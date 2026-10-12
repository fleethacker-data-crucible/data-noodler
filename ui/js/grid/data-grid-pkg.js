// The Data Grid as a built-in package (kind 'apexgrid'): the app's table for Import / Transform previews, the Dashboard's
// drill-down and pop-outs, and Data Grids already on a dashboard. Not a widget: its renderer is ui/js/grid/data-grid.js
// (global DNGrid, loaded on first use by ApexRender) and its only style is ui/js/grid/data-grid.css (.GRID = its box).
// Global: DataGrid.   await DataGrid.pkg() -> manifest (same shape as a chart.json package, with specJson / styleCss)
const DataGrid = (() => {
  const SPEC = { $kind: 'apexgrid', data: [{ key: 'fields', label: 'Fields', role: 'fields' }],
    columnDefaults: { sort: true, filter: true, resizable: true }, showQuickFilter: true, showExport: true, exportFilename: 'data' };
  const OPT = (path, label, group, type, def) => ({ path, label, group, type, default: def, show: true });
  let css = null;
  async function pkg() {
    if (css === null) css = await fetch('/ui/js/grid/data-grid.css', { cache: 'no-store' }).then(r => r.ok ? r.text() : '').catch(() => '');
    return {
      id: 'data-grid', name: 'Data Grid', category: 'Tables', description: 'Table of the picked fields: sort, filter, search, resize, export',
      version: 3, kind: 'apexgrid', renderer: '/ui/js/grid/data-grid.js', builtIn: true,
      inputs: SPEC.data.map(i => ({ ...i })),
      options: [OPT('columnDefaults.sort', 'Sortable columns', 'Columns', 'boolean', true), OPT('columnDefaults.filter', 'Column filters', 'Columns', 'boolean', true),
        OPT('columnDefaults.resizable', 'Resizable columns', 'Columns', 'boolean', true), OPT('showQuickFilter', 'Search box', 'Toolbar', 'boolean', true),
        OPT('showExport', 'Export button', 'Toolbar', 'boolean', true), OPT('exportFilename', 'Export file name', 'Toolbar', 'text', 'data')],
      specJson: JSON.parse(JSON.stringify(SPEC)), styleCss: css,
    };
  }
  return { pkg };
})();
