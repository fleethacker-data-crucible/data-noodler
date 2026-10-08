// SQL editor: multi-line text with line numbers, syntax colours, Tab / Shift+Tab indent, auto-indent on Enter,
// and completion of keywords, functions, tables and columns. No libraries: a textarea over a coloured <pre>.
// Global: SqlEditor.
//   const ed = SqlEditor.mount(el, { onChange(text), words() -> { tables: [..], columns: [..] },
//                                    check(text) -> Promise<[{ pos, end, line, message }]>, onCheck(errors) })
//   check runs 400 ms after typing stops; errors are underlined (wavy red) and their line numbers turn red.
//   ed.value / ed.value = 'SELECT *\nFROM t'   ed.insert(text)   ed.focus()
const SqlEditor = (() => {
  const KW = ('select from where group by having order limit offset join inner left right full outer cross on using as and or not in is null ' +
    'between like ilike case when then else end distinct all union with asc desc nulls first last cast try_cast true false exclude filter over ' +
    'partition rows range describe').split(' ');
  const FN = ('count sum avg mean min max any_value first last string_agg median quantile_cont stddev variance count_if bool_and bool_or ' +
    'row_number rank dense_rank lag lead first_value last_value ntile coalesce ifnull nullif greatest least abs round floor ceil sqrt ln log ' +
    'exp pow power mod lower upper length trim ltrim rtrim substr substring left right replace concat concat_ws contains starts_with ends_with ' +
    'strpos split_part lpad rpad regexp_matches regexp_replace regexp_extract year month day quarter dayofweek hour minute second date_part ' +
    'date_trunc date_add date_diff strftime strptime make_date last_day today now hash choose add_seconds if typeof read_parquet read_csv read_sqlite range').split(' ');
  const TYPES = 'varchar bigint integer int smallint tinyint double decimal date timestamp boolean'.split(' ');
  const KWS = new Set(KW), FNS = new Set(FN), TYS = new Set(TYPES);
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const IND = '    ';

  // lang 'json': JSON colours, no completion.
  function mount(el, { onChange = () => {}, words = () => ({ tables: [], columns: [] }), lang = 'sql', check = null, onCheck = () => {} } = {}) {
    el.classList.add('sqled');
    el.innerHTML = `<div class="sqled-gut"></div><div class="sqled-body"><pre class="sqled-hl" aria-hidden="true"></pre>` +
      `<textarea class="sqled-ta" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" wrap="off"></textarea></div><div class="sqled-pop" hidden></div>`;
    const ta = el.querySelector('textarea'), hl = el.querySelector('.sqled-hl'), gut = el.querySelector('.sqled-gut'), pop = el.querySelector('.sqled-pop');
    let items = [], pick = 0, chosen = false;   // chosen: user moved through the list (then Enter accepts)
    let errs = [], checkT, checkSeq = 0;
    // Live check: the latest answer wins; edits clear the marks until the next answer.
    function runCheck() {
      if (!check) return;
      clearTimeout(checkT);
      checkT = setTimeout(async () => {
        const text = ta.value, seq = ++checkSeq;
        let r = [];
        try { r = await check(text) || []; } catch { r = []; }
        if (seq !== checkSeq || text !== ta.value) return;
        errs = r; paint(); onCheck(errs);
      }, 400);
    }

    function paintJson(t) {
      let out = '', m;
      const re = /("(?:[^"\\]|\\.)*"?)(\s*:)?|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|\b(true|false|null)\b|([\s\S])/g;
      while ((m = re.exec(t))) {
        const [s, str, colon, num, lit] = m;
        if (str) out += `<span class="${colon ? 't-kw' : 't-str'}">${esc(str)}</span>${colon || ''}`;
        else if (num) out += `<span class="t-num">${s}</span>`;
        else if (lit) out += `<span class="t-fn">${s}</span>`;
        else out += esc(s);
      }
      return out;
    }
    function paint() {
      if (lang === 'json') {
        hl.innerHTML = paintJson(ta.value) + '\n';
        gut.innerHTML = Array.from({ length: ta.value.split('\n').length }, (_, i) => i + 1).join('<br>');
        return sync();
      }
      const t = ta.value, tables = new Set(words().tables.map(x => x.toLowerCase()));
      const marks = errs.filter(e => e.pos >= 0), badLines = new Set(errs.map(e => e.line).filter(Boolean));
      let out = '', m;
      const re = /(--[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|('(?:[^']|'')*'?)|("(?:[^"]|"")*"?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|([\s\S])/g;
      while ((m = re.exec(t))) {
        const [s, com, str, qid, num, id] = m;
        let h;
        if (com) h = `<span class="t-com">${esc(s)}</span>`;
        else if (str) h = `<span class="t-str">${esc(s)}</span>`;
        else if (qid) h = `<span class="t-id">${esc(s)}</span>`;
        else if (num) h = `<span class="t-num">${s}</span>`;
        else if (id) {
          const w = id.toLowerCase(), next = t.slice(re.lastIndex).match(/^\s*\(/);
          h = KWS.has(w) ? `<span class="t-kw">${s}</span>` : FNS.has(w) && next ? `<span class="t-fn">${s}</span>` : TYS.has(w) ? `<span class="t-ty">${s}</span>` : tables.has(w) ? `<span class="t-tb">${s}</span>` : esc(s);
        } else h = esc(s);
        const a = m.index, b = a + s.length;
        out += marks.some(e => e.pos < b && (e.end > a || e.pos === a)) && s.trim() ? `<span class="t-err">${h}</span>` : h;
      }
      if (marks.some(e => e.pos >= t.length)) out += '<span class="t-err"> </span>';
      hl.innerHTML = out + '\n';
      const n = t.split('\n').length;
      gut.innerHTML = Array.from({ length: n }, (_, i) => badLines.has(i + 1) ? `<span class="bad">${i + 1}</span>` : i + 1).join('<br>');
      sync();
    }
    function sync() { hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft; gut.scrollTop = ta.scrollTop; }

    // Replace selection with text, keeping browser undo.
    let quiet = false;
    function insert(text) { ta.focus(); quiet = true; try { if (!document.execCommand('insertText', false, text)) ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end'); } finally { quiet = false; } changed(); }
    function changed() { if (errs.length) { errs = []; onCheck(errs); } paint(); onChange(ta.value); runCheck(); }

    function lineStart(pos) { return ta.value.lastIndexOf('\n', pos - 1) + 1; }
    function indentLines(out) {
      const v = ta.value, a = lineStart(ta.selectionStart), b = ta.selectionEnd;
      const block = v.slice(a, b), lines = block.split('\n');
      const done = lines.map(l => out ? l.replace(/^( {1,4}|\t)/, '') : IND + l).join('\n');
      ta.setSelectionRange(a, b); insert(done); ta.setSelectionRange(a, a + done.length);
    }

    // ---- completion ----
    function wordAt() { const v = ta.value, p = ta.selectionStart; let a = p; while (a > 0 && /[A-Za-z0-9_]/.test(v[a - 1])) a--; return { a, w: v.slice(a, p) }; }
    function caretXY() {
      const v = ta.value.slice(0, ta.selectionStart), lines = v.split('\n'), cs = getComputedStyle(ta);
      const lh = parseFloat(cs.lineHeight) || 20, cw = measure(cs), padL = parseFloat(cs.paddingLeft), padT = parseFloat(cs.paddingTop);
      return { x: padL + lines[lines.length - 1].length * cw - ta.scrollLeft + gut.offsetWidth, y: padT + lines.length * lh - ta.scrollTop };
    }
    let cwCache = 0;
    function measure(cs) {
      if (cwCache) return cwCache;
      const s = document.createElement('span'); s.style.font = cs.font; s.style.position = 'absolute'; s.style.visibility = 'hidden'; s.textContent = 'M'.repeat(50);
      document.body.append(s); cwCache = s.getBoundingClientRect().width / 50; s.remove(); return cwCache;
    }
    function suggest(force) {
      if (lang === 'json') return;
      const { w } = wordAt();
      if (w.length < (force ? 1 : 2) || /^\d/.test(w)) return close();
      const lw = w.toLowerCase(), wd = words(), seen = new Set();
      const all = [...wd.tables.map(t => [t, 'table']), ...wd.columns.map(c => [c, 'column']), ...KW.map(k => [k.toUpperCase(), 'keyword']), ...FN.map(f => [f, 'function'])];
      items = all.filter(([t]) => { const k = t.toLowerCase(); if (!k.startsWith(lw) || k === lw || seen.has(k)) return false; seen.add(k); return true; }).slice(0, 12);
      if (!items.length) return close();
      pick = 0; chosen = !!force; renderPop();
      const { x, y } = caretXY(); pop.style.left = Math.max(0, x) + 'px'; pop.style.top = y + 'px'; pop.hidden = false;
    }
    function renderPop() { pop.innerHTML = items.map(([t, k], i) => `<div class="${i === pick ? 'sel' : ''}" data-i="${i}"><span>${esc(t)}</span><small>${k}</small></div>`).join(''); }
    function close() { pop.hidden = true; items = []; }
    function accept(i = pick) {
      const it = items[i]; if (!it) return;
      const { a } = wordAt(); ta.setSelectionRange(a, ta.selectionStart);
      insert(it[1] === 'function' ? it[0] + '(' : it[0]); close();
    }
    pop.addEventListener('mousedown', ev => { const d = ev.target.closest('[data-i]'); if (d) { ev.preventDefault(); accept(+d.dataset.i); } });

    ta.addEventListener('keydown', ev => {
      if (!pop.hidden) {
        if (ev.key === 'ArrowDown') { ev.preventDefault(); chosen = true; pick = (pick + 1) % items.length; return renderPop(); }
        if (ev.key === 'ArrowUp') { ev.preventDefault(); chosen = true; pick = (pick - 1 + items.length) % items.length; return renderPop(); }
        if (ev.key === 'Tab' || (ev.key === 'Enter' && chosen)) { ev.preventDefault(); return accept(); }
        if (ev.key === 'Enter') close();
        if (ev.key === 'Escape') { ev.preventDefault(); return close(); }
      }
      if (ev.key === 'Tab') {
        ev.preventDefault();
        if (ev.shiftKey || ta.value.slice(ta.selectionStart, ta.selectionEnd).includes('\n')) indentLines(ev.shiftKey);
        else insert(IND);
      } else if (ev.key === 'Enter' && !ev.ctrlKey) {
        ev.preventDefault();
        const line = ta.value.slice(lineStart(ta.selectionStart), ta.selectionStart), ind = line.match(/^[ \t]*/)[0];
        insert('\n' + ind + ((lang === 'json' ? /[{[]\s*$/ : /\(\s*$/).test(line) ? IND : ''));
      } else if (ev.key === ' ' && ev.ctrlKey) { ev.preventDefault(); suggest(true); }
    });
    ta.addEventListener('input', ev => { if (quiet) return; changed(); if (ev.inputType && ev.inputType.startsWith('insert') && ev.data && /[A-Za-z0-9_]/.test(ev.data)) suggest(); else close(); });
    ta.addEventListener('scroll', sync);
    ta.addEventListener('blur', () => setTimeout(close, 150));
    ta.addEventListener('click', close);
    paint();

    return {
      get value() { return ta.value; },
      set value(v) { ta.value = v || ''; close(); errs = []; onCheck(errs); paint(); runCheck(); },
      recheck: runCheck,
      insert, focus: () => ta.focus(), refresh: paint,
    };
  }
  return { mount };
})();
