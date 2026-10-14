// Summary Table: the app's Data Grid (ui/js/grid/data-grid.js) through DNTable (ui/js/widgets/dn-table.js). Data: Group By, Value.
// Click a header = sort, its funnel = filter, drag its edge = resize, Search = contains; a row click filters linked widgets.
export default function widget(data, ctx) {
  return DNTable.render(data, ctx);
}
