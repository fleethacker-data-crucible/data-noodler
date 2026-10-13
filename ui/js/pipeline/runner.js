// Runs a project's transform on the native engine. Global: PipelineRunner. Needs projects.js, engine-client.js.
// pipeline/pipeline.json = { version: 4, queries: [{ id, name, sql, run: true }], rev, updated }.
// Each query is a SQL script (see server/data-engine/Core/Script.cs). Every CREATE TABLE <NAME> AS ... in it (not
// CREATE TEMP TABLE: helpers) is saved as the dataset data/source/CLEAN_<NAME>/ (the CLEAN_ prefix is added, never doubled).
// Ticked queries (run: true) run, in list order, on Run Selected and on Update.
//   await PipelineRunner.load(ctx)                   pipeline.json (older versions are converted)
//   PipelineRunner.selected(pipe)                    the ticked queries, in order
//   PipelineRunner.tables(sql)                       [{ table, name, ok }] the datasets a query saves (name = CLEAN_...)
//   PipelineRunner.problems(pipe, imported)          [{ q, msg }] what stops the ticked queries from running
//   await PipelineRunner.writeSql(ctx, pipe)         pipeline/transform.sql = the ticked queries (for reading)
//   await PipelineRunner.run(ctx, pipe, log, changed, onJob)   runs every ticked query; records the run. Stops at the
//                                                    first failure. changed: unused, kept for Update.
const PipelineRunner = (() => {
  const file = ctx => `${ctx.dir}/pipeline/pipeline.json`, runsFile = ctx => `${ctx.dir}/pipeline/runs.json`;
  const blank = () => ({ version: 4, queries: [] });
  const runs = async ctx => { try { return await DNFS.readJSONOr(runsFile(ctx), []); } catch { return []; } };
  const PRE = 'CLEAN_', NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

  // Comments and strings blanked (positions kept), so names inside them are not read.
  const strip = sql => String(sql || '').replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'/g, m => m.replace(/[^\n]/g, ' '));
  const placeholder = sql => /\bXXX\b/i.test(strip(sql));
  // CREATE [OR REPLACE] TABLE [IF NOT EXISTS] name (not TEMP / TEMPORARY): the datasets the query saves, in order.
  function tables(sql) {
    const out = [];
    for (const m of strip(sql).matchAll(/\bCREATE\s+(?:OR\s+REPLACE\s+)?(TEMP\s+|TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("([^"]+)"|\[([^\]]+)\]|([A-Za-z_]\w*))/gi)) {
      if (m[1]) continue;
      const table = m[3] || m[4] || m[5], up = table.toUpperCase(), name = up.startsWith(PRE) ? up : PRE + up;
      const i = out.findIndex(o => o.name === name); if (i >= 0) out.splice(i, 1);
      out.push({ table, name, ok: NAME.test(table) && up !== 'XXX' });
    }
    return out;
  }

  // 1 (steps) -> 2 (one active query + one output) -> 3 (per query output + tick) -> 4 (outputs are CREATE TABLE in the SQL).
  function migrate(p) {
    if (!p || typeof p !== 'object') return blank();
    if (p.version === 4 && Array.isArray(p.queries)) return p;
    if (p.version !== 2 && p.version !== 3) {
      const steps = Array.isArray(p.steps) ? p.steps : [];
      const sqlOf = s => s.config?.query ?? (typeof PipelineSteps !== 'undefined' ? (() => { try { return PipelineSteps.sqlOf(s); } catch { return ''; } })() : '');
      const queries = steps.map(s => ({ id: s.id || crypto.randomUUID(), name: s.title || s.name || '', sql: sqlOf(s) }));
      const last = steps[steps.length - 1];
      p = { version: 2, queries, active: queries.length ? queries[queries.length - 1].id : null, output: last?.name ? String(last.name).toUpperCase().replace(/\s/g, '_') : '', rev: p.rev || 0, updated: p.updated };
    }
    if (p.version === 2) p = { version: 3, queries: p.queries.map(q => ({ ...q, output: q.id === p.active ? p.output || '' : '', run: q.id === p.active })), rev: p.rev, updated: p.updated };
    // v3 -> v4: a one-statement query with an output name becomes CREATE TABLE <name> AS <its SQL>.
    const queries = p.queries.map(q => {
      let sql = q.sql || '';
      const one = !strip(sql).replace(/;\s*$/, '').includes(';'), base = String(q.output || '').toUpperCase().replace(/^CLEAN_/, '');
      if (base && one && sql.trim() && !tables(sql).length) sql = `CREATE TABLE ${base} AS\n${sql.replace(/;\s*$/, '')}`;
      return { id: q.id, name: q.name || '', sql, run: !!q.run };
    });
    return { version: 4, queries, rev: p.rev || 0, updated: p.updated };
  }
  const load = async ctx => { try { return migrate(await DNFS.readJSONOr(file(ctx), blank())); } catch { return blank(); } };
  const selected = pipe => (pipe.queries || []).filter(q => q.run);

  // What stops the ticked queries: a name, SQL, XXX left, no table created, two queries saving the same dataset,
  // a dataset named like an imported one. imported = imported dataset names.
  function problems(pipe, imported = []) {
    const out = [], seen = new Map(), imp = new Set(imported.map(n => n.toUpperCase()));
    for (const q of selected(pipe)) {
      const label = q.name?.trim() || 'blank';
      if (!q.name?.trim()) { out.push({ q, msg: 'Name every ticked query.' }); continue; }
      if (!q.sql.trim()) { out.push({ q, msg: `Query "${label}" is empty.` }); continue; }
      if (placeholder(q.sql)) { out.push({ q, msg: `Query "${label}": replace XXX (select it, then Shift+click a dataset on the left).` }); continue; }
      const ts = tables(q.sql);
      if (!ts.length) { out.push({ q, msg: `Query "${label}" creates no table: write CREATE TABLE <name> AS SELECT ...` }); continue; }
      for (const t of ts) {
        if (!t.ok) out.push({ q, msg: `Query "${label}": "${t.table}" is not a valid table name (letters, digits and _).` });
        else if (imp.has(t.name)) out.push({ q, msg: `Query "${label}": ${t.name} is an imported dataset; pick another table name.` });
        else if (seen.has(t.name)) out.push({ q, msg: `${t.name} is created by "${seen.get(t.name)}" and "${label}"; give each table its own name.` });
        else seen.set(t.name, label);
      }
    }
    return out;
  }

  // pipeline/transform.sql: the ticked queries as they run (for reading).
  const sqlFile = ctx => `${ctx.dir}/pipeline/transform.sql`;
  async function writeSql(ctx, pipe) {
    const qs = selected(pipe);
    if (!qs.length) return DNFS.remove(sqlFile(ctx)).catch(() => {});
    await DNFS.write(sqlFile(ctx), `-- Data Noodler transform: the ticked queries, in the order they run (written by Transform on every save).\n`
      + qs.map(q => `\n-- ===== Query "${q.name}" (${q.id}) saves ${tables(q.sql).map(t => t.name).join(', ') || '(nothing)'} =====\n${q.sql.trim()}\n`).join(''));
  }

  async function views(ctx) { await ctx.reload(); return Engine.views(ctx.cfg.datasets || []); }

  // Returns the run record { at, ms, ok, outputs: [{ name, rows, before }], error }.
  async function run(ctx, pipe, log = () => {}, changed = null, onJob = () => {}) {
    const t0 = performance.now(), rec = { at: new Date().toISOString(), outputs: [], ok: true };
    try {
      if (!selected(pipe).length) throw new Error('Tick at least one query.');
      const cfg0 = await ctx.reload(), bad = problems(pipe, (cfg0.datasets || []).filter(d => Projects.stageOf(d) === 'imported').map(d => d.name));
      if (bad.length) throw new Error(bad[0].msg);
      for (const q of selected(pipe)) {
        const cfg = await ctx.reload(), ds = cfg.datasets || [];
        let lastStage = '';
        log(`Running query "${q.name}" (saves ${tables(q.sql).map(t => t.name).join(', ')})…`);
        const meta = { lineage: { transformQuery: q.id, transformName: q.name, pipelineVersion: pipe.rev || 0 } };
        const r = await Engine.writeTables({ sql: q.sql, views: Engine.views(ds), dir: `${ctx.dir}/data/source`, prefix: PRE, meta }, j => {
          onJob(j, q);
          if (j.stage && j.stage !== lastStage) { lastStage = j.stage; log(`${j.stage}…`); }
        });
        for (const { name, manifest: w } of r.datasets) {
          const before = ds.find(d => d.name === name);
          if (before && before.path !== w.path) await DNFS.remove(before.path, { recursive: !/\.(parquet|arrow)$/.test(before.path) }).catch(() => {});
          await Projects.upsertDataset(ctx.folder, { name, path: w.path, parts: w.files, stage: 'source', rows: w.rowCount, bytes: w.bytes, columns: Engine.columnsOf(w),
            version: w.version, imported: new Date().toISOString(), source: { kind: 'pipeline', query: q.id } });
          rec.outputs.push({ name, rows: w.rowCount, before: before?.rows ?? null });
          log(`${name}: ${UI.num(w.rowCount)} rows, ${(w.columns || []).length} columns, ${(w.files || []).length} part(s), ${UI.bytes(w.bytes)}`, 'ok');
        }
      }
    } catch (e) { rec.ok = false; rec.error = e.message; }
    rec.ms = Math.round(performance.now() - t0);
    const all = await runs(ctx); all.push(rec); await DNFS.writeJSON(runsFile(ctx), all.slice(-100));
    await Projects.touchModule(ctx.folder, 'pipeline', { ok: rec.ok });
    await ctx.reload();
    return rec;
  }
  return { PRE, load, runs, views, run, file, selected, tables, problems, placeholder, migrate, writeSql, sqlFile };
})();
