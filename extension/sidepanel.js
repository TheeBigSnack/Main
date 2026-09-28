// The guided one-click-post flow. Runs in Chrome's side panel, which stays
// open while the salesperson moves between the dealer tab and the Facebook
// tab (a popup would close).
//
// Steps: checking (fresh fetch + re-check) -> review (description, fields)
// -> filling (opens the Marketplace form, fills it, attaches photos)
// -> publish (the salesperson checks the form and clicks Publish themselves)
// -> done (the post is recorded in the same list the popup uses).
//
// This file never clicks anything on the Facebook page.

import { markPosted, basisPrice } from './src/rescan.js';
import { shortLocation, storeNames } from './src/normalize.js';
import { fetchVehicleDetails, recheck } from './src/vehicleDetails.js';
import { generateDescription, guessColorsWithBackend } from './src/rewriter.js';
import { runGuardrails } from './src/rewriteTemplate.js';
import { buildListingData, normalizeColor, COLORS } from './src/listingData.js';
import { capStatus } from './src/cap.js';
import { withDefaults, loadProfile, settingsFromProfile } from './src/settings.js';
import { currentVin, advance, pause as pauseQueue, resume as resumeQueue, describe as describeQueue } from './src/queue.js';
import { wiz, startWizard, resumeWizard, wizardHtml, handleWizardClick, handleWizardChange } from './wizard.js';
import { up, startUpkeep, endUpkeep, upkeepHtml, handleUpkeepClick } from './upkeep.js';
import { localVinCheck, decodeVinOnline, compareVin, NHTSA_ORIGIN } from './src/vin.js';
import { FORM_MAP, applyOverrides } from './facebook/formMap.js';
import { fillFormInPage, attachPhotosInPage, probeFormInPage } from './facebook/fillForm.js';
import { watchForListing } from './facebook/detectPost.js';
import { beginPost, notePostStep, endPost, noteFill, updatePilot } from './src/pilot.js';
import { siteKeys, GLOBAL_KEYS, REQUEST_KEYS } from './src/storageKeys.js';
import { updateKey, storageErrorText } from './src/storage.js';
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
  ? `<div class="banner warn" id="languageHint">Your Facebook is set to "${esc(lang)}". Lot Sync's form map is English only for now: switch Facebook to English (Settings > Language), then try again.</div>`
  : '');

const state = {
  origin: null, vin: null, dealerTabId: null, windowId: null,
  settings: null, posted: {}, boilerplate: [], siteName: '',
  vehicle: null, price: null,
  description: '', descriptionSource: 'template', note: '', guardrails: null,
  listing: null,
  fbTabId: null, fill: null, photos: null, detected: null, probe: null,
  vinCheck: null, // { local, online } from src/vin.js
  colorGuess: null, // { exterior, interior, confidence } from the photos, or { error }
  queue: null, // the batch queue (src/queue.js), shared with the popup
  queueMode: false, // this car is being posted as part of the queue
  drafts: {}, // cars the person saved as drafts on Facebook: { vin: { name, savedAt } }
  snapshotVehicles: {}, // names for the queue bar
  syncState: null, // this website's sync state (src/sync.js nextSyncState): the server's count of today's posts feeds the cap
  step: 'idle', message: '', doneAt: null,
  map: FORM_MAP,
};
let watcher = null;

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

