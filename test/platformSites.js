// Synthetic DealerOn and Dealer.com websites for the adapter tests. Their
// shapes come from public sources and the 2026-10-01 survey of local dealer
// websites (see extension/adapters/dealerOn.js and dealerCom.js); no live
// page was read, so these are stand-ins, not recordings. Every name, VIN and
// address here is made up (the VINs carry a valid check digit).

import vm from 'node:vm';
import { sampleVin } from './helpers.js';

export const DEALERON_ORIGIN = 'https://www.sample-dealeron.test';
export const DEALERCOM_ORIGIN = 'https://www.sample-dealercom.test';
export const DEALERON_LIST = `${DEALERON_ORIGIN}/api/vhcliaa/vehicle-pages/cosmos/srp/vehicles/12345/67890?host=www.sample-dealeron.test&pn=24&st=Price+asc`;
export const DEALERCOM_LIST = `${DEALERCOM_ORIGIN}/apis/widget/INVENTORY_LISTING_DEFAULT_AUTO_USED:inventory-data-bus1/getInventory?start=0`;

const MAKES = [['Jeep', 'Cherokee', 'Latitude', 'SUV'], ['Ram', '1500', 'Big Horn', 'Pickup'], ['Chevrolet', 'Malibu', 'LT', 'Sedan'], ['Ford', 'Edge', 'SEL', 'SUV'], ['Toyota', 'RAV4', 'XLE', 'SUV']];

// `count` cars, numbered from `from`: what both sites list.
export function platformCars(count, { from = 0 } = {}) {
  return Array.from({ length: count }, (_, n) => {
    const i = 200 + from + n;
    const [make, model, trim, body] = MAKES[i % MAKES.length];
    const year = 2017 + (i % 5);
    return { vin: sampleVin(i, year), stock: `PL${3000 + i}`, year, make, model, trim, body, base: 20000 + i * 100, fee: 490, miles: 30000 + i * 731, photos: 4, certified: i % 4 === 0 };
  });
}

const json = (body) => ({ ok: true, status: 200, contentType: 'application/json; charset=utf-8', text: JSON.stringify(body), json: body });
const html = (text) => ({ ok: true, status: 200, contentType: 'text/html; charset=utf-8', text, json: null });
export const answerWith = (status, text = '') => ({ ok: status >= 200 && status < 300, status, contentType: 'text/html', text, json: null });
const money = (n) => '$' + Number(n).toLocaleString('en-US');

// ---------- DealerOn ----------

export const dealerOnPath = (c) => `/used-Springfield-${c.year}-${c.make}-${c.model}-${c.trim.replace(/ /g, '+')}-${c.vin}`;

export function dealerOnCard(c, { dealer = 'Sample Motors' } = {}) {
  return {
    VehicleCard: {
      VehicleVin: c.vin,
      VehicleYear: c.year,
      VehicleMake: c.make,
      VehicleModel: c.model,
      VehicleTrim: c.trim,
      VehicleName: `${c.certified ? 'Certified Pre-Owned' : 'Used'} ${c.year} ${c.make} ${c.model} ${c.trim}`,
      VehicleStockNumber: c.stock,
      VehicleCondition: c.certified ? 'Certified Pre-Owned' : 'Used',
      VehicleIsCertified: c.certified,
      Mileage: c.miles.toLocaleString('en-US'),
      VehicleDetailUrl: dealerOnPath(c),
      VehicleExteriorColor: 'Bright White',
      VehicleInteriorColor: 'Black',
      VehicleBodyStyle: c.body,
      VehicleDrivetrain: '4WD',
      VehicleEngine: '2.4L I4',
      VehicleTransmission: '9-Speed Automatic',
      VehicleFuelType: 'Gasoline',
      VehiclePhotoCount: c.photos,
      VehiclePhotos: [`/inventoryphotos/12345/${c.vin.toLowerCase()}/ip/thumbs/1.jpg?width=320`],
      VehicleRetailPrice: c.base,
      VehicleInternetPrice: c.base + c.fee,
      VehiclePriceLabel: `${dealer} Price`,
      DealerName: dealer,
    },
  };
}

