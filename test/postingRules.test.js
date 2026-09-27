import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { POSTING_RULES } from '../extension/src/postingRules.js';

test('the rules shown in the product are the rules in legal/posting-rules.md, word for word', () => {
  const md = readFileSync(new URL('../legal/posting-rules.md', import.meta.url), 'utf8');
  const items = [...md.matchAll(/^\d+\.\s+\*\*(.+?)\*\*\s+(.+)$/gm)].map((m) => ({ title: m[1].trim(), text: m[2].trim() }));
  assert.equal(items.length, 10);
  assert.equal(POSTING_RULES.length, items.length);
  items.forEach((item, i) => {
    assert.equal(POSTING_RULES[i].title, item.title, `rule ${i + 1} title`);
    assert.equal(POSTING_RULES[i].text, item.text, `rule ${i + 1} text`);
  });
});
