import { assessVehicle, DECISION } from './src/classify.js';
import { makeSnapshot, diffScans, markPosted, markPriceUpdated, markTakenDown, basisPrice } from './src/rescan.js';
import { performScan } from './src/scanRunner.js';
import { todoCountFor, originsFor } from './src/rescanSchedule.js';
import { defaultSettings, withDefaults, feeGap, suggestedPriceNote, loadProfile, saveProfile, settingsFromProfile, showsLowerPrice, chooseBasis, PROFILE_KEY, DEFAULT_SALESPERSON_TITLE } from './src/settings.js';
import { capStatus, DEFAULT_DAILY_CAP } from './src/cap.js';
import { TITLE_STATUSES, CONDITIONS } from './src/listingData.js';
import { createQueue, currentVin, describe as describeQueue } from './src/queue.js';
import { FORM_MAP } from './facebook/formMap.js';
import { recordFlags, resolveFlag, updatePilot, summarizePilot, pilotText, pilotCsv, pilotFileName, hasPilotData } from './src/pilot.js';
import { LEGAL, acceptLegal, legalIsCurrent } from './src/legalLinks.js';

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => (typeof n === 'number' && Number.isFinite(n) ? '$' + Math.round(n).toLocaleString('en-US') : '—');
const signedMoney = (n) => (n < 0 ? '−' : '+') + money(Math.abs(n));
const miles = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') + ' mi' : 'no mileage');
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const dateOnly = (iso) => (iso ? new Date(iso).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) : '');

const state = {
  tab: null,
  origin: null, // the dealer website this popup is working on
  siteName: '',
  snapshot: null, // last saved scan
  diff: null, // to-do list from the last scan
  posted: {}, // cars this salesperson marked as posted: { vin: { name, price, postedAt, listingUrl?, salesperson? } }
  settings: null, // see src/settings.js
  settingsFromProfile: false, // true until the first scan checks the profile's store names against this website
  boilerplate: [],
  queue: null, // the batch queue (src/queue.js), shared with the side panel
  drafts: {}, // cars saved as drafts on Facebook during a queue: { vin: { name, savedAt } }
  wizardDone: false, // set-up finished (or skipped) for this website
  wizardActive: false, // set-up started in the side panel and not finished
  site: null, // this website's entry in the background-rescan registry (src/scanRunner.js SITES_KEY)
  pilot: null, // pilot numbers (src/pilot.js): post timings, fill failures per field, to-do item durations
  rescanPermission: null, // true/false once known: may the service worker read this website?
  scanning: false,
  view: 'todo',
};

// ---------- saved data (kept per website, in this browser only) ----------

const storageKeys = (origin) => ({
  snapshot: `snapshot:${origin}`,
  diff: `diff:${origin}`,
  posted: `posted:${origin}`,
  settings: `settings:${origin}`,
  boilerplate: `boilerplate:${origin}`,
  queue: `postQueue:${origin}`,
  drafts: `drafts:${origin}`,
  wizardDone: `wizardDone:${origin}`,
  wizard: `wizard:${origin}`,
  pilot: `pilot:${origin}`,
  flow: `postFlow:${origin}`, // the side panel's in-progress post; cleared with everything else
});

const rescanOrigins = () => (state.site ? originsFor(state.site.site || { origin: state.origin }, state.site.service) : []);

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
  const k = storageKeys(state.origin);
  const data = await chrome.storage.local.get([...Object.values(k), 'sites']);
  state.snapshot = data[k.snapshot] || null;
  state.diff = data[k.diff] || null;
  state.posted = data[k.posted] || {};
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
  state.site = (data.sites || {})[state.origin] || null;
  state.pilot = data[k.pilot] || null;
  await checkRescanPermission();
}

// The registry entry the service worker reads: auto on or off for this website.
async function setSiteAuto(auto) {
  const data = await chrome.storage.local.get('sites');
  const sites = data.sites || {};
  if (!sites[state.origin]) return false;
  sites[state.origin] = { ...sites[state.origin], auto: Boolean(auto) };
  state.site = sites[state.origin];
  await ownSet({ sites });
  chrome.runtime.sendMessage({ type: 'ensureAlarm' }).catch(() => {});
  return true;
}

// The popup's own storage writes come back through storage.onChanged like
// anyone else's; they are counted here so the listener can tell an echo
// from a change made by the side panel or the service worker.
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
  noteOwn(Object.keys(obj));
  await chrome.storage.local.set(obj);
}
async function ownRemove(keys) {
  noteOwn(keys);
  await chrome.storage.local.remove(keys);
}

