// The per-salesperson daily post cap. Meta doesn't publish its limits, so
// this is a safety setting the dealer can change, never a guarantee.

import { takenDownList } from './takenDown.js';

export const DEFAULT_DAILY_CAP = 10;

const localDay = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

// A colleague's entry (merged in by sync, src/sync.js mergeRegistry, marked
// `mine: false`) is not this salesperson's post: the cap is per salesperson.
const own = (p) => Boolean(p) && p.mine !== false;

// A listing the salesperson made by hand before the day they marked it
// posted (Mark posted, "Before today": `listedBefore`) is watched like any
// other but is not a post of that day: on a first day with Lot Current, the
// listings made earlier would otherwise use up the cap.
export function postsToday(posted, now = new Date()) {
  const today = localDay(now);
  return Object.values(posted || {}).filter((p) => {
    if (!own(p) || !p.postedAt || p.listedBefore === true) return false;
    const d = new Date(p.postedAt);
    return !Number.isNaN(d.getTime()) && localDay(d) === today;
  }).length;
}

// The sync function's count of this salesperson's posts in the local day the
// extension sent it, kept in sync:<origin> as { count, from, to } (src/sync.js
// nextSyncState). It includes posts made on the person's other machines that
// have not come down here yet. It counts only while its range covers `now`:
// yesterday's count says nothing about today. 0 for none or a stale one.
export function serverPostsToday(serverCount, now = new Date()) {
  if (!serverCount || typeof serverCount !== 'object') return 0;
  const count = Number(serverCount.count);
  const from = Date.parse(serverCount.from);
  const to = Date.parse(serverCount.to);
  const at = new Date(now).getTime();
  if (!Number.isInteger(count) || count < 0 || Number.isNaN(from) || Number.isNaN(to) || Number.isNaN(at)) return 0;
  return from <= at && at < to ? count : 0;
}

// The day's log: the posts this salesperson recorded on this computer today,
// for one website (postLog:<origin>: a list of { vin, at }), kept apart from
// the posted list. Taking a listing down or unmarking the car removes it from
// the posted list, but the post was still recorded today: the log keeps it,
// so neither hands a post back (the sync function counts taken-down posts
// the same way). Nothing takes an entry off. Each write keeps only the
// day's entries. It is the one record of the day's posts; the take-down
// record (takenDown:<origin>, src/takenDown.js) is the re-post notice's, and
// the cap reads it only to carry into the log the posts the log never had
// (dayLog below).
const sameDay = (at, now) => {
  const d = new Date(at);
  return !Number.isNaN(d.getTime()) && localDay(d) === localDay(now);
};
const entries = (log) => (Array.isArray(log) ? log.filter((e) => e && typeof e.vin === 'string' && typeof e.at === 'string') : []);
const vinKey = (vin) => String(vin ?? '').trim().toUpperCase();
const postKey = (vin, at) => `${vinKey(vin)}@${new Date(at).getTime()}`;

//
// A post recorded through the side panel is always a new post: one car
// posted, taken down and posted again the same day is two. The popup's Mark
// posted records a listing already live (`alreadyLive`): a car already on
// today's log was recorded today and unmarked since, and marking it again is
// the same listing, so the log stays as it is and the post counts once.
export function logPost(log, vin, at, now = new Date(at), { alreadyLive = false } = {}) {
  const today = entries(log).filter((e) => sameDay(e.at, now));
  if (alreadyLive && today.some((e) => e.vin === vin)) return today;
  return [...today, { vin, at }];
}

export function loggedToday(log, now = new Date()) {
  return entries(log).filter((e) => sameDay(e.at, now)).length;
}

// The day's log as the cap reads it: today's entries, and the posts of today
// that only the take-down record holds, carried into it as { vin, at } (at:
// when the post was made). Those are posts recorded before this computer
// kept the log (an install updated during the day, whose take-downs were
// recorded in takenDown:<origin>), or the person's own posts synced from
// another of their computers and taken down here. A car already on today's
// log is not carried again: the log has its posts (a Mark posted of a car
// unmarked today is the same listing, src/cap.js logPost). One post (VIN and
// posting time) is carried once; a listing marked as made before that day
// (`listedBefore`) is no post of that day and stays out. Read only: nothing
// is written, and the take-down record keeps its entries for the re-post
// notice.
export function dayLog(log, takenDown = null, now = new Date()) {
  const { today, carried } = logParts(log, takenDown, now);
  return [...today, ...carried];
}

