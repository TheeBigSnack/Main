// Wires the Lot Current test drive (demo/index.html): the fake browser pane
// whose tabs are iframes, the extension's real popup, side panel and service
// worker mounted in iframes with demo/chrome-shim.js in front of them, the
// shared hub they talk through, the sample data the end-to-end flows also
// seed (settings for the sample dealership, the addresses of the sandbox's
// Marketplace pages), the choice of sample website, the day-2 scenario
// switch and Reset.
//
// Nothing in this file touches the pages inside the tabs: the extension's
// own injected functions do that through chrome.scripting.executeScript,
// and only a person clicks Publish, Update, Mark as sold or Delete.

import { LEGAL } from '../extension/src/legalLinks.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const DEMO_BASE = new URL('./', location.href).href;
const SITE_BASE = new URL('site/', DEMO_BASE).href;
const STANDARD_BASE = new URL('site-standard/', DEMO_BASE).href;
const MARKET_BASE = new URL('marketplace/', DEMO_BASE).href;
const EXT_BASE = new URL('../extension/', DEMO_BASE).href;
const ORIGIN = location.origin;
const inventory = window.LOT_SYNC_INVENTORY;
const standard = window.LOT_SYNC_STANDARD;
const standardSite = standard.hashSite(STANDARD_BASE);
const Shim = window.LotSyncShim;

// The two sample websites: Example Motors (demo/site/), whose page carries an
// inventory search service, and Example Auto Outlet (demo/site-standard/),
// which publishes standard vehicle data on each car's own page. Lot Current
// keeps its data per website address and both are served from this page's
// address, so one is in use at a time and switching starts the sandbox over.
const SAMPLES = {
  service: {
    label: 'Example Motors',
    url: SITE_BASE + 'index.html',
    myStores: ['Example Motors Springfield'],
    dealer: 'Example Motors',
    priceNote: `Price includes the $${inventory.DOC_FEE} doc fee; tax and tags extra.`,
    day2Order: () => [inventory.VINS.civic, inventory.VINS.f150, inventory.VINS.rav4, inventory.VINS.grandCherokee],
    // this lot's describeDay2 leaves out the car that gets its photos; it is always the same one
    describeDay2: (s) => {
      const c = inventory.CARS.find((x) => x.vin === inventory.DAY2_DEFAULTS.gotPhotos);
      return { ...inventory.describeDay2(s), gotPhotos: [c.year, c.make, c.model, c.trim].join(' ') };
    },
  },
  standard: {
    label: 'Example Auto Outlet',
    url: standardSite.address('/used-vehicles/'),
    myStores: [standard.DEALER.name],
    dealer: standard.DEALER.name,
    priceNote: 'Tax, title and registration are extra.',
    day2Order: () => standard.DAY2_ORDER,
    describeDay2: (s) => standard.describeDay2(s),
  },
};
const sampleId = (s) => Object.keys(SAMPLES).find((id) => SAMPLES[id] === s);
let sample = SAMPLES[new URLSearchParams(location.search).get('site')] || SAMPLES.service;

// ---------- the browser pane: every tab is an iframe ----------

const browser = { tabs: [], seq: 0, activeId: null };
const findTab = (id) => browser.tabs.find((t) => t.id === Number(id)) || null;
function currentUrl(t) {
  try {
    const h = t.iframe.contentWindow.location.href;
    if (h && h !== 'about:blank') return h;
  } catch (e) { /* mid-navigation */ }
  return t.url;
}
const tabInfo = (t) => ({
  id: t.id, index: browser.tabs.indexOf(t), windowId: 1, active: t.id === browser.activeId, highlighted: t.id === browser.activeId,
  url: currentUrl(t), title: t.title, status: t.status, incognito: false, pinned: false, groupId: -1,
});

