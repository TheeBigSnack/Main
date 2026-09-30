// The site survey's pure parts (scripts/survey-lib.mjs): arguments, robots.txt,
// the page anatomy, the platform fingerprint, bot-check signs, the JSON a page
// calls, the survey's copy of the extension, the verdict and the reports.
// Every page here is SYNTHETIC: small HTML strings written for this test. The
// "DealerOn-like" and "Dealer.com-like" snippets only carry the markers the
// survey looks for; they are not copied from, and are not claimed to match,
// any real DealerOn or Dealer.com website.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import {
  DEFAULTS, parseArgs, hostDir, parseRobots, robotsAllows, robotsVerdict, metaGenerator, assetHosts, findVins,
  jsonLdSummary, jsonLdExcerpt, microdataTypes, carLinks, pickCarPages, paginationShape, pageAnatomy, photoHosts,
  urlPattern, jsonEndpoint, botSigns, fingerprint, capScanLimits, surveyHostPermissions, lotSyncReading, verdictFor,
  renderReportMd, renderSummaryMd, EXCERPT_LIMIT,
} from '../scripts/survey-lib.mjs';
import { vinCheckDigit } from '../extension/src/vin.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const SITE = 'https://www.sample-motors.test';
const LIST = SITE + '/used-vehicles/';
// the textbook example VIN, check digit included; a second one made valid here
const VIN = '1HGCM82633A004352';
const VIN2 = (() => {
  const base = '2T3WFREV0JW000017';
  return base.slice(0, 8) + vinCheckDigit(base) + base.slice(9);
})();

// SYNTHETIC: carries only the markers the survey looks for, not a real site's page.
const DEALERON_LIKE = `<!doctype html><html><head><title>Used Cars | Sample Motors</title>
<script src="https://cdn.dealeron.com/sample/app.js"></script></head><body>
<a href="/used-Springfield-2019-Honda-Civic-EX-${VIN}">2019 Honda Civic EX</a>
<a href="/used-Springfield-2018-Toyota-RAV4-XLE-${VIN2}">2018 Toyota RAV4 XLE</a>
<a href="/searchused.aspx?pt=2">2</a></body></html>`;
// SYNTHETIC, same caveat.
const DEALERCOM_LIKE = `<!doctype html><html><head><title>Used Inventory</title>
<script src="https://static.dealer.com/sample/bundle.js"></script>
<script>window.DDC = window.DDC || {}; DDC.dataLayer = {};</script></head>
<body><div id="inventory-root"></div></body></html>`;

const CAR_PAGE = `<!doctype html><html><head><title>2019 Honda Civic EX</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"AutoDealer","name":"Sample Motors"}</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":["Product","Car"],"name":"2019 Honda Civic EX","vehicleIdentificationNumber":"${VIN}",
"mileageFromOdometer":{"@type":"QuantitativeValue","value":41230,"unitCode":"SMI"},"image":["https://photos.example-cdn.test/a.jpg"],
"offers":{"@type":"Offer","price":19995,"priceCurrency":"USD"}}</script></head>
<body><h1>2019 Honda Civic EX</h1><p>$19,995</p></body></html>`;

test('parseArgs: defaults, every option in both spellings, and plain-English errors', () => {
  const d = parseArgs([LIST]);
  assert.deepEqual([d.urls, d.out, d.maxCarPages, d.scanCarPages, d.headed], [[LIST], 'survey-out', 5, DEFAULTS.scanCarPages, false]);
  const o = parseArgs([LIST, 'https://other.test/searchused.aspx', '--out', 'x', '--max-car-pages=2', '--scan-car-pages', '3', '--headed', '--scan-timeout', '60']);
  assert.deepEqual([o.urls.length, o.out, o.maxCarPages, o.scanCarPages, o.headed, o.scanTimeoutSec], [2, 'x', 2, 3, true, 60]);
  assert.equal(parseArgs(['--help']).help, true);
  assert.throws(() => parseArgs([]), /at least one used-inventory address/);
  assert.throws(() => parseArgs(['not a url']), /not a web address/);
  assert.throws(() => parseArgs(['ftp://x.test/']), /not an http or https/);
  assert.throws(() => parseArgs(['https://www.facebook.com/marketplace/']), /never Facebook/);
  assert.throws(() => parseArgs([LIST, '--max-car-pages', '11']), /from 0 to 10/, 'the survey never opens more than 10 car pages');
  assert.throws(() => parseArgs([LIST, '--max-car-pages', '-1']), /whole number/);
  assert.throws(() => parseArgs([LIST, '--fast']), /unknown option/);
  assert.throws(() => parseArgs([LIST, '--out']), /needs a folder/);
  assert.equal(hostDir('https://www.Sample-Motors.test/used/'), 'www.sample-motors.test');
  assert.equal(hostDir('http://127.0.0.1:4321/used-vehicles/'), '127.0.0.1_4321');
});

