// The pure parts of the site survey (scripts/survey.mjs): reading one page's
// anatomy from its HTML, the platform fingerprint, robots.txt, the JSON
// endpoints a page calls, bot-check signs, the verdict and the two reports.
// Nothing here fetches, opens a browser or writes a file, so test/survey.test.js
// runs it on small HTML strings.
//
// The platform markers below are starting points, not findings: none has been
// checked against a real Dealer.com, DealerOn, DealerFire, Dealer eProcess,
// Sincro, Team Velocity or Carsforsale website from this repository. The survey
// reports the exact evidence it matched, so a person can judge, and says
// "unknown" when nothing matched instead of guessing.

import { extractJsonLd, vehicleNodes, pageFacts } from '../extension/adapters/schemaOrgParse.js';
import { vinInAddress, looksLikeCarAddress } from '../extension/adapters/schemaOrg.js';
import { vinCheckDigit } from '../extension/src/vin.js';

export const DEFAULTS = Object.freeze({
  out: 'survey-out',
  maxCarPages: 5,
  // car pages the Lot Current scan may read in the survey's copy of the extension
  // (as shipped: MAX_CAR_PAGES = 600), so one survey stays a handful of requests
  scanCarPages: 10,
  scanListPages: 5,
  scanSitemaps: 2,
  scanTimeoutSec: 240,
  pauseMs: 2000,
});
// The survey never reads more car pages than this, whatever --max-car-pages says.
export const MAX_CAR_PAGES_LIMIT = 10;
export const EXCERPT_LIMIT = 4096;

// ---------- command line ----------

export const USAGE = `Usage: npm run survey -- <used-inventory URL> [<URL> ...] [options]

Options:
  --out <dir>             where the reports go (default ${DEFAULTS.out}/)
  --max-car-pages <n>     car pages the survey opens per site, 0 to ${MAX_CAR_PAGES_LIMIT} (default ${DEFAULTS.maxCarPages})
  --scan-car-pages <n>    car pages Lot Current's own scan may read per site, 1 to 50 (default ${DEFAULTS.scanCarPages})
  --scan-timeout <sec>    how long to wait for Lot Current's scan (default ${DEFAULTS.scanTimeoutSec})
  --headed                show the browser window
  --help                  this text`;

/**
 * The survey's arguments. Throws an Error with a readable message on a bad one.
 * @param {string[]} argv  process.argv.slice(2)
 */
export function parseArgs(argv) {
  const opts = { urls: [], out: DEFAULTS.out, maxCarPages: DEFAULTS.maxCarPages, scanCarPages: DEFAULTS.scanCarPages, scanTimeoutSec: DEFAULTS.scanTimeoutSec, headed: false, help: false };
  const whole = (value, name, min, max) => {
    const n = Number(value);
    if (value === undefined || value === '' || !Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max}, got "${value ?? ''}"`);
    return n;
  };
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i += 1) {
    const raw = String(list[i]);
    const eq = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const flag = eq > 0 ? raw.slice(0, eq) : raw;
    const value = () => (eq > 0 ? raw.slice(eq + 1) : list[++i]);
    if (flag === '--help' || flag === '-h') opts.help = true;
    else if (flag === '--headed') opts.headed = true;
    else if (flag === '--out') {
      const v = value();
      if (!v || String(v).startsWith('--')) throw new Error('--out needs a folder');
      opts.out = String(v);
    } else if (flag === '--max-car-pages') opts.maxCarPages = whole(value(), '--max-car-pages', 0, MAX_CAR_PAGES_LIMIT);
    else if (flag === '--scan-car-pages') opts.scanCarPages = whole(value(), '--scan-car-pages', 1, 50);
    else if (flag === '--scan-timeout') opts.scanTimeoutSec = whole(value(), '--scan-timeout', 10, 1800);
    else if (flag.startsWith('-')) throw new Error(`unknown option "${flag}"`);
    else {
      let u;
      try {
        u = new URL(raw);
      } catch (e) {
        throw new Error(`"${raw}" is not a web address (start it with https://)`);
      }
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`"${raw}" is not an http or https address`);
      if (/(^|\.)(facebook\.com|fb\.com|messenger\.com)$/i.test(u.hostname)) throw new Error('the survey reads dealer websites, never Facebook');
      opts.urls.push(u.href);
    }
  }
  if (!opts.help && !opts.urls.length) throw new Error('give at least one used-inventory address');
  return opts;
}

/** A folder name for a site: its host, with the port when there is one. */
export function hostDir(url) {
  const u = new URL(url);
  return (u.hostname + (u.port ? '_' + u.port : '')).toLowerCase().replace(/[^a-z0-9._-]/g, '_');
}

// ---------- robots.txt ----------

/**
 * The rules robots.txt gives every robot (the `User-agent: *` groups), its
 * Crawl-delay for them and the sitemaps it names. A missing file means no rules.
 * @param {string} text
 * @returns {{ rules: {allow: boolean, path: string}[], crawlDelaySec: number|null, sitemaps: string[] }}
 */
