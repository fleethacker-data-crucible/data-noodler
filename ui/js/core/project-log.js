// Project activity log: <project>/logs/activity.log, capped at the newest MAX lines (older ones drop off). Global: ProjectLog.
//   await ProjectLog.write('sales-q3', 'import', 'Imported orders.csv: 1,000,000 rows')
//   await ProjectLog.read('sales-q3')   -> lines, newest first (at most MAX)
// Older versions wrote one file per month (activity-YYYY-MM.log); the first write merges those in and removes them.
const ProjectLog = (() => {
  const MAX = 1000;
  const dir = folder => `workspace/projects/${folder}/logs`;
  const file = folder => `${dir(folder)}/activity.log`;
  let queue = Promise.resolve(); // serialise appends from the same page

  const monthly = async folder => {
    try { return (await DNFS.list(dir(folder))).filter(f => /^activity-\d{4}-\d{2}\.log$/.test(f.name)).sort((a, b) => a.name.localeCompare(b.name)); }
    catch { return []; }
  };
  const lines = text => text.split('\n').filter(Boolean);

  function write(folder, module, msg, level = 'info') {
    const line = `${new Date().toISOString()}  ${level.toUpperCase().padEnd(5)} ${module.padEnd(9)} ${msg}`;
    queue = queue.then(async () => {
      const p = file(folder);
      let all = (await DNFS.exists(p)) ? lines(await DNFS.readText(p)) : [];   // new project: no file yet
      const old = await monthly(folder);
      if (old.length) {
        const prev = [];
        for (const f of old) prev.push(...lines(await DNFS.readText(f.path)));
        all = prev.concat(all);
      }
      all.push(line);
      await DNFS.writeText(p, all.slice(-MAX).join('\n') + '\n');
      for (const f of old) await DNFS.remove(f.path).catch(() => {});
    }).catch(e => console.warn('ProjectLog:', e.message));
    return queue;
  }
  async function read(folder) {
    const out = [];
    for (const f of await monthly(folder)) out.push(...lines(await DNFS.readText(f.path)));
    try { out.push(...lines(await DNFS.readText(file(folder)))); } catch {}
    return out.slice(-MAX).reverse();
  }
  return { write, read, MAX };
})();
