// BBChart: the billboard.js runtime every chart widget uses (Dashboard Studio, Widget Editor, Publish). Global: BBChart.
// Needs ui/js/vendor/d3.v7.min.js (global d3) and ui/js/vendor/billboard/billboard.min.js (global bb).
//
// A chart package's code.js is one call:
//   export default (data, ctx) => BBChart.render(data, ctx, { family: 'xy', type: 'line' });
//   data  rows keyed by input key (Widgets.load): x, y, y_1 ..., split, name, value ...
//   ctx   { width, height, settings, inputs, container, links, filter, static } (Widgets.draw / the studio)
//   spec  { family, type, options } - family = how rows become billboard data (below); type = data.type;
//         options = fixed billboard options for this chart (merged under the settings).
//
// Settings (settings.json): a path "bb.<billboard option path>" is that option as it is (e.g. bb.axis.x.tick.rotate);
// "dn.<name>" are ours (formats, theme, palette, stacking, reference lines, click to filter ...), turned into options here.
// Text values: '' = not set (billboard's default), a number in text = that number, 'None' on a pick = null.
//
// Data updates: a redraw with the same options (only the rows changed) calls chart.load(), so billboard animates the
// change (transition.duration); other changes rebuild the chart. A size change resizes it.
// Click to filter (dn.filter): a click on a point / bar / slice fires 'dn-filter' { input, values, state } from the chart
// (Ctrl / Shift click adds to the pick, a click on the only picked value clears it); the dashboard filters the linked
// containers. The picked values are dimmed-around and marked (x grid line) and come back on redraw (ctx.filter).
const BBChart = (() => {
  // ---------------- themes: one CSS file each, scoped to .bbt-<slug> so charts on one page can differ ----------------
  const THEMES = {
    'Data Noodler': '/ui/js/widgets/bb-themes/noodler.css',
    Billboard: '/ui/js/vendor/billboard/billboard.css',
    Dark: '/ui/js/vendor/billboard/theme/dark.css',
    Datalab: '/ui/js/vendor/billboard/theme/datalab.css',
    Graph: '/ui/js/vendor/billboard/theme/graph.css',
    Insight: '/ui/js/vendor/billboard/theme/insight.css',
    Modern: '/ui/js/vendor/billboard/theme/modern.css',
  };
  const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const themes = new Map();   // name -> Promise
  // Every selector gets the theme's scope class in front (".bb svg" -> ".bbt-dark .bb svg").
  function scope(css, cls) {
    css = css.replace(/\/\*[\s\S]*?\*\//g, '');
    let out = '', i = 0;
    while (i < css.length) {
      const open = css.indexOf('{', i); if (open < 0) break;
      const sel = css.slice(i, open).trim();
      let depth = 1, j = open + 1;
      while (j < css.length && depth) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
      const body = css.slice(open + 1, j - 1);
      if (sel.startsWith('@')) out += /^@(media|supports)/.test(sel) ? `${sel}{${scope(body, cls)}}` : `${sel}{${body}}`;
      else out += sel.split(',').map(x => `.${cls} ${x.trim()}`).join(', ') + `{${body}}`;
      i = j;
    }
    return out;
  }
  function theme(name) {
    if (!THEMES[name]) name = 'Data Noodler';
    if (!themes.has(name)) themes.set(name, fetch(THEMES[name]).then(r => { if (!r.ok) throw new Error(`Theme ${name}: ${r.status}`); return r.text(); }).then(css => {
      const id = `dn-bb-theme-${slug(name)}`;
      if (!document.getElementById(id)) document.head.append(Object.assign(document.createElement('style'), { id, textContent: scope(css, `bbt-${slug(name)}`) }));
      return `bbt-${slug(name)}`;
    }).catch(e => { themes.delete(name); throw e; }));
    return themes.get(name);
  }
  // The scoped CSS of the themes in use (Publish embeds it in the page).
  const css = () => [...document.querySelectorAll('style[id^="dn-bb-theme-"]')].map(s => s.textContent).join('\n') + '\n' + BASE_CSS;
  const BASE_CSS = '.dn-bb{width:100%;height:100%;position:relative;overflow:hidden}.dn-bb .bb{width:100%;height:100%}'
    + '.dn-bb .bb-xgrid-line.dn-pick line{stroke:var(--blue,#4269d0);stroke-width:2;stroke-dasharray:none;opacity:.8}'
    + '.dn-bb .bb-text.bb-empty{font-size:13px;fill:var(--muted,#888)}.dn-bb.is-empty .bb-axis,.dn-bb.is-empty .bb-legend-item,.dn-bb.is-empty .bb-grid{display:none}';

  // ---------------- palettes (dn.palette); 'Theme' = the theme's own pattern ----------------
  const PALETTES = {
    'Data Noodler': ['#4269d0', '#efb118', '#ff725c', '#6cc5b0', '#3ca951', '#ff8ab7', '#a463f2', '#97bbf5', '#9c6b4e', '#9498a0'],
    Billboard: ['#00c73c', '#fa7171', '#2ad0ff', '#7294ce', '#e3e448', '#cc7e6e', '#fb6ccf', '#c98dff', '#4aea99', '#bbbbbb'],
    'Category 10': ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'],
    'Tableau 10': ['#4e79a7', '#f28e2c', '#e15759', '#76b7b2', '#59a14f', '#edc949', '#af7aa1', '#ff9da7', '#9c755f', '#bab0ab'],
    'Dark 2': ['#1b9e77', '#d95f02', '#7570b3', '#e7298a', '#66a61e', '#e6ab02', '#a6761d', '#666666'],
    Pastel: ['#fbb4ae', '#b3cde3', '#ccebc5', '#decbe4', '#fed9a6', '#ffffcc', '#e5d8bd', '#fddaec', '#f2f2f2'],
    'Set 2': ['#66c2a5', '#fc8d62', '#8da0cb', '#e78ac3', '#a6d854', '#ffd92f', '#e5c494', '#b3b3b3'],
    Paired: ['#a6cee3', '#1f78b4', '#b2df8a', '#33a02c', '#fb9a99', '#e31a1c', '#fdbf6f', '#ff7f00', '#cab2d6', '#6a3d9a', '#ffff99', '#b15928'],
    Blues: ['#08306b', '#08519c', '#2171b5', '#4292c6', '#6baed6', '#9ecae1', '#c6dbef'],
    Greens: ['#00441b', '#006d2c', '#238b45', '#41ab5d', '#74c476', '#a1d99b', '#c7e9c0'],
    Warm: ['#6e40aa', '#bf3caf', '#fe4b83', '#ff7847', '#e2b72f', '#aff05b'],
    Cool: ['#6e40aa', '#4c6edb', '#23abd8', '#1ddfa3', '#52f667', '#aff05b'],
    Viridis: ['#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'],
    Traffic: ['#FF0000', '#F97600', '#F6C600', '#60B044'],
  };

  // ---------------- formats (the Formats settings: an example of how a value looks) ----------------
  const CASES = { 'CAPS': s => s.toUpperCase(), 'lower case': s => s.toLowerCase(),
    'Sentence case': s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(),
    'Title Case': s => s.toLowerCase().replace(/(^|[\s\-_/(])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()) };
  const DATES = { '2026-01-31': '%Y-%m-%d', '01/31/2026': '%m/%d/%Y', '31/01/2026': '%d/%m/%Y', 'Jan 31, 2026': '%b %-d, %Y', '31 Jan 2026': '%-d %b %Y',
    'January 31, 2026': '%B %-d, %Y', 'Jan 2026': '%b %Y', 'January 2026': '%B %Y', 'Jan': '%b', 'January': '%B', '2026': '%Y', 'Mon': '%a', 'Monday': '%A' };
  const SCALE = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
  function compact(v, dec = 1, unit = null, cur = '') {
    const a = Math.abs(v), u = unit || (a >= 1e12 ? 'T' : a >= 1e9 ? 'B' : a >= 1e6 ? 'M' : 'K'), f = 10 ** dec;
    const n = Math.trunc(v / SCALE[u] * f) / f;
    return (n < 0 ? '-' : '') + cur + Math.abs(n).toFixed(dec) + u;
  }
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
  const utc = d => new Date(d.getTime() + d.getTimezoneOffset() * 6e4);   // a UTC date shown as its own calendar day
  // spec = the setting, kind = 'number' | 'date' | 'text'. Returns a function, or undefined for billboard's own (Auto).
  function fmt(spec, kind) {
    spec = spec || 'Auto';
    if (kind === 'number') {
      if (spec === 'Auto') return v => typeof v !== 'number' ? v : Math.abs(v) >= 1e4 ? compact(v, 1) : d3.format(',~f')(+v.toFixed(2));
      if (spec === 'None') return v => String(v);
      const f = numberFmt(spec); return v => typeof v === 'number' ? f(v) : v;
    }
    if (kind === 'date') {
      const toD = v => v instanceof Date ? v : new Date(v);
      if (spec === 'None') return v => toD(v).toISOString().slice(0, 10);
      if (/^Q1/.test(spec)) return v => { const t = toD(v); return `Q${Math.floor(t.getUTCMonth() / 3) + 1} ${t.getUTCFullYear()}`; };
      const f = d3.utcFormat(DATES[spec === 'Auto' ? 'Jan 31, 2026' : spec] || '%b %-d, %Y');
      return v => { const t = toD(v); return isNaN(t) ? String(v) : f(t); };
    }
    if (spec === 'None') return v => String(v ?? '');
    const f = CASES[spec === 'Auto' ? 'Title Case' : spec] || (s => s); return v => f(String(v ?? ''));
  }

  // ---------------- helpers ----------------
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
  // Settings values -> option values: '' / 'Auto' / undefined dropped, 'None' -> null, numbers in text -> numbers.
  function clean(o) {
    if (Array.isArray(o)) return o.map(clean);
    if (!isObj(o)) {
      if (o === '' || o === 'Auto' || o === undefined) return undefined;
      if (o === 'None') return null;
      if (typeof o === 'string' && /^-?\d+(\.\d+)?$/.test(o.trim())) return +o;
      return o;
    }
    const out = {};
    for (const [k, v] of Object.entries(o)) { const c = clean(v); if (c !== undefined && !(isObj(c) && !Object.keys(c).length)) out[k] = c; }
    return out;
  }
  function merge(a, b) {   // b over a, deep
    if (!isObj(a) || !isObj(b)) return b === undefined ? a : b;
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = merge(a[k], v);
    return out;
  }
  const get = (o, p) => String(p).split('.').reduce((a, k) => a == null ? a : a[k], o);
  function set(o, p, v) { const ks = String(p).split('.'); let a = o; for (const k of ks.slice(0, -1)) { if (!isObj(a[k])) a[k] = {}; a = a[k]; } a[ks[ks.length - 1]] = v; }
  const num = v => v == null || v === '' ? null : Number.isFinite(+v) ? +v : null;
  const kindOf = vals => { const v = vals.find(x => x != null && x !== ''); return v instanceof Date ? 'date' : typeof v === 'number' ? 'number' : 'text'; };
  const list = s => String(s ?? '').split(/[;\n]/).map(x => x.trim()).filter(Boolean);
  const val = v => v instanceof Date ? v.getTime() : v;

  // Series name of an input: the field it is linked to (Y Axis = BALANCE), unique.
  function namer(ctx) {
    const used = new Map();
    return (key, label) => {
      let n = ctx.links?.[key]?.col || label || key;
      const c = used.get(n) || 0; used.set(n, c + 1);
      return c ? `${n} (${c + 1})` : n;
    };
  }
  const measureKeys = (ctx, base) => (ctx.inputs || []).filter(i => i.key === base || i.base === base).map(i => i.key);
  const inputLabel = (ctx, key) => (ctx.inputs || []).find(i => i.key === key)?.label || key;

  // ---------------- data: rows -> billboard data, by family ----------------
  // Every builder returns { data: {...}, xKind, filterKey, xs: [x values] } (filterKey = the input a click filters on).
  const FAMILY = {
    // X (dimension) + Y (measure, repeatable) + Split By (optional dimension: one series per value of it).
    xy(rows, ctx, S) {
      const name = namer(ctx), ys = measureKeys(ctx, 'y').filter(k => rows.some(r => r[k] != null));
      const xKind = kindOf(rows.map(r => r.x));
      const xs = [...new Map(rows.filter(r => r.x != null && r.x !== '').map(r => [val(r.x), r.x])).values()];
      if (xKind !== 'text' && S.dn.xSort !== false) xs.sort((a, b) => val(a) - val(b));
      const at = new Map(xs.map((x, i) => [val(x), i])), cols = [];
      if (rows.some(r => r.split != null)) {
        const ids = [...new Set(rows.map(r => r.split).filter(v => v != null).map(String))];
        const by = new Map(ids.map(id => [id, new Array(xs.length).fill(null)]));
        for (const r of rows) { const i = at.get(val(r.x)), v = num(r.y); if (i == null || r.split == null || v == null) continue; const a = by.get(String(r.split)); a[i] = (a[i] ?? 0) + v; }
        for (const id of ids) cols.push([id, ...by.get(id)]);
      } else {
        for (const k of ys) {
          const a = new Array(xs.length).fill(null);
          for (const r of rows) { const i = at.get(val(r.x)), v = num(r[k]); if (i != null && v != null) a[i] = (a[i] ?? 0) + v; }
          cols.push([name(k, inputLabel(ctx, k)), ...a]);
        }
      }
      return { data: { x: 'x', columns: [['x', ...xs], ...cols] }, xKind, filterKey: 'x', xs };
    },
    // X + one value array per point: range (High / Mid / Low), bar range (Start / End), candlestick (O / H / L / C).
    tuple(rows, ctx, S, spec) {
      const name = namer(ctx), xKind = kindOf(rows.map(r => r.x)), keys = spec.tuple;
      const ok = rows.filter(r => r.x != null && keys.filter(k => !spec.optional?.includes(k)).every(k => num(r[k]) != null));
      if (xKind !== 'text') ok.sort((a, b) => val(a.x) - val(b.x));
      const ids = ok.some(r => r.split != null) ? [...new Set(ok.map(r => String(r.split ?? '')))] : [null];
      const xs = [...new Map(ok.map(r => [val(r.x), r.x])).values()], at = new Map(xs.map((x, i) => [val(x), i]));
      const cols = ids.map(id => {
        const a = new Array(xs.length).fill(null);
        for (const r of ok) if (id === null || String(r.split ?? '') === id) a[at.get(val(r.x))] = tupleValue(r, keys);
        return [id ?? name(keys[0], spec.series || inputLabel(ctx, keys[0])), ...a];
      });
      return { data: { x: 'x', columns: [['x', ...xs], ...cols] }, xKind, filterKey: 'x', xs };
    },
    // X (number) + Y (number) per row, one series per Split By value; each series has its own x column.
    xyNum(rows, ctx, S) {
      const ok = rows.filter(r => num(r.x) != null && num(r.y) != null);
      const ids = ok.some(r => r.split != null) ? [...new Set(ok.map(r => String(r.split ?? '')))] : [namer(ctx)('y', inputLabel(ctx, 'y'))];
      const cols = [], xsMap = {};
      for (const id of ids) {
        let part = ids.length > 1 || ok.some(r => r.split != null) ? ok.filter(r => String(r.split ?? '') === id) : ok;
        if (S.dn.xSort !== false) part = [...part].sort((a, b) => num(a.x) - num(b.x));
        cols.push([`${id}__x`, ...part.map(r => num(r.x))], [id, ...part.map(r => num(r.y))]); xsMap[id] = `${id}__x`;
      }
      return { data: { xs: xsMap, columns: cols }, xKind: 'number', filterKey: 'split' };
    },
    // Name (dimension) + Value (measure): one series per name (pie, donut, polar, funnel, treemap, multi gauge).
    arc(rows, ctx, S) {
      let items = [];
      const at = new Map();
      for (const r of rows) {
        const n = r.name == null || r.name === '' ? '(blank)' : r.name instanceof Date ? fmt('Auto', 'date')(r.name) : String(r.name), v = num(r.value);
        if (v == null) continue;
        if (at.has(n)) at.get(n)[1] += v; else { const it = [n, v]; at.set(n, it); items.push(it); }
      }
      if (!rows.some(r => 'name' in r) && rows.length) items = [[namer(ctx)('value', inputLabel(ctx, 'value')), d3.sum(rows, r => num(r.value) || 0)]];
      const top = +S.dn.topN || 0;
      if (top > 0 && items.length > top) {
        const sorted = [...items].sort((a, b) => b[1] - a[1]), keep = sorted.slice(0, top), rest = d3.sum(sorted.slice(top), d => d[1]);
        items = items.filter(it => keep.includes(it)); if (rest) items.push([S.dn.otherLabel || 'Other', rest]);
      }
      return { data: { columns: items }, xKind: 'text', filterKey: 'name' };
    },
  };

  // One point's value for the tuple charts (billboard's own shapes for them).
  function tupleValue(r, keys) {
    const k = keys.join(',');
    if (k === 'high,mid,low') { const h = num(r.high), l = num(r.low), m = num(r.mid); return { high: h, mid: m ?? (h + l) / 2, low: l }; }
    if (k === 'open,high,low,close,volume') { const v = [num(r.open), num(r.high), num(r.low), num(r.close)]; if (num(r.volume) != null) v.push(num(r.volume)); return v; }
    return keys.map(x => num(r[x]));   // [start, end], [y, size]
  }

  // ---------------- options ----------------
  const PICK_NULL = v => v === 'None' ? null : v;
  function options(S, spec, built, ctx) {
    const dn = S.dn, mine = clean(S.bb || {}) || {};
    // Auto Padding: the padding settings are left out (the chart's own spec padding stays).
    if (dn.paddingAuto !== false && isObj(mine.padding)) { const m = mine.padding.mode; delete mine.padding; if (m) mine.padding = { mode: m }; }
    const o = merge(spec.options || {}, mine);
    const isXY = ['xy', 'tuple'].includes(spec.family), xKind = built.xKind;
    // data
    o.data = merge(o.data || {}, built.data);
    if (spec.type) o.data.type = spec.type;
    const ids = (built.data.columns || []).map(c => c[0]).filter(id => id !== 'x' && !String(id).endsWith('__x'));
    // Combination: a type per series (dn.types.s1 ...); Y2: series numbers on the right axis.
    if (spec.combo) o.data.types = Object.fromEntries(ids.map((id, i) => { const v = dn.types?.[`s${i + 1}`]; return [id, v && v !== 'Default' ? v : spec.type]; }));
    if (spec.typeFor) o.data.types = Object.fromEntries(ids.map(id => [id, spec.typeFor]));
    if (dn.y2Series) {
      const nums = String(dn.y2Series).split(/[,\s]+/).map(Number).filter(n => n >= 1);
      if (nums.length) { o.data.axes = Object.fromEntries(ids.map((id, i) => [id, nums.includes(i + 1) ? 'y2' : 'y'])); set(o, 'axis.y2.show', true); }
    }
    // Stacking: all series, or the groups typed in Stack Groups ("1, 2; 3, 4" = series numbers).
    if (dn.stackGroups) { const g = list(dn.stackGroups).map(x => x.split(/[,\s]+/).map(Number).filter(n => n >= 1 && n <= ids.length).map(n => ids[n - 1])).filter(x => x.length); if (g.length) o.data.groups = g; }
    else if (dn.stack) o.data.groups = [ids];
    // Formats: 'Auto' = billboard's own formatting (the same as its examples); anything else = that format.
    const F = (spec, kind) => !spec || spec === 'Auto' ? undefined : fmt(spec, kind);
    const str = f => f || (v => v == null ? '' : String(v));
    const fl = F(dn.fmtLabels, 'number');
    if (dn.labelsShow === false) o.data.labels = false;
    else if (dn.labelsShow) o.data.labels = merge(isObj(o.data.labels) ? o.data.labels : {}, fl ? { format: fl } : {});
    if (dn.labelsShow && dn.labelColor) set(o, 'data.labels.colors', dn.labelColor);
    if (isObj(o.data.labels) && !Object.keys(o.data.labels).length) o.data.labels = true;
    if (dn.dashFrom !== undefined && dn.dashFrom !== '' && isXY) { const s = num(dn.dashFrom); if (s != null) o.data.regions = Object.fromEntries(ids.map(id => [id, [{ start: s, style: { dasharray: '6 2' } }]])); }
    if (dn.order) o.data.order = PICK_NULL(dn.order);
    // x axis type: auto from the data (dates -> timeseries, numbers -> indexed, text -> category)
    if (isXY || spec.family === 'xyNum') {
      const t = dn.xType && dn.xType !== 'Auto' ? dn.xType.toLowerCase() : xKind === 'date' ? 'timeseries' : xKind === 'number' ? 'indexed' : 'category';
      if (spec.type !== 'radar') set(o, 'axis.x.type', t);
      const xk = t === 'timeseries' ? 'date' : t === 'category' ? 'text' : 'number';
      // Dates in Auto: YYYY-MM-DD as in billboard's timeseries example (the data's dates are UTC days).
      const fx = F(dn.fmtX, xk) || (xk === 'date' ? fmt('2026-01-31', 'date') : undefined), title = fx;
      if (fx && spec.type !== 'radar') set(o, 'axis.x.tick.format', t === 'category' ? (i, c) => fx(c ?? built.xs?.[i] ?? i) : fx);
      if (title) set(o, 'tooltip.format.title', x => t === 'category' ? title(built.xs?.[x] ?? x) : title(x));
      const xc = get(o, 'axis.x.tick.culling');
      set(o, 'axis.x.tick.culling', dn.xCulling === false ? false : { ...(isObj(xc) ? xc : {}) });
    }
    // y / y2 tick formats, tooltip value, legend names, levels
    const fy = F(dn.fmtY, 'number'), fy2 = F(dn.fmtY2, 'number') || fy, ft = F(dn.fmtTooltip, 'number') || fy;
    if (fy) set(o, 'axis.y.tick.format', fy);
    if (fy2) set(o, 'axis.y2.tick.format', fy2);
    for (const ax of ['y', 'y2']) { const c = get(o, `axis.${ax}.tick.culling`); set(o, `axis.${ax}.tick.culling`, dn[`${ax}Culling`] ? { ...(isObj(c) ? c : {}) } : false); }
    const pct = d3.format('.1%');
    if (ft || dn.tooltipPercent === false || spec.family === 'tuple') {
      const f = str(ft);
      set(o, 'tooltip.format.value', (v, ratio) => {
        if (Array.isArray(v)) return v.map(f).join(' / ');
        if (isObj(v)) return Object.entries(v).map(([k, x]) => `${k} ${f(x)}`).join(', ');
        return ratio != null && dn.tooltipPercent !== false && ['pie', 'donut', 'gauge', 'polar', 'treemap'].includes(spec.type) ? `${pct(ratio)}` : f(v);
      });
    }
    if (dn.fmtLegend && dn.fmtLegend !== 'Auto') { const fg = fmt(dn.fmtLegend, 'text'); set(o, 'legend.format', id => fg(id)); }
    if (fy && spec.type === 'radar') set(o, 'radar.level.text.format', fy);
    if (fy && spec.type === 'polar') set(o, 'polar.level.text.format', fy);
    // Arc / treemap labels: what each piece shows (billboard's default = the percent; a treemap's = name + percent).
    for (const shape of ['pie', 'donut', 'gauge', 'polar', 'treemap']) {
      if (spec.type !== shape) continue;
      const what = dn.arcLabel || (shape === 'treemap' ? 'Name + Percent' : 'Percent'), fv = str(fl || fy);
      if (!fl && (what === 'Percent' && shape !== 'gauge' || what === 'Name + Percent' && shape === 'treemap')) continue;   // billboard's own label
      set(o, `${shape}.label.format`, (v, ratio, id) => {
        const p = ratio == null ? '' : pct(ratio);
        return { Percent: p, Value: fv(v), Name: id, 'Name + Percent': `${id}\n${p}`, 'Name + Value': `${id}\n${fv(v)}`, 'Value + Percent': `${fv(v)}\n${p}` }[what] ?? p;
      });
    }
    if (spec.type === 'funnel') {
      const what = dn.arcLabel || 'Name', fv = str(fl || fy);
      if (dn.labelsShow !== false) o.data.labels = merge(isObj(o.data.labels) ? o.data.labels : {}, { format: (v, id) => ({ Value: fv(v), Name: id, 'Name + Value': `${id}\n${fv(v)}` }[what] ?? id) });
    }
    // colours: palette (or the theme's own), custom colours first, thresholds
    const custom = Object.values(dn.colors || {}).filter(Boolean);
    const pal = dn.palette && dn.palette !== 'Theme' ? PALETTES[dn.palette] || [] : [];
    if (custom.length || pal.length) set(o, 'color.pattern', [...custom, ...pal.slice(custom.length)]);
    if (dn.thresholds) { const v = String(dn.thresholds).split(/[,\s]+/).map(Number).filter(Number.isFinite); if (v.length) set(o, 'color.threshold', { values: v, unit: dn.thresholdUnit === 'Percentage' ? 'percentage' : 'value', ...(get(o, 'color.threshold.max') != null ? { max: get(o, 'color.threshold.max') } : {}) }); }
    // reference lines and regions (text lists "value: label")
    const lines = (s, kind) => list(s).map(x => { const [v, ...t] = x.split(':'); const value = kind === 'date' ? new Date(v.trim()) : num(v) ?? v.trim(); return { value, text: t.join(':').trim(), position: 'end' }; });
    if (dn.xLines) set(o, 'grid.x.lines', lines(dn.xLines, xKind));
    if (dn.yLines) set(o, 'grid.y.lines', lines(dn.yLines, 'number'));
    if (dn.regions) set(o, 'regions', list(dn.regions).map(x => { const [a, b] = x.split(/\s+to\s+|\s*\.\.\s*/); const c = v => v == null || v.trim() === '' ? undefined : xKind === 'date' ? new Date(v.trim()) : num(v) ?? v.trim(); return { axis: dn.regionsAxis === 'Y' ? 'y' : 'x', start: c(a), end: c(b) }; }));
    if (dn.tickValues) { const v = String(dn.tickValues).split(/[,\s]+/).map(x => xKind === 'date' ? new Date(x) : num(x) ?? x).filter(x => x != null && x !== ''); if (v.length) set(o, 'axis.x.tick.values', v); }
    if (dn.yTickValues) { const v = String(dn.yTickValues).split(/[,\s]+/).map(num).filter(x => x != null); if (v.length) set(o, 'axis.y.tick.values', v); }
    if (isObj(o.padding) && !Object.keys(o.padding).length) delete o.padding;
    if (dn.tooltipShow === false) set(o, 'tooltip.show', false);
    if (dn.legendShow === false) set(o, 'legend.show', false);
    // pie inner radius as a share of the radius (donut-like pie)
    if (spec.type === 'pie' && dn.innerRatio) set(o, 'pie.innerRadius', { ratio: dn.innerRatio / 100 });
    if (dn.cornerRatio && ['pie', 'donut', 'gauge'].includes(spec.type)) set(o, 'arc.cornerRadius', { ratio: dn.cornerRatio / 100 });
    if (dn.barRadius && /bar/.test(spec.type || '') || dn.barRadius && spec.combo) set(o, 'bar.radius', { ratio: dn.barRadius / 100 });
    if (dn.funnelNeckW || dn.funnelNeckH) { set(o, 'funnel.neck.width', { ratio: (dn.funnelNeckW || 0) / 100 }); set(o, 'funnel.neck.height', { ratio: (dn.funnelNeckH || 0) / 100 }); }
    // On / off for options that are either false or an object (dn.on.pie_label_line = pie.label.line ...).
    for (const [k, on] of Object.entries(dn.on || {})) {
      const p = k.replace(/_/g, '.'), cur = get(o, p);
      const parent = p.includes('.') ? get(o, p.slice(0, p.lastIndexOf('.'))) : o;
      if (on === false) { if (isObj(parent)) set(o, p, false); }   // never creates its parent (data.labels.border off must not turn labels on)
      else if (on && !isObj(cur)) set(o, p, true);
    }
    if (dn.labelsShow && !dn.on?.data_labels_border && isObj(o.data.labels)) delete o.data.labels.border;
    if (dn.rangeTextValues) { const v = String(dn.rangeTextValues).split(/[,\s]+/).map(Number).filter(Number.isFinite); if (v.length) set(o, 'arc.rangeText.values', v); }
    if (get(o, 'bar.connectLine') === null) set(o, 'bar.connectLine', false);
    if (get(o, 'tooltip.order') === null) delete o.tooltip.order;
    if (dn.noAnimation || ctx.static) set(o, 'transition.duration', 0);
    if (dn.subchart === false) set(o, 'subchart.show', false);
    return o;
  }

  // Configuration without the data (functions as their text): equal = only the rows changed -> chart.load().
  const signature = o => JSON.stringify({ ...o, data: { ...o.data, columns: undefined, x: undefined, xs: undefined, labels: o.data?.labels ? String(o.data.labels.format || o.data.labels) : o.data?.labels }, size: undefined, bindto: undefined },
    (k, v) => typeof v === 'function' ? String(v) : v instanceof Date ? v.toISOString() : v);

  // ---------------- render ----------------
  async function render(data, ctx = {}, spec = {}) {
    if (typeof bb === 'undefined') throw new Error('billboard.js is not loaded (ui/js/vendor/billboard/billboard.min.js).');
    const S = { bb: ctx.settings?.bb || {}, dn: ctx.settings?.dn || {} };
    const themeCls = await theme(S.dn.theme || 'Data Noodler');
    if (!document.getElementById('dn-bb-base')) document.head.append(Object.assign(document.createElement('style'), { id: 'dn-bb-base', textContent: BASE_CSS }));
    const host = ctx.container;
    // The chart's own root: reused while it is the same kind of chart (so data changes animate).
    let root = host?.firstElementChild?.classList?.contains('dn-bb') ? host.firstElementChild : null;
    if (root && root._bbKind !== `${spec.family}:${spec.type}`) { try { root._bb?.destroy(); } catch {} root = null; }
    if (!root) {
      root = document.createElement('div'); root.className = 'dn-bb'; root._bbKind = `${spec.family}:${spec.type}`;
      if (host) host.replaceChildren(root);
    }
    root.className = `dn-bb ${themeCls}`;
    const rows = (Array.isArray(data) ? data : []).filter(Boolean);
    const built = (FAMILY[spec.family] || FAMILY.xy)(rows, ctx, S, spec);
    const o = options(S, spec, built, ctx);
    const empty = !(built.data.columns || []).some(c => c.length > 1 && c[0] !== 'x' && !String(c[0]).endsWith('__x'));
    if (empty) set(o, 'data.empty.label.text', S.dn.emptyText || spec.empty || 'Drop fields on Settings > Data');
    root.classList.toggle('is-empty', empty);
    const width = Math.max(40, Math.floor(ctx.width || host?.clientWidth || 400)), height = Math.max(40, Math.floor(ctx.height || host?.clientHeight || 300));
    // Size: the container's (we resize on redraw); a published chart scales with its card (viewBox).
    o.size = { width, height }; o.resize = ctx.static ? { auto: 'viewBox' } : { auto: false };
    // ---- click to filter ----
    const pick = new Set((ctx.filter?.state?.pick || []).map(String));
    const key = built.filterKey, canFilter = S.dn.filter !== false && key && rows.some(r => r[key] != null) && !ctx.static;
    const valueOf = d => {
      if (key === 'name' || key === 'split') return d.id;
      const x = built.xs ? built.xs[typeof d.index === 'number' ? d.index : d.x] ?? d.x : d.x;
      return x;
    };
    const keyOf = v => String(v instanceof Date ? v.getTime() : v);
    // The picked values keep their colour, the rest fade; on an x axis a line marks each picked x.
    const userLines = get(o, 'grid.x.lines') || [];
    const marks = () => key === 'x' && built.xs ? built.xs.map((x, i) => [x, i]).filter(([x]) => pick.has(keyOf(x)))
      .map(([x, i]) => ({ value: get(o, 'axis.x.type') === 'category' ? i : x, class: 'dn-pick' })) : [];
    if (canFilter || pick.size) {
      const fade = c => { const k = d3.color(c); if (!k) return c; k.opacity = 0.3; return k.formatRgb(); };
      const prev = o.data.color;
      o.data.color = (c, d) => {
        c = prev ? prev(c, d) : c;
        if (!pick.size) return c;
        if (!d || typeof d !== 'object') return (key === 'name' || key === 'split') && typeof d === 'string' && !pick.has(d) ? fade(c) : c;
        return pick.has(keyOf(valueOf(d))) ? c : fade(c);
      };
      set(o, 'grid.x.lines', [...userLines, ...marks()]);
    }
    if (canFilter) {
      const userClick = o.data.onclick;
      o.data.onclick = function (d, el) {
        userClick?.call(this, d, el);
        const v = valueOf(d); if (v == null) return;
        const k = keyOf(v), ev = window.event || {}, add = ev.ctrlKey || ev.metaKey || ev.shiftKey;
        if (add) { pick.has(k) ? pick.delete(k) : pick.add(k); }
        else if (pick.size === 1 && pick.has(k)) pick.clear();
        else { pick.clear(); pick.add(k); }
        const vals = [], seen = new Set();
        for (const r of rows) { const rv = key === 'name' || key === 'split' ? String(r[key] instanceof Date ? fmt('Auto', 'date')(r[key]) : r[key]) : r[key]; if (rv == null) continue; const rk = keyOf(key === 'name' || key === 'split' ? rv : r[key]); if (pick.has(rk) && !seen.has(rk)) { seen.add(rk); vals.push(key === 'name' || key === 'split' ? r[key] : r[key]); } }
        root.dispatchEvent(new CustomEvent('dn-filter', { bubbles: true, detail: { input: key, values: vals, state: { pick: [...pick] } } }));
        try { if (key === 'x') root._bb.xgrids([...userLines, ...marks()]); root._bb.flush(); } catch {}
      };
    }
    // ---- reuse (animated data change) or build ----
    const sig = signature(o), chart = root._bb;
    if (chart && root._sig === sig && !ctx.static) {
      try {
        const next = new Set(o.data.columns.map(c => String(c[0]))), gone = (root._ids || []).filter(id => !next.has(id));
        if (root._w !== width || root._h !== height) chart.resize({ width, height });
        // One load at a time: a load started while another animates would leave its points behind; the newest waits.
        // (billboard 4.1.0 skips a load given an empty unload list: only series that went away are passed)
        const args = { columns: o.data.columns, ...(o.data.xs ? { xs: o.data.xs } : {}), ...(gone.length ? { unload: gone } : {}), ...(o.data.types && Object.keys(o.data.types).length ? { types: o.data.types } : {}) };
        const run = a => {
          root._busy = true;
          let t = 0; const fin = () => { clearTimeout(t); if (!root._busy) return; root._busy = false; const nx = root._next; root._next = null; if (nx) run(nx); };
          t = setTimeout(fin, (get(o, 'transition.duration') ?? 250) + 800);   // never stuck if billboard skips done
          chart.load({ ...a, done: fin });
        };
        if (root._busy) root._next = args; else run(args);
        root._ids = [...next]; root._w = width; root._h = height; root._rows = rows;
        return root;
      } catch { /* rebuild below */ }
    }
    try { chart?.destroy(); } catch {}
    root.replaceChildren();
    const el = document.createElement('div'); root.append(el);
    o.bindto = el;
    let done;
    const rendered = new Promise(r => { done = r; });
    const userRendered = o.onrendered;
    o.onrendered = function () { userRendered?.call(this); done(); };
    if (!host) document.body.append(root);   // billboard measures text: the chart must be in the page while it is built
    root._bb = bb.generate(o);
    root._sig = sig; root._ids = o.data.columns.map(c => String(c[0])); root._w = width; root._h = height; root._rows = rows;
    if (ctx.static) { await Promise.race([rendered, new Promise(r => setTimeout(r, 400))]); await new Promise(r => setTimeout(r, 30)); }
    if (!host) root.remove();
    return root;
  }

  return { render, theme, css, scope, fmt, THEMES: Object.keys(THEMES), PALETTES: Object.keys(PALETTES), FAMILY };
})();
