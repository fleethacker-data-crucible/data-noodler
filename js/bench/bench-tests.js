// Benchmark tests (html/benchmark.html). Global: BenchTests.
// Test data lives in temp/bench/data/<rows>/ (gitignored; Wipe Test Data removes it):
//   base/          Arrow dataset: the generated sales table (16 columns: ids, dates, timestamps, numbers, a 10k-value
//                  text key, a mostly-unique text column, low-cardinality text, a flag, NULLs)
//   src.csv / src.parquet / src.sqlite   the same rows in each import format
//   out/           what the tests write (overwritten each run)
// temp/bench/data/dim/  10,000-row store table for joins.
// Every test runs with a worker limit (1 .. max) and returns metrics { id, label, kind: read|write|query, ms, rows }:
// ms = the engine's own time (no HTTP), rows = rows the step works through.
const BenchTests = (() => {
  const DIR = 'temp/bench', DATA = `${DIR}/data`;
  const SIZES = [100000, 1000000, 5000000, 10000000, 25000000];
  const BATCHES = [10000, 50000, 100000, 250000, 500000, 1000000];
  const sizeLabel = n => n >= 1e6 ? `${n / 1e6}M` : `${n / 1e3}k`;
  const lit = s => `'${String(s).replace(/'/g, "''")}'`;
  const dirOf = n => `${DATA}/${n}`;

  const TESTS = [
    { id: 'import-csv', label: 'Import CSV', kind: 'read', desc: 'CSV file -> Arrow dataset (the Import / Stage path)' },
    { id: 'import-parquet', label: 'Import Parquet', kind: 'read', desc: 'Parquet file -> Arrow dataset' },
    { id: 'import-sqlite', label: 'Import SQLite', kind: 'read', desc: 'SQLite table -> Arrow dataset' },
    { id: 'export-csv', label: 'Export CSV', kind: 'write', desc: 'Arrow dataset -> CSV file' },
    { id: 'export-parquet', label: 'Export Parquet', kind: 'write', desc: 'Arrow dataset -> Parquet file (Snappy)' },
    { id: 'export-sqlite', label: 'Export SQLite', kind: 'write', desc: 'Arrow dataset -> SQLite table' },
    { id: 'rw-mem', label: 'Read/Write (memory)', kind: 'both', desc: 'Read: scan every column of an in-memory table. Write: copy it to another in-memory table' },
    { id: 'rw-csv', label: 'Read/Write CSV', kind: 'both', desc: 'Read: CSV file into memory. Write: memory -> CSV file' },
    { id: 'rw-parquet', label: 'Read/Write Parquet', kind: 'both', desc: 'Read: Parquet file into memory. Write: memory -> Parquet file' },
    { id: 'rw-arrow', label: 'Read/Write Arrow', kind: 'both', desc: 'Read: Arrow dataset into memory. Write: memory -> Arrow dataset' },
    { id: 'rw-sqlite', label: 'Read/Write SQLite', kind: 'both', desc: 'Read: SQLite table into memory. Write: memory -> SQLite table' },
    { id: 'heavy', label: 'Heavy queries', kind: 'query', desc: 'Joins, sorts, filters, GROUP BY, COUNT DISTINCT, window on an in-memory table' },
  ];
  // Heavy queries (bench_m = the table in memory, bench_d = stores). rows = the big table's rows.
  const HEAVY = [
    ['q-filter', 'Filter (2 conditions)', 'SELECT count(*), sum(qty) FROM bench_m WHERE price > 50 AND qty < 40'],
    ['q-calc', 'Calculations (5 expressions)', 'SELECT sum(qty * price * (1 - coalesce(discount, 0))), avg(price / (qty + 1)), max(abs(price - 50) * 2), sum(CASE WHEN qty > 50 THEN 1 ELSE 0 END), avg(length(customer)) FROM bench_m'],
    ['q-group', 'GROUP BY 10k key', 'SELECT store_key, sum(qty), count(*) FROM bench_m GROUP BY store_key'],
    ['q-group2', 'GROUP BY 2 keys, 5 aggregates', 'SELECT region, category, count(*), sum(amount), avg(price), min(order_date), max(discount) FROM bench_m GROUP BY region, category'],
    ['q-distinct', 'COUNT DISTINCT (mostly unique text)', 'SELECT count(DISTINCT customer) FROM bench_m'],
    ['q-join', 'Join + GROUP BY', 'SELECT d.segment, sum(f.qty * f.price), count(*) FROM bench_m f JOIN bench_d d ON f.store_id = d.store_id GROUP BY d.segment'],
    ['q-join2', 'Join + filter both sides', "SELECT count(*), avg(f.price) FROM bench_m f JOIN bench_d d ON f.store_id = d.store_id WHERE d.tier = 'A' AND f.qty > 20"],
    ['q-topn', 'ORDER BY ... LIMIT 100', 'SELECT id, price FROM bench_m ORDER BY price DESC, id LIMIT 100'],
    ['q-sort', 'Full sort (every row)', null],   // ORDER BY over all rows: built per size (OFFSET to the last rows)
    ['q-window', 'Window: rank per key', 'SELECT max(r) FROM (SELECT row_number() OVER (PARTITION BY store_key ORDER BY price DESC, id) AS r FROM bench_m) t'],
  ];

  // ---- test data ----
  const baseSql = n => `SELECT range AS id,
    CAST(CAST('2021-01-01' AS DATE) + CAST(range % 1826 AS INTEGER) AS DATE) AS order_date,
    add_seconds(CAST('2021-01-01 08:00:00' AS TIMESTAMP), range * 7 % 157680000) AS order_ts,
    CAST(range % 10000 AS INTEGER) AS store_id,
    'S' || CAST(range % 10000 AS VARCHAR) AS store_key,
    'C' || CAST((range * 7919) % ${Math.max(1000, Math.floor(n / 4))} AS VARCHAR) AS customer,
    CASE range % 8 WHEN 0 THEN 'Northeast' WHEN 1 THEN 'Southeast' WHEN 2 THEN 'Midwest' WHEN 3 THEN 'Southwest'
      WHEN 4 THEN 'Mountain' WHEN 5 THEN 'Pacific' WHEN 6 THEN 'Northwest' ELSE 'Great Lakes' END AS region,
    'Cat ' || CAST(range % 25 AS VARCHAR) AS category,
    CAST((range * 31) % 100 + 1 AS INTEGER) AS qty,
    ((range * 7) % 10000) / 100.0 AS price,
    CASE WHEN range % 20 = 0 THEN NULL ELSE ((range * 13) % 30) / 100.0 END AS discount,
    ((range * 11) % 6000) / 100.0 AS cost,
    range % 3 = 0 AS is_online,
    CASE WHEN range % 4 = 0 THEN NULL ELSE CAST(range % 5 + 1 AS INTEGER) END AS rating,
    CASE WHEN range % 20 = 1 THEN NULL ELSE 'note ' || CAST(range % 100 AS VARCHAR) END AS note,
    CAST(((range * 37) % 100000) / 100.0 AS DECIMAL(12,2)) AS amount
  FROM range(${n})`;
  const dimSql = `SELECT range AS store_id, 'SEG' || CAST(range % 12 AS VARCHAR) AS segment,
    CASE WHEN range % 3 = 0 THEN 'A' WHEN range % 3 = 1 THEN 'B' ELSE 'C' END AS tier FROM range(10000)`;
  const exists = async p => !!(await DNFS.stat(p, { quiet: true }).catch(() => ({}))).exists;

  // Makes whatever test data for n rows is missing (not timed). say(text) reports progress.
  async function ensureData(n, say, job) {
    const D = dirOf(n);
    if (!await exists(`${DATA}/dim/dataset.json`)) { say('Making the store table (10,000 rows)'); await job('write', { sql: dimSql, dest: `${DATA}/dim` }); }
    if (!await exists(`${D}/base/dataset.json`)) { say(`Making ${sizeLabel(n)} rows of test data (Arrow)`); await job('write', { sql: baseSql(n), dest: `${D}/base` }); }
    for (const f of ['csv', 'parquet', 'sqlite'])
      if (!await exists(`${D}/src.${f}`)) { say(`Making the ${sizeLabel(n)} ${f.toUpperCase()} file`); await job('export', { sql: `SELECT * FROM read_dataset(${lit(`${D}/base`)})`, to: `${D}/src.${f}`, format: f, table: 't' }); }
  }

  // Measures bytes per row of the test table in engine memory (two sample sizes, not saved) and returns, per size,
  // what the memory tests hold (the table + its copy) against what fits before the engine spills to disk (70% of budget).
  async function memoryPlan(call, budget, say) {
    const probes = [50000, 200000], per = [];
    for (let i = 0; i < probes.length; i++) {
      say(`Measuring ${sizeLabel(probes[i])} sample rows`, (i + 1) / (probes.length + 1));
      const r = await call('cache/load', { name: 'bench_probe', sql: baseSql(probes[i]) });
      per.push(r.bytes / Math.max(1, r.rows));
      await call('cache/drop', { name: 'bench_probe' }).catch(() => {});
    }
    const bpr = Math.max(...per), room = budget * 0.7, plan = {};
    for (const n of SIZES) { const need = n * bpr * 2; plan[n] = { need, room, fits: need <= room }; }
    say('Done', 1);
    return plan;
  }

  // ---- runs one test: returns metrics ----
  // ctx = { n, workers, job(op, body) -> job, call(op, body), say(text) }
  async function run(id, ctx) {
    const { n, workers, job, call } = ctx, D = dirOf(n), base = `read_dataset(${lit(`${D}/base`)})`;
    const src = { csv: `read_csv(${lit(`${D}/src.csv`)})`, parquet: `read_parquet(${lit(`${D}/src.parquet`)})`, sqlite: `read_sqlite(${lit(`${D}/src.sqlite`)}, 't')`, arrow: base };
    const m = (mid, label, kind, ms, rows = n) => ({ id: mid, label, kind, ms, rows });
    const t = TESTS.find(x => x.id === id);
    const fmt = id.split('-')[1];
    if (id.startsWith('import-')) {
      const j = await job('write', { sql: `SELECT * FROM ${src[fmt]}`, dest: `${D}/out/import_${fmt}`, workers });
      return [m(id, t.label, 'read', j.elapsedMs)];
    }
    if (id.startsWith('export-')) {
      const j = await job('export', { sql: `SELECT * FROM ${base}`, to: `${D}/out/export.${fmt}`, format: fmt, table: 't', workers });
      return [m(id, t.label, 'write', j.elapsedMs)];
    }
    if (id === 'rw-mem') {
      await ensureMem(ctx);
      const cols = 'count(*), max(id), max(order_date), max(order_ts), sum(store_id), max(store_key), max(customer), max(region), max(category), sum(qty), sum(price), sum(discount), sum(cost), sum(CASE WHEN is_online THEN 1 ELSE 0 END), sum(rating), max(note), sum(amount)';
      const r = await call('query', { sql: `SELECT ${cols} FROM bench_m`, workers });
      const w = await call('cache/load', { name: 'bench_m2', sql: 'SELECT * FROM bench_m', workers });
      await call('cache/drop', { name: 'bench_m2' });
      return [m('rw-mem:read', 'Read (memory)', 'read', r.ms), m('rw-mem:write', 'Write (memory)', 'write', w.ms)];
    }
    if (id.startsWith('rw-')) {
      await call('cache/drop', { name: 'bench_m' }); memFor = null;   // room for the copy being read (reloaded when needed)
      const r = await call('cache/load', { name: 'bench_r', sql: `SELECT * FROM ${src[fmt]}`, workers });
      try {
        const w = fmt === 'arrow' ? await job('write', { sql: 'SELECT * FROM bench_r', dest: `${D}/out/rw_arrow`, workers })
          : await job('export', { sql: 'SELECT * FROM bench_r', to: `${D}/out/rw.${fmt}`, format: fmt, table: 't', workers });
        return [m(`${id}:read`, `Read ${fmt === 'csv' ? 'CSV' : fmt === 'sqlite' ? 'SQLite' : fmt[0].toUpperCase() + fmt.slice(1)}`, 'read', r.ms),
          m(`${id}:write`, `Write ${fmt === 'csv' ? 'CSV' : fmt === 'sqlite' ? 'SQLite' : fmt[0].toUpperCase() + fmt.slice(1)}`, 'write', w.elapsedMs)];
      } finally { await call('cache/drop', { name: 'bench_r' }).catch(() => {}); }
    }
    if (id === 'heavy') {
      await ensureMem(ctx);
      const out = [];
      for (const [qid, label, sql0] of HEAVY) {
        if (ctx.stopped()) break;
        ctx.say(`${label} (${sizeLabel(n)} rows, ${workers} worker${workers > 1 ? 's' : ''})`);
        const sql = sql0 || `SELECT id, customer FROM bench_m ORDER BY customer, id LIMIT 10 OFFSET ${Math.max(0, n - 10)}`;
        try { const r = await call('query', { sql, workers }); out.push(m(qid, label, 'query', r.ms)); }
        catch (e) { out.push({ id: qid, label, kind: 'query', err: e.code === 'QUERY_OUT_OF_MEMORY' ? 'out of memory' : e.message.split('\n')[0] }); }
        ctx.onMetric?.(out[out.length - 1]);
      }
      return out;
    }
    throw new Error(`Unknown test ${id}`);
  }
  // The table in memory (bench_m) + stores (bench_d) for the memory and query tests; loaded once per size (not timed).
  let memFor = null;
  async function ensureMem(ctx) {
    if (memFor === ctx.n) return;
    ctx.say(`Loading ${sizeLabel(ctx.n)} rows into engine memory (not timed)`);
    await ctx.call('cache/drop', { name: 'bench_m' }).catch(() => {});
    memFor = null;
    await ctx.call('cache/load', { name: 'bench_m', sql: `SELECT * FROM read_dataset(${lit(`${dirOf(ctx.n)}/base`)})` });
    await ctx.call('cache/load', { name: 'bench_d', sql: `SELECT * FROM read_dataset(${lit(`${DATA}/dim`)})` });
    memFor = ctx.n;
  }
  async function dropMem(call) { memFor = null; for (const t of ['bench_m', 'bench_m2', 'bench_r', 'bench_d']) await call('cache/drop', { name: t }).catch(() => {}); }

  // Metric rows of a test, in table order (before it has run).
  const metricsOf = id => id === 'heavy' ? HEAVY.map(([q, l]) => ({ id: q, label: l, kind: 'query' }))
    : id.startsWith('rw-') ? [{ id: `${id}:read`, kind: 'read' }, { id: `${id}:write`, kind: 'write' }] : [{ id, kind: TESTS.find(t => t.id === id).kind }];

  return { memoryPlan, DIR, DATA, SIZES, BATCHES, TESTS, HEAVY, sizeLabel, ensureData, run, dropMem, metricsOf };
})();
