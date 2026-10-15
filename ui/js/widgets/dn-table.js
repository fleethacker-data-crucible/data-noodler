// DNTable: the Table widgets' runtime (the app's own Data Grid, ui/js/grid/data-grid.js, in a dashboard container).
// Global: DNTable. A Table package's code.js is one call:
//   export default (data, ctx) => DNTable.render(data, ctx);
// Columns: the fields on the Column / Group By / Value slots (in slot order), named after the field. The grid sorts
// (click a header), filters (its funnel button or right-click), resizes (drag a header edge) and searches (contains).
// Click to filter (dn.filter): a row click fires 'dn-filter' on the clicked column's value; linked containers follow.
// Engine paging: a table of plain columns (no Value slots) with ctx.source { dataset, where } (the dashboard) reads its
// rows from the engine 1,000 at a time as the reader scrolls (GridRemote; search, filters and sort run in SQL).
// Settings: dn.search, dn.export, dn.sort, dn.colFilter, dn.resize, dn.filter, dn.rowHeight, dn.fontSize, dn.stripes, dn.fmtNum.
const DNTable = (() => {
  const PAGE = 1000;   // engine-paged tables: rows per request
  let cssReady = null;
  // The Data Grid's look (ui/js/grid/data-grid.css) once per page, for every table box (.dn-table).
  function css() {
    return cssReady ||= fetch('/ui/js/grid/data-grid.css').then(r => r.text()).then(t => {
      if (!document.getElementById('dn-grid-style'))
        document.head.append(Object.assign(document.createElement('style'), { id: 'dn-grid-style', textContent: t.replace(/\.GRID\b/g, '.dn-table') + EXTRA }));
    }).catch(e => { cssReady = null; throw e; });
  }
  const EXTRA = '.dn-table{width:100%;height:100%;box-sizing:border-box;display:flex;flex-direction:column}.dn-table>.dn-grid-box{flex:1;min-height:0}'
    + '.dn-table.stripes .dg-t tbody tr:nth-child(even) td{background:color-mix(in srgb,var(--panel-2) 55%,transparent)}';
  const styleText = () => document.getElementById('dn-grid-style')?.textContent || '';

  async function render(data, ctx = {}) {
    if (typeof DNGrid === 'undefined') throw new Error('The Data Grid is not loaded (ui/js/grid/data-grid.js).');
    await css();
    const S = ctx.settings?.dn || {}, host = ctx.container;
    // Columns in slot order, named after their field (a field used twice gets "(2)").
    const used = new Map(), cols = [];
    for (const i of ctx.inputs || []) {
      if (!(data || []).some(r => i.key in r)) continue;
      let n = ctx.links?.[i.key]?.col || i.label || i.key; const k = used.get(n) || 0; used.set(n, k + 1); if (k) n = `${n} (${k + 1})`;
      cols.push({ key: i.key, name: n });
    }
    const f = S.fmtNum && S.fmtNum !== 'Auto' && typeof BBChart !== 'undefined' ? BBChart.fmt(S.fmtNum, 'number') : null;
    const fd = typeof BBChart !== 'undefined' ? BBChart.fmt(S.fmtDate || 'None', 'date') : null;
    const rows = (data || []).map(r => Object.fromEntries(cols.map(c => { let v = r[c.key]; if (v instanceof Date && fd) v = fd(v); else if (typeof v === 'number' && f) v = f(v); return [c.name, v]; })));
    let root = host?.firstElementChild?.classList?.contains('dn-table') ? host.firstElementChild : null;
    if (!root) { root = document.createElement('div'); root.className = 'dn-table'; host?.replaceChildren(root); }
    root.classList.toggle('stripes', !!S.stripes);
    root.style.setProperty('--dg-row-h', `${S.rowHeight || 34}px`);
    root.style.fontSize = '';
    try { root._grid?.destroy(); } catch {}
    const box = document.createElement('div'); box.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column'; root.replaceChildren(box);
    if (!cols.length && !(ctx.source?.dataset && Object.values(ctx.links || {}).some(l => l?.col))) { box.innerHTML = '<div style="margin:auto;color:var(--muted);font-size:13px">Drag fields onto the Column slots (Settings > Data)</div>'; return root; }
    // Numbers stay numbers for sorting unless a format turns them into text.
    // Engine paging (plain columns on a dashboard): the grid asks the engine for 1,000 rows at a time.
    const src = ctx.source, cnames = [...new Set((ctx.inputs || []).map(i => ctx.links?.[i.key]?.col).filter(Boolean))];
    if (src?.dataset && typeof GridRemote !== 'undefined' && !ctx.static && cnames.length && !(ctx.inputs || []).some(i => i.role === 'measure')) {
      const d = src.dataset, byCol = new Map((ctx.inputs || []).filter(i => ctx.links?.[i.key]?.col).map(i => [ctx.links[i.key].col, i.key]).reverse());
      root._grid = DNGrid.create(box, {
        names: cnames, columns: cnames.map(n => ({ name: n, type: (d.columns || []).find(c => c.name === n)?.type || 'VARCHAR' })), rows: [],
        remote: (g, bar) => GridRemote.attach(g, { dataset: d.name, views: () => Engine.views([d]), cols: cnames, columns: d.columns || [], where: src.where || '', page: PAGE, more: PAGE }),
        props: { showQuickFilter: S.search !== false, showExport: S.export !== false, exportFilename: 'table',
          onRowClick: S.filter === false ? null : (row, col) => {
            const key = byCol.get(col); if (!key) return; const v = row[col];
            root.dispatchEvent(new CustomEvent('dn-filter', { bubbles: true, detail: { input: key, values: v == null ? [] : [v], state: { col, v } } }));
          } },
        columnDefaults: { sort: S.sort !== false, filter: S.colFilter !== false, resizable: S.resize !== false },
      });
      const t = box.querySelector('.dg-t'); if (t && S.fontSize) t.style.fontSize = `${S.fontSize}px`;
      return root;
    }
    const types = cols.map(c => ({ name: c.name, type: !f && (data || []).some(r => typeof r[c.key] === 'number') ? 'DOUBLE' : 'VARCHAR' }));
    const back = new Map(cols.map(c => [c.name, c.key]));
    root._grid = DNGrid.create(box, {
      names: cols.map(c => c.name), columns: types, rows,
      props: { showQuickFilter: S.search !== false, showExport: S.export !== false, exportFilename: 'table',
        onRowClick: S.filter === false || ctx.static ? null : (row, col) => {
          const key = back.get(col); if (!key) return;
          const i = rows.indexOf(row), v = i >= 0 ? data[i][key] : row[col];
          root.dispatchEvent(new CustomEvent('dn-filter', { bubbles: true, detail: { input: key, values: v == null ? [] : [v], state: { col, v } } }));
        } },
      columnDefaults: { sort: S.sort !== false, filter: S.colFilter !== false, resizable: S.resize !== false },
    });
    const t = box.querySelector('.dg-t'); if (t && S.fontSize) t.style.fontSize = `${S.fontSize}px`;
    return root;
  }
  return { render, css: styleText };
})();
