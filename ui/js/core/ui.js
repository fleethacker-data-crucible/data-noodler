// Shared UI helpers. Global: UI.
//   UI.toast('Saved', 'ok')                      bottom-right message (kind: '', 'ok', 'err')
//   await UI.confirm('Delete?', { danger: true, ok, cancel }) true / false (styled dialog; the browser's confirm() is not used)
//   await UI.form('New project', fields)         { values } or null; fields = [{ name, label, type, value, options, required }]
//   UI.dataTable(el, cols, rows)                 query results as a table
const UI = (() => {
  const $ = id => document.getElementById(id) || [...(window.DNPopped || [])].map(d => d.getElementById(id)).find(Boolean) || null;   // also inside a popped-out table window
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Notifications, every window (look: ui/css/theme.css .toast, as in the Server Control panel): the newest drops in at the
  // top, older ones move down. kind: 'ok' green, 'warn' orange, 'err' / 'error' red, anything else white (info). 5 s or X.
  let toasts;
  // Notifications are always the top layer: a manual popover sits in the browser's top layer (above open dialogs, which
  // no z-index can beat), and is shown again whenever a notification appears or any dialog / popover opens later.
  function raise() {
    if (!toasts?.isConnected || !toasts.showPopover) return;
    toasts.popover = 'manual';
    try { if (toasts.matches(':popover-open')) toasts.hidePopover(); toasts.showPopover(); } catch {}
  }
  new MutationObserver(ms => { if (toasts?.childElementCount && ms.some(m => m.target !== toasts && m.target.hasAttribute?.('open'))) raise(); })
    .observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['open'] });
  document.addEventListener('toggle', e => { if (e.target !== toasts && e.newState === 'open' && toasts?.childElementCount) raise(); }, true);   // popovers
  function toast(msg, kind = '', ms = 5000) {
    if (kind === 'error') kind = 'err';
    // One problem, one notification: a failed step logs "X failed: <reason>" and its handler then shows "<reason>".
    const now = Date.now(), m = String(msg);
    if (toasts?.isConnected && [...toasts.children].some(t => now - t._at < 3000 && t._kind === kind && (t._msg.includes(m) || m.includes(t._msg)))) return;
    if (!toasts?.isConnected) toasts = document.body.appendChild(Object.assign(document.createElement('div'), { className: 'toasts' }));
    // Always on top: a manual popover lives in the browser's top layer (above open dialogs, which no z-index can beat);
    // shown again on every notification so it is the newest top-layer item, above any dialog opened since.
    raise();
    const t = Object.assign(document.createElement('div'), { _at: now, _kind: kind, _msg: m }); t.className = `toast ${kind}`;
    t.innerHTML = `<span>${esc(msg)}</span><button class="x" title="Dismiss">&times;</button>`;
    t.querySelector('.x').onclick = () => t.remove();
    toasts.prepend(t);
    setTimeout(() => t.remove(), ms);
  }

  // A modal <dialog>. body = HTML string; buttons = [{ label, value, kind }]. Resolves with the clicked value (null on Esc).
  function dialog(title, body, buttons) {
    return new Promise(res => {
      const d = document.createElement('dialog');
      d.innerHTML = `<header>${esc(title)}</header><form method="dialog"><div class="body">${body}</div><footer>${
        buttons.map((b, i) => `<button value="${i}" class="${b.kind || ''}" ${b.submit ? '' : 'formnovalidate'}>${esc(b.label)}</button>`).join('')}</footer></form>`;
      document.body.append(d);
      const form = d.querySelector('form');
      // Handle the submit itself (the dialog 'close' event is not reliable in every embedded browser).
      let done = false;
      const finish = i => {
        if (done) return; done = true;
        const b = buttons[+i];
        const out = b ? (typeof b.value === 'function' ? b.value(form) : b.value) : null;
        if (d.open) d.close();
        d.remove(); res(out);
      };
      form.addEventListener('submit', ev => { ev.preventDefault(); finish(ev.submitter?.value); });
      d.addEventListener('cancel', ev => { ev.preventDefault(); finish(null); });
      d.addEventListener('keydown', ev => { if (ev.key === 'Escape') { ev.preventDefault(); finish(null); } });
      if (typeof UserPicker !== 'undefined') UserPicker.bind(d);
      d.showModal();
      d.querySelector('input, select, textarea')?.focus();
    });
  }
  const confirm = (msg, { danger = false, ok = 'OK', cancel = 'Cancel' } = {}) =>
    dialog('Confirm', `<div>${esc(msg)}</div>`, [{ label: cancel, value: false, kind: 'ghost' }, { label: ok, value: true, kind: danger ? 'danger' : '' }]);
  const alert = (title, msg) => dialog(title, `<div>${esc(msg)}</div>`, [{ label: 'OK', value: true }]);

  function fieldHtml(f) {
    const v = esc(f.value ?? ''), req = f.required ? 'required' : '';
    if (f.type === 'user' || f.type === 'users') return UserPicker.html({ ...f, multi: f.type === 'users' });
    if (f.type === 'select') return `<label class="field">${esc(f.label)}<select name="${f.name}">${f.options.map(o => { const [val, lab] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(val)}" ${String(val) === String(f.value) ? 'selected' : ''}>${esc(lab)}</option>`; }).join('')}</select></label>`;
    if (f.type === 'textarea') return `<label class="field">${esc(f.label)}<textarea name="${f.name}" ${req}>${v}</textarea></label>`;
    return `<label class="field">${esc(f.label)}<input name="${f.name}" type="${f.type || 'text'}" value="${v}" ${req} ${f.pattern ? `pattern="${f.pattern}"` : ''} placeholder="${esc(f.placeholder || '')}"></label>`;
  }
  // Form dialog: resolves { name: value, ... } or null when cancelled.
  const form = (title, fields, { ok = 'Save' } = {}) => dialog(title, fields.map(fieldHtml).join(''), [
    { label: 'Cancel', value: null, kind: 'ghost' },
    { label: ok, submit: true, kind: /^save/i.test(ok) ? 'go' : '', value: f => Object.fromEntries(new FormData(f)) },
  ]);

  // ---- formatting ----
  const num = v => v == null ? '' : Number(v).toLocaleString();
  const bytes = b => b >= 1073741824 ? (b / 1073741824).toFixed(2) + ' GB' : b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b >= 1024 ? Math.round(b / 1024) + ' KB' : (b || 0) + ' B';
  const ms = v => (v / 1000).toFixed(1) + ' s';   // every timer: seconds, 1 decimal
  const date = iso => iso ? new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '';
  const rows = n => n >= 1e9 ? +(n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? +(n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? +(n / 1e3).toFixed(1) + 'k' : String(n);

  // Query results as an HTML table. rows = arrays of plain values.
  function dataTable(el, cols, data, { max = 500 } = {}) {
    el.innerHTML = `<div class="table-wrap"><table class="grid data"><thead><tr>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${
      data.slice(0, max).map(r => `<tr>${r.map(v => v == null ? '<td class="null">null</td>' : `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` +
      (data.length > max ? `<div class="muted" style="margin-top:4px">Showing ${max} of ${num(data.length)} rows.</div>` : '');
  }

  // Wrap an async handler: errors become a red toast instead of a silent failure.
  const guard = fn => async (...a) => { try { return await fn(...a); } catch (e) { console.error(e); toast(e.message || String(e), 'err'); } };
  const debounce = (fn, wait = 200) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), wait); }; };
  // Log time stamp: yyyy-mm-dd hh:mm:ss, 24 h, local time.
  const stamp = (d = new Date()) => { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
  const params = () => Object.fromEntries(new URLSearchParams(location.search));

  // Table scrollbars stay hidden until the mouse is within 10px of one. The vertical one is drawn
  // as an overlay thumb (native bar has zero width) so it sits over the rows, below the sticky header.
  function vthumb(w) {
    let t = w.querySelector(':scope > .vthumb');
    if (!t) {
      t = w.appendChild(Object.assign(document.createElement('div'), { className: 'vthumb' }));
      w.addEventListener('scroll', () => placeThumb(w), { passive: true });
      t.addEventListener('mousedown', e => {
        e.preventDefault(); t.classList.add('drag');
        const y0 = e.clientY, s0 = w.scrollTop, g = w._thumb;
        const move = ev => { w.scrollTop = s0 + (ev.clientY - y0) * (w.scrollHeight - w.clientHeight) / Math.max(1, g.track - g.h); };
        const up = () => { t.classList.remove('drag'); removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
        addEventListener('mousemove', move); addEventListener('mouseup', up);
      });
    }
    return t;
  }
  function placeThumb(w) {
    const t = vthumb(w), over = w.scrollHeight > w.clientHeight;
    t.hidden = !over; if (!over) return;
    const head = w.querySelector('thead')?.offsetHeight || 0, track = w.clientHeight - head - 4;
    const h = Math.max(24, track * w.clientHeight / w.scrollHeight);
    const top = head + 2 + (track - h) * w.scrollTop / (w.scrollHeight - w.clientHeight);
    w._thumb = { track, h };
    Object.assign(t.style, { height: h + 'px', top: w.scrollTop + top + 'px', left: w.scrollLeft + w.clientWidth - 8 + 'px' });
  }
  document.addEventListener('mousemove', e => {
    for (const w of document.querySelectorAll('.table-wrap')) {
      placeThumb(w);
      const r = w.getBoundingClientRect(), sb = 10;
      const inY = e.clientY >= r.top - sb && e.clientY <= r.bottom + sb, inX = e.clientX >= r.left - sb && e.clientX <= r.right + sb;
      const nearV = w.scrollHeight > w.clientHeight && inY && Math.abs(r.right - 4 - e.clientX) <= sb + 4;
      const nearH = w.scrollWidth > w.clientWidth && inX && Math.abs(r.bottom - 5 - e.clientY) <= sb + 5;
      w.classList.toggle('near', nearV || nearH);
    }
  }, { passive: true });

  return { $, esc, stamp, toast, dialog, confirm, alert, form, num, bytes, ms, date, rows, dataTable, guard, debounce, params };
})();
