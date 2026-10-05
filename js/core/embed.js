// Runs first (in <head>) on every page that lives inside the app shell (html/app.html).
// Opened on its own: reload inside the shell, so the global header is always there.
// Inside the shell: mark the page as embedded (its own logo/title header is hidden, theme.css) and,
// on modules, put the Back button at the left of the page's toolbar row: same place in every module.
(() => {
  const id = location.pathname.split('/').pop().replace(/\.html$/, '');
  // Opened on its own, or by mistake inside a frame that is not the shell: load the shell at the top.
  let shell = null; try { shell = window.parent !== window ? window.parent.Shell : null; } catch {}
  if (!shell) {
    const q = new URLSearchParams(location.search); q.set('m', id);
    window.top.location.replace(`/html/app.html?${q}`);
    return;
  }
  document.documentElement.classList.add('embedded');
  if (id === 'home') return;
  addEventListener('DOMContentLoaded', () => {
    const bar = document.querySelector('.topbar');
    if (!bar) return;
    const b = Object.assign(document.createElement('button'), { className: 'back', title: 'Back to Projects', innerHTML: '&larr; Back' });
    b.onclick = () => shell.go('home', new URLSearchParams(location.search).get('project'));
    bar.prepend(b);
  });
})();
