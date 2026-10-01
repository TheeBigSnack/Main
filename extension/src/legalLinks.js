// Where the Terms of Service, the Privacy Policy and the posting rules are
// read, and which edition of them a person accepts.
//
// The documents are attorney drafts (legal/terms-of-service.md,
// legal/privacy-policy.md, legal/posting-rules.md). `npm run legal-pages`
// writes them into the website as site/legal/terms/index.html,
// site/legal/privacy/index.html and site/legal/posting-rules/index.html
// (served at /legal/terms/, /legal/privacy/ and /legal/posting-rules/; the
// old .html addresses redirect there), each marked as a draft that is not in
// effect while legal/legal-status.json says draft. Until site/ is deployed
// (docs/website.md) and those pages are no longer drafts, these addresses
// stay placeholders: recording that a person accepted a text marked "not in
// effect" would be a false record. Then they become
// https://<the site's host>/legal/terms/,
// https://<the site's host>/legal/privacy/ and
// https://<the site's host>/legal/posting-rules/ (the host is the one in
// site/config.js siteUrl), and `version` must be bumped in the same change.
//
// `version` is the edition the wizard's Terms step and the tick in Settings
// record next to the acceptance time (settings.legal); after a change
// Settings shows everyone's acceptance as out of date (legalIsCurrent), so
// bump it whenever the texts change in a way people must accept again.

export const LEGAL = Object.freeze({
  version: '2026-09-28-draft',
  termsUrl: 'https://lotsync.example/terms',
  privacyUrl: 'https://lotsync.example/privacy',
  rulesUrl: 'https://lotsync.example/posting-rules',
});

// A placeholder address: not an https address at all, or one under the
// reserved .example domain (RFC 2606), which nobody can host.
export function isPlaceholderUrl(url) {
  const u = String(url || '').trim();
  if (!/^https:\/\//i.test(u)) return true;
  let host = '';
  try {
    host = new URL(u).hostname;
  } catch {
    return true;
  }
  return /(^|\.)example$/i.test(host);
}

// Are the documents really published? While the addresses are placeholders
// nobody can read them, so the wizard's Terms step is informational and no
// acceptance is recorded (asking a person to accept what they cannot open
// would be a false record). The step starts gating on its own once the
// addresses point at a real host.
export const legalHosted = () => !isPlaceholderUrl(LEGAL.termsUrl) && !isPlaceholderUrl(LEGAL.privacyUrl);

// The record settings.legal holds once a person has accepted the current edition.
export const acceptLegal = (now = new Date().toISOString()) => ({ version: LEGAL.version, acceptedAt: String(now) });

// True when the acceptance on file is for the current edition. A person who
// set up before the Terms step existed, or accepted an older edition, is not
// blocked from posting (a Milestone 5 decision); Settings shows it.
export const legalIsCurrent = (legal) => Boolean(legal && legal.version === LEGAL.version && legal.acceptedAt);
