// The three files of a new Custom Widget (Dashboard Studio > Custom > New > Edit Widget). Global: WidgetStarter.
// A small working billboard.js chart (a column chart) to start from or replace.
const WidgetStarter = (() => {
  const code = `// A widget: one function that returns its element. Charts are billboard.js, drawn by BBChart (ui/js/widgets/bb-chart.js):
//   data  rows keyed by the input keys in settings.json, e.g. { x: 'East', y: 1250 }
//   ctx   { width, height, settings, inputs, container, links, filter }
// spec: family = how the rows become chart data ('xy', 'arc', 'tuple', 'xyNum'), type = the billboard chart type,
//       options = more billboard options (https://naver.github.io/billboard.js/release/latest/doc/Options.html).
// Settings "bb.<option path>" are billboard options as they are; a click on a bar filters the linked widgets.
export default function widget(data, ctx) {
  return BBChart.render(data, ctx, {
    family: 'xy',
    type: 'bar',
    options: { bar: { width: { ratio: 0.6 } } },
  });
}
`;

  const css = `/* The widget's own style. .WIDGET = its container (scoped to this widget automatically).
   The chart's look comes from its billboard theme (Settings > Theme); add to it here, e.g.:
   .WIDGET .bb-bar { stroke: var(--panel); stroke-width: 1px; } */
`;

  const settings = JSON.stringify({
    name: '',
    chart: 'bar',
    filter: true,
    inputs: [
      { key: 'x', label: 'X Axis', role: 'dimension', axis: 'x' },
      { key: 'y', label: 'Y Axis', role: 'measure', axis: 'y', agg: 'sum', repeat: 'Series' },
      { key: 'split', label: 'Split By', role: 'dimension', optional: true },
    ],
    settings: [
      { path: 'bb.axis.rotated', label: 'Horizontal', group: 'Axis', type: 'boolean', default: false },
      { path: 'bb.grid.y.show', label: 'Y Grid Lines', group: 'Grid', type: 'boolean', default: true },
      { path: 'bb.legend.show', label: 'Show Legend', group: 'Legend', type: 'boolean', default: true },
      { path: 'dn.palette', label: 'Palette', group: 'Colors', type: 'pick', choices: ['Theme', 'Data Noodler', 'Tableau 10', 'Category 10'], default: 'Theme' },
      { path: 'dn.theme', label: 'Theme', group: 'Colors', type: 'pick', choices: ['Data Noodler', 'Billboard', 'Dark', 'Datalab', 'Graph', 'Insight', 'Modern'], default: 'Data Noodler' },
    ],
    values: {},
  }, null, 2) + '\n';

  return { files: () => ({ code, css, settings }) };
})();
