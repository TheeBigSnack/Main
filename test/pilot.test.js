import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  withPilotDefaults, hasPilotData, beginPost, notePostStep, endPost, noteFill, noteFlags, resolveFlag,
  summarizePilot, pilotText, pilotCsv, pilotFileName, updatePilot, recordFlags, median, secondsBetween, hoursBetween, pilotKey,
} from '../extension/src/pilot.js';
import { diffScans } from '../extension/src/rescan.js';
import { FORM_MAP } from '../extension/facebook/formMap.js';
import { snapshot, fixtures } from './helpers.js';

const RAM = fixtures.usedNormal.vin;
const WAGONEER = fixtures.certified.vin;
const LOT = [['usedNormal'], ['certified'], ['usedNoCarfax'], ['usedNoPhotos']];
const confirmed = (...vins) => ({ checked: vins, notFound: vins, error: null });
const T = (min, sec = 0) => new Date(Date.UTC(2026, 9, 26, 9, min, sec)).toISOString(); // Oct 26 2026 09:mm:ss
const labels = Object.fromEntries(FORM_MAP.fields.map((f) => [f.key, f.label]));

test('defaults: garbage in, an empty record out', () => {
  assert.deepEqual(withPilotDefaults(undefined), { version: 1, posts: [], fills: [], flags: [] });
  assert.deepEqual(withPilotDefaults({ posts: 'nope', fills: [null, 3], flags: [{ vin: 'X' }] }), { version: 1, posts: [], fills: [], flags: [{ vin: 'X' }] });
  assert.equal(hasPilotData(null), false);
  assert.equal(hasPilotData({ fills: [{}] }), true);
});