export function parseRobots(text) {
  const rules = [];
  const sitemaps = [];
  let crawlDelaySec = null;
  let agents = [];
  let inRules = false;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'sitemap') {
      if (val) sitemaps.push(val);
      continue;
    }
    if (key === 'user-agent') {
      if (inRules) { agents = []; inRules = false; }
      agents.push(val.toLowerCase());
      continue;
    }
    inRules = true;
    if (!agents.includes('*')) continue;
    if (key === 'allow' || key === 'disallow') {
      if (val) rules.push({ allow: key === 'allow', path: val });
    } else if (key === 'crawl-delay') {
      const n = Number(val);
      if (Number.isFinite(n) && n >= 0) crawlDelaySec = n;
    }
  }
  return { rules, crawlDelaySec, sitemaps };
}

function ruleMatches(rulePath, path) {
  const anchored = rulePath.endsWith('$');
  const body = anchored ? rulePath.slice(0, -1) : rulePath;
  const re = new RegExp('^' + body.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (anchored ? '$' : ''));
  return re.test(path);
}

/**
 * Whether robots.txt lets every robot read an address: the longest matching
 * rule wins, Allow wins a tie, no matching rule means allowed.
 * @returns {{ allowed: boolean, rule: string|null }}
 */
export function robotsAllows(robots, href) {
  let path;
  try {
    const u = new URL(href);
    path = u.pathname + u.search;
  } catch (e) {
    path = String(href || '/');
  }
  let best = null;
  for (const r of (robots && robots.rules) || []) {
    if (!ruleMatches(r.path, path)) continue;
    const len = r.path.replace(/\*/g, '').length;
    if (!best || len > best.len || (len === best.len && r.allow && !best.allow)) best = { ...r, len };
  }
  return { allowed: !best || best.allow, rule: best ? `${best.allow ? 'Allow' : 'Disallow'}: ${best.path}` : null };
}

/**
 * What a robots.txt answer means for the survey: 404 or 410 is no rules; a
 * 401, 403, 429 or 5xx means the rules can't be known (or the website is
 * turning the survey away), so the site is not surveyed.
 */
export function robotsVerdict(status) {
  if (status >= 200 && status < 300) return 'rules';
  if (status === 404 || status === 410) return 'none';
  if (status === 401 || status === 403 || status === 429 || status >= 500) return 'stop';
  return 'none';
}

// ---------- small HTML readers (string-level; a survey, not a browser) ----------

const ATTR = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

/** The attributes of every <name ...> start tag, lower-cased keys. */
export function tagsOf(html, name) {
  const out = [];
  const re = new RegExp('<' + name + '\\b([^>]*)>', 'gi');
  for (const m of String(html || '').matchAll(re)) {
    const attrs = {};
    for (const a of m[1].matchAll(ATTR)) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? '';
    out.push(attrs);
  }
  return out;
}

const hostOf = (href, base) => {
  try {
    const u = new URL(href, base);
    return /^https?:$/.test(u.protocol) ? u.hostname.toLowerCase() : '';
  } catch (e) {
    return '';
  }
};

const countBy = (items) => {
  const out = {};
  for (const x of items) if (x) out[x] = (out[x] || 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
};

export function metaGenerator(html) {
  const tag = tagsOf(html, 'meta').find((a) => String(a.name || '').toLowerCase() === 'generator');
  return tag ? String(tag.content || '').trim() || null : null;
}

/** The hosts of the page's scripts, stylesheets and other linked assets. */
export function assetHosts(html, pageUrl) {
  const scripts = tagsOf(html, 'script').map((a) => a.src).filter(Boolean).map((s) => hostOf(s, pageUrl));
  const links = tagsOf(html, 'link').map((a) => a.href).filter(Boolean).map((s) => hostOf(s, pageUrl));
  return { scriptHosts: [...new Set(scripts.filter(Boolean))].sort(), linkHosts: [...new Set(links.filter(Boolean))].sort() };
}

/** Distinct 17-character strings shaped like a VIN whose check digit is right. */
export function findVins(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/(?:^|[^A-Za-z0-9])([A-HJ-NPR-Za-hj-npr-z0-9]{17})(?![A-Za-z0-9])/g)) {
    const v = m[1].toUpperCase();
    if (!/[A-Z]/.test(v) || !/[0-9]/.test(v)) continue;
    if (vinCheckDigit(v) === v[8]) out.add(v);
  }
  return [...out];
}

// ---------- schema.org ----------

