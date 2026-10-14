import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { queueHoldReasons, holdStatus } from '../extension/src/queueHold.js';

// A car with nothing to check: every hold check passes.
const CLEAR = {
  guardrails: { ok: true, problems: [] },
  relist: null,
  vinProblems: [],
  brandingRunning: false,
  croppedPhotos: 0,
  missing: [],
  assumed: [],
  branded: '',
  unknownPhotoServers: false,
  cap: { reached: false, count: 3 },
};
const hold = (over = {}) => queueHoldReasons({ ...CLEAR, ...over });
const keysOf = (over = {}) => hold(over).map((r) => r.key);

test('a car with nothing to check is not held', () => {
  assert.deepEqual(hold(), []);
});

test('a description that failed its checks holds the car and names its first problem', () => {
  const [r] = hold({ guardrails: { ok: false, problems: [{ code: 'too-short', text: '12 words; needs at least 25' }, { code: 'too-long', text: 'later problem' }] } });
  assert.equal(r.key, 'guardrails');
  assert.equal(r.text, 'The description needs a fix first: 12 words; needs at least 25.');
});

test('a description that has not been checked holds the car', () => {
  const [r] = hold({ guardrails: null });
  assert.equal(r.key, 'guardrails');
  assert.equal(r.text, 'The description has not been checked yet.');
});

test('a car taken down on Facebook while the website still lists it is held', () => {
  assert.deepEqual(keysOf({ relist: { takenDownAt: '2026-10-01T10:00:00Z' } }), ['relist']);
});

test('a VIN check problem holds the car and names the check that failed', () => {
  const [r] = hold({ vinProblems: [{ label: 'Manufacturer', detail: 'VIN is from Honda, but the website says Ford' }] });
  assert.equal(r.key, 'vin');
  assert.equal(r.text, 'The VIN check failed: Manufacturer: VIN is from Honda, but the website says Ford.');
});

test('a photo check still running holds the car', () => {
  assert.deepEqual(keysOf({ brandingRunning: true }), ['branding']);
});

test('a photo the check cropped holds the car until the person looks at it, with the count', () => {
  assert.equal(hold({ croppedPhotos: 1 })[0].text, 'The photo check cropped 1 photo on this listing; look at it before posting.');
  assert.equal(hold({ croppedPhotos: 2 })[0].text, 'The photo check cropped 2 photos on this listing; look at them before posting.');
});

test('a field the website gives no value for holds the car; the photo-title fields never do', () => {
  const [r] = hold({ missing: [{ key: 'titleStatus', label: 'Title status' }, { key: 'cleanTitle', label: 'Clean title' }, { key: 'model', label: 'Model' }] });
  assert.equal(r.key, 'missing');
  assert.equal(r.text, 'Model is missing: the website gives no value for it.');
  assert.deepEqual(keysOf({ missing: [{ key: 'titleStatus', label: 'Title status' }] }), []);
});

test('a missing field names how many more are blank', () => {
  const [r] = hold({ missing: [{ key: 'model', label: 'Model' }, { key: 'year', label: 'Year' }] });
  assert.equal(r.text, 'Model is missing: the website gives no value for it (and 1 more blank).');
});

test('the condition and title status defaults do not hold the car', () => {
  assert.deepEqual(hold({ assumed: [{ key: 'condition', label: 'Vehicle condition', value: 'Used' }, { key: 'titleStatus', label: 'Title status', value: 'Clean' }] }), []);
});

test('an assumed value holds the car and says what was assumed and why', () => {
  const [r] = hold({ assumed: [{ key: 'fuelType', label: 'Fuel type', value: 'Hybrid', why: 'a mild hybrid' }] });
  assert.equal(r.key, 'assumed');
  assert.equal(r.text, 'Assumed: Fuel type is Hybrid (a mild hybrid). Check it on the form.');
});

test('a branded title in the website text holds the car', () => {
  const [r] = hold({ branded: 'rebuilt title' });
  assert.equal(r.key, 'branded');
  assert.equal(r.text, 'The website\'s text mentions a branded title ("rebuilt title"). Pick the title on the form.');
});

test('a photo server Chrome has not been allowed to read holds the car', () => {
  assert.deepEqual(keysOf({ unknownPhotoServers: true }), ['photoServer']);
});

test('the day\'s cap holds the car and names the count', () => {
  const [r] = hold({ cap: { reached: true, count: 10 } });
  assert.equal(r.key, 'cap');
  assert.equal(r.text, 'Daily post cap reached (10). It resets tomorrow; the dealer can change it in Settings.');
});

test('reasons come in the order the checks run, so the first one is the one named', () => {
  const all = {
    guardrails: { ok: false, problems: [{ text: 'x' }] },
    relist: { takenDownAt: 'T' },
    vinProblems: [{ label: 'a', detail: 'b' }],
    brandingRunning: true,
    croppedPhotos: 1,
    missing: [{ key: 'model', label: 'Model' }],
    assumed: [{ key: 'fuelType', label: 'Fuel type', value: 'Hybrid', why: 'w' }],
    branded: 'rebuilt',
    unknownPhotoServers: true,
    cap: { reached: true, count: 1 },
  };
  assert.deepEqual(keysOf(all), ['guardrails', 'relist', 'vin', 'branding', 'cropped', 'missing', 'assumed', 'branded', 'photoServer', 'cap']);
});

