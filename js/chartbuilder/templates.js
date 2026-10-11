// Chart Builder templates (html/chart-builder.html). Each one is a ready chart: its data slots (inputs), its settings
// (options) and its D3 code. The code is ordinary D3 Studio chart code (js/charts/d3-render.js says what it gets:
// data, X / Y accessors, W, H, colors, opts, theme), so a chart made here draws on the Dashboard like any other and
// can be opened as code and changed by hand. Global: ChartTemplates.
const ChartTemplates = (() => {
  const GRID = [
    { path: 'grid.y', label: 'Horizontal grid lines', group: 'Grid', type: 'boolean', default: true, show: true },
    { path: 'grid.x', label: 'Vertical grid lines', group: 'Grid', type: 'boolean', default: false, show: true },
  ];
  const LABELS = { path: 'labels', label: 'Value labels', group: 'Labels', type: 'boolean', default: false, show: true };
  const LEGEND = { path: 'legend', label: 'Legend', group: 'Labels', type: 'boolean', default: true, show: true };
  const X = (label = 'X Axis') => ({ key: 'x', label, role: 'dimension', axis: 'x' });
  const Y = (label = 'Y Axis', agg = 'sum') => ({ key: 'y', label, role: 'measure', axis: 'y', agg });
  const SAMPLE = [{ x: 'North', y: 42 }, { x: 'South', y: 28 }, { x: 'East', y: 35 }, { x: 'West', y: 51 }, { x: 'Central', y: 19 }];
  const TIME = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'].map((m, i) => ({ x: new Date(m + '-01'), y: [12, 19, 15, 24, 22, 31, 28, 36][i] }));
  const POINTS = Array.from({ length: 40 }, (_, i) => ({ x: (i * 37) % 100, y: ((i * 53) % 90) + (i % 7) * 2 }));

  // Shared head of the axis charts: margins, the Y scale (left margin fits its labels), the svg, grid lines and axes.
  const axisHead = (xScale, xAxis, yDomain = '[0, d3.max(data, Y) || 1]') => `const margin = { top: 16, right: 16, bottom: 32, left: 48 };
const y = d3.scaleLinear().domain(${yDomain}).nice().range([H - margin.bottom, margin.top]);
margin.left = 14 + 7 * d3.max(y.ticks(5).map(y.tickFormat(5)), s => s.length);
const x = ${xScale};
const svg = d3.create('svg').attr('viewBox', [0, 0, W, H]);

// Grid lines (Settings)
const grid = g => g.call(g => g.select('.domain').remove()).selectAll('line').attr('stroke', theme.border).attr('stroke-dasharray', '2,3');
if (opts.grid?.y) svg.append('g').attr('transform', \`translate(\${margin.left},0)\`)
  .call(d3.axisLeft(y).ticks(5).tickSize(-(W - margin.left - margin.right)).tickFormat('')).call(grid);
if (opts.grid?.x) svg.append('g').attr('transform', \`translate(0,\${H - margin.bottom})\`)
  .call(${xAxis}.tickSize(-(H - margin.top - margin.bottom)).tickFormat('')).call(grid);

// Axes
svg.append('g').attr('transform', \`translate(0,\${H - margin.bottom})\`).call(${xAxis}.tickSizeOuter(0));
svg.append('g').attr('transform', \`translate(\${margin.left},0)\`).call(d3.axisLeft(y).ticks(5)).call(g => g.select('.domain').remove());
`;
  // X scale for line / area: dates -> time scale, numbers -> linear, text -> points.
  const lineX = `data[0] && X(data[0]) instanceof Date ? d3.scaleUtc().domain(d3.extent(data, X)).range([margin.left, W - margin.right])
  : typeof X(data[0] || {}) === 'number' ? d3.scaleLinear().domain(d3.extent(data, X)).range([margin.left, W - margin.right])
  : d3.scalePoint().domain(data.map(X)).range([margin.left, W - margin.right]).padding(0.5)`;
  const lineAxis = `d3.axisBottom(x).ticks(Math.max(2, Math.floor(W / 90)))`;

  const T = [
    { id: 'bar', label: 'Column', icon: '<rect x="3" y="11" width="4" height="10"/><rect x="10" y="5" width="4" height="16"/><rect x="17" y="8" width="4" height="13"/>',
      inputs: [X('Category'), Y('Value')], options: [...GRID, LABELS], sample: SAMPLE,
      code: `// Column chart: one bar per category, height = value.
${axisHead(`d3.scaleBand().domain(data.map(X)).range([margin.left, W - margin.right]).padding(0.2)`, 'd3.axisBottom(x)')}
// Bars
svg.append('g').attr('fill', colors[0]).selectAll('rect').data(data).join('rect')
  .attr('x', d => x(X(d))).attr('y', d => y(Y(d))).attr('width', x.bandwidth()).attr('height', d => y(0) - y(Y(d)));
// Value labels (Settings)
if (opts.labels) svg.append('g').attr('fill', theme.text2).attr('font-size', 11).attr('text-anchor', 'middle')
  .selectAll('text').data(data).join('text').attr('x', d => x(X(d)) + x.bandwidth() / 2).attr('y', d => y(Y(d)) - 4).text(d => d3.format('~s')(Y(d)));
return svg.node();
` },
    { id: 'hbar', label: 'Bar', icon: '<rect x="3" y="3" width="12" height="4"/><rect x="3" y="10" width="18" height="4"/><rect x="3" y="17" width="9" height="4"/>',
      inputs: [X('Category'), Y('Value')], options: [{ ...GRID[1], label: 'Vertical grid lines', default: true }, LABELS], sample: SAMPLE,
      code: `// Bar chart: one horizontal bar per category, length = value.
const margin = { top: 12, right: 24, bottom: 28, left: 16 };
margin.left = 16 + 7 * d3.max(data, d => String(X(d)).length) || 40;
const x = d3.scaleLinear().domain([0, d3.max(data, Y) || 1]).nice().range([margin.left, W - margin.right]);
const y = d3.scaleBand().domain(data.map(X)).range([margin.top, H - margin.bottom]).padding(0.2);
const svg = d3.create('svg').attr('viewBox', [0, 0, W, H]);
if (opts.grid?.x) svg.append('g').attr('transform', \`translate(0,\${H - margin.bottom})\`)
  .call(d3.axisBottom(x).ticks(5).tickSize(-(H - margin.top - margin.bottom)).tickFormat(''))
  .call(g => g.select('.domain').remove()).selectAll('line').attr('stroke', theme.border).attr('stroke-dasharray', '2,3');
svg.append('g').attr('transform', \`translate(0,\${H - margin.bottom})\`).call(d3.axisBottom(x).ticks(5)).call(g => g.select('.domain').remove());
svg.append('g').attr('transform', \`translate(\${margin.left},0)\`).call(d3.axisLeft(y).tickSizeOuter(0));
// Bars
svg.append('g').attr('fill', colors[0]).selectAll('rect').data(data).join('rect')
  .attr('x', x(0)).attr('y', d => y(X(d))).attr('width', d => x(Y(d)) - x(0)).attr('height', y.bandwidth());
// Value labels (Settings)
if (opts.labels) svg.append('g').attr('fill', theme.text2).attr('font-size', 11).attr('dominant-baseline', 'middle')
  .selectAll('text').data(data).join('text').attr('x', d => x(Y(d)) + 4).attr('y', d => y(X(d)) + y.bandwidth() / 2).text(d => d3.format('~s')(Y(d)));
return svg.node();
` },
    { id: 'line', label: 'Line', icon: '<polyline points="3,18 8,11 13,14 21,5" fill="none" stroke="currentColor" stroke-width="2"/>',
      inputs: [X('X Axis'), Y('Value')], options: [...GRID, { path: 'dots', label: 'Dots', group: 'Line', type: 'boolean', default: true, show: true }], sample: TIME, sort: 'label', top: 1000,
      code: `// Line chart: the values in X order, joined by a line.
${axisHead(lineX, lineAxis)}
// Line
svg.append('path').datum(data).attr('fill', 'none').attr('stroke', colors[0]).attr('stroke-width', 2)
  .attr('d', d3.line().x(d => x(X(d))).y(d => y(Y(d))));
// Dots (Settings)
if (opts.dots) svg.append('g').attr('fill', colors[0]).selectAll('circle').data(data).join('circle')
  .attr('cx', d => x(X(d))).attr('cy', d => y(Y(d))).attr('r', 3);
return svg.node();
` },
    { id: 'area', label: 'Area', icon: '<path d="M3 20 L3 14 L8 9 L13 12 L21 5 L21 20 Z"/>',
      inputs: [X('X Axis'), Y('Value')], options: [...GRID], sample: TIME, sort: 'label', top: 1000,
      code: `// Area chart: a line with the space under it filled.
${axisHead(lineX, lineAxis)}
// Area and its top line
svg.append('path').datum(data).attr('fill', colors[0]).attr('fill-opacity', 0.25)
  .attr('d', d3.area().x(d => x(X(d))).y0(y(0)).y1(d => y(Y(d))));
svg.append('path').datum(data).attr('fill', 'none').attr('stroke', colors[0]).attr('stroke-width', 2)
  .attr('d', d3.line().x(d => x(X(d))).y(d => y(Y(d))));
return svg.node();
` },
    { id: 'scatter', label: 'Scatter', icon: '<circle cx="6" cy="16" r="2"/><circle cx="10" cy="9" r="2"/><circle cx="15" cy="13" r="2"/><circle cx="19" cy="6" r="2"/>',
      inputs: [{ key: 'x', label: 'X Axis', role: 'measure', axis: 'x', agg: 'none' }, Y('Y Axis', 'none')], options: [...GRID], sample: POINTS,
      code: `// Scatter plot: one dot per row at (X, Y).
${axisHead('d3.scaleLinear().domain(d3.extent(data, X)).nice().range([margin.left, W - margin.right])', 'd3.axisBottom(x).ticks(Math.max(2, Math.floor(W / 90)))', 'd3.extent(data, Y)')}
// Dots
svg.append('g').attr('fill', colors[0]).attr('fill-opacity', 0.7).selectAll('circle').data(data).join('circle')
  .attr('cx', d => x(X(d))).attr('cy', d => y(Y(d))).attr('r', 3.5);
return svg.node();
` },
    { id: 'pie', label: 'Pie', icon: '<path d="M12 3 A9 9 0 1 1 3 12 L12 12 Z"/><path d="M12 3 L12 12 L3 12 A9 9 0 0 1 12 3" opacity=".5"/>',
      inputs: [X('Slices'), Y('Value')], options: [LEGEND, LABELS], sample: SAMPLE,
      code: pieCode(0) },
    { id: 'donut', label: 'Donut', icon: '<path d="M12 3 A9 9 0 1 1 3 12 L7 12 A5 5 0 1 0 12 7 Z"/><path d="M12 3 L12 7 A5 5 0 0 0 7 12 L3 12 A9 9 0 0 1 12 3" opacity=".5"/>',
      inputs: [X('Slices'), Y('Value')], options: [LEGEND, LABELS], sample: SAMPLE,
      code: pieCode(0.6) },
  ];
  function pieCode(hole) {
    return `// ${hole ? 'Donut' : 'Pie'} chart: one slice per category, size = value.
const legendW = opts.legend ? Math.min(160, W * 0.35) : 0;
const r = Math.max(10, Math.min(W - legendW, H) / 2 - 8), cx = (W - legendW) / 2, cy = H / 2;
const pie = d3.pie().value(Y).sort(null)(data);
const arc = d3.arc().innerRadius(r * ${hole}).outerRadius(r);
const svg = d3.create('svg').attr('viewBox', [0, 0, W, H]);
const g = svg.append('g').attr('transform', \`translate(\${cx},\${cy})\`);
g.selectAll('path').data(pie).join('path').attr('fill', (d, i) => colors[i % colors.length])
  .attr('stroke', theme.bg || 'none').attr('stroke-width', 1).attr('d', arc);
// Value labels (Settings)
if (opts.labels) g.selectAll('text').data(pie).join('text').attr('transform', d => \`translate(\${d3.arc().innerRadius(r * ${hole ? 0.8 : 0.6}).outerRadius(r * ${hole ? 0.8 : 0.6}).centroid(d)})\`)
  .attr('text-anchor', 'middle').attr('font-size', 11).attr('fill', theme.text).text(d => d3.format('~s')(Y(d.data)));
// Legend (Settings)
if (opts.legend) {
  const lg = svg.append('g').attr('transform', \`translate(\${W - legendW + 8},\${Math.max(8, cy - data.length * 10)})\`).attr('font-size', 12).attr('fill', theme.text2);
  const row = lg.selectAll('g').data(data).join('g').attr('transform', (d, i) => \`translate(0,\${i * 20})\`);
  row.append('rect').attr('class', 'square').attr('width', 10).attr('height', 10).attr('rx', 2).attr('fill', (d, i) => colors[i % colors.length]);
  row.append('text').attr('x', 16).attr('y', 9).text(X);
}
return svg.node();
`;
  }
  const get = id => T.find(t => t.id === id);
  return { list: T, get };
})();
