// Pilot numbers (Milestone 3): what the pilot agreement lets Lot Current record,
// kept per dealer website in this browser only:
//   - time per post: from the click on Post to "It's posted", including the
//     salesperson's review and their own Publish click;
//   - which form fields could not be filled, per fill attempt (field keys
//     only: never the values, never the description);
//   - how long a sold car or a price change stayed on the salesperson's
//     listing: from the scan that flagged it to the moment Lot Current saw the
//     change on the listing or the person ticked the item off.
// No customer or buyer data, and nothing from Facebook beyond what the posted
// registry already holds. Everything here is pure; updatePilot at the end is
// the one storage helper the popup, the side panel and the worker share, and
// it runs under the key's lock (src/storage.js) so those three never
// overwrite each other's writes. Times are stored as ISO; only the CSV and
// the file name show them in local time.

import { pilotKey } from './storageKeys.js';
import { updateKey } from './storage.js';

export { pilotKey };
export const PILOT_VERSION = 1;
export const POST_OUTCOMES = Object.freeze(['posted', 'draft', 'skipped', 'blocked', 'not-posted', 'abandoned']);
export const FLAG_KINDS = Object.freeze(['takeDown', 'price']);
export const FLAG_HOWS = Object.freeze(['detected', 'manual', 'cleared']);
export const POST_STEPS = Object.freeze(['reviewedAt', 'formOpenedAt', 'filledAt']);
// Each list keeps this many entries at most, and nothing older than the
// retention window (the pilot agreement's numbers are weekly; the CSV is
// how they leave the browser, so an old record is one that was exported
// long ago). Open to-do flags stay whatever their age.
export const PILOT_RETENTION_DAYS = 90;
const MAX_ENTRIES = 500; // per list; the oldest are dropped beyond that
const RETENTION_MS = PILOT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

const nowIso = () => new Date().toISOString();
const ms = (iso) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

export function secondsBetween(fromIso, toIso) {
  const a = ms(fromIso);
  const b = ms(toIso);
  return a === null || b === null ? null : Math.max(0, Math.round((b - a) / 1000));
}

export function hoursBetween(fromIso, toIso) {
  const s = secondsBetween(fromIso, toIso);
  return s === null ? null : Math.round(s / 360) / 10;
}

export function withPilotDefaults(pilot) {
  const p = pilot && typeof pilot === 'object' ? pilot : {};
  const list = (x) => (Array.isArray(x) ? x.filter((e) => e && typeof e === 'object') : []);
  return { version: PILOT_VERSION, posts: list(p.posts), fills: list(p.fills), flags: list(p.flags) };
}

export const hasPilotData = (pilot) => {
  const p = withPilotDefaults(pilot);
  return p.posts.length > 0 || p.fills.length > 0 || p.flags.length > 0;
};

// The newest MAX_ENTRIES entries, none older than the retention window as of
// `now` (the time of the change being recorded). `stamp` reads an entry's
// time; `keep` names entries that stay whatever their age or the count (open
// flags). An entry whose stamp cannot be read counts as new. The list is
// oldest first, so the oldest droppable entries go first.
function trim(list, now, stamp, keep = () => false) {
  const at = ms(now);
  const recent = at === null ? list : list.filter((e) => keep(e) || (ms(stamp(e)) ?? at) >= at - RETENTION_MS);
  if (recent.length <= MAX_ENTRIES) return recent;
  let excess = recent.length - MAX_ENTRIES;
  return recent.filter((e) => {
    if (excess > 0 && !keep(e)) { excess -= 1; return false; }
    return true;
  });
}
const clean = (s, max = 120) => String(s ?? '').slice(0, max);

function openPostIndex(posts, vin) {
  for (let i = posts.length - 1; i >= 0; i--) if (posts[i].vin === vin && !posts[i].endedAt) return i;
  return -1;
}

// ---------- posts ----------

// A post attempt starts when the side panel picks the car up. Any attempt for
// the same car still open (the panel was closed on it) ends as abandoned.
export function beginPost(pilot, { vin, name = '', salesperson = '', queue = false, at = nowIso() }) {
  const p = withPilotDefaults(pilot);
  const key = String(vin || '').toUpperCase();
  if (!key) return p;
  const posts = p.posts.map((a) => (a.vin === key && !a.endedAt ? { ...a, endedAt: at, outcome: 'abandoned', seconds: secondsBetween(a.startedAt, at) } : a));
  posts.push({ vin: key, name: clean(name, 80), salesperson: clean(salesperson, 60), queue: Boolean(queue), startedAt: at });
  return { ...p, posts: trim(posts, at, (a) => a.startedAt) };
}

