// The per-salesperson daily post cap. Meta doesn't publish its limits, so
// this is a safety setting the dealer can change, never a guarantee.

import { takenDownList } from './takenDown.js';

export const DEFAULT_DAILY_CAP = 10;

const localDay = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

// A colleague's entry (merged in by sync, src/sync.js mergeRegistry, marked
// `mine: false`) is not this salesperson's post: the cap is per salesperson.
const own = (p) => Boolean(p) && p.mine !== false;

// The posts this salesperson made today: the entries of their posted list
// stamped today, and the posts made today that they have taken down since
// (src/takenDown.js, `takenDown`): a post taken down later was still a post
// that day, as the sync function counts it. One post (VIN and posting time)
// counts once.
export function postsToday(posted, now = new Date(), takenDown = null) {
  const today = localDay(now);
  const posts = new Set();
  const add = (vin, postedAt) => {
    if (!postedAt) return;
    const d = new Date(postedAt);
    if (!Number.isNaN(d.getTime()) && localDay(d) === today) posts.add(`${String(vin).toUpperCase()}@${d.getTime()}`);
  };
  for (const [vin, p] of Object.entries(posted || {})) if (own(p)) add(vin, p.postedAt);
  for (const t of takenDownList(takenDown)) add(t.vin, t.postedAt);
  return posts.size;
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

// The day's standing. `options.serverCount` is the count above; the larger
// of the two counts is the day's, since both are real posts by this person
// (this machine knows the ones made here; the server knows the ones synced
// from anywhere, minus what has not gone up yet). `options.takenDown` is
// this website's takenDown:<origin> list, so a take-down never frees a slot.
// The fourth argument is optional: the old three-argument call is the
// posted list alone.
export function capStatus(posted, cap = DEFAULT_DAILY_CAP, now = new Date(), options = undefined) {
  const limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : DEFAULT_DAILY_CAP;
  const o = options && typeof options === 'object' ? options : {};
  const used = Math.max(postsToday(posted, now, o.takenDown), serverPostsToday(o.serverCount, now));
  return { used, cap: limit, remaining: Math.max(0, limit - used), reached: used >= limit };
}
