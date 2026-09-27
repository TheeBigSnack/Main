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
// dropped $1,500, the Hellcat got photos, and a Silverado arrived.
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
};

let current = 'day1';

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<title>Used Vehicles for Sale Near Washington | Ron Lewis Chrysler Dodge Jeep Ram Waynesburg</title>
<meta property="og:site_name" content="Ron Lewis Chrysler Dodge Jeep Ram Waynesburg">
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
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(SCENARIOS[current]()));
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
