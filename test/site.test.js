// The landing page (site/) is customer-facing copy, so it passes the same
// honesty checks as marketing/ (test/marketing.test.js; the regex lists are
// copied here, not imported, so each file stays self-contained), quotes the one
// pricing config, names no dealer, loads nothing from anywhere else, and shows
// only the sandbox's screenshots (site/screenshots/, drawn by npm run screenshots).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const html = read('../site/index.html');
const css = read('../site/site.css');
const js = read('../site/site.js');
const pricing = JSON.parse(read('../marketing/pricing.json'));
const money = (n) => '$' + Number(n).toLocaleString('en-US');

// The page as a reader sees it: tags gone, the title and meta description kept.
function stripTags(src) {
  const title = (src.match(/<title>([\s\S]*?)<\/title>/i) || [, ''])[1];
  const desc = (src.match(/<meta name="description" content="([^"]*)"/i) || [, ''])[1];
  const body = src
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return [title, desc, body].join(' ')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
const text = stripTags(html);

test('the page says who publishes, that Lot Sync never does, and that it is not affiliated with Meta', () => {
  assert.match(text, /not affiliated with Meta Platforms, Inc\./, 'carries the non-affiliation line');
  assert.match(text, /clicks? Publish/, 'says the person clicks Publish');
  assert.match(text, /never clicks Publish|Lot Sync never does|never (clicks|does) Publish|Lot Sync never clicks/i, 'says Lot Sync never does');
  assert.match(text, /not a guarantee|isn't a guarantee|is not guaranteed|won't pretend|no tool can honestly promise/, 'does not oversell safety');
  assert.match(text, /safest design available/, 'the honest line about a person clicking Publish');
  assert.match(text, /Is this allowed on Facebook\?/, 'the FAQ asks the question straight');
});

test('no claim we have not measured, and nothing that sounds like Meta approval', () => {
  // copied from test/marketing.test.js: what no document may say
  const never = [/approved by (meta|facebook)/i, /(meta|facebook) partner/i, /partner(ed|ship) with (meta|facebook)/i, /official(ly)? (meta|facebook)/i, /compliant with (meta|facebook)/i, /(customers|dealers|salespeople) (say|love|report)/i, /\b(five|5) stars?\b/i, /\d+\s*(%|percent|x|times) (faster|more|fewer)/i, /hours? (a|per) (day|week)/i, /industry[- ]leading/i, /best[- ]in[- ]class/i, /\b#1\b/];
  // and what customer-facing copy may not say either
  const notToCustomers = [/testimonial/i, /never (be|get) restricted/i, /your account is (safe|protected)/i, /\brisk[- ]free\b/i, /\bno risk\b/i, /\bbots?\b/i];
  const rest = text.replace(/(not|no|isn't|not be|without|never|can't|cannot|won't|doesn't|don't|no one can|no tool can)[a-z' ]{0,20}guarantee[ds]?/gi, '').replace(/a guarantee\b/gi, '');
  assert.doesNotMatch(rest, /\bguarantee[ds]?\b/i, 'the page makes a guarantee');
  for (const re of [...never, ...notToCustomers]) assert.doesNotMatch(text, re, `the page matches ${re}`);
  // no logos, no review widgets, no invented proof: the only images are the sandbox screenshots
  for (const m of html.matchAll(/<img\b([^>]*)>/gi)) assert.match(m[1], /\bsrc="screenshots\/[\w-]+\.png"/, `an image that is not a sandbox screenshot: <img${m[1]}>`);
  assert.doesNotMatch(text, /\b(reviews?|rated|trusted by)\b/i, 'no review or trust claims');
});

test('site/pricing.json is the marketing pricing config, and the page quotes it', () => {
  assert.deepEqual(JSON.parse(read('../site/pricing.json')), pricing, 'site/pricing.json equals marketing/pricing.json');
  // the fallback text (what a visitor sees with JavaScript off) carries the same numbers
  assert.match(text, new RegExp(`\\${money(pricing.perRooftopMonthly)} per rooftop per month`), 'quotes the monthly price');
  assert.match(text, new RegExp(`\\${money(pricing.extraSalespersonMonthly)} a month`), 'quotes the seat price');
  assert.match(text, new RegExp(`\\${money(pricing.foundingDealerMonthly)} a month`), 'quotes the founding rate');
  assert.match(text, new RegExp(`${pricing.pilotDays}[ -]day`), 'quotes the pilot length');
  assert.match(text, new RegExp(`${pricing.includedSalespeople === 5 ? 'five' : pricing.includedSalespeople} salespeople included`), 'quotes the included seats');
  assert.match(text, new RegExp(`first ${pricing.foundingDealerCount === 5 ? 'five' : pricing.foundingDealerCount} stores`), 'quotes the founding count');
  assert.match(text, /planned pric/i, 'labelled as planned pricing');
  assert.match(text, /confirmed with you before any paid subscription/i, 'confirmed before any paid subscription');
  // no other dollar-per-month figure
  const allowed = new Set([pricing.perRooftopMonthly, pricing.extraSalespersonMonthly, pricing.foundingDealerMonthly].map(money));
  for (const m of text.matchAll(/(\$[\d,]+)\s*(?:a|per)\s*month/g)) assert.ok(allowed.has(m[1]), `${m[0]} is not from pricing.json`);
  // every number JavaScript fills has fallback text, and a key the config has
  for (const m of html.matchAll(/data-pricing="([^"]+)">([^<]*)</g)) {
    assert.ok(m[2].trim().length > 0, `data-pricing="${m[1]}" has fallback text`);
    assert.ok(m[1] === 'foundingDealerTerm' || m[1] in pricing, `data-pricing="${m[1]}" is a pricing.json field`);
  }
  assert.match(js, /fetch\('\.\/pricing\.json'/, 'site.js reads the copied config');
});

test('the page speaks to any dealership', () => {
  // copied from test/anyDealer.test.js
  const PILOT = /Waynesburg|Ron Lewis|Cranberry|Pleasant Hills|15370|\$\s?490\b|\bRoger\b|ronlewis/i;
  const files = readdirSync(new URL('../site/', import.meta.url), { withFileTypes: true }).filter((d) => d.isFile()).map((d) => '../site/' + d.name);
  for (const rel of [...files, '../scripts/screenshots.mjs']) {
    const hit = read(rel).match(PILOT);
    assert.equal(hit, null, `${rel.slice(3)} contains "${hit && hit[0]}"`);
  }
});

test('every screenshot the page shows exists at 1280 x 800, has alt text and says it is the sandbox with sample data', () => {
  const figures = [...html.matchAll(/<figure\b[\s\S]*?<\/figure>/g)].map((m) => m[0]);
  assert.equal(figures.length, 5, 'the five images of the store plan (store/listing.md, Screenshots)');
  assert.equal((html.match(/<img\b/gi) || []).length, figures.length, 'one image per figure and no other');
  const section = html.match(/<section id="see"[\s\S]*?<\/section>/);
  assert.ok(section, 'the See it section');
  assert.match(stripTags(section[0]), /sandbox[\s\S]*sample data/i, 'the section says where the images come from');
  for (const fig of figures) {
    const attrs = fig.match(/<img\b([^>]*)>/)[1];
    const src = (attrs.match(/\bsrc="([^"]+)"/) || [])[1];
    assert.match(src, /^screenshots\/[\w-]+\.png$/, `image source ${src}`);
    const file = new URL('../site/' + src, import.meta.url);
    assert.ok(existsSync(file), `${src} exists (npm run screenshots draws it)`);
    const png = readFileSync(file);
    assert.equal(png.toString('ascii', 12, 16), 'IHDR', `${src} is a PNG`);
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1280, 800], `${src} is 1280 x 800`);
    assert.ok(png.length <= 400 * 1024, `${src} is ${png.length} bytes; keep it under 400 KB (a JPEG, with this test extended for it)`);
    const alt = (attrs.match(/\balt="([^"]*)"/) || [])[1] || '';
    assert.ok(alt.trim().length >= 40, `${src} has alt text that says what is shown`);
    for (const a of ['width="1280"', 'height="800"', 'loading="lazy"']) assert.ok(attrs.includes(a), `${src} has ${a}`);
    const caption = stripTags((fig.match(/<figcaption>[\s\S]*?<\/figcaption>/) || [''])[0]);
    assert.match(caption, /Sandbox with sample data\./, `${src} has a caption that says it is the sandbox with sample data`);
  }
  assert.match(css, /\.shots img \{[^}]*max-width: 100%/, 'images scale to the column');
});

