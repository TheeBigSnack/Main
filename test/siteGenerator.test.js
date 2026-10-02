// The website generator (scripts/site-pages.mjs): the page map, the template
// syntax, the document it writes around each page in both siteUrl states and
// both demo-form states, the structured data, the files next to the pages
// (robots.txt, llms.txt, sitemap.xml, CNAME), config.js's rules, what it
// refuses to write, and --check against a temp root. The committed pages are
// what the sources make now, whether site/config.js has the site's address
// or not; FIXTURE_URL, a subdomain of the business's own domain, stands in for
// another address here only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PAGES, REDIRECTS, NAV, LEGAL_PAGES, FRAGMENT_PAGES, SITE_NAME, TITLE_SUFFIX, FOOTER_LINE, BRAND_TAGLINE, LINE, THEME_COLOR, NO_SCRIPT_CSP, FORBIDDEN, PILOT,
  TITLE_MAX, DESCRIPTION_MAX, CONFIG_FILE, PRICING_FILE, STATUS_FILE, USAGE,
  fullTitle, rootFor, cspFor, render, renderPage, jsonLdFor, socialAlt, faqItems, ancestorsOf, textOf, escapeHtml,
  robotsTxt, sitemapXml, llmsTxt, listedPages, cnameTxt, isPlaceholderHost, validateSite, validatePages, siteUrlReport, templateVars, renderFragmentPage,
  readContext, buildSite, staleFiles, writeSite, assertClean, main,
  strayFiles, strayAdvice, KEPT_FILES, FAVICON_FILES, SOCIAL_INDEX, socialFile,
} from '../scripts/site-pages.mjs';
import { FILES as FAVICONS, SOURCE as FAVICON_SOURCE } from '../scripts/favicons.mjs';
import { DIR as SOCIAL_DIR, IMAGES_JSON } from '../scripts/social-images.mjs';
import { SITE } from '../site/config.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(join(root, rel), 'utf8');
const pricing = JSON.parse(read(PRICING_FILE));
const legalDraft = JSON.parse(read(STATUS_FILE)).draft;

// A fixture host for the tests only: not one of the reserved placeholder
// names (which the generator refuses), and never written anywhere but here.
const FIXTURE_URL = 'https://fixture.lotcurrent.com';
const EMPTY_BUSINESS = { name: '', legalName: '', streetAddress: '', addressLocality: '', addressRegion: '', postalCode: '', addressCountry: '', telephone: '', email: '', url: '', openingHours: [], areaServed: '' };
const BUSINESS = { ...EMPTY_BUSINESS, name: 'Lot Current', legalName: 'Lot Current LLC', streetAddress: '1 Main Street', addressLocality: 'Springfield', addressRegion: 'PA', postalCode: '19064', addressCountry: 'US', telephone: '+1-555-010-0100', email: 'hello@fixture.lotcurrent.com', openingHours: ['Mo-Fr 09:00-17:00'], areaServed: 'Pennsylvania' };
const base = { siteUrl: '', demoEndpoint: '', demoMailto: '', supportEmail: '', signupUrl: '', business: { ...EMPTY_BUSINESS } };
const ctxOf = (site = {}, extra = {}) => ({ dir: root, site: { ...base, ...site }, pricing, legalDraft, ...extra });
const page = (slug) => PAGES.find((p) => p.slug === slug);
const between = (html, open, close) => {
  const start = html.indexOf(open);
  return start < 0 ? '' : html.slice(start, html.indexOf(close, start) + close.length);
};
// a value inside a double-quoted attribute, as the generator writes it (an apostrophe stays)
const attr = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const jsonLdOf = (html) => {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  return blocks.length ? blocks.map((m) => JSON.parse(m[1])) : [];
};

test('the page map: every address, file and kind as planned, titles unique and short, descriptions unique and short, one of each', () => {
  assert.deepEqual(PAGES.map((p) => p.path), ['/', '/how-it-works/', '/pricing/', '/faq/', '/for-managers/', '/support/', '/legal/', '/legal/terms/', '/legal/privacy/', '/legal/posting-rules/', '/404.html']);
  assert.deepEqual(PAGES.map((p) => p.slug), ['home', 'how-it-works', 'pricing', 'faq', 'for-managers', 'support', 'legal', 'legal-terms', 'legal-privacy', 'legal-posting-rules', 'not-found']);
  for (const p of PAGES) {
    assert.ok(Object.isFrozen(p), `${p.slug} is frozen`);
    assert.deepEqual(Object.keys(p).sort(), ['crumb', 'description', 'file', 'h1', 'jsonld', 'kind', 'nav', 'path', 'script', 'sitemap', 'slug', 'social', 'source', 'title'].sort(), `${p.slug}: the entry's fields`);
    assert.ok(['page', 'legal', 'notFound'].includes(p.kind));
    assert.equal(p.file, p.kind === 'notFound' ? 'site/404.html' : `site${p.path}index.html`, `${p.slug}: the file is the directory index of its address`);
    assert.equal(p.source, p.kind === 'legal' ? p.source : `site-src/pages/${p.slug}.html`);
    assert.ok(existsSync(join(root, p.source)), `${p.source} exists`);
    assert.ok(existsSync(join(root, p.file)), `${p.file} exists (npm run site-pages / npm run legal-pages)`);
    const title = fullTitle(p);
    assert.ok(title.endsWith(TITLE_SUFFIX) && title.length <= TITLE_MAX, `${p.slug}: "${title}" (${title.length})`);
    assert.ok(p.description.length > 0 && p.description.length <= DESCRIPTION_MAX, `${p.slug}: the description is ${p.description.length} characters`);
    assert.equal(p.kind === 'legal', p.h1 === null, `${p.slug}: h1 is null only on a legal page`);
    assert.equal(typeof p.script, 'boolean');
    assert.equal(p.sitemap, p.kind !== 'notFound');
    assert.equal(p.social === null, p.kind === 'notFound', `${p.slug}: a share image on every page but 404`);
  }
  assert.equal(new Set(PAGES.map((p) => fullTitle(p).toLowerCase())).size, PAGES.length, 'titles are unique');
  assert.equal(new Set(PAGES.map((p) => p.description.toLowerCase())).size, PAGES.length, 'descriptions are unique');
  assert.doesNotThrow(() => validatePages(PAGES, true));
  assert.doesNotThrow(() => validatePages(PAGES, false));
  assert.deepEqual(NAV.map((p) => p.nav), ['Home', 'How it works', 'Pricing', 'FAQ', 'For managers', 'Support']);
  assert.deepEqual(LEGAL_PAGES.map((p) => p.slug), ['legal-terms', 'legal-privacy', 'legal-posting-rules']);
  assert.equal(FRAGMENT_PAGES.length + LEGAL_PAGES.length, PAGES.length);
  assert.deepEqual(REDIRECTS.map((r) => [r.file, r.to, r.target]), [
    ['site/legal/terms.html', 'terms/', '/legal/terms/'], ['site/legal/privacy.html', 'privacy/', '/legal/privacy/'], ['site/legal/posting-rules.html', 'posting-rules/', '/legal/posting-rules/'],
  ]);
  for (const r of REDIRECTS) assert.ok(PAGES.some((p) => p.path === r.target), `${r.target} is a page`);
  // the home title keeps "Facebook" out of the tab (the brand is last) while the h1 names the place
  assert.equal(fullTitle(page('home')), 'Used cars on Marketplace, from your website | Lot Current');
  assert.equal(page('home').h1, 'Your used cars on Facebook Marketplace, from your website, in seconds.');
  // draft legal pages say so before the brand
  assert.equal(fullTitle(page('legal-terms'), true), 'Terms of service (draft) | Lot Current');
  assert.equal(fullTitle(page('legal-terms'), false), 'Terms of service | Lot Current');
  assert.equal(fullTitle(page('legal-terms')), legalDraft ? 'Terms of service (draft) | Lot Current' : 'Terms of service | Lot Current', 'without a flag, the committed status decides');
  assert.equal(fullTitle(page('pricing'), true), 'Pricing | Lot Current', '(draft) is for legal pages only');
  // the breadcrumb trails mirror the addresses
  assert.deepEqual(PAGES.map((p) => [...ancestorsOf(p).map((a) => (a.path === '/' ? 'Home' : a.crumb)), ...(p.crumb ? [p.crumb] : [])]), [
    [], ['Home', 'How it works'], ['Home', 'Pricing'], ['Home', 'FAQ'], ['Home', 'For managers'], ['Home', 'Support'], ['Home', 'Legal'],
    ['Home', 'Legal', 'Terms of service'], ['Home', 'Legal', 'Privacy policy'], ['Home', 'Legal', 'Posting rules'], [],
  ]);
  assert.deepEqual(PAGES.map(rootFor), ['./', '../', '../', '../', '../', '../', '../', '../../', '../../', '../../', '/']);
  assert.equal(socialAlt(page('home')), `The Lot Current check mark and name, with the words "Your used cars listed from your website, in seconds." and "${LINE}"`);
  assert.equal(socialAlt(page('not-found')), '');
  assert.equal(LINE, 'You click Publish. Lot Current never does.');
  assert.equal(SITE_NAME, 'Lot Current');
  assert.equal(BRAND_TAGLINE, 'A Chrome extension for dealership salespeople');
  assert.match(FOOTER_LINE, /^Lot Current is not affiliated with Meta Platforms, Inc\./);
  assert.equal(THEME_COLOR, '#14532d');
  for (const p of PAGES) {
    const words = p.social ? p.social.heading : '';
    assert.doesNotMatch(words, /Facebook|Marketplace|Meta|\d/, `${p.slug}: the share heading names nothing of Meta's and no number`);
  }
});

