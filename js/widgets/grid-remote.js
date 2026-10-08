// Data Grid on the engine: the grid never holds the whole dataset. Its quick search, column filters, sorting and pages are
// turned into one SQL query (WHERE / ORDER BY / LIMIT / OFFSET) that the engine runs on all workers (the dataset's
// in-memory table when the Dashboard loaded one, else its Parquet parts). The first 100 rows load at once; scrolling to
// the bottom loads the next 100. Global: GridRemote.
//   GridRemote.attach(grid, { dataset, views(), cols, columns, where, onCount(total, loaded, stat) }, bar)
//     views() = engine views for the dataset; cols = the picked fields; columns = [{ name, type }] of the dataset;
//     where = SQL from the Dashboard's Filter widgets; bar = the app-styled bar above the grid (input.search + a readout span)
const GridRemote = (() => {
  const PAGE = 100;
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
  // Grid state -> WHERE / ORDER BY. Per column: every "and" expression, plus any one of the "or" expressions.
  function whereOf(g, o, types) {
    const parts = o.where ? [`(${o.where})`] : [], byKey = new Map();
    for (const e of g.filterExpressions || []) { if (!byKey.has(e.key)) byKey.set(e.key, []); byKey.get(e.key).push(e); }
    for (const list of byKey.values()) {
      const ands = list.filter(e => e.criteria !== 'or').map(e => term(e, types)), ors = list.filter(e => e.criteria === 'or').map(e => term(e, types));
      if (ands.length) parts.push(`(${ands.join(' AND ')})`);
      if (ors.length) parts.push(`(${ors.join(' OR ')})`);
    }
    const q = String(g.quickFilter ?? '').trim();
    if (q) parts.push(`(${o.cols.map(c => `CAST(${qid(c)} AS VARCHAR) ILIKE ${str(`%${q}%`)}`).join(' OR ')})`);
    return parts.join(' AND ');
  }
  const orderOf = g => {
    const s = (g.sortExpressions || []).filter(e => e.direction === 'ascending' || e.direction === 'descending');
    return s.length ? ` ORDER BY ${s.map(e => `${qid(e.key)}${e.direction === 'descending' ? ' DESC NULLS LAST' : ''}`).join(', ')}` : '';
  };

  function attach(g, o, bar) {
    const types = new Map((o.columns || []).map(c => [c.name, c.type])), from = qid(o.dataset), select = o.cols.map(qid).join(', ');
    const paged = () => !!g.pagination?.enabled;
    let cache = { key: null, rows: [], total: 0, done: false }, seq = 0, loading = false;
    // Times of the last request (wall clock incl. HTTP, and the engine's own ms; page + count run side by side).
    const stat = { wall: 0, engine: 0 };
    const run = async sql => { const r = await Engine.call('query', { sql, views: o.views() }); stat.engine = Math.max(stat.engine, +r.ms || 0); return ApexWidget.objects(r); };
    const timed = async fn => { const t0 = performance.now(); stat.engine = 0; const v = await fn(); stat.wall = performance.now() - t0; return v; };
    const page = (where, order, offset, n) => run(`SELECT ${select} FROM ${from}${where ? ` WHERE ${where}` : ''}${order} LIMIT ${n} OFFSET ${offset}`);
    const count = async where => +Object.values((await run(`SELECT count(*) AS n FROM ${from}${where ? ` WHERE ${where}` : ''}`))[0] || {})[0] || 0;
    // The grid calls this whenever its search / filters / sort / page change: answer from the engine.
    async function rows() {
      const where = whereOf(g, o, types), order = orderOf(g), size = paged() ? +g.pageSize || PAGE : PAGE, at = paged() ? (+g.page || 0) * size : 0;
      const key = JSON.stringify([where, order, paged() && [at, size]]);
      if (key === cache.key) return cache.rows.slice();
      const my = ++seq;
      const [list, total] = await timed(() => Promise.all([page(where, order, at, size), count(where)]));
      if (my !== seq) return cache.rows.slice();   // a newer request won
      cache = { key, rows: list, total, done: paged() || list.length < size, where, order };
      if (paged()) g.pagination = { ...g.pagination, mode: 'remote', totalItems: total };
      o.onCount?.(total, list.length, stat);
      return list.slice();
    }
    // Scrolled near the bottom: the next 100 rows (same search / filters / sort).
    async function more() {
      if (loading || cache.done || paged() || cache.key == null) return;
      loading = true;
      try {
        const key = cache.key, list = await timed(() => page(cache.where, cache.order, cache.rows.length, PAGE));
        if (key !== cache.key) return;
        cache.rows.push(...list); cache.done = list.length < PAGE;
        o.onCount?.(cache.total, cache.rows.length, stat);
        // Re-run the pipeline (rows() answers from the cache). A new data set makes the grid jump to the top: keep the
        // reading position by restoring it once the longer list is in.
        const top = g.scrollTop, inner = g.scrollContainer?.scrollTop || 0;
        g.data = [];
        for (let i = 0; i < 40 && (g.dataView?.length || 0) < cache.rows.length; i++) await new Promise(r => setTimeout(r, 25));
        await g.updateComplete;
        const put = () => { g.scrollTop = top; if (g.scrollContainer) g.scrollContainer.scrollTop = inner; };
        put(); requestAnimationFrame(put);
      } finally { loading = false; }
    }
    // Bar: search box -> the grid's quick filter (engine query); "Row n of total" for the row under the mouse.
    const info = bar?.querySelector('span'), input = bar?.querySelector('input.search');
    let hover = null;
    const show = () => { if (info) info.textContent = `${hover != null ? `Row ${(hover + 1).toLocaleString()}` : 'Row -'} of ${cache.total.toLocaleString()} (${cache.rows.length.toLocaleString()} loaded)`; };
    if (input) { let t; input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { g.quickFilter = input.value; }, 300); }); }
    g.addEventListener('mousemove', e => {
      const r = e.composedPath().find(x => x?.getAttribute?.('role') === 'row' && typeof x.index === 'number');
      const i = r ? r.index : null; if (i !== hover) { hover = i; show(); }
    });
    g.addEventListener('mouseleave', () => { hover = null; show(); });
    const count0 = o.onCount; o.onCount = (t, n, s) => { count0?.(t, n, s); show(); };
    g.dataPipelineConfiguration = { quickFilter: ({ data }) => data, filter: ({ data }) => data, sort: () => rows() };
    g.addEventListener('pageChanged', () => { g.data = []; });
    (async () => {
      await g.updateComplete;
      if (cache.key == null) g.data = [];   // first 100 rows once the grid is on the page
      // The grid element itself scrolls (its rows are one tall list inside it).
      const near = sc => sc.scrollHeight > sc.clientHeight && sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 200;
      for (const sc of [g, g.scrollContainer].filter(Boolean)) sc.addEventListener('scroll', () => { if (near(sc)) more(); }, { passive: true });
    })();
    g.data = [];
  }
  return { attach, PAGE };
})();