test('the status names the first reason and says the queue carries on once the form is opened', () => {
  const s = holdStatus({ key: 'assumed', text: 'Assumed: Fuel type is Hybrid (a mild hybrid). Check it on the form.' });
  assert.equal(s.text, 'Assumed: Fuel type is Hybrid (a mild hybrid). Check it on the form. Click Open the Marketplace form when it is right; the queue carries on after this car.');
  assert.equal(s.kind, '');
});

test('the cap status is an error and does not promise the form opens', () => {
  const s = holdStatus({ key: 'cap', text: 'Daily post cap reached (10). It resets tomorrow; the dealer can change it in Settings.' });
  assert.equal(s.text, 'Daily post cap reached (10). It resets tomorrow; the dealer can change it in Settings.');
  assert.equal(s.kind, 'error');
});

// The gate and the explanation must agree. canAutoOpen (sidepanel.js) is the
// gate that opens a queued car's form; holdFacts (sidepanel.js) reads the same
// state for the status line. Both are compiled from the panel's source here,
// with the same stubs, and checked on every scenario: the car is held exactly
// when the helper names a reason, and the first reason is the one named.
const panelSrc = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
function fnText(name) {
  const start = panelSrc.search(new RegExp(`(async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} is defined in sidepanel.js`);
  const end = panelSrc.indexOf('\n}\n', start);
  return panelSrc.slice(start, end + 2);
}

const VIN = 'AAA';
const PHOTO = 'https://img.example.test/a/1.jpg';
// a car the gate lets through; each scenario changes one thing
function scene(over = {}) {
  const s = {
    state: {
      vin: VIN, guardrails: { ok: true, problems: [] }, relist: null, vinCheck: { local: { ok: true, problems: [] } }, brandingRun: null,
      settings: { cropBranding: true }, branding: null, photoOriginals: [], map: { fields: [{ key: 'model', label: 'Model' }] },
    },
    listing: { photos: [PHOTO], missing: [], assumed: [], branded: '' },
    cap: { reached: false, count: 3 },
    servers: [], refused: new Set(),
  };
  if (over.state) Object.assign(s.state, over.state);
  if (over.listing) Object.assign(s.listing, over.listing);
  if (over.cap) s.cap = over.cap;
  if (over.servers) s.servers = over.servers;
  return s;
}
function compileBoth(s) {
  const scope = {
    state: s.state,
    currentListing: () => s.listing,
    dailyCap: () => s.cap,
    capCount: (c) => c.count,
    photoPatterns: () => s.servers,
    refusedPhotoServers: s.refused,
  };
  const names = Object.keys(scope);
  const vals = names.map((n) => scope[n]);
  const canAutoOpen = new Function(...names, `${fnText('canAutoOpen')}\nreturn canAutoOpen;`)(...vals);
  const holdFacts = new Function(...names, `${fnText('holdFacts')}\nreturn holdFacts;`)(...vals);
  return { canAutoOpen, holdFacts };
}

test('the gate and the explanation agree on every scenario: a car is held exactly when a reason is named, first to last', () => {
  const scenarios = {
    clear: scene(),
    guardrailsFailed: scene({ state: { guardrails: { ok: false, problems: [{ text: 'x' }] } } }),
    guardrailsNotChecked: scene({ state: { guardrails: null } }),
    takenDown: scene({ state: { relist: { takenDownAt: 'T' } } }),
    vinFailed: scene({ state: { vinCheck: { local: { ok: false, problems: [{ label: 'a', detail: 'b' }] } } } }),
    brandingRunning: scene({ state: { brandingRun: { vin: VIN } } }),
    cropped: scene({ state: { branding: { vin: VIN, photos: { [PHOTO]: { status: 'cropped' } } } } }),
    croppedSeen: scene({ state: { branding: { vin: VIN, photos: { [PHOTO]: { status: 'cropped' } } }, photoOriginals: [PHOTO] } }),
    missing: scene({ listing: { missing: ['model'] } }),
    missingTitleOnly: scene({ listing: { missing: ['titleStatus', 'cleanTitle'] } }),
    assumed: scene({ listing: { assumed: [{ key: 'fuelType', label: 'Fuel type', value: 'Hybrid', why: 'w' }] } }),
    defaultsOnly: scene({ listing: { assumed: [{ key: 'condition', label: 'Vehicle condition', value: 'Used', why: 'd' }] } }),
    branded: scene({ listing: { branded: 'rebuilt' } }),
    photoServer: scene({ servers: ['https://img.example.test/*'] }),
    capReached: scene({ cap: { reached: true, count: 10 } }),
  };
  for (const [name, s] of Object.entries(scenarios)) {
    const { canAutoOpen, holdFacts } = compileBoth(s);
    const reasons = queueHoldReasons(holdFacts());
    assert.equal(canAutoOpen(), reasons.length === 0, `${name}: the gate and the reasons disagree`);
  }
  // the first reason named is the one the checks reach first
  const { holdFacts } = compileBoth(scene({ state: { relist: { takenDownAt: 'T' }, brandingRun: { vin: VIN } }, cap: { reached: true, count: 2 } }));
  assert.deepEqual(queueHoldReasons(holdFacts()).map((r) => r.key), ['relist', 'branding', 'cap']);
});
