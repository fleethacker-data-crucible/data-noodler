// New App (ui/html/new_app.html) Projects view: the project list (one category, "Projects" with a +) and, on a click,
// the project in a pane that slides in from the right. Repurposed from the Project Manager (ui/html/project_manager.html):
// the same details, Update workflow, cards, Edit / Archives / Delete and activity log, laid out as a task-style pane.
// Needs: dn-fs, ui, user-picker, project-log, projects, windows, engine-client, external-source, steps, runner, publisher,
// project-update. Global: ProjectsView.init(listEl, paneEl), ProjectsView.setWorkspace(folder | null) (null = all workspaces).
// New projects go into the selected workspace (with all shown, the New project form asks which one).
const ProjectsView = (() => {
  const { $, esc } = UI, P = Projects;
  let projects = [], open = null, listEl, paneEl, ws = null, wsList = [];
  const updated = p => p.modules?.update?.lastRun || '';
  const badge = (list, v) => v === '' || v == null ? '-' : `<span class="badge ${esc(v)}">${esc(P.label(list, v))}</span>`;
  // "Doe, Jane Q. CIV" -> "Doe Q."; a Windows login ("jane_doe") -> "Doe Q.".
  const shortName = n => { const [last, rest = ''] = String(n).split(','); const f = rest.trim()[0]; return f ? `${last.trim()} ${f.toUpperCase()}.` : last.trim(); };
  const shortUser = u => { u = String(u || ''); if (u.includes(',')) return shortName(u); const w = u.split(/[._\s-]+/).filter(Boolean); return w.length > 1 ? `${w[w.length - 1][0].toUpperCase()}${w[w.length - 1].slice(1)} ${w[0][0].toUpperCase()}.` : u; };
  const lastUpdated = p => { const u = p.modules?.update; return u?.lastRun ? `${UI.date(u.lastRun)}${u.by ? ` by ${esc(shortUser(u.by))}` : ''}` : '-'; };
  const shortNames = l => (l || []).map(n => esc(shortName(n))).join('; ') || '-';
  const IC = {
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>', team: '<circle cx="8" cy="9" r="3"/><circle cx="16" cy="9" r="3"/><path d="M2 20c.6-3 3-5 6-5s5.4 2 6 5M14 15c3 0 5.4 2 6 5"/>',
    flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>', pct: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1"/>', cal: '<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
    db: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/>', note: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>',
    flow: '<circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/><path d="M7 12h3M14 12h3"/>', plus: '<path d="M12 5v14M5 12h14"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>', folder: '<path d="M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>',
  };
  const pctCls = v => `p${Math.min(100, Math.round((+v || 0) / 25) * 25)}`;   // colour band of a status (every 5%)
  const STATUS5 = Array.from({ length: 21 }, (_, i) => [i * 5, `${i * 5}%`]);
  const svg = k => `<svg class="pico" viewBox="0 0 24 24">${IC[k]}</svg>`;

  // ---- the list: one category, Projects (+ = New project); newest change first ----
  const load = UI.guard(async () => {
    wsList = await P.workspaces();
    projects = (await P.list(ws || undefined)).sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
    if (open && !projects.some(p => p.folder === open)) { open = null; paneEl.classList.remove('open'); }
    renderList(); if (open) renderPane();
  });
  const wsName = folder => wsList.find(w => w.folder === folder)?.name || folder;
  function renderList() {
    listEl.innerHTML = '<div class="pl-bar"><button data-act="new">New Project</button><button class="ghost" data-act="trash">Trash</button></div>'
      + (projects.length ? '<div class="pl-cols"><span>Project Name</span><span class="c-wide">Owner</span><span>Classification</span><span>Phase</span><span>Status</span><span class="c-wide num">Datasets</span><span class="c-wide">Created</span><span class="c-wide">Modified</span><span class="c-wide">Last Updated</span></div>'
        + projects.map(p => `<div class="pl-row${open === p.folder ? ' on' : ''}" data-f="${esc(p.folder)}">
          <span class="pl-name">${esc(p.name)}${p.broken ? ' <span class="err">(config missing)</span>' : ''}</span><span class="c-wide pl-meta">${esc(p.owner || '-')}</span>
          <span>${badge(P.CLASSIFICATION, p.classification)}</span><span>${badge(P.PHASE, p.phase)}</span><span class="pl-pct pct ${pctCls(p.status)}">${+p.status || 0}%</span>
          <span class="c-wide pl-meta num">${p.datasets?.length || 0}</span><span class="c-wide pl-meta">${UI.date(p.created)}</span>
          <span class="c-wide pl-meta">${UI.date(p.modified)}</span><span class="c-wide pl-meta">${updated(p) ? UI.date(updated(p)) : '-'}</span></div>`).join('')
        : `<div class="pl-empty">${wsList.length ? 'No projects yet. Click + to create one.' : 'Create a workspace first (Workspace + on the left).'}</div>`);
  }

  // ---- the pane: header (phase, close), name, properties, description, Update workflow, cards, actions, activity ----
  function renderPane() {
    const p = projects.find(x => x.folder === open);
    if (!p) { paneEl.classList.remove('open'); return; }
    const people = k => `<span class="pp-plus" data-act="people" data-k="${k}" title="${k === 'owner' ? 'Choose the owner' : `Add ${k}`}">${svg('plus')}</span>`;
    const names = l => (l && l.length ? l : ['-']).map(n => `<div>${esc(n)}</div>`).join('');   // full names, one under the other
    const prop = (ic, k, v) => `<div class="pp-prop">${svg(ic)}<span class="k">${k}</span><span class="v">${v}</span></div>`;
    paneEl.innerHTML = `<div class="pp-top">${badge(P.PHASE, p.phase)}<span class="pp-folder">${esc(wsName(P.wsOf(p.folder)))} / ${esc(p.folder.split('/').pop())}</span><span style="flex:1"></span><button class="pp-x" data-act="close" title="Close">${svg('x')}</button></div>
      <div class="pp-body">
        <h2 class="pp-name" data-act="title" title="Click to rename">${esc(p.name)}${p.broken ? ' <span class="err">(config missing)</span>' : ''}</h2>
        <div class="pp-ids"><span title="Alias: the project's folder name">${esc(p.folder.split('/').pop())}</span><span title="Project UUID">${esc(p.id || '-')}</span></div>
        <div class="pp-props">
          ${prop('user', 'Owner', `${people('owner')}${names(p.owner ? [p.owner] : [])}`)}${prop('team', 'Developers', `${people('developers')}${names(p.developers)}`)}
          ${prop('team', 'Updaters', `${people('updaters')}${names(p.updaters)}`)}${prop('flag', 'Phase', `<span class="pp-pick" data-act="pick" data-k="phase">${badge(P.PHASE, p.phase)}</span>`)}
          ${prop('pct', 'Status', `<span class="pp-pick" data-act="pick" data-k="status"><span class="pct ${pctCls(p.status)}">${+p.status || 0}%</span><span class="pp-car"></span></span>`)}${prop('lock', 'Classification', `<span class="pp-pick" data-act="pick" data-k="classification">${badge(P.CLASSIFICATION, p.classification)}</span>`)}
          ${prop('tag', 'Tags', (p.tags || []).map(esc).join(', ') || '-')}${prop('db', 'Datasets', (p.datasets || []).length)}
          ${prop('cal', 'Created', UI.date(p.created))}${prop('cal', 'Modified', UI.date(p.modified))}
          ${prop('cal', 'Last Updated', lastUpdated(p))}
        </div>
        <div class="pp-sec"><div class="pp-h"><b>Description</b><button class="ghost small" data-act="edit">Edit</button></div>
          <div class="pp-desc" data-act="desc" title="Click to edit">${p.description ? esc(p.description) : '<span class="muted">No description.</span>'}</div></div>
        <div class="pp-sec"><div class="wf" id="wf">${workflow(p)}</div></div>
        <div class="pp-sec"><div class="pcards" id="pcards"></div></div>
        <div class="pp-actions"><button class="ghost" data-act="edit">Edit details</button><button class="ghost" data-act="archives"${p.broken ? ' disabled' : ''} title="Project snapshots (zipped): take, restore, delete">Archives</button><button class="danger" data-act="delete">Delete</button></div>
        <div class="pp-tabs"><span class="on">Activity</span></div>
        <div class="log" id="plog"></div>
      </div>`;
    paneEl.classList.add('open');
    loadLog(p.folder); loadCards(p);
  }

  // ---- Update workflow (as in the Project Manager): one circle per step; click = open its module / run Update ----
  const runs = new Map();   // folder -> { steps, running, pct } for updates started in this window
  const stepsOf = p => runs.get(p.folder)?.steps || p.modules?.update?.steps || {};
  const STEP_MOD = { import: 'import', transform: 'pipeline', dashboard: 'dashboard', publish: 'publish' };
  function workflow(p) {
    const st = stepsOf(p), ids = ProjectUpdate.STEPS.map(s => s.id), live = !runs.get(p.folder)?.running;
    const shown = ids.map(id => { const x = st[id] || {}; return live && stale.folder === p.folder && stale.ids.has(id) ? 'stale' : x.state === 'done' && x.note === 'No Changes' ? 'same' : x.state || 'idle'; });
    const never = id => !p.modules?.[id === 'archive' ? 'archives' : STEP_MOD[id] || id]?.lastRun;
    const fin = i => ['done', 'same', 'skipped', 'failed', 'stale'].includes(shown[i]);
    const on = ids.map((id, i) => i > 0 && fin(i - 1) && shown[i] !== 'idle' && !(id === 'update' && shown[i] === 'running'));
    const tip = Math.max(-1, ...on.map((v, i) => v ? i : -1));
    return ProjectUpdate.STEPS.map((s, i) => {
      const x = st[s.id] || {}, state = shown[i], pct = runs.get(p.folder)?.pct?.[s.id], working = state === 'running' && pct != null;
      const note = { running: s.id === 'update' || working ? 'Running' : 'Checking', failed: 'Failed', idle: 'Not Run', done: s.id === 'update' ? 'Finished' : 'Updated', same: 'No Changes', stale: 'Changed' }[state]
        || (x.note === 'No Changes' ? 'No Changes' : never(s.id) ? 'Not Started' : 'Skipped');
      return `${i ? `<div class="ar${on[i] ? ' on' : ' hid'}${on[i] && i === tip ? ' head' : ''}"></div>` : ''}<div class="st ${state}${working ? ' working' : ''}${state === 'skipped' && x.note === 'No Changes' ? ' nochg' : ''}" data-s="${s.id}"><div class="c"><span class="pct">${i + 1}</span>${state === 'done' ? '<span class="ck">✓</span>' : state === 'failed' ? '<span class="ck x">✕</span>' : ''}</div><div class="note">${note}</div><div class="lbl">${s.label}</div></div>`;
    }).join('');
  }
  // Change monitor: every 2 s (open project, page visible, no update running); a change after the last Update turns that
  // step and every later one light red (Changed).
  const AREA_STEP = { 'data/raw': 'import', 'data/imported': 'transform', transform: 'transform', 'data/clean': 'dashboard', dashboard: 'dashboard', publish: 'publish' };
  let stale = { folder: null, ids: new Set(), direct: new Set(), key: '' }, polling = false;
  async function monitor() {
    const p = projects.find(x => x.folder === open);
    if (polling || !p || p.broken || document.hidden || runs.get(p.folder)?.running) return;
    const since = Date.parse(p.modules?.update?.lastRun || ''); if (!since) return;
    polling = true;
    try {
      const areas = await DNFS.changes(Projects.dir(p.folder)), ids = ProjectUpdate.STEPS.map(s => s.id);
      const direct = new Set(Object.entries(areas).filter(([a, t]) => t > since && AREA_STEP[a]).map(([a]) => AREA_STEP[a]));
      const cfg = await Projects.peek(p.folder).catch(() => null);
      if (cfg && ProjectUpdate.importSig(cfg) !== p.modules?.update?.importCfg) direct.add('import');
      const first = Math.min(...[...direct].map(id => ids.indexOf(id)));
      const next = new Set(first < ids.length ? ids.slice(first) : []);
      const key = [...next].join() + '|' + [...direct].join();
      if (stale.folder !== p.folder || key !== stale.key) { stale = { folder: p.folder, ids: next, direct, key }; paintWf(p); }
    } catch {} finally { polling = false; }
  }
  function paintWf(p, flash) {
    const wf = $('wf'); if (!wf || open !== p.folder) return;
    const tmp = document.createElement('div'); tmp.innerHTML = workflow(p);
    [...tmp.children].forEach((n, i) => {
      const el = wf.children[i]; if (!el) return;
      if (el.className.replace(' flash', '') !== n.className) el.className = n.className + (el.classList.contains('flash') && n.classList.contains('done') ? ' flash' : '');
      if (el.innerHTML !== n.innerHTML) el.innerHTML = n.innerHTML;
    });
    if (flash) wf.querySelector(`[data-s="${flash}"]`)?.classList.add('flash');
  }
  async function runUpdate(p) {
    if (runs.get(p.folder)?.running) return;
    const r = { steps: {}, running: true, pct: {} }; runs.set(p.folder, r);
    paintWf(p);
    try {
      await ProjectUpdate.run(p.folder, {
        step(id, state, note) { const was = r.steps[id]?.state; r.steps[id] = { state, note }; paintWf(p, state === 'done' && was === 'running' ? id : null); },
        progress(id, pct) { if (r.pct[id] === pct) return; r.pct[id] = pct; paintWf(p); },
        log(msg, level) { if (open !== p.folder) return; $('plog')?.insertAdjacentHTML('afterbegin', `<div class="${level === 'error' ? 'err' : level === 'warn' ? 'warn' : ''}"><span class="t">${UI.stamp()}</span>  update: ${esc(msg)}</div>`); },
        minStep: 700,
        after: () => open === p.folder && !document.hidden ? new Promise(res => setTimeout(res, 1800)) : null,
      });
    } finally {
      r.running = false;
      const fresh = await P.get(p.folder).catch(() => null);
      if (fresh) projects = projects.map(x => x.folder === p.folder ? fresh : x);
      const ok = fresh?.modules?.update?.ok !== false;
      UI.toast(`${p.name}: ${ok ? 'update finished' : 'update failed'}`, ok ? 'ok' : 'err');
      renderList();
    }
  }
  // Step details (mouse over a circle): who ran it last, and everything it covers.
  const stepCache = new Map();
  async function stepFiles(p) {
    const c = stepCache.get(p.folder); if (c && Date.now() - c.at < 10000) return c.data;
    const dir = Projects.dir(p.folder), json = f => DNFS.readJSONOr(`${dir}/${f}`, null).catch(() => null);
    const [pipe, runsF, dash, man] = await Promise.all([json('transform/transform.json'), json('transform/runs.json'), json('dashboard/dashboard.json'), json('publish/published.json')]);
    const exports = (await DNFS.list(`${dir}/publish`).catch(() => [])).filter(e => e.dir && /^data-/.test(e.name)).map(e => e.name).sort().reverse();
    const data = { pipe, runs: runsF || [], dash, man: man || {}, exports };
    stepCache.set(p.folder, { at: Date.now(), data });
    return data;
  }
  function stepInfo(p, id, f) {
    const m = p.modules || {}, upd = m.update?.steps?.[id];
    const who = r => r?.lastRun ? `Last updated ${UI.date(r.lastRun)}${r.by ? ` by ${esc(r.by)}` : ''}` : 'Never updated';
    const list = (title, items) => `<div class="h">${title}</div>` + (items.length ? items.map(t => `<div class="i">${t}</div>`).join('') : '<div class="i"><small>None</small></div>');
    const ds = p.datasets || [], imported = ds.filter(d => Projects.stageOf(d) === 'imported'), clean = ds.filter(d => Projects.stageOf(d) === 'source');
    const file = s => String(s || '').split(/[\\/]/).pop();
    const err = msg => msg ? `<div class="h">Error</div><div class="i err">${esc(msg)}</div>` : '';
    const updErr = upd?.state === 'failed' ? upd.note : '';
    let title, run, body = '';
    if (id === 'import') {
      title = 'Import'; run = m.import;
      body = list('Raw files', imported.map(d => `${esc(file(d.source?.from?.src || d.source?.origin || d.source?.path))}${d.source?.from?.src || d.source?.origin ? ' <small>(outside the project)</small>' : ''}`))
        + list('Imported datasets', imported.map(d => `${esc(d.name)} <small>${UI.rows(d.rows)} rows · ${d.imported ? UI.date(d.imported) : '-'}</small>`)) + err(updErr);
    } else if (id === 'transform') {
      title = 'Transform'; run = m.pipeline;
      const q = f.pipe ? PipelineRunner.migrate(f.pipe).queries : [], last = f.runs[f.runs.length - 1];
      body = list('Queries', q.map(x => `${esc(x.name || '(unnamed)')}${x.run ? ' <small>(runs on Update, saves ' + esc(PipelineRunner.tables(x.sql).map(t => t.name).join(', ') || '-') + ')</small>' : ''}`))
        + list('Clean Datasets', clean.map(d => `${esc(d.name)} <small>${UI.rows(d.rows)} rows · last built ${d.imported ? UI.date(d.imported) : '-'}</small>`))
        + err(updErr || (last && !last.ok ? last.error : ''));
    } else if (id === 'dashboard') {
      title = 'Dashboard'; run = m.dashboard;
      const w = f.dash?.widgets || [];
      body = list('Dashboard widgets', w.map(x => `${esc(x.widget || 'Custom Widget')}${x.dataset ? ` <small>(${esc(x.dataset)})</small>` : ''}`))
        + list('Published dashboards', Object.entries(f.man).sort((a, b) => String(b[1].at).localeCompare(String(a[1].at))).slice(0, 12).map(([n, v]) => `${esc(n)} <small>${v.at ? UI.date(v.at) : ''}${v.by ? ' by ' + esc(v.by) : ''}</small>`))
        + list('Dataset exports', f.exports.slice(0, 12).map(n => esc(n))) + err(updErr);
    } else if (id === 'publish') {
      title = 'Publish'; run = m.publish;
      body = `<div class="h">Last publish</div><div class="i">${run?.files != null ? `${UI.num(run.files)} file(s)` : '<small>No record</small>'}</div>`
        + list('Published to', (run?.dirs || []).map(d => esc(d))) + err(updErr);
    } else if (id === 'archive') {
      title = 'Archive'; run = m.update;
      body = `<div class="h">Each Update ends with a zipped snapshot of the project in archives/</div><div class="i">${esc(m.update?.steps?.archive?.note || 'No snapshot yet')}</div>`
        + `<div class="i"><small>Click to open the project's snapshots (take, restore or delete one).</small></div>` + err(updErr);
    } else {
      title = 'Update'; run = m.update;
      const steps = run?.steps || {};
      body = list('Last update', ProjectUpdate.STEPS.map(s => `${s.label}: ${esc(steps[s.id]?.state || 'not run')}${steps[s.id]?.note ? ` <small>(${esc(steps[s.id].note)})</small>` : ''}`))
        + err(Object.values(steps).find(s => s.state === 'failed')?.note);
    }
    return `<b>${title}</b><div class="who">${who(run)}</div>${body}`;
  }
  let stepBox = null, stepAt = null;
  const placeStep = (x, y) => {
    if (!stepBox) return;
    const r = stepBox.getBoundingClientRect();
    stepBox.style.left = `${Math.min(x + 14, innerWidth - r.width - 8)}px`;
    stepBox.style.top = `${y + 18 + r.height > innerHeight ? y - r.height - 10 : y + 18}px`;
  };
  document.addEventListener('mousemove', async ev => {
    const c = ev.target.closest?.('#wf .st .c'), st = c?.closest('.st');
    if (!c) { stepBox?.remove(); stepBox = stepAt = null; return; }
    if (stepAt !== st.dataset.s) {
      stepAt = st.dataset.s;
      const p = projects.find(x => x.folder === open); if (!p) return;
      stepBox?.remove();
      stepBox = Object.assign(document.createElement('div'), { className: 'stepinfo', innerHTML: '<small>Loading...</small>' });
      document.body.append(stepBox);
      const want = stepAt, f = await stepFiles(p);
      if (stepBox && stepAt === want) stepBox.innerHTML = stepInfo(p, want, f);
    }
    placeStep(ev.clientX, ev.clientY);
  });

  // ---- cards: disk used, rows, datasets, snapshots, last update ----
  const sizeCache = new Map();
  async function diskOf(folder) {
    const c = sizeCache.get(folder); if (c && Date.now() - c.at < 30000) return c;
    const dir = Projects.dir(folder), files = (await DNFS.list(dir, { recursive: true }).catch(() => [])).filter(e => !e.dir);
    const by = {}; let bytes = 0;
    for (const f of files) { const a = f.path.slice(dir.length + 1).split('/')[0]; by[a] = (by[a] || 0) + f.size; bytes += f.size; }
    const r = { at: Date.now(), bytes, by }; sizeCache.set(folder, r); return r;
  }
  async function loadCards(p) {
    if (!$('pcards') || !p || p.broken) return;
    const ds = p.datasets || [], imp = ds.filter(d => Projects.stageOf(d) === 'imported'), clean = ds.filter(d => Projects.stageOf(d) === 'source');
    const rows = l => l.reduce((n, d) => n + (+d.rows || 0), 0), u = p.modules?.update;
    const card = (k, v, sub = '') => `<div class="pcard"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${sub}</div></div>`;
    const paint = (disk, arch) => {
      if (open !== p.folder || !$('pcards')) return;
      $('pcards').innerHTML =
        card('Disk Used', disk ? UI.bytes(disk.bytes) : '...', disk ? `data ${UI.bytes(disk.by.data || 0)}` : '')
        + card('Rows', UI.num(rows(ds)), `${UI.num(rows(clean))} clean`)
        + card('Datasets', ds.length, `${imp.length} imported · ${clean.length} clean`)
        + card('Snapshots', arch ? arch.items.length : '...', arch ? UI.bytes(arch.items.reduce((n, a) => n + (a.bytes || a.size || 0), 0)) : '')
        + card('Last Update', u?.ms != null ? UI.ms(u.ms) : '-', u?.lastRun ? UI.date(u.lastRun) : 'never');
    };
    paint(null, null);
    const [disk, arch] = await Promise.all([diskOf(p.folder), P.archives(p.folder).catch(() => null)]);
    paint(disk, arch);
  }
  async function loadLog(folder) {
    const lines = await ProjectLog.read(folder).catch(() => []);
    const el = $('plog'); if (!el || open !== folder) return;
    el.innerHTML = lines.slice(0, ProjectLog.MAX).map(l => {
      const m = l.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/); if (!m) return `<div>${esc(l)}</div>`;
      const [, at, lvl, mod, msg] = m, cls = lvl === 'ERROR' ? 'err' : lvl === 'WARN' ? 'warn' : '';
      return `<div class="${cls}"><span class="t">${UI.stamp(new Date(at))}</span>  ${esc(mod)}: ${esc(msg)}</div>`;
    }).join('') || '<span class="muted">No activity yet.</span>';
  }

  // ---- New / Edit / Archives / Delete (the Project Manager's) ----
  const fields = p => [
    { name: 'name', label: 'Name', value: p?.name, required: true, placeholder: 'e.g. Sales Q3' },
    { name: 'owner', label: 'Owner', type: 'user', value: p?.owner },
    { name: 'developers', label: 'Developer(s)', type: 'users', value: p?.developers || [] },
    { name: 'updaters', label: 'Updater(s)', type: 'users', value: p?.updaters || [] },
    { name: 'description', label: 'Description', type: 'textarea', value: p?.description },
    { name: 'phase', label: 'Phase', type: 'select', options: P.PHASE, value: p?.phase || 'not-started' },
    { name: 'status', label: 'Status', type: 'select', options: P.STATUS, value: p?.status ?? 0 },
    { name: 'classification', label: 'Classification', type: 'select', options: P.CLASSIFICATION, value: p?.classification || 'unclassified' },
    { name: 'tags', label: 'Tags (comma separated)', value: (p?.tags || []).join(', ') },
  ];
  const capWords = t => t.replace(/(^|\s)(\p{Ll})/gu, (m, sp, c) => sp + c.toUpperCase());
  document.addEventListener('input', ev => {
    const el = ev.target;
    if (!el.matches?.('dialog input[name="name"]')) return;
    const v = capWords(el.value);
    if (v !== el.value) { const at = el.selectionStart; el.value = v; el.setSelectionRange(at, at); }
  });
  const tagsOf = s => (s || '').split(',').map(t => t.trim()).filter(Boolean);
  const clean = async v => ({ ...v, name: capWords(v.name || ''), status: +v.status || 0, developers: UserPicker.parse(v.developers), updaters: UserPicker.parse(v.updaters), tags: tagsOf(v.tags) });
  function archBusy(title) {
    const d = document.createElement('dialog');
    d.innerHTML = `<header>${esc(title)}</header><form method="dialog"><div class="body"><div class="muted">Starting...</div></div></form>`;
    d.oncancel = ev => ev.preventDefault();
    document.body.appendChild(d); d.showModal();
    const line = d.querySelector('.body div');
    return { set: (phase, done, total) => { line.textContent = `${phase || 'Working'}... ${total ? `${UI.bytes(done)} of ${UI.bytes(total)} (${Math.floor(done * 100 / total)}%)` : ''}`; }, close: () => { d.close(); d.remove(); } };
  }
  const actions = {
    async new() {
      if (!wsList.length) return UI.toast('Create a workspace first (Workspace + on the left).', 'err');
      await UserPicker.load();
      const pickWs = ws ? [] : [{ name: 'workspace', label: 'Workspace', type: 'select', options: wsList.map(w => [w.folder, w.name]), value: wsList[0].folder }];
      const v = await UI.form(`New project${ws ? ` in ${wsName(ws)}` : ''}`, [...pickWs, ...fields()], { ok: 'Create' }); if (!v) return;
      const cfg = await P.create({ ...await clean(v), workspace: ws || v.workspace });
      UI.toast(`Created ${cfg.name} (workspace/${cfg.folder})`, 'ok');
      open = cfg.folder; await load();
    },
    async archives(p) {
      for (;;) {
        const r = await P.archives(p.folder), items = r.items.sort((a, b) => b.at.localeCompare(a.at));
        const body = `<div class="arch-path" title="Snapshots are saved here">${esc(r.folder)}/</div>` + (items.length
          ? `<div class="trash-list arch-list">${items.map(a => `<label><input type="radio" name="pick" value="${esc(a.id)}"> ${UI.date(a.at)}${a.note ? ` &middot; ${esc(a.note)}` : ''}<small>${a.datasets} dataset(s) &middot; ${UI.bytes(a.size)}${a.zip ? ` zipped (${UI.bytes(a.bytes)})` : ' folder'}</small></label>`).join('')}</div>`
          : '<div class="muted">No snapshots yet.</div>') +
          `<label class="field arch-note">Note for a new snapshot<input type="text" name="note" autocomplete="off" spellcheck="false" placeholder="optional"></label>`;
        const pick = f => f.querySelector('input[name=pick]:checked')?.value;
        const act = await UI.dialog(`Archives: ${p.name}`, body, [{ label: 'Close', value: null, kind: 'ghost' },
          ...(items.length ? [{ label: 'Delete', value: f => ({ op: 'delete', id: pick(f) }), kind: 'danger' }, { label: 'Restore', value: f => ({ op: 'restore', id: pick(f) }) }] : []),
          { label: 'Take Snapshot', value: f => ({ op: 'take', note: f.querySelector('input[name=note]').value.trim() }), kind: 'go' }]);
        if (!act) return;
        if (act.op !== 'take' && !act.id) { UI.toast('Pick a snapshot first.', 'err'); continue; }
        if (act.op === 'delete') {
          if (!await UI.confirm(`Delete snapshot ${act.id}? This cannot be undone.`, { danger: true, ok: 'Delete' })) continue;
          await P.deleteSnapshot(p.folder, act.id); await ProjectLog.write(p.folder, 'archives', `Deleted snapshot ${act.id}`);
          UI.toast('Snapshot deleted', 'ok'); continue;
        }
        if (act.op === 'restore' && !await UI.confirm(`Restore snapshot ${act.id}? Imported datasets, transform and dashboard are replaced. The current state is saved as a snapshot first (unless the newest one already matches it).`, { danger: true, ok: 'Restore' })) continue;
        const busy = archBusy(act.op === 'take' ? 'Taking snapshot' : 'Restoring snapshot');
        try {
          if (act.op === 'take') {
            const s = await P.snapshot(p.folder, act.note, busy.set);
            await ProjectLog.write(p.folder, 'archives', `Snapshot taken: ${s.id}${act.note ? ` (${act.note})` : ''}, ${UI.bytes(s.bytes)} zipped`);
            UI.toast(`Snapshot taken (${UI.bytes(s.bytes)} zipped)`, 'ok');
          } else {
            const s = await P.restoreSnapshot(p.folder, act.id, busy.set);
            await ProjectLog.write(p.folder, 'archives', `Restored snapshot ${act.id}${s.saved ? ` (current state saved as ${s.saved})` : ''}`);
            UI.toast(`Snapshot restored${s.saved ? `; the previous state was saved as ${s.saved}` : ''}`, 'ok'); await load();
          }
        } finally { busy.close(); }
      }
    },
    async edit(p) {
      await UserPicker.load();
      const v = await UI.form(`Edit ${p.name}`, fields(p), { ok: 'Save' }); if (!v) return;
      const { name, ...rest } = await clean(v);
      let folder = p.folder;
      if (name.trim() !== p.name) folder = (await P.rename(p.folder, name)).folder;
      await P.update(folder, rest);
      await ProjectLog.write(folder, 'project', 'Details edited');
      UI.toast('Saved', 'ok'); open = folder; await load();
    },
    async delete(p) {
      if (!await UI.dialog('Delete project', `<div>Are you sure you want to delete <b>${esc(p.name)}</b>?</div>
        <div class="muted"><b>NOTE:</b> This only removes the project from the list and moves it to the trash (workspace/.trash). If the trash is emptied, the project is permanently deleted.</div>`,
        [{ label: 'Cancel', value: false, kind: 'ghost' }, { label: 'Delete', value: true, kind: 'danger' }])) return;
      const r = await P.trash(p.folder);
      UI.toast(`Moved to ${r.trashed}`, 'ok'); open = null; paneEl.classList.remove('open'); await load();
    },
    close() { open = null; paneEl.classList.remove('open'); renderList(); },
  };

  // ---- in-place edits in the pane ----
  // Owner / Developers / Updaters: the green + opens the user picker for that field.
  async function people(p, k) {
    await UserPicker.load();
    const label = { owner: 'Owner', developers: 'Developer(s)', updaters: 'Updater(s)' }[k];
    const v = await UI.form(`${label}: ${p.name}`, [{ name: k, label, type: k === 'owner' ? 'user' : 'users', value: p[k] || (k === 'owner' ? '' : []) }], { ok: 'Save' });
    if (!v) return;
    await P.update(p.folder, { [k]: k === 'owner' ? v[k] : UserPicker.parse(v[k]) });
    await ProjectLog.write(p.folder, 'project', `${label} changed`); load();
  }
  // Phase / Classification badge, Status %: a click drops the options (status every 5%).
  let menu = null;
  const closeMenu = () => { menu?.remove(); menu = null; };
  document.addEventListener('pointerdown', e => { if (menu && !menu.contains(e.target)) closeMenu(); }, true);
  function pick(p, k, el) {
    closeMenu();
    const list = k === 'phase' ? P.PHASE : k === 'classification' ? P.CLASSIFICATION : STATUS5;
    menu = Object.assign(document.createElement('div'), { className: 'ppmenu' });
    menu.innerHTML = list.map(([v, l]) => `<div data-v="${esc(v)}" class="${String(p[k] ?? '') === String(v) ? 'on' : ''}">${k === 'status' ? `<span class="pct ${pctCls(v)}">${esc(l)}</span>` : badge(list, v)}</div>`).join('');
    document.body.append(menu);
    const r = el.getBoundingClientRect(), h = menu.offsetHeight;
    Object.assign(menu.style, { left: `${r.left}px`, top: `${r.bottom + 4 + h > innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4}px` });
    menu.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
    menu.onclick = UI.guard(async e => {
      const o = e.target.closest('[data-v]'); if (!o) return;
      const v = k === 'status' ? +o.dataset.v : o.dataset.v; closeMenu();
      if (String(v) === String(p[k])) return;
      await P.update(p.folder, { [k]: v });
      await ProjectLog.write(p.folder, 'project', `${k[0].toUpperCase() + k.slice(1)} set to ${k === 'status' ? v + '%' : P.label(list, v)}`); load();
    });
  }
  // Title: click to edit in place; Enter / leaving saves (renames the project and its folder), Escape cancels.
  function editTitle(p, h) {
    if (h.querySelector('input')) return;
    const box = Object.assign(document.createElement('input'), { type: 'text', className: 'pp-title-in', value: p.name, spellcheck: false });
    h.replaceChildren(box); box.focus(); box.select();
    let done = false;
    const finish = UI.guard(async save => {
      if (done) return; done = true;
      const name = capWords(box.value.trim());
      if (!save || !name || name === p.name) return renderPane();
      const cfg = await P.rename(p.folder, name);
      UI.toast('Renamed', 'ok'); open = cfg.folder; await load();
    });
    box.oninput = () => { const v = capWords(box.value); if (v !== box.value) { const at = box.selectionStart; box.value = v; box.setSelectionRange(at, at); } };
    box.onkeydown = e => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); };
    box.onblur = () => finish(true);
  }

  // Description: click to edit in place; leaving the box or Ctrl+Enter saves, Escape cancels.
  function editDesc(p, el) {
    if (el.querySelector('textarea')) return;
    const box = Object.assign(document.createElement('textarea'), { className: 'pp-desc-in', value: p.description || '', spellcheck: true });
    box.rows = Math.max(3, (p.description || '').split(/\r?\n/).length + 1);
    el.replaceChildren(box); box.focus();
    let done = false;
    const finish = UI.guard(async save => {
      if (done) return; done = true;
      const text = box.value.trim();
      if (!save || text === (p.description || '').trim()) return renderPane();
      await P.update(p.folder, { description: text });
      await ProjectLog.write(p.folder, 'project', 'Description edited'); await load();
    });
    box.onkeydown = e => { if (e.key === 'Escape') finish(false); else if (e.key === 'Enter' && e.ctrlKey) finish(true); };
    box.onblur = () => finish(true);
  }

  function init(list, pane) {
    listEl = list; paneEl = pane;
    listEl.onclick = UI.guard(async ev => {
      if (ev.target.closest('[data-act="new"]')) return actions.new();
      if (ev.target.closest('[data-act="trash"]')) return api.onTrash?.();   // the page's Trash dialog
      const row = ev.target.closest('.pl-row'); if (!row) return;
      open = open === row.dataset.f ? null : row.dataset.f;
      stale = { folder: null, ids: new Set(), direct: new Set(), key: '' };
      renderList(); renderPane();
    });
    paneEl.onclick = UI.guard(async ev => {
      const p = projects.find(x => x.folder === open);
      const circle = ev.target.closest('#wf .st .c');
      if (circle) {
        if (!p || p.broken) return;
        const id = circle.closest('.st').dataset.s;
        if (id === 'update') return runUpdate(p);
        if (id === 'archive') return actions.archives(p);
        if (Windows.MODULES.find(m => m.id === STEP_MOD[id])?.enabled) Windows.open(STEP_MOD[id], open);
        return;
      }
      const act = ev.target.closest('[data-act]');
      if (act?.dataset.act === 'people') return people(p, act.dataset.k);
      if (act?.dataset.act === 'pick') return pick(p, act.dataset.k, act);
      if (act?.dataset.act === 'title') return editTitle(p, act);
      if (act?.dataset.act === 'desc') return editDesc(p, act);
      if (act && actions[act.dataset.act]) return actions[act.dataset.act](p);
    });
    setInterval(monitor, 2000);
    load();
  }
  const setWorkspace = folder => { ws = folder || null; load(); };
  const api = { init, reload: load, setWorkspace, onTrash: null };
  return api;
})();