test('robots.txt: only the rules for every robot, longest match wins, Allow wins a tie, wildcards, Crawl-delay', () => {
  const robots = parseRobots(`# comment
User-agent: SomeBot
Disallow: /

User-agent: *
Disallow: /inventory/
Allow: /inventory/used-
Disallow: /*.pdf$
Crawl-delay: 5
Sitemap: ${SITE}/sitemap.xml
`);
  assert.equal(robots.rules.length, 3, "SomeBot's rules are not every robot's");
  assert.equal(robots.crawlDelaySec, 5);
  assert.deepEqual(robots.sitemaps, [SITE + '/sitemap.xml']);
  assert.deepEqual(robotsAllows(robots, LIST), { allowed: true, rule: null });
  assert.equal(robotsAllows(robots, SITE + '/inventory/new-2025-x/').allowed, false);
  assert.equal(robotsAllows(robots, SITE + '/inventory/used-2019-honda/').allowed, true, 'the longer Allow wins');
  assert.equal(robotsAllows(robots, SITE + '/brochure.pdf').allowed, false);
  assert.equal(robotsAllows(robots, SITE + '/brochure.pdf?x=1').allowed, true, '$ anchors the end');
  const tie = parseRobots('User-agent: *\nDisallow: /used\nAllow: /used\n');
  assert.equal(robotsAllows(tie, SITE + '/used').allowed, true);
  assert.equal(robotsAllows(parseRobots('User-agent: *\nDisallow:\n'), LIST).allowed, true, 'an empty Disallow allows everything');
  assert.equal(robotsAllows(parseRobots('User-agent: *\nDisallow: /\n'), LIST).allowed, false);
  assert.deepEqual([200, 404, 410, 401, 403, 429, 500, 503].map(robotsVerdict), ['rules', 'none', 'none', 'stop', 'stop', 'stop', 'stop', 'stop']);
});

test('fingerprint: a synthetic DealerOn-like page and a synthetic Dealer.com-like page, each with its evidence', () => {
  const on = fingerprint({ url: SITE + '/searchused.aspx', html: DEALERON_LIKE, hosts: assetHosts(DEALERON_LIKE, SITE).scriptHosts });
  assert.equal(on.platform, 'DealerOn');
  assert.ok(on.evidence.some((e) => e.kind === 'host' && e.value === 'cdn.dealeron.com'));
  assert.ok(on.evidence.some((e) => e.kind === 'path' && e.value === '/searchused.aspx'));
  const dc = fingerprint({ url: SITE + '/used-inventory/index.htm', html: DEALERCOM_LIKE, hosts: assetHosts(DEALERCOM_LIKE, SITE).scriptHosts, globals: ['DDC'] });
  assert.equal(dc.platform, 'Dealer.com');
  assert.deepEqual(dc.evidence.filter((e) => e.platform === 'Dealer.com').map((e) => e.kind).sort(), ['global', 'host', 'path', 'text']);
  const di = fingerprint({ url: LIST, html: '<html></html>', globals: ['SEARCH_SERVICE', 'IDPSearchServiceHelper'] });
  assert.equal(di.platform, 'Dealer Inspire');
});

