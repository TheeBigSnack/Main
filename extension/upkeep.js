// Listing upkeep in the side panel: a To do item (a sold car to take down, a
// price to update) opens the salesperson's own listing, the new price is put
// into the edit form's Price box as soon as it appears, and the item is
// marked done when the page shows the change (or when the person says so).
// The person clicks Edit, Update, Mark as sold or Delete; Lot Current never does.
//
// Two guards, because the tab is an ordinary tab the person can move around
// in (and for a car with no saved link it opens on Marketplace's list of all
// their listings):
//   - nothing is filled or ticked off unless the page is this car's listing
//     (its id in the address, or its year/make/model on the page);
//   - a sold/removed sign counts only if it appeared after the page was first
//     read, so a page that already says "sold" somewhere waits for the person.

import { markPriceUpdated, markTakenDown } from './src/rescan.js';
import { fillPriceInPage, readListingInPage } from './facebook/fillForm.js';
import { LISTING_SIGNS } from './facebook/listingSigns.js';
import { resolveFlag, updatePilot } from './src/pilot.js';
import { siteKeys } from './src/storageKeys.js';
import { noteTakenDown } from './src/takenDown.js';
import { updateKey, storageErrorText } from './src/storage.js';

export const up = {
  active: false,
  origin: null, vin: null, kind: null, price: null, listingUrl: '', name: '', listedPrice: null,
  basis: null, // the price basis the new price was taken at (the popup's request), recorded with it
  tabId: null, status: 'idle', // idle | opening | waiting | filled | done | gone
  note: '', filledShown: '', seen: null, error: '', fills: 0,
  baseline: null, // { url, sold, unavailable } from the first read of the current page
  offTarget: false, // the tab is showing some other page
};
let poller = null;
const MAX_FILLS = 4; // a form that is still loading can overwrite the price once or twice

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => (typeof n === 'number' && Number.isFinite(n) ? '$' + Math.round(n).toLocaleString('en-US') : '—');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The listing id from a saved listing link, using the map's pattern.
export function listingIdFrom(url, pattern) {
  if (!url) return '';
  try {
    const m = new RegExp(pattern).exec(url);
    return (m && m[1]) || '';
  } catch (e) {
    return '';
  }
}

function stopPolling() {
  if (poller) clearInterval(poller);
  poller = null;
}

export async function startUpkeep(req, ctx) {
  stopPolling();
  Object.assign(up, { active: true, origin: req.origin, vin: String(req.vin || '').toUpperCase(), kind: req.kind, price: req.price || null, basis: req.basis || null, listingUrl: req.listingUrl || '', name: req.name || req.vin, listedPrice: req.listedPrice || null, tabId: null, status: 'opening', note: '', filledShown: '', seen: null, error: '', fills: 0, baseline: null, offTarget: false });
  ctx.render();
  const map = ctx.map();
  const url = up.listingUrl || map.yourListingsUrl;
  try {
    const tab = await chrome.tabs.create({ url, active: true });
    up.tabId = tab.id;
  } catch (e) {
    up.error = "Couldn't open the listing: " + ((e && e.message) || e);
    up.status = 'idle';
    ctx.render();
    return;
  }
  up.status = 'waiting';
  up.note = up.listingUrl ? '' : `No listing link was saved for this car, so this is Marketplace's Your listings page: open the listing for ${up.name} there.`;
  ctx.render();
  await sleep(1500);
  poller = setInterval(() => poll(ctx).catch(() => {}), 1500);
}

const expectFor = (map) => ({ id: listingIdFrom(up.listingUrl, map.listingUrlPattern), name: up.name });

// Every 1.5 s: read the tab; for a price update, fill the box when it shows
// up on this car's edit form (again if the loading form overwrites it); for
// either kind, notice when this car's page shows the change.
let polling = false;
async function poll(ctx) {
  if (!up.active || !up.tabId) return stopPolling();
  if (polling) return;
  polling = true;
  try {
    const map = ctx.map();
    let seen;
    try {
      const [inj] = await chrome.scripting.executeScript({ target: { tabId: up.tabId }, func: readListingInPage, args: [map, LISTING_SIGNS, expectFor(map)] });
      seen = inj && inj.result;
    } catch (e) {
      // the tab closed, or is on a page Lot Current may not read (outside /marketplace/)
      try { await chrome.tabs.get(up.tabId); } catch (gone) { up.status = 'gone'; stopPolling(); ctx.render(); }
      return;
    }
    if (!seen) return;
    up.seen = seen;
    const onTarget = Boolean(seen.matchesId || seen.matchesName);
    if (!up.baseline || up.baseline.url !== seen.url) {
      // first read of this page: what it says now is the starting point, not a change
      up.baseline = { url: seen.url, sold: seen.sold, unavailable: seen.unavailable };
      if (up.status === 'filled' && up.kind === 'price' && !onTarget) up.status = 'waiting'; // moved to another page after the fill
    }
    if (up.offTarget !== !onTarget) {
      up.offTarget = !onTarget;
      up.note = onTarget ? '' : `This tab isn't showing the listing for ${up.name}. Open that listing and Lot Current continues.`;
      ctx.render();
    }
    if (!onTarget) return;
    if (up.kind === 'price') {
      const want = String(Math.round(up.price));
      const boxHasIt = seen.hasPriceBox && seen.priceBoxValue.replace(/\D/g, '') === want;
      if (seen.hasPriceBox && !boxHasIt && up.fills < MAX_FILLS && (up.status === 'waiting' || up.status === 'filled')) {
        up.fills += 1;
        const [inj] = await chrome.scripting.executeScript({ target: { tabId: up.tabId }, func: fillPriceInPage, args: [map, up.price] });
        const r = inj && inj.result;
        if (r && r.ok) {
          up.status = 'filled';
          up.filledShown = r.shown;
          up.note = '';
        } else if (r && r.reason) {
          up.note = r.reason;
        }
        ctx.render();
        return;
      }
      if (up.status === 'filled' && !seen.hasPriceBox && seen.prices.includes(want)) return finish(ctx, 'detected'); // saved: the listing page shows the new price
    } else if (up.kind === 'takeDown') {
      const changed = (seen.sold && !up.baseline.sold) || (seen.unavailable && !up.baseline.unavailable);
      if (changed) return finish(ctx, 'detected');
    }
  } finally {
    polling = false;
  }
}

