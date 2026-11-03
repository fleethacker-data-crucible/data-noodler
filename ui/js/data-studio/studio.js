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
  const ICON_PUBLISH = `<path d="M4 12v7h16v-7M12 3v12M8 7l4-4 4 4" ${SW}/><circle cx="12" cy="3" r="0" ${SW}/>`;
  const ICON_ARCHIVE = `<rect x="3" y="4" width="18" height="4" rx="1" ${SW}/><path d="M5 8v11h14V8M10 12h4" ${SW}/>`;
  const ICON_PIPE = `<circle cx="5" cy="6" r="2.5" ${SW}/><circle cx="19" cy="6" r="2.5" ${SW}/><circle cx="12" cy="18" r="2.5" ${SW}/><path d="M7.5 6h9M6.5 8l4 8M17.5 8l-4 8" ${SW}/>`;
  const ICONS = { import: ICON_IMPORT, transform: ICON_TRANSFORM, sql: ICON_SQL, function: ICON_FUNCTION, join: ICON_JOIN, append: ICON_APPEND, chart: ICON_CHART, output: ICON_OUTPUT, publish: ICON_PUBLISH, archive: ICON_ARCHIVE };
  // The Nodes menu (top bar Nodes), in this order: [type, name]
  const NODE_TYPES = [['import', 'Input'], ['transform', 'Transform'], ['sql', 'SQL'], ['function', 'Function'], ['join', 'Join'], ['append', 'Append'], ['chart', 'Chart'], ['output', 'Output'], ['publish', 'Publish'], ['archive', 'Archive']];
  let nodes = [];   // the open pipeline's nodes (DSPipeline: <project>/pipelines/<name>.pipeline)
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
  const hasOut = n => !['output', 'publish', 'archive'].includes(n.type);   // output, publish and archive nodes: an input only
  const ins = n => links.filter(l => l.to === n.id);
  const wires = document.createElementNS(NS, 'svg'); wires.id = 'wires'; $('nodes').append(wires);
  const DIRS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
  function drawNode(n) {
    const el = document.createElement('div');
    el.className = `node t-${n.type}`; el.dataset.id = n.id;
    el.innerHTML = `<div class="nh"><svg viewBox="0 0 24 24">${ICONS[n.type]}</svg><i class="nst"></i><b>${UI.esc(n.title)}</b><button type="button" class="nx" title="Delete this node">×</button></div><div class="nb">${UI.esc(n.sub)}</div>`
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
      const n = { id: DSPipeline.uuid(), type, title: name, sub: '', ...place(ev) };
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
  // ---- Node window (double-click a node): looks like the node (title, selected border; no ports, no wires), on top of
  // everything, 28 x 28 grid cells (screen px), centred in the window; drag by the title, resize from any edge / corner.
  // The grid and nodes fade, blurred, behind it. X or Esc closes it. ----
  function openNodeWin(n) {
    closeNodeWin();
    const bd = document.createElement('div'); bd.className = 'nwin-bd'; bd.id = 'nodeWinBd';
    const w = document.createElement('div'); w.className = `node sel nwin t-${n.type}`; w.id = 'nodeWin';
    w.innerHTML = `<div class="nh"><svg viewBox="0 0 24 24">${ICONS[n.type]}</svg><b>Settings - ${UI.esc(n.title)}</b><button type="button" class="nx" title="Close">×</button></div>`
      + `<div class="drawer nwin-in t-${n.type}"><div class="dr-b"></div></div>` + DIRS.map(d => `<span class="rz ${d}" data-dir="${d}"></span>`).join('');
    document.body.append(bd, w);
    const S = 28 * G, vw = innerWidth, vh = innerHeight;
    let r = { w: Math.min(S, vw - 16), h: Math.min(S, vh - 16) }; r.x = (vw - r.w) / 2; r.y = (vh - r.h) / 2;
    const put = () => Object.assign(w.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    put();
    const box = w.querySelector('.dr-b');
    if (n.type === 'import') inputSettings(n, box);   // input nodes: no Name box (the Table Name is at the top)
    else {
      box.innerHTML = `<div class="optrow"><span>Name</span><input type="text" data-k="title" value="${UI.esc(n.title)}" spellcheck="false"></div>`;
      box.querySelector('[data-k="title"]').oninput = e => {
        n.title = e.target.value; elOf(n.id).querySelector('.nh b').textContent = n.title; w.querySelector('.nh b').textContent = `Settings - ${n.title}`; save();
      };
      typeSettings(n, box);
    }
    requestAnimationFrame(() => requestAnimationFrame(() => { bd.classList.add('in'); w.classList.add('in'); }));
    w.addEventListener('wheel', e => e.stopPropagation());
    w.addEventListener('pointerdown', e => {
      e.stopPropagation();
      if (e.button !== 0) return;
      if (e.target.closest('.nx')) return closeNodeWin();
      const rz = e.target.closest('.rz'), head = !rz && e.target.closest('.nh');
      if (!rz && !head) return;
      e.preventDefault(); w.setPointerCapture(e.pointerId);
      const x0 = e.clientX, y0 = e.clientY, s = { ...r }, d = rz?.dataset.dir || '', MIN = 8 * G;
      const move = ev => {
        const dx = ev.clientX - x0, dy = ev.clientY - y0;
        if (head) { r.x = s.x + dx; r.y = s.y + dy; }
        else {
          if (d.includes('e')) r.w = Math.max(MIN, s.w + dx);
          if (d.includes('s')) r.h = Math.max(MIN, s.h + dy);
          if (d.includes('w')) { r.w = Math.max(MIN, s.w - dx); r.x = s.x + s.w - r.w; }
          if (d.includes('n')) { r.h = Math.max(MIN, s.h - dy); r.y = s.y + s.h - r.h; }
        }
        put();
      };
      const up = () => { w.removeEventListener('pointermove', move); w.removeEventListener('pointerup', up); w.removeEventListener('pointercancel', up); };
      w.addEventListener('pointermove', move); w.addEventListener('pointerup', up); w.addEventListener('pointercancel', up);
    });
  }
  function closeNodeWin() {
    for (const id of ['nodeWin', 'nodeWinBd']) {
      const el = document.getElementById(id); if (!el) continue;
      el.removeAttribute('id'); el.classList.remove('in'); el.style.pointerEvents = 'none'; setTimeout(() => el.remove(), 200);
    }
  }
  on(window, 'keydown', e => { if (e.key === 'Escape') closeNodeWin(); });

  // ---- Settings of the other node types (under the Name box). Every change saves the pipeline, which re-runs the
  // node on the first 1000 rows (and what is downstream of it). The fields offered are its inputs' (their last run). ----
  const insOf = n => (pipe ? DSPipeline.inputs(pipe, n) : []);
  async function fieldsOf(m) {
    try { return (await Engine.describe(`SELECT * FROM read_dataset(${Engine.lit(DSPipeline.outDir(ctx, pipe, m, 'preview'))})`)).map(c => c.name); }
    catch { return []; }
  }
  const opt = (v, cur, label = v) => `<option value="${UI.esc(v)}" ${v === cur ? 'selected' : ''}>${UI.esc(label)}</option>`;
  function typeSettings(n, box) {
    const s = n.cfg ||= {}, esc = UI.esc, ins = insOf(n);
    const add = html => box.insertAdjacentHTML('beforeend', html);
    const inputsNote = () => ins.length ? ins.map((m, i) => `<code>INPUT${i + 1}</code> = ${esc(m.title)} (<code>${esc(DSPipeline.viewName(m))}</code>)`).join(', ') : 'Nothing is wired into this node yet.';
    const changed = () => save();
    if (n.type === 'transform' || n.type === 'sql') {
      // Oracle SQL, as in Transform: a query on the inputs (INPUT = the first one). Its result is the node's output.
      s.sql ??= 'SELECT *\nFROM INPUT';
      add(`<div class="tm-sep"></div><div class="dr-sec">SQL</div><div class="dr-full"><div class="in-hint">Inputs: ${inputsNote()}</div><div class="ns-sql"></div></div>`);
      const ed = SqlEditor.mount(box.querySelector('.ns-sql'), {
        onChange: t => { s.sql = t; changed(); },
        words: () => ({ tables: ['INPUT', ...ins.flatMap((m, i) => [`INPUT${i + 1}`, DSPipeline.viewName(m)])], columns: [], fields: {} }),
        check: t => Engine.check(t, DSPipeline.viewsOf(ctx, pipe, n, 'preview')).catch(() => []),
      });
      ed.value = s.sql;
    } else if (n.type === 'function') {
      // New fields from expressions (Oracle SQL on the input's fields): NAME = expression. Add / Delete rows.
      s.cols ??= [];
      add(`<div class="tm-sep"></div><div class="dr-sec">CALCULATED FIELDS</div><div class="dr-full"><div class="in-hint">Each row adds a field to the input's. Expressions are Oracle SQL on its fields, e.g. <code>PRICE * QTY</code>.</div><div class="ns-rows"></div><div class="in-row"><button type="button" data-f="add">Add</button></div></div>`);
      const draw = () => {
        box.querySelector('.ns-rows').innerHTML = s.cols.map((c, i) => `<div class="in-row ns-fn" data-i="${i}"><input type="text" data-f="name" value="${esc(c.name || '')}" placeholder="FIELD_NAME" spellcheck="false"><input type="text" data-f="expr" value="${esc(c.expr || '')}" placeholder="Expression" spellcheck="false"><button type="button" class="ghost" data-f="del">Delete</button></div>`).join('');
      };
      draw();
      box.addEventListener('click', e => {
        const b = e.target.closest('[data-f]')?.dataset.f;
        if (b === 'add') { s.cols.push({ name: '', expr: '' }); draw(); }
        else if (b === 'del') { s.cols.splice(+e.target.closest('.ns-fn').dataset.i, 1); draw(); changed(); }
      });
      box.addEventListener('input', e => {
        const row = e.target.closest('.ns-fn'); if (!row) return;
        const k = e.target.dataset.f, c = s.cols[+row.dataset.i];
        if (k === 'name') { const el = e.target, p = el.selectionStart; el.value = el.value.toUpperCase().replace(/\s/g, '_'); el.setSelectionRange(p, p); }
        c[k] = e.target.value; changed();
      });
    } else if (n.type === 'join') {
      // The first input is the left side, the second the right; join type and the field pairs to match.
      s.type ??= 'INNER'; s.keys ??= [{ l: '', r: '' }];
      add(`<div class="tm-sep"></div><div class="dr-sec">JOIN</div><div class="dr-full"><div class="in-hint">Left: ${esc(ins[0]?.title || '(wire a node in)')} · Right: ${esc(ins[1]?.title || '(wire a second node in)')}</div></div>
        <div class="optrow"><span>Join Type</span><select data-j="type">${[['INNER', 'inner'], ['LEFT', 'left'], ['RIGHT', 'right'], ['FULL', 'full outer'], ['CROSS', 'cross']].map(([v, t]) => opt(v, s.type, t)).join('')}</select></div>
        <div class="tm-sep"></div><div class="dr-sec">MATCH FIELDS</div><div class="dr-full"><div class="ns-keys"></div><div class="in-row"><button type="button" data-j="add">Add</button></div></div>`);
      let lf = [], rf = [];
      const draw = () => {
        box.querySelector('.ns-keys').innerHTML = s.keys.map((k, i) => `<div class="in-row ns-key" data-i="${i}"><select data-j="l"><option value=""></option>${lf.map(f => opt(f, k.l)).join('')}</select><span>=</span><select data-j="r"><option value=""></option>${rf.map(f => opt(f, k.r)).join('')}</select><button type="button" class="ghost" data-j="del">Delete</button></div>`).join('');
      };
      draw();
      Promise.all([ins[0] ? fieldsOf(ins[0]) : [], ins[1] ? fieldsOf(ins[1]) : []]).then(([a, b]) => { lf = a; rf = b; draw(); });
      box.addEventListener('click', e => {
        const b = e.target.closest('button[data-j]')?.dataset.j;
        if (b === 'add') { s.keys.push({ l: '', r: '' }); draw(); }
        else if (b === 'del') { s.keys.splice(+e.target.closest('.ns-key').dataset.i, 1); draw(); changed(); }
      });
      box.addEventListener('change', e => {
        const k = e.target.dataset.j; if (!k) return;
        if (k === 'type') s.type = e.target.value; else s.keys[+e.target.closest('.ns-key').dataset.i][k] = e.target.value;
        changed();
      });
    } else if (n.type === 'append') {
      // Every input's rows one after another, fields matched by name (a field one input lacks is empty there).
      add(`<div class="tm-sep"></div><div class="dr-sec">APPEND</div><div class="dr-full"><div class="in-hint">Inputs, in order: ${ins.map(m => esc(m.title)).join(', ') || 'none yet'}. Fields are matched by name.</div></div>
        <div class="optrow"><span>Remove Duplicate Rows</span><span class="seg"><button type="button" data-a="0" class="${s.distinct ? '' : 'on'}">OFF</button><button type="button" data-a="1" class="${s.distinct ? 'on' : ''}">ON</button></span></div>`);
      box.addEventListener('click', e => {
        const b = e.target.closest('[data-a]'); if (!b) return;
        s.distinct = b.dataset.a === '1'; b.parentElement.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); changed();
      });
    } else if (n.type === 'output') {
      // The dataset Execute saves (data/clean/CLEAN_<NAME>): what Dashboard Studio and Publish use.
      s.name ??= DSPipeline.viewName(n);
      add(`<div class="tm-sep"></div><div class="dr-sec">OUTPUT DATASET</div>
        <div class="optrow"><span>Dataset Name</span><input type="text" data-o="name" value="${esc(s.name)}" spellcheck="false"></div>
        <div class="dr-full"><div class="in-hint">Execute saves it as <code class="ns-ds">CLEAN_${esc(s.name.replace(/^CLEAN_/i, ''))}</code> in data/clean.</div></div>`);
      box.querySelector('[data-o="name"]').oninput = e => {
        const el = e.target, p = el.selectionStart; el.value = el.value.toUpperCase().replace(/\s/g, '_'); el.setSelectionRange(p, p);
        s.name = el.value; box.querySelector('.ns-ds').textContent = `CLEAN_${s.name.replace(/^CLEAN_/i, '')}`; changed();
      };
    } else if (n.type === 'archive') {
      // Execute takes a zipped snapshot of the project in archives/ (as Archive and Update do).
      add(`<div class="tm-sep"></div><div class="dr-sec">ARCHIVE</div>
        <div class="optrow"><span>Snapshot Note</span><input type="text" data-r="note" value="${esc(s.note || '')}" placeholder="Pipeline ${esc(pipe?.name || '')}" spellcheck="false"></div>
        <div class="dr-full"><div class="in-hint">Execute takes a zipped snapshot of the project (settings, datasets, pipelines, dashboard) in archives/.</div></div>`);
      box.querySelector('[data-r="note"]').oninput = e => { s.note = e.target.value; changed(); };
    } else if (n.type === 'publish') {
      // As Publish: the dashboard in the ticked formats, and datasets exported as files (publish/).
      s.targets ??= []; s.data ??= []; s.fmt ??= 'csv';
      const tick = (k, v, label, on) => `<label class="ns-tick"><input type="checkbox" data-p="${k}" value="${esc(v)}" ${on ? 'checked' : ''}> ${esc(label)}</label>`;
      add(`<div class="tm-sep"></div><div class="dr-sec">DASHBOARD</div>
        <div class="optrow"><span>Dashboard Name</span><input type="text" data-p="name" value="${esc(s.name || '')}" spellcheck="false"></div>
        <div class="dr-full">${Publisher.TARGETS.map(t => tick('targets', t.id, t.label, s.targets.includes(t.id))).join('')}</div>
        <div class="tm-sep"></div><div class="dr-sec">DATASETS</div>
        <div class="optrow"><span>File Format</span><select data-p="fmt">${['csv', 'parquet', 'sqlite'].map(f => opt(f, s.fmt)).join('')}</select></div>
        <div class="dr-full ns-data"><div class="in-hint">Reading the project's datasets…</div></div>`);
      Projects.get(ctx.folder).then(cfg => {
        const ds = (cfg.datasets || []).filter(d => /^CLEAN_/.test(d.name)).map(d => d.name).sort();
        box.querySelector('.ns-data').innerHTML = ds.length ? ds.map(d => tick('data', d, d, s.data.includes(d))).join('') : '<div class="in-hint">No CLEAN_ datasets yet: Execute a pipeline with an Output node first.</div>';
      });
      box.addEventListener('change', e => {
        const k = e.target.dataset.p; if (!k) return;
        if (k === 'targets' || k === 'data') s[k] = [...box.querySelectorAll(`[data-p="${k}"]:checked`)].map(x => x.value);
        else s[k] = e.target.value;
        changed();
      });
      box.querySelector('[data-p="name"]').oninput = e => { s.name = e.target.value; changed(); };
    } else if (n.type === 'chart') {
      add('<div class="tm-sep"></div><div class="dr-full"><div class="in-hint">Chart nodes come later.</div></div>');
    }
  }

  // ---- Input node settings: the Import module (ui/html/import.html) in the node window, without its preview. Browse /
  // drop / From Path pick a raw source (Copy: into data/raw; Link: read where it is, From Path only), its schema shows
  // (Keep, Source Field, Detected Type, Change Type, New Field Name), and Import / Update writes the Arrow dataset to
  // data/imported and records it, exactly as the Import module does. The node keeps n.src = { mode, path, label, ext,
  // from, table, ds, name, cols }; the reader, SQL source and row count live only while the page is open. ----
  const { TYPES, TYPE_NEED, typeLabel, tryCast, unquote } = ImportCore;
  const live_ = new Map();   // node id -> { reader, src, rows }
  const dsSlug = s => s.toUpperCase().replace(/\.[^.]+$/, '').replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'DATASET';
  function inputSettings(n, box) {
    const s = n.src && 'label' in n.src ? n.src : (n.src = { mode: 'copy', label: null });
    const L = live_.get(n.id) || {}; live_.set(n.id, L);
    const esc = UI.esc, q = sel => box.querySelector(sel);
    let importing = false;
    box.insertAdjacentHTML('beforeend', `<div class="dr-full im">
        <div class="dr-sec">TABLE NAME <span class="req" title="Required">*</span></div>
        <div><input type="text" class="im-name" placeholder="UPPER_CASE_NAME" spellcheck="false"><span class="im-nmsg" hidden></span></div>
      </div>
      <div class="tm-sep"></div>
      <div class="dr-sec">RAW SOURCE FILES</div>
      <div class="dr-full im">
        <div class="in-mode">
          <label title="Browse, drop and From Path put a copy of the file in the project's data/raw folder"><input type="radio" name="imode-${n.id}" value="copy"> Copy raw files to project</label>
          <label title="From Path reads the file where it is (nothing is copied); Update reads it there again"><input type="radio" name="imode-${n.id}" value="link"> Link to raw file's location</label>
        </div>
        <div class="in-row"><button type="button" class="ghost" data-in="browse">Browse</button><input type="text" class="in-path" placeholder="X:\\folder\\file.csv or \\\\snnsvrXXX\\folder\\file.csv" spellcheck="false" autocomplete="off"><button type="button" data-in="go">GO</button></div>
        <div class="in-drop">Drop CSV, Parquet, Arrow or SQLite files here</div>
        <div class="table-wrap dt-wrap im-src" hidden><table class="grid schema im-files"></table></div>
        <span class="in-st"></span>
      </div>
      <div class="dr-full im im-ed" hidden>
        <div class="dr-sec">SCHEMA</div>
        <div class="im-host"><div class="pgrid im-box">
          <div class="dt-bar"><input class="search im-q" type="search" placeholder="Search" spellcheck="false"><span class="muted dt-n im-n"></span><span style="flex:1"></span>
            <button type="button" class="ghost small" data-in="all" title="Keep every column">Select All</button><button type="button" class="ghost small" data-in="none" title="Keep no columns">Select None</button>
            <button type="button" class="ghost small dt-pop" data-in="pop" title="Open the schema in its own window">Pop-out</button></div>
          <div class="table-wrap dt-wrap"><table class="grid schema im-schema"></table></div>
        </div></div>
        <div class="row"><label class="field im-tl" hidden>Table<select class="im-table"></select></label>
          <div class="stats"><div class="stat"><label>Rows</label><b class="im-rows">-</b></div><div class="stat"><label>Columns</label><b class="im-cols">-</b></div></div></div>
        <div class="row"><button type="button" data-in="validate" hidden>Check Type Changes</button><button type="button" class="ghost" data-in="reset" hidden title="Set every Change Type back to the detected type">Reset to Detected Types</button></div>
      </div>`);
    const status = (t, cls = '') => { const el = q('.in-st'); el.className = `in-st ${cls}`; el.textContent = t; };
    const RAW = () => `${ctx.dir}/data/raw`;
    const showMode = () => { box.querySelectorAll(`[name="imode-${n.id}"]`).forEach(r => r.checked = r.value === (s.mode || 'copy')); };
    const showSrc = () => {
      // every attached file, A-Z by name: File Name, Full Path (where it was attached from)
      const fs = (s.files || []).slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
      q('.im-src').hidden = !fs.length;
      q('.im-files').innerHTML = `<thead><tr><th class="fit">File Name</th><th>Full Path</th></tr></thead><tbody>${fs.map(f => `<tr><td class="mono fit">${esc(f.name)}</td><td class="mono">${esc(f.path)}</td></tr>`).join('')}</tbody>`;
    };
    const cols = () => s.cols || [];
    // The Table Name is the node's title (the node on the grid and this window's title).
    const nameNode = () => { n.title = s.name || n.title; elOf(n.id).querySelector('.nh b').textContent = n.title; const h = document.querySelector('#nodeWin .nh b'); if (h) h.textContent = `Settings - ${n.title}`; };
    // Opens a source as the Import module does: reader, table list, schema (saved choices matched by source field), row count.
    async function openSrc(c) {
      Object.assign(s, { path: c.path ?? null, label: c.label, ext: c.ext || null, from: c.from || null });
      if (!c.keep) Object.assign(s, { ds: null, name: null, cols: null, table: null });
      save(); showSrc(); status('Reading source…');
      L.reader = await ImportCore.reader(s.ext ? s.ext.src : s.path);
      q('.im-ed').hidden = false; q('.im-tl').hidden = L.reader.kind !== 'sqlite';
      q('.im-table').innerHTML = L.reader.tables.map(t => `<option>${esc(t)}</option>`).join('');
      if (s.table && L.reader.tables.includes(s.table)) q('.im-table').value = s.table;
      await loadTable(s.table && L.reader.tables.includes(s.table) ? s.table : L.reader.tables[0], !!c.keep);
    }
    async function loadTable(table, keep) {
      L.src = await L.reader.sql(table); L.rows = null; s.table = table;
      const desc = await Engine.describe(`SELECT * FROM ${L.src}`), by = new Map(keep ? cols().map(x => [x.name, x]) : []);
      s.cols = desc.map(c => { const d = ImportCore.defName(c.name), o = by.get(c.name);
        return o ? { ...c, defName: d, keep: o.keep, newName: o.newName, newType: o.newType } : { ...c, newName: d, defName: d, newType: c.type, keep: !by.size }; });
      q('.im-name').value = s.name || s.ds || dsSlug(table || s.label); s.name = q('.im-name').value; nameNode();
      save(); checkName(); renderSchema(); status('');
      q('.im-cols').textContent = desc.length; q('.im-rows').textContent = '…';
      const st = ctx.step('Counting rows…');
      try { L.rows = Number(await Engine.countLive(L.src, undefined, j => { q('.im-rows').textContent = `${UI.num(j.rowsProcessed || 0)}…`; })); }
      catch (e) { st.fail(`Counting rows failed: ${e.message}`); throw e; }
      q('.im-rows').textContent = UI.num(L.rows); st.done(`Counted ${UI.num(L.rows)} rows`);
    }
    function renderSchema() {
      const t = q('.im-schema');
      t.innerHTML = `<thead><tr><th class="fit">Keep</th><th>Source Field</th><th class="fit">Detected Type</th><th class="fit">Change Type</th><th>New Field Name</th></tr></thead><tbody>` +
        cols().map((c, i) => [c, i]).sort((a, b) => a[0].name.localeCompare(b[0].name, undefined, { sensitivity: 'base', numeric: true })).map(([c, i]) => `<tr><td class="fit"><input type="checkbox" data-i="${i}" data-k="keep" ${c.keep ? 'checked' : ''}></td><td class="mono src">${esc(c.name)}</td><td class="muted fit">${esc(c.type)}</td>
          <td class="fit"><select data-i="${i}" data-k="newType">${[...new Set([c.type, ...TYPES])].map(x => `<option value="${esc(x)}" ${x === c.newType ? 'selected' : ''}>${esc(typeLabel(x))}</option>`).join('')}</select></td>
          <td class="nn"><input type="text" data-i="${i}" data-k="newName" value="${esc(c.newName)}" title="${esc(c.newName)}"></td></tr>`).join('') + '</tbody>';
      const fitAll = (els, w0, pad) => {   // every box as wide as its longest choice / value (as in the Import module)
        if (!els.length) return () => {};
        const cs = getComputedStyle(els[0]), g = document.createElement('canvas').getContext('2d'); g.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const side = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth) + pad;
        const fit = () => { const w = Math.ceil(Math.max(w0, ...els.flatMap(el => el.tagName === 'SELECT' ? [g.measureText(el.selectedOptions[0]?.text || '').width] : [g.measureText(el.value).width])) + side);
          els.forEach(el => Object.assign(el.style, { width: w + 'px', minWidth: w + 'px', maxWidth: 'none' })); };
        fit(); return fit;
      };
      fitAll([...t.querySelectorAll('select[data-k="newType"]')], 0, 28);
      showValidate(); filterSchema();
    }
    const showValidate = () => { const h = !cols().some(c => c.newType !== c.type); q('[data-in="validate"]').hidden = h || !cols().some(c => c.keep && c.newType !== c.type); q('[data-in="reset"]').hidden = h; };
    function filterSchema() {
      const v = q('.im-q').value.trim().toLowerCase(); let k = 0;
      q('.im-schema').querySelectorAll('tbody tr').forEach(tr => { const c = cols()[+tr.querySelector('[data-i]').dataset.i], ok = !v || c.name.toLowerCase().includes(v) || c.newName.toLowerCase().includes(v); tr.hidden = !ok; if (ok) k++; });
      q('.im-n').textContent = `${UI.num(k)}${v ? ' matching' : ''} of ${UI.num(cols().length)} fields`;
    }
    function checkName() {
      const v = q('.im-name').value.trim(), msg = !v ? 'A name is required.' : /^[0-9]/.test(v) ? "The name can't start with a number." : '';
      q('.im-name').classList.toggle('bad', !!msg); q('.im-nmsg').textContent = msg; q('.im-nmsg').hidden = !msg;
      const b = q('[data-in="import"]'); if (b) { b.disabled = importing || !!msg; b.textContent = s.ds ? 'Update' : 'Import'; }
      return !msg;
    }
    async function checkTypes() {
      const changed = cols().filter(c => c.keep && c.newType !== c.type);
      if (!changed.length) { ctx.log('No type changes to check.'); return 0; }
      const st = ctx.step(`Checking ${changed.length} type change${changed.length > 1 ? 's' : ''}…`);
      let r;
      try { r = await Engine.query(`SELECT ${changed.map((c, i) => `COUNT(CASE WHEN ${Engine.q(c.name)} IS NOT NULL AND ${tryCast(c.name, c.newType)} IS NULL THEN 1 END) AS c${i}`).join(', ')} FROM ${L.src}`); }
      catch (e) { st.fail(`Type check failed: ${e.message}`); throw e; }
      const bad = changed.map((c, i) => [c, Number(r.rows[0][i])]).filter(([, k]) => k > 0), badSet = new Set(bad.map(([c]) => c));
      q('.im-schema').querySelectorAll('select[data-k="newType"]').forEach(el => el.classList.toggle('bad', badSet.has(cols()[+el.dataset.i])));
      if (!bad.length) st.done('Type check: all changes convert cleanly');
      for (let k = 0; k < bad.length; k++) {
        const [c, m] = bad[k]; let ex = [];
        try { ex = (await Engine.query(`SELECT DISTINCT CAST(${Engine.q(c.name)} AS VARCHAR2(4000)) FROM ${L.src} WHERE ${Engine.q(c.name)} IS NOT NULL AND ${tryCast(c.name, c.newType)} IS NULL FETCH FIRST 3 ROWS ONLY`)).rows.map(x => `"${x[0]}"`); } catch {}
        const msg = `Type check: ${c.name} → ${c.newType}: ${UI.num(m)} value(s) cannot convert${ex.length ? `, e.g. ${ex.join(', ')}` : ''}. ${TYPE_NEED[c.newType] || ''} They would become null.`;
        if (k === bad.length - 1) st.done(msg, 'warn'); else ctx.log(msg, 'warn');
      }
      return bad.reduce((a, [, m]) => a + m, 0);
    }
    // Import / Update: the Import module's runImport (column choices applied, Arrow in data/imported, checks, dataset record).
    async function runImport() {
      const name = q('.im-name').value.trim();
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new Error(/^[0-9]/.test(name) ? "Dataset name: it can't start with a number." : 'Dataset name: use letters, digits and _ only.');
      if (L.rows == null) throw new Error('Still counting rows; try again in a moment.');
      const keep = cols().filter(c => c.keep);
      if (!keep.length) throw new Error('Keep at least one column.');
      const dup = keep.map(c => c.newName).find((x, i, a) => a.indexOf(x) !== i);
      if (dup) throw new Error(`Column name "${dup}" is used twice.`);
      const bad = await checkTypes();
      if (bad && !await UI.confirm(`${UI.num(bad)} value(s) cannot be converted and will be imported as null. Continue?`, { ok: 'Import anyway' })) return;
      const select = ImportCore.selectList(cols()), want = keep.map(c => c.newName);
      const folder = 'imported', dest = `${ctx.dir}/data/${folder}/${name}`;
      const cfg = await ctx.reload();
      if (cfg.datasets?.some(d => d.name === name) && s.ds !== name && !await UI.confirm(`Dataset "${name}" already exists. Replace it?`, { danger: true, ok: 'Replace' })) return;
      const t0 = performance.now();
      importing = true; checkName();
      try {
        const wst = ctx.step('Writing Arrow…');
        const w = await Engine.write({ sql: `SELECT ${select} FROM ${L.src}`, dest, meta: { source: s.ext?.src || s.path } }, j => {
          const t = `${j.stage || 'Working'}… ${UI.num(j.rowsProcessed)} of ${UI.num(L.rows)} rows${j.progress != null ? ` (${Math.round(100 * j.progress)}%)` : ''}`;
          wst.set(t); status(t);
        }).catch(e => { wst.fail(`Write failed: ${e.message}`); throw e; });
        wst.done('Written'); ctx.log('Checking columns and row count…');
        const rows = w.rowCount, columns = Engine.columnsOf(w), parts = w.files, got = columns.map(c => c.name), diff = want.findIndex((x, i) => x !== got[i]);
        const checks = [
          { name: 'Column count', ok: want.length === got.length, detail: `${want.length} expected, ${got.length} written` },
          { name: 'Column names and order', ok: diff < 0 && want.length === got.length, detail: diff < 0 ? 'match' : `#${diff + 1}: "${want[diff]}" expected, "${got[diff]}" written` },
          { name: 'Row count', ok: rows === L.rows, detail: `${UI.num(L.rows)} in source, ${UI.num(rows)} written in ${parts.length} part${parts.length > 1 ? 's' : ''}` },
        ];
        checks.forEach(c => ctx.log(`${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`, c.ok ? 'ok' : 'err'));
        if (checks.some(c => !c.ok)) {
          await DNFS.remove(w.path, { recursive: true }).catch(() => {});
          throw new Error(`Import check failed (${checks.filter(c => !c.ok).map(c => c.name).join(', ')}); the output was removed.`);
        }
        const st = s.ext ? { size: s.ext.size, modified: s.ext.modified } : await DNFS.stat(s.path);
        await Projects.upsertDataset(ctx.folder, {
          name, path: w.path, parts, stage: folder, direct: false, rows, bytes: w.bytes, columns, version: w.version, imported: new Date().toISOString(),
          source: { mode: s.ext ? 'link' : 'copy', path: s.ext ? null : s.path, origin: s.ext?.src || null, from: s.from || null,
            table: s.table || null, kind: L.reader.kind, select, direct: false, size: st.size, modified: st.modified,
            columns: cols().map(c => ({ name: c.name, type: c.type, keep: c.keep, newName: c.newName, newType: c.newType })) },
        });
        const old = s.ds && s.ds !== name ? (await ctx.reload()).datasets.find(d => d.name === s.ds) : null;
        if (old) {
          await Projects.update(ctx.folder, { datasets: (await ctx.reload()).datasets.filter(d => d.name !== old.name) });
          if (old.path && old.path !== w.path) await DNFS.remove(old.path, { recursive: true }).catch(() => {});
          ctx.log(`Renamed dataset ${old.name} → ${name}`, 'ok');
        }
        await Projects.touchModule(ctx.folder, 'import');
        ctx.log(`Imported ${s.label}${s.table ? `:${s.table}` : ''} → data/${folder}/${name}/ (${parts.length} part${parts.length > 1 ? 's' : ''}): ${UI.num(rows)} rows, ${columns.length} columns, ${UI.bytes(w.bytes)} in ${UI.ms(performance.now() - t0)}`, 'ok');
        UI.toast(`Imported ${name}`, 'ok');
        s.ds = name; s.name = name; save(); showSrc(); status('');
      } finally { importing = false; checkName(); }
    }
    // Attaches files by full path (Browse = the server's Windows dialog, drop = found by the server in Explorer, or the path
    // box). Copy: each file is copied into data/raw; Link: it stays where it is and only its path is kept. Every attached
    // file is listed (n.src.files); the last one attached is the one the schema shows.
    const onWait = d => { status(`Waiting on drive ${d}: no response for 10 s. Giving up at 30 s.`, 'warn'); UI.toast(`Waiting on drive ${d}…`, ''); };
    async function attach(paths) {
      const Xs = ExternalSource, ok = paths.filter(p => Engine.kind(p));
      if (ok.length < paths.length) UI.toast('Unsupported file type. Use CSV, Parquet, Arrow or SQLite.', 'err');
      let last = null;
      for (const src of ok) {
        const name = Xs.name(src), fail = e => { status(e.message, 'err'); ctx.log(`Import from ${src} failed${e.drive ? ` (drive ${e.drive})` : ''}: ${e.message}`, 'err'); throw e; };
        status(`Checking ${name}…`);
        const info = await Xs.probe(src, { onWait }).catch(fail);
        let copy = null;
        if (s.mode !== 'link') {
          copy = `${RAW()}/${name}`;
          await Xs.copy(src, copy, (d, t) => status(`Copying ${name}: ${UI.bytes(d)} of ${UI.bytes(t)}`), { onWait }).catch(fail);
          ctx.log(`Copied ${src} → ${copy} (${UI.bytes(info.size)})`, 'ok');
        } else ctx.log(`Linked ${src}`, 'ok');
        s.files = (s.files || []).filter(f => f.path.toLowerCase() !== src.toLowerCase());
        s.files.push(last = { name, path: src, copy, size: info.size, modified: info.modified });
      }
      save(); showSrc();
      if (last) await openFile(last);
    }
    const openFile = f => f.copy ? openSrc({ path: f.copy, label: f.name, from: { src: f.path, size: f.size, modified: f.modified } })
      : openSrc({ path: null, label: f.name, ext: { src: f.path, size: f.size, modified: f.modified } });
    async function browse() {
      status('Pick the files in the Windows dialog…');
      const r = await ExternalSource.pick();
      status(''); if (r.length) await attach(r);
    }
    async function dropped(files) {
      if (!files.length) return;
      status('Finding the dropped files…');
      const r = await ExternalSource.locate(files.map(f => ({ name: f.name, size: f.size })));
      status('');
      if (r.missing.length) UI.toast(`Could not find where ${r.missing.join(', ')} ${r.missing.length > 1 ? 'are' : 'is'}: use Browse or type the full path.`, 'err');
      if (r.paths.length) await attach(r.paths);
    }
    async function fromPath() {
      const src = q('.in-path').value = unquote(q('.in-path').value);
      if (!ExternalSource.isPath(src)) throw new Error('Enter a full path like X:\folder\file.csv or \\server\share\file.csv.');
      await attach([src]); q('.in-path').value = '';
    }
    const G_ = fn => UI.guard(async (...a) => { try { await fn(...a); } catch (e) { status(''); throw e; } });
    const drop = q('.in-drop');
    drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = G_(async e => { e.preventDefault(); drop.classList.remove('over'); await dropped([...e.dataTransfer.files]); });
    const path = q('.in-path');
    path.addEventListener('paste', e => { const t = unquote(e.clipboardData?.getData('text/plain') || ''); if (t) { e.preventDefault(); path.value = t; } });
    path.addEventListener('keydown', e => { if (e.key === 'Enter') G_(fromPath)(); });
    q('.im-name').addEventListener('input', e => { const el = e.target, p = el.selectionStart, u = el.value.toUpperCase().replace(/\s/g, '_'); if (u !== el.value) { el.value = u; el.setSelectionRange(p, p); } s.name = el.value; nameNode(); save(); checkName(); });
    q('.im-q').oninput = filterSchema;
    q('.im-table').onchange = G_(() => loadTable(q('.im-table').value));
    box.addEventListener('click', G_(async e => {
      const b = e.target.closest('[data-in]')?.dataset.in; if (!b) return;
      if (b === 'browse') await browse();
      else if (b === 'go') await fromPath();
      else if (b === 'all' || b === 'none') { cols().forEach(c => c.keep = b === 'all'); save(); renderSchema(); }
      else if (b === 'reset') { cols().forEach(c => c.newType = c.type); save(); renderSchema(); ctx.log('Change types reset to the detected types.'); }
      else if (b === 'pop') DataTable.popOut(q('.im-host'), q('.im-box'), `${q('.im-name').value || s.label} schema`);
      else if (b === 'validate') await checkTypes();
      else if (b === 'import') await runImport();
    }));
    box.addEventListener('change', e => {
      const el = e.target;
      if (el.name === `imode-${n.id}`) { s.mode = el.value; save(); showMode(); return; }
      const c = cols()[+el.dataset.i]; if (!c || !el.closest('.im-schema')) return;
      if (el.dataset.k === 'newType') el.classList.remove('bad');
      c[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value.trim(); save(); if (el.dataset.k === 'newType') renderSchema(); else showValidate();
    });
    box.addEventListener('input', e => { if (e.target.dataset.k === 'newName' && e.target.closest('.im-schema')) { const el = e.target, p = el.selectionStart, u = el.value.toUpperCase(); if (u !== el.value) { el.value = u; el.setSelectionRange(p, p); } } });
    showMode(); showSrc(); q('.im-name').value = s.name || ''; checkName();
    if (s.label) G_(() => openSrc({ path: s.path, label: s.label, ext: s.ext, from: s.from, keep: true }))();   // reopened: the same source and choices
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
        const c = JSON.parse(JSON.stringify(m)); c.id = DSPipeline.uuid(); c.x = m.x + dx; c.y = m.y + dy; map.set(m.id, c.id);
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
    if (dbl && !e.target.closest('.port, .rz')) { openNodeWin(n); return; }
    // Selection: Ctrl + click adds / removes a node; a plain click on an unselected node selects only it (on a selected
    // one it keeps the group, to drag it).
    if (e.ctrlKey || e.metaKey) el.classList.toggle('sel');
    else if (!el.classList.contains('sel')) $('nodes').querySelectorAll('.node.sel').forEach(x => x.classList.remove('sel'));
    if (!e.ctrlKey && !e.metaKey) el.classList.add('sel');
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
  // what the node's last run wrote (its first 1000 rows while the pipeline is built)
  async function outSql(n) { return n && pipe ? `SELECT * FROM read_dataset(${Engine.lit(DSPipeline.outDir(ctx, pipe, n, 'preview'))})` : null; }
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

  // ---- State: the open pipeline (<project>/pipelines/<name>.pipeline, DSPipeline) holds the view, nodes and wires;
  // <project>/data-studio/studio.json = { pipeline: the one open, preview, drawer } (this window, per project). Written as
  // it changes (every move, wire, resize, zoom, scroll, selection), so the window reopens exactly as it was left. ----
  const FILE = () => `${ctx.dir}/data-studio/studio.json`;
  let pipe = null;   // the open pipeline
  function save() {
    showDataSoon();   // anything that is saved may change what the preview shows
    if (!ctx || !pipe) return;
    dirty = true; clearTimeout(saveT);
    saveT = setTimeout(flush, 150);
    runSoon();
  }
  async function flush() {
    if (!dirty || !ctx || !pipe) return;
    dirty = false; clearTimeout(saveT);
    Object.assign(pipe, { view: { zoom, offX, offY }, nodes, links, sel: [...$('nodes').querySelectorAll('.node.sel')].map(x => x.dataset.id) });
    try {
      await DSPipeline.save(ctx, pipe);
      await DNFS.writeJSON(FILE(), { version: 2, pipeline: pipe.name, preview, drawer, updated: new Date().toISOString() });
    } catch (e) { UI.toast(`Data Studio not saved: ${e.message}`, 'err'); }
  }
  on(window, 'pagehide', flush);
  on(document, 'visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });

  // ---- Pipelines: open one (its nodes on the grid), make a new one, delete one. ----
  async function openPipe(name) {
    await flush();
    const p = await DSPipeline.load(ctx, name);
    if (!p) return UI.toast(`Pipeline ${name} not found.`, 'err');
    pipe = p; closeNodeWin();
    $('nodes').querySelectorAll('.node').forEach(el => el.remove()); vis.clear();
    nodes = p.nodes; links = p.links.filter(l => { const t = nodes.find(m => m.id === l.to), f = nodes.find(m => m.id === l.from); return t && f && hasIn(t) && hasOut(f); });
    nodes.forEach(n => { n.w ??= W0; n.h ??= H0; });
    ({ zoom = 1, offX = 0, offY = 0 } = p.view || {});
    nodes.forEach(drawNode); drawLinks();
    [].concat(p.sel || []).forEach(id => elOf(id)?.classList.add('sel'));
    $('pipeName').textContent = p.name; document.title = `${p.name} · Data Studio`;
    applyView(); lastSig = ''; dirty = true; await flush();
    runSoon(true);
  }
  // The Pipelines window: New + a name box, then every pipeline of the project (A-Z); a click opens one, the red X
  // (on hover) deletes it after asking.
  async function openPipeWin() {
    closePipeWin();
    const bd = document.createElement('div'); bd.className = 'nwin-bd'; bd.id = 'pipeWinBd';
    const w = document.createElement('div'); w.className = 'node sel nwin pwin'; w.id = 'pipeWin';
    w.innerHTML = `<div class="nh"><svg viewBox="0 0 24 24">${ICON_PIPE}</svg><b>Pipelines</b><button type="button" class="nx" title="Close">×</button></div>
      <div class="drawer nwin-in"><div class="dr-b"><div class="dr-full">
        <div class="in-row"><button type="button" data-p="new">New</button><input type="text" class="pw-name" placeholder="Pipeline name" spellcheck="false"></div>
        <div class="pw-list"></div></div></div></div>`;
    document.body.append(bd, w);
    const W = 16 * G, H = 16 * G;
    Object.assign(w.style, { width: `${W}px`, height: `${H}px`, left: `${(innerWidth - W) / 2}px`, top: `${(innerHeight - H) / 2}px` });
    const draw = async () => {
      const names = await DSPipeline.list(ctx);
      w.querySelector('.pw-list').innerHTML = names.length ? names.map(nm => `<div class="pw-row${pipe?.name === nm ? ' on' : ''}" data-name="${UI.esc(nm)}"><span>${UI.esc(nm)}</span><button type="button" class="pw-x" title="Delete this pipeline">×</button></div>`).join('')
        : '<div class="in-hint">No pipelines yet: type a name and click New.</div>';
    };
    const make = UI.guard(async () => {
      const nm = DSPipeline.safe(w.querySelector('.pw-name').value);
      if (!nm) throw new Error('Type a name for the new pipeline.');
      if ((await DSPipeline.list(ctx)).some(x => x.toLowerCase() === nm.toLowerCase())) throw new Error(`There is already a pipeline named ${nm}.`);
      await DSPipeline.save(ctx, DSPipeline.blank(nm));
      closePipeWin(); await openPipe(nm);
      ctx.log(`Pipeline ${nm} created`, 'ok');
    });
    w.querySelector('.pw-name').addEventListener('keydown', e => { if (e.key === 'Enter') make(); });
    w.addEventListener('pointerdown', e => e.stopPropagation());
    w.addEventListener('click', UI.guard(async e => {
      if (e.target.closest('.nh .nx')) return pipe ? closePipeWin() : UI.toast('Open or make a pipeline first.', 'err');
      if (e.target.closest('[data-p="new"]')) return make();
      const row = e.target.closest('.pw-row'); if (!row) return;
      const nm = row.dataset.name;
      if (e.target.closest('.pw-x')) {
        if (!await UI.confirm(`Delete the pipeline ${nm} and everything its nodes made?`, { danger: true, ok: 'Delete' })) return;
        if (pipe?.name === nm) { pipe = null; nodes = []; links = []; $('nodes').querySelectorAll('.node').forEach(el => el.remove()); drawLinks(); $('pipeName').textContent = ''; }
        await DSPipeline.remove(ctx, nm); ctx.log(`Pipeline ${nm} deleted`); return draw();
      }
      closePipeWin(); await openPipe(nm);
    }));
    requestAnimationFrame(() => requestAnimationFrame(() => { bd.classList.add('in'); w.classList.add('in'); }));
    await draw(); w.querySelector('.pw-name').focus();
  }
  function closePipeWin() {
    for (const id of ['pipeWin', 'pipeWinBd']) { const el = document.getElementById(id); if (el) { el.removeAttribute('id'); el.classList.remove('in'); el.style.pointerEvents = 'none'; setTimeout(() => el.remove(), 200); } }
  }
  on(window, 'keydown', e => { if (e.key === 'Escape' && pipe) closePipeWin(); });

  // ---- Running: as the pipeline is built, every node whose settings, SQL or inputs changed runs on the first 1000 rows
  // (with what is downstream of it); Execute runs every node on the full data. A node shows its state: orange flashing
  // dot = running, green = done (its border flashes green 3 times as it finishes), red = failed (hover: why). ----
  let runT = 0, running = false, again = false, lastSig = '';
  function runSoon(force) { clearTimeout(runT); runT = setTimeout(() => runPreview(force), 600); }
  function nodeState(n, st, info = {}, cached) {
    const el = elOf(n.id); if (!el) return;
    el.dataset.st = st === 'idle' ? '' : st;
    el.querySelector('.nst').title = st === 'failed' ? info.error || 'Failed' : st === 'running' ? 'Running…' : st === 'done' ? `${UI.num(info.rows ?? 0)} rows${info.at ? `, ${new Date(info.at).toLocaleString()}` : ''}` : '';
    if (st === 'done' && !cached) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1900); }
  }
  async function runPreview(force) {
    if (!pipe || !ctx) return;
    const sig = JSON.stringify([nodes.map(n => [n.id, n.type, n.title, n.cfg, n.src]), links]);
    if (!force && sig === lastSig) return;
    if (running) { again = true; return; }
    lastSig = sig; running = true;
    try { await flush(); await DSPipeline.run(ctx, pipe, { mode: 'preview', onNode: nodeState, onJob: jobBar }); }
    finally { running = false; jobBar(null); showDataSoon(); }
    if (again) { again = false; runPreview(true); }
  }
  async function execute() {
    if (!pipe) return UI.toast('Open or make a pipeline first.', 'err');
    if (running) return UI.toast('A run is in progress; try again when it ends.');
    running = true; $('exec').disabled = true;
    const t0 = performance.now();
    try {
      await flush();
      ctx.log(`Executing pipeline ${pipe.name} on the full data…`);
      const r = await DSPipeline.run(ctx, pipe, { mode: 'data', onNode: nodeState, onJob: jobBar, log: (m, l) => ctx.log(m, l === 'error' ? 'err' : l) });
      if (r.ok) { UI.toast(`${pipe.name} executed in ${UI.ms(performance.now() - t0)}`, 'ok'); ctx.log(`Pipeline ${pipe.name} executed in ${UI.ms(performance.now() - t0)}`, 'ok'); }
      else UI.toast(r.error, 'err');
    } finally { running = false; $('exec').disabled = false; jobBar(null); }
  }
  $('exec').onclick = execute;
  $('exec').addEventListener('pointerdown', e => e.stopPropagation());

  // ---- Memory and Workers cards (top right): the engine's memory in use, 0-100% of what it may use (past 100%
  // spill to disk takes over); one light per worker (grey idle, green reading / computing, red writing) and a bar for
  // the job running now. ----
  function jobBar(j, n) {
    const bar = $('wkBar'), txt = $('wkJob');
    if (!j) { bar.style.width = '0'; bar.classList.remove('busy'); txt.textContent = 'Idle'; return; }
    const pct = j.progress != null ? Math.round(100 * j.progress) : null;
    bar.style.width = pct != null ? `${pct}%` : '100%'; bar.classList.toggle('busy', pct == null);
    txt.textContent = `${n?.title || ''}: ${j.stage || 'Working'}${j.rowsProcessed ? ` · ${UI.num(j.rowsProcessed)} rows` : ''}${pct != null ? ` · ${pct}%` : ''}`;
  }
  let cardBusy = false;
  setInterval(async () => {
    if (cardBusy || document.hidden || !ctx) return;
    cardBusy = true;
    try {
      const [w, st] = await Promise.all([Engine.call('workers'), Engine.status()]);
      const s = w.states.slice(); let extra = w.writers || 0;
      for (let i = 0; i < s.length && extra > 0; i++) if (s[i] === 0) { s[i] = 2; extra--; }
      const host = $('wkLights');
      if (host.children.length !== s.length) host.innerHTML = s.map((_, i) => `<i title="Worker ${i + 1}"></i>`).join('');
      s.forEach((v, i) => { const c = `l${v}`; if (host.children[i].className !== c) host.children[i].className = c; });
      // in use = the budget less what is still free above the floor Windows keeps
      const m = st.memory, free = Math.max(0, m.availPhys - m.freeFloor), used = Math.max(0, m.budget - free), pct = m.budget ? Math.min(100, Math.round(100 * used / m.budget)) : 0;
      $('memPct').textContent = `${pct}%`; $('memBar').style.width = `${pct}%`;
      $('memCard').classList.toggle('spill', pct >= 100);
      $('memCard').title = `${UI.bytes(used)} of ${UI.bytes(m.budget)} the engine may use${pct >= 100 ? ': spilling to disk' : ''}`;
    } catch {}
    finally { cardBusy = false; }
  }, 300);

  // A start-up failure stays on screen (not only a notification that fades), so it can be read and fixed.
  const fail = e => { console.error(e); $('stage').insertAdjacentHTML('beforeend', `<div class="ds-fail">Data Studio could not start: ${UI.esc(e?.message || e)}</div>`); };
  on(window, 'error', e => fail(e.error || e.message));
  on(window, 'unhandledrejection', e => fail(e.reason));
  try { ctx = await ModulePage.init('data_studio', 'Data Studio'); }
  catch (e) { return fail(e); }
  const saved = await DNFS.readJSONOr(FILE(), null).catch(() => null);
  if (saved?.preview) { preview = { ...preview, ...saved.preview }; drawTabs(); }
  if (saved?.drawer?.id === STUDIO) { drawer = { ...drawer, ...saved.drawer }; openStudioSettings(); }
  let names = await DSPipeline.list(ctx);
  if (!names.length && saved?.nodes?.length) {   // before pipelines: the nodes kept in studio.json become the first pipeline
    await DSPipeline.save(ctx, { ...DSPipeline.blank('Pipeline 1'), view: saved.view, nodes: saved.nodes, links: saved.links || [] });
    names = await DSPipeline.list(ctx);
  }
  const first = names.find(x => x === saved?.pipeline) || names[0];
  if (first) await openPipe(first); else { applyView(); openPipeWin(); }
  if (prefs.preview) showDataSoon();
  $('types').onclick = e => {
    const t = e.target.closest('.type'); if (!t) return;
    const act = t.dataset.act;
    // a dimmed button: the one in use closes first, then this one opens
    if (act !== 'nodes') closeNodeMenu();
    if (act !== 'settings' && drawer.id === STUDIO) closeSettings();
    if (act === 'settings') drawer.id === STUDIO ? closeSettings() : openStudioSettings();
    else if (act === 'nodes') document.getElementById('nodeMenu') ? closeNodeMenu() : openNodeMenu(t);
    else if (act === 'pipeline') openPipeWin();
  };
})();
