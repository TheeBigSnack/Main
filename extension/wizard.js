// The first-run wizard, shown in the side panel for a website that has no
// settings yet: read the website, choose the store, name and role, sign in
// and join the dealership (only when accounts are configured, and never
// required), the store's address, the price to post, permission for
// automatic rescans, the posting rules, the Terms of Service and Privacy
// Policy, and a first scan with the final settings. Progress is kept in
// storage so the panel can be closed and reopened; the sign-in session is
// not part of it (src/account.js keeps it).

import { performScan, rememberSite } from './src/scanRunner.js';
import { withDefaults, saveProfile, DEFAULT_SALESPERSON_TITLE, priceStepModel, suggestedPriceNote, chooseBasis } from './src/settings.js';
import { originsFor } from './src/rescanSchedule.js';
import { shortLocation, storeNames, matchStore } from './src/normalize.js';
import { POSTING_RULES } from './src/postingRules.js';
import { recordFlags } from './src/pilot.js';
import { LEGAL, acceptLegal, legalHosted } from './src/legalLinks.js';
import { siteKeys } from './src/storageKeys.js';
import { ACCOUNT, accountsConfigured } from './src/accountConfig.js';
import { signInStart, signInFinish, currentSession, rewriteEndpointFor } from './src/accountFlow.js';
import { loadSession, redeemInvite } from './src/account.js';
import { wizardSteps, accountStepModel, joinedFrom, rewriteAtAccount } from './src/wizardSteps.js';

const steps = () => wizardSteps(accountsConfigured());
// The Account step's own state: what was typed and answered, never a token.
const freshAccount = () => ({ email: '', note: '', error: '', joined: null });
const accountFrom = (saved) => {
  const a = saved && typeof saved === 'object' ? saved : {};
  return { email: String(a.email || ''), note: String(a.note || ''), error: '', joined: a.joined && typeof a.joined === 'object' ? a.joined : null };
};

export const wiz = {
  active: false,
  origin: null, dealerTabId: null, windowId: null,
  step: 'welcome',
  scan: null, // { cars, stores, siteName }
  settings: null, // built up as the person goes
  service: null, site: null,
  granted: false, rulesRead: false, termsAccepted: false, busy: false, error: '',
  account: freshAccount(),
};

// The stored session, read where src/account.js keeps it, only to say who is
// signed in; it is never copied into the wizard's saved state.
let accountSession = null;
let accountBusy = false; // an account request is under way; Next and Quit still work
const accountDeps = () => ({ config: ACCOUNT, storage: chrome.storage.local });
async function loadAccount() {
  accountSession = accountsConfigured() ? await loadSession(chrome.storage.local) : null;
}
// A step saved by a copy with accounts that this copy does not have.
const knownStep = (step) => (step === 'account' && !steps().includes(step) ? 'address' : step);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => (typeof n === 'number' && Number.isFinite(n) ? '$' + Math.round(n).toLocaleString('en-US') : '—');
const key = (origin) => siteKeys(origin).wizard; // the wizard's own persisted state
// The Price step's model from the last read (showsLower, gap, example); empty for a read saved before the step existed.
const priceModel = () => (wiz.scan && wiz.scan.price) || { showsLower: false, gap: 0, example: null };
const NOTE_PLACEHOLDER = 'e.g. Tax and tags extra.';
const priceHint = (suggested) => `Honest prices: the listed price always equals the website price. This note explains what it includes.${suggested ? ` Suggested: "${suggested}"` : ''}`;

async function persist() {
  if (!wiz.origin) return;
  const { active, origin, dealerTabId, windowId, step, scan, settings, service, site, granted, rulesRead, termsAccepted } = wiz;
  const account = { email: wiz.account.email, note: wiz.account.note, joined: wiz.account.joined };
  await chrome.storage.local.set({ [key(origin)]: { active, origin, dealerTabId, windowId, step, scan, settings, service, site, granted, rulesRead, termsAccepted, account } });
}

export async function startWizard(req) {
  Object.assign(wiz, { active: true, origin: req.origin, dealerTabId: req.dealerTabId, windowId: req.windowId || null, step: 'welcome', scan: null, settings: null, service: null, site: null, granted: false, rulesRead: false, termsAccepted: false, busy: false, error: '', account: freshAccount() });
  const saved = (await chrome.storage.local.get(key(req.origin)))[key(req.origin)];
  if (saved && saved.active && saved.step !== 'done') Object.assign(wiz, saved, { dealerTabId: req.dealerTabId || saved.dealerTabId, step: knownStep(saved.step), busy: false, error: '', account: accountFrom(saved.account) });
  await loadAccount();
  await persist();
}

