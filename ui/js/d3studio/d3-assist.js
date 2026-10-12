// D3 Studio editor help: suggestions, hover text and D3 name checks for the code editor (ui/js/pipeline/sql-editor.js, lang 'js').
// Needs ui/js/d3studio/d3-api.js. Global: D3Assist.
//   const a = D3Assist.create({ vars() -> Map(name -> info), fields() -> [[key, info]], opts() -> ['grid.x', ...] })
//     vars    the chart's ready variables (data, el, W, H, colors, opts, theme, inputs, X / Y accessors, ...)
//     fields  the input variables (what d.<key> holds)
//     opts    the Settings paths (opts.<path>)
//   a.complete({ text, pos, word, dot, force })  -> [[text, kind, info]]   kinds: keyword function method variable field d3 value
//   a.hover(text, pos)                           -> info text or null
//   a.check(text)                                -> [{ pos, end, line, message }]   d3.<name> D3 does not have; .<method>() a
//                                                   known D3 object does not have (with "did you mean")
//   a.explain(message)                           -> a runtime error message with "did you mean" added where it helps
//   a.receiver(text, dotPos)                     -> { root, chain } the expression before a dot
const D3Assist = (() => {
  const KW = 'const let var function return if else for of in while do switch case break continue new typeof instanceof class try catch finally throw true false null undefined this async await'.split(' ');
  const GLOBALS = { Math: 'Math functions', Number: 'Number', String: 'String', Object: 'Object', Array: 'Array', Date: 'dates', JSON: 'JSON', console: 'console.log(...) for debugging', isNaN: 'test for NaN', parseFloat: 'text to number', parseInt: 'text to integer', Intl: 'number / date formats', Set: 'Set', Map: 'Map' };
  const ARRAY = { map: 'new array from each item', filter: 'keep matching items', forEach: 'run for each item', reduce: 'reduce to one value', sort: 'sort in place', slice: 'part of the array', find: 'first match', findIndex: 'index of first match', some: 'any match', every: 'all match', includes: 'contains a value', indexOf: 'index of a value', concat: 'join arrays', flatMap: 'map and flatten', length: 'number of items', at: 'item at an index (negative from the end)', join: 'items to text', reverse: 'reverse in place', keys: 'indexes', entries: '[index, item] pairs' };
  const TYPE_NAME = { selection: 'selection', transition: 'transition', axis: 'axis', linear: 'linear scale', pow: 'power scale', log: 'log scale', symlog: 'symlog scale', time: 'time scale', radial: 'radial scale', identity: 'identity scale',
    sequential: 'sequential scale', quantize: 'quantize scale', ordinal: 'ordinal scale', band: 'band scale', point: 'point scale', arc: 'arc generator', pie: 'pie layout', line: 'line generator', area: 'area generator',
    lineRadial: 'radial line', areaRadial: 'radial area', link: 'link generator', symbol: 'symbol generator', stack: 'stack generator', bin: 'bin generator', brush: 'brush', drag: 'drag behaviour', zoom: 'zoom behaviour',
    simulation: 'force simulation', force: 'force', node: 'hierarchy node', stratify: 'stratify operator', layout: 'hierarchy layout', geoPath: 'geo path', projection: 'projection', color: 'colour', quadtree: 'quadtree',
    delaunay: 'Delaunay', voronoi: 'Voronoi', dispatch: 'dispatch', timer: 'timer', contours: 'contours', chord: 'chord', zoomTransform: 'zoom transform' };
  const isW = c => /[\w$]/.test(c || '');

  // Comments and strings blanked out (same length, so positions stay), template literal ${...} kept.
  function blank(t) {
    let out = '', i = 0;
    while (i < t.length) {
      const c = t[i], n = t[i + 1];
      if (c === '/' && n === '/') { const e = t.indexOf('\n', i); const j = e < 0 ? t.length : e; out += ' '.repeat(j - i); i = j; continue; }
      if (c === '/' && n === '*') { const e = t.indexOf('*/', i + 2); const j = e < 0 ? t.length : e + 2; out += t.slice(i, j).replace(/[^\n]/g, ' '); i = j; continue; }
      if (c === '"' || c === "'" || c === '`') {
        let j = i + 1; out += c;
        while (j < t.length && t[j] !== c) {
          if (t[j] === '\\') { out += '  '; j += 2; continue; }
          if (c === '`' && t[j] === '$' && t[j + 1] === '{') {   // keep ${ ... } code
            let d = 1, k = j + 2; while (k < t.length && d) { if (t[k] === '{') d++; else if (t[k] === '}') d--; k++; }
            out += t.slice(j, k); j = k; continue;
          }
          if (c !== '`' && t[j] === '\n') break;
          out += t[j] === '\n' ? '\n' : ' '; j++;
        }
        if (j < t.length && t[j] === c) { out += c; j++; }
        i = j; continue;
      }
      out += c; i++;
    }
    return out;
  }
  // Arguments in a call's text "(a, b)": -1 = not a call (a property), 0 = empty, else how many (top-level commas + 1).
  function argCount(inner) {
    if (inner == null) return -1;
    const b = blank(inner); if (!b.trim()) return 0;
    let d = 0, n = 1; for (const c of b) { if ('([{'.includes(c)) d++; else if (')]}'.includes(c)) d--; else if (c === ',' && !d) n++; }
    return n;
  }
  // The expression before the dot at dotPos: a.b(...).c( -> { root: 'a', chain: ['b', 'c'], args: [n, n] }
  // (args per name: -1 = a property, else its call's argument count; an [..] index or a called root = unknown).
  function receiver(t, dotPos) {
    let p = dotPos - 1; const chain = [], args = [];
    const ws = () => { while (p >= 0 && /\s/.test(t[p])) p--; };
    for (;;) {
      ws();
      let inner = null;
      if (t[p] === ']') return null;   // an index: unknown value
      if (t[p] === ')') {   // skip the (...) back to its opener
        const end = p; let d = 0;
        for (; p >= 0; p--) { if (t[p] === ')') d++; else if (t[p] === '(' && !--d) break; }
        inner = t.slice(p + 1, end); p--; ws();
      }
      const e = p; while (p >= 0 && isW(t[p])) p--;
      const name = t.slice(p + 1, e + 1);
      if (!name || /^\d/.test(name)) return null;
      chain.unshift(name); args.unshift(argCount(inner));
      ws();
      if (t[p] === '.' && t[p - 1] !== '.') { p--; continue; }
      break;
    }
    if (args[0] !== -1) return null;   // root(...): what a function returns is unknown
    return { root: chain[0], chain: chain.slice(1), args: args.slice(1) };
  }
  // Methods that give back something else than the object (a value, an array, a getter's answer).
  const VALUE = new Set(['ticks', 'tickFormat', 'invert', 'invertExtent', 'bandwidth', 'step', 'quantiles', 'thresholds', 'node', 'nodes', 'size', 'empty', 'centroid', 'bounds',
    'area', 'measure', 'find', 'descendants', 'leaves', 'links', 'ancestors', 'path', 'toString', 'formatHex', 'formatHex8', 'formatHsl', 'formatRgb', 'displayable', 'end', 'brighter', 'darker', 'rgb',
    'apply', 'applyX', 'applyY', 'invertX', 'invertY', 'rescaleX', 'rescaleY', 'contour', 'contours', 'hull', 'neighbors', 'render', 'cellPolygons', 'cellPolygon', 'hullPolygon', 'trianglePolygons',
    'trianglePolygon', 'root', 'visit', 'visitAfter']);
  // Called with no arguments these still give back the object; any other method called empty is a getter.
  const NULLARY_SELF = new Set(['nice', 'copy', 'remove', 'raise', 'lower', 'enter', 'exit', 'interrupt', 'stop', 'restart', 'sort', 'order', 'clone', 'transition', 'selection', 'clear', 'selectChildren', 'tick']);
  // One argument = a getter: .attr('x') is the value, .attr('x', 1) the selection.
  const GETTER1 = new Set(['attr', 'style', 'property', 'classed', 'on', 'styleTween', 'attrTween', 'tween', 'force']);
  function create({ vars = () => new Map(), fields = () => [], opts = () => [] } = {}) {
    // The D3 type a variable holds, from its declaration: const x = d3.scaleBand()...; const g = svg.append('g')...
    function declType(t, name, depth = 0) {
      if (depth > 4) return null;
      const m = new RegExp(`\\b(?:const|let|var)\\s+${name.replace(/\$/g, '\\$')}\\s*=\\s*([\\s\\S]{0,400})`).exec(t);
      if (!m) return null;
      const expr = m[1], b = blank(expr), end = b.search(/;|\n\s*\n|\n(?=\s*(const|let|var|if|for|return)\b)/);
      return chainType(expr.slice(0, end < 0 ? expr.length : end), depth + 1, t);
    }
    // Walk a chain forwards (text of the expression): d3.scaleLinear().domain(..).range(..) -> 'linear'.
    function chainType(expr, depth, whole) {
      const b = blank(expr), head = /^\s*([A-Za-z_$][\w$]*)/.exec(b); if (!head) return null;
      // The chain at depth 0 only (.name(args) steps; what is inside the brackets is skipped).
      const names = [], args = [];
      let i = head[0].length, d = 0;
      if (/^\s*\(/.test(b.slice(i))) return null;   // head(...): unknown
      while (i < b.length) {
        const c = b[i];
        if (c === '(' || c === '[' || c === '{') d++;
        else if (c === ')' || c === ']' || c === '}') { if (--d < 0) break; }
        else if (!d && c === '.') {
          const m = /^\.\s*([A-Za-z_$][\w$]*)\s*/.exec(b.slice(i)); if (!m) return null;
          names.push(m[1]); i += m[0].length;
          if (b[i] === '(') { let k = i, e = 0; for (; k < b.length; k++) { if (b[k] === '(') e++; else if (b[k] === ')' && !--e) break; } args.push(argCount(b.slice(i + 1, k))); i = k + 1; } else args.push(-1);
          continue;
        } else if (!d && /\S/.test(c)) return null;   // an operator: not a plain chain
        i++;
      }
      let type;
      if (head[1] === 'd3') { type = D3Api.typeOfFactory(names.shift()); args.shift(); }
      else type = declType(whole, head[1], depth);
      return follow(type, names, args);
    }
    // Along a chain: setters give back the object; transition() / selection() switch type; values and getters end it.
    function follow(type, names, args = []) {
      for (let k = 0; k < names.length; k++) {
        const n = names[k], a = args[k] ?? 1;
        if (!type) return null;
        if (a === -1) return null;   // a property
        if (VALUE.has(n) || (a === 0 && !NULLARY_SELF.has(n)) || (a === 1 && GETTER1.has(n))) return null;
        if (type === 'selection' && n === 'transition') type = 'transition';
        else if (type === 'transition' && n === 'selection') type = 'selection';
        else if (type === 'delaunay' && n === 'voronoi') type = 'voronoi';
        else if (D3Api.TYPES[type] && !D3Api.methods(type).has(n)) return null;   // not a known method: unknown result
      }
      return type;
    }
    // Type of the receiver before a dot, or a special: 'd3', 'row', 'opts:<path>', 'theme', 'inputs', 'input', 'array'.
    function typeAt(t, dotPos) {
      const r = receiver(t, dotPos); if (!r) return null;
      const { root, chain, args } = r;
      if (root === 'd3') return chain.length ? args[0] === -1 ? null : follow(D3Api.typeOfFactory(chain[0]), chain.slice(1), args.slice(1)) : 'd3';
      if (!chain.length && /^(d|row|datum)$/.test(root)) return 'row';
      if (root === 'opts') return 'opts:' + chain.join('.');
      if (root === 'theme' && !chain.length) return 'theme';
      if (root === 'inputs') return chain.length === 1 ? 'input' : chain.length ? null : 'inputs';
      if (root === 'data' && !chain.length) return 'array';
      if (root === 'Math' && !chain.length) return 'Math';
      const base = declType(t, root);
      return follow(base, chain, args);
    }
    const varMap = () => vars();
    function locals(t) {
      const b = blank(t), out = new Set();
      for (const m of b.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
      for (const m of b.matchAll(/\b(?:const|let|var)\s*[{[]([^}\]]*)[}\]]/g)) for (const n of m[1].split(',')) { const k = n.split(/[:=]/).pop().trim(); if (/^[A-Za-z_$][\w$]*$/.test(k)) out.add(k); }
      return out;
    }
    function membersOf(type, t, dotPos) {
      if (type === 'd3') return [...D3Api.top].map(([k, v]) => [k, typeof d3 !== 'undefined' && typeof d3[k] === 'function' ? 'function' : 'value', v]);
      if (type === 'row') return fields().map(([k, info]) => [k, 'field', info]);
      if (type === 'theme') return ['text', 'text2', 'muted', 'border', 'font', 'bg', 'panel', 'panel2', 'sel', 'blue', 'dark', 'colors'].map(k => [k, 'field', `theme colour / value (${k})`]);
      if (type === 'inputs') return fields().map(([k, info]) => [k, 'field', info]);
      if (type === 'input') return [['label', 'field', 'axis title, e.g. X Axis'], ['field', 'field', 'linked TABLE.FIELD (\'\' = none)'], ['key', 'field', 'variable name'], ['role', 'field', 'dimension / measure'], ['agg', 'field', 'aggregation (measures)']];
      if (type === 'array') return Object.entries(ARRAY).map(([k, v]) => [k, k === 'length' ? 'field' : 'method', v]);
      if (type === 'Math') return Object.getOwnPropertyNames(Math).map(k => [k, typeof Math[k] === 'function' ? 'method' : 'value', 'Math']);
      if (type && type.startsWith('opts:')) {
        const at = type.slice(5), pre = at ? at + '.' : '', kids = new Map();
        for (const p of opts()) if (p.startsWith(pre)) { const k = p.slice(pre.length).split('.')[0]; if (!kids.has(k)) kids.set(k, p.slice(pre.length).includes('.') ? 'group of settings' : `setting opts.${pre}${k}`); }
        return [...kids].map(([k, v]) => [k, 'field', v]);
      }
      if (type && D3Api.TYPES[type]) return [...D3Api.methods(type)].map(([k, v]) => [k, 'method', `${TYPE_NAME[type] || type}: ${v || 'D3 method'}`]);
      // Unknown receiver: every D3 method (selection first) and the array ones.
      const sel = D3Api.methods('selection'), out = [...sel].map(([k, v]) => [k, 'method', `selection: ${v}`]);
      for (const [k, v] of D3Api.allMethods) if (!sel.has(k)) out.push([k, 'method', v || 'D3 method']);
      for (const [k, v] of Object.entries(ARRAY)) if (!sel.has(k) && !D3Api.allMethods.has(k)) out.push([k, 'method', `array: ${v}`]);
      return out;
    }
    const abc = (a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' });
    function complete({ text, pos, word, dot, force }) {
      // Not inside a comment or a string.
      const b = blank(text.slice(0, pos + word.length)), at = pos + word.length - 1;
      if (at >= 0 && b[at] !== text[at]) return [];
      if (dot) {
        const list = membersOf(typeAt(text, pos - 1), text, pos - 1);
        return list.sort(abc);
      }
      const v = varMap(), mine = locals(text), out = [];
      for (const [k, info] of v) out.push([k, 'variable', info]);
      out.push(['d3', 'd3', 'the D3 library (v7): type d3. for everything in it']);
      for (const k of [...mine].sort()) if (!v.has(k) && k !== 'd3') out.push([k, 'variable', 'your variable']);
      for (const k of KW) out.push([k, 'keyword', 'JavaScript']);
      for (const [k, info] of Object.entries(GLOBALS)) out.push([k, 'variable', info]);
      return out.sort((a, b) => (a[1] === 'keyword') - (b[1] === 'keyword') || abc(a, b));
    }
    function wordAt(t, p) { let a = p, b = p; while (a > 0 && isW(t[a - 1])) a--; while (b < t.length && isW(t[b])) b++; return { a, b, w: t.slice(a, b) }; }
    function hover(t, p) {
      if (!isW(t[p])) return null;
      const { a, w } = wordAt(t, p); if (!w || /^\d/.test(w)) return null;
      if (blank(t).slice(a, a + w.length).trim() !== w) return null;   // in a comment or string
      let q = a - 1; while (q >= 0 && /\s/.test(t[q])) q--;
      if (t[q] === '.') {
        const type = typeAt(t, q);
        if (type === 'd3') { const d = D3Api.top.get(w); return d !== undefined ? `d3.${w}: ${d}` : `d3.${w}: D3 has no such name`; }
        if (type === 'row' || type === 'inputs') { const f = fields().find(([k]) => k === w); return f ? `${w}: ${f[1]}` : null; }
        if (type && type.startsWith('opts:')) return `opts.${type.slice(5) ? type.slice(5) + '.' : ''}${w}: a Setting (below the preview)`;
        if (type && D3Api.TYPES[type]) { const d = D3Api.methods(type).get(w); return d !== undefined ? `${TYPE_NAME[type] || type}.${w}: ${d || 'D3 method'}` : null; }
        const d = D3Api.allMethods.get(w); return d ? `.${w}: ${d}` : ARRAY[w] ? `.${w}: array ${ARRAY[w]}` : null;
      }
      if (w === 'd3') return 'd3: the D3 library (v7). Type d3. for everything in it.';
      const v = varMap(); if (v.has(w) && !locals(t).has(w)) return `${w}: ${v.get(w)}`;
      const type = declType(t, w); if (type) return `${w}: a ${TYPE_NAME[type] || type} (type ${w}. for its methods)`;
      return null;
    }
    // D3 names that do not exist: d3.<name>, and .<method>( on a value whose D3 type is known; d3.csv / json / ... (a chart
    // never loads files: its rows are data, and these load later, with no callback in D3 v7).
    const FETCH = /^(csv|tsv|dsv|json|text|xml|html|svg|blob|buffer|image)$/;
    function check(text) {
      const b = blank(text), out = [];
      const lineAt = p => text.slice(0, p).split('\n').length;
      for (const m of b.matchAll(/\bd3\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
        const n = m[1]; if (!FETCH.test(n)) continue;
        const at = m.index + m[0].indexOf(n);
        out.push({ pos: at, end: at + n.length, line: lineAt(at), message: `d3.${n}() loads a file from outside the chart, later (a Promise; D3 v7 takes no callback function), so nothing is drawn from it and its errors are lost. The chart's rows are already in data: link fields in Inputs (or use Sample data) and draw from data.` });
      }
      for (const m of b.matchAll(/\bd3\s*\.\s*([A-Za-z_$][\w$]*)/g)) {
        const n = m[1], at = m.index + m[0].length - n.length;
        if (D3Api.top.has(n)) continue;
        const near = D3Api.closest(n, [...D3Api.top.keys()]);
        out.push({ pos: at, end: at + n.length, line: lineAt(at), message: `d3.${n} is not part of D3${near ? `: did you mean d3.${near}?` : '.'}` });
      }
      for (const m of b.matchAll(/\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
        const n = m[1], dot = m.index, at = b.indexOf(n, dot);
        const type = typeAt(text, dot);
        if (!type || !D3Api.TYPES[type] || type === 'd3') continue;
        const ms = D3Api.methods(type);
        if (ms.has(n) || ['call', 'apply', 'bind', 'toString'].includes(n)) continue;
        const near = D3Api.closest(n, [...ms.keys()]);
        out.push({ pos: at, end: at + n.length, line: lineAt(at), message: `.${n}() is not a method of a ${TYPE_NAME[type] || type}${near ? `: did you mean .${near}()?` : '.'}` });
      }
      return out;
    }
    // "x.domian is not a function" -> + did you mean; "Y is not defined" -> + the chart's variables.
    function explain(msg) {
      let m = /(?:^|\s)d3\.([A-Za-z_$][\w$]*) is not a function/.exec(msg);
      if (m) { const near = D3Api.closest(m[1], [...D3Api.top.keys()]); return near ? `${msg} (did you mean d3.${near}?)` : `${msg} (D3 has no such name)`; }
      m = /(?:^|\s)[\w$.]*\.([A-Za-z_$][\w$]*) is not a function/.exec(msg);
      if (m) { const near = D3Api.closest(m[1], [...D3Api.allMethods.keys(), ...Object.keys(ARRAY)]); if (near && near !== m[1]) return `${msg} (did you mean .${near}?)`; }
      // D3's own (minified) names: say what it means.
      if (/^\w{1,2} is not iterable/.test(msg)) return `${msg} (a D3 function such as d3.extent / d3.max / .data() got one value where it needs a list: pass data, the array of rows)`;
      if (/^Cannot read propert(y|ies) of (undefined|null)/.test(msg)) return `${msg} (something on this line is undefined: a field name not in data, a scale not set up yet, or a missing return)`;
      m = /^([A-Za-z_$][\w$]*) is not defined/.exec(msg);
      if (m) { const near = D3Api.closest(m[1], [...varMap().keys()]); return near ? `${msg} (did you mean ${near}? Ready variables are listed in the Generated box)` : `${msg} (declare it, or see the Generated box for what is ready)`; }
      return msg;
    }
    return { complete, hover, check, explain, receiver: (t, p) => receiver(t, p), typeAt };
  }
  return { create, blank, receiver };
})();
