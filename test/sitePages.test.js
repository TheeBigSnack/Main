// The website as committed under site/, checked page by page against the
// site map (scripts/site-pages.mjs, PAGES): every page exists with its own
// title, description and one h1; the head tags, the canonical and share
// tags gated on site/config.js's siteUrl; the shared nav, breadcrumbs and
// footer; every link, image, stylesheet and script resolving to a file under
// site/ (or an anchor on the page, or an inbox from config.js); the two
// Content-Security-Policy variants; robots.txt, llms.txt, sitemap.xml and
// CNAME; the structured data; the favicons and the share images; the
// redirect stubs at the legal pages' old addresses; the honesty lines and the
// forbidden words (test/honesty.js) over every page's text, alt text and head,
// llms.txt and the share sentences, and the pricing over the same places but
// alt text (the screenshots show sample cars' prices); the Pages-like server of
// scripts/site-check.mjs; both generators' --check modes; and that the
// browser checks (scripts/site-check.mjs, scripts/a11y.mjs) cover every page.
// No browser here: the live checks are `npm run test:site` and
// `npm run test:a11y`. The generator itself is tested in
// test/siteGenerator.test.js and the images in test/siteImages.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PAGES, REDIRECTS, NAV, LINE, FOOTER_LINE, FORBIDDEN, PILOT, THEME_COLOR, TITLE_SUFFIX, TITLE_MAX, DESCRIPTION_MAX,
  fullTitle, rootFor, cspFor, socialAlt, ancestorsOf, textOf, isPlaceholderHost, validateSite, siteUrlReport, listedPages,
} from '../scripts/site-pages.mjs';
import { pngSize, parseIco } from '../scripts/favicons.mjs';
import { MIME, ROOT_FILES, MISSING_PATHS, resolvePath, startPagesServer } from '../scripts/site-check.mjs';
import { SITE } from '../site/config.js';
import { copyProblems } from './copyGuards.js';
import { LEGAL, isPlaceholderUrl } from '../extension/src/legalLinks.js';
import { honestyProblems, offPricing } from './honesty.js';
const LEGAL_DRAFT = JSON.parse(readFileSync(new URL('../legal/legal-status.json', import.meta.url), 'utf8')).draft === true;

const root = fileURLToPath(new URL('..', import.meta.url));
const SITE_DIR = join(root, 'site');
const read = (rel) => readFileSync(join(root, rel), 'utf8');
const pricing = JSON.parse(read('site/pricing.json'));
const money = (n) => '$' + Number(n).toLocaleString('en-US');
const notFoundPage = PAGES.find((p) => p.kind === 'notFound');
const home = PAGES.find((p) => p.slug === 'home');

// ---------- reading a page ----------

const cache = new Map();
const htmlOf = (page) => {
  if (!cache.has(page.slug)) cache.set(page.slug, read(page.file));
  return cache.get(page.slug);
};
const between = (html, open, close) => {
  const start = html.indexOf(open);
  assert.ok(start >= 0, `${open} is not in the page`);
  const end = html.indexOf(close, start);
  assert.ok(end >= 0, `${close} does not follow ${open}`);
  return html.slice(start, end + close.length);
};
const headOf = (html) => between(html, '<head>', '</head>');
const bodyOf = (html) => between(html, '<body>', '</body>');
const unattr = (s) => String(s).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
// every <name ...> tag as its attributes ({ _: the raw attribute text })
const tagsOf = (html, name) => [...html.matchAll(new RegExp(`<${name}\\b([^>]*)>`, 'g'))].map((m) => {
  const out = { _: m[1] };
  for (const a of m[1].matchAll(/([\w:-]+)="([^"]*)"/g)) out[a[1]] = unattr(a[2]);
  return out;
});
const metas = (html) => tagsOf(headOf(html), 'meta');
const meta = (html, key) => metas(html).filter((m) => m.name === key || m.property === key).map((m) => m.content);
const links = (html) => tagsOf(headOf(html), 'link');
const title = (html) => unattr((html.match(/<title>([^<]*)<\/title>/) || [, ''])[1]);
const cspOf = (html) => metas(html).filter((m) => m['http-equiv'] === 'Content-Security-Policy').map((m) => m.content);
const jsonLdOf = (html) => [...headOf(html).matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
const visibleText = (page) => textOf(bodyOf(htmlOf(page)));
const crumbNames = (page) => [...ancestorsOf(page).map((a) => (a.path === '/' ? 'Home' : a.crumb)), ...(page.crumb ? [page.crumb] : [])];

// Where a reference on a page points: an anchor on the page, an inbox, an
// absolute address, or a file under site/ (a directory is its index.html);
// a file reference may carry an #anchor into that file.
function resolveRef(page, ref) {
  if (ref.startsWith('#')) return { kind: 'anchor', id: ref.slice(1), file: join(root, page.file) };
  if (/^mailto:/i.test(ref)) return { kind: 'mailto', value: ref };
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//')) return { kind: 'absolute', value: ref };
  const [pathPart, hash] = ref.split('#');
  const clean = pathPart.split('?')[0];
  const from = clean.startsWith('/') ? SITE_DIR : dirname(join(root, page.file));
  let file = clean ? normalize(join(from, clean)) : join(root, page.file);
  if (file !== SITE_DIR && !file.startsWith(SITE_DIR + sep)) return { kind: 'outside', file };
  if (existsSync(file) && statSync(file).isDirectory()) {
    if (clean && !clean.endsWith('/')) return { kind: 'slashless', file };
    file = join(file, 'index.html');
  }
  return { kind: 'file', file, id: hash || null, exists: existsSync(file) };
}
const refsOf = (html) => [...html.matchAll(/\b(href|src|action)="([^"]*)"/g)].map((m) => ({ attr: m[1], value: unattr(m[2]) }));

// every file under dir (relative to the repo root), recursively
function walk(dir, out = []) {
  for (const d of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (d.isDirectory()) walk(`${dir}/${d.name}`, out);
    else out.push(`${dir}/${d.name}`);
  }
  return out;
}
const BINARY = /\.(png|ico|jpe?g|webp|gif|woff2?)$/i;

// ---------- the pages ----------

test('every page of the map is a committed file with the title, description and one h1 the map gives it', () => {
  assert.ok(PAGES.length >= 11, 'the map has the planned pages');
  const titles = new Set();
  const descriptions = new Set();
  for (const p of PAGES) {
    assert.ok(existsSync(join(root, p.file)), `${p.file} is missing: run npm run site-pages and npm run legal-pages`);
    const html = htmlOf(p);
    const want = fullTitle(p);
    assert.equal(title(html), want, `${p.file}: the <title>`);
    assert.ok(want.endsWith(TITLE_SUFFIX) && want.length <= TITLE_MAX, `${p.file}: "${want}" is ${want.length} characters (at most ${TITLE_MAX}, brand last)`);
    assert.doesNotMatch(want, FORBIDDEN, `${p.file}: the tab would say "${(want.match(FORBIDDEN) || [])[0]}"`);
    titles.add(want.toLowerCase());
    const [description, ...more] = meta(html, 'description');
    assert.equal(more.length, 0, `${p.file}: one meta description`);
    assert.equal(description, p.description, `${p.file}: the meta description is the map's`);
    assert.ok(description.length > 0 && description.length <= DESCRIPTION_MAX, `${p.file}: the description is ${description.length} characters`);
    descriptions.add(description.toLowerCase());
    if (p.kind !== 'legal') assert.ok(visibleText(p).includes(p.description), `${p.file}: the description is a sentence of the page, word for word`);
    assert.equal((html.match(/<h1\b/g) || []).length, 1, `${p.file}: exactly one h1`);
    const h1 = textOf(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)[1]);
    if (p.h1) assert.equal(h1, p.h1, `${p.file}: the h1`);
    else assert.ok(h1.length > 0, `${p.file}: the h1 has text`);
    const firstH2 = html.indexOf('<h2');
    assert.ok(firstH2 < 0 || html.indexOf('<h1') < firstH2, `${p.file}: the h1 comes before any other heading`);
    assert.match(html, new RegExp(`^<html lang="en" data-root="${rootFor(p).replace(/\./g, '\\.')}">$`, 'm'), `${p.file}: <html lang data-root>`);
    assert.ok(html.startsWith('<!doctype html>\n<!-- Written by scripts/'), `${p.file} is a generated file that says so`);
    const m = metas(html);
    assert.ok(m.some((x) => x.charset === 'utf-8'), `${p.file}: charset`);
    assert.ok(m.some((x) => x.name === 'viewport' && x.content === 'width=device-width, initial-scale=1'), `${p.file}: viewport`);
    assert.ok(m.some((x) => x.name === 'color-scheme' && x.content === 'light dark'), `${p.file}: color-scheme`);
    assert.ok(m.some((x) => x.name === 'theme-color' && x.content === THEME_COLOR), `${p.file}: theme-color ${THEME_COLOR}`);
  }
  assert.equal(titles.size, PAGES.length, 'every title is unique');
  assert.equal(descriptions.size, PAGES.length, 'every description is unique');
});

