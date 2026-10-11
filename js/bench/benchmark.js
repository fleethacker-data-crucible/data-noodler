// Benchmark page (html/benchmark.html, Project Manager > Utilities > Benchmark).
// Pick sizes, tests, worker counts and rows per batch (check boxes), Run: every checked test runs for every checked
// size x rows per batch x worker count (1 .. the engine's max). Live cards show the step running; the table keeps every
// result. Results + choices are saved in test-data/bench/benchmark.json (gitignored) and come back when the page opens.
// Save Report writes test-data/bench/reports/benchmark-<time>.md. Wipe Test Data deletes test-data/bench/data.
(() => {
  const { $, esc } = UI, T = BenchTests;
  const FILE = `${T.DIR}/benchmark.json`, DEFAULT_BATCH = 100000;
  let maxW = 1, status = null;
  let st = { sizes: [100000, 1000000], tests: T.TESTS.map(t => t.id), threads: [], batches: [DEFAULT_BATCH], unit: 'rps' };
  let results = {};   // key "metric|rows|batch" -> { id, label, kind, test, n, batch, cells: { workers: { ms, rows } | { err } } }
  let running = false, stopped = false, curJob = null, runT0 = 0;

  const fmtRate = r => r >= 1e9 ? (r / 1e9).toFixed(2) + 'B' : r >= 1e6 ? (r / 1e6).toFixed(r >= 1e8 ? 0 : 1) + 'M' : r >= 1e3 ? (r / 1e3).toFixed(0) + 'k' : r.toFixed(0);
  const fmtS = ms => (ms / 1000).toFixed(1) + ' s';   // live cards: always seconds, 1 decimal
  const fmtMs = ms => ms >= 10000 ? (ms / 1000).toFixed(1) + ' s' : Math.round(ms).toLocaleString() + ' ms';
  const val = c => !c || c.err || !(c.ms >= 0) ? null : st.unit === 'ms' ? c.ms : c.rows / Math.max(c.ms, 0.01) * 1000;
  const show = c => c?.err ? c.err : c?.running ? 'running' : val(c) == null ? '' : st.unit === 'ms' ? fmtMs(c.ms) : fmtRate(val(c)) + '/s';
  const log = (msg, cls = '') => { const d = document.createElement('div'); d.className = cls; d.textContent = `${UI.stamp()}  ${msg}`; $('log').prepend(d); };

  // ---- check-box drop-downs ----
  function pick(host, title, items, key) {
    host.innerHTML = `<span class="dd-wrap"><button class="ghost"></button><div class="dd-menu"></div></span>`;
    const btn = host.querySelector('button'), menu = host.querySelector('.dd-menu');
    const paint = () => {
      const sel = st[key], all = items.every(i => sel.includes(i.v));
      btn.textContent = `${title}: ${all ? 'All' : sel.length ? items.filter(i => sel.includes(i.v)).map(i => i.short || i.l).join(', ') : 'none'} ▾`;
      menu.innerHTML = `<label class="all"><input type="checkbox" data-v="*" ${all ? 'checked' : ''}>${key === 'tests' ? 'Run All' : 'All'}</label>` +
        items.map(i => `<label class="${i.bad ? 'bad' : ''}" title="${esc(i.desc || '')}"><input type="checkbox" data-v="${esc(String(i.v))}" ${sel.includes(i.v) ? 'checked' : ''}><span>${esc(i.l)}${i.desc ? `<small>${esc(i.desc)}</small>` : ''}</span></label>`).join('');
      plan();
    };
    btn.onclick = ev => { ev.stopPropagation(); const was = menu.classList.contains('open'); document.querySelectorAll('.pick .dd-menu.open').forEach(m => m.classList.remove('open')); if (!was && !running) menu.classList.add('open'); };
    menu.onclick = ev => ev.stopPropagation();
    menu.onchange = ev => {
      const v = ev.target.dataset.v;
      if (v === '*') st[key] = ev.target.checked ? items.map(i => i.v) : [];
      else { const x = items.find(i => String(i.v) === v).v; st[key] = ev.target.checked ? [...new Set([...st[key], x])] : st[key].filter(y => y !== x); }
      st[key] = items.map(i => i.v).filter(v2 => st[key].includes(v2));   // keep list order
      paint(); save();
    };
    paint();
    return paint;
  }
  addEventListener('click', () => document.querySelectorAll('.pick .dd-menu.open').forEach(m => m.classList.remove('open')));

  // ---- cards ----
  const last = {};   // kind -> the last finished result shown (put back when the live ticker stops)
  function card(kind, ms, rows, note, final) {
    if (final) last[kind] = [ms, rows, note];
    const id = kind === 'read' ? 'Read' : kind === 'write' ? 'Write' : 'Query';
    $('c' + id).textContent = ms == null ? '–' : st.unit === 'ms' ? fmtS(ms) : rows ? fmtRate(rows / Math.max(ms, 0.01) * 1000) + '/s' : fmtS(ms);
    $('s' + id).textContent = note || ' ';
  }
  setInterval(async () => {
    try {
      const r = await fetch('/api/mem', { headers: { 'X-DN-Token': window.DN_TOKEN || '' }, cache: 'no-store' }).then(r => r.json());
      $('cMem').textContent = UI.bytes(r.engine);
      $('sMem').textContent = `system free ${UI.bytes(r.sysFree)} of ${UI.bytes(r.sysTotal)}`;
    } catch {}
    if (running) $('cTime').textContent = fmtS(performance.now() - runT0);
  }, 500);

  // ---- engine calls with live numbers ----
  let live = null;   // { kind, n, label, t0 } for the step running (sync calls tick the elapsed time)
  setInterval(() => { if (live && !live.job) card(live.kind, performance.now() - live.t0, null, `${live.label} · running…`); }, 100);
  async function call(op, body) {
    const r = await Engine.call(op, body);
    return r;
  }
  async function job(op, body) {
    let j = await Engine.call(op, body); curJob = j.jobId;
    try {
      while (j.state !== 'done') {
        if (j.state === 'failed' || j.state === 'cancelled') { const e = new Error(j.error?.message || `Job ${j.state}`); e.code = j.error?.code; throw e; }
        await new Promise(r => setTimeout(r, 100));
        j = await Engine.call('job?id=' + encodeURIComponent(j.jobId), undefined, 'GET');
        if (live) { live.job = true; card(live.kind, j.elapsedMs, j.rowsProcessed, `${live.label} · ${UI.num(j.rowsProcessed)} rows`); }
      }
      return j;
    } finally { curJob = null; }
  }
  const setBatch = n => Engine.call('options', { batchRows: n }).catch(() => {});

  // ---- results table ----
  const keyOf = (id, n, b) => `${id}|${n}|${b}`;
  function threadCols() { const s = new Set(); for (const r of Object.values(results)) for (const t of Object.keys(r.cells)) s.add(+t); return [...s].sort((a, b) => a - b); }
  const testOrder = id => { const base = id.split(':')[0]; const i = T.TESTS.findIndex(t => t.id === base); return i >= 0 ? i * 100 + (id.endsWith(':write') ? 1 : 0) : 1100 + T.HEAVY.findIndex(h => h[0] === id); };
  function render() {
    const rows = Object.values(results).sort((a, b) => a.n - b.n || a.batch - b.batch || testOrder(a.id) - testOrder(b.id));
    if (!rows.length) { $('results').innerHTML = '<div class="muted" style="padding:8px">No results yet: pick what to run and press Run.</div>'; return; }
    const ts = threadCols(), better = (x, y) => st.unit === 'ms' ? x < y : x > y;
    let html = `<div class="table-wrap"><table><thead><tr><th>Test</th><th>Rows</th><th>Batch</th><th>Kind</th>${ts.map(t => `<th>${t} worker${t > 1 ? 's' : ''}</th>`).join('')}<th>Best</th><th>Best vs 1</th></tr></thead><tbody>`;
    let grp = '';
    for (const r of rows) {
      const g = `${T.sizeLabel(r.n)} rows · ${T.sizeLabel(r.batch)} per batch`;
      if (g !== grp) { grp = g; html += `<tr class="grp"><td colspan="${ts.length + 6}">${esc(g)}</td></tr>`; }
      let best = null, bestT = null;
      for (const t of ts) { const v = val(r.cells[t]); if (v != null && (best == null || better(v, best))) { best = v; bestT = t; } }
      const one = val(r.cells[1]);
      const sp = best != null && one != null ? (st.unit === 'ms' ? one / best : best / one) : null;
      html += `<tr><td><span class="kind ${r.kind}"></span>${esc(r.label)}</td><td>${T.sizeLabel(r.n)}</td><td>${T.sizeLabel(r.batch)}</td><td>${r.kind}</td>` +
        ts.map(t => { const c = r.cells[t]; return `<td class="${c?.err ? 'err' : c?.running ? 'run' : 'v'}${t === bestT ? ' best' : ''}" title="${c && !c.err && c.ms != null ? `${fmtMs(c.ms)} · ${fmtRate(c.rows / Math.max(c.ms, .01) * 1000)} rows/s` : esc(c?.err || '')}">${esc(show(c))}</td>`; }).join('') +
        `<td class="v">${bestT ? `${bestT}` : ''}</td><td class="v">${sp ? sp.toFixed(1) + '×' : ''}</td></tr>`;
    }
    $('results').innerHTML = html + '</tbody></table></div>';
  }
  $('unit').onchange = () => { st.unit = $('unit').value; render(); save(); };

  // ---- plan / save / load ----
  function plan() {
    const n = st.sizes.length * st.batches.length * st.tests.length * st.threads.length;
    $('run').disabled = running || !n;
    if (!running) $('status').textContent = n ? `${UI.num(n)} runs: ${st.tests.length} test${st.tests.length !== 1 ? 's' : ''} × ${st.sizes.length} size${st.sizes.length !== 1 ? 's' : ''} × ${st.batches.length} batch size${st.batches.length !== 1 ? 's' : ''} × ${st.threads.length} worker count${st.threads.length !== 1 ? 's' : ''}` : 'Pick at least one size, test, worker count and batch size.';
  }
  const save = UI.debounce(() => DNFS.writeJSON(FILE, { settings: st, results, machine: status && { workers: status.workers, cores: status.cores, budget: status.memory?.budget, totalPhys: status.memory?.totalPhys, clr: status.clr }, updated: new Date().toISOString() }).catch(e => log(`Could not save results: ${e.message}`, 'err')), 400);

  // ---- run ----
  $('run').onclick = UI.guard(async () => {
    if (running) return;
    running = true; stopped = false; runT0 = performance.now();
    $('run').disabled = true; $('stop').disabled = false; ['report', 'clear', 'purge', 'wipe'].forEach(id => $(id).disabled = true);
    const total = st.sizes.length * st.batches.length * st.tests.length * st.threads.length; let done = 0;
    const prog = (label) => { $('cProg').textContent = `${done} / ${total}`; $('sProg').textContent = label; $('bar').style.width = `${(100 * done / total).toFixed(1)}%`; $('status').textContent = label; };
    const ctxBase = { call, job, stopped: () => stopped, say: t => prog(t) };
    try {
      for (const n of st.sizes) {
        if (stopped) break;
        await setBatch(DEFAULT_BATCH);
        await T.ensureData(n, t => { prog(t); log(t); }, job);
        for (const b of st.batches) {
          if (stopped) break;
          await setBatch(b);
          for (const id of st.tests) {
            const test = T.TESTS.find(x => x.id === id);
            for (const w of st.threads) {
              if (stopped) break;
              const label = `${test.label} · ${T.sizeLabel(n)} rows · ${T.sizeLabel(b)} per batch · ${w} worker${w > 1 ? 's' : ''}`;
              prog(label);
              for (const m of T.metricsOf(id)) { const k = keyOf(m.id, n, b); results[k] ||= { id: m.id, label: m.label || test.label, kind: m.kind, test: id, n, batch: b, cells: {} }; results[k].cells[w] = { running: true }; }
              render();
              live = { kind: test.kind === 'both' ? 'read' : test.kind, label: test.label, t0: performance.now() };
              const put = m => { const k = keyOf(m.id, n, b); results[k] ||= { id: m.id, label: m.label, kind: m.kind, test: id, n, batch: b, cells: {} }; results[k].label = m.label; results[k].cells[w] = m.err ? { err: m.err } : { ms: m.ms, rows: m.rows }; if (!m.err) { card(m.kind, m.ms, m.rows, `${m.label} · ${T.sizeLabel(n)} · ${w}w`, true); if (live) live.t0 = performance.now(); } render(); save(); };
              try {
                const ms = await T.run(id, { ...ctxBase, n, workers: w, onMetric: put });
                for (const m of ms) put(m);
                for (const m of T.metricsOf(id)) { const c = results[keyOf(m.id, n, b)]?.cells[w]; if (c?.running) results[keyOf(m.id, n, b)].cells[w] = { err: stopped ? 'stopped' : 'not run' }; }
              } catch (e) {
                const msg = e.code === 'QUERY_OUT_OF_MEMORY' ? 'out of memory' : stopped ? 'stopped' : String(e.message || e).split('\n')[0];
                for (const m of T.metricsOf(id)) { const k = keyOf(m.id, n, b); if (results[k].cells[w]?.running) results[k].cells[w] = { err: msg }; }
                if (!stopped) log(`${label}: ${msg}`, 'err');
              }
              live = null; for (const k of Object.keys(last)) card(k, ...last[k]); done++; render(); save();
            }
          }
        }
        await T.dropMem(call);
      }
      prog(stopped ? 'Stopped.' : `Finished ${done} runs in ${fmtMs(performance.now() - runT0)}.`);
      log(stopped ? 'Stopped.' : `Finished ${done} runs in ${fmtMs(performance.now() - runT0)}.`, stopped ? 'warn' : 'ok');
    } finally {
      live = null; running = false;
      await setBatch(DEFAULT_BATCH); await T.dropMem(call).catch(() => {});
      $('stop').disabled = true; ['report', 'clear', 'purge', 'wipe'].forEach(id => $(id).disabled = false); plan(); save();
    }
  });
  $('stop').onclick = async () => { stopped = true; $('stop').disabled = true; $('status').textContent = 'Stopping…'; if (curJob) await Engine.cancel(curJob).catch(() => {}); };
  addEventListener('pagehide', () => { try { fetch('/api/engine/options', { method: 'POST', keepalive: true, headers: { 'X-DN-Token': window.DN_TOKEN || '', 'Content-Type': 'application/json' }, body: JSON.stringify({ batchRows: DEFAULT_BATCH }) }); } catch {} });

  // ---- clear / wipe / report ----
  $('clear').onclick = UI.guard(async () => { if (!await UI.confirm('Clear every result in the table? (Test data stays.)', { ok: 'Clear' })) return; results = {}; render(); save(); });
  $('purge').onclick = UI.guard(async () => {
    if (running) throw new Error('Stop the run first.');
    await T.dropMem(call);
    const r = await call('memory/purge', {});
    log(`Memory purged: ${r.tables} table(s), ${r.datasets} dataset(s) freed; engine holds ${UI.bytes(r.managed)}.`, 'ok'); UI.toast('Engine memory purged', 'ok');
  });
  $('wipe').onclick = UI.guard(async () => {
    if (!await UI.confirm('Delete every file the tests made (test-data/bench/data)? Results and reports stay.', { danger: true, ok: 'Wipe' })) return;
    await T.dropMem(call);
    await DNFS.remove(T.DATA, { recursive: true }).catch(() => {});
    log('Test data wiped.', 'ok'); UI.toast('Test data wiped', 'ok');
  });
  function markdown() {
    const rows = Object.values(results).sort((a, b) => a.n - b.n || a.batch - b.batch || testOrder(a.id) - testOrder(b.id)), ts = threadCols();
    const m = status || {};
    const lines = [`# Data Noodler benchmark`, '', `${new Date().toLocaleString()} · engine ${m.version || ''} · ${m.workers} workers on ${m.cores} logical cores · memory budget ${UI.bytes(m.memory?.budget || 0)} of ${UI.bytes(m.memory?.totalPhys || 0)} RAM · .NET ${m.clr || ''}`, '',
      'Times are the engine\'s own (no HTTP). Rows/s = rows the step works through / time. Read = into memory or into a dataset, Write = to a file or table, Query = in-memory queries.', ''];
    for (const unit of ['rps', 'ms']) {
      lines.push(`## ${unit === 'rps' ? 'Rows per second (higher is better)' : 'Time (lower is better)'}`, '');
      let grp = '';
      for (const r of rows) {
        const g = `${T.sizeLabel(r.n)} rows, ${T.sizeLabel(r.batch)} rows per batch`;
        if (g !== grp) { grp = g; lines.push('', `### ${g}`, '', `| Test | Kind | ${ts.map(t => `${t}w`).join(' | ')} |`, `|---|---|${ts.map(() => '---:').join('|')}|`); }
        const cell = c => !c ? '' : c.err ? c.err : c.ms == null ? '' : unit === 'ms' ? fmtMs(c.ms) : fmtRate(c.rows / Math.max(c.ms, .01) * 1000);
        lines.push(`| ${r.label} | ${r.kind} | ${ts.map(t => cell(r.cells[t])).join(' | ')} |`);
      }
      lines.push('');
    }
    return lines.join('\n');
  }
  $('report').onclick = UI.guard(async () => {
    if (!Object.keys(results).length) throw new Error('Nothing to report yet: run some tests first.');
    const d = new Date(), p = n => String(n).padStart(2, '0');
    const path = `${T.DIR}/reports/benchmark-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.md`;
    await DNFS.writeText(path, markdown());
    log(`Report saved: ${path}`, 'ok'); UI.toast(`Report saved: ${path}`, 'ok');
  });

  // ---- start ----
  (async () => {
    try { status = await Engine.status(); maxW = status.workers; } catch (e) { log(`Engine not reachable: ${e.message}`, 'err'); }
    const saved = await DNFS.readJSONOr(FILE, null).catch(() => null);
    if (saved?.settings) st = { ...st, ...saved.settings };
    if (saved?.results) results = saved.results;
    for (const r of Object.values(results)) for (const t of Object.keys(r.cells)) if (r.cells[t]?.running) r.cells[t] = { err: 'interrupted' };
    // Pre-calculate which sizes fit in engine memory (popup + progress); the ones that do not are red and spill to disk.
    let mem = {};
    if (status) {
      const dlg = $('memDlg'); dlg.showModal();
      const say = (t, f) => { $('memMsg').textContent = t; $('memBar').style.width = `${Math.round(f * 100)}%`; };
      try { say('Reading the engine memory budget', 0.05); mem = await T.memoryPlan(call, status.memory?.budget || 0, say); }
      catch (e) { log(`Memory pre-calculation failed: ${e.message}`, 'err'); }
      finally { dlg.close(); }
      const over = T.SIZES.filter(n => mem[n] && !mem[n].fits);
      if (over.length) log(`Will not fit in memory (spill to disk, slower): ${over.map(T.sizeLabel).join(', ')} rows.`, 'warn');
    }
    const threads = Array.from({ length: maxW }, (_, i) => i + 1);
    if (!st.threads.length) st.threads = [...new Set([1, 2, 4, maxW])].filter(t => t <= maxW);
    st.threads = st.threads.filter(t => t <= maxW);
    $('unit').value = st.unit;
    pick($('pSizes'), 'Rows', T.SIZES.map(v => ({ v, l: `${T.sizeLabel(v)} rows`, short: T.sizeLabel(v), bad: mem[v] && !mem[v].fits,
      desc: mem[v] ? `memory tests need ~${UI.bytes(mem[v].need)} of ${UI.bytes(mem[v].room)}${mem[v].fits ? '' : ': does not fit, spills to disk'}` : '' })), 'sizes');
    pick($('pTests'), 'Tests', T.TESTS.map(t => ({ v: t.id, l: t.label, short: t.label.replace(/^(Import|Export|Read\/Write) /, '$1 ').replace('Read/Write', 'R/W'), desc: t.desc })), 'tests');
    pick($('pThreads'), 'Workers', threads.map(v => ({ v, l: `${v} worker${v > 1 ? 's' : ''}`, short: String(v) })), 'threads');
    pick($('pBatches'), 'Rows per batch', T.BATCHES.map(v => ({ v, l: `${T.sizeLabel(v)} rows${v === DEFAULT_BATCH ? ' (default)' : ''}`, short: T.sizeLabel(v) })), 'batches');
    $('sub').textContent = status ? `${status.workers} workers on ${status.cores} logical cores · memory budget ${UI.bytes(status.memory?.budget || 0)} of ${UI.bytes(status.memory?.totalPhys || 0)} RAM` : $('sub').textContent;
    render(); plan();
  })();
})();
