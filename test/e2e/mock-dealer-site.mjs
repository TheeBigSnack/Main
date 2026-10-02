// A stand-in for a Dealer Inspire dealership website, for testing the
// extension end to end without touching the real site. It exposes the same
// window.SEARCH_SERVICE / IDPSearchServiceHelper the real site has, backed by
// the real records in test/fixtures/records.json. The inventory can be
// changed between scans with /scenario?name=...

import http from 'node:http';
import { readFileSync } from 'node:fs';

const fx = JSON.parse(readFileSync(new URL('../fixtures/records.json', import.meta.url)));
delete fx._about;

const clone = (x) => JSON.parse(JSON.stringify(x));
// Change a car's price the way the real site shows it: the headline
// "Ron Lewis Real Price" includes the $490 doc fee, the rest don't.
const withPrice = (r, value) => {
  const c = clone(r);
  c.extra_fields.lightning.pricing.low.value = String(value);
  c.extra_fields.lightning.pricing.high.value = String(value - 490);
  Object.assign(c.pricing, { our_price: value, internet_price: value - 490, price: value - 490, original_price: value - 490 });
  return c;
};

// Day 1: everything from the fixtures. Day 2: the Ram sold, the Wagoneer
// dropped $1,500, the Hellcat got photos, and a Silverado arrived. Day 3:
// the Tradesman got photos and moved to Waynesburg, so three cars are ready
// (the Silverado: today, $36,603; the Hellcat: 40 days, $53,485; the
// Tradesman: 50 days, $33,485) and each of the Ready tab's four orders
// gives a different list.
export const SCENARIOS = {
  day1: () => Object.values(fx).map(clone),
  day2: () => {
    const list = Object.values(fx)
      .filter((r) => r.vin !== fx.usedNormal.vin)
      .map((r) => (r.vin === fx.certified.vin ? withPrice(r, 36883) : clone(r)));
    const hellcat = list.find((r) => r.vin === fx.usedNoCarfax.vin);
    hellcat.media.image_count = 14;
    hellcat.extra_fields.meta_location = 'Ron Lewis Chrysler Dodge Jeep Ram Waynesburg';
    const arrival = clone(fx.usedNormal);
    Object.assign(arrival, { vin: '3GCUYGED0MG244585', stock: 'W2001', make: 'Chevrolet', model: 'Silverado 1500', trim: 'LTZ', year: 2021, mileage: 53222 });
    arrival.vdp_url = 'https://example.test/inventory/used-2021-chevrolet-silverado-1500-ltz-4wd-3gcuyged0mg244585/';
    arrival.extra_fields.title = 'Pre-Owned 2021 Chevrolet Silverado 1500 LTZ';
    arrival.extra_fields.lightning.vdp_title = arrival.extra_fields.title;
    list.push(withPrice(arrival, 36603));
    return list;
  },
  day3: () => {
    const list = SCENARIOS.day2();
    const tradesman = list.find((r) => r.vin === fx.usedNoPhotos.vin);
    tradesman.media.image_count = 9;
    tradesman.extra_fields.meta_location = 'Ron Lewis Chrysler Dodge Jeep Ram Waynesburg';
    return list;
  },
};

let current = 'day1';
let directSearches = 0;

// The real site's `description` field mixes a lot-wide disclaimer, feature
// bullets, and (on some cars) a genuine write-up; `features` is a clean list.
// The fixtures were captured without those fields, so they're added here.
const DISCLAIMER =
  'Ron Lewis Real Price includes all costs to be paid by a consumer except for licensing costs, registration fees and taxes. Documentation fee of $490 is not included. All loans are subject to bank approval.';
const EXTRA = {
  [fx.usedNormal.vin]: {
    features: ['4WD', 'Backup Camera', 'Bluetooth', 'Keyless Entry', 'Tow Package', 'Power Windows', 'Cruise Control'],
    // it ends on a word in lower case, so the template can tell the sentence is over and copies it (src/description.js openingSentences)
    narrative: 'This 2019 Ram 1500 Classic Express Quad Cab pairs the HEMI 5.7L V8 with 4WD and an 8-speed automatic.',
  },
};
// The fixtures' in-stock dates are the capture's; here each car's date is
// set relative to the day the test runs, so the Ready tab's "New" window
// (7 days) and its two date orders can be checked on any day: day 1's cars
// 30 days or more ago, each a little older than the one before it in the
// fixtures, and the day-2 arrival today. "Today" is the machine's own
// calendar day, as a dealer's website in the dealer's time zone has it: the
// popup counts a website's calendar date in the person's day (src/readyList.js
// ageDays), so "40 days on the lot" holds at any hour in any time zone.
const ARRIVAL_VIN = '3GCUYGED0MG244585';
const DAY_MS = 24 * 60 * 60 * 1000;
const AGE_DAYS = new Map(Object.values(fx).map((r, i) => [r.vin, 30 + i * 5]));
const todayUtc = () => { const d = new Date(); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); };
export const inStockDate = (daysAgo) => new Date(todayUtc() - daysAgo * DAY_MS).toISOString().slice(0, 10) + 'T00:00:00.000Z';