test('time helpers', () => {
  assert.equal(secondsBetween(T(0), T(1, 30)), 90);
  assert.equal(secondsBetween(T(1), T(0)), 0, 'never negative');
  assert.equal(secondsBetween('garbage', T(0)), null);
  assert.equal(hoursBetween(T(0), new Date(Date.UTC(2026, 9, 26, 12, 15)).toISOString()), 3.3);
  assert.equal(median([]), null);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test('a post attempt: start, review, form, fill, posted, with the seconds from the click on Post', () => {
  let p = beginPost(null, { vin: RAM.toLowerCase(), name: '2019 Ram 1500 Classic Express', salesperson: 'Roger', queue: false, at: T(0) });
  p = notePostStep(p, RAM, 'reviewedAt', T(0, 8));
  p = notePostStep(p, RAM, 'reviewedAt', T(0, 20)); // a re-render must not move the first time
  p = notePostStep(p, RAM, 'formOpenedAt', T(0, 25));
  p = notePostStep(p, RAM, 'filledAt', T(0, 40));
  p = notePostStep(p, RAM, 'filledAt', T(0, 50)); // Fill again: the latest fill counts
  p = notePostStep(p, RAM, 'bogus', T(0, 55));
  p = endPost(p, RAM, 'posted', { at: T(1, 5) });
  assert.equal(p.posts.length, 1);
  const a = p.posts[0];
  assert.equal(a.vin, RAM, 'VINs are kept upper-case');
  assert.equal(a.reviewedAt, T(0, 8));
  assert.equal(a.formOpenedAt, T(0, 25));
  assert.equal(a.filledAt, T(0, 50));
  assert.equal(a.bogus, undefined);
  assert.equal(a.outcome, 'posted');
  assert.equal(a.seconds, 65);
  // ended: later steps and a second end are ignored
  assert.deepEqual(notePostStep(p, RAM, 'filledAt', T(2)), p);
  assert.deepEqual(endPost(p, RAM, 'draft', { at: T(2) }), p);
});

test('a car picked up again while an attempt is open ends the old one as abandoned; a blocked car keeps its reason', () => {
  let p = beginPost(null, { vin: RAM, at: T(0) });
  p = beginPost(p, { vin: RAM, at: T(3), queue: true });
  assert.equal(p.posts.length, 2);
  assert.equal(p.posts[0].outcome, 'abandoned');
  assert.equal(p.posts[0].seconds, 180);
  assert.equal(p.posts[1].endedAt, undefined);
  p = endPost(p, RAM, 'blocked', { at: T(3, 4), reason: 'The website shows no price for this car right now, so it can\'t be posted.' });
  assert.equal(p.posts[1].outcome, 'blocked');
  assert.match(p.posts[1].reason, /no price/);
  assert.equal(endPost(p, RAM, 'whatever').posts.length, 2, 'nothing open: no change');
  const q = beginPost(p, { vin: WAGONEER, at: T(5) });
  assert.equal(endPost(q, WAGONEER, 'not-a-real-outcome', { at: T(6) }).posts[2].outcome, 'abandoned');
  assert.equal(beginPost(p, { vin: '', at: T(9) }).posts.length, 2, 'no VIN, no attempt');
});

test('a fill keeps field keys only: never the values, the description or the car', () => {
  const fill = {
    filled: [{ key: 'year', label: 'Year', value: '2019', shown: '2019' }, { key: 'description', label: 'Description', value: 'A long description with the VIN in it' }, { key: 'year', label: 'Year', value: '2019' }],
    partial: [{ key: 'location', label: 'Location', value: 'Waynesburg', note: 'pick the suggestion' }],
    blocked: [{ key: 'make', label: 'Make', value: 'Ram', reason: 'the box shows "Honda" after typing "Ram"', candidates: [{ tag: 'input' }] }],
    changedAfterFill: [{ key: 'year', label: 'Year', was: '2020', held: true }],
    preexisting: [{ key: 'model', label: 'Model', shown: 'Accord EX-L' }],
    skipped: [{ key: 'titleStatus', reason: 'not on this form' }],
  };
  const p = noteFill(null, { vin: RAM, fill, at: T(1), mapVersion: FORM_MAP.version });
  assert.deepEqual(p.fills, [{ at: T(1), vin: RAM, mapVersion: FORM_MAP.version, filled: ['year', 'description'], partial: ['location'], blocked: ['make'], changed: ['year'], preexisting: true }]);
  assert.doesNotMatch(JSON.stringify(p), /Honda|Accord|Waynesburg|long description|2019/);
  assert.deepEqual(noteFill(p, { vin: RAM, fill: null, at: T(2) }).fills[1], { at: T(2), vin: RAM, mapVersion: '', filled: [], partial: [], blocked: [], changed: [], preexisting: false });
});

test('a rescan flags your sold cars and price changes once, with the scan time, using the real diff shape', () => {
  const posted = { [RAM]: { name: '2019 Ram 1500 Classic Express', price: 27163 }, [WAGONEER]: { name: '2022 Jeep Wagoneer Series III', price: 38383 } };
  const day2 = snapshot([['certified', { extra_fields: { lightning: { pricing: { low: { label: 'Ron Lewis Real Price', value: '36883' } } } } }], ['usedNoCarfax'], ['usedNoPhotos']], undefined, T(0));
  const diff = diffScans(snapshot(LOT), day2, { posted, confirm: confirmed(RAM) });
  diff.takenAt = T(0);
  assert.equal(diff.takeDown.length, 1);
  assert.equal(diff.priceUpdates.length, 1);
  let p = noteFlags(null, diff);
  assert.equal(p.flags.length, 2);
  const td = p.flags.find((f) => f.kind === 'takeDown');
  const pr = p.flags.find((f) => f.kind === 'price');
  assert.deepEqual(td, { vin: RAM, kind: 'takeDown', name: '2019 Ram 1500 Classic Express', why: 'gone', flaggedAt: T(0) });
  assert.deepEqual(pr, { vin: WAGONEER, kind: 'price', name: '2022 Jeep Wagoneer Series III', from: 38383, to: 36883, flaggedAt: T(0) });
  // the same items three hours later: still one flag each, the first scan's time kept
  const again = { ...diff, takenAt: T(180) };
  p = noteFlags(p, again);
  assert.equal(p.flags.length, 2);
  assert.equal(p.flags[0].flaggedAt, T(0));
  // items that are not the salesperson's own never get a flag
  const theirs = { takeDown: [{ vin: 'X', yours: false, name: 'Someone else\'s' }], priceUpdates: [{ vin: 'Y', yours: false, from: 1, to: 2 }], takenAt: T(1) };
  assert.equal(noteFlags(p, theirs).flags.length, 2);
});

test('an open flag is cleared only by a complete, confirmed scan that no longer lists it; the price moving again is followed', () => {
  const base = { warnings: [], takeDown: [{ vin: RAM, yours: true, name: 'Ram', why: 'gone' }], priceUpdates: [{ vin: WAGONEER, yours: true, name: 'Wagoneer', from: 38383, to: 36883 }], takenAt: T(0) };
  let p = noteFlags(null, base);
  // a scan with a warning (incomplete, or the VIN check failed) keeps every open flag
  p = noteFlags(p, { warnings: ['Couldn\'t double-check missing cars'], takeDown: [], priceUpdates: [], takenAt: T(10) });
  assert.equal(p.flags.filter((f) => !f.doneAt).length, 2);
  p = noteFlags(p, { warnings: [], unreliable: true, takeDown: [], priceUpdates: [], takenAt: T(20) });
  assert.equal(p.flags.filter((f) => !f.doneAt).length, 2);
  // the website drops the price again: the open flag follows the new price
  p = noteFlags(p, { ...base, priceUpdates: [{ ...base.priceUpdates[0], to: 35883 }], takenAt: T(30) });
  assert.equal(p.flags.length, 2);
  assert.equal(p.flags[1].to, 35883);
  // a clean scan without the items: the website changed its mind, so the flags close as "cleared"
  p = noteFlags(p, { warnings: [], takeDown: [], priceUpdates: [], takenAt: T(60) });
  assert.deepEqual(p.flags.map((f) => [f.how, f.hours]), [['cleared', 1], ['cleared', 1]]);
  // and the item coming back later opens a new flag
  p = noteFlags(p, { ...base, takenAt: T(90) });
  assert.equal(p.flags.length, 4);
  assert.equal(noteFlags(p, null).flags.length, 4);
});

test('resolving a flag: seen on the listing, ticked off by hand, or the car unmarked; kind null closes both kinds', () => {
  const diff = { warnings: [], takeDown: [{ vin: RAM, yours: true, name: 'Ram', why: 'gone' }], priceUpdates: [{ vin: RAM, yours: true, name: 'Ram', from: 2, to: 1 }, { vin: WAGONEER, yours: true, name: 'Wagoneer', from: 38383, to: 36883 }], takenAt: T(0) };
  let p = noteFlags(null, diff);
  assert.equal(p.flags.length, 3);
  const same = resolveFlag(p, 'NOPE', null, { at: T(1) });
  assert.deepEqual(same, p, 'nothing open for that car: nothing changes');
  p = resolveFlag(p, WAGONEER.toLowerCase(), 'price', { at: T(30), how: 'detected' });
  assert.deepEqual(p.flags[2], { vin: WAGONEER, kind: 'price', name: 'Wagoneer', from: 38383, to: 36883, flaggedAt: T(0), doneAt: T(30), how: 'detected', hours: 0.5 });
  p = resolveFlag(p, RAM, null, { at: T(120), how: 'nonsense' });
  assert.deepEqual(p.flags.slice(0, 2).map((f) => [f.kind, f.how, f.hours]), [['takeDown', 'manual', 2], ['price', 'manual', 2]]);
  assert.deepEqual(resolveFlag(p, RAM, null, { at: T(200) }), p, 'already closed');
});

function samplePilot() {
  let p = null;
  const post = (vin, name, who, start, end, { queue = false, outcome = 'posted' } = {}) => {
    p = beginPost(p, { vin, name, salesperson: who, queue, at: start });
    p = notePostStep(p, vin, 'reviewedAt', start);
    p = endPost(p, vin, outcome, { at: end });
  };
  post('VIN00001', 'Car 1', 'Roger', T(0), T(0, 40));
  post('VIN00002', 'Car 2', 'Roger', T(1), T(1, 50), { queue: true });
  post('VIN00003', 'Car 3', 'Dana', T(2), T(3, 30));
  post('VIN00004', 'Car 4', 'Dana', T(4), T(4, 20), { outcome: 'draft' });
  post('VIN00005', 'Car 5', 'Roger', T(5), T(5, 10), { outcome: 'not-posted' });
  p = beginPost(p, { vin: 'VIN00006', name: 'Car 6', salesperson: 'Roger', at: T(6) }); // still open
  const ok = (keys) => keys.map((key) => ({ key }));
  p = noteFill(p, { vin: 'VIN00001', at: T(0, 30), fill: { filled: ok(['year', 'make', 'model', 'price']), partial: [], blocked: [] } });
  p = noteFill(p, { vin: 'VIN00002', at: T(1, 30), fill: { filled: ok(['year', 'model', 'price']), partial: ok(['location']), blocked: ok(['make']), changedAfterFill: ok(['year']), preexisting: [{ key: 'model' }] } });
  p = noteFill(p, { vin: 'VIN00003', at: T(2, 30), fill: { filled: ok(['year', 'model', 'price', 'location']), partial: [], blocked: ok(['make']) } });
  const diff = { warnings: [], takeDown: [{ vin: 'VIN00001', yours: true, name: 'Car 1', why: 'gone' }, { vin: 'VIN00002', yours: true, name: 'Car 2', why: 'sale-pending' }], priceUpdates: [{ vin: 'VIN00003', yours: true, name: 'Car 3', from: 20000, to: 19000 }], takenAt: T(10) };
  p = noteFlags(p, diff);
  p = resolveFlag(p, 'VIN00001', 'takeDown', { at: T(70), how: 'detected' }); // 1 h
  p = resolveFlag(p, 'VIN00003', 'price', { at: T(190), how: 'manual' }); // 3 h
  return p;
}

test('the summary: median time per post, per salesperson, per-field failure rates, sold-car hours', () => {
  const s = summarizePilot(samplePilot(), { now: T(310), labels });
  assert.deepEqual(s.posts, {
    started: 6, inProgress: 1, posted: 3, drafts: 1, skipped: 0, blocked: 0, notPosted: 1, abandoned: 0, queued: 1,
    medianSeconds: 50, fastestSeconds: 40, slowestSeconds: 90, under60: 2, under60Share: 67, firstPostAt: T(0, 40), lastPostAt: T(3, 30),
  });
  assert.deepEqual(s.salespeople, [{ name: 'Roger', posted: 2, medianSeconds: 45 }, { name: 'Dana', posted: 1, medianSeconds: 90 }]);
  assert.deepEqual(s.fills, { attempts: 3, clean: 1, withDraft: 1 });
  assert.deepEqual(s.fields[0], { key: 'make', label: 'Make', attempts: 3, filled: 1, partial: 0, blocked: 2, changed: 0, failures: 2, failureRate: 67 });
  assert.deepEqual(s.fields[1], { key: 'location', label: 'Location', attempts: 2, filled: 1, partial: 1, blocked: 0, changed: 0, failures: 1, failureRate: 50 });
  assert.deepEqual(s.fields.slice(2).map((f) => f.key), ['year', 'model', 'price'], 'clean fields follow in the form map\'s order');
  assert.equal(s.fields.find((f) => f.key === 'year').changed, 1);
  assert.equal(s.topFailure.key, 'make');
  assert.deepEqual(s.takeDowns, { flagged: 2, done: 1, detected: 1, cleared: 0, open: 1, medianHours: 1, longestHours: 1, openItems: [{ vin: 'VIN00002', name: 'Car 2', flaggedAt: T(10), hoursOpen: 5 }] });
  assert.deepEqual(s.priceUpdates, { flagged: 1, done: 1, detected: 0, cleared: 0, open: 0, medianHours: 3, longestHours: 3, openItems: [] });
  const empty = summarizePilot(null, { labels });
  assert.equal(empty.posts.medianSeconds, null);
  assert.equal(empty.topFailure, null);
  assert.equal(empty.takeDowns.medianHours, null);
});

test('the text summary and the CSV say the same numbers; the CSV quotes what needs quoting and holds no descriptions', () => {
  const p = samplePilot();
  const text = pilotText(summarizePilot(p, { now: T(310), labels }), { site: 'Ron Lewis CDJR Waynesburg' });
  assert.match(text, /^Lot Sync pilot numbers: Ron Lewis CDJR Waynesburg\n/);
  assert.match(text, /3 posted \(1 in a queue\), 1 saved as drafts, 1 not posted/);
  assert.match(text, /median 50 s, fastest 40 s, slowest 90 s, 67% within 60 s/);
  assert.match(text, /Roger: 2 posted, median 45 s/);
  assert.match(text, /Make: 2 of 3 not filled \(67%\)/);
  assert.match(text, /Location: 1 of 2 not filled \(50%\)/);
  assert.match(text, /Sold cars to take down: 2 flagged, 1 done \(1 seen on the listing\), 1 still open, 0 cleared by the website; median 1 h/);
  assert.match(text, /open: Car 2 \(5 h\)/);
  assert.match(text, /Price changes: 1 flagged, 1 done \(0 seen on the listing\), 0 still open/);
  const clean = pilotText(summarizePilot(null, { labels }));
  assert.match(clean, /every field filled every time/);
  assert.match(clean, /median —, fastest —/);

  const withComma = endPost(beginPost(p, { vin: 'VIN00007', name: 'Car "7", the odd one', salesperson: 'Lee, Jr.', at: T(20) }), 'VIN00007', 'blocked', { at: T(21), reason: 'no price' });
  const csv = pilotCsv(withComma, { now: T(310), labels, site: 'Test' });
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'Lot Sync pilot numbers,Test,exported ' + T(310));
  assert.ok(lines.includes('Posted,3'));
  assert.ok(lines.includes('Median seconds per post,50'));
  assert.ok(lines.includes('Sold cars still listed,1'));
  assert.ok(lines.includes('Roger,2,45'));
  assert.ok(lines.includes("Field,Attempts,Filled,Needed a click,Couldn't fill,Changed by the form afterwards,Failure rate %"));
  assert.ok(lines.includes('Make,3,1,0,2,0,67'));
  assert.ok(lines.includes(`${T(0)},Roger,Car 1,VIN00001,posted,40,no,0,,,`));
  assert.ok(lines.includes(`${T(6)},Roger,Car 6,VIN00006,in progress,,no,,,,`));
  assert.ok(lines.includes(`${T(20)},"Lee, Jr.","Car ""7"", the odd one",VIN00007,blocked,60,no,,,,no price`));
  assert.ok(lines.includes(`${T(10)},sold / take down,Car 1,VIN00001,${T(70)},detected,1,,`));
  assert.ok(lines.includes(`${T(10)},sold / take down,Car 2,VIN00002,,open,5,,`));
  assert.ok(lines.includes(`${T(10)},price change,Car 3,VIN00003,${T(190)},manual,3,20000,19000`));
  assert.ok(csv.endsWith('\r\n'));
  assert.equal(pilotFileName(T(0)), 'lot-sync-pilot-2026-10-26.csv');
});

test('the storage helper reads, changes and writes one key; a failure is the caller\'s to catch', async () => {
  const store = {};
  const storage = { get: async (key) => ({ [key]: store[key] }), set: async (obj) => Object.assign(store, obj) };
  const origin = 'https://example-dealer.test';
  const after = await updatePilot(origin, (p) => beginPost(p, { vin: RAM, at: T(0) }), storage);
  assert.equal(after.posts.length, 1);
  assert.equal(store[pilotKey(origin)].posts[0].vin, RAM);
  const diff = { warnings: [], takeDown: [{ vin: RAM, yours: true, name: 'Ram', why: 'gone' }], priceUpdates: [], takenAt: T(5) };
  const flagged = await recordFlags(origin, diff, T(5), storage);
  assert.equal(flagged.flags.length, 1);
  assert.equal(store[pilotKey(origin)].flags[0].flaggedAt, T(5));
  const broken = { get: async () => { throw new Error('storage is gone'); }, set: async () => {} };
  await assert.rejects(updatePilot(origin, (p) => p, broken), /storage is gone/);
});

test('the lists stay bounded', () => {
  let p = null;
  for (let i = 0; i < 2005; i += 1) p = endPost(beginPost(p, { vin: `V${i}`, at: T(0) }), `V${i}`, 'posted', { at: T(1) });
  assert.equal(p.posts.length, 2000);
  assert.equal(p.posts[0].vin, 'V5', 'the oldest go first');
});
