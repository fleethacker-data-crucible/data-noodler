// Node checks for the GHAS DOM fixes (settings panel, colour swatch, project-table headers, SQL comment toggle).
// Run: node --test tests/  (Node 18+). Loads the scripts in a sandbox; no server, no files written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = rel => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

function domContext() {
  const listeners = [];
  const document = {
    documentElement: {},
    addEventListener(type, fn) { listeners.push([type, fn]); },
    querySelectorAll() { return []; },
    createElement(tag) {
      const el = {
        tag, className: '', type: '', textContent: '', parent: null,
        style: {}, children: [],
        classList: {
          _s: new Set(),
          add(c) { this._s.add(c); },
          toggle(c, on) { if (on) this._s.add(c); else this._s.delete(c); },
          contains(c) { return this._s.has(c); },
        },
        append(...nodes) { for (const n of nodes) { n.parent = el; el.children.push(n); } },
        replaceChildren() { el.children = []; },
        querySelector(sel) {
          const name = sel.startsWith('.') ? sel.slice(1) : sel;
          return el.children.find(c => c.className === name || c.classList?.contains(name)) || null;
        },
      };
      return el;
    },
  };
  const ctx = {
    console, document, listeners,
    addEventListener(type, fn) { listeners.push([type, fn]); },
    MutationObserver: class { observe() {} },
  };
  ctx.globalThis = ctx;
  return vm.createContext(ctx);
}

function load(rel, ctx, name) {
  vm.runInContext(read(rel) + `\n;globalThis.__out = ${name};`, ctx);
  return ctx.__out;
}

test('settings rows escape labels, values, and slider bounds before innerHTML', () => {
  const ctx = domContext();
  const Settings = load('../ui/js/widgets/settings-panel.js', ctx, 'SettingsPanel');
  const el = { innerHTML: '', closest() { return null; }, querySelectorAll() { return []; } };
  const get = p => ({ n: '<script>', t: 'hello"world<SCRIPT>', s: 25 }[p]);
  Settings.settings(el, [
    { path: 'n', label: '<b>Label</b>', type: 'number', min: '"><img>', max: 10, step: 1 },
    { path: 't', label: "it's", type: 'text' },
    { path: 's', label: 'Size', type: 'number', min: 0, max: 100, step: 5 },
  ], get, () => {});
  assert.equal(el.innerHTML.includes('<script>'), false);
  assert.equal(el.innerHTML.includes('<SCRIPT>'), false);
  assert.equal(el.innerHTML.includes('<img'), false);
  assert.equal(el.innerHTML.includes('<b>'), false);
  assert.match(el.innerHTML, /&lt;script&gt;/);
  assert.match(el.innerHTML, /&quot;&gt;&lt;img&gt;/);
  assert.equal(el.innerHTML.includes('hello&quot;world&lt;SCRIPT&gt;'), true);
  assert.match(el.innerHTML, /&lt;b&gt;Label&lt;\/b&gt;/);
  assert.match(el.innerHTML, /it&#39;s/);
  assert.match(el.innerHTML, /style="--p:25%;--pf:0\.25"/);
  assert.match(el.innerHTML, /min="0"/);
  assert.match(el.innerHTML, /max="100"/);
  assert.match(el.innerHTML, /step="5"/);
});

test('colour swatch shows a value as text and does not parse it as HTML', () => {
  const ctx = domContext();
  const ColorPicker = load('../ui/js/widgets/color-picker.js', ctx, 'ColorPicker');
  const raw = '</span><img src=x onerror=alert(1)>';
  const b = ColorPicker.swatch(raw);
  assert.equal(b.children.length, 2);
  assert.equal(b.children[0].className, 'cp-chip');
  assert.equal(b.children[0].style.background, raw);
  assert.equal(b.children[1].className, 'cp-val');
  assert.equal(b.children[1].textContent, raw);
  assert.equal(b.children.some(c => c.tag === 'img'), false);
  const theme = ColorPicker.swatch(null);
  assert.equal(theme.children[1].textContent, 'Theme');
  assert.equal(theme.classList.contains('theme'), true);
  assert.equal(theme.children[0].style.background, 'transparent');
  const hex = ColorPicker.swatch('#3987e5');
  assert.equal(hex.children[1].textContent, '#3987e5');
  assert.equal(hex.children[0].style.background, '#3987e5');
  assert.equal(hex.classList.contains('theme'), false);
});

test('project table headers escape DOM text before it is written as HTML', () => {
  const src = read('../ui/html/project_manager.html');
  const line = src.split('\n').find(l => l.includes("querySelectorAll('th.sort')"));
  assert.ok(line.includes('esc(th.textContent'), 'header label is escaped before innerHTML');
  const ui = domContext();
  const UI = load('../ui/js/core/ui.js', ui, 'UI');
  const headers = [
    { text: 'Project Name', k: 'name' },
    { text: 'Created ▲', k: 'created' },
    { text: '<img src=x onerror=alert(1)>', k: 'owner' },
  ].map(h => ({ ...h, html: '' }));
  const ths = headers.map(h => ({
    textContent: h.text,
    dataset: { k: h.k },
    set innerHTML(v) { h.html = v; },
  }));
  const sandbox = vm.createContext({
    document: { querySelectorAll: () => ths },
    esc: UI.esc,
    sortKey: 'name',
    sortDir: 1,
    DATES: ['created', 'modified', 'updated'],
  });
  vm.runInContext(line, sandbox);
  assert.equal(headers[0].html, 'Project Name <span class="arrow">▲</span>');
  assert.equal(headers[1].html, 'Created <span class="arrow off">▼</span>');
  assert.equal(headers[2].html, '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(headers[2].html.includes('<img'), false);
  assert.equal(headers[2].html.includes('<IMG'), false);
});

test('SQL comment toggle removes the mark without building a regex from it', () => {
  const src = read('../ui/js/pipeline/sql-editor.js');
  assert.equal(src.includes('mark.replace'), false);
  const ctx = domContext();
  const Sql = load('../ui/js/pipeline/sql-editor.js', ctx, 'SqlEditor');
  const off = (line, mark) => Sql.uncommentLine(line, mark);
  assert.equal(off('    // comment', '//'), '    comment');
  assert.equal(off('//comment', '//'), 'comment');
  assert.equal(off('//  two', '//'), ' two');
  assert.equal(off('///x', '//'), '/x');
  assert.equal(off('\t// x', '//'), '\tx');
  assert.equal(off('//\tx', '//'), '\tx');
  assert.equal(off('not a comment', '//'), 'not a comment');
  assert.equal(off('    -- sql', '--'), '    sql');
  assert.equal(off('--sql', '--'), 'sql');
  assert.equal(off('---keep', '--'), '-keep');
  assert.equal(off('    //', '//'), '    ');
  assert.equal(off('', '//'), '');
});