function createTab({ url, active = true }) {
  const id = ++browser.seq;
  const iframe = document.createElement('iframe');
  iframe.className = 'tab';
  iframe.inert = true; // until it is the active tab
  iframe.dataset.tabId = String(id);
  iframe.title = `Tab ${id}`;
  const tab = { id, iframe, url: String(url || 'about:blank'), status: 'loading', title: '', closed: false };
  browser.tabs.push(tab);
  iframe.addEventListener('load', () => onTabLoad(tab));
  $('page').insertBefore(iframe, $('popupHost'));
  iframe.src = tab.url;
  hub.emit('tabs.onCreated', [tabInfo(tab)]);
  hub.emit('tabs.onUpdated', [id, { status: 'loading', url: tab.url }, tabInfo(tab)]);
  if (active) activateTab(id);
  else renderChrome();
  return tab;
}

function onTabLoad(tab) {
  if (tab.closed) return;
  const win = tab.iframe.contentWindow;
  tab.status = 'complete';
  tab.url = currentUrl(tab);
  try { tab.title = win.document.title || tab.url; } catch (e) { tab.title = tab.url; }
  try {
    // the page is leaving (a link, a form, location.href): the tab is loading again
    win.addEventListener('pagehide', () => {
      if (tab.closed) return;
      tab.status = 'loading';
      hub.emit('tabs.onUpdated', [tab.id, { status: 'loading' }, tabInfo(tab)]);
      renderChrome();
    });
  } catch (e) { /* not same-origin, which never happens in the sandbox */ }
  applyScenario(tab);
  hub.emit('tabs.onUpdated', [tab.id, { status: 'complete', url: tab.url }, tabInfo(tab)]);
  renderChrome();
}

function activateTab(id) {
  const tab = findTab(id);
  if (!tab) return;
  browser.activeId = id;
  for (const t of browser.tabs) {
    t.iframe.classList.toggle('active', t.id === id);
    // a tab in the background is invisible, so the Tab key must not reach into it
    t.iframe.inert = t.id !== id;
  }
  hub.emit('tabs.onActivated', [{ tabId: id, windowId: 1 }]);
  renderChrome();
}

function closeTab(id) {
  const tab = findTab(id);
  if (!tab || browser.tabs.length === 1) return;
  tab.closed = true;
  tab.iframe.remove();
  browser.tabs = browser.tabs.filter((t) => t !== tab);
  hub.emit('tabs.onRemoved', [id, { windowId: 1, isWindowClosing: false }]);
  if (browser.activeId === id) activateTab(browser.tabs[browser.tabs.length - 1].id);
  else renderChrome();
}

function navigateTab(tab, url) {
  tab.url = String(url);
  tab.status = 'loading';
  tab.iframe.src = tab.url;
  hub.emit('tabs.onUpdated', [tab.id, { status: 'loading', url: tab.url }, tabInfo(tab)]);
  renderChrome();
}

// What the shim's chrome.tabs and chrome.scripting call.
const tabsApi = {
  list: () => browser.tabs.map(tabInfo),
  get: (id) => { const t = findTab(id); return t ? tabInfo(t) : null; },
  create: ({ url, active }) => tabInfo(createTab({ url: url || 'about:blank', active })),
  update: (id, props) => {
    const t = id === null || id === undefined ? findTab(browser.activeId) : findTab(id);
    if (!t) throw new Error(`No tab with id: ${id}.`);
    if (props && props.url) navigateTab(t, props.url);
    if (props && props.active) activateTab(t.id);
    return tabInfo(t);
  },
  remove: (id) => { if (!findTab(id)) throw new Error(`No tab with id: ${id}.`); closeTab(id); },
  windowOf: (id) => { const t = findTab(id); return t ? t.iframe.contentWindow : null; },
};

function renderChrome() {
  $('tabstrip').innerHTML = browser.tabs.map((t) => {
    const active = t.id === browser.activeId;
    const label = t.title || (t.status === 'loading' ? 'Loading…' : t.url);
    const close = browser.tabs.length > 1 ? `<button type="button" class="x" data-close="${t.id}" title="Close tab" aria-label="Close tab">×</button>` : '';
    return `<div class="tabbtn${active ? ' active' : ''}" role="tab" aria-selected="${active}" data-tab="${t.id}"><span class="t">${esc(label)}</span>${close}</div>`;
  }).join('');
  const active = findTab(browser.activeId);
  $('url').textContent = active ? currentUrl(active) : '';
}