test('fingerprint says unknown instead of guessing: no marker, or only the address shape', () => {
  assert.equal(fingerprint({ url: LIST, html: CAR_PAGE, hosts: ['www.sample-motors.test'] }).platform, 'unknown');
  const pathOnly = fingerprint({ url: SITE + '/searchused.aspx', html: '<html><body>Used cars</body></html>' });
  assert.equal(pathOnly.platform, 'unknown', 'an .aspx address alone is not DealerOn');
  assert.equal(pathOnly.evidence.length, 1, 'but the hint is still reported');
  const both = fingerprint({ url: LIST, html: '', hosts: ['cdn.dealeron.com', 'static.dealer.com'] });
  assert.match(both.platform, /^unclear: /);
  assert.equal(metaGenerator('<meta content="DealerFire 3" name="generator">'), 'DealerFire 3');
  assert.equal(fingerprint({ url: LIST, generator: 'DealerFire 3' }).platform, 'DealerFire');
  assert.equal(metaGenerator('<html></html>'), null);
});

test('findVins keeps only VIN-shaped strings whose check digit is right', () => {
  assert.equal(vinCheckDigit(VIN), VIN[8]);
  const bad = VIN.slice(0, 8) + (VIN[8] === '0' ? '1' : '0') + VIN.slice(9);
  assert.deepEqual(findVins(`vin=${VIN}&x ${bad} ${VIN.toLowerCase()} ABCDEFGHJKLMNPRST 12345678901234567 ${VIN}`), [VIN]);
  assert.deepEqual(findVins(`"${VIN2}"`), [VIN2]);
});

test('jsonLdSummary: the @types, and what the vehicle nodes carry; the excerpt prefers the vehicle block and is cut at 4 KB', () => {
  const s = jsonLdSummary(CAR_PAGE);
  assert.equal(s.blocks, 2);
  assert.deepEqual(s.types, ['AutoDealer', 'Car', 'Offer', 'Product', 'QuantitativeValue']);
  assert.deepEqual([s.vehicles, s.withVin, s.withPrice, s.withCurrency, s.withMileage, s.withImage], [1, 1, 1, 1, 1, 1]);
  const thin = jsonLdSummary('<script type="application/ld+json">{"@type":"Car","name":"x","offers":{"@type":"Offer","price":"1"}}</script>');
  assert.deepEqual([thin.vehicles, thin.withVin, thin.withPrice, thin.withCurrency, thin.withMileage, thin.withImage], [1, 0, 1, 0, 0, 0]);
  assert.match(jsonLdExcerpt(CAR_PAGE), /vehicleIdentificationNumber/, 'the block with the car, not the dealer block before it');
  const big = `<script type="application/ld+json">{"@type":"Car","description":"${'x'.repeat(EXCERPT_LIMIT * 2)}"}</script>`;
  const cut = jsonLdExcerpt(big);
  assert.ok(cut.length < EXCERPT_LIMIT + 60);
  assert.match(cut, /\[cut at 4096 characters\]$/);
  assert.equal(jsonLdExcerpt('<p>none</p>'), null);
});

test('microdataTypes counts item types by their short name', () => {
  const html = '<div itemscope itemtype="https://schema.org/Car"><span itemprop="offers" itemscope itemtype="http://schema.org/Offer"></span></div><div itemscope itemtype="https://schema.org/Car"></div>';
  assert.deepEqual(microdataTypes(html), { Car: 2, Offer: 1 });
  assert.deepEqual(microdataTypes('<p>none</p>'), {});
});

