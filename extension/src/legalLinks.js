// Where the Terms of Service, the Privacy Policy and the posting rules are
// read, and which edition of them a person accepts.
//
// The documents are attorney drafts (legal/terms-of-service.md,
// legal/privacy-policy.md, legal/posting-rules.md) and will be hosted on the
// product website once it exists (Milestone 5). Until then these addresses
// are placeholders: replace all three when the site is up. `version` is the
// edition the wizard's Terms step and the tick in Settings record next to the
// acceptance time (settings.legal); changing it re-asks everyone, so bump it
// whenever the texts change in a way people must accept again.

export const LEGAL = Object.freeze({
  version: '2026-09-28-draft',
  termsUrl: 'https://lotsync.example/terms',
  privacyUrl: 'https://lotsync.example/privacy',
  rulesUrl: 'https://lotsync.example/posting-rules',
});

// Are the documents really published? While the addresses are placeholders
// nobody can read them, so the wizard's Terms step is informational and no
// acceptance is recorded (asking a person to accept what they cannot open
// would be a false record). The step starts gating on its own once the
// addresses point at a real host.
export const legalHosted = () => !/\.example(\/|$)/i.test(LEGAL.termsUrl) && !/\.example(\/|$)/i.test(LEGAL.privacyUrl);

// The record settings.legal holds once a person has accepted the current edition.
export const acceptLegal = (now = new Date().toISOString()) => ({ version: LEGAL.version, acceptedAt: String(now) });

// True when the acceptance on file is for the current edition. A person who
// set up before the Terms step existed, or accepted an older edition, is not
// blocked from posting (a Milestone 5 decision); Settings shows it.
export const legalIsCurrent = (legal) => Boolean(legal && legal.version === LEGAL.version && legal.acceptedAt);
