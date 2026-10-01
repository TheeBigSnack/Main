// The shared copy guard (test/copyGuards.js) catches the account promises a
// review slipped past the store listing's old check, still lets the honest
// denials through, and is the one list every copy test uses: the listing and
// the Web Store answers, the marketing kit, the website and the docs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { copyProblems } from './copyGuards.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

// Each passed the listing's check before it shared this guard.
const PROMISES = [
  'Lot Current is a guarantee that your account stays in good standing.',
  'We promise your account will not be banned or restricted.',
  'Your account will never be restricted.',
  'Your account is protected while you use Lot Current.',
  'Risk-free for your account.',
];

test('every account promise is caught on its own and inside the store listing, the help doc and a sales email', () => {
  const listing = read('../store/listing.md');
  const help = read('../docs/help.md');
  const email = read('../marketing/pilot-offer-email.md');
  for (const s of PROMISES) {
    assert.notDeepEqual(copyProblems(s), [], s);
    assert.ok(listing.includes('You click Publish. Lot Current never does.'));
    assert.notDeepEqual(copyProblems(listing.replace('You click Publish. Lot Current never does.', `${s} You click Publish. Lot Current never does.`)), [], `the listing with: ${s}`);
    assert.notDeepEqual(copyProblems(`${help}\n${s}\n`), [], `docs/help.md with: ${s}`);
    assert.notDeepEqual(copyProblems(`${email}\n${s}\n`), [], `the pilot offer email with: ${s}`);
  }
  // other words for the same promise
  for (const s of ['Your profile won\'t get banned.', 'Accounts stay safe with Lot Current.', 'We guarantee it.', 'Lot Current knows a guarantee when it sees one.']) {
    assert.notDeepEqual(copyProblems(s), [], s);
  }
});

// A second review found these passing the shared guard: a ban promised away,
// "no risk" in other words, and "safe" before the account or a profile.
const MORE_PROMISES = [
  'Facebook will never ban you for using Lot Current.',
  'No bans, ever.',
  'Ban-free posting.',
  'Zero risk to your Facebook account.',
  'It is 100% safe for your account.',
  'Your profile is safe with Lot Current.',
];

test('a ban promised away, zero risk, and a safe account or profile are caught, alone and in the help doc and a sales email', () => {
  const help = read('../docs/help.md');
  const email = read('../marketing/pilot-offer-email.md');
  for (const s of MORE_PROMISES) {
    assert.notDeepEqual(copyProblems(s), [], s);
    assert.notDeepEqual(copyProblems(`${help}\n${s}\n`), [], `docs/help.md with: ${s}`);
    assert.notDeepEqual(copyProblems(`${email}\n${s}\n`), [], `the pilot offer email with: ${s}`);
  }
  // the honest lines about safety still pass
  for (const s of [
    'Having a person click Publish is the safest design available, but it isn\'t a guarantee.',
    'The daily cap is a safety setting.',
    'Facebook can still restrict an account, and no tool can honestly promise otherwise.',
  ]) assert.deepEqual(copyProblems(s), [], s);
});

test('the honest lines pass: the denials of a guarantee, a promise, an affiliation', () => {
  for (const s of [
    'Meta doesn\'t publish its limits; this is a safety setting, not a guarantee.',
    'Having a person click Publish is the safest design available, but it isn\'t a guarantee.',
    'We make no promise about how Meta treats any account.',
    'No tool can honestly promise that.',
    'Lot Current is not affiliated with, endorsed by or partnered with Meta Platforms, Inc.',
    'no one can promise your account will never be restricted',
    'Nothing here is a guarantee.',
  ]) assert.deepEqual(copyProblems(s), [], s);
});

test('internal documents keep the rules every text keeps, and may name a promise to avoid it', () => {
  assert.deepEqual(copyProblems('We should never write that an account is protected.', { customerFacing: false }), []);
  assert.notDeepEqual(copyProblems('Lot Current is a guarantee.', { customerFacing: false }), []);
  assert.notDeepEqual(copyProblems('Approved by Meta.', { customerFacing: false }), []);
});

test('every copy test uses the shared guard and keeps no list or blanket "a guarantee" strip of its own', () => {
  for (const f of ['manifest.test.js', 'marketing.test.js', 'site.test.js', 'sitePages.test.js', 'docs.test.js']) {
    const src = read(f);
    assert.match(src, /^import \{ copyProblems \} from '\.\/copyGuards\.js';$/m, `${f} imports the shared guard`);
    assert.match(src, /copyProblems\(/, `${f} calls it`);
    assert.doesNotMatch(src, /\.replace\(\/a guarantee\\b\/gi, ''\)/, `${f} strips every "a guarantee" again`);
    assert.doesNotMatch(src, /const (NEVER|NOT_TO_CUSTOMERS|never|notToCustomers) = \[/, `${f} keeps its own list again`);
  }
  // the store listing and the Web Store answers are both held to it
  const manifestTest = read('manifest.test.js');
  assert.match(manifestTest, /copyProblems\(listing\)/);
  assert.match(manifestTest, /copyProblems\(read\('\.\.\/legal\/chrome-web-store-privacy\.md'\)\)/);
});
