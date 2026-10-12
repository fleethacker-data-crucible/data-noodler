// Drop-down menus on every page (look: ui/css/theme.css .dd-wrap / .dd-menu). Global: Menus.
//   <span class="dd-wrap"><button>Name ▾</button><div class="dd-menu">
//     <div data-act="x">Item<small>tip, shown only while Shift is held</small></div> ... </div></span>
//   Menus.bind(button, menu, onPick(act, ev))  the button opens / closes it; picking an item closes it (.off items do nothing)
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
  function open(m, ev) { m.classList.add('open'); tips(m, false); if (ev?.shiftKey) tips(m, true); }
  function close(m) { m.classList.remove('open'); tips(m, false); }
  const closeAll = () => document.querySelectorAll('.dd-menu.open').forEach(close);
  function bind(btn, m, onPick) {
    btn.addEventListener('click', ev => { ev.stopPropagation(); const was = m.classList.contains('open'); closeAll(); if (!was) open(m, ev); });
    m.addEventListener('click', ev => {
      ev.stopPropagation();
      const it = ev.target.closest('[data-act]'); if (!it || it.classList.contains('off')) return;
      close(m); onPick?.(it.dataset.act, ev);
    });
  }
  addEventListener('click', closeAll);
  addEventListener('keydown', e => { if (e.key === 'Shift') document.querySelectorAll('.dd-menu.open').forEach(m => tips(m, true)); });
  addEventListener('keyup', e => { if (e.key === 'Shift') document.querySelectorAll('.dd-menu').forEach(m => tips(m, false)); });
  addEventListener('blur', () => document.querySelectorAll('.dd-menu').forEach(m => tips(m, false)));
  return { bind, open, close, closeAll, sort, tips };
})();