// reviewedAt and formOpenedAt keep their first time; filledAt keeps the latest
// (Fill again counts as a new fill).
export function notePostStep(pilot, vin, step, at = nowIso()) {
  const p = withPilotDefaults(pilot);
  if (!POST_STEPS.includes(step)) return p;
  const i = openPostIndex(p.posts, String(vin || '').toUpperCase());
  if (i < 0) return p;
  const a = p.posts[i];
  if (a[step] && step !== 'filledAt') return p;
  const posts = p.posts.slice();
  posts[i] = { ...a, [step]: at };
  return { ...p, posts };
}

export function endPost(pilot, vin, outcome, { at = nowIso(), reason } = {}) {
  const p = withPilotDefaults(pilot);
  const i = openPostIndex(p.posts, String(vin || '').toUpperCase());
  if (i < 0) return p;
  const a = p.posts[i];
  const posts = p.posts.slice();
  posts[i] = { ...a, endedAt: at, outcome: POST_OUTCOMES.includes(outcome) ? outcome : 'abandoned', seconds: secondsBetween(a.startedAt, at) };
  if (reason) posts[i].reason = clean(reason);
  return { ...p, posts };
}

// ---------- fills ----------

// One entry per fill of the Marketplace form: which fields were filled, which
// need a click, which couldn't be filled, which the form changed afterwards.
// Field keys only (formMap.js), so nothing about the car or the description
// is kept here.
export function noteFill(pilot, { vin, fill, at = nowIso(), mapVersion = '', version = '' }) {
  const p = withPilotDefaults(pilot);
  const f = fill && typeof fill === 'object' ? fill : {};
  const keysOf = (list) => [...new Set((Array.isArray(list) ? list : []).map((x) => x && x.key).filter((k) => typeof k === 'string'))];
  const entry = {
    at,
    vin: String(vin || '').toUpperCase(),
    mapVersion: clean(mapVersion, 40),
    version: clean(version, 20), // the Lot Current build that did the fill
    filled: keysOf(f.filled),
    partial: keysOf(f.partial),
    blocked: keysOf(f.blocked),
    changed: keysOf(f.changedAfterFill),
    preexisting: Array.isArray(f.preexisting) && f.preexisting.length > 0,
  };
  return { ...p, fills: trim([...p.fills, entry], at, (f) => f.at) };
}

// ---------- to-do flags ----------

const flagOpen = (f) => !f.doneAt;

// After a scan: a take-down or price item on one of the salesperson's own
// listings that has no open flag yet gets one, stamped with the scan time.
// An open flag whose item is no longer in the diff is closed as "cleared"
// (the website changed its mind: the car came back, is for sale again after a
// sale-pending or sold mark, or the price went back), but
// only when the scan was complete and confirmed; a scan with warnings keeps
// every open flag as it is, and so does a take-down whose car is still under
// Needs a look as the salesperson's (still missing, only not confirmed gone
// this time: its page could not be checked).
export function noteFlags(pilot, diff, { at } = {}) {
  const p = withPilotDefaults(pilot);
  if (!diff || typeof diff !== 'object') return p;
  const when = at || diff.takenAt || nowIso();
  const wanted = [];
  for (const t of Array.isArray(diff.takeDown) ? diff.takeDown : []) if (t && t.yours && t.vin) wanted.push({ vin: t.vin, kind: 'takeDown', name: clean(t.name, 80), why: clean(t.why, 40) });
  for (const u of Array.isArray(diff.priceUpdates) ? diff.priceUpdates : []) if (u && u.yours && u.vin) wanted.push({ vin: u.vin, kind: 'price', name: clean(u.name, 80), from: u.from, to: u.to });
  const reliable = !diff.unreliable && !(Array.isArray(diff.warnings) && diff.warnings.length);
  const unsettled = new Set((Array.isArray(diff.needsALook) ? diff.needsALook : []).filter((n) => n && n.yours && n.vin).map((n) => n.vin));
  const flags = p.flags.map((f) => {
    if (!flagOpen(f)) return f;
    const still = wanted.find((w) => w.vin === f.vin && w.kind === f.kind);
    if (!still && f.kind === 'takeDown' && unsettled.has(f.vin)) return f;
    if (!still) return reliable ? { ...f, doneAt: when, how: 'cleared', hours: hoursBetween(f.flaggedAt, when) } : f;
    if (f.kind === 'price' && still.to !== f.to) return { ...f, from: still.from, to: still.to }; // the website price moved again while the item was open
    return f;
  });
  for (const w of wanted) {
    if (!flags.some((f) => flagOpen(f) && f.vin === w.vin && f.kind === w.kind)) flags.push({ ...w, flaggedAt: when });
  }
  return { ...p, flags: trim(flags, when, (f) => f.doneAt || f.flaggedAt, flagOpen) };
}