async function save(...names) {
  const k = storageKeys(state.origin);
  const out = {};
  for (const name of names) out[k[name]] = state[name];
  await ownSet(out);
  if (names.includes('settings') && state.settings) await saveProfile(state.settings, undefined, state.origin);
  if (names.includes('diff') || names.includes('posted')) chrome.runtime.sendMessage({ type: 'updateBadge' }).catch(() => {});
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
    const r = await performScan({ tabId: state.tab.id, origin: state.origin, settings: state.settings, settingsFromProfile: state.settingsFromProfile, snapshot: state.snapshot, posted: state.posted });
    if (!r.ok) {
      setStatus(r.message, 'error');
      return;
    }
    state.settings = r.settings;
    state.settingsFromProfile = false;
    state.boilerplate = r.boilerplate;
    state.diff = r.diff;
    if (!r.diff.unreliable) state.snapshot = r.snapshot; // keep the last good scan if this one looks broken
    state.siteName = r.site.name;
    await save('snapshot', 'diff', 'settings', 'boilerplate');
    state.pilot = await recordFlags(state.origin, r.diff, r.diff.takenAt).catch(() => state.pilot); // pilot numbers: when a to-do item first appeared
    // the scan registered the website for background rescans; show its state
    state.site = ((await chrome.storage.local.get('sites')).sites || {})[state.origin] || null;
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
  return {
    all,
    ready: all.filter((e) => e.decision === DECISION.READY),
    notReady: all.filter((e) => e.decision === DECISION.NOT_READY && !has(e, 'other-store')),
    otherStores: all.filter((e) => e.decision === DECISION.NOT_READY && has(e, 'other-store')),
    review: all.filter((e) => e.decision === DECISION.REVIEW),
    skipped: all.filter((e) => e.decision === DECISION.SKIP),
    mine: Object.entries(state.posted).map(([vin, p]) => ({ vin, ...p, now: state.snapshot?.vehicles?.[vin] || null })),
  };
}

const todoCount = () => todoCountFor(state.diff);

