// D3 Studio (html/d3-studio.html): builds CHARTS (D3; "widgets" are something else: several things in one box).
// Paste D3 code, attach sample data, edit until it looks right (the preview redraws on every change), lock in the
// default colours. Save = the chart package into d3-studio/dev/<id>/ (work in progress, not on the Dashboard);
// Publish = Save + copy it to d3-studio/live/<id>/ (Dashboard > Charts lists only live charts).
// A chart package (kind 'd3'):
//   <dir>/widget.json   { id, name, description, category, kind: 'd3', spec, style, code, sample, thumb, inputs, options }
//   <dir>/d3-code.js    the D3 code (js/widgets/d3-render.js says what it is called with); in dev it is the live code
//                       file, the same as the editor both ways (edit it on disk and the studio redraws)
//   <dir>/sample.json   sample rows (drawn on the Dashboard until a dataset is connected)
//   <dir>/spec.json     { "$kind": "d3", "data": inputs }
//   <dir>/style.css     the chart's ONLY style; the D3 Studio colour block holds --w-c1..c8 (its default colours)
//   <dir>/thumb.svg     picture of the preview for the Dashboard's Charts list
(() => {
  const { $, esc } = UI;
  const DEV = WidgetRegistry.CHARTS_DEV, LIVE_DIR = WidgetRegistry.CHARTS_LIVE;
  const CATS = ['Bar', 'Line & Area', 'Pie & Donut', 'Scatter', 'Hierarchy', 'Network', 'Map', 'Tables', 'Controls', 'Other'];
  const AGGS = ['sum', 'avg', 'count', 'count_distinct', 'median', 'min', 'max', 'none'];
  const COLOUR_BLOCK = /\/\*\s*=====\s*COLOURS[^*]*\*\/[^}]*\}\n?/;
  const SHADOW = /\/\*\s*=====\s*SHADOW\s*=====[^*]*\*\//;

  const SAMPLE_CODE = `// Bar chart. data = rows ({ x, y }: d.x = X Axis, d.y = Y Axis), el = the box, W x H = its size in px, colors = the 8 chart colours.
const margin = { top: 12, right: 12, bottom: 28, left: 44 };
const x = d3.scaleBand().domain(data.map(d => d.x)).range([margin.left, W - margin.right]).padding(0.2);
const y = d3.scaleLinear().domain([0, d3.max(data, d => d.y) || 1]).nice().range([H - margin.bottom, margin.top]);

const svg = d3.create('svg').attr('viewBox', [0, 0, W, H]);
// Dotted grid lines, each switched on / off in the widget settings (Settings: opts.grid.y = horizontal, opts.grid.x = vertical).
const dotted = g => g.call(g => g.select('.domain').remove()).selectAll('line').attr('stroke', theme.muted).attr('stroke-opacity', 0.6).attr('stroke-dasharray', '2,3');
if (opts.grid?.y) svg.append('g').attr('transform', \`translate(\${margin.left},0)\`)
    .call(d3.axisLeft(y).ticks(5).tickSize(-(W - margin.left - margin.right)).tickFormat('')).call(dotted);
if (opts.grid?.x) svg.append('g').attr('transform', \`translate(0,\${H - margin.bottom})\`)
    .call(d3.axisBottom(x).tickSize(-(H - margin.top - margin.bottom)).tickFormat('')).call(dotted);
svg.append('g').selectAll('rect').data(data).join('rect')
    .attr('x', d => x(d.x)).attr('y', d => y(d.y))
    .attr('width', x.bandwidth()).attr('height', d => y(0) - y(d.y))
    .attr('rx', 2).attr('fill', (d, i) => colors[0]);
svg.append('g').attr('transform', \`translate(0,\${H - margin.bottom})\`).call(d3.axisBottom(x).tickSizeOuter(0));
svg.append('g').attr('transform', \`translate(\${margin.left},0)\`).call(d3.axisLeft(y).ticks(5))
    .call(g => g.select('.domain').remove());
return svg.node();
`;
  const SAMPLE_DATA = JSON.stringify([
    { x: 'North', y: 42 }, { x: 'South', y: 28 }, { x: 'East', y: 35 },
    { x: 'West', y: 51 }, { x: 'Central', y: 19 }], null, 2);

  // ---- state ----
  let editing = null;           // manifest of the chart loaded from the dev folder (null = new)
  let rows = [];                // parsed sample rows
  let inputs = [];              // [{ key, label, role, agg, optional }]
  let colours = Array(8).fill(null);   // '#rrggbb' or null (= theme colour)
  let settings = [];            // widget.json options besides the colours: [{ path, label, group, type, default, min, max, step, choices, show }]
  const NEW_SETTINGS = [{ path: 'grid.y', label: 'Horizontal grid lines', group: 'Grid', type: 'boolean', default: true, show: true },
    { path: 'grid.x', label: 'Vertical grid lines', group: 'Grid', type: 'boolean', default: true, show: true }];
  let all = [];                 // every chart in the dev folder (ids taken, categories)

  // Code runs only on Run (or Ctrl+Enter); the preview draws the last run code. Settings, colours and sample data redraw
  // live (with that code). Edits still go to the live code file at once. Run turns blue while the editor has unrun changes.
  let ran = '';
  const code = SqlEditor.mount($('code'), { lang: 'js', onChange: () => { if (liveText !== null) liveWrite(); markRun(); }, check: async text => checkCode(text) });
  const markRun = () => $('run').classList.toggle('ghost', code.value === ran);
  function run() { ran = code.value; markRun(); findSettings(true); draw(); }
  $('run').onclick = run;
  addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); } });
  // Pasted code: Observable notebook cells become plain code (js/d3studio/observable.js), and a fixed size
  // (width = 928, height = 500) becomes W / H, the widget box's size.
  const FIXED = /(?<![.\w$])(width|height)(\s*=\s*)\d+(?:\.\d+)?(?![\w.])/g;
  // Also on the Convert to D3 button (says so when there is nothing to change).
  $('convert').onclick = () => convertCode(true);
  $('code').querySelector('textarea').addEventListener('paste', () => setTimeout(() => convertCode(false)));
  function convertCode(asked) {
    const was = code.value, obs = ObservableImport.convert(was);
    const now = (obs ? obs.code : was).replace(FIXED, (s, n, eq) => `${n}${eq}${n === 'width' ? 'W' : 'H'}`);
    if (now === was) { if (asked) UI.toast('Already plain D3: nothing to convert.'); return; }
    const ta = $('code').querySelector('textarea'), at = obs ? now.length : ta.selectionStart + now.length - was.length;
    code.value = now; ta.focus(); ta.setSelectionRange(at, at); run();
    const said = [obs && 'Observable notebook code converted to plain D3', now !== (obs ? obs.code : was) && 'fixed width / height changed to W / H (the widget box size)'].filter(Boolean).join('; ');
    UI.toast(said.charAt(0).toUpperCase() + said.slice(1) + '.');
    obs?.notes.forEach(n => UI.toast(n, 'warn', 9000));
  }
  const data = SqlEditor.mount($('data'), { lang: 'json', onChange: () => { parseData(); schedule(); } });

  // ---- sample data: JSON rows (an array of objects, or { data: [...] }) or CSV / TSV (types guessed) ----
  function parse(text) {
    const t = text.trim(); if (!t) return [];
    if (/^[[{]/.test(t)) { const j = JSON.parse(t); const a = Array.isArray(j) ? j : Array.isArray(j.data) ? j.data : [j]; return a.filter(r => r && typeof r === 'object'); }
    const first = t.split('\n')[0];
    return (first.includes('\t') ? d3.tsvParse(t, d3.autoType) : d3.csvParse(t, d3.autoType)).slice();
  }
  let dataErr = '';
  function parseData() {
    try { rows = parse(data.value); dataErr = ''; } catch (e) { dataErr = `Sample data: ${e.message}`; return; }
    syncInputs();
  }
  // One input per sample column (plug and play: on the Dashboard each one is connected to a dataset column at once).
  // Charts use d.x (X Axis) and d.y (Y Axis): columns named x / y go to that axis. Otherwise numbers = measures (sum) on
  // the Y Axis; the 1st other column = X Axis, the 2nd = Series (colour, optional), more = Other. Edits are kept per key.
  function syncInputs() {
    const keys = [...new Set(rows.flatMap(r => Object.keys(r)))], old = new Map(inputs.map(i => [i.key, i]));
    const num = k => rows.some(r => typeof r[k] === 'number') && !rows.some(r => r[k] != null && typeof r[k] !== 'number');
    inputs = keys.map(k => old.get(k) || (num(k) ? { key: k, label: human(k), role: 'measure', agg: 'sum' } : { key: k, label: human(k), role: 'dimension' }));
    const taken = new Set(inputs.filter(i => i.axis).map(i => i.axis));
    for (const i of inputs) {
      if (i.axis) continue;
      i.axis = /^(x|y)$/i.test(i.key) ? i.key.toLowerCase() : i.role === 'measure' ? 'y' : !taken.has('x') ? 'x' : !taken.has('series') ? 'series' : 'other';
      if (i.axis === 'series') i.optional = true;
      taken.add(i.axis);
    }
    drawInputs();
  }
  const human = k => String(k).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());
  // Charts: d.x is always "X Axis" and d.y always "Y Axis" (ApexWidget.labelOf, kind d3).
  const labelOf = i => ApexWidget.labelOf({ kind: 'd3', inputs }, i);
  const AXES = [['x', 'X Axis'], ['y', 'Y Axis'], ['series', 'Series (colour)'], ['other', 'Other']];
  function drawInputs() {
    $('ins').innerHTML = inputs.length ? `<table><thead><tr><th>Field in code</th><th>Axis</th><th>Shown in settings as</th><th>Role</th><th>Aggregation</th><th>Optional</th></tr></thead><tbody>${inputs.map((i, k) => `<tr data-k="${k}">
      <td><code>d.${esc(i.key)}</code></td>
      <td><select data-f="axis">${AXES.map(([v, l]) => `<option value="${v}" ${i.axis === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></td>
      <td>${i.axis === 'other' ? `<input type="text" data-f="label" value="${esc(i.label)}">` : esc(labelOf(i))}</td>
      <td><select data-f="role"><option value="dimension" ${i.role === 'dimension' ? 'selected' : ''}>Dimension (group by)</option><option value="measure" ${i.role === 'measure' ? 'selected' : ''}>Measure (number)</option></select></td>
      <td>${i.role === 'measure' ? `<select data-f="agg">${AGGS.map(a => `<option value="${a}" ${i.agg === a ? 'selected' : ''}>${esc(ApexWidget.AGG_LABEL[a])}</option>`).join('')}</select>` : ''}</td>
      <td><input type="checkbox" data-f="optional" ${i.optional ? 'checked' : ''}></td></tr>`).join('')}</tbody></table>` : '<div class="help" style="padding:6px">No sample columns yet.</div>';
  }
  $('ins').addEventListener('change', e => {
    const f = e.target.dataset.f, i = inputs[+e.target.closest('tr')?.dataset.k]; if (!f || !i) return;
    if (f === 'optional') i.optional = e.target.checked || undefined;
    else if (f === 'role') { i.role = e.target.value; i.agg = i.role === 'measure' ? i.agg || 'sum' : undefined; drawInputs(); }
    else if (f === 'axis') { i.axis = e.target.value; drawInputs(); }
    else i[f] = e.target.value;
  });

  // ---- colours: 8 swatches; blank = the app theme colour (--c1..c8) ----
  function drawColours() {
    $('colours').innerHTML = '';
    colours.forEach((c, i) => $('colours').append(ColorPicker.swatch(c, { allowTheme: true, onInput: v => { colours[i] = v; draw(); }, onChange: v => { colours[i] = v; draw(); } })));
  }
  $('themecols').onclick = () => { colours = Array(8).fill(null); drawColours(); draw(); };
  const themeColour = i => getComputedStyle(document.documentElement).getPropertyValue(`--c${i + 1}`).trim();

  // ---- settings: the options the Dashboard's widget settings show for this widget; the code reads opts.<path> ----
  // Default = the value the preview uses (and the Dashboard until changed there).
  const TYPES = [['boolean', 'On / off'], ['number', 'Number'], ['select', 'List'], ['text', 'Text'], ['color', 'Colour']];
  const PATH = /^[A-Za-z_$][\w$]*(\.[\w$]+)*$/;
  const OPT_REF = /\bopts\??\.([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*)/g;
  const blankOf = t => t === 'boolean' ? true : t === 'number' ? 0 : t === 'color' ? null : '';
  const asType = (s, v) => s.type === 'boolean' ? !!v : s.type === 'number' ? (Number.isFinite(+v) ? +v : 0) : s.type === 'color' ? v || null : String(v ?? '');
  function drawSettings() {
    const def = (s, k) => s.type === 'boolean' ? `<input type="checkbox" data-f="default" ${s.default ? 'checked' : ''}>`
      : s.type === 'select' ? `<select data-f="default">${(s.choices || []).map(c => `<option ${c === s.default ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>`
      : s.type === 'color' ? `<span class="cp" data-k="${k}"></span>`
      : `<input type="${s.type === 'number' ? 'number' : 'text'}" data-f="default" value="${esc(s.default ?? '')}"${s.type === 'number' ? ` step="${s.step ?? 1}"` : ''}>`;
    const more = s => s.type === 'number' ? `<span class="rng">${['min', 'max', 'step'].map(f => `<input type="number" data-f="${f}" value="${esc(s[f] ?? '')}" placeholder="${f}" title="${f}">`).join('')}</span>`
      : s.type === 'select' ? `<input type="text" data-f="choices" value="${esc((s.choices || []).join(', '))}" placeholder="a, b, c" title="The list: comma separated">` : '';
    $('opts').innerHTML = settings.length ? `<table><thead><tr><th>In code</th><th>Shown in settings as</th><th>Group</th><th>Type</th><th title="The value the preview uses right now (and the Dashboard starts with): change it to test the chart">Value</th><th>Range / list</th><th title="Listed in the Dashboard widget settings (off = fixed at Value there)">On Dashboard</th><th></th></tr></thead><tbody>${settings.map((s, k) => `<tr data-k="${k}">
      <td><span class="op">opts.<input type="text" data-f="path" value="${esc(s.path)}" spellcheck="false"></span></td>
      <td><input type="text" data-f="label" value="${esc(s.label)}"></td>
      <td><input type="text" data-f="group" value="${esc(s.group)}" list="optgroups"></td>
      <td><select data-f="type">${TYPES.map(([v, l]) => `<option value="${v}" ${s.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
      <td>${def(s, k)}</td><td>${more(s)}</td>
      <td><input type="checkbox" data-f="show" ${s.show !== false ? 'checked' : ''} title="Off: kept in widget.json but not shown on the Dashboard"></td>
      <td class="acts"><button class="ib eye${s.hide ? ' off' : ''}" data-f="eye" title="${s.hide ? 'Hidden from the preview: click to show it' : 'Shown on the preview: click to hide it'}">${Icons.svg(s.hide ? 'eye-slash' : 'eye')}</button><button class="ib del" data-f="del" title="Remove this setting">${Icons.svg('x-circle')}</button></td></tr>`).join('')}</tbody></table>
      <datalist id="optgroups">${[...new Set(['General', ...settings.map(s => s.group).filter(Boolean)])].map(g => `<option value="${esc(g)}">`).join('')}</datalist>`
      : '<div class="help" style="padding:6px">No settings yet: Add setting, or Find in code (every <code>opts.&lt;name&gt;</code> the code reads).</div>';
    $('opts').querySelectorAll('.cp').forEach(span => { const s = settings[+span.dataset.k]; span.append(ColorPicker.swatch(s.default, { allowTheme: true, onInput: v => { s.default = v || null; draw(); }, onChange: v => { s.default = v || null; draw(); } })); });
  }
  function onSetting(e) {
    const f = e.target.dataset.f, k = +e.target.closest('tr')?.dataset.k, s = settings[k]; if (!f || !s) return;
    if (f === 'del' || f === 'eye') return;   // the click handler below
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    if (f === 'type') { s.type = v; s.default = blankOf(v); if (v === 'number') Object.assign(s, { min: s.min ?? 0, max: s.max ?? 100, step: s.step ?? 1 }); if (v === 'select') s.choices ||= []; drawSettings(); }
    else if (f === 'choices') { s.choices = v.split(',').map(c => c.trim()).filter(Boolean); if (e.type === 'change') { if (!s.choices.includes(s.default)) s.default = s.choices[0] ?? ''; drawSettings(); } }
    else if (f === 'default') s.default = asType(s, v);
    else if (f === 'min' || f === 'max' || f === 'step') s[f] = v === '' ? undefined : +v;
    else if (f === 'path') { s.path = v.trim(); e.target.classList.toggle('bad', !PATH.test(s.path)); }
    else s[f] = v;
    draw();
  }
  $('opts').addEventListener('input', e => { if (e.target.type !== 'checkbox' && e.target.tagName !== 'SELECT') onSetting(e); });
  $('opts').addEventListener('change', onSetting);
  // Row buttons: eye = show / hide this setting on the preview (studio only, not saved), red X = remove it.
  $('opts').addEventListener('click', e => {
    const b = e.target.closest('button[data-f]'), s = settings[+b?.closest('tr')?.dataset.k]; if (!b || !s) return;
    if (b.dataset.f === 'del') settings.splice(settings.indexOf(s), 1); else s.hide = !s.hide || undefined;
    drawSettings(); draw();
  });
  $('optsAdd').onclick = () => {
    let n = settings.length + 1; while (settings.some(s => s.path === `setting${n}`)) n++;
    settings.push({ path: `setting${n}`, label: `Setting ${n}`, group: 'General', type: 'boolean', default: true, show: true });
    drawSettings(); draw();
    $('opts').querySelector('tbody tr:last-child [data-f="path"]')?.select();
  };
  // Every opts.<path> the code reads that is not a setting yet (On / off, default on: change the type after).
  // Also done by Run (quiet = no toast when there is nothing new).
  function findSettings(quiet) {
    const have = new Set(settings.map(s => s.path)), found = [...new Set([...code.value.matchAll(OPT_REF)].map(m => m[1].replace(/\?\./g, '.')))]
      .filter(p => !/^(\$kind|colors)\b/.test(p) && !have.has(p) && ![...have].some(h => h.startsWith(p + '.')));
    for (const p of found) settings.push({ path: p, label: human(p.split('.').filter(x => !/^(show|enabled?|on)$/i.test(x)).pop() || p), group: human(p.split('.')[0]), type: 'boolean', default: true, show: true });
    if (found.length || !quiet) UI.toast(found.length ? `Added ${found.length} setting${found.length > 1 ? 's' : ''}: ${found.map(p => 'opts.' + p).join(', ')}. Check each type.` : 'Every opts.<name> in the code is already a setting.');
    if (found.length || !quiet) drawSettings();
  }
  $('optsFind').onclick = () => { findSettings(false); draw(); };
  // What the code gets as opts in the preview: each setting's default at its path.
  function previewOpts() {
    const o = { $kind: 'd3' };
    for (const s of settings) if (!s.hide && PATH.test(s.path) && !(s.type === 'color' && !s.default)) ApexWidget.setAt(o, s.path, s.default);   // hidden (eye): left out
    return o;
  }
  const colourBlock = () => `/* ===== COLOURS (D3 Studio) ===== */\n.WIDGET { ${colours.map((c, i) => `--w-c${i + 1}: ${c || `var(--c${i + 1})`};`).join(' ')} }\n`;
  const coloursFrom = css => { const out = Array(8).fill(null), m = String(css || '').match(COLOUR_BLOCK); if (m) for (const [, n, v] of m[0].matchAll(/--w-c(\d):\s*([^;]+);/g)) if (/^#[0-9a-f]{3,8}$/i.test(v.trim())) out[+n - 1] = v.trim(); return out; };
  const baseStyle = name => `/* ${name} (D3 widget): the ONE place this widget's look is set, wherever it is drawn (Dashboard, previews, Publish).
   .WIDGET = this widget's box (class dn-w-<folder name>). --w-c1..c8 = its default colours (D3 Studio writes the
   COLOURS block); the other --w-* variables reach the code as \`theme\`. */

/* ===== PAGE ===== */
.WIDGET {
  --w-font: 'Exo 2', system-ui, sans-serif;
  --w-bg: var(--bg); --w-panel: var(--panel); --w-panel-2: var(--panel-2); --w-sel: var(--sel);
  --w-text: var(--text); --w-text-2: var(--text-2); --w-muted: var(--muted); --w-border: var(--border); --w-accent: var(--blue);
}
.WIDGET > div { position: relative; }
.WIDGET > div > svg { display: block; width: 100%; height: 100%; font-family: var(--w-font); color: var(--w-text-2); }
`;
  // The widget's style sheet with this colour block (an existing sheet keeps everything else).
  function styleCss(name) {
    const old = editing?.styleCss;
    if (!old) return baseStyle(name) + colourBlock();
    if (COLOUR_BLOCK.test(old)) return old.replace(COLOUR_BLOCK, colourBlock());
    const at = old.search(SHADOW);
    return at < 0 ? old.replace(/\s*$/, '\n') + colourBlock() : old.slice(0, at) + colourBlock() + '\n' + old.slice(at);
  }

  // ---- preview: drawn like the Dashboard draws it (the widget's style sheet on the box, then a plain inner box) ----
  const slug = () => editing?.id || WidgetRegistry.slug($('name').value || 'd3-widget');
  let drawT = 0;
  // Live: every sample data / name change redraws at once (code changes wait for Run).
  const schedule = () => { clearTimeout(drawT); drawT = setTimeout(draw, 16); };   // a timer, not a frame: also runs while the window is hidden
  function draw() {
    if (liveText !== null) liveWrite();   // the live code file follows the editor (once the open has read it)
    clearTimeout(drawT);
    const pv = $('pv'), err = $('err');
    ApexWidget.useStyle({ id: 'd3-studio-preview', styleCss: styleCss($('name').value || 'Widget') }, pv);
    const W = Math.max(60, Math.floor(pv.clientWidth)), H = Math.max(60, Math.floor(pv.clientHeight));
    pv.innerHTML = '<div style="width:100%;height:100%;overflow:hidden"></div>';
    if (dataErr) { err.className = ''; err.textContent = dataErr; return; }
    const th = ApexWidget.theme(pv), t0 = performance.now(), was = runErr;
    runErr = null;
    try {
      if (syntaxErrs(ran).length) throw Object.assign(new SyntaxError(syntaxErrs(ran)[0].message.replace(/^SyntaxError: /, '')), { at: syntaxErrs(ran)[0] });
      D3Render.draw(pv.firstElementChild, ran, rows.map(r => ({ ...r })), { W, H, colors: colours.map((c, i) => c || th.colors[i] || themeColour(i)), opts: previewOpts(), theme: th });
      err.className = 'ok'; err.textContent = `Drawn in ${UI.ms(performance.now() - t0)} · ${rows.length.toLocaleString()} sample rows · ${W} x ${H} px`;
    } catch (e) {
      const at = e.at || whereIn(e);
      if (!e.at && at) runErr = { ...at, code: ran, message: `${e.name}: ${e.message}` };
      err.className = ''; err.textContent = `${e.name}: ${e.message}${at ? ` (line ${at.line})` : ''}`;
    }
    if (JSON.stringify(was) !== JSON.stringify(runErr)) code.recheck();   // the editor marks the new runtime error (or clears the old one)
  }
  // Where in the code editor a runtime error happened: the first stack frame inside the compiled function
  // (V8 numbers its lines from the function header: the code's line 1 is line 4).
  function whereIn(e) {
    const m = String(e.stack || '').match(/<anonymous>:(\d+):(\d+)/);
    return m && +m[1] > 3 ? { line: +m[1] - 3, col: +m[2] } : null;
  }
  // Syntax errors with their line / column: the code compiled as a script (not run), its error event gives the place.
  let synFor = null, synErrs = [];
  function syntaxErrs(text) {
    if (text === synFor) return synErrs;
    let hit = null;
    const on = e => { if (e.filename === '' || e.filename === location.href) { hit = e; e.preventDefault(); } };
    addEventListener('error', on);
    const s = document.createElement('script');
    s.textContent = `window.__dnD3Check = function (d3, data, el, W, H, colors, opts, theme) { "use strict";\n${text}\n};`;
    document.head.append(s); s.remove();
    removeEventListener('error', on);
    synFor = text;
    return (synErrs = hit ? [{ line: Math.max(1, hit.lineno - 1), col: Math.max(1, hit.colno), message: String(hit.message).replace(/^Uncaught /, '').replace(/Failed to execute '\w+' on '\w+': /, '') }] : []);
  }
  let runErr = null;   // { line, col, code, message } of the last preview run
  // Editor check (js/pipeline/sql-editor.js): syntax errors, else the preview's runtime error while the code is the same.
  function checkCode(text) {
    const pos = ({ line, col }) => { const ls = text.split('\n'); return ls.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + Math.min(col - 1, (ls[line - 1] || '').length); };
    const list = syntaxErrs(text).length ? syntaxErrs(text) : runErr && runErr.code === text ? [runErr] : [];
    return list.map(e => ({ pos: pos(e), end: pos(e) + 1, line: e.line, message: `${e.message} (line ${e.line})` }));
  }
  // ---- live code file: d3-studio/dev/<id>/d3-code.js (a new, unsaved chart: d3-studio/dev/_new/d3-code.js) is always the
  // same as the code editor. Editor changes are written to it; when the file changes on disk (edited elsewhere, e.g. by
  // Claude) the editor takes it and the preview redraws. Only Publish copies it to the live folder (the Dashboard).
  const LIVE = 'd3-code.js';
  const livePath = () => `${DEV}/${editing?.id || '_new'}/${LIVE}`;
  let liveText = null, liveMod = null, liveBusy = false;
  async function liveWrite() {
    const path = livePath(), text = code.value;
    if (text === liveText || liveBusy) return;
    liveBusy = true;
    try { await DNFS.writeText(path, text); const mod = (await DNFS.stat(path, { quiet: true })).modified; if (path === livePath()) { liveText = text; liveMod = mod; } }
    catch (e) { console.warn('D3 Studio live file:', e.message); }
    finally { liveBusy = false; }
    if (liveText !== null && code.value !== liveText) liveWrite();   // typed while it was writing
  }
  // Opening a chart: an existing live file is the latest code (it may have been edited while the studio was closed).
  async function liveOpen(fresh) {
    liveText = null; liveMod = null;
    $('live').textContent = livePath(); $('live').title = `Live code file: the same as this editor, both ways. Edit ${livePath()} and the preview redraws.`;
    const st = fresh ? {} : await DNFS.stat(livePath(), { quiet: true }).catch(() => ({}));
    if (st.exists) {
      const text = await DNFS.readText(livePath());
      if (text !== code.value) { code.value = text; UI.toast(`Code loaded from ${livePath()} (changed since the chart was opened).`); }
      liveText = text; liveMod = st.modified; run();
    } else liveWrite();
  }
  async function liveWatch() {
    if (!liveBusy && liveText !== null) try {
      const path = livePath(), st = await DNFS.stat(path, { quiet: true });
      if (!st.exists) { liveText = null; liveWrite(); }
      else if (st.modified !== liveMod && !liveBusy && path === livePath()) {
        liveMod = st.modified;
        const text = await DNFS.readText(path);
        if (text !== code.value) {
          const ta = $('code').querySelector('textarea'), at = ta.selectionStart, top = ta.scrollTop, mine = document.activeElement === ta;
          code.value = text; liveText = text;
          if (mine) ta.setSelectionRange(Math.min(at, text.length), Math.min(at, text.length));
          ta.scrollTop = top; ta.dispatchEvent(new Event('scroll'));
          run();   // the file was changed on disk (e.g. by Claude): run it
        } else liveText = text;
      }
    } catch { /* server busy or offline: try again next time */ }
    setTimeout(liveWatch, 1000);
  }

  // The chart box: its bottom edge sits on the window's vertical middle (its left edge is the page's middle already: the
  // two columns split the width). Kept there on every window resize; the redraw follows its new size.
  function placePreview() { const b = $('pv').parentElement; b.style.height = `${Math.max(120, Math.round(innerHeight / 2 - b.getBoundingClientRect().top))}px`; }
  // Again once the global header is in (js/core/embed.js adds it on DOMContentLoaded and pushes the studio down) and after fonts load.
  for (const ev of ['resize', 'DOMContentLoaded', 'load']) addEventListener(ev, placePreview);
  new ResizeObserver(placePreview).observe(document.documentElement);   // the window's size, however it changes
  placePreview();
  new ResizeObserver(UI.debounce(draw, 120)).observe($('pv').parentElement);
  $('name').addEventListener('input', schedule);
  $('helpbtn').onclick = () => { $('help').hidden = !$('help').hidden; };

  // ---- load a sample file ----
  $('load').onclick = () => $('file').click();
  $('file').onchange = UI.guard(async () => {
    const f = $('file').files[0]; $('file').value = ''; if (!f) return;
    if (f.size > 20 * 1048576) throw new Error('Sample files over 20 MB are too big: use a few hundred rows.');
    let text = await f.text();
    if (!/\.json$/i.test(f.name)) { const r = parse(text); if (r.length > 2000) { UI.toast(`Kept the first 2,000 of ${r.length.toLocaleString()} rows.`); } text = JSON.stringify(r.slice(0, 2000), null, 2); }
    data.value = text; parseData(); draw();
  });

  // ---- open a chart (from the dev folder) ----
  let live = new Set();   // folders published to the live folder
  async function refreshList(selectId = '') {
    [all, live] = await Promise.all([WidgetRegistry.scan(DEV, { only: m => m.kind === 'd3' }),
      DNFS.list(LIVE_DIR).then(es => new Set(es.filter(e => e.dir).map(e => e.name))).catch(() => new Set())]);
    $('pick').innerHTML = `<option value="">New chart</option>${all.map(m => `<option value="${esc(m.id)}" ${m.id === selectId ? 'selected' : ''}>${esc(m.name)}${live.has(m.id) ? ' (published)' : ''}</option>`).join('')}`;
    $('cats').innerHTML = [...new Set([...CATS, ...all.map(m => m.category).filter(Boolean)])].map(c => `<option value="${esc(c)}">`).join('');
  }
  // fresh = start over (New chart picked): the live file takes the editor's code instead of giving its own.
  function openWidget(m, fresh = false) {
    liveText = null;   // no live file writes until liveOpen has read the new one
    editing = m || null;
    $('name').value = m?.name || ''; $('cat').value = m?.category || ''; $('desc').value = m?.description || '';
    code.value = m ? m.codeJs || '' : SAMPLE_CODE;
    data.value = m ? JSON.stringify(m.sampleRows || [], null, 2) : SAMPLE_DATA;
    inputs = m ? (m.inputs || []).map(i => ({ ...i })) : [];
    colours = m ? coloursFrom(m.styleCss) : colours.map((_, i) => themeColour(i) || null);   // new: starts from the app palette
    settings = JSON.parse(JSON.stringify(m ? (m.options || []).filter(o => !/^colors\.\d+$/.test(o.path)) : NEW_SETTINGS));

    parseData(); drawColours(); drawSettings(); run();
    return liveOpen(fresh);
  }
  $('pick').onchange = UI.guard(async () => {
    const id = $('pick').value;
    if (!await UI.confirm(id ? 'Open this chart? Unsaved changes here are lost.' : 'Start a new chart? Unsaved changes here are lost.')) { $('pick').value = editing?.id || ''; return; }
    await openWidget(id ? all.find(m => m.id === id) : null, !id);
  });

  // ---- thumbnail for the Dashboard's Charts list: the preview's SVG scaled into 100 x 80 ----
  function thumb() {
    const svg = $('pv').querySelector('svg'); if (!svg) return null;
    const c = svg.cloneNode(true), cs = getComputedStyle(svg);
    if (!c.getAttribute('viewBox')) c.setAttribute('viewBox', `0 0 ${svg.clientWidth || 100} ${svg.clientHeight || 80}`);
    c.setAttribute('xmlns', 'http://www.w3.org/2000/svg'); c.setAttribute('width', '100'); c.setAttribute('height', '80');
    c.removeAttribute('class'); c.setAttribute('style', `color:${cs.color};font-family:${cs.fontFamily}`);
    // Theme variables do not reach an <img>: write their values in.
    const root = getComputedStyle($('pv'));
    return new XMLSerializer().serializeToString(c).replace(/var\((--[\w-]+)\)/g, (s, v) => root.getPropertyValue(v).trim() || s);
  }

  // ---- Save: the package into the dev folder (work in progress, never on the Dashboard).
  //      Publish: Save, then copy the package to the live folder (the Dashboard's Charts list). ----
  async function save() {
    const name = $('name').value.trim(); if (!name) { $('name').focus(); throw new Error('Give the chart a name.'); }
    if (dataErr) throw new Error(dataErr);
    if (!code.value.trim()) throw new Error('There is no D3 code to save.');
    D3Render.compile(code.value);   // a syntax error stops the save
    const paths = settings.map(s => s.path), badPath = paths.find(p => !PATH.test(p) || /^(\$kind|colors)\b/.test(p)),
      twice = paths.find((p, k) => paths.indexOf(p) !== k || paths.some(q => q.startsWith(p + '.')));
    if (badPath !== undefined) throw new Error(`Setting "opts.${badPath}": use names like grid.show (letters, digits, _ and dots; not colors or $kind).`);
    if (twice) throw new Error(`Setting "opts.${twice}" is used twice (or also holds another setting).`);
    const opts = settings.map(s => ({ path: s.path, label: s.label.trim() || human(s.path), group: s.group.trim() || 'General', type: s.type, default: asType(s, s.default),
      ...(s.type === 'number' ? { min: s.min ?? 0, max: s.max ?? 100, step: s.step ?? 1 } : {}), ...(s.type === 'select' ? { choices: s.choices || [] } : {}), show: s.show !== false }));
    const id = editing?.id || WidgetRegistry.slug(name);
    if (!editing && all.some(m => m.id === id) && !await UI.confirm(`A chart folder "${DEV}/${id}" already exists. Replace it?`, { danger: true, ok: 'Replace' })) return null;
    const dir = `${DEV}/${id}`, ins = inputs.map(i => ({ ...i, label: i.axis === 'other' ? i.label : labelOf(i) })).map(({ key, label, role, agg, optional, axis }) => ({ key, label, role, axis, ...(role === 'measure' ? { agg: agg || 'sum' } : {}), ...(optional ? { optional: true } : {}) }));
    const pic = thumb();
    const m = {
      id, name, description: $('desc').value.trim(), category: $('cat').value.trim() || 'Other',
      version: (+editing?.version || 0) + 1, kind: 'd3', spec: 'spec.json', style: 'style.css', code: LIVE, sample: 'sample.json',
      ...(pic ? { thumb: 'thumb.svg' } : {}), inputs: ins,
      options: colours.map((_, i) => ({ path: `colors.${i}`, label: `Colour ${i + 1}`, group: 'Colours', type: 'color', default: null, show: true })).concat(opts),
      updated: new Date().toISOString(),
    };
    await DNFS.writeText(`${dir}/${LIVE}`, code.value);
    await DNFS.writeJSON(`${dir}/sample.json`, rows);
    await DNFS.writeJSON(`${dir}/spec.json`, { $kind: 'd3', data: ins });
    await DNFS.writeText(`${dir}/style.css`, styleCss(name));
    if (pic) await DNFS.writeText(`${dir}/thumb.svg`, pic);
    await DNFS.writeJSON(`${dir}/widget.json`, m);
    await refreshList(id);
    const wasNew = !editing;
    editing = all.find(x => x.id === id) || null;
    // A new chart's live code file is now its folder's d3-code.js.
    if (wasNew) { liveText = code.value; liveMod = (await DNFS.stat(livePath(), { quiet: true })).modified; $('live').textContent = livePath(); await DNFS.remove(`${DEV}/_new`, { recursive: true }).catch(() => {}); }
    return { id, dir, m };
  }
  $('save').onclick = UI.guard(async () => {
    const s = await save(); if (!s) return;
    UI.toast(`Saved ${s.dir} (dev: not on the Dashboard until you Publish).`, 'ok');
  });
  $('publish').onclick = UI.guard(async () => {
    const s = await save(); if (!s) return;
    const to = `${LIVE_DIR}/${s.id}`;
    if (!live.has(s.id) && !await UI.confirm(`Publish "${s.m.name}"? It is copied to ${to} and listed in Dashboard > Charts.`, { ok: 'Publish' })) return;
    await DNFS.remove(to, { recursive: true }).catch(() => {});
    await DNFS.copy(s.dir, to, { overwrite: true });
    await refreshList(s.id);
    UI.toast(`Published ${to}: Dashboard > Charts (${s.m.category}). Dashboards already using it get it on their next load.`, 'ok');
  });

  UI.guard(async () => {
    await refreshList();
    const want = UI.params().chart || UI.params().widget;
    await openWidget(want ? all.find(m => m.id === want && m.kind === 'd3') : null);
    if (want) $('pick').value = editing?.id || '';
    liveWatch();
  })();
})();
