// Node checks for UI.toast live regions (ui/js/core/ui.js).
// Run: node --test tests/toast-live.test.mjs  (Node 18+). Loads the script in a sandbox; no server, no files written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

class El {
  constructor(tag) {
    this.tagName = tag;
    this.className = '';
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.attrs = {};
    this.textContent = '';
    this._html = '';
    this.popover = '';
  }
  get isConnected() {
    let n = this;
    while (n) {
      if (n === this.doc?.body || n === this.doc?.documentElement) return true;
      n = n.parentNode;
    }
    return false;
  }
  get childElementCount() { return this.children.length; }
  appendChild(node) { node.parentNode = this; this.children.push(node); return node; }
  prepend(node) { node.parentNode = this; this.children.unshift(node); return node; }
  remove() {
    const p = this.parentNode;
    if (!p) return;
    p.children = p.children.filter(c => c !== this);
    this.parentNode = null;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
  matches() { return false; }
  showPopover() { this.popoverOpen = true; }
  hidePopover() { this.popoverOpen = false; }
  querySelector(sel) {
    const want = sel.startsWith('.') ? sel.slice(1) : sel;
    const walk = nodes => {
      for (const n of nodes) {
        const classes = String(n.className || '').split(/\s+/);
        const hit = sel.startsWith('.') ? classes.includes(want) : n.tagName === want;
        if (hit) return n;
        const inner = walk(n.children || []);
        if (inner) return inner;
      }
      return null;
    };
    return walk(this.children);
  }
  querySelectorAll() { return []; }
  set innerHTML(html) {
    this._html = String(html);
    this.children = [];
    const re = /<button\b([^>]*)>/gi;
    let m;
    while ((m = re.exec(this._html))) {
      const b = new El('button');
      b.doc = this.doc;
      const cls = /class="([^"]*)"/.exec(m[1]);
      if (cls) b.className = cls[1];
      const al = /aria-label="([^"]*)"/.exec(m[1]);
      if (al) b.setAttribute('aria-label', al[1]);
      this.appendChild(b);
    }
  }
  get innerHTML() { return this._html; }
}

function loadUI() {
  const document = {
    documentElement: new El('html'),
    body: new El('body'),
    addEventListener() {},
    querySelectorAll() { return []; },
    createElement(tag) {
      const el = new El(tag);
      el.doc = document;
      return el;
    },
  };
  document.documentElement.doc = document;
  document.body.doc = document;
  const ctx = vm.createContext({
    console, document, window: {},
    MutationObserver: class { observe() {} },
    setTimeout, clearTimeout, Date,
    addEventListener() {},
  });
  const src = fs.readFileSync(new URL('../ui/js/core/ui.js', import.meta.url), 'utf8');
  vm.runInContext(src + '\n;globalThis.UI = UI;', ctx);
  return { UI: ctx.UI, document };
}

function walk(el, out = []) {
  for (const c of el.children || []) { out.push(c); walk(c, out); }
  return out;
}
const byRole = (document, role) => walk(document.body).find(c => c.getAttribute('role') === role);
const toastsOf = document => walk(document.body).filter(c => String(c.className).split(/\s+/).includes('toast'));
const wait = ms => new Promise(r => setTimeout(r, ms));

test('status and alert regions exist before any toast and stay on the page', () => {
  const { document } = loadUI();
  const status = byRole(document, 'status');
  const alert = byRole(document, 'alert');
  assert.ok(status?.isConnected);
  assert.ok(alert?.isConnected);
  assert.equal(status.getAttribute('aria-live'), 'polite');
  assert.equal(alert.getAttribute('aria-live'), 'assertive');
  assert.equal(status.getAttribute('aria-atomic'), 'true');
  assert.equal(alert.getAttribute('aria-atomic'), 'true');
  assert.equal(status.textContent, '');
  assert.equal(alert.textContent, '');
  assert.equal(status.parentNode, document.body);
  assert.equal(alert.parentNode, document.body);
});

test('a routine result is announced once in the status region and then leaves', async () => {
  const { UI, document } = loadUI();
  UI.toast('Saved', 'ok', 30);
  const shown = toastsOf(document);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].className, 'toast ok');
  assert.equal(shown[0].getAttribute('role'), null);
  assert.equal(byRole(document, 'status').textContent, 'Saved');
  assert.equal(byRole(document, 'alert').textContent, '');
  assert.match(shown[0].innerHTML, /Saved/);
  assert.match(shown[0].innerHTML, /aria-label="Dismiss"/);
  await wait(60);
  assert.equal(toastsOf(document).length, 0);
  assert.ok(byRole(document, 'status').isConnected);
  assert.equal(byRole(document, 'status').textContent, 'Saved');
});

test('an error is announced once, stays past its timeout, and a repeat is suppressed', async () => {
  const { UI, document } = loadUI();
  UI.toast('Import failed: disk full', 'error', 20);
  UI.toast('disk full', 'err', 20);   // overlaps the first message: one notification
  const shown = toastsOf(document);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].className, 'toast err');
  assert.equal(shown[0].getAttribute('role'), null);
  assert.equal(byRole(document, 'alert').textContent, 'Import failed: disk full');
  assert.equal(byRole(document, 'status').textContent, '');
  await wait(50);
  assert.equal(toastsOf(document).length, 1);
  assert.equal(byRole(document, 'alert').textContent, 'Import failed: disk full');
  shown[0].querySelector('.x').onclick();
  assert.equal(toastsOf(document).length, 0);
  assert.ok(byRole(document, 'alert').isConnected);
});

test('the same failure is announced again after the duplicate window, without a second live region', async () => {
  const { UI, document } = loadUI();
  UI.toast('disk full', 'err');
  toastsOf(document)[0].querySelector('.x').onclick();
  assert.equal(byRole(document, 'alert').textContent, 'disk full');
  UI.toast('disk full', 'err');
  assert.equal(byRole(document, 'alert').textContent, '');
  assert.equal(document.body.children.filter(c => c.getAttribute('role') === 'alert').length, 1);
  await wait(70);
  assert.equal(byRole(document, 'alert').textContent, 'disk full');
  assert.equal(toastsOf(document).length, 1);
});

test('toast text is escaped before it is written as HTML', () => {
  const { UI, document } = loadUI();
  UI.toast('a<b>c&d', 'ok', 20);
  const html = toastsOf(document)[0].innerHTML;
  assert.equal(html.includes('<b>'), false);
  assert.match(html, /a&lt;b&gt;c&amp;d/);
  assert.equal(byRole(document, 'status').textContent, 'a<b>c&d');
});
