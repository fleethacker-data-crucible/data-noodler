// Preview tables (Import, Transform, their pop-out): the app's own table, the same look as the schema tables
// (ui/css/theme.css: .table-wrap + table.grid). A bar above it: Search, a row readout, Pop-out and Export.
// Global: DataTable.
//   DataTable.show(el, cols, rows, { total, more, title, popped })   cols = column names, rows = arrays (an engine result)
//     more(offset) -> rows (arrays) after the first ones: asked for as the reader scrolls near the end (100 at a time).
//     total = all rows of the query (when known). el gets a .pgrid box (its height comes from the page's CSS).
//   DataTable.popData(cols, rows, opts) -> what the pop-out window (ui/html/table-pop.html) draws: win.DNTableShow(d).
//   Pop-out hides the table here (a note says where it is) and raises 'grid-popout' { open, win } on el; it comes
//   back when that window closes. Export: .csv of the rows loaded (filtered by Search); .parquet / .sqlite raise
//   'grid-export' { format } on el for the page to handle.
const DataTable = (() => {
  const PAGE = 100, NEAR = 400;   // rows per block; px from the bottom that load the next block
  const esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const text = v => v == null ? '' : String(v);
  const pops = new WeakMap();   // el -> pop-out window

  function show(el, cols, rows, o = {}) {
    const host = el._popped || el, doc = host.ownerDocument;   // popped out: the same box, now in that window
    let box = host.querySelector(':scope > .pgrid');
    if (!box) { host.innerHTML = ''; box = Object.assign(doc.createElement('div'), { className: 'pgrid' }); host.append(box); }
    box._dt?.stop();
    const st = { rows: [...rows], q: '', done: !o.more || rows.length < PAGE || (o.total != null && rows.length >= o.total), busy: false, live: true };
    box._dt = { stop: () => { st.live = false; } };
    box.innerHTML = `<div class="dt-bar"><input class="search" type="search" placeholder="Search" spellcheck="false"><span class="muted dt-n"></span><span style="flex:1"></span>`
      + (o.popped ? '' : '<button class="ghost small dt-pop" title="Open this table in its own window">Pop-out</button>')
      + `<div class="dt-exp"><button class="ghost small">Export ▾</button><div class="dd-menu">${['csv', 'parquet', 'sqlite'].map(f => `<div data-fmt="${f}">.${f}</div>`).join('')}</div></div></div>`
      + `<div class="table-wrap dt-wrap"><table class="grid dt"><thead><tr>${cols.map(c => `<th title="${esc(c)}">${esc(c)}</th>`).join('')}</tr></thead><tbody></tbody></table></div>`;
    const wrap = box.querySelector('.dt-wrap'), body = box.querySelector('tbody'), n = box.querySelector('.dt-n'), search = box.querySelector('.search');
    const match = r => !st.q || r.some(v => text(v).toLowerCase().includes(st.q));
    const row = r => `<tr>${r.map(v => `<td${v == null ? ' class="muted"' : String(v).length > 30 ? ` title="${esc(v)}"` : ''}>${v == null ? 'NULL' : esc(v)}</td>`).join('')}</tr>`;
    const readout = shown => { n.textContent = `${UI.num(shown)}${st.q ? ' matching' : ''} of ${UI.num(o.total ?? st.rows.length)}${o.total == null && !st.done ? '+' : ''} rows`; };
    let shown = 0;
    function draw() {
      const list = st.rows.filter(match); shown = list.length;
      body.innerHTML = list.length ? list.map(row).join('') : `<tr><td class="muted" colspan="${cols.length || 1}">${st.rows.length ? 'No matching rows.' : 'No rows.'}</td></tr>`;
      readout(shown);
    }
    async function next() {
      if (st.done || st.busy || !o.more) return;
      st.busy = true;
      try {
        const add = await o.more(st.rows.length); if (!st.live) return;
        st.rows.push(...add); st.done = add.length < PAGE || (o.total != null && st.rows.length >= o.total);
        const fresh = add.filter(match); body.insertAdjacentHTML('beforeend', fresh.map(row).join('')); shown += fresh.length; readout(shown);
      } catch (e) { st.done = true; UI.toast(e.message, 'err'); } finally { st.busy = false; }
      if (st.live && wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < NEAR) next();   // still near the end (searching hides rows)
    }
    wrap.addEventListener('scroll', () => { if (wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < NEAR) next(); });
    let t; search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { st.q = search.value.trim().toLowerCase(); draw(); if (st.q) next(); }, 150); });
    // Export
    const ex = box.querySelector('.dt-exp'), menu = ex.querySelector('.dd-menu');
    ex.querySelector('button').onclick = e => { e.stopPropagation(); menu.classList.toggle('open'); };
    doc.addEventListener('click', () => menu.classList.remove('open'));
    menu.onclick = e => {
      const f = e.target.closest('[data-fmt]')?.dataset.fmt; if (!f) return; menu.classList.remove('open');
      if (f === 'csv') return csv(doc, cols, st.rows.filter(match), (o.title || 'data').replace(/[^\w-]+/g, '_') + '.csv');
      el.dispatchEvent(new CustomEvent('grid-export', { bubbles: true, detail: { format: f } }));
    };
    // Pop-out: the rows loaded so far go along; the window asks for more itself.
    box.querySelector('.dt-pop')?.addEventListener('click', () => popOut(el, box, o.title || doc.title.split(' · ')[0]));
    draw();
    if (!st.done) requestAnimationFrame(() => { if (wrap.scrollHeight <= wrap.clientHeight + NEAR) next(); });
  }

  function csv(doc, cols, rows, file) {
    const q = v => { v = text(v); return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
    const out = [cols.map(q).join(','), ...rows.map(r => r.map(q).join(','))].join('\r\n');
    const a = Object.assign(doc.createElement('a'), { href: URL.createObjectURL(new Blob([out], { type: 'text/csv' })), download: file });
    doc.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // Pop-out: the SAME table (its element, with its drop-downs, text boxes, handlers and loaded rows) moves into its own
  // window (ui/html/table-pop.html) and moves back here when that window closes. The page's own <style> rules go along.
  // UI.$ finds ids inside a popped-out window too. 'grid-popout' { open, win } is raised on el.
  function popOut(el, box, title) {
    const was = pops.get(el);
    if (was && !was.closed) return was.focus();
    const w = window.open(`${location.pathname.includes('/ui/html/') ? '' : 'ui/html/'}table-pop.html`, '_blank', 'popup,width=1100,height=700');
    if (!w) return UI.toast('The browser blocked the pop-out window. Allow pop-ups for this site.', 'err');
    pops.set(el, w);
    const doc = el.ownerDocument, note = Object.assign(doc.createElement('div'), { className: 'muted dt-popped', textContent: 'This table is open in its own window. Close that window to bring it back here.' });
    const h = box.style.height, mh = [...box.querySelectorAll('.table-wrap')].map(t => t.style.maxHeight);
    let back = false;
    const home = () => {
      if (back) return; back = true;
      pops.delete(el); el._popped = null; (window.DNPopped ||= new Set()).delete(w.document);
      const b = w.document.querySelector('#body > .pgrid') || box;   // the table now shown there (it may have been redrawn)
      b.style.height = h; b.querySelectorAll('.table-wrap').forEach((t, i) => t.style.maxHeight = mh[i] ?? '');
      note.remove(); el.append(b);
      el.dispatchEvent(new CustomEvent('grid-popout', { bubbles: true, detail: { open: false, win: w } }));
    };
    w.addEventListener('load', () => {
      const d = w.document, body = d.getElementById('body');
      doc.querySelectorAll('head style').forEach(s => d.head.append(s.cloneNode(true)));
      d.title = `${title} · Table`; d.getElementById('h').textContent = title;
      box.style.height = ''; box.querySelectorAll('.table-wrap').forEach(t => t.style.maxHeight = 'none');
      body.innerHTML = ''; body.append(box); el._popped = body; (window.DNPopped ||= new Set()).add(d);
      el.append(note);
      w.addEventListener('pagehide', home);
      el.dispatchEvent(new CustomEvent('grid-popout', { bubbles: true, detail: { open: true, win: w } }));
      w.focus();
    });
    const watch = setInterval(() => { if (w.closed) { clearInterval(watch); home(); } }, 400);
  }
  return { show, popOut, csv, PAGE };
})();
window.DataTable = DataTable;   // Transform draws through win.DataTable (this window or its pop-out)
