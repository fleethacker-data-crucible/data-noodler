// Project activity log: one text file per month in <project>/logs/. Global: ProjectLog.
//   await ProjectLog.write('sales-q3', 'import', 'Imported orders.csv: 1,000,000 rows')
//   await ProjectLog.read('sales-q3')   -> lines, newest month first
const ProjectLog = (() => {
  const file = (folder, d = new Date()) => `projects/${folder}/logs/activity-${d.toISOString().slice(0, 7)}.log`;
  let queue = Promise.resolve(); // serialise appends from the same page

  function write(folder, module, msg, level = 'info') {
    const line = `${new Date().toISOString()}  ${level.toUpperCase().padEnd(5)} ${module.padEnd(9)} ${msg}\n`;
    queue = queue.then(async () => {
      const p = file(folder);
      let text = '';
      if (await DNFS.exists(p)) text = await DNFS.readText(p);   // new month/project: no file yet
      await DNFS.writeText(p, text + line);
    }).catch(e => console.warn('ProjectLog:', e.message));
    return queue;
  }
  async function read(folder) {
    let files = [];
    try { files = (await DNFS.list(`projects/${folder}/logs`)).filter(f => f.name.endsWith('.log')).sort((a, b) => b.name.localeCompare(a.name)); } catch {}
    const out = [];
    for (const f of files) out.push(...(await DNFS.readText(f.path)).trim().split('\n').reverse());
    return out.filter(Boolean);
  }
  return { write, read };
})();
