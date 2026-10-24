// Module navigation. Global: Windows.
// Every module opens in its own window, 95% of the screen height at 16:10, centred (one window per module + project).
// initials = the global header logo for that module (ui/js/core/embed.js).
const Windows = (() => {
  const MODULES = [
    { id: 'import', label: 'Import', page: 'import.html', initials: 'IM', enabled: true },
    { id: 'pipeline', label: 'Transform', page: 'transform.html', initials: 'PL', enabled: true },
    { id: 'dashboard', label: 'Dashboard Studio', page: 'dashboard-studio.html', initials: 'DS', enabled: true },
    { id: 'publish', label: 'Publish', page: 'publish.html', initials: 'PU', enabled: true },
    { id: 'data_studio', label: 'Data Studio', page: 'data-studio.html', initials: 'DT', enabled: true },
    { id: 'new_app', label: 'New App', page: 'new_app.html', initials: 'NA', enabled: true, global: true },
    { id: 'benchmark', label: 'Benchmark', page: 'benchmark.html', initials: 'BM', enabled: true, global: true },
  ];
  // Window features: 95% of the available height, 16:10 width (capped to the screen), centred.
  function features() {
    const H = Math.round(screen.availHeight * 0.95), W = Math.min(Math.round(H * 1.6), screen.availWidth);
    const L = (screen.availLeft || 0) + Math.round((screen.availWidth - W) / 2), T = (screen.availTop || 0) + Math.round((screen.availHeight - H) / 2);
    return `popup=yes,width=${W},height=${H},left=${L},top=${T}`;
  }
  function open(moduleId, folder) {
    const m = MODULES.find(x => x.id === moduleId);
    if (!m?.enabled) return false;
    const url = m.global ? `/ui/html/${m.page}` : `/ui/html/${m.page}?${new URLSearchParams({ project: folder })}`;
    const w = window.open(url, m.global ? `dn-${moduleId}` : `dn-${moduleId}-${folder}`, features());
    w?.focus();
    return true;
  }
  return { MODULES, open };
})();
