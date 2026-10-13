// Pie Chart (after Mike Bostock's Observable PieChart): one wedge per Name, sized by Value. A Donut Hole above 0 makes it a
// donut. Labels sit at 80% of the radius: the name in bold, the value under it (wedges too thin for two lines show the
// name only). Hover a wedge: its name and value.
//   data      rows { name, value }
//   settings  colors / labels / formats from d3-settings.json
export default function widget(data, { width, height, settings: S }) {
  const root = d3.create('div').attr('class', 'root');
  const svg = root.append('svg').attr('viewBox', [-width / 2, -height / 2, width, height]);

  const rows = data.filter(d => d.name != null && Number.isFinite(+d.value) && +d.value > 0);
  if (!rows.length) {
    svg.append('text').attr('class', 'empty').attr('text-anchor', 'middle').attr('dy', '0.35em').text('Drag a field onto Name and Value (Data)');
    return root.node();
  }
  if (S.sort === 'Largest First') rows.sort((a, b) => b.value - a.value);
  else if (S.sort === 'Smallest First') rows.sort((a, b) => a.value - b.value);

  // ---- sizes ----
  const outerRadius = Math.max(10, Math.min(width, height) / 2 - 4);
  const innerRadius = outerRadius * Math.min(0.9, Math.max(0, (S.donut || 0) / 100));
  const labelRadius = innerRadius * 0.2 + outerRadius * 0.8;
  const strokeWidth = S.strokeWidth ?? 1;
  const stroke = strokeWidth > 0 ? S.strokeColor || '#ffffff' : 'none';
  const padAngle = innerRadius > 0 && strokeWidth === 0 ? 1 / outerRadius : 0;

  // ---- colours: one per name ----
  const names = new d3.InternSet(rows.map(d => d.name));
  const color = d3.scaleOrdinal(names, scheme(S.scheme, names.size));

  // ---- labels and titles ----
  const fmtName = makeFmt(S.nameFormat, kindOf(rows.map(d => d.name)));
  const fmtValue = makeFmt(S.valueFormat, 'number');
  const lines = d => [fmtName(d.name), fmtValue(+d.value)];

  const arcs = d3.pie().padAngle(padAngle).sort(null).value(d => +d.value)(rows);
  const arc = d3.arc().innerRadius(innerRadius).outerRadius(outerRadius);
  const arcLabel = d3.arc().innerRadius(labelRadius).outerRadius(labelRadius);

  svg.append('g').attr('class', 'wedges')
    .attr('stroke', stroke).attr('stroke-width', strokeWidth).attr('stroke-linejoin', 'round')
    .selectAll('path').data(arcs).join('path')
      .attr('fill', d => color(d.data.name))
      .attr('d', arc)
    .append('title')
      .text(d => lines(d.data).join('\n'));

  if (S.labels) {
    svg.append('g').attr('class', 'labels')
      .attr('font-size', S.fontSize).attr('text-anchor', 'middle').attr('fill', S.labelColor || '#000000')
      .selectAll('text').data(arcs).join('text')
        .attr('transform', d => `translate(${arcLabel.centroid(d)})`)
      .selectAll('tspan')
      .data(d => { const l = lines(d.data); return S.values && d.endAngle - d.startAngle > 0.25 ? l : l.slice(0, 1); })
      .join('tspan')
        .attr('x', 0)
        .attr('y', (_, i) => `${i * 1.1}em`)
        .attr('font-weight', (_, i) => i ? null : 'bold')
        .text(t => t);
  }
  return root.node();
}

// ---- colour schemes (Colors > Color Scheme); Spectral as in the original: its own steps up to 11 names, then spread ----
function scheme(name, n) {
  if (name === 'Spectral' || !name) return n >= 3 && n <= 11 ? d3.schemeSpectral[n] : d3.quantize(t => d3.interpolateSpectral(t * 0.8 + 0.1), Math.max(n, 1));
  const ramps = { Viridis: d3.interpolateViridis, Blues: t => d3.interpolateBlues(0.25 + t * 0.7), Rainbow: d3.interpolateRainbow, Warm: d3.interpolateWarm, Cool: d3.interpolateCool };
  if (ramps[name]) return d3.quantize(ramps[name], Math.max(n, 2)).slice(0, Math.max(n, 1));
  const lists = { 'Tableau 10': d3.schemeTableau10, 'Category 10': d3.schemeCategory10, 'Set 2': d3.schemeSet2, Pastel: d3.schemePastel1, 'Dark 2': d3.schemeDark2, Paired: d3.schemePaired };
  return lists[name] || d3.schemeTableau10;   // an ordinal scale repeats a short list
}

