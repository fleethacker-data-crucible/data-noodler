// Chart Builder templates (ui/html/chart-builder.html). Each one is a ready chart: its data slots (inputs), its settings
// (options) and its D3 code. The code is ordinary D3 Studio chart code (ui/js/charts/d3-render.js says what it gets:
// data, X / Y accessors, W, H, colors, opts, theme), so a chart made here draws on the Dashboard like any other and
// can be opened as code and changed by hand. The code is written the way D3 examples are: one step per line, indented.
// Global: ChartTemplates.
const ChartTemplates = (() => {
  const GRID = [
    { path: 'grid.x', label: 'Grid Lines', sub: 'X-Axis', group: 'X-Axis', type: 'boolean', default: false, show: true, sep: true },
    { path: 'grid.y', label: 'Grid Lines', sub: 'Y-Axis', group: 'X-Axis', type: 'boolean', default: true, show: true, sep: true },
  ];
  const LABELS = { path: 'labels', label: 'Value labels', group: 'Labels', type: 'boolean', default: false, show: true };
  // X-Axis section (Chart Builder / Dashboard Builder: options in group 'X-Axis').
  const XFONT = { path: 'xaxis.fontSize', label: 'Font Size', sub: 'X-Axis', group: 'X-Axis', type: 'number', default: 13, min: 6, max: 32, step: 1, show: true };
  const YFONT = { ...XFONT, path: 'yaxis.fontSize', sub: 'Y-Axis' };
  // Axis side: one of two check boxes in a row (type 'pick'). sep: a line under it in the panel.
  const XPOS = { path: 'xaxis.position', label: 'Position', sub: 'X-Axis', group: 'X-Axis', type: 'pick', choices: ['bottom', 'top'], labels: ['Bottom', 'Top'], default: 'bottom', show: true };
  const YPOS = { path: 'yaxis.position', label: 'Position', sub: 'Y-Axis', group: 'X-Axis', type: 'pick', choices: ['left', 'right'], labels: ['Left', 'Right'], default: 'left', show: true };
  // The axis line itself (the domain line), on / off.
  const XLINE = { path: 'xaxis.line', label: 'Border', sub: 'X-Axis', group: 'X-Axis', type: 'boolean', default: true, show: true };
  const YLINE = { path: 'yaxis.line', label: 'Border', sub: 'Y-Axis', group: 'X-Axis', type: 'boolean', default: false, show: true };
  const BG = { path: 'background', label: 'Background', group: 'X-Axis', type: 'boolean', default: true, show: true };
  const BORDER = { path: 'border', label: 'Border', group: 'X-Axis', type: 'boolean', default: false, show: true };   // a line around the whole chart
  // Data Points (the value on each bar): on / off, inside or outside the bar.
  const DPOINTS = { path: 'labels', label: 'Show', sub: 'Column Values', group: 'X-Axis', type: 'boolean', default: false, show: true };
  const DPOS = { path: 'labelPos', label: 'Position', sub: 'Column Values', group: 'X-Axis', type: 'pick', choices: ['outside', 'inside'], labels: ['Outside', 'Inside'], default: 'outside', show: true };
  const DFONT = { path: 'labelFont', label: 'Font Size', sub: 'Column Values', group: 'X-Axis', type: 'number', default: 13, min: 6, max: 32, step: 1, show: true };
  const DFMT = { path: 'labelFormat', label: 'Format', sub: 'Column Values', group: 'X-Axis', type: 'format', input: 'y', default: '1,234', show: true };   // an example: $1,234.50  12.5%  1.2K
  // Label formats: the panel offers the ones for the data on that input (input: x / y): numbers, dates or text (letter case).
  const XFMT = { path: 'xaxis.format', label: 'Format', sub: 'X-Axis', group: 'X-Axis', type: 'format', input: 'x', default: 'Title Case', show: true };
  const YFMT = { path: 'yaxis.format', label: 'Format', sub: 'Y-Axis', group: 'X-Axis', type: 'format', input: 'y', default: '1,234', show: true };
  const XROT = { path: 'xaxis.rotate', label: 'Text Orientation', sub: 'X-Axis', group: 'X-Axis', type: 'pick', choices: ['auto', '0', '-90', '90', '-45', '45'],
    labels: ['Auto', 'Horizontal', 'Vertical Left', 'Vertical Right', 'Diag. Left', 'Diag. Right'], default: 'auto', show: true };
  const TOPSPACE = { path: 'topSpace', label: 'Top Space', group: 'X-Axis', type: 'number', default: 1, min: 1, max: 10, step: 1, show: true };   // x 10px above the highest value
  const DROT = { ...XROT, path: 'labelRotate', sub: 'Column Values' };   // the same choices, Auto = vertical left when a value is wider than its bar
  // Bar chart (horizontal): X-Axis = the labels down the side (Left / Right), Y-Axis = the values (Bottom / Top),
  // Bar Values instead of Column Values, End Space instead of Top Space.
  const BARV = o => ({ ...o, sub: 'Bar Values' });
  const HBAR_OPTIONS = [{ ...XPOS, choices: ['left', 'right'], labels: ['Left', 'Right'], default: 'left' }, XFONT, XFMT, XROT, XLINE, GRID[0],
    { ...YPOS, choices: ['bottom', 'top'], labels: ['Bottom', 'Top'], default: 'bottom' }, YFONT, YFMT, YLINE, GRID[1], BG, BORDER,
    { ...TOPSPACE, label: 'End Space' }, BARV(DPOINTS), BARV(DPOS), BARV(DFONT), BARV(DFMT), BARV(DROT)];
  // Line chart: the Column chart's axis / chart settings, Line (width, curve, dots), Point Values (above / below).
  const PV = o => ({ ...o, sub: 'Point Values' });
  const LINE_OPTIONS = [XPOS, XFONT, { ...XFMT, default: 'Jan 2026' }, XROT, XLINE, GRID[0], YPOS, YFONT, YFMT, YLINE, GRID[1], BG, BORDER, TOPSPACE,
    { path: 'line.width', label: 'Width', sub: 'Line', group: 'X-Axis', type: 'number', default: 2, min: 1, max: 10, step: 1, show: true, order: 1 },
    { path: 'line.smooth', label: 'Data Smoothness', sub: 'Line', group: 'X-Axis', type: 'number', default: 0, min: 0, max: 100, step: 5, show: true },
    { path: 'line.smoothTo', label: 'Data Smoothness Target', sub: 'Line', group: 'X-Axis', type: 'pick', choices: ['mean', 'median'], labels: ['Average (Mean)', 'Median'], default: 'mean', show: true },
    { path: 'line.curve', label: 'Curve', sub: 'Line', group: 'X-Axis', type: 'pick', choices: ['linear', 'smooth', 'step'], labels: ['Straight', 'Smooth', 'Steps'], default: 'linear', show: true, order: 2 },
    { path: 'line.smoothAmount', label: 'Smooth Amount', sub: 'Line', group: 'X-Axis', type: 'number', default: 50, min: 0, max: 100, step: 5, show: true, order: 3 },   // Curve: Smooth only
    { path: 'dotShape', label: 'Dot Shape', sub: 'Line', group: 'X-Axis', type: 'pick', choices: ['none', 'circle', 'square', 'diamond', 'triangle-up', 'triangle-down', 'cross', 'x', 'star', 'wye'],
      labels: ['None', 'Circle', 'Square', 'Diamond', 'Triangle Up', 'Triangle Down', 'Cross', 'X', 'Star', 'Y'], default: 'circle', show: true },
    { path: 'dotFill', label: 'Dot Fill', sub: 'Line', group: 'X-Axis', type: 'boolean', default: true, show: true },
    { path: 'dotWidth', label: 'Dot Thickness', sub: 'Line', group: 'X-Axis', type: 'number', default: 1, min: 1, max: 8, step: 1, show: true },
    { path: 'dotSize', label: 'Dot Size', sub: 'Line', group: 'X-Axis', type: 'number', default: 3, min: 1, max: 12, step: 1, show: true },
    PV({ path: 'labelShare', label: 'Density', group: 'X-Axis', type: 'pick', choices: Array.from({ length: 20 }, (_, i) => String((i + 1) * 5)), labels: Array.from({ length: 20 }, (_, i) => (i + 1) * 5 + '%'), default: '100', show: true }),
    PV(DPOINTS), PV({ ...DPOS, choices: ['above', 'below'], labels: ['Above', 'Below'], default: 'above' }), PV(DFONT), PV(DFMT), PV(DROT)];
  // Line sample sets (Edit Data > Sample data): months with a trend and ups and downs, from 6 points of tens to 60 of billions.
  const months = (n, lo, hi, seed) => Array.from({ length: n }, (_, i) => ({ x: new Date(Date.UTC(2025, i, 1)),
    y: Math.round((lo + (hi - lo) * 0.7 * (i / (n - 1)) + (hi - lo) * 0.3 * (0.5 + 0.5 * Math.sin(i * 1.3 + seed))) * 100) / 100 }));
  const LINE_SAMPLES = [
    { label: 'Small: 6 months (tens)', rows: months(6, 12, 48, 1) },
    { label: 'Medium: 12 months (hundreds)', rows: months(12, 120.5, 980.25, 2) },
    { label: 'Large: 24 months (thousands)', rows: months(24, 1234.56, 98765.4, 3) },
    { label: 'Very large: 36 months (millions)', rows: months(36, 150000.5, 9875000.75, 4) },
    { label: 'Huge: 60 months (billions)', rows: months(60, 25000000, 8750000000, 5) },
  ];
  const LEGEND = { path: 'legend', label: 'Legend', group: 'Labels', type: 'boolean', default: true, show: true };
  const X = (label = 'X') => ({ key: 'x', label, role: 'dimension', axis: 'x' });
  const Y = (label = 'Y', agg = 'sum') => ({ key: 'y', label, role: 'measure', axis: 'y', agg });
  const SAMPLE = [{ x: 'North', y: 42 }, { x: 'South', y: 28 }, { x: 'East', y: 35 }, { x: 'West', y: 51 }, { x: 'Central', y: 19 }];
  // Column sample: values with decimals and a wide range, so every number format (Column Values > Format) shows.
  // Column sample sets (Edit Data > Sample data): from 5 small bars up to 20 bars of very large numbers.
  const NAMES = ['North', 'South', 'East', 'West', 'Central', 'Online', 'Retail', 'Wholesale', 'Export', 'Partners', 'Direct', 'Mobile',
    'Enterprise', 'Government', 'Education', 'Healthcare', 'Finance', 'Travel', 'Media', 'Energy'];
  const spread = (n, lo, hi) => NAMES.slice(0, n).map((x, i) => ({ x, y: Math.round(lo * Math.pow(hi / lo, ((i * 7) % n) / (n - 1)) * 100) / 100 }));
  const SAMPLES = [
    { label: 'Small: 5 bars (tens)', rows: SAMPLE },
    { label: 'Medium: 8 bars (hundreds)', rows: spread(8, 120.5, 980.25) },
    { label: 'Large: 12 bars (thousands)', rows: spread(12, 1234.56, 98765.4) },
    { label: 'Very large: 16 bars (millions)', rows: spread(16, 150000.5, 9875000.75) },
    { label: 'Huge: 20 bars (billions)', rows: spread(20, 25000000, 8750000000) },
  ];
  const MONEY = [{ x: 'North', y: 1234.56 }, { x: 'South', y: 48250.9 }, { x: 'East', y: 312875.25 }, { x: 'West', y: 1875400.5 }, { x: 'Central', y: 965.4 }, { x: 'Online', y: 2650000 }];
  const TIME = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'].map((m, i) => ({ x: new Date(m + '-01'), y: [12, 19, 15, 24, 22, 31, 28, 36][i] }));
  const POINTS = Array.from({ length: 40 }, (_, i) => ({ x: (i * 37) % 100, y: ((i * 53) % 90) + (i % 7) * 2 }));

  // Number / date / text formats (Format settings): formatLike(example) -> a function, shared by the axis charts.
  const formatsCode = `// Formats (Chart > X-Axis / Y-Axis / Column Values > Format): picked from a list of examples; the one picked is used for
// every value. None = the value exactly as it is in the data. Auto (numbers) = each value in the unit that fits it
// (950, 1.2K, 3.4M, 2.1B). A typed number example: the text before / after the number is kept, a comma = thousands
// separator, the decimals = how many, K / M / B = every value in thousands / millions / billions, % = the values are
// already percents, (1,234) = negatives in brackets, +1,234 = always a sign, 1.2e+3 = scientific.
const DATES = { '2026-01-31': '%Y-%m-%d', '01/31/2026': '%m/%d/%Y', '31/01/2026': '%d/%m/%Y', 'Jan 31, 2026': '%b %d, %Y', '31 Jan 2026': '%d %b %Y',
  'Jan 2026': '%b %Y', 'January 2026': '%B %Y', 'Jan': '%b', '2026': '%Y', 'Q1 2026': d => 'Q' + (Math.floor(d.getUTCMonth() / 3) + 1) + ' ' + d.getUTCFullYear() };
const CASES = { 'UPPER CASE': s => s.toUpperCase(), 'lower case': s => s.toLowerCase(),
  'Title Case': s => s.toLowerCase().replace(/(^|[\\s_-])(\\S)/g, (m, a, b) => a + b.toUpperCase()),
  'Sentence case': s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() };
const asIs = v => v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
const formatLike = ex => {
  ex = String(ex ?? '').trim();
  if (!ex) return null;
  if (ex === 'None') return asIs;
  if (ex === 'Auto') {
    const f = d3.format('.1~f');
    return v => {
      if (typeof v !== 'number') return asIs(v);
      const a = Math.abs(v), [n, u] = a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : a >= 1e3 ? [1e3, 'K'] : [1, ''];
      return f(v / n) + u;
    };
  }
  if (CASES[ex]) return v => typeof v === 'string' ? CASES[ex](v) : asIs(v);
  if (DATES[ex]) { const f = typeof DATES[ex] === 'function' ? DATES[ex] : d3.utcFormat(DATES[ex]); return v => v instanceof Date ? f(v) : asIs(v); }
  const num = numberLike(ex); return num && (v => typeof v === 'number' ? num(v) : asIs(v));
};
const numberLike = ex => {
  if (/^\\d(\\.\\d+)?e[+-]?\\d+$/i.test(ex)) { const f = d3.format('.' + ((ex.split('e')[0].split('.')[1] || '').length) + 'e'); return v => f(v); }
  const paren = /^\\(.*\\)$/.test(ex); if (paren) ex = ex.slice(1, -1);
  const plus = ex.startsWith('+'); if (plus) ex = ex.slice(1);
  const m = ex.match(/^([^\\d.]*)(\\d{1,3}(?:,\\d{3})+|\\d+)?(?:\\.(\\d+))?(\\s*(?:[KMB](?![a-z])|%)?)(.*)$/i);
  if (!m) return null;
  const [, pre, int = '', dec = '', unit, post] = m, n = { K: 1e3, M: 1e6, B: 1e9 }[unit.trim().toUpperCase()] || 1;
  const f = d3.format((int.includes(',') ? ',' : '') + '.' + dec.length + 'f');
  return v => {
    const s = pre + f(Math.abs(v) / n) + unit + post;
    return v < 0 ? (paren ? '(' + s + ')' : '-' + s) : (plus && v > 0 ? '+' : '') + s;
  };
};`;

  // Shared head of the axis charts: margins, the Y scale (the left margin fits its labels), the X scale, the svg, the
  // grid lines (Settings) and both axes. xScale / xAxis are code (already indented).
  const axisHead = (xScale, xAxis, yDomain = '[0, d3.max(data, Y) || 1]') => `// Size and margins
const margin = { top: 16, right: 16, bottom: 32, left: 48 };
const xFont = opts.xaxis?.fontSize ?? 13;            // Chart > X-Axis Font Size
const yFont = opts.yaxis?.fontSize ?? 13;            // Chart > Y-Axis Font Size
const xTop = opts.xaxis?.position === 'top';         // Chart > X Axis: Bottom / Top
const yRight = opts.yaxis?.position === 'right';     // Chart > Y Axis: Left / Right
// The X labels' side gets room for them, the other side the usual 16px (Top = the chart mirrored)
margin[xTop ? 'top' : 'bottom'] = 22 + xFont;
margin[xTop ? 'bottom' : 'top'] = 16;

${formatsCode}const xFmt = formatLike(opts.xaxis?.format);   // null = the axis' own labels

// X label angle (Chart > X-Axis > Text Angle): 0 horizontal, -90 / 90 vertical, -45 / 45 diagonal. Turned labels get
// room for the longest one.
const longest = d3.max(data, d => { const v = X(d); return String(xFmt ? xFmt(v) : v instanceof Date ? d3.utcFormat('%b %d')(v) : v).length; }) || 1;
// Auto: horizontal, unless the labels would run into each other: then vertical (reading top to bottom).
let xRot = opts.xaxis?.rotate ?? 'auto';
if (xRot === 'auto') {
  const n = typeof X(data[0] || {}) === 'string' ? new Set(data.map(X)).size : Math.max(2, Math.floor(W / 90));
  xRot = 0.6 * xFont * longest > (W - 80) / Math.max(1, n) - 6 ? 90 : 0;
}
xRot = +xRot;
if (xRot) {
  const a = Math.abs(xRot) * Math.PI / 180;
  margin[xTop ? 'top' : 'bottom'] = Math.ceil(14 + 0.6 * xFont * longest * Math.sin(a) + xFont * Math.cos(a));
}

// Y scale: values -> pixels (the Y labels' side fits the longest one)
const y = d3.scaleLinear()
    .domain(${yDomain})
    .nice()
    .range([H - margin.bottom, margin.top]);
// Top space (Chart > Top Space, 1 to 10): 10px per step between the highest value and the top of the plot
const topPad = 10 * (opts.topSpace ?? 1);
y.range([H - margin.bottom, margin.top + topPad]);
y.domain([y.domain()[0], y.invert(margin.top)]).range([H - margin.bottom, margin.top]);
const yFmt = formatLike(opts.yaxis?.format) || y.tickFormat(5);
margin[yRight ? 'right' : 'left'] = 14 + 0.7 * yFont * d3.max(y.ticks(5).map(yFmt), s => String(s).length);
margin[yRight ? 'left' : 'right'] = 16;   // Right = the chart mirrored: same width, the axis on the other side

// X scale
const x = ${xScale};

// The chart
const svg = d3.create('svg')
    .attr('viewBox', [0, 0, W, H]);

// Background (Chart > Background)
if (opts.background ?? true) {
  svg.append('rect')
      .attr('width', W)
      .attr('height', H)
      .attr('fill', theme.bg);
}

// Border around the whole chart (Chart > Border)
if (opts.border) {
  svg.append('rect')
      .attr('class', 'chart-border')
      .attr('x', 0.5)
      .attr('y', 0.5)
      .attr('width', W - 1)
      .attr('height', H - 1)
      .attr('fill', 'none')
      .attr('stroke', theme.border);
}

// Grid lines (Settings)
const grid = g => g
    .call(g => g.select('.domain').remove())
    .selectAll('line')
    .attr('stroke', theme.border)
    .attr('stroke-dasharray', '2,3');

if (opts.grid?.y) {
  svg.append('g')
      .attr('transform', 'translate(' + margin.left + ',0)')
      .call(d3.axisLeft(y)
          .ticks(5)
          .tickSize(-(W - margin.left - margin.right))
          .tickFormat(''))
      .call(grid);
}
if (opts.grid?.x) {
  svg.append('g')
      .attr('transform', 'translate(0,' + (H - margin.bottom) + ')')
      .call(${xAxis}
          .tickSize(-(H - margin.top - margin.bottom))
          .tickFormat(''))
      .call(grid);
}

// Axes
svg.append('g')
    .attr('transform', 'translate(0,' + (xTop ? margin.top : H - margin.bottom) + ')')
    .call(${xAxis.replace('d3.axisBottom(x)', '(xTop ? d3.axisTop : d3.axisBottom)(x)')}.tickSizeOuter(0).tickFormat(xFmt))
    .attr('font-size', xFont)
    .call(g => {
      if (!xRot) return;
      // Turned labels hang from their tick: start of the text at the tick when they lean right, end of it when left.
      const down = xTop ? -1 : 1, lean = xRot * down;
      g.selectAll('.tick text')
          .attr('x', 0)
          .attr('y', 0)
          .attr('dy', '.35em')
          .attr('text-anchor', lean > 0 ? 'start' : 'end')
          .attr('transform', 'translate(0,' + 9 * down + ') rotate(' + xRot + ')');
    })
    .call(g => g.select('.domain').attr('display', (opts.xaxis?.line ?? true) ? null : 'none'));   // Chart > X Axis Line

svg.append('g')
    .attr('transform', 'translate(' + (yRight ? W - margin.right : margin.left) + ',0)')
    .call((yRight ? d3.axisRight : d3.axisLeft)(y).ticks(5).tickFormat(yFmt))
    .attr('font-size', yFont)
    .call(g => g.select('.domain').attr('display', (opts.yaxis?.line ?? false) ? null : 'none'));   // Chart > Y Axis Line
`;
  const bandX = `d3.scaleBand()
    .domain(data.map(X))
    .range([margin.left, W - margin.right])
    .padding(0.2)`;
  // Line / area X: dates -> time scale, numbers -> linear, text -> points.
  const lineX = `data[0] && X(data[0]) instanceof Date
    ? d3.scaleUtc()
        .domain(d3.extent(data, X))
        .range([margin.left, W - margin.right])
    : typeof X(data[0] || {}) === 'number'
      ? d3.scaleLinear()
          .domain(d3.extent(data, X))
          .range([margin.left, W - margin.right])
      : d3.scalePoint()
          .domain(data.map(X))
          .range([margin.left, W - margin.right])
          .padding(0.5)`;
  const lineAxis = `d3.axisBottom(x).ticks(Math.max(2, Math.floor(W / 90)))`;

  const T = [
    { id: 'bar', label: 'Column', icon: '<rect x="3" y="11" width="4" height="10"/><rect x="10" y="5" width="4" height="16"/><rect x="17" y="8" width="4" height="13"/>',
      inputs: [X(), Y()], options: [XPOS, XFONT, XFMT, XROT, XLINE, GRID[0], YPOS, YFONT, YFMT, YLINE, GRID[1], BG, BORDER, TOPSPACE, DPOINTS, DPOS, DFONT, DFMT, DROT], sample: SAMPLE, samples: SAMPLES,
      code: `// Column chart: one bar per X value, height = Y.
${axisHead(bandX, 'd3.axisBottom(x)')}
// Bars
svg.append('g')
    .attr('fill', colors[0])
  .selectAll('rect')
  .data(data)
  .join('rect')
    .attr('x', d => x(X(d)))
    .attr('y', d => y(Y(d)))
    .attr('width', x.bandwidth())
    .attr('height', d => y(0) - y(Y(d)));

// Column values: the value on each bar (Chart > Column Values: Show, Font Size, Position outside / inside the bar)
if (opts.labels) {
  const inside = opts.labelPos === 'inside', vFont = opts.labelFont ?? 13;
  const fmt = formatLike(opts.labelFormat ?? '1,234') || d3.format(',');
  // Text Orientation (Column Values): Auto = horizontal, unless a value is wider than its bar: then vertical left (reading bottom to top).
  let vRot = opts.labelRotate ?? 'auto';
  if (vRot === 'auto') vRot = 0.6 * vFont * d3.max(data, d => fmt(Y(d)).length) > x.bandwidth() ? -90 : 0;
  vRot = +vRot;
  // Turned values hang from the top of their bar: outside they lean up and away from it, inside down into it.
  const cx = d => x(X(d)) + x.bandwidth() / 2;
  const cy = d => !vRot ? (inside ? y(Y(d)) + 4 + vFont : y(Y(d)) - 4) : inside ? y(Y(d)) + 4 : y(Y(d)) - 4;
  const anchor = !vRot ? 'middle' : (vRot < 0) === inside ? 'end' : 'start';
  svg.append('g')
      .attr('fill', inside ? '#fff' : theme.text2)
      .attr('font-size', vFont)
      .attr('text-anchor', anchor)
    .selectAll('text')
    .data(data)
    .join('text')
      .attr('x', cx)
      .attr('y', cy)
      .attr('dy', vRot ? '.35em' : null)
      .attr('transform', d => vRot ? 'rotate(' + vRot + ',' + cx(d) + ',' + cy(d) + ')' : null)
      .text(d => fmt(Y(d)));
}

return svg.node();
` },
    { id: 'hbar', label: 'Bar', flip: true, icon: '<rect x="3" y="3" width="12" height="4"/><rect x="3" y="10" width="18" height="4"/><rect x="3" y="17" width="9" height="4"/>',
      inputs: [X(), Y()], options: HBAR_OPTIONS, sample: SAMPLE, samples: SAMPLES,
      code: `// Bar chart: one horizontal bar per X value (down the side), length = Y. The same settings as the Column chart, turned
// on its side: X-Axis = the labels down the side, Y-Axis = the values along the bottom.

// Size and margins
const margin = { top: 16, right: 16, bottom: 16, left: 16 };
const xFont = opts.xaxis?.fontSize ?? 13;            // Chart > X-Axis Font Size (the labels down the side)
const yFont = opts.yaxis?.fontSize ?? 13;            // Chart > Y-Axis Font Size (the values along the bottom)
const xRight = opts.xaxis?.position === 'right';     // Chart > X-Axis Position: Left / Right
const yTop = opts.yaxis?.position === 'top';         // Chart > Y-Axis Position: Bottom / Top

${formatsCode}
const xFmt = formatLike(opts.xaxis?.format);
const xText = v => String(xFmt ? xFmt(v) : v instanceof Date ? d3.utcFormat('%b %d, %Y')(v) : v);

// X label orientation (Chart > X-Axis > Text Orientation): Auto = horizontal. The X labels' side gets room for the
// longest one (Right = the chart mirrored); the Y labels' side room for one line.
let xRot = opts.xaxis?.rotate ?? 'auto';
xRot = xRot === 'auto' ? 0 : +xRot;
const longest = d3.max(data, d => xText(X(d)).length) || 1, turn = Math.abs(xRot) * Math.PI / 180;
margin[xRight ? 'right' : 'left'] = Math.ceil(14 + 0.6 * xFont * longest * Math.cos(turn) + xFont * Math.sin(turn));
margin[yTop ? 'top' : 'bottom'] = 22 + yFont;

// Values -> pixels along the bottom, with End Space (Chart > End Space, 1 to 10: 10px per step) past the longest bar
const x = d3.scaleLinear()
    .domain([0, d3.max(data, Y) || 1])
    .nice()
    .range([margin.left, W - margin.right]);
const endPad = 10 * (opts.topSpace ?? 1);
x.range([margin.left, W - margin.right - endPad]);
x.domain([x.domain()[0], x.invert(W - margin.right)]).range([margin.left, W - margin.right]);
const ticks = Math.max(2, Math.min(8, Math.floor((W - margin.left - margin.right) / 80)));
const yFmt = formatLike(opts.yaxis?.format) || x.tickFormat(ticks);

// X values -> rows down the side
const y = d3.scaleBand()
    .domain(data.map(X))
    .range([margin.top, H - margin.bottom])
    .padding(0.2);

// The chart
const svg = d3.create('svg')
    .attr('viewBox', [0, 0, W, H]);

// Background (Chart > Background)
if (opts.background ?? true) {
  svg.append('rect')
      .attr('width', W)
      .attr('height', H)
      .attr('fill', theme.bg);
}

// Border around the whole chart (Chart > Border)
if (opts.border) {
  svg.append('rect')
      .attr('class', 'chart-border')
      .attr('x', 0.5)
      .attr('y', 0.5)
      .attr('width', W - 1)
      .attr('height', H - 1)
      .attr('fill', 'none')
      .attr('stroke', theme.border);
}

// Grid lines (Chart > X-Axis / Y-Axis > Grid Lines)
const grid = g => g
    .call(g => g.select('.domain').remove())
    .selectAll('line')
    .attr('stroke', theme.border)
    .attr('stroke-dasharray', '2,3');

if (opts.grid?.y) {
  svg.append('g')
      .attr('transform', 'translate(0,' + (H - margin.bottom) + ')')
      .call(d3.axisBottom(x)
          .ticks(ticks)
          .tickSize(-(H - margin.top - margin.bottom))
          .tickFormat(''))
      .call(grid);
}
if (opts.grid?.x) {
  svg.append('g')
      .attr('transform', 'translate(' + margin.left + ',0)')
      .call(d3.axisLeft(y)
          .tickSize(-(W - margin.left - margin.right))
          .tickFormat(''))
      .call(grid);
}

// X axis: the labels down the side
svg.append('g')
    .attr('transform', 'translate(' + (xRight ? W - margin.right : margin.left) + ',0)')
    .call((xRight ? d3.axisRight : d3.axisLeft)(y).tickSizeOuter(0).tickFormat(xText))
    .attr('font-size', xFont)
    .call(g => g.select('.domain').attr('display', (opts.xaxis?.line ?? true) ? null : 'none'))   // Chart > X-Axis > Border
    .call(g => {
      if (!xRot) return;
      // Turned labels sit centred just outside their tick.
      const side = xRight ? 1 : -1, out = 9 + (Math.abs(xRot) === 90 ? xFont * 0.6 : 0);
      g.selectAll('.tick text')
          .attr('x', 0)
          .attr('y', 0)
          .attr('dy', '.35em')
          .attr('text-anchor', Math.abs(xRot) === 90 ? 'middle' : xRight ? 'start' : 'end')
          .attr('transform', 'translate(' + side * out + ',0) rotate(' + xRot + ')');
    });

// Y axis: the values along the bottom
svg.append('g')
    .attr('transform', 'translate(0,' + (yTop ? margin.top : H - margin.bottom) + ')')
    .call((yTop ? d3.axisTop : d3.axisBottom)(x).ticks(ticks).tickFormat(yFmt))
    .attr('font-size', yFont)
    .call(g => g.select('.domain').attr('display', (opts.yaxis?.line ?? false) ? null : 'none'));   // Chart > Y-Axis > Border

// Bars
svg.append('g')
    .attr('fill', colors[0])
  .selectAll('rect')
  .data(data)
  .join('rect')
    .attr('x', x(0))
    .attr('y', d => y(X(d)))
    .attr('width', d => x(Y(d)) - x(0))
    .attr('height', y.bandwidth());

// Bar values: the value at the end of each bar (Chart > Bar Values: Show, Font Size, Format, Position outside / inside)
if (opts.labels) {
  const inside = opts.labelPos === 'inside', vFont = opts.labelFont ?? 13;
  const fmt = formatLike(opts.labelFormat ?? '1,234') || d3.format(',');
  // Text Orientation (Bar Values): Auto = horizontal, unless the text is taller than its bar: then vertical left.
  let vRot = opts.labelRotate ?? 'auto';
  if (vRot === 'auto') vRot = vFont > y.bandwidth() ? -90 : 0;
  vRot = +vRot;
  // Outside: just past the end of the bar; inside: just inside it (turned values a little further, centred).
  const gap = vRot ? 4 + vFont * 0.6 : 4;
  const cx = d => inside ? x(Y(d)) - gap : x(Y(d)) + gap;
  const cy = d => y(X(d)) + y.bandwidth() / 2;
  svg.append('g')
      .attr('fill', inside ? '#fff' : theme.text2)
      .attr('font-size', vFont)
      .attr('text-anchor', vRot ? 'middle' : inside ? 'end' : 'start')
    .selectAll('text')
    .data(data)
    .join('text')
      .attr('x', cx)
      .attr('y', cy)
      .attr('dy', '.35em')
      .attr('transform', d => vRot ? 'rotate(' + vRot + ',' + cx(d) + ',' + cy(d) + ')' : null)
      .text(d => fmt(Y(d)));
}

return svg.node();
` },
    { id: 'line', label: 'Line', icon: '<polyline points="3,18 8,11 13,14 21,5" fill="none" stroke="currentColor" stroke-width="2"/>',
      inputs: [X(), Y()], options: LINE_OPTIONS, sample: LINE_SAMPLES[0].rows, samples: LINE_SAMPLES, sort: 'label', top: 1000,
      code: `// Line chart: the Y values in X order, joined by a line.
${axisHead(lineX, lineAxis)}
// Data Smoothness (Chart > Line, 0 to 100%): every point moves that far from its real value toward the target (Data
// Smoothness Target: the average (mean) or the median of all of them) (0 = the real data, 100 = one flat line at the average). Dots and values follow the line, and the values show the smoothed numbers.
const avgY = (opts.line?.smoothTo === 'median' ? d3.median(data, Y) : d3.mean(data, Y)) ?? 0, smoothK = Math.max(0, Math.min(100, opts.line?.smooth ?? 0)) / 100;
const SY = d => Y(d) + (avgY - Y(d)) * smoothK;

// Line (Chart > Line: Width, Curve)
// Smooth Amount (0 to 100, with Curve: Smooth): how gradual the turns are; the line still goes through every real point.
const curve = opts.line?.curve === 'smooth' ? d3.curveCardinal.tension(1 - Math.max(0, Math.min(100, opts.line?.smoothAmount ?? 50)) / 100)
  : opts.line?.curve === 'step' ? d3.curveStepAfter : d3.curveLinear;
svg.append('path')
    .datum(data)
    .attr('fill', 'none')
    .attr('stroke', colors[0])
    .attr('stroke-width', opts.line?.width ?? 2)
    .attr('stroke-linejoin', 'round')
    .attr('stroke-linecap', 'round')
    .attr('d', d3.line()
        .curve(curve)
        .x(d => x(X(d)))
        .y(d => y(SY(d))));

// Dots on each point (Chart > Line: Dot Shape (None = no dots), Dot Size = the dot's radius in px, Dot Thickness = its outline in px,
// Dot Fill = filled or just the outline). X and Cross are drawn as lines only: Dot Thickness is how thick their lines are.
const dotR = opts.dotSize ?? 3;
const hasDots = (opts.dotShape || 'circle') !== 'none' && opts.dots !== false;   // Dot Shape: None = no dots
if (hasDots) {
  const SHAPES = { circle: d3.symbolCircle, square: d3.symbolSquare, diamond: d3.symbolDiamond, 'triangle-up': d3.symbolTriangle,
    'triangle-down': d3.symbolTriangle, cross: d3.symbolPlus, x: d3.symbolTimes, star: d3.symbolStar, wye: d3.symbolWye };
  const shape = opts.dotShape || 'circle', lines = shape === 'x' || shape === 'cross';
  const turn = shape === 'triangle-down' ? ' rotate(180)' : '';
  const dot = d3.symbol().type(SHAPES[shape] || d3.symbolCircle).size(Math.PI * dotR * dotR * (lines ? 2 : 1.3));
  const dotW = opts.dotWidth ?? 1, filled = !lines && (opts.dotFill ?? true);
  svg.append('g')
      .attr('fill', filled ? colors[0] : 'none')
      .attr('stroke', colors[0])
      .attr('stroke-width', dotW)
      .attr('stroke-linejoin', 'round')
      .attr('stroke-linecap', 'round')
    .selectAll('path')
    .data(data)
    .join('path')
      .attr('d', dot)
      .attr('transform', d => 'translate(' + x(X(d)) + ',' + y(SY(d)) + ')' + turn);
}

// Point values: the value at each point (Chart > Point Values: Show, Font Size, Format, Position above / below the point)
if (opts.labels) {
  const below = opts.labelPos === 'below', vFont = opts.labelFont ?? 13;
  const fmt = formatLike(opts.labelFormat ?? '1,234') || d3.format(',');
  // Density (Point Values: 5% to 100%, in steps of 5): that share of the points get their value, spread evenly along the line.
  const want = Math.max(1, Math.min(data.length, Math.round(data.length * (+(opts.labelShare ?? 100) || 100) / 100)));
  const shown = want >= data.length ? data : want === 1 ? data.slice(-1)
    : [...new Set(d3.range(want).map(i => Math.round(i * (data.length - 1) / (want - 1))))].map(i => data[i]);
  // Text Orientation (Point Values): Auto = horizontal, unless the values would run into each other: then vertical left.
  let vRot = opts.labelRotate ?? 'auto';
  if (vRot === 'auto') {
    const step = (W - margin.left - margin.right) / Math.max(1, shown.length - 1);
    vRot = 0.6 * vFont * d3.max(shown, d => fmt(SY(d)).length) > step - 4 ? -90 : 0;
  }
  vRot = +vRot;
  // Above: just over the dot; below: just under it. Turned values lean away from the line.
  const off = (hasDots ? dotR : 0) + 4;
  const cx = d => x(X(d));
  const cy = d => below ? y(SY(d)) + off + (vRot ? 0 : vFont * 0.8) : y(SY(d)) - off;
  svg.append('g')
      .attr('fill', theme.text2)
      .attr('font-size', vFont)
      .attr('text-anchor', !vRot ? 'middle' : (vRot < 0) !== below ? 'start' : 'end')
    .selectAll('text')
    .data(shown)
    .join('text')
      .attr('x', cx)
      .attr('y', cy)
      .attr('dy', vRot ? '.35em' : null)
      .attr('transform', d => vRot ? 'rotate(' + vRot + ',' + cx(d) + ',' + cy(d) + ')' : null)
      .text(d => fmt(SY(d)));
}

return svg.node();
` },
    { id: 'area', label: 'Area', icon: '<path d="M3 20 L3 14 L8 9 L13 12 L21 5 L21 20 Z"/>',
      inputs: [X(), Y()], options: [XPOS, XFONT, XFMT, XROT, XLINE, GRID[0], YPOS, YFONT, YFMT, YLINE, GRID[1], BG, BORDER, TOPSPACE], sample: TIME, sort: 'label', top: 1000,
      code: `// Area chart: a line with the space under it filled.
${axisHead(lineX, lineAxis)}
// Area
svg.append('path')
    .datum(data)
    .attr('fill', colors[0])
    .attr('fill-opacity', 0.25)
    .attr('d', d3.area()
        .x(d => x(X(d)))
        .y0(y(0))
        .y1(d => y(Y(d))));

// Its top line
svg.append('path')
    .datum(data)
    .attr('fill', 'none')
    .attr('stroke', colors[0])
    .attr('stroke-width', 2)
    .attr('d', d3.line()
        .x(d => x(X(d)))
        .y(d => y(Y(d))));

return svg.node();
` },
    { id: 'scatter', label: 'Scatter', icon: '<circle cx="6" cy="16" r="2"/><circle cx="10" cy="9" r="2"/><circle cx="15" cy="13" r="2"/><circle cx="19" cy="6" r="2"/>',
      inputs: [{ key: 'x', label: 'X', role: 'measure', axis: 'x', agg: 'none' }, Y('Y', 'none')], options: [XPOS, XFONT, XFMT, XROT, XLINE, GRID[0], YPOS, YFONT, YFMT, YLINE, GRID[1], BG, BORDER, TOPSPACE], sample: POINTS,
      code: `// Scatter plot: one dot per row at (X, Y).
${axisHead(`d3.scaleLinear()
    .domain(d3.extent(data, X))
    .nice()
    .range([margin.left, W - margin.right])`, 'd3.axisBottom(x).ticks(Math.max(2, Math.floor(W / 90)))', 'd3.extent(data, Y)')}
// Dots
svg.append('g')
    .attr('fill', colors[0])
    .attr('fill-opacity', 0.7)
  .selectAll('circle')
  .data(data)
  .join('circle')
    .attr('cx', d => x(X(d)))
    .attr('cy', d => y(Y(d)))
    .attr('r', 3.5);

return svg.node();
` },
    { id: 'pie', label: 'Pie', icon: '<path d="M12 3 A9 9 0 1 1 3 12 L12 12 Z"/><path d="M12 3 L12 12 L3 12 A9 9 0 0 1 12 3" opacity=".5"/>',
      inputs: [X(), Y()], options: [LEGEND, LABELS], sample: SAMPLE, code: pieCode(0) },
    { id: 'donut', label: 'Donut', icon: '<path d="M12 3 A9 9 0 1 1 3 12 L7 12 A5 5 0 1 0 12 7 Z"/><path d="M12 3 L12 7 A5 5 0 0 0 7 12 L3 12 A9 9 0 0 1 12 3" opacity=".5"/>',
      inputs: [X(), Y()], options: [LEGEND, LABELS], sample: SAMPLE, code: pieCode(0.6) },
  ];
  function pieCode(hole) {
    const lr = hole ? 0.8 : 0.6;   // where the value labels sit (share of the radius)
    return `// ${hole ? 'Donut' : 'Pie'} chart: one slice per X value, size = Y.

// Size: room for the legend on the right (Settings)
const legendW = opts.legend ? Math.min(160, W * 0.35) : 0;
const r = Math.max(10, Math.min(W - legendW, H) / 2 - 8);
const cx = (W - legendW) / 2;
const cy = H / 2;

// Slices
const pie = d3.pie()
    .value(Y)
    .sort(null)(data);

const arc = d3.arc()
    .innerRadius(r * ${hole})
    .outerRadius(r);

// The chart
const svg = d3.create('svg')
    .attr('viewBox', [0, 0, W, H]);

const g = svg.append('g')
    .attr('transform', 'translate(' + cx + ',' + cy + ')');

g.selectAll('path')
  .data(pie)
  .join('path')
    .attr('fill', (d, i) => colors[i % colors.length])
    .attr('stroke', theme.bg || 'none')
    .attr('stroke-width', 1)
    .attr('d', arc);

// Value labels (Settings)
if (opts.labels) {
  const at = d3.arc()
      .innerRadius(r * ${lr})
      .outerRadius(r * ${lr});
  g.selectAll('text')
    .data(pie)
    .join('text')
      .attr('transform', d => 'translate(' + at.centroid(d) + ')')
      .attr('text-anchor', 'middle')
      .attr('font-size', 13)
      .attr('fill', theme.text)
      .text(d => d3.format('~s')(Y(d.data)));
}

// Legend (Settings)
if (opts.legend) {
  const legend = svg.append('g')
      .attr('transform', 'translate(' + (W - legendW + 8) + ',' + Math.max(8, cy - data.length * 10) + ')')
      .attr('font-size', 13)
      .attr('fill', theme.text2);

  const row = legend.selectAll('g')
    .data(data)
    .join('g')
      .attr('transform', (d, i) => 'translate(0,' + i * 20 + ')');

  row.append('rect')
      .attr('class', 'square')
      .attr('width', 10)
      .attr('height', 10)
      .attr('rx', 2)
      .attr('fill', (d, i) => colors[i % colors.length]);

  row.append('text')
      .attr('x', 16)
      .attr('y', 9)
      .text(X);
}

return svg.node();
`;
  }
  const get = id => T.find(t => t.id === id);
  return { list: T, get };
})();