export async function resumeWizard(origin) {
  const saved = (await chrome.storage.local.get(key(origin)))[key(origin)];
  if (!saved || !saved.active || saved.step === 'done') return false;
  Object.assign(wiz, saved, { step: knownStep(saved.step), busy: false, error: '', account: accountFrom(saved.account) });
  await loadAccount();
  return true;
}

export async function endWizard() {
  if (wiz.origin) await chrome.storage.local.remove(key(wiz.origin));
  wiz.active = false;
}

// The dealer tab this wizard started from may be gone (closed, or Chrome was
// restarted, which renumbers tabs). Look for a live tab on the site first;
// that only works once the site's host permission is granted, so the popup's
// "Continue set-up" (which sends a fresh tab id) remains the sure route.
async function findDealerTab() {
  try {
    // Without the tabs permission Chrome ignores the url filter for tabs the
    // extension can't read, so only a tab whose address is visible and on the
    // site counts.
    const tabs = (await chrome.tabs.query({ url: wiz.origin + '/*' })).filter((t) => t.id && typeof t.url === 'string' && t.url.startsWith(wiz.origin + '/'));
    const pick = tabs.find((t) => t.id === wiz.dealerTabId) || tabs.find((t) => t.windowId === wiz.windowId) || tabs[0];
    if (pick) wiz.dealerTabId = pick.id;
  } catch (e) { /* no access to tab addresses: keep the stored id */ }
  return wiz.dealerTabId;
}

export const TAB_GONE = "Couldn't reach the dealership tab. Open the used inventory page, click the Lot Sync icon and click Continue set-up.";

// Reads the website with the settings so far (defaults on the first pass) and saves the result.
async function runScan(ctx) {
  wiz.busy = true;
  wiz.error = '';
  ctx.render();
  const k = siteKeys(wiz.origin);
  const data = await chrome.storage.local.get([k.snapshot, k.posted]);
  let r;
  try {
    const tabId = await findDealerTab();
    r = await performScan({ tabId, origin: wiz.origin, settings: wiz.settings, snapshot: data[k.snapshot] || null, posted: data[k.posted] || {} });
  } catch (e) {
    r = { ok: false, message: TAB_GONE + ' (' + ((e && e.message) || e) + ')' };
  }
  wiz.busy = false;
  if (!r.ok) {
    wiz.error = r.message;
    ctx.render();
    return false;
  }
  wiz.settings = r.settings;
  wiz.service = r.service;
  wiz.site = r.site;
  // Like the popup and the background rescan: a scan that lost most of the
  // lot at once is a website hiccup, so the last good snapshot is kept.
  const kept = r.diff.unreliable && data[k.snapshot] ? data[k.snapshot] : r.snapshot;
  const stores = storeNames(r.vehicles);
  // the Price step judges the same entries Settings does, so the two agree on whether a lower second price is offered
  wiz.scan = { cars: r.vehicles.length, stores, siteName: r.site.name, ready: Object.values(kept.vehicles).filter((v) => v.decision === 'ready').length, warnings: r.diff.warnings || [], price: priceStepModel(Object.values(kept.vehicles)) };
  await chrome.storage.local.set({ [k.snapshot]: kept, [k.diff]: r.diff, [k.boilerplate]: r.boilerplate, [k.settings]: r.settings });
  await recordFlags(wiz.origin, r.diff, r.diff.takenAt).catch(() => null); // pilot numbers: when a to-do item first appeared
  chrome.runtime.sendMessage({ type: 'updateBadge' }).catch(() => {});
  await persist();
  ctx.render();
  return true;
}

function stepIndex() {
  return steps().indexOf(wiz.step);
}

function nav(back = true, nextLabel = 'Next', nextId = 'wizNext', nextDisabled = false) {
  return `<div class="actions">${back ? '<button type="button" class="plain" id="wizBack">Back</button>' : ''}<button type="button" class="primary" id="${nextId}" ${nextDisabled ? 'disabled' : ''}>${esc(nextLabel)}</button><button type="button" class="plain" id="wizQuit">Quit set-up</button></div>`;
}

