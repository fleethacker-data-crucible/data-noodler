// Publishing a project's dashboard and datasets, shared by Publish (the page) and Update (re-runs the project's saved
// publish choices). Global: Publisher. Needs dn-fs.js, engine-client.js, ui.js, projects.js.
//   ctx = { folder, dir, cfg, log(msg, level) }   (a module page ctx, or one built by Update)
//   cfg.publish = { name, targets: ['image'|'pdf'|'pptx'|'web'], image: { name, formats, res }, data: { names, fmt } }
//   await Publisher.dashboard(ctx, { name })   every ticked format -> <project>/publish/<name>.<ext>; returns files written
//   await Publisher.data(ctx, { names, fmt })  each dataset -> <project>/publish/data-<stamp>/<name>.<fmt>
//   Publisher.TARGETS, IMG_FMTS, imgSettings(cfg), nameStamp(), STAMP, fixName(v), MANIFEST(ctx), loadRenderers()
const Publisher = (() => {
  const esc = UI.esc;
  const TARGETS = [   // alphabetical
    { id: 'image', label: 'Image (.jpg, .png, .webp)', desc: 'One picture per chart widget, in the formats and sizes picked in Settings.', img: true },
    { id: 'pdf', label: 'PDF (.pdf)', desc: 'The dashboard as a one-page PDF that opens in any PDF reader.' },
    { id: 'pptx', label: 'PowerPoint Slide', desc: 'The dashboard as a slide in a PowerPoint (.pptx) file.' },
    { id: 'web', label: 'Web App (.html)', desc: 'A self-contained web page that opens in any browser, without the server or the data.' },
  ];
  const IMG_FMTS = ['jpg', 'png', 'webp'];
  const imgSettings = cfg => { const s = cfg.publish?.image || {}; return { name: s.name || '', formats: s.formats?.length ? s.formats : ['png'], res: s.res?.length ? s.res : ['default'] }; };
  // Dashboard Name: YYYY_MM_DD_HHMMSS_ (local time) then Title_Case words; spaces become _.
  const nameStamp = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}_${p(d.getMonth() + 1)}_${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}_`; };
  const STAMP = /^\d{4}_\d{2}_\d{2}_\d{6}_/;
  const fixName = v => v.replace(/\s/g, '_').replace(/[\\/:*?"<>|]/g, '').replace(/(^|_)([a-z])/g, (m, a, c) => a + c.toUpperCase());
  const MANIFEST = ctx => `${ctx.dir}/publish/published.json`;
  const fileStamp = () => new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '').replace(/(\d{8})(\d{6})/, '$1-$2');

  // D3 and the widget code load only when something is published, not with the page.
  let renderers;
  const addScript = src => new Promise((res, rej) => document.head.append(Object.assign(document.createElement('script'), { src, async: false, onload: res, onerror: () => rej(new Error(`Could not load ${src}`)) })));
  const loadRenderers = () => renderers ||= Promise.all([typeof d3 === 'undefined' && '/ui/js/vendor/d3.v7.min.js', typeof bb === 'undefined' && '/ui/js/vendor/billboard/billboard.min.js', typeof BBChart === 'undefined' && '/ui/js/widgets/bb-chart.js', typeof DNGrid === 'undefined' && '/ui/js/grid/data-grid.js', typeof DNTable === 'undefined' && '/ui/js/widgets/dn-table.js', typeof Widgets === 'undefined' && '/ui/js/widgets/widgets.js',
    typeof Pptx === 'undefined' && '/ui/js/core/pptx.js', typeof Pdf === 'undefined' && '/ui/js/core/pdf.js'].filter(Boolean).map(addScript)).catch(e => { renderers = null; throw e; });
  // Picture at W x H (scaled by s): the published page's cards drawn through an SVG foreignObject.
  // inner is the board's cards, or { chart } for one widget's chart body alone (no card, no title).
  async function rasterize(css, inner, W, H, s = 1) {
    const doc = document.implementation.createHTMLDocument('');
    doc.body.innerHTML = typeof inner === 'string' ? `<div class="board" style="width:${W}px;height:${H}px;margin:0">${inner}</div>`
      : `<div class="card" style="position:relative;width:${W}px;height:${H}px;padding:0"><div class="body" style="border:0;border-radius:0">${inner.chart}</div></div>`;
    const xhtml = new XMLSerializer().serializeToString(doc.body.firstChild);
    W = Math.round(W * s); H = Math.round(H * s);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W / s} ${H / s}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="width:${W / s}px;height:${H / s}px;background:var(--bg)"><style>${esc(css.replace(/@font-face[^}]+}/g, ''))}
.board{position:relative}.card{position:absolute;box-sizing:border-box;padding:4px;display:flex;flex-direction:column}.card>*{min-width:0}
.card h3{margin:0;padding:6px 10px;font-size:13px;font-weight:600;background:var(--panel);border:1px solid var(--border);border-bottom:0;border-radius:4px 4px 0 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.card .body{flex:1;min-height:0;background:var(--panel);border:1px solid var(--border);border-radius:0 0 4px 4px;padding:6px 8px;overflow:hidden}
.card .body>svg,.card .body>figure>svg:last-child{width:100%;height:100%}.card .body>figure{margin:0;height:100%;display:flex;flex-direction:column}.card .body>figure>svg:last-child{flex:1;min-height:0}
.note{height:100%;display:grid;place-items:center;color:var(--muted)}</style>${xhtml}</div></foreignObject></svg>`;
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await img.decode();
    const cv = Object.assign(document.createElement('canvas'), { width: W, height: H }), g = cv.getContext('2d');
    g.fillStyle = getComputedStyle(document.body).backgroundColor || '#1a1a19'; g.fillRect(0, 0, W, H);
    g.drawImage(img, 0, 0);
    const blob = (type, q) => new Promise((res, rej) => cv.toBlob(b => b ? res(b) : rej(new Error(`Could not make the ${type} image.`)), type, q));
    const png = await blob('image/png');
    return { png, as: (t, q = 0.92) => t === 'png' ? png : blob(t === 'jpg' ? 'image/jpeg' : 'image/webp', q) };
  }

  // The dashboard in every ticked format (cfg.publish.targets). name = the full file name (with its stamp).
  async function dashboard(ctx, { name } = {}) {
    const cfg = ctx.cfg, log = ctx.log || (() => {});
    if (!cfg.publish?.targets?.length) throw new Error('Tick at least one format.');
    await loadRenderers();
    const dash = await DNFS.readJSONOr(`${ctx.dir}/dashboard/dashboard.json`, null);
    if (!dash) throw new Error('No dashboard yet. Build one in the Dashboard module first.');
    if (!dash.widgets?.length) throw new Error('The dashboard has no widgets.');
    // Each widget is drawn here at its dashboard size (its own code, the project's copy in dashboard/widgets/; charts are
    // billboard.js, drawn without animation and scaled by their viewBox) and embedded as static markup with its style.css
    // and the billboard theme CSS: the page needs no JavaScript.
    const pkgs = new Map((await Widgets.list(Widgets.projectDir(ctx))).map(p => [p.id, p])), src = await Projects.sourceDatasets(ctx.folder, cfg);
    const y0 = Math.min(...dash.widgets.map(w => w.y)), COLS = 48, ROWS = Math.max(27, ...dash.widgets.map(w => w.y - y0 + w.h)), CELL = 30, cards = [], charts = [], styles = new Map();
    const host = Object.assign(document.createElement('div'), { style: 'position:fixed;left:-99999px;top:0' }); document.body.append(host);
    try {
      for (const w of dash.widgets) {
        const p = pkgs.get(w.widget), d = src.find(x => x.name === w.dataset);
        let body, title = p?.name || '';
        if (!w.widget) continue;   // an empty Custom Widget container: left out
        if (!p) body = `<div class="note err">Widget ${esc(w.widget)} not found</div>`;
        else if (!d) body = `<div class="note err">Dataset ${esc(w.dataset || '(none)')} not found</div>`;
        else {
          const el = Object.assign(document.createElement('div'), { style: `width:${w.w * CELL - 16}px;height:${w.h * CELL - 44}px` }); host.append(el);
          try {
            const s = Widgets.parse(p.settings), rows = Widgets.ready(s.inputs, w.inputs || {}) ? await Widgets.load(s.inputs, w.inputs || {}, d) : [];
            await Widgets.draw(el, { ...p, key: p.id }, rows, undefined, { static: true, links: w.inputs || {} });
            styles.set(p.id, document.getElementById(`dn-widget-${p.id.replace(/[^A-Za-z0-9_-]/g, '_')}-style`)?.textContent || '');
            body = `<div class="${esc(el.className)}" style="width:100%;height:100%">${el.innerHTML}</div>`;
            charts.push({ title: title || 'Widget', body, w: w.w * CELL - 16, h: w.h * CELL - 44 });
          }
          catch (e) { body = `<div class="note err">${esc(String(e.message || e).split('\n')[0])}</div>`; }
        }
        cards.push(`<div class="card" style="left:${w.x / COLS * 100}%;top:${(w.y - y0) / ROWS * 100}%;width:${w.w / COLS * 100}%;height:${w.h / ROWS * 100}%"><h3>${esc(title)}</h3><div class="body">${body}</div></div>`);
      }
    } finally { host.remove(); }
    if (!cards.length) throw new Error('No widget is set up yet (Edit Widget, attach a CLEAN_ dataset, Save).');
    const css = (await (await fetch('/ui/css/theme.css')).text()) + '\n' + [...styles.values()].join('\n') + '\n' + (typeof BBChart !== 'undefined' ? BBChart.css() : '') + '\n' + (typeof DNTable !== 'undefined' ? DNTable.css() : '');
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(cfg.name)} · Dashboard</title>
<style>${css.replace(/@font-face[^}]+}/g, '')}
.board{position:relative;width:min(100%,calc((100vh - 120px) * ${COLS} / ${ROWS}));aspect-ratio:${COLS}/${ROWS};margin:0 auto}
.card{position:absolute;box-sizing:border-box;padding:4px;display:flex}
.card>*{min-width:0}
.card{flex-direction:column}
.card h3{margin:0;padding:6px 10px;font-size:13px;font-weight:600;background:var(--panel);border:1px solid var(--border);border-bottom:0;border-radius:4px 4px 0 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.card .body{flex:1;min-height:0;background:var(--panel);border:1px solid var(--border);border-radius:0 0 4px 4px;padding:6px 8px;overflow:hidden}
.card .body>svg,.card .body>figure>svg:last-child{width:100%;height:100%}
.card .body>figure{margin:0;height:100%;display:flex;flex-direction:column}
.card .body>figure>svg:last-child{flex:1;min-height:0}
.note{height:100%;display:grid;place-items:center;color:var(--muted)}</style></head>
<body><div class="app"><header class="topbar"><div class="brand"><span class="logo">DN</span><div><h1>${esc(cfg.name)}</h1><div class="sub">Dashboard published ${esc(new Date().toLocaleString(undefined, { hourCycle: 'h23' }))}${cfg.classification ? ` (classification: ${esc(cfg.classification)})` : ''}</div></div></div></header>
<div class="main"><div class="board">${cards.join('\n')}</div></div></div></body></html>`;
    // Every ticked format goes to the project's publish folder as <Dashboard Name>.<ext>.
    name = fixName(name || nameStamp() + (cfg.publish?.name || '')).replace(/_+$/, '') || nameStamp() + 'Dashboard';
    const base = `${ctx.dir}/publish/${name}`, want = new Set(cfg.publish.targets);
    const man = await DNFS.readJSONOr(MANIFEST(ctx), {}), at = new Date().toISOString(), files = [];
    const by = await fetch('/api/status', { headers: { 'X-DN-Token': window.DN_TOKEN } }).then(r => r.json()).then(s => s.user || '').catch(() => '');
    // Pictures are drawn once per resolution; PowerPoint and PDF use the default (dashboard) size.
    const DW = COLS * CELL, DH = ROWS * CELL, pics = new Map();
    const raster = async (w = DW, h = DH) => { const k = `${w}x${h}`; if (!pics.has(k)) pics.set(k, await rasterize(css, cards.join('\n'), w, h)); return pics.get(k); };
    const out = async (path, data, label) => {
      await DNFS.write(path, data);
      man[path.split('/').pop()] = { by, at }; files.push(path);
      log(`Published ${label} → ${path} (${UI.bytes(data.size ?? data.length)})`, 'ok');
    };
    const img = imgSettings(cfg);
    for (const t of TARGETS.filter(t => want.has(t.id))) {
      if (t.id === 'web') await out(`${base}.html`, html, t.label);
      else if (t.id === 'pptx') await out(`${base}.pptx`, Pptx.imageSlide(new Uint8Array(await (await raster()).png.arrayBuffer())), t.label);
      else if (t.id === 'pdf') { const r = await raster(); await out(`${base}.pdf`, Pdf.imagePage(new Uint8Array(await (await r.as('jpg', 0.95)).arrayBuffer()), DW, DH), t.label); }
      else if (t.id === 'image') {
        // One picture per chart (the chart alone, at its dashboard size; other resolutions scale it by width).
        const ibase = `${ctx.dir}/publish/${nameStamp() + (img.name || name.replace(STAMP, ''))}`, used = new Set();
        for (const c of charts) {
          let cn = fixName(c.title).replace(/_+$/, '') || 'Chart', k = 2;
          while (used.has(cn)) cn = `${cn.replace(/_\d+$/, '')}_${k++}`;
          used.add(cn);
          for (const res of img.res) {
            const s = res === 'default' ? 1 : Number(res.split('x')[0]) / DW, r = await rasterize(css, { chart: c.body }, c.w, c.h, s);
            const w = Math.round(c.w * s), h = Math.round(c.h * s), sfx = res === 'default' ? '' : `_${res}`;
            for (const f of img.formats) await out(`${ibase}_${cn}${sfx}.${f}`, await r.as(f), `Image (.${f}) ${c.title} ${w} × ${h}`);
          }
        }
      }
    }
    await DNFS.writeJSON(MANIFEST(ctx), man);
    await Projects.touchModule(ctx.folder, 'publish', published(files));
    return files;
  }

  // What a publish run wrote (Project Manager step details): file count and folders.
  const published = files => ({ files: files.length, dirs: [...new Set(files.map(f => f.slice(0, f.lastIndexOf('/'))))] });

  // Datasets as CSV / Parquet / SQLite files (one per dataset; the engine streams them). Remembered as cfg.publish.data.
  async function data(ctx, { names, fmt }) {
    const log = ctx.log || (() => {}), dir = `${ctx.dir}/publish/data-${fileStamp()}`, files = [];
    for (const n of names) {
      const d = (ctx.cfg.datasets || []).find(x => x.name === n);
      if (!d) throw new Error(`Dataset ${n} not found.`);
      const r = await Engine.exportTo({ sql: `SELECT * FROM ${Engine.dataset(d)}`, to: `${dir}/${n}.${fmt}`, format: fmt, table: n });
      log(`Exported ${n} as ${fmt.toUpperCase()}: ${UI.num(r.rows)} rows, ${UI.bytes(r.bytes)}`, 'ok'); files.push(`${dir}/${n}.${fmt}`);
    }
    await Projects.touchModule(ctx.folder, 'publish', published(files));
    return files;
  }
  return { TARGETS, IMG_FMTS, imgSettings, nameStamp, STAMP, fixName, MANIFEST, loadRenderers, rasterize, dashboard, data };
})();
