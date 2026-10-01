// The per-server photo permission (src/photoHosts.js and the side panel):
//   - which servers a car's photos sit on, and the pattern to ask for each:
//     https only, never Facebook's, one per host whatever the port;
//   - which of them the manifest or a granted permission already covers, by
//     Chrome's rules for host patterns (ports, "*", "*.<domain>", IP hosts);
//   - the side panel asks Chrome only from the salesperson's click, before
//     anything else is awaited, and only for what neededPatterns names; the
//     service worker never asks; a queued car whose photo server has not
//     been asked about waits for that click;
//   - photos on Facebook's servers are never asked for nor sent to the
//     worker (the worker's own refusal is in photoDownload.test.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { photoOriginsOf, permissionPattern, neededPatterns, patternCovers, patternHost, isFacebookServer } from '../extension/src/photoHosts.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const manifest = JSON.parse(read('../extension/manifest.json'));
const ANY = '/' + '*';
const need = (urls, granted = []) => neededPatterns(urls, { manifestHosts: manifest.host_permissions, granted });

test('photoOriginsOf: the https origins, once each, in photo order; nothing else', () => {
  assert.deepEqual(photoOriginsOf([
    'https://img.cdn.example/a.jpg',
    'https://IMG.cdn.example/b.jpg?w=640',
    'https://img.cdn.example./c.jpg', // a trailing dot is the same server
    'https://photos.example:8443/d.jpg',
    'https://photos.example/e.jpg',
    'http://plain.example/f.jpg',
    'https://scontent.xx.facebook.com/g.jpg',
    'https://www.facebook.com/marketplace/h.jpg',
    'https://notfacebook.com/i.jpg',
    '/relative/j.jpg',
    'not a url',
    null,
    42,
  ]), ['https://img.cdn.example', 'https://photos.example:8443', 'https://photos.example', 'https://notfacebook.com']);
  assert.deepEqual(photoOriginsOf(null), []);
  assert.deepEqual(photoOriginsOf('https://img.example/a.jpg'), [], 'a list, not a string');
});

test('permissionPattern: https://<host>/ with any path, no port, never http or Facebook', () => {
  assert.equal(permissionPattern('https://img.cdn.example'), 'https://img.cdn.example' + ANY);
  assert.equal(permissionPattern('https://img.cdn.example:8443'), 'https://img.cdn.example' + ANY, 'a pattern without a port covers every port');
  assert.equal(permissionPattern('https://img.cdn.example/some/path.jpg'), 'https://img.cdn.example' + ANY);
  assert.equal(permissionPattern('https://192.168.1.20'), 'https://192.168.1.20' + ANY);
  assert.equal(permissionPattern('https://[2001:db8::1]:8443'), 'https://[2001:db8::1]' + ANY);
  assert.equal(permissionPattern('http://img.cdn.example'), null);
  assert.equal(permissionPattern('https://www.facebook.com'), null);
  assert.equal(permissionPattern('https://facebook.com'), null);
  assert.equal(permissionPattern('https://static.xx.facebook.com'), null);
  assert.equal(permissionPattern(''), null);
  assert.equal(permissionPattern('img.cdn.example'), null);
});

test('neededPatterns: the manifest\'s own image host is never asked for, Facebook and http never', () => {
  const imageHosts = manifest.host_permissions.filter((p) => !/facebook\.com/.test(p));
  assert.ok(imageHosts.length >= 1, 'the manifest names an image host');
  for (const pattern of imageHosts) {
    const host = patternHost(pattern);
    assert.deepEqual(need([`https://${host}/1.jpg`, `https://${host}/2.jpg`]), [], `${host} is in the manifest`);
  }
  assert.deepEqual(need(['https://www.facebook.com/marketplace/x.jpg', 'https://scontent.facebook.com/y.jpg']), []);
  assert.deepEqual(need(['http://img.cdn.example/a.jpg', 'http://127.0.0.1:5173/photo/1.png']), [], 'http photos: nothing to ask (the e2e mock serves these)');
  assert.deepEqual(need([]), []);
  assert.deepEqual(neededPatterns(['https://img.example/a.jpg']), ['https://img.example' + ANY], 'no lists: everything https is needed');
});

