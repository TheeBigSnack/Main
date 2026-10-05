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
//     (onListing): its id in the address when the listing's id is known; with
//     no saved link, never on the Your listings page, and elsewhere only a
//     page that shows every word of the car's name as a whole word and the
//     price it was listed at (or the new price), and also its VIN when
//     another car in the posted list has every word of this car's name in
//     its own (two identical units at one price look alike otherwise). Such
//     a page that is a listing gives the id, which is what counts from then
//     on. A car with neither a link nor a listed price is never matched: the
//     person uses I updated it / I took it down;
//   - a sold/removed sign counts only if it appeared after the page was first
//     read, so a page that already says "sold" somewhere waits for the person.

import { markPriceUpdated, markTakenDown } from './src/rescan.js';
import { fillPriceInPage, readListingInPage } from './facebook/fillForm.js';
import { LISTING_SIGNS } from './facebook/listingSigns.js';
import { listingLink } from './facebook/detectPost.js';
import { resolveFlag, updatePilot } from './src/pilot.js';
import { siteKeys } from './src/storageKeys.js';
import { noteTakenDown } from './src/takenDown.js';
import { updateKey, storageErrorText } from './src/storage.js';
import { accountsConfigured } from './src/accountConfig.js';
import { loadSession } from './src/account.js';

