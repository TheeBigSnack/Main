// The guided one-click-post flow. Runs in Chrome's side panel, which stays
// open while the salesperson moves between the dealer tab and the Facebook
// tab (a popup would close).
//
// Steps: checking (fresh fetch + re-check) -> review (description, fields)
// -> filling (opens the Marketplace form, fills it, attaches photos; a car
// read more than ten minutes earlier, or one a later scan contradicts, is
// read and checked again first: carStillCurrent)
// -> publish (the salesperson checks the form and clicks Publish themselves)
// -> done (the post is recorded in the same list the popup uses).
//
// This file never clicks anything on the Facebook page.

import { markPosted, basisPrice, listingWebsitePrice, pendingText } from './src/rescan.js';
import { DECISION } from './src/classify.js';
import { draftRecord, draftPill } from './src/drafts.js';
import { shortLocation, storeNames } from './src/normalize.js';
import { readCarForPost, recheck } from './src/vehicleDetails.js';
import { readyRows, nextToPost, siteChoices, defaultOrigin, siteReadOrigins, missingOrigins, siteAskText } from './src/panelList.js';
import { SORT_ORDERS, sortOrder } from './src/readyList.js';
import { generateDescription, guessColorsWithBackend } from './src/rewriter.js';
import { runGuardrails, ruleProblems, featureChoices, settleHighlights, usableClosingLine, MAX_HIGHLIGHTS } from './src/rewriteTemplate.js';
import { usablePhotos, settlePick, togglePhoto, makeCover, pickSummary } from './src/photoPick.js';
import { buildListingData, listingChanges, normalizeColor, COLORS } from './src/listingData.js';
import { capStatus, capCount, logPost } from './src/cap.js';
import { withDefaults, loadProfile, settingsFromProfile } from './src/settings.js';
import { createQueue, currentVin, advance, pause as pauseQueue, resume as resumeQueue, describe as describeQueue } from './src/queue.js';
import { wiz, startWizard, resumeWizard, wizardHtml, handleWizardClick, handleWizardChange } from './wizard.js';
import { up, startUpkeep, endUpkeep, upkeepHtml, handleUpkeepClick, namesakesOf } from './upkeep.js';
import { localVinCheck, decodeVinOnline, compareVin, compareSummary, NHTSA_ORIGIN } from './src/vin.js';
import { neededPatterns, patternCovers, patternHost, hostList, isFacebookServer } from './src/photoHosts.js';
import { askChrome } from './src/askChrome.js';
import { FORM_MAP, applyOverrides } from './facebook/formMap.js';
import { fillFormInPage, attachPhotosInPage, probeFormInPage, readListingInPage } from './facebook/fillForm.js';
import { watchForListing, isNewListingFromForm, showsPostedCar, onCreatePage, listingLink } from './facebook/detectPost.js';
import { LISTING_SIGNS } from './facebook/listingSigns.js';
import { beginPost, notePostStep, endPost, noteFill, updatePilot } from './src/pilot.js';
import { relistNotice } from './src/takenDown.js';
import { POSTING_RULES } from './src/postingRules.js';
import { siteKeys, GLOBAL_KEYS, REQUEST_KEYS } from './src/storageKeys.js';
import { updateKey, withLock, storageErrorText } from './src/storage.js';
import { ACCOUNT, accountsConfigured } from './src/accountConfig.js';
import { currentSession, rewriteKeyFor, LAPSED_MESSAGE, LAPSED_SENTENCE } from './src/accountFlow.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => (typeof n === 'number' && Number.isFinite(n) ? '$' + Math.round(n).toLocaleString('en-US') : '—');
const miles = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') + ' mi' : 'no mileage');
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Which build produced a report: shown in the dry-run report and the pilot numbers.
const VERSION = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '';
// Facebook draws its form in the account's language; the form map is English.
const languageHint = (lang, nothingFound) => (lang && !/^en\b/i.test(lang) && nothingFound
  ? `<div class="banner warn" id="languageHint">Your Facebook is set to "${esc(lang)}". Lot Current's form map is English only for now: switch Facebook to English (Settings > Language), then try again.</div>`
  : '');

const state = {
  origin: null, vin: null, dealerTabId: null, windowId: null,
  settings: null, posted: {}, postLog: [], boilerplate: [], siteName: '',
  vehicle: null, price: null,
  readAt: null, // when the car was last read and checked on the website (READ_MAX_AGE_MS)
  opening: false, // Open the Marketplace form is running its checks (openForm): a second click meanwhile does nothing
  description: '', descriptionSource: 'template', note: '', guardrails: null,
  listing: null,
  fbTabId: null, fill: null, photos: null, detected: null, probe: null,
  listingTyped: null, // what the person typed into Listing link on this form (null: nothing): kept over every redraw, whatever the listing check offers
  vinCheck: null, // { local, online } from src/vin.js
  colorGuess: null, // { exterior, interior, confidence } from the photos, or { error }
  photoPick: null, // the salesperson's pick of this car's photos, in order (src/photoPick.js); null: the website's first ones
  highlights: null, // the salesperson's pick of this car's features for the description (rewriteTemplate.js settleHighlights); null: the usual pick
  highlightsUsed: null, // the highlights the description on screen was written with
  relist: null, // this car's take-down while the website still listed it (src/takenDown.js relistNotice): the review says so, a queue waits
  queue: null, // the batch queue (src/queue.js), shared with the popup
  queueMode: false, // this car is being posted as part of the queue
  unlinked: null, // { queue, names }: the cars this queue recorded with no listing link, said in the queue bar (the next car's steps clear the status line)
  drafts: {}, // cars the person saved as drafts on Facebook: { vin: { name, savedAt, price, basis } } (src/drafts.js)
  snapshotVehicles: {}, // names for the queue bar
  syncState: null, // this website's sync state (src/sync.js nextSyncState): the server's count of today's posts feeds the cap
  takenDown: null, // the posts this salesperson took off their posted list (src/takenDown.js): the cap still counts the day's
  sites: {}, // the site registry (src/scanRunner.js rememberSite): every website this computer has read, for the list's website choice
  siteInfo: null, // this website's registry entry: its adapter and service, so a car can be read without the dealer tab
  snapshotTakenAt: null, // when the saved snapshot behind the list was taken
  listFilter: '', // the list's search box, kept while the panel is open
  blockedOrigins: null, // the website permission a post stopped on (src/vehicleDetails.js needsPermission)
  rescanning: false,
  step: 'idle', message: '', doneAt: null,
  map: FORM_MAP,
};
let watcher = null;
// Counts the posts the panel has dropped (clearFlow: a new post, Stop queue,
// Back, Skip, a set-up). Each step of a post that waits on something (the
// website, the rewrite service, storage, the Marketplace tab) notes the count
// first and goes no further when it changed meanwhile, so a post left behind
// never writes into the post that took over, and never opens or fills a form.
let flowRun = 0;
// Fills of the Marketplace form under way (runFill, from the injection until
// it answers). A fill already sent lands in the tab whatever the panel does
// next, so a queued car's Skip this car waits for it (onClick): a form left
// filled for a car the queue moved past would never be recorded.
let fillsUnderWay = 0;

// ---------- saved data ----------
// The keys are named in src/storageKeys.js (siteKeys(origin) for this
// website's, GLOBAL_KEYS for the requests and the test hook).

// The panel's own storage writes come back through storage.onChanged like
// the popup's and the worker's; they are counted here so adoptChanges can
// tell an echo from a change made elsewhere (the pattern popup.js uses). A
// write that failed never echoes, so its note is taken back.
const ownWrites = new Map();
const noteOwn = (keys) => { for (const key of keys) ownWrites.set(key, (ownWrites.get(key) || 0) + 1); };
const isOwnEcho = (key) => {
  const n = ownWrites.get(key) || 0;
  if (!n) return false;
  if (n === 1) ownWrites.delete(key);
  else ownWrites.set(key, n - 1);
  return true;
};
async function ownSet(obj) {
  const keys = Object.keys(obj);
  noteOwn(keys);
  try {
    await chrome.storage.local.set(obj);
  } catch (e) {
    keys.forEach(isOwnEcho);
    throw e;
  }
}
async function ownRemove(keys) {
  noteOwn(keys);
  try {
    await chrome.storage.local.remove(keys);
  } catch (e) {
    keys.forEach(isOwnEcho);
    throw e;
  }
}
// Read-modify-writes of the posted list, the drafts and the queue go through
// src/storage.js under the key's lock: the popup changes all three too.
const panelStorage = { get: (key) => chrome.storage.local.get(key), set: ownSet };

// Reads the website's saved data into the panel. The website choice can move
// on while the reads run (two quick changes of the Website menu): a load for a
// website the panel no longer shows is dropped, so one website's cars, posts
// and queue never show under another. Resolves false when it was dropped.
async function loadSaved() {
  const origin = state.origin;
  const k = siteKeys(origin);
  const data = await chrome.storage.local.get([k.settings, k.snapshot, k.posted, k.postLog, k.boilerplate, k.queue, k.drafts, k.sync, k.takenDown, GLOBAL_KEYS.sites]);
  const sites = data[GLOBAL_KEYS.sites] || {};
  const siteInfo = sites[origin] || null;
  const siteName = data[k.snapshot]?.site?.name || siteInfo?.name || origin;
  const site = data[k.snapshot]?.site || { name: siteName };
  const settings = data[k.settings] ? withDefaults(data[k.settings], site) : settingsFromProfile(await loadProfile(), { ...site, origin }) || withDefaults({}, site);
  if (state.origin !== origin) return false;
  Object.assign(state, {
    sites,
    siteInfo,
    siteName,
    snapshotTakenAt: data[k.snapshot]?.takenAt || null,
    settings,
    posted: data[k.posted] || {},
    postLog: data[k.postLog] || [],
    boilerplate: data[k.boilerplate] || [],
    queue: data[k.queue] || null,
    drafts: data[k.drafts] || {},
    snapshotVehicles: data[k.snapshot]?.vehicles || {},
    syncState: data[k.sync] || null,
    takenDown: data[k.takenDown] || null,
  });
  return true;
}

const saveQueue = async () => {
  const key = siteKeys(state.origin).queue;
  try {
    if (state.queue) await ownSet({ [key]: state.queue });
    else await ownRemove([key]);
  } catch (e) {
    setStatus(storageErrorText(e), 'error');
  }
};

// What a post under way keeps across a closed panel. Not the form map: a
// reopened panel builds it from formMap.js again (resumeFlow), so nothing
// saved can change what the fill code may touch, and a map fixed in a newer
// version applies to a post saved before the update.
const FLOW_FIELDS = ['vin', 'dealerTabId', 'windowId', 'vehicle', 'price', 'priceBasis', 'readAt', 'noteApplies', 'description', 'descriptionSource', 'note', 'guardrails', 'listing', 'fbTabId', 'fill', 'photos', 'detected', 'probe', 'vinCheck', 'colorGuess', 'photoPick', 'highlights', 'highlightsUsed', 'relist', 'queueMode', 'blockedOrigins', 'step', 'message', 'doneAt', 'saveId'];

// One post is saved per website. A save never replaces the post saved there
// when that one is under way in another window's side panel (liveElsewhere),
// unless it is that very post as it stands: the same car, saved as that
// window's, and not saved again since this panel last read or saved it (a
// second window's panel showing it). Each save marks the post with a new
// saveId, so a copy shown in a second window that the first window's panel
// has saved since (it opened the car's form, say) is out of date, and
// nothing that copy saves replaces the post. Then nothing is written,
// and it resolves that post ({ where, vin, name }) so a post just starting
// or about to open its form gives way (startFlow, openForm); otherwise it
// resolves null. The check and the write run under the saved post's lock, so
// of two panels saving at once, the second sees the first's post.
async function saveFlow() {
  if (!state.origin) return null;
  const origin = state.origin;
  const run = flowRun;
  const flow = {};
  for (const f of FLOW_FIELDS) flow[f] = state[f];
  let other = null;
  try {
    await updateKey(siteKeys(origin).flow, async (saved) => {
      // the save this panel last read or made of its post: read under the
      // lock, so a save that waited for this panel's previous one counts it
      const known = run === flowRun ? state.saveId : flow.saveId;
      const samePost = Boolean(saved) && saved.vin === flow.vin && saved.windowId === flow.windowId && (saved.saveId || null) === (known || null);
      other = samePost ? null : await liveElsewhere(saved);
      if (other) return undefined;
      flow.saveId = crypto.randomUUID(); // never one an earlier save had, even of a post removed and started again
      if (run === flowRun) state.saveId = flow.saveId;
      return flow;
    }, flowStorage(origin));
  } catch (e) {
    setStatus(storageErrorText(e), 'error'); // the quota, most likely; the post goes on from what the panel holds
  }
  return other;
}

// A website's saved post is written together with that website as the one
// the panel last posted from, so a reopened panel opens on it (init).
const flowStorage = (origin) => ({ get: (key) => chrome.storage.local.get(key), set: (obj) => chrome.storage.local.set({ ...obj, [GLOBAL_KEYS.lastPostOrigin]: origin }) });

// Removes the post saved for a website, unless it is under way in another
// window's side panel (liveElsewhere): that one stays for that panel. Under
// the saved post's lock, as saveFlow writes it.
async function dropSavedFlow(origin) {
  const k = siteKeys(origin).flow;
  await withLock(k, async () => {
    const saved = (await chrome.storage.local.get(k))[k];
    if (await liveElsewhere(saved)) return;
    await chrome.storage.local.remove(k);
  });
}

// Resolves the new count (flowRun): the number of the post started next.
// keepSaved: the saved post is left as it is (it is another panel's now).
// Without it, the saved post is removed unless another window's side panel
// has it under way (dropSavedFlow).
async function clearFlow({ keepSaved = false } = {}) {
  const run = ++flowRun;
  if (watcher) watcher.cancel();
  watcher = null;
  const { vin, origin } = state;
  if (vin) await pilotNote((p) => endPost(p, vin, 'abandoned')); // only an attempt still open changes
  if (origin && !keepSaved) await dropSavedFlow(origin);
  if (run !== flowRun) return run; // cleared again meanwhile (another post started): that clear empties the state, and this one must not empty the new post's
  Object.assign(state, {
    vin: null, dealerTabId: null, windowId: null, vehicle: null, price: null, priceBasis: null, readAt: null, opening: false, description: '', descriptionSource: 'template', note: '', guardrails: null,
    listing: null, fbTabId: null, fill: null, photos: null, detected: null, listingTyped: null, probe: null, vinCheck: null, colorGuess: null, photoPick: null, highlights: null, highlightsUsed: null, relist: null, queueMode: false, blockedOrigins: null, step: 'idle', message: '', doneAt: null, saveId: null, map: FORM_MAP,
  });
  return run;
}

// Whether the post saved for this website is still this car's, or none is.
// A side panel in a second window that finds its car already recorded and
// moved on from elsewhere must not remove or overwrite the post the panel of
// the first window saved since (its next car, with its open form's tab).
async function savedFlowIs(origin, vin) {
  try {
    const k = siteKeys(origin).flow;
    const saved = (await chrome.storage.local.get(k))[k];
    return !saved || saved.vin === vin;
  } catch (e) {
    return true; // unknown: as before, this panel's
  }
}