// The item was handled: Lot Current saw the listing change (detected), the person
// ticked it off (manual), or the car was unmarked as posted (cleared).
// kind null closes both kinds for the car.
export function resolveFlag(pilot, vin, kind = null, { at = nowIso(), how = 'manual' } = {}) {
  const p = withPilotDefaults(pilot);
  const key = String(vin || '').toUpperCase();
  const done = FLAG_HOWS.includes(how) ? how : 'manual';
  let touched = false;
  const flags = p.flags.map((f) => {
    if (!flagOpen(f) || f.vin !== key || (kind && f.kind !== kind)) return f;
    touched = true;
    return { ...f, doneAt: at, how: done, hours: hoursBetween(f.flaggedAt, at) };
  });
  return touched ? { ...p, flags } : p;
}

// ---------- the numbers ----------

export function median(values) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : Math.round(((nums[mid - 1] + nums[mid]) / 2) * 10) / 10;
}

function flagStats(flags, now) {
  const done = flags.filter((f) => f.doneAt && f.how !== 'cleared');
  const cleared = flags.filter((f) => f.how === 'cleared');
  const open = flags.filter(flagOpen).map((f) => ({ vin: f.vin, name: f.name || f.vin, flaggedAt: f.flaggedAt, hoursOpen: hoursBetween(f.flaggedAt, now) }));
  const hours = done.map((f) => f.hours).filter((h) => typeof h === 'number');
  return {
    flagged: flags.length,
    done: done.length,
    detected: done.filter((f) => f.how === 'detected').length,
    cleared: cleared.length,
    open: open.length,
    medianHours: median(hours),
    longestHours: hours.length ? Math.max(...hours) : null,
    openItems: open,
  };
}

/**
 * @param {object} pilot
 * @param {object} options
 *   now:    ISO time for the age of open items
 *   labels: { fieldKey: label } from formMap.js, which also fixes the field order
 */
