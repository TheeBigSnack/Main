// The first-run wizard's Account step (src/wizardSteps.js): the step list
// with and without accounts, what the step shows in each state, the words
// Settings' Account section uses, and the source rules that keep wizard.js
// on the same sign-in functions as Settings and the token out of its saved
// state.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { wizardSteps, accountStepModel, joinedFrom, joinedText, rewriteAtAccount, addressHint, ACCOUNT_WORDS, LATER } from '../extension/src/wizardSteps.js';
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

test('the address step calls read from the website only what the website gave, and asks for the rest', () => {
  const TAIL = 'Marketplace asks for a location; the ZIP is what gets typed.';
  const none = `No address was found on the website: type the store's city, state and ZIP. ${TAIL}`;
  // the scan found no address (src/scan.js leaves source '' and every part blank)
  assert.equal(addressHint({ street: '', city: '', state: '', zip: '', phone: '', source: '' }), none);
  assert.equal(addressHint(undefined), none, 'no site read yet');
  assert.equal(addressHint(null), none);
  assert.doesNotMatch(addressHint({ source: '' }), /Read from the website/);
  // all of it read
  assert.equal(addressHint({ city: 'Springfield', state: 'OH', zip: '43215', source: 'structured data' }), `Read from the website (structured data). ${TAIL}`);
  // structured data with a ZIP and no city: the missing part is named, not filled in
  assert.equal(addressHint({ city: '', state: '', zip: '43215', source: 'structured data' }), `Read from the website (structured data). It gives no city or state: type them. ${TAIL}`);
  assert.equal(addressHint({ city: 'Springfield', state: 'OH', zip: '', source: 'structured data' }), `Read from the website (structured data). It gives no ZIP: type it. ${TAIL}`);
  // wizard.js draws this hint, not a fixed "Read from the website"
  const wizard = read('../extension/wizard.js');
  assert.match(wizard, /addressHint\(wiz\.site && wiz\.site\.address\)/);
  assert.doesNotMatch(wizard, />Read from the website/);
});

test('HANDOFF.md 5.7 lists the wizard steps with the Account step in its place', () => {
  const heading = read('../HANDOFF.md').match(/^### 5\.7 .*steps `([^`]+)`/m);
  assert.ok(heading, 'HANDOFF.md 5.7 lists the steps');
  assert.deepEqual(heading[1].split(',').map((s) => s.trim()), wizardSteps(true));
});

// ---------- the address step needs the dealership's name ----------
import { withDefaults, NO_DEALER_NAME, dealerNameMissing } from '../extension/src/settings.js';

// A top-level function of wizard.js, as written, compiled with the given names in scope.
function wizardFn(name, scope) {
  const src = read('../extension/wizard.js');
  const start = src.search(new RegExp(`(async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} is defined`);
  const text = src.slice(start, src.indexOf('\n}\n', start) + 2);
  return new Function(...Object.keys(scope), `${text}\nreturn ${name};`)(...Object.values(scope));
}

test('the address step says when no dealership name is set, and Next goes on only once one is typed', async () => {
  assert.equal(dealerNameMissing({ name: '' }), true);
  assert.equal(dealerNameMissing({ name: '   ' }), true);
  assert.equal(dealerNameMissing({}), true);
  assert.equal(dealerNameMissing(undefined), true);
  assert.equal(dealerNameMissing({ name: 'Example Motors' }), false);
  assert.equal(NO_DEALER_NAME, 'No dealership name is set: type it in Dealership name. Every description names the dealership, so nothing can be posted until it is.');

  // a website that gives no name (src/scan.js reads none), and one that does
  const unnamed = { name: '', address: { city: 'Springfield', state: 'OH', zip: '43215', source: 'structured data' } };
  const named = { ...unnamed, name: 'Example Motors' };
  const list = TODAY;
  const draw = (site) => {
    const wiz = { step: 'address', site, settings: null, scan: { siteName: site.name }, error: '' };
    const esc = (x) => String(x ?? '');
    const html = wizardFn('wizardHtml', { wiz, withDefaults, esc, steps: () => list, stepIndex: () => list.indexOf(wiz.step), addressHint, nav: () => '<nav>', dealerNameMissing, NO_DEALER_NAME })();
    return html;
  };
  assert.ok(draw(unnamed).includes(`<div class="banner bad" id="wizNoDealer" role="alert">${NO_DEALER_NAME}</div>`), 'the step says so');
  assert.ok(!draw(named).includes('wizNoDealer'), 'nothing to say when the website gives the name');

  // Next: with the name still blank the step stays and the name box gets the caret; once typed, set-up goes on
  const next = async (typed) => {
    const wiz = { active: true, step: 'address', site: unnamed, settings: null };
    const focused = [];
    let rendered = 0;
    let persisted = 0;
    const click = wizardFn('handleWizardClick', {
      wiz,
      readInputs: () => { wiz.settings = withDefaults({ dealer: { name: typed, city: 'Springfield', state: 'OH', zip: '43215' } }, wiz.site); },
      steps: () => list,
      stepIndex: () => list.indexOf(wiz.step),
      loadAccount: async () => {},
      persist: async () => { persisted += 1; },
      runScan: async () => { throw new Error('no scan from the address step'); },
      document: { getElementById: (id) => ({ focus: () => focused.push(id) }) },
      dealerNameMissing,
    });
    const handled = await click('wizNext', { render: () => { rendered += 1; }, setStatus: () => {}, onClose: () => {} });
    return { handled, step: wiz.step, focused, rendered, persisted, dealer: wiz.settings.dealer };
  };
  for (const typed of ['', '   ']) {
    const r = await next(typed);
    assert.equal(r.handled, true);
    assert.equal(r.step, 'address', `"${typed}": set-up waits for a name`);
    assert.deepEqual(r.focused, ['wizDealer']);
    assert.equal(r.rendered, 1, 'drawn again, with the banner');
    assert.equal(r.dealer.city, 'Springfield', 'what was typed is kept');
  }
  const r = await next('Example Motors');
  assert.equal(r.step, 'price', 'with a name set-up goes on');
  assert.equal(r.dealer.name, 'Example Motors');
  assert.deepEqual(r.focused, []);
  assert.equal(r.persisted, 1);
});
