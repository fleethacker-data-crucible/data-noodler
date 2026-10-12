// Bar chart: one horizontal bar per X value (down the side), length = Y. The same settings as the Column chart, turned
// on its side: X-Axis = the labels down the side, Y-Axis = the values along the bottom.

// Size and margins
const margin = { top: 16, right: 16, bottom: 16, left: 16 };
const xFont = opts.xaxis?.fontSize ?? 13;            // Chart > X-Axis Font Size (the labels down the side)
const yFont = opts.yaxis?.fontSize ?? 13;            // Chart > Y-Axis Font Size (the values along the bottom)
const xRight = opts.xaxis?.position === 'right';     // Chart > X-Axis Position: Left / Right
const yTop = opts.yaxis?.position === 'top';         // Chart > Y-Axis Position: Bottom / Top

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
};
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
