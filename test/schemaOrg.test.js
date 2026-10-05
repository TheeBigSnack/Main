// The standard vehicle data reader (extension/adapters/schemaOrgParse.js and
// schemaOrgNormalize.js): the schema.org JSON-LD and microdata a dealer
// website publishes for search engines, read into the one flat vehicle.
// The pages are synthetic (test/fixtures/structured/_about.md): written from
// the public schema.org definitions and Google's vehicle listing
// documentation, never copied from a platform, so nothing here claims that
// a named platform works.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import { extractJsonLd, vehicleNodes, microdataVehicles, pageFacts, parseVehiclePage, TEXT_LIMIT } from '../extension/adapters/schemaOrgParse.js';
import { normalizeVehicle, priceFromOffers, milesFromOdometer, readingNotes } from '../extension/adapters/schemaOrgNormalize.js';
import { normalizeVehicle as dealerInspireVehicle } from '../extension/adapters/dealerInspireNormalize.js';
import { trimRecord } from '../extension/adapters/dealerInspire.js';
import { PAGE_TEXT_LIMIT } from '../extension/adapters/schemaOrg.js';
import { VEHICLE_FIELDS } from '../extension/src/vehicle.js';
import { assessVehicle, readCondition, DECISION } from '../extension/src/classify.js';
import { fixtures, MY_STORE } from './helpers.js';

const SITE = 'https://www.sample-motors.test';
const DIR = new URL('./fixtures/structured/', import.meta.url);
const html = (file) => readFileSync(new URL(file, DIR), 'utf8');
const PAGES = readdirSync(DIR).filter((f) => f.endsWith('.html')).sort();

// A fixture page read the way a scan reads one: its nodes, its facts and the flat cars.
function readPage(file, url = SITE + '/inventory/' + file.replace('.html', '/')) {
  const { vehicles, facts } = parseVehiclePage(html(file), url);
  return { nodes: vehicles, facts, url, cars: vehicles.map((n) => normalizeVehicle(n, { url, facts })) };
}
const civicUrl = SITE + '/inventory/used-2019-honda-civic-ex-2hgsampl8kh000101/';

