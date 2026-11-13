// Colour picker for the widget settings popout. Global: ColorPicker.
//   const el = ColorPicker.swatch(value, { onInput(v), onChange(v), allowTheme: true })   // value '#rrggbb' or null (= theme default)
// Click the swatch: Grid / Theme / Manual tabs, opacity slider, the colour now + 16 colours that go with it.
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

  const hsl = (h, s, l) => { s /= 100; l /= 100; const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)); return rgbToHex(f(0) * 255, f(8) * 255, f(4) * 255); };
  function toHsl(hex) { const [r, g, b] = hexToRgb(hex).map(x => x / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2;
    let h = 0; if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [(h * 60 + 360) % 360, d ? d / (1 - Math.abs(2 * l - 1)) * 100 : 0, l * 100]; }
  // Grid: a grey row, then 10 rows (dark -> light) x 12 hues.
  const HUES = [195, 215, 240, 270, 300, 335, 0, 18, 32, 45, 58, 90];
  const GRID = [Array.from({ length: 12 }, (_, i) => hsl(0, 0, 100 - i * 100 / 11)),
    ...[18, 25, 32, 40, 48, 56, 64, 72, 80, 88].map(l => HUES.map(h => hsl(h, l > 75 ? 70 : 80, l)))];
  // 16 colours that go with c: complement, split complements, triads, analogous, tetrads (top), and lighter / darker ones (bottom).
  function partners(c) {
    const [h, s0, l0] = toHsl(c), s = Math.max(45, s0), l = Math.min(65, Math.max(35, l0)), at = (d, ll = l) => hsl((h + d + 360) % 360, s, ll);
    const D = [180, 150, 210, 120, 240, 30, -30, 90];
    return D.map(d => at(d)).concat(D.map((d, i) => at(d, i % 2 ? Math.max(20, l - 22) : Math.min(85, l + 22))));
  }
  const withAlpha = (c, a) => a >= 100 ? c : c + Math.round(a * 2.55).toString(16).padStart(2, '0');

  let pop = null;
  function close() { if (pop) { pop._done?.(); pop.remove(); pop = null; } }
  addEventListener('pointerdown', e => { if (pop && !pop.contains(e.target) && !e.target.closest('.cp-sw')) close(); }, true);
  addEventListener('keydown', e => { if (e.key === 'Escape' && pop) { e.stopPropagation(); close(); } }, true);

  // The popout: Grid / Theme (empty for now) / Manual (type a #hex) tabs, Opacity slider, then the colour now + 16 that go with it.
  function open(anchor, value, { onInput, onChange }) {
    close();
    const v0 = String(value || '');
    let col = toHex(v0) || toHex(css('--c1')) || '#3987e5', alpha = /^#[0-9a-f]{8}$/i.test(v0) ? Math.round(parseInt(v0.slice(7), 16) / 2.55) : 100;
    let tab = (() => { try { return localStorage.getItem('dn-cp-tab') || 'grid'; } catch { return 'grid'; } })();
    pop = document.createElement('div');
    pop.className = 'cp-pop';
    pop.innerHTML = `<div class="cp-head"><b>Colors</b><button class="cp-x" title="Close">×</button></div>
      <div class="cp-tabs"><button data-t="grid">Grid</button><button data-t="theme">Theme</button><button data-t="manual">Manual</button></div>
      <div class="cp-pane" data-t="grid"><div class="cp-grid">${GRID.flat().map(c => `<button class="cp-g" data-c="${c}" style="background:${c}"></button>`).join('')}</div></div>
      <div class="cp-pane" data-t="theme"></div>
      <div class="cp-pane" data-t="manual"><div class="cp-row"><span class="cp-prev"></span><input class="cp-hex" spellcheck="false" maxlength="7" placeholder="#rrggbb"></div></div>
      <div class="cp-lbl">Opacity</div><div class="cp-op"><div class="cp-opbar"><input type="range" min="0" max="100" class="cp-a"></div><span class="cp-ap"></span></div>
      <div class="cp-foot"><span class="cp-now"></span><div class="cp-match"></div></div>`;
    document.body.append(pop);
    const r = anchor.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
    pop.style.left = clamp(r.right - pw, 8, innerWidth - pw - 8) + 'px';
    pop.style.top = (r.bottom + 6 + ph > innerHeight ? Math.max(8, r.top - ph - 6) : r.bottom + 6) + 'px';
    const $ = q => pop.querySelector(q), hex = $('.cp-hex'), rng = $('.cp-a');
    const out = () => withAlpha(col, alpha);
    function paint(fromHex) {
      pop.querySelectorAll('.cp-tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === tab));
      pop.querySelectorAll('.cp-pane').forEach(p => { p.hidden = p.dataset.t !== tab; });
      pop.querySelectorAll('.cp-g').forEach(b => b.classList.toggle('on', b.dataset.c === col));
      $('.cp-prev').style.background = col; if (!fromHex) hex.value = col;
      rng.value = alpha; $('.cp-ap').textContent = alpha + '%';
      $('.cp-opbar').style.setProperty('--c', col);
      $('.cp-now').style.background = out();
      $('.cp-match').innerHTML = partners(col).map(c => `<button class="cp-c" data-c="${c}" style="background:${c}" title="${c}"></button>`).join('');
    }
    const pick = (c, fromHex) => { col = c; paint(fromHex); onInput?.(out()); onChange?.(out()); remember(col); };
    rng.addEventListener('input', () => { alpha = +rng.value; paint(); onInput?.(out()); });
    rng.addEventListener('change', () => onChange?.(out()));
    hex.addEventListener('input', () => { const c = toHex(hex.value.startsWith('#') ? hex.value : '#' + hex.value); if (c && hex.value.replace('#', '').length >= 6) pick(c, true); });
    pop.addEventListener('click', e => {
      const t = e.target.closest('.cp-tabs button')?.dataset.t;
      if (t) { tab = t; try { localStorage.setItem('dn-cp-tab', t); } catch {} paint(); return; }
      if (e.target.closest('.cp-x')) return close();
      const c = e.target.closest('.cp-g, .cp-c')?.dataset.c; if (c) pick(c);
    });
    paint();
  }

  function swatch(value, opts = {}) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'cp-sw';
    // Text and the chip colour are DOM properties, not an HTML string: a colour typed or stored
    // in settings cannot be reinterpreted as markup. style.background sets only that property.
    const show = v => {
      b.replaceChildren();
      const chip = document.createElement('span');
      chip.className = 'cp-chip';
      chip.style.background = v || 'transparent';
      const val = document.createElement('span');
      val.className = 'cp-val';
      val.textContent = v || 'Theme';
      b.append(chip, val);
      b.classList.toggle('theme', !v);
    };
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