async function loadSaved() {
  const k = siteKeys(state.origin);
  const data = await chrome.storage.local.get([k.settings, k.snapshot, k.posted, k.boilerplate, k.queue, k.drafts, k.sync]);
  state.siteName = data[k.snapshot]?.site?.name || state.origin;
  const site = data[k.snapshot]?.site || { name: state.siteName };
  state.settings = data[k.settings] ? withDefaults(data[k.settings], site) : settingsFromProfile(await loadProfile(), { ...site, origin: state.origin }) || withDefaults({}, site);
  state.posted = data[k.posted] || {};
  state.boilerplate = data[k.boilerplate] || [];
  state.queue = data[k.queue] || null;
  state.drafts = data[k.drafts] || {};
  state.snapshotVehicles = data[k.snapshot]?.vehicles || {};
  state.syncState = data[k.sync] || null;
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

const FLOW_FIELDS = ['vin', 'dealerTabId', 'windowId', 'vehicle', 'price', 'noteApplies', 'description', 'descriptionSource', 'note', 'guardrails', 'listing', 'fbTabId', 'fill', 'photos', 'detected', 'probe', 'vinCheck', 'colorGuess', 'queueMode', 'step', 'message', 'doneAt', 'map'];

async function saveFlow() {
  if (!state.origin) return;
  const flow = {};
  for (const f of FLOW_FIELDS) flow[f] = state[f];
  try {
    await chrome.storage.local.set({ [siteKeys(state.origin).flow]: flow, [GLOBAL_KEYS.lastPostOrigin]: state.origin });
  } catch (e) {
    setStatus(storageErrorText(e), 'error'); // the quota, most likely; the post goes on from what the panel holds
  }
}

async function clearFlow() {
  if (watcher) watcher.cancel();
  watcher = null;
  if (state.vin) await pilotNote((p) => endPost(p, state.vin, 'abandoned')); // only an attempt still open changes
  if (state.origin) await chrome.storage.local.remove(siteKeys(state.origin).flow);
  Object.assign(state, {
    vin: null, vehicle: null, price: null, description: '', descriptionSource: 'template', note: '', guardrails: null,
    listing: null, fbTabId: null, fill: null, photos: null, detected: null, probe: null, vinCheck: null, colorGuess: null, queueMode: false, step: 'idle', message: '', doneAt: null, map: FORM_MAP,
  });
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
const ctx = () => ({ vehicle: state.vehicle, dealer: state.settings.dealer, priceNote: noteFor(), price: state.price });

// Pilot numbers (src/pilot.js): when each post started and ended, and what
// each fill could not do. Bookkeeping only; a failure here never stops a post.
const pilotNote = (change) => (state.origin ? updatePilot(state.origin, change).catch(() => null) : Promise.resolve(null));

// ---------- the flow ----------

async function startFlow(req) {
  await chrome.storage.local.remove(GLOBAL_KEYS.postRequest);
  endUpkeep(); // a waiting upkeep must not keep polling and redrawing over a post
  await clearFlow();
  state.origin = req.origin;
  state.vin = String(req.vin || '').toUpperCase();
  state.dealerTabId = req.dealerTabId;
  state.windowId = req.windowId || null;
  state.queueMode = Boolean(req.queue);
  await loadSaved();
  state.step = 'checking';
  setStatus('');
  render();
  await pilotNote((p) => beginPost(p, { vin: state.vin, name: nameOf(state.vin), salesperson: state.settings.salesperson.name, queue: state.queueMode }));

  const fresh = await fetchVehicleDetails(state.dealerTabId, state.vin);
  if (!fresh.ok) return block(fresh.message, fresh.notFound ? 'not-on-website' : 'site-unreachable');
  const check = recheck(fresh.vehicle, state.settings);
  if (!check.ok) return block(check.message, 'check-' + check.assessment.decision);
  // the store label the popup shows: settled over the lot's store names, not the adapter's brand-word guess for one record
  fresh.vehicle.locationShort = shortLocation(fresh.vehicle.location, storeNames(Object.values(state.snapshotVehicles)));
  state.vehicle = fresh.vehicle;
  state.vinCheck = { local: localVinCheck(fresh.vehicle), online: null };
  state.price = basisPrice(fresh.vehicle, state.settings.basis); // the lower second price only when this car shows one
  state.noteApplies = !(state.settings.basis === 'beforeFees' && state.price === fresh.vehicle.price);
  if (!state.price) return block("The website shows no price for this car right now, so it can't be posted.", 'no-price');

  state.message = 'Writing the description…';
  render();
  await maybeGuessColors();
  await generate();
  state.step = 'review';
  state.message = '';
  render();
  await saveFlow();
  await pilotNote((p) => notePostStep(p, state.vin, 'reviewedAt'));
  // In a queue, a car that passes every check goes straight to the form;
  // one with a warning waits here so the person sees it.
  if (state.queueMode && canAutoOpen()) await openForm();
}

// The day's cap for this salesperson: this machine's posts and, after a
// sync, the server's count of theirs across their machines (src/cap.js).
const dailyCap = () => capStatus(state.posted, state.settings.dailyCap, new Date(), { serverCount: state.syncState && state.syncState.postsToday });

function canAutoOpen() {
  if (!state.guardrails || !state.guardrails.ok) return false;
  if (state.vinCheck && state.vinCheck.local && !state.vinCheck.local.ok) return false;
  const blockers = currentListing().missing.filter((k) => !['titleStatus', 'cleanTitle'].includes(k));
  if (blockers.length) return false;
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
    setStatus(`Daily post cap reached (${cap.used} of ${cap.cap}). The queue is paused until tomorrow; the dealer can change the cap in Settings.`, 'error');
    render();
    return;
  }
  await startFlow({ origin: state.origin, vin, dealerTabId: q.dealerTabId || state.dealerTabId, windowId: q.windowId || state.windowId, queue: true });
}

// Records how this car ended and moves on: the next car, a pause, or the end.
// The queue is advanced from what is stored, under its lock: the popup may
// have stopped it (or paused it) while this car was on the form, and a stale
// copy must not bring it back.
let advancing = false;
async function afterQueueStep(outcome) {
  if (advancing) return; // the watcher and a click on the same car advance once
  advancing = true;
  let startNext = false;
  try {
    if (watcher) watcher.cancel();
    if (state.vin) await pilotNote((p) => endPost(p, state.vin, outcome)); // a no-op for a car already recorded as posted or drafted
    let stored;
    try {
      stored = await updateKey(siteKeys(state.origin).queue, (q) => (q ? advance(q, outcome) : undefined), panelStorage);
    } catch (e) {
      setStatus(storageErrorText(e), 'error'); // the queue stays where it is; the button can be clicked again
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
  if (startNext) return startNextInQueue();
}

async function savedDraft() {
  const savedAt = new Date().toISOString();
  try {
    // added to the list as it is stored now: the popup may have changed it meanwhile
    state.drafts = await updateKey(siteKeys(state.origin).drafts, (fresh) => ({ ...(fresh || {}), [state.vin]: { name: state.vehicle.name, savedAt } }), panelStorage);
  } catch (e) {
    setStatus(storageErrorText(e), 'error');
    return;
  }
  await pilotNote((p) => endPost(p, state.vin, 'draft'));
  return afterQueueStep('draft');
}

function queueBar() {
  const q = state.queue;
  if (!q) return '';
  const next = currentVin(q);
  const active = state.queueMode && state.vin && state.step !== 'idle' && state.step !== 'queueDone';
  let buttons = '';
  if (q.status === 'done') {
    buttons = `<button type="button" class="plain" id="queueClear">Clear queue</button>`;
  } else {
    if (!active && next && q.status === 'running') buttons += `<button type="button" class="primary" id="queueNext">Post next car</button>`;
    buttons += q.status === 'running' ? `<button type="button" class="plain" id="queuePause">Pause</button>` : `<button type="button" class="plain" id="queueResume">Resume</button>`;
    if (next) buttons += `<button type="button" class="plain" id="queueSkip">Skip this car</button>`;
    buttons += `<button type="button" class="plain" id="queueStop">Stop queue</button>`;
  }
  return `<div class="banner info queuebar" id="queueBar"><b>${esc(describeQueue(q))}</b>${next && !active ? ` · next: ${esc(nameOf(next))}` : ''}<div class="actions">${buttons}</div></div>`;
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
  if (!state.map) state.map = FORM_MAP;
  await loadSaved();
  if (state.step === 'checking' || state.step === 'filling') state.step = state.vehicle ? 'review' : 'idle';
  render();
  if (state.step === 'publish' && state.fbTabId) startWatcher();
}

// Which colors the website gives no usable word for (blank, or a word that
// isn't on Facebook's list, like "Sepia").
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
  const rw = await rewriteWithKey(base);
  try {
    const r = await guessColorsWithBackend({ endpoint: rw.endpoint, key: rw.key, photos, options: COLORS });
    state.colorGuess = r.ok ? { exterior: need.exterior ? r.exterior : '', interior: need.interior ? r.interior : '', confidence: r.confidence, model: r.model } : { error: r.error };
  } catch (e) {
    state.colorGuess = { error: String((e && e.message) || e) };
  }
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

// The vehicle as the description writer should see it: a guessed color
// fills in only where the website gives none.
function vehicleForText() {
  const v = state.vehicle;
  const g = state.colorGuess || {};
  return { ...v, exteriorColor: v.exteriorColor || g.exterior || '', interiorColor: v.interiorColor || g.interior || '' };
}

async function generate({ useClaude } = {}) {
  const s = state.settings;
  const rewrite = await rewriteWithKey(useClaude === undefined ? s.rewrite : { ...s.rewrite, enabled: useClaude });
  const settings = { ...s, rewrite };
  const r = await generateDescription({ vehicle: vehicleForText(), dealer: s.dealer, salesperson: s.salesperson, priceNote: noteFor(), price: state.price, boilerplate: state.boilerplate, settings, origin: state.origin }); // the origin tells the service which store this is
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

// probeOnly: open the form and only report which fields can be found (the
// first-run dry run); otherwise open it and fill it in.
async function openForm({ probeOnly = false } = {}) {
  const k = siteKeys(state.origin);
  const fresh = await chrome.storage.local.get([k.posted, k.sync]); // as they are now: the popup may have marked cars meanwhile, and a sync may have counted more
  state.posted = fresh[k.posted] || state.posted;
  state.syncState = fresh[k.sync] || state.syncState;
  const cap = dailyCap();
  if (cap.reached) {
    setStatus(`Daily post cap reached (${cap.used} of ${cap.cap} today). It resets tomorrow; the dealer can change it in Settings.`, 'error');
    return;
  }
  const box = $('description');
  if (box) state.description = box.value;
  state.guardrails = runGuardrails(state.description, ctx());
  state.listing = buildListingData(state.vehicle, { dealer: state.settings.dealer, defaults: state.settings.defaults, guesses: state.colorGuess, description: state.description, price: state.price, photos: state.vehicle.photos });
  state.step = 'filling';
  state.message = 'Opening the Marketplace form in a new tab…';
  setStatus('');
  render();
  await saveFlow();
  await pilotNote((p) => notePostStep(p, state.vin, 'formOpenedAt'));
  try {
    const devOverrides = (await chrome.storage.local.get(GLOBAL_KEYS.devOverrides))[GLOBAL_KEYS.devOverrides]; // test hook: addresses and timings only, see formMap.js
    state.map = applyOverrides(FORM_MAP, devOverrides);
    const tab = await chrome.tabs.create({ url: state.map.createUrl, active: true });
    state.fbTabId = tab.id;
    await waitForTabLoad(tab.id);
    await sleep(state.map.settleMs ?? FORM_MAP.settleMs);
    if (probeOnly) await runProbe();
    else await runFill();
  } catch (e) {
    state.step = 'review';
    state.message = '';
    setStatus(String((e && e.message) || e), 'error');
    render();
    await saveFlow();
  }
}

async function runFill() {
  state.message = 'Filling in the form…';
  render();
  try {
    const [inj] = await chrome.scripting.executeScript({ target: { tabId: state.fbTabId }, func: fillFormInPage, args: [state.map, { fields: state.listing.fields, match: state.listing.match || {} }] });
    state.fill = (inj && inj.result) || { filled: [], partial: [], blocked: [], photoLimit: { value: state.map.photoLimitDefault, verified: false } };
  } catch (e) {
    // e.g. no permission for this page: the form is open, so let the salesperson copy everything by hand
    state.fill = {
      filled: [], partial: [],
      blocked: state.map.fields.map((f) => ({ key: f.key, label: f.label, value: state.listing.fields[f.key] || '', reason: "couldn't run on this page: " + ((e && e.message) || e) })),
      photoLimit: { value: state.map.photoLimitDefault, verified: false },
    };
  }
  state.step = 'publish';
  state.detected = null;
  state.message = '';
  render();
  await saveFlow();
  await pilotNote((p) => notePostStep(noteFill(p, { vin: state.vin, fill: state.fill, mapVersion: state.map.version, version: VERSION }), state.vin, 'filledAt'));
  startWatcher();
  await attachPhotos();
}

// Read-only: which fields the map can find on the open page. Nothing is filled.
async function runProbe() {
  state.step = 'filling';
  state.message = 'Checking the form (nothing is filled)…';
  render();
  try {
    const [inj] = await chrome.scripting.executeScript({ target: { tabId: state.fbTabId }, func: probeFormInPage, args: [state.map] });
    state.probe = { ...((inj && inj.result) || { error: 'no result came back', found: [], missing: [], controls: [] }), extensionVersion: VERSION };
  } catch (e) {
    state.probe = {
      error: "couldn't run on this page: " + ((e && e.message) || e),
      found: [], controls: [],
      missing: state.map.fields.map((f) => ({ key: f.key, label: f.label, patterns: f.name })),
    };
  }
  state.step = 'probe';
  state.message = '';
  render();
  await saveFlow();
}

async function attachPhotos() {
  const limit = (state.fill && state.fill.photoLimit && state.fill.photoLimit.value) || state.map.photoLimitDefault;
  const urls = state.listing.photos.slice(0, limit);
  state.photos = { total: state.listing.photos.length, limit, verified: Boolean(state.fill && state.fill.photoLimit && state.fill.photoLimit.verified), attached: 0, failed: [], done: false, error: null };
  render();
  for (let i = 0; i < urls.length && !state.photos.error; i += 4) {
    const batch = urls.slice(i, i + 4);
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'downloadPhotos', urls: batch, offset: i });
    } catch (e) {
      state.photos.error = 'Downloading photos failed: ' + ((e && e.message) || e);
      break;
    }
    const photos = (res && res.photos) || [];
    for (const p of photos.filter((p) => !p.ok)) state.photos.failed.push({ url: p.url, error: p.error });
    const good = photos.filter((p) => p.ok).map(({ name, type, dataUrl }) => ({ name, type, dataUrl }));
    if (good.length) {
      try {
        const [inj] = await chrome.scripting.executeScript({ target: { tabId: state.fbTabId }, func: attachPhotosInPage, args: [state.map, good] });
        const r = inj && inj.result;
        if (r && r.ok) state.photos.attached += r.attached;
        else state.photos.error = (r && r.reason) || "couldn't attach the photos";
      } catch (e) {
        state.photos.error = 'Attaching photos failed: ' + ((e && e.message) || e);
      }
    }
    render();
  }
  state.photos.done = true;
  render();
  await saveFlow();
}

function startWatcher() {
  if (watcher) watcher.cancel();
  watcher = watchForListing({ tabId: state.fbTabId, listingUrlPattern: state.map.listingUrlPattern, afterPublishPatterns: state.map.afterPublishPatterns });
  watcher.promise.then((r) => {
    if (state.step !== 'publish') return;
    if (r.status === 'listing' || r.status === 'probably' || r.status === 'closed') {
      state.detected = r;
      // In a queue, a listing address means the person clicked Publish: record it and load the next car.
      if (state.queueMode && r.status === 'listing') return confirmPosted();
      render();
      saveFlow();
    }
  });
}

async function confirmPosted() {
  const typed = (($('listingUrl') && $('listingUrl').value) || '').trim();
  const listingUrl = /^https?:\/\//i.test(typed) ? typed : (state.detected && state.detected.url) || '';
  const now = new Date().toISOString();
  const extra = { postedWith: 'lotsync', salesperson: state.settings.salesperson.name || '' };
  if (listingUrl) extra.listingUrl = listingUrl;
  try {
    // recorded into the list as it is stored now: the popup may have marked or unmarked cars while this one was on the form
    state.posted = await updateKey(siteKeys(state.origin).posted, (fresh) => markPosted(fresh || {}, state.vehicle, state.settings.basis, now, extra), panelStorage);
  } catch (e) {
    setStatus(storageErrorText(e), 'error'); // the post is on Facebook; the panel stays here so it can be recorded once there is room
    return;
  }
  await pilotNote((p) => endPost(p, state.vin, 'posted', { at: now }));
  // the dealership's shared registry (accounts only): the worker syncs; nothing here waits for it
  if (accountsConfigured()) chrome.runtime.sendMessage({ type: 'syncNow', origin: state.origin }).catch(() => {});
  if (watcher) watcher.cancel();
  if (state.queueMode) return afterQueueStep('posted');
  state.step = 'done';
  state.doneAt = now;
  render();
  await saveFlow();
}

async function notPosted() {
  if (watcher) watcher.cancel();
  await pilotNote((p) => endPost(p, state.vin, 'not-posted'));
  state.step = 'review';
  state.fill = null;
  state.photos = null;
  state.detected = null;
  render();
  await saveFlow();
}

// The full decode from NHTSA's free service. Chrome asks the salesperson for
// the vpic.nhtsa.dot.gov permission the first time (optional_host_permissions).
async function checkVinOnline() {
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [NHTSA_ORIGIN + '/' + '*'] }); // split so the guard test's comment stripper never sees a block-comment opener
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
  const urls = state.listing ? state.listing.photos : state.vehicle.photos;
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
  setStatus(`${n} of ${urls.length} photos downloaded to your Downloads folder.`);
}

