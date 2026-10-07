import { assessVehicle, DECISION } from './src/classify.js';
import { makeSnapshot, diffScans, markPosted, markPriceUpdated, markTakenDown, basisPrice, listingLine, settleDiff, postedBasis, withPostedBasis, markLookDismissed, withWithheld, withheldOffer, acceptWithheld, scanCar, priceItemWaits } from './src/rescan.js';
import { draftPrice, markDraftPosted, draftPriceUpdate, withPriceUpdate, draftPill, draftScanCar } from './src/drafts.js';
import { performScan, keepSeenBasis } from './src/scanRunner.js';
import { todoCountFor, originsFor } from './src/rescanSchedule.js';
import { askChrome } from './src/askChrome.js';
import { defaultSettings, withDefaults, feeGap, suggestedPriceNote, loadProfile, saveProfile, settingsFromProfile, showsLowerPrice, chooseBasis, basisChangeNote, PROFILE_KEY, DEFAULT_SALESPERSON_TITLE, NO_DEALER_NAME, dealerNameMissing } from './src/settings.js';
import { capStatus, capCount, logPost, askWhenListed, DEFAULT_DAILY_CAP } from './src/cap.js';
import { noteTakenDown, stillListedNow } from './src/takenDown.js';
import { TITLE_STATUSES, CONDITIONS } from './src/listingData.js';
import { checkClosingLine, cleanClosingLine, CLOSING_LINE_MAX_WORDS, settingNumberWarning, settingNumberNotice, priceNoteWarning, priceNoteNotice } from './src/rewriteTemplate.js';
import { createQueue, currentVin, describe as describeQueue } from './src/queue.js';
import { FORM_MAP, applyOverrides } from './facebook/formMap.js';
import { listingLink } from './facebook/detectPost.js';
import { recordFlags, resolveFlag, updatePilot, summarizePilot, pilotText, pilotCsv, pilotFileName, hasPilotData } from './src/pilot.js';
import { LEGAL, acceptLegal, legalIsCurrent, legalHosted } from './src/legalLinks.js';
import { POSTING_RULES } from './src/postingRules.js';
import { siteKeys, GLOBAL_KEYS, SITES_KEY } from './src/storageKeys.js';
import { updateKey, withLock, storageErrorText } from './src/storage.js';
import { ACCOUNT, accountsConfigured } from './src/accountConfig.js';
import { signInStart, signInFinish, currentSession, signOutAll, rewriteEndpointFor, describeSync, planText, NOT_CONFIGURED } from './src/accountFlow.js';
import { clearNumbersKeepingUnsynced } from './src/sync.js';
import { loadSession, redeemInvite } from './src/account.js';
import { SORT_ORDERS, sortOrder, newDaysOf, isNew, dateLine, filterText, sortEntries, MIN_NEW_DAYS, MAX_NEW_DAYS, DEFAULT_NEW_DAYS } from './src/readyList.js';

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => (typeof n === 'number' && Number.isFinite(n) ? '$' + Math.round(n).toLocaleString('en-US') : '—');
const signedMoney = (n) => (n < 0 ? '−' : '+') + money(Math.abs(n));
const miles = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') + ' mi' : 'no mileage');
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const day = (iso) => (iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '');
const dateOnly = (iso) => (iso ? new Date(iso).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) : '');

const state = {
  tab: null,
  origin: null, // the dealer website this popup is working on
  siteName: '',
  snapshot: null, // last saved scan
  diff: null, // to-do list from the last scan
  posted: {}, // cars this salesperson marked as posted: { vin: { name, price, postedAt, listingUrl?, salesperson? } }; with an account, colleagues' too, marked `mine: false` by sync
  postLog: [], // today's posts recorded on this computer, those taken down or unmarked since included: the cap counts them (src/cap.js)
  settings: null, // see src/settings.js
  settingsFromProfile: false, // true until the first scan checks the profile's store names against this website
  boilerplate: [],
  queue: null, // the batch queue (src/queue.js), shared with the side panel
  drafts: {}, // cars saved as drafts on Facebook during a queue: { vin: { name, savedAt, price, basis } } (src/drafts.js)
  wizardDone: false, // set-up finished (or skipped) for this website
  wizardActive: false, // set-up started in the side panel and not finished
  site: null, // this website's entry in the background-rescan registry (src/scanRunner.js SITES_KEY)
  pilot: null, // pilot numbers (src/pilot.js): post timings, fill failures per field, to-do item durations
  takenDown: null, // the posts this salesperson took off their posted list (src/takenDown.js): the cap counts the day's ones the day's log never had (src/cap.js dayLog)
  listingMap: FORM_MAP, // the form map's addresses (with the test hook's, devOverrides): which saved links are a listing's own (listingHref)
  syncState: null, // this website's sync state (src/sync.js nextSyncState): dealership, role, when it last synced, the plan, the server's count of today's posts (the cap reads it); accounts only
  account: { session: null, email: '', note: '', error: '' }, // the signed-in session (read only when accounts are configured) and what the Account section says
  rescanPermission: null, // true/false once known: may the service worker read this website?
  scanning: false,
  view: 'todo',
  readyFilter: '', // the Ready tab's search box, for as long as the popup is open
  markAsk: null, // the VIN whose Mark posted is asking "Posted today" or "Before today", for as long as the popup is open
  picked: new Set(), // the Ready tab's ticked cars (VINs), for as long as the popup is open: a tick survives the search box hiding its row and a redraw; the queue takes them all
};

// ---------- saved data (kept per website, in this browser only) ----------
// The keys are named in src/storageKeys.js: siteKeys(origin) is every key
// this website owns (the side panel's in-progress post included, so "Clear
// everything" clears it too); SITES_KEY is the background-rescan registry.

const rescanOrigins = () => (state.site ? originsFor(state.site.site || { origin: state.origin }, state.site.service) : []);

// What the last scan read about the website, for the blanks in the settings
// (withDefaults): nothing before the website's first scan, so a Settings
// save or a sign-in then never stores the website's address as the
// dealership's name; the first scan fills in the name the website gives.
const knownSite = () => state.snapshot?.site || {};

async function checkRescanPermission() {
  const origins = rescanOrigins();
  if (!origins.length) { state.rescanPermission = null; return; }
  try {
    state.rescanPermission = await chrome.permissions.contains({ origins });
  } catch (e) {
    state.rescanPermission = false;
  }
}

async function loadSaved() {
  const k = siteKeys(state.origin);
  const data = await chrome.storage.local.get([...Object.values(k), SITES_KEY, GLOBAL_KEYS.devOverrides]);
  state.snapshot = data[k.snapshot] || null;
  state.diff = data[k.diff] || null;
  state.posted = data[k.posted] || {};
  state.postLog = data[k.postLog] || [];
  const site = state.snapshot?.site || {};
  if (data[k.settings]) {
    state.settings = withDefaults(data[k.settings], site);
    state.settingsFromProfile = false;
  } else {
    // a website without settings yet: start from the person's synced profile
    state.settings = settingsFromProfile(await loadProfile(), { ...site, origin: state.origin });
    state.settingsFromProfile = Boolean(state.settings);
  }
  state.boilerplate = data[k.boilerplate] || [];
  state.queue = data[k.queue] || null;
  state.drafts = data[k.drafts] || {};
  state.wizardDone = Boolean(data[k.wizardDone]);
  state.wizardActive = Boolean(data[k.wizard] && data[k.wizard].active && data[k.wizard].step !== 'done');
  state.site = (data[SITES_KEY] || {})[state.origin] || null;
  state.pilot = data[k.pilot] || null;
  state.takenDown = data[k.takenDown] || null;
  state.syncState = data[k.sync] || null;
  state.listingMap = applyOverrides(FORM_MAP, data[GLOBAL_KEYS.devOverrides]); // test hook: addresses only, see formMap.js
  await checkRescanPermission();
}

// The popup's own storage writes come back through storage.onChanged like
// anyone else's; they are counted here so the listener can tell an echo
// from a change made by the side panel or the service worker. A write that
// failed (the quota) never echoes, so its note is taken back.
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

// Read-modify-writes go through src/storage.js under the key's lock, since
// the side panel and the service worker change the same keys (the posted
// list, the diff, the site registry); the write itself is ownSet, so the
// echo is ignored like any other own write.
const popupStorage = { get: (key) => chrome.storage.local.get(key), set: ownSet };

// The registry entry the service worker reads: auto on or off for this website.
async function setSiteAuto(auto) {
  let sites;
  try {
    sites = await updateKey(SITES_KEY, (current) => {
      if (!current || !current[state.origin]) return undefined;
      return { ...current, [state.origin]: { ...current[state.origin], auto: Boolean(auto) } };
    }, popupStorage);
  } catch (e) {
    setStatus(storageErrorText(e), 'error');
    return false;
  }
  if (!sites) return false;
  state.site = sites[state.origin];
  chrome.runtime.sendMessage({ type: 'ensureAlarm' }).catch(() => {});
  return true;
}

// Writes what the popup holds for these fields. False when the write failed
// (the status says why; the values stay on screen until the popup closes).
// Every key belongs to a website, so with none open nothing is written. The
// synced profile is not written here: only Save settings (onSettingsSubmit)
// and finishing set-up write it, so "Forget my synced profile" holds until
// the person saves again, as the popup and the privacy policy say.
const NO_SITE_TEXT = "Open your dealership's website in this tab first: settings are kept for each dealership website.";
async function save(...names) {
  if (!state.origin) {
    setStatus(NO_SITE_TEXT, 'error');
    return false;
  }
  const k = siteKeys(state.origin);
  const out = {};
  for (const name of names) out[k[name]] = state[name];
  try {
    await ownSet(out);
  } catch (e) {
    setStatus(storageErrorText(e), 'error');
    return false;
  }
  if (names.includes('diff') || names.includes('posted')) chrome.runtime.sendMessage({ type: 'updateBadge' }).catch(() => {});
  return true;
}

// Changes one of this website's fields from what is stored now (not from
// the popup's copy: the side panel may have recorded a post, the worker a
// rescan, since the popup opened), under the key's lock. `change` gets the
// stored value and returns the next one; undefined leaves the key alone.
async function update(name, change) {
  const key = siteKeys(state.origin)[name];
  try {
    const next = await updateKey(key, change, popupStorage);
    if (next !== undefined) state[name] = next;
  } catch (e) {
    setStatus(storageErrorText(e), 'error');
    return false;
  }
  if (name === 'diff' || name === 'posted') chrome.runtime.sendMessage({ type: 'updateBadge' }).catch(() => {});
  return true;
}

// The diff without one car's items in the given lists (a to-do item handled).
// Undefined when nothing is stored, so nothing is written.
function withoutVin(diff, vin, lists) {
  if (!diff || typeof diff !== 'object') return undefined;
  const next = { ...diff };
  for (const list of lists) if (Array.isArray(next[list])) next[list] = next[list].filter((x) => x.vin !== vin);
  return next;
}

