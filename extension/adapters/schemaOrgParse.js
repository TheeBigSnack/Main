// Reads the vehicle data a dealer website publishes for search engines: the
// schema.org JSON-LD blocks and microdata that Google's vehicle listing
// guidelines describe (Car, Vehicle, Product, Offer), plus the few plain
// facts about the page the normaliser needs next to them (its title, its
// canonical address, the next page, its links, its Carfax links and its
// visible text). Written from the public schema.org definitions and Google's
// structured-data documentation, not from any one platform's pages, so it
// names none: which platforms mark up their inventory this way is only known
// once a real site has been scanned.
//
// Pure and string-level. It also runs in the service worker, which has no
// DOMParser, so the HTML is split by a small tokenizer here. It never
// fetches anything: the caller hands it the page's HTML and address.
// adapters/schemaOrgNormalize.js turns the nodes it returns into the flat
// vehicle.

// ---------- the HTML, split the way a browser splits it ----------

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
// Elements whose content is text, not markup: a "<" inside a script is not a tag.
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'noscript', 'template', 'iframe', 'xmp', 'noembed', 'noframes']);
// Never part of what a person sees on the page.
const UNSEEN = new Set(['head', 'script', 'style', 'noscript', 'template', 'title', 'svg', 'math', 'iframe', 'textarea', 'object', 'canvas', 'xmp', 'noembed', 'noframes']);

// The visible text is for finding a price or a mileage on the page; a
// vehicle page's own text is far shorter than this.
export const TEXT_LIMIT = 100000;
const MAX_DEPTH = 32;
// A microdata value is read from its element's whole subtree, and nested
// itemprops each read their own subtree again, so a page of thousands of
// nested elements would cost the square of its size. One value stops at
// VALUE_LIMIT characters and elements (a real description is far shorter),
// and all the values on one page share TEXT_BUDGET.
const VALUE_LIMIT = 20000;
const TEXT_BUDGET = 1000000;
// Following @id references copies the node they point at, and a node that
// points at itself thousands of times would be copied the square of that
// many times. A real car with its offers, seller and a few hundred photos
// is a few thousand objects and values; past the limit a reference stays as
// written. A page's cars together share the larger one.
const RESOLVE_LIMIT = 10000;
const PAGE_RESOLVE_LIMIT = 1000000;

const ENTITIES = new Map(Object.entries({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', shy: '\u00ad',
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', hellip: '\u2026', mdash: '\u2014', ndash: '\u2013', bull: '\u2022', middot: '\u00b7',
  lsquo: '\u2018', rsquo: '\u2019', sbquo: '\u201a', ldquo: '\u201c', rdquo: '\u201d', bdquo: '\u201e', laquo: '\u00ab', raquo: '\u00bb',
  deg: '\u00b0', times: '\u00d7', divide: '\u00f7', plusmn: '\u00b1', frac12: '\u00bd', frac14: '\u00bc', frac34: '\u00be', sup2: '\u00b2', sup3: '\u00b3',
  cent: '\u00a2', pound: '\u00a3', euro: '\u20ac', yen: '\u00a5', sect: '\u00a7', para: '\u00b6', micro: '\u00b5',
  eacute: '\u00e9', egrave: '\u00e8', ecirc: '\u00ea', aacute: '\u00e1', agrave: '\u00e0', ntilde: '\u00f1', ouml: '\u00f6', uuml: '\u00fc', auml: '\u00e4',
}));

/** "&amp;", "&#39;" and "&#x2F;" back to the characters they stand for; unknown names are left as written. */
export function decodeEntities(s) {
  if (typeof s !== 'string' || !s.includes('&')) return s;
  return s.replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, name) => {
    if (name[0] === '#') {
      const code = /^#x/i.test(name) ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES.get(name) ?? ENTITIES.get(name.toLowerCase()) ?? whole;
  });
}

const isSpace = (c) => c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f';
const isLetter = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');

