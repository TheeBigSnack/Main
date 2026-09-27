// The first-run wizard, shown in the side panel for a website that has no
// settings yet: read the website, choose the store, name and role, the
// store's address, permission for automatic rescans, the posting rules, and
// a first scan with the final settings. Progress is kept in storage so the
// panel can be closed and reopened.

import { performScan } from './src/scanRunner.js';
import { withDefaults, saveProfile } from './src/settings.js';
import { originsFor } from './src/rescanSchedule.js';
import { shortLocation } from './src/normalize.js';
import { POSTING_RULES } from './src/postingRules.js';

const STEPS = ['welcome', 'scan', 'store', 'you', 'address', 'permission', 'rules', 'done'];

export const wiz = {
  active: false,
  origin: null, dealerTabId: null, windowId: null,
  step: 'welcome',
  scan: null, // { cars, stores, siteName }
  settings: null, // built up as the person goes
  service: null, site: null,
  granted: false, rulesRead: false, busy: false, error: '',
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const key = (origin) => `wizard:${origin}`;

async function persist() {
  if (!wiz.origin) return;
  const { active, origin, dealerTabId, windowId, step, scan, settings, service, site, granted, rulesRead } = wiz;
  await chrome.storage.local.set({ [key(origin)]: { active, origin, dealerTabId, windowId, step, scan, settings, service, site, granted, rulesRead } });
}

export async function startWizard(req) {
  Object.assign(wiz, { active: true, origin: req.origin, dealerTabId: req.dealerTabId, windowId: req.windowId || null, step: 'welcome', scan: null, settings: null, service: null, site: null, granted: false, rulesRead: false, busy: false, error: '' });
  const saved = (await chrome.storage.local.get(key(req.origin)))[key(req.origin)];
  if (saved && saved.active && saved.step !== 'done') Object.assign(wiz, saved, { dealerTabId: req.dealerTabId || saved.dealerTabId, busy: false, error: '' });
  await persist();
}

export async function resumeWizard(origin) {
  const saved = (await chrome.storage.local.get(key(origin)))[key(origin)];
  if (!saved || !saved.active || saved.step === 'done') return false;
  Object.assign(wiz, saved, { busy: false, error: '' });
  return true;
}

export async function endWizard() {
  if (wiz.origin) await chrome.storage.local.remove(key(wiz.origin));
  wiz.active = false;
}

// Reads the website with the settings so far (defaults on the first pass) and saves the result.
async function runScan(ctx) {
  wiz.busy = true;
  wiz.error = '';
  ctx.render();
  const k = (name) => `${name}:${wiz.origin}`;
  const data = await chrome.storage.local.get([k('snapshot'), k('posted')]);
  let r;
  try {
    r = await performScan({ tabId: wiz.dealerTabId, origin: wiz.origin, settings: wiz.settings, snapshot: data[k('snapshot')] || null, posted: data[k('posted')] || {} });
  } catch (e) {
    r = { ok: false, message: "Couldn't reach the dealership tab. Keep the used inventory page open in this window, then try again. (" + ((e && e.message) || e) + ')' };
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
  const stores = [...new Set(r.vehicles.map((v) => v.location).filter(Boolean))].sort();
  wiz.scan = { cars: r.vehicles.length, stores, siteName: r.site.name, ready: Object.values(r.snapshot.vehicles).filter((v) => v.decision === 'ready').length };
  await chrome.storage.local.set({ [k('snapshot')]: r.snapshot, [k('diff')]: r.diff, [k('boilerplate')]: r.boilerplate, [k('settings')]: r.settings });
  chrome.runtime.sendMessage({ type: 'updateBadge' }).catch(() => {});
  await persist();
  ctx.render();
  return true;
}

function stepIndex() {
  return STEPS.indexOf(wiz.step);
}

function nav(back = true, nextLabel = 'Next', nextId = 'wizNext', nextDisabled = false) {
  return `<div class="actions">${back ? '<button type="button" class="plain" id="wizBack">Back</button>' : ''}<button type="button" class="primary" id="${nextId}" ${nextDisabled ? 'disabled' : ''}>${esc(nextLabel)}</button><button type="button" class="plain" id="wizQuit">Quit set-up</button></div>`;
}

export function wizardHtml() {
  const s = wiz.settings || withDefaults({}, wiz.site || {});
  const progress = `<p class="hint">Set-up · step ${stepIndex() + 1} of ${STEPS.length}${wiz.scan ? ` · ${esc(wiz.scan.siteName)}` : ''}</p>`;
  const error = wiz.error ? `<div class="banner bad">${esc(wiz.error)}</div>` : '';
  switch (wiz.step) {
    case 'welcome':
      return `${progress}<h3>Set up Lot Sync for this dealership</h3>
        <p>In a few steps: read the website, pick your store, your name, the store's address, permission for automatic rescans, and the posting rules. About two minutes.</p>
        <p class="hint">Keep the dealership's used inventory page open in this window while you do this.</p>
        ${nav(false, 'Start')}`;
    case 'scan':
      return `${progress}<h3>Reading the website</h3>${error}
        ${wiz.busy ? '<p>Reading the used inventory…</p>' : wiz.scan ? `<div class="banner good">${wiz.scan.cars} used cars read from ${esc(wiz.scan.siteName)}. ${wiz.scan.stores.length} store${wiz.scan.stores.length === 1 ? '' : 's'} found.</div>` : '<p>Click Read to scan the used inventory.</p>'}
        ${wiz.scan ? nav(true, 'Next') : `<div class="actions"><button type="button" class="plain" id="wizBack">Back</button><button type="button" class="primary" id="wizScan" ${wiz.busy ? 'disabled' : ''}>Read the website</button><button type="button" class="plain" id="wizQuit">Quit set-up</button></div>`}`;
    case 'store': {
      const stores = (wiz.scan && wiz.scan.stores) || [];
      return `${progress}<h3>Your store</h3>
        <p class="hint">Only cars at your store count as ready to post. The website lists these stores.</p>
        ${stores.length ? stores.map((st) => `<label class="block"><input type="checkbox" class="wizStore" value="${esc(st)}" ${s.myStores.includes(st) ? 'checked' : ''} /> ${esc(st)} <span class="why">${esc(shortLocation(st))}</span></label>`).join('') : '<p class="hint">The website does not name stores; every car will count.</p>'}
        ${nav()}`;
    }
    case 'you':
      return `${progress}<h3>You</h3>
        <label class="block">Your name <input type="text" id="wizName" value="${esc(s.salesperson.name)}" placeholder="e.g. Roger" /></label>
        <label class="block">Your role <input type="text" id="wizTitle" value="${esc(s.salesperson.title)}" /></label>
        <p class="hint">Every description ends with "I'm [name], [role] at [dealership]". Posing as a private seller isn't allowed.</p>
        ${nav()}`;
    case 'address':
      return `${progress}<h3>The store's address</h3>
        <p class="hint">Read from the website${wiz.site && wiz.site.address && wiz.site.address.source ? ` (${esc(wiz.site.address.source)})` : ''}. Marketplace asks for a location; the ZIP is what gets typed.</p>
        <label class="block">Dealership name <input type="text" id="wizDealer" value="${esc(s.dealer.name)}" /></label>
        <label class="block">City <input type="text" id="wizCity" value="${esc(s.dealer.city)}" /></label>
        <label class="block">State <input type="text" id="wizState" value="${esc(s.dealer.state)}" maxlength="2" placeholder="PA" /></label>
        <label class="block">ZIP <input type="text" id="wizZip" value="${esc(s.dealer.zip)}" placeholder="15370" inputmode="numeric" /></label>
        ${nav()}`;
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
        ${nav(true, wiz.busy ? 'Finishing…' : 'Finish set-up', 'wizFinish', !wiz.rulesRead || wiz.busy)}${error}`;
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
  if (!wiz.settings && !['store', 'you', 'address', 'permission', 'rules'].includes(wiz.step)) return;
  const s = wiz.settings || withDefaults({}, wiz.site || {});
  const val = (id) => { const el = document.getElementById(id); return el ? String(el.value || '').trim() : undefined; };
  const next = { ...s };
  if (wiz.step === 'store') next.myStores = [...document.querySelectorAll('.wizStore:checked')].map((b) => b.value);
  if (wiz.step === 'you') next.salesperson = { name: val('wizName') ?? s.salesperson.name, title: val('wizTitle') || s.salesperson.title || 'sales consultant' };
  if (wiz.step === 'address') next.dealer = { name: val('wizDealer') || s.dealer.name, city: val('wizCity') ?? s.dealer.city, state: (val('wizState') ?? s.dealer.state).toUpperCase(), zip: val('wizZip') ?? s.dealer.zip };
  if (wiz.step === 'permission') { const n = document.getElementById('wizNotify'); if (n) next.notify = n.checked; }
  if (wiz.step === 'rules') { const r = document.getElementById('wizRulesRead'); if (r) wiz.rulesRead = r.checked; }
  wiz.settings = withDefaults(next, wiz.site || {});
}

async function finish(ctx) {
  readInputs();
  wiz.busy = true;
  ctx.render();
  const settings = withDefaults({ ...wiz.settings, autoRescan: wiz.granted, rulesReadAt: new Date().toISOString() }, wiz.site || {});
  wiz.settings = settings;
  const k = (name) => `${name}:${wiz.origin}`;
  await chrome.storage.local.set({ [k('settings')]: settings, [`wizardDone:${wiz.origin}`]: new Date().toISOString() });
  await saveProfile(settings);
  // one more read with the final settings, so Ready to post is right from the start
  const ok = await runScan(ctx);
  wiz.busy = false;
  if (!ok) { ctx.render(); return; }
  chrome.runtime.sendMessage({ type: 'ensureAlarm' }).catch(() => {});
  wiz.step = 'done';
  await persist();
  ctx.render();
}

// Returns true when the click was the wizard's.
export async function handleWizardClick(id, ctx) {
  if (!wiz.active) return false;
  switch (id) {
    case 'wizNext': {
      readInputs();
      const i = stepIndex();
      wiz.step = STEPS[Math.min(i + 1, STEPS.length - 1)];
      await persist();
      ctx.render();
      if (wiz.step === 'scan' && !wiz.scan) await runScan(ctx);
      return true;
    }
    case 'wizBack':
      readInputs();
      wiz.step = STEPS[Math.max(stepIndex() - 1, 0)];
      await persist();
      ctx.render();
      return true;
    case 'wizScan':
      await runScan(ctx);
      return true;
    case 'wizGrant': {
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
      ctx.setStatus(id === 'wizQuit' ? 'Set-up stopped. You can run it again from the popup.' : '');
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
    const btn = document.getElementById('wizFinish');
    if (btn) btn.disabled = !wiz.rulesRead;
  }
}
