// Project CRUD on top of DNFS. Global: Projects.
// Workspaces hold projects: workspace/<ws>/ (a workspace.json: UUID, name, folder) and workspace/workspaces.json maps them
// all. A project is a folder workspace/<ws>/<project>/ with the standard layout and a project-config.json (id = its UUID,
// workspaceId = its workspace's UUID). A project's "folder" id is "<ws>/<project>" (paths: workspace/<folder>/...).
//   await Projects.workspaces()                 [{ id, name, folder, created }] A to Z
//   await Projects.createWorkspace(name)        workspace (folder: the name in lower case, spaces -> dashes)
//   await Projects.list(wsFolder?)              [config...] (one workspace, or all)
//   await Projects.create({ name, owner, ..., workspace }) config (folder made from the name, in that workspace)
//   await Projects.update(folder, patch)        config
//   await Projects.rename(folder, newName)      config (folder renamed too, same workspace)
//   await Projects.trash(folder)                moves it to workspace/.trash/
const Projects = (() => {
  const ROOT = 'workspace';
  const WS_MAP = `${ROOT}/workspaces.json`;
  const RESERVED = ['projects', 'dashboard-studio', 'sample-data'];   // folders in workspace/ that are not workspaces
  const LAYOUT = ['data/raw', 'data/clean', 'data/imported', 'data/cache', 'transform', 'dashboard', 'publish', 'archives', 'logs'];
  const MODULES = ['import', 'pipeline', 'dashboard', 'publish', 'update', 'archives'];
  // Option lists: [stored value, label]. The value is also the badge class.
  const PHASE = [['not-started', 'Not Started'], ['planning', 'Planning'], ['development', 'Development'], ['testing', 'Testing'], ['production', 'Production']];
  const STATUS = [0, 25, 50, 75, 100].map(n => [n, n + '%']); // percent complete
  // Stored keys ('unclassified', 'unnpi', 'cui') are kept as-is for compatibility with saved projects, the migration below
  // and the badge CSS classes. Only the labels are shown in the UI (Public / Internal / Restricted); never display the keys.
  const CLASSIFICATION = [['unclassified', 'Public'], ['unnpi', 'Internal'], ['cui', 'Restricted']];
  const label = (list, v) => (list.find(([k]) => String(k) === String(v)) || [, v ?? ''])[1];
  // Older configs: status was a word (active/complete/planning...), classification public/internal/confidential/restricted.
  // Legacy classification -> stored key. Only an explicit 'public' becomes Public. 'confidential'/'restricted' become
  // Restricted. 'internal', and anything unknown or missing, becomes Internal: never widen a project to Public by guessing,
  // and use Restricted only where the legacy value says so (Internal is the most restrictive choice that doesn't invent a
  // marking). The original value is kept in legacyClassification so a later save doesn't lose it.
  const LEGACY_CLASSIFICATION = { public: 'unclassified', internal: 'unnpi', confidential: 'cui', restricted: 'cui',
    unclassified: 'unclassified', unnpi: 'unnpi', cui: 'cui' };   // stored keys in another case (e.g. 'CUI') keep their meaning
  const migrateClassification = c => {
    const v = c.classification;
    if (CLASSIFICATION.some(([k]) => k === v)) return v;
    const key = LEGACY_CLASSIFICATION[String(v ?? '').trim().toLowerCase()] || 'unnpi';
    if (v != null && v !== '' && c.legacyClassification == null) c.legacyClassification = String(v);
    return key;
  };
  const migrate = c => {
    if (typeof c.status !== 'number') {
      const old = String(c.status ?? '');
      if (!c.phase || !PHASE.some(([k]) => k === c.phase)) c.phase = PHASE.some(([k]) => k === old) ? old : old === 'complete' ? 'production' : 'not-started';
      c.status = Number.isFinite(+old) && old !== '' ? +old : old === 'complete' || old === 'production' ? 100 : 0;
    }
    if (c.handling === 'unnpi' && c.classification !== 'cui') c.classification = 'unnpi'; // handling was folded into classification
    delete c.handling;
    c.classification = migrateClassification(c);
    return c;
  };
  const cfgPath = folder => `${ROOT}/${folder}/project-config.json`;

  // "Sales Q3 2026!" -> "sales-q3-2026"
  const slug = name => name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  const validName = name => {
    if (!name || !name.trim()) return 'A name is required.';
    if (!slug(name)) return 'The name needs at least one letter or digit.';
    return '';
  };
  const id = () => crypto.randomUUID();
  const isUuid = v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));

  // ---- workspaces ----
  async function workspaces() {
    const m = await DNFS.readJSONOr(WS_MAP, { workspaces: [] }).catch(() => ({ workspaces: [] }));
    return (m.workspaces || []).slice().sort((a, b) => a.name.localeCompare(b.name));
  }
  async function createWorkspace(name) {
    name = String(name || '').trim();
    const folder = slug(name);
    if (!folder) throw new Error('The name needs at least one letter or digit.');
    if (RESERVED.includes(folder) || await DNFS.exists(`${ROOT}/${folder}`)) throw new Error(`A folder "${folder}" already exists in workspace/.`);
    const all = await workspaces();
    if (all.some(w => w.name.toLowerCase() === name.toLowerCase())) throw new Error(`A workspace named "${name}" already exists.`);
    const ws = { schemaVersion: 1, id: id(), name, folder, created: new Date().toISOString() };
    await DNFS.mkdir(`${ROOT}/${folder}`);
    await DNFS.writeJSON(`${ROOT}/${folder}/workspace.json`, ws);
    await DNFS.writeJSON(WS_MAP, { schemaVersion: 1, workspaces: [...all, ws] });
    return ws;
  }
  // Delete a workspace (not SMPG, the built-in one): the server moves it, projects and all, to workspace/.trash and
  // drops it from workspaces.json; the Trash dialog restores it.
  const BUILTIN_WS = 'smpg';
  async function deleteWorkspace(folder) {
    if (folder === BUILTIN_WS) throw new Error('SMPG is built in and cannot be deleted.');
    const r = await fetch(`/api/workspace/trash?folder=${encodeURIComponent(folder)}`, { method: 'POST', headers: { 'X-DN-Token': window.DN_TOKEN } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) throw new Error(j.error || `Delete failed (${r.status})`);
    return j;
  }
  const wsOf = folder => String(folder).split('/')[0];

  // Every project of one workspace (wsFolder) or of all of them. A project missing its UUID / workspace UUID / folder id
  // (made before workspaces) gets them here, once.
  async function list(wsFolder) {
    const out = [];
    for (const ws of (await workspaces()).filter(w => !wsFolder || w.folder === wsFolder)) {
      const dirs = (await DNFS.list(`${ROOT}/${ws.folder}`).catch(() => [])).filter(e => e.dir);
      for (const d of dirs) {
        const folder = `${ws.folder}/${d.name}`;
        if (!await DNFS.exists(cfgPath(folder))) continue;
        try {
          const c = migrate(await DNFS.readJSON(cfgPath(folder)));
          if (!isUuid(c.id) || c.workspaceId !== ws.id || c.folder !== folder) {
            if (!isUuid(c.id)) { if (c.id) c.legacyId = c.id; c.id = id(); }
            c.workspaceId = ws.id; c.folder = folder;
            await DNFS.writeJSON(cfgPath(folder), c);
          }
          out.push(c);
        } catch { out.push({ folder, name: d.name, workspaceId: ws.id, broken: true, status: 'archived', modified: d.modified }); }
      }
    }
    return out;
  }
  // Stored paths name the project folder ("workspace/projects/<folder>/data/..."). After a rename every JSON file in the
  // project (config, pipeline, dashboard, dataset manifests, publish records ...) is re-pointed from the old folder to the
  // new one, so Import, Transform, Dashboard Studio and Publish keep finding their files. Data parts are never touched.
  async function repath(folder, from) {
    const a = `${ROOT}/${from}/`, b = `${ROOT}/${folder}/`, esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[^A-Za-z0-9_.-])${esc(a)}`, 'g');
    const walk = async dir => {
      for (const e of await DNFS.list(dir).catch(() => [])) {
        const p = `${dir}/${e.name}`;
        if (e.dir) { if (!/^(raw|archives|\.)/.test(e.name)) await walk(p); continue; }
        if (!/\.json$/i.test(e.name)) continue;
        const t = await DNFS.readText(p).catch(() => null);
        if (t == null || !t.includes(a)) continue;
        await DNFS.writeText(p, t.replace(re, `$1${b}`));
      }
    };
    await walk(`${ROOT}/${folder}`);
  }
  // A project renamed before paths were re-pointed: its datasets still name a folder that no longer exists. Fixed on load.
  // Older projects kept the clean (Transform output) datasets in data/source: moved to data/clean once, and every path to
  // them in the project's .json files (project-config.json, dataset.json, dashboard.json, ...) rewritten.
  async function sourceToClean(folder) {
    const src = `${ROOT}/${folder}/data/source`, dst = `${ROOT}/${folder}/data/clean`;
    if (!await DNFS.exists(src)) return false;
    if (!await DNFS.exists(dst)) await DNFS.move(src, dst);
    else {   // both exist: move what is not in data/clean yet; data/source is removed only once it is empty (nothing is ever lost)
      for (const e of await DNFS.list(src)) if (!await DNFS.exists(`${dst}/${e.name}`)) await DNFS.move(`${src}/${e.name}`, `${dst}/${e.name}`);
      if (!(await DNFS.list(src)).length) await DNFS.remove(src, { recursive: true });
    }
    const a = `${src}/`, b = `${dst}/`;
    const walk = async dir => {
      for (const e of await DNFS.list(dir).catch(() => [])) {
        const p = `${dir}/${e.name}`;
        if (e.dir) { if (!/^(raw|archives|\.)/.test(e.name)) await walk(p); continue; }
        if (!/\.json$/i.test(e.name)) continue;
        const t = await DNFS.readText(p).catch(() => null);
        if (t != null && t.includes(a)) await DNFS.writeText(p, t.split(a).join(b));
      }
    };
    await walk(`${ROOT}/${folder}`);
    return true;
  }
  // Older projects kept Transform's files in pipeline/ (pipeline.json): moved once to transform/ (transform.json).
  async function pipelineToTransform(folder) {
    const src = `${ROOT}/${folder}/pipeline`, dst = `${ROOT}/${folder}/transform`;
    if (!await DNFS.exists(src)) return;
    if (!await DNFS.exists(dst)) await DNFS.move(src, dst);
    else {
      for (const e of await DNFS.list(src)) if (!await DNFS.exists(`${dst}/${e.name}`)) await DNFS.move(`${src}/${e.name}`, `${dst}/${e.name}`);
      if (!(await DNFS.list(src)).length) await DNFS.remove(src, { recursive: true });
    }
    if (await DNFS.exists(`${dst}/pipeline.json`) && !await DNFS.exists(`${dst}/transform.json`)) await DNFS.move(`${dst}/pipeline.json`, `${dst}/transform.json`);
  }
  async function get(folder) {
    await pipelineToTransform(folder).catch(e => console.warn('pipeline -> transform:', e.message));
    if (await sourceToClean(folder).catch(() => false)) { /* paths rewritten: read the config below */ }
    let cfg = migrate(await DNFS.readJSON(cfgPath(folder)));
    // Paths that name another folder (a rename, or "workspace/projects/<p>/" from before workspaces): re-pointed here.
    const stale = [...new Set((cfg.datasets || []).map(d => String(d.path || '').match(/^workspace\/([^/]+\/[^/]+)\//)?.[1]).filter(f => f && f !== folder))];
    let fixed = false;
    for (const old of stale) if (!await DNFS.exists(`${ROOT}/${old}`)) { await repath(folder, old); fixed = true; }
    if (fixed) cfg = migrate(await DNFS.readJSON(cfgPath(folder)));
    return cfg;
  }
  // Polling (Project Manager change monitor): the config as saved, no one-time fixes, not written to the server log.
  const peek = async folder => migrate(await DNFS.readJSON(cfgPath(folder), { quiet: true }));
  async function save(cfg) { cfg.modified = new Date().toISOString(); await DNFS.writeJSON(cfgPath(cfg.folder), cfg); return cfg; }

  async function create({ name, owner = '', developers = [], updaters = [], description = '', phase = 'not-started', status = 0, classification = 'unnpi' /* stored key, shown as 'Internal': new projects default to Internal, not Public */, tags = [], workspace }) {
    const err = validName(name); if (err) throw new Error(err);
    const all = await workspaces(), ws = all.find(w => w.folder === workspace || w.id === workspace) || all[0];
    if (!ws) throw new Error('Create a workspace first.');
    const folder = `${ws.folder}/${slug(name)}`;
    if (await DNFS.exists(`${ROOT}/${folder}`)) throw new Error(`A project folder "${folder}" already exists.`);
    for (const d of LAYOUT) await DNFS.mkdir(`${ROOT}/${folder}/${d}`);
    const now = new Date().toISOString();
    const cfg = {
      schemaVersion: 1, id: id(), workspaceId: ws.id, name: name.trim(), folder, description, owner, developers, updaters, phase, status: +status || 0, classification, tags,
      created: now, modified: now,
      modules: Object.fromEntries(MODULES.map(m => [m, { lastRun: null }])),
      datasets: [], settings: {},
    };
    await DNFS.writeJSON(cfgPath(folder), cfg);
    await ProjectLog.write(folder, 'project', `Project created: ${cfg.name}`);
    return cfg;
  }

  async function update(folder, patch) {
    const cfg = await get(folder);
    for (const k of ['name', 'owner', 'developers', 'updaters', 'description', 'phase', 'status', 'classification', 'tags', 'settings', 'datasets', 'modules']) if (k in patch) cfg[k] = patch[k];
    return save(cfg);
  }

  // Rename: new display name, and the folder follows the new name.
  async function rename(folder, name) {
    const err = validName(name); if (err) throw new Error(err);
    const to = `${wsOf(folder)}/${slug(name)}`;
    if (to !== folder) {
      if (await DNFS.exists(`${ROOT}/${to}`)) throw new Error(`A project folder "${to}" already exists.`);
      await DNFS.move(`${ROOT}/${folder}`, `${ROOT}/${to}`);
      await repath(to, folder);
    }
    const cfg = await get(to);
    cfg.name = name.trim(); cfg.folder = to;
    await save(cfg);
    await ProjectLog.write(to, 'project', `Renamed to ${cfg.name}${to !== folder ? ` (folder ${folder} -> ${to})` : ''}`);
    return cfg;
  }

  // Moves the project to workspace/.trash/<ws>~<project>-<timestamp> (server call: dot-folders are off-limits to DNFS).
  async function trash(folder) {
    const r = await fetch(`/api/project/trash?folder=${encodeURIComponent(folder)}`, { method: 'POST', headers: { 'X-DN-Token': window.DN_TOKEN } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) throw new Error(j.error || `Delete failed (${r.status})`);
    return j;
  }

  // Trash (workspace/.trash, closed to the file API): list, restore one, empty all.
  async function trashApi(op, q = '') {
    const r = await fetch(`/api/project/trash/${op}${q}`, { method: op === 'list' ? 'GET' : 'POST', headers: { 'X-DN-Token': window.DN_TOKEN } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) throw new Error(j.error || `Trash ${op} failed (${r.status})`);
    return j;
  }
  const trashList = async () => (await trashApi('list')).items || [];
  const restore = id => trashApi('restore', `?id=${encodeURIComponent(id)}`);
  const emptyTrash = () => trashApi('empty');

  // Archives: zipped snapshots in <project>/archives (server: zip / unzip runs as a job; progress(phase, done, total)).
  async function archApi(op, folder, body) {
    const r = await fetch(`/api/project/archive/${op}?folder=${encodeURIComponent(folder || '')}${op === 'job' ? `&id=${body}` : ''}`,
      body && op !== 'job' ? { method: 'POST', headers: { 'X-DN-Token': window.DN_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { headers: { 'X-DN-Token': window.DN_TOKEN } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) throw new Error(j.error || `Archive ${op} failed (${r.status})`);
    return j;
  }
  async function archJob(folder, op, body, progress = () => {}) {
    const { job } = await archApi(op, folder, body);
    for (;;) {
      await new Promise(r => setTimeout(r, 400));
      const s = await archApi('job', '', job);
      progress(s.phase, s.done, s.total);
      if (s.state === 'failed') throw new Error(s.error || 'Snapshot job failed');
      if (s.state === 'done') return s.result || {};
    }
  }
  const archives = folder => archApi('list', folder);   // { folder, items: [{ id, zip, at, note, bytes, size, datasets }] }
  async function snapshot(folder, note = '', progress) {
    const cfg = await get(folder);
    const r = await archJob(folder, 'create', { note, datasets: (cfg.datasets || []).map(d => ({ name: d.name, rows: d.rows, columns: (d.columns || []).length })) }, progress);
    await touchModule(folder, 'archives');
    return r;   // { id, bytes }
  }
  // Restore: the server snapshots the current state first (unless a snapshot already holds it), then puts the snapshot
  // back. Name, folder, id and created date stay as they are now.
  async function restoreSnapshot(folder, id, progress) {
    const cur = await get(folder);
    const r = await archJob(folder, 'restore', { id, datasets: (cur.datasets || []).map(d => ({ name: d.name, rows: d.rows, columns: (d.columns || []).length })) }, progress);
    return r;   // { saved: id of the "before restoring" snapshot, or null }
  }
  const deleteSnapshot = (folder, id) => archApi('delete', folder, { id });

  // The Windows user running the app (the server's /api/status), asked once per page.
  let userP;
  const user = () => userP ||= fetch('/api/status', { headers: { 'X-DN-Token': window.DN_TOKEN } }).then(r => r.json()).then(s => s.user || '').catch(() => '');
  // Record that a module ran (shown on the Project Manager page): when, and by whom.
  async function touchModule(folder, module, info = {}) {
    const by = await user();
    const cfg = await get(folder);
    cfg.modules ||= {};
    cfg.modules[module] = { ...cfg.modules[module], lastRun: new Date().toISOString(), by, ...info };
    return save(cfg);
  }

  // Datasets (Arrow IPC parts; older ones Parquet): { name, path, parts?, stage, direct?, rows, columns: [{ name, type }], source, imported }
  //   stage 'imported' = data/imported (Import > Import; input for Pipeline)
  //   stage 'source' = data/clean (Transform output, CLEAN_<name>; ready for Dashboard)
  //   path = dataset folder (part-NNNNNN.arrow + dataset.json, written by the engine); parts = its part files.
  //   version = dataset.json version (bumped on every rewrite). Older records may point at a single .parquet file.
  async function upsertDataset(folder, ds) {
    const cfg = await get(folder);
    cfg.datasets ||= [];
    const i = cfg.datasets.findIndex(d => d.name === ds.name);
    if (i >= 0) cfg.datasets[i] = { ...cfg.datasets[i], ...ds }; else cfg.datasets.push(ds);
    return save(cfg);
  }
  const dir = folder => `${ROOT}/${folder}`;
  // The cleaned datasets that really exist: every folder in <project>/data/clean with a dataset.json (read from disk, so a
  // dataset deleted or renamed outside the app is never offered). Columns / version / rows come from its dataset.json;
  // other fields from the project's record of it, if any. cfg = the project config (read when not given).
  async function sourceDatasets(folder, cfg) {
    cfg ||= await get(folder).catch(() => ({}));
    const root = `${ROOT}/${folder}/data/clean`, out = [];
    for (const e of (await DNFS.list(root).catch(() => [])).filter(e => e.dir)) {
      const path = `${root}/${e.name}`, man = await DNFS.readJSON(`${path}/dataset.json`).catch(() => null);
      if (!man) continue;
      const rec = (cfg.datasets || []).find(d => d.path === path) || {};
      out.push({ ...rec, name: rec.name || man.name || e.name, path, stage: 'source', columns: man.columns || rec.columns || [], version: man.version ?? rec.version, rowCount: man.rowCount ?? rec.rowCount });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
  // 'imported' | 'source' (older records have no stage: taken from the path; pipeline outputs are 'source').
  const stageOf = d => (d.stage === 'staged' ? 'imported' : d.stage) || (d.source?.kind !== 'pipeline' && d.path.includes('/data/imported/') ? 'imported' : 'source');

  return { ROOT, BUILTIN_WS, workspaces, createWorkspace, deleteWorkspace, wsOf, LAYOUT, MODULES, PHASE, STATUS, CLASSIFICATION, migrate, user, label, slug, validName, list, get, peek, save, create, update, rename, trash, trashList, restore, emptyTrash, archives, snapshot, restoreSnapshot, deleteSnapshot, touchModule, upsertDataset, dir, stageOf, sourceDatasets };
})();