test('every link is an anchor or a legal placeholder, and nothing loads from a third party', () => {
  const placeholders = new Set(['/terms', '/privacy', '/posting-rules']);
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length > 5);
  for (const href of hrefs) {
    assert.ok(/^#[\w-]+$/.test(href) || placeholders.has(href) || href === 'site.css', `href ${href}`);
  }
  for (const p of placeholders) assert.ok(hrefs.includes(p), `links to ${p}`);
  assert.doesNotMatch(html, /https?:\/\//i, 'no absolute URLs in the page');
  assert.doesNotMatch(css, /https?:\/\/|@import|url\(/i, 'no external assets in the stylesheet');
  assert.doesNotMatch(js, /https?:\/\//i, 'site.js names no address of its own');
  const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
  assert.deepEqual(scripts, [' type="module" src="site.js"'], 'one script, the page module');
  const links = [...html.matchAll(/<link\b([^>]*)>/g)].map((m) => m[1]);
  assert.deepEqual(links, [' rel="stylesheet" href="site.css"'], 'one stylesheet, ours');
  assert.doesNotMatch(html, /<(iframe|embed|object)\b/i);
  assert.doesNotMatch(html, /font-face|fonts\./i);
});

test('the demo form sends to the configured places only, and works without JavaScript', async () => {
  const { SITE } = await import('../site/config.js');
  assert.equal(typeof SITE.demoEndpoint, 'string');
  assert.match(SITE.demoMailto, /^mailto:[^\s@]+@[^\s@]+$/);
  const form = html.match(/<form\b([^>]*)>/)[1];
  assert.match(form, new RegExp(`action="${SITE.demoMailto}"`), 'the form action is the mailto from config.js');
  assert.match(form, /method="post"/);
  assert.match(form, /enctype="text\/plain"/, 'a mailto form needs text/plain to carry the fields');
  for (const name of ['name', 'dealership', 'website', 'email', 'phone', 'message']) {
    assert.match(html, new RegExp(`name="${name}"`), `field ${name}`);
  }
  assert.match(js, /SITE\.demoEndpoint/);
  assert.match(js, /SITE\.demoMailto/);
  assert.match(js, /Supabase Edge Function|Edge Function/, 'says what the endpoint will be');
  // fetch() is called only for the local config and the configured endpoint
  const fetches = [...js.matchAll(/fetch\(([^,)]+)/g)].map((m) => m[1].trim());
  assert.deepEqual(fetches.sort(), ["'./pricing.json'", 'SITE.demoEndpoint'].sort());
  assert.doesNotMatch(js, /XMLHttpRequest|sendBeacon|navigator\.share|new Image/);
});

test('semantic, labelled and reachable: skip link, landmarks, labels on every field, sections in order', () => {
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /<a class="skip" href="#main">/);
  assert.match(html, /<main id="main">/);
  for (const tag of ['header', 'nav', 'main', 'footer', 'section', 'h1', 'h2', 'form']) assert.match(html, new RegExp(`<${tag}\\b`), `<${tag}>`);
  assert.equal((html.match(/<h1\b/g) || []).length, 1, 'one h1');
  // every field has a label
  for (const m of html.matchAll(/<(input|textarea|select)\b([^>]*)>/g)) {
    const id = (m[2].match(/\bid="([^"]+)"/) || [])[1];
    assert.ok(id, `${m[0]} has an id`);
    assert.match(html, new RegExp(`<label for="${id}"`), `a label for #${id}`);
  }
  // sections in the order the plan names
  const ids = [...html.matchAll(/<section[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['how', 'see', 'features', 'wont', 'needs', 'pricing', 'faq', 'demo']);
  assert.match(html, /<section class="hero"/);
  for (const q of ['Does it post for me?', 'What does it read?', 'Where is my data?', 'What about my Facebook password?', 'Which websites work?', 'How do updates arrive?']) {
    assert.ok(text.includes(q), `FAQ: ${q}`);
  }
  // the five things it won't do, the three things it needs
  assert.equal((html.match(/<ul class="wont">[\s\S]*?<\/ul>/)[0].match(/<li>/g) || []).length, 5);
  assert.match(text, /Google Chrome/);
  assert.match(text, /Dealer Inspire/);
  assert.match(text, /own Facebook account/);
  // colours are the extension's, in both schemes, with focus styles
  const popup = read('../extension/popup.css');
  for (const v of ['--bg', '--text', '--accent', '--accent-text', '--muted', '--line']) {
    const light = popup.match(new RegExp(`^  ${v}: ([^;]+);`, 'm'))[1];
    assert.ok(css.includes(`${v}: ${light};`), `${v} light matches popup.css`);
  }
  assert.match(css, /prefers-color-scheme: dark/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /min-width: 720px/);
  assert.doesNotMatch(css, /width: \d{4,}px/, 'no fixed wide widths');
});