function setStatus(text, kind = '') {
  const el = $('status');
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

// ---------- scanning ----------

function friendlyError(e) {
  const msg = String((e && e.message) || e);
  if (/cannot access|chrome:\/\/|extensions gallery|cannot be scripted|permission/i.test(msg)) {
    return "Can't read this page. Open your dealership's website (the used inventory page works best) and click Scan again.";
  }
  return 'Scan failed: ' + msg;
}

async function scan() {
  await initDone; // a click during start-up must not race the saved-data load
  if (!state.tab || !state.origin) {
    setStatus("Open your dealership's website in this tab first, then click Scan.", 'error');
    return;
  }
  state.scanning = true;
  $('scan').disabled = true;
  setStatus("Reading the website's used inventory…");
  try {
    const last = state.snapshot;
    const r = await performScan({ tabId: state.tab.id, origin: state.origin, settings: state.settings, settingsFromProfile: state.settingsFromProfile, snapshot: state.snapshot, posted: state.posted, boilerplate: state.boilerplate });
    if (!r.ok) {
      setStatus(r.message, 'error');
      return;
    }
    state.settings = r.settings;
    state.settingsFromProfile = false;
    state.boilerplate = r.boilerplate;
    if (!r.diff.unreliable) state.snapshot = r.snapshot; // keep the last good scan if this one looks broken
    state.siteName = r.site.name;
    // saved under the diff's lock, against the posted list as it is now: the
    // side panel may have finished a to-do item while this scan ran (src/rescan.js settleDiff).
    // A read judged a hiccup is held back with the diff, counted on from the
    // one saved before it (withWithheld): To do offers it once scans agree.
    const diffKey = siteKeys(state.origin).diff;
    const saved = await withLock(diffKey, async () => {
      const postedKey = siteKeys(state.origin).posted;
      const stored = await chrome.storage.local.get([postedKey, diffKey]);
      state.posted = stored[postedKey] || {};
      state.diff = withWithheld(settleDiff(r.diff, state.posted), r.snapshot, stored[diffKey]);
      return save('snapshot', 'diff', 'settings', 'boilerplate');
    });
    if (!saved) return; // the status says why (the quota); the read stays on screen
    // the price basis this read shows for a listing that has none, kept on it unless the read was held back (src/scanRunner.js keepSeenBasis)
    state.posted = (await keepSeenBasis(state.origin, last, r.snapshot, r.diff, popupStorage).catch(() => undefined)) || state.posted;
    state.pilot = await recordFlags(state.origin, state.diff, state.diff.takenAt).catch(() => state.pilot); // pilot numbers: when a to-do item first appeared
    syncInBackground(); // the scan's counts (marked withheld after a website hiccup) and the to-do items it flagged
    // the scan registered the website for background rescans; show its state
    state.site = ((await chrome.storage.local.get(SITES_KEY))[SITES_KEY] || {})[state.origin] || null;
    await checkRescanPermission();
    state.view = 'todo';
    setStatus('');
  } catch (e) {
    setStatus(friendlyError(e), 'error');
  } finally {
    state.scanning = false;
    render();
  }
}

// ---------- views ----------

function lists() {
  const all = Object.values(state.snapshot?.vehicles || {}).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const has = (e, code) => (e.blockers || []).includes(code);
  const posted = Object.entries(state.posted).map(([vin, p]) => ({ vin, ...p, now: state.snapshot?.vehicles?.[vin] || null }));
  return {
    all,
    ready: all.filter((e) => e.decision === DECISION.READY),
    notReady: all.filter((e) => e.decision === DECISION.NOT_READY && !has(e, 'other-store')),
    otherStores: all.filter((e) => e.decision === DECISION.NOT_READY && has(e, 'other-store')),
    review: all.filter((e) => e.decision === DECISION.REVIEW),
    skipped: all.filter((e) => e.decision === DECISION.SKIP),
    mine: posted.filter((p) => p.mine !== false),
    colleagues: posted.filter((p) => p.mine === false), // merged in by sync: shown, never the person's to update or take down
  };
}

// A colleague's listing, merged into the posted list by sync (`mine: false`,
// src/sync.js): it keeps the car off the Post buttons so nobody lists it
// twice, but updating or taking it down is theirs, so no button here acts on it.
const colleagueEntry = (vin) => {
  const p = state.posted[vin];
  return p && p.mine === false ? p : null;
};
const byWhom = (p) => (p.salesperson ? esc(p.salesperson) : 'a colleague');

const todoCount = () => todoCountFor(state.diff);

const VIEWS = [
  ['todo', 'To do'],
  ['ready', 'Ready to post'],
  ['notReady', 'Not ready'],
  ['otherStores', 'Other stores'],
  ['review', 'Needs a look'],
  ['mine', 'My listings'],
  ['pilot', 'Numbers'], // the view id and the storage key keep the pilot name: renaming the key would orphan installs
];

function renderTabs(l) {
  const counts = {
    todo: todoCount(),
    ready: l.ready.length,
    notReady: l.notReady.length,
    otherStores: l.otherStores.length,
    review: l.review.length + l.skipped.length,
    mine: l.mine.length,
  };
  $('tabs').innerHTML = VIEWS.filter(([id]) => id !== 'otherStores' || l.otherStores.length)
    .map(([id, label]) => {
      const c = counts[id];
      const badge = c === undefined ? '' : `<span class="count${id === 'todo' && c ? ' hot' : ''}">${c}</span>`;
      return `<button type="button" role="tab" data-view="${id}" aria-selected="${state.view === id}">${esc(label)}${badge}</button>`;
    })
    .join('');
}

function facts(e) {
  const bits = [];
  if (e.stock) bits.push('Stock ' + esc(e.stock));
  if (e.mileage !== undefined) bits.push(miles(e.mileage));
  if (/certified/i.test(e.type || '')) bits.push('Certified');
  if (e.carfax !== undefined) bits.push(e.carfax ? 'Carfax' : 'No Carfax');
  if (e.locationShort) bits.push(esc(e.locationShort));
  return bits.join(' · ');
}

// `tag` is HTML shown after the name (the New pill), `line` a third, small
// line under the facts (the car's date and where it came from).
function row(e, { sub = '', right = '', action = '', muted = false, pick = false, tag = '', line = '' } = {}) {
  const name = /^https?:\/\//i.test(e.url || '')
    ? `<a class="name" href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.name)}</a>`
    : `<span class="name">${esc(e.name)}</span>`;
  const box = pick ? `<input type="checkbox" class="pick" data-vin="${esc(e.vin)}" aria-label="Queue ${esc(e.name)}"${state.picked.has(e.vin) ? ' checked' : ''} />` : '';
  return `<li class="row${muted ? ' muted' : ''}">${box}<div class="main">${name}${tag}<div class="sub">${sub}</div>${line ? `<div class="when">${line}</div>` : ''}</div>${
    right ? `<div class="price">${right}</div>` : ''
  }${action}</li>`;
}

// ---------- new arrivals and the car's date (src/readyList.js) ----------

const readySort = () => sortOrder(state.settings?.readySort);
const newDays = () => newDaysOf(state.settings?.newDays);
const newOptions = (now = Date.now()) => ({ days: newDays(), now, posted: state.posted });
const newPill = (e, now = Date.now()) => (isNew(e, newOptions(now)) ? ` <span class="pill good new" title="Within the last ${newDays()} days, by the website's in-stock date or else the scan that first saw it">New</span>` : '');
const whenLine = (e, now = Date.now()) => esc(dateLine(e, { now }));

// The To do tab's New arrivals: every car the window says is new (the
// website's in-stock date, else the scan that first saw it; posted cars
// drop off), plus what the last scan found that was not on the website the
// time before (the rescan diff, as ever: a fact even when the website's own
// date is older than the window). Newest first.
function newArrivalItems(now = Date.now()) {
  const snap = state.snapshot?.vehicles || {};
  const byVin = new Map();
  for (const n of state.diff?.newArrivals || []) {
    if (state.posted[n.vin]) continue;
    byVin.set(n.vin, { ...(snap[n.vin] || {}), ...n });
  }
  for (const e of Object.values(snap)) {
    if (byVin.has(e.vin) || !isNew(e, newOptions(now))) continue;
    byVin.set(e.vin, { ...e, price: price(e) });
  }
  return sortEntries([...byVin.values()], 'newest', { basis: state.settings?.basis });
}
const readyArrivals = (items) => items.filter((n) => n.decision === DECISION.READY && !state.posted[n.vin]);

function rows(items) {
  return `<ul class="rows">${items.join('')}</ul>`;
}

function section(title, tone, items) {
  return `<h3>${esc(title)} <span class="pill ${tone}">${items.length}</span></h3>${rows(items)}`;
}

function empty(text) {
  return `<div class="empty">${text}</div>`;
}

// "Post" opens the guided flow in the side panel (only for ready cars). "Mark
// posted" is for a listing the salesperson made by hand, or published from a
// draft: the draft's pill shows the price it was filled with, and says so
// when the website's price moved (on a scan taken since the draft was
// filled: src/drafts.js draftScanCar) or the car is not ready any more.
function postButton(vin, { canPost = true } = {}) {
  const theirs = colleagueEntry(vin);
  if (theirs) return `<span class="pill" title="A colleague's listing: theirs to update or take down">Posted by ${byWhom(theirs)}</span>`;
  if (state.posted[vin]) return `<button type="button" class="small" data-action="unpost" data-vin="${esc(vin)}" title="Click to unmark. A post recorded today still counts toward today's cap.">Posted ✓</button>`;
  if (state.markAsk === vin) return markChoice(vin);
  if (state.drafts[vin]) {
    const pill = draftPill(state.drafts[vin], draftScanCar(state.drafts[vin], state.snapshot, vin), { basis: state.settings?.basis, ready: canPost });
    return `<span class="actions"><span class="pill ${pill.tone}" title="${esc(pill.title)}">${esc(pill.text)}</span><button type="button" class="small go" data-action="post" data-vin="${esc(vin)}">Mark posted</button></span>`;
  }
  const capReached = dailyCap().reached;
  const post = canPost
    ? `<button type="button" class="small go" data-action="openPost" data-vin="${esc(vin)}" ${capReached ? 'disabled' : ''} title="${capReached ? 'Daily post cap reached; it resets tomorrow' : 'Pre-fill the Marketplace form in the side panel. You click Publish.'}">Post</button>`
    : '';
  return `<span class="actions">${post}<button type="button" class="small" data-action="post" data-vin="${esc(vin)}" title="Already listed it yourself? Mark it posted so rescans watch it.">Mark posted</button></span>`;
}

// Mark posted's question: did the listing go up today? A listing made by
// hand before today is watched the same, but it is not one of today's posts
// (src/cap.js askWhenListed, postsToday).
function markChoice(vin) {
  const v = esc(vin);
  return `<span class="actions markWhen" role="group" aria-label="When did this listing go up on Facebook?"><span class="hint">Listed on Facebook:</span><button type="button" class="small go" data-action="markToday" data-vin="${v}" title="It went up today: it counts toward today's posts.">Today</button><button type="button" class="small" data-action="markBefore" data-vin="${v}" title="You listed it by hand before today: rescans watch it, and it doesn't count toward today's posts.">Before today</button><button type="button" class="small" data-action="markCancel" data-vin="${v}">Cancel</button></span>`;
}

function decisionPill(decision) {
  const map = { ready: ['good', 'Ready to post'], 'not-ready': ['warn', 'Not ready'], review: ['warn', 'Needs a look'], skip: ['bad', 'Skipped: new'] };
  const [tone, text] = map[decision] || ['', decision];
  return `<span class="pill ${tone}">${esc(text)}</span>`;
}

const price = (e) => basisPrice(e, state.settings?.basis);

// Offered until set-up has been finished or skipped for this website, so the
// posting rules and the background permission stay reachable; "Continue"
// when it was started and left.
function setupBanner() {
  if (!state.origin || !state.tab || state.wizardDone) return '';
  const active = state.wizardActive;
  const text = active
    ? '<b>Set-up is not finished.</b> Pick up where you left off in the side panel.'
    : "<b>First time here?</b> Set-up runs in the side panel: your store, your name, the store's address, the price to post, automatic rescans, the posting rules and the Terms of Service.";
  const later = state.snapshot ? '<button type="button" class="small" data-action="skipSetup" title="Settings has the same fields, the posting rules included">Not now</button>' : '';
  return `<div class="banner setup" id="setup">${text}<div class="toolbar"><button type="button" class="small go" data-action="setup">${active ? 'Continue set-up' : 'Set up Lot Current'}</button>${later}</div></div>`;
}

// When automatic rescans are switched on but cannot run, say so here rather than nowhere.
function scheduleBanner() {
  const s = state.site;
  if (!s || !s.auto) return '';
  if (state.rescanPermission === false) {
    return `<div class="banner warn" id="scheduleWarning">Automatic rescans are on, but Lot Current has no permission to read this website in the background, so they can't run. <button type="button" class="small go" data-action="allowRescans">Allow automatic rescans</button></div>`;
  }
  if (s.lastError && (!s.lastScan || String(s.lastAttempt || '') > String(s.lastScan))) {
    const what = s.lastReason === 'panel' ? 'rescan from the side panel' : 'automatic rescan';
    return `<div class="banner warn" id="scheduleWarning">The last ${what} (${esc(when(s.lastAttempt))}) failed: ${esc(s.lastError)}</div>`;
  }
  return '';
}

// A lot that keeps reading more than half smaller (src/rescan.js
// withWithheld): the saved list stays until the salesperson, having looked at
// the website, says the new one is right. Then, until the next scan, what
// they chose.
function withheldBanner(d) {
  const w = withheldOffer(d);
  if (w) {
    const cars = (n) => `${n} ${n === 1 ? 'car' : 'cars'}`;
    return `<div class="banner warn" id="withheld">The last ${w.scans} scans, since ${esc(when(w.since))}, each read about ${cars(w.cars)} on the website, where the saved list has ${cars(w.saved ?? 0)}. Lot Current keeps the saved list and marks nothing gone, in case the website is having trouble. If the website's used-inventory page really lists only these cars now, use the new list: the next scan compares with it, and looks up each of your listings it misses on the website before calling it gone.<div class="toolbar"><button type="button" class="small go" data-action="acceptWithheld">Use the new list of ${cars(w.cars)}</button></div></div>`;
  }
  const a = d && d.accepted;
  if (a && typeof a === 'object') {
    return `<div class="banner info" id="withheldAccepted">You chose the website's new list of ${esc(String(a.cars))} cars (${esc(when(a.at))}) over the ${esc(String(a.saved))} saved. The next scan compares with it.</div>`;
  }
  return '';
}

// Why a to-do item has no buttons: a colleague's listing, or a car nobody marked as posted.
const notYours = (vin) => (colleagueEntry(vin) ? ` · posted by ${byWhom(colleagueEntry(vin))}` : ' · not marked as posted');

function viewTodo(l) {
  const d = state.diff;
  if (!state.snapshot && !d) {
    return setupBanner() + empty("Or just click <b>Scan website</b> on your dealership's used inventory page.");
  }
  let html = setupBanner() + scheduleBanner() + notSharedBanner();
  html += `<div class="meta">Last scan ${esc(when(d?.takenAt || state.snapshot?.takenAt))} · ${l.all.length} used cars · ${l.ready.length} ready to post</div>`;
  for (const w of d?.warnings || []) html += `<div class="banner warn">${esc(w)}</div>`;
  html += withheldBanner(d);
  if (d?.firstScan) {
    html += `<div class="banner info">First scan saved. Start with the <b>Ready to post</b> tab. From now on, each scan compares with the last one and lists what sold, what changed price and what's new. Mark cars as posted so your own listings come first.</div>`;
  }
  const parts = [];
  const takeDown = d?.takeDown || [];
  if (takeDown.length) {
    parts.push(
      section('Take down', 'bad', takeDown.map((t) =>
        row(t, {
          sub: esc(t.text) + (t.yours ? '' : notYours(t.vin)),
          right: t.lastPrice ? money(t.lastPrice) : '',
          action: t.yours
            ? `<span class="actions"><button type="button" class="small go" data-action="upkeep" data-kind="takeDown" data-vin="${esc(t.vin)}" title="${t.why === 'not-pre-owned' ? 'Opens your listing so you can delete it' : 'Opens your listing so you can mark it sold or delete it'}">Open listing</button><button type="button" class="small" data-action="takenDown" data-vin="${esc(t.vin)}">Taken down</button></span>`
            : '',
          muted: !t.yours,
        })
      ))
    );
  }
  const updates = d?.priceUpdates || [];
  if (updates.length) {
    parts.push(
      section('Update price', 'warn', updates.map((p) => {
        // an item worked out on a scan taken before your listing got the price it carries (updated on another
        // computer since and brought by sync: src/rescan.js priceItemWaits) is the listing and the website as they
        // were then: as on My listings, its price waits for the next scan, with neither price of that scan named
        // and nothing to record or fill
        const entry = state.posted[p.vin];
        const waits = priceItemWaits(p, entry, d);
        return row(p, {
          sub: (waits ? '<span class="pill">Price compared at the next scan</span> ' : '') + (p.yours ? 'Your listing' : colleagueEntry(p.vin) ? `Posted by ${byWhom(colleagueEntry(p.vin))}` : 'Not marked as posted') + (p.stock ? ' · Stock ' + esc(p.stock) : ''),
          right: waits ? `Listed ${money(entry.price)}` : `${money(p.from)} → <b>${money(p.to)}</b> <span class="${p.change < 0 ? 'down' : 'up'}">${signedMoney(p.change)}</span>`,
          action: p.yours && !waits
            ? `<span class="actions"><button type="button" class="small go" data-action="upkeep" data-kind="price" data-vin="${esc(p.vin)}" data-price="${p.to}" title="Opens your listing with the new price ready to fill in; you click Update">Open &amp; update price</button><button type="button" class="small" data-action="priceUpdated" data-vin="${esc(p.vin)}" data-price="${p.to}"${p.basis ? ` data-basis="${esc(p.basis)}"` : ''}>Updated</button></span>`
            : '',
          muted: !p.yours,
        });
      }))
    );
  }
  const now = Date.now();
  const arrivals = newArrivalItems(now);
  if (arrivals.length) {
    const ready = readyArrivals(arrivals);
    const queueAll = ready.length > 1
      ? `<div class="toolbar"><button type="button" class="small go" data-action="queueArrivals">Queue all ${ready.length} ready arrivals</button><span class="hint">Pre-fills them one at a time in the side panel; you click Publish on each.</span></div>`
      : '';
    parts.push(
      section('New arrivals', 'good', arrivals.map((n) =>
        row(n, {
          sub: decisionPill(n.decision) + (n.decision === DECISION.READY ? '' : ' ' + esc(n.reason)),
          line: whenLine(n, now),
          right: money(n.price),
          action: n.decision === DECISION.READY ? postButton(n.vin) : '',
        })
      )) + queueAll
    );
  }
  const nowReady = d?.nowReady || [];
  if (nowReady.length) parts.push(section('Just became ready', 'good', nowReady.map((n) => row(n, { sub: esc(n.what), action: postButton(n.vin) }))));
  const look = d?.needsALook || [];
  // a posted car whose details the pre-owned check questions: the person may look and dismiss it (the listing stays up)
  const dismiss = (n) => (n.yours && n.why === 'review' ? `<span class="actions"><button type="button" class="small" data-action="dismissLook" data-vin="${esc(n.vin)}" title="Your listing stays up; the item comes back if the website gives another reason">Dismiss</button></span>` : '');
  if (look.length) parts.push(section('Needs a look', 'warn', look.map((n) => row(n, { sub: esc(n.text) + (n.yours ? ' · your listing' : colleagueEntry(n.vin) ? notYours(n.vin) : ''), action: dismiss(n) }))));
  if (!parts.length && d && !d.firstScan) html += empty('Nothing changed since the last scan.');
  return html + parts.join('');
}

// The batch queue's state line, shown on the Ready tab while a queue exists.
function queueStatusHtml() {
  const q = state.queue;
  if (!q) return '';
  const next = currentVin(q);
  const name = next && state.snapshot?.vehicles?.[next] ? state.snapshot.vehicles[next].name : next;
  const buttons = q.status === 'done'
    ? `<button type="button" class="small" data-action="clearQueue">Clear</button>`
    : `<button type="button" class="small go" data-action="continueQueue">Continue in the side panel</button><button type="button" class="small" data-action="clearQueue">Stop the queue</button>`;
  return `<div class="banner info queue" id="queueStatus"><b>${esc(describeQueue(q))}</b>${next ? ` · next: ${esc(name)}` : ''}<div class="toolbar">${buttons}</div></div>`;
}

// The day's cap for this salesperson: this machine's posts (those taken down
// or unmarked since included: the day's log, with the posts the take-down
// record holds that the log never had), after a sync the server's count of
// theirs across their machines, and the forms saved as drafts today that are
// not marked posted yet (src/cap.js). Mark posted never looks at it: a
// listing already live on Facebook is always recorded, so rescans watch it.
const dailyCap = () => capStatus(state.posted, state.settings?.dailyCap, new Date(), { log: state.postLog, takenDown: state.takenDown, serverCount: state.syncState && state.syncState.postsToday, drafts: state.drafts });
const capText = (cap) => `Daily post cap reached (${capCount(cap)}). It resets tomorrow; the dealer can change it in Settings.`;

// The Ready tab: the sort menu (remembered for this website in
// settings.readySort) and the search box above the list; the list itself,
// with its Select the next N toolbar, is drawn by readyBodyHtml so typing in
// the box redraws only the list and the box keeps the focus.
function viewReady(l) {
  const lead = `<p class="lead">Pre-owned, at your store, with photos and a price. Click <b>Post</b> on one car, or tick several and <b>Post</b> them as a queue: the side panel pre-fills each form and you click Publish on each. Listed one by hand? Click <b>Mark posted</b>.</p>`;
  if (!l.ready.length) {
    state.picked.clear();
    return lead + queueStatusHtml() + empty('No cars are ready right now.');
  }
  const cap = dailyCap();
  const capBanner = cap.reached ? `<div class="banner warn" id="capReached">${esc(capText(cap))}</div>` : '';
  const order = readySort();
  const controls = `<div class="toolbar listControls">
    <label class="control"><span>Sort</span><select id="readySort">${SORT_ORDERS.map((o) => `<option value="${o.id}" ${o.id === order ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>
    <label class="control grow"><span class="sr">Search</span><input type="search" id="readySearch" value="${esc(state.readyFilter)}" placeholder="Search: stock number, last 6 of the VIN, year, make or model" autocomplete="off" spellcheck="false" /></label>
  </div>`;
  return lead + queueStatusHtml() + capBanner + controls + `<div id="readyBody">${readyBodyHtml(l, cap)}</div>`;
}

// The ready cars in the chosen order, after the search box, each with its
// New pill and date line. The ticks live in state.picked (every pickable
// car, shown or hidden by the search box), so "Post N cars" counts them all
// and the queue takes them all, in this order. "Select the next N" counts
// the pickable cars shown, less the ticked ones the search box hides, so N
// is what the tick takes from the top and the day's cap holds either way.
function readyBodyHtml(l, cap) {
  const order = readySort();
  const basis = { basis: state.settings?.basis };
  prunePicks(sortEntries(l.ready.filter((e) => !state.posted[e.vin]), order, basis), cap);
  const shown = sortEntries(l.ready.filter((e) => filterText(e, state.readyFilter)), order, basis);
  const pickable = shown.filter((e) => !state.posted[e.vin]);
  const hidden = state.picked.size - pickable.filter((e) => state.picked.has(e.vin)).length;
  const n = Math.max(0, Math.min(cap.remaining - hidden, pickable.length));
  const posts = `${cap.remaining} more post${cap.remaining === 1 ? '' : 's'} allowed today.`;
  const selectNext = pickable.length > 1 && n > 0;
  const toolbar = !cap.reached && (pickable.length > 1 || state.picked.size)
    ? `<div class="toolbar">${selectNext ? `<label><input type="checkbox" id="pickAll" data-n="${n}" /> <span>Select the next ${n}</span></label>` : ''}<button type="button" class="small go" data-action="queue" id="queueBtn"${state.picked.size ? '' : ' disabled'}>${queueLabel()}</button><span class="hint" id="pickHint">${selectNext ? `Ticks the next ${n} in this order. ` : ''}${hidden ? `${hidden} ticked car${hidden === 1 ? '' : 's'} hidden by the search. ` : ''}${posts}</span></div>`
    : '';
  if (!shown.length) return toolbar + empty('No cars match');
  const now = Date.now();
  return toolbar + rows(shown.map((e) => row(e, { sub: facts(e), line: whenLine(e, now), tag: newPill(e, now), right: money(price(e)), action: postButton(e.vin), pick: !state.posted[e.vin] && !cap.reached })));
}

// Ticks that no longer apply: a car that left the Ready list or was posted
// (another tab, a rescan), and, once the day's cap has moved under them,
// the ones past it (the first ones in the current order stay).
function prunePicks(ordered, cap) {
  state.picked = new Set(ordered.filter((e) => state.picked.has(e.vin)).slice(0, Math.max(0, cap.remaining)).map((e) => e.vin));
}

// The ticked cars, in the order shown, the ones the search box hides included.
const pickedVins = () => sortEntries(lists().ready.filter((e) => state.picked.has(e.vin)), readySort(), { basis: state.settings?.basis }).map((e) => e.vin);

const queueLabel = () => (state.picked.size ? `Post ${state.picked.size} car${state.picked.size === 1 ? '' : 's'}` : 'Post selected');

// Redraws the list after a keystroke in the search box or a change of
// order; the ticks come back from state.picked.
function renderReadyBody() {
  const body = $('readyBody');
  if (!body) return;
  body.innerHTML = readyBodyHtml(lists(), dailyCap());
  syncPickAll();
}

// The sort order, kept with this website's settings (never in the synced
// profile): written from what is stored now, under the key's lock, like
// every other change to a shared key.
async function changeReadySort(value) {
  const order = sortOrder(value);
  const site = knownSite();
  state.settings = withDefaults({ ...(state.settings || {}), readySort: order }, site);
  renderReadyBody();
  if (!state.origin) return;
  await update('settings', (s) => withDefaults({ ...(s || state.settings || {}), readySort: order }, site));
}

// Ticking: never more than the day's remaining posts, the ticks the search
// box hides counted. "Select the next N" takes the first N cars in the order
// shown (N as readyBodyHtml worked it out); unticking it clears the shown ones.
function onPickChange(target) {
  const cap = dailyCap();
  const boxes = [...document.querySelectorAll('.pick')];
  if (target.id === 'pickAll') {
    const n = Number(target.dataset.n) || 0;
    boxes.forEach((box, i) => {
      box.checked = target.checked && i < n;
      if (box.checked) state.picked.add(box.dataset.vin);
      else state.picked.delete(box.dataset.vin);
    });
    if (target.checked && boxes.length > n) setStatus(`Selected the next ${n} in this order: that's all that's allowed today.`);
  } else if (target.checked && state.picked.size >= cap.remaining) {
    target.checked = false;
    setStatus(`Only ${cap.remaining} more post${cap.remaining === 1 ? '' : 's'} allowed today.`, 'error');
  } else if (target.checked) {
    state.picked.add(target.dataset.vin);
  } else {
    state.picked.delete(target.dataset.vin);
  }
  syncPickAll();
}

// The Select the next N box reads as ticked only when exactly those N are.
function syncPickAll() {
  const all = $('pickAll');
  if (all) {
    const picked = [...document.querySelectorAll('.pick:checked')].length;
    all.checked = picked > 0 && picked === (Number(all.dataset.n) || 0);
  }
  updateQueueButton();
}

function updateQueueButton() {
  const btn = $('queueBtn');
  if (!btn) return;
  btn.disabled = state.picked.size === 0;
  btn.textContent = queueLabel();
}

function viewNotReady(l) {
  const lead = `<p class="lead">Pre-owned cars at your store that are missing something a listing needs. They move to Ready to post on their own once the website has it.</p>`;
  if (!l.notReady.length) return lead + empty('Nothing waiting.');
  return lead + rows(l.notReady.map((e) => row(e, { sub: `<span class="pill warn">${esc(e.reason)}</span> ${facts(e)}`, right: money(price(e)), action: postButton(e.vin, { canPost: false }) })));
}

function viewOtherStores(l) {
  const lead = `<p class="lead">Pre-owned cars at your group's other stores, kept off your list so you don't advertise a car that's somewhere else. You can change your store in Settings.</p>`;
  if (!l.otherStores.length) return lead + empty('None.');
  return lead + rows(l.otherStores.map((e) => row(e, { sub: `${facts(e)}${(e.blockers || []).length > 1 ? ' · ' + esc(e.reason.replace(/;?\s*At [^;]+$/, '')) : ''}`, right: money(price(e)), action: postButton(e.vin, { canPost: false }) })));
}

function viewReview(l) {
  const lead = `<p class="lead">The website's details for these cars don't add up, so they're held back. Fix them on the website (or ask whoever manages inventory), then scan again.</p>`;
  let html = lead;
  if (!l.review.length && !l.skipped.length) return html + empty('Nothing needs a look.');
  if (l.review.length) html += rows(l.review.map((e) => row(e, { sub: `${esc(e.reason)}<br>${facts(e)}` })));
  if (l.skipped.length) html += section('Skipped as new (never posted)', 'bad', l.skipped.map((e) => row(e, { sub: `${esc(e.reason)}<br>${facts(e)}` })));
  return html;
}

// One of the person's posts the last sync could not put on the dealership's
// list (src/sync.js notSharedFrom), or null: the person is told on the car.
function notShared(p) {
  const list = state.syncState && Array.isArray(state.syncState.notShared) ? state.syncState.notShared : [];
  return list.find((n) => n && n.vin === String(p.vin || '').toUpperCase() && Date.parse(n.postedAt) === Date.parse(p.postedAt)) || null;
}
const notSharedText = (n) => (n.reason === 'clock'
  ? "Not shared with your dealership: this post's time is ahead of the server's clock. Check this computer's date and time, then sync again."
  : `Not shared with your dealership: ${n.by ? esc(n.by) : 'a colleague'} already has this car listed, so your dealership's list and the manager view show theirs, not yours.`);

// How many of the person's own posts on this computer the dealership's list
// does not hold: a post taken down here since the last sync is not counted.
const notSharedCount = () => Object.entries(state.posted || {}).filter(([vin, p]) => p && p.mine !== false && notShared({ vin, ...p })).length;

// On To do, where the person looks first: how many of their posts the
// dealership's list does not hold. My listings says which and why.
function notSharedBanner() {
  const n = notSharedCount();
  if (!n) return '';
  return `<div class="banner warn" id="notSharedBanner">${n === 1 ? 'One of your posts is' : `${n} of your posts are`} not on your dealership's list: the last sync could not share ${n === 1 ? 'it' : 'them'}. <b>My listings</b> says why.</div>`;
}

function viewMine(l) {
  const lead = `<p class="lead">Cars you've marked as posted. Each scan compares these with the website.</p>`;
  if (!l.mine.length) return lead + empty('Nothing marked as posted yet. Use <b>Mark posted</b> on the Ready to post tab.') + viewColleagues(l);
  return (
    lead +
    rows(
      l.mine.map((p) => {
        // the line from the last scan (src/rescan.js listingLine): the website price on the basis this listing was
        // posted at, so a switch of Price to post is not shown (or recorded) as a change. An entry with none reads it
        // off that scan only when it was taken once the listing had its price (scanCar), as the rescan does. A scan
        // from before (`compared` false) names no website price, whatever it says about the car, and a price that
        // differs waits for the next scan, so Updated never records it.
        // Sold, sale-pending or held back by the pre-owned check come before a price change (listingStatus).
        const { now, basis: own, compared, site, status } = listingLine(p, state.snapshot, p.vin, state.settings?.basis);
        const other = own !== postedBasis(null, state.settings?.basis) ? ` · posted at ${own === 'beforeFees' ? 'the lower second price' : "the website's main price"}; your price setting now applies to new posts` : '';
        const pill = `<span class="pill${status.tone ? ' ' + status.tone : ''}">${esc(status.text)}</span>`;
        // Updated records the price with the basis it is on, kept on a listing that carries none (src/rescan.js markPriceUpdated)
        const extra = status.priceChanged ? `<button type="button" class="small go" data-action="priceUpdated" data-vin="${esc(p.vin)}" data-price="${site}" data-basis="${esc(own)}">Updated</button>` : '';
        const entry = { name: p.name, url: now?.url };
        const link = openListing(p.listingUrl);
        const refused = notShared(p);
        return row(entry, {
          sub: `${pill} ${p.listedBefore ? `Listed before ${esc(day(p.postedAt))}` : `Posted ${esc(when(p.postedAt))}`}${p.updatedAt ? ' · price updated ' + esc(when(p.updatedAt)) : ''}${esc(other)}${link}`,
          line: refused ? `<span class="notShared" style="color: var(--bad)">${notSharedText(refused)}</span>` : '',
          right: `Listed ${money(p.price)}${now && compared && site !== p.price ? `<br>Website ${money(site)}` : ''}`,
          action: `${extra}<button type="button" class="small" data-action="takenDown" data-vin="${esc(p.vin)}">Taken down</button>`,
        });
      })
    ) +
    viewColleagues(l)
  );
}

// "Open listing" on My listings: only for a Marketplace listing's own
// address (facebook/detectPost.js listingLink, the side panel's rule for
// what it saves). A link saved before that rule, or synced from a computer
// without it (the Your listings page Facebook lands on after Publish, any
// other page), would open the wrong page: none is shown, as for a listing
// saved with no link.
function openListing(url) {
  const href = listingLink(url, state.listingMap);
  return href ? ` · <a href="${esc(href)}" target="_blank" rel="noopener">Open listing</a>` : '';
}

// Colleagues' listings, as the last sync brought them: who posted the car,
// when, at what price and the link, so nobody lists it again. No buttons:
// marking one taken down or updated here would change nothing on Facebook
// or for the colleague, only this computer's copy.
function viewColleagues(l) {
  if (!l.colleagues.length) return '';
  const items = l.colleagues.map((p) => {
    const link = openListing(p.listingUrl);
    return row({ name: p.name || p.vin, url: p.now?.url }, { sub: `Posted by ${byWhom(p)} ${esc(when(p.postedAt))}${link}`, right: `Listed ${money(p.price)}`, muted: true });
  });
  return `<h3 id="colleagueListings">Posted by colleagues <span class="pill">${items.length}</span></h3><p class="hint">Their listings, as of the last sync. Keeping them up to date is theirs to do.</p>${rows(items)}`;
}

// ---------- pilot numbers ----------

const FIELD_LABELS = Object.fromEntries(FORM_MAP.fields.map((f) => [f.key, f.label]));
const secs = (s) => (typeof s === 'number' ? `${s} s` : '—');
const hrs = (h) => (typeof h === 'number' ? `${h} h` : '—');

// The Numbers tab: the usage numbers Lot Current records from the first post
// (src/pilot.js; for a pilot, legal/pilot-agreement.md section 2 names them),
// for the weekly check-in and the manager: time per post, fields that could not be
// filled, how long sold cars and price changes stayed on the salesperson's
// listings. Kept in this browser, per website; Download CSV is how it leaves,
// and with accounts the posts and the to-do items also sync (src/sync.js).
function viewPilot() {
  const synced = accountsConfigured() ? ' While you are signed in, the posts and the to-do items also sync to your dealership\'s account for the manager view.' : '';
  const lead = `<p class="lead">The numbers your dealership sees, kept in this browser per website: how long each post takes, which form fields Lot Current couldn't fill, and how long sold cars and price changes stayed on your listings. Each record names the car (its VIN and name) and you (your name from Settings), and a price change keeps the website's old and new price.${synced} No customer data, and nothing from Facebook beyond your own listings. <b>Download CSV</b> gives your manager the spreadsheet.</p>`;
  if (!hasPilotData(state.pilot)) return lead + empty('Nothing recorded yet. The numbers start with the first post through the side panel.');
  const s = summarizePilot(state.pilot, { labels: FIELD_LABELS });
  const stat = (k, v) => `<tr><td>${k}</td><td class="n">${v}</td></tr>`;
  const notPosted = s.posts.skipped + s.posts.blocked + s.posts.notPosted + s.posts.abandoned;
  const posts = `<h3>Posts <span class="pill ${s.posts.posted ? 'good' : ''}">${s.posts.posted}</span></h3><table class="stats" id="pilotPosts">
    ${stat('Posted through Lot Current', s.posts.posted)}
    ${stat('Median time per post <span class="hint">(from the click on Post to "It\'s posted", your review included)</span>', secs(s.posts.medianSeconds))}
    ${stat('Within 60 seconds', s.posts.under60Share === null ? '—' : `${s.posts.under60} of ${s.posts.posted} (${s.posts.under60Share}%)`)}
    ${stat('Fastest / slowest', `${secs(s.posts.fastestSeconds)} / ${secs(s.posts.slowestSeconds)}`)}
    ${stat('Saved as drafts on Facebook', s.posts.drafts)}
    ${stat('Started but not posted', notPosted)}
    ${s.posts.inProgress ? stat('Under way now', s.posts.inProgress) : ''}
    ${s.salespeople.map((sp) => stat(esc(sp.name), `${sp.posted} posted, median ${secs(sp.medianSeconds)}`)).join('')}
  </table>`;
  const failing = s.fields.filter((f) => f.failures || f.changed);
  const fillsNote = `${s.fills.attempts} form fill${s.fills.attempts === 1 ? '' : 's'}, ${s.fills.clean} with nothing to fix by hand${s.fills.withDraft ? `; ${s.fills.withDraft} found another car already on the form (a restored draft)` : ''}.`;
  const fields = `<h3>Form fields <span class="pill ${s.fills.attempts && s.fills.clean === s.fills.attempts ? 'good' : failing.length ? 'warn' : ''}">${s.fills.attempts}</span></h3>
    <p class="hint">${fillsNote}</p>` + (failing.length
    ? `<table class="stats" id="pilotFields"><tr><th>Field</th><th class="n">Not filled</th><th class="n">Changed by the form afterwards</th></tr>${failing.map((f) => `<tr><td>${esc(f.label)}</td><td class="n">${f.failures} of ${f.attempts} (${f.failureRate}%)</td><td class="n">${f.changed}</td></tr>`).join('')}</table><p class="hint">"Not filled" counts a field that needed a click or couldn't be filled. Copy the side panel's report when it happens; each fix is one line in formMap.js.</p>`
    : `<p class="hint" id="pilotFields">${s.fills.attempts ? 'Every field filled every time.' : 'No form filled yet.'}</p>`);
  const flagTable = (title, t, id) => `<h3>${esc(title)} <span class="pill ${t.open ? 'warn' : t.flagged ? 'good' : ''}">${t.flagged}</span></h3><table class="stats" id="${id}">
    ${stat('Done', `${t.done}${t.done ? ` (${t.detected} seen on the listing by Lot Current)` : ''}`)}
    ${stat('Median time open, from the scan that flagged it', hrs(t.medianHours))}
    ${stat('Longest', hrs(t.longestHours))}
    ${stat('Still open', t.open ? t.openItems.map((o) => `${esc(o.name)} (${hrs(o.hoursOpen)})`).join('<br>') : '0')}
    ${t.cleared ? stat('Cleared by the website (the car came back, or the price went back)', t.cleared) : ''}
  </table>`;
  const toolbar = `<div class="toolbar"><button type="button" class="small go" data-action="pilotCsv">Download CSV</button><button type="button" class="small" data-action="pilotCopy">Copy summary</button><button type="button" class="small" data-action="pilotClear">Clear the numbers</button></div>
    <p class="hint" id="pilotClearNote">Clear the numbers keeps the to-do items still open, so they close as usual once done.${accountsConfigured() ? ' While you are signed in, it also keeps the items closed since the last sync until the next sync sends them, and it does not remove what has already synced to your dealership\'s account.' : ''}</p>`;
  return lead + toolbar + posts + fields + flagTable('Sold cars to take down', s.takeDowns, 'pilotTakeDowns') + flagTable('Price changes', s.priceUpdates, 'pilotPrices');
}

const field = (label, name, value, attrs = 'type="text"') =>
  `<label class="field"><span class="k">${esc(label)}</span><input name="${name}" value="${esc(value)}" ${attrs} /></label>`;
// A number in the role or the name, or a dealership name that reads as a
// price or a mileage, is in every description and keeps the Marketplace form
// shut for nearly every car (src/rewriteTemplate.js settingNumberWarning).
// Settings says so under the field, and the input is described by that
// warning, when the form is drawn and as the person types; Save still saves
// it. The warning quotes the number and a way to write the value, so it
// changes on nearly every key; a screen reader is told through a live region
// of its own beside it (<name>Say), written only when the warning comes or
// goes, so it is spoken once, not on every key. Set-up's You and address
// steps say the same (wizard.js).
// A role or a name whose numbers the dealership's name, city and ZIP all hold
// passes (the number check reads them as facts), so their warnings follow
// those fields too: `dealer` is the dealership as the form holds it now.
const WARNED_FIELDS = Object.freeze({ salespersonName: 'name', salespersonTitle: 'role', dealerName: 'dealer' });
const DEALER_FIELDS = Object.freeze({ dealerName: 'name', dealerCity: 'city', dealerZip: 'zip' });
function settingWarningHtml(name, value, dealer) {
  const text = settingNumberWarning(WARNED_FIELDS[name], value, dealer);
  return text ? `<div class="banner warn">${esc(text)}</div>` : '';
}
const settingNotice = (name, value, dealer) => settingNumberNotice(WARNED_FIELDS[name], value, dealer);
const settingWarning = (name, value, dealer) => `<div id="${name}Warn">${settingWarningHtml(name, value, dealer)}</div><div id="${name}Say" class="sr" aria-live="polite">${esc(settingNotice(name, value, dealer))}</div>`;
// A price note that says "not the dealer" may say only where the fees go and
// what the price includes (src/rewriteTemplate.js priceNoteWarning): Settings
// says so under the note, read with the dealership's name and city as the
// form holds them, when the form is drawn and as the note or the dealership
// is typed; Save still saves it. Its live region (priceNoteSay) leaves out
// the quoted words, so it is spoken once, when the warning comes or goes.
// Set-up's price step says the same (wizard.js).
const noteWarningHtml = (note, dealer) => {
  const text = priceNoteWarning(note, dealer);
  return text ? `<div class="banner warn">${esc(text)}</div>` : '';
};
const noteWarning = (note, dealer) => `<div id="priceNoteWarn">${noteWarningHtml(note, dealer)}</div><div id="priceNoteSay" class="sr" aria-live="polite">${esc(priceNoteNotice(note, dealer))}</div>`;
// Typing in one of these fields (or the price note): each warning brought up
// to date from what the form holds now (the saved Settings for a box it
// can't read). The warning under a field follows every key; its live region
// is written only when what it says changes, that is when the warning comes
// or goes, since a screen reader speaks every write.
function refreshSettingWarnings(target) {
  const saved = withDefaults(state.settings || {}, knownSite());
  const savedValues = { salespersonName: saved.salesperson.name, salespersonTitle: saved.salesperson.title, dealerName: saved.dealer.name, dealerCity: saved.dealer.city, dealerZip: saved.dealer.zip, priceNote: saved.priceNote };
  const box = (name) => (target.form && target.form.elements && typeof target.form.elements.namedItem === 'function' ? target.form.elements.namedItem(name) : null);
  const now = (name) => (name === target.name ? target.value : (box(name) || { value: savedValues[name] }).value);
  const dealer = Object.fromEntries(Object.entries(DEALER_FIELDS).map(([name, key]) => [key, now(name)]));
  for (const name of Object.keys(WARNED_FIELDS)) {
    const shown = $(`${name}Warn`);
    if (shown) shown.innerHTML = settingWarningHtml(name, now(name), dealer);
    const say = $(`${name}Say`);
    const notice = settingNotice(name, now(name), dealer);
    if (say && say.textContent !== notice) say.textContent = notice;
  }
  const noteShown = $('priceNoteWarn');
  if (noteShown) noteShown.innerHTML = noteWarningHtml(now('priceNote'), dealer);
  const noteSay = $('priceNoteSay');
  const noteNotice = priceNoteNotice(now('priceNote'), dealer);
  if (noteSay && noteSay.textContent !== noteNotice) noteSay.textContent = noteNotice;
}
const choices = (list, current) =>
  `<option value="" ${current === '' ? 'selected' : ''}>Leave blank</option>` + list.map((o) => `<option value="${esc(o)}" ${o === current ? 'selected' : ''}>${esc(o)}</option>`).join('');

// ---------- the Account section (Milestone 4) ----------
// One line while src/accountConfig.js is empty. Once the owner has filled it
// in: sign in with the six-digit code from an email, join a dealership with
// an invite code, sync this website's posted list by hand, sign out. None of
// it is saved by the Save settings button; each button does its own thing.
const signedIn = () => accountsConfigured() && Boolean(state.account.session);
const sameAddress = (a, b) => String(a || '').trim().replace(/\/+$/, '').toLowerCase() === String(b || '').trim().replace(/\/+$/, '').toLowerCase();
// Signed in and the rewrite service is the account's own function: the sign-in is the key, so no key field.
const usesAccountRewrite = (s) => signedIn() && sameAddress(s.rewrite.endpoint, rewriteEndpointFor(ACCOUNT));

function accountFieldset() {
  if (!accountsConfigured()) return `<fieldset><legend>Account</legend><p class="hint" id="accountStatus">${esc(NOT_CONFIGURED)}</p></fieldset>`;
  const a = state.account;
  const note = a.error
    ? `<p class="hint" id="accountNote" style="color: var(--bad)">${esc(a.error)}</p>`
    : a.note ? `<p class="hint" id="accountNote">${esc(a.note)}</p>` : '';
  if (!a.session) {
    return `<fieldset><legend>Account</legend>
      <p class="hint">Sign in to share your posted list with your dealership: every salesperson sees the same listings and your manager sees who posted what. No password: a six-digit code is emailed to you.</p>
      ${field('Your email', 'accountEmail', a.email, 'type="text" inputmode="email" autocomplete="email" placeholder="you@example.com"')}
      <div class="actions"><button type="button" class="plain" data-action="accountSendCode">Send me a sign-in code</button></div>
      ${field('Code from the email', 'accountCode', '', 'type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6 digits"')}
      <div class="actions"><button type="button" class="plain" data-action="accountSignIn">Sign in</button></div>
      ${note}
    </fieldset>`;
  }
  const ss = state.syncState || {};
  const site = state.site || {};
  const email = (a.session.user && a.session.user.email) || '';
  const dealership = ss.dealershipName ? ` · ${esc(ss.dealershipName)}${ss.role ? ` (${esc(ss.role)})` : ''}` : '';
  // the plan as the last sync learned it (src/accountFlow.js planText); lapsed is what stops syncing, so it is the one in red
  const plan = planText(ss.plan);
  const planLine = plan ? ` · <span id="planStatus"${ss.plan.state === 'lapsed' ? ' style="color: var(--bad)"' : ''}>${esc(plan)}</span>` : '';
  const last = ss.lastSyncAt ? `Last sync ${esc(when(ss.lastSyncAt))}` : 'Not synced yet';
  // a sync the server asked to wait is tried again by the service worker (background.js planRetry); said only while that is still to come
  const retry = site.lastSyncRetry && Date.parse(site.lastSyncRetry) > Date.now() ? `; Lot Current tries again on its own at ${esc(when(site.lastSyncRetry))}` : '';
  const failed = site.lastSyncError && (!site.lastSync || String(site.lastSyncAttempt || '') > String(site.lastSync)) ? ` · the last attempt failed: ${esc(site.lastSyncError)}${retry}` : '';
  const refused = notSharedCount(); // the same count as To do's banner
  const notSharedNote = refused ? ` · ${refused} of your posts ${refused === 1 ? 'is' : 'are'} not shared with your dealership (My listings says why)` : '';
  const syncHint = state.origin
    ? `<p class="hint" id="syncStatus">${last}${failed}${notSharedNote}. Lot Current also syncs after every rescan and after each post, take-down or price update you record.</p>`
    : `<p class="hint" id="syncStatus">Open your dealership's website to sync its listings.</p>`;
  return `<fieldset><legend>Account</legend>
    <p id="accountStatus">Signed in as <b>${esc(email)}</b>${dealership}${planLine}</p>
    ${syncHint}
    <div class="actions"><button type="button" class="plain" data-action="accountSyncNow" ${state.origin ? '' : 'disabled'}>Sync now</button><button type="button" class="plain" data-action="accountSignOut">Sign out</button></div>
    <p class="hint"><b>Join a dealership with an invite code.</b> Your manager gives you one; it works once.</p>
    ${field('Invite code', 'inviteCode', '', 'type="text" autocomplete="off"')}
    <div class="actions"><button type="button" class="plain" data-action="accountJoin">Join</button></div>
    ${note}
  </fieldset>`;
}

// What Settings keeps beside the form: the synced profile, and the problem report.
const PROFILE_HINT = "Your profile (name, role, closing line, dealership, stores, price basis, note, cap, listing defaults, rewrite service address, Terms acceptance) is also kept in Chrome's sync storage under your own Google account, so it follows you to other computers. This removes it from there; the settings on this computer stay.";
const forgetProfileHtml = () => `<p class="hint">${PROFILE_HINT}</p>
      <button type="button" class="danger" data-action="forgetProfile">Forget my synced profile</button>`;
const reportProblemHtml = () => `<fieldset><legend>Report a problem</legend>
      <p class="hint">Copies a short technical report to paste into your message to support: the versions, this website and its platform, the last scan and its error, the tab counts, which form fields the last fill couldn't do, your Chrome version and time zone. No names, no cars, no listing links.</p>
      <button type="button" class="small" data-action="reportProblem">Copy problem report</button>
    </fieldset>`;
const versionHtml = () => {
  const version = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '';
  return `<p class="hint" id="version">Lot Current ${esc(version)} · form map ${esc(FORM_MAP.version)}</p>`;
};

// Settings belong to a dealership's website: with none open in this tab (a
// Facebook page, a new tab) there is nothing to show or save, only the
// account, the synced profile and the problem report.
function viewSettingsWithoutSite() {
  return `<form id="settings" class="settings">
    ${versionHtml()}
    <div class="banner info" id="settingsNeedSite">Settings are kept for each dealership website. Open your dealership's website in this tab to see or change them.</div>
    ${accountFieldset()}
    <fieldset><legend>Saved data</legend>
      ${forgetProfileHtml()}
    </fieldset>
    ${reportProblemHtml()}
  </form>`;
}

// The person's own listings on this website (a colleague's are theirs to keep up).
const ownListings = () => Object.values(state.posted || {}).filter((p) => p && p.mine !== false).length;

// Said before a change of "Price to post" is saved: it is for new posts, and
// each listing already posted keeps the price it was posted at (src/rescan.js
// postedBasis). Drawn only beside the choice of the lower second price: on a
// website that shows none there is no other basis to change to.
function basisNote() {
  const text = basisChangeNote(ownListings());
  return text ? `<p class="hint" id="basisNote">${text}</p>` : '';
}

function viewSettings() {
  if (!state.origin) return viewSettingsWithoutSite();
  const entries = Object.values(state.snapshot?.vehicles || {});
  const locations = [...new Set(entries.map((e) => e.location).filter(Boolean))].sort();
  const s = withDefaults(state.settings || {}, knownSite());
  const fee = feeGap(entries);
  const example = fee.example;
  const suggested = suggestedPriceNote(fee.gap, s.basis);
  const stores = locations.length
    ? locations
        .map((l) => `<label><input type="checkbox" name="store" value="${esc(l)}" ${s.myStores.includes(l) ? 'checked' : ''} /> <span>${esc(l)}</span></label>`)
        .join('')
    : '<p class="hint">Scan once to see the stores.</p>';
  const feeNote = example
    ? `<p class="hint">On this website the main price is usually ${money(fee.gap)} higher than the lower second price it shows (often the doc fee, but only your store can say). Posting the website's main price keeps Marketplace and the website matching.</p>`
    : '';
  return `<form id="settings" class="settings">
    ${versionHtml()}
    <fieldset><legend>You</legend>
      ${field('Your name', 'salespersonName', s.salesperson.name, 'type="text" placeholder="Your first name" aria-describedby="salespersonNameWarn"')}
      ${settingWarning('salespersonName', s.salesperson.name, s.dealer)}
      ${field('Your role', 'salespersonTitle', s.salesperson.title, 'type="text" aria-describedby="salespersonTitleWarn"')}
      ${settingWarning('salespersonTitle', s.salesperson.title, s.dealer)}
      <p class="hint">Every description ends with "I'm [name], [role] at [dealership]". Posing as a private seller isn't allowed.</p>
      ${field('Your closing line (optional)', 'closingLine', s.salesperson.closingLine, `type="text" maxlength="300" aria-describedby="closingLineHint" placeholder="e.g. Ask for me by name when you come in."`)}
      <p class="hint" id="closingLineHint">Added after that sign-off on every description, in place of "Message me to set up a test drive or ask a question." About you, not the car: no prices or numbers (a phone number is fine), up to ${CLOSING_LINE_MAX_WORDS} words. Follows you to any computer you sign in to Chrome on.</p>
    </fieldset>
    <fieldset><legend>Your store</legend>
      <p class="hint">Only cars at these stores count as ready to post. Leave all unticked to include every store.</p>
      ${stores}
    </fieldset>
    <fieldset><legend>New arrivals</legend>
      ${field('Mark cars as new for N days', 'newDays', s.newDays, `type="number" min="${MIN_NEW_DAYS}" max="${MAX_NEW_DAYS}"`)}
      <p class="hint">Counted from the in-stock date the website gives for the car, or else from the scan that first saw it. A car you have posted is never marked new. ${MIN_NEW_DAYS} to ${MAX_NEW_DAYS} days; kept for this website only, so it does not follow your profile to another website. The order of the Ready to post list is remembered the same way.</p>
    </fieldset>
    <fieldset><legend>Dealership, named on every listing</legend>
      ${field('Dealership name', 'dealerName', s.dealer.name, `type="text"${state.snapshot ? '' : ' placeholder="Filled in from the website at the first scan"'} aria-describedby="dealerNameWarn"`)}
      ${settingWarning('dealerName', s.dealer.name, s.dealer)}
      ${field('City', 'dealerCity', s.dealer.city)}
      ${field('State', 'dealerState', s.dealer.state, 'type="text" placeholder="e.g. OH" maxlength="2"')}
      ${field('ZIP', 'dealerZip', s.dealer.zip, 'type="text" placeholder="e.g. 43215" inputmode="numeric"')}
      <p class="hint">Marketplace asks for a location. The ZIP is used when it's set, otherwise the city.</p>
    </fieldset>
    <fieldset><legend>Price to post</legend>
      <label><input type="radio" name="basis" value="website" ${s.basis !== 'beforeFees' ? 'checked' : ''} /> <span>The website's main price${example ? ` (e.g. ${money(example.price)} "${esc(example.priceLabel)}")` : ''}</span></label>
      ${!state.snapshot || showsLowerPrice(entries)
        ? `<label><input type="radio" name="basis" value="beforeFees" ${s.basis === 'beforeFees' ? 'checked' : ''} /> <span>The lower second price the website shows${example ? ` (e.g. ${money(example.priceBeforeFees)}; usually the price before the doc fee)` : ''}</span></label>
      <p class="hint">Some states require the advertised price to include dealer fees. Check with your manager before choosing this. A car with no lower second price is posted at the main price, without the price note.</p>
      ${basisNote()}`
        : ''}
      ${feeNote}
      ${field('Price note in every description', 'priceNote', s.priceNote, `type="text" placeholder="${esc(suggested || 'e.g. Tax and tags extra.')}" aria-describedby="priceNoteWarn priceNoteHint"`)}
      ${noteWarning(s.priceNote, s.dealer)}
      <p class="hint" id="priceNoteHint">Honest prices: the listed price always equals the website price. This note explains what it includes.${suggested ? ` Suggested: "${esc(suggested)}"` : ''}</p>
    </fieldset>
    <fieldset><legend>Listing defaults</legend>
      <label class="field"><span class="k">Title status</span><select name="defaultTitleStatus">${choices(TITLE_STATUSES, s.defaults.titleStatus)}</select></label>
      <label class="field"><span class="k">Vehicle condition</span><select name="defaultCondition">${choices(CONDITIONS, s.defaults.condition)}</select></label>
      <p class="hint">Filled in on every listing, unless the website's own text says otherwise (a car described as rebuilt or salvage gets no title default). These are statements about each car that your dealership stands behind; the side panel shows them so you can change them on the form.</p>
    </fieldset>
    <fieldset><legend>Safety</legend>
      ${field('Posts per day, per salesperson', 'dailyCap', s.dailyCap, 'type="number" min="1" max="100"')}
      <p class="hint">A safety setting, not a guarantee: Meta doesn't publish its limits.</p>
    </fieldset>
    <fieldset><legend>Posting rules</legend>
      <details id="postingRules"><summary>Read the posting rules</summary><ol class="rules">${POSTING_RULES.map((r) => `<li><b>${esc(r.title)}</b> ${esc(r.text)}</li>`).join('')}</ol></details>
      ${s.rulesReadAt
        ? `<p class="hint" id="rulesStatus">You ticked that you will follow them on ${esc(dateOnly(s.rulesReadAt))}.</p>`
        : `<p class="hint" id="rulesStatus">Not ticked yet for this website: the side panel shows them before your first post, or tick here.</p>
      <label><input type="checkbox" name="rulesAccept" /> <span>I have read the posting rules and will follow them</span></label>`}
    </fieldset>
    <fieldset><legend>Automatic rescans</legend>
      <label><input type="checkbox" name="autoRescan" ${s.autoRescan ? 'checked' : ''} /> <span>Rescan this website every 3 hours while Chrome is open, and show the to-do count on the icon</span></label>
      <label><input type="checkbox" name="notify" ${s.notify !== false ? 'checked' : ''} /> <span>Desktop notification when listings need attention</span></label>
      ${!state.site
        ? '<p class="hint">Scan this website once first. Then the permission to read it in the background can be granted here.</p>'
        : state.rescanPermission
          ? `<p class="hint">Permission to read this website in the background: granted. Lot Current then re-reads the website${accountsConfigured() ? " and, while you are signed in to a Lot Current account, sends that rescan's results (your posted list, post records, to-do items and the scan's counts) to your dealership's account" : ''}; it never touches Facebook on its own.</p>`
          : '<p class="hint">Needs permission to read this website in the background (Chrome will ask). <button type="button" class="small go" data-action="allowRescans">Allow automatic rescans</button></p>'}
    </fieldset>
    ${accountFieldset()}
    <fieldset><legend>Description writer (optional)</legend>
      <label><input type="checkbox" name="rewriteEnabled" ${s.rewrite.enabled ? 'checked' : ''} /> <span>Use the Lot Current rewrite service (Claude) for first drafts</span></label>
      ${field('Service address', 'rewriteEndpoint', s.rewrite.endpoint, 'type="url" placeholder="http://localhost:8787"')}
      ${usesAccountRewrite(s)
        ? `<p class="hint" id="rewriteKeyHint">Your sign-in is the key: nothing to type here while you are signed in and the address is your account's rewrite service.</p>`
        : field('Service key', 'rewriteKey', s.rewrite.key, 'type="password" autocomplete="off"')}
      <p class="hint">Off by default: descriptions come from a built-in template. Either way every draft is checked against the website's facts, and you review it before posting.</p>
    </fieldset>
    <fieldset><legend>Terms and privacy</legend>
      ${!legalHosted()
        ? `<p class="hint" id="legalStatus">The Terms of Service and the Privacy Policy are being finalised. You can read and accept them here once they are published.</p>`
        : `<p class="hint" id="legalLinks"><a href="${esc(LEGAL.termsUrl)}" target="_blank" rel="noopener">Terms of Service</a> · <a href="${esc(LEGAL.privacyUrl)}" target="_blank" rel="noopener">Privacy Policy</a></p>
      ${legalIsCurrent(s.legal)
        ? `<p class="hint" id="legalStatus">Accepted ${esc(dateOnly(s.legal.acceptedAt))} (version ${esc(s.legal.version)}).</p>`
        : `<p class="hint" id="legalStatus">${s.legal.acceptedAt ? `You accepted version ${esc(s.legal.version || 'unknown')} on ${esc(dateOnly(s.legal.acceptedAt))}; the current version is ${esc(LEGAL.version)}` : 'Not accepted yet'}: ${state.wizardDone ? 'tick here to accept.' : 'run Set up Lot Current, or tick here.'}</p>
      <label><input type="checkbox" name="legalAccept" /> <span>I have read and accept the Terms of Service and the Privacy Policy</span></label>`}`}
    </fieldset>
    <div class="actions"><button type="submit" class="plain">Save settings</button><span class="hint" id="saved"></span></div>
    <fieldset style="margin-top:14px"><legend>Saved data</legend>
      <p class="hint">Scans and your posted list are kept in this browser, separately for each website. When you are signed in, your posted list, post timings, to-do items and scan counts also sync to your dealership's account. Clearing this website does not remove them there: while you are signed in, the next sync brings your posted list and its open to-do items back.</p>
      <button type="button" class="danger" data-action="clear">Clear everything for this website</button>
      ${forgetProfileHtml()}
    </fieldset>
    ${reportProblemHtml()}
  </form>`;
}

// ---------- report a problem ----------

// Chrome's version, from the client hints when the popup has them, else the
// Chrome/ token of the user-agent string.
function chromeVersion() {
  const uad = navigator.userAgentData;
  const brands = uad && Array.isArray(uad.brands) ? uad.brands : [];
  const b = brands.find((x) => /google chrome/i.test(x.brand)) || brands.find((x) => /chromium/i.test(x.brand));
  if (b && b.version) return String(b.version);
  const m = /Chrome\/(\d+[\d.]*)/.exec(navigator.userAgent || '');
  return m ? m[1] : 'unknown';
}

// A plain-text diagnostic for a support message: the versions, the website
// and its adapter, when the last scan ran and what failed, the counts on each
// tab, the field keys the last fill could not do, Chrome's version and the
// time zone. Nothing personal: no names, no VINs, no descriptions, no
// listing links.
function problemReport() {
  const l = lists();
  const site = state.site || {};
  const version = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '';
  const fills = state.pilot && Array.isArray(state.pilot.fills) ? state.pilot.fills : [];
  const lastFill = fills.length ? fills[fills.length - 1] : null;
  const keysOf = (list) => (Array.isArray(list) && list.length ? list.filter((k) => typeof k === 'string').join(', ') : 'none');
  const permission = state.rescanPermission === null ? 'unknown' : state.rescanPermission ? 'granted' : 'not granted';
  return [
    'Lot Current problem report',
    `Lot Current version: ${version || 'unknown'}`,
    `Form map version: ${FORM_MAP.version}`,
    `Website: ${state.origin || 'none open'}`,
    `Adapter: ${site.adapter || 'unknown'}`,
    `Last scan: ${state.diff?.takenAt || state.snapshot?.takenAt || 'never'}`,
    `Last automatic rescan attempt: ${site.lastAttempt || 'never'}`,
    `Last error: ${site.lastError || 'none'}`,
    `Automatic rescans: ${site.auto ? 'on' : 'off'}; background permission: ${permission}`,
    `Account: ${accountsConfigured() ? (state.account.session ? 'signed in' : 'signed out') : 'not set up'}; plan: ${state.syncState && state.syncState.plan ? state.syncState.plan.state : 'unknown'}; last sync: ${site.lastSync || 'never'}; last sync error: ${site.lastSyncError || 'none'}`,
    `Counts: to do ${todoCount()}, ready to post ${l.ready.length}, not ready ${l.notReady.length}, other stores ${l.otherStores.length}, needs a look ${l.review.length + l.skipped.length}, my listings ${l.mine.length}, colleagues' listings ${l.colleagues.length}, queue: ${state.queue ? describeQueue(state.queue) : 'none'}`,
    lastFill
      ? `Last fill: ${lastFill.at || 'unknown time'}, form map ${lastFill.mapVersion || 'unknown'}, build ${lastFill.version || 'unknown'}; needed a click: ${keysOf(lastFill.partial)}; couldn't fill: ${keysOf(lastFill.blocked)}; changed by the form afterwards: ${keysOf(lastFill.changed)}`
      : 'Last fill: none recorded',
    `Chrome: ${chromeVersion()}`,
    `Time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
    `Reported: ${new Date().toISOString()}`,
  ].join('\n');
}

function render() {
  $('site').textContent = state.origin ? state.siteName || state.origin : "Open your dealership's website, then scan.";
  $('scan').textContent = state.snapshot ? 'Rescan website' : 'Scan website';
  $('scan').disabled = Boolean(state.scanning); // disabled in popup.html until the first render after start-up, and while a scan runs
  $('settingsBtn').setAttribute('aria-pressed', String(state.view === 'settings'));
  const l = lists();
  renderTabs(l);
  const views = { todo: viewTodo, ready: viewReady, notReady: viewNotReady, otherStores: viewOtherStores, review: viewReview, mine: viewMine, pilot: viewPilot, settings: viewSettings };
  if (state.view === 'otherStores' && !l.otherStores.length) state.view = 'todo';
  // A redraw the person did not ask for (the service worker's 3-hourly
  // rescan, a colleague's sync) must not take the caret out of the box they
  // are typing in: the focused control comes back by its id, caret and all.
  const panel = $('panel');
  const active = document.activeElement;
  const focus = active && active.id && panel.contains(active) ? { id: active.id, start: active.selectionStart, end: active.selectionEnd } : null;
  panel.innerHTML = (views[state.view] || viewTodo)(l);
  const again = focus && $(focus.id);
  if (again) {
    again.focus();
    if (typeof focus.start === 'number' && typeof again.setSelectionRange === 'function') {
      try { again.setSelectionRange(focus.start, focus.end); } catch (e) { /* a control with no caret */ }
    }
  }
}

// ---------- actions ----------

let clearArmed = false;
let pilotClearArmed = false;

// Before a post leaves the posted list (Taken down, or Posted ✓ unmarked):
// it is kept in takenDown:<origin> (src/takenDown.js), for the side panel's
// re-post notice. The daily cap counts the post from the day's log, which a
// take-down leaves alone, and from this record when the log never had it
// (src/cap.js dayLog). Written first: if the posted list then fails to
// change, the post is still counted once. A colleague's entry is theirs and
// has no such buttons. False when the write failed.
async function keepTakenDown(vin) {
  const entry = state.posted[vin];
  if (!entry || entry.mine === false) return true;
  const stillListed = stillListedNow(state.snapshot, state.diff, vin);
  return update('takenDown', (log) => noteTakenDown(log, { vin, postedAt: entry.postedAt, stillListed, listedBefore: entry.listedBefore === true, name: entry.name }));
}

// The post under way in the side panel for this website (postFlow:<origin>),
// read when Mark posted is clicked: a form Lot Current filled for the car
// today makes its listing one of today's posts (src/cap.js askWhenListed).
// Null when there is none or it can't be read.
async function savedFlow() {
  try {
    const key = siteKeys(state.origin).flow;
    return (await chrome.storage.local.get(key))[key] || null;
  } catch (e) {
    return null;
  }
}

// Pilot numbers: an item the person ticked off by hand, or a car unmarked,
// closes its to-do flag. Awaited, and a write that fails (the quota) is shown
// and answered false. A fix whose posted-list write landed while its flag
// stayed open would be lost at the next sync: the sync function files no
// item for an open flag the listing already shows, and mergeFlags then drops
// that flag (src/sync.js), so the item would be in neither the numbers nor
// the manager view.
async function notePilot(change) {
  try {
    const next = await updatePilot(state.origin, change);
    if (next !== undefined) state.pilot = next;
    return true;
  } catch (e) {
    setStatus(storageErrorText(e), 'error');
    return false;
  }
}

// After a change recorded here (a scan, a car marked or unmarked, taken
// down or updated), the worker syncs this website with the dealership's
// account while the person is signed in, so the manager view and colleagues
// see it now rather than at the next rescan. Fire and forget: the popup may
// close first, and Settings shows how the sync went.
function syncInBackground() {
  if (!signedIn() || !state.origin) return;
  chrome.runtime.sendMessage({ type: 'syncNow', origin: state.origin }).catch(() => {});
}

async function onPanelClick(ev) {
  const btn = ev.target.closest('button[data-action]');
  if (!btn) return;
  const vin = btn.dataset.vin;
  switch (btn.dataset.action) {
    case 'markCancel':
      state.markAsk = null;
      break;
    case 'post':
    case 'markToday':
    case 'markBefore': {
      const entry = state.snapshot?.vehicles?.[vin];
      if (!entry) return;
      // a listing published from a draft shows the draft's price: that is what is recorded (src/drafts.js)
      const draft = state.drafts[vin] || null;
      // Mark posted first asks whether the listing went up today, unless a draft saved today, today's log,
      // or a form Lot Current filled for the car today says so (src/cap.js askWhenListed)
      if (btn.dataset.action === 'post' && askWhenListed(draft, new Date(), { vin, log: state.postLog, flow: await savedFlow(), pilot: state.pilot })) {
        state.markAsk = vin;
        render();
        const today = document.querySelector(`button[data-action="markToday"][data-vin="${CSS.escape(vin)}"]`);
        if (today) today.focus();
        return;
      }
      state.markAsk = null;
      const before = btn.dataset.action === 'markBefore';
      const at = new Date().toISOString();
      const basis = state.settings?.basis;
      const extra = before ? { listedBefore: true } : {};
      if (!(await update('posted', (p) => (draft ? markDraftPosted(p || {}, entry, draft, basis, at, extra) : markPosted(p || {}, entry, basis, at, extra))))) break;
      // the day's log for the cap, which a take-down or an unmark leaves alone; a car unmarked today and marked again counts once.
      // A listing made before today is not one of today's posts, so it stays off the log.
      if (!before) await update('postLog', (log) => logPost(log, vin, at, undefined, { alreadyLive: true }));
      if (btn.dataset.action === 'post') setStatus(`Recorded as posted today: Lot Current filled the form for ${entry.name || 'this car'} today or recorded it earlier today, so it counts toward today's posts.`);
      else if (before) setStatus(`Recorded as listed before today: rescans watch ${entry.name || 'it'}, and it doesn't count toward today's posts.`);
      if (draft) {
        // compared with the last scan only when it was taken once the listing had its price (the draft filled: the entry's
        // draftSavedAt, src/rescan.js scanCar), as My listings compares it: a scan from before names no price to update
        const gap = draftPriceUpdate(draft, scanCar(state.posted[vin], state.snapshot, vin), basis);
        if (gap) {
          await update('diff', (d) => withPriceUpdate(d, gap)); // on To do now; every rescan lists it too until the listing is updated
          setStatus(`Recorded at ${money(gap.from)}, the price the draft was filled with. The website now shows ${money(gap.to)}: update the price on the listing (To do, Update price).`, 'error');
        } else if (draftPrice(draft) === null && basisPrice(entry, basis)) {
          setStatus(`Recorded at ${money(basisPrice(entry, basis))}, the website's price. Lot Current did not keep this draft's price: check that the published listing shows ${money(basisPrice(entry, basis))}.`);
        }
      }
      syncInBackground(); // colleagues see the car is taken
      break;
    }
    case 'openPost': {
      // Hands the car to the side panel, which re-checks it on the website,
      // writes the description and pre-fills the Marketplace form.
      const entry = state.snapshot?.vehicles?.[vin];
      if (!entry || entry.decision !== DECISION.READY || !state.tab) return;
      const cap = dailyCap();
      if (cap.reached) {
        setStatus(capText(cap), 'error');
        return;
      }
      // Must run straight from the click (a user gesture) or Chrome won't open the panel.
      let opened = true;
      try {
        await chrome.sidePanel.open({ windowId: state.tab.windowId });
      } catch (e) {
        opened = false;
      }
      await chrome.storage.local.set({ [GLOBAL_KEYS.postRequest]: { origin: state.origin, vin, dealerTabId: state.tab.id, windowId: state.tab.windowId, at: Date.now() } });
      setStatus(opened ? `Continue in the side panel: ${entry.name}` : 'Open the Lot Current side panel (Chrome menu → Side panel) to continue posting this car.');
      return;
    }
    case 'queue':
    case 'queueArrivals':
    case 'continueQueue': {
      // Build (or pick up) the queue, then hand it to the side panel. The
      // panel must be opened straight from the click (a user gesture).
      if (!state.tab) return;
      let queue = state.queue;
      if (btn.dataset.action !== 'continueQueue') {
        const vins = btn.dataset.action === 'queue'
          ? pickedVins() // the ticked cars in the order shown, the ones the search box hides included
          : readyArrivals(newArrivalItems()).map((n) => n.vin); // the same cars the To do tab lists, in the same order
        const cap = dailyCap();
        const made = createQueue(vins, { remaining: cap.remaining, dealerTabId: state.tab.id, windowId: state.tab.windowId });
        if (!made.ok) {
          setStatus(made.error, 'error');
          return;
        }
        queue = made.queue;
        if (made.dropped) setStatus(`${made.dropped} car${made.dropped === 1 ? '' : 's'} left out: only ${cap.remaining} more post${cap.remaining === 1 ? '' : 's'} allowed today.`);
      }
      const first = currentVin(queue);
      if (!first) {
        setStatus('The queue is finished. Clear it to start another.');
        return;
      }
      let opened = true;
      try {
        await chrome.sidePanel.open({ windowId: state.tab.windowId });
      } catch (e) {
        opened = false;
      }
      state.queue = queue;
      try {
        await ownSet({
          [siteKeys(state.origin).queue]: queue,
          [GLOBAL_KEYS.postRequest]: { origin: state.origin, vin: first, dealerTabId: state.tab.id, windowId: state.tab.windowId, queue: true, at: Date.now() },
        });
      } catch (e) {
        setStatus(storageErrorText(e), 'error');
        return;
      }
      if (btn.dataset.action === 'queue') state.picked.clear(); // the queue has them
      if (!opened) setStatus('Open the Lot Current side panel (Chrome menu → Side panel) to work through the queue.');
      else setStatus(`Queue of ${queue.vins.length}: continue in the side panel.`);
      render();
      return;
    }
    case 'clearQueue':
      state.queue = null;
      await ownRemove([siteKeys(state.origin).queue]);
      break;
    case 'upkeep': {
      // Hands a to-do item to the side panel: it opens the listing, fills the
      // new price when the edit form appears, and marks the item done once it
      // sees the change. The person clicks Update / Mark as sold / Delete.
      if (!state.tab) return;
      const p = state.posted[vin] || {};
      const why = btn.dataset.kind === 'takeDown' ? (state.diff?.takeDown || []).find((t) => t && t.vin === vin)?.why || '' : ''; // a car not sold (not-pre-owned) is deleted, not marked sold
      const item = { origin: state.origin, vin, kind: btn.dataset.kind, why, price: Number(btn.dataset.price) || null, listingUrl: p.listingUrl || '', name: p.name || state.snapshot?.vehicles?.[vin]?.name || vin, listedPrice: p.price || null, dealerTabId: state.tab.id, windowId: state.tab.windowId, at: Date.now() };
      let opened = true;
      try {
        await chrome.sidePanel.open({ windowId: state.tab.windowId }); // straight from the click
      } catch (e) {
        opened = false;
      }
      await chrome.storage.local.set({ [GLOBAL_KEYS.upkeepRequest]: item });
      setStatus(opened ? `Continue in the side panel: ${item.name}` : 'Open the Lot Current side panel (Chrome menu → Side panel) to continue.');
      return;
    }
    case 'setup': {
      if (!state.tab) return;
      let opened = true;
      try {
        await chrome.sidePanel.open({ windowId: state.tab.windowId }); // straight from the click
      } catch (e) {
        opened = false;
      }
      await chrome.storage.local.set({ [GLOBAL_KEYS.setupRequest]: { origin: state.origin, dealerTabId: state.tab.id, windowId: state.tab.windowId, at: Date.now() } });
      setStatus(opened ? 'Continue in the side panel.' : 'Open the Lot Current side panel (Chrome menu → Side panel) to continue set-up.');
      return;
    }
    case 'skipSetup':
      state.wizardDone = true;
      await ownSet({ [siteKeys(state.origin).wizardDone]: { skipped: true, at: new Date().toISOString() } });
      setStatus(`Settings has the same fields, the posting rules included.${state.settings && state.settings.rulesReadAt ? '' : ' The side panel shows the rules before your first post until you tick them.'} Set-up can be run later after "Clear everything for this website".`);
      break;
    case 'allowRescans': {
      // Asks Chrome straight from the click (a user gesture) for the host
      // permission the service worker needs, then switches rescans on.
      if (!state.site) return;
      let granted = false;
      try {
        granted = await askChrome(rescanOrigins());
      } catch (e) {
        setStatus("Couldn't ask Chrome for permission: " + ((e && e.message) || e), 'error');
      }
      state.rescanPermission = granted;
      if (granted) {
        state.settings = withDefaults({ ...(state.settings || {}), autoRescan: true }, knownSite());
        if (!(await save('settings'))) break; // the status says why; the registry the worker reads is left as it was
        if (await setSiteAuto(true)) setStatus('Automatic rescans are on: every 3 hours while Chrome is open.');
      } else {
        await setSiteAuto(false);
        setStatus('Not allowed, so automatic rescans stay off. Scan by hand any time.', 'error');
      }
      break;
    }
    case 'unpost': {
      // the car leaves the posted list; the day's log keeps the post, as for a
      // take-down, so unmarking never hands a post back under the daily cap.
      // It is kept in the take-down record first, as Taken down keeps it.
      if (!(await keepTakenDown(vin))) break;
      if (!(await update('posted', (p) => markTakenDown(p || {}, vin)))) break;
      // its open to-do items close as cleared; the sync goes after, so it
      // carries both, and goes even when that write failed (the status says
      // why): the car is unmarked, and colleagues see it is free
      await notePilot((p) => resolveFlag(p, vin, null, { how: 'cleared' }));
      syncInBackground();
      break;
    }
    // The posted list, the item's flag (pilot numbers), then the diff: stop
    // at the first write that fails (the status says why), so the item stays
    // on To do and can be ticked again once there is room, and the flag is
    // closed before the item leaves To do.
    case 'takenDown':
      if (!(await keepTakenDown(vin))) break;
      if (!(await update('posted', (p) => markTakenDown(p || {}, vin)))) break;
      if (!(await notePilot((p) => resolveFlag(p, vin, null, { how: 'manual' })))) break;
      if (!(await update('diff', (d) => withoutVin(d, vin, ['takeDown', 'priceUpdates', 'needsALook'])))) break;
      syncInBackground();
      break;
    case 'dismissLook': {
      // The person looked at the website's reason: the listing stays up, and
      // the item stays off To do while the website gives that reason
      // (src/rescan.js lookDismissed); no pilot flag is involved.
      const item = (state.diff?.needsALook || []).find((n) => n && n.vin === vin && n.yours && n.why === 'review');
      if (!item) break;
      if (!(await update('posted', (p) => markLookDismissed(p || {}, vin, item.text)))) break;
      if (!(await update('diff', (d) => (d && typeof d === 'object' ? { ...d, needsALook: (d.needsALook || []).filter((n) => !(n && n.vin === vin && n.why === 'review')) } : undefined)))) break;
      break;
    }
    case 'acceptWithheld': {
      // The salesperson's word that the website's smaller list is right: the
      // held-back read becomes the saved list, under the diff's lock (a scan
      // saves both under it), and only while the diff still offers it.
      const diffKey = siteKeys(state.origin).diff;
      let took = null;
      const saved = await withLock(diffKey, async () => {
        took = acceptWithheld((await chrome.storage.local.get(diffKey))[diffKey]);
        if (!took) return false;
        state.snapshot = took.snapshot;
        state.diff = took.diff;
        return save('snapshot', 'diff');
      });
      if (!took) setStatus('A scan since then has changed To do; nothing was replaced.');
      else if (saved) syncInBackground(); // the scan's counts, now as a trusted scan
      break;
    }
    case 'priceUpdated':
      // the price, and the basis it was worked out on for a listing that carries none (the item's, or My listings' line)
      if (!(await update('posted', (p) => markPriceUpdated(p || {}, vin, Number(btn.dataset.price), undefined, btn.dataset.basis)))) break;
      if (!(await notePilot((p) => resolveFlag(p, vin, 'price', { how: 'manual' })))) break;
      if (!(await update('diff', (d) => withoutVin(d, vin, ['priceUpdates'])))) break;
      syncInBackground();
      break;
    case 'pilotCsv': {
      // A file for the manager, saved by the browser like any download.
      const who = { site: state.siteName, salesperson: state.settings?.salesperson?.name || '' };
      const version = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([pilotCsv(state.pilot, { labels: FIELD_LABELS, ...who, origin: state.origin, dealer: state.settings?.dealer?.name || '', version })], { type: 'text/csv' }));
      a.download = pilotFileName(undefined, who);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      setStatus(`Saved ${a.download} to your Downloads folder.`);
      return;
    }
    case 'pilotCopy':
      try {
        await navigator.clipboard.writeText(pilotText(summarizePilot(state.pilot, { labels: FIELD_LABELS }), { site: state.siteName }));
        setStatus('Copied.');
      } catch (e) {
        setStatus("Couldn't copy: " + ((e && e.message) || e), 'error');
      }
      return;
    case 'reportProblem':
      try {
        await navigator.clipboard.writeText(problemReport());
        setStatus('Copied. Paste it into your report.');
      } catch (e) {
        setStatus("Couldn't copy: " + ((e && e.message) || e), 'error');
      }
      return;
    case 'forgetProfile':
      try {
        await chrome.storage.sync.remove(PROFILE_KEY);
        setStatus('Your synced profile was removed from Chrome\'s sync storage. The settings on this computer are unchanged; only saving Settings or finishing set-up re-creates the profile.');
      } catch (e) {
        setStatus("Couldn't reach Chrome's sync storage: " + ((e && e.message) || e), 'error');
      }
      return;
    case 'pilotClear':
      if (!pilotClearArmed) {
        pilotClearArmed = true;
        btn.textContent = 'Click again to clear the numbers';
        return;
      }
      pilotClearArmed = false;
      // The to-do items still open, and a post under way, stay (src/pilot.js
      // clearNumbers): the item stays on To do, and its synced copy on the
      // manager's list closes only when this computer sends it closed. So the
      // items closed since the last sync stay too, until the next sync sends
      // them (src/sync.js clearNumbersKeepingUnsynced).
      try {
        const k = siteKeys(state.origin);
        const left = await withLock(k.pilot, async () => {
          const got = await chrome.storage.local.get([k.pilot, k.sync]);
          const kept = clearNumbersKeepingUnsynced(got[k.pilot], got[k.sync]);
          if (hasPilotData(kept)) await ownSet({ [k.pilot]: kept });
          else await ownRemove([k.pilot]);
          return kept;
        });
        state.pilot = hasPilotData(left) ? left : null;
        const open = left.flags.filter((f) => !f.doneAt).length;
        const waiting = left.flags.length - open;
        const openText = open ? ` ${open === 1 ? 'The to-do item still open stays' : `The ${open} to-do items still open stay`} until ${open === 1 ? 'it is' : 'they are'} done.` : '';
        const waitingText = waiting ? ` ${waiting === 1 ? 'The to-do item closed since the last sync stays' : `The ${waiting} to-do items closed since the last sync stay`} until the next sync sends ${waiting === 1 ? 'it' : 'them'} to your dealership's account.` : '';
        setStatus(`The numbers for this website were cleared.${openText}${waitingText}`);
      } catch (e) {
        setStatus(storageErrorText(e), 'error');
      }
      break;
    case 'clear':
      if (!clearArmed) {
        clearArmed = true;
        btn.textContent = 'Click again to clear everything';
        return;
      }
      Object.assign(state, { snapshot: null, diff: null, posted: {}, postLog: [], takenDown: null, settings: null, settingsFromProfile: false, queue: null, drafts: {}, wizardDone: false, wizardActive: false, site: null, pilot: null, rescanPermission: null, view: 'todo' });
      await ownRemove(Object.values(siteKeys(state.origin)));
      // The synced profile is the person's, not this website's data: start
      // again from it, as a popup opened on a website with no settings does,
      // so the next Scan or Settings save puts it back instead of defaults.
      state.settings = settingsFromProfile(await loadProfile(), { origin: state.origin });
      state.settingsFromProfile = Boolean(state.settings);
      // forget the website for background rescans too, and take its count off the badge
      try {
        await updateKey(SITES_KEY, (sites) => {
          if (!sites || !sites[state.origin]) return undefined;
          const next = { ...sites };
          delete next[state.origin];
          return next;
        }, popupStorage);
        setStatus('Cleared. Scan again, or run set-up, to start over.');
      } catch (e) {
        setStatus(storageErrorText(e), 'error');
      }
      chrome.runtime.sendMessage({ type: 'updateBadge' }).catch(() => {});
      clearArmed = false;
      break;
    case 'accountSendCode':
    case 'accountSignIn':
    case 'accountSignOut':
    case 'accountSyncNow':
    case 'accountJoin':
      await accountAction(btn.dataset.action);
      break;
    default:
      return;
  }
  render();
}

