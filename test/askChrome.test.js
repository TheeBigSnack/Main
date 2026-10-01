// The one place Lot Current asks Chrome for a host permission (src/askChrome.js):
//   - it asks only for single named http or https hosts, each for its whole
//     site, and refuses the whole list, without a prompt, when anything in it
//     is a Facebook server, a wildcard, another scheme or path, or nothing;
//   - Chrome is asked before anything is awaited, so the click still counts;
//   - a caller's list that gains a Facebook host, the way a change to the
//     wizard's or the popup's list would add one, is refused at the ask;
//   - the popup's list (rescanOrigins) and the wizard's Allow click, run as
//     written, name the website and its service, and put nothing to Chrome
//     for a site or service on Facebook's servers.
// That every ask in the extension goes through it is checked in
// marketing.test.js (the prompt inventory) and photoHosts.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './helpers.js';
import { askableOrigins, askChrome } from '../extension/src/askChrome.js';
import { originsFor } from '../extension/src/rescanSchedule.js';
import { NHTSA_ORIGIN } from '../extension/src/vin.js';

const ANY = '/' + '*';
const DEALER = 'https://www.dealer.test';
const SERVICE = 'https://inventory.dealer-platform.test';

// A stand-in for chrome.permissions.request that records what it was asked and answers as told.
async function withChrome(answer, run) {
  const asked = [];
  const before = globalThis.chrome;
  globalThis.chrome = { permissions: { request: (p) => { asked.push(p); return Promise.resolve(answer); } } };
  try {
    return await run(asked);
  } finally {
    if (before === undefined) delete globalThis.chrome;
    else globalThis.chrome = before;
  }
}

test('askableOrigins: named http and https hosts, each for its whole site, come back as given', () => {
  const lists = [
    [DEALER + ANY, SERVICE + ANY],
    [NHTSA_ORIGIN + ANY],
    ['https://img.cdn.example' + ANY, 'https://photos.dealer.test:8443' + ANY],
    ['http://127.0.0.1:5173' + ANY], // the mock sites the end-to-end tests read
    ['https://[2001:db8::1]:8443' + ANY],
    // look-alikes are other people's servers, not Facebook's
    ['https://notfacebook.com' + ANY, 'https://facebook.com.dealer.test' + ANY, 'https://fbcdn.net.example' + ANY],
  ];
  for (const list of lists) {
    const out = askableOrigins(list);
    assert.deepEqual(out, list, list.join(' '));
    assert.notEqual(out, list, 'a copy, so a later change to the caller\'s list asks for nothing new');
  }
});

test('askableOrigins: a list with any Facebook server in it is refused whole', () => {
  const facebook = [
    'https://www.facebook.com', 'https://facebook.com', 'https://m.facebook.com', 'https://WWW.FACEBOOK.COM',
    'https://www.facebook.com.', 'http://www.facebook.com', 'https://www.facebook.com:443',
    'https://scontent-iad3-1.xx.fbcdn.net', 'https://lookaside.fbsbx.com', 'https://www.messenger.com',
    'https://fb.com', 'https://connect.facebook.net',
  ];
  for (const origin of facebook) {
    assert.equal(askableOrigins([origin + ANY]), null, origin);
    assert.equal(askableOrigins([DEALER + ANY, origin + ANY, SERVICE + ANY]), null, `${origin} among the dealer's own`);
  }
});

test('askableOrigins: nothing, wildcards, other schemes, paths and anything not a pattern are refused', () => {
  const refused = [
    undefined, null, DEALER + ANY, {}, [], [''], [null], [42], [{ origin: DEALER }],
    ['<all_urls>'], ['https://' + '*' + ANY], ['*://www.dealer.test' + ANY], ['https://' + '*.dealer.test' + ANY], ['https://www.*.test' + ANY],
    ['file://' + ANY], ['chrome-extension://abcdefghijklmnop' + ANY], ['ftp://www.dealer.test' + ANY], ['wss://www.dealer.test' + ANY],
    [DEALER + '/'], [DEALER], [DEALER + '/used-vehicles' + ANY], [DEALER + ANY + '?q'], ['https://user@www.dealer.test' + ANY],
    ['https://www.dealer.test:' + ANY], ['https://www.dealer.test:123456' + ANY], [' ' + DEALER + ANY],
    [DEALER + ANY, '<all_urls>'],
  ];
  for (const list of refused) assert.equal(askableOrigins(list), null, JSON.stringify(list));
});

test('askChrome asks Chrome before it returns, for exactly the list, and resolves Chrome\'s answer', async () => {
  for (const answer of [true, false]) {
    await withChrome(answer, async (asked) => {
      const list = [DEALER + ANY, SERVICE + ANY];
      const reply = askChrome(list);
      assert.deepEqual(asked, [{ origins: list }], 'Chrome was asked before askChrome returned: nothing was awaited first');
      assert.ok(reply instanceof Promise);
      assert.equal(await reply, answer);
    });
  }
});

test('askChrome resolves false without asking Chrome when the list is refused', async () => {
  await withChrome(true, async (asked) => {
    for (const list of [[], undefined, ['https://www.facebook.com' + ANY], [DEALER + ANY, 'https://www.facebook.com' + ANY], ['https://' + '*' + ANY]]) {
      const reply = askChrome(list);
      assert.ok(reply instanceof Promise, 'a refusal is an answer like Chrome\'s, never a throw');
      assert.equal(await reply, false, JSON.stringify(list));
    }
    assert.deepEqual(asked, [], 'Chrome was never asked');
  });
});

