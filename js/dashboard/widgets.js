// Dashboard widgets: query building (split into per-engine "partial" + combining "final" SQL) and SVG rendering.
// Global: Widgets.
//   widget = { id, type: 'kpi'|'bar'|'line'|'table', title, dataset, dim, agg, col, where, limit, sort }
const Widgets = (() => {
  const q = s => '"' + String(s).replace(/"/g, '""') + '"';
  const AGGS = ['count', 'sum', 'avg', 'min', 'max', 'count_distinct'];
  const TYPES = { kpi: 'KPI number', bar: 'Bar chart', line: 'Line chart', table: 'Table' };
  const COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)', 'var(--c7)'];

  // Measure split into a per-engine part and a combining part, so the job can run on several engines.
  function measure(w) {
    const c = w.col ? q(w.col) : '*';
    switch (w.agg) {
      case 'count': return { p: [`count(${w.col ? c : '*'}) AS m`], f: 'sum(m)' };
      case 'sum': return { p: [`sum(${c}) AS m`], f: 'sum(m)' };
      case 'min': return { p: [`min(${c}) AS m`], f: 'min(m)' };
      case 'max': return { p: [`max(${c}) AS m`], f: 'max(m)' };
      case 'avg': return { p: [`sum(${c}) AS s`, `count(${c}) AS n`], f: 'sum(s) / sum(n)' };
      case 'count_distinct': return { p: [], f: `count(DISTINCT ${c})`, distinct: c };
      default: throw new Error(`Unknown aggregate ${w.agg}`);
    }
  }
  // { partial(src), final, kind } for kpi/bar/line; kind = profile test used to pick the engine count.
  function aggQuery(w) {
    const m = measure(w), dim = w.type === 'kpi' || !w.dim ? null : q(w.dim);
    const where = w.where?.trim() ? ` WHERE ${w.where}` : '';
    const label = dim ? `${dim} AS d, ` : '';
    const partial = m.distinct
      ? src => `SELECT DISTINCT ${dim ? `${dim} AS d, ` : ''}${m.distinct} AS v FROM ${src}${where}`
      : src => `SELECT ${label}${m.p.join(', ')} FROM ${src}${where}${dim ? ' GROUP BY 1' : ''}`;
    const fm = m.distinct ? 'count(DISTINCT v)' : m.f;
    const order = w.type === 'line' ? 'ORDER BY d' : w.sort === 'label' ? 'ORDER BY d' : 'ORDER BY m DESC NULLS LAST';
    const final = dim
      ? `SELECT d, ${fm} AS m FROM __parts GROUP BY d ${order}${+w.limit > 0 ? ` LIMIT ${+w.limit}` : ''}`
      : `SELECT ${fm} AS m FROM __parts`;
    return { partial, final, kind: m.distinct ? 'dist' : dim ? 'group' : 'scan' };
  }
  const tableQuery = (w, src) => `SELECT * FROM ${src}${w.where?.trim() ? ` WHERE ${w.where}` : ''}${w.sort && w.sort !== 'label' ? ` ORDER BY ${w.sort}` : ''} LIMIT ${Math.min(+w.limit || 100, 1000)}`;

  // ---- rendering ----
  const fmt = v => typeof v === 'number' ? (Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : Math.abs(v) >= 1e4 ? Math.round(v).toLocaleString() : +v.toFixed(2) + '') : String(v ?? '');
  const nice = max => { const p = 10 ** Math.floor(Math.log10(max || 1)); for (const k of [1, 2, 5, 10]) if (k * p >= max) return k * p; return max; };
  let tip;
  const bindTips = el => {
    tip ||= document.body.appendChild(Object.assign(document.createElement('div'), { className: 'tip' }));
    el.querySelectorAll('[data-tip]').forEach(p => {
      p.onmousemove = e => { tip.textContent = p.dataset.tip; tip.style.display = 'block'; tip.style.left = e.clientX + 12 + 'px'; tip.style.top = e.clientY + 12 + 'px'; };
      p.onmouseleave = () => tip.style.display = 'none';
    });
  };
  function kpi(el, rows, w) {
    const v = Number(rows[0]?.[0]); // KPIs show the exact value, not the abbreviated chart label
    el.innerHTML = `<div class="kpi">${UI.esc(Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 }))}</div><div class="kpi-label">${UI.esc(`${w.agg.replace('_', ' ')}${w.col ? ` of ${w.col}` : ''}`)}</div>`;
  }
  // Horizontal bars: label on the left, value bar to the right.
  function bar(el, rows) {
    const H = 22, L = 150, W = 560, max = nice(Math.max(...rows.map(r => Number(r[1]) || 0), 0));
    let s = `<svg viewBox="0 0 ${W + L + 70} ${rows.length * H + 6}">`;
    rows.forEach((r, i) => {
      const v = Number(r[1]) || 0, w = max ? W * v / max : 0, y = i * H + 3;
      s += `<text x="${L - 8}" y="${y + 15}" text-anchor="end">${UI.esc(String(r[0] ?? 'null').slice(0, 22))}</text>`;
      s += `<rect x="${L}" y="${y + 2}" width="${Math.max(1, w)}" height="${H - 6}" rx="3" fill="${COLORS[0]}" data-tip="${UI.esc(`${r[0]}: ${fmt(v)}`)}"/>`;
      s += `<text x="${L + w + 6}" y="${y + 15}">${UI.esc(fmt(v))}</text>`;
    });
    el.innerHTML = s + '</svg>'; bindTips(el);
  }
  function line(el, rows) {
    const W = 760, H = 240, L = 60, B = 26, T = 10, iw = W - L - 10, ih = H - T - B;
    const vals = rows.map(r => Number(r[1]) || 0), max = nice(Math.max(...vals, 0)), n = rows.length;
    const x = i => L + (n > 1 ? iw * i / (n - 1) : iw / 2), y = v => T + ih - ih * v / (max || 1);
    let s = `<svg viewBox="0 0 ${W} ${H}">`;
    for (let k = 0; k <= 4; k++) { const v = max * k / 4; s += `<line class="gridline" x1="${L}" x2="${W - 10}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`; }
    const step = Math.max(1, Math.ceil(n / 8));
    rows.forEach((r, i) => { if (i % step === 0) s += `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${UI.esc(String(r[0]).slice(0, 10))}</text>`; });
    s += `<polyline fill="none" stroke="${COLORS[0]}" stroke-width="2" points="${vals.map((v, i) => `${x(i)},${y(v)}`).join(' ')}"/>`;
    vals.forEach((v, i) => s += `<circle cx="${x(i)}" cy="${y(v)}" r="${n > 60 ? 1.5 : 3}" fill="${COLORS[0]}" data-tip="${UI.esc(`${rows[i][0]}: ${fmt(v)}`)}"/>`);
    el.innerHTML = s + '</svg>'; bindTips(el);
  }
  const render = (el, w, res) => w.type === 'kpi' ? kpi(el, res.rows, w) : w.type === 'bar' ? bar(el, res.rows) : w.type === 'line' ? line(el, res.rows) : UI.dataTable(el, res.cols, res.rows, { max: 200 });

  return { AGGS, TYPES, aggQuery, tableQuery, render, q };
})();
