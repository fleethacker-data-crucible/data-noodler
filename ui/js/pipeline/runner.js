// Runs a project's transform on the native engine. Global: PipelineRunner. Needs projects.js, engine-client.js.
// transform/transform.json = { version: 4, queries: [{ id, name, sql, run: true }], rev, updated }.
// Each query is a SQL script (see server/data-engine/Core/Script.cs). Every CREATE TABLE <NAME> AS ... in it (not
// CREATE TEMP TABLE: helpers) is saved as the dataset data/clean/CLEAN_<NAME>/ (the CLEAN_ prefix is added, never doubled).
// Ticked queries (run: true) run, in list order, on Run Selected and on Update.
//   await PipelineRunner.load(ctx)                   transform/transform.json (older versions are converted)
//   PipelineRunner.selected(pipe)                    every query that has SQL, in Query Output Tables order (Update runs them all)
//   PipelineRunner.tables(sql)                       [{ table, name, ok }] the datasets a query saves (name = CLEAN_...)
//   PipelineRunner.problems(pipe, imported)          [{ q, msg }] what stops the ticked queries from running
//   await PipelineRunner.writeSql(ctx, pipe)         transform/transform.sql = every query, in run order (for reading)
//   await PipelineRunner.run(ctx, pipe, log, changed, onJob)   runs every ticked query; records the run. Stops at the
//                                                    first failure. changed: unused, kept for Update.
const PipelineRunner = (() => {
  const file = ctx => `${ctx.dir}/transform/transform.json`, runsFile = ctx => `${ctx.dir}/transform/runs.json`;
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
  const selected = pipe => pipe.only || (pipe.queries || []).filter(q => (q.sql || '').trim());   // pipe.only: run just these (Transform Run)

  // What stops the ticked queries: a name, SQL, XXX left, no table created, two queries saving the same dataset,
  // a dataset named like an imported one. imported = imported dataset names.
  function problems(pipe, imported = []) {
    const out = [], seen = new Map(), imp = new Set(imported.map(n => n.toUpperCase()));
    for (const q of selected(pipe)) {
      const label = q.name?.trim() || 'blank';
      if (!q.name?.trim()) { out.push({ q, msg: 'A query has no CREATE TABLE name.' }); continue; }
      if (!q.sql.trim()) { out.push({ q, msg: `Query "${label}" is empty.` }); continue; }
      if (placeholder(q.sql)) { out.push({ q, msg: `Query "${label}": replace XXX (select it, then Shift+click a dataset on the right).` }); continue; }
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

  // transform/transform.sql: every query, in run order (for reading).
  const sqlFile = ctx => `${ctx.dir}/transform/transform.sql`;
  // Every query as one script, in run order (transform.sql and Transform > Export SQL).
  const sqlText = pipe => '-- Data Noodler transform: every query, in the order they run.\n'
    + selected(pipe).map(q => `\n-- ===== Query "${q.name}" saves ${tables(q.sql).map(t => t.name).join(', ') || '(nothing)'} =====\n${q.sql.trim()}\n`).join('');
  async function writeSql(ctx, pipe) {
    if (!selected(pipe).length) return DNFS.remove(sqlFile(ctx)).catch(() => {});
    await DNFS.write(sqlFile(ctx), sqlText(pipe));
  }

  // The datasets as views, plus every named query as a table under the exact name in the Query Output Tables list:
  //   CREATE TABLE name AS <select> (one statement) -> that SELECT, live (works before the query has ever run);
  //   a plain SELECT -> that SELECT; a longer script -> its saved CLEAN_ table (once it has run).
  // Dataset names win; self (the query being written / run) is left out.
  function queryViews(pipe, ds, self) {
    const v = Engine.views(ds || []), have = new Set(Object.keys(v).map(k => k.toUpperCase()));
    for (const q of pipe.queries || []) {
      const n = (q.name || '').trim(); if (!n || q === self || have.has(n.toUpperCase())) continue;
      const sql = (q.sql || '').trim().replace(/;\s*$/, ''), one = !strip(sql).includes(';');
      const ctas = one && sql.match(/^\s*CREATE\s+(?:GLOBAL\s+TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"[^"]+"|[A-Za-z_][\w$#]*)\s+AS\s+([\s\S]+)$/i);
      const t = tables(sql).find(x => x.ok);
      if (ctas) v[n] = ctas[1];
      else if (one && /^(SELECT|WITH)\b/i.test(sql)) v[n] = sql;
      else if (t && (ds || []).some(d => d.name === t.name)) v[n] = `SELECT * FROM ${Engine.q(t.name)}`;
      else continue;
      have.add(n.toUpperCase());
    }
    return v;
  }
  async function views(ctx) { await ctx.reload(); return Engine.views(ctx.cfg.datasets || []); }

  // Returns the run record { at, ms, ok, outputs: [{ name, rows, before }], error }.
  // onQuery(q, 'start' | 'done'): each ticked query as it starts and when its tables are saved (Transform's status).
  async function run(ctx, pipe, log = () => {}, changed = null, onJob = () => {}, onQuery = () => {}) {
    const t0 = performance.now(), rec = { at: new Date().toISOString(), outputs: [], ok: true };
    try {
      if (!selected(pipe).length) throw new Error('No queries to run: write one in Transform first.');
      const cfg0 = await ctx.reload(), bad = problems(pipe, (cfg0.datasets || []).filter(d => Projects.stageOf(d) === 'imported').map(d => d.name));
      if (bad.length) throw new Error(bad[0].msg);
      for (const q of selected(pipe)) {
        const cfg = await ctx.reload(), ds = cfg.datasets || [];
        let lastStage = '';
        log(`Running query "${q.name}" (saves ${tables(q.sql).map(t => t.name).join(', ')})…`);
        onQuery(q, 'start');
        const meta = { lineage: { transformQuery: q.id, transformName: q.name, pipelineVersion: pipe.rev || 0 } };
        const r = await Engine.writeTables({ sql: q.sql, views: queryViews(pipe, ds, q), dir: `${ctx.dir}/data/clean`, prefix: PRE, meta }, j => {
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
        onQuery(q, 'done');
      }
    } catch (e) { rec.ok = false; rec.error = e.message; }
    rec.ms = Math.round(performance.now() - t0);
    const all = await runs(ctx); all.push(rec); await DNFS.writeJSON(runsFile(ctx), all.slice(-100));
    await Projects.touchModule(ctx.folder, 'pipeline', { ok: rec.ok });
    await ctx.reload();
    return rec;
  }
  return { PRE, load, runs, views, queryViews, run, file, selected, tables, problems, placeholder, migrate, writeSql, sqlFile, sqlText };
})();
