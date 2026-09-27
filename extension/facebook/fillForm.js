// Runs inside the Facebook tab (injected with chrome.scripting.executeScript,
// so each exported function must be self-contained: no imports, nothing from
// outside its own body). Fills the fields listed in formMap.js and reports
// what it could and couldn't fill. Never fails silently.
//
// The only things this code ever clicks are a dropdown control (to open it)
// and one of that dropdown's options. It has no way to reach Publish.

export async function fillFormInPage(map, data) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const text = (el) => (el && el.textContent ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  // A rough accessible name: aria-label, aria-labelledby, <label for>, a
  // wrapping <label>, placeholder, title, and (for dropdown controls) the text.
  function accessibleName(el) {
    const parts = [];
    const aria = el.getAttribute('aria-label');
    if (aria) parts.push(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) for (const id of by.split(/\s+/)) { const n = document.getElementById(id); if (n) parts.push(text(n)); }
    if (el.id) {
      try { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) parts.push(text(l)); } catch (e) { /* odd id */ }
    }
    const wrap = el.closest('label');
    if (wrap) parts.push(text(wrap));
    const ph = el.getAttribute('placeholder');
    if (ph) parts.push(ph);
    const title = el.getAttribute('title');
    if (title) parts.push(title);
    if (el.matches('[role="combobox"],[role="button"],button,[aria-haspopup]')) parts.push(text(el));
    return norm(parts.join(' '));
  }

  const TEXT_INPUTS = 'input[type="text"], input:not([type]), input[type="number"], input[type="search"], input[type="tel"]';
  const KIND_SELECTORS = {
    text: TEXT_INPUTS + ', [role="textbox"], [contenteditable="true"]',
    textarea: 'textarea, [role="textbox"], [contenteditable="true"]',
    typeahead: TEXT_INPUTS + ', [role="combobox"] input, [role="textbox"]',
    choice: 'select, [role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="menu"], [aria-haspopup="true"], [role="button"][aria-expanded], button[aria-expanded]',
  };

  const neverNames = (map.neverFill || []).flatMap((f) => f.name).map((p) => new RegExp(p, 'i'));
  const offLimits = (name) => neverNames.some((re) => re.test(name));

  function findField(spec) {
    const patterns = spec.name.map((p) => new RegExp(p, 'i'));
    const candidates = [...document.querySelectorAll(KIND_SELECTORS[spec.kind] || KIND_SELECTORS.text)].filter(visible);
    const matches = candidates.filter((el) => {
      const name = accessibleName(el);
      return name && !offLimits(name) && patterns.some((re) => re.test(name));
    });
    matches.sort((a, b) => text(a).length - text(b).length); // the smallest matching element wins
    return matches[0] || null;
  }

  function pressEscape() {
    const el = document.activeElement || document.body;
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }));
  }

  // React ignores plain `el.value = x`, so set it through the prototype setter
  // and fire the events a typing person would.
  function setText(el, value) {
    if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') {
      el.focus();
      const sel = window.getSelection();
      if (sel) sel.selectAllChildren(el);
      document.execCommand('insertText', false, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return norm(el.textContent) === norm(value);
    }
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    el.focus();
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
    return el.value === value;
  }

  function pickOption(options, wanted) {
    const w = norm(wanted);
    if (!w) return null;
    const labels = options.map((o) => norm(text(o) || o.getAttribute('aria-label') || o.value || ''));
    let i = labels.findIndex((t) => t === w);
    if (i === -1) i = labels.findIndex((t) => t.startsWith(w));
    if (i === -1) i = labels.findIndex((t) => t.includes(w));
    return i === -1 ? null : options[i];
  }

  async function choose(control, wantedList) {
    if (control.tagName === 'SELECT') {
      for (const wanted of wantedList) {
        const option = pickOption([...control.options].filter((o) => o.value !== ''), wanted);
        if (option) {
          control.value = option.value;
          control.dispatchEvent(new Event('input', { bubbles: true }));
          control.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true, chosen: text(option) };
        }
      }
      return { ok: false, reason: 'none of the options matched' };
    }
    control.click();
    let options = [];
    for (let i = 0; i < 20 && !options.length; i += 1) {
      await sleep(100);
      options = [...document.querySelectorAll('[role="option"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]')].filter(visible);
    }
    if (!options.length) {
      pressEscape();
      return { ok: false, reason: "the dropdown didn't open" };
    }
    for (const wanted of wantedList) {
      const option = pickOption(options, wanted);
      if (option) {
        option.click();
        await sleep(150);
        return { ok: true, chosen: text(option) };
      }
    }
    pressEscape();
    return { ok: false, reason: 'none of the options matched (' + options.slice(0, 8).map(text).join(', ') + ')' };
  }

  async function typeahead(el, value) {
    setText(el, value);
    let options = [];
    for (let i = 0; i < 15 && !options.length; i += 1) {
      await sleep(100);
      options = [...document.querySelectorAll('[role="option"], [role="listbox"] li')].filter(visible);
    }
    if (options.length) {
      const option = options[0];
      option.click();
      await sleep(150);
      return { ok: true, chosen: text(option), note: 'picked the first suggestion: ' + text(option) };
    }
    return { ok: true, partial: true, note: 'typed it; pick the suggestion Facebook shows' };
  }

  function readPhotoLimit() {
    try {
      const m = new RegExp(map.photoLimitTextPattern, 'i').exec(document.body.innerText || '');
      if (m) return { value: Number(m[1]), verified: true };
    } catch (e) { /* fall through */ }
    return { value: map.photoLimitDefault, verified: false };
  }

  const result = { url: location.href, filled: [], partial: [], blocked: [], photoLimit: readPhotoLimit() };
  const fields = (data && data.fields) || {};
  for (const spec of map.fields) {
    const raw = fields[spec.key];
    const entry = { key: spec.key, label: spec.label, value: raw === null || raw === undefined ? '' : String(raw) };
    if (!entry.value) {
      result.blocked.push({ ...entry, reason: 'the website has no usable value for this' });
      continue;
    }
    const el = findField(spec);
    if (!el) {
      result.blocked.push({ ...entry, reason: "couldn't find this field on the page" });
      continue;
    }
    try {
      if (spec.kind === 'choice') {
        const wantedList = (spec.options && spec.options[entry.value]) || [entry.value];
        const r = await choose(el, wantedList);
        if (r.ok) result.filled.push({ ...entry, shown: r.chosen });
        else result.blocked.push({ ...entry, reason: r.reason });
      } else if (spec.kind === 'typeahead') {
        const r = await typeahead(el, entry.value);
        (r.partial ? result.partial : result.filled).push({ ...entry, note: r.note, shown: r.chosen });
      } else if (setText(el, entry.value)) {
        result.filled.push(entry);
      } else {
        result.blocked.push({ ...entry, reason: "the page didn't accept the text" });
      }
    } catch (e) {
      result.blocked.push({ ...entry, reason: String((e && e.message) || e) });
    }
    await sleep(50);
  }
  return result;
}

