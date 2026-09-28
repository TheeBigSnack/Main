// The sandbox's stand-in for a Marketplace: the listings the person has
// published, kept in this browser tab's sessionStorage (all the sandbox's
// pages share it, and it empties when the tab closes). Nothing here is
// Facebook, and nothing here is reached by the extension except through the
// page's own form controls: only a person clicks Publish, Update, Mark as
// sold or Delete, and this file counts those clicks so the sandbox can prove
// it (see demo/drive.mjs).

(function (root) {
  'use strict';
  const KEY = 'lotSyncSandbox.listings';
  const CLICKS = 'lotSyncSandbox.publishClicks';
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
    notePublishClick() {
      const s = store();
      const n = api.publishClicks() + 1;
      if (s) s.setItem(CLICKS, String(n));
      else memory.__clicks = n;
      return n;
    },
    publishClicks() {
      const s = store();
      return Number((s ? s.getItem(CLICKS) : memory.__clicks) || 0);
    },
    reset() {
      const s = store();
      if (s) { s.removeItem(KEY); s.removeItem(CLICKS); }
      memory = {};
    },
    money: (n) => '$' + Number(n || 0).toLocaleString('en-US'),
    esc: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
    param: (name) => new URLSearchParams(root.location ? root.location.search : '').get(name) || '',
  };
  root.SandboxMarketplace = api;
})(typeof window !== 'undefined' ? window : globalThis);
