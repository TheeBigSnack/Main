// The Terms, the Privacy Policy and the posting rules as pages of the landing
// site (scripts/legal-pages.mjs). The committed pages are what the Markdown
// and legal/legal-status.json make now; every line of the Markdown is on its
// page; a draft says so at the top and a final page cannot keep a draft's
// blanks; the renderer escapes every piece of text and links only to safe
// places; each page has the landing page's look, header, footer and policy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PAGES, STATUS_FILE, CSP, FOOTER_LINE, USAGE, escapeHtml, safeHref, renderInline, renderMarkdown, readStatus, renderPage, stalePages, main,
} from '../scripts/legal-pages.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(join(root, rel), 'utf8');
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
// inline tags join their text to the words around them; block tags separate
const textOf = (html) => decode(html.replace(/<\/?(code|strong|em|a|span)\b[^>]*>/g, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
// Every tag the renderer and the page template write, with the attributes they may carry. Anything
// else (a script, an image, an event handler, a style) would be markup that came from the text.
const TAG = /^<(\/?)(html|head|meta|title|link|body|header|nav|main|footer|div|p|h[1-6]|ul|ol|li|table|thead|tbody|tr|th|td|code|strong|em|a|span|small)((?: (?:id|class|role|tabindex|aria-labelledby|aria-label|aria-current|scope|href|start|lang|charset|name|content|http-equiv|rel)="[^"<>]*")*)>$/;
const strayTags = (html) => (html.replace(/<!--[\s\S]*?-->/g, '').replace(/^<!doctype html>/, '').match(/<[^>]*>/g) || []).filter((t) => !TAG.test(t));
const between = (html, open, close) => {
  const start = html.indexOf(open);
  return start < 0 ? '' : html.slice(start, html.indexOf(close, start) + close.length);
};
const status = JSON.parse(read(STATUS_FILE));

test('the committed pages are what the Markdown and legal/legal-status.json make now (npm run legal-pages)', () => {
  assert.deepEqual(stalePages(), [], 'a page differs from its Markdown or the draft status: run npm run legal-pages and commit the pages');
});

test('legal-status.json says whether the texts are drafts, and says what that means', () => {
  assert.equal(typeof status.draft, 'boolean');
  assert.match(status.note, /draft under attorney review/);
  assert.match(status.note, /not in effect/);
  assert.match(status.note, /npm run legal-pages/, 'the note says to rerun the script');
  assert.deepEqual(readStatus(read(STATUS_FILE)), { draft: status.draft });
  for (const bad of ['{"draft":"no"}', '{}', 'null', 'not json']) assert.throws(() => readStatus(bad), /legal-status\.json/, `${bad} is refused, not read as final`);
  const help = USAGE.join('\n');
  for (const re of [/legal-status\.json/, /"draft" is true/, /not in effect/, /attorney approves/, /set "draft" to\s+false and run this again/, /legalLinks\.js/]) assert.match(help, re, `--help: ${re}`);
});

test('while the status says draft, every page opens with the banner and its title says draft', () => {
  for (const entry of PAGES) {
    const html = read(entry.page);
    const main = between(html, '<main id="main">', '</main>');
    const first = main.match(/<div class="wrap narrow legal">\s*(<[^>]+>[\s\S]*?<\/p>)/);
    const title = html.match(/<title>([^<]*)<\/title>/)[1];
    if (status.draft) {
      assert.ok(first && first[1].startsWith('<p class="draft">'), `${entry.page}: the banner is the first thing in the page's main content`);
      assert.match(textOf(first[1]), /^Draft under attorney review\. Not in effect/, `${entry.page}: the banner says draft and not in effect`);
      assert.match(title, /\(draft\)$/, `${entry.page}: the title says draft`);
    } else {
      assert.doesNotMatch(html, /class="draft"/, `${entry.page}: a final page has no draft banner`);
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
    const page = textOf(between(read(entry.page), '<main id="main">', '</main>'));
    const md = read(entry.source).split('\n');
    let checked = 0;
    for (const line of md) {
      if (!line.trim() || /^ *\|? *:?-{3,}/.test(line)) continue;
      const parts = /^ *\|/.test(line)
        ? line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|'))
        : [line.replace(/^ *#{1,6} +/, '').replace(/^ *([-*+]|\d+[.)]) +/, '')];
      for (const part of parts.map(visible).filter(Boolean)) {
        assert.ok(page.includes(part), `${entry.page} lacks "${part.slice(0, 80)}" from ${entry.source}`);
        checked += 1;
      }
    }
    assert.ok(checked >= 10, `${entry.source}: only ${checked} lines checked`);
    // and the structure: one heading, list item and table row on the page for each in the Markdown
    const html = read(entry.page);
    const count = (re, s) => (s.match(re) || []).length;
    const src = md.join('\n');
    assert.equal(count(/<h[1-6] /g, html), count(/^#{1,6} /gm, src), `${entry.page}: headings`);
    assert.equal(count(/<li>/g, between(html, '<main id="main">', '</main>')), count(/^ *([-*+]|\d+[.)]) /gm, src), `${entry.page}: list items`);
    assert.equal(count(/<tr>/g, html), count(/^ *\|/gm, src) - count(/^ *\|? *:?-{3,}/gm, src), `${entry.page}: table rows`);
  }
});

test('each page has the landing page\'s look, its header back to the landing page, the same footer and a tight policy', () => {
  const landing = read('site/index.html');
  const footerOf = (html, base) => {
    const f = between(html, '<footer>', '</footer>');
    const links = [...f.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => [resolve(root, base, m[1]), m[2]]);
    return { links, text: textOf(f) };
  };
  const expected = footerOf(landing, 'site');
  assert.equal(expected.links.length, 3, 'the landing page\'s footer links the three documents');
  assert.ok(expected.text.includes(FOOTER_LINE), 'the landing page\'s footer carries the non-affiliation line');
  assert.match(landing, /<a class="skip" href="#main">/, 'the landing page has a skip link, so the legal pages have one too');
  for (const entry of PAGES) {
    const html = read(entry.page);
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    assert.match(html, /<meta name="color-scheme" content="light dark">/);
    const h1 = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)];
    assert.equal(h1.length, 1, `${entry.page}: one h1`);
    assert.ok(decode(html.match(/<title>([^<]+)<\/title>/)[1]).includes(textOf(h1[0][1])), `${entry.page}: the title is the document's heading`);
    // the look: the landing page's stylesheet and nothing else
    assert.deepEqual([...html.matchAll(/<link\b([^>]*)>/g)].map((m) => m[1]), [' rel="stylesheet" href="../site.css"']);
    assert.deepEqual(strayTags(html), [], `${entry.page}: no script, style, frame, image or event handler`);
    // the policy: nothing but the stylesheet may load, nothing may be sent
    const csp = (html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/) || [])[1];
    assert.equal(csp, CSP, `${entry.page}: the Content-Security-Policy`);
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /style-src 'self'/);
    assert.match(csp, /form-action 'none'/);
    assert.match(csp, /base-uri 'none'/);
    assert.doesNotMatch(csp, /unsafe|script-src|\*/);
    // skip link, header, nav
    assert.match(html, /<a class="skip" href="#main">Skip to content<\/a>/);
    assert.match(html, /<main id="main">/);
    assert.match(between(html, '<header class="top">', '</header>'), /<a class="brand" href="\.\.\/index\.html">Lot Sync/, `${entry.page}: the header links back to the landing page`);
    const here = entry.page.split('/').pop();
    assert.equal([...html.matchAll(/aria-current="page"/g)].length, 1);
    assert.match(html, new RegExp(`<a href="${here}" aria-current="page">`), `${entry.page}: the header marks the page it is on`);
    // the footer: the landing page's links (to the same files) and text
    assert.deepEqual(footerOf(html, 'site/legal'), expected, `${entry.page}: the footer is the landing page's`);
    // every link goes to a file that exists, or to an id on the page
    for (const [, href] of html.matchAll(/href="([^"]+)"/g)) {
      if (href.startsWith('#')) assert.match(html, new RegExp(`id="${href.slice(1)}"`), `${entry.page}: ${href} is on the page`);
      else if (!/^(https?|mailto):/.test(href)) assert.ok(existsSync(resolve(root, 'site/legal', href.split('#')[0])), `${entry.page}: ${href} exists`);
    }
    // ids are unique (headings get their own, never the page's)
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, `${entry.page}: an id is used twice`);
    // the pilot dealer is a fixture, not a default (copied from test/anyDealer.test.js)
    assert.doesNotMatch(html, /Waynesburg|Ron Lewis|Cranberry|Pleasant Hills|15370|\$\s?490\b|\bRoger\b|ronlewis/i);
  }
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
  for (const ok of ['https://lotsync.example/', 'http://a.test/x', 'mailto:support@lotsync.example', 'MAILTO:a@b.test', 'terms.html', '../index.html', './privacy.html#retention', '/legal/terms.html', '#processors', '?q=1']) {
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
  assert.deepEqual(renderMarkdown('Last updated: [date]. Ask [Attorney: which law?] or read [the rules](posting-rules.html).').blanks, ['date', 'Attorney: which law?']);
  // a list and a paragraph end where a heading or a table begins
  assert.equal(renderMarkdown('- a\n## H\ntext\n| x |\n|---|\n| 1 |').html.split('\n').filter((l) => /^<(ul|h2|p|div)/.test(l)).length, 4);
});

test('a final page cannot keep the DRAFT line or a blank in brackets, and drops the banner once the texts are', () => {
  const entry = PAGES[0];
  const clean = '# Lot Sync Terms of Service\n\nLast updated: 1 December 2026. These Terms are final.\n';
  const draftPage = renderPage(entry, clean, { draft: true });
  assert.match(draftPage, /<p class="draft"><strong>Draft under attorney review\.<\/strong> Not in effect/);
  assert.match(draftPage, /<title>Lot Sync Terms of Service \(draft\)<\/title>/);
  const final = renderPage(entry, clean, { draft: false });
  assert.doesNotMatch(final, /class="draft"|\(draft\)/);
  assert.match(final, /<title>Lot Sync Terms of Service<\/title>/);
  assert.throws(() => renderPage(entry, `DRAFT: starting point for attorney review. Not legal advice.\n\n${clean}`, { draft: false }), /terms-of-service\.md still has its DRAFT line/);
  assert.throws(() => renderPage(entry, `${clean}\nContact: [support email].\n`, { draft: false }), /blanks in brackets \(\[support email\]\)/);
  assert.throws(() => renderPage(entry, 'No title here.\n', { draft: true }), /no "# " title/);
  // a title without the product's name gets it
  assert.match(renderPage(PAGES[2], '# Posting rules for salespeople\n\nRules.\n', { draft: false }), /<title>Posting rules for salespeople: Lot Sync<\/title>/);
  // the drafts as they stand today cannot be published as final
  for (const e of PAGES) assert.throws(() => renderPage(e, read(e.source), { draft: false }), /still has/, `${e.source} reads as final`);
});

test('--check exits 1 when a page is missing or differs, names it and writes nothing; a run writes them and --check passes', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'lotsync-legal-'));
  try {
    for (const rel of [STATUS_FILE, ...PAGES.map((p) => p.source)]) cpSync(join(root, rel), join(tmp, rel));
    const run = (argv) => {
      const said = { log: [], error: [] };
      const code = main(argv, { log: (s) => said.log.push(s), error: (s) => said.error.push(s) }, tmp);
      return { code, ...said };
    };
    assert.equal(run(['--check']).code, 1, 'no pages yet');
    assert.deepEqual(run([]).log, PAGES.map((p) => `wrote ${p.page}`));
    assert.equal(run(['--check']).code, 0, 'the pages just written match');
    const page = join(tmp, PAGES[1].page);
    const written = readFileSync(page, 'utf8');
    const edited = written.replace('</h1>', ' (edited by hand)</h1>');
    writeFileSync(page, edited);
    const r = run(['--check']);
    assert.equal(r.code, 1);
    assert.match(r.error.join('\n'), /site\/legal\/privacy\.html is not what the Markdown/);
    assert.equal(readFileSync(page, 'utf8'), edited, '--check writes nothing');
    rmSync(join(tmp, PAGES[2].page));
    assert.match(run(['--check']).error.join('\n'), /posting-rules\.html/, 'a missing page is named');
    // a Markdown change without a rerun is caught too
    writeFileSync(join(tmp, PAGES[0].source), read(PAGES[0].source) + '\nOne more line.\n');
    assert.match(run(['--check']).error.join('\n'), /terms\.html/);
    // a run writes all three, then the check passes
    assert.equal(run([]).code, 0);
    assert.equal(run(['--check']).code, 0);
    assert.equal(readFileSync(page, 'utf8'), written, 'the hand edit is gone');
    // "draft": false over texts that still read as drafts: refused, nothing written
    writeFileSync(join(tmp, STATUS_FILE), '{ "draft": false }');
    const before = readFileSync(page, 'utf8');
    const refused = run([]);
    assert.equal(refused.code, 1);
    assert.match(refused.error.join('\n'), /still has its DRAFT line/);
    assert.equal(readFileSync(page, 'utf8'), before, 'nothing is written when a page cannot be');
    // help and a wrong option
    const help = run(['--help']);
    assert.equal(help.code, 0);
    assert.match(help.log.join('\n'), /draft under attorney review|a draft under attorney/);
    assert.equal(run(['--chek']).code, 2);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('the script needs nothing beyond Node, and npm run legal-pages runs it', () => {
  const src = read('scripts/legal-pages.mjs');
  for (const m of src.matchAll(/^import [^;]* from '([^']+)';/gm)) assert.match(m[1], /^node:/, `imports ${m[1]}`);
  assert.equal(JSON.parse(read('package.json')).scripts['legal-pages'], 'node scripts/legal-pages.mjs');
  assert.ok(existsSync(dirname(join(root, PAGES[0].page))));
});
