// Data Grid on the engine: the grid never holds the whole dataset. Its search box, column filters and sort are turned
// into one SQL query (WHERE / ORDER BY / LIMIT / OFFSET) that the engine runs on all workers (the dataset's rows
// resident in engine memory, else its Arrow parts on disk). The first 100 rows load at once, then 100 more at a time as
// the reader nears the end. Global: GridRemote.
//   GridRemote.attach(grid, { dataset, views(), cols, columns, where, onCount(total, loaded, stat) })
//     views() = engine views for the dataset; cols = the picked fields; columns = [{ name, type }] of the dataset;
//     where = SQL from the Dashboard's Filter widgets.
const GridRemote = (() => {
  const PAGE = 100, MORE = 100;   // first 100 rows, then the next 100 each time the reader nears the end
  const BLOCK = 1000;             // sorted grids: rows fetched per request (each request is a full top-N over the data)
  const NUM = /INT|DOUBLE|FLOAT|DECIMAL|REAL|NUMERIC/i, BOOL = /BOOL/i, DATE = /^(DATE|TIMESTAMP)/i;
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
    if (q) {
      // Only columns whose text could contain q (same rows as searching them all, far less work: numbers / dates /
      // flags are not turned into text for every row when q cannot match them).
      const look = o.cols.filter(c => canHold(types.get(c) || '', q));
      parts.push(look.length ? `(${look.map(c => `CAST(${qid(c)} AS VARCHAR) ILIKE ${str(`%${q}%`)}`).join(' OR ')})` : 'FALSE');
    }
    return parts.join(' AND ');
  }
  // Can a value of this type, as text, contain q (case-insensitive)? Numbers print as digits . - + E (and nan / inf),
  // dates / timestamps as digits - : . and space, flags as true / false.
  function canHold(type, q) {
    const t = q.toLowerCase();
    if (BOOL.test(type)) return 'true'.includes(t) || 'false'.includes(t);
    if (NUM.test(type)) return /^[0-9.+\-e]+$/.test(t) || 'nan'.includes(t) || '-inf'.includes(t);
    if (DATE.test(type)) return /^[0-9\-:. ]+$/.test(t);
    return true;
  }
  const orderOf = s => s.sort ? ` ORDER BY ${qid(s.sort.key)}${s.sort.dir === 'desc' ? ' DESC' : ''} NULLS LAST` : '';

  // grid = DNGrid (widgets/data-grid/grid.js): it asks grid.provider for the first rows and for more near the end.
  function attach(g, o) {
    const types = new Map((o.columns || []).map(c => [c.name, c.type])), from = qid(o.dataset), select = o.cols.map(qid).join(', ');
    // Times of the last request (wall clock incl. HTTP, and the engine's own ms; page + count run side by side).
    const stat = { wall: 0, engine: 0 };
    const run = async sql => { const r = await Engine.call('query', { sql, views: o.views() }); stat.engine = Math.max(stat.engine, +r.ms || 0); return r.rows.map(row => Object.fromEntries(r.cols.map((c, k) => [typeof c === 'string' ? c : c.name, row[k]]))); };
    const timed = async fn => { const t0 = performance.now(); stat.engine = 0; const v = await fn(); stat.wall = performance.now() - t0; return v; };
    const page = (where, order, offset, n) => run(`SELECT ${select} FROM ${from}${where ? ` WHERE ${where}` : ''}${order} LIMIT ${n} OFFSET ${offset}`);
    const count = async where => +Object.values((await run(`SELECT count(*) AS n FROM ${from}${where ? ` WHERE ${where}` : ''}`))[0] || {})[0] || 0;
    let total = 0;
    // Sorted: rows come BLOCK at a time into buf (rows buf.at .. buf.at + buf.rows.length of this query) and the grid's
    // pages are served from it, so scrolling a sorted grid runs one sort per 1,000 rows instead of one per 100.
    let buf = null;   // { key, at, rows, end } end = the query has no rows after these
    const fetch = async (where, order, key, at, n) => {
      if (!order) { const rows = await page(where, order, at, n); return { rows, done: rows.length < n }; }
      if (!buf || buf.key !== key || at < buf.at || at >= buf.at + buf.rows.length) {
        if (buf && buf.key === key && buf.end && at >= buf.at + buf.rows.length) return { rows: [], done: true };
        const rows = await page(where, order, at, BLOCK);
        buf = { key, at, rows, end: rows.length < BLOCK };
      }
      const from = at - buf.at, rows = buf.rows.slice(from, from + n);
      return { rows, done: buf.end && from + n >= buf.rows.length };
    };
    g.provider = {
      async load(s) {
        const where = whereOf(s, o, types), order = orderOf(s), key = where + order;
        buf = null;
        const [r, n] = await timed(() => Promise.all([fetch(where, order, key, 0, PAGE), count(where)]));
        total = n; o.onCount?.(n, r.rows.length, stat);
        return { rows: r.rows, total: n, done: r.done };
      },
      async more(s, at) {
        const where = whereOf(s, o, types), order = orderOf(s);
        const r = await timed(() => fetch(where, order, where + order, at, MORE));
        o.onCount?.(total, at + r.rows.length, stat);
        return r;
      },
    };
  }
  return { attach, PAGE };
})();
