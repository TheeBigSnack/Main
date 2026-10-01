// The first-run wizard's Account step (src/wizardSteps.js): the step list
// with and without accounts, what the step shows in each state, the words
// Settings' Account section uses, and the source rules that keep wizard.js
// on the same sign-in functions as Settings and the token out of its saved
// state.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { wizardSteps, accountStepModel, joinedFrom, joinedText, rewriteAtAccount, termsSummary, ACCOUNT_WORDS, LATER } from '../extension/src/wizardSteps.js';
import { syncPayload } from '../extension/src/sync.js';
import { accountsConfigured } from '../extension/src/accountConfig.js';
import { signInStart } from '../extension/src/accountFlow.js';
import { redeemInvite } from '../extension/src/account.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const TODAY = ['welcome', 'scan', 'store', 'you', 'address', 'price', 'permission', 'rules', 'terms', 'done'];
const ORIGIN = 'https://www.example-motors.test';
const SESSION = { user: { id: 'u1', email: 'sam@example.com' } };
const CONFIG = Object.freeze({ url: 'https://abcdefgh.supabase.co', anonKey: 'anon-key-for-tests', functionsUrl: '' });
const reply = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test('the step list: today\'s ten without accounts, the Account step right after You with them', () => {
  assert.deepEqual(wizardSteps(false), TODAY);
  assert.deepEqual(wizardSteps(), TODAY, 'no config means no step');
  const withAccounts = wizardSteps(true);
  assert.equal(withAccounts.length, TODAY.length + 1);
  assert.equal(withAccounts.indexOf('account'), withAccounts.indexOf('you') + 1);
  assert.deepEqual(withAccounts.filter((s) => s !== 'account'), TODAY, 'nothing else moves');
  wizardSteps(false).push('x');
  assert.deepEqual(wizardSteps(false), TODAY, 'each call is a fresh list');
  // the shipped wizard has the Account step exactly when src/accountConfig.js is filled in, as
  // supabase/README.md step 6 does; test/e2e/wizard.e2e.mjs counts its steps from the same list
  assert.equal(wizardSteps(accountsConfigured()).includes('account'), accountsConfigured());
});

test('without accounts the model says there is no step', () => {
  assert.deepEqual(accountStepModel({ configured: false, session: SESSION }), { show: false, state: 'off', next: 'Next' });
  assert.equal(accountStepModel().show, false);
});

test('signed out: the email box, Send me a sign-in code, the code box and Sign in; Next reads Skip for now', () => {
  const m = accountStepModel({ configured: true, email: 'sam@example.com' });
  assert.equal(m.state, 'signedOut');
  assert.equal(m.heading, 'Your account');
  assert.deepEqual(m.signIn, { emailLabel: 'Your email', email: 'sam@example.com', sendCode: 'Send me a sign-in code', codeLabel: 'Code from the email', signIn: 'Sign in' });
  assert.equal(m.intro, ACCOUNT_WORDS.intro);
  assert.equal(m.status, '');
  assert.equal(m.invite, null, 'no invite code before signing in');
  assert.equal(m.joined, '');
  assert.equal(m.next, 'Skip for now');
  assert.equal(m.later, LATER.signIn);
  assert.match(m.later, /Skip for now[\s\S]*Settings, Account/, 'says the step can be skipped and where to sign in later');
});

test('code sent: the note from signInStart shows, the boxes stay, Next still reads Skip for now', async () => {
  const r = await signInStart('Sam@Example.com', { config: CONFIG, fetchImpl: reply(200, {}) });
  assert.equal(r.ok, true);
  const m = accountStepModel({ configured: true, email: r.email, note: r.message });
  assert.equal(m.state, 'codeSent');
  assert.equal(m.note, 'A six-digit sign-in code is on its way to sam@example.com. Enter it below.');
  assert.ok(m.signIn && m.signIn.email === 'sam@example.com');
  assert.equal(m.next, 'Skip for now');
});

test('signed in: "Signed in as" the session\'s email, the invite code box and Join; Next reads Next', () => {
  const m = accountStepModel({ configured: true, session: SESSION, email: 'typed@example.com', note: 'A six-digit sign-in code is on its way to typed@example.com. Enter it below.' });
  assert.equal(m.state, 'signedIn');
  assert.equal(m.status, 'Signed in as sam@example.com', 'the session says who, not the typed box');
  assert.equal(m.signIn, null, 'no sign-in boxes once signed in');
  assert.equal(m.note, '', 'the code note is stale once signed in');
  assert.deepEqual(m.invite, { heading: 'Join a dealership with an invite code.', hint: 'Your manager gives you one; it works once.', label: 'Invite code', join: 'Join' });
  assert.equal(m.next, 'Next');
  assert.equal(m.later, LATER.join);
  assert.equal(accountStepModel({ configured: true, session: { user: {} }, email: 'typed@example.com' }).status, 'Signed in as typed@example.com');
  assert.equal(accountStepModel({ configured: true, session: {} }).status, 'Signed in');
});