$('tabstrip').addEventListener('click', (ev) => {
  const x = ev.target.closest('[data-close]');
  if (x) { closeTab(Number(x.dataset.close)); return; }
  const b = ev.target.closest('[data-tab]');
  if (b) activateTab(Number(b.dataset.tab));
});
$('reload').addEventListener('click', () => {
  const t = findTab(browser.activeId);
  if (t) navigateTab(t, currentUrl(t));
});

// ---------- the hub the extension's frames share ----------

const manifest = await (await fetch(EXT_BASE + 'manifest.json', { cache: 'no-store' })).json();
const hub = Shim.createHub({
  manifest,
  extensionBase: EXT_BASE,
  tabs: tabsApi,
  badge: drawBadge,
  notify: toast,
  sidePanel: () => flashPanel(),
});
// The service-worker frame's stand-ins for the sample websites' servers
// (the background rescan): Example Motors' inventory search endpoint, and
// Example Auto Outlet's pages while that sample is the one in use.
hub.search = (body) => inventory.search(inventory.records(scenario, SITE_BASE), body);
hub.standardPage = (url) => (sample === SAMPLES.standard ? standard.respond(url, scenario, standardSite, { follow: true }) : null);
window.__lotSyncHub = hub;

function drawBadge({ text, color }) {
  const b = $('badge');
  b.textContent = text;
  b.hidden = !text;
  if (color) b.style.background = color;
}

function toast(id, opts) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.dataset.id = id;
  el.innerHTML = `<b>${esc((opts && opts.title) || 'Lot Current')}</b>${esc((opts && opts.message) || '')}<br><small>a desktop notification, as Chrome would show it</small>`;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 9000);
}

function flashPanel() {
  $('sidepanel').classList.add('flash');
  setTimeout(() => $('sidepanel').classList.remove('flash'), 1200);
}

// ---------- the sample website's scenario ----------

let scenario = 'day1';

function applyScenario(tab) {
  try {
    const w = tab.iframe.contentWindow;
    if (w && 'LOT_SYNC_SCENARIO' in w) w.LOT_SYNC_SCENARIO = scenario; // only the sample websites have it
  } catch (e) { /* not the sample site */ }
}

// Day 2 aims at the cars the person has posted: the newest listing gets the
// price drop, an older one sells. With one posted car it gets the price drop
// (the richer flow) and a car nobody posted sells.
function day2Scenario() {
  const key = `posted:${ORIGIN}`;
  const posted = hub.storageGet('local', key)[key] || {};
  const vins = Object.entries(posted).sort((a, b) => String(a[1].postedAt || '').localeCompare(String(b[1].postedAt || ''))).map(([vin]) => vin);
  const order = sample.day2Order();
  if (vins.length >= 2) return { name: 'day2', sold: vins[0], dropped: vins[vins.length - 1] };
  const dropped = vins[0] || order[1];
  return { name: 'day2', sold: order.find((v) => v !== dropped), dropped };
}

function setScenario(next) {
  scenario = next;
  for (const t of browser.tabs) applyScenario(t);
  renderScenario();
}

function renderScenario() {
  const el = $('scenario');
  if (scenario === 'day1' || (scenario && scenario.name !== 'day2')) {
    el.textContent = 'Website inventory: day 1.';
    $('day2').textContent = 'Day 2: a car sells and a price drops';
    return;
  }
  const d = sample.describeDay2(scenario);
  el.textContent = `Day 2 on the website: the ${d.sold} sold, the ${d.dropped} dropped $${d.drop.toLocaleString('en-US')}, the ${d.gotPhotos} got photos, and a ${d.arrived} arrived. Now click Rescan website in the popup.`;
  $('day2').textContent = 'Back to day 1';
}

$('day2').addEventListener('click', () => setScenario(scenario === 'day1' ? day2Scenario() : 'day1'));

// ---------- the seed: what the e2e flows put in storage ----------

