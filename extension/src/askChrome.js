// The one place Lot Current asks Chrome for a host permission. The popup, the
// wizard and the side panel call askChrome from a person's click (Chrome
// shows its prompt only during one), and it is the only code that calls
// chrome.permissions.request (test/marketing.test.js reads every call).
//
// It asks only for named websites: each pattern is one http or https host,
// with an optional port, and its whole site. Never a wildcard host, and never
// one of Facebook's servers (src/photoHosts.js isFacebookServer): Lot Current
// reads the dealer's website, its photo servers and NHTSA, and fills
// Facebook's form through the manifest's one Marketplace path. A list with
// anything else in it, or an empty one, is refused whole, without a prompt,
// so whatever a caller builds its list from, Chrome is never asked for more.

import { isFacebookServer } from './photoHosts.js';

// Written in two parts so no comment stripper mistakes it for a comment opener.
const ANY_PATH = '/' + '*';
// <scheme>://<host>[:<port>] in front of ANY_PATH: a name or an IPv4 address
// (letters, digits, dots and hyphens, so no "*"), or an IPv6 address in brackets.
const ONE_HOST = /^(https?):\/\/(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:\d{1,5})?$/i;

/**
 * The patterns, as given, when every one names a single http or https host
 * that is not one of Facebook's; null when the list is empty, is not a list,
 * or has anything else in it (a wildcard, another scheme, a path, "<all_urls>",
 * a Facebook server).
 */
export function askableOrigins(origins) {
  if (!Array.isArray(origins) || !origins.length) return null;
  for (const pattern of origins) {
    if (typeof pattern !== 'string' || !pattern.endsWith(ANY_PATH)) return null;
    const m = ONE_HOST.exec(pattern.slice(0, -ANY_PATH.length));
    if (!m || isFacebookServer(`${m[1]}://${m[2]}/`)) return null;
  }
  return [...origins];
}

/**
 * Asks Chrome for these host permissions and resolves Chrome's answer, or
 * false at once, with no prompt, when askableOrigins refuses the list. Nothing
 * is awaited before Chrome is asked, so the person's click still counts.
 */
export function askChrome(origins) {
  const asked = askableOrigins(origins);
  if (!asked) return Promise.resolve(false);
  return chrome.permissions.request({ origins: asked });
}