function typeName(t) {
  return String(t).trim().replace(/\/+$/, '').split(/[/#:]/).pop();
}

function everyType(x, out, depth = 0) {
  if (!x || typeof x !== 'object' || depth > 12) return;
  if (Array.isArray(x)) {
    for (const y of x) everyType(y, out, depth + 1);
    return;
  }
  for (const t of [].concat(x['@type'] || [])) if (typeof t === 'string' && t.trim()) out.add(typeName(t));
  for (const v of Object.values(x)) if (v && typeof v === 'object') everyType(v, out, depth + 1);
}

const has = (v) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length);
const offersOf = (node) => [].concat(node.offers || []).filter((o) => o && typeof o === 'object');
const offerHas = (node, key) => offersOf(node).some((o) => has(o[key]) || (o.priceSpecification && has([].concat(o.priceSpecification)[0]?.[key])));

/**
 * The JSON-LD blocks on a page and what their vehicle nodes carry.
 * @returns {{ blocks: number, types: string[], vehicles: number, withVin: number, withPrice: number, withCurrency: number, withMileage: number, withImage: number, vins: string[] }}
 */
export function jsonLdSummary(html) {
  const blocks = extractJsonLd(html);
  const types = new Set();
  everyType(blocks, types);
  const nodes = vehicleNodes(blocks);
  const vinOf = (n) => String([].concat(n.vehicleIdentificationNumber || '')[0] || '').replace(/\s+/g, '').toUpperCase();
  return {
    blocks: blocks.length,
    types: [...types].sort(),
    vehicles: nodes.length,
    withVin: nodes.filter((n) => vinOf(n)).length,
    withPrice: nodes.filter((n) => offerHas(n, 'price') || offerHas(n, 'lowPrice')).length,
    withCurrency: nodes.filter((n) => offerHas(n, 'priceCurrency')).length,
    withMileage: nodes.filter((n) => has(n.mileageFromOdometer)).length,
    withImage: nodes.filter((n) => has(n.image)).length,
    vins: [...new Set(nodes.map(vinOf).filter(Boolean))],
  };
}

/**
 * One JSON-LD block of a page as text, cut at EXCERPT_LIMIT characters: the
 * first block that holds a vehicle, else the first block. Null without any.
 */
export function jsonLdExcerpt(html, limit = EXCERPT_LIMIT) {
  const raws = [...String(html || '').matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1].trim()).filter(Boolean);
  if (!raws.length) return null;
  const withVehicle = raws.find((raw) => {
    try {
      return vehicleNodes([JSON.parse(raw)]).length > 0;
    } catch (e) {
      return false;
    }
  });
  const text = withVehicle || raws[0];
  return text.length > limit ? text.slice(0, limit) + ' [cut at ' + limit + ' characters]' : text;
}

/** Microdata item types on a page (short names, "Car" for https://schema.org/Car), with counts. */
export function microdataTypes(html) {
  const types = [];
  for (const a of [...tagsOf(html, '[a-z][a-z0-9-]*')]) {
    if (a.itemtype) for (const t of String(a.itemtype).split(/\s+/).filter(Boolean)) types.push(typeName(t));
  }
  return countBy(types);
}

// ---------- links, pagination ----------

/** The same-website links on a page that look like a car's own page (a VIN in the address, or a model year under an inventory word). */
export function carLinks(html, pageUrl) {
  const facts = pageFacts(html, pageUrl);
  const here = new URL(pageUrl);
  here.hash = '';
  return facts.links.filter((href) => href !== here.href && (vinInAddress(href) || looksLikeCarAddress(href)));
}

/**
 * Up to max car pages to open: addresses with a VIN first, one per car,
 * in page order, only those robots.txt allows.
 * @returns {{ picked: string[], disallowed: {url: string, rule: string}[] }}
 */