function seed() {
  hub.resetStorage();
  const now = new Date().toISOString();
  hub.storageSet('local', {
    [`settings:${ORIGIN}`]: {
      myStores: sample.myStores,
      basis: 'website',
      salesperson: { name: 'Alex', title: 'sales consultant' },
      // No ZIP on purpose, as in the e2e flows: the scan fills it from the website's own structured data.
      dealer: { name: sample.dealer, city: 'Springfield', state: 'OH', zip: '' },
      priceNote: sample.priceNote,
      dailyCap: 10,
      rewrite: { enabled: false, endpoint: '', key: '' },
      notify: true,
      rulesReadAt: now,
      legal: { version: LEGAL.version, acceptedAt: now },
    },
    [`wizardDone:${ORIGIN}`]: { skipped: true, at: now, sandbox: true },
    // Points the side panel at the sandbox's Marketplace pages instead of the real ones (formMap.js DEV_OVERRIDE_KEYS: addresses and timings only).
    devOverrides: {
      createUrl: MARKET_BASE + 'create.html',
      listingUrlPattern: '^' + escapeRe(MARKET_BASE + 'item.html?id=') + '(\\d+)',
      afterPublishPatterns: ['^' + escapeRe(MARKET_BASE + 'selling.html')],
      yourListingsUrl: MARKET_BASE + 'selling.html',
      settleMs: 300,
      recheckMs: 800,
    },
  });
}

// ---------- mounting the extension's pages ----------

