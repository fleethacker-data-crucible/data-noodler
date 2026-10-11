// Global header. Runs first (in <head>) on the Project Manager page and every module page; each opens in its own window.
// Adds a top bar on the Project Manager only (modules have none, for more room): logo with the module's initials, "Data Noodler", module · project,
// Server and Engine status, and a separator line. The page's own logo/title is hidden (theme.css html.embedded),
// so its own header row is left as the page toolbar. No Back buttons.
// Global: GlobalHeader.setInfo(title, project)   (ModulePage calls it once the project is loaded)
(() => {
  const id = location.pathname.split('/').pop().replace(/\.html$/, '');
  const MODS = { project_manager: ['Project Management Module', 'PR'], import: ['Import', 'IM'], pipeline: ['Transform', 'PL'], dashboard: ['Dashboard', 'DA'],
    publish: ['Publish', 'PU'], update: ['Update', 'UP'], 'd3-studio': ['D3 Studio', 'D3'], 'chart-builder': ['Chart Builder', 'CB'] };
  const [label, initials] = MODS[id] || [document.title || id, id.slice(0, 2).toUpperCase()];
  document.documentElement.classList.add('embedded');
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const G = window.GlobalHeader = {
    setInfo(title, project) {
      if (id === 'import') {
        const el = document.getElementById('gh-sub'); if (el) el.textContent = project ? `Import Module (${project})` : 'Import Module';
        document.title = 'Import'; return;
      }
      const el = document.getElementById('gh-sub'); if (el) el.textContent = project ? `${title} · ${project}` : title;
      if (id === 'd3-studio') { document.title = 'D3 Studio'; return; }
      if (id === 'chart-builder') { document.title = 'Chart Builder'; return; }
      document.title = project ? `${title} · ${project}` : id === 'project_manager' ? 'Project Manager' : `${title} · Data Noodler`;
    },
  };

  addEventListener('DOMContentLoaded', () => {
    const h = document.createElement('header');
    h.className = 'topbar gh';
    h.innerHTML = `<div class="brand"><span class="logo">${esc(initials)}</span><div><h1>Data Noodler</h1><div class="sub" id="gh-sub">${esc(label)}</div></div></div>
      <div class="spacer"></div>
      <div class="gh-status"><div class="stat"><label>Web Server (PowerShell)</label><b id="gh-srv" class="wait">CONNECTING</b></div>
      <div class="stat"><label>Data Engine (C#)</label><b id="gh-eng" class="wait" title="Click to re-run the test">TESTING</b></div></div>`;
    if (id === 'project_manager') document.body.prepend(h);   // the header is on the Project Manager only; modules use the full window
    G.setInfo(label, null);
    const hdr = () => ({ 'X-DN-Token': window.DN_TOKEN || '', 'Content-Type': 'application/json' });

    async function server() {
      const el = document.getElementById('gh-srv') || {};
      try {
        // 3 s timeout: a request to a stopped server can hang instead of failing.
        const r = await fetch('/api/status', { headers: hdr(), cache: 'no-store', signal: AbortSignal.timeout(3000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const s = await r.json();
        if (s.theme && window.Theme && s.theme !== Theme.current) Theme.apply(s.theme);   // changed from another window
        el.textContent = 'ONLINE'; el.className = 'on'; el.title = `Port ${s.port}, up ${s.uptime} s`;
        return s.engine !== false;   // false: the site answers but the engine is not ready
      } catch { el.textContent = 'OFFLINE'; el.className = 'off'; el.title = 'The server is not responding.'; return false; }
    }
    async function engine() {
      const el = document.getElementById('gh-eng') || {}; el.textContent = 'TESTING'; el.className = 'wait';
      const t0 = performance.now();
      try {
        const r = await (await fetch('/api/engine/query', { method: 'POST', headers: hdr(), body: JSON.stringify({ sql: 'SELECT sum(range) AS s FROM range(1000000)' }) })).json();
        if (!r.ok || r.rows[0][0] !== 499999500000) throw new Error(r.error || 'wrong answer');
        const s = await (await fetch('/api/engine/status', { headers: hdr(), cache: 'no-store' })).json();
        el.textContent = 'ONLINE'; el.className = 'on';
        el.title = `Native engine ${s.version}: ${s.workers} workers on ${s.cores} cores, memory budget ${(s.memory.budget / 1073741824).toFixed(1)} GB, test ${Math.round(performance.now() - t0)} ms. Click to re-test.`;
      } catch (e) { el.textContent = 'OFFLINE'; el.className = 'off'; el.title = e.message; }
    }
    if (document.getElementById('gh-eng')) document.getElementById('gh-eng').onclick = engine;
    // Status every 2 s; when the server comes back, the engine is re-tested too.
    let wasOff = false;
    // Server down = engine down (it runs in the server and stops with it); back up = re-test the engine.
    const poll = async () => {
      const off = !(await server());
      if (off && !wasOff) { const e = document.getElementById('gh-eng') || {}; e.textContent = 'OFFLINE'; e.className = 'off'; e.title = 'The server is stopped.'; }
      if (wasOff && !off) engine();
      wasOff = off;
    };
    poll(); setInterval(poll, 2000); if (id === 'project_manager') engine();   // modules: the poll only keeps the theme in step
  });

  // Every activity log (.log): 5 lines, with a Show More / Show Less link above it. Show More grows the log down to
  // 20px above the bottom of the window (at least 5 lines). window.LogMore(el) adds the link to a log created later.
  const fitLog = log => { log.style.height = log.classList.contains('more') ? Math.max(innerHeight - log.getBoundingClientRect().top - 20, 5 * 21) + 'px' : ''; };
  addEventListener('resize', () => document.querySelectorAll('.log.more').forEach(fitLog));
  const logMore = window.LogMore = log => {
    if (log.dataset.more) return; log.dataset.more = '1';
    const a = document.createElement('a'); a.href = '#'; a.className = 'log-more'; a.textContent = 'Show More';
    a.onclick = ev => { ev.preventDefault(); a.textContent = log.classList.toggle('more') ? 'Show Less' : 'Show More'; fitLog(log); };
    const wrap = document.createElement('div'); wrap.className = 'log-more-row'; log.before(wrap); wrap.append(a);
  };
  addEventListener('DOMContentLoaded', () => document.querySelectorAll('.log').forEach(logMore));

  // Mouse wheel, every page: Ctrl + wheel scrolls 4x faster vertically (instead of zooming);
  // Shift + wheel scrolls tables horizontally.
  const scroller = (el, axis) => {
    for (; el && el !== document.documentElement; el = el.parentElement) {
      const cs = getComputedStyle(el), ov = axis === 'y' ? cs.overflowY : cs.overflowX;
      const room = axis === 'y' ? el.scrollHeight > el.clientHeight : el.scrollWidth > el.clientWidth;
      if (room && /auto|scroll/.test(ov)) return el;
    }
    return axis === 'y' ? document.scrollingElement : null;
  };
  // Smooth wheel, every page: each notch glides to its target instead of jumping (Data Grids do the same themselves).
  // Selects, text areas and anything marked data-native-wheel keep the browser's own wheel.
  const EASE = 0.22, glides = new WeakMap();   // el -> { tx, ty, cx, cy, f }
  const glideTo = (el, dx, dy) => {
    let g = glides.get(el);
    if (!g || !g.f) { g = { tx: el.scrollLeft, ty: el.scrollTop, cx: el.scrollLeft, cy: el.scrollTop, f: 0 }; glides.set(el, g); }
    g.tx = Math.max(0, Math.min(el.scrollWidth - el.clientWidth, g.tx + dx));
    g.ty = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, g.ty + dy));
    const step = () => {
      g.cx += (g.tx - g.cx) * EASE; g.cy += (g.ty - g.cy) * EASE;
      if (Math.abs(g.tx - g.cx) < 0.5 && Math.abs(g.ty - g.cy) < 0.5) { g.cx = g.tx; g.cy = g.ty; g.f = 0; }
      el.scrollLeft = g.cx; el.scrollTop = g.cy;
      if (g.f) g.f = requestAnimationFrame(step);
    };
    if (!g.f) g.f = requestAnimationFrame(step);
  };
  addEventListener('wheel', e => {
    if (e.defaultPrevented || e.target.closest?.('select, textarea, [data-native-wheel]')) return;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1;
    let dx = e.deltaX * unit, dy = e.deltaY * unit;
    if (e.ctrlKey) dy *= 4;                                  // Ctrl: 4x faster vertically (instead of zooming)
    else if (e.shiftKey && !dx) { dx = dy; dy = 0; }         // Shift: sideways
    if (e.ctrlKey) e.preventDefault();
    const el = scroller(e.target, dx && !dy ? 'x' : 'y');
    if (!el) return;
    const g = glides.get(el), at = g?.f ? g : { tx: el.scrollLeft, ty: el.scrollTop };
    const room = (dy > 0 ? at.ty < el.scrollHeight - el.clientHeight : dy < 0 ? at.ty > 0 : false)
      || (dx > 0 ? at.tx < el.scrollWidth - el.clientWidth : dx < 0 ? at.tx > 0 : false);
    if (!room) return;
    e.preventDefault();
    glideTo(el === document.scrollingElement ? document.scrollingElement : el, dx, dy);
  }, { passive: false });

  // Tooltips, every page: title="..." shows a themed, rounded tooltip instead of the browser's square one.
  // While hovered the title moves to data-tip-title (so the native one stays hidden) and comes back on leave.
  let tipEl, tipFor, tipT;
  const tipHide = () => {
    clearTimeout(tipT); if (tipEl) tipEl.style.display = 'none';
    if (tipFor) { if (!tipFor.hasAttribute('title')) tipFor.setAttribute('title', tipFor.dataset.tipTitle); delete tipFor.dataset.tipTitle; tipFor = null; }
  };
  addEventListener('mouseover', e => {
    const el = e.target.closest?.('[title]:not(svg title)');
    if (!el || el === tipFor || !el.getAttribute('title')) return;
    tipHide(); tipFor = el; el.dataset.tipTitle = el.getAttribute('title'); el.removeAttribute('title');
    const x = e.clientX, y = e.clientY;
    tipT = setTimeout(() => {
      if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'gtip'; document.body.append(tipEl); }
      tipEl.textContent = el.dataset.tipTitle; tipEl.style.display = 'block';
      const r = tipEl.getBoundingClientRect();
      tipEl.style.left = Math.max(4, Math.min(x + 12, innerWidth - r.width - 4)) + 'px';
      tipEl.style.top = (y + 18 + r.height > innerHeight ? y - r.height - 8 : y + 18) + 'px';
    }, 500);
  });
  addEventListener('mouseout', e => { if (tipFor && !tipFor.contains(e.relatedTarget)) tipHide(); });
  addEventListener('mousedown', tipHide, true);
  addEventListener('scroll', tipHide, true);
})();
