// Every chrome.storage.local key the extension uses, in one place. The popup,
// the side panel, the wizard, listing upkeep, the service worker and the pilot
// numbers read and write the same keys; each used to spell them itself, and
// "Clear everything for this website" had to know all of them. The names are
// the ones existing installs already hold: nothing here may be renamed
// without a migration. HANDOFF.md section 5.1 describes each value's shape.
//
// Per-website keys are `<name>:<origin>`, origin being the dealer website's
// (https://www.example-dealer.com). The rest are single keys. Milestone 4's
// accounts add a namespace on top of these; `account` is reserved for the
// signed-in session and `sync` for each website's sync state.
// The synced profile lives in chrome.storage.sync under PROFILE_KEY in
// src/settings.js, not here.

// Field name (as the code calls it) -> the prefix stored before ":<origin>".
export const SITE_KEY_NAMES = Object.freeze({
  settings: 'settings',
  snapshot: 'snapshot',
  diff: 'diff',
  posted: 'posted',
  boilerplate: 'boilerplate',
  queue: 'postQueue',
  drafts: 'drafts',
  wizard: 'wizard',
  wizardDone: 'wizardDone',
  flow: 'postFlow',
  pilot: 'pilot',
  sync: 'sync', // the sync state for this website (src/sync.js, Milestone 4): since, dealership id, role, the plan state, today's server-side post count
});

// { settings: 'settings:<origin>', queue: 'postQueue:<origin>', ... }: every
// key one website owns, so Object.values(siteKeys(origin)) is what clearing
// that website removes.
export function siteKeys(origin) {
  const o = String(origin || '');
  const out = {};
  for (const [field, name] of Object.entries(SITE_KEY_NAMES)) out[field] = `${name}:${o}`;
  return out;
}

export const pilotKey = (origin) => siteKeys(origin).pilot;

// Keys that are not per website.
export const GLOBAL_KEYS = Object.freeze({
  sites: 'sites', // the background-rescan registry, one object for all origins (src/scanRunner.js)
  devOverrides: 'devOverrides', // test hook over the form map's addresses and timings (facebook/formMap.js)
  postRequest: 'postRequest', // popup -> side panel: post this car
  setupRequest: 'setupRequest', // popup -> side panel: run set-up
  upkeepRequest: 'upkeepRequest', // popup -> side panel: open this listing to take it down or update its price
  lastPostOrigin: 'lastPostOrigin', // the website the side panel was last working on
  account: 'account', // reserved: the signed-in account (Milestone 4)
});

export const SITES_KEY = GLOBAL_KEYS.sites;

// The three requests the popup writes and the side panel acts on.
export const REQUEST_KEYS = Object.freeze([GLOBAL_KEYS.postRequest, GLOBAL_KEYS.setupRequest, GLOBAL_KEYS.upkeepRequest]);