// ---------- account actions ----------

const accountDeps = () => ({ config: ACCOUNT, storage: chrome.storage.local });
const settingsInput = (name) => {
  const el = document.querySelector(`#settings [name="${name}"]`);
  return el ? String(el.value || '').trim() : '';
};

// The worker does the sync (one place, one lock per key); the answer is
// shown here and the merged lists are read back so the redraw is current.
async function syncNow() {
  if (!state.origin) return;
  setStatus('Syncing…');
  let r;
  try {
    r = await chrome.runtime.sendMessage({ type: 'syncNow', origin: state.origin });
  } catch (e) {
    r = { ok: false, error: String((e && e.message) || e) };
  }
  if (r && r.signedOut) state.account.session = null;
  setStatus(describeSync(r), r && r.ok ? '' : 'error');
  const k = siteKeys(state.origin);
  const data = await chrome.storage.local.get([k.posted, k.pilot, k.sync, SITES_KEY]);
  state.posted = data[k.posted] || {};
  state.pilot = data[k.pilot] || null;
  state.syncState = data[k.sync] || null;
  state.site = (data[SITES_KEY] || {})[state.origin] || null;
}

// On sign-in the rewrite service's address becomes the account's own
// function. Whether it is used stays the person's choice: the "Use the Lot
// Current rewrite service" box is not ticked for them. The key field goes away
// (the sign-in is the key; the panel reads the token where it needs it), and
// a key typed for a self-hosted backend is kept in case they switch back.
async function pointRewriteAtAccount() {
  if (!state.origin) return;
  const site = knownSite();
  const prev = withDefaults(state.settings || {}, site);
  const endpoint = rewriteEndpointFor(ACCOUNT);
  if (!endpoint || sameAddress(prev.rewrite.endpoint, endpoint)) return;
  state.settings = withDefaults({ ...prev, rewrite: { ...prev.rewrite, endpoint } }, site);
  await save('settings');
}

