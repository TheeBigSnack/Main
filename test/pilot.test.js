import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  withPilotDefaults, hasPilotData, beginPost, notePostStep, endPost, noteFill, noteFlags, resolveFlag,
  summarizePilot, pilotText, pilotCsv, pilotFileName, updatePilot, recordFlags, median, secondsBetween, hoursBetween, pilotKey,
  DEFINITIONS, fmtLocal, PILOT_RETENTION_DAYS,
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
  assert.deepEqual(p.fills, [{ at: T(1), vin: RAM, mapVersion: FORM_MAP.version, version: '', filled: ['year', 'description'], partial: ['location'], blocked: ['make'], changed: ['year'], preexisting: true }]);
  assert.doesNotMatch(JSON.stringify(p), /Honda|Accord|Waynesburg|long description|2019/);
  assert.deepEqual(noteFill(p, { vin: RAM, fill: null, at: T(2) }).fills[1], { at: T(2), vin: RAM, mapVersion: '', version: '', filled: [], partial: [], blocked: [], changed: [], preexisting: false });
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

test('a posted car the website keeps showing as sale-pending keeps its take-down flag open scan after scan, never "cleared"', () => {
  const posted = { [RAM]: { name: '2019 Ram 1500 Classic Express', price: 27163 } };
  const pending = (at) => snapshot([['usedNormal', { status: 'pend-sale' }], ['certified'], ['usedNoCarfax'], ['usedNoPhotos']], undefined, at);
  let prev = snapshot(LOT);
  let p = null;
  for (const at of [T(0), T(180), T(360)]) {
    const now = pending(at);
    const diff = diffScans(prev, now, { posted, confirm: confirmed() });
    diff.takenAt = at;
    p = noteFlags(p, diff);
    prev = now; // the scan's snapshot is saved, as background.js and the popup save it
  }
  assert.deepEqual(p.flags.map((f) => [f.vin, f.kind, f.why, f.flaggedAt, f.doneAt]), [[RAM, 'takeDown', 'sale-pending', T(0), undefined]]);
  assert.equal(summarizePilot(p, { now: T(360), labels }).takeDowns.cleared, 0);
  // Taken down closes it with the hours from the first scan that flagged it
  p = resolveFlag(p, RAM, null, { at: T(420) });
  assert.deepEqual(p.flags.map((f) => [f.how, f.hours]), [['manual', 7]]);
});

