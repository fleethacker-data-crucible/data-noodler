// Column chart: one bar per X value, height = Y.
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
const x = d3.scaleBand()
    .domain(data.map(X))
    .range([margin.left, W - margin.right])
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
      .call(d3.axisBottom(x)
          .tickSize(-(H - margin.top - margin.bottom))
          .tickFormat(''))
      .call(grid);
}

// Axes
svg.append('g')
    .attr('transform', 'translate(0,' + (xTop ? margin.top : H - margin.bottom) + ')')
    .call((xTop ? d3.axisTop : d3.axisBottom)(x).tickSizeOuter(0).tickFormat(xFmt))
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
