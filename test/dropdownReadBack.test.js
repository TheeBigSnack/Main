// A dropdown fill (facebook/fillForm.js, applyField) is reported filled only when the form
// shows the value chosen. A form that still shows the value it had before the click has not
// taken the choice: that is retried, then blocked, so the restore re-check looks at it too.
// The fill runs inside the page, so applyField is compiled here from the source with the
// page stubbed (as typeaheadPick.test.js does).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../extension/facebook/fillForm.js', import.meta.url), 'utf8');
function innerLine(name) {
  const m = src.match(new RegExp(`\\n  const ${name} = .*;\\n`));
  assert.ok(m, `${name} is defined in fillFormInPage`);
  return m[0].trim();
}
function innerAsyncFunction(name) {
  const start = src.search(new RegExp(`\\n  async function ${name}\\(`));
  assert.ok(start >= 0, `${name} is defined in fillFormInPage`);
  const end = src.indexOf('\n  }\n', start);
  return src.slice(start + 1, end + 4);
}
// the page: `shownBefore` and `shownAfter` are what the dropdown displays around the click
function applyFieldWith({ shownBefore, shownAfter, chosen = 'Gray' }) {
  const reads = [shownBefore, shownAfter];
  const applyField = new Function(
    'setCheckbox', 'isDropdown', 'choose', 'displayed', 'sleep', 'setText', 'typeahead', 'text', 'tickHeld', 'verifyEntry',
    `${innerLine('norm')}\n${innerAsyncFunction('applyField')}\nreturn applyField;`,
  )(
    null, () => true,
    async () => ({ ok: true, chosen }),
    () => (reads.length > 1 ? reads.shift() : reads[0]),
    async () => {}, null, null, null, null, null,
  );
  return applyField({ key: 'exterior_color', kind: 'choice' }, { key: 'exterior_color', value: 'Gray' }, {});
}

test('a dropdown still showing the value it had before the click is not reported filled with the chosen value', async () => {
  const r = await applyFieldWith({ shownBefore: 'Silver', shownAfter: 'Silver' });
  assert.equal(r.status, 'blocked', JSON.stringify(r));
  assert.match(r.reason, /^chose "Gray" but the form shows "Silver"/);
});

test('a dropdown that shows the chosen value is filled, and one that reads empty keeps the read-it-back note', async () => {
  assert.deepEqual(await applyFieldWith({ shownBefore: 'Silver', shownAfter: 'Gray' }), { status: 'filled', shown: 'Gray' });
  const empty = await applyFieldWith({ shownBefore: '', shownAfter: '' });
  assert.equal(empty.status, 'filled');
  assert.match(empty.note, /read it back/);
});
