// D3 Studio (ui/html/d3-studio.html): builds CHARTS (D3; "widgets" are something else: several things in one box).
// Write D3 code and see it drawn; the chart's data comes in through its INPUTS: data variables (x, y, ...) each linked to a
// field of the Data table picked top right (a cleaned CLEAN_ dataset in a project's data/source, like SQL FROM).
// Until they are linked the Sample data is drawn. The Generated box shows what the code gets ready made (data, the X / Y
// accessors, W x H, colors, opts, theme, inputs); Starter code writes the scales, svg, grid and axes from the inputs, so
// only the marks are left to write. The chart is drawn in a <div> and its svg always scales to fit it (D3Render.fit).
// Save = the chart package into workspace/chart-builder/dev/<id>/ (work in progress); Publish = Save + copy to workspace/chart-builder/live/<id>/
// (Dashboard > Charts lists only live charts). On the Dashboard a chart starts with no data (axes / grid only) until its
// inputs are linked in Right-click > Chart Settings; the links made here are only for testing (chart.json "studio").
// A chart package (kind 'd3'):
//   <dir>/chart.json    { id, name, description, category, kind: 'd3', spec, style, code, sample, thumb, inputs, options, studio }
//   <dir>/d3-code.js    the D3 code (ui/js/charts/d3-render.js says what it is called with); in dev it is the live code
//                       file, the same as the editor both ways (edit it on disk and the studio redraws)
//   <dir>/sample.json   sample rows (D3 Studio only, drawn while the inputs are not linked)
//   <dir>/spec.json     { "$kind": "d3", "data": inputs, "query": { sort, top } }
//   <dir>/style.css     the chart's ONLY style; the D3 Studio colour block holds --w-c1..c8 (its default colours)
//   <dir>/thumb.svg     picture of the preview for the Dashboard's Charts list
(() => {
  const { $, esc } = UI;
  const DEV = ChartRegistry.CHARTS_DEV, LIVE_DIR = ChartRegistry.CHARTS_LIVE;
  const CATS = ['Bar', 'Line & Area', 'Pie & Donut', 'Scatter', 'Hierarchy', 'Network', 'Map', 'Tables', 'Controls', 'Other'];
  const AGGS = ['sum', 'avg', 'count', 'count_distinct', 'median', 'min', 'max', 'none'];
  const COLOUR_BLOCK = /\/\*\s*=====\s*COLOURS[^*]*\*\/[^}]*\}\n?/;
  const SHADOW = /\/\*\s*=====\s*SHADOW\s*=====[^*]*\*\//;
  const IDENT = /^[A-Za-z_$][\w$]*$/;
  const RESERVED = new Set([...D3Render.PARAMS, 'd3', 'width', 'height', 'd', 'i']);
  const NUMERIC = /INT|DOUBLE|FLOAT|DECIMAL|REAL|NUMERIC/i, DATE = /DATE|TIME/i;

  const NEW_INPUTS = () => [{ key: 'x', label: 'X Axis', role: 'dimension', axis: 'x' }, { key: 'y', label: 'Y Axis', role: 'measure', axis: 'y', agg: 'sum' }];
  const NEW_SAMPLE = [{ x: 'North', y: 42 }, { x: 'South', y: 28 }, { x: 'East', y: 35 }, { x: 'West', y: 51 }, { x: 'Central', y: 19 }];
  const NEW_SETTINGS = [{ path: 'grid.y', label: 'Horizontal grid lines', group: 'Grid', type: 'boolean', default: true, show: true },
    { path: 'grid.x', label: 'Vertical grid lines', group: 'Grid', type: 'boolean', default: false, show: true }];

  // ---- state ----
  let editing = null;           // manifest of the chart loaded from the dev folder (null = new)
  let rows = [];                // parsed sample rows
  let inputs = [];              // [{ key, label, role, agg, axis, optional }]: the chart's data variables
  let links = {};               // { <key>: 'TABLE.FIELD' } (D3 Studio test data)
  let order = { sort: 'desc', top: 20 };   // spec.json "query": default order / number of X values
  let colours = Array(8).fill(null);   // '#rrggbb' or null (= theme colour)
  let settings = [];            // chart.json options besides the colours: [{ path, label, group, type, default, min, max, step, choices, show }]
  let all = [];                 // every chart in the dev folder (ids taken, categories)
  let project = '';             // project folder of the Data table
  let tables = new Map();       // the Data table: its name -> { d, columns } (one entry, or none = sample data)
  let sources = [];             // every CLEAN_ dataset in data/source of every project: [{ key, folder, proj, d }]
  let source = '';              // key of the Data table ('' = None: sample data)
  let liveRows = null;          // rows from the engine (inputs linked), else null (sample drawn)
  let dataNote = '', linkErr = '';

  // ---- editors ----
  let codeRef = null;   // the code editor, once mounted (its first paint already asks for the variables)
  const codeText = () => codeRef ? codeRef.value : '';
  // Chart variables the code gets ready made (name -> what it is): the Generated box, suggestions, hover, purple colour.
  function readyVars() {
    const v = new Map(), n = (liveRows || rows).length, from = linkedTable();
    v.set('data', `rows: ${n.toLocaleString()} ${liveRows ? `from ${from}` : 'sample'}, each { ${inputs.map(i => i.key).join(', ')} }`);
    for (const [acc, k] of D3Render.accessors(codeText(), inputs.map(i => i.key))) v.set(acc, `accessor: d => d.${k} (${labelOf(inputs.find(i => i.key === k))}${links[k] ? ` = ${fieldText(inputs.find(i => i.key === k))}` : ''})`);
    v.set('W', 'width of the chart box, px'); v.set('H', 'height of the chart box, px');
    v.set('el', "the chart's <div> (draw into it, or return a node)"); v.set('colors', 'the 8 chart colours: colors[0] ... colors[7]');
    v.set('opts', 'the Settings: opts.<name>'); v.set('theme', 'theme.text / text2 / muted / border / font / dark');
    v.set('inputs', 'inputs.<key>.label / .field (axis titles)'); v.set('width', '= W'); v.set('height', '= H');
    return v;
  }
  const assist = D3Assist.create({ vars: readyVars, fields: () => inputs.map(i => [i.key, `${labelOf(i)}${links[i.key] ? ' = ' + fieldText(i) : ''} (${i.role})`]), opts: () => settings.map(s => s.path) });
  const d3names = () => D3Api.top;
  // (The editors paint once while this file is still setting up: no names until then.)
  const varNames = () => { try { return new Set(readyVars().keys()); } catch { return null; } };
  let ran = '';
  const code = SqlEditor.mount($('code'), { lang: 'js', onChange: () => { if (liveText !== null) liveWrite(); markRun(); autoRun(); },
    check: async text => checkCode(text), complete: a => assist.complete(a), hover: (t, p) => assist.hover(t, p), vars: varNames, d3names });
  codeRef = code;
  const gen = SqlEditor.mount($('gen'), { lang: 'js', readOnly: true, vars: varNames, d3names, hover: (t, p) => assist.hover(t, p) });
  const markRun = () => $('run').classList.toggle('ghost', code.value === ran);
  function run() { ran = code.value; markRun(); findSettings(true); updateGen(); draw(); }
  $('run').onclick = run;
  addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); } });
  // Auto run: a moment after typing stops, when the code compiles (a half-typed line never runs).
  const AUTO = 'd3studio.auto';
  try { $('auto').checked = localStorage.getItem(AUTO) !== '0'; } catch {}
  $('auto').onchange = () => { try { localStorage.setItem(AUTO, $('auto').checked ? '1' : '0'); } catch {} if ($('auto').checked) run(); };
  const autoRun = UI.debounce(() => { if ($('auto').checked && code.value !== ran && !syntaxErrs(code.value).length) run(); }, 500);

  // Pasted code: Observable notebook cells become plain code (ui/js/d3studio/observable.js), and a fixed size
  // (width = 928, height = 500) becomes W / H, the chart box's size.
  const FIXED = /(?<![.\w$])(width|height)(\s*=\s*)\d+(?:\.\d+)?(?![\w.])/g;
  $('convert').onclick = () => convertCode(true);
  $('code').querySelector('textarea').addEventListener('paste', () => setTimeout(() => convertCode(false)));
  function convertCode(asked) {
    const was = code.value, obs = ObservableImport.convert(was);
    const now = (obs ? obs.code : was).replace(FIXED, (s, n, eq) => `${n}${eq}${n === 'width' ? 'W' : 'H'}`);
    if (now === was) { if (asked) UI.toast('Already plain D3: nothing to convert.'); return; }
    const ta = $('code').querySelector('textarea'), at = obs ? now.length : ta.selectionStart + now.length - was.length;
    code.value = now; ta.focus(); ta.setSelectionRange(at, at); run();
    const said = [obs && 'Observable notebook code converted to plain D3', now !== (obs ? obs.code : was) && 'fixed width / height changed to W / H (the chart box size)'].filter(Boolean).join('; ');
    UI.toast(said.charAt(0).toUpperCase() + said.slice(1) + '.');
    obs?.notes.forEach(n => UI.toast(n, 'warn', 9000));
  }
  const data = SqlEditor.mount($('data'), { lang: 'json', onChange: () => { parseData(); updateGen(); schedule(); } });
  $('datatog').onclick = () => { const off = $('data').classList.toggle('off'); $('datatog').textContent = off ? 'Show' : 'Hide'; };

  // ---- sample data: JSON rows (an array of objects, or { data: [...] }) or CSV / TSV (types guessed) ----
  function parse(text) {
    const t = text.trim(); if (!t) return [];
    if (/^[[{]/.test(t)) { const j = JSON.parse(t); const a = Array.isArray(j) ? j : Array.isArray(j.data) ? j.data : [j]; return a.filter(r => r && typeof r === 'object'); }
    const first = t.split('\n')[0];
    return (first.includes('\t') ? d3.tsvParse(t, d3.autoType) : d3.csvParse(t, d3.autoType)).slice();
  }
  let dataErr = '';
  let parsedText = null;   // the Sample data text rows were parsed from (draw re-parses when the box holds other text)
  function parseData() { parsedText = data.value; try { rows = parse(data.value); dataErr = ''; } catch (e) { dataErr = `Sample data: ${e.message}`; } }

  // ---- inputs: the chart's data variables, each linked to TABLE.FIELD ----
  const human = k => String(k).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());
  // d.x is always "X Axis" and d.y "Y Axis" (ApexWidget.labelOf, kind d3); other inputs: their own label.
  const labelOf = i => i ? ApexWidget.labelOf({ kind: 'd3', inputs }, i) : '';
  const AXES = [['x', 'X Axis'], ['y', 'Y Axis'], ['series', 'Series (colour)'], ['other', 'Other']];
  const splitLink = s => { const m = /^\s*([^.\s]+)\.(.+?)\s*$/.exec(s || ''); return m ? { table: m[1], col: m[2] } : null; };
  // The dataset column a link points at (case-insensitive match), or null.
  function resolve(s) {
    const p = splitLink(s); if (!p) return null;
    const t = [...tables.keys()].find(n => n.toLowerCase() === p.table.toLowerCase()); if (!t) return null;
    const c = tables.get(t).columns.find(c => c.name.toLowerCase() === p.col.toLowerCase()); if (!c) return null;
    return { table: t, col: c.name, type: c.type };
  }
  const aggOf = i => i.role === 'measure' ? i.agg || 'sum' : null;
  const fieldText = i => { const r = resolve(links[i.key]); if (!r) return links[i.key] || ''; const f = `${r.table}.${r.col}`, a = aggOf(i); return a && a !== 'none' ? `${ApexWidget.AGG_LABEL[a].toUpperCase().replace(/ /g, '_')}(${f})` : f; };
  const linkedTable = () => { const t = [...new Set(inputs.map(i => resolve(links[i.key])?.table).filter(Boolean))]; return t.length === 1 ? t[0] : t.join(' + '); };
  function drawInputs() {
    $('ins').innerHTML = inputs.length ? `<table><thead><tr><th title="The variable in your code: a column of data">Variable</th><th>In code</th><th>Shown as</th><th>Role</th><th>Aggregation</th>
      <th title="A field of the Data table (top right)">Field</th><th title="Optional: the chart also draws without it">Opt.</th><th></th></tr></thead><tbody>${inputs.map((i, k) => {
      const r = resolve(links[i.key]), acc = D3Render.accessors(code.value, [i.key])[0];
      return `<tr data-k="${k}">
      <td><input type="text" data-f="key" value="${esc(i.key)}" spellcheck="false"></td>
      <td class="code">d.${esc(i.key)}${acc ? ` · ${esc(acc[0])}(d)` : ''}</td>
      <td><select data-f="axis">${AXES.map(([v, l]) => `<option value="${v}" ${i.axis === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>${i.axis === 'other' ? `<input type="text" data-f="label" value="${esc(i.label)}" style="margin-top:2px">` : ''}</td>
      <td><select data-f="role"><option value="dimension" ${i.role === 'dimension' ? 'selected' : ''}>Dimension (group by)</option><option value="measure" ${i.role === 'measure' ? 'selected' : ''}>Measure (number)</option></select></td>
      <td>${i.role === 'measure' ? `<select data-f="agg">${AGGS.map(a => `<option value="${a}" ${(i.agg || 'sum') === a ? 'selected' : ''}>${esc(ApexWidget.AGG_LABEL[a])}</option>`).join('')}</select>` : ''}</td>
      <td>${fieldSelect(i, r)}</td>
      <td><input type="checkbox" data-f="optional" ${i.optional ? 'checked' : ''}></td>
      <td><button class="ib del" data-f="del" title="Remove this input">${Icons.svg('x-circle')}</button></td></tr>`; }).join('')}</tbody></table>`
      : '<div class="help" style="padding:6px">No inputs: Add input.</div>';
  }
  // Field list of one input: only the Data table's fields (names only); None = not linked (sample data).
  function fieldSelect(i, r) {
    const t = [...tables.values()][0];
    if (!t) return `<select data-f="src" disabled title="Pick a Data table top right first"><option>None (sample data)</option></select>`;
    return `<select data-f="src"><option value="">${i.optional ? 'None' : 'Not linked'}</option>${[...t.columns].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })).map(c => `<option value="${esc(c.name)}" ${r?.col === c.name ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>`;
  }
  function onInput(e) {
    const f = e.target.dataset.f, i = inputs[+e.target.closest('tr')?.dataset.k]; if (!f || !i) return;
    if (f === 'key') {
      const v = e.target.value.trim(), bad = !IDENT.test(v) || RESERVED.has(v) || inputs.some(o => o !== i && o.key === v);
      e.target.classList.toggle('bad', bad); e.target.title = bad ? 'A JavaScript name, not used by another input or by the chart (data, el, W, H, ...)' : '';
      if (bad || e.type !== 'change' || v === i.key) return;
      // Renamed: the sample rows and the link follow.
      const old = i.key; i.key = v;
      if (old in links) { links[v] = links[old]; delete links[old]; }
      if (rows.some(r => old in r)) { rows = rows.map(r => { const o = {}; for (const [k, x] of Object.entries(r)) o[k === old ? v : k] = x; return o; }); data.value = JSON.stringify(rows, null, 2); }
      if (new RegExp(`\\bd\\.${old}\\b|\\b${old.toUpperCase()}\\(`).test(code.value)) UI.toast(`Renamed ${old} to ${v}: change d.${old} / ${old.toUpperCase()}(d) in the code too.`, 'warn', 7000);
      return inputsChanged();
    }
    if (f === 'src') {
      if (e.type !== 'change') return;
      const tn = [...tables.keys()][0], r = e.target.value && tn ? resolve(`${tn}.${e.target.value}`) : null;
      if (r) links[i.key] = `${r.table}.${r.col}`; else delete links[i.key];
      // A dimension linked to a date field: order by X (dates in time order), not by value.
      if (r && i.axis === 'x' && DATE.test(r.type) && order.sort !== 'label') { order.sort = 'label'; order.top = Math.max(order.top, 1000); drawOrder(); UI.toast('X is a date: Order set to By X (dates in order), Max X values 1,000.'); }
      // A measure linked to a text field cannot be summed: count it instead.
      if (r && i.role === 'measure' && !NUMERIC.test(r.type) && !['count', 'count_distinct', 'min', 'max'].includes(aggOf(i))) { i.agg = 'count'; UI.toast(`${r.col} is not a number: ${i.key} counts its rows (Aggregation).`); }
      return inputsChanged();
    }
    if (e.type !== 'change' && e.target.type !== 'text') return;
    if (f === 'optional') i.optional = e.target.checked || undefined;
    else if (f === 'role') { i.role = e.target.value; i.agg = i.role === 'measure' ? i.agg || 'sum' : undefined; }
    else if (f === 'axis') { i.axis = e.target.value; if (i.axis === 'other' && /Axis|Series/.test(i.label)) i.label = human(i.key); }
    else if (f === 'agg') i.agg = e.target.value;
    else if (f === 'label') { i.label = e.target.value; if (e.type !== 'change') return updateGen(); }
    inputsChanged();
  }
  $('ins').addEventListener('input', onInput);
  $('ins').addEventListener('change', onInput);
  $('ins').addEventListener('click', e => {
    const b = e.target.closest('button[data-f="del"]'), i = inputs[+b?.closest('tr')?.dataset.k]; if (!i) return;
    inputs.splice(inputs.indexOf(i), 1); delete links[i.key]; inputsChanged();
  });
  $('insAdd').onclick = () => {
    const taken = new Set(inputs.map(i => i.key)), want = ['x', 'y', 'series', 'value', 'size', 'label'];
    let key = want.find(k => !taken.has(k)); for (let n = 2; !key; n++) if (!taken.has('v' + n)) key = 'v' + n;
    const axis = key === 'x' ? 'x' : key === 'y' ? 'y' : key === 'series' ? 'series' : 'other';
    inputs.push({ key, label: axis === 'other' ? human(key) : AXES.find(a => a[0] === axis)[1], role: key === 'y' || key === 'value' || key === 'size' ? 'measure' : 'dimension', axis, ...(key === 'y' || key === 'value' || key === 'size' ? { agg: 'sum' } : {}), ...(axis === 'series' ? { optional: true } : {}) });
    inputsChanged();
    $('ins').querySelector('tbody tr:last-child [data-f="key"]')?.select();
  };
  // Order: spec.json "query" (the Dashboard's default too).
  function drawOrder() { $('sort').value = order.sort; $('top').value = order.top; }
  $('sort').onchange = () => { order.sort = $('sort').value; refreshData(); };
  $('top').oninput = () => { order.top = Math.max(1, Math.min(100000, +$('top').value || 20)); refreshData(); };
  function inputsChanged(redraw = true) { if (redraw) drawInputs(); updateGen(); refreshData(); }

  // ---- data from the project: the inputs' TABLE.FIELD links as one engine query (the Dashboard's query: ApexWidget.query) ----
  // Data list: None (sample data) first, then every CLEAN_ dataset that exists now in a project's data/source (read from
  // disk on every load / refresh), green, A to Z. The project is named only when more than one project has datasets.
  const DATA = 'd3studio.data';
  async function loadSources() {
    const projs = (await Projects.list().catch(() => [])).filter(p => !p.broken);
    sources = [];
    for (const p of projs) for (const d of await Projects.sourceDatasets(p.folder).catch(() => [])) if (/^CLEAN_/i.test(d.name)) sources.push({ key: `${p.folder}/${d.name}`, folder: p.folder, proj: p.name, d });
    const many = new Set(sources.map(s => s.folder)).size > 1;
    sources.sort((a, b) => a.d.name.localeCompare(b.d.name, undefined, { sensitivity: 'base', numeric: true }) || a.proj.localeCompare(b.proj));
    $('src').innerHTML = `<option value="">None (sample data)</option>${sources.map(s => `<option class="ds" value="${esc(s.key)}">${esc(s.d.name)}${many ? ` (${esc(s.proj)})` : ''}</option>`).join('')}`;
    if (!source) { try { source = localStorage.getItem(DATA) || ''; } catch {} }
    setSource(source);
  }
  // Pick the Data table (key, or a table name + project). Links keep their field where the new table has it.
  function setSource(key, { relink = false } = {}) {
    const s = sources.find(x => x.key === key) || null;
    source = s ? s.key : ''; project = s ? s.folder : '';
    tables = new Map(s ? [[s.d.name, { d: s.d, columns: s.d.columns || [] }]] : []);
    $('src').value = source; $('src').classList.toggle('ds', !!s); fitSelect($('src'));
    if (relink) for (const [k, v] of Object.entries(links)) { const col = splitLink(v)?.col, r = s && col ? resolve(`${s.d.name}.${col}`) : null; if (r) links[k] = `${r.table}.${r.col}`; else if (s) delete links[k]; }
    drawInputs();
  }
  const sourceFor = (folder, table) => sources.find(x => x.d.name === table && (!folder || x.folder === folder))?.key || '';
  $('src').onchange = () => { setSource($('src').value, { relink: true }); try { localStorage.setItem(DATA, source); } catch {} inputsChanged(false); };

  let dataSeq = 0;
  const sqlId = c => /^[A-Za-z_][\w]*$/.test(c) ? c : `"${String(c).replace(/"/g, '""')}"`;
  // The query as SQL, for reading (the engine gets the declarative form).
  function sqlText(q, m) {
    const as = new Map(m.inputs.map(i => [`v_${i.key}`, i.key]));
    const K = s => `<span class="kw">${s}</span>`;
    if (q.select) return `${K('SELECT')} ${q.select.map(c => { const i = m.inputs.find(i => resolve(links[i.key])?.col === c); return `${esc(sqlId(c))}${i && i.key !== c ? ` ${K('AS')} ${esc(i.key)}` : ''}`; }).join(', ')} ${K('FROM')} <span class="tb">${esc(q.dataset)}</span>${q.limit ? ` ${K('LIMIT')} ${q.limit.toLocaleString()}` : ''}`;
    const dims = (q.groupBy || []).map(c => { const i = m.inputs.find(i => i.role === 'dimension' && resolve(links[i.key])?.col === c); return `${esc(sqlId(c))}${i && i.key !== c ? ` ${K('AS')} ${esc(i.key)}` : ''}`; });
    const aggs = (q.aggregate || []).map(a => `${K(a.function === 'count_distinct' ? 'COUNT' : a.function.toUpperCase())}(${a.function === 'count_distinct' ? K('DISTINCT') + ' ' : ''}${a.column ? esc(sqlId(a.column)) : '*'}) ${K('AS')} ${esc(as.get(a.as) || a.as)}`);
    const ord = (q.sort || []).map(s => `${esc(as.get(s.column) || sqlId(s.column))}${s.direction === 'desc' ? ' ' + K('DESC') : ''}`);
    return `${K('SELECT')} ${[...dims, ...aggs].join(', ')}\n${K('FROM')} <span class="tb">${esc(q.dataset)}</span>${q.groupBy?.length ? `\n${K('GROUP BY')} ${q.groupBy.map(c => esc(sqlId(c))).join(', ')}` : ''}${ord.length ? `\n${K('ORDER BY')} ${ord.join(', ')}` : ''}${q.limit ? ` ${K('LIMIT')} ${q.limit.toLocaleString()}` : ''}`;
  }
  const refreshData = UI.debounce(() => loadData().catch(e => { liveRows = null; dataNote = ''; linkErr = `Data: ${String(e.message || e).split('\n')[0]}`; updateGen(); draw(); }), 150);
  async function loadData() {
    const seq = ++dataSeq;
    linkErr = ''; $('sql').innerHTML = '';
    const linked = inputs.filter(i => links[i.key]), res = linked.map(i => [i, resolve(links[i.key])]);
    const done = (r, note) => { if (seq !== dataSeq) return; liveRows = r; dataNote = note; updateGen(); draw(); };
    if (!tables.size) return done(null, 'sample data · pick a Data table (top right) for real data');
    if (!linked.length) return done(null, 'sample data · pick a field for each input');
    const bad = res.find(([, r]) => !r);
    if (bad) { linkErr = `${bad[0].key}: "${splitLink(links[bad[0].key])?.col || links[bad[0].key]}" is not a field of ${[...tables.keys()][0]}`; return done(null, ''); }
    const used = [...new Set(res.map(([, r]) => r.table))];
    if (used.length > 1) { linkErr = `The inputs come from ${used.join(' and ')}: a chart reads one table (like SQL FROM). Link them all to one.`; return done(null, ''); }
    const missing = inputs.filter(i => !links[i.key] && !i.optional && !(i.role === 'measure' && aggOf(i) === 'count'));
    if (missing.length) return done(null, `sample data · link ${missing.map(i => i.key).join(', ')} to draw ${used[0]}`);
    const t = tables.get(used[0]), m = { kind: 'd3', inputs, specJson: { query: order } };
    const w = { dataset: used[0], inputs: Object.fromEntries(res.map(([i, r]) => [i.key, { col: r.col, ...(i.role === 'measure' ? { agg: aggOf(i) } : {}) }])), sort: order.sort, top: order.top };
    const q = ApexWidget.query(m, w);
    $('sql').innerHTML = sqlText(q, m);
    const t0 = performance.now(), r = await Engine.call('query', { query: q, views: Engine.views([t.d]) });
    if (seq !== dataSeq) return;
    const out = ApexWidget.shape(m, w, ApexWidget.objects(r), t.columns);
    done(out, `${out.length.toLocaleString()} rows from ${used[0]} (engine ${UI.ms(performance.now() - t0)})`);
  }

  // ---- Generated: what the code gets ready made (read only) ----
  function updateGen() {
    const [W, H] = boxSize(), acc = D3Render.accessors(code.value, inputs.map(i => i.key));
    const keys = inputs.map(i => i.key), n = (liveRows || rows).length, from = liveRows ? linkedTable() : null;
    const lines = [`// data: ${n.toLocaleString()} rows ${from ? `from ${from}` : '(sample data)'}, each { ${keys.join(', ')} }${linkErr ? '   (inputs not linked: ' + linkErr.replace(/\n/g, ' ') + ')' : ''}`];
    const pad = Math.max(...acc.map(([a, k]) => `const ${a} = d => d.${k};`.length), 0);
    for (const [a, k] of acc) { const i = inputs.find(x => x.key === k); lines.push(`${`const ${a} = d => d.${k};`.padEnd(pad)}   // ${labelOf(i)} = ${links[k] ? fieldText(i) : 'sample column ' + k}`); }
    for (const i of inputs.filter(i => !acc.some(([, k]) => k === i.key))) lines.push(`// d.${i.key}: ${labelOf(i)} = ${links[i.key] ? fieldText(i) : 'sample column ' + i.key}${IDENT.test(i.key) ? ' (accessor name taken by your code)' : ''}`);
    lines.push(`const W = ${W}, H = ${H};   // the chart box (a <div>, el) in px: draw in 0..W x 0..H; the svg scales to fit its box`);
    lines.push(`// also: colors[0..7], opts.${settings[0]?.path || '<setting>'}, theme.text / muted / border / font, inputs.${keys[0] || 'x'}.label / .field`);
    if (gen.value !== lines.join('\n')) gen.value = lines.join('\n');
  }

  // ---- colours: 8 swatches; blank = the app theme colour (--c1..c8) ----
  function drawColours() {
    $('colours').innerHTML = '';
    colours.forEach((c, i) => $('colours').append(ColorPicker.swatch(c, { allowTheme: true, onInput: v => { colours[i] = v; draw(); }, onChange: v => { colours[i] = v; draw(); } })));
  }
  $('themecols').onclick = () => { colours = Array(8).fill(null); drawColours(); draw(); };
  const themeColour = i => getComputedStyle(document.documentElement).getPropertyValue(`--c${i + 1}`).trim();

  // ---- settings: the options the Dashboard's Chart Settings show for this chart; the code reads opts.<path> ----
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
    $('opts').innerHTML = settings.length ? `<table><thead><tr><th>In code</th><th>Shown in settings as</th><th>Group</th><th>Type</th><th title="The value the preview uses right now (and the Dashboard starts with): change it to test the chart">Value</th><th>Range / list</th><th title="Listed in the Dashboard's Chart Settings (off = fixed at Value there)">Include</th><th></th></tr></thead><tbody>${settings.map((s, k) => `<tr data-k="${k}">
      <td><span class="op">opts.<input type="text" data-f="path" value="${esc(s.path)}" spellcheck="false"></span></td>
      <td><input type="text" data-f="label" value="${esc(s.label)}"></td>
      <td><input type="text" data-f="group" value="${esc(s.group)}" list="optgroups"></td>
      <td><select data-f="type">${TYPES.map(([v, l]) => `<option value="${v}" ${s.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
      <td>${def(s, k)}</td><td>${more(s)}</td>
      <td><input type="checkbox" data-f="show" ${s.show !== false ? 'checked' : ''} title="Off: kept in chart.json but not shown on the Dashboard"></td>
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
    const have = new Set(settings.map(s => s.path)), found = [...new Set([...D3Assist.blank(code.value).matchAll(OPT_REF)].map(m => m[1].replace(/\?\./g, '.')))]
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
  const colourBlock = () => `/* ===== COLOURS (D3 Studio) ===== */\n.CHART { ${colours.map((c, i) => `--w-c${i + 1}: ${c || `var(--c${i + 1})`};`).join(' ')} }\n`;
  const coloursFrom = css => { const out = Array(8).fill(null), m = String(css || '').match(COLOUR_BLOCK); if (m) for (const [, n, v] of m[0].matchAll(/--w-c(\d):\s*([^;]+);/g)) if (/^#[0-9a-f]{3,8}$/i.test(v.trim())) out[+n - 1] = v.trim(); return out; };
  const baseStyle = name => `/* ${name} (D3 chart): the ONE place this chart's look is set, wherever it is drawn (Dashboard, previews, Publish).
   .CHART = this chart's box (class dn-w-<folder name>). --w-c1..c8 = its default colours (D3 Studio writes the
   COLOURS block); the other --w-* variables reach the code as \`theme\`. */

/* ===== PAGE ===== */
.CHART {
  --w-font: 'Exo 2', system-ui, sans-serif;
  --w-bg: var(--bg); --w-panel: var(--panel); --w-panel-2: var(--panel-2); --w-sel: var(--sel);
  --w-text: var(--text); --w-text-2: var(--text-2); --w-muted: var(--muted); --w-border: var(--border); --w-accent: var(--blue);
}
.CHART > div { position: relative; }
.CHART > div > svg { display: block; width: 100%; height: 100%; font-family: var(--w-font); color: var(--w-text-2); }
`;
  // The chart's style sheet with this colour block (an existing sheet keeps everything else).
  function styleCss(name) {
    const old = editing?.styleCss;
    if (!old) return baseStyle(name) + colourBlock();
    if (COLOUR_BLOCK.test(old)) return old.replace(COLOUR_BLOCK, colourBlock());
    const at = old.search(SHADOW);
    return at < 0 ? old.replace(/\s*$/, '\n') + colourBlock() : old.slice(0, at) + colourBlock() + '\n' + old.slice(at);
  }

  // ---- starter code: scales, svg, grid and axes from the inputs (X / Y accessors), marks to fill in ----
  function starter() {
    const xi = inputs.find(i => i.axis === 'x') || inputs[0], yi = inputs.find(i => i.axis === 'y') || inputs.find(i => i !== xi);
    const acc = new Map(D3Render.accessors('', inputs.map(i => i.key)).map(([a, k]) => [k, a]));
    const get = i => !i ? '(d => 0)' : acc.get(i.key) || `(d => d[${JSON.stringify(i.key)}])`;
    const X = get(xi), Y = get(yi), r = xi && resolve(links[xi.key]), sv = xi && rows[0]?.[xi.key];
    const kind = !xi ? 'band' : xi.role === 'measure' ? 'linear' : (r ? DATE.test(r.type) : sv instanceof Date || /^\d{4}-\d{2}-\d{2}/.test(String(sv ?? ''))) ? 'time' : 'band';
    const xScale = kind === 'band' ? `d3.scaleBand().domain(data.map(${X})).range([margin.left, W - margin.right]).padding(0.2)`
      : kind === 'time' ? `d3.scaleUtc().domain(d3.extent(data, d => new Date(${X}(d)))).range([margin.left, W - margin.right])`
      : `d3.scaleLinear().domain(d3.extent(data, ${X})).nice().range([margin.left, W - margin.right])`;
    const xAt = kind === 'time' ? `x(new Date(${X}(d)))` : `x(${X}(d))`;
    const marks = kind === 'band'
      ? `// Bars: one per row, from y = 0 up to Y.
svg.append('g').attr('fill', colors[0])
  .selectAll('rect').data(data).join('rect')
    .attr('x', d => ${xAt}).attr('y', d => y(${Y}(d)))
    .attr('width', x.bandwidth()).attr('height', d => y(0) - y(${Y}(d)))
    .attr('rx', 2);`
      : `// Line: through every row, in X order.
svg.append('path').datum(data.slice().sort((a, b) => d3.ascending(${X}(a), ${X}(b))))
    .attr('fill', 'none').attr('stroke', colors[0]).attr('stroke-width', 2)
    .attr('d', d3.line().x(d => ${xAt}).y(d => y(${Y}(d))));`;
    return `// ${$('name').value.trim() || 'New chart'}. Ready made (see Generated above): data, ${[X, Y].filter(s => IDENT.test(s)).join(' / ')} accessors, W x H, colors, opts, theme.
const margin = { top: 16, right: 16, bottom: 32, left: 48 };

// Scales: data values -> pixels inside the box (the left margin fits the longest Y label).
const y = d3.scaleLinear().domain([0, d3.max(data, ${Y}) || 1]).nice().range([H - margin.bottom, margin.top]);
margin.left = 14 + 7 * d3.max(y.ticks(5).map(y.tickFormat(5)), s => s.length);
const x = ${xScale};

// The chart: an svg the size of the box (it scales with its box on the Dashboard).
const svg = d3.create('svg').attr('viewBox', [0, 0, W, H]);

// Grid lines (Settings: opts.grid.y = horizontal, opts.grid.x = vertical).
const grid = g => g.call(g => g.select('.domain').remove()).selectAll('line').attr('stroke', theme.border).attr('stroke-dasharray', '2,3');
if (opts.grid?.y) svg.append('g').attr('transform', \`translate(\${margin.left},0)\`)
    .call(d3.axisLeft(y).ticks(5).tickSize(-(W - margin.left - margin.right)).tickFormat('')).call(grid);
if (opts.grid?.x) svg.append('g').attr('transform', \`translate(0,\${H - margin.bottom})\`)
    .call(d3.axisBottom(x).tickSize(-(H - margin.top - margin.bottom)).tickFormat('')).call(grid);

// Axes.
svg.append('g').attr('transform', \`translate(0,\${H - margin.bottom})\`).call(d3.axisBottom(x).tickSizeOuter(0));
svg.append('g').attr('transform', \`translate(\${margin.left},0)\`).call(d3.axisLeft(y).ticks(5))
    .call(g => g.select('.domain').remove());

// ---- Your marks (the part each chart changes) ----
${marks}

return svg.node();
`;
  }
  $('starter').onclick = UI.guard(async () => {
    if (code.value.trim() && !await UI.confirm('Replace the code with starter code built from the Inputs?', { ok: 'Replace' })) return;
    code.value = starter(); run();
    if (!settings.some(s => s.path === 'grid.y')) { settings.push(...JSON.parse(JSON.stringify(NEW_SETTINGS)).filter(n => !settings.some(s => s.path === n.path))); drawSettings(); draw(); }
  });

  // ---- preview: drawn like the Dashboard draws it (the chart's style sheet on the box, then a plain inner <div>) ----
  let drawT = 0;
  const SESSION = 'd3studio.session';
  // This window's work (a refresh comes back to it): the chart open (id) + everything not in its files yet (the draft).
  // A new, unsaved chart is also kept for any window (localStorage). The code itself is in the live code file.
  let restoring = true;   // no draft writes until the page has finished opening (a half-opened page must not overwrite it)
  function writeDraft() {
    if (restoring) return;
    try {
      const st = JSON.stringify({ id: editing?.id || '', at: Date.now(), name: $('name').value, cat: $('cat').value, desc: $('desc').value, data: data.value, inputs, links, order, source });
      sessionStorage.setItem(SESSION, st); if (!editing) localStorage.setItem(SESSION + '.new', st);
    } catch {}
  }
  const boxSize = () => { const pv = $('pv'); return [Math.max(60, Math.floor(pv.clientWidth)), Math.max(60, Math.floor(pv.clientHeight))]; };
  const schedule = () => { clearTimeout(drawT); drawT = setTimeout(draw, 16); };   // a timer, not a frame: also runs while the window is hidden
  function chartInputs() { return Object.fromEntries(inputs.map(i => [i.key, { key: i.key, label: labelOf(i), role: i.role, agg: aggOf(i) || undefined, field: resolve(links[i.key]) ? fieldText(i) : '' }])); }
  function draw() {
    if (liveText !== null) liveWrite();   // the live code file follows the editor (once the open has read it)
    clearTimeout(drawT);
    if (data.value !== parsedText) parseData();
    // This window's state (code is in the live file): a refresh comes back to it, a new window starts clean.
    writeDraft();
    const pv = $('pv'), err = $('err');
    ApexWidget.useStyle({ id: 'd3-studio-preview', styleCss: styleCss($('name').value || 'Chart') }, pv);
    const [W, H] = boxSize();
    // The same inner box every time (D3Render animates from its previous drawing).
    if (!pv.firstElementChild || pv.children.length !== 1) pv.innerHTML = '<div style="width:100%;height:100%;overflow:hidden"></div>';
    if (dataErr && !liveRows) { err.className = ''; err.textContent = dataErr; return; }
    const th = ApexWidget.theme(pv), t0 = performance.now(), was = runErr, use = liveRows || rows;
    runErr = null;
    try {
      const se = syntaxErrs(ran);
      if (se.length) throw Object.assign(new SyntaxError(se[0].message.replace(/^SyntaxError: /, '')), { at: se[0] });
      const runId = ++runSeq, box = pv.firstElementChild;
      const res = D3Render.draw(box, ran, use.map(r => ({ ...r })), { W, H, colors: colours.map((c, i) => c || th.colors[i] || themeColour(i)), opts: previewOpts(), theme: th, inputs: chartInputs() });
      lastRun = { id: runId, at: Date.now(), code: ran };
      const info = `${UI.ms(performance.now() - t0)} · ${dataNote || `${use.length.toLocaleString()} sample rows`} · ${W} x ${H} px`;
      const why = emptyWhy(box, res, use);
      err.className = linkErr || why ? '' : 'ok';
      err.textContent = why ? `Nothing was drawn. ${why}` : linkErr ? `${linkErr}\nDrawn with the sample data.` : `Drawn in ${info}${res.redirected.length ? ` · d3.select(${res.redirected.map(s => `'${s}'`).join(', ')}) = the chart box (el)` : ''}`;
      // Async code (a Promise, d3.csv(...).then, timers): tell when it ends, and what it drew by then.
      if (res.result && typeof res.result.then === 'function') {
        if (!why) err.textContent += ' · async: still drawing…';
        res.result.then(() => { if (runId !== runSeq) return; const w2 = emptyWhy(box, { ...res, result: null }, use); err.className = w2 ? '' : 'ok'; err.textContent = w2 ? `Nothing was drawn (async code finished). ${w2}` : `Drawn (async) · ${info}`; },
          e => { if (runId === runSeq) asyncError(e); });
      }
    } catch (e) {
      const at = e.at || whereIn(e), msg = assist.explain(e.message);
      if (!e.at && at) runErr = { ...at, code: ran, message: `${e.name}: ${msg}` };
      err.className = ''; err.textContent = `${e.name}: ${msg}${at ? ` (line ${at.line})` : ''}`;
    }
    if (JSON.stringify(was) !== JSON.stringify(runErr)) code.recheck();   // the editor marks the new runtime error (or clears the old one)
  }
  // ---- why nothing shows: the run ended with an empty chart box ----
  let runSeq = 0, lastRun = null;
  function emptyWhy(box, res, use) {
    const svg = box.querySelector('svg'), any = box.firstElementChild;
    const empty = !any || (svg && !svg.querySelector('*') && box.children.length === 1);
    if (!empty) return '';
    if (res.result && typeof res.result.then === 'function') return '';   // async: judged when it ends
    const why = [], c = D3Assist.blank(ran);
    const fetchers = [...c.matchAll(/\bd3\s*\.\s*(csv|tsv|dsv|json|text|xml|html|svg|blob|buffer|image)\s*\(/g)].map(m => `d3.${m[1]}()`);
    if (fetchers.length) why.push(`${[...new Set(fetchers)].join(', ')} loads a file from outside, later (D3 v7: a Promise, no callback), so its drawing code never runs here: draw from data (the chart's rows, from Inputs / Sample data) instead.`);
    if (!any) why.push(res.result === undefined ? 'The code returned nothing and put nothing in el: end with return svg.node(), or draw into el (d3.select(el).append(\'svg\')).'
      : `The code returned ${res.result === null ? 'null' : typeof res.result} instead of a node: end with return svg.node().`);
    else why.push('The svg is empty: no marks were added to it.');
    if (!use.length) why.push('data has 0 rows (no sample rows, or the linked fields returned nothing).');
    return why.join(' ');
  }
  // Errors thrown later (callbacks, Promises, timers) from the chart code: shown and marked like any run error.
  function asyncError(e) {
    if (!lastRun || lastRun.code !== ran) return;
    const at = whereIn(e), msg = assist.explain(String(e?.message || e));
    $('err').className = ''; $('err').textContent = `${e?.name || 'Error'} (async, after the chart ran): ${msg}${at ? ` (line ${at.line})` : ''}`;
    if (at) { runErr = { ...at, code: ran, message: `${e?.name || 'Error'}: ${msg}` }; code.recheck(); }
  }
  const fromChart = e => /<anonymous>:\d+:\d+/.test(String(e?.stack || '')) && lastRun && Date.now() - lastRun.at < 120000;
  addEventListener('error', e => { if (fromChart(e.error)) { e.preventDefault(); asyncError(e.error); } });
  addEventListener('unhandledrejection', e => { if (fromChart(e.reason)) { e.preventDefault(); asyncError(e.reason); } });
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
    s.textContent = `window.__dnD3Check = function (${D3Render.PARAMS.join(', ')}) { "use strict";\n${text}\n};`;
    document.head.append(s); s.remove();
    removeEventListener('error', on);
    synFor = text;
    return (synErrs = hit ? [{ line: Math.max(1, hit.lineno - 1), col: Math.max(1, hit.colno), message: String(hit.message).replace(/^Uncaught /, '').replace(/Failed to execute '\w+' on '\w+': /, '') }] : []);
  }
  let runErr = null;   // { line, col, code, message } of the last preview run
  // Editor check: syntax errors; else D3 names D3 does not have (d3-assist.js) and the preview's runtime error while the code is the same.
  function checkCode(text) {
    const pos = ({ line, col }) => { const ls = text.split('\n'); return ls.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + Math.min(col - 1, (ls[line - 1] || '').length); };
    if (syntaxErrs(text).length) return syntaxErrs(text).map(e => ({ pos: pos(e), end: pos(e) + 1, line: e.line, message: `${e.message} (line ${e.line})` }));
    const out = assist.check(text).map(e => ({ ...e, message: `${e.message} (line ${e.line})` }));
    if (runErr && runErr.code === text && !out.some(e => e.line === runErr.line)) out.push({ pos: pos(runErr), end: pos(runErr) + 1, line: runErr.line, message: `${runErr.message} (line ${runErr.line})` });
    return out;
  }

  // ---- live code file: workspace/chart-builder/dev/<id>/d3-code.js (a new, unsaved chart: workspace/chart-builder/dev/_new/d3-code.js) is always the
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
      if (!st.exists) {
        // The chart's folder was deleted: never bring it back; the editor becomes a new (unsaved) chart on _new.
        if (editing && !(await DNFS.stat(`${DEV}/${editing.id}/${ChartRegistry.MANIFEST}`, { quiet: true }).catch(() => ({}))).exists) {
          UI.toast(`${DEV}/${editing.id} was deleted: this is now a new, unsaved chart.`, 'warn', 8000);
          editing = null; await refreshList(); pickColour(); $('live').textContent = livePath();
        }
        liveText = null; liveWrite();
      }
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
  // Again once the global header is in (ui/js/core/embed.js adds it on DOMContentLoaded and pushes the studio down) and after fonts load.
  for (const ev of ['resize', 'DOMContentLoaded', 'load']) addEventListener(ev, placePreview);
  new ResizeObserver(placePreview).observe(document.documentElement);   // the window's size, however it changes
  placePreview();
  // Resizing: redrawn every frame at the new size (no wait, no animation), so the chart follows the window live.
  let rsFrame = 0;
  let rsWas = '';
  new ResizeObserver(() => { if (!rsFrame) rsFrame = requestAnimationFrame(() => { rsFrame = 0; const s = boxSize().join('x'); if (s === rsWas) return; rsWas = s; updateGen(); draw(); }); }).observe($('pv').parentElement);   // only a real size change redraws
  $('name').addEventListener('input', schedule);
  $('helpbtn').onclick = () => { $('help').hidden = !$('help').hidden; };

  // ---- load a sample file ----
  $('load').onclick = () => $('file').click();
  $('file').onchange = UI.guard(async () => {
    const f = $('file').files[0]; $('file').value = ''; if (!f) return;
    if (f.size > 20 * 1048576) throw new Error('Sample files over 20 MB are too big: use a few hundred rows.');
    let text = await f.text();
    if (!/\.json$/i.test(f.name)) { const r = parse(text); if (r.length > 2000) { UI.toast(`Kept the first 2,000 of ${r.length.toLocaleString()} rows.`); } text = JSON.stringify(r.slice(0, 2000), null, 2); }
    data.value = text; parseData(); updateGen(); draw();
  });

  // ---- open a chart (from the dev folder) ----
  let live = new Set();   // folders published to the live folder
  async function refreshList(selectId = '') {
    [all, live] = await Promise.all([ChartRegistry.scan(DEV, { only: m => m.kind === 'd3' }),
      DNFS.list(LIVE_DIR).then(es => new Set(es.filter(e => e.dir).map(e => e.name))).catch(() => new Set())]);
    // Charts A to Z by name; published ones (in the live folder) in green.
    const abc = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
    $('pick').innerHTML = `<option value="">New chart</option>${[...all].sort((a, b) => abc(a.name, b.name)).map(m => `<option value="${esc(m.id)}"${live.has(m.id) ? ' class="pub" title="Published: on the Dashboard"' : ''} ${m.id === selectId ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}`;
    pickColour(); fitSelect($('pick'));
    // Categories: the usual ones + every category in use, A to Z, then New category….
    cats = [...new Set([...CATS, ...all.map(m => m.category).filter(Boolean), ...cats])].sort(abc);
    setCat($('cat').value);
  }
  // Chart / Category lists: as wide as their longest entry (text width + padding and the arrow), never narrower than 120px.
  let measure;
  function fitSelect(sel) {
    const cs = getComputedStyle(sel), ctx = (measure ||= document.createElement('canvas').getContext('2d'));
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const text = Math.max(0, ...[...sel.options].map(o => ctx.measureText(o.textContent).width));
    const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
    sel.style.width = `${Math.max(120, Math.ceil(text + pad + 28))}px`;
  }
  addEventListener('load', () => { fitSelect($('pick')); fitSelect($('cat')); });   // again once the theme font is in
  const pickColour = () => $('pick').classList.toggle('pub', !!$('pick').selectedOptions[0]?.classList.contains('pub'));
  // ---- category: a list like the Chart list (New category… adds one) ----
  let cats = [];
  function setCat(v) {
    v = String(v || '').trim();
    if (v && !cats.includes(v)) cats = [...cats, v].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    $('cat').innerHTML = `<option value="">Choose…</option>${cats.map(c => `<option ${c === v ? 'selected' : ''}>${esc(c)}</option>`).join('')}<option value="__new">New category…</option>`;
    $('cat').value = v; fitSelect($('cat'));
  }
  let catWas = '';
  $('cat').onfocus = () => { catWas = $('cat').value; };
  $('cat').onchange = UI.guard(async () => {
    if ($('cat').value !== '__new') { catWas = $('cat').value; return schedule(); }
    const r = await UI.form('New category', [{ name: 'cat', label: 'Category', type: 'text', required: true }], { ok: 'Add' });
    setCat(r?.cat?.trim() || catWas); catWas = $('cat').value; schedule();
  });
  // Inputs of an older chart without them: one per sample column (x / y keys go to that axis, numbers = measures).
  function inputsFromSample(r) {
    const keys = [...new Set(r.flatMap(o => Object.keys(o)))], taken = new Set();
    const num = k => r.some(o => typeof o[k] === 'number') && !r.some(o => o[k] != null && typeof o[k] !== 'number');
    return keys.map(k => {
      const i = num(k) ? { key: k, label: human(k), role: 'measure', agg: 'sum' } : { key: k, label: human(k), role: 'dimension' };
      i.axis = /^(x|y)$/i.test(k) && !taken.has(k.toLowerCase()) ? k.toLowerCase() : i.role === 'measure' && !taken.has('y') ? 'y' : !taken.has('x') && i.role !== 'measure' ? 'x' : !taken.has('series') && i.role !== 'measure' ? 'series' : 'other';
      if (i.axis === 'series') i.optional = true;
      taken.add(i.axis); return i;
    });
  }
  // fresh = start over (New chart picked): the live file takes the editor's code instead of giving its own.
  async function openChart(m, fresh = false) {
    liveText = null;   // no live file writes until liveOpen has read the new one
    editing = m || null;
    $('name').value = m?.name || ''; setCat(m?.category || ''); $('desc').value = m?.description || '';
    data.value = JSON.stringify(m ? m.sampleRows || [] : NEW_SAMPLE, null, 2); parseData();
    inputs = m ? (m.inputs?.length ? m.inputs : inputsFromSample(rows)).map(i => ({ ...i })) : NEW_INPUTS();
    links = { ...(m?.studio?.links || {}) };
    order = { sort: m?.specJson?.query?.sort || 'desc', top: +m?.specJson?.query?.top || 20 };
    const want = m?.studio?.table || splitLink(Object.values(links)[0])?.table;
    if (want) setSource(sourceFor(m?.studio?.project, want) || source); else if (m) setSource('');
    colours = m ? coloursFrom(m.styleCss) : colours.map((_, i) => themeColour(i) || null);   // new: starts from the app palette
    settings = JSON.parse(JSON.stringify(m ? (m.options || []).filter(o => !/^colors\.\d+$/.test(o.path)) : NEW_SETTINGS));
    code.value = m ? m.codeJs || '' : starter();   // new chart: the starter code
    drawInputs(); drawOrder(); drawColours(); drawSettings(); run(); refreshData();
    return liveOpen(fresh);
  }
  $('pick').onchange = UI.guard(async () => {
    const id = $('pick').value; pickColour();
    if (!await UI.confirm(id ? 'Open this chart? Unsaved changes here are lost.' : 'Start a new chart? Unsaved changes here are lost.')) { $('pick').value = editing?.id || ''; pickColour(); return; }
    await openChart(id ? all.find(m => m.id === id) : null, !id);
  });

  // A draft back on screen. Never an empty sample (the chart would have no rows): then the sample stays as opened.
  function applyDraft(d) {
    $('name').value = d.name || ''; setCat(d.cat || ''); $('desc').value = d.desc || '';
    if (String(d.data || '').trim()) { data.value = d.data; parseData(); }
    if (Array.isArray(d.inputs) && d.inputs.length) inputs = d.inputs;
    if (d.links) links = d.links;
    if (d.order) order = d.order;
    // The dataset: its key, else the table its fields point at.
    const key = sources.some(s => s.key === d.source) ? d.source : sourceFor('', splitLink(Object.values(links)[0])?.table);
    setSource(key);
    drawInputs(); drawOrder(); updateGen(); refreshData(); draw();
  }
  // F5 / Ctrl+R: save first (no questions), then reload and reopen the same chart. A chart that cannot be saved quietly
  // (no name yet, a name taken by another chart, an error in it) keeps its draft instead.
  async function quickSave() {
    const name = $('name').value.trim();
    if (!name || (!editing && all.some(m => m.id === ChartRegistry.slug(name)))) return false;
    try { return !!(await save()); } catch { return false; }
  }
  let reloading = false;
  addEventListener('keydown', async e => {
    if (!(e.key === 'F5' || ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'r'))) return;
    e.preventDefault(); e.stopPropagation();
    if (reloading) return; reloading = true;
    await quickSave(); writeDraft();
    location.reload();
  }, true);
  addEventListener('beforeunload', writeDraft);   // other reloads (browser button): at least the draft

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
    D3Render.compile(code.value, inputs.map(i => i.key));   // a syntax error stops the save
    if (!inputs.length) throw new Error('The chart has no inputs: Add input (x, y ...).');
    const keys = inputs.map(i => i.key), badKey = keys.find((k, n) => !IDENT.test(k) || RESERVED.has(k) || keys.indexOf(k) !== n);
    if (badKey !== undefined) throw new Error(`Input "${badKey}": use a JavaScript name, once, not one of data / el / W / H / colors / opts / theme / inputs.`);
    const paths = settings.map(s => s.path), badPath = paths.find(p => !PATH.test(p) || /^(\$kind|colors)\b/.test(p)),
      twice = paths.find((p, k) => paths.indexOf(p) !== k || paths.some(q => q.startsWith(p + '.')));
    if (badPath !== undefined) throw new Error(`Setting "opts.${badPath}": use names like grid.show (letters, digits, _ and dots; not colors or $kind).`);
    if (twice) throw new Error(`Setting "opts.${twice}" is used twice (or also holds another setting).`);
    const opts = settings.map(s => ({ path: s.path, label: s.label.trim() || human(s.path), group: s.group.trim() || 'General', type: s.type, default: asType(s, s.default),
      ...(s.type === 'number' ? { min: s.min ?? 0, max: s.max ?? 100, step: s.step ?? 1 } : {}), ...(s.type === 'select' ? { choices: s.choices || [] } : {}), show: s.show !== false }));
    const id = editing?.id || ChartRegistry.slug(name);
    if (!editing && all.some(m => m.id === id) && !await UI.confirm(`A chart folder "${DEV}/${id}" already exists. Replace it?`, { danger: true, ok: 'Replace' })) return null;
    const dir = `${DEV}/${id}`, ins = inputs.map(i => ({ ...i, label: i.axis === 'other' ? i.label || human(i.key) : labelOf(i) })).map(({ key, label, role, agg, optional, axis }) => ({ key, label, role, axis, ...(role === 'measure' ? { agg: agg || 'sum' } : {}), ...(optional ? { optional: true } : {}) }));
    const pic = thumb();
    const m = {
      id, name, description: $('desc').value.trim(), category: $('cat').value.trim() || 'Other',
      version: (+editing?.version || 0) + 1, kind: 'd3', spec: 'spec.json', style: 'style.css', code: LIVE, sample: 'sample.json',
      ...(pic ? { thumb: 'thumb.svg' } : {}), inputs: ins,
      options: colours.map((_, i) => ({ path: `colors.${i}`, label: `Colour ${i + 1}`, group: 'Colours', type: 'color', default: null, show: true })).concat(opts),
      // D3 Studio test data only (the Dashboard starts every chart unlinked).
      studio: { project, table: [...tables.keys()][0] || '', links: Object.fromEntries(Object.entries(links).filter(([k]) => keys.includes(k))) },
      updated: new Date().toISOString(),
    };
    await DNFS.writeText(`${dir}/${LIVE}`, code.value);
    await DNFS.writeJSON(`${dir}/sample.json`, rows);
    await DNFS.writeJSON(`${dir}/spec.json`, { $kind: 'd3', data: ins, query: { sort: order.sort, top: order.top } });
    await DNFS.writeText(`${dir}/style.css`, styleCss(name));
    if (pic) await DNFS.writeText(`${dir}/thumb.svg`, pic);
    await DNFS.writeJSON(`${dir}/${ChartRegistry.MANIFEST}`, m);
    await refreshList(id);
    const wasNew = !editing;
    editing = all.find(x => x.id === id) || null;
    // A new chart's live code file is now its folder's d3-code.js.
    if (wasNew) { liveText = code.value; liveMod = (await DNFS.stat(livePath(), { quiet: true })).modified; $('live').textContent = livePath(); await DNFS.remove(`${DEV}/_new`, { recursive: true }).catch(() => {}); }
    draw();   // also keeps this window's state (a refresh reopens the saved chart)
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
    await Promise.all([refreshList(), loadSources()]);
    // Reopen what this window was on: a saved chart from its files (its dataset, fields, sample data, everything frozen
    // at its last Save; F5 saves first), plus the draft when that is newer; a new chart from its draft.
    let saved = null; try { saved = JSON.parse(sessionStorage.getItem(SESSION)) || (UI.params().chart ? null : JSON.parse(localStorage.getItem(SESSION + '.new'))); } catch {}
    const asked = UI.params().chart || UI.params().widget;
    if (asked && saved && saved.id !== asked) saved = null;   // opened for another chart: that one, not this window's last state
    const want = saved ? saved.id : asked, m = want ? all.find(x => x.id === want && x.kind === 'd3') : null;
    await openChart(m, !saved && !want);
    if (saved && (!m || +saved.at > Date.parse(m.updated || 0))) applyDraft(saved);
    if (m) { $('pick').value = m.id; pickColour(); }
    restoring = false; writeDraft();
    liveWatch();
  })();
})();
