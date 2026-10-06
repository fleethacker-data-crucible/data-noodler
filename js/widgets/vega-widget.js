// Widget packages (widgets/<id>/widget.json + spec.json) and Vega / Vega-Lite rendering. Global: VegaWidget, WidgetRegistry.
// Needs js/vendor/vega.min.js + vega-lite.min.js (vendored, offline) and js/dn-fs.js.
//
// Manifest (widget.json):
//   { id, name, description, version, kind: 'builtin' | 'vega' | 'vega-lite',
//     builtin: 'chart' | 'table'                          (built-in widgets: rendered by js/dashboard/widgets.js)
//     spec: 'spec.json', dataName                         (vega: the data set the inputs feed; vega-lite: top-level data)
//     inputs:  [{ key, label, role: 'dimension' | 'measure', agg, paths: ['encoding.x.field', ..], sample }]
//     options: [{ path, label, group, type: 'color' | 'number' | 'boolean' | 'select' | 'text', default, min, max, step, choices, show }] }
// Dashboard widget using a package: { id, type: 'widget', pkg, title, dataset, x, y, w, h,
//   inputs: { <key>: { col, agg } }, opts: { <path>: value }, limit }
// The manifest drives the settings popout in both the Widget Builder and the Dashboard (js/widgets/widget-settings.js).
const VegaWidget = (() => {
  const AGGS = ['count', 'count_distinct', 'sum', 'avg', 'min', 'max', 'none'];
  const AGG_LABEL = { count: 'Count', count_distinct: 'Count distinct', sum: 'Sum', avg: 'Average', min: 'Min', max: 'Max', none: 'No aggregation' };
  const COLOR_KEYS = /^(color|fill|stroke|background|\w+Color)$/;
  const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  const TEXT_KEYS = /^(title|text|subtitle|description|format|labelExpr_?)$/;
  const SKIP = new Set(['$schema', 'data', 'values', 'signal', 'expr', 'name', 'from', 'test', 'url', 'transform', 'scale', 'on', 'params', 'width', 'height', 'autosize']);
  const ENUMS = {
    'mark.type': ['bar', 'line', 'area', 'point', 'circle', 'square', 'tick', 'rule', 'arc', 'text', 'rect', 'trail'],
    interpolate: ['linear', 'monotone', 'step', 'step-after', 'step-before', 'basis', 'cardinal', 'natural'],
    orient: ['horizontal', 'vertical', 'left', 'right', 'top', 'bottom', 'none'],
    type: ['quantitative', 'nominal', 'ordinal', 'temporal'],
    stack: ['zero', 'normalize', 'center'],
    sort: ['ascending', 'descending'],
    align: ['left', 'center', 'right'], baseline: ['top', 'middle', 'bottom', 'alphabetic'],
    scheme: ['tableau10', 'category10', 'set2', 'dark2', 'blues', 'greens', 'oranges', 'reds', 'purples', 'viridis', 'magma', 'inferno', 'plasma', 'turbo', 'redblue', 'blueorange'],
    shape: ['circle', 'square', 'cross', 'diamond', 'triangle-up', 'triangle-down', 'stroke'],
  };
  const NUM = { opacity: [0, 1, 0.05], fillOpacity: [0, 1, 0.05], strokeOpacity: [0, 1, 0.05], size: [0, 2000, 10], strokeWidth: [0, 20, 0.5],
    cornerRadius: [0, 30, 1], cornerRadiusEnd: [0, 30, 1], innerRadius: [0, 300, 1], outerRadius: [0, 300, 1], padAngle: [0, 0.2, 0.005],
    padding: [0, 100, 1], labelAngle: [-90, 90, 5], angle: [-180, 180, 5], fontSize: [6, 48, 1], labelFontSize: [6, 32, 1], titleFontSize: [6, 32, 1],
    tickCount: [0, 30, 1], labelLimit: [0, 400, 10], dx: [-50, 50, 1], dy: [-50, 50, 1], thickness: [1, 40, 1], binSpacing: [0, 20, 1] };

  // ---- path helpers ('encoding.x.field', 'layer.0.mark.color') ----
  const split = p => p.split('.').map(k => /^\d+$/.test(k) ? +k : k);
  const getAt = (o, p) => split(p).reduce((a, k) => a == null ? undefined : a[k], o);
  function setAt(o, p, v) {
    const ks = split(p); let a = o;
    for (let i = 0; i < ks.length - 1; i++) { if (a[ks[i]] == null || typeof a[ks[i]] !== 'object') a[ks[i]] = typeof ks[i + 1] === 'number' ? [] : {}; a = a[ks[i]]; }
    if (v === undefined) delete a[ks[ks.length - 1]]; else a[ks[ks.length - 1]] = v;
  }
  const clone = o => JSON.parse(JSON.stringify(o));
  const kindOf = spec => /vega-lite/.test(spec.$schema || '') ? 'vega-lite' : /\/vega\//.test(spec.$schema || '') || spec.marks || spec.scales ? 'vega' : 'vega-lite';
  const human = p => {
    const parts = split(p).filter(k => typeof k !== 'number' && !['encoding', 'encode', 'enter', 'update', 'value', 'mark', 'config', 'properties', 'marks'].includes(k));
    const s = parts.join(' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    return (p.startsWith('mark.') && parts.length === 1 ? 'Mark ' + s : s.charAt(0).toUpperCase() + s.slice(1)) || p;
  };
  const groupOf = p => {
    const k = split(p).filter(x => typeof x !== 'number');
    if (k[0] === 'encoding') return (k[1] || 'Encoding').replace(/^./, c => c.toUpperCase());
    if (k[0] === 'mark' || k[0] === 'marks' || k[0] === 'layer') return 'Mark';
    if (k[0] === 'title') return 'Title';
    return (k[0] || 'General').replace(/^./, c => c.toUpperCase());
  };

  // Vega-Lite: "mark": "bar" -> { type: "bar" } so the mark has options (colour, opacity, ...).
  function normalize(spec) {
    const fix = s => { if (s && typeof s.mark === 'string') s.mark = { type: s.mark }; (s?.layer || []).forEach(fix); };
    if (kindOf(spec) === 'vega-lite') fix(spec);
    return spec;
  }

  // Read a spec: every `field` becomes a data input, every colour / number / switch / known choice / text becomes an option.
  function detect(spec) {
    spec = normalize(clone(spec));
    const kind = kindOf(spec), fields = new Map(), options = [];
    const walk = (node, path, key, parent) => {
      if (node == null) return;
      if (Array.isArray(node)) return node.forEach((v, i) => walk(v, path ? `${path}.${i}` : String(i), key, node));
      if (typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          if (k === 'field' && typeof v === 'string') {
            const f = fields.get(v) || { name: v, paths: [], quant: false };
            f.paths.push(path ? `${path}.field` : 'field');
            if (node.aggregate || node.type === 'quantitative' || /(^|\.)(y|y2|size|theta|radius)$/.test(path) && kind === 'vega') f.quant = true;
            fields.set(v, f); continue;
          }
          if (SKIP.has(k) && !(k === 'scale' && typeof v === 'object' && kind === 'vega-lite')) continue;
          walk(v, path ? `${path}.${k}` : k, k, node);
        }
        return;
      }
      const shortKey = typeof key === 'number' ? '' : key;
      const enumKey = path.endsWith('mark.type') ? 'mark.type' : shortKey;
      const base = { path, label: human(path), group: groupOf(path), default: node, show: true };
      if (typeof node === 'string' && (HEX.test(node) || COLOR_KEYS.test(shortKey))) options.push({ ...base, type: 'color' });
      else if (typeof node === 'string' && ENUMS[enumKey] && (kind === 'vega-lite' || enumKey !== 'type')) options.push({ ...base, type: 'select', choices: [...new Set([node, ...ENUMS[enumKey]])] });
      else if (typeof node === 'string' && TEXT_KEYS.test(shortKey)) options.push({ ...base, type: 'text' });
      else if (typeof node === 'number') {
        const [min, max, step] = NUM[shortKey] || [Math.min(0, node), Math.max(100, Math.abs(node) * 4), Number.isInteger(node) ? 1 : 0.1];
        options.push({ ...base, type: 'number', min, max, step });
      } else if (typeof node === 'boolean') options.push({ ...base, type: 'boolean' });
    };
    walk(spec, '', '', null);
    if (kind === 'vega-lite' && spec.mark && typeof spec.mark === 'object') {   // always offer the mark colour + tooltip
      if (!options.some(o => o.path === 'mark.color')) options.unshift({ path: 'mark.color', label: 'Mark color', group: 'Mark', type: 'color', default: null, show: true });
      if (!options.some(o => o.path === 'mark.tooltip')) options.push({ path: 'mark.tooltip', label: 'Tooltips', group: 'Mark', type: 'boolean', default: true, show: true });
    }
    let dataName;
    if (kind === 'vega') dataName = (spec.data || []).find(d => d.values || d.url)?.name || spec.data?.[0]?.name;
    const inputs = [...fields.values()].map(f => ({ key: f.name.replace(/[^\w]/g, '_'), label: f.name, role: f.quant ? 'measure' : 'dimension', agg: f.quant ? 'sum' : undefined, paths: f.paths, sample: f.name }));
    return { kind, spec, inputs, options, dataName };
  }

  // Keep what the user set (labels, show, defaults, roles) for options / inputs that still exist after an edit.
  function merge(old, fresh) {
    if (!old) return fresh;
    const op = new Map((old.options || []).map(o => [o.path, o])), ip = new Map((old.inputs || []).map(i => [i.sample || i.key, i]));
    fresh.options = fresh.options.map(o => op.has(o.path) ? { ...o, label: op.get(o.path).label, show: op.get(o.path).show, group: op.get(o.path).group } : o);
    fresh.inputs = fresh.inputs.map(i => ip.has(i.sample) ? { ...i, label: ip.get(i.sample).label, role: ip.get(i.sample).role, agg: ip.get(i.sample).agg } : i);
    return fresh;
  }

  // ---- data ----
  const alias = i => 'v_' + i.key;
  const fieldName = c => String(c).replace(/([.[\]\\])/g, '\\$1');
  const binding = (m, w, i) => ({ col: '', agg: i.agg || (i.role === 'measure' ? 'sum' : undefined), ...(w.inputs?.[i.key] || {}) });
  function ready(m, w) {
    if (!w.dataset) return false;
    return (m.inputs || []).every(i => { const b = binding(m, w, i); return b.col || (i.role === 'measure' && b.agg === 'count'); });
  }
  // Declarative engine query: group by the dimensions, aggregate the measures (or plain rows when a measure has no aggregation).
  function query(m, w) {
    const ins = m.inputs || [], dims = ins.filter(i => i.role !== 'measure'), meas = ins.filter(i => i.role === 'measure');
    const limit = Math.min(+w.limit || 5000, 200000), where = w.where?.trim() || undefined;
    const raw = !meas.length || meas.some(i => binding(m, w, i).agg === 'none');
    if (raw) return { dataset: w.dataset, select: [...new Set(ins.map(i => binding(m, w, i).col).filter(Boolean))], where, limit };
    const groupBy = [...new Set(dims.map(i => binding(m, w, i).col).filter(Boolean))];
    const aggregate = meas.map(i => { const b = binding(m, w, i); return { function: b.agg, column: b.col || undefined, as: alias(i) }; });
    return { dataset: w.dataset, groupBy: groupBy.length ? groupBy : undefined, aggregate, where, sort: groupBy.length ? groupBy.map(c => ({ column: c, direction: 'asc' })) : undefined, limit };
  }
  const objects = res => res.rows.map(r => Object.fromEntries(res.cols.map((c, k) => [typeof c === 'string' ? c : c.name, r[k]])));

  // ---- theme: charts follow css/theme.css unless an option sets a colour ----
  function theme() {
    const cs = getComputedStyle(document.documentElement), v = n => cs.getPropertyValue(n).trim();
    const font = 'Exo 2, system-ui, sans-serif', cat = [1, 2, 3, 4, 5, 6, 7, 8].map(i => v(`--c${i}`));
    const ax = { labelColor: v('--text-2'), titleColor: v('--text-2'), gridColor: v('--border'), domainColor: v('--border'), tickColor: v('--border'),
      labelFont: font, titleFont: font, labelFontSize: 11, titleFontSize: 12, titleFontWeight: 600, gridOpacity: 0.6 };
    return {
      background: null, font, padding: 4,
      view: { stroke: null }, axis: ax,
      legend: { labelColor: v('--text-2'), titleColor: v('--text-2'), labelFont: font, titleFont: font, titleFontWeight: 600, symbolType: 'square' },
      title: { color: v('--text'), font, fontSize: 14, fontWeight: 600, subtitleColor: v('--muted'), anchor: 'start' },
      header: { labelColor: v('--text-2'), titleColor: v('--text-2') },
      range: { category: cat },
      mark: { color: cat[0] }, bar: { cornerRadiusEnd: 4 }, line: { strokeWidth: 2 }, point: { filled: true },
      text: { color: v('--text'), font }, arc: { stroke: v('--panel') },
      // plain Vega mark defaults
      rect: { fill: cat[0] }, symbol: { fill: cat[0] }, area: { fill: cat[0] }, rule: { stroke: v('--border') },
    };
  }

  // Final spec for drawing: options applied, inputs pointed at the query's columns, data inlined, sized to the box.
  function build(m, baseSpec, w, rows, W, H) {
    const s = normalize(clone(baseSpec)), vals = { ...Object.fromEntries((m.options || []).map(o => [o.path, o.default])), ...(w.opts || {}) };
    for (const [p, v] of Object.entries(vals)) setAt(s, p, v === null || v === '' && (m.options || []).find(o => o.path === p)?.type === 'color' ? undefined : v);
    if (rows) {
      const raw = (m.inputs || []).some(i => i.role === 'measure' && binding(m, w, i).agg === 'none') || !(m.inputs || []).some(i => i.role === 'measure');
      for (const i of m.inputs || []) {
        const b = binding(m, w, i), name = i.role === 'measure' && !raw ? alias(i) : b.col;
        for (const p of i.paths) {
          setAt(s, p, fieldName(name));
          if (i.role === 'measure' && !raw) { const par = p.split('.').slice(0, -1).join('.'); const o = par ? getAt(s, par) : s; if (o && o.aggregate) delete o.aggregate; }
        }
      }
      if (m.kind === 'vega') { const d = (s.data || []).find(x => x.name === m.dataName); if (d) { d.values = rows; delete d.url; delete d.format; delete d.source; } }
      else s.data = { values: rows };
    }
    if (W && H) {
      if (m.kind === 'vega') { s.width = W; s.height = H; s.autosize = { type: 'fit', contains: 'padding' }; }
      else if (!s.facet && !s.hconcat && !s.vconcat && !s.concat && !s.repeat) { s.width = W; s.height = H; s.autosize = { type: 'fit', contains: 'padding' }; }
    }
    return s;
  }

  let tip;
  const tooltip = (handler, ev, item, value) => {
    tip ||= document.body.appendChild(Object.assign(document.createElement('div'), { className: 'tip' }));
    if (value == null || value === '') { tip.style.display = 'none'; return; }
    tip.textContent = typeof value === 'object' ? Object.entries(value).map(([k, v]) => `${k}: ${typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : v}`).join('\n') : String(value);
    Object.assign(tip.style, { display: 'block', whiteSpace: 'pre', left: ev.clientX + 12 + 'px', top: ev.clientY + 12 + 'px' });
  };
  // Draw into el (replaces what was there). Returns the Vega view.
  async function render(el, m, spec, w, rows) {
    const cs = getComputedStyle(el);
    const Wd = Math.max(60, el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)), Hd = Math.max(60, el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom));
    const s = build(m, spec, w, rows, Wd, Hd), cfg = theme();
    const vg = m.kind === 'vega' ? s : vegaLite.compile(s, { config: cfg }).spec;
    const view = new vega.View(vega.parse(vg, m.kind === 'vega' ? cfg : undefined), { renderer: 'svg', hover: true });
    view.tooltip(tooltip);
    el._vv?.finalize(); el.innerHTML = '';
    view.initialize(el); el._vv = view;
    await view.runAsync();
    return view;
  }
  return { AGGS, AGG_LABEL, detect, merge, normalize, kindOf, ready, query, objects, build, render, theme, getAt, setAt, binding };
})();

