// Watches the Facebook tab after the form is filled and reports when its
// address changes to a published listing. It only listens; it never acts on
// the page. Detection is best-effort. A single post always waits for the
// salesperson to confirm ("Looks like it posted", It's posted, record it)
// and lets them paste the link. In a queue, a listing address the form's own
// tab moved to straight from the create page, for a listing not already
// recorded, is taken as the person's Publish and recorded without asking
// (isNewListingFromForm); any other listing address waits for their click.

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

// The listing link to keep for a post, from an address the person pasted (or
// the one the tab showed): only a listing's own address, the one the map's
// listingUrlPattern reads an id from. Another spelling of the form's own
// website (m., web. or no www, http, no scheme; createUrl's domain) becomes
// the form's origin, without a query the pattern doesn't need. Anything else
// (the Your listings page Facebook lands on after Publish, another page, text
// that is not an address) gives '': no link is better than one that opens the
// wrong page and hides upkeep's note that no link was saved.
export function listingLink(text, { listingUrlPattern, afterPublishPatterns = [], createUrl = '' } = {}) {
  const t = String(text || '').trim();
  if (!t || !listingUrlPattern) return '';
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : 'https://' + t);
  } catch (e) {
    return '';
  }
  let tries = [u.href];
  try {
    const form = new URL(createUrl);
    const domain = form.hostname.replace(/^www\./i, '').toLowerCase();
    const host = u.hostname.toLowerCase();
    if (/^https?:$/.test(u.protocol) && (host === domain || host.endsWith('.' + domain))) tries = [form.origin + u.pathname, form.origin + u.pathname + u.search];
  } catch (e) {
    /* no form address to compare with: the address as given */
  }
  return tries.find((link) => {
    const r = classifyUrl(link, { listingUrlPattern, afterPublishPatterns });
    return Boolean(r) && r.status === 'listing' && Boolean(r.id);
  }) || '';
}

// Whether an address is the create-listing page: createUrl's page or a page
// under it, with any query.
export function onCreatePage(url, createUrl) {
  try {
    const u = new URL(String(url || ''));
    const c = new URL(String(createUrl || ''));
    const page = u.pathname.replace(/\/+$/, '');
    const form = c.pathname.replace(/\/+$/, '');
    return u.origin === c.origin && (page === form || page.startsWith(form + '/'));
  } catch (e) {
    return false;
  }
}

// In a queue, whether a watch result may be recorded without asking: a
// listing address the tab moved to straight from the create page
// (afterCreate), whose listing is not one already recorded in `posted`.
export function isNewListingFromForm(result, posted, patterns) {
  if (!result || result.status !== 'listing' || result.afterCreate !== true) return false;
  if (!result.id) return true;
  return !Object.values(posted || {}).some((p) => {
    const known = classifyUrl(p && p.listingUrl, patterns);
    return Boolean(known) && known.status === 'listing' && known.id === result.id;
  });
}

/**
 * Resolves with { status: 'listing' | 'probably' | 'closed' | 'timeout' | 'cancelled', url }.
 * A 'listing' result also says whether the address came straight after the
 * create page (createUrl) in this tab, as an address change this watch saw:
 * afterCreate. The address the tab already showed when the watch began
 * never counts as coming from the form.
 */
export function watchForListing({ tabId, listingUrlPattern, afterPublishPatterns = [], createUrl = '', timeoutMs = 30 * 60 * 1000 }) {
  const patterns = { listingUrlPattern, afterPublishPatterns };
  let onForm = false; // the last address this watch saw in the tab was the create page
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
  function check(url, changed) {
    const r = classifyUrl(url, patterns);
    if (!r) {
      onForm = onCreatePage(url, createUrl);
      return;
    }
    if (r.status === 'listing') r.afterCreate = changed && onForm;
    finish(r);
  }
  function onUpdated(id, info) {
    if (id === tabId && info && info.url) check(info.url, true);
  }
  function onRemoved(id) {
    if (id === tabId) finish({ status: 'closed', url: null });
  }

  chrome.tabs.onUpdated.addListener(onUpdated);
  chrome.tabs.onRemoved.addListener(onRemoved);
  timer = setTimeout(() => finish({ status: 'timeout', url: null }), timeoutMs);
  chrome.tabs.get(tabId).then((t) => check(t && t.url, false)).catch(() => finish({ status: 'closed', url: null }));

  return { promise, cancel: () => finish({ status: 'cancelled', url: null }) };
}