// ---------- rendering ----------

function checksHtml(g) {
  if (!g) return '';
  if (g.ok) return `<div class="checks ok" id="checks">All checks passed: ${g.words} words, every number matches the website, no banned phrases, dealership named.</div>`;
  return `<div class="checks bad" id="checks">Fix before posting:<ul>${g.problems.map((p) => `<li>${esc(p.text)}</li>`).join('')}</ul></div>`;
}

function sourcePill() {
  const map = { template: ['', 'Template'], claude: ['claude', 'Claude draft'], edited: ['', 'Edited by you'] };
  const [tone, label] = map[state.descriptionSource] || ['', state.descriptionSource];
  return `<span class="pill ${tone}">${esc(label)}</span>`;
}

function viewIdle() {
  return `<p class="lead">Open your dealership's used inventory page, click the Lot Sync icon, pick a car on <b>Ready to post</b> and click <b>Post</b>. This panel then pre-fills the Marketplace form for you to check and publish.</p>
  <p class="hint">Facebook and Marketplace are named here only as the places you post. Lot Sync is not affiliated with Meta.</p>`;
}

function viewChecking() {
  return `<p class="lead">Re-checking <b>${esc(state.vin)}</b> on the website: still pre-owned, still on the lot, still priced.</p><p class="hint">${esc(state.message || '')}</p>`;
}