test('the map refuses a long or repeated title or description', () => {
  const long = { ...page('pricing'), slug: 'x', title: 'A title that is far too long for a browser tab and a search result' };
  assert.throws(() => validatePages([long], true), /at most 60/);
  assert.throws(() => validatePages([{ ...page('pricing'), description: 'x'.repeat(156) }], true), /at most 155/);
  assert.throws(() => validatePages([{ ...page('pricing'), description: '' }], true), /no description/);
  assert.throws(() => validatePages([{ ...page('pricing'), title: ' ' }], true), /no title/);
  assert.throws(() => validatePages([page('pricing'), { ...page('faq'), title: 'pricing' }], true), /share the title/);
  assert.throws(() => validatePages([page('pricing'), { ...page('faq'), description: page('pricing').description }], true), /share a description/);
  assert.throws(() => validatePages([{ ...page('pricing'), description: 'a <b>tag</b>' }], true), /markup/);
});

test('the template syntax: escaped values, truthy and falsy blocks, nesting, and an unknown name throws even in a block that is left out', () => {
  const vars = { root: '../', name: 'A & B <c> "d" \'e\'', yes: true, no: false, list: [1], empty: [], zero: 0, nothing: null, missing: undefined };
  assert.equal(render('href="{{root}}pricing/" {{name}}', vars), 'href="../pricing/" A &amp; B &lt;c&gt; &quot;d&quot; &#39;e&#39;');
  assert.equal(render('[{{#yes}}on{{/yes}}{{^yes}}off{{/yes}}]', vars), '[on]');
  assert.equal(render('[{{#no}}on{{/no}}{{^no}}off{{/no}}]', vars), '[off]');
  assert.equal(render('[{{#list}}some{{/list}}{{#empty}}none{{/empty}}{{^empty}}empty{{/empty}}]', vars), '[someempty]');
  assert.equal(render('[{{#zero}}0{{/zero}}{{^zero}}z{{/zero}}{{#nothing}}n{{/nothing}}{{nothing}}{{missing}}{{no}}]', vars), '[z]');
  assert.equal(render('{{#yes}}a{{#no}}b{{/no}}{{^no}}c{{#yes}}{{name}}{{/yes}}{{/no}}d{{/yes}}', { ...vars, name: 'n' }), 'acnd');
  assert.equal(render('no tags at all', vars), 'no tags at all');
  assert.equal(render('{{ root }} stays as typed', vars), '{{ root }} stays as typed', 'only the exact syntax is a tag');
  assert.throws(() => render('{{unknown}}', vars), /unknown variable \{\{unknown\}\}/);
  assert.throws(() => render('{{#no}}{{unknown}}{{/no}}', vars), /unknown variable/, 'checked inside a block that is left out');
  assert.throws(() => render('{{#unknown}}x{{/unknown}}', vars), /unknown variable/);
  assert.throws(() => render('{{#yes}}x', vars), /is not closed/);
  assert.throws(() => render('x{{/yes}}', vars), /closes nothing/);
  assert.throws(() => render('{{#yes}}x{{/no}}', vars), /closes \{\{#yes\}\}/);
  assert.equal(render('{{#yes}}{{^no}}{{name}}{{/no}}{{/yes}}', { yes: 1, no: '', name: '<' }), '&lt;');
});

test('config.js: validateSite accepts the committed config and every honest shape, and refuses placeholders, paths and a half-filled business', () => {
  assert.doesNotThrow(() => validateSite(SITE), 'the committed config.js');
  assert.doesNotThrow(() => validateSite(base));
  assert.doesNotThrow(() => validateSite({ ...base, siteUrl: FIXTURE_URL, demoEndpoint: 'https://abcdefgh.supabase.co/functions/v1/lead', demoMailto: 'mailto:demo@fixture.lotcurrent.com', supportEmail: 'support@fixture.lotcurrent.com', signupUrl: '../manager/', business: BUSINESS }));
  assert.doesNotThrow(() => validateSite({ ...base, business: { ...EMPTY_BUSINESS, ...Object.fromEntries(['name', 'streetAddress', 'addressLocality', 'addressRegion', 'postalCode', 'addressCountry'].map((k) => [k, 'x'])) } }), 'required fields only');
  assert.doesNotThrow(() => validateSite({ ...base, demoMailto: 'mailto:demo@fixture.lotcurrent.com?subject=Demo' }), 'a mailto with a query');
  for (const [bad, why] of [
    [{ siteUrl: 'https://fixture.lotcurrent.com/' }, /trailing slash/],
    [{ siteUrl: 'https://fixture.lotcurrent.com/site' }, /no path/],
    [{ siteUrl: 'http://fixture.lotcurrent.com' }, /https origin/],
    [{ siteUrl: 'fixture.lotcurrent.com' }, /https origin/],
    [{ siteUrl: 'https://lotcurrent.example' }, /reserved placeholder host/],
    [{ siteUrl: 'https://www.example.com' }, /reserved placeholder host/],
    [{ siteUrl: 'https://site.test' }, /reserved placeholder host/],
    [{ siteUrl: 'https://localhost' }, /reserved placeholder host/],
    [{ siteUrl: ' https://fixture.lotcurrent.com' }, /spaces/],
    [{ siteUrl: null }, /must be a string/],
    [{ demoEndpoint: 'https://lead.example/functions/v1/lead' }, /reserved placeholder host/],
    [{ demoEndpoint: 'http://abcdefgh.supabase.co/functions/v1/lead' }, /https address/],
    [{ demoMailto: 'mailto:demo@lotcurrent.example' }, /reserved placeholder host/],
    [{ demoMailto: 'demo@fixture.lotcurrent.com' }, /'mailto:<address>'/],
    [{ demoMailto: 'mailto:not an address' }, /'mailto:<address>'/],
    [{ supportEmail: 'mailto:support@fixture.lotcurrent.com' }, /plain address/],
    [{ supportEmail: 'support@example.org' }, /reserved placeholder host/],
    [{ supportEmail: 'support' }, /plain address/],
    [{ signupUrl: 'https://app.lotcurrent.example/manager/' }, /reserved placeholder host/],
    [{ business: { ...EMPTY_BUSINESS, name: 'Lot Current' } }, /partly filled \(missing streetAddress, addressLocality, addressRegion, postalCode, addressCountry\)/],
    [{ business: { ...BUSINESS, postalCode: '' } }, /partly filled \(missing postalCode\)/],
    [{ business: { ...EMPTY_BUSINESS, telephone: '555' } }, /optional fields but no name or address/],
    [{ business: { ...BUSINESS, url: 'https://lotcurrent.example' } }, /business\.url/],
    [{ business: { ...BUSINESS, url: 'fixture.lotcurrent.com' } }, /business\.url/],
    [{ business: { ...BUSINESS, email: 'x@example.com' } }, /business\.email/],
    [{ business: { ...BUSINESS, openingHours: 'Mo-Fr' } }, /openingHours must be a list/],
    [{ business: { ...BUSINESS, openingHours: [''] } }, /openingHours must be a list/],
    [{ business: null }, /business must be an object/],
    [{ business: { ...EMPTY_BUSINESS, areaServed: undefined } }, /business\.areaServed must be a string/],
  ]) {
    assert.throws(() => validateSite({ ...base, ...bad }), why, JSON.stringify(bad));
  }
  const { business: _b, ...noBusiness } = base;
  assert.throws(() => validateSite(noBusiness), /business must be an object/);
  for (const host of ['lotcurrent.example', 'example', 'a.test', 'x.invalid', 'localhost', 'app.localhost', 'example.com', 'www.example.org', 'sub.example.net', '', 'EXAMPLE.COM', 'a.test.']) assert.equal(isPlaceholderHost(host), true, host);
  for (const host of ['fixture.lotcurrent.com', 'example.co', 'test.org', 'notexample.com', 'abcdefgh.supabase.co', 'my-test.io']) assert.equal(isPlaceholderHost(host), false, host);
  // the committed file: a switch is empty until the owner has the real thing,
  // and no invented address is in it, comments included. The only addresses
  // it may hold are on the site's own domain (the owner's inbox there).
  const text = read(CONFIG_FILE);
  assert.doesNotMatch(text, FORBIDDEN, 'config.js carries no placeholder word or invented address');
  const domain = SITE.siteUrl ? new URL(SITE.siteUrl).hostname.replace(/^www\./, '') : null;
  const inboxes = [...text.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)].map((m) => m[1].toLowerCase());
  for (const host of inboxes) assert.equal(host, domain, `config.js names an inbox on ${host}: only the site's own domain (${domain || 'none: siteUrl is empty'}) may appear`);
  if (!SITE.siteUrl) assert.deepEqual([SITE.demoMailto, SITE.supportEmail], ['', ''], 'no inbox before the site has its domain');
  for (const phrase of ['functions/v1/lead', '"Self-serve sign-up"', 'selfServeSignup in manager/config.js', 'LEAD_ORIGINS', 'LocalBusiness']) assert.ok(text.includes(phrase), `config.js explains ${phrase}`);
  assert.deepEqual(Object.keys(SITE), ['siteUrl', 'demoEndpoint', 'demoMailto', 'supportEmail', 'signupUrl', 'business']);
  assert.deepEqual(Object.keys(SITE.business), Object.keys(EMPTY_BUSINESS));
});

test('siteUrl is not set: the site is not ready to publish', async () => {
  // A reported condition, not a failure: whichever state config.js is in, the generated files agree with it.
  const report = siteUrlReport(SITE);
  const ctx = await readContext(root);
  assert.deepEqual(ctx.site, SITE);
  const home = read('site/index.html');
  if (!SITE.siteUrl) {
    assert.equal(report, 'siteUrl is not set: the site is not ready to publish (no canonical, og:url, og:image, sitemap.xml or CNAME is written; docs/launch-checklist.md)');
    assert.ok(!existsSync(join(root, 'site/sitemap.xml')), 'no sitemap.xml while siteUrl is not set');
    assert.ok(!existsSync(join(root, 'site/CNAME')), 'no CNAME while siteUrl is not set');
    assert.doesNotMatch(home, /rel="canonical"|og:url|og:image/, 'no absolute address is invented');
    assert.equal(read('site/robots.txt'), 'User-agent: *\nAllow: /\n');
  } else {
    assert.equal(report, `siteUrl is ${SITE.siteUrl}: canonical, og:url, og:image, sitemap.xml and CNAME are written`);
    assert.equal(read('site/sitemap.xml'), sitemapXml(SITE));
    assert.equal(read('site/CNAME'), cnameTxt(SITE));
    assert.ok(home.includes(`<link rel="canonical" href="${SITE.siteUrl}/">`));
    assert.equal(read('site/robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE.siteUrl}/sitemap.xml\n`);
  }
  assert.equal(siteUrlReport({ siteUrl: FIXTURE_URL }), `siteUrl is ${FIXTURE_URL}: canonical, og:url, og:image, sitemap.xml and CNAME are written`);
});

test('the committed pages, robots.txt and llms.txt are what the sources make now (npm run site-pages)', async () => {
  const ctx = await readContext(root);
  assert.deepEqual(staleFiles(ctx), [], 'an output differs from its sources: run npm run site-pages and commit');
  assert.deepEqual(strayFiles(ctx), [], 'a file under site/ is none of the site\'s: the deploy would publish it unchecked');
  const { files, remove } = buildSite(ctx);
  assert.deepEqual(files.map((f) => f.file), [...FRAGMENT_PAGES.map((p) => p.file), 'site/robots.txt', 'site/llms.txt', ...(SITE.siteUrl ? ['site/sitemap.xml', 'site/CNAME'] : [])]);
  assert.deepEqual(remove, SITE.siteUrl ? [] : ['site/sitemap.xml', 'site/CNAME']);
});

test('cspFor: two variants, form-action mailto: only on the home page and only once an inbox exists', () => {
  const noScript = "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'";
  const script = (x) => `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self' https://*.supabase.co; object-src 'none'; base-uri 'none'; form-action ${x}`;
  assert.equal(NO_SCRIPT_CSP, noScript);
  for (const p of PAGES) {
    assert.equal(cspFor(p, base), p.script ? script("'none'") : noScript, p.slug);
    assert.equal(cspFor(p, { ...base, demoMailto: 'mailto:demo@fixture.lotcurrent.com' }), p.script ? script(p.slug === 'home' ? 'mailto:' : "'none'") : noScript, `${p.slug} with an inbox`);
    assert.equal(cspFor(p, { ...base, demoEndpoint: 'https://abcdefgh.supabase.co/functions/v1/lead' }), p.script ? script("'none'") : noScript, `${p.slug} with the function only`);
  }
  assert.deepEqual(PAGES.filter((p) => p.script).map((p) => p.slug), ['home', 'pricing']);
});

test('renderPage writes the document in the fixed order, with the absolute tags only once siteUrl is set and nothing shared on the 404 page', () => {
  for (const p of FRAGMENT_PAGES) {
    const body = read(p.source).includes('{{') ? render(read(p.source), templateVars(p, ctxOf())) : read(p.source);
    for (const site of [{}, { siteUrl: FIXTURE_URL }]) {
      const ctx = ctxOf(site);
      const html = renderPage(p, body, ctx);
      const r = rootFor(p);
      const set = Boolean(site.siteUrl);
      assert.ok(html.startsWith(`<!doctype html>\n<!-- Written by scripts/site-pages.mjs from ${p.source} and site/config.js.`), p.slug);
      assert.ok(html.includes(`<html lang="en" data-root="${r}">`), `${p.slug}: data-root`);
      const head = between(html, '<head>', '</head>');
      const order = [
        '<meta charset="utf-8">', '<meta name="viewport" content="width=device-width, initial-scale=1">', '<meta name="color-scheme" content="light dark">',
        `<meta name="theme-color" content="${THEME_COLOR}">`, `<meta http-equiv="Content-Security-Policy" content="${cspFor(p, ctx.site)}">`, `<title>${fullTitle(p)}</title>`,
        `<meta name="description" content="${p.description}">`,
        ...(p.kind === 'notFound' ? ['<meta name="robots" content="noindex">'] : []),
        ...(set && p.kind !== 'notFound' ? [`<link rel="canonical" href="${FIXTURE_URL}${p.path}">`] : []),
        `<link rel="icon" href="${r}favicon.svg" type="image/svg+xml">`, `<link rel="icon" href="${r}favicon-32.png" type="image/png" sizes="32x32">`, `<link rel="apple-touch-icon" href="${r}apple-touch-icon.png">`, `<link rel="stylesheet" href="${r}site.css">`,
        ...(p.kind !== 'notFound' ? [
          '<meta property="og:type" content="website">', '<meta property="og:site_name" content="Lot Current">', `<meta property="og:title" content="${p.title}">`, `<meta property="og:description" content="${p.description}">`,
          ...(set ? [`<meta property="og:url" content="${FIXTURE_URL}${p.path}">`, `<meta property="og:image" content="${FIXTURE_URL}/social/${p.slug}.png">`, '<meta property="og:image:width" content="1200">', '<meta property="og:image:height" content="630">', `<meta property="og:image:alt" content="${attr(socialAlt(p))}">`] : []),
          '<meta name="twitter:card" content="summary_large_image">', `<meta name="twitter:title" content="${p.title}">`, `<meta name="twitter:description" content="${p.description}">`,
          '<script type="application/ld+json">',
        ] : []),
      ];
      let at = -1;
      for (const tag of order) {
        const i = head.indexOf(tag);
        assert.ok(i > at, `${p.slug}${set ? ' (siteUrl set)' : ''}: ${tag} comes next in the head`);
        at = i;
      }
      assert.equal((head.match(/<meta|<link|<title|<script/g) || []).length, order.length, `${p.slug}: nothing else in the head`);
      if (!set) assert.doesNotMatch(head, /canonical|og:url|og:image|https?:\/\/(?!schema\.org|\*\.supabase\.co)/, `${p.slug}: no absolute address while siteUrl is ''`);
      // header, nav, breadcrumbs, main, footer, script
      assert.ok(html.includes(`<a class="brand" href="${r}">Lot Current <small>${BRAND_TAGLINE}</small></a>`), `${p.slug}: the brand link`);
      const nav = between(html, '<nav aria-label="Site">', '</nav>');
      assert.deepEqual([...nav.matchAll(/<li><a href="([^"]+)"( aria-current="page")?>([^<]+)<\/a><\/li>/g)].map((m) => [m[1], m[3], Boolean(m[2])]),
        NAV.map((n) => [r + n.path.slice(1), n.nav, n === p]), `${p.slug}: the site nav with aria-current on its own item only`);
      const crumbs = between(html, '<nav class="crumbs" aria-label="Breadcrumb">', '</nav>');
      if (p.crumb) {
        assert.ok(crumbs.includes('<div class="wrap">') && crumbs.includes('<ol>'), `${p.slug}: nav.crumbs > div.wrap > ol`);
        assert.deepEqual([...crumbs.matchAll(/<li(?: aria-current="page")?>(?:<a href="([^"]+)">)?([^<]+)/g)].map((m) => [m[1] || null, m[2]]),
          [...ancestorsOf(p).map((a) => [r + a.path.slice(1), a.path === '/' ? 'Home' : a.crumb]), [null, p.crumb]], `${p.slug}: the trail`);
        assert.ok(crumbs.endsWith(`<li aria-current="page">${p.crumb}</li>\n      </ol>\n    </div>\n  </nav>`), `${p.slug}: the last crumb is the page, not a link`);
      } else {
        assert.equal(crumbs, '', `${p.slug}: no breadcrumbs on home and 404`);
      }
      assert.ok(html.includes('  <main id="main">\n'), `${p.slug}: main`);
      const footer = between(html, '<footer>', '</footer>');
      assert.deepEqual([...footer.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map((m) => [m[1], m[2]]), [[`${r}legal/terms/`, 'Terms of service'], [`${r}legal/privacy/`, 'Privacy policy'], [`${r}legal/posting-rules/`, 'Posting rules']]);
      assert.ok(footer.includes(`<p>${FOOTER_LINE}</p>`));
      const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
      assert.deepEqual(scripts, [...(p.kind !== 'notFound' ? [' type="application/ld+json"'] : []), ...(p.script ? [` type="module" src="${r}site.js"`] : [])], `${p.slug}: the JSON-LD block and site.js on script pages, nothing else`);
      assert.ok(html.endsWith('</body>\n</html>\n'));
      assert.equal((html.match(/<h1\b/g) || []).length, 1, `${p.slug}: one h1`);
      assert.doesNotMatch(html, FORBIDDEN);
      assert.doesNotMatch(html, PILOT);
    }
  }
  assert.throws(() => renderPage({ ...page('faq') }, '<h1>x</h1>', ctxOf()), /not a page of the map/, 'a copy of an entry is not the entry');
  assert.throws(() => renderPage(page('faq'), '<h1>x</h1>', {}), /ctx\.site/);
});

test('JSON-LD: home carries Organization, WebSite and SoftwareApplication (LocalBusiness and an Offer only from config.js and pricing.json), crumb pages a BreadcrumbList, the FAQ a FAQPage', () => {
  const faqBody = render(read(page('faq').source), templateVars(page('faq'), ctxOf()));
  // the state as committed: no address, no business, prices a hypothesis
  const home = jsonLdFor(page('home'), ctxOf());
  assert.equal(home['@context'], 'https://schema.org');
  assert.deepEqual(home['@graph'], [
    { '@type': 'Organization', name: 'Lot Current' },
    { '@type': 'WebSite', name: 'Lot Current' },
    { '@type': 'SoftwareApplication', name: 'Lot Current', applicationCategory: 'BusinessApplication', operatingSystem: 'Chrome', description: page('home').description },
  ]);
  assert.equal(pricing.hypothesis, true, 'pricing.json is still a hypothesis: no Offer is written');
  // siteUrl set: addresses, the logo, the breadcrumb items
  const live = jsonLdFor(page('home'), ctxOf({ siteUrl: FIXTURE_URL }))['@graph'];
  assert.deepEqual(live[0], { '@type': 'Organization', name: 'Lot Current', url: FIXTURE_URL, logo: `${FIXTURE_URL}/apple-touch-icon.png` });
  assert.equal(live[1].url, FIXTURE_URL);
  assert.equal(live[2].url, FIXTURE_URL);
  assert.ok(!('offers' in live[2]));
  // a confirmed price: the Offer from pricing.json, nothing invented
  const paid = jsonLdFor(page('home'), ctxOf({}, { pricing: { ...pricing, hypothesis: false } }))['@graph'][2];
  assert.deepEqual(paid.offers, { '@type': 'Offer', price: pricing.perRooftopMonthly, priceCurrency: pricing.currency });
  // the business filled in: LocalBusiness replaces Organization, with only the fields given
  const local = jsonLdFor(page('home'), ctxOf({ business: BUSINESS }))['@graph'][0];
  assert.deepEqual(local, {
    '@type': 'LocalBusiness', name: 'Lot Current', legalName: 'Lot Current LLC',
    address: { '@type': 'PostalAddress', streetAddress: '1 Main Street', addressLocality: 'Springfield', addressRegion: 'PA', postalCode: '19064', addressCountry: 'US' },
    telephone: '+1-555-010-0100', email: 'hello@fixture.lotcurrent.com', openingHours: ['Mo-Fr 09:00-17:00'], areaServed: 'Pennsylvania',
  });
  const bare = jsonLdFor(page('home'), ctxOf({ siteUrl: FIXTURE_URL, business: { ...EMPTY_BUSINESS, name: 'N', streetAddress: 'S', addressLocality: 'L', addressRegion: 'R', postalCode: 'P', addressCountry: 'C' } }))['@graph'][0];
  assert.deepEqual(Object.keys(bare), ['@type', 'name', 'url', 'address'], 'optional fields left out; url falls back to siteUrl');
  assert.equal(bare.url, FIXTURE_URL);
  assert.equal(jsonLdFor(page('home'), ctxOf({ business: { ...BUSINESS, url: 'https://fixture.lotcurrent.com/store' } }))['@graph'][0].url, 'https://fixture.lotcurrent.com/store');
  for (const node of jsonLdFor(page('home'), ctxOf())['@graph']) {
    for (const key of ['aggregateRating', 'review', 'telephone', 'address', 'offers', 'openingHours', 'url', 'logo', 'email']) assert.ok(!(key in node), `${node['@type']}.${key}: nothing that is not in config.js or pricing.json`);
  }
  // breadcrumbs
  for (const p of PAGES.filter((x) => x.crumb)) {
    const graph = jsonLdFor(p, ctxOf({ siteUrl: FIXTURE_URL }), p.slug === 'faq' ? faqBody : '')['@graph'];
    const crumbs = graph.find((n) => n['@type'] === 'BreadcrumbList');
    const trail = [...ancestorsOf(p), p];
    assert.deepEqual(crumbs.itemListElement, trail.map((t, i) => ({ '@type': 'ListItem', position: i + 1, name: t.path === '/' ? 'Home' : t.crumb, item: FIXTURE_URL + t.path })), p.slug);
    const plain = jsonLdFor(p, ctxOf(), p.slug === 'faq' ? faqBody : '')['@graph'].find((n) => n['@type'] === 'BreadcrumbList');
    assert.ok(plain.itemListElement.every((e) => !('item' in e)), `${p.slug}: no item address while siteUrl is ''`);
    assert.deepEqual(graph.map((n) => n['@type']), p.jsonld, `${p.slug}: the map's jsonld list`);
  }
  assert.deepEqual(jsonLdFor(page('home'), ctxOf())['@graph'].map((n) => n['@type']), page('home').jsonld);
  // the FAQ page
  const items = faqItems(faqBody);
  assert.equal(items.length, 7);
  assert.deepEqual(items.map((i) => i.question), ['Is this allowed on Facebook?', 'Does it post for me?', 'What does it read?', 'Where is my data?', 'What about my Facebook password?', 'Which websites work?', 'How do updates arrive?']);
  for (const i of items) assert.ok(i.answer.length > 40 && !/<|&[a-z#0-9]+;/.test(i.answer), `${i.question}: a plain-text answer`);
  const faq = jsonLdFor(page('faq'), ctxOf(), faqBody)['@graph'].find((n) => n['@type'] === 'FAQPage');
  assert.deepEqual(faq.mainEntity, items.map((i) => ({ '@type': 'Question', name: i.question, acceptedAnswer: { '@type': 'Answer', text: i.answer } })));
  assert.deepEqual(faqItems('<article class="qa"><h3>Q &amp; A?</h3><p>Yes, <b>bold</b>.</p><p>Two.</p></article>'), [{ question: 'Q & A?', answer: 'Yes, bold. Two.' }]);
  assert.throws(() => faqItems('<article class="qa"><p>no question</p></article>'), /no h3/);
  assert.throws(() => faqItems('<article class="qa"><h3>Q?</h3></article>'), /no answer/);
  assert.throws(() => jsonLdFor(page('faq'), ctxOf(), '<h1>x</h1>'), /no article\.qa/);
  assert.equal(jsonLdFor(page('not-found'), ctxOf()), null);
  // the block is safe inside <script>
  const html = renderPage(page('faq'), faqBody.replace('Does it post for me?', 'Does it &lt;/script&gt; post?'), ctxOf());
  assert.equal((html.match(/<\/script>/g) || []).length, 1, 'a closing tag in the text cannot end the block');
  assert.ok(html.includes('\\u003c/script\\u003e'), 'angle brackets in the data are escaped');
  assert.equal(jsonLdOf(html)[0]['@graph'].find((n) => n['@type'] === 'FAQPage').mainEntity[1].name, 'Does it </script> post?');
});

test('the files next to the pages: robots.txt, sitemap.xml, CNAME and llms.txt in the llmstxt.org shape', () => {
  assert.equal(robotsTxt(base), 'User-agent: *\nAllow: /\n');
  assert.equal(robotsTxt({ siteUrl: FIXTURE_URL }), `User-agent: *\nAllow: /\nSitemap: ${FIXTURE_URL}/sitemap.xml\n`);
  // a legal text still marked draft is readable but not listed; once approved it is
  assert.deepEqual(listedPages(false), PAGES.filter((p) => p.sitemap));
  assert.deepEqual(listedPages(true), PAGES.filter((p) => p.sitemap && p.kind !== 'legal'));
  assert.ok(listedPages(true).some((p) => p.path === '/legal/'), 'the legal index stays listed while the texts are drafts');
  for (const draft of [true, false]) {
    const locs = [...sitemapXml({ siteUrl: FIXTURE_URL }, draft).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    assert.deepEqual(locs, listedPages(draft).map((p) => FIXTURE_URL + p.path), `sitemap with draft ${draft}`);
    const llmsLinks = [...llmsTxt({ siteUrl: FIXTURE_URL }, draft).matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
    assert.deepEqual(llmsLinks, locs, `llms.txt lists the same pages as the sitemap with draft ${draft}`);
  }
  const sitemap = sitemapXml({ siteUrl: FIXTURE_URL }, false);
  assert.ok(sitemap.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'));
  assert.doesNotMatch(sitemap, /lastmod|changefreq|priority/, 'nothing faked');
  assert.doesNotMatch(sitemap, /404/);
  assert.throws(() => sitemapXml(base), /needs siteUrl/);
  assert.equal(cnameTxt({ siteUrl: 'https://www.fixture.lotcurrent.com' }), 'www.fixture.lotcurrent.com\n');
  assert.throws(() => cnameTxt(base), /needs siteUrl/);
  for (const site of [base, { siteUrl: FIXTURE_URL }]) {
    const llms = llmsTxt(site, false);
    const lines = llms.split('\n');
    assert.equal(lines[0], '# Lot Current');
    assert.equal(lines[1], '');
    assert.match(lines[2], /^> Lot Current is a Chrome extension for dealership salespeople/);
    assert.ok(lines[2].includes('a person checks it and clicks Publish') && lines[2].includes('never publishes anything itself'));
    assert.match(lines[4], /^Lot Current is not affiliated with Meta Platforms, Inc\.;.*planned prices/);
    assert.deepEqual(lines.filter((l) => l.startsWith('## ')), ['## Pages', '## Legal']);
    const items = lines.filter((l) => l.startsWith('- '));
    assert.equal(items.length, listedPages(false).length);
    for (const item of items) {
      const m = item.match(/^- \[([^\]]+)\]\(([^)]+)\): (.+)$/);
      assert.ok(m, `the llms.txt line shape: ${item}`);
      const p = PAGES.find((x) => (site.siteUrl ? site.siteUrl + x.path : x.path) === m[2]);
      assert.ok(p, `${m[2]} is a page`);
      assert.equal(m[1], p.nav || p.title);
      assert.equal(m[3], p.description);
    }
    assert.ok(llms.endsWith('\n') && !llms.endsWith('\n\n\n'));
    assert.doesNotMatch(llms, FORBIDDEN);
  }
  assert.equal(llmsTxt(base).indexOf('[Legal documents](/legal/)') > llmsTxt(base).indexOf('## Legal'), true);
});

test('the fragments: the variables a page may use, both demo-form states on the home page, the support inbox, the draft note', () => {
  const home = read(page('home').source);
  const closed = render(home, templateVars(page('home'), ctxOf()));
  assert.ok(closed.includes('<p id="demo-closed" class="notice">The demo request form is not open yet.</p>'), 'closed: the note shows');
  assert.ok(closed.includes('<form id="demo-form" class="form-grid" hidden>'), 'closed: the form is hidden, with no action');
  assert.ok(closed.includes('<button type="submit" class="button" disabled>Send the request</button>'), 'closed: the button waits for site.js');
  assert.ok(closed.includes('<noscript><p class="muted">This form needs JavaScript.</p></noscript>'));
  assert.doesNotMatch(closed, /mailto:|Ten minutes at your desk/);
  const byMail = render(home, templateVars(page('home'), ctxOf({ demoMailto: 'mailto:demo@fixture.lotcurrent.com' })));
  assert.ok(byMail.includes('<p id="demo-closed" class="notice" hidden>'), 'open: the note is hidden');
  assert.ok(byMail.includes('<form id="demo-form" class="form-grid" action="mailto:demo@fixture.lotcurrent.com" method="post" enctype="text/plain">'), 'open by mail: the form posts to the inbox without JavaScript');
  assert.ok(byMail.includes('<button type="submit" class="button">Send the request</button>'));
  assert.ok(byMail.includes('Without JavaScript, the button opens your email app'));
  assert.ok(byMail.includes('Ten minutes at your desk'));
  const byFunction = render(home, templateVars(page('home'), ctxOf({ demoEndpoint: 'https://abcdefgh.supabase.co/functions/v1/lead' })));
  assert.ok(byFunction.includes('<form id="demo-form" class="form-grid">'), 'open by the function only: no action (form-action is \'none\'), site.js sends it');
  assert.ok(byFunction.includes('<button type="submit" class="button" disabled>'), 'the button stays disabled until site.js runs');
  assert.ok(byFunction.includes('<p id="demo-closed" class="notice" hidden>'));
  assert.doesNotMatch(byFunction, /mailto:|abcdefgh\.supabase\.co/, 'the endpoint is never written into the page');
  // the honeypot and the fields as the lead function expects them, in every state
  for (const html of [closed, byMail, byFunction]) {
    assert.match(html, /<div class="hp" aria-hidden="true">[\s\S]*?<input id="f-company-url" name="company_url" type="text" tabindex="-1" autocomplete="off">/);
    assert.deepEqual([...html.matchAll(/\bname="([^"]+)"/g)].map((m) => m[1]), ['name', 'dealership', 'website', 'email', 'phone', 'message', 'company_url']);
  }
  const vars = templateVars(page('home'), ctxOf({ demoMailto: 'mailto:demo@fixture.lotcurrent.com?subject=Demo', supportEmail: 's@fixture.lotcurrent.com' }));
  assert.deepEqual(vars, { root: './', siteUrl: '', demoOpen: true, demoEndpoint: '', demoMailto: 'mailto:demo@fixture.lotcurrent.com?subject=Demo', demoMailtoAddress: 'demo@fixture.lotcurrent.com', supportEmail: 's@fixture.lotcurrent.com', signupUrl: '', legalDraft });
  assert.equal(templateVars(page('not-found'), ctxOf()).root, '/');
  assert.equal(templateVars(page('legal'), ctxOf()).root, '../');
  // the support page shows an inbox only once one exists
  const support = read(page('support').source);
  const noInbox = render(support, templateVars(page('support'), ctxOf()));
  assert.ok(noInbox.includes('a public support address will be listed here once it exists'));
  assert.doesNotMatch(noInbox, /mailto:/);
  const inbox = render(support, templateVars(page('support'), ctxOf({ supportEmail: 'support@fixture.lotcurrent.com' })));
  assert.ok(inbox.includes('<a href="mailto:support@fixture.lotcurrent.com">support@fixture.lotcurrent.com</a>'));
  assert.doesNotMatch(inbox, /listed here once it exists/);
  // the legal index says the texts are drafts only while they are
  const legal = read(page('legal').source);
  assert.ok(render(legal, templateVars(page('legal'), ctxOf({}, { legalDraft: true }))).includes('drafts under attorney review'));
  assert.doesNotMatch(render(legal, templateVars(page('legal'), ctxOf({}, { legalDraft: false }))), /draft/i);
  // every internal address in a fragment goes through root
  for (const p of FRAGMENT_PAGES) {
    const src = read(p.source);
    for (const m of src.matchAll(/\b(href|src)="([^"]*)"/g)) {
      const v = m[2];
      assert.ok(v.startsWith('{{root}}') || /^#[\w-]+$/.test(v) || v.startsWith('mailto:{{') || v === '{{demoMailto}}', `${p.source}: ${m[0]} does not go through {{root}}`);
    }
    assert.doesNotMatch(src, /https?:\/\//, `${p.source}: no absolute address`);
    assert.doesNotMatch(src, FORBIDDEN, `${p.source}: no placeholder word`);
    assert.doesNotMatch(src, PILOT, `${p.source}: no pilot-dealer value`);
  }
});

test('what the generator refuses: a second h1, a lost description, an unknown variable, an image without alt, inline style, a forbidden word, a pilot value', () => {
  const p = page('support');
  const good = read(p.source);
  const ctx = ctxOf();
  assert.doesNotThrow(() => renderFragmentPage(p, good, ctx));
  assert.throws(() => renderFragmentPage(p, good + '<h1>Another</h1>', ctx), /has 2 <h1> elements/);
  assert.throws(() => renderFragmentPage(p, good.replace(/<h1[^>]*>/, '<h2>').replace('</h1>', '</h2>'), ctx), /has 0 <h1> elements/);
  assert.throws(() => renderFragmentPage(p, good.replace('what support never asks for', 'what support never wants'), ctx), /description is not in the page/);
  assert.throws(() => renderFragmentPage(p, good.replace('<h1 id="page-h">Support</h1>', '<h1 id="page-h">Help</h1>'), ctx), /the h1 is "Help", the map says "Support"/);
  assert.throws(() => renderFragmentPage(p, good + '{{inbox}}', ctx), /unknown variable \{\{inbox\}\}/);
  assert.throws(() => renderFragmentPage(p, good + '<img src="{{root}}favicon-32.png" width="32" height="32">', ctx), /without alt, width and height/);
  assert.throws(() => renderFragmentPage(p, good + '<p style="color: red">x</p>', ctx), /inline style or event handler/);
  assert.throws(() => renderFragmentPage(p, good + '<a href="#main" onclick="x()">x</a>', ctx), /inline style or event handler/);
  assert.throws(() => renderFragmentPage(p, good + '<script src="x.js"></script>', ctx), /neither the JSON-LD block nor site\.js/);
  assert.throws(() => renderFragmentPage(p, good + '<p>Welcome to Lot Current</p>', ctx), /contains "Welcome to"/);
  assert.throws(() => renderFragmentPage(p, good + '<p>Built with Vite</p>', ctx), /contains "Vite"/);
  assert.doesNotThrow(() => renderFragmentPage(p, good + '<p>Send an invite.</p>', ctx), 'invite is not Vite');
  assert.throws(() => renderFragmentPage(p, good + '<p>lorem ipsum</p>', ctx), /contains "lorem"/);
  assert.throws(() => renderFragmentPage(p, good + '<!-- TODO: later -->', ctx), /contains "TODO"/);
  assert.throws(() => renderFragmentPage(p, good + '<input placeholder="x" aria-label="x">', ctx), /contains "placeholder"/);
  assert.throws(() => renderFragmentPage(p, good + '<p>demo@lotcurrent.example</p>', ctx), /contains ".example"/);
  assert.throws(() => renderFragmentPage(p, good + '<p>yourdomain</p>', ctx), /contains "yourdomain"/);
  assert.throws(() => renderFragmentPage(p, good + '<p>Ron Lewis</p>', ctx), /pilot dealer is a fixture/);
  assert.throws(() => assertClean('x example.com y', 'f'), /f contains "example.com"/);
  assert.doesNotThrow(() => assertClean('This example comes from a test.', 'f'), 'the word example alone is fine');
  assert.doesNotThrow(() => assertClean('reactive invite Vitest', 'f'), 'whole words only');
  assert.throws(() => assertClean('React', 'f'), /"React"/);
  // the FAQ page must have questions and answers in article.qa
  assert.throws(() => renderFragmentPage(page('faq'), '<h1 id="page-h">Frequently asked questions</h1><p class="lead">' + page('faq').description + '</p>', ctx), /no article\.qa/);
});

test('--check exits 1 naming each output that is missing, differs or must not exist, writes nothing, and reports the siteUrl state either way; a run writes and removes', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'lotcurrent-site-'));
  try {
    for (const rel of [CONFIG_FILE, PRICING_FILE, STATUS_FILE]) {
      mkdirSync(join(tmp, rel, '..'), { recursive: true });
      cpSync(join(root, rel), join(tmp, rel));
    }
    cpSync(join(root, 'site-src'), join(tmp, 'site-src'), { recursive: true });
    // Start from the committed config with no address and no inbox, whatever
    // the committed file holds, so every step below means the same thing.
    const config = read(CONFIG_FILE).replace(/siteUrl: '[^']*',/, "siteUrl: '',").replace(/demoMailto: '[^']*',/, "demoMailto: '',");
    assert.match(config, /siteUrl: '',/);
    writeFileSync(join(tmp, CONFIG_FILE), config);
    const run = async (argv) => {
      const said = { log: [], error: [] };
      const code = await main(argv, { log: (s) => said.log.push(s), error: (s) => said.error.push(s) }, tmp);
      return { code, ...said };
    };
    const notReady = 'siteUrl is not set: the site is not ready to publish (no canonical, og:url, og:image, sitemap.xml or CNAME is written; docs/launch-checklist.md)';
    let r = await run(['--check']);
    assert.equal(r.code, 1, 'no pages yet');
    assert.equal(r.log[0], notReady, 'the state is reported before the findings');
    assert.equal(r.error.length, FRAGMENT_PAGES.length + 2);
    assert.match(r.error[0], /^site\/index\.html is missing: run npm run site-pages$/);
    assert.ok(!existsSync(join(tmp, 'site/index.html')), '--check writes nothing');
    r = await run([]);
    assert.equal(r.code, 0);
    assert.deepEqual(r.log, [notReady, ...FRAGMENT_PAGES.map((p) => `wrote ${p.file}`), 'wrote site/robots.txt', 'wrote site/llms.txt']);
    r = await run(['--check']);
    assert.deepEqual([r.code, r.error], [0, []]);
    assert.deepEqual(r.log, [notReady, 'The website pages match site-src/, site/config.js, site/pricing.json and legal/legal-status.json.']);
    // a hand edit, a missing file, a fragment change
    const faqFile = join(tmp, 'site/faq/index.html');
    const written = readFileSync(faqFile, 'utf8');
    writeFileSync(faqFile, written.replace('</h1>', ' (edited)</h1>'));
    r = await run(['--check']);
    assert.equal(r.code, 1);
    assert.deepEqual(r.error, ['site/faq/index.html is not what the sources make: run npm run site-pages']);
    rmSync(join(tmp, 'site/llms.txt'));
    r = await run(['--check']);
    assert.deepEqual(r.error, ['site/faq/index.html is not what the sources make: run npm run site-pages', 'site/llms.txt is missing: run npm run site-pages']);
    writeFileSync(join(tmp, 'site-src/pages/support.html'), read('site-src/pages/support.html').replace('</h1>', '</h1>\n        <p>One more line.</p>'));
    r = await run(['--check']);
    assert.ok(r.error.some((e) => e.startsWith('site/support/index.html is not what the sources make')));
    assert.equal((await run([])).code, 0);
    assert.equal((await run(['--check'])).code, 0);
    assert.equal(readFileSync(faqFile, 'utf8'), written, 'the hand edit is gone');
    // a file no generator writes, nobody keeps and no page shows: the deploy publishes site/ whole, so --check refuses it
    const stray = 'site/offer/index.html';
    mkdirSync(join(tmp, 'site/offer'), { recursive: true });
    writeFileSync(join(tmp, stray), '<!doctype html><title>Offer</title><p>Approved by Meta, an official Facebook partner. Your account is guaranteed safe.</p>');
    mkdirSync(join(tmp, 'site/screenshots'), { recursive: true });
    writeFileSync(join(tmp, 'site/screenshots/01-ready-to-post.png'), 'shown on the home page');
    writeFileSync(join(tmp, 'site/screenshots/failure.png'), 'left by a failed npm run screenshots');
    writeFileSync(join(tmp, 'site/.DS_Store'), '');
    r = await run(['--check']);
    assert.equal(r.code, 1, 'a stray page fails the check');
    assert.deepEqual(r.error, [strayAdvice(stray), strayAdvice('site/screenshots/failure.png')]);
    assert.match(r.error[0], /^site\/offer\/index\.html is not part of the site .* the deploy would publish it unchecked: delete it/);
    r = await run([]);
    assert.equal(r.code, 1, 'a run writes the pages, names the stray files and fails');
    assert.deepEqual(r.error, [strayAdvice(stray), strayAdvice('site/screenshots/failure.png')]);
    assert.ok(existsSync(join(tmp, stray)), 'a run never deletes a file it does not own');
    rmSync(join(tmp, 'site/offer'), { recursive: true });
    rmSync(join(tmp, 'site/screenshots/failure.png'));
    assert.deepEqual([(await run(['--check'])).code, (await run([])).code], [0, 0], 'the screenshot a page shows and the system file are the site\'s');
    // siteUrl set: sitemap.xml and CNAME appear, every page gets its canonical; cleared again: they must go
    writeFileSync(join(tmp, CONFIG_FILE), config.replace("siteUrl: '',", `siteUrl: '${FIXTURE_URL}',`));
    r = await run(['--check']);
    assert.equal(r.log[0], `siteUrl is ${FIXTURE_URL}: canonical, og:url, og:image, sitemap.xml and CNAME are written`);
    assert.ok(r.error.includes('site/sitemap.xml is missing: run npm run site-pages') && r.error.includes('site/CNAME is missing: run npm run site-pages'));
    r = await run([]);
    assert.ok(r.log.includes('wrote site/sitemap.xml') && r.log.includes('wrote site/CNAME'));
    assert.equal(readFileSync(join(tmp, 'site/CNAME'), 'utf8'), 'fixture.lotcurrent.com\n');
    assert.equal(readFileSync(join(tmp, 'site/robots.txt'), 'utf8'), `User-agent: *\nAllow: /\nSitemap: ${FIXTURE_URL}/sitemap.xml\n`);
    for (const p of FRAGMENT_PAGES.filter((x) => x.kind !== 'notFound')) {
      const html = readFileSync(join(tmp, p.file), 'utf8');
      assert.ok(html.includes(`<link rel="canonical" href="${FIXTURE_URL}${p.path}">`), `${p.file}: canonical`);
      assert.ok(html.includes(`<meta property="og:image" content="${FIXTURE_URL}/social/${p.slug}.png">`), `${p.file}: og:image`);
    }
    assert.doesNotMatch(readFileSync(join(tmp, 'site/404.html'), 'utf8'), /canonical|og:/);
    assert.equal((await run(['--check'])).code, 0);
    writeFileSync(join(tmp, CONFIG_FILE), config);
    r = await run(['--check']);
    assert.equal(r.code, 1);
    assert.ok(r.error.includes('site/sitemap.xml exists although siteUrl is not set: run npm run site-pages'));
    assert.ok(r.error.includes('site/CNAME exists although siteUrl is not set: run npm run site-pages'));
    r = await run([]);
    assert.ok(r.log.includes('removed site/sitemap.xml (siteUrl is not set)') && r.log.includes('removed site/CNAME (siteUrl is not set)'));
    assert.ok(!existsSync(join(tmp, 'site/sitemap.xml')) && !existsSync(join(tmp, 'site/CNAME')));
    assert.equal((await run(['--check'])).code, 0);
    // a config that cannot be published: refused, nothing written
    const before = readFileSync(faqFile, 'utf8');
    writeFileSync(join(tmp, CONFIG_FILE), config.replace("siteUrl: '',", "siteUrl: 'https://lotcurrent.example',"));
    r = await run([]);
    assert.equal(r.code, 1);
    assert.match(r.error.join('\n'), /siteUrl is on a reserved placeholder host/);
    assert.equal(readFileSync(faqFile, 'utf8'), before);
    writeFileSync(join(tmp, CONFIG_FILE), config.replace("demoMailto: '',", "demoMailto: 'mailto:demo@lotcurrent.example',"));
    assert.match((await run(['--check'])).error.join('\n'), /demoMailto is on a reserved placeholder host/);
    writeFileSync(join(tmp, CONFIG_FILE), config.replace("name: '',", "name: 'Lot Current',"));
    assert.match((await run(['--check'])).error.join('\n'), /business is partly filled/);
    writeFileSync(join(tmp, CONFIG_FILE), config);
    // a fragment with a forbidden word: refused, nothing written
    writeFileSync(join(tmp, 'site-src/pages/faq.html'), read('site-src/pages/faq.html') + '\n<!-- TODO -->\n');
    r = await run([]);
    assert.equal(r.code, 1);
    assert.match(r.error[0], /site\/faq\/index\.html contains "TODO"/);
    assert.equal(readFileSync(faqFile, 'utf8'), before);
    writeFileSync(join(tmp, 'site-src/pages/faq.html'), read('site-src/pages/faq.html'));
    // help and a wrong option
    const help = await run(['--help']);
    assert.equal(help.code, 0);
    assert.equal(help.log.join('\n'), USAGE.join('\n'));
    assert.match(help.log.join('\n'), /siteUrl/);
    assert.equal((await run(['--chek'])).code, 2);
    assert.equal((await run(['--check', '--help'])).code, 0);
    // writeSite and staleFiles against a context by hand
    const ctx = await readContext(tmp);
    assert.equal(ctx.dir, tmp);
    assert.deepEqual(staleFiles(ctx), []);
    assert.ok(writeSite(ctx).every((l) => l.startsWith('wrote ')));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('the files under site/ the map knows besides the pages: the ones kept by hand, and the favicons and share images as their generators name them', () => {
  assert.deepEqual([...FAVICON_FILES].sort(), FAVICONS.map((f) => f.file).sort(), 'scripts/favicons.mjs writes these');
  assert.ok(KEPT_FILES.includes(FAVICON_SOURCE), 'the mark the favicons are drawn from');
  assert.equal(SOCIAL_INDEX, IMAGES_JSON);
  for (const p of PAGES.filter((x) => x.social)) assert.equal(socialFile(p), `${SOCIAL_DIR}/${p.slug}.png`);
  for (const f of KEPT_FILES) assert.ok(existsSync(join(root, f)), `${f} exists`);
});

test('the script imports only node: modules and site/config.js, and reads the inputs it names', () => {
  const src = read('scripts/site-pages.mjs');
  for (const m of src.matchAll(/^import [^;]* from '([^']+)';/gm)) assert.match(m[1], /^node:/, `imports ${m[1]}`);
  assert.doesNotMatch(src, /from '\.\/legal-pages|import\(['"`]\.\/legal-pages/, 'no cycle: legal-pages.mjs imports this, never the other way');
  assert.match(src, /import\(`\$\{pathToFileURL\(configPath\)\.href\}/, 'config.js is imported as a module');
  assert.ok(textOf('<p>a &amp; <b>b</b></p>') === 'a & b');
  assert.equal(escapeHtml('<a href="x">\'&'), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
});
