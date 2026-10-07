// The sandbox's stand-in for a Marketplace: the listings the person has
// published, kept in this browser tab's sessionStorage (all the sandbox's
// pages share it, and it empties when the tab closes). Nothing here is
// Facebook, and nothing here is reached by the extension except through the
// page's own form controls: only a person clicks Publish, Update, Mark as
// sold or Delete. Each of those four buttons counts its own clicks here
// (create.html's Publish, edit.html's Update, item.html's Mark as sold and
// Delete), and demo/drive.mjs checks each count is still 0 before its own
// click as the person and exactly what it clicked after.

(function (root) {
  'use strict';
  const KEY = 'lotSyncSandbox.listings';
  // one count per button, each under its own key: lotSyncSandbox.publishClicks and so on
  const KINDS = ['publish', 'update', 'markSold', 'delete'];
  const clicksKey = (kind) => `lotSyncSandbox.${kind}Clicks`;
  let memory = {}; // fallback when sessionStorage is not available

  function store() {
    try { return root.sessionStorage; } catch (e) { return null; }
  }
  function read() {
    const s = store();
    if (!s) return memory;
    try { return JSON.parse(s.getItem(KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function write(all) {
    const s = store();
    if (!s) { memory = all; return; }
    s.setItem(KEY, JSON.stringify(all));
  }
  const nextId = (all) => String(101000000001 + Object.keys(all).length);

  const api = {
    all: read,
    get(id) { return read()[String(id)] || null; },
    // A person clicked Publish on the create form: the listing goes live and gets its id.
    create(fields) {
      const all = read();
      const id = nextId(all);
      all[id] = { id, createdAt: new Date().toISOString(), sold: false, deleted: false, ...fields };
      write(all);
      return id;
    },
    update(id, patch) {
      const all = read();
      if (!all[String(id)]) return null;
      all[String(id)] = { ...all[String(id)], ...patch, updatedAt: new Date().toISOString() };
      write(all);
      return all[String(id)];
    },
    // A person clicked one of the four buttons: 'publish', 'update', 'markSold' or 'delete'.
    noteClick(kind) {
      if (!KINDS.includes(kind)) throw new Error('unknown button: ' + kind);
      const s = store();
      const n = api.clicks(kind) + 1;
      if (s) s.setItem(clicksKey(kind), String(n));
      else memory['__' + kind] = n;
      return n;
    },
    clicks(kind) {
      const s = store();
      return Number((s ? s.getItem(clicksKey(kind)) : memory['__' + kind]) || 0);
    },
    reset() {
      const s = store();
      if (s) { s.removeItem(KEY); for (const kind of KINDS) s.removeItem(clicksKey(kind)); }
      memory = {};
    },
    money: (n) => '$' + Number(n || 0).toLocaleString('en-US'),
    esc: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
    param: (name) => new URLSearchParams(root.location ? root.location.search : '').get(name) || '',
    // The listing page for an id, built with URLSearchParams so the id is encoded.
    itemUrl: (id) => { const u = new URL('item.html', root.location ? root.location.href : 'http://localhost/'); u.searchParams.set('id', String(id)); return u.href; },
  };
  root.SandboxMarketplace = api;
})(typeof window !== 'undefined' ? window : globalThis);
