// The sandbox's stand-in for the chrome.* extension API. The real, unchanged
// popup.html, sidepanel.html and background.js run inside iframes of the
// sandbox page (demo/index.html); this script is put into each of those
// frames ahead of the extension's own module script, so when popup.js runs
// `chrome` is already there. Everything the extension code touches is
// implemented on a hub that lives in the sandbox page (window.parent
// .__lotSyncHub), so the popup, the side panel and the service worker share
// one storage and one message bus, exactly as they share Chrome's.
//
// Two roles in one file: createHub() builds that shared hub (the sandbox page
// calls it, and test/demo.test.js calls it in Node), createChrome(hub, win)
// builds a frame's chrome object. When loaded inside a sandbox frame it
// installs window.chrome by itself.
//
// What is real and what is stubbed:
//   chrome.storage.local / .sync / .session   real semantics, in memory: JSON round-trip of values, get with
//                                              string / array / object-with-defaults / null, onChanged fired in
//                                              every frame only for keys whose value changed (as Chrome does)
//   chrome.runtime.sendMessage / onMessage     a message bus between frames; sendResponse and `return true`
//                                              work as in Chrome; rejects when nothing listens (as Chrome does)
//   chrome.runtime.getManifest / getURL / id   the real manifest.json, read once by the sandbox page
//   chrome.runtime.onInstalled / onStartup     fired once by the sandbox page after the service worker frame loads
//   chrome.scripting.executeScript             runs `func` INSIDE the browser-pane tab's window (same origin):
//                                              document, window and location in it are that page's; the result
//                                              comes back structured-cloned; files: [] is not supported
//   chrome.tabs.query / get / create / update / remove / onUpdated / onRemoved / onCreated / onActivated
//                                              tabs are the browser pane's iframes, managed by the sandbox page
//   chrome.windows.getCurrent                  one window, id 1
//   chrome.permissions.contains / request / getAll / remove / onAdded / onRemoved
//                                              host patterns matched as Chrome matches them: granted are the
//                                              manifest's host_permissions, the sandbox's own origin (the sample
//                                              website and its photos are served from it, and a same-origin read
//                                              needs no permission) and whatever a request was answered yes to;
//                                              request needs a click (user activation) as in Chrome, asks nothing
//                                              when everything is granted already, and otherwise answers
//                                              hub.permissionAnswer (true unless a test sets it) without showing
//                                              Chrome's prompt (STUB); hub.permissionRequests lists what was asked
//   chrome.alarms                              remembered, never fired (STUB: the sandbox has a button that
//                                              sends the rescan message the alarm would)
//   chrome.notifications.create                shown as a toast on the sandbox page
//   chrome.action.setBadgeText / setBadgeBackgroundColor
//                                              shown on the sandbox page's Lot Current toolbar icon
//   chrome.sidePanel.open / setPanelBehavior   the panel is always docked in the sandbox; open() only flashes it (STUB)
//   chrome.storage.managed                     always empty (STUB)
// Nothing here can reach the Publish, Update, Delete or Mark as sold buttons
// on the sandbox's Marketplace pages: the shim has no page-clicking API at
// all, only what the extension itself calls.

