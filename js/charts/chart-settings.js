// Settings body for a dashboard widget, built from its package manifest. Global: ChartSettings.
//   ChartSettings.render(el, { manifest, w, columns, onChange(kind, live), only })
//     w        = dashboard widget ({ inputs, opts, limit }); values are written into it
//     columns  = [{ name, type }] of the chosen dataset (null = no dataset: data inputs are hidden)
//     only     = a group name: render just that group's rows (no collapsible wrapper); omitted = every group, collapsible
//     kind     = 'data' (re-run the query) | 'look' (redraw only)
//     tables   = { <dataset>: [{ name, type }] } every ready dataset (charts, kind d3: each input is linked to TABLE.FIELD,
//                all from one table, which becomes w.dataset; no fields linked = no dataset = the chart draws empty)
//   ChartSettings.tree(args) -> [{ name, count, items: [{ label, path }] }]   the groups (Inputs first) for a tree view
// Filter widgets (kind 'filter'): w.filters = [{ col, label, sort: 'asc' | 'desc' | 'count' }], w.showCounts, w.maxValues;
// the selected values live in w.sel = { <col>: value } (set from the dropdowns on the dashboard).
// Every row carries data-path (option path, or "in:<key>" for an input) so a tree can jump to it.
const ChartSettings = (() => {
  const OPEN = new Set(['Inputs']);   // groups the user opened (kept across re-renders)
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const section = (name, body, count) => `<details class="ws-grp" data-g="${esc(name)}" ${OPEN.has(name) ? 'open' : ''}><summary>${Icons.caret()}${esc(name)}<small>${count}</small></summary><div class="ws-gb">${body}</div></details>`;
  const NUMERIC = /INT|DOUBLE|FLOAT|DECIMAL|REAL|NUMERIC/i;
  const groupName = (m, o) => m.kind === 'apexcharts' && typeof ApexOptions !== 'undefined' ? ApexOptions.groupOf(o.path) : o.group || 'General';
  // Option groups: Map(name -> [index in m.options]) of the options shown in the dashboard.
  function optionGroups(m) {
    const groups = new Map();
    (m.options || []).forEach((o, k) => { if (o.show === false) return; const g = groupName(m, o); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(k); });
    return groups;
  }

  const SORTS = [['asc', 'Ascending (A to Z)'], ['desc', 'Descending (Z to A)'], ['count', 'Most rows first']];
  const isChart = (m, tables) => m.kind === 'd3' && !!tables;
  function tree({ manifest: m, w, columns, tables }) {
    if (m.kind === 'filter') return columns ? [{ name: 'Filter fields', count: (w.filters || []).length, items: (w.filters || []).map((f, k) => ({ label: f.label || f.col || 'Field', path: `f:${k}` })) },
      { name: 'Filter options', count: 2, items: [{ label: 'Show row counts', path: 'f:counts' }, { label: 'Max values', path: 'f:max' }] }] : [];
    const out = [];
    const ins = ApexWidget.inputsOf(m);
    if (columns || isChart(m, tables)) out.push({ name: 'Inputs', count: ins.length, items: ins.map(i => ({ label: ApexWidget.labelOf(m, i), path: `in:${i.key}` })) });
    for (const [g, list] of optionGroups(m)) out.push({ name: g, count: list.length, items: list.map(k => ({ label: m.options[k].label, path: m.options[k].path })) });
    return out;
  }

  function render(el, args) {
    const { manifest: m, w, columns, only, onChange = () => {} } = args;
    w.inputs ||= {}; w.opts ||= {};
    const valOf = o => o.path in w.opts ? w.opts[o.path] : o.default;
    const A = ApexWidget, ins = A.inputsOf(m), parts = [];
    if (m.kind === 'filter') return filterSettings(el, args);
    const chart = isChart(m, args.tables);
    if (chart) {
      // Charts: each input variable = TABLE.FIELD (one table for all, like SQL FROM).
      const tabs = Object.entries(args.tables), cur = w.dataset || '';
      let h = `<div class="muted ws-from">${cur ? `FROM <b>${esc(cur)}</b>: every input reads this table. A field of another table switches the chart to it (the other inputs are cleared).` : 'No fields linked: the chart shows its axes / grid only. Link each input to a TABLE.FIELD.'}</div>`;
      if (!tabs.length) h += '<div class="muted">No ready datasets in this project. Use Import Directly, or run the Transform on imported data.</div>';
      for (const i of ins) {
        const b = A.binding(m, w, i), isM = i.role === 'measure';
        const ok = c => !isM || ['count', 'count_distinct', 'min', 'max'].includes(b.agg) || NUMERIC.test(c.type);
        const now = cur && b.col ? `${cur}.${b.col}` : '';
        h += `<div class="ws-in" data-k="${esc(i.key)}" data-path="in:${esc(i.key)}">
          <div class="ws-inh"><b>${esc(A.labelOf(m, i))}</b><small>${isM ? 'measure' : 'dimension'} · d.${esc(i.key)}</small></div>
          <select class="ws-src"><option value="">${isM && b.agg === 'count' ? 'All rows (count)' : i.optional ? 'None' : 'Not linked: pick TABLE.FIELD…'}</option>${tabs.map(([t, cols]) => `<optgroup label="${esc(t)}">${cols.filter(ok).map(c => `<option value="${esc(`${t}.${c.name}`)}" ${`${t}.${c.name}` === now ? 'selected' : ''}>${esc(`${t}.${c.name}`)}</option>`).join('')}</optgroup>`).join('')}</select>
          ${isM ? `<select class="ws-agg">${A.AGGS.map(a => `<option value="${a}" ${a === b.agg ? 'selected' : ''}>${A.AGG_LABEL[a]}</option>`).join('')}</select>` : ''}
        </div>`;
      }
      if (A.hasTop(m)) {
        const s = A.sortOf(m, w);
        h += `<label class="field">Order<select id="wsSort">${[['desc', 'Largest first'], ['asc', 'Smallest first'], ['label', 'By X (A to Z, dates in order)']].map(([v, l]) => `<option value="${v}" ${v === s ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label class="field">Max X values<input id="wsTop" type="number" min="1" max="100000" value="${A.topOf(m, w)}"></label>`;
      }
      parts.push(['Inputs', h, ins.length]);
    } else if (columns) {
      let h = '';
      for (const i of ins) {
        const b = A.binding(m, w, i), isM = i.role === 'measure';
        if (i.role === 'fields') {
          const on = b.cols || [];
          h += `<div class="ws-in" data-k="${esc(i.key)}" data-path="in:${esc(i.key)}"><div class="ws-inh"><b>${esc(A.labelOf(m, i))}</b><small>${on.length} of ${columns.length}</small></div>
            <div class="row"><button class="ghost small ws-all">All</button><button class="ghost small ws-none">None</button></div>
            <div class="ws-fields">${columns.map(c => `<label><input type="checkbox" class="ws-f" value="${esc(c.name)}" ${on.includes(c.name) ? 'checked' : ''}> ${esc(c.name)} <small>${esc(c.type)}</small></label>`).join('')}</div></div>`;
          continue;
        }
        const cols = columns.filter(c => !isM || ['count', 'count_distinct', 'min', 'max'].includes(b.agg) || NUMERIC.test(c.type) || (b.agg === 'none' && i.anyType));
        const blank = isM && b.agg === 'count' ? 'All rows' : i.optional ? 'None' : 'Select a field…';
        h += `<div class="ws-in" data-k="${esc(i.key)}" data-path="in:${esc(i.key)}">
          <div class="ws-inh"><b>${esc(A.labelOf(m, i))}</b><small>${isM ? 'measure' : 'dimension'}${m.kind === 'd3' ? ` · d.${esc(i.key)}` : ''}</small></div>
          <select class="ws-col"><option value="">${blank}</option>${cols.map(c => `<option ${c.name === b.col ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
          ${isM ? `<select class="ws-agg">${A.AGGS.map(a => `<option value="${a}" ${a === b.agg ? 'selected' : ''}>${A.AGG_LABEL[a]}</option>`).join('')}</select>` : ''}
        </div>`;
      }
      if (A.hasTop(m)) {
        const s = A.sortOf(m, w);
        h += `<label class="field">Order<select id="wsSort">${[['desc', 'Largest first'], ['asc', 'Smallest first'], ['label', 'By label (A to Z)']].map(([v, l]) => `<option value="${v}" ${v === s ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label class="field">Max categories<input id="wsTop" type="number" min="1" max="1000" value="${A.topOf(m, w)}"></label>`;
      }
      parts.push(['Inputs', h, ins.length]);
    }
    const control = (o, ix, v) => {
      if (o.type === 'color') return `<span class="ws-cp" data-i="${ix}"></span>`;
      if (o.type === 'boolean') return `<label class="switch"><input type="checkbox" data-i="${ix}" class="ws-v" ${v ? 'checked' : ''}><span></span></label>`;
      if (o.type === 'select') return `<select class="ws-v" data-i="${ix}">${(o.choices || []).map(c => `<option ${c === v ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>`;
      if (o.type === 'number') return `<span class="ws-num"><input type="range" class="ws-v" data-i="${ix}" min="${o.min}" max="${o.max}" step="${o.step}" value="${v}"><input type="number" class="ws-v" data-i="${ix}" step="${o.step}" value="${v}"></span>`;
      return `<input type="text" class="ws-v" data-i="${ix}" value="${esc(v)}">`;
    };
    const row = (o, ix) => `<div class="ws-opt ${o.type === 'text' || o.type === 'number' ? 'wide' : ''}" data-path="${esc(o.path)}"><span title="${esc(o.path)}">${esc(o.label)}</span>${control(o, ix, valOf(o))}</div>`;
    for (const [g, list] of optionGroups(m)) parts.push([g, list.map(k => row(m.options[k], k)).join(''), list.length]);

    if (only) { const p = parts.find(x => x[0] === only); el.innerHTML = p ? `<div class="ws-gb">${p[1]}</div>` : '<div class="muted">Nothing here.</div>'; }
    else el.innerHTML = parts.map(p => section(...p)).join('') || '<div class="muted">This widget has no settings.</div>';

    // ---- bind ----
    el.querySelectorAll('details.ws-grp').forEach(d => d.addEventListener('toggle', () => { if (d.open) OPEN.add(d.dataset.g); else OPEN.delete(d.dataset.g); }));
    el.querySelectorAll('.ws-cp').forEach(span => {
      const o = m.options[+span.dataset.i];
      span.append(ColorPicker.swatch(valOf(o), { allowTheme: true, onInput: v => { w.opts[o.path] = v; onChange('look', true); }, onChange: v => { w.opts[o.path] = v; onChange('look'); } }));
    });
    el.querySelectorAll('.ws-v').forEach(inp => inp.addEventListener('input', () => {
      const o = m.options[+inp.dataset.i];
      const v = o.type === 'boolean' ? inp.checked : o.type === 'number' ? +inp.value : inp.value;
      w.opts[o.path] = v;
      if (o.type === 'number') inp.closest('.ws-num').querySelectorAll('input').forEach(x => { if (x !== inp) x.value = v; });
      onChange('look');
    }));
    el.querySelectorAll('.ws-in').forEach(r => {
      const i = ins.find(x => x.key === r.dataset.k), cur = () => (w.inputs[i.key] ||= { col: '', agg: i.agg });
      r.querySelector('.ws-col')?.addEventListener('change', e => { cur().col = e.target.value; onChange('data'); });
      // Chart: TABLE.FIELD. Another table = the chart reads that table now (the other inputs' fields are cleared).
      r.querySelector('.ws-src')?.addEventListener('change', e => {
        const v = e.target.value, at = v.indexOf('.'), t = at > 0 ? v.slice(0, at) : '', c = at > 0 ? v.slice(at + 1) : '';
        if (t && t !== w.dataset) { for (const k of Object.keys(w.inputs)) if (k !== i.key) w.inputs[k] = { ...w.inputs[k], col: '' }; w.dataset = t; }
        cur().col = c;
        if (!Object.values(w.inputs).some(x => x?.col)) w.dataset = '';
        onChange('data'); render(el, args);
      });
      r.querySelector('.ws-agg')?.addEventListener('change', e => { cur().agg = e.target.value; onChange('data'); render(el, args); });
      const fl = r.querySelector('.ws-fields');
      if (fl) {
        const sync = () => { cur().cols = [...fl.querySelectorAll('.ws-f:checked')].map(x => x.value); r.querySelector('.ws-inh small').textContent = `${cur().cols.length} of ${columns.length}`; onChange('data'); };
        fl.addEventListener('change', sync);
        r.querySelector('.ws-all').onclick = () => { fl.querySelectorAll('.ws-f').forEach(x => x.checked = true); sync(); };
        r.querySelector('.ws-none').onclick = () => { fl.querySelectorAll('.ws-f').forEach(x => x.checked = false); sync(); };
      }
    });
    el.querySelector('#wsSort')?.addEventListener('change', e => { w.sort = e.target.value; onChange('data'); });
    el.querySelector('#wsTop')?.addEventListener('input', e => { w.top = Math.max(1, Math.min(chart ? 100000 : 1000, +e.target.value || 20)); onChange('data'); });
  }
  // ---- filter widget: the fields with a dropdown each, their order; Add field / remove ----
  function filterSettings(el, args) {
    const { w, columns, only, onChange = () => {} } = args;
    if (!columns) { el.innerHTML = '<div class="muted">Choose a dataset first (Widget).</div>'; return; }
    w.filters ||= []; w.sel ||= {};
    const fields = w.filters.map((f, k) => `<div class="ws-in" data-f="${k}" data-path="f:${k}">
        <div class="ws-inh"><b>Field ${k + 1}</b><button class="ghost small ws-fdel" title="Remove this field">Remove</button></div>
        <select class="ws-fcol"><option value="">Select a field…</option>${columns.map(c => `<option ${c.name === f.col ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
        <input type="text" class="ws-flbl" placeholder="Label (default: field name)" value="${esc(f.label || '')}">
        <select class="ws-fsort">${SORTS.map(([v, l]) => `<option value="${v}" ${v === (f.sort || 'asc') ? 'selected' : ''}>${l}</option>`).join('')}</select>
      </div>`).join('') + `<div class="row"><button class="ghost small" id="wsFAdd">Add field</button></div>`;
    const optsH = `<label class="field" data-path="f:counts"><span><input type="checkbox" id="wsFCounts" ${w.showCounts !== false ? 'checked' : ''}> Show row counts next to each value</span></label>
      <label class="field" data-path="f:max">Max values per dropdown<input id="wsFMax" type="number" min="10" max="100000" value="${+w.maxValues || 1000}"></label>`;
    const parts = [['Filter fields', fields, w.filters.length], ['Filter options', optsH, 2]];
    if (only) { const p = parts.find(x => x[0] === only); el.innerHTML = p ? `<div class="ws-gb">${p[1]}</div>` : '<div class="muted">Nothing here.</div>'; }
    else el.innerHTML = parts.map(p => section(...p)).join('');
    const again = () => { onChange('data'); render(el, args); };
    el.querySelectorAll('.ws-in[data-f]').forEach(r => {
      const f = w.filters[+r.dataset.f];
      r.querySelector('.ws-fcol').onchange = e => { if (f.col) delete w.sel[f.col]; f.col = e.target.value; again(); };
      r.querySelector('.ws-flbl').oninput = e => { f.label = e.target.value; onChange('data'); };
      r.querySelector('.ws-fsort').onchange = e => { f.sort = e.target.value; onChange('data'); };
      r.querySelector('.ws-fdel').onclick = () => { if (f.col) delete w.sel[f.col]; w.filters.splice(+r.dataset.f, 1); again(); };
    });
    el.querySelector('#wsFAdd')?.addEventListener('click', () => { w.filters.push({ col: '', label: '', sort: 'asc' }); again(); });
    el.querySelector('#wsFCounts')?.addEventListener('change', e => { w.showCounts = e.target.checked; onChange('data'); });
    el.querySelector('#wsFMax')?.addEventListener('input', e => { w.maxValues = Math.max(10, Math.min(100000, +e.target.value || 1000)); onChange('data'); });
  }
  return { render, tree };
})();
