// The website (site/) is customer-facing copy, so every page passes the same
// honesty checks as marketing/ (test/copyGuards.js and the shared lists in test/honesty.js, which
// test/marketing.test.js and the store listing's test use too), the home and
// pricing pages quote the one pricing config, no page names a dealer or loads
// anything from anywhere else, and the only images are the sandbox's
// screenshots (site/screenshots/, drawn by npm run screenshots). The home page's
// sections, its demo form in both states (closed until config.js names an
// endpoint or an inbox), its policy and the Start a free pilot links (shown
// only once config.js names the manager view) are checked here; the page map
// against every committed page is test/sitePages.test.js, the generator
// test/siteGenerator.test.js, the legal pages test/legalPages.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { PAGES, cspFor, sitePricing, SITE_PRICING_FIELDS } from '../scripts/site-pages.mjs';
import { SITE } from '../site/config.js';
import { copyProblems } from './copyGuards.js';
import { honestyProblems, offPricing } from './honesty.js';
import { checkPreOwned } from '../extension/src/classify.js';
import { profileFrom } from '../extension/src/settings.js';
import { ADAPTERS, isCheckedLive } from '../extension/adapters/index.js';
import { DEFAULT_DAILY_CAP } from '../extension/src/cap.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const html = read('../site/index.html');
const pricingPage = read('../site/pricing/index.html');
const faqPage = read('../site/faq/index.html');
const howPage = read('../site/how-it-works/index.html');
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

test('the page says who publishes, that Lot Current never does, and that it is not affiliated with Meta', () => {
  assert.match(text, /not affiliated with Meta Platforms, Inc\./, 'carries the non-affiliation line');
  assert.match(text, /clicks? Publish/, 'says the person clicks Publish');
  assert.match(text, /never clicks Publish|Lot Current never does|never (clicks|does) Publish|Lot Current never clicks/i, 'says Lot Current never does');
  assert.match(text, /not a guarantee|isn't a guarantee|is not guaranteed|won't pretend|no tool can honestly promise/, 'does not oversell safety');
  assert.match(text, /safest design available/, 'the honest line about a person clicking Publish');
  assert.match(text, /Is this allowed on Facebook\?/, 'the FAQ asks the question straight');
});

// test/copyGuards.js and the shared honesty lists (test/honesty.js): what no customer-facing text may say, the same
// rules as the marketing kit and the store listing
function assertHonest(said, where) {
  assert.deepEqual(copyProblems(said), [], where);
  assert.deepEqual(honestyProblems(said), [], where);
}

test('no claim we have not measured, and nothing that sounds like Meta approval', () => {
  assertHonest(text, 'the page');
  // every page the generator writes from a fragment (the legal texts name the forbidden things only to deny
  // them; test/sitePages.test.js reads those denials first and scans them too)
  const fragmentPages = PAGES.filter((p) => p.kind !== 'legal');
  assert.ok(fragmentPages.length >= 8, 'the map has the fragment pages');
  for (const p of fragmentPages) assertHonest(stripTags(read(`../${p.file}`)), `the ${p.slug} page`);
  // no logos, no review widgets, no invented proof: the only images are the sandbox screenshots
  for (const m of html.matchAll(/<img\b([^>]*)>/gi)) assert.match(m[1], /\bsrc="\.\/screenshots\/[\w-]+\.png"/, `an image that is not a sandbox screenshot: <img${m[1]}>`);
  assert.doesNotMatch(text, /\b(reviews?|rated|trusted by)\b/i, 'no review or trust claims');
});

test('site/pricing.json is the public part of the marketing pricing config, and the page quotes it', () => {
  // review: the site served marketing/pricing.json whole, its reasoning ("why"), what would change the price
  // ("wouldChangeIt") and its notes included; it carries only the numbers the pages show
  const served = JSON.parse(read('../site/pricing.json'));
  assert.deepEqual(served, sitePricing(pricing), 'site/pricing.json is the public fields of marketing/pricing.json (npm run site-pages)');
  for (const k of ['why', 'wouldChangeIt', 'notes']) assert.ok(!(k in served), `site/pricing.json publishes marketing/pricing.json's "${k}"`);
  assert.deepEqual(Object.keys(served).sort(), SITE_PRICING_FIELDS.filter((k) => k in pricing).sort());
  for (const k of Object.keys(served)) assert.equal(served[k], pricing[k], `site/pricing.json's ${k} is marketing/pricing.json's`);
  // every field the pages and site.js read is there: the data-pricing keys, the founding term's months, the pilot's length
  for (const m of (html + pricingPage).matchAll(/data-pricing="([^"]+)"/g)) assert.ok(m[1] === 'foundingDealerTerm' || m[1] in served, `data-pricing="${m[1]}" is in site/pricing.json`);
  for (const k of ['foundingDealerMonths', 'pilotDays', 'hypothesis', 'currency']) assert.ok(k in served, `site/pricing.json carries ${k}`);
  // the fallback text (what a visitor sees with JavaScript off) carries the same numbers
  assert.match(text, new RegExp(`\\${money(pricing.perRooftopMonthly)} per rooftop per month`), 'quotes the monthly price');
  assert.match(text, new RegExp(`\\${money(pricing.extraSalespersonMonthly)} a month`), 'quotes the seat price');
  // the home page gives the short version and links the pricing page for the rest
  const priced = text + ' ' + stripTags(pricingPage);
  assert.match(stripTags(pricingPage), new RegExp(`\\${money(pricing.foundingDealerMonthly)} a month`), 'the pricing page quotes the founding rate');
  assert.match(priced, new RegExp(`${pricing.pilotDays}[ -]day`), 'quotes the pilot length');
  assert.match(text, new RegExp(`${pricing.includedSalespeople === 5 ? 'five' : pricing.includedSalespeople} salespeople included`), 'quotes the included seats');
  assert.match(stripTags(pricingPage), new RegExp(`first ${pricing.foundingDealerCount === 5 ? 'five' : pricing.foundingDealerCount} stores`), 'the pricing page quotes the founding count');
  assert.match(html, /<a href="\.\/pricing\/">The pricing page<\/a> has the founding-dealer price/, 'the home page links the rest');
  assert.match(text, /planned pric/i, 'labelled as planned pricing');
  assert.match(text, /confirmed with you before any paid subscription/i, 'confirmed before any paid subscription');
  // no other dollar figure, whatever words follow it
  assert.deepEqual(offPricing(priced, pricing), [], 'a price that is not from pricing.json');
  // every number JavaScript fills has fallback text, and a key the config has
  for (const m of (html + pricingPage).matchAll(/data-pricing="([^"]+)">([^<]*)</g)) {
    assert.ok(m[2].trim().length > 0, `data-pricing="${m[1]}" has fallback text`);
    assert.ok(m[1] === 'foundingDealerTerm' || m[1] in pricing, `data-pricing="${m[1]}" is a pricing.json field`);
  }
  assert.match(js, /fetch\(ROOT \+ 'pricing\.json'/, 'site.js reads the copied config from the page\'s root (data-root)');
});