function setStatus(text, kind = '') {
  const el = $('status');
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

// The price note describes the chosen basis. When the basis is the lower
// second price and this car has none (the main price is used), the note
// would be untrue for it, so it is left out and the car card says so.
const noteFor = () => (state.noteApplies === false ? '' : state.settings.priceNote);
const ctx = () => ({ vehicle: state.vehicle, dealer: state.settings.dealer, salesperson: state.settings.salesperson, priceNote: noteFor(), price: state.price, closingLine: usableClosingLine(state.settings.salesperson.closingLine) });

// Every description names the dealership (rule 5): with no dealership name
// set, no description can, so the form is not opened until one is.
const dealerNamed = () => Boolean(String((state.settings && state.settings.dealer && state.settings.dealer.name) || '').trim());
const NO_DEALER_TEXT = "Add your dealership's name in Settings first (Dealership name): every description names the dealership.";

// Why a description can't be typed into the form, or '' when it can. Every
// way of opening or filling the form goes through this (Open the
// Marketplace form, Open the form and check fields only, Fill it in now
// after a fields check, Fill again, a queued car's form), so none of them
// types a description that does not name the dealership (not with no name
// set, and not a description written before the name was added), or one
// that breaks any other posting rule (rewriteTemplate.js ruleProblems): a
// number, price, mileage or claim the website doesn't make, a banned phrase,
// a missing role, VIN or price note. Length, capitals and emoji only warn.
function fillBlocker(description) {
  if (!dealerNamed()) return NO_DEALER_TEXT;
  const name = String(state.settings.dealer.name).trim();
  if (!String(description || '').toLowerCase().includes(name.toLowerCase())) {
    return `The description doesn't name ${name}, and every description names the dealership. Add it to the description (or use Reset to template) before the form is filled.`;
  }
  const stops = ruleProblems(runGuardrails(description, ctx()));
  if (!stops.length) return '';
  return `The description fails ${stops.length === 1 ? 'a check' : `${stops.length} checks`} that must pass before the form is filled: ${stops.map((p) => p.text).join('; ')}. Fix the description (or use Reset to template) first.`;
}

// The description's checks, run again on the text that would be filled (the
// box's, on the review screen), with the checks line and the form buttons
// brought up to date. A text fillBlocker stops keeps the form shut, with the
// reason in the status line: Lot Current never types such a text into
// Facebook's form. Returns true when stopped.
function descriptionStopped() {
  const box = $('description');
  if (box) state.description = box.value;
  state.guardrails = runGuardrails(state.description, ctx());
  const old = $('checks');
  if (old) old.outerHTML = checksHtml(state.guardrails);
  setFormButtons();
  const why = fillBlocker(state.description);
  if (!why) return false;
  setStatus(why, 'error');
  return true;
}

// Open the Marketplace form and Check fields: off at the day's cap, while no
// dealership name is set, and while the description breaks a posting rule.
function setFormButtons(cap = dailyCap()) {
  const off = cap.reached || !dealerNamed() || ruleProblems(state.guardrails).length > 0;
  for (const id of ['openForm', 'checkForm']) {
    const b = $(id);
    if (b) b.disabled = off;
  }
}

// Pilot numbers (src/pilot.js): when each post started and ended, and what
// each fill could not do. Bookkeeping only; a failure here never stops a post.
const pilotNote = (change) => (state.origin ? updatePilot(state.origin, change).catch(() => null) : Promise.resolve(null));

// ---------- photo servers ----------
// The service worker downloads the car's photos, and Chrome lets it read a
// server only with a host permission (src/photoHosts.js). The manifest names
// one image host; for any other, Chrome's own prompt asks the salesperson the
// first time they fill a car whose photos sit there, and Chrome remembers a yes.

const MANIFEST_HOSTS = (chrome.runtime.getManifest && chrome.runtime.getManifest().host_permissions) || [];
// What Chrome has granted, kept in memory: a click must ask before it waits
// on anything, so it can't stop to look this up first.
let grantedOrigins = [];
// Servers the salesperson said no to while this panel is open. They are not
// asked about again for the next car, only from their own Allow photos button.
const refusedPhotoServers = new Set();
// A Chrome permission prompt (photos or the website) is open: other clicks wait for its answer.
let promptOpen = false;

async function refreshGranted() {
  try {
    const all = await chrome.permissions.getAll();
    grantedOrigins = all && Array.isArray(all.origins) ? all.origins : [];
  } catch (e) {
    /* keep what was known; at worst Chrome is asked for a server it already allows, and says yes without a prompt */
  }
}

// The form's photo limit: what the last fill read on the form, else the map's default.
const photoLimitNow = () => (state.fill && state.fill.photoLimit && state.fill.photoLimit.value) || state.map.photoLimitDefault;
// The limit a pick is cut to. With no pick made and no limit read from the
// form yet, none: the listing keeps every photo and attachPhotos cuts it to
// the limit the form shows (the map's default is not verified). A pick the
// salesperson made is cut to the best limit known.
const pickLimit = () => (state.photoPick === null && !(state.fill && state.fill.photoLimit) ? 0 : photoLimitNow());
// The photos the salesperson picked for this car, in order (src/photoPick.js).
const pickedPhotos = () => (state.vehicle ? settlePick(state.photoPick, state.vehicle.photos, pickLimit()) : []);
// Every photo unticked while the website has some: the form would open with none.
const noPhotosPicked = () => Boolean(state.vehicle) && !pickedPhotos().length && usablePhotos(state.vehicle.photos).length > 0;
const NO_PHOTOS_TEXT = 'No photos are ticked. Marketplace needs at least one: tick the photos to post first.';
const photoList = () => (state.listing ? state.listing.photos : pickedPhotos());
const photoPatterns = (urls = photoList()) => neededPatterns(urls, { manifestHosts: MANIFEST_HOSTS, granted: grantedOrigins });
const askSentence = (patterns) => `Chrome will ask to let Lot Current download this car's photos from ${hostList(patterns)}.`;

// Asks Chrome, in one request, for every server this car's photos sit on
// that Lot Current can't download from yet. It runs first in a click handler,
// before anything else is awaited: Chrome shows its prompt only during the
// salesperson's click, and the click stops counting after a few seconds of
// waiting. Everything it needs is in memory. again: also a server refused
// earlier (the Allow photos button). Resolves true when nothing is missing.
async function askForPhotos(urls = photoList(), { again = false } = {}) {
  const patterns = neededPatterns(urls, { manifestHosts: MANIFEST_HOSTS, granted: grantedOrigins }).filter((p) => again || !refusedPhotoServers.has(p));
  if (!patterns.length) return true;
  setStatus(askSentence(patterns));
  promptOpen = true;
  let granted = false;
  try {
    granted = await askChrome(patterns);
  } catch (e) {
    setStatus("Couldn't ask Chrome for permission: " + ((e && e.message) || e), 'error');
    return false;
  } finally {
    promptOpen = false;
  }
  await refreshGranted();
  for (const p of patterns) {
    if (granted) refusedPhotoServers.delete(p);
    else refusedPhotoServers.add(p);
  }
  setStatus('');
  return granted;
}

// After the Allow photos button: a yes attaches the photos from that server
// that were left out of the form; a no leaves things as they are.
async function afterAllowPhotos(pattern, granted) {
  const host = patternHost(pattern);
  if (!granted) {
    if (!$('status').textContent) setStatus(`Photos from ${host} were not allowed.`, 'error');
    return render();
  }
  setStatus(`Photos from ${host} are allowed.`);
  const left = state.step === 'publish' && state.photos && state.fbTabId ? state.photos.failed.filter((f) => patternCovers(pattern, f.url)).map((f) => f.url) : [];
  if (left.length) return attachPhotos(left);
  return render();
}

// ---------- the flow ----------

// How long one read of the car counts as "at post time". Past this, Open the
// Marketplace form and the dry run's Fill it in now read the car on the
// website and check it again before anything is opened or filled
// (carStillCurrent): a review left open for an hour, or one the panel
// brought back the next day, is never filled from the old read.
const READ_MAX_AGE_MS = 10 * 60 * 1000;

// The car as the website shows it now, checked again (src/vehicleDetails.js
// recheck): still there, still pre-owned and ready, still priced. Read
// through the dealer tab when the post started from one that still shows this
// website; otherwise straight from the extension, with the website
// permission (readCarForPost). A failure stops the post with the reason
// (block). Resolves { vehicle, price, noteApplies, readAt }, or null when
// stopped. Also null, with nothing changed, when the post was dropped while
// the website answered (flowRun: another car's Post, Stop queue, Skip,
// Back): neither the car nor a failure lands in the post that took over.
async function readCarNow() {
  const run = flowRun;
  const fresh = await readCarForPost({ tabId: state.dealerTabId ?? null, origin: state.origin, info: state.siteInfo, vin: state.vin, url: state.snapshotVehicles[state.vin]?.url });
  if (run !== flowRun) return null;
  if (!fresh.ok && fresh.needsPermission) {
    state.blockedOrigins = fresh.origins;
    await block(fresh.message, 'no-permission');
    return null;
  }
  if (!fresh.ok) {
    await block(fresh.message, fresh.notFound ? 'not-on-website' : 'site-unreachable');
    return null;
  }
  const check = recheck(fresh.vehicle, state.settings);
  if (!check.ok) {
    await block(check.message, 'check-' + check.assessment.decision);
    return null;
  }
  // the store label the popup shows: settled over the lot's store names, not the adapter's brand-word guess for one record
  fresh.vehicle.locationShort = shortLocation(fresh.vehicle.location, storeNames(Object.values(state.snapshotVehicles)));
  const price = basisPrice(fresh.vehicle, state.settings.basis); // the lower second price only when this car shows one
  if (!price) {
    await block("The website shows no price for this car right now, so it can't be posted.", 'no-price');
    return null;
  }
  // the basis the price was taken on, kept with it: the post is recorded on it (confirmPosted), whatever Settings says by then
  return { vehicle: fresh.vehicle, price, priceBasis: state.settings.basis === 'beforeFees' ? 'beforeFees' : 'website', noteApplies: !(state.settings.basis === 'beforeFees' && price === fresh.vehicle.price), readAt: new Date().toISOString() };
}

function takeCar(car) {
  state.vehicle = car.vehicle;
  state.vinCheck = { local: localVinCheck(car.vehicle), online: null };
  state.price = car.price;
  state.priceBasis = car.priceBasis;
  state.noteApplies = car.noteApplies;
  state.readAt = car.readAt;
}

// No time recorded (a post saved before reads were timed) counts as old, and
// so does a read that a scan since then contradicts: the car is not in it
// (sold, or taken off the website meanwhile), or it is there with another
// price, second price, status, availability or inventory type than the read
// gave. The read again decides.
function readIsOld() {
  const readAt = Date.parse(state.readAt || '');
  if (!(Date.now() - readAt < READ_MAX_AGE_MS)) return true;
  if (!(Date.parse(state.snapshotTakenAt || '') > readAt)) return false;
  const listed = (state.snapshotVehicles || {})[state.vin];
  if (!listed) return true;
  const v = state.vehicle || {};
  const same = (a, b) => (a ?? null) === (b ?? null);
  return !(same(listed.price, v.price) && same(listed.priceBeforeFees, v.priceBeforeFees) && same(listed.status, v.status) && same(listed.availability, v.availability) && same(listed.type, v.inventoryType));
}

// What the form would get from the car as it stands: every field but the
// description (the person's own text), and the photos in order.
function formValues() {
  return buildListingData(state.vehicle, { dealer: state.settings.dealer, defaults: state.settings.defaults, guesses: state.colorGuess, description: '', price: state.price, photos: pickedPhotos(), stores: state.settings.myStores });
}

// Before Open the Marketplace form or Fill it in now: with a read older than
// READ_MAX_AGE_MS, the car is read and checked on the website again. A car
// that sold, turned new, went sale-pending or lost its price stops here
// (block says why). The description's checks run again against the new read
// too. A car whose price or any form value changed, or whose description
// now breaks a posting rule (a fact the website no longer gives, such as the
// Carfax one-owner flag or a feature's number, with every form value the
// same), goes back to the review screen with the new values and checks, and
// the status line says what changed and what to fix: the person sees it
// before anything is filled. A post dropped during the read (readCarNow)
// goes no further. Resolves true to go on.
async function carStillCurrent() {
  if (!readIsOld()) return true;
  const run = flowRun;
  const was = state.step;
  const before = { price: state.price, values: formValues() };
  state.step = 'checking';
  state.message = 'Checking the car on the website again before the form opens…';
  setStatus('');
  render();
  const car = await readCarNow();
  if (!car) return false;
  const online = state.vinCheck && state.vinCheck.online;
  takeCar(car);
  const after = formValues();
  const labels = Object.fromEntries(state.map.fields.map((f) => [f.key, f.label]));
  const changed = listingChanges(before.values, after).map((c) => c.key); // every form field but the description (src/listingData.js)
  if (before.values.photos.join(' ') !== after.photos.join(' ')) changed.push('photos');
  state.guardrails = runGuardrails(state.description, ctx());
  const stops = ruleProblems(state.guardrails);
  state.message = '';
  if (!changed.length && !stops.length) {
    if (state.vinCheck && online) state.vinCheck.online = online; // the same car: the NHTSA comparison still stands
    state.step = was;
    await saveFlow();
    return run === flowRun; // false when the post was dropped while it saved
  }
  const said = changed.map((k) => (k === 'price' ? `price ${money(before.price)} to ${money(state.price)}` : k === 'photos' ? 'photos' : (labels[k] || k).toLowerCase()));
  state.listing = null;
  state.step = 'review';
  render();
  const what = said.length ? ` (${said.join(', ')})` : '';
  const next = stops.length
    ? ` The description no longer matches it: ${stops.map((p) => p.text).join('; ')}. Fix the description, then click Open the Marketplace form again.`
    : ' Check the review, then click Open the Marketplace form again.';
  setStatus(`The website changed this car since it was read${what}.${next}`, 'error');
  await saveFlow();
  return false;
}

// A car marked as posted meanwhile (from the panel's own list while a queue
// was paused, from the popup, or on another computer through the sync) never
// gets a second form. It is checked when the post starts and again, from
// what is stored then, before the form opens or the dry run's form is filled:
// a queued car is skipped, a single post stops.
async function stopPosted() {
  const name = nameOf(state.vin);
  if (state.queueMode) {
    await afterQueueStep('skipped');
    if (state.step === 'idle' || state.step === 'queueDone') setStatus(`${name} is already marked as posted, so the queue skipped it.`);
    return undefined;
  }
  await clearFlow();
  setStatus(`${name} is already marked as posted on this website, so it isn't posted again. Its listing is under My listings in the popup.`);
  return render();
}

async function startFlow(req) {
  await chrome.storage.local.remove(GLOBAL_KEYS.postRequest);
  // a post from this website (this car's or another's) is under way in another window's side panel: none is started (and that saved post not removed) here
  const elsewhere = await postElsewhere(req.origin);
  if (elsewhere) {
    setStatus(elsewhereText(elsewhere, String(req.vin || '').toUpperCase()), 'error');
    return render();
  }
  endUpkeep(); // a waiting upkeep must not keep polling and redrawing over a post
  // This post's number: another post started, Stop queue, Skip or Back
  // changes it, and this one then stops at its next step (flowRun).
  const run = await clearFlow();
  const dropped = () => run !== flowRun;
  if (dropped()) return undefined;
  state.origin = req.origin;
  state.vin = String(req.vin || '').toUpperCase();
  state.dealerTabId = req.dealerTabId;
  state.windowId = req.windowId || null;
  state.queueMode = Boolean(req.queue);
  await loadSaved();
  if (dropped()) return undefined;
  if (state.posted[state.vin]) return stopPosted();
  if (!state.settings.rulesReadAt) {
    // The posting rules come before the first post from this website. Set-up
    // shows them; whoever skipped it reads and ticks them here, and the post
    // (or the queue) goes on from the tick (acceptRules).
    state.step = 'rules';
    setStatus('');
    return render();
  }
  await refreshGranted(); // current before canAutoOpen below looks at the photo servers
  if (dropped()) return undefined;
  state.step = 'checking';
  setStatus('');
  render();
  // Saved from the start of the check, as this window's: a side panel in
  // another window sees the post from now on (postElsewhere) and starts none
  // from this website. One that saved its own first wins (saveFlow), and this
  // one gives way.
  const taken = await saveFlow();
  if (dropped()) return undefined;
  if (taken) return giveWay(taken, { began: false });
  await pilotNote((p) => beginPost(p, { vin: state.vin, name: nameOf(state.vin), salesperson: state.settings.salesperson.name, queue: state.queueMode }));
  if (dropped()) return undefined;

  const car = await readCarNow();
  if (!car) return undefined; // stopped, and block() says why
  takeCar(car);

  // taken down by this person while the website still listed it: possibly a delete and repost (posting rule 3)
  state.relist = relistNotice(state.takenDown, state.vin);
  state.message = 'Writing the description…';
  render();
  await maybeGuessColors();
  if (dropped()) return undefined;
  await generate();
  if (dropped()) return undefined;
  state.step = 'review';
  state.message = '';
  render();
  const lost = await saveFlow(); // another window's side panel took this website's saved post meanwhile: that post goes on there, not this one
  if (dropped()) return undefined;
  if (lost) return giveWay(lost);
  await pilotNote((p) => notePostStep(p, state.vin, 'reviewedAt'));
  if (dropped()) return undefined;
  // In a queue, a car that passes every check goes straight to the form;
  // one with a warning waits here so the person sees it.
  if (state.queueMode && canAutoOpen()) await openForm();
}

// The day's cap for this salesperson: this machine's posts (those taken down
// or unmarked since included: the day's log, with the posts the take-down
// record holds that the log never had), after a sync the server's count of
// theirs across their machines, and the forms saved as drafts today that are
// not marked posted yet (src/cap.js).
const dailyCap = () => capStatus(state.posted, state.settings.dailyCap, new Date(), { log: state.postLog, takenDown: state.takenDown, serverCount: state.syncState && state.syncState.postsToday, drafts: state.drafts });

// Anything assumed besides the dealership's own defaults (a reading of the
// website's words, a colour guessed from the photos, a motorcycle read from
// the make) holds a queued car at review, where the assumed list is shown.
function canAutoOpen() {
  if (!state.guardrails || !state.guardrails.ok) return false;
  if (state.relist) return false; // the person sees the take-down notice first
  if (state.vinCheck && state.vinCheck.local && !state.vinCheck.local.ok) return false;
  const listing = currentListing();
  const blockers = listing.missing.filter((k) => !['titleStatus', 'cleanTitle'].includes(k));
  if (blockers.length) return false;
  if ((listing.assumed || []).some((a) => !['condition', 'titleStatus'].includes(a.key))) return false;
  // the website's own text mentions a branded title: a person picks the title on the form
  if (listing.branded) return false;
  // Chrome asks for a new photo server only from a click: the car waits for Open the Marketplace form
  if (photoPatterns().some((p) => !refusedPhotoServers.has(p))) return false;
  return !dailyCap().reached;
}

// ---------- the queue ----------

const nameOf = (vin) => (state.snapshotVehicles[vin] && state.snapshotVehicles[vin].name) || vin;

async function startNextInQueue() {
  const q = state.queue;
  const vin = currentVin(q);
  if (!vin) return;
  const cap = dailyCap();
  if (cap.reached) {
    state.queue = pauseQueue(q);
    await saveQueue();
    await clearFlow();
    setStatus(`Daily post cap reached (${capCount(cap)}). The queue is paused until tomorrow; the dealer can change the cap in Settings.`, 'error');
    render();
    return;
  }
  // the tab the queue was started from (the popup's), never one an earlier post or to-do item left behind.
  // The car is this panel's, the one walking the queue: a queue made in
  // another window (or before Chrome restarted) and continued here records
  // its posts by itself here (postsWindow), not only in the window it was made in.
  await startFlow({ origin: state.origin, vin, dealerTabId: q.dealerTabId ?? null, windowId: panelWindowId || q.windowId || state.windowId, queue: true });
}

// Records how this car ended and moves on: the next car, a pause, or the end.
// The queue is advanced from what is stored, under its lock: the popup may
// have stopped it (or paused it) while this car was on the form, and a stale
// copy must not bring it back. It moves only while it is still on the car
// this panel finished (vin): when it has moved on already (a second confirm
// of the same car, or the side panel in another window), nothing is recorded
// against the next car and the next car is not started a second time.
// Resolves false only when the queue could not be saved: it stays on this
// car, and the button that called it can be clicked again.
let advancing = false;
async function afterQueueStep(outcome, vin = state.vin) {
  if (advancing) return undefined; // the watcher and a click on the same car advance once
  advancing = true;
  let startNext = false;
  try {
    if (watcher) watcher.cancel();
    if (vin) await pilotNote((p) => endPost(p, vin, outcome)); // a no-op for a car already recorded as posted or drafted
    let stored;
    let moved = false;
    try {
      stored = await updateKey(siteKeys(state.origin).queue, (q) => {
        if (!q) return undefined;
        moved = Boolean(vin) && currentVin(q) === vin;
        return advance(q, outcome, vin);
      }, panelStorage);
    } catch (e) {
      setStatus(storageErrorText(e), 'error'); // the queue stays where it is; the button can be clicked again
      return false;
    }
    if (stored && !moved) {
      state.queue = stored;
      if (state.vin !== vin) return; // this panel is on another car already: it stays on it
      // the panel that moved the queue on (another window's) may have saved its next car since: that stays
      await clearFlow({ keepSaved: !(await savedFlowIs(state.origin, vin)) });
      state.step = stored.status === 'done' ? 'queueDone' : 'idle';
      setStatus(`The queue had already moved on from ${nameOf(vin)}, so nothing more was recorded for it here.`);
      render();
      return;
    }
    if (!stored) {
      state.queue = null;
      await clearFlow();
      state.step = 'idle';
      setStatus('The queue was stopped from the popup. Posted cars stay recorded.');
      render();
      return;
    }
    state.queue = stored;
    const next = currentVin(state.queue);
    startNext = Boolean(next && state.queue.status === 'running');
    if (!startNext) {
      await clearFlow();
      state.step = state.queue && state.queue.status === 'done' ? 'queueDone' : 'idle';
      setStatus('');
      render();
    }
  } finally {
    advancing = false; // released before the next car's flow, whose own end must be able to advance
  }
  if (startNext) await startNextInQueue(); // the next car's own outcome is not this car's
  return undefined;
}

// The draft keeps the price the form was filled with: the listing published
// from it later shows that price, so Mark posted records it (src/drafts.js).
// Like It's posted, once per post (confirmedRun) and only from the publish
// step, for the car captured here: a second click while the next car comes
// up records nothing against the next car and starts nothing twice.
async function savedDraft() {
  const run = flowRun;
  if (state.step !== 'publish' || !state.vehicle || confirmedRun === run) return undefined;
  confirmedRun = run;
  const { vin, vehicle, origin, price } = state;
  // on the basis its price was read under (a post saved before that was kept goes by the setting)
  const record = draftRecord({ name: vehicle.name, price, basis: state.priceBasis || state.settings.basis, savedAt: new Date().toISOString() });
  try {
    // added to the list as it is stored now: the popup may have changed it meanwhile
    state.drafts = await updateKey(siteKeys(origin).drafts, (fresh) => ({ ...(fresh || {}), [vin]: record }), panelStorage);
  } catch (e) {
    confirmedRun = -1; // not saved: the button can be clicked again
    setStatus(storageErrorText(e), 'error');
    return undefined;
  }
  await pilotNote((p) => endPost(p, vin, 'draft'));
  if (run !== flowRun) return undefined; // dropped meanwhile: the draft is kept, and the post now under way is not touched
  if ((await afterQueueStep('draft', vin)) === false) confirmedRun = -1; // the queue could not be saved: clicking again moves it
  return undefined;
}

// Which queue a note belongs to: a new queue (or none) shows none of the last one's.
const queueKey = (q) => (q ? String(q.startedAt || (q.vins || []).join(',')) : '');

function queueBar() {
  const q = state.queue;
  if (!q) return '';
  const unlinked = state.unlinked && state.unlinked.queue === queueKey(q) ? state.unlinked.names : [];
  const note = unlinked.length
    ? `<p class="hint" id="queueUnlinked">No listing link was saved for ${esc(unlinked.join(', '))}: the address in Listing link wasn't a Marketplace listing's own address. ${unlinked.length === 1 ? 'Its' : 'Their'} To do items open Your listings, where you pick the listing.</p>`
    : '';
  const next = currentVin(q);
  const active = state.queueMode && state.vin && state.step !== 'idle' && state.step !== 'queueDone';
  let buttons = '';
  if (q.status === 'done') {
    buttons = `<button type="button" class="plain" id="queueClear">Clear queue</button>`;
  } else {
    if (!active && !formOpen() && next && q.status === 'running') buttons += `<button type="button" class="primary" id="queueNext">Post next car</button>`;
    buttons += q.status === 'running' ? `<button type="button" class="plain" id="queuePause">Pause</button>` : `<button type="button" class="plain" id="queueResume">Resume</button>`;
    if (next) buttons += `<button type="button" class="plain" id="queueSkip">Skip this car</button>`;
    buttons += `<button type="button" class="plain" id="queueStop">Stop queue</button>`;
  }
  return `<div class="banner info queuebar" id="queueBar"><b>${esc(describeQueue(q))}</b>${next && !active ? ` · next: ${esc(nameOf(next))}` : ''}${note}<div class="actions">${buttons}</div></div>`;
}

function viewQueueDone() {
  return `<div class="banner good" id="queueDone">${esc(describeQueue(state.queue))}. Posted cars are under <b>My listings</b> in the popup; drafts are on Facebook under your listings, and show as "Draft on Facebook" on the Ready tab until you mark them posted.</div>`;
}

// code: a short reason for the pilot numbers (the message is for the person).
async function block(message, code = 'blocked') {
  state.step = 'blocked';
  state.message = message;
  render();
  await saveFlow();
  await pilotNote((p) => endPost(p, state.vin, 'blocked', { reason: code }));
}

async function resumeFlow(origin, flow) {
  state.origin = origin;
  for (const f of FLOW_FIELDS) if (f in flow) state[f] = flow[f];
  const devOverrides = (await chrome.storage.local.get(GLOBAL_KEYS.devOverrides))[GLOBAL_KEYS.devOverrides]; // test hook: addresses and timings only, see formMap.js
  state.map = applyOverrides(FORM_MAP, devOverrides);
  await loadSaved();
  if (state.step === 'checking' || state.step === 'filling') state.step = state.vehicle ? 'review' : 'idle';
  // a listing the panel had not finished reading (the panel closed during the
  // read, or a post saved by an older version) says nothing until it is read
  // again: the watcher below reports it again while the tab still shows it
  const d = state.detected;
  if (d && d.status === 'listing' && !d.verified && !d.unverified) state.detected = null;
  render();
  // A side panel opened in a second window shows the same post with its
  // buttons and watches the same tab, so its It's posted knows the listing's
  // link too; only the panel of the post's own window records it by itself
  // (startWatcher, postsWindow).
  if (state.step === 'publish' && state.fbTabId) startWatcher();
}

// Which colors the website gives no usable word for (blank, or a word that is
// neither on Facebook's list nor one of listingData.js's shade names, like
// "Titanium").
function colorsNeeded() {
  const v = state.vehicle || {};
  return { exterior: !normalizeColor(v.exteriorColor), interior: !normalizeColor(v.interiorColor) };
}

// Ask the rewrite service to read the colors off the photos. Only when the
// service is on and a color is missing (or on the button); shown as a guess.
async function maybeGuessColors(force = false) {
  const base = state.settings.rewrite;
  const need = colorsNeeded();
  if (!base.enabled || !base.endpoint || !state.vehicle) return;
  if (!need.exterior && !need.interior && !force) return;
  const photos = (state.vehicle.photos || []).slice(0, 4);
  if (!photos.length) {
    state.colorGuess = { error: 'no photos to look at' };
    return;
  }
  const run = flowRun;
  const rw = await rewriteWithKey(base);
  let guess;
  try {
    const r = await guessColorsWithBackend({ endpoint: rw.endpoint, key: rw.key, photos, options: COLORS, origin: state.origin }); // the origin tells the service which store this is
    guess = r.ok ? { exterior: need.exterior ? r.exterior : '', interior: need.interior ? r.interior : '', confidence: r.confidence, model: r.model } : { error: r.error };
  } catch (e) {
    guess = { error: String((e && e.message) || e) };
  }
  if (run === flowRun) state.colorGuess = guess; // a dropped post's guess never lands in the next car's
}

// The rewrite settings as the writer should use them. Signed in, with the
// account's own rewrite function as the address, the session's token is the
// key: read from chrome.storage.local here, at call time, and never written
// into the settings or the synced profile (src/accountFlow.js rewriteKeyFor).
// Any other address keeps the key typed in Settings, and with no account
// server configured this is the settings' own rewrite block, untouched.
async function rewriteWithKey(rewrite) {
  const rw = rewrite || {};
  if (!accountsConfigured() || !rw.enabled || !rw.endpoint) return rw;
  const s = await currentSession({ config: ACCOUNT, storage: chrome.storage.local });
  return { ...rw, key: rewriteKeyFor({ rewrite: rw, session: s.ok ? s.session : null, config: ACCOUNT }) };
}

// The description is written from the website's record only (CLAUDE.md
// rule 6). A colour guessed from the photos goes on the form's colour
// fields, listed there as assumed, and never into the text as a fact.
async function generate({ useClaude } = {}) {
  const run = flowRun;
  const s = state.settings;
  const rewrite = await rewriteWithKey(useClaude === undefined ? s.rewrite : { ...s.rewrite, enabled: useClaude });
  if (run !== flowRun) return;
  const settings = { ...s, rewrite };
  const r = await generateDescription({ vehicle: state.vehicle, dealer: s.dealer, salesperson: s.salesperson, priceNote: noteFor(), price: state.price, boilerplate: state.boilerplate, settings, origin: state.origin, highlights: state.highlights }); // the origin tells the service which store this is
  if (run !== flowRun) return; // a dropped post's text never lands in the next car's
  state.highlightsUsed = settleHighlights(state.highlights, state.vehicle.features);
  state.description = r.text;
  state.descriptionSource = r.source;
  // the function's 402 (the dealership's plan has lapsed) arrives as the service's error text: said plainly, not as a service hiccup
  state.note = r.note && r.note.includes(LAPSED_MESSAGE) ? `${LAPSED_SENTENCE}. The template is shown instead.` : (r.note || '');
  state.guardrails = r.guardrails;
}

function waitForTabLoad(tabId, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpdated); reject(new Error('The Marketplace page took too long to load.')); }, timeoutMs);
    function onUpdated(id, info) {
      if (id !== tabId || info.status !== 'complete') return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((t) => { if (t && t.status === 'complete') onUpdated(tabId, { status: 'complete' }); }).catch(() => {});
  });
}

