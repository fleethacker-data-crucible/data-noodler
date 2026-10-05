// Light / dark mode for every page. Global: Theme. Load in <head> (before the page paints).
//   Theme.apply('light')   sets the mode here (and in pages loaded in this window's frames)
// The mode is chosen in the server panel (Settings > Appearance) and saved in settings.json (default dark).
// The app shell picks it up from /api/status; localStorage only avoids a flash on load and syncs other
// windows of this site instantly (storage event).
const Theme = (() => {
  const KEY = 'dn-theme';
  const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  function apply(t) {
    t = t === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = t;
    try { if (localStorage.getItem(KEY) !== t) localStorage.setItem(KEY, t); } catch {}
    for (const f of document.querySelectorAll('iframe')) { try { f.contentDocument.documentElement.dataset.theme = t; } catch {} }
    return t;
  }
  apply(read() || 'dark');
  addEventListener('storage', e => { if (e.key === KEY && e.newValue) apply(e.newValue); });
  return { apply, get current() { return document.documentElement.dataset.theme || 'dark'; } };
})();
