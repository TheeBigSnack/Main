#!/usr/bin/env node
// Writes the website's pages (site/) from the page fragments in
// site-src/pages/, site/config.js, site/pricing.json and
// legal/legal-status.json, and the files a site needs next to them:
//
//   site-src/pages/home.html          -> site/index.html
//   site-src/pages/how-it-works.html  -> site/how-it-works/index.html
//   site-src/pages/pricing.html       -> site/pricing/index.html
//   site-src/pages/faq.html           -> site/faq/index.html
//   site-src/pages/for-managers.html  -> site/for-managers/index.html
//   site-src/pages/support.html       -> site/support/index.html
//   site-src/pages/legal.html         -> site/legal/index.html
//   site-src/pages/not-found.html     -> site/404.html
//   (always)                          -> site/robots.txt, site/llms.txt
//   (only once config.js has siteUrl) -> site/sitemap.xml, site/CNAME
//
// The three legal documents (site/legal/<name>/index.html) and the redirect
// stubs at their old addresses are written by scripts/legal-pages.mjs, which
// takes the shared header, footer and head tags from here (renderPage) so
// every page of the site has the same chrome. The favicons and the share
// images are drawn by scripts/favicons.mjs and scripts/social-images.mjs.
// The Pages deploy publishes site/ whole, so any other file there (a page
// written by hand, a page the map no longer has, a stray screenshot) is
// named by both modes and refused by --check: nothing under site/ goes live
// unless a generator writes it, it is kept by hand in KEPT_FILES, or a page
// shows it.
//
// Run:  npm run site-pages                     -> writes the pages and files
//       node scripts/site-pages.mjs --check    -> writes nothing; exit 1 when an
//                                                output is missing, differs, or
//                                                exists although it must not,
//                                                or a file under site/ is
//                                                none of the site's
//
// A fragment is the inner HTML of <main id="main">: sections with .wrap, as
// the home page has them. It may use {{name}} (the value, HTML-escaped),
// {{#name}}...{{/name}} (when the value is truthy) and {{^name}}...{{/name}}
// (when falsy), nested as needed; an unknown name stops the run. The names
// are root ('./' on the home page, '../' one level down, '/' on the 404 page,
// which GitHub Pages serves at any depth), siteUrl, demoOpen, demoEndpoint,
// demoMailto, demoMailtoAddress, supportEmail, signupUrl and legalDraft.
// Every internal address in a fragment goes through root, so a page works
// at any depth and on any host.
//
// Everything that needs the site's absolute address (canonical, og:url,
// og:image, the sitemap, the robots.txt Sitemap line, CNAME, the JSON-LD
// item addresses) comes from SITE.siteUrl and is left out while it is '':
// nothing is ever written with an invented address. Both modes print which
// state the site is in; the state never changes the exit code (the tests and
// docs/launch-checklist.md carry it as a reported condition).
//
// The script refuses to write (exit 1) when a title or description is too
// long, missing or repeated, a fragment has not exactly one h1, a description
// is not in its page's text, config.js carries a reserved placeholder host
// (.example, .test, .invalid, .localhost, example.com/.org/.net), the
// business record is only partly filled, or an output carries a word that
// marks unfinished work (Vite, React, lorem, TODO, placeholder, example.com,
// .example, yourdomain, "Welcome to") or a pilot-dealer value. The script
// imports only node: modules and site/config.js.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const CONFIG_FILE = 'site/config.js';
export const PRICING_FILE = 'site/pricing.json';
export const STATUS_FILE = 'legal/legal-status.json';

export const SITE_NAME = 'Lot Current';
export const TITLE_SUFFIX = ' | Lot Current';
export const BRAND_TAGLINE = 'A Chrome extension for dealership salespeople';
export const LINE = 'You click Publish. Lot Current never does.';
export const FOOTER_LINE = 'Lot Current is not affiliated with Meta Platforms, Inc. "Facebook" and "Marketplace" are used only as the names of the places you post.';
export const THEME_COLOR = '#14532d';
export const SOCIAL = Object.freeze({ width: 1200, height: 630 });

