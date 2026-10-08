// ApexCharts / ApexGrid / ApexTree drawing for widget packages (used by ApexWidget.render). Global: ApexRender.
// Needs js/vendor/apexcharts.min.js, apextree.min.js and the ApexGrid module (js/widgets/apex-grid-loader.js); a missing
// library only breaks the widgets of that kind.
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
//   grid: columns = the picked fields (role 'fields'); spec = <apex-grid> properties + "columnDefaults" + "style" (CSS vars)
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

  // ---- ApexGrid ----
  const gridVars = th => ({ '--ag-font': th.font, '--ag-grid-bg': th.panel, '--ag-surface': th.panel, '--ag-surface-alt': th.panel2, '--ag-surface-elevated': th.panel2,
    '--ag-text': th.text, '--ag-text-body': th.text, '--ag-text-muted': th.muted, '--ag-text-subtle': th.text2, '--ag-border': th.border, '--ag-hairline': th.border,
    '--ag-header-separator': th.border, '--header-background': th.panel2, '--ag-row-hover': th.sel, '--ag-brand': th.blue, '--ag-grid-shadow': 'none', '--ag-shadow-card': 'none' });
  // No scroll bars inside the grid (the app's rule): the mouse wheel scrolls. Injected into every shadow root of the grid.
  const NOBAR = ':host,*{scrollbar-width:none}:host::-webkit-scrollbar,*::-webkit-scrollbar{display:none}'
    // Sticky header rows: solid (the panel colour) and above the rows, so scrolled rows never show through them.
    + 'apex-grid-header-row,apex-grid-group-header-row,apex-filter-row{background:var(--ag-surface-elevated)!important;z-index:20!important}';
  function hideBars(root) {
    if (!root || root.querySelector?.(':scope > style[data-nobar]')) return;
    const st = document.createElement('style'); st.textContent = NOBAR; st.dataset.nobar = '1'; root.append(st);
    root.querySelectorAll('*').forEach(e => e.shadowRoot && hideBars(e.shadowRoot));
  }
  // remote(g, bar): GridRemote.attach (rows come from the engine, 100 at a time) + the bar above the grid (search, readout, Export).
  async function grid(box, s, rows, names, columns, th, remote) {
    await Promise.race([window.ApexGridReady, new Promise((_, no) => setTimeout(() => no(new Error('ApexGrid is not loaded: put apex-grid in js/vendor/.')), 3000))]);
    const { columnDefaults = {}, style = {}, ...props } = strip(s), g = document.createElement('apex-grid');
    for (const [k, v] of Object.entries({ ...gridVars(th), ...style })) g.style.setProperty(k, v);
    g.style.height = '100%'; g.style.display = 'block';
    Object.assign(g, props);
    const typeOf = n => { const c = columns.find(x => x.name === n); return c ? (/INT|DOUBLE|FLOAT|DECIMAL|REAL|NUMERIC/i.test(c.type) ? 'number' : /BOOL/i.test(c.type) ? 'boolean' : 'string') : typeof rows[0]?.[n] === 'number' ? 'number' : 'string'; };
    g.columns = names.map(n => ({ key: n, headerText: n, type: typeOf(n), ...columnDefaults }));
    if (remote) {
      // Our own bar above the grid (app look, not Apex): search box (when the spec shows one) + the row under the mouse.
      const bar = document.createElement('div'); bar.className = 'gbar';
      // Export (when the spec shows it): our button at the right end; its menu raises 'grid-export' { format } on the box.
      bar.innerHTML = `${g.showQuickFilter !== false ? '<input class="search" type="search" placeholder="Search">' : ''}<span class="grow muted"></span>`
        + '<span class="spacer"></span>'
        + (g.showExport ? `<div class="addwrap gexp"><button class="ghost small">Export ▾</button><div class="addmenu">${['.csv', '.parquet', '.sqlite']
          .map(f => `<div data-fmt="${f.slice(1)}">${f}</div>`).join('')}</div></div>` : '');
      g.showQuickFilter = false; g.showExport = false;
      const ex = bar.querySelector('.gexp');
      if (ex) {
        const menu = ex.querySelector('.addmenu');
        ex.querySelector('button').onclick = e => { e.stopPropagation(); document.querySelectorAll('.addmenu.open').forEach(m => m !== menu && m.classList.remove('open')); menu.classList.toggle('open'); };
        menu.onclick = e => { const f = e.target.closest('[data-fmt]')?.dataset.fmt; if (!f) return; menu.classList.remove('open'); box.dispatchEvent(new CustomEvent('grid-export', { bubbles: true, detail: { format: f } })); };
        addEventListener('click', () => menu.classList.remove('open'));
      }
      box.style.display = 'flex'; box.style.flexDirection = 'column'; g.style.flex = '1'; g.style.minHeight = '0';
      box.append(bar);
      remote(g, bar);
    } else g.data = rows;
    box.append(g);
    await g.updateComplete; hideBars(g.shadowRoot); setTimeout(() => hideBars(g.shadowRoot), 300);   // late-rendered parts too
    return g;
  }

  // el: an empty box; rows keyed by input key (grid: by column name). live = rows come from a dataset (else the spec's own data).
  async function render(kind, box, s, ins, rows, W, H, th, { live, names = [], columns = [], prev = null, remote = null }) {
    await document.fonts?.load(`11px ${th.font.split(',')[0]}`).catch(() => {});   // Exo 2 loaded before Apex measures label widths
    if (kind === 'apexcharts') return chart(box, s, ins, rows, W, H, th, live, prev);
    if (kind === 'apextree') return tree(box, s, ins, rows, W, H, th, live);
    return grid(box, s, rows, names, columns, th, remote);
  }
  function dispose(inst) { try { inst?.destroy?.(); } catch {} }
  return { render, dispose };
})();

// ApexGrid is an ES module: js/widgets/apex-grid-loader.js resolves this once <apex-grid> is registered.
window.ApexGridReady ||= new Promise(res => addEventListener('apexgrid-ready', res, { once: true }));