// Packages in the global widgets/ folder: a folder with a valid widget.json is a widget.
const WidgetRegistry = (() => {
  const ROOT = 'widgets';
  let cache = null;
  const valid = m => m && typeof m.id === 'string' && m.name && (m.kind === 'builtin' ? !!m.builtin : (m.kind === 'vega' || m.kind === 'vega-lite'));
  async function list(fresh = false) {
    if (cache && !fresh) return cache;
    const out = [];
    for (const e of (await DNFS.list(ROOT).catch(() => [])).filter(e => e.dir)) {
      try {
        const m = await DNFS.readJSON(`${ROOT}/${e.name}/widget.json`);
        if (!valid(m)) continue;
        m.id = e.name;   // the folder name is the id
        if (m.kind !== 'builtin') m.specJson = await DNFS.readJSON(`${ROOT}/${e.name}/${m.spec || 'spec.json'}`);
        out.push(m);
      } catch { /* not a widget package */ }
    }
    out.sort((a, b) => (a.kind === 'builtin' ? 0 : 1) - (b.kind === 'builtin' ? 0 : 1) || a.name.localeCompare(b.name));
    return (cache = out);
  }
  const get = async id => (await list()).find(m => m.id === id);
  const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'widget';
  async function save(manifest, spec) {
    const { specJson, ...m } = manifest;
    m.spec = 'spec.json'; m.version = (+m.version || 0) + 1; m.updated = new Date().toISOString();
    await DNFS.writeJSON(`${ROOT}/${m.id}/spec.json`, spec);
    await DNFS.writeJSON(`${ROOT}/${m.id}/widget.json`, m);
    cache = null;
    return m;
  }
  async function remove(id) { await DNFS.remove(`${ROOT}/${id}`, { recursive: true }); cache = null; }
  return { ROOT, list, get, save, remove, slug };
})();