test('a sold car\'s take-down flag stays open while a later scan could not check its page, and is never "cleared" by that', () => {
  const posted = { [RAM]: { name: '2019 Ram 1500 Classic Express', price: 27163 } };
  const gone = (at) => snapshot([['certified'], ['usedNoCarfax'], ['usedNoPhotos']], undefined, at);
  const day2 = gone(T(0));
  const flagged = diffScans(snapshot(LOT), day2, { posted, confirm: confirmed(RAM) });
  flagged.takenAt = T(0);
  let p = noteFlags(null, flagged);
  assert.deepEqual(p.flags.map((f) => [f.vin, f.kind, f.why]), [[RAM, 'takeDown', 'gone']]);
  // the next scans: its page answers 500, so this car alone is unchecked; the scan is otherwise complete
  let prev = day2;
  for (const at of [T(180), T(360)]) {
    const now = gone(at);
    const diff = diffScans(prev, now, { posted, confirm: { checked: [], notFound: [], error: null, unchecked: { [RAM]: 'its page gave HTTP 500' } } });
    diff.takenAt = at;
    assert.deepEqual([diff.warnings, diff.takeDown, diff.needsALook.map((n) => [n.vin, n.yours])], [[], [], [[RAM, true]]]);
    p = noteFlags(p, diff);
    prev = now;
  }
  assert.deepEqual(p.flags.map((f) => [f.vin, f.kind, f.flaggedAt, f.doneAt]), [[RAM, 'takeDown', T(0), undefined]]);
  // Taken down closes it with the hours from the scan that flagged it
  p = resolveFlag(p, RAM, null, { at: T(420) });
  assert.deepEqual(p.flags.map((f) => [f.how, f.hours]), [['manual', 7]]);
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
  assert.match(text, /^Lot Current pilot numbers: Ron Lewis CDJR Waynesburg\n/);
  assert.match(text, /3 posted \(1 in a queue\), 1 saved as drafts, 1 not posted/);
  assert.match(text, /median 50 s, fastest 40 s, slowest 90 s, 67% within 60 s/);
  assert.match(text, /Roger: 2 posted, median 45 s/);
  assert.match(text, /Make: 2 of 3 not filled \(67%\)/);
  assert.match(text, /Location: 1 of 2 not filled \(50%\)/);
  assert.match(text, /Sold cars to take down: 2 flagged, 1 done \(1 seen on the listing\), 1 still open, 0 cleared by the website; median 1 h/);
  assert.match(text, /open: Car 2 \(5 h\)/);
  assert.match(text, /Price changes: 1 flagged, 1 done \(0 seen on the listing\), 0 still open/);
  assert.ok(text.endsWith('\n\n' + DEFINITIONS.join('\n')), 'the definitions close the summary');
  const clean = pilotText(summarizePilot(null, { labels }));
  assert.match(clean, /every field filled every time/);
  assert.match(clean, /median —, fastest —/);

  // the CSV shows every time in the given zone (Oct 26 2026, New York: UTC-4); storage keeps ISO
  const withComma = endPost(beginPost(p, { vin: 'VIN00007', name: 'Car "7", the odd one', salesperson: 'Lee, Jr.', at: T(20) }), 'VIN00007', 'blocked', { at: T(21), reason: 'no price' });
  const csv = pilotCsv(withComma, { now: T(310), labels, site: 'Test', origin: 'https://example-dealer.test', dealer: 'Ron Lewis CDJR Waynesburg', salesperson: 'Roger', timeZone: 'America/New_York', version: '0.4.0' });
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'Lot Current pilot numbers,Test,exported 2026-10-26 10:10');
  assert.equal(lines[1], 'Dealership,Ron Lewis CDJR Waynesburg');
  assert.equal(lines[2], 'Website,https://example-dealer.test');
  assert.equal(lines[3], 'Salesperson (from Settings),Roger');
  assert.equal(lines[4], 'Time zone,America/New_York');
  assert.equal(lines[5], 'Lot Current version,0.4.0');
  assert.equal(lines[6], '');
  assert.ok(lines.includes('Posted,3'));
  assert.ok(lines.includes('Median seconds per post,50'));
  assert.ok(lines.includes('Sold cars still listed,1'));
  assert.ok(lines.includes('Roger,2,45'));
  assert.ok(lines.includes('Field,Attempts,Filled,Needed a click,"Couldn\'t fill",Changed by the form afterwards,Failure rate %'), 'an apostrophe puts the cell in quotes');
  assert.ok(lines.includes('Make,3,1,0,2,0,67'));
  assert.ok(lines.includes('2026-10-26 05:00,Roger,Car 1,VIN00001,posted,40,no,0,,,'));
  assert.ok(lines.includes('2026-10-26 05:06,Roger,Car 6,VIN00006,in progress,,no,,,,'));
  assert.ok(lines.includes('2026-10-26 05:20,"Lee, Jr.","Car ""7"", the odd one",VIN00007,blocked,60,no,,,,no price'));
  assert.ok(lines.includes('2026-10-26 05:10,sold / take down,Car 1,VIN00001,2026-10-26 06:10,detected,1,,'));
  assert.ok(lines.includes('2026-10-26 05:10,sold / take down,Car 2,VIN00002,,open,5,,'));
  assert.ok(lines.includes('2026-10-26 05:10,price change,Car 3,VIN00003,2026-10-26 08:10,manual,3,20000,19000'));
  assert.doesNotMatch(csv, /\d\dT\d\d:\d\d/, 'no ISO timestamps reach the spreadsheet');
  // a name that starts like a formula is written as text, never run by the spreadsheet; numbers stay numbers
  const hostile = endPost(beginPost(withComma, { vin: 'VIN00008', name: '-Car', salesperson: '=HYPERLINK("x")', at: T(22) }), 'VIN00008', 'posted', { at: T(23) });
  const hostileLines = pilotCsv(hostile, { now: T(310), labels, timeZone: 'America/New_York' }).split('\r\n');
  assert.ok(hostileLines.includes(`2026-10-26 05:22,"'=HYPERLINK(""x"")","'-Car",VIN00008,posted,60,no,,,,`), hostileLines.filter((l) => /VIN00008/.test(l)).join(' | '));
  assert.ok(hostileLines.includes(`"'=HYPERLINK(""x"")",1,60`), 'the salesperson table too');
  assert.ok(hostileLines.includes('2026-10-26 05:10,price change,Car 3,VIN00003,2026-10-26 08:10,manual,3,20000,19000'), 'numbers are not prefixed');
  assert.ok(csv.endsWith('\r\n'));
  assert.equal(withComma.posts[0].startedAt, T(0), 'storage keeps ISO');
  // the same export in another zone, and the local zone when none is given
  assert.equal(pilotCsv(withComma, { now: T(310), labels, timeZone: 'Asia/Tokyo' }).split('\r\n')[0], 'Lot Current pilot numbers,,exported 2026-10-26 23:10');
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert.equal(pilotCsv(withComma, { now: T(310), labels }).split('\r\n')[4], `Time zone,${here}`);
  assert.equal(pilotCsv(withComma, { now: T(310), labels, timeZone: 'Not/AZone' }).split('\r\n')[4], `Time zone,${here}`, 'a zone Intl does not know falls back to this computer\'s instead of failing the download');
  assert.equal(fmtLocal(T(0), 'America/New_York'), '2026-10-26 05:00');
  assert.equal(fmtLocal(undefined, 'UTC'), '');
});

