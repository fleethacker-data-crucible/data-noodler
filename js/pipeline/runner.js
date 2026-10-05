// Runs a project's pipeline. Global: PipelineRunner. Needs steps.js, projects.js.
//   await PipelineRunner.defineViews(E, ctx, pipe, upto)   datasets + steps (0..upto) as views
//   await PipelineRunner.run(E, ctx, pipe)                 writes every output step to data/staged, records the run
const PipelineRunner = (() => {
  const S = PipelineSteps;
  const file = ctx => `${ctx.dir}/pipeline/pipeline.json`, runsFile = ctx => `${ctx.dir}/pipeline/runs.json`;
  const load = async ctx => { try { return await DNFS.readJSON(file(ctx)); } catch { return { version: 1, steps: [] }; } };
  const runs = async ctx => { try { return await DNFS.readJSON(runsFile(ctx)); } catch { return []; } };

  async function defineViews(E, ctx, pipe, upto = pipe.steps.length - 1) {
    await ctx.reload();
    for (const d of ctx.cfg.datasets || []) await E.exec(`CREATE OR REPLACE VIEW ${S.q(d.name)} AS SELECT * FROM read_parquet('${E.url(d.path)}')`);
    for (const s of pipe.steps.slice(0, upto + 1)) {
      try { await E.exec(`CREATE OR REPLACE VIEW ${S.q(s.name)} AS ${S.sqlOf(s)}`); }
      catch (e) { throw new Error(`Step "${s.name}": ${e.message.split('\n')[0]}`); }
    }
  }

  // Returns the run record { at, ms, ok, outputs: [{ name, rows, before }], error }.
  async function run(E, ctx, pipe, log = () => {}) {
    const t0 = performance.now(), rec = { at: new Date().toISOString(), outputs: [], ok: true };
    try {
      await defineViews(E, ctx, pipe);
      for (const s of pipe.steps.filter(x => x.output)) {
        const existing = ctx.cfg.datasets?.find(d => d.name === s.name);
        if (existing && existing.source?.kind !== 'pipeline') throw new Error(`"${s.name}" is an imported dataset; rename the step.`);
        const path = `${ctx.dir}/data/staged/${s.name}.parquet`;
        log(`Writing ${s.name}…`);
        const w = await E.writeProjectFile(`SELECT * FROM ${S.q(s.name)}`, path, 'FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000');
        const url = E.url(path);
        const rows = Number((await E.query(`SELECT count(*) FROM read_parquet('${url}')`)).rows[0][0]);
        const columns = (await E.query(`DESCRIBE SELECT * FROM read_parquet('${url}')`)).rows.map(r => ({ name: r[0], type: r[1] }));
        await Projects.upsertDataset(ctx.folder, { name: s.name, path, rows, bytes: w.bytes, columns, imported: new Date().toISOString(), source: { kind: 'pipeline', step: s.id } });
        rec.outputs.push({ name: s.name, rows, before: existing?.rows ?? null });
        log(`${s.name}: ${UI.num(rows)} rows, ${UI.bytes(w.bytes)}`, 'ok');
      }
    } catch (e) { rec.ok = false; rec.error = e.message; }
    rec.ms = Math.round(performance.now() - t0);
    const all = await runs(ctx); all.push(rec); await DNFS.writeJSON(runsFile(ctx), all.slice(-100));
    await Projects.touchModule(ctx.folder, 'pipeline', { ok: rec.ok });
    await ctx.reload();
    return rec;
  }
  return { load, runs, defineViews, run, file };
})();
