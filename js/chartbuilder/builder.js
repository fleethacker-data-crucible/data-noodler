// Chart Builder (html/chart-builder.html): the simple way to make a chart. Pick a chart type, pick a dataset, drag its
// fields onto the slots (Category, Value ...), set colours and a few settings; Code shows the D3 code behind it, which
// can be edited or replaced with code from the web (the chart is then "custom": the chart type no longer rewrites it).
// It saves the same chart package as D3 Studio (d3-studio/dev/<id>/; Publish copies it to d3-studio/live/<id>/ for
// Dashboard > Charts), plus chart.json "builder" { template, custom, links, size } so it reopens here as it was.
(() => {
  const { $, esc } = UI;
  const DEV = ChartRegistry.CHARTS_DEV, LIVE = ChartRegistry.CHARTS_LIVE, G = 24;
  const CATS = ['Bar', 'Line & Area', 'Pie & Donut', 'Scatter', 'Hierarchy', 'Network', 'Map', 'Tables', 'Controls', 'Other'];
  const CAT_OF = { bar: 'Bar', hbar: 'Bar', line: 'Line & Area', area: 'Line & Area', scatter: 'Scatter', pie: 'Pie & Donut', donut: 'Pie & Donut' };
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
    const many = new Set(sources.map(s => s.folder)).size > 1;
    $('src').innerHTML = `<option value="">Sample data</option>${sources.map(s => `<option value="${esc(s.key)}">${esc(s.d.name)}${many ? ` (${esc(s.proj)})` : ''}</option>`).join('')}`;
  }
  function setSource(key) {
    source = sources.find(s => s.key === key) || null;
    $('src').value = source?.key || '';
    // Links keep their field where the new dataset has it.
    for (const k of Object.keys(links)) if (!columns().some(c => c.name === links[k].col)) delete links[k];
    drawFields(); drawSlots(); loadData();
  }
  $('src').onchange = () => setSource($('src').value);

  function drawFields() {
    const q = $('fq').value.trim().toLowerCase();
    const cols = columns().filter(c => !q || c.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
    $('fields').innerHTML = cols.map(c => { const k = kindOf(c.type); return `<div class="chip" draggable="true" data-col="${esc(c.name)}" title="${esc(c.name)} (${esc(c.type)})"><span class="t ${k}">${k === 'num' ? '#' : k === 'date' ? 'D' : 'Aa'}</span><span>${esc(c.name)}</span></div>`; }).join('');
    $('fhint').hidden = !!columns().length && !q;
    if (!source) $('fhint').textContent = 'Pick a dataset, then drag its fields onto the slots above the chart (or straight onto the chart).';
    else if (q && !cols.length) { $('fhint').hidden = false; $('fhint').textContent = 'No field matches.'; }
  }
  $('fq').oninput = drawFields;
  $('fields').addEventListener('dragstart', e => { const c = e.target.closest('.chip'); if (c) { e.dataTransfer.setData('text/x-field', c.dataset.col); e.dataTransfer.effectAllowed = 'copy'; } });
  // Double-click a field: it goes into the first empty slot that suits it.
  $('fields').addEventListener('dblclick', e => { const c = e.target.closest('.chip'); if (c) autoPlace(c.dataset.col); });

  // ---- slots: one per input; drop a field on it ----
  const AGG_TXT = { sum: 'Sum', avg: 'Average', count: 'Count', count_distinct: 'Count distinct', median: 'Median', min: 'Min', max: 'Max', none: 'Each row' };
  function drawSlots() {
    $('slots').innerHTML = inputs.map(i => {
      const l = links[i.key];
      const agg = i.role === 'measure' ? `<select data-agg="${esc(i.key)}" title="How the values are combined">${Object.entries(AGG_TXT).map(([v, t]) => `<option value="${v}" ${(l?.agg || i.agg || 'sum') === v ? 'selected' : ''}>${t}</option>`).join('')}</select>` : '';
      return `<div class="slot ${l ? 'set' : ''}" data-key="${esc(i.key)}"><b>${esc(i.label || i.key)}</b>${l ? `<span class="f">${esc(l.col)}</span>${agg}<button class="x" data-clear="${esc(i.key)}" title="Remove">×</button>` : `<span>drop a field</span>`}</div>`;
    }).join('');
    layout();
  }
  $('slots').addEventListener('change', e => { const k = e.target.dataset.agg; if (k && links[k]) { links[k].agg = e.target.value; loadData(); } });
  $('slots').addEventListener('click', e => { const k = e.target.dataset.clear; if (k) { delete links[k]; drawSlots(); loadData(); } });
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
    useTemplate(t);
  };
  function useTemplate(t) {
    // Fields stay on the slot with the same key (x, y): a Column chart becomes a Line chart with the same data.
    tpl = t; custom = false; code = t.code; inputs = clone(t.inputs); options = clone(t.options);
    opts = { ...defaults(options), ...Object.fromEntries(Object.entries(opts).filter(([p]) => options.some(o => o.path === p))) };
    for (const k of Object.keys(links)) { const i = inputs.find(x => x.key === k); if (!i) delete links[k]; else if (i.role === 'measure' && i.agg === 'none') links[k].agg = 'none'; else if (i.role === 'measure' && links[k].agg === 'none') links[k].agg = i.agg || 'sum'; else if (i.role !== 'measure') delete links[k].agg; }
    if (t.sort) sort = t.sort; else if (sort === 'label' && !t.sort) sort = 'desc';
    top = t.top || (top >= 1000 ? 20 : top);
    if (!$('cat').dataset.touched) $('cat').value = CAT_OF[t.id] || 'Other';
    if (editor) editor.value = code;
    drawTypes(); drawOpts(); drawSlots(); drawCustom(); loadData();
  }

  // ---- colours and settings ----
  function drawColours() {
    $('colours').innerHTML = '';
    colours.forEach((c, i) => $('colours').append(ColorPicker.swatch(c, { allowTheme: true, onInput: v => { colours[i] = v || null; draw(); }, onChange: v => { colours[i] = v || null; draw(); } })));
  }
  function drawOpts() {
    $('opts').innerHTML = options.filter(o => o.type === 'boolean').map(o => `<label class="opt"><input type="checkbox" data-p="${esc(o.path)}" ${opts[o.path] ? 'checked' : ''}> ${esc(o.label)}</label>`).join('') || '<div class="hintbox">This chart has no settings.</div>';
    const ordered = inputs.some(i => i.role === 'measure' && (links[i.key]?.agg || i.agg) !== 'none');
    $('orderBox').hidden = !ordered;
    $('sort').value = sort; $('top').value = top;
  }
  $('opts').onchange = e => { const p = e.target.dataset.p; if (p) { opts[p] = e.target.checked; draw(); } };
  $('sort').onchange = () => { sort = $('sort').value; loadData(); };
  $('top').onchange = () => { top = Math.max(1, +$('top').value || 20); loadData(); };
  $('cat').innerHTML = CATS.map(c => `<option>${c}</option>`).join('');
  $('cat').onchange = () => { $('cat').dataset.touched = '1'; };

  // ---- code drawer ----
  let editor = null;
  $('codeBtn').onclick = () => {
    $('drawer').hidden = !$('drawer').hidden;
    if (!$('drawer').hidden && !editor) {
      editor = SqlEditor.mount($('code'), { lang: 'js', onChange: () => { if (editor.value === code) return; code = editor.value; if (!custom) { custom = true; drawCustom(); } draw(); } });
      editor.value = code;
    }
    $('vars').textContent = `Ready made: data (rows), ${inputs.map(i => `${i.key.toUpperCase()}(d) = ${i.label}`).join(', ')}, W, H, colors[0..7], opts, theme`;
    layout();
  };
  $('closeCode').onclick = () => { $('drawer').hidden = true; layout(); };
  $('reset').onclick = async () => {
    if (!tpl) return UI.toast('This chart was made as code: it has no chart type to go back to. Pick one on the right to start from it.');
    if (custom && !await UI.confirm('Throw away your code changes and use the chart type\'s code again?', { danger: true, ok: 'Reset' })) return;
    useTemplate(tpl);
  };
  function drawCustom() { $('custom').hidden = !custom; $('codeBtn').textContent = custom ? 'Code (custom)' : 'Code'; }

  // ---- stage layout: the 24px grid with a line at the centre; the card centred on it, its slots above it ----
  function layout() {
    const st = $('stage'), W = st.clientWidth, c = Math.floor(W / 2);
    st.style.setProperty('--gx', `${c % G}px`);
    const avail = st.clientHeight - ($('drawer').hidden ? 0 : $('drawer').offsetHeight);
    const cw = size.w * G, ch = Math.min(size.h * G, Math.max(6 * G, Math.floor((avail - 6 * G) / G) * G));
    const left = c - Math.round(size.w / 2) * G, topPx = 5 * G;
    Object.assign($('card').style, { left: `${left}px`, top: `${topPx}px`, width: `${cw + 1}px`, height: `${ch + 1}px` });
    Object.assign($('slots').style, { left: `${left}px`, width: `${cw}px`, top: `${3 * G + 10}px` });
    $('sz').textContent = `${cw} x ${ch} px`;
    draw();
  }
  new ResizeObserver(() => layout()).observe($('stage'));
  // Resize the card in whole cells: try the chart at Dashboard sizes.
  $('rz').addEventListener('pointerdown', ev => {
    ev.preventDefault();
    const sx = ev.clientX, sy = ev.clientY, s0 = { ...size };
    const move = e => { size = { w: Math.max(8, s0.w + 2 * Math.round((e.clientX - sx) / G / 2) * 1), h: Math.max(6, s0.h + Math.round((e.clientY - sy) / G)) }; layout(); };
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
      note = !source ? 'Sample data: pick a dataset on the left.' : `Sample data: drop a field on ${missing.map(i => i.label || i.key).join(' and ')}.`;
      return draw();
    }
    const m = manifest(), w = { dataset: source.d.name, inputs: Object.fromEntries(Object.entries(links).map(([k, l]) => [k, { ...l }])), sort, top };
    try {
      const t0 = performance.now(), r = await Engine.call('query', { query: ApexWidget.query(m, w), views: Engine.views([source.d]) });
      if (n !== seq) return;
      rows = ApexWidget.shape(m, w, ApexWidget.objects(r), columns());
      note = `${rows.length.toLocaleString()} rows from ${source.d.name} · ${UI.ms(performance.now() - t0)}`;
    } catch (e) { if (n !== seq) return; rows = null; note = `Data: ${String(e.message || e).split('\n')[0]}`; }
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
`;
  const colourBlock = () => `/* ===== COLOURS (D3 Studio) ===== */\n.CHART { ${colours.map((c, i) => `--w-c${i + 1}: ${c || `var(--c${i + 1})`};`).join(' ')} }\n`;
  const COLOUR_BLOCK = /\/\*\s*=====\s*COLOURS[^*]*\*\/[^}]*\}\n?/;
  function styleCss(name) {
    const old = editing?.styleCss;
    if (!old) return STYLE_BASE(name) + colourBlock();
    return COLOUR_BLOCK.test(old) ? old.replace(COLOUR_BLOCK, colourBlock()) : old.replace(/\s*$/, '\n') + colourBlock();
  }
  let drawT = 0;
  function draw() { clearTimeout(drawT); drawT = setTimeout(drawNow, 16); }
  function drawNow() {
    const pv = $('pv'), stt = $('status');
    ApexWidget.useStyle({ id: 'chart-builder-preview', styleCss: styleCss($('name').value || 'Chart') }, pv);
    if (pv.children.length !== 1) pv.innerHTML = '<div style="width:100%;height:100%;overflow:hidden"></div>';
    const W = Math.max(60, Math.floor(pv.clientWidth)), H = Math.max(60, Math.floor(pv.clientHeight)), th = ApexWidget.theme(pv);
    const data = (rows || tpl?.sample || editing?.sampleRows || []).map(r => ({ ...r }));
    const ins = Object.fromEntries(inputs.map(i => [i.key, { key: i.key, label: i.label, role: i.role, agg: links[i.key]?.agg || i.agg, field: links[i.key] ? `${source?.d.name}.${links[i.key].col}` : '' }]));
    try {
      D3Render.draw(pv.firstElementChild, code, data, { W, H, colors: colours.map((c, i) => c || th.colors[i]), opts: clone(nest(opts)), theme: th, inputs: ins });
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
  Menus.bind($('open'), $('openmenu'), id => { const m = all.find(x => x.id === id); if (m) openChart(m); });
  function openChart(m) {
    editing = m || null; rows = null;
    const b = m?.builder || {};
    if (!m) { tpl = ChartTemplates.get('bar'); custom = false; code = tpl.code; inputs = clone(tpl.inputs); options = clone(tpl.options); links = {}; colours = Array(8).fill(null); sort = 'desc'; top = 20; size = { w: 26, h: 14 }; }
    else {
      tpl = b.template ? ChartTemplates.get(b.template) : null;
      custom = !tpl || !!b.custom || (m.codeJs || '') !== tpl.code;
      code = m.codeJs || ''; inputs = clone(m.inputs || []);
      options = (m.options || []).filter(o => o.type !== 'color');
      links = clone(b.links || {}); sort = m.specJson?.query?.sort || 'desc'; top = +m.specJson?.query?.top || 20;
      size = b.size || { w: 26, h: 14 };
      colours = Array(8).fill(null); for (const [, n, v] of String(m.styleCss || '').matchAll(/--w-c(\d):\s*(#[0-9a-f]{3,8})\s*;/gi)) colours[+n - 1] = v;
      if (b.source) setSourceQuiet(b.source);
    }
    opts = { ...defaults(options), ...(m?.builder?.opts || {}) };
    $('name').value = m?.name || ''; $('cat').value = m?.category || CAT_OF[tpl?.id] || 'Other'; delete $('cat').dataset.touched;
    if (editor) editor.value = code;
    drawTypes(); drawColours(); drawOpts(); drawFields(); drawSlots(); drawCustom(); loadData();
  }
  function setSourceQuiet(key) { source = sources.find(s => s.key === key) || source; $('src').value = source?.key || ''; }
  $('new').onclick = async () => { if (await UI.confirm('Start a new chart? Unsaved changes to this one are lost.', { ok: 'New chart' })) openChart(null); };

  function thumb() {
    const svg = $('pv').querySelector('svg'); if (!svg) return null;
    const c = svg.cloneNode(true), cs = getComputedStyle(svg);
    if (!c.getAttribute('viewBox')) c.setAttribute('viewBox', `0 0 ${svg.clientWidth || 100} ${svg.clientHeight || 80}`);
    c.setAttribute('xmlns', 'http://www.w3.org/2000/svg'); c.setAttribute('width', '100'); c.setAttribute('height', '80');
    c.removeAttribute('class'); c.setAttribute('style', `color:${cs.color};font-family:${cs.fontFamily}`);
    const root = getComputedStyle($('pv'));
    return new XMLSerializer().serializeToString(c).replace(/var\((--[\w-]+)\)/g, (s, v) => root.getPropertyValue(v).trim() || s);
  }
  async function save() {
    const name = $('name').value.trim(); if (!name) { $('name').focus(); throw new Error('Give the chart a name (top of the grid).'); }
    if (!code.trim()) throw new Error('The chart has no code.');
    D3Render.compile(code, inputs.map(i => i.key));   // a syntax error stops the save
    const id = editing?.id || ChartRegistry.slug(name);
    if (!editing && all.some(m => m.id === id) && !await UI.confirm(`A chart "${id}" already exists. Replace it?`, { danger: true, ok: 'Replace' })) return null;
    const dir = `${DEV}/${id}`, pic = thumb();
    const ins = inputs.map(i => ({ key: i.key, label: i.label, role: i.role, axis: i.axis, ...(i.role === 'measure' ? { agg: links[i.key]?.agg || i.agg || 'sum' } : {}), ...(i.optional ? { optional: true } : {}) }));
    const m = {
      id, name, description: editing?.description || '', category: $('cat').value || 'Other',
      version: (+editing?.version || 0) + 1, kind: 'd3', spec: 'spec.json', style: 'style.css', code: 'd3-code.js', sample: 'sample.json',
      ...(pic ? { thumb: 'thumb.svg' } : {}), inputs: ins,
      options: colours.map((_, i) => ({ path: `colors.${i}`, label: `Colour ${i + 1}`, group: 'Colours', type: 'color', default: null, show: true }))
        .concat(options.map(o => ({ ...o, default: o.type === 'boolean' ? !!opts[o.path] : o.default }))),
      studio: { project: source?.folder || '', table: source?.d.name || '', links: Object.fromEntries(Object.entries(links).map(([k, l]) => [k, `${source?.d.name}.${l.col}`])) },
      builder: { template: tpl?.id || null, custom, links, opts, size, source: source?.key || '' },
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
  $('save').onclick = UI.guard(async () => { const s = await save(); if (s) UI.toast(`Saved "${s.m.name}". Publish puts it in Dashboard > Charts.`, 'ok'); });
  $('publish').onclick = UI.guard(async () => {
    const s = await save(); if (!s) return;
    const to = `${LIVE}/${s.id}`;
    if (!live.has(s.id) && !await UI.confirm(`Publish "${s.m.name}"? It is listed in Dashboard > Charts (${s.m.category}).`, { ok: 'Publish' })) return;
    await DNFS.remove(to, { recursive: true }).catch(() => {});
    await DNFS.copy(s.dir, to, { overwrite: true });
    await refreshList();
    UI.toast(`Published "${s.m.name}": Dashboard > Charts (${s.m.category}).`, 'ok');
  });
  $('name').oninput = () => draw();

  // ---- start ----
  UI.guard(async () => {
    document.title = 'Chart Builder';
    await Promise.all([refreshList(), loadSources()]);
    const want = UI.params().chart, m = want ? all.find(x => x.id === want) : null;
    if (m?.builder?.source) setSourceQuiet(m.builder.source);
    openChart(m);
  })();
})();