export function summarizePilot(pilot, { now = nowIso(), labels = {} } = {}) {
  const p = withPilotDefaults(pilot);
  const ended = p.posts.filter((a) => a.endedAt);
  const posted = ended.filter((a) => a.outcome === 'posted');
  const seconds = posted.map((a) => a.seconds).filter((s) => typeof s === 'number');
  const count = (outcome) => ended.filter((a) => a.outcome === outcome).length;
  const under60 = seconds.filter((s) => s <= 60).length;
  const people = new Map();
  for (const a of posted) {
    const name = a.salesperson || '(no name)';
    const e = people.get(name) || { name, posted: 0, seconds: [] };
    e.posted += 1;
    if (typeof a.seconds === 'number') e.seconds.push(a.seconds);
    people.set(name, e);
  }
  const salespeople = [...people.values()].map((e) => ({ name: e.name, posted: e.posted, medianSeconds: median(e.seconds) })).sort((a, b) => b.posted - a.posted || a.name.localeCompare(b.name));

  const order = Object.keys(labels);
  const fieldMap = new Map();
  const bump = (key, what) => {
    const f = fieldMap.get(key) || { key, label: labels[key] || key, attempts: 0, filled: 0, partial: 0, blocked: 0, changed: 0 };
    f[what] += 1;
    if (what !== 'changed') f.attempts += 1;
    fieldMap.set(key, f);
  };
  for (const fill of p.fills) {
    for (const k of fill.filled || []) bump(k, 'filled');
    for (const k of fill.partial || []) bump(k, 'partial');
    for (const k of fill.blocked || []) bump(k, 'blocked');
    for (const k of fill.changed || []) bump(k, 'changed');
  }
  const rank = (k) => { const i = order.indexOf(k); return i < 0 ? order.length : i; };
  const fields = [...fieldMap.values()]
    .map((f) => ({ ...f, failures: f.partial + f.blocked, failureRate: f.attempts ? Math.round((100 * (f.partial + f.blocked)) / f.attempts) : 0 }))
    .sort((a, b) => b.failures - a.failures || rank(a.key) - rank(b.key));
  const topFailure = fields.length && fields[0].failures ? fields[0] : null;

  return {
    posts: {
      started: p.posts.length,
      inProgress: p.posts.length - ended.length,
      posted: posted.length,
      drafts: count('draft'),
      skipped: count('skipped'),
      blocked: count('blocked'),
      notPosted: count('not-posted'),
      abandoned: count('abandoned'),
      queued: posted.filter((a) => a.queue).length,
      medianSeconds: median(seconds),
      fastestSeconds: seconds.length ? Math.min(...seconds) : null,
      slowestSeconds: seconds.length ? Math.max(...seconds) : null,
      under60,
      under60Share: seconds.length ? Math.round((100 * under60) / seconds.length) : null,
      firstPostAt: posted.length ? posted.map((a) => a.endedAt).sort()[0] : null,
      lastPostAt: posted.length ? posted.map((a) => a.endedAt).sort().slice(-1)[0] : null,
    },
    salespeople,
    fills: { attempts: p.fills.length, clean: p.fills.filter((f) => !(f.blocked || []).length && !(f.partial || []).length).length, withDraft: p.fills.filter((f) => f.preexisting).length },
    fields,
    topFailure,
    takeDowns: flagStats(p.flags.filter((f) => f.kind === 'takeDown'), now),
    priceUpdates: flagStats(p.flags.filter((f) => f.kind === 'price'), now),
  };
}

// ---------- export ----------

const fmtSeconds = (s) => (typeof s === 'number' ? `${s} s` : '—');
const fmtHours = (h) => (typeof h === 'number' ? `${h} h` : '—');

// Local time for the spreadsheet and the file name (storage keeps ISO). The
// sv-SE locale is the one whose short style reads 2026-10-26 09:15.
const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const formatters = new Map();
function formatterFor(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('sv-SE', { timeZone, dateStyle: 'short', timeStyle: 'short' });
    formatters.set(timeZone, f);
  }
  return f;
}
// The zone the export is written in: the caller's when Intl knows it, else
// this computer's (a bad zone in Settings must not break the download).
export function resolveTimeZone(timeZone) {
  if (timeZone) {
    try { formatterFor(timeZone); return timeZone; } catch { /* not a zone Intl knows */ }
  }
  return localTimeZone();
}
export function fmtLocal(iso, timeZone) {
  if (!iso) return '';
  const t = ms(iso);
  return t === null ? String(iso) : formatterFor(resolveTimeZone(timeZone)).format(t);
}

// What each number means, in the words the manager reads; the CSV and the
// text summary both carry them (PILOT.md says the same at more length).
export const DEFINITIONS = Object.freeze([
  'Time per post runs from the click on Post to "It\'s posted", the salesperson\'s review and their own Publish click included; abandoned attempts are not in the median.',
  'Form fields count one entry per fill of the Marketplace form (a dry run is not a fill), by field name only: never the values or the description.',
  'A sold car\'s flag starts at the scan that first put the item on To do for the salesperson\'s own listing and ends when Lot Current sees the listing changed, the person ticks it off, or a clean scan no longer lists it, which counts as "cleared by the website".',
  'A price change\'s flag starts and ends the same way.',
  'Hours run from the flagging scan, and rescans happen every 3 hours while Chrome is open.',
]);

