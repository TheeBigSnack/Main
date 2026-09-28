import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { normalizeVehicle } from '../extension/adapters/dealerInspireNormalize.js';
import { assessVehicle } from '../extension/src/classify.js';
import { makeSnapshot } from '../extension/src/rescan.js';

export const fixtures = JSON.parse(readFileSync(new URL('./fixtures/records.json', import.meta.url)));
export const WAYNESBURG = 'Ron Lewis Chrysler Dodge Jeep Ram Waynesburg';
export const MY_STORE = { myStores: [WAYNESBURG] };

function isObject(x) {
  return x && typeof x === 'object' && !Array.isArray(x);
}

export function deepMerge(base, patch) {
  if (!isObject(patch)) return patch;
  const out = { ...base };
  for (const [k, val] of Object.entries(patch)) out[k] = isObject(val) && isObject(base?.[k]) ? deepMerge(base[k], val) : val;
  return out;
}

// A raw record from the fixtures, optionally changed
export function raw(name, patch = {}) {
  return deepMerge(fixtures[name], patch);
}

export function vehicle(name, patch = {}) {
  return normalizeVehicle(raw(name, patch));
}

// A snapshot built from [fixtureName, patch] pairs, run through the real pipeline
export function snapshot(items, settings = MY_STORE, takenAt = '2026-09-26T21:00:00.000Z') {
  const vehicles = items.map(([name, patch]) => vehicle(name, patch));
  const assessments = vehicles.map((v) => assessVehicle(v, settings));
  return makeSnapshot({ site: { origin: 'https://example-dealer.test', name: 'Test' }, takenAt, complete: true, vehicles, assessments });
}

// ---------- a dealer page as the injected code sees it ----------

// The globals a Dealer Inspire look-alike page (test/e2e/mock-dealer-site.mjs)
// offers the functions chrome.scripting.executeScript copies into it:
// window.SEARCH_SERVICE and IDPSearchServiceHelper backed by `records`, a
// document with the og:site_name and a schema.org address, a location.
// `withService: false` gives a page no adapter recognises. The result is a
// vm sandbox for fakeChrome: injected functions run inside it, with nothing
// else in scope, so one that reached outside its own body throws.
export function fakeDealerPage({ records = [], origin = 'https://example-dealer.test', withService = true, name = 'Example Motors' } = {}) {
  const getListings = async (body) => {
    const f = body.filters || {};
    const list = records.filter((r) => (!f.type || f.type.includes(r.type)) && (!f.vin || f.vin.includes(r.vin)) && (!f.status || f.status.includes(r.status)));
    const perPage = body.perPage || 50;
    const start = ((body.page || 1) - 1) * perPage;
    return { data: { total_vehicle_count: list.length, listings: list.slice(start, start + perPage) } };
  };
  const window = {};
  if (withService) {
    window.SEARCH_SERVICE = { apiKey: 'test-key', search: '/api/v1/listings/1', visibleStatusValues: ['publish', 'modified', 'pend-sale'] };
    window.IDPSearchServiceHelper = { getListings };
  }
  const ld = { '@context': 'https://schema.org', '@type': 'AutoDealer', name, telephone: '(555) 555-0100', address: { '@type': 'PostalAddress', streetAddress: '1 Example Way', addressLocality: 'Springfield', addressRegion: 'OH', postalCode: '43215' } };
  const document = {
    title: `Used Vehicles for Sale | ${name}`,
    body: { innerText: 'USED AND CERTIFIED USED FOR SALE' },
    querySelector: (sel) => (sel === 'meta[property="og:site_name"]' ? { content: name } : null),
    querySelectorAll: (sel) => (sel === 'script[type="application/ld+json"]' ? [{ textContent: JSON.stringify(ld) }] : []),
  };
  const location = { origin, hostname: new URL(origin).hostname, href: origin + '/used-vehicles/' };
  return vm.createContext({ window, document, location, URL });
}

// Runs a function's source inside the page sandbox, the way Chrome copies it
// into the tab: nothing from the module it came from is in scope, and the
// result comes back structured-cloned, as executeScript returns it.
export async function runInPage(page, func, ...args) {
  const fn = vm.runInContext('(' + String(func) + ')', page);
  const result = await fn(...args);
  return result === undefined ? undefined : structuredClone(result);
}

// chrome.scripting.executeScript and chrome.storage.local stand-ins for the
// scan runner: injections run in the page sandbox, storage is `store`.
export function fakeChrome(page, store = {}) {
  return {
    store,
    scripting: {
      executeScript: async ({ func, args = [] }) => [{ result: await runInPage(page, func, ...args) }],
    },
    storage: {
      local: {
        get: async (keys) => {
          const out = {};
          for (const k of Array.isArray(keys) ? keys : [keys]) if (k in store) out[k] = store[k];
          return out;
        },
        set: async (obj) => { Object.assign(store, obj); },
      },
    },
  };
}