// The diff without this car's items in the given lists; undefined when no
// diff is stored, so nothing is written.
function dropFromDiff(diff, lists) {
  if (!diff || typeof diff !== 'object') return undefined;
  const next = { ...diff };
  for (const list of lists) if (Array.isArray(next[list])) next[list] = next[list].filter((x) => x.vin !== up.vin);
  return next;
}

async function finish(ctx, how) {
  stopPolling();
  // The posted list and the diff are changed from what is stored now, each
  // under its key's lock (src/storage.js): the popup and the worker write
  // them too. A write that fails (the quota) leaves the item open, with the
  // reason shown, so "I updated it" can be clicked again once there is room.
  const k = siteKeys(up.origin);
  const price = up.kind === 'price';
  try {
    // a post taken down is kept for the daily cap first (src/takenDown.js);
    // this item came from the scan (sold, gone or sale pending), so the
    // website no longer listed the car as ready
    if (!price) {
      const entry = ((await chrome.storage.local.get(k.posted))[k.posted] || {})[up.vin];
      if (entry && entry.mine !== false) await updateKey(k.takenDown, (log) => noteTakenDown(log, { vin: up.vin, postedAt: entry.postedAt, stillListed: false }));
    }
    await updateKey(k.posted, (posted) => (price ? markPriceUpdated(posted || {}, up.vin, up.price, undefined, up.basis) : markTakenDown(posted || {}, up.vin)));
    await updateKey(k.diff, (diff) => dropFromDiff(diff, price ? ['priceUpdates'] : ['takeDown', 'priceUpdates', 'needsALook']));
  } catch (e) {
    up.error = storageErrorText(e);
    ctx.render();
    return;
  }
  up.error = '';
  // pilot numbers: how long the item stayed open, and whether Lot Current saw the change itself
  await updatePilot(up.origin, (p) => resolveFlag(p, up.vin, up.kind === 'price' ? 'price' : 'takeDown', { how })).catch(() => null);
  chrome.runtime.sendMessage({ type: 'updateBadge' }).catch(() => {});
  up.status = 'done';
  up.note = how === 'detected' ? (up.kind === 'price' ? `The listing now shows ${money(up.price)}.` : 'The listing shows it as sold or removed.') : 'Marked done.';
  ctx.render();
}

export function endUpkeep() {
  stopPolling();
  up.active = false;
  up.status = 'idle';
}

export function upkeepHtml() {
  const title = up.kind === 'price' ? `Update the price: ${esc(up.name)}` : `Take down: ${esc(up.name)}`;
  const error = up.error ? `<div class="banner bad">${esc(up.error)}</div>` : '';
  const note = up.note ? `<p class="hint" id="upkeepNote">${esc(up.note)}</p>` : '';
  let body = '';
  if (up.status === 'opening') body = '<p>Opening your listing…</p>';
  else if (up.status === 'gone') body = '<div class="banner warn">The listing tab was closed. Did you finish?</div>';
  else if (up.status === 'done') body = `<div class="banner good" id="upkeepDone">Done. ${esc(up.note)}</div>`;
  else if (up.kind === 'price') {
    body = up.status === 'filled'
      ? `<div class="banner good" id="priceFilled">New price ${money(up.price)} is in the Price box (it shows "${esc(up.filledShown)}"). Now click <b>Update</b> on Facebook. Lot Current will notice when the listing shows the new price.</div>`
      : `<div class="banner info" id="priceWaiting">On Facebook, click <b>Edit listing</b>. As soon as the Price box appears on this car's form, Lot Current fills in <b>${money(up.price)}</b>${up.listedPrice ? ` (was ${money(up.listedPrice)})` : ''}; then you click <b>Update</b>.</div>`;
  } else {
    body = `<div class="banner info" id="takeDownWaiting">On Facebook, click <b>Mark as sold</b> (or <b>Delete</b>) on this listing. Lot Current will notice and mark it done.</div>`;
  }
  const buttons = up.status === 'done'
    ? `<button type="button" class="primary" id="upkeepClose">Close</button>`
    : `<button type="button" class="primary" id="upkeepDoneBtn">${up.kind === 'price' ? 'I updated it' : 'I took it down'}</button><button type="button" class="plain" id="upkeepCancel">Not now</button>`;
  return `<section class="car"><div class="name">${title}</div><div class="facts">${esc(up.vin)}${up.listingUrl ? ` · <a href="${esc(up.listingUrl)}" target="_blank" rel="noopener">listing</a>` : ''}</div></section>
    ${error}${body}${note}
    <div class="actions">${buttons}</div>
    <p class="hint">Lot Current fills in the price and reads the page; you click Edit, Update, Mark as sold or Delete. It never clicks those for you.</p>`;
}

export async function handleUpkeepClick(id, ctx) {
  if (!up.active) return false;
  switch (id) {
    case 'upkeepDoneBtn':
      await finish(ctx, 'manual');
      return true;
    case 'upkeepCancel':
    case 'upkeepClose':
      endUpkeep();
      ctx.onClose();
      return true;
    default:
      return false;
  }
}