function viewBlocked() {
  const buttons = state.queueMode
    ? `<button type="button" class="primary" id="skipBlocked">Skip this car, next</button><button type="button" class="plain" id="queueStop">Stop queue</button>`
    : `<button type="button" class="plain" id="back">Back</button>`;
  return `<div class="banner bad">${esc(state.message)}</div><div class="actions">${buttons}</div>`;
}

const currentListing = () => state.listing || buildListingData(state.vehicle, { dealer: state.settings.dealer, defaults: state.settings.defaults, guesses: state.colorGuess, description: state.description, price: state.price, photos: state.vehicle.photos });

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
  return `<table class="fields">${rows}<tr><td>Photos</td><td>${l.photos.length} from the website</td></tr></table>${locationHint}${colorHint}`;
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
      .map((r) => `<tr class="${r.verdict === 'differ' ? 'missing' : ''}"><td>${esc(r.field)}</td><td>${esc(r.website) || '—'}</td><td>${esc(r.vin) || '—'} ${r.verdict === 'agree' ? '✓' : r.verdict === 'differ' ? '✗' : ''}</td></tr>`)
      .join('')}</table>
      <p class="hint">${on.compare.ok ? 'NHTSA agrees with the website on everything it knows about this VIN.' : `${on.compare.differ.length} difference(s) between the website and the VIN: check the car before posting.`}</p>`;
  } else if (on && !on.ok) {
    html += `<div class="banner warn">NHTSA check failed: ${esc(on.error)}</div>`;
  }
  html += `<div class="actions"><button type="button" class="plain" id="checkVinOnline">${on && on.ok ? 'Check again with NHTSA' : 'Check with NHTSA (free government decoder)'}</button></div>
    <p class="hint">The checks above need no internet. The NHTSA check reads make, model, body, fuel, engine and drive from the VIN; Chrome asks for permission to reach vpic.nhtsa.dot.gov the first time. The VIN never changes what gets posted by itself; it flags what to look at.</p></section>`;
  return html;
}

// The two fields the website can't give: filled from the dealership's
// defaults (and said so), or left for the person when there is no default or
// the website's own text says the title is branded.
function assumptionsHtml() {
  const l = currentListing();
  let html = '';
  if (l.assumed.length) {
    html += `<section class="highlight" id="assumed"><h3>Filled from your dealership's defaults</h3><ul class="list">${l.assumed.map((b) => `<li><b>${esc(b.label)}</b>: ${esc(b.value)} <span class="why">${esc(b.why)}</span></li>`).join('')}</ul></section>`;
  }
  if (l.leftBlank.length) {
    html += `<section class="highlight" id="leftBlank"><h3>You fill in yourself</h3><ul class="list">${l.leftBlank.map((b) => `<li><b>${esc(b.label)}</b> <span class="why">${esc(b.why)}</span></li>`).join('')}</ul></section>`;
  }
  return html;
}