// A car node for the rules below, with the page text that shows its price and miles.
const car = (patch = {}) => ({
  '@type': 'Car',
  name: 'Used 2019 Honda Civic EX',
  vehicleIdentificationNumber: '2HGSAMPL8KH000101',
  vehicleModelDate: '2019',
  brand: 'Honda',
  model: 'Civic',
  vehicleConfiguration: 'EX',
  itemCondition: 'https://schema.org/UsedCondition',
  mileageFromOdometer: { '@type': 'QuantitativeValue', value: 41230, unitCode: 'SMI' },
  image: '/photos/civic-1.jpg',
  offers: { '@type': 'Offer', price: 19995, priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
  ...patch,
});
const shown = (text = 'Price $19,995 \u00b7 41,230 miles', more = {}) => ({ title: '', canonical: null, next: null, links: [], carfaxLinks: [], text, ...more });
const flat = (patch, facts = shown(), url = civicUrl) => normalizeVehicle(car(patch), { url, facts });

// ---------- the fixtures ----------

test('the structured-data fixtures are synthetic, say so, and cover every shape the reader promises', () => {
  const about = html('_about.md');
  assert.match(about, /synthetic/i);
  assert.match(about, /schema\.org/);
  for (const f of PAGES) assert.ok(about.includes('`' + f + '`'), `_about.md does not describe ${f}`);
  assert.ok(PAGES.length >= 12);
  for (const f of PAGES) {
    const src = html(f);
    assert.doesNotMatch(src, /Waynesburg|Ron Lewis|Cranberry|ronlewis|facebook\.com/i, `${f} names a real dealership or Facebook`);
    for (const vin of src.match(/"vehicleIdentificationNumber"[^"]*"([^"]+)"/g) || []) assert.match(vin, /SAMPL/i, `${f}: the VINs are visibly samples`);
  }
});

// ---------- JSON-LD ----------

test('extractJsonLd parses every ld+json block and skips a bad one without failing', () => {
  const graph = extractJsonLd(html('graph-vdp.html'));
  assert.equal(graph.length, 1);
  assert.equal(graph[0]['@graph'].length, 4);
  // malformed.html: a missing comma, a plain application/json script, a
  // block inside an HTML comment, an empty block and a bare string are all
  // skipped; a raw line break inside a string is repaired
  const malformed = extractJsonLd(html('malformed.html'));
  assert.deepEqual(malformed.map((b) => b['@type']), ['AutoDealer', 'Car']);
  assert.equal(malformed[1].description, 'Line one of the write-up.\n\tLine two, after a raw line break and a tab.');
  assert.deepEqual(extractJsonLd(''), []);
  assert.deepEqual(extractJsonLd(null), []);
  assert.deepEqual(extractJsonLd('<script type="Application/LD+JSON; charset=utf-8">{"@type":"Car"}</script>'), [{ '@type': 'Car' }]);
  assert.deepEqual(extractJsonLd('<script type="application/ld+json">{"a": 1}</SCRIPT ><p>after</p>'), [{ a: 1 }]);
});

test('entities, CDATA sections and byte order marks are handled', () => {
  const blocks = extractJsonLd(html('entities.html'));
  assert.deepEqual(blocks.map((b) => b['@type']), ['Car', 'AutoDealer', 'WebSite']);
  assert.equal(blocks[0].name, 'Used 2020 GMC Sierra 1500 SLE & Z71');
  assert.equal(blocks[0].vehicleInteriorColor, 'Jet Black / Dark Ash');
  assert.equal(blocks[0].description, 'Tow package & spray-in bed liner \u2013 "clean" inside!');
  assert.equal(blocks[1].name, 'Sample Motors & Service', 'a block escaped as a whole is read, and its entities once only');
});

test('vehicleNodes finds cars in @graph, arrays, lists, mainEntity and multi-typed nodes, and nothing else', () => {
  const [civic] = vehicleNodes(extractJsonLd(html('graph-vdp.html')));
  assert.equal(civic.vehicleIdentificationNumber, '2HGSAMPL8KH000101');
  assert.equal(civic.offers.price, '19995', 'the offer given by @id is followed');
  assert.equal(civic.offers.seller.name, 'Sample Motors', 'and so is its seller');
  assert.equal(vehicleNodes(extractJsonLd(html('graph-vdp.html'))).length, 1, 'mainEntity and @graph point at the same car: once');

  const array = vehicleNodes(extractJsonLd(html('array-product.html')));
  assert.deepEqual(array.map((n) => n.vehicleIdentificationNumber), ['2T3SAMPL8MW000102'], 'a Product with a VIN counts; the organisation and the service plan do not');
  assert.equal(vehicleNodes(extractJsonLd(html('multitype.html'))).length, 1, '["Product", "Car"]');

  const list = vehicleNodes(extractJsonLd(html('list-page.html')));
  assert.deepEqual(list.map((n) => n['@type']), ['Car', 'Car', 'MotorVehicle', 'Motorcycle'], 'in list order; the gift card is no vehicle');

  // types written as addresses, an offer that carries its car, a car's own properties
  const blocks = [
    { '@type': 'https://schema.org/Car', vehicleIdentificationNumber: 'A' },
    { '@type': 'schema:Vehicle', vehicleIdentificationNumber: 'B', isSimilarTo: { '@type': 'Car', vehicleIdentificationNumber: 'C' } },
    { '@type': 'Offer', price: 100, priceCurrency: 'USD', itemOffered: { '@type': 'Car', vehicleIdentificationNumber: 'D' } },
    { '@type': 'Product', name: 'Floor mats' },
  ];
  const found = vehicleNodes(blocks);
  assert.deepEqual(found.map((n) => n.vehicleIdentificationNumber), ['A', 'B', 'D'], 'a car inside another car\'s properties is not a listing of its own');
  assert.deepEqual(found[2].offers, { '@type': 'Offer', price: 100, priceCurrency: 'USD' }, 'the offer that carries a car becomes its offers, without the car inside');
  // the car first in a graph and its offer after it, pointing back by @id
  const graph = { '@graph': [{ '@type': 'Car', '@id': '#c', vehicleIdentificationNumber: 'E' }, { '@type': 'Offer', price: 5, itemOffered: { '@id': '#c' } }] };
  assert.equal(vehicleNodes([graph])[0].offers.price, 5);
  for (const junk of [null, undefined, 'x', 7, [1, 2], {}, [{ '@graph': null }]]) assert.deepEqual(vehicleNodes(junk), []);
  // a reference loop does not hang
  const loop = { '@type': 'Car', '@id': '#x', vehicleIdentificationNumber: 'F', offers: { '@id': '#x' } };
  assert.equal(vehicleNodes([loop]).length, 1);
  // a "__proto__" key in a page's JSON is only data
  const [sly] = parseVehiclePage('<script type="application/ld+json">{"@type":"Car","vehicleIdentificationNumber":"G","__proto__":{"offers":{"price":1}}}</script>', SITE).vehicles;
  assert.equal(Object.getPrototypeOf(sly), Object.prototype);
  assert.equal(sly.offers, undefined);
});

// ---------- microdata ----------

test('microdataVehicles reads itemprop microdata into nodes of the same shape', () => {
  const nodes = microdataVehicles(html('microdata.html'), SITE + '/inventory/crv/');
  assert.equal(nodes.length, 1, 'the dealer in the footer is not a vehicle');
  assert.deepEqual(nodes[0], {
    '@type': 'Car',
    name: 'Used 2019 Honda CR-V EX',
    vehicleIdentificationNumber: '2HKSAMPL8KH000119',
    sku: 'SM1019',
    vehicleModelDate: '2019',
    brand: { '@type': 'Brand', name: 'Honda' },
    model: 'CR-V',
    vehicleConfiguration: 'EX',
    itemCondition: 'https://schema.org/UsedCondition',
    mileageFromOdometer: { '@type': 'QuantitativeValue', value: '38410', unitCode: 'SMI' },
    image: ['https://www.sample-motors.test/inventory/photos/crv-1.jpg', 'https://images.sample-motors.test/crv-2.jpg'],
    color: 'Platinum White Pearl',
    vehicleInteriorColor: 'Black',
    driveWheelConfiguration: 'https://schema.org/AllWheelDriveConfiguration',
    offers: { '@type': 'Offer', priceCurrency: 'USD', price: '25995', availability: 'https://schema.org/InStock', seller: { '@type': 'AutoDealer', name: 'Sample Motors' } },
    description: 'Heated seats, sunroof & lane keeping assist.',
    url: 'https://www.sample-motors.test/inventory/used-2019-honda-cr-v-ex-2hksampl8kh000119/',
  }, 'relative addresses resolve against the page\'s <base href>');
  assert.deepEqual(extractJsonLd(html('microdata.html')), [], 'a microdata-only page has no JSON-LD');
  assert.deepEqual(microdataVehicles('<li itemscope itemtype="http://schema.org/Car"><span itemprop="vehicleIdentificationNumber">A</span><li itemscope itemtype="http://schema.org/Car"><span itemprop="vehicleIdentificationNumber">B</span>').map((n) => n.vehicleIdentificationNumber), ['A', 'B'], 'unclosed list items still give one car each');
});

// ---------- page facts ----------

test('pageFacts: the title, canonical, next and previous page, same-origin links, Carfax links and only the visible text', () => {
  const f = pageFacts(html('graph-vdp.html'), civicUrl + '?from=search');
  assert.deepEqual(Object.keys(f), ['title', 'canonical', 'next', 'prev', 'links', 'carfaxLinks', 'text', 'segments']);
  assert.equal(f.title, 'Used 2019 Honda Civic EX Sedan', 'the og:title, without the site name');
  assert.equal(f.canonical, civicUrl);
  assert.equal(f.next, null);
  assert.equal(f.prev, null);
  assert.deepEqual(f.links, [SITE + '/', SITE + '/used-vehicles/', civicUrl + '?from=search'], 'absolute, once each, fragments dropped; mailto and other sites left out');
  assert.deepEqual(f.carfaxLinks, ['https://www.carfax.com/VehicleHistory/p/Report.cfx?partner=SMP_0&vin=2HGSAMPL8KH000101', 'https://www.carfax.com/value/']);
  assert.match(f.text, /Sample Motors Price \$ 19,995 41,230 miles/);
  for (const unseen of ['18,500', '20,995', '99999', 'dataLayer', 'content:', 'for Sale | Sample Motors']) assert.ok(!f.text.includes(unseen), `"${unseen}" is not on the page a person sees`);

  const list = pageFacts(html('list-page.html'), SITE + '/used-vehicles/');
  assert.equal(list.title, 'Used Vehicles for Sale | Sample Motors', 'no og:title: the <title>');
  assert.equal(list.next, SITE + '/used-vehicles/?page=2');
  assert.deepEqual(list.links, [
    SITE + '/inventory/used-2018-chevrolet-equinox-lt-3gnsampl0jl000105/',
    SITE + '/inventory/used-2017-ram-1500-big-horn-1c6sampl8hs000106/',
    SITE + '/inventory/used-2021-hyundai-tucson-sel-5nmsampl2mu000107/',
    SITE + '/inventory/used-2020-harley-davidson-street-glide-1hdsampl1lb000108/',
    SITE + '/used-vehicles/?page=1',
    SITE + '/used-vehicles/?page=2',
    SITE + '/used-vehicles/#/compare',
  ], 'the photo link and the "#photos" link are one page; a "#/" route is a page of its own');
  assert.equal(pageFacts('<a rel="next nofollow" href="p2">2</a>', SITE + '/list/').next, SITE + '/list/p2');
  assert.equal(pageFacts('<link rel="prev" href="?page=1"><a rel="previous" href="p0">0</a>', SITE + '/list/?page=2').prev, SITE + '/list/?page=1');
  assert.equal(pageFacts('<a rel="previous nofollow" href="p1">1</a>', SITE + '/list/').prev, SITE + '/list/p1');
  assert.equal(pageFacts(html('entities.html'), SITE + '/x/').title, 'Used 2020 GMC Sierra 1500 SLE & Z71');
  assert.match(pageFacts(html('entities.html'), SITE + '/x/').text, /Price: \$38,450 36,112 miles/, 'a non-breaking space is a space');
  // without a usable page address nothing can be called same-origin
  assert.deepEqual(pageFacts(html('list-page.html'), 'not a url').links, []);
  assert.equal(pageFacts(html('list-page.html'), 'not a url').canonical, SITE + '/used-vehicles/', 'an absolute canonical still reads');
  // the text is capped
  const long = pageFacts('<p>' + 'word '.repeat(TEXT_LIMIT) + '</p>', SITE + '/');
  assert.equal(long.text.length, TEXT_LIMIT);
});

test('parseVehiclePage: JSON-LD first, then microdata, one car per VIN, with the facts', () => {
  const { vehicles, facts } = parseVehiclePage(html('carousel.html'), SITE + '/inventory/used-2021-kia-sorento-lx-5xysampl6mg000114/');
  assert.deepEqual(vehicles.map((n) => n.vehicleIdentificationNumber), ['5XYSAMPL6MG000114', '1HGSAMPLXKA000115', '4T1SAMPL9LU000116', '5XYSAMPLXVG000117', '1FMSAMPLXJU000118']);
  assert.equal(vehicles[0].offers.price, 24995, 'the microdata copy of the same car, with an older price, is dropped');
  assert.equal(facts.links.length, 4);
  const microOnly = parseVehiclePage(html('microdata.html'), SITE + '/inventory/crv/');
  assert.equal(microOnly.vehicles.length, 1);
  // a node without a VIN is kept for a caller that follows its address
  assert.equal(parseVehiclePage('<script type="application/ld+json">[{"@type":"Car","url":"/a"},{"@type":"Car","url":"/b"}]</script>', SITE).vehicles.length, 2);
  assert.deepEqual(parseVehiclePage('', SITE).vehicles, []);
});

test('the tokenizer follows the browser\'s rules and costs one pass, whatever the page', () => {
  // the first of two attributes wins; a "/" inside an unquoted value does not close the tag
  assert.deepEqual(pageFacts('<a href="/one" href="/two">x</a><a href=/cars/>y</a>', SITE + '/').links, [SITE + '/one', SITE + '/cars/']);
  // a quote opens a value only after "="; a stray one is part of a name
  assert.deepEqual(pageFacts('<a "odd" href="/ok">x</a>', SITE + '/').links, [SITE + '/ok']);
  // a value whose quote never closes runs to the end of the page, as in a browser
  assert.equal(pageFacts('<p>$1,000</p><a href="/open>never closed<p>$2,000</p>', SITE + '/').text, '$1,000');
  // "/>" closes an element; a "/" that ends an unquoted value does not; on a script it changes nothing
  assert.equal(microdataVehicles('<div itemscope itemtype="https://schema.org/Car"><span itemprop="model" data-x=/y/>Civic<br/>EX</span></div>')[0].model, 'Civic EX');
  assert.deepEqual(extractJsonLd('<script type="application/ld+json" />{"a": 1}</script>'), [{ a: 1 }]);
  // comments, doctypes and a lone "<" are not tags
  assert.equal(pageFacts('<!doctype html><!-- <p>$9</p> --><p>1 < 2</p>', SITE + '/').text, '1 < 2');
  // pages built to be slow are read in one pass: stray quotes, unclosed tags, lone brackets
  const started = Date.now();
  for (const hostile of ['<a "'.repeat(200000), '<a x="'.repeat(200000), '<div>'.repeat(200000), '<'.repeat(200000)]) parseVehiclePage(hostile, SITE + '/');
  assert.ok(Date.now() - started < 5000, `${Date.now() - started} ms for four hostile pages`);
});

// A page built to be slow, as big as a scan reads (PAGE_TEXT_LIMIT), or
// half that where the page is only tags, read in well under a second.
function quick(label, run, ms = 1000) {
  const started = performance.now();
  const result = run();
  const took = performance.now() - started;
  assert.ok(took < ms, `${label}: ${Math.round(took)} ms`);
  return result;
}
const HOSTILE_VIN = '1G1SAMPL7MF000120';

test('references by @id: a node that points at itself thousands of times is copied a bounded number of times', () => {
  const refs = Array.from({ length: 20000 }, () => ({ '@id': '#b' }));
  const blocks = [{ '@id': '#b', '@type': 'Car', vehicleIdentificationNumber: HOSTILE_VIN, r: refs, offers: { '@id': '#o' } }, { '@id': '#o', '@type': 'Offer', price: 19995, priceCurrency: 'USD' }];
  const page = `<script type="application/ld+json">${JSON.stringify(blocks)}</script>`;
  const { vehicles } = quick('20,000 references to itself', () => parseVehiclePage(page, SITE + '/'));
  assert.equal(vehicles.length, 1);
  assert.equal(vehicles[0].vehicleIdentificationNumber, HOSTILE_VIN);
  assert.equal(vehicles[0].r.length, 20000);
  assert.ok(JSON.stringify(vehicles[0]).length < 20 * page.length, 'the copy stays the size of the page, so it can be stored and sent');
  // many cars that all point at one wide node share the page's limit
  const wide = { '@id': '#w', k: Array.from({ length: 50000 }, (_, i) => i) };
  const many = Array.from({ length: 30000 }, () => ({ '@type': 'Car', x: { '@id': '#w' } }));
  assert.equal(quick('30,000 cars pointing at one wide node', () => vehicleNodes([wide, ...many])).length, 30000);
  // a real car is copied whole: its offer and seller by @id, as graph-vdp.html shows
  const [civic] = vehicleNodes(extractJsonLd(html('graph-vdp.html')));
  assert.equal(civic.offers.seller.name, 'Sample Motors');
});

test('pages built to be slow read in one pass: stray end tags, nested itemprops, thousands of links, long blocks', () => {
  const half = Math.floor(PAGE_TEXT_LIMIT / 2);
  // thousands of unclosed tags, then as many end tags that close nothing
  const tags = Math.floor(half / 9 / 2);
  quick('stray end tags', () => parseVehiclePage('<div>'.repeat(tags) + '</b>'.repeat(tags), SITE + '/'));
  // itemprops nested inside one another: each value is its whole subtree
  const nested = '<div itemscope itemtype="https://schema.org/Car"><span itemprop="vehicleIdentificationNumber">' + HOSTILE_VIN + '</span>' + '<span itemprop="name">x'.repeat(Math.floor(half / 25));
  const [deep] = quick('nested itemprops', () => parseVehiclePage(nested, SITE + '/')).vehicles;
  assert.equal(deep.vehicleIdentificationNumber, HOSTILE_VIN, 'the car is still read');
  // a real description, and a wrapper around a whole page, still read as written
  const description = 'Heated seats. '.repeat(700).trim();
  const wrapped = `<body itemscope itemtype="https://schema.org/WebPage"><main itemprop="mainContentOfPage">${'<p>Filler text. </p>'.repeat(20000)}</main><div itemscope itemtype="https://schema.org/Car"><span itemprop="vehicleIdentificationNumber">${HOSTILE_VIN}</span><div itemprop="description">${description}</div></div></body>`;
  const [real] = microdataVehicles(wrapped, SITE + '/');
  assert.equal(real.description, description);
  // thousands of different links
  const links = Array.from({ length: Math.floor(half / 26) }, (_, i) => `<a href="/c/${i}">x</a>`).join('');
  const facts = quick('distinct links', () => pageFacts(links, SITE + '/'));
  assert.equal(facts.links.length, Math.floor(half / 26));
  assert.equal(facts.links[7], SITE + '/c/7');
  // a JSON-LD block with a long run of spaces inside it (the CDATA ending is taken off by hand)
  quick('a block of spaces', () => extractJsonLd('<script type="application/ld+json">{' + ' '.repeat(PAGE_TEXT_LIMIT) + 'x}</script>'));
  assert.deepEqual(extractJsonLd('<script type="application/ld+json">//<![CDATA[\n{"a": 1}\n//]]></script><script type="application/ld+json">/*<![CDATA[*/{"b": 2}/*]]>*/</script><script type="application/ld+json"><![CDATA[{"c": 3}]]></script>'), [{ a: 1 }, { b: 2 }, { c: 3 }]);
  // a block with thousands of raw line breaks, repaired in one pass
  assert.equal(quick('raw line breaks', () => extractJsonLd('<script type="application/ld+json">{"description": "' + 'a\n'.repeat(half / 2) + '"}</script>'))[0].description.length, half);
});

test('the price and mileage checks read a long run of digits and commas in one pass', () => {
  // as long as the page text can be, a comma-grouped run that never ends
  const run = '1' + ',111'.repeat(Math.floor((TEXT_LIMIT - 10) / 4)) + ',11';
  const facts = shown('$' + run + ' miles ' + 'Mileage: ' + run);
  // a text search, so a tighter limit: it takes a millisecond or two
  quick('price', () => priceFromOffers(car(), facts), 250);
  quick('mileage', () => milesFromOdometer(car({ mileageFromOdometer: { value: 41230 } }), facts), 250);
  quick('flat vehicle', () => normalizeVehicle(car({ mileageFromOdometer: { value: 41230 } }), { url: civicUrl, facts }));
  quick('digits', () => milesFromOdometer(car({ mileageFromOdometer: { value: 41230 } }), shown('9'.repeat(TEXT_LIMIT) + ' miles')));
  quick('a mileage written out', () => milesFromOdometer(car({ mileageFromOdometer: '1' + '.'.repeat(TEXT_LIMIT) + '!' }), shown('')));
  quick('photos and features', () => normalizeVehicle(car({ image: Array.from({ length: 50000 }, (_, i) => '/p/' + i + '.jpg'), features: Array.from({ length: 50000 }, (_, i) => 'Feature ' + i) }), { url: civicUrl, facts: shown() }));
  // and the bounds read every real price and mileage
  assert.equal(priceFromOffers(car({ offers: { '@type': 'Offer', price: 1250000, priceCurrency: 'USD' } }), shown('$1,250,000')).value, 1250000);
  assert.deepEqual(milesFromOdometer(car({ mileageFromOdometer: { value: 1250000 } }), shown('1,250,000 miles')), { value: 1250000, reason: '' });
  assert.deepEqual(milesFromOdometer(car({ mileageFromOdometer: { value: 41230 } }), shown('41,230,5 miles')), { value: null, reason: 'the page gives no unit for the mileage' }, 'part of a bigger number');
});

test('the reader is pure: no DOM, no network, no platform named', () => {
  for (const file of ['schemaOrgParse.js', 'schemaOrgNormalize.js']) {
    const src = readFileSync(new URL('../extension/adapters/' + file, import.meta.url), 'utf8');
    const code = src.replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
    assert.doesNotMatch(code, /DOMParser|\bdocument\.|\bwindow\.|\bfetch\(|XMLHttpRequest|chrome\./, `${file} must run in the service worker and never fetch`);
    assert.doesNotMatch(code, /Dealer ?Inspire|Dealer\.com|DealerOn|eProcess|DealerFire|carscommerce/i, `${file} names a platform in its code; it reads a public standard`);
  }
  // and it runs with nothing but the language itself and URL in scope
  const ctx = vm.createContext({ URL });
  const run = vm.runInContext('(f, ...a) => f(...a)', ctx);
  assert.equal(run(parseVehiclePage, html('graph-vdp.html'), civicUrl).vehicles.length, 1);
});

// ---------- the flat vehicle ----------

test('normalizeVehicle maps a vehicle page to exactly the flat vehicle, field by field', () => {
  const { cars } = readPage('graph-vdp.html', civicUrl);
  assert.deepEqual(cars[0], {
    vin: '2HGSAMPL8KH000101',
    stock: 'SM1001',
    year: 2019,
    make: 'Honda',
    model: 'Civic',
    trim: 'EX',
    name: '2019 Honda Civic EX',
    inventoryType: 'Used',
    siteTitle: 'Used 2019 Honda Civic EX',
    readableType: null,
    url: civicUrl,
    urlConditionWord: 'used',
    isDemo: false,
    isLoaner: false,
    carfaxUrl: 'https://www.carfax.com/VehicleHistory/p/Report.cfx?partner=SMP_0&vin=2HGSAMPL8KH000101',
    carfaxOneOwner: false,
    mileage: 41230,
    price: 19995,
    priceLabel: 'Price',
    priceBeforeFees: null,
    status: 'InStock',
    statusLabel: '',
    availability: 'In-Stock',
    inTransit: false,
    location: 'Sample Motors',
    locationShort: 'Sample Motors',
    photoCount: 3,
    photos: [SITE + '/photos/civic-1.jpg', 'https://images.sample-motors.test/civic-2.jpg', SITE + '/photos/civic-3.jpg'],
    dateInStock: null,
    descriptionRaw: 'One owner, serviced here since new.',
    features: [],
    exteriorColor: 'Lunar Silver Metallic',
    interiorColor: 'Gray',
    bodyType: 'Sedan',
    drivetrain: 'FWD',
    engine: '1.5L Turbo 4-Cylinder',
    transmission: 'CVT',
    fuelType: 'Gasoline',
  });
  assert.equal(assessVehicle(cars[0], {}).decision, DECISION.READY);
  assert.equal(assessVehicle(cars[0], {}).reason, 'Pre-owned: inventory type, web address, title and Carfax agree.');
});

test('every car on every fixture page has exactly VEHICLE_FIELDS; no valid VIN, no vehicle', () => {
  let count = 0;
  for (const f of PAGES) {
    for (const v of readPage(f).cars) {
      assert.ok(v, `${f}: every fixture car has a VIN`);
      assert.deepEqual(Object.keys(v).sort(), [...VEHICLE_FIELDS].sort(), `${f} ${v.vin}`);
      assert.equal(v.vin, v.vin.toUpperCase());
      count += 1;
    }
  }
  assert.ok(count >= 18, `${count} cars across the fixtures`);
  assert.equal(readPage('price-string.html').cars[0].vin, '1C6SAMPL4KS000109', 'a lower-case VIN is upper-cased');
  for (const vin of [undefined, '', '2HGSAMPL8KH00010', '2HGSAMPL8KH0001011', '2HGSAMPLOKH000101', 'not a vin at all!']) assert.equal(flat({ vehicleIdentificationNumber: vin }), null, `VIN ${vin}`);
  assert.equal(normalizeVehicle(null), null);
  assert.equal(normalizeVehicle('car'), null);
  assert.equal(normalizeVehicle(car(), undefined).vin, '2HGSAMPL8KH000101', 'no page given: still a vehicle, with what the node alone says');
});

test('identity: stock from sku, year from the model date or the name, make from brand or manufacturer, the trim never doubled', () => {
  const ram = readPage('price-string.html').cars[0];
  assert.deepEqual([ram.stock, ram.year, ram.make, ram.model, ram.trim, ram.name], ['SM1009', 2019, 'Ram', '1500 Classic', 'Express', '2019 Ram 1500 Classic Express']);
  const f150 = readPage('multitype.html').cars[0];
  assert.deepEqual([f150.year, f150.make, f150.model, f150.trim], [2020, 'Ford', 'F-150', 'XLT'], 'modelDate "2020-01-01" and a manufacturer node');
  const rav4 = readPage('array-product.html').cars[0];
  assert.deepEqual([rav4.make, rav4.model, rav4.trim], ['Toyota', 'RAV4', 'XLE'], 'a brand string and a ProductModel');
  assert.equal(flat({ vehicleModelDate: undefined }).year, 2019, 'the year in the name');
  assert.equal(flat({ vehicleModelDate: undefined, name: 'Chevrolet Silverado LT stock 2019A' }).year, null, 'a number glued to letters is no year');
  assert.equal(flat({ model: 'EX', vehicleConfiguration: 'EX' }).model, 'EX');
  assert.equal(flat({ model: 'EX', vehicleConfiguration: 'EX' }).trim, '');
  assert.equal(flat({ model: 'Civic', vehicleConfiguration: 'EX' }).name, '2019 Honda Civic EX');
  assert.equal(flat({ sku: undefined }).stock, '');
});

test('condition: itemCondition becomes the inventory type in plain words; the title and the address are the other two signs', () => {
  assert.equal(flat().inventoryType, 'Used');
  assert.equal(flat({ itemCondition: 'NewCondition' }).inventoryType, 'New');
  assert.equal(flat({ itemCondition: 'schema:DamagedCondition' }).inventoryType, 'Damaged');
  assert.equal(flat({ itemCondition: 'http://schema.org/RefurbishedCondition' }).inventoryType, 'Refurbished');
  assert.equal(flat({ itemCondition: 'Certified Pre-Owned' }).inventoryType, 'Certified Pre-Owned', 'the website\'s own short words');
  assert.equal(flat({ itemCondition: 'Used 2012 Volkswagen New Beetle with low miles' }).inventoryType, null, 'a title is not condition text');
  assert.equal(flat({ itemCondition: undefined }).inventoryType, null);
  assert.equal(readPage('multitype.html').cars[0].inventoryType, 'Used', 'the offer\'s itemCondition when the car has none');
  // the title: the node's name, else the page title when only it says, and only when it is about this car
  const noWord = { name: '2019 Honda Civic EX' };
  assert.equal(flat(noWord, shown(undefined, { title: 'Used 2019 Honda Civic EX Sedan' })).siteTitle, 'Used 2019 Honda Civic EX Sedan');
  assert.equal(flat(noWord, shown(undefined, { title: 'Used 2021 Toyota RAV4 XLE' })).siteTitle, '2019 Honda Civic EX', 'another car\'s title lends nothing');
  assert.equal(flat(noWord, shown(undefined, { title: 'Used Vehicles for Sale | Sample Motors' })).siteTitle, '2019 Honda Civic EX', 'a list page\'s title lends nothing');
  assert.equal(flat({ name: undefined }, shown(undefined, { title: '2019 Honda Civic EX | Sample Motors' })).siteTitle, '2019 Honda Civic EX | Sample Motors', 'no name: the page title, when it is about this car');
  assert.equal(flat({ name: undefined }, shown(undefined, { title: 'Sample Motors' })).siteTitle, null);
  assert.deepEqual(milesFromOdometer(car({ mileageFromOdometer: { value: 'lots', unitCode: 'SMI' } }), shown()), { value: null, reason: 'the mileage is not a number' });
  const list = readPage('list-page.html', SITE + '/used-vehicles/');
  assert.deepEqual(list.cars.map((v) => v.urlConditionWord), ['used', 'used', 'used', 'used'], 'each car\'s own address, not the list page\'s');
  // the address: the node's own url, else the page's
  assert.equal(flat({}, shown(), SITE + '/inventory/new-2027-kia-telluride/').urlConditionWord, 'new');
  assert.equal(flat({ url: '/cars/used-2019-honda-civic/' }, shown(), SITE + '/inventory/new-2027-kia-telluride/').url, SITE + '/cars/used-2019-honda-civic/');
  // a number of previous owners is not a Carfax report
  assert.equal(readPage('graph-vdp.html', civicUrl).cars[0].carfaxOneOwner, false);
  assert.equal(flat({ numberOfPreviousOwners: 1 }).carfaxOneOwner, false);
});

test('Carfax: only a carfax.com link on the page that names this car\'s VIN', () => {
  const { cars } = readPage('carousel.html', SITE + '/inventory/used-2021-kia-sorento-lx-5xysampl6mg000114/');
  assert.equal(cars[0].carfaxUrl, 'https://www.carfax.com/VehicleHistory/p/Report.cfx?vin=5XYSAMPL6MG000114');
  assert.equal(cars[1].carfaxUrl, 'https://www.carfax.com/VehicleHistory/p/Report.cfx?vin=1HGSAMPLXKA000115', 'the carousel car gets its own report, not the main car\'s');
  assert.equal(cars[2].carfaxUrl, null);
  assert.equal(flat({}, shown(undefined, { carfaxLinks: ['https://www.carfax.com/value/'] })).carfaxUrl, null, 'a Carfax page about nothing in particular');
  assert.equal(flat({}, shown(undefined, { carfaxLinks: ['https://www.carfax.com/r?vin=2hgsampl8kh000101'] })).carfaxUrl, 'https://www.carfax.com/r?vin=2hgsampl8kh000101');
});

test('price: one offer in US dollars that the page also shows; never an average, never a price the page does not show', () => {
  assert.equal(readPage('price-string.html').cars[0].price, 27163, 'the string "$27,163"');
  assert.equal(readPage('multitype.html').cars[0].price, 32995, 'two offers that agree are one price');
  const range = readPage('aggregate-offer.html').cars[0];
  assert.equal(range.price, null);
  assert.equal(range.priceLabel, 'the page gives a price range, not one price');
  assert.deepEqual(readingNotes(readPage('aggregate-offer.html').nodes[0], { facts: readPage('aggregate-offer.html').facts }), [{ field: 'price', reason: 'the page gives a price range, not one price' }]);
  const stale = readPage('stale-price.html').cars[0];
  assert.equal(stale.price, null, 'the markup says $24,995; the page shows $23,995');
  assert.equal(stale.priceLabel, 'the page does not show this price');
  const a = assessVehicle(stale, {});
  assert.deepEqual(a.blockers.map((b) => b.code), ['no-price']);
  assert.equal(a.blockers[0].text, 'No price on the website (the page does not show this price)');

  const offers = (list) => ({ offers: list });
  const two = offers([{ '@type': 'Offer', price: 19995, priceCurrency: 'USD' }, { '@type': 'Offer', price: 18995, priceCurrency: 'USD' }]);
  assert.deepEqual(priceFromOffers(car(two), shown('$19,995 $18,995')), { value: null, label: 'the page gives more than one price', reason: 'the page gives more than one price' });
  assert.equal(flat(offers({ '@type': 'Offer', price: 19995, priceCurrency: 'EUR' })).price, null);
  assert.equal(flat(offers({ '@type': 'Offer', priceSpecification: { '@type': 'UnitPriceSpecification', price: 19995, priceCurrency: 'USD' } })).price, 19995, 'a price specification');
  assert.equal(flat(offers({ '@type': 'Offer', price: 0, priceCurrency: 'USD' })).priceLabel, 'Call for price');
  assert.equal(flat(offers(undefined)).priceLabel, 'Call for price');
  assert.equal(flat(offers({ '@type': 'Offer', price: 'Call for price', priceCurrency: 'USD' })).priceLabel, 'Call for price');
  assert.equal(flat(offers({ '@type': 'Offer', price: '19,995 USD', priceCurrency: 'USD' })).priceLabel, 'the price is not a number');
  assert.equal(flat({}, null).price, null, 'no page text, nothing to check the price against');
  assert.equal(flat({}, shown('Stock 19995 \u00b7 19,995 miles')).price, null, 'the same digits without a dollar sign are not a price');
  assert.equal(flat({}, shown('Our price $19,995.00')).price, 19995);
  assert.equal(flat({}, shown('Our price $119,995')).price, null, 'part of a bigger number is not the price');
});

test('price: a price the page shows only crossed out, after "Was", "MSRP" or the like, or in a payment estimate is not the car\'s price', () => {
  // the stale markup price of stale-price.html, in the layouts a price drop leaves behind
  for (const file of ['stale-price-struck.html', 'stale-price-was.html', 'stale-price-msrp.html', 'stale-price-payment.html']) {
    const page = readPage(file);
    assert.equal(page.cars[0].price, null, `${file}: the markup says $24,995; the page's current price is $23,995`);
    assert.equal(page.cars[0].priceLabel, 'the page does not show this price', file);
    assert.deepEqual(assessVehicle(page.cars[0], {}).blockers.map((b) => b.code), ['no-price'], file);
  }
  assert.ok(!readPage('stale-price-struck.html').facts.text.includes('24,995'), 'crossed-out text is not in the text a price is checked against');
  assert.match(readPage('stale-price-struck.html').facts.text, /\$23,995/);

  const at = (price, text) => priceFromOffers(car({ offers: { '@type': 'Offer', price, priceCurrency: 'USD' } }), shown(text)).value;
  for (const text of [
    'Was $24,995 Now $23,995',
    'Was: $24,995 \u00b7 Sale price $23,995',
    'MSRP $24,995 Sale Price $23,995',
    'M.S.R.P.: $24,995 Our price $23,995',
    'Retail Price: $24,995 Internet Price $23,995',
    'List price $24,995 Sale $23,995',
    'Compare at $24,995 Ours $23,995',
    'Reg. $24,995 Now $23,995',
    'Originally $24,995 Now $23,995',
    'Previous price - $24,995 Now $23,995',
    'Now $23,995. Estimated payment $389/mo based on $24,995.',
    'Now $23,995. $389/mo based on a price of $24,995.',
  ]) assert.equal(at(24995, text), null, text);
  // the page's current price is kept whatever labels sit around it
  for (const text of ['Was $24,995 Now $23,995', 'MSRP $24,995 Sale Price $23,995', 'Sale Price $23,995 MSRP $24,995', 'Price was reduced! Now $23,995', 'Value Price $23,995']) assert.equal(at(23995, text), 23995, text);
  assert.equal(at(24995, 'Price $24,995 \u00b7 Estimated payment $389/mo based on $24,995'), 24995, 'shown once as the price and once in the estimate');
  // crossed out by the page's markup: <s>, <strike>, <del> or a line-through style
  for (const struck of ['<s>$24,995</s>', '<strike>$24,995</strike>', '<del>$24,995</del>', '<span style="color: gray; text-decoration: line-through">$24,995</span>', '<span style="text-decoration-line:line-through">$24,995</span>']) {
    const facts = pageFacts(`<p>${struck} <b>$23,995</b></p>`, civicUrl);
    assert.equal(facts.text, '$23,995', struck);
    assert.equal(at(24995, facts.text), null, struck);
  }
  assert.equal(pageFacts('<p><span style="text-decoration: underline">$24,995</span></p>', civicUrl).text, '$24,995', 'only a line through the text crosses it out');
});

test('price: a guide or estimate value, a class that strikes the old price through, or a page style rule that does, is not the car\'s price', () => {
  const at = (price, text) => priceFromOffers(car({ offers: { '@type': 'Offer', price, priceCurrency: 'USD' } }), shown(text)).value;
  // a value from a price guide, an estimate or the window sticker at the stale markup amount
  for (const label of ['KBB Fair Market Value', 'Market value', 'Sticker price', 'Book value:', 'Estimated value', 'Window sticker', 'Kelley Blue Book® Value:', 'Trade-in value', 'Edmunds True Market Value',
    // a guide's own labels, and an offer to buy the car
    'Kelley Blue Book® Fair Purchase Price', 'KBB Fair Purchase Price', 'Kelley Blue Book Typical Listing Price', 'Instant Cash Offer', 'NADA value', 'J.D. Power value', 'JD Power', 'Black Book', 'Average market price', 'Fair Market Price']) {
    assert.equal(at(26000, `${label} $26,000 Our price $24,995`), null, label);
    assert.equal(at(24995, `${label} $26,000 Our price $24,995`), 24995, `${label}: the current price is still read`);
  }
  assert.equal(at(26000, 'Value Price $26,000'), 26000, 'a bare "value" is no cue');
  for (const label of ['Our price', 'Internet price', 'Sale price', 'Listing price', 'Cash price', 'Power package. Price']) assert.equal(at(26000, `${label} $26,000`), 26000, `${label} is the car's price`);
  // crossed out by a class named for it, word by word, never by a piece of a word
  for (const cls of ['strike', 'price strikethrough', 'old-price', 'price-was', 'was_price', 'originalPrice', 'price--previous', 'line-through', 'is-crossed']) {
    const facts = pageFacts(`<p><span class="${cls}">$24,995</span> <b>$23,995</b></p>`, civicUrl);
    assert.equal(facts.text, '$23,995', cls);
    assert.equal(at(24995, facts.text), null, cls);
  }
  for (const cls of ['font-bold', 'holder', 'golden', 'price', 'price-box theme-old', 'wash', 'old-school', 'original-content']) {
    assert.equal(pageFacts(`<p><span class="${cls}">$24,995</span></p>`, civicUrl).text, '$24,995', `${cls} is not crossed out`);
  }
  // crossed out by the page's own style rule for a class
  const styled = pageFacts('<html><head><style>.tag{color:red} .card .gone, .x > span.price-tag { text-decoration: gray line-through; } .keep{text-decoration:underline}</style></head><body><p><span class="gone">$24,995</span> <span class="price-tag">$24,500</span> <span class="keep">$23,995</span></p></body></html>', civicUrl);
  assert.equal(styled.text, '$23,995');
  assert.equal(pageFacts('<html><head><style>' + '{'.repeat(20000) + '.a{text-decoration:line-through}</style></head><body><span class="a">$1</span></body></html>', civicUrl).text, '', 'a long run of braces is read in one pass');
});

test('price: when the page\'s only price carries a guide\'s or an old price\'s label, it is still not taken, and the reason quotes the label for a person to check', () => {
  const at = (text, price = 24995) => priceFromOffers(car({ offers: { '@type': 'Offer', price, priceCurrency: 'USD' } }), shown(text));
  const quoted = (label) => ({ value: null, label: `the page labels its only price "${label}", which Lot Current does not read as the selling price`, reason: `the page labels its only price "${label}", which Lot Current does not read as the selling price` });
  for (const [text, label] of [
    ['2019 Honda Civic EX Market Price $24,995 Call us', 'Market Price'],
    ['2019 Honda Civic EX Our Market Price: $24,995', 'Market Price'],
    ['Fair Market Price $24,995', 'Fair Market Price'],
    ['Dealer Cash Offer price $24,995', 'Cash Offer price'],
    ['Market Value $24,995 \u00b7 Market Value $24,995', 'Market Value'],
  ]) assert.deepEqual(at(text), quoted(label), text);
  // the same label next to a current price is a stale or guide value, as before
  const notShown = { value: null, label: 'the page does not show this price', reason: 'the page does not show this price' };
  assert.deepEqual(at('Market Price $24,995 Our price $23,995'), notShown);
  assert.deepEqual(at('Was $24,995 Now $23,995'), notShown);
  assert.deepEqual(at('Our price $23,995'), notShown);
  assert.equal(at('Market Price $26,000 Our price $24,995').value, 24995, 'the current price is still read');
  // the car is not ready, and the To do reason says why
  const v = flat({ offers: { '@type': 'Offer', price: 24995, priceCurrency: 'USD', availability: 'https://schema.org/InStock' } }, shown('Market Price $24,995 \u00b7 41,230 miles'));
  assert.equal(v.price, null);
  assert.deepEqual(assessVehicle(v, {}).blockers.map((b) => b.text), ['No price on the website (the page labels its only price "Market Price", which Lot Current does not read as the selling price)']);
});

test('price: the page text comes in segments, each tied to the car whose card holds it', () => {
  const page = `<html><body><h1>Used 2019 Honda Civic EX</h1><div class="price-box"><p>Our price $20,995</p><a href="/finance/">Payments</a></div>
  <aside><a href="/inventory/used-2018-honda-accord-1hgsampl0jh000102/">2018 Accord $21,995</a><div class="tile"><a href="/inventory/used-2017-ford-escape-1fmsampl0hu000103/"><img alt="">2017 Escape</a> <span>$19,000</span></div></aside>
  <a href="${civicUrl}">This car</a> <a href="https://www.carfax.com/x">Carfax</a></body></html>`;
  // without a carKey, every address on this website is a car of its own
  const f = pageFacts(page, civicUrl);
  assert.equal(f.text, 'Used 2019 Honda Civic EX Our price $20,995 Payments 2018 Accord $21,995 2017 Escape $19,000 This car Carfax');
  assert.deepEqual(f.segments, [
    { car: null, text: 'Used 2019 Honda Civic EX' },
    { car: SITE + '/finance/', text: 'Our price $20,995 Payments' },
    { car: SITE + '/inventory/used-2018-honda-accord-1hgsampl0jh000102/', text: '2018 Accord $21,995' },
    { car: SITE + '/inventory/used-2017-ford-escape-1fmsampl0hu000103/', text: '2017 Escape $19,000' },
    { car: null, text: 'This car Carfax' },
  ], 'a link to this page or another website is no card');
  // with one, a link to no car shapes no card
  const byVin = () => (href) => (href.match(/\b[a-z0-9]{17}\b/i) || [null])[0];
  assert.deepEqual(pageFacts(page, civicUrl, { carKey: byVin }).segments, [
    { car: null, text: 'Used 2019 Honda Civic EX Our price $20,995 Payments' },
    { car: '1hgsampl0jh000102', text: '2018 Accord $21,995' },
    { car: '1fmsampl0hu000103', text: '2017 Escape $19,000' },
    { car: null, text: 'This car Carfax' },
  ]);
});

test('price: a card holds all of its car\'s links, so a contact, finance or "Check availability" link does not split it, and the car\'s own title and price are never another car\'s card', () => {
  const byVin = () => (href) => {
    const vins = href.match(/\b[a-z0-9]{17}\b/gi) || [];
    return vins.length === 1 ? vins[0].toUpperCase() : null; // several VINs: a comparison, no one car
  };
  const A = '1HGSAMPL0JH000102';
  const B = '1FMSAMPL0HU000103';
  const C = '5XYSAMPL6MG000114';
  const card = (vin, price, extra) => `<div class="card"><a href="/inventory/used-${vin.toLowerCase()}/"><img alt=""></a><h3><a href="/inventory/used-${vin.toLowerCase()}/">Used car ${vin.slice(-3)}</a></h3><span class="price">${price}</span> ${extra}</div>`;
  const extras = [
    '<a href="/contact-us/">Check availability</a>',
    '<a href="/finance/apply/">Get pre-approved</a> <a href="/value-your-trade/">Value your trade</a>',
    `<a href="/contact-us/?vin=VIN">Check availability</a>`,
  ];
  // a list: each card with its price, whatever else it links to
  for (const extra of extras) {
    const list = `<html><body><h1>Used vehicles</h1><nav><a href="/">Home</a> <a href="/used-vehicles/?page=2">Next page</a></nav><main>${[[A, '$15,000'], [B, '$15,500'], [C, '$16,000']].map(([vin, price]) => card(vin, price, extra.replace('VIN', vin))).join('')}</main></body></html>`;
    const segments = pageFacts(list, SITE + '/used-vehicles/', { carKey: byVin }).segments;
    for (const [vin, price] of [[A, '$15,000'], [B, '$15,500'], [C, '$16,000']]) {
      const own = segments.filter((g) => g.car === vin).map((g) => g.text).join(' ');
      assert.match(own, new RegExp(`Used car ${vin.slice(-3)} \\${price}`), `${extra}: the card of ${vin} holds its price`);
    }
  }
  // a car's page with one other car's tile, the tile's price outside its link, beside a contact link:
  // the page's own price shows outside the tile's block, so the whole block, heading and all, is the tile's
  for (const extra of extras) {
    const one = `<html><body><header><a href="/">Home</a></header><main><h1>Used 2021 Kia Sorento LX</h1><p>Our price $14,000</p><section><h2>You may also like</h2>${card(A, '$15,000', extra.replace('VIN', A))}</section></main><footer><a href="/about/">About</a></footer></body></html>`;
    const segments = pageFacts(one, SITE + '/inventory/used-' + C.toLowerCase() + '/', { carKey: byVin }).segments;
    assert.deepEqual(segments.filter((g) => g.car === null).map((g) => g.text).join(' '), 'Home Used 2021 Kia Sorento LX Our price $14,000 About', extra);
    assert.match(segments.filter((g) => g.car === A).map((g) => g.text).join(' '), /^You may also like Used car 102 \$15,000/, extra);
  }
  // the car's own title, price and form link next to that tile, with no heading: still not the tile's
  const plain = `<html><body><div><p>Our price $14,000</p><a href="/contact-us/?vin=${C}">Ask about this car</a></div>${card(A, '$15,000', '')}</body></html>`;
  const own = pageFacts(plain, SITE + '/inventory/used-' + C.toLowerCase() + '/', { carKey: byVin }).segments;
  assert.deepEqual(own.map((g) => [g.car, g.text]), [[C, 'Our price $14,000 Ask about this car'], [A, 'Used car 102 $15,000']]);
  // a link naming two cars (a comparison) goes with neither
  const compare = `<html><body><h1>t</h1><div>${card(A, '$15,000', `<a href="/compare/?vins=${A},${B}">Compare</a>`)}${card(B, '$15,500', '')}</div></body></html>`;
  assert.match(pageFacts(compare, SITE + '/inventory/used-' + C.toLowerCase() + '/', { carKey: byVin }).segments.filter((g) => g.car === A).map((g) => g.text).join(' '), /\$15,000 Compare/);
});

test('price: beside one other car\'s tile in one block (the car\'s title in a bar of its own), the whole block is the tile\'s card, the car\'s own price box with it, however the tile is built', () => {
  const byVin = () => (href) => {
    const vins = href.match(/\b[a-z0-9]{17}\b/gi) || [];
    return vins.length === 1 ? vins[0].toUpperCase() : null;
  };
  const A = '1HGSAMPL0JH000102';
  const here = SITE + '/inventory/used-5xysampl6mg000114/';
  const link = `/inventory/used-${A.toLowerCase()}/`;
  // the car's title in a bar of its own; its price box and one similar tile side by side below it
  const page = (main) => `<html><body><header><a href="/">Home</a></header><div class="bar"><h1>Used 2021 Kia Sorento LX</h1></div><div class="main">${main}</div><footer>Call us</footer></body></html>`;
  const box = (price) => `<div class="price-box"><p>Our price ${price}</p><p>20,000 miles</p><a href="/contact-us/">Check availability</a> <a href="/finance/">Get financing</a></div>`;
  const read = (main) => pageFacts(page(main), here, { carKey: byVin }).segments;
  const own = (main) => read(main).filter((g) => g.car === null).map((g) => g.text).join(' ');
  const tile = (main) => read(main).filter((g) => g.car === A).map((g) => g.text).join(' ');
  const similar = (amount) => `<div class="similar"><h3>Similar</h3><a href="${link}">2018 Honda Accord ${amount}</a></div>`;
  const split = `<div class="tile"><div class="photo"><a href="${link}"><img alt=""></a><span>Low miles</span></div><div class="info"><span>$15,000</span></div></div>`;
  const wrapped = (beside) => `<div class="tile"><div class="head"><a href="${link}">2018 Honda Accord</a> ${beside}</div><div class="info"><span>$15,000</span></div></div>`;
  const loose = (beside) => `<div class="head"><a href="${link}">2018 Honda Accord</a> ${beside}</div><div class="info"><span>$15,000</span></div>`;
  // Lot Current cannot tell the car's price box from a piece of the tile, so neither amount is the page's own:
  // the car may get no price, never the tile's
  for (const [name, main] of [
    ['a tile with its amount in its link', box('$15,000') + similar('$15,500')],
    ['a tile showing no amount', box('$14,000') + similar('')],
    ['a tile whose amount sits outside the element around its link', box('$14,000') + split],
    ['a saving beside the tile\'s link', box('$14,000') + wrapped('<span>Save $500</span>')],
    ['a payment beside the tile\'s link', box('$14,000') + wrapped('<span>Est. $299/mo</span>')],
    ['the tile\'s pieces loose beside the price box', box('$14,000') + loose('<span>$16,000</span>')],
    ['a price box that shows no amount', box('Call for price') + loose('<span>Save $500</span>')],
  ]) {
    assert.equal(own(main), 'Home Used 2021 Kia Sorento LX Call us', name);
    assert.match(tile(main), /^Our price /, name);
  }
  // two other cars' tiles: each tile is its own card, and the price box the page's own
  const B = '1FMSAMPL0HU000103';
  const two = `<div class="similar"><a href="${link}">2018 Honda Accord $15,500</a><a href="/inventory/used-${B.toLowerCase()}/">2017 Ford Escape $16,000</a></div>`;
  assert.equal(own(box('$15,000') + two), 'Home Used 2021 Kia Sorento LX Our price $15,000 20,000 miles Check availability Get financing Call us');
});

test('price: one other car\'s tile\'s own price never passes for the page\'s, whatever sits beside its link, wherever it sits, however its "$" is written and whatever the page\'s price box says or shows', () => {
  const byVin = () => (href) => {
    const vins = href.match(/\b[a-z0-9]{17}\b/gi) || [];
    return vins.length === 1 ? vins[0].toUpperCase() : null;
  };
  const A = '1HGSAMPL0JH000102';
  const here = SITE + '/inventory/used-5xysampl6mg000114/';
  const L = `<a href="/inventory/used-${A.toLowerCase()}/">2018 Honda Accord</a>`;
  const read = (body) => pageFacts(`<html><body><header><a href="/">Home</a></header>${body}<footer>Call us</footer></body></html>`, here, { carKey: byVin }).segments;
  const own = (body) => read(body).filter((g) => g.car === null).map((g) => g.text).join(' ');
  const tile = (body) => read(body).filter((g) => g.car === A).map((g) => g.text).join(' ');
  const box = (price) => `<div class="price-box"><p>Our price ${price}</p><p>20,000 miles</p><a href="/contact-us/">Check availability</a></div>`;
  const h1 = '<h1>Used 2021 Kia Sorento LX</h1>';
  const bar = `<div class="bar">${h1}</div>`;
  const wrapped = (beside, info = '$15,000') => `<div class="tile"><div class="head">${L} <span>${beside}</span></div><div class="info"><span>${info}</span></div></div>`;
  // the page's title and price box together, the tile in an aside or straight in the page: whatever sits beside
  // the tile's link, the tile's $15,000 stays the tile's
  for (const [beside, info] of [['Save $500'], ['Price drop $500'], ['$500 dealer discount'], ['Reduced $1,000'], ['$1,000 bonus cash'], ['Est. $299/mo'], ['Low miles'], ['$16,000', 'Sale price $15,000']]) {
    for (const [where, body] of [
      ['in an aside', `${h1}${box('$14,000')}<aside>${wrapped(beside, info)}</aside>`],
      ['in an aside under a heading', `${h1}${box('$14,000')}<aside><h3>You may also like</h3>${wrapped(beside, info)}</aside>`],
      ['straight in the page', `${h1}${box('$14,000')}${wrapped(beside, info)}`],
      ['its price first, beside a page that shows no amount', `${h1}${box('Call for price')}<aside><div class="tile"><div class="info"><span>${info || '$15,000'}</span></div><div class="head">${L} <span>${beside}</span></div></div></aside>`],
    ]) {
      assert.doesNotMatch(own(body), /15,000/, `${beside}, ${where}`);
      assert.match(tile(body), /\$15,000/, `${beside}, ${where}`);
    }
  }
  // the page's title in a bar of its own: a tile's price after the block that holds the price box and the
  // tile's link is not the page's, nor is one whose "$" sits in an element of its own, nor one written as an entity
  for (const beside of ['$16,000', 'Save $500']) {
    assert.doesNotMatch(own(`${bar}<div class="outer"><div class="main">${box('$14,000')}<div class="head">${L} <span>${beside}</span></div></div><div class="info"><span>$15,000</span></div></div>`), /15,000/, `nested: ${beside}`);
  }
  assert.doesNotMatch(own(`${bar}<div class="main">${box('<sup>$</sup>14,000')}<div class="head">${L} <span>$16,000</span></div><div class="info"><sup>$</sup>15,000</div></div>`), /15,000/, 'a "$" of its own');
  assert.doesNotMatch(own(`${bar}<div class="main">${box('&#36;14,000')}<div class="head">${L} <span>$16,000</span></div><div class="info">&#36;15,000</div></div>`), /15,000/, 'an entity');
  // the tile before the price box, the page's own text showing an amount elsewhere, or other text between the
  // page's title and the block: the whole block stays the tile's
  for (const [name, body] of [
    ['the tile first', `${bar}<div class="main">${wrapped('Low miles')}${box('$14,000')}</div>`],
    ['an amount in the page\'s own text after the block', `${bar}<div class="main">${box('$14,000')}${wrapped('Low miles')}</div><p>Doc fee $499</p>`],
    ['text between the title and the block', `${bar}<div class="gallery">1 of 24</div><div class="main">${box('$14,000')}${wrapped('Low miles')}</div>`],
  ]) {
    assert.doesNotMatch(own(body), /14,000|15,000/, name);
    assert.match(tile(body), /Our price \$14,000.*\$15,000|\$15,000.*Our price \$14,000/, name);
  }
  // the tile right after the page's title, its price before its link, the page's own price box after it
  const priceFirst = `<div class="tile"><div class="info"><span>$15,000</span></div><div class="head">${L} <span>$16,000</span></div></div>`;
  assert.doesNotMatch(own(`${h1}<aside>${priceFirst}</aside>${box('$14,000')}`), /15,000/, 'the page\'s own price after the tile');
  assert.match(own(`${h1}<aside>${priceFirst}</aside>${box('$14,000')}`), /Our price \$14,000/);
  // the tile's price before its link, another amount beside the link, the page showing no amount of its own,
  // whatever its price box says instead: after more text in the heading's block, beside the tile's pieces, after
  // the whole tile
  assert.doesNotMatch(own(`<div class="top">${h1}<p>20,000 miles</p><p>Automatic, one owner</p></div>${priceFirst}`), /15,000/, 'more text after the heading in its block');
  assert.doesNotMatch(own(`<div class="top">${h1}<p>Stock SM1000</p></div><div class="main">${box('$14,000')}${wrapped('Low miles')}</div>`), /14,000|15,000/, 'a block after more text in the heading\'s block stays the tile\'s');
  for (const says of ['Call for price', 'Contact us for today\'s pricing', 'Price on request', 'Ask for our best price', 'Get today\'s price', 'Contact dealer for price', 'Call for internet price', 'Price: Call', 'Request a quote', '']) {
    assert.doesNotMatch(own(`${bar}<div class="main">${box(says)}<div class="info"><span>$15,000</span></div><div class="head">${L} <span>$16,000</span></div></div>`), /15,000/, says);
    assert.doesNotMatch(own(`${h1}<aside>${priceFirst}</aside>${box(says)}`), /15,000/, `${says}, after the tile`);
    assert.doesNotMatch(own(`${bar}${priceFirst}${box(says)}`), /15,000/, `${says}, after the whole tile`);
  }
  assert.doesNotMatch(own(`${bar}<div class="main"><div class="group">${box('$14,000')}<div class="info"><span>$15,000</span></div></div><div class="head">${L} <span>$16,000</span></div></div>`), /15,000/, 'the price box grouped with the tile\'s price');
  assert.doesNotMatch(own(`${bar}<div class="main"><div class="price-box"><p>Our price $14,000</p><p>Similar cars from $15,000</p></div><div class="head">${L} <span>$16,000</span></div></div>`), /15,000/, 'a second price in the price box');
  // the page's title in a bar, its price box and one whole tile in one block: the whole block is the tile's, so
  // the car's own price is not read there either (no price, never the tile's)
  for (const main of [`${box('$14,000')}${wrapped('Low miles')}`, `<div class="price-box"><p>Was $16,500</p><p>Our price $14,000</p><p>Est. $250/mo</p><p>Doc fee $499</p></div>${wrapped('Low miles')}`]) {
    assert.doesNotMatch(own(`${bar}<div class="main">${main}</div>`), /14,000|15,000/, main);
    assert.match(tile(`${bar}<div class="main">${main}</div>`), /Our price \$14,000.*2018 Honda Accord Low miles \$15,000/, main);
  }
});

test('price: priceSpecification without an offer price; a strikethrough, list or MSRP entry is never the price', () => {
  const tacoma = readPage('price-specification.html').cars[0];
  assert.equal(tacoma.price, 29995, 'the StrikethroughPrice comes first in the markup and on the page, and is not the price');
  assert.equal(tacoma.priceLabel, 'Price');
  const spec = (list, text = 'MSRP $32,995 Sale Price $29,995') => priceFromOffers(car({ offers: { '@type': 'Offer', priceSpecification: list } }), shown(text));
  const usd = (price, priceType) => ({ '@type': 'UnitPriceSpecification', price, priceCurrency: 'USD', ...(priceType ? { priceType } : {}) });
  const plain = '$32,995 $29,995';
  for (const type of ['https://schema.org/StrikethroughPrice', 'http://schema.org/ListPrice', 'schema:MSRP', 'SRP', 'InvoicePrice', 'MinimumAdvertisedPrice', { '@id': 'https://schema.org/ListPrice' }]) {
    assert.deepEqual(spec([usd(32995, type), usd(29995)], plain), { value: 29995, label: 'Price', reason: '' }, JSON.stringify(type));
    assert.deepEqual(spec([usd(29995), usd(32995, type)], plain), { value: 29995, label: 'Price', reason: '' }, JSON.stringify(type) + ' second');
  }
  assert.equal(spec([usd(32995, 'ListPrice'), usd(29995, 'https://schema.org/SalePrice')], plain).value, 29995, 'a SalePrice is the price');
  assert.deepEqual(spec([usd(32995), usd(29995)], plain), { value: null, label: 'the page gives more than one price', reason: 'the page gives more than one price' });
  assert.deepEqual(spec([usd(29995), usd(29995)], plain).value, 29995, 'two that agree are one price');
  assert.deepEqual(spec([usd(32995, 'StrikethroughPrice')], plain), { value: null, label: 'Call for price', reason: 'the page gives no price' }, 'only a crossed-out price: no price');
  assert.equal(spec([{ ...usd(389), billingDuration: 1, unitCode: 'MON' }, usd(29995)], '$389/mo $29,995').value, 29995, 'a monthly payment is not the price');
  assert.equal(spec([{ ...usd(12), referenceQuantity: { value: 1, unitCode: 'MTR' } }], '$12').value, null, 'nor a price per unit');
  // the currency may sit on the offer
  assert.equal(priceFromOffers(car({ offers: { '@type': 'Offer', priceCurrency: 'USD', priceSpecification: [{ price: 29995, priceType: 'ListPrice' }, { price: 27995 }] } }), shown('$29,995 $27,995')).value, 27995);
});

test('price: no currency counts as US dollars only when the page shows that amount with a dollar sign as its current price', () => {
  assert.equal(readPage('no-currency.html').cars[0].price, 17163, 'no-currency.html: "$17,163.00" on the page');
  const bare = (text, price = 27163) => priceFromOffers(car({ offers: { '@type': 'Offer', price } }), shown(text));
  for (const text of ['Price $27,163', 'Price $27163', 'Price $27,163.00', 'Price $ 27,163', 'Price US$27,163', 'Price USD $27,163']) {
    assert.deepEqual(bare(text), { value: 27163, label: 'Price', reason: '' }, text);
  }
  assert.equal(bare('Price $27,163', '27163.00').value, 27163, 'the price written as text');
  const notDollars = { value: null, label: 'the page does not say the price is in US dollars', reason: 'the page does not say the price is in US dollars' };
  assert.deepEqual(bare('Price USD 27,163'), notDollars, 'US dollars in words, but no dollar sign');
  const notShown = { value: null, label: 'the page does not show this price', reason: 'the page does not show this price' };
  for (const text of ['Price 27,163', 'Price CA$27,163', 'Price C$27,163', 'Price $27,163.50', 'Price $127,163', 'Stock 27163', '']) assert.deepEqual(bare(text), notShown, text);
  for (const text of ['Was $27,163 Now $25,999', 'MSRP $27,163 Sale Price $25,999']) assert.deepEqual(bare(text), notShown, text);
  assert.equal(bare('List Price: $27,163').value, null, 'the only price, labelled a list price');
  assert.match(bare('List Price: $27,163').reason, /^the page labels its only price "List Price"/);
  assert.deepEqual(bare('Was $27,163 Now $27,163'), { value: 27163, label: 'Price', reason: '' }, 'shown once as the current price');
  assert.deepEqual(priceFromOffers(car({ offers: { '@type': 'Offer', price: 27163 } }), null), notShown, 'no page text');
  // an explicit currency other than US dollars is never a price, whatever the page shows
  for (const currency of ['EUR', 'CAD', 'mxn', 'US']) {
    assert.deepEqual(priceFromOffers(car({ offers: { '@type': 'Offer', price: 27163, priceCurrency: currency } }), shown('Price $27,163')), { value: null, label: 'the price is not in US dollars', reason: 'the price is not in US dollars' }, currency);
  }
  assert.equal(priceFromOffers(car({ offers: { '@type': 'Offer', price: 27163, priceCurrency: 'USD' } }), shown('Price USD 27,163')).value, 27163, 'USD in the markup: the amount in words is enough');
  // an offer with a currency and one without are two prices, as before
  assert.equal(priceFromOffers(car({ offers: [{ '@type': 'Offer', price: 27163, priceCurrency: 'USD' }, { '@type': 'Offer', price: 27163 }] }), shown('$27,163')).label, 'the page gives more than one price');
});

test('mileage: miles when the markup says so or the page shows it; kilometres never', () => {
  const km = readPage('km.html');
  assert.equal(km.cars[0].mileage, null);
  assert.deepEqual(readingNotes(km.nodes[0], { facts: km.facts }), [{ field: 'mileage', reason: 'the mileage is in kilometres' }]);
  assert.equal(assessVehicle(km.cars[0], {}).decision, DECISION.REVIEW, 'no mileage: a person checks');
  assert.equal(readPage('array-product.html').cars[0].mileage, 28904, 'unitText "miles" and a value written "28,904"');
  const noUnit = (text, value = 41230) => milesFromOdometer(car({ mileageFromOdometer: { '@type': 'QuantitativeValue', value } }), shown(text));
  assert.deepEqual(noUnit('41,230 miles'), { value: 41230, reason: '' });
  assert.deepEqual(noUnit('Mileage: 41,230'), { value: 41230, reason: '' });
  assert.deepEqual(noUnit('41230 mi.'), { value: 41230, reason: '' });
  assert.deepEqual(noUnit('41,230 km'), { value: null, reason: 'the page gives no unit for the mileage' });
  assert.deepEqual(noUnit('Mileage: 41,230 km'), { value: null, reason: 'the page gives no unit for the mileage' });
  assert.deepEqual(noUnit('141,230 miles'), { value: null, reason: 'the page gives no unit for the mileage' });
  assert.deepEqual(noUnit(''), { value: null, reason: 'the page gives no unit for the mileage' });
  assert.equal(readPage('no-condition.html').cars[0].mileage, 72514, 'no unit, and the page shows "72,514 miles"');
  assert.deepEqual(milesFromOdometer(car({ mileageFromOdometer: { value: 41230, unitCode: 'KMT' } }), shown('41,230 miles')), { value: null, reason: 'the mileage is in kilometres' }, 'kilometres in the markup win over a page that says miles');
  assert.deepEqual(milesFromOdometer(car({ mileageFromOdometer: '41,230 miles' }), shown('')), { value: 41230, reason: '' });
  assert.deepEqual(milesFromOdometer(car({ mileageFromOdometer: { value: 41230, unitCode: 'FOT' } }), shown('')), { value: null, reason: 'the page does not say the mileage is in miles' });
  assert.deepEqual(milesFromOdometer(car({ mileageFromOdometer: undefined }), shown()), { value: null, reason: 'the page gives no mileage' });
  assert.equal(flat({ mileageFromOdometer: { value: 0, unitCode: 'SMI' } }).mileage, 0, 'zero is kept: the gate asks a person about it');
});

test('availability: in stock is on the lot, sold reads as sale-pending, on order is not on the lot yet', () => {
  const at = (member) => flat({ offers: { '@type': 'Offer', price: 19995, priceCurrency: 'USD', availability: member } });
  const pick = (v) => [v.availability, v.statusLabel, v.inTransit];
  assert.deepEqual(pick(at('https://schema.org/InStock')), ['In-Stock', '', false]);
  assert.deepEqual(pick(at('InStoreOnly')), ['In-Stock', '', false]);
  for (const sold of ['https://schema.org/SoldOut', 'OutOfStock', 'schema:Discontinued']) {
    const v = at(sold);
    assert.deepEqual(pick(v), [null, 'Sold', false]);
    assert.deepEqual(assessVehicle(v, {}).blockers.map((b) => b.code), ['sale-pending']);
  }
  assert.deepEqual(assessVehicle(at('Reserved'), {}).blockers.map((b) => b.code), ['sale-pending']);
  for (const [member, word] of [['PreOrder', 'Pre-Order'], ['https://schema.org/BackOrder', 'Back-Order'], ['PreSale', 'Pre-Sale']]) {
    const v = at(member);
    assert.deepEqual(pick(v), [word, '', true]);
    assert.deepEqual(assessVehicle(v, {}).blockers.map((b) => b.code), ['not-on-lot']);
  }
  assert.deepEqual(pick(at('OnlineOnly')), ['OnlineOnly', '', false], 'a value the map does not know stays in the website\'s words');
  assert.deepEqual(assessVehicle(at('OnlineOnly'), {}).blockers.map((b) => b.code), ['not-on-lot']);
  assert.deepEqual(pick(at(undefined)), [null, '', false]);
  assert.equal(at('https://schema.org/InStock').status, 'InStock');
});

test('details: colours, body, drive, engine, transmission, fuel, photos, features and description as stated', () => {
  const f150 = readPage('multitype.html').cars[0];
  assert.equal(f150.drivetrain, '4WD');
  assert.equal(f150.engine, '2.7L V6', 'an engine without a name: its displacement and type');
  assert.equal(f150.fuelType, 'Gasoline', 'the engine\'s fuel when the car names none');
  assert.deepEqual(f150.features, ['Backup Camera', 'Apple CarPlay', 'Tow Package', 'Bed Liner'], 'a feature list, and the extras marked as present');
  const crv = readPage('microdata.html', SITE + '/inventory/crv/').cars[0];
  assert.equal(crv.drivetrain, 'AWD');
  assert.deepEqual(crv.photos, [SITE + '/inventory/photos/crv-1.jpg', 'https://images.sample-motors.test/crv-2.jpg']);
  assert.equal(crv.price, 25995, 'the page shows "$ 25,995" across two elements');
  assert.equal(flat({ driveWheelConfiguration: 'RearWheelDriveConfiguration' }).drivetrain, 'RWD');
  assert.equal(flat({ driveWheelConfiguration: '4x4' }).drivetrain, '4x4', 'the website\'s own words');
  assert.equal(flat({ bodyType: 'https://www.wikidata.org/wiki/Q23442' }).bodyType, '', 'an address says nothing a person can read');
  assert.equal(flat({ image: [{ '@type': 'ImageObject', contentUrl: 'a.jpg', url: 'https://x.test/page' }, 'data:image/png;base64,AAAA', 'a.jpg'] }).photos.join(), SITE + '/inventory/used-2019-honda-civic-ex-2hgsampl8kh000101/a.jpg');
  assert.equal(readPage('entities.html').cars[0].descriptionRaw, 'Tow package & spray-in bed liner \u2013 "clean" inside!');
});

// ---------- the gate reads these cars with the same three signs ----------

test('the gate: the same three signs, a lone sign never admits a car, damaged and refurbished go to a person', () => {
  const rogueUrl = SITE + '/inventory/used-2016-nissan-rogue-sv-5n1sampl5gc000111/';
  const rogue = readPage('no-condition.html', rogueUrl).cars[0];
  assert.equal(rogue.inventoryType, null, 'the page gives no condition');
  const alone = assessVehicle(rogue, {});
  assert.equal(alone.decision, DECISION.REVIEW);
  assert.equal(alone.reason, "Only one sign it's pre-owned (web address), and no Carfax report.");
  const facts = { ...readPage('no-condition.html', rogueUrl).facts, title: 'Used 2016 Nissan Rogue SV | Sample Motors' };
  const titled = assessVehicle(normalizeVehicle(readPage('no-condition.html', rogueUrl).nodes[0], { url: rogueUrl, facts }), {});
  assert.deepEqual([titled.decision, titled.blockers.map((b) => b.code)], [DECISION.NOT_READY, ['no-photos']], 'the address and the page title agree: pre-owned, waiting only for photos');
  // the schema.org condition alone, with nothing else saying used and no Carfax
  const lone = flat({ name: '2019 Honda Civic EX' }, shown(), SITE + '/vehicle/2HGSAMPL8KH000101');
  assert.equal(assessVehicle(lone, {}).decision, DECISION.REVIEW);
  for (const [member, word] of [['https://schema.org/DamagedCondition', 'damaged'], ['RefurbishedCondition', 'refurbished']]) {
    const v = flat({ itemCondition: member }, shown(undefined, { carfaxLinks: ['https://www.carfax.com/r?vin=2HGSAMPL8KH000101'] }));
    assert.equal(v.urlConditionWord, 'used');
    assert.equal(v.siteTitle, 'Used 2019 Honda Civic EX');
    const a = assessVehicle(v, {});
    assert.equal(a.decision, DECISION.REVIEW, `${word}: never Ready, whatever the address, the title and Carfax say`);
    assert.equal(a.reason, `The website lists it as ${word} (inventory type). Check its condition before posting.`);
  }
  const carousel = readPage('carousel.html', SITE + '/inventory/used-2021-kia-sorento-lx-5xysampl6mg000114/').cars;
  assert.equal(assessVehicle(carousel[3], {}).decision, DECISION.SKIP, 'the new car in the carousel');
});

test('the gate: a schema.org car called a demo or loaner after its model year waits for a person', () => {
  // schema.org has no demo or loaner flag, so the car's own words carry it
  const carfax = { carfaxLinks: ['https://www.carfax.com/r?vin=2HGSAMPL8KH000101'] };
  assert.equal(assessVehicle(flat({}, shown(undefined, carfax)), {}).decision, DECISION.READY, 'the plain used car is ready');
  const demo = flat({ name: 'Used 2019 Honda Civic EX Demo' }, shown(undefined, carfax));
  assert.equal(demo.isDemo, false, 'no flag');
  const a = assessVehicle(demo, {});
  assert.equal(a.decision, DECISION.REVIEW);
  assert.match(a.reason, /its title says "Demo"/);
  const loaner = flat({}, shown(undefined, carfax), SITE + '/inventory/used-2019-honda-civic-ex-loaner-2hgsampl8kh000101/');
  assert.equal(assessVehicle(loaner, {}).decision, DECISION.REVIEW, 'loaner in the page address after the year');
  // a demo word after a " - " in the name is read too
  const dashed = flat({ name: '2019 Honda Civic EX - Demo' }, shown(undefined, carfax));
  assert.equal(assessVehicle(dashed, {}).decision, DECISION.REVIEW, 'a " - Demo" name');
  // the car's own name is kept when it says demo or loaner, even when the page title says Used
  for (const name of ['2019 Honda Civic EX Demo', '2019 Honda Civic EX - Service Loaner', 'Honda Civic EX Demonstrator']) {
    const v = flat({ name }, shown(undefined, { ...carfax, title: 'Used 2019 Honda Civic EX | Sample Motors' }));
    assert.equal(v.siteTitle, name, `${name}: the name is the title the gate reads`);
    const r = assessVehicle(v, {});
    assert.equal(r.decision, DECISION.REVIEW, name);
    assert.match(r.reason, /Demos and loaners are usually sold as new/, name);
  }
  // a plain name still takes the page title's condition word
  assert.equal(flat({ name: '2019 Honda Civic EX' }, shown(undefined, { ...carfax, title: 'Used 2019 Honda Civic EX | Sample Motors' })).siteTitle, 'Used 2019 Honda Civic EX | Sample Motors');
  // the page title's dealership part is not the car's words: a "Courtesy" store stays ready
  const store = flat({ name: '' }, shown(undefined, { ...carfax, title: 'Used 2019 Honda Civic EX | Courtesy Honda of Springfield' }));
  assert.equal(store.siteTitle, 'Used 2019 Honda Civic EX | Courtesy Honda of Springfield');
  assert.equal(assessVehicle(store, {}).decision, DECISION.READY);
});

test('the gate: a demo or loaner word only the page title has is read, with the name\'s condition word kept', () => {
  const carfax = { carfaxLinks: ['https://www.carfax.com/r?vin=2HGSAMPL8KH000101'] };
  // the name is plain; the page title about this car says Demo
  const plain = flat({ name: '2019 Honda Civic EX' }, shown(undefined, { ...carfax, title: '2019 Honda Civic EX Demo | Sample Motors' }));
  assert.equal(plain.siteTitle, '2019 Honda Civic EX Demo | Sample Motors');
  const a = assessVehicle(plain, {});
  assert.equal(a.decision, DECISION.REVIEW);
  assert.match(a.reason, /its title says "Demo"/);
  // the name says Used and the page title says Courtesy Vehicle: both are read
  const used = flat({ name: 'Used 2019 Honda Civic EX' }, shown(undefined, { ...carfax, title: '2019 Honda Civic EX - Courtesy Vehicle | Sample Motors' }));
  assert.equal(used.siteTitle, 'Used 2019 Honda Civic EX - Courtesy Vehicle | Sample Motors');
  const b = assessVehicle(used, {});
  assert.equal(b.decision, DECISION.REVIEW);
  assert.match(b.reason, /^Listed as pre-owned but its title says "Courtesy Vehicle"/);
  // the page title's word is read as the car's own word, wherever it stands after the model year
  for (const [title, word] of [
    ['2019 Honda Civic EX Courtesy Vehicle for Sale | Sample Motors', 'Courtesy Vehicle'],
    ['2019 Honda Civic EX Courtesy Car Special | Sample Motors', 'Courtesy Car'],
    ['Sample Motors | 2019 Honda Civic EX Courtesy Loaner Sale', 'Courtesy Loaner'],
    ['2019 Honda Civic EX Demo Special | Sample Motors', 'Demo'],
  ]) {
    for (const name of ['Used 2019 Honda Civic EX', '2019 Honda Civic EX', 'Certified Pre-Owned 2019 Honda Civic EX']) {
      const v = flat({ name }, shown(undefined, { ...carfax, title }));
      const r = assessVehicle(v, {});
      assert.equal(r.decision, DECISION.REVIEW, `${name} / ${title}: ${v.siteTitle}`);
      assert.match(r.reason, new RegExp(`its title says "${word}"`), `${name} / ${title}`);
      if (name !== '2019 Honda Civic EX') assert.equal(v.siteTitle, `${name.replace(/ 2019 Honda Civic EX$/, '')} ${title}`, 'the name\'s condition words go before the page title');
    }
  }
  // a demo, loaner or courtesy word before the page title's model year is read whatever condition word the name has
  for (const title of ['Demo 2019 Honda Civic EX | Sample Motors', 'Courtesy Vehicle 2019 Honda Civic EX | Sample Motors', 'Courtesy Vehicle: 2019 Honda Civic EX | Sample Motors', 'Courtesy Vehicle - 2019 Honda Civic EX | Sample Motors', 'Sample Motors - Service Loaner 2019 Honda Civic EX']) {
    for (const name of ['Used 2019 Honda Civic EX', '2019 Honda Civic EX', 'Certified Pre-Owned 2019 Honda Civic EX', 'New 2019 Honda Civic EX']) {
      const v = flat({ name }, shown(undefined, { ...carfax, title }));
      assert.equal(v.siteTitle, title, `${name} / ${title}: the page title is the title the gate reads`);
      const r = assessVehicle(v, {});
      assert.equal(r.decision, DECISION.REVIEW, `${name} / ${title}`);
      assert.match(r.reason, /^Listed as pre-owned but also flagged as a demo\. Demos and loaners are usually sold as new/, `${name} / ${title}`);
    }
    // a name that says demo itself is kept
    assert.equal(flat({ name: 'Demo 2019 Honda Civic EX' }, shown(undefined, { ...carfax, title })).siteTitle, 'Demo 2019 Honda Civic EX', title);
  }
  // a page title about another car lends no words; a plain page title changes nothing
  assert.equal(flat({ name: 'Used 2019 Honda Civic EX' }, shown(undefined, { ...carfax, title: 'Demo 2021 Kia Sorento LX | Sample Motors' })).siteTitle, 'Used 2019 Honda Civic EX');
  assert.equal(flat({ name: '2019 Honda Civic EX' }, shown(undefined, { ...carfax, title: '2021 Kia Sorento LX Demo | Sample Motors' })).siteTitle, '2019 Honda Civic EX');
  assert.equal(flat({ name: '2019 Honda Civic EX' }, shown(undefined, { ...carfax, title: '2019 Honda Civic EX | Sample Motors' })).siteTitle, '2019 Honda Civic EX');
});

// ---------- parity with the Dealer Inspire reader ----------

const DRIVE_MEMBERS = { '4WD': 'FourWheelDriveConfiguration', AWD: 'AllWheelDriveConfiguration', FWD: 'FrontWheelDriveConfiguration', RWD: 'RearWheelDriveConfiguration' };

// A flat vehicle written back out as the page a website would publish for
// it: schema.org JSON-LD as Google's vehicle listing documentation shows it,
// and the same price, miles and Carfax link in the page a person sees.
function asStructuredPage(v) {
  const node = {
    '@context': 'https://schema.org',
    '@type': 'Car',
    name: v.siteTitle || undefined,
    vehicleIdentificationNumber: v.vin,
    sku: v.stock || undefined,
    url: v.url,
    vehicleModelDate: String(v.year),
    brand: { '@type': 'Brand', name: v.make },
    model: [v.model, v.trim].filter(Boolean).join(' '), // many sites repeat the trim in the model
    vehicleConfiguration: v.trim || undefined,
    itemCondition: readCondition(v.inventoryType) === 'new' ? 'https://schema.org/NewCondition' : 'https://schema.org/UsedCondition',
    mileageFromOdometer: typeof v.mileage === 'number' ? { '@type': 'QuantitativeValue', value: v.mileage, unitCode: 'SMI' } : undefined,
    image: v.photos,
    color: v.exteriorColor || undefined,
    vehicleInteriorColor: v.interiorColor || undefined,
    bodyType: v.bodyType || undefined,
    driveWheelConfiguration: DRIVE_MEMBERS[v.drivetrain] ? 'https://schema.org/' + DRIVE_MEMBERS[v.drivetrain] : v.drivetrain || undefined,
    vehicleEngine: v.engine ? { '@type': 'EngineSpecification', name: v.engine } : undefined,
    vehicleTransmission: v.transmission || undefined,
    fuelType: v.fuelType || undefined,
    description: v.descriptionRaw || undefined,
    features: v.features.length ? v.features : undefined,
    offers: {
      '@type': 'Offer',
      price: v.price ?? undefined,
      priceCurrency: 'USD',
      availability: v.inTransit ? 'https://schema.org/PreOrder' : 'https://schema.org/InStock',
      seller: v.location ? { '@type': 'AutoDealer', name: v.location } : undefined,
    },
  };
  const carfax = v.carfaxUrl ? `<a href="https://www.carfax.com/VehicleHistory/p/Report.cfx?vin=${v.vin}">Carfax</a>` : '';
  const shownPrice = v.price ? `$${v.price.toLocaleString('en-US')}` : 'Call for price';
  const miles = typeof v.mileage === 'number' ? `${v.mileage.toLocaleString('en-US')} miles` : '';
  const json = JSON.stringify(node).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><title>${v.name} | Sample Motors</title><script type="application/ld+json">${json}</script></head><body><h1>${v.name}</h1><p>${shownPrice}</p><p>${miles}</p>${carfax}</body></html>`;
}

// What both readers can know from a page like that. Not compared: the
// photo count (the other platform reports a count beside a shortened list),
// the lower price, the status word, the stock date, the one-owner flag (it
// comes from a Carfax field schema.org does not have) and the price label.
const BOTH_KNOW = ['vin', 'stock', 'year', 'make', 'model', 'trim', 'name', 'siteTitle', 'url', 'urlConditionWord', 'isDemo', 'isLoaner', 'mileage', 'price', 'inTransit', 'location', 'locationShort', 'photos', 'descriptionRaw', 'features', 'exteriorColor', 'interiorColor', 'bodyType', 'drivetrain', 'engine', 'transmission', 'fuelType'];

function assertParity(label, record, settings) {
  const di = dealerInspireVehicle(record);
  const page = parseVehiclePage(asStructuredPage(di), di.url);
  assert.equal(page.vehicles.length, 1, label);
  const so = normalizeVehicle(page.vehicles[0], { url: di.url, facts: page.facts });
  for (const field of BOTH_KNOW) assert.deepEqual(so[field], di[field], `${label}: ${field}`);
  assert.equal(readCondition(so.inventoryType), readCondition(di.inventoryType), `${label}: the inventory type reads the same`);
  assert.equal(Boolean(so.carfaxUrl), Boolean(di.carfaxUrl), `${label}: a Carfax report either way`);
  assert.equal(/in.?stock/i.test(so.availability || ''), /in.?stock/i.test(di.availability || ''), `${label}: on the lot either way`);
  const [a, b] = [assessVehicle(so, settings), assessVehicle(di, settings)];
  assert.equal(a.decision, b.decision, `${label}: the gate decides the same`);
  assert.deepEqual(a.blockers.map((x) => x.code), b.blockers.map((x) => x.code), `${label}: the same blockers`);
  if (!b.blockers.length) assert.equal(a.reason, b.reason, `${label}: for the same reason`);
  return b.decision;
}

test('parity: every record of test/fixtures/records.json, published as JSON-LD, reads the same as the Dealer Inspire reader reads it', () => {
  const seen = new Set();
  for (const [key, record] of Object.entries(fixtures)) {
    if (key === '_about') continue;
    seen.add(assertParity(key, record, MY_STORE));
    assertParity(key + ' (any store)', record, {});
  }
  assert.deepEqual([...seen].sort(), ['not-ready', 'ready', 'review', 'skip'], 'the records cover every decision');
});

test('parity: the sandbox lot too, with its descriptions, features and single-page addresses', () => {
  const ctx = vm.createContext({ window: {} });
  vm.runInContext(readFileSync(new URL('../demo/site/inventory.js', import.meta.url), 'utf8'), ctx);
  const inventory = ctx.window.LOT_SYNC_INVENTORY;
  for (const day of ['day1', 'day2']) {
    // copied out of the sandbox's own realm, so lists compare as lists
    for (const r of JSON.parse(JSON.stringify(inventory.records(day, 'http://sandbox.test/demo/site/')))) {
      assertParity(`${day} ${r.stock || r.vin}`, trimRecord(r, { fullRecords: true }), { myStores: ['Example Motors Springfield'] });
    }
  }
});
