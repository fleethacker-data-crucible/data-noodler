// Widgets (Dashboard Studio): packages, data and drawing. Global: Widgets. Needs ui/js/vendor/d3.v7.min.js (global d3),
// dn-fs.js and engine-client.js.
//
// A widget package is a folder with three files:
//   d3-code.js        an ES module: export default function (data, { width, height, settings, inputs }) -> element
//                     It builds its own root (controls + SVG) with d3, selects only inside it, and returns it. Filters /
//                     buttons fire CustomEvents from the root.
//   d3-style.css      the widget's only style. ".WIDGET" = its container (scoped here per widget). Frame colours (axes,
//                     grid, text, background) use the app theme variables; data colours come from settings.
//   d3-settings.json  { name, inputs: [{ key, label, role: 'dimension' | 'measure', agg, axis, optional }],
//                       settings: [{ path, label, group, sub, type, default, ... }], values: { <path>: value } }
// Where they live: GLOBAL (workspace/dashboard-studio/widgets/<id>/) and each project (<project>/dashboard/widgets/<id>/).
// A project only uses its own copy. Data: the project's CLEAN_ datasets; SAMPLE_ datasets (workspace/sample-data/) are
// for the editor's preview only.
const Widgets = (() => {
  const GLOBAL = 'workspace/dashboard-studio/widgets', SAMPLES = 'workspace/sample-data';
  const FILES = { code: 'd3-code.js', css: 'd3-style.css', settings: 'd3-settings.json' };
  const projectDir = ctx => `${ctx.dir}/dashboard/widgets`;
  const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'widget';
  const isSample = name => /^SAMPLE_/i.test(name || '');

  // ---- packages ----
  async function read(dir) {
    const [code, css, settings] = await Promise.all([DNFS.readText(`${dir}/${FILES.code}`), DNFS.readText(`${dir}/${FILES.css}`).catch(() => ''),
      DNFS.readText(`${dir}/${FILES.settings}`).catch(() => '{}')]);
    const id = dir.split('/').pop();
    let s = {}; try { s = JSON.parse(settings); } catch {}
    return { id, dir, name: s.name || id, code, css, settings };
  }
  async function list(root) {
    const out = [];
    for (const e of (await DNFS.list(root).catch(() => [])).filter(e => e.dir && !e.name.startsWith('_'))) {
      try { out.push(await read(`${root}/${e.name}`)); } catch { /* not a widget */ }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
  async function write(dir, p) {
    await DNFS.writeText(`${dir}/${FILES.code}`, p.code);
    await DNFS.writeText(`${dir}/${FILES.css}`, p.css);
    await DNFS.writeText(`${dir}/${FILES.settings}`, p.settings);
  }
  async function copy(from, to) {
    await DNFS.remove(to, { recursive: true }).catch(() => {});
    await DNFS.copy(from, to, { overwrite: true });
  }
  // d3-settings.json text -> object (a broken file throws with the reason).
  function parse(text) {
    const s = JSON.parse(text || '{}');
    return { name: s.name || '', inputs: Array.isArray(s.inputs) ? s.inputs.filter(i => i && i.key) : [], settings: Array.isArray(s.settings) ? s.settings.filter(o => o && o.path) : [], values: s.values || {} };
  }
  // The values the code gets as `settings`: defaults + saved values, as nested objects ('colors.0' -> settings.colors[0]).
  function values(s, over = {}) {
    const flat = { ...Object.fromEntries(s.settings.map(o => [o.path, o.default])), ...s.values, ...over }, out = {};
    for (const [p, v] of Object.entries(flat)) setAt(out, p, v);
    return out;
  }
  function setAt(o, p, v) {
    const ks = String(p).split('.').map(k => /^\d+$/.test(k) ? +k : k); let a = o;
    for (let i = 0; i < ks.length - 1; i++) { if (a[ks[i]] == null || typeof a[ks[i]] !== 'object') a[ks[i]] = typeof ks[i + 1] === 'number' ? [] : {}; a = a[ks[i]]; }
    a[ks[ks.length - 1]] = v;
  }

  // ---- code: the module is imported from its text (one import per distinct text) ----
  const mods = new Map();
  async function compile(code) {
    if (!mods.has(code)) {
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      mods.set(code, import(url).finally(() => URL.revokeObjectURL(url)));
      if (mods.size > 50) mods.delete(mods.keys().next().value);
    }
    let m;
    try { m = await mods.get(code); } catch (e) { mods.delete(code); throw e; }
    if (typeof m.default !== 'function') throw new Error('d3-code.js must "export default function (data, { width, height, settings }) { ... }".');
    return m.default;
  }

  // ---- style: ".WIDGET" in d3-style.css = the widget's container, scoped by the class dn-widget-<key> ----
  const cls = key => `dn-widget-${String(key).replace(/[^A-Za-z0-9_-]/g, '_')}`;
  function useStyle(el, key, css) {
    const doc = el.ownerDocument, id = `${cls(key)}-style`, text = String(css || '').replace(/\.WIDGET\b/g, '.' + cls(key));
    let st = doc.getElementById(id);
    if (!st) { st = Object.assign(doc.createElement('style'), { id }); doc.head.append(st); }
    if (st.textContent !== text) st.textContent = text;
    [...el.classList].filter(c => c.startsWith('dn-widget-') && c !== cls(key)).forEach(c => el.classList.remove(c));
    el.classList.add('dn-widget', cls(key));
  }
  // Draw into el: the container's contents are replaced by the element the widget returns.
  // p = { key, code, css, settings (text or parsed) }, data = rows keyed by input key, over = setting values to use,
  // extra = more options for the widget (the dashboard passes { filter }: a filter widget's last 'dn-filter' detail).
  async function draw(el, p, data, over, extra) {
    const s = typeof p.settings === 'string' ? parse(p.settings) : p.settings, fn = await compile(p.code);
    useStyle(el, p.key || p.id || 'edit', p.css);
    const width = Math.max(40, Math.floor(el.clientWidth)), height = Math.max(40, Math.floor(el.clientHeight));
    const node = fn(data || [], { ...extra, width, height, settings: values(s, over), inputs: s.inputs });
    if (node instanceof Node) el.replaceChildren(node);
    else if (node != null) throw new Error('The widget function must return an element (e.g. svg.node()).');
  }

  // ---- datasets: the project's CLEAN_ datasets and the SAMPLE_ ones (folders or .arrow files in workspace/sample-data) ----
  async function samples() {
    const out = [];
    for (const e of await DNFS.list(SAMPLES).catch(() => [])) {
      if (!isSample(e.name)) continue;
      const path = `${SAMPLES}/${e.name}`, name = e.name.replace(/\.(arrow|feather|parquet)$/i, '');
      if (!e.dir && !/\.(arrow|feather|parquet)$/i.test(e.name)) continue;
      let columns = [];
      try {
        const man = e.dir ? await DNFS.readJSON(`${path}/dataset.json`).catch(() => null) : null;
        columns = man?.columns || await Engine.describe(`SELECT * FROM ${Engine.dataset({ path })}`);
      } catch { continue; }
      out.push({ name, path, columns, sample: true });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---- data: one declarative engine query for the linked inputs; rows come back keyed by input key ----
  // links = { <input key>: { col, agg } }. Dimensions are grouped by, measures aggregated (agg 'none' = raw rows).
  const NUMERIC = /INT|DOUBLE|FLOAT|DECIMAL|REAL|NUMERIC/i, DATE = /DATE|TIME/i;
  const ready = (inputs, links) => inputs.length > 0 && inputs.every(i => i.optional || links[i.key]?.col || (i.role === 'measure' && links[i.key]?.agg === 'count'));
  // A dimension input with "count": true (filter widgets) is grouped and its rows counted: rows = { <key>, count }.
  const counted = inputs => inputs.some(i => i.role !== 'measure' && i.count);
  const isRaw = (inputs, links) => (!inputs.some(i => i.role === 'measure') && !counted(inputs)) || inputs.some(i => i.role === 'measure' && (links[i.key]?.agg || i.agg) === 'none');
  // where = an optional SQL condition (the dashboard's filter widgets, see where()).
  function query(inputs, links, dataset, where) {
    const col = i => links[i.key]?.col, limit = 200000, w = where ? { where } : {};
    if (isRaw(inputs, links)) return { dataset, select: [...new Set(inputs.map(col).filter(Boolean))], ...w, limit };
    const dims = [...new Set(inputs.filter(i => i.role !== 'measure').map(col).filter(Boolean))];
    const aggregate = inputs.filter(i => i.role === 'measure').map(i => ({ function: links[i.key]?.agg || i.agg || 'sum', column: col(i) || undefined, as: 'v_' + i.key }));
    if (counted(inputs)) aggregate.push({ function: 'count', as: 'n__count' });
    return dims.length ? { dataset, groupBy: dims, aggregate, ...w, sort: dims.map(c => ({ column: c })), limit } : { dataset, aggregate, ...w };
  }
  // Filters [{ col, values, ranges }] -> one SQL condition ("Region" IN ('East', 'West') AND ...); values = the rows' own
  // values, ranges = [{ min, max }] (both included; a date at midnight = that whole day). Within a filter they are OR'd.
  function where(filters) {
    const q = n => `"${String(n).replace(/"/g, '""')}"`, s = v => `'${String(v).replace(/'/g, "''")}'`;
    const midnight = d => d.getUTCHours() + d.getUTCMinutes() + d.getUTCSeconds() + d.getUTCMilliseconds() === 0;
    const dlit = d => s(midnight(d) ? d.toISOString().slice(0, 10) : d.toISOString().replace('T', ' ').replace(/\.\d+Z$|Z$/, ''));
    const lit = v => typeof v === 'number' ? (Number.isFinite(v) ? String(v) : 'NULL') : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE')
      : v instanceof Date ? dlit(v) : s(v);
    const range = (c, r) => {
      const lo = r.min != null ? `${c} >= ${lit(r.min)}` : '', hi = r.max == null ? ''
        : r.max instanceof Date && midnight(r.max) ? `${c} < ${dlit(new Date(+r.max + 864e5))}` : `${c} <= ${lit(r.max)}`;
      return [lo, hi].filter(Boolean).join(' AND ') || 'TRUE';
    };
    return filters.filter(f => f.col && (f.values?.length || f.ranges?.length)).map(f => {
      const c = q(f.col), all = f.values || [], vals = all.filter(v => v != null), parts = vals.length ? [`${c} IN (${vals.map(lit).join(', ')})`] : [];
      if (vals.length < all.length) parts.push(`${c} IS NULL`);
      for (const r of f.ranges || []) parts.push(`(${range(c, r)})`);
      return parts.length > 1 ? `(${parts.join(' OR ')})` : parts[0];
    }).join(' AND ');
  }
  async function load(inputs, links, d, cond) {
    const r = await Engine.call('query', { query: query(inputs, links, d.name, cond), views: Engine.views([d]) });
    const raw = isRaw(inputs, links), dates = new Set((d.columns || []).filter(c => DATE.test(c.type)).map(c => c.name));
    return r.rows.map(row => {
      const o = Object.fromEntries(r.cols.map((c, k) => [typeof c === 'string' ? c : c.name, row[k]])), out = {};
      for (const i of inputs) {
        const c = links[i.key]?.col;
        let v = i.role === 'measure' && !raw ? o['v_' + i.key] : c ? o[c] : undefined;
        if (v != null && c && dates.has(c) && (raw || i.role !== 'measure')) { const t = new Date(v); if (!isNaN(t)) v = t; }
        if (v !== undefined) out[i.key] = v;
      }
      if (!raw && counted(inputs)) out.count = o.n__count;
      return out;
    });
  }

  return { GLOBAL, SAMPLES, FILES, NUMERIC, DATE, projectDir, slug, isSample, read, list, write, copy, parse, values, compile, useStyle, draw, samples, ready, query, where, load };
})();
