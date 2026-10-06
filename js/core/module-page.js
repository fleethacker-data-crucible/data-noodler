// Common start-up for module pages (import, pipeline, ...). Global: ModulePage.
//   const ctx = await ModulePage.init('import', 'Import Data')
//   ctx = { folder, cfg, dir, log(msg, level), reload() }
// Fills the page header (#title, #sub), reads ?project=<folder>, and writes to the project log.
// The global header (embed.js) shows the module title and project name.
const ModulePage = {
  async init(module, title) {
    const folder = UI.params().project;
    document.title = `${title} · Data Noodler`;
    const set = (id, t) => { const el = document.getElementById(id); if (el) el.textContent = t; };
    set('title', title);
    if (!folder) { set('sub', 'No project selected. Open this module from the home page.'); throw new Error('No project given (?project=<folder>).'); }
    let cfg;
    try { cfg = await Projects.get(folder); }
    catch { set('sub', `Project "${folder}" not found.`); throw new Error(`Project "${folder}" not found.`); }
    set('sub', `${cfg.name} · projects/${folder}`);
    window.GlobalHeader?.setInfo(title, cfg.name);
    const ctx = {
      folder, cfg, module, dir: Projects.dir(folder),
      // Log to the page (#log, if any) and to the project activity log.
      log(msg, level = 'info') {
        const el = document.getElementById('log');
        if (el) {
          const d = document.createElement('div');
          d.className = level === 'error' ? 'err' : level === 'ok' ? 'ok' : '';
          d.innerHTML = `<span class="t">${new Date().toLocaleTimeString()}</span>  ${UI.esc(msg)}`;
          el.prepend(d);
        }
        ProjectLog.write(folder, module, msg, level === 'ok' ? 'info' : level);
      },
      async reload() { ctx.cfg = await Projects.get(folder); return ctx.cfg; },
    };
    return ctx;
  },
};
