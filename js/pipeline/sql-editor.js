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
  // Words that can follow a table name but are not its alias.
  const NOT_ALIAS = new Set([...KW, 'natural', 'lateral', 'qualify', 'window', 'pivot', 'unpivot', 'intersect', 'except', 'set', 'values']);
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const IND = '    ';
  const isW = c => /[A-Za-z0-9_]/.test(c || '');

  // lang 'json' / 'js': JSON or JavaScript colours, no completion.
  function mount(el, { onChange = () => {}, words = () => ({ tables: [], columns: [] }), lang = 'sql', check = null, onCheck = () => {} } = {}) {
    el.classList.add('sqled');
    el.innerHTML = `<div class="sqled-gut"></div><div class="sqled-body"><pre class="sqled-hl" aria-hidden="true"></pre>` +
      `<textarea class="sqled-ta" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" wrap="off"></textarea></div><div class="sqled-pop" hidden></div><div class="sqled-tip" hidden></div>` +
      `<div class="sqled-find" hidden><input class="f-q" type="text" placeholder="Find" spellcheck="false">` +
      `<button type="button" class="f-case" title="Match case">Aa</button><button type="button" class="f-prev" title="Previous (Shift+Enter)">&#8593;</button>` +
      `<button type="button" class="f-next" title="Next (Enter)">&#8595;</button><span class="f-n"></span>` +
      `<input class="f-r" type="text" placeholder="Replace" spellcheck="false"><button type="button" class="f-one" title="Replace this match (Enter)">Replace</button>` +
      `<button type="button" class="f-all" title="Replace every match">All</button><button type="button" class="f-x" title="Close (Esc)">&#215;</button></div>`;
    const ta = el.querySelector('textarea'), hl = el.querySelector('.sqled-hl'), gut = el.querySelector('.sqled-gut'), pop = el.querySelector('.sqled-pop'), tip = el.querySelector('.sqled-tip');
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
    const caretLine = t => document.activeElement === ta ? lineOf(t, ta.selectionStart) : -1;
    function stateOf(t, a) { return lineOf(t, a) === caretLine(t) ? 'warn' : 'bad'; }
    function flash(a, b, cls, ms) {
      flashes.push({ a, b, cls, until: Date.now() + ms });
      clearTimeout(flashT); flashT = setTimeout(() => { flashes = flashes.filter(f => f.until > Date.now()); paint(); }, ms + 20);
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
    const JS_KW = new Set('const let var function return if else for while do switch case break continue new this typeof instanceof of in class extends async await try catch finally throw default import export delete void yield'.split(' '));
    // bad: [{ ta, tb }] error ranges, drawn dark grey (their whole line gets a dark red bar, see paint()).
    function paintJs(t, bad = []) {
      let out = '', m;
      const re = /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([A-Za-z_$][\w$]*)|([\s\S])/g;
      while ((m = re.exec(t))) {
        const [s, com, str, num, word] = m;
        let h;
        if (com) h = `<span class="t-com">${esc(com)}</span>`;
        else if (str) h = `<span class="t-str">${esc(str)}</span>`;
        else if (num) h = `<span class="t-num">${s}</span>`;
        else if (word) h = JS_KW.has(word) ? `<span class="t-kw">${word}</span>` : /^(true|false|null|undefined)$/.test(word) ? `<span class="t-fn">${word}</span>` : word === 'd3' ? `<span class="t-tb">${word}</span>` : esc(word);
        else h = esc(s);
        out += s !== '\n' && bad.some(x => x.ta < m.index + s.length && x.tb > m.index) ? `<span class="t-jserr">${h}</span>` : h;
      }
      return out;
    }
    let marks = [];   // { a, b, st, msg } for this paint (hover reads it)
    function paint() {
      if (lang === 'js') {
        // Errors: the bad line gets a dark red bar, the error itself dark grey; hovering the line shows the message.
        const t = ta.value, cs = getComputedStyle(hl), lh = parseFloat(cs.lineHeight) || 20, padT = parseFloat(cs.paddingTop) || 0;
        marks = errs.filter(e => e.pos >= 0).map(e => {
          const [a, b] = span(t, e), ls = t.lastIndexOf('\n', a - 1) + 1, le = t.indexOf('\n', a) < 0 ? t.length : t.indexOf('\n', a);
          return { a: ls, b: le + 1, ta: a, tb: b, L: lineOf(t, a), st: 'bad', msg: e.message };
        });
        const bad = new Set(marks.map(x => x.L));
        hl.innerHTML = findMarks() + [...bad].map(L => `<div class="sqled-bar" style="top:${padT + (L - 1) * lh}px;height:${lh}px"></div>`).join('') + paintJs(t, marks) + '\n';
        gut.innerHTML = Array.from({ length: t.split('\n').length }, (_, i) => bad.has(i + 1) ? `<span class="bad">${i + 1}</span>` : i + 1).join('<br>');
        return sync();
      }
      if (lang !== 'sql') {
        hl.innerHTML = findMarks() + paintJson(ta.value) + '\n';
        gut.innerHTML = Array.from({ length: ta.value.split('\n').length }, (_, i) => i + 1).join('<br>');
        return sync();
      }
      // Source tables and their aliases (FROM / JOIN name [AS] alias) are coloured as tables (green).
      const t = ta.value, tables = new Set([...words().tables.map(x => x.toLowerCase()), ...aliases(words().fields || {}).keys()]);
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
      // Plain colouring first, then wrap characters in error / flash spans (per character range, so words stay whole).
      let out = '', m;
      const re = /(--[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|('(?:[^']|'')*'?)|("(?:[^"]|"")*"?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|([\s\S])/g;
      const cls = (a, b) => {
        const mk = marks.find(x => x.a < b && x.b > a), f = fl.find(x => x.a < b && x.b > a);
        return [a < sB && b > sA && 't-stmt', mk && 't-err-' + mk.st, f && f.cls].filter(Boolean).join(' ');
      };
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
        const c = s === '\n' ? '' : s.trim() ? cls(m.index, m.index + s.length) : (m.index < sB && m.index >= sA ? 't-stmt' : '');   // spaces: only the statement grey
        out += c ? `<span class="${c}">${h}</span>` : h;
      }
      hl.innerHTML = findMarks() + out + '\n';
      const n = t.split('\n').length;
      gut.innerHTML = Array.from({ length: n }, (_, i) => badLines.has(i + 1) ? `<span class="bad">${i + 1}</span>` : i + 1).join('<br>');
      sync();
    }
    function sync() { hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft; gut.scrollTop = ta.scrollTop; }

    // Replace selection with text, keeping browser undo.
    let quiet = false, prev = '';
    function insert(text) { ta.focus(); quiet = true; try { if (!document.execCommand('insertText', false, text)) ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end'); } finally { quiet = false; } changed(); }
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
      const s = document.createElement('span'); s.style.font = cs.font; s.style.position = 'absolute'; s.style.visibility = 'hidden'; s.textContent = 'M'.repeat(50);
      document.body.append(s); cwCache = s.getBoundingClientRect().width / 50; s.remove(); return cwCache;
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
    function suggest(force) {
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
          ...[...KW.map(k => [k.toUpperCase(), 'keyword']), ...FN.map(f => [f, 'function'])].sort(abc)];
        items = all.filter(([t]) => { const k = t.toLowerCase(); if (!k.startsWith(lw) || k === lw || seen.has(k)) return false; seen.add(k); return true; }).slice(0, 300);
      }
      if (!items.length) return close();
      pick = 0; chosen = !!force; renderPop();
      const { x, y } = caretXY(); pop.style.left = Math.max(0, x) + 'px'; pop.style.top = y + 'px'; pop.hidden = false;
    }
    // Fields white, datasets / aliases green, SQL keywords and functions blue (css/theme.css .sqled-pop .sql / .tb).
    function renderPop() { pop.innerHTML = items.map(([t, k], i) => `<div class="${[i === pick && 'sel', (k === 'keyword' || k === 'function') && 'sql', (k === 'dataset' || k === 'alias') && 'tb'].filter(Boolean).join(' ')}" data-i="${i}"><span>${esc(t)}</span><small>${k}</small></div>`).join(''); pop.querySelector('.sel')?.scrollIntoView({ block: 'nearest' }); }
    function close() { pop.hidden = true; items = []; }
    function accept(i = pick) {
      const it = items[i]; if (!it) return;
      const { a } = wordAt(); ta.setSelectionRange(a, ta.selectionStart);
      insert(it[1] === 'function' ? it[0] + '(' : it[0]); close();
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
      if (!mk) { tip.hidden = true; return; }
      tip.className = 'sqled-tip ' + (mk.st === 'bad' ? 'bad' : 'warn'); tip.textContent = mk.msg; tip.hidden = false;
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
      if (ev.key === 'Tab') {
        ev.preventDefault();
        if (ev.shiftKey || ta.value.slice(ta.selectionStart, ta.selectionEnd).includes('\n')) indentLines(ev.shiftKey);
        else insert(IND);
      } else if (ev.key === 'Enter' && !ev.ctrlKey) {
        ev.preventDefault();
        const line = ta.value.slice(lineStart(ta.selectionStart), ta.selectionStart), ind = line.match(/^[ \t]*/)[0];
        insert('\n' + ind + ((lang === 'sql' ? /\(\s*$/ : /[{[(]\s*$/).test(line) ? IND : ''));
      } else if ((ev.key === ' ' || ev.code === 'Space') && ev.ctrlKey) { ev.preventDefault(); suggest(true); }
      else if ((ev.key === '/' || ev.code === 'Slash') && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); close(); toggleComment(); }
    });
    ta.addEventListener('input', ev => {
      if (quiet) return; changed();
      if (ev.inputType && ev.inputType.startsWith('insert') && ev.data && /[A-Za-z0-9_.]/.test(ev.data)) suggest();
      else if (ev.inputType === 'deleteContentBackward' && !pop.hidden) suggest(); else close();
    });
    ta.addEventListener('scroll', sync);
    ta.addEventListener('blur', () => { setTimeout(close, 150); paint(); });
    ta.addEventListener('focus', paint);
    ta.addEventListener('click', close);
    // Caret moves (arrows, clicks) change the error colours.
    let lastCaret = -1;
    document.addEventListener('selectionchange', () => { if (document.activeElement === ta && ta.selectionStart !== lastCaret) { lastCaret = ta.selectionStart; if (errs.length) paint(); } });
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