test('the CSV summary adds up (flagged = done + still open + cleared by the website) and carries the definitions', () => {
  let p = samplePilot();
  // a clean scan at T(200): Car 2 still gone, Car 4's price down; at T(260) the price is back, so the website cleared that flag
  const car2 = { vin: 'VIN00002', yours: true, name: 'Car 2', why: 'gone' };
  p = noteFlags(p, { warnings: [], takeDown: [car2], priceUpdates: [{ vin: 'VIN00004', yours: true, name: 'Car 4', from: 21000, to: 20500 }], takenAt: T(200) });
  p = noteFlags(p, { warnings: [], takeDown: [car2], priceUpdates: [], takenAt: T(260) });
  const lines = pilotCsv(p, { now: T(310), labels, timeZone: 'UTC' }).split('\r\n');
  const value = (label) => {
    const line = lines.find((l) => l.startsWith(label + ','));
    assert.ok(line, `a "${label}" row`);
    return Number(line.slice(label.length + 1));
  };
  assert.deepEqual([value('Sold cars flagged'), value('Sold cars taken down'), value('Sold cars still listed'), value('Sold cars cleared by the website')], [2, 1, 1, 0]);
  assert.deepEqual([value('Price changes flagged'), value('Price changes updated'), value('Price changes still open'), value('Price changes cleared by the website')], [2, 1, 0, 1]);
  assert.equal(value('Sold cars flagged'), value('Sold cars taken down') + value('Sold cars still listed') + value('Sold cars cleared by the website'));
  assert.equal(value('Price changes flagged'), value('Price changes updated') + value('Price changes still open') + value('Price changes cleared by the website'));
  assert.equal(value('Median hours from the flagging scan until taken down'), 1);
  assert.equal(value('Median hours from the flagging scan until updated'), 3, 'a cleared flag is not in the median');
  assert.ok(!lines.some((l) => l.startsWith('Median hours until')), 'the old, vaguer labels are gone');
  // the Definitions block: a header row, then one row per sentence, right after the summary
  const at = lines.indexOf('Definitions');
  assert.ok(at > 0);
  assert.equal(lines[at - 1], '');
  assert.equal(lines[at - 2], `Median hours from the flagging scan until updated,3`);
  const unquote = (l) => (l.startsWith('"') ? l.slice(1, -1).replace(/""/g, '"') : l);
  assert.deepEqual(lines.slice(at + 1, at + 1 + DEFINITIONS.length).map(unquote), [...DEFINITIONS]);
  assert.equal(lines[at + 1 + DEFINITIONS.length], '');
  assert.equal(DEFINITIONS.length, 5);
  for (const d of DEFINITIONS) assert.match(d, /^[A-Z].*\.$/, 'one plain sentence each');
  assert.ok(lines.includes('2026-10-26 12:20,price change,Car 4,VIN00004,2026-10-26 13:20,cleared,1,21000,20500'));
});

