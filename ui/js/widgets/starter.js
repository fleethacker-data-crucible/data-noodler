// The three files of a new Custom Widget (Dashboard Studio > Custom Widget > Edit Widget). Global: WidgetStarter.
// A small working column chart, written the D3 way, to start from or replace.
const WidgetStarter = (() => {
  const code = `// A widget: one function that builds its own element with D3 and returns it.
//   data      rows keyed by the input keys in d3-settings.json, e.g. { x: 'East', y: 1250 }
//   width     the container's width in px, height its height
//   settings  the values from the Settings window (d3-settings.json), e.g. settings.colors[0]
// Select only inside the root you build (never d3.select('body')). Buttons / filters fire CustomEvents from the root.
// Frame colours (axes, grid, text) are set in d3-style.css (app theme); data colours come from settings.
export default function widget(data, { width, height, settings }) {
  const margin = { top: 16, right: 16, bottom: 32, left: 48 };
  const root = d3.create('div').attr('class', 'root');
  const svg = root.append('svg').attr('viewBox', [0, 0, width, height]);

  if (!data.length) {
    svg.append('text').attr('class', 'empty').attr('x', width / 2).attr('y', height / 2).attr('text-anchor', 'middle')
      .text('Drag a field onto X and Y (Data)');
    return root.node();
  }

  const x = d3.scaleBand().domain(data.map(d => d.x)).range([margin.left, width - margin.right]).padding(0.2);
  const y = d3.scaleLinear().domain([0, d3.max(data, d => d.y) || 1]).nice().range([height - margin.bottom, margin.top]);

  if (settings.grid) svg.append('g').attr('class', 'grid').attr('transform', \`translate(\${margin.left},0)\`)
    .call(d3.axisLeft(y).tickSize(-(width - margin.left - margin.right)).tickFormat(''));

  svg.append('g').attr('class', 'bars').selectAll('rect').data(data).join('rect')
    .attr('x', d => x(d.x)).attr('width', x.bandwidth())
    .attr('y', d => y(Math.max(0, d.y))).attr('height', d => Math.abs(y(d.y) - y(0)))
    .attr('rx', 3).attr('fill', settings.colors?.[0] || '#4e79a7');

  svg.append('g').attr('class', 'axis').attr('transform', \`translate(0,\${height - margin.bottom})\`).call(d3.axisBottom(x));
  svg.append('g').attr('class', 'axis').attr('transform', \`translate(\${margin.left},0)\`).call(d3.axisLeft(y).ticks(5, 's'));
  svg.selectAll('.axis text').style('font-size', \`\${settings.fontSize}px\`);

  return root.node();
}
`;

  const css = `/* The widget's only style. .WIDGET = its container (scoped to this widget automatically).
   Frame colours follow the app theme (light / dark); data colours come from the widget's settings. */
.WIDGET {
  --frame-text: var(--text-2, #555);
  --frame-muted: var(--muted, #888);
  --frame-line: var(--border, #ccc);
  font-family: 'Exo 2', system-ui, sans-serif;
  color: var(--frame-text);
}
.WIDGET .root { width: 100%; height: 100%; }
.WIDGET svg { display: block; width: 100%; height: 100%; }
.WIDGET .axis path, .WIDGET .axis line { stroke: var(--frame-line); }
.WIDGET .axis text { fill: var(--frame-text); font-family: inherit; }
.WIDGET .grid line { stroke: var(--frame-line); stroke-opacity: .45; }
.WIDGET .grid path { display: none; }
.WIDGET .empty { fill: var(--frame-muted); font-size: 13px; }
`;

  const settings = JSON.stringify({
    name: '',
    inputs: [
      { key: 'x', label: 'X', role: 'dimension', axis: 'x' },
      { key: 'y', label: 'Y', role: 'measure', axis: 'y', agg: 'sum' },
    ],
    settings: [
      { path: 'colors.0', label: 'Bar Color', group: 'Colors', type: 'color', default: '#4e79a7' },
      { path: 'fontSize', label: 'Font Size', group: 'Settings', type: 'number', default: 12, min: 6, max: 32, step: 1 },
      { path: 'grid', label: 'Grid Lines', group: 'Settings', type: 'boolean', default: true },
    ],
    values: {},
  }, null, 2) + '\n';

  return { files: () => ({ code, css, settings }) };
})();