test('joined: "Joined <dealership> as <role>" and no invite box; the other website is named when it differs', () => {
  const joined = joinedFrom({ dealershipId: 'd1', dealershipName: 'Example Motors', websiteOrigin: ORIGIN, role: 'salesperson', name: 'Sam' });
  assert.deepEqual(joined, { dealershipName: 'Example Motors', role: 'salesperson', websiteOrigin: ORIGIN }, 'only what the step says is kept');
  const m = accountStepModel({ configured: true, session: SESSION, joined, origin: ORIGIN + '/' });
  assert.equal(m.state, 'joined');
  assert.equal(m.joined, 'Joined Example Motors as salesperson.');
  assert.equal(m.invite, null);
  assert.equal(m.later, '');
  assert.equal(m.next, 'Next');
  assert.equal(joinedText(joined, 'https://other-lot.test'), `Joined Example Motors as salesperson. Its website is ${ORIGIN}: open it there to sync its listings.`);
  assert.equal(joinedText(joinedFrom({})), 'Joined the dealership as a member.');
  assert.equal(joinedText(null), '');
  // joined but signed out since (Settings, Sign out): back to signing in
  assert.equal(accountStepModel({ configured: true, session: null, joined }).state, 'signedOut');
});

test('a wrong or expired invite code: the server\'s one sentence, the box and Join stay for another try, Next still goes on', async () => {
  const r = await redeemInvite('WRONG1', 'Sam', { url: CONFIG.url, anonKey: CONFIG.anonKey, session: { accessToken: 'x' }, fetchImpl: reply(400, { code: 'P0002', message: 'that invite code is not valid', details: null, hint: null }) });
  assert.equal(r.ok, false);
  const m = accountStepModel({ configured: true, session: SESSION, error: r.error });
  assert.equal(m.error, 'that invite code is not valid');
  assert.equal(m.state, 'signedIn');
  assert.ok(m.invite, 'the invite box stays for a retry');
  assert.equal(m.next, 'Next', 'and the step can be left');
  // a sign-in failure while signed out: the boxes stay and Skip for now works
  const out = accountStepModel({ configured: true, email: 'sam@example.com', note: 'A six-digit sign-in code is on its way to sam@example.com. Enter it below.', error: 'Token has expired or is invalid' });
  assert.equal(out.error, 'Token has expired or is invalid');
  assert.ok(out.signIn);
  assert.equal(out.next, 'Skip for now');
});

test('on sign-in the rewrite address becomes the account\'s function; the key and the on/off choice stay', () => {
  const endpoint = 'https://abcdefgh.supabase.co/functions/v1/rewrite';
  const own = { enabled: false, endpoint: 'http://localhost:8787', key: 'self-hosted-key' };
  assert.deepEqual(rewriteAtAccount(own, endpoint), { enabled: false, endpoint, key: 'self-hosted-key' });
  const already = { enabled: true, endpoint: endpoint.toUpperCase() + '/', key: '' };
  assert.equal(rewriteAtAccount(already, endpoint), already, 'the same address, any case or trailing slash: unchanged');
  assert.equal(rewriteAtAccount(own, ''), own, 'no account function: unchanged');
  assert.deepEqual(rewriteAtAccount(undefined, endpoint), { endpoint });
});

test('the step\'s words are the ones Settings\' Account section uses', () => {
  const popup = read('../extension/popup.js');
  const section = popup.slice(popup.indexOf('function accountFieldset()'), popup.indexOf('function viewSettings()'));
  assert.ok(section.length > 500, 'popup.js accountFieldset moved: update this test');
  for (const [name, words] of Object.entries(ACCOUNT_WORDS)) assert.ok(section.includes(words), `"${words}" (${name}) is not in popup.js's Account section: update src/wizardSteps.js and Settings together`);
  // the join sentence and the other-website sentence are Settings' too (popup.js accountAction)
  assert.ok(popup.includes("`Joined ${m.dealershipName || 'the dealership'} as ${m.role || 'a member'}.`"), 'Settings words the join differently now');
  assert.ok(popup.includes('` Its website is ${m.websiteOrigin}: open it there to sync its listings.`'), 'Settings words the other website differently now');
});

test('the welcome names no set-up time: none has been measured', () => {
  const wizard = read('../extension/wizard.js');
  const welcome = wizard.slice(wizard.indexOf("case 'welcome':"), wizard.indexOf("case 'scan':"));
  assert.match(welcome, /In a few steps: read the website/, 'the welcome moved: update this test');
  assert.doesNotMatch(welcome, /\b(minutes?|seconds?)\b/i, 'an unmeasured figure (CLAUDE.md: no invented numbers)');
});