test('car links, the pages picked (VIN addresses first, one per car, never a disallowed one) and the pagination shape', () => {
  const links = carLinks(DEALERON_LIKE, SITE + '/searchused.aspx');
  assert.equal(links.length, 2);
  const list = `<a href="/inventory/used-2019-honda-civic/">a</a><a href="/inventory/used-2019-honda-civic/#photos">same</a>
<a href="/vehicle/${VIN}/">b</a><a href="/vehicle/${VIN}/?ref=x">same car</a><a href="/private/used-2020-kia-soul/">c</a>
<a href="https://elsewhere.test/used-2019-x/">off site</a><a rel="next" href="/used-vehicles/?page=2">Next</a><a href="/used-vehicles/?page=3">3</a>`;
  const found = carLinks(list, LIST);
  assert.ok(!found.some((h) => h.includes('elsewhere.test')), 'only this website');
  const robots = parseRobots('User-agent: *\nDisallow: /private/\n');
  const { picked, disallowed } = pickCarPages(found, 5, robots);
  assert.equal(picked[0], `${SITE}/vehicle/${VIN}/`, 'the address with a VIN comes first');
  assert.equal(picked.length, 2, 'one page per car');
  assert.deepEqual(disallowed.map((d) => [d.url, d.rule]), [[`${SITE}/private/used-2020-kia-soul/`, 'Disallow: /private/']]);
  assert.equal(pickCarPages(found, 1, robots).picked.length, 1);
  assert.equal(pickCarPages(found, 0).picked.length, 0);
  const p = paginationShape(list, LIST);
  assert.equal(p.relNext, SITE + '/used-vehicles/?page=2');
  assert.deepEqual(p.shapes, ['rel=next', '?page=']);
  assert.deepEqual(paginationShape(DEALERON_LIKE, SITE + '/searchused.aspx').shapes, ['?pt=']);
  assert.deepEqual(paginationShape('<a href="/used/page/2/">2</a>', SITE + '/used/').shapes, ['/page/N/']);
});

test('pageAnatomy shows a list whose cars appear only after scripts run', () => {
  const server = pageAnatomy(DEALERCOM_LIKE, SITE + '/used-inventory/index.htm', 200);
  const rendered = pageAnatomy(DEALERCOM_LIKE.replace('<div id="inventory-root"></div>', `<div id="inventory-root"><a href="/used/Honda/2019-Honda-Civic-${VIN}.htm">Civic</a><a href="/used/Toyota/2018-Toyota-RAV4-${VIN2}.htm">RAV4</a></div>`), SITE + '/used-inventory/index.htm', 200);
  assert.deepEqual([server.carLinks, server.vins], [0, 0]);
  assert.deepEqual([rendered.carLinks, rendered.vins], [2, 2]);
  assert.equal(server.title, 'Used Inventory');
  assert.deepEqual(photoHosts(['https://pictures.example-cdn.test/1.jpg', 'https://pictures.example-cdn.test/2.jpg', 'https://www.sample-motors.test/p.png', 'data:x']), { 'pictures.example-cdn.test': 2, 'www.sample-motors.test': 1 });
});

test('jsonEndpoint keeps the address pattern, the top-level keys and the VIN count, never the body or anyone\'s search', () => {
  const body = JSON.stringify({ total: 2, vehicles: [{ vin: VIN, price: 19995 }, { vin: VIN2 }], facets: {} });
  const ep = jsonEndpoint({ url: SITE + '/api/inventory?zip=12345&page=1', method: 'POST', status: 200, contentType: 'application/json; charset=utf-8', body });
  assert.deepEqual(ep, { method: 'POST', pattern: SITE + '/api/inventory?zip=…&page=…', status: 200, topKeys: ['total', 'vehicles', 'facets'], vinCount: 2 });
  assert.ok(!JSON.stringify(ep).includes('19995') && !JSON.stringify(ep).includes('12345'));
  const arr = jsonEndpoint({ url: SITE + '/inv.json', body: JSON.stringify([{ vin: VIN, stock: 'A1' }]), contentType: 'application/json' });
  assert.deepEqual(arr.topKeys, ['[array of 1]', '[].vin', '[].stock']);
  assert.equal(jsonEndpoint({ url: SITE + '/menu.json', body: '{"items":[]}', contentType: 'application/json' }), null, 'no VINs, not kept');
  assert.equal(jsonEndpoint({ url: SITE + '/x', body: 'not json ' + VIN, contentType: 'text/plain' }), null);
  assert.equal(urlPattern('https://a.test/p?x=1&x=2&y='), 'https://a.test/p?x=…&y=…');
});