// The pages, in the order of the site. kind: 'page' (a fragment in
// site-src/pages/), 'legal' (a Markdown document, written by
// scripts/legal-pages.mjs) or 'notFound' (site/404.html). title is without
// the brand (fullTitle adds it); h1 is null for a legal page (the Markdown's
// own heading); nav is the header label or null; crumb the breadcrumb label
// or null; social the share image's heading or null; script: whether the page
// loads site.js; sitemap: whether it is listed; jsonld: the structured-data
// nodes the page carries (home's Organization becomes LocalBusiness once
// config.js has the business's address).
const page = (p) => Object.freeze({ ...p, social: p.social ? Object.freeze(p.social) : null, jsonld: Object.freeze(p.jsonld) });
export const PAGES = Object.freeze([
  page({
    slug: 'home', path: '/', file: 'site/index.html', kind: 'page', source: 'site-src/pages/home.html',
    title: 'Used cars on Marketplace, from your website',
    description: 'Lot Current fills in the Facebook Marketplace vehicle listing from your dealership website, photos included; you check it and click Publish.',
    h1: 'Your used cars on Facebook Marketplace, from your website, in seconds.',
    nav: 'Home', crumb: null, social: { heading: 'Your used cars listed from your website, in seconds.' },
    script: true, sitemap: true, jsonld: ['Organization', 'WebSite', 'SoftwareApplication'],
  }),
  page({
    slug: 'how-it-works', path: '/how-it-works/', file: 'site/how-it-works/index.html', kind: 'page', source: 'site-src/pages/how-it-works.html',
    title: 'How it works',
    description: "Lot Current reads your website's used inventory, fills in the Marketplace form for each pre-owned car, and rescans to show what sold or changed price.",
    h1: 'How Lot Current works',
    nav: 'How it works', crumb: 'How it works', social: { heading: 'How it works: scan, fill, check, publish.' },
    script: false, sitemap: true, jsonld: ['BreadcrumbList'],
  }),
  page({
    slug: 'pricing', path: '/pricing/', file: 'site/pricing/index.html', kind: 'page', source: 'site-src/pages/pricing.html',
    title: 'Pricing',
    description: 'Lot Current is priced per rooftop per month, with a free pilot first; the planned prices are confirmed with you before any paid subscription starts.',
    h1: 'Pricing',
    nav: 'Pricing', crumb: 'Pricing', social: { heading: 'Pricing: per rooftop, per month, after a free pilot.' },
    script: true, sitemap: true, jsonld: ['BreadcrumbList'],
  }),
  page({
    slug: 'faq', path: '/faq/', file: 'site/faq/index.html', kind: 'page', source: 'site-src/pages/faq.html',
    title: 'Frequently asked questions',
    description: 'Straight answers about Lot Current: whether it is allowed on Facebook, what it reads, where your data is, and why you click Publish, never the tool.',
    h1: 'Frequently asked questions',
    nav: 'FAQ', crumb: 'FAQ', social: { heading: 'Questions, answered straight.' },
    script: false, sitemap: true, jsonld: ['BreadcrumbList', 'FAQPage'],
  }),
  page({
    slug: 'for-managers', path: '/for-managers/', file: 'site/for-managers/index.html', kind: 'page', source: 'site-src/pages/for-managers.html',
    title: 'For managers',
    description: 'The manager view will show who posted what, sold cars still listed and for how long, and price changes not yet updated, with a CSV of the same numbers.',
    h1: 'What managers see',
    nav: 'For managers', crumb: 'For managers', social: { heading: 'What managers see.' },
    script: false, sitemap: true, jsonld: ['BreadcrumbList'],
  }),
  page({
    slug: 'support', path: '/support/', file: 'site/support/index.html', kind: 'page', source: 'site-src/pages/support.html',
    title: 'Support',
    description: 'How to get help with Lot Current, what to send with a report, what support never asks for, and how to ask for your data to be exported or deleted.',
    h1: 'Support',
    nav: 'Support', crumb: 'Support', social: { heading: 'Support, and what we never ask for.' },
    script: false, sitemap: true, jsonld: ['BreadcrumbList'],
  }),
  page({
    slug: 'legal', path: '/legal/', file: 'site/legal/index.html', kind: 'page', source: 'site-src/pages/legal.html',
    title: 'Legal documents',
    description: 'The Lot Current Terms of Service, the Privacy Policy and the posting rules for salespeople, each on its own page.',
    h1: 'Legal documents',
    nav: null, crumb: 'Legal', social: { heading: 'Legal documents.' },
    script: false, sitemap: true, jsonld: ['BreadcrumbList'],
  }),
  page({
    slug: 'legal-terms', path: '/legal/terms/', file: 'site/legal/terms/index.html', kind: 'legal', source: 'legal/terms-of-service.md',
    title: 'Terms of service',
    description: 'The Terms of Service for the Lot Current browser extension and its related services, for the dealership that subscribes and the people it authorises.',
    h1: null,
    nav: null, crumb: 'Terms of service', social: { heading: 'Terms of service.' },
    script: false, sitemap: true, jsonld: ['BreadcrumbList'],
  }),
  page({
    slug: 'legal-privacy', path: '/legal/privacy/', file: 'site/legal/privacy/index.html', kind: 'legal', source: 'legal/privacy-policy.md',
    title: 'Privacy policy',
    description: 'The Lot Current Privacy Policy: what we collect, why, who processes it, how long we keep it and how to reach us.',
    h1: null,
    nav: null, crumb: 'Privacy policy', social: { heading: 'Privacy policy.' },
    script: false, sitemap: true, jsonld: ['BreadcrumbList'],
  }),
  page({
    slug: 'legal-posting-rules', path: '/legal/posting-rules/', file: 'site/legal/posting-rules/index.html', kind: 'legal', source: 'legal/posting-rules.md',
    title: 'Posting rules',
    description: 'The posting rules every salesperson reads before using Lot Current: you publish every post, pre-owned cars only, the website price, facts only.',
    h1: null,
    nav: null, crumb: 'Posting rules', social: { heading: 'Posting rules for salespeople.' },
    script: false, sitemap: true, jsonld: ['BreadcrumbList'],
  }),
  page({
    slug: 'not-found', path: '/404.html', file: 'site/404.html', kind: 'notFound', source: 'site-src/pages/not-found.html',
    title: 'Page not found',
    description: 'That address is not on the Lot Current website; the links on this page lead to the pages that exist.',
    h1: 'Page not found',
    nav: null, crumb: null, social: null,
    script: false, sitemap: false, jsonld: [],
  }),
]);

// The old addresses of the legal documents, kept working by a stub that
// sends the browser on to the new page (written by scripts/legal-pages.mjs).
export const REDIRECTS = Object.freeze([
  Object.freeze({ file: 'site/legal/terms.html', to: 'terms/', target: '/legal/terms/', label: 'Terms of service' }),
  Object.freeze({ file: 'site/legal/privacy.html', to: 'privacy/', target: '/legal/privacy/', label: 'Privacy policy' }),
  Object.freeze({ file: 'site/legal/posting-rules.html', to: 'posting-rules/', target: '/legal/posting-rules/', label: 'Posting rules' }),
]);

// The files under site/ that are neither a page of the map nor a stub: the
// ones kept by hand (the config, the pricing copy, the stylesheet, the
// script, the mark), the favicons scripts/favicons.mjs draws from the mark,
// and the index of the share images scripts/social-images.mjs draws (one
// site/social/<slug>.png per page with a social heading). Screenshots
// (scripts/screenshots.mjs) belong to the site while a page shows them.
export const KEPT_FILES = Object.freeze([CONFIG_FILE, PRICING_FILE, 'site/site.css', 'site/site.js', 'site/favicon.svg']);
export const FAVICON_FILES = Object.freeze(['site/favicon-32.png', 'site/apple-touch-icon.png', 'site/favicon.ico']);
export const SOCIAL_INDEX = 'site/social/images.json';
export const socialFile = (page) => `site/social/${page.slug}.png`;
// what an operating system leaves in a folder (.gitignore keeps them out of the repository, so never deployed)
const OS_FILES = /^(\.DS_Store|Thumbs\.db)$/;

