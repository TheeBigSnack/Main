// The typeahead fill (facebook/fillForm.js, typeahead) takes an exact suggestion when one
// matches the typed words: "Grand Cherokee" is not "Grand Cherokee L" when the form lists both.
// The fill runs inside the page, so it is compiled here from the source, with the page
// stubbed: the suggestions are the options typed text filters, and a pick sets the box.

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
const typeahead = new Function(
  'closePopups', 'visibleOptions', 'typeText', 'sleep', 'escapeRe', 'key', 'chooseOption', 'visiblePopups', 'readBack', 'readNear', 'text',
  `${innerLine('norm')}\n${innerLine('accepted')}\n${innerAsyncFunction('typeahead')}\nreturn typeahead;`,
);

// a page with a model box: `all` are the suggestions the form lists (in its order), and typing filters them
function run(all, value, expect) {
  let shown = [];
  let chosen = null;
  const el = { value: '', textContent: '' };
  const fn = typeahead(
    async () => {},
    () => shown,
    async (box, typed) => { shown = all.filter((o) => o.textContent.toLowerCase().includes(typed.toLowerCase())); },
    async () => {},
    (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    () => {},
    (option) => { chosen = option; el.value = option.textContent; },
    () => [],
    () => el.value,
    () => null,
    (node) => node.textContent,
  );
  return fn(el, value, expect).then((result) => ({ result, chosen: chosen && chosen.textContent }));
}
const opt = (t) => ({ textContent: t });

test('a typed model takes the suggestion that is exactly it, not the longer one listed first', async () => {
  const { chosen } = await run([opt('Grand Cherokee L'), opt('Grand Cherokee')], 'Grand Cherokee');
  assert.equal(chosen, 'Grand Cherokee', 'the exact suggestion, though it is listed second');
});

test('a single matching suggestion is still taken, as before', async () => {
  const { chosen } = await run([opt('Grand Cherokee Altitude X')], 'Grand Cherokee');
  assert.equal(chosen, 'Grand Cherokee Altitude X');
});