test('canonical, share and favicon tags follow the siteUrl state on every page; the 404 page carries noindex and nothing shared', () => {
  const set = Boolean(SITE.siteUrl);
  for (const p of PAGES) {
    const html = htmlOf(p);
    const notFound = p.kind === 'notFound';
    const canonical = links(html).filter((l) => l.rel === 'canonical').map((l) => l.href);
    assert.deepEqual(canonical, set && !notFound ? [SITE.siteUrl + p.path] : [], `${p.file}: canonical ${set ? 'is siteUrl + path' : 'is left out while siteUrl is not set'}`);
    const draftLegal = p.kind === 'legal' && LEGAL_DRAFT;
    assert.deepEqual(meta(html, 'robots'), notFound || draftLegal ? ['noindex'] : [], `${p.file}: robots noindex on the 404 page and on a legal text still marked draft, nowhere else`);
    const og = Object.fromEntries(metas(html).filter((m) => m.property && m.property.startsWith('og:')).map((m) => [m.property, m.content]));
    const tw = Object.fromEntries(metas(html).filter((m) => m.name && m.name.startsWith('twitter:')).map((m) => [m.name, m.content]));
    if (notFound) {
      assert.deepEqual(og, {}, `${p.file}: no Open Graph tags`);
      assert.deepEqual(tw, {}, `${p.file}: no Twitter tags`);
      assert.equal(jsonLdOf(html).length, 0, `${p.file}: no structured data`);
      continue;
    }
    const short = fullTitle(p).slice(0, -TITLE_SUFFIX.length);
    assert.equal(og['og:type'], 'website', `${p.file}: og:type`);
    assert.equal(og['og:site_name'], 'Lot Current', `${p.file}: og:site_name`);
    assert.equal(og['og:title'], short, `${p.file}: og:title`);
    assert.equal(og['og:description'], p.description, `${p.file}: og:description`);
    assert.equal(tw['twitter:card'], 'summary_large_image', `${p.file}: twitter:card`);
    assert.equal(tw['twitter:title'], short, `${p.file}: twitter:title`);
    assert.equal(tw['twitter:description'], p.description, `${p.file}: twitter:description`);
    if (set) {
      assert.equal(og['og:url'], SITE.siteUrl + p.path, `${p.file}: og:url`);
      assert.equal(og['og:image'], `${SITE.siteUrl}/social/${p.slug}.png`, `${p.file}: og:image`);
      assert.equal(og['og:image:width'], '1200', `${p.file}: og:image:width`);
      assert.equal(og['og:image:height'], '630', `${p.file}: og:image:height`);
      assert.equal(og['og:image:alt'], socialAlt(p), `${p.file}: og:image:alt`);
    } else {
      for (const k of ['og:url', 'og:image', 'og:image:width', 'og:image:height', 'og:image:alt']) assert.equal(og[k], undefined, `${p.file}: no ${k} while siteUrl is not set (no invented address)`);
    }
    const icons = links(html).filter((l) => l.rel === 'icon' || l.rel === 'apple-touch-icon');
    assert.deepEqual(icons.map((l) => [l.rel, l.href, l.type || '', l.sizes || '']), [
      ['icon', `${rootFor(p)}favicon.svg`, 'image/svg+xml', ''],
      ['icon', `${rootFor(p)}favicon-32.png`, 'image/png', '32x32'],
      ['apple-touch-icon', `${rootFor(p)}apple-touch-icon.png`, '', ''],
    ], `${p.file}: the favicon links through the page's root`);
    for (const l of icons) assert.ok(resolveRef(p, l.href).exists, `${p.file}: ${l.href} resolves to a file`);
  }
  // the 404 page's favicons too, root-relative because Pages serves it at any depth
  for (const l of links(htmlOf(notFoundPage))) {
    assert.ok(l.href.startsWith('/'), `${notFoundPage.file}: ${l.href} is root-relative`);
    assert.ok(resolveRef(notFoundPage, l.href).exists, `${notFoundPage.file}: ${l.href} resolves`);
  }
});