export const up = {
  active: false,
  origin: null, vin: null, kind: null, price: null, listingUrl: '', name: '', listedPrice: null,
  why: '', // a take-down's reason (src/rescan.js): 'not-pre-owned' is a car not sold, so its listing is deleted
  listingId: '', // the listing's id, from its saved link or from this car's own listing page once opened (onListing)
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

// A saved link that is not a listing's own address (Your listings, saved by
// an older version or another computer) counts as no link: the person is told
// to open the listing, instead of being sent to a page with no word about it.
export async function startUpkeep(req, ctx) {
  stopPolling();
  Object.assign(up, { active: true, origin: req.origin, vin: String(req.vin || '').toUpperCase(), kind: req.kind, why: String(req.why || ''), price: req.price || null, listingUrl: listingLink(req.listingUrl, ctx.map()), name: req.name || req.vin, listedPrice: req.listedPrice || null, listingId: '', tabId: null, status: 'opening', note: '', filledShown: '', seen: null, error: '', fills: 0, baseline: null, offTarget: false });
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
  up.note = up.listingUrl ? '' : `No link to this car's own listing was saved, so this is Marketplace's Your listings page: open the listing for ${up.name} there.`;
  ctx.render();
  await sleep(1500);
  if (!up.active) return; // closed meanwhile
  poller = setInterval(() => poll(ctx).catch(() => {}), 1500);
}

// What the listing reader is told about this car's listing: its id when
// known, else its name and the prices that identify it.
const knownId = (map) => up.listingId || listingIdFrom(up.listingUrl, map.listingUrlPattern);
const expectFor = (map) => ({ id: knownId(map), name: up.name, prices: [up.listedPrice, up.price].filter((p) => typeof p === 'number' && p > 0), vin: up.vin });

// The words of a car's name as the listing reader compares them.
const nameWords = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase().split(' ').map((t) => t.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')).filter(Boolean);

// How many other cars in the posted list have every word of this car's name
// in their own: a listing of one of them shows this car's name too (a second
// 2021 Jeep Grand Cherokee Laredo, or a Wrangler Unlimited Sport for a
// Wrangler Sport), and perhaps the same price.
export function namesakesOf(posted, vin, name) {
  const mine = nameWords(name);
  if (mine.length < 2) return 0;
  const own = String(vin || '').toUpperCase();
  return Object.entries(posted && typeof posted === 'object' ? posted : {})
    .filter(([v, p]) => String(v).toUpperCase() !== own && p && mine.every((w) => nameWords(p.name).includes(w))).length;
}

// The same, from what is stored now; null when the posted list can't be read
// (onListing then asks for the VIN, as if there were one).
async function namesakesNow() {
  try {
    const k = siteKeys(up.origin).posted;
    return namesakesOf((await chrome.storage.local.get(k))[k], up.vin, up.name);
  } catch (e) {
    return null;
  }
}

// The page of an address, without its query, for comparing two addresses.
function pageOf(url) {
  try {
    const u = new URL(String(url || ''));
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch (e) {
    return '';
  }
}

// Whether what the reader saw is this car's listing. With the listing's id
// known, only its id in the address counts: a listing of another car with
// the same name never does. Without it, never the Your listings page (every
// listing's name is on it), and elsewhere every word of the name as a whole
// word plus the price it was listed at (or the new price); and when other
// posted cars carry this name too (namesakes, null when unknown), this car's
// VIN on the page as well. A car with no listed price and no id is never
// matched.
export function onListing(seen, { id = '', yourListingsUrl = '', namesakes = 0 } = {}) {
  if (!seen) return false;
  if (id) return Boolean(seen.matchesId);
  if (yourListingsUrl && pageOf(seen.url) === pageOf(yourListingsUrl)) return false;
  if (namesakes !== 0 && !seen.matchesVin) return false;
  return Boolean(seen.matchesName && seen.matchesPrice);
}

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
    const id = knownId(map);
    const namesakes = id ? 0 : await namesakesNow();
    const onTarget = onListing(seen, { id, yourListingsUrl: map.yourListingsUrl, namesakes });
    // the car's own listing page, found by its name and price: its id is what counts from now on
    if (onTarget && !id) up.listingId = listingIdFrom(seen.url, map.listingUrlPattern);
    if (!up.baseline || up.baseline.url !== seen.url) {
      // first read of this page: what it says now is the starting point, not a change
      up.baseline = { url: seen.url, sold: seen.sold, unavailable: seen.unavailable };
      if (up.status === 'filled' && up.kind === 'price' && !onTarget) up.status = 'waiting'; // moved to another page after the fill
    }
    const note = onTarget ? '' : offTargetNote(id, seen, namesakes);
    if (up.offTarget !== !onTarget || (!onTarget && up.note !== note)) {
      up.offTarget = !onTarget;
      up.note = note;
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
    // a post taken down is kept in the take-down record first
    // (src/takenDown.js; the daily cap counts it from the day's log, or from
    // this record for a post the log never had); this item came from the
    // scan (sold, gone or sale pending), so the website no longer listed the
    // car as ready
    if (!price) {
      const entry = ((await chrome.storage.local.get(k.posted))[k.posted] || {})[up.vin];
      if (entry && entry.mine !== false) await updateKey(k.takenDown, (log) => noteTakenDown(log, { vin: up.vin, postedAt: entry.postedAt, stillListed: false, listedBefore: entry.listedBefore === true }));
    }
    await updateKey(k.posted, (posted) => (price ? markPriceUpdated(posted || {}, up.vin, up.price) : markTakenDown(posted || {}, up.vin)));
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
  // signed in: the worker syncs the change, so the manager view and colleagues see it now (fire and forget; Settings shows how it went)
  if (accountsConfigured() && (await loadSession(chrome.storage.local))) chrome.runtime.sendMessage({ type: 'syncNow', origin: up.origin }).catch(() => {});
  up.status = 'done';
  up.note = how === 'detected' ? (up.kind === 'price' ? `The listing now shows ${money(up.price)}.` : 'The listing shows it as sold or removed.') : 'Marked done.';
  ctx.render();
}

// Said while the tab is not on this car's listing.
export function offTargetNote(id, seen, namesakes = 0) {
  const done = up.kind === 'price' ? 'I updated it' : 'I took it down';
  if (id) return `This tab isn't showing the listing for ${up.name}. Open that listing and Lot Current continues.`;
  if (!up.listedPrice) return `No listing link or listed price was saved for ${up.name}, so Lot Current can't tell which listing is its own and fills in or ticks off nothing. Do it on Facebook, then click ${done}.`;
  if (namesakes !== 0 && seen && seen.matchesName && seen.matchesPrice && !seen.matchesVin) {
    const why = namesakes === null ? `Lot Current couldn't read your posted cars to check whether another one is also a ${up.name}` : `Another car you posted also has ${up.name} in its name`;
    return `${why}, so a listing counts as this car's only when its page shows this car's VIN, ${up.vin}, and this page doesn't. Open this car's own listing (its description carries the VIN); if the VIN isn't on it, do it on Facebook, then click ${done}.`;
  }
  const looksFor = namesakes !== 0 ? `its full name, ${money(up.listedPrice)} and its VIN, ${up.vin}` : `its full name and ${money(up.listedPrice)}`;
  return `This tab isn't showing the listing for ${up.name}. Open its own listing page (Lot Current looks for ${looksFor}) and Lot Current continues; if it doesn't, click ${done} when you are done.`;
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
      : `<div class="banner info" id="priceWaiting">On Facebook, click <b>Edit listing</b>. As soon as the Price box appears on this car's form, Lot Current fills in <b>${money(up.price)}</b>${up.listedPrice ? ` (was ${money(up.listedPrice)})` : ''}, the price the website showed at the last scan; then you click <b>Update</b>. If the website's price may have changed since, rescan first.</div>`;
  } else {
    body = up.why === 'not-pre-owned'
      ? `<div class="banner info" id="takeDownWaiting">On Facebook, click <b>Delete</b> on this listing: the website no longer lists the car as pre-owned, and it was not sold, so do not mark it sold. Lot Current will notice and mark it done.</div>`
      : `<div class="banner info" id="takeDownWaiting">On Facebook, click <b>Mark as sold</b> (or <b>Delete</b>) on this listing. Lot Current will notice and mark it done.</div>`;
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
