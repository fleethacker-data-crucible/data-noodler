// Widget packages (widgets/<id>/widget.json + spec.json) drawn with ApexCharts / ApexGrid / ApexTree
// (js/widgets/apex-render.js). Globals: ApexWidget, WidgetRegistry. Needs the Apex libraries and js/dn-fs.js.
//   "$kind" in spec.json: 'apexcharts' | 'apexgrid' | 'apextree' (default: apexcharts).
//
// spec.json (the default look; never holds query data): an Apex options object, plus
//   "data":  [{ key, label, role: 'dimension' | 'measure' | 'fields', agg, optional }] (optional; default inputs per chart type)
//   "query": { sort: 'desc' | 'asc' | 'label', top } (optional): default order / number of categories
// Manifest (widget.json): { id, name, description, version, kind, spec, inputs, options }
//   options: [{ path, label, group, type: 'color' | 'number' | 'boolean' | 'select' | 'text', default, min, max, step, choices, show }]
// Dashboard widget using a package: { id, type: 'widget', pkg, title, dataset, x, y, w, h,
//   inputs: { <key>: { col, agg } }, opts: { <path>: value }, sort, top, limit }
const ApexWidget = (() => {
  const AGGS = ['count', 'count_distinct', 'sum', 'avg', 'median', 'min', 'max', 'none'];
  const AGG_LABEL = { count: 'Count', count_distinct: 'Count distinct', sum: 'Sum', avg: 'Average', median: 'Median', min: 'Min', max: 'Max', none: 'No aggregation' };
  const KINDS = { apexcharts: 'ApexCharts', apexgrid: 'ApexGrid', apextree: 'ApexTree', filter: 'Filter' };   // filter: drawn by the Dashboard (dropdowns)
  const APEX = new Set(['apexcharts', 'apexgrid', 'apextree']);

  // ---- option detection: every colour / number / switch / known choice / text in the spec becomes an option ----
  const COLOR_KEYS = /^(fill|stroke|color|background|\w+Color)$/;
  const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  const CHANNELS = new Set(['x', 'y', 'x1', 'x2', 'y1', 'y2', 'fill', 'stroke', 'r', 'z', 'text', 'title', 'fx', 'fy', 'fillOpacity', 'strokeOpacity', 'opacity', 'symbol', 'href', 'length', 'rotate', 'weight']);
  const TEXT_KEYS = /^(label|title|subtitle|caption|text|fontFamily|fontWeight|format|tickFormat|centerLabel|rootName|name|headerText|fontSize|borderRadius)$/;
  const SIZE_TEXT = /^-?\d+(\.\d+)?(%|px|em)$/;   // '65%', '12px' (Apex sizes)
  const SKIP = new Set(['data', 'query', 'domain', 'range', 'ticks', 'style', 'className', 'transform', '$kind', 'sampleData']);
  // Apex specs: the pasted demo data and callbacks are not options.
  const APEX_SKIP = new Set(['series', 'labels', 'categories', 'formatter', 'events', 'locales', 'id', 'group', 'width', 'height', 'nodeTemplate', 'tooltipTemplate', 'a11y', 'containerClassName', 'annotations']);
  const ENUMS = {
    curve: ['smooth', 'straight', 'stepline', 'monotoneCubic', 'linear'],
    type: ['linear', 'log', 'sqrt', 'pow', 'symlog', 'time', 'utc', 'band', 'point', 'ordinal', 'categorical', 'sequential', 'diverging', 'threshold', 'quantile', 'quantize'],
    scheme: ['observable10', 'tableau10', 'category10', 'set2', 'dark2', 'pastel1', 'blues', 'greens', 'oranges', 'reds', 'purples', 'greys', 'viridis', 'magma', 'inferno', 'plasma', 'turbo', 'cividis', 'ylgnbu', 'ylorrd', 'rdbu', 'rdylgn', 'spectral', 'piyg', 'brbg'],
    anchor: ['top', 'right', 'bottom', 'left', 'middle'], textAnchor: ['start', 'middle', 'end'], lineAnchor: ['top', 'middle', 'bottom'],
    frameAnchor: ['middle', 'top', 'right', 'bottom', 'left', 'top-left', 'top-right', 'bottom-left', 'bottom-right'], symbol: ['circle', 'square', 'diamond', 'triangle', 'cross', 'star', 'wye', 'plus', 'times', 'asterisk'],
    labelAnchor: ['left', 'center', 'right', 'top', 'bottom'], labelArrow: ['auto', 'up', 'down', 'left', 'right', 'none'], sort: ['ascending', 'descending'],
    'chart.type': ['line', 'area', 'bar', 'pie', 'donut', 'radialBar', 'scatter', 'bubble', 'heatmap', 'candlestick', 'boxPlot', 'radar', 'polarArea', 'rangeBar', 'rangeArea', 'treemap'],
    position: ['top', 'right', 'bottom', 'left', 'center', 'front', 'back'], horizontalAlign: ['left', 'center', 'right'], align: ['left', 'center', 'right'],
    shape: ['circle', 'square', 'rect', 'line', 'flat', 'round'], lineCap: ['butt', 'square', 'round'], stackType: ['normal', '100%'], mode: ['light', 'dark'],
    palette: ['palette1', 'palette2', 'palette3', 'palette4', 'palette5', 'palette6', 'palette7', 'palette8', 'palette9', 'palette10'],
    direction: ['top', 'bottom', 'left', 'right'], edgeStyle: ['orthogonal', 'curved', 'straight'], borderStyle: ['solid', 'dashed', 'dotted', 'none'],
  };
  const NUM = { opacity: [0, 1, 0.05], fillOpacity: [0, 1, 0.05], strokeOpacity: [0, 1, 0.05], strokeWidth: [0, 20, 0.5], r: [0, 60, 0.5], rx: [0, 30, 1], ry: [0, 30, 1],
    inset: [0, 20, 0.5], insetLeft: [0, 20, 0.5], insetRight: [0, 20, 0.5], insetTop: [0, 20, 0.5], insetBottom: [0, 20, 0.5], padding: [0, 1, 0.05], tickRotate: [-90, 90, 5],
    marginLeft: [0, 300, 1], marginRight: [0, 300, 1], marginTop: [0, 300, 1], marginBottom: [0, 300, 1], fontSize: [6, 48, 1], ticks: [0, 30, 1], thresholds: [1, 200, 1],
    innerRadius: [0, 0.95, 0.01], padAngle: [0, 0.2, 0.005], cornerRadius: [0, 30, 1], startAngle: [-360, 360, 5], endAngle: [-360, 360, 5], labelRadius: [0, 1.5, 0.01], dx: [-50, 50, 1], dy: [-50, 50, 1] };

  const split = p => p.split('.').map(k => /^\d+$/.test(k) ? +k : k);
  const getAt = (o, p) => split(p).reduce((a, k) => a == null ? undefined : a[k], o);
  function setAt(o, p, v) {
    const ks = split(p); let a = o;
    for (let i = 0; i < ks.length - 1; i++) { if (a[ks[i]] == null || typeof a[ks[i]] !== 'object') a[ks[i]] = typeof ks[i + 1] === 'number' ? [] : {}; a = a[ks[i]]; }
    if (v === undefined) delete a[ks[ks.length - 1]]; else a[ks[ks.length - 1]] = v;
  }
  const clone = o => JSON.parse(JSON.stringify(o));
  const kindOf = spec => KINDS[spec?.$kind] ? spec.$kind : 'apexcharts';
  const isApex = k => APEX.has(k);
  function human(p, spec) {
    const k = split(p);
    return k.join(' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());
  }
  function groupOf(p, spec) {
    const k = split(p);
    if (k.length > 1) return { x: 'X axis', y: 'Y axis', fx: 'Facet X', fy: 'Facet Y', color: 'Color', r: 'Size' }[k[0]] || k[0].replace(/^./, c => c.toUpperCase());
    return 'General';
  }
  // Apex specs without a "data" list get the usual inputs for their chart type.
  function defaultInputs(kind, spec) {
    const D = (key, label, o = {}) => ({ key, label, role: 'dimension', ...o }), M = (key, label, agg = 'sum') => ({ key, label, role: 'measure', agg });
    if (kind === 'apexgrid') return [{ key: 'fields', label: 'Fields', role: 'fields' }];
    if (kind === 'apextree') return [D('l1', 'Level 1'), D('l2', 'Level 2', { optional: true }), D('l3', 'Level 3', { optional: true }), M('value', 'Value', 'count')];
    const t = spec?.chart?.type || 'line';
    if (['pie', 'donut', 'polarArea', 'radialBar'].includes(t)) return [D('category', 'Slices'), M('value', 'Value')];
    if (t === 'heatmap') return [D('category', 'X axis'), D('series', 'Y axis'), M('value', 'Value')];
    if (t === 'scatter') return [M('x', 'X', 'none'), M('y', 'Y', 'none'), D('series', 'Series', { optional: true })];
    if (t === 'bubble') return [M('x', 'X', 'none'), M('y', 'Y', 'none'), M('z', 'Size', 'none'), D('series', 'Series', { optional: true })];
    if (t === 'candlestick') return [D('x', 'Date'), M('open', 'Open', 'none'), M('high', 'High', 'none'), M('low', 'Low', 'none'), M('close', 'Close', 'none')];
    if (t === 'boxPlot') return [D('x', 'Group'), ...['min', 'q1', 'median', 'q3', 'max'].map(k => M(k, k.toUpperCase(), 'none'))];
    if (t === 'rangeBar') return [D('category', 'Row'), M('start', 'Start', 'none'), M('end', 'End', 'none'), D('series', 'Series', { optional: true })];
    return [D('category', 'Category'), D('series', 'Series', { optional: true }), M('value', 'Value')];
  }
  function detect(spec) {
    spec = clone(spec);
    const kind = kindOf(spec), list = Array.isArray(spec.data) ? spec.data : defaultInputs(kind, spec);
    const inputs = list.filter(i => i && i.key).map(i => ({ label: i.key, role: 'dimension', ...i, agg: i.role === 'measure' ? i.agg || 'sum' : undefined }));
    const keys = new Set(inputs.map(i => i.key)), options = [];
    const walk = (node, path, key, inMark) => {
      if (node == null) return;
      if (Array.isArray(node)) return node.forEach((v, i) => walk(v, path ? `${path}.${i}` : String(i), key, inMark));
      if (typeof node === 'object') { for (const [k, v] of Object.entries(node)) if (!SKIP.has(k) && !APEX_SKIP.has(k)) walk(v, path ? `${path}.${k}` : k, k, inMark); return; }
      if (typeof node === 'string' && keys.has(node) && (CHANNELS.has(key) || inMark)) return;   // a channel bound to a data input
      const base = { path, label: human(path, spec), group: groupOf(path, spec), default: node, show: true };
      if (typeof node === 'string' && (HEX.test(node) || COLOR_KEYS.test(key) && !keys.has(node))) options.push({ ...base, type: 'color' });
      else if (typeof node === 'string' && ENUMS[path === 'chart.type' ? path : key]) options.push({ ...base, type: 'select', choices: [...new Set([node, ...ENUMS[path === 'chart.type' ? path : key]])] });
      else if (typeof node === 'string' && (TEXT_KEYS.test(key) || SIZE_TEXT.test(node))) options.push({ ...base, type: 'text' });
      else if (typeof node === 'number') { const [min, max, step] = NUM[key] || [Math.min(0, node), Math.max(100, Math.abs(node) * 4), Number.isInteger(node) ? 1 : 0.1]; options.push({ ...base, type: 'number', min, max, step }); }
      else if (typeof node === 'boolean') options.push({ ...base, type: 'boolean' });
    };
    for (const [k, v] of Object.entries(spec)) if (!SKIP.has(k) && !APEX_SKIP.has(k)) walk(v, k, k, false);
    return { kind, spec, inputs, options };
  }
  // Keep what the user set (labels, show, groups, aggregations) for options / inputs that still exist after an edit.
  function merge(old, fresh) {
    if (!old) return fresh;
    const op = new Map((old.options || []).map(o => [o.path, o])), ip = new Map((old.inputs || []).map(i => [i.key, i]));
    fresh.options = fresh.options.map(o => op.has(o.path) ? { ...o, label: op.get(o.path).label, show: op.get(o.path).show, group: op.get(o.path).group } : o);
    fresh.inputs = fresh.inputs.map(i => ip.has(i.key) && ip.get(i.key).role === i.role ? { ...i, label: ip.get(i.key).label, agg: ip.get(i.key).agg ?? i.agg } : i);
    return fresh;
  }

  // ---- data ----
  const alias = i => 'v_' + i.key;
  const binding = (m, w, i) => ({ col: '', agg: i.agg, ...(w.inputs?.[i.key] || {}) });
  const inputsOf = m => m.inputs || [];
  const dimsOf = m => inputsOf(m).filter(i => i.role === 'dimension');
  const fieldsOf = m => inputsOf(m).find(i => i.role === 'fields');
  const hasTop = m => dimsOf(m).length > 0 && inputsOf(m).some(i => i.role === 'measure' && i.agg !== 'none');
  const sortOf = (m, w) => w.sort || m.specJson?.query?.sort || 'desc';
  const topOf = (m, w) => +w.top || +m.specJson?.query?.top || 20;
  function ready(m, w) {
    if (!w.dataset) return false;
    if (m.kind === 'filter') return true;
    return inputsOf(m).every(i => { const b = binding(m, w, i); return i.role === 'fields' ? !!b.cols?.length : i.optional || b.col || (i.role === 'measure' && b.agg === 'count'); });
  }
  const isRaw = (m, w) => !!fieldsOf(m) || !inputsOf(m).some(i => i.role === 'measure') || inputsOf(m).some(i => i.role === 'measure' && binding(m, w, i).agg === 'none');
  function query(m, w) {
    const ins = inputsOf(m), where = w.where?.trim() || undefined, limit = 200000;   // no row setting: everything the engine returns (its maximum)
    if (fieldsOf(m)) return { dataset: w.dataset, select: binding(m, w, fieldsOf(m)).cols, where, limit };
    if (isRaw(m, w)) return { dataset: w.dataset, select: [...new Set(ins.map(i => binding(m, w, i).col).filter(Boolean))], where, limit };
    const dims = [...new Set(dimsOf(m).map(i => binding(m, w, i).col).filter(Boolean))];
    const aggregate = ins.filter(i => i.role === 'measure').map(i => { const b = binding(m, w, i); return { function: b.agg || 'count', column: b.col || undefined, as: alias(i) }; });
    if (!dims.length) return { dataset: w.dataset, aggregate, where };
    if (dims.length > 1) return { dataset: w.dataset, groupBy: dims, aggregate, where, sort: dims.map(c => ({ column: c })), limit: 20000 };
    const s = sortOf(m, w);
    return { dataset: w.dataset, groupBy: dims, aggregate, where, sort: s === 'label' ? [{ column: dims[0] }] : [{ column: aggregate[0].as, direction: s }], limit: topOf(m, w) };
  }
  const objects = res => res.rows.map(r => Object.fromEntries(res.cols.map((c, k) => [typeof c === 'string' ? c : c.name, r[k]])));
  // Query rows -> rows keyed by input key. Dates become Date objects.
  // Two dimensions: keep the top N values of the first one (by total of the first measure).
  function shape(m, w, rows, columns = []) {
    if (fieldsOf(m)) return rows;   // grid: rows keyed by column name
    const raw = isRaw(m, w), ins = inputsOf(m), dates = new Set(columns.filter(c => /DATE|TIME/i.test(c.type)).map(c => c.name));
    let out = rows.map(r => {
      const o = {};
      for (const i of ins) {
        const b = binding(m, w, i);
        let v = i.role === 'measure' && !raw ? r[alias(i)] : b.col ? r[b.col] : undefined;
        if (v != null && b.col && dates.has(b.col) && (raw || i.role !== 'measure')) { const d = new Date(v); if (!isNaN(d)) v = d; }
        if (v !== undefined) o[i.key] = v;
      }
      return o;
    });
    const dims = dimsOf(m).filter(i => binding(m, w, i).col), meas = ins.find(i => i.role === 'measure');
    if (!raw && dims.length > 1 && meas) {
      const k = dims[0].key, tot = new Map();
      for (const o of out) tot.set(o[k], (tot.get(o[k]) || 0) + (+o[meas.key] || 0));
      const s = sortOf(m, w);
      let keep = [...tot.keys()];
      if (s === 'label') keep.sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true })); else keep.sort((a, b) => s === 'asc' ? tot.get(a) - tot.get(b) : tot.get(b) - tot.get(a));
      keep = keep.slice(0, topOf(m, w)); const set = new Set(keep);
      out = out.filter(o => set.has(o[k])); out.order = keep;
    } else if (!raw && dims.length === 1) out.order = out.map(o => o[dims[0].key]);
    return out;
  }

  // ---- style: a widget's ONLY style is its own sheet, widgets/<id>/style.css (widget.json "style"). ----
  // The part before "/* ===== SHADOW ===== */" goes into the page once per widget package, scoped by the class
  // dn-w-<id> on the box the widget is drawn in; the rest goes into the widget's shadow roots (Data Grid).
  // Chart / tree colours are --w-* variables set in that sheet (read by theme(el)); nothing else styles a widget.
  const SPLIT = /\/\*\s*=====\s*SHADOW\s*=====[^*]*\*\//;
  const cssParts = css => { const [page, shadow = ''] = String(css || '').split(SPLIT); return { page, shadow }; };
  const cls = id => `dn-w-${String(id).replace(/[^A-Za-z0-9_-]/g, '_')}`;
  function useStyle(m, el, doc = el?.ownerDocument || document) {
    if (!m) return;
    // ".WIDGET" in the sheet = this package's box, so a sheet copied to a new widget folder works there unchanged.
    const sid = `dn-w-style-${cls(m.id)}`, page = cssParts(m.styleCss).page.replace(/\.WIDGET\b/g, '.' + cls(m.id));
    let st = doc.getElementById(sid);
    if (!st) { st = Object.assign(doc.createElement('style'), { id: sid }); doc.head.append(st); }
    if (st.textContent !== page) st.textContent = page;
    if (!el) return;
    [...el.classList].filter(c => c.startsWith('dn-w-') && c !== cls(m.id)).forEach(c => el.classList.remove(c));   // box reused by another package
    el.classList.add('dn-widget', cls(m.id));
  }
  // Values for the chart / tree libraries, from the widget's --w-* variables on el (its style sheet).
  function theme(el) {
    const cs = getComputedStyle(el || document.documentElement), v = n => cs.getPropertyValue(`--w-${n}`).trim();
    const n = parseInt((v('bg') || '#fff').replace('#', '').padEnd(6, '0').slice(0, 6), 16), dark = (((n >> 16) & 255) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000 < 128;
    return { dark, bg: v('bg'), panel: v('panel'), panel2: v('panel-2'), sel: v('sel'), text: v('text'), text2: v('text-2'), muted: v('muted'), border: v('border'), blue: v('accent'),
      font: v('font') || "'Exo 2', system-ui, sans-serif", colors: [1, 2, 3, 4, 5, 6, 7, 8].map(i => v(`c${i}`)).filter(Boolean) };
  }
  // Spec + chosen options (null / blank colour = theme default).
  function applied(m, baseSpec, w) {
    const s = clone(baseSpec), vals = { ...Object.fromEntries((m.options || []).map(o => [o.path, o.default])), ...(w.opts || {}) };
    for (const [p, v] of Object.entries(vals)) { const o = (m.options || []).find(x => x.path === p); setAt(s, p, (v === null || v === '') && o?.type === 'color' ? undefined : v); }
    return s;
  }

  // ---- draw into el: an ApexCharts chart of the same type is updated in place (bars / lines animate to the new values) ----
  const size = el => { const cs = getComputedStyle(el); return [Math.max(60, Math.floor(el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight))), Math.max(60, Math.floor(el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)))]; };
  function dispose(el) { if (el?._inst) { ApexRender.dispose(el._inst); el._inst = null; } }
  // rows: objects from the query, or rows keyed by input key when opts.sample. columns: [{ name, type }] (dates, grid types).
  // remote: Data Grid rows come from the engine page by page (js/widgets/grid-remote.js), rows is then empty.
  async function render(el, m, spec, w, rows, { sample = false, columns = [], remote = null, more = null, total = null } = {}) {
    const [W, H] = size(el), data = sample ? rows : shape(m, w, rows, columns);
    const s = applied(m, spec, w), type = `${m.kind}:${s.chart?.type || ''}`;
    const f = fieldsOf(m), names = sample ? Object.keys(data[0] || {}) : f ? binding(m, w, f).cols || [] : [];
    const reuse = m.kind === 'apexcharts' && el._inst && el._type === type && el._inst.el?.isConnected;
    if (!reuse) {
      dispose(el); el.innerHTML = '';
      const box = document.createElement('div'); box.style.cssText = 'width:100%;height:100%;overflow:hidden'; el.append(box);
    }
    el._type = type;
    useStyle(m, el);
    el._inst = await ApexRender.render(m.kind, el.firstElementChild, s, inputsOf(m), data, W, H, theme(el), { live: !sample, names, columns, prev: reuse ? el._inst : null, remote, more, total, wid: m.id, renderer: m.renderer });
    return el._inst;
  }

  return { AGGS, AGG_LABEL, KINDS, isApex, kindOf, detect, merge, inputsOf, hasTop, ready, query, objects, shape, render, dispose, theme, useStyle, cssParts, getAt, setAt, binding, sortOf, topOf };
})();

