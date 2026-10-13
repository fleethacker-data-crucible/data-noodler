// Dashboard Studio (ui/html/dashboard-studio.html): the project's dashboard on the 24px grid. The bar at the top: widget
// category buttons (Column, Bar, ...: a drop-down of the app's packaged widgets, ui/widgets/<Category>/<id>/) and Custom
// (a drop-down: an empty container, this project's own widgets and the global library). A packaged or global widget is
// copied into the project first. Each drop-down: a search box + a 4-wide grid of buttons. Right-click a container > Edit opens the Widget
// Editor (ui/js/dashboard/widget-editor.js). Containers move (drag) and resize (handles of the selected one).
// State: <project>/dashboard/dashboard.json = { version: 4, widgets: [{ id, widget, x, y, w, h, z, dataset, inputs: { <key>: { col, agg } } }] }
//   widget = the folder in <project>/dashboard/widgets/ (null = an empty Custom Widget container). Read by Publish.
(() => {
  const { $, esc } = UI;
  const COLS = 48, G = 24, SIZE = [16, 10], MIN = [4, 3], TOP = 5;   // TOP: rows kept free under the bar
  const PLACEHOLDERS = [
    ['Column', '<rect x="3" y="11" width="4" height="10"/><rect x="10" y="5" width="4" height="16"/><rect x="17" y="8" width="4" height="13"/>'],
    ['Bar', '<rect x="3" y="3" width="12" height="4"/><rect x="3" y="10" width="18" height="4"/><rect x="3" y="17" width="9" height="4"/>'],
    ['Line', '<polyline points="3,18 8,11 13,14 21,5" fill="none" stroke="currentColor" stroke-width="2"/>'],
    ['Area', '<path d="M3 20 L3 14 L8 9 L13 12 L21 5 L21 20 Z"/>'],
    ['Scatter', '<circle cx="6" cy="16" r="2"/><circle cx="10" cy="9" r="2"/><circle cx="15" cy="13" r="2"/><circle cx="19" cy="6" r="2"/>'],
    ['Pie', '<path d="M12 3 A9 9 0 1 1 3 12 L12 12 Z"/><path d="M12 3 L12 12 L3 12 A9 9 0 0 1 12 3" opacity=".5"/>'],
    ['Donut', '<path d="M12 3 A9 9 0 1 1 3 12 L7 12 A5 5 0 1 0 12 7 Z"/><path d="M12 3 L12 7 A5 5 0 0 0 7 12 L3 12 A9 9 0 0 1 12 3" opacity=".5"/>'],
  ];
  const ICON_CUSTOM = '<rect x="3" y="3" width="18" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 2"/><path d="M12 8v8M8 12h8" stroke="currentColor" stroke-width="2"/>';
  const ICON_GEAR = '<path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
  // Dashboard Studio settings (this browser): grid shown, containers snap to it.
  const PREFS = 'dn-studio-prefs';
  let prefs = { grid: true, snap: true, barPos: 'Top', autoHide: false };
  try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem(PREFS) || '{}') }; } catch {}
  const savePrefs = () => { try { localStorage.setItem(PREFS, JSON.stringify(prefs)); } catch {} };
  const applyPrefs = () => {
    document.body.classList.toggle('nogrid', !prefs.grid);
    document.body.classList.toggle('barbottom', prefs.barPos === 'Bottom');
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

  let ctx, dash = { version: 4, widgets: [] }, selId = null, OX = 0;
  let pkgs = new Map(), globals = [], packaged = {}, clean = [];
  const PACKAGED = 'ui/widgets';   // shipped with the app: ui/widgets/<Category>/<id>/ (the folder name = the button)
  const results = new Map();   // container id -> rows (redraw on resize without a query)
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
      : packaged[cat].map(p => pkgs.has(p.id) ? { proj: p.id, icon: ICON_WIDGET, name: p.name, tip: `${p.name}: add it` }
        : { src: p.dir, id: p.id, icon: ICON_WIDGET, name: p.name, tip: `${p.name}: copy it into this project and add it` });
    menu = document.createElement('div'); menu.className = 'tmenu';
    menu._items = items;
    menu.innerHTML = `<input class="tm-q" type="search" placeholder="Search" spellcheck="false"><div class="tm-grid">${items.map((it, k) => tile(`data-k="${k}" data-n="${esc(it.name.toLowerCase())}"`, it.icon, it.name, it.tip, it.cls || '')).join('')}</div><div class="tm-none" hidden>No match</div>`;
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
    menu.innerHTML = `<div class="tm-h">Dashboard Studio</div>${row('autoHide', 'Auto Hide')}${pick('barPos', 'Icon Bar Position', ['Top', 'Bottom'])}${row('grid', 'Show Grid')}${row('snap', 'Snap to Grid')}`;
    menu.onchange = e => { const k = e.target.dataset?.k; if (!k) return; prefs[k] = e.target.value; savePrefs(); applyPrefs(); closeMenu(); };
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
    try { await Widgets.draw(pv, { ...p, key: p.id }, results.get(w.id) || []); }
    catch (e) { note(esc(String(e.message || e).split('\n')[0]), true); }
  }
  let queue = Promise.resolve();
  function draw(w) {
    queue = queue.then(async () => {
      results.delete(w.id);
      const p = pkgs.get(w.widget), d = dsOf(w.dataset);
      if (p && d) {
        try { const s = Widgets.parse(p.settings); if (Widgets.ready(s.inputs, w.inputs || {})) { await Engine.memory.load([d.path]).catch(() => {}); results.set(w.id, await Widgets.load(s.inputs, w.inputs || {}, d)); } }
        catch (e) { ctx.log(`${p.name}: ${String(e.message || e).split('\n')[0]}`, 'warn'); }
      }
      await paint(w);
    });
    return queue;
  }
  let rpFrame = 0; const rpSet = new Set();
  const repaintSoon = w => { rpSet.add(w); if (!rpFrame) rpFrame = requestAnimationFrame(() => { rpFrame = 0; const s = [...rpSet]; rpSet.clear(); s.forEach(paint); }); };

  // ---- the stage: a grid line locked to the centre; containers keep their columns counted from it ----
  function fitGrid() {
    const st = $('stage'), dp = devicePixelRatio || 1, c = Math.floor(st.clientWidth * dp / 2) / dp;
    st.style.setProperty('--gx', `${((c % G) + G) % G}px`);
    const ox = c - (COLS / 2) * G; if (ox === OX) return false;
    OX = ox; return true;
  }
  function place(el, w) {
    el.style.zIndex = w.z || 1;
    Object.assign(el.style, { left: `${OX + w.x * G}px`, top: `${w.y * G}px`, width: `${w.w * G + 1}px`, height: `${w.h * G + 1}px` });
    const sz = el.querySelector?.('.sz'); if (sz) sz.textContent = `${w.w * G} x ${w.h * G} px`;
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
  new ResizeObserver(() => { if (fitGrid()) dash.widgets.forEach(w => { const e = cardOf(w); if (e) place(e, w); }); }).observe($('stage'));

  // Move (drag) / resize (handles of the selected container), snapped to the grid. A press without movement selects.
  $('cards').addEventListener('pointerdown', ev => {
    const el = ev.target.closest('.card'); if (!el || ev.button !== 0) return;
    if (ev.target.closest('input, select, button, textarea, a')) return;   // a widget's own controls
    const w = byId(el.dataset.id), dir = ev.target.closest('.rz')?.dataset.dir;
    ev.preventDefault();
    const sx = ev.clientX, sy = ev.clientY, start = { ...w }, ghost = Object.assign(document.createElement('div'), { className: 'ghostbox' });
    let moved = false;
    const onMove = e => {
      if (!moved && Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) < 4) return;
      if (!moved) { moved = true; select(w.id); el.classList.add('moving'); }
      const dx = R((e.clientX - sx) / G), dy = R((e.clientY - sy) / G);
      if (!dir) {
        // The chart itself moves: its top-left corner snaps to the top-left of the grid cell it is over (Snap to Grid off:
        // every pixel).
        const fx = start.x + (e.clientX - sx) / G, fy = start.y + (e.clientY - sy) / G, S = v => prefs.snap ? Math.floor(v) : Math.round(v * G) / G;
        w.x = S(fx); w.y = Math.max(TOP, S(fy));
        place(el, w);
      } else {
        const right = start.x + start.w, bottom = start.y + start.h;
        let x = start.x, y = start.y, x2 = right, y2 = bottom;
        if (dir.includes('e')) x2 = Math.max(start.x + MIN[0], right + dx);
        if (dir.includes('w')) x = Math.min(right - MIN[0], start.x + dx);
        if (dir.includes('s')) y2 = Math.max(start.y + MIN[1], bottom + dy);
        if (dir.includes('n')) y = Math.max(TOP, Math.min(bottom - MIN[1], start.y + dy));
        Object.assign(w, { x, y, w: x2 - x, h: y2 - y });
        place(el, w); repaintSoon(w);
      }
    };
    const onUp = () => {
      removeEventListener('pointermove', onMove); removeEventListener('pointerup', onUp);
      ghost.remove(); el.classList.remove('moving'); place(el, w);
      if (!moved) return select(w.id);
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
  }

  // ---- add / delete ----
  // builtin: placed from a category button (a chart shipped with the app): only its settings can change, never its code.
  const addContainer = UI.guard(async (widget, builtin) => {
    const w = clamp({ id: crypto.randomUUID().slice(0, 8), widget, x: (COLS - SIZE[0]) / 2, y: Math.max(TOP, Math.floor(($('stage').clientHeight / G - SIZE[1]) / 2)), w: SIZE[0], h: SIZE[1], dataset: '', inputs: {}, ...(builtin ? { builtin: true } : {}) });
    const used = dash.widgets.filter(o => o.x === w.x && o.y === w.y).length; w.x += used * 2; w.y += used * 2;   // not exactly on top of another
    dash.widgets.push(w); await saveNow();
    $('cards').append(cardEl(w)); fitHint(); select(w.id); draw(w);
    ctx.log(widget ? `Widget added: ${pkgs.get(widget)?.name || widget}` : 'Custom Widget container added');
  });
  const delContainer = UI.guard(async w => {
    const name = pkgs.get(w.widget)?.name || 'this Custom Widget';
    if (!await UI.confirm(`Delete ${name} from the dashboard? (Its widget files stay in dashboard/widgets/.)`, { danger: true, ok: 'Delete' })) return;
    dash.widgets = dash.widgets.filter(x => x !== w); results.delete(w.id);
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
    m.style.left = `${Math.max(0, Math.min(ev.clientX, innerWidth - m.offsetWidth - 4))}px`; m.style.top = `${Math.max(0, Math.min(ev.clientY, innerHeight - m.offsetHeight - 4))}px`;
  });
  addEventListener('contextmenu', e => { if (!e.target.closest('input, textarea, .sqled')) e.preventDefault(); });   // no browser menu
  addEventListener('pointerdown', e => { if (!e.target.closest('#ctxmenu')) $('ctxmenu').classList.remove('open'); }, true);
  addEventListener('blur', () => $('ctxmenu').classList.remove('open'));
  $('ctxmenu').onclick = ev => {
    const act = ev.target.closest('[data-act]')?.dataset.act, w = byId(ctxId); if (!act || !w) return;
    $('ctxmenu').classList.remove('open');
    if (act === 'edit') { if (w.builtin) return UI.toast('A built-in chart: only its Settings can change.', 'warn'); edit(w); } else if (act === 'delete') delContainer(w);
    else if (act === 'data') quickData(w); else if (act === 'settings') quickSettings(w);
  };
  addEventListener('keydown', e => { if (e.key === 'Escape' && !document.querySelector('dialog[open]') && $('wed').hidden) { $('ctxmenu').classList.remove('open'); select(null); } });

  // ---- Data / Settings on the dashboard (right-click): both can be open; they follow the selected container ----
  let qId = null;   // the container they work on
  const qW = () => byId(qId);
  const setOpen = () => !$('dSet').hidden;
  function quickData(w) {
    qId = w.id; $('dSet').hidden || quickSettings(w);
    DataWindow.open({ datasets: clean.map(d => ({ key: d.name, name: d.name.replace(/^CLEAN_/i, ''), note: 'clean', columns: d.columns || [] })), current: w.dataset || null,
      onClose: () => qSlots() });
    qSlots();
  }
  // The widget's slots (X, Y ...) around the container while the Data window is open: drop a field on one, change how a
  // measure is combined, or x to remove it. Empty slots show while a field is dragged.
  function qSlots() {
    let el = $('dSlots');
    if (!el) { el = Object.assign(document.createElement('div'), { id: 'dSlots', className: 'slots' }); $('cards').append(el); wireSlots(el); }
    const w = qW(), p = pkgs.get(w?.widget);
    if (!w || !p || !DataWindow.isOpen() || !$('wed').hidden) { el.innerHTML = ''; return; }
    let st; try { st = Widgets.parse(p.settings); } catch { el.innerHTML = ''; return; }
    el.innerHTML = SettingsPanel.slots(st.inputs, w.inputs || {});
    SettingsPanel.placeSlots(el, st.inputs, { left: OX + w.x * G, top: w.y * G, w: w.w * G, h: w.h * G });
  }
  async function linkField(w, key, col, ds) {
    const p = pkgs.get(w?.widget), d = dsOf(ds); if (!p || !d) return;
    if (w.dataset !== ds) { w.dataset = ds; w.inputs = {}; }
    const st = Widgets.parse(p.settings), inputs = w.inputs || (w.inputs = {});
    const num = Widgets.NUMERIC.test((d.columns || []).find(c => c.name === col)?.type || ''), fits = i => num ? i.role === 'measure' : i.role !== 'measure';
    const i = key ? st.inputs.find(x => x.key === key) : st.inputs.find(x => !inputs[x.key] && fits(x)) || st.inputs.find(x => !inputs[x.key]) || st.inputs.find(fits);
    if (!i) return;
    inputs[i.key] = { col, ...(i.role === 'measure' ? { agg: i.agg === 'none' ? 'none' : num ? i.agg || 'sum' : 'count' } : {}) };
    qId = w.id; select(w.id); DataWindow.update({ current: ds }); qSlots();
    await saveNow(); await draw(w);
    if (setOpen()) quickSettings(w);
  }
  function wireSlots(el) {
    el.addEventListener('dragover', e => { const sl = e.target.closest('.slot'); if (!sl || !e.dataTransfer.types.includes('text/x-field')) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; sl.classList.add('over'); });
    el.addEventListener('dragleave', e => e.target.closest('.slot')?.classList.remove('over'));
    el.addEventListener('drop', UI.guard(async e => {
      const sl = e.target.closest('.slot'), col = e.dataTransfer.getData('text/x-field'); if (!sl || !col) return;
      e.preventDefault(); e.stopPropagation(); document.body.classList.remove('dragging');
      await linkField(qW(), sl.dataset.key, col, e.dataTransfer.getData('text/x-dataset'));
    }));
    el.addEventListener('change', UI.guard(async e => { const k = e.target.dataset.agg, w = qW(); if (!k || !w?.inputs?.[k]) return; w.inputs[k].agg = e.target.value; qSlots(); await saveNow(); await draw(w); }));
    el.addEventListener('click', UI.guard(async e => { const k = e.target.dataset.clear, w = qW(); if (!k || !w?.inputs) return; delete w.inputs[k]; qSlots(); await saveNow(); await draw(w); }));
  }
  // Settings: the values go into the project's d3-settings.json of that widget (every container using it redraws).
  let qWrite = null;
  function quickSettings(w) {
    qId = w.id; const p = pkgs.get(w.widget);
    $('dSet').hidden = false; dsetPlace();
    if (!p) { $('dOpts').innerHTML = '<div class="hintbox">Custom Widget: no settings yet (right-click > Edit).</div>'; return; }
    let s; try { s = Widgets.parse(p.settings); } catch (e) { $('dOpts').innerHTML = `<div class="hintbox">d3-settings.json: ${esc(e.message)}</div>`; return; }
    s.values = s.values || {};
    SettingsPanel.sections($('dOpts'), s, results.get(w.id) || [], (path, v) => {
      s.values = { ...s.values, [path]: v };
      let obj = {}; try { obj = JSON.parse(p.settings); } catch {}
      p.settings = JSON.stringify({ ...obj, values: s.values }, null, 2) + '\n';
      dash.widgets.filter(x => x.widget === p.id).forEach(repaintSoon);   // live, once per frame
      clearTimeout(qWrite); qWrite = setTimeout(() => DNFS.writeText(`${p.dir}/d3-settings.json`, p.settings).catch(e => UI.toast(`Could not save the settings: ${e.message}`, 'err')), 300);
    });
  }
  const DSET_KEY = 'dn-dashsettings';
  let dsetPos = null; try { dsetPos = JSON.parse(sessionStorage.getItem(DSET_KEY) || 'null'); } catch {}
  function dsetPlace() { const el = $('dSet'), p = dsetPos || { x: Math.max(0, innerWidth - 300 - 24), y: 96 }; Object.assign(el.style, { left: `${Math.max(0, Math.min(innerWidth - 60, p.x))}px`, top: `${Math.max(0, Math.min(innerHeight - 30, p.y))}px` }); }
  $('dSetX').onclick = () => { $('dSet').hidden = true; };
  $('dSetHead').addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    const r = $('dSet').getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    const mv = ev => { dsetPos = { x: ev.clientX - dx, y: ev.clientY - dy }; dsetPlace(); };
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); try { sessionStorage.setItem(DSET_KEY, JSON.stringify(dsetPos)); } catch {} };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
  });
  // Selecting another container while they are open: they switch to it.
  $('cards').addEventListener('pointerdown', e => {
    const id = e.target.closest('.card')?.dataset.id; if (!id || id === qId || !$('wed').hidden) return;
    const w = byId(id); if (!w) return;
    if (setOpen()) quickSettings(w);
    if (DataWindow.isOpen()) { qId = id; DataWindow.update({ current: w.dataset || null }); qSlots(); }
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
    } catch (e) { UI.toast(e.message, 'err'); $('cards').innerHTML = `<div class="hint err">${esc(e.message)}</div>`; }
  })();
})();
