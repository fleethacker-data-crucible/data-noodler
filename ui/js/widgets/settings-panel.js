// The widget settings panel (Dashboard Studio > Widget Editor): the X / Y slots beside the widget and the settings,
// built from the widget's settings.json (inputs, settings). Global: SettingsPanel. Look: ui/css/dashboard-studio.css.
const SettingsPanel = (() => {
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const NUMERIC = /INT|DOUBLE|FLOAT|DECIMAL|REAL|NUMERIC/i, DATE = /DATE|TIME/i;
  const kindOf = t => NUMERIC.test(t) ? 'num' : DATE.test(t) ? 'date' : 'text';
  const AGG_TXT = { sum: 'Sum', avg: 'Average', count: 'Count', count_distinct: 'Count distinct', median: 'Median', min: 'Min', max: 'Max', none: 'Each row' };
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });

  // Field chips, A to Z. q = search text.
  function chips(columns, q = '') {
    q = q.trim().toLowerCase();
    return columns.filter(c => !q || c.name.toLowerCase().includes(q)).sort(byName).map(c => { const k = kindOf(c.type);
      return `<div class="chip" draggable="true" data-col="${esc(c.name)}" title="${esc(c.name)} (${esc(c.type)})"><span class="t ${k}">${k === 'num' ? '#' : k === 'date' ? 'D' : 'Aa'}</span><span>${esc(c.name)}</span></div>`; }).join('');
  }
  // One slot per input. links = { <key>: { col, agg } }.
  function slots(inputs, links) {
    return inputs.map(i => {
      const l = links[i.key]?.col ? links[i.key] : null;
      const agg = i.role === 'measure' ? `<select data-agg="${esc(i.key)}" title="How the values are combined">${Object.entries(AGG_TXT).map(([v, t]) => `<option value="${v}" ${(l?.agg || i.agg || 'sum') === v ? 'selected' : ''}>${t}</option>`).join('')}</select>` : '';
      return `<div class="slot ${l ? 'set' : ''}" data-key="${esc(i.key)}"><b>${esc(i.label || i.key)}</b>${l ? `<span class="f">${esc(l.col)}</span>${agg}<button class="x" data-clear="${esc(i.key)}" title="Remove">×</button>` : '<span>drop a field</span>'}</div>`;
    }).join('');
  }
  // Slots around a chart box { left, top, w, h } (px in the slots' container): Y centred on its left, X centred under it,
  // any other slot under X. flip = a horizontal bar chart (X is down the left).
  function placeSlots(el, inputs, r, flip = false) {
    let below = 0;
    for (const s of el.children) {
      const i = inputs.find(x => x.key === s.dataset.key), a0 = i?.axis || (i?.role === 'measure' ? 'y' : 'x'), axis = flip ? { x: 'y', y: 'x' }[a0] || a0 : a0;
      if (axis === 'y') Object.assign(s.style, { left: `${r.left - 10}px`, top: `${r.top + r.h / 2}px`, transform: 'translate(-100%, -50%)' });
      else { Object.assign(s.style, { left: `${r.left + r.w / 2}px`, top: `${r.top + r.h + 10 + below * 40}px`, transform: 'translateX(-50%)' }); below++; }
    }
  }
  // 8 colour swatches; values[i] = '#rrggbb' or null (the chart's default colour). set(i, value).
  function colours(el, values, set) {
    el.innerHTML = '';
    values.forEach((c, i) => el.append(ColorPicker.swatch(c, { allowTheme: true, onInput: v => set(i, v || null), onChange: v => set(i, v || null) })));
  }
  // Number formats offered by a 'format' option (an example of how a value looks; the chart turns it into a format).
  // Formats for each kind of data, grouped by similarity: [group, [format, ...]]. Every list starts with Auto, then None
  // (the value exactly as it is in the data). A format is shown as its own example.
  const FORMATS = {
    number: [['', ['Auto', 'None']], ['Whole numbers', ['1234', '1,234', '(1,234)', '+1,234']],
      ['Decimals', ['1234.5', '1,234.5', '1,234.56', '1,234.567', '(1,234.56)', '+1,234.56']],
      ['Currency', ['$1,234', '$1,234.56', '($1,234.56)', '€1,234', '€1,234.56', '£1,234', '£1,234.56', '¥1,234']],
      ['Percent', ['12%', '12.5%', '12.34%']],
      ['Thousands', ['1K', '1.2K', '1.23K', '$1.2K']], ['Millions', ['1M', '1.2M', '1.23M', '$1.2M']],
      ['Billions', ['1B', '1.2B', '1.23B', '$1.2B']], ['Scientific', ['1.2e+3', '1.23e+3']], ['With text', ['1,234 units']]],
    date: [['', ['Auto', 'None']], ['Numeric', ['2026-01-31', '01/31/2026', '31/01/2026']],
      ['Written', ['Jan 31, 2026', '31 Jan 2026', 'January 31, 2026']], ['Month', ['Jan 2026', 'January 2026', 'Jan', 'January']],
      ['Quarter / year', ['Q1 2026', '2026']], ['Weekday', ['Mon', 'Monday']]],
    text: [['', ['Auto', 'None']], ['Case', ['CAPS', 'Sentence case', 'Title Case', 'lower case']]],
  };
  const EXAMPLE = { Auto: { text: 'Title Case', number: 'whole, else 1.2K', date: 'Jan 31, 2026' }, None: 'as in the data',
    CAPS: 'NORTH AMERICA', 'Sentence case': 'North america', 'Title Case': 'North America', 'lower case': 'north america' };
  const flat = kind => FORMATS[kind].flatMap(g => g[1]);
  // The kind of the values on an input: 'number' | 'date' | 'text' (rows = the chart's data).
  const valueKind = (rows, key) => { const v = (rows || []).map(r => r?.[key]).find(x => x != null && x !== ''); return v instanceof Date ? 'date' : typeof v === 'number' ? 'number' : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? 'date' : v === undefined ? null : 'text'; };
  // Every option that is not a colour. get(path) -> value, set(path, value).
  // kinds: { <input key>: 'number' | 'date' | 'text' } = what is on each input now; a format option (o.input) offers the
  // formats for that kind only, and a format of another kind switches to that kind's first one.
  function settings(el, options, get, set, kinds = {}) {
    // Order: sub groups A to Z (settings without one last); in each, settings A to Z by label.
    const by = (a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: 'base', numeric: true });
    // o.when = { path, is } or { kind, is } (or a list of them, all must hold): shown only while that setting has that value (e.g. only in
    // Pop-out mode).
    // when: { kind: <input key>, is: 'date' } = only while that input holds that kind of data (numbers / text / dates).
    const shown = o => [].concat(o.when || []).every(w => [].concat(w.is).includes(w.kind ? kinds[w.kind] : get(w.path)));
    const os = options.filter(o => o.type !== 'color' && o.show !== false && shown(o))
      .sort((a, b) => (!a.sub - !b.sub) || by(a.sub || '', b.sub || '') || by(a.label, b.label));
    // o.sub: settings of the same sub group (X-Axis, Y-Axis) sit in a collapsible block under its own heading; all start
    // folded (on load / refresh). A redraw while open (a setting that shows / hides others) keeps the open ones open.
    const was = new Set([...el.querySelectorAll('details.subsec[open]')].map(d => d.dataset.sub));
    const folded = n => !was.has(n);
    el.innerHTML = os.map((o, k) => {
      const first = o.sub && o.sub !== os[k - 1]?.sub, last = o.sub && o.sub !== os[k + 1]?.sub;
      return (first ? `<details class="subsec" data-sub="${esc(o.sub)}" ${folded(o.sub) ? '' : 'open'}><summary class="optsub">${esc(o.sub)}</summary>` : '') + row(o, k) + (last ? '</details>' : '');
    }).join('') || '<div class="hintbox">This chart has no settings.</div>';
    el.onclick = e => {   // Show / Hide: sets the hidden checkbox and fires its change
      const b = e.target.closest('.seg button'); if (!b) return;
      const cb = b.parentElement.querySelector('input'), on = b.dataset.on === '1'; if (cb.checked === on) return;
      cb.checked = on; b.parentElement.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    };
    function row(o, k) {
      let v = get(o.path); const id = `data-k="${k}"`;
      // boolean: an OFF | ON toggle (o.labels = [on, off] for other words); the hidden checkbox holds the value
      if (o.type === 'boolean') { const [on, off] = o.labels || ['ON', 'OFF'];
        return `<div class="optrow${o.sep ? ' sep' : ''}"><span>${esc(o.label)}</span><span class="seg"><input type="checkbox" hidden ${id} ${v ? 'checked' : ''}><button type="button" data-on="0" class="${v ? '' : 'on'}">${esc(off)}</button><button type="button" data-on="1" class="${v ? 'on' : ''}">${esc(on)}</button></span></div>`; }
      // pick: a small drop-down of the choices (Bottom / Top)
      if (o.type === 'pick') return `<label class="optrow${o.sep ? ' sep' : ''}"><span>${esc(o.label)}</span><select class="pick" ${id}>${(o.choices || []).map((c, j) => `<option value="${esc(c)}" ${c === v ? 'selected' : ''}>${esc(o.labels?.[j] ?? c)}</option>`).join('')}</select></label>`;
      // format: a drop-down of example values (how a number should look) + Other: type your own example below it
      if (o.type === 'format') {
        // The formats for the kind of data on that input (numbers, dates or text), grouped; Other… (type an example) for numbers.
        const kind = kinds[o.input] || (o.kinds || ['number'])[0], list = flat(kind) ;
        if (v == null || (!list.includes(v) && (kind !== 'number' || Object.values(FORMATS).some(f => f !== FORMATS[kind] && f.flatMap(g => g[1]).includes(v))))) { v = 'Auto'; set(o.path, v); }
        const other = !list.includes(v);
        const label = f => { const e = EXAMPLE[f]; const x = typeof e === 'object' ? e[kind] : e; return x ? `${f}  (${x})` : f; };
        const opt = f => `<option value="${esc(f)}" ${f === v ? 'selected' : ''}>${esc(label(f))}</option>`;
        const groups = FORMATS[kind].map(([g, fs]) => g ? `<optgroup label="${esc(g)}">${fs.map(opt).join('')}</optgroup>` : fs.map(opt).join('')).join('');
        return `<label class="optrow${other ? '' : o.sep ? ' sep' : ''}"><span>${esc(o.label)}</span><select class="pick fmt" ${id}>${groups}${kind === 'number' ? `<optgroup label="Custom"><option value="__other" ${other ? 'selected' : ''}>Other…</option></optgroup>` : ''}</select></label>`
          + `<label class="optrow fmt-other${o.sep ? ' sep' : ''}" ${other ? '' : 'hidden'}><span>Example</span><input type="text" ${id} data-other="1" value="${esc(other ? v : '')}" placeholder="e.g. 1,234 units" spellcheck="false"></label>`;
      }
      const ctl = o.type === 'select' ? `<select ${id}>${(o.choices || []).map(c => `<option ${c === v ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>`
        : o.type === 'number' && o.min != null && o.max != null   // a slider: value bubble above the knob, min / max under the ends
          ? `<span class="slide" style="--p:${((v - o.min) / (o.max - o.min || 1)) * 100}%;--pf:${(v - o.min) / (o.max - o.min || 1)}"><span class="sl-tip">${esc(v)}</span><input type="range" ${id} min="${o.min}" max="${o.max}" step="${o.step ?? 1}" value="${esc(v)}"><span class="sl-mm"><i>${o.min}</i><i>${o.max}</i></span></span>`
        : o.type === 'number' ? `<input type="number" ${id} ${o.min != null ? `min="${o.min}"` : ''} ${o.max != null ? `max="${o.max}"` : ''} ${o.step != null ? `step="${o.step}"` : ''} value="${esc(v)}">`
        : `<input type="text" ${id} value="${esc(v)}" spellcheck="false">`;
      return `<label class="optrow${o.sep ? ' sep' : ''}"><span>${esc(o.label)}</span>${ctl}</label>`;
    }
    el.oninput = el.onchange = e => {
      const o = os[+e.target.dataset.k]; if (!o) return;
      if (o.type === 'format' && e.target.tagName === 'SELECT') {
        const box = e.target.closest('.optrow').nextElementSibling, inp = box.querySelector('input');
        box.hidden = e.target.value !== '__other';
        if (e.target.value === '__other') { inp.focus(); if (inp.value.trim()) set(o.path, inp.value); return; }
        return set(o.path, e.target.value);
      }
      if (e.target.type === 'range') {   // the fill and the bubble follow the knob
        const r = e.target, sl = r.parentElement;
        const f = (r.value - r.min) / (r.max - r.min || 1); sl.style.setProperty('--p', f * 100 + '%'); sl.style.setProperty('--pf', f); sl.querySelector('.sl-tip').textContent = r.value;
      }
      set(o.path, o.type === 'boolean' ? e.target.checked : o.type === 'number' ? +e.target.value : e.target.value);
      if (options.some(x => [].concat(x.when || []).some(w => w.path === o.path))) settings(el, options, get, set, kinds);   // settings that depend on it show / hide
    };
    const root = el.closest('.set-root'); if (root?._search) root._search();   // a redraw keeps the settings search applied
  }
  // Mouse wheel over a number box in the panel: up = one step more, down = one step less (min / max kept); over a toggle's row:
  // up = on, down = off. The page does not scroll.
  document.addEventListener('wheel', e => {
    // A drop-down: wheel up = the option above, wheel down = the one below, without opening it (Other… is skipped).
    const sel = e.target.closest?.('aside select');
    const isOpen = el => { try { return el.matches(':open'); } catch { return false; } };   // :open is new: older browsers have no open list here
    if (sel && e.deltaY && !isOpen(sel)) {
      e.preventDefault();
      const opts = [...sel.options].filter(o => !o.disabled && o.value !== '__other'), at = opts.findIndex(o => o.selected);
      const next = opts[Math.max(0, Math.min(opts.length - 1, (at < 0 ? 0 : at) + (e.deltaY < 0 ? -1 : 1)))];
      if (!next || next.selected) return;
      sel.value = next.value;
      sel.dispatchEvent(new Event('input', { bubbles: true })); sel.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    // A toggle: wheel up = on (knob right), wheel down = off (knob left).
    const tg = e.target.closest?.('aside .optrow')?.querySelector('.seg');
    if (tg && e.deltaY) {
      e.preventDefault();
      tg.querySelector(`button[data-on="${e.deltaY < 0 ? 1 : 0}"]`).click();
      return;
    }
    const inp = e.target.closest?.('aside .slide')?.querySelector('input[type=range]') || e.target.closest?.('aside input[type=number]'); if (!inp || !e.deltaY) return;
    e.preventDefault();
    const step = +inp.step || 1, min = inp.min === '' ? -Infinity : +inp.min, max = inp.max === '' ? Infinity : +inp.max;
    const v = Math.min(max, Math.max(min, Math.round(((+inp.value || 0) + (e.deltaY < 0 ? step : -step)) / step) * step));
    if (v === +inp.value) return;
    inp.value = +v.toFixed(6);
    inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true }));
  }, { capture: true, passive: false });
  // Drop-downs: our own list instead of the browser's (groups, as wide as the longest option, 25 rows tall, smooth scroll).
  let dd = null;
  const ddClose = () => { dd?.remove(); dd = null; };
  document.addEventListener('mousedown', e => {
    if (dd && !dd.contains(e.target)) { const same = dd._sel === e.target.closest?.('aside select, .tmenu select'); ddClose(); if (same) { e.preventDefault(); return; } }
    const sel = e.target.closest?.('aside select, .tmenu select'); if (!sel || e.button !== 0) return;
    e.preventDefault(); sel.focus();
    dd = document.createElement('div'); dd.className = 'dd-list'; dd._sel = sel;
    const row = o => `<div class="dd-o${o.selected ? ' on' : ''}" data-v="${esc(o.value)}">${esc(o.textContent)}</div>`;
    dd.innerHTML = [...sel.children].map(c => c.tagName === 'OPTGROUP' ? `<div class="dd-g">${esc(c.label)}</div>${[...c.children].map(row).join('')}` : row(c)).join('');
    document.body.append(dd);
    const r = sel.getBoundingClientRect(), h = dd.offsetHeight, below = innerHeight - r.bottom - 8;
    dd.style.minWidth = r.width + 'px'; dd.style.left = Math.max(8, Math.min(r.left, innerWidth - dd.offsetWidth - 8)) + 'px';
    dd.style.top = (h > below && r.top > below ? Math.max(8, r.top - h - 2) : r.bottom + 2) + 'px';
    dd.querySelector('.dd-o.on')?.scrollIntoView({ block: 'center', behavior: 'instant' });
    dd.onclick = ev => {
      const o = ev.target.closest('.dd-o'); if (!o) return;
      sel.value = o.dataset.v; ddClose();
      sel.dispatchEvent(new Event('input', { bubbles: true })); sel.dispatchEvent(new Event('change', { bubbles: true }));
    };
  }, true);
  addEventListener('keydown', e => { if (e.key === 'Escape' && dd) { e.stopPropagation(); ddClose(); } }, true);
  addEventListener('blur', ddClose);
  document.addEventListener('scroll', e => { if (dd && !dd.contains(e.target)) ddClose(); }, true);

  // Sections and sub groups fold independently: any number can be open at once.
  // The Settings window's body: one folding section per group (A to Z; all start folded, a redraw keeps open ones open),
  // colours under the other settings. s = the parsed settings.json, rows = the data (kinds of the inputs),
  // setValue(path, value).
  function sections(el, s, rows, setValue) {
    const esc2 = esc, val = p => p in (s.values || {}) ? s.values[p] : s.settings.find(x => x.path === p)?.default;
    const by2 = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
    const groups = [...new Set(s.settings.map(x => x.group || 'Settings'))].sort(by2);
    // While a search is on every section is open: the ones open before it are in el._before.
    const opened = el._before?.secs || new Set([...el.querySelectorAll('details.sec[open] > summary')].map(x => x.textContent));
    const q = el.querySelector(':scope > .set-search input')?.value || '';
    el.classList.add('set-root');
    el.innerHTML = (groups.length ? `<div class="set-search"><input type="search" placeholder="Search settings" spellcheck="false" value="${esc2(q)}"></div>` : '')
      + (groups.map((g, i) => `<details class="sec" data-g="${i}" ${opened.has(g) ? 'open' : ''}><summary>${esc2(g)}</summary><div class="${s.settings.some(x => (x.group || 'Settings') === g && x.type !== 'color') ? 'opts' : ''}"></div><div class="swatches"></div></details>`).join('')
      || '<div class="hintbox">No settings: add them to settings.json ("settings": [{ "path", "label", "group", "type", "default" }]).</div>')
      + '<div class="hintbox set-none" hidden>No setting matches.</div>';
    el._search = () => search(el);
    el.querySelector(':scope > .set-search input')?.addEventListener('input', el._search);
    const kinds = Object.fromEntries((s.inputs || []).map(i => [i.key, valueKind(rows || [], i.key) || 'number']));
    groups.forEach((g, i) => {
      const box = el.querySelector(`[data-g="${i}"]`), list = s.settings.filter(x => (x.group || 'Settings') === g);
      const plain = list.filter(x => x.type !== 'color'), cols = list.filter(x => x.type === 'color');
      if (plain.length) settings(box.querySelector('.opts'), plain, val, setValue, kinds); else box.querySelector('div').remove();
      const sw = box.querySelector('.swatches');
      if (!cols.length) sw.remove();
      else for (const c of cols) {
        const row = document.createElement('label'); row.className = 'optrow'; row.innerHTML = `<span>${esc2(c.label || c.path)}</span>`;
        row.append(ColorPicker.swatch(val(c.path) || null, { allowTheme: false, onInput: v => setValue(c.path, v || c.default || null), onChange: v => setValue(c.path, v || c.default || null) }));
        sw.append(row);
      }
    });
    search(el);
  }
  // The settings search (top of the Settings window): only the settings whose label holds the text (or all of a section /
  // sub group whose name does), every section and sub group open. Cleared: the sections open before the search again.
  function search(el) {
    const q = (el.querySelector(':scope > .set-search input')?.value || '').trim().toLowerCase();
    const secs = [...el.querySelectorAll(':scope > details.sec')], subs = [...el.querySelectorAll('details.subsec')];
    const name = d => d.querySelector(':scope > summary').textContent;
    if (q && !el._before) el._before = { secs: new Set(secs.filter(d => d.open).map(name)), subs: new Set(subs.filter(d => d.open).map(d => d.dataset.sub)) };
    const has = (t, s) => String(t || '').toLowerCase().includes(s);
    for (const r of el.querySelectorAll('.optrow')) {
      const sec = r.closest('details.sec'), sub = r.closest('details.subsec');
      r.classList.toggle('srch-hide', !!q && !has(r.querySelector(':scope > span')?.textContent, q) && !has(sec && name(sec), q) && !has(sub?.dataset.sub, q));
    }
    const shows = d => [...d.querySelectorAll('.optrow')].some(r => !r.hidden && !r.classList.contains('srch-hide'));
    for (const d of [...subs, ...secs]) { d.classList.toggle('srch-hide', !!q && !shows(d)); if (q) d.open = true; }
    if (!q && el._before) {
      for (const d of secs) d.open = el._before.secs.has(name(d));
      for (const d of subs) d.open = el._before.subs.has(d.dataset.sub);
      el._before = null;
    }
    const none = el.querySelector(':scope > .set-none'); if (none) none.hidden = !q || secs.some(d => !d.classList.contains('srch-hide'));
  }
  return { valueKind, NUMERIC, DATE, kindOf, AGG_TXT, chips, slots, placeSlots, colours, settings, sections };
})();
