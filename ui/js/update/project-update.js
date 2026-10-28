// Update one project: re-runs everything the project has set up, in order, with the choices saved in each module.
// Global: ProjectUpdate. Needs dn-fs.js, engine-client.js, ui.js, project-log.js, projects.js, external-source.js,
// pipeline/runner.js, publish/publisher.js (Publisher loads the chart libraries itself), import/import-core.js and
// data-studio/pipeline.js (a project with Data Studio pipelines runs those instead of the module steps).
//   Import     each imported dataset whose source file changed (or has no size / date recorded) is read again with the
//              same column choices as its first import (dataset.source.select); unchanged sources are left as they are
//   Transform  every ticked transform query rebuilds its output dataset (when the project has one)
//   Dashboard  widget caches are cleared, so the dashboard shows the new data the next time it opens
//   Publish    the dashboard formats ticked in Publish (cfg.publish.targets) and the last dataset export (cfg.publish.data)
//   Archive    a zipped snapshot of the project (settings, datasets, transform, dashboard) in archives/ (Projects.snapshot)
//   await ProjectUpdate.run(folder, { step(id, state, note), log(msg, level), after(id), progress(id, pct) })  -> { ok, steps: { id: { state, note } } }
//   progress(id, 0..100): a step found changes and is working (0 = starting); 'update' = the whole run.
//     after(id) is awaited when a step finishes (before the next one starts).
//     state = 'running' | 'done' | 'skipped' | 'failed'. The result is saved as cfg.modules.update.
//   ProjectUpdate.STEPS = [{ id, label }];  await ProjectUpdate.sources(cfg) -> [{ d, status }]  (same | changed | missing | unknown)
const ProjectUpdate = (() => {
  const STEPS = [{ id: 'import', label: 'Import' }, { id: 'transform', label: 'Transform' }, { id: 'dashboard', label: 'Dashboard' },
    { id: 'publish', label: 'Publish' }, { id: 'archive', label: 'Archive' }, { id: 'update', label: 'Update' }];

  // Sources live in the project (source.path) or outside it (source.origin: local / network path, via the server).
  async function statSource(d) {
    if (d.source.path) return DNFS.stat(d.source.path).catch(() => ({ exists: false }));
    try { const p = await ExternalSource.probe(d.source.origin); return { exists: true, size: p.size, modified: p.modified }; }
    catch (e) { return { exists: false, error: e.message }; }
  }
  const imported = cfg => (cfg.datasets || []).filter(d => d.source && d.source.kind !== 'pipeline');
  // The Import settings (dataset names, where they are saved, what is read): a change (e.g. a renamed export table)
  // counts as an Import change even when no source file changed. Saved with each Update (modules.update.importCfg).
  const importSig = cfg => JSON.stringify(imported(cfg).map(d => [d.name, d.path, d.source.table || '', d.source.select || '']).sort());
  // A file copied into data/raw from somewhere else (source.from): when the original is newer it is copied in again
  // (recopy). When the original cannot be reached, the copy in the project is used as it is.
  async function sources(cfg) {
    const out = [];
    for (const d of imported(cfg)) {
      const f = d.source.from;
      if (f?.src) {
        const o = await ExternalSource.probe(f.src).then(p => ({ exists: true, ...p }), e => ({ exists: false, error: e.message }));
        if (o.exists && (o.size !== f.size || o.modified !== f.modified)) { out.push({ d, st: o, status: 'changed', recopy: o }); continue; }
      }
      const st = await statSource(d);
      out.push({ d, st, status: !st.exists ? 'missing' : d.source.size == null ? 'unknown' : st.size !== d.source.size || st.modified !== d.source.modified ? 'changed' : 'same' });
    }
    return out;
  }

  // Read one dataset again from its source (same columns as its first import); the old version stays until the new one is complete.
  async function reimport(ctx, d, st) {
    const from = Engine.src(d.source.path || d.source.origin, d.source.table || '');
    const total = await Engine.count(from);
    const w = await Engine.write({ sql: `SELECT ${d.source.select} FROM ${from}`, dest: d.path.replace(/\.parquet$/, ''), meta: { source: d.source.origin || d.source.path } });
    if (w.rowCount !== total) throw new Error(`${d.name}: ${UI.num(total)} rows in the source, ${UI.num(w.rowCount)} written.`);
    await Projects.upsertDataset(ctx.folder, { ...d, path: w.path, parts: w.files, rows: w.rowCount, bytes: w.bytes, columns: Engine.columnsOf(w), version: w.version,
      imported: new Date().toISOString(), source: { ...d.source, size: st.size, modified: st.modified } });
    return { before: d.rows, after: w.rowCount };
  }

  async function run(folder, { step = () => {}, log = () => {}, after = async () => {}, progress = () => {}, minStep = 0 } = {}) {
    const ctx = { folder, dir: Projects.dir(folder), cfg: await Projects.get(folder) };
    ctx.reload = async () => (ctx.cfg = await Projects.get(folder));
    // Every line goes to the caller (the live view) and to the project's activity log.
    ctx.log = (msg, level = 'info') => { log(msg, level); ProjectLog.write(folder, 'update', msg, level === 'ok' ? 'info' : level === 'warn' ? 'warn' : level === 'error' ? 'error' : 'info').catch(() => {}); };
    const steps = {}, t0 = performance.now();
    const set = (id, state, note = '') => { steps[id] = { state, note }; step(id, state, note); };
    let failed = null;
    // Anything changed in the project since the last Update (server change notifications)? Nothing = no new snapshot.
    const since = Date.parse(ctx.cfg.modules?.update?.lastRun || '');
    const areas = since ? await DNFS.changes(ctx.dir).catch(() => null) : null;
    const newer = k => !areas || (areas[k] || 0) > since;   // unknown = changed
    const changed = !areas || Object.entries(areas).some(([k, t]) => t > since && k !== 'data/cache');
    let reimported = 0;
    // A step "updated" when it did real work this run; later steps with nothing new of their own can then skip.
    const updated = id => steps[id]?.state === 'done' && steps[id].note !== 'No Changes';
    const pubCfg = c => JSON.stringify(c.publish || {});
    const impChanged = importSig(ctx.cfg) !== ctx.cfg.modules?.update?.importCfg;
    ctx.log(`Update started: ${ctx.cfg.name}`);
    // Progress: ctx.at(f) (0..1) from the step working now; the whole update = the share of steps finished.
    const work = STEPS.filter(s => s.id !== 'update'); let cur = null, nDone = 0;
    const total = f => progress('update', Math.round(((nDone + (f || 0)) / work.length) * 100));
    // Between real progress reports the circle keeps moving: it creeps toward the next report (never past 99%), slowing
    // as it goes, so every step counts up live even while one long call (a snapshot, a query) runs.
    let real = 0, shown = 0, tick = 0;
    const show = f => { shown = f; progress(cur, Math.round(f * 100)); total(f); };
    const stopTick = () => { clearInterval(tick); tick = 0; };
    ctx.at = f => {
      if (!cur) return; real = Math.max(0, Math.min(1, f));
      if (real >= 1) { stopTick(); return show(1); }
      show(Math.max(shown, real));
      if (!tick) tick = setInterval(() => { if (!cur) return stopTick(); const cap = 0.99; show(shown + (cap - shown) * 0.04); }, 150);
    };
    // Step 6 (Update) is gold "Running" for the whole update: green (or red) only when every other step has finished.
    set('update', 'running', 'Updating…');
    const jobs = {
      async import() {
        const list = await sources(ctx.cfg);
        if (!list.length) return 'skip:No imported datasets';
        const missing = list.filter(s => s.status === 'missing');
        if (missing.length) throw new Error(`Source file not found: ${missing.map(s => `${s.d.name} (${s.d.source.path || s.d.source.origin}${s.st.error ? `: ${s.st.error}` : ''})`).join(', ')}`);
        let n = 0; const todo = list.filter(s => s.status !== 'same').length;
        if (todo) ctx.at(0);
        for (const s of list) {
          if (s.status === 'same') { ctx.log(`${s.d.name}: source unchanged`); continue; }
          let d = s.d, st = s.st;
          if (s.recopy) {   // copied file: bring the newer original into data/raw first
            ctx.log(`${d.name}: copying the newer ${d.source.from.src} into the project…`);
            await ExternalSource.copy(d.source.from.src, d.source.path);
            d = { ...d, source: { ...d.source, from: { ...d.source.from, size: s.recopy.size, modified: s.recopy.modified } } };
            st = await DNFS.stat(d.source.path);
          }
          ctx.log(`${d.name}: reading the source again…`);
          const c = await reimport(ctx, d, st); n++; ctx.at(n / todo);
          ctx.log(`${s.d.name}: ${UI.num(c.before)} → ${UI.num(c.after)} rows`, 'ok');
        }
        reimported = n;
        await Projects.touchModule(folder, 'import');
        if (!n && impChanged) { ctx.at(1); return 'Import settings changed'; }   // e.g. a renamed table: the later steps run
        return n ? `${n} dataset(s) re-imported` : 'same:No Changes';
      },
      async transform() {
        if (!(await Projects.sourceDatasets(folder, ctx.cfg)).length) return 'skip:No CLEAN_ datasets';
        const pipe = await PipelineRunner.load(ctx);
        if (!PipelineRunner.selected(pipe).length) return 'skip:No transform queries';
        // Same queries, same input data, nothing re-imported: the CLEAN_ datasets are already up to date.
        if (!reimported && !newer('transform') && !newer('data/imported') && !newer('data/raw')) return 'same:No Changes';
        ctx.at(0);
        const qs = PipelineRunner.selected(pipe).length || 1; let qn = 0;
        const rec = await PipelineRunner.run(ctx, pipe, (m, l) => ctx.log(m, l), null, () => {}, (q, st) => { if (st === 'done') ctx.at(++qn / qs); });
        if (!rec.ok) throw new Error(rec.error);
        return rec.outputs.map(o => `${o.name}: ${UI.num(o.rows)} rows`).join(', ');
      },
      async dashboard() {
        const dash = await DNFS.readJSONOr(`${ctx.dir}/dashboard/dashboard.json`, null);
        if (!dash?.widgets?.length) return 'skip:No dashboard';
        if (!updated('import') && !updated('transform') && !newer('dashboard') && !newer('data/clean')) return 'same:No Changes';
        let n = 0; ctx.at(0);
        try { for (const f of await DNFS.list(`${ctx.dir}/data/cache`)) if (!f.dir && /^widget-.*\.json$/.test(f.name)) { await DNFS.remove(f.path); n++; } } catch {}
        ctx.log(`Dashboard: ${dash.widgets.length} widget(s) will show the new data (${n} cached result(s) cleared)`, 'ok');
        await Projects.touchModule(folder, 'dashboard');
        return `${dash.widgets.length} widget(s) refreshed`;
      },
      async publish() {
        await ctx.reload();
        const same = !updated('import') && !updated('transform') && !updated('dashboard') && !newer('dashboard') && !newer('data/clean')
          && !newer('publish') && pubCfg(ctx.cfg) === ctx.cfg.modules?.update?.publishCfg;
        if (same && (ctx.cfg.publish?.targets?.length || ctx.cfg.publish?.data?.names?.length)) return 'same:No Changes';
        const p = ctx.cfg.publish || {}, done = []; ctx.at(0);
        if (p.targets?.length) { const files = await Publisher.dashboard(ctx, {}); done.push(`${files.length} dashboard file(s)`); ctx.at(p.data?.names?.length ? 0.5 : 1); }
        if (p.data?.names?.length) { const files = await Publisher.data(ctx, p.data); done.push(`${files.length} dataset file(s)`); }
        return done.length ? done.join(', ') : 'skip:Nothing ticked in Publish';
      },
      async archive() {
        if (!changed) return 'skip:No Changes';
        ctx.at(0); await ctx.reload();
        const s = await Projects.snapshot(folder, 'Update', (ph, done, all) => { if (all) ctx.at(done / all); });
        ctx.log(`Snapshot taken: ${s.id}, ${UI.bytes(s.bytes)} zipped`, 'ok');
        return 'Snapshot taken';
      },
    };
    // Data Studio pipelines (<project>/pipelines/*.pipeline): when the project has any, they ARE the update: every
    // pipeline runs on the full data (A-Z) as the Import step, the others are done inside them.
    const pipes = typeof DSPipeline !== 'undefined' ? await DSPipeline.list(ctx) : [];
    if (pipes.length) {
      jobs.import = async () => {
        ctx.at(0); let n = 0;
        const r = await DSPipeline.runAll(ctx, { log: (m, l) => ctx.log(m, l === 'error' ? 'error' : l), onNode: (nd, st) => { if (st === 'done') ctx.at(Math.min(0.99, ++n / 20)); } });
        if (!r.ok) throw new Error(r.error);
        ctx.at(1);
        return `${r.done.length} pipeline(s) run: ${r.done.join(', ')}`;
      };
      for (const k of ['transform', 'publish', 'archive']) jobs[k] = async () => 'skip:Done in the pipeline';
    }
    for (const s of STEPS) {
      if (s.id === 'update') continue;   // the whole update: set below
      if (failed) { set(s.id, 'skipped', 'Not run (an earlier step failed)'); continue; }
      set(s.id, 'running'); cur = s.id; real = shown = 0; stopTick();   // Checking: until it finds changes (ctx.at)
      ctx.log(`${s.label}…`);
      try {
        const t1 = performance.now(), r = await jobs[s.id]() || '';
        const rest = minStep - (performance.now() - t1); if (rest > 0) await new Promise(res => setTimeout(res, rest));   // the page shows Checking on every step
        if (r.startsWith('same:')) { set(s.id, 'done', r.slice(5)); ctx.log(`${s.label}: skipped, no changes since the last update`, 'ok'); }
        else if (r.startsWith('skip:')) { set(s.id, 'skipped', r.slice(5)); ctx.log(`${s.label}: ${r.slice(5)}`); }
        else { progress(s.id, 100); set(s.id, 'done', r); ctx.log(`${s.label} done${r ? `: ${r}` : ''}`, 'ok'); await after(s.id); }   // after: the page lets its finish animation play
      } catch (e) {
        failed = e; set(s.id, 'failed', e.message); ctx.log(`${s.label} failed: ${e.message}`, 'error');
      }
      stopTick(); cur = null; nDone++; total(0);
    }
    const ok = !failed, ms = performance.now() - t0;
    if (ok) progress('update', 100);
    set('update', ok ? 'done' : 'failed', ok ? `Finished in ${UI.ms(ms)}` : failed.message);
    ctx.log(ok ? `Update finished in ${UI.ms(ms)}` : `Update stopped: ${failed.message}`, ok ? 'ok' : 'error');
    await ctx.reload().catch(() => {});
    await Projects.touchModule(folder, 'update', { ok, steps, ms: Math.round(ms), publishCfg: pubCfg(ctx.cfg), importCfg: importSig(ctx.cfg) });
    return { ok, steps };
  }
  return { STEPS, sources, run, importSig };
})();
