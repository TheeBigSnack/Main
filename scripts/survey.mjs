// Site survey: what Lot Current can and cannot read on a real dealer website,
// and what that website's pages look like.
//
//   npm run survey -- <used-inventory URL> [<URL> ...] [--out survey-out] [--max-car-pages 5] [--headed]
//
// For each address, in Playwright's own Chromium with the real unpacked
// extension loaded (the way test/e2e/*.e2e.mjs load it):
//   1. robots.txt once; a list or car page it disallows for every robot is not read
//   2. the list page as the browser renders it, and its server HTML once
//      (page.request, the browser context's own request), to compare what a
//      read without scripts sees with what the page shows
//   3. up to --max-car-pages car pages linked from it, one at a time
//   4. Lot Current's popup against that tab: Scan website, then what it read
// and writes <out>/<host>/report.json and report.md, and <out>/summary.md.
//
// A polite survey, not a crawl: every page the survey asks for is at least
// 2 seconds after the one before (longer when robots.txt sets a Crawl-delay),
// the timing is fixed, images, video and fonts are not downloaded, and Lot
// Current's own scan runs in a temporary copy of the extension whose page limits
// are lowered (DEFAULTS in survey-lib.mjs). The browser is Playwright's
// Chromium as it is: its own user agent, nothing hidden. A 403, 429, 503 or a
// bot check stops that site at once; nothing is retried. Facebook is never
// opened (any request to it is blocked and recorded). docs/survey.md has the
// how-to and what to send back.

import { chromium } from 'playwright';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULTS, USAGE, parseArgs, hostDir, parseRobots, robotsAllows, robotsVerdict, metaGenerator, assetHosts,
  pageAnatomy, jsonLdSummary, microdataTypes, carLinks, pickCarPages, paginationShape, jsonEndpoint, botSigns,
  fingerprint, GLOBAL_NAMES, capScanLimits, capInventoryLimits, surveyHostPermissions, lotSyncReading, verdictFor, findVins,
  jsonLdExcerpt, photoHosts, renderReportMd, renderSummaryMd,
} from './survey-lib.mjs';
import { adapterById } from '../extension/adapters/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(join(root, 'extension/manifest.json'), 'utf8')).version;
const MEDIA = new Set(['image', 'media', 'font']);
const isFacebook = (host) => /(^|\.)(facebook\.com|fb\.com|fbcdn\.net|facebook\.net|messenger\.com)$/i.test(host);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hostOf = (href) => {
  try {
    return new URL(href).hostname.toLowerCase();
  } catch (e) {
    return '';
  }
};

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(`survey: ${e.message}\n\n${USAGE}`);
  process.exit(2);
}
if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}
const outDir = resolve(opts.out);
const scanLimits = { carPages: opts.scanCarPages, listPages: DEFAULTS.scanListPages, sitemaps: DEFAULTS.scanSitemaps };

