// Client for the native C# data engine (runs inside the local server; see .claude/docs/ARCHITECTURE.md). Global: Engine.
// The browser never crunches data: it sends SQL (or a declarative query) and gets compact results back.
//   await Engine.query(sql, { views, limit, workers })   -> { cols, types, rows, rowCount, truncated, ms }
//   await Engine.describe(sql, views)                    -> [{ name, type }]
//   await Engine.count(fromSql, views)                   -> number of rows
//   await Engine.countLive(fromSql, views, onProgress)   -> the same, as a job (onProgress gets rowsProcessed live)
//   await Engine.check(sql, views)                       -> [{ pos, end, line, message, code }] syntax / name errors (editor)
//   await Engine.preview(sql, { views, limit, workers }) -> query result + { count }: first rows and the total of a query or
//                                                           script (statements ending in a SELECT), rows and count in parallel
//   await Engine.open(src, table)                        -> { kind, tables, columns, rows, size, modified }  (project path or X:\... / \\server\...)
//   await Engine.write({ sql, views, dest, meta }, onProgress)    -> dataset manifest { path, files, rowCount, bytes, columns, version, ... }
//   await Engine.writeTables({ sql, views, dir, prefix, meta }, onProgress) -> { datasets: [{ table, name, manifest }] }: every CREATE TABLE (not TEMP) of the script
//   await Engine.exportTo({ sql, views, to, format, table }, onProgress) -> { path, rows, bytes, format }
//   await Engine.pipeline(spec, onProgress)              -> { outputs, skipped, order, ms }
//   await Engine.memory.load(paths)  / preload(paths)    project datasets into engine memory (load waits, preload does not)
//                                                         -> [{ path, state: resident|loading|skipped|error, rows, bytes, reason }]
//   await Engine.memory.info() / drop(path)               what is resident; free it (path = folder prefix, none = all)
//   Closing a window that loaded datasets releases them (memory/release); the last such window purges engine memory.
//   Engine.src(path, table)  SQL source for a file: read_csv / read_dataset (Arrow / Parquet) / read_sqlite
//   Engine.views(datasets)   { name: 'SELECT * FROM read_dataset(...)' } for a project's datasets
// Datasets are folders of Arrow IPC parts (the working format; older ones Parquet); Parquet / CSV / SQLite = export only.
//   Engine.q(name) / Engine.lit(text)   quote an identifier / a string literal
// Views are named SQL snippets the query can use as tables (datasets, pipeline steps).
const Engine = (() => {
  const KINDS = { csv: 'csv', tsv: 'csv', txt: 'csv', parquet: 'parquet', pq: 'parquet', arrow: 'arrow', feather: 'arrow', sqlite: 'sqlite', sqlite3: 'sqlite', db: 'sqlite' };
  const kind = path => KINDS[(String(path).split('.').pop() || '').toLowerCase()] || null;
  const q = s => '"' + String(s).replace(/"/g, '""') + '"';
  const lit = s => "'" + String(s).replace(/'/g, "''") + "'";

  async function call(op, body, method = body === undefined ? 'GET' : 'POST') {
    let r;
    try {
      r = await fetch('/api/data-engine/' + op, { method, cache: 'no-store', headers: { 'X-DN-Token': window.DN_TOKEN || '', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) { throw new Error('Engine not reachable: is the server running?'); }
    let j;
    try { j = await r.json(); } catch { throw new Error(`Engine: HTTP ${r.status}`); }
    if (!j.ok) { const e = new Error(j.error || `Engine: HTTP ${r.status}`); e.code = j.code; e.status = r.status; throw e; }
    return j;
  }

  const src = (path, table) => {
    const k = kind(path);
    if (k === 'csv') return `read_csv(${lit(path)})`;
    if (k === 'sqlite') return `read_sqlite(${lit(path)}, ${lit(table || '')})`;
    return `read_dataset(${lit(path)})`;   // an .arrow / .parquet file or a dataset folder
  };
  // A dataset record { path, parts } as SQL: the folder (or legacy single file) holds its own part list.
  const dataset = d => `read_dataset(${lit(d.path)})`;
  const views = (datasets = []) => Object.fromEntries(datasets.map(d => [d.name, `SELECT * FROM ${dataset(d)}`]));

  const query = (sql, { views, limit, workers } = {}) => call('query', { sql, views, limit, workers });
  const describe = async (sql, views) => (await call('describe', { sql, views })).columns;
  const count = async (from, views) => Number((await query(`SELECT count(*) FROM ${from}`, { views })).rows[0][0]);
  // Same count as a job: onProgress(job) gets rowsProcessed (rows read so far) while it runs.
  const countLive = async (from, views, onProgress) => Number((await job('query', { sql: `SELECT count(*) FROM ${from}`, views, async: true }, onProgress)).rows[0][0]);
  const preview = (sql, { views, limit = 100, workers } = {}) => call('preview', { sql, views, limit, workers });
  const check = async (sql, views) => (await call('check', { sql, views })).errors;
  const open = (src, table) => call('open', { src, table });

  // Start a job and poll it until it ends. onProgress(job) gets { state, stage, progress, rowsProcessed, ... }.
  async function job(op, body, onProgress = () => {}) {
    let j = await call(op, body);
    const id = j.jobId;
    for (let wait = 150; ; wait = Math.min(1000, wait * 1.5)) {
      if (j.state === 'done') { onProgress(j); return j.result; }
      if (j.state === 'failed' || j.state === 'cancelled') { const e = new Error(j.error?.message || `Job ${j.state}`); e.code = j.error?.code; throw e; }
      onProgress(j);
      await new Promise(r => setTimeout(r, wait));
      j = await call('job?id=' + encodeURIComponent(id), undefined, 'GET');
    }
  }
  const write = (o, onProgress) => job('write', o, onProgress);
  const writeTables = (o, onProgress) => job('write-tables', o, onProgress);
  const exportTo = (o, onProgress) => job('export', o, onProgress);
  const pipeline = (spec, onProgress) => job('pipeline', spec, onProgress);
  const cancel = id => call('job/cancel?id=' + encodeURIComponent(id), {});
  const status = () => call('status');
  const cache = { load: (name, sql, views, workers) => call('cache/load', { name, sql, views, workers }), drop: name => call('cache/drop', { name }) };
  const paths = p => (p || []).filter(Boolean);
  // This window is a client of the engine: datasets it loads stay in memory while it is open. Closing it releases
  // them (the engine drops what no other window holds, and purges everything when no window holds anything).
  const client = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now();
  let holds = false;
  const hold = () => { holds = true; return client; };
  addEventListener('pagehide', () => {
    if (!holds) return;
    holds = false;
    try { fetch('/api/data-engine/memory/release', { method: 'POST', keepalive: true, headers: { 'X-DN-Token': window.DN_TOKEN || '', 'Content-Type': 'application/json' }, body: JSON.stringify({ client }) }); } catch {}
  });
  const memory = {
    load: async p => (await call('memory/load', { paths: paths(p), wait: true, client: hold() })).datasets,
    preload: async p => (await call('memory/load', { paths: paths(p), wait: false, client: hold() })).datasets,
    info: () => call('memory'),
    drop: path => call('memory/drop', { path: path || '' }),
  };

  // Columns of a written dataset manifest, in the { name, type } form dataset records use.
  const columnsOf = m => (m.columns || []).map(c => ({ name: c.name, type: c.type }));

  return { kind, q, lit, src, dataset, views, query, describe, count, countLive, preview, check, open, job, write, writeTables, exportTo, pipeline, cancel, status, cache, memory, columnsOf, call };
})();
