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

test('pageFacts: the title, canonical, next page, same-origin links, Carfax links and only the visible text', () => {
  const f = pageFacts(html('graph-vdp.html'), civicUrl + '?from=search');
  assert.deepEqual(Object.keys(f), ['title', 'canonical', 'next', 'links', 'carfaxLinks', 'text']);
  assert.equal(f.title, 'Used 2019 Honda Civic EX Sedan', 'the og:title, without the site name');
  assert.equal(f.canonical, civicUrl);
  assert.equal(f.next, null);
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
  assert.equal(flat(offers({ '@type': 'Offer', price: 19995 })).priceLabel, 'the page does not say the price is in US dollars');
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
