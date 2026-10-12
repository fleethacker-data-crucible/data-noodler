// Edit Data window (Chart Builder and Dashboard Builder: Right-click a chart > Edit Data). A small window inside the page,
// dragged by its header: the clean datasets, each one expands into its fields grouped by type (Numbers, Text, Dates; A to Z
// in each). Drag a field onto the chart's X / Y slots (or the chart). Global: DataWindow. Look: ui/css/chart-studio.css.
//   DataWindow.open({ datasets: [{ key, name, note, columns: [{ name, type }] }], current: key, onSample })
//     a dragged field carries 'text/x-field' = the column and 'text/x-dataset' = the dataset key.
//     onRandom(): Randomize selected sample (button at the top; shown when given). samples: [label] sample sets (sample = the index in use); onSample(i): one was clicked (the page drops its fields and shows the sample rows). onClose(): the window closed.
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

  function build() {
    el = document.createElement('div');
    el.className = 'dwin'; el.hidden = true;
    el.innerHTML = `<div class="dw-head"><b>Edit Data</b><button class="dw-x" title="Close (Esc)">×</button></div>
      <div class="dw-body"><button class="dw-rand" hidden title="New random values for the sample set in use (same bars, same size of numbers): to see the chart move">Randomize selected sample</button>
        <input class="dw-q" type="search" placeholder="Search fields" spellcheck="false">
        <div class="dw-samples"></div>
        <div class="dw-list"></div></div>`;
    document.body.append(el);
    el.querySelector('.dw-x').onclick = close;
    el.querySelector('.dw-q').oninput = draw;
    el.querySelector('.dw-rand').onclick = () => args?.onRandom?.();
    el.querySelector('.dw-samples').addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (b) args?.onSample?.(+b.dataset.i); });
    // Move: drag the header.
    el.querySelector('.dw-head').addEventListener('pointerdown', e => {
      if (e.button !== 0 || e.target.closest('button')) return;
      e.preventDefault();
      const r = el.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      const mv = ev => { pos = { x: Math.max(0, Math.min(innerWidth - 60, ev.clientX - dx)), y: Math.max(0, Math.min(innerHeight - 30, ev.clientY - dy)) }; place(); };
      const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); remember(); };
      addEventListener('pointermove', mv); addEventListener('pointerup', up);
    });
    const list = el.querySelector('.dw-list');
    list.addEventListener('click', e => {
      const h = e.target.closest('.dw-ds > .dw-dh'); if (!h) return;
      const k = h.parentElement.dataset.key; open.has(k) ? open.delete(k) : open.add(k); draw(); remember();
    });
    list.addEventListener('dragstart', e => {
      const c = e.target.closest('.dw-f'); if (!c) return;
      e.dataTransfer.setData('text/x-field', c.dataset.col); e.dataTransfer.setData('text/x-dataset', c.closest('.dw-ds').dataset.key);
      e.dataTransfer.effectAllowed = 'copy'; document.body.classList.add('dragging');
    });
    list.addEventListener('dragend', () => document.body.classList.remove('dragging'));
    addEventListener('keydown', e => { if (e.key === 'Escape' && el && !el.hidden && !document.querySelector('dialog[open]')) close(); });
  }
  function place() {
    if (!pos) pos = { x: 24, y: 96 };
    Object.assign(el.style, { left: `${pos.x}px`, top: `${pos.y}px` });
  }
  function draw() {
    if (!el || !args) return;
    const q = el.querySelector('.dw-q').value.trim().toLowerCase(), list = el.querySelector('.dw-list');
    el.querySelector('.dw-rand').hidden = !args.onRandom;
    const ds = args.datasets || [], ss = args.samples?.length ? args.samples : ['Sample data'];
    // Sample data: one button per sample set (the one in use is blue while no dataset is linked).
    el.querySelector('.dw-samples').innerHTML = `<div class="dw-gh">Sample data</div>` + ss.map((t, i) => `<button class="ghost small dw-s ${!args.current && (args.sample || 0) === i ? 'on' : ''}" data-i="${i}" title="Drop the fields: the chart shows these sample rows">${esc(t)}</button>`).join('');
    list.innerHTML = ds.map(d => {
      const cols = (d.columns || []).filter(c => !q || c.name.toLowerCase().includes(q));
      const shown = open.has(d.key) || (q && cols.length);
      if (q && !cols.length) return '';
      const body = !shown ? '' : GROUPS.map(([k, label, mark]) => {
        const g = cols.filter(c => ChartPanel.kindOf(c.type) === k).sort(by);
        return g.length ? `<div class="dw-g"><div class="dw-gh">${label}<small>${g.length}</small></div>${g.map(c =>
          `<div class="dw-f ${k}" draggable="true" data-col="${esc(c.name)}" title="${esc(c.name)} (${esc(c.type)}): drag onto X or Y"><span class="t">${mark}</span><span>${esc(c.name)}</span></div>`).join('')}</div>` : '';
      }).join('');
      return `<div class="dw-ds ${d.key === args.current ? 'cur' : ''}" data-key="${esc(d.key)}"><div class="dw-dh"><span class="dw-tw ${shown ? 'on' : ''}">▾</span><span class="dw-dn">${esc(d.name)}</span>${d.note ? `<small>${esc(d.note)}</small>` : ''}</div>${body}</div>`;
    }).join('') || `<div class="dw-none">${ds.length ? 'No field matches.' : 'No clean datasets yet. Run a Transform to make one (CLEAN_).'}</div>`;
  }
  function show(a) {
    if (!el) build();
    args = a;
    if (a.current) open.add(a.current);
    el.hidden = false; place(); draw(); remember();
  }
  // Keep the open window in step with the page (another chart picked, a field linked).
  function update(a) { if (el && !el.hidden) { args = { ...args, ...a }; draw(); remember(); } }
  function close() { if (el && !el.hidden) { el.hidden = true; remember(); args?.onClose?.(); } }
  const isOpen = () => !!el && !el.hidden;
  return { open: show, update, close, isOpen, wasOpen };
})();
