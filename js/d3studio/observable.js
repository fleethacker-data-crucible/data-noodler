// Observable notebook code -> plain D3 Studio code (a function body). Global: ObservableImport.
//   ObservableImport.convert(text) -> { code, notes: [..] } or null when the text is not Observable code.
// Notebook cells ("name = expr", "name = { ... }", "viewof name = ...") become consts, sorted so each comes after the
// cells it uses; the chart cell (named chart, else the last block cell that builds a node) is unwrapped at the end, so
// its own "return svg.node()" is the widget's return. Dropped: imports, md / html text cells, the data cell (the rows
// come from Sample data). DOM.uid gets a small stand-in. width / height are given by D3Render (W / H).
const ObservableImport = (() => {
  const NAME = /^(?:viewof\s+|mutable\s+)?([A-Za-z_$][\w$]*)\s*=(?!=)\s*/;
  const DECL = /^(?:const|let|var|function|class|async|return|if|for|while|switch|try|export)\b/;

  // Split at top-level line starts (outside brackets, strings, template literals and comments).
  function cells(text) {
    const out = []; let depth = 0, start = 0, i = 0, q = null; const tpl = [];
    const at0 = p => p === 0 || text[p - 1] === '\n';
    while (i < text.length) {
      const c = text[i], n = text[i + 1];
      if (q) {
        if (c === '\\') { i += 2; continue; }
        if (q === '`' && c === '$' && n === '{') { tpl.push(depth); depth++; q = null; i += 2; continue; }
        if (c === q) q = null;
        i++; continue;
      }
      if (c === '/' && n === '/') { const e = text.indexOf('\n', i); i = e < 0 ? text.length : e; continue; }
      if (c === '/' && n === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? text.length : e + 2; continue; }
      if (c === '"' || c === "'" || c === '`') { q = c; i++; continue; }
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) { depth = Math.max(0, depth - 1); if (c === '}' && tpl.length && tpl[tpl.length - 1] === depth) { tpl.pop(); q = '`'; } }
      else if (depth === 0 && at0(i) && i > start && /\S/.test(c) && (NAME.test(text.slice(i, i + 80)) || /^(import\b|md`|html`|tex`)/.test(text.slice(i, i + 10)))) {
        out.push(text.slice(start, i)); start = i;
      }
      i++;
    }
    out.push(text.slice(start));
    return out.map(s => s.trim()).filter(Boolean);
  }

  function isObservable(text) {
    return /^(?:viewof\s+)?[A-Za-z_$][\w$]*\s*=\s*\{/m.test(text) && !/^\s*(const|let|var)\s/m.test(text.split('\n').find(l => l.trim()) || '')
      || /\bFileAttachment\s*\(|^import\s+\{[^}]*\}\s+from\s+["']@|^\s*md`|^viewof\s/m.test(text);
  }

  function convert(text) {
    if (!isObservable(text)) return null;
    const notes = [], defs = [];
    for (const c of cells(text)) {
      if (/^import\b/.test(c)) { notes.push(`Removed: ${c.split('\n')[0].slice(0, 80)}`); continue; }
      if (/^(md|html|tex)`/.test(c)) continue;
      const m = c.match(NAME);
      if (!m || DECL.test(c)) { defs.push({ name: null, raw: c }); continue; }
      const name = m[1], body = c.slice(m[0].length).replace(/;\s*$/, '');
      if (name === 'data') { notes.push('The notebook\'s data cell was removed: put the rows in Sample data (Load file…).'); continue; }
      if (/\bFileAttachment\s*\(/.test(body)) notes.push(`Cell "${name}" reads a FileAttachment: load that file as Sample data instead.`);
      const block = /^\{[\s\S]*\}$/.test(body) && !/^\{\s*[\w$"']+\s*:/.test(body);   // { statements } (not an object literal)
      defs.push({ name, body, block });
    }
    if (/\bPlot\./.test(text)) notes.push('Observable Plot is not loaded here (D3 only): Plot.* calls will fail.');
    const named = defs.filter(d => d.name);
    const main = named.find(d => d.name === 'chart') || [...named].reverse().find(d => d.block && /\.node\(\)|d3\.create\(|return\s+svg\b/.test(d.body)) || named[named.length - 1];
    // Order: each cell after the cells it uses (Observable runs cells in dependency order, not text order).
    const uses = d => named.filter(o => o !== d && new RegExp(`(?<![.\\w$])${o.name.replace(/\$/g, '\\$')}(?![\\w$])`).test(d.body));
    const sorted = [], seen = new Set();
    const visit = d => { if (seen.has(d)) return; seen.add(d); uses(d).forEach(visit); if (d !== main) sorted.push(d); };
    named.forEach(visit);
    const lines = [];
    if (/\bDOM\.uid\b/.test(text)) lines.push(`const DOM = { uid: n => { const id = 'O-' + (n || '') + '-' + Math.random().toString(36).slice(2, 8); return { id, href: '#' + id, toString: () => 'url(#' + id + ')' }; } };`);
    defs.filter(d => !d.name).forEach(d => lines.push(d.raw));
    for (const d of sorted) lines.push(d.block ? `const ${d.name} = (() => ${d.body})();` : `const ${d.name} = ${d.body};`);
    if (main) lines.push(main.block ? dedent(main.body.slice(1, -1)) : `return ${main.body};`);
    return { code: lines.join('\n\n') + '\n', notes };
  }
  // The chart cell's statements, moved out of their braces one indent level.
  function dedent(s) {
    const ls = s.replace(/^\s*\n/, '').replace(/\s+$/, '').split('\n'), n = Math.min(...ls.filter(l => l.trim()).map(l => l.match(/^ */)[0].length));
    return ls.map(l => l.slice(Math.min(n, l.match(/^ */)[0].length))).join('\n');
  }
  return { convert, cells };
})();
