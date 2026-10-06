// The posts this salesperson took off their posted list on one website, kept
// so that a take-down never erases the post. posted:<origin> holds only the
// listings that are up: rescan.js markTakenDown removes the entry when the
// person clicks Taken down or unmarks Posted ✓ (popup.js), or finishes a
// take-down from To do (upkeep.js). Taken down here, a post still counts
// toward the daily cap on the day it was made, the way the sync function
// counts the day's posts (any status): a take-down never frees a slot. The
// cap's record of the day's posts is the day's log (postLog:<origin>,
// src/cap.js); it reads this record only to carry into that log the posts
// of the day the log never had (cap.js dayLog: posts recorded before the log
// existed, or synced from another computer).
//
// The side panel reads it too, before a post (relistNotice): a car this
// person took down while the website still listed it as ready may be a
// delete and repost to bump the listing, which posting rule 3 forbids. The
// review step says so and a queue waits there for the person. The post is
// not refused: Facebook may have removed the listing, or the click was a
// mistake.
//
// Each entry is { vin, postedAt, takenDownAt, stillListed }, plus
// listedBefore: true for a listing marked as made by hand before the day it
// was marked posted (no post of that day, so the cap never counts it), and
// the car's name as the posted list had it (name, when it had one): a
// listing taken down here may still be on Facebook, so the side panel and
// To do count it among the cars whose listing looks like another car's of
// that name (upkeep.js namesakesOf). stillListed is whether the website
// still listed the car as ready to post when it was taken down
// (stillListedNow). Kept in this browser only, under
// takenDown:<origin> (src/storageKeys.js), never synced; pruned on every
// write to the last KEEP_DAYS days and the newest MAX_ENTRIES entries.

import { DECISION } from './classify.js';

export const KEEP_DAYS = 30;
export const MAX_ENTRIES = 500;

const DAY_MS = 24 * 3600 * 1000;
const ms = (x) => {
  if (x === null || x === undefined || x === '') return null;
  const t = x instanceof Date ? x.getTime() : typeof x === 'number' ? x : Date.parse(x);
  return Number.isNaN(t) ? null : t;
};
const iso = (x) => {
  const t = ms(x);
  return t === null ? null : new Date(t).toISOString();
};
const vinOf = (v) => String(v ?? '').trim().toUpperCase().slice(0, 17);
const nameOf = (n) => (typeof n === 'string' ? n.replace(/\s+/g, ' ').trim().slice(0, 200) : '');

// The stored list, each entry well formed (a VIN and a take-down time).
export function takenDownList(log) {
  const out = [];
  for (const e of Array.isArray(log) ? log : []) {
    if (!e || typeof e !== 'object') continue;
    const vin = vinOf(e.vin);
    const takenDownAt = iso(e.takenDownAt);
    if (!vin || !takenDownAt) continue;
    const name = nameOf(e.name);
    out.push({ vin, postedAt: iso(e.postedAt), takenDownAt, stillListed: e.stillListed === true, ...(e.listedBefore === true ? { listedBefore: true } : {}), ...(name ? { name } : {}) });
  }
  return out;
}

// Whether the last scan still listed the car as ready to post, and not as a
// car to take down (sale pending): a take-down then was the person's own
// choice, not the website's.
export function stillListedNow(snapshot, diff, vin) {
  const v = snapshot && snapshot.vehicles ? snapshot.vehicles[vin] : null;
  if (!v || v.decision !== DECISION.READY) return false;
  const flagged = diff && Array.isArray(diff.takeDown) ? diff.takeDown : [];
  return !flagged.some((x) => x && x.vin === vin);
}

/**
 * The list with one more take-down, pruned. A second take-down of the same
 * post (VIN and posting time) replaces the first.
 *   vin, postedAt  the posted entry being removed (postedAt may be missing
 *                  for an entry saved without one; it then counts toward no day)
 *   stillListed    stillListedNow() at the moment of the take-down
 *   listedBefore   the posted entry's listedBefore (made by hand before the
 *                  day it was marked posted: no post of that day)
 *   name           the posted entry's name (for namesakesOf)
 *   at             when it was taken down
 */
export function noteTakenDown(log, { vin, postedAt = null, stillListed = false, listedBefore = false, name = '' } = {}, at = new Date().toISOString(), now = at) {
  const v = vinOf(vin);
  const when = iso(at);
  const list = takenDownList(log);
  if (!v || !when) return list;
  const posted = iso(postedAt);
  const kept = list.filter((e) => !(e.vin === v && e.postedAt === posted));
  const named = nameOf(name);
  kept.push({ vin: v, postedAt: posted, takenDownAt: when, stillListed: stillListed === true, ...(listedBefore === true ? { listedBefore: true } : {}), ...(named ? { name: named } : {}) });
  const floor = (ms(now) ?? Date.now()) - KEEP_DAYS * DAY_MS;
  return kept
    .filter((e) => ms(e.takenDownAt) >= floor || (e.postedAt && ms(e.postedAt) >= floor))
    .sort((a, b) => ms(b.takenDownAt) - ms(a.takenDownAt))
    .slice(0, MAX_ENTRIES)
    .reverse();
}

// The latest take-down of this car, when the website still listed it as
// ready then and it was within the last `days`; null otherwise (never taken
// down, taken down because it sold or went sale pending, or long ago).
export function relistNotice(log, vin, now = new Date(), days = KEEP_DAYS) {
  const v = vinOf(vin);
  const at = ms(now);
  if (!v || at === null) return null;
  const latest = takenDownList(log).filter((e) => e.vin === v).sort((a, b) => ms(b.takenDownAt) - ms(a.takenDownAt))[0];
  if (!latest || !latest.stillListed || ms(latest.takenDownAt) < at - days * DAY_MS) return null;
  return { takenDownAt: latest.takenDownAt, postedAt: latest.postedAt };
}
