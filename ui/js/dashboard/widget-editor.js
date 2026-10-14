// Widget Editor (Dashboard Studio > right-click a container > Edit Widget). Global: WidgetEditor.
//   WidgetEditor.open({ ctx, pkg, clean, dataset, links, size, onSaved({ id, dataset, links, size, project, global }) })
//     pkg = the project's widget { id, code, css, settings } (null = a new Custom Widget: the starter files)
//     clean = the project's CLEAN_ datasets; dataset / links / size = what the container has now
// The widget is drawn live on the grid (resize handles try other sizes). Data: drag a field from the Data window onto a
// slot; SAMPLE_ datasets preview only: Save stays greyed until a CLEAN_ dataset is attached. Settings: built from
// settings.json (values are written back into it). Code: code.js / style.css / settings.json in their own
// window (ui/html/widget-code.html, through window.WidgetCode). Save asks: Project, Global or both.
const WidgetEditor = (() => {
  const { $, esc } = UI, G = 24;
  let o = null;                 // the open call's arguments
  let files, s, id, links, dataset, size, rows = null, sources = [], dirty = false, seq = 0;
  const subs = new Set();
  const push = () => subs.forEach(f => { try { f(); } catch { subs.delete(f); } });
  const src = () => sources.find(d => d.name === dataset) || null;
  const isClean = () => !!src() && !src().sample;

  // ---- open / close ----
  async function open(args) {
    o = args;
    // After a refresh (F5) the files are always read fresh from disk (edits made there show); only the unsaved setting
    // values come back on top.
    const r = args.restore;
    files = args.pkg ? { code: args.pkg.code, css: args.pkg.css, settings: args.pkg.settings } : (r?.files || WidgetStarter.files());
    if (args.pkg && r?.dirty) try {
      const old = JSON.parse(r.files.settings).values || {}, cur = JSON.parse(files.settings);
      files.settings = JSON.stringify({ ...cur, values: { ...(cur.values || {}), ...old } }, null, 2) + '\n';
    } catch {}
    id = args.pkg?.id || null; links = JSON.parse(JSON.stringify(args.links || {})); dataset = args.dataset || ''; size = { ...(args.size || { w: 16, h: 10 }) };
    try { s = Widgets.parse(files.settings); } catch { s = { name: '', inputs: [], settings: [], values: {} }; }
    $('wName').value = s.name || args.pkg?.name || '';
    rows = null; dirty = !!r?.dirty;
    sources = [...args.clean.map(d => ({ ...d })), ...await Widgets.samples().catch(() => [])];
    if (!src()) { dataset = ''; links = {}; }
    $('wed').hidden = false; document.body.classList.add('editing');
    drawSlots(); drawSettings(); loadData(); push();
    if (r?.setOpen) setWin(true);
    if (r?.codeOpen) $('wCode').click();
    requestAnimationFrame(layout);
  }
  async function close(force) {
    if (!force && dirty && !await UI.confirm('Close the Widget Editor? Unsaved changes are lost.', { ok: 'Close' })) return;
    $('wed').hidden = true; document.body.classList.remove('editing');
    DataWindow.close(); setWin(false); try { codeWin?.close(); } catch {}
    o = null; push();
  }
  const changed = () => { dirty = true; };

  // ---- layout: the card centred on the grid at the container's size; slots beside it ----
  function layout() {
    if ($('wed').hidden) return;
    const st = $('wStage'), W = st.clientWidth, H = st.clientHeight, c = Math.floor(W / 2);
    st.style.setProperty('--gx', `${c % G}px`);
    const cw = size.w * G, ch = Math.min(size.h * G, Math.max(4 * G, Math.floor((H - 8 * G) / G) * G));
    const left = Math.round(c - cw / 2), top = Math.max(4 * G, Math.round(H / 2 - ch / 2));
    Object.assign($('wCard').style, { left: `${left}px`, top: `${top}px`, width: `${cw + 1}px`, height: `${ch + 1}px` });
    Object.assign($('wName').style, { left: `${left + cw / 2}px`, top: `${top - 10}px` });
    SettingsPanel.placeSlots($('wSlots'), Widgets.expand(s.inputs, links, true), { left, top, w: cw, h: ch });
    $('wSz').textContent = `${cw} x ${ch} px`;
    drawNow();
  }
  new ResizeObserver(layout).observe($('wStage'));
  $('wCard').addEventListener('pointerdown', ev => {
    const dir = ev.target.closest('.rz')?.dataset.dir; if (!dir) return;
    ev.preventDefault();
    const sx = ev.clientX, sy = ev.clientY, s0 = { ...size };
    const fx = dir.includes('e') ? 1 : dir.includes('w') ? -1 : 0, fy = dir.includes('s') ? 1 : dir.includes('n') ? -1 : 0;
    const move = e => { size = { w: Math.max(4, s0.w + 2 * fx * Math.round((e.clientX - sx) / G)), h: Math.max(3, s0.h + 2 * fy * Math.round((e.clientY - sy) / G)) }; layout(); };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); changed(); };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  });

  // ---- data: slots (drop a field), the Data window (CLEAN_ + SAMPLE_ datasets) ----
  const columns = () => src()?.columns || [];
  // Slots + Add / Delete under a repeatable input (Series, Column ...): Add = one more copy, Delete = the last copy.
  function drawSlots() {
    $('wSlots').innerHTML = SettingsPanel.slots(Widgets.expand(s.inputs, links, true), links)
      + s.inputs.filter(i => i.repeat).map(i => `<div class="slot set slot-btns"><b>${esc(i.repeat)}</b><button type="button" class="ghost small" data-add="${esc(i.key)}">Add</button>`
        + `${Widgets.copies(i, links).length ? `<button type="button" class="ghost small" data-del="${esc(i.key)}">Delete</button>` : ''}</div>`).join('');
    layout();
  }
  // Data window: names without the SAMPLE_ / CLEAN_ file prefix; the kind is the note on the right (sample / clean).
  const dsList = () => sources.map(d => ({ key: d.name, name: d.name.replace(/^(SAMPLE|CLEAN)_/i, ''), note: d.sample ? 'sample' : /^CLEAN_/i.test(d.name) ? 'clean' : '', columns: d.columns || [] }));
  const dataWin = () => DataWindow.update({ datasets: dsList(), current: dataset || null });
  $('wData').onclick = () => DataWindow.open({ datasets: dsList(), current: dataset || null });
  function useDataset(name) {
    if (!name || name === dataset) return;
    dataset = name;
    for (const k of Object.keys(links)) if (!columns().some(c => c.name === links[k].col)) delete links[k];
    dataWin();
  }
  function link(key, col) {
    const i = Widgets.expand(s.inputs, links, true).find(x => x.key === key); if (!i) return;
    const num = Widgets.NUMERIC.test(columns().find(c => c.name === col)?.type || '');
    links[key] = { col, ...(i.role === 'measure' ? { agg: links[key]?.agg || (i.agg === 'none' ? 'none' : num ? i.agg || 'sum' : 'count') } : {}) };
    changed(); drawSlots(); loadData();
  }
  function autoPlace(col) {
    const num = Widgets.NUMERIC.test(columns().find(c => c.name === col)?.type || ''), fits = i => num ? i.role === 'measure' : i.role !== 'measure';
    const i = s.inputs.find(x => !links[x.key] && fits(x)) || s.inputs.find(x => !links[x.key]) || s.inputs.find(fits);
    if (i) link(i.key, col);
  }
  $('wSlots').addEventListener('change', e => { const k = e.target.dataset.agg; if (k && links[k]) { links[k].agg = e.target.value; changed(); drawSlots(); loadData(); } });
  $('wSlots').addEventListener('click', e => {
    const b = e.target.closest('[data-clear], [data-add], [data-del]'); if (!b) return;
    const k = b.dataset.clear;
    if (k) { if (Widgets.expand(s.inputs, links, true).find(x => x.key === k)?.base) links[k] = {}; else delete links[k]; }   // a cleared copy stays, empty
    else if (b.dataset.add) { const base = b.dataset.add, n = Widgets.copies({ key: base }, links).map(x => +x.slice(base.length + 1)); links[`${base}_${Math.max(0, ...n) + 1}`] = {}; }
    else { const last = Widgets.copies({ key: b.dataset.del }, links).pop(); if (last) delete links[last]; }
    changed(); drawSlots(); loadData();
  });
  const over = (el, on) => el?.classList.toggle('over', on);
  for (const zone of [$('wSlots'), $('wCard')]) {
    zone.addEventListener('dragover', e => { if (!e.dataTransfer.types.includes('text/x-field')) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; over(zone === $('wCard') ? zone : e.target.closest('.slot'), true); });
    zone.addEventListener('dragleave', e => over(zone === $('wCard') ? zone : e.target.closest('.slot'), false));
    zone.addEventListener('drop', e => {
      const col = e.dataTransfer.getData('text/x-field'); if (!col) return;
      e.preventDefault(); document.querySelectorAll('.over').forEach(x => x.classList.remove('over'));
      useDataset(e.dataTransfer.getData('text/x-dataset'));
      const sl = e.target.closest('.slot'); if (sl) link(sl.dataset.key, col); else autoPlace(col);
    });
  }
  async function loadData() {
    const n = ++seq, d = src();
    if (!d || !Widgets.ready(s.inputs, links)) { rows = null; note(); return draw(); }
    try {
      if (!d.sample) await Engine.memory.load([d.path]).catch(() => {});
      const r = await Widgets.load(s.inputs, links, d);
      if (n !== seq) return;
      rows = r;
    } catch (e) { if (n !== seq) return; rows = null; status(`Data: ${String(e.message || e).split('\n')[0]}`, true); }
    note(); draw();
  }
  // Under the widget: which data it shows; Save greyed while no CLEAN_ dataset is attached.
  function note() {
    const d = src();
    $('wNote').textContent = !d ? 'No data: open Data and drag a field onto a slot.' : d.sample ? `${d.name}: sample data (preview only). Attach a CLEAN_ dataset to save.` : rows ? `${rows.length.toLocaleString()} rows from ${d.name}` : `${d.name}: link every slot.`;
    $('wSave').disabled = !isClean();
    $('wSave').title = isClean() ? 'Save the widget to the project and / or the global library' : 'Attach a CLEAN_ dataset to save (SAMPLE_ data is preview only)';
  }

  // ---- settings window: built from settings.json; a change is written into its "values" ----
  let syncF = 0;
  function setValue(path, v) {
    s.values = { ...s.values, [path]: v };
    changed(); draw();
    if (!syncF) syncF = requestAnimationFrame(() => { syncF = 0; syncSettingsText(); });   // the settings text / code window: once per frame too
  }
  function syncSettingsText() {
    let obj = {}; try { obj = JSON.parse(files.settings); } catch {}
    const { name, inputs, settings, values, ...rest } = obj;
    files.settings = JSON.stringify({ name: $('wName').value.trim(), inputs: inputs ?? s.inputs, settings: settings ?? s.settings, values: s.values, ...rest }, null, 2) + '\n';
    push();
  }
  function drawSettings() { SettingsPanel.sections($('wOpts'), s, rows, setValue); }
  const SET_KEY = 'dn-widgetsettings';
  let setPos = null; try { setPos = JSON.parse(sessionStorage.getItem(SET_KEY) || 'null'); } catch {}
  function setPlace() { const el = $('wSet'), p = setPos || { x: Math.max(0, innerWidth - 400 - 24), y: 96 }; Object.assign(el.style, { left: `${Math.max(0, Math.min(innerWidth - 60, p.x))}px`, top: `${Math.max(0, Math.min(innerHeight - 30, p.y))}px` }); }
  function setWin(open) { $('wSet').hidden = !open; if (open) setPlace(); }
  $('wSetBtn').onclick = () => setWin($('wSet').hidden);
  $('wSetX').onclick = () => setWin(false);
  $('wSetHead').addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    const r = $('wSet').getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    const mv = ev => { setPos = { x: ev.clientX - dx, y: ev.clientY - dy }; setPlace(); };
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); try { sessionStorage.setItem(SET_KEY, JSON.stringify(setPos)); } catch {} };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
  });
  addEventListener('resize', () => { if (!$('wSet').hidden) setPlace(); });

  // ---- code window: the three files in tabs; every keystroke redraws the widget here ----
  let codeWin = null;
  window.WidgetCode = {
    get open() { return !!o; },
    get title() { return $('wName').value.trim() || 'New widget'; },
    get files() { return files; },
    set(tab, text) {
      if (!o || files[tab] === text) return;
      files[tab] = text; changed();
      if (tab === 'settings') {
        try { const n = Widgets.parse(text); s = { ...n, values: n.values || {} }; if (n.name && n.name !== $('wName').value) $('wName').value = n.name; }
        catch (e) { return status(`${Widgets.FILES.settings}: ${e.message}`, true); }
        for (const k of Object.keys(links)) if (!Widgets.expand(s.inputs, links, true).some(i => i.key === k)) delete links[k];
        drawSlots(); drawSettings(); loadData(); return;
      }
      draw();
    },
    subscribe(f) { subs.add(f); return () => subs.delete(f); },
  };
  $('wCode').onclick = () => {
    if (codeWin && !codeWin.closed) return codeWin.focus();
    const W = Math.min(900, screen.availWidth), H = Math.min(820, screen.availHeight), L = (screen.availLeft ?? 0) + screen.availWidth - W, T = screen.availTop ?? 0;
    codeWin = window.open('widget-code.html', 'dn-widget-code', `popup,width=${W},height=${H},left=${L},top=${T}`);
    if (!codeWin) UI.toast('The browser blocked the code window. Allow pop-ups for this site.', 'err');
  };
  addEventListener('beforeunload', () => { try { codeWin?.close(); } catch {} });

  // ---- draw ----
  function status(msg, err) { $('wStatus').className = 'status' + (err ? ' err' : ''); $('wStatus').textContent = msg || ''; }
  // Redraw once per frame (60fps) while values change: the latest values win, nothing waits for a pause.
  let drawF = 0, busy = false, again = false;
  function draw() { if (!drawF) drawF = requestAnimationFrame(() => { drawF = 0; drawNow(); }); }
  async function drawNow() {
    if (drawF) { cancelAnimationFrame(drawF); drawF = 0; }
    if (!o) return;
    if (busy) { again = true; return; }   // one draw at a time; the next frame takes the newest values
    busy = true;
    try { await drawOnce(); } finally { busy = false; if (again) { again = false; draw(); } }
  }
  async function drawOnce() {
    try { await Widgets.draw($('wPv'), { key: 'edit', code: files.code, css: files.css, settings: s }, (rows || []).map(r => ({ ...r })), undefined, { links }); status(''); }
    catch (e) { status(`The widget failed: ${String(e.message || e).split('\n')[0]}`, true); }
  }
  $('wName').oninput = () => { changed(); syncSettingsText(); };

  // ---- save: Project, Global or both ----
  async function save() {
    if (syncF) { cancelAnimationFrame(syncF); syncF = 0; syncSettingsText(); }   // the newest values are in the file
    const name = $('wName').value.trim();
    if (!name) { $('wName').focus(); throw new Error('Enter a Widget name (above the widget) before you Save.'); }
    if (!isClean()) throw new Error('Attach a CLEAN_ dataset to save (SAMPLE_ data is preview only).');
    await Widgets.compile(files.code);   // a syntax error stops the save
    const where = await UI.dialog('Save widget', `<div class="savewhere">
        <label><input type="checkbox" name="project" checked> <b>Project</b><small>${esc(o.ctx.dir)}/dashboard/widgets/ (used by this dashboard)</small></label>
        <label><input type="checkbox" name="global"> <b>Global</b><small>${esc(Widgets.GLOBAL)}/ (other projects can copy it)</small></label></div>`,
      [{ label: 'Cancel', value: null, kind: 'ghost' }, { label: 'Save', submit: true, value: f => ({ project: f.project.checked, global: f.global.checked }) }]);
    if (!where) return;
    if (!where.project && !where.global) throw new Error('Tick Project, Global or both.');
    const wid = id || Widgets.slug(name);
    s.name = name; syncSettingsText();
    const targets = [where.project && `${Widgets.projectDir(o.ctx)}/${wid}`, where.global && `${Widgets.GLOBAL}/${wid}`].filter(Boolean);
    if (!id) for (const dir of targets) {
      if (await DNFS.exists(`${dir}/${Widgets.FILES.code}`).catch(() => false)
        && !await UI.confirm(`A widget "${wid}" already exists in ${dir}. Replace it?`, { danger: true, ok: 'Replace' })) return;
    }
    for (const dir of targets) await Widgets.write(dir, files);
    if (where.project) id = wid;
    dirty = false;
    o.ctx.log(`Widget saved: ${name} (${[where.project && 'project', where.global && 'global'].filter(Boolean).join(' + ')})`);
    UI.toast(`Saved "${name}"${where.project && where.global ? ' to the project and the global library' : where.global ? ' to the global library' : ''}.`, 'ok');
    await o.onSaved({ id: wid, dataset, links: JSON.parse(JSON.stringify(links)), size: { ...size }, project: where.project, global: where.global });
  }
  $('wSave').onclick = UI.guard(save);
  $('wClose').onclick = () => close();
  addEventListener('keydown', e => { if (e.key === 'Escape' && o && !document.querySelector('dialog[open]') && !DataWindow.isOpen() && $('wSet').hidden) close(); });

  // What a refresh needs to come back to the same place.
  const snapshot = () => o && { files: { ...files }, dataset, links: JSON.parse(JSON.stringify(links)), size: { ...size }, dirty,
    setOpen: !$('wSet').hidden, codeOpen: !!codeWin && !codeWin.closed };
  return { open, close, snapshot, get isOpen() { return !!o; } };
})();
