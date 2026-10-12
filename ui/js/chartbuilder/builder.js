// Chart Builder (ui/html/chart-builder.html): the simple way to make a chart. Pick a chart type, pick a dataset, drag its
// fields onto the slots (Category, Value ...), set colours and a few settings; Code shows the D3 code behind it, which
// can be edited or replaced with code from the web (the chart is then "custom": the chart type no longer rewrites it).
// It saves the same chart package as D3 Studio (workspace/chart-builder/dev/<id>/; Publish copies it to workspace/chart-builder/published/<id>/ for
// Dashboard Builder), plus chart.json "builder" { template, custom, links, size } so it reopens here as it was.
(() => {
  const { $, esc } = UI;
  const DEV = ChartRegistry.CHARTS_DEV, LIVE = ChartRegistry.CHARTS_LIVE, G = 24;
  // Category (Dashboard > Charts group) = the chart type for now: Column, Bar, Line ... (code-only charts: Other).
  const catOf = () => tpl?.label || 'Other';
  const NUMERIC = /INT|DOUBLE|FLOAT|DECIMAL|REAL|NUMERIC/i, DATE = /DATE|TIME/i;

  // ---- state ----
  let tpl = ChartTemplates.get('bar');   // chart type (null = a chart that never had one: code only)
  let custom = false;                    // the code was changed by hand: the chart type no longer rewrites it
  let code = tpl.code, inputs = clone(tpl.inputs), options = clone(tpl.options);
  let links = {};                        // input key -> { col, agg }
  let opts = defaults(options);          // option path -> value
  let colours = Array(8).fill(null);     // '#rrggbb' or null (theme colour)
  let sort = 'desc', top = 20;
  let size = { w: 26, h: 14 };           // chart card, in grid cells
  let sources = [], source = null;       // CLEAN_ datasets of every project; the one picked: { key, folder, d }
  let editing = null, all = [], live = new Set();
  let rows = null, note = '', seq = 0;

  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function defaults(os) { return Object.fromEntries(os.filter(o => o.type !== 'color').map(o => [o.path, o.default])); }
  const kindOf = t => NUMERIC.test(t) ? 'num' : DATE.test(t) ? 'date' : 'text';
  const columns = () => source?.d.columns || [];

  // ---- data sources: every CLEAN_ dataset in data/source of every project ----
  async function loadSources() {
    const projs = (await Projects.list().catch(() => [])).filter(p => !p.broken);
    sources = [];
    for (const p of projs) for (const d of await Projects.sourceDatasets(p.folder).catch(() => [])) if (/^CLEAN_/i.test(d.name)) sources.push({ key: `${p.folder}/${d.name}`, folder: p.folder, proj: p.name, d });
    sources.sort((a, b) => a.d.name.localeCompare(b.d.name, undefined, { sensitivity: 'base', numeric: true }));
  }
  function setSource(key) {
    source = sources.find(s => s.key === key) || null;
    // Links keep their field where the new dataset has it.
    for (const k of Object.keys(links)) if (!columns().some(c => c.name === links[k].col)) delete links[k];
    drawSlots(); loadData(); dataWin();
  }

  // ---- Edit Data (right-click the chart): the clean datasets and their fields in a window; drag a field onto X / Y ----
  const dsList = () => { const many = new Set(sources.map(s => s.folder)).size > 1; return sources.map(s => ({ key: s.key, name: s.d.name, note: many ? s.proj : '', columns: s.d.columns || [] })); };
  const dataWin = () => DataWindow.update({ datasets: dsList(), current: source?.key || null });
  // Sample data: the chart type's sample sets (Small ... Huge), else its one sample.
  let sampleIdx = 0;
  let randomRows = null;   // Randomize selected sample: new values for the sample set in use (not saved)
  const sampleRows = () => randomRows || tpl?.samples?.[sampleIdx]?.rows || tpl?.sample || editing?.sampleRows || [];
  // New random values, the same size of numbers as the set's own (each value between half and twice the set's range).
  function randomize() {
    const base = tpl?.samples?.[sampleIdx]?.rows || tpl?.sample || editing?.sampleRows || [];
    const ys = base.map(r => +r.y).filter(Number.isFinite), lo = Math.max(Math.min(...ys) / 2, 1e-9), hi = Math.max(...ys) * 1.2;
    randomRows = base.map(r => typeof r.y === 'number' ? { ...r, y: Math.round(lo * Math.pow(hi / lo, Math.random()) * 100) / 100 } : { ...r });
    links = {}; source = null; drawSlots(); loadData();
  }
  const samples = () => (tpl?.samples || []).map(x => x.label);
  const openData = () => DataWindow.open({ datasets: dsList(), current: source?.key || null, samples: samples(), sample: sampleIdx, onRandom: randomize,
    onSample: i => { links = {}; source = null; sampleIdx = +i || 0; randomRows = null; drawSlots(); loadData(); DataWindow.update({ datasets: dsList(), current: null, samples: samples(), sample: sampleIdx }); } });
  $('card').addEventListener('contextmenu', ev => {
    ev.preventDefault();
    const m = $('ctxmenu'); Menus.closeAll(); m.classList.add('open');
    m.style.left = `${Math.max(0, Math.min(ev.clientX, innerWidth - m.offsetWidth - 4))}px`; m.style.top = `${Math.max(0, Math.min(ev.clientY, innerHeight - m.offsetHeight - 4))}px`;
  });
  addEventListener('pointerdown', e => { if (!e.target.closest('#ctxmenu')) $('ctxmenu').classList.remove('open'); }, true);
  addEventListener('blur', () => $('ctxmenu').classList.remove('open'));
  $('ctxmenu').onclick = e => { const act = e.target.closest('[data-act]')?.dataset.act; $('ctxmenu').classList.remove('open'); if (act === 'data') openData(); else if (act === 'settings') setWin(true); };

  // ---- Chart Settings: the settings panel in its own window, moved by its header; open / closed and its place survive a refresh ----
  const SET_KEY = 'dn-chartsettings:' + location.pathname;
  let setPos = null, setOpen = true;
  try { const st = JSON.parse(sessionStorage.getItem(SET_KEY) || 'null'); if (st) { setPos = st.pos || null; setOpen = st.open !== false; } } catch {}
  const setSave = () => { try { sessionStorage.setItem(SET_KEY, JSON.stringify({ open: setOpen, pos: setPos })); } catch {} };
  function setPlace() {
    const el = $('cset'), p = setPos || { x: Math.max(0, innerWidth - el.offsetWidth - 24), y: 96 };
    Object.assign(el.style, { left: `${Math.max(0, Math.min(innerWidth - 60, p.x))}px`, top: `${Math.max(0, Math.min(innerHeight - 30, p.y))}px` });
  }
  function setWin(open) { setOpen = open; $('cset').hidden = !open; if (open) setPlace(); setSave(); }
  $('csetX').onclick = () => setWin(false);
  $('csetHead').addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    const r = $('cset').getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    const mv = ev => { setPos = { x: ev.clientX - dx, y: ev.clientY - dy }; setPlace(); };
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); setSave(); };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
  });
  addEventListener('resize', setPlace);
  setWin(setOpen);

  // ---- slots: one per input; drop a field on it ----
  function drawSlots() {
    $('slots').innerHTML = ChartPanel.slots(inputs, links);
    layout();
  }
  for (const el of [$('slots')]) {
    el.addEventListener('change', e => { const k = e.target.dataset.agg; if (k && links[k]) { links[k].agg = e.target.value; drawSlots(); loadData(); } });
    el.addEventListener('click', e => { const k = e.target.dataset.clear; if (k) { delete links[k]; drawSlots(); loadData(); } });
  }
  function link(key, col) {
    const i = inputs.find(x => x.key === key); if (!i) return;
    links[key] = { col, ...(i.role === 'measure' ? { agg: links[key]?.agg || (i.agg === 'none' ? 'none' : NUMERIC.test(columns().find(c => c.name === col)?.type || '') ? i.agg || 'sum' : 'count') } : {}) };
    drawSlots(); loadData();
  }
  // A field dropped on the chart (not on a slot): numbers go to a value slot, text / dates to a category slot; empty ones first.
  function autoPlace(col) {
    const num = NUMERIC.test(columns().find(c => c.name === col)?.type || '');
    const fits = i => num ? i.role === 'measure' : i.role !== 'measure';
    const i = inputs.find(x => !links[x.key] && fits(x)) || inputs.find(x => !links[x.key]) || inputs.find(fits);
    if (i) link(i.key, col);
  }
  const over = (el, on) => el?.classList.toggle('over', on);
  for (const zone of [$('slots'), $('card')]) {
    zone.addEventListener('dragover', e => { if (!e.dataTransfer.types.includes('text/x-field')) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; over(zone === $('card') ? zone : e.target.closest('.slot'), true); });
    zone.addEventListener('dragleave', e => over(zone === $('card') ? zone : e.target.closest('.slot'), false));
    zone.addEventListener('drop', e => {
      const col = e.dataTransfer.getData('text/x-field'); if (!col) return;
      e.preventDefault(); document.querySelectorAll('.over').forEach(x => x.classList.remove('over'));
      const ds = e.dataTransfer.getData('text/x-dataset'); if (ds && ds !== source?.key) setSource(ds);   // a field of another dataset: the chart reads that one now
      const s = e.target.closest('.slot'); if (s) link(s.dataset.key, col); else autoPlace(col);
    });
  }

  // ---- chart types ----
  function drawTypes() {
    $('types').innerHTML = ChartTemplates.list.map(t => `<div class="type ${tpl?.id === t.id ? 'on' : ''}" data-t="${t.id}" title="${esc(t.label)} chart"><svg viewBox="0 0 24 24">${t.icon}</svg>${esc(t.label)}</div>`).join('');
  }
  $('types').onclick = async e => {
    const t = ChartTemplates.get(e.target.closest('[data-t]')?.dataset.t); if (!t || t === tpl) return;
    if (custom && !await UI.confirm(`Switch to ${t.label}? The code changes you made are replaced by the ${t.label} chart's code.`, { ok: 'Switch' })) return;
    // Quick cross-fade: the old chart fades out, the new one fades in (drawn at once, not morphed from the old one).
    $('pv').classList.add('fade');
    setTimeout(() => { still = true; useTemplate(t); drawNow(); still = false; requestAnimationFrame(() => $('pv').classList.remove('fade')); }, 120);
  };
  function useTemplate(t) {
    // Fields stay on the slot with the same key (x, y): a Column chart becomes a Line chart with the same data.
    tpl = t; custom = false; code = t.code; inputs = clone(t.inputs); options = clone(t.options);
    opts = { ...defaults(options), ...Object.fromEntries(Object.entries(opts).filter(([p]) => options.some(o => o.path === p))) };
    for (const k of Object.keys(links)) { const i = inputs.find(x => x.key === k); if (!i) delete links[k]; else if (i.role === 'measure' && i.agg === 'none') links[k].agg = 'none'; else if (i.role === 'measure' && links[k].agg === 'none') links[k].agg = i.agg || 'sum'; else if (i.role !== 'measure') delete links[k].agg; }
    if (t.sort) sort = t.sort; else if (sort === 'label' && !t.sort) sort = 'desc';
    top = t.top || (top >= 1000 ? 20 : top);
    pushCode();
    drawTypes(); drawOpts(); drawSlots(); drawCustom(); syncCat(); loadData();
  }

  // ---- colours and settings ----
  function drawColours() {
    ChartPanel.colours($('colours'), colours, (i, v) => { colours[i] = v; draw(); });
  }
  function drawOpts() {
    // X-Axis / Y-Axis sections: the options in those groups; Settings: the rest.
    const SECS = { 'X-Axis': 'X', 'Y-Axis': 'Y' }, get = p => opts[p], set = (p, v) => { opts[p] = v; draw(); };
    // What is on each input now (numbers, dates, text): the Format drop-downs offer the formats for it.
    const shown = rows || sampleRows(), kinds = Object.fromEntries(inputs.map(i => [i.key, ChartPanel.valueKind(shown, i.key)]));
    for (const [g, k] of Object.entries(SECS)) { const os = options.filter(o => o.group === g); $(k.toLowerCase() + 'Box').hidden = !os.length; ChartPanel.settings($('opts' + k), os, get, set, kinds); }
    ChartPanel.settings($('opts'), options.filter(o => !SECS[o.group]), get, set, kinds);
    const ordered = inputs.some(i => i.role === 'measure' && (links[i.key]?.agg || i.agg) !== 'none');
    $('orderBox').hidden = true || !ordered;   // Order and Settings sections are not shown for now (sort / top keep their values)
    $('sort').value = sort; $('top').value = top;
  }
  $('sort').onchange = () => { sort = $('sort').value; loadData(); };
  $('top').onchange = () => { top = Math.max(1, +$('top').value || 20); loadData(); };
  const syncCat = () => {};   // the category is the chart type picked (catOf); nothing to show

  // ---- code: its own window (ui/html/chart-code.html), out of the way. It works through window.ChartCode below and
  //      gets every change made here (chart type switched, chart opened). ----
  let codeWin = null;
  const subs = new Set();
  const pushCode = () => subs.forEach(f => { try { f(); } catch { subs.delete(f); } });
  window.ChartCode = {
    get code() { return code; },
    get custom() { return custom; },
    get title() { return $('name').value.trim() || 'New chart'; },
    vars: () => `Ready made: data (rows), ${inputs.map(i => `${i.key.toUpperCase()}(d) = ${i.label}`).join(', ')}, W, H, colors[0..7], opts, theme`,
    set(v) { if (v === code) return; code = v; if (!custom) { custom = true; drawCustom(); } draw(); },
    async reset() {
      if (!tpl) return UI.toast('This chart was made as code: it has no chart type to go back to. Pick one on the right to start from it.');
      if (custom && !await UI.confirm("Throw away your code changes and use the chart type's code again?", { danger: true, ok: 'Reset' })) return;
      useTemplate(tpl);
    },
    subscribe(f) { subs.add(f); return () => subs.delete(f); },
  };
  $('codeBtn').onclick = () => {
    if (codeWin && !codeWin.closed) return codeWin.focus();
    const W = Math.min(900, screen.availWidth), H = Math.min(800, screen.availHeight), L = (screen.availLeft ?? 0) + screen.availWidth - W, T = screen.availTop ?? 0;
    codeWin = window.open('chart-code.html', 'dn-chart-code', `popup,width=${W},height=${H},left=${L},top=${T}`);
    if (!codeWin) UI.toast('The browser blocked the code window. Allow pop-ups for this site.', 'err');
  };
  addEventListener('beforeunload', () => { try { codeWin?.close(); } catch {} });
  function drawCustom() { $('custom').hidden = !custom; $('codeBtn').title = custom ? 'Custom code: see and edit it' : "See and edit the chart's D3 code, or paste code from the web"; }

  // ---- stage layout: the 24px grid with a line at the centre; the card centred on it, its slots above it ----
  function layout() {
    const st = $('stage'), W = st.clientWidth, c = Math.floor(W / 2);
    st.style.setProperty('--gx', `${c % G}px`);
    const avail = st.clientHeight;
    // The chart's centre is locked to the centre of the grid area.
    const cw = size.w * G, ch = Math.min(size.h * G, Math.max(6 * G, Math.floor((avail - 8 * G) / G) * G));
    const left = Math.round(c - cw / 2), topPx = Math.max(4 * G, Math.round(avail / 2 - ch / 2));
    Object.assign($('card').style, { left: `${left}px`, top: `${topPx}px`, width: `${cw + 1}px`, height: `${ch + 1}px` });
    $('types').style.left = `${left + cw / 2}px`;   // the chart types: centred on the chart
    Object.assign($('name').style, { left: `${left + cw / 2}px`, top: `${topPx - 10}px` });   // the name: 10px above the chart, centred
    // X slot: centred under the chart; Y slot: centred on its left side; any other slot under X.
    ChartPanel.placeSlots($('slots'), inputs, { left, top: topPx, w: cw, h: ch }, tpl?.flip && !custom);   // Bar (horizontal): X is down the left
    $('sz').textContent = `${cw} x ${ch} px`;
    drawNow();   // at once: a resize redraws the chart to its new size in the same frame
  }
  new ResizeObserver(() => layout()).observe($('stage'));
  // Resize the card in whole cells: try the chart at Dashboard sizes.
  $('card').addEventListener('pointerdown', ev => {
    const dir = ev.target.closest('.rz')?.dataset.dir; if (!dir) return;
    ev.preventDefault();
    const sx = ev.clientX, sy = ev.clientY, s0 = { ...size };
    const fx = dir.includes('e') ? 1 : dir.includes('w') ? -1 : 0, fy = dir.includes('s') ? 1 : dir.includes('n') ? -1 : 0;   // side bars: one direction only
    const move = e => { size = { w: Math.max(8, s0.w + 2 * fx * Math.round((e.clientX - sx) / G)), h: Math.max(6, s0.h + 2 * fy * Math.round((e.clientY - sy) / G)) }; layout(); };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  });

  // ---- data: the slots' fields as one engine query (the Dashboard's own query), else the chart type's sample rows ----
  const manifest = () => ({ kind: 'd3', inputs: inputs.map(i => ({ ...i, agg: links[i.key]?.agg || i.agg })), specJson: { query: { sort, top } } });
  async function loadData() {
    const n = ++seq;
    drawOpts();
    const missing = inputs.filter(i => !links[i.key] && !i.optional);
    if (!source || missing.length) {
      rows = null;
      note = !source ? 'Sample data: pick a dataset under Data (right).' : `Sample data: drop a field on ${missing.map(i => i.label || i.key).join(' and ')}.`;
      return draw();
    }
    const m = manifest(), w = { dataset: source.d.name, inputs: Object.fromEntries(Object.entries(links).map(([k, l]) => [k, { ...l }])), sort, top };
    try {
      const t0 = performance.now(), r = await Engine.call('query', { query: ApexWidget.query(m, w), views: Engine.views([source.d]) });
      if (n !== seq) return;
      rows = ApexWidget.shape(m, w, ApexWidget.objects(r), columns());
      drawOpts();   // the formats follow the data's kinds
      note = `${rows.length.toLocaleString()} rows from ${source.d.name} · ${UI.ms(performance.now() - t0)}`;
    } catch (e) { if (n !== seq) return; rows = null; drawOpts(); note = `Data: ${String(e.message || e).split('\n')[0]}`; }
    draw();
  }

  // ---- draw ----
  const STYLE_BASE = name => `/* ${name} (D3 chart, made in Chart Builder): the ONE place this chart's look is set, wherever it is drawn.
   .CHART = this chart's box. --w-c1..c8 = its default colours (the COLOURS block); the other --w-* variables reach the code as \`theme\`. */

/* ===== PAGE ===== */
.CHART {
  --w-font: 'Exo 2', system-ui, sans-serif;
  --w-bg: var(--bg); --w-panel: var(--panel); --w-panel-2: var(--panel-2); --w-sel: var(--sel);
  --w-text: var(--text); --w-text-2: var(--text-2); --w-muted: var(--muted); --w-border: var(--border); --w-accent: var(--blue);
}
.CHART > div { position: relative; }
.CHART > div > svg { display: block; width: 100%; height: 100%; font-family: var(--w-font); color: var(--w-text-2); }
.CHART text { font-family: var(--w-font); }   /* every label in Exo 2 (D3 axes write sans-serif on their own) */
`;
  const colourBlock = () => `/* ===== COLOURS (D3 Studio) ===== */\n.CHART { ${colours.map((c, i) => `--w-c${i + 1}: ${c || `var(--c${i + 1})`};`).join(' ')} }\n`;
  const COLOUR_BLOCK = /\/\*\s*=====\s*COLOURS[^*]*\*\/[^}]*\}\n?/;
  function styleCss(name) {
    const old = editing?.styleCss;
    if (!old) return STYLE_BASE(name) + colourBlock();
    return COLOUR_BLOCK.test(old) ? old.replace(COLOUR_BLOCK, colourBlock()) : old.replace(/\s*$/, '\n') + colourBlock();
  }
  let drawT = 0, still = false;   // still: draw without motion (a chart type switch fades instead)
  function draw() { clearTimeout(drawT); drawT = setTimeout(drawNow, 16); }
  function drawNow() {
    clearTimeout(drawT); saveState();
    if (!active) return;
    const pv = $('pv'), stt = $('status');
    ApexWidget.useStyle({ id: 'chart-builder-preview', styleCss: styleCss($('name').value || 'Chart') }, pv);
    if (pv.children.length !== 1) pv.innerHTML = '<div style="width:100%;height:100%;overflow:hidden"></div>';
    const W = Math.max(60, Math.floor(pv.clientWidth)), H = Math.max(60, Math.floor(pv.clientHeight)), th = ApexWidget.theme(pv);
    const data = (rows || sampleRows()).map(r => ({ ...r }));
    const ins = Object.fromEntries(inputs.map(i => [i.key, { key: i.key, label: i.label, role: i.role, agg: links[i.key]?.agg || i.agg, field: links[i.key] ? `${source?.d.name}.${links[i.key].col}` : '' }]));
    try {
      D3Render.draw(pv.firstElementChild, code, data, { W, H, colors: colours.map((c, i) => c || th.colors[i]), opts: clone(nest(opts)), theme: th, inputs: ins, motion: !still });
      stt.className = 'status'; stt.textContent = note;
    } catch (e) { stt.className = 'status err'; stt.textContent = `The chart's code failed: ${e.message}`; }
  }
  // opts paths ('grid.y') -> the object the code reads (opts.grid.y).
  function nest(flat) { const o = {}; for (const [p, v] of Object.entries(flat)) ApexWidget.setAt(o, p, v); return o; }

  // ---- open / new / save / publish ----
  async function refreshList() {
    [all, live] = await Promise.all([ChartRegistry.scan(DEV, { only: m => m.kind === 'd3' }), DNFS.list(LIVE).then(es => new Set(es.filter(e => e.dir).map(e => e.name))).catch(() => new Set())]);
    $('openmenu').innerHTML = all.length ? all.map(m => `<div data-act="${esc(m.id)}">${esc(m.name)}<small>${esc(m.category || '')}${m.builder ? '' : ' · made in D3 Studio (opens as code)'}${live.has(m.id) ? ' · published' : ''}</small></div>`).join('') : '<div class="off">No saved charts yet</div>';
  }
  Menus.bind($('open'), $('openmenu'), id => { const m = all.find(x => x.id === id); if (m) { show(); openChart(m); } });
  function openChart(m) {
    editing = m || null; rows = null;
    const b = m?.builder || {};
    if (!m) { tpl = ChartTemplates.get('bar'); custom = false; code = tpl.code; inputs = clone(tpl.inputs); options = clone(tpl.options); links = {}; colours = Array(8).fill(null); sort = 'desc'; top = 20; size = { w: 26, h: 14 }; }
    else {
      tpl = b.template ? ChartTemplates.get(b.template) : null;
      custom = !tpl || !!b.custom || (m.codeJs || '') !== tpl.code;
      code = m.codeJs || ''; inputs = clone(m.inputs || []);
      options = (m.options || []).filter(o => o.type !== 'color');
      if (tpl && !custom) options = clone(tpl.options);   // not custom: exactly the chart type's settings now (added ones in, removed ones out)
      else if (tpl) options = [...options, ...clone(tpl.options).filter(o => !options.some(x => x.path === o.path))];
      links = clone(b.links || {}); sort = m.specJson?.query?.sort || 'desc'; top = +m.specJson?.query?.top || 20;
      size = b.size || { w: 26, h: 14 };
      colours = Array(8).fill(null); for (const [, n, v] of String(m.styleCss || '').matchAll(/--w-c(\d):\s*(#[0-9a-f]{3,8})\s*;/gi)) colours[+n - 1] = v;
      if (b.source) setSourceQuiet(b.source);
    }
    opts = { ...defaults(options), ...(m?.builder?.opts || {}) };
    $('name').value = m?.name || ''; 
    pushCode();
    drawTypes(); drawColours(); drawOpts(); drawSlots(); drawCustom(); syncCat(); loadData();
  }
  function setSourceQuiet(key) { source = sources.find(s => s.key === key) || source; }
  $('new').onclick = async () => {
    if (active && !await UI.confirm('Start a new chart? Unsaved changes to this one are lost.', { ok: 'New chart' })) return;
    show(); openChart(null);
  };
  // Empty page -> working: the settings slide in from the right, the chart fades in.
  let active = false;
  function show() {
    if (active) return;
    active = true; $('card').classList.add('fade'); $('cb').classList.remove('empty');
    requestAnimationFrame(() => requestAnimationFrame(() => $('card').classList.remove('fade')));
  }

  // ---- this window remembers where it was: a refresh (F5) comes back to the same chart, unsaved changes and all ----
  // Kept in a file (workspace/chart-builder/builder-state.json), not browser storage: the server's port changes on every start and
  // browser storage belongs to one port. Written shortly after each change; the open chart's id comes back with it.
  const STATE_FILE = 'workspace/chart-builder/builder-state.json';
  let stateT = 0, stateText = '';
  function saveState() {
    const text = JSON.stringify(!active ? { active: false } : { active: true, editing: editing?.id || null, tpl: tpl?.id || null, custom, code, inputs, options, links, opts, colours, sort, top, size,
      source: source?.key || '', sampleIdx, name: $('name').value });
    if (text === stateText) return;
    stateText = text; clearTimeout(stateT);
    stateT = setTimeout(() => DNFS.writeText(STATE_FILE, text).catch(() => {}), 150);
  }
  addEventListener('beforeunload', () => { if (stateT) { clearTimeout(stateT); DNFS.writeText(STATE_FILE, stateText).catch(() => {}); } });   // a refresh right after a change
  async function restoreState() {
    let st = null; try { st = await DNFS.readJSON(STATE_FILE); } catch {}
    stateText = JSON.stringify(st || {});
    if (!st?.active) return false;
    editing = all.find(x => x.id === st.editing) || null;
    tpl = st.tpl ? ChartTemplates.get(st.tpl) : null; custom = !!st.custom; code = !custom && tpl ? tpl.code : st.code || '';   // not custom: the chart type's current code
    inputs = st.inputs || clone(tpl?.inputs || []); options = st.options || clone(tpl?.options || []);
    if (tpl && !custom) options = clone(tpl.options);   // not custom: exactly the chart type's settings now (added ones in, removed ones out)
    else if (tpl) options = [...options, ...clone(tpl.options).filter(o => !options.some(x => x.path === o.path))];
    for (const o of options) if (!(o.path in (st.opts || {})) && o.type !== 'color') (st.opts ||= {})[o.path] = o.default;
    links = st.links || {}; opts = st.opts || defaults(options); colours = st.colours || Array(8).fill(null);
    sort = st.sort || 'desc'; top = +st.top || 20; size = st.size || { w: 26, h: 14 };
    if (st.source) setSourceQuiet(st.source);
    sampleIdx = +st.sampleIdx || 0;
    $('name').value = st.name || '';
    active = true; $('cb').classList.add('instant'); $('cb').classList.remove('empty');
    setTimeout(() => $('cb').classList.remove('instant'), 300);
    drawTypes(); drawColours(); drawOpts(); drawSlots(); drawCustom(); loadData();
    return true;
  }

  function thumb() {
    const svg = $('pv').querySelector('svg'); if (!svg) return null;
    // The thumbnail (Dashboard Builder > Add chart) = the chart exactly as drawn here: every element keeps its computed
    // look (fonts, colours), and the border around the chart (Chart > Border) is left out.
    const c = svg.cloneNode(true), cs = getComputedStyle(svg), src = [svg, ...svg.querySelectorAll('*')], dst = [c, ...c.querySelectorAll('*')];
    src.forEach((n, i) => { const k = getComputedStyle(n), d = dst[i];
      for (const p of ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'opacity', 'font-family', 'font-size', 'font-weight', 'display']) d.style.setProperty(p, k.getPropertyValue(p)); });
    c.querySelectorAll('.chart-border').forEach(n => n.remove());
    if (!c.getAttribute('viewBox')) c.setAttribute('viewBox', `0 0 ${svg.clientWidth || 100} ${svg.clientHeight || 80}`);
    c.setAttribute('xmlns', 'http://www.w3.org/2000/svg'); c.setAttribute('width', '100'); c.setAttribute('height', '80');
    c.removeAttribute('class'); c.style.color = cs.color; c.style.width = c.style.height = ''; c.style.display = 'block';
    const root = getComputedStyle($('pv'));
    return new XMLSerializer().serializeToString(c).replace(/var\((--[\w-]+)\)/g, (s, v) => root.getPropertyValue(v).trim() || s);
  }
  async function save() {
    const name = $('name').value.trim(); if (!name) { $('name').focus(); throw new Error('Enter a Chart name (above the chart) before you Save or Publish.'); }
    if (!code.trim()) throw new Error('The chart has no code.');
    D3Render.compile(code, inputs.map(i => i.key));   // a syntax error stops the save
    const id = editing?.id || ChartRegistry.slug(name);
    if (!editing && all.some(m => m.id === id) && !await UI.confirm(`A chart "${id}" already exists. Replace it?`, { danger: true, ok: 'Replace' })) return null;
    const dir = `${DEV}/${id}`, pic = thumb();
    const ins = inputs.map(i => ({ key: i.key, label: i.label, role: i.role, axis: i.axis, ...(i.role === 'measure' ? { agg: links[i.key]?.agg || i.agg || 'sum' } : {}), ...(i.optional ? { optional: true } : {}) }));
    const m = {
      id, name, description: editing?.description || '', category: catOf(),
      version: (+editing?.version || 0) + 1, kind: 'd3', spec: 'spec.json', style: 'style.css', code: 'd3-code.js', sample: 'sample.json',
      ...(pic ? { thumb: 'thumb.svg' } : {}), inputs: ins,
      options: colours.map((_, i) => ({ path: `colors.${i}`, label: `Color ${i + 1}`, group: 'Colors', type: 'color', default: null, show: true }))
        .concat(options.map(o => ({ ...o, default: o.type === 'boolean' ? !!opts[o.path] : o.default }))),
      // No data paths: the fields attached here are for the preview only; each dashboard links its own (Dashboard Builder).
      builder: { template: tpl?.id || null, custom, opts, size },
      updated: new Date().toISOString(),
    };
    await DNFS.writeText(`${dir}/d3-code.js`, code);
    await DNFS.writeJSON(`${dir}/sample.json`, tpl?.sample || editing?.sampleRows || []);
    await DNFS.writeJSON(`${dir}/spec.json`, { $kind: 'd3', data: ins, query: { sort, top } });
    await DNFS.writeText(`${dir}/style.css`, styleCss(name));
    if (pic) await DNFS.writeText(`${dir}/thumb.svg`, pic);
    await DNFS.writeJSON(`${dir}/${ChartRegistry.MANIFEST}`, m);
    await refreshList();
    editing = all.find(x => x.id === id) || editing;
    return { id, dir, m };
  }
  $('save').onclick = UI.guard(async () => { const s = await save(); if (s) UI.toast(`Saved "${s.m.name}". Publish puts it in the Dashboard Builder.`, 'ok'); });
  $('publish').onclick = UI.guard(async () => {
    const s = await save(); if (!s) return;
    const to = `${LIVE}/${s.id}`;
    if (!live.has(s.id) && !await UI.confirm(`Publish "${s.m.name}"? It is listed in the Dashboard Builder's Add chart (${s.m.category}).`, { ok: 'Publish' })) return;
    await DNFS.remove(to, { recursive: true }).catch(() => {});
    await DNFS.copy(s.dir, to, { overwrite: true });
    await refreshList();
    UI.toast(`Published "${s.m.name}": Dashboard Builder > Add chart (${s.m.category}).`, 'ok');
  });
  // Delete: the chart's folder in the dev folder (workspace/chart-builder/dev/<id>/) and nothing else. The published
  // copy (workspace/chart-builder/published/) is NEVER touched: Dashboard Builder charts keep working.
  $('del').onclick = UI.guard(async () => {
    const id = editing?.id, name = $('name').value.trim() || 'this chart';
    if (!id) {   // never saved: just drop it
      if (!await UI.confirm(`Discard ${name}? It was never saved.`, { danger: true, ok: 'Discard' })) return;
      return resetPage();
    }
    if (!/^[A-Za-z0-9_-]+$/.test(id) || id.startsWith('_')) throw new Error(`Not a chart folder: "${id}".`);
    const dir = `${DEV}/${id}`;
    if (!dir.startsWith(DEV + '/') || dir.startsWith(LIVE)) throw new Error('Refused: only the dev folder can be deleted from here.');
    const pub = live.has(id) ? ' Its published copy stays (Dashboard Builder charts keep working).' : '';
    if (!await UI.confirm(`Delete "${name}" from Chart Builder (${dir})?${pub}`, { danger: true, ok: 'Delete' })) return;
    await DNFS.remove(dir, { recursive: true });
    await refreshList();
    UI.toast(`Deleted "${name}" (dev folder).${pub}`, 'ok');
    resetPage();
  });
  function resetPage() {   // back to the empty grid
    editing = null; active = false; rows = null; links = {}; source = null;
    $('cb').classList.add('empty'); $('name').value = ''; DataWindow.close(); saveState();
  }
  $('name').oninput = () => draw();

  // Folded sections stay folded next time (this browser).
  document.querySelectorAll('details.sec').forEach(d => {
    const key = 'chartbuilder.fold.' + d.querySelector('summary').textContent;
    try { if (localStorage.getItem(key) === '1') d.open = false; } catch {}
    d.addEventListener('toggle', () => { try { localStorage.setItem(key, d.open ? '0' : '1'); } catch {} });
  });

  // ---- start ----
  UI.guard(async () => {
    document.title = 'Chart Builder';
    await Promise.all([refreshList(), loadSources()]);
    const want = UI.params().chart, m = want ? all.find(x => x.id === want) : null;
    if (m) { if (m.builder?.source) setSourceQuiet(m.builder.source); show(); openChart(m); }
    else if (!await restoreState()) saveState();   // nothing to come back to: the empty grid
    if (active && DataWindow.wasOpen()) openData();   // Edit Data was open before the refresh
  })();
})();
