// What the product says about the dealer-website platforms it reads
// (extension/adapters/index.js unsupportedSiteMessage, shown by the popup and
// the wizard on a page no reader recognises). A reader counts as checked only
// when its PLATFORM says checkedLive: true; every other reader is named only
// after the caveat that it has not been checked on a real dealership website,
// so the product never claims a platform it has not read.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ADAPTERS, unsupportedSiteMessage, isCheckedLive } from '../extension/adapters/index.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const CAVEAT = 'Also tries, not yet checked on a real dealership website:';

test('the unsupported-page message names only the readers checked on a real website without the caveat', () => {
  const message = unsupportedSiteMessage();
  assert.doesNotMatch(message, /reads today/, 'no reader is said to be read "today" without saying whether it was checked');
  const at = message.indexOf(CAVEAT);
  const before = at === -1 ? message : message.slice(0, at);
  const after = at === -1 ? '' : message.slice(at);
  for (const a of ADAPTERS) {
    const name = a.PLATFORM.name;
    if (isCheckedLive(a)) {
      assert.ok(before.includes(name), `${name} is checked and is named among the checked readers`);
      assert.ok(!after.includes(name), `${name} is checked and is not named after the caveat`);
    } else {
      assert.ok(!before.includes(name), `${name} has not been checked on a real website, yet the message names it before the caveat`);
      assert.ok(after.includes(name), `${name} is named after the caveat`);
    }
  }
  assert.match(message, /^Lot Current can't read the cars on this page\. /, 'the survey reads the first sentence');
  // each checked reader has been read on one real dealership website so far
  // (README.md: Dealer Inspire on the pilot dealer's live site), so the
  // message claims one website, not several
  assert.doesNotMatch(message, /real dealership websites/, 'the message claims more real websites than any reader has been checked on');
  assert.match(message, /Checked on a real dealership website: /);
  assert.match(message, /Open your dealership's used inventory page and try again\.$/);
});

test('a reader counts as checked only when it says so, and no reader its own file calls unchecked says so', () => {
  assert.equal(isCheckedLive({ PLATFORM: { id: 'x', name: 'X' } }), false, 'saying nothing is unchecked');
  assert.equal(isCheckedLive({ PLATFORM: { id: 'x', name: 'X', checkedLive: 'yes' } }), false, 'only true counts');
  assert.equal(isCheckedLive(null), false);
  const files = { dealerInspire: 'dealerInspire.js', dealerOn: 'dealerOn.js', dealerCom: 'dealerCom.js', schemaOrg: 'schemaOrg.js' };
  for (const a of ADAPTERS) {
    const file = files[a.PLATFORM.id];
    assert.ok(file, `${a.PLATFORM.id}: add its file to this test`);
    if (/NOT YET CHECKED ON A LIVE SITE/.test(read(`../extension/adapters/${file}`))) {
      assert.equal(isCheckedLive(a), false, `${file} says it is not yet checked on a live site, so its PLATFORM must not say checkedLive`);
    }
  }
  // the readers README.md says have never read a real website are not checked
  const readme = read('../extension/adapters/README.md');
  assert.match(readme, /\*\*No real DealerOn or Dealer\.com website has been read yet\.\*\*/);
  for (const id of ['dealerOn', 'dealerCom', 'schemaOrg']) {
    const a = ADAPTERS.find((x) => x.PLATFORM.id === id);
    assert.ok(a, id);
    assert.equal(isCheckedLive(a), false, `${id} has been tested only on sample websites`);
  }
  assert.equal(isCheckedLive(ADAPTERS.find((x) => x.PLATFORM.id === 'dealerInspire')), true, 'Dealer Inspire is the reader checked on a live site');
});