// One start tag's attributes, read from just after its name up to its ">".
// As in a browser, a quote opens a value only after "=", the first of two
// attributes with one name wins, and a value whose closing quote never comes
// runs to the end of the page (null: the rest of the page is inside this
// tag). One pass, so a page full of stray quotes costs no more than any other.
function readTag(src, i) {
  const attrs = Object.create(null); // a page's attribute names never reach Object.prototype
  const n = src.length;
  let slash = false; // a "/" of its own right before ">" ("<br/>"), not one ending a value ("href=/cars/>")
  while (i < n) {
    const c = src[i];
    if (c === '>') return { attrs, end: i + 1, selfClosing: slash };
    slash = c === '/';
    if (isSpace(c) || c === '/') {
      i += 1;
      continue;
    }
    let j = i + 1; // an attribute name may start with "=", never end with one
    while (j < n && !isSpace(src[j]) && src[j] !== '/' && src[j] !== '>' && src[j] !== '=') j += 1;
    const name = src.slice(i, j).toLowerCase();
    i = j;
    while (i < n && isSpace(src[i])) i += 1;
    let value = '';
    if (src[i] === '=') {
      i += 1;
      while (i < n && isSpace(src[i])) i += 1;
      const q = src[i];
      if (q === '"' || q === "'") {
        const close = src.indexOf(q, i + 1);
        if (close === -1) return null;
        value = src.slice(i + 1, close);
        i = close + 1;
      } else {
        const from = i;
        while (i < n && !isSpace(src[i]) && src[i] !== '>') i += 1;
        value = src.slice(from, i);
      }
    }
    if (!(name in attrs)) attrs[name] = decodeEntities(value);
  }
  return null;
}

// Tags, text and raw text in page order. Comments, doctypes and CDATA
// sections outside scripts are dropped; a commented-out script is no script.
function tokenize(html) {
  const src = String(html || '');
  const lower = src.toLowerCase();
  const out = [];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      out.push({ text: src.slice(i) });
      break;
    }
    if (lt > i) out.push({ text: src.slice(i, lt) });
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    const closing = src[lt + 1] === '/';
    const at = closing ? lt + 2 : lt + 1;
    if (!isLetter(src[at] || '')) {
      // "<!DOCTYPE", "<?xml", "</ >" are no tags; a "<" before anything else is text
      const bogus = src[lt + 1] === '!' || src[lt + 1] === '?' || closing;
      const end = bogus ? src.indexOf('>', lt) : -1;
      if (bogus) i = end === -1 ? src.length : end + 1;
      else {
        out.push({ text: '<' });
        i = lt + 1;
      }
      continue;
    }
    let j = at;
    while (j < src.length && !isSpace(src[j]) && src[j] !== '/' && src[j] !== '>') j += 1;
    const name = src.slice(at, j).toLowerCase();
    if (closing) {
      const end = src.indexOf('>', j);
      out.push({ close: name });
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    const read = readTag(src, j);
    if (!read) break;
    i = read.end;
    const tag = { open: name, attrs: read.attrs, selfClosing: read.selfClosing };
    // a browser ignores "/>" on a script and the like: its text runs to the end tag
    if (RAW_TEXT.has(name)) {
      tag.selfClosing = false;
      let end = lower.indexOf('</' + name, i);
      while (end !== -1 && !/[\s/>]/.test(src[end + name.length + 2] || '>')) end = lower.indexOf('</' + name, end + 1);
      tag.raw = src.slice(i, end === -1 ? src.length : end);
      const close = end === -1 ? -1 : src.indexOf('>', end);
      i = close === -1 ? src.length : close + 1;
    }
    out.push(tag);
  }
  return out;
}

// The element tree. An end tag closes the nearest open element of its name
// and everything opened inside it; a stray end tag is ignored. How many
// elements of each name are open is counted, so a stray end tag is known
// without searching the open elements: thousands of unclosed tags followed
// by thousands of stray end tags cost one pass, not the square of it.
function buildTree(tokens) {
  const root = { tag: '#document', attrs: Object.create(null), children: [] };
  const stack = [root];
  const open = new Map();
  for (const t of tokens) {
    const parent = stack[stack.length - 1];
    if (t.text !== undefined) parent.children.push({ text: t.text });
    else if (t.close) {
      if (!open.get(t.close)) continue;
      for (let k = stack.length - 1; k > 0; k -= 1) {
        if (stack[k].tag === t.close) {
          for (let j = k; j < stack.length; j += 1) open.set(stack[j].tag, open.get(stack[j].tag) - 1);
          stack.length = k;
          break;
        }
      }
    } else {
      const el = { tag: t.open, attrs: t.attrs, children: [], raw: t.raw };
      parent.children.push(el);
      if (t.raw === undefined && !t.selfClosing && !VOID.has(t.open)) {
        stack.push(el);
        open.set(t.open, (open.get(t.open) || 0) + 1);
      }
    }
  }
  return root;
}