// Photos a dealer page reuses from its Facebook page sit on Facebook's image
// servers, not on facebook.com: those are Facebook's too.
const FACEBOOK_PHOTOS = [
  'https://www.facebook.com/marketplace/x.jpg',
  'https://scontent-iad3-1.xx.fbcdn.net/v/t39/1.jpg',
  'https://static.xx.fbcdn.net/rsrc/2.png',
  'https://lookaside.fbsbx.com/lookaside/crawler/3.jpg',
  'https://connect.facebook.net/4.jpg',
  'https://www.fb.com/5.jpg',
  'https://FBCDN.NET./6.jpg',
];

test('Facebook\'s servers, its image servers included, are never asked for', () => {
  assert.deepEqual(photoOriginsOf(FACEBOOK_PHOTOS), []);
  assert.deepEqual(need(FACEBOOK_PHOTOS), []);
  assert.deepEqual(neededPatterns(FACEBOOK_PHOTOS), [], 'not even with no lists');
  for (const url of FACEBOOK_PHOTOS) assert.equal(permissionPattern(url), null, url);
  // a name that only ends the same way, or has Facebook's name inside it, is someone else's
  assert.deepEqual(need(['https://notfbcdn.net/a.jpg', 'https://fbcdn.net.example/b.jpg', 'https://myfb.com/c.jpg']),
    ['https://notfbcdn.net' + ANY, 'https://fbcdn.net.example' + ANY, 'https://myfb.com' + ANY]);
});

test('isFacebookServer: Facebook\'s servers whatever the scheme, nothing else', () => {
  for (const url of FACEBOOK_PHOTOS) assert.equal(isFacebookServer(url), true, url);
  assert.equal(isFacebookServer('http://scontent.fbcdn.net/a.jpg'), true, 'http too: the download is refused, not only the asking');
  for (const url of ['https://notfbcdn.net/a.jpg', 'https://fbcdn.net.example/b.jpg', 'https://img.cdn.example/c.jpg', 'not a url', '', null, undefined]) {
    assert.equal(isFacebookServer(url), false, String(url));
  }
});

test('neededPatterns: one pattern per server not yet covered, in photo order', () => {
  const photos = ['https://img.b.example/1.jpg', 'https://img.a.example/2.jpg', 'https://img.b.example/3.jpg', 'https://img.a.example:8443/4.jpg'];
  assert.deepEqual(need(photos), ['https://img.b.example' + ANY, 'https://img.a.example' + ANY]);
  assert.deepEqual(need(photos, ['https://img.b.example' + ANY]), ['https://img.a.example' + ANY]);
  assert.deepEqual(need(photos, ['https://img.a.example' + ANY, 'https://img.b.example' + ANY]), []);
});

test('Chrome\'s rules: wildcard subdomains, "*" and <all_urls>, scheme', () => {
  // a granted *.cdn.example covers the domain itself and every name under it
  assert.deepEqual(need(['https://img.cdn.example/a.jpg', 'https://a.b.cdn.example/b.jpg', 'https://cdn.example/c.jpg'], ['https://*.cdn.example' + ANY]), []);
  // but not a name that only ends the same way, nor a longer domain
  assert.deepEqual(need(['https://xcdn.example/a.jpg', 'https://cdn.example.com/b.jpg'], ['https://*.cdn.example' + ANY]), ['https://xcdn.example' + ANY, 'https://cdn.example.com' + ANY]);
  // an exact host covers only itself
  assert.deepEqual(need(['https://img.cdn.example/a.jpg'], ['https://cdn.example' + ANY]), ['https://img.cdn.example' + ANY]);
  // any host
  assert.deepEqual(need(['https://img.cdn.example/a.jpg', 'https://10.0.0.5/b.jpg'], ['https://*' + ANY]), []);
  assert.deepEqual(need(['https://img.cdn.example/a.jpg'], ['<all_urls>']), []);
  // the scheme: "*" means http and https; an http pattern doesn't cover https
  assert.deepEqual(need(['https://img.cdn.example/a.jpg'], ['*://img.cdn.example' + ANY]), []);
  assert.deepEqual(need(['https://img.cdn.example/a.jpg'], ['http://img.cdn.example' + ANY]), ['https://img.cdn.example' + ANY]);
  // case and a trailing dot don't matter; garbage patterns cover nothing
  assert.deepEqual(need(['https://IMG.cdn.example./a.jpg'], ['https://img.CDN.example' + ANY]), []);
  assert.deepEqual(need(['https://img.cdn.example/a.jpg'], ['img.cdn.example', 'https://img*.cdn.example' + ANY, 'https://' + ANY, '', null]), ['https://img.cdn.example' + ANY]);
  // the path of a pattern is not compared: Chrome lets an extension read another site per origin
  assert.deepEqual(need(['https://img.cdn.example/photos/a.jpg'], ['https://img.cdn.example/other' + ANY]), []);
});