test('the site nav, the breadcrumbs and the footer are the same on every page, marking where the page is', () => {
  for (const p of PAGES) {
    const html = htmlOf(p);
    const r = rootFor(p);
    const href = (path) => r + path.replace(/^\//, '');
    assert.match(html, /<a class="skip" href="#main">Skip to content<\/a>/, `${p.file}: the skip link`);
    assert.match(html, /<main id="main">/, `${p.file}: the main landmark`);
    const header = between(html, '<header class="top">', '</header>');
    assert.ok(header.includes(`<a class="brand" href="${r}">Lot Current <small>`), `${p.file}: the brand link goes to the home page`);
    const nav = between(header, '<nav aria-label="Site">', '</nav>');
    const items = [...nav.matchAll(/<li><a href="([^"]*)"( aria-current="page")?>([^<]*)<\/a><\/li>/g)].map((m) => [m[1], m[3], Boolean(m[2])]);
    assert.deepEqual(items, NAV.map((n) => [href(n.path), n.nav, n === p]), `${p.file}: the nav is NAV in order, aria-current on this page only`);
    assert.equal((nav.match(/<li>/g) || []).length, NAV.length, `${p.file}: no other nav item`);
    // the breadcrumb trail on every page with a crumb: Home, each ancestor as a link, the page itself as the current item
    const crumbs = html.match(/<nav class="crumbs" aria-label="Breadcrumb">[\s\S]*?<\/nav>/g) || [];
    if (!p.crumb) {
      assert.equal(crumbs.length, 0, `${p.file}: no breadcrumbs on ${p.slug}`);
    } else {
      assert.equal(crumbs.length, 1, `${p.file}: one breadcrumb trail`);
      assert.match(crumbs[0], /<nav class="crumbs" aria-label="Breadcrumb">\s*<div class="wrap">\s*<ol>/, `${p.file}: nav.crumbs > div.wrap > ol`);
      const lis = [...crumbs[0].matchAll(/<li( aria-current="page")?>(?:<a href="([^"]*)">)?([^<]*)(?:<\/a>)?<\/li>/g)].map((m) => ({ current: Boolean(m[1]), href: m[2] || null, name: m[3] }));
      const trail = [...ancestorsOf(p), p];
      assert.deepEqual(lis, trail.map((t, i) => ({ current: t === p, href: t === p ? null : href(t.path), name: i === 0 ? 'Home' : t.crumb })), `${p.file}: the trail is the address's ancestors then the page, the last item current and not a link`);
      assert.equal(lis[0].name, 'Home');
      for (const a of ancestorsOf(p)) assert.ok(p.path.startsWith(a.path), `${a.path} is above ${p.path}`);
    }
    const footer = between(html, '<footer>', '</footer>');
    assert.deepEqual([...footer.matchAll(/<a href="([^"]*)">([^<]*)<\/a>/g)].map((m) => [m[1], m[2]]), [
      [`${r}legal/terms/`, 'Terms of service'], [`${r}legal/privacy/`, 'Privacy policy'], [`${r}legal/posting-rules/`, 'Posting rules'],
    ], `${p.file}: the footer links exactly the three legal pages`);
    assert.ok(footer.includes(`<p>${FOOTER_LINE}</p>`), `${p.file}: the non-affiliation line in the footer`);
    assert.equal((html.match(/<footer>/g) || []).length, 1, `${p.file}: one footer`);
  }
});

test('every link, image, stylesheet, script and form action resolves; every public page is reachable from home; nothing points elsewhere', () => {
  const allowedMailto = new Set([SITE.demoMailto, SITE.supportEmail ? `mailto:${SITE.supportEmail}` : ''].filter(Boolean));
  const linkedPages = new Map(PAGES.map((p) => [p.file, new Set()]));
  for (const p of PAGES) {
    const html = htmlOf(p);
    const refs = refsOf(html);
    assert.ok(refs.length > 10, `${p.file}: has links`);
    for (const { attr, value } of refs) {
      const ref = resolveRef(p, value);
      if (ref.kind === 'anchor') {
        assert.match(html, new RegExp(`\\bid="${ref.id}"`), `${p.file}: #${ref.id} is on the page`);
      } else if (ref.kind === 'mailto') {
        assert.ok(allowedMailto.has(ref.value), `${p.file}: ${ref.value} is not an inbox from config.js`);
      } else if (ref.kind === 'absolute') {
        assert.ok(SITE.siteUrl && ref.value.startsWith(SITE.siteUrl + '/') && attr === 'href', `${p.file}: ${attr}="${ref.value}" points off the site`);
      } else {
        assert.equal(ref.kind, 'file', `${p.file}: ${attr}="${value}" ${ref.kind === 'slashless' ? 'names a directory without its slash (a redirect on Pages)' : 'leaves site/'}`);
        assert.ok(ref.exists, `${p.file}: ${attr}="${value}" resolves to nothing under site/`);
        if (ref.id) assert.match(readFileSync(ref.file, 'utf8'), new RegExp(`\\bid="${ref.id}"`), `${p.file}: ${value}: #${ref.id} is on the target page`);
        const rel = relative(root, ref.file);
        if (linkedPages.has(rel) && attr === 'href') linkedPages.get(p.file).add(rel);
      }
      if (p.kind === 'notFound' && ref.kind === 'file') assert.ok(value.startsWith('/'), `${p.file}: ${value} is root-relative (Pages serves 404.html at any depth)`);
      if (p.kind !== 'notFound' && ref.kind === 'file') assert.ok(!value.startsWith('/'), `${p.file}: ${value} is relative through the page's root, never root-relative`);
    }
    // nothing loaded or named from anywhere else: the only absolute addresses are the canonical and share tags
    // (siteUrl), the structured data's vocabulary and the policy's allowed host
    const rest = html
      .replace(/<meta http-equiv="Content-Security-Policy" content="[^"]*">/, '')
      .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, '')
      .replace(/<(link rel="canonical"|meta property="og:(url|image)") [^>]*>/g, '');
    assert.doesNotMatch(rest, /https?:\/\/|\/\/[a-z0-9-]+\.[a-z]/i, `${p.file}: an address off the site`);
    for (const block of jsonLdOf(html)) {
      for (const u of JSON.stringify(block).matchAll(/https?:\/\/[^"\\]*/g)) assert.ok(u[0] === 'https://schema.org' || (SITE.siteUrl && u[0].startsWith(SITE.siteUrl)), `${p.file}: ${u[0]} in the structured data`);
    }
  }
  // reachability: from home, following internal links
  const seen = new Set([home.file]);
  const queue = [home.file];
  while (queue.length) for (const next of linkedPages.get(queue.shift())) if (!seen.has(next)) { seen.add(next); queue.push(next); }
  for (const p of PAGES.filter((x) => x.sitemap)) assert.ok(seen.has(p.file), `${p.path} is not reachable from the home page by its links`);
  // the stylesheet and site.js name nothing elsewhere either
  assert.doesNotMatch(read('site/site.css'), /https?:\/\/|@import|url\(|@font-face/i, 'site.css loads nothing from elsewhere');
  assert.doesNotMatch(read('site/site.js'), /https?:\/\//i, 'site.js names no address of its own');
});

test('each page runs under its Content-Security-Policy variant, with nothing inline, nothing embedded and no other script', () => {
  const noScript = "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'";
  for (const p of PAGES) {
    const html = htmlOf(p);
    assert.deepEqual(cspOf(html), [cspFor(p, SITE)], `${p.file}: the policy is cspFor(page, config.js)`);
    if (!p.script) assert.equal(cspOf(html)[0], noScript, `${p.file}: a page without site.js runs under the no-script policy`);
    else assert.match(cspOf(html)[0], /^default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self' https:\/\/\*\.supabase\.co; object-src 'none'; base-uri 'none'; form-action (mailto:|'none')$/, `${p.file}: the script policy`);
    if (p.slug === 'home') assert.equal(cspOf(html)[0].endsWith(SITE.demoMailto ? 'form-action mailto:' : "form-action 'none'"), true, 'form-action mailto: only once config.js has an inbox');
    assert.doesNotMatch(bodyOf(html), /<style\b|\sstyle="|\son[a-z]+="/i, `${p.file}: no inline style or handler`);
    assert.doesNotMatch(html, /<(iframe|embed|object|frame)\b/i, `${p.file}: nothing embedded`);
    assert.doesNotMatch(html, /font-face|fonts\./i, `${p.file}: no web font`);
    const scripts = tagsOf(html, 'script').map((s) => s._);
    const expected = [...(p.kind === 'notFound' ? [] : [' type="application/ld+json"']), ...(p.script ? [` type="module" src="${rootFor(p)}site.js"`] : [])];
    assert.deepEqual(scripts, expected, `${p.file}: the structured-data block and, on script pages, site.js; nothing else`);
    const sheets = links(html).filter((l) => l.rel === 'stylesheet').map((l) => l.href);
    assert.deepEqual(sheets, [`${rootFor(p)}site.css`], `${p.file}: the one stylesheet`);
  }
});

// ---------- the files next to the pages ----------

test('robots.txt allows everything and names the sitemap once there is one; llms.txt lists every public page in the llmstxt.org shape', () => {
  const robots = read('site/robots.txt').split('\n');
  assert.deepEqual(robots.slice(0, 2), ['User-agent: *', 'Allow: /']);
  assert.deepEqual(robots.slice(2).filter(Boolean), SITE.siteUrl ? [`Sitemap: ${SITE.siteUrl}/sitemap.xml`] : [], 'the Sitemap line exists exactly when siteUrl is set');
  const llms = read('site/llms.txt');
  const lines = llms.split('\n');
  assert.equal(lines[0], '# Lot Current', 'an H1 first');
  assert.equal(lines[1], '');
  assert.match(lines[2], /^> \S/, 'a blockquote summary second');
  assert.match(lines[2], /clicks Publish/, 'the summary says who publishes');
  assert.ok(lines.includes('## Pages') && lines.includes('## Legal'), 'H2 sections');
  assert.ok(lines.indexOf('## Pages') < lines.indexOf('## Legal'));
  assert.match(llms, /not affiliated with Meta Platforms, Inc\./);
  assert.match(llms, /planned prices/);
  const listed = [];
  for (const line of lines.filter((l) => l.startsWith('- '))) {
    const m = line.match(/^- \[([^\]]+)\]\(([^)]+)\): (.+)$/);
    assert.ok(m, `a list line in the "- [name](url): description" shape: ${line}`);
    const page = PAGES.find((p) => (SITE.siteUrl ? SITE.siteUrl + p.path : p.path) === m[2]);
    assert.ok(page, `${m[2]} is a page of the map${SITE.siteUrl ? ' at its absolute address' : ' by its path'}`);
    assert.equal(m[1], page.nav || page.title, `${m[2]}: named as the nav or the title names it`);
    assert.equal(m[3], page.description, `${m[2]}: described with its description`);
    listed.push(page.path);
  }
  assert.deepEqual(listed, listedPages(LEGAL_DRAFT).map((p) => p.path), 'exactly the public pages, in map order, not the 404 page and not a legal text still marked draft');
  assert.ok(lines.findIndex((l) => l.startsWith(`- [Legal documents](${SITE.siteUrl}/legal/): `)) > lines.indexOf('## Legal'), 'the legal pages sit under ## Legal');
  assert.ok(lines.findIndex((l) => l.startsWith(`- [Support](${SITE.siteUrl}/support/): `)) < lines.indexOf('## Legal'), 'the other pages sit under ## Pages');
  for (const f of ['site/robots.txt', 'site/llms.txt']) assert.ok(read(f).endsWith('\n') && !read(f).includes('\r'), `${f} ends with a newline`);
});

test('siteUrl is not set: the site is not ready to publish', (t) => {
  // A reported condition, not a failure: this test passes in both states and checks that every file that
  // needs the site's address exists exactly when siteUrl is set, and that nothing invents one before then.
  const set = Boolean(SITE.siteUrl);
  t.diagnostic(siteUrlReport(SITE));
  assert.match(siteUrlReport(SITE), set ? /^siteUrl is https:\/\/\S+: canonical, og:url, og:image, sitemap\.xml and CNAME are written$/ : /^siteUrl is not set: the site is not ready to publish/);
  assert.equal(existsSync(join(SITE_DIR, 'sitemap.xml')), set, `site/sitemap.xml exists exactly when siteUrl is set (${set ? 'run npm run site-pages' : 'it would carry an invented address'})`);
  assert.equal(existsSync(join(SITE_DIR, 'CNAME')), set, 'site/CNAME exists exactly when siteUrl is set');
  const everything = PAGES.map((p) => htmlOf(p)).join('\n');
  assert.equal(/<link rel="canonical"/.test(everything), set, 'a canonical on the pages exactly when siteUrl is set');
  assert.equal(/property="og:url"/.test(everything), set, 'og:url exactly when siteUrl is set');
  assert.equal(/property="og:image"/.test(everything), set, 'og:image exactly when siteUrl is set');
  assert.equal(/^Sitemap: /m.test(read('site/robots.txt')), set, 'robots.txt names the sitemap exactly when siteUrl is set');
  assert.equal(/\]\(https:\/\//.test(read('site/llms.txt')), set, 'llms.txt links absolute addresses exactly when siteUrl is set');
  if (set) {
    const xml = read('site/sitemap.xml');
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
    assert.deepEqual([...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]), listedPages(LEGAL_DRAFT).map((p) => SITE.siteUrl + p.path), 'the sitemap lists exactly the public pages, without draft legal texts');
    assert.doesNotMatch(xml, /<lastmod>|<changefreq>|<priority>/, 'no invented dates or priorities');
    assert.equal(read('site/CNAME'), new URL(SITE.siteUrl).hostname + '\n', 'CNAME is the host');
    for (const r of REDIRECTS) assert.ok(read(r.file).includes(`<link rel="canonical" href="${SITE.siteUrl}${r.target}">`), `${r.file} carries the new address as canonical`);
  } else {
    for (const r of REDIRECTS) assert.doesNotMatch(read(r.file), /canonical/, `${r.file} carries no canonical while siteUrl is not set`);
  }
  // the owner's checklist and the website doc carry the condition by its exact words
  assert.match(read('docs/launch-checklist.md'), /siteUrl is not set: the site is not ready to publish/, 'docs/launch-checklist.md names the condition');
  assert.match(read('docs/website.md'), /siteUrl is not set: the site is not ready to publish/, 'docs/website.md names the condition');
});

// ---------- the structured data ----------

test('the structured data on every page parses, names schema.org as its vocabulary, carries the nodes the map says, and invents nothing', () => {
  const businessFilled = Boolean(SITE.business && SITE.business.name && SITE.business.streetAddress);
  for (const p of PAGES) {
    const html = htmlOf(p);
    const blocks = jsonLdOf(html);
    if (p.kind === 'notFound') {
      assert.equal(blocks.length, 0);
      continue;
    }
    assert.equal(blocks.length, 1, `${p.file}: one structured-data block`);
    const [data] = blocks;
    assert.equal(data['@context'], 'https://schema.org', `${p.file}: @context`);
    assert.ok(Array.isArray(data['@graph']) && data['@graph'].length, `${p.file}: @graph`);
    const types = data['@graph'].map((n) => n['@type']);
    for (const n of data['@graph']) assert.equal(typeof n['@type'], 'string', `${p.file}: every node has an @type`);
    const expected = p.jsonld.map((t) => (t === 'Organization' && businessFilled ? 'LocalBusiness' : t));
    assert.deepEqual(types, expected, `${p.file}: the nodes the map names, in order`);
    const text = JSON.stringify(data);
    assert.doesNotMatch(text, /aggregateRating|"review"|ratingValue|reviewCount|"Review"/, `${p.file}: no rating or review`);
    if (!businessFilled) assert.doesNotMatch(text, /"telephone"|"address"|openingHours|"PostalAddress"|"areaServed"/, `${p.file}: no address, phone or hours until config.js has them`);
    if (pricing.hypothesis !== false) assert.doesNotMatch(text, /"offers"|"price"|"Offer"/, `${p.file}: no offer while pricing.json is a hypothesis`);
    if (!SITE.siteUrl) assert.doesNotMatch(text, /"url"|"logo"|"item"/, `${p.file}: no address while siteUrl is not set`);
    if (p.slug === 'home') {
      const org = data['@graph'][0];
      assert.equal(org['@type'], businessFilled ? 'LocalBusiness' : 'Organization');
      assert.equal(org.name, businessFilled ? SITE.business.name.trim() : 'Lot Current');
      if (businessFilled) {
        assert.equal(org.address['@type'], 'PostalAddress');
        for (const k of ['streetAddress', 'addressLocality', 'addressRegion', 'postalCode', 'addressCountry']) assert.equal(org.address[k], SITE.business[k].trim(), `LocalBusiness ${k} is config.js's`);
      }
      const web = data['@graph'].find((n) => n['@type'] === 'WebSite');
      assert.equal(web.name, 'Lot Current');
      const app = data['@graph'].find((n) => n['@type'] === 'SoftwareApplication');
      assert.equal(app.name, 'Lot Current');
      assert.equal(app.applicationCategory, 'BusinessApplication');
      assert.equal(app.operatingSystem, 'Chrome');
      assert.equal(app.description, p.description);
      if (pricing.hypothesis === false) assert.deepEqual(app.offers, { '@type': 'Offer', price: pricing.perRooftopMonthly, priceCurrency: pricing.currency }, 'the offer is pricing.json\'s');
      else assert.equal(app.offers, undefined);
      if (SITE.siteUrl) for (const n of [org, web, app]) assert.equal(n.url, businessFilled && n === org && SITE.business.url ? SITE.business.url : SITE.siteUrl, `${n['@type']}.url`);
    }
    if (p.crumb) {
      const crumbs = data['@graph'].find((n) => n['@type'] === 'BreadcrumbList');
      assert.ok(crumbs, `${p.file}: a BreadcrumbList`);
      assert.deepEqual(crumbs.itemListElement.map((i) => [i['@type'], i.position, i.name]), crumbNames(p).map((name, i) => ['ListItem', i + 1, name]), `${p.file}: the list equals the visible trail`);
      const visible = [...between(html, '<nav class="crumbs"', '</nav>').matchAll(/<li[^>]*>(?:<a[^>]*>)?([^<]*)/g)].map((m) => m[1]);
      assert.deepEqual(crumbs.itemListElement.map((i) => i.name), visible, `${p.file}: the names are the breadcrumb's`);
      for (const [i, item] of crumbs.itemListElement.entries()) {
        const trail = [...ancestorsOf(p), p];
        assert.equal(item.item, SITE.siteUrl ? SITE.siteUrl + trail[i].path : undefined, `${p.file}: item ${i + 1}'s address`);
      }
    }
    if (p.slug === 'faq') {
      const faq = data['@graph'].find((n) => n['@type'] === 'FAQPage');
      const articles = [...bodyOf(html).matchAll(/<article class="qa">[\s\S]*?<h3>([\s\S]*?)<\/h3>([\s\S]*?)<\/article>/g)];
      assert.ok(articles.length >= 7, 'the seven questions');
      assert.deepEqual(faq.mainEntity.map((q) => q.name), articles.map((a) => textOf(a[1])), 'one Question per article.qa, named by its h3');
      for (const [i, q] of faq.mainEntity.entries()) {
        assert.equal(q['@type'], 'Question');
        assert.equal(q.acceptedAnswer['@type'], 'Answer');
        assert.equal(q.acceptedAnswer.text, textOf(articles[i][2]), `${q.name}: the answer is the article's text`);
      }
    }
  }
});

// ---------- nothing unfinished ----------

test('no unfinished work ships: no framework name, placeholder, invented address, pilot value, source map or big script under site/ or site-src/', () => {
  const files = [...walk('site'), ...walk('site-src')];
  assert.ok(files.length > 40);
  for (const f of files) {
    assert.doesNotMatch(f, /\.map$/, `${f}: a source map`);
    if (/\.(m?js)$/.test(f)) {
      assert.ok(statSync(join(root, f)).size <= 50 * 1024, `${f} is ${statSync(join(root, f)).size} bytes; keep scripts under 50 KB`);
    }
    if (BINARY.test(f)) continue;
    const text = read(f);
    const hit = text.match(FORBIDDEN);
    assert.equal(hit, null, `${f} contains "${hit && hit[0]}"`);
    const pilot = text.match(PILOT);
    assert.equal(pilot, null, `${f} contains the pilot value "${pilot && pilot[0]}"`);
    if (/\.(m?js|css)$/.test(f)) assert.doesNotMatch(text, /sourceMappingURL/, `${f} points at a source map`);
    // no social proof: "review" as a verb (the salesperson's own review, attorney review) is fine
    if (/\.html$/.test(f)) assert.doesNotMatch(text, /\b(testimonials?|customer reviews?|star[- ]rated|\d(\.\d)? stars?|rated \d|trusted by|as seen (in|on))\b/i, `${f}: no testimonial, review or trust claim`);
  }
  assert.ok(statSync(join(SITE_DIR, 'site.js')).size < 12 * 1024, 'site.js stays small');
  for (const p of PAGES) assert.doesNotMatch(title(htmlOf(p)), /\b(Vite|React)\b|\+ /, `${p.file}: the tab says the page, not a tool`);
  assert.ok(!existsSync(join(SITE_DIR, 'site.webmanifest')) && !existsSync(join(SITE_DIR, 'manifest.json')), 'no web manifest (nothing needs one, and every field in it would have to be true)');
});

// ---------- the images ----------

test('every image on every page has alt text that says what it shows, its size, and a PNG of that size behind it; every share image exists at 1200 x 630', () => {
  let images = 0;
  for (const p of PAGES) {
    for (const img of tagsOf(htmlOf(p), 'img')) {
      images += 1;
      assert.ok('alt' in img, `${p.file}: <img${img._}> has no alt`);
      if (img.alt !== '') assert.ok(img.alt.trim().length >= 40, `${p.file}: the alt "${img.alt}" does not say what the image shows`);
      assert.match(img.width || '', /^\d+$/, `${p.file}: ${img.src} has a width`);
      assert.match(img.height || '', /^\d+$/, `${p.file}: ${img.src} has a height`);
      const ref = resolveRef(p, img.src);
      assert.ok(ref.kind === 'file' && ref.exists, `${p.file}: ${img.src} resolves to a file under site/`);
      assert.deepEqual(pngSize(readFileSync(ref.file)), { width: Number(img.width), height: Number(img.height) }, `${p.file}: ${img.src} is the size its attributes say`);
      assert.equal(img.loading, 'lazy', `${p.file}: ${img.src} loads lazily`);
    }
  }
  assert.ok(images >= 5, 'the home page shows the five sandbox screens');
  const social = JSON.parse(read('site/social/images.json'));
  for (const p of PAGES) {
    if (!p.social) continue;
    const file = `site/social/${p.slug}.png`;
    assert.ok(existsSync(join(root, file)), `${file} is missing: run npm run social-images`);
    const buf = readFileSync(join(root, file));
    assert.deepEqual(pngSize(buf), { width: 1200, height: 630 }, `${file} is 1200 x 630`);
    assert.ok(buf.length <= 300 * 1024, `${file} is ${buf.length} bytes; at most 300 KB`);
    assert.equal(social[p.path] && social[p.path].alt, socialAlt(p), `${p.path}: images.json and socialAlt(page) say the same sentence`);
    assert.equal(social[p.path].path, `/social/${p.slug}.png`);
  }
  assert.deepEqual(Object.keys(social), PAGES.filter((p) => p.social).map((p) => p.path), 'images.json lists exactly the pages with a share image');
  assert.match(socialAlt(home), new RegExp(`"${LINE.replace(/\./g, '\\.')}"$`), 'the alt sentence ends with the line');
});

test('the favicon set: an SVG mark in the site\'s green and white, a 32 px PNG, a 180 px touch icon and an ICO with 16 and 32 px entries', () => {
  const svg = read('site/favicon.svg');
  assert.ok(svg.startsWith('<svg'), 'favicon.svg starts with <svg');
  assert.deepEqual([...new Set([...svg.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0].toLowerCase()))].sort(), ['#14532d', '#ffffff'], 'only the green and the white');
  assert.doesNotMatch(svg, /<(text|script|image|style|a)\b|url\(/i, 'a mark, not a letter, and nothing loaded');
  assert.deepEqual([...svg.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((m) => m[0]), ['http://www.w3.org/2000/svg'], 'the only address is the SVG namespace');
  assert.deepEqual(pngSize(readFileSync(join(SITE_DIR, 'favicon-32.png'))), { width: 32, height: 32 });
  assert.deepEqual(pngSize(readFileSync(join(SITE_DIR, 'apple-touch-icon.png'))), { width: 180, height: 180 });
  const ico = parseIco(readFileSync(join(SITE_DIR, 'favicon.ico')));
  assert.deepEqual(ico.map((e) => [e.width, e.height]), [[16, 16], [32, 32]], 'favicon.ico: a 16 and a 32 px entry');
  for (const e of ico) assert.deepEqual(pngSize(e.png), { width: e.width, height: e.height }, `the ${e.width} px entry is a PNG of that size`);
  const css = read('site/site.css').toLowerCase();
  const template = read('site-src/social/template.html');
  for (const c of new Set([...template.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0].toLowerCase()))) assert.ok(css.includes(c), `${c} in the share-image template is one of site.css's colours`);
  assert.doesNotMatch(template, /Facebook|Marketplace|\bMeta\b/, 'the share image names nothing of Meta\'s');
  assert.ok(template.includes(LINE), 'the share image carries the line');
  for (const [path] of ROOT_FILES) assert.ok(existsSync(join(SITE_DIR, path)), `${path} exists at the site root`);
});

// ---------- the old addresses ----------

test('the legal pages\' old addresses redirect: a stub per entry, sending the browser to a page that exists and loading nothing', () => {
  assert.equal(REDIRECTS.length, 3);
  for (const r of REDIRECTS) {
    assert.ok(existsSync(join(root, r.file)), `${r.file} is missing: run npm run legal-pages`);
    const html = read(r.file);
    const target = PAGES.find((p) => p.path === r.target);
    assert.ok(target && existsSync(join(root, target.file)), `${r.target} is a page that exists`);
    assert.ok(html.includes(`<meta http-equiv="refresh" content="0; url=${r.to}">`), `${r.file}: the meta refresh to ${r.to}`);
    assert.equal(normalize(join(dirname(join(root, r.file)), r.to, 'index.html')), join(root, target.file), `${r.file}: ${r.to} resolves to the target from the stub's own folder`);
    assert.ok(html.includes(`<a href="${r.to}">`), `${r.file}: a link for anyone whose browser does not follow the refresh`);
    assert.equal(title(html), `${r.label} has moved${TITLE_SUFFIX}`, `${r.file}: the title`);
    assert.equal((html.match(/<h1\b/g) || []).length, 1, `${r.file}: one h1`);
    assert.match(html, /<h1>This page has moved<\/h1>/);
    assert.match(html, /<meta name="robots" content="noindex">/, `${r.file}: not for the index`);
    assert.deepEqual(cspOf(html), ["default-src 'none'; base-uri 'none'; form-action 'none'"], `${r.file}: loads nothing at all`);
    assert.doesNotMatch(html, /<(link rel="stylesheet"|script|img)\b/, `${r.file}: no stylesheet, script or image`);
    assert.equal((html.match(/<link rel="canonical"/g) || []).length, SITE.siteUrl ? 1 : 0, `${r.file}: a canonical exactly when siteUrl is set`);
    assert.doesNotMatch(html, FORBIDDEN);
  }
  // the comment in the extension's legal links names those directory addresses for when the host exists
  // (its values are checked in the next test)
  assert.match(read('extension/src/legalLinks.js'), /\/legal\/terms\/[\s\S]*\/legal\/privacy\/[\s\S]*\/legal\/posting-rules\//, 'legalLinks.js\'s comment names the new addresses');
});

// What extension/src/legalLinks.js may hold: three placeholders nobody can host (the wizard and Settings then
// record no acceptance), or the three legal pages' addresses on siteUrl's host, with a new edition, once
// legal/legal-status.json says the texts are final. Anything else links salespeople to a page that is not
// there, or records an acceptance of a draft marked "not in effect".
const LEGAL_SOURCES = { termsUrl: 'legal/terms-of-service.md', privacyUrl: 'legal/privacy-policy.md', rulesUrl: 'legal/posting-rules.md' };
function legalLinkProblems(legal, siteUrl, status) {
  const keys = Object.keys(LEGAL_SOURCES);
  const placeholders = keys.filter((k) => isPlaceholderUrl(legal[k]));
  if (placeholders.length === keys.length) return [];
  const problems = [];
  if (placeholders.length) problems.push(`${placeholders.join(', ')} still a placeholder: switch all three addresses together`);
  if (!siteUrl) problems.push('siteUrl in site/config.js is not set, so no address can be checked');
  for (const k of keys) {
    const page = PAGES.find((p) => p.source === LEGAL_SOURCES[k]);
    const want = siteUrl + page.path;
    if (!isPlaceholderUrl(legal[k]) && legal[k] !== want) problems.push(`${k} is ${legal[k]}, not the page's address ${want}`);
  }
  if (!status || status.draft !== false) problems.push('legal/legal-status.json does not say "draft": false');
  if (/draft/i.test(String(legal.version))) problems.push(`version ${legal.version} is the draft edition: bump it with the addresses`);
  return problems;
}

test('the extension\'s legal links are placeholders, or the legal pages\' real addresses with a final edition', () => {
  const status = JSON.parse(read('legal/legal-status.json'));
  assert.deepEqual(legalLinkProblems(LEGAL, SITE.siteUrl, status), [], 'extension/src/legalLinks.js');
  // the Web Store listing names the same addresses (store/listing.md: "change both together")
  const listing = read('store/listing.md');
  for (const k of Object.keys(LEGAL_SOURCES)) assert.ok(listing.includes('`' + LEGAL[k] + '`'), `store/listing.md does not name ${k} ${LEGAL[k]}`);
  // the checker, on the edits it is there for
  const site = 'https://lot.test';
  const final = { draft: false };
  assert.deepEqual(legalLinkProblems({ version: 'x-draft', termsUrl: 'https://a.example/t', privacyUrl: 'https://a.example/p', rulesUrl: 'https://a.example/r' }, site, { draft: true }), [], 'placeholders are fine at any time');
  const good = { version: '2027-01-01', termsUrl: site + '/legal/terms/', privacyUrl: site + '/legal/privacy/', rulesUrl: site + '/legal/posting-rules/' };
  assert.deepEqual(legalLinkProblems(good, site, final), []);
  // the host swapped without the pages' paths: every link a 404
  const p1 = legalLinkProblems({ ...good, termsUrl: site + '/terms', privacyUrl: site + '/privacy', rulesUrl: site + '/posting-rules' }, site, final);
  assert.equal(p1.length, 3, p1.join('; '));
  assert.ok(legalLinkProblems({ ...good, termsUrl: 'https://www.lot.test/legal/terms/' }, site, final).some((p) => /termsUrl/.test(p)), 'another host than siteUrl');
  assert.ok(legalLinkProblems({ ...good, version: '2026-09-28-draft' }, site, final).some((p) => /draft edition/.test(p)), 'the version not bumped');
  assert.ok(legalLinkProblems(good, site, { draft: true }).some((p) => /legal-status/.test(p)), 'the texts still drafts');
  assert.ok(legalLinkProblems({ ...good, rulesUrl: 'https://a.example/r' }, site, final).some((p) => /rulesUrl still a placeholder/.test(p)), 'only some switched');
  assert.ok(legalLinkProblems(good, '', final).some((p) => /siteUrl/.test(p)), 'no siteUrl to check against');
});

// ---------- config.js, the form and the inboxes ----------

test('site/config.js validates, holds no placeholder, and the demo form and the support page follow it', () => {
  assert.doesNotThrow(() => validateSite(SITE));
  if (SITE.siteUrl) assert.equal(new URL(SITE.siteUrl).origin, SITE.siteUrl, 'siteUrl is an https origin with no path or trailing slash');
  for (const [key, host] of [['siteUrl', SITE.siteUrl && new URL(SITE.siteUrl).hostname], ['demoMailto', SITE.demoMailto.split('@')[1]], ['supportEmail', SITE.supportEmail.split('@')[1]], ['demoEndpoint', SITE.demoEndpoint && new URL(SITE.demoEndpoint).hostname]]) {
    if (host) assert.ok(!isPlaceholderHost(host), `${key} is on a reserved placeholder host (${host})`);
  }
  const config = read('site/config.js');
  assert.doesNotMatch(config, /\.example\b|example\.(com|org|net)|yourdomain|placeholder/i, 'config.js carries no placeholder, in its values or its comments');
  // an inbox only on the site's own domain, and none before the site has one
  const domain = SITE.siteUrl ? new URL(SITE.siteUrl).hostname.replace(/^www\./, '') : null;
  for (const m of config.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) assert.equal(m[1].toLowerCase(), domain, `config.js names an inbox on ${m[1]}, not the site's own domain`);
  // the home page's demo form: in the HTML in every state (test/fn-lead.test.js reads its field names); hidden with the note while closed
  const html = htmlOf(home);
  const form = tagsOf(html, 'form')[0];
  assert.ok(form, 'the form is in the page');
  assert.equal(form.id, 'demo-form');
  const open = Boolean(SITE.demoEndpoint || SITE.demoMailto);
  assert.equal(/\shidden/.test(form._), !open, open ? 'the form shows' : 'the form is hidden while it is not open');
  assert.ok(html.includes(`<p id="demo-closed" class="notice"${open ? ' hidden' : ''}>The demo request form is not open yet.</p>`), 'the note shows exactly while the form is closed');
  if (SITE.demoMailto) {
    assert.equal(form.action, SITE.demoMailto, 'the form posts to the inbox from config.js');
    assert.equal(form.method, 'post');
    assert.equal(form.enctype, 'text/plain');
  } else {
    assert.ok(!('action' in form) && !('method' in form), 'no action until config.js names an inbox');
    assert.match(html, /<button type="submit" class="button" disabled>/, 'the submit button is disabled until site.js runs (form-action is \'none\')');
    assert.match(html, /<noscript><p class="muted">This form needs JavaScript\.<\/p><\/noscript>/);
  }
  assert.doesNotMatch(visibleText(home), /@[a-z0-9-]+\.[a-z]+/i, SITE.demoMailto ? 'the inbox is in the form action, not the text' : 'no address on the page while no inbox exists');
  // the support page
  const support = PAGES.find((p) => p.slug === 'support');
  const supportText = visibleText(support);
  if (SITE.supportEmail) {
    assert.ok(htmlOf(support).includes(`<a href="mailto:${SITE.supportEmail}">${SITE.supportEmail}</a>`), 'the support address is a mailto link');
  } else {
    assert.match(supportText, /a public support address will be listed here once it exists/, 'the support page says there is no public address yet');
    assert.doesNotMatch(htmlOf(support), /mailto:/, 'no address on the support page');
  }
  assert.match(supportText, /within one business day/, 'the support promise docs/support.md makes');
});

// ---------- pricing and honesty over every page ----------

// what no customer-facing page may say: the shared lists in test/honesty.js. The legal texts name the
// forbidden things only to deny them; those denials are read first, then the scan.
const DENIALS = [/not affiliated with, endorsed by or partnered with Meta/g, /no one can promise your account will never be restricted/g];
// What a page says besides its visible text: the head's title and every attribute a screen reader, a
// share card or a search engine reads out (alt, aria-label, title, and each meta tag's content,
// og:image:alt included). The sample car prices in the screenshots' alt text are not prices of ours, so
// an image's alt text is the one place the price check does not read (docs/website.md says so).
const attributeWords = (html) => [['<title>', title(html)], ...[...html.matchAll(/\s(alt|aria-label|title|content)="([^"]*)"/g)].map((m) => [m[1], unattr(m[2])])];
function pageHonesty(html) {
  const out = honestyProblems(textOf(bodyOf(html)), { denials: DENIALS });
  for (const [where, said] of attributeWords(html)) for (const problem of honestyProblems(said, { denials: DENIALS })) out.push(`${where}: ${problem}`);
  return out;
}

test('the prices on every page are pricing.json\'s, through data-pricing spans with fallback text, and no other figure', () => {
  const marketing = JSON.parse(read('marketing/pricing.json'));
  for (const [k, v] of Object.entries(pricing)) assert.deepEqual(v, marketing[k], `site/pricing.json's ${k} is marketing/pricing.json's`);
  for (const p of PAGES) {
    const html = htmlOf(p);
    const text = visibleText(p);
    assert.deepEqual(offPricing(text, pricing), [], `${p.file}: a price that is not from pricing.json`);
    for (const [where, said] of attributeWords(html)) if (where !== 'alt') assert.deepEqual(offPricing(said, pricing), [], `${p.file}: ${where}: a price that is not from pricing.json`);
    const spans = [...html.matchAll(/data-pricing="([^"]+)">([^<]*)</g)];
    if (p.slug === 'home' || p.slug === 'pricing') {
      assert.ok(spans.length >= 4, `${p.file}: the pricing numbers are data-pricing spans`);
      assert.ok(text.includes(`${money(pricing.perRooftopMonthly)} per rooftop per month`), `${p.file}: the monthly price as fallback text`);
      assert.match(text, /planned pric/i, `${p.file}: labelled as planned pricing`);
      assert.match(text, /confirmed with you before any paid subscription/i, `${p.file}: confirmed before any paid subscription`);
    } else {
      assert.equal(spans.length, 0, `${p.file}: pricing numbers only on the home and pricing pages`);
      assert.doesNotMatch(text, /\$\d/, `${p.file}: no dollar figure`);
    }
    for (const [, key, fallback] of spans) {
      assert.ok(fallback.trim().length > 0, `${p.file}: data-pricing="${key}" has fallback text`);
      assert.ok(key === 'foundingDealerTerm' || key in pricing, `${p.file}: data-pricing="${key}" is a pricing.json field`);
    }
    if (p.script) assert.ok(spans.length > 0, `${p.file}: a page that loads site.js has numbers for it to fill`);
    if (!p.script) assert.equal(spans.length, 0, `${p.file}: no data-pricing span on a page without site.js`);
  }
  // the head and the labels are read too; an image's alt text is not (it describes sample cars' prices)
  const offPage = (html) => attributeWords(html).filter(([where]) => where !== 'alt').flatMap(([, said]) => offPricing(said, pricing));
  assert.deepEqual(offPage(htmlOf(home)), []);
  assert.deepEqual(offPage(htmlOf(home).replace(/(<meta name="description" content=")/, '$1Plans from $49/month. ')), ['$49'], 'a price in the description is caught');
  assert.deepEqual(offPage(htmlOf(home).replace(/(<title>)/, '$1From $79 monthly: ')), ['$79'], 'a price in the title is caught');
});

// test/copyGuards.js: what no customer-facing page may say (the legal texts name the forbidden things only to
// deny them; copyProblems reads those denials first, then scans the rest). pageHonesty (the lists in
// test/honesty.js) also reads each page's alt text, aria-labels, titles and share tags.

test('honest on every page: who clicks Publish, nothing guaranteed, the non-affiliation line, nothing that sounds like Meta approval', () => {
  for (const p of PAGES) {
    const said = visibleText(p);
    assert.ok(said.includes(FOOTER_LINE), `${p.file}: the non-affiliation line`);
    assert.deepEqual(copyProblems(said), [], p.file);
    assert.deepEqual(pageHonesty(htmlOf(p)), [], p.file);
  }
  // alt text and the head are read too: a claim there fails like one in the text
  const altClaim = htmlOf(home).replace(/(<img\b[^>]*\balt=")/, '$1Approved by Meta, and your account is safe: ');
  assert.ok(pageHonesty(altClaim).some((x) => x.startsWith('alt: ')), 'a claim in an image\'s alt text is caught');
  const headClaim = htmlOf(home).replace(/(<meta property="og:title" content=")/, '$1Meta-approved: ');
  assert.ok(pageHonesty(headClaim).some((x) => x.startsWith('content: ')), 'a claim in a share tag is caught');
  for (const slug of ['home', 'faq']) {
    const text = visibleText(PAGES.find((p) => p.slug === slug));
    assert.match(text, /Is this allowed on Facebook\?/, `${slug}: the question asked straight`);
    assert.match(text, /clicks? Publish/, `${slug}: the person clicks Publish`);
    assert.match(text, /Lot Current never does|never clicks Publish/, `${slug}: Lot Current never does`);
    assert.match(text, /safest design available/, `${slug}: the honest line`);
    assert.match(text, /not a guarantee/, `${slug}: not a guarantee`);
  }
  assert.ok(visibleText(home).includes(LINE), 'the home page carries the line');
  for (const slug of ['legal-terms', 'legal-posting-rules']) assert.match(visibleText(PAGES.find((p) => p.slug === slug)), /no (promise|guarantees?)|does not guarantee|no one can promise/i, `${slug}: promises nothing about Facebook`);
  // The deploy publishes site/ whole: every HTML file there (the redirect stubs, and anything the map does not
  // name, which site-pages --check also refuses) is held to the same lines, title and description included.
  const html = walk('site').filter((f) => f.endsWith('.html'));
  assert.ok(html.length >= PAGES.length + REDIRECTS.length);
  for (const f of html) {
    const doc = read(f);
    const said = [textOf(doc), ...[...doc.matchAll(/<meta\b[^>]*\bcontent="([^"]*)"/g)].map((m) => unattr(m[1]))].join(' ');
    assert.deepEqual(copyProblems(said), [], f);
  }
});

test('llms.txt and the share-image sentences pass the same honesty lists, and quote no other price', () => {
  // llms.txt is what AI assistants quote about Lot Current; the share sentences are each image's alt text
  // in images.json and the og:image:alt the pages carry once siteUrl is set
  const llmsProblems = (text) => [...honestyProblems(text), ...offPricing(text, pricing).map((f) => `${f} is not from pricing.json`)];
  const llms = read('site/llms.txt');
  assert.deepEqual(llmsProblems(llms), [], 'site/llms.txt');
  assert.notDeepEqual(llmsProblems(llms + '> Approved by Meta, and your account is safe.\n'), [], 'a claim added to llms.txt is caught');
  assert.notDeepEqual(llmsProblems(llms + '> From $49/month.\n'), [], 'a price added to llms.txt is caught');
  const social = JSON.parse(read('site/social/images.json'));
  for (const [path, { alt }] of Object.entries(social)) assert.deepEqual(llmsProblems(alt), [], `site/social/images.json ${path}`);
  for (const p of PAGES.filter((x) => x.social)) assert.deepEqual(llmsProblems(socialAlt(p)), [], `the share sentence of ${p.slug}`);
});

// ---------- the checks that need a browser, and their server ----------

test('the Pages-like server of scripts/site-check.mjs: directory indexes, 301 to the slashed address, 404.html with status 404, the MIME types', async () => {
  // the resolver, as a pure function over site/
  const at = (p) => resolvePath(SITE_DIR, p);
  assert.deepEqual(at('/'), { status: 200, file: join(SITE_DIR, 'index.html'), type: 'text/html; charset=utf-8' });
  assert.deepEqual(at('/pricing'), { status: 301, file: null, type: null, location: '/pricing/' });
  assert.equal(at('/pricing/').file, join(SITE_DIR, 'pricing', 'index.html'));
  assert.equal(at('/legal/terms.html').file, join(SITE_DIR, 'legal', 'terms.html'));
  assert.equal(at('/legal/terms').status, 301, 'the directory wins over terms.html, as on Pages');
  assert.deepEqual(at('/does-not-exist/'), { status: 404, file: join(SITE_DIR, '404.html'), type: 'text/html; charset=utf-8' });
  assert.equal(at('/legal/nothing/here/').status, 404);
  assert.equal(at('/../package.json').status, 404, 'nothing above the root');
  assert.equal(at('/%2e%2e/package.json').status, 404, 'nothing above the root, encoded');
  assert.equal(at('/favicon.ico').type, 'image/x-icon');
  assert.equal(at('/favicon.svg').type, 'image/svg+xml');
  assert.equal(at('/robots.txt').type, 'text/plain; charset=utf-8');
  assert.equal(at('/site.js').type, 'text/javascript; charset=utf-8');
  assert.equal(at('/pricing.json').type, 'application/json; charset=utf-8');
  assert.equal(at('/sitemap.xml').status, SITE.siteUrl ? 200 : 404);
  if (SITE.siteUrl) assert.equal(at('/sitemap.xml').type, 'application/xml; charset=utf-8');
  assert.deepEqual(Object.keys(MIME).sort(), ['.css', '.html', '.ico', '.js', '.json', '.mjs', '.png', '.svg', '.txt', '.xml'], 'the types a static site needs');
  assert.deepEqual([...MISSING_PATHS], ['/does-not-exist/', '/legal/does-not-exist/']);
  // the server itself, on a free port
  const server = await startPagesServer({ root: SITE_DIR, port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const get = async (path, init) => {
      const res = await fetch(base + path, { redirect: 'manual', ...init });
      return { status: res.status, type: res.headers.get('content-type'), location: res.headers.get('location'), body: await res.text() };
    };
    const index = await get('/');
    assert.equal(index.status, 200);
    assert.equal(index.type, 'text/html; charset=utf-8');
    assert.equal(index.body, htmlOf(home), 'the home page as committed');
    const slashless = await get('/faq');
    assert.deepEqual([slashless.status, slashless.location], [301, '/faq/']);
    assert.equal((await get('/faq?x=1')).location, '/faq/?x=1', 'the query survives the redirect');
    const missing = await get('/does-not-exist/');
    assert.equal(missing.status, 404);
    assert.equal(missing.type, 'text/html; charset=utf-8');
    assert.equal(missing.body, htmlOf(notFoundPage), 'the 404 page itself, with status 404');
    assert.equal((await get('/favicon.ico')).type, 'image/x-icon');
    assert.equal((await get('/llms.txt')).type, 'text/plain; charset=utf-8');
    assert.equal((await get('/legal/privacy.html')).body, read('site/legal/privacy.html'), 'a .html file at its name');
    assert.equal((await get('/', { method: 'POST' })).status, 405, 'only GET and HEAD');
    const head = await fetch(base + '/robots.txt', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  } finally {
    server.close();
  }
});

test('both generators\' --check modes pass on the committed files and print the siteUrl state', () => {
  const run = (script) => execFileSync(process.execPath, [join(root, 'scripts', script), '--check'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const pages = run('site-pages.mjs');
  assert.ok(pages.includes(siteUrlReport(SITE)), 'site-pages --check reports the siteUrl state');
  assert.match(pages, /The website pages match/);
  assert.match(run('legal-pages.mjs'), /The legal pages and their redirect stubs match/);
});

test('the browser checks cover every page: npm run test:site and npm run test:a11y read the site map, and CI runs both', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['test:site'], 'node scripts/site-check.mjs');
  assert.equal(pkg.scripts['test:a11y'], 'node scripts/a11y.mjs');
  assert.equal(pkg.scripts['site-pages'], 'node scripts/site-pages.mjs');
  const check = read('scripts/site-check.mjs');
  assert.match(check, /import \{ PAGES, REDIRECTS, NAV, fullTitle \} from '\.\/site-pages\.mjs';/, 'site-check.mjs walks the site map');
  assert.match(check, /for \(const entry of PAGES\)/, 'every page');
  assert.match(check, /for \(const r of REDIRECTS\)/, 'every redirect stub');
  assert.match(check, /MISSING_PATHS/, 'the missing addresses');
  assert.match(check, /m\.type\(\) !== 'error' && m\.type\(\) !== 'warning'/, 'console errors and warnings are findings');
  assert.match(check, /page\.on\('pageerror'/);
  assert.match(check, /page\.on\('requestfailed'/);
  assert.match(check, /r\.status\(\) < 400\) return;/, 'any response of 400 or more is a finding');
  assert.match(check, /await import\('playwright'\)/, 'Playwright is imported inside main(), so this test needs no browser');
  assert.match(check, /process\.env\.LOTSYNC_CHROME \|\| \(existsSync\(DEFAULT_CHROME\)/, 'the browser is resolved as scripts/a11y.mjs resolves it');
  const a11y = read('scripts/a11y.mjs');
  assert.match(a11y, /import \{ PAGES \} from '\.\/site-pages\.mjs';/, 'a11y.mjs walks the site map');
  assert.doesNotMatch(a11y, /legal-pages\.mjs/, 'a11y.mjs no longer reads the legal pages through legal-pages.mjs');
  assert.match(a11y, /startServer\(\{ port: 0, root: /, 'a second server rooted at site/ (the 404 page\'s links are root-relative)');
  assert.match(a11y, /for \(const entry of PAGES\)/, 'every page, legal and 404 included');
  assert.match(a11y, /width: 390, height: 844/, 'at a phone width too');
  const ci = read('.github/workflows/ci.yml');
  const a11yAt = ci.indexOf('- run: npm run test:a11y');
  const siteAt = ci.indexOf('- run: npm run test:site');
  assert.ok(a11yAt > 0 && siteAt > a11yAt, 'the demo job runs test:site after test:a11y');
  const pages = read('.github/workflows/pages.yml');
  assert.match(pages, /node scripts\/site-pages\.mjs --check[\s\S]*node scripts\/legal-pages\.mjs --check/, 'the Pages workflow refuses to deploy stale pages');
  // pages.yml does not wait for CI: the unit tests (the honesty rules, site/pricing.json against the marketing pricing) gate the upload themselves
  const steps = pages.split(/\n      - /);
  const unit = steps.findIndex((st) => /^run: npm test$/m.test(st));
  assert.ok(unit > 0, 'the Pages workflow runs npm test');
  assert.ok(unit < steps.findIndex((st) => /uses: actions\/upload-pages-artifact@/.test(st)), 'before anything is uploaded');
  assert.doesNotMatch(steps[unit], /continue-on-error|if:/, 'a failure stops the deploy');
  assert.doesNotMatch(pages, /run: npm (ci|install)/, 'npm test needs no dependencies');
  // it deploys from the repository's default branch, whatever its name, and only from there
  assert.doesNotMatch(pages, /branches:/, 'no branch name is written into the Pages workflow');
  assert.match(pages, /^ {4}if: github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)$/m, 'the deploy job runs only on the default branch');
  assert.match(pages, /path: site\n/, 'it deploys site/ and nothing else');
  // the browser checks run in CI's demo job, which nothing waits for: the doc says so rather than promising a gate before every merge
  const website = read('docs/website.md');
  assert.doesNotMatch(website, /before every merge/, 'no merge waits for npm run test:site');
  assert.match(website, /`npm run test:site` checks the same things against the committed files in a browser: CI's `demo` job runs it on every push and pull request, but neither a merge nor the deploy waits for it/);
});
