// Update one project: re-runs everything the project has set up, in order, with the choices saved in each module.
// Global: ProjectUpdate. Needs dn-fs.js, engine-client.js, ui.js, project-log.js, projects.js, external-source.js,
// pipeline/runner.js, publish/publisher.js (Publisher loads the chart libraries itself).
//   Import     each imported dataset whose source file changed (or has no size / date recorded) is read again with the
//              same column choices as its first import (dataset.source.select); unchanged sources are left as they are
//   Transform  the active transform query rebuilds its output dataset (when the project has one)
//   Dashboard  widget caches are cleared, so the dashboard shows the new data the next time it opens
//   Publish    the dashboard formats ticked in Publish (cfg.publish.targets) and the last dataset export (cfg.publish.data)
//   Archive    a snapshot of the project (settings, datasets, transform, dashboard) in archives/
//   await ProjectUpdate.run(folder, { step(id, state, note), log(msg, level), after(id) })  -> { ok, steps: { id: { state, note } } }
//     after(id) is awaited when a step finishes (before the next one starts).
//     state = 'running' | 'done' | 'skipped' | 'failed'. The result is saved as cfg.modules.update.
//   ProjectUpdate.STEPS = [{ id, label }];  await ProjectUpdate.sources(cfg) -> [{ d, status }]  (same | changed | missing | unknown)
const ProjectUpdate = (() => {
  const STEPS = [{ id: 'import', label: 'Import' }, { id: 'transform', label: 'Transform' }, { id: 'dashboard', label: 'Dashboard' },
    { id: 'publish', label: 'Publish' }, { id: 'archive', label: 'Archive' }];
  const SNAP_PARTS = ['project-config.json', 'data/imported', 'data/source', 'pipeline', 'dashboard'];   // what a snapshot holds (as in Archives)

  // Sources live in the project (source.path) or outside it (source.origin: local / network path, via the server).
  async function statSource(d) {
    if (d.source.path) return DNFS.stat(d.source.path).catch(() => ({ exists: false }));
    try { const p = await ExternalSource.probe(d.source.origin); return { exists: true, size: p.size, modified: p.modified }; }
    catch (e) { return { exists: false, error: e.message }; }
  }
  const imported = cfg => (cfg.datasets || []).filter(d => d.source && d.source.kind !== 'pipeline');
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

  async function snapshot(ctx, note) {
    const dir = `${ctx.dir}/archives/${new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}`;
    for (const p of SNAP_PARTS) if ((await DNFS.stat(`${ctx.dir}/${p}`)).exists) await DNFS.copy(`${ctx.dir}/${p}`, `${dir}/${p}`);
    let bytes = 0;
    try { bytes = (await DNFS.list(dir, { recursive: true })).reduce((s, f) => s + (f.dir ? 0 : f.size), 0); } catch {}
    await DNFS.writeJSON(`${dir}/snapshot.json`, { at: new Date().toISOString(), note, bytes, datasets: (ctx.cfg.datasets || []).map(d => ({ name: d.name, rows: d.rows, columns: d.columns.length })) });
    await Projects.touchModule(ctx.folder, 'archives');
    return { dir, bytes };
  }

  async function run(folder, { step = () => {}, log = () => {}, after = async () => {} } = {}) {
    const ctx = { folder, dir: Projects.dir(folder), cfg: await Projects.get(folder) };
    ctx.reload = async () => (ctx.cfg = await Projects.get(folder));
    // Every line goes to the caller (the live view) and to the project's activity log.
    ctx.log = (msg, level = 'info') => { log(msg, level); ProjectLog.write(folder, 'update', msg, level === 'ok' ? 'info' : level === 'warn' ? 'warn' : level === 'error' ? 'error' : 'info').catch(() => {}); };
    const steps = {}, t0 = performance.now();
    const set = (id, state, note = '') => { steps[id] = { state, note }; step(id, state, note); };
    let failed = null;
    ctx.log(`Update started: ${ctx.cfg.name}`);
    const jobs = {
      async import() {
        const list = await sources(ctx.cfg);
        if (!list.length) return 'No imported datasets';
        const missing = list.filter(s => s.status === 'missing');
        if (missing.length) throw new Error(`Source file not found: ${missing.map(s => `${s.d.name} (${s.d.source.path || s.d.source.origin}${s.st.error ? `: ${s.st.error}` : ''})`).join(', ')}`);
        let n = 0;
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
          const c = await reimport(ctx, d, st); n++;
          ctx.log(`${s.d.name}: ${UI.num(c.before)} → ${UI.num(c.after)} rows`, 'ok');
        }
        await Projects.touchModule(folder, 'import');
        return n ? `${n} dataset(s) re-imported` : 'All sources unchanged';
      },
      async transform() {
        const pipe = await PipelineRunner.load(ctx);
        if (!PipelineRunner.active(pipe)) return 'skip:No active transform query';
        const rec = await PipelineRunner.run(ctx, pipe, (m, l) => ctx.log(m, l));
        if (!rec.ok) throw new Error(rec.error);
        return rec.outputs.map(o => `${o.name}: ${UI.num(o.rows)} rows`).join(', ');
      },
      async dashboard() {
        const dash = await DNFS.readJSONOr(`${ctx.dir}/dashboard/dashboard.json`, null);
        if (!dash?.widgets?.length) return 'skip:No dashboard';
        let n = 0;
        try { for (const f of await DNFS.list(`${ctx.dir}/data/cache`)) if (!f.dir && /^widget-.*\.json$/.test(f.name)) { await DNFS.remove(f.path); n++; } } catch {}
        ctx.log(`Dashboard: ${dash.widgets.length} widget(s) will show the new data (${n} cached result(s) cleared)`, 'ok');
        await Projects.touchModule(folder, 'dashboard');
        return `${dash.widgets.length} widget(s) refreshed`;
      },
      async publish() {
        await ctx.reload();
        const p = ctx.cfg.publish || {}, done = [];
        if (p.targets?.length) { const files = await Publisher.dashboard(ctx, {}); done.push(`${files.length} dashboard file(s)`); }
        if (p.data?.names?.length) { const files = await Publisher.data(ctx, p.data); done.push(`${files.length} dataset file(s)`); }
        return done.length ? done.join(', ') : 'skip:Nothing ticked in Publish';
      },
      async archive() {
        await ctx.reload();
        const s = await snapshot(ctx, 'Update');
        ctx.log(`Snapshot taken: ${s.dir.split('/').pop()}, ${UI.bytes(s.bytes)}`, 'ok');
        return 'Snapshot taken';
      },
    };
    for (const s of STEPS) {
      if (failed) { set(s.id, 'skipped', 'Not run (an earlier step failed)'); continue; }
      set(s.id, 'running');
      ctx.log(`${s.label}…`);
      try {
        const r = await jobs[s.id]() || '';
        if (r.startsWith('skip:')) { set(s.id, 'skipped', r.slice(5)); ctx.log(`${s.label}: ${r.slice(5)}`); }
        else { set(s.id, 'done', r); ctx.log(`${s.label} done${r ? `: ${r}` : ''}`, 'ok'); await after(s.id); }   // after: the page lets its finish animation play
      } catch (e) {
        failed = e; set(s.id, 'failed', e.message); ctx.log(`${s.label} failed: ${e.message}`, 'error');
      }
    }
    const ok = !failed, ms = performance.now() - t0;
    ctx.log(ok ? `Update finished in ${UI.ms(ms)}` : `Update stopped: ${failed.message}`, ok ? 'ok' : 'error');
    await Projects.touchModule(folder, 'update', { ok, steps, ms: Math.round(ms) });
    return { ok, steps };
  }
  return { STEPS, sources, run };
})();