test('Chrome\'s rules: ports', () => {
  // a pattern without a port covers every port
  assert.deepEqual(need(['https://img.cdn.example:8443/a.jpg'], ['https://img.cdn.example' + ANY]), []);
  // a port in the pattern covers only that port; 443 is the port of an address that writes none
  assert.deepEqual(need(['https://img.cdn.example:8443/a.jpg'], ['https://img.cdn.example:8443' + ANY]), []);
  assert.deepEqual(need(['https://img.cdn.example/a.jpg'], ['https://img.cdn.example:8443' + ANY]), ['https://img.cdn.example' + ANY]);
  assert.deepEqual(need(['https://img.cdn.example/a.jpg'], ['https://img.cdn.example:443' + ANY]), []);
  assert.deepEqual(need(['https://img.cdn.example:9000/a.jpg'], ['https://img.cdn.example:*' + ANY]), []);
  // two ports, one covered: the other still needs the host, asked once
  assert.deepEqual(need(['https://img.cdn.example:8443/a.jpg', 'https://img.cdn.example/b.jpg'], ['https://img.cdn.example:8443' + ANY]), ['https://img.cdn.example' + ANY]);
  assert.deepEqual(need(['https://img.cdn.example/a.jpg', 'https://img.cdn.example:8443/b.jpg']), ['https://img.cdn.example' + ANY]);
});

test('Chrome\'s rules: IP hosts have no subdomains', () => {
  assert.deepEqual(need(['https://192.168.1.20/a.jpg'], ['https://192.168.1.20' + ANY]), []);
  assert.deepEqual(need(['https://192.168.1.20/a.jpg'], ['https://*.168.1.20' + ANY]), ['https://192.168.1.20' + ANY]);
  assert.deepEqual(need(['https://192.168.1.20:8443/a.jpg'], ['https://192.168.1.20' + ANY]), []);
  assert.deepEqual(need(['https://[2001:db8::1]/a.jpg'], ['https://[2001:db8::1]' + ANY]), []);
  // the URL parser writes 0xC0.0xA8.1.20 as 192.168.1.20
  assert.deepEqual(need(['https://0xC0.0xA8.1.20/a.jpg'], ['https://192.168.1.20' + ANY]), []);
});

test('patternCovers and patternHost, as the panel uses them', () => {
  assert.equal(patternCovers('https://img.cdn.example' + ANY, 'https://img.cdn.example/a.jpg'), true);
  assert.equal(patternCovers('https://img.cdn.example' + ANY, 'https://img.cdn.example:8443/a.jpg'), true);
  assert.equal(patternCovers('https://img.cdn.example' + ANY, 'https://other.example/a.jpg'), false);
  assert.equal(patternCovers('https://img.cdn.example' + ANY, 'http://img.cdn.example/a.jpg'), false, 'only https addresses');
  assert.equal(patternCovers('nonsense', 'https://img.cdn.example/a.jpg'), false);
  assert.equal(patternHost('https://img.cdn.example' + ANY), 'img.cdn.example');
  assert.equal(patternHost('https://*.cdn.example' + ANY), '*.cdn.example');
  assert.equal(patternHost('https://*' + ANY), '*');
  assert.equal(patternHost('nonsense'), '');
});