function carCard() {
  const v = state.vehicle;
  const mainText = `website's main price${v.priceLabel ? ', "' + esc(v.priceLabel) + '"' : ''}`;
  const basis = state.settings.basis === 'beforeFees'
    ? (state.noteApplies === false ? `${mainText}; this car shows no lower second price, so the price note is left out` : 'the lower second price the website shows')
    : mainText;
  return `<section class="car" id="vehicle">
    <div class="name">${esc(v.name)}</div>
    <div class="facts">${[v.stock && 'Stock ' + esc(v.stock), miles(v.mileage), v.carfaxOneOwner ? 'Carfax one owner' : v.carfaxUrl ? 'Carfax' : 'No Carfax', esc(v.locationShort || v.location || '')].filter(Boolean).join(' · ')}</div>
    <div class="posting">Posting at <b>${money(state.price)}</b> (${basis})${v.url ? ` · <a href="${esc(v.url)}" target="_blank" rel="noopener">website page</a>` : ''}</div>
  </section>`;
}

const capHtml = (cap) => `<div class="cap ${cap.reached ? 'reached' : ''}" id="cap">${cap.used} of ${cap.cap} posts today${cap.reached ? ' · cap reached' : ''}</div>`;

function viewReview() {
  const cap = dailyCap();
  const rw = state.settings.rewrite;
  return `${carCard()}
  <section>
    <h3>Description ${sourcePill()}</h3>
    ${state.note ? `<div class="banner warn">${esc(state.note)}</div>` : ''}
    <textarea id="description" spellcheck="true">${esc(state.description)}</textarea>
    ${checksHtml(state.guardrails)}
    <div class="actions">
      <button type="button" class="plain" id="rewrite" ${rw.enabled && rw.endpoint ? '' : 'disabled title="Turn on the rewrite service in Settings first"'}>Rewrite with Claude</button>
      <button type="button" class="plain" id="resetTemplate">Reset to template</button>
      <button type="button" class="plain" id="copyDescription">Copy</button>
    </div>
    <p class="hint">Edit anything you like; your edits are kept. Facts only: every number is checked against the website.</p>
  </section>
  <section><h3>What Lot Sync will fill in</h3>${fieldsTable()}</section>
  ${vinCheckHtml()}
  ${assumptionsHtml()}
  <section>
    ${capHtml(cap)}
    <button type="button" class="primary wide" id="openForm" ${cap.reached ? 'disabled' : ''}>Open the Marketplace form</button>
    <p class="hint">Opens the create-listing page in a new tab and fills in the fields above. Then you check everything, including condition and title, and click Publish yourself.</p>
    <button type="button" class="plain wide" id="checkForm" ${cap.reached ? 'disabled' : ''}>Open the form and check fields only (nothing filled)</button>
    <p class="hint">For the first run: the panel reports which fields it can find on the page, without filling anything. You can fill it in from there.</p>
  </section>`;
}

