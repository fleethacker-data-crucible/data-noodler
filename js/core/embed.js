// Global header. Runs first (in <head>) on the home page and every module page; each opens in its own window.
// Adds the same top bar everywhere: logo with the module's initials, "Data Noodler", module · project,
// Server and Engine status, and a separator line. The page's own logo/title is hidden (theme.css html.embedded),
// so its own header row is left as the page toolbar. No Back buttons.
// Global: GlobalHeader.setInfo(title, project)   (ModulePage calls it once the project is loaded)
(() => {
  const id = location.pathname.split('/').pop().replace(/\.html$/, '');
  const MODS = { home: ['Projects', 'PR'], import: ['Import Data', 'IM'], pipeline: ['Pipeline', 'PL'], dashboard: ['Dashboard', 'DA'],
    publish: ['Publish', 'PU'], update: ['Update', 'UP'], archives: ['Archives', 'AR'], 'widget-builder': ['Widget Builder', 'WB'] };
  const [label, initials] = MODS[id] || [document.title || id, id.slice(0, 2).toUpperCase()];
  document.documentElement.classList.add('embedded');
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const G = window.GlobalHeader = {
    setInfo(title, project) {
      const el = document.getElementById('gh-sub'); if (el) el.textContent = project ? `${title} · ${project}` : title;
      document.title = project ? `${title} · ${project}` : `${title} · Data Noodler`;
    },
  };

  addEventListener('DOMContentLoaded', () => {
    const h = document.createElement('header');
    h.className = 'topbar gh';
    h.innerHTML = `<div class="brand"><span class="logo">${esc(initials)}</span><div><h1>Data Noodler</h1><div class="sub" id="gh-sub">${esc(label)}</div></div></div>
      <div class="spacer"></div>
      <div class="gh-status"><div class="stat"><label>Server</label><b id="gh-srv" class="wait">CONNECTING</b></div>
      <div class="stat"><label>Engine</label><b id="gh-eng" class="wait" title="Click to re-run the test">TESTING</b></div></div>`;
    document.body.prepend(h);
    G.setInfo(label, null);
    const hdr = () => ({ 'X-DN-Token': window.DN_TOKEN || '', 'Content-Type': 'application/json' });

    async function server() {
      const el = document.getElementById('gh-srv');
      try {
        const s = await (await fetch('/api/status', { headers: hdr(), cache: 'no-store' })).json();
        if (s.theme && window.Theme && s.theme !== Theme.current) Theme.apply(s.theme);   // changed from another window
        el.textContent = `ONLINE v${s.ps}`; el.className = 'on'; el.title = `Port ${s.port}, up ${s.uptime} s`;
      } catch { el.textContent = 'OFFLINE'; el.className = 'off'; el.title = 'The server is not responding.'; }
    }
    async function engine() {
      const el = document.getElementById('gh-eng'); el.textContent = 'TESTING'; el.className = 'wait';
      const t0 = performance.now();
      try {
        const r = await (await fetch('/api/engine/query', { method: 'POST', headers: hdr(), body: JSON.stringify({ sql: 'SELECT sum(range) AS s FROM range(1000000)' }) })).json();
        if (!r.ok || r.rows[0][0] !== 499999500000) throw new Error(r.error || 'wrong answer');
        const s = await (await fetch('/api/engine/status', { headers: hdr(), cache: 'no-store' })).json();
        el.textContent = `READY ${s.workers} WORKERS`; el.className = 'on';
        el.title = `Native engine ${s.version}: ${s.workers} workers on ${s.cores} cores, memory budget ${(s.memory.budget / 1073741824).toFixed(1)} GB, test ${Math.round(performance.now() - t0)} ms. Click to re-test.`;
      } catch (e) { el.textContent = 'FAILED'; el.className = 'off'; el.title = e.message; }
    }
    document.getElementById('gh-eng').onclick = engine;
    server(); setInterval(server, 5000); engine();
  });
})();
