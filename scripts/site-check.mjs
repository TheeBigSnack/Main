#!/usr/bin/env node
// Lot Sync website check (`npm run test:site`): serves site/ the way GitHub
// Pages does and opens every page of the site map (scripts/site-pages.mjs)
// in headless Chromium, at a desktop and a phone width, failing on anything
// a visitor's browser would complain about. Nothing is mocked: the committed
// files are served as they are, and the browser is a real one.
//
// The server (startPagesServer) behaves like Pages: a directory serves its
// index.html; a directory address without the slash answers 301 to the
// slashed one; a .html file is served at its name (and at the name without
// .html); a missing path serves 404.html with status 404; the MIME types
// cover html, css, js, json, png, svg, ico, xml and txt. The resolver
// (resolvePath) is a pure function over the files, so test/sitePages.test.js
// checks it without a browser.
//
// For every page: any console message of type error or warning (a
// Content-Security-Policy violation arrives as one), any uncaught page
// error, any failed request, and any response with status 400 or more
// (except the document itself on the deliberate visit to a missing address)
// is a finding. In the live DOM: document.title is fullTitle(page); the
// canonical is siteUrl + path exactly when site/config.js has siteUrl, and
// absent otherwise; there is exactly one h1; the site nav marks the current
// page and nothing else; the breadcrumb's last item is the page's crumb;
// site.js has filled the pricing numbers on the pages that load it; the
// demo form is open or closed as config.js says; the page does not scroll
// sideways. Then: the root files (favicons, robots.txt, llms.txt, every
// share image; sitemap.xml and CNAME only once siteUrl is set) answer 200
// with the right type; each redirect stub lands on its target page; a
// missing address, at the root and under /legal/, shows the 404 page with
// status 404 and no failed asset.
//
// Chromium: LOTSYNC_CHROME, else the path scripts/a11y.mjs uses when it
// exists, else the one Playwright installed (npx playwright install chromium;
// PLAYWRIGHT_BROWSERS_PATH says where). Playwright is imported inside main(),
// so importing the server and the resolver costs nothing.
//
// Exit code 1 with every finding named; 0 when there is none.

import { createServer } from 'node:http';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PAGES, REDIRECTS, NAV, fullTitle } from './site-pages.mjs';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const SITE_DIR = join(ROOT, 'site');
export const DEFAULT_CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
export const chromePath = () => process.env.LOTSYNC_CHROME || (existsSync(DEFAULT_CHROME) ? DEFAULT_CHROME : undefined);

export const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
});

export const VIEWPORTS = Object.freeze([Object.freeze({ width: 1280, height: 900 }), Object.freeze({ width: 390, height: 844 })]);
// The files every page links or a crawler asks for, expected at the root with these types.
export const ROOT_FILES = Object.freeze([
  ['/favicon.ico', 'image/x-icon'],
  ['/favicon.svg', 'image/svg+xml'],
  ['/favicon-32.png', 'image/png'],
  ['/apple-touch-icon.png', 'image/png'],
  ['/robots.txt', 'text/plain; charset=utf-8'],
  ['/llms.txt', 'text/plain; charset=utf-8'],
]);
export const MISSING_PATHS = Object.freeze(['/does-not-exist/', '/legal/does-not-exist/']);

const isDir = (f) => existsSync(f) && statSync(f).isDirectory();
const isFile = (f) => existsSync(f) && statSync(f).isFile();

/**
 * What GitHub Pages answers for an address, as a pure function over the
 * files under root: { status, file, type, location }. 301 carries the
 * slashed address in location; 404 carries root/404.html when it exists
 * (else no file); 200 carries the file and its MIME type.
 */