test('the page speaks to any dealership', () => {
  // copied from test/anyDealer.test.js
  const PILOT = /Waynesburg|Ron Lewis|Cranberry|Pleasant Hills|15370|\$\s?490\b|\bRoger\b|ronlewis/i;
  const walk = (dir, out = []) => {
    for (const d of readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })) {
      if (d.isDirectory()) walk(dir + d.name + '/', out);
      else if (/\.(html|css|js|json|txt|xml|svg|md)$/.test(d.name)) out.push(dir + d.name);
    }
    return out;
  };
  const files = [...walk('../site/'), ...walk('../site-src/')];
  for (const rel of [...files, '../scripts/screenshots.mjs']) {
    const hit = read(rel).match(PILOT);
    assert.equal(hit, null, `${rel.slice(3)} contains "${hit && hit[0]}"`);
  }
});

// site/ is published whole (.github/workflows/pages.yml uploads the folder), so a file in
// site/screenshots/ that no page shows (a failed run's capture, say) would be published too.
test('site/screenshots holds exactly the images the pages show, and npm run screenshots writes nothing else there', () => {
  const shown = new Set();
  const walk = (dir) => {
    for (const d of readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })) {
      if (d.isDirectory()) walk(dir + d.name + '/');
      else if (/\.(html|css|js)$/.test(d.name)) for (const m of read(dir + d.name).matchAll(/screenshots\/([\w.-]+)/g)) shown.add(m[1]);
    }
  };
  walk('../site/');
  assert.ok(shown.size >= 1, 'the pages show the sandbox screenshots');
  assert.deepEqual(readdirSync(new URL('../site/screenshots/', import.meta.url)).sort(), [...shown].sort(), 'site/screenshots/ holds a file no page shows, or misses one a page shows');
  // the script: its shot() helper draws exactly those names, and every other capture goes to a git-ignored folder
  const src = read('../scripts/screenshots.mjs');
  assert.deepEqual([...src.matchAll(/\bshot\('([^']+)'\)/g)].map((m) => m[1]).sort(), [...shown].sort(), 'npm run screenshots draws exactly the images the pages show');
  const ignored = read('../.gitignore').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const others = [...src.matchAll(/page\.screenshot\(\{\s*path:\s*((?:[^,(){}]|\([^()]*\))+)/g)].map((m) => m[1].trim()).filter((p) => p !== 'file'); // file: shot()'s own
  assert.ok(others.length >= 1, 'the failure capture is still taken');
  for (const p of others) {
    assert.doesNotMatch(p, /\bshots\b/, `screenshots.mjs captures ${p} into site/screenshots/, which is published`);
    const def = /^[A-Za-z_$][\w$]*$/.test(p) ? (src.match(new RegExp(`const ${p} = (.+);`)) || [])[1] : p;
    const dir = (String(def).match(/^join\(root, '([^']+)'/) || [])[1];
    assert.ok(dir, `screenshots.mjs captures to ${p}, which is not join(root, '<folder>', ...)`);
    assert.ok(!/^site(\/|$)/.test(dir), `screenshots.mjs captures ${p} into ${dir}, which is published`);
    assert.ok(ignored.includes(dir.replace(/\/?$/, '/')), `screenshots.mjs captures ${p} into ${dir}, which .gitignore does not ignore`);
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
    assert.match(src, /^\.\/screenshots\/[\w-]+\.png$/, `image source ${src}`);
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
  // the fifth image is the popup's numbers tab, named as the popup labels it (Numbers since 0.5.0)
  const popup = read('../extension/popup.js');
  const label = popup.match(/\['pilot', '([^']+)'\]/)[1];
  assert.match(figures[4], new RegExp(`alt="The popup's ${label} tab`), `the fifth image's alt text names the ${label} tab`);
});

// The page's Content-Security-Policy, the one place an outside host is named.
const CSP_TAG = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/;

test('every link is an anchor on the page or one of the legal pages, and nothing loads from a third party', () => {
  const legal = ['./legal/terms/', './legal/privacy/', './legal/posting-rules/'];
  // Once siteUrl is set the page names its own address in the canonical link
  // and the share tags; that is this site, and nothing is fetched from it.
  const canonical = SITE.siteUrl ? `<link rel="canonical" href="${SITE.siteUrl}/">` : null;
  assert.equal(canonical ? html.split(canonical).length - 1 : 0, canonical ? 1 : 0, 'one canonical, on the home page\'s own address, only once siteUrl is set');
  const own = (text) => (SITE.siteUrl ? text.split(canonical).join('').split(`content="${SITE.siteUrl}/`).join('content="') : text);
  const hrefs = [...own(html).matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length > 5);
  for (const href of hrefs) {
    assert.ok(/^#[\w-]+$/.test(href) || href.startsWith('./'), `href ${href}`);
    if (href.startsWith('#')) assert.match(html, new RegExp(`id="${href.slice(1)}"`), `${href} is on the page`);
    else assert.ok(existsSync(new URL('../site/' + href.slice(2) + (href.endsWith('/') ? 'index.html' : ''), import.meta.url)), `${href} resolves to a file under site/`);
  }
  // the footer links the three pages npm run legal-pages writes, by relative address
  const footer = html.match(/<footer>[\s\S]*?<\/footer>/)[0];
  assert.deepEqual([...footer.matchAll(/href="([^"]*)"/g)].map((m) => m[1]), legal);
  for (const p of legal) assert.ok(existsSync(new URL('../site/' + p.slice(2) + 'index.html', import.meta.url)), `site/${p.slice(2)}index.html exists (npm run legal-pages)`);
  assert.doesNotMatch(own(html).replace(CSP_TAG, '').replace(/<script type="application\/ld\+json">[^<]*<\/script>/, ''), /https?:\/\//i, 'no absolute URLs in the page (the structured data names https://schema.org as its vocabulary; nothing is fetched)');
  assert.doesNotMatch(css, /https?:\/\/|@import|url\(/i, 'no external assets in the stylesheet');
  assert.doesNotMatch(js, /https?:\/\//i, 'site.js names no address of its own');
  const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
  assert.deepEqual(scripts, [' type="application/ld+json"', ' type="module" src="./site.js"'], 'the structured data block and the page module, nothing else');
  const links = [...own(html).matchAll(/<link\b([^>]*)>/g)].map((m) => m[1]);
  assert.deepEqual(links, [' rel="icon" href="./favicon.svg" type="image/svg+xml"', ' rel="icon" href="./favicon-32.png" type="image/png" sizes="32x32"', ' rel="apple-touch-icon" href="./apple-touch-icon.png"', ' rel="stylesheet" href="./site.css"'], 'the favicons and our stylesheet, nothing else (canonical only once config.js has siteUrl)');
  assert.doesNotMatch(html, /<(iframe|embed|object)\b/i);
  assert.doesNotMatch(html, /font-face|fonts\./i);
});

test('the page runs under a Content-Security-Policy: its own files, the lead function, and the mailto form', async () => {
  const { SITE } = await import('../site/config.js');
  const csp = (html.match(CSP_TAG) || [])[1];
  assert.ok(csp, 'the page has a Content-Security-Policy');
  const rules = Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
  assert.deepEqual(rules, {
    'default-src': ["'self'"],
    'script-src': ["'self'"],
    'style-src': ["'self'"],
    'img-src': ["'self'"],
    'connect-src': ["'self'", 'https://*.supabase.co'],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': [SITE.demoMailto ? 'mailto:' : "'none'"],
  });
  // nothing inline, which the policy would block: no inline script, style or handler (a JSON-LD block is data the browser never runs)
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)(?![^>]*type="application\/ld\+json")[^>]*>|<style\b|\sstyle="|\son[a-z]+="/i);
  // every other page runs under the tighter variant: no script at all, only its stylesheet and images; /pricing/ loads site.js like the home page
  const noScript = "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'";
  for (const p of PAGES) {
    const policy = (read(`../${p.file}`).match(CSP_TAG) || [])[1];
    assert.equal(policy, cspFor(p, SITE), `${p.file}: the policy the generator gives the page`);
    if (p.script) assert.equal(policy, csp.replace(/form-action .*$/, p.slug === 'home' ? csp.match(/form-action .*$/)[0] : "form-action 'none'"), `${p.file}: the script variant, with form-action mailto: only on the home page`);
    else assert.equal(policy, noScript, `${p.file}: the no-script variant`);
  }
  assert.deepEqual(PAGES.filter((p) => p.script).map((p) => p.slug), ['home', 'pricing'], 'site.js loads on the home and pricing pages only');
  // the form's action and the configured endpoint are allowed by it
  if (SITE.demoMailto) assert.match(SITE.demoMailto, /^mailto:/, 'form-action allows the mailto form');
  if (SITE.demoEndpoint) assert.match(new URL(SITE.demoEndpoint).hostname, /\.supabase\.co$/, 'connect-src allows demoEndpoint; change both together');
});

test('the demo form sends to the configured places only, and works without JavaScript', async () => {
  const { SITE } = await import('../site/config.js');
  assert.equal(typeof SITE.demoEndpoint, 'string');
  assert.ok(SITE.demoMailto === '' || /^mailto:[^\s@]+@[^\s@]+$/.test(SITE.demoMailto), 'demoMailto is empty or a mailto address');
  assert.doesNotMatch(SITE.demoMailto + SITE.demoEndpoint, /\.example\b|example\.(com|org|net)/, 'no placeholder address');
  const form = html.match(/<form\b([^>]*)>/)[1];
  if (SITE.demoMailto) {
    assert.match(form, new RegExp(`action="${SITE.demoMailto}"`), 'the form action is the mailto from config.js');
    assert.match(form, /method="post"/);
    assert.match(form, /enctype="text\/plain"/, 'a mailto form needs text/plain to carry the fields');
  } else {
    assert.doesNotMatch(form, /action=/, 'no action until config.js names an inbox');
    if (!SITE.demoEndpoint) {
      assert.match(form, /\shidden/, 'the form is hidden while it is not open');
      assert.match(html, /<p id="demo-closed" class="notice">The demo request form is not open yet\.<\/p>/, 'the page says the form is not open yet');
    }
  }
  for (const name of ['name', 'dealership', 'website', 'email', 'phone', 'message']) {
    assert.match(html, new RegExp(`name="${name}"`), `field ${name}`);
  }
  assert.match(js, /SITE\.demoEndpoint/);
  assert.match(js, /SITE\.demoMailto/);
  assert.match(js, /Supabase Edge Function|Edge Function/, 'says what the endpoint will be');
  // fetch() is called only for the local config and the configured endpoint
  const fetches = [...js.matchAll(/fetch\(([^,)]+)/g)].map((m) => m[1].trim());
  assert.deepEqual(fetches.sort(), ["ROOT + 'pricing.json'", 'SITE.demoEndpoint'].sort());
  assert.doesNotMatch(js, /XMLHttpRequest|sendBeacon|navigator\.share|new Image/);
});

test('semantic, labelled and reachable: skip link, landmarks, labels on every field, sections in order', () => {
  assert.match(html, /<html lang="en" data-root="\.\/">/);
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
  assert.deepEqual(ids, ['how', 'see', 'features', 'wont', 'pricing', 'faq', 'demo']);
  assert.match(html, /<section class="hero"/);
  const faqText = stripTags(faqPage);
  assert.ok(text.includes('Does it post for me?'), 'FAQ on the home page: Does it post for me?');
  for (const q of ['Is this allowed on Facebook?', 'Does it post for me?', 'What does it read?', 'Where is my data?', 'What about my Facebook password?', 'Which websites work?', 'How do updates arrive?']) {
    assert.ok(faqText.includes(q), `FAQ page: ${q}`);
  }
  // the five things it won't do; the three things it needs are on the how-it-works page
  assert.equal((html.match(/<ul class="wont">[\s\S]*?<\/ul>/)[0].match(/<li>/g) || []).length, 5);
  const howText = stripTags(howPage);
  assert.match(howText, /Google Chrome/);
  assert.match(howText, /Dealer Inspire/);
  assert.match(howText, /own Facebook account/);
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

// site.js run against a stand-in page: the two Start a free pilot links, and pricing.json as the server
// answers it (or not). Answers the links as site.js left them.
let runs = 0;
async function runSite({ signupUrl, pricing }) {
  const configImport = "import { SITE } from './config.js';";
  assert.ok(js.includes(configImport), 'site.js takes its addresses from config.js');
  runs += 1;
  // a stand-in config.js: a fixture inbox (never a reserved placeholder host, which the generator refuses; it exists only in test/)
  const config = { demoEndpoint: '', demoMailto: 'mailto:demo@fixture.lotcurrent.com', supportEmail: '', siteUrl: '', signupUrl };
  const code = js.replace(configImport, `const SITE = ${JSON.stringify(config)};`) + `\n// run ${runs}\n`;
  const links = [0, 1].map(() => ({ hidden: true, href: '', textContent: 'Start a free pilot' }));
  const stubs = {
    document: { getElementById: () => null, querySelectorAll: (sel) => (sel === 'a[data-signup]' ? links : []) },
    fetch: async (url) => (url === './pricing.json' && pricing ? { ok: true, status: 200, json: async () => pricing } : { ok: false, status: 404 }),
  };
  const saved = Object.fromEntries(Object.keys(stubs).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  Object.assign(globalThis, stubs);
  try {
    await import('data:text/javascript,' + encodeURIComponent(code));
    await new Promise((done) => setTimeout(done, 0)); // pricing.json read, links shown
  } finally {
    for (const [k, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(globalThis, k, d);
      else delete globalThis[k];
    }
  }
  return links;
}

test('Start a free pilot: hidden in the page, shown only once config.js names the manager view, with the pilot length from pricing.json', async () => {
  const { SITE } = await import('../site/config.js');
  assert.equal(SITE.signupUrl, '', 'empty until the owner opens self-serve sign-up');
  const config = read('../site/config.js');
  assert.match(config, /"Self-serve\s+\/\/ sign-up"|"Self-serve sign-up"/, 'config.js points at the README section');
  assert.match(config, /selfServeSignup in manager\/config\.js/, 'and at the manager view\'s switch');
  // in the page: next to the demo request in the hero and under Pricing, hidden, with no address and no number
  const pair = /<div class="actions">\s*<a class="button" href="#demo">Request a demo<\/a>\s*<a class="button alt" data-signup hidden>Start a free pilot<\/a>\s*<\/div>/;
  const hero = html.match(/<section class="hero"[\s\S]*?<\/section>/)[0];
  const pricingSection = html.match(/<section id="pricing"[\s\S]*?<\/section>/)[0];
  assert.match(hero, pair, 'the hero: Request a demo, then Start a free pilot');
  assert.match(pricingSection, pair, 'Pricing: Request a demo, then Start a free pilot');
  assert.match(pricingPage, /<div class="actions">\s*<a class="button" href="\.\.\/#demo">Request a demo<\/a>\s*<a class="button alt" data-signup hidden>Start a free pilot<\/a>\s*<\/div>/, '/pricing/: Request a demo (on the home page), then Start a free pilot');
  const tags = [...(html + pricingPage).matchAll(/<a\b[^>]*\bdata-signup\b[^>]*>([^<]*)<\/a>/g)];
  assert.equal(tags.length, 3, 'two links on the home page and one on /pricing/, no more');
  for (const [tag, label] of tags) {
    assert.match(tag, /\shidden>/, 'hidden until site.js shows it');
    assert.doesNotMatch(tag, /href=/, 'no address until config.js gives one');
    assert.doesNotMatch(label, /\d/, 'no number written into the page');
  }
  assert.match(css, /\[hidden\] \{ display: none !important; \}/, 'the hidden attribute beats .button\'s display');

  // signupUrl empty: nothing changes, whatever pricing.json says
  for (const link of await runSite({ signupUrl: '', pricing })) assert.deepEqual(link, { hidden: true, href: '', textContent: 'Start a free pilot' });
  // set: both links shown, to that address, with the pilot's length from pricing.json
  const url = 'https://app.fixture.lotcurrent.com/manager/';
  for (const link of await runSite({ signupUrl: url, pricing })) {
    assert.deepEqual(link, { hidden: false, href: url, textContent: `Start a free ${pricing.pilotDays}-day pilot` });
  }
  for (const link of await runSite({ signupUrl: url, pricing: { ...pricing, pilotDays: 14 } })) assert.equal(link.textContent, 'Start a free 14-day pilot', 'the length is read, not written in');
  // pricing.json unreadable: shown, with no length rather than a guessed one
  for (const link of await runSite({ signupUrl: url, pricing: null })) assert.deepEqual(link, { hidden: false, href: url, textContent: 'Start a free pilot' });
  // a path on this site works too; anything that is not https or a path shows nothing
  for (const ok of ['../manager/', '/manager/index.html', './manager/']) assert.equal((await runSite({ signupUrl: ok, pricing }))[0].href, ok, ok);
  for (const bad of ['javascript:alert(1)', 'http://app.fixture.lotcurrent.com/', 'app.fixture.lotcurrent.com/manager/', '//app.fixture.lotcurrent.com/', 'https://', ' ', 'https://app.fixture.lotcurrent.com/ x']) {
    for (const link of await runSite({ signupUrl: bad, pricing })) assert.equal(link.hidden, true, `${JSON.stringify(bad)} shows nothing`);
  }

  // the page's honesty rules hold with the links shown
  assertHonest(text.replaceAll('Start a free pilot', `Start a free ${pricing.pilotDays}-day pilot`), 'the page with sign-up open');
  assert.doesNotMatch(js, /https?:\/\//i, 'site.js still names no address of its own');
});

// review: the support page's privacy section said "nothing leaves your browser" and that Clear everything
// for this website removes it, while the privacy policy (and the code) put the profile in Chrome's sync
// storage, send a VIN to NHTSA on a click and send the car's facts to the rewrite service when it is on,
// and keep the synced profile until Forget my synced profile.
test('no customer-facing page says nothing leaves the browser, and the support page names where data goes without an account', () => {
  const policy = read('../legal/privacy-policy.md');
  const claim = /nothing (ever )?(leaves|leaving) (your|the) (browser|computer)|never leaves (your|the) (browser|computer)|everything stays in (your|the) browser/i;
  const files = [
    ...PAGES.filter((p) => p.kind !== 'legal').map((p) => `../${p.file}`),
    ...readdirSync(new URL('../marketing/', import.meta.url)).filter((f) => f.endsWith('.md')).map((f) => `../marketing/${f}`),
    ...readdirSync(new URL('../store/', import.meta.url)).filter((f) => f.endsWith('.md')).map((f) => `../store/${f}`),
  ];
  for (const rel of files) assert.doesNotMatch(stripTags(read(rel)), claim, `${rel.slice(3)} says nothing leaves the browser`);
  const support = stripTags(read('../site/support/index.html'));
  const privacy = support.slice(support.indexOf('Privacy requests'), support.indexOf('What support never does'));
  assert.ok(privacy.length > 100, 'the support page has its Privacy requests section');
  if (/Chrome's sync storage/.test(policy)) {
    assert.match(privacy, /Chrome's sync storage/, 'the privacy policy keeps the profile in Chrome sync; the support page says so');
    assert.match(privacy, /Forget my synced profile/, 'and names the button that removes it');
  }
  if (/NHTSA/.test(policy)) assert.match(privacy, /NHTSA/, 'the privacy policy sends a VIN to NHTSA on a click; the support page says so');
  if (/rewrite service/.test(policy)) assert.match(privacy, /rewrite service/, 'the privacy policy sends the car\'s facts to the rewrite service when it is on; the support page says so');
  // review: neither page named where the rewrite service sends the facts on to, which the privacy policy does
  if (/Anthropic/.test(policy)) {
    assert.match(privacy, /rewrite service[^.]*on to Anthropic's API/, 'the support page names Anthropic as the privacy policy does');
    const where = stripTags(faqPage).match(/Where is my data\? (.*?) What about my Facebook password\?/);
    assert.ok(where, 'the FAQ has its Where is my data? answer');
    assert.match(where[1], /rewrite service[^.]*on to Anthropic's API/, 'the FAQ\'s Where is my data? names Anthropic as the privacy policy does');
    // and what goes there, as the policy lists it: the dealership's name and city, the price note and, for a
    // colour guess, up to four photo addresses; never the VIN or the price
    for (const [page, said] of [['the support page', privacy], ['the FAQ\'s Where is my data?', where[1]]]) {
      if (/the dealership's name and city/.test(policy)) assert.match(said, /the dealership's name and city/, `${page} says the dealership's name and city go to the rewrite service`);
      if (/the price note/.test(policy)) assert.match(said, /the price note/, `${page} says the price note goes to the rewrite service`);
      if (/up to four photo addresses/.test(policy)) assert.match(said, /up to four of the car's photo addresses/, `${page} says photo addresses go on to Anthropic for a colour guess`);
      if (/The VIN and the price are not among the fields sent/.test(policy)) assert.match(said, /not its VIN or price/, `${page} says the VIN and the price are not sent`);
      if (/NHTSA/.test(policy)) assert.match(said, /VIN goes to NHTSA only when you click Check with NHTSA/, `${page} says a VIN goes to NHTSA on a click`);
    }
  }
  assert.doesNotMatch(privacy, /Clear everything for this website removes it\b/, 'Clear everything for this website does not remove the synced profile');
});

// review: the home page, How it works and the README said "three separate signs ... have to agree" a car
// is pre-owned, while the gate (classify.js checkPreOwned) passes a car on two signs, or on one sign plus a
// linked Carfax report. The copy says what the gate does, and this reads the gate to keep it so.
test('the pre-owned check is described as the gate decides it: two signs, or one plus a Carfax link, and none new', () => {
  const car = { inventoryType: 'Used', urlConditionWord: null, siteTitle: '2019 Sample Sedan LX', mileage: 40000, carfaxUrl: null };
  const verdict = (v) => checkPreOwned({ ...car, ...v }).verdict;
  const rule = {
    two: verdict({ urlConditionWord: 'used' }) === 'pre-owned',
    oneWithCarfax: verdict({ carfaxUrl: 'https://www.carfax.com/vehicle/sample' }) === 'pre-owned',
    oneAlone: verdict({}) === 'pre-owned',
    newBlocks: verdict({ urlConditionWord: 'used', siteTitle: 'New 2019 Sample Sedan LX' }) !== 'pre-owned',
  };
  // the gate the copy below describes; a change to it changes the copy too
  assert.deepEqual(rule, { two: true, oneWithCarfax: true, oneAlone: false, newBlocks: true }, 'checkPreOwned decides differently now: update the home page, How it works, the README and this test together');
  const overclaim = /three (separate |independent )?signs[^.]*(have to|must) (all )?agree|all three signs/i;
  const docs = {
    'site/index.html': stripTags(html),
    'site/how-it-works/index.html': stripTags(howPage),
    'README.md': read('../README.md'),
  };
  for (const [name, doc] of Object.entries(docs)) assert.doesNotMatch(doc, overclaim, `${name} says all three signs must agree; the gate passes two, or one plus a Carfax link`);
  for (const rel of [...readdirSync(new URL('../marketing/', import.meta.url)).map((f) => `marketing/${f}`), ...readdirSync(new URL('../store/', import.meta.url)).filter((f) => f.endsWith('.md')).map((f) => `store/${f}`)].filter((f) => /\.(md|json)$/.test(f))) {
    assert.doesNotMatch(read(`../${rel}`), overclaim, `${rel} says all three signs must agree`);
  }
  const card = stripTags((html.match(/<h3>Pre-owned only<\/h3>\s*<p>[\s\S]*?<\/p>/) || [''])[0]);
  const how = stripTags((howPage.match(/<section aria-labelledby="preowned-h">[\s\S]*?<\/section>/) || [''])[0]);
  const readme = (read('../README.md').match(/## How the pre-owned check works\n[\s\S]*?(?=\n## )/) || [''])[0];
  for (const [name, doc] of [['the home page\'s Pre-owned only card', card], ['How it works', how], ['README.md', readme]]) {
    assert.ok(doc.length > 0, `${name} still describes the check`);
    assert.match(doc, /at least two/, `${name} says two signs are enough`);
    assert.match(doc, /one must and the (website|car's page) must link a Carfax report/, `${name} says one sign plus a Carfax link is enough`);
    assert.match(doc, /none may say new/, `${name} says a new sign stops the car`);
  }
  for (const [name, doc] of [['How it works', how], ['README.md', readme]]) assert.match(doc, /only one sign and no Carfax report goes to \**Needs a look/, `${name} says one sign alone goes to Needs a look`);
});

// review: the FAQ (sent to search engines as FAQPage data) said Lot Current reads back only the
// create-listing form and keeps nothing from Facebook beyond the links a person saves. The upkeep flow
// (upkeep.js) also reads a listing the person opens to update or take down, and a queue records the
// listing link after Publish without a click; the privacy policy says both.
test('the FAQ says what Lot Current reads and keeps from Facebook pages, as the code and the privacy policy do', () => {
  const policy = read('../legal/privacy-policy.md');
  const upkeep = read('../extension/upkeep.js');
  const qa = (q) => {
    const m = faqPage.match(new RegExp(`<h3>${q.replace(/[?]/g, '\\?')}</h3>\\s*<p>([\\s\\S]*?)</p>`));
    assert.ok(m, `the FAQ asks "${q}"`);
    return stripTags(m[1]);
  };
  const reads = qa('What does it read?');
  if (/func: readListingInPage/.test(upkeep)) {
    assert.match(policy, /title, prices and sold status shown on the Marketplace page in the tab Lot Current opened for it/, 'the privacy policy names the listing read');
    assert.match(reads, /When you open a to-do item, it reads the Marketplace page it opened for it \(the listing, or your Your listings page when no listing link was saved\) for the title, prices and a sold sign/, 'the FAQ names the listing read the upkeep flow makes');
  }
  const kept = qa('Where is my data?');
  assert.doesNotMatch(kept, /beyond the listing links you save\./, 'a queue records the listing link after Publish without a click');
  assert.match(kept, /Nothing from Facebook is kept beyond the links to your own listings \(the ones you save, or that Lot Current records after you click Publish\)/);
  assert.match(kept, /only while a post or an update is under way, what the form or the listing showed/, 'and what a post or an update read, only while it runs');
  // the structured data carries the same answers
  const ld = JSON.parse(faqPage.match(/<script type="application\/ld\+json">([^<]*)<\/script>/)[1]);
  const faq = ld['@graph'].find((n) => n['@type'] === 'FAQPage');
  assert.equal(faq.mainEntity.find((e) => e.name === 'What does it read?').acceptedAnswer.text, reads);
});

// review: How it works said "a person is at the keyboard for every one" of its four steps, and the Terms
// said Lot Current "does not act while the User is away", while background.js rescans an allowed website
// every 3 hours with nobody there and, for a signed-in salesperson, syncs the results. The texts now say a
// person starts every step that touches Facebook and clicks its buttons, and name the rescan and its upload.
test('How it works and the Terms keep "while you are away" to Facebook, and name the unattended rescan', () => {
  const bg = read('../extension/background.js');
  const rescan = bg.slice(bg.indexOf('async function runRescan'), bg.indexOf('async function rescanDueSites'));
  assert.match(bg, /chrome\.alarms\.create\(RESCAN_ALARM/, 'background.js no longer schedules the rescan: these texts can change');
  assert.match(rescan, /\bsyncSite\(/, 'the background rescan no longer syncs: these texts can change');
  const how = stripTags(howPage);
  assert.doesNotMatch(how, /at the keyboard for every/i, 'the 3-hourly rescan runs with nobody at the keyboard');
  // review: "A person does every step that touches Facebook" was wrong too: Lot Current types into the form, puts
  // the new price into the Price box and reads the listing a to-do item opened. A person starts those steps and
  // clicks every button that publishes or changes a listing.
  assert.doesNotMatch(how, /A person does every step/, 'Lot Current itself fills the form, so a person does not do every step that touches Facebook');
  assert.match(how, /A person starts every step that touches Facebook, and clicks Publish, Update, Mark as sold or Delete themselves; Lot Current fills in the form\./);
  assert.match(how, /The rescan of your website in step four can also run on its own, if you allow it, and it never touches Facebook\./);
  const step = stripTags((howPage.match(/<section aria-labelledby="honest-h">[\s\S]*?<\/section>/) || [''])[0]);
  assert.match(step, /every 3 hours while Chrome is open, with nobody at the keyboard/, 'step four says the rescan runs unattended');
  assert.match(step, /while you are signed in to a Lot Current account it also sends that rescan's results/, 'and what a signed-in rescan sends');
  assert.match(step, /it never touches Facebook then/);
  const terms = read('../legal/terms-of-service.md');
  const s1 = terms.slice(terms.indexOf('## 1.'), terms.indexOf('## 2.'));
  assert.doesNotMatch(s1, /does not act while the User is away/, 'the Terms say Lot Current does nothing while the User is away; the rescan runs then');
  assert.match(s1, /never acts on Facebook while the User is away/);
  assert.match(s1, /re-reads the dealership's website every 3 hours while Chrome is open[^.]*signed in to a Lot Current account, sends that rescan's results/, 'the Terms name the rescan and its upload');
  const page = stripTags(read('../site/legal/terms/index.html'));
  assert.match(page, /never acts on Facebook while the User is away/, 'npm run legal-pages wrote the Terms page from the Markdown');
});

// review: the For managers page said the manager view's numbers include "which form fields could not be
// filled", and the home page's Numbers caption put those fields in the dealership's account too, while
// sync.js never sends the fill records (syncPayload's pilot carries posts and flags only).
test('the site never puts the form fields that could not be filled in the manager view or the dealership\'s account', async () => {
  const { syncPayload } = await import('../extension/src/sync.js');
  const body = syncPayload({ origin: 'https://www.dealer.test', pilot: { posts: [], flags: [], fills: [{ vin: '1HGCM82633A004352', at: new Date().toISOString(), failed: ['price'] }] } });
  assert.deepEqual(Object.keys(body.pilot).sort(), ['flags', 'posts'], 'the sync sends fill records now: the site can say the manager view shows them');
  const managers = stripTags(read('../site/for-managers/index.html'));
  const numbers = managers.slice(managers.indexOf('The numbers'), managers.indexOf('Getting started'));
  assert.ok(numbers.length > 100, 'For managers has its numbers section');
  assert.doesNotMatch(numbers, /numbers the salespeople's own Numbers tab keeps: how long each post took, which form fields/, 'the manager view does not show the form fields');
  assert.match(numbers, /Which form fields could not be filled is not synced: it stays in each salesperson's own browser/);
  const caption = stripTags((html.match(/<figcaption><b>The numbers you can share[\s\S]*?<\/figcaption>/) || [''])[0]);
  assert.ok(caption, 'the home page has its Numbers caption');
  if (/dealership's account/.test(caption)) assert.match(caption, /fields that could not be filled, which stay in your browser/, 'the caption says the fields stay in the browser');
  assert.doesNotMatch(text, /managers will see the same numbers for the whole store/, 'managers see the post and to-do numbers, not the form fields');
});

// review: the website, the sales sheet and the demo script offered the free pilot "for 2 or 3 of your
// salespeople", the first pilot's own size, while the pilot agreement leaves the number for the parties to fill
// in and the manager view's Billing card offers the pilot with the plan's included seats. The copy says the
// pilot is for the salespeople named in the pilot agreement, and gives no headcount of its own.
test('the free pilot is offered for the salespeople named in the pilot agreement, with no headcount of the copy\'s own', () => {
  const agreement = read('../legal/pilot-agreement.md');
  const N = '(?:\\d+|two|three|four|five|six|seven|eight|nine|ten)';
  // the row is a blank for the parties; a note beside the blank is fine, a number in it is a standard headcount
  const row = agreement.match(/^\| Number of designated salespeople \|([^|\n]*)\|\s*$/m);
  assert.ok(row, 'the pilot agreement has its Number of designated salespeople row');
  assert.match(row[1], /^\s*\[ \]/, 'the pilot agreement no longer leaves the number of salespeople blank: say that number in the copy and change this test');
  assert.doesNotMatch(row[1], new RegExp(`\\b(?:${N}|one|a dozen|up to|at least|at most)\\b`, 'i'), 'the pilot agreement now fixes how many salespeople a pilot has: say that number in the copy and change this test');
  assert.match(agreement, /The salespeople are named at the signature block/, 'the agreement names the salespeople');
  const headcount = new RegExp(`\\bfor ${N}(?: or ${N})? (?:of your )?salespeople\\b|\\b${N} or ${N} (?:of your )?salespeople\\b|\\bwho the ${N}(?: or ${N})? salespeople\\b`, 'i');
  const files = [
    ...PAGES.filter((p) => p.kind !== 'legal').map((p) => `../${p.file}`),
    ...readdirSync(new URL('../marketing/', import.meta.url)).filter((f) => f.endsWith('.md')).map((f) => `../marketing/${f}`),
    ...readdirSync(new URL('../store/', import.meta.url)).filter((f) => f.endsWith('.md')).map((f) => `../store/${f}`),
  ];
  for (const rel of files) {
    // a bracket is the sender's to fill in for one dealership ("[two or three] salespeople")
    const said = stripTags(read(rel)).replace(/\[[^\]]*\]/g, '[ ]');
    const hit = said.match(headcount);
    assert.equal(hit, null, `${rel.slice(3)} offers the pilot to a fixed number of salespeople: "${hit && hit[0]}"`);
  }
  const pilot = stripTags(pricingPage).match(/The free pilot (.*?)Request a demo/);
  assert.ok(pilot, 'the pricing page has its free pilot section');
  assert.match(pilot[1], /free, for the salespeople named in your pilot agreement/);
  assert.match(read('../marketing/sales-sheet.md'), /free, for the salespeople named in your pilot agreement/);
});

// review: the sales sheet said "Every 3 hours while Chrome is open, Lot Current re-reads your website", and its
// lead, the pilot offer email, the demo pitch and the home page's lead said it "tells you the same day" when a car
// sells, with no condition. Automatic rescans are opt-in (set-up offers Allow automatic rescans or Skip for now,
// and background.js skips a website whose rescans are off), so a salesperson who skipped is flagged only when
// they rescan by hand. The rescans also run only while someone's Chrome is open (a chrome.alarms alarm in the
// service worker), so a store whose salespeople close Chrome for the weekend hears nothing until Monday. Every
// sentence that promises the schedule or the same-day flag names both conditions: rescans allowed, Chrome open.
// A posting rule ("take sold cars down the same day") asks something of the salesperson and is not a promise.
const RESCAN_PROMISE = /\b(?:3|three)[- ]hour(?:s|ly)?\b|\bevery few hours\b|\bsame[- ]day\b|\bwithin one rescan\b/i;
const TAKE_DOWN_RULE = /\bdown the same day\b|\bsame-day take-?downs?\b/gi;
// "rescans on" counts only as "automatic rescans on" (a setting), never the verb ("Lot Current rescans on its
// own"), and neither counts when it says the setting needs nothing from the person ("on by default").
const RESCANS_ALLOWED = /\b(?:automatic rescans on|(?:automatic )?rescans allowed)\b(?! (?:its|their) own\b| by default\b)|\bif you allow it\b|\bonly if you allow\b|\bwebsites? (?:the person|you) allow(?:ed)?\b/i;
const CHROME_OPEN = /\bChrome (?:is )?open\b/i;
// the sentences of a page or a Markdown text that promise the rescan, with their rule wording taken out
function rescanPromises(src, markdown) {
  const paragraphs = markdown
    ? src.split('\n')
    : src.replace(/<head>[\s\S]*?<\/head>/, ' ').split(/<\/(?:p|li|h[1-6]|figcaption|td|th|dd|dt|summary)>/i).map(stripTags);
  return paragraphs
    .flatMap((para) => para.split(/(?<=[.!?]["”)]?)\s+(?=["“(]?[A-Z])/))
    .filter((sentence) => RESCAN_PROMISE.test(sentence.replace(TAKE_DOWN_RULE, ' ')));
}
function unconditionalRescanPromises(src, markdown) {
  return rescanPromises(src, markdown).filter((s) => !RESCANS_ALLOWED.test(s) || !CHROME_OPEN.test(s));
}

test('the rescan-promise check catches a same-day or 3-hour promise without both conditions, and leaves posting rules alone', () => {
  for (const said of [
    'With automatic rescans allowed, it also tells you the same day when a car sells or its price changes.',
    'Lot Current flags sold cars and price changes the same day.',
    'Sold cars flagged the same day.',
    'Same-day sold-car flags, with automatic rescans on.',
    'Every 3 hours while Chrome is open, Lot Current re-reads your website.',
    'Flagged within one rescan (3 hours while Chrome is open), with the listing opened for you.',
    'It re-reads the website every few hours and tells them when a car sells.',
    'Lot Current flags sold cars the same day so they come down the same day.',
    // the verb, not the setting
    'Lot Current rescans on its own every 3 hours while Chrome is open and flags sold cars the same day.',
    'With Chrome open, Lot Current rescans on its own schedule and flags sold cars the same day.',
    'Automatic rescans on by default: every 3 hours while Chrome is open.',
  ]) assert.equal(unconditionalRescanPromises(`<p>${said}</p>`, false).length, 1, said);
  for (const said of [
    'With automatic rescans allowed and Chrome open, it also tells you the same day when a car sells or its price changes.',
    'Then, with automatic rescans allowed, it re-reads the website every 3 hours while their Chrome is open.',
    'Take sold cars down the same day.',
    'facts only, sold cars down the same day.',
    'Same-day take-downs are the point of the pilot, so please clear To do items the day they appear.',
    'The posting rules ask for sold cars to come down the same day.',
    'Downloads photos; rescans every website with automatic rescans on every 3 hours while Chrome is open.',
    'Rescans run every 3 hours while someone\'s Chrome is open with rescans allowed.',
  ]) assert.deepEqual(unconditionalRescanPromises(said, true), [], said);
});

test('every page and marketing text that promises the 3-hour rescan or the same-day flag says it needs automatic rescans allowed and Chrome open', () => {
  const files = [
    ...PAGES.filter((p) => p.kind !== 'legal').map((p) => `../${p.file}`),
    ...readdirSync(new URL('../marketing/', import.meta.url)).filter((f) => f.endsWith('.md')).map((f) => `../marketing/${f}`),
    ...readdirSync(new URL('../store/', import.meta.url)).filter((f) => f.endsWith('.md')).map((f) => `../store/${f}`),
    '../README.md',
  ];
  let promises = 0;
  const problems = [];
  for (const rel of files) {
    const src = read(rel);
    promises += rescanPromises(src, rel.endsWith('.md')).length;
    for (const s of unconditionalRescanPromises(src, rel.endsWith('.md'))) {
      problems.push(`${rel.slice(3)}: "${s.trim().slice(0, 140)}" promises the rescan without saying ${RESCANS_ALLOWED.test(s) ? 'it runs only while Chrome is open' : 'automatic rescans must be allowed'}`);
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(promises >= 8, `the texts still describe the rescan (${promises} found)`);
  // the conditions are real: background.js rescans only the websites whose rescans are on, from a chrome.alarms
  // alarm every RESCAN_PERIOD_MINUTES (an alarm fires only while Chrome runs)
  const background = read('../extension/background.js');
  assert.match(background, /if \(!info\.auto\) continue;/, 'background.js no longer skips a website whose automatic rescans are off: these texts can drop that condition');
  assert.match(background, /chrome\.alarms\.create\(RESCAN_ALARM, \{ periodInMinutes: RESCAN_PERIOD_MINUTES/, 'the rescan no longer runs from a Chrome alarm: change "while Chrome is open" with it');
  assert.match(read('../extension/src/rescanSchedule.js'), /export const RESCAN_PERIOD_MINUTES = 180;/, 'the rescan no longer runs every 3 hours: change the texts with it');
});

// review: For managers said "Start the free pilot, Subscribe and Manage billing open Stripe's own pages for the card
// and the invoices". Start the free pilot calls the database's start_pilot() and opens no page; only Subscribe and
// Manage billing go to Stripe (manager/manager.js), and the manager view says no card is asked for (manager/data.js).
test('For managers says the free pilot starts with no card, and only Subscribe and Manage billing open Stripe\'s pages', async () => {
  const { BILLING_BUTTONS } = await import('../manager/data.js');
  assert.match(BILLING_BUTTONS.pilot.does, /no card is asked for/, 'the manager view now asks for a card to start the pilot: change For managers with it');
  const manager = read('../manager/manager.js');
  const pilot = manager.slice(manager.indexOf("if (kind === 'pilot')"), manager.indexOf("const route = kind === 'portal'"));
  assert.match(pilot, /rpc\('start_pilot'/, 'Start the free pilot calls start_pilot()');
  assert.doesNotMatch(pilot, /location\.assign|billing\/checkout|callFunction/, 'Start the free pilot now opens a page: change For managers with it');
  const page = stripTags(read('../site/for-managers/index.html'));
  assert.doesNotMatch(page, /Start the free pilot\s*,\s*Subscribe and Manage billing open Stripe/i, 'For managers says Start the free pilot opens Stripe\'s pages');
  assert.match(page, /start the free pilot here, with no card/, 'For managers says the pilot needs no card');
  assert.match(page, /Subscribe and Manage billing open Stripe's own pages for the card and the invoices/);
});

// review: the demo form's fields were drawn with --line (#e2e5e1 on white, #2f3531 on #161917: 1.27:1 and
// 1.41:1) on a fill the same as the page, so the border was the only edge a field had, and it was well under
// the 3:1 WCAG 1.4.11 asks of a control's boundary. Fields now use their own --field-line token; --line still
// draws the decorative rules. This reads site.css in both schemes and measures every field border it sets.
test('the website\'s form fields have an edge with at least 3:1 contrast against the page, light and dark', () => {
  const block = (src) => Object.fromEntries([...src.matchAll(/(--[a-z-]+):\s*(#[0-9a-f]{6})\b/gi)].map((m) => [m[1], m[2].toLowerCase()]));
  const light = block(css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {'))));
  const darkAt = css.indexOf(':root {', css.indexOf('prefers-color-scheme: dark'));
  const dark = { ...light, ...block(css.slice(darkAt, css.indexOf('}', darkAt))) };
  const lum = (hex) => {
    const f = (i) => { const v = parseInt(hex.slice(i, i + 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(1) + 0.7152 * f(3) + 0.0722 * f(5);
  };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  // every rule whose selector names a form field and that sets a border colour (focus states aside: they add the accent)
  const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .map((m) => ({ selector: m[1].trim(), body: m[2] }))
    .filter((r) => /(^|[\s,>+~(])(input|textarea|select)\b/.test(r.selector) && !/:focus/.test(r.selector) && /\bborder(-color)?\s*:/.test(r.body));
  assert.ok(rules.length >= 1, 'site.css styles the form fields\' borders');
  for (const r of rules) {
    const token = (r.body.match(/\bborder(?:-color)?\s*:[^;]*var\((--[a-z-]+)\)/) || [])[1];
    assert.ok(token, `${r.selector}: the border colour is a token`);
    const fill = (r.body.match(/\bbackground(?:-color)?\s*:\s*var\((--[a-z-]+)\)/) || [, '--bg'])[1];
    for (const [scheme, t] of [['light', light], ['dark', dark]]) {
      assert.ok(t[token] && t[fill], `${r.selector}: ${token} and ${fill} are set in the ${scheme} scheme`);
      // the field's fill is the page's own colour here, so its border is its only edge
      if (ratio(t[fill], t['--bg']) >= 3) continue;
      const got = ratio(t[token], t['--bg']);
      assert.ok(got >= 3, `${r.selector}: the ${scheme} field border ${token} ${t[token]} on ${t['--bg']} is ${got.toFixed(2)}:1, under 3:1`);
    }
  }
  // the a11y check measures the same thing on the rendered pages
  const a11y = read('../scripts/a11y.mjs');
  assert.match(a11y, /a form field's edge is below WCAG 3:1/, 'npm run test:a11y checks field borders too');
});

// review: the FAQ's Where is my data? (also sent to search engines as FAQPage data) said only "your name, role
// and listing defaults follow your Chrome sign-in", and the support page listed five fields. profileFrom
// (extension/src/settings.js) puts much more in Chrome's sync storage: the dealership's name and town, its
// stores, price basis, price note and daily cap, the rewrite-service address, the Terms acceptance and the
// website it was saved on. Clear everything for this website leaves it; Forget my synced profile removes it.
// Each part of the profile, in the words the two pages use for it:
const PROFILE_PARTS = {
  origin: /the website it was saved on/,
  salesperson: /\bname\b[^)]*\brole\b[^)]*closing line/,
  dealer: /the dealership's name, town, state and ZIP/,
  myStores: /\bstores\b/,
  basis: /price basis/,
  priceNote: /price note/,
  dailyCap: /daily cap/,
  defaults: /listing defaults/,
  rewrite: /rewrite-service address/,
  legal: /Terms acceptance/,
  savedAt: null, // when it was saved: a timestamp of the profile itself
};
test('the FAQ and the support page name every part of the profile Chrome syncs, and the button that removes it', () => {
  const profile = profileFrom({}, 'https://www.example-dealer.test');
  assert.deepEqual(Object.keys(profile).sort(), Object.keys(PROFILE_PARTS).sort(), 'the synced profile changed: update the FAQ, the support page and PROFILE_PARTS');
  assert.deepEqual(Object.keys(profile.salesperson).sort(), ['closingLine', 'name', 'title'], 'the salesperson part of the profile changed: update the two pages');
  assert.deepEqual(Object.keys(profile.dealer).sort(), ['city', 'name', 'state', 'zip'], 'the dealership part of the profile changed: update the two pages');
  const where = stripTags(faqPage).match(/Where is my data\? (.*?) What about my Facebook password\?/);
  assert.ok(where, 'the FAQ has its Where is my data? answer');
  const support = stripTags(read('../site/support/index.html'));
  const privacy = support.slice(support.indexOf('Privacy requests'), support.indexOf('What support never does'));
  for (const [page, said] of [['the FAQ\'s Where is my data?', where[1]], ['the support page\'s Privacy requests', privacy]]) {
    const list = (said.match(/Your profile \(([^)]*)\)/) || [])[1];
    assert.ok(list, `${page} lists what is in the profile`);
    for (const [key, words] of Object.entries(PROFILE_PARTS)) {
      if (words) assert.match(list, words, `${page}: the profile list leaves out ${key}`);
    }
    assert.match(said, /Chrome's sync storage|its sync storage/, `${page} says where the profile is kept`);
    assert.match(said, /Forget my synced profile/, `${page} names the button that removes it`);
  }
  assert.match(where[1], /Forget my synced profile in Settings removes it from there; Clear everything for this website does not\./, 'the FAQ says which button removes the profile, and that Clear everything for this website does not');
  // the FAQPage data search engines read is the same answer
  const ld = JSON.parse(faqPage.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  const answer = ld['@graph'].find((n) => n['@type'] === 'FAQPage').mainEntity.find((e) => e.name === 'Where is my data?').acceptedAnswer.text;
  assert.match(answer, /Your profile \([^)]*the website it was saved on[^)]*\) also follows your Chrome sign-in/, 'npm run site-pages wrote the FAQPage answer from the page');
});

// review: the store listing and the help named the DealerOn and Dealer.com readers, while the FAQ's Which
// websites work?, How it works' What it needs and the sales sheet named Dealer Inspire and the standard-data
// reader only, so a DealerOn dealer reading the website would conclude theirs was never tried. Each place now
// names every reader in extension/adapters/index.js, and every reader not checked on a real dealership website
// comes with the caveat that it has been tested only on sample websites.
test('the FAQ, How it works and the sales sheet name every website reader, each unchecked one with its caveat', () => {
  const faqText = stripTags(faqPage);
  const places = {
    'the FAQ\'s Which websites work?': (faqText.match(/Which websites work\? (.*?) How do updates arrive\?/) || [])[1],
    'How it works, What it needs': stripTags((howPage.match(/<li>A dealership website[\s\S]*?<\/li>/) || [''])[0]),
    'the sales sheet, What it needs': (read('../marketing/sales-sheet.md').match(/^- A dealership website[^\n]*/m) || [])[0],
  };
  const nameOf = (a) => (a.PLATFORM.id === 'schemaOrg' ? /standard vehicle data/i : new RegExp(a.PLATFORM.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  for (const [place, said] of Object.entries(places)) {
    assert.ok(said, `${place} is still there`);
    for (const a of ADAPTERS) assert.match(said, nameOf(a), `${place} does not name the ${a.PLATFORM.name} reader`);
    if (ADAPTERS.some(isCheckedLive)) assert.match(said, /checked on a live site/, `${place} says which reader has been checked on a live site`);
    if (ADAPTERS.some((a) => !isCheckedLive(a))) assert.match(said, /tested only on sample websites/, `${place} names readers that have not read a real website without saying so`);
    assert.doesNotMatch(said, /on the way/, `${place} promises platforms instead of naming the readers there are`);
  }
});

// review: the home page said "Your dealership sets how many posts a day each salesperson may make", and For
// managers that the cap is 10 "unless your dealership changes it". The only control is each salesperson's own
// Settings field (popup.js, 1 to 100), and nothing in the manager view or the database sets or locks it. The
// pages now say the dealership chooses the number and each salesperson enters it, and For managers says the
// manager view does not lock it. If a dealership-level cap is ever built, this test says to change the copy.
test('the daily cap is described as the code has it: the dealership chooses, each salesperson enters it, nothing locks it', () => {
  const popup = read('../extension/popup.js');
  assert.match(popup, /field\('Posts per day, per salesperson', 'dailyCap', s\.dailyCap, 'type="number" min="1" max="100"'\)/, 'the cap field moved or changed its range: change the copy with it');
  assert.match(popup, /dailyCap: Math\.max\(1, Math\.min\(100, /, 'the saved cap is no longer 1 to 100');
  const managerCode = ['../manager/data.js', '../manager/manager.js'].map(read).join('\n');
  const migrations = readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter((f) => f.endsWith('.sql')).map((f) => read(`../supabase/migrations/${f}`)).join('\n');
  assert.doesNotMatch(managerCode + migrations, /daily_?cap/i, 'a dealership-level cap now exists: the home page and For managers can say the dealership sets it');
  const home = stripTags(html);
  const managers = stripTags(read('../site/for-managers/index.html'));
  for (const [name, page] of [['the home page', home], ['For managers', managers]]) {
    assert.doesNotMatch(page, /dealership (sets|changes)|cap you set\b/i, `${name} says the dealership sets the cap, but each salesperson enters it`);
  }
  assert.match(home, /Your dealership chooses how many posts a day each salesperson may make, and each salesperson enters that number in their own Settings\./);
  assert.match(managers, new RegExp(`posts a day, ${DEFAULT_DAILY_CAP} unless changed\\. Your dealership chooses the number, and each salesperson enters it in their own extension's Settings \\(Safety, Posts per day, per salesperson\\), up to 100; the manager view does not set or lock it\\.`));
});
