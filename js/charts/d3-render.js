// CHART drawing (kind 'd3', D3 Studio): runs a chart's own D3 code (chart-builder/<dev|live>/<id>/d3-code.js) in its <div>.
// Needs js/vendor/d3.min.js. Global: D3Render. Used by ApexRender.render (Dashboard, previews, Publish) and D3 Studio.
//
// The code is a function body. It is called with:
//   d3      the D3 library (v7)
//   data    rows: objects keyed by the chart's input variables, e.g. { x, y } (dates are Date objects; [] = no data yet)
//   el      the chart's <div> (empty) to draw in
//   W, H    the div's size in px (also width / height unless the code declares them)
//   colors  the 8 chart colours (Chart Settings, else the --w-c1..c8 defaults locked in the chart's style.css)
//   opts    the chart's settings (opts.<path>)
//   theme   { dark, text, text2, muted, border, font, ... } from the chart's --w-* variables
//   inputs  { <key>: { key, label, role, agg, field } }: field = 'TABLE.FIELD' it is linked to ('' = not linked)
// Generated for each input variable (unless the code declares the name): an accessor in capitals, X = d => d.x.
// It returns an SVG / HTML node (appended to el), or draws into el itself and returns nothing.
// Look (every chart, the same): data bars get 4px rounded corners on their value end (roundBars), and every redraw
// zips from the old drawing to the new one (animate: ease-in, data change 420 ms; a resize is not animated: the pages
// redraw every frame while the box changes size, so the chart follows the window live).
// Fit: the chart's root <svg> always scales to its div. No viewBox = one is made from its width / height (fixed sizes in
// pasted code still fill the box); its own width / height attributes and max-width styles are dropped.
const D3Render = (() => {
  const fns = new Map();   // code + inputs -> compiled function
  const PARAMS = ['d3', 'data', 'el', 'W', 'H', 'colors', 'opts', 'theme', 'inputs'];
  // The code declares name itself (const / let / var / function / class, or in a destructuring): nothing is generated for it.
  const declares = (code, n) => { const q = n.replace(/\$/g, '\\$'); return new RegExp(`\\b(const|let|var|function|class)\\s+${q}(?![\\w$])|\\b(const|let|var)\\s*[{[][^}\\]]*(?<![\\w$.])${q}(?![\\w$])`).test(code); };
  const IDENT = /^[A-Za-z_$][\w$]*$/;
  // Capital accessor names for the input keys: x -> X, value -> VALUE (never one of the parameters or a declared name).
  const accName = k => IDENT.test(k) ? k.toUpperCase() : null;
  function accessors(code, keys = []) {
    const out = [];
    for (const k of keys) {
      const n = accName(k);
      if (!n || PARAMS.includes(n) || n === 'D3' || out.some(o => o[0] === n) || declares(code, n)) continue;
      out.push([n, k]);
    }
    return out;
  }
  // The one line run before the code (kept on one line: the code's line 1 is line 4 of the compiled function).
  function prelude(code, keys) {
    const size = ['width', 'height'].filter(n => !declares(code, n)).map(n => `const ${n} = ${n === 'width' ? 'W' : 'H'};`);
    const acc = accessors(code, keys).map(([n, k]) => `const ${n} = d => d[${JSON.stringify(k)}];`);
    return `"use strict"; ${[...size, ...acc].join(' ')}`;
  }
  function compile(code, keys = []) {
    const id = code + '\u0001' + keys.join(',');
    if (!fns.has(id)) fns.set(id, new Function(...PARAMS, `${prelude(code, keys)}\n${code}\n`));
    return fns.get(id);
  }
  // Scale the chart's root svg to its div, whatever size the code drew it at.
  function fit(box, W, H) {
    const svg = [...box.children].find(n => n.tagName?.toLowerCase() === 'svg'); if (!svg) return;
    const px = a => { const v = svg.getAttribute(a); return v && !/%$/.test(v) && parseFloat(v) > 0 ? parseFloat(v) : null; };
    if (!svg.getAttribute('viewBox')) svg.setAttribute('viewBox', `0 0 ${px('width') || W} ${px('height') || H}`);
    svg.removeAttribute('width'); svg.removeAttribute('height');
    Object.assign(svg.style, { width: '100%', height: '100%', maxWidth: 'none', maxHeight: 'none', display: 'block' });
  }
  // The d3 the code gets: the library, except that d3.select / selectAll of a page selector ('#my_dataviz', 'body', ...)
  // that is not inside the chart's div means the div itself (gallery code draws into a page element we do not have).
  // redirected = the selectors that were sent to the div.
  function scoped(box, redirected) {
    const page = s => typeof s === 'string' && !box.querySelector(s) && /^\s*(#[\w-]+|body|html|:root)\s*$/.test(s);
    return Object.assign(Object.create(d3), {
      select: s => { if (page(s)) { redirected.push(s); return d3.select(box); } return d3.select(typeof s === 'string' && box.querySelector(s) ? box.querySelector(s) : s); },
      selectAll: s => { if (page(s)) { redirected.push(s); return d3.selectAll([box]); } return d3.selectAll(typeof s === 'string' && box.querySelector(s) ? box.querySelectorAll(s) : s); },
    });
  }
  // ---- the universal look: bars ----
  // Every data-bound bar (a <rect> made by a data join) gets BAR_RADIUS rounded corners on its VALUE end only; the end on
  // the zero line stays square. Done with rx / ry plus the bar made BAR_RADIUS longer past the zero line and that extra
  // clipped off (CSS clip-path inset), so the rect stays a rect (its events, classes and transitions keep working).
  // Stacked bars: only the outer segment of each stack is rounded. Same-size groups (legend swatches) are left alone.
  // A rect with class "square" (or data-square) is never rounded.
  const BAR_RADIUS = 4;
  function roundBars(svg) {
    const groups = new Map();
    for (const r of svg.querySelectorAll('rect')) {
      if (r.__data__ === undefined || r.classList.contains('square') || r.hasAttribute('data-square')) continue;
      const g = groups.get(r.parentNode) || []; g.push(r); groups.set(r.parentNode, g);
    }
    const num = (r, a) => parseFloat(r.getAttribute(a)) || 0, near = (a, b) => Math.abs(a - b) < 0.75;
    for (const bars of groups.values()) {
      const box = bars.map(r => ({ r, x: num(r, 'x'), y: num(r, 'y'), w: num(r, 'width'), h: num(r, 'height') })).filter(b => b.w > 0 && b.h > 0);
      if (!box.length || (box.length > 1 && box.every(b => near(b.w, box[0].w) && near(b.h, box[0].h)))) continue;   // swatches, not bars
      // The zero line: the edge most bars share. Vertical bars share a bottom (or top) y, horizontal ones a left (or right) x.
      const mode = vals => { const c = new Map(); for (const v of vals) { const k = Math.round(v * 2) / 2; c.set(k, (c.get(k) || 0) + 1); } return [...c].sort((a, b) => b[1] - a[1])[0] || [0, 0]; };
      const [yb, yn] = mode(box.flatMap(b => [b.y, b.y + b.h])), [xb, xn] = mode(box.flatMap(b => [b.x, b.x + b.w]));
      const vertical = yn >= xn;
      // Stacks: bars in the same column (vertical) / row (horizontal); only the one reaching farthest from zero is rounded.
      const lane = b => vertical ? `${Math.round(b.x)}:${Math.round(b.w)}` : `${Math.round(b.y)}:${Math.round(b.h)}`;
      const far = new Map();
      for (const b of box) {
        const up = vertical ? !near(b.y, yb) : !near(b.x + b.w, xb);   // the value end is the top (vertical) / right (horizontal)
        const reach = vertical ? (up ? yb - b.y : b.y + b.h - yb) : (up ? b.x + b.w - xb : xb - b.x);
        b.end = vertical ? (near(b.y + b.h, yb) ? 'top' : near(b.y, yb) ? 'bottom' : 'top') : (near(b.x, xb) ? 'right' : near(b.x + b.w, xb) ? 'left' : 'right');
        const k = lane(b) + b.end, f = far.get(k);
        if (!f || reach > f.reach) far.set(k, { b, reach });
      }
      for (const { b } of far.values()) {
        const R = Math.min(BAR_RADIUS, (vertical ? b.w : b.h) / 2, vertical ? b.h : b.w), r = b.r;
        if (R <= 0) continue;
        r.setAttribute('rx', R); r.setAttribute('ry', R);
        if (b.end === 'top') { r.setAttribute('height', b.h + R); r.style.clipPath = `inset(0 0 ${R}px 0)`; }
        else if (b.end === 'bottom') { r.setAttribute('y', b.y - R); r.setAttribute('height', b.h + R); r.style.clipPath = `inset(${R}px 0 0 0)`; }
        else if (b.end === 'right') { r.setAttribute('x', b.x - R); r.setAttribute('width', b.w + R); r.style.clipPath = `inset(0 0 0 ${R}px)`; }
        else { r.setAttribute('width', b.w + R); r.style.clipPath = `inset(0 ${R}px 0 0)`; }
      }
    }
  }

  // ---- the universal look: motion ----
  // A redraw never jumps: every element of the new drawing starts where its match in the previous drawing was and zips to
  // its new place / size / colour (ease-in: starts slow, ramps up fast). Data changes take MOTION.data ms; a new box size
  // (resize) is drawn at once (MOTION.size 0), frame by frame. Elements are matched under the same parent by tag and order (axis ticks by their label);
  // new ones fade in. The first drawing of a chart is not animated.
  const MOTION = { data: 420, size: 0, toggle: 150 };   // toggle: a setting turned on / off fades its parts in / out   // size 0: a resize redraws every frame and follows the box at once (no catch-up)
  const ease = t => t * t * t;   // cubic ease-in
  const ATTRS = ['x', 'y', 'width', 'height', 'rx', 'ry', 'cx', 'cy', 'r', 'x1', 'x2', 'y1', 'y2', 'd', 'transform', 'points', 'opacity', 'fill-opacity', 'stroke-opacity', 'fill', 'stroke', 'stroke-width'];
  const keyOf = (el, n) => el.classList?.contains('tick') ? `tick:${el.textContent}` : `${el.tagName}#${n}`;
  function pairs(oldP, newP, out) {
    const old = new Map(), seen = new Map();
    for (const c of oldP.children) { const n = (seen.get(c.tagName) || 0); if (!c.classList?.contains('tick')) seen.set(c.tagName, n + 1); old.set(keyOf(c, n), c); }
    seen.clear();
    for (const c of newP.children) {
      const n = (seen.get(c.tagName) || 0); if (!c.classList?.contains('tick')) seen.set(c.tagName, n + 1);
      const o = old.get(keyOf(c, n));
      if (o && o.tagName === c.tagName) { out.push([o, c]); pairs(o, c, out); } else out.push([null, c]);
    }
    return out;
  }
  // A setting turned on / off (same code, data and colours): parts that are the same stay still, parts that appeared fade
  // in, parts that went away fade out (a copy of the old part, removed after). Parts that changed (the plot got smaller
  // for a legend) move as with a data change.
  function toggle(oldSvg, svg, ms) {
    if (!oldSvg || typeof d3.transition !== 'function') return;
    const kids = el => [...el.children].filter(c => c instanceof SVGElement);
    const olds = kids(oldSvg), used = new Set(), moved = [];
    const news = kids(svg).map(n => { const o = olds.find(x => !used.has(x) && x.outerHTML === n.outerHTML); if (o) used.add(o); return [o, n]; });
    for (const pr of news) {
      if (pr[0]) continue;
      const n = pr[1], o = olds.find(x => !used.has(x) && x.tagName === n.tagName && x.childElementCount === n.childElementCount && x.getAttribute('class') === n.getAttribute('class'));
      if (o) { used.add(o); moved.push([o, n]); continue; }
      const op = n.getAttribute('opacity');
      d3.select(n).attr('opacity', 0).transition('dn').duration(ms).attr('opacity', op ?? 1)
        .on('end interrupt', () => op == null ? n.removeAttribute('opacity') : n.setAttribute('opacity', op));
    }
    for (const o of olds.filter(x => !used.has(x))) {
      const ghost = o.cloneNode(true); ghost.setAttribute('pointer-events', 'none'); svg.append(ghost);
      d3.select(ghost).transition('dn').duration(ms).attr('opacity', 0).on('end interrupt', () => ghost.remove());
    }
    for (const [o, n] of moved) morph(o, n, MOTION.data);
  }
  function animate(oldSvg, svg, ms) { if (oldSvg && ms) morph(oldSvg, svg, ms); }
  function morph(oldSvg, svg, ms) {
    if (!oldSvg || !ms || typeof d3.transition !== 'function') return;
    for (const [o, n] of pairs(oldSvg, svg, [])) {
      if (!(n instanceof SVGElement) || n.tagName === 'svg') continue;
      const sel = d3.select(n);
      // Interrupted (the next redraw came first) or ended: the element is put at its final values, so the next drawing
      // always starts from where this one was going, never from a half-faded / half-moved state.
      const done = fin => () => { for (const [a, v] of fin) v == null ? n.removeAttribute(a) : n.setAttribute(a, v); };
      if (!o) { const op = n.getAttribute('opacity'), fin = [['opacity', op]]; sel.attr('opacity', 0).transition('dn').duration(ms).ease(ease).attr('opacity', op ?? 1).on('end interrupt', done(fin)); continue; }
      let t = null; const fin = [];
      for (const a of ATTRS) {
        const was = o.getAttribute(a), now = n.getAttribute(a);
        if (was == null || now == null || was === now) continue;
        fin.push([a, now]); sel.attr(a, was);
        (t ||= sel.transition('dn').duration(ms).ease(ease)).attr(a, now);
      }
      t?.on('interrupt', done(fin));
    }
  }

  // -> { el, destroy, result, redirected }: result = what the code returned (a Promise = it draws later, see D3 Studio).
  // motion: false = no animation (pictures for Publish); else the redraw animates from what this box showed before.
  function draw(box, code, data, { W, H, colors = [], opts = {}, theme = {}, inputs = {}, motion = true } = {}) {
    if (typeof d3 === 'undefined') throw new Error('D3 is not loaded: put d3.min.js in js/vendor/.');
    const oldSvg = [...box.children].find(n => n.tagName?.toLowerCase() === 'svg') || null, was = box.__dnSize, wasSig = box.__dnSig;
    // Animate only a real change (other data, code, settings or colours) at the same size. A redraw of the same thing
    // (resize frames, refreshes, repeated redraws) is drawn at its final state at once, so nothing is ever left mid-move.
    let sig = '', base = ''; try { base = JSON.stringify([code, data, colors]); sig = base + JSON.stringify(opts); } catch { sig = base = String(Math.random()); }
    const wasBase = box.__dnBase;
    oldSvg?.querySelectorAll('*').forEach(n => d3.select(n).interrupt('dn'));   // its current (mid-move) values are the start
    box.innerHTML = '';
    const redirected = [];
    const out = compile(String(code || ''), Object.keys(inputs))(scoped(box, redirected), data || [], box, W, H, colors, opts, theme, inputs);
    if (out instanceof Node && !out.isConnected) box.append(out);
    const finish = () => {
      fit(box, W, H);
      const svg = [...box.children].find(n => n.tagName?.toLowerCase() === 'svg');
      if (!svg) return;
      roundBars(svg);
      const resized = was && (was[0] !== W || was[1] !== H);
      if (motion && sig !== wasSig) { if (!resized && base === wasBase) toggle(oldSvg, svg, MOTION.toggle); else animate(oldSvg, svg, resized ? MOTION.size : MOTION.data); }
    };
    finish();
    box.__dnSize = [W, H]; box.__dnSig = sig; box.__dnBase = base;
    if (out && typeof out.then === 'function') out.then(finish, () => {});   // drawn later: fit / round / animate it then
    return { el: box, destroy() { box.innerHTML = ''; box.__dnSize = box.__dnSig = box.__dnBase = null; }, result: out, redirected };
  }
  // Chart colours: the spec's chosen ones (opts "colors.N"), else the style sheet's --w-c1..c8.
  const colorsOf = (s, th) => Array.from({ length: 8 }, (_, i) => s?.colors?.[i] || th.colors?.[i] || '#888888');
  return { compile, draw, colorsOf, accessors, prelude, PARAMS, MOTION, BAR_RADIUS };
})();