export function resolvePath(root, pathname) {
  const base = resolve(root);
  let decoded;
  try {
    decoded = decodeURIComponent(String(pathname || '/').split('?')[0].split('#')[0]);
  } catch {
    decoded = '';
  }
  const notFound = () => (isFile(join(base, '404.html'))
    ? { status: 404, file: join(base, '404.html'), type: MIME['.html'] }
    : { status: 404, file: null, type: MIME['.txt'] });
  if (!decoded.startsWith('/') || decoded.includes('\0')) return notFound();
  const file = normalize(join(base, decoded));
  if (file !== base && !file.startsWith(base + sep)) return notFound(); // outside root: never served
  if (isDir(file)) {
    if (!decoded.endsWith('/')) return { status: 301, file: null, type: null, location: decoded + '/' };
    const index = join(file, 'index.html');
    return isFile(index) ? { status: 200, file: index, type: MIME['.html'] } : notFound();
  }
  if (isFile(file)) return { status: 200, file, type: MIME[extname(file).toLowerCase()] || 'application/octet-stream' };
  if (!decoded.endsWith('/') && isFile(file + '.html')) return { status: 200, file: file + '.html', type: MIME['.html'] }; // Pages serves about.html at /about too
  return notFound();
}

/** A static server over root that answers like GitHub Pages (resolvePath); GET and HEAD only. Resolves with the listening server. */
export function startPagesServer({ root = SITE_DIR, port = 0, host = '127.0.0.1' } = {}) {
  const server = createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', 'content-type': MIME['.txt'] });
      return res.end('The site is static: only GET.');
    }
    const url = new URL(req.url, `http://${req.headers.host || host}`);
    const answer = resolvePath(root, url.pathname);
    if (answer.status === 301) {
      res.writeHead(301, { location: answer.location + url.search });
      return res.end();
    }
    const body = answer.file ? readFileSync(answer.file) : Buffer.from(`Not found: ${url.pathname}`);
    res.writeHead(answer.status, { 'content-type': answer.type, 'content-length': body.length, 'cache-control': 'no-store' });
    return res.end(req.method === 'HEAD' ? undefined : body);
  });
  return new Promise((ok, fail) => {
    server.on('error', fail);
    server.listen(port, host, () => ok(server));
  });
}

const money = (n) => '$' + Number(n).toLocaleString('en-US');
const pageLabel = (page) => page.nav || page.crumb || page.h1 || page.slug;

/**
 * Opens url in a new page of the context with the listeners that make a
 * finding of what the browser complains about: console errors and warnings,
 * page errors, failed requests, responses of 400 or more. `allowDocument404`
 * lets the document's own 404 through (the deliberate missing address);
 * `leaving` lets the browser's own cancellations through (a page that sends
 * the browser on at once, like a redirect stub, cancels what it had started).
 * Answers { page, response, findings }.
 */
