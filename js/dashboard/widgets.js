// Dashboard widgets: declarative queries for the native engine (Widgets.query) and SVG rendering.
// Global: Widgets. Used by html/dashboard.html and inlined into published dashboards (html/publish.html).
//   widget (dashboard.json v2) = { id, type: 'chart' | 'table', title, dataset, x, y, w, h (grid cells),
//     chart: 'bar' | 'line', measure: { agg, col }, category: { col, sort: 'value' | 'label', limit },   (charts)
//     fields: [column names, in display order], limit }                                                (tables)
//   Bar = horizontal: X axis = measure, Y axis = categories. Line: X axis = categories, Y axis = measure.
//   Widgets.spec(w) flattens a widget (or an older v1 one) to { type: 'bar'|'line'|'table', dim, agg, col, ... }.
const Widgets = (() => {
  const q = s => '"' + String(s).replace(/"/g, '""') + '"';
  const AGGS = ['count', 'count_distinct', 'sum', 'avg', 'min', 'max'];
  const AGG_LABEL = { count: 'Count', count_distinct: 'Count distinct', sum: 'Sum', avg: 'Average', min: 'Min', max: 'Max' };
  const NUMERIC = /INT|DOUBLE|FLOAT|DECIMAL|REAL|NUMERIC|HUGEINT/i;   // sum / avg need a number column
  const TYPES = { chart: 'Chart', table: 'Table' };
  const CHARTS = { bar: 'Bar', line: 'Line' };
  const COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)', 'var(--c7)'];

  function spec(w) {
    if (w.type === 'chart') return { type: w.chart || 'bar', dim: w.category?.col || '', agg: w.measure?.agg || 'count', col: w.measure?.col || '', limit: w.category?.limit ?? 20, sort: w.category?.sort || 'value', where: w.where };
    if (w.type === 'table') return { type: 'table', cols: w.fields || null, limit: w.limit ?? 100, where: w.where, sort: w.sort };
    return w;   // v1 widget (kpi / bar / line / table with dim, agg, col)
  }
  // Has everything it needs to run a query? Otherwise the widget shows a "set me up" note.
  function ready(w) {
    const s = spec(w);
    if (!w.dataset) return false;
    if (s.type === 'table') return !w.fields || w.fields.length > 0;
    if (s.type === 'bar' || s.type === 'line') return !!s.dim && (s.agg === 'count' || !!s.col);
    return true;
  }

  // Declarative query for the engine (plan: dashboard widgets describe WHAT to calculate; the engine calculates).
  //   chart -> rows [category, measure]; kpi -> [[measure]]; table -> the chosen fields.
  function query(w) {
    const s = spec(w), where = s.where?.trim() || undefined;
    if (s.type === 'table') {
      const sort = s.sort && s.sort !== 'label' && s.sort !== 'value' ? [{ expr: s.sort }] : undefined;
      return { dataset: w.dataset, select: s.cols?.length ? s.cols : ['*'], where, sort, limit: Math.min(+s.limit || 100, 1000) };
    }
    if (!AGGS.includes(s.agg)) throw new Error(`Unknown aggregate ${s.agg}`);
    const aggregate = [{ function: s.agg, column: s.col || undefined, as: 'm' }];
    if (s.type === 'kpi' || !s.dim) return { dataset: w.dataset, aggregate, where };
    const sort = s.type === 'line' || s.sort === 'label' ? [{ column: s.dim, direction: 'asc' }] : [{ column: 'm', direction: 'desc' }];
    return { dataset: w.dataset, groupBy: [s.dim], aggregate, where, sort, limit: +s.limit > 0 ? +s.limit : undefined };
  }

  // ---- rendering (sized to the element, so a resized widget redraws crisply) ----
  const fmt = v => typeof v === 'number' ? (Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : Math.abs(v) >= 1e4 ? Math.round(v).toLocaleString() : +v.toFixed(2) + '') : String(v ?? '');
  const nice = max => { const p = 10 ** Math.floor(Math.log10(max || 1)); for (const k of [1, 2, 5, 10]) if (k * p >= max) return k * p; return max; };
  const size = el => { const cs = getComputedStyle(el); return [Math.max(60, (el.clientWidth || 760) - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)), Math.max(60, (el.clientHeight || 260) - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom))]; };
  let tip;
  const bindTips = el => {
    tip ||= document.body.appendChild(Object.assign(document.createElement('div'), { className: 'tip' }));
    el.querySelectorAll('[data-tip]').forEach(p => {
      p.onmousemove = e => { tip.textContent = p.dataset.tip; tip.style.display = 'block'; tip.style.left = e.clientX + 12 + 'px'; tip.style.top = e.clientY + 12 + 'px'; };
      p.onmouseleave = () => tip.style.display = 'none';
    });
  };
  function kpi(el, rows, s) {
    const v = Number(rows[0]?.[0]); // KPIs show the exact value, not the abbreviated chart label
    el.innerHTML = `<div class="kpi">${UI.esc(Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 }))}</div><div class="kpi-label">${UI.esc(`${s.agg.replace('_', ' ')}${s.col ? ` of ${s.col}` : ''}`)}</div>`;
  }
  // Horizontal bars: label on the left, value bar to the right. Rows shrink to fit the height (min 14px).
  function bar(el, rows) {
    const [W] = size(el), n = Math.max(1, rows.length), [, Hel] = size(el);
    const H = Math.max(14, Math.min(26, Math.floor((Hel - 4) / n))), L = Math.min(160, Math.round(W * 0.3)), bw = Math.max(40, W - L - 70);
    const max = nice(Math.max(...rows.map(r => Number(r[1]) || 0), 0));
    let s = `<svg width="${W}" height="${n * H + 4}" viewBox="0 0 ${W} ${n * H + 4}">`;
    rows.forEach((r, i) => {
      const v = Number(r[1]) || 0, w = max ? bw * v / max : 0, y = i * H + 2, mid = y + H / 2 + 4;
      s += `<text x="${L - 8}" y="${mid}" text-anchor="end">${UI.esc(String(r[0] ?? 'null').slice(0, 24))}</text>`;
      s += `<rect x="${L}" y="${y + 2}" width="${Math.max(1, w)}" height="${H - 5}" rx="4" fill="${COLORS[0]}" data-tip="${UI.esc(`${r[0]}: ${fmt(v)}`)}"/>`;
      s += `<text x="${L + w + 6}" y="${mid}">${UI.esc(fmt(v))}</text>`;
    });
    el.innerHTML = s + '</svg>'; bindTips(el);
  }
  function line(el, rows) {
    const [W, H] = size(el), L = 56, B = 24, T = 10, iw = W - L - 14, ih = H - T - B;
    const vals = rows.map(r => Number(r[1]) || 0), max = nice(Math.max(...vals, 0)), n = rows.length;
    const x = i => L + (n > 1 ? iw * i / (n - 1) : iw / 2), y = v => T + ih - ih * v / (max || 1);
    let s = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
    for (let k = 0; k <= 4; k++) { const v = max * k / 4; s += `<line class="gridline" x1="${L}" x2="${W - 14}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`; }
    const step = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 80))));
    rows.forEach((r, i) => { if (i % step === 0) s += `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${UI.esc(String(r[0]).slice(0, 10))}</text>`; });
    s += `<polyline fill="none" stroke="${COLORS[0]}" stroke-width="2" points="${vals.map((v, i) => `${x(i)},${y(v)}`).join(' ')}"/>`;
    vals.forEach((v, i) => s += `<circle cx="${x(i)}" cy="${y(v)}" r="${n > 60 ? 1.5 : 3}" fill="${COLORS[0]}" data-tip="${UI.esc(`${rows[i][0]}: ${fmt(v)}`)}"/>`);
    el.innerHTML = s + '</svg>'; bindTips(el);
  }
  function render(el, w, res) {
    const s = spec(w);
    if (s.type === 'kpi') return kpi(el, res.rows, s);
    if (s.type === 'bar') return bar(el, res.rows);
    if (s.type === 'line') return line(el, res.rows);
    UI.dataTable(el, res.cols, res.rows, { max: 1000 });
  }

  return { AGGS, AGG_LABEL, NUMERIC, TYPES, CHARTS, spec, ready, query, render, q };
})();
