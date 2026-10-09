// ApexCharts / ApexGrid / ApexTree drawing for widget packages (used by ApexWidget.render). Global: ApexRender.
// Needs js/vendor/apexcharts.min.js and apextree.min.js; a missing library only breaks the widgets of that kind. Data Grids
// are drawn by their own package renderer (widgets/<id>/grid.js), not by Apex.
//
// spec.json = the library's own options (paste a demo's options object), plus "$kind" and "data" (the inputs).
//   Without a dataset (sample preview) the spec is drawn as-is, with its own series / labels / categories
//   (no series in the spec: sample rows).
//   With a dataset, query rows replace them. Inputs are used in order:
//     pie / donut / polarArea / radialBar   labels = 1st dimension, series = 1st measure
//     line / area / bar / radar / ...       categories = 1st dimension; 2nd dimension = one series per value, else one series per measure
//     heatmap                                x = 1st dimension, one series per value of the 2nd dimension
//     treemap                                x = 1st dimension, y = 1st measure; 2nd dimension = groups
//     scatter / bubble                       [x, y, (z)] = measures in order; 1st dimension = one series per value
//     candlestick / boxPlot                  x = 1st dimension, y = all measures in order
//     rangeBar                               x = 1st dimension, y = [1st, 2nd measure]; 2nd dimension = series
//   grid: columns = the picked fields (role 'fields'); spec = showQuickFilter / showExport / exportFilename + "columnDefaults"
//   tree: levels = dimensions in order, node value = 1st measure; spec = ApexTree options + "rootName"
const ApexRender = (() => {
  const isObj = o => o && typeof o === 'object' && !Array.isArray(o);
  const deep = (a, b) => { const out = { ...a }; for (const [k, v] of Object.entries(b || {})) out[k] = isObj(v) && isObj(a?.[k]) ? deep(a[k], v) : v; return out; };
  const num = v => v == null || v === '' ? null : Number(v);
  const lbl = v => v == null ? '(null)' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
  const time = v => v instanceof Date ? +v : typeof v === 'number' ? v : (t => isNaN(t) ? Number(v) : t)(Date.parse(v));
  const strip = s => { const { $kind, data, query, sampleData, ...o } = s; return o; };
  const need = (g, name) => { if (typeof g === 'undefined') throw new Error(`${name} is not loaded: put it in js/vendor/.`); };

  // ---- ApexCharts ----
  function chartTheme(th, H) {
    return {
      chart: { height: H, width: '100%', background: 'transparent', foreColor: th.text2, fontFamily: th.font, toolbar: { show: false }, parentHeightOffset: 0,
        redrawOnParentResize: false, redrawOnWindowResize: false,
        animations: { enabled: true, respectReducedMotion: false, speed: 300, easing: 'easeout', animateGradually: { enabled: false }, dynamicAnimation: { enabled: true, speed: 300 } } },
      theme: { mode: th.dark ? 'dark' : 'light' }, colors: th.colors,
      grid: { borderColor: th.border, strokeDashArray: 3 },
      tooltip: { theme: th.dark ? 'dark' : 'light', style: { fontFamily: th.font } },
      legend: { labels: { colors: th.text2 }, fontFamily: th.font },
      xaxis: { axisBorder: { color: th.border }, axisTicks: { color: th.border }, labels: { style: { fontFamily: th.font } }, title: { style: { fontFamily: th.font } } },
      yaxis: { labels: { style: { fontFamily: th.font } }, title: { style: { fontFamily: th.font } } },
      dataLabels: { style: { fontFamily: th.font } }, title: { style: { fontFamily: th.font } }, subtitle: { style: { fontFamily: th.font } },
      plotOptions: { pie: { donut: { labels: { name: { color: th.text2 }, value: { color: th.text } } } }, radialBar: { track: { background: th.sel }, dataLabels: { name: { color: th.text2 }, value: { color: th.text } } } },
      noData: { text: 'No data', style: { color: th.muted } },
    };
  }
  function chartData(type, ins, rows) {
    const dims = ins.filter(i => i.role === 'dimension'), meas = ins.filter(i => i.role === 'measure');
    const d1 = dims[0]?.key, d2 = dims[1]?.key, m1 = meas[0]?.key;
    const has = k => k && rows.some(r => r[k] !== undefined);
    const group = (key, make) => { const g = new Map(); for (const r of rows) { const n = key && r[key] !== undefined ? lbl(r[key]) : meas[0]?.label || 'Value'; if (!g.has(n)) g.set(n, []); g.get(n).push(make(r)); } return [...g].slice(0, 30).map(([name, data]) => ({ name, data })); };
    if (['pie', 'donut', 'polarArea', 'radialBar'].includes(type)) return { labels: rows.map(r => lbl(r[d1])), series: rows.map(r => num(r[m1]) ?? 0) };
    if (type === 'heatmap') return { series: group(d2, r => ({ x: lbl(r[d1]), y: num(r[m1]) ?? 0 })) };
    if (type === 'treemap') return { series: group(has(d2) ? d2 : null, r => ({ x: lbl(r[d1]), y: num(r[m1]) ?? 0 })) };
    if (type === 'scatter' || type === 'bubble') return { series: group(has(d1) ? d1 : null, r => meas.slice(0, type === 'bubble' ? 3 : 2).map(i => num(r[i.key]))) };
    if (type === 'candlestick' || type === 'boxPlot') return { series: [{ name: meas[0]?.label || 'Value', data: rows.map(r => ({ x: lbl(r[d1]), y: meas.map(i => num(r[i.key])) })) }] };
    if (type === 'rangeBar') return { series: group(has(d2) ? d2 : null, r => ({ x: lbl(r[d1]), y: meas.slice(0, 2).map(i => time(r[i.key])) })) };
    // category charts
    if (has(d2)) {
      const cats = [...new Set(rows.map(r => lbl(r[d1])))], cell = new Map(rows.map(r => [lbl(r[d1]) + '\u0001' + lbl(r[d2]), num(r[m1])]));
      return { xaxis: { categories: cats }, series: [...new Set(rows.map(r => lbl(r[d2])))].slice(0, 30).map(s => ({ name: s, data: cats.map(c => cell.get(c + '\u0001' + s) ?? null) })) };
    }
    return { xaxis: { categories: rows.map(r => lbl(r[d1])) }, series: meas.map(i => ({ name: i.label || i.key, data: rows.map(r => num(r[i.key])) })) };
  }
  // prev: the chart already in box (same type): updated in place, so the marks animate to the new values / size.
  async function chart(box, s, ins, rows, W, H, th, live, prev) {
    need(window.ApexCharts, 'ApexCharts (apexcharts.min.js)');
    let o = deep(chartTheme(th, H), strip(s));
    o = deep(o, { chart: { height: H, width: '100%' } });
    if (live || !Array.isArray(s.series)) { const d = chartData(o.chart?.type || 'line', ins, rows); if (d.labels) o.labels = d.labels; o.series = d.series; if (d.xaxis) o.xaxis = deep(o.xaxis || {}, d.xaxis); }
    if (prev) { await prev.updateOptions(o, false, true); return prev; }
    const c = new ApexCharts(box, o); await c.render(); return c;
  }

  // ---- ApexTree ----
  function treeData(ins, rows, rootName) {
    const dims = ins.filter(i => i.role === 'dimension').map(i => i.key), m1 = ins.find(i => i.role === 'measure')?.key;
    const root = { id: 'root', name: rootName || 'All', value: 0, children: [] }, idx = new Map([['', root]]); let n = 0;
    for (const r of rows) {
      const v = num(r[m1]) || 0; let path = '', parent = root; root.value += v;
      for (const k of dims) {
        if (r[k] === undefined) break;
        path += '\u0001' + lbl(r[k]);
        if (!idx.has(path)) { const node = { id: 'n' + (++n), name: lbl(r[k]), value: 0, children: [] }; idx.set(path, node); parent.children.push(node); }
        parent = idx.get(path); parent.value += v;
      }
    }
    const fin = x => { if (m1) x.name = `${x.name}: ${x.value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`; x.children.forEach(fin); if (!x.children.length) delete x.children; return x; };
    return fin(root);
  }
  function tree(box, s, ins, rows, W, H, th, live) {
    need(window.ApexTree, 'ApexTree (apextree.min.js)');
    const base = { contentKey: 'name', fontFamily: th.font, fontColor: th.text, nodeBGColor: th.panel2, nodeBGColorHover: th.sel, borderColor: th.border, borderColorHover: th.blue,
      edgeColor: th.muted, edgeColorHover: th.blue, canvasStyle: 'background: transparent;', expandCollapseButtonBGColor: th.panel, expandCollapseButtonBorderColor: th.border, expandCollapseButtonIconColor: th.text2 };
    const t = new ApexTree(box, { ...deep(base, strip(s)), width: W, height: H });
    t.render(live ? treeData(ins, rows, s.rootName) : s.sampleData || treeData(ins, rows, s.rootName));
    return t;
  }

  // ---- Data Grid: drawn by the widget's own renderer (widgets/<id>/grid.js, widget.json "renderer"; global DNGrid),
  // loaded once per window. No ApexGrid. Its look is the widget's style.css only.
  const loads = new WeakMap();   // window -> Map(src -> promise)
  function loadRenderer(doc, wid, file) {
    const win = doc.defaultView;
    let m = loads.get(win); if (!m) loads.set(win, m = new Map());
    const src = `/widgets/${encodeURIComponent(wid || 'data-grid')}/${file || 'grid.js'}`;
    if (!m.has(src)) m.set(src, new Promise((res, rej) => {
      const s = Object.assign(doc.createElement('script'), { src, onload: res, onerror: () => rej(new Error(`Could not load the grid renderer ${src}.`)) });
      doc.head.append(s);
    }));
    return m.get(src);
  }
  // Pop-out (every Data Grid): the same grid in its own window (html/grid-pop.html), which reads what to draw from
  // window.DNGridPops[id] here (spec, rows or the engine pager, columns) and draws it with its own scripts.
  // While it is popped out, the grid here is hidden (a note says where it is) and the page gets 'grid-popout'
  // { open: true } on the box (Transform gives the SQL editor the room); it comes back when that window closes.
  const pops = new WeakMap();   // box -> pop-out window
  function popOut(d, box) {
    const was = box && pops.get(box);
    if (was && !was.closed) return was.focus();
    const id = Math.random().toString(36).slice(2);
    (window.DNGridPops ||= {})[id] = d;
    const w = window.open(`${location.pathname.includes('/html/') ? '' : 'html/'}grid-pop.html?id=${id}`, `dn-grid-${id}`, 'popup,width=1100,height=700');   // window.: a page may have its own global named open
    if (!w) return window.UI?.toast('The browser blocked the pop-out window. Allow pop-ups for this site.', 'err');
    w.focus();
    if (!box) return;
    pops.set(box, w);
    const note = Object.assign(document.createElement('div'), { className: 'dg-popped', textContent: 'This table is open in its own window. Close that window to bring it back here.' });
    box.style.display = 'none'; box.after(note);
    const host = box.parentElement;   // stays on the page even if a new grid replaces this one
    const say = open => (box.isConnected ? box : host)?.dispatchEvent(new CustomEvent('grid-popout', { bubbles: true, detail: { open, win: w } }));
    say(true);
    const watch = setInterval(() => {
      if (!w.closed && box.isConnected) return;
      clearInterval(watch); pops.delete(box); note.remove(); box.style.display = ''; delete window.DNGridPops[id];
      say(false);
    }, 400);
  }
  async function grid(box, s, rows, names, columns, remote, popped, wid, renderer, more, total) {
    await loadRenderer(box.ownerDocument, wid, renderer);
    const { columnDefaults = {}, style: _s, ...props } = strip(s);
    const title = () => box.closest('.wd')?.querySelector('.wh b')?.textContent || box.ownerDocument.title.split(' · ')[0] || 'Data Grid';   // widget title, else the page (Transform, Import)
    return box.ownerDocument.defaultView.DNGrid.create(box, { names, columns, rows, remote, more, total, props, columnDefaults, popped,
      onPop: cur => popOut({ s, rows: cur?.rows || rows, names, columns, remote, more, total, wid, title: title() }, box) });
  }

  // el: an empty box; rows keyed by input key (grid: by column name). live = rows come from a dataset (else the spec's own data).
  async function render(kind, box, s, ins, rows, W, H, th, { live, names = [], columns = [], prev = null, remote = null, more = null, total = null, popped = false, wid = '', renderer = '' }) {
    if (kind === 'apexgrid') return grid(box, s, rows, names, columns, remote, popped, wid, renderer, more, total);
    await document.fonts?.load(`11px ${th.font.split(',')[0]}`).catch(() => {});   // Exo 2 loaded before Apex measures label widths
    if (kind === 'apexcharts') return chart(box, s, ins, rows, W, H, th, live, prev);
    if (kind === 'apextree') return tree(box, s, ins, rows, W, H, th, live);
  }
  function dispose(inst) { try { inst?.destroy?.(); } catch {} }
  return { render, dispose };
})();