// A plain-text summary for the clipboard (the weekly check-in).
export function pilotText(summary, { site = '' } = {}) {
  const s = summary;
  const lines = [`Lot Current pilot numbers${site ? ': ' + site : ''}`];
  lines.push(`Posts through Lot Current: ${s.posts.posted} posted (${s.posts.queued} in a queue), ${s.posts.drafts} saved as drafts, ${s.posts.notPosted + s.posts.skipped + s.posts.blocked + s.posts.abandoned} not posted`);
  lines.push(`Time per post (click on Post to "It's posted", review included): median ${fmtSeconds(s.posts.medianSeconds)}, fastest ${fmtSeconds(s.posts.fastestSeconds)}, slowest ${fmtSeconds(s.posts.slowestSeconds)}, ${s.posts.under60Share === null ? '—' : s.posts.under60Share + '%'} within 60 s`);
  for (const sp of s.salespeople) lines.push(`  ${sp.name}: ${sp.posted} posted, median ${fmtSeconds(sp.medianSeconds)}`);
  lines.push(`Form fills: ${s.fills.attempts}, ${s.fills.clean} with nothing to fix by hand, ${s.fills.withDraft} where the form already held another car`);
  const failing = s.fields.filter((f) => f.failures);
  if (failing.length) for (const f of failing) lines.push(`  ${f.label}: ${f.failures} of ${f.attempts} not filled (${f.failureRate}%)${f.changed ? `, changed by the form ${f.changed}×` : ''}`);
  else lines.push('  every field filled every time');
  const flagLine = (title, t) => `${title}: ${t.flagged} flagged, ${t.done} done (${t.detected} seen on the listing), ${t.open} still open, ${t.cleared} cleared by the website; median ${fmtHours(t.medianHours)} from the scan that flagged it, longest ${fmtHours(t.longestHours)}`;
  lines.push(flagLine('Sold cars to take down', s.takeDowns));
  for (const o of s.takeDowns.openItems) lines.push(`  open: ${o.name} (${fmtHours(o.hoursOpen)})`);
  lines.push(flagLine('Price changes', s.priceUpdates));
  for (const o of s.priceUpdates.openItems) lines.push(`  open: ${o.name} (${fmtHours(o.hoursOpen)})`);
  lines.push('', ...DEFINITIONS);
  return lines.join('\n');
}

// One cell of the spreadsheet. A string that starts like a formula (=, +, -,
// @, a tab or a carriage return) gets a leading apostrophe so a spreadsheet
// shows it as text instead of running it (a car's name or a salesperson's
// comes from outside); numbers are written as they are. Quotes, commas,
// apostrophes and line breaks put the cell in quotes.
const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",'\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const csvRow = (cells) => cells.map(csvCell).join(',');

// The spreadsheet the manager gets: who and where it is from, a summary that
// adds up, the definitions, the per-field table, then every post and every
// to-do item as a row, in the given time zone. Field keys only; no
// descriptions, no buyer data, nothing from Facebook beyond the listing outcome.
/**
 * @param {object} pilot
 * @param {object} options
 *   now:         ISO time of the export (the age of open items counts from it)
 *   labels:      { fieldKey: label } from formMap.js
 *   site:        the website's name (the scan's site.name)
 *   origin:      the website's origin, the key the numbers live under
 *   dealer:      the dealership's name from Settings
 *   salesperson: the salesperson's name from Settings
 *   timeZone:    IANA zone for every time in the file; default: this computer's
 */
