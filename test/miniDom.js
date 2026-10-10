// A small stand-in page for the functions fillForm.js injects into a
// Facebook tab, for unit tests that need its selectors to mean what they say
// (the stand-ins in detectPost.test.js and upkeep.test.js hand every box to
// every query). Elements are written as a tree:
//   { tag, attrs, text, children, value, hidden }
// and the page answers querySelectorAll, querySelector, closest and matches
// for the selector forms the injected code uses: a tag, [attr], [attr="v"]
// and :not([attr="v"]), in comma-separated lists. Any other selector throws,
// so a test fails loudly instead of quietly matching nothing. Facebook's real
// pages are not modelled; these only stand in for the shapes the code looks at.

function parseSelector(list) {
  return list.split(',').map((part) => {
    const s = part.trim();
    const m = /^([a-zA-Z][a-zA-Z0-9]*|\*)?/.exec(s);
    const tag = m[1] && m[1] !== '*' ? m[1].toUpperCase() : null;
    const tests = [];
    let rest = s.slice(m[0].length);
    const ATTR = /^\[([\w-]+)(?:="([^"]*)")?\]/;
    const NOT = /^:not\(\[([\w-]+)(?:="([^"]*)")?\]\)/;
    while (rest) {
      let a = ATTR.exec(rest);
      if (a) {
        tests.push({ name: a[1], value: a[2], not: false });
        rest = rest.slice(a[0].length);
        continue;
      }
      a = NOT.exec(rest);
      if (a) {
        tests.push({ name: a[1], value: a[2], not: true });
        rest = rest.slice(a[0].length);
        continue;
      }
      throw new Error(`miniDom: unsupported selector "${s}"`);
    }
    if (!tag && !tests.length) throw new Error(`miniDom: unsupported selector "${s}"`);
    return { tag, tests };
  });
}

function matchesOne(el, { tag, tests }) {
  if (tag && el.tagName !== tag) return false;
  return tests.every(({ name, value, not }) => {
    const has = Object.prototype.hasOwnProperty.call(el.attrs, name) && (value === undefined || String(el.attrs[name]) === value);
    return not ? !has : has;
  });
}

export function miniPage({ url, title = '', lang = 'en', body = [] }) {
  const all = []; // elements in document order
  const texts = []; // text nodes in document order
  const make = (spec, parent) => {
    if (typeof spec === 'string') {
      texts.push({ nodeValue: spec, parentElement: parent });
      return { text: spec };
    }
    const el = {
      tagName: String(spec.tag || 'div').toUpperCase(),
      attrs: { ...(spec.attrs || {}) },
      parentElement: parent,
      isConnected: true,
      hidden: Boolean(spec.hidden || (parent && parent.hidden)),
      kids: [],
      value: spec.value ?? (spec.attrs && spec.attrs.value) ?? '',
      get id() { return this.attrs.id || ''; },
      get isContentEditable() { return this.attrs.contenteditable === 'true' || Boolean(this.parentElement && this.parentElement.isContentEditable); },
      get textContent() { return this.kids.map((k) => (k.text !== undefined ? k.text : k.textContent)).join(' '); },
      get innerText() { return this.hidden ? '' : this.kids.map((k) => (k.text !== undefined ? k.text : k.innerText)).join(' '); },
      getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? String(this.attrs[n]) : null; },
      checkVisibility() { return !this.hidden; },
      getBoundingClientRect() { return this.hidden ? { width: 0, height: 0 } : { width: 100, height: 20 }; },
      matches(sel) { return parseSelector(sel).some((p) => matchesOne(this, p)); },
      closest(sel) {
        const parts = parseSelector(sel);
        for (let n = this; n; n = n.parentElement) if (parts.some((p) => matchesOne(n, p))) return n;
        return null;
      },
      querySelectorAll(sel) {
        const parts = parseSelector(sel);
        return all.filter((e) => e !== this && isInside(e, this) && parts.some((p) => matchesOne(e, p)));
      },
    };
    all.push(el);
    if (spec.text !== undefined) el.kids.push(make(String(spec.text), el));
    for (const c of spec.children || []) el.kids.push(make(c, el));
    return el;
  };
  const isInside = (e, root) => { for (let n = e.parentElement; n; n = n.parentElement) if (n === root) return true; return false; };
  const bodyEl = make({ tag: 'body', children: body }, null);
  const document = {
    title,
    body: bodyEl,
    documentElement: { lang },
    getElementById: (id) => all.find((e) => e.id === id) || null,
    querySelectorAll: (sel) => { const parts = parseSelector(sel); return all.filter((e) => e !== bodyEl && parts.some((p) => matchesOne(e, p))); },
    querySelector: (sel) => document.querySelectorAll(sel)[0] || null,
    createTreeWalker: (root) => {
      const list = texts.filter((t) => t.parentElement === root || isInside(t.parentElement, root));
      let i = -1;
      return { nextNode: () => { i += 1; return i < list.length ? list[i] : null; } };
    },
  };
  return {
    document,
    // Runs fn(...args) with this page as the global document and location.
    run(fn, ...args) {
      const names = ['document', 'location', 'NodeFilter', 'CSS', 'getComputedStyle'];
      const saved = Object.fromEntries(names.map((n) => [n, globalThis[n]]));
      Object.assign(globalThis, {
        document,
        location: { href: url },
        NodeFilter: { SHOW_TEXT: 4 },
        CSS: { escape: (s) => String(s) },
        getComputedStyle: (el) => ({ visibility: el.hidden ? 'hidden' : 'visible', display: el.hidden ? 'none' : 'block' }),
      });
      try {
        return fn(...args);
      } finally {
        for (const n of names) {
          if (saved[n] === undefined) delete globalThis[n];
          else globalThis[n] = saved[n];
        }
      }
    },
  };
}
