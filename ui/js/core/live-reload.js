// Live updates while developing: the page watches its own ui/ files (the page, its stylesheets and scripts) through the
// server (/api/dev/mtimes, every second) and redraws only what changed:
//   stylesheet           swapped in place
//   page / hot script    hot update: window.DNHot.dispose() (the module saves and stops), the page's [data-hot-root]
//                        element is replaced by the new page's, and the <script data-hot> scripts run again
//   anything else        (core scripts, a page without DNHot) the page reloads; window.DNBeforeReload() saves first
// Global: LiveReload. Load it last on a page: <script src="../js/core/live-reload.js"></script>
const LiveReload = (() => {
  const own = u => { try { const x = new URL(u, location.href); return x.origin === location.origin && x.pathname.startsWith('/ui/') ? x.pathname.slice(1) : null; } catch { return null; } };
  const page = own(location.href);
  const sheets = () => [...document.querySelectorAll('link[rel=stylesheet][href]')].map(l => ({ l, p: own(l.getAttribute('href')) })).filter(o => o.p);
  const scripts = () => [...document.querySelectorAll('script[src]')].map(s => own(s.getAttribute('src'))).filter(Boolean);
  let last = null, busy = false, api = true;
  // Change stamps: the server's /api/dev/mtimes (one request); a server without it: each file's own ETag / Last-Modified
  // (HEAD requests).
  async function stamps(paths) {
    if (api) {
      const r = await fetch(`/api/dev/mtimes?paths=${encodeURIComponent(paths.join(','))}`, { headers: { 'X-DN-Token': window.DN_TOKEN }, cache: 'no-store' });
      if (r.ok) return (await r.json()).mtimes || {};
      if (r.status !== 404) return null;
      api = false;
    }
    const out = {};
    await Promise.all(paths.map(async p => {
      const r = await fetch(`/${p}`, { method: 'HEAD', cache: 'no-store' }).catch(() => null);
      out[p] = r?.ok ? (r.headers.get('ETag') || r.headers.get('Last-Modified') || String(r.headers.get('Content-Length'))) : 0;
    }));
    return out;
  }
  const hotScripts = () => [...document.querySelectorAll('script[data-hot][src]')].map(el => ({ el, p: own(el.getAttribute('src')) })).filter(o => o.p);
  // Hot update: the module stops, its root element comes back fresh from the server's page, its scripts run again.
  async function hotUpdate() {
    await window.DNHot.dispose(); window.DNHot = null;
    const html = await (await fetch(location.href, { cache: 'no-store' })).text();
    const fresh = new DOMParser().parseFromString(html, 'text/html').querySelector('[data-hot-root]');
    if (fresh) document.querySelector('[data-hot-root]').replaceWith(document.importNode(fresh, true));
    for (const o of hotScripts()) {
      const n = document.createElement('script');
      for (const a of o.el.attributes) n.setAttribute(a.name, a.value);
      n.src = `/${o.p}?v=${Date.now()}`;
      o.el.replaceWith(n);
    }
  }
  async function tick() {
    if (busy || document.hidden) return;
    busy = true;
    try {
      const css = sheets(), paths = [...new Set([page, ...css.map(o => o.p), ...scripts()].filter(Boolean))];
      const now = await stamps(paths); if (!now) return;
      if (last) {
        const changed = paths.filter(p => last[p] !== undefined && now[p] !== last[p]);
        const hard = changed.filter(p => !p.endsWith('.css'));
        if (hard.length) {
          const hot = new Set([page, ...hotScripts().map(s => s.p)]);
          if (window.DNHot && document.querySelector('[data-hot-root]') && hard.every(p => hot.has(p))) { await hotUpdate(); last = now; return; }
          try { await window.DNBeforeReload?.(); } catch {}
          location.reload(); return;
        }
        for (const o of css) if (changed.includes(o.p)) {   // swap the stylesheet: the new one loads, then the old one goes
          const n = o.l.cloneNode(); n.href = `/${o.p}?v=${now[o.p]}`;
          n.onload = () => o.l.remove(); o.l.after(n);
        }
      }
      last = now;
    } catch {} finally { busy = false; }
  }
  setInterval(tick, 1000); tick();
  return { tick };
})();