// Photo URLs point back at this mock server (the real ones are on the dealer's image host).
function enrich(r, origin) {
  const c = clone(r);
  c.date_in_stock = inStockDate(c.vin === ARRIVAL_VIN ? 0 : AGE_DAYS.get(c.vin) ?? 60);
  const x = EXTRA[c.vin] || { features: ['Power Windows', 'Cruise Control'], narrative: '' };
  c.features = x.features;
  c.description =
    (x.narrative
      ? `${x.narrative}<br>- HEMI 5.7L V8 Multi Displacement VVT Engine<br>- 8-Speed Automatic Transmission with 4WD<br>`
      : 'Recent Arrival! Air Conditioning, Power Steering, Power Windows, Power Locks, Cruise Control, Tilt Wheel, AM/FM Stereo.<br>') + DISCLAIMER;
  const n = Number(c.media && c.media.image_count) || 0;
  c.media = { image_count: n, images: Array.from({ length: n }, (_, i) => `${origin}/photo/${c.vin}/${i + 1}.png`) };
  return c;
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<title>Used Vehicles for Sale Near Washington | Ron Lewis Chrysler Dodge Jeep Ram Waynesburg</title>
<meta property="og:site_name" content="Ron Lewis Chrysler Dodge Jeep Ram Waynesburg">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"AutoDealer","name":"Ron Lewis Chrysler Dodge Jeep Ram Waynesburg","telephone":"(555) 555-0100","address":{"@type":"PostalAddress","streetAddress":"1 Example Way","addressLocality":"Waynesburg","addressRegion":"PA","postalCode":"15370","addressCountry":"US"}}</script>
</head><body><h1>124 USED AND CERTIFIED USED FOR SALE (test page)</h1>
<script>
window.SEARCH_SERVICE = { apiKey: 'test-key', search: '/api/v1/listings/153146', visibleStatusValues: ['publish', 'modified', 'pend-sale'] };
window.IDPSearchServiceHelper = {
  async getListings(body) {
    const all = await (await fetch('/inventory.json')).json();
    const f = body.filters || {};
    let list = all.filter((r) => (!f.type || f.type.includes(r.type)) && (!f.vin || f.vin.includes(r.vin)) && (!f.status || f.status.includes(r.status)));
    const total = list.length;
    const start = (body.page - 1) * body.perPage;
    return { data: { ccid: 153146, total_vehicle_count: total, listings: list.slice(start, start + body.perPage) } };
  },
};
</script></body></html>`;

export function startMockSite(port = 0) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/inventory.json') {
      const origin = 'http://' + req.headers.host;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(SCENARIOS[current]().map((r) => enrich(r, origin))));
    }
    // The search service's own endpoint, as the extension's background rescan
    // calls it directly (POST, JSON, x-api-key).
    if (req.method === 'POST' && /^\/api\/v1\/listings\/\d+\/search$/.test(url.pathname)) {
      directSearches += 1;
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const b = JSON.parse(raw || '{}');
        const origin = 'http://' + req.headers.host;
        const all = SCENARIOS[current]().map((r) => enrich(r, origin));
        const f = b.filters || {};
        const list = all.filter((r) => (!f.type || f.type.includes(r.type)) && (!f.vin || f.vin.includes(r.vin)) && (!f.status || f.status.includes(r.status)));
        const perPage = b.perPage || 50;
        const start = ((b.page || 1) - 1) * perPage;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: { ccid: 153146, total_vehicle_count: list.length, listings: list.slice(start, start + perPage) }, meta: { apiKey: req.headers['x-api-key'] ? 'seen' : 'missing' } }));
      });
      return;
    }
    if (url.pathname.startsWith('/photo/')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(PNG);
    }
    // how many searches reached the service directly (not through the page's helper): the side panel's tabless reads count here
    if (url.pathname === '/direct-count') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(String(directSearches));
    }
    if (url.pathname === '/scenario') {
      current = url.searchParams.get('name') || 'day1';
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(current);
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
