// D3 widget drawing (kind 'd3'): runs a widget's own D3 code (widgets/<id>/chart.js, widget.json "code") in a box.
// Needs js/vendor/d3.min.js. Global: D3Render. Used by ApexRender.render (Dashboard, previews, Publish) and D3 Studio.
//
// The code is a function body. It is called with:
//   d3      the D3 library (v7)
//   data    rows: objects keyed by the widget's input keys (dates are Date objects)
//   el      the empty box to draw in
//   W, H    the box size in px
//   colors  the 8 widget colours (widget settings, else the --w-c1..c8 defaults locked in the widget's style.css)
//   opts    the widget's spec with the chosen options applied
//   theme   { dark, text, text2, muted, border, font, ... } from the widget's --w-* variables
// It returns an SVG / HTML node (appended to el), or draws into el itself and returns nothing.
// Pasted Observable / D3 gallery code that uses width / height without declaring them gets them as W / H.
const D3Render = (() => {
  const fns = new Map();   // code -> compiled function
  const declares = (code, n) => new RegExp(`\\b(const|let|var|function)\\s+${n}\\b`).test(code);
  function compile(code) {
    if (!fns.has(code)) {
      const pre = ['width', 'height'].filter(n => !declares(code, n)).map(n => `const ${n} = ${n === 'width' ? 'W' : 'H'};`).join(' ');
      fns.set(code, new Function('d3', 'data', 'el', 'W', 'H', 'colors', 'opts', 'theme', `"use strict"; ${pre}\n${code}\n`));
    }
    return fns.get(code);
  }
  function draw(box, code, data, { W, H, colors = [], opts = {}, theme = {} } = {}) {
    if (typeof d3 === 'undefined') throw new Error('D3 is not loaded: put d3.min.js in js/vendor/.');
    box.innerHTML = '';
    const out = compile(String(code || ''))(d3, data || [], box, W, H, colors, opts, theme);
    if (out instanceof Node && !out.isConnected) box.append(out);
    return { el: box, destroy() { box.innerHTML = ''; } };
  }
  // Widget colours: the spec's chosen ones (opts "colors.N"), else the style sheet's --w-c1..c8.
  const colorsOf = (s, th) => Array.from({ length: 8 }, (_, i) => s?.colors?.[i] || th.colors?.[i] || '#888888');
  return { compile, draw, colorsOf };
})();
