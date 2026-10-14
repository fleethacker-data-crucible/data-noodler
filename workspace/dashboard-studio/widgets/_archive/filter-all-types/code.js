// Filter: pick values of one field; the widgets it is linked to (right-click > Link) are filtered by them.
//   data      one row per value: { value, count }
//   filter    the last pick (handed back on every redraw): { values, ranges, state }
// Settings > Type picks the look. Text / numbers: Bubbles, Chips, Dropdown, List, Range Slider (numbers), Search Tokens,
// Tiles. Dates: Calendar, Heatmap, Manual, Periods, Presets, Range Slider.
// A pick fires 'dn-filter' from the root: detail = { input: 'value', values: [...], ranges: [{ min, max }], state }.
// Nothing picked = no filter. Date ranges are whole days (UTC), both ends included.
export default function widget(data, { width, height, settings: S, filter }) {
  const accent = S.colors?.[0] || '#3987e5', histColor = S.colors?.[1] || accent;
  const F = filter || {};
  const root = d3.create('div').attr('class', 'f-root').style('font-size', `${S.fontSize}px`)
    .style('--accent', accent).style('--hist', histColor);

  if (!data.length) {
    root.append('div').attr('class', 'f-empty').text('Drag a field onto Field (Data)');
    return root.node();
  }

  // ---- the data ----
  const isDate = data.some(d => d.value instanceof Date), isNum = !isDate && data.some(d => typeof d.value === 'number');
  const kind = isDate ? 'date' : isNum ? 'number' : 'text';
  let type = kind === 'date' ? S.dateType || 'Range Slider' : S.type || 'List';
  if (type === 'Range Slider' && kind === 'text') type = 'List';
  const key = v => v instanceof Date ? v.toISOString() : `${typeof v}:${v}`;
  const cnt = d => d.count ?? 1;
  const total = d3.sum(data, cnt) || 1, maxCount = d3.max(data, cnt) || 1;
  const share = d => cnt(d) / maxCount;
  const byVal = (a, b) => a.value == null ? 1 : b.value == null ? -1
    : kind === 'text' ? String(a.value).localeCompare(String(b.value), undefined, { numeric: true, sensitivity: 'base' }) : a.value - b.value;
  const rows = data.slice().sort(S.sort === 'Value A-Z' ? byVal : S.sort === 'Value Z-A' ? (a, b) => byVal(b, a)
    : (a, b) => cnt(b) - cnt(a) || byVal(a, b));
  const dated = rows.filter(d => d.value instanceof Date);

  // ---- formats ----
  const fmtVal = valueFormatter(S.valueFormat);
  const label = v => v == null || v === '' ? '(blank)' : fmtVal(v);
  const fmtDay = d3.utcFormat('%b %-d, %Y');
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
      if (!f || f === 'Auto') return v => Number.isInteger(v) ? num(v) : d3.format(',.2~f')(v);
      if (f === 'None') return v => String(v);
      const m = String(f).trim().match(/^([(+]?)([$€£¥]?)\d[\d,]*(?:\.(\d+))?(K|M|B|%|e\+\d+)?\)?(.*)$/);
      if (!m) return num;
      const [, sign, cur, dec = '', unit = '', tail] = m, n = dec.length, comma = f.includes(',') ? ',' : '';
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
      'Title Case': s => s.toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()) }[f];
    return t ? v => t(String(v)) : v => String(v);
  }

  // ---- the pick ----
  const picked = new Map((F.values || []).map(v => [key(v), v]));
  let ranges = (F.ranges || []).map(r => ({ ...r }));
  const state = { ...(F.state || {}) };
  const isOn = d => picked.has(key(d.value));
  const active = () => picked.size > 0 || ranges.length > 0;
  const inRange = (v, r) => v != null && (r.min == null || v >= r.min) && (r.max == null || v <= r.max);
  const countIn = r => d3.sum(rows.filter(d => inRange(d.value, r)), cnt);
  const fire = () => root.node().dispatchEvent(new CustomEvent('dn-filter', { bubbles: true,
    detail: { input: 'value', values: [...picked.values()], ranges: ranges.map(r => ({ ...r })), state: { ...state } } }));
  function toggle(d) {
    const k = key(d.value);
    if (picked.has(k)) picked.delete(k);
    else { if (S.single) picked.clear(); picked.set(k, d.value); }
    commit();
  }
  function commit() { update(); fire(); }
  function clearAll() { if (!active()) return; picked.clear(); ranges = []; state.preset = null; commit(); }

  // ---- frame: header (title, what is picked, Clear) + the body of the chosen type ----
  const head = root.append('div').attr('class', 'f-head');
  head.append('span').attr('class', 'f-title').text(S.showTitle ? S.title || 'Filter' : '');
  const status = head.append('span').attr('class', 'f-status');
  const clearBtn = S.showClear ? head.append('button').attr('type', 'button').attr('class', 'f-clear').text('Clear').on('click', clearAll) : null;
  const body = root.append('div').attr('class', 'f-body');
  body.on('pointerdown', e => e.stopPropagation());   // picking in the body never drags the container (the header does)
  const bodyW = Math.max(40, width - 16), bodyH = Math.max(40, height - 16 - 26);
  let refresh = () => {};
  function statusText() {
    if (kind === 'date' && type !== 'Periods') {
      const r = ranges[0];
      return !r ? 'All dates' : +r.min === +r.max ? fmtDay(r.min) : `${fmtDay(r.min)} - ${fmtDay(r.max)}`;
    }
    if (ranges.length) return ranges.length === 1 && type === 'Range Slider' ? `${label(ranges[0].min)} - ${label(ranges[0].max)}` : `${ranges.length} picked`;
    return picked.size ? `${picked.size} of ${rows.length}` : `${rows.length}`;
  }
  function update() { status.text(statusText()); clearBtn?.attr('disabled', active() ? null : ''); refresh(); }

  // ---- shared pieces ----
  let query = '';
  const matches = () => query ? rows.filter(d => label(d.value).toLowerCase().includes(query)) : rows;
  const searchBox = (parent, placeholder = 'Search') => parent.append('input').attr('class', 'f-search').attr('type', 'search')
    .attr('placeholder', placeholder).attr('spellcheck', 'false').on('input', e => { query = e.target.value.trim().toLowerCase(); refresh(); });
  const histOn = !!S.histogram, fill = histOn && S.histStyle === 'Fill';
  // List rows: [box] label [bar] [count]; with Fill the row's own background is the bar.
  function rowsInto(box, items, withBox = true) {
    box.selectAll('button.f-row').data(items, d => key(d.value)).join(enter => {
      const b = enter.append('button').attr('type', 'button').attr('class', 'f-row').on('click', (e, d) => toggle(d));
      if (withBox) b.append('span').attr('class', S.single ? 'f-box f-radio' : 'f-box');
      b.append('span').attr('class', 'f-label');
      if (histOn && !fill) b.append('span').attr('class', 'f-track').append('span').attr('class', 'f-fill');
      if (S.counts) b.append('span').attr('class', 'f-num');
      return b;
    }).order()
      .classed('f-on', isOn).classed('f-dim', d => picked.size > 0 && !isOn(d))
      .classed('f-hfill', fill).style('--share', d => `${share(d) * 100}%`)
      .call(b => b.select('.f-label').text(d => label(d.value)).attr('title', d => label(d.value)))
      .call(b => b.select('.f-fill').style('width', d => `${share(d) * 100}%`))
      .call(b => b.select('.f-num').text(d => fmtCount(cnt(d))));
  }
  // Chips (also Periods): label [count badge] [bar under it].
  function chipsInto(box, items, k, text, on, click) {
    const most = d3.max(items, x => x.count ?? 1) || 1, sh = d => `${(d.count ?? 1) / most * 100}%`;
    box.selectAll('button.f-chip').data(items, k).join(enter => {
      const b = enter.append('button').attr('type', 'button').attr('class', 'f-chip').on('click', (e, d) => click(d));
      b.append('span').attr('class', 'f-label');
      if (S.counts) b.append('span').attr('class', 'f-badge');
      if (histOn && !fill) b.append('span').attr('class', 'f-under');
      return b;
    }).order()
      .classed('f-on', on).classed('f-dim', d => active() && !on(d))
      .classed('f-hfill', fill).style('--share', sh)
      .call(b => b.select('.f-label').text(text))
      .call(b => b.select('.f-badge').text(d => fmtCount(d.count ?? 1)))
      .call(b => b.select('.f-under').style('width', sh));
  }
  const navBar = (parent, onPrev, onNext) => {
    const nav = parent.append('div').attr('class', 'f-nav');
    nav.append('button').attr('type', 'button').attr('class', 'f-navb').attr('title', 'Back').text('<').on('click', onPrev);
    const t = nav.append('span').attr('class', 'f-nav-title');
    nav.append('button').attr('type', 'button').attr('class', 'f-navb').attr('title', 'Next').text('>').on('click', onNext);
    return t;
  };
  const weekIv = S.weekStart === 'Monday' ? d3.utcMonday : d3.utcSunday;
  const dayCounts = () => d3.rollup(dated, v => d3.sum(v, cnt), d => +d3.utcDay.floor(d.value));

  const TYPES = {
    // ---- text / number types ----
    List() {
      if (S.search) searchBox(body);
      const box = body.append('div').attr('class', 'f-list');
      refresh = () => rowsInto(box, matches());
    },
    // a button that says what is picked; the list opens under it
    Dropdown() {
      const btn = body.append('button').attr('type', 'button').attr('class', 'f-dd-btn');
      btn.append('span').attr('class', 'f-dd-text'); btn.append('span').attr('class', 'f-dd-caret');
      const panel = body.append('div').attr('class', 'f-dd-panel').attr('hidden', '');
      if (S.search) searchBox(panel);
      const box = panel.append('div').attr('class', 'f-list');
      btn.on('click', () => { const open = panel.attr('hidden') != null; panel.attr('hidden', open ? null : ''); btn.classed('f-open', open); if (open) panel.select('.f-search').node()?.focus(); });
      refresh = () => {
        btn.select('.f-dd-text').text(picked.size === 0 ? 'All' : picked.size === 1 ? label([...picked.values()][0]) : `${picked.size} selected`);
        rowsInto(box, matches());
      };
    },
    Chips() {
      if (S.search) searchBox(body);
      const box = body.append('div').attr('class', `f-chips f-shape-${String(S.chipShape || 'Pill').toLowerCase()}`);
      refresh = () => chipsInto(box, matches(), d => key(d.value), d => label(d.value), isOn, toggle);
    },
    Tiles() {
      if (S.search) searchBox(body);
      const box = body.append('div').attr('class', 'f-tiles').style('grid-template-columns', `repeat(${Math.max(1, S.tileColumns || 3)}, minmax(0, 1fr))`);
      refresh = () => box.selectAll('button.f-tile').data(matches(), d => key(d.value)).join(enter => {
        const b = enter.append('button').attr('type', 'button').attr('class', 'f-tile').on('click', (e, d) => toggle(d));
        b.append('span').attr('class', 'f-tile-label');
        if (S.counts) b.append('span').attr('class', 'f-tile-num');
        if (histOn && !fill) b.append('span').attr('class', 'f-tile-bar').append('span').attr('class', 'f-fill');
        return b;
      }).order()
        .classed('f-on', isOn).classed('f-dim', d => picked.size > 0 && !isOn(d))
        .classed('f-hfill', fill).style('--share', d => `${share(d) * 100}%`)
        .call(b => b.select('.f-tile-label').text(d => label(d.value)).attr('title', d => label(d.value)))
        .call(b => b.select('.f-tile-num').text(d => fmtCount(cnt(d))))
        .call(b => b.select('.f-fill').style('width', d => `${share(d) * 100}%`));
    },
    // type to find; Enter takes the first match; picks show as tokens (x removes one, Backspace the last)
    'Search Tokens'() {
      const bar = body.append('div').attr('class', 'f-tokbar');
      const toks = bar.append('div').attr('class', 'f-toks');
      searchBox(bar, 'Type to find values').on('keydown', e => {
        if (e.key === 'Enter') { const d = matches().find(x => !isOn(x)); if (d) { e.target.value = ''; query = ''; toggle(d); } }
        else if (e.key === 'Backspace' && !e.target.value && picked.size) { picked.delete([...picked.keys()].pop()); commit(); }
      });
      const box = body.append('div').attr('class', 'f-list f-sugg');
      refresh = () => {
        toks.selectAll('button.f-tok').data([...picked.values()], key).join(enter => {
          const b = enter.append('button').attr('type', 'button').attr('class', 'f-tok').attr('title', 'Remove').on('click', (e, v) => { picked.delete(key(v)); commit(); });
          b.append('span').attr('class', 'f-label'); b.append('span').attr('class', 'f-x').text('x');
          return b;
        }).call(b => b.select('.f-label').text(v => label(v)));
        rowsInto(box, matches().filter(d => !isOn(d)).slice(0, 100), false);
      };
    },
    // packed circles: size = rows, click to pick (the creative one)
    Bubbles() {
      const svg = body.append('svg').attr('class', 'f-bubbles').attr('width', bodyW).attr('height', bodyH);
      const leaves = d3.pack().size([bodyW, bodyH]).padding(3)(d3.hierarchy({ children: rows.slice(0, 200) }).sum(d => Math.max(1, cnt(d)))).leaves();
      const fs = S.fontSize || 12;
      const g = svg.selectAll('g.f-bub').data(leaves).join('g').attr('class', 'f-bub').attr('transform', d => `translate(${d.x},${d.y})`)
        .on('click', (e, d) => toggle(d.data));
      g.append('title').text(d => `${label(d.data.value)}: ${fmtCount(cnt(d.data))}`);
      g.append('circle').attr('r', d => d.r);
      const fit = (t, r) => { const n = Math.max(1, Math.floor((2 * r - 6) / (fs * 0.6))); return t.length > n ? t.slice(0, Math.max(1, n - 1)) + '.' : t; };
      const big = d => S.counts && d.r > fs * 1.8;
      g.filter(d => d.r > fs * 0.9).append('text').attr('class', 'f-bub-label').attr('text-anchor', 'middle')
        .attr('dy', d => big(d) ? '-0.1em' : '0.35em').text(d => fit(label(d.data.value), d.r));
      g.filter(big).append('text').attr('class', 'f-bub-num').attr('text-anchor', 'middle').attr('dy', '1.1em').text(d => fmtCount(cnt(d.data)));
      refresh = () => g.classed('f-on', d => isOn(d.data)).classed('f-dim', d => picked.size > 0 && !isOn(d.data))
        .select('circle').attr('fill', d => isOn(d.data) ? accent : histOn ? histColor : 'transparent')
        .attr('fill-opacity', d => isOn(d.data) ? 1 : histOn ? 0.12 + 0.5 * Math.sqrt(share(d.data)) : 1)
        .attr('stroke', accent);
    },
    // a brush over the histogram (numbers and dates)
    'Range Slider'() {
      const lab = body.append('div').attr('class', 'f-range-lab');
      const h = Math.max(50, bodyH - 22), m = { l: 10, r: 10, t: 6, b: 20 };
      const svg = body.append('svg').attr('class', 'f-range').attr('width', bodyW).attr('height', h);
      const vals = rows.filter(d => d.value != null);
      let [lo, hi] = d3.extent(vals, d => d.value);
      if (+lo === +hi) hi = kind === 'date' ? d3.utcDay.offset(lo, 1) : hi + 1;
      const x = (kind === 'date' ? d3.scaleUtc() : d3.scaleLinear()).domain([lo, hi]).range([m.l, bodyW - m.r]);
      const n = Math.max(5, Math.min(60, Math.floor(bodyW / 8)));
      const bins = d3.bin().value(d => +d.value).domain([+lo, +hi]).thresholds(kind === 'date' ? x.ticks(n).map(Number) : n)(vals);
      const binSum = b => d3.sum(b, cnt);
      const y = d3.scaleLinear().domain([0, d3.max(bins, binSum) || 1]).range([h - m.b, m.t]);
      const bars = svg.append('g').attr('class', 'f-hbars');
      if (histOn) bars.selectAll('rect').data(bins).join('rect')
        .attr('x', b => x(b.x0) + 0.5).attr('width', b => Math.max(0, x(b.x1) - x(b.x0) - 1))
        .attr('y', b => y(binSum(b))).attr('height', b => y(0) - y(binSum(b))).attr('rx', 1).attr('fill', histColor)
        .append('title').text(b => fmtCount(binSum(b)));
      else svg.append('line').attr('class', 'f-rtrack').attr('x1', m.l).attr('x2', bodyW - m.r).attr('y1', h - m.b).attr('y2', h - m.b);
      svg.append('g').attr('class', 'f-axis').attr('transform', `translate(0,${h - m.b})`)
        .call(d3.axisBottom(x).ticks(Math.max(2, Math.floor(bodyW / 90))).tickSizeOuter(0));
      const snap = v => kind === 'date' ? d3.utcDay.floor(v) : +v.toPrecision(6);
      const brush = d3.brushX().extent([[m.l, m.t], [bodyW - m.r, h - m.b]]).on('end', e => {
        if (!e.sourceEvent) return;
        if (!e.selection) { ranges = []; return commit(); }
        const [a, b] = e.selection.map(p => snap(x.invert(p)));
        ranges = [{ min: a, max: b }]; commit();
      });
      const gb = svg.insert('g', '.f-hbars').attr('class', 'f-brush').call(brush);   // under the bars, so they stay clear
      refresh = () => {
        const r = ranges[0], show = v => kind === 'date' ? fmtDay(v) : label(v);
        lab.text(r ? `${show(r.min)} - ${show(r.max)}${S.counts ? `  (${fmtCount(countIn(r))})` : ''}` : 'Drag across the chart to pick a range');
        gb.call(brush.move, r ? [x(r.min), x(kind === 'date' ? d3.utcDay.offset(r.max, 1) : r.max)].map(v => Math.max(m.l, Math.min(bodyW - m.r, v))) : null);
        bars.selectAll('rect').attr('fill-opacity', b => !r || (b.x1 > +r.min && b.x0 <= +r.max) ? 1 : 0.3);
      };
    },

    // ---- date types ----
    // a month: click a day, then another for a range
    Calendar() {
      const days = dayCounts(), maxDay = d3.max(days.values()) || 1;
      let month = d3.utcMonth.floor(ranges[0]?.min || d3.max(dated, d => d.value) || new Date()), anchor = null;
      const title = navBar(body, () => { month = d3.utcMonth.offset(month, -1); refresh(); }, () => { month = d3.utcMonth.offset(month, 1); refresh(); });
      const grid = body.append('div').attr('class', 'f-cal');
      const wd = S.weekStart === 'Monday' ? ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'] : ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
      refresh = () => {
        title.text(d3.utcFormat('%B %Y')(month));
        const start = weekIv.floor(month), r = ranges[0];
        grid.selectAll('*').remove();
        grid.selectAll('span.f-wd').data(wd).join('span').attr('class', 'f-wd').text(d => d);
        grid.selectAll('button.f-day').data(d3.utcDays(start, d3.utcDay.offset(start, 42))).join('button').attr('type', 'button').attr('class', 'f-day')
          .classed('f-out', d => d.getUTCMonth() !== month.getUTCMonth())
          .classed('f-has', d => days.has(+d)).classed('f-heat', d => histOn && days.has(+d))
          .style('--heat', d => histOn && days.has(+d) ? `${Math.round(15 + 60 * Math.sqrt(days.get(+d) / maxDay))}%` : null)
          .classed('f-in', d => !!r && inRange(d, r)).classed('f-edge', d => !!r && (+d === +r.min || +d === +r.max))
          .attr('title', d => fmtDay(d) + (days.has(+d) && S.counts ? `: ${fmtCount(days.get(+d))}` : ''))
          .text(d => d.getUTCDate())
          .on('click', (e, d) => {
            if (!anchor) { anchor = d; ranges = [{ min: d, max: d }]; }
            else { ranges = [{ min: anchor < d ? anchor : d, max: anchor < d ? d : anchor }]; anchor = null; }
            commit();
          });
      };
    },
    // two date boxes (type or pick)
    Manual() {
      const [lo, hi] = d3.extent(dated, d => d.value), iso = d3.utcFormat('%Y-%m-%d');
      const form = body.append('div').attr('class', 'f-manual');
      const field = text => { const l = form.append('label').attr('class', 'f-field'); l.append('span').text(text); return l.append('input').attr('type', 'date').attr('class', 'f-date').attr('min', lo && iso(lo)).attr('max', hi && iso(hi)); };
      const from = field('From'), to = field('To');
      const note = form.append('div').attr('class', 'f-note');
      const apply = () => {
        const a = from.property('value'), b = to.property('value');
        if (!a && !b) ranges = [];
        else { let min = a ? new Date(a) : lo, max = b ? new Date(b) : hi; if (min > max) [min, max] = [max, min]; ranges = [{ min, max }]; }
        commit();
      };
      from.on('change', apply); to.on('change', apply);
      refresh = () => {
        const r = ranges[0];
        from.property('value', r ? iso(r.min) : ''); to.property('value', r ? iso(r.max) : '');
        note.text(lo ? `Data: ${fmtDay(lo)} - ${fmtDay(hi)}${S.counts ? `  |  ${r ? 'Picked' : 'All'}: ${fmtCount(r ? countIn(r) : total)}` : ''}` : '');
      };
    },
    // one click: Last 7 Days, This Month ... (from today or from the latest date in the data)
    Presets() {
      const now = new Date(), D = d3.utcDay, M = d3.utcMonth, Y = d3.utcYear;
      const ref = S.relativeTo === 'Latest Date' && dated.length ? D.floor(d3.max(dated, d => d.value)) : new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
      const qs = d => new Date(Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1));
      const list = [['Today', ref, ref], ['Yesterday', D.offset(ref, -1), D.offset(ref, -1)], ['Last 7 Days', D.offset(ref, -6), ref],
        ['Last 30 Days', D.offset(ref, -29), ref], ['Last 90 Days', D.offset(ref, -89), ref], ['This Month', M.floor(ref), ref],
        ['Last Month', M.offset(M.floor(ref), -1), D.offset(M.floor(ref), -1)], ['This Quarter', qs(ref), ref],
        ['Last Quarter', M.offset(qs(ref), -3), D.offset(qs(ref), -1)], ['This Year', Y.floor(ref), ref],
        ['Last Year', Y.offset(Y.floor(ref), -1), D.offset(Y.floor(ref), -1)], ['Last 12 Months', D.offset(M.offset(ref, -12), 1), ref]]
        .map(([name, min, max]) => ({ name, min, max, count: countIn({ min, max }) }));
      const pmax = d3.max(list, p => p.count) || 1;
      const box = body.append('div').attr('class', 'f-presets');
      const on = p => state.preset === p.name && ranges.length > 0;
      refresh = () => box.selectAll('button.f-preset').data(list, p => p.name).join(enter => {
        const b = enter.append('button').attr('type', 'button').attr('class', 'f-preset')
          .on('click', (e, p) => { if (on(p)) { state.preset = null; ranges = []; } else { state.preset = p.name; ranges = [{ min: p.min, max: p.max }]; } commit(); });
        b.append('span').attr('class', 'f-label');
        if (S.counts) b.append('span').attr('class', 'f-num');
        if (histOn && !fill) b.append('span').attr('class', 'f-under');
        return b;
      })
        .classed('f-on', on).classed('f-dim', p => (active() && !on(p)) || !p.count)
        .classed('f-hfill', fill).style('--share', p => `${p.count / pmax * 100}%`)
        .attr('title', p => `${fmtDay(p.min)} - ${fmtDay(p.max)}`)
        .call(b => b.select('.f-label').text(p => p.name))
        .call(b => b.select('.f-num').text(p => fmtCount(p.count)))
        .call(b => b.select('.f-under').style('width', p => `${p.count / pmax * 100}%`));
    },
    // the data's years / quarters / months / weeks as chips (pick several)
    Periods() {
      const P = S.period || 'Month';
      const quarter = { floor: d => new Date(Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1)), offset: (d, n) => d3.utcMonth.offset(d, 3 * n) };
      const iv = { Year: d3.utcYear, Quarter: quarter, Month: d3.utcMonth, Week: weekIv }[P] || d3.utcMonth;
      const name = { Year: d3.utcFormat('%Y'), Quarter: d => `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`,
        Month: d3.utcFormat('%b %Y'), Week: d => `Wk ${d3.utcFormat('%b %-d, %Y')(d)}` }[P] || d3.utcFormat('%b %Y');
      const groups = d3.rollups(dated, v => d3.sum(v, cnt), d => +iv.floor(d.value)).sort((a, b) => a[0] - b[0])
        .map(([t, count]) => { const min = new Date(t); return { min, max: d3.utcDay.offset(iv.offset(min, 1), -1), count }; });
      const box = body.append('div').attr('class', 'f-chips f-shape-rounded');
      const on = g => ranges.some(r => +r.min === +g.min);
      refresh = () => chipsInto(box, groups, g => +g.min, g => name(g.min), on, g => {
        ranges = on(g) ? ranges.filter(r => +r.min !== +g.min) : [...(S.single ? [] : ranges), { min: g.min, max: g.max }];
        commit();
      });
    },
    // a year of days as a heat map (the creative one): click a day, drag across days, or click a month name. Only the
    // weeks of that year that hold data are drawn (at least 13), so the cells stay big.
    Heatmap() {
      const days = dayCounts(), maxDay = d3.max(days.values()) || 1;
      const years = [...new Set(dated.map(d => d.value.getUTCFullYear()))].sort();
      let year = state.year ?? (ranges[0]?.max || d3.max(dated, d => d.value) || new Date()).getUTCFullYear();
      const title = navBar(body, () => { year = Math.max(years[0], year - 1); state.year = year; refresh(); },
        () => { year = Math.min(years[years.length - 1], year + 1); state.year = year; refresh(); });
      const h = Math.max(40, bodyH - 26);
      const svg = body.append('svg').attr('class', 'f-heatmap').attr('width', bodyW).attr('height', h);
      const L = 26, T = 14;
      refresh = () => {
        title.text(year);
        svg.selectAll('*').remove();
        const Y0 = new Date(Date.UTC(year, 0, 1)), Y1 = new Date(Date.UTC(year + 1, 0, 1));
        const inYear = dated.map(d => d.value).filter(d => d >= Y0 && d < Y1);
        let w0 = weekIv.floor(d3.min(inYear) || Y0), wEnd = weekIv.offset(weekIv.floor(d3.max(inYear) || Y1), 1);
        while (weekIv.count(w0, wEnd) < 13) { if (wEnd < Y1) wEnd = weekIv.offset(wEnd, 1); else if (w0 > Y0) w0 = weekIv.offset(w0, -1); else break; }
        const y0 = w0 < Y0 ? Y0 : w0, y1 = wEnd > Y1 ? Y1 : wEnd;
        const weeks = weekIv.count(w0, y1) + 1, cell = Math.max(3, Math.min(28, (bodyW - L - 2) / weeks, (h - T - 2) / 7));
        const row = d => d3.utcDay.count(weekIv.floor(d), d), col = d => weekIv.count(w0, d);
        const r = ranges[0];
        const wd = S.weekStart === 'Monday' ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        svg.selectAll('text.f-hm-wd').data([1, 3, 5]).join('text').attr('class', 'f-hm-wd').attr('x', L - 4).attr('text-anchor', 'end')
          .attr('y', i => T + i * cell + cell * 0.75).text(i => wd[i]);
        svg.selectAll('text.f-hm-mo').data(d3.utcMonths(y0, y1)).join('text').attr('class', 'f-hm-mo').attr('x', d => L + col(d) * cell).attr('y', T - 4)
          .text(d3.utcFormat('%b')).on('click', (e, d) => { ranges = [{ min: d, max: d3.utcDay.offset(d3.utcMonth.offset(d, 1), -1) }]; commit(); })
          .append('title').text('Pick this month');
        const cells = svg.selectAll('rect.f-hm-day').data(d3.utcDays(y0, y1)).join('rect').attr('class', 'f-hm-day')
          .attr('x', d => L + col(d) * cell).attr('y', d => T + row(d) * cell).attr('width', Math.max(1, cell - 2)).attr('height', Math.max(1, cell - 2)).attr('rx', 2)
          .classed('f-none', d => !days.has(+d))
          .attr('fill', d => days.has(+d) ? accent : null)
          .attr('fill-opacity', d => days.has(+d) ? (histOn ? 0.2 + 0.8 * Math.sqrt(days.get(+d) / maxDay) : 0.6) : null)
          .classed('f-in', d => !!r && inRange(d, r));
        cells.append('title').text(d => fmtDay(d) + (days.has(+d) && S.counts ? `: ${fmtCount(days.get(+d))}` : ''));
        const at = e => {
          const [px, py] = d3.pointer(e, svg.node()), c = Math.floor((px - L) / cell), rr = Math.floor((py - T) / cell);
          if (c < 0 || rr < 0 || rr > 6 || c >= weeks) return null;
          const d = d3.utcDay.offset(w0, c * 7 + rr);
          return d >= y0 && d < y1 ? d : null;
        };
        svg.on('pointerdown', e => {
          const d = at(e); if (!d || e.button !== 0) return;
          e.preventDefault();
          const drag = { from: d, min: d, max: d };
          const mv = ev => { const t = at(ev); if (!t) return; drag.min = t < drag.from ? t : drag.from; drag.max = t < drag.from ? drag.from : t; cells.classed('f-in', x => inRange(x, drag)); };
          const up = () => {
            removeEventListener('pointermove', mv); removeEventListener('pointerup', up);
            const r0 = ranges[0], { min, max } = drag;
            ranges = r0 && +min === +max && +r0.min === +min && +r0.max === +max ? [] : [{ min, max }];   // a click on the one picked day clears it
            commit();
          };
          addEventListener('pointermove', mv); addEventListener('pointerup', up);
        });
      };
    },
  };
  (TYPES[type] || TYPES.List)();
  update();
  return root.node();
}