test('botSigns: a 403, 429 or 503 or a challenge page is a refusal; a CDN header on an ordinary page is only noted', () => {
  for (const status of [403, 429, 503]) assert.equal(botSigns({ status, html: '<p>no</p>' }).refused, true, `HTTP ${status}`);
  const cf = botSigns({ status: 200, headers: { 'CF-RAY': 'abc', server: 'cloudflare' }, html: '<title>Just a moment...</title><p>Checking your browser before accessing</p>' });
  assert.equal(cf.refused, true);
  assert.match(cf.reason, /Cloudflare challenge/);
  const plain = botSigns({ status: 200, headers: { 'cf-ray': 'abc' }, html: CAR_PAGE });
  assert.equal(plain.refused, false);
  assert.deepEqual(plain.signs, ['served through Cloudflare (cf-ray header)']);
  const captcha = botSigns({ status: 200, html: '<p>Please verify you are a human</p>' });
  assert.equal(captcha.refused, true);
  const long = botSigns({ status: 200, html: `<p>recaptcha on the contact form</p>${'<div>car</div>'.repeat(6000)}` });
  assert.equal(long.refused, false, 'a long page that names a captcha is not a challenge page');
  assert.equal(botSigns({ status: 200, html: `<p>captcha</p><a href="/v/${VIN}">car</a>` }).refused, false, 'a small page with cars on it is not a challenge');
  assert.equal(botSigns({ status: 404, html: '<p>Not found</p>' }).refused, false);
});

test("capScanLimits lowers the standard-data adapter's limits in the survey's copy, and fails loudly if they are renamed", () => {
  const src = read('../extension/adapters/schemaOrg.js');
  const out = capScanLimits(src, { carPages: 10, listPages: 5, sitemaps: 2 });
  assert.match(out, /export const MAX_CAR_PAGES = 10;/);
  assert.match(out, /export const MAX_LIST_PAGES = 5;/);
  assert.match(out, /export const MAX_SITEMAPS = 2;/);
  assert.equal(out.length, src.length - 2, 'nothing else changed (600 -> 10 and 40 -> 5 are one digit shorter each, 5 -> 2 the same length)');
  assert.throws(() => capScanLimits('export const OTHER = 1;', { carPages: 1, listPages: 1, sitemaps: 1 }), /MAX_CAR_PAGES/);
  const perms = surveyHostPermissions(['https://www.sample-motors.test/used/', 'http://127.0.0.1:4321/used-vehicles/', 'https://sample-motors2.test/']);
  const ANY = '/' + '*';
  assert.deepEqual(perms, ['https://www.sample-motors.test' + ANY, 'https://sample-motors.test' + ANY, 'http://127.0.0.1' + ANY, 'https://sample-motors2.test' + ANY, 'https://www.sample-motors2.test' + ANY]);
  assert.ok(!perms.some((p) => /facebook/.test(p)));
});

const SNAPSHOT = {
  complete: true,
  site: { adapter: 'schemaOrg' },
  vehicles: {
    [VIN]: { vin: VIN, name: '2019 Honda Civic EX', price: 19995, mileage: 41230, photoCount: 3, type: 'Used', decision: 'ready' },
    [VIN2]: { vin: VIN2, name: '2018 Toyota RAV4 XLE', price: null, mileage: 50000, photoCount: 0, type: 'Used', decision: 'not-ready', reason: 'No price on the website' },
  },
};

test('lotSyncReading counts what the scan stored and summarises the service without its values', () => {
  const r = lotSyncReading({
    snapshot: SNAPSHOT,
    diff: { warnings: ['This lot has more car pages than one scan reads, so 3 cars\' pages were left for the next scan.'], requests: 7 },
    site: { adapter: 'dealerInspire', service: { search: 'https://search.example.test/api/v1/listings/1', apiKey: 'secret-value', visibleStatusValues: ['publish'] }, photoOrigins: ['https://photos.example-cdn.test'] },
    metaText: '2 used cars · 1 ready to post',
  });
  assert.deepEqual([r.adapter, r.carCount, r.withVin, r.withPrice, r.withMileage, r.withPhotos, r.requests, r.complete], ['dealerInspire', 2, 2, 1, 2, 1, 7, true]);
  assert.deepEqual(r.decisions, { 'not-ready': 1, ready: 1 });
  assert.equal(r.firstCars.length, 2);
  assert.deepEqual(r.service.keys, ['apiKey', 'search', 'visibleStatusValues']);
  assert.equal(r.service.searchHost, 'search.example.test');
  assert.ok(!JSON.stringify(r).includes('secret-value'), 'never the key itself');
  assert.equal(lotSyncReading({}).carCount, 0);
});

