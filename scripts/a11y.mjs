#!/usr/bin/env node
// Lot Sync accessibility check (`npm run test:a11y`): opens the landing page
// (also as it looks once sign-up is open), the three legal pages
// (site/legal/), the manager view (sample data) and, through the in-browser
// sandbox, the real popup and side panel, and checks each for the failures a
// keyboard or screen-reader user meets first. No dependency beyond Playwright: the rules
// are plain DOM checks run inside each page (auditPage, below).
//
//   - every form control has a name (a label, aria-label or aria-labelledby);
//   - every button and link has a name, every image an alt attribute;
//   - ids are unique; aria-selected only on roles that take it, and a tab
//     sits in a tablist;
//   - headings do not skip a level; the page has a language and a title;
//   - every focusable control shows a focus ring (outline or box-shadow);
//   - text meets WCAG AA contrast (4.5:1, 3:1 for large text) against the
//     colour behind it.
//
// Exit code 1 when any page has a finding; each finding names the page, the
// rule and the element.

import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { startServer } from '../demo/serve.mjs';
import { PAGES as LEGAL_PAGES } from './legal-pages.mjs';

// Runs inside the page: must be self-contained.
export function auditPage() {
  const out = [];
  const add = (rule, el, detail = '') => {
    const tag = el ? el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + (el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '') : '';
    const text = el ? (el.textContent || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 40) : '';
    out.push({ rule, el: tag, text, detail });
  };
  const visible = (el) => {
    if (!el || el.closest('[aria-hidden="true"],[hidden],template')) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const byId = (id) => document.getElementById(id);
  const nameOf = (el) => {
    const labelled = el.getAttribute('aria-labelledby');
    if (labelled) return labelled.split(/\s+/).map((id) => (byId(id) ? byId(id).textContent : '')).join(' ').trim();
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) {
      if (el.id) {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l && l.textContent.trim()) return l.textContent.trim();
      }
      const wrap = el.closest('label');
      if (wrap && wrap.textContent.trim()) return wrap.textContent.trim();
      if (el.type === 'submit' || el.type === 'button') return (el.value || '').trim();
      return (el.getAttribute('title') || '').trim();
    }
    const imgs = [...el.querySelectorAll('img[alt]')].map((i) => i.alt).join(' ');
    return ((el.textContent || '') + ' ' + imgs + ' ' + (el.getAttribute('title') || '')).trim();
  };

  // language and title
  if (!document.documentElement.getAttribute('lang')) add('the page has no lang attribute', null);
  if (!document.title.trim()) add('the page has no title', null);

  // controls, buttons, links, images
  for (const el of document.querySelectorAll('input:not([type=hidden]), select, textarea')) {
    if (visible(el) && !nameOf(el)) add('a form control has no label', el);
  }
  for (const el of document.querySelectorAll('button, [role=button], a[href]')) {
    if (visible(el) && !nameOf(el)) add('a button or link has no name', el);
  }
  for (const el of document.querySelectorAll('img')) {
    if (!el.hasAttribute('alt')) add('an image has no alt attribute', el);
  }

  // ids, ARIA
  const seen = new Map();
  for (const el of document.querySelectorAll('[id]')) seen.set(el.id, (seen.get(el.id) || 0) + 1);
  for (const [id, n] of seen) if (n > 1) add('an id is used more than once', byId(id), `${id} x${n}`);
  const SELECTABLE = ['tab', 'option', 'gridcell', 'row', 'columnheader', 'rowheader', 'treeitem'];
  for (const el of document.querySelectorAll('[aria-selected]')) {
    if (!SELECTABLE.includes(el.getAttribute('role'))) add('aria-selected on an element whose role does not take it', el, el.getAttribute('role') || 'no role');
  }
  for (const el of document.querySelectorAll('[role=tab]')) {
    if (!el.closest('[role=tablist]')) add('a tab outside a tablist', el);
  }
  for (const el of document.querySelectorAll('[aria-controls],[aria-labelledby],[aria-describedby]')) {
    for (const attr of ['aria-controls', 'aria-labelledby', 'aria-describedby']) {
      const v = el.getAttribute(attr);
      if (v && v.split(/\s+/).some((id) => !byId(id))) add(`${attr} names an id that is not on the page`, el, v);
    }
  }

  // headings
  let last = 0;
  for (const h of document.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    if (!visible(h)) continue;
    const level = Number(h.tagName[1]);
    if (last && level > last + 1) add('a heading skips a level', h, `h${last} then h${level}`);
    last = level;
  }

  // focus rings are checked from outside with the real Tab key (focusWalk below):
  // Chrome draws :focus-visible for keyboard focus, not for a script's focus()

  // contrast
  const rgba = (c) => {
    const m = String(c).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const behind = (el) => {
    let color = { r: 255, g: 255, b: 255, a: 1 };
    const stack = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const bg = rgba(getComputedStyle(n).backgroundColor);
      if (getComputedStyle(n).backgroundImage !== 'none') return null; // a picture or gradient: not judged
      if (bg && bg.a > 0) { stack.push(bg); if (bg.a >= 1) break; }
    }
    for (const bg of stack.reverse()) color = { r: bg.r * bg.a + color.r * (1 - bg.a), g: bg.g * bg.a + color.g * (1 - bg.a), b: bg.b * bg.a + color.b * (1 - bg.a), a: 1 };
    return color;
  };
  const judged = new Set();
  for (const node of document.querySelectorAll('body *')) {
    if (!visible(node) || judged.size > 400) continue;
    const own = [...node.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim());
    if (!own) continue;
    const s = getComputedStyle(node);
    const fg = rgba(s.color);
    const bg = behind(node);
    if (!fg || !bg) continue;
    const text = { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) };
    const [hi, lo] = [lum(text), lum(bg)].sort((a, b) => b - a);
    const ratio = (hi + 0.05) / (lo + 0.05);
    const size = parseFloat(s.fontSize);
    const bold = Number(s.fontWeight) >= 700;
    const large = size >= 24 || (bold && size >= 18.66);
    const need = large ? 3 : 4.5;
    if (node.closest('button[disabled], input[disabled], [aria-disabled="true"]')) continue; // WCAG exempts inactive controls
    const key = `${s.color}|${bg.r},${bg.g},${bg.b}|${need}`;
    if (ratio < need && !judged.has(key)) {
      judged.add(key);
      add('text contrast is below WCAG AA', node, `${ratio.toFixed(2)}:1, needs ${need}:1 (${s.color} on rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)}))`);
    }
  }
  return out;
}

