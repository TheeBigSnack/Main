// Watches the Facebook tab after the form is filled and reports when its
// address changes to a published listing. It only listens; it never acts on
// the page. Detection is best-effort: the side panel always asks the
// salesperson to confirm ("Did it post?") and lets them paste the link.

// 'listing' = a listing page with an id; 'probably' = the "your listings"
// page, which usually follows a publish; null = nothing to report.
export function classifyUrl(url, { listingUrlPattern, afterPublishPatterns = [] }) {
  const u = String(url || '');
  if (!u) return null;
  const m = new RegExp(listingUrlPattern, 'i').exec(u);
  if (m) return { status: 'listing', url: u, id: m[1] || null };
  if (afterPublishPatterns.some((p) => new RegExp(p, 'i').test(u))) return { status: 'probably', url: null, id: null };
  return null;
}

/**
 * Resolves with { status: 'listing' | 'probably' | 'closed' | 'timeout' | 'cancelled', url }.
 */
export function watchForListing({ tabId, listingUrlPattern, afterPublishPatterns = [], timeoutMs = 30 * 60 * 1000 }) {
  const patterns = { listingUrlPattern, afterPublishPatterns };
  let done = false;
  let timer = null;
  let resolveFn;
  const promise = new Promise((resolve) => { resolveFn = resolve; });

  function finish(result) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    chrome.tabs.onUpdated.removeListener(onUpdated);
    chrome.tabs.onRemoved.removeListener(onRemoved);
    resolveFn(result);
  }
  function check(url) {
    const r = classifyUrl(url, patterns);
    if (r) finish(r);
  }
  function onUpdated(id, info) {
    if (id === tabId && info && info.url) check(info.url);
  }
  function onRemoved(id) {
    if (id === tabId) finish({ status: 'closed', url: null });
  }

  chrome.tabs.onUpdated.addListener(onUpdated);
  chrome.tabs.onRemoved.addListener(onRemoved);
  timer = setTimeout(() => finish({ status: 'timeout', url: null }), timeoutMs);
  chrome.tabs.get(tabId).then((t) => check(t && t.url)).catch(() => finish({ status: 'closed', url: null }));

  return { promise, cancel: () => finish({ status: 'cancelled', url: null }) };
}