// ---- Formats (Formats section): the setting is an example of how a value should look ----
// Text: Auto (= Title Case), None, CAPS, Sentence case, Title Case, lower case.
// Numbers: Auto (whole number when it fits, else 0.9K / 1.2M / 3.4B), None (as in the data) or an example: 1,234 / (1,234) /
//   +1,234 / 1,234.56 / $1,234 / €1,234 / 12.5% / 1.2K / $1.2M / 1.2e+3 / 1,234 units ...
// Dates: Auto (Jan 31, 2026), None or an example: 2026-01-31 / 01/31/2026 / Jan 2026 / Q1 2026 ...
const kindOf = vals => { const v = vals.find(x => x != null && x !== ''); return v instanceof Date ? 'date' : typeof v === 'number' ? 'number'
  : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? 'date' : 'text'; };
const CASES = {
  'CAPS': s => s.toUpperCase(), 'lower case': s => s.toLowerCase(),
  'Sentence case': s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(),
  'Title Case': s => s.toLowerCase().replace(/(^|[\s\-_/(])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()),
};
const DATES = { '2026-01-31': '%Y-%m-%d', '01/31/2026': '%m/%d/%Y', '31/01/2026': '%d/%m/%Y', 'Jan 31, 2026': '%b %-d, %Y', '31 Jan 2026': '%-d %b %Y',
  'January 31, 2026': '%B %-d, %Y', 'Jan 2026': '%b %Y', 'January 2026': '%B %Y', 'Jan': '%b', 'January': '%B', '2026': '%Y', 'Mon': '%a', 'Monday': '%A' };
const toDate = v => v instanceof Date ? v : new Date(String(v).length === 10 ? v + 'T00:00:00' : v);
const SCALE = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
// Compact with floored decimals: 999 -> 0.9K, 1,250,000 -> 1.2M.
function compact(v, dec = 1, unit = null, cur = '') {
  const a = Math.abs(v), u = unit || (a >= 1e12 ? 'T' : a >= 1e9 ? 'B' : a >= 1e6 ? 'M' : 'K'), f = 10 ** dec;
  const n = Math.trunc(v / SCALE[u] * f) / f;
  return (n < 0 ? '-' : '') + cur + Math.abs(n).toFixed(dec) + u;
}
// A number format from an example ("($1,234.56)", "12.5%", "$1.2M", "1,234 units").
function numberFmt(ex) {
  const m = String(ex).trim().match(/^(\()?([+])?([$€£¥]?)\s*([\d,]*\d)(?:\.(\d+))?(e\+\d+|[KMBT]|%)?([$€£¥]?)(\))?(.*)$/i);
  if (!m) return v => String(v);
  const [, par, plus, pre = '', int, frac = '', tail = '', post = '', , rest = ''] = m, dec = frac.length, comma = int.includes(',');
  const t = tail.toUpperCase();
  if (/^E/.test(t)) return v => d3.format(`.${dec}e`)(v);
  if (SCALE[t]) return v => compact(v, dec, t, pre);
  const f = d3.format(`${comma ? ',' : ''}.${dec}${t === '%' ? '%' : 'f'}`);
  return v => { const neg = v < 0, s = f(Math.abs(v)); return (neg ? (par ? '(' : '-') : plus ? '+' : '') + pre + s + post + (neg && par ? ')' : '') + rest; };
}
function makeFmt(spec, kind) {
  spec = spec || 'Auto';
  if (spec === 'None') return v => v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '');
  if (kind === 'text') { const f = CASES[spec === 'Auto' ? 'Title Case' : spec] || (s => s); return v => f(String(v ?? '')); }
  if (kind === 'date') {
    if (/^Q1/.test(spec)) return v => { const t = toDate(v); return isNaN(t) ? String(v) : `Q${Math.floor(t.getMonth() / 3) + 1} ${t.getFullYear()}`; };
    const f = d3.timeFormat(DATES[spec === 'Auto' ? 'Jan 31, 2026' : spec] || '%b %-d, %Y');
    return v => { const t = toDate(v); return isNaN(t) ? String(v) : f(t); };
  }
  if (spec === 'Auto') return d3.format(',');   // as in the original: 1,234
  return numberFmt(spec);
}