// The survey's temporary copy of the extension: the surveyed websites as its
// only host permissions (what the toolbar click's activeTab grants a real
// install), no Facebook permission, no side panel, and the page limits of
// the standard-data adapter and of the inventory-data reader (DealerOn,
// Dealer.com) lowered so one survey reads a handful of pages.
function extensionCopy(urls) {
  const dir = mkdtempSync(join(tmpdir(), 'lot-sync-survey-ext-'));
  cpSync(join(root, 'extension'), dir, { recursive: true });
  const manifestPath = join(dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = surveyHostPermissions(urls);
  manifest.permissions = manifest.permissions.filter((p) => p !== 'sidePanel');
  delete manifest.side_panel;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const adapterPath = join(dir, 'adapters', 'schemaOrg.js');
  writeFileSync(adapterPath, capScanLimits(readFileSync(adapterPath, 'utf8'), scanLimits));
  const inventoryPath = join(dir, 'adapters', 'inventoryJson.js');
  writeFileSync(inventoryPath, capInventoryLimits(readFileSync(inventoryPath, 'utf8'), scanLimits));
  return dir;
}

// Playwright's own Chromium (PLAYWRIGHT_BROWSERS_PATH is honoured by
// Playwright itself). When that build is not installed, a Chromium named by
// LOTSYNC_CHROME, or the one preinstalled at /opt/pw-browsers/chromium.
// Branded Google Chrome and Edge 137+ ignore --load-extension, so they can't be used.
async function launch(extDir, profileDir) {
  const base = {
    headless: !opts.headed,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
    viewport: { width: 1280, height: 900 },
  };
  const fallbacks = [process.env.LOTSYNC_CHROME, '/opt/pw-browsers/chromium'].filter((p) => p && existsSync(p));
  try {
    if (process.env.LOTSYNC_CHROME && existsSync(process.env.LOTSYNC_CHROME)) throw new Error('use LOTSYNC_CHROME');
    return await chromium.launchPersistentContext(profileDir, { ...base, channel: 'chromium' });
  } catch (e) {
    if (!fallbacks.length) throw e;
    return chromium.launchPersistentContext(profileDir, { ...base, executablePath: fallbacks[0] });
  }
}

function capText(pauseMs) {
  const survey = 3 + opts.maxCarPages;
  return `the survey itself asks for at most ${survey} pages per site (robots.txt, the list page, the list's server HTML once, and up to ${opts.maxCarPages} car pages), each at least ${pauseMs / 1000} s after the one before; ` +
    `Lot Current's own scan then runs as a salesperson's click would, in a copy of the extension limited to ${scanLimits.listPages} list pages, ${scanLimits.sitemaps} sitemaps and ${scanLimits.carPages} car pages ` +
    '(as shipped: 40, 5 and 600), two at a time with no pauses, as the product does (a Dealer Inspire site is read through its inventory search instead, a few requests; ' +
    `a DealerOn or Dealer.com site through the list data its page loads, at most ${scanLimits.listPages} list pages, as shipped 30)`;
}

async function surveySite(url) {
  const input = new URL(url);
  const report = {
    tool: 'lot-current site survey',
    lotSyncVersion: version,
    host: input.host,
    input: input.href,
    surveyedAt: new Date().toISOString(),
    limits: { maxCarPages: opts.maxCarPages, pauseMs: DEFAULTS.pauseMs, scan: scanLimits, capText: capText(DEFAULTS.pauseMs) },
    robots: {},
    list: {},
    carPages: [],
    carPagesSummary: { read: 0, withVehicleJsonLd: 0, withVehicleMicrodata: 0, withVinInServerHtml: 0, photoHosts: {} },
    jsonEndpoints: [],
    requests: { survey: 0, robots: 0, list: 0, listServerHtml: 0, carPages: 0, browserTotal: 0, blockedMedia: 0, lotSyncScan: 0, facebookBlocked: 0 },
    bot: { signs: [] },
    lotSync: { attempted: false },
    stopped: null,
  };
  const log = (msg) => console.log(`[${input.host}] ${msg}`);
  const stop = (at, reason) => {
    report.stopped = { at, reason };
    log(`stopped: ${reason}`);
  };
  const noteSigns = (signs) => {
    for (const s of signs) if (!report.bot.signs.includes(s)) report.bot.signs.push(s);
  };

  const extDir = extensionCopy([url]);
  const profileDir = mkdtempSync(join(tmpdir(), 'lot-sync-survey-profile-'));
  let context;
  let phase = 'start';
  const phaseHosts = { list: new Set() };
  const pending = new Set();
  let pauseMs = DEFAULTS.pauseMs;
  let lastAsk = 0;
  // at least pauseMs between the survey's own requests; fixed, never varied
  const politely = async () => {
    const wait = lastAsk + pauseMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastAsk = Date.now();
  };

  try {
    context = await launch(extDir, profileDir);
    await context.route('**/*', (route) => {
      const req = route.request();
      if (isFacebook(hostOf(req.url()))) {
        report.requests.facebookBlocked += 1;
        return route.abort('blockedbyclient');
      }
      if (MEDIA.has(req.resourceType())) {
        report.requests.blockedMedia += 1;
        return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    context.on('request', (req) => {
      if (!/^https?:/.test(req.url())) return;
      if (MEDIA.has(req.resourceType()) || isFacebook(hostOf(req.url()))) return;
      if (phase === 'list' || phase === 'car') {
        report.requests.browserTotal += 1;
        if (phase === 'list') phaseHosts.list.add(hostOf(req.url()));
      } else if (phase === 'scan') report.requests.lotSyncScan += 1;
    });
    // JSON the page's own scripts ask for: kept only when it holds VIN-like
    // strings, and then only its address pattern, top-level keys, the names
    // its request sent and the layout of its car records, never a value
    context.on('response', (res) => {
      const req = res.request();
      if ((phase !== 'list' && phase !== 'car') || !['xhr', 'fetch'].includes(req.resourceType())) return;
      const on = phase === 'list' ? 'list page' : 'car pages';
      const p = (async () => {
        const contentType = (await res.allHeaders().catch(() => ({})))['content-type'] || '';
        if (!/json|javascript|text\/plain/i.test(contentType)) return;
        const body = await res.text().catch(() => '');
        const ep = body.length <= 20000000 ? jsonEndpoint({ url: res.url(), method: req.method(), status: res.status(), contentType, body, postData: req.postData() }) : null;
        if (ep && !report.jsonEndpoints.some((x) => x.pattern === ep.pattern && x.method === ep.method)) report.jsonEndpoints.push({ ...ep, page: on });
      })();
      pending.add(p);
      p.finally(() => pending.delete(p));
    });
    const settle = async () => {
      await Promise.allSettled([...pending]);
    };

    // ---- 1. robots.txt, once ----
    const page = await context.newPage();
    phase = 'robots';
    await politely();
    let robots = { rules: [], crawlDelaySec: null, sitemaps: [] };
    try {
      const res = await page.request.get(input.origin + '/robots.txt', { failOnStatusCode: false, timeout: 30000 });
      report.requests.robots += 1;
      const status = res.status();
      report.robots.status = status;
      const kind = robotsVerdict(status);
      if (kind === 'stop') {
        stop('robots.txt', `robots.txt answered HTTP ${status}, so the website's rules can't be known (or it is turning the survey away); not surveyed`);
      } else if (kind === 'rules') {
        robots = parseRobots(await res.text());
      } else report.robots.note = 'no robots.txt, so no rules';
    } catch (e) {
      stop('robots.txt', `could not reach ${input.origin}: ${String(e.message || e).split('\n')[0]}`);
    }
    report.robots.rules = robots.rules.length;
    report.robots.crawlDelaySec = robots.crawlDelaySec;
    report.robots.sitemaps = robots.sitemaps.length;
    if (robots.crawlDelaySec) pauseMs = Math.max(pauseMs, Math.round(robots.crawlDelaySec * 1000));
    report.limits.pauseMs = pauseMs;
    report.limits.capText = capText(pauseMs);
    if (!report.stopped) {
      const r = robotsAllows(robots, input.href);
      report.robots.listAllowed = r.allowed;
      if (!r.allowed) stop('robots.txt', `robots.txt disallows the list page for every robot (${r.rule}); not surveyed`);
    }

    // ---- 2. the list page, rendered ----
    let rendered = '';
    let finalUrl = input.href;
    if (!report.stopped) {
      phase = 'list';
      await politely();
      log('reading the list page');
      let resp = null;
      try {
        resp = await page.goto(input.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
        report.requests.list += 1;
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      } catch (e) {
        stop('list page', `the list page did not load: ${String(e.message || e).split('\n')[0]}`);
      }
      if (resp) {
        finalUrl = page.url();
        rendered = await page.content();
        const status = resp.status();
        const bot = botSigns({ status, headers: resp.headers(), html: rendered });
        noteSigns(bot.signs);
        const globals = await page.evaluate((names) => names.filter((n) => { try { return n in window && window[n] != null; } catch (e) { return false; } }), GLOBAL_NAMES).catch(() => []);
        const assets = assetHosts(rendered, finalUrl);
        report.list.finalUrl = finalUrl;
        report.list.redirected = finalUrl.replace(/#.*$/, '') !== input.href.replace(/#.*$/, '');
        report.list.title = await page.title().catch(() => '');
        report.list.generator = metaGenerator(rendered);
        report.list.scriptHosts = assets.scriptHosts;
        report.list.globals = globals;
        report.list.rendered = pageAnatomy(rendered, finalUrl, status);
        report.list.jsonLdTypes = jsonLdSummary(rendered).types;
        report.list.pagination = paginationShape(rendered, finalUrl);
        if (bot.refused) stop('list page', `the website refused the list page (${bot.reason}); nothing was retried`);
      }
    }

    // ---- 3. the list's server HTML, once: what a read without scripts sees ----
    let serverHtml = '';
    if (!report.stopped) {
      phase = 'serverHtml';
      await politely();
      try {
        const res = await page.request.get(finalUrl, { failOnStatusCode: false, timeout: 60000 });
        report.requests.listServerHtml += 1;
        serverHtml = await res.text();
        const bot = botSigns({ status: res.status(), headers: res.headers(), html: serverHtml });
        noteSigns(bot.signs);
        report.list.server = pageAnatomy(serverHtml, finalUrl, res.status());
        report.list.serverRelNext = paginationShape(serverHtml, finalUrl).relNext;
        if (bot.refused) stop('list server HTML', `the website refused a read of the list without scripts (${bot.reason}); nothing was retried`);
      } catch (e) {
        report.list.server = null;
        report.list.serverError = String(e.message || e).split('\n')[0];
      }
    }
    await settle();
    report.list.requestHosts = [...phaseHosts.list].sort();
    report.list.platform = fingerprint({ url: finalUrl, html: rendered + '\n' + serverHtml, hosts: [...new Set([...phaseHosts.list, ...(report.list.scriptHosts || [])])], globals: report.list.globals || [], generator: report.list.generator });

    // ---- 4. car pages, one at a time ----
    const links = [...new Set([...carLinks(rendered, finalUrl), ...carLinks(serverHtml, finalUrl)])];
    const { picked, disallowed } = pickCarPages(links, opts.maxCarPages, robots);
    report.carLinksFound = links.length;
    report.disallowedCarPages = disallowed.slice(0, 20);
    report.disallowedCarPagesCount = disallowed.length;
    if (!links.length) report.carPagesNote = 'The list page links to no address that looks like a car page, so no car page was opened.';
    if (!report.stopped && picked.length) {
      const carPage = await context.newPage();
      for (const href of picked) {
        if (report.stopped) break;
        phase = 'car';
        await politely();
        log(`reading car page ${report.carPages.length + 1} of ${picked.length}`);
        const entry = { url: href };
        try {
          const resp = await carPage.goto(href, { waitUntil: 'domcontentloaded', timeout: 60000 });
          report.requests.carPages += 1;
          await carPage.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
          const html = await carPage.content();
          // the navigation's own answer is the server HTML: no second request
          const server = resp ? await resp.text().catch(() => '') : '';
          const status = resp ? resp.status() : null;
          const bot = botSigns({ status: status || 200, headers: resp ? resp.headers() : {}, html: server || html });
          noteSigns(bot.signs);
          const photos = await carPage.evaluate(() => {
            const out = [];
            for (const img of document.querySelectorAll('img')) for (const a of ['src', 'data-src', 'data-lazy', 'data-original']) if (img.getAttribute(a)) out.push(new URL(img.getAttribute(a), document.baseURI).href);
            for (const s of document.querySelectorAll('source[srcset], img[srcset]')) {
              const first = String(s.getAttribute('srcset') || '').trim().split(/\s+/)[0];
              if (first) out.push(new URL(first, document.baseURI).href);
            }
            const og = document.querySelector('meta[property="og:image"]');
            if (og && og.content) out.push(og.content);
            return out;
          }).catch(() => []);
          const serverJson = jsonLdSummary(server);
          entry.finalUrl = carPage.url();
          entry.status = status;
          entry.title = await carPage.title().catch(() => '');
          entry.jsonLd = { ...serverJson, vins: undefined };
          entry.renderedJsonLdBlocks = jsonLdSummary(html).blocks;
          entry.microdata = microdataTypes(server);
          entry.serverVins = findVins(server).length;
          entry.renderedVins = findVins(html).length;
          entry.photoHosts = photoHosts(photos.filter((p) => /\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(p) || /photo|image|img|pictures|media/i.test(p)));
          if (!report.excerpt) {
            const text = jsonLdExcerpt(server) || jsonLdExcerpt(html);
            if (text) report.excerpt = { from: href, text };
          }
          report.carPagesSummary.read += 1;
          if (serverJson.vehicles > 0) report.carPagesSummary.withVehicleJsonLd += 1;
          if (Object.keys(entry.microdata).some((t) => /^(Car|Vehicle|MotorVehicle|Motorcycle)$/.test(t))) report.carPagesSummary.withVehicleMicrodata += 1;
          if (entry.serverVins > 0) report.carPagesSummary.withVinInServerHtml += 1;
          for (const [h, n] of Object.entries(entry.photoHosts)) report.carPagesSummary.photoHosts[h] = (report.carPagesSummary.photoHosts[h] || 0) + n;
          if (bot.refused) stop('car page', `the website refused a car page (${bot.reason}); nothing was retried`);
        } catch (e) {
          entry.error = String(e.message || e).split('\n')[0];
        }
        report.carPages.push(entry);
      }
      await settle();
      await carPage.close();
    }

    // ---- 5. what Lot Current reads: the popup's Scan website on the list tab ----
    phase = 'idle';
    const origin = new URL(finalUrl).origin;
    const permitted = surveyHostPermissions([input.href]).some((p) => new URL(p.slice(0, -1)).hostname === new URL(finalUrl).hostname);
    if (report.stopped) report.lotSync.skippedReason = 'the survey stopped first';
    else if (!permitted) report.lotSync.skippedReason = `the list moved to another website (${origin}); run the survey again with that address`;
    else if (disallowed.length && disallowed.length >= links.length - disallowed.length) report.lotSync.skippedReason = "robots.txt disallows most of the car pages Lot Current's scan would read, so the survey did not run it";
    else {
      phase = 'scan';
      await politely();
      log("running Lot Current's Scan website");
      report.lotSync.attempted = true;
      const listPage = page;
      const setup = await context.newPage();
      await setup.goto('chrome://extensions');
      const extensionId = await setup.evaluate(async () => (await chrome.management.getAll()).find((e) => e.name === 'Lot Current').id);
      await setup.close();
      const popup = await context.newPage();
      // In a real browser the popup sits on top of the dealer tab; here it has
      // its own tab, so "the active tab" is pointed at the list page (as the e2e flows do).
      await popup.addInitScript((tabUrl) => {
        const realQuery = chrome.tabs.query.bind(chrome.tabs);
        chrome.tabs.query = async (q) => {
          if (!(q && q.active)) return realQuery(q);
          const all = await realQuery({});
          return all.filter((t) => t.url === tabUrl).slice(0, 1);
        };
      }, listPage.url());
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      await popup.waitForSelector('#scan:not([disabled])', { timeout: 20000 });
      await popup.click('#scan');
      let finished = true;
      try {
        await popup.waitForFunction(() => {
          const b = document.querySelector('#scan');
          const s = document.querySelector('#status');
          return b && !b.disabled && !/Reading the website/.test((s && s.textContent) || '');
        }, null, { timeout: opts.scanTimeoutSec * 1000, polling: 500 });
      } catch (e) {
        finished = false;
      }
      const statusEl = popup.locator('#status');
      const statusText = ((await statusEl.textContent().catch(() => '')) || '').trim();
      const statusError = /error/.test((await statusEl.getAttribute('class').catch(() => '')) || '');
      const metaText = ((await popup.locator('.meta').first().textContent({ timeout: 1000 }).catch(() => '')) || '').trim();
      const warningsShown = (await popup.locator('.banner.warn').allTextContents().catch(() => [])).map((t) => t.trim()).filter((t) => !/automatic rescan/i.test(t));
      const stored = await popup.evaluate(async (o) => {
        const keys = [`snapshot:${o}`, `diff:${o}`, 'sites'];
        const got = await chrome.storage.local.get(keys);
        return { snapshot: got[keys[0]] || null, diff: got[keys[1]] || null, site: (got.sites || {})[o] || null };
      }, origin);
      await popup.close();
      Object.assign(report.lotSync, lotSyncReading({ ...stored, statusText, metaText, warningsShown }));
      report.lotSync.ok = finished && !statusError && Boolean(stored.snapshot);
      report.lotSync.message = !finished ? `Lot Current's scan did not finish within ${opts.scanTimeoutSec} s` : statusError ? statusText : stored.snapshot ? '' : statusText || 'no scan was saved';
      const adapter = report.lotSync.adapter ? adapterById(report.lotSync.adapter) : null;
      report.lotSync.adapterName = adapter ? adapter.PLATFORM.name : null;
      log(report.lotSync.ok ? `Lot Current read ${report.lotSync.carCount} cars with ${report.lotSync.adapterName}` : `Lot Current did not read it: ${report.lotSync.message}`);
    }
    phase = 'done';
  } catch (e) {
    if (!report.stopped) stop(phase, `the survey itself failed: ${String(e.message || e).split('\n')[0]}`);
  } finally {
    if (context) await context.close().catch(() => {});
    // the throwaway profile and extension copy; a folder still locked by the
    // closing browser is left for the system's temp cleanup
    for (const d of [profileDir, extDir]) {
      try {
        rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      } catch (e) { /* see above */ }
    }
  }

  const q = report.requests;
  q.survey = q.robots + q.list + q.listServerHtml + q.carPages;
  report.verdict = verdictFor(report);
  // two addresses on one website in one run get a folder each
  let name = hostDir(url);
  for (let n = 2; usedDirs.has(name); n += 1) name = `${hostDir(url)}-${n}`;
  usedDirs.add(name);
  const dir = join(outDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(join(dir, 'report.md'), renderReportMd(report));
  log(`verdict: ${report.verdict.verdict}. Report: ${join(dir, 'report.md')}`);
  return report;
}

const usedDirs = new Set();
const runAt = new Date().toISOString();
const reports = [];
for (const url of opts.urls) reports.push(await surveySite(url));
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'summary.md'), renderSummaryMd(reports, { runAt }));
console.log(`\nSummary: ${join(outDir, 'summary.md')}`);