test('verdictFor: reads it, partly, doesn\'t read it, and not surveyed, each with its reason', () => {
  const base = { list: { server: { carLinks: 2 }, rendered: { carLinks: 2 } }, carPagesSummary: { read: 2, withVehicleJsonLd: 2, withVehicleMicrodata: 0 } };
  const ok = { attempted: true, ok: true, adapter: 'schemaOrg', adapterName: 'Standard vehicle data (schema.org)', carCount: 10, withPrice: 10, withMileage: 10, withPhotos: 9, warnings: [] };
  const reads = verdictFor({ ...base, lotSync: ok });
  assert.equal(reads.verdict, 'reads it');
  assert.match(reads.notes.join(), /1 of 10 cars have no photos/, 'one car without photos is a note: the website may have none');
  const capped = verdictFor({ ...base, lotSync: { ...ok, warnings: ['This lot has more car pages than one scan reads, so 5 cars\' pages were left for the next scan.'] } });
  assert.equal(capped.verdict, 'reads it', "the survey's own cap is not a gap");
  assert.match(capped.notes.join(), /survey's own cap/);
  const noPrice = verdictFor({ ...base, lotSync: { ...ok, withPrice: 3 } });
  assert.equal(noPrice.verdict, 'partly');
  assert.match(noPrice.why, /7 of 10 cars have no price/);
  const scripted = verdictFor({ ...base, list: { server: { carLinks: 0 }, rendered: { carLinks: 2 } }, lotSync: ok });
  assert.equal(scripted.verdict, 'partly');
  assert.match(scripted.gaps.join(), /only after scripts run/);
  const fewer = verdictFor({ ...base, list: { server: { carLinks: 20 }, rendered: { carLinks: 20 } }, lotSync: { ...ok, carCount: 3, withPrice: 3, withMileage: 3, withPhotos: 3 } });
  assert.match(fewer.gaps[0], /read 3 cars, but the list's first page alone links to 20/);
  const unsupported = verdictFor({ ...base, lotSync: { attempted: true, ok: false, message: "Lot Sync can't read the cars on this page." } });
  assert.deepEqual([unsupported.verdict, unsupported.why], ["doesn't read it", "Lot Sync can't read the cars on this page."]);
  assert.equal(verdictFor({ ...base, lotSync: { ...ok, carCount: 0 } }).verdict, "doesn't read it");
  const drawn = verdictFor({ ...base, list: { server: { carLinks: 0 }, rendered: { carLinks: 2 } }, lotSync: { attempted: true, ok: false, message: 'Lot Sync found no links to car pages on the inventory page.' } });
  assert.equal(drawn.verdict, "doesn't read it");
  assert.match(drawn.gaps[1], /only after scripts run/, 'the anatomy says why');
  const refused = verdictFor({ ...base, stopped: { at: 'list page', reason: 'the website refused the list page (HTTP 403)' }, lotSync: { attempted: false } });
  assert.deepEqual([refused.verdict, refused.why], ['not surveyed', 'the website refused the list page (HTTP 403)']);
  assert.equal(verdictFor({ lotSync: { attempted: false, skippedReason: 'robots.txt disallows most car pages' } }).why, 'robots.txt disallows most car pages');
});

test('the reports: the per-site report.md carries the platform evidence, the gaps, the cap and the verdict; summary.md has one row per site', () => {
  const report = {
    host: 'www.sample-motors.test', input: LIST, surveyedAt: '2026-09-30T00:00:00.000Z', lotSyncVersion: '0.0.0',
    limits: { maxCarPages: 5, pauseMs: 2000, capText: 'at most 8 pages per site' },
    robots: { status: 404, rules: 0, note: 'no robots.txt, so no rules' },
    list: { finalUrl: LIST, title: 'Used', platform: fingerprint({ url: LIST, html: '' }), server: pageAnatomy(DEALERCOM_LIKE, LIST, 200), rendered: pageAnatomy(DEALERON_LIKE, LIST, 200), pagination: { shapes: ['?pt='] } },
    carPages: [{ url: SITE + '/v/1', status: 200, jsonLd: jsonLdSummary(CAR_PAGE), microdata: {}, serverVins: 1, photoHosts: { 'photos.example-cdn.test': 1 } }],
    carPagesSummary: { read: 1, withVehicleJsonLd: 1, withVehicleMicrodata: 0 },
    jsonEndpoints: [{ method: 'GET', pattern: SITE + '/api/inventory?page=…', status: 200, topKeys: ['vehicles'], vinCount: 2, page: 'list page' }],
    excerpt: { from: SITE + '/v/1', text: jsonLdExcerpt(CAR_PAGE) },
    requests: { survey: 4, robots: 1, list: 1, listServerHtml: 1, carPages: 1, browserTotal: 9, blockedMedia: 3, lotSyncScan: 5 },
    bot: { signs: [] },
    lotSync: { attempted: true, ok: true, ...lotSyncReading({ snapshot: SNAPSHOT }), adapterName: 'Standard vehicle data (schema.org)' },
  };
  report.verdict = verdictFor(report);
  const md = renderReportMd(report);
  assert.match(md, /^# Site survey: www\.sample-motors\.test$/m);
  assert.match(md, /\*\*unknown\*\* \(no known marker matched; not guessed\)/);
  assert.match(md, /car links only after scripts run: yes/);
  assert.match(md, /`https:\/\/www\.sample-motors\.test\/api\/inventory\?page=…`/);
  assert.match(md, /```json\n[\s\S]*vehicleIdentificationNumber/);
  assert.match(md, /\*\*Verdict: partly\.\*\*/);
  assert.match(md, /cap: at most 8 pages per site/);
  assert.match(md, /\| 1HGCM82633A004352 \| 2019 Honda Civic EX \| 19995 \| 41230 \| 3 \|/);
  const summary = renderSummaryMd([report, { host: 'refused.test', stopped: { reason: 'x' }, verdict: { verdict: 'not surveyed', why: 'the website refused the list page (HTTP 403)' } }], { runAt: 'now' });
  const rows = summary.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Site'));
  assert.equal(rows.length, 2);
  assert.match(rows[0], /^\| www\.sample-motors\.test \| unknown \| 0 \/ 0 \| 2 \/ 2 \| 1 \/ 0 of 1 \| schemaOrg \| 2 \(1 \/ 2 \/ 1\) \| \*\*partly\*\*/);
  assert.match(rows[1], /^\| refused\.test \| unknown \|.*\*\*not surveyed\*\*: the website refused the list page \(HTTP 403\) \|$/);
});

test('the survey script: its npm command, an ignored output folder, the how-to, and no detection evasion', () => {
  const pkg = JSON.parse(read('../package.json'));
  assert.equal(pkg.scripts.survey, 'node scripts/survey.mjs');
  assert.match(read('../.gitignore'), /^survey-out\/$/m);
  assert.ok(existsSync(new URL('../docs/survey.md', import.meta.url)));
  const doc = read('../docs/survey.md');
  for (const words of ['npm run survey', 'PowerShell', '2 seconds', 'robots.txt', 'user agent', 'summary.md', 'report.json']) assert.ok(doc.includes(words), `docs/survey.md does not mention "${words}"`);
  const src = read('../scripts/survey.mjs');
  // the browser as it is: no user agent of ours, nothing random about the timing, no hiding
  for (const re of [/userAgent\s*:/, /Math\.random/, /stealth/i, /webdriver/i, /--disable-blink-features/, /extraHTTPHeaders/, /proxy\s*:/]) assert.doesNotMatch(src, re);
  assert.match(src, /isFacebook\(hostOf\(req\.url\(\)\)\)[\s\S]{0,120}route\.abort/, 'any request to Facebook is blocked');
  assert.ok(DEFAULTS.pauseMs >= 2000, 'at least 2 seconds between the survey\'s own requests');
  assert.equal((src.match(/if \(bot\.refused\) stop\(/g) || []).length, 3, 'a refusal on the list, its server HTML or a car page stops the site');
});