// ---------- the side panel asks only from a click ----------

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
// A top-level function's text, from its declaration to the closing brace at the start of a line.
function fnText(src, name) {
  const start = src.search(new RegExp(`(async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} is defined`);
  const end = src.indexOf('\n}\n', start);
  return src.slice(start, end + 2);
}

test('the side panel asks Chrome for photo servers only from the click handler, first, and only for what neededPatterns names', () => {
  const src = stripComments(read('../extension/sidepanel.js'));
  // the panel's three requests: the NHTSA decode (checkVinOnline), the photo
  // servers (askForPhotos) and the website itself (askForSite, test below)
  const requests = [...src.matchAll(/permissions\.request\(/g)].map((m) => m.index);
  assert.equal(requests.length, 3, 'sidepanel.js makes exactly three permission requests');
  const ask = fnText(src, 'askForPhotos');
  const vin = fnText(src, 'checkVinOnline');
  assert.equal((ask.match(/permissions\.request\(/g) || []).length, 1);
  assert.equal((vin.match(/permissions\.request\(/g) || []).length, 1);
  assert.equal((fnText(src, 'askForSite').match(/permissions\.request\(/g) || []).length, 1);
  assert.match(vin, /permissions\.request\(\{ origins: \[NHTSA_ORIGIN \+ '\/' \+ '\*'\] \}\)/);

  // the photo request: the patterns come straight from neededPatterns, and nothing is awaited first
  assert.ok(ask.includes('await chrome.permissions.request('), 'the request is awaited where it is made');
  const before = ask.slice(0, ask.indexOf('await chrome.permissions.request('));
  assert.match(before, /const patterns = neededPatterns\(urls, \{ manifestHosts: MANIFEST_HOSTS, granted: grantedOrigins \}\)/);
  assert.equal((ask.match(/\bpatterns\s*=[^=]/g) || []).length, 1, 'patterns is assigned once');
  assert.match(ask, /permissions\.request\(\{ origins: patterns \}\)/);
  assert.doesNotMatch(before, /\bawait\b/, 'nothing is awaited before Chrome is asked');

  // Nothing is awaited on the way into the click handler's branches: Chrome
  // shows a prompt only while the click still counts. Measured from the
  // start of onClick, so an await added at its top is caught, not only one
  // in the branch itself. The wizard and upkeep short-circuits are the
  // exception: those steps show no photo or VIN button.
  const click = fnText(src, 'onClick');
  const allowAt = click.indexOf('if (btn.dataset.allowPhotos');
  const switchAt = click.indexOf('switch (btn.id)');
  assert.ok(allowAt > 0 && switchAt > allowAt, 'onClick has its Allow photos branch, then its switch');
  assert.doesNotMatch(click.slice(0, allowAt), /\bawait\b/, 'nothing is awaited in the click before the Allow photos branch');
  const allowEnd = click.indexOf('\n  }\n', allowAt); // the Allow photos branch returns; its own awaits come after its ask
  assert.ok(allowEnd > allowAt && allowEnd < switchAt, 'the Allow photos branch ends before the switch');
  const shortCircuits = /^\s*if \(state\.step === '(?:wizard|upkeep)' && \(await handle(?:Wizard|Upkeep)Click\([^\n]*\n/gm;
  const beforeSwitch = click.slice(0, allowAt) + click.slice(allowEnd + 4, switchAt);
  assert.equal((beforeSwitch.match(shortCircuits) || []).length, 2, 'the wizard and upkeep short-circuits are where this test expects them');
  assert.doesNotMatch(beforeSwitch.replace(shortCircuits, ''), /\bawait\b/, 'nothing but the wizard and upkeep short-circuits is awaited before the switch');

  // both are called only from the click handler, each before anything else in its branch is awaited
  for (const name of ['askForPhotos', 'checkVinOnline']) {
    const everywhere = (src.match(new RegExp(`(?<!['"])\\b${name}\\b(?!['"])`, 'g')) || []).length;
    const inClick = [...click.matchAll(new RegExp(`\\b${name}\\(`, 'g'))];
    assert.ok(inClick.length >= 1, `${name} is called from the click handler`);
    assert.equal(everywhere, inClick.length + 1, `${name} is named only where it is defined and in the click handler`);
    for (const m of inClick) {
      const upTo = click.slice(0, m.index);
      const branch = upTo.slice(Math.max(upTo.lastIndexOf('case '), upTo.lastIndexOf('if (btn.dataset.'))).replace(/await\s*$/, '');
      assert.doesNotMatch(branch, /\bawait\b/, `${name} is the first thing its click awaits: ${branch.trim().slice(0, 80)}`);
    }
  }
  // the clicks that fill the form with its photos or download photos go through the same ask
  for (const id of ['openForm', 'fillNow', 'attachAgain', 'downloadPhotos']) {
    assert.match(click, new RegExp(`case '${id}':\\s*await askForPhotos\\(\\);`), `${id} asks first`);
  }
  // Fill again fills the fields only: no photos, so nothing to ask Chrome for
  assert.match(click, /case 'fillAgain': return runFill\(\{ photos: false \}\);/);
  // the photo branches of the click handler come before anything the wizard or upkeep await
  assert.ok(click.indexOf('btn.dataset.allowPhotos') < click.indexOf('await handleWizardClick'), 'Allow photos asks before any other await');
});

// Posting from the side panel's own list reads the car straight from the
// website, which needs the website permission automatic rescans use. Chrome
// asks for it only during a click, so the ask comes first in each of the four
// clicks that need it, and asks only for what siteReadOrigins names.
test('the side panel asks Chrome for the website only from a click, first, and only for the patterns siteReadOrigins names', () => {
  const src = stripComments(read('../extension/sidepanel.js'));
  const ask = fnText(src, 'askForSite');
  assert.match(ask, /^async function askForSite\(origins = siteMissing\(\)\)/, 'the default is what is missing of the website\'s patterns');
  assert.match(src, /const siteNeeds = \(\) => siteReadOrigins\(state\.origin, state\.siteInfo\);/);
  assert.match(src, /const siteMissing = \(\) => missingOrigins\(siteNeeds\(\), grantedOrigins\);/);
  const before = ask.slice(0, ask.indexOf('await chrome.permissions.request('));
  assert.ok(before.length > 0, 'askForSite awaits its request');
  assert.doesNotMatch(before, /\bawait\b/, 'nothing is awaited before Chrome is asked');
  assert.match(ask, /permissions\.request\(\{ origins \}\)/);

  // called only as the first await of the four click actions
  const callers = ['postFromList', 'queueFromList', 'rescanFromList', 'allowSiteAndRetry'];
  const everywhere = (src.match(/\baskForSite\(/g) || []).length;
  assert.equal(everywhere, callers.length + 1, 'askForSite is named only where it is defined and in the four click actions');
  for (const name of callers) {
    const body = fnText(src, name);
    const at = body.indexOf('await askForSite(');
    assert.ok(at > 0, `${name} asks for the website`);
    assert.doesNotMatch(body.slice(0, at), /\bawait\b/, `${name} asks Chrome before it awaits anything`);
  }
  // allowSiteAndRetry asks for the patterns the blocked read named, or the website's own
  assert.match(fnText(src, 'allowSiteAndRetry'), /state\.blockedOrigins[^\n]*: siteNeeds\(\)/);

  // each action is reached from the click handler with nothing awaited on the
  // way in the idle and blocked steps: the only awaits before the list's Post
  // buttons are the photo prompt's own branch and the wizard's and upkeep's
  // handlers, each behind its own step
  const click = fnText(src, 'onClick');
  const switchAt = click.indexOf('switch (btn.id)');
  const postAt = click.indexOf('btn.dataset.postVin');
  assert.ok(postAt > 0 && postAt < switchAt, 'the list\'s Post buttons are handled before the switch');
  const awaitsBefore = [...click.slice(0, postAt).matchAll(/[^\n]*\bawait\b[^\n]*/g)].map((m) => m[0].trim());
  assert.deepEqual(awaitsBefore, [
    'const granted = await askForPhotos(photoList().filter((u) => patternCovers(pattern, u)), { again: true });',
    "if (state.step === 'wizard' && (await handleWizardClick(btn.id, wizardCtx))) return undefined;",
    "if (state.step === 'upkeep' && (await handleUpkeepClick(btn.id, upkeepCtx))) return undefined;",
  ], 'nothing else is awaited before the list\'s actions');
  assert.match(click, /if \(btn\.dataset\.allowPhotos !== undefined\) \{\n\s*const pattern = btn\.dataset\.allowPhotos;\n\s*const granted = await askForPhotos\([^\n]*\n\s*return afterAllowPhotos\(pattern, granted\);\n\s*\}/, 'the photo prompt\'s await is inside its own branch, which returns');
  assert.match(click, /if \(btn\.dataset\.postVin !== undefined && state\.step === 'idle'\) return oneAtATime\(\(\) => postFromList\(btn\.dataset\.postVin\)\);/);
  for (const [id, name, step] of [['panelQueue', 'queueFromList', 'idle'], ['allowSite', 'allowSiteAndRetry', 'blocked']]) {
    assert.match(click, new RegExp(`case '${id}': return state\\.step === '${step}' \\? oneAtATime\\(\\(\\) => ${name}\\(\\)\\) : undefined;`), `${id} goes straight to ${name}`);
  }
  assert.match(click, /case 'panelRescan': return state\.step === 'idle' \? rescanFromList\(\) : undefined;/, 'panelRescan goes straight to rescanFromList (it has its own Rescanning… state)');
  // oneAtATime calls the action before anything else, so Chrome's prompt is still inside the click
  assert.match(fnText(src, 'oneAtATime'), /^function oneAtATime\(action\) \{\n\s*if \(listBusy\) return undefined;\n\s*listBusy = true;\n\s*return action\(\)\.finally\(/);
  for (const name of callers) {
    const uses = (src.match(new RegExp(`\\b${name}\\(`, 'g')) || []).length;
    assert.equal(uses, 2, `${name} is called only from the click handler`);
  }
});

// canAutoOpen, run as written with the rest of the panel replaced by stubs:
// a queued car whose photos need a server Chrome has not been asked about
// waits at review, because Chrome prompts only from a click.
test('the queue does not open the form by itself for a car whose photo server has not been asked about', () => {
  const src = stripComments(read('../extension/sidepanel.js'));
  const body = fnText(src, 'canAutoOpen');
  const make = new Function('state', 'currentListing', 'dailyCap', 'photoPatterns', 'refusedPhotoServers', `${body}\nreturn canAutoOpen;`);
  const run = (photos, { granted = [], refused = [] } = {}) => make(
    { guardrails: { ok: true }, vinCheck: { local: { ok: true } } },
    () => ({ missing: [] }),
    () => ({ reached: false }),
    (urls = photos) => need(urls, granted),
    new Set(refused),
  )();
  const cdn = ['https://img.uncovered.example/1.jpg', 'https://img.uncovered.example/2.jpg'];
  const pattern = 'https://img.uncovered.example' + ANY;
  assert.equal(run([]), true, 'a car that passes every check and has no photos opens');
  assert.equal(run(['http://127.0.0.1:5173/photo/1.png']), true, 'nothing to ask: it opens');
  assert.equal(run(cdn), false, 'a server not yet asked about: the car waits for a click');
  assert.equal(run(cdn, { granted: [pattern] }), true, 'granted: it opens');
  assert.equal(run(cdn, { refused: [pattern] }), true, 'refused this session: it opens without those photos, and Allow photos asks again');
  assert.equal(run([...cdn, 'https://img.other.example/3.jpg'], { refused: [pattern] }), false, 'one refused, another not yet asked: it waits');
  assert.equal(run(['https://scontent-iad3-1.xx.fbcdn.net/v/1.jpg']), true, 'Facebook\'s servers are never asked for, so they never hold the car');
});

// attachPhotos and downloadPhotos, run as written with the rest of the panel
// replaced by stubs: the worker is never sent a photo on Facebook's servers,
// and the salesperson is told those photos were left out.
test('the side panel never sends a Facebook photo to the worker, and says it left them out', async () => {
  const src = stripComments(read('../extension/sidepanel.js'));
  assert.equal((src.match(/type: 'downloadPhotos'/g) || []).length, 2, 'the worker is asked for photos from attachPhotos and downloadPhotos only');
  const photos = ['https://img.cdn.example/1.jpg', 'https://scontent-iad3-1.xx.fbcdn.net/v/2.jpg', 'https://img.cdn.example/3.jpg', 'https://www.facebook.com/marketplace/4.jpg'];
  const facebook = photos.filter((u) => /fbcdn|facebook/.test(u));
  const sent = [];
  const chrome = {
    runtime: {
      sendMessage: async (msg) => {
        sent.push(...msg.urls);
        return { ok: true, photos: msg.urls.map((url, i) => ({ url, ok: true, name: `photo-${i}.jpg`, type: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,AA==' })) };
      },
    },
    scripting: { executeScript: async ({ args }) => [{ result: { ok: true, attached: args[1].length } }] },
  };
  const panel = {
    state: { listing: { photos }, vehicle: { photos, stock: 'P1' }, vin: 'V', fill: null, map: { photoLimitDefault: 20 }, fbTabId: 1, photos: null },
    chrome,
    render: () => {},
    saveFlow: async () => {},
    photoPatterns: (urls) => need(urls),
    refusedPhotoServers: new Set(),
    patternCovers,
    isFacebookServer,
    attachPhotosInPage: () => {},
    photoList: () => photos,
    hostList: (patterns) => patterns.map(patternHost).join(', '),
    sleep: async () => {},
    flowRun: 0, // the post under way (sidepanel.js clearFlow); nothing drops it here
    formTabShows: async () => true, // the form's tab still shows the form (tested in panelFlow.test.js)
    document: { createElement: () => ({ click() {}, remove() {} }), body: { appendChild() {} } },
    status: '',
  };
  panel.setStatus = (text) => { panel.status = text; };
  const names = Object.keys(panel).filter((k) => k !== 'status');
  const load = (name) => new Function(...names, `${fnText(src, name)}\nreturn ${name};`)(...names.map((k) => panel[k]));

  await load('attachPhotos')();
  assert.deepEqual(sent, photos.filter((u) => !facebook.includes(u)), 'attachPhotos sends only the dealer\'s photos');
  assert.deepEqual(panel.state.photos.failed.map((f) => [f.url, f.facebook]), facebook.map((u) => [u, true]), 'and records Facebook\'s as left out');
  assert.equal(panel.state.photos.attached, 2);

  sent.length = 0;
  await load('downloadPhotos')();
  assert.deepEqual(sent, photos.filter((u) => !facebook.includes(u)), 'downloadPhotos sends only the dealer\'s photos');
  assert.match(panel.status, /^2 of 4 photos downloaded/);
  assert.match(panel.status, /2 are on Facebook's own servers, which Lot Current doesn't download from\./);
});

test('nothing but a click in an extension page asks for a host: never the service worker, never an adapter', () => {
  const ext = new URL('../extension/', import.meta.url);
  const askers = [];
  for (const dir of ['', 'src/', 'facebook/', 'adapters/']) {
    for (const f of readdirSync(new URL(dir, ext)).filter((n) => n.endsWith('.js'))) {
      if (/permissions\.request\(/.test(stripComments(read('../extension/' + dir + f)))) askers.push(dir + f);
    }
  }
  assert.deepEqual(askers.sort(), ['popup.js', 'sidepanel.js', 'wizard.js'], 'only the three pages people click in ask Chrome for anything');
  assert.doesNotMatch(stripComments(read('../extension/background.js')), /permissions\.request/);
});
