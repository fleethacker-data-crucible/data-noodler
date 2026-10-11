// Data preview tables (Import, Transform and its pop-out) drawn as the built-in Data Grid (kind apexgrid, our own renderer).
// Needs dn-fs.js, ui.js, apex-render.js, apex-options.js, apex-widget.js, js/grid/data-grid-pkg.js (the grid itself: js/grid/data-grid.js). Global: PreviewGrid.
//   PreviewGrid.show(el, cols, rows, { total, more })   cols = column names, rows = arrays (an engine result); el gets a .pgrid box
//     more(offset) -> rows (arrays) after the first ones: the grid asks for the next 100 as the reader nears the end;
//     total = all rows of the query (when known).
//   The .pgrid box height comes from CSS (or the page sets it); falls back to UI.dataTable when no grid package exists.
const PreviewGrid = (() => {
  let seq = 0;
  const PAGE = 100;   // rows per block
  async function show(el, cols, rows, { total = null, more = null } = {}) {
    const n = ++seq, m = await DataGrid.pkg().catch(() => null);
    if (n !== seq) return;   // a newer preview started meanwhile
    if (!m) return UI.dataTable(el, cols, rows);
    let box = el.querySelector(':scope > .pgrid');
    if (!box) { el.innerHTML = ''; box = Object.assign(el.ownerDocument.createElement('div'), { className: 'pgrid' }); el.append(box); }
    ApexWidget.dispose(box);
    const w = { id: 'preview', inputs: { fields: { cols: [...cols] } } };
    const next = more && (async at => { const r = await more(at); return { rows: ApexWidget.objects({ cols, rows: r }), done: r.length < PAGE || (total != null && at + r.length >= total) }; });
    await ApexWidget.render(box, m, m.specJson, w, ApexWidget.objects({ cols, rows }), { columns: [], more: next, total });
  }
  // Data for a popped-out grid window (html/grid-pop.html: win.DNGridShow(d)) showing another preview in place.
  async function popData(cols, rows, { total = null, more = null, title = '' } = {}) {
    const m = await DataGrid.pkg();
    const next = more && (async at => { const r = await more(at); return { rows: ApexWidget.objects({ cols, rows: r }), done: r.length < PAGE || (total != null && at + r.length >= total) }; });
    return { s: m.specJson, rows: ApexWidget.objects({ cols, rows }), names: [...cols], columns: [], more: next, total, wid: m.id, title };
  }
  return { show, popData, PAGE };
})();
window.PreviewGrid = PreviewGrid;   // Transform draws through win.PreviewGrid (this window or its pop-out)
