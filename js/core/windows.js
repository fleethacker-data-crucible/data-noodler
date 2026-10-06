// Module navigation. Global: Windows.
// Every module opens in its own window, 85% of the screen, centred (one window per module + project).
// initials = the global header logo for that module (js/core/embed.js).
const Windows = (() => {
  const MODULES = [
    { id: 'import', label: 'Import Data', page: 'import.html', initials: 'IM', enabled: true },
    { id: 'pipeline', label: 'Pipeline', page: 'pipeline.html', initials: 'PL', enabled: true },
    { id: 'dashboard', label: 'Dashboard', page: 'dashboard.html', initials: 'DA', enabled: true },
    { id: 'publish', label: 'Publish', page: 'publish.html', initials: 'PU', enabled: true },
    { id: 'update', label: 'Update', page: 'update.html', initials: 'UP', enabled: true },
    { id: 'archives', label: 'Archives', page: 'archives.html', initials: 'AR', enabled: true },
    { id: 'widget-builder', label: 'Widget Builder', page: 'widget-builder.html', initials: 'WB', enabled: true, global: true },   // developer tool, no project
  ];
  // Window features: 85% of the available screen, centred.
  function features() {
    const W = Math.round(screen.availWidth * 0.85), H = Math.round(screen.availHeight * 0.85);
    const L = (screen.availLeft || 0) + Math.round((screen.availWidth - W) / 2), T = (screen.availTop || 0) + Math.round((screen.availHeight - H) / 2);
    return `popup=yes,width=${W},height=${H},left=${L},top=${T}`;
  }
  function open(moduleId, folder) {
    const m = MODULES.find(x => x.id === moduleId);
    if (!m?.enabled) return false;
    const url = m.global ? `/html/${m.page}` : `/html/${m.page}?${new URLSearchParams({ project: folder })}`;
    const w = window.open(url, m.global ? `dn-${moduleId}` : `dn-${moduleId}-${folder}`, features());
    w?.focus();
    return true;
  }
  return { MODULES, open };
})();
