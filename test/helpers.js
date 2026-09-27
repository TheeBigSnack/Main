import { readFileSync } from 'node:fs';
import { normalizeVehicle } from '../extension/src/normalize.js';
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
