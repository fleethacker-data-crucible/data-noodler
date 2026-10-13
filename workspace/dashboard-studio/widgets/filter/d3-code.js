// Filter: pick values of one field (text, numbers or dates); the widgets it is linked to (right-click > Link) are
// filtered by them.
//   data      one row per value: { value, count }
//   filter    the last pick (handed back on every redraw): { values }
// Settings > Type: List (the values, always shown) or Dropdown (a button; the list opens under it).
// A pick fires 'dn-filter' from the root: detail = { input: 'value', values: [...] }. Nothing picked = no filter.
// Only the rows in view are drawn, so a field with 100,000s of values stays fast (resizing redraws every frame).

// Kept per data array across redraws (resize, settings): the sorted rows and labels, the scroll position, the search
// text and whether the drop-down is open.
const memo = new WeakMap();

export default function widget(data, { width, height, settings: S, filter }) {
  const accent = S.colors?.[0] || '#3987e5', histColor = S.colors?.[1] || accent;
  const root = d3.create('div').attr('class', 'f-root').style('font-size', `${S.fontSize}px`)
    .style('--accent', accent).style('--hist', histColor);

  if (!data.length) {
    root.append('div').attr('class', 'f-empty').text('Drag a field onto Field (Data)');
    return root.node();
  }

  // ---- the data ----
  const kind = data.some(d => d.value instanceof Date) ? 'date' : data.some(d => typeof d.value === 'number') ? 'number' : 'text';
  const key = v => v instanceof Date ? v.toISOString() : `${typeof v}:${v}`;
  const cnt = d => d.count ?? 1;
  const fmtVal = valueFormatter(S.valueFormat);
  const label = v => v == null || v === '' ? '(blank)' : fmtVal(v);
  let m = memo.get(data);
  if (!m) memo.set(data, m = { view: { scroll: 0, query: '', open: false } });
  const sig = `${S.sort}|${S.valueFormat}`;
  if (m.sig !== sig) {
    const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });   // far faster than localeCompare on 100,000s
    const byVal = (a, b) => a.value == null ? 1 : b.value == null ? -1 : kind === 'text' ? coll.compare(a.value, b.value) : a.value - b.value;
    const rows = data.slice().sort(S.sort === 'Value A-Z' ? byVal : S.sort === 'Value Z-A' ? (a, b) => byVal(b, a)
      : (a, b) => cnt(b) - cnt(a) || byVal(a, b));
    Object.assign(m, { sig, rows, labels: rows.map(d => label(d.value)), total: d3.sum(rows, cnt) || 1, most: d3.max(rows, cnt) || 1, hits: null });
    m.lower = m.labels.map(t => t.toLowerCase());
  }
  const { rows, labels, total, most, view } = m;
  const index = new Map(rows.map((d, i) => [d, i]));
  const share = d => cnt(d) / most;

  // ---- formats ----
  const pct = d3.format('.1%'), num = d3.format(',');
  const fmtCount = c => ({ 'Percent of Total': pct(c / total), 'Number + Percent': `${num(c)} (${pct(c / total)})`,
    Compact: d3.format('.3~s')(c).replace('G', 'B') }[S.countFormat] ?? num(c));
  function valueFormatter(f = 'Auto') {
    if (kind === 'date') {
      if (f === 'Q1 2026') return d => `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
      return d3.utcFormat({ None: '%Y-%m-%d', '2026-01-31': '%Y-%m-%d', '01/31/2026': '%m/%d/%Y', '31/01/2026': '%d/%m/%Y',
        '31 Jan 2026': '%-d %b %Y', 'January 31, 2026': '%B %-d, %Y', 'Jan 2026': '%b %Y', 'January 2026': '%B %Y', Jan: '%b',
        January: '%B', 2026: '%Y', Mon: '%a', Monday: '%A' }[f] || '%b %-d, %Y');
    }
    if (kind === 'number') {
      if (!f || f === 'Auto') return v => Number.isInteger(v) ? d3.format(',')(v) : d3.format(',.2~f')(v);
      if (f === 'None') return v => String(v);
      const mt = String(f).trim().match(/^([(+]?)([$€£¥]?)\d[\d,]*(?:\.(\d+))?(K|M|B|%|e\+\d+)?\)?(.*)$/);
      if (!mt) return d3.format(',');
      const [, sign, cur, dec = '', unit = '', tail] = mt, n = dec.length, comma = f.includes(',') ? ',' : '';
      const scale = { K: 1e3, M: 1e6, B: 1e9 }[unit] || 1;
      return v => {
        const x = +v / scale, a = Math.abs(x);
        let s = unit === '%' ? d3.format(`${comma}.${n}%`)(a) : unit.startsWith('e') ? d3.format(`.${n}e`)(a)
          : d3.format(`${comma}.${n}f`)(a) + (scale > 1 ? unit : '');
        s = cur + s + tail;
        return x < 0 ? (sign === '(' ? `(${s})` : `-${s}`) : sign === '+' ? `+${s}` : s;
      };
    }
    const t = { CAPS: s => s.toUpperCase(), 'lower case': s => s.toLowerCase(),
      'Sentence case': s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(),
      'Title Case': s => s.toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (x, a, b) => a + b.toUpperCase()) }[f];
    return t ? v => t(String(v)) : v => String(v);
  }

  // ---- the pick ----
  const picked = new Map((filter?.values || []).map(v => [key(v), v]));
  const isOn = d => picked.has(key(d.value));
  const fire = () => root.node().dispatchEvent(new CustomEvent('dn-filter', { bubbles: true, detail: { input: 'value', values: [...picked.values()] } }));
  function toggle(d) {
    const k = key(d.value);
    if (picked.has(k)) picked.delete(k);
    else { if (S.single) picked.clear(); picked.set(k, d.value); }
    update(); fire();
  }
  function clearAll() { if (!picked.size) return; picked.clear(); update(); fire(); }

  // ---- frame: header (title, what is picked, Clear) + the body ----
  const head = root.append('div').attr('class', 'f-head');
  head.append('span').attr('class', 'f-title').text(S.showTitle ? S.title || 'Filter' : '');
  const status = head.append('span').attr('class', 'f-status');
  const clearBtn = S.showClear ? head.append('button').attr('type', 'button').attr('class', 'f-clear').text('Clear').on('click', clearAll) : null;
  const body = root.append('div').attr('class', 'f-body');
  body.on('pointerdown', e => e.stopPropagation());   // picking in the body never drags the container (the header does)
  const bodyH = Math.max(40, height - 16 - 26);

  // the rows that match the search (kept until the search text changes)
  const matches = () => {
    if (!view.query) return rows;
    if (m.hits?.q !== view.query) m.hits = { q: view.query, rows: rows.filter((d, i) => m.lower[i].includes(view.query)) };
    return m.hits.rows;
  };
  const searchBox = parent => parent.append('input').attr('class', 'f-search').attr('type', 'search').attr('placeholder', 'Search')
    .attr('spellcheck', 'false').property('value', view.query)
    .on('input', e => { view.query = e.target.value.trim().toLowerCase(); view.scroll = 0; list.reset(); update(); });

  // ---- the list: only the rows in view are in the page ----
  const histOn = !!S.histogram, fill = histOn && S.histStyle === 'Fill';
  const rowH = Math.round((S.fontSize || 12) * 1.25 + 10);
  function vlist(parent) {
    const box = parent.append('div').attr('class', 'f-list');
    const inner = box.append('div').attr('class', 'f-vinner');
    let items = [];
    const draw = () => {
      const el = box.node(), top = el.scrollTop, h = el.clientHeight || bodyH;
      const i0 = Math.max(0, Math.floor(top / rowH) - 4), i1 = Math.min(items.length, Math.ceil((top + h) / rowH) + 4);
      inner.selectAll('button.f-row').data(items.slice(i0, i1), d => key(d.value)).join(enter => {
        const b = enter.append('button').attr('type', 'button').attr('class', 'f-row').on('click', (e, d) => toggle(d));
        b.append('span').attr('class', S.single ? 'f-box f-radio' : 'f-box');
        b.append('span').attr('class', 'f-label');
        if (histOn && !fill) b.append('span').attr('class', 'f-track').append('span').attr('class', 'f-fill');
        if (S.counts) b.append('span').attr('class', 'f-num');
        return b;
      })
        .style('top', (d, i) => `${(i0 + i) * rowH}px`).style('height', `${rowH}px`)
        .classed('f-on', isOn).classed('f-dim', d => picked.size > 0 && !isOn(d))
        .classed('f-hfill', fill).style('--share', d => `${share(d) * 100}%`)
        .call(b => b.select('.f-label').text(d => labels[index.get(d)]).attr('title', d => labels[index.get(d)]))
        .call(b => b.select('.f-fill').style('width', d => `${share(d) * 100}%`))
        .call(b => b.select('.f-num').text(d => fmtCount(cnt(d))));
    };
    box.on('scroll', () => { view.scroll = box.node().scrollTop; draw(); });
    // once the widget is in the page: back to where it was scrolled (a redraw builds it new)
    Promise.resolve().then(() => { if (box.node().isConnected && view.scroll) { box.node().scrollTop = view.scroll; draw(); } });
    return {
      set(list) { items = list; inner.style('height', `${items.length * rowH}px`); draw(); },
      reset() { box.node().scrollTop = 0; },
    };
  }

  let list;
  if (S.type === 'Dropdown') {
    const btn = body.append('button').attr('type', 'button').attr('class', 'f-dd-btn').classed('f-open', view.open);
    btn.append('span').attr('class', 'f-dd-text'); btn.append('span').attr('class', 'f-dd-caret');
    const panel = body.append('div').attr('class', 'f-dd-panel').attr('hidden', view.open ? null : '');
    if (S.search) searchBox(panel);
    list = vlist(panel);
    btn.on('click', () => {
      view.open = !view.open; panel.attr('hidden', view.open ? null : ''); btn.classed('f-open', view.open);
      if (view.open) { update(); panel.select('.f-search').node()?.focus(); }
    });
  } else {
    if (S.search) searchBox(body);
    list = vlist(body);
  }
  const ddText = body.select('.f-dd-text');

  function update() {
    status.text(picked.size ? `${picked.size} of ${rows.length.toLocaleString()}` : rows.length.toLocaleString());
    clearBtn?.attr('disabled', picked.size ? null : '');
    if (!ddText.empty()) ddText.text(picked.size === 0 ? 'All' : picked.size === 1 ? label([...picked.values()][0]) : `${picked.size} selected`);
    list.set(matches());
  }
  update();
  return root.node();
}