export const NAV = Object.freeze(PAGES.filter((p) => p.nav));
export const LEGAL_PAGES = Object.freeze(PAGES.filter((p) => p.kind === 'legal'));
export const FRAGMENT_PAGES = Object.freeze(PAGES.filter((p) => p.kind !== 'legal'));
const bySlug = (slug) => PAGES.find((p) => p.slug === slug);

export const TITLE_MAX = 60;
export const DESCRIPTION_MAX = 155;

// Words that mark unfinished work, and the pilot dealer's values, which no
// output may carry (CLAUDE.md, "Build for any dealer").
export const FORBIDDEN = /\bVite\b|\bReact\b|lorem|TODO|placeholder|example\.com|\.example\b|yourdomain|Welcome to/i;
export const PILOT = /Waynesburg|Ron Lewis|Cranberry|Pleasant Hills|15370|\$\s?490\b|\bRoger\b|ronlewis/i;

// The two Content-Security-Policy variants. A page without site.js loads
// only its stylesheet and images; the JSON-LD block is data, not a script,
// so it needs no script-src.
export const NO_SCRIPT_CSP = "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'";
export function cspFor(page, site) {
  if (!page.script) return NO_SCRIPT_CSP;
  const formAction = page.slug === 'home' && site && site.demoMailto ? 'mailto:' : "'none'";
  return `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self' https://*.supabase.co; object-src 'none'; base-uri 'none'; form-action ${formAction}`;
}

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ENTITIES[c]);
// Inside a double-quoted attribute an apostrophe is plain text, so a
// description reads the same in the attribute and on the page.
const attr = (s) => String(s).replace(/[&<>"]/g, (c) => ENTITIES[c]);
// What a reader sees in a piece of HTML: tags gone (an inline tag joins its
// text to the words around it, a block tag separates), entities read back.
export const textOf = (html) => String(html)
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<\/?(a|b|strong|em|i|code|span|small)\b[^>]*>/gi, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (e) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' })[e])
  .replace(/\s+/g, ' ')
  .trim();

// ---------- the template syntax ----------

const TAG = /\{\{([#^/]?)([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

/**
 * {{name}} is the value, HTML-escaped ('' for false, null or undefined);
 * {{#name}}...{{/name}} is kept when the value is truthy (a list: non-empty);
 * {{^name}}...{{/name}} when it is falsy; blocks nest. Nothing else: no loops,
 * no partials, no raw output. An unknown name, an unclosed block or a stray
 * closing tag throws, even inside a block that is left out.
 */
export function render(template, vars) {
  const src = String(template);
  const value = (name) => {
    if (!Object.prototype.hasOwnProperty.call(vars || {}, name)) throw new Error(`template: unknown variable {{${name}}}`);
    return vars[name];
  };
  const truthy = (v) => (Array.isArray(v) ? v.length > 0 : Boolean(v));
  let pos = 0;
  const block = (closing) => {
    let out = '';
    for (;;) {
      TAG.lastIndex = pos;
      const m = TAG.exec(src);
      if (!m) {
        if (closing) throw new Error(`template: {{#${closing}}} is not closed`);
        out += src.slice(pos);
        pos = src.length;
        return out;
      }
      out += src.slice(pos, m.index);
      pos = m.index + m[0].length;
      const [, kind, name] = m;
      if (kind === '/') {
        if (name !== closing) throw new Error(closing ? `template: {{/${name}}} closes {{#${closing}}}` : `template: {{/${name}}} closes nothing`);
        return out;
      }
      if (kind === '#' || kind === '^') {
        const v = value(name);
        const inner = block(name);
        if (kind === '#' ? truthy(v) : !truthy(v)) out += inner;
        continue;
      }
      const v = value(name);
      out += escapeHtml(v === false || v === null || v === undefined ? '' : v);
    }
  };
  return block(null);
}

// ---------- config.js ----------

// A host nobody can serve: the reserved names of RFC 2606 (and .localhost).
export function isPlaceholderHost(host) {
  const h = String(host || '').trim().toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  return /(^|\.)(example|test|invalid|localhost)$/.test(h) || /(^|\.)example\.(com|org|net)$/.test(h);
}

const hostOfUrl = (u) => {
  try {
    return new URL(u).hostname;
  } catch {
    return '';
  }
};
const EMAIL = /^[^\s@<>"'()]+@[^\s@<>"'()/]+\.[^\s@<>"'()/]+$/;
export const BUSINESS_REQUIRED = Object.freeze(['name', 'streetAddress', 'addressLocality', 'addressRegion', 'postalCode', 'addressCountry']);
export const BUSINESS_OPTIONAL = Object.freeze(['legalName', 'telephone', 'email', 'url', 'openingHours', 'areaServed']);

const businessFilled = (business) => Boolean(business && BUSINESS_REQUIRED.every((k) => typeof business[k] === 'string' && business[k].trim()));

/**
 * Throws when config.js cannot be published as it is: a siteUrl that is not
 * '' or an https origin (no path, no trailing slash, no query) on a real
 * host; an inbox or endpoint on a placeholder host; a business record only
 * partly filled. Never guesses a value.
 */
export function validateSite(site) {
  if (!site || typeof site !== 'object') throw new Error(`${CONFIG_FILE}: SITE is not an object`);
  for (const key of ['siteUrl', 'demoEndpoint', 'demoMailto', 'supportEmail', 'signupUrl']) {
    if (typeof site[key] !== 'string') throw new Error(`${CONFIG_FILE}: ${key} must be a string ('' until the real value exists)`);
    if (site[key] !== site[key].trim()) throw new Error(`${CONFIG_FILE}: ${key} has spaces around it`);
  }
  if (site.siteUrl) {
    const u = site.siteUrl;
    const parsed = (() => {
      try {
        return new URL(u);
      } catch {
        return null;
      }
    })();
    if (!parsed || parsed.protocol !== 'https:' || parsed.origin !== u || parsed.username || parsed.password) {
      throw new Error(`${CONFIG_FILE}: siteUrl must be an https origin with no path, query or trailing slash (it is ${JSON.stringify(u)})`);
    }
    if (isPlaceholderHost(parsed.hostname)) throw new Error(`${CONFIG_FILE}: siteUrl is on a reserved placeholder host (${parsed.hostname}); leave it '' until the domain exists`);
  }
  if (site.demoEndpoint) {
    const host = hostOfUrl(site.demoEndpoint);
    if (!/^https:\/\//i.test(site.demoEndpoint) || !host) throw new Error(`${CONFIG_FILE}: demoEndpoint must be an https address or ''`);
    if (isPlaceholderHost(host)) throw new Error(`${CONFIG_FILE}: demoEndpoint is on a reserved placeholder host (${host}); leave it '' until the function is deployed`);
  }
  if (site.demoMailto) {
    const m = site.demoMailto.match(/^mailto:([^\s?]+)(\?.*)?$/);
    if (!m || !EMAIL.test(m[1])) throw new Error(`${CONFIG_FILE}: demoMailto must be 'mailto:<address>' or ''`);
    if (isPlaceholderHost(m[1].split('@')[1])) throw new Error(`${CONFIG_FILE}: demoMailto is on a reserved placeholder host (${m[1].split('@')[1]}); leave it '' until the inbox exists`);
  }
  if (site.supportEmail) {
    if (/^mailto:/i.test(site.supportEmail) || !EMAIL.test(site.supportEmail)) throw new Error(`${CONFIG_FILE}: supportEmail must be a plain address (no mailto:) or ''`);
    if (isPlaceholderHost(site.supportEmail.split('@')[1])) throw new Error(`${CONFIG_FILE}: supportEmail is on a reserved placeholder host (${site.supportEmail.split('@')[1]}); leave it '' until the inbox exists`);
  }
  if (site.signupUrl && /^https:\/\//i.test(site.signupUrl) && isPlaceholderHost(hostOfUrl(site.signupUrl))) {
    throw new Error(`${CONFIG_FILE}: signupUrl is on a reserved placeholder host; leave it '' until the manager view is hosted`);
  }
  const b = site.business;
  if (!b || typeof b !== 'object') throw new Error(`${CONFIG_FILE}: business must be an object (every field '' until the details exist)`);
  for (const key of [...BUSINESS_REQUIRED, ...BUSINESS_OPTIONAL]) {
    if (!(key in b)) throw new Error(`${CONFIG_FILE}: business.${key} is missing`);
    if (key === 'openingHours') {
      if (!Array.isArray(b[key]) || b[key].some((h) => typeof h !== 'string' || !h.trim())) throw new Error(`${CONFIG_FILE}: business.openingHours must be a list of schema.org strings such as 'Mo-Fr 09:00-17:00'`);
    } else if (typeof b[key] !== 'string') {
      throw new Error(`${CONFIG_FILE}: business.${key} must be a string`);
    }
  }
  const filled = BUSINESS_REQUIRED.filter((k) => b[k].trim());
  if (filled.length && filled.length < BUSINESS_REQUIRED.length) {
    const missing = BUSINESS_REQUIRED.filter((k) => !b[k].trim());
    throw new Error(`${CONFIG_FILE}: business is partly filled (missing ${missing.join(', ')}); fill every required field or none`);
  }
  if (!filled.length && BUSINESS_OPTIONAL.some((k) => (Array.isArray(b[k]) ? b[k].length : b[k].trim()))) {
    throw new Error(`${CONFIG_FILE}: business has optional fields but no name or address; fill the required fields or clear it`);
  }
  if (b.url && (!/^https:\/\//i.test(b.url) || !hostOfUrl(b.url) || isPlaceholderHost(hostOfUrl(b.url)))) throw new Error(`${CONFIG_FILE}: business.url must be an https address on a real host or ''`);
  if (b.email && (!EMAIL.test(b.email) || isPlaceholderHost(b.email.split('@')[1]))) throw new Error(`${CONFIG_FILE}: business.email must be a plain address on a real host or ''`);
}

// The one line both modes print: which state the site is in. Never changes the exit code.
export const siteUrlReport = (site) => (site.siteUrl
  ? `siteUrl is ${site.siteUrl}: canonical, og:url, og:image, sitemap.xml and CNAME are written`
  : 'siteUrl is not set: the site is not ready to publish (no canonical, og:url, og:image, sitemap.xml or CNAME is written; docs/launch-checklist.md)');

// ---------- the page map helpers ----------

export const draftMark = (page, legalDraft) => (page.kind === 'legal' && legalDraft ? ' (draft)' : '');

let statusDraft;
// legal/legal-status.json's draft flag, read once, for callers that have no
// context of their own (fullTitle(page) on a legal page). Unreadable: draft.
function defaultLegalDraft() {
  if (statusDraft === undefined) {
    try {
      statusDraft = JSON.parse(readFileSync(join(ROOT, STATUS_FILE), 'utf8')).draft === true;
    } catch {
      statusDraft = true;
    }
  }
  return statusDraft;
}

/** The <title>: the page's title, ' (draft)' on a legal page while the texts are drafts, then the brand. */
export function fullTitle(page, legalDraft = page.kind === 'legal' ? defaultLegalDraft() : false) {
  return page.title + draftMark(page, legalDraft) + TITLE_SUFFIX;
}

/** The relative path from the page to site/: './', '../', '../../'; '/' on the 404 page, which is served at any depth. */
export function rootFor(page) {
  if (page.kind === 'notFound') return '/';
  const depth = page.path.split('/').filter(Boolean).length;
  return depth ? '../'.repeat(depth) : './';
}

export const socialAlt = (page) => (page.social ? `The Lot Current check mark and name, with the words "${page.social.heading}" and "${LINE}"` : '');

/** The pages above this one in the address, home first (the breadcrumb trail without the page itself). */
export function ancestorsOf(page) {
  if (!page.crumb) return [];
  return PAGES.filter((p) => p !== page && p.kind !== 'notFound' && page.path.startsWith(p.path) && (p.path === '/' || p.crumb))
    .sort((a, b) => a.path.length - b.path.length);
}

// An address relative to the page: root + the path without its leading slash.
const hrefFor = (root, path) => root + path.replace(/^\//, '');

// ---------- structured data ----------

/** The article.qa items of a body: the h3 as the question, the rest as the answer, both as plain text. */
export function faqItems(bodyHtml) {
  const out = [];
  for (const m of String(bodyHtml).matchAll(/<article class="qa"[^>]*>([\s\S]*?)<\/article>/g)) {
    const h = m[1].match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/);
    if (!h) throw new Error('an article.qa has no h3 question');
    const question = textOf(h[1]);
    const answer = textOf(m[1].replace(h[0], ' '));
    if (!question || !answer) throw new Error(`the question "${question}" has no answer`);
    out.push({ question, answer });
  }
  return out;
}

function organizationNode(ctx) {
  const { site } = ctx;
  const b = site.business;
  if (businessFilled(b)) {
    const node = { '@type': 'LocalBusiness', name: b.name.trim() };
    if (b.legalName.trim()) node.legalName = b.legalName.trim();
    const url = b.url.trim() || site.siteUrl;
    if (url) node.url = url;
    node.address = {
      '@type': 'PostalAddress',
      streetAddress: b.streetAddress.trim(),
      addressLocality: b.addressLocality.trim(),
      addressRegion: b.addressRegion.trim(),
      postalCode: b.postalCode.trim(),
      addressCountry: b.addressCountry.trim(),
    };
    if (b.telephone.trim()) node.telephone = b.telephone.trim();
    if (b.email.trim()) node.email = b.email.trim();
    if (b.openingHours.length) node.openingHours = b.openingHours.map((h) => h.trim());
    if (b.areaServed.trim()) node.areaServed = b.areaServed.trim();
    return node;
  }
  const node = { '@type': 'Organization', name: SITE_NAME };
  if (site.siteUrl) {
    node.url = site.siteUrl;
    node.logo = `${site.siteUrl}/apple-touch-icon.png`;
  }
  return node;
}

/**
 * The page's JSON-LD graph, or null on the 404 page: home carries
 * Organization (LocalBusiness once config.js has the business), WebSite and
 * SoftwareApplication; every page with a crumb a BreadcrumbList; the FAQ page
 * a FAQPage built from its article.qa items. Addresses only when siteUrl is
 * set; a price only when pricing.json is no longer a hypothesis; never a
 * rating, review, phone, address or opening hours that is not in config.js.
 */
export function jsonLdFor(page, ctx, bodyHtml = '') {
  const { site, pricing } = ctx;
  const nodes = [];
  if (page.slug === 'home') {
    nodes.push(organizationNode(ctx));
    const webSite = { '@type': 'WebSite', name: SITE_NAME };
    if (site.siteUrl) webSite.url = site.siteUrl;
    nodes.push(webSite);
    const app = { '@type': 'SoftwareApplication', name: SITE_NAME, applicationCategory: 'BusinessApplication', operatingSystem: 'Chrome', description: page.description };
    if (site.siteUrl) app.url = site.siteUrl;
    if (pricing && pricing.hypothesis === false && typeof pricing.perRooftopMonthly === 'number' && typeof pricing.currency === 'string') {
      app.offers = { '@type': 'Offer', price: pricing.perRooftopMonthly, priceCurrency: pricing.currency };
    }
    nodes.push(app);
  }
  if (page.crumb) {
    const trail = [...ancestorsOf(page), page];
    nodes.push({
      '@type': 'BreadcrumbList',
      itemListElement: trail.map((p, i) => {
        const item = { '@type': 'ListItem', position: i + 1, name: p.path === '/' ? 'Home' : p.crumb };
        if (site.siteUrl) item.item = site.siteUrl + p.path;
        return item;
      }),
    });
  }
  if (page.slug === 'faq') {
    const items = faqItems(bodyHtml);
    if (!items.length) throw new Error('the FAQ page has no article.qa items');
    nodes.push({
      '@type': 'FAQPage',
      mainEntity: items.map(({ question, answer }) => ({ '@type': 'Question', name: question, acceptedAnswer: { '@type': 'Answer', text: answer } })),
    });
  }
  return nodes.length ? { '@context': 'https://schema.org', '@graph': nodes } : null;
}

// JSON inside a <script> block: angle brackets and ampersands as escapes, so no text can close the block.
const jsonForScript = (data) => JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');

// ---------- the document ----------

/**
 * The whole document around a rendered body: head (meta, policy, title,
 * description, canonical and share tags gated on siteUrl, favicons,
 * stylesheet, JSON-LD), header with the site nav, the breadcrumb trail, the
 * body inside <main id="main">, the footer, and site.js on script pages.
 * ctx: { root (the page's relative root; rootFor(page) when left out), site,
 * pricing, legalDraft }.
 */
export function renderPage(page, bodyHtml, ctx) {
  if (!page || !PAGES.includes(page)) throw new Error('renderPage: not a page of the map');
  if (!ctx || !ctx.site) throw new Error('renderPage: ctx.site is missing');
  const root = ctx.root || rootFor(page);
  const site = ctx.site;
  const legalDraft = Boolean(ctx.legalDraft);
  const title = page.title + draftMark(page, legalDraft);
  const notFound = page.kind === 'notFound';
  const comment = page.kind === 'legal'
    ? [`<!-- Written by scripts/legal-pages.mjs from ${page.source} and ${STATUS_FILE}. Change those and run`, '     npm run legal-pages; an edit made here is lost at the next run, and npm test fails until then. -->']
    : [`<!-- Written by scripts/site-pages.mjs from ${page.source} and ${CONFIG_FILE}. Change those and run`, '     npm run site-pages; an edit made here is lost at the next run, and npm test fails until then. -->'];
  const head = [
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    '  <meta name="color-scheme" content="light dark">',
    `  <meta name="theme-color" content="${THEME_COLOR}">`,
    `  <meta http-equiv="Content-Security-Policy" content="${cspFor(page, site)}">`,
    `  <title>${attr(title)}${TITLE_SUFFIX}</title>`,
    `  <meta name="description" content="${attr(page.description)}">`,
  ];
  // A legal text still marked draft (legal/legal-status.json) carries blanks
  // in brackets and notes for the attorney: readable, never indexed.
  if (notFound || (page.kind === 'legal' && legalDraft)) head.push('  <meta name="robots" content="noindex">');
  if (site.siteUrl && !notFound) head.push(`  <link rel="canonical" href="${attr(site.siteUrl + page.path)}">`);
  head.push(
    `  <link rel="icon" href="${root}favicon.svg" type="image/svg+xml">`,
    `  <link rel="icon" href="${root}favicon-32.png" type="image/png" sizes="32x32">`,
    `  <link rel="apple-touch-icon" href="${root}apple-touch-icon.png">`,
    `  <link rel="stylesheet" href="${root}site.css">`,
  );
  if (!notFound) {
    head.push(
      '  <meta property="og:type" content="website">',
      `  <meta property="og:site_name" content="${SITE_NAME}">`,
      `  <meta property="og:title" content="${attr(title)}">`,
      `  <meta property="og:description" content="${attr(page.description)}">`,
    );
    if (site.siteUrl) {
      head.push(`  <meta property="og:url" content="${attr(site.siteUrl + page.path)}">`);
      if (page.social) {
        head.push(
          `  <meta property="og:image" content="${attr(`${site.siteUrl}/social/${page.slug}.png`)}">`,
          `  <meta property="og:image:width" content="${SOCIAL.width}">`,
          `  <meta property="og:image:height" content="${SOCIAL.height}">`,
          `  <meta property="og:image:alt" content="${attr(socialAlt(page))}">`,
        );
      }
    }
    head.push(
      '  <meta name="twitter:card" content="summary_large_image">',
      `  <meta name="twitter:title" content="${attr(title)}">`,
      `  <meta name="twitter:description" content="${attr(page.description)}">`,
    );
    const data = jsonLdFor(page, ctx, bodyHtml);
    if (data) head.push(`  <script type="application/ld+json">${jsonForScript(data)}</script>`);
  }
  const navItems = NAV.map((p) => `          <li><a href="${hrefFor(root, p.path)}"${p === page ? ' aria-current="page"' : ''}>${escapeHtml(p.nav)}</a></li>`);
  const crumbs = page.crumb
    ? [
      '  <nav class="crumbs" aria-label="Breadcrumb">',
      '    <div class="wrap">',
      '      <ol>',
      ...ancestorsOf(page).map((p) => `        <li><a href="${hrefFor(root, p.path)}">${escapeHtml(p.path === '/' ? 'Home' : p.crumb)}</a></li>`),
      `        <li aria-current="page">${escapeHtml(page.crumb)}</li>`,
      '      </ol>',
      '    </div>',
      '  </nav>',
      '',
    ]
    : [];
  const body = String(bodyHtml).replace(/^\n+|\s+$/g, '');
  return [
    '<!doctype html>',
    ...comment,
    `<html lang="en" data-root="${root}">`,
    '<head>',
    ...head,
    '</head>',
    '<body>',
    '  <a class="skip" href="#main">Skip to content</a>',
    '',
    '  <header class="top">',
    '    <div class="wrap">',
    `      <a class="brand" href="${root}">${SITE_NAME} <small>${BRAND_TAGLINE}</small></a>`,
    '      <nav aria-label="Site">',
    '        <ul>',
    ...navItems,
    '        </ul>',
    '      </nav>',
    '    </div>',
    '  </header>',
    '',
    ...crumbs,
    '  <main id="main">',
    body,
    '  </main>',
    '',
    '  <footer>',
    '    <div class="wrap">',
    '      <ul>',
    `        <li><a href="${root}legal/terms/">Terms of service</a></li>`,
    `        <li><a href="${root}legal/privacy/">Privacy policy</a></li>`,
    `        <li><a href="${root}legal/posting-rules/">Posting rules</a></li>`,
    '      </ul>',
    `      <p>${FOOTER_LINE}</p>`,
    '    </div>',
    '  </footer>',
    ...(page.script ? [`  <script type="module" src="${root}site.js"></script>`] : []),
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** Throws when an output carries a word that marks unfinished work, or a pilot-dealer value. */
export function assertClean(content, name) {
  const f = String(content).match(FORBIDDEN);
  if (f) throw new Error(`${name} contains "${f[0]}": no placeholder text, framework name or invented address may ship`);
  const p = String(content).match(PILOT);
  if (p) throw new Error(`${name} contains "${p[0]}": the pilot dealer is a fixture, not a default`);
}

/** Throws when a page's title or description breaks the rules, or two pages share one. */
export function validatePages(pages = PAGES, legalDraft = true) {
  const titles = new Map();
  const descriptions = new Map();
  for (const p of pages) {
    const title = fullTitle(p, legalDraft);
    if (!p.title || !p.title.trim()) throw new Error(`${p.slug}: no title`);
    if (title.length > TITLE_MAX) throw new Error(`${p.slug}: the title "${title}" is ${title.length} characters; at most ${TITLE_MAX}`);
    if (!p.description || !p.description.trim()) throw new Error(`${p.slug}: no description`);
    if (p.description.length > DESCRIPTION_MAX) throw new Error(`${p.slug}: the description is ${p.description.length} characters; at most ${DESCRIPTION_MAX}`);
    if (/[<>"]/.test(p.description) || /[<>"]/.test(p.title)) throw new Error(`${p.slug}: a title or description with markup in it`);
    const t = title.toLowerCase();
    const d = p.description.toLowerCase();
    if (titles.has(t)) throw new Error(`${p.slug} and ${titles.get(t)} share the title "${title}"`);
    if (descriptions.has(d)) throw new Error(`${p.slug} and ${descriptions.get(d)} share a description`);
    titles.set(t, p.slug);
    descriptions.set(d, p.slug);
  }
}

// ---------- the files next to the pages ----------

export function robotsTxt(site) {
  const lines = ['User-agent: *', 'Allow: /'];
  if (site.siteUrl) lines.push(`Sitemap: ${site.siteUrl}/sitemap.xml`);
  return lines.join('\n') + '\n';
}

// The pages search engines and llms.txt are pointed at: the map's sitemap
// pages, less the legal texts while they are drafts (they say noindex then).
export const listedPages = (legalDraft = defaultLegalDraft()) => PAGES.filter((p) => p.sitemap && !(p.kind === 'legal' && legalDraft));

export function sitemapXml(site, legalDraft = defaultLegalDraft()) {
  if (!site.siteUrl) throw new Error('sitemap.xml needs siteUrl');
  const urls = listedPages(legalDraft).map((p) => `  <url><loc>${attr(site.siteUrl + p.path)}</loc></url>`);
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', ...urls, '</urlset>', ''].join('\n');
}

export const cnameTxt = (site) => {
  if (!site.siteUrl) throw new Error('CNAME needs siteUrl');
  return new URL(site.siteUrl).hostname + '\n';
};

export const LLMS_SUMMARY = "Lot Current is a Chrome extension for dealership salespeople: it fills in the Facebook Marketplace vehicle listing from the dealership's own website, photos included, and a person checks it and clicks Publish. Lot Current never publishes anything itself.";
export const LLMS_NOTE = 'Lot Current is not affiliated with Meta Platforms, Inc.; "Facebook" and "Marketplace" are used only as the names of the places salespeople post. The prices on the pricing page are planned prices, confirmed with each dealership before any paid subscription starts.';

// The llmstxt.org shape: an H1, a blockquote summary, a paragraph, then H2
// sections of "- [name](url): description" lines. url is the absolute
// address once siteUrl is set, the path until then.
export function llmsTxt(site, legalDraft = defaultLegalDraft()) {
  const line = (p) => `- [${p.nav || p.title}](${site.siteUrl ? site.siteUrl + p.path : p.path}): ${p.description}`;
  const listed = listedPages(legalDraft);
  return [
    `# ${SITE_NAME}`,
    '',
    `> ${LLMS_SUMMARY}`,
    '',
    LLMS_NOTE,
    '',
    '## Pages',
    '',
    ...listed.filter((p) => !p.path.startsWith('/legal/')).map(line),
    '',
    '## Legal',
    '',
    ...listed.filter((p) => p.path.startsWith('/legal/')).map(line),
    '',
  ].join('\n');
}

// ---------- reading the inputs ----------

export function readStatus(text) {
  let status;
  try {
    status = JSON.parse(text);
  } catch (e) {
    throw new Error(`${STATUS_FILE} is not JSON (${e.message})`);
  }
  if (!status || typeof status.draft !== 'boolean') throw new Error(`${STATUS_FILE} needs "draft": true or false`);
  return { draft: status.draft };
}

/**
 * The inputs under a repository root: config.js (validated), pricing.json
 * and the draft flag. ctx.dir is that root; the per-page root is added by
 * buildSite. config.js is imported fresh each time its file changes.
 */
export async function readContext(root = ROOT) {
  const configPath = join(root, CONFIG_FILE);
  if (!existsSync(configPath)) throw new Error(`${CONFIG_FILE} is missing`);
  const configText = readFileSync(configPath, 'utf8');
  // keyed by its content, so a changed config.js is read again and an unchanged one is not re-evaluated
  const mod = await import(`${pathToFileURL(configPath).href}?v=${createHash('sha1').update(configText).digest('hex')}`);
  if (!mod.SITE) throw new Error(`${CONFIG_FILE} exports no SITE`);
  const site = mod.SITE;
  validateSite(site);
  assertClean(configText, CONFIG_FILE);
  let pricing;
  try {
    pricing = JSON.parse(readFileSync(join(root, PRICING_FILE), 'utf8'));
  } catch (e) {
    throw new Error(`${PRICING_FILE} could not be read (${e.message})`);
  }
  if (!pricing || typeof pricing.hypothesis !== 'boolean') throw new Error(`${PRICING_FILE} needs "hypothesis": true or false`);
  const { draft } = readStatus(readFileSync(join(root, STATUS_FILE), 'utf8'));
  return { dir: root, site, pricing, legalDraft: draft };
}

/** The variables a fragment may use. */
export function templateVars(page, ctx) {
  const { site } = ctx;
  return {
    root: rootFor(page),
    siteUrl: site.siteUrl,
    demoOpen: Boolean(site.demoEndpoint || site.demoMailto),
    demoEndpoint: site.demoEndpoint,
    demoMailto: site.demoMailto,
    demoMailtoAddress: site.demoMailto.replace(/^mailto:/, '').replace(/\?.*$/, ''),
    supportEmail: site.supportEmail,
    signupUrl: site.signupUrl,
    legalDraft: Boolean(ctx.legalDraft),
  };
}

/** One fragment page as a whole document; throws when it cannot be written. */
export function renderFragmentPage(page, fragment, ctx) {
  const body = render(fragment, templateVars(page, ctx));
  const h1s = (body.match(/<h1\b/g) || []).length;
  if (h1s !== 1) throw new Error(`${page.source} has ${h1s} <h1> elements; exactly one`);
  const html = renderPage(page, body, { ...ctx, root: rootFor(page) });
  const text = textOf(html.replace(/<head>[\s\S]*?<\/head>/, ' '));
  if (!text.includes(page.description)) throw new Error(`${page.source}: the description is not in the page's text, word for word`);
  if (page.h1) {
    const h1 = textOf((html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/) || [, ''])[1]);
    if (h1 !== page.h1) throw new Error(`${page.source}: the h1 is "${h1}", the map says "${page.h1}"`);
  }
  if (/<script\b(?![^>]*type="application\/ld\+json")(?![^>]*\bsrc="[^"]*site\.js")/i.test(html)) throw new Error(`${page.source} has a script that is neither the JSON-LD block nor site.js`);
  if (/<style\b|\sstyle="|\son[a-z]+="/i.test(body)) throw new Error(`${page.source} has an inline style or event handler, which the Content-Security-Policy blocks`);
  for (const m of body.matchAll(/<img\b([^>]*)>/gi)) {
    const a = m[1];
    if (!/\balt="/.test(a) || !/\bwidth="\d+"/.test(a) || !/\bheight="\d+"/.test(a)) throw new Error(`${page.source}: an image without alt, width and height: <img${a.slice(0, 60)}>`);
  }
  assertClean(html, page.file);
  return html;
}

/**
 * Every output as it would be written now, and the files that must not
 * exist in this state. Throws before anything is written when one of them
 * cannot be.
 */
export function buildSite(ctx) {
  validatePages(PAGES, ctx.legalDraft);
  const files = [];
  for (const p of FRAGMENT_PAGES) {
    const fragment = readFileSync(join(ctx.dir, p.source), 'utf8');
    files.push({ file: p.file, content: renderFragmentPage(p, fragment, ctx) });
  }
  files.push({ file: 'site/robots.txt', content: robotsTxt(ctx.site) });
  files.push({ file: 'site/llms.txt', content: llmsTxt(ctx.site, ctx.legalDraft) });
  const remove = [];
  if (ctx.site.siteUrl) {
    files.push({ file: 'site/sitemap.xml', content: sitemapXml(ctx.site, ctx.legalDraft) });
    files.push({ file: 'site/CNAME', content: cnameTxt(ctx.site) });
  } else {
    remove.push('site/sitemap.xml', 'site/CNAME');
  }
  for (const f of files) assertClean(f.content, f.file);
  return { files, remove };
}

/** The outputs that are missing, differ, or exist although they must not: [{ file, why }] as strings "file: why". */
export function staleFiles(ctx) {
  const { files, remove } = buildSite(ctx);
  const out = [];
  for (const { file, content } of files) {
    const full = join(ctx.dir, file);
    if (!existsSync(full)) out.push(`${file} is missing`);
    else if (readFileSync(full, 'utf8') !== content) out.push(`${file} is not what the sources make`);
  }
  for (const file of remove) if (existsSync(join(ctx.dir, file))) out.push(`${file} exists although siteUrl is not set`);
  return out;
}

// every file under rel (a folder of dir), as a path relative to dir
function filesUnder(dir, rel) {
  if (!existsSync(join(dir, rel))) return [];
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? filesUnder(dir, `${rel}/${d.name}`) : OS_FILES.test(d.name) ? [] : [`${rel}/${d.name}`]));
}

/**
 * The files under site/ that are none of the site's: no generator writes
 * them (this one, scripts/legal-pages.mjs, favicons, social-images), they
 * are not kept by hand (KEPT_FILES), and no page shows them. The deploy
 * publishes site/ whole, so each would go live with no check reading it.
 */
export function strayFiles(ctx, built = buildSite(ctx)) {
  const shown = built.files.flatMap(({ file, content }) => [...content.matchAll(/\bsrc="([^":]+)"/g)]
    .map((m) => (m[1].startsWith('/') ? `site${m[1]}` : posix.normalize(posix.join(posix.dirname(file), m[1])))));
  const known = new Set([
    ...built.files.map((f) => f.file), ...built.remove,
    ...PAGES.map((p) => p.file), ...REDIRECTS.map((r) => r.file),
    ...KEPT_FILES, ...FAVICON_FILES, SOCIAL_INDEX, ...PAGES.filter((p) => p.social).map(socialFile),
    ...shown,
  ]);
  return filesUnder(ctx.dir, 'site').filter((file) => !known.has(file));
}
export const strayAdvice = (file) => `${file} is not part of the site (no generator writes it, it is not kept by hand and no page shows it), so the deploy would publish it unchecked: delete it, or add it to the site map in scripts/site-pages.mjs`;

/** Writes every output and removes the files that must not exist; answers what it did. */
export function writeSite(ctx) {
  const { files, remove } = buildSite(ctx);
  const done = [];
  for (const { file, content } of files) {
    mkdirSync(dirname(join(ctx.dir, file)), { recursive: true });
    writeFileSync(join(ctx.dir, file), content);
    done.push(`wrote ${file}`);
  }
  for (const file of remove) {
    if (existsSync(join(ctx.dir, file))) {
      rmSync(join(ctx.dir, file));
      done.push(`removed ${file} (siteUrl is not set)`);
    }
  }
  return done;
}

export const USAGE = [
  'Usage: npm run site-pages              write the pages, robots.txt, llms.txt (and sitemap.xml, CNAME once siteUrl is set)',
  '       node scripts/site-pages.mjs --check',
  '                                       write nothing; exit 1 when an output is missing, differs, or exists although it must not,',
  '                                       or a file under site/ is none of the site\'s (no generator writes it, it is not kept',
  '                                       by hand, no page shows it): the deploy publishes site/ whole',
  '',
  ...FRAGMENT_PAGES.map((p) => `  ${p.source.padEnd(32)}-> ${p.file}`),
  '  (always)                        -> site/robots.txt, site/llms.txt',
  '  (once config.js has siteUrl)    -> site/sitemap.xml, site/CNAME',
  '',
  'site/config.js holds the one address and the inboxes (siteUrl, demoEndpoint,',
  'demoMailto, supportEmail, signupUrl, business). While siteUrl is \'\' nothing',
  'absolute is written and the script reports that the site is not ready to',
  'publish; set it, run this and npm run legal-pages, and commit (docs/website.md).',
  'The legal documents and their redirect stubs are written by npm run legal-pages.',
];

export async function main(argv, io = { log: (s) => console.log(s), error: (s) => console.error(s) }, root = ROOT) {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.log(USAGE.join('\n'));
    return 0;
  }
  const unknown = argv.find((a) => a !== '--check');
  if (unknown) {
    io.error(`site-pages: unknown option ${unknown}\n${USAGE.join('\n')}`);
    return 2;
  }
  try {
    const ctx = await readContext(root);
    io.log(siteUrlReport(ctx.site));
    if (argv.includes('--check')) {
      const stale = staleFiles(ctx);
      const stray = strayFiles(ctx);
      for (const s of stale) io.error(`${s}: run npm run site-pages`);
      for (const file of stray) io.error(strayAdvice(file));
      if (!stale.length && !stray.length) io.log('The website pages match site-src/, site/config.js, site/pricing.json and legal/legal-status.json.');
      return stale.length || stray.length ? 1 : 0;
    }
    for (const line of writeSite(ctx)) io.log(line);
    // a stray file is never deleted here (it may be someone's work): it is named, and the run fails until it goes
    const stray = strayFiles(ctx);
    for (const file of stray) io.error(strayAdvice(file));
    return stray.length ? 1 : 0;
  } catch (e) {
    io.error(`site-pages: ${e.message}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exitCode = await main(process.argv.slice(2));
