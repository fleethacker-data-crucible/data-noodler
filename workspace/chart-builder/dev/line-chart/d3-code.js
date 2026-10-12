// Line chart: the Y values in X order, joined by a line.
// Size and margins
const margin = { top: 16, right: 16, bottom: 32, left: 48 };
const xFont = opts.xaxis?.fontSize ?? 13;            // Chart > X-Axis Font Size
const yFont = opts.yaxis?.fontSize ?? 13;            // Chart > Y-Axis Font Size
const xTop = opts.xaxis?.position === 'top';         // Chart > X Axis: Bottom / Top
const yRight = opts.yaxis?.position === 'right';     // Chart > Y Axis: Left / Right
// The X labels' side gets room for them, the other side the usual 16px (Top = the chart mirrored)
margin[xTop ? 'top' : 'bottom'] = 22 + xFont;
margin[xTop ? 'bottom' : 'top'] = 16;

// Formats (Chart > X-Axis / Y-Axis / Column Values > Format): picked from a list of examples; the one picked is used for
// every value. None = the value exactly as it is in the data. Auto (numbers) = each value in the unit that fits it
// (950, 1.2K, 3.4M, 2.1B). A typed number example: the text before / after the number is kept, a comma = thousands
// separator, the decimals = how many, K / M / B = every value in thousands / millions / billions, % = the values are
// already percents, (1,234) = negatives in brackets, +1,234 = always a sign, 1.2e+3 = scientific.
const DATES = { '2026-01-31': '%Y-%m-%d', '01/31/2026': '%m/%d/%Y', '31/01/2026': '%d/%m/%Y', 'Jan 31, 2026': '%b %d, %Y', '31 Jan 2026': '%d %b %Y',
  'Jan 2026': '%b %Y', 'January 2026': '%B %Y', 'Jan': '%b', '2026': '%Y', 'Q1 2026': d => 'Q' + (Math.floor(d.getUTCMonth() / 3) + 1) + ' ' + d.getUTCFullYear() };
const CASES = { 'UPPER CASE': s => s.toUpperCase(), 'lower case': s => s.toLowerCase(),
  'Title Case': s => s.toLowerCase().replace(/(^|[\s_-])(\S)/g, (m, a, b) => a + b.toUpperCase()),
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
  if (/^\d(\.\d+)?e[+-]?\d+$/i.test(ex)) { const f = d3.format('.' + ((ex.split('e')[0].split('.')[1] || '').length) + 'e'); return v => f(v); }
  const paren = /^\(.*\)$/.test(ex); if (paren) ex = ex.slice(1, -1);
  const plus = ex.startsWith('+'); if (plus) ex = ex.slice(1);
  const m = ex.match(/^([^\d.]*)(\d{1,3}(?:,\d{3})+|\d+)?(?:\.(\d+))?(\s*(?:[KMB](?![a-z])|%)?)(.*)$/i);
  if (!m) return null;
  const [, pre, int = '', dec = '', unit, post] = m, n = { K: 1e3, M: 1e6, B: 1e9 }[unit.trim().toUpperCase()] || 1;
  const f = d3.format((int.includes(',') ? ',' : '') + '.' + dec.length + 'f');
  return v => {
    const s = pre + f(Math.abs(v) / n) + unit + post;
    return v < 0 ? (paren ? '(' + s + ')' : '-' + s) : (plus && v > 0 ? '+' : '') + s;
  };
};const xFmt = formatLike(opts.xaxis?.format);   // null = the axis' own labels

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
    .domain([0, d3.max(data, Y) || 1])
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
const x = data[0] && X(data[0]) instanceof Date
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
          .padding(0.5);

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
      .call(d3.axisBottom(x).ticks(Math.max(2, Math.floor(W / 90)))
          .tickSize(-(H - margin.top - margin.bottom))
          .tickFormat(''))
      .call(grid);
}

// Axes
svg.append('g')
    .attr('transform', 'translate(0,' + (xTop ? margin.top : H - margin.bottom) + ')')
    .call((xTop ? d3.axisTop : d3.axisBottom)(x).ticks(Math.max(2, Math.floor(W / 90))).tickSizeOuter(0).tickFormat(xFmt))
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