// Presses Tab through the page (or frame) the way a keyboard user does and
// reports each control that shows no focus ring. The walk ends when focus
// comes back to an element it has already stopped on, or leaves the frame,
// or goes into a frame inside it (the sandbox's tabs, popup and panel).
// A repeat is the same element, never the same label: a page has many
// id-less buttons called Copy or Remove, and each is its own stop. `limit`
// is only a backstop, about four times the longest audited page (the
// popup's Settings, 31 controls when this was written). A walk that reaches
// it is a finding, so a page that outgrows it fails instead of passing
// half-walked. Answers the findings and how many controls the walk reached.
export async function focusWalk(page, target, limit = 120) {
  const found = [];
  await target.evaluate(() => {
    // the elements this walk has stopped on, kept in the page (a set, not a mark on the
    // element: the page's own elements are left as they were, and every walk starts empty)
    window.__lotSyncA11yWalk = new WeakSet();
    // start at the top: a click before the walk (a tab of the popup, say) leaves the
    // browser's Tab starting point on that control, and blur() does not move it; a
    // throwaway first element, focused and removed, puts it before everything else
    const top = document.createElement('span');
    top.tabIndex = -1;
    document.body.prepend(top);
    top.focus();
    top.remove();
    window.focus();
  });
  let reached = 0;
  let ended = false;
  for (let i = 0; i < limit; i += 1) {
    await page.keyboard.press('Tab');
    const info = await target.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body || !document.hasFocus()) return null;
      // focus inside a frame belongs to that frame's own control, which is audited as its own page;
      // a frame nobody can see must not take the focus at all
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        const f = getComputedStyle(el);
        const unseen = f.visibility === 'hidden' || Number(f.opacity) === 0;
        return { frame: true, unseen, tag: el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + (el.title ? ` "${el.title}"` : '') };
      }
      const visited = window.__lotSyncA11yWalk || (window.__lotSyncA11yWalk = new WeakSet());
      if (visited.has(el)) return { repeat: true };
      visited.add(el);
      const s = getComputedStyle(el);
      const ring = (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || (s.boxShadow && s.boxShadow !== 'none');
      const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
      return { ring, type: el.type || '', tag: el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + cls, text: (el.textContent || el.value || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40) };
    });
    if (info && info.frame && info.unseen) found.push({ rule: 'the Tab key reaches into a frame that is not visible', el: info.tag, text: '', detail: '' });
    if (!info || info.repeat || info.frame) {
      ended = true;
      break;
    }
    reached += 1;
    if (!info.ring && info.type !== 'radio' && info.type !== 'checkbox') found.push({ rule: 'no visible focus ring', el: info.tag, text: info.text, detail: '' });
  }
  if (!ended) found.push({ rule: 'the Tab walk reached its limit before focus came back round', el: '', text: '', detail: `${limit} controls; the rest of the page was not checked` });
  if (reached === 0) {
    // a page with controls the keyboard never reached; a page with none (the idle side panel) is fine
    const controls = await target.evaluate(() => [...document.querySelectorAll('a[href], button:not([disabled]), input:not([type=hidden]):not([disabled]), select, textarea')].filter((el) => el.getBoundingClientRect().width > 0).length);
    if (controls) found.push({ rule: 'the keyboard cannot reach any control', el: '', text: '', detail: `${controls} control(s) on the page` });
  }
  return { found, reached };
}

