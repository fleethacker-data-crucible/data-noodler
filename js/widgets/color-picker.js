// Colour picker for the widget settings popout. Global: ColorPicker.
//   const el = ColorPicker.swatch(value, { onInput(v), onChange(v), allowTheme: true })   // value '#rrggbb' or null (= theme default)
// Click the swatch: saturation/brightness square, hue strip, hex field, theme palette and recent colours.
// Dragging calls onInput continuously (live preview); releasing / picking calls onChange.
const ColorPicker = (() => {
  const RECENT = 'dn-recent-colors';
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  function hexToRgb(h) {
    h = String(h || '').replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const n = parseInt(h.slice(0, 6), 16);
    return isNaN(n) || h.length < 6 ? null : [n >> 16 & 255, n >> 8 & 255, n & 255];
  }
  const rgbToHex = (r, g, b) => '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [(h * 60 + 360) % 360, mx ? d / mx : 0, mx];
  }
  function hsvToRgb(h, s, v) {
    const f = n => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
    return [f(5) * 255, f(3) * 255, f(1) * 255];
  }
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  // Named colours ('steelblue') -> hex, via the browser.
  function toHex(v) {
    if (!v) return null;
    if (hexToRgb(v)) return '#' + String(v).replace('#', '').slice(0, 6).toLowerCase().replace(/^(.)(.)(.)$/, '$1$1$2$2$3$3');
    const c = document.createElement('canvas').getContext('2d'); c.fillStyle = '#000'; c.fillStyle = v;
    return /^#/.test(c.fillStyle) ? c.fillStyle : null;
  }
  const recent = () => { try { return JSON.parse(localStorage.getItem(RECENT)) || []; } catch { return []; } };
  const remember = h => { try { localStorage.setItem(RECENT, JSON.stringify([h, ...recent().filter(x => x !== h)].slice(0, 8))); } catch {} };

  let pop = null;
  function close() { if (pop) { pop._done?.(); pop.remove(); pop = null; } }
  addEventListener('pointerdown', e => { if (pop && !pop.contains(e.target) && !e.target.closest('.cp-sw')) close(); }, true);
  addEventListener('keydown', e => { if (e.key === 'Escape' && pop) { e.stopPropagation(); close(); } }, true);

  function open(anchor, value, { onInput, onChange, allowTheme }) {
    close();
    let [h, s, v] = rgbToHsv(...(hexToRgb(toHex(value) || css('--c1')) || [57, 135, 229]));
    let changedVal;
    pop = document.createElement('div');
    pop.className = 'cp-pop';
    const theme = [1, 2, 3, 4, 5, 6, 7, 8].map(i => toHex(css(`--c${i}`))).concat([toHex(css('--text')), toHex(css('--text-2')), toHex(css('--muted')), toHex(css('--panel'))]);
    pop.innerHTML = `<div class="cp-sv"><div class="cp-dot"></div></div><div class="cp-hue"><div class="cp-knob"></div></div>
      <div class="cp-row"><span class="cp-prev"></span><input class="cp-hex" spellcheck="false" maxlength="7">${allowTheme ? '<button class="ghost small cp-theme" title="Use the global theme colour">Theme</button>' : ''}</div>
      <div class="cp-lbl">Theme palette</div><div class="cp-pal">${theme.map(c => `<button class="cp-c" data-c="${c}" style="background:${c}" title="${c}"></button>`).join('')}</div>
      ${recent().length ? `<div class="cp-lbl">Recent</div><div class="cp-pal">${recent().map(c => `<button class="cp-c" data-c="${c}" style="background:${c}" title="${c}"></button>`).join('')}</div>` : ''}`;
    document.body.append(pop);
    const r = anchor.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
    pop.style.left = clamp(r.right - pw, 8, innerWidth - pw - 8) + 'px';
    pop.style.top = (r.bottom + 6 + ph > innerHeight ? Math.max(8, r.top - ph - 6) : r.bottom + 6) + 'px';
    const sv = pop.querySelector('.cp-sv'), dot = pop.querySelector('.cp-dot'), hue = pop.querySelector('.cp-hue'), knob = pop.querySelector('.cp-knob');
    const hex = pop.querySelector('.cp-hex'), prev = pop.querySelector('.cp-prev');
    let frame = 0;
    const cur = () => rgbToHex(...hsvToRgb(h, s, v));
    function paint(fromHex) {
      sv.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${h} 100% 50%))`;
      dot.style.left = s * 100 + '%'; dot.style.top = (1 - v) * 100 + '%'; dot.style.background = cur();
      knob.style.left = h / 360 * 100 + '%'; knob.style.background = `hsl(${h} 100% 50%)`;
      prev.style.background = cur(); if (!fromHex) hex.value = cur();
    }
    const emit = () => { changedVal = cur(); if (!frame) frame = requestAnimationFrame(() => { frame = 0; onInput?.(changedVal); }); };
    const drag = (el, fn) => el.addEventListener('pointerdown', e => {
      e.preventDefault(); el.setPointerCapture(e.pointerId);
      const mv = ev => { const b = el.getBoundingClientRect(); fn(clamp((ev.clientX - b.left) / b.width, 0, 1), clamp((ev.clientY - b.top) / b.height, 0, 1)); paint(); emit(); };
      const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); onChange?.(cur()); remember(cur()); };
      el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); mv(e);
    });
    drag(sv, (x, y) => { s = x; v = 1 - y; });
    drag(hue, x => { h = x * 359.9; });
    hex.addEventListener('input', () => { const c = toHex(hex.value.startsWith('#') ? hex.value : '#' + hex.value); if (c && hex.value.replace('#', '').length >= 6) { [h, s, v] = rgbToHsv(...hexToRgb(c)); paint(true); emit(); onChange?.(c); } });
    pop.addEventListener('click', e => {
      const c = e.target.closest('.cp-c')?.dataset.c;
      if (c) { [h, s, v] = rgbToHsv(...hexToRgb(c)); paint(); onInput?.(c); onChange?.(c); remember(c); }
      if (e.target.closest('.cp-theme')) { onInput?.(null); onChange?.(null); close(); }
    });
    paint();
  }

  function swatch(value, opts = {}) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'cp-sw';
    const show = v => { b.innerHTML = `<span class="cp-chip" style="background:${v || 'transparent'}"></span><span class="cp-val">${v || 'Theme'}</span>`; b.classList.toggle('theme', !v); };
    show(value);
    b.onclick = () => {
      if (pop && pop._for === b) return close();
      open(b, value, { ...opts, onInput: v => { show(v); opts.onInput?.(v); }, onChange: v => { value = v; show(v); opts.onChange?.(v); } });
      pop._for = b;
    };
    return b;
  }
  return { swatch, close, toHex };
})();