export function pilotCsv(pilot, { now = nowIso(), labels = {}, site = '', origin = '', dealer = '', salesperson = '', timeZone, version = '' } = {}) {
  const zone = resolveTimeZone(timeZone);
  const local = (iso) => fmtLocal(iso, zone);
  const p = withPilotDefaults(pilot);
  const s = summarizePilot(p, { now, labels });
  const rows = [];
  rows.push(csvRow(['Lot Current pilot numbers', site, `exported ${local(now)}`]));
  rows.push(csvRow(['Dealership', dealer]));
  rows.push(csvRow(['Website', origin]));
  rows.push(csvRow(['Salesperson (from Settings)', salesperson]));
  rows.push(csvRow(['Time zone', zone]));
  rows.push(csvRow(['Lot Current version', version]));
  rows.push('');
  rows.push(csvRow(['Summary', 'Value']));
  rows.push(csvRow(['Posts started', s.posts.started]));
  rows.push(csvRow(['Posted', s.posts.posted]));
  rows.push(csvRow(['Posted in a queue', s.posts.queued]));
  rows.push(csvRow(['Saved as draft', s.posts.drafts]));
  rows.push(csvRow(['Not posted (skipped, blocked, backed out, abandoned)', s.posts.skipped + s.posts.blocked + s.posts.notPosted + s.posts.abandoned]));
  rows.push(csvRow(['Median seconds per post', s.posts.medianSeconds]));
  rows.push(csvRow(['Fastest seconds', s.posts.fastestSeconds]));
  rows.push(csvRow(['Slowest seconds', s.posts.slowestSeconds]));
  rows.push(csvRow(['Posts within 60 seconds', s.posts.under60]));
  rows.push(csvRow(['Form fills', s.fills.attempts]));
  rows.push(csvRow(['Fills with nothing to fix by hand', s.fills.clean]));
  rows.push(csvRow(['Fills where the form already held another car', s.fills.withDraft]));
  rows.push(csvRow(['Sold cars flagged', s.takeDowns.flagged])); // = taken down + still listed + cleared
  rows.push(csvRow(['Sold cars taken down', s.takeDowns.done]));
  rows.push(csvRow(['Sold cars still listed', s.takeDowns.open]));
  rows.push(csvRow(['Sold cars cleared by the website', s.takeDowns.cleared]));
  rows.push(csvRow(['Median hours from the flagging scan until taken down', s.takeDowns.medianHours]));
  rows.push(csvRow(['Price changes flagged', s.priceUpdates.flagged])); // = updated + still open + cleared
  rows.push(csvRow(['Price changes updated', s.priceUpdates.done]));
  rows.push(csvRow(['Price changes still open', s.priceUpdates.open]));
  rows.push(csvRow(['Price changes cleared by the website', s.priceUpdates.cleared]));
  rows.push(csvRow(['Median hours from the flagging scan until updated', s.priceUpdates.medianHours]));
  rows.push('');
  rows.push(csvRow(['Definitions']));
  for (const d of DEFINITIONS) rows.push(csvRow([d]));
  rows.push('');
  rows.push(csvRow(['Salesperson', 'Posted', 'Median seconds per post']));
  for (const sp of s.salespeople) rows.push(csvRow([sp.name, sp.posted, sp.medianSeconds]));
  rows.push('');
  rows.push(csvRow(['Field', 'Attempts', 'Filled', 'Needed a click', "Couldn't fill", 'Changed by the form afterwards', 'Failure rate %']));
  for (const f of s.fields) rows.push(csvRow([f.label, f.attempts, f.filled, f.partial, f.blocked, f.changed, f.failureRate]));
  rows.push('');
  rows.push(csvRow(['Post started', 'Salesperson', 'Car', 'VIN', 'Outcome', 'Seconds', 'In a queue', 'Seconds to review', 'Seconds to form open', 'Seconds to filled', 'Reason']));
  for (const a of p.posts) {
    rows.push(csvRow([local(a.startedAt), a.salesperson, a.name, a.vin, a.outcome || 'in progress', a.seconds, a.queue ? 'yes' : 'no', secondsBetween(a.startedAt, a.reviewedAt), secondsBetween(a.startedAt, a.formOpenedAt), secondsBetween(a.startedAt, a.filledAt), a.reason || '']));
  }
  rows.push('');
  rows.push(csvRow(['Flagged', 'Kind', 'Car', 'VIN', 'Done', 'How', 'Hours', 'Price from', 'Price to']));
  for (const f of p.flags) {
    rows.push(csvRow([local(f.flaggedAt), f.kind === 'price' ? 'price change' : 'sold / take down', f.name, f.vin, local(f.doneAt), f.doneAt ? f.how : 'open', f.doneAt ? f.hours : hoursBetween(f.flaggedAt, now), f.from ?? '', f.to ?? '']));
  }
  return rows.join('\r\n') + '\r\n';
}

// lot-current-pilot-<site>-<salesperson>-<local day>.csv, so one CSV per person
// per website stays tellable apart on the owner's disk.
const slug = (s) => String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed';
export function pilotFileName(now = nowIso(), { site = '', salesperson = '', timeZone } = {}) {
  return `lot-current-pilot-${slug(site)}-${slug(salesperson)}-${fmtLocal(now, timeZone).slice(0, 10)}.csv`;
}

// ---------- storage ----------

// Read, change, write: the popup, the side panel and the service worker all
// use this, sometimes at the same moment (a rescan lands while a post is being
// recorded). updateKey (src/storage.js) runs the get/change/set under a lock
// named after the key; an injected storage may bring its own get, set and
// lock (tests). A failure here must never stop a post, so callers catch.
export function updatePilot(origin, change, storage) {
  return updateKey(pilotKey(origin), (current) => change(withPilotDefaults(current)), storage);
}

export const recordFlags = (origin, diff, at, storage) => updatePilot(origin, (p) => noteFlags(p, diff, { at }), storage);
