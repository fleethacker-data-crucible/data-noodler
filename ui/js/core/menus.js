// Drop-down menus on every page (look: ui/css/theme.css .dd-wrap / .dd-menu). Global: Menus.
//   <span class="dd-wrap"><button>Name ▾</button><div class="dd-menu">
//     <div data-act="x">Item<small>tip, shown only while Shift is held</small></div> ... </div></span>
//   Menus.bind(button, menu, onPick(act, ev))  the button opens / closes it; picking an item closes it (.off items do nothing)
//     Items are [data-act] (or [data-fmt]; onPick gets that value). Keyboard (WAI-ARIA menu button): Enter / Space / Down / Up on the
//     button opens it; Down / Up / Home / End move between items (.off ones are skipped), a typed letter jumps to the next item starting
//     with it, Enter / Space picks, Escape or Tab closes and focus goes back to the button. Roles and aria-expanded are set here.
//   Menus.open(menu, ev) / Menus.close(menu) / Menus.closeAll()
//   Menus.sort(menu)   items A to Z by name (.last ones stay last)
//   Menus.tips(menu, on)
// Shift held while a menu is open shows every item's tip; the menu doubles its width so they fit (kept on screen).
const Menus = (() => {
  function tips(m, on) {
    if (on === m.classList.contains('tips')) return;
    if (!on) { m.classList.remove('tips'); m.style.width = ''; return; }
    const w = Math.min(m.offsetWidth * 2, innerWidth - 8);
    m.classList.add('tips'); m.style.width = `${w}px`;
    const r = m.getBoundingClientRect();
    if (r.right > innerWidth - 4) {
      if (getComputedStyle(m).position === 'fixed') m.style.left = `${Math.max(4, innerWidth - 4 - w)}px`;
      else m.style.width = `${Math.max(m.offsetWidth / 2, innerWidth - 4 - r.left)}px`;
    }
  }
  function sort(m) {
    const name = d => (d.firstChild?.textContent || '').trim();
    [...m.querySelectorAll(':scope > div[data-act], :scope > div[data-pkg]')]
      .sort((a, b) => a.classList.contains('last') - b.classList.contains('last') || name(a).localeCompare(name(b), undefined, { sensitivity: 'base' }))
      .forEach(d => m.append(d));
  }
  const ITEM = '[data-act], [data-fmt]';
  const items = m => [...m.querySelectorAll(`:scope > ${ITEM.split(', ').join(', :scope > ')}`)];
  const live = m => items(m).filter(d => !d.classList.contains('off'));   // what the arrow keys visit
  function prep(m) {   // roles + roving tabindex; items can be added or sorted after bind, so this runs on every open
    items(m).forEach(d => {
      d.setAttribute('role', 'menuitem'); d.setAttribute('tabindex', '-1');
      if (d.classList.contains('off')) d.setAttribute('aria-disabled', 'true'); else d.removeAttribute('aria-disabled');
    });
  }
  function sync(m, isOpen) { m._btn?.setAttribute('aria-expanded', isOpen ? 'true' : 'false'); }
  function focusItem(m, d) { if (!d) return; items(m).forEach(x => x.setAttribute('tabindex', x === d ? '0' : '-1')); d.focus(); }
  function open(m, ev) { m.classList.add('open'); tips(m, false); if (ev?.shiftKey) tips(m, true); prep(m); sync(m, true); }
  function close(m) {
    const hadFocus = m.contains(m.ownerDocument.activeElement);
    m.classList.remove('open'); tips(m, false); sync(m, false);
    if (hadFocus) m._btn?.focus();   // keyboard users land back on the trigger
  }
  const closeAll = () => document.querySelectorAll('.dd-menu.open').forEach(close);
  let uid = 0;
  function bind(btn, m, onPick) {
    m._btn = btn;
    if (!btn.id) btn.id = `dd-btn-${++uid}`;
    btn.setAttribute('aria-haspopup', 'menu'); sync(m, m.classList.contains('open'));
    m.setAttribute('role', 'menu'); m.setAttribute('aria-labelledby', btn.id);
    prep(m);
    btn.addEventListener('click', ev => {
      ev.stopPropagation(); const was = m.classList.contains('open'); closeAll(); if (!was) open(m, ev);
      if (!was && ev.detail === 0) focusItem(m, live(m)[0]);   // opened from the keyboard (Enter / Space): go into the menu
    });
    btn.addEventListener('keydown', ev => {
      const isOpen = m.classList.contains('open');
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault(); ev.stopPropagation();
        if (!isOpen) { closeAll(); open(m, ev); }
        const l = live(m); focusItem(m, ev.key === 'ArrowDown' ? l[0] : l[l.length - 1]);
      } else if (ev.key === 'Escape' && isOpen) { ev.preventDefault(); ev.stopPropagation(); close(m); }
    });
    let typed = '', typedAt = 0;
    m.addEventListener('keydown', ev => {
      if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
      if (Date.now() - typedAt > 700) typed = '';
      const l = live(m), cur = l.indexOf(ev.target.closest?.(ITEM)), k = ev.key, stop = () => { ev.preventDefault(); ev.stopPropagation(); };
      if (k === 'ArrowDown') { stop(); focusItem(m, l[(cur + 1) % l.length]); }
      else if (k === 'ArrowUp') { stop(); focusItem(m, l[cur < 0 ? l.length - 1 : (cur - 1 + l.length) % l.length]); }
      else if (k === 'Home') { stop(); focusItem(m, l[0]); }
      else if (k === 'End') { stop(); focusItem(m, l[l.length - 1]); }
      else if (k === 'Escape') { stop(); close(m); }
      else if (k === 'Tab') close(m);   // focus returns to the trigger and Tab then moves on from it
      else if ((k === 'Enter' || (k === ' ' && !typed)) && cur >= 0) { stop(); l[cur].click(); }
      else if (k.length === 1 && (k.trim() || typed)) {   // type-ahead (a space only counts inside a word being typed)
        stop();
        const now = Date.now(); typed += k.toLowerCase(); typedAt = now;
        const name = d => (d.firstChild?.textContent || '').trim().toLowerCase();
        const from = typed.length > 1 ? Math.max(cur, 0) : cur + 1;   // same letter again steps to the next match
        const order = [...l.slice(from), ...l.slice(0, from)];
        focusItem(m, order.find(d => name(d).startsWith(typed)));
      }
    });
    m.addEventListener('click', ev => {
      ev.stopPropagation();
      const it = ev.target.closest(ITEM); if (!it || it.classList.contains('off')) return;
      close(m); onPick?.(it.dataset.act ?? it.dataset.fmt, ev);
    });
  }
  addEventListener('click', closeAll);
  addEventListener('keydown', e => { if (e.key === 'Shift') document.querySelectorAll('.dd-menu.open').forEach(m => tips(m, true)); });
  addEventListener('keyup', e => { if (e.key === 'Shift') document.querySelectorAll('.dd-menu').forEach(m => tips(m, false)); });
  addEventListener('blur', () => document.querySelectorAll('.dd-menu').forEach(m => tips(m, false)));
  return { bind, open, close, closeAll, sort, tips };
})();