// Read-only check of the page against the map: which fields can be found and
// what controls the page has. Nothing is filled and nothing is clicked. Meant
// for the first live run, so `name` patterns in formMap.js can be fixed in
// minutes from the report. (Helpers are repeated here on purpose: injected
// functions must be self-contained.)
export function probeFormInPage(map) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const text = (el) => (el && el.textContent ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  function accessibleName(el) {
    const parts = [];
    const aria = el.getAttribute('aria-label');
    if (aria) parts.push(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) for (const id of by.split(/\s+/)) { const n = document.getElementById(id); if (n) parts.push(text(n)); }
    if (el.id) {
      try { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) parts.push(text(l)); } catch (e) { /* odd id */ }
    }
    const wrap = el.closest('label');
    if (wrap) parts.push(text(wrap));
    const ph = el.getAttribute('placeholder');
    if (ph) parts.push(ph);
    const title = el.getAttribute('title');
    if (title) parts.push(title);
    if (el.matches('[role="combobox"],[role="button"],button,[aria-haspopup]')) parts.push(text(el));
    return norm(parts.join(' '));
  }
  const TEXT_INPUTS = 'input[type="text"], input:not([type]), input[type="number"], input[type="search"], input[type="tel"]';
  const KIND_SELECTORS = {
    text: TEXT_INPUTS + ', [role="textbox"], [contenteditable="true"]',
    textarea: 'textarea, [role="textbox"], [contenteditable="true"]',
    typeahead: TEXT_INPUTS + ', [role="combobox"] input, [role="textbox"]',
    choice: 'select, [role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="menu"], [aria-haspopup="true"], [role="button"][aria-expanded], button[aria-expanded]',
  };
  const neverNames = (map.neverFill || []).flatMap((f) => f.name).map((p) => new RegExp(p, 'i'));
  const offLimits = (name) => neverNames.some((re) => re.test(name));
  function findField(spec) {
    const patterns = spec.name.map((p) => new RegExp(p, 'i'));
    const candidates = [...document.querySelectorAll(KIND_SELECTORS[spec.kind] || KIND_SELECTORS.text)].filter(visible);
    const matches = candidates.filter((el) => {
      const name = accessibleName(el);
      return name && !offLimits(name) && patterns.some((re) => re.test(name));
    });
    matches.sort((a, b) => text(a).length - text(b).length);
    return matches[0] || null;
  }

  const found = [];
  const missing = [];
  for (const spec of map.fields) {
    const el = findField(spec);
    if (el) found.push({ key: spec.key, label: spec.label, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', name: accessibleName(el).slice(0, 80) });
    else missing.push({ key: spec.key, label: spec.label, patterns: spec.name });
  }
  const controls = [...document.querySelectorAll('input:not([type="hidden"]), textarea, select, [role="combobox"], [role="textbox"], [contenteditable="true"], [aria-haspopup], [role="button"][aria-expanded], button[aria-expanded]')]
    .filter(visible)
    .map((el) => ({ tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '', role: el.getAttribute('role') || '', name: accessibleName(el).slice(0, 80) }))
    .filter((c) => c.name)
    .slice(0, 100);
  let photoLimit = { value: map.photoLimitDefault, verified: false };
  try {
    const m = new RegExp(map.photoLimitTextPattern, 'i').exec(document.body.innerText || '');
    if (m) photoLimit = { value: Number(m[1]), verified: true };
  } catch (e) { /* keep the default */ }
  return { url: location.href, title: document.title, found, missing, controls, fileInputs: document.querySelectorAll(map.fileInput).length, photoLimit, mapVersion: map.version };
}

// Attaches already-downloaded photos ({ name, type, dataUrl }) to the form's
// file input, the same way a person dropping files on it would.
export async function attachPhotosInPage(map, files) {
  const inputs = [...document.querySelectorAll(map.fileInput)];
  const input = inputs.find((i) => /image/i.test(i.accept || '')) || inputs.find((i) => i.multiple) || inputs[0];
  if (!input) return { ok: false, reason: "couldn't find the photo upload control on the page" };
  const dt = new DataTransfer();
  for (const f of files || []) {
    const b64 = String(f.dataUrl || '').split(',')[1] || '';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    dt.items.add(new File([bytes], f.name || 'photo.jpg', { type: f.type || 'image/jpeg' }));
  }
  if (!dt.files.length) return { ok: false, reason: 'no photos to attach' };
  input.files = dt.files;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, attached: dt.files.length };
}
