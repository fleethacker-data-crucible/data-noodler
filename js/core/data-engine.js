// The app's data engine. Global: DataEngine. Needs dn-fs.js, duckdb-engine.js, duckdb-pool.js.
//   const e = await DataEngine.main()                  shared single DuckDB engine for this page
//   DataEngine.plan('group', 12_000_000)               { engines, from } using js/duckdb/optimal-engine-profile.json
//   await DataEngine.parallel({ path, rows, kind, partial, final })
//        runs partial(src) on N engines, each over its own row range of a Parquet file, then final over __parts
//
// Engine counts come from the saved profile (engine-bench.html "Profile"): the entry for that kind of query
// with the row count nearest to this one. With no profile yet, a simple rule is used.
const DataEngine = (() => {
  const PROFILE = 'js/duckdb/optimal-engine-profile.json';
  const cores = navigator.hardwareConcurrency || 4, MAX = Math.min(16, cores);
  let main, profile, pool, poolSize = 0;

  async function getMain() { if (!main) { main = DuckEngine; await main.init(); } return main; }
  async function loadProfile(force) {
    if (profile && !force) return profile;
    try { profile = await DNFS.readJSONOr(PROFILE, { tests: {} }); } catch { profile = { tests: {} }; }
    return profile;
  }

  // kind = a profile test id: scan, group, dist, sort, join, window. source = 'http' or 'memory'.
  function plan(kind, rows, source = 'http') {
    const es = Object.values(profile?.tests?.[kind]?.entries || {}).filter(e => e.engines && e.source === source);
    if (es.length) {
      const e = es.reduce((a, b) => Math.abs(Math.log(b.rows / rows)) < Math.abs(Math.log(a.rows / rows)) ? b : a);
      return { engines: Math.min(e.engines, MAX), from: 'profile', nearRows: e.rows };
    }
    // No profile yet: 1 engine below 1M rows, then about one engine per 2M rows.
    return { engines: rows < 1e6 ? 1 : Math.min(MAX, Math.max(2, Math.round(rows / 2e6))), from: 'default' };
  }

  // A pool big enough for n engines, kept for the life of the page (engine start-up costs ~1 s).
  async function getPool(n) {
    if (pool && poolSize >= n) return pool;
    await pool?.close();
    pool = await DuckPool.create(n, { memoryLimitGB: Math.max(0.5, Math.min(3, Math.floor(100 / n) / 10)) });
    poolSize = n;
    return pool;
  }

  // Row range [a, b) of a Parquet file as a SQL source (file_row_number = position in the file).
  const rangeSrc = (url, a, b) => `(SELECT * EXCLUDE (file_row_number) FROM read_parquet('${url}', file_row_number = true) WHERE file_row_number >= ${a} AND file_row_number < ${b})`;

  // partial(src) -> SQL over one share; final -> SQL over table __parts. Returns { cols, rows, ms, engines, from }.
  // parts = part files of a split dataset (ParquetWriter): each engine gets whole parts instead of a row range.
  async function parallel({ path, parts = null, rows, kind = 'group', partial, final, source = 'http' }) {
    await loadProfile();
    const p = plan(kind, rows, source);
    const n = Math.max(1, parts?.length ? Math.min(p.engines, parts.length) : p.engines);
    const e = await getMain(), url = e.url(path);
    const list = ps => `read_parquet([${ps.map(f => `'${e.url(f)}'`).join(', ')}])`;
    if (n === 1) {
      const r = await e.query(final.replaceAll('__parts', `(${partial(parts?.length ? list(parts) : `read_parquet('${url}')`)})`));
      return { ...r, engines: 1, from: p.from };
    }
    const pl = await getPool(n);
    const share = parts?.length
      ? i => list(parts.filter((_, k) => k % n === i))
      : i => rangeSrc(url, Math.floor(rows * i / n), Math.floor(rows * (i + 1) / n));
    const r = await pl.run(i => partial(share(i)), final, n);
    return { cols: r.cols, rows: r.rows, ms: r.ms, engines: n, from: p.from };
  }

  async function close() { await pool?.close(); pool = null; poolSize = 0; }
  return { main: getMain, loadProfile, plan, parallel, close, get maxEngines() { return MAX; } };
})();
