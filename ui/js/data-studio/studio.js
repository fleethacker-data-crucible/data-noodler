// Data Studio (ui/html/data-studio.html): the project's workflow as draggable, connectable nodes on the 24px grid
// (Import, Transform, Dashboard, Publish, Archive, Update schedule). In development.
(async () => {
  const $ = id => document.getElementById(id);
  // Window listeners go through on(), so a hot update (ui/js/core/live-reload.js) can take them all off again; listeners
  // on the page's own elements go with the elements (the update replaces them).
  const offs = [];
  const on = (t, type, fn, opt) => { t.addEventListener(type, fn, opt); offs.push(() => t.removeEventListener(type, fn, opt)); };
  let ctx, saveT = 0, dirty = false;   // the project (once loaded); pending save of the studio state
  let preview = { h: 240, tab: 'input' }, pvH = 0, pvRaf = 0;   // Data Preview drawer: its height, open tab; shown height (glides)
  let drawer = { id: null, on: false, open: { input: true } };   // open: Nodes drawer categories expanded   // the Settings drawer: the node it shows (null = hidden); on = comes back with the next selected node (off after X)
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
  // Auto Hide: the icon bar fades out once the mouse has been off it for 2s.
  let hideT = 0, menu = null;
  function hideSoon() {
    clearTimeout(hideT); const bar = $('types');
    bar.classList.remove('faded');
    if (prefs.autoHide && !bar.matches(':hover') && !menu) hideT = setTimeout(() => { if (!menu && !bar.matches(':hover')) bar.classList.add('faded'); }, 2000);
  }
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
  on(window, 'keydown', e => { if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r')) e.preventDefault(); });   // no refresh: the canvas would be lost
  $('types').addEventListener('pointerenter', () => { clearTimeout(hideT); $('types').classList.remove('faded'); });
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
    $('nodes').style.transform = `translate(${ox}px, ${oy}px) scale(${zoom})`;
    $('zPct').textContent = `${Math.round(zoom * 100)}%`;
    $('zReset').classList.toggle('off', Math.abs(zoom - 1) < 1e-6);
    // X / Y: the grid point at the window centre, in grid px
    $('sPos').textContent = `X ${Math.round(-offX / zoom)}  Y ${Math.round(-offY / zoom)}`;
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
  const G = 24, NS = 'http://www.w3.org/2000/svg', W0 = 6 * 24, H0 = 3 * 24, WMIN = 120, HMIN = 72;   // new node: 6 x 3 grid cells
  const ICON_IMPORT = '<path d="M12 3v12M7 10l5 5 5-5M4 19h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
  const ICON_TRANSFORM = '<path d="M4 7h12M13 4l3 3-3 3M20 17H8M11 14l-3 3 3 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
  const ICON_JOIN = '<path d="M4 6h5a4 4 0 0 1 4 4v4a4 4 0 0 0 4 4h3M4 18h5a4 4 0 0 0 4-4M17 15l3 3-3 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
  const ICONS = { import: ICON_IMPORT, transform: ICON_TRANSFORM, join: ICON_JOIN };
  let nodes = [{ id: 'n1', type: 'import', title: 'Import', sub: 'Test node', x: -264, y: -48 },
               { id: 'n3', type: 'import', title: 'Import 2', sub: 'Test node', x: -264, y: 96 },
               { id: 'n4', type: 'join', title: 'Join', sub: 'Test node', x: 72, y: 96 },
               { id: 'n2', type: 'transform', title: 'Transform', sub: 'Test node', x: 72, y: -48 }];
  nodes.forEach(n => { n.w ??= W0; n.h ??= H0; });
  applyView();
  let links = [];   // { from: node id (its out port), to: node id (its in port) }
  const snap = v => prefs.snap ? Math.round(v / G) * G : Math.round(v);
  const nodeOf = id => nodes.find(m => m.id === id), elOf = id => $('nodes').querySelector(`.node[data-id="${id}"]`);
  const multi = n => n.type === 'join';
  const hasIn = n => n.type !== 'import';   // input nodes: an output only
  const ins = n => links.filter(l => l.to === n.id);
  const wires = document.createElementNS(NS, 'svg'); wires.id = 'wires'; $('nodes').append(wires);
  const DIRS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
  function drawNode(n) {
    const el = document.createElement('div');
    el.className = `node t-${n.type}`; el.dataset.id = n.id;
    el.innerHTML = `<div class="nh"><svg viewBox="0 0 24 24">${ICONS[n.type]}</svg><b>${UI.esc(n.title)}</b><button type="button" class="nx" title="Delete this node">×</button></div><div class="nb">${UI.esc(n.sub)}</div>`
      + (hasIn(n) ? '<span class="port in" data-port="in"></span>' : '') + '<span class="port out" data-port="out"></span>' + DIRS.map(d => `<span class="rz ${d}" data-dir="${d}"></span>`).join('');
    $('nodes').append(el); vis.set(n.id, { x: n.x, y: n.y, w: n.w, h: n.h }); putNode(el, n);
  }

  // ---- Node Settings: a fixed drawer that slides out from the window's right side, 400px wide (long names wrap; screen
  // px, never zoomed). One node at a time: Settings on another node swaps it in. ----
  const STUDIO = '__studio', NODES = '__nodes';   // drawer.id while it shows the Data Studio settings / the Nodes list
  // The Nodes drawer (top bar Nodes): the node types by category, each category collapsible (arrow on the left).
  const ICON_FILE = '<path d="M6 2h8l5 5v15H6z M14 2v5h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>';
  const ICON_DB = '<ellipse cx="12" cy="5.5" rx="7" ry="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5" fill="none" stroke="currentColor" stroke-width="1.8"/>';
  const ICON_SHEET = '<rect x="4" y="4" width="16" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M4 9.5h16M4 15h16M10 4v16" stroke="currentColor" stroke-width="1.8"/>';
  const NODE_CATS = [
    { id: 'input', name: 'INPUT', type: 'import', items: [
      { name: 'Text (.csv, .tsv, .txt)', title: 'Text', icon: ICON_FILE },
      { name: 'Database (.parquet, .sqlite, .arrow)', title: 'Database', icon: ICON_DB },
      { name: 'Excel (.xlsx, .xlsb, .xlsm)', title: 'Excel', icon: ICON_SHEET },
    ] },
  ];
  function openNodes() {
    const d = $('drawer'), body = $('drBody');
    drawer.id = NODES; drawer.on = true; d.className = 'drawer open list';
    $('drTitle').textContent = 'NODES';
    body.onchange = body.oninput = null;
    body.innerHTML = NODE_CATS.map(c => `<div class="nd-cat${drawer.open[c.id] ? ' open' : ''}" data-cat="${c.id}">
      <div class="nd-h"><span class="nd-arr"></span>${UI.esc(c.name)}</div>
      <div class="nd-items">${c.items.map((it, i) => `<div class="nd-item t-${c.type}" data-cat="${c.id}" data-i="${i}" title="${UI.esc(it.name)}"><span class="nd-ic"><svg viewBox="0 0 24 24">${it.icon}</svg></span><span class="nd-t">${UI.esc(it.name)}</span></div>`).join('')}</div></div>`).join('');
    body.onclick = e => {
      const h = e.target.closest('.nd-h'); if (!h) return;
      const cat = h.parentElement, id = cat.dataset.cat;
      drawer.open[id] = !drawer.open[id]; cat.classList.toggle('open', drawer.open[id]); save();
    };
    body.onpointerdown = dragNewNode;
    save();
  }
  // Drag a node type out of the Nodes drawer: a ghost follows the mouse; let go over the grid = a new node there (centred
  // on the mouse, snapped), selected. Let go anywhere else = nothing.
  function dragNewNode(e) {
    const tile = e.target.closest('.nd-item'); if (!tile || e.button !== 0) return;
    e.preventDefault();
    const cat = NODE_CATS.find(c => c.id === tile.dataset.cat), it = cat.items[+tile.dataset.i];
    const ghost = tile.querySelector('.nd-ic').cloneNode(true); ghost.classList.add('nd-ghost', `t-${cat.type}`); document.body.append(ghost);
    const at = ev => { ghost.style.left = `${ev.clientX}px`; ghost.style.top = `${ev.clientY}px`; };
    at(e); tile.setPointerCapture(e.pointerId);
    const overGrid = ev => { const t = document.elementFromPoint(ev.clientX, ev.clientY); return t && (onGrid(t) || !!t.closest('#nodes')); };
    const move = ev => { at(ev); ghost.classList.toggle('no', !overGrid(ev)); };
    const up = ev => {
      tile.removeEventListener('pointermove', move); tile.removeEventListener('pointerup', up); ghost.remove();
      if (!overGrid(ev)) return;
      const p = toGrid(ev.clientX, ev.clientY);
      const n = { id: `n${Date.now().toString(36)}`, type: cat.type, title: it.title || it.name, sub: it.name, x: snap(p.x - W0 / 2), y: snap(p.y - H0 / 2), w: W0, h: H0 };
      nodes.push(n); drawNode(n);
      document.querySelectorAll('.node.sel').forEach(x => x.classList.remove('sel')); elOf(n.id).classList.add('sel');
      drawLinks(); applyView();
    };
    tile.addEventListener('pointermove', move); tile.addEventListener('pointerup', up);
  }
  function openStudioSettings() {
    const d = $('drawer');
    drawer.id = STUDIO; drawer.on = true; d.className = 'drawer open';
    $('drTitle').textContent = 'DATA STUDIO SETTINGS';
    $('drBody').innerHTML = prefsHtml(); bindPrefs($('drBody')); filterSettings();
    save();
  }
  function openSettings(n) {
    const d = $('drawer');
    drawer.id = n.id; drawer.on = true; d.className = `drawer open t-${n.type}`; $('drBody').onclick = null;
    $('drTitle').textContent = `${n.title} Settings`;
    $('drBody').onchange = $('drBody').onclick = null;
    $('drBody').innerHTML = `<div class="optrow"><span>Name</span><input type="text" data-k="title" value="${UI.esc(n.title)}" spellcheck="false"></div>`;
    $('drBody').oninput = null; filterSettings();
    $('drBody').querySelector('[data-k="title"]').oninput = e => {
      n.title = e.target.value; elOf(n.id).querySelector('.nh b').textContent = n.title; $('drTitle').textContent = `${n.title} Settings`; save();
    };
    save();
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
  const hideSettings = () => { drawer.id = null; $('drawer').classList.remove('open'); save(); };   // clicked off a node: back with the next one
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
      el.querySelector('.port.out').classList.toggle('on', links.some(l => l.from === n.id));
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
    else if (!el.classList.contains('sel')) document.querySelectorAll('.node.sel').forEach(x => x.classList.remove('sel'));
    if (!e.ctrlKey && !e.metaKey) el.classList.add('sel');
    if (drawer.on && el.classList.contains('sel') && drawer.id !== n.id) openSettings(n);   // the open drawer follows the selected node
    save();
    st.setPointerCapture(e.pointerId);
    if (e.target.closest('.nx')) { deleteNode(n); return; }   // the red X (shown on hover)
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
          if (o === src || (want === 'in' && !hasIn(o))) continue;
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
    } else if (rz) {   // resize from an edge or corner (snaps to the grid; never smaller than WMIN x HMIN)
      const d = rz.dataset.dir, p0 = toGrid(e.clientX, e.clientY), b0 = { x: n.x, y: n.y, r: n.x + n.w, b: n.y + n.h };
      el.classList.add('drag');
      move = ev => {
        const p = toGrid(ev.clientX, ev.clientY), dx = p.x - p0.x, dy = p.y - p0.y;
        let { x, y, r, b } = b0;
        if (d.includes('w')) x = Math.min(snap(x + dx), r - WMIN);
        if (d.includes('e')) r = Math.max(snap(r + dx), x + WMIN);
        if (d.includes('n')) y = Math.min(snap(y + dy), b - HMIN);
        if (d.includes('s')) b = Math.max(snap(b + dy), y + HMIN);
        Object.assign(n, { x, y, w: r - x, h: b - y }); putNode(el, n); drawLinks();
      };
      done = () => el.classList.remove('drag');
    } else {   // move the node, or the whole selection with it (snaps to the grid with Snap to Grid on); wires follow
      if (!el.classList.contains('sel')) return;   // Ctrl + click just took it out of the selection
      const p0 = toGrid(e.clientX, e.clientY), x0 = n.x, y0 = n.y;
      const group = [...document.querySelectorAll('.node.sel')].map(g => ({ g, m: nodeOf(g.dataset.id) })).map(o => ({ ...o, x: o.m.x, y: o.m.y }));
      group.forEach(o => o.g.classList.add('drag'));
      move = ev => {
        const p = toGrid(ev.clientX, ev.clientY), dx = snap(x0 + p.x - p0.x) - x0, dy = snap(y0 + p.y - p0.y) - y0;   // the grabbed node snaps; the rest keep their places to it
        group.forEach(o => { o.m.x = o.x + dx; o.m.y = o.y + dy; putNode(o.g, o.m); });
        drawLinks();
      };
      done = () => group.forEach(o => o.g.classList.remove('drag'));
    }
    const up = () => { done(); st.removeEventListener('pointermove', move); st.removeEventListener('pointerup', up); st.removeEventListener('pointercancel', up); };
    st.addEventListener('pointermove', move); st.addEventListener('pointerup', up); st.addEventListener('pointercancel', up);
  });
  $('stage').addEventListener('pointerdown', e => { if (onGrid(e.target) && drawer.id) hideSettings(); if (onGrid(e.target) && document.querySelector('.node.sel')) { document.querySelectorAll('.node.sel').forEach(x => x.classList.remove('sel')); save(); } });

  // Shift + drag (anywhere on the grid, over nodes too): a selection box; a node with at least 50% of it inside is
  // selected, live. Ctrl as well keeps the nodes already selected.
  $('stage').addEventListener('pointerdown', e => {
    if (e.button !== 0 || !e.shiftKey || !(onGrid(e.target) || e.target.closest('.node'))) return;
    e.preventDefault(); e.stopPropagation();
    const st = $('stage'), r0 = st.getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY;
    const keep = e.ctrlKey || e.metaKey ? new Set([...document.querySelectorAll('.node.sel')]) : new Set();
    const box = document.createElement('div'); box.className = 'selbox'; st.append(box);
    st.setPointerCapture(e.pointerId);
    const move = ev => {
      const L = Math.min(x0, ev.clientX), T = Math.min(y0, ev.clientY), Rr = Math.max(x0, ev.clientX), B = Math.max(y0, ev.clientY);
      Object.assign(box.style, { left: `${L - r0.left}px`, top: `${T - r0.top}px`, width: `${Rr - L}px`, height: `${B - T}px` });
      for (const el of document.querySelectorAll('.node')) {
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
  function showPreview(on) { $('preview').hidden = false; glidePreview(on ? preview.h : 0); }
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
  $('pvTabs').onclick = e => {
    const t = e.target.closest('[data-tab]'); if (!t) return;
    preview.tab = t.dataset.tab; drawTabs(); save();
  };
  const drawTabs = () => $('pvTabs').querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === preview.tab));
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
  const state = () => ({ version: 1, view: { zoom, offX, offY }, drawer, preview, nodes, links, sel: [...document.querySelectorAll('.node.sel')].map(x => x.dataset.id), updated: new Date().toISOString() });
  function save() {
    if (!ctx) return;
    dirty = true; clearTimeout(saveT);
    saveT = setTimeout(flush, 150);
  }
  function flush() {
    if (!dirty || !ctx) return Promise.resolve();
    dirty = false; clearTimeout(saveT);
    return DNFS.writeJSON(FILE(), state()).catch(e => UI.toast(`Data Studio not saved: ${e.message}`, 'err'));
  }
  window.DNBeforeReload = flush;   // live reload (ui/js/core/live-reload.js): save first, reopen exactly as it was
  // Hot update: save, then stop everything this run started (listeners, timers, animations); the new code then starts
  // on fresh page elements and reads the saved state back, so only Data Studio is redrawn, never the whole window.
  window.DNHot = {
    async dispose() {
      await flush();
      offs.splice(0).forEach(f => f());
      clearTimeout(saveT); clearTimeout(hideT); cancelAnimationFrame(viewRaf); cancelAnimationFrame(zRaf); cancelAnimationFrame(glideRaf); cancelAnimationFrame(pvRaf);
      ctx = null;   // a late save from this run does nothing
    },
  };
  on(window, 'pagehide', flush);
  on(document, 'visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });

  try { ctx = await ModulePage.init('data_studio', 'Data Studio'); }
  catch (e) { UI.toast(e.message, 'err'); return; }
  const saved = await DNFS.readJSONOr(FILE(), null).catch(() => null);
  if (saved?.nodes) {
    nodes = saved.nodes; links = (saved.links || []).filter(l => { const t = nodes.find(m => m.id === l.to); return t && hasIn(t); });   // no wires into input nodes
    nodes.forEach(n => { n.w ??= W0; n.h ??= H0; });
    ({ zoom = 1, offX = 0, offY = 0 } = saved.view || {});
  }
  nodes.forEach(drawNode); drawLinks();
  [].concat(saved?.sel || []).forEach(id => elOf(id)?.classList.add('sel'));
  if (saved?.preview) { preview = { ...preview, ...saved.preview }; drawTabs(); if (prefs.preview) glidePreview(preview.h); }
  if (saved?.drawer) { drawer = { ...drawer, ...saved.drawer }; const n = nodeOf(drawer.id); if (drawer.id === STUDIO) openStudioSettings(); else if (drawer.id === NODES) openNodes(); else if (n) openSettings(n); else drawer.id = null; }
  applyView();
  $('types').onclick = e => {
    const t = e.target.closest('.type'); if (!t) return;
    const act = t.dataset.act;
    if (act === 'settings') drawer.id === STUDIO ? closeSettings() : openStudioSettings();
    else if (act === 'nodes') drawer.id === NODES ? closeSettings() : openNodes();
  };
})();