export function wizardHtml() {
  const s = wiz.settings || withDefaults({}, wiz.site || {});
  const progress = `<p class="hint">Set-up · step ${stepIndex() + 1} of ${steps().length}${wiz.scan ? ` · ${esc(wiz.scan.siteName)}` : ''}</p>`;
  const error = wiz.error ? `<div class="banner bad">${esc(wiz.error)}</div>` : '';
  switch (wiz.step) {
    case 'welcome':
      return `${progress}<h3>Set up Lot Sync for this dealership</h3>
        <p>In a few steps: read the website, pick your store, your name,${accountsConfigured() ? " your dealership's account (optional)," : ''} the store's address, the price to post, permission for automatic rescans, the posting rules, and the Terms of Service and Privacy Policy. About two minutes.</p>
        <p class="hint">Keep the dealership's used inventory page open in this window while you do this.</p>
        ${nav(false, 'Start')}`;
    case 'scan':
      return `${progress}<h3>Reading the website</h3>${error}
        ${wiz.busy ? '<p>Reading the used inventory…</p>' : wiz.scan ? `<div class="banner good">${wiz.scan.cars} used cars read from ${esc(wiz.scan.siteName)}. ${wiz.scan.stores.length} store${wiz.scan.stores.length === 1 ? '' : 's'} found.</div>${(wiz.scan.warnings || []).map((w) => `<div class="banner warn">${esc(w)}</div>`).join('')}` : '<p>Click Read to scan the used inventory.</p>'}
        ${wiz.scan ? nav(true, 'Next') : `<div class="actions"><button type="button" class="plain" id="wizBack">Back</button><button type="button" class="primary" id="wizScan" ${wiz.busy ? 'disabled' : ''}>Read the website</button><button type="button" class="plain" id="wizQuit">Quit set-up</button></div>`}`;
    case 'store': {
      const stores = (wiz.scan && wiz.scan.stores) || [];
      // The same match the read used for the default tick (performScan,
      // normalize.js matchStore): one store at most, and when nothing stands
      // out none is ticked and the hint says so, so a person picks.
      const matched = stores.length ? matchStore(wiz.site, stores) : null;
      const hint = !stores.length ? '' : matched ? `The website lists these stores; ${esc(matched)} matches the website's own name, so it was ticked for you.` : "The website lists these stores. None of them matches the website's own name, so none is ticked: tick yours.";
      return `${progress}<h3>Your store</h3>
        <p class="hint">Only cars at your store count as ready to post.${hint ? ' ' + hint : ''}</p>
        ${stores.length ? stores.map((st) => `<label class="block"><input type="checkbox" class="wizStore" value="${esc(st)}" ${s.myStores.includes(st) ? 'checked' : ''} /> ${esc(st)} <span class="why">${esc(shortLocation(st, stores))}</span></label>`).join('') : '<p class="hint">The website does not name stores; every car will count.</p>'}
        ${nav()}`;
    }
    case 'you':
      return `${progress}<h3>You</h3>
        <label class="block">Your name <input type="text" id="wizName" value="${esc(s.salesperson.name)}" placeholder="Your first name" /></label>
        <label class="block">Your role <input type="text" id="wizTitle" value="${esc(s.salesperson.title)}" /></label>
        <p class="hint">Every description ends with "I'm [name], [role] at [dealership]". Posing as a private seller isn't allowed.</p>
        ${nav()}`;
    case 'account': {
      // Settings' Account section in the wizard; Next ("Skip for now" until
      // signed in) always goes on, and the account buttons wait while one works.
      const a = wiz.account;
      const m = accountStepModel({ configured: accountsConfigured(), session: accountSession, joined: a.joined, email: a.email, note: a.note, error: a.error, origin: wiz.origin });
      const off = accountBusy ? 'disabled' : '';
      const note = m.note ? `<p class="hint" id="wizAccountNote">${esc(m.note)}</p>` : '';
      const failed = m.error ? `<div class="banner bad" id="wizAccountError" role="alert">${esc(m.error)}</div>` : '';
      const body = m.signIn
        ? `<p class="hint">${esc(m.intro)}</p>
        <label class="block">${esc(m.signIn.emailLabel)} <input type="text" id="wizEmail" value="${esc(m.signIn.email)}" inputmode="email" autocomplete="email" placeholder="you@example.com" /></label>
        <div class="actions"><button type="button" class="plain" id="wizSendCode" ${off}>${esc(m.signIn.sendCode)}</button></div>
        ${note}
        <label class="block">${esc(m.signIn.codeLabel)} <input type="text" id="wizCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6 digits" /></label>
        <div class="actions"><button type="button" class="plain" id="wizSignIn" ${off}>${esc(m.signIn.signIn)}</button></div>`
        : `<div class="banner good" id="wizSignedIn">${esc(m.status)}</div>
        ${m.joined ? `<div class="banner good" id="wizJoined">${esc(m.joined)}</div>` : ''}
        ${m.invite ? `<p class="hint"><b>${esc(m.invite.heading)}</b> ${esc(m.invite.hint)}</p>
        <label class="block">${esc(m.invite.label)} <input type="text" id="wizInvite" autocomplete="off" /></label>
        <div class="actions"><button type="button" class="plain" id="wizJoin" ${off}>${esc(m.invite.join)}</button></div>` : ''}`;
      return `${progress}<h3>${esc(m.heading)}</h3>
        <div class="wizAccount">${body}</div>
        ${failed}
        ${m.later ? `<p class="hint">${esc(m.later)}</p>` : ''}
        ${nav(true, m.next)}`;
    }
    case 'address':
      return `${progress}<h3>The store's address</h3>
        <p class="hint">Read from the website${wiz.site && wiz.site.address && wiz.site.address.source ? ` (${esc(wiz.site.address.source)})` : ''}. Marketplace asks for a location; the ZIP is what gets typed.</p>
        <label class="block">Dealership name <input type="text" id="wizDealer" value="${esc(s.dealer.name)}" /></label>
        <label class="block">City <input type="text" id="wizCity" value="${esc(s.dealer.city)}" /></label>
        <label class="block">State <input type="text" id="wizState" value="${esc(s.dealer.state)}" maxlength="2" placeholder="e.g. OH" /></label>
        <label class="block">ZIP <input type="text" id="wizZip" value="${esc(s.dealer.zip)}" placeholder="e.g. 43215" inputmode="numeric" /></label>
        ${nav()}`;
    case 'price': {
      // The same choice and wording as Settings' "Price to post". The note is
      // never filled in: the gap only suggests wording, and a person decides
      // whether it is true for this store.
      const pm = priceModel();
      const ex = pm.example;
      const suggested = suggestedPriceNote(pm.gap, s.basis);
      const choice = pm.showsLower
        ? `<label class="block"><input type="radio" name="wizBasis" value="website" ${s.basis !== 'beforeFees' ? 'checked' : ''} /> The website's main price${ex ? ` (e.g. ${money(ex.price)} "${esc(ex.priceLabel)}")` : ''}</label>
        <label class="block"><input type="radio" name="wizBasis" value="beforeFees" ${s.basis === 'beforeFees' ? 'checked' : ''} /> The lower second price the website shows${ex ? ` (e.g. ${money(ex.priceBeforeFees)}; usually the price before the doc fee)` : ''}</label>
        <p class="hint">Some states require the advertised price to include dealer fees. Check with your manager before choosing this. A car with no lower second price is posted at the main price, without the price note.</p>`
        : `<p>Cars are posted at the website's main price; this website shows no lower second price to choose instead.</p>`;
      const gapNote = ex ? `<p class="hint">On this website the main price is usually ${money(pm.gap)} higher than the lower second price it shows (often the doc fee, but only your store can say). Posting the website's main price keeps Marketplace and the website matching.</p>` : '';
      return `${progress}<h3>The price to post</h3>
        ${choice}
        ${gapNote}
        <label class="block">Price note in every description <input type="text" id="wizPriceNote" value="${esc(s.priceNote)}" placeholder="${esc(suggested || NOTE_PLACEHOLDER)}" /></label>
        <p class="hint" id="wizPriceHint">${esc(priceHint(suggested))}</p>
        ${nav()}`;
    }
    case 'permission': {
      const origins = originsFor(wiz.site, wiz.service);
      return `${progress}<h3>Automatic rescans</h3>
        <p>Every 3 hours while Chrome is open, Lot Sync can re-read the website and put your to-do count on its toolbar icon: sold cars to take down, prices to update. For that it needs permission to read ${origins.map((o) => `<b>${esc(o.replace(/\/\*$/, ''))}</b>`).join(' and ')} in the background. Chrome will ask.</p>
        ${wiz.granted ? '<div class="banner good">Permission granted. Automatic rescans are on.</div>' : `<div class="actions"><button type="button" class="primary" id="wizGrant">Allow automatic rescans</button></div><p class="hint">Or skip: the Scan button in the popup still works by hand.</p>`}
        <label class="block"><input type="checkbox" id="wizNotify" ${s.notify !== false ? 'checked' : ''} /> Show a desktop notification when listings need attention</label>
        ${nav(true, wiz.granted ? 'Next' : 'Skip for now')}`;
    }
    case 'rules':
      return `${progress}<h3>The posting rules</h3>
        <ol class="rules">${POSTING_RULES.map((r) => `<li><b>${esc(r.title)}</b> ${esc(r.text)}</li>`).join('')}</ol>
        <label class="block"><input type="checkbox" id="wizRulesRead" ${wiz.rulesRead ? 'checked' : ''} /> I have read the posting rules and will follow them</label>
        ${nav(true, 'Next', 'wizNext', !wiz.rulesRead)}`;
    case 'terms': {
      const summary = `<p>In short: Lot Sync reads your dealership's website and the Marketplace form you open, keeps its data in your browser, records the usage numbers for the pilot (how long each post took, which fields it couldn't fill, how long sold cars and price changes stayed listed), and never your Facebook login. You publish every post yourself. Lot Sync is not affiliated with Meta Platforms, Inc.</p>`;
      if (!legalHosted()) {
        // The documents are not published yet: nobody is asked to accept what they cannot read.
        return `${progress}<h3>Terms and privacy</h3>
        ${summary}
        <p class="hint" id="legalPending">The Terms of Service and the Privacy Policy are being finalised. Once they are published you can read and accept them in Settings (Terms and privacy); nothing is recorded until then.</p>
        ${nav(true, wiz.busy ? 'Finishing…' : 'Finish set-up', 'wizFinish', wiz.busy)}${error}`;
      }
      return `${progress}<h3>Terms and privacy</h3>
        <p>Two documents to read before you post: the <a href="${esc(LEGAL.termsUrl)}" target="_blank" rel="noopener">Terms of Service</a> and the <a href="${esc(LEGAL.privacyUrl)}" target="_blank" rel="noopener">Privacy Policy</a>.</p>
        ${summary}
        <label class="block"><input type="checkbox" id="wizTermsRead" ${wiz.termsAccepted ? 'checked' : ''} /> I have read and accept the Terms of Service and the Privacy Policy</label>
        ${nav(true, wiz.busy ? 'Finishing…' : 'Finish set-up', 'wizFinish', !wiz.termsAccepted || wiz.busy)}${error}`;
    }
    case 'done':
      return `${progress}<div class="banner good"><b>Set up.</b> ${wiz.scan ? `${wiz.scan.ready} car${wiz.scan.ready === 1 ? ' is' : 's are'} ready to post.` : ''} Click the Lot Sync icon and open <b>Ready to post</b>.${wiz.granted ? ' Automatic rescans are on; the icon shows your to-do count.' : ''}</div>
        <div class="actions"><button type="button" class="primary" id="wizClose">Close</button></div>`;
    default:
      return '';
  }
}

