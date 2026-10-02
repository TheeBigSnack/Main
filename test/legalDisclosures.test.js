// What the legal drafts and the store texts say Lot Current does on Facebook
// and on its own, held to the code. Each test reads the code fact first, so a
// change to the code fails here with the texts to update, and then reads the
// texts the attorney, Google's reviewer and the user are given.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

// The text from a "## " heading to the next "## " heading.
function section(text, heading) {
  const start = text.indexOf('\n' + heading + '\n');
  assert.ok(start >= 0, `no "${heading}" heading`);
  const rest = text.slice(start + heading.length + 2);
  const next = rest.search(/^## /m);
  return next >= 0 ? rest.slice(0, next) : rest;
}

// The cell after "| <first cell> |" on a table row whose first cell matches.
function rowText(text, firstCell) {
  const line = text.split('\n').find((l) => l.startsWith('| ' + firstCell + ' |'));
  assert.ok(line, `no table row for ${firstCell}`);
  return line;
}

test('the attorney\'s automated-means question says how the form is typed into and that a queue opens the next form without a click', () => {
  // the code: suggestion boxes are typed one character at a time with key events and a fixed pause
  const fill = read('extension/facebook/fillForm.js');
  assert.match(fill, /async function typeText\(el, value\) \{[\s\S]*?for \(const ch of String\(value\)\) \{[\s\S]*?key\(el, ch\)[\s\S]*?await sleep\(\d+\);/, 'fillForm.js no longer types character by character: update questions-for-attorney.md 1 and this test');
  assert.doesNotMatch(fill, /Math\.random/, 'a random delay would break rule 2; the texts say the pauses are fixed');
  // the code: in a queue a car that passes every check opens and fills the form with no click
  const panel = read('extension/sidepanel.js');
  assert.match(panel, /if \(state\.queueMode && canAutoOpen\(\)\)[^\n]*openForm\(/, 'the queue no longer opens the next form by itself: update questions-for-attorney.md 1, the scripting rows and this test');

  const q1 = section(read('legal/questions-for-attorney.md'), '## 1. Meta\'s Terms and Commerce Policies').split('\n').find((l) => l.includes('"using automated means"'));
  assert.ok(q1, 'questions-for-attorney.md 1 lost its automated-means question');
  assert.doesNotMatch(q1, /uses no delays/, 'the question says no delays while the fill pauses between characters');
  assert.match(q1, /one character at a time with key events/);
  assert.match(q1, /fixed pause/);
  assert.match(q1, /no randomized or "human-like" delays/);
  assert.match(q1, /queue/);
  assert.match(q1, /without another click/);
  assert.match(q1, /does the queue's opening and filling of the next car's form without a click change the answer\?/, 'the attorney is asked about the queue itself');

  // what Google's reviewer reads for the scripting permission
  const store = rowText(read('legal/chrome-web-store-privacy.md'), '`scripting`');
  const listing = rowText(read('store/listing.md'), '`scripting`');
  for (const [where, row] of [['legal/chrome-web-store-privacy.md', store], ['store/listing.md', listing]]) {
    assert.match(row, /queue/, `${where}: the scripting row leaves out the queue's forms`);
    assert.match(row, /without another click/, `${where}: the scripting row says every form is filled from a click`);
    assert.match(row, /to-do item/, `${where}: the scripting row leaves out the listing read and the price fill`);
    assert.doesNotMatch(row, /form (?:the person opened )?when (?:the user|they) click Post/, `${where}: the scripting row says the form is filled only on a click on Post`);
  }
  // and the data inventory the privacy texts follow
  const inventory = rowText(read('docs/data-inventory.md'), 'Fill the Marketplace form (`facebook/fillForm.js`)');
  assert.match(inventory, /in a queue the person started, each car that passes every check, without another click/);
});

test('the Terms say what Lot Current does with nobody at the computer: the rescan the User allowed and its upload, never Facebook', () => {
  // the code: an alarm rescans the websites the person allowed and, signed in, syncs the result
  const bg = read('extension/background.js');
  const rescan = bg.slice(bg.indexOf('async function runRescan'), bg.indexOf('async function rescanDueSites'));
  assert.ok(rescan.length > 100 && /\bsyncSite\(/.test(rescan), 'the background rescan no longer syncs: update the Terms and this test');
  assert.match(bg, /chrome\.alarms\.create\(RESCAN_ALARM, \{ periodInMinutes: RESCAN_PERIOD_MINUTES/);
  assert.match(read('extension/src/rescanSchedule.js'), /RESCAN_PERIOD_MINUTES = 180;/, 'the rescan is no longer every 3 hours: update the Terms and this test');
  assert.match(bg, /if \(!info\.auto\) continue;/, 'the rescan no longer waits for the person\'s allowing it: update the Terms and this test');

  const what = section(read('legal/terms-of-service.md'), '## 1. What Lot Current is');
  assert.doesNotMatch(what, /does not act while the User is away/, 'the Terms say Lot Current does nothing while the User is away');
  assert.match(what, /never acts on Facebook while the User is away/);
  assert.match(what, /If the User allows it, Lot Current re-reads the dealership's website every 3 hours while Chrome is open/);
  assert.match(what, /while the User is signed in, sends the results to the dealership's records/);
});

// Each function the extension runs in a Facebook tab, and the words the
// Facebook host justification uses for it. A new one fails here until the
// justification says what it does.
const FACEBOOK_FUNCS = {
  fillFormInPage: /fill(?:s)? the vehicle listing form/i,
  attachPhotosInPage: /attach(?:es)? the car's photos/,
  probeFormInPage: /check fields only, (?:to )?lists? that form's fields without filling them/,
  fillPriceInPage: /fill(?:s)? the new price on the listing's edit form/,
  readListingInPage: /reads? every 1\.5 seconds the Marketplace page[^|]*Your listings page when no (?:listing )?link was saved[^|]*title, (?:the )?prices/,
};

test('the Facebook host justification and the privacy texts name every read Lot Current makes on a Facebook page, the Your listings page among them', () => {
  // the code: the functions run in the tab Lot Current opened for a post or a to-do item
  const injected = new Set();
  for (const rel of ['extension/sidepanel.js', 'extension/upkeep.js', 'extension/popup.js', 'extension/background.js']) {
    for (const m of read(rel).matchAll(/executeScript\(\{ target: \{ tabId: (?:state\.fbTabId|up\.tabId) \}, func: (\w+)/g)) injected.add(m[1]);
  }
  assert.deepEqual([...injected].sort(), Object.keys(FACEBOOK_FUNCS).sort(), 'a function now runs in a Facebook tab that the justification does not describe, or one is gone: update FACEBOOK_FUNCS and the texts');
  const upkeep = read('extension/upkeep.js');
  assert.match(upkeep, /const url = up\.listingUrl \|\| map\.yourListingsUrl;/, 'a to-do item no longer falls back to Your listings: update the texts and this test');
  assert.match(upkeep, /setInterval\(\(\) => poll\(ctx\)[^\n]*, 1500\)/, 'the to-do read is no longer every 1.5 seconds: update the texts and this test');

  const store = rowText(read('legal/chrome-web-store-privacy.md'), 'Host `https://www.facebook.com/marketplace/*`');
  const listing = rowText(read('store/listing.md'), '`https://www.facebook.com/marketplace/*`');
  for (const [where, row] of [['legal/chrome-web-store-privacy.md', store], ['store/listing.md', listing]]) {
    for (const [func, words] of Object.entries(FACEBOOK_FUNCS)) assert.match(row, words, `${where}: the Facebook host row does not say what ${func} does`);
    assert.doesNotMatch(row, /No other Facebook pages? (?:is|are) read/, `${where}: the Facebook host row says no other page is read while a to-do item reads the listing or Your listings page`);
    assert.match(row, /sent nowhere/);
  }
  const content = read('legal/chrome-web-store-privacy.md').split('\n').find((l) => l.startsWith('- Website content:'));
  assert.match(content, /title, prices and sold or unavailable sign of the Marketplace page/, 'the Website content answer leaves out the listing read');
  assert.match(content, /Your listings page/);
  assert.match(read('store/listing.md'), /website content, yes \([^)]*title, prices and sold sign of the listing page or Your listings page/);

  // the privacy policy, the data inventory and the FAQ a salesperson reads
  const policy = read('legal/privacy-policy.md').split('\n').find((l) => l.startsWith('We do **not** collect Facebook passwords'));
  assert.match(policy, /title, prices and sold status shown on the Marketplace page in the tab Lot Current opened for it \(the listing, or Marketplace's Your listings page when no listing link was saved\)/);
  assert.match(rowText(read('docs/data-inventory.md'), 'Watch the tab and read a listing (`facebook/detectPost.js`, `readListingInPage`)'), /every 1\.5 seconds the title, prices and sold or unavailable sign[^|]*Your listings page when no listing link was saved/);
  const faq = read('site-src/pages/faq.html');
  const reads = faq.slice(faq.indexOf('<h3>What does it read?</h3>'), faq.indexOf('</article>', faq.indexOf('<h3>What does it read?</h3>')));
  assert.match(reads, /When you open a to-do item, it reads the Marketplace page it opened for it \(the listing, or your Your listings page when no listing link was saved\) for the title, prices and a sold sign/);
});

test('no text says Facebook gets nothing before Publish: the fill types into Facebook\'s own suggestion boxes and hands it the photos', () => {
  // the code: Location (and Make and Model) are suggestion boxes typed into, and the photos are put on the form's file input
  const map = read('extension/facebook/formMap.js');
  assert.match(map, /key: 'location', label: 'Location', kind: 'typeahead'/, 'Location is no longer a suggestion box: update the texts and this test');
  const fill = read('extension/facebook/fillForm.js');
  const attach = fill.slice(fill.indexOf('export async function attachPhotosInPage'));
  assert.match(attach, /input\.files = dt\.files;[\s\S]*?input\.dispatchEvent\(new Event\('change'/, 'the photos are no longer handed to the form\'s file input: update the texts and this test');

  const NOTHING = /sends nothing to Facebook|Nothing goes to Facebook|Facebook receives them only when|What Facebook receives then/;
  const texts = {
    'legal/privacy-policy.md': /Facebook's own page may send some of what is filled in to Facebook before the User publishes[^.]*suggestion box such as Location[^.]*attached photos; and Facebook may keep an unfinished listing as a draft/,
    'legal/chrome-web-store-privacy.md': /Facebook's own page may send some of what is filled in to Facebook before the user publishes[^.]*suggestion box such as Location[^.]*attached photos\), and Facebook may keep an unfinished listing as a draft/,
    'docs/data-inventory.md': /Facebook's own page may send some of that to Facebook before the person publishes[^|]*suggestion box such as Location[^|]*attached photos/,
    'legal/questions-for-attorney.md': /Facebook's own page may send some of what goes into its boxes to Facebook as it goes in[^.]*Location[^.]*attached photos, before the user publishes/,
  };
  for (const [rel, says] of Object.entries(texts)) {
    const text = read(rel);
    assert.doesNotMatch(text, NOTHING, `${rel} says Facebook gets nothing until Publish`);
    assert.match(text, says, `${rel} does not say what Facebook's own page may send before Publish`);
  }
});

test('every screenshot rule keeps Facebook\'s logo, wordmark and brand colour out of the store images, the real form\'s included', () => {
  // the rule the others follow: no Meta, Facebook or Marketplace logos or brand colours in screenshots or the store listing
  const rule = read('legal/trademark-note.md').split('\n').find((l) => l.includes('Never use the Facebook, Marketplace or Meta logos'));
  assert.match(rule, /brand colours/);
  assert.match(rule, /screenshots/);
  assert.match(rule, /the Chrome Web Store listing/);

  const shots = read('store/screenshots.md');
  const listing = read('store/listing.md');
  const listingShots = listing.slice(listing.indexOf('## Screenshots'), listing.indexOf('\n## ', listing.indexOf('## Screenshots') + 1));
  const notes = section(read('legal/chrome-web-store-privacy.md'), '## Notes for the listing text');
  for (const [where, text] of [['store/screenshots.md', shots], ['store/listing.md Screenshots', listingShots], ['legal/chrome-web-store-privacy.md notes', notes]]) {
    assert.doesNotMatch(text, /beyond what the page itself shows/, `${where} lets the real page's logo or colour into a store image`);
    assert.match(text, /logo/, `${where} says nothing about Facebook's logo`);
    assert.match(text, /wordmark/, `${where} says nothing about Facebook's wordmark`);
    assert.match(text, /below Facebook's top bar/, `${where} does not say a capture of the real form is cropped below Facebook's top bar`);
    assert.match(text, /Facebook-blue button|button or mark in Facebook's blue/, `${where} does not say Facebook's blue is covered`);
  }
  // the shot of the real form says it too
  const shot3 = shots.split('\n').find((l) => l.startsWith('| `3-form.png` |'));
  assert.match(shot3, /Crop below Facebook's top bar/);
});

test('the privacy texts say Anthropic\'s servers fetch and look at the colour-guess photos, not only receive their addresses', () => {
  // the code: the photos go to Anthropic as image links, which its servers fetch
  for (const rel of ['supabase/functions/rewrite/index.ts', 'backend/server.js']) {
    assert.match(read(rel), /type: 'image', source: \{ type: 'url', url \}/, `${rel} no longer sends the photos as links Anthropic fetches: update the texts and this test`);
  }
  const policy = read('legal/privacy-policy.md');
  const request = policy.split('\n').find((l) => l.startsWith('| Rewrite requests'));
  assert.match(request, /for a colour guess, up to four of the car's photo addresses, from which Anthropic's servers fetch those photos to look at them/);
  const processor = policy.split('\n').find((l) => l.startsWith('- **Anthropic**'));
  assert.match(processor, /from which its servers fetch those photos to look at them/);
  const sends = read('legal/chrome-web-store-privacy.md').split('\n').find((l) => l.startsWith('| Only with the description writer turned on'));
  assert.match(sends, /Anthropic's servers fetch the photos from those addresses/);
  assert.match(section(read('legal/terms-of-service.md'), '## 9. Privacy'), /for a colour guess, up to four of the car's photo addresses, from which Anthropic's servers fetch those photos/);
  // the data inventory's short version agrees with its own "Exactly what reaches Anthropic"
  const inventory = read('docs/data-inventory.md');
  assert.match(inventory, /^- \*\*Anthropic\*\* receives[^\n]*from which its servers fetch those photos/m);
  const never = inventory.split('\n').find((l) => l.startsWith('- **Never kept or sent anywhere:**'));
  assert.match(never, /the photos themselves \([^)]*the up to four photos Anthropic's servers fetch from their addresses for a colour guess/, 'the inventory says the photos are never sent anywhere, and Anthropic fetches them for a colour guess');
});

test('the subscription agreement says what removing a User does and does not do, and the attorney is asked where the Dealer\'s responsibility ends', () => {
  // the code: the account service turns a non-member away from sync and the description writer
  assert.match(read('supabase/functions/sync/index.ts'), /json\(req, 403, \{ ok: false, error: memberships\.length \? `your account is not a member of the dealership/, 'sync no longer refuses a removed member: update dealer-subscription-agreement.md 3 and this test');
  assert.match(read('supabase/functions/rewrite/index.ts'), /if \(!membership\) return json\(req, 403,/, 'the description writer no longer refuses a removed member: update dealer-subscription-agreement.md 3 and this test');
  // the code: reading the website and preparing a listing need no account
  for (const rel of ['extension/src/scanRunner.js', 'extension/src/vehicleDetails.js', 'extension/src/listingData.js', 'extension/facebook/fillForm.js']) {
    assert.doesNotMatch(read(rel), /accountFlow|currentSession|accountConfig/, `${rel} now depends on the account: removal may stop the extension, update dealer-subscription-agreement.md 3 and this test`);
  }

  const s3 = section(read('legal/dealer-subscription-agreement.md'), '## 3. Authorisation for staff to post');
  assert.match(s3, /Removing a User from the Dealer's account in the Service ends that person's syncing/, 'section 3 does not say what removing a User ends');
  assert.match(s3, /it does not stop the extension on that person's computer, which needs no account to read the Dealer's public website and prepare a listing/, 'section 3 lets the Dealer think removal stops the extension');
  const q7 = section(read('legal/questions-for-attorney.md'), '## 7. Employees posting from personal accounts');
  assert.match(q7, /Should the Dealer's responsibility for a person's conduct end at removal/, 'the attorney is not asked whether the Dealer\'s responsibility ends at removal');
});

test('while the subscription agreement promises a move to an official inventory feed, the attorney is asked whether it should bind Lot Current', () => {
  const s2 = section(read('legal/dealer-subscription-agreement.md'), '## 2. Authorisation to read the Dealer\'s website inventory');
  if (!/will move to an official inventory feed/.test(s2)) return;
  // the code: every reader is a website reader; none takes a feed the dealer or its provider supplies
  const index = read('extension/adapters/index.js');
  assert.doesNotMatch(index, /feed/i, 'an adapter for an inventory feed exists: say what it reads in dealer-subscription-agreement.md 2 and this test');
  const q3 = section(read('legal/questions-for-attorney.md'), '## 3. Reading dealer websites\' inventory search');
  assert.match(q3, /Should section 2 bind Lot Current to switch/, 'questions-for-attorney.md 3 does not ask whether the feed promise should bind Lot Current');
  assert.doesNotMatch(q3, /when we move to (?:an )?official inventory feeds?/i, 'questions-for-attorney.md 3 presumes the move to a feed that no reader is built or planned for');
});

test('while the published texts say they apply to no one and the pilot agreement says they apply, pilot salespeople stay signed out and the attorney is asked which text binds', async () => {
  const draft = JSON.parse(read('legal/legal-status.json')).draft === true;
  const { DRAFT_BANNER } = await import('../scripts/legal-pages.mjs');
  const s1 = section(read('legal/pilot-agreement.md'), '## 1. The pilot');
  const applies = /The Terms of Service, Privacy Policy[^.]*apply during the Pilot/.test(s1);
  if (!draft || !/nothing on this page applies to anyone yet/.test(DRAFT_BANNER) || !applies) return; // the two texts no longer disagree
  // the code: the shipped build offers sign-in, which sends the salesperson's details to the account service
  const { accountsConfigured } = await import('../extension/src/accountConfig.js');
  if (!accountsConfigured()) return;
  const pilot = read('PILOT.md');
  const before = pilot.slice(pilot.indexOf('### Before every pilot'), pilot.indexOf('## During the pilot'));
  assert.match(before, /^- \[ \] \*\*No sign-in while the texts are drafts\.\*\*[^\n]*Until the attorney answers `legal\/questions-for-attorney\.md` 10\.2, each salesperson clicks \*\*Skip for now\*\* at set-up's Account step and does not sign in/m, 'PILOT.md lets pilot salespeople sign in while the texts the pilot agreement applies say they apply to no one');
  // the day-0 email walks each salesperson through set-up, so it says the same at the Account step
  const day0 = section(read('marketing/onboarding-emails.md'), '## Day 0: install and set-up (10 minutes)');
  assert.match(day0, /your account \(click \*\*Skip for now\*\*: this pilot runs without Lot Current accounts, so don't sign in under Settings later either\)/, 'the day-0 email walks the salesperson through set-up without saying to skip the Account step');
  assert.match(pilot, /A second dealership runs on the Milestone 4 accounts[^\n]*once the Terms and Privacy Policy are final or the attorney has answered `legal\/questions-for-attorney\.md` 10\.2/, 'the second dealership\'s pilot runs on accounts before the texts are settled');
  const q10 = section(read('legal/questions-for-attorney.md'), '## 10. The Pilot Agreement\'s list of what is recorded');
  assert.match(q10, /^- \*\*10\.2\*\* Section 1 says the Terms of Service and the Privacy Policy apply during the Pilot, but the website publishes both as drafts marked "Not in effect/m, 'the attorney is not asked which text binds during a pilot signed before the texts are final');
});

// Automatic rescans are switched on, through Chrome's own permission prompt,
// in set-up and in the popup's Settings (the rescan box on Save, or Allow
// automatic rescans, which the To do tab also shows when the permission was
// removed). The answers Google's reviewer reads name every place, not set-up
// alone.
test('the Web Store answers name every place that turns automatic rescans on: set-up and the popup\'s Settings, the To do tab\'s button included', () => {
  // the code: set-up asks Chrome for the website's origins from its own click
  const wizard = read('extension/wizard.js');
  assert.match(wizard, /case 'wizGrant': \{[^]*?wiz\.granted = await askChrome\(origins\)/, 'set-up no longer asks Chrome for the rescan permission: update the alarms and https://*/* rows and this test');
  // the code: Settings asks for the same origins from Allow automatic rescans and from Save with the rescan box ticked
  const popup = read('extension/popup.js');
  const allow = popup.slice(popup.indexOf("case 'allowRescans': {"));
  assert.match(allow, /^case 'allowRescans': \{[^]*?askChrome\(rescanOrigins\(\)\)[^]*?autoRescan: true/, 'Allow automatic rescans no longer asks Chrome and switches rescans on: update these texts and this test');
  const save = popup.slice(popup.indexOf('async function onSettingsSubmit('));
  assert.match(save, /^async function onSettingsSubmit\([^]*?autoRescan: form\.get\('autoRescan'\) === 'on'[^]*?askChrome\(rescanOrigins\(\)\)/, 'saving Settings with the rescan box ticked no longer asks Chrome: update these texts and this test');
  const settings = popup.slice(popup.indexOf('<legend>Automatic rescans</legend>'));
  assert.match(settings, /^<legend>Automatic rescans<\/legend>[^]*?data-action="allowRescans"/, 'Settings no longer has an Allow automatic rescans button');
  assert.match(popup.slice(popup.indexOf('function scheduleBanner()')), /^function scheduleBanner\(\)[^]*?data-action="allowRescans"/, 'the To do banner no longer has an Allow automatic rescans button');

  const cws = read('legal/chrome-web-store-privacy.md');
  const listing = read('store/listing.md');
  for (const [where, text] of [['legal/chrome-web-store-privacy.md', cws], ['store/listing.md', listing]]) {
    for (const line of text.split('\n')) assert.doesNotMatch(line, /only for a website (?:the user|you|they) allowe?d? in the set-up wizard/i, `${where} says only set-up turns automatic rescans on: "${line.trim().slice(0, 100)}"`);
  }
  const alarms = rowText(cws, '`alarms`');
  assert.match(alarms, /set-up wizard, or in the popup's Settings/, 'the alarms row does not say Settings can turn automatic rescans on too');
  for (const [where, row] of [['legal/chrome-web-store-privacy.md', rowText(cws, 'Optional host `https://*/*`')], ['store/listing.md', rowText(listing, '`https://*/*` (optional)')]]) {
    assert.match(row, /The set-up wizard, and the popup's Settings when the (?:user|person) saves with the rescan box ticked or clicks Allow automatic rescans \(a button the To do tab also shows[^)]*\), request only the chosen dealership's website origin and its inventory-service origin/, `${where}: the https://*/* row does not name every place that asks for the website's origins`);
  }
  const tester = listing.split('\n').find((l) => l.includes('Background rescans happen only'));
  assert.ok(tester, 'store/listing.md no longer has its tester step about background rescans');
  assert.match(tester, /in the set-up wizard or in Settings/, 'the reviewer\'s tester step says only set-up turns automatic rescans on');
});

// The Terms name Pennsylvania law while the Subscription and Pilot Agreements
// leave the state blank; the Subscription Agreement's whole-agreement list
// takes in the Privacy Policy and the Terms' list does not; and the sections
// that end an agreement "on notice" say nowhere how notice is given. While any
// of that holds, the attorney is asked to make the three agree.
test('while the agreements differ on governing law or on what makes up the whole agreement, or none says how notice is given, the attorney is asked to settle it', () => {
  const tos = section(read('legal/terms-of-service.md'), '## 13. Changes, termination, general');
  const dsa = section(read('legal/dealer-subscription-agreement.md'), '## 9. General');
  const pilot = section(read('legal/pilot-agreement.md'), '## 7. General');
  const namesPennsylvania = /governed by the laws of the Commonwealth of Pennsylvania/.test(tos);
  const blankState = [dsa, pilot].filter((t) => /The law of \[state\] governs/.test(t)).length;
  const lawDiffers = namesPennsylvania && blankState > 0;
  const privacyInWhole = (t) => /Privacy Policy[^.]*are the whole agreement/.test(t);
  const wholeDiffers = privacyInWhole(dsa) !== privacyInWhole(tos);
  const all = ['legal/terms-of-service.md', 'legal/dealer-subscription-agreement.md', 'legal/pilot-agreement.md'].map(read).join('\n');
  const onNotice = /\bon notice\b/.test(all);
  const noticesClause = /\bnotices?\b[^.\n]*\b(?:given|sent|delivered|served) (?:by|to|at)\b/i.test(all);
  if (!lawDiffers && !wholeDiffers && !(onNotice && !noticesClause)) return; // the three agree: drop question 11.1 with this test
  const q11 = section(read('legal/questions-for-attorney.md'), '## 11. Where the agreements disagree or say nothing');
  const item = q11.split('\n').find((l) => l.startsWith('- **11.1**'));
  assert.ok(item, 'questions-for-attorney.md 11 does not ask the attorney to make the agreements agree');
  if (lawDiffers) {
    assert.match(item, /Terms of Service section 13 names Pennsylvania law/, 'question 11.1 does not say the Terms already name Pennsylvania');
    assert.match(item, /leaves the state as "\[state\]"/, 'question 11.1 does not say the other agreements leave the state blank');
    assert.match(item, /Should the three name one governing law and venue/);
  }
  if (wholeDiffers) {
    assert.match(item, /adds the Privacy Policy to its whole-agreement list/, 'question 11.1 does not say the whole-agreement lists differ');
    assert.match(item, /should the Privacy Policy be in every whole-agreement list or in none/);
  }
  if (onNotice && !noticesClause) assert.match(item, /none of the three says how notice is given/, 'question 11.1 does not say no agreement says how notice is given');
});

// Schedule A prices the extra seats a dealership buys at signing, and nothing
// in the Subscription Agreement or the Terms says how seats change during the
// term. The software never changes a subscription's seats (the manager view
// warns and says to ask; the Billing Portal cannot change a subscription; a
// second Checkout is refused), so a seat is added by hand on a manager's
// request, and whether it is prorated is the owner's choice, not yet made.
// While the agreement is silent, the attorney is asked how to say it.
test('while the subscription agreement says nothing about seats added during the term, the attorney is asked how it should, and the question says the software never adds one', () => {
  // the code: nothing in Lot Current adds a seat or changes what a dealership pays
  assert.match(read('manager/data.js'), /export const SEATS_NOT_ADDED = 'Lot Current never adds seats or changes what you pay on its own/, 'the manager view no longer says Lot Current never adds seats: update question 11.2 and this test');
  assert.match(read('scripts/stripe-setup-lib.mjs'), /subscription_update: \{ enabled: false \}/, 'the Billing Portal can now change a subscription: update question 11.2 and this test');
  assert.match(read('supabase/functions/_shared/billing.mjs'), /already has a subscription[^']*to change seats, ask your Lot Current contact/, 'a running subscription can now change seats through Checkout: update question 11.2 and this test');

  const dsa = read('legal/dealer-subscription-agreement.md');
  const fees = section(dsa, '## 5. Fees') + section(dsa, '## Schedule A: rooftops, websites and fees');
  if (/seats?[^.]*(?:added|prorat|next billing period|during the term)/i.test(fees)) return; // the agreement now says it: drop question 11.2 with this test
  const q11 = section(read('legal/questions-for-attorney.md'), '## 11. Where the agreements disagree or say nothing');
  const item = q11.split('\n').find((l) => l.startsWith('- **11.2**'));
  assert.ok(item, 'questions-for-attorney.md 11 does not ask how seats change during the term');
  assert.match(item, /Nothing in either says how seats change during the term/);
  assert.match(item, /The software never adds a seat or changes what a dealership pays on its own/);
  assert.match(item, /a seat is added only when a manager asks and Lot Current changes the subscription by hand in Stripe/);
  assert.match(item, /prorated from the day it is added or only from the next billing period is the owner's commercial choice, not yet made/);
});

// The dry run (Open the form and check fields only) reads the Marketplace
// form page: its address, title and language, the names of up to 100 visible
// controls anywhere on it and 200 characters next to the photo box. The side
// panel keeps that with the post under way, and Copy report puts all of it on
// the clipboard for a support message. The privacy texts say so, and the
// support steps ask the person to read it before sending.
test('the privacy texts name what the dry-run report holds from the Facebook page, and support asks the person to read it before sending', () => {
  // the code: what the probe returns, that the panel keeps it, and that Copy report copies it whole
  const fill = read('extension/facebook/fillForm.js');
  const probe = fill.slice(fill.indexOf('export function probeFormInPage('), fill.indexOf('\n}\n', fill.indexOf('export function probeFormInPage(')));
  assert.match(probe, /return \{ url: location\.href, language: [^}]*title: document\.title,[^}]*controls,[^}]*photoText/, 'the dry run no longer returns the page address, title, controls and photo text: update the texts and this test');
  assert.match(probe, /\.slice\(0, 100\);/, 'the dry run no longer keeps up to 100 controls: update the texts and this test');
  assert.match(probe, /\.slice\(0, 200\) : ''/, 'the dry run no longer keeps 200 characters next to the photo box: update the texts and this test');
  const panel = read('extension/sidepanel.js');
  assert.match(panel, /const FLOW_FIELDS = \[[^\]]*'probe'/, 'the side panel no longer keeps the dry-run report with the post: update the texts and this test');
  assert.match(panel, /case 'copyReport': return copy\(JSON\.stringify\(state\.probe/, 'Copy report no longer copies the dry-run report: update the texts and this test');

  const what = /address, title and language, the names of the fields found and of up to 100 visible controls on that page, which can include Facebook's own menus, and up to 200 characters of the text next to its photo box/;
  const policy = read('legal/privacy-policy.md');
  assert.match(rowText(policy, 'Support messages (name, dealership, role, email, phone, what the message says, and any problem report the User pastes in: the versions, the dealership website\'s address and platform, the last scan and its errors, the counts on each tab, which form fields the last fill could not do, the Chrome version and time zone; and the report of the dry run, Open the form and check fields only, if the User pastes that in: the Marketplace form page\'s address, title and language, the names of the fields found and of up to 100 visible controls on that page, which can include Facebook\'s own menus, and up to 200 characters of the text next to its photo box)'), /Our inbox and the support log/);
  const facebook = policy.split('\n').find((l) => l.startsWith('We do **not** collect Facebook passwords'));
  assert.doesNotMatch(facebook, /From Facebook pages Lot Current keeps only the listing address the User saves or Lot Current detects on the User's own tab\./, 'the policy says only the listing address is kept from Facebook pages while the dry run keeps what it read');
  assert.match(facebook, /after Open the form and check fields only, what that check read on the form page \(listed under Support messages above\), which stays with the post under way and leaves the browser only if the User copies the report into a message/);
  const content = read('legal/chrome-web-store-privacy.md').split('\n').find((l) => l.startsWith('- Website content:'));
  assert.match(content, what, 'the Web Store\'s Website content answer leaves out what the dry run reads');
  assert.match(content, /sent nowhere unless the user copies the report into a message/);
  const inventory = read('docs/data-inventory.md');
  assert.match(rowText(inventory, '`postFlow:<origin>`'), /the dry run's report \(Open the form and check fields only: the form page's address, title and language/, 'the data inventory\'s postFlow row leaves out the dry-run report');
  assert.match(inventory, /^- \*\*Copy report\*\* \(side panel, after \*\*Open the form and check fields only \(nothing filled\)\*\*, `copyReport` in `extension\/sidepanel\.js`\): [^\n]*up to 100 visible controls on that page[^\n]*the person pastes it into a message to support\./m, 'the data inventory does not list what Copy report puts on the clipboard');
  assert.match(read('docs/support.md'), /The dry run's report also holds the form page's address and title and the names of up to 100 controls on that page, which can include Facebook's own menus: ask the person to read it before sending and take out anything personal/);
  assert.match(read('docs/help.md'), /\*\*Copy report\*\* on the result \(read it before you send it: it holds the form page's address and title and the names of the controls on that page/);
});
