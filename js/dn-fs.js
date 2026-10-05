// Project file access through the Data Noodler server (.server/server.ps1).
// All paths are relative to the project root, e.g. 'test-data/sales_1k.csv'.
// Nothing outside the project root (or inside dot-folders) is reachable.
//
//   const csv = await DNFS.readText('test-data/sales_1k.csv');
//   await DNFS.writeText('output/summary.json', JSON.stringify(data));
//   await DNFS.upload(fileFromInput, 'test-data');
const DNFS = (() => {
  async function call(op, params = {}, init = {}) {
    if (!window.DN_TOKEN) throw new Error('DNFS: page was not served by the Data Noodler server.');
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined));
    const r = await fetch(`/api/fs/${op}?${qs}`, { ...init, headers: { 'X-DN-Token': window.DN_TOKEN, ...init.headers } });
    if (!r.ok) {
      let msg = r.statusText;
      try { msg = (await r.json()).error || msg; } catch {}
      const e = new Error(`DNFS ${op}: ${msg}`); e.status = r.status; throw e;
    }
    return r;
  }
  const json = async p => (await p).json();
  // Writes from one page go one at a time: the server handles writes one by one anyway, and many large
  // uploads at once can exhaust the page's memory.
  let writeQueue = Promise.resolve();
  const queued = fn => { const p = writeQueue.then(fn, fn); writeQueue = p.catch(() => {}); return p; };

  return {
    // [{ name, path, dir, size, modified }]
    list: async (path = '', { recursive = false } = {}) =>
      (await json(call('list', { path, recursive: recursive ? 1 : undefined }))).entries,
    stat: path => json(call('stat', { path })),
    exists: async path => (await json(call('stat', { path }))).exists,

    read: path => call('read', { path }),                          // raw Response (stream it for big files)
    readText: async path => (await call('read', { path })).text(),
    readJSON: async path => (await call('read', { path })).json(),
    readBuffer: async path => (await call('read', { path })).arrayBuffer(),
    // Optional file (may not exist yet, e.g. a new project): fallback instead of a 404 in the server log.
    readJSONOr: async (path, fallback) => (await DNFS.exists(path)) ? (await call('read', { path })).json() : fallback,

    // data: string, Blob/File, ArrayBuffer or typed array. Creates folders as needed.
    write: (path, data, { overwrite = true } = {}) =>
      queued(() => json(call('write', { path, overwrite: overwrite ? undefined : 0 }, { method: 'PUT', body: data }))),
    writeText: (path, text, opts) => DNFS.write(path, text, opts),
    writeJSON: (path, obj, opts) => DNFS.write(path, JSON.stringify(obj, null, 2), opts),

    // Copies a user-picked File (from <input type=file> or drag/drop) into a project folder.
    upload: (file, folder = '', opts) => DNFS.write(folder ? `${folder.replace(/\/+$/, '')}/${file.name}` : file.name, file, opts),

    mkdir: path => json(call('mkdir', { path }, { method: 'POST' })),
    remove: (path, { recursive = false } = {}) => json(call('delete', { path, recursive: recursive ? 1 : undefined }, { method: 'DELETE' })),
    move: (from, to, { overwrite = false } = {}) => json(call('move', { from, to, overwrite: overwrite ? 1 : undefined }, { method: 'POST' })),
    // Copies a file or a whole folder.
    copy: (from, to, { overwrite = false } = {}) => json(call('copy', { from, to, overwrite: overwrite ? 1 : undefined }, { method: 'POST' })),
  };
})();
