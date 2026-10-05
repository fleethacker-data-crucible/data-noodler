// User drop-downs fed by config/users.json (edited in the server panel's User Access dialog). Global: UserPicker.
//   await UserPicker.load()                       fetch the user list (call before building a form)
//   UserPicker.html({ name, label, value, multi }) field HTML; single -> hidden input = display name,
//                                                  multi -> hidden input = JSON array of display names
//   UserPicker.bind(rootEl)                       wire every picker inside rootEl (UI.dialog calls this)
//   UserPicker.parse(v)                           JSON array string -> array
const UserPicker = (() => {
  let users = [];
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Same format as the server panel: "Last, First M. TYPE" (type omitted for N/A).
  const display = u => u.last ? `${u.last}, ${u.first || ''}${u.middle ? ' ' + u.middle.toUpperCase() + '.' : ''}${u.type && u.type.toUpperCase() !== 'N/A' ? ' ' + u.type.toUpperCase() : ''}` : u.display;
  const names = () => users.map(display).filter(Boolean).sort((a, b) => a.localeCompare(b));

  async function load() {
    try { const r = await fetch('/config/users.json', { cache: 'no-store' }); users = r.ok ? await r.json() : []; }
    catch { users = []; }
    return names();
  }
  const parse = v => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };

  function html(f) {
    if (f.multi) {
      const list = Array.isArray(f.value) ? f.value : parse(f.value);
      return `<div class="field upick multi" data-name="${f.name}">${esc(f.label)}
        <input type="hidden" name="${f.name}" value="${esc(JSON.stringify(list))}">
        <div class="ubox"><button type="button" class="uopen">Add</button>${menu()}</div>
        <div class="chips"></div></div>`;
    }
    return `<div class="field upick" data-name="${f.name}">${esc(f.label)}
      <input type="hidden" name="${f.name}" value="${esc(f.value || '')}">
      <div class="ubox"><button type="button" class="usel uopen"><span></span><i>▾</i></button>${menu()}</div></div>`;
  }
  const menu = () => `<div class="umenu" hidden><input type="search" class="uq" placeholder="Search users"><div class="uitems"></div></div>`;

  function bind(root) {
    root.querySelectorAll('.upick').forEach(el => {
      const hidden = el.querySelector('input[type=hidden]'), multi = el.classList.contains('multi');
      const m = el.querySelector('.umenu'), q = el.querySelector('.uq'), items = el.querySelector('.uitems');
      const chosen = () => multi ? parse(hidden.value) : [hidden.value].filter(Boolean);
      const show = () => {
        if (multi) el.querySelector('.chips').innerHTML = [...chosen()].sort((a, b) => a.localeCompare(b)).map(n => `<span class="chip">${esc(n)}<button type="button" data-rm="${esc(n)}" title="Remove">✕</button></span>`).join('');
        else el.querySelector('.usel span').innerHTML = hidden.value ? esc(hidden.value) : '<span class="muted">Select owner</span>';
      };
      const fill = () => {
        const s = q.value.trim().toLowerCase(), have = chosen();
        const list = names().filter(n => n.toLowerCase().includes(s) && !(multi && have.includes(n)));
        items.innerHTML = list.map(n => `<div class="${!multi && n === hidden.value ? 'sel' : ''}" data-n="${esc(n)}">${esc(n)}</div>`).join('')
          || `<div class="muted empty">${users.length ? 'No match' : 'No users. Add them in the server panel (User Access).'}</div>`;
      };
      const close = () => { m.hidden = true; };
      el.querySelector('.uopen').onclick = () => { if (!m.hidden) return close(); root.querySelectorAll('.umenu').forEach(x => x.hidden = true); m.hidden = false; q.value = ''; fill(); q.focus(); };
      q.oninput = fill;
      q.onkeydown = ev => {
        if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); }
        if (ev.key === 'Enter') { ev.preventDefault(); items.querySelector('[data-n]')?.click(); }
      };
      // Keep focus in the search box while picking, so the focus-outside check doesn't close the menu first.
      items.onmousedown = ev => ev.preventDefault();
      items.onclick = ev => {
        const n = ev.target.closest('[data-n]')?.dataset.n; if (!n) return;
        hidden.value = multi ? JSON.stringify([...chosen(), n].sort((a, b) => a.localeCompare(b))) : n;
        close(); show();
      };
      if (multi) el.querySelector('.chips').onclick = ev => {
        const n = ev.target.closest('[data-rm]')?.dataset.rm; if (n == null) return;
        hidden.value = JSON.stringify(chosen().filter(x => x !== n)); show();
      };
      // Clicks anywhere outside close it (backdrop too); focus moving to another field closes it,
      // but focus landing on the dialog itself (a click on plain space) is handled by the click.
      const outside = ev => { if (!m.hidden && !el.contains(ev.target)) close(); };
      const focusOut = ev => { if (!m.hidden && !el.contains(ev.target) && ev.target !== root) close(); };
      document.addEventListener('pointerdown', outside, true);
      document.addEventListener('focusin', focusOut, true);
      new MutationObserver((_, o) => { if (!root.isConnected) { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('focusin', focusOut, true); o.disconnect(); } })
        .observe(document.body, { childList: true });
      show();
    });
  }
  return { load, html, bind, parse, names };
})();