function viewProbe() {
  const p = state.probe || {};
  const found = p.found || [];
  const missing = p.missing || [];
  const controls = p.controls || [];
  const limit = p.photoLimit ? `${p.photoLimit.value}${p.photoLimit.verified ? '' : ' (unverified)'}` : '?';
  return `${carCard()}
  <div class="banner info">Nothing was filled. This is what Lot Sync can see on the form (map ${esc(p.mapVersion || state.map.version)}, Lot Sync ${esc(p.extensionVersion || VERSION)}).</div>
  ${p.error ? `<div class="banner bad">${esc(p.error)}</div>` : ''}
  ${languageHint(p.language, !found.some((f) => f.tag))}
  <section id="probeResults">
    <h3>Found <span class="pill good">${found.length}</span></h3>
    ${found.length ? `<ul class="list">${found.map((f) => `<li>${esc(f.label)} <span class="why">${esc(f.tag)}${f.role ? '[' + esc(f.role) + ']' : ''}: "${esc(f.name)}"</span></li>`).join('')}</ul>` : '<p class="hint">None of the fields were found.</p>'}
    ${missing.length ? `<section class="highlight"><h3>Not found <span class="pill bad">${missing.length}</span></h3><ul class="list">${missing.map((m) => `<li><b>${esc(m.label)}</b> <span class="why">looked for ${esc((m.patterns || []).join(' or '))}</span></li>`).join('')}</ul><p class="hint">Copy the report and send it to whoever maintains formMap.js; each fix is one name pattern.</p></section>` : ''}
    <p class="hint">Photo upload: ${p.fileInputs ?? '?'} file input(s) on the page · limit ${esc(limit)}${p.photoText ? ` · the page says: "${esc(p.photoText)}"` : ''}</p>
    <details><summary>Controls on the page (${controls.length})</summary><ul class="list">${controls.map((c) => `<li>${esc(c.tag)}${c.type ? '[' + esc(c.type) + ']' : ''}${c.role ? '[' + esc(c.role) + ']' : ''}: "${esc(c.name)}"</li>`).join('')}</ul></details>
  </section>
  <div class="actions">
    <button type="button" class="primary" id="fillNow" ${found.length ? '' : 'disabled'}>Fill it in now</button>
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

function photosHtml() {
  const p = state.photos;
  if (!p) return '<div id="photos">Preparing photos…</div>';
  const limitNote = p.total > p.limit ? ` (the form takes ${p.limit}${p.verified ? '' : ', unverified'}; the first ${p.limit} were used)` : '';
  let html = `<div id="photos" class="${p.done ? 'done' : ''}">${p.attached} of ${Math.min(p.total, p.limit)} attached${p.done ? '' : '…'}${limitNote}</div>`;
  if (p.failed.length) html += `<p class="hint">${p.failed.length} couldn't be downloaded.</p>`;
  if (p.error) html += `<div class="banner warn">${esc(p.error)} Use <b>Download photos</b> and add them by hand.</div>`;
  return html;
}

