// Data Studio (ui/html/data-studio.html): the project's workflow as draggable, connectable nodes on the 24px grid
// (Import, Transform, Dashboard, Publish, Archive, Update schedule). In development.
(async () => {
  const $ = id => document.getElementById(id);
  let ctx, saveT = 0, dirty = false;   // the project (once loaded); pending save of the studio state
  // Data Studio settings (this browser).
  const PREFS = 'dn-data-studio-prefs';
  let prefs = { grid: true, snap: true, barPos: 'Top', autoHide: false };
  try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem(PREFS) || '{}') }; } catch {}
  const savePrefs = () => { try { localStorage.setItem(PREFS, JSON.stringify(prefs)); } catch {} };
  const applyPrefs = () => {
    document.body.classList.toggle('nogrid', !prefs.grid);
    document.body.classList.toggle('barbottom', prefs.barPos === 'Bottom');
    hideSoon();
  };
  // Auto Hide: the icon bar fades out once the mouse has been off it for 2s.
  let hideT = 0, menu = null;
  function hideSoon() {
    clearTimeout(hideT); const bar = $('types');
    bar.classList.remove('faded');
    if (prefs.autoHide && !bar.matches(':hover') && !menu) hideT = setTimeout(() => { if (!menu && !bar.matches(':hover')) bar.classList.add('faded'); }, 2000);
  }
  const closeMenu = () => { menu?.remove(); menu = null; hideSoon(); };
  // Settings drop-down (A-Z): OFF | ON toggles, applied at once.
  function openPrefs(btn) {
    const pick = (k, label, choices) => `<div class="optrow"><span>${label}</span><select data-k="${k}">${choices.map(c => `<option ${prefs[k] === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>`;
    const row = (k, label) => `<div class="optrow"><span>${label}</span><span class="seg"><button type="button" data-k="${k}" data-on="0" class="${prefs[k] ? '' : 'on'}">OFF</button><button type="button" data-k="${k}" data-on="1" class="${prefs[k] ? 'on' : ''}">ON</button></span></div>`;
    menu = document.createElement('div'); menu.className = 'tmenu';
    menu.innerHTML = `<div class="tm-h">Data Studio</div>${row('autoHide', 'Auto Hide')}${pick('barPos', 'Icon Bar Position', ['Top', 'Bottom'])}${row('grid', 'Show Grid')}${row('snap', 'Snap to Grid')}`;
    menu.onchange = e => { const k = e.target.dataset?.k; if (!k) return; prefs[k] = e.target.value; savePrefs(); applyPrefs(); place(btn); };
    menu.onclick = e => {
      const b = e.target.closest('.seg button'); if (!b) return;
      prefs[b.dataset.k] = b.dataset.on === '1'; savePrefs(); applyPrefs();
      b.parentElement.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    };
    document.body.append(menu); menu._act = 'settings'; place(btn);
  }
  // Centred on its button, below it (above with the bar at the bottom).
  function place(btn) {
    const r = btn.getBoundingClientRect();
    menu.style.top = (prefs.barPos === 'Bottom' ? r.top - 6 - menu.offsetHeight : r.bottom + 6) + 'px';
    menu.style.left = Math.max(8, Math.min(r.left + r.width / 2 - menu.offsetWidth / 2, innerWidth - menu.offsetWidth - 8)) + 'px';
  }
  addEventListener('pointerdown', e => { if (menu && !menu.contains(e.target) && !e.target.closest('.type')) closeMenu(); }, true);
  addEventListener('keydown', e => { if (e.key === 'Escape' && menu) closeMenu(); });
  addEventListener('keydown', e => { if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r')) e.preventDefault(); });   // no refresh: the canvas would be lost
  $('types').addEventListener('pointerenter', () => { clearTimeout(hideT); $('types').classList.remove('faded'); });
  $('types').addEventListener('pointerleave', () => hideSoon());
  applyPrefs();

  // View: grid 0, 0 = the window centre at no scroll. offX / offY = how far grid 0, 0 has moved from the window centre (px).
  // Zoom (mouse wheel, about the cursor) and Scroll (drag the empty grid) move only the grid and its nodes, never the UI.
  const Z_MIN = 0.25, Z_MAX = 4;
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
    $('sReset').classList.toggle('off', !Math.round(offX) && !Math.round(offY));
  }
  $('stage').addEventListener('wheel', e => {
    if (e.target !== $('stage') && !$('nodes').contains(e.target)) return;   // only over the grid and its nodes, never over UI
    e.preventDefault();
    if (!e.deltaY) return;
    const z = Math.min(Z_MAX, Math.max(Z_MIN, (Math.round(zoom * 20) + (e.deltaY < 0 ? 1 : -1)) / 20));   // 5% a wheel step
    if (z === zoom) return;
    const r = $('stage').getBoundingClientRect(), mx = e.clientX - r.left - r.width / 2, my = e.clientY - r.top - r.height / 2;
    offX = mx - (mx - offX) * z / zoom; offY = my - (my - offY) * z / zoom; zoom = z;
    applyView();
  }, { passive: false });
  // Scroll: hold the left button on the empty grid and drag; the grid and every node follow the mouse.
  $('stage').addEventListener('pointerdown', e => {
    if (e.button !== 0 || !onGrid(e.target)) return;
    e.preventDefault();
    const st = $('stage'), x0 = e.clientX - offX, y0 = e.clientY - offY;
    st.setPointerCapture(e.pointerId); st.classList.add('grabbing');
    const move = ev => { offX = ev.clientX - x0; offY = ev.clientY - y0; applyView(); };
    const up = () => { st.classList.remove('grabbing'); st.removeEventListener('pointermove', move); st.removeEventListener('pointerup', up); st.removeEventListener('pointercancel', up); };
    st.addEventListener('pointermove', move); st.addEventListener('pointerup', up); st.addEventListener('pointercancel', up);
  });
  $('zReset').onclick = () => { offX /= zoom; offY /= zoom; zoom = 1; applyView(); };   // about the window centre
  $('sReset').onclick = () => { offX = 0; offY = 0; applyView(); };
  addEventListener('resize', applyView);
  applyView();

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
  let links = [];   // { from: node id (its out port), to: node id (its in port) }
  const snap = v => prefs.snap ? Math.round(v / G) * G : Math.round(v);
  const nodeOf = id => nodes.find(m => m.id === id), elOf = id => $('nodes').querySelector(`.node[data-id="${id}"]`);
  const multi = n => n.type === 'join';
  const ins = n => links.filter(l => l.to === n.id);
  const wires = document.createElementNS(NS, 'svg'); wires.id = 'wires'; $('nodes').append(wires);
  const DIRS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
  function drawNode(n) {
    const el = document.createElement('div');
    el.className = `node t-${n.type}`; el.dataset.id = n.id;
    el.innerHTML = `<div class="nh"><svg viewBox="0 0 24 24">${ICONS[n.type]}</svg><b>${UI.esc(n.title)}</b></div><div class="nb">${UI.esc(n.sub)}</div>`
      + '<span class="port in" data-port="in"></span><span class="port out" data-port="out"></span>' + DIRS.map(d => `<span class="rz ${d}" data-dir="${d}"></span>`).join('');
    $('nodes').append(el); putNode(el, n);
  }
  const putNode = (el, n) => { Object.assign(el.style, { left: `${n.x}px`, top: `${n.y}px`, width: `${n.w}px`, height: `${n.h}px` }); };
  const toGrid = (cx, cy) => { const r = $('stage').getBoundingClientRect(); return { x: (cx - r.left - r.width / 2 - offX) / zoom, y: (cy - r.top - r.height / 2 - offY) / zoom }; };
  // Port centres (grid px): the middle of the left (in) / right (out) edge.
  const portAt = (n, k) => ({ x: n.x + (k === 'out' ? n.w : 0), y: n.y + n.h / 2 });
  const SNAP_R = 36;   // screen px: a wire end within this of a port snaps to it
  function drawLinks() {
    save();
    for (const n of nodes) {
      const el = elOf(n.id);
      el.querySelector('.port.in').classList.toggle('on', ins(n).length > 0);
      el.querySelector('.port.out').classList.toggle('on', links.some(l => l.from === n.id));
    }
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
  $('nodes').addEventListener('pointerdown', e => {
    const el = e.target.closest('.node'); if (!el || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const n = nodeOf(el.dataset.id), st = $('stage');
    document.querySelectorAll('.node.sel').forEach(x => x.classList.toggle('sel', x === el)); el.classList.add('sel'); save();
    st.setPointerCapture(e.pointerId);
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
          if (o === src) continue;
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
    } else {   // move the node (snaps to the grid with Snap to Grid on)
      const p0 = toGrid(e.clientX, e.clientY), x0 = n.x, y0 = n.y;
      el.classList.add('drag');
      move = ev => { const p = toGrid(ev.clientX, ev.clientY); n.x = snap(x0 + p.x - p0.x); n.y = snap(y0 + p.y - p0.y); putNode(el, n); drawLinks(); };
      done = () => el.classList.remove('drag');
    }
    const up = () => { done(); st.removeEventListener('pointermove', move); st.removeEventListener('pointerup', up); st.removeEventListener('pointercancel', up); };
    st.addEventListener('pointermove', move); st.addEventListener('pointerup', up); st.addEventListener('pointercancel', up);
  });
  $('stage').addEventListener('pointerdown', e => { if (onGrid(e.target) && document.querySelector('.node.sel')) { document.querySelectorAll('.node.sel').forEach(x => x.classList.remove('sel')); save(); } });

  // ---- State: <project>/data-studio/studio.json = { version, view: { zoom, offX, offY }, nodes, links, sel }, written as it
  // changes (every move, wire, resize, zoom, scroll, selection), so the window reopens exactly as it was left. ----
  const FILE = () => `${ctx.dir}/data-studio/studio.json`;
  const state = () => ({ version: 1, view: { zoom, offX, offY }, nodes, links, sel: document.querySelector('.node.sel')?.dataset.id || null, updated: new Date().toISOString() });
  function save() {
    if (!ctx) return;
    dirty = true; clearTimeout(saveT);
    saveT = setTimeout(flush, 150);
  }
  function flush() {
    if (!dirty || !ctx) return;
    dirty = false; clearTimeout(saveT);
    DNFS.writeJSON(FILE(), state()).catch(e => UI.toast(`Data Studio not saved: ${e.message}`, 'err'));
  }
  addEventListener('pagehide', flush);
  addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });

  try { ctx = await ModulePage.init('data_studio', 'Data Studio'); }
  catch (e) { UI.toast(e.message, 'err'); return; }
  const saved = await DNFS.readJSONOr(FILE(), null).catch(() => null);
  if (saved?.nodes) {
    nodes = saved.nodes; links = saved.links || [];
    nodes.forEach(n => { n.w ??= W0; n.h ??= H0; });
    ({ zoom = 1, offX = 0, offY = 0 } = saved.view || {});
  }
  nodes.forEach(drawNode); drawLinks();
  if (saved?.sel) elOf(saved.sel)?.classList.add('sel');
  applyView();
  $('types').onclick = e => {
    const t = e.target.closest('.type'); if (!t) return;
    const act = t.dataset.act;
    if (menu) { const same = menu._act === act; closeMenu(); if (same) return; }
    if (act === 'settings') openPrefs(t);
  };
})();
