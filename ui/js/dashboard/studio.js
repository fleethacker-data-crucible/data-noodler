// Dashboard Studio (ui/html/dashboard-studio.html): the project's dashboard on the 24px grid. The bar at the top: widget
// category buttons (Column, Bar, ...: a drop-down of the app's packaged widgets, ui/widgets/<Category>/<id>/) and Custom
// (a drop-down: an empty container, this project's own widgets and the global library). A packaged or global widget is
// copied into the project first. Each drop-down: a search box + a 4-wide grid of buttons. Right-click a container > Edit opens the Widget
// Editor (ui/js/dashboard/widget-editor.js). Containers move (drag) and resize (handles of the selected one).
// State: <project>/dashboard/dashboard.json = { version: 4, widgets: [{ id, widget, x, y, w, h, z, dataset, inputs: { <key>: { col, agg } } }] }
//   widget = the folder in <project>/dashboard/widgets/ (null = an empty Custom Widget container). Read by Publish.
(() => {
  const { $, esc } = UI;
  const COLS = 48, G = 24, SIZE = [16, 10], MIN = [4, 3], TOP = 0;   // TOP: rows kept free at the top (none: drag anywhere)
  // The category buttons: billboard.js chart families (ui/widgets/<Category>/<id>/) + Table (the app's Data Grid).
  const PLACEHOLDERS = [
    ['Line', '<polyline points="3,18 8,11 13,14 21,5" fill="none" stroke="currentColor" stroke-width="2"/>'],
    ['Area', '<path d="M3 20 L3 14 L8 9 L13 12 L21 5 L21 20 Z"/>'],
    ['Bar', '<rect x="3" y="11" width="4" height="10"/><rect x="10" y="5" width="4" height="16"/><rect x="17" y="8" width="4" height="13"/>'],
    ['Scatter', '<circle cx="6" cy="16" r="2"/><circle cx="10" cy="9" r="2"/><circle cx="15" cy="13" r="2"/><circle cx="19" cy="6" r="2"/>'],
    ['Bubble', '<circle cx="8" cy="14" r="4" opacity=".7"/><circle cx="16" cy="8" r="3" opacity=".7"/><circle cx="17" cy="17" r="2" opacity=".7"/>'],
    ['Pie', '<path d="M12 3 A9 9 0 1 1 3 12 L12 12 Z"/><path d="M12 3 L12 12 L3 12 A9 9 0 0 1 12 3" opacity=".5"/>'],
    ['Donut', '<path d="M12 3 A9 9 0 1 1 3 12 L7 12 A5 5 0 1 0 12 7 Z"/><path d="M12 3 L12 7 A5 5 0 0 0 7 12 L3 12 A9 9 0 0 1 12 3" opacity=".5"/>'],
    ['Gauge', '<path d="M3 17 A9 9 0 0 1 21 17 L17 17 A5 5 0 0 0 7 17 Z" opacity=".5"/><path d="M3 17 A9 9 0 0 1 14 8.3 L13 12.2 A5 5 0 0 0 7 17 Z"/>'],
    ['Radar', '<polygon points="12,3 20,9 17,19 7,19 4,9" fill="none" stroke="currentColor" stroke-width="1.5"/><polygon points="12,7 16,10 15,16 9,15 7,10" opacity=".7"/>'],
    ['Polar', '<path d="M12 12 L12 3 A9 9 0 0 1 20 9 Z"/><path d="M12 12 L19 14 A7 7 0 0 1 11 19 Z" opacity=".7"/><path d="M12 12 L8 16 A5 5 0 0 1 8 8 Z" opacity=".5"/>'],
    ['Funnel', '<path d="M3 4 H21 L18 9 H6 Z"/><path d="M7 11 H17 L15 15 H9 Z" opacity=".75"/><path d="M10 17 H14 L13 20 H11 Z" opacity=".5"/>'],
    ['Treemap', '<rect x="3" y="3" width="10" height="11"/><rect x="14" y="3" width="7" height="6" opacity=".7"/><rect x="14" y="10" width="7" height="11" opacity=".5"/><rect x="3" y="15" width="10" height="6" opacity=".6"/>'],
    ['Candlestick', '<line x1="7" y1="3" x2="7" y2="21" stroke="currentColor" stroke-width="1.5"/><rect x="5" y="7" width="4" height="9"/><line x1="16" y1="5" x2="16" y2="19" stroke="currentColor" stroke-width="1.5"/><rect x="14" y="9" width="4" height="6" opacity=".5"/>'],
    ['Combination', '<rect x="3" y="12" width="4" height="9" opacity=".6"/><rect x="10" y="8" width="4" height="13" opacity=".6"/><rect x="17" y="14" width="4" height="7" opacity=".6"/><polyline points="3,10 10,5 17,9 21,4" fill="none" stroke="currentColor" stroke-width="2"/>'],
    ['Table', '<rect x="3" y="4" width="18" height="16" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3 9 H21 M3 14 H21 M9 4 V20 M15 4 V20" stroke="currentColor" stroke-width="1.2"/>'],
  ];
  const ICON_CUSTOM = '<rect x="3" y="3" width="18" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 8v8M8 12h8" stroke="currentColor" stroke-width="2"/>';
  const ICON_GEAR = '<path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
  // Dashboard Studio settings (this browser): grid shown, containers snap to it.
  const PREFS = 'dn-studio-prefs';
  let prefs = { grid: true, snap: true, barPos: 'Top', autoHide: false, aspect: '16:9', frame: false };
  try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem(PREFS) || '{}') }; } catch {}
  const savePrefs = () => { try { localStorage.setItem(PREFS, JSON.stringify(prefs)); } catch {} };
  const applyPrefs = () => {
    document.body.classList.toggle('nogrid', !prefs.grid);
    document.body.classList.toggle('barbottom', prefs.barPos === 'Bottom');
    if (typeof refit === 'function') refit();
    hideSoon();
  };
  // Auto Hide: the icon bar fades out (0.5s) once the mouse has been off it for 2s; back as soon as the mouse is over it.
  let hideT = 0;
  function hideSoon() {
    clearTimeout(hideT); const bar = document.getElementById('types'); if (!bar) return;
    bar.classList.remove('faded');
    if (prefs.autoHide && !bar.matches(':hover') && !menu) hideT = setTimeout(() => { if (!menu && !bar.matches(':hover')) bar.classList.add('faded'); }, 2000);
  }
  const R = v => prefs.snap ? Math.round(v) : Math.round(v * 24) / 24;   // grid cells, or single pixels with snap off
  const ICON_WIDGET = '<rect x="3" y="3" width="18" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7 16l3-4 3 2 4-6" fill="none" stroke="currentColor" stroke-width="2"/>';

  let ctx, dash = { version: 4, widgets: [] }, selId = null, OX = 0, OY = 0, GX = 24, GY = 24;
  let pkgs = new Map(), globals = [], packaged = {}, clean = [];
  const PACKAGED = 'ui/widgets';   // shipped with the app: ui/widgets/<Category>/<id>/ (the folder name = the button)
  const results = new Map();   // container id -> rows (redraw on resize without a query)
  // Filter widgets (settings.json "filter": true; every chart is one too: a click filters): container id -> { dataset, col, values, ranges, detail }. A widget fires
  // 'dn-filter' ({ input, values, ranges: [{ min, max }], state }; detail is handed back to it on redraw); the containers it is linked to (w.links = [ids] | 'page', saved; right-click > Link) are queried
  // again with those values. A target on another dataset is filtered only if it has a column of the same name.
  // The picked values are this session only.
  const filters = new Map();
  const isFilter = w => { try { return JSON.parse(pkgs.get(w?.widget)?.settings || '{}').filter === true; } catch { return false; } };
  const linked = (fw, x) => !!fw && x !== fw && (fw.links === 'page' || (Array.isArray(fw.links) && fw.links.includes(x.id)));
  const hasCol = (x, col) => !!x.dataset && (dsOf(x.dataset)?.columns || []).some(c => c.name === col);
  const whereFor = w => Widgets.where([...filters].filter(([id, f]) => linked(byId(id), w) && (f.dataset === w.dataset || hasCol(w, f.col))).map(([, f]) => f));
  const byId = id => dash.widgets.find(w => w.id === id);
  const cardOf = w => $('cards').querySelector(`.card[data-id="${w.id}"]`);
  const FILE = () => `${ctx.dir}/dashboard/dashboard.json`;
  const dsOf = name => clean.find(d => d.name === name);
  const saveNow = async () => { dash.updated = new Date().toISOString(); await DNFS.writeJSON(FILE(), dash); };
  const save = UI.debounce(() => saveNow().catch(e => UI.toast(`Could not save the dashboard: ${e.message}`, 'err')), 400);

  async function loadPkgs() {
    const [mine, glob, ...cats] = await Promise.all([Widgets.list(Widgets.projectDir(ctx)), Widgets.list(Widgets.GLOBAL),
      ...PLACEHOLDERS.map(([c]) => Widgets.list(`${PACKAGED}/${c}`))]);
    pkgs = new Map(mine.map(p => [p.id, p])); globals = glob;
    packaged = Object.fromEntries(PLACEHOLDERS.map(([c], i) => [c, cats[i]]));
    // Copies of built-in charts (this project's, the global library's) pick up the charts' current settings.
    await Widgets.syncBuiltins([...mine, ...glob], cats.flat());
  }
  const loadClean = async () => { clean = (await Projects.sourceDatasets(ctx.folder, ctx.cfg)).filter(d => /^CLEAN_/i.test(d.name)); };

  // ---- the bar: categories (placeholders), Custom Widget, this project's widgets, the global library ----
  const tile = (attrs, icon, label, tip, cls = '') => `<div class="type ${cls}" ${attrs} title="${esc(tip)}"><svg viewBox="0 0 24 24">${icon}</svg><span>${esc(label)}</span></div>`;
  const shipped = () => new Set(Object.values(packaged).flat().map(p => p.id));
  function drawTypes() {
    $('types').innerHTML = PLACEHOLDERS.map(([l, i]) => tile(`data-cat="${esc(l)}"`, i, l, packaged[l]?.length ? `${l}: ${packaged[l].length} widget(s)` : `${l}: none yet (put them in ${PACKAGED}/${l}/)`, packaged[l]?.length ? '' : 'off')).join('')
      + tile('data-cat="__custom"', ICON_CUSTOM, 'Custom', 'An empty container, this project\'s widgets and the global library', 'custom')
      + tile('data-cat="__settings"', ICON_GEAR, 'Settings', 'Dashboard Studio settings', 'gear');
  }
  // The drop-down under a category button: a search box (titles) + a 4-wide grid of the widgets.
  let menu = null;
  const closeMenu = () => { menu?.remove(); menu = null; hideSoon(); };
  addEventListener('pointerdown', e => { if (menu && !menu.contains(e.target) && !e.target.closest('.type, .dd-list')) closeMenu(); }, true);
  addEventListener('keydown', e => { if (e.key === 'Escape' && menu) closeMenu(); });
  function openMenu(btn, cat) {
    closeMenu();
    if (cat === '__settings') return openPrefs(btn);
    const items = cat === '__custom'
      ? [{ act: 'custom', icon: ICON_CUSTOM, name: 'New', tip: 'Add an empty widget container (right-click it > Edit)', cls: 'custom' },
        ...[...pkgs.values()].map(p => ({ proj: p.id, icon: ICON_WIDGET, name: p.name, tip: `${p.name} (this project): add it` })),
        ...globals.filter(g => !pkgs.has(g.id)).map(g => ({ src: g.dir, id: g.id, icon: ICON_WIDGET, name: g.name, tip: `${g.name} (global library): copy it into this project and add it`, cls: 'glob' }))]
      : packaged[cat].map(p => { const icon = PLACEHOLDERS.find(([c]) => c === cat)?.[1] || ICON_WIDGET, cls = 'bb';
        return pkgs.has(p.id) ? { proj: p.id, icon, name: p.name, tip: `${p.name}: add it`, cls }
          : { src: p.dir, id: p.id, icon, name: p.name, tip: `${p.name}: copy it into this project and add it`, cls }; });
    menu = document.createElement('div'); menu.className = 'tmenu';
    menu._items = items;
    const tiles = list => list.map(it => tile(`data-k="${items.indexOf(it)}" data-n="${esc(it.name.toLowerCase())}"`, it.icon, it.name, it.tip, it.cls || '')).join('');
    const body = `<div class="tm-grid">${tiles(items)}</div>`;
    menu.innerHTML = `<input class="tm-q" type="search" placeholder="Search" spellcheck="false">${body}<div class="tm-none" hidden>No match</div>`;
    document.body.append(menu);
    const r = btn.getBoundingClientRect();
    menu.style.top = (prefs.barPos === 'Bottom' ? r.top - 6 - menu.offsetHeight : r.bottom + 6) + 'px'; menu.style.left = Math.max(8, Math.min(r.left + r.width / 2 - menu.offsetWidth / 2, innerWidth - menu.offsetWidth - 8)) + 'px';   // centred on its button
    const q = menu.querySelector('.tm-q'); q.focus();
    q.oninput = () => { const t = q.value.trim().toLowerCase(); let n = 0;
      menu.querySelectorAll('.tm-grid .type').forEach(el => { el.hidden = !!t && !el.dataset.n.includes(t); n += !el.hidden; });
      menu.querySelector('.tm-none').hidden = n > 0; };
    menu.onclick = UI.guard(async e => {
      const it = items[e.target.closest('.type')?.dataset.k]; if (!it) return;
      const cat = menu?._cat; closeMenu();
      if (it.act === 'custom') return editPkg(null);   // New: the editor, set up for a new chart
      const builtin = cat !== '__custom' || undefined;
      if (it.proj) return addContainer(it.proj, builtin);
      await Widgets.copy(it.src, `${Widgets.projectDir(ctx)}/${it.id}`);
      ctx.log(`Widget copied into the project: ${it.name}`);
      await loadPkgs(); drawTypes(); addContainer(it.id, builtin);
    });
  }
  // Studio settings drop-down: OFF | ON toggles, applied at once.
  function openPrefs(btn) {
    const pick = (k, label, choices) => `<div class="optrow"><span>${label}</span><select class="pick" data-k="${k}">${choices.map(c => `<option ${prefs[k] === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>`;
    const row = (k, label) => `<div class="optrow"><span>${label}</span><span class="seg"><button type="button" data-k="${k}" data-on="0" class="${prefs[k] ? '' : 'on'}">OFF</button><button type="button" data-k="${k}" data-on="1" class="${prefs[k] ? 'on' : ''}">ON</button></span></div>`;
    menu = document.createElement('div'); menu.className = 'tmenu prefs';
    menu.innerHTML = `<div class="tm-h">Dashboard Studio</div>${row('frame', 'Aspect Boundary')}${pick('aspect', 'Aspect Ratio', ['16:9', '4:3'])}${row('autoHide', 'Auto Hide')}${pick('barPos', 'Icon Bar Position', ['Top', 'Bottom'])}${row('grid', 'Show Grid')}${row('snap', 'Snap to Grid')}`;
    menu.onchange = e => { const k = e.target.dataset?.k; if (!k) return; prefs[k] = e.target.value; savePrefs(); applyPrefs(); };
    document.body.append(menu);
    const r = btn.getBoundingClientRect();
    menu.style.top = (prefs.barPos === 'Bottom' ? r.top - 6 - menu.offsetHeight : r.bottom + 6) + 'px'; menu.style.left = Math.max(8, Math.min(r.left + r.width / 2 - menu.offsetWidth / 2, innerWidth - menu.offsetWidth - 8)) + 'px';   // centred on its button
    menu.onclick = e => {
      const b = e.target.closest('.seg button'); if (!b) return;
      prefs[b.dataset.k] = b.dataset.on === '1'; savePrefs(); applyPrefs();
      b.parentElement.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    };
  }
  // Custom: right-click a widget > Delete. Moves its folder to _trash/ beside it (hidden from every list; built-in copies
  // under the category buttons are never touched). Containers using it then show "not found".
  addEventListener('contextmenu', e => {
    const t = e.target.closest('.tmenu .type'); if (!t || menu?._cat !== '__custom') return;
    const it = menu._items?.[t.dataset.k]; if (!it || it.act) return;
    e.preventDefault(); e.stopPropagation();
    document.querySelector('.tm-ctx')?.remove();
    const m = Object.assign(document.createElement('div'), { className: 'dd-menu ctxmenu open tm-ctx' });
    m.innerHTML = '<div data-act="edit">Edit<small>Open it in the Widget Editor</small></div><div data-act="del" class="danger last">Delete<small>Move it to the trash (only this Custom copy)</small></div>';
    document.body.append(m);
    m.style.left = `${Math.min(e.clientX, innerWidth - m.offsetWidth - 4)}px`; m.style.top = `${Math.min(e.clientY, innerHeight - m.offsetHeight - 4)}px`;
    const off = ev => { if (!m.contains(ev.target)) { m.remove(); removeEventListener('pointerdown', off, true); } };
    addEventListener('pointerdown', off, true);
    m.onclick = UI.guard(async ev => {
      const act = ev.target.closest('[data-act]')?.dataset.act; if (!act) return;
      m.remove(); removeEventListener('pointerdown', off, true);
      if (act === 'edit') { closeMenu(); return editPkg(it.proj ? pkgs.get(it.proj) : globals.find(g => g.id === it.id)); }
      const glob = !!it.src, root = glob ? Widgets.GLOBAL : Widgets.projectDir(ctx), id = it.proj || it.id;
      const used = glob ? 0 : dash.widgets.filter(w => w.widget === id).length;
      if (!await UI.confirm(`Delete "${it.name}" from ${glob ? 'the global library' : 'this project'}?${used ? ` ${used} container(s) on this dashboard use it.` : ''} It goes to ${root}/_trash/.`, { danger: true, ok: 'Delete' })) return;
      await DNFS.move(`${root}/${id}`, `${root}/_trash/${id}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      ctx.log(`Widget moved to the trash: ${it.name}`);
      closeMenu(); await loadPkgs(); drawTypes(); dash.widgets.filter(w => w.widget === id).forEach(paint);
    });
  }, true);
  $('types').addEventListener('pointerenter', () => { clearTimeout(hideT); $('types').classList.remove('faded'); });
  $('types').addEventListener('pointerleave', () => hideSoon());
  $('types').onclick = e => {
    const t = e.target.closest('.type'); if (!t || t.classList.contains('off')) return;
    if (menu && menu._cat === t.dataset.cat) return closeMenu();
    openMenu(t, t.dataset.cat); menu._cat = t.dataset.cat;
  };

  // ---- drawing a container ----
  async function paint(w) {
    const card = cardOf(w); if (!card) return;
    const pv = card.querySelector('.pv'), p = pkgs.get(w.widget);
    const note = (h, err) => { pv.className = 'pv'; pv.innerHTML = `<div class="note ${err ? 'err' : ''}">${h}</div>`; };
    if (!w.widget) return note('Custom Widget<br><small>Right-click > Edit</small>');
    if (!p) return note(`Widget "${esc(w.widget)}" not found in dashboard/widgets/. Right-click > Edit, or delete it.`, true);
    const d = paged(p) ? dsOf(w.dataset) : null, source = d ? { dataset: d, where: whereFor(w) } : null;
    try { await Widgets.draw(pv, { ...p, key: p.id }, results.get(w.id) || [], undefined, { filter: filters.get(w.id)?.detail || null, links: w.inputs || {}, source }); }
    catch (e) { note(esc(String(e.message || e).split('\n')[0]), true); }
  }
  // Tables of plain columns page their rows from the engine themselves (DNTable + GridRemote, 1,000 at a time): no query here.
  const paged = p => { try { const s = Widgets.parse(p.settings); return s.chart === 'table' && !(s.inputs || []).some(i => i.role === 'measure'); } catch { return false; } };
  let queue = Promise.resolve();
  function draw(w) {
    queue = queue.then(async () => {
      results.delete(w.id);
      const p = pkgs.get(w.widget), d = dsOf(w.dataset);
      if (p && d && !paged(p)) {
        try { const s = Widgets.parse(p.settings); if (Widgets.ready(s.inputs, w.inputs || {})) { await Engine.memory.load([d.path]).catch(() => {}); results.set(w.id, await Widgets.load(s.inputs, w.inputs || {}, d, whereFor(w))); } }
        catch (e) { ctx.log(`${p.name}: ${String(e.message || e).split('\n')[0]}`, 'warn'); }
      }
      await paint(w);
    });
    return queue;
  }
  const refilter = w => dash.widgets.filter(x => linked(w, x)).forEach(draw);
  $('cards').addEventListener('dn-filter', e => {
    const w = byId(e.target.closest('.card')?.dataset.id); if (!w) return;
    const d = e.detail || {}, col = w.inputs?.[d.input]?.col, values = Array.isArray(d.values) ? d.values : [], ranges = Array.isArray(d.ranges) ? d.ranges : [];
    if (col && (values.length || ranges.length)) filters.set(w.id, { dataset: w.dataset, col, values, ranges, detail: d });
    else if (col && d.state) filters.set(w.id, { dataset: w.dataset, col, values: [], ranges: [], detail: d });   // nothing picked, but keep its view
    else filters.delete(w.id);
    refilter(w);
  });
  let rpFrame = 0; const rpSet = new Set();
  const repaintSoon = w => { rpSet.add(w); if (!rpFrame) rpFrame = requestAnimationFrame(() => { rpFrame = 0; const s = [...rpSet]; rpSet.clear(); s.forEach(paint); }); };

  // ---- the stage: a grid line locked to the centre; containers keep their columns counted from it ----
  // Aspect Boundary on: a box of the chosen aspect, as big as fits, centred horizontally, its top 25px under the icon
  // bar (bottom bar: 25px above it); widgets stay inside it. Off: the box is the whole stage.
  let BOX = { x: 0, y: 0, w: 0, h: 0, cols: 0, rows: 0 };
  function fitGrid() {
    const st = $('stage'), W = st.clientWidth, H = st.clientHeight;
    let b = { x: 0, y: 0, w: W, h: H };
    if (prefs.frame) {
      const sr = st.getBoundingClientRect(), tr = $('types')?.getBoundingClientRect(), M = 25;
      const top = prefs.barPos === 'Bottom' ? M : (tr ? tr.bottom - sr.top : 0) + M;
      const bottom = prefs.barPos === 'Bottom' ? (tr ? tr.top - sr.top : H) - M : H - M;
      const [ax, ay] = prefs.aspect === '4:3' ? [4, 3] : [16, 9], aw = W - 2 * M, ah = Math.max(40, bottom - top);
      const s = Math.min(aw / ax, ah / ay); b = { w: ax * s, h: ay * s }; b.x = (W - b.w) / 2; b.y = top;
    }
    // Cells as close to G px as possible, a whole (even) number of columns / rows filling the box exactly.
    const cols = Math.max(2, 2 * Math.round(b.w / (2 * G))), rows = Math.max(1, Math.round(b.h / G)), gx = b.w / cols, gy = b.h / rows;
    st.style.setProperty('--gw', `${gx}px`); st.style.setProperty('--gh', `${gy}px`); st.style.setProperty('--gp', `${b.x}px ${b.y}px`);
    const fr = $('frame'); fr.hidden = !prefs.frame; Object.assign(fr.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w + 1}px`, height: `${b.h + 1}px` });
    const ox = b.x + b.w / 2 - (COLS / 2) * gx;
    BOX = { ...b, cols, rows, x0: COLS / 2 - cols / 2 };
    if (ox === OX && b.y === OY && gx === GX && gy === GY) return false;
    OX = ox; OY = b.y; GX = gx; GY = gy; return true;
  }
  // Inside the boundary (only while it is on).
  function inBox(w) {
    if (!prefs.frame) return w;
    w.w = Math.min(w.w, BOX.cols); w.h = Math.min(w.h, BOX.rows);
    w.x = Math.min(Math.max(w.x, BOX.x0), BOX.x0 + BOX.cols - w.w); w.y = Math.min(Math.max(w.y, 0), BOX.rows - w.h);
    return w;
  }
  function refit() { if (fitGrid()) dash.widgets.forEach(w => { const e = cardOf(w); if (e) { place(e, w); repaintSoon(w); } }); }
  function place(el, w) {
    el.style.zIndex = w.z || 1;
    Object.assign(el.style, { left: `${OX + w.x * GX}px`, top: `${OY + w.y * GY}px`, width: `${w.w * GX + 1}px`, height: `${w.h * GY + 1}px` });
    const sz = el.querySelector?.('.sz'); if (sz) sz.textContent = `${Math.round(w.w * GX)} x ${Math.round(w.h * GY)} px`;
    if (w.id === qId && DataWindow.isOpen()) qSlots();
  }
  const RZ = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map(d => `<div class="rz ${d}" data-dir="${d}"></div>`).join('');
  function cardEl(w) {
    const el = document.createElement('div');
    el.className = 'card' + (w.id === selId ? ' sel' : ''); el.dataset.id = w.id;
    el.innerHTML = `<div class="pv"></div>${RZ}<div class="sz"></div>`;
    place(el, w);
    return el;
  }
  const clamp = w => { w.w = Math.max(MIN[0], R(w.w)); w.h = Math.max(MIN[1], R(w.h)); w.x = R(w.x); w.y = Math.max(TOP, R(w.y)); return w; };
  function fitHint() {
    $('cards').querySelector('.hint')?.remove();
    if (!dash.widgets.length) $('cards').insertAdjacentHTML('beforeend', '<div class="hint">Empty dashboard. Custom Widget (top) adds a widget container.</div>');
  }
  function renderAll() {
    $('cards').querySelectorAll('.card').forEach(e => e.remove());
    for (const w of dash.widgets) $('cards').append(cardEl(w));
    fitHint();
    for (const w of dash.widgets) draw(w);
  }
  { const ro = new ResizeObserver(refit); ro.observe($('stage')); if ($('types')) ro.observe($('types')); }   // the bar too: the boundary sits under it

  // Resize: within EDGE px (as the Settings / Data windows) of a container's edge or corner; the cursor shows it.
  // Resize zone: 5px either side of a container's border (the blue line); the selected one first, then the top-most.
  const RZB = 5;
  function edgeHit(e) {
    if (e.target.closest?.('.typebar, .tmenu, aside, .dwin')) return null;
    const els = [...$('cards').querySelectorAll('.card')].sort((a, b) => b.classList.contains('sel') - a.classList.contains('sel') || (+b.style.zIndex || 0) - (+a.style.zIndex || 0));
    for (const el of els) {
      const r = el.getBoundingClientRect(), x = e.clientX, y = e.clientY;
      if (x < r.left - RZB || x > r.right + RZB || y < r.top - RZB || y > r.bottom + RZB) continue;
      const dir = (Math.abs(y - r.top) <= RZB ? 'n' : Math.abs(y - r.bottom) <= RZB ? 's' : '') + (Math.abs(x - r.left) <= RZB ? 'w' : Math.abs(x - r.right) <= RZB ? 'e' : '');
      if (dir) return { el, dir };
      return null;   // inside a container, away from its border
    }
    return null;
  }
  $('stage').addEventListener('pointermove', e => {
    if (e.buttons) return; const c = CUR[edgeHit(e)?.dir];
    document.body.classList.toggle('rzcur', !!c); if (c) document.body.style.setProperty('--rzc', c);
  });
  $('stage').addEventListener('pointerleave', () => document.body.classList.remove('rzcur'));
  // Move (drag) / resize (edges), snapped to the grid. A press selects.
  $('stage').addEventListener('pointerdown', ev => {
    const hit = ev.button === 0 ? edgeHit(ev) : null;
    const el = hit?.el || ev.target.closest('#cards .card'); if (!el || ev.button !== 0) return;
    if (!hit && ev.target.closest('input, select, button, textarea, a')) return;   // a widget's own controls
    ev.stopImmediatePropagation();
    const w = byId(el.dataset.id), dir = hit?.dir || null;   // on the border (5px either side): resize
    ev.preventDefault();
    if (selId !== w.id) select(w.id);   // selected on the press itself (no wait for the release)
    const sx = ev.clientX, sy = ev.clientY, start = { ...w }, ghost = Object.assign(document.createElement('div'), { className: 'ghostbox' });
    let moved = false;
    const onMove = e => {
      if (!moved && Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) < 4) return;
      if (!moved) { moved = true; el.classList.add('moving'); }
      const dx = R((e.clientX - sx) / GX), dy = R((e.clientY - sy) / GY);
      if (!dir) {
        // The chart itself moves: its top-left corner snaps to the top-left of the grid cell it is over (Snap to Grid off:
        // every pixel).
        const fx = start.x + (e.clientX - sx) / GX, fy = start.y + (e.clientY - sy) / GY, S = (v, g) => prefs.snap ? Math.floor(v) : Math.round(v * g) / g;
        w.x = S(fx, GX); w.y = Math.max(TOP, S(fy, GY)); inBox(w);
        place(el, w);
      } else {
        const right = start.x + start.w, bottom = start.y + start.h;
        let x = start.x, y = start.y, x2 = right, y2 = bottom;
        if (dir.includes('e')) x2 = Math.max(start.x + MIN[0], right + dx);
        if (dir.includes('w')) x = Math.min(right - MIN[0], start.x + dx);
        if (dir.includes('s')) y2 = Math.max(start.y + MIN[1], bottom + dy);
        if (dir.includes('n')) y = Math.max(TOP, Math.min(bottom - MIN[1], start.y + dy));
        if (prefs.frame) { x = Math.max(x, BOX.x0); y = Math.max(y, 0); x2 = Math.min(x2, BOX.x0 + BOX.cols); y2 = Math.min(y2, BOX.rows); }
        Object.assign(w, { x, y, w: x2 - x, h: y2 - y });
        place(el, w); repaintSoon(w);
      }
    };
    const onUp = () => {
      removeEventListener('pointermove', onMove); removeEventListener('pointerup', onUp);
      ghost.remove(); el.classList.remove('moving'); place(el, w);
      if (!moved) return;
      save();
    };
    addEventListener('pointermove', onMove); addEventListener('pointerup', onUp);
  });
  $('stage').addEventListener('pointerdown', ev => { if (!ev.target.closest('.card, .typebar') && ev.button === 0) select(null); });
  function toFront(w) {
    if (!w || dash.widgets.every(x => x === w || (x.z || 0) < (w.z || 0))) return;
    [...dash.widgets.filter(x => x !== w).sort((a, b) => (a.z || 0) - (b.z || 0)), w].forEach((x, i) => { x.z = i + 1; const e = cardOf(x); if (e) e.style.zIndex = x.z; });
    save();
  }
  function select(id) {
    selId = id; toFront(byId(id));
    $('cards').querySelectorAll('.card').forEach(e => e.classList.toggle('sel', e.dataset.id === id));
    if (!id) { $('dSet').hidden = true; DataWindow.close(); }   // no chart selected: Settings and Data go
  }

  // ---- add / delete ----
  // builtin: placed from a category button (a chart shipped with the app): only its settings can change, never its code.
  const addContainer = UI.guard(async (widget, builtin) => {
    const w = inBox(clamp({ id: crypto.randomUUID().slice(0, 8), widget, x: (COLS - SIZE[0]) / 2, y: Math.max(TOP, Math.floor(((prefs.frame ? BOX.rows : $('stage').clientHeight / GY) - SIZE[1]) / 2)), w: SIZE[0], h: SIZE[1], dataset: '', inputs: {}, ...(builtin ? { builtin: true } : {}) }));
    const used = dash.widgets.filter(o => o.x === w.x && o.y === w.y).length; w.x += used * 2; w.y += used * 2;   // not exactly on top of another
    dash.widgets.push(w); await saveNow();
    $('cards').append(cardEl(w)); fitHint(); select(w.id); draw(w);
    ctx.log(widget ? `Widget added: ${pkgs.get(widget)?.name || widget}` : 'Custom Widget container added');
  });
  const delContainer = UI.guard(async w => {
    const name = pkgs.get(w.widget)?.name || 'this Custom Widget';
    if (!await UI.confirm(`Delete ${name} from the dashboard? (Its widget files stay in dashboard/widgets/.)`, { danger: true, ok: 'Delete' })) return;
    dash.widgets = dash.widgets.filter(x => x !== w); results.delete(w.id);
    if (filters.delete(w.id)) refilter(w);
    for (const x of dash.widgets) if (Array.isArray(x.links)) x.links = x.links.filter(id => id !== w.id);
    cardOf(w)?.remove(); select(null); fitHint(); await saveNow();
    ctx.log(`Widget container deleted: ${name}`);
  });

  // ---- right-click menu ----
  let ctxId = null;
  $('cards').addEventListener('contextmenu', ev => {
    const el = ev.target.closest('.card'); if (!el) return;
    ev.preventDefault(); ctxId = el.dataset.id; select(ctxId);
    const m = $('ctxmenu'); Menus.closeAll(); m.classList.add('open');
    m.querySelector('[data-act="edit"]').classList.toggle('off', !!byId(ctxId)?.builtin);   // built-in: settings only
    m.querySelector('[data-act="link"]').hidden = !isFilter(byId(ctxId));
    m.style.left = `${Math.max(0, Math.min(ev.clientX, innerWidth - m.offsetWidth - 4))}px`; m.style.top = `${Math.max(0, Math.min(ev.clientY, innerHeight - m.offsetHeight - 4))}px`;
  });
  addEventListener('contextmenu', e => { if (!e.target.closest('input, textarea, .sqled')) e.preventDefault(); });   // no browser menu
  addEventListener('pointerdown', e => { if (!e.target.closest('#ctxmenu')) $('ctxmenu').classList.remove('open'); }, true);
  addEventListener('blur', () => $('ctxmenu').classList.remove('open'));
  $('ctxmenu').onclick = ev => {
    const act = ev.target.closest('[data-act]')?.dataset.act, w = byId(ctxId); if (!act || !w) return;
    $('ctxmenu').classList.remove('open');
    if (act === 'edit') { if (w.builtin) return UI.toast('A built-in chart: only its Settings can change.', 'warn'); edit(w); } else if (act === 'delete') delContainer(w);
    else if (act === 'settings') quickSettings(w);
    else if (act === 'link') linkMode(w);
  };

  // ---- Link (right-click a filter > Link): an overlay over the dashboard. Green cross = the filter, orange = the other
  // widgets, pink (centre) = the whole page. Drag the green cross onto one: that link is made. Each link is a line with a
  // red trash can in its middle (click = unlink). Esc or a click on the empty overlay closes it.
  const LINK = { r: 18, orange: '#f28c28', green: 'var(--ok)', pink: 'var(--pink)', red: 'var(--err)' };
  let linkEnd = null;
  function linkMode(fw) {
    linkEnd?.();
    const stage = $('stage'), svg = d3.select($('cards')).append('svg').attr('class', 'linkov');
    const mid = x => ({ x: OX + (x.x + x.w / 2) * GX, y: OY + (x.y + x.h / 2) * GY });
    const col = () => fw.inputs?.value?.col || Object.values(fw.inputs || {})[0]?.col;
    const fits = x => !col() || !x.dataset || !fw.dataset || x.dataset === fw.dataset || hasCol(x, col());
    const cross = (g, c, size = LINK.r) => {
      g.append('circle').attr('r', size).attr('fill', c);
      g.append('path').attr('d', `M${-size / 2} 0H${size / 2}M0 ${-size / 2}V${size / 2}`).attr('stroke', '#fff').attr('stroke-width', 4).attr('stroke-linecap', 'round');
    };
    const relink = async (targets) => { await saveNow(); if (filters.has(fw.id)) targets.forEach(draw); render(); };
    const unlink = x => {
      const was = dash.widgets.filter(o => linked(fw, o));
      if (x === 'page') fw.links = []; else fw.links = (Array.isArray(fw.links) ? fw.links : []).filter(id => id !== x.id);
      relink(was.filter(o => !linked(fw, o)));
    };
    const link = x => {
      if (x === 'page') { fw.links = 'page'; return relink(dash.widgets.filter(o => o !== fw)); }
      if (!fits(x) || linked(fw, x)) return render();
      const was = fw.links === 'page' ? dash.widgets.filter(o => o !== fw && o !== x) : [];
      fw.links = [...(Array.isArray(fw.links) ? fw.links : []), x.id];   // a page link becomes this one widget
      relink([x, ...was]);
    };
    function render() {
      svg.selectAll('*').remove();
      const H = Math.max($('cards').scrollHeight, stage.scrollTop + stage.clientHeight), W = Math.max($('cards').scrollWidth, stage.clientWidth);
      svg.attr('width', W).attr('height', H);
      svg.append('rect').attr('class', 'lk-dim').attr('width', W).attr('height', H).on('click', () => linkEnd());
      const page = { x: stage.scrollLeft + stage.clientWidth / 2, y: stage.scrollTop + stage.clientHeight / 2 }, from = mid(fw);
      const others = dash.widgets.filter(x => x !== fw);
      // the links: line + trash can in the middle
      const ends = fw.links === 'page' ? [['page', page]] : others.filter(x => linked(fw, x)).map(x => [x, mid(x)]);
      for (const [x, p] of ends) {
        svg.append('line').attr('class', 'lk-line').attr('x1', from.x).attr('y1', from.y).attr('x2', p.x).attr('y2', p.y);
        const t = svg.append('g').attr('class', 'lk-trash').attr('transform', `translate(${(from.x + p.x) / 2},${(from.y + p.y) / 2})`).on('click', () => unlink(x));
        t.append('title').text('Remove this link');
        t.append('circle').attr('r', 13).attr('fill', LINK.red);
        t.append('path').attr('d', 'M-5 -3h10M-3.5 -3v8h7v-8M-2 -5h4').attr('fill', 'none').attr('stroke', '#fff').attr('stroke-width', 1.6).attr('stroke-linejoin', 'round');
      }
      // the targets
      for (const x of others) {
        const p = mid(x), g = svg.append('g').attr('class', 'lk-target' + (fits(x) ? '' : ' off')).attr('transform', `translate(${p.x},${p.y})`).datum(x);
        g.append('title').text(fits(x) ? (linked(fw, x) ? 'Linked' : 'Drop here to link') : `No column "${col()}" in ${x.dataset}`);
        cross(g, LINK.orange);
      }
      const pg = svg.append('g').attr('class', 'lk-target lk-page').attr('transform', `translate(${page.x},${page.y})`).datum('page');
      cross(pg, LINK.pink, 26);
      pg.append('text').attr('y', 46).attr('text-anchor', 'middle').text('Link Filter to Page');
      // the filter: drag its green cross
      const src = svg.append('g').attr('class', 'lk-src').attr('transform', `translate(${from.x},${from.y})`);
      src.append('title').text('Drag onto a widget, or onto the centre for the whole page');
      cross(src, LINK.green);
      src.on('pointerdown', e => {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        const line = svg.insert('line', '.lk-target').attr('class', 'lk-line lk-drag').attr('x1', from.x).attr('y1', from.y).attr('x2', from.x).attr('y2', from.y);
        const ghost = svg.append('g').attr('class', 'lk-ghost').attr('transform', `translate(${from.x},${from.y})`); cross(ghost, LINK.green);
        let over = null;
        const at = ev => { const r = $('cards').getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
        const mv = ev => {
          const p = at(ev); line.attr('x2', p.x).attr('y2', p.y); ghost.attr('transform', `translate(${p.x},${p.y})`);
          over = null;
          svg.selectAll('.lk-target').each(function (d) {
            const c = d === 'page' ? page : mid(d), hit = Math.hypot(p.x - c.x, p.y - c.y) <= (d === 'page' ? 30 : 24) && (d === 'page' || fits(d));
            d3.select(this).classed('hot', hit); if (hit) over = d;
          });
        };
        const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); if (over) link(over); else render(); };
        addEventListener('pointermove', mv); addEventListener('pointerup', up);
      });
    }
    const esc = e => { if (e.key === 'Escape') { e.stopPropagation(); linkEnd(); } };
    const fit = () => requestAnimationFrame(render);   // after the grid has re-centred
    addEventListener('keydown', esc, true); stage.addEventListener('scroll', render); addEventListener('resize', fit);
    linkEnd = () => { svg.remove(); removeEventListener('keydown', esc, true); stage.removeEventListener('scroll', render); removeEventListener('resize', fit); linkEnd = null; };
    render();
  }
  addEventListener('keydown', e => { if (e.key === 'Escape' && !document.querySelector('dialog[open]') && $('wed').hidden) { $('ctxmenu').classList.remove('open'); select(null); } });

  // ---- Data / Settings on the dashboard (right-click): both can be open; they follow the selected container ----
  let qId = null;   // the container they work on
  const qW = () => byId(qId);
  const setOpen = () => !$('dSet').hidden;
  let setWanted = false;
  // The fields a chart already uses ('<dataset>|<column>'): marked in the Data window, refused on its drop boxes.
  const usedOf = w => new Set(Object.values(w?.inputs || {}).filter(v => v?.col).map(v => `${w.dataset}|${v.col}`));   // Settings was open when its chart was let go: clicking a chart brings it back
  function quickData(w) {
    qId = w.id; quickSettings(w);   // the Data section (slots) is in the Settings window
    DataWindow.open({ datasets: clean.map(d => ({ key: d.name, name: d.name.replace(/^CLEAN_/i, ''), note: 'clean', columns: d.columns || [] })), current: w.dataset || null, used: usedOf(w),
      onClose: () => { pruneSlots(qW()); qSlots(); }, managed: true });
    const de = DataWindow.element();
    if (de && dataPanel?.el !== de) dataPanel = floatPanel(de, de.querySelector('.dw-head'), 'dn-dashdata', () => ({ x: 24, y: 96 }));
    dataPanel?.place();
    restack(w, true); qSlots();
  }
  // Repeatable inputs (Line ...): fields packed to the top (base, _1, _2 ...); pad = one empty box below them (while the
  // Data window is open), else none. Returns true when something changed.
  function restack(w, pad) {
    const p = pkgs.get(w?.widget); if (!p) return false;
    const ins = w.inputs || (w.inputs = {}), before = JSON.stringify(ins);
    for (const bi of Widgets.parse(p.settings).inputs || []) {
      if (!bi.repeat) continue;
      const keys = [bi.key, ...Widgets.copies(bi, ins)], filled = keys.map(k => ins[k]).filter(v => v?.col);
      keys.forEach(k => delete ins[k]);
      filled.forEach((v, n) => { ins[n ? `${bi.key}_${n}` : bi.key] = v; });
      if (pad && filled.length) ins[`${bi.key}_${filled.length}`] = {};
    }
    return JSON.stringify(ins) !== before;
  }
  // The Data window closed: no blank drop boxes left.
  function pruneSlots(w) { if (restack(w, false)) saveNow(); }
  // The widget's slots (X, Y, Line 1 ...) are in the Settings window's Data section: drop a field on one, change how a
  // measure is combined, x to remove it. This redraws that section.
  function qSlots() {
    const w = qW();
    if (setOpen() && w && $('wed').hidden) quickSettings(w);
  }
  async function linkField(w, key, col, ds) {
    const p = pkgs.get(w?.widget), d = dsOf(ds); if (!p || !d) return;
    if (filters.delete(w.id)) refilter(w);   // its filter was for the old field
    if (w.dataset !== ds) { w.dataset = ds; w.inputs = {}; }
    const st = Widgets.parse(p.settings), inputs = w.inputs || (w.inputs = {});
    const num = Widgets.NUMERIC.test((d.columns || []).find(c => c.name === col)?.type || ''), fits = i => num ? i.role === 'measure' : i.role !== 'measure';
    const all = Widgets.expand(st.inputs, inputs, true);
    const i = key ? all.find(x => x.key === key) : all.find(x => !inputs[x.key]?.col && fits(x)) || all.find(x => !inputs[x.key]?.col) || all.find(fits);
    if (!i) return;
    inputs[i.key] = { col, ...(i.role === 'measure' ? { agg: i.agg === 'none' ? 'none' : num ? i.agg || 'sum' : 'count' } : {}) };
    // A repeatable input (Line ...): once every copy has a field, an empty one opens below for the next.
    const base = i.base || (i.repeat ? i.key : null), bi = base && st.inputs.find(x => x.key === base);
    if (bi && inputs[base]?.col && Widgets.copies(bi, inputs).every(k => inputs[k]?.col)) {
      const n = Widgets.copies(bi, inputs).map(k => +k.slice(base.length + 1)); inputs[`${base}_${Math.max(0, ...n) + 1}`] = {};
    }
    qId = w.id; select(w.id); DataWindow.close(); qSlots();   // a field added: the Data window goes (a drop box opens it)
    await saveNow(); await draw(w);
    if (setOpen()) quickSettings(w);
  }
  let dOptsWired = false;
  // A click on the canvas or in the Settings window (not on a drop box) closes the Data window.
  addEventListener('pointerdown', e => {
    if (!DataWindow.isOpen() || e.target.closest?.('.dwin, #dOpts .slot')) return;
    if (e.target.closest?.('#stage, #dSet')) DataWindow.close();
  }, true);
  addEventListener('pointermove', e => {
    const box = $('dOpts')?.querySelector(':scope > .sec-data'); if (!box) return;
    if (!document.body.classList.contains('dragging')) { box.classList.remove('near'); return; }
    const r = box.getBoundingClientRect(), dx = Math.max(r.left - e.clientX, 0, e.clientX - r.right), dy = Math.max(r.top - e.clientY, 0, e.clientY - r.bottom);
    box.classList.toggle('near', Math.hypot(dx, dy) <= 40);
  });
  function wireSlots(el) {
    // Refused: the field is already on this chart on the same axis (x / y; measures default to y). Another axis is fine
    // (e.g. a date grouped on x and counted on y).
    const axisOf = i => i?.axis || (i?.role === 'measure' ? 'y' : 'x');
    const dup = (e, key) => {
      const w = qW(), p = pkgs.get(w?.widget); if (!w || !p || w.dataset !== e.dataTransfer.getData('text/x-dataset')) return false;
      const col = e.dataTransfer.getData('text/x-field'), all = Widgets.expand(Widgets.parse(p.settings).inputs, w.inputs || {}, true), ax = axisOf(all.find(i => i.key === key));
      return all.some(i => i.key !== key && w.inputs?.[i.key]?.col === col && axisOf(i) === ax);
    };
    el.addEventListener('dragover', e => { const sl = e.target.closest('.slot'); if (!sl || !e.dataTransfer.types.includes('text/x-field')) return; e.preventDefault(); e.stopPropagation();
      const d = dup(e, sl.dataset.key); e.dataTransfer.dropEffect = d ? 'none' : 'copy'; sl.classList.toggle('dup', d); sl.classList.toggle('over', !d); });
    el.addEventListener('dragleave', e => e.target.closest('.slot')?.classList.remove('over', 'dup'));
    el.addEventListener('drop', UI.guard(async e => {
      const sl = e.target.closest('.slot'), col = e.dataTransfer.getData('text/x-field'); if (!sl || !col) return;
      e.preventDefault(); e.stopPropagation(); document.body.classList.remove('dragging'); sl.classList.remove('over', 'dup');
      if (dup(e, sl.dataset.key)) return UI.toast(`${col} is already on this axis.`, 'warn');
      await linkField(qW(), sl.dataset.key, col, e.dataTransfer.getData('text/x-dataset'));
    }));
    el.addEventListener('change', UI.guard(async e => { const k = e.target.dataset.agg, w = qW(); if (!k || !w?.inputs?.[k]) return; w.inputs[k].agg = e.target.value; qSlots(); await saveNow(); await draw(w); }));
    el.addEventListener('click', UI.guard(async e => {
      const w = qW(), b = e.target.closest('[data-clear], [data-add], [data-del]'); if (!w) return;
      if (!b) { if (e.target.closest('.slot') && !e.target.closest('select, button, input')) quickData(w); return; }   // a click in a drop box: the Data window
      const ins = w.inputs || (w.inputs = {}), k = b.dataset.clear;
      if (k) { delete ins[k]; restack(w, true); DataWindow.update({ used: usedOf(w) }); }   // the rest move up, an empty box below
      else if (b.dataset.add) { const base = b.dataset.add, n = Widgets.copies({ key: base }, ins).map(x => +x.slice(base.length + 1)); ins[`${base}_${Math.max(0, ...n) + 1}`] = {}; }
      else { const base = b.dataset.del, last = Widgets.copies({ key: base }, ins).pop(); if (last) delete ins[last]; }
      qSlots(); await saveNow(); await draw(w);
    }));
  }
  // Settings: the values go into the project's settings.json of that widget (every container using it redraws).
  let qWrite = null;
  function quickSettings(w) {
    if (!dOptsWired) { dOptsWired = true; wireSlots($('dOpts')); }
    qId = w.id; const p = pkgs.get(w.widget);
    $('dSet').hidden = false; setWanted = true; dsetPlace();
    if (!p) { $('dOpts').innerHTML = '<div class="hintbox">Custom Widget: no settings yet (right-click > Edit).</div>'; return; }
    let s; try { s = Widgets.parse(p.settings); } catch (e) { $('dOpts').innerHTML = `<div class="hintbox">${Widgets.FILES.settings}: ${esc(e.message)}</div>`; return; }
    s.values = s.values || {};
    SettingsPanel.sections($('dOpts'), s, results.get(w.id) || [], (path, v) => {
      s.values = { ...s.values, [path]: v };
      let obj = {}; try { obj = JSON.parse(p.settings); } catch {}
      p.settings = JSON.stringify({ ...obj, values: s.values }, null, 2) + '\n';
      dash.widgets.filter(x => x.widget === p.id).forEach(repaintSoon);   // live, once per frame
      clearTimeout(qWrite); qWrite = setTimeout(() => DNFS.writeText(`${p.dir}/${Widgets.FILES.settings}`, p.settings).catch(e => UI.toast(`Could not save the settings: ${e.message}`, 'err')), 300);
    });
    // Data (never folds): the widget's slots; a repeatable input (Line ...) gets Add, and Delete once it has copies.
    if ((s.inputs || []).length) {
      const links = w.inputs || {}, box = document.createElement('div');
      box.className = 'sec-data';
      box.innerHTML = '<div class="sec-title">Data</div>' + s.inputs.map(i => {
        const list = Widgets.expand([i], links, true);
        return `<div class="slot-list">${SettingsPanel.slots(list, links, Object.fromEntries((dsOf(w.dataset)?.columns || []).map(c => [c.name, c.type])))}</div>` + '';
      }).join('');
      const search = $('dOpts').querySelector(':scope > .set-search');
      $('dOpts').prepend(box); if (search) box.after(search);   // Data, then the search box, then the settings
      // Field names in one column: every label as wide as the longest (hidden spare boxes included).
      const labs = [...box.querySelectorAll('.slot > b')]; labs.forEach(b => { b.style.minWidth = ''; });
      const was = box.classList.contains('near'); box.classList.add('near');
      const lw = Math.ceil(Math.max(0, ...labs.map(b => b.getBoundingClientRect().width)));
      box.classList.toggle('near', was); labs.forEach(b => { b.style.minWidth = `${lw}px`; b.style.boxSizing = 'border-box'; });
    }
  }
  // Floating panels (Settings, Data): drag the header to move; within SNAP px of a window edge or of the other panel's
  // edges it snaps to it; drag any edge or corner (10px band, resize cursors) to resize. Place, size and window-edge snaps
  // are remembered (this browser).
  const SNAP = 16, EDGE = 10, PMIN = [220, 120], panels = [];
  const CUR = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' };
  function floatPanel(el, head, key, def) {
    let pos = null; try { pos = JSON.parse(localStorage.getItem(key) || 'null'); } catch {}
    const save = () => { try { localStorage.setItem(key, JSON.stringify(pos)); } catch {} };
    const others = () => panels.filter(q => q.el !== el && !q.el.hidden).map(q => q.el.getBoundingClientRect());
    function place() {
      const p = pos || def();
      const w = Math.min(innerWidth, Math.max(PMIN[0], p.w || 300)), h = p.h ? Math.min(innerHeight, Math.max(PMIN[1], p.h)) : 0;
      const sn = p.snap || '', x = sn.includes('l') ? 0 : sn.includes('r') ? innerWidth - w : p.x;
      const y = sn.includes('t') ? 0 : sn.includes('b') ? innerHeight - (h || el.offsetHeight) : p.y;
      Object.assign(el.style, { left: `${Math.max(0, Math.min(innerWidth - 60, x))}px`, top: `${Math.max(0, Math.min(innerHeight - 30, y))}px`,
        width: `${w}px`, maxWidth: 'none', height: h ? `${h}px` : '', maxHeight: h ? 'none' : '' });
    }
    const zoneOf = (e, r) => (e.clientY - r.top < EDGE ? 'n' : r.bottom - e.clientY < EDGE ? 's' : '') + (e.clientX - r.left < EDGE ? 'w' : r.right - e.clientX < EDGE ? 'e' : '');
    el.addEventListener('pointermove', e => { if (e.buttons) return; el.style.cursor = CUR[zoneOf(e, el.getBoundingClientRect())] || ''; });
    el.addEventListener('pointerleave', () => { el.style.cursor = ''; });
    // Resize: an edge snaps to a window edge or to the other panel's edges.
    el.addEventListener('pointerdown', e => {
      const r = el.getBoundingClientRect(), z = zoneOf(e, r); if (e.button !== 0 || !z) return;
      e.preventDefault(); e.stopPropagation();
      const sx = e.clientX, sy = e.clientY, os = others(), xs = [0, innerWidth, ...os.flatMap(o => [o.left, o.right])], ys = [0, innerHeight, ...os.flatMap(o => [o.top, o.bottom])];
      const near = (v, list) => list.find(t => Math.abs(v - t) < SNAP) ?? v;
      document.body.style.cursor = CUR[z];
      const mv = ev => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy; let { left: x, top: y, right: x2, bottom: y2 } = r;
        if (z.includes('w')) x = Math.max(0, Math.min(r.right - PMIN[0], near(r.left + dx, xs)));
        if (z.includes('e')) x2 = Math.min(innerWidth, Math.max(r.left + PMIN[0], near(r.right + dx, xs)));
        if (z.includes('n')) y = Math.max(0, Math.min(r.bottom - PMIN[1], near(r.top + dy, ys)));
        if (z.includes('s')) y2 = Math.min(innerHeight, Math.max(r.top + PMIN[1], near(r.bottom + dy, ys)));
        const snap = (x <= 0 ? 'l' : x2 >= innerWidth ? 'r' : '') + (y <= 0 ? 't' : y2 >= innerHeight ? 'b' : '');
        pos = { x, y, w: x2 - x, h: y2 - y, snap }; place();
      };
      const up = () => { document.body.style.cursor = ''; removeEventListener('pointermove', mv); removeEventListener('pointerup', up); save(); };
      addEventListener('pointermove', mv); addEventListener('pointerup', up);
    }, true);
    // Move: snaps to the window edges, and side by side with / lined up on the other panel.
    head.addEventListener('pointerdown', e => {
      if (e.button !== 0 || e.target.closest('button')) return;
      e.preventDefault(); e.stopPropagation();
      const r = el.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top, os = others(), W = r.width, H = r.height;
      const pick = (v, cands) => { let best = null; for (const t of cands) if (Math.abs(v - t) < SNAP && (best == null || Math.abs(v - t) < Math.abs(v - best))) best = t; return best; };
      const mv = ev => {
        let x = ev.clientX - dx, y = ev.clientY - dy, snap = '';
        const sx = pick(x, os.flatMap(o => [o.right, o.left, o.right - W, o.left - W])), sy = pick(y, os.flatMap(o => [o.bottom, o.top, o.bottom - H, o.top - H]));
        if (sx != null) x = sx; if (sy != null) y = sy;
        if (x < SNAP) { x = 0; snap += 'l'; } else if (innerWidth - (x + W) < SNAP) { x = innerWidth - W; snap += 'r'; }
        if (y < SNAP) { y = 0; snap += 't'; } else if (innerHeight - (y + H) < SNAP) { y = innerHeight - H; snap += 'b'; }
        pos = { ...pos, x, y, w: W, snap }; place();
      };
      const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); save(); };
      addEventListener('pointermove', mv); addEventListener('pointerup', up);
    }, true);
    addEventListener('resize', () => { if (!el.hidden) place(); });
    const q = { el, place }; panels.push(q); return q;
  }
  const dsetPanel = floatPanel($('dSet'), $('dSetHead'), 'dn-dashsettings', () => ({ x: Math.max(0, innerWidth - 300 - 24), y: 96 }));
  const dsetPlace = () => dsetPanel.place();
  let dataPanel = null;   // the Data window: made by DataWindow on its first open
  $('dSetX').onclick = () => { $('dSet').hidden = true; setWanted = false; DataWindow.close(); };   // closed until right-click > Settings
  // Selecting another container while they are open: they switch to it.
  $('cards').addEventListener('pointerdown', e => {
    const id = e.target.closest('.card')?.dataset.id; if (!id || !$('wed').hidden) return;
    const w = byId(id); if (!w) return;
    if (setWanted && (!setOpen() || id !== qId)) quickSettings(w);
    if (id === qId) return;
    if (DataWindow.isOpen()) { qId = id; DataWindow.update({ current: w.dataset || null, used: usedOf(w) }); qSlots(); }
  });
  // A field dropped on a container: that dataset + the field on the first free slot that fits (numbers -> measures).
  $('cards').addEventListener('dragover', e => { if (!e.dataTransfer.types.includes('text/x-field') || !e.target.closest('.card')) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  $('cards').addEventListener('drop', UI.guard(async e => {
    const card = e.target.closest('.card'), col = e.dataTransfer.getData('text/x-field'); if (!card || !col) return;
    e.preventDefault(); document.body.classList.remove('dragging');
    const w = byId(card.dataset.id); if (!pkgs.get(w?.widget)) return UI.toast('Custom Widget: edit it first (right-click > Edit).', 'err');
    await linkField(w, null, col, e.dataTransfer.getData('text/x-dataset'));
  }));
  addEventListener('resize', () => { if (setOpen()) dsetPlace(); });

  // ---- Widget Editor ----
  let editing = null;   // the container open in the Widget Editor
  const edit = UI.guard(async (w, restore) => {
    await loadClean();
    const p = pkgs.get(w.widget) || null;
    editing = w.id; $('dSet').hidden = true; DataWindow.close();
    WidgetEditor.open({
      ctx, pkg: p, clean, restore, dataset: restore?.dataset ?? w.dataset, links: restore?.links || w.inputs || {}, size: restore?.size || { w: w.w, h: w.h },
      // Saved (the dataset attached is a CLEAN_ one): the container uses the project copy and that data.
      onSaved: async ({ id, dataset, links, size, project }) => {
        // The editor's data stays in the editor: on the dashboard the container keeps its own (a new widget starts blank;
        // attach data with right-click > Data).
        if (project) { if (w.widget !== id) Object.assign(w, { dataset: '', inputs: {} }); Object.assign(w, { widget: id, w: size.w, h: size.h }); const c = cardOf(w); if (c) place(c, w); }
        await loadPkgs(); drawTypes(); await saveNow(); draw(w);
      },
    });
  });

  // The Widget Editor on a Custom widget (or a new one: p = null) without a container. Saved: it shows under Custom.
  const editPkg = UI.guard(async p => {
    await loadClean();
    editing = null; $('dSet').hidden = true; DataWindow.close();
    WidgetEditor.open({ ctx, pkg: p || null, clean, dataset: '', links: {}, size: { w: SIZE[0], h: SIZE[1] },
      onSaved: async () => { await loadPkgs(); drawTypes(); } });
  });

  // ---- F5: come back exactly where you were (selected container, Widget Editor with its unsaved edits and windows) ----
  const VIEW = () => `dn-studio-view:${ctx.folder}`;
  addEventListener('beforeunload', () => {
    try { sessionStorage.setItem(VIEW(), JSON.stringify({ sel: selId, edit: WidgetEditor.isOpen ? editing : null, ed: WidgetEditor.snapshot() })); } catch {}
  });
  function restoreView() {
    let v = null; try { v = JSON.parse(sessionStorage.getItem(VIEW()) || 'null'); } catch {}
    if (!v) return;
    if (v.sel && byId(v.sel)) select(v.sel);
    const w = v.edit && byId(v.edit); if (w && v.ed) edit(w, v.ed);
  }

  // ---- start ----
  (async () => {
    try {
      ctx = await ModulePage.init('dashboard', 'Dashboard Studio');
      await Promise.all([loadPkgs(), loadClean()]);
      applyPrefs(); drawTypes(); fitGrid();
      const raw = await DNFS.readJSONOr(FILE(), null);
      dash = raw?.version === 4 ? raw : { version: 4, widgets: [] };   // dashboards from the old Dashboard Builder start empty
      dash.widgets = (dash.widgets || []).map(clamp);
      renderAll();
      restoreView();
      // Shown only once the grid, boundary and widgets have their final sizes (no jump on load / refresh).
      requestAnimationFrame(() => { refit(); requestAnimationFrame(() => document.body.classList.remove('dsload')); });
    } catch (e) { document.body.classList.remove('dsload'); UI.toast(e.message, 'err'); $('cards').innerHTML = `<div class="hint err">${esc(e.message)}</div>`; }
  })();
})();