async function accountAction(action) {
  const a = state.account;
  a.error = '';
  a.note = '';
  switch (action) {
    case 'accountSendCode': {
      a.email = settingsInput('accountEmail');
      setStatus('Sending the code…');
      const r = await signInStart(a.email, accountDeps());
      setStatus('');
      if (r.ok) {
        a.email = r.email;
        a.note = r.message;
      } else a.error = r.error;
      return;
    }
    case 'accountSignIn': {
      a.email = settingsInput('accountEmail') || a.email;
      const code = settingsInput('accountCode');
      setStatus('Signing in…');
      const r = await signInFinish(a.email, code, accountDeps());
      if (!r.ok) {
        setStatus('');
        a.error = r.error;
        return;
      }
      a.session = r.session;
      setStatus(`Signed in as ${(r.session.user && r.session.user.email) || a.email}.`);
      await pointRewriteAtAccount();
      if (state.origin) await syncNow(); // the first sync says whether the account is in a dealership yet
      return;
    }
    case 'accountSignOut':
      await signOutAll({ ...accountDeps(), origins: state.origin ? [state.origin] : [] });
      a.session = null;
      state.syncState = null;
      setStatus('Signed out. Your posted list stays on this computer.');
      return;
    case 'accountSyncNow':
      return syncNow();
    case 'accountJoin': {
      const code = settingsInput('inviteCode');
      const s = await currentSession(accountDeps());
      if (!s.ok) {
        if (s.signedOut) a.session = null;
        a.error = s.error;
        return;
      }
      setStatus('Joining…');
      let r;
      try {
        r = await redeemInvite(code, state.settings?.salesperson?.name || '', { url: ACCOUNT.url, anonKey: ACCOUNT.anonKey, session: s.session });
      } catch (e) {
        r = { ok: false, error: `couldn't reach the account server (${(e && e.message) || e})` };
      }
      setStatus('');
      if (!r.ok) {
        if (r.signedOut) a.session = null;
        a.error = r.error;
        return;
      }
      const m = r.membership;
      a.note = `Joined ${m.dealershipName || 'the dealership'} as ${m.role || 'a member'}.`;
      if (state.origin && m.websiteOrigin && !sameAddress(m.websiteOrigin, state.origin)) {
        a.note += ` Its website is ${m.websiteOrigin}: open it there to sync its listings.`;
      } else if (state.origin) {
        await syncNow();
      }
      return;
    }
    default:
  }
}