// The walk is checked before any real page, on a page made to fail: two
// id-less buttons with the same label, the second with its focus ring
// removed, then a link. A walk that took the second Copy for focus coming
// back round would stop there and pass every real page unchecked; one that
// started from the last click (the link, here) would miss both buttons.
// Answers '' when the walk found exactly that one control, else what went
// wrong.
export async function checkTheWalk(browser) {
  const page = await browser.newPage();
  try {
    await page.setContent('<!doctype html><html lang="en"><head><title>Walk check</title><style>.bare:focus-visible { outline: none; box-shadow: none; }</style></head><body><button type="button">Copy</button><button type="button" class="bare">Copy</button><a href="#end">Copy</a></body></html>');
    await page.click('a');
    const { found, reached } = await focusWalk(page, page);
    const ok = reached === 3 && found.length === 1 && found[0].rule === 'no visible focus ring' && found[0].el === 'button.bare';
    return ok ? '' : `on a page of three controls, the second one without a focus ring, it reached ${reached} and reported ${JSON.stringify(found)}`;
  } finally {
    await page.close();
  }
}

const DEFAULT_CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

async function main() {
  const executablePath = process.env.LOTSYNC_CHROME || (existsSync(DEFAULT_CHROME) ? DEFAULT_CHROME : undefined);
  const server = await startServer({ port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath, headless: true });
  const results = [];
  const reachedBy = new Map(); // page -> controls the Tab walk reached, printed so the coverage shows
  let current = null; // the page the frames belong to, for the keyboard
  const audit = async (name, target) => {
    const found = await target.evaluate(`(${auditPage.toString()})()`);
    const walk = await focusWalk(current, target);
    found.push(...walk.found);
    reachedBy.set(name, walk.reached);
    results.push(...found.map((f) => ({ page: name, ...f })));
  };
  try {
    const broken = await checkTheWalk(browser);
    if (broken) results.push({ page: 'the Tab walk itself', rule: 'the walk misses a control without a focus ring', el: '', text: '', detail: broken });

    for (const scheme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: scheme });
      current = page;
      await page.goto(`${base}/site/index.html`);
      await audit(`landing page (${scheme})`, page);
      await page.setViewportSize({ width: 390, height: 844 });
      await audit(`landing page, phone (${scheme})`, page);
      // the Start a free pilot links show only once config.js names the manager view: audit the page as it
      // will look then, from a config.js served with signupUrl set (the file on disk is not touched)
      const config = readFileSync(new URL('../site/config.js', import.meta.url), 'utf8');
      const open = config.replace(/signupUrl: '[^']*'/, "signupUrl: '../manager/index.html'");
      if (open === config) results.push({ page: `landing page, sign-up open (${scheme})`, rule: 'site/config.js has no signupUrl to set for the audit', el: '', text: '', detail: '' });
      await page.route('**/site/config.js', (route) => route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: open }));
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`${base}/site/index.html`);
      await page.locator('a[data-signup]').first().waitFor({ state: 'visible', timeout: 15000 });
      await audit(`landing page, sign-up open (${scheme})`, page);
      await page.unroute('**/site/config.js');
      for (const legal of LEGAL_PAGES) {
        const name = `${legal.label} page (${scheme})`;
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.goto(`${base}/${legal.page}`);
        await audit(name, page);
        await page.setViewportSize({ width: 390, height: 844 });
        await audit(name.replace(' (', ', phone ('), page);
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`${base}/manager/index.html?mock=1`);
      await page.locator('#invites').waitFor({ timeout: 15000 });
      await audit(`manager view, sample data (${scheme})`, page);
      // self-serve sign-up: the empty form, a refusal in its live region, then the new dealership's Getting started
      await page.goto(`${base}/manager/index.html?mock=signup`);
      await page.locator('#startDealership').waitFor({ timeout: 15000 });
      await audit(`manager view, Start your dealership (${scheme})`, page);
      await page.fill('#suName', 'Example Motors');
      await page.fill('#suWebsite', '192.168.1.10');
      await page.fill('#suYou', 'Jamie');
      await page.click('#signup button[type="submit"]');
      await page.waitForFunction(() => document.getElementById('signupError').textContent.length > 0);
      await audit(`manager view, Start your dealership refused (${scheme})`, page);
      await page.fill('#suWebsite', 'www.example-motors.test');
      await page.click('#signup button[type="submit"]');
      await page.locator('#gettingStarted ol.steps').waitFor({ timeout: 15000 });
      await audit(`manager view, new dealership with Getting started (${scheme})`, page);
      await page.close();
    }

    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    current = page;
    await page.goto(`${base}/demo/`);
    await page.waitForFunction(() => Boolean(document.body.dataset.ready), null, { timeout: 30000 });
    const openPopup = async () => {
      if (await page.locator('#popupHost').isHidden()) await page.click('#lotSyncButton');
      await page.locator('#popupHost').waitFor({ state: 'visible' });
    };
    await openPopup();
    await page.check('#pinPopup'); // keep the popup open while the keyboard walks in and out of it
    const popupFrame = await (await page.waitForSelector('#popupFrame', { state: 'attached' })).contentFrame();
    await popupFrame.locator('#scan').click();
    await popupFrame.locator('.banner.info').waitFor({ timeout: 20000 });
    for (const view of ['ready', 'todo', 'pilot', 'mine']) {
      const tab = popupFrame.locator(`.tabs button[data-view="${view}"]`);
      if (await tab.count()) {
        await openPopup();
        await tab.click();
        await audit(`popup, ${view} tab`, popupFrame);
      }
    }
    const settings = popupFrame.locator('#settingsBtn');
    if (await settings.count()) {
      await settings.click();
      await audit('popup, Settings', popupFrame);
    }
    const panelFrame = await (await page.waitForSelector('#panelFrame', { state: 'attached' })).contentFrame();
    await audit('side panel, idle', panelFrame);
    await openPopup();
    if (await popupFrame.locator('#settingsBtn[aria-pressed="true"]').count()) await popupFrame.locator('#settingsBtn').click();
    await popupFrame.locator('.tabs button[data-view="ready"]').click();
    await popupFrame.locator('button[data-action="openPost"]').first().click();
    await panelFrame.locator('#description, textarea').first().waitFor({ timeout: 30000 });
    await audit('side panel, reviewing a car', panelFrame);
    await page.close();

    // The sandbox with its sample cars' photos on another https server, as
    // many dealers keep them: the side panel says Chrome will ask, and after
    // a no it shows the photos left out with an Allow button. Then the
    // sandbox page itself (its bar, the sample website choice, the tabs).
    const photos = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    current = photos;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"><rect width="4" height="3" fill="#36c"/></svg>';
    await photos.route('**/demo/site/inventory.js', async (route) => {
      const res = await route.fetch();
      const body = (await res.text()).replace('`${base}photos/${c.key}-${i + 1}.svg`', '`https://photos.example-cdn.test/${c.key}-${i + 1}.svg`');
      if (!body.includes('photos.example-cdn.test')) throw new Error("demo/site/inventory.js no longer builds its photo addresses the way this check moves them; update scripts/a11y.mjs");
      await route.fulfill({ response: res, body });
    });
    await photos.route('https://photos.example-cdn.test/**', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', headers: { 'Access-Control-Allow-Origin': '*' }, body: svg }));
    await photos.goto(`${base}/demo/`);
    await photos.waitForFunction(() => Boolean(document.body.dataset.ready), null, { timeout: 30000 });
    if (await photos.locator('#popupHost').isHidden()) await photos.click('#lotSyncButton');
    await photos.locator('#popupHost').waitFor({ state: 'visible' });
    await photos.check('#pinPopup');
    const popup2 = photos.frameLocator('#popupFrame');
    const panel2 = await (await photos.waitForSelector('#panelFrame', { state: 'attached' })).contentFrame();
    await popup2.locator('#scan').click();
    await popup2.locator('.banner.info').waitFor({ timeout: 20000 });
    await popup2.locator('.tabs button[data-view="ready"]').click();
    await popup2.locator('button[data-action="openPost"]').first().click();
    await panel2.locator('#photoAsk').waitFor({ timeout: 30000 });
    await audit('side panel, Chrome will ask for photos', panel2);
    await photos.evaluate(() => { window.__lotSyncHub.permissionAnswer = false; });
    await panel2.locator('#openForm').click();
    await panel2.locator('#photos.done').waitFor({ timeout: 40000 });
    await panel2.locator('button[data-allow-photos]').first().waitFor();
    await audit('side panel, photos not allowed', panel2);
    await audit('sandbox page', photos); // last: its walk leaves focus wherever it ends
    await photos.close();
  } finally {
    await browser.close();
    server.close();
  }
  for (const [page, n] of reachedBy) console.log(`${page}: the Tab key reached ${n} control${n === 1 ? '' : 's'}`);
  const byPage = new Map();
  for (const r of results) byPage.set(r.page, [...(byPage.get(r.page) || []), r]);
  for (const [page, list] of byPage) {
    console.log(`\n${page}: ${list.length} finding(s)`);
    for (const f of list) console.log(`  - ${f.rule}: ${f.el}${f.text ? ` "${f.text}"` : ''}${f.detail ? ` (${f.detail})` : ''}`);
  }
  console.log(results.length ? `\n${results.length} accessibility finding(s).` : '\nNo accessibility findings.');
  process.exitCode = results.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
