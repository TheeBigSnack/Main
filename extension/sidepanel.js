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

import { markPosted } from './src/rescan.js';
import { fetchVehicleDetails, recheck } from './src/vehicleDetails.js';
import { generateDescription } from './src/rewriter.js';
import { runGuardrails } from './src/rewriteTemplate.js';
import { buildListingData } from './src/listingData.js';
import { capStatus } from './src/cap.js';
import { withDefaults, loadProfile, settingsFromProfile } from './src/settings.js';
import { localVinCheck, decodeVinOnline, compareVin, NHTSA_ORIGIN } from './src/vin.js';
import { FORM_MAP } from './facebook/formMap.js';
import { fillFormInPage, attachPhotosInPage, probeFormInPage } from './facebook/fillForm.js';
import { watchForListing } from './facebook/detectPost.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => (typeof n === 'number' && Number.isFinite(n) ? '$' + Math.round(n).toLocaleString('en-US') : '—');
const miles = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') + ' mi' : 'no mileage');
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = {
  origin: null, vin: null, dealerTabId: null, windowId: null,
  settings: null, posted: {}, boilerplate: [], siteName: '',
  vehicle: null, price: null,
  description: '', descriptionSource: 'template', note: '', guardrails: null,
  listing: null,
  fbTabId: null, fill: null, photos: null, detected: null, probe: null,
  vinCheck: null, // { local, online } from src/vin.js
  step: 'idle', message: '', doneAt: null,
  map: FORM_MAP,
};
let watcher = null;

const keys = (origin) => ({
  settings: `settings:${origin}`,
  snapshot: `snapshot:${origin}`,
  posted: `posted:${origin}`,
  boilerplate: `boilerplate:${origin}`,
  flow: `postFlow:${origin}`,
});

// ---------- saved data ----------

async function loadSaved() {
  const k = keys(state.origin);
  const data = await chrome.storage.local.get([k.settings, k.snapshot, k.posted, k.boilerplate]);
  state.siteName = data[k.snapshot]?.site?.name || state.origin;
  const site = { name: state.siteName };
  state.settings = data[k.settings] ? withDefaults(data[k.settings], site) : settingsFromProfile(await loadProfile(), site) || withDefaults({}, site);
  state.posted = data[k.posted] || {};
  state.boilerplate = data[k.boilerplate] || [];
}

const FLOW_FIELDS = ['vin', 'dealerTabId', 'windowId', 'vehicle', 'price', 'description', 'descriptionSource', 'note', 'guardrails', 'listing', 'fbTabId', 'fill', 'photos', 'detected', 'probe', 'vinCheck', 'step', 'message', 'doneAt', 'map'];

async function saveFlow() {
  if (!state.origin) return;
  const flow = {};
  for (const f of FLOW_FIELDS) flow[f] = state[f];
  await chrome.storage.local.set({ [keys(state.origin).flow]: flow, lastPostOrigin: state.origin });
}

async function clearFlow() {
  if (watcher) watcher.cancel();
  watcher = null;
  if (state.origin) await chrome.storage.local.remove(keys(state.origin).flow);
  Object.assign(state, {
    vin: null, vehicle: null, price: null, description: '', descriptionSource: 'template', note: '', guardrails: null,
    listing: null, fbTabId: null, fill: null, photos: null, detected: null, probe: null, vinCheck: null, step: 'idle', message: '', doneAt: null, map: FORM_MAP,
  });
}