function readInputs() {
  // Before the first read there are no settings yet: the read computes the
  // defaults (store from the site name, address from the page), so don't
  // invent an empty settings object here.
  if (!wiz.settings && !['store', 'you', 'account', 'address', 'price', 'permission', 'rules', 'terms'].includes(wiz.step)) return;
  const s = wiz.settings || withDefaults({}, wiz.site || {});
  const val = (id) => { const el = document.getElementById(id); return el ? String(el.value || '').trim() : undefined; };
  if (wiz.step === 'account') {
    wiz.account.email = val('wizEmail') ?? wiz.account.email; // the typed address survives Back and Next
    wiz.account.error = ''; // a failed try is not news on the way back
  }
  const next = { ...s };
  if (wiz.step === 'store') next.myStores = [...document.querySelectorAll('.wizStore:checked')].map((b) => b.value);
  if (wiz.step === 'you') next.salesperson = { name: val('wizName') ?? s.salesperson.name, title: val('wizTitle') || s.salesperson.title || DEFAULT_SALESPERSON_TITLE };
  if (wiz.step === 'address') next.dealer = { name: val('wizDealer') || s.dealer.name, city: val('wizCity') ?? s.dealer.city, state: (val('wizState') ?? s.dealer.state).toUpperCase(), zip: val('wizZip') ?? s.dealer.zip };
  if (wiz.step === 'price') {
    const picked = document.querySelector('input[name="wizBasis"]:checked');
    next.basis = chooseBasis(picked ? picked.value : s.basis, s.basis, wiz.scan ? priceModel() : null); // never a basis this website cannot support
    next.priceNote = val('wizPriceNote') ?? s.priceNote;
  }
  if (wiz.step === 'permission') { const n = document.getElementById('wizNotify'); if (n) next.notify = n.checked; }
  if (wiz.step === 'rules') { const r = document.getElementById('wizRulesRead'); if (r) wiz.rulesRead = r.checked; }
  if (wiz.step === 'terms') { const t = document.getElementById('wizTermsRead'); if (t) wiz.termsAccepted = t.checked; }
  wiz.settings = withDefaults(next, wiz.site || {});
}