// The posted list and the day's counts the cap reads, as they are now: the
// popup may have marked cars meanwhile, and a sync may have counted more
// (posts from the person's other computers). Read before a form is opened
// and before the dry run's form is first filled. False when the post was
// dropped meanwhile (nothing of it is taken then).
async function readStoredCounts() {
  const run = flowRun;
  const k = siteKeys(state.origin);
  const fresh = await chrome.storage.local.get([k.posted, k.postLog, k.takenDown, k.sync, k.drafts]);
  if (run !== flowRun) return false;
  state.posted = fresh[k.posted] || state.posted;
  state.postLog = fresh[k.postLog] || state.postLog;
  state.takenDown = fresh[k.takenDown] || state.takenDown;
  state.syncState = fresh[k.sync] || state.syncState;
  state.drafts = fresh[k.drafts] || state.drafts;
  return true;
}

// probeOnly: open the form and only report which fields can be found (the
// first-run dry run); otherwise open it and fill it in.
// One form per click: the checks below can take a trip to the website (the
// car read again) while the button is still on screen, so a second click
// then does nothing, and neither does one that lands once the form is open.
async function openForm({ probeOnly = false } = {}) {
  if (state.opening || state.step === 'filling' || state.step === 'publish') return undefined;
  const run = flowRun;
  const dropped = () => run !== flowRun; // the post was dropped meanwhile: no tab for it, nothing filled
  state.opening = true;
  try {
    if (!(await readStoredCounts()) || dropped()) return undefined;
    if (state.posted[state.vin]) return stopPosted();
    const cap = dailyCap();
    if (cap.reached) {
      setStatus(`Daily post cap reached (${capCount(cap)}). It resets tomorrow; the dealer can change it in Settings.`, 'error');
      return undefined;
    }
    if (descriptionStopped()) return undefined;
    if (!(await carStillCurrent()) || dropped()) return undefined;
    // its post went on in another window's side panel meanwhile (that panel opened the form, say), or another car's from this website did: no form here
    const elsewhere = await postElsewhere(state.origin);
    if (dropped()) return undefined;
    if (elsewhere) {
      setStatus(elsewhereText(elsewhere, state.vin), 'error');
      return undefined;
    }
  } finally {
    // released before the step below moves on, with no wait in between; a
    // post dropped meanwhile leaves it to clearFlow, so the next car's own
    // open (a queue's, as soon as its car is read) is not turned away by this one
    if (!dropped()) state.opening = false;
  }
  // The form opens in this panel's window, so the post is this panel's from
  // now on (postsWindow): a post brought back here from another window, or
  // from before Chrome restarted, is recorded by itself here, and saved as
  // this window's before the form opens.
  const before = { windowId: state.windowId, listing: state.listing, listingTyped: state.listingTyped };
  state.windowId = panelWindowId || state.windowId;
  state.listing = buildListingData(state.vehicle, { dealer: state.settings.dealer, defaults: state.settings.defaults, guesses: state.colorGuess, description: state.description, price: state.price, photos: pickedPhotos(), stores: state.settings.myStores });
  state.listingTyped = null; // a new form: nothing typed for it yet
  state.step = 'filling';
  state.message = 'Opening the Marketplace form in a new tab…';
  setStatus('');
  render();
  // saved as this window's before the form opens, unless another window's
  // side panel saved a post under way from this website since the check
  // above: then no form opens, and the review stays as it was
  const taken = await saveFlow();
  if (dropped()) return;
  if (taken) {
    Object.assign(state, before, { step: 'review', message: '' });
    setStatus(elsewhereText(taken, state.vin), 'error');
    render();
    return;
  }
  await pilotNote((p) => notePostStep(p, state.vin, 'formOpenedAt'));
  if (dropped()) return;
  try {
    const devOverrides = (await chrome.storage.local.get(GLOBAL_KEYS.devOverrides))[GLOBAL_KEYS.devOverrides]; // test hook: addresses and timings only, see formMap.js
    if (dropped()) return;
    state.map = applyOverrides(FORM_MAP, devOverrides);
    const tab = await chrome.tabs.create({ url: state.map.createUrl, active: true });
    if (dropped()) return; // the tab stays empty
    state.fbTabId = tab.id;
    await waitForTabLoad(tab.id);
    if (dropped()) return;
    await sleep(state.map.settleMs ?? FORM_MAP.settleMs);
    if (dropped()) return;
    if (probeOnly) await runProbe();
    else await runFill({ opened: true });
  } catch (e) {
    if (dropped()) return;
    state.step = 'review';
    state.message = '';
    setStatus(String((e && e.message) || e), 'error');
    render();
    await saveFlow();
  }
}

// The page an address shows, without its query: origin and path.
function pageOf(url) {
  try {
    const u = new URL(String(url || ''));
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch (e) {
    return '';
  }
}

// Whether the post's Marketplace tab still shows its form, read just before
// anything is typed or attached into a form that was opened earlier (Fill
// again, Fill it in now, each batch of photos, Allow photos). The tab is an
// ordinary tab: the person can move it to a listing or another listing's
// edit form, and a tab id kept from before Chrome restarted can name another
// tab. The form is the map's create page, or the page this post's fill or
// dry run found the form's fields on. Nothing is typed or attached elsewhere.
async function formTabShows(tabId) {
  if (typeof tabId !== 'number') return false;
  let url = '';
  try {
    const tab = await chrome.tabs.get(tabId);
    url = (tab && tab.url) || '';
  } catch (e) {
    return false;
  }
  if (!url) return false;
  if (onCreatePage(url, state.map.createUrl)) return true;
  const fill = state.fill && ((state.fill.filled || []).length || (state.fill.partial || []).length) ? state.fill.url : '';
  const probe = state.probe && (state.probe.found || []).length ? state.probe.url : '';
  return [fill, probe].map(pageOf).filter(Boolean).includes(pageOf(url));
}
const FORM_GONE_TEXT = "Nothing was filled: the tab Lot Current opened for this car no longer shows its Marketplace form. Go back to the form in that tab, then try again.";

// opened: the form was opened for this car a moment ago (openForm), and is
// filled as it loaded; any later fill checks the tab first (formTabShows).
// photos: false for Fill again, which fills the fields only. The photos sent
// earlier are still on the form, and each change of its photo box adds to
// what is there, so sending them again would put every photo on it twice
// (Attach photos again does that, on the person's word).
// Every fill, Fill again included, first reads the car again when its
// last read is old (carStillCurrent) and goes through fillBlocker: nothing
// is typed from an old read, or with a description that breaks a posting rule.
async function runFill({ opened = false, photos = true } = {}) {
  const run = flowRun;
  const { map, listing } = state;
  const tabId = state.fbTabId;
  if (!opened && !(await formTabShows(tabId))) {
    if (run === flowRun) setStatus(FORM_GONE_TEXT, 'error');
    return undefined;
  }
  if (run !== flowRun || state.fbTabId !== tabId) return undefined;
  if (!(await carStillCurrent()) || run !== flowRun || state.fbTabId !== tabId) return undefined;
  const blocked = fillBlocker(listing && listing.fields && listing.fields.description);
  if (blocked) {
    if (state.step === 'filling') {
      state.step = 'review';
      state.message = '';
      render();
    }
    return setStatus(blocked, 'error');
  }
  state.message = 'Filling in the form…';
  render();
  let fill;
  fillsUnderWay += 1;
  try {
    const [inj] = await chrome.scripting.executeScript({ target: { tabId }, func: fillFormInPage, args: [state.map, { fields: state.listing.fields, match: state.listing.match || {} }] });
    fill = (inj && inj.result) || { filled: [], partial: [], blocked: [], photoLimit: { value: map.photoLimitDefault, verified: false } };
  } catch (e) {
    // e.g. no permission for this page: the form is open, so let the salesperson copy everything by hand
    fill = {
      filled: [], partial: [],
      blocked: map.fields.map((f) => ({ key: f.key, label: f.label, value: listing.fields[f.key] || '', reason: "couldn't run on this page: " + ((e && e.message) || e) })),
      photoLimit: { value: map.photoLimitDefault, verified: false },
    };
  } finally {
    fillsUnderWay -= 1;
  }
  if (run !== flowRun || state.fbTabId !== tabId) return; // the post was dropped while the form filled: nothing of it lands in the next car's, and no photos follow
  state.fill = fill;
  state.step = 'publish';
  state.detected = null;
  state.message = '';
  render();
  await saveFlow();
  if (run !== flowRun) return;
  await pilotNote((p) => notePostStep(noteFill(p, { vin: state.vin, fill: state.fill, mapVersion: state.map.version, version: VERSION }), state.vin, 'filledAt'));
  if (run !== flowRun) return;
  startWatcher();
  if (photos) await attachPhotos();
}

// Fill it in now, on the form the dry run opened: the same checks as Open
// the Marketplace form before anything is typed, the car's read included,
// whether it was marked as posted meanwhile (stopPosted), and the day's cap
// as it is now. The dry run may have been opened under the cap and left
// open (or brought back the next day) while posts were recorded elsewhere:
// a form first filled at the cap is a post over it.
async function fillFromProbe() {
  if (!(await readStoredCounts())) return undefined;
  if (state.posted[state.vin]) return stopPosted();
  const cap = dailyCap();
  if (cap.reached) {
    setStatus(`Daily post cap reached (${capCount(cap)}). It resets tomorrow; the dealer can change it in Settings.`, 'error');
    return render();
  }
  if (descriptionStopped()) return undefined;
  if (!(await carStillCurrent())) return undefined;
  return runFill();
}

// Read-only: which fields the map can find on the open page. Nothing is filled.
async function runProbe() {
  const run = flowRun;
  const { map } = state;
  state.step = 'filling';
  state.message = 'Checking the form (nothing is filled)…';
  render();
  let probe;
  try {
    const [inj] = await chrome.scripting.executeScript({ target: { tabId: state.fbTabId }, func: probeFormInPage, args: [state.map] });
    probe = { ...((inj && inj.result) || { error: 'no result came back', found: [], missing: [], controls: [] }), extensionVersion: VERSION };
  } catch (e) {
    probe = {
      error: "couldn't run on this page: " + ((e && e.message) || e),
      found: [], controls: [],
      missing: map.fields.map((f) => ({ key: f.key, label: f.label, patterns: f.name })),
    };
  }
  if (run !== flowRun) return;
  state.probe = probe;
  state.step = 'probe';
  state.message = '';
  render();
  await saveFlow();
}

// only: photos to try again (after Allow photos), added to what is already
// attached; otherwise the car's photos up to the form's limit. again: the
// person's Attach photos again, which adds every photo once more; when some
// were attached before, the photos section says each may now be on the
// form twice (photosHtml). Each batch
// goes to the tab this run began with, only while it still shows the form
// (formTabShows), and only while this run's photo count is still the one on
// screen: a post dropped, Attach photos again or It didn't post meanwhile ends it.
async function attachPhotos(only = null, { again = false } = {}) {
  const run = flowRun; // the post was dropped meanwhile: no more photos, and nothing written into the next car's post
  const tabId = state.fbTabId;
  const limit = (state.fill && state.fill.photoLimit && state.fill.photoLimit.value) || state.map.photoLimitDefault;
  let urls = state.listing.photos.slice(0, limit);
  if (only && state.photos) {
    urls = urls.filter((u) => only.includes(u));
    Object.assign(state.photos, { failed: state.photos.failed.filter((f) => !urls.includes(f.url)), done: false, error: null });
  } else {
    const before = state.photos;
    state.photos = { total: state.listing.photos.length, limit, verified: Boolean(state.fill && state.fill.photoLimit && state.fill.photoLimit.verified), attached: 0, failed: [], done: false, error: null, again: Boolean(again && before && (before.again || before.attached > 0 || !before.done)) }; // some attached before, or a run still sending them
  }
  // A server the salesperson said no to is not downloaded from: its photos
  // are recorded as failed like any other, and the photos section names the
  // server with a button that asks again.
  const refused = photoPatterns(urls).filter((p) => refusedPhotoServers.has(p));
  const isRefused = (u) => refused.some((p) => patternCovers(p, u));
  for (const url of urls.filter(isRefused)) state.photos.failed.push({ url, error: 'not allowed in Chrome', refused: true });
  urls = urls.filter((u) => !isRefused(u));
  // Nor from Facebook's own servers, which Lot Current never reads from
  // (src/photoHosts.js): those photos are left out and said so.
  const fromFacebook = (u) => isFacebookServer(u);
  for (const url of urls.filter(fromFacebook)) state.photos.failed.push({ url, error: "on Facebook's servers", facebook: true });
  urls = urls.filter((u) => !fromFacebook(u));
  const mine = state.photos;
  const current = () => run === flowRun && state.photos === mine && state.fbTabId === tabId;
  render();
  for (let i = 0; i < urls.length && !mine.error; i += 4) {
    const batch = urls.slice(i, i + 4);
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'downloadPhotos', urls: batch, offset: i });
    } catch (e) {
      if (!current()) return;
      mine.error = 'Downloading photos failed: ' + ((e && e.message) || e);
      break;
    }
    if (!current()) return;
    const photos = (res && res.photos) || [];
    for (const p of photos.filter((p) => !p.ok)) mine.failed.push({ url: p.url, error: p.error });
    const good = photos.filter((p) => p.ok).map(({ name, type, dataUrl }) => ({ name, type, dataUrl }));
    if (good.length) {
      const onForm = await formTabShows(tabId);
      if (!current()) return;
      if (!onForm) {
        mine.error = "The tab no longer shows this car's Marketplace form, so the rest of the photos were not attached.";
        break;
      }
      try {
        const [inj] = await chrome.scripting.executeScript({ target: { tabId }, func: attachPhotosInPage, args: [state.map, good] });
        if (!current()) return;
        const r = inj && inj.result;
        if (r && r.ok) mine.attached += r.attached;
        else mine.error = (r && r.reason) || "couldn't attach the photos";
      } catch (e) {
        if (!current()) return;
        mine.error = 'Attaching photos failed: ' + ((e && e.message) || e);
      }
    }
    render();
  }
  mine.done = true;
  render();
  await saveFlow();
}

