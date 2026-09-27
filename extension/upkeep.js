// Listing upkeep in the side panel: a To do item (a sold car to take down, a
// price to update) opens the salesperson's own listing, the new price is put
// into the edit form's Price box as soon as it appears, and the item is
// marked done when the page shows the change (or when the person says so).
// The person clicks Edit, Update, Mark as sold or Delete; Lot Sync never does.

import { markPriceUpdated, markTakenDown } from './src/rescan.js';
import { fillPriceInPage, readListingInPage } from './facebook/fillForm.js';
import { LISTING_SIGNS } from './facebook/listingSigns.js';

export const up = {
  active: false,
  origin: null, vin: null, kind: null, price: null, listingUrl: '', name: '', listedPrice: null,
  tabId: null, status: 'idle', // idle | opening | waiting | filled | done | gone
  note: '', filledShown: '', seen: null, error: '', fills: 0,
};
let poller = null;
const MAX_FILLS = 4; // a form that is still loading can overwrite the price once or twice

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => (typeof n === 'number' && Number.isFinite(n) ? '$' + Math.round(n).toLocaleString('en-US') : '—');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stopPolling() {
  if (poller) clearInterval(poller);
  poller = null;
}

export async function startUpkeep(req, ctx) {
  stopPolling();
  Object.assign(up, { active: true, origin: req.origin, vin: String(req.vin || '').toUpperCase(), kind: req.kind, price: req.price || null, listingUrl: req.listingUrl || '', name: req.name || req.vin, listedPrice: req.listedPrice || null, tabId: null, status: 'opening', note: '', filledShown: '', seen: null, error: '', fills: 0 });
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
  up.note = up.listingUrl ? '' : "No listing link was saved for this car, so this is Marketplace's Your listings page: open the car's listing there.";
  ctx.render();
  await sleep(1500);
  poller = setInterval(() => poll(ctx).catch(() => {}), 1500);
}

// Every 1.5 s: read the tab; for a price update, fill the box when it shows
// up (again if the loading form overwrites it); for either kind, notice when
// the page shows the change.
let polling = false;
async function poll(ctx) {
  if (!up.active || !up.tabId) return stopPolling();
  if (polling) return;
  polling = true;
  try {
    const map = ctx.map();
    let seen;
    try {
      const [inj] = await chrome.scripting.executeScript({ target: { tabId: up.tabId }, func: readListingInPage, args: [map, LISTING_SIGNS] });
      seen = inj && inj.result;
    } catch (e) {
      // the tab closed, or is on a page Lot Sync may not read (outside /marketplace/)
      try { await chrome.tabs.get(up.tabId); } catch (gone) { up.status = 'gone'; stopPolling(); ctx.render(); }
      return;
    }
    if (!seen) return;
    up.seen = seen;
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
      if (seen.sold || seen.unavailable) return finish(ctx, 'detected');
    }
  } finally {
    polling = false;
  }
}

async function finish(ctx, how) {
  stopPolling();
  const k = (name) => `${name}:${up.origin}`;
  const data = await chrome.storage.local.get([k('posted'), k('diff')]);
  let posted = data[k('posted')] || {};
  const diff = data[k('diff')] || null;
  const drop = (list) => { if (diff && Array.isArray(diff[list])) diff[list] = diff[list].filter((x) => x.vin !== up.vin); };
  if (up.kind === 'price') {
    posted = markPriceUpdated(posted, up.vin, up.price);
    drop('priceUpdates');
  } else {
    posted = markTakenDown(posted, up.vin);
    drop('takeDown');
    drop('priceUpdates');
    drop('needsALook');
  }
  const save = { [k('posted')]: posted };
  if (diff) save[k('diff')] = diff;
  await chrome.storage.local.set(save);
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
      ? `<div class="banner good" id="priceFilled">New price ${money(up.price)} is in the Price box (it shows "${esc(up.filledShown)}"). Now click <b>Update</b> on Facebook. Lot Sync will notice when the listing shows the new price.</div>`
      : `<div class="banner info" id="priceWaiting">On Facebook, click <b>Edit listing</b>. As soon as the Price box appears, Lot Sync fills in <b>${money(up.price)}</b>${up.listedPrice ? ` (was ${money(up.listedPrice)})` : ''}; then you click <b>Update</b>.</div>`;
  } else {
    body = `<div class="banner info" id="takeDownWaiting">On Facebook, click <b>Mark as sold</b> (or <b>Delete</b>) on this listing. Lot Sync will notice and mark it done.</div>`;
  }
  const buttons = up.status === 'done'
    ? `<button type="button" class="primary" id="upkeepClose">Close</button>`
    : `<button type="button" class="primary" id="upkeepDoneBtn">${up.kind === 'price' ? 'I updated it' : 'I took it down'}</button><button type="button" class="plain" id="upkeepCancel">Not now</button>`;
  return `<section class="car"><div class="name">${title}</div><div class="facts">${esc(up.vin)}${up.listingUrl ? ` · <a href="${esc(up.listingUrl)}" target="_blank" rel="noopener">listing</a>` : ''}</div></section>
    ${error}${body}${note}
    <div class="actions">${buttons}</div>
    <p class="hint">Lot Sync fills in the price and reads the page; you click Edit, Update, Mark as sold or Delete. It never clicks those for you.</p>`;
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