test('the file name says whose numbers they are: site, salesperson and the local day', () => {
  assert.equal(pilotFileName(T(0), { site: 'Ron Lewis CDJR Waynesburg', salesperson: 'Lee, Jr.', timeZone: 'America/New_York' }), 'lot-current-pilot-ron-lewis-cdjr-waynesburg-lee-jr-2026-10-26.csv');
  assert.equal(pilotFileName(T(0), { site: '  --Dealer #1!  ', salesperson: 'José Álvarez', timeZone: 'UTC' }), 'lot-current-pilot-dealer-1-jose-alvarez-2026-10-26.csv');
  assert.equal(pilotFileName(T(0), { timeZone: 'UTC' }), 'lot-current-pilot-unnamed-unnamed-2026-10-26.csv');
  // the day is the local one, not UTC's: 02:30 UTC is still the evening before in New York and already the next morning in Tokyo
  const smallHours = new Date(Date.UTC(2026, 9, 26, 2, 30)).toISOString();
  assert.equal(pilotFileName(smallHours, { site: 'Test', salesperson: 'Roger', timeZone: 'America/New_York' }), 'lot-current-pilot-test-roger-2026-10-25.csv');
  assert.equal(pilotFileName(smallHours, { site: 'Test', salesperson: 'Roger', timeZone: 'Asia/Tokyo' }), 'lot-current-pilot-test-roger-2026-10-26.csv');
  assert.match(pilotFileName(), /^lot-current-pilot-unnamed-unnamed-\d{4}-\d{2}-\d{2}\.csv$/, 'no arguments: today, this computer\'s zone');
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

// chrome.storage answers a tick later, in the order the calls were made: two
// gets sent before either set both see the same old record, and the second
// set then wipes out the first. That is the lost update updatePilot's lock
// exists for (a background rescan recording a flag while the side panel
// records a post). src/storage.js provides the lock: a Web Lock in the
// browser, a promise-chain mutex here.
function tickStorage() {
  const store = {};
  const later = (fn) => new Promise((resolve) => setTimeout(() => resolve(fn()), 0));
  return { store, get: (key) => later(() => ({ [key]: store[key] })), set: (obj) => later(() => { Object.assign(store, obj); }) };
}

test('two callers at once: a lock that does nothing loses one write; the fallback mutex and an injected storage.lock keep both', async () => {
  const origin = 'https://example-dealer.test';
  const key = pilotKey(origin);
  const diff = { warnings: [], takeDown: [{ vin: RAM, yours: true, name: 'Ram', why: 'gone' }], priceUpdates: [], takenAt: T(5) };
  const post = (storage) => updatePilot(origin, (p) => beginPost(p, { vin: 'A', at: T(0) }), storage);

  const bare = { ...tickStorage(), lock: (name, fn) => fn() }; // a lock that holds nothing: the hazard itself
  await Promise.all([post(bare), recordFlags(origin, diff, T(5), bare)]);
  const lost = bare.store[key];
  assert.equal(lost.posts.length + lost.flags.length, 1, 'unlocked, the second set overwrites the first: one of the two is gone');
  assert.equal(lost.posts.length, 0, 'the post (recorded first) is the one lost');

  const fallback = tickStorage(); // no lock of its own and no Web Locks under node: updateKey's own mutex
  await Promise.all([post(fallback), recordFlags(origin, diff, T(5), fallback)]);
  assert.equal(fallback.store[key].posts.length, 1);
  assert.equal(fallback.store[key].flags.length, 1);

  const locked = tickStorage();
  const chains = new Map(); // a promise-chain mutex per name, the shape navigator.locks.request has
  const names = [];
  locked.lock = (name, fn) => {
    names.push(name);
    const run = (chains.get(name) || Promise.resolve()).then(fn);
    chains.set(name, run.catch(() => null));
    return run;
  };
  const [afterPost, afterFlags] = await Promise.all([post(locked), recordFlags(origin, diff, T(5), locked)]);
  assert.deepEqual(names, [key, key], 'locked on the pilot key');
  assert.equal(locked.store[key].posts.length, 1);
  assert.equal(locked.store[key].flags.length, 1);
  assert.deepEqual([afterPost.posts.length, afterPost.flags.length], [1, 0]);
  assert.deepEqual([afterFlags.posts.length, afterFlags.flags.length], [1, 1], 'the second caller read the first one\'s write');
  const failing = { ...tickStorage(), lock: locked.lock, get: async () => { throw new Error('storage is gone'); } };
  await assert.rejects(updatePilot(origin, (p) => p, failing), /storage is gone/, 'a failure still reaches the caller through the lock');
});

test('in the browser the lock is a Web Lock on the pilot key', async () => {
  const origin = 'https://example-dealer.test';
  const requested = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (name, fn) => { requested.push(name); return fn(); } } } });
  try {
    const storage = tickStorage();
    const after = await updatePilot(origin, (p) => beginPost(p, { vin: 'A', at: T(0) }), storage);
    assert.deepEqual(requested, [pilotKey(origin)]);
    assert.equal(after.posts.length, 1);
    assert.equal(storage.store[pilotKey(origin)].posts.length, 1);
    const own = { ...tickStorage(), lock: async (name, fn) => fn() };
    await updatePilot(origin, (p) => p, own);
    assert.equal(requested.length, 1, 'an injected storage.lock is used before navigator.locks');
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original); else delete globalThis.navigator;
  }
});

