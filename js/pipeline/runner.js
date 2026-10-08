// Runs a project's transform on the native engine. Global: PipelineRunner. Needs projects.js, engine-client.js.
// pipeline/pipeline.json = { version: 2, queries: [{ id, name, sql }], active: id, output: 'CLEAN_...', rev, updated }.
// Each query is a SQL script (one SELECT, or statements ending in a SELECT; see engine/Core/Script.cs). The active query
// builds the output dataset.
//   await PipelineRunner.load(ctx)                   pipeline.json (older step lists are converted)
//   await PipelineRunner.views(ctx)                  the project's datasets as engine views { name: sql }
//   PipelineRunner.active(pipe)                      the active query, or undefined
//   await PipelineRunner.run(ctx, pipe, log, changed, onJob)   writes the active query's result to data/source/<output>/
//                                                    (Parquet parts, atomic) and records the run. changed: unused (the
//                                                    output always rebuilds), kept for Update.
const PipelineRunner = (() => {
  const file = ctx => `${ctx.dir}/pipeline/pipeline.json`, runsFile = ctx => `${ctx.dir}/pipeline/runs.json`;
  const blank = () => ({ version: 2, queries: [], active: null, output: '' });
  const runs = async ctx => { try { return await DNFS.readJSONOr(runsFile(ctx), []); } catch { return []; } };

  // Version 1 (ordered steps, each writing a dataset) -> version 2 (queries; the last step becomes the active one).
  function migrate(p) {
    if (!p || typeof p !== 'object') return blank();
    if (p.version === 2 && Array.isArray(p.queries)) return p;
    const steps = Array.isArray(p.steps) ? p.steps : [];
    const sqlOf = s => s.config?.query ?? (typeof PipelineSteps !== 'undefined' ? (() => { try { return PipelineSteps.sqlOf(s); } catch { return ''; } })() : '');
    const queries = steps.map(s => ({ id: s.id || crypto.randomUUID(), name: s.title || s.name || '', sql: sqlOf(s) }));
    const last = steps[steps.length - 1];
    let output = last?.name ? String(last.name).toUpperCase().replace(/\s/g, '_') : '';
    if (output && !output.startsWith('CLEAN_')) output = 'CLEAN_' + output;
    return { version: 2, queries, active: queries.length ? queries[queries.length - 1].id : null, output, rev: p.rev || 0, updated: p.updated };
  }
  const load = async ctx => { try { return migrate(await DNFS.readJSONOr(file(ctx), blank())); } catch { return blank(); } };

  async function views(ctx) { await ctx.reload(); return Engine.views(ctx.cfg.datasets || []); }
  const active = pipe => (pipe.queries || []).find(q => q.id === pipe.active);

  // Returns the run record { at, ms, ok, outputs: [{ name, rows, before }], error }.
  async function run(ctx, pipe, log = () => {}, changed = null, onJob = () => {}) {
    const t0 = performance.now(), rec = { at: new Date().toISOString(), outputs: [], ok: true };
    try {
      const q = active(pipe);
      if (!q) throw new Error('Set an active query first.');
      if (!q.sql.trim()) throw new Error(`Query "${q.name}" is empty.`);
      const name = pipe.output;
      if (!/^CLEAN_[A-Z0-9_]+$/.test(name || '')) throw new Error('The output dataset name must be CLEAN_ followed by letters, digits or _.');
      const cfg = await ctx.reload(), ds = cfg.datasets || [];
      const before = ds.find(d => d.name === name);
      if (before && before.source?.kind !== 'pipeline') throw new Error(`"${name}" is an imported dataset; pick another output name.`);
      let lastStage = '';
      log(`Building ${name} from query "${q.name}"…`);
      const meta = { lineage: { transformQuery: q.id, transformName: q.name, pipelineVersion: pipe.rev || 0 } };
      const w = await Engine.write({ sql: q.sql, views: Engine.views(ds), dest: `${ctx.dir}/data/source/${name}`, meta }, j => {
        onJob(j);
        if (j.stage && j.stage !== lastStage) { lastStage = j.stage; log(`${j.stage}…`); }
      });
      if (before && before.path !== w.path) await DNFS.remove(before.path, { recursive: !/\.parquet$/.test(before.path) }).catch(() => {});
      await Projects.upsertDataset(ctx.folder, { name, path: w.path, parts: w.files, stage: 'source', rows: w.rowCount, bytes: w.bytes, columns: Engine.columnsOf(w),
        version: w.version, imported: new Date().toISOString(), source: { kind: 'pipeline', query: q.id } });
      rec.outputs.push({ name, rows: w.rowCount, before: before?.rows ?? null });
      log(`${name}: ${UI.num(w.rowCount)} rows, ${(w.columns || []).length} columns, ${(w.files || []).length} part(s), ${UI.bytes(w.bytes)}`, 'ok');
    } catch (e) { rec.ok = false; rec.error = e.message; }
    rec.ms = Math.round(performance.now() - t0);
    const all = await runs(ctx); all.push(rec); await DNFS.writeJSON(runsFile(ctx), all.slice(-100));
    await Projects.touchModule(ctx.folder, 'pipeline', { ok: rec.ok });
    await ctx.reload();
    return rec;
  }
  return { load, runs, views, run, file, active, migrate };
})();
