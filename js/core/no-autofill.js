// No browser text history: every text box (pages, popups, shadow roots, ones added later) gets autocomplete="off" etc.
// the moment it takes focus, so the browser never saves or suggests what was typed. Load on every page.
document.addEventListener('focusin', e => {
  const el = e.composedPath()[0];
  if (!el || !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable)) return;
  if (el.getAttribute('autocomplete') === 'off') return;
  el.setAttribute('autocomplete', 'off');
  el.setAttribute('autocorrect', 'off');
  el.setAttribute('autocapitalize', 'off');
  el.setAttribute('data-lpignore', 'true');
  if (el.form) el.form.setAttribute('autocomplete', 'off');
}, true);