async function finish(ctx) {
  readInputs();
  wiz.busy = true;
  ctx.render();
  const now = new Date().toISOString();
  const settings = withDefaults({ ...wiz.settings, autoRescan: wiz.granted, rulesReadAt: now, legal: legalHosted() && wiz.termsAccepted ? acceptLegal(now) : (wiz.settings && wiz.settings.legal) || undefined }, wiz.site || {});
  wiz.settings = settings;
  const k = siteKeys(wiz.origin);
  await chrome.storage.local.set({ [k.settings]: settings });
  await saveProfile(settings, undefined, wiz.origin);
  // the site registry must agree with the settings even if the final read below fails
  await rememberSite(wiz.origin, { auto: Boolean(settings.autoRescan) });
  // one more read with the final settings, so Ready to post is right from the start
  const ok = await runScan(ctx);
  wiz.busy = false;
  if (!ok) { ctx.render(); return; }
  await chrome.storage.local.set({ [k.wizardDone]: new Date().toISOString() });
  chrome.runtime.sendMessage({ type: 'ensureAlarm' }).catch(() => {});
  // signed in: the worker runs the first sync with the final read (fire and forget; Settings shows how it went)
  if (accountsConfigured() && (await loadSession(chrome.storage.local))) chrome.runtime.sendMessage({ type: 'syncNow', origin: wiz.origin }).catch(() => {});
  wiz.step = 'done';
  await persist();
  ctx.render();
}

