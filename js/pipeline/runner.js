// Runs a project's pipeline on the native engine. Global: PipelineRunner. Needs steps.js, projects.js, engine-client.js.
//   await PipelineRunner.views(ctx, pipe, upto)          datasets + steps (0..upto) as engine views { name: sql }
//   await PipelineRunner.run(ctx, pipe, log, changed)    the engine runs the step DAG and writes every output step to
//                                                        data/source/<name>/ (atomic, with lineage); records the run.
//                                                        changed = dataset names re-imported by Update: only outputs
//                                                        downstream of them run (null = all outputs).
const PipelineRunner = (() => {
  const S = PipelineSteps;
  const file = ctx => `${ctx.dir}/pipeline/pipeline.json`, runsFile = ctx => `${ctx.dir}/pipeline/runs.json`;
  const load = async ctx => { try { return await DNFS.readJSONOr(file(ctx), { version: 1, steps: [] }); } catch { return { version: 1, steps: [] }; } };
  const runs = async ctx => { try { return await DNFS.readJSONOr(runsFile(ctx), []); } catch { return []; } };

  async function views(ctx, pipe, upto = pipe.steps.length - 1) {
    await ctx.reload();
    const v = Engine.views(ctx.cfg.datasets || []);
    for (const s of pipe.steps.slice(0, upto + 1)) {
      try { v[s.name] = S.sqlOf(s); } catch (e) { throw new Error(`Step "${s.name}": ${e.message}`); }
    }
    return v;
  }

  // Returns the run record { at, ms, ok, outputs: [{ name, rows, before }], skipped, error }.
  async function run(ctx, pipe, log = () => {}, changed = null) {
    const t0 = performance.now(), rec = { at: new Date().toISOString(), outputs: [], ok: true };
    try {
      const cfg = await ctx.reload(), ds = cfg.datasets || [];
      for (const s of pipe.steps.filter(x => x.output)) {
        const existing = ds.find(d => d.name === s.name);
        if (existing && existing.source?.kind !== 'pipeline') throw new Error(`"${s.name}" is an imported dataset; rename the step.`);
      }
      const nodes = pipe.steps.map(s => {
        let sql; try { sql = S.sqlOf(s); } catch (e) { throw new Error(`Step "${s.name}": ${e.message}`); }
        return { id: s.id, name: s.name, sql, output: !!s.output, dest: `${ctx.dir}/data/source/${s.name}` };
      });
      const spec = { name: ctx.folder, version: pipe.rev || 0, datasets: Object.fromEntries(ds.map(d => [d.name, d.path])), nodes };
      if (changed) spec.changed = changed;
      let lastStage = '';
      const r = await Engine.pipeline(spec, j => { if (j.stage && j.stage !== lastStage) { lastStage = j.stage; log(`${j.stage}…`); } });
      for (const o of r.outputs) {
        const before = ds.find(d => d.name === o.step), step = pipe.steps.find(s => s.name === o.step);
        if (before && before.path !== o.path) await DNFS.remove(before.path, { recursive: !/\.parquet$/.test(before.path) }).catch(() => {});   // older runs wrote elsewhere
        await Projects.upsertDataset(ctx.folder, { name: o.step, path: o.path, parts: o.files, stage: 'source', rows: o.rowCount, bytes: o.bytes, columns: Engine.columnsOf(o),
          version: o.version, imported: new Date().toISOString(), source: { kind: 'pipeline', step: step?.id } });
        rec.outputs.push({ name: o.step, rows: o.rowCount, before: before?.rows ?? null });
        log(`${o.step}: ${UI.num(o.rowCount)} rows, ${UI.bytes(o.bytes)}`, 'ok');
      }
      rec.skipped = r.skipped || [];
      if (rec.skipped.length) log(`Unchanged, not re-run: ${rec.skipped.join(', ')}`);
    } catch (e) { rec.ok = false; rec.error = e.message; }
    rec.ms = Math.round(performance.now() - t0);
    const all = await runs(ctx); all.push(rec); await DNFS.writeJSON(runsFile(ctx), all.slice(-100));
    await Projects.touchModule(ctx.folder, 'pipeline', { ok: rec.ok });
    await ctx.reload();
    return rec;
  }
  return { load, runs, views, run, file };
})();
