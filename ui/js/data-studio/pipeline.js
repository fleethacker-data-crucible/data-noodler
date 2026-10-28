// Data Studio pipelines: storage and runner. Global: DSPipeline. Needs dn-fs.js, engine-client.js, import/import-core.js,
// core/projects.js, ui.js (publish nodes also publish/publisher.js).
// A project's pipelines live in <project>/pipelines/:
//   <name>.pipeline                       { version, id, name, created, updated, view, nodes, links, order }: everything
//                                         Data Studio shows plus the run order (node ids, inputs first)
//   <name>/node_<uuid>/node.json          { id, type, title, settings, inputs: [ids], outputs: [ids], sql, preview, data }
//   <name>/node_<uuid>/node.sql           the SQL the node runs (its inputs are the views INPUT, INPUT1.., and their names)
//   <name>/node_<uuid>/preview/           its output on the first 1000 rows (Arrow parts), made as the pipeline is built
//   <name>/node_<uuid>/data/              its output on the full data (Execute, Run Update)
// Every node runs on the engine (in memory, spilling to disk past the budget) and writes its output as Arrow parts that
// the next node reads with all workers. Preview runs only the nodes whose SQL, settings or inputs changed (and what is
// downstream of them); Execute runs every node on the full data. Output nodes also save data/clean/CLEAN_<NAME>,
// Archive nodes take a project snapshot and Publish nodes publish (Execute only).
//   DSPipeline.list(ctx) -> [name]   load(ctx, name)   save(ctx, p)   remove(ctx, name)   blank(name)
//   DSPipeline.order(p) -> [node]    inputs(p, n) -> [node]   outDir(ctx, p, n, mode)   viewName(n)
//   await DSPipeline.run(ctx, p, { mode: 'preview' | 'data', only, onNode(n, state, info), onJob(job, n), log }) -> { ok, ran, error }
//   await DSPipeline.runAll(ctx, { log, onNode }) -> every pipeline of the project, A-Z, on the full data (Run Update)
const DSPipeline = (() => {
  const VERSION = 1, LIMIT = 1000;
  const ACTIONS = new Set(['archive', 'publish']);   // run on Execute only, give no data
  const SKIP = new Set(['chart']);                    // not part of a run (for now)
  const root = ctx => `${ctx.dir}/pipelines`;
  const safe = s => String(s || '').trim().replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ');
  const file = (ctx, name) => `${root(ctx)}/${safe(name)}.pipeline`;
  const nodeDir = (ctx, p, n) => `${root(ctx)}/${safe(p.name)}/node_${n.id}`;
  const outDir = (ctx, p, n, mode = 'preview') => `${nodeDir(ctx, p, n)}/${mode === 'data' ? 'data' : 'preview'}`;
  const uuid = () => crypto.randomUUID ? crypto.randomUUID() : 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  const blank = name => ({ version: VERSION, id: uuid(), name: safe(name), created: new Date().toISOString(), view: { zoom: 1, offX: 0, offY: 0 }, nodes: [], links: [], order: [] });
  // A node's name as a table in SQL: upper case, letters / digits / _.
  const viewName = n => String(n.title || n.type).toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'NODE';

  async function list(ctx) {
    try { return (await DNFS.list(root(ctx))).filter(f => !f.dir && /\.pipeline$/i.test(f.name)).map(f => f.name.replace(/\.pipeline$/i, '')).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })); }
    catch { return []; }
  }
  const load = async (ctx, name) => { const p = await DNFS.readJSONOr(file(ctx, name), null); if (p) { p.nodes ||= []; p.links ||= []; p.name = safe(name); } return p; };

  const inputs = (p, n) => p.links.filter(l => l.to === n.id).map(l => p.nodes.find(m => m.id === l.from)).filter(Boolean);
  const outputs = (p, n) => p.links.filter(l => l.from === n.id).map(l => p.nodes.find(m => m.id === l.to)).filter(Boolean);
  // Run order: every node after the nodes wired into it (left to right, top to bottom among equals); a loop is an error.
  function order(p) {
    const out = [], state = new Map();
    const sorted = p.nodes.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    const visit = (n, path) => {
      const s = state.get(n.id);
      if (s === 2) return;
      if (s === 1) throw new Error(`The wires make a loop: ${[...path, n].map(m => m.title).join(' > ')}.`);
      state.set(n.id, 1);
      inputs(p, n).sort((a, b) => a.x - b.x || a.y - b.y).forEach(m => visit(m, [...path, n]));
      state.set(n.id, 2); out.push(n);
    };
    sorted.forEach(n => visit(n, []));
    return out;
  }

  // ---- SQL per node. Inputs are views: INPUT (the first), INPUT1, INPUT2 ... and each input's own name. ----
  const Q = Engine.q, L = Engine.lit;
  async function columnsOf(view, views) { return (await Engine.describe(`SELECT * FROM ${Q(view)}`, views)).map(c => c.name); }
  async function sqlOf(ctx, p, n, views) {
    const ins = inputs(p, n), s = n.cfg || {};
    switch (n.type) {
      case 'import': {
        const src = n.src || {};
        const files = (src.files || []).map(f => f.copy || f.path).filter(Boolean);
        if (!files.length && (src.path || src.ext?.src)) files.push(src.ext?.src || src.path);   // older input nodes: one file
        if (!files.length) throw new Error(`${n.title}: attach a file in its Settings.`);
        const list = src.cols?.length ? ImportCore.selectList(src.cols) : '*';
        if (!list) throw new Error(`${n.title}: keep at least one field.`);
        return files.map(f => `SELECT ${list} FROM ${Engine.src(f, src.table || '')}`).join('\nUNION ALL\n');
      }
      case 'transform': case 'sql': {
        if (!ins.length) throw new Error(`${n.title}: wire a node into it.`);
        const sql = String(s.sql || '').trim().replace(/;\s*$/, '');
        return sql || 'SELECT * FROM INPUT';
      }
      case 'function': {
        if (!ins.length) throw new Error(`${n.title}: wire a node into it.`);
        const add = (s.cols || []).filter(c => c.name?.trim() && c.expr?.trim());
        return `SELECT t.*${add.map(c => `, ${c.expr} AS ${Q(c.name.trim().toUpperCase())}`).join('')}\nFROM INPUT t`;
      }
      case 'join': {
        if (ins.length < 2) throw new Error(`${n.title}: wire two nodes into it (the first is the left side).`);
        const keys = (s.keys || []).filter(k => k.l && k.r);
        if (!keys.length && s.type !== 'CROSS') throw new Error(`${n.title}: pick the fields to join on.`);
        const [a, b] = await Promise.all([columnsOf('INPUT1', views), columnsOf('INPUT2', views)]);
        const same = new Set(keys.filter(k => k.l === k.r).map(k => k.r)), have = new Set(a.map(c => c.toUpperCase()));
        // the right side's fields after the left's; a name already used gets the right input's name in front
        const right = b.filter(c => !same.has(c)).map(c => have.has(c.toUpperCase()) ? `b.${Q(c)} AS ${Q(`${viewName(ins[1])}_${c}`)}` : `b.${Q(c)}`);
        const type = ['INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS'].includes(s.type) ? s.type : 'INNER';
        const on = type === 'CROSS' ? '' : `\nON ${keys.map(k => `a.${Q(k.l)} = b.${Q(k.r)}`).join(' AND ')}`;
        return `SELECT a.*${right.map(c => `, ${c}`).join('')}\nFROM INPUT1 a\n${type === 'FULL' ? 'FULL OUTER' : type} JOIN INPUT2 b${on}`;
      }
      case 'append': {
        if (!ins.length) throw new Error(`${n.title}: wire nodes into it.`);
        // by field name: every field of every input, missing ones empty, in the order they first appear
        const cols = await Promise.all(ins.map((_, i) => columnsOf(`INPUT${i + 1}`, views)));
        const all = []; cols.flat().forEach(c => { if (!all.some(x => x.toUpperCase() === c.toUpperCase())) all.push(c); });
        return ins.map((_, i) => `SELECT ${all.map(c => cols[i].some(x => x.toUpperCase() === c.toUpperCase()) ? Q(c) : `NULL AS ${Q(c)}`).join(', ')} FROM INPUT${i + 1}`)
          .join(s.distinct ? '\nUNION\n' : '\nUNION ALL\n');
      }
      case 'output': {
        if (!ins.length) throw new Error(`${n.title}: wire a node into it.`);
        return 'SELECT * FROM INPUT';
      }
      default: return null;
    }
  }
  // Views for a node: its inputs' outputs (Arrow parts written by the run) under INPUT, INPUTn and their names.
  function viewsOf(ctx, p, n, mode) {
    const v = {};
    inputs(p, n).forEach((m, i) => {
      const sql = `SELECT * FROM read_dataset(${L(outDir(ctx, p, m, mode))})`;
      if (i === 0) v.INPUT = sql;
      v[`INPUT${i + 1}`] = sql;
      if (!v[viewName(m)]) v[viewName(m)] = sql;
    });
    return v;
  }

  // ---- save: the .pipeline file, then each node's folder (node.json + node.sql) ----
  async function save(ctx, p) {
    p.updated = new Date().toISOString(); p.version = VERSION;
    try { p.order = order(p).map(n => n.id); } catch { p.order = []; }
    await DNFS.writeJSON(file(ctx, p.name), p);
    await Promise.all(p.nodes.map(n => saveNode(ctx, p, n)));
  }
  async function saveNode(ctx, p, n, extra = {}) {
    const dir = nodeDir(ctx, p, n), old = await DNFS.readJSONOr(`${dir}/node.json`, {}).catch(() => ({}));
    const { x, y, w, h, ...rest } = n;
    const j = { ...old, id: n.id, type: n.type, title: n.title, settings: rest.cfg || rest.src || {}, inputs: inputs(p, n).map(m => m.id), outputs: outputs(p, n).map(m => m.id),
      sql: 'node.sql', ...extra };
    await DNFS.writeJSON(`${dir}/node.json`, j);
    return j;
  }
  async function remove(ctx, name) {
    await DNFS.remove(file(ctx, name)).catch(() => {});
    await DNFS.remove(`${root(ctx)}/${safe(name)}`, { recursive: true }).catch(() => {});
  }
  const hash = s => { let h = 0; for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };

  // ---- run ----
  async function run(ctx, p, { mode = 'preview', only = null, onNode = () => {}, onJob = () => {}, log = () => {} } = {}) {
    const full = mode === 'data', ran = [], sig = new Map();
    let seq;
    try { seq = order(p); } catch (e) { return { ok: false, ran, error: e.message }; }
    if (only) { const keep = new Set(only); seq = seq.filter(n => keep.has(n.id)); }
    for (const n of seq) {
      if (SKIP.has(n.type)) continue;
      const ins = inputs(p, n);
      try {
        if (ACTIONS.has(n.type)) {
          if (!full) { onNode(n, 'idle'); continue; }
          onNode(n, 'running'); await action(ctx, p, n, log); ran.push(n.id);
          await saveNode(ctx, p, n, { data: { at: new Date().toISOString() } }); onNode(n, 'done'); continue;
        }
        const views = viewsOf(ctx, p, n, mode), sql = await sqlOf(ctx, p, n, views);
        if (sql == null) continue;
        const h = hash(JSON.stringify([n.type, n.cfg || n.src || {}, sql, ins.map(m => sig.get(m.id) || '')]));
        sig.set(n.id, h);
        const dir = nodeDir(ctx, p, n), j = await DNFS.readJSONOr(`${dir}/node.json`, {}).catch(() => ({}));
        await DNFS.write(`${dir}/node.sql`, `-- ${n.title} (${n.type}, node ${n.id})\n-- Inputs: ${ins.map((m, i) => `INPUT${i + 1} = ${viewName(m)} (node ${m.id})`).join(', ') || 'none'}\n${sql};\n`);
        if (!full && j.preview?.hash === h) { onNode(n, 'done', j.preview, true); continue; }   // unchanged: its preview is current
        onNode(n, 'running'); log(`${n.title}: running${full ? '' : ' (first 1000 rows)'}…`);
        const body = full ? sql : `SELECT * FROM (\n${sql}\n) FETCH FIRST ${LIMIT} ROWS ONLY`;
        const w = await Engine.write({ sql: body, views, dest: outDir(ctx, p, n, mode), meta: { pipeline: p.name, node: n.id, mode } }, job => onJob(job, n));
        const info = { hash: h, rows: w.rowCount, columns: Engine.columnsOf(w), parts: (w.files || []).length, bytes: w.bytes, at: new Date().toISOString() };
        if (full && n.type === 'output') await saveDataset(ctx, p, n, sql, views, log, job => onJob(job, n));
        await saveNode(ctx, p, n, { [full ? 'data' : 'preview']: info });
        ran.push(n.id); onNode(n, 'done', info);
        log(`${n.title}: ${UI.num(w.rowCount)} rows, ${info.columns.length} fields`, 'ok');
      } catch (e) {
        onNode(n, 'failed', { error: e.message }); log(`${n.title} failed: ${e.message}`, 'error');
        return { ok: false, ran, error: `${n.title}: ${e.message}`, node: n.id };
      }
    }
    if (full) { p.lastRun = new Date().toISOString(); await DNFS.writeJSON(file(ctx, p.name), p).catch(() => {}); }
    return { ok: true, ran };
  }
  // Output node, full run: the dataset data/clean/CLEAN_<NAME> (as Transform saves its tables), recorded in the project.
  async function saveDataset(ctx, p, n, sql, views, log, onJob) {
    const base = String(n.cfg?.name || viewName(n)).toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^CLEAN_/, '');
    if (!/^[A-Z_][A-Z0-9_]*$/.test(base)) throw new Error('give the dataset a name (letters, digits and _).');
    const name = `CLEAN_${base}`;
    const w = await Engine.write({ sql, views, dest: `${ctx.dir}/data/clean/${name}`, meta: { lineage: { pipeline: p.name, pipelineNode: n.id } } }, onJob);
    await Projects.upsertDataset(ctx.folder, { name, path: w.path, parts: w.files, stage: 'source', rows: w.rowCount, bytes: w.bytes, columns: Engine.columnsOf(w),
      version: w.version, imported: new Date().toISOString(), source: { kind: 'pipeline', pipeline: p.name, node: n.id } });
    log(`${name}: ${UI.num(w.rowCount)} rows saved`, 'ok');
  }
  // Archive: a zipped project snapshot (as Archive / Update). Publish: the ticked dashboard formats and dataset exports (as Publish).
  async function action(ctx, p, n, log) {
    const s = n.cfg || {};
    if (n.type === 'archive') {
      const r = await Projects.snapshot(ctx.folder, s.note || `Pipeline ${p.name}`);
      log(`${n.title}: snapshot ${r.id} taken (${UI.bytes(r.bytes)})`, 'ok');
    } else if (n.type === 'publish') {
      if (typeof Publisher === 'undefined') throw new Error('publishing is not available on this page.');
      const cfg = { ...(ctx.cfg || await Projects.get(ctx.folder)), publish: { name: s.name || '', targets: s.targets || [], image: s.image || {} } };
      const pctx = { ...ctx, cfg, log };
      if (s.targets?.length) await Publisher.dashboard(pctx, {});
      if (s.data?.length) await Publisher.data({ ...pctx, cfg: await Projects.get(ctx.folder) }, { names: s.data, fmt: s.fmt || 'csv' });
      if (!s.targets?.length && !s.data?.length) log(`${n.title}: nothing ticked to publish`, 'warn');
    }
  }
  // Run Update: every pipeline of the project, A-Z, on the full data. Stops at the first failure.
  async function runAll(ctx, { log = () => {}, onNode = () => {} } = {}) {
    const names = await list(ctx), done = [];
    for (const name of names) {
      const p = await load(ctx, name); if (!p) continue;
      log(`Pipeline ${name}…`);
      const r = await run(ctx, p, { mode: 'data', log, onNode });
      if (!r.ok) return { ok: false, error: `Pipeline ${name}: ${r.error}`, done };
      done.push(name);
    }
    return { ok: true, done };
  }
  return { VERSION, LIMIT, list, load, save, saveNode, remove, blank, uuid, order, inputs, outputs, outDir, viewName, sqlOf, viewsOf, run, runAll, safe };
})();
