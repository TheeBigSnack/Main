// The salesperson's pick of photos for one car: which of the website's
// photos go on the Marketplace form, and in what order (the first is the
// cover photo). Pure: the side panel keeps the pick in its flow state and
// draws it; nothing here reads or writes storage.
//
// A pick is a list of photo addresses. Only the website's own photos for
// this car can be in it (settlePick drops anything else, so a pick made
// before the post-time re-fetch never carries a photo the website no longer
// shows), never a photo on Facebook's own servers (src/photoHosts.js), and
// never more than the form takes.

import { isFacebookServer } from './photoHosts.js';

// The photos a pick can be made from: the website's, in its order, each once.
export function usablePhotos(photos) {
  const seen = new Set();
  const out = [];
  for (const u of Array.isArray(photos) ? photos : []) {
    if (typeof u !== 'string' || !/^https?:\/\//i.test(u) || seen.has(u) || isFacebookServer(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

const cap = (limit) => (Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : Infinity);

// The website's first photos, as many as the form takes: what is attached
// when the salesperson picks nothing themselves.
export const defaultPick = (photos, limit) => usablePhotos(photos).slice(0, cap(limit));

// The pick as it can be used now: null (no pick made) is the default; a pick
// keeps its order, loses photos the website no longer shows and duplicates,
// and is cut to the form's limit.
export function settlePick(pick, photos, limit) {
  if (!Array.isArray(pick)) return defaultPick(photos, limit);
  const usable = new Set(usablePhotos(photos));
  return [...new Set(pick)].filter((u) => usable.has(u)).slice(0, cap(limit));
}

// Ticks or unticks one photo. A ticked photo goes to the end of the pick; a
// tick past the form's limit is refused ({ full: true }) and changes nothing.
export function togglePhoto(pick, url, photos, limit) {
  const now = settlePick(pick, photos, limit);
  if (now.includes(url)) return { pick: now.filter((u) => u !== url), full: false };
  if (!usablePhotos(photos).includes(url)) return { pick: now, full: false };
  if (now.length >= cap(limit)) return { pick: now, full: true };
  return { pick: [...now, url], full: false };
}

// Makes one photo the cover: first in the pick, ticking it if it wasn't. At
// the limit, the last photo of the pick makes room for it.
export function makeCover(pick, url, photos, limit) {
  const now = settlePick(pick, photos, limit);
  if (!usablePhotos(photos).includes(url)) return now;
  return [url, ...now.filter((u) => u !== url)].slice(0, cap(limit));
}

// One line about the pick for the side panel.
export function pickSummary(pick, photos, limit) {
  const usable = usablePhotos(photos).length;
  const n = settlePick(pick, photos, limit).length;
  const max = cap(limit);
  if (!usable) return 'The website shows no photos that can be attached for this car.';
  if (!n) return 'No photos picked. Marketplace needs at least one: tick the ones to attach.';
  const of = `${n} of ${usable} photo${usable === 1 ? '' : 's'} picked`;
  return usable > max && n === max ? `${of}; the form takes ${max}.` : `${of}.`;
}
