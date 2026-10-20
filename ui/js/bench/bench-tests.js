// Benchmark tests (ui/html/benchmark.html). Global: BenchTests.
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
    { id: 'import-csv', label: 'Import CSV', kind: 'read', desc: 'CSV file -> Arrow dataset (the Import path)' },
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
    ['q-topn', 'ORDER BY ... FETCH FIRST 100', 'SELECT id, price FROM bench_m ORDER BY price DESC, id FETCH FIRST 100 ROWS ONLY'],
    ['q-sort', 'Full sort (every row)', null],   // ORDER BY over all rows: built per size (OFFSET to the last rows)
    ['q-window', 'Window: rank per key', 'SELECT max(r) FROM (SELECT row_number() OVER (PARTITION BY store_key ORDER BY price DESC, id) AS r FROM bench_m) t'],
  ];

  // ---- test data ----
  const baseSql = n => `SELECT range AS id,
    TRUNC(DATE '2021-01-01' + MOD(range, 1826)) AS order_date,
    TIMESTAMP '2021-01-01 08:00:00' + MOD(range * 7, 157680000) / 86400 AS order_ts,
    CAST(MOD(range, 10000) AS INTEGER) AS store_id,
    'S' || TO_CHAR(MOD(range, 10000)) AS store_key,
    'C' || TO_CHAR(MOD(range * 7919, ${Math.max(1000, Math.floor(n / 4))})) AS customer,
    CASE MOD(range, 8) WHEN 0 THEN 'Northeast' WHEN 1 THEN 'Southeast' WHEN 2 THEN 'Midwest' WHEN 3 THEN 'Southwest'
      WHEN 4 THEN 'Mountain' WHEN 5 THEN 'Pacific' WHEN 6 THEN 'Northwest' ELSE 'Great Lakes' END AS region,
    'Cat ' || TO_CHAR(MOD(range, 25)) AS category,
    CAST(MOD(range * 31, 100) + 1 AS INTEGER) AS qty,
    MOD(range * 7, 10000) / 100.0 AS price,
    CASE WHEN MOD(range, 20) = 0 THEN NULL ELSE MOD(range * 13, 30) / 100.0 END AS discount,
    MOD(range * 11, 6000) / 100.0 AS cost,
    CASE WHEN MOD(range, 3) = 0 THEN TRUE ELSE FALSE END AS is_online,
    CASE WHEN MOD(range, 4) = 0 THEN NULL ELSE CAST(MOD(range, 5) + 1 AS INTEGER) END AS rating,
    CASE WHEN MOD(range, 20) = 1 THEN NULL ELSE 'note ' || TO_CHAR(MOD(range, 100)) END AS note,
    CAST(MOD(range * 37, 100000) / 100.0 AS NUMBER(12,2)) AS amount
  FROM range(${n})`;
  const dimSql = `SELECT range AS store_id, 'SEG' || TO_CHAR(MOD(range, 12)) AS segment,
    CASE WHEN MOD(range, 3) = 0 THEN 'A' WHEN MOD(range, 3) = 1 THEN 'B' ELSE 'C' END AS tier FROM range(10000)`;
  const exists = async p => !!(await DNFS.stat(p, { quiet: true }).catch(() => ({}))).exists;

  // Is the base test table for n rows there?
  const hasData = n => exists(`${dirOf(n)}/base/dataset.json`);
  // Makes whatever test data for n rows is missing (not timed). say(text, rows) reports each step (rows it writes).
  // Every test file that can be made: { key, n, label, path, exists }. key = 'dim' | '<n>:base|csv|parquet|sqlite'.
  async function dataItems() {
    const items = [{ key: 'dim', n: 0, label: 'Store table (10,000 rows, for joins)', path: `${DATA}/dim/dataset.json` }];
    for (const n of SIZES) {
      items.push({ key: `${n}:base`, n, label: `${sizeLabel(n)} rows: Arrow dataset (the table every test reads)`, path: `${dirOf(n)}/base/dataset.json` });
      for (const f of ['csv', 'parquet', 'sqlite']) items.push({ key: `${n}:${f}`, n, label: `${sizeLabel(n)} rows: ${f === 'csv' ? 'CSV' : f === 'sqlite' ? 'SQLite' : 'Parquet'} file`, path: `${dirOf(n)}/src.${f}` });
    }
    await Promise.all(items.map(async i => { i.exists = await exists(i.path); }));
    return items;
  }
  // Makes the picked items (keys) that are missing; a size's files need its Arrow dataset, so that is made first.
  async function makeItems(keys, say, job) {
    const want = new Set(keys);
    if (want.size && !await exists(`${DATA}/dim/dataset.json`)) want.add('dim');
    if (want.has('dim') && !await exists(`${DATA}/dim/dataset.json`)) { say('Making the store table (10,000 rows)', 10000); await job('write', { sql: dimSql, dest: `${DATA}/dim` }); }
    for (const n of SIZES) {
      const D = dirOf(n), fs = ['csv', 'parquet', 'sqlite'].filter(f => want.has(`${n}:${f}`));
      if ((want.has(`${n}:base`) || fs.length) && !await exists(`${D}/base/dataset.json`)) { say(`Making ${sizeLabel(n)} rows of test data (Arrow)`, n); await job('write', { sql: baseSql(n), dest: `${D}/base` }); }
      for (const f of fs)
        if (!await exists(`${D}/src.${f}`)) { say(`Making the ${sizeLabel(n)} ${f.toUpperCase()} file`, n); await job('export', { sql: `SELECT * FROM read_dataset(${lit(`${D}/base`)})`, to: `${D}/src.${f}`, format: f, table: 't' }); }
    }
  }
  // How many files makeItems(keys) will make (picked missing files + the Arrow tables they need + the store table).
  async function stepsFor(keys) {
    const want = new Set(keys); let k = 0;
    if (want.size && !await exists(`${DATA}/dim/dataset.json`)) k++;
    for (const n of SIZES) {
      const fs = ['csv', 'parquet', 'sqlite'].filter(f => want.has(`${n}:${f}`));
      if ((want.has(`${n}:base`) || fs.length) && !await exists(`${dirOf(n)}/base/dataset.json`)) k++;
      for (const f of fs) if (!await exists(`${dirOf(n)}/src.${f}`)) k++;
    }
    return k;
  }
  async function ensureData(n, say, job) {
    const D = dirOf(n);
    if (!await exists(`${DATA}/dim/dataset.json`)) { say('Making the store table (10,000 rows)', 10000); await job('write', { sql: dimSql, dest: `${DATA}/dim` }); }
    if (!await exists(`${D}/base/dataset.json`)) { say(`Making ${sizeLabel(n)} rows of test data (Arrow)`, n); await job('write', { sql: baseSql(n), dest: `${D}/base` }); }
    for (const f of ['csv', 'parquet', 'sqlite'])
      if (!await exists(`${D}/src.${f}`)) { say(`Making the ${sizeLabel(n)} ${f.toUpperCase()} file`, n); await job('export', { sql: `SELECT * FROM read_dataset(${lit(`${D}/base`)})`, to: `${D}/src.${f}`, format: f, table: 't' }); }
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
    const part = ctx.part || (() => {}), act = ctx.act || (() => {});
    // Timed engine calls run as jobs so the page sees rows read as they go; the metric is the engine's own time.
    const aj = async (op, body) => (await job(op, { ...body, async: true })).result;
    // Fast in-memory steps (a few ms to a few hundred) are noisy from run to run (garbage collection, timer rounding):
    // they run again until about 1 s of engine time or 5 runs, and the median is kept.
    const timed = async fn => {
      const t = []; let sum = 0;
      do { const ms = await fn(); t.push(ms); sum += ms; } while (sum < 1000 && t.length < 5 && !ctx.stopped());
      t.sort((a, b) => a - b);
      return t.length % 2 ? t[t.length >> 1] : (t[t.length / 2 - 1] + t[t.length / 2]) / 2;
    };
    if (id.startsWith('import-')) {
      act('read'); part(0, 1, n);
      const j = await job('write', { sql: `SELECT * FROM ${src[fmt]}`, dest: `${D}/out/import_${fmt}`, workers });
      return [m(id, t.label, 'read', j.elapsedMs)];
    }
    if (id.startsWith('export-')) {
      act('write'); part(0, 1, n);
      const j = await job('export', { sql: `SELECT * FROM ${base}`, to: `${D}/out/export.${fmt}`, format: fmt, table: 't', workers });
      return [m(id, t.label, 'write', j.elapsedMs)];
    }
    if (id === 'rw-mem') {
      await ensureMem(ctx);
      const cols = 'count(*), max(id), max(order_date), max(order_ts), sum(store_id), max(store_key), max(customer), max(region), max(category), sum(qty), sum(price), sum(discount), sum(cost), sum(CASE WHEN is_online THEN 1 ELSE 0 END), sum(rating), max(note), sum(amount)';
      act('read'); part(0, 0.5, n);
      const rMs = await timed(async () => (await aj('query', { sql: `SELECT ${cols} FROM bench_m`, workers })).ms);
      act('write'); part(0.5, 1, n);
      const wMs = await timed(async () => { const w = await aj('cache/load', { name: 'bench_m2', sql: 'SELECT * FROM bench_m', workers }); await call('cache/drop', { name: 'bench_m2' }); return w.ms; });
      return [m('rw-mem:read', 'Read (memory)', 'read', rMs), m('rw-mem:write', 'Write (memory)', 'write', wMs)];
    }
    if (id.startsWith('rw-')) {
      await call('cache/drop', { name: 'bench_m' }); memFor = null;   // room for the copy being read (reloaded when needed)
      act('read'); part(0, 0.5, n);
      const r = await aj('cache/load', { name: 'bench_r', sql: `SELECT * FROM ${src[fmt]}`, workers });
      act('write'); part(0.5, 1, n);
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
      for (const [qi, [qid, label, sql0]] of HEAVY.entries()) {
        if (ctx.stopped()) break;
        part(qi / HEAVY.length, (qi + 1) / HEAVY.length, 0, n / (qid === 'q-sort' || qid === 'q-window' ? 2e6 : 15e6) * 1000);
        ctx.say(`${label} (${sizeLabel(n)} rows, ${workers} worker${workers > 1 ? 's' : ''})`);
        const sql = sql0 || `SELECT id, customer FROM bench_m ORDER BY customer, id OFFSET ${Math.max(0, n - 10)} ROWS FETCH NEXT 10 ROWS ONLY`;
        act('query');
        try { out.push(m(qid, label, 'query', await timed(async () => (await aj('query', { sql, workers })).ms))); }
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
    ctx.loading?.(ctx.n);
    await ctx.call('cache/drop', { name: 'bench_m' }).catch(() => {});
    memFor = null;
    await ctx.call('cache/load', { name: 'bench_m', sql: `SELECT * FROM read_dataset(${lit(`${dirOf(ctx.n)}/base`)})` });
    await ctx.call('cache/load', { name: 'bench_d', sql: `SELECT * FROM read_dataset(${lit(`${DATA}/dim`)})` });
    memFor = ctx.n;
    ctx.loaded?.();
  }
  async function dropMem(call) { memFor = null; for (const t of ['bench_m', 'bench_m2', 'bench_r', 'bench_d']) await call('cache/drop', { name: t }).catch(() => {}); }

  // Metric rows of a test, in table order (before it has run).
  const metricsOf = id => id === 'heavy' ? HEAVY.map(([q, l]) => ({ id: q, label: l, kind: 'query' }))
    : id.startsWith('rw-') ? [{ id: `${id}:read`, kind: 'read' }, { id: `${id}:write`, kind: 'write' }] : [{ id, kind: TESTS.find(t => t.id === id).kind }];

  return { memoryPlan, hasData, dataItems, makeItems, stepsFor, DIR, DATA, SIZES, BATCHES, TESTS, HEAVY, sizeLabel, ensureData, run, dropMem, metricsOf };
})();