async function onSettingsSubmit(ev) {
  if (ev.target.id !== 'settings') return;
  ev.preventDefault();
  // Enter in one of the Account boxes means that box's button, not Save settings
  const active = document.activeElement && document.activeElement.name;
  const viaEnter = { accountEmail: 'accountSendCode', accountCode: 'accountSignIn', inviteCode: 'accountJoin' }[active];
  if (viaEnter) {
    await accountAction(viaEnter);
    render();
    return;
  }
  if (!state.origin) {
    setStatus(NO_SITE_TEXT, 'error');
    return;
  }
  const form = new FormData(ev.target);
  // the closing line goes into every description: a line that fails its checks is not saved, and the form keeps what was typed
  const closing = checkClosingLine(form.get('closingLine'));
  if (!closing.ok) {
    setStatus(closing.problems.map((p) => p.text).join('. ') + '. Nothing was saved.', 'error');
    const box = ev.target.querySelector('[name="closingLine"]');
    if (box) box.focus();
    return;
  }
  const prev = withDefaults(state.settings || {}, knownSite());
  const str = (k) => String(form.get(k) ?? '').trim();
  // the store boxes are drawn once a scan has named the stores (viewSettings):
  // a Save with them in view is the person's choice, none ticked meaning every
  // store (storesChosen, which the website's first scan keeps); a Save before
  // that leaves the stores as they were. The form decides, not the snapshot: a
  // scan the service worker or set-up finishes while Settings is open updates
  // state.snapshot without redrawing the form, so a form drawn without boxes
  // can be saved after the stores are known
  const storesShown = Boolean(ev.target.querySelector && ev.target.querySelector('input[name="store"]'));
  state.settings = withDefaults(
    {
      ...prev,
      myStores: storesShown ? form.getAll('store').map(String) : prev.myStores,
      storesChosen: storesShown || prev.storesChosen,
      basis: chooseBasis(form.get('basis'), prev.basis, state.snapshot ? Object.values(state.snapshot.vehicles || {}) : null), // the lower price only when this website shows one; without a scan the previous choice stands
      salesperson: { name: str('salespersonName'), title: str('salespersonTitle') || DEFAULT_SALESPERSON_TITLE, closingLine: cleanClosingLine(form.get('closingLine')) },
      dealer: { name: str('dealerName') || prev.dealer.name, city: str('dealerCity'), state: str('dealerState').toUpperCase(), zip: str('dealerZip') },
      priceNote: str('priceNote'),
      dailyCap: Math.max(1, Math.min(100, Number(form.get('dailyCap')) || DEFAULT_DAILY_CAP)),
      newDays: Math.max(MIN_NEW_DAYS, Math.min(MAX_NEW_DAYS, Number(form.get('newDays')) || DEFAULT_NEW_DAYS)), // 1 to 30; blank or 0 is the default (readySort stays as the Ready tab's menu set it, through ...prev)
      rewrite: { enabled: form.get('rewriteEnabled') === 'on', endpoint: str('rewriteEndpoint'), key: form.has('rewriteKey') ? str('rewriteKey') : prev.rewrite.key }, // no key field while signed in: the typed one is kept, never the token
      defaults: { titleStatus: str('defaultTitleStatus'), condition: str('defaultCondition') },
      autoRescan: form.get('autoRescan') === 'on',
      notify: form.get('notify') === 'on',
      legal: form.get('legalAccept') === 'on' && legalHosted() ? acceptLegal() : prev.legal, // the tick is the same acceptance the wizard's Terms step records; nothing while the documents are placeholders
      rulesReadAt: form.get('rulesAccept') === 'on' ? new Date().toISOString() : prev.rulesReadAt, // the same tick as set-up's rules step and the side panel's
    },
    knownSite()
  );
  let message = 'Saved. Click Rescan website to apply.';
  if (state.settings.autoRescan && state.site && !state.rescanPermission) {
    // Rescans need the host permission; the Save click is a user gesture, so ask now.
    try {
      state.rescanPermission = await askChrome(rescanOrigins());
    } catch (e) {
      state.rescanPermission = false;
    }
    if (!state.rescanPermission) {
      state.settings.autoRescan = false;
      message = 'Saved, but automatic rescans stay off: Lot Current was not allowed to read this website in the background.';
    }
  }
  if (state.settings.autoRescan && !state.site) {
    state.settings.autoRescan = false;
    message = 'Saved, but automatic rescans need one scan of this website first.';
  }
  const basisChanged = state.settings.basis !== prev.basis;
  // Listings posted before the price basis was kept on each one stay on the
  // basis they were posted at: the new setting is for new posts, and a
  // changed setting is never shown as a website price change (src/rescan.js
  // withPostedBasis). Stamped before the new basis is saved, so a background
  // rescan in between never reads them under the new one; nothing is saved
  // when the stamp could not be written.
  if (basisChanged && !(await update('posted', (p) => withPostedBasis(p, prev.basis, state.snapshot)))) { render(); return; }
  // the other settings are kept either way; the side panel opens no form until the name is set
  if (state.origin && dealerNameMissing(state.settings.dealer)) message += ` ${NO_DEALER_NAME}`;
  if (!(await save('settings'))) { render(); return; } // the status says why; the registry the worker reads must not change on an unsaved setting
  await saveProfile(state.settings, undefined, state.origin); // the person's explicit save is what (re)creates the synced profile
  if (basisChanged && ownListings()) message += ' Your listings keep the price they were posted at; the new price setting is for new posts.';
  await setSiteAuto(state.settings.autoRescan);
  const note = $('saved');
  if (note) note.textContent = message;
  render();
  const again = $('saved');
  if (again) again.textContent = message;
}

