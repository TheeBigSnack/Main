// The Terms, the Privacy Policy and the posting rules as pages of the website
// (scripts/legal-pages.mjs). The committed pages are what the Markdown,
// legal/legal-status.json and site/config.js make now; every line of the
// Markdown is on its page; a draft says so at the top and in its title and a
// final page cannot keep a draft's blanks; the renderer escapes every piece
// of text and links only to safe places; each page carries the site's shared
// chrome (scripts/site-pages.mjs) at its new address, and a stub at the old
// address sends the browser on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PAGES, REDIRECTS, STATUS_FILE, CSP, REDIRECT_CSP, FOOTER_LINE, USAGE, escapeHtml, safeHref, renderInline, renderMarkdown, readStatus, renderPage, renderRedirect, stalePages, main,
} from '../scripts/legal-pages.mjs';
import { NAV, NO_SCRIPT_CSP, fullTitle, rootFor, ancestorsOf, readContext } from '../scripts/site-pages.mjs';
import { SITE } from '../site/config.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(join(root, rel), 'utf8');
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
// inline tags join their text to the words around them; block tags separate
const textOf = (html) => decode(html.replace(/<\/?(code|strong|em|a|span)\b[^>]*>/g, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
// Every tag the renderer and the page template write, with the attributes they may carry. Anything
// else (a script, an image, an event handler, a style) would be markup that came from the text.
const TAG = /^<(\/?)(html|head|meta|title|link|body|header|nav|main|footer|div|p|h[1-6]|ul|ol|li|table|thead|tbody|tr|th|td|code|strong|em|a|span|small)((?: (?:id|class|role|tabindex|aria-labelledby|aria-label|aria-current|scope|href|start|lang|charset|name|content|http-equiv|rel|type|sizes|property|data-root)="[^"<>]*")*)>$/;
const withoutData = (html) => html.replace(/<script type="application\/ld\+json">[^<]*<\/script>/g, '');
const strayTags = (html) => (withoutData(html).replace(/<!--[\s\S]*?-->/g, '').replace(/^<!doctype html>/, '').match(/<[^>]*>/g) || []).filter((t) => !TAG.test(t));
const between = (html, open, close) => {
  const start = html.indexOf(open);
  return start < 0 ? '' : html.slice(start, html.indexOf(close, start) + close.length);
};
const status = JSON.parse(read(STATUS_FILE));
const EMPTY_BUSINESS = { name: '', legalName: '', streetAddress: '', addressLocality: '', addressRegion: '', postalCode: '', addressCountry: '', telephone: '', email: '', url: '', openingHours: [], areaServed: '' };
const site = (over = {}) => ({ siteUrl: '', demoEndpoint: '', demoMailto: '', supportEmail: '', signupUrl: '', business: { ...EMPTY_BUSINESS }, ...over });
const pricing = JSON.parse(read('site/pricing.json'));
const ctxOf = (over) => ({ site: site(over), pricing });
// a fixture host for this test only (the generator refuses the reserved placeholder names)
// A subdomain of the site's own domain: a real-shaped host the generator
// accepts (it refuses reserved names), owned by the business, different from
// the committed siteUrl.
const FIXTURE_URL = 'https://fixture.lotcurrent.com';

test('the committed pages and stubs are what the Markdown, legal/legal-status.json and site/config.js make now (npm run legal-pages)', async () => {
  assert.deepEqual(await stalePages(), [], 'a file differs from its sources: run npm run legal-pages and commit the pages');
});

test('the three documents are the legal entries of the site map, at directory addresses, with a stub at each old address', () => {
  assert.deepEqual(PAGES.map((p) => [p.source, p.file, p.path, p.crumb]), [
    ['legal/terms-of-service.md', 'site/legal/terms/index.html', '/legal/terms/', 'Terms of service'],
    ['legal/privacy-policy.md', 'site/legal/privacy/index.html', '/legal/privacy/', 'Privacy policy'],
    ['legal/posting-rules.md', 'site/legal/posting-rules/index.html', '/legal/posting-rules/', 'Posting rules'],
  ]);
  for (const p of PAGES) assert.equal(p.kind, 'legal');
  assert.deepEqual(REDIRECTS.map((r) => [r.file, r.to, r.target, r.label]), [
    ['site/legal/terms.html', 'terms/', '/legal/terms/', 'Terms of service'],
    ['site/legal/privacy.html', 'privacy/', '/legal/privacy/', 'Privacy policy'],
    ['site/legal/posting-rules.html', 'posting-rules/', '/legal/posting-rules/', 'Posting rules'],
  ]);
  assert.equal(CSP, NO_SCRIPT_CSP);
  assert.equal(CSP, "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'");
  assert.equal(REDIRECT_CSP, "default-src 'none'; base-uri 'none'; form-action 'none'");
});

test('legal-status.json says whether the texts are drafts, and says what that means', () => {
  assert.equal(typeof status.draft, 'boolean');
  assert.match(status.note, /draft under attorney review/);
  assert.match(status.note, /not in effect/);
  assert.match(status.note, /npm run legal-pages/, 'the note says to rerun the script');
  assert.deepEqual(readStatus(read(STATUS_FILE)), { draft: status.draft });
  for (const bad of ['{"draft":"no"}', '{}', 'null', 'not json']) assert.throws(() => readStatus(bad), /legal-status\.json/, `${bad} is refused, not read as final`);
  const help = USAGE.join('\n');
  for (const re of [/legal-status\.json/, /"draft" is true/, /not in effect/, /attorney approves/, /set "draft" to\s+false and run this again/, /legalLinks\.js/, /\/legal\/terms\/, \/legal\/privacy\/, \/legal\/posting-rules\//, /redirect stubs/]) assert.match(help, re, `--help: ${re}`);
});

test('while the status says draft, every page opens with the banner and its title says draft before the brand', () => {
  for (const entry of PAGES) {
    const html = read(entry.file);
    const main = between(html, '<main id="main">', '</main>');
    const first = main.match(/<div class="wrap narrow legal">\s*(<[^>]+>[\s\S]*?<\/p>)/);
    const title = html.match(/<title>([^<]*)<\/title>/)[1];
    assert.equal(title, fullTitle(entry, status.draft));
    if (status.draft) {
      assert.ok(first && first[1].startsWith('<p class="draft">'), `${entry.file}: the banner is the first thing in the page's main content`);
      assert.match(textOf(first[1]), /^Draft under attorney review\. Not in effect/, `${entry.file}: the banner says draft and not in effect`);
      assert.equal(title, `${entry.title} (draft) | Lot Current`, `${entry.file}: the title says draft`);
      assert.equal(html.match(/<meta property="og:title" content="([^"]*)">/)[1], `${entry.title} (draft)`);
    } else {
      assert.doesNotMatch(html, /class="draft"/, `${entry.file}: a final page has no draft banner`);
      assert.doesNotMatch(title, /draft/i);
    }
  }
});

test('every line of the Markdown is on its page: headings, paragraphs, list items and each table cell', () => {
  // the Markdown as a reader sees it: markers and emphasis gone, a link's text kept
  const visible = (s) => s
    .replace(/\\([!-/:-@[-`{-~])/g, '$1')
    .replace(/\[([^\]]+)\]\([^)\s]*\)/g, '$1')
    .replace(/\*\*|`/g, '')
    .replace(/(^|[^\w*])\*(?!\s)([^*]+?)\*(?!\w)/g, '$1$2')
    .replace(/(^|\W)_(?!\s)([^_]+?)_(?!\w)/g, '$1$2')
    .replace(/\s+/g, ' ').trim();
  for (const entry of PAGES) {
    const page = textOf(between(read(entry.file), '<main id="main">', '</main>'));
    const md = read(entry.source).split('\n');
    let checked = 0;
    for (const line of md) {
      if (!line.trim() || /^ *\|? *:?-{3,}/.test(line)) continue;
      const parts = /^ *\|/.test(line)
        ? line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|'))
        : [line.replace(/^ *#{1,6} +/, '').replace(/^ *([-*+]|\d+[.)]) +/, '')];
      for (const part of parts.map(visible).filter(Boolean)) {
        assert.ok(page.includes(part), `${entry.file} lacks "${part.slice(0, 80)}" from ${entry.source}`);
        checked += 1;
      }
    }
    assert.ok(checked >= 10, `${entry.source}: only ${checked} lines checked`);
    // and the structure: one heading, list item and table row on the page for each in the Markdown
    const html = read(entry.file);
    const main = between(html, '<main id="main">', '</main>');
    const count = (re, s) => (s.match(re) || []).length;
    const src = md.join('\n');
    assert.equal(count(/<h[1-6] /g, main), count(/^#{1,6} /gm, src), `${entry.file}: headings`);
    assert.equal(count(/<li>/g, main), count(/^ *([-*+]|\d+[.)]) /gm, src), `${entry.file}: list items`);
    assert.equal(count(/<tr>/g, main), count(/^ *\|/gm, src) - count(/^ *\|? *:?-{3,}/gm, src), `${entry.file}: table rows`);
  }
});

test('each page has the site\'s chrome: head tags, the site nav, breadcrumbs Home > Legal > the document, the footer and a tight policy', () => {
  const home = read('site/index.html');
  assert.ok(textOf(between(home, '<footer>', '</footer>')).includes(FOOTER_LINE), 'the home page\'s footer carries the non-affiliation line');
  for (const entry of PAGES) {
    const html = read(entry.file);
    const r = rootFor(entry);
    assert.equal(r, '../../');
    assert.match(html, /^<!doctype html>\n<!-- Written by scripts\/legal-pages\.mjs from legal\/[a-z-]+\.md and legal\/legal-status\.json\./);
    assert.ok(html.includes('<html lang="en" data-root="../../">'));
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    assert.match(html, /<meta name="color-scheme" content="light dark">/);
    assert.match(html, /<meta name="theme-color" content="#14532d">/);
    assert.ok(html.includes(`<meta name="description" content="${entry.description}">`), `${entry.file}: the map's description`);
    const h1 = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)];
    assert.equal(h1.length, 1, `${entry.file}: one h1`);
    assert.match(textOf(h1[0][1]), /Lot Current|Posting rules/, `${entry.file}: the h1 is the document's heading`);
    // the look: the site's stylesheet and favicons, nothing else
    const links = [...html.matchAll(/<link\b([^>]*)>/g)].map((m) => m[1]);
    assert.deepEqual(links.filter((l) => !/rel="canonical"/.test(l)), [
      ' rel="icon" href="../../favicon.svg" type="image/svg+xml"', ' rel="icon" href="../../favicon-32.png" type="image/png" sizes="32x32"', ' rel="apple-touch-icon" href="../../apple-touch-icon.png"', ' rel="stylesheet" href="../../site.css"',
    ], `${entry.file}: the links`);
    // the canonical names the page's own address, and only once siteUrl is set
    assert.deepEqual(links.filter((l) => /rel="canonical"/.test(l)), SITE.siteUrl ? [` rel="canonical" href="${SITE.siteUrl}${entry.path}"`] : [], `${entry.file}: the canonical`);
    assert.deepEqual(strayTags(html), [], `${entry.file}: no script, style, frame, image or event handler`);
    assert.deepEqual([...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]), [' type="application/ld+json"'], `${entry.file}: the structured data block and no other script`);
    const data = JSON.parse(html.match(/<script type="application\/ld\+json">([^<]*)<\/script>/)[1]);
    assert.deepEqual(data['@graph'].map((n) => n['@type']), ['BreadcrumbList']);
    assert.deepEqual(data['@graph'][0].itemListElement.map((i) => i.name), ['Home', 'Legal', entry.crumb]);
    // the policy: the stylesheet and the images may load, nothing may be sent
    const csp = (html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/) || [])[1];
    assert.equal(csp, CSP, `${entry.file}: the Content-Security-Policy`);
    assert.doesNotMatch(csp, /unsafe|script-src|\*/);
    // skip link, header, nav (no current item: the legal pages are not in the nav), breadcrumbs
    assert.match(html, /<a class="skip" href="#main">Skip to content<\/a>/);
    assert.match(html, /<main id="main">/);
    assert.match(between(html, '<header class="top">', '</header>'), /<a class="brand" href="\.\.\/\.\.\/">Lot Current/, `${entry.file}: the header links back to the home page`);
    const nav = between(html, '<nav aria-label="Site">', '</nav>');
    assert.deepEqual([...nav.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map((m) => [m[1], m[2]]), NAV.map((n) => [r + n.path.slice(1), n.nav]));
    assert.doesNotMatch(nav, /aria-current/);
    const crumbs = between(html, '<nav class="crumbs" aria-label="Breadcrumb">', '</nav>');
    assert.deepEqual([...crumbs.matchAll(/<li(?: aria-current="page")?>(?:<a href="([^"]+)">)?([^<]+)/g)].map((m) => [m[1] || null, m[2]]), [['../../', 'Home'], ['../../legal/', 'Legal'], [null, entry.crumb]]);
    assert.deepEqual(ancestorsOf(entry).map((a) => a.path), ['/', '/legal/']);
    assert.equal([...html.matchAll(/aria-current="page"/g)].length, 1, `${entry.file}: the breadcrumb's last item only`);
    // the footer: the three documents by relative address, and the line
    const footer = between(html, '<footer>', '</footer>');
    assert.deepEqual([...footer.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map((m) => [m[1], m[2]]), [['../../legal/terms/', 'Terms of service'], ['../../legal/privacy/', 'Privacy policy'], ['../../legal/posting-rules/', 'Posting rules']]);
    assert.ok(textOf(footer).includes(FOOTER_LINE));
    // every link goes to a file that exists (a directory: its index.html), or to an id on the page
    for (const [, href] of html.matchAll(/href="([^"]+)"/g)) {
      if (href.startsWith('#')) assert.match(html, new RegExp(`id="${href.slice(1)}"`), `${entry.file}: ${href} is on the page`);
      else if (!/^(https?|mailto):/.test(href)) {
        const target = resolve(root, dirname(entry.file), href.split('#')[0]);
        assert.ok(existsSync(target) || existsSync(join(target, 'index.html')), `${entry.file}: ${href} exists`);
      }
    }
    // ids are unique (headings get their own, never the page's)
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, `${entry.file}: an id is used twice`);
    // the pilot dealer is a fixture, not a default (copied from test/anyDealer.test.js)
    assert.doesNotMatch(html, /Waynesburg|Ron Lewis|Cranberry|Pleasant Hills|15370|\$\s?490\b|\bRoger\b|ronlewis/i);
  }
});

test('the old addresses keep working: a stub at each sends the browser to the new page, loads nothing and says where it went', () => {
  for (const r of REDIRECTS) {
    const html = read(r.file);
    assert.match(html, /^<!doctype html>\n<!-- Written by scripts\/legal-pages\.mjs: the old address of \/legal\/[a-z-]+\/\./);
    assert.ok(html.includes(`<meta http-equiv="refresh" content="0; url=${r.to}">`), `${r.file}: the refresh`);
    assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="${REDIRECT_CSP}">`));
    assert.ok(html.includes('<meta name="robots" content="noindex">'));
    assert.ok(html.includes(`<title>${r.label} has moved | Lot Current</title>`));
    assert.equal((html.match(/<h1\b/g) || []).length, 1);
    assert.ok(html.includes('<h1>This page has moved</h1>'));
    assert.ok(html.includes(`<a href="${r.to}">${r.label}</a>`));
    // the canonical is the only link, and the browser loads nothing from it
    assert.doesNotMatch(html.replace(/<link rel="canonical" href="[^"]*">/, ''), /<link|<script|<style|<img/, `${r.file}: nothing is loaded`);
    assert.ok(existsSync(resolve(root, dirname(r.file), r.to, 'index.html')), `${r.file}: the target exists`);
    assert.equal(PAGES.find((p) => p.path === r.target).file, resolve(root, dirname(r.file), r.to, 'index.html').slice(root.length));
    assert.equal(html.includes('rel="canonical"'), Boolean(SITE.siteUrl), `${r.file}: a canonical only once siteUrl is set`);
    if (SITE.siteUrl) assert.ok(html.includes(`<link rel="canonical" href="${SITE.siteUrl}${r.target}">`));
  }
  const stub = renderRedirect(REDIRECTS[0], ctxOf({ siteUrl: FIXTURE_URL }));
  assert.ok(stub.includes(`<link rel="canonical" href="${FIXTURE_URL}/legal/terms/">`));
  assert.doesNotMatch(renderRedirect(REDIRECTS[0], ctxOf()), /canonical/);
  assert.throws(() => renderRedirect(REDIRECTS[0], {}), /site context/);
});

test('the renderer escapes every piece of text: paragraphs, headings, list items, table cells, link text, code and blanks', () => {
  const nasty = '<script>alert("x")</script> & \'q\'';
  const safe = '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;';
  assert.equal(escapeHtml(nasty), safe);
  const md = [
    `# ${nasty}`,
    '',
    nasty,
    '',
    `- ${nasty}`,
    '',
    `| ${nasty} | b |`,
    '|---|---|',
    `| \`${nasty}\` | [${nasty}](https://a.test/) |`,
    '',
    `[<b onclick="x">](#top) and [<img src=x onerror=alert(1)>]`,
  ].join('\n');
  const { html } = renderMarkdown(md);
  assert.deepEqual(strayTags(html), [], 'no markup from the text survives');
  assert.ok(html.split(safe).length - 1 >= 5, 'the text is there, escaped, in the heading, the paragraph, the item, the cells and the link text');
  assert.match(html, /<code>&lt;script&gt;/);
  assert.match(html, /<a href="#top">&lt;b onclick=&quot;x&quot;&gt;<\/a>/);
  assert.match(html, /<span class="blank">\[&lt;img src=x onerror=alert\(1\)&gt;\]<\/span>/);
  // an address with a quote in it stays inside its attribute
  assert.equal(renderInline('[x](https://a.test/?q="1"&r=2)'), '<a href="https://a.test/?q=&quot;1&quot;&amp;r=2">x</a>');
});

test('a link becomes a link only for http(s), mailto, a relative address or an #anchor', () => {
  for (const ok of ['https://fixture.lotcurrent.com/', 'http://a.test/x', 'mailto:support@fixture.lotcurrent.com', 'MAILTO:a@b.test', 'terms/', '../../', './privacy/#retention', '/legal/terms/', '#processors', '?q=1']) {
    assert.equal(safeHref(ok), ok, ok);
    assert.match(renderInline(`[x](${ok})`), /^<a href="[^"]+">x<\/a>$/, `[x](${ok}) is a link`);
  }
  for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'java\nscript:x', 'data:text/html,<b>x</b>', 'vbscript:x', 'file:///etc/passwd', 'ftp://a.test/', '//evil.test/x', '/\\evil.test', '\\\\evil.test', 'blob:https://a.test/1', '']) {
    assert.equal(safeHref(bad), '', JSON.stringify(bad));
  }
  // a refused target keeps the link's text, and nothing of the address
  assert.equal(renderInline('see [the form](javascript:alert(1)) here'), 'see the form) here');
  assert.equal(renderInline('[x](data:text/html,hi)'), 'x');
  assert.equal(renderInline('[x](//evil.test/)'), 'x');
});

test('headings, paragraphs, nested lists, tables, bold, italic and inline code render as Markdown means them', () => {
  const md = [
    'DRAFT: first line.',
    '# Title *here*',
    'Line one of a paragraph',
    'and line two, with **bold**, *italic*, _also italic_, snake_case_name, trailing_under_ and `a **b** c`.',
    '1999. A year that starts a line stays in the paragraph.',
    '',
    '## Main',
    '## Main',
    '',
    '- one',
    '  - one.a',
    '    1. deep',
    '    2. deeper',
    '  - one.b',
    '- two',
    '  continues here',
    '',
    '- three, after a blank line',
    '',
    '3. starts at three',
    '4. four',
    '',
    '### Table',
    '| A | B \\| C |',
    '|:---|---:|',
    '| 1 | `x\\|y` |',
    '| only one |',
  ].join('\n');
  const out = renderMarkdown(md);
  assert.equal(out.title, 'Title here');
  assert.equal(out.html, [
    '<p>DRAFT: first line.</p>',
    '<h1 id="title-here">Title <em>here</em></h1>',
    '<p>Line one of a paragraph and line two, with <strong>bold</strong>, <em>italic</em>, <em>also italic</em>, snake_case_name, trailing_under_ and <code>a **b** c</code>. 1999. A year that starts a line stays in the paragraph.</p>',
    '<h2 id="main-2">Main</h2>',
    '<h2 id="main-3">Main</h2>',
    '<ul>',
    '  <li>one',
    '    <ul>',
    '      <li>one.a',
    '        <ol>',
    '          <li>deep</li>',
    '          <li>deeper</li>',
    '        </ol>',
    '      </li>',
    '      <li>one.b</li>',
    '    </ul>',
    '  </li>',
    '  <li>two continues here</li>',
    '  <li>three, after a blank line</li>',
    '</ul>',
    '<ol start="3">',
    '  <li>starts at three</li>',
    '  <li>four</li>',
    '</ol>',
    '<h3 id="table">Table</h3>',
    '<div class="table" role="region" tabindex="0" aria-labelledby="table">',
    '  <table>',
    '    <thead>',
    '      <tr><th scope="col">A</th><th scope="col">B | C</th></tr>',
    '    </thead>',
    '    <tbody>',
    '      <tr><td>1</td><td><code>x|y</code></td></tr>',
    '      <tr><td>only one</td><td></td></tr>',
    '    </tbody>',
    '  </table>',
    '</div>',
  ].join('\n'));
  // the blanks a final page may not keep
  assert.deepEqual(renderMarkdown('Last updated: [date]. Ask [Attorney: which law?] or read [the rules](posting-rules/).').blanks, ['date', 'Attorney: which law?']);
  // a list and a paragraph end where a heading or a table begins
  assert.equal(renderMarkdown('- a\n## H\ntext\n| x |\n|---|\n| 1 |').html.split('\n').filter((l) => /^<(ul|h2|p|div)/.test(l)).length, 4);
});

test('a final page cannot keep the DRAFT line or a blank in brackets, and drops the banner and the (draft) once the texts are', () => {
  const entry = PAGES[0];
  const clean = '# Lot Current Terms of Service\n\nLast updated: 1 December 2026. These Terms are final.\n';
  const draftPage = renderPage(entry, clean, { draft: true }, ctxOf());
  assert.match(draftPage, /<p class="draft"><strong>Draft under attorney review\.<\/strong> Not in effect/);
  assert.match(draftPage, /<title>Terms of service \(draft\) \| Lot Current<\/title>/);
  assert.match(draftPage, /<h1 id="lot-current-terms-of-service">Lot Current Terms of Service<\/h1>/);
  const final = renderPage(entry, clean, { draft: false }, ctxOf());
  assert.doesNotMatch(final, /class="draft"|\(draft\)/);
  assert.match(final, /<title>Terms of service \| Lot Current<\/title>/);
  assert.throws(() => renderPage(entry, `DRAFT: starting point for attorney review. Not legal advice.\n\n${clean}`, { draft: false }, ctxOf()), /terms-of-service\.md still has its DRAFT line/);
  assert.throws(() => renderPage(entry, `${clean}\nContact: [support email].\n`, { draft: false }, ctxOf()), /blanks in brackets \(\[support email\]\)/);
  assert.throws(() => renderPage(entry, 'No title here.\n', { draft: true }, ctxOf()), /no "# " title/);
  assert.throws(() => renderPage(entry, `${clean}\n# Another\n`, { draft: true }, ctxOf()), /has 2 "# " headings/);
  assert.throws(() => renderPage(entry, clean, { draft: true }), /site context/);
  // siteUrl set: the canonical and share address of the new page
  const live = renderPage(PAGES[2], '# Posting rules for salespeople\n\nRules.\n', { draft: true }, ctxOf({ siteUrl: FIXTURE_URL }));
  assert.ok(live.includes(`<link rel="canonical" href="${FIXTURE_URL}/legal/posting-rules/">`));
  assert.ok(live.includes(`<meta property="og:url" content="${FIXTURE_URL}/legal/posting-rules/">`));
  assert.ok(live.includes(`<meta property="og:image" content="${FIXTURE_URL}/social/legal-posting-rules.png">`));
  // the drafts as they stand today cannot be published as final
  for (const e of PAGES) assert.throws(() => renderPage(e, read(e.source), { draft: false }, ctxOf()), /still has/, `${e.source} reads as final`);
});

test('--check exits 1 when a file is missing or differs, names it and writes nothing; a run writes all six and --check passes', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'lotcurrent-legal-'));
  try {
    for (const rel of [STATUS_FILE, 'site/config.js', 'site/pricing.json', ...PAGES.map((p) => p.source)]) {
      mkdirSync(dirname(join(tmp, rel)), { recursive: true });
      cpSync(join(root, rel), join(tmp, rel));
    }
    const run = async (argv) => {
      const said = { log: [], error: [] };
      const code = await main(argv, { log: (s) => said.log.push(s), error: (s) => said.error.push(s) }, tmp);
      return { code, ...said };
    };
    assert.equal((await run(['--check'])).code, 1, 'no pages yet');
    assert.deepEqual((await run([])).log, [...PAGES, ...REDIRECTS].map((p) => `wrote ${p.file}`));
    assert.equal((await run(['--check'])).code, 0, 'the files just written match');
    const page = join(tmp, PAGES[1].file);
    const written = readFileSync(page, 'utf8');
    const edited = written.replace('</h1>', ' (edited by hand)</h1>');
    writeFileSync(page, edited);
    const r = await run(['--check']);
    assert.equal(r.code, 1);
    assert.match(r.error.join('\n'), /site\/legal\/privacy\/index\.html is not what the Markdown/);
    assert.equal(readFileSync(page, 'utf8'), edited, '--check writes nothing');
    rmSync(join(tmp, PAGES[2].file));
    assert.match((await run(['--check'])).error.join('\n'), /posting-rules\/index\.html/, 'a missing page is named');
    rmSync(join(tmp, REDIRECTS[0].file));
    assert.match((await run(['--check'])).error.join('\n'), /site\/legal\/terms\.html/, 'a missing stub is named');
    // a Markdown change without a rerun is caught too
    writeFileSync(join(tmp, PAGES[0].source), read(PAGES[0].source) + '\nOne more line.\n');
    assert.match((await run(['--check'])).error.join('\n'), /terms\/index\.html/);
    // a run writes all six, then the check passes
    assert.equal((await run([])).code, 0);
    assert.equal((await run(['--check'])).code, 0);
    assert.equal(readFileSync(page, 'utf8'), written, 'the hand edit is gone');
    // config.js changes the pages too: siteUrl set means a canonical on every page and stub
    const config = read('site/config.js');
    const withSiteUrl = config.replace(/siteUrl: '[^']*',/, `siteUrl: '${FIXTURE_URL}',`);
    assert.notEqual(withSiteUrl, config, 'the config has a siteUrl line');
    writeFileSync(join(tmp, 'site/config.js'), withSiteUrl);
    assert.equal((await run(['--check'])).code, 1, 'the committed files carry another canonical, or none');
    assert.equal((await run([])).code, 0);
    for (const p of PAGES) assert.ok(readFileSync(join(tmp, p.file), 'utf8').includes(`<link rel="canonical" href="${FIXTURE_URL}${p.path}">`), p.file);
    for (const s of REDIRECTS) assert.ok(readFileSync(join(tmp, s.file), 'utf8').includes(`<link rel="canonical" href="${FIXTURE_URL}${s.target}">`), s.file);
    writeFileSync(join(tmp, 'site/config.js'), config.replace(/demoMailto: '[^']*',/, "demoMailto: 'mailto:demo@lotcurrent.example',"));
    const refusedConfig = await run([]);
    assert.equal(refusedConfig.code, 1);
    assert.match(refusedConfig.error.join('\n'), /reserved placeholder host/);
    writeFileSync(join(tmp, 'site/config.js'), config);
    assert.equal((await run([])).code, 0);
    // "draft": false over texts that still read as drafts: refused, nothing written
    writeFileSync(join(tmp, STATUS_FILE), '{ "draft": false }');
    const before = readFileSync(page, 'utf8');
    const refused = await run([]);
    assert.equal(refused.code, 1);
    assert.match(refused.error.join('\n'), /still has its DRAFT line/);
    assert.equal(readFileSync(page, 'utf8'), before, 'nothing is written when a page cannot be');
    // help and a wrong option
    const help = await run(['--help']);
    assert.equal(help.code, 0);
    assert.match(help.log.join('\n'), /draft under attorney review|a draft under attorney/);
    assert.equal((await run(['--chek'])).code, 2);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('the script needs nothing beyond Node and the site generator, and npm run legal-pages runs it', async () => {
  const src = read('scripts/legal-pages.mjs');
  for (const m of src.matchAll(/^import [^;]* from '([^']+)';/gm)) assert.match(m[1], /^node:|^\.\/site-pages\.mjs$/, `imports ${m[1]}`);
  assert.equal(JSON.parse(read('package.json')).scripts['legal-pages'], 'node scripts/legal-pages.mjs');
  for (const p of PAGES) assert.ok(existsSync(dirname(join(root, p.file))));
  const ctx = await readContext(root);
  assert.equal(typeof ctx.legalDraft, 'boolean');
});
