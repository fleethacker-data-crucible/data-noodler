// Data window (Widget Editor > Data): the datasets the widget can read (CLEAN_ of the project, SAMPLE_ for preview only).
// A small window inside the page, dragged by its header; each dataset expands into its fields grouped by type (Numbers,
// Text, Dates; A to Z). Drag a field onto the widget's slots (or the widget). Global: DataWindow. Look: ui/css/dashboard-studio.css.
//   DataWindow.open({ datasets: [{ key, name, note, columns: [{ name, type }] }], current: key, onClose, host })
//     host = a window of the page with .dw-q + .dw-list inside (the combined Data / Settings window): the Data part lives
//     there and that window is what opens / closes (the page places and moves it).
//     a dragged field carries 'text/x-field' = the column and 'text/x-dataset' = the dataset key.
//     onClose(): the window closed.
const DataWindow = (() => {
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const by = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
  const GROUPS = [['num', 'Numbers', '#'], ['text', 'Text', 'Aa'], ['date', 'Dates', 'D']];
  let el = null, args = null, open = new Set(), pos = null;
  // Open / closed, place and the page's own note (args.ctx, e.g. which chart) survive a refresh of the page (this tab).
  const KEY = 'dn-datawin:' + location.pathname;
  const remember = () => { try { sessionStorage.setItem(KEY, JSON.stringify({ open: isOpen(), pos, ctx: args?.ctx ?? null, expanded: [...open] })); } catch {} };
  try { const st = JSON.parse(sessionStorage.getItem(KEY) || 'null'); if (st) { pos = st.pos || null; open = new Set(st.expanded || []); } } catch {}
  // The saved state when the window was open at the last refresh: { ctx } (the page reopens it), else null.
  const wasOpen = () => { try { const st = JSON.parse(sessionStorage.getItem(KEY) || 'null'); return st?.open ? { ctx: st.ctx } : null; } catch { return null; } };

  let hosted = false;
  const wired = new WeakSet();
  function build() {
    el = document.createElement('div');
    el.className = 'dwin'; el.hidden = true;
    el.innerHTML = `<div class="dw-head sethead"><b>Data</b><button class="dw-x" title="Close (Esc)">×</button></div>
      <div class="dw-body">
        <input class="dw-q" type="search" placeholder="Search fields" spellcheck="false">
        <div class="dw-list"></div></div>`;
    document.body.append(el);
    wire(el);
    // Move: drag the header.
    el.querySelector('.dw-head').addEventListener('pointerdown', e => {
      if (e.button !== 0 || e.target.closest('button')) return;
      e.preventDefault();
      const r = el.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      const mv = ev => { pos = { x: Math.max(0, Math.min(innerWidth - 60, ev.clientX - dx)), y: Math.max(0, Math.min(innerHeight - 30, ev.clientY - dy)) }; place(); };
      const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); remember(); };
      addEventListener('pointermove', mv); addEventListener('pointerup', up);
    });
  }
  // The search box, the list (expand, drag a field) and the close button of a window (ours or a host).
  function wire(w) {
    if (wired.has(w)) return; wired.add(w);
    w.querySelector('.dw-x')?.addEventListener('click', close);
    w.querySelector('.dw-q').oninput = draw;
    const list = w.querySelector('.dw-list');
    list.addEventListener('click', e => {
      const h = e.target.closest('.dw-ds > .dw-dh'); if (!h) return;
      const k = h.parentElement.dataset.key, was = open.has(k); open.clear(); if (!was) open.add(k); draw(); remember();   // one table open at a time
    });
    list.addEventListener('dragstart', e => {
      const c = e.target.closest('.dw-f'); if (!c) return;
      e.dataTransfer.setData('text/x-field', c.dataset.col); e.dataTransfer.setData('text/x-dataset', c.closest('.dw-ds').dataset.key);
      e.dataTransfer.effectAllowed = 'copy'; document.body.classList.add('dragging');
    });
    list.addEventListener('dragend', () => document.body.classList.remove('dragging'));
  }
  addEventListener('keydown', e => { if (e.key === 'Escape' && el && !el.hidden && !document.querySelector('dialog[open]') && !e.target.closest?.('input, textarea')) close(); });
  function place() {
    if (!pos) pos = { x: 24, y: 96 };
    Object.assign(el.style, { left: `${pos.x}px`, top: `${pos.y}px` });
  }
  function draw() {
    if (!el || !args) return;
    const q = el.querySelector('.dw-q').value.trim().toLowerCase(), list = el.querySelector('.dw-list');
    const ds = args.datasets || [];
    list.innerHTML = ds.map(d => {
      const cols = (d.columns || []).filter(c => !q || c.name.toLowerCase().includes(q));
      const shown = open.has(d.key) || (q && cols.length);
      if (q && !cols.length) return '';
      const body = !shown ? '' : GROUPS.map(([k, label, mark]) => {
        const g = cols.filter(c => SettingsPanel.kindOf(c.type) === k).sort(by);
        return g.length ? `<div class="dw-g"><div class="dw-gh">${label}<small>${g.length}</small></div>${g.map(c =>
          `<div class="dw-f ${k}" draggable="true" data-col="${esc(c.name)}" title="${esc(c.name)} (${esc(c.type)}): drag onto a slot"><span class="t">${mark}</span><span>${esc(c.name)}</span></div>`).join('')}</div>` : '';
      }).join('');
      return `<div class="dw-ds ${d.key === args.current ? 'cur' : ''}" data-key="${esc(d.key)}"><div class="dw-dh ${esc(d.note || '')}" title="${esc(d.key)}"><span class="dw-tw ${shown ? 'on' : ''}">▾</span><span class="dw-dn">${esc(d.name)}</span>${d.note ? `<small>${esc(d.note)}</small>` : ''}</div>${body}</div>`;
    }).join('') || `<div class="dw-none">${ds.length ? 'No field matches.' : 'No datasets yet: run a Transform (CLEAN_), or add SAMPLE_ files to workspace/sample-data.'}</div>`;
  }
  function show(a) {
    if (a.host) { if (el && el !== a.host && !hosted) el.hidden = true; el = a.host; hosted = true; wire(el); }
    else if (!el || hosted) { hosted = false; build(); }
    args = a;
    open.clear();   // opens with every table collapsed
    el.hidden = false; if (!hosted) place(); draw(); remember();
  }
  // Keep the open window in step with the page (another chart picked, a field linked).
  function update(a) { if (el && !el.hidden) { args = { ...args, ...a }; draw(); remember(); } }
  function close() { if (el && !el.hidden) { el.hidden = true; remember(); args?.onClose?.(); } }
  const isOpen = () => !!el && !el.hidden;
  return { open: show, update, close, isOpen, wasOpen };
})();
