// Which servers a car's photos sit on, and which of them Lot Current still has
// to ask Chrome for. The service worker downloads every photo (background.js
// downloadPhoto: the Facebook page can't read another site's images), and
// Chrome lets it read a server only when a host permission covers it: one the
// manifest lists, or one granted later. The side panel asks for the rest from
// the salesperson's click, with Chrome's own prompt; Chrome remembers a yes.
//
// Pure: the manifest's list and the granted list come in as arguments.
// Only https servers are ever asked for (the manifest's optional host
// permissions offer https://<any host>/ and nothing wider), and never one of
// Facebook's: Lot Current fills Facebook's form, it doesn't read from Facebook.
// That rule holds for downloads too, not only for the asking: the manifest
// covers www.facebook.com/marketplace/ for the form, so the side panel and
// the worker both check isFacebookServer before a photo is fetched.

// Facebook's own domains, the image servers included: a dealer page that
// reuses photos from its Facebook page points at scontent-*.fbcdn.net or
// lookaside.fbsbx.com, not at facebook.com.
const FACEBOOK_DOMAINS = ['facebook.com', 'facebook.net', 'fb.com', 'fbcdn.net', 'fbsbx.com', 'messenger.com'];

// Written in two parts so no comment stripper mistakes it for a comment opener.
const ANY_PATH = '/' + '*';

// Chrome compares host names in lower case and without a trailing dot.
const bareHost = (host) => String(host || '').toLowerCase().replace(/\.$/, '');
const neverAsked = (host) => FACEBOOK_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
// The URL parser writes every IPv4 address as four decimal numbers and puts IPv6 in brackets.
const isIpAddress = (host) => /^\[.*\]$/.test(host) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
const list = (x) => (Array.isArray(x) ? x : []);

function httpsUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && url.hostname ? url : null;
  } catch (e) {
    return null;
  }
}

/**
 * Is this address on one of Facebook's servers, whatever its scheme? Lot Current
 * never downloads from those, even where a manifest permission would let it.
 */
export function isFacebookServer(address) {
  try {
    return neverAsked(bareHost(new URL(String(address)).hostname));
  } catch (e) {
    return false;
  }
}

/**
 * The https origins the photos are on, each once, in the order the photos
 * come (a host with a trailing dot is the same server without it). Anything
 * else (http, a relative or broken address, Facebook's own servers) is left
 * out: Lot Current never asks for it.
 */
export function photoOriginsOf(urls) {
  const out = [];
  for (const u of list(urls)) {
    const url = httpsUrl(u);
    const host = url && bareHost(url.hostname);
    if (!host || neverAsked(host)) continue;
    const origin = 'https://' + host + (url.port ? ':' + url.port : '');
    if (!out.includes(origin)) out.push(origin);
  }
  return out;
}

/**
 * The host permission to ask for so the worker can download from an origin:
 * https://<host>/ with any path. No port is written, and a pattern without
 * one covers every port on that host. null for anything Lot Current never asks for.
 */
export function permissionPattern(origin) {
  const url = httpsUrl(origin);
  if (!url) return null;
  const host = bareHost(url.hostname);
  if (!host || neverAsked(host)) return null;
  return 'https://' + host + ANY_PATH;
}

// A host permission taken apart the way Chrome reads one:
// <scheme>://<host><path>, where the host is "*", "*.<domain>" or one name
// or address, with an optional ":<port>" (a number or "*"; none means any
// port). "<all_urls>" covers everything. Anything Chrome would refuse is null.
function parsePattern(pattern) {
  const p = String(pattern || '');
  if (p === '<all_urls>') return { scheme: '*', host: '', subdomains: true, port: '*' };
  const m = /^(\*|[a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)$/i.exec(p);
  if (!m) return null;
  const hp = /^(\[[^\]]*\]|[^:]*)(?::(\*|\d+))?$/.exec(m[2]);
  if (!hp) return null;
  let host = hp[1];
  let subdomains = false;
  if (host === '*') {
    host = '';
    subdomains = true;
  } else if (host.startsWith('*.')) {
    host = host.slice(2);
    subdomains = true;
  }
  if (host.includes('*')) return null; // a wildcard anywhere else is not a pattern Chrome accepts
  if (!host && !subdomains) return null;
  return { scheme: m[1].toLowerCase(), host: bareHost(host), subdomains, port: hp[2] === undefined ? '*' : hp[2] };
}

// Chrome's rules for a host pattern against an https address: the scheme is
// https or "*"; the host is the same, or the pattern is "*", or it is
// "*.<domain>" and the address is that domain or a name under it (never an
// IP address, which has no subdomains); the port is "*" or the address's
// own (443 when none is written). The path part of a pattern is not
// compared: Chrome lets an extension read another site per origin, so a
// pattern's path doesn't narrow what the worker can download.
function covers(p, url) {
  if (!p || !url) return false;
  if (p.scheme !== 'https' && p.scheme !== '*') return false;
  if (p.port !== '*' && Number(p.port) !== (url.port ? Number(url.port) : 443)) return false;
  const host = bareHost(url.hostname);
  if (host === p.host) return true;
  if (!p.subdomains) return false;
  if (!p.host) return true;
  if (isIpAddress(host)) return false;
  return host.endsWith('.' + p.host);
}

/** Does a host permission (Chrome's pattern syntax) cover this https address or origin? */
export function patternCovers(pattern, address) {
  return covers(parsePattern(pattern), httpsUrl(address));
}

/** The host a pattern names, for the sentences the panel shows ("*" for any host). */
export function patternHost(pattern) {
  const p = parsePattern(pattern);
  if (!p) return '';
  if (!p.host) return '*';
  return p.subdomains ? '*.' + p.host : p.host;
}

/**
 * The patterns to ask Chrome for so the worker can download these photos:
 * one per server that neither the manifest's host_permissions nor the
 * granted permissions (chrome.permissions.getAll().origins) cover, each
 * once, in the order the photos come. Empty when nothing is missing.
 * @param urls  the car's photo addresses
 * @param options { manifestHosts: manifest.host_permissions, granted: the granted origins }
 */
export function neededPatterns(urls, { manifestHosts = [], granted = [] } = {}) {
  const have = [...list(manifestHosts), ...list(granted)].map(parsePattern).filter(Boolean);
  const out = [];
  for (const origin of photoOriginsOf(urls)) {
    const pattern = permissionPattern(origin);
    if (!pattern || out.includes(pattern)) continue;
    const url = httpsUrl(origin);
    if (have.some((p) => covers(p, url))) continue;
    out.push(pattern);
  }
  return out;
}