test('wizard.js: the step list from wizardSteps, the sign-in functions and messages Settings uses, and never a token', () => {
  const wizard = read('../extension/wizard.js');
  assert.doesNotMatch(wizard, /accessToken|refreshToken/, 'wizard.js must not touch the token: the session lives where src/account.js keeps it');
  assert.doesNotMatch(wizard, /\bSTEPS\b/, 'one step list: src/wizardSteps.js');
  assert.match(wizard, /wizardSteps\(accountsConfigured\(\)\)/);
  assert.match(wizard, /from '\.\/src\/accountConfig\.js'/);
  assert.match(wizard, /async function accountAction\(id, ctx\) \{\n\s+if \(!accountsConfigured\(\)/, 'every account call is gated on the config');
  assert.match(wizard, /accountDeps = \(\) => \(\{ config: ACCOUNT, storage: chrome\.storage\.local \}\)/);
  assert.match(wizard, /signInStart\(email, accountDeps\(\)\)/);
  assert.match(wizard, /signInFinish\(email, code, accountDeps\(\)\)/);
  assert.match(wizard, /redeemInvite\(code, [^,]+salesperson\.name[^,]*, \{ url: ACCOUNT\.url, anonKey: ACCOUNT\.anonKey, session: s\.session \}\)/, 'Join sends the name typed on the You step');
  assert.match(wizard, /rewriteAtAccount\(s\.rewrite, rewriteEndpointFor\(ACCOUNT\)\)/, 'sign-in points the rewrite address at the account in the settings finish() saves');
  // the saved state keeps what was typed and answered, nothing of the session
  const start = wizard.indexOf('async function persist()');
  const persist = wizard.slice(start, wizard.indexOf('\n}\n', start));
  assert.match(persist, /const account = \{ email: wiz\.account\.email, note: wiz\.account\.note, joined: wiz\.account\.joined \};/);
  assert.doesNotMatch(persist, /session/i);
  // after finish, a signed-in person's first sync runs in the worker
  const fin = wizard.slice(wizard.indexOf('async function finish('), wizard.indexOf('\n}\n', wizard.indexOf('async function finish(')));
  assert.match(fin, /if \(accountsConfigured\(\) && \(await loadSession\(chrome\.storage\.local\)\)\) chrome\.runtime\.sendMessage\(\{ type: 'syncNow', origin: wiz\.origin \}\)\.catch\(\(\) => \{\}\);/);
});

test('HANDOFF.md 5.7 lists the wizard steps with the Account step in its place', () => {
  const heading = read('../HANDOFF.md').match(/^### 5\.7 .*steps `([^`]+)`/m);
  assert.ok(heading, 'HANDOFF.md 5.7 lists the steps');
  assert.deepEqual(heading[1].split(',').map((s) => s.trim()), wizardSteps(true));
});

// What the Terms step says Lot Current keeps. With accounts configured the
// person can be signed in, and then sync sends their posted list, post
// timings, to-do items and scan counts to the dealership's account; the
// summary must say so instead of "keeps its data in your browser" alone.
const unescape = (html) => html.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

test('the Terms step\'s summary says what syncs to the dealership\'s account whenever accounts are configured', async () => {
  const off = termsSummary(false);
  const on = termsSummary(true);
  for (const s of [off, on]) {
    assert.match(s, /keeps its data in your browser/);
    assert.match(s, /never your Facebook login/);
    assert.match(s, /You publish every post yourself\. Lot Current is not affiliated with Meta Platforms, Inc\.$/);
  }
  assert.doesNotMatch(off, /sync|database|account/i, 'without accounts nothing leaves the browser, and the summary says nothing of an account');
  assert.match(on, /While you are signed in, your posted list \([^)]*\), your post timings, your to-do items \(with the old and new price of a price change\) and each scan's counts also sync to your dealership's account in Lot Current's database\./);
  // every field of a posted-list entry that sync sends is named in the parentheses
  const sent = syncPayload({ origin: ORIGIN, posted: { TESTVIN00000000A1: { name: 'A', price: 1, postedAt: '2026-11-16T09:00:00.000Z', updatedAt: '2026-11-16T10:00:00.000Z', listingUrl: 'https://www.facebook.com/marketplace/item/1/', salesperson: 'Sam' } } }).posted.TESTVIN00000000A1;
  const words = { name: 'name', price: 'price', postedAt: 'when you posted', updatedAt: 'and updated it', listingUrl: 'the listing link', salesperson: 'your name' };
  const listed = on.match(/your posted list \(([^)]*)\)/)[1];
  assert.match(listed, /\bVIN\b/);
  for (const field of Object.keys(sent)) assert.ok(words[field] && listed.includes(words[field]), `the summary does not name the posted-list field ${field} that sync sends`);
  // the step shows the summary for this build's config
  const { wiz, wizardHtml } = await import('../extension/wizard.js');
  wiz.step = 'terms';
  const html = wizardHtml();
  const shown = html.match(/<p id="termsSummary">([^<]*)<\/p>/);
  assert.ok(shown, 'the Terms step has no summary paragraph');
  assert.equal(unescape(shown[1]), termsSummary(accountsConfigured()));
});