function setStatus(text, kind = '') {
  const el = $('status');
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

const ctx = () => ({ vehicle: state.vehicle, dealer: state.settings.dealer, priceNote: state.settings.priceNote, price: state.price });

// ---------- the flow ----------

async function startFlow(req) {
  await chrome.storage.local.remove('postRequest');
  await clearFlow();
  state.origin = req.origin;
  state.vin = String(req.vin || '').toUpperCase();
  state.dealerTabId = req.dealerTabId;
  state.windowId = req.windowId || null;
  await loadSaved();
  state.step = 'checking';
  setStatus('');
  render();

  const fresh = await fetchVehicleDetails(state.dealerTabId, state.vin);
  if (!fresh.ok) return block(fresh.message);
  const check = recheck(fresh.vehicle, state.settings);
  if (!check.ok) return block(check.message);
  state.vehicle = fresh.vehicle;
  state.vinCheck = { local: localVinCheck(fresh.vehicle), online: null };
  state.price = state.settings.basis === 'beforeFees' ? fresh.vehicle.priceBeforeFees : fresh.vehicle.price;
  if (!state.price) return block("The website shows no price for this car right now, so it can't be posted.");

  state.message = 'Writing the description…';
  render();
  await generate();
  state.step = 'review';
  state.message = '';
  render();
  await saveFlow();
}

async function block(message) {
  state.step = 'blocked';
  state.message = message;
  render();
  await saveFlow();
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

async function generate({ useClaude } = {}) {
  const s = state.settings;
  const settings = useClaude === undefined ? s : { ...s, rewrite: { ...s.rewrite, enabled: useClaude } };
  const r = await generateDescription({ vehicle: state.vehicle, dealer: s.dealer, salesperson: s.salesperson, priceNote: s.priceNote, price: state.price, boilerplate: state.boilerplate, settings });
  state.description = r.text;
  state.descriptionSource = r.source;
  state.note = r.note || '';
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
  const cap = capStatus(state.posted, state.settings.dailyCap);
  if (cap.reached) {
    setStatus(`Daily post cap reached (${cap.used} of ${cap.cap} today). It resets tomorrow; the dealer can change it in Settings.`, 'error');
    return;
  }
  const box = $('description');
  if (box) state.description = box.value;
  state.guardrails = runGuardrails(state.description, ctx());
  state.listing = buildListingData(state.vehicle, { dealer: state.settings.dealer, defaults: state.settings.defaults, description: state.description, price: state.price, photos: state.vehicle.photos });
  state.step = 'filling';
  state.message = 'Opening the Marketplace form in a new tab…';
  setStatus('');
  render();
  await saveFlow();
  try {
    const { devOverrides } = await chrome.storage.local.get('devOverrides'); // test hook, see formMap.js
    state.map = { ...FORM_MAP, ...(devOverrides || {}) };
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
    state.probe = (inj && inj.result) || { error: 'no result came back', found: [], missing: [], controls: [] };
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
  state.posted = markPosted(state.posted, state.vehicle, state.settings.basis, now, extra);
  await chrome.storage.local.set({ [keys(state.origin).posted]: state.posted });
  if (watcher) watcher.cancel();
  state.step = 'done';
  state.doneAt = now;
  render();
  await saveFlow();
}

async function notPosted() {
  if (watcher) watcher.cancel();
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
    granted = await chrome.permissions.request({ origins: [NHTSA_ORIGIN + '/*'] });
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
  return `<div class="banner bad">${esc(state.message)}</div><button type="button" class="plain" id="back">Back</button>`;
}

const currentListing = () => state.listing || buildListingData(state.vehicle, { dealer: state.settings.dealer, defaults: state.settings.defaults, description: state.description, price: state.price, photos: state.vehicle.photos });

function fieldsTable() {
  const l = currentListing();
  const labels = Object.fromEntries(state.map.fields.map((f) => [f.key, f.label]));
  const rows = state.map.fields
    .filter((f) => f.key !== 'description')
    .map((f) => {
      const v = l.fields[f.key];
      const src = l.source && l.source[f.key];
      const shown = v ? esc(v === 'car_truck' ? 'Car/Truck' : v === 'motorcycle' ? 'Motorcycle' : v) : `— (website says "${esc(src || 'nothing')}")`;
      return `<tr class="${v ? '' : 'missing'}"><td>${esc(labels[f.key])}</td><td>${shown}</td></tr>`;
    })
    .join('');
  const d = state.settings.dealer || {};
  const locationHint = !/^\d{5}/.test(String(d.zip || ''))
    ? `<p class="hint" id="locationHint">Add the store's ZIP in Settings so Marketplace picks the right town${d.state ? '' : ' (the state helps too)'}: there are several places with the same name.</p>`
    : '';
  return `<table class="fields">${rows}<tr><td>Photos</td><td>${l.photos.length} from the website</td></tr></table>${locationHint}`;
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
  const basis = state.settings.basis === 'beforeFees' ? 'price before fees' : `website's main price${v.priceLabel ? ', "' + esc(v.priceLabel) + '"' : ''}`;
  return `<section class="car" id="vehicle">
    <div class="name">${esc(v.name)}</div>
    <div class="facts">${[v.stock && 'Stock ' + esc(v.stock), miles(v.mileage), v.carfaxOneOwner ? 'Carfax one owner' : v.carfaxUrl ? 'Carfax' : 'No Carfax', esc(v.locationShort || v.location || '')].filter(Boolean).join(' · ')}</div>
    <div class="posting">Posting at <b>${money(state.price)}</b> (${basis})${v.url ? ` · <a href="${esc(v.url)}" target="_blank" rel="noopener">website page</a>` : ''}</div>
  </section>`;
}

function viewReview() {
  const cap = capStatus(state.posted, state.settings.dailyCap);
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
    <div class="cap ${cap.reached ? 'reached' : ''}" id="cap">${cap.used} of ${cap.cap} posts today${cap.reached ? ' · cap reached' : ''}</div>
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
  <div class="banner info">Nothing was filled. This is what Lot Sync can see on the form (map ${esc(p.mapVersion || state.map.version)}).</div>
  ${p.error ? `<div class="banner bad">${esc(p.error)}</div>` : ''}
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
  const f = state.fill || { filled: [], partial: [], blocked: [] };
  const d = state.detected;
  let detect = '';
  if (d && (d.status === 'listing' || d.status === 'probably')) {
    detect = `<div class="banner good" id="detected">Looks like it posted${d.url ? '' : ' (the listing page opened)'}. Confirm below to record it.</div>`;
  } else if (d && d.status === 'closed') {
    detect = `<div class="banner warn" id="detected">The Facebook tab was closed. Did it post?</div>`;
  } else {
    detect = `<div class="banner info">Waiting for you to click <b>Publish</b> on Facebook…</div>`;
  }
  return `${carCard()}
  <div class="banner info">The form is filled in. Check every field, including <b>Vehicle condition</b> and <b>Title status</b> (from your dealership's defaults), then click <b>Publish</b> on Facebook yourself.</div>
  <section id="fillResults">
    <h3>Filled in <span class="pill good">${f.filled.length}</span></h3>
    ${f.filled.length ? `<ul class="list">${f.filled.map((x) => `<li>${esc(x.label)}: ${esc(x.shown || x.value).slice(0, 80)}</li>`).join('')}</ul>` : '<p class="hint">Nothing could be filled.</p>'}
    ${f.partial.length ? `<h3>Needs a click <span class="pill warn">${f.partial.length}</span></h3><ul class="list">${f.partial.map((x) => `<li>${esc(x.label)}: ${esc(x.value)} <span class="why">${esc(x.note || '')}</span></li>`).join('')}</ul>` : ''}
  </section>
  ${f.blocked.length ? `<section class="highlight"><h3>Couldn't fill <span class="pill bad">${f.blocked.length}</span></h3><ul class="list">${f.blocked.map((x) => `<li><b>${esc(x.label)}</b>${x.value ? ': ' + esc(x.value).slice(0, 80) + copyBtn(x.value) : ''} <span class="why">${esc(x.reason)}</span></li>`).join('')}</ul></section>` : ''}
  <section><h3>Photos</h3>${photosHtml()}
    <div class="actions"><button type="button" class="plain" id="downloadPhotos">Download photos</button><button type="button" class="plain" id="fillAgain">Fill again</button><button type="button" class="plain" id="copyDescription">Copy description</button></div>
  </section>
  <section>${detect}
    <label class="block">Listing link (optional) <input type="url" id="listingUrl" value="${esc((d && d.url) || '')}" placeholder="paste the listing's address if you have it" /></label>
    <div class="actions"><button type="button" class="primary" id="confirmPosted">It's posted, record it</button><button type="button" class="plain" id="notPosted">It didn't post</button></div>
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
  const views = { idle: viewIdle, checking: viewChecking, blocked: viewBlocked, review: viewReview, filling: viewFilling, probe: viewProbe, publish: viewPublish, done: viewDone };
  $('panel').innerHTML = (views[state.step] || viewIdle)();
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
  switch (btn.id) {
    case 'openForm': return openForm();
    case 'checkForm': return openForm({ probeOnly: true });
    case 'checkVinOnline': return checkVinOnline();
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
    case 'back':
    case 'postAnother':
      await clearFlow();
      setStatus('');
      return render();
    default:
  }
}

async function init() {
  $('panel').addEventListener('click', onClick);
  $('panel').addEventListener('input', onInput);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.postRequest && changes.postRequest.newValue) startFlow(changes.postRequest.newValue);
  });
  const { postRequest, lastPostOrigin } = await chrome.storage.local.get(['postRequest', 'lastPostOrigin']);
  if (postRequest) return startFlow(postRequest);
  if (lastPostOrigin) {
    const k = keys(lastPostOrigin).flow;
    const flow = (await chrome.storage.local.get(k))[k];
    if (flow && flow.step && flow.step !== 'idle') return resumeFlow(lastPostOrigin, flow);
    state.origin = lastPostOrigin;
    await loadSaved();
  }
  render();
}

init();
