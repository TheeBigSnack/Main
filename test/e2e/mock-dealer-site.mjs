// A stand-in for a Dealer Inspire dealership website, for testing the
// extension end to end without touching the real site. It exposes the same
// window.SEARCH_SERVICE / IDPSearchServiceHelper the real site has, backed by
// the real records in test/fixtures/records.json. The inventory can be
// changed between scans with /scenario?name=...

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

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
  // Day 2, then the website marks the Wagoneer sale-pending (it stays listed).
  day2pending: () => SCENARIOS.day2().map((r) => (r.vin === fx.certified.vin ? { ...r, status: 'pend-sale' } : r)),
  day3: () => {
    const list = SCENARIOS.day2();
    const tradesman = list.find((r) => r.vin === fx.usedNoPhotos.vin);
    tradesman.media.image_count = 9;
    tradesman.extra_fields.meta_location = 'Ron Lewis Chrysler Dodge Jeep Ram Waynesburg';
    return list;
  },
  // Day 1 with real-size photos (test/e2e/branding.e2e.mjs): the Ram's 6
  // carry a photo vendor's band along the bottom, the Wagoneer's 6 are plain.
  // The Wagoneer's fuel reads plain gasoline here and it sits at the same
  // store as the Ram, so nothing but its photos decides whether the queue
  // opens its form by itself.
  branded: () => SCENARIOS.day1().map((r) => {
    if (r.vin === fx.usedNormal.vin) r.media.image_count = 6;
    if (r.vin === fx.certified.vin) {
      r.media.image_count = 6;
      r.mechanical.fuel_type = 'Gasoline Fuel';
      r.extra_fields.meta_location = 'Ron Lewis Chrysler Dodge Jeep Ram Waynesburg';
      r.extra_fields.location_rt = r.extra_fields.meta_location;
    }
    return r;
  }),
};

let current = 'day1';
let directSearches = 0;
let photoDelayMs = 0; // /photo-delay?ms=: every photo answers this late (a slow photo server)

// The real site's `description` field mixes a lot-wide disclaimer, feature
// bullets, and (on some cars) a genuine write-up; `features` is a clean list.
// The fixtures were captured without those fields, so they're added here.
const DISCLAIMER =
  'Ron Lewis Real Price includes all costs to be paid by a consumer except for licensing costs, registration fees and taxes. Documentation fee of $490 is not included. All loans are subject to bank approval.';
const EXTRA = {
  [fx.usedNormal.vin]: {
    features: ['4WD', 'Backup Camera', 'Bluetooth', 'Keyless Entry', 'Tow Package', 'Power Windows', 'Cruise Control'],
    narrative: 'This 2019 Ram 1500 Classic Express Quad Cab pairs the HEMI 5.7L V8 with 4WD and an 8-Speed Automatic.',
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

// ---- real-size photos for the 'branded' scenario ----
// A 640x480 photo-like picture (a random gradient, a few shapes, a little
// noise, different for every photo), as an RGB PNG encoded here (zlib and a
// CRC-32, no image library). The branded car's photos carry the same band
// over their bottom 48 rows, the way a photo vendor's overlay is laid on:
// BAND_COLOUR with white bars for lettering.
export const PHOTO_W = 640;
export const PHOTO_H = 480;
export const BAND_ROWS = 48;
export const BAND_COLOUR = [0x1a, 0x3c, 0x8c];
export const BRANDED_VIN = fx.usedNormal.vin;
export const PLAIN_VIN = fx.certified.vin;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
function encodePng(w, h, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0; // no filter
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const inBand = (x, y) => y >= PHOTO_H - BAND_ROWS;
// Every photo also has a strip EDGE_COLS wide down its left and right edges
// (above the band) in a colour of its own, so it is part of the picture, not
// of the overlay: test/e2e/branding.e2e.mjs reads a cropped thumbnail's
// outermost columns to see that the whole width that goes is shown.
export const EDGE_COLS = 24;
const EDGE_PALETTE = [[230, 30, 30], [30, 200, 60], [240, 220, 20], [220, 40, 220], [30, 210, 220], [250, 140, 20]];
export const edgeColour = (seed) => EDGE_PALETTE[seed % EDGE_PALETTE.length];
const atEdge = (x) => x < EDGE_COLS || x >= PHOTO_W - EDGE_COLS;
const bandPixel = (x, y) => (y >= PHOTO_H - 36 && y < PHOTO_H - 12 && (x >> 3) % 3 === 0 && x >= 40 && x < 560 ? [250, 250, 250] : BAND_COLOUR);
// Also used by scripts/a11y.mjs for the side panel's cropped-photos state.
export function photoPng(seed, branded) {
  const r = rng(seed);
  const c = () => [r() * 255, r() * 255, r() * 255];
  const [a, b, d, e] = [c(), c(), c(), c()];
  const shapes = Array.from({ length: 6 }, () => ({ x: r() * PHOTO_W, y: r() * PHOTO_H, rad: 25 + r() * 120, col: c() }));
  const rgb = Buffer.alloc(PHOTO_W * PHOTO_H * 3);
  for (let y = 0; y < PHOTO_H; y++) {
    for (let x = 0; x < PHOTO_W; x++) {
      const o = (y * PHOTO_W + x) * 3;
      const band = branded && inBand(x, y) ? bandPixel(x, y) : !inBand(x, y) && atEdge(x) ? edgeColour(seed) : null;
      const u = x / PHOTO_W;
      const v = y / PHOTO_H;
      for (let k = 0; k < 3; k++) {
        if (band) { rgb[o + k] = band[k]; continue; }
        let val = a[k] * (1 - u) * (1 - v) + b[k] * u * (1 - v) + d[k] * (1 - u) * v + e[k] * u * v;
        for (const s of shapes) if ((x - s.x) ** 2 + (y - s.y) ** 2 < s.rad ** 2) val = s.col[k];
        rgb[o + k] = Math.max(0, Math.min(255, Math.round(val + (r() - 0.5) * 8)));
      }
    }
  }
  return encodePng(PHOTO_W, PHOTO_H, rgb);
}
const photoCache = new Map();
// The seed of photo n of a car in the 'branded' scenario (its picture and its edge colour).
export const photoSeed = (vin, n) => (vin === BRANDED_VIN ? 1000 : 2000) + Number(n);
// The photo the 'branded' scenario serves at /photo/<vin>/<n>.png, or null (every other photo is the 1x1 PNG).
function brandedPhoto(vin, n) {
  if (vin !== BRANDED_VIN && vin !== PLAIN_VIN) return null;
  const key = `${vin}/${n}`;
  if (!photoCache.has(key)) photoCache.set(key, photoPng(photoSeed(vin, n), vin === BRANDED_VIN));
  return photoCache.get(key);
}

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
      const m = /^\/photo\/([^/]+)\/(\d+)\.png$/.exec(url.pathname);
      const big = current === 'branded' && m ? brandedPhoto(m[1], m[2]) : null;
      const send = () => {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(big || PNG);
      };
      if (photoDelayMs) setTimeout(send, photoDelayMs);
      else send();
      return;
    }
    if (url.pathname === '/photo-delay') {
      photoDelayMs = Math.max(0, Number(url.searchParams.get('ms')) || 0);
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(String(photoDelayMs));
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
