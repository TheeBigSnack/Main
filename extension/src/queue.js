// The batch queue: several ready cars, posted one at a time. For each car
// the side panel pre-fills the Marketplace form; the salesperson clicks
// Publish (or Facebook's Save draft) themselves; the panel records the
// outcome and loads the next car. Skip, Pause and Stop are always available.
// The queue lives in chrome.storage so it survives closing the panel, and it
// can never be longer than the day's remaining post cap.

export const OUTCOMES = Object.freeze(['posted', 'draft', 'skipped', 'blocked']);

export function createQueue(vins, { remaining = Infinity, dealerTabId = null, windowId = null, now = new Date().toISOString() } = {}) {
  const unique = [...new Set((vins || []).map((v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '')).filter(Boolean))];
  if (!unique.length) return { ok: false, error: 'Pick at least one car.' };
  if (!(remaining > 0)) return { ok: false, error: "The daily post cap is reached, so nothing can be queued until tomorrow. The dealer can change the cap in Settings." };
  const vinsToQueue = unique.slice(0, remaining);
  return {
    ok: true,
    dropped: unique.length - vinsToQueue.length,
    queue: { vins: vinsToQueue, index: 0, status: 'running', results: {}, dealerTabId, windowId, startedAt: now },
  };
}

export function currentVin(queue) {
  if (!queue || queue.status === 'done' || !Array.isArray(queue.vins)) return null;
  return queue.index < queue.vins.length ? queue.vins[queue.index] : null;
}

export function advance(queue, outcome) {
  const vin = currentVin(queue);
  if (!vin) return queue;
  const results = { ...queue.results, [vin]: OUTCOMES.includes(outcome) ? outcome : 'skipped' };
  const index = queue.index + 1;
  return { ...queue, results, index, status: index >= queue.vins.length ? 'done' : queue.status };
}

export const pause = (queue) => (queue && queue.status === 'running' ? { ...queue, status: 'paused' } : queue);
export const resume = (queue) => (queue && queue.status === 'paused' ? { ...queue, status: 'running' } : queue);

export function summary(queue) {
  const counts = { posted: 0, draft: 0, skipped: 0, blocked: 0 };
  for (const r of Object.values((queue && queue.results) || {})) if (counts[r] !== undefined) counts[r] += 1;
  const total = queue && Array.isArray(queue.vins) ? queue.vins.length : 0;
  const done = queue ? Object.keys(queue.results || {}).length : 0;
  return { total, done, remaining: Math.max(0, total - (queue ? queue.index : 0)), position: queue ? Math.min(queue.index + 1, total) : 0, status: queue ? queue.status : 'none', ...counts };
}

export function describe(queue) {
  const s = summary(queue);
  if (!queue) return '';
  const bits = [];
  if (s.posted) bits.push(`${s.posted} posted`);
  if (s.draft) bits.push(`${s.draft} saved as draft${s.draft === 1 ? '' : 's'}`);
  if (s.skipped) bits.push(`${s.skipped} skipped`);
  if (s.blocked) bits.push(`${s.blocked} couldn't be posted`);
  const progress = s.status === 'done' ? `Queue finished: ${s.total} car${s.total === 1 ? '' : 's'}` : `Car ${s.position} of ${s.total}${s.status === 'paused' ? ' (paused)' : ''}`;
  return bits.length ? `${progress} · ${bits.join(', ')}` : progress;
}