function viewPublish() {
  const f = state.fill || { filled: [], partial: [], blocked: [], skipped: [] };
  const skipped = f.skipped || [];
  const pre = f.preexisting || [];
  const preexisting = pre.length
    ? `<div class="banner bad" id="preexisting"><b>This form already held another vehicle before Lot Sync filled it:</b> ${pre.map((p) => `${esc(p.label)} "${esc(p.shown)}"`).join(', ')}. That is probably a draft Facebook restored. Lot Sync replaced the fields it manages (check each one below), but photos and anything else from that draft may still be on the form. Remove them, or discard the draft on Facebook and click <b>Fill again</b>, before you publish.</div>`
    : '';
  const changed = f.changedAfterFill || [];
  const changedBanner = changed.length
    ? `<div class="banner bad" id="changedAfterFill"><b>Facebook changed ${changed.map((c) => `${esc(c.label)} to "${esc(c.was)}"`).join(', ')} a few seconds after Lot Sync filled it.</b> That is a saved draft being restored over the form. Lot Sync set ${changed.every((c) => c.held) ? 'them again and they held' : 'them again, but not all of them held (see Couldn\'t fill)'}. Check every field below, and delete that draft on Facebook (Marketplace → Your listings → Drafts) so it stops coming back.</div>`
    : '';
  const d = state.detected;
  let detect = '';
  if (d && (d.status === 'listing' || d.status === 'probably')) {
    detect = `<div class="banner good" id="detected">Looks like it posted${d.url ? '' : ' (the listing page opened)'}. Confirm below to record it.</div>`;
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
  <div class="banner info">The form is filled in. Check every field, including <b>Vehicle condition</b> and <b>Title status</b> (from your dealership's defaults), then click <b>Publish</b>${state.queueMode ? ' (or <b>Save draft</b>)' : ''} on Facebook yourself.${state.queueMode ? ' When it posts, the next car loads by itself.' : ''}</div>
  <section id="fillResults">
    <h3>Filled in <span class="pill good">${f.filled.length}</span> <span class="why">as the form shows them</span></h3>
    ${f.filled.length ? `<ul class="list">${f.filled.map((x) => `<li>${esc(x.label)}: ${esc(x.shown || x.value).slice(0, 80)}${x.note ? ` <span class="why">${esc(x.note)}</span>` : ''}</li>`).join('')}</ul>` : '<p class="hint">Nothing could be filled.</p>'}
    ${f.partial.length ? `<h3>Needs a click <span class="pill warn">${f.partial.length}</span></h3><ul class="list">${f.partial.map((x) => `<li>${esc(x.label)}: ${esc(x.value)} <span class="why">${esc(x.note || '')}</span></li>`).join('')}</ul>` : ''}
    ${skipped.length ? `<p class="hint">Left alone: ${skipped.map((x) => `${esc(x.label)} (${esc(x.reason)})`).join('; ')}.</p>` : ''}
  </section>
  ${f.blocked.length ? `<section class="highlight"><h3>Couldn't fill <span class="pill bad">${f.blocked.length}</span></h3><ul class="list">${f.blocked.map((x) => `<li><b>${esc(x.label)}</b>${x.value ? ': ' + esc(x.value).slice(0, 80) + copyBtn(x.value) : ''} <span class="why">${esc(x.reason)}</span>${
    x.candidates && x.candidates.length ? `<div class="why">Similar controls on the page: ${x.candidates.map((c) => `${esc(c.tag)}${c.role ? '[' + esc(c.role) + ']' : ''}${c.type ? '[' + esc(c.type) + ']' : ''}${c.haspopup ? '[popup ' + esc(c.haspopup) + ']' : ''}${c.editable ? '[editable]' : ''} "${esc(c.name || c.near)}"`).join('; ')}</div>` : ''
  }</li>`).join('')}</ul><p class="hint">Copy the report (Copy report on the dry run, or this list) and send it to whoever maintains formMap.js.</p></section>` : ''}
  <section><h3>Photos</h3>${photosHtml()}
    <div class="actions"><button type="button" class="plain" id="downloadPhotos">Download photos</button><button type="button" class="plain" id="fillAgain">Fill again</button><button type="button" class="plain" id="copyDescription">Copy description</button></div>
  </section>
  <section>${detect}
    <label class="block">Listing link (optional) <input type="url" id="listingUrl" value="${esc((d && d.url) || '')}" placeholder="paste the listing's address if you have it" /></label>
    <div class="actions">${outcome}</div>
  </section>`;
}

function viewDone() {
  const p = state.posted[state.vin] || {};
  return `<div class="banner good" id="done">Recorded: <b>${esc(state.vehicle.name)}</b> at ${money(p.price)}, ${esc(when(state.doneAt))}. It's now under <b>My listings</b> in the popup, and every rescan will tell you if it sells or the website price changes.</div>
  ${p.listingUrl ? `<p><a href="${esc(p.listingUrl)}" target="_blank" rel="noopener">Open the listing</a></p>` : ''}
  <button type="button" class="primary wide" id="postAnother">Post another car</button>`;
}

function render() {
  $('site').textContent = state.siteName || '';
  const views = { idle: viewIdle, checking: viewChecking, blocked: viewBlocked, review: viewReview, filling: viewFilling, probe: viewProbe, publish: viewPublish, done: viewDone, queueDone: viewQueueDone, wizard: wizardHtml };
  if (state.step === 'wizard') {
    $('panel').innerHTML = wizardHtml();
    return;
  }
  if (state.step === 'upkeep') {
    $('panel').innerHTML = upkeepHtml();
    return;
  }
  $('panel').innerHTML = queueBar() + (views[state.step] || viewIdle)();
}

const upkeepCtx = {
  render: () => { if (state.step === 'upkeep') render(); }, // a late poll never redraws another step's view
  map: () => state.map || FORM_MAP,
  onClose: () => { state.step = 'idle'; render(); },
};

// A post that is under way (a car being checked, reviewed, filled or waiting
// for Publish) is not abandoned for a to-do item; the person finishes or
// stops it first.
const LIVE_STEPS = ['checking', 'review', 'filling', 'probe', 'publish'];
const postUnderWay = () => Boolean(state.vin) && LIVE_STEPS.includes(state.step);

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

// ---------- events ----------

let inputTimer = null;
function onInput(ev) {
  if (ev.target.id !== 'description') return;
  clearTimeout(inputTimer);
  inputTimer = setTimeout(() => {
    state.description = ev.target.value;
    state.descriptionSource = 'edited';
    state.note = '';
    state.guardrails = runGuardrails(state.description, ctx());
    const old = $('checks');
    if (old) old.outerHTML = checksHtml(state.guardrails);
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
  if (state.step === 'wizard' && (await handleWizardClick(btn.id, wizardCtx))) return undefined;
  if (state.step === 'upkeep' && (await handleUpkeepClick(btn.id, upkeepCtx))) return undefined;
  switch (btn.id) {
    case 'openForm': return openForm();
    case 'checkForm': return openForm({ probeOnly: true });
    case 'checkVinOnline': return checkVinOnline();
    case 'guessColors': {
      btn.disabled = true;
      setStatus('Looking at the photos…');
      await maybeGuessColors(true);
      await generate();
      setStatus(state.colorGuess && state.colorGuess.error ? '' : 'Colors guessed from the photos; check them on the form.');
      render();
      return saveFlow();
    }
    case 'fillNow': return runFill();
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
    case 'resetTemplate':
      await generate({ useClaude: false });
      render();
      return saveFlow();
    case 'copyDescription': return copy(state.description);
    case 'fillAgain': return runFill();
    case 'downloadPhotos': return downloadPhotos();
    case 'confirmPosted': return confirmPosted();
    case 'notPosted': return notPosted();
    case 'savedDraft': return savedDraft();
    case 'skipCar':
    case 'skipBlocked': return afterQueueStep(btn.id === 'skipBlocked' ? 'blocked' : 'skipped');
    case 'queueNext': return startNextInQueue();
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
      if (state.queueMode && state.vin && state.step !== 'idle') return afterQueueStep('skipped');
      state.queue = advance(state.queue, 'skipped');
      await saveQueue();
      if (state.queue.status === 'done') state.step = 'queueDone';
      return render();
    case 'queueStop':
    case 'queueClear':
      if (watcher) watcher.cancel();
      state.queue = null;
      await saveQueue();
      await clearFlow();
      setStatus(btn.id === 'queueStop' ? 'Queue stopped. Posted cars stay recorded.' : '');
      return render();
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

const handlers = { [GLOBAL_KEYS.postRequest]: startFlow, [GLOBAL_KEYS.setupRequest]: openWizard, [GLOBAL_KEYS.upkeepRequest]: openUpkeep };

// Changes to this website's posted list, drafts, queue and settings made by
// the popup or the service worker are adopted here, so the cap, the queue
// bar and the next car's record are current without reopening the panel.
// The panel's own writes echo back too: they are marked (ownSet), and a value
// the panel already holds is not a change. What is redrawn: steps without a
// text box are redrawn whole; on review and publish only the queue bar and
// the cap line are replaced, so the description and the listing link the
// person is typing stay put; the wizard and upkeep draw their own views.
// When the popup stops the queue while a car is under way, that car can
// still be finished; afterQueueStep then finds no queue and stops.
const INPUT_STEPS = ['review', 'publish'];
const OWN_VIEW_STEPS = ['wizard', 'upkeep'];
function adoptChanges(changes) {
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
  take(k.drafts, 'drafts', {});
  take(k.sync, 'syncState', null); // the server's count of today's posts feeds the cap line
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
    for (const id of ['openForm', 'checkForm']) { const b = $(id); if (b) b.disabled = cap.reached; }
  }
}

async function init() {
  $('panel').addEventListener('click', onClick);
  $('panel').addEventListener('input', onInput);
  $('panel').addEventListener('change', (ev) => { if (state.step === 'wizard') handleWizardChange(ev.target); });
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
  const stored = await chrome.storage.local.get([...REQUEST_KEYS, GLOBAL_KEYS.lastPostOrigin]);
  // the newest request for this window wins; every request key is cleared
  // once one is acted on, so nothing stale fires on a later panel load
  const pending = REQUEST_KEYS.map((name) => ({ name, req: stored[name] })).filter(({ req }) => forThisWindow(req) && isFresh(req)).sort((a, b) => (b.req.at || 0) - (a.req.at || 0));
  const stale = REQUEST_KEYS.filter((name) => stored[name] && !isFresh(stored[name]));
  if (stale.length) await chrome.storage.local.remove(stale);
  if (pending.length) {
    await chrome.storage.local.remove(REQUEST_KEYS);
    return handlers[pending[0].name](pending[0].req);
  }
  const lastPostOrigin = stored[GLOBAL_KEYS.lastPostOrigin];
  if (lastPostOrigin) {
    // a post under way comes back first; an unfinished set-up only when nothing else is going on
    const k = siteKeys(lastPostOrigin).flow;
    const flow = (await chrome.storage.local.get(k))[k];
    if (flow && flow.step && flow.step !== 'idle') return resumeFlow(lastPostOrigin, flow);
    if (await resumeWizard(lastPostOrigin)) {
      state.origin = lastPostOrigin;
      state.dealerTabId = wiz.dealerTabId;
      await loadSaved();
      state.step = 'wizard';
      return render();
    }
    state.origin = lastPostOrigin;
    await loadSaved();
  }
  render();
}

init();
