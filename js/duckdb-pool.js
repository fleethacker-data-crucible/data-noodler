// A pool of independent single-threaded DuckDB engines. Global: DuckPool. Needs duckdb-engine.js.
// Each engine is its own worker with its own memory (up to 4 GB each), so N engines use N CPU cores.
// Data is split into partitions, one per engine. run() sends each engine the same "partial" query on
// its own partition in parallel, then engine 0 combines the partial results with a "final" query.
//
//   const pool = await DuckPool.create(4);
//   const r = await pool.run(i => `SELECT region, sum(total) s FROM read_parquet('${pool.engines[i].url(`parts/p${i}.parquet`)}') GROUP BY 1`,
//                            'SELECT region, sum(s) total FROM __parts GROUP BY 1');
const DuckPool = {
  // Coordination cost per engine (ms): median time of a trivial job on the pool, divided by its size.
  async overhead(pool, reps = 7) {
    const job = () => pool.run(() => 'SELECT 1 x', 'SELECT sum(x) FROM __parts');
    await job();
    const t = [];
    for (let i = 0; i < reps; i++) t.push((await job()).ms);
    return t.sort((a, b) => a - b)[reps >> 1] / pool.size;
  },
  // Engine count that minimises estimated time T(N) = workMs / N + perEngineMs * N,
  // i.e. N = sqrt(workMs / perEngineMs), clamped to 1..max.
  bestCount(workMs, perEngineMs, max) {
    return Math.max(1, Math.min(max, Math.round(Math.sqrt(workMs / Math.max(perEngineMs, 0.05)))));
  },

  // Start n engines in parallel. opts go to each engine's init().
  async create(n, opts = {}) {
    const engines = Array.from({ length: n }, () => createDuckEngine());
    await Promise.all(engines.map(e => e.init({ build: 'eh', threads: 1, ...opts })));
    const coord = engines[0];
    return {
      engines,
      get size() { return engines.length; },
      // partial(i, engine) -> SQL for partition i. final -> SQL over the combined partial results in table __parts.
      // n = use only the first n engines (default: all). Returns { cols, rows, ms (total), partialMs: [per engine], combineMs }.
      async run(partial, final, n = engines.length) {
        const t0 = performance.now();
        const parts = await Promise.all(engines.slice(0, n).map(async (e, i) => {
          const t = performance.now(), tbl = await e.queryArrow(partial(i, e));
          return { tbl, ms: performance.now() - t };
        }));
        const t1 = performance.now();
        await coord.drop('__parts');
        for (const [i, p] of parts.entries()) await coord.insertArrow(p.tbl, '__parts', i === 0);
        const r = await coord.query(final);
        await coord.drop('__parts');
        const t2 = performance.now();
        return { ...r, ms: t2 - t0, partialMs: parts.map(p => p.ms), combineMs: t2 - t1 };
      },
      // Run fn(engine, i) on every engine in parallel.
      each(fn) { return Promise.all(engines.map(fn)); },
      async close() { await Promise.all(engines.map(e => e.close().catch(() => {}))); },
    };
  },
};
