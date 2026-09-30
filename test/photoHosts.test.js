// The per-server photo permission (src/photoHosts.js and the side panel):
//   - which servers a car's photos sit on, and the pattern to ask for each:
//     https only, never Facebook's, one per host whatever the port;
//   - which of them the manifest or a granted permission already covers, by
//     Chrome's rules for host patterns (ports, "*", "*.<domain>", IP hosts);
//   - the side panel asks Chrome only from the salesperson's click, before
//     anything else is awaited, and only for what neededPatterns names; the
//     service worker never asks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { photoOriginsOf, permissionPattern, neededPatterns, patternCovers, patternHost } from '../extension/src/photoHosts.js';

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
  // the panel's two requests: the NHTSA decode (checkVinOnline) and the photo servers (askForPhotos)
  const requests = [...src.matchAll(/permissions\.request\(/g)].map((m) => m.index);
  assert.equal(requests.length, 2, 'sidepanel.js makes exactly two permission requests');
  const ask = fnText(src, 'askForPhotos');
  const vin = fnText(src, 'checkVinOnline');
  assert.equal((ask.match(/permissions\.request\(/g) || []).length, 1);
  assert.equal((vin.match(/permissions\.request\(/g) || []).length, 1);
  assert.match(vin, /permissions\.request\(\{ origins: \[NHTSA_ORIGIN \+ '\/' \+ '\*'\] \}\)/);

  // the photo request: the patterns come straight from neededPatterns, and nothing is awaited first
  assert.ok(ask.includes('await chrome.permissions.request('), 'the request is awaited where it is made');
  const before = ask.slice(0, ask.indexOf('await chrome.permissions.request('));
  assert.match(before, /const patterns = neededPatterns\(urls, \{ manifestHosts: MANIFEST_HOSTS, granted: grantedOrigins \}\)/);
  assert.equal((ask.match(/\bpatterns\s*=[^=]/g) || []).length, 1, 'patterns is assigned once');
  assert.match(ask, /permissions\.request\(\{ origins: patterns \}\)/);
  assert.doesNotMatch(before, /\bawait\b/, 'nothing is awaited before Chrome is asked');

  // both are called only from the click handler, each before anything else in its branch is awaited
  const click = fnText(src, 'onClick');
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
  // the clicks that fill the form or download photos go through the same ask
  for (const id of ['openForm', 'fillNow', 'fillAgain', 'downloadPhotos']) {
    assert.match(click, new RegExp(`case '${id}':\\s*await askForPhotos\\(\\);`), `${id} asks first`);
  }
  // the photo branches of the click handler come before anything the wizard or upkeep await
  assert.ok(click.indexOf('btn.dataset.allowPhotos') < click.indexOf('await handleWizardClick'), 'Allow photos asks before any other await');
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
