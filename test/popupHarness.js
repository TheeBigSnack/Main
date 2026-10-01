// extension/popup.js in Node: a bare document with the popup's fixed
// elements (popup.html's ids), chrome as test/helpers.js stands it in, with
// the Dealer Inspire look-alike page as the open tab (or any other address,
// `tabUrl`: a Facebook page, a new tab), and sync storage.
// Enough to click the popup's buttons and read what it draws, without a
// browser. Each loadPopup imports a fresh copy of the popup, so its state
// starts from the storage given.

import { fixtures, fakeDealerPage, fakeChrome } from './helpers.js';

export const POPUP_ORIGIN = 'https://example-dealer.test';
const RECORDS = Object.entries(fixtures).filter(([k]) => k !== '_about').map(([, r]) => r);
let copies = 0;

export async function loadPopup({ origin = POPUP_ORIGIN, local = {}, sync = {}, records = RECORDS, granted = true, name = 'Example Motors', tabUrl = origin + '/used-vehicles/' } = {}) {
  const page = fakeDealerPage({ records, origin, name });
  const chrome = fakeChrome(page, local);
  chrome.storage.local.remove = async (keys) => { for (const key of [].concat(keys)) delete local[key]; };
  const storageListeners = [];
  chrome.storage.onChanged = { addListener(fn) { storageListeners.push(fn); } };
  chrome.storage.sync = {
    get: async (key) => (key in sync ? { [key]: structuredClone(sync[key]) } : {}),
    set: async (obj) => { Object.assign(sync, structuredClone(obj)); },
    remove: async (key) => { delete sync[key]; },
  };
  chrome.tabs = { query: async () => [{ id: 3, windowId: 1, url: tabUrl }] };
  chrome.runtime = { sendMessage: async () => ({}), getManifest: () => ({ version: '0.0.0-test' }) };
  chrome.permissions = { contains: async () => granted, request: async () => granted };
  chrome.sidePanel = { open: async () => {} };
  globalThis.chrome = chrome;

  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) {
      els.set(id, {
        id, innerHTML: '', textContent: '', disabled: false, className: '', dataset: {}, listeners: {},
        setAttribute() {}, addEventListener(type, fn) { this.listeners[type] = fn; }, contains: () => false, focus() {},
      });
    }
    return els.get(id);
  };
  globalThis.document = {
    getElementById: el, activeElement: null, querySelector: () => null, querySelectorAll: () => [],
    createElement: () => ({ click() {}, remove() {} }), body: { appendChild() {} },
  };

  copies += 1;
  await import(`../extension/popup.js?copy=${copies}`);
  // start-up ends with the first render, which names the website
  for (let i = 0; i < 200 && !el('site').textContent; i++) await new Promise((r) => setTimeout(r, 5));

  const button = (dataset) => ({ dataset, textContent: '' });
  return {
    local, sync, el,
    // a button in the panel, by its data-action (and data-vin, data-price ...)
    click: (action, data = {}) => el('panel').listeners.click({ target: { closest: () => button({ action, ...data }) } }),
    scan: () => el('scan').listeners.click(),
    tab: (view) => el('tabs').listeners.click({ target: { closest: () => button({ view }) } }),
    panel: () => el('panel').innerHTML,
    tabs: () => el('tabs').innerHTML,
    status: () => el('status').textContent,
    // another page (the side panel, the service worker) wrote these keys: { key: { newValue } }
    storageChanged: (changes, area = 'local') => { for (const fn of storageListeners) fn(changes, area); },
  };
}
