#!/usr/bin/env node
// Writes the Terms of Service, the Privacy Policy and the posting rules as
// pages of the landing site, from the Markdown the attorney reviews:
//
//   legal/terms-of-service.md  -> site/legal/terms.html
//   legal/privacy-policy.md    -> site/legal/privacy.html
//   legal/posting-rules.md     -> site/legal/posting-rules.html
//
// Run:  npm run legal-pages                         -> writes the three pages
//       node scripts/legal-pages.mjs --check        -> writes nothing; exit 1 when a
//                                                      page differs from what it would write
//
// legal/legal-status.json says whether the texts are still drafts. While
// "draft" is true, every page opens with a banner: a draft under attorney
// review, not in effect. The owner sets it to false once the attorney has
// approved the texts and their approved wording is in legal/, then runs this
// again. It refuses to write a page as final while its Markdown still has the
// DRAFT line or a blank in [brackets], so a page never claims to be in effect
// with "[date]" in it. After that, extension/src/legalLinks.js gets the pages'
// real addresses and a new version (the comment there says how).
//
// The Markdown is rendered by the small renderer below, not a dependency: it
// knows what the legal texts use (headings, paragraphs, lists, nested lists,
// tables, bold, italic, inline code, links) and nothing else, so anything it
// does not know shows as the text that was typed. Every piece of text is
// HTML-escaped, and a link becomes a link only when its target is http(s),
// mailto, a relative address or a #anchor. test/legalPages.test.js runs the
// check in npm test, so a page edited by hand, or a Markdown change without a
// rerun, fails there.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const STATUS_FILE = 'legal/legal-status.json';

// label is what the header and the footer call the page, as the landing page's footer does.
export const PAGES = Object.freeze([
  Object.freeze({ source: 'legal/terms-of-service.md', page: 'site/legal/terms.html', label: 'Terms of service' }),
  Object.freeze({ source: 'legal/privacy-policy.md', page: 'site/legal/privacy.html', label: 'Privacy policy' }),
  Object.freeze({ source: 'legal/posting-rules.md', page: 'site/legal/posting-rules.html', label: 'Posting rules' }),
]);

// The landing page's policy, narrowed to what these pages load: the stylesheet
// and nothing else. No script runs, no form is sent, nothing is called.
export const CSP = "default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'";

export const FOOTER_LINE = 'Lot Sync is not affiliated with Meta Platforms, Inc. "Facebook" and "Marketplace" are used only as the names of the places you post.';
export const DRAFT_BANNER = '<strong>Draft under attorney review.</strong> Not in effect: nothing on this page applies to anyone yet, and the text may change before it does.';

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ENTITIES[c]);

// A link target the page may carry: http(s), mailto, a relative address or a
// #anchor. Anything with a space, a control character or a backslash is
// refused before the scheme is read, because browsers drop tabs and newlines
// from an address ("java\tscript:" runs as "javascript:") and read a
// backslash as a slash ("/\host" is another site). Answers '' when refused.
export function safeHref(target) {
  const t = String(target || '');
  if (!t || /[\s\x00-\x1f\x7f\\]/.test(t)) return '';
  const scheme = t.match(/^([a-z][a-z0-9+.-]*):/i);
  if (scheme) return /^(https?|mailto)$/i.test(scheme[1]) ? t : '';
  if (t.startsWith('//')) return ''; // another host with this page's scheme: not a relative address
  return t;
}

const PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

