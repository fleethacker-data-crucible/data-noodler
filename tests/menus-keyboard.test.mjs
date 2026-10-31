// Node checks for the shared drop-down keyboard behaviour (ui/js/core/menus.js, Menus.bind).
// Run: node --test tests/  (Node 18+). Loads menus.js in a sandbox with a small stand-in DOM; no server, no browser, no files written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// ---- stand-in DOM: just enough for menus.js (classes, attributes, bubbling events, focus, :scope > [attr] queries)
const matches = (el, sel) => sel.trim().split(',').some(part => {
  const s = part.trim().replace(/^:scope\s*>\s*/, '');
  const toks = s.match(/\.[\w-]+|\[[\w-]+\]/g) || [];
  return toks.length > 0 && toks.every(t => t[0] === '.' ? el.classList.contains(t.slice(1)) : el.dataset[t.slice(1, -1).replace(/^data-/, '')] !== undefined);
});
class El {
  constructor(doc, cls = '', data = {}, text = '') {
    this.doc = doc; this.ownerDocument = doc; this.children = []; this.parent = null; this.attrs = {}; this.on = {};
    this.dataset = { ...data }; this._cls = new Set(cls.split(' ').filter(Boolean)); this.id = '';
    this.firstChild = { textContent: text }; this.textContent = text;
    this.classList = { add: c => this._cls.add(c), remove: c => this._cls.delete(c), contains: c => this._cls.has(c) };
  }
  append(c) { c.parent = this; this.children.push(c); return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, f) { (this.on[t] ||= []).push(f); }
  contains(x) { for (let n = x; n; n = n.parent) if (n === this) return true; return false; }
  closest(sel) { for (let n = this; n && n.parent !== undefined; n = n.parent) if (n.classList && matches(n, sel)) return n; return null; }
  descendants() { return this.children.flatMap(c => [c, ...c.descendants()]); }
  querySelectorAll(sel) {
    return sel.includes(':scope') ? this.children.filter(c => matches(c, sel)) : this.descendants().filter(c => matches(c, sel));
  }
  focus() { this.doc.activeElement = this; }
  fire(type, init = {}) {
    const ev = { type, target: this, key: '', detail: 0, defaultPrevented: false, stopped: false, ...init,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
    for (let n = this; n && !ev.stopped; n = n.parent) (n.on[type] || []).forEach(f => f(ev));
    if (!ev.stopped) (this.doc.win[type] || []).forEach(f => f(ev));
    return ev;
  }
  click() { return this.fire('click'); }
  key(key, init = {}) { return this.fire('keydown', { key, ...init }); }
}
function setup(itemSpecs) {
  const win = {}, doc = { win, activeElement: null };
  doc.body = new El(doc); doc.body.parent = null;
  const root = new El(doc, 'dd-wrap'); doc.body.append(root);
  const btn = root.append(new El(doc, '', {}, 'Utilities'));
  const menu = root.append(new El(doc, 'dd-menu'));
  const items = itemSpecs.map(([act, text, cls]) => menu.append(new El(doc, cls || '', { act }, text)));
  doc.querySelectorAll = sel => doc.body.querySelectorAll(sel);
  const picked = [];
  const src = fs.readFileSync(new URL('../ui/js/core/menus.js', import.meta.url), 'utf8') + '\n;globalThis.__Menus = Menus;';
  const ctx = vm.createContext({ console, document: doc, innerWidth: 1000, getComputedStyle: () => ({ position: 'absolute' }),
    addEventListener: (t, f) => (win[t] ||= []).push(f) });
  vm.runInContext(src, ctx);
  ctx.__Menus.bind(btn, menu, (act) => picked.push(act));
  return { doc, btn, menu, items, picked, Menus: ctx.__Menus };
}
const SPECS = [['a', 'Alpha'], ['b', 'Bravo', 'off'], ['c', 'Charlie'], ['d', 'Delta']];
const openByKeyboard = (t) => { t.btn.focus(); t.btn.fire('click', { detail: 0 }); };   // Enter / Space on a button fires click with detail 0

test('roles and aria wiring on the trigger and menu', () => {
  const t = setup(SPECS);
  assert.equal(t.btn.getAttribute('aria-haspopup'), 'menu');
  assert.equal(t.btn.getAttribute('aria-expanded'), 'false');
  assert.equal(t.menu.getAttribute('role'), 'menu');
  assert.ok(t.btn.id && t.menu.getAttribute('aria-labelledby') === t.btn.id, 'menu is named by its trigger');
  t.items.forEach(i => assert.equal(i.getAttribute('role'), 'menuitem'));
  assert.equal(t.items[1].getAttribute('aria-disabled'), 'true');
  assert.equal(t.items[0].getAttribute('aria-disabled'), null);
});

test('aria-expanded follows open and close', () => {
  const t = setup(SPECS);
  t.btn.fire('click', { detail: 1 });
  assert.equal(t.btn.getAttribute('aria-expanded'), 'true');
  t.btn.fire('click', { detail: 1 });
  assert.equal(t.btn.getAttribute('aria-expanded'), 'false');
});

test('Enter / Space on the button opens the menu and focuses the first item', () => {
  const t = setup(SPECS);
  openByKeyboard(t);
  assert.ok(t.menu.classList.contains('open'));
  assert.equal(t.doc.activeElement, t.items[0]);
  assert.equal(t.items[0].getAttribute('tabindex'), '0');   // roving tabindex
  assert.equal(t.items[2].getAttribute('tabindex'), '-1');
});

test('mouse click opens without stealing focus into the menu', () => {
  const t = setup(SPECS);
  t.btn.focus(); t.btn.fire('click', { detail: 1 });
  assert.equal(t.doc.activeElement, t.btn);
});

test('ArrowDown / ArrowUp on the closed button open to the first / last item', () => {
  let t = setup(SPECS);
  t.btn.focus(); const ev = t.btn.key('ArrowDown');
  assert.ok(ev.defaultPrevented && t.menu.classList.contains('open'));
  assert.equal(t.doc.activeElement, t.items[0]);
  t = setup(SPECS);
  t.btn.focus(); t.btn.key('ArrowUp');
  assert.equal(t.doc.activeElement, t.items[3]);
});

test('arrows move between items, skip .off items and wrap', () => {
  const t = setup(SPECS);
  openByKeyboard(t);
  t.items[0].key('ArrowDown'); assert.equal(t.doc.activeElement, t.items[2]);   // Bravo is .off
  t.items[2].key('ArrowDown'); assert.equal(t.doc.activeElement, t.items[3]);
  t.items[3].key('ArrowDown'); assert.equal(t.doc.activeElement, t.items[0]);   // wraps
  t.items[0].key('ArrowUp'); assert.equal(t.doc.activeElement, t.items[3]);     // wraps back
  t.items[3].key('ArrowUp'); assert.equal(t.doc.activeElement, t.items[2]);
});

test('Home and End jump to the first and last enabled item', () => {
  const t = setup(SPECS);
  openByKeyboard(t);
  t.items[0].key('End'); assert.equal(t.doc.activeElement, t.items[3]);
  t.items[3].key('Home'); assert.equal(t.doc.activeElement, t.items[0]);
});

test('Enter picks the focused item, closes the menu and returns focus to the trigger', () => {
  const t = setup(SPECS);
  openByKeyboard(t);
  t.items[0].key('ArrowDown');
  t.items[2].key('Enter');
  assert.deepEqual(t.picked, ['c']);
  assert.ok(!t.menu.classList.contains('open'));
  assert.equal(t.doc.activeElement, t.btn);
  assert.equal(t.btn.getAttribute('aria-expanded'), 'false');
});

test('Space picks the focused item', () => {
  const t = setup(SPECS);
  openByKeyboard(t);
  const ev = t.items[0].key(' ');
  assert.ok(ev.defaultPrevented);
  assert.deepEqual(t.picked, ['a']);
  assert.equal(t.doc.activeElement, t.btn);
});

test('a disabled item is never picked', () => {
  const t = setup(SPECS);
  openByKeyboard(t);
  t.items[1].key('Enter');   // even if focus somehow lands on it
  t.items[1].click();
  assert.deepEqual(t.picked, []);
});

test('Escape closes the menu and returns focus to the trigger', () => {
  const t = setup(SPECS);
  openByKeyboard(t);
  const ev = t.items[0].key('Escape');
  assert.ok(ev.defaultPrevented);
  assert.ok(!t.menu.classList.contains('open'));
  assert.equal(t.doc.activeElement, t.btn);
  assert.deepEqual(t.picked, []);
});

test('Escape on the open trigger closes the menu', () => {
  const t = setup(SPECS);
  t.btn.focus(); t.btn.fire('click', { detail: 1 });
  t.btn.key('Escape');
  assert.ok(!t.menu.classList.contains('open'));
  assert.equal(t.btn.getAttribute('aria-expanded'), 'false');
});

test('Tab closes the menu and leaves focus on the trigger so Tab moves on from it', () => {
  const t = setup(SPECS);
  openByKeyboard(t);
  const ev = t.items[0].key('Tab');
  assert.ok(!ev.defaultPrevented);
  assert.ok(!t.menu.classList.contains('open'));
  assert.equal(t.doc.activeElement, t.btn);
});

test('type-ahead jumps to the next item starting with the typed letter', () => {
  let t = setup(SPECS);
  openByKeyboard(t);
  t.items[0].key('d'); assert.equal(t.doc.activeElement, t.items[3]);
  t.items[3].key('e'); assert.equal(t.doc.activeElement, t.items[3]);   // "de" still matches Delta
  t = setup(SPECS);
  openByKeyboard(t);
  t.items[0].key('c'); assert.equal(t.doc.activeElement, t.items[2]);
});

test('Alt / Ctrl chords are left alone', () => {
  const t = setup(SPECS);
  openByKeyboard(t);
  const ev = t.items[0].key('ArrowDown', { altKey: true });
  assert.ok(!ev.defaultPrevented);
  assert.equal(t.doc.activeElement, t.items[0]);
});

test('mouse picking still works and still closes the menu', () => {
  const t = setup(SPECS);
  t.btn.fire('click', { detail: 1 });
  t.items[3].click();
  assert.deepEqual(t.picked, ['d']);
  assert.ok(!t.menu.classList.contains('open'));
});

test('items marked data-fmt work the same as data-act (table export menus)', () => {
  const doc = { win: {}, activeElement: null };
  doc.body = new El(doc);
  const wrap = doc.body.append(new El(doc));
  const btn = wrap.append(new El(doc, '', {}, 'Export'));
  const menu = wrap.append(new El(doc, 'dd-menu'));
  const csv = menu.append(new El(doc, '', { fmt: 'csv' }, '.csv'));
  doc.querySelectorAll = sel => doc.body.querySelectorAll(sel);
  const src = fs.readFileSync(new URL('../ui/js/core/menus.js', import.meta.url), 'utf8') + '\n;globalThis.__Menus = Menus;';
  const ctx = vm.createContext({ console, document: doc, innerWidth: 1000, getComputedStyle: () => ({ position: 'absolute' }),
    addEventListener: (t, f) => (doc.win[t] ||= []).push(f) });
  vm.runInContext(src, ctx);
  const picked = [];
  ctx.__Menus.bind(btn, menu, f => picked.push(f));
  btn.focus(); btn.fire('click', { detail: 0 });
  assert.equal(csv.getAttribute('role'), 'menuitem');
  assert.equal(doc.activeElement, csv);
  csv.key('Enter');
  assert.deepEqual(picked, ['csv']);
  assert.equal(doc.activeElement, btn);
});