const VIEWS = [
  ['todo', 'To do'],
  ['ready', 'Ready to post'],
  ['notReady', 'Not ready'],
  ['otherStores', 'Other stores'],
  ['review', 'Needs a look'],
  ['mine', 'My listings'],
  ['pilot', 'Pilot'],
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

function row(e, { sub = '', right = '', action = '', muted = false, pick = false } = {}) {
  const name = /^https?:\/\//i.test(e.url || '')
    ? `<a class="name" href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.name)}</a>`
    : `<span class="name">${esc(e.name)}</span>`;
  const box = pick ? `<input type="checkbox" class="pick" data-vin="${esc(e.vin)}" aria-label="Queue ${esc(e.name)}" />` : '';
  return `<li class="row${muted ? ' muted' : ''}">${box}<div class="main">${name}<div class="sub">${sub}</div></div>${
    right ? `<div class="price">${right}</div>` : ''
  }${action}</li>`;
}

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
// posted" is for a listing the salesperson made by hand.
function postButton(vin, { canPost = true } = {}) {
  if (state.posted[vin]) return `<button type="button" class="small" data-action="unpost" data-vin="${esc(vin)}" title="Click to unmark">Posted ✓</button>`;
  if (state.drafts[vin]) {
    return `<span class="actions"><span class="pill warn" title="Saved as a draft on Facebook; publish it there, then mark it posted">Draft on Facebook</span><button type="button" class="small go" data-action="post" data-vin="${esc(vin)}">Mark posted</button></span>`;
  }
  const capReached = capStatus(state.posted, state.settings?.dailyCap).reached;
  const post = canPost
    ? `<button type="button" class="small go" data-action="openPost" data-vin="${esc(vin)}" ${capReached ? 'disabled' : ''} title="${capReached ? 'Daily post cap reached; it resets tomorrow' : 'Pre-fill the Marketplace form in the side panel. You click Publish.'}">Post</button>`
    : '';
  return `<span class="actions">${post}<button type="button" class="small" data-action="post" data-vin="${esc(vin)}" title="Already listed it yourself? Mark it posted so rescans watch it.">Mark posted</button></span>`;
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
    : "<b>First time here?</b> Set-up takes two minutes in the side panel: your store, your name, the store's address, automatic rescans, the posting rules and the Terms of Service.";
  const later = state.snapshot ? '<button type="button" class="small" data-action="skipSetup" title="Settings has the same fields">Not now</button>' : '';
  return `<div class="banner setup" id="setup">${text}<div class="toolbar"><button type="button" class="small go" data-action="setup">${active ? 'Continue set-up' : 'Set up Lot Sync'}</button>${later}</div></div>`;
}

// When automatic rescans are switched on but cannot run, say so here rather than nowhere.
function scheduleBanner() {
  const s = state.site;
  if (!s || !s.auto) return '';
  if (state.rescanPermission === false) {
    return `<div class="banner warn" id="scheduleWarning">Automatic rescans are on, but Lot Sync has no permission to read this website in the background, so they can't run. <button type="button" class="small go" data-action="allowRescans">Allow automatic rescans</button></div>`;
  }
  if (s.lastError && (!s.lastScan || String(s.lastAttempt || '') > String(s.lastScan))) {
    return `<div class="banner warn" id="scheduleWarning">The last automatic rescan (${esc(when(s.lastAttempt))}) failed: ${esc(s.lastError)}</div>`;
  }
  return '';
}

function viewTodo(l) {
  const d = state.diff;
  if (!state.snapshot && !d) {
    return setupBanner() + empty("Or just click <b>Scan website</b> on your dealership's used inventory page.");
  }
  let html = setupBanner() + scheduleBanner();
  html += `<div class="meta">Last scan ${esc(when(d?.takenAt || state.snapshot?.takenAt))} · ${l.all.length} used cars · ${l.ready.length} ready to post</div>`;
  for (const w of d?.warnings || []) html += `<div class="banner warn">${esc(w)}</div>`;
  if (d?.firstScan) {
    html += `<div class="banner info">First scan saved. Start with the <b>Ready to post</b> tab. From now on, each scan compares with the last one and lists what sold, what changed price and what's new. Mark cars as posted so your own listings come first.</div>`;
  }
  const parts = [];
  const takeDown = d?.takeDown || [];
  if (takeDown.length) {
    parts.push(
      section('Take down', 'bad', takeDown.map((t) =>
        row(t, {
          sub: esc(t.text) + (t.yours ? '' : ' · not marked as posted'),
          right: t.lastPrice ? money(t.lastPrice) : '',
          action: t.yours
            ? `<span class="actions"><button type="button" class="small go" data-action="upkeep" data-kind="takeDown" data-vin="${esc(t.vin)}" title="Opens your listing so you can mark it sold or delete it">Open listing</button><button type="button" class="small" data-action="takenDown" data-vin="${esc(t.vin)}">Taken down</button></span>`
            : '',
          muted: !t.yours,
        })
      ))
    );
  }
  const updates = d?.priceUpdates || [];
  if (updates.length) {
    parts.push(
      section('Update price', 'warn', updates.map((p) =>
        row(p, {
          sub: (p.yours ? 'Your listing' : 'Not marked as posted') + (p.stock ? ' · Stock ' + esc(p.stock) : ''),
          right: `${money(p.from)} → <b>${money(p.to)}</b> <span class="${p.change < 0 ? 'down' : 'up'}">${signedMoney(p.change)}</span>`,
          action: p.yours
            ? `<span class="actions"><button type="button" class="small go" data-action="upkeep" data-kind="price" data-vin="${esc(p.vin)}" data-price="${p.to}" title="Opens your listing with the new price ready to fill in; you click Update">Open &amp; update price</button><button type="button" class="small" data-action="priceUpdated" data-vin="${esc(p.vin)}" data-price="${p.to}">Updated</button></span>`
            : '',
          muted: !p.yours,
        })
      ))
    );
  }
  const arrivals = d?.newArrivals || [];
  if (arrivals.length) {
    const readyArrivals = arrivals.filter((n) => n.decision === DECISION.READY && !state.posted[n.vin]);
    const queueAll = readyArrivals.length > 1
      ? `<div class="toolbar"><button type="button" class="small go" data-action="queueArrivals">Queue all ${readyArrivals.length} ready arrivals</button><span class="hint">Pre-fills them one at a time in the side panel; you click Publish on each.</span></div>`
      : '';
    parts.push(
      section('New arrivals', 'good', arrivals.map((n) =>
        row(n, {
          sub: decisionPill(n.decision) + (n.decision === DECISION.READY ? '' : ' ' + esc(n.reason)),
          right: money(n.price),
          action: n.decision === DECISION.READY ? postButton(n.vin) : '',
        })
      )) + queueAll
    );
  }
  const nowReady = d?.nowReady || [];
  if (nowReady.length) parts.push(section('Just became ready', 'good', nowReady.map((n) => row(n, { sub: esc(n.what), action: postButton(n.vin) }))));
  const look = d?.needsALook || [];
  if (look.length) parts.push(section('Needs a look', 'warn', look.map((n) => row(n, { sub: esc(n.text) + (n.yours ? ' · your listing' : '') }))));
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

const capText = (cap) => `Daily post cap reached (${cap.used} of ${cap.cap} today). It resets tomorrow; the dealer can change it in Settings.`;

function viewReady(l) {
  const lead = `<p class="lead">Pre-owned, at your store, with photos and a price. Click <b>Post</b> on one car, or tick several and <b>Post</b> them as a queue: the side panel pre-fills each form and you click Publish on each. Listed one by hand? Click <b>Mark posted</b>.</p>`;
  if (!l.ready.length) return lead + queueStatusHtml() + empty('No cars are ready right now.');
  const cap = capStatus(state.posted, state.settings?.dailyCap);
  const pickable = l.ready.filter((e) => !state.posted[e.vin]);
  const capBanner = cap.reached ? `<div class="banner warn" id="capReached">${esc(capText(cap))}</div>` : '';
  const toolbar = pickable.length > 1 && !cap.reached
    ? `<div class="toolbar"><label><input type="checkbox" id="pickAll" /> <span>Select the next ${Math.min(cap.remaining, pickable.length)}</span></label><button type="button" class="small go" data-action="queue" id="queueBtn" disabled>Post selected</button><span class="hint" id="pickHint">${cap.remaining} more post${cap.remaining === 1 ? '' : 's'} allowed today.</span></div>`
    : '';
  return lead + queueStatusHtml() + capBanner + toolbar + rows(l.ready.map((e) => row(e, { sub: facts(e), right: money(price(e)), action: postButton(e.vin), pick: !state.posted[e.vin] && !cap.reached })));
}

// Ticking: never more than the day's remaining posts. "Select all" takes the
// first N cars from the top, where N is what's left today.
function onPickChange(target) {
  const cap = capStatus(state.posted, state.settings?.dailyCap);
  const boxes = [...document.querySelectorAll('.pick')];
  if (target.id === 'pickAll') {
    boxes.forEach((box, i) => { box.checked = target.checked && i < cap.remaining; });
    if (target.checked && boxes.length > cap.remaining) setStatus(`Selected the first ${cap.remaining}: that's all that's allowed today.`);
  } else if (target.checked && boxes.filter((b) => b.checked).length > cap.remaining) {
    target.checked = false;
    setStatus(`Only ${cap.remaining} more post${cap.remaining === 1 ? '' : 's'} allowed today.`, 'error');
  }
  const picked = boxes.filter((b) => b.checked).length;
  const all = $('pickAll');
  if (all) all.checked = picked > 0 && picked === Math.min(cap.remaining, boxes.length);
  updateQueueButton();
}

function updateQueueButton() {
  const btn = $('queueBtn');
  if (!btn) return;
  const n = document.querySelectorAll('.pick:checked').length;
  btn.disabled = n === 0;
  btn.textContent = n ? `Post ${n} car${n === 1 ? '' : 's'}` : 'Post selected';
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

function viewMine(l) {
  const lead = `<p class="lead">Cars you've marked as posted. Each scan compares these with the website.</p>`;
  if (!l.mine.length) return lead + empty('Nothing marked as posted yet. Use <b>Mark posted</b> on the Ready to post tab.');
  return (
    lead +
    rows(
      l.mine.map((p) => {
        const now = p.now;
        const site = now ? price(now) : null;
        let pill = '<span class="pill good">Matches the website</span>';
        let extra = '';
        if (!now) pill = '<span class="pill bad">Not on the website at the last scan</span>';
        else if (site && site !== p.price) {
          pill = '<span class="pill warn">Website price changed</span>';
          extra = `<button type="button" class="small go" data-action="priceUpdated" data-vin="${esc(p.vin)}" data-price="${site}">Updated</button>`;
        }
        const entry = { name: p.name, url: now?.url };
        const link = /^https?:\/\//i.test(p.listingUrl || '') ? ` · <a href="${esc(p.listingUrl)}" target="_blank" rel="noopener">Open listing</a>` : '';
        return row(entry, {
          sub: `${pill} Posted ${esc(when(p.postedAt))}${p.updatedAt ? ' · price updated ' + esc(when(p.updatedAt)) : ''}${link}`,
          right: `Listed ${money(p.price)}${now && site !== p.price ? `<br>Website ${money(site)}` : ''}`,
          action: `${extra}<button type="button" class="small" data-action="takenDown" data-vin="${esc(p.vin)}">Taken down</button>`,
        });
      })
    )
  );
}

// ---------- pilot numbers ----------

const FIELD_LABELS = Object.fromEntries(FORM_MAP.fields.map((f) => [f.key, f.label]));
const secs = (s) => (typeof s === 'number' ? `${s} s` : '—');
const hrs = (h) => (typeof h === 'number' ? `${h} h` : '—');

// What the pilot agreement lets Lot Sync record, for the weekly check-in and
// the manager: time per post, fields that could not be filled, how long sold
// cars and price changes stayed on the salesperson's listings. Kept in this
// browser only, per website; Download CSV is how it leaves.
function viewPilot() {
  const lead = `<p class="lead">Numbers for the pilot, kept in this browser only: how long each post takes, which form fields Lot Sync couldn't fill, and how long sold cars and price changes stayed on your listings. No customer data, and nothing from Facebook beyond your own listings. <b>Download CSV</b> gives your manager the spreadsheet.</p>`;
  if (!hasPilotData(state.pilot)) return lead + empty('Nothing recorded yet. The numbers start with the first post through the side panel.');
  const s = summarizePilot(state.pilot, { labels: FIELD_LABELS });
  const stat = (k, v) => `<tr><td>${k}</td><td class="n">${v}</td></tr>`;
  const notPosted = s.posts.skipped + s.posts.blocked + s.posts.notPosted + s.posts.abandoned;
  const posts = `<h3>Posts <span class="pill ${s.posts.posted ? 'good' : ''}">${s.posts.posted}</span></h3><table class="stats" id="pilotPosts">
    ${stat('Posted through Lot Sync', s.posts.posted)}
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
    ${stat('Done', `${t.done}${t.done ? ` (${t.detected} seen on the listing by Lot Sync)` : ''}`)}
    ${stat('Median time open, from the scan that flagged it', hrs(t.medianHours))}
    ${stat('Longest', hrs(t.longestHours))}
    ${stat('Still open', t.open ? t.openItems.map((o) => `${esc(o.name)} (${hrs(o.hoursOpen)})`).join('<br>') : '0')}
    ${t.cleared ? stat('Cleared by the website (the car came back, or the price went back)', t.cleared) : ''}
  </table>`;
  const toolbar = `<div class="toolbar"><button type="button" class="small go" data-action="pilotCsv">Download CSV</button><button type="button" class="small" data-action="pilotCopy">Copy summary</button><button type="button" class="small" data-action="pilotClear">Clear pilot numbers</button></div>`;
  return lead + toolbar + posts + fields + flagTable('Sold cars to take down', s.takeDowns, 'pilotTakeDowns') + flagTable('Price changes', s.priceUpdates, 'pilotPrices');
}

const field = (label, name, value, attrs = 'type="text"') =>
  `<label class="field"><span class="k">${esc(label)}</span><input name="${name}" value="${esc(value)}" ${attrs} /></label>`;
const choices = (list, current) =>
  `<option value="" ${current === '' ? 'selected' : ''}>Leave blank</option>` + list.map((o) => `<option value="${esc(o)}" ${o === current ? 'selected' : ''}>${esc(o)}</option>`).join('');

function viewSettings() {
  const entries = Object.values(state.snapshot?.vehicles || {});
  const locations = [...new Set(entries.map((e) => e.location).filter(Boolean))].sort();
  const s = withDefaults(state.settings || {}, { name: state.siteName });
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
  const version = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '';
  return `<form id="settings" class="settings">
    <p class="hint" id="version">Lot Sync ${esc(version)} · form map ${esc(FORM_MAP.version)}</p>
    <fieldset><legend>You</legend>
      ${field('Your name', 'salespersonName', s.salesperson.name, 'type="text" placeholder="Your first name"')}
      ${field('Your role', 'salespersonTitle', s.salesperson.title, 'type="text"')}
      <p class="hint">Every description ends with "I'm [name], [role] at [dealership]". Posing as a private seller isn't allowed.</p>
    </fieldset>
    <fieldset><legend>Your store</legend>
      <p class="hint">Only cars at these stores count as ready to post. Leave all unticked to include every store.</p>
      ${stores}
    </fieldset>
    <fieldset><legend>Dealership, named on every listing</legend>
      ${field('Dealership name', 'dealerName', s.dealer.name)}
      ${field('City', 'dealerCity', s.dealer.city)}
      ${field('State', 'dealerState', s.dealer.state, 'type="text" placeholder="e.g. OH" maxlength="2"')}
      ${field('ZIP', 'dealerZip', s.dealer.zip, 'type="text" placeholder="e.g. 43215" inputmode="numeric"')}
      <p class="hint">Marketplace asks for a location. The ZIP is used when it's set, otherwise the city.</p>
    </fieldset>
    <fieldset><legend>Price to post</legend>
      <label><input type="radio" name="basis" value="website" ${s.basis !== 'beforeFees' ? 'checked' : ''} /> <span>The website's main price${example ? ` (e.g. ${money(example.price)} "${esc(example.priceLabel)}")` : ''}</span></label>
      ${!state.snapshot || showsLowerPrice(entries)
        ? `<label><input type="radio" name="basis" value="beforeFees" ${s.basis === 'beforeFees' ? 'checked' : ''} /> <span>The lower second price the website shows${example ? ` (e.g. ${money(example.priceBeforeFees)}; usually the price before the doc fee)` : ''}</span></label>
      <p class="hint">Some states require the advertised price to include dealer fees. Check with your manager before choosing this. A car with no lower second price is posted at the main price, without the price note.</p>`
        : ''}
      ${feeNote}
      ${field('Price note in every description', 'priceNote', s.priceNote, `type="text" placeholder="${esc(suggested || 'e.g. Tax and tags extra.')}"`)}
      <p class="hint">Honest prices: the listed price always equals the website price. This note explains what it includes.${suggested ? ` Suggested: "${esc(suggested)}"` : ''}</p>
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
    <fieldset><legend>Automatic rescans</legend>
      <label><input type="checkbox" name="autoRescan" ${s.autoRescan ? 'checked' : ''} /> <span>Rescan this website every 3 hours while Chrome is open, and show the to-do count on the icon</span></label>
      <label><input type="checkbox" name="notify" ${s.notify !== false ? 'checked' : ''} /> <span>Desktop notification when listings need attention</span></label>
      ${!state.site
        ? '<p class="hint">Scan this website once first. Then the permission to read it in the background can be granted here.</p>'
        : state.rescanPermission
          ? '<p class="hint">Permission to read this website in the background: granted. Lot Sync only reads the website then; it never touches Facebook on its own.</p>'
          : '<p class="hint">Needs permission to read this website in the background (Chrome will ask). <button type="button" class="small go" data-action="allowRescans">Allow automatic rescans</button></p>'}
    </fieldset>
    <fieldset><legend>Description writer (optional)</legend>
      <label><input type="checkbox" name="rewriteEnabled" ${s.rewrite.enabled ? 'checked' : ''} /> <span>Use the Lot Sync rewrite service (Claude) for first drafts</span></label>
      ${field('Service address', 'rewriteEndpoint', s.rewrite.endpoint, 'type="url" placeholder="http://localhost:8787"')}
      ${field('Service key', 'rewriteKey', s.rewrite.key, 'type="password" autocomplete="off"')}
      <p class="hint">Off by default: descriptions come from a built-in template. Either way every draft is checked against the website's facts, and you review it before posting.</p>
    </fieldset>
    <fieldset><legend>Terms and privacy</legend>
      <p class="hint" id="legalLinks"><a href="${esc(LEGAL.termsUrl)}" target="_blank" rel="noopener">Terms of Service</a> · <a href="${esc(LEGAL.privacyUrl)}" target="_blank" rel="noopener">Privacy Policy</a></p>
      ${legalIsCurrent(s.legal)
        ? `<p class="hint" id="legalStatus">Accepted ${esc(dateOnly(s.legal.acceptedAt))} (version ${esc(s.legal.version)}).</p>`
        : `<p class="hint" id="legalStatus">${s.legal.acceptedAt ? `You accepted version ${esc(s.legal.version || 'unknown')} on ${esc(dateOnly(s.legal.acceptedAt))}; the current version is ${esc(LEGAL.version)}` : 'Not accepted yet'}: run Set up Lot Sync, or tick here.</p>
      <label><input type="checkbox" name="legalAccept" /> <span>I have read and accept the Terms of Service and the Privacy Policy</span></label>`}
    </fieldset>
    <div class="actions"><button type="submit" class="plain">Save settings</button><span class="hint" id="saved"></span></div>
    <fieldset style="margin-top:14px"><legend>Saved data</legend>
      <p class="hint">Scans and your posted list are kept only in this browser, separately for each website.</p>
      <button type="button" class="danger" data-action="clear">Clear everything for this website</button>
      <p class="hint">Your profile (name, role, dealership, price basis, note, cap, listing defaults, Terms acceptance) is also kept in Chrome's sync storage under your own Google account, so it follows you to other computers. This removes it from there; the settings on this computer stay.</p>
      <button type="button" class="danger" data-action="forgetProfile">Forget my synced profile</button>
    </fieldset>
  </form>`;
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
  $('panel').innerHTML = (views[state.view] || viewTodo)(l);
}

// ---------- actions ----------

let clearArmed = false;
let pilotClearArmed = false;

// Pilot numbers: an item the person ticked off by hand, or a car unmarked.
const notePilot = (change) => updatePilot(state.origin, change).then((p) => { state.pilot = p; }).catch(() => null);

async function onPanelClick(ev) {
  const btn = ev.target.closest('button[data-action]');
  if (!btn) return;
  const vin = btn.dataset.vin;
  const dropFromDiff = (list) => {
    if (state.diff && Array.isArray(state.diff[list])) state.diff[list] = state.diff[list].filter((x) => x.vin !== vin);
  };
  switch (btn.dataset.action) {
    case 'post': {
      const entry = state.snapshot?.vehicles?.[vin];
      if (!entry) return;
      state.posted = markPosted(state.posted, entry, state.settings?.basis);
      await save('posted');
      break;
    }
    case 'openPost': {
      // Hands the car to the side panel, which re-checks it on the website,
      // writes the description and pre-fills the Marketplace form.
      const entry = state.snapshot?.vehicles?.[vin];
      if (!entry || entry.decision !== DECISION.READY || !state.tab) return;
      const cap = capStatus(state.posted, state.settings?.dailyCap);
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
      await chrome.storage.local.set({ postRequest: { origin: state.origin, vin, dealerTabId: state.tab.id, windowId: state.tab.windowId, at: Date.now() } });
      setStatus(opened ? `Continue in the side panel: ${entry.name}` : 'Open the Lot Sync side panel (Chrome menu → Side panel) to continue posting this car.');
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
          ? [...document.querySelectorAll('.pick:checked')].map((i) => i.dataset.vin)
          : (state.diff?.newArrivals || []).filter((n) => n.decision === DECISION.READY && !state.posted[n.vin]).map((n) => n.vin);
        const cap = capStatus(state.posted, state.settings?.dailyCap);
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
      await ownSet({
        [storageKeys(state.origin).queue]: queue,
        postRequest: { origin: state.origin, vin: first, dealerTabId: state.tab.id, windowId: state.tab.windowId, queue: true, at: Date.now() },
      });
      if (!opened) setStatus('Open the Lot Sync side panel (Chrome menu → Side panel) to work through the queue.');
      else setStatus(`Queue of ${queue.vins.length}: continue in the side panel.`);
      render();
      return;
    }
    case 'clearQueue':
      state.queue = null;
      await ownRemove([storageKeys(state.origin).queue]);
      break;
    case 'upkeep': {
      // Hands a to-do item to the side panel: it opens the listing, fills the
      // new price when the edit form appears, and marks the item done once it
      // sees the change. The person clicks Update / Mark as sold / Delete.
      if (!state.tab) return;
      const p = state.posted[vin] || {};
      const item = { origin: state.origin, vin, kind: btn.dataset.kind, price: Number(btn.dataset.price) || null, listingUrl: p.listingUrl || '', name: p.name || state.snapshot?.vehicles?.[vin]?.name || vin, listedPrice: p.price || null, dealerTabId: state.tab.id, windowId: state.tab.windowId, at: Date.now() };
      let opened = true;
      try {
        await chrome.sidePanel.open({ windowId: state.tab.windowId }); // straight from the click
      } catch (e) {
        opened = false;
      }
      await chrome.storage.local.set({ upkeepRequest: item });
      setStatus(opened ? `Continue in the side panel: ${item.name}` : 'Open the Lot Sync side panel (Chrome menu → Side panel) to continue.');
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
      await chrome.storage.local.set({ setupRequest: { origin: state.origin, dealerTabId: state.tab.id, windowId: state.tab.windowId, at: Date.now() } });
      setStatus(opened ? 'Continue in the side panel.' : 'Open the Lot Sync side panel (Chrome menu → Side panel) to continue set-up.');
      return;
    }
    case 'skipSetup':
      state.wizardDone = true;
      await ownSet({ [storageKeys(state.origin).wizardDone]: { skipped: true, at: new Date().toISOString() } });
      setStatus('Settings has the same fields. Set-up can be run later after "Clear everything for this website".');
      break;
    case 'allowRescans': {
      // Asks Chrome straight from the click (a user gesture) for the host
      // permission the service worker needs, then switches rescans on.
      if (!state.site) return;
      let granted = false;
      try {
        granted = await chrome.permissions.request({ origins: rescanOrigins() });
      } catch (e) {
        setStatus("Couldn't ask Chrome for permission: " + ((e && e.message) || e), 'error');
      }
      state.rescanPermission = granted;
      if (granted) {
        state.settings = withDefaults({ ...(state.settings || {}), autoRescan: true }, state.snapshot?.site || { name: state.siteName });
        await save('settings');
        await setSiteAuto(true);
        setStatus('Automatic rescans are on: every 3 hours while Chrome is open.');
      } else {
        await setSiteAuto(false);
        setStatus('Not allowed, so automatic rescans stay off. Scan by hand any time.', 'error');
      }
      break;
    }
    case 'unpost':
      state.posted = markTakenDown(state.posted, vin);
      await save('posted');
      notePilot((p) => resolveFlag(p, vin, null, { how: 'cleared' })); // fire-and-forget: the redraw must not wait for the pilot bookkeeping
      break;
    case 'takenDown':
      state.posted = markTakenDown(state.posted, vin);
      dropFromDiff('takeDown');
      dropFromDiff('priceUpdates');
      dropFromDiff('needsALook');
      await save('posted', 'diff');
      notePilot((p) => resolveFlag(p, vin, null, { how: 'manual' }));
      break;
    case 'priceUpdated':
      state.posted = markPriceUpdated(state.posted, vin, Number(btn.dataset.price));
      dropFromDiff('priceUpdates');
      await save('posted', 'diff');
      notePilot((p) => resolveFlag(p, vin, 'price', { how: 'manual' }));
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
    case 'forgetProfile':
      try {
        await chrome.storage.sync.remove(PROFILE_KEY);
        setStatus('Your synced profile was removed from Chrome\'s sync storage. The settings on this computer are unchanged; saving them again re-creates the profile.');
      } catch (e) {
        setStatus("Couldn't reach Chrome's sync storage: " + ((e && e.message) || e), 'error');
      }
      return;
    case 'pilotClear':
      if (!pilotClearArmed) {
        pilotClearArmed = true;
        btn.textContent = 'Click again to clear the pilot numbers';
        return;
      }
      pilotClearArmed = false;
      state.pilot = null;
      await ownRemove([storageKeys(state.origin).pilot]);
      setStatus('Pilot numbers cleared for this website.');
      break;
    case 'clear':
      if (!clearArmed) {
        clearArmed = true;
        btn.textContent = 'Click again to clear everything';
        return;
      }
      Object.assign(state, { snapshot: null, diff: null, posted: {}, settings: null, settingsFromProfile: false, queue: null, drafts: {}, wizardDone: false, wizardActive: false, site: null, pilot: null, rescanPermission: null, view: 'todo' });
      await ownRemove(Object.values(storageKeys(state.origin)));
      {
        // forget the website for background rescans too, and take its count off the badge
        const data = await chrome.storage.local.get('sites');
        if (data.sites && data.sites[state.origin]) {
          delete data.sites[state.origin];
          await ownSet({ sites: data.sites });
        }
      }
      chrome.runtime.sendMessage({ type: 'updateBadge' }).catch(() => {});
      clearArmed = false;
      setStatus('Cleared. Scan again, or run set-up, to start over.');
      break;
    default:
      return;
  }
  render();
}

async function onSettingsSubmit(ev) {
  if (ev.target.id !== 'settings') return;
  ev.preventDefault();
  const form = new FormData(ev.target);
  const prev = withDefaults(state.settings || {}, { name: state.siteName });
  const str = (k) => String(form.get(k) ?? '').trim();
  state.settings = withDefaults(
    {
      ...prev,
      myStores: form.getAll('store').map(String),
      basis: chooseBasis(form.get('basis'), prev.basis, state.snapshot ? Object.values(state.snapshot.vehicles || {}) : null), // the lower price only when this website shows one; without a scan the previous choice stands
      salesperson: { name: str('salespersonName'), title: str('salespersonTitle') || DEFAULT_SALESPERSON_TITLE },
      dealer: { name: str('dealerName') || prev.dealer.name, city: str('dealerCity'), state: str('dealerState').toUpperCase(), zip: str('dealerZip') },
      priceNote: str('priceNote'),
      dailyCap: Math.max(1, Math.min(100, Number(form.get('dailyCap')) || DEFAULT_DAILY_CAP)),
      rewrite: { enabled: form.get('rewriteEnabled') === 'on', endpoint: str('rewriteEndpoint'), key: str('rewriteKey') },
      defaults: { titleStatus: str('defaultTitleStatus'), condition: str('defaultCondition') },
      autoRescan: form.get('autoRescan') === 'on',
      notify: form.get('notify') === 'on',
      legal: form.get('legalAccept') === 'on' ? acceptLegal() : prev.legal, // the tick is the same acceptance the wizard's Terms step records
    },
    { name: state.siteName }
  );
  let message = 'Saved. Click Rescan website to apply.';
  if (state.settings.autoRescan && state.site && !state.rescanPermission) {
    // Rescans need the host permission; the Save click is a user gesture, so ask now.
    try {
      state.rescanPermission = await chrome.permissions.request({ origins: rescanOrigins() });
    } catch (e) {
      state.rescanPermission = false;
    }
    if (!state.rescanPermission) {
      state.settings.autoRescan = false;
      message = 'Saved, but automatic rescans stay off: Lot Sync was not allowed to read this website in the background.';
    }
  }
  if (state.settings.autoRescan && !state.site) {
    state.settings.autoRescan = false;
    message = 'Saved, but automatic rescans need one scan of this website first.';
  }
  await save('settings');
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
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    // the side panel, the wizard and the service worker all write while the
    // popup can be open; keep up so a click here never writes stale data back.
    // The popup's own writes come back through here too: a value that is
    // already what the popup holds is not a change, so nothing is redrawn
    // under the person's pointer.
    if (area !== 'local' || !state.origin) return;
    const k = storageKeys(state.origin);
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
    take(k.drafts, 'drafts', {});
    take(k.diff, 'diff', null);
    take(k.snapshot, 'snapshot', null);
    take(k.pilot, 'pilot', null);
    if (changed(k.settings) && changes[k.settings].newValue && !same(changes[k.settings].newValue, state.settings)) {
      state.settings = withDefaults(changes[k.settings].newValue, state.snapshot?.site || {});
      state.settingsFromProfile = false;
      touched = true;
    }
    if (changed(k.wizardDone)) { const v = Boolean(changes[k.wizardDone].newValue); if (v !== state.wizardDone) { state.wizardDone = v; touched = true; } }
    if (changed(k.wizard)) { const w = changes[k.wizard].newValue; const v = Boolean(w && w.active && w.step !== 'done'); if (v !== state.wizardActive) { state.wizardActive = v; touched = true; } }
    if (changed('sites')) {
      const before = scheduleBanner();
      state.site = (changes.sites.newValue || {})[state.origin] || null;
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
  render();
}

const initDone = init();
