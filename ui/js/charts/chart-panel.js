// The chart settings panel, the same in Chart Builder and Dashboard Builder: field chips (drag onto a slot or the chart),
// the X / Y slots beside the chart, Colors and Settings. It is built from the chart's own inputs and options, so a setting
// added to a chart in Chart Builder appears on every dashboard that uses the published chart (at its default until
// changed); settings a chart no longer has are ignored. Global: ChartPanel. Look: ui/css/chart-studio.css.
const ChartPanel = (() => {
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
  const FORMATS = { number: ['None', 'Auto', '1234', '1,234', '1234.5', '1,234.5', '1,234.56', '1,234.567', '(1,234)', '+1,234',
      '$1,234', '$1,234.56', '($1,234.56)', '€1,234', '£1,234', '12%', '12.5%', '12.34%', '1.2K', '1.23K', '$1.2K', '1.2M', '1.23M', '$1.2M',
      '1.2B', '1.23B', '$1.2B', '1.2e+3', '1,234 units'],
    date: ['None', '2026-01-31', '01/31/2026', '31/01/2026', 'Jan 31, 2026', '31 Jan 2026', 'Jan 2026', 'January 2026', 'Q1 2026', 'Jan', '2026'],
    text: ['None', 'UPPER CASE', 'Sentence case', 'Title Case', 'lower case'] };
  const FIRST = { number: '1,234', date: 'Jan 2026', text: 'Title Case' };   // what a format switches to when the data's kind changes
  // The kind of the values on an input: 'number' | 'date' | 'text' (rows = the chart's data).
  const valueKind = (rows, key) => { const v = (rows || []).map(r => r?.[key]).find(x => x != null && x !== ''); return v instanceof Date ? 'date' : typeof v === 'number' ? 'number' : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? 'date' : v === undefined ? null : 'text'; };
  // Every option that is not a colour. get(path) -> value, set(path, value).
  // kinds: { <input key>: 'number' | 'date' | 'text' } = what is on each input now; a format option (o.input) offers the
  // formats for that kind only, and a format of another kind switches to that kind's first one.
  function settings(el, options, get, set, kinds = {}) {
    // Order: sub groups A to Z (settings without one last); in each, settings with an order (1, 2, ...) first, then boxes / drop-downs,
    // then toggles, each A to Z.
    const by = (a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: 'base', numeric: true });
    const os = options.filter(o => o.type !== 'color' && o.show !== false)
      .sort((a, b) => (!a.sub - !b.sub) || by(a.sub || '', b.sub || '') || ((a.order ?? 99) - (b.order ?? 99)) || ((a.type === 'boolean') - (b.type === 'boolean')) || by(a.label, b.label));
    // o.sub: settings of the same sub group (X-Axis, Y-Axis) sit in a collapsible block under its own heading (folded ones
    // stay folded: this browser).
    const folded = n => { try { return localStorage.getItem('chartpanel.sub.' + n) === '1'; } catch { return false; } };
    el.innerHTML = os.map((o, k) => {
      const first = o.sub && o.sub !== os[k - 1]?.sub, last = o.sub && o.sub !== os[k + 1]?.sub;
      return (first ? `<details class="subsec" data-sub="${esc(o.sub)}" ${folded(o.sub) ? '' : 'open'}><summary class="optsub">${esc(o.sub)}</summary>` : '') + row(o, k) + (last ? '</details>' : '');
    }).join('') || '<div class="hintbox">This chart has no settings.</div>';
    el.querySelectorAll('details.subsec').forEach(d => d.addEventListener('toggle', () => { try { localStorage.setItem('chartpanel.sub.' + d.dataset.sub, d.open ? '0' : '1'); } catch {} }));
    function row(o, k) {
      let v = get(o.path); const id = `data-k="${k}"`;
      if (o.type === 'boolean') return `<label class="optrow${o.sep ? ' sep' : ''}"><span>${esc(o.label)}</span><span class="switch"><input type="checkbox" ${id} ${v ? 'checked' : ''}><span></span></span></label>`;   // a toggle
      // pick: a small drop-down of the choices (Bottom / Top)
      if (o.type === 'pick') return `<label class="optrow${o.sep ? ' sep' : ''}"><span>${esc(o.label)}</span><select class="pick" ${id}>${(o.choices || []).map((c, j) => `<option value="${esc(c)}" ${c === v ? 'selected' : ''}>${esc(o.labels?.[j] ?? c)}</option>`).join('')}</select></label>`;
      // format: a drop-down of example values (how a number should look) + Other: type your own example below it
      if (o.type === 'format') {
        // The formats for the kind of data on that input (numbers, dates or text); Other… (type an example) for numbers only.
        const kind = kinds[o.input] || (o.kinds || ['number'])[0], list = FORMATS[kind] || FORMATS.number;
        if (Object.values(FORMATS).some(l => l !== list && l.includes(v)) || (kind !== 'number' && !list.includes(v))) { v = FIRST[kind]; set(o.path, v); }
        const other = !list.includes(v);
        const opt = f => `<option value="${esc(f)}" ${f === v ? 'selected' : ''}>${esc(f)}</option>`;
        return `<label class="optrow${other ? '' : o.sep ? ' sep' : ''}"><span>${esc(o.label)}</span><select class="pick fmt" ${id}>${list.map(opt).join('')}${kind === 'number' ? `<option value="__other" ${other ? 'selected' : ''}>Other…</option>` : ''}</select></label>`
          + `<label class="optrow fmt-other${o.sep ? ' sep' : ''}" ${other ? '' : 'hidden'}><span>Example</span><input type="text" ${id} data-other="1" value="${esc(other ? v : '')}" placeholder="e.g. 1,234 units" spellcheck="false"></label>`;
      }
      const ctl = o.type === 'select' ? `<select ${id}>${(o.choices || []).map(c => `<option ${c === v ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>`
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
      set(o.path, o.type === 'boolean' ? e.target.checked : o.type === 'number' ? +e.target.value : e.target.value);
    };
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
    const tg = e.target.closest?.('aside .optrow')?.querySelector('.switch input');
    if (tg && e.deltaY) {
      e.preventDefault();
      const on = e.deltaY < 0; if (tg.checked === on) return;
      tg.checked = on; tg.dispatchEvent(new Event('input', { bubbles: true })); tg.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    const inp = e.target.closest?.('aside input[type=number]'); if (!inp || !e.deltaY) return;
    e.preventDefault();
    const step = +inp.step || 1, min = inp.min === '' ? -Infinity : +inp.min, max = inp.max === '' ? Infinity : +inp.max;
    const v = Math.min(max, Math.max(min, Math.round(((+inp.value || 0) + (e.deltaY < 0 ? step : -step)) / step) * step));
    if (v === +inp.value) return;
    inp.value = +v.toFixed(6);
    inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true }));
  }, { capture: true, passive: false });
  // One open at a time: opening a section folds the open one away at the same time; the same for sub groups.
  document.addEventListener('click', e => {
    const sum = e.target.closest?.('summary'), d = sum?.parentElement;
    if (!(d instanceof HTMLDetailsElement) || d.open) return;
    const cls = d.classList.contains('sec') ? 'sec' : d.classList.contains('subsec') ? 'subsec' : null; if (!cls) return;
    const root = cls === 'sec' ? d.closest('aside') : d.closest('.sec');
    const others = [...(root?.querySelectorAll(`details.${cls}[open]`) || [])].filter(x => x !== d);
    if (!others.length) return;
    others.forEach(x => { x.open = false; });   // they fold while the clicked one unfolds (the click opens it)
  }, true);
  return { valueKind, NUMERIC, DATE, kindOf, AGG_TXT, chips, slots, placeSlots, colours, settings };
})();
