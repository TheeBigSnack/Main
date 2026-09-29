// The landing page (site/) is customer-facing copy, so it passes the same
// honesty checks as marketing/ (test/marketing.test.js; the regex lists are
// copied here, not imported, so each file stays self-contained), quotes the one
// pricing config, names no dealer, loads nothing from anywhere else, and shows
// only the sandbox's screenshots (site/screenshots/, drawn by npm run screenshots).
// Its footer links the legal pages (site/legal/, test/legalPages.test.js), and
// its Start a free pilot links show only once config.js names the manager view.

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

// copied from test/marketing.test.js: what no document may say
const NEVER = [/approved by (meta|facebook)/i, /(meta|facebook) partner/i, /partner(ed|ship) with (meta|facebook)/i, /official(ly)? (meta|facebook)/i, /compliant with (meta|facebook)/i, /(customers|dealers|salespeople) (say|love|report)/i, /\b(five|5) stars?\b/i, /\d+\s*(%|percent|x|times) (faster|more|fewer)/i, /hours? (a|per) (day|week)/i, /industry[- ]leading/i, /best[- ]in[- ]class/i, /\b#1\b/];
// and what customer-facing copy may not say either
const NOT_TO_CUSTOMERS = [/testimonial/i, /never (be|get) restricted/i, /your account is (safe|protected)/i, /\brisk[- ]free\b/i, /\bno risk\b/i, /\bbots?\b/i];
function assertHonest(said, where) {
  const rest = said.replace(/(not|no|isn't|not be|without|never|can't|cannot|won't|doesn't|don't|no one can|no tool can)[a-z' ]{0,20}guarantee[ds]?/gi, '').replace(/a guarantee\b/gi, '');
  assert.doesNotMatch(rest, /\bguarantee[ds]?\b/i, `${where} makes a guarantee`);
  for (const re of [...NEVER, ...NOT_TO_CUSTOMERS]) assert.doesNotMatch(said, re, `${where} matches ${re}`);
}

test('no claim we have not measured, and nothing that sounds like Meta approval', () => {
  assertHonest(text, 'the page');
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
  // the fifth image is the popup's numbers tab, named as the popup labels it (Numbers since 0.5.0)
  const popup = read('../extension/popup.js');
  const label = popup.match(/\['pilot', '([^']+)'\]/)[1];
  assert.match(figures[4], new RegExp(`alt="The popup's ${label} tab`), `the fifth image's alt text names the ${label} tab`);
});

// The page's Content-Security-Policy, the one place an outside host is named.
const CSP_TAG = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/;

test('every link is an anchor on the page or one of the legal pages, and nothing loads from a third party', () => {
  const legal = ['legal/terms.html', 'legal/privacy.html', 'legal/posting-rules.html'];
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length > 5);
  for (const href of hrefs) {
    assert.ok(/^#[\w-]+$/.test(href) || legal.includes(href) || href === 'site.css', `href ${href}`);
    if (href.startsWith('#')) assert.match(html, new RegExp(`id="${href.slice(1)}"`), `${href} is on the page`);
  }
  // the footer links the three pages npm run legal-pages writes, by relative address
  const footer = html.match(/<footer>[\s\S]*?<\/footer>/)[0];
  assert.deepEqual([...footer.matchAll(/href="([^"]*)"/g)].map((m) => m[1]), legal);
  for (const p of legal) assert.ok(existsSync(new URL('../site/' + p, import.meta.url)), `site/${p} exists (npm run legal-pages)`);
  assert.doesNotMatch(html.replace(CSP_TAG, ''), /https?:\/\//i, 'no absolute URLs in the page');
  assert.doesNotMatch(css, /https?:\/\/|@import|url\(/i, 'no external assets in the stylesheet');
  assert.doesNotMatch(js, /https?:\/\//i, 'site.js names no address of its own');
  const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
  assert.deepEqual(scripts, [' type="module" src="site.js"'], 'one script, the page module');
  const links = [...html.matchAll(/<link\b([^>]*)>/g)].map((m) => m[1]);
  assert.deepEqual(links, [' rel="stylesheet" href="site.css"'], 'one stylesheet, ours');
  assert.doesNotMatch(html, /<(iframe|embed|object)\b/i);
  assert.doesNotMatch(html, /font-face|fonts\./i);
});

test('the page runs under a Content-Security-Policy: its own files, the lead function, and the mailto form', async () => {
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
    'form-action': ['mailto:'],
  });
  // nothing inline, which the policy would block: no inline script, style or handler
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>|<style\b|\sstyle="|\son[a-z]+="/i);
  // the form's action and the configured endpoint are allowed by it
  const { SITE } = await import('../site/config.js');
  assert.match(SITE.demoMailto, /^mailto:/, 'form-action allows the mailto form');
  if (SITE.demoEndpoint) assert.match(new URL(SITE.demoEndpoint).hostname, /\.supabase\.co$/, 'connect-src allows demoEndpoint; change both together');
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

// site.js run against a stand-in page: the two Start a free pilot links, and pricing.json as the server
// answers it (or not). Answers the links as site.js left them.
let runs = 0;
async function runSite({ signupUrl, pricing }) {
  const configImport = "import { SITE } from './config.js';";
  assert.ok(js.includes(configImport), 'site.js takes its addresses from config.js');
  runs += 1;
  const config = { demoEndpoint: '', demoMailto: 'mailto:demo@lotsync.example', signupUrl };
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
  const tags = [...html.matchAll(/<a\b[^>]*\bdata-signup\b[^>]*>([^<]*)<\/a>/g)];
  assert.equal(tags.length, 2, 'two links, no more');
  for (const [tag, label] of tags) {
    assert.match(tag, /\shidden>/, 'hidden until site.js shows it');
    assert.doesNotMatch(tag, /href=/, 'no address until config.js gives one');
    assert.doesNotMatch(label, /\d/, 'no number written into the page');
  }
  assert.match(css, /\[hidden\] \{ display: none !important; \}/, 'the hidden attribute beats .button\'s display');

  // signupUrl empty: nothing changes, whatever pricing.json says
  for (const link of await runSite({ signupUrl: '', pricing })) assert.deepEqual(link, { hidden: true, href: '', textContent: 'Start a free pilot' });
  // set: both links shown, to that address, with the pilot's length from pricing.json
  const url = 'https://app.lotsync.example/manager/';
  for (const link of await runSite({ signupUrl: url, pricing })) {
    assert.deepEqual(link, { hidden: false, href: url, textContent: `Start a free ${pricing.pilotDays}-day pilot` });
  }
  for (const link of await runSite({ signupUrl: url, pricing: { ...pricing, pilotDays: 14 } })) assert.equal(link.textContent, 'Start a free 14-day pilot', 'the length is read, not written in');
  // pricing.json unreadable: shown, with no length rather than a guessed one
  for (const link of await runSite({ signupUrl: url, pricing: null })) assert.deepEqual(link, { hidden: false, href: url, textContent: 'Start a free pilot' });
  // a path on this site works too; anything that is not https or a path shows nothing
  for (const ok of ['../manager/', '/manager/index.html', './manager/']) assert.equal((await runSite({ signupUrl: ok, pricing }))[0].href, ok, ok);
  for (const bad of ['javascript:alert(1)', 'http://app.lotsync.example/', 'app.lotsync.example/manager/', '//app.lotsync.example/', 'https://', ' ', 'https://app.lotsync.example/ x']) {
    for (const link of await runSite({ signupUrl: bad, pricing })) assert.equal(link.hidden, true, `${JSON.stringify(bad)} shows nothing`);
  }

  // the page's honesty rules hold with the links shown
  assertHonest(text.replaceAll('Start a free pilot', `Start a free ${pricing.pilotDays}-day pilot`), 'the page with sign-up open');
  assert.doesNotMatch(js, /https?:\/\//i, 'site.js still names no address of its own');
});