// On sign-in the rewrite address becomes the account's function in the
// settings being built; finish() saves them (Settings does the same at once).
function pointRewriteAtAccount() {
  const s = wiz.settings || withDefaults({}, wiz.site || {});
  const rewrite = rewriteAtAccount(s.rewrite, rewriteEndpointFor(ACCOUNT));
  if (rewrite !== s.rewrite) wiz.settings = withDefaults({ ...s, rewrite }, wiz.site || {});
}

// The Account step's three buttons, with the functions and messages
// Settings uses (popup.js accountAction). A failure is shown in the
// server's words and the step stays open for another try or Skip for now.
async function accountAction(id, ctx) {
  if (!accountsConfigured() || accountBusy) return;
  const a = wiz.account;
  const val = (elId) => { const el = document.getElementById(elId); return el ? String(el.value || '').trim() : ''; };
  const email = val('wizEmail') || a.email;
  const code = val(id === 'wizJoin' ? 'wizInvite' : 'wizCode');
  a.email = email;
  a.error = '';
  accountBusy = true;
  ctx.render();
  try {
    if (id === 'wizSendCode') {
      a.note = '';
      ctx.setStatus('Sending the code…');
      const r = await signInStart(email, accountDeps());
      ctx.setStatus('');
      if (r.ok) {
        a.email = r.email;
        a.note = r.message;
      } else a.error = r.error;
    } else if (id === 'wizSignIn') {
      ctx.setStatus('Signing in…');
      const r = await signInFinish(email, code, accountDeps());
      if (!r.ok) {
        ctx.setStatus('');
        a.error = r.error;
      } else {
        accountSession = r.session;
        a.note = '';
        a.joined = null; // a membership answered to an earlier sign-in is not this one's
        ctx.setStatus(`Signed in as ${(r.session.user && r.session.user.email) || email}.`);
        pointRewriteAtAccount();
      }
    } else if (id === 'wizJoin') {
      const s = await currentSession(accountDeps());
      if (!s.ok) {
        if (s.signedOut) accountSession = null;
        a.error = s.error;
      } else {
        accountSession = s.session;
        ctx.setStatus('Joining…');
        let r;
        try {
          r = await redeemInvite(code, (wiz.settings && wiz.settings.salesperson && wiz.settings.salesperson.name) || '', { url: ACCOUNT.url, anonKey: ACCOUNT.anonKey, session: s.session });
        } catch (e) {
          r = { ok: false, error: `couldn't reach the account server (${(e && e.message) || e})` };
        }
        ctx.setStatus('');
        if (!r.ok) {
          if (r.signedOut) accountSession = null;
          a.error = r.error;
        } else a.joined = joinedFrom(r.membership);
      }
    }
  } finally {
    accountBusy = false;
  }
  if (!wiz.active) return; // set-up was quit while the request was out
  await persist();
  if (wiz.step === 'account') ctx.render(); // the person may have moved on meanwhile: never redraw over another step's typing
}