async function init() {
  $('scan').addEventListener('click', scan);
  $('settingsBtn').addEventListener('click', () => {
    state.view = state.view === 'settings' ? 'todo' : 'settings';
    render();
  });
  $('tabs').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-view]');
    if (!b) return;
    state.view = b.dataset.view;
    render();
  });
  $('panel').addEventListener('click', onPanelClick);
  $('panel').addEventListener('submit', onSettingsSubmit);
  $('panel').addEventListener('change', (ev) => {
    if (ev.target.id === 'pickAll' || ev.target.classList.contains('pick')) onPickChange(ev.target);
    else if (ev.target.id === 'readySort') changeReadySort(ev.target.value);
  });
  // the Ready tab's search box: filters as you type, Escape clears it; in
  // Settings, the warning under the name, role, dealership name or price note follows the typing
  $('panel').addEventListener('input', (ev) => {
    if (Object.hasOwn(WARNED_FIELDS, ev.target.name) || Object.hasOwn(DEALER_FIELDS, ev.target.name) || ev.target.name === 'priceNote') {
      refreshSettingWarnings(ev.target);
      return;
    }
    if (ev.target.id !== 'readySearch') return;
    state.readyFilter = ev.target.value;
    renderReadyBody();
  });
  $('panel').addEventListener('keydown', (ev) => {
    if (ev.target.id !== 'readySearch' || ev.key !== 'Escape' || !ev.target.value) return;
    ev.preventDefault();
    ev.target.value = '';
    state.readyFilter = '';
    renderReadyBody();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    // the side panel, the wizard and the service worker all write while the
    // popup can be open; keep up so a click here never writes stale data back.
    // The popup's own writes come back through here too: a value that is
    // already what the popup holds is not a change, so nothing is redrawn
    // under the person's pointer.
    if (area !== 'local' || !state.origin) return;
    const k = siteKeys(state.origin);
    const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    let touched = false;
    const changed = (key) => Boolean(changes[key]) && !isOwnEcho(key);
    const take = (key, field, fallback) => {
      if (!changed(key)) return;
      const next = changes[key].newValue ?? fallback;
      if (same(next, state[field])) return;
      state[field] = next;
      touched = true;
    };
    take(k.queue, 'queue', null);
    take(k.posted, 'posted', {});
    take(k.postLog, 'postLog', []);
    take(k.drafts, 'drafts', {});
    take(k.diff, 'diff', null);
    take(k.snapshot, 'snapshot', null);
    take(k.pilot, 'pilot', null);
    take(k.takenDown, 'takenDown', null); // a take-down from the side panel's To do upkeep: the cap counts it
    if (changes[k.sync]) {
      const next = changes[k.sync].newValue ?? null;
      // the server's count of today's posts feeds the cap, and the posts it would not share are named on To do and My listings,
      // so the lists are redrawn when either moves; the rest is shown in Settings only
      if (!same(next && next.postsToday, state.syncState && state.syncState.postsToday)) touched = true;
      if (!same(next && next.notShared, state.syncState && state.syncState.notShared)) touched = true;
      state.syncState = next;
    }
    if (accountsConfigured() && changes[GLOBAL_KEYS.account]) state.account.session = changes[GLOBAL_KEYS.account].newValue || null; // the worker refreshed the session, or a rejected token signed the person out
    if (changed(k.settings) && changes[k.settings].newValue && !same(changes[k.settings].newValue, state.settings)) {
      state.settings = withDefaults(changes[k.settings].newValue, state.snapshot?.site || {});
      state.settingsFromProfile = false;
      touched = true;
    }
    if (changed(k.wizardDone)) { const v = Boolean(changes[k.wizardDone].newValue); if (v !== state.wizardDone) { state.wizardDone = v; touched = true; } }
    if (changed(k.wizard)) { const w = changes[k.wizard].newValue; const v = Boolean(w && w.active && w.step !== 'done'); if (v !== state.wizardActive) { state.wizardActive = v; touched = true; } }
    if (changed(SITES_KEY)) {
      const before = scheduleBanner();
      state.site = (changes[SITES_KEY].newValue || {})[state.origin] || null;
      if (scheduleBanner() !== before) touched = true;
    }
    // while a scan runs, its final render draws everything at once
    if (touched && state.view !== 'settings' && !state.scanning) render();
  });
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    state.tab = tab || null;
    const url = tab && tab.url ? new URL(tab.url) : null;
    if (url && /^https?:$/.test(url.protocol) && !/(^|\.)facebook\.com$/i.test(url.hostname)) {
      // Facebook is where listings go, never a dealership website to scan or set up.
      state.origin = url.origin;
      await loadSaved();
      state.siteName = state.snapshot?.site?.name || url.hostname.replace(/^www\./, '');
    }
  } catch (e) {
    // no access to this tab's address; the Scan button explains what to do
  }
  if (accountsConfigured()) state.account.session = await loadSession(chrome.storage.local); // with an empty config the session is never even read
  render();
}

const initDone = init();