export function dealerOnCarPage(c, { photos = c.photos } = {}) {
  const imgs = Array.from({ length: photos }, (_, n) => `<img src="/inventoryphotos/12345/${c.vin.toLowerCase()}/ip/${n + 1}.jpg?height=400"><img src="/inventoryphotos/12345/${c.vin.toLowerCase()}/ip/thumbs/${n + 1}.jpg?width=320">`).join('');
  return `<!doctype html><html><head><title>Used ${c.year} ${c.make} ${c.model} | Sample Motors</title></head><body>
<h1>Used ${c.year} ${c.make} ${c.model} ${c.trim}</h1><p>VIN ${c.vin}</p><p>Retail Price ${money(c.base)}</p><p>Doc Fee +${money(c.fee)}</p><p>Sample Motors Price ${money(c.base + c.fee)}</p>
${imgs}<img src="/inventoryphotos/12345/1c4pjmcx5md000000/ip/1.jpg"><footer>Copyright © 2026 by DealerOn</footer></body></html>`;
}

/**
 * A DealerOn site: the list data (page size `perPage`, the page number in
 * "pt"), the car pages, and `gone` cars whose pages answer `goneStatus`.
 */
export function dealerOnSite({ cars = platformCars(6), perPage = 24, withTotal = true, gone = [], goneStatus = 404 } = {}) {
  const site = new Map();
  const pages = Math.max(1, Math.ceil(cars.length / perPage));
  for (let p = 1; p <= pages + 1; p += 1) {
    const slice = cars.slice((p - 1) * perPage, p * perPage);
    const body = { DisplayCards: slice.map((c) => dealerOnCard(c)), Paging: withTotal ? { PaginationDataModel: { TotalCount: cars.length, PageNumber: p } } : {} };
    const u = new URL(DEALERON_LIST);
    if (p > 1) u.searchParams.set('pt', String(p));
    site.set(u.href, json(body));
    if (p === 1) {
      u.searchParams.set('pt', '1');
      site.set(u.href, json(body));
    }
  }
  for (const c of cars) site.set(DEALERON_ORIGIN + dealerOnPath(c), html(dealerOnCarPage(c)));
  for (const c of gone) site.set(DEALERON_ORIGIN + dealerOnPath(c), answerWith(goneStatus, 'Not found'));
  return site;
}

// ---------- Dealer.com ----------

export const dealerComPath = (c) => `/${c.certified ? 'certified' : 'used'}/${c.make}/${c.year}-${c.make}-${c.model}-${c.vin.slice(-8).toLowerCase()}a0b1c2d3.htm`;

export function dealerComRecord(c, { dealer = 'Sample Chevrolet' } = {}) {
  return {
    uuid: `${c.vin.slice(-8).toLowerCase()}a0b1c2d3`,
    vin: c.vin,
    stockNumber: c.stock,
    year: c.year,
    make: c.make,
    model: c.model,
    trim: c.trim,
    bodyStyle: c.body,
    odometer: c.miles,
    exteriorColor: 'Summit White',
    interiorColor: 'Jet Black',
    engine: '1.5L Turbo',
    transmission: 'Automatic CVT',
    driveLine: 'FWD',
    fuelType: 'Gasoline',
    inventoryType: 'used',
    certified: c.certified,
    status: 'live',
    title: [`${c.year} ${c.make} ${c.model}`, c.trim],
    link: dealerComPath(c),
    images: Array.from({ length: c.photos }, (_, n) => ({ uri: `https://pictures.dealer.com/s/sampledealer/${100 + n}/${c.vin.slice(-6).toLowerCase()}${n}x.jpg`, alt: `${c.year} ${c.make} ${c.model}` })),
    pricing: {
      retailPrice: money(c.base),
      dprice: [
        { typeClass: 'retailPrice', label: 'Price', value: money(c.base), isFinalPrice: false },
        { typeClass: 'fees', label: 'Doc Fee', value: money(c.fee), isFinalPrice: false },
        { typeClass: 'internetPrice', label: `${dealer.split(' ')[0]} Price`, value: money(c.base + c.fee), isFinalPrice: true },
      ],
    },
    address: { accountName: dealer, city: 'Springfield', state: 'OH', postalCode: '43215' },
  };
}