// Packages in the global widgets/ folder: a folder with a valid widget.json is a widget.
const WidgetRegistry = (() => {
  const ROOT = 'widgets';
  let cache = null;
  const valid = m => m && typeof m.id === 'string' && m.name && !!ApexWidget.KINDS[m.kind];
  async function list(fresh = false) {
    if (cache && !fresh) return cache;
    const out = [];
    for (const e of (await DNFS.list(ROOT).catch(() => [])).filter(e => e.dir)) {
      try {
        const m = await DNFS.readJSON(`${ROOT}/${e.name}/widget.json`);
        if (!valid(m)) continue;
        m.id = e.name;   // the folder name is the id
        m.specJson = await DNFS.readJSON(`${ROOT}/${e.name}/${m.spec || 'spec.json'}`);
        // The widget's own style sheet (widget.json "style"): its whole look, the same wherever it is drawn.
        if (m.style) m.styleCss = await DNFS.readText(`${ROOT}/${e.name}/${m.style}`).catch(() => '');
        out.push(m);
      } catch { /* not a widget package */ }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return (cache = out);
  }
  const get = async id => (await list()).find(m => m.id === id);
  const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'widget';
  async function save(manifest, spec) {
    const { specJson, styleCss: _s, code: _c, ...m } = manifest;
    m.spec = 'spec.json'; m.version = (+m.version || 0) + 1; m.updated = new Date().toISOString();
    // Every widget has its own style sheet (its only style): a new one starts from a widget of the same kind.
    if (!m.style || !(await DNFS.exists(`${ROOT}/${m.id}/${m.style}`))) {
      const like = (await list()).find(x => x.kind === m.kind && x.styleCss && x.id !== m.id);
      m.style = 'style.css';
      await DNFS.write(`${ROOT}/${m.id}/style.css`, like?.styleCss || `/* ${m.name || m.id}: the ONE place this widget's look is set. .WIDGET = its box. */\n\n/* ===== PAGE ===== */\n`);
    }
    await DNFS.writeJSON(`${ROOT}/${m.id}/spec.json`, spec);
    await DNFS.remove(`${ROOT}/${m.id}/render.js`).catch(() => {});
    await DNFS.writeJSON(`${ROOT}/${m.id}/widget.json`, m);
    cache = null;
    return m;
  }
  async function remove(id) { await DNFS.remove(`${ROOT}/${id}`, { recursive: true }); cache = null; }
  return { ROOT, list, get, save, remove, slug };
})();