// The real HTML, fetched and written into the iframe with the shim ahead of
// the page's own module script and a <base> so its relative paths resolve to
// the extension folder. The extension's files themselves are not changed.
async function mountPage(iframe, file) {
  const res = await fetch(EXT_BASE + file, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Could not load ${file}: HTTP ${res.status}`);
  const html = await res.text();
  const head = `<base href="${EXT_BASE}"><script src="${DEMO_BASE}chrome-shim.js"></script>`;
  const doc = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + head) : head + html;
  await new Promise((resolve) => { iframe.addEventListener('load', resolve, { once: true }); iframe.srcdoc = doc; });
}

// The service worker has no HTML: a bare document that loads background.js as
// a module, plus a fetch stand-in for what the sample websites' servers
// answer (a static host has no inventory search endpoint and no page for
// each car), so the background rescan can run here too.
async function mountWorker(iframe) {
  const intercept = `<script>(function () {
    var real = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      if (method === 'POST' && /\\/api\\/v1\\/listings\\/\\d+\\/search$/.test(url)) {
        var body = {};
        try { body = JSON.parse((init && init.body) || '{}'); } catch (e) { body = {}; }
        return Promise.resolve(window.parent.__lotSyncHub.search(body)).then(function (data) {
          return new Response(JSON.stringify({ data: data }), { status: 200, headers: { 'content-type': 'application/json' } });
        });
      }
      if (method === 'GET' || method === 'HEAD') {
        var address = url;
        try { address = new URL(url, document.baseURI).href; } catch (e) { address = url; }
        var answer = window.parent.__lotSyncHub.standardPage(address);
        if (answer) {
          // the answer carries the address it came from, as a real response does
          var res = new Response(method === 'HEAD' ? null : answer.body, { status: answer.status, headers: { 'content-type': answer.type } });
          Object.defineProperty(res, 'url', { value: answer.url || address });
          Object.defineProperty(res, 'redirected', { value: Boolean(answer.redirected) });
          return Promise.resolve(res);
        }
      }
      return real(input, init);
    };
  })();</script>`;
  const doc = `<!doctype html><html><head><meta charset="utf-8"><base href="${EXT_BASE}"><script src="${DEMO_BASE}chrome-shim.js"></script>${intercept}<title>Lot Current service worker (sandbox)</title></head><body><script type="module" src="background.js"></script></body></html>`;
  await new Promise((resolve) => { iframe.addEventListener('load', resolve, { once: true }); iframe.srcdoc = doc; });
  hub.emit('runtime.onInstalled', [{ reason: 'install' }]);
}

// ---------- the popup drops down from the toolbar icon, as in Chrome ----------

function openPopup() {
  $('popupHost').hidden = false;
  $('lotSyncButton').setAttribute('aria-expanded', 'true');
}
function closePopup(force = false) {
  if (!force && $('pinPopup').checked) return;
  $('popupHost').hidden = true;
  $('lotSyncButton').setAttribute('aria-expanded', 'false');
}
$('lotSyncButton').addEventListener('click', () => ($('popupHost').hidden ? openPopup() : closePopup(true)));
// Chrome closes the popup when you click anywhere else. A click on this page
// says so directly; a click inside another iframe (a tab, the side panel)
// only moves the focus there, and focus moving between two iframes fires no
// event on this page, so the focused element is watched instead.
document.addEventListener('pointerdown', (ev) => {
  if ($('popupHost').hidden) return;
  if ($('popupHost').contains(ev.target) || $('lotSyncButton').contains(ev.target)) return;
  closePopup();
});
setInterval(() => {
  if ($('popupHost').hidden) return;
  const a = document.activeElement;
  if (a && a.tagName === 'IFRAME' && a !== $('popupFrame')) closePopup();
}, 150);

// ---------- the automatic rescan, on demand ----------

$('rescanNow').addEventListener('click', async () => {
  const el = $('rescanStatus');
  el.hidden = false;
  el.textContent = 'Asking the service worker to rescan the website in the background…';
  $('rescanNow').disabled = true;
  try {
    const r = await hub.sendMessage(null, { type: 'rescanNow', origin: ORIGIN, reason: 'alarm' });
    el.textContent = r && r.ok
      ? `Background rescan done: ${r.cars} used cars read, ${r.count} to-do item${r.count === 1 ? '' : 's'} on your listings (the badge on the icon shows it).${r.warnings && r.warnings.length ? ' ' + r.warnings.join(' ') : ''}`
      : `Background rescan did not run: ${(r && r.error) || 'no answer'}`;
  } catch (e) {
    el.textContent = `Background rescan did not run: ${(e && e.message) || e}`;
  } finally {
    $('rescanNow').disabled = false;
  }
});

// ---------- the sample website ----------

// Switching starts over: the two samples share this page's address, so they
// would share Lot Current's data too.
async function switchSite(id) {
  if (!SAMPLES[id] || SAMPLES[id] === sample) return;
  sample = SAMPLES[id];
  try {
    const u = new URL(location.href);
    u.searchParams.set('site', id);
    history.replaceState(null, '', u.href);
  } catch (e) { /* the address stays as it was; the choice still applies */ }
  await reset();
  const note = $('siteNote');
  note.textContent = `Now showing ${sample.label}'s sample website. Both sample websites share this page's address, and Lot Current keeps its data per website address, so the sandbox was reset.`;
  note.hidden = false;
}

$('siteChoice').value = sampleId(sample);
$('siteChoice').addEventListener('change', (ev) => {
  switchSite(ev.target.value).catch((e) => { console.error(e); alert('Switching failed: ' + (e && e.message)); });
});

// ---------- reset / start ----------

async function reset() {
  document.body.dataset.ready = '';
  hub.detachAll();
  for (const t of browser.tabs) { t.closed = true; t.iframe.remove(); }
  browser.tabs = [];
  browser.seq = 0;
  browser.activeId = null;
  try { sessionStorage.removeItem('lotSyncSandbox.listings'); sessionStorage.removeItem('lotSyncSandbox.publishClicks'); } catch (e) { /* no sessionStorage */ }
  scenario = 'day1';
  renderScenario();
  $('rescanStatus').hidden = true;
  $('siteNote').hidden = true;
  $('siteChoice').value = sampleId(sample);
  hub.setBadge({ text: '' });
  seed();
  createTab({ url: sample.url, active: true });
  await mountWorker($('workerFrame'));
  await Promise.all([mountPage($('popupFrame'), 'popup.html'), mountPage($('panelFrame'), 'sidepanel.html')]);
  $('pinPopup').checked = false;
  openPopup();
  document.body.dataset.ready = String(Date.now());
}

$('reset').addEventListener('click', () => reset().catch((e) => { console.error(e); alert('Reset failed: ' + (e && e.message)); }));

reset().catch((e) => {
  console.error(e);
  $('scenario').textContent = 'The sandbox could not start: ' + ((e && e.message) || e) + '. Serve the repository root (node demo/serve.mjs) and open /demo/.';
});
