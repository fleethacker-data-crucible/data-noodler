// Data Grid renderer (ui/js/grid/data-grid-pkg.js "renderer"): our own table, no ApexGrid. One real <table> inside one native
// scroller (like the app's schema tables), so vertical and sideways scrolling are the browser's own and the styling
// covers every column. Only the rows on screen (+ a margin) are in the page; they are redrawn in blocks of 10 rows.
// Its look: ui/js/grid/data-grid.css only. Global: DNGrid.
//   DNGrid.create(box, { names, columns, rows, remote, more, total, props, columnDefaults, popped, onPop }) -> grid
//     more(offset) -> { rows, done } (optional, local grids): the next block of rows near the end; total = all rows.
//     names = the column keys; columns = [{ name, type }] (types); rows = objects (local grid) or empty with
//     remote(grid, bar) = GridRemote.attach (rows come from the engine: grid.provider = { load(state), more(state, at) }).
//     props = spec options (showQuickFilter, showExport, exportFilename); columnDefaults = { sort, filter, resizable }.
//   grid.destroy() removes it; grid-export { format } is raised on the box for engine grids and .parquet / .sqlite.
window.DNGrid = (() => {
  const NUM = /INT|DOUBLE|FLOAT|DECIMAL|REAL|NUMERIC/i, BOOL = /BOOL/i;
  const OVER = 12, BLOCK = 10, NEAR = 30;   // rows drawn past each edge; redraw step; rows from the end that load the next block
  const esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const text = v => v == null ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
  const CONDS = {
    string: [['contains', 'Contains'], ['doesNotContain', 'Does not contain'], ['startsWith', 'Starts with'], ['endsWith', 'Ends with'],
      ['equals', 'Equals'], ['doesNotEqual', 'Does not equal'], ['empty', 'Empty'], ['notEmpty', 'Not empty']],
    number: [['equals', 'Equals'], ['doesNotEqual', 'Does not equal'], ['greaterThan', 'Greater than'], ['lessThan', 'Less than'],
      ['greaterThanOrEqual', 'Greater than or equal'], ['lessThanOrEqual', 'Less than or equal'], ['empty', 'Empty'], ['notEmpty', 'Not empty']],
    boolean: [['true', 'True'], ['false', 'False'], ['empty', 'Empty'], ['notEmpty', 'Not empty']] };
  const NOVAL = new Set(['empty', 'notEmpty', 'true', 'false']);

  // One filter on a local row value (the engine grids do the same in SQL: ui/js/grid/grid-remote.js).
  function test(v, f, type) {
    const c = f.condition, blank = v == null || v === '';
    if (c === 'empty') return blank;
    if (c === 'notEmpty') return !blank;
    if (c === 'true') return v === true || v === 'true';
    if (c === 'false') return v === false || v === 'false';
    const t = f.searchTerm;
    if (type === 'number' && t !== '' && !isNaN(+t) && !blank) {
      const n = +v, m = +t;
      return { equals: n === m, doesNotEqual: n !== m, greaterThan: n > m, lessThan: n < m, greaterThanOrEqual: n >= m, lessThanOrEqual: n <= m }[c] ?? true;
    }
    const s = text(v).toLowerCase(), q = String(t ?? '').toLowerCase();
    return { contains: s.includes(q), doesNotContain: !s.includes(q), startsWith: s.startsWith(q), endsWith: s.endsWith(q), equals: s === q, doesNotEqual: s !== q }[c] ?? true;
  }

  function create(box, o) {
    const doc = box.ownerDocument, win = doc.defaultView, props = o.props || {}, cd = o.columnDefaults || {};
    const canSort = cd.sort !== false, canFilter = cd.filter !== false, canResize = cd.resizable !== false;
    const typeOf = n => {
      const c = (o.columns || []).find(x => x.name === n);
      if (c) return NUM.test(c.type) ? 'number' : BOOL.test(c.type) ? 'boolean' : 'string';
      const v = (o.rows || []).find(r => r[n] != null)?.[n];
      return typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string';
    };
    const cols = (o.names || []).map(key => ({ key, type: typeOf(key), w: 0 }));
    const st = { sort: null, filters: new Map(), quick: '' };   // sort = { key, dir: 'asc' | 'desc' }
    let sized = !!(o.rows || []).length, view = [], total = 0, done = true, rowH = 0, headH = 0, w0 = -1, w1 = -1, seq = 0, loading = false, hover = null;
    const offs = [];   // remove on destroy

    // ---- layout: bar (search, readout, Pop-out, Export) + the scroller with the table ----
    box.classList.add('dn-grid-box'); box.innerHTML = '';
    const bar = doc.createElement('div'); bar.className = 'gbar';
    bar.innerHTML = (props.showQuickFilter !== false ? '<input class="search" type="search" placeholder="Search" spellcheck="false">' : '')
      + '<span class="grow muted"></span><span class="spacer"></span>'
      + (o.popped || !o.onPop ? '' : '<button class="ghost small gpop" title="Open this table in its own window">Pop-out</button>')
      + (props.showExport !== false ? `<div class="addwrap gexp"><button class="ghost small">Export ▾</button><div class="addmenu">${['csv', 'parquet', 'sqlite']
        .map(f => `<div data-fmt="${f}">.${f}</div>`).join('')}</div></div>` : '');
    const sc = doc.createElement('div'); sc.className = 'dg';
    sc.innerHTML = '<table class="dg-t"><colgroup></colgroup><thead><tr></tr></thead><tbody></tbody></table>';
    const menu = doc.createElement('div'); menu.className = 'gctx'; menu.hidden = true;
    box.append(bar, sc, menu);
    const table = sc.firstChild, colgroup = table.querySelector('colgroup'), headRow = table.querySelector('thead tr'), body = table.querySelector('tbody');
    const readout = bar.querySelector('.grow');
    const on = (t, ev, fn, opt) => { t.addEventListener(ev, fn, opt); offs.push(() => t.removeEventListener(ev, fn, opt)); };

    // ---- column widths: from the header and the first rows; Autosize measures with the cell font ----
    const meas = doc.createElement('canvas').getContext('2d');
    const fontOf = sel => { const e = table.querySelector(sel); return e ? getComputedStyle(e).font : getComputedStyle(sc).font; };
    function guess(c, rows) {
      let n = c.key.length * 1.15 + 3;
      for (let i = 0; i < Math.min(rows.length, 200); i++) n = Math.max(n, text(rows[i][c.key]).length);
      return Math.max(70, Math.min(320, Math.round(n * 7.6 + 24)));
    }
    function autosize(c) {
      meas.font = fontOf('thead th'); let w = meas.measureText(c.key).width;
      meas.font = fontOf('tbody td:not(.pad)');
      for (let i = 0; i < Math.min(view.length, 2000); i++) w = Math.max(w, meas.measureText(text(view[i][c.key])).width);
      c.w = Math.min(800, Math.ceil(w) + 28); widths();
    }
    function widths() {
      colgroup.innerHTML = cols.map(c => `<col style="width:${c.w}px">`).join('');
      table.style.width = `${cols.reduce((s, c) => s + c.w, 0)}px`;
    }
    function header() {
      headRow.innerHTML = cols.map((c, i) => {
        const s = st.sort?.key === c.key ? ` sorted-${st.sort.dir}` : '', f = st.filters.has(c.key) ? ' filtered' : '';
        return `<th data-i="${i}" class="${c.type === 'number' ? 'num' : ''}${s}${f}"><span class="ht">${esc(c.key)}</span>${canResize ? '<span class="rz"></span>' : ''}</th>`;
      }).join('');
    }

    // ---- rows on screen: blocks of BLOCK rows, OVER rows past each edge; spacer rows keep the full height ----
    const span = cols.length || 1;
    function rowsHtml(a, b) {
      let h = '';
      for (let i = a; i < b; i++) {
        const r = view[i]; h += `<tr data-i="${i}">`;
        for (const c of cols) { const v = r[c.key]; h += `<td${c.type === 'number' ? ' class="num"' : v == null ? ' class="null"' : ''}>${esc(text(v))}</td>`; }
        h += '</tr>';
      }
      return h;
    }
    function paint(force) {
      if (!rowH) {   // measure one real row once
        body.innerHTML = view.length ? rowsHtml(0, 1) : `<tr><td colspan="${span}">&nbsp;</td></tr>`;
        rowH = body.firstChild?.getBoundingClientRect().height || 34; headH = headRow.getBoundingClientRect().height || 0; w0 = w1 = -1;
      }
      const n = view.length, top = Math.max(0, sc.scrollTop - headH), vis = sc.clientHeight || 600;
      let a = Math.max(0, Math.floor(top / rowH) - OVER), b = Math.min(n, Math.ceil((top + vis) / rowH) + OVER);
      a = Math.floor(a / BLOCK) * BLOCK; b = Math.min(n, Math.ceil(b / BLOCK) * BLOCK);
      if (!force && a === w0 && b === w1) return;
      w0 = a; w1 = b;
      const pad = h => h > 0 ? `<tr class="pad"><td colspan="${span}" style="height:${h}px"></td></tr>` : '';
      body.innerHTML = pad(a * rowH) + rowsHtml(a, b) + pad((n - b) * rowH)
        + (n ? '' : `<tr class="none"><td colspan="${span}">${loading ? 'Loading…' : 'No rows'}</td></tr>`);
      if (!done && b >= n - NEAR) more();
    }
    let frame = 0;
    on(sc, 'scroll', () => { if (!frame) frame = win.requestAnimationFrame(() => { frame = 0; paint(false); }); }, { passive: true });
    on(win, 'resize', () => paint(false));

    // ---- data: local rows are searched / filtered / sorted here; engine grids ask grid.provider ----
    function local() {
      let out = o.rows || [];
      const q = st.quick.trim().toLowerCase();
      if (q) out = out.filter(r => cols.some(c => text(r[c.key]).toLowerCase().includes(q)));
      for (const [k, f] of st.filters) { const t = cols.find(c => c.key === k)?.type; out = out.filter(r => test(r[k], f, t)); }
      if (st.sort) {
        const { key, dir } = st.sort, num = cols.find(c => c.key === key)?.type === 'number', m = dir === 'desc' ? -1 : 1;
        out = out.slice().sort((x, y) => {
          const a = x[key], b = y[key];
          if (a == null || a === '') return b == null || b === '' ? 0 : 1;   // blanks last
          if (b == null || b === '') return -1;
          return m * (num ? a - b : text(a).localeCompare(text(b), undefined, { numeric: true, sensitivity: 'base' }));
        });
      }
      return out;
    }
    function show() {
      if (o.remote) readout.textContent = `${hover != null ? `Row ${(hover + 1).toLocaleString()}` : 'Row -'} of ${total.toLocaleString()} (${view.length.toLocaleString()} loaded)`;
      else {
        const all = (o.rows || []).length, N = x => x.toLocaleString(), paged = o.more && o.total != null && !localDone;
        const loaded = paged ? `${N(all)} of ${N(+o.total)} rows loaded` : `${N(all)} rows`;
        readout.textContent = view.length === all ? loaded : `${N(view.length)} matching · ${loaded}`;
      }
    }
    // Local grids with o.more (previews): more rows are fetched as the reader nears the end; done once all are in.
    let localDone = !o.more || (o.total != null && (o.rows || []).length >= o.total);
    async function reload(top = true) {
      header();
      if (top) sc.scrollTop = 0;
      if (!grid.provider) { view = local(); total = view.length; done = localDone; paint(true); show(); return; }
      const my = ++seq; loading = true; paint(true);
      try {
        const r = await grid.provider.load(st);
        if (my !== seq) return;
        view = r.rows; total = r.total; done = r.done;
        if (!sized && view.length) { sized = true; for (const c of cols) c.w = guess(c, view); widths(); }   // engine grids: widths from the first rows
      } finally { if (my === seq) loading = false; }
      paint(true); show();
    }
    // The next block of rows (engine grids: grid.provider; previews: o.more). The reading position stays: rows are added below.
    async function more() {
      if (loading || done) return;
      loading = true; const my = seq;
      try {
        if (grid.provider) {
          const r = await grid.provider.more(st, view.length);
          if (my !== seq) return;
          view = view.concat(r.rows); done = r.done;
        } else if (o.more) {
          const r = await o.more((o.rows || []).length);
          o.rows = (o.rows || []).concat(r.rows); localDone = done = r.done || !r.rows.length;
          view = local();
        } else return;
      } catch (e) { done = true; console.error(e); }
      finally { loading = false; }
      paint(true); show();
    }

    // ---- search box ----
    const input = bar.querySelector('input.search');
    if (input) { let t; on(input, 'input', () => { clearTimeout(t); t = setTimeout(() => { st.quick = input.value; reload(); }, o.remote ? 300 : 150); }); }

    // ---- row under the mouse (engine grids show "Row n of total"); once per frame ----
    let mf = 0, mt = null;
    on(body, 'mousemove', e => { mt = e.target; if (!mf) mf = win.requestAnimationFrame(() => { mf = 0; const tr = mt?.closest?.('tr[data-i]'); const i = tr ? +tr.dataset.i : null; if (i !== hover) { hover = i; if (o.remote) show(); } }); }, { passive: true });
    on(body, 'mouseleave', () => { hover = null; if (o.remote) show(); });

    // ---- wheel: smooth (each notch glides to its target instead of jumping). Ctrl = 4x faster vertically,
    // Shift = sideways (the app's rules). At an edge the wheel is left to the page. ----
    let tx = 0, ty = 0, cx = 0, cy = 0, glide = 0;
    const EASE = 0.22;   // share of the remaining distance per frame (higher = snappier)
    const stepGlide = () => {
      cx += (tx - cx) * EASE; cy += (ty - cy) * EASE;
      if (Math.abs(tx - cx) < 0.5 && Math.abs(ty - cy) < 0.5) { cx = tx; cy = ty; glide = 0; }
      sc.scrollLeft = cx; sc.scrollTop = cy;
      if (glide) glide = win.requestAnimationFrame(stepGlide);
    };
    on(sc, 'wheel', e => {
      if (e.defaultPrevented) return;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? sc.clientHeight : 1;
      let dx = e.deltaX * unit, dy = e.deltaY * unit;
      if (e.ctrlKey) dy *= 4;
      else if (e.shiftKey && !dx) { dx = dy; dy = 0; }
      if (!glide) { cx = tx = sc.scrollLeft; cy = ty = sc.scrollTop; }   // start from where the grid is now
      const mx = sc.scrollWidth - sc.clientWidth, my = sc.scrollHeight - sc.clientHeight;
      const nx = Math.max(0, Math.min(mx, tx + dx)), ny = Math.max(0, Math.min(my, ty + dy));
      if (nx === tx && ny === ty && !e.ctrlKey) return;   // nothing left to scroll here: the page scrolls
      e.preventDefault(); e.stopPropagation();
      tx = nx; ty = ny;
      if (!glide) glide = win.requestAnimationFrame(stepGlide);
    }, { passive: false });

    // ---- column resize: drag a header's right edge ----
    on(headRow, 'pointerdown', e => {
      const rz = e.target.closest('.rz'); if (!rz || e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      const c = cols[+rz.parentElement.dataset.i], x0 = e.clientX, w = c.w;
      rz.setPointerCapture(e.pointerId); rz.classList.add('on');
      const mv = ev => { c.w = Math.max(40, Math.round(w + ev.clientX - x0)); widths(); };
      const up = () => { rz.removeEventListener('pointermove', mv); rz.removeEventListener('pointerup', up); rz.classList.remove('on'); };
      rz.addEventListener('pointermove', mv); rz.addEventListener('pointerup', up);
    });
    on(headRow, 'dblclick', e => { const rz = e.target.closest('.rz'); if (rz) autosize(cols[+rz.parentElement.dataset.i]); });

    // ---- right-click a header: sort, autosize, then the filter (condition + value) right in the menu ----
    const close = () => { menu.hidden = true; };
    on(doc, 'pointerdown', e => { if (!menu.contains(e.target)) close(); }, true);
    on(win, 'blur', close); on(doc, 'keydown', e => { if (e.key === 'Escape') close(); });
    on(headRow, 'contextmenu', e => {
      const th = e.target.closest('th'); if (!th) return;
      e.preventDefault(); e.stopPropagation();   // the page's own right-click menu (e.g. the Dashboard widget menu) stays shut
      const c = cols[+th.dataset.i], cur = st.filters.get(c.key), conds = CONDS[c.type] || CONDS.string, cond = cur?.condition || conds[0][0];
      const h = [];
      if (canSort) h.push('<div data-act="asc">Sort ascending</div>', '<div data-act="desc">Sort descending</div>');
      h.push('<div data-act="size">Autosize column</div>');
      if (st.sort?.key === c.key) h.push('<div data-act="nosort">Clear sort</div>');
      if (canFilter) h.push('<hr>', `<div class="gflt"><select>${conds.map(([v, t]) => `<option value="${v}"${v === cond ? ' selected' : ''}>${t}</option>`).join('')}</select>`
        + `<input type="text" placeholder="Filter value" spellcheck="false" value="${esc(cur?.searchTerm)}"></div>`, `<div data-act="nofilter"${cur ? '' : ' class="off"'}>Clear filter</div>`);
      menu.innerHTML = h.join(''); menu.hidden = false;
      const r = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(4, Math.min(e.clientX, win.innerWidth - r.width - 4))}px`;
      menu.style.top = `${Math.max(4, Math.min(e.clientY, win.innerHeight - r.height - 4))}px`;
      const sel = menu.querySelector('.gflt select'), inp = menu.querySelector('.gflt input');
      if (sel) {
        let t;
        const apply = () => {
          const k = sel.value, v = inp.value; inp.disabled = NOVAL.has(k);
          if (NOVAL.has(k) || v !== '') st.filters.set(c.key, { condition: k, searchTerm: NOVAL.has(k) ? undefined : v }); else st.filters.delete(c.key);
          menu.querySelector('[data-act=nofilter]')?.classList.toggle('off', !st.filters.has(c.key));
          reload();
        };
        inp.disabled = NOVAL.has(sel.value);
        sel.onchange = apply; inp.oninput = () => { clearTimeout(t); t = setTimeout(apply, o.remote ? 300 : 150); };
        inp.onkeydown = ev => { if (ev.key === 'Enter') { clearTimeout(t); apply(); close(); } };
      }
      menu.onclick = ev => {
        const it = ev.target.closest('[data-act]'); if (!it || it.classList.contains('off')) return;
        const a = it.dataset.act; close();
        if (a === 'asc' || a === 'desc') { st.sort = { key: c.key, dir: a }; reload(); }
        else if (a === 'nosort') { st.sort = null; reload(); }
        else if (a === 'nofilter') { st.filters.delete(c.key); reload(); }
        else if (a === 'size') autosize(c);
      };
    });

    // ---- Pop-out / Export ----
    bar.querySelector('.gpop')?.addEventListener('click', e => { e.stopPropagation(); o.onPop?.({ rows: o.rows || [] }); });   // the rows loaded so far go along
    const ex = bar.querySelector('.gexp');
    if (ex) {
      const m = ex.querySelector('.addmenu');
      ex.querySelector('button').onclick = e => { e.stopPropagation(); m.classList.toggle('open'); };
      on(doc, 'click', () => m.classList.remove('open'));
      m.onclick = e => {
        const f = e.target.closest('[data-fmt]')?.dataset.fmt; if (!f) return; m.classList.remove('open');
        if (!o.remote && f === 'csv') return csv((props.exportFilename || 'data') + '.csv');
        box.dispatchEvent(new CustomEvent('grid-export', { bubbles: true, detail: { format: f } }));
      };
    }
    function csv(file) {
      const q = v => { v = text(v); return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
      const out = [cols.map(c => q(c.key)).join(','), ...view.map(r => cols.map(c => q(r[c.key])).join(','))].join('\r\n');
      const a = Object.assign(doc.createElement('a'), { href: URL.createObjectURL(new Blob([out], { type: 'text/csv' })), download: file });
      doc.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    // ---- start ----
    const grid = {
      provider: null, state: st,
      refresh: () => reload(false),
      destroy() { offs.forEach(f => f()); if (frame) win.cancelAnimationFrame(frame); if (glide) win.cancelAnimationFrame(glide); box.innerHTML = ''; },
    };
    for (const c of cols) c.w = guess(c, o.rows || []);
    widths(); header();
    if (o.remote) o.remote(grid, bar);
    reload();
    return grid;
  }
  return { create };
})();
