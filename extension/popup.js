import { normalizeVehicle } from './src/normalize.js';
import { assessVehicle, DECISION } from './src/classify.js';
import { makeSnapshot, diffScans, markPosted, markPriceUpdated, markTakenDown, basisPrice } from './src/rescan.js';
import { scanInventoryInPage } from './src/scan.js';
import { findBoilerplate } from './src/description.js';
import { defaultSettings, withDefaults, feeGap, suggestedPriceNote } from './src/settings.js';
import { capStatus, DEFAULT_DAILY_CAP } from './src/cap.js';

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => (typeof n === 'number' && Number.isFinite(n) ? '$' + Math.round(n).toLocaleString('en-US') : '—');
const signedMoney = (n) => (n < 0 ? '−' : '+') + money(Math.abs(n));
const miles = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') + ' mi' : 'no mileage');
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

const state = {
  tab: null,
  origin: null, // the dealer website this popup is working on
  siteName: '',
  snapshot: null, // last saved scan
  diff: null, // to-do list from the last scan
  posted: {}, // cars this salesperson marked as posted: { vin: { name, price, postedAt, listingUrl?, salesperson? } }
  settings: null, // see src/settings.js
  boilerplate: [], // description text that repeats across the lot (disclaimers), stripped by the description writer
  view: 'todo',
};

// ---------- saved data (kept per website, in this browser only) ----------

const storageKeys = (origin) => ({
  snapshot: `snapshot:${origin}`,
  diff: `diff:${origin}`,
  posted: `posted:${origin}`,
  settings: `settings:${origin}`,
  boilerplate: `boilerplate:${origin}`,
});

async function loadSaved() {
  const k = storageKeys(state.origin);
  const data = await chrome.storage.local.get(Object.values(k));
  state.snapshot = data[k.snapshot] || null;
  state.diff = data[k.diff] || null;
  state.posted = data[k.posted] || {};
  state.settings = data[k.settings] ? withDefaults(data[k.settings], { name: state.snapshot?.site?.name }) : null;
  state.boilerplate = data[k.boilerplate] || [];
}