// Depth-first, in page order, without recursion (a page with thousands of
// unclosed tags must not overflow the stack). enter(node) returns false to
// skip a node's children.
function walk(root, enter) {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (enter(node) === false || !node.children) continue;
    for (let k = node.children.length - 1; k >= 0; k -= 1) stack.push(node.children[k]);
  }
}

function readDocument(html) {
  const tokens = tokenize(html);
  return { tokens, root: buildTree(tokens) };
}

// An http(s) address as a URL, or null.
function urlOf(href, base) {
  if (typeof href !== 'string' || !href.trim()) return null;
  try {
    const u = new URL(href.trim(), base || undefined);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

function absolute(href, base) {
  const u = urlOf(href, base);
  return u ? u.href : null;
}

// The address relative links resolve against: the page's own, or its <base href>.
function baseOf(doc, pageUrl) {
  const page = absolute(pageUrl);
  const base = doc.tokens.find((t) => t.open === 'base' && t.attrs.href);
  return (base && absolute(base.attrs.href, page)) || page;
}

// ---------- JSON-LD ----------

// XHTML habits and copy-paste leave wrappers around the JSON: a byte order
// mark, an HTML comment, a CDATA section (often inside a JS comment). The
// closing "]]>" is found first and the comment mark in front of it taken
// off after: a single pattern for both, anchored only at the end, would be
// tried from every space in the block, and a block with a long run of
// spaces would cost the square of its length.
function unwrap(raw) {
  let s = String(raw)
    .replace(/\ufeff/g, '')
    .trim()
    .replace(/^<!--/, '')
    .replace(/-->$/, '')
    .trim()
    .replace(/^(?:\/\/|\/\*)?\s*<!\[CDATA\[(?:\s*\*\/)?/, '');
  const close = /\]\]>(?:\s*\*\/)?$/.exec(s);
  if (close) s = s.slice(0, close.index).trimEnd().replace(/(?:\/\/|\/\*)$/, '');
  return s.trim();
}

// A raw line break or tab inside a JSON string is invalid, but description
// fields often carry them; escaping them is the only repair made. The text
// between repairs is copied in slices, not a character at a time, so a block
// of megabytes costs no more than reading it.
function escapeControls(s) {
  let out = '';
  let from = 0;
  let inString = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (inString) {
      if (c === 92) i += 1; // a backslash: the next character is escaped already
      else if (c === 34) inString = false;
      else if (c < 32) {
        out += s.slice(from, i) + '\\u' + c.toString(16).padStart(4, '0');
        from = i + 1;
      }
    } else if (c === 34) inString = true;
  }
  return out + s.slice(from);
}

// Websites HTML-escape text before putting it in their JSON ("Tow &amp;
// Haul"); a person reading the page sees the character, so that is what is kept.
function decodeStrings(value, depth = 0) {
  if (typeof value === 'string') return decodeEntities(value);
  if (!value || typeof value !== 'object' || depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((v) => decodeStrings(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) if (k !== '__proto__') out[k] = decodeStrings(v, depth + 1);
  return out;
}

function parseBlock(raw) {
  const s = unwrap(raw);
  if (!s) return undefined;
  const decoded = decodeEntities(s);
  // as written, then with its line breaks escaped, then with the whole block
  // unescaped (some sites escape all of it, quotes included)
  const attempts = [[() => s, true], [() => escapeControls(s), true], [() => decoded, false], [() => escapeControls(decoded), false]];
  for (const [text, decodeValues] of attempts) {
    try {
      const value = JSON.parse(text());
      if (value && typeof value === 'object') return decodeValues ? decodeStrings(value) : value;
      return undefined;
    } catch {
      // not valid as it stands: try the next repair
    }
  }
  return undefined;
}

function blocksFrom(tokens) {
  const blocks = [];
  for (const t of tokens) {
    if (t.open !== 'script' || typeof t.raw !== 'string') continue;
    if (!/^\s*application\/ld\+json\s*(?:;|$)/i.test(t.attrs.type || '')) continue;
    const value = parseBlock(t.raw);
    if (value !== undefined) blocks.push(value);
  }
  return blocks;
}

/**
 * Every application/ld+json block on the page, parsed. A block that is not
 * valid JSON even after the repairs above is skipped, never fatal.
 * @param {string} html
 * @returns {Array<object|Array>}
 */
export function extractJsonLd(html) {
  return blocksFrom(tokenize(html));
}

// ---------- vehicle nodes ----------

const VEHICLE_TYPES = new Set(['Car', 'Vehicle', 'MotorVehicle', 'Motorcycle']);
// Where schema.org pages nest the things they list: a graph, a list and its
// items, the page's main entity, an offer's item, a dealer's offers.
const NESTED = ['@graph', 'itemListElement', 'item', 'mainEntity', 'itemOffered', 'makesOffer', 'hasOfferCatalog'];

// "Car", "schema:Car", "https://schema.org/Car" and "http://schema.org/Car/" are one type.
function typeName(t) {
  return String(t).trim().replace(/\/+$/, '').split(/[/#:]/).pop();
}

function typesOf(node) {
  const t = node['@type'];
  return (Array.isArray(t) ? t : [t]).filter((x) => typeof x === 'string' && x.trim()).map(typeName);
}

function firstText(value) {
  const v = Array.isArray(value) ? value.find((x) => typeof x === 'string' || typeof x === 'number') : value;
  return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
}

function vinOf(node) {
  return firstText(node && node.vehicleIdentificationNumber).replace(/\s+/g, '').toUpperCase();
}

function isVehicle(node) {
  const types = typesOf(node);
  return types.some((t) => VEHICLE_TYPES.has(t)) || (types.includes('Product') && Boolean(vinOf(node)));
}

const isOffer = (node) => typesOf(node).some((t) => t === 'Offer' || t === 'AggregateOffer');

// Every object in the blocks, once each, depth-limited.
function everyObject(blocks, visit) {
  const stack = [[blocks, 0]];
  const seen = new Set();
  while (stack.length) {
    const [x, depth] = stack.pop();
    if (!x || typeof x !== 'object' || depth > MAX_DEPTH || seen.has(x)) continue;
    seen.add(x);
    if (!Array.isArray(x)) visit(x);
    for (const v of Array.isArray(x) ? x : Object.values(x)) if (v && typeof v === 'object') stack.push([v, depth + 1]);
  }
}

// A node that is only { "@id": ... } points at the full node elsewhere on the page.
function target(value, ids) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === '@id' && ids.has(value['@id']) ? ids.get(value['@id']) : value;
}

// A copy of a node with its references followed a few levels down (an
// offer by @id, that offer's seller by @id), so the normaliser reads one
// self-contained object whatever the page's style. Each object copied and
// each value in it is taken from budget.left; once that runs out, what is
// left stays as written (the node itself is always a copy, so the caller
// can change it). The copies are never shared between places: a copy
// that appears in many places would be written out in full at each of them
// when the record is stored or sent.
function resolved(value, ids, budget, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return value;
  if (depth > 0 && budget.left <= 0) return value;
  if (Array.isArray(value)) {
    budget.left -= 1 + value.length;
    return value.map((v) => resolved(v, ids, budget, depth + 1));
  }
  const node = target(value, ids);
  const entries = Object.entries(node);
  budget.left -= 1 + entries.length;
  const out = {};
  // a "__proto__" key in a page's JSON would replace the copy's prototype
  for (const [k, v] of entries) if (k !== '__proto__') out[k] = resolved(v, ids, budget, depth + 1);
  return out;
}

/**
 * The vehicle nodes in parsed JSON-LD blocks (or any objects of the same
 * shape): @type Car, Vehicle, MotorVehicle or Motorcycle, alone or among
 * other types (["Product", "Car"]), or a Product with a
 * vehicleIdentificationNumber. Found at the top level, in arrays, in @graph,
 * in an ItemList's itemListElement (and each ListItem's item), in
 * mainEntity, and as an Offer's itemOffered, in which case that Offer
 * becomes the vehicle's offers when it has none of its own. References by
 * @id are followed. A vehicle's own properties are never searched for more
 * vehicles.
 * @param {Array|object} blocks  what extractJsonLd returns
 * @returns {object[]}
 */
export function vehicleNodes(blocks) {
  const list = Array.isArray(blocks) ? blocks : [blocks];
  const ids = new Map();
  const offerFor = new Map();
  everyObject(list, (node) => {
    const id = node['@id'];
    if (typeof id === 'string' && Object.keys(node).length > 1 && !ids.has(id)) ids.set(id, node);
  });
  everyObject(list, (node) => {
    if (!isOffer(node) || !node.itemOffered) return;
    for (const item of Array.isArray(node.itemOffered) ? node.itemOffered : [node.itemOffered]) {
      const car = target(item, ids);
      if (car && typeof car === 'object' && !offerFor.has(car)) offerFor.set(car, node);
    }
  });

  const out = [];
  const seen = new Set();
  const page = { left: PAGE_RESOLVE_LIMIT };
  const stack = [[list, 0]];
  while (stack.length) {
    const [x, depth] = stack.pop();
    if (!x || typeof x !== 'object' || depth > MAX_DEPTH) continue;
    if (Array.isArray(x)) {
      for (let k = x.length - 1; k >= 0; k -= 1) stack.push([x[k], depth + 1]);
      continue;
    }
    const node = target(x, ids);
    if (seen.has(node)) continue;
    seen.add(node);
    if (isVehicle(node)) {
      const start = Math.min(RESOLVE_LIMIT, page.left);
      const budget = { left: start };
      const car = resolved(node, ids, budget);
      const offer = offerFor.get(node);
      if (offer && car.offers === undefined) {
        car.offers = resolved(offer, ids, budget);
        delete car.offers.itemOffered; // the offer without the car inside it
      }
      page.left = Math.max(0, page.left - (start - budget.left));
      out.push(car);
      continue;
    }
    for (let k = NESTED.length - 1; k >= 0; k -= 1) if (node[NESTED[k]] !== undefined) stack.push([node[NESTED[k]], depth + 1]);
  }
  return out;
}

// ---------- microdata ----------

// An element's text, at most VALUE_LIMIT characters and elements of it,
// taken from the page's budget (see VALUE_LIMIT).
function textOf(el, budget) {
  const start = Math.min(VALUE_LIMIT, budget.left);
  let left = start;
  const parts = [];
  const stack = [el];
  while (stack.length && left > 0) {
    const n = stack.pop();
    left -= 1;
    if (n.text !== undefined) {
      parts.push(n.text.length > left ? n.text.slice(0, Math.max(0, left)) : n.text);
      left -= n.text.length;
      continue;
    }
    if (n !== el && UNSEEN.has(n.tag)) continue;
    const count = Math.min(n.children.length, Math.max(0, left));
    for (let k = count - 1; k >= 0; k -= 1) stack.push(n.children[k]);
    left -= count;
  }
  budget.left = Math.max(0, budget.left - (start - left));
  return decodeEntities(parts.join(' ')).replace(/\s+/g, ' ').trim();
}

// An itemprop's value, as the microdata standard reads it: a meta's content,
// a link's href, an image's src, a time's datetime, else the text. The
// content attribute is read on any element, as search engines do.
function propValue(el, base, budget) {
  const a = el.attrs;
  if ('content' in a) return a.content;
  switch (el.tag) {
    case 'a':
    case 'area':
    case 'link':
      return absolute(a.href, base) || a.href || '';
    case 'img':
    case 'audio':
    case 'video':
    case 'source':
    case 'embed':
    case 'track':
      return absolute(a.src || a['data-src'], base) || '';
    case 'object':
      return absolute(a.data, base) || '';
    case 'data':
    case 'meter':
      return a.value ?? textOf(el, budget);
    case 'time':
      return a.datetime || textOf(el, budget);
    default:
      return textOf(el, budget);
  }
}

function addValue(node, key, value) {
  if (key === '__proto__' || !key) return;
  if (!Object.prototype.hasOwnProperty.call(node, key)) node[key] = value;
  else if (Array.isArray(node[key])) node[key].push(value);
  else node[key] = [node[key], value];
}

// One itemscope element as a node of the JSON-LD shape: its itemtype as
// @type, each itemprop as a property (a property given twice becomes a
// list), a nested itemscope as a nested node.
function readItem(scope, base, budget, depth = 0) {
  const node = {};
  const types = (scope.attrs.itemtype || '').split(/\s+/).filter(Boolean).map(typeName);
  if (types.length) node['@type'] = types.length === 1 ? types[0] : types;
  if (scope.attrs.itemid) node['@id'] = scope.attrs.itemid;
  const pending = [...scope.children].reverse();
  while (pending.length) {
    const el = pending.pop();
    if (el.text !== undefined) continue;
    const isScope = 'itemscope' in el.attrs;
    if ('itemprop' in el.attrs) {
      const value = isScope ? (depth < MAX_DEPTH ? readItem(el, base, budget, depth + 1) : {}) : propValue(el, base, budget);
      for (const name of el.attrs.itemprop.split(/\s+/).filter(Boolean)) addValue(node, typeName(name), value);
    }
    if (!isScope) for (let k = el.children.length - 1; k >= 0; k -= 1) pending.push(el.children[k]);
  }
  return node;
}

// Every top-level item on the page (itemscope without itemprop), wherever it sits.
function microdataItems(root, base) {
  const items = [];
  const budget = { left: TEXT_BUDGET };
  walk(root, (el) => {
    if (el.attrs && 'itemscope' in el.attrs && !('itemprop' in el.attrs)) items.push(readItem(el, base, budget));
    return el.text === undefined;
  });
  return items;
}

/**
 * The vehicles a page marks up with microdata (itemscope, itemtype,
 * itemprop) for the same schema.org properties, as nodes of the shape
 * vehicleNodes returns for JSON-LD: { '@type': 'Car', name, offers: {
 * '@type': 'Offer', price, ... }, ... }. RDFa is not read.
 * @param {string} html
 * @param {string} [pageUrl]  resolves relative image and link addresses
 */
export function microdataVehicles(html, pageUrl) {
  const doc = readDocument(html);
  return vehicleNodes(microdataItems(doc.root, baseOf(doc, pageUrl)));
}

// ---------- the page around the vehicles ----------

function isHidden(attrs) {
  return 'hidden' in attrs || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attrs.style || '');
}

// Crossed-out text is a price or a figure the page no longer stands by
// ("<s>$24,995</s> $23,995"), so the text a price is checked against leaves
// it out. The style is read one declaration at a time, in one pass.
const CROSSED_OUT = new Set(['s', 'strike', 'del']);
function isCrossedOut(el) {
  if (CROSSED_OUT.has(el.tag)) return true;
  const style = el.attrs.style;
  return typeof style === 'string' && /line-through/i.test(style) && style.split(';').some((d) => /^\s*text-decoration(?:-line)?\s*:/i.test(d) && /line-through/i.test(d));
}

function visibleText(root) {
  const parts = [];
  let size = 0;
  walk(root, (n) => {
    if (size > TEXT_LIMIT * 2) return false; // enough read; whitespace is squeezed below
    if (n.text !== undefined) {
      parts.push(n.text);
      size += n.text.length;
      return false;
    }
    return n.tag === '#document' || (!UNSEEN.has(n.tag) && !isHidden(n.attrs) && !isCrossedOut(n));
  });
  return decodeEntities(parts.join(' ')).replace(/\s+/g, ' ').trim().slice(0, TEXT_LIMIT);
}

const relHas = (attrs, word) => String(attrs.rel || '').toLowerCase().split(/\s+/).includes(word);

// A link to a single-page site's route ("#/inventory/...") is a page of its
// own; any other fragment is a place on the same page.
function withoutFragment(u) {
  if (u.hash && !/^#!?\//.test(u.hash)) u.hash = '';
  return u.href;
}

function isCarfax(u) {
  const host = u.hostname.toLowerCase();
  return host === 'carfax.com' || host.endsWith('.carfax.com');
}

function factsFrom(doc, pageUrl) {
  const page = absolute(pageUrl);
  const base = baseOf(doc, pageUrl);
  const origin = page ? new URL(page).origin : null;
  let title = '';
  let ogTitle = '';
  let canonical = null;
  let next = null;
  const links = [];
  const carfaxLinks = [];
  // a Set beside each list: a page of thousands of links is read in one pass
  const seenLinks = new Set();
  const seenCarfax = new Set();
  for (const t of doc.tokens) {
    if (!t.open) continue;
    const a = t.attrs;
    if (t.open === 'title' && !title) title = decodeEntities(t.raw || '').replace(/\s+/g, ' ').trim();
    else if (t.open === 'meta' && !ogTitle && String(a.property || a.name || '').toLowerCase() === 'og:title') ogTitle = String(a.content || '').replace(/\s+/g, ' ').trim();
    else if (t.open === 'link' && relHas(a, 'canonical') && !canonical) canonical = absolute(a.href, base);
    if ((t.open === 'link' || t.open === 'a') && relHas(a, 'next') && !next) next = absolute(a.href, base);
    if (t.open === 'a' || t.open === 'area' || t.open === 'iframe') {
      // parsed once, then read for its host, its origin and its address
      const u = urlOf(t.open === 'iframe' ? a.src : a.href, base);
      if (!u) continue;
      const href = u.href;
      if (isCarfax(u) && !seenCarfax.has(href)) {
        seenCarfax.add(href);
        carfaxLinks.push(href);
      }
      if (t.open !== 'iframe' && origin && u.origin === origin) {
        const clean = withoutFragment(u);
        if (!seenLinks.has(clean)) {
          seenLinks.add(clean);
          links.push(clean);
        }
      }
    }
  }
  return { title: ogTitle || title, canonical, next, links, carfaxLinks, text: visibleText(doc.root) };
}

/**
 * The plain facts about a page the normaliser and a crawler need:
 *   title        the og:title when the page has one (it names the car without
 *                the site's name tacked on), else the <title>
 *   canonical    the rel=canonical address, absolute, or null
 *   next         the rel=next address (the next page of a list), or null
 *   links        every same-origin link, absolute, once each, in page order,
 *                without in-page fragments
 *   carfaxLinks  every link to a carfax.com page, once each
 *   text         the text a person sees (no scripts, styles, head or hidden
 *                elements), without crossed-out text (<s>, <strike>, <del>
 *                or a line-through style: an old price), whitespace
 *                squeezed, at most TEXT_LIMIT characters
 * @param {string} html
 * @param {string} pageUrl  the page's own address
 */
export function pageFacts(html, pageUrl) {
  return factsFrom(readDocument(html), pageUrl);
}

/**
 * Everything the reader takes from one page: the vehicle nodes from JSON-LD
 * first, then microdata, one per VIN (the first one found is kept; nodes
 * without a VIN are kept as they are, for a caller that follows their url),
 * and the page facts.
 * @param {string} html
 * @param {string} pageUrl
 * @returns {{ vehicles: object[], facts: ReturnType<typeof pageFacts> }}
 */
export function parseVehiclePage(html, pageUrl) {
  const doc = readDocument(html);
  const nodes = [...vehicleNodes(blocksFrom(doc.tokens)), ...vehicleNodes(microdataItems(doc.root, baseOf(doc, pageUrl)))];
  const vins = new Set();
  const vehicles = nodes.filter((node) => {
    const vin = vinOf(node);
    if (!vin) return true;
    if (vins.has(vin)) return false;
    vins.add(vin);
    return true;
  });
  return { vehicles, facts: factsFrom(doc, pageUrl) };
}