// Bold, italic, inline code, links and [blanks] in one line of text. Blanks
// (a bracket that is not a link: "[date]", "[Attorney: ...]") are kept as
// typed, marked so a reader sees them, and collected in `blanks`.
export function renderInline(src, blanks = []) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const rest = src.slice(i);
    let m;
    if (c === '\\' && PUNCTUATION.test(src[i + 1] || '')) {
      out += escapeHtml(src[i + 1]);
      i += 2;
      continue;
    }
    if (c === '`' && (m = rest.match(/^(`+)([\s\S]*?[^`])\1(?!`)/))) {
      out += `<code>${escapeHtml(m[2].trim() || m[2])}</code>`;
      i += m[0].length;
      continue;
    }
    if (c === '*' && (m = rest.match(/^\*\*(?!\s)([\s\S]*?[^\s])\*\*/))) {
      out += `<strong>${renderInline(m[1], blanks)}</strong>`;
      i += m[0].length;
      continue;
    }
    if (c === '*' && (m = rest.match(/^\*(?![\s*])([^*]*?[^\s*])\*(?!\*)/))) {
      out += `<em>${renderInline(m[1], blanks)}</em>`;
      i += m[0].length;
      continue;
    }
    // an underscore inside a word (snake_case) is a letter, not emphasis
    if (c === '_' && !/\w/.test(src[i - 1] || '') && (m = rest.match(/^_(?![\s_])([^_]*?[^\s_])_(?!\w)/))) {
      out += `<em>${renderInline(m[1], blanks)}</em>`;
      i += m[0].length;
      continue;
    }
    if (c === '[' && (m = rest.match(/^\[([^\]\n]+)\]\(([^)\s]*)\)/))) {
      const href = safeHref(m[2]);
      out += href ? `<a href="${escapeHtml(href)}">${renderInline(m[1], blanks)}</a>` : renderInline(m[1], blanks);
      i += m[0].length;
      continue;
    }
    if (c === '[' && (m = rest.match(/^\[([^\]\n]+)\]/))) {
      blanks.push(m[1]);
      out += `<span class="blank">[${renderInline(m[1], blanks)}]</span>`;
      i += m[0].length;
      continue;
    }
    out += escapeHtml(c);
    i += 1;
  }
  return out;
}

// The text a reader sees in rendered inline HTML: tags gone, entities read back.
const plain = (html) => html.replace(/<[^>]+>/g, '').replace(/&(amp|lt|gt|quot|#39);/g, (e) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[e]);

const HEADING = /^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const ITEM = /^( *)([-*+]|(\d{1,9})[.)])[ \t]+(.*)$/;
const TABLE_RULE = /^ *\|? *:?-{3,}:? *(\| *:?-{3,}:? *)*\|? *$/;
const blank = (line) => line.trim() === '';
const isTableStart = (lines, i) => lines[i].includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]);

// The cells of a table row: the outer pipes dropped, "\|" kept as a pipe.
function cells(line) {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

// Items at a deeper indent than the one before are its sub-list.
function nest(items) {
  const root = { children: [] };
  const stack = [{ indent: -1, node: root }];
  for (const item of items) {
    while (stack.length > 1 && item.indent <= stack[stack.length - 1].indent) stack.pop();
    const node = { ...item, children: [] };
    stack[stack.length - 1].node.children.push(node);
    stack.push({ indent: item.indent, node });
  }
  return root.children;
}

/**
 * Markdown to HTML, one block per line of output.
 * @returns {{ html: string, title: string, blanks: string[] }} title: the
 *   first # heading as plain text; blanks: every [bracket] left to fill in.
 */
export function renderMarkdown(markdown) {
  const lines = String(markdown).replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  const out = [];
  const blanks = [];
  const ids = new Set(['main']); // the page's own ids
  let title = '';
  let lastHeading = '';
  const inline = (s) => renderInline(s, blanks);

  const renderList = (nodes, pad) => {
    let i = 0;
    while (i < nodes.length) {
      const ordered = nodes[i].ordered;
      const group = [];
      while (i < nodes.length && nodes[i].ordered === ordered) group.push(nodes[i++]);
      const tag = ordered ? 'ol' : 'ul';
      const start = ordered && group[0].start !== 1 ? ` start="${group[0].start}"` : '';
      out.push(`${pad}<${tag}${start}>`);
      for (const node of group) {
        if (!node.children.length) {
          out.push(`${pad}  <li>${inline(node.text)}</li>`);
          continue;
        }
        out.push(`${pad}  <li>${inline(node.text)}`);
        renderList(node.children, pad + '    ');
        out.push(`${pad}  </li>`);
      }
      out.push(`${pad}</${tag}>`);
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) {
      i += 1;
      continue;
    }
    const h = line.match(HEADING);
    if (h) {
      const level = h[1].length;
      const html = inline(h[2]);
      const text = plain(html).trim();
      if (level === 1 && !title) title = text;
      const base = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
      let id = base;
      for (let n = 2; ids.has(id); n += 1) id = `${base}-${n}`;
      ids.add(id);
      lastHeading = id;
      out.push(`<h${level} id="${id}">${html}</h${level}>`);
      i += 1;
      continue;
    }
    if (isTableStart(lines, i)) {
      const head = cells(lines[i]);
      const rows = [];
      i += 2;
      while (i < lines.length && !blank(lines[i]) && lines[i].includes('|')) rows.push(cells(lines[i++]));
      // A wide table scrolls inside its own box on a phone; the box takes
      // keyboard focus so it can be scrolled without a mouse, and is named by
      // the heading above it.
      const name = lastHeading ? `aria-labelledby="${lastHeading}"` : 'aria-label="Table"';
      out.push(`<div class="table" role="region" tabindex="0" ${name}>`);
      out.push('  <table>');
      out.push('    <thead>');
      out.push(`      <tr>${head.map((c) => `<th scope="col">${inline(c)}</th>`).join('')}</tr>`);
      out.push('    </thead>');
      out.push('    <tbody>');
      for (const row of rows) {
        const full = row.length < head.length ? [...row, ...Array(head.length - row.length).fill('')] : row;
        out.push(`      <tr>${full.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`);
      }
      out.push('    </tbody>');
      out.push('  </table>');
      out.push('</div>');
      continue;
    }
    if (ITEM.test(line)) {
      const items = [];
      while (i < lines.length) {
        const cur = lines[i];
        if (blank(cur)) {
          // a blank line inside a list: the list goes on when the next text is an item or indented under one
          let j = i;
          while (j < lines.length && blank(lines[j])) j += 1;
          if (j < lines.length && (ITEM.test(lines[j]) || /^ {2,}\S/.test(lines[j]))) {
            i = j;
            continue;
          }
          break;
        }
        const m = cur.match(ITEM);
        if (m) {
          items.push({ indent: m[1].length, ordered: Boolean(m[3]), start: m[3] ? Number(m[3]) : 1, text: m[4] });
          i += 1;
          continue;
        }
        if (HEADING.test(cur) || isTableStart(lines, i)) break;
        items[items.length - 1].text += ' ' + cur.trim(); // the item's text goes on
        i += 1;
      }
      renderList(nest(items), '');
      continue;
    }
    // A paragraph runs to a blank line or the start of another block. A list
    // interrupts it only with a bullet or a "1.", so a line that begins with a
    // year stays in the paragraph.
    const para = [];
    while (i < lines.length && !blank(lines[i]) && !HEADING.test(lines[i]) && !isTableStart(lines, i)) {
      const m = para.length ? lines[i].match(ITEM) : null;
      if (m && (!m[3] || m[3] === '1')) break;
      para.push(lines[i].trim());
      i += 1;
    }
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return { html: out.join('\n'), title, blanks };
}

// legal/legal-status.json: { "draft": true|false, "note": "..." }. A missing
// or unreadable file stops the script: whether a page says "not in effect"
// is never guessed.
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
 * One page: the landing page's header, look and footer around the rendered
 * document, with the draft banner on top while the status says draft.
 * Throws when the status says final but the Markdown still reads as a draft.
 */
export function renderPage(entry, markdown, status) {
  const doc = renderMarkdown(markdown);
  if (!doc.title) throw new Error(`${entry.source} has no "# " title`);
  if (!status.draft) {
    const left = [];
    if (/^DRAFT\b/m.test(markdown)) left.push('its DRAFT line');
    if (doc.blanks.length) left.push(`blanks in brackets (${doc.blanks.map((b) => `[${b}]`).join(', ')})`);
    if (left.length) {
      throw new Error(`${entry.source} still has ${left.join(' and ')}, but ${STATUS_FILE} says the texts are final ("draft": false). Put the attorney's approved text in the file, or set "draft" back to true.`);
    }
  }
  const title = (/\bLot Sync\b/.test(doc.title) ? doc.title : `${doc.title}: Lot Sync`) + (status.draft ? ' (draft)' : '');
  const here = entry.page.split('/').pop();
  const links = (current) => PAGES.map((p) => {
    const file = p.page.split('/').pop();
    return `          <li><a href="${file}"${current && file === here ? ' aria-current="page"' : ''}>${escapeHtml(p.label)}</a></li>`;
  });
  const body = doc.html.split('\n').map((l) => `      ${l}`);
  return [
    '<!doctype html>',
    `<!-- Written by scripts/legal-pages.mjs from ${entry.source} and ${STATUS_FILE}. Change those and run`,
    '     npm run legal-pages; an edit made here is lost at the next run, and npm test fails until then. -->',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    '  <meta name="color-scheme" content="light dark">',
    `  <meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    `  <title>${escapeHtml(title)}</title>`,
    '  <link rel="stylesheet" href="../site.css">',
    '</head>',
    '<body>',
    '  <a class="skip" href="#main">Skip to content</a>',
    '',
    '  <header class="top">',
    '    <div class="wrap">',
    '      <a class="brand" href="../index.html">Lot Sync <small>A Chrome extension for dealership salespeople</small></a>',
    '      <nav aria-label="Legal documents">',
    '        <ul>',
    ...links(true),
    '        </ul>',
    '      </nav>',
    '    </div>',
    '  </header>',
    '',
    '  <main id="main">',
    '    <div class="wrap narrow legal">',
    ...(status.draft ? [`      <p class="draft">${DRAFT_BANNER}</p>`] : []),
    ...body,
    '    </div>',
    '  </main>',
    '',
    '  <footer>',
    '    <div class="wrap">',
    '      <ul>',
    ...links(false).map((l) => l.slice(2)),
    '      </ul>',
    `      <p>${FOOTER_LINE}</p>`,
    '    </div>',
    '  </footer>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

// Every page as it would be written now: [{ page, html }]. Throws before
// anything is written when one of them cannot be.
export function buildPages(root = ROOT) {
  const status = readStatus(readFileSync(join(root, STATUS_FILE), 'utf8'));
  return PAGES.map((entry) => ({ page: entry.page, html: renderPage(entry, readFileSync(join(root, entry.source), 'utf8'), status) }));
}

// The pages that are missing or differ from what buildPages would write.
export function stalePages(root = ROOT) {
  return buildPages(root)
    .filter(({ page, html }) => {
      const file = join(root, page);
      return !existsSync(file) || readFileSync(file, 'utf8') !== html;
    })
    .map(({ page }) => page);
}

export function writePages(root = ROOT) {
  const pages = buildPages(root);
  for (const { page, html } of pages) {
    mkdirSync(dirname(join(root, page)), { recursive: true });
    writeFileSync(join(root, page), html);
  }
  return pages.map(({ page }) => page);
}

export const USAGE = [
  'Usage: npm run legal-pages            write the three pages',
  '       node scripts/legal-pages.mjs --check',
  '                                      write nothing; exit 1 when a page differs from what would be written',
  '',
  ...PAGES.map((p) => `  ${p.source.padEnd(28)}-> ${p.page}`),
  '',
  `${STATUS_FILE} says whether the texts are drafts. While "draft" is true,`,
  'every page opens with a banner: a draft under attorney review, not in effect.',
  'Once the attorney approves the texts, put the approved wording in the three',
  'Markdown files (no DRAFT line, every [bracket] filled in), set "draft" to',
  'false and run this again; it refuses while a file still reads as a draft.',
  'Then give extension/src/legalLinks.js the pages\' addresses and a new version.',
];

export function main(argv, io = { log: (s) => console.log(s), error: (s) => console.error(s) }, root = ROOT) {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.log(USAGE.join('\n'));
    return 0;
  }
  const unknown = argv.find((a) => a !== '--check');
  if (unknown) {
    io.error(`legal-pages: unknown option ${unknown}\n${USAGE.join('\n')}`);
    return 2;
  }
  try {
    if (argv.includes('--check')) {
      const stale = stalePages(root);
      for (const page of stale) io.error(`${page} is not what the Markdown and ${STATUS_FILE} make: run npm run legal-pages`);
      if (!stale.length) io.log('The legal pages match the Markdown and the draft status.');
      return stale.length ? 1 : 0;
    }
    for (const page of writePages(root)) io.log(`wrote ${page}`);
    return 0;
  } catch (e) {
    io.error(`legal-pages: ${e.message}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exitCode = main(process.argv.slice(2));
