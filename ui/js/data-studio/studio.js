// Data Studio (ui/html/data-studio.html): the project's workflow as draggable, connectable nodes on the 24px grid
// (Import, Transform, Dashboard, Publish, Archive, Update schedule). In development.
(async () => {
  const $ = id => document.getElementById(id);
  const on = (t, type, fn, opt) => t.addEventListener(type, fn, opt);
  let ctx, saveT = 0, dirty = false, pvT = 0;   // the project (once loaded); pending save of the studio state; pending preview refresh
  // Data Preview: its tabs and table kept by reference (they move to the pop-out window and back); the pop-out window.
  // Declared first: the saved settings can show the preview while the page is still starting.
  const pvTabs = $('pvTabs'), pvBody = $('pvBody');
  let pvWin = null;
  let preview = { h: 240, tab: 'input' }, pvH = 0, pvRaf = 0;   // Data Preview drawer: its height, open tab; shown height (glides)
  let drawer = { id: null, on: false };   // the Settings drawer: the node it shows (null = hidden); on = comes back with the next selected node (off after X)
  // Data Studio settings (this browser).
  const PREFS = 'dn-data-studio-prefs';
  let prefs = { grid: true, snap: true, barPos: 'Top', autoHide: false, wire: 2, preview: false };
  try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem(PREFS) || '{}') }; } catch {}
  const savePrefs = () => { try { localStorage.setItem(PREFS, JSON.stringify(prefs)); } catch {} };
  const applyPrefs = () => {
    document.body.classList.toggle('nogrid', !prefs.grid);
    document.body.classList.toggle('barbottom', prefs.barPos === 'Bottom');
    document.body.style.setProperty('--ww', `${prefs.wire}px`);
    showPreview(prefs.preview);
    hideSoon();
  };
  // Auto Hide: the icon bar, and its open drop-down (the Nodes menu) with it, fade out once the mouse has been off both for
  // 2s; the drop-down stays open, so the mouse back on the bar brings both back.
  let hideT = 0;
  const barParts = () => [$('types'), document.getElementById('nodeMenu')].filter(Boolean);
  const overBar = () => barParts().some(el => el.matches(':hover'));
  function hideSoon() {
    clearTimeout(hideT);
    barParts().forEach(el => el.classList.remove('faded'));
    if (prefs.autoHide && !overBar()) hideT = setTimeout(() => { if (!overBar()) barParts().forEach(el => el.classList.add('faded')); }, 2000);
  }
  const barIn = () => { clearTimeout(hideT); barParts().forEach(el => el.classList.remove('faded')); };
  // Data Studio settings (top bar Settings): in the side drawer. Only drop-downs and toggles; groups, each A-Z, a line
  // between: drop-downs, then toggles. Applied at once.
  // drop-down items are always lower case
  function prefsHtml() {
    // choices: [value, label]; the value keeps its type (numbers stay numbers)
    const pick = (k, label, choices) => `<div class="optrow"><span>${label}</span><select data-k="${k}">${choices.map(([v, t]) => `<option value="${v}" ${prefs[k] === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>`;
    const row = (k, label) => `<div class="optrow"><span>${label}</span><span class="seg"><button type="button" data-k="${k}" data-on="0" class="${prefs[k] ? '' : 'on'}">OFF</button><button type="button" data-k="${k}" data-on="1" class="${prefs[k] ? 'on' : ''}">ON</button></span></div>`;
    return [
      pick('wire', 'Connector Thickness', [1, 2, 3, 4, 5].map(v => [v, `${v} px`])) + pick('barPos', 'Icon Bar Position', [['Top', 'top'], ['Bottom', 'bottom']]),
      row('autoHide', 'Auto Hide') + row('preview', 'Data Preview') + row('grid', 'Show Grid') + row('snap', 'Snap to Grid'),
    ].join('<div class="tm-sep"></div>');
  }
  function bindPrefs(box) {
    box.onchange = e => {
      const k = e.target.dataset?.k; if (!k || e.target.tagName !== 'SELECT') return;
      prefs[k] = typeof prefs[k] === 'number' ? +e.target.value : e.target.value; savePrefs(); applyPrefs();
    };
    box.onclick = e => {
      const b = e.target.closest('.seg button'); if (!b) return;
      prefs[b.dataset.k] = b.dataset.on === '1'; savePrefs(); applyPrefs();
      b.parentElement.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    };
  }
  $('types').addEventListener('pointerenter', barIn);
  $('types').addEventListener('pointerleave', () => hideSoon());
  applyPrefs();

  // View: grid 0, 0 = the window centre at no scroll. offX / offY = how far grid 0, 0 has moved from the window centre (px).
  // Zoom (mouse wheel, about the cursor) and Scroll (drag the empty grid) move only the grid and its nodes, never the UI.
  const Z_MIN = 0.2, Z_MAX = 4;
  let zoom = 1, offX = 0, offY = 0;
  const onGrid = t => t === $('stage') || t === $('nodes');   // the empty grid (not a node, not UI)
  function applyView() {
    save();
    const st = $('stage'), ox = st.clientWidth / 2 + offX, oy = st.clientHeight / 2 + offY;
    st.style.setProperty('--gs', `${24 * zoom}px`); st.style.setProperty('--gp', `${ox}px ${oy}px`);
    st.style.setProperty('--gm', `${96 * zoom}px`); st.style.setProperty('--gpm', `${ox - 48 * zoom}px ${oy - 48 * zoom}px`);   // 4 x 4 blocks, 0, 0 in the middle of one
    $('nodes').style.transform = `translate(${ox}px, ${oy}px) scale(${zoom})`;
    $('zPct').textContent = `${Math.round(zoom * 100)}%`;
    $('zReset').classList.toggle('off', Math.abs(zoom - 1) < 1e-6);
    // X / Y: the grid point at the window centre
    $('sPos').textContent = `X ${Math.round(-offX / zoom / 24)}  Y ${Math.round(-offY / zoom / 24)}`;   // grid squares (24px each)
    const c = home();   // Re-center fades out once the window is centred on it
    $('sReset').classList.toggle('off', Math.round(offX + c.x * zoom) === 0 && Math.round(offY + c.y * zoom) === 0);
  }
  $('stage').addEventListener('wheel', e => {
    if (e.target !== $('stage') && !$('nodes').contains(e.target)) return;   // only over the grid and its nodes, never over UI
    e.preventDefault();
    if (!e.deltaY) return;
    cancelAnimationFrame(viewRaf); viewRaf = 0;   // the wheel takes over from a Reset glide
    // 10% a wheel step, counted from where the zoom is heading (fast wheeling adds up); the view eases there about the cursor
    const z = Math.min(Z_MAX, Math.max(Z_MIN, (Math.round((zT ?? zoom) * 10) + (e.deltaY < 0 ? 1 : -1)) / 10));
    const r = $('stage').getBoundingClientRect();
    zT = z; zAt = { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 };
    if (!zRaf) zRaf = requestAnimationFrame(zoomStep);
  }, { passive: false });
  // Smooth wheel zoom: each frame a part of the way to the target, the grid point under the cursor staying put.
  let zT = null, zAt = { x: 0, y: 0 }, zRaf = 0;
  function zoomStep() {
    const d = zT - zoom, z = Math.abs(d) < 0.002 ? zT : zoom + d * 0.3;
    offX = zAt.x - (zAt.x - offX) * z / zoom; offY = zAt.y - (zAt.y - offY) * z / zoom; zoom = z;
    applyView();
    if (zoom === zT) { zT = null; zRaf = 0; } else zRaf = requestAnimationFrame(zoomStep);
  }
  const stopZoom = () => { cancelAnimationFrame(zRaf); zRaf = 0; zT = null; };
  // Scroll: hold the left button on the empty grid and drag; the grid and every node follow the mouse.
  $('stage').addEventListener('pointerdown', e => {
    if (e.button !== 0 || !onGrid(e.target)) return;
    e.preventDefault();
    cancelAnimationFrame(viewRaf); stopZoom();
    const st = $('stage'), x0 = e.clientX - offX, y0 = e.clientY - offY;
    st.setPointerCapture(e.pointerId); st.classList.add('grabbing');
    const move = ev => { offX = ev.clientX - x0; offY = ev.clientY - y0; applyView(); };
    const up = () => { st.classList.remove('grabbing'); st.removeEventListener('pointermove', move); st.removeEventListener('pointerup', up); st.removeEventListener('pointercancel', up); };
    st.addEventListener('pointermove', move); st.addEventListener('pointerup', up); st.addEventListener('pointercancel', up);
  });
  // Reset Zoom / Re-center glide there (ease-out, 300ms) instead of jumping.
  let viewRaf = 0;
  function animateView(z1, x1, y1) {
    cancelAnimationFrame(viewRaf); stopZoom();   // from exactly where the view is now, even mid-zoom
    const z0 = zoom, x0 = offX, y0 = offY, t0 = performance.now();
    const step = t => {
      const k = Math.min(1, (t - t0) / 300), e = 1 - (1 - k) ** 3;
      zoom = z0 + (z1 - z0) * e; offX = x0 + (x1 - x0) * e; offY = y0 + (y1 - y0) * e;
      if (k === 1) { zoom = z1; offX = x1; offY = y1; }
      applyView();
      viewRaf = k < 1 ? requestAnimationFrame(step) : 0;
    };
    viewRaf = requestAnimationFrame(step);
  }
  $('zReset').onclick = () => animateView(1, offX / zoom, offY / zoom);   // about the window centre
  // Re-center: the centre of all the nodes (their bounding box) to the window centre; no nodes = grid 0, 0.
  function home() {
    if (!nodes.length) return { x: 0, y: 0 };
    const L = Math.min(...nodes.map(n => n.x)), T = Math.min(...nodes.map(n => n.y)), R = Math.max(...nodes.map(n => n.x + n.w)), B = Math.max(...nodes.map(n => n.y + n.h));
    return { x: (L + R) / 2, y: (T + B) / 2 };
  }
  $('sReset').onclick = () => { const c = home(); animateView(zoom, -c.x * zoom, -c.y * zoom); };
  on(window, 'resize', applyView);

  // ---- Nodes: cards on the grid at grid px (x, y = top-left, w x h), input port(s) on the left, an output port on the right.
  // A Join node's one input takes any number of wires; every other node's input takes one. ----
  const G = 24, NS = 'http://www.w3.org/2000/svg', W0 = 8 * 24, H0 = 4 * 24, WMIN = 4 * 24, HMIN = 24;   // new node: 8 wide x 4 tall grid cells
  const ICON_IMPORT = '<path d="M12 3v12M7 10l5 5 5-5M4 19h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
  const ICON_TRANSFORM = '<path d="M4 7h12M13 4l3 3-3 3M20 17H8M11 14l-3 3 3 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
  const ICON_JOIN = '<path d="M4 6h5a4 4 0 0 1 4 4v4a4 4 0 0 0 4 4h3M4 18h5a4 4 0 0 0 4-4M17 15l3 3-3 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
  const SW = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  const ICON_SQL = `<ellipse cx="12" cy="5.5" rx="7" ry="2.5" ${SW}/><path d="M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5" ${SW}/>`;
  const ICON_FUNCTION = `<path d="M15 4h-2a3 3 0 0 0-3 3v11a3 3 0 0 1-3 3H6M7 11h8" ${SW}/>`;
  const ICON_APPEND = `<rect x="4" y="3" width="16" height="7" rx="1.5" ${SW}/><rect x="4" y="14" width="16" height="7" rx="1.5" ${SW}/><path d="M12 10v4" ${SW}/>`;
  const ICON_CHART = `<path d="M4 20V4M4 20h16M8 16v-4M12 16V8M16 16v-6" ${SW}/>`;
  const ICON_OUTPUT = `<path d="M12 15V3M7 8l5-5 5 5M4 19h16" ${SW}/>`;
  const ICONS = { import: ICON_IMPORT, transform: ICON_TRANSFORM, sql: ICON_SQL, function: ICON_FUNCTION, join: ICON_JOIN, append: ICON_APPEND, chart: ICON_CHART, output: ICON_OUTPUT };
  // The Nodes menu (top bar Nodes), in this order: [type, name]
  const NODE_TYPES = [['import', 'Input'], ['transform', 'Transform'], ['sql', 'SQL'], ['function', 'Function'], ['join', 'Join'], ['append', 'Append'], ['chart', 'Chart'], ['output', 'Output']];
  let nodes = [{ id: 'n1', type: 'import', title: 'Import', sub: 'Test node', x: -264, y: -48 },
               { id: 'n3', type: 'import', title: 'Import 2', sub: 'Test node', x: -264, y: 96 },
               { id: 'n4', type: 'join', title: 'Join', sub: 'Test node', x: 72, y: 96 },
               { id: 'n2', type: 'transform', title: 'Transform', sub: 'Test node', x: 72, y: -48 }];
  nodes.forEach(n => { n.w ??= W0; n.h ??= H0; });
  applyView();
  let links = [];   // { from: node id (its out port), to: node id (its in port) }
  const snap = v => prefs.snap ? Math.round(v / G) * G : Math.round(v);
  const nodeOf = id => nodes.find(m => m.id === id), elOf = id => $('nodes').querySelector(`.node[data-id="${id}"]`);
  // Nodes keep at least GAP (2 grid cells) apart: a rectangle (grid px) closer than that to another node (other than skip,
  // a Set of ids) is refused. Exactly GAP apart is fine.
  const GAP = 2 * G;
  const hits = (r, skip = new Set()) => nodes.some(m => !skip.has(m.id) && r.x < m.x + m.w + GAP && m.x - GAP < r.x + r.w && r.y < m.y + m.h + GAP && m.y - GAP < r.y + r.h);
  const multi = n => n.type === 'join' || n.type === 'append';   // one input dot, any number of wires
  const hasIn = n => n.type !== 'import';   // input nodes: an output only
  const hasOut = n => n.type !== 'output';   // output nodes: an input only
  const ins = n => links.filter(l => l.to === n.id);
  const wires = document.createElementNS(NS, 'svg'); wires.id = 'wires'; $('nodes').append(wires);
  const DIRS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
  function drawNode(n) {
    const el = document.createElement('div');
    el.className = `node t-${n.type}`; el.dataset.id = n.id;
    el.innerHTML = `<div class="nh"><svg viewBox="0 0 24 24">${ICONS[n.type]}</svg><b>${UI.esc(n.title)}</b><button type="button" class="nx" title="Delete this node">×</button></div><div class="nb">${UI.esc(n.sub)}</div>`
      + (hasIn(n) ? '<span class="port in" data-port="in"></span>' : '') + (hasOut(n) ? '<span class="port out" data-port="out"></span>' : '') + DIRS.map(d => `<span class="rz ${d}" data-dir="${d}"></span>`).join('');
    $('nodes').append(el); vis.set(n.id, { x: n.x, y: n.y, w: n.w, h: n.h }); putNode(el, n);
    el.classList.toggle('bar', n.h <= G);
  }

  // ---- Node Settings: a fixed drawer that slides out from the window's right side, 400px wide (long names wrap; screen
  // px, never zoomed). One node at a time: Settings on another node swaps it in. ----
  const STUDIO = '__studio';   // drawer.id while it shows the Data Studio settings
  // ---- Nodes menu (top bar Nodes): a row of tiles under it, like the top bar (4 across, as many rows as needed), centred
  // on the Nodes button. Drag a tile onto the grid = a new node there (centred on the mouse, snapped), selected; let go
  // anywhere else = nothing. ----
  function openNodeMenu(btn) {
    closeNodeMenu();
    const m = document.createElement('div'); m.className = 'nmenu'; m.id = 'nodeMenu';
    m.innerHTML = NODE_TYPES.map(([t, name]) => `<div class="type ntile t-${t}" data-type="${t}" title="Drag onto the grid"><svg viewBox="0 0 24 24">${ICONS[t]}</svg><span>${name}</span></div>`).join('');
    document.body.append(m);
    const r = btn.getBoundingClientRect();
    m.style.left = `${Math.max(8, Math.min(r.left + r.width / 2 - m.offsetWidth / 2, innerWidth - m.offsetWidth - 8))}px`;
    m.style.top = `${prefs.barPos === 'Bottom' ? r.top - 6 - m.offsetHeight : r.bottom + 6}px`;
    m.onpointerdown = dragNewNode;
    requestAnimationFrame(() => requestAnimationFrame(() => m.classList.add('in')));   // fades in (0.15s)
    m.addEventListener('pointerenter', barIn); m.addEventListener('pointerleave', () => hideSoon());
    syncBar();
  }
  // It stays open (drop as many nodes as wanted, work on the canvas) until Esc or Nodes again (or another top bar button).
  const closeNodeMenu = () => {   // fades out (0.15s), then goes
    const m = document.getElementById('nodeMenu'); if (m) { m.removeAttribute('id'); m.classList.remove('in'); m.style.pointerEvents = 'none'; setTimeout(() => m.remove(), 150); }
    syncBar();
  };
  on(window, 'keydown', e => { if (e.key === 'Escape') closeNodeMenu(); });
  // The top bar: while one of its buttons is in use (the Nodes menu open, the Data Studio settings open), the others dim.
  function syncBar() {
    const act = document.getElementById('nodeMenu') ? 'nodes' : drawer.id === STUDIO ? 'settings' : null;
    $('types').querySelectorAll('.type').forEach(t => { t.classList.toggle('dim', !!act && t.dataset.act !== act); t.classList.toggle('act', t.dataset.act === act); });
  }
  function dragNewNode(e) {
    const tile = e.target.closest('.ntile'); if (!tile || e.button !== 0) return;
    e.preventDefault();
    const type = tile.dataset.type, name = NODE_TYPES.find(x => x[0] === type)[1];
    const ghost = tile.cloneNode(true); ghost.classList.add('nd-ghost'); document.body.append(ghost);
    const at = ev => { ghost.style.left = `${ev.clientX}px`; ghost.style.top = `${ev.clientY}px`; };
    at(e); tile.setPointerCapture(e.pointerId); document.body.classList.add('nocursor');   // the dragged tile stands in for the pointer
    const overGrid = ev => { const t = document.elementFromPoint(ev.clientX, ev.clientY); return t && (onGrid(t) || !!t.closest('#nodes')); };
    const place = ev => { const p = toGrid(ev.clientX, ev.clientY); return { x: snap(p.x - W0 / 2), y: snap(p.y - H0 / 2), w: W0, h: H0 }; };
    const canDrop = ev => overGrid(ev) && !hits(place(ev));   // on the grid, not on another node
    const move = ev => { at(ev); ghost.classList.toggle('no', !canDrop(ev)); };
    const up = ev => {
      tile.removeEventListener('pointermove', move); tile.removeEventListener('pointerup', up); ghost.remove(); document.body.classList.remove('nocursor');
      if (!canDrop(ev)) return;
      const n = { id: `n${Date.now().toString(36)}`, type, title: name, sub: '', ...place(ev) };
      nodes.push(n); drawNode(n);
      $('nodes').querySelectorAll('.node.sel').forEach(x => x.classList.remove('sel')); elOf(n.id).classList.add('sel');
      drawLinks(); applyView();
    };
    tile.addEventListener('pointermove', move); tile.addEventListener('pointerup', up);
  }
  function openStudioSettings() {
    const d = $('drawer');
    drawer.id = STUDIO; drawer.on = true; d.className = 'drawer open';
    $('drTitle').textContent = 'DATA STUDIO SETTINGS'; syncBar();
    $('drBody').innerHTML = prefsHtml(); bindPrefs($('drBody')); filterSettings();
    save();
  }
  function openSettings(n) {
    const d = $('drawer');
    drawer.id = n.id; drawer.on = true; d.className = `drawer open t-${n.type}`; $('drBody').onclick = null;
    $('drTitle').textContent = `${n.title} Settings`; syncBar();
    $('drBody').onchange = $('drBody').onclick = null;
    $('drBody').innerHTML = `<div class="optrow"><span>Name</span><input type="text" data-k="title" value="${UI.esc(n.title)}" spellcheck="false"></div>`;
    $('drBody').oninput = null;
    if (n.type === 'import') inputSettings(n, $('drBody'));   // every input node: the same settings
    filterSettings();
    $('drBody').querySelector('[data-k="title"]').oninput = e => {
      n.title = e.target.value; elOf(n.id).querySelector('.nh b').textContent = n.title; $('drTitle').textContent = `${n.title} Settings`; save();
    };
    save();
  }
  // ---- Input node settings (every input node the same, for now): RAW SOURCE FILES and SCHEMA, as in the Import module.
  // Browse / drop / a typed path pick the files (only .csv, .tsv, .txt); Import then copies them into data/raw (Copy) or
  // keeps where they are (Link: a typed path only; browsed / dropped files are always copied, the browser hides their
  // location). The node keeps n.src = { mode, files: [{ name, path | origin, size, modified }], cols: [{ name, type,
  // newName, newType }] }; the schema is read from the first file. ----
  const INPUT_EXT = /\.(csv|tsv|txt)$/i;
  const pending = new Map();   // node id -> { files: [File], paths: [string] } picked, not imported yet
  // the Import module's own code (ui/js/import/import-core.js): types, names, casts, reader, preview
  const { TYPES, typeLabel, unquote, defName: colName } = ImportCore;
  function inputSettings(n, box) {
    const src = n.src ||= { mode: 'copy', files: [], cols: [] };
    const pend = pending.get(n.id) || { files: [], paths: [] }; pending.set(n.id, pend);
    const picked = [...pend.files.map(f => f.name), ...pend.paths.map(p => ExternalSource.name(p))];
    let open = null;   // the schema field expanded
    const draw = () => {
      const fileRows = picked.length ? picked.map(t => `<div class="in-f"><span>${UI.esc(t)}</span><small>to import</small></div>`).join('')
        : src.files.map(f => `<div class="in-f" title="${UI.esc(f.path || f.origin)}"><span>${UI.esc(f.name)}</span><small>${f.path ? 'copied' : 'linked'}</small></div>`).join('');
      const cols = src.cols.map((c, i) => [c, i]).sort((a, b) => a[0].name.localeCompare(b[0].name, undefined, { sensitivity: 'base', numeric: true }));
      box.querySelectorAll('.in-part').forEach(x => x.remove());
      box.insertAdjacentHTML('beforeend', `<div class="tm-sep in-part"></div>
        <div class="dr-sec in-part">RAW SOURCE FILES</div>
        <div class="dr-full in-part">
          <div class="in-row"><button type="button" class="ghost" data-in="browse">Browse</button><input type="text" class="in-path" placeholder="File path: X:\\folder\\file.csv, Enter" spellcheck="false"></div>
          <input type="file" class="in-file" multiple hidden accept=".csv,.tsv,.txt">
          <div class="in-drop">Drop .csv, .tsv or .txt files here</div>
          <div class="in-mode">
            <label><input type="radio" name="imode-${n.id}" value="copy" ${src.mode !== 'link' ? 'checked' : ''}> Copy raw files to project</label>
            <label><input type="radio" name="imode-${n.id}" value="link" ${src.mode === 'link' ? 'checked' : ''}> Link to raw file's location</label>
            ${src.mode === 'link' ? '<div class="in-hint">Link works with a typed path. Browse and drop always copy (the browser does not tell the app where a file is).</div>' : ''}
          </div>
          ${fileRows ? `<div class="in-list">${fileRows}</div>` : ''}
          <div class="in-row"><button type="button" data-in="import" ${picked.length ? '' : 'disabled'}>Import</button><span class="in-st"></span></div>
        </div>
        <div class="tm-sep in-part"></div>
        <div class="dr-sec in-part">SCHEMA</div>
        <div class="dr-full in-part">${cols.length ? `<div class="sc-list">${cols.map(([c, i]) => `<div class="sc-f${open === i ? ' open' : ''}" data-i="${i}">
            <div class="sc-h"><span class="nd-arr"></span><span class="sc-n">${UI.esc(c.name)}</span>${c.newName !== colName(c.name) || c.newType !== c.type ? '<small>changed</small>' : ''}</div>
            ${open === i ? `<div class="sc-b">
              <div class="optrow"><span>Detected Type</span><span class="sc-t">${UI.esc(c.type)}</span></div>
              <div class="optrow"><span>Change Type</span><select data-sc="newType">${[...new Set([c.type, ...TYPES])].map(t => `<option value="${UI.esc(t)}" ${t === c.newType ? 'selected' : ''}>${UI.esc(typeLabel(t))}</option>`).join('')}</select></div>
              <div class="optrow"><span>Rename</span><input type="text" data-sc="newName" value="${UI.esc(c.newName)}" spellcheck="false"></div>
            </div>` : ''}</div>`).join('')}</div>` : '<div class="in-hint">Import a file to see its fields.</div>'}</div>`);
      const drop = box.querySelector('.in-drop');
      drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
      drop.ondragleave = () => drop.classList.remove('over');
      drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); take([...e.dataTransfer.files], []); };
      box.querySelector('.in-file').onchange = e => { take([...e.target.files], []); e.target.value = ''; };
      const path = box.querySelector('.in-path');
      path.addEventListener('paste', e => { const t = unquote(e.clipboardData?.getData('text/plain') || ''); if (t) { e.preventDefault(); path.value = t; } });
      path.addEventListener('keydown', e => { if (e.key === 'Enter') { const t = unquote(path.value); if (!ExternalSource.isPath(t)) return UI.toast('Enter a full path like X:\\folder\\file.csv or \\\\server\\share\\file.csv.', 'err'); take([], [t]); } });
    };
    // picked files: only .csv / .tsv / .txt
    function take(files, paths) {
      const bad = [...files.map(f => f.name), ...paths].filter(t => !INPUT_EXT.test(t));
      if (bad.length) UI.toast(`Only .csv, .tsv or .txt files: ${bad.map(t => ExternalSource.name(t)).join(', ')} left out.`, 'err');
      pend.files = files.filter(f => INPUT_EXT.test(f.name)); pend.paths = paths.filter(t => INPUT_EXT.test(t));
      picked.splice(0, picked.length, ...pend.files.map(f => f.name), ...pend.paths.map(t => ExternalSource.name(t)));
      draw();
    }
    const status = t => { const el = box.querySelector('.in-st'); if (el) el.textContent = t; };
    async function runImport() {
      const RAW = `${ctx.dir}/data/raw`, out = [];
      box.querySelector('[data-in="import"]').disabled = true;
      try {
        for (const f of pend.files) {   // browsed / dropped: always a copy
          status(`Copying ${f.name}…`); await DNFS.upload(f, RAW);
          out.push({ name: f.name, path: `${RAW}/${f.name}`, origin: null, size: f.size, modified: new Date(f.lastModified).toISOString() });
        }
        for (const p of pend.paths) {
          const name = ExternalSource.name(p);
          status(`Checking ${name}…`); const info = await ExternalSource.probe(p);
          if (src.mode === 'link') out.push({ name, path: null, origin: p, size: info.size, modified: info.modified });
          else {
            status(`Copying ${name}…`); await ExternalSource.copy(p, `${RAW}/${name}`, (d, t) => status(`Copying ${name}: ${UI.bytes(d)} of ${UI.bytes(t)}`));
            out.push({ name, path: `${RAW}/${name}`, origin: null, from: p, size: info.size, modified: info.modified });
          }
        }
        status('Reading the schema…');
        const first = out[0], where = first.path || first.origin;
        const r = await ImportCore.reader(where);
        const cols = await Engine.describe(`SELECT * FROM ${await r.sql(r.tables[0])}`);
        const old = new Map(src.cols.map(c => [c.name, c]));   // choices already made for a field carry over
        src.files = out;
        src.cols = cols.map(c => { const o = old.get(c.name); return { name: c.name, type: c.type, newName: o?.newName || colName(c.name), newType: o && o.type === c.type ? o.newType : c.type }; });
        pend.files = []; pend.paths = []; picked.length = 0;
        ctx.log(`${n.title}: ${out.length} file${out.length > 1 ? 's' : ''} ${src.mode === 'link' ? 'linked' : 'copied'} (${out.map(f => f.name).join(', ')}), ${src.cols.length} fields`, 'ok');
        save(); draw();
      } catch (e) { status(''); UI.toast(e.message, 'err'); box.querySelector('[data-in="import"]').disabled = false; }
    }
    box.onclick = e => {
      const b = e.target.closest('[data-in]');
      if (b?.dataset.in === 'browse') return box.querySelector('.in-file').click();
      if (b?.dataset.in === 'import') return runImport();
      const f = e.target.closest('.sc-h');   // a field: expand it (another one, or a click off it, collapses)
      if (f) { const i = +f.parentElement.dataset.i; open = open === i ? null : i; return draw(); }
      if (open != null && !e.target.closest('.sc-b')) { open = null; draw(); }
    };
    box.onchange = e => {
      if (e.target.name === `imode-${n.id}`) { src.mode = e.target.value; save(); return draw(); }
      if (e.target.dataset.sc && open != null) { src.cols[open][e.target.dataset.sc] = e.target.value.trim(); save(); }
    };
    box.oninput = e => { if (e.target.dataset.sc === 'newName') { const el = e.target, p = el.selectionStart; el.value = el.value.toUpperCase().replace(/\s/g, '_'); el.setSelectionRange(p, p); } };   // as the Import module: upper case, spaces become _
    draw();
  }

  // Search (top of the drawer): only the settings' names, live; matching text in gold (the app's gold, #d4a72c). A group with no match hides
  // with its line.
  function filterSettings() {
    const q = $('drQ').value.trim().toLowerCase(), body = $('drBody');
    for (const r of body.querySelectorAll('.optrow')) {
      const lab = r.firstElementChild, t = lab.dataset.t ??= lab.textContent, i = q ? t.toLowerCase().indexOf(q) : -1;
      r.hidden = !!q && i < 0;
      lab.innerHTML = i < 0 ? UI.esc(t) : `${UI.esc(t.slice(0, i))}<mark>${UI.esc(t.slice(i, i + q.length))}</mark>${UI.esc(t.slice(i + q.length))}`;
    }
    // a line only between two groups that both still show something
    const groups = [[]], seps = [];
    for (const k of body.children) if (k.classList.contains('tm-sep')) { seps.push(k); groups.push([]); } else groups.at(-1).push(k);
    const shows = groups.map(g => g.some(r => !r.hidden));
    seps.forEach((sp, j) => { sp.hidden = !(shows.slice(0, j + 1).some(Boolean) && shows.slice(j + 1).some(Boolean)) || !shows[j + 1]; });
  }
  $('drQ').oninput = filterSettings;
  const hideSettings = () => { drawer.id = null; $('drawer').classList.remove('open'); syncBar(); save(); };   // clicked off a node: back with the next one
  function closeSettings() { drawer.on = false; hideSettings(); }   // X: back only with a double-click
  $('drX').onclick = closeSettings;
  $('drawer').addEventListener('pointerdown', e => e.stopPropagation());   // its own clicks: no grid scroll, no deselect
  $('drawer').addEventListener('wheel', e => e.stopPropagation());

  // Shown position: glides to the node's (snapped) place over a few frames instead of jumping a grid cell; wires and
  // ports follow what is shown.
  const vis = new Map();   // node id -> { x, y, w, h } on screen
  let glideRaf = 0;
  const rectOf = n => vis.get(n.id) || n;
  const putNode = () => { if (!glideRaf) glideRaf = requestAnimationFrame(glide); };
  function glide() {
    glideRaf = 0; let moving = false;
    for (const n of nodes) {
      const v = vis.get(n.id); if (!v) continue;
      for (const k of ['x', 'y', 'w', 'h']) { const d = n[k] - v[k]; if (Math.abs(d) < 0.5) v[k] = n[k]; else { v[k] += d * 0.35; moving = true; } }
      Object.assign(elOf(n.id).style, { left: `${v.x}px`, top: `${v.y}px`, width: `${v.w}px`, height: `${v.h}px` });
      elOf(n.id).classList.toggle('bar', n.h <= G);   // 1 grid cell tall: the title bar only
    }
    drawWires();
    if (moving) glideRaf = requestAnimationFrame(glide);
  }
  const toGrid = (cx, cy) => { const r = $('stage').getBoundingClientRect(); return { x: (cx - r.left - r.width / 2 - offX) / zoom, y: (cy - r.top - r.height / 2 - offY) / zoom }; };
  // Port centres (grid px): the middle of the left (in) / right (out) edge.
  const portAt = (n, k) => { const r = rectOf(n); return { x: r.x + (k === 'out' ? r.w : 0), y: r.y + r.h / 2 }; };
  const SNAP_R = 36;   // screen px: a wire end within this of a port snaps to it
  function drawLinks() {
    save();
    for (const n of nodes) {
      const el = elOf(n.id);
      el.querySelector('.port.in')?.classList.toggle('on', ins(n).length > 0);
      el.querySelector('.port.out')?.classList.toggle('on', links.some(l => l.from === n.id));
    }
    drawWires();
  }
  function drawWires() {
    wires.querySelectorAll('.wire:not(.live)').forEach(x => x.remove());
    for (const l of links) {
      const a = nodeOf(l.from), b = nodeOf(l.to); if (!a || !b) continue;
      const path = document.createElementNS(NS, 'path'); path.setAttribute('class', 'wire');
      path.setAttribute('d', curve(portAt(a, 'out'), portAt(b, 'in'))); wires.prepend(path);
    }
  }
  // Wires: square runs (out -> right, in <- from the left). Every bend is one grid cell (G) each way, so wires meeting the
  // same input bend at the same points and run into one another's straight parts. The turn is exactly half way between
  // the two nodes (on a grid line or in the middle of a cell: the gap decides). A step under two cells (no room for two
  // corners) is one S sweep over the same two cells. A target behind the output goes round: out a cell, across half
  // way, back in a cell before the input.
  const R = G, STUB = G;
  function curve(a, b) {
    let pts;
    if (b.x - a.x >= 2 * G) {
      const mx = (a.x + b.x) / 2, dy = Math.abs(b.y - a.y);   // the turn: exactly half way between the two nodes
      if (dy < 0.5) return `M${a.x},${a.y} L${b.x},${b.y}`;
      if (dy < 2 * R) return `M${a.x},${a.y} L${mx - G},${a.y} C${mx},${a.y} ${mx},${b.y} ${mx + G},${b.y} L${b.x},${b.y}`;
      pts = [a, { x: mx, y: a.y }, { x: mx, y: b.y }, b];
    }
    else { const my = (a.y + b.y) / 2; pts = [a, { x: a.x + STUB, y: a.y }, { x: a.x + STUB, y: my }, { x: b.x - STUB, y: my }, { x: b.x - STUB, y: b.y }, b]; }
    let d = `M${a.x},${a.y}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i - 1], c = pts[i], n = pts[i + 1];
      // one grid cell; a run shared by two bends gives each half, a run to a port is this bend's alone
      const r = Math.min(R, Math.hypot(c.x - p.x, c.y - p.y) / (i === 1 ? 1 : 2), Math.hypot(n.x - c.x, n.y - c.y) / (i === pts.length - 2 ? 1 : 2));
      if (r < 0.5) { d += ` L${c.x},${c.y}`; continue; }
      const u = (q, k) => { const l = Math.hypot(q.x - c.x, q.y - c.y) || 1; return { x: c.x + (q.x - c.x) / l * k, y: c.y + (q.y - c.y) / l * k }; };
      const s1 = u(p, r), s2 = u(n, r);
      const sweep = (c.x - p.x) * (n.y - c.y) - (c.y - p.y) * (n.x - c.x) > 0 ? 1 : 0;   // turning clockwise or not
      d += ` L${s1.x},${s1.y} A${r},${r} 0 0 ${sweep} ${s2.x},${s2.y}`;   // a true quarter circle
    }
    return d + ` L${b.x},${b.y}`;
  }
  // Delete a node: its wires go with it; the drawer closes if it showed this node.
  function deleteNode(n) {
    nodes = nodes.filter(m => m !== n); links = links.filter(l => l.from !== n.id && l.to !== n.id);
    elOf(n.id)?.remove(); vis.delete(n.id);
    if (drawer.id === n.id) hideSettings();
    drawLinks(); applyView();
  }
  // Delete asks first: the red X (its node), or the Del key (every selected node).
  async function askDelete(list) {
    if (!list.length) return;
    const k = list.length;
    if (!await UI.confirm(`Are you sure you want to delete ${k} node${k > 1 ? 's' : ''}?`, { danger: true, ok: 'Yes', cancel: 'No' })) return;
    list.forEach(deleteNode);
  }
  on(window, 'keydown', e => {
    if (e.key !== 'Delete' || e.target.closest?.('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]')) return;
    askDelete([...$('nodes').querySelectorAll('.node.sel')].map(el => nodeOf(el.dataset.id)).filter(Boolean));
  });
  // Ctrl + A: every node selected (never the page's text: only text boxes and SQL editors select their own text), and type
  // keys on: each type's first letter then toggles that type's nodes in / out of the selection (T Transform, I Input,
  // S SQL, F Function, J Join, A Append, C Chart, O Output) until a click on the canvas.
  const TYPE_KEYS = { t: 'transform', i: 'import', s: 'sql', f: 'function', j: 'join', a: 'append', c: 'chart', o: 'output' };
  let typeKeys = false;
  const typing = e => e.target.closest?.('input, textarea, select, [contenteditable]');
  on(window, 'keydown', e => {
    if (typing(e) || document.querySelector('dialog[open]')) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 't') e.preventDefault();   // not the browser's new tab (where it lets the page stop it)
    if ((e.ctrlKey || e.metaKey) && k === 'a') {
      e.preventDefault(); typeKeys = true;
      $('nodes').querySelectorAll('.node').forEach(el => el.classList.add('sel')); save();
      return;
    }
    const t = TYPE_KEYS[k];
    if (!typeKeys || !t || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    const els = [...$('nodes').querySelectorAll('.node')].filter(el => nodeOf(el.dataset.id)?.type === t);
    const on_ = !els.some(el => el.classList.contains('sel'));   // any of them selected: all out; none: all in
    els.forEach(el => el.classList.toggle('sel', on_)); save();
  });
  // Ctrl + C: the selected nodes (every setting) and the wires between them; Ctrl + V: a copy, laid out as they were,
  // centred on the mouse, selected and on top of anything under it (it may sit too close until moved).
  let clip = null, mouse = null;
  $('stage').addEventListener('pointermove', e => { mouse = { x: e.clientX, y: e.clientY }; });
  on(window, 'keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || typing(e) || document.querySelector('dialog[open]')) return;
    const k = e.key.toLowerCase();
    if (k === 'c') {
      const sel = [...$('nodes').querySelectorAll('.node.sel')].map(el => nodeOf(el.dataset.id)).filter(Boolean); if (!sel.length) return;
      e.preventDefault();
      const ids = new Set(sel.map(m => m.id));
      clip = JSON.parse(JSON.stringify({ nodes: sel, links: links.filter(l => ids.has(l.from) && ids.has(l.to)) }));
      UI.toast(`Copied ${sel.length} node${sel.length > 1 ? 's' : ''}`);
    } else if (k === 'v' && clip) {
      e.preventDefault();
      const L = Math.min(...clip.nodes.map(m => m.x)), T = Math.min(...clip.nodes.map(m => m.y));
      const R = Math.max(...clip.nodes.map(m => m.x + m.w)), B = Math.max(...clip.nodes.map(m => m.y + m.h));
      const r = $('stage').getBoundingClientRect(), at = toGrid(mouse?.x ?? r.left + r.width / 2, mouse?.y ?? r.top + r.height / 2);
      const dx = snap(at.x - (L + R) / 2), dy = snap(at.y - (T + B) / 2), stamp = Date.now().toString(36), map = new Map();
      $('nodes').querySelectorAll('.node.sel').forEach(x => x.classList.remove('sel'));
      clip.nodes.forEach((m, i) => {
        const c = JSON.parse(JSON.stringify(m)); c.id = `n${stamp}${i}`; c.x = m.x + dx; c.y = m.y + dy; map.set(m.id, c.id);
        nodes.push(c); drawNode(c); elOf(c.id).classList.add('sel');   // drawn last: on top
      });
      links.push(...clip.links.map(l => ({ from: map.get(l.from), to: map.get(l.to) })));
      drawLinks(); applyView();
    }
  });
  let lastDown = { id: null, t: 0, x: 0, y: 0 };   // the last press on a node (double-click)
  $('nodes').addEventListener('pointerdown', e => {
    const el = e.target.closest('.node'); if (!el || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const n = nodeOf(el.dataset.id), st = $('stage');
    // Double-click (2nd press on the same node within 400ms, barely moved): its Settings; the selection stays as it is.
    // Done here, not with 'dblclick': the pointer capture below sends the clicks to the stage.
    const now = performance.now(), dbl = lastDown.id === n.id && now - lastDown.t < 400 && Math.hypot(e.clientX - lastDown.x, e.clientY - lastDown.y) < 6;
    lastDown = dbl ? { id: null, t: 0, x: 0, y: 0 } : { id: n.id, t: now, x: e.clientX, y: e.clientY };
    if (dbl && !e.target.closest('.port, .rz')) { openSettings(n); return; }
    // Selection: Ctrl + click adds / removes a node; a plain click on an unselected node selects only it (on a selected
    // one it keeps the group, to drag it).
    if (e.ctrlKey || e.metaKey) el.classList.toggle('sel');
    else if (!el.classList.contains('sel')) $('nodes').querySelectorAll('.node.sel').forEach(x => x.classList.remove('sel'));
    if (!e.ctrlKey && !e.metaKey) el.classList.add('sel');
    if (drawer.on && el.classList.contains('sel') && drawer.id !== n.id) openSettings(n);   // the open drawer follows the selected node
    save();
    st.setPointerCapture(e.pointerId);
    if (e.target.closest('.nx')) { askDelete([n]); return; }   // the red X (shown on hover): this node, after asking
    const port = e.target.closest('.port'), rz = e.target.closest('.rz');
    let move, done;
    if (port) {   // drag a wire out of a port: it snaps to the nearest free opposite port within reach; let go there = linked
      let out = port.dataset.port === 'out', src = n, a;
      if (!out) {   // from a wired input: pick its last wire up (it keeps its output end); from a free one: start a new wire
        const old = ins(n).pop();
        if (old) { links = links.filter(l => l !== old); drawLinks(); src = nodeOf(old.from); out = true; a = portAt(src, 'out'); }
        else a = portAt(n, 'in');
      } else a = portAt(n, 'out');
      const want = out ? 'in' : 'out';
      const path = document.createElementNS(NS, 'path'); path.setAttribute('class', 'wire live'); wires.append(path);
      let hit = null;
      move = ev => {
        const m = toGrid(ev.clientX, ev.clientY);
        hit = null; let best = SNAP_R / zoom;
        for (const o of nodes) {
          if (o === src || (want === 'in' && !hasIn(o)) || (want === 'out' && !hasOut(o))) continue;
          const q = portAt(o, want), d = Math.hypot(q.x - m.x, q.y - m.y);
          if (d < best) { best = d; hit = { n: o, q }; }
        }
        document.querySelectorAll('.port.hot').forEach(x => x.classList.remove('hot'));
        if (hit) elOf(hit.n.id).querySelector(`.port.${want}`).classList.add('hot');
        const b = hit ? hit.q : m;
        path.setAttribute('d', out ? curve(a, b) : curve(b, a)); path.classList.toggle('live', !hit);
      };
      done = () => {
        path.remove(); document.querySelectorAll('.port.hot').forEach(x => x.classList.remove('hot'));
        if (!hit) return;
        const from = out ? src.id : hit.n.id, to = out ? hit.n.id : src.id;
        links = links.filter(l => !(l.from === from && l.to === to) && (multi(nodeOf(to)) || l.to !== to));   // one wire into a single input
        links.push({ from, to }); drawLinks();
      };
      move(e);
    } else if (rz) {   // resize from an edge or corner (snaps to the grid; never smaller than WMIN x HMIN); every other
      // selected node takes the same change to the same edges, live
      const d = rz.dataset.dir, p0 = toGrid(e.clientX, e.clientY);
      const group = (el.classList.contains('sel') ? [...$('nodes').querySelectorAll('.node.sel')] : [el])
        .map(g => { const m = nodeOf(g.dataset.id); return { g, m, x: m.x, y: m.y, r: m.x + m.w, b: m.y + m.h }; });
      const me = group.find(o => o.m === n), ids = new Set(group.map(o => o.m.id));
      const tight = group.some(o => hits({ x: o.x, y: o.y, w: o.r - o.x, h: o.b - o.y }, ids));   // pasted on top of others: no limit until moved
      group.forEach(o => o.g.classList.add('drag'));
      move = ev => {
        const p = toGrid(ev.clientX, ev.clientY), dx = p.x - p0.x, dy = p.y - p0.y;
        // the grabbed node's edges snap; that change (in grid px) goes to all
        const ch = { l: 0, r: 0, t: 0, b: 0 };
        if (d.includes('w')) ch.l = Math.min(snap(me.x + dx), me.r - WMIN) - me.x;
        if (d.includes('e')) ch.r = Math.max(snap(me.r + dx), me.x + WMIN) - me.r;
        if (d.includes('n')) ch.t = Math.min(snap(me.y + dy), me.b - HMIN) - me.y;
        if (d.includes('s')) ch.b = Math.max(snap(me.b + dy), me.y + HMIN) - me.b;
        const next = group.map(o => {
          const x = Math.min(o.x + ch.l, o.r - WMIN), r = Math.max(o.r + ch.r, o.x + WMIN);
          const y = Math.min(o.y + ch.t, o.b - HMIN), b = Math.max(o.b + ch.b, o.y + HMIN);
          return { x, y, w: r - x, h: b - y };
        });
        if (!tight && next.some(r => hits(r, ids))) return;   // it would run into another node: stays at the last size that fit
        group.forEach((o, i) => { Object.assign(o.m, next[i]); putNode(o.g, o.m); });
        drawLinks();
      };
      done = () => group.forEach(o => o.g.classList.remove('drag'));
    } else {   // move the node, or the whole selection with it (snaps to the grid with Snap to Grid on); wires follow
      if (!el.classList.contains('sel')) return;   // Ctrl + click just took it out of the selection
      const p0 = toGrid(e.clientX, e.clientY), x0 = n.x, y0 = n.y;
      const group = [...$('nodes').querySelectorAll('.node.sel')].map(g => ({ g, m: nodeOf(g.dataset.id) })).map(o => ({ ...o, x: o.m.x, y: o.m.y }));
      const ids = new Set(group.map(o => o.m.id));
      let lx = 0, ly = 0;   // the last move that fit
      let free = group.some(o => hits({ x: o.x, y: o.y, w: o.m.w, h: o.m.h }, ids));
      group.forEach(o => o.g.classList.add('drag'));
      document.body.classList.add('nocursor');   // moving nodes: no pointer over them
      move = ev => {
        const p = toGrid(ev.clientX, ev.clientY), dx = snap(x0 + p.x - p0.x) - x0, dy = snap(y0 + p.y - p0.y) - y0;   // the grabbed node snaps; the rest keep their places to it
        const fits = (ax, ay) => !group.some(o => hits({ x: o.x + ax, y: o.y + ay, w: o.m.w, h: o.m.h }, ids));
        // never onto another node: as far towards the mouse as it fits (a grid cell at a time from where it last fit), else
        // slid along the node in the way (one axis)
        // nodes that start too close (pasted on top of others) move freely until they first reach a place that fits;
        // from then on the 2-cell rule holds
        if (free) { if (fits(dx, dy)) free = false; [lx, ly] = [dx, dy]; group.forEach(o => { o.m.x = o.x + lx; o.m.y = o.y + ly; putNode(o.g, o.m); }); return drawLinks(); }
        let to = fits(dx, dy) ? [dx, dy] : null;
        if (!to) {
          const n = Math.ceil(Math.max(Math.abs(dx - lx), Math.abs(dy - ly)) / G);
          for (let k = 1; k <= n; k++) {
            const ax = snap(lx + (dx - lx) * k / n), ay = snap(ly + (dy - ly) * k / n);
            if (fits(ax, ay)) to = [ax, ay]; else break;
          }
          to ||= [[dx, ly], [lx, dy]].find(([ax, ay]) => fits(ax, ay));
          if (!to) return;
        }
        [lx, ly] = to;
        group.forEach(o => { o.m.x = o.x + lx; o.m.y = o.y + ly; putNode(o.g, o.m); });
        drawLinks();
      };
      done = () => {
        document.body.classList.remove('nocursor');
        group.forEach(o => o.g.classList.remove('drag'));
      };
    }
    const up = () => { done(); st.removeEventListener('pointermove', move); st.removeEventListener('pointerup', up); st.removeEventListener('pointercancel', up); };
    st.addEventListener('pointermove', move); st.addEventListener('pointerup', up); st.addEventListener('pointercancel', up);
  });
  // A click on the empty grid (not a drag: dragging scrolls and keeps the selection) clears the selection and hides the drawer.
  let gridDown = null;
  $('stage').addEventListener('pointerdown', e => { gridDown = e.button === 0 && onGrid(e.target) ? { x: e.clientX, y: e.clientY } : null; });
  $('stage').addEventListener('pointerup', e => {
    if (!gridDown || Math.hypot(e.clientX - gridDown.x, e.clientY - gridDown.y) > 4) return;
    gridDown = null; typeKeys = false;   // a click on the canvas ends Ctrl + A's type keys
    if (drawer.id) hideSettings();
    if ($('nodes').querySelector('.node.sel')) { $('nodes').querySelectorAll('.node.sel').forEach(x => x.classList.remove('sel')); save(); }
  });

  // Shift + drag (anywhere on the grid, over nodes too): a selection box; a node with at least 50% of it inside is
  // selected, live. Ctrl as well keeps the nodes already selected.
  $('stage').addEventListener('pointerdown', e => {
    if (e.button !== 0 || !e.shiftKey || !(onGrid(e.target) || e.target.closest('.node'))) return;
    e.preventDefault(); e.stopPropagation();
    const st = $('stage'), r0 = st.getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY;
    const keep = e.ctrlKey || e.metaKey ? new Set([...$('nodes').querySelectorAll('.node.sel')]) : new Set();
    const box = document.createElement('div'); box.className = 'selbox'; st.append(box);
    st.setPointerCapture(e.pointerId);
    const move = ev => {
      const L = Math.min(x0, ev.clientX), T = Math.min(y0, ev.clientY), Rr = Math.max(x0, ev.clientX), B = Math.max(y0, ev.clientY);
      Object.assign(box.style, { left: `${L - r0.left}px`, top: `${T - r0.top}px`, width: `${Rr - L}px`, height: `${B - T}px` });
      for (const el of $('nodes').querySelectorAll('.node')) {
        const b = el.getBoundingClientRect();
        const ix = Math.max(0, Math.min(Rr, b.right) - Math.max(L, b.left)), iy = Math.max(0, Math.min(B, b.bottom) - Math.max(T, b.top));
        el.classList.toggle('sel', keep.has(el) || ix * iy >= 0.5 * b.width * b.height);
      }
    };
    const up = () => { box.remove(); save(); st.removeEventListener('pointermove', move); st.removeEventListener('pointerup', up); st.removeEventListener('pointercancel', up); };
    st.addEventListener('pointermove', move); st.addEventListener('pointerup', up); st.addEventListener('pointercancel', up);
    move(e);
  }, true);

  // Double-click a node (in the node pointerdown above): its Settings in the drawer. Once open it follows the selected
  // node; a click on the grid hides it until a node is selected again; X closes it until the next double-click.


  // ---- Data Preview (Settings > Data Preview): a drawer up from the bottom, tabs Input / Output (the data table
  // comes later). Its top snaps to the grid and glides like a node; the Settings drawer and the view buttons sit on it. ----
  function showPreview(on) { $('preview').hidden = false; glidePreview(on && !pvWin && ctx && pvNode() ? preview.h : 0); if (on) showDataSoon(); }
  // Pop-out (the grid's Pop-out button): the whole Data Preview, tabs and table, moves to its own window and the drawer
  // closes; closing that window puts it back in the drawer.
  // The wheel over a preview table (drawer or pop-out): Shift = left / right, Ctrl = 4x as fast (not the browser's zoom).
  function tableWheel(e) {
    const t = e.target.closest?.('.dg'); if (!t || (!e.shiftKey && !e.ctrlKey)) return;
    e.preventDefault();
    const d = (e.deltaY || e.deltaX) * (e.ctrlKey ? 4 : 1);
    if (e.shiftKey) t.scrollLeft += d; else t.scrollTop += d;
  }
  pvBody.addEventListener('wheel', tableWheel, { passive: false });
  function popPreview() {
    if (pvWin && !pvWin.closed) return pvWin.focus();
    // its own page (ui/html/data-preview.html: the app's styles); the tabs and table move in once it has loaded
    const w = window.open('/ui/html/data-preview.html', `dn-preview-${ctx?.folder || ''}`, `popup=yes,width=${Math.round(screen.availWidth * .7)},height=${Math.round(screen.availHeight * .6)}`);
    if (!w) return UI.toast('The pop-out window was blocked.', 'err');
    pvWin = w;
    w.addEventListener('load', () => moveIn(w), { once: true });
    watchClosed(w);
  }
  const watchClosed = w => { const t = setInterval(() => { if (w.closed) { clearInterval(t); moveBack(); } }, 500); };   // closed (even before it loaded)
  // F5 in the pop-out: its page loads again and asks for the preview back (ui/html/data-preview.html)
  window.DSPreview = { reattach(w) { if (pvWin && pvWin !== w) return; pvWin = w; moveIn(w); watchClosed(w); } };
  function moveIn(w) {
    if (pvTabs.ownerDocument === w.document) return;   // already there (its load and its own reattach both ask)
    w.document.title = `Data Preview · ${ctx?.cfg?.name || ''}`;
    w.document.querySelector('.preview').append(w.document.adoptNode(pvTabs), w.document.adoptNode(pvBody));
    glidePreview(0);
    if (pvShown) showGrid(pvBody, pvShown.sql, pvShown.columns, pvShown.title);
    // In the pop-out: a table's scroll bars show only with the mouse within 10px of them (the wheel: tableWheel, which
    // moved here with the table).
    w.document.addEventListener('mousemove', e => {
      for (const t of w.document.querySelectorAll('.pv-grid .dg')) {
        const r = t.getBoundingClientRect(), inX = e.clientX >= r.left && e.clientX <= r.right, inY = e.clientY >= r.top && e.clientY <= r.bottom;
        t.classList.toggle('sb-on', (inY && Math.abs(e.clientX - r.right) <= 10 + (t.offsetWidth - t.clientWidth)) || (inX && Math.abs(e.clientY - r.bottom) <= 10 + (t.offsetHeight - t.clientHeight)));
      }
    });
    w.addEventListener('pagehide', moveBack);
  }
  // the pop-out closed: the tabs and table go back in the drawer
  function moveBack() {
    if (!pvWin) return;
    pvWin = null;
    if (pvTabs.ownerDocument !== document) $('preview').append(document.adoptNode(pvTabs), document.adoptNode(pvBody));
    if (pvShown) showGrid(pvBody, pvShown.sql, pvShown.columns, pvShown.title);
    if (prefs.preview) showDataSoon();   // the drawer comes back only with a node to show
  }
  on(window, 'pagehide', () => pvWin?.close());
  function glidePreview(to) {
    cancelAnimationFrame(pvRaf);
    const step = () => {
      const d = to - pvH; pvH = Math.abs(d) < 0.5 ? to : pvH + d * 0.35;
      $('preview').style.height = `${pvH}px`; $('preview').hidden = !pvH;
      document.querySelector('.dst').style.setProperty('--pvh', `${pvH}px`);
      pvRaf = pvH === to ? 0 : requestAnimationFrame(step);
    };
    pvRaf = requestAnimationFrame(step);
  }
  pvTabs.onclick = e => {
    const t = e.target.closest('[data-tab]'); if (!t) return;
    preview.tab = t.dataset.tab; drawTabs(); save(); showData();
  };
  // ---- Preview data: the node in the Settings drawer, else the selected one. Output = what the node gives on (an input
  // node: its files with the schema choices applied); Input = what comes in (the output of the node wired to it). Rows
  // come 100 at a time as the table scrolls (DataTable, as in Import). ----
  // A node's output as SQL (null = nothing yet). Input nodes: every file, the same fields, one after another.
  async function outSql(n, seen = new Set()) {
    if (!n || seen.has(n.id)) return null;
    seen.add(n.id);
    if (n.type === 'import') {
      const src = n.src; if (!src?.files?.length || !src.cols?.length) return null;
      const list = ImportCore.selectList(src.cols);
      const parts = await Promise.all(src.files.map(async f => `SELECT ${list} FROM ${await Engine.src(f.path || f.origin)}`));
      return parts.join(' UNION ALL ');
    }
    const up = ins(n)[0];   // other nodes, for now: what comes in goes out
    return up ? outSql(nodeOf(up.from), seen) : null;
  }
  const inSql = async n => { const up = n && ins(n)[0]; return up ? outSql(nodeOf(up.from)) : null; };
  const pvNode = () => nodeOf(drawer.id) || nodeOf($('nodes').querySelector('.node.sel')?.dataset.id);
  let pvSeq = 0, pvKey = '';
  async function showData() {
    if (!prefs.preview || !ctx) return;
    const seq = ++pvSeq, n = pvNode(), box = pvBody;
    const note = t => { box.innerHTML = `<div class="pv-note">${UI.esc(t)}</div>`; };
    // an input node has no Input tab: its Output shows (the tab chosen stays for the other nodes)
    const noIn = n?.type === 'import', tab = noIn ? 'output' : preview.tab;
    pvTabs.querySelector('[data-tab="input"]').hidden = noIn; drawTabs(tab);
    // no node: the drawer goes (a popped-out preview stays and says so); a node: it comes back
    if (!pvWin) glidePreview(n ? preview.h : 0);
    if (!n) return note('Select a node to see its data.');
    try {
      const sql = tab === 'input' ? await inSql(n) : await outSql(n);
      if (seq !== pvSeq) return;
      const key = `${n.id}|${tab}|${sql}`;
      if (key === pvKey && box.querySelector('.pv-grid')) return;   // the same data already shown (a move, a zoom...): keep it
      pvKey = key;
      if (!sql) return note(tab === 'input' ? `Nothing is wired into ${n.title}.` : `${n.title} has no data yet${n.type === 'import' ? ': import a file in its Settings.' : '.'}`);
      note('Reading…');
      const [columns] = await Promise.all([Engine.describe(`SELECT * FROM (${sql})`), gridCss()]);
      if (seq !== pvSeq) return;
      showGrid(box, sql, columns, n.title);
    } catch (e) { pvKey = ''; if (seq === pvSeq) note(`Cannot read ${n.title}: ${String(e.message).split('\n')[0]}`); }
  }
  // The table: the app's Data Grid (ui/js/grid/, as in the Dashboard's table view: search, sort, column menu with
  // filters, autosize, export; no resizing) on the engine (GridRemote: 100 rows at a time, filters and sort in SQL).
  let gridText = null;
  const gridCss = async () => gridText ??= (await (await fetch('/ui/js/grid/data-grid.css')).text()).replace(/\.GRID\b/g, '.pv-grid')
    + '.pv-grid{flex:1;min-height:0;display:flex;flex-direction:column;--dg-row-h:24px}.pv-grid>.dn-grid-box{flex:1;min-height:0}'
    + '.pv-grid .dg-t td.num,.pv-grid .dg-t th.num{text-align:left}'
    + '.pv-grid .dg-t tbody td{font-family:var(--mono);font-size:12px}'   // the data in Syne Mono, a size down; headers, bar and menus stay Exo 2
    // header: grey, as tall as a row; its column button (on hover) bigger
    + '.pv-grid .dg-t thead th{height:var(--dg-row-h);background:var(--sel)}.pv-grid .dg-t thead th:hover{background:color-mix(in srgb,var(--sel) 85%,#fff)}'
    + '.pv-grid .dg-t thead th .fb svg{width:15px;height:15px}'
    + '.pv-grid .gbar .gpop{height:24px;box-sizing:border-box}'   // Pop-Out, rows and header: 1 grid cell (24px) tall
    // the column button: no box behind it on hover; it stays shown while its column's menu is open; the menu 3px lower
    + '.pv-grid .dg-t thead th .fb:hover{background:none}.pv-grid .dg-t thead th.menu-open .fb{opacity:1;color:var(--text)}.pv-grid .gctx{margin-top:3px}'
    // sorted: a plain triangle (up / down) a little right of the name, the size of the column button; none when not sorted
    + '.pv-grid .dg-t thead th.sorted-asc .ht::after,.pv-grid .dg-t thead th.sorted-desc .ht::after{content:"";display:inline-block;margin-left:8px;vertical-align:-1px;'
    + 'width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent}'
    + '.pv-grid .dg-t thead th.sorted-asc .ht::after{border-bottom:10px solid var(--muted)}.pv-grid .dg-t thead th.sorted-desc .ht::after{border-top:10px solid var(--muted)}'
    // column separators: a line between columns, header and rows
    + '.pv-grid .dg-t td+td,.pv-grid .dg-t th+th{border-left:1px solid var(--border)}'
    // hover: the row (striped ones too), the field under the mouse in the app's blue at 50%; the picked field outlined
    + '.pv-grid .dg-t tbody tr:hover td,.pv-grid .dg-t tbody tr:nth-child(even):hover td{background:color-mix(in srgb,var(--sel) 88%,#fff)}'
    + '.pv-grid .dg-t tbody tr:nth-child(n):hover td:hover{background:color-mix(in srgb,var(--blue) 50%,transparent)}'   // beats the striped rows' hover
    + '.pv-grid .dg-t tbody td.cell-sel{box-shadow:inset 0 0 0 1px var(--blue)}'   // previews: rows a little shorter, every value left aligned
  const gridStyle = doc => { if (gridText && !doc.getElementById('pv-grid-style')) doc.head.append(Object.assign(doc.createElement('style'), { id: 'pv-grid-style', textContent: gridText })); };
  let pvGrid = null, pvShown = null;   // the grid; what it shows (to draw it again in the pop-out / drawer)
  function showGrid(box, sql, columns, title) {
    try { pvGrid?.destroy(); } catch {}
    gridStyle(box.ownerDocument);
    // .pv-grid > the grid's own box (as the Dashboard's .dn-table > box): the grid's styles hang off that pair
    const doc = box.ownerDocument, wrap = doc.createElement('div'), host = doc.createElement('div');
    wrap.className = 'pv-grid'; wrap.append(host); box.replaceChildren(wrap);
    const names = columns.map(c => c.name);
    pvShown = { sql, columns, title };
    pvGrid = DNGrid.create(host, {
      names, columns, rows: [],
      remote: g => GridRemote.attach(g, { dataset: 'PREVIEW', views: () => ({ PREVIEW: sql }), cols: names, columns, page: 100, more: 100 }),
      props: { showQuickFilter: true, showExport: false, exportFilename: title.replace(/[^\w-]+/g, '_'),
        onRowClick: (row, col) => { picked = { row, col }; } },
      columnDefaults: { sort: true, filter: true, resizable: false },   // no column resizing here
      popped: !!pvWin, onPop: () => popPreview(),
    });
    // A field: click = picked (outlined); right-click = picked + a menu: Filter to Value (that column = that value).
    let picked = null;
    const tbody = wrap.querySelector('tbody');
    tbody.addEventListener('click', e => {
      const td = e.target.closest('td'); if (!td) return;
      tbody.querySelectorAll('td.cell-sel').forEach(x => x.classList.remove('cell-sel')); td.classList.add('cell-sel');
    });
    tbody.addEventListener('contextmenu', e => {
      const td = e.target.closest('tr[data-i] td'); if (!td) return;
      e.preventDefault(); td.click();   // the grid picks the row and field (onRowClick)
      if (!picked?.col) return;
      const { row, col } = picked, v = row[col], d = doc.defaultView;
      doc.querySelector('.pv-cellmenu')?.remove();
      const m = doc.createElement('div'); m.className = 'dd-menu open pv-cellmenu';
      m.innerHTML = '<div data-act="filter">Filter to Value</div>';
      doc.body.append(m);
      m.style.left = `${Math.min(e.clientX, d.innerWidth - m.offsetWidth - 4)}px`; m.style.top = `${Math.min(e.clientY, d.innerHeight - m.offsetHeight - 4)}px`;
      const off = ev => { if (!m.contains(ev.target)) { m.remove(); doc.removeEventListener('pointerdown', off, true); } };
      doc.addEventListener('pointerdown', off, true);
      m.onclick = () => {
        m.remove(); doc.removeEventListener('pointerdown', off, true);
        pvGrid.state.filters.set(col, v == null || v === '' ? { condition: 'empty' } : { condition: 'equals', searchTerm: String(v) });
        pvGrid.refresh();
      };
    });
    // which column's menu is open (the grid does not say): the header last clicked / right-clicked, while its menu shows
    const gm = wrap.querySelector('.gctx');
    let th = null;
    wrap.addEventListener('pointerdown', e => { const h = e.target.closest('thead th'); if (h) th = h; }, true);
    if (gm) new MutationObserver(() => {
      wrap.querySelectorAll('thead th.menu-open').forEach(x => x.classList.remove('menu-open'));
      if (!gm.hidden && th) th.classList.add('menu-open');
    }).observe(gm, { attributes: true, attributeFilter: ['hidden'] });
  }
  function showDataSoon() { clearTimeout(pvT); pvT = setTimeout(showData, 200); }
  const drawTabs = (tab = preview.tab) => pvTabs.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  $('preview').addEventListener('pointerdown', e => e.stopPropagation());
  $('preview').addEventListener('wheel', e => e.stopPropagation());
  $('pvGrip').addEventListener('pointerdown', e => {   // resize from the top edge
    if (e.button !== 0) return;
    e.preventDefault();
    const g = e.currentTarget, y0 = e.clientY, h0 = preview.h;
    g.setPointerCapture(e.pointerId);
    const move = ev => {
      const st = $('stage'), H = st.clientHeight, gs = G * zoom, oy = H / 2 + offY;
      let top = H - Math.max(96, Math.min(H - 120, h0 + y0 - ev.clientY));
      if (prefs.snap) top = oy + Math.round((top - oy) / gs) * gs;
      preview.h = Math.round(Math.max(96, Math.min(H - 120, H - top))); glidePreview(preview.h);
    };
    const up = () => { g.removeEventListener('pointermove', move); g.removeEventListener('pointerup', up); save(); };
    g.addEventListener('pointermove', move); g.addEventListener('pointerup', up);
  });
  drawTabs();

  // ---- State: <project>/data-studio/studio.json = { version, view: { zoom, offX, offY }, nodes, links, sel }, written as it
  // changes (every move, wire, resize, zoom, scroll, selection), so the window reopens exactly as it was left. ----
  const FILE = () => `${ctx.dir}/data-studio/studio.json`;
  const state = () => ({ version: 1, view: { zoom, offX, offY }, drawer, preview, nodes, links, sel: [...$('nodes').querySelectorAll('.node.sel')].map(x => x.dataset.id), updated: new Date().toISOString() });
  function save() {
    showDataSoon();   // anything that is saved may change what the preview shows
    if (!ctx) return;
    dirty = true; clearTimeout(saveT);
    saveT = setTimeout(flush, 150);
  }
  function flush() {
    if (!dirty || !ctx) return;
    dirty = false; clearTimeout(saveT);
    return DNFS.writeJSON(FILE(), state()).catch(e => UI.toast(`Data Studio not saved: ${e.message}`, 'err'));
  }
  on(window, 'pagehide', flush);
  on(document, 'visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });

  // A start-up failure stays on screen (not only a notification that fades), so it can be read and fixed.
  const fail = e => { console.error(e); $('stage').insertAdjacentHTML('beforeend', `<div class="ds-fail">Data Studio could not start: ${UI.esc(e?.message || e)}</div>`); };
  on(window, 'error', e => fail(e.error || e.message));
  on(window, 'unhandledrejection', e => fail(e.reason));
  try { ctx = await ModulePage.init('data_studio', 'Data Studio'); }
  catch (e) { return fail(e); }
  const saved = await DNFS.readJSONOr(FILE(), null).catch(() => null);
  if (saved?.nodes) {
    nodes = saved.nodes; links = (saved.links || []).filter(l => { const t = nodes.find(m => m.id === l.to); return t && hasIn(t); });   // no wires into input nodes
    nodes.forEach(n => { n.w ??= W0; n.h ??= H0; });
    ({ zoom = 1, offX = 0, offY = 0 } = saved.view || {});
  }
  nodes.forEach(drawNode); drawLinks();
  [].concat(saved?.sel || []).forEach(id => elOf(id)?.classList.add('sel'));
  if (saved?.preview) { preview = { ...preview, ...saved.preview }; drawTabs(); if (prefs.preview) showDataSoon(); }
  if (saved?.drawer) { drawer = { ...drawer, ...saved.drawer }; const n = nodeOf(drawer.id); if (drawer.id === STUDIO) openStudioSettings(); else if (n) openSettings(n); else drawer.id = null; }
  applyView();
  $('types').onclick = e => {
    const t = e.target.closest('.type'); if (!t) return;
    const act = t.dataset.act;
    // a dimmed button: the one in use closes first, then this one opens
    if (act !== 'nodes') closeNodeMenu();
    if (act !== 'settings' && drawer.id === STUDIO) closeSettings();
    if (act === 'settings') drawer.id === STUDIO ? closeSettings() : openStudioSettings();
    else if (act === 'nodes') document.getElementById('nodeMenu') ? closeNodeMenu() : openNodeMenu(t);
  };
})();