// Attach photos again, on a form opened earlier: like Fill again (runFill),
// the car is read again first when its last read is old (carStillCurrent),
// so no photo goes onto a form left open overnight for a car that sold or
// changed since; a change takes the panel back to the review, and a car that
// no longer passes stops there (block says why).
async function attachAgain() {
  const run = flowRun;
  const tabId = state.fbTabId;
  if (!(await carStillCurrent()) || run !== flowRun || state.fbTabId !== tabId || state.step !== 'publish') return undefined;
  return attachPhotos(null, { again: true });
}

// Whether this side panel is in the window the post under way belongs to
// (or Chrome could not say which window either is). Chrome runs one side
// panel per window, and a panel opened in a second window brings back the
// same post: only the post's own panel records it or saves it by itself.
function postsWindow() {
  return !state.windowId || panelWindowId === null || state.windowId === panelWindowId;
}

function startWatcher() {
  if (watcher) watcher.cancel();
  watcher = watchForListing({ tabId: state.fbTabId, listingUrlPattern: state.map.listingUrlPattern, afterPublishPatterns: state.map.afterPublishPatterns, createUrl: state.map.createUrl });
  watcher.promise.then((r) => {
    if (state.step !== 'publish') return undefined;
    if (r.status === 'listing' || r.status === 'probably' || r.status === 'closed') {
      const own = postsWindow();
      // A listing page is read before the panel says anything about it
      // (confirmIfThisCar), in a queue or not: until then it says it is
      // checking, with the Listing link box empty, and only a page that
      // shows this car is offered as its link (offeredLink). In a queue, the
      // form's tab moving straight from the form to a new listing that shows
      // this car means the person clicked Publish: the post is recorded and
      // the next car loads. Any other listing address in that tab (one
      // browsed to, or one it already showed when the panel came back), and
      // every listing of a single post, waits for the person's click. A
      // panel in a second window reads and shows it, but never records it:
      // two panels that both recorded the post would record it twice.
      if (r.status === 'listing') {
        state.detected = { ...r, checking: true };
        render();
        return confirmIfThisCar(state.detected, state.queueMode && own && isNewListingFromForm(r, state.posted, state.map));
      }
      state.detected = r;
      render();
      if (own) saveFlow(); // the saved post is its own panel's: a second window's late write could land over the next car's
    }
    return undefined;
  });
}

// The listing page the form's tab is on is read (read-only) a few times
// while it loads. Only a page that is that listing and shows this car (its
// VIN in the page's text, or, when no other car posted or taken down lately
// has a name like its own (upkeep.js namesakesOf), its name and the price
// the form was filled with; never the form itself: showsPostedCar) is shown as "Looks like it posted" with its address in the
// Listing link box, and, in a queue, recorded by itself when `record` says
// the tab came straight from the form to a new listing in the post's own
// panel. A notification or a link clicked on the form page also goes
// straight to a listing, of another car: then the panel says it could not
// confirm the page shows this car and asks, and that listing's address stays
// out of the Listing link box, so It's posted never saves it as this car's
// link. The same holds for a single post, after Stop queue, and when the
// panel is opened again or in a second window: the watcher reports the
// listing again and it is read again.
const VERIFY_READS = 6;
const VERIFY_EVERY_MS = 1500;
async function confirmIfThisCar(d, record) {
  const run = flowRun;
  const { vin, vehicle, fbTabId } = state;
  const own = postsWindow();
  const { checking, ...r } = d; // the listing as the watcher reported it
  const still = () => run === flowRun && state.step === 'publish' && state.vin === vin && state.detected === d;
  const price = typeof state.price === 'number' && state.price > 0 ? state.price : vehicle ? basisPrice(vehicle, state.priceBasis || state.settings.basis) : null;
  const expect = { id: r.id, name: vehicle ? vehicle.name : '', prices: typeof price === 'number' && price > 0 ? [price] : [], vin };
  const namesakes = vehicle ? namesakesOf(state.posted, vin, vehicle.name, { takenDown: state.takenDown, names: state.snapshotVehicles }) : null;
  for (let i = 0; vehicle && i < VERIFY_READS; i += 1) {
    if (i) await sleep(VERIFY_EVERY_MS);
    if (!still()) return undefined;
    let seen = null;
    try {
      const [inj] = await chrome.scripting.executeScript({ target: { tabId: fbTabId }, func: readListingInPage, args: [state.map, LISTING_SIGNS, expect] });
      seen = inj && inj.result;
    } catch (e) {
      seen = null; // the page is still loading, or the tab went where Lot Current may not read: read again
    }
    if (!still()) return undefined;
    if (showsPostedCar(seen, { namesakes })) {
      state.detected = { ...r, verified: true };
      if (record) return confirmPosted();
      render();
      if (own) await saveFlow();
      return undefined;
    }
  }
  if (!still()) return undefined;
  state.detected = { ...r, unverified: true, name: expect.name, price: expect.prices[0] || null };
  render();
  if (own) await saveFlow();
  return undefined;
}

// The listing address the panel offers as this car's link (in the Listing
// link box, and for It's posted with nothing typed): only a listing page the
// panel read and saw this car on (verified), in a queue or not. A listing of
// another car the tab went to (a notification clicked on the form, say), or
// one not read yet, is never offered: It's posted then saves no link unless
// the person pastes one.
function offeredLink(d) {
  return d && d.url && d.verified && !d.unverified && !d.checking ? d.url : '';
}

// Records the post of the car on the form, once: the watcher and a click on
// It's posted (or two quick clicks) can both arrive, and only the first
// records it and moves a queue on (confirmedRun holds the post's flowRun).
// Only from the publish step, for the car captured here; a post dropped
// while it was recorded stays recorded, and the post that took over is left alone.
// A car this person already has a stored entry for was recorded while it
// was on the form (by the side panel in another window, or the popup's Mark
// posted; the form never opens for a car already marked): that entry stays
// as it is, gaining only a link it lacks, and the day's log gets nothing, so
// the post is counted once. A colleague's entry (`mine: false`) is theirs,
// not this person's post, and is recorded over as before.
let confirmedRun = -1;
async function confirmPosted() {
  const run = flowRun;
  if (state.step !== 'publish' || !state.vehicle || confirmedRun === run) return undefined;
  confirmedRun = run;
  const { vin, vehicle, origin } = state;
  const typed = (($('listingUrl') && $('listingUrl').value) || '').trim();
  // only a listing's own address is kept (listingLink): Your listings, where
  // Facebook often lands after Publish, would open the wrong page from To do
  // and in the manager's view. Another address typed in is not swapped for
  // what the tab showed: the post is recorded with no link, and the panel says so.
  const listingUrl = listingLink(typed || offeredLink(state.detected), state.map); // a listing the panel did not see this car on is never kept unless typed
  const linkNote = typed && !listingUrl
    ? `No listing link was saved for ${nameOf(vin)}: the address in Listing link isn't a Marketplace listing's own address (Your listings, say). Its To do items open Your listings, where you pick the listing.`
    : '';
  const now = new Date().toISOString();
  const extra = { postedWith: 'lotsync', salesperson: state.settings.salesperson.name || '' };
  if (listingUrl) extra.listingUrl = listingUrl;
  // The price the form was filled with (read and checked on the website under
  // the price basis of that moment), not one worked out again from today's
  // Settings: a basis changed while the form waited would record a price the
  // listing does not show. It is recorded on the basis it was read under
  // (priceBasis; src/rescan.js postedBasis), so rescans compare the listing
  // with the website on that basis, as for every listing posted before a
  // change of the setting.
  const filled = typeof state.price === 'number' && Number.isFinite(state.price) && state.price > 0 ? state.price : null;
  let kept = null; // this person's entry for the car, already stored
  try {
    // recorded into the list as it is stored now: the popup may have marked or unmarked cars while this one was on the form
    let list = {};
    const stored = await updateKey(siteKeys(origin).posted, (fresh) => {
      list = fresh || {};
      const had = list[vehicle.vin];
      kept = had && had.mine !== false ? had : null;
      if (!kept) return markPosted(list, filled === null ? vehicle : { ...vehicle, price: filled, priceBeforeFees: null }, filled === null ? state.settings.basis : 'website', now, filled === null ? extra : { ...extra, basis: state.priceBasis || (state.settings.basis === 'beforeFees' ? 'beforeFees' : 'website') });
      if (!listingUrl || kept.listingUrl) return undefined; // nothing to add: nothing is written
      kept = { ...kept, listingUrl };
      return { ...list, [vehicle.vin]: kept };
    }, panelStorage);
    state.posted = stored || list;
  } catch (e) {
    confirmedRun = -1; // not recorded: It's posted can be clicked again
    setStatus(storageErrorText(e), 'error'); // the post is on Facebook; the panel stays here so it can be recorded once there is room
    return undefined;
  }
  if (!kept) {
    try {
      // the day's log for the cap, which a take-down later leaves alone
      state.postLog = await updateKey(siteKeys(origin).postLog, (log) => logPost(log, vehicle.vin, now), panelStorage); // the same key as the posted entry
    } catch (e) {
      /* the posted list has the post, and counts it while it stays listed */
    }
  }
  await pilotNote((p) => endPost(p, vin, 'posted', { at: now })); // a no-op once this post's attempt is ended
  // the dealership's shared registry (accounts only): the worker syncs; nothing here waits for it
  if (accountsConfigured()) chrome.runtime.sendMessage({ type: 'syncNow', origin }).catch(() => {});
  if (run !== flowRun) return undefined; // dropped meanwhile: recorded, and the post now under way is not touched
  if (watcher) watcher.cancel();
  if (state.queueMode) {
    if (linkNote) {
      setStatus(linkNote, 'error');
      // the next car (or the queue's end) clears the status line: the queue bar keeps saying it
      const key = queueKey(state.queue);
      const names = state.unlinked && state.unlinked.queue === key ? state.unlinked.names : [];
      state.unlinked = { queue: key, names: [...names.filter((n) => n !== nameOf(vin)), nameOf(vin)] };
    }
    // the queue could not be saved: the car is recorded, and clicking again only moves the queue
    if ((await afterQueueStep('posted', vin)) === false) confirmedRun = -1;
    return undefined;
  }
  state.step = 'done';
  state.doneAt = (kept && kept.postedAt) || now;
  const said = [kept ? `${nameOf(vin)} was already recorded as posted, so it was not recorded or counted again.` : '', linkNote].filter(Boolean).join(' ');
  if (said) setStatus(said, linkNote ? 'error' : '');
  render();
  // recorded elsewhere first (another window's panel), which may have started another post since: its saved post stays
  if (!kept || (await savedFlowIs(origin, vin))) await saveFlow();
}

async function notPosted() {
  if (watcher) watcher.cancel();
  await pilotNote((p) => endPost(p, state.vin, 'not-posted'));
  state.step = 'review';
  state.fill = null;
  state.photos = null;
  state.detected = null;
  state.listingTyped = null;
  render();
  await saveFlow();
}

// The full decode from NHTSA's free service. Chrome asks the salesperson for
// the vpic.nhtsa.dot.gov permission the first time (optional_host_permissions).
async function checkVinOnline() {
  let granted = false;
  try {
    granted = await askChrome([NHTSA_ORIGIN + '/' + '*']); // split so the guard test's comment stripper never sees a block-comment opener
  } catch (e) {
    setStatus("Couldn't ask Chrome for permission: " + ((e && e.message) || e), 'error');
    return;
  }
  if (!granted) {
    setStatus('Permission for vpic.nhtsa.dot.gov was not granted, so the VIN was not checked online.', 'error');
    return;
  }
  setStatus('Asking NHTSA about this VIN…');
  const r = await decodeVinOnline(state.vin);
  state.vinCheck = { ...(state.vinCheck || {}), online: r.ok ? { ok: true, decoded: r.decoded, compare: compareVin(state.vehicle, r.decoded) } : { ok: false, error: r.error } };
  setStatus('');
  render();
  await saveFlow();
}