export function dealerComCarPage(c) {
  return `<!doctype html><html><head><title>Used ${c.year} ${c.make} ${c.model} for sale in Springfield</title></head><body>
<h1>Used ${c.year} ${c.make} ${c.model} ${c.trim}</h1><dl><dt>VIN</dt><dd>${c.vin}</dd></dl><p>Price ${money(c.base)}</p><p>Doc Fee ${money(c.fee)}</p><p>Sample Price ${money(c.base + c.fee)}</p>
<img src="https://pictures.dealer.com/s/sampledealer/999/othercarx.jpg"><footer>Website by Dealer.com</footer></body></html>`;
}

/** A Dealer.com site: the list data (page size `perPage`, "start" counted from 0), the car pages, and sold cars answering 410. */
export function dealerComSite({ cars = platformCars(6), perPage = 35, withTotal = true, gone = [], goneStatus = 410 } = {}) {
  const site = new Map();
  for (let start = 0; start <= cars.length; start += perPage) {
    const slice = cars.slice(start, start + perPage);
    const body = { pageInfo: withTotal ? { totalCount: cars.length, pageSize: perPage, pageStart: start } : { pageSize: perPage }, inventory: slice.map((c) => dealerComRecord(c)) };
    const u = new URL(DEALERCOM_LIST);
    u.searchParams.set('start', String(start));
    site.set(u.href, json(body));
  }
  for (const c of cars) site.set(DEALERCOM_ORIGIN + dealerComPath(c), html(dealerComCarPage(c)));
  for (const c of gone) site.set(DEALERCOM_ORIGIN + dealerComPath(c), answerWith(goneStatus, 'Gone'));
  return site;
}

// ---------- search and page stand-ins ----------

/** search(request) over a site map, the way searchInPage / makeDirectSearch answer. */
export function platformSearch(site) {
  const calls = [];
  const search = async (request) => {
    calls.push(request.url);
    const got = site.get(request.url) || answerWith(404, 'Not found');
    return { finalUrl: request.url, redirected: false, ...got };
  };
  search.calls = calls;
  return search;
}

/**
 * A page of the site in a bare sandbox, for the in-page functions: the
 * resource timing list holds `requested` (what the page's own scripts asked
 * for), the body text holds `text`, window carries `windowExtras`.
 */
export function fakePlatformPage({ site = new Map(), origin, path = '/', requested = [], text = '', windowExtras = {}, scripts = [] }) {
  const url = new URL(path, origin).href;
  const fetchCalls = [];
  const fetch = async (href, init) => {
    fetchCalls.push({ url: String(href), init });
    const got = site.get(String(href)) || answerWith(404, 'Not found');
    return { ok: got.ok, status: got.status, url: String(href), redirected: false, headers: { get: (n) => (n.toLowerCase() === 'content-type' ? got.contentType : null) }, text: async () => got.text };
  };
  const document = {
    URL: url,
    title: 'Used vehicles',
    body: { innerText: text },
    querySelector: () => null,
    querySelectorAll: (sel) => (sel === 'script[src], link[href]' ? scripts.map((src) => ({ src })) : []),
  };
  const performance = { getEntriesByType: (type) => (type === 'resource' ? requested.map((name) => ({ name, initiatorType: 'fetch' })) : []) };
  const location = { origin, hostname: new URL(origin).hostname, href: url };
  const context = vm.createContext({ window: { ...windowExtras }, document, location, performance, URL, fetch, setTimeout, clearTimeout, AbortController });
  context.fetchCalls = fetchCalls;
  return context;
}
