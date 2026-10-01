// Stand-ins for a DealerOn and a Dealer.com dealership website, for testing
// the two adapters end to end without touching any real website. Their
// shapes come from public sources and the 2026-10-01 survey (see
// extension/adapters/dealerOn.js and dealerCom.js), not from a recording of
// a live site. What matters for the extension is reproduced the way a real
// browser meets it:
//   - the used list page arrives with no cars in its HTML; its own script
//     asks the website for the list as JSON and draws the cards, so the
//     browser's resource timing list holds that request (what the probe
//     reads), and a plain read of the page shows no car;
//   - the list JSON pages (DealerOn: "pt" page numbers, 4 cars a page;
//     Dealer.com: "start" offsets, 4 cars a page) state the total;
//   - car pages are server HTML; DealerOn's carry /inventoryphotos/ photos;
//   - photos are served by the website itself (the test extension may reach
//     only 127.0.0.1).
// Test controls:
//   /scenario?name=day2   the first car sells (its page answers 404 on
//                         DealerOn, 410 on Dealer.com) and the second car's
//                         price drops $1,000
//   /requests             what was asked ({ method, path, status, ua });
//                         ?clear=1 empties the list
// It never looks at who is asking.

import http from 'node:http';
import { platformCars, dealerOnCard, dealerOnPath, dealerOnCarPage, dealerComRecord, dealerComPath, dealerComCarPage } from '../platformSites.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const CONTROLS = new Set(['/scenario', '/requests']);
const PER_PAGE = 4;

// Six used cars (one certified) and a "Used" car with 13 miles, which waits on Needs a look.
export const PLATFORM_LOT = (() => {
  const cars = platformCars(6, { from: 1 });
  const [low] = platformCars(1, { from: 7 });
  return [...cars, { ...low, miles: 13 }];
})();
export const DEALER_NAMES = { dealerOn: 'Sample Motors', dealerCom: 'Sample Chevrolet' };

const LIST_PATHS = { dealerOn: '/searchused.aspx', dealerCom: '/used-inventory/index.htm' };
const API = {
  dealerOn: '/api/vhcliaa/vehicle-pages/cosmos/srp/vehicles/12345/67890',
  dealerCom: '/apis/widget/INVENTORY_LISTING_DEFAULT_AUTO_USED:inventory-data-bus1/getInventory',
};

// The list page: an empty shell whose script fetches page 1 of the list and draws the cards.
function listPage(kind, host) {
  const first = kind === 'dealerOn' ? `${API.dealerOn}?host=${host}&pn=${PER_PAGE}` : `${API.dealerCom}?start=0`;
  const credit = kind === 'dealerOn' ? 'Copyright © 2026 by DealerOn' : 'Website by Dealer.com';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Used Vehicles | ${DEALER_NAMES[kind]}</title></head>
<body><h1>Used vehicles</h1><div id="cards"><div class="vehicle-card-skeleton"></div></div>
<footer>${credit}</footer>
<script>
fetch(${JSON.stringify(first)}).then((r) => r.json()).then((data) => {
  const list = data.DisplayCards ? data.DisplayCards.map((c) => c.VehicleCard) : data.inventory;
  const box = document.getElementById('cards');
  box.textContent = '';
  for (const car of list) {
    const a = document.createElement('a');
    a.className = 'vehicle-card';
    a.href = car.VehicleDetailUrl || car.link;
    a.textContent = car.VehicleName || [car.year, car.make, car.model].join(' ');
    box.appendChild(a);
  }
});
</script></body></html>`;
}

export function startMockPlatformSite(kind, port = 0) {
  let scenario = 'day1';
  const requests = [];
  const lot = () => {
    if (scenario !== 'day2') return PLATFORM_LOT;
    return PLATFORM_LOT.slice(1).map((c, i) => (i === 0 ? { ...c, base: c.base - 1000 } : c));
  };
  const sold = () => (scenario === 'day2' ? PLATFORM_LOT[0] : null);
  const pathOf = kind === 'dealerOn' ? dealerOnPath : dealerComPath;

  const server = http.createServer((req, res) => {
    const origin = 'http://' + req.headers.host;
    const url = new URL(req.url, origin);
    const send = (status, type, body) => {
      if (!CONTROLS.has(url.pathname)) requests.push({ method: req.method, path: url.pathname + url.search, status, ua: req.headers['user-agent'] || '' });
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    if (url.pathname === '/scenario') {
      scenario = url.searchParams.get('name') === 'day2' ? 'day2' : 'day1';
      return send(200, 'text/plain', scenario);
    }
    if (url.pathname === '/requests') {
      if (url.searchParams.get('clear')) requests.length = 0;
      return send(200, 'application/json', JSON.stringify(requests));
    }
    if (url.pathname === LIST_PATHS[kind]) return send(200, 'text/html; charset=utf-8', listPage(kind, req.headers.host));
    if (url.pathname === API[kind]) {
      const cars = lot();
      if (kind === 'dealerOn') {
        const page = Number(url.searchParams.get('pt') || 1);
        const slice = cars.slice((page - 1) * PER_PAGE, page * PER_PAGE);
        return send(200, 'application/json; charset=utf-8', JSON.stringify({ DisplayCards: slice.map((c) => dealerOnCard(c, { dealer: DEALER_NAMES.dealerOn })), Paging: { PaginationDataModel: { TotalCount: cars.length, PageNumber: page } } }));
      }
      const start = Number(url.searchParams.get('start') || 0);
      const records = cars.slice(start, start + PER_PAGE).map((c) => {
        const r = dealerComRecord(c, { dealer: DEALER_NAMES.dealerCom });
        // the photos on the website itself: the test extension can reach nothing else
        return { ...r, images: r.images.map((img, n) => ({ ...img, uri: `${origin}/pictures/${c.vin.toLowerCase()}-${n + 1}.png` })) };
      });
      return send(200, 'application/json; charset=utf-8', JSON.stringify({ pageInfo: { totalCount: cars.length, pageSize: PER_PAGE, pageStart: start }, inventory: records }));
    }
    const gone = sold();
    if (gone && url.pathname === pathOf(gone)) return send(kind === 'dealerOn' ? 404 : 410, 'text/html', '<h1>This vehicle is no longer available</h1>');
    const car = lot().find((c) => url.pathname === pathOf(c));
    if (car) return send(200, 'text/html; charset=utf-8', kind === 'dealerOn' ? dealerOnCarPage(car) : dealerComCarPage(car));
    if (/^\/(?:inventoryphotos|pictures)\//.test(url.pathname) || /\.(?:png|ico)$/.test(url.pathname)) return send(200, 'image/png', PNG);
    return send(404, 'text/html', '<h1>Not found</h1>');
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