async function save(...names) {
  const k = storageKeys(state.origin);
  const out = {};
  for (const name of names) out[k[name]] = state[name];
  await chrome.storage.local.set(out);
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
  if (!state.tab || !state.origin) {
    setStatus("Open your dealership's website in this tab first, then click Scan.", 'error');
    return;
  }
  const button = $('scan');
  button.disabled = true;
  setStatus("Reading the website's used inventory…");
  try {
    const confirmVins = [...new Set([...Object.keys(state.snapshot?.vehicles || {}), ...Object.keys(state.posted)])];
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: state.tab.id },
      world: 'MAIN',
      func: scanInventoryInPage,
      args: [{ confirmVins }],
    });
    const res = injection && injection.result;
    if (!res || !res.ok) {
      setStatus((res && res.message) || "Couldn't read this page.", 'error');
      return;
    }
    const vehicles = res.records.map(normalizeVehicle).filter(Boolean);
    state.settings = state.settings ? withDefaults(state.settings, res.site) : defaultSettings(res.site, vehicles);
    // Text that repeats across the lot (disclaimers, legal lines) is remembered so the description writer can strip it.
    state.boilerplate = [...findBoilerplate(vehicles.map((v) => v.descriptionRaw))];
    const assessments = vehicles.map((v) => assessVehicle(v, state.settings));
    const curr = makeSnapshot({ site: res.site, takenAt: res.fetchedAt, complete: res.complete, vehicles, assessments });
    const diff = diffScans(state.snapshot, curr, { posted: state.posted, confirm: res.confirm, basis: state.settings.basis });
    if (!res.complete) {
      diff.warnings.unshift(`The website returned ${res.records.length} of ${res.total} cars. Missing cars were double-checked one by one.`);
    }
    diff.takenAt = res.fetchedAt;
    diff.requests = res.requests;
    state.diff = diff;
    if (!diff.unreliable) state.snapshot = curr; // keep the last good scan if this one looks broken
    state.siteName = res.site.name;
    await save('snapshot', 'diff', 'settings', 'boilerplate');
    state.view = 'todo';
    setStatus('');
    render();
  } catch (e) {
    setStatus(friendlyError(e), 'error');
  } finally {
    button.disabled = false;
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

function todoCount() {
  const d = state.diff;
  if (!d) return 0;
  const yours = (x) => x.yours;
  return (d.takeDown || []).filter(yours).length + (d.priceUpdates || []).filter(yours).length + (d.needsALook || []).filter(yours).length;
}

const VIEWS = [
  ['todo', 'To do'],
  ['ready', 'Ready to post'],
  ['notReady', 'Not ready'],
  ['otherStores', 'Other stores'],
  ['review', 'Needs a look'],
  ['mine', 'My listings'],
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

function row(e, { sub = '', right = '', action = '', muted = false } = {}) {
  const name = /^https?:\/\//i.test(e.url || '')
    ? `<a class="name" href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.name)}</a>`
    : `<span class="name">${esc(e.name)}</span>`;
  return `<li class="row${muted ? ' muted' : ''}"><div class="main">${name}<div class="sub">${sub}</div></div>${
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
  const post = canPost
    ? `<button type="button" class="small go" data-action="openPost" data-vin="${esc(vin)}" title="Pre-fill the Marketplace form in the side panel. You click Publish.">Post</button>`
    : '';
  return `<span class="actions">${post}<button type="button" class="small" data-action="post" data-vin="${esc(vin)}" title="Already listed it yourself? Mark it posted so rescans watch it.">Mark posted</button></span>`;
}

function decisionPill(decision) {
  const map = { ready: ['good', 'Ready to post'], 'not-ready': ['warn', 'Not ready'], review: ['warn', 'Needs a look'], skip: ['bad', 'Skipped: new'] };
  const [tone, text] = map[decision] || ['', decision];
  return `<span class="pill ${tone}">${esc(text)}</span>`;
}

const price = (e) => basisPrice(e, state.settings?.basis);

function viewTodo(l) {
  const d = state.diff;
  if (!state.snapshot && !d) {
    return empty("No scan yet. Open your dealership's used inventory page and click <b>Scan website</b>.");
  }
  let html = `<div class="meta">Last scan ${esc(when(d?.takenAt || state.snapshot?.takenAt))} · ${l.all.length} used cars · ${l.ready.length} ready to post</div>`;
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
          action: t.yours ? `<button type="button" class="small go" data-action="takenDown" data-vin="${esc(t.vin)}">Taken down</button>` : '',
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
          action: p.yours ? `<button type="button" class="small go" data-action="priceUpdated" data-vin="${esc(p.vin)}" data-price="${p.to}">Updated</button>` : '',
          muted: !p.yours,
        })
      ))
    );
  }
  const arrivals = d?.newArrivals || [];
  if (arrivals.length) {
    parts.push(
      section('New arrivals', 'good', arrivals.map((n) =>
        row(n, {
          sub: decisionPill(n.decision) + (n.decision === DECISION.READY ? '' : ' ' + esc(n.reason)),
          right: money(n.price),
          action: n.decision === DECISION.READY ? postButton(n.vin) : '',
        })
      ))
    );
  }
  const nowReady = d?.nowReady || [];
  if (nowReady.length) parts.push(section('Just became ready', 'good', nowReady.map((n) => row(n, { sub: esc(n.what), action: postButton(n.vin) }))));
  const look = d?.needsALook || [];
  if (look.length) parts.push(section('Needs a look', 'warn', look.map((n) => row(n, { sub: esc(n.text) + (n.yours ? ' · your listing' : '') }))));
  if (!parts.length && d && !d.firstScan) html += empty('Nothing changed since the last scan.');
  return html + parts.join('');
}

function viewReady(l) {
  const lead = `<p class="lead">Pre-owned, at your store, with photos and a price. After you list one on Marketplace, click <b>Mark posted</b> and the next scan will tell you if it sells or its price changes.</p>`;
  if (!l.ready.length) return lead + empty('No cars are ready right now.');
  return lead + rows(l.ready.map((e) => row(e, { sub: facts(e), right: money(price(e)), action: postButton(e.vin) })));
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

const field = (label, name, value, attrs = 'type="text"') =>
  `<label class="field"><span class="k">${esc(label)}</span><input name="${name}" value="${esc(value)}" ${attrs} /></label>`;

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
    ? `<p class="hint">On this website the main price is usually ${money(fee.gap)} higher than the price before fees, most likely the doc fee. Posting the website's main price keeps Marketplace and the website matching.</p>`
    : '';
  return `<form id="settings" class="settings">
    <fieldset><legend>You</legend>
      ${field('Your name', 'salespersonName', s.salesperson.name, 'type="text" placeholder="e.g. Roger"')}
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
      ${field('State', 'dealerState', s.dealer.state, 'type="text" placeholder="PA" maxlength="2"')}
      ${field('ZIP', 'dealerZip', s.dealer.zip, 'type="text" placeholder="15370" inputmode="numeric"')}
      <p class="hint">Marketplace asks for a location. The ZIP is used when it's set, otherwise the city.</p>
    </fieldset>
    <fieldset><legend>Price to post</legend>
      <label><input type="radio" name="basis" value="website" ${s.basis !== 'beforeFees' ? 'checked' : ''} /> <span>The website's main price${example ? ` (e.g. ${money(example.price)} "${esc(example.priceLabel)}")` : ''}</span></label>
      <label><input type="radio" name="basis" value="beforeFees" ${s.basis === 'beforeFees' ? 'checked' : ''} /> <span>Price before fees${example ? ` (e.g. ${money(example.priceBeforeFees)})` : ''}</span></label>
      ${feeNote}
      ${field('Price note in every description', 'priceNote', s.priceNote, `type="text" placeholder="${esc(suggested || 'e.g. Tax and tags extra.')}"`)}
      <p class="hint">Honest prices: the listed price always equals the website price. This note explains what it includes.${suggested ? ` Suggested: "${esc(suggested)}"` : ''}</p>
    </fieldset>
    <fieldset><legend>Safety</legend>
      ${field('Posts per day, per salesperson', 'dailyCap', s.dailyCap, 'type="number" min="1" max="100"')}
      <p class="hint">A safety setting, not a guarantee: Meta doesn't publish its limits.</p>
    </fieldset>
    <fieldset><legend>Description writer (optional)</legend>
      <label><input type="checkbox" name="rewriteEnabled" ${s.rewrite.enabled ? 'checked' : ''} /> <span>Use the Lot Sync rewrite service (Claude) for first drafts</span></label>
      ${field('Service address', 'rewriteEndpoint', s.rewrite.endpoint, 'type="url" placeholder="http://localhost:8787"')}
      ${field('Service key', 'rewriteKey', s.rewrite.key, 'type="password" autocomplete="off"')}
      <p class="hint">Off by default: descriptions come from a built-in template. Either way every draft is checked against the website's facts, and you review it before posting.</p>
    </fieldset>
    <div class="actions"><button type="submit" class="plain">Save settings</button><span class="hint" id="saved"></span></div>
    <fieldset style="margin-top:14px"><legend>Saved data</legend>
      <p class="hint">Scans and your posted list are kept only in this browser, separately for each website.</p>
      <button type="button" class="danger" data-action="clear">Clear everything for this website</button>
    </fieldset>
  </form>`;
}

function render() {
  $('site').textContent = state.origin ? state.siteName || state.origin : "Open your dealership's website, then scan.";
  $('scan').textContent = state.snapshot ? 'Rescan website' : 'Scan website';
  $('settingsBtn').setAttribute('aria-pressed', String(state.view === 'settings'));
  const l = lists();
  renderTabs(l);
  const views = { todo: viewTodo, ready: viewReady, notReady: viewNotReady, otherStores: viewOtherStores, review: viewReview, mine: viewMine, settings: viewSettings };
  if (state.view === 'otherStores' && !l.otherStores.length) state.view = 'todo';
  $('panel').innerHTML = (views[state.view] || viewTodo)(l);
}

// ---------- actions ----------

let clearArmed = false;

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
        setStatus(`Daily post cap reached (${cap.used} of ${cap.cap} today). It resets tomorrow; the dealer can change it in Settings.`, 'error');
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
    case 'unpost':
      state.posted = markTakenDown(state.posted, vin);
      await save('posted');
      break;
    case 'takenDown':
      state.posted = markTakenDown(state.posted, vin);
      dropFromDiff('takeDown');
      dropFromDiff('priceUpdates');
      dropFromDiff('needsALook');
      await save('posted', 'diff');
      break;
    case 'priceUpdated':
      state.posted = markPriceUpdated(state.posted, vin, Number(btn.dataset.price));
      dropFromDiff('priceUpdates');
      await save('posted', 'diff');
      break;
    case 'clear':
      if (!clearArmed) {
        clearArmed = true;
        btn.textContent = 'Click again to clear everything';
        return;
      }
      await chrome.storage.local.remove(Object.values(storageKeys(state.origin)));
      Object.assign(state, { snapshot: null, diff: null, posted: {}, settings: null, view: 'todo' });
      clearArmed = false;
      setStatus('Cleared. Scan again to start over.');
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
      basis: form.get('basis') === 'beforeFees' ? 'beforeFees' : 'website',
      salesperson: { name: str('salespersonName'), title: str('salespersonTitle') || 'sales consultant' },
      dealer: { name: str('dealerName') || prev.dealer.name, city: str('dealerCity'), state: str('dealerState').toUpperCase(), zip: str('dealerZip') },
      priceNote: str('priceNote'),
      dailyCap: Math.max(1, Math.min(100, Number(form.get('dailyCap')) || DEFAULT_DAILY_CAP)),
      rewrite: { enabled: form.get('rewriteEnabled') === 'on', endpoint: str('rewriteEndpoint'), key: str('rewriteKey') },
    },
    { name: state.siteName }
  );
  await save('settings');
  const note = $('saved');
  if (note) note.textContent = 'Saved. Click Rescan website to apply.';
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
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    state.tab = tab || null;
    const url = tab && tab.url ? new URL(tab.url) : null;
    if (url && /^https?:$/.test(url.protocol)) {
      state.origin = url.origin;
      await loadSaved();
      state.siteName = state.snapshot?.site?.name || url.hostname.replace(/^www\./, '');
    }
  } catch (e) {
    // no access to this tab's address; the Scan button explains what to do
  }
  render();
}

init();