(function (root) {
  'use strict';

  const AREAS = ['local', 'sync', 'session'];
  const jsonClone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const clone = (v) => {
    if (v === undefined || v === null) return v;
    try { return structuredClone(v); } catch (e) { return jsonClone(v); }
  };
  const later = (fn) => setTimeout(fn, 0);
  const glob = (pattern) => new RegExp('^' + String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');

  // A host permission pattern taken apart as Chrome reads it: scheme, host
  // ("*", "*.<domain>" or one name), port ("*" when none is written), path.
  function parsePattern(pattern) {
    const s = String(pattern || '');
    if (s === '<all_urls>') return { scheme: '*', host: '', subdomains: true, port: '*', path: '/' + '*' };
    const m = /^(\*|[a-z][a-z0-9+.-]*):\/\/(\*|\*\.[^/:*]+|\[[^\]]*\]|[^/:*]+)(?::(\*|\d+))?(\/.*)$/i.exec(s);
    if (!m) return null;
    const any = m[2] === '*';
    const subdomains = any || m[2].startsWith('*.');
    return { scheme: m[1].toLowerCase(), host: any ? '' : (subdomains ? m[2].slice(2) : m[2]).toLowerCase(), subdomains, port: m[3] || '*', path: m[4] };
  }
  // Does granted pattern a cover everything pattern b names (chrome.permissions.contains)?
  function patternContains(a, b) {
    if (!a || !b) return false;
    if (a.scheme === '*' ? !['*', 'http', 'https'].includes(b.scheme) : a.scheme !== b.scheme) return false;
    if (a.port !== '*' && a.port !== b.port) return false;
    if (a.subdomains && a.host) {
      if (b.host !== a.host && !b.host.endsWith('.' + a.host)) return false;
    } else if (!a.subdomains && (b.subdomains || b.host !== a.host)) {
      return false;
    }
    return glob(a.path).test(b.path);
  }

  // ---------- the shared hub (one per sandbox page) ----------

  /**
   * @param {object} options
   *   manifest     the extension's manifest.json (an object)
   *   extensionId  what chrome.runtime.id says
   *   tabs         the browser pane: { list(), get(id), create({url, active}), update(id, props), remove(id), windowOf(id) }
   *   badge        ({ text, color }) => void, drawn on the toolbar icon
   *   notify       (id, options) => void, a desktop notification
   *   sidePanel    (action, options) => void
   *   extensionBase the URL the extension's files are served from (for chrome.runtime.getURL)
   */
  function createHub(options = {}) {
    const areas = { local: new Map(), sync: new Map(), session: new Map() };
    const listeners = new Map(); // event name -> Set<{ fn, frame }>
    const alarms = new Map();
    const badge = { text: '', color: '#000000' };
    const manifestHosts = (options.manifest && options.manifest.host_permissions) || [];
    let ownOrigin = '';
    try { ownOrigin = options.extensionBase ? new URL(options.extensionBase).origin : ''; } catch (e) { ownOrigin = ''; }
    const grantedHosts = [...manifestHosts, ...(ownOrigin ? [ownOrigin + '/' + '*'] : [])];
    const covered = (origin) => grantedHosts.some((g) => patternContains(parsePattern(g), parsePattern(origin)));
    let frameSeq = 0;
    let panelBehavior = { openPanelOnActionClick: false };

    const set = (name) => { if (!listeners.has(name)) listeners.set(name, new Set()); return listeners.get(name); };

    function get(area, keys) {
      const map = areas[area];
      const out = {};
      if (keys === null || keys === undefined) {
        for (const [k, v] of map) out[k] = clone(v);
        return out;
      }
      if (typeof keys === 'string') keys = [keys];
      if (Array.isArray(keys)) {
        for (const k of keys) if (map.has(k)) out[k] = clone(map.get(k));
        return out;
      }
      if (typeof keys === 'object') {
        for (const [k, dflt] of Object.entries(keys)) out[k] = map.has(k) ? clone(map.get(k)) : clone(dflt);
        return out;
      }
      return out;
    }

    function fireChanges(area, changes) {
      if (!Object.keys(changes).length) return;
      hub.emit('storage.onChanged', [changes, area]);
      hub.emit(`storage.${area}.onChanged`, [changes]);
    }

    function setItems(area, items) {
      const map = areas[area];
      const changes = {};
      for (const [k, raw] of Object.entries(items && typeof items === 'object' ? items : {})) {
        if (raw === undefined) continue;
        const next = jsonClone(raw);
        const before = map.has(k) ? map.get(k) : undefined;
        if (before !== undefined && JSON.stringify(before) === JSON.stringify(next)) continue; // Chrome reports only real changes
        map.set(k, next);
        changes[k] = before === undefined ? { newValue: clone(next) } : { oldValue: clone(before), newValue: clone(next) };
      }
      fireChanges(area, changes);
    }

    function remove(area, keys) {
      const map = areas[area];
      const changes = {};
      for (const k of typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : []) {
        if (!map.has(k)) continue;
        changes[k] = { oldValue: clone(map.get(k)) };
        map.delete(k);
      }
      fireChanges(area, changes);
    }

    function clear(area) {
      remove(area, [...areas[area].keys()]);
    }

    const hub = {
      manifest: options.manifest || { name: 'Lot Current', version: '' },
      extensionId: options.extensionId || 'lot-sync-sandbox',
      extensionBase: options.extensionBase || '',
      tabs: options.tabs || null,
      alarms,
      badge,
      areas,
      get panelBehavior() { return panelBehavior; },
      set panelBehavior(v) { panelBehavior = { ...panelBehavior, ...(v || {}) }; },
      newFrame(win) { return { id: ++frameSeq, win: win || null }; },
      detachFrame(frame) { for (const s of listeners.values()) for (const l of [...s]) if (l.frame === frame) s.delete(l); },
      detachAll() { listeners.clear(); },
      on(name, fn, frame) { if (typeof fn === 'function') set(name).add({ fn, frame }); },
      off(name, fn, frame) { for (const l of [...set(name)]) if (l.fn === fn && l.frame === frame) set(name).delete(l); },
      has(name, fn, frame) { return [...set(name)].some((l) => l.fn === fn && l.frame === frame); },
      count(name) { return set(name).size; },
      // Delivers an event to every frame that listens, each with its own copy of the arguments, asynchronously (as Chrome does).
      emit(name, args = [], { except = null } = {}) {
        for (const l of [...set(name)]) {
          if (except && l.frame === except) continue;
          later(() => { try { l.fn(...args.map(clone)); } catch (e) { console.error(`[sandbox] ${name} listener failed:`, e); } });
        }
      },
      storageGet: get,
      storageSet: setItems,
      storageRemove: remove,
      storageClear: clear,
      storageBytes: (area) => JSON.stringify(Object.fromEntries(areas[area])).length,
      // Empties every area without firing events (Reset sandbox).
      resetStorage() { for (const a of AREAS) areas[a].clear(); },
      // chrome.runtime.sendMessage: every other frame's onMessage listener gets the message; the first sendResponse wins.
      sendMessage(frame, message) {
        const targets = [...set('runtime.onMessage')].filter((l) => l.frame !== frame);
        if (!targets.length) return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
        return new Promise((resolve) => {
          let settled = false;
          const finish = (value) => { if (!settled) { settled = true; resolve(value === undefined ? undefined : clone(value)); } };
          later(() => {
            let pending = 0;
            const sender = { id: hub.extensionId, url: frame && frame.win && frame.win.location ? String(frame.win.location.href) : '', origin: hub.extensionBase };
            for (const l of targets) {
              let ret;
              try {
                ret = l.fn(clone(message), sender, finish);
              } catch (e) {
                console.error('[sandbox] onMessage listener failed:', e);
              }
              if (ret === true) pending += 1;
            }
            if (!pending) finish(undefined);
          });
        });
      },
      setBadge(patch) {
        Object.assign(badge, patch);
        if (typeof options.badge === 'function') options.badge({ ...badge });
      },
      notify(id, opts) { if (typeof options.notify === 'function') options.notify(id, clone(opts)); },
      sidePanel(action, opts) { if (typeof options.sidePanel === 'function') options.sidePanel(action, clone(opts)); },
      // ---------- permissions ----------
      permissionAnswer: true,
      permissionRequests: [],
      permissionsContain(p) {
        const wanted = (p && p.permissions) || [];
        const have = hub.manifest.permissions || [];
        return wanted.every((x) => have.includes(x)) && ((p && p.origins) || []).every(covered);
      },
      permissionsGetAll() { return { permissions: [...(hub.manifest.permissions || [])], origins: [...grantedHosts] }; },
      // What Chrome does after its gesture check: nothing to ask when all is
      // granted, else the prompt's answer (hub.permissionAnswer), and a yes adds the hosts.
      permissionsRequest(p) {
        const origins = ((p && p.origins) || []).map(String);
        if (hub.permissionsContain(p)) return true;
        hub.permissionRequests.push(origins);
        if (!hub.permissionAnswer) return false;
        const added = origins.filter((o) => !covered(o));
        grantedHosts.push(...added);
        if (added.length) hub.emit('permissions.onAdded', [{ permissions: [], origins: added }]);
        return true;
      },
      permissionsRemove(p) {
        const origins = ((p && p.origins) || []).map(String);
        if (origins.some((o) => manifestHosts.includes(o))) throw new Error('You cannot remove required permissions.');
        const removed = origins.filter((o) => grantedHosts.includes(o));
        for (const o of removed) grantedHosts.splice(grantedHosts.indexOf(o), 1);
        if (removed.length) hub.emit('permissions.onRemoved', [{ permissions: [], origins: removed }]);
        return removed.length > 0;
      },
    };
    return hub;
  }

  // ---------- one frame's chrome object ----------

  function createChrome(hub, win) {
    const frame = hub.newFrame(win);
    if (win && typeof win.addEventListener === 'function') win.addEventListener('pagehide', () => hub.detachFrame(frame));

    // MV3 style: a promise, and the optional callback the older style passes.
    const promised = (work, cb) => {
      const p = Promise.resolve().then(work);
      if (typeof cb === 'function') p.then((v) => cb(v), () => cb());
      return p;
    };
    const event = (name) => ({
      addListener: (fn) => hub.on(name, fn, frame),
      removeListener: (fn) => hub.off(name, fn, frame),
      hasListener: (fn) => hub.has(name, fn, frame),
      hasListeners: () => hub.count(name) > 0,
    });
    const area = (name) => ({
      get: (keys, cb) => promised(() => hub.storageGet(name, typeof keys === 'function' ? null : keys), typeof keys === 'function' ? keys : cb),
      set: (items, cb) => promised(() => hub.storageSet(name, items), cb),
      remove: (keys, cb) => promised(() => hub.storageRemove(name, keys), cb),
      clear: (cb) => promised(() => hub.storageClear(name), cb),
      getBytesInUse: (keys, cb) => promised(() => hub.storageBytes(name), typeof keys === 'function' ? keys : cb),
      setAccessLevel: () => Promise.resolve(),
      onChanged: event(`storage.${name}.onChanged`),
      QUOTA_BYTES: name === 'sync' ? 102400 : 10485760,
    });

    const tabs = () => {
      if (!hub.tabs) throw new Error('The sandbox has no browser pane for chrome.tabs.');
      return hub.tabs;
    };
    const noTab = (id) => new Error(`No tab with id: ${id}.`);
    const matchesQuery = (t, q) => {
      if (!q) return true;
      if (q.active !== undefined && Boolean(t.active) !== Boolean(q.active)) return false;
      if (q.currentWindow !== undefined && q.currentWindow !== (t.windowId === 1)) return false;
      if (q.windowId !== undefined && q.windowId !== -2 && q.windowId !== t.windowId) return false;
      if (q.url !== undefined) {
        const patterns = Array.isArray(q.url) ? q.url : [q.url];
        if (!patterns.some((p) => glob(p).test(t.url || ''))) return false;
      }
      return true;
    };

    const chrome = {
      storage: {
        local: area('local'),
        sync: area('sync'),
        session: area('session'),
        managed: { get: (keys, cb) => promised(() => ({}), typeof keys === 'function' ? keys : cb), onChanged: event('storage.managed.onChanged') },
        onChanged: event('storage.onChanged'),
        AccessLevel: { TRUSTED_CONTEXTS: 'TRUSTED_CONTEXTS', TRUSTED_AND_UNTRUSTED_CONTEXTS: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' },
      },

      runtime: {
        id: hub.extensionId,
        lastError: undefined,
        getManifest: () => clone(hub.manifest),
        getURL: (path) => (hub.extensionBase ? new URL(String(path || ''), hub.extensionBase).href : String(path || '')),
        getPlatformInfo: (cb) => promised(() => ({ os: 'linux', arch: 'x86-64', nacl_arch: 'x86-64' }), cb),
        // (message), (message, options), (extensionId, message), each with an optional callback
        sendMessage: (...args) => {
          let message = args[0];
          let cb = null;
          if (typeof args[0] === 'string' && args.length >= 2 && (typeof args[1] !== 'function')) message = args[1];
          for (const a of args) if (typeof a === 'function') cb = a;
          return promised(() => hub.sendMessage(frame, message), cb);
        },
        onMessage: event('runtime.onMessage'),
        onInstalled: event('runtime.onInstalled'),
        onStartup: event('runtime.onStartup'),
        onSuspend: event('runtime.onSuspend'),
        onConnect: event('runtime.onConnect'),
      },

      scripting: {
        // Runs `func` inside the tab's page. Same origin, so a Function built in
        // that window sees its document, window and location. Args go in and
        // the result comes back structured-cloned, as through Chrome.
        executeScript: async (injection) => {
          const inj = injection || {};
          const tabId = inj.target && inj.target.tabId;
          if (Array.isArray(inj.files) && inj.files.length) throw new Error('The sandbox runs functions only, not files.');
          if (typeof inj.func !== 'function') throw new Error('executeScript needs a func.');
          const pageWindow = tabs().windowOf(tabId);
          if (!pageWindow) throw noTab(tabId);
          const fn = new pageWindow.Function('return (' + inj.func.toString() + ')')();
          const args = (inj.args || []).map(clone);
          const result = await fn(...args);
          return [{ frameId: 0, documentId: 'sandbox', result: result === undefined ? undefined : clone(result) }];
        },
        registerContentScripts: () => Promise.resolve(),
        unregisterContentScripts: () => Promise.resolve(),
      },

      tabs: {
        TAB_ID_NONE: -1,
        query: (info, cb) => promised(() => tabs().list().filter((t) => matchesQuery(t, info)).map(clone), cb),
        get: (id, cb) => promised(() => { const t = tabs().get(id); if (!t) throw noTab(id); return clone(t); }, cb),
        create: (props, cb) => promised(() => clone(tabs().create({ url: props && props.url, active: !props || props.active !== false })), cb),
        update: (...args) => {
          const [id, props] = typeof args[0] === 'number' ? args : [null, args[0]];
          const cb = args.find((a) => typeof a === 'function');
          return promised(() => clone(tabs().update(id, props || {})), cb);
        },
        remove: (ids, cb) => promised(() => { for (const id of Array.isArray(ids) ? ids : [ids]) tabs().remove(id); }, cb),
        getCurrent: (cb) => promised(() => undefined, cb), // the popup and the panel are not tabs
        sendMessage: () => Promise.reject(new Error('Could not establish connection. Receiving end does not exist.')),
        onUpdated: event('tabs.onUpdated'),
        onRemoved: event('tabs.onRemoved'),
        onCreated: event('tabs.onCreated'),
        onActivated: event('tabs.onActivated'),
      },

      windows: {
        WINDOW_ID_CURRENT: -2,
        WINDOW_ID_NONE: -1,
        getCurrent: (info, cb) => promised(() => ({ id: 1, focused: true, type: 'normal', state: 'normal', incognito: false, alwaysOnTop: false }), typeof info === 'function' ? info : cb),
        getAll: (info, cb) => promised(() => [{ id: 1, focused: true, type: 'normal', state: 'normal', incognito: false, alwaysOnTop: false }], typeof info === 'function' ? info : cb),
        getLastFocused: (info, cb) => promised(() => ({ id: 1, focused: true, type: 'normal', state: 'normal', incognito: false, alwaysOnTop: false }), typeof info === 'function' ? info : cb),
        onFocusChanged: event('windows.onFocusChanged'),
      },

      permissions: {
        contains: (p, cb) => promised(() => hub.permissionsContain(p), cb),
        // Chrome refuses a request made outside a click; the frame's user activation says whether one is under way.
        request: (p, cb) => {
          const activation = win && win.navigator && win.navigator.userActivation;
          if (activation && !activation.isActive) return promised(() => { throw new Error('This function must be called during a user gesture'); }, cb);
          return promised(() => hub.permissionsRequest(p), cb);
        },
        remove: (p, cb) => promised(() => hub.permissionsRemove(p), cb),
        getAll: (cb) => promised(() => hub.permissionsGetAll(), cb),
        onAdded: event('permissions.onAdded'),
        onRemoved: event('permissions.onRemoved'),
      },

      alarms: {
        create: (...args) => {
          const [name, info] = typeof args[0] === 'string' ? args : ['', args[0]];
          const cb = args.find((a) => typeof a === 'function');
          return promised(() => { hub.alarms.set(name, { name, scheduledTime: Date.now() + ((info && info.delayInMinutes) || 0) * 60000, periodInMinutes: info && info.periodInMinutes }); }, cb);
        },
        get: (name, cb) => promised(() => (hub.alarms.has(typeof name === 'string' ? name : '') ? clone(hub.alarms.get(typeof name === 'string' ? name : '')) : null), typeof name === 'function' ? name : cb),
        getAll: (cb) => promised(() => [...hub.alarms.values()].map(clone), cb),
        clear: (name, cb) => promised(() => hub.alarms.delete(typeof name === 'string' ? name : ''), typeof name === 'function' ? name : cb),
        clearAll: (cb) => promised(() => { hub.alarms.clear(); return true; }, cb),
        onAlarm: event('alarms.onAlarm'),
      },

      notifications: {
        create: (...args) => {
          const [id, opts] = typeof args[0] === 'string' ? args : ['', args[0]];
          const cb = args.find((a) => typeof a === 'function');
          return promised(() => { const nid = id || 'n' + Date.now(); hub.notify(nid, opts); return nid; }, cb);
        },
        update: (id, opts, cb) => promised(() => false, cb),
        clear: (id, cb) => promised(() => true, cb),
        getAll: (cb) => promised(() => ({}), cb),
        onClicked: event('notifications.onClicked'),
        onClosed: event('notifications.onClosed'),
        onButtonClicked: event('notifications.onButtonClicked'),
      },

      action: {
        setBadgeText: (d, cb) => promised(() => { hub.setBadge({ text: String((d && d.text) || '') }); }, cb),
        getBadgeText: (d, cb) => promised(() => hub.badge.text, typeof d === 'function' ? d : cb),
        setBadgeBackgroundColor: (d, cb) => promised(() => { hub.setBadge({ color: (d && d.color) || '#000000' }); }, cb),
        getBadgeBackgroundColor: (d, cb) => promised(() => hub.badge.color, typeof d === 'function' ? d : cb),
        setBadgeTextColor: (d, cb) => promised(() => undefined, cb),
        setTitle: (d, cb) => promised(() => undefined, cb),
        getTitle: (d, cb) => promised(() => String(hub.manifest.action && hub.manifest.action.default_title || hub.manifest.name || ''), typeof d === 'function' ? d : cb),
        setPopup: (d, cb) => promised(() => undefined, cb),
        getPopup: (d, cb) => promised(() => 'popup.html', typeof d === 'function' ? d : cb),
        enable: (id, cb) => promised(() => undefined, typeof id === 'function' ? id : cb),
        disable: (id, cb) => promised(() => undefined, typeof id === 'function' ? id : cb),
        onClicked: event('action.onClicked'),
      },

      sidePanel: {
        open: (opts, cb) => promised(() => { hub.sidePanel('open', opts); }, cb),
        setPanelBehavior: (b, cb) => promised(() => { hub.panelBehavior = b; }, cb),
        getPanelBehavior: (cb) => promised(() => ({ ...hub.panelBehavior }), cb),
        setOptions: (opts, cb) => promised(() => undefined, cb),
        getOptions: (opts, cb) => promised(() => ({ enabled: true, path: 'sidepanel.html' }), typeof opts === 'function' ? opts : cb),
      },
    };
    return chrome;
  }

  root.LotSyncShim = { createHub, createChrome, AREAS };

  // Inside a sandbox frame: the hub is on the sandbox page; install chrome now,
  // before the extension's module script runs.
  let hub = null;
  try {
    if (root.__lotSyncHub) hub = root.__lotSyncHub;
    else if (root.parent && root.parent !== root && root.parent.__lotSyncHub) hub = root.parent.__lotSyncHub;
  } catch (e) { hub = null; }
  if (hub) root.chrome = createChrome(hub, root);
})(typeof window !== 'undefined' ? window : globalThis);