export async function openPage(context, url, { allowDocument404 = false, leaving = false, waitUntil = 'load' } = {}) {
  const findings = [];
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    // the deliberate missing address: Chromium logs the document's own 404 as a resource failure; an
    // asset that answers 404 on that page is still caught below, by its response
    const at = (m.location() && m.location().url) || '';
    if (allowDocument404 && /status of 404/.test(m.text()) && (at === url || at === '')) return;
    findings.push(`console ${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => findings.push(`page error: ${e.message}`));
  page.on('requestfailed', (r) => {
    const why = (r.failure() && r.failure().errorText) || 'failed';
    if (leaving && why === 'net::ERR_ABORTED') return;
    findings.push(`request failed: ${r.url()} (${why})`);
  });
  page.on('response', (r) => {
    if (r.status() < 400) return;
    if (allowDocument404 && r.status() === 404 && r.url() === url) return;
    findings.push(`${r.status()} for ${r.url()}`);
  });
  let response = null;
  try {
    response = await page.goto(url, { waitUntil });
  } catch (e) {
    // a page that sends the browser on at once can interrupt its own navigation; the caller then waits for the target
    if (!leaving || !/interrupted|ERR_ABORTED/.test(e.message)) throw e;
  }
  return { page, response, findings };
}

/** The live-DOM assertions on one page of the map; answers the findings. */
export async function checkPageDom(page, entry, { site, pricing, viewport }) {
  const out = [];
  const title = await page.title();
  const want = fullTitle(entry);
  if (title !== want) out.push(`the tab says "${title}", not "${want}"`);
  const canonical = await page.evaluate(() => [...document.querySelectorAll('link[rel="canonical"]')].map((l) => l.href));
  const wantCanonical = site.siteUrl && entry.kind !== 'notFound' ? [site.siteUrl + entry.path] : [];
  if (JSON.stringify(canonical) !== JSON.stringify(wantCanonical)) out.push(`canonical ${JSON.stringify(canonical)}, expected ${JSON.stringify(wantCanonical)}`);
  const h1s = await page.locator('h1').count();
  if (h1s !== 1) out.push(`${h1s} h1 elements, expected one`);
  const navItems = await page.locator('nav[aria-label="Site"] a').allTextContents();
  if (JSON.stringify(navItems) !== JSON.stringify(NAV.map((p) => p.nav))) out.push(`the site nav reads ${JSON.stringify(navItems)}`);
  const current = await page.locator('nav[aria-label="Site"] a[aria-current="page"]').allTextContents();
  const wantCurrent = entry.nav ? [entry.nav] : [];
  if (JSON.stringify(current) !== JSON.stringify(wantCurrent)) out.push(`aria-current on ${JSON.stringify(current)}, expected ${JSON.stringify(wantCurrent)}`);
  const crumbs = await page.locator('nav[aria-label="Breadcrumb"] [aria-current="page"]').allTextContents();
  const wantCrumbs = entry.crumb ? [entry.crumb] : [];
  if (JSON.stringify(crumbs) !== JSON.stringify(wantCrumbs)) out.push(`the breadcrumb ends on ${JSON.stringify(crumbs)}, expected ${JSON.stringify(wantCrumbs)}`);
  if (entry.script) {
    const price = money(pricing.perRooftopMonthly);
    const filled = await page.waitForFunction((p) => {
      const el = document.querySelector('[data-pricing="perRooftopMonthly"]');
      return el && el.textContent === p;
    }, price, { timeout: 10000 }).then(() => true, () => false);
    if (!filled) out.push(`site.js did not fill [data-pricing="perRooftopMonthly"] with ${price}`);
    const signup = await page.locator('a[data-signup]').evaluateAll((links) => links.map((l) => l.hidden));
    if (!signup.length) out.push('no Start a free pilot link');
    const shown = signup.some((hidden) => !hidden);
    if (shown !== Boolean(site.signupUrl)) out.push(`the Start a free pilot links are ${shown ? 'shown' : 'hidden'} while signupUrl is ${JSON.stringify(site.signupUrl)}`);
  }
  if (entry.slug === 'home') {
    const open = Boolean(site.demoEndpoint || site.demoMailto);
    const formShown = await page.locator('#demo-form').isVisible();
    const noteShown = await page.locator('#demo-closed').isVisible();
    const enabled = await page.locator('#demo-form button[type="submit"]').isEnabled();
    if (formShown !== open) out.push(`the demo form is ${formShown ? 'shown' : 'hidden'} while the form is ${open ? 'open' : 'closed'} in config.js`);
    if (noteShown === open) out.push(`the "not open yet" note is ${noteShown ? 'shown' : 'hidden'} while the form is ${open ? 'open' : 'closed'}`);
    if (enabled !== open) out.push(`the submit button is ${enabled ? 'enabled' : 'disabled'} while the form is ${open ? 'open' : 'closed'}`);
  }
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (sideways) out.push(`the page scrolls sideways at ${viewport.width} px`);
  return out;
}

/**
 * Runs every check against a served site: answers the findings, each "where:
 * what". `base` is the server's address; `browser` a Playwright browser.
 */
export async function checkSite({ base, browser, site, pricing, log = () => {} }) {
  const findings = [];
  const note = (where, list) => {
    for (const f of list) findings.push(`${where}: ${f}`);
  };

  for (const entry of PAGES) {
    for (const viewport of VIEWPORTS) {
      const where = `${entry.path} at ${viewport.width} px`;
      const context = await browser.newContext({ viewport });
      try {
        const { page, response, findings: seen } = await openPage(context, base + entry.path);
        if (!response || response.status() !== 200) seen.push(`the document answered ${response ? response.status() : 'nothing'}`);
        seen.push(...(await checkPageDom(page, entry, { site, pricing, viewport })));
        await page.close();
        note(where, seen);
        log(`${where}: ${seen.length ? `${seen.length} finding(s)` : 'ok'} (${pageLabel(entry)})`);
      } finally {
        await context.close();
      }
    }
  }

  // the redirect stubs land on their targets, loading nothing of their own
  const context = await browser.newContext({ viewport: VIEWPORTS[0] });
  try {
    for (const r of REDIRECTS) {
      const from = '/' + r.file.replace(/^site\//, '');
      const target = PAGES.find((p) => p.path === r.target);
      const { page, findings: seen } = await openPage(context, base + from, { leaving: true });
      const landed = await page.waitForURL(base + r.target, { timeout: 10000 }).then(() => true, () => false);
      if (!landed) seen.push(`did not land on ${r.target} (${page.url()})`);
      else {
        await page.waitForLoadState('load');
        const title = await page.title();
        if (title !== fullTitle(target)) seen.push(`landed with the title "${title}", not "${fullTitle(target)}"`);
      }
      await page.close();
      note(from, seen);
      log(`${from}: ${seen.length ? `${seen.length} finding(s)` : `ok, lands on ${r.target}`}`);
    }

    // a missing address shows the 404 page, with status 404 and every asset found (its links are root-relative, so any depth works)
    const notFound = PAGES.find((p) => p.kind === 'notFound');
    for (const missing of MISSING_PATHS) {
      const { page, response, findings: seen } = await openPage(context, base + missing, { allowDocument404: true });
      if (!response || response.status() !== 404) seen.push(`answered ${response ? response.status() : 'nothing'}, expected 404`);
      const h1 = await page.locator('h1').allTextContents();
      if (JSON.stringify(h1) !== JSON.stringify([notFound.h1])) seen.push(`the h1 reads ${JSON.stringify(h1)}, expected "${notFound.h1}"`);
      const title = await page.title();
      if (title !== fullTitle(notFound)) seen.push(`the tab says "${title}", not "${fullTitle(notFound)}"`);
      await page.close();
      note(missing, seen);
      log(`${missing}: ${seen.length ? `${seen.length} finding(s)` : 'ok, the 404 page with status 404'}`);
    }
  } finally {
    await context.close();
  }

  // the root files, by plain request
  const social = readdirSync(join(SITE_DIR, 'social')).filter((f) => f.endsWith('.png')).sort().map((f) => [`/social/${f}`, 'image/png']);
  const gated = [['/sitemap.xml', 'application/xml; charset=utf-8'], ['/CNAME', 'application/octet-stream']];
  for (const [path, type] of [...ROOT_FILES, ...social, ...gated]) {
    const res = await fetch(base + path);
    await res.arrayBuffer();
    const expected = gated.some(([p]) => p === path) && !site.siteUrl ? 404 : 200;
    if (res.status !== expected) findings.push(`${path}: answered ${res.status}, expected ${expected}${expected === 404 ? ' (siteUrl is not set)' : ''}`);
    else if (expected === 200 && res.headers.get('content-type') !== type) findings.push(`${path}: served as ${res.headers.get('content-type')}, expected ${type}`);
  }
  const slashless = await fetch(base + '/pricing', { redirect: 'manual' });
  await slashless.arrayBuffer();
  if (slashless.status !== 301 || slashless.headers.get('location') !== '/pricing/') findings.push(`/pricing: answered ${slashless.status} ${slashless.headers.get('location') || ''}, expected 301 to /pricing/`);
  log(`root files: ${ROOT_FILES.length + social.length + gated.length} checked`);
  return findings;
}

export async function main() {
  const { chromium } = await import('playwright');
  const { SITE } = await import(pathToFileURL(join(SITE_DIR, 'config.js')).href);
  const pricing = JSON.parse(readFileSync(join(SITE_DIR, 'pricing.json'), 'utf8'));
  const server = await startPagesServer({ root: SITE_DIR });
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  let findings;
  try {
    console.log(SITE.siteUrl ? `siteUrl is ${SITE.siteUrl}: every canonical is expected` : 'siteUrl is not set: no canonical is expected (the site is not ready to publish)');
    findings = await checkSite({ base, browser, site: SITE, pricing, log: (s) => console.log(s) });
  } finally {
    await browser.close();
    server.close();
  }
  for (const f of findings) console.log(`  - ${f}`);
  console.log(findings.length ? `\n${findings.length} website finding(s).` : `\nNo website findings: ${PAGES.length} pages at ${VIEWPORTS.length} widths, ${REDIRECTS.length} redirect stubs, ${MISSING_PATHS.length} missing addresses, the root files.`);
  return findings.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exitCode = await main();