// Returns true when the click was the wizard's.
export async function handleWizardClick(id, ctx) {
  if (!wiz.active) return false;
  switch (id) {
    case 'wizNext': {
      readInputs();
      const list = steps();
      wiz.step = list[Math.min(stepIndex() + 1, list.length - 1)];
      if (wiz.step === 'account') await loadAccount(); // signed in or out in Settings since
      await persist();
      ctx.render();
      if (wiz.step === 'scan' && !wiz.scan) await runScan(ctx);
      return true;
    }
    case 'wizBack':
      readInputs();
      wiz.step = steps()[Math.max(stepIndex() - 1, 0)];
      if (wiz.step === 'account') await loadAccount();
      await persist();
      ctx.render();
      return true;
    case 'wizSendCode':
    case 'wizSignIn':
    case 'wizJoin':
      await accountAction(id, ctx);
      return true;
    case 'wizScan':
      await runScan(ctx);
      return true;
    case 'wizGrant': {
      readInputs(); // keep the notification tick as the person left it across the re-render
      const origins = originsFor(wiz.site, wiz.service);
      try {
        wiz.granted = await chrome.permissions.request({ origins }); // straight from the click
      } catch (e) {
        wiz.error = "Couldn't ask Chrome for permission: " + ((e && e.message) || e);
      }
      await persist();
      ctx.render();
      return true;
    }
    case 'wizFinish':
      await finish(ctx);
      return true;
    case 'wizQuit':
    case 'wizClose':
      await endWizard();
      ctx.setStatus(id === 'wizQuit' ? 'Set-up stopped. The popup offers Set up Lot Sync again until it is finished; Settings has the same fields.' : '');
      ctx.onClose();
      return true;
    default:
      return false;
  }
}

export function handleWizardChange(target) {
  if (!wiz.active) return;
  if (target.id === 'wizRulesRead') {
    wiz.rulesRead = target.checked;
    const btn = document.getElementById('wizNext');
    if (btn) btn.disabled = !wiz.rulesRead;
  }
  if (target.id === 'wizTermsRead') {
    wiz.termsAccepted = target.checked;
    const btn = document.getElementById('wizFinish');
    if (btn) btn.disabled = !wiz.termsAccepted;
  }
  if (target.id === 'wizNotify' && wiz.settings) wiz.settings = { ...wiz.settings, notify: target.checked };
  if (target.name === 'wizBasis' && wiz.settings) {
    wiz.settings = { ...wiz.settings, basis: chooseBasis(target.value, wiz.settings.basis, wiz.scan ? priceModel() : null) };
    // the suggested wording follows the basis; the typed note stays as it is
    const suggested = suggestedPriceNote(priceModel().gap, wiz.settings.basis);
    const note = document.getElementById('wizPriceNote');
    if (note) note.placeholder = suggested || NOTE_PLACEHOLDER;
    const hint = document.getElementById('wizPriceHint');
    if (hint) hint.textContent = priceHint(suggested);
  }
  if (target.id === 'wizPriceNote' && wiz.settings) wiz.settings = { ...wiz.settings, priceNote: String(target.value || '').trim() };
}
