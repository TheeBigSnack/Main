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
  // review: Q1 described the listing-page read as part of the queue only, while the panel reads the listing page
  // after every post (sidepanel.js startWatcher: confirmIfThisCar for every listing) to offer its address as the car's link
  assert.match(panel, /if \(r\.status === 'listing'\) \{[\s\S]{0,300}?return confirmIfThisCar\(/, 'the listing page a post reached is no longer read after every post: update questions-for-attorney.md 1 and this test');
  assert.match(q1, /After every post, in a queue or not, it watches the tab it opened for the post for up to 30 minutes, and if that tab reaches a Marketplace listing page before it reaches Your listings \(normally the listing just published, but it is whichever listing page that tab reaches first\), it reads that page a few times while it loads, clicking nothing on it: whether its text holds the car's VIN, or the car's name and the price filled in, a sold or unavailable sign, and whether a listing form is still on the page\. When the side panel is reopened or opened in another window while the post still waits for Publish, it watches that tab again in the same way, and reads whichever listing page the tab then shows or next reaches\./, 'Q1 says when the listing page is read: the watch stops at Your listings and after 30 minutes (detectPost.js watchForListing), and a reopened panel watches again only while the post waits for Publish (resumeFlow)');
  assert.match(q1, /Only the page's address and whether it showed this car are kept, with the post under way in the browser's own storage \(by the side panel of the post's own window\); the rest of what it reads is discarded and never sent\. When the page shows this car, the side panel offers that address as the car's listing link, and once it is kept \(the user's It's posted, or by itself in a queue\), the address is part of the posted list that sync sends when the user is signed in\. In a queue, it then records the car and moves on/, 'Q1 says what is kept of the listing-page read: confirmIfThisCar keeps the watcher\'s address and a verified or unverified mark, saved only in the post\'s own window');
  assert.doesNotMatch(q1, /What it reads is kept with the post under way/, 'Q1 says everything read off the listing page is kept, while only its address and whether it showed the car are');

  // what Google's reviewer reads for the scripting permission
  const store = rowText(read('legal/chrome-web-store-privacy.md'), '`scripting`');
  const listing = rowText(read('store/listing.md'), '`scripting`');
  for (const [where, row] of [['legal/chrome-web-store-privacy.md', store], ['store/listing.md', listing]]) {
    assert.match(row, /queue/, `${where}: the scripting row leaves out the queue's forms`);
    assert.match(row, /without another click/, `${where}: the scripting row says every form is filled from a click`);
    assert.match(row, /to-do item/, `${where}: the scripting row leaves out the listing read and the price fill`);
    // the queue's read of the listing page after Publish, and the advance it decides (sidepanel.js: readListingInPage on the post tab)
    assert.match(row, /publish[^;]*(?:to read|reads) (?:that|the) listing page/, `${where}: the scripting row leaves out the read of the listing page after Publish`);
    assert.match(row, /VIN[^|;]*name and the price filled in[^|;]*sold[^|;]*listing form is still/, `${where}: the scripting row does not say what the listing read looks for`);
    assert.match(row, /in a queue, records the post and moves on[^|;]*only when the page shows that car/, `${where}: the scripting row leaves out the queue's conditional advance`);
    assert.match(row, /sen(?:t|ding) nowhere|sending nothing anywhere/, `${where}: the scripting row does not say the listing read is sent nowhere`);
    assert.doesNotMatch(row, /form (?:the person opened )?when (?:the user|they) click Post/, `${where}: the scripting row says the form is filled only on a click on Post`);
  }
  // review: Q1 and the scripting row named "Post selected", the label the popup's button shows while it is disabled,
  // and left out Queue all N ready arrivals on the To do tab, which starts the same queue
  const popup = read('extension/popup.js');
  assert.match(popup, /: 'Post selected'\);/, 'the popup\'s queue button changed its idle label: check these texts');
  assert.match(popup, /`Post \$\{state\.picked\.size\} car\$\{/, 'the popup\'s queue button no longer reads Post N cars');
  assert.match(popup, />Queue all \$\{ready\.length\} ready arrivals</, 'the To do tab no longer has Queue all N ready arrivals');
  assert.match(panel, />Post the next \$\{vins\.length\}</, 'the side panel no longer has Post the next N');
  const scripting = rowText(read('legal/chrome-web-store-privacy.md'), '`scripting`');
  for (const [where, text] of [['questions-for-attorney.md 1', q1], ['the Web Store scripting row', scripting]]) {
    assert.doesNotMatch(text, /Post selected/, `${where} names Post selected, the label of a button that starts nothing`);
    for (const label of [/Post N cars/, /Queue all N ready arrivals/, /Post the next N/]) assert.match(text, label, `${where} does not name ${label} among the queue's starts`);
  }
  // the code: after Publish the post tab's listing page is read, and in a queue the post is recorded (and the queue moves on) only when it shows the car
  assert.match(panel, /executeScript\(\{ target: \{ tabId(?:: \w+)? \}, func: readListingInPage/, 'the listing page after Publish is no longer read: update the scripting rows and this test');
  const store2 = rowText(read('store/listing.md'), '`https://www.facebook.com/marketplace/*`');
  assert.match(store2, /notices when the tab shows the published listing's address and then reads that listing page/, 'store/listing.md: the Facebook host row leaves out the read of the listing page after Publish');
  const faq = read('site-src/pages/faq.html');
  assert.match(faq, /After you click Publish, it reads the listing page that tab goes to/, 'the FAQ leaves out the read of the listing page after Publish');
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
  // review: "never acts on Facebook while the User is away" was absolute too: after a Publish the queue opens and
  // fills the next car's form with no new click, and an open to-do item reads its listing page, whoever is there
  const panel = read('extension/sidepanel.js');
  assert.match(panel, /if \(state\.queueMode && canAutoOpen\(\)\)[^\n]*openForm\(/, 'the queue no longer opens the next form by itself: the Terms can change');
  assert.doesNotMatch(what, /never acts on Facebook while the User is away/, 'the Terms say Lot Current does nothing on Facebook while the User is away, while a queue opens and fills the next form by itself');
  assert.match(what, /never posts or edits a listing in the background or while the User is away/);
  assert.match(what, /It acts on Facebook only in a tab it opened for a post or a to-do item the User started/);
  assert.match(what, /in a queue the User started it opens and fills the next car's form, without another click, once the User has published the previous one/);
  assert.match(what, /If the User allows it, Lot Current re-reads the dealership's website every 3 hours while Chrome is open/);
  assert.match(what, /while the User is signed in to a Lot Current account, sends that rescan's results to the dealership's records/);
});

// The posted list keeps, for a listing the person marked posted, whether it
// had gone up before that day (`listedBefore`: left out of the daily cap,
// and synced as listed_before), and the day's post log keeps each post made
// that day, so the cap still counts a listing taken down or unmarked the
// same day. The privacy policy and the store privacy form name both, for
// the browser's copy and for the synced one.
test('the privacy texts name the posted list\'s before-that-day mark, and say the cap counts a listing taken down or unmarked the same day', () => {
  // the code
  assert.match(read('extension/src/cap.js'), /p\.listedBefore === true/, 'the cap no longer leaves out a listing marked as made before that day: update the texts and this test');
  assert.match(read('extension/src/sync.js'), /listed_before: e\.listedBefore === true/, 'the before-that-day mark no longer syncs: update the texts and this test');
  assert.match(read('extension/src/cap.js'), /export function dayLog\(/, 'the cap no longer keeps the day\'s post log: update the texts and this test');
  // the privacy policy
  const policy = read('legal/privacy-policy.md').split('\n').find((l) => l.startsWith('| Posted-listing registry'));
  assert.ok(policy, 'the privacy policy has a row for the posted list');
  assert.match(policy, /whether a listing the User marked posted had gone up before that day/);
  assert.match(policy, /the daily cap still counts a listing taken down or unmarked the same day/);
  // the store privacy form: the browser's copy and the synced one
  const form = read('legal/chrome-web-store-privacy.md');
  const storage = rowText(form, '`storage`');
  assert.match(storage, /whether a listing the user marked posted had gone up before that day/, 'the storage row leaves out the before-that-day mark');
  assert.match(storage, /the daily cap still counts a listing taken down or unmarked the same day/, 'the storage row leaves out unmarked posts');
  const synced = form.split('\n').find((l) => l.startsWith('| While signed in:'));
  assert.match(synced, /The user's posted list \([^)]*whether a listing the user marked posted had gone up before that day/, 'the sync row leaves out the before-that-day mark');
  // and the data inventory they follow
  assert.match(rowText(read('docs/data-inventory.md'), '`posted:<origin>`'), /whether the salesperson said a listing they marked had gone up before that day/);
});

// What sync writes for a listing, column by column (src/sync.js toServerRows,
// the function's own copy in supabase/functions/sync/index.ts), and for a
// scan (scanRow). Review: the store form's sync row named the before-that-day
// mark but not the price basis (migration 0015), and the data inventory's
// sync row the basis but not the before-that-day mark. A new column fails
// here until the texts that list what sync sends name it.
const LISTING_COLUMN_WORDS = {
  dealership_id: null, // whose records: each row says "for the user's dealership" / "Our database (Supabase)"
  user_id: null, // the signed-in person's own entries
  vin: /\bVIN\b/,
  name: /car name/,
  price: /price/,
  posted_at: /times|when posted/,
  updated_at: /times|updated/,
  status: /times|when posted/, // 'listed' until the entry leaves the list; the function then marks it taken down, with the time
  taken_down_at: /times|when posted/,
  listed_before: /whether a listing (?:the user|they) marked posted had gone up before that day/,
  basis: /website's main price or its lower second price|which of the website's two prices/,
  listing_url: /listing link/,
  salesperson: /salesperson name/,
};

test('the texts that list what sync sends name every column it writes for a listing, the price basis and the before-that-day mark among them, and a scan\'s held-back mark', async () => {
  const { toServerRows, scanRow } = await import('../extension/src/sync.js');
  const entry = { name: 'A', price: 1, basis: 'beforeFees', postedAt: '2026-11-16T09:00:00.000Z', updatedAt: '2026-11-16T10:00:00.000Z', listingUrl: 'https://www.facebook.com/marketplace/item/1/', salesperson: 'Sam', listedBefore: true };
  const [row] = toServerRows({ posted: { TESTVIN00000000A1: entry }, dealershipId: 'd', userId: 'u' }).listings;
  assert.deepEqual(Object.keys(row).sort(), Object.keys(LISTING_COLUMN_WORDS).sort(), 'sync writes a listing column these texts are not checked for: name it in the store form\'s sync row and the data inventory\'s, then here');
  // the function writes the same columns (its copy of toServerRows)
  const fn = read('supabase/functions/sync/index.ts');
  for (const col of Object.keys(LISTING_COLUMN_WORDS)) assert.match(fn, new RegExp(`\\b${col}:`), `the sync function no longer writes ${col}`);
  const scan = scanRow({ takenAt: '2026-11-16T11:00:00.000Z', cars: 3, ready: 2, takeDownCount: 0, priceUpdateCount: 0, withheld: true }, { origin: 'https://dealer.test', dealershipId: 'd' });
  assert.equal(scan.withheld, true, 'a held-back scan no longer goes up marked: update the texts and this test');

  const store = read('legal/chrome-web-store-privacy.md').split('\n').find((l) => l.startsWith('| While signed in:'));
  const inventory = rowText(read('docs/data-inventory.md'), 'Sync (`src/accountFlow.js` `syncOnce`, `src/sync.js` `syncPayload`)');
  const lists = [
    ['legal/chrome-web-store-privacy.md (sync row)', store.match(/The user's posted list \(([^)]*)\)/)?.[1]],
    ['docs/data-inventory.md (Sync row)', inventory.match(/`posted` \(the person's own entries: ([^)]*)\)/)?.[1]],
  ];
  for (const [where, listed] of lists) {
    assert.ok(listed, `${where}: no list of the posted-list fields sync sends`);
    for (const [col, words] of Object.entries(LISTING_COLUMN_WORDS)) if (words) assert.match(listed, words, `${where} does not name the listing column ${col} that sync writes`);
  }
  assert.match(store, /scan's counts \(marked as held back for a scan that looked like a website hiccup\)/, 'the store form\'s sync row leaves out the held-back mark');
  assert.match(inventory, /`withheld` for a scan held back as a likely website hiccup/, 'the data inventory\'s sync row leaves out the held-back mark');
  // the browser's copy of the posted list keeps the basis too (src/rescan.js markPosted)
  assert.match(rowText(read('legal/chrome-web-store-privacy.md'), '`storage`'), /posted list \(each car's VIN, name, posted price and whether it is the website's main price or its lower second price,/, 'the storage row leaves out the price basis each listing was posted at');
});

// Each function the extension runs in a Facebook tab, and the words the
// Facebook host justification uses for it. A new one fails here until the
// justification says what it does.
const FACEBOOK_FUNCS = {
  fillFormInPage: /fill(?:s)? the vehicle listing form/i,
  attachPhotosInPage: /attach(?:es)? the car's photos/,
  probeFormInPage: /check fields only(?: \(nothing filled\)\*\*)?, (?:to )?lists? that form's fields without filling them/,
  fillPriceInPage: /fill(?:s)? the new price on the listing's edit form/,
  // store/listing.md says 'repeatedly': the listing copy carries no timing figures (test/honesty.js)
  readListingInPage: /reads? (?:every 1\.5 seconds|repeatedly) the Marketplace page[^|]*Your listings page when no (?:listing )?link was saved[^|]*title, (?:the )?prices/,
};

test('the Facebook host justification and the privacy texts name every read Lot Current makes on a Facebook page, the Your listings page among them', () => {
  // the code: the functions run in the tab Lot Current opened for a post or a to-do item
  const injected = new Set();
  for (const rel of ['extension/sidepanel.js', 'extension/upkeep.js', 'extension/popup.js', 'extension/background.js']) {
    // the form's tab as state.fbTabId, or as the copy of it a fill or a listing read keeps (tabId, fbTabId) so it acts only on this car's tab
    for (const m of read(rel).matchAll(/executeScript\(\{ target: \{ tabId(?:: (?:state\.fbTabId|fbTabId|up\.tabId))? \}, func: (\w+)/g)) injected.add(m[1]);
  }
  assert.deepEqual([...injected].sort(), Object.keys(FACEBOOK_FUNCS).sort(), 'a function now runs in a Facebook tab that the justification does not describe, or one is gone: update FACEBOOK_FUNCS and the texts');
  const upkeep = read('extension/upkeep.js');
  assert.match(upkeep, /const url = up\.listingUrl \|\| map\.yourListingsUrl;/, 'a to-do item no longer falls back to Your listings: update the texts and this test');
  assert.match(upkeep, /setInterval\(\(\) => poll\(ctx\)[^\n]*, 1500\)/, 'the to-do read is no longer every 1.5 seconds: update the texts and this test');

  const store = rowText(read('legal/chrome-web-store-privacy.md'), 'Host `https://www.facebook.com/marketplace/*`');
  const listing = rowText(read('store/listing.md'), '`https://www.facebook.com/marketplace/*`');
  // the help's install section says what Chrome's warning about that host covers, as the two rows do
  const help = read('docs/help.md').split('\n').find((l) => l.startsWith('Chrome says the extension can read and change data on `www.facebook.com/marketplace`'));
  assert.ok(help, 'docs/help.md no longer explains the Facebook host permission');
  // the listing page a post's tab reached is read in a queue or not (sidepanel.js startWatcher: confirmIfThisCar for every listing)
  assert.match(read('extension/sidepanel.js'), /if \(r\.status === 'listing'\) \{[\s\S]{0,300}?return confirmIfThisCar\(/, 'the listing page a post reached is no longer read, or only in a queue: update the texts and this test');
  for (const [where, row] of [['legal/chrome-web-store-privacy.md', store], ['store/listing.md', listing], ['docs/help.md', help]]) {
    for (const [func, words] of Object.entries(FACEBOOK_FUNCS)) assert.match(row, words, `${where}: the Facebook host row does not say what ${func} does`);
    assert.match(row, /notices? when the tab shows the published listing's address/, `${where}: the Facebook host row does not say the tab is watched for the listing's address`);
    assert.match(row, /listing's address(?: and then|; once that tab shows a listing's address,)[^;]* read(?:s)? that listing page a few times/, `${where}: the Facebook host row does not say the listing page a post reached is read`);
    assert.doesNotMatch(row, /in a queue, [^;]*read(?:s)? that listing page/, `${where}: the Facebook host row says only a queue reads the listing page, while every post's is read`);
    assert.match(row, /offer(?:s|ing)? that (?:listing's )?address as the car's link/, `${where}: the Facebook host row does not say the address is offered as the car's link only when the page shows the car`);
    assert.match(row, /in a queue,? [^;]*record/, `${where}: the Facebook host row leaves out the queue's own record of the post`);
    assert.doesNotMatch(row, /No other Facebook pages? (?:is|are) read/, `${where}: the Facebook host row says no other page is read while a to-do item reads the listing or Your listings page`);
    assert.match(row, /sent nowhere/);
  }
  const content = read('legal/chrome-web-store-privacy.md').split('\n').find((l) => l.startsWith('- Website content:'));
  assert.match(content, /title, prices and sold or unavailable sign of the Marketplace page/, 'the Website content answer leaves out the listing read');
  assert.match(content, /Your listings page/);
  assert.match(read('store/listing.md'), /website content, yes \([^)]*title, prices and sold sign of the listing page or Your listings page/);
  // the read of the listing page after Publish (sidepanel.js confirmIfThisCar: readListingInPage on the post's tab), in the data-use answer and its summary as in the scripting rows
  assert.match(read('extension/sidepanel.js'), /async function confirmIfThisCar[\s\S]*?executeScript\(\{ target: \{ tabId: fbTabId \}, func: readListingInPage/, 'the listing page after Publish is no longer read: update the Website content answers and this test');
  assert.match(content, /once the user has published and that tab shows a listing, whether that listing page shows the car \(its VIN in the page's text, or the car's name and the price filled in\), a sold or unavailable sign, and whether a listing form is still on the page, kept with the post under way and sent nowhere/, 'the Website content answer leaves out the read of the listing page after Publish');
  assert.match(read('store/listing.md'), /website content, yes \([^)]*the listing page that tab shows after they publish, read for the car's VIN, or its name and the price filled in, a sold sign and whether a listing form is still there, kept with the post and sent nowhere/, 'the store listing\'s privacy summary leaves out the read of the listing page after Publish');

  // the privacy policy, the data inventory and the FAQ a salesperson reads
  const policy = read('legal/privacy-policy.md').split('\n').find((l) => l.startsWith('We do **not** collect Facebook passwords'));
  assert.match(policy, /title, prices and sold status shown on the Marketplace page in the tab Lot Current opened for it \(the listing, or Marketplace's Your listings page when no listing link was saved\)/);
  assert.match(rowText(read('docs/data-inventory.md'), 'Watch the tab and read a listing (`facebook/detectPost.js`, `readListingInPage`)'), /every 1\.5 seconds the title, prices and sold or unavailable sign[^|]*Your listings page when no listing link was saved/);
  const faq = read('site-src/pages/faq.html');
  const reads = faq.slice(faq.indexOf('<h3>What does it read?</h3>'), faq.indexOf('</article>', faq.indexOf('<h3>What does it read?</h3>')));
  assert.match(reads, /When you open a to-do item, it reads the Marketplace page it opened for it \(the listing, or your Your listings page when no listing link was saved\) for the title, prices and a sold sign/);
});

// review: beside those reads, the Web Store answers said only that the extension "fills in the form" in the
// user's tab, their Limited Use statement that "No Facebook account data is collected", and the privacy
// policy that nothing at all is collected "from the User's Facebook account", while the listing address is
// kept and the dry run, the queue and an open to-do item read Facebook pages of the user's own account.
test('the privacy texts\' summary lines about Facebook name the reads they make, with no blanket "nothing from the account"', () => {
  const store = read('legal/chrome-web-store-privacy.md');
  const policy = read('legal/privacy-policy.md');
  assert.doesNotMatch(store, /No Facebook account data is collected/, 'the Limited Use statement says no Facebook account data is collected while the listing address is kept');
  assert.doesNotMatch(policy, /or anything from the User's Facebook account\./, 'the privacy policy says nothing is collected from the User\'s Facebook account while it keeps the listing address and reads the listing pages');
  const noRequest = store.split('\n').find((l) => l.startsWith('The extension makes no request to Facebook itself'));
  assert.ok(noRequest, 'the Web Store answers lost their line on requests to Facebook');
  for (const seen of [/fills in the form/, /check fields only/, /listing page after each post/, /Your listings page while a to-do item is open/]) assert.match(noRequest, seen, `the Web Store answers' line on requests to Facebook leaves out a read (${seen})`);
  const limited = section(store, '## Limited Use statement (for the listing and the Privacy Policy)');
  assert.match(limited, /from Facebook pages, Lot Current keeps only the address of each listing the user posts/);
  const policyLine = policy.split('\n').find((l) => l.startsWith('We do **not** collect Facebook passwords'));
  assert.match(policyLine, /from the User's Facebook account we keep and read only what this paragraph lists/);
  assert.match(policyLine, /it types into the form and reads the pages above in the User's own tab/);
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
  // review: the trademark note said only "never ... brand colours ... screenshots", with no word of how a capture of
  // the real form keeps to it, so the four texts the screenshots follow said it two ways
  for (const [where, text] of [['legal/trademark-note.md', rule], ['store/screenshots.md', shots], ['store/listing.md Screenshots', listingShots], ['legal/chrome-web-store-privacy.md notes', notes]]) {
    assert.doesNotMatch(text, /beyond what the page itself shows/, `${where} lets the real page's logo or colour into a store image`);
    assert.match(text, /logo/, `${where} says nothing about Facebook's logo`);
    assert.match(text, /wordmark/, `${where} says nothing about Facebook's wordmark`);
    assert.match(text, /below Facebook's top bar/, `${where} does not say a capture of the real form is cropped below Facebook's top bar`);
    assert.match(text, /Facebook-blue button|button or mark in Facebook's blue/, `${where} does not say Facebook's blue is covered`);
  }
  // the shot of the real form says it too
  const shot3 = shots.split('\n').find((l) => l.startsWith('| `3-form.png` |'));
  assert.match(shot3, /Crop below Facebook's top bar/);
  // personal details are covered with a solid box, never blurred: the shot list says a blur can be read back, and
  // the listing (its Screenshots section and its checklist) and the Web Store notes once said "blurs"/"blurred"
  assert.match(shots, /solid filled box[^.]*\(a light blur can sometimes be read back\)/);
  for (const [where, text] of [['store/screenshots.md', shots], ['store/listing.md', listing], ['legal/chrome-web-store-privacy.md notes', notes]]) {
    const blur = text.replace(/\(a (?:light )?blur can sometimes be read back\)/g, '').match(/[^.\n]*\bblur(?:s|red|ring)?\b[^.\n]*/i);
    assert.equal(blur, null, `${where} still asks for a blur: "${blur && blur[0].trim()}"`);
  }
  // the Numbers shot's caption keeps the unfilled fields out of the manager's numbers, as the home page does
  const shot5 = listing.split('\n').find((l) => l.startsWith('| 5 |'));
  assert.doesNotMatch(shot5, /The numbers your manager sees/);
  assert.match(shot5, /the fields that could not be filled stay in your browser/);
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

// review: Stripe, set up as docs/stripe-setup.md step 3 says, cancels a subscription by itself once the retries of a
// failed payment run out, and the plan counts as lapsed from the first failed payment; the Terms and the
// subscription agreement describe only cancelling on purpose, and the attorney was not asked about it.
test('while the agreements say nothing of a failed payment, the attorney is asked about the subscription Stripe ends by itself', async () => {
  // the code and the setup: a past-due subscription is lapsed, and Stripe is told to cancel after the retries
  const { subscriptionState } = await import('../supabase/functions/_shared/billing.mjs');
  assert.equal(subscriptionState({ status: 'past_due', pilot_ends_at: null }), 'lapsed', 'a failed payment no longer lapses the plan: update question 11.3 and this test');
  assert.match(read('docs/stripe-setup.md'), /set \*\*If all retries for a payment fail\*\* to \*\*Cancel the subscription\*\*/, 'Stripe is no longer set to cancel after the retries: update question 11.3 and this test');

  const terms = section(read('legal/terms-of-service.md'), '## 7. Fees, billing and cancellation');
  const dsa = section(read('legal/dealer-subscription-agreement.md'), '## 6. Term and termination');
  if (/fail(?:s|ed)? payment|non-?payment|not paid|unpaid/i.test(terms + dsa)) return; // the agreements now say it: drop question 11.3 with this test
  const q11 = section(read('legal/questions-for-attorney.md'), '## 11. Where the agreements disagree or say nothing');
  const item = q11.split('\n').find((l) => l.startsWith('- **11.3**'));
  assert.ok(item, 'questions-for-attorney.md 11 does not ask about ending a subscription for non-payment');
  assert.match(item, /when every retry has failed, cancels the subscription by itself, with no notice from Lot Current/);
  assert.match(item, /From the first failed payment the dealership's plan counts as lapsed: syncing and the description writer stop/);
  assert.match(item, /its database records are deleted within 30 days/);
});

// The dry run (Open the form and check fields only) reads the Marketplace
// form page: its address, title and language, the names of up to 100 visible
// controls inside the vehicle form (only the part of the page holding the
// fields it found, never Facebook's menus around it) and 200 characters next
// to the photo box. The side
// panel keeps that with the post under way, and Copy report puts all of it on
// the clipboard for a support message. The privacy texts say so, and the
// support steps ask the person to read it before sending.
test('the privacy texts name what the dry-run report holds from the Facebook page, and support asks the person to read it before sending', () => {
  // the code: what the probe returns, that the panel keeps it, and that Copy report copies it whole
  const fill = read('extension/facebook/fillForm.js');
  const probe = fill.slice(fill.indexOf('export function probeFormInPage('), fill.indexOf('\n}\n', fill.indexOf('export function probeFormInPage(')));
  assert.match(probe, /return \{ url: location\.href, language: [^}]*title: document\.title,[^}]*controls,[^}]*photoText/, 'the dry run no longer returns the page address, title, controls and photo text: update the texts and this test');
  assert.match(probe, /\.slice\(0, 100\);/, 'the dry run no longer keeps up to 100 controls: update the texts and this test');
  assert.match(probe, /const controls = \(formArea \? \[\.\.\.formArea\.querySelectorAll\(/, 'the dry run lists controls from more than the vehicle form: update the texts and this test');
  assert.match(probe, /\.slice\(0, 200\) : ''/, 'the dry run no longer keeps 200 characters next to the photo box: update the texts and this test');
  const panel = read('extension/sidepanel.js');
  assert.match(panel, /const FLOW_FIELDS = \[[^\]]*'probe'/, 'the side panel no longer keeps the dry-run report with the post: update the texts and this test');
  assert.match(panel, /case 'copyReport': return copy\(JSON\.stringify\(state\.probe/, 'Copy report no longer copies the dry-run report: update the texts and this test');

  const what = /address, title and language, the names of the fields found and of up to 100 visible controls inside the vehicle form, taken only from the part of that page that holds the form's fields and never from Facebook's menus or side columns around it, and up to 200 characters of the text next to its photo box/;
  const policy = read('legal/privacy-policy.md');
  assert.match(rowText(policy, 'Support messages (name, dealership, role, email, phone, what the message says, and any problem report the User pastes in: the versions, the dealership website\'s address and platform, the last scan and its errors, the counts on each tab, which form fields the last fill could not do, the Chrome version and time zone; and the report of the dry run, Open the form and check fields only, if the User pastes that in: the Marketplace form page\'s address, title and language, the names of the fields found and of up to 100 visible controls inside the vehicle form, taken only from the part of that page that holds the form\'s fields and never from Facebook\'s menus or side columns around it, and up to 200 characters of the text next to its photo box)'), /Our inbox and the support log/);
  const facebook = policy.split('\n').find((l) => l.startsWith('We do **not** collect Facebook passwords'));
  assert.doesNotMatch(facebook, /From Facebook pages Lot Current keeps only the listing address the User saves or Lot Current detects on the User's own tab\./, 'the policy says only the listing address is kept from Facebook pages while the dry run keeps what it read');
  assert.match(facebook, /after Open the form and check fields only, what that check read on the form page \(listed under Support messages above\), which stays with the post under way and leaves the browser only if the User copies the report into a message/);
  const content = read('legal/chrome-web-store-privacy.md').split('\n').find((l) => l.startsWith('- Website content:'));
  assert.match(content, what, 'the Web Store\'s Website content answer leaves out what the dry run reads');
  assert.match(content, /sent nowhere unless the user copies the report into a message/);
  const inventory = read('docs/data-inventory.md');
  assert.match(rowText(inventory, '`postFlow:<origin>`'), /the dry run's report \(Open the form and check fields only: the form page's address, title and language/, 'the data inventory\'s postFlow row leaves out the dry-run report');
  assert.match(inventory, /^- \*\*Copy report\*\* \(side panel, after \*\*Open the form and check fields only \(nothing filled\)\*\*, `copyReport` in `extension\/sidepanel\.js`\): [^\n]*up to 100 visible controls inside the vehicle form \(only from the part of the page that holds the form's fields, never Facebook's menus or side columns around it; none when Lot Current can't tell which part that is\)[^\n]*the person pastes it into a message to support\./m, 'the data inventory does not list what Copy report puts on the clipboard');
  assert.match(read('docs/support.md'), /The dry run's report also holds the form page's address and title and the names of up to 100 controls inside the vehicle form \(never Facebook's menus or side columns around it\): ask the person to read it before sending and take out anything personal/);
  assert.match(read('docs/help.md'), /\*\*Copy report\*\* on the result \(read it before you send it: it holds the form page's address and title and the names of the controls inside the vehicle form, never Facebook's menus around it\)/);
});

// review: the store listing's reviewer steps said the test needs no sign-in but never said how to get past the
// set-up wizard's Your account step, which shows whenever accounts are configured (extension/src/accountConfig.js),
// and did not mention the fields check; its privacy summary left out the colour guess's photo addresses and what
// the fields check reads from the form page, which the Web Store answers name.
test('the store listing tells the reviewer to skip the account step, and its privacy summary names the photos and the fields check', async () => {
  const { accountsConfigured } = await import('../extension/src/accountConfig.js');
  const { accountStepModel } = await import('../extension/src/wizardSteps.js');
  const listing = read('store/listing.md');
  const steps = listing.slice(listing.indexOf('## Test instructions'), listing.indexOf('## Support and homepage'));
  assert.match(steps, /Lot Current needs no account or sign-in for this test\./);
  if (accountsConfigured()) {
    const model = accountStepModel({ configured: true });
    assert.equal(model.heading, 'Your account', 'the wizard\'s account step was renamed: change the reviewer steps with it');
    assert.equal(model.next, 'Skip for now', 'the account step\'s button was renamed: change the reviewer steps with it');
    assert.match(steps, /At the Your account step, click Skip for now: this test needs no sign-in\./);
  }
  assert.match(read('extension/sidepanel.js'), />Open the form and check fields only \(nothing filled\)<\/button>/, 'the fields check button was renamed: change the reviewer steps with it');
  assert.match(steps, /click "Open the form and check fields only \(nothing filled\)" instead/);
  assert.match(steps, /attaches the car's photos/);
  const answers = read('legal/chrome-web-store-privacy.md');
  assert.match(answers, /for a colour guess, up to four photo addresses/, 'the Web Store answers no longer name the photo addresses: change the summary with them');
  assert.match(answers, /for Open the form and check fields only, the form page's address, title and language/);
  const short = listing.split('\n').find((l) => l.startsWith('The answers are in `legal/chrome-web-store-privacy.md`'));
  assert.ok(short, 'the store listing has its privacy summary');
  assert.match(short, /for a colour guess up to four of its photo addresses \(Anthropic's servers fetch those photos to look at them\)/);
  // the summary names what the answers name: the controls (only those inside the vehicle form) and the photo box's text
  assert.match(answers, /the names of the fields found and of up to 100 visible controls inside the vehicle form, taken only from the part of that page that holds the form's fields and never from Facebook's menus or side columns around it, and up to 200 characters of the text next to its photo box/, 'the Web Store answers changed what the fields check reads: change the summary with them');
  assert.match(short, /for Open the form and check fields only, that form page's address, title and language, the names of the fields found and of up to 100 visible controls inside the vehicle form, taken only from the part of that page that holds the form's fields and never from Facebook's menus or side columns around it, and up to 200 characters of the text next to its photo box/);
  assert.doesNotMatch(short, /which can include Facebook's own menus/, 'the summary says the fields check lists Facebook\'s menus, while it lists only the vehicle form\'s controls');
});
