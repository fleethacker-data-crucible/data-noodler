// Data Grid on the engine: the grid never holds the whole dataset. Its search box, column filters and sort are turned
// into one SQL query (WHERE / ORDER BY / LIMIT / OFFSET) that the engine runs on all workers (the dataset's in-memory
// table when the Dashboard loaded one, else its Parquet parts). The first 100 rows load at once, then 100 more at a time as
// the reader nears the end. Global: GridRemote.
//   GridRemote.attach(grid, { dataset, views(), cols, columns, where, onCount(total, loaded, stat) })
//     views() = engine views for the dataset; cols = the picked fields; columns = [{ name, type }] of the dataset;
//     where = SQL from the Dashboard's Filter widgets.
const GridRemote = (() => {
  const PAGE = 100, MORE = 100;   // first 100 rows, then the next 100 each time the reader nears the end
  const NUM = /INT|DOUBLE|FLOAT|DECIMAL|REAL|NUMERIC/i, BOOL = /BOOL/i;
  const qid = c => `"${String(c).replace(/"/g, '""')}"`;
  const str = v => `'${String(v ?? '').replace(/'/g, "''")}'`;

  // One grid filter expression -> SQL. Expressions: { key, condition: { name } | name, searchTerm, criteria, caseSensitive }.
  function term(e, types) {
    const c = qid(e.key), t = types.get(e.key) || '', v = e.searchTerm, s = `CAST(${c} AS VARCHAR)`, like = e.caseSensitive ? 'LIKE' : 'ILIKE';
    const num = NUM.test(t) && v !== '' && v != null && !isNaN(+v), cmp = op => num ? `${c} ${op} ${+v}` : `${s} ${op} ${str(v)}`;
    const blank = NUM.test(t) || BOOL.test(t) ? `${c} IS NULL` : `(${c} IS NULL OR ${s} = '')`;
    switch (e.condition?.name ?? e.condition) {
      case 'all': return 'TRUE';
      case 'true': return `${c} = TRUE`;
      case 'false': return `${c} = FALSE`;
      case 'empty': return blank;
      case 'notEmpty': return `NOT ${blank}`;
      case 'contains': return `${s} ${like} ${str(`%${v ?? ''}%`)}`;
      case 'doesNotContain': return `(${c} IS NULL OR ${s} NOT ${like} ${str(`%${v ?? ''}%`)})`;
      case 'startsWith': return `${s} ${like} ${str(`${v ?? ''}%`)}`;
      case 'endsWith': return `${s} ${like} ${str(`%${v ?? ''}`)}`;
      case 'equals': return num ? `${c} = ${+v}` : e.caseSensitive ? `${s} = ${str(v)}` : `lower(${s}) = lower(${str(v)})`;
      case 'doesNotEqual': return num ? `${c} <> ${+v}` : e.caseSensitive ? `${s} <> ${str(v)}` : `lower(${s}) <> lower(${str(v)})`;
      case 'greaterThan': return cmp('>');
      case 'lessThan': return cmp('<');
      case 'greaterThanOrEqual': return cmp('>=');
      case 'lessThanOrEqual': return cmp('<=');
      default: return 'TRUE';
    }
  }
  // Grid state -> WHERE / ORDER BY. state = { sort: { key, dir }, filters: Map(key -> { condition, searchTerm }), quick }.
  function whereOf(s, o, types) {
    const parts = o.where ? [`(${o.where})`] : [];
    for (const [key, f] of s.filters || []) parts.push(`(${term({ key, ...f }, types)})`);
    const q = String(s.quick ?? '').trim();
    if (q) parts.push(`(${o.cols.map(c => `CAST(${qid(c)} AS VARCHAR) ILIKE ${str(`%${q}%`)}`).join(' OR ')})`);
    return parts.join(' AND ');
  }
  const orderOf = s => s.sort ? ` ORDER BY ${qid(s.sort.key)}${s.sort.dir === 'desc' ? ' DESC' : ''} NULLS LAST` : '';

  // grid = DNGrid (widgets/data-grid/grid.js): it asks grid.provider for the first rows and for more near the end.
  function attach(g, o) {
    const types = new Map((o.columns || []).map(c => [c.name, c.type])), from = qid(o.dataset), select = o.cols.map(qid).join(', ');
    // Times of the last request (wall clock incl. HTTP, and the engine's own ms; page + count run side by side).
    const stat = { wall: 0, engine: 0 };
    const run = async sql => { const r = await Engine.call('query', { sql, views: o.views() }); stat.engine = Math.max(stat.engine, +r.ms || 0); return ApexWidget.objects(r); };
    const timed = async fn => { const t0 = performance.now(); stat.engine = 0; const v = await fn(); stat.wall = performance.now() - t0; return v; };
    const page = (where, order, offset, n) => run(`SELECT ${select} FROM ${from}${where ? ` WHERE ${where}` : ''}${order} LIMIT ${n} OFFSET ${offset}`);
    const count = async where => +Object.values((await run(`SELECT count(*) AS n FROM ${from}${where ? ` WHERE ${where}` : ''}`))[0] || {})[0] || 0;
    let total = 0;
    g.provider = {
      async load(s) {
        const where = whereOf(s, o, types), order = orderOf(s);
        const [rows, n] = await timed(() => Promise.all([page(where, order, 0, PAGE), count(where)]));
        total = n; o.onCount?.(n, rows.length, stat);
        return { rows, total: n, done: rows.length < PAGE };
      },
      async more(s, at) {
        const rows = await timed(() => page(whereOf(s, o, types), orderOf(s), at, MORE));
        o.onCount?.(total, at + rows.length, stat);
        return { rows, done: rows.length < MORE };
      },
    };
  }
  return { attach, PAGE };
})();
