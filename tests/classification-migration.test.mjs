// Node checks for the project classification migration (ui/js/core/projects.js).
// Run: node --test tests/  (Node 18+). Loads projects.js in a sandbox; no server, no files written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../ui/js/core/projects.js', import.meta.url), 'utf8') + '\n;globalThis.__Projects = Projects;';
const ctx = vm.createContext({ console, window: {}, document: { addEventListener() {} }, location: { search: '', pathname: '/' },
  localStorage: { getItem: () => null, setItem() {} }, UI: { esc: (s) => s } });
vm.runInContext(src, ctx);
const P = ctx.__Projects;
const run = (cfg) => P.migrate({ status: 0, phase: 'not-started', ...cfg });
const labelOf = (k) => P.label(P.CLASSIFICATION, k);

const cases = [
  ['public', 'unclassified', 'Public'],
  ['Public', 'unclassified', 'Public'],
  ['internal', 'unnpi', 'Internal'],
  ['INTERNAL', 'unnpi', 'Internal'],
  ['confidential', 'cui', 'Restricted'],
  ['restricted', 'cui', 'Restricted'],
  ['CUI', 'cui', 'Restricted'],
  ['unclassified', 'unclassified', 'Public'],
  ['unnpi', 'unnpi', 'Internal'],
  ['cui', 'cui', 'Restricted'],
];
for (const [legacy, key, lab] of cases) {
  test(`legacy '${legacy}' -> ${key} (${lab})`, () => {
    const c = run({ classification: legacy });
    assert.equal(c.classification, key);
    assert.equal(labelOf(c.classification), lab);
  });
}

for (const unknown of ['secret', 'top-secret', 'sensitive', 'other', '', null, undefined, 42]) {
  test(`unknown/missing ${JSON.stringify(unknown)} never becomes Public`, () => {
    const c = run(unknown === undefined ? {} : { classification: unknown });
    assert.notEqual(c.classification, 'unclassified');
    assert.equal(c.classification, 'unnpi');
    assert.equal(labelOf(c.classification), 'Internal');
  });
}

test('legacy value is kept in legacyClassification; current keys are not touched', () => {
  assert.equal(run({ classification: 'internal' }).legacyClassification, 'internal');
  assert.equal(run({ classification: 'internal', legacyClassification: 'restricted' }).legacyClassification, 'restricted');
  assert.equal('legacyClassification' in run({ classification: 'cui' }), false);
  assert.equal('legacyClassification' in run({}), false);
});

test('legacy handling=unnpi still folds into Internal unless Restricted', () => {
  assert.equal(run({ classification: 'public', handling: 'unnpi' }).classification, 'unnpi');
  assert.equal(run({ classification: 'cui', handling: 'unnpi' }).classification, 'cui');
  assert.equal('handling' in run({ handling: 'unnpi' }), false);
});

test('migrate is idempotent', () => {
  for (const v of ['public', 'internal', 'restricted', 'bogus']) {
    const once = run({ classification: v });
    const twice = P.migrate(JSON.parse(JSON.stringify(once)));
    assert.equal(twice.classification, once.classification);
    assert.equal(twice.legacyClassification, once.legacyClassification);
  }
});
