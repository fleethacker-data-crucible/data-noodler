// Module navigation. Global: Windows.
// Modules load inside the app shell (html/app.html) under its global header, in the same window.
// initials = the header logo while that module is shown.
const Windows = (() => {
  const MODULES = [
    { id: 'import', label: 'Import Data', page: 'import.html', initials: 'IM', enabled: true },
    { id: 'pipeline', label: 'Pipeline', page: 'pipeline.html', initials: 'PL', enabled: true },
    { id: 'dashboard', label: 'Dashboard', page: 'dashboard.html', initials: 'DA', enabled: true },
    { id: 'publish', label: 'Publish', page: 'publish.html', initials: 'PU', enabled: true },
    { id: 'update', label: 'Update', page: 'update.html', initials: 'UP', enabled: true },
    { id: 'archives', label: 'Archives', page: 'archives.html', initials: 'AR', enabled: true },
  ];
  function open(moduleId, folder) {
    const m = MODULES.find(x => x.id === moduleId);
    if (!m?.enabled) return false;
    const shell = window.parent !== window && window.parent.Shell;
    if (shell) shell.go(moduleId, folder);
    else location.href = `/html/app.html?${new URLSearchParams({ m: moduleId, project: folder })}`;
    return true;
  }
  return { MODULES, open };
})();