function logParts(log, takenDown, now) {
  const today = entries(log).filter((e) => sameDay(e.at, now));
  const logged = new Set(today.map((e) => vinKey(e.vin)));
  const carried = new Map();
  for (const t of takenDownList(takenDown)) {
    if (t.listedBefore || !t.postedAt || !sameDay(t.postedAt, now) || logged.has(t.vin)) continue;
    const key = postKey(t.vin, t.postedAt);
    if (!carried.has(key)) carried.set(key, { vin: t.vin, at: t.postedAt });
  }
  return { today, logged, carried: [...carried.values()] };
}

// This computer's count of the person's posts today: every post on the day's
// log (one per post: a car posted twice through the side panel counts
// twice), and, for cars the log does not have, the posts the take-down
// record carries into it (dayLog) and the posted list's own posts of today
// (recorded before the log existed, or synced from another of the person's
// computers), one per VIN and posting time.
function localPostsToday(posted, log, takenDown, now) {
  const { today, logged, carried } = logParts(log, takenDown, now);
  const others = new Set(carried.map((e) => postKey(e.vin, e.at)));
  for (const [vin, p] of Object.entries(posted || {})) {
    if (!own(p) || p.listedBefore === true || !p.postedAt || !sameDay(p.postedAt, now) || logged.has(vinKey(vin))) continue;
    others.add(postKey(vin, p.postedAt));
  }
  return today.length + others.size;
}

// The forms Lot Current filled today that the person saved as a Facebook
// draft instead of publishing (drafts:<origin>, src/drafts.js: { vin: {
// savedAt, ... } }). Each was a listing filled in today, so each counts
// toward the day's cap like a post, until the car is marked posted: from
// then on it counts as that post (the posted list or the day's log has it),
// never twice.
export function draftsToday(drafts, { posted = {}, log = [], now = new Date() } = {}) {
  const logged = new Set(entries(log).filter((e) => sameDay(e.at, now)).map((e) => e.vin));
  // a car marked as listed before today is no post of today's; its draft from today still counts
  const postedToday = (vin) => Boolean(posted && posted[vin] && posted[vin].listedBefore !== true);
  return Object.entries(drafts && typeof drafts === 'object' ? drafts : {}).filter(([vin, d]) => (
    d && typeof d === 'object' && typeof d.savedAt === 'string' && sameDay(d.savedAt, now) && !postedToday(vin) && !logged.has(vin)
  )).length;
}

// Mark posted records a listing already live on Facebook. Whether it went
// up today decides whether it is one of today's posts, and only the
// salesperson knows, so the popup asks: "Posted today" or "Before today"
// (`listedBefore`, left out of postsToday above, and out of the sync
// function's count and the manager's posted this week). A form Lot Current
// filled and the person saved as a Facebook draft today went up today at
// the earliest: there is nothing to ask, it is today's.
export function askWhenListed(draft, now = new Date()) {
  return !(draft && typeof draft === 'object' && typeof draft.savedAt === 'string' && sameDay(draft.savedAt, now));
}

// The day's standing: the larger of two counts of this person's posts
// today, since each is a count of real posts. This computer's count
// (localPostsToday) knows the posts on the day's log, the ones taken down or
// unmarked since included, and the posted list's; `options.log` is the log
// (postLog:<origin>) and `options.takenDown` the take-down record
// (takenDown:<origin>), read through dayLog. `options.serverCount` (the
// count above) knows the ones synced from anywhere, minus what has not gone
// up yet. To that come the forms saved as drafts today (`options.drafts`,
// draftsToday above), which the result also names as `drafts` when there
// are any. The fourth argument is optional: the old three-argument call is
// the posted list alone.
export function capStatus(posted, cap = DEFAULT_DAILY_CAP, now = new Date(), options = undefined) {
  const limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : DEFAULT_DAILY_CAP;
  const opts = options && typeof options === 'object' ? options : {};
  const drafts = draftsToday(opts.drafts, { posted, log: dayLog(opts.log, opts.takenDown, now), now });
  const used = Math.max(localPostsToday(posted, opts.log, opts.takenDown, now), serverPostsToday(opts.serverCount, now)) + drafts;
  const out = { used, cap: limit, remaining: Math.max(0, limit - used), reached: used >= limit };
  if (drafts) out.drafts = drafts;
  return out;
}

// "N of M today", and how many of the N are drafts: the cap's count as the
// popup and the side panel say it.
export function capCount(cap) {
  const d = cap && cap.drafts;
  return `${cap.used} of ${cap.cap} today${d ? `, ${d === 1 ? 'one' : d} of them saved as ${d === 1 ? 'a draft' : 'drafts'}` : ''}`;
}