test('the lists stay bounded at 500', () => {
  let p = null;
  for (let i = 0; i < 505; i += 1) p = endPost(beginPost(p, { vin: `V${i}`, at: T(0) }), `V${i}`, 'posted', { at: T(1) });
  assert.equal(p.posts.length, 500);
  assert.equal(p.posts[0].vin, 'V5', 'the oldest go first');
  // open flags are never dropped for the count: 505 open, then 5 closed and 2 new ones
  const many = { warnings: [], takeDown: [], priceUpdates: [], takenAt: T(0) };
  for (let i = 0; i < 505; i += 1) many.takeDown.push({ vin: `F${i}`, yours: true, name: `Car ${i}` });
  let q = noteFlags(null, many);
  assert.equal(q.flags.length, 505);
  for (let i = 0; i < 5; i += 1) q = resolveFlag(q, `F${i}`, 'takeDown', { at: T(1) });
  // the next scan no longer lists the five handled cars, and brings two new ones
  q = noteFlags(q, { ...many, takeDown: [...many.takeDown.slice(5), { vin: 'NEW1', yours: true, name: 'New 1' }, { vin: 'NEW2', yours: true, name: 'New 2' }], takenAt: T(2) });
  assert.equal(q.flags.length, 502, 'the five closed flags went, the open ones stayed');
  assert.ok(q.flags.every((f) => !f.doneAt));
});

test('posts and fills older than 90 days go when the next one is recorded; open flags stay whatever their age, closed ones go', () => {
  assert.equal(PILOT_RETENTION_DAYS, 90);
  const DAY = 24 * 60 * 60 * 1000;
  const old = new Date(Date.UTC(2026, 5, 1, 9, 0)).toISOString(); // June 1
  const later = (days) => new Date(Date.parse(old) + days * DAY).toISOString();
  let p = endPost(beginPost(null, { vin: 'OLD', at: old }), 'OLD', 'posted', { at: old });
  p = noteFill(p, { vin: 'OLD', at: old, fill: {} });
  p = noteFlags(p, { warnings: [], takeDown: [{ vin: 'OPEN', yours: true, name: 'Open' }, { vin: 'DONE', yours: true, name: 'Done' }], priceUpdates: [], takenAt: old });
  p = resolveFlag(p, 'DONE', 'takeDown', { at: old, how: 'manual' });
  // 89 days on: everything is still there
  let q = noteFill(beginPost(p, { vin: 'NEW', at: later(89) }), { vin: 'NEW', at: later(89), fill: {} });
  assert.deepEqual(q.posts.map((a) => a.vin), ['OLD', 'NEW']);
  assert.deepEqual(q.fills.map((f) => f.vin), ['OLD', 'NEW']);
  // 91 days on: the old post and fill go; the closed flag goes, the open one stays
  q = beginPost(p, { vin: 'NEW', at: later(91) });
  assert.deepEqual(q.posts.map((a) => a.vin), ['NEW']);
  q = noteFill(q, { vin: 'NEW', at: later(91), fill: {} });
  assert.deepEqual(q.fills.map((f) => f.vin), ['NEW']);
  q = noteFlags(q, { warnings: ['incomplete'], takeDown: [], priceUpdates: [], takenAt: later(91) }); // a scan with a warning keeps open flags open
  assert.deepEqual(q.flags.map((f) => [f.vin, Boolean(f.doneAt)]), [['OPEN', false]]);
  // a flag closed recently stays even though it was flagged long ago: its age counts from when it was done
  let r = resolveFlag(p, 'OPEN', 'takeDown', { at: later(100), how: 'detected' });
  r = noteFlags(r, { warnings: [], takeDown: [], priceUpdates: [], takenAt: later(101) });
  assert.deepEqual(r.flags.map((f) => f.vin), ['OPEN']);
  // a stamp that cannot be read never causes a drop
  const odd = { version: 1, posts: [{ vin: 'X', startedAt: 'garbage' }], fills: [], flags: [] };
  assert.equal(beginPost(odd, { vin: 'Y', at: later(200) }).posts.length, 2);
});
