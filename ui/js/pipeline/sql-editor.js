// SQL editor: multi-line text with line numbers, syntax colours, Tab / Shift+Tab indent, auto-indent on Enter,
// and completion of keywords, functions, tables and columns. No libraries: a textarea over a coloured <pre>.
// Global: SqlEditor.
//   const ed = SqlEditor.mount(el, { onChange(text), words() -> { tables: [..], columns: [..], fields: { TABLE: [cols] } },
//                                    check(text) -> Promise<[{ pos, end, line, message }]>, onCheck(errors) })
//   check runs 400 ms after typing stops. On the caret's line, while it has an error, the statement is dark grey and the
//     error dark orange (flashes twice when it turns orange). Off the caret's line an error is dark red (flashes twice when
//     it turns red). Fixed: the highlight flashes green twice and fades out. Hover a highlight for its message.
//   Suggestions from the first letter typed (fields / datasets white, SQL keywords / functions blue); Ctrl+Space lists
//   everything. Typing "name." (a table, or an alias from FROM / JOIN) lists its fields, narrowed as you type.
//   ed.value / ed.value = 'SELECT *\nFROM t'   ed.insert(text)   ed.focus()
//   lang 'js' (D3 Studio): the same error marks and flashes; complete({ text, pos, word, dot, force }) -> [[text, kind, info]]
//     gives the suggestions (after a letter or a dot), hover(text, pos) -> info text for the word under the mouse,
//     vars() -> Set of the page's own variable names (purple), d3names() -> Set of D3 exports (d3.<name> blue).
//   readOnly: shown and coloured, not editable (D3 Studio's generated variables).
const SqlEditor = (() => {
  // Oracle SQL (.claude/docs/SQL_DIALECT.md): keywords, functions and types.
  const KW = ('select distinct unique all from where group by having order asc desc nulls first last offset fetch next rows row only ' +
    'join inner left right full outer cross on using as and or not in is null between like escape exists any some case when then else end ' +
    'union intersect minus with rollup cube grouping sets pivot for over partition dual rownum true false interval year month day hour ' +
    'minute second cast conversion error within sysdate systimestamp current_date current_timestamp sqlerrm sqlcode ' +
    'create global temporary table view force noforce read check option index bitmap replace drop cascade constraints purge ' +
    'if insert into values update set delete truncate merge matched alter add modify column rename to constraint primary key foreign ' +
    'references default generated always identity commit rollback begin exception others raise execute immediate prompt describe').split(' ');
  const FN = ('abs ceil floor round trunc mod remainder power sqrt exp ln log sign sin cos tan asin acos atan atan2 sinh cosh tanh bitand greatest least ' +
    'lower upper initcap length substr instr replace translate concat lpad rpad ltrim rtrim trim chr ascii reverse soundex ' +
    'regexp_like regexp_substr regexp_replace regexp_instr regexp_count nvl nvl2 nullif coalesce decode lnnvl ' +
    'to_char to_date to_timestamp to_number add_months months_between last_day next_day extract ' +
    'ora_hash count sum avg min max median stddev stddev_samp stddev_pop variance var_samp var_pop any_value approx_count_distinct stats_mode ' +
    'listagg percentile_cont percentile_disc row_number rank dense_rank percent_rank cume_dist ntile lag lead first_value last_value ' +
    'raise_application_error read_dataset read_parquet range').split(' ');
  const TYPES = 'varchar2 nvarchar2 varchar char nchar clob nclob number integer int smallint decimal numeric float binary_float binary_double real double precision date timestamp boolean'.split(' ');
  const KWS = new Set(KW), FNS = new Set(FN), TYS = new Set(TYPES);
  // Words that can follow a table name but are not its alias.
  const NOT_ALIAS = new Set([...KW, 'natural', 'unpivot', 'set', 'values', 'start', 'connect', 'model']);
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const IND = '    ';
  const isW = c => /[A-Za-z0-9_]/.test(c || '');

  // lang 'json' / 'js': JSON or JavaScript colours, no completion.
  function mount(el, { onChange = () => {}, words = () => ({ tables: [], columns: [] }), lang = 'sql', check = null, onCheck = () => {}, complete = null, hover = null, vars = null, d3names = null, readOnly = false } = {}) {
    el.classList.add('sqled');
    el.innerHTML = `<div class="sqled-gut"></div><div class="sqled-body"><pre class="sqled-hl" aria-hidden="true"></pre>` +
      `<textarea class="sqled-ta" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" wrap="off"></textarea></div><div class="sqled-pop" hidden></div><div class="sqled-tip" hidden></div>` +
      `<div class="sqled-find" hidden><input class="f-q" type="text" placeholder="Find" spellcheck="false">` +
      `<button type="button" class="f-case" title="Match case">Aa</button><button type="button" class="f-prev" title="Previous (Shift+Enter)">&#8593;</button>` +
      `<button type="button" class="f-next" title="Next (Enter)">&#8595;</button><span class="f-n"></span>` +
      `<input class="f-r" type="text" placeholder="Replace" spellcheck="false"><button type="button" class="f-one" title="Replace this match (Enter)">Replace</button>` +
      `<button type="button" class="f-all" title="Replace every match">All</button><button type="button" class="f-x" title="Close (Esc)">&#215;</button></div>`;
    if (readOnly) el.classList.add('ro');
    const ta = el.querySelector('textarea'), hl = el.querySelector('.sqled-hl'), gut = el.querySelector('.sqled-gut'), pop = el.querySelector('.sqled-pop'), tip = el.querySelector('.sqled-tip');
    if (readOnly) ta.readOnly = true;
    let items = [], pick = 0, chosen = false;   // chosen: user moved through the list (then Enter accepts)
    let errs = [], checkT, checkSeq = 0;
    const was = new Map();   // line -> error state at the last paint ('warn' | 'bad'): a change flashes
    let flashes = [];        // { a, b, cls, until }: orange / red double flash, green double flash + fade
    let flashT;

    // Live check: the latest answer wins. Until it comes, the old marks follow the edits (see shift()).
    function runCheck() {
      if (!check) return;
      clearTimeout(checkT);
      checkT = setTimeout(async () => {
        const text = ta.value, seq = ++checkSeq;
        let r = [];
        try { r = await check(text) || []; } catch { r = []; }
        if (seq !== checkSeq || text !== ta.value) return;
        // A line whose errors are gone now was corrected: its old highlights flash green twice and fade out.
        const lines = new Set(r.filter(e => e.pos >= 0).map(e => lineOf(text, span(text, e)[0])));
        for (const m of marks) if (!lines.has(lineOf(text, m.a)) && m.b > m.a) { flash(m.a, m.b, 't-ok', 1150); was.delete(lineOf(text, m.a)); }
        errs = r; paint(); onCheck(errs);
      }, 400);
    }

    const lineOf = (t, p) => t.slice(0, p).split('\n').length;
    // The whole word an error points at (the word before it when it points at a space or the end).
    function span(t, e) {
      let a = Math.min(Math.max(0, e.pos), t.length), b = Math.min(Math.max(e.end || a, a), t.length);
      if (!isW(t[a]) && !(a > 0 && isW(t[a - 1]))) { if (b > a && t.slice(a, b).trim()) return [a, b]; let p = a; while (p > 0 && /[ \t]/.test(t[p - 1])) p--; a = b = p; }
      while (a > 0 && isW(t[a - 1])) a--;
      while (b < t.length && isW(t[b])) b++;
      if (b === a) b = Math.min(t.length, a + 1);
      return [a, b];
    }
    // Where the caret is decides the colour: on the error's line = orange (still working on it), elsewhere = red.
    const caretLine = t => ta.ownerDocument.activeElement === ta ? lineOf(t, ta.selectionStart) : -1;   // ownerDocument: the editor may sit in a pop-out window
    function stateOf(t, a) { return lineOf(t, a) === caretLine(t) ? 'warn' : 'bad'; }
    function flash(a, b, cls, ms) {
      flashes.push({ a, b, cls, until: Date.now() + ms });
      clearTimeout(flashT); flashT = setTimeout(() => { flashes = flashes.filter(f => f.until > Date.now()); paint(); }, ms + 20);
    }

    // Tokens per language: [[index, text, html]]. The error / flash / statement colours are added on top (paint()).
    function tokJson(t) {
      const out = [], re = /("(?:[^"\\]|\\.)*"?)(\s*:)?|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|\b(true|false|null)\b|([\s\S])/g;
      let m;
      while ((m = re.exec(t))) {
        const [s, str, colon, num, lit] = m;
        if (str) { out.push([m.index, str, `<span class="${colon ? 't-kw' : 't-str'}">${esc(str)}</span>`]); if (colon) out.push([m.index + str.length, colon, colon]); }
        else out.push([m.index, s, num ? `<span class="t-num">${s}</span>` : lit ? `<span class="t-fn">${s}</span>` : esc(s)]);
      }
      return out;
    }
    const JS_KW = new Set('const let var function return if else for while do switch case break continue new this typeof instanceof of in class extends async await try catch finally throw default import export delete void yield'.split(' '));
    // JS: keywords blue, d3 green, d3.<name> blue (left white when D3 has no such name), the chart's own variables (vars()) purple.
    function tokJs(t) {
      const out = [], v = vars ? vars() : null, api = d3names ? d3names() : null;
      const re = /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([A-Za-z_$][\w$]*)|([\s\S])/g;
      // The two code tokens before this one (comments and spaces skipped): "x." / "d3." before a word makes it a property.
      // (Not the raw text: a comment ending in a full stop must not turn the next line's const into a property.)
      let m, p1 = '', p2 = '';
      while ((m = re.exec(t))) {
        const [s, com, str, num, word] = m;
        let h;
        if (com) h = `<span class="t-com">${esc(com)}</span>`;
        else if (str) h = `<span class="t-str">${esc(str)}</span>`;
        else if (num) h = `<span class="t-num">${s}</span>`;
        else if (word) {
          const dotted = p1 === '.', afterD3 = dotted && p2 === 'd3';
          h = JS_KW.has(word) && !dotted ? `<span class="t-kw">${word}</span>` : /^(true|false|null|undefined)$/.test(word) ? `<span class="t-fn">${word}</span>`
            : word === 'd3' && !dotted ? `<span class="t-tb">${word}</span>` : afterD3 && api ? (api.has(word) ? `<span class="t-fn">${word}</span>` : esc(word))
            : !dotted && v && v.has(word) ? `<span class="t-ty">${word}</span>` : esc(word);
        } else h = esc(s);
        out.push([m.index, s, h]);
        if (!com && s.trim()) { p2 = p1; p1 = s; }
      }
      return out;
    }
    function tokSql(t) {
      // Source tables and their aliases (FROM / JOIN name [AS] alias) are coloured as tables (green).
      const tables = new Set([...words().tables.map(x => x.toLowerCase()), ...aliases(words().fields || {}).keys()]);
      // Field names in a SELECT list (SELECT ... FROM) are white even when the name is also a keyword / function (DATE, LEVEL):
      // a known column not followed by "(", or any name right after "t.".
      const cols = new Set((words().columns || []).map(x => x.toLowerCase()));
      let inSel = false;
      const out = [], re = /(--[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|('(?:[^']|'')*'?)|("(?:[^"]|"")*"?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|([\s\S])/g;
      let m;
      while ((m = re.exec(t))) {
        const [s, com, str, qid, num, id] = m;
        let h;
        if (com) h = `<span class="t-com">${esc(s)}</span>`;
        else if (str) h = `<span class="t-str">${esc(s)}</span>`;
        else if (qid) h = `<span class="t-id">${esc(s)}</span>`;
        else if (num) h = `<span class="t-num">${s}</span>`;
        else if (id) {
          const w = id.toLowerCase(), next = t.slice(re.lastIndex).match(/^\s*\(/);
          if (w === 'select') inSel = true; else if (w === 'from') inSel = false;
          const dotted = /\.\s*$/.test(t.slice(Math.max(0, m.index - 4), m.index));
          if (inSel && w !== 'select' && !next && (cols.has(w) || dotted)) h = esc(s);
          else h = KWS.has(w) ? `<span class="t-kw">${s}</span>` : FNS.has(w) && next ? `<span class="t-fn">${s}</span>` : TYS.has(w) ? `<span class="t-ty">${s}</span>` : tables.has(w) ? `<span class="t-tb">${s}</span>` : esc(s);
        } else h = esc(s);
        out.push([m.index, s, h]);
      }
      return out;
    }
    let marks = [];   // { a, b, st, msg } for this paint (hover reads it)
    // The same for every language: on the caret's line an error is dark orange (its statement dark grey), elsewhere dark red;
    // turning orange / red flashes that colour twice, a fixed error flashes green twice and fades out.
    function paint() {
      const t = ta.value;
      marks = errs.filter(e => e.pos >= 0).map(e => { const [a, b] = span(t, e); return { a, b, st: stateOf(t, a), msg: e.message }; });
      // A line that turns orange or red flashes that colour twice (per line, so typing on an orange line does not keep flashing).
      const lineSt = new Map(); for (const m of marks) lineSt.set(lineOf(t, m.a), m.st);
      for (const m of marks) { const L = lineOf(t, m.a); if (was.get(L) !== m.st) flash(m.a, m.b, m.st === 'warn' ? 't-flash-warn' : 't-flash-bad', 950); }
      for (const [L] of lineSt) was.delete(L);
      for (const [L, st] of lineSt) was.set(L, st);
      // The caret's line while it has an error: the statement on it (from its first non-blank character) in dark grey.
      const cl = caretLine(t);
      let sA = -1, sB = -1;
      if (cl > 0 && lineSt.has(cl)) {
        const ls = t.split('\n').slice(0, cl - 1).reduce((n, l) => n + l.length + 1, 0), le = t.indexOf('\n', ls) < 0 ? t.length : t.indexOf('\n', ls);
        sA = ls + (t.slice(ls, le).match(/^\s*/)[0].length); sB = le;
      }
      const now = Date.now(), fl = flashes.filter(f => f.until > now);
      const badLines = new Set(marks.filter(m => m.st === 'bad').map(m => lineOf(t, m.a)));
      const cls = (a, b) => {
        const mk = marks.find(x => x.a < b && x.b > a), f = fl.find(x => x.a < b && x.b > a);
        return [a < sB && b > sA && 't-stmt', mk && 't-err-' + mk.st, f && f.cls].filter(Boolean).join(' ');
      };
      // Plain colouring first, then error / flash spans around each token (so words stay whole).
      let out = '';
      for (const [i, s, h] of (lang === 'sql' ? tokSql : lang === 'js' ? tokJs : tokJson)(t)) {
        const c = s === '\n' ? '' : s.trim() ? cls(i, i + s.length) : (i < sB && i >= sA ? 't-stmt' : '');   // spaces: only the statement grey
        out += c ? `<span class="${c}">${h}</span>` : h;
      }
      hl.innerHTML = findMarks() + out + '\n';
      gut.innerHTML = Array.from({ length: t.split('\n').length }, (_, i) => badLines.has(i + 1) ? `<span class="bad">${i + 1}</span>` : i + 1).join('<br>');
      sync();
    }
    function sync() { hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft; gut.scrollTop = ta.scrollTop; }

    // Replace selection with text, keeping browser undo.
    let quiet = false, prev = '';
    function insert(text) { ta.focus(); quiet = true; try { if (!ta.ownerDocument.execCommand('insertText', false, text)) ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end'); } finally { quiet = false; } changed(); }
    // Old error positions follow the edit until the next check answers.
    function shift() {
      const v = ta.value, d = v.length - prev.length;
      let p = 0; while (p < v.length && p < prev.length && v[p] === prev[p]) p++;
      prev = v;
      if (!d) return;
      for (const e of errs) {
        if (e.pos < 0) continue;
        if (e.pos >= p) { e.pos = Math.max(p, e.pos + d); e.end = Math.max(e.pos, (e.end || e.pos) + d); }
        else if ((e.end || e.pos) >= p) e.end = Math.max(e.pos, e.end + d);
      }
    }
    function changed() { shift(); paint(); onChange(ta.value); runCheck(); }

    function lineStart(pos) { return ta.value.lastIndexOf('\n', pos - 1) + 1; }
    function indentLines(out) {
      const v = ta.value, a = lineStart(ta.selectionStart), b = ta.selectionEnd;
      const block = v.slice(a, b), lines = block.split('\n');
      const done = lines.map(l => out ? l.replace(/^( {1,4}|\t)/, '') : IND + l).join('\n');
      ta.setSelectionRange(a, b); insert(done); ta.setSelectionRange(a, a + done.length);
    }
    // Ctrl+/: comment / uncomment the caret's line (or every selected line): '//' in JS, '--' in SQL. The caret stays put.
    function toggleComment() {
      const mark = lang === 'js' ? '//' : lang === 'sql' ? '--' : null; if (!mark) return;
      const v = ta.value, s = ta.selectionStart, e = ta.selectionEnd, a = lineStart(s);
      let b = v.indexOf('\n', e > s && v[e - 1] === '\n' ? e - 1 : e); if (b < 0) b = v.length;
      const lines = v.slice(a, b).split('\n'), used = lines.filter(l => l.trim());
      const off = used.length && used.every(l => l.trimStart().startsWith(mark));
      const ind = Math.min(...used.map(l => l.match(/^[ \t]*/)[0].length), Infinity);
      const done = lines.map(l => !l.trim() ? l : off ? l.replace(new RegExp(`^([ \\t]*)${mark.replace(/\//g, '\\/')} ?`), '$1') : l.slice(0, ind) + mark + ' ' + l.slice(ind)).join('\n');
      const d = done.length - (b - a);
      ta.setSelectionRange(a, b); insert(done);
      if (e > s) ta.setSelectionRange(a, a + done.length); else { const p = Math.max(a, s + (lines.length === 1 ? d : 0)); ta.setSelectionRange(p, p); }
    }

    // ---- completion ----
    function wordAt() { const v = ta.value, p = ta.selectionStart; let a = p; while (a > 0 && isW(v[a - 1])) a--; return { a, w: v.slice(a, p) }; }
    function caretXY() {
      const v = ta.value.slice(0, ta.selectionStart), lines = v.split('\n'), cs = getComputedStyle(ta);
      const lh = parseFloat(cs.lineHeight) || 20, cw = measure(cs), padL = parseFloat(cs.paddingLeft), padT = parseFloat(cs.paddingTop);
      return { x: padL + lines[lines.length - 1].length * cw - ta.scrollLeft + gut.offsetWidth, y: padT + lines.length * lh - ta.scrollTop };
    }
    let cwCache = 0;
    function measure(cs) {
      if (cwCache) return cwCache;
      const d = ta.ownerDocument, s = d.createElement('span'); s.style.font = cs.font; s.style.position = 'absolute'; s.style.visibility = 'hidden'; s.textContent = 'M'.repeat(50);
      d.body.append(s); cwCache = s.getBoundingClientRect().width / 50; s.remove(); return cwCache;
    }
    // Table names and aliases in the SQL: FROM / JOIN / , name [AS] alias. Returns lower-case name or alias -> table.
    function aliases(fields) {
      const t = ta.value.replace(/--[^\n]*|\/\*[\s\S]*?(\*\/|$)|'(?:[^']|'')*'?/g, ' '), map = new Map();
      const byLower = new Map(Object.keys(fields).map(k => [k.toLowerCase(), k]));
      const re = /(\bfrom\b|\bjoin\b|,)\s*([A-Za-z_]\w*)(?:\s+(?:as\s+)?([A-Za-z_]\w*))?/gi;
      let m;
      while ((m = re.exec(t))) {
        const tb = byLower.get(m[2].toLowerCase()); if (!tb) continue;
        map.set(m[2].toLowerCase(), tb);
        if (m[3] && !NOT_ALIAS.has(m[3].toLowerCase())) map.set(m[3].toLowerCase(), tb);
      }
      for (const [k, v] of byLower) if (!map.has(k)) map.set(k, v);
      return map;
    }
    // After "x.": the fields of table / alias x, or null when x is not one.
    function dotFields() {
      const { a } = wordAt(), v = ta.value;
      if (v[a - 1] !== '.') return undefined;
      let q = a - 1; while (q > 0 && isW(v[q - 1])) q--;
      const name = v.slice(q, a - 1).toLowerCase(); if (!name) return null;
      const fields = words().fields || {}, tb = aliases(fields).get(name);
      return tb ? fields[tb] || [] : null;
    }
    // JS: complete({ text, pos, word, dot, force }) -> [[text, kind, info]] (the page knows its names: D3, the chart's variables).
    // From the first letter typed, and after a dot; Ctrl+Space lists everything here.
    function suggestJs(force) {
      if (!complete || readOnly) return close();
      const { a, w } = wordAt(), dot = ta.value[a - 1] === '.';
      if ((!w && !dot && !force) || /^\d/.test(w)) return close();
      const lw = w.toLowerCase(), seen = new Set();
      items = (complete({ text: ta.value, pos: a, word: w, dot, force }) || [])
        .filter(([t]) => { const k = t.toLowerCase(); if (!k.startsWith(lw) || t === w || seen.has(t)) return false; seen.add(t); return true; }).slice(0, 300);
      if (!items.length) return close();
      pick = 0; chosen = !!force; renderPop();
      const { x, y } = caretXY(); pop.style.left = Math.max(0, x) + 'px'; pop.style.top = y + 'px'; pop.hidden = false;
    }
    function suggest(force) {
      if (lang === 'js') return suggestJs(force);
      if (lang !== 'sql') return;
      const { w } = wordAt(), lw = w.toLowerCase(), df = dotFields();
      if (df !== undefined) {
        if (!df) return close();
        items = df.filter(c => c.toLowerCase().startsWith(lw) && c.toLowerCase() !== lw).sort((x, y) => x.localeCompare(y, undefined, { sensitivity: 'base' })).map(c => [c, 'field']);
      } else {
        // From the first letter typed; Ctrl+Space with nothing typed lists everything. Green (datasets, aliases), white (fields), blue (SQL).
        if ((!w && !force) || /^\d/.test(w)) return close();
        const wd = words(), seen = new Set(), abc = (x, y) => x[0].localeCompare(y[0], undefined, { sensitivity: 'base' });
        // Grouped by colour, each group A to Z: green (datasets, and aliases from FROM / JOIN), white (fields), blue (SQL).
        const tbl = new Set(wd.tables.map(t => t.toLowerCase()));
        const al = [...aliases(wd.fields || {}).keys()].filter(k => !tbl.has(k)).map(k => [k, 'alias']);
        const all = [...[...wd.tables.map(t => [t, 'dataset']), ...al].sort(abc), ...wd.columns.map(c => [c, 'column']).sort(abc),
          ...[...KW.map(k => [k.toUpperCase(), 'keyword']), ...FN.map(f => [f.toUpperCase(), 'function'])].sort(abc)];
        items = all.filter(([t]) => { const k = t.toLowerCase(); if (!k.startsWith(lw) || k === lw || seen.has(k)) return false; seen.add(k); return true; }).slice(0, 300);
      }
      if (!items.length) return close();
      pick = 0; chosen = !!force; renderPop();
      const { x, y } = caretXY(); pop.style.left = Math.max(0, x) + 'px'; pop.style.top = y + 'px'; pop.hidden = false;
    }
    // Fields white, datasets / aliases green, SQL keywords and functions blue (ui/css/theme.css .sqled-pop .sql / .tb).
    // JS kinds: keyword / function / method blue, d3 green, the chart's variables and fields white; the info text on the right.
    function renderPop() { pop.innerHTML = items.map(([t, k, info], i) => `<div class="${[i === pick && 'sel', ['keyword', 'function', 'method'].includes(k) && 'sql', ['dataset', 'alias', 'd3'].includes(k) && 'tb'].filter(Boolean).join(' ')}" data-i="${i}"><span>${esc(t)}</span><small>${esc(info || k)}</small></div>`).join(''); pop.querySelector('.sel')?.scrollIntoView({ block: 'nearest' }); }
    function close() { pop.hidden = true; items = []; }
    function accept(i = pick) {
      const it = items[i]; if (!it) return;
      const { a } = wordAt(); ta.setSelectionRange(a, ta.selectionStart);
      insert((it[1] === 'function' || it[1] === 'method') && ta.value[ta.selectionEnd] !== '(' ? it[0] + '(' : it[0]); close();
    }
    pop.addEventListener('mousedown', ev => { const d = ev.target.closest('[data-i]'); if (d) { ev.preventDefault(); accept(+d.dataset.i); } });

    // ---- error hover ----
    function posAt(ev) {
      const r = ta.getBoundingClientRect(), cs = getComputedStyle(ta);
      const lh = parseFloat(cs.lineHeight) || 20, cw = measure(cs);
      const row = Math.floor((ev.clientY - r.top - parseFloat(cs.paddingTop) + ta.scrollTop) / lh), col = Math.floor((ev.clientX - r.left - parseFloat(cs.paddingLeft) + ta.scrollLeft) / cw);
      const lines = ta.value.split('\n'); if (row < 0 || row >= lines.length || col < 0 || col >= lines[row].length) return -1;
      let p = 0; for (let i = 0; i < row; i++) p += lines[i].length + 1;
      return p + col;
    }
    ta.addEventListener('mousemove', ev => {
      const p = posAt(ev), mk = p >= 0 && marks.find(x => p >= x.a && p < x.b);
      // No error here: hover(text, pos) may explain the word under the mouse (D3 names in the D3 Studio).
      const info = !mk && p >= 0 && hover ? hover(ta.value, p) : null;
      if (!mk && !info) { tip.hidden = true; return; }
      tip.className = 'sqled-tip ' + (mk ? mk.st === 'bad' ? 'bad' : 'warn' : 'info'); tip.textContent = mk ? mk.msg : info; tip.hidden = false;
      const er = el.getBoundingClientRect();
      tip.style.left = Math.min(ev.clientX - er.left + 12, er.width - tip.offsetWidth - 4) + 'px'; tip.style.top = (ev.clientY - er.top + 18) + 'px';
    });
    ta.addEventListener('mouseleave', () => { tip.hidden = true; });

    ta.addEventListener('keydown', ev => {
      if (!pop.hidden) {
        if (ev.key === 'ArrowDown') { ev.preventDefault(); chosen = true; pick = (pick + 1) % items.length; return renderPop(); }
        if (ev.key === 'ArrowUp') { ev.preventDefault(); chosen = true; pick = (pick - 1 + items.length) % items.length; return renderPop(); }
        if (ev.key === 'Tab' || (ev.key === 'Enter' && chosen)) { ev.preventDefault(); return accept(); }
        if (ev.key === 'Enter') close();
        if (ev.key === 'Escape') { ev.preventDefault(); return close(); }
      }
      // Auto-close: ( [ { " ' type their closer with the cursor in between (a selection is wrapped); typing the closer
      // right before the same closer steps over it; Backspace between an empty pair deletes both.
      const PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" };
      if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && !ta.readOnly) {
        const a = ta.selectionStart, b = ta.selectionEnd, v = ta.value;
        if ((ev.key === ')' || ev.key === ']' || ev.key === '}' || ev.key === '"' || ev.key === "'") && a === b && v[a] === ev.key) {
          ev.preventDefault(); ta.setSelectionRange(a + 1, a + 1); return;
        }
        if (PAIRS[ev.key]) {
          const close = PAIRS[ev.key], q = ev.key === '"' || ev.key === "'";
          // a quote right after a letter / digit (e.g. it's) is typed alone
          if (!(q && a === b && a > 0 && /\w/.test(v[a - 1]))) {
            ev.preventDefault();
            const inner = v.slice(a, b);
            insert(ev.key + inner + close);
            ta.setSelectionRange(a + 1, a + 1 + inner.length);
            return;
          }
        }
        if (ev.key === 'Backspace' && a === b && a > 0 && PAIRS[v[a - 1]] && v[a] === PAIRS[v[a - 1]]) {
          ev.preventDefault(); ta.setSelectionRange(a - 1, a + 1); insert(''); return;
        }
      }
      if (ev.key === 'Tab') {
        ev.preventDefault();
        if (ev.shiftKey || ta.value.slice(ta.selectionStart, ta.selectionEnd).includes('\n')) indentLines(ev.shiftKey);
        else insert(IND);
      } else if (ev.key === 'Enter' && !ev.ctrlKey && !readOnly) {
        ev.preventDefault();
        const line = ta.value.slice(lineStart(ta.selectionStart), ta.selectionStart), ind = line.match(/^[ \t]*/)[0];
        insert('\n' + ind + ((lang === 'sql' ? /\(\s*$/ : /[{[(]\s*$/).test(line) ? IND : ''));
      } else if ((ev.key === ' ' || ev.code === 'Space') && ev.ctrlKey) { ev.preventDefault(); suggest(true); }
      else if ((ev.key === '/' || ev.code === 'Slash') && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); close(); toggleComment(); }
    });
    ta.addEventListener('input', ev => {
      if (quiet) return; changed();
      if (ev.inputType && ev.inputType.startsWith('insert') && ev.data && /[A-Za-z0-9_.$]/.test(ev.data)) suggest();
      else if (ev.inputType === 'deleteContentBackward' && !pop.hidden) suggest(); else close();
    });
    ta.addEventListener('scroll', sync);
    ta.addEventListener('blur', () => { setTimeout(close, 150); paint(); });
    ta.addEventListener('focus', paint);
    ta.addEventListener('click', close);
    // Caret moves (arrows, clicks) change the error colours.
    let lastCaret = -1;
    // Watched in whichever document the editor is in (it may be moved into a pop-out window).
    const watched = new WeakSet();
    const watchDoc = d => { if (watched.has(d)) return; watched.add(d); d.addEventListener('selectionchange', () => { if (d.activeElement === ta && ta.selectionStart !== lastCaret) { lastCaret = ta.selectionStart; if (errs.length) paint(); } }); };
    watchDoc(document); ta.addEventListener('focus', () => watchDoc(ta.ownerDocument));
    // ---- find / replace (Ctrl+F, Ctrl+H): matches boxed in the code (the current one brighter), scrolled into view ----
    const fb = el.querySelector('.sqled-find'), fq = fb.querySelector('.f-q'), fr = fb.querySelector('.f-r'), fn = fb.querySelector('.f-n');
    let found = [], cur = -1, matchCase = false;
    function findAll() {
      const q = fq.value; found = [];
      if (q && !fb.hidden) { const t = matchCase ? ta.value : ta.value.toLowerCase(), s = matchCase ? q : q.toLowerCase(); for (let p = t.indexOf(s); p >= 0; p = t.indexOf(s, p + s.length)) found.push(p); }
      if (cur >= found.length) cur = found.length - 1;
      fn.textContent = !q ? '' : found.length ? `${cur + 1} of ${found.length}` : 'No results';
      fn.classList.toggle('none', !!q && !found.length);
    }
    function findMarks() {
      if (fb.hidden || !found.length) return '';
      const cs = getComputedStyle(hl), lh = parseFloat(cs.lineHeight) || 20, cw = measure(cs), padT = parseFloat(cs.paddingTop) || 0, padL = parseFloat(cs.paddingLeft) || 0, n = fq.value.length, t = ta.value;
      return found.map((p, k) => { const ls = t.lastIndexOf('\n', p - 1) + 1, L = t.slice(0, p).split('\n').length;
        return `<div class="sqled-hit${k === cur ? ' cur' : ''}" style="top:${padT + (L - 1) * lh}px;left:${padL + (p - ls) * cw}px;width:${n * cw}px;height:${lh}px"></div>`; }).join('');
    }
    // Go to match k (wraps): select it in the code and scroll it into view.
    function goTo(k) {
      findAll(); if (!found.length) { paint(); return; }
      cur = (k + found.length) % found.length; findAll();
      const p = found[cur], t = ta.value, cs = getComputedStyle(hl), lh = parseFloat(cs.lineHeight) || 20, cw = measure(cs);
      const L = t.slice(0, p).split('\n').length, x = (p - t.lastIndexOf('\n', p - 1) - 1) * cw, y = (L - 1) * lh;
      ta.setSelectionRange(p, p + fq.value.length);
      if (y < ta.scrollTop || y > ta.scrollTop + ta.clientHeight - lh * 2) ta.scrollTop = Math.max(0, y - ta.clientHeight / 3);
      if (x < ta.scrollLeft || x > ta.scrollLeft + ta.clientWidth - 60) ta.scrollLeft = Math.max(0, x - 60);
      paint();
    }
    // From the caret: the first match at or after it.
    const fromCaret = () => { findAll(); const i = found.findIndex(p => p >= ta.selectionStart); return i < 0 ? 0 : i; };
    function openFind(replace) {
      const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
      fb.hidden = false; el.classList.add('finding');   // the code moves down two lines under the bar
      if (sel && !sel.includes('\n')) fq.value = sel;
      const box = replace ? fr : fq; box.focus(); box.select();
      cur = -1; if (fq.value) goTo(sel ? found.indexOf(ta.selectionStart) >= 0 ? found.indexOf(ta.selectionStart) : fromCaret() : fromCaret()); else { findAll(); paint(); }
    }
    function closeFind() { fb.hidden = true; el.classList.remove('finding'); found = []; paint(); ta.focus(); }
    function replaceOne() {
      findAll(); if (!found.length) return;
      if (cur < 0) return goTo(fromCaret());
      const p = found[cur]; ta.setSelectionRange(p, p + fq.value.length); insert(fr.value);
      findAll(); goTo(found.findIndex(x => x >= p + fr.value.length) < 0 ? 0 : found.findIndex(x => x >= p + fr.value.length));
      fr.focus();
    }
    function replaceAll() {
      findAll(); if (!found.length) return;
      const n = found.length, q = fq.value, t = ta.value;
      let out = '', last = 0; for (const p of found) { out += t.slice(last, p) + fr.value; last = p + q.length; } out += t.slice(last);
      ta.setSelectionRange(0, t.length); insert(out); ta.setSelectionRange(0, 0);   // one undo step
      cur = -1; findAll(); paint(); fn.textContent = `Replaced ${n}`; fr.focus();
    }
    fq.addEventListener('input', () => { cur = -1; goTo(fromCaret()); fq.focus(); });
    fb.querySelector('.f-next').onclick = () => goTo(cur + 1);
    fb.querySelector('.f-prev').onclick = () => goTo(cur - 1);
    fb.querySelector('.f-x').onclick = closeFind;
    fb.querySelector('.f-one').onclick = replaceOne;
    fb.querySelector('.f-all').onclick = replaceAll;
    fb.querySelector('.f-case').onclick = e => { matchCase = !matchCase; e.currentTarget.classList.toggle('on', matchCase); cur = -1; goTo(fromCaret()); fq.focus(); };
    fb.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return closeFind(); }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'h')) { e.preventDefault(); (e.key === 'h' ? fr : fq).focus(); return; }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (e.target === fr && !e.shiftKey) replaceOne(); else goTo(cur + (e.shiftKey ? -1 : 1));
      e.target.focus();
    });
    ta.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'f' || e.key === 'h')) { e.preventDefault(); openFind(e.key === 'h'); }
      else if (e.key === 'Escape' && !fb.hidden) { e.preventDefault(); closeFind(); }
    });
    ta.addEventListener('input', () => { if (!fb.hidden) { findAll(); paint(); } });
    // The browser can put text back into the box itself (page restore after F5 / Back) without an input event: then the
    // colours, the error check and the page's onChange would be for the old text. Catch up whenever that happened.
    const resync = () => { if (ta.value !== prev) changed(); };
    for (const ev of ['pageshow', 'load', 'focus']) addEventListener(ev, () => setTimeout(resync));
    setTimeout(resync); setTimeout(resync, 300);
    paint();

    return {
      get value() { return ta.value; },
      set value(v) { ta.value = v || ''; prev = ta.value; close(); errs = []; marks = []; was.clear(); onCheck(errs); paint(); runCheck(); },
      recheck: runCheck,
      insert, focus: () => ta.focus(), refresh: paint,
    };
  }
  return { mount };
})();