// The wizard asks for originsFor(site, service) and the popup for the same
// list (rescanOrigins). A change that adds Facebook to either list, after
// originsFor has dropped it, is refused at the ask whatever the list is called.
test('a website list that gains a Facebook host on its way to Chrome is refused at the ask', async () => {
  const own = originsFor({ origin: DEALER }, [SERVICE + '/inventory/search']);
  assert.deepEqual(own, [DEALER + ANY, SERVICE + ANY]);
  await withChrome(true, async (asked) => {
    assert.equal(await askChrome([...own, 'https://www.facebook.com/' + '*']), false, 'the website plus all of www.facebook.com is not asked for');
    assert.equal(await askChrome([...own, 'https://www.messenger.com' + ANY]), false);
    assert.equal(await askChrome(own), true, 'the website itself is');
    assert.deepEqual(asked, [{ origins: own }], 'only the website was ever put to Chrome');
  });
});

// The popup asks for rescanOrigins() from its Allow automatic rescans button
// and its Save (the prompt inventory in marketing.test.js holds it to those
// two calls). Run as written: a dealer website's list is the website and its
// service, which the gate lets through; a site on Facebook's servers, or no
// site yet, is an empty list, which the gate refuses without a prompt.
test('the popup asks Chrome for what originsFor names for the website, and a Facebook site\'s list is empty', () => {
  const src = stripComments(readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8'));
  const m = src.match(/^const rescanOrigins = \(\) => ([^\n]+);$/m);
  assert.ok(m, 'popup.js defines rescanOrigins on one line: fix this test');
  const rescanOrigins = (state) => new Function('state', 'originsFor', `return ${m[1]};`)(state, originsFor);
  const dealer = rescanOrigins({ origin: DEALER, site: { site: { origin: DEALER }, service: [SERVICE + '/inventory/search'] } });
  assert.deepEqual(dealer, [DEALER + ANY, SERVICE + ANY], 'the website and its inventory service, nothing else');
  assert.deepEqual(askableOrigins(dealer), dealer, 'which the gate lets through');
  assert.deepEqual(rescanOrigins({ origin: DEALER, site: { service: null } }), [DEALER + ANY], 'a registry entry without its site record falls back to the tab\'s website');
  for (const state of [
    { origin: 'https://www.facebook.com', site: { site: { origin: 'https://www.facebook.com' }, service: null } },
    { origin: DEALER, site: { site: { origin: DEALER }, service: ['https://www.facebook.com/marketplace/api'] } },
    { origin: DEALER, site: null },
  ]) {
    const list = rescanOrigins(state);
    assert.deepEqual(list, [], JSON.stringify(state));
    assert.equal(askableOrigins(list), null, 'and the gate asks Chrome nothing for it');
  }
});

// The wizard's "Allow automatic rescans" click, run as written (wizard.js
// handleWizardClick) with Chrome and the page replaced by stand-ins: it puts
// the website to Chrome, and for a site or service on Facebook's servers it
// puts nothing to Chrome at all, not even an empty request, so the wizard
// never says rescans are on for a site the worker may not read; the step says
// rescans stay off for that website instead of offering the button.
test('the wizard\'s Allow automatic rescans click asks Chrome for the website and never for a Facebook host', async () => {
  globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
  const { wiz, handleWizardClick, wizardHtml } = await import('../extension/wizard.js');
  const click = async (site, service) => withChrome(true, async (asked) => {
    const saved = [];
    globalThis.chrome.storage = { local: { set: async (o) => { saved.push(o); } } };
    Object.assign(wiz, { active: true, origin: site.origin, step: 'permission', site, service, settings: {}, granted: false, error: '' });
    let rendered = 0;
    await handleWizardClick('wizGrant', { render: () => { rendered += 1; }, setStatus: () => {} });
    assert.equal(rendered, 1, 'the step is drawn again with the answer');
    assert.equal(saved.length, 1, 'the answer is saved with the wizard');
    return { asked, granted: wiz.granted, error: wiz.error };
  });
  try {
    assert.deepEqual(await click({ origin: DEALER }, [SERVICE + '/inventory/search']), { asked: [{ origins: [DEALER + ANY, SERVICE + ANY] }], granted: true, error: '' });
    for (const [site, service] of [
      [{ origin: 'https://www.facebook.com' }, null],
      [{ origin: DEALER }, ['https://www.facebook.com/marketplace/api']],
      [{ origin: DEALER }, ['https://www.messenger.com/api']],
    ]) {
      const r = await click(site, service);
      assert.deepEqual(r.asked, [], `Chrome is asked nothing for ${site.origin} with ${service}`);
      assert.equal(r.granted, false, 'and the wizard does not say rescans are on');
      // the step says rescans stay off for this website and offers no Allow button
      const html = wizardHtml();
      assert.doesNotMatch(html, /id="wizGrant"|Automatic rescans are on|permission to read/);
      assert.match(html, /can't read this website in the background, so automatic rescans stay off for it/);
    }
    // a dealer website's step names it and offers the button until Chrome says yes
    Object.assign(wiz, { site: { origin: DEALER }, service: null, granted: false });
    assert.match(wizardHtml(), /permission to read <b>https:\/\/www\.dealer\.test<\/b> in the background[\s\S]*id="wizGrant"/);
  } finally {
    delete globalThis.document;
  }
});