async function downloadPhotos() {
  const all = photoList();
  // as when attaching: nothing from a server the salesperson said no to
  const refused = photoPatterns(all).filter((p) => refusedPhotoServers.has(p));
  const onFacebook = all.filter((u) => isFacebookServer(u)); // never downloaded from (src/photoHosts.js)
  const urls = all.filter((u) => !refused.some((p) => patternCovers(p, u)) && !isFacebookServer(u));
  setStatus(`Downloading ${urls.length} photos…`);
  let n = 0;
  for (let i = 0; i < urls.length; i += 4) {
    const res = await chrome.runtime.sendMessage({ type: 'downloadPhotos', urls: urls.slice(i, i + 4), offset: i }).catch(() => null);
    for (const p of (res && res.photos) || []) {
      if (!p.ok) continue;
      const a = document.createElement('a');
      a.href = p.dataUrl;
      a.download = `${state.vehicle.stock || state.vin}-${p.name}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      n += 1;
      await sleep(150);
    }
  }
  const left = all.length - urls.length - onFacebook.length;
  let note = left ? ` Photos from ${hostList(refused)} were not allowed, so ${left === 1 ? 'one was' : `${left} were`} not downloaded.` : '';
  if (onFacebook.length) note += ` ${onFacebook.length === 1 ? 'One is' : `${onFacebook.length} are`} on Facebook's own servers, which Lot Current doesn't download from.`;
  setStatus(`${n} of ${all.length} photos downloaded to your Downloads folder.${note}`);
}

// ---------- rendering ----------

// The problems that keep the form from being filled (fillBlocker), then the
// ones that only warn (length and tone).
function checksHtml(g) {
  if (!g) return '';
  if (g.ok) return `<div class="checks ok" id="checks">All checks passed: ${g.words} words; every number the checks found is in the website's data, price and mileage included; no banned phrases or flagged claims; dealership and your role named${noteFor() ? '; price note included' : ''}. The checks look for set words and numbers, so read it through before you publish.</div>`;
  const stops = ruleProblems(g);
  const warns = g.problems.filter((p) => !stops.includes(p));
  const list = (ps) => `<ul>${ps.map((p) => `<li>${esc(p.text)}</li>`).join('')}</ul>`;
  return `<div class="checks ${stops.length ? 'bad' : 'warn'}" id="checks">${stops.length ? `Fix before the form can be filled:${list(stops)}` : ''}${warns.length ? `Worth fixing (the form can still be filled):${list(warns)}` : ''}</div>`;
}

function sourcePill() {
  const map = { template: ['', 'Template'], claude: ['claude', 'Claude draft'], edited: ['', 'Edited by you'] };
  const [tone, label] = map[state.descriptionSource] || ['', state.descriptionSource];
  return `<span class="pill ${tone}">${esc(label)}</span>`;
}

// ---------- the panel's own Ready to post list ----------
// What the popup's Ready tab lists (src/panelList.js readyRows), so the next
// car can be posted from here: on Facebook, after the last one, with the
// dealership website closed. Post re-checks the car on the website first,
// through the extension's own read when there is no dealer tab (the website
// permission automatic rescans use; Chrome asks for it from the click).

const hostOf = (origin) => {
  try {
    return new URL(origin).host;
  } catch (e) {
    return String(origin || '');
  }
};
// The patterns reading this website from here needs, and which of them
// Chrome has not granted yet (kept in memory, so a click can ask first).
const siteNeeds = () => siteReadOrigins(state.origin, state.siteInfo);
const siteMissing = () => missingOrigins(siteNeeds(), grantedOrigins);

// Asks Chrome for the website permission, first thing in a click (Chrome
// prompts only during one; see askForPhotos). Resolves true when it is
// granted, or when nothing is needed because the website is not in the
// registry (the read then says what to do instead).
async function askForSite(origins = siteMissing()) {
  if (!origins.length) return true;
  const asking = missingOrigins(origins, grantedOrigins);
  setStatus(siteAskText(asking.length ? asking : origins)); // every host Chrome's prompt will name, the inventory service's included
  promptOpen = true;
  let granted = false;
  try {
    granted = await askChrome(origins);
  } catch (e) {
    setStatus("Couldn't ask Chrome for permission: " + ((e && e.message) || e), 'error');
    return false;
  } finally {
    promptOpen = false;
  }
  await refreshGranted();
  if (!granted) {
    setStatus(`Not allowed, so Lot Current can't read ${hostOf(state.origin)} from the side panel. Open the website's used inventory page and scan or post from the popup there instead.`, 'error');
    return false;
  }
  setStatus('');
  return true;
}

// One list action at a time (Post, Post the next N, Allow reading), and one
// action on an open form (Fill it in now, Fill again, Attach photos again).
// The step stays idle while Chrome's prompt and the first reads run, so a
// second click (Post and then Post the next N, or a double click) would
// otherwise start a second flow over the same state, or fill the same form
// twice at once. Called straight from the click, so the action's own first
// call, Chrome's prompt, still runs inside it.
let listBusy = false;
function oneAtATime(action) {
  if (listBusy) return undefined;
  listBusy = true;
  return action().finally(() => {
    listBusy = false;
  });
}

const readyNow = (now = Date.now()) => readyRows({ vehicles: state.snapshotVehicles }, { posted: state.posted, drafts: state.drafts, settings: state.settings || {}, filter: state.listFilter, now });

function siteChoiceHtml() {
  const choices = siteChoices(state.sites);
  if (choices.length < 2) return '';
  return `<label class="control"><span>Website</span><select id="panelSite">${choices.map((c) => `<option value="${esc(c.origin)}" ${c.origin === state.origin ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>`;
}

// canPost: false at the day's cap, when the row shows no Post button.
function listRowHtml(r, { canPost = true } = {}) {
  const e = r.entry;
  const name = /^https?:\/\//i.test(e.url || '') ? `<a class="name" href="${esc(e.url)}" target="_blank" rel="noopener">${esc(r.name)}</a>` : `<span class="name">${esc(r.name)}</span>`;
  const pill = r.isNew ? ' <span class="pill good new">New</span>' : '';
  const facts = [e.stock && 'Stock ' + esc(e.stock), typeof e.mileage === 'number' ? miles(e.mileage) : '', esc(e.locationShort || '')].filter(Boolean).join(' · ');
  let action = '';
  if (r.draft) {
    const draft = draftPill(state.drafts[r.vin], e, { basis: (state.settings && state.settings.basis) || 'website', markWhere: ' in the popup' });
    action = `<span class="pill ${draft.tone}" title="${esc(draft.title)}">${esc(draft.text)}</span>`;
  } else if (canPost) action = `<button type="button" class="small go" data-post-vin="${esc(r.vin)}" aria-label="Post ${esc(r.name)}">Post</button>`;
  return `<li class="row"><div class="main">${name}${pill}<div class="sub">${facts}</div><div class="when">${esc(r.line)}</div></div><div class="price">${money(r.price)}</div>${action}</li>`;
}

// The list itself, redrawn on its own as the search box changes.
function listBodyHtml(list, cap) {
  if (!list.total) return '<div class="empty">No cars are ready to post right now.</div>';
  if (!list.rows.length) return '<div class="empty">No cars match</div>';
  return `<ul class="rows">${list.rows.map((r) => listRowHtml(r, { canPost: !cap.reached })).join('')}</ul>`;
}

function queueOfferHtml(list, cap) {
  const q = state.queue;
  if (cap.reached || (q && q.status !== 'done')) return ''; // a queue under way has its own bar
  const vins = nextToPost(list.rows, cap.remaining);
  if (vins.length < 2) return '';
  return `<div class="toolbar"><button type="button" class="small go" id="panelQueue" data-n="${vins.length}">Post the next ${vins.length}</button><span class="hint">In the order shown, one at a time: you check each form and click Publish.</span></div>`;
}

function viewIdle() {
  const intro = `<p class="lead">Open your dealership's used inventory page, click the Lot Current icon and click <b>Scan website</b>. The cars ready to post then show here and on the popup's <b>Ready to post</b> tab; <b>Post</b> pre-fills the Marketplace form for you to check and publish.</p>`;
  const notAffiliated = '<p class="hint">Facebook and Marketplace are named here only as the places you post. Lot Current is not affiliated with Meta.</p>';
  if (!state.origin || !Object.keys(state.snapshotVehicles || {}).length) return `${siteChoiceHtml() ? `<div class="toolbar listControls">${siteChoiceHtml()}</div>` : ''}${intro}${notAffiliated}`;
  const cap = dailyCap();
  const list = readyNow();
  const order = sortOrder(state.settings && state.settings.readySort);
  const meta = `Last scan ${esc(when(state.snapshotTakenAt))} · ${list.total} ready to post · ${cap.remaining} more post${cap.remaining === 1 ? '' : 's'} allowed today`;
  const rescanLabel = state.rescanning ? 'Rescanning…' : 'Rescan the website';
  return `<section id="panelReady" aria-labelledby="panelReadyLabel">
    <h3 id="panelReadyLabel">Ready to post</h3>
    <div class="meta" id="panelMeta">${meta}</div>
    ${cap.reached ? `<div class="banner warn" id="capReached">Daily post cap reached (${esc(capCount(cap))}). It resets tomorrow; the dealer can change it in Settings.</div>` : ''}
    <div class="toolbar listControls">
      ${siteChoiceHtml()}
      <label class="control"><span>Sort</span><select id="panelSort">${SORT_ORDERS.map((o) => `<option value="${o.id}" ${o.id === order ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>
      <button type="button" class="small" id="panelRescan" ${state.rescanning ? 'disabled' : ''}>${rescanLabel}</button>
    </div>
    <div class="toolbar listControls"><label class="control grow"><span class="sr">Search</span><input type="search" id="panelSearch" value="${esc(state.listFilter)}" placeholder="Search: stock number, last 6 of the VIN, year, make or model" autocomplete="off" spellcheck="false" /></label></div>
    <div id="panelList">${queueOfferHtml(list, cap)}${listBodyHtml(list, cap)}</div>
    <p class="hint" id="panelListHint">Post re-checks the car on the website first: a car that sold, is now listed as new or is no longer ready to post is stopped, and a price that changed since the last scan is posted as the website shows it now. You check every form and click Publish yourself.</p>
  </section>${notAffiliated}`;
}

function viewChecking() {
  return `<p class="lead">Re-checking <b>${esc(state.vin)}</b> on the website: still pre-owned, still on the lot, still priced.</p><p class="hint">${esc(state.message || '')}</p>`;
}

function viewBlocked() {
  // stopped for the website permission: one click asks Chrome and re-checks the same car
  const allow = Array.isArray(state.blockedOrigins) && state.blockedOrigins.length
    ? `<button type="button" class="primary" id="allowSite">Allow reading ${esc(hostOf(state.origin))}</button>`
    : '';
  const buttons = state.queueMode
    ? `${allow}<button type="button" class="${allow ? 'plain' : 'primary'}" id="skipBlocked">Skip this car, next</button><button type="button" class="plain" id="queueStop">Stop queue</button>`
    : `${allow}<button type="button" class="plain" id="back">Back</button>`;
  return `<div class="banner bad" id="blocked">${esc(state.message)}</div><div class="actions">${buttons}</div>`;
}

const currentListing = () => state.listing || buildListingData(state.vehicle, { dealer: state.settings.dealer, defaults: state.settings.defaults, guesses: state.colorGuess, description: state.description, price: state.price, photos: pickedPhotos(), stores: state.settings.myStores });

function fieldsTable() {
  const l = currentListing();
  const labels = Object.fromEntries(state.map.fields.map((f) => [f.key, f.label]));
  const rows = state.map.fields
    .filter((f) => f.key !== 'description')
    .map((f) => {
      const v = l.fields[f.key];
      const src = l.source && l.source[f.key];
      let shown;
      if (f.kind === 'checkbox') shown = v === 'yes' ? 'ticked' : v === 'no' ? 'unticked' : 'left as it is';
      else if (f.optional && !v) shown = '— (only if this form has it)';
      else shown = v ? esc(v === 'car_truck' ? 'Car/Truck' : v === 'motorcycle' ? 'Motorcycle' : v) : `— (website says "${esc(src || 'nothing')}")`;
      return `<tr class="${v || f.optional ? '' : 'missing'}"><td>${esc(labels[f.key])}</td><td>${shown}</td></tr>`;
    })
    .join('');
  const d = state.settings.dealer || {};
  const locationHint = !/^\d{5}/.test(String(d.zip || ''))
    ? `<p class="hint" id="locationHint">Add the store's ZIP in Settings so Marketplace picks the right town${d.state ? '' : ' (the state helps too)'}: there are several places with the same name.</p>`
    : '';
  const need = colorsNeeded();
  let colorHint = '';
  if (need.exterior || need.interior) {
    const rw = state.settings.rewrite;
    const cg = state.colorGuess;
    const which = [need.exterior && 'exterior', need.interior && 'interior'].filter(Boolean).join(' and ');
    const status = cg && cg.error ? `Photo guess failed: ${esc(cg.error)}.` : cg && (cg.exterior || cg.interior) ? `Guessed from the photos with ${esc(cg.confidence)} confidence.` : '';
    colorHint = `<p class="hint" id="colorHint">The website gives no usable ${which} color. ${status}
      <button type="button" class="copy" id="guessColors" ${rw.enabled && rw.endpoint ? '' : 'disabled title="Turn on the rewrite service in Settings first"'}>${cg && (cg.exterior || cg.interior) ? 'Guess again from the photos' : 'Guess from the photos'}</button>
      ${rw.enabled && rw.endpoint ? '' : ' (needs the rewrite service; otherwise pick it on the form)'}</p>`;
  }
  return `<table class="fields">${rows}<tr><td>Photos</td><td id="photoCount">${l.photos.length} picked from the website</td></tr></table>${locationHint}${colorHint}`;
}

function vinCheckHtml() {
  const vc = state.vinCheck;
  if (!vc || !vc.local) return '';
  const mark = (ok) => (ok === true ? '✓' : ok === false ? '✗' : '–');
  const local = vc.local;
  const on = vc.online;
  let html = `<section id="vinCheck"><h3>VIN check <span class="pill ${local.ok ? 'good' : 'bad'}">${local.ok ? 'agrees' : 'differs'}</span></h3>
    <ul class="list">${local.checks.map((c) => `<li>${mark(c.ok)} ${esc(c.label)}: <span class="why">${esc(c.detail)}</span></li>`).join('')}</ul>`;
  if (!local.ok) html += `<div class="banner warn">The VIN and the website disagree. Check the car before posting; the website's inventory may need a fix.</div>`;
  if (on && on.ok) {
    html += `<table class="fields"><tr><td></td><td><b>Website</b></td><td><b>VIN (NHTSA)</b></td></tr>${on.compare.rows
      .map((r) => `<tr class="${r.verdict === 'differ' ? 'missing' : ''}"><td>${esc(r.field)}</td><td>${esc(r.website) || '—'}</td><td>${esc(r.vin) || '—'} ${r.verdict === 'agree' ? '✓' : r.verdict === 'differ' ? '✗' : r.verdict === 'partly' ? '(partly)' : ''}</td></tr>`)
      .join('')}</table>
      ${compareSummary(on.compare).map((line) => `<p class="hint">${esc(line)}</p>`).join('')}`;
  } else if (on && !on.ok) {
    html += `<div class="banner warn">NHTSA check failed: ${esc(on.error)}</div>`;
  }
  html += `<div class="actions"><button type="button" class="plain" id="checkVinOnline">${on && on.ok ? 'Check again with NHTSA' : 'Check with NHTSA (free government decoder)'}</button></div>
    <p class="hint">The checks above need no internet. The NHTSA check reads make, model, body, fuel, engine and drive from the VIN; Chrome asks for permission to reach vpic.nhtsa.dot.gov the first time. The VIN never changes what gets posted by itself; it flags what to look at.</p></section>`;
  return html;
}

// Every value that took an assumption, each with where it came from: a
// reading of the website's words (a mild hybrid, a body style from the page
// address, a colour shade name, an electric car's single-speed gearbox), a
// colour guessed from the photos, or the dealership's defaults for the two
// fields the website can't give. Below it, what is left for the person: no
// default, a branded title, or a vehicle kind Lot Current doesn't fill in.
function assumptionsHtml() {
  const l = currentListing();
  let html = '';
  if (l.assumed.length) {
    html += `<section class="highlight" id="assumed"><h3>Assumed: check these on the form</h3><ul class="list">${l.assumed.map((b) => `<li><b>${esc(b.label)}</b>: ${esc(b.value)} <span class="why">${esc(b.why)}</span></li>`).join('')}</ul></section>`;
  }
  if (l.leftBlank.length) {
    html += `<section class="highlight" id="leftBlank"><h3>You fill in yourself</h3><ul class="list">${l.leftBlank.map((b) => `<li><b>${esc(b.label)}</b> <span class="why">${esc(b.why)}</span></li>`).join('')}</ul></section>`;
  }
  return html;
}

// The price is named by the basis it was read on (priceBasis): Settings
// saved while the post waits change new posts, not this car's price or its
// label. A post saved before the basis was kept goes by the setting.
function carCard() {
  const v = state.vehicle;
  const mainText = `website's main price${v.priceLabel ? ', "' + esc(v.priceLabel) + '"' : ''}`;
  const basis = (state.priceBasis || state.settings.basis) === 'beforeFees'
    ? (state.noteApplies === false ? `${mainText}; this car shows no lower second price, so the price note is left out` : 'the lower second price the website shows')
    : mainText;
  return `<section class="car" id="vehicle">
    <div class="name">${esc(v.name)}</div>
    <div class="facts">${[v.stock && 'Stock ' + esc(v.stock), miles(v.mileage), v.carfaxOneOwner ? 'Carfax one owner' : v.carfaxUrl ? 'Carfax' : 'No Carfax', esc(v.locationShort || v.location || '')].filter(Boolean).join(' · ')}</div>
    <div class="posting">Posting at <b>${money(state.price)}</b> (${basis})${v.url ? ` · <a href="${esc(v.url)}" target="_blank" rel="noopener">website page</a>` : ''}</div>
  </section>`;
}

// The salesperson's pick of photos: every photo the website shows for this
// car, in the website's order, ticked when it goes on the form, numbered in
// the order it will be attached. The first is the cover. The thumbnails are
// the website's own photo addresses, shown as the website shows them (no
// permission is needed to show a picture; downloading it for the form is
// asked for from the click on Open the Marketplace form).
const ordinal = (n) => n + ((n % 100 >= 11 && n % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'));

function photoPickHtml() {
  const all = usablePhotos(state.vehicle.photos);
  const onFacebook = (state.vehicle.photos || []).filter((u) => typeof u === 'string' && isFacebookServer(u)).length;
  const limit = photoLimitNow();
  const pick = pickedPhotos();
  const items = all.map((url, i) => {
    const at = pick.indexOf(url);
    const place = at === 0 ? ', cover' : at > 0 ? `, attached ${ordinal(at + 1)}` : '';
    return `<li class="thumb${at === -1 ? '' : ' on'}">
      <label class="pic"><img src="${esc(url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />
        <span class="row"><input type="checkbox" class="photoTick" id="photo-${i}" data-photo="${i}" ${at === -1 ? '' : 'checked'} /><span id="photoName-${i}">Photo ${i + 1}${place}</span></span></label>
      <button type="button" class="copy" id="photoCover-${i}" data-photo-cover="${i}" aria-label="Make cover: photo ${i + 1}">Make cover</button>
    </li>`;
  }).join('');
  const isDefault = state.photoPick === null;
  return `<section id="photoPick" aria-labelledby="photoPickLabel">
    <h3 id="photoPickLabel">Photos</h3>
    <p class="hint" id="photoPickSummary">${esc(pickSummary(state.photoPick, state.vehicle.photos, pickLimit()))}</p>
    ${all.length ? `<ul class="thumbs">${items}</ul>
    <div class="actions"><button type="button" class="plain" id="photosDefault" ${isDefault ? 'aria-pressed="true"' : 'aria-pressed="false"'}>Use the website's order</button><button type="button" class="plain" id="photosNone">Untick all</button></div>
    <p class="hint">Tick the photos to put on the listing. They are attached in the order shown by their numbers; the cover is the one Marketplace shows first.${all.length > limit ? ` The form takes up to ${limit}${state.fill && state.fill.photoLimit && state.fill.photoLimit.verified ? '' : ' (not yet checked on the form)'}.` : ''}</p>` : ''}
    ${onFacebook ? `<p class="hint">${onFacebook === 1 ? 'One photo is' : `${onFacebook} photos are`} on Facebook's own servers and can't be attached.</p>` : ''}
  </section>`;
}

// The salesperson's pick of highlights: the website's own features for this
// car (rewriteTemplate.js featureChoices), up to MAX_HIGHLIGHTS, named in the
// description in the order ticked. Nothing outside the website's list can be
// picked, so the description stays facts only.
function highlightsHtml() {
  const choices = featureChoices(state.vehicle.features);
  if (!choices.length) return '';
  const picked = settleHighlights(state.highlights, state.vehicle.features);
  // a flow saved before highlights were kept has none recorded: unknown, so no note
  const changed = Array.isArray(state.highlightsUsed) && JSON.stringify(picked) !== JSON.stringify(state.highlightsUsed);
  const boxes = choices.map((t, i) => {
    const at = picked.indexOf(t);
    return `<label class="feature"><input type="checkbox" class="featureTick" id="feature-${i}" data-feature="${i}" ${at === -1 ? '' : 'checked'} /> <span>${esc(t)}</span>${at === -1 ? '' : ` <span class="why" aria-hidden="true">${at + 1}</span>`}</label>`;
  }).join('');
  const edited = state.descriptionSource === 'edited';
  return `<fieldset class="highlights" id="highlights">
    <legend>Highlights <span class="why">${picked.length} of up to ${MAX_HIGHLIGHTS}, from the website's features</span></legend>
    <div class="featureList">${boxes}</div>
    <div class="actions"><button type="button" class="plain" id="useHighlights">Use these highlights</button>${changed ? ' <span class="why" id="highlightsChanged">Changed: the description above still has the earlier ones.</span>' : ''}</div>
    <p class="hint">Writes the description again with the highlights ticked, in the order ticked${edited ? '. Your edits to the description are replaced' : ''}.</p>
  </fieldset>`;
}

// The posting rules, before the first post from a website whose settings
// have no tick for them (set-up skipped, or started from Scan and Settings).
function viewRules() {
  return `<section id="postingRules" aria-labelledby="postingRulesLabel">
    <h3 id="postingRulesLabel">The posting rules</h3>
    <p class="lead">Before your first post from this website, read the posting rules and tick that you will follow them. Set-up shows the same rules.</p>
    <ol class="rules">${POSTING_RULES.map((r) => `<li><b>${esc(r.title)}</b> ${esc(r.text)}</li>`).join('')}</ol>
    <label class="block"><input type="checkbox" id="rulesRead" /> I have read the posting rules and will follow them</label>
    <div class="actions"><button type="button" class="primary" id="rulesContinue" disabled>Continue to the post</button><button type="button" class="plain" id="rulesCancel">Not now</button></div>
  </section>`;
}

// The tick: saved in this website's settings (rulesReadAt, as set-up's
// finish saves it), then the same post starts again from the top.
async function acceptRules() {
  const box = $('rulesRead');
  if (!box || !box.checked) return undefined;
  const at = new Date().toISOString();
  const key = siteKeys(state.origin).settings;
  try {
    await updateKey(key, (stored) => ({ ...(stored || state.settings), rulesReadAt: at }), panelStorage);
  } catch (e) {
    setStatus(storageErrorText(e), 'error');
    return undefined;
  }
  state.settings = { ...state.settings, rulesReadAt: at };
  return startFlow({ origin: state.origin, vin: state.vin, dealerTabId: state.dealerTabId, windowId: state.windowId, queue: state.queueMode });
}

// Not now: no post without the tick. A queue waits, paused, for the next try.
async function leaveRules() {
  const queued = state.queueMode && state.queue;
  if (queued) {
    state.queue = pauseQueue(state.queue);
    await saveQueue();
  }
  await clearFlow();
  setStatus(`Nothing was posted: the posting rules come first.${queued ? ' The queue is paused; Resume shows the rules again.' : ''}`);
  render();
}

// A car this person took off their listings while the website still listed
// it: re-posting it may be the delete and repost that posting rule 3 forbids.
// Said, never refused: the old listing may be gone for another reason.
function relistHtml() {
  const r = state.relist;
  if (!r) return '';
  return `<div class="banner warn" id="relistNotice" role="alert">You took this car off your listings on ${esc(when(r.takenDownAt))}, while the website still listed it. The posting rules say: no deleting and reposting to bump a listing. Post it again only if the old listing is gone for another reason, such as Facebook removing it or a Taken down clicked by mistake.</div>`;
}

// A review or dry run on an old read of the car (left open, or brought back
// when the panel reopened) says so: the car is read again before the form opens.
const readAgainHtml = () => (readIsOld()
  ? `<p class="hint" id="readAgain">Read from the website ${state.readAt ? esc(when(state.readAt)) : 'a while ago'}. Lot Current reads and checks it again before the form opens or fills.</p>`
  : '');

const capHtml = (cap) => `<div class="cap ${cap.reached ? 'reached' : ''}" id="cap">${cap.used} of ${cap.cap} posts today${cap.drafts ? ` (${cap.drafts} saved as ${cap.drafts === 1 ? 'a draft' : 'drafts'})` : ''}${cap.reached ? ' · cap reached' : ''}</div>`;

function viewReview() {
  const cap = dailyCap();
  const formOff = cap.reached || !dealerNamed() || ruleProblems(state.guardrails).length > 0;
  const rw = state.settings.rewrite;
  return `${relistHtml()}${carCard()}${readAgainHtml()}
  <section>
    <h3 id="descriptionLabel">Description ${sourcePill()}</h3>
    ${state.note ? `<div class="banner warn">${esc(state.note)}</div>` : ''}
    <textarea id="description" spellcheck="true" aria-labelledby="descriptionLabel">${esc(state.description)}</textarea>
    ${checksHtml(state.guardrails)}
    <div class="actions">
      <button type="button" class="plain" id="rewrite" ${rw.enabled && rw.endpoint ? '' : 'disabled title="Turn on the rewrite service in Settings first"'}>Rewrite with Claude</button>
      <button type="button" class="plain" id="resetTemplate">Reset to template</button>
      <button type="button" class="plain" id="copyDescription">Copy</button>
    </div>
    <p class="hint">Edit anything you like; your edits are kept. Facts only: every number is checked against the website.</p>
    ${highlightsHtml()}
  </section>
  ${photoPickHtml()}
  <section><h3>What Lot Current will fill in</h3>${fieldsTable()}</section>
  ${vinCheckHtml()}
  ${assumptionsHtml()}
  <section>
    ${capHtml(cap)}
    ${dealerNamed() ? '' : `<div class="banner bad" id="noDealer">${esc(NO_DEALER_TEXT)}</div>`}
    <button type="button" class="primary wide" id="openForm" ${formOff ? 'disabled' : ''}>Open the Marketplace form</button>
    <p class="hint">Opens the create-listing page in a new tab and fills in the fields above. Then you check everything, including condition and title, and click Publish yourself.</p>
    <div id="photoServers">${photoServersHtml()}</div>
    <button type="button" class="plain wide" id="checkForm" ${formOff ? 'disabled' : ''}>Open the form and check fields only (nothing filled)</button>
    <p class="hint">For the first run: the panel reports which fields it can find on the page, without filling anything. You can fill it in from there.</p>
    ${state.queueMode ? '' : '<button type="button" class="plain wide" id="stopPost">Stop this post</button>'}
  </section>`;
}

function viewProbe() {
  const p = state.probe || {};
  const cap = dailyCap();
  const found = p.found || [];
  const missing = p.missing || [];
  const controls = p.controls || [];
  const limit = p.photoLimit ? `${p.photoLimit.value}${p.photoLimit.verified ? '' : ' (unverified)'}` : '?';
  const blocked = fillBlocker(state.listing && state.listing.fields && state.listing.fields.description);
  return `${carCard()}${readAgainHtml()}
  <div class="banner info">Nothing was filled. This is what Lot Current can see on the form (map ${esc(p.mapVersion || state.map.version)}, Lot Current ${esc(p.extensionVersion || VERSION)}).</div>
  ${p.error ? `<div class="banner bad">${esc(p.error)}</div>` : ''}
  ${languageHint(p.language, !found.some((f) => f.tag))}
  <section id="probeResults">
    <h3>Found <span class="pill good">${found.length}</span></h3>
    ${found.length ? `<ul class="list">${found.map((f) => `<li>${esc(f.label)} <span class="why">${esc(f.tag)}${f.role ? '[' + esc(f.role) + ']' : ''}: "${esc(f.name)}"</span></li>`).join('')}</ul>` : '<p class="hint">None of the fields were found.</p>'}
    ${missing.length ? `<section class="highlight"><h3>Not found <span class="pill bad">${missing.length}</span></h3><ul class="list">${missing.map((m) => `<li><b>${esc(m.label)}</b> <span class="why">looked for ${esc((m.patterns || []).join(' or '))}</span></li>`).join('')}</ul><p class="hint">Copy the report and send it to whoever maintains formMap.js; each fix is one name pattern.</p></section>` : ''}
    <p class="hint">Photo upload: ${p.fileInputs ?? '?'} file input(s) on the page · limit ${esc(limit)}${p.photoText ? ` · the page says: "${esc(p.photoText)}"` : ''}</p>
    <details><summary>Controls in the vehicle form (${controls.length})</summary>${p.controlsFrom && p.controlsFrom !== 'the vehicle form' ? `<p class="hint">${esc(p.controlsFrom)}.</p>` : ''}<ul class="list">${controls.map((c) => `<li>${esc(c.tag)}${c.type ? '[' + esc(c.type) + ']' : ''}${c.role ? '[' + esc(c.role) + ']' : ''}: "${esc(c.name)}"</li>`).join('')}</ul></details>
  </section>
  ${photoServersHtml()}
  ${cap.reached ? `<div class="banner warn" id="capReached">Daily post cap reached (${esc(capCount(cap))}). It resets tomorrow; the dealer can change it in Settings.</div>` : ''}
  ${blocked ? `<div class="banner bad" id="fillBlocked">${esc(blocked)}</div>` : ''}
  <div class="actions">
    <button type="button" class="primary" id="fillNow" ${found.length && !cap.reached && !blocked ? '' : 'disabled'}>Fill it in now</button>
    <button type="button" class="plain" id="probeAgain">Check again</button>
    <button type="button" class="plain" id="copyReport">Copy report</button>
    <button type="button" class="plain" id="backToReview">Back</button>
  </div>`;
}

function viewFilling() {
  return `${carCard()}<p class="lead">${esc(state.message || 'Working…')}</p>`;
}

function copyBtn(text) {
  return `<button type="button" class="copy" data-copy="${esc(text)}">Copy</button>`;
}

const allowButton = (pattern) => `<button type="button" class="plain" data-allow-photos="${esc(pattern)}">Allow photos from ${esc(patternHost(pattern))}</button>`;

// The servers of the photos that didn't come which Lot Current still may not download from.
const blockedPatterns = () => (state.photos ? photoPatterns(state.photos.failed.map((f) => f.url)) : []);

// Said before the click that asks: which servers Chrome's prompt will name,
// and the ones refused earlier, which that click doesn't ask about again.
// except: servers the photos section already speaks about.
function photoServersHtml(except = []) {
  const needed = photoPatterns().filter((p) => !except.includes(p));
  const toAsk = needed.filter((p) => !refusedPhotoServers.has(p));
  let html = toAsk.length ? `<p class="hint" id="photoAsk">${esc(askSentence(toAsk))}</p>` : '';
  for (const p of needed.filter((x) => refusedPhotoServers.has(x))) {
    html += `<div class="banner warn">Photos from ${esc(patternHost(p))} were not allowed, so they won't be attached. ${allowButton(p)}</div>`;
  }
  return html;
}

function photosHtml() {
  const p = state.photos;
  if (!p) return '<div id="photos">Preparing photos…</div>';
  const limitNote = p.total > p.limit ? ` (the form takes ${p.limit}${p.verified ? '' : ', unverified'}; the first ${p.limit} were used)` : '';
  let html = `<div id="photos" class="${p.done ? 'done' : ''}">${p.attached} of ${Math.min(p.total, p.limit)} attached${p.done ? '' : '…'}${limitNote}</div>`;
  // The count is what Lot Current sent to the form, not what the form holds
  // now. The doubles warning is about photos this run actually attached:
  // none yet (or none at all: the tab left the form, say) means no doubles.
  if (p.again) {
    const all = p.done && p.attached >= Math.min(p.total, p.limit);
    const what = all ? 'Every photo was attached again. If the form still had the ones attached before, each is on it twice now'
      : `${p.attached} ${p.attached === 1 ? 'photo was' : 'photos were'} attached again. If the form still had the ones attached before, ${p.attached === 1 ? 'it is' : 'those are'} on it twice now`;
    if (p.attached > 0) html += `<div class="banner warn" id="photosAgain">${what}: remove the extra copies on Facebook before you publish.</div>`;
  } else if (p.done && p.attached) html += '<p class="hint" id="photosKept"><b>Fill again</b> fills the fields only and leaves these photos on the form. If the form lost them (the page reloaded, or you discarded a draft), click <b>Attach photos again</b>.</p>';
  const blocked = blockedPatterns();
  const onFacebook = p.failed.filter((f) => f.facebook).length;
  const others = p.failed.filter((f) => !f.facebook && !blocked.some((b) => patternCovers(b, f.url))).length;
  if (others) html += `<p class="hint">${others} couldn't be downloaded.</p>`;
  if (onFacebook) html += `<p class="hint">${onFacebook === 1 ? 'One is' : `${onFacebook} are`} on Facebook's own servers, which Lot Current doesn't download from.</p>`;
  for (const pattern of blocked) {
    const mine = p.failed.filter((f) => patternCovers(pattern, f.url));
    const host = esc(patternHost(pattern));
    const what = mine.length === 1 ? 'the photo from it is' : `the ${mine.length} photos from it are`;
    const why = mine.some((f) => f.refused) ? `Photos from ${host} were not allowed` : `Lot Current has no permission to download photos from ${host} yet`;
    html += `<div class="banner warn">${why}, so ${what} not attached. ${allowButton(pattern)}</div>`;
  }
  if (p.error) html += `<div class="banner warn">${esc(p.error)} Use <b>Download photos</b> and add them by hand.</div>`;
  return html;
}

function viewPublish() {
  const f = state.fill || { filled: [], partial: [], blocked: [], skipped: [] };
  const skipped = f.skipped || [];
  const pre = f.preexisting || [];
  const preexisting = pre.length
    ? `<div class="banner bad" id="preexisting"><b>This form already held another vehicle before Lot Current filled it:</b> ${pre.map((p) => `${esc(p.label)} "${esc(p.shown)}"`).join(', ')}. That is probably a draft Facebook restored. Lot Current replaced the fields it manages (check each one below), but photos and anything else from that draft may still be on the form. Remove them, or discard the draft on Facebook and click <b>Fill again</b>, then <b>Attach photos again</b>, before you publish.</div>`
    : '';
  const changed = f.changedAfterFill || [];
  const changedBanner = changed.length
    ? `<div class="banner bad" id="changedAfterFill"><b>Facebook changed ${changed.map((c) => `${esc(c.label)} to "${esc(c.was)}"`).join(', ')} a few seconds after Lot Current filled it.</b> That is a saved draft being restored over the form. Lot Current set ${changed.every((c) => c.held) ? 'them again and they held' : 'them again, but not all of them held (see Couldn\'t fill)'}. Check every field below, and delete that draft on Facebook (Marketplace → Your listings → Drafts) so it stops coming back.</div>`
    : '';
  const d = state.detected;
  let detect = '';
  const name = esc(d && d.name ? d.name : (state.vehicle && state.vehicle.name) || 'this car');
  if (d && d.unverified) {
    const so = state.queueMode ? 'so the queue did not record it by itself' : "so its address isn't offered as this car's link";
    detect = `<div class="banner warn" id="detected">The Facebook tab is on a listing page, and Lot Current couldn't confirm that it shows ${name} (its VIN, or its name${d.price ? ` at ${money(d.price)}` : ''}), ${so}. If you clicked <b>Publish</b> and it posted, paste its listing link below if you have it and click <b>${state.queueMode ? "It's posted, next car" : "It's posted, record it"}</b>.</div>`;
  } else if (d && d.status === 'listing' && !d.verified) {
    // being read (confirmIfThisCar), or brought back from before a read: the watcher reports it again and it is read again
    detect = `<div class="banner info" id="detected">The Facebook tab is on a listing page. Lot Current is reading it (only reading) to see whether it shows ${name}…</div>`;
  } else if (d && (d.status === 'listing' || d.status === 'probably')) {
    detect = `<div class="banner good" id="detected">Looks like it posted${d.url ? '' : ' (the tab moved to Your listings)'}. Confirm below to record it.</div>`;
  } else if (d && d.status === 'closed') {
    detect = `<div class="banner warn" id="detected">The Facebook tab was closed. Did it post?</div>`;
  } else {
    detect = `<div class="banner info">Waiting for you to click <b>Publish</b> on Facebook…</div>`;
  }
  const outcome = state.queueMode
    ? `<button type="button" class="primary" id="confirmPosted">It's posted, next car</button><button type="button" class="plain" id="savedDraft">Saved as draft, next car</button><button type="button" class="plain" id="skipCar">Skip, next car</button>`
    : `<button type="button" class="primary" id="confirmPosted">It's posted, record it</button><button type="button" class="plain" id="notPosted">It didn't post</button>`;
  return `${carCard()}
  ${preexisting}${changedBanner}
  ${languageHint(f.language, !f.filled.length && !f.partial.length)}
  <div class="banner info">The form is filled in. Check every field, including <b>Vehicle condition</b> and <b>Title status</b> (from your dealership's defaults), then click <b>Publish</b>${state.queueMode ? ' (or <b>Save draft</b>)' : ''} on Facebook yourself.${state.queueMode ? ' When the Facebook tab goes straight from the form to your new listing and Lot Current sees this car on it, the next car loads by itself; if it does not, click <b>It\'s posted, next car</b>.' : ''}</div>
  <section id="fillResults">
    <h3>Filled in <span class="pill good">${f.filled.length}</span> <span class="why">as the form shows them</span></h3>
    ${f.filled.length ? `<ul class="list">${f.filled.map((x) => `<li>${esc(x.label)}: ${esc(x.shown || x.value).slice(0, 80)}${x.note ? ` <span class="why">${esc(x.note)}</span>` : ''}</li>`).join('')}</ul>` : '<p class="hint">Nothing could be filled.</p>'}
    ${f.partial.length ? `<h3>Needs a click <span class="pill warn">${f.partial.length}</span></h3><ul class="list">${f.partial.map((x) => `<li>${esc(x.label)}: ${esc(x.value)} <span class="why">${esc(x.note || '')}</span></li>`).join('')}</ul>` : ''}
    ${skipped.length ? `<p class="hint">Left alone: ${skipped.map((x) => `${esc(x.label)} (${esc(x.reason)})`).join('; ')}.</p>` : ''}
  </section>
  ${f.blocked.length ? `<section class="highlight"><h3>Couldn't fill <span class="pill bad">${f.blocked.length}</span></h3><ul class="list">${f.blocked.map((x) => `<li><b>${esc(x.label)}</b>${x.value ? ': ' + esc(x.value).slice(0, 80) + copyBtn(x.value) : ''} <span class="why">${esc(x.reason)}</span>${
    x.candidates && x.candidates.length ? `<div class="why">Similar controls on the page: ${x.candidates.map((c) => `${esc(c.tag)}${c.role ? '[' + esc(c.role) + ']' : ''}${c.type ? '[' + esc(c.type) + ']' : ''}${c.haspopup ? '[popup ' + esc(c.haspopup) + ']' : ''}${c.editable ? '[editable]' : ''} "${esc(c.name || c.near)}"`).join('; ')}</div>` : ''
  }</li>`).join('')}</ul><p class="hint">Copy the report (Copy report on the dry run, or this list) and send it to whoever maintains formMap.js.</p></section>` : ''}
  <section><h3>Photos</h3>${photosHtml()}${photoServersHtml(blockedPatterns())}
    <div class="actions"><button type="button" class="plain" id="downloadPhotos">Download photos</button><button type="button" class="plain" id="fillAgain">Fill again</button><button type="button" class="plain" id="attachAgain">${state.photos && (state.photos.attached || state.photos.again) ? 'Attach photos again' : 'Attach photos'}</button><button type="button" class="plain" id="copyDescription">Copy description</button></div>
  </section>
  <section>${detect}
    <label class="block">Listing link (optional) <input type="url" id="listingUrl" value="${esc(state.listingTyped ?? offeredLink(d))}" placeholder="paste the listing's own address if you have it" /></label>
    <div class="actions">${outcome}</div>
  </section>`;
}

function viewDone() {
  const p = state.posted[state.vin] || {};
  return `<div class="banner good" id="done">Recorded: <b>${esc(state.vehicle.name)}</b> at ${money(p.price)}, ${esc(when(state.doneAt))}. It's now under <b>My listings</b> in the popup, and every rescan will tell you if it sells or the website price changes.</div>
  ${p.listingUrl ? `<p><a href="${esc(p.listingUrl)}" target="_blank" rel="noopener">Open the listing</a></p>` : ''}
  <button type="button" class="primary wide" id="postAnother">Post another car</button>`;
}

// The control that had the keyboard (by id) and its caret, so a redraw of
// the list the person did not ask for (a rescan, a post recorded in the
// popup, a sync) never throws them out of the search box.
function focusNow() {
  const el = document.activeElement;
  if (!el || !el.id || !$('panel').contains(el)) return null;
  let start = null;
  let end = null;
  try {
    start = el.selectionStart;
    end = el.selectionEnd;
  } catch (e) { /* a control without a caret */ }
  return { id: el.id, start, end };
}

function refocus(kept) {
  const el = kept && $(kept.id);
  if (!el) return;
  el.focus();
  if (typeof kept.start === 'number' && typeof el.setSelectionRange === 'function') {
    try {
      el.setSelectionRange(kept.start, kept.end);
    } catch (e) { /* not a text box */ }
  }
}

function render() {
  $('site').textContent = state.siteName || '';
  const views = { idle: viewIdle, rules: viewRules, checking: viewChecking, blocked: viewBlocked, review: viewReview, filling: viewFilling, probe: viewProbe, publish: viewPublish, done: viewDone, queueDone: viewQueueDone, wizard: wizardHtml };
  if (state.step === 'wizard') {
    $('panel').innerHTML = wizardHtml();
    return;
  }
  if (state.step === 'upkeep') {
    $('panel').innerHTML = upkeepHtml();
    return;
  }
  const kept = (state.step === 'idle' && $('panelReady')) || state.step === 'publish' ? focusNow() : null; // the list, or the publish step (the Listing link box), redrawn under the person
  $('panel').innerHTML = queueBar() + (views[state.step] || viewIdle)();
  if (kept) refocus(kept);
}

// The list part only, after a keystroke in the search box: the box keeps its focus and caret.
function renderList() {
  const box = $('panelList');
  if (!box || state.step !== 'idle') return render();
  const cap = dailyCap();
  const list = readyNow();
  box.innerHTML = queueOfferHtml(list, cap) + listBodyHtml(list, cap);
}

// A price update's read of the car on the website, just before its listing
// opens (upkeep.js startUpkeep): the same read and check a post makes at post
// time (readCarForPost, recheck), through the dealer tab the To do item was
// clicked from while it still shows this website, else straight from the
// extension with the website permission. What stops it is what the rescan
// raises for a posted car (rescan.js diffScans): gone from the website,
// marked sold or sale-pending, no longer called pre-owned, or details that
// need a look. Another store, no photos or not yet on the lot hold back a
// new post but not this: the listing is up, and its price should match the
// website. The price is the website's now, on the basis the listing was
// posted at (listingWebsitePrice), as the To do item's was. Resolves
// { ok, price } or { ok: false, message }; upkeep.js fills nothing on a
// stop or when there is no price.
async function upkeepPriceNow(req) {
  const vin = String(req.vin || '').toUpperCase();
  const host = hostOf(req.origin);
  const fresh = await readCarForPost({ tabId: req.dealerTabId ?? null, origin: req.origin, info: state.siteInfo, vin, url: state.snapshotVehicles[vin]?.url });
  if (!fresh.ok && fresh.needsPermission) {
    return { ok: false, message: `Lot Current reads this car on ${host} again before it fills a new price, and Chrome hasn't let it read ${host} from here. Open ${host}'s used inventory page, then click Open & update price in the popup there.` };
  }
  if (!fresh.ok && fresh.notFound) {
    return { ok: false, message: `${host} no longer lists this car, so its price was not updated. Rescan the website: if it sold, To do lists it to take down.` };
  }
  if (!fresh.ok) {
    const said = String(fresh.message || '').replace(/click Post( again| in the popup)?/g, 'click Open & update price in the popup').trim();
    return { ok: false, message: `Lot Current reads this car on ${host} again before it fills a new price, and couldn't just now.${said ? ' ' + said : ''}` };
  }
  const held = pendingText(fresh.vehicle);
  if (held) return { ok: false, message: `${held}, so its price was not updated. Rescan the website: To do then lists it to take down.` };
  const check = recheck(fresh.vehicle, state.settings);
  if (!check.ok && check.assessment.decision !== DECISION.NOT_READY) return { ok: false, message: `${check.message} Its price was not updated: rescan the website to see what to do with this listing.` };
  return { ok: true, price: listingWebsitePrice(state.posted[vin], fresh.vehicle, state.settings.basis, [state.snapshotVehicles[vin], fresh.vehicle]) };
}

const upkeepCtx = {
  render: () => { if (state.step === 'upkeep') render(); }, // a late poll never redraws another step's view
  map: () => state.map || FORM_MAP,
  priceNow: (req) => upkeepPriceNow(req),
  onClose: () => { state.step = 'idle'; render(); },
};

// A post that is under way (a car being checked, reviewed, filled or waiting
// for Publish) is not abandoned for a to-do item; the person finishes or
// stops it first.
const LIVE_STEPS = ['checking', 'review', 'filling', 'probe', 'publish'];
const postUnderWay = () => Boolean(state.vin) && LIVE_STEPS.includes(state.step);

// A Marketplace form open for the post under way: being opened and filled,
// the dry run's, or waiting for Publish. Dropping it for another car would
// leave a listing published from it unrecorded: never flagged when the car
// sells, never checked for price changes, never counted against the cap.
const FORM_STEPS = ['filling', 'probe', 'publish'];
function formOpen() {
  return Boolean(state.vin) && FORM_STEPS.includes(state.step);
}
const finishFirstText = (button) => `Finish or stop the current post (${state.vehicle ? state.vehicle.name : nameOf(state.vin)}) first: its Marketplace form is open. Then click ${button} again.`;

// Chrome runs one side panel per window, and each can start a post. One
// post is saved per website (saveFlow), so while one window's side panel has
// a post under way from a website, a side panel in another window starts no
// post from that website, of that car or another, and opens no form for it:
// startFlow and openForm stop and say so (elsewhereText). A post counts as
// under way there while it is being checked or reviewed with that window's
// side panel open, or while its Marketplace form is open (that panel open, or
// the form's tab still in that window). liveElsewhere reads it from the saved
// post: { where: 'form' | 'review', vin, name }, or null when the post is
// this window's, over, or left in a window whose side panel is closed with no
// form open there (this panel may then take it over), and when Chrome can't
// say which window either is.
async function liveElsewhere(saved) {
  if (panelWindowId === null || !saved || !saved.vin || !saved.windowId || saved.windowId === panelWindowId || !LIVE_STEPS.includes(saved.step)) return null;
  const form = FORM_STEPS.includes(saved.step);
  const found = { where: form ? 'form' : 'review', vin: saved.vin, name: (saved.vehicle && saved.vehicle.name) || nameOf(saved.vin) };
  try {
    const panels = await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'], windowIds: [saved.windowId] });
    if (panels && panels.length) return found;
  } catch (e) {
    // this Chrome can't list its side panels: the open form's tab still tells
  }
  if (form && typeof saved.fbTabId === 'number') {
    try {
      const tab = await chrome.tabs.get(saved.fbTabId);
      if (tab && tab.windowId === saved.windowId) return found;
    } catch (e) {
      // the form's tab is gone
    }
  }
  return null;
}
async function postElsewhere(origin) {
  if (panelWindowId === null || !origin) return null;
  let saved = null;
  try {
    const k = siteKeys(origin).flow;
    saved = (await chrome.storage.local.get(k))[k];
  } catch (e) {
    return null;
  }
  return liveElsewhere(saved);
}
// What the panel says when `other` (liveElsewhere) stops a post of `vin`.
function elsewhereText(other, vin) {
  const { name, where } = other;
  if (other.vin === vin) {
    return where === 'form'
      ? `${name}'s Marketplace form is already open from the side panel in another Chrome window, so no second form opens here. Finish it there; opening the side panel in that window brings the post back.`
      : `${name} is already being posted from the side panel in another Chrome window, so no second form opens here. Finish or stop it there, or close the side panel in that window, then try again here.`;
  }
  return where === 'form'
    ? `${name}'s Marketplace form is open from the side panel in another Chrome window. One post from a website goes at a time, so none starts here: finish that one there first (opening the side panel in that window brings it back).`
    : `${name} is being posted from the side panel in another Chrome window. One post from a website goes at a time, so none starts here: finish or stop that one there, or close the side panel in that window, then try again here.`;
}

// This panel's post gives way to `other`, a post from the same website that
// another window's side panel saved first (saveFlow): that saved post stays
// as it is, this panel's post is dropped, and the panel says why. began:
// whether this panel began an attempt for its car in the pilot numbers; one
// that gives way before it began ends none, so the other panel's attempt for
// the same car stays open (clearFlow ends the open attempt of state.vin).
async function giveWay(other, { began = true } = {}) {
  const vin = state.vin;
  if (!began) state.vin = null;
  await clearFlow({ keepSaved: true });
  setStatus(elsewhereText(other, vin), 'error');
  return render();
}

// A post request from the popup (Post, or Continue in the side panel). A
// request for the car already under way (being checked, reviewed, filled or
// waiting for Publish) leaves the panel on it: the post goes on, the text
// typed into the review is kept, and no second form is opened. A queue's
// request takes that car into the queue. While a form is open, a request for
// another car is refused until the person says whether that form posted.
// Otherwise the new post starts; a review with nothing on Facebook yet gives
// way to it, as before, and the post left behind stops (flowRun).
async function postRequested(req) {
  const sameCar = req.origin === state.origin && String(req.vin || '').toUpperCase() === state.vin;
  if (!(sameCar && postUnderWay()) && !formOpen()) return startFlow(req);
  await chrome.storage.local.remove(GLOBAL_KEYS.postRequest);
  if (sameCar) {
    if (req.queue && !state.queueMode) {
      state.queueMode = true;
      await saveFlow();
    }
    setStatus('');
    return render();
  }
  setStatus(finishFirstText('Post'), 'error');
  return undefined;
}

// A form left open on Facebook when the panel closed comes back before a
// post request is handled, so the request meets it (postRequested) instead
// of starting over it; so does a post of the very car the request is for
// that was still being checked or reviewed, with its typed text, unless it
// is still under way in another window's side panel.
async function resumeOpenForm(origin, req = null) {
  if (!origin) return;
  const k = siteKeys(origin).flow;
  const flow = (await chrome.storage.local.get(k))[k];
  if (!flow || !flow.vin) return;
  if (FORM_STEPS.includes(flow.step)) {
    await resumeFlow(origin, flow);
    return;
  }
  const sameCar = Boolean(req) && req.origin === origin && String(req.vin || '').toUpperCase() === flow.vin;
  if (!sameCar || !LIVE_STEPS.includes(flow.step)) return;
  // a car still being read for the first time has nothing to bring back yet,
  // and one being checked or reviewed in another window's open side panel
  // stays there: the request then says so (startFlow)
  if (firstRead(flow) || (await liveElsewhere(flow))) return;
  await resumeFlow(origin, flow);
}

// A post saved as the first read of its car began (startFlow), with nothing
// read yet: a reopened panel has nothing of it to bring back.
const firstRead = (flow) => Boolean(flow) && flow.step === 'checking' && !flow.vehicle;

let lastUpkeepAt = 0;
async function openUpkeep(req) {
  // the request can arrive twice (storage change + start-up read): act once
  if (req.at && req.at === lastUpkeepAt) return;
  lastUpkeepAt = req.at || Date.now();
  await chrome.storage.local.remove(GLOBAL_KEYS.upkeepRequest);
  if (postUnderWay()) {
    setStatus(`Finish or stop the current post (${state.vehicle ? state.vehicle.name : state.vin}) first, then click that To do button again.`, 'error');
    return;
  }
  endUpkeep();
  if (watcher) watcher.cancel();
  // A post that is over (recorded, or stopped with the reason) is cleared
  // first, as Post another car or Back clear it: left in place, its car would
  // keep the Website menu shut once the item is closed (chooseSite). A saved
  // post that is another window's panel's now stays where it is.
  if (state.vin) await clearFlow({ keepSaved: !(await savedFlowIs(state.origin, state.vin)) });
  state.origin = req.origin;
  state.dealerTabId = req.dealerTabId || state.dealerTabId;
  await chrome.storage.local.set({ [GLOBAL_KEYS.lastPostOrigin]: req.origin });
  await loadSaved();
  const devOverrides = (await chrome.storage.local.get(GLOBAL_KEYS.devOverrides))[GLOBAL_KEYS.devOverrides]; // test hook: addresses and timings only
  state.map = applyOverrides(FORM_MAP, devOverrides);
  state.step = 'upkeep';
  await startUpkeep(req, upkeepCtx);
}

const wizardCtx = {
  render,
  setStatus,
  onClose: () => { state.step = 'idle'; render(); },
};

async function openWizard(req) {
  endUpkeep();
  await clearFlow();
  state.origin = req.origin;
  state.dealerTabId = req.dealerTabId;
  state.windowId = req.windowId || null;
  await chrome.storage.local.set({ [GLOBAL_KEYS.lastPostOrigin]: req.origin });
  await loadSaved();
  await startWizard(req);
  state.step = 'wizard';
  render();
}

// ---------- posting from the panel's list ----------

// Post on a car in the panel's own list. Chrome's prompt for the website, when
// it is missing, comes first in the click; then the same flow as the popup's
// Post, with no dealer tab: the car is read straight from the website.
async function postFromList(vin) {
  if (!(await askForSite())) return undefined;
  const entry = state.snapshotVehicles[vin];
  if (!entry || state.posted[vin]) return render(); // posted or gone meanwhile: the list is redrawn
  const cap = dailyCap();
  if (cap.reached) {
    setStatus(`Daily post cap reached (${capCount(cap)}). It resets tomorrow; the dealer can change it in Settings.`, 'error');
    return render();
  }
  return startFlow({ origin: state.origin, vin, dealerTabId: null, windowId: panelWindowId, at: Date.now() });
}

// "Post the next N": a queue of the first N cars in the order shown, walked
// the way the popup's queue is (src/queue.js), with no dealer tab.
async function queueFromList() {
  if (!(await askForSite())) return undefined;
  const key = siteKeys(state.origin).queue;
  const stored = (await chrome.storage.local.get(key))[key] || null;
  if (stored && stored.status !== 'done') {
    state.queue = stored; // one started in the popup meanwhile: its bar takes over
    setStatus('A queue is already under way: continue it from the bar above, or stop it first.', 'error');
    return render();
  }
  const cap = dailyCap();
  const made = createQueue(nextToPost(readyNow().rows, cap.remaining), { remaining: cap.remaining, dealerTabId: null, windowId: panelWindowId });
  if (!made.ok) {
    setStatus(made.error, 'error');
    return render();
  }
  state.queue = made.queue;
  try {
    await ownSet({ [key]: made.queue });
  } catch (e) {
    state.queue = stored;
    setStatus(storageErrorText(e), 'error');
    return render();
  }
  setStatus(`Queue of ${made.queue.vins.length}: the first car is being checked on the website.`);
  return startNextInQueue();
}

// Rescan the website from here: the service worker's own rescan (the same
// read automatic rescans make, background.js runRescan), so the list shows
// what sold, what changed price and what arrived since the last scan.
async function rescanFromList() {
  if (!(await askForSite())) return undefined;
  const origin = state.origin;
  const host = hostOf(origin);
  state.rescanning = true;
  setStatus(`Reading ${host}…`);
  render();
  let r;
  try {
    r = await chrome.runtime.sendMessage({ type: 'rescanNow', origin, reason: 'panel' });
  } catch (e) {
    r = { ok: false, error: String((e && e.message) || e) };
  }
  state.rescanning = false;
  if (state.origin !== origin) return render(); // the website choice moved on meanwhile
  if (r && r.ok) {
    const warning = Array.isArray(r.warnings) && r.warnings.length ? ` ${r.warnings[0]}` : '';
    const todo = r.count ? ` ${r.count} of your listings need${r.count === 1 ? 's' : ''} attention: see To do in the popup.` : '';
    setStatus(`Rescanned ${host}: ${r.cars} used car${r.cars === 1 ? '' : 's'}.${todo}${warning}`);
  } else {
    setStatus(`The rescan didn't finish: ${(r && r.error) || "no answer from Lot Current's background worker"}`, 'error');
  }
  if (state.step !== 'idle') return undefined;
  await loadSaved(); // the worker saved the new scan (the storage change usually brought it already)
  return render();
}

// Another website from the list's choice. Only from the list itself, so a
// post, a set-up or an upkeep under way is never pulled onto another website.
async function chooseSite(origin) {
  if (listBusy) return render(); // a post from the list is starting on this website: the menu goes back to it
  if (state.step !== 'idle' || state.vin || !origin || origin === state.origin) return render(); // a post or a set-up is under way here
  state.origin = origin;
  state.listFilter = '';
  try {
    await chrome.storage.local.set({ [GLOBAL_KEYS.lastPostOrigin]: origin });
  } catch (e) { /* only which website the panel opens on next time */ }
  if (!(await loadSaved())) return; // chosen again meanwhile: the later choice draws the list
  setStatus('');
  render();
  if ($('panelSite')) $('panelSite').focus();
}

// The list's order is the popup's Ready tab order (settings.readySort, per
// website), written under the settings key's lock like every shared key.
async function changeSort(value) {
  const order = sortOrder(value);
  const site = { name: state.siteName };
  try {
    const saved = await updateKey(siteKeys(state.origin).settings, (s) => ({ ...withDefaults(s || state.settings || {}, site), readySort: order }), panelStorage);
    state.settings = withDefaults(saved, site);
  } catch (e) {
    setStatus(storageErrorText(e), 'error');
  }
  render();
  if ($('panelSort')) $('panelSort').focus();
}

// The website permission a post stopped on: asked from this click, then the
// same car is checked again (in a queue, the queue goes on from it).
async function allowSiteAndRetry() {
  const origins = Array.isArray(state.blockedOrigins) && state.blockedOrigins.length ? state.blockedOrigins : siteNeeds();
  if (!(await askForSite(missingOrigins(origins, grantedOrigins).length ? origins : []))) return undefined;
  return startFlow({ origin: state.origin, vin: state.vin, dealerTabId: null, windowId: panelWindowId || state.windowId, queue: state.queueMode, at: Date.now() }); // started again from this panel: its post
}

// ---------- events ----------

// Redraws one part of the review view in place, keeping keyboard focus on the
// control that had it (by id), so ticking photos or highlights never throws
// the person back to the top or loses the description they are typing.
function redraw(id, html, focusId = null) {
  const el = $(id);
  if (!el) return render();
  const focused = focusId || (document.activeElement && document.activeElement.id);
  el.outerHTML = html;
  if (focused && $(focused)) $(focused).focus();
}

// A changed pick of photos: the listing is built again from it at Open the
// Marketplace form, and the count in the fields table follows.
async function afterPhotoPick(focusId) {
  state.listing = null;
  redraw('photoPick', photoPickHtml(), focusId);
  setStatus(pickSummary(state.photoPick, state.vehicle.photos, pickLimit())); // said aloud: the status line is the panel's live region
  const count = $('photoCount');
  if (count) count.textContent = `${pickedPhotos().length} picked from the website`;
  // which photo servers Chrome will be asked about follows the pick
  const servers = $('photoServers');
  if (servers) servers.innerHTML = photoServersHtml();
  await saveFlow();
}

async function onPickChange(target) {
  if (state.step !== 'review' || !state.vehicle) return false;
  if (target.classList.contains('photoTick')) {
    const url = usablePhotos(state.vehicle.photos)[Number(target.dataset.photo)];
    const r = togglePhoto(state.photoPick, url, state.vehicle.photos, photoLimitNow());
    state.photoPick = r.pick;
    await afterPhotoPick(target.id);
    if (r.full) setStatus(`The form takes up to ${photoLimitNow()} photos: untick one first.`, 'error');
    return true;
  }
  if (target.classList.contains('featureTick')) {
    const t = featureChoices(state.vehicle.features)[Number(target.dataset.feature)];
    const now = settleHighlights(state.highlights, state.vehicle.features);
    let next = now.includes(t) ? now.filter((x) => x !== t) : [...now, t];
    if (next.length > MAX_HIGHLIGHTS) {
      next = now;
      setStatus(`Up to ${MAX_HIGHLIGHTS} highlights: untick one first.`, 'error');
    } else {
      setStatus('');
    }
    state.highlights = next;
    redraw('highlights', highlightsHtml(), target.id);
    await saveFlow();
    return true;
  }
  return false;
}

let inputTimer = null;
function onInput(ev) {
  if (ev.target.id === 'panelSearch') {
    state.listFilter = ev.target.value;
    renderList();
    return;
  }
  if (ev.target.id === 'listingUrl') {
    state.listingTyped = ev.target.value; // the person's own link: no redraw (a listing check, a photo batch) puts another in its place
    return;
  }
  if (ev.target.id !== 'description') return;
  clearTimeout(inputTimer);
  inputTimer = setTimeout(() => {
    state.description = ev.target.value;
    state.descriptionSource = 'edited';
    state.note = '';
    state.guardrails = runGuardrails(state.description, ctx());
    const old = $('checks');
    if (old) old.outerHTML = checksHtml(state.guardrails);
    setFormButtons();
    saveFlow();
  }, 250);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    setStatus('Copied.');
  } catch (e) {
    setStatus("Couldn't copy: " + ((e && e.message) || e), 'error');
  }
}

async function onClick(ev) {
  const btn = ev.target.closest('button');
  if (!btn) return;
  if (btn.dataset.copy !== undefined) return copy(btn.dataset.copy);
  if (promptOpen) return undefined; // Chrome's prompt is open: its answer comes first
  // Every Chrome prompt for photo servers is asked from here, first thing in
  // the click (askForPhotos says why).
  if (btn.dataset.allowPhotos !== undefined) {
    const pattern = btn.dataset.allowPhotos;
    const granted = await askForPhotos(photoList().filter((u) => patternCovers(pattern, u)), { again: true });
    return afterAllowPhotos(pattern, granted);
  }
  if (state.step === 'wizard' && (await handleWizardClick(btn.id, wizardCtx))) return undefined;
  if (btn.dataset.photoCover !== undefined && state.step === 'review') {
    const url = usablePhotos(state.vehicle.photos)[Number(btn.dataset.photoCover)];
    state.photoPick = makeCover(state.photoPick, url, state.vehicle.photos, photoLimitNow());
    return afterPhotoPick(btn.id);
  }
  if (state.step === 'upkeep' && (await handleUpkeepClick(btn.id, upkeepCtx))) return undefined;
  if (btn.dataset.postVin !== undefined && state.step === 'idle') return oneAtATime(() => postFromList(btn.dataset.postVin));
  switch (btn.id) {
    case 'panelQueue': return state.step === 'idle' ? oneAtATime(() => queueFromList()) : undefined;
    case 'panelRescan': return state.step === 'idle' ? rescanFromList() : undefined;
    case 'rulesContinue': return state.step === 'rules' ? acceptRules() : undefined;
    case 'rulesCancel': return state.step === 'rules' ? leaveRules() : undefined;
    case 'allowSite': return state.step === 'blocked' ? oneAtATime(() => allowSiteAndRetry()) : undefined;
    case 'openForm':
      await askForPhotos(); // with nothing ticked there is nothing to ask about, so no prompt
      if (noPhotosPicked()) return setStatus(NO_PHOTOS_TEXT, 'error');
      return openForm();
    case 'checkForm': return openForm({ probeOnly: true });
    case 'checkVinOnline': return checkVinOnline();
    case 'guessColors': {
      btn.disabled = true;
      setStatus('Looking at the photos…');
      await maybeGuessColors(true); // the form's colour fields only: the description stays as it is
      setStatus(state.colorGuess && state.colorGuess.error ? '' : 'Colors guessed from the photos; check them on the form.');
      render();
      return saveFlow();
    }
    case 'fillNow':
      await askForPhotos(); // with nothing ticked there is nothing to ask about, so no prompt
      if (noPhotosPicked()) return setStatus(NO_PHOTOS_TEXT, 'error');
      return oneAtATime(() => fillFromProbe()); // one fill of the dry run's form, as for Fill again below
    case 'probeAgain': return runProbe();
    case 'copyReport': return copy(JSON.stringify(state.probe, null, 2));
    case 'backToReview':
      state.step = 'review';
      render();
      return saveFlow();
    case 'rewrite': {
      btn.disabled = true;
      state.message = 'Asking the rewrite service…';
      setStatus(state.message);
      await generate({ useClaude: true });
      setStatus(state.note ? '' : 'Draft ready.');
      render();
      return saveFlow();
    }
    case 'photosDefault':
    case 'photosNone':
      state.photoPick = btn.id === 'photosNone' ? [] : null;
      return afterPhotoPick(btn.id);
    case 'useHighlights': {
      // the writer the description on screen came from: Claude's draft is asked for again, anything else is the template
      const useClaude = state.descriptionSource === 'claude';
      btn.disabled = true;
      if (useClaude) setStatus('Asking the rewrite service…');
      await generate({ useClaude });
      setStatus(useClaude && !state.note ? 'Draft ready.' : '');
      render();
      if ($('useHighlights')) $('useHighlights').focus();
      return saveFlow();
    }
    case 'resetTemplate':
      await generate({ useClaude: false });
      render();
      return saveFlow();
    case 'copyDescription': return copy(state.description);
    // Fill again and Attach photos again act on the open form one click at a
    // time (oneAtATime): a double click never fills the form twice at once
    // or sends every photo twice more. Both read the car again first when
    // its last read is old (runFill, attachAgain: carStillCurrent).
    case 'fillAgain': return state.step === 'publish' ? oneAtATime(() => runFill({ photos: false })) : undefined; // the fields only: the photos stay as they are on the form
    case 'attachAgain':
      await askForPhotos();
      return state.step === 'publish' ? oneAtATime(() => attachAgain()) : undefined;
    case 'downloadPhotos':
      await askForPhotos();
      return downloadPhotos();
    case 'confirmPosted': return confirmPosted();
    case 'notPosted': return notPosted();
    case 'savedDraft': return savedDraft();
    case 'skipCar':
    case 'skipBlocked': return afterQueueStep(btn.id === 'skipBlocked' ? 'blocked' : 'skipped');
    case 'queueNext': return formOpen() ? setStatus(finishFirstText('Post next car'), 'error') : startNextInQueue();
    case 'queuePause':
      state.queue = pauseQueue(state.queue);
      await saveQueue();
      return render();
    case 'queueResume':
      state.queue = resumeQueue(state.queue);
      await saveQueue();
      if (!state.vin || state.step === 'idle' || state.step === 'queueDone') return startNextInQueue();
      return render();
    case 'queueSkip':
      // a queued car's form being opened and filled (or filled again) is finished first (fillsUnderWay)
      if (state.queueMode && state.vin && (state.step === 'filling' || fillsUnderWay > 0)) {
        return setStatus(`Lot Current is still working on ${state.vehicle ? state.vehicle.name : nameOf(state.vin)}'s Marketplace form. Wait until the panel shows the form, then click Skip this car to move on without posting it.`, 'error');
      }
      if (state.queueMode && state.vin && state.step !== 'idle') return afterQueueStep('skipped');
      state.queue = advance(state.queue, 'skipped');
      await saveQueue();
      if (state.queue.status === 'done') state.step = 'queueDone';
      return render();
    case 'queueStop':
    case 'queueClear': {
      const stopped = btn.id === 'queueStop' ? 'Queue stopped. Posted cars stay recorded.' : '';
      state.queue = null;
      await saveQueue();
      // The post under way stays when it isn't one of the queue's cars, and
      // when its Marketplace form is open: a listing published from that form
      // must still be recorded (formOpen). A queued car on its form goes on
      // as a single post, recorded with It's posted, record it.
      if (state.vin && (!state.queueMode || formOpen())) {
        const open = formOpen() ? ` ${state.vehicle ? state.vehicle.name : state.vin} stays on its form: say whether it posted.` : '';
        state.queueMode = false;
        await saveFlow();
        setStatus(stopped + open);
        return render();
      }
      if (watcher) watcher.cancel();
      await clearFlow();
      setStatus(stopped);
      return render();
    }
    case 'stopPost': {
      // a single post at review: nothing is filled yet, so it can simply be
      // dropped (a queued car has Skip in the queue bar instead)
      if (state.step !== 'review' || state.queueMode) return undefined;
      const name = state.vehicle ? state.vehicle.name : nameOf(state.vin);
      await clearFlow();
      setStatus(`Stopped the post of ${name}. Click Post on any car to start again.`);
      return render();
    }
    case 'back':
    case 'postAnother':
      await clearFlow();
      setStatus('');
      return render();
    default:
  }
}

// Requests from the popup carry the window they were clicked in. Chrome runs
// one side panel per window, so a panel acts only on requests for its own
// window; a request older than this is a leftover, not something to act on.
const REQUEST_MAX_AGE_MS = 10 * 60 * 1000;
let panelWindowId = null;
const forThisWindow = (req) => Boolean(req) && (!req.windowId || panelWindowId === null || req.windowId === panelWindowId);
const isFresh = (req) => Boolean(req) && (!req.at || Date.now() - req.at <= REQUEST_MAX_AGE_MS);

const handlers = { [GLOBAL_KEYS.postRequest]: postRequested, [GLOBAL_KEYS.setupRequest]: openWizard, [GLOBAL_KEYS.upkeepRequest]: openUpkeep };

// Changes to this website's posted list, drafts, queue and settings made by
// the popup or the service worker are adopted here, so the cap, the queue
// bar and the next car's record are current without reopening the panel.
// The panel's own writes echo back too: they are marked (ownSet), and a value
// the panel already holds is not a change. What is redrawn: steps without a
// text box are redrawn whole; on the posting rules, review and publish only
// the queue bar and the cap line are replaced, so the rules' tick, the
// description and the listing link the person is typing stay put; the
// wizard and upkeep draw their own views.
// When the popup stops the queue while a car is under way, that car can
// still be finished; afterQueueStep then finds no queue and stops.
const INPUT_STEPS = ['rules', 'review', 'publish'];
const OWN_VIEW_STEPS = ['wizard', 'upkeep'];
function adoptChanges(changes) {
  // the site registry: a website scanned or set up elsewhere, its service and permission state
  if (changes[GLOBAL_KEYS.sites]) {
    state.sites = changes[GLOBAL_KEYS.sites].newValue || {};
    state.siteInfo = state.origin ? state.sites[state.origin] || null : null;
    if (!state.origin && state.step === 'idle') {
      // the first scan on this computer: the list opens on that website
      const origin = defaultOrigin(state.sites, null);
      if (origin) {
        state.origin = origin;
        loadSaved().then(() => { if (state.step === 'idle' && state.origin === origin) render(); });
      }
      return;
    }
    if (state.step === 'idle') render(); // the website choice
  }
  if (!state.origin) return;
  const k = siteKeys(state.origin);
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const changed = (key) => Boolean(changes[key]) && !isOwnEcho(key);
  let touched = false;
  let queueChanged = false;
  const take = (key, field, fallback) => {
    if (!changed(key)) return;
    const next = changes[key].newValue ?? fallback;
    if (same(next, state[field])) return;
    state[field] = next;
    touched = true;
  };
  take(k.posted, 'posted', {});
  take(k.postLog, 'postLog', []);
  take(k.drafts, 'drafts', {});
  // a new scan (the popup, the worker's rescan): the list follows it
  if (changes[k.snapshot]) {
    const snap = changes[k.snapshot].newValue || null;
    const vehicles = (snap && snap.vehicles) || {};
    if (!same(vehicles, state.snapshotVehicles) || (snap && snap.takenAt) !== state.snapshotTakenAt) {
      state.snapshotVehicles = vehicles;
      state.snapshotTakenAt = (snap && snap.takenAt) || null;
      if (snap && snap.site && snap.site.name) state.siteName = snap.site.name;
      touched = true;
    }
  }
  take(k.sync, 'syncState', null); // the server's count of today's posts feeds the cap line
  take(k.takenDown, 'takenDown', null); // a post taken down still counts toward the cap
  if (changed(k.settings) && changes[k.settings].newValue && !same(changes[k.settings].newValue, state.settings)) {
    state.settings = withDefaults(changes[k.settings].newValue, { name: state.siteName });
    touched = true;
  }
  if (changed(k.queue)) {
    const next = changes[k.queue].newValue ?? null;
    if (!same(next, state.queue)) {
      state.queue = next;
      touched = true;
      queueChanged = true;
      if (!next && state.queueMode && postUnderWay()) setStatus('The queue was stopped from the popup. Finish or skip this car; the panel stops after it. Posted cars stay recorded.');
      // the popup cleared a finished queue: its summary view has nothing left to describe, so back to the idle view
      if (!next && state.step === 'queueDone') state.step = 'idle';
    }
  }
  if (!touched || OWN_VIEW_STEPS.includes(state.step)) return;
  if (!INPUT_STEPS.includes(state.step)) return render();
  if (queueChanged) {
    const bar = $('queueBar');
    const html = queueBar();
    if (bar) bar.outerHTML = html;
    else if (html) $('panel').insertAdjacentHTML('afterbegin', html);
  }
  const capLine = $('cap');
  if (capLine && state.settings) {
    const cap = dailyCap();
    capLine.outerHTML = capHtml(cap);
    setFormButtons(cap);
  }
  // a name added in Settings: the banner asking for one goes (a description
  // written before it still has to name the dealership: fillBlocker)
  const noDealer = $('noDealer');
  if (noDealer && state.step === 'review' && dealerNamed()) noDealer.remove();
}

async function init() {
  $('panel').addEventListener('click', onClick);
  $('panel').addEventListener('input', onInput);
  $('panel').addEventListener('change', (ev) => {
    if (state.step === 'wizard') handleWizardChange(ev.target);
    else if (ev.target.id === 'rulesRead') { const b = $('rulesContinue'); if (b) b.disabled = !ev.target.checked; }
    else if (ev.target.id === 'panelSite') chooseSite(ev.target.value);
    else if (ev.target.id === 'panelSort') changeSort(ev.target.value);
    else onPickChange(ev.target);
  });
  $('panel').addEventListener('keydown', (ev) => {
    // Escape clears the list's search box, as on the popup's Ready tab
    if (ev.key !== 'Escape' || ev.target.id !== 'panelSearch' || !ev.target.value) return;
    ev.preventDefault();
    ev.target.value = '';
    state.listFilter = '';
    renderList();
  });
  await refreshGranted();
  // a permission granted or removed elsewhere (the popup, chrome://extensions) counts from the next click
  chrome.permissions.onAdded.addListener(refreshGranted);
  chrome.permissions.onRemoved.addListener(refreshGranted);
  try {
    const win = await chrome.windows.getCurrent();
    panelWindowId = win && typeof win.id === 'number' ? win.id : null;
  } catch (e) {
    panelWindowId = null;
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    adoptChanges(changes);
    for (const name of REQUEST_KEYS) {
      const req = changes[name] && changes[name].newValue;
      if (!req || !forThisWindow(req)) continue;
      if (name === GLOBAL_KEYS.setupRequest) chrome.storage.local.remove(GLOBAL_KEYS.setupRequest);
      handlers[name](req);
    }
  });
  const stored = await chrome.storage.local.get([...REQUEST_KEYS, GLOBAL_KEYS.lastPostOrigin, GLOBAL_KEYS.sites]);
  // the newest request for this window wins; every request key is cleared
  // once one is acted on, so nothing stale fires on a later panel load
  const pending = REQUEST_KEYS.map((name) => ({ name, req: stored[name] })).filter(({ req }) => forThisWindow(req) && isFresh(req)).sort((a, b) => (b.req.at || 0) - (a.req.at || 0));
  const stale = REQUEST_KEYS.filter((name) => stored[name] && !isFresh(stored[name]));
  if (stale.length) await chrome.storage.local.remove(stale);
  const lastPostOrigin = stored[GLOBAL_KEYS.lastPostOrigin];
  if (pending.length) {
    await chrome.storage.local.remove(REQUEST_KEYS);
    if (pending[0].name === GLOBAL_KEYS.postRequest) await resumeOpenForm(lastPostOrigin, pending[0].req);
    return handlers[pending[0].name](pending[0].req);
  }
  if (lastPostOrigin) {
    // a post under way comes back first; an unfinished set-up only when nothing else is going on
    const k = siteKeys(lastPostOrigin).flow;
    const flow = (await chrome.storage.local.get(k))[k];
    if (firstRead(flow)) {
      // nothing to bring back: this window's own was left by its panel
      // closing during that read, so it goes; another window's panel may
      // still be reading, and it stays
      if (panelWindowId !== null && flow.windowId === panelWindowId) await chrome.storage.local.remove(k);
    } else if (flow && flow.step && flow.step !== 'idle') return resumeFlow(lastPostOrigin, flow);
    if (await resumeWizard(lastPostOrigin)) {
      state.origin = lastPostOrigin;
      state.dealerTabId = wiz.dealerTabId;
      await loadSaved();
      state.step = 'wizard';
      return render();
    }
  }
  // the list opens on the website the panel last worked on, else the one scanned last (src/panelList.js defaultOrigin)
  const origin = defaultOrigin(stored[GLOBAL_KEYS.sites], lastPostOrigin);
  if (origin) {
    state.origin = origin;
    await loadSaved();
  }
  render();
}

init();
