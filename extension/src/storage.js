// Shared read-modify-writes on chrome.storage.local. The popup, the side
// panel and the service worker change the same keys (the posted list, the
// diff, the queue, the site registry, the pilot numbers), sometimes at the
// same moment: a rescan lands while a post is being recorded. chrome.storage
// has no transactions, so two callers that both read before either writes
// lose one write. updateKey runs get -> change -> set under a lock named
// after the key: a Web Lock where the browser has them (the three contexts
// share the extension's origin, so they share the lock), else a promise-chain
// mutex that serialises the callers in this context. A storage passed in may
// bring its own lock(name, fn) (tests) and its own set (the popup's ownSet,
// which marks the write so the popup's storage listener ignores the echo).

const chains = new Map(); // name -> the tail of the callers waiting on it (the fallback mutex)

function chained(name, fn) {
  const prev = chains.get(name) || Promise.resolve();
  const run = prev.then(fn); // a rejection reaches this caller
  const tail = run.then(() => undefined, () => undefined); // and never blocks the next one
  chains.set(name, tail);
  tail.then(() => { if (chains.get(name) === tail) chains.delete(name); });
  return run;
}

// Runs fn once no other holder of `name` is running. navigator.locks is read
// at call time so a test can stand one in.
export function withLock(name, fn) {
  const locks = globalThis.navigator && navigator.locks;
  if (locks && typeof locks.request === 'function') return locks.request(name, fn);
  return chained(name, fn);
}

/**
 * Read one key, change it, write it back, all under withLock(key).
 * @param {string} key
 * @param {(current: any) => any} change  gets the stored value (undefined when
 *   there is none) and returns the value to store; returning undefined writes
 *   nothing (the key is left as it is) and resolves to undefined.
 * @param {object} [storage]  { get(key) -> { [key]: value }, set(obj), lock?(name, fn) };
 *   defaults to chrome.storage.local. get and set may be replaced separately
 *   (the popup passes its own set); lock, when present, replaces withLock.
 * @returns the value written
 */
export async function updateKey(key, change, storage) {
  const area = storage || chrome.storage.local;
  const get = typeof area.get === 'function' ? (k) => area.get(k) : (k) => chrome.storage.local.get(k);
  const set = typeof area.set === 'function' ? (obj) => area.set(obj) : (obj) => chrome.storage.local.set(obj);
  const run = async () => {
    const current = (await get(key))[key];
    const next = await change(current);
    if (next === undefined) return undefined;
    await set({ [key]: next });
    return next;
  };
  return typeof area.lock === 'function' ? area.lock(key, run) : withLock(key, run);
}

// chrome.storage.local has a fixed quota (10 MB without unlimitedStorage,
// which Lot Sync does not ask for); a set beyond it rejects with a message
// naming the quota. This is what the popup, the panel and the worker show
// instead of an unhandled rejection.
export const STORAGE_FULL = "Couldn't save: Chrome's storage for Lot Sync is full. Clear pilot numbers or an old website in Settings.";

export function storageErrorText(e) {
  const msg = String((e && e.message) || e || '');
  return /quota/i.test(msg) ? STORAGE_FULL : "Couldn't save: " + (msg || 'unknown error');
}
