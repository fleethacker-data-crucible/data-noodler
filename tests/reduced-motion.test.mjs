// Node checks that Project Manager's flash and pulse stop under prefers-reduced-motion.
// The new home page copies the same workflow styles, so it is checked too.
// Run: node --test tests/reduced-motion.test.mjs  (Node 18+). Reads source; no server, no files written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const files = ['../ui/html/project_manager.html', '../ui/html/new_app.html'];

for (const rel of files) {
  test(`${rel} disables the dialog flash and workflow pulse under reduced motion`, () => {
    const html = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
    const mediaAt = html.search(/@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)/);
    assert.ok(mediaAt > 0, 'missing prefers-reduced-motion override');
    for (const mark of ['dialog.flash { animation: flash', 'animation: wf-run', 'animation: wf-done']) {
      const at = html.indexOf(mark);
      assert.ok(at > 0 && at < mediaAt, `${mark} must be declared before the reduced-motion override`);
    }
    const media = html.slice(mediaAt, html.indexOf('</style>', mediaAt));
    assert.match(media, /dialog\.flash\s*\{[^}]*animation:\s*none/);
    assert.match(media, /\.wf \.st\.running \.c\s*\{[^}]*animation:\s*none/);
    assert.match(media, /\.wf \.st\.done\.flash \.c\s*\{[^}]*animation:\s*none/);
    assert.equal(media.includes('animation: wf-run'), false);
    assert.equal(media.includes('animation: wf-done'), false);
    assert.equal(media.includes('animation: flash '), false);
    // Stage name and the failed stage are not motion. They stay in the stylesheet.
    assert.match(html, /\.wf \.lbl \{/);
    assert.match(html, /\.wf \.st\.failed \.c \{[^}]*border-color:\s*var\(--red\)/);
    assert.match(html, /\.wf \.st\.failed \.note \{[^}]*color:\s*var\(--red\)/);
  });
}
