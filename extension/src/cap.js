// The per-salesperson daily post cap. Meta doesn't publish its limits, so
// this is a safety setting the dealer can change, never a guarantee.

export const DEFAULT_DAILY_CAP = 10;

const localDay = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

// A colleague's entry (merged in by sync, src/sync.js mergeRegistry, marked
// `mine: false`) is not this salesperson's post: the cap is per salesperson.
const own = (p) => Boolean(p) && p.mine !== false;

export function postsToday(posted, now = new Date()) {
  const today = localDay(now);
  return Object.values(posted || {}).filter((p) => {
    if (!own(p) || !p.postedAt) return false;
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

// The posts this salesperson recorded on this computer today, for one
// website (postLog:<origin>: a list of { vin, at }), kept apart from the
// posted list. Taking a listing down or unmarking the car removes it from
// the posted list, but the post was still recorded today: the log keeps it,
// so neither hands a post back (the sync function counts taken-down posts
// the same way). Nothing takes an entry off. Each write keeps only the
// day's entries.
const sameDay = (at, now) => {
  const d = new Date(at);
  return !Number.isNaN(d.getTime()) && localDay(d) === localDay(now);
};
const entries = (log) => (Array.isArray(log) ? log.filter((e) => e && typeof e.vin === 'string' && typeof e.at === 'string') : []);

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

// The forms Lot Current filled today that the person saved as a Facebook
// draft instead of publishing (drafts:<origin>, src/drafts.js: { vin: {
// savedAt, ... } }). Each was a listing filled in today, so each counts
// toward the day's cap like a post, until the car is marked posted: from
// then on it counts as that post (the posted list or the day's log has it),
// never twice.
export function draftsToday(drafts, { posted = {}, log = [], now = new Date() } = {}) {
  const logged = new Set(entries(log).filter((e) => sameDay(e.at, now)).map((e) => e.vin));
  return Object.entries(drafts && typeof drafts === 'object' ? drafts : {}).filter(([vin, d]) => (
    d && typeof d === 'object' && typeof d.savedAt === 'string' && sameDay(d.savedAt, now) && !(posted && posted[vin]) && !logged.has(vin)
  )).length;
}

// The day's standing: the largest of three counts of this person's posts
// today, since each is a count of real posts. The posted list knows the
// cars still listed; `options.log` (the log above) also knows the ones
// taken down or unmarked since; `options.serverCount` (the count above) knows the ones
// synced from anywhere, minus what has not gone up yet. To that come the
// forms saved as drafts today (`options.drafts`, draftsToday above), which
// the result also names as `drafts` when there are any. The fourth argument
// is optional: the old three-argument call is the posted list alone.
export function capStatus(posted, cap = DEFAULT_DAILY_CAP, now = new Date(), options = undefined) {
  const limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : DEFAULT_DAILY_CAP;
  const opts = options && typeof options === 'object' ? options : {};
  const drafts = draftsToday(opts.drafts, { posted, log: opts.log, now });
  const used = Math.max(postsToday(posted, now), loggedToday(opts.log, now), serverPostsToday(opts.serverCount, now)) + drafts;
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
