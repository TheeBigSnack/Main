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

export function capStatus(posted, cap = DEFAULT_DAILY_CAP, now = new Date()) {
  const limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : DEFAULT_DAILY_CAP;
  const used = postsToday(posted, now);
  return { used, cap: limit, remaining: Math.max(0, limit - used), reached: used >= limit };
}
