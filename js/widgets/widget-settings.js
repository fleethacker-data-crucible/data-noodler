// Settings popout body for a widget package, built from its manifest. Same UI in the Dashboard and the Widget Builder.
// Global: WidgetSettings.
//   WidgetSettings.render(el, { manifest, w, columns, builder, onChange(kind) })
//     w        = dashboard widget ({ inputs, opts, limit }); values are written into it
//     columns  = [{ name, type }] of the chosen dataset (null = no dataset: data inputs are hidden)
//     builder  = true: also edit the manifest (input roles, option labels, "show in dashboard")
//     kind     = 'data' (re-run the query) | 'look' (redraw only) | 'manifest'
const WidgetSettings = (() => {
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const NUMERIC = /INT|DOUBLE|FLOAT|DECIMAL|REAL|NUMERIC/i;

  function render(el, args) {
    const { manifest: m, w, columns, builder = false, onChange = () => {} } = args;
    w.inputs ||= {}; w.opts ||= {};
    const valOf = o => o.path in w.opts ? w.opts[o.path] : o.default;
    let h = '';
    if (columns || builder) {
      h += `<h2>Data</h2>`;
      if (!(m.inputs || []).length) h += `<div class="muted">The code has no <code>field</code> to connect.</div>`;
      for (const i of m.inputs || []) {
        const b = VegaWidget.binding(m, w, i), isM = i.role === 'measure';
        const cols = (columns || []).filter(c => !isM || ['count', 'count_distinct', 'min', 'max', 'none'].includes(b.agg) || NUMERIC.test(c.type));
        h += `<div class="ws-in" data-k="${esc(i.key)}">
          <div class="ws-inh">${builder ? `<input class="ws-lbl" data-k="${esc(i.key)}" value="${esc(i.label)}" title="Label shown in the dashboard">` : `<b>${esc(i.label)}</b>`}
            ${builder ? `<div class="seg ws-role"><button data-r="dimension" class="small ${!isM ? 'on' : ''}" title="Group by this field">Dimension</button><button data-r="measure" class="small ${isM ? 'on' : ''}" title="Aggregate this field">Measure</button></div>` : `<small>${isM ? 'measure' : 'dimension'}</small>`}</div>
          ${columns ? `<select class="ws-col"><option value="">${isM && b.agg === 'count' ? 'All rows' : 'Select a field…'}</option>${cols.map(c => `<option ${c.name === b.col ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>` : ''}
          ${isM ? `<select class="ws-agg">${VegaWidget.AGGS.map(a => `<option value="${a}" ${a === b.agg ? 'selected' : ''}>${VegaWidget.AGG_LABEL[a]}</option>`).join('')}</select>` : ''}
        </div>`;
      }
      if (columns) h += `<label class="field">Max rows<input id="wsLimit" type="number" min="1" max="200000" value="${+w.limit || 5000}"></label>`;
    }
    const groups = new Map();
    (m.options || []).filter(o => builder || o.show !== false).forEach((o, idx) => { if (!groups.has(o.group)) groups.set(o.group, []); groups.get(o.group).push([o, (m.options || []).indexOf(o)]); });
    for (const [g, list] of groups) {
      h += `<h2>${esc(g)}</h2>`;
      for (const [o, ix] of list) {
        const v = valOf(o), lbl = builder ? `<input class="ws-olbl" data-i="${ix}" value="${esc(o.label)}" title="${esc(o.path)}">` : `<span title="${esc(o.path)}">${esc(o.label)}</span>`;
        const eye = builder ? `<input type="checkbox" class="ws-show" data-i="${ix}" ${o.show !== false ? 'checked' : ''} title="Show in the dashboard">` : '';
        let ctl = '';
        if (o.type === 'color') ctl = `<span class="ws-cp" data-i="${ix}"></span>`;
        else if (o.type === 'boolean') ctl = `<label class="switch"><input type="checkbox" data-i="${ix}" class="ws-v" ${v ? 'checked' : ''}><span></span></label>`;
        else if (o.type === 'select') ctl = `<select class="ws-v" data-i="${ix}">${(o.choices || []).map(c => `<option ${c === v ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>`;
        else if (o.type === 'number') ctl = `<span class="ws-num"><input type="range" class="ws-v" data-i="${ix}" min="${o.min}" max="${o.max}" step="${o.step}" value="${v}"><input type="number" class="ws-v" data-i="${ix}" step="${o.step}" value="${v}"></span>`;
        else ctl = `<input type="text" class="ws-v" data-i="${ix}" value="${esc(v)}">`;
        h += `<div class="ws-opt ${o.type === 'text' || o.type === 'number' ? 'wide' : ''}">${eye}${lbl}${ctl}</div>`;
      }
    }
    if (!(m.options || []).length) h += `<div class="muted">No options found in the code.</div>`;
    el.innerHTML = h;

    // ---- bind ----
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
    el.querySelectorAll('.ws-in').forEach(row => {
      const i = m.inputs.find(x => x.key === row.dataset.k), cur = () => (w.inputs[i.key] ||= { col: '', agg: i.agg });
      row.querySelector('.ws-col')?.addEventListener('change', e => { cur().col = e.target.value; onChange('data'); });
      row.querySelector('.ws-agg')?.addEventListener('change', e => { cur().agg = e.target.value; if (builder) i.agg = e.target.value; onChange('data'); render(el, args); });
      row.querySelector('.ws-role')?.addEventListener('click', e => {
        const r = e.target.closest('[data-r]')?.dataset.r; if (!r || r === i.role) return;
        i.role = r; i.agg = r === 'measure' ? 'sum' : undefined; delete w.inputs[i.key];
        onChange('manifest'); render(el, args);
      });
    });
    el.querySelectorAll('.ws-lbl').forEach(inp => inp.addEventListener('input', () => { m.inputs.find(x => x.key === inp.dataset.k).label = inp.value; onChange('manifest'); }));
    el.querySelectorAll('.ws-olbl').forEach(inp => inp.addEventListener('input', () => { m.options[+inp.dataset.i].label = inp.value; onChange('manifest'); }));
    el.querySelectorAll('.ws-show').forEach(inp => inp.addEventListener('change', () => { m.options[+inp.dataset.i].show = inp.checked; onChange('manifest'); }));
    el.querySelector('#wsLimit')?.addEventListener('input', e => { w.limit = Math.max(1, Math.min(200000, +e.target.value || 5000)); onChange('data'); });
  }
  return { render };
})();
