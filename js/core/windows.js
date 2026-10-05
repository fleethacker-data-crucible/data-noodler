// Module windows. Global: Windows.
// Each module opens as its own 1400x1000 window centered on the screen, with ?project=<folder>.
const Windows = (() => {
  const MODULES = [
    { id: 'import', label: 'Import Data', page: 'import.html', enabled: true },
    { id: 'pipeline', label: 'Pipeline', page: 'pipeline.html', enabled: true },
    { id: 'dashboard', label: 'Dashboard', page: 'dashboard.html', enabled: true },
    { id: 'publish', label: 'Publish', page: 'publish.html', enabled: true },
    { id: 'update', label: 'Update', page: 'update.html', enabled: true },
    { id: 'archives', label: 'Archives', page: 'archives.html', enabled: true },
  ];
  const W = 1400, H = 1000;
  function open(moduleId, folder) {
    const m = MODULES.find(x => x.id === moduleId);
    if (!m?.enabled) return null;
    const sw = screen.availWidth, sh = screen.availHeight;
    const left = Math.max(0, Math.round((screen.availLeft || 0) + (sw - W) / 2)), top = Math.max(0, Math.round((screen.availTop || 0) + (sh - H) / 2));
    const url = new URL(m.page, new URL('/html/', location.origin)); url.searchParams.set('project', folder);
    // One window per module+project: opening again focuses the existing one.
    const w = window.open(url.href, `dn-${moduleId}-${folder}`, `popup=yes,width=${Math.min(W, sw)},height=${Math.min(H, sh)},left=${left},top=${top}`);
    w?.focus();
    return w;
  }
  return { MODULES, open };
})();