export function pickCarPages(links, max, robots = null) {
  const seen = new Set();
  const withVin = [];
  const without = [];
  const disallowed = [];
  for (const href of links || []) {
    const key = vinInAddress(href) || href.replace(/[?#].*$/, '').replace(/\/+$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    const r = robots ? robotsAllows(robots, href) : { allowed: true };
    if (!r.allowed) {
      disallowed.push({ url: href, rule: r.rule });
      continue;
    }
    (vinInAddress(href) ? withVin : without).push(href);
  }
  return { picked: [...withVin, ...without].slice(0, Math.max(0, max)), disallowed };
}

const PAGE_PARAMS = ['page', 'pg', 'pn', 'p', 'pt', 'start', 'offset', 'from', 'skip', 'pagenum', 'pagenumber', 'currentpage'];

/** How the list pages itself: rel=next, page-number query parameters, /page/2/ paths. */
export function paginationShape(html, pageUrl) {
  const facts = pageFacts(html, pageUrl);
  const params = new Set();
  const examples = [];
  let pathPages = false;
  const here = new URL(pageUrl);
  for (const href of facts.links) {
    let u;
    try {
      u = new URL(href);
    } catch (e) {
      continue;
    }
    let hit = false;
    for (const [k, v] of u.searchParams) {
      if (PAGE_PARAMS.includes(k.toLowerCase()) && /^\d{1,5}$/.test(v)) {
        params.add(k);
        hit = true;
      }
    }
    if (/\/page\/\d+\/?$/i.test(u.pathname)) {
      pathPages = true;
      hit = true;
    }
    if (hit && u.pathname.replace(/\/page\/\d+\/?$/i, '/').replace(/\/+$/, '') === here.pathname.replace(/\/+$/, '') && examples.length < 3) examples.push(href);
  }
  const shapes = [];
  if (facts.next) shapes.push('rel=next');
  for (const p of params) shapes.push(`?${p}=`);
  if (pathPages) shapes.push('/page/N/');
  return { relNext: facts.next, shapes, examples };
}

/**
 * One page's anatomy from its HTML: what a read without scripts (the server
 * HTML) or the browser (the rendered DOM) sees. Counts only, no content.
 */
export function pageAnatomy(html, pageUrl, status = null) {
  const text = String(html || '');
  const j = jsonLdSummary(text);
  delete j.vins;
  return { status, bytes: text.length, title: pageFacts(text, pageUrl).title, carLinks: new Set(carLinks(text, pageUrl)).size, vins: findVins(text).length, jsonLd: j, microdata: microdataTypes(text) };
}

/** Photo addresses grouped by host, with counts (the addresses themselves are not kept). */
export function photoHosts(urls) {
  return countBy((urls || []).map((u) => hostOf(u)));
}

// ---------- the JSON a page calls ----------

/** An address with its query values blanked, so a pattern is kept without anyone's search. */
export function urlPattern(href) {
  try {
    const u = new URL(href);
    const keys = [...new Set([...u.searchParams.keys()])];
    return u.origin + u.pathname + (keys.length ? '?' + keys.map((k) => k + '=…').join('&') : '');
  } catch (e) {
    return String(href || '').slice(0, 200);
  }
}

/**
 * One JSON answer a page's own scripts asked for, kept only when it holds
 * VIN-like strings: the address pattern, the top-level keys and the count.
 * The body itself is never kept.
 */
export function jsonEndpoint({ url, method = 'GET', status = 0, contentType = '', body = '' }) {
  if (!/json/i.test(contentType) && !/^\s*[[{]/.test(String(body || ''))) return null;
  let data;
  try {
    data = JSON.parse(body);
  } catch (e) {
    return null;
  }
  const vins = findVins(body);
  if (!vins.length) return null;
  let topKeys;
  if (Array.isArray(data)) {
    const first = data.find((x) => x && typeof x === 'object' && !Array.isArray(x));
    topKeys = [`[array of ${data.length}]`, ...(first ? Object.keys(first).slice(0, 30).map((k) => '[].' + k) : [])];
  } else if (data && typeof data === 'object') {
    topKeys = Object.keys(data).slice(0, 30);
  } else {
    topKeys = [];
  }
  return { method, pattern: urlPattern(url), status, topKeys, vinCount: vins.length };
}

// ---------- refusals and bot checks ----------

const CHALLENGE = [
  ['Cloudflare challenge', /just a moment\.\.\.|cf-chl|challenge-platform|cf_chl_|checking your browser before accessing|attention required! \| cloudflare/i],
  ['Akamai block', /access denied[\s\S]{0,200}reference #|errors\.edgesuite\.net/i],
  ['Incapsula / Imperva', /_incapsula_resource|incapsula incident id/i],
  ['PerimeterX / HUMAN', /px-captcha|perimeterx|press (?:&amp; |& )?hold/i],
  ['DataDome', /captcha-delivery\.com|datadome/i],
  ['captcha wording', /captcha|are you (?:a )?(?:human|robot)|verify (?:that )?you are (?:a )?human|unusual traffic/i],
];

/**
 * Whether an answer turned the survey away: a 403, 429 or 503, or a
 * challenge page. CDN headers on an ordinary page are noted, not a refusal.
 * @returns {{ refused: boolean, reason: string|null, signs: string[] }}
 */
export function botSigns({ status = 200, headers = {}, html = '' } = {}) {
  const h = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const signs = [];
  if (h['cf-ray'] || /cloudflare/i.test(h.server || '')) signs.push('served through Cloudflare (cf-ray header)');
  if (/akamai/i.test(h.server || '') || h['x-akamai-transformed'] || h['akamai-grn']) signs.push('served through Akamai');
  if (h['x-iinfo'] || /incap_ses|visid_incap/i.test(h['set-cookie'] || '')) signs.push('served through Imperva/Incapsula');
  if (h['x-datadome'] || /datadome/i.test(h['set-cookie'] || '')) signs.push('DataDome cookie or header');
  const text = String(html || '');
  // a challenge page is short and has no vehicles; a long inventory page that
  // happens to name a captcha library is not one
  const small = text.length < 60000;
  let challenge = null;
  if (small) {
    for (const [name, re] of CHALLENGE) {
      const m = re.exec(text);
      if (m) {
        challenge = `${name} ("${m[0].slice(0, 60)}")`;
        break;
      }
    }
  }
  if (challenge) signs.push(challenge);
  let reason = null;
  if (status === 403 || status === 429 || status === 503) reason = `HTTP ${status}${challenge ? ', ' + challenge : ''}`;
  else if (challenge && !findVins(text).length) reason = challenge;
  return { refused: Boolean(reason), reason, signs };
}

// ---------- platform fingerprint ----------

// Starting points, not findings (see the top of this file). kind: host (a
// request or asset host), global (a name on window), text (in the page's
// HTML), generator (meta generator), path (the list's address shape; a hint
// only, never enough on its own).
export const PLATFORM_MARKERS = Object.freeze([
  { platform: 'Dealer Inspire', kind: 'global', re: /^(SEARCH_SERVICE|IDPSearchServiceHelper)$/ },
  { platform: 'Dealer Inspire', kind: 'host', re: /(^|\.)(dealerinspire\.com|carscommerce\.inc)$/ },
  { platform: 'Dealer Inspire', kind: 'text', re: /dealer ?inspire/i },
  { platform: 'Dealer.com', kind: 'host', re: /(^|\.)dealer\.com$/ },
  { platform: 'Dealer.com', kind: 'global', re: /^DDC$/ },
  { platform: 'Dealer.com', kind: 'text', re: /\bDDC\.[A-Za-z]+|static\.dealer\.com|pictures\.dealer\.com/ },
  { platform: 'Dealer.com', kind: 'path', re: /\/(?:used|new|all|certified)-inventory\/index\.htm/i },
  { platform: 'DealerOn', kind: 'host', re: /(^|\.)dealeron\.com$/ },
  { platform: 'DealerOn', kind: 'text', re: /dealeron/i },
  { platform: 'DealerOn', kind: 'path', re: /\/search(?:used|new|certified)\.aspx/i },
  { platform: 'DealerFire', kind: 'host', re: /(^|\.)dealerfire\.com$/ },
  { platform: 'DealerFire', kind: 'text', re: /dealerfire/i },
  { platform: 'Dealer eProcess', kind: 'host', re: /(^|\.)dealereprocess\.(?:com|org|net)$/ },
  { platform: 'Dealer eProcess', kind: 'text', re: /dealer ?e-?process/i },
  { platform: 'Sincro (CDK websites)', kind: 'host', re: /(^|\.)(sincrodigital\.com|cdkglobal\.com|cdksites\.com)$/ },
  { platform: 'Sincro (CDK websites)', kind: 'text', re: /sincro ?digital|cdk global/i },
  { platform: 'Team Velocity', kind: 'host', re: /(^|\.)teamvelocity(?:marketing)?\.com$/ },
  { platform: 'Team Velocity', kind: 'text', re: /team ?velocity/i },
  { platform: 'Carsforsale.com', kind: 'host', re: /(^|\.)carsforsale\.com$/ },
  { platform: 'Carsforsale.com', kind: 'text', re: /carsforsale\.com/i },
  { platform: 'DealerSocket', kind: 'host', re: /(^|\.)dealersocket\.com$/ },
  { platform: 'Dealer Spike', kind: 'host', re: /(^|\.)dealerspike\.com$/ },
  { platform: 'DealerCenter', kind: 'host', re: /(^|\.)dealercenter\.net$/ },
  { platform: 'Overfuel', kind: 'host', re: /(^|\.)overfuel\.com$/ },
]);

/** The global names worth checking on window (the survey asks the page whether each exists). */
export const GLOBAL_NAMES = Object.freeze(['SEARCH_SERVICE', 'IDPSearchServiceHelper', 'DDC']);

const WEIGHT = { generator: 3, global: 3, host: 2, text: 1, path: 0 };

/**
 * Which dealer-website platform the evidence points at.
 * @param {{ url: string, html?: string, hosts?: string[], globals?: string[], generator?: string|null }} input
 * @returns {{ platform: string, evidence: {platform: string, kind: string, value: string}[], candidates: {platform: string, score: number}[] }}
 *   platform is "unknown" when no marker matched, or only the address shape did.
 */
export function fingerprint({ url, html = '', hosts = [], globals = [], generator = null }) {
  const evidence = [];
  const add = (platform, kind, value) => {
    if (!evidence.some((e) => e.platform === platform && e.kind === kind && e.value === value)) evidence.push({ platform, kind, value });
  };
  const text = String(html || '');
  for (const mk of PLATFORM_MARKERS) {
    if (mk.kind === 'host') for (const h of hosts) if (mk.re.test(h)) add(mk.platform, 'host', h);
    if (mk.kind === 'global') for (const g of globals) if (mk.re.test(g)) add(mk.platform, 'global', 'window.' + g);
    if (mk.kind === 'text') {
      const m = mk.re.exec(text);
      if (m) add(mk.platform, 'text', text.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30).replace(/\s+/g, ' ').trim());
    }
    if (mk.kind === 'path') {
      try {
        const u = new URL(url);
        if (mk.re.test(u.pathname)) add(mk.platform, 'path', u.pathname);
      } catch (e) { /* no address */ }
    }
  }
  if (generator) {
    for (const mk of PLATFORM_MARKERS.filter((m) => m.kind === 'text')) if (mk.re.test(generator)) add(mk.platform, 'generator', generator);
  }
  const scores = new Map();
  for (const e of evidence) scores.set(e.platform, (scores.get(e.platform) || 0) + WEIGHT[e.kind]);
  const candidates = [...scores.entries()].map(([platform, score]) => ({ platform, score })).sort((a, b) => b.score - a.score || a.platform.localeCompare(b.platform));
  const strong = candidates.filter((c) => c.score > 0);
  let platform = 'unknown';
  if (strong.length === 1) platform = strong[0].platform;
  else if (strong.length > 1) platform = strong[0].score >= 2 * strong[1].score ? strong[0].platform : 'unclear: ' + strong.map((c) => c.platform).join(' or ');
  return { platform, evidence, candidates };
}

// ---------- the survey's copy of the extension ----------

/**
 * The adapter's scan limits, lowered in the survey's own temporary copy of
 * extension/adapters/schemaOrg.js so one survey reads a handful of pages.
 * Throws when a constant is not found, so a rename can't silently turn the cap off.
 */
export function capScanLimits(source, { carPages, listPages, sitemaps }) {
  let out = String(source);
  for (const [name, n] of [['MAX_CAR_PAGES', carPages], ['MAX_LIST_PAGES', listPages], ['MAX_SITEMAPS', sitemaps]]) {
    const re = new RegExp('export const ' + name + ' = \\d+;');
    if (!re.test(out)) throw new Error(`schemaOrg.js has no "export const ${name} = <number>;" to cap`);
    out = out.replace(re, `export const ${name} = ${Number(n)};`);
  }
  return out;
}

/** The host permissions the survey's copy of the extension gets: the surveyed websites (and their www twin) only. */
export function surveyHostPermissions(urls) {
  const out = new Set();
  for (const href of urls) {
    const u = new URL(href);
    const twin = u.hostname.startsWith('www.') ? u.hostname.slice(4) : /^\d+\.\d+\.\d+\.\d+$|^localhost$/.test(u.hostname) ? null : 'www.' + u.hostname;
    // A match pattern without a port covers every port on that host.
    out.add(`${u.protocol}//${u.hostname}/` + '*');
    if (twin) out.add(`${u.protocol}//${twin}/` + '*');
  }
  return [...out];
}

// ---------- what Lot Current read ----------

/**
 * Lot Current's reading of the site from the extension's own storage after the
 * popup's scan: the snapshot's cars, the to-do warnings, the registry entry.
 * The service is summarised (its keys and list address, never an API key).
 */
export function lotSyncReading({ snapshot = null, diff = null, site = null, statusText = '', metaText = '', warningsShown = [] }) {
  const cars = Object.values((snapshot && snapshot.vehicles) || {});
  const decisions = countBy(cars.map((c) => c.decision));
  const service = site && site.service && typeof site.service === 'object' ? site.service : null;
  return {
    adapter: (site && site.adapter) || (snapshot && snapshot.site && snapshot.site.adapter) || null,
    service: service ? { keys: Object.keys(service).sort(), listUrl: typeof service.listUrl === 'string' ? service.listUrl : undefined, searchHost: typeof service.search === 'string' ? hostOf(service.search) : undefined } : null,
    carCount: cars.length,
    withVin: cars.filter((c) => c.vin).length,
    withPrice: cars.filter((c) => typeof c.price === 'number' && c.price > 0).length,
    withMileage: cars.filter((c) => typeof c.mileage === 'number').length,
    withPhotos: cars.filter((c) => Number(c.photoCount) > 0).length,
    decisions,
    warnings: [...new Set([...(diff && Array.isArray(diff.warnings) ? diff.warnings : []), ...warningsShown])],
    requests: diff && Number.isFinite(diff.requests) ? diff.requests : null,
    complete: snapshot ? Boolean(snapshot.complete) : null,
    photoOrigins: (site && site.photoOrigins) || [],
    statusText: statusText || '',
    metaText: metaText || '',
    firstCars: cars.slice(0, 3).map((c) => ({ vin: c.vin, name: c.name, price: c.price, mileage: c.mileage, photoCount: c.photoCount, type: c.type, location: c.location, url: c.url, decision: c.decision, reason: c.reason, blockers: c.blockers })),
  };
}

// A reading problem, not the website's own gap: a car with no price, mileage
// or photos may simply have none on the website ("call for price", a new
// arrival not yet photographed), so it is a gap only when more than half of
// the lot lacks it, and a note otherwise. The same floor on any lot size.
const mostOf = (missing, total) => missing * 2 > total;
// Car links on the list that the scan did not turn into cars: more than a
// tenth of them, and at least one on a lot of under ten.
const tooMany = (missing, total) => missing > Math.floor(total * 0.1);

/**
 * The gaps between what the website offers and what Lot Current read, and the
 * one-line verdict: "reads it", "partly", "doesn't read it", or "not
 * surveyed" when the survey stopped before Lot Current's scan could run.
 */
export function verdictFor(report) {
  const gaps = [];
  const notes = [];
  const r = report || {};
  const list = r.list || {};
  const ls = r.lotSync || {};
  if (r.stopped) return { verdict: 'not surveyed', why: r.stopped.reason, gaps, notes };
  if (!ls.attempted) return { verdict: 'not surveyed', why: ls.skippedReason || "Lot Current's scan did not run", gaps, notes };
  const scriptsOnly = Boolean(list.server && list.rendered && list.rendered.carLinks > 0 && list.server.carLinks === 0);
  if (!ls.ok) {
    const failed = [ls.message || 'the scan failed'];
    if (scriptsOnly) failed.push("the list's car links appear only after scripts run, and Lot Current reads the list without scripts");
    return { verdict: "doesn't read it", why: ls.message || "Lot Current's scan failed", gaps: failed, notes };
  }
  const n = ls.carCount || 0;
  if (!n) return { verdict: "doesn't read it", why: 'the scan ran but found no used cars', gaps: ['no cars read'], notes };

  const linksOnList = list.rendered ? list.rendered.carLinks : 0;
  if (linksOnList && n < linksOnList && tooMany(linksOnList - n, linksOnList)) gaps.push(`read ${n} cars, but the list's first page alone links to ${linksOnList} car pages`);
  for (const [key, what] of [['withPrice', 'price'], ['withMileage', 'mileage'], ['withPhotos', 'photos']]) {
    const missing = n - (ls[key] || 0);
    if (missing > 0 && mostOf(missing, n)) gaps.push(`${missing} of ${n} cars have no ${what} in what Lot Current read`);
    else if (missing > 0) notes.push(`${missing} of ${n} cars have no ${what} in what Lot Current read (the website may show none for them; compare a car page)`);
  }
  for (const w of ls.warnings || []) {
    if (/more car pages than one scan reads/i.test(w)) notes.push("the survey's own cap on car pages left some for a later scan (not a gap in Lot Current)");
    else gaps.push('warning: ' + w);
  }
  if (ls.adapter === 'schemaOrg' && scriptsOnly) {
    gaps.push("the list's car links appear only after scripts run, and Lot Current reads the list without scripts");
  }
  if (ls.adapter === 'schemaOrg' && r.carPagesSummary && r.carPagesSummary.read > 0 && r.carPagesSummary.withVehicleJsonLd === 0 && r.carPagesSummary.withVehicleMicrodata === 0) {
    gaps.push('the car pages carry no schema.org vehicle markup');
  }
  const name = ls.adapterName || ls.adapter || 'an adapter';
  if (!gaps.length) return { verdict: 'reads it', why: `${name} read ${n} cars; ${ls.withPrice} with a price, ${ls.withMileage} with mileage, ${ls.withPhotos} with photos`, gaps, notes };
  return { verdict: 'partly', why: `${name} read ${n} cars, but ${gaps[0]}`, gaps, notes };
}

// ---------- the reports ----------

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const yes = (b) => (b ? 'yes' : 'no');

function anatomyLines(label, a) {
  if (!a) return [`- ${label}: not read`];
  return [
    `- ${label}: HTTP ${a.status ?? '?'}, ${a.carLinks} car links, ${a.vins} VIN-like strings, ${a.jsonLd.blocks} JSON-LD blocks (${a.jsonLd.vehicles} vehicle nodes), microdata: ${Object.keys(a.microdata || {}).length ? Object.entries(a.microdata).map(([t, c]) => `${t} ×${c}`).join(', ') : 'none'}`,
  ];
}

/** The readable per-site report. */
export function renderReportMd(r) {
  const L = [];
  const list = r.list || {};
  const v = r.verdict || {};
  L.push(`# Site survey: ${r.host}`, '');
  L.push(`Surveyed ${r.surveyedAt} from ${r.input}. Tool: \`npm run survey\` (Lot Current ${r.lotSyncVersion}).`, '');
  L.push(`**Verdict: ${v.verdict}.** ${v.why || ''}`, '');
  if (r.stopped) L.push(`**Stopped:** ${r.stopped.reason} (at ${r.stopped.at}). Nothing was retried.`, '');

  L.push('## Platform', '');
  const fp = list.platform || { platform: 'unknown', evidence: [] };
  L.push(`**${fp.platform}**${fp.platform === 'unknown' ? ' (no known marker matched; not guessed)' : ''}`, '');
  if (list.generator) L.push(`- meta generator: \`${esc(list.generator)}\``);
  for (const e of fp.evidence || []) L.push(`- ${e.platform}, ${e.kind}: \`${esc(e.value)}\``);
  if (list.scriptHosts && list.scriptHosts.length) L.push(`- script hosts: ${list.scriptHosts.map((h) => '`' + h + '`').join(', ')}`);
  if (list.requestHosts && list.requestHosts.length) L.push(`- every host the list page loaded from: ${list.requestHosts.map((h) => '`' + h + '`').join(', ')}`);
  L.push('');

  L.push('## What the markup offers', '');
  if (list.finalUrl) L.push(`List page: ${list.finalUrl}${list.redirected ? ' (redirected from the address given)' : ''}, "${esc(list.title || '')}"`, '');
  L.push(...anatomyLines('List, server HTML (no scripts, what Lot Current reads)', list.server));
  L.push(...anatomyLines('List, rendered (after scripts)', list.rendered));
  if (list.server && list.rendered) {
    L.push(`- car links only after scripts run: ${yes(list.rendered.carLinks > 0 && list.server.carLinks === 0)}; VINs only after scripts run: ${yes(list.rendered.vins > 0 && list.server.vins === 0)}`);
  }
  if (list.jsonLdTypes && list.jsonLdTypes.length) L.push(`- JSON-LD @type values on the list: ${list.jsonLdTypes.join(', ')}`);
  const pg = list.pagination || {};
  L.push(`- pagination: ${pg.shapes && pg.shapes.length ? pg.shapes.join(', ') : 'none seen on the first page'}${pg.relNext ? ` (next: ${pg.relNext})` : ''}`);
  const eps = r.jsonEndpoints || [];
  if (eps.length) {
    L.push('- JSON the pages themselves asked for that holds VIN-like strings (address pattern, top-level keys; bodies not kept):');
    for (const e of eps) L.push(`  - ${e.method} \`${esc(e.pattern)}\` (HTTP ${e.status}, ${e.vinCount} VINs, on the ${e.page}): ${e.topKeys.map((k) => '`' + esc(k) + '`').join(', ')}`);
  } else {
    L.push('- JSON the pages themselves asked for that holds VIN-like strings: none seen');
  }
  L.push('');

  const cps = r.carPages || [];
  L.push(`## Car pages (${cps.length} opened, at most ${r.limits ? r.limits.maxCarPages : '?'})`, '');
  if (!cps.length) L.push(r.carPagesNote || 'None opened.');
  for (const c of cps) {
    if (c.error) {
      L.push(`- ${c.url}: ${c.error}`);
      continue;
    }
    const j = c.jsonLd || {};
    L.push(`- ${c.url}: HTTP ${c.status}; JSON-LD ${j.blocks} blocks, types ${j.types && j.types.length ? j.types.join(', ') : 'none'}; vehicle nodes ${j.vehicles} (VIN ${j.withVin}, offers.price ${j.withPrice}, priceCurrency ${j.withCurrency}, mileageFromOdometer ${j.withMileage}, image ${j.withImage}); microdata ${Object.keys(c.microdata || {}).join(', ') || 'none'}; VIN in the server HTML ${yes(c.serverVins > 0)}; photo hosts ${Object.keys(c.photoHosts || {}).join(', ') || 'none seen'}`);
  }
  if (r.disallowedCarPages && r.disallowedCarPages.length) L.push(`- skipped for robots.txt: ${r.disallowedCarPages.length} car page(s), e.g. ${r.disallowedCarPages[0].url} (${r.disallowedCarPages[0].rule})`);
  if (r.excerpt) L.push('', `A JSON-LD block of ${r.excerpt.from} (the first with a vehicle, else the first) (at most ${EXCERPT_LIMIT} characters):`, '', '```json', r.excerpt.text, '```');
  L.push('');

  L.push('## What Lot Current read', '');
  const ls = r.lotSync || {};
  if (!ls.attempted) L.push(`Not run: ${ls.skippedReason || 'the survey stopped first'}.`);
  else if (!ls.ok) L.push(`The scan did not read the site: "${esc(ls.message)}"`);
  else {
    L.push(`- adapter: **${ls.adapterName || ls.adapter}** (\`${ls.adapter}\`)`);
    L.push(`- cars: ${ls.carCount}; with a VIN ${ls.withVin}, a price ${ls.withPrice}, mileage ${ls.withMileage}, photos ${ls.withPhotos}`);
    L.push(`- decisions: ${Object.entries(ls.decisions || {}).map(([k, c]) => `${k} ${c}`).join(', ') || 'none'}`);
    L.push(`- requests the scan reported: ${ls.requests ?? 'not reported'}; complete: ${yes(ls.complete)}`);
    if (ls.photoOrigins && ls.photoOrigins.length) L.push(`- photo servers: ${ls.photoOrigins.join(', ')}`);
    if (ls.metaText) L.push(`- the popup said: "${esc(ls.metaText)}"`);
    for (const w of ls.warnings || []) L.push(`- warning shown: "${esc(w)}"`);
    if (ls.firstCars && ls.firstCars.length) {
      L.push('', 'First cars as Lot Current stored them:', '', '| VIN | Name | Price | Mileage | Photos | Type | Decision |', '|---|---|---|---|---|---|---|');
      for (const c of ls.firstCars) L.push(`| ${esc(c.vin)} | ${esc(c.name)} | ${c.price ?? ''} | ${c.mileage ?? ''} | ${c.photoCount ?? ''} | ${esc(c.type)} | ${esc(c.decision)}${c.reason ? ': ' + esc(c.reason) : ''} |`);
    }
  }
  L.push('');

  L.push('## Gaps', '');
  if (v.gaps && v.gaps.length) for (const g of v.gaps) L.push(`- ${g}`);
  else L.push('- none found');
  for (const n of v.notes || []) L.push(`- note: ${n}`);
  L.push('');

  L.push('## Requests and limits', '');
  const q = r.requests || {};
  L.push(`- cap: ${r.limits ? r.limits.capText : ''}`);
  L.push(`- pages the survey itself asked for: ${q.survey ?? 0} (robots.txt ${q.robots ?? 0}, list ${q.list ?? 0}, list server HTML ${q.listServerHtml ?? 0}, car pages ${q.carPages ?? 0}), at least ${r.limits ? r.limits.pauseMs / 1000 : 2} s apart`);
  L.push(`- everything the browser loaded while on the site's pages (scripts, styles, the page's own data calls): ${q.browserTotal ?? 0}; images, video and fonts were not downloaded (${q.blockedMedia ?? 0} skipped)`);
  L.push(`- during Lot Current's scan: ${q.lotSyncScan ?? 0} requests seen from the tab`);
  const rb = r.robots || {};
  L.push(`- robots.txt: HTTP ${rb.status ?? 'not read'}; ${rb.rules ?? 0} rules for every robot; crawl-delay ${rb.crawlDelaySec ?? 'none'}${rb.note ? '; ' + rb.note : ''}`);
  if (r.bot && r.bot.signs && r.bot.signs.length) L.push(`- bot-check / CDN signs: ${r.bot.signs.join('; ')}`);
  L.push('');
  return L.join('\n');
}

/** The table across every site surveyed in one run. */
export function renderSummaryMd(reports, { runAt = '' } = {}) {
  const L = ['# Site survey summary', ''];
  if (runAt) L.push(`Run ${runAt}. One row per site; each site's report.md has the evidence.`, '');
  L.push('| Site | Platform | Server HTML: car links / VINs | Rendered: car links / VINs | Car pages with vehicle JSON-LD / microdata | Lot Current adapter | Cars read (price / mileage / photos) | Verdict |', '|---|---|---|---|---|---|---|---|');
  for (const r of reports) {
    const list = r.list || {};
    const s = list.server;
    const d = list.rendered;
    const cp = r.carPagesSummary || { read: 0, withVehicleJsonLd: 0, withVehicleMicrodata: 0 };
    const ls = r.lotSync || {};
    const cars = ls.ok ? `${ls.carCount} (${ls.withPrice} / ${ls.withMileage} / ${ls.withPhotos})` : '';
    const v = r.verdict || {};
    L.push(`| ${esc(r.host)} | ${esc((list.platform && list.platform.platform) || 'unknown')} | ${s ? `${s.carLinks} / ${s.vins}` : ''} | ${d ? `${d.carLinks} / ${d.vins}` : ''} | ${cp.read ? `${cp.withVehicleJsonLd} / ${cp.withVehicleMicrodata || 0} of ${cp.read}` : ''} | ${esc(ls.ok ? ls.adapter : ls.attempted ? 'scan failed' : 'not run')} | ${cars} | **${esc(v.verdict)}**: ${esc(v.why)} |`);
  }
  L.push('');
  return L.join('\n');
}
