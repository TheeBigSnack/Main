// Runs inside the Facebook tab (injected with chrome.scripting.executeScript,
// so each exported function must be self-contained: no imports, nothing from
// outside its own body). Fills the fields listed in formMap.js and reports
// what it could and couldn't fill. Never fails silently.
//
// The only things this code ever clicks are a dropdown control (to open it)
// and one of that dropdown's options. It has no way to reach Publish.
//
// Lessons from the first live run (2026-09-27): Facebook draws a dropdown's
// option list slowly and leaves it open until something closes it, and a
// click on the next dropdown only closes the stale one. So every dropdown is
// handled as: close anything open, open this one with real pointer events,
// wait (up to 6 s) for ITS popup, choose inside that popup only, close it.
// Facebook also reformats numbers as you type ("36603" -> "36,603").

export async function fillFormInPage(map, data) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const text = (el) => (el && el.textContent ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

  const TEXT_INPUTS = 'input:not([type="hidden"]):not([type="file"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="image"])';
  const CHOICES = 'select, [role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="menu"], [aria-haspopup="true"], [role="button"][aria-expanded], button[aria-expanded]';
  const CHECKBOXES = 'input[type="checkbox"], [role="checkbox"], [role="switch"]';
  const KIND_SELECTORS = {
    text: TEXT_INPUTS + ', [role="textbox"], [contenteditable="true"]',
    textarea: 'textarea, [role="textbox"], [contenteditable="true"]',
    // a typeahead may be a text box or a searchable dropdown; the fill code decides by the control it finds
    typeahead: TEXT_INPUTS + ', [role="textbox"], [contenteditable="true"], ' + CHOICES,
    choice: CHOICES,
    // a field that is a text box on some forms and a dropdown on others
    either: TEXT_INPUTS + ', [role="textbox"], [contenteditable="true"], ' + CHOICES,
    checkbox: CHECKBOXES,
  };
  const ANY_CONTROL = TEXT_INPUTS + ', textarea, select, [role="combobox"], [role="textbox"], [contenteditable="true"], [aria-haspopup], [role="button"][aria-expanded], button[aria-expanded], [role="checkbox"]';

  // For a field that can't be found: the page's controls that look related,
  // so the report shows what is really there.
  function similarControls(spec) {
    const word = new RegExp('\\b' + escapeRe(spec.label.split(' ')[0]) + '\\b', 'i');
    const out = [];
    for (const el of [...document.querySelectorAll(ANY_CONTROL)].filter(visible)) {
      let near = '';
      let node = el;
      for (let up = 0; node && up < 3; up += 1, node = node.parentElement) {
        const t = text(node);
        if (t.length > 200) break;
        near = t;
      }
      const name = accessibleName(el);
      if (!word.test(name) && !word.test(near)) continue;
      out.push({ tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', type: el.getAttribute('type') || '', haspopup: el.getAttribute('aria-haspopup') || '', editable: el.isContentEditable ? 'yes' : '', name: name.slice(0, 60), near: near.slice(0, 60) });
      if (out.length >= 5) break;
    }
    return out;
  }
  const POPUPS = '[role="listbox"], [role="menu"]';
  const OPTIONS = '[role="option"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';

  const neverNames = (map.neverFill || []).flatMap((f) => f.name).map((p) => new RegExp(p, 'i'));
  const offLimits = (name) => neverNames.some((re) => re.test(name));

  // A checkbox is often labelled only by nearby text; the smallest container
  // (up to four levels up) whose text matches names it.
  function checkboxByNearbyText(candidates, patterns) {
    for (const el of candidates) {
      let node = el.parentElement;
      for (let up = 0; node && up < 4; up += 1, node = node.parentElement) {
        const t = norm(text(node));
        if (t.length > 400) break;
        if (t && patterns.some((re) => re.test(t))) return el;
      }
    }
    return null;
  }

  function findFieldNow(spec) {
    const candidates = [...document.querySelectorAll(KIND_SELECTORS[spec.kind] || KIND_SELECTORS.text)].filter(visible);
    const pick = (patterns) => {
      const matches = candidates.filter((el) => {
        const name = accessibleName(el);
        return name && !offLimits(name) && patterns.some((re) => re.test(name));
      });
      matches.sort((a, b) => text(a).length - text(b).length); // the smallest matching element wins
      return matches[0] || null;
    };
    const patterns = spec.name.map((p) => new RegExp(p, 'i'));
    // The map's patterns first; the field's label anywhere in the name as a second chance.
    const found = pick(patterns) || pick([new RegExp('\\b' + escapeRe(spec.label) + '\\b', 'i')]);
    if (found || spec.kind !== 'checkbox') return found;
    return checkboxByNearbyText(candidates, patterns);
  }

  const isChecked = (el) => (el.tagName === 'INPUT' ? el.checked : el.getAttribute('aria-checked') === 'true');
  async function setCheckbox(control, wantChecked) {
    if (isChecked(control) === wantChecked) return { ok: true, shown: wantChecked ? 'already checked' : 'already unchecked' };
    pointer(control, 'pointerdown');
    mouse(control, 'mousedown');
    control.focus();
    pointer(control, 'pointerup');
    mouse(control, 'mouseup');
    control.click();
    await sleep(150);
    if (isChecked(control) !== wantChecked) {
      key(control, ' '); // some custom checkboxes only toggle from the keyboard
      await sleep(150);
    }
    return isChecked(control) === wantChecked ? { ok: true, shown: wantChecked ? 'checked' : 'unchecked' } : { ok: false, reason: "the checkbox didn't change" };
  }

  // Some fields only appear after an earlier one is chosen (Make after Year on
  // the real form), so give a missing field a few seconds to show up.
  async function findField(spec, waitMs = 3000) {
    const until = Date.now() + waitMs;
    let el = findFieldNow(spec);
    while (!el && Date.now() < until) {
      await sleep(250);
      el = findFieldNow(spec);
    }
    return el;
  }
  const isDropdown = (el) => el.tagName === 'SELECT' || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && el.matches(CHOICES));

  const visiblePopups = () => [...document.querySelectorAll(POPUPS)].filter(visible);
  const visibleOptions = (root) => [...(root || document).querySelectorAll(OPTIONS)].filter(visible);
  const mouse = (el, type) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, view: window }));
  const pointer = (el, type) => {
    if (typeof PointerEvent === 'function') el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
  };
  const key = (el, k) => {
    for (const type of ['keydown', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, { key: k, code: k, bubbles: true, cancelable: true }));
  };

  // Pages built with React react to pointer and mouse events, not only click.
  function openDropdown(control) {
    pointer(control, 'pointerdown');
    mouse(control, 'mousedown');
    control.focus();
    pointer(control, 'pointerup');
    mouse(control, 'mouseup');
    control.click();
  }
  function chooseOption(option) {
    pointer(option, 'pointerdown');
    mouse(option, 'mousedown');
    pointer(option, 'pointerup');
    mouse(option, 'mouseup');
    option.click();
  }

  // Leave no menu open behind us: Escape sent to the page (never to a focused
  // box, which the live form's location field treats as "clear me"), then a
  // press outside, then the control itself (which toggles its own popup).
  async function closePopups(control) {
    for (let attempt = 0; attempt < 3 && visiblePopups().length; attempt += 1) {
      if (attempt === 0) {
        key(document.body, 'Escape');
      } else if (attempt === 1) {
        mouse(document.body, 'mousedown');
        mouse(document.body, 'mouseup');
      } else if (control && control.getAttribute('aria-expanded') === 'true') {
        openDropdown(control);
      }
      await sleep(150);
    }
  }

  // React ignores plain `el.value = x`, so set it through the prototype setter
  // and fire the events a typing person would.
  const accepted = (got, want) => got === want || norm(got) === norm(want) || (/^\d+$/.test(want) && String(got).replace(/\D/g, '') === want);
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
    return accepted(el.value, value);
  }

  // What a control shows right now. Used to notice a form that already holds
  // another car (Facebook restores drafts) and to verify each field after it
  // is filled: the report says what the form shows, not what was sent.
  const PLACEHOLDER = /^(select|choose|pick|none|add|enter|type|search)\b/i;
  function displayed(el, spec) {
    if (!el) return '';
    let t = '';
    if (el.tagName === 'SELECT') t = el.selectedIndex >= 0 && el.value !== '' ? text(el.options[el.selectedIndex]) : '';
    else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') t = el.type === 'checkbox' ? (el.checked ? 'checked' : '') : String(el.value || '');
    else if (el.getAttribute('role') === 'checkbox' || el.getAttribute('role') === 'switch') t = el.getAttribute('aria-checked') === 'true' ? 'checked' : '';
    else if (el.isContentEditable) t = text(el);
    else {
      t = text(el); // a dropdown control shows its label and, once chosen, the value
      const label = spec && spec.label ? spec.label : '';
      if (label && t.toLowerCase().startsWith(label.toLowerCase())) t = t.slice(label.length).trim();
    }
    if (!t || PLACEHOLDER.test(t) || (spec && norm(t) === norm(spec.label))) return '';
    return t.trim();
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
    await closePopups(null);
    const popupsBefore = new Set(visiblePopups());
    const optionsBefore = new Set(visibleOptions());
    openDropdown(control);
    const ids = [control.getAttribute('aria-controls'), control.getAttribute('aria-owns')].filter(Boolean).join(' ').split(/\s+/).filter(Boolean);
    let popup = null;
    let options = [];
    for (let i = 0; i < 60 && !options.length; i += 1) {
      await sleep(100);
      if (i === 15) key(control, 'ArrowDown'); // some dropdowns only open from the keyboard
      popup = ids.map((id) => document.getElementById(id)).find((n) => n && visible(n)) || visiblePopups().find((p) => !popupsBefore.has(p)) || null;
      options = popup ? visibleOptions(popup) : visibleOptions().filter((o) => !optionsBefore.has(o));
    }
    if (!options.length) {
      await closePopups(control);
      return { ok: false, reason: "the dropdown didn't open (waited 6 seconds)" };
    }
    const find = () => {
      for (const wanted of wantedList) {
        const option = pickOption(options, wanted);
        if (option) return option;
      }
      return null;
    };
    let option = find();
    // A long list (makes) may have a search box, and only draws the first
    // screen: search for the value, then scroll until it appears.
    const search = popup && [...popup.querySelectorAll('input, [role="searchbox"], [contenteditable="true"]')].find(visible);
    if (!option && search) {
      await typeText(search, wantedList[0]);
      await sleep(400);
      options = visibleOptions(popup);
      option = find();
    }
    if (!option && popup) {
      const scroller = [popup, ...popup.querySelectorAll('*')].find((n) => n.scrollHeight > n.clientHeight + 10) || popup;
      let last = -1;
      for (let i = 0; i < 40 && !option && scroller.scrollTop !== last; i += 1) {
        last = scroller.scrollTop;
        scroller.scrollTop += Math.max(scroller.clientHeight - 20, 40);
        await sleep(120);
        options = visibleOptions(popup);
        option = find();
      }
    }
    if (option) {
      chooseOption(option);
      await sleep(200);
      await closePopups(control);
      return { ok: true, chosen: text(option) };
    }
    await closePopups(control);
    return { ok: false, reason: 'none of the options matched (' + options.slice(0, 8).map(text).join(', ') + (search ? '; searched too' : '') + ')' };
  }

  // Types like a person, one character at a time with key events, so a
  // typeahead sees it. Leaves the box focused: a blur can commit a suggestion
  // we never chose (the live form turned every make into Honda that way).
  async function typeText(el, value) {
    const isInput = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = isInput ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
    const setVal = (v) => { if (desc && desc.set) desc.set.call(el, v); else if (isInput) el.value = v; };
    el.focus();
    if (isInput) {
      setVal('');
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    } else {
      const sel = window.getSelection();
      if (sel) sel.selectAllChildren(el);
      document.execCommand('insertText', false, ''); // clears the selection
    }
    let typed = '';
    for (const ch of String(value)) {
      key(el, ch);
      typed += ch;
      if (isInput) {
        setVal(typed);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
      } else {
        document.execCommand('insertText', false, ch);
      }
      await sleep(12);
    }
    return isInput ? accepted(el.value, value) : norm(text(el)) === norm(value);
  }
  const readBack = (el) => (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? String(el.value) : text(el));
  // After a suggestion is picked some forms empty the box and show the choice
  // beside it; look a few levels up for the words.
  function readNear(el, words) {
    let node = el.parentElement;
    for (let up = 0; node && up < 4; up += 1, node = node.parentElement) {
      const t = String(node.innerText || '').replace(/\s+/g, ' ').trim(); // visible text only: hidden option lists don't count
      if (t.length > 300) break;
      if (t && words.every((w) => new RegExp('\\b' + escapeRe(w) + '\\b', 'i').test(t))) return t;
    }
    return '';
  }

  // Types the value, waits for suggestions, and picks one only if it contains
  // what we typed (or, for the location, the city and state from `expect`).
  // Otherwise the suggestions are dismissed with Escape and the person picks.
  // Always reports what the box shows afterwards.
  async function typeahead(el, value, expect) {
    await closePopups(null);
    const optionsBefore = new Set(visibleOptions());
    await typeText(el, value);
    let options = [];
    for (let i = 0; i < 25 && !options.length; i += 1) {
      await sleep(100);
      options = visibleOptions().filter((o) => !optionsBefore.has(o));
    }
    const has = (t, word) => new RegExp('\\b' + escapeRe(word) + '\\b', 'i').test(t);
    const alternatives = expect && expect.alternatives && expect.alternatives.length ? expect.alternatives : [[value]];
    const strict = expect ? expect.strict !== false : true;
    const fits = (t) => accepted(t, value) || alternatives.some((words) => words.every((w) => has(t, w)));
    if (!options.length) {
      key(el, 'Escape');
      await sleep(100);
      const shown = readBack(el);
      return fits(shown) ? { ok: true, shown } : { ok: false, reason: `typed "${value}" but the box shows "${shown.slice(0, 40)}"` };
    }
    const matching = options.filter((o) => alternatives.some((words) => words.every((w) => has(text(o), w))));
    const shownList = options.slice(0, 5).map(text).join('; ');
    if (!matching.length || (matching.length > 1 && !strict)) {
      key(el, 'Escape');
      await sleep(150);
      await closePopups(null);
      const shown = readBack(el);
      if (!fits(shown)) return { ok: false, reason: `the box shows "${shown.slice(0, 40)}" after typing "${value}"` };
      const note = !matching.length
        ? `none of the suggestions matched (${shownList}); pick the right one yourself`
        : `several match (${matching.slice(0, 4).map(text).join('; ')}); add the state or ZIP in Settings, or pick one yourself`;
      return { ok: true, partial: true, note };
    }
    const option = matching[0];
    chooseOption(option);
    await sleep(250);
    // Nothing is sent to the box after a pick: the list closes by itself, and
    // an Escape here made the live form clear the location.
    if (visiblePopups().length) await closePopups(null);
    const wordsChosen = alternatives.find((words) => words.every((w) => has(text(option), w))) || [value];
    let shown = readBack(el);
    if (!shown || !(fits(shown) || norm(shown).includes(norm(text(option)).slice(0, 20)))) {
      const near = readNear(el, wordsChosen);
      if (near) shown = near;
    }
    const good = fits(shown) || norm(shown).includes(norm(text(option)).slice(0, 20));
    return good ? { ok: true, shown: shown.slice(0, 80), note: 'picked ' + text(option).slice(0, 60) } : { ok: false, reason: `picked "${text(option).slice(0, 60)}" but the box shows "${shown.slice(0, 40)}"` };
  }

  function readPhotoLimit() {
    const patterns = Array.isArray(map.photoLimitTextPatterns) ? map.photoLimitTextPatterns : [map.photoLimitTextPattern].filter(Boolean);
    const body = document.body.innerText || '';
    for (const p of patterns) {
      try {
        const m = new RegExp(p, 'i').exec(body);
        if (m && Number(m[1]) > 0) return { value: Number(m[1]), verified: true };
      } catch (e) { /* next pattern */ }
    }
    return { value: map.photoLimitDefault, verified: false };
  }

  // skipped: things that are not failures (a checkbox left as it is, an
  // optional field this form doesn't have)
  const result = { url: location.href, language: document.documentElement.lang || '', filled: [], partial: [], blocked: [], skipped: [], preexisting: [], changedAfterFill: [], photoLimit: readPhotoLimit() };
  const fields = (data && data.fields) || {};
  const match = (data && data.match) || {};

  // Fills one field and says how it went: { status: 'filled'|'partial'|'blocked', shown?, note?, reason? }
  async function applyField(spec, entry, el) {
    if (spec.kind === 'checkbox') {
      const r = await setCheckbox(el, entry.value === 'yes');
      return r.ok ? { status: 'filled', shown: r.shown } : { status: 'blocked', reason: r.reason };
    }
    if (spec.kind === 'choice' || (spec.kind !== 'textarea' && isDropdown(el))) {
      const wantedList = (spec.options && spec.options[entry.value]) || [entry.value];
      // Verify by reading the control back; if the form shows something else
      // (a draft landing at that moment), choose once more. A control that
      // never shows its value can't be verified; say so instead of assuming.
      let last = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const before = displayed(el, spec);
        const r = await choose(el, wantedList);
        if (!r.ok) return { status: 'blocked', reason: r.reason };
        await sleep(150);
        const after = displayed(el, spec);
        if (after && norm(after).includes(norm(r.chosen))) return { status: 'filled', shown: after };
        if (!after || after === before) return { status: 'filled', shown: r.chosen, note: "couldn't read it back; check it on the form" };
        last = { chosen: r.chosen, after };
        await sleep(400);
      }
      return { status: 'blocked', reason: `chose "${last.chosen}" but the form shows "${last.after.slice(0, 40)}" (twice)` };
    }
    if (spec.kind === 'typeahead') {
      const r = await typeahead(el, entry.value, match[spec.key]);
      if (!r.ok) return { status: 'blocked', reason: r.reason };
      return { status: r.partial ? 'partial' : 'filled', note: r.note, shown: r.shown };
    }
    if (setText(el, entry.value)) return { status: 'filled', shown: el.value !== undefined ? String(el.value) : text(el) };
    const shows = el.value !== undefined ? el.value : text(el);
    return { status: 'blocked', reason: `the page didn't accept the text (it shows "${String(shows).slice(0, 40)}")` };
  }

  // The live form keeps changing for a few seconds after it opens (a saved
  // draft being restored). Don't start until the identity fields have been
  // still for two seconds, or six seconds have passed.
  const IDENTITY = ['vehicleType', 'year', 'make', 'model', 'vin', 'mileage', 'price', 'description'];
  async function waitForStableForm() {
    const snapshot = () => IDENTITY.map((k) => { const spec = map.fields.find((f) => f.key === k); const el = spec && findFieldNow(spec); return el ? displayed(el, spec) : ''; }).join('|');
    const started = Date.now();
    let last = snapshot();
    let still = 0;
    while (still < 2 && Date.now() - started < 6000) {
      await sleep(1000);
      const now = snapshot();
      still = now === last ? still + 1 : 0;
      last = now;
    }
    return Date.now() - started;
  }

  // Does the form still show what we filled? { ok, shown }
  const hasWord = (t, word) => new RegExp('\\b' + escapeRe(word) + '\\b', 'i').test(t);
  function verifyEntry(spec, entry, el) {
    const shown = displayed(el, spec);
    const dropdown = isDropdown(el) || spec.kind === 'choice';
    const expectWords = match[spec.key] && match[spec.key].alternatives;
    const words = Array.isArray(expectWords) && expectWords[0] ? expectWords[0] : [entry.value];
    if (!shown) {
      if (dropdown) return { ok: true, shown: '' }; // a dropdown control may simply not show its value
      if (spec.kind === 'typeahead') { const near = readNear(el, words); return { ok: Boolean(near), shown: near }; } // a box that empties itself after a pick
      return { ok: false, shown: '' };
    }
    const wordsOk = (t) => Array.isArray(expectWords) && expectWords.some((ws) => ws.every((w) => hasWord(t, w)));
    const ok = dropdown
      ? norm(shown).includes(norm(entry.shown || entry.value))
      : accepted(shown, entry.value) || wordsOk(shown) || (entry.shown && norm(shown) === norm(entry.shown)) || (spec.kind === 'typeahead' && norm(shown).includes(norm(entry.value)));
    return { ok, shown };
  }

  result.settledAfterMs = await waitForStableForm();

  // Anything already in the form that is not ours: another car, most likely
  // a draft Facebook restored. Reported so nothing of it is published by
  // mistake. The location and the dealership defaults are not "another car".
  for (const spec of map.fields) {
    if (spec.kind === 'checkbox' || ['location', 'condition', 'titleStatus'].includes(spec.key)) continue;
    const el = findFieldNow(spec);
    const shown = el ? displayed(el, spec) : '';
    const ours = fields[spec.key] === null || fields[spec.key] === undefined ? '' : String(fields[spec.key]);
    if (shown && norm(shown) !== norm(ours) && !(ours && norm(shown).includes(norm(ours)))) {
      result.preexisting.push({ key: spec.key, label: spec.label, shown: shown.slice(0, 60) });
    }
  }

  for (const spec of map.fields) {
    const raw = fields[spec.key];
    const entry = { key: spec.key, label: spec.label, value: raw === null || raw === undefined ? '' : String(raw) };
    if (!entry.value) {
      if (spec.kind === 'checkbox') result.skipped.push({ ...entry, reason: 'left as it is (no default for it)' });
      else if (spec.optional) result.skipped.push({ ...entry, reason: 'nothing to put in it' });
      else result.blocked.push({ ...entry, reason: 'the website has no usable value for this' });
      continue;
    }
    const el = await findField(spec, spec.optional ? 1000 : 3000);
    if (!el) {
      if (spec.optional) result.skipped.push({ ...entry, reason: 'not on this form' });
      else result.blocked.push({ ...entry, reason: "couldn't find this field on the page (waited 3 seconds)", candidates: similarControls(spec) });
      continue;
    }
    try {
      const r = await applyField(spec, entry, el);
      const item = { ...entry };
      if (r.shown !== undefined) item.shown = r.shown;
      if (r.note) item.note = r.note;
      if (r.reason) item.reason = r.reason;
      result[r.status].push(item);
    } catch (e) {
      result.blocked.push({ ...entry, reason: String((e && e.message) || e) });
    }
    await sleep(50);
  }
  await closePopups(null);

  // The live form can rewrite fields a few seconds after they were filled
  // (a saved draft being restored). Wait, read everything back, set any
  // field that changed underneath us again, and report what changed.
  await sleep(map.recheckMs === undefined ? 3000 : map.recheckMs);
  // ...including fields whose first attempt lost to such a change.
  const retryBlocked = result.blocked.filter((b) => /^chose |^the form shows|^the page didn't accept/.test(b.reason || ''));
  for (const entry of [...result.filled, ...retryBlocked]) {
    const wasBlocked = retryBlocked.includes(entry);
    const spec = map.fields.find((f) => f.key === entry.key);
    if (!spec || spec.kind === 'checkbox' || (!wasBlocked && entry.note && /read it back/.test(entry.note))) continue;
    const el = findFieldNow(spec);
    if (!el) continue;
    const v = verifyEntry(spec, entry, el);
    if (v.ok && !wasBlocked) continue;
    const was = wasBlocked ? (v.shown || '(empty)') : (v.shown || '(empty)');
    let again = { status: 'blocked' };
    try { again = await applyField(spec, entry, el); } catch (e) { again = { status: 'blocked', reason: String((e && e.message) || e) }; }
    await sleep(300);
    const v2 = verifyEntry(spec, entry, findFieldNow(spec) || el);
    const held = again.status === 'filled' && v2.ok;
    result.changedAfterFill.push({ key: spec.key, label: spec.label, was, held });
    if (held) {
      if (wasBlocked) {
        result.blocked.splice(result.blocked.indexOf(entry), 1);
        entry.reason = '';
        result.filled.push(entry);
      }
      entry.shown = v2.shown || again.shown || entry.shown;
      entry.note = `the form changed it to "${was.slice(0, 30)}" after filling; set again`;
    } else if (!wasBlocked) {
      result.filled.splice(result.filled.indexOf(entry), 1);
      result.blocked.push({ ...entry, reason: `the form changed it to "${was.slice(0, 40)}" after filling and would not hold "${entry.value.slice(0, 30)}"` });
    } else {
      entry.reason = `${entry.reason}; tried again later, the form still shows "${(v2.shown || '').slice(0, 30)}"`;
    }
  }
  await closePopups(null);
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
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  const TEXT_INPUTS = 'input:not([type="hidden"]):not([type="file"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="image"])';
  const CHOICES = 'select, [role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="menu"], [aria-haspopup="true"], [role="button"][aria-expanded], button[aria-expanded]';
  const KIND_SELECTORS = {
    text: TEXT_INPUTS + ', [role="textbox"], [contenteditable="true"]',
    textarea: 'textarea, [role="textbox"], [contenteditable="true"]',
    typeahead: TEXT_INPUTS + ', [role="textbox"]',
    choice: CHOICES,
    either: TEXT_INPUTS + ', [role="textbox"], [contenteditable="true"], ' + CHOICES,
    checkbox: 'input[type="checkbox"], [role="checkbox"], [role="switch"]',
  };
  const neverNames = (map.neverFill || []).flatMap((f) => f.name).map((p) => new RegExp(p, 'i'));
  const offLimits = (name) => neverNames.some((re) => re.test(name));
  function findField(spec) {
    const candidates = [...document.querySelectorAll(KIND_SELECTORS[spec.kind] || KIND_SELECTORS.text)].filter(visible);
    const pick = (patterns) => {
      const matches = candidates.filter((el) => {
        const name = accessibleName(el);
        return name && !offLimits(name) && patterns.some((re) => re.test(name));
      });
      matches.sort((a, b) => text(a).length - text(b).length);
      return matches[0] || null;
    };
    const patterns = spec.name.map((p) => new RegExp(p, 'i'));
    const found = pick(patterns) || pick([new RegExp('\\b' + escapeRe(spec.label) + '\\b', 'i')]);
    if (found || spec.kind !== 'checkbox') return found;
    // a checkbox labelled only by nearby text
    for (const el of candidates) {
      let node = el.parentElement;
      for (let up = 0; node && up < 4; up += 1, node = node.parentElement) {
        const t = norm(text(node));
        if (t.length > 400) break;
        if (t && patterns.some((re) => re.test(t))) return el;
      }
    }
    return null;
  }

  const found = [];
  const missing = [];
  for (const spec of map.fields) {
    const el = findField(spec);
    if (el) found.push({ key: spec.key, label: spec.label, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', name: accessibleName(el).slice(0, 80) });
    else if (spec.optional) found.push({ key: spec.key, label: spec.label, tag: '', role: '', name: '(optional, not on this form)' });
    else missing.push({ key: spec.key, label: spec.label, patterns: spec.name, note: 'not on the page right now; some fields only appear after an earlier one is chosen' });
  }
  const controls = [...document.querySelectorAll('input:not([type="hidden"]), textarea, select, [role="combobox"], [role="textbox"], [contenteditable="true"], [aria-haspopup], [role="button"][aria-expanded], button[aria-expanded], [role="checkbox"], [role="switch"]')]
    .filter(visible)
    .map((el) => ({ tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '', role: el.getAttribute('role') || '', name: accessibleName(el).slice(0, 80) }))
    .filter((c) => c.name)
    .slice(0, 100);
  let photoLimit = { value: map.photoLimitDefault, verified: false };
  const patterns = Array.isArray(map.photoLimitTextPatterns) ? map.photoLimitTextPatterns : [map.photoLimitTextPattern].filter(Boolean);
  for (const p of patterns) {
    try {
      const m = new RegExp(p, 'i').exec(document.body.innerText || '');
      if (m && Number(m[1]) > 0) { photoLimit = { value: Number(m[1]), verified: true }; break; }
    } catch (e) { /* next pattern */ }
  }
  // the words near the photo control, so the limit wording can be added to the map
  const photoText = (() => {
    const input = document.querySelector(map.fileInput);
    const around = input && (input.closest('section, form, div') || input.parentElement);
    return around ? (around.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  })();
  return { url: location.href, language: document.documentElement.lang || '', title: document.title, found, missing, controls, fileInputs: document.querySelectorAll(map.fileInput).length, photoLimit, photoText, mapVersion: map.version };
}

// Upkeep, step 1: once the salesperson has opened the listing's edit form,
// put the new price in its Price box (found the same way as on the create
// form) and read it back. Nothing else is touched and nothing is clicked.
export function fillPriceInPage(map, price) {
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
    return norm(parts.join(' '));
  }
  const spec = (map.fields || []).find((f) => f.key === 'price');
  if (!spec) return { ok: false, reason: 'no price field in the map' };
  const patterns = spec.name.map((p) => new RegExp(p, 'i'));
  const candidates = [...document.querySelectorAll('input:not([type="hidden"]):not([type="file"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="image"]), [role="textbox"]')].filter(visible);
  const el = candidates.filter((c) => patterns.some((re) => re.test(accessibleName(c)))).sort((a, b) => text(a).length - text(b).length)[0];
  if (!el) return { ok: false, reason: 'no price box on this page yet', url: location.href };
  const want = String(Math.round(Number(price)));
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  el.focus();
  if (desc && desc.set) desc.set.call(el, want);
  else el.value = want;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.blur();
  const shown = String(el.value || '');
  const ok = shown === want || shown.replace(/\D/g, '') === want;
  return ok ? { ok: true, shown, url: location.href } : { ok: false, reason: `the price box shows "${shown.slice(0, 20)}" instead of ${want}`, url: location.href };
}

// Upkeep, step 2: what a listing page shows, read-only, so the panel can tell
// when the salesperson has saved a new price or marked the car sold. Only the
// page's static text counts: text inside buttons, links, menus, tabs and
// dialogs is skipped, so a "Mark as sold" button never reads as a sold
// listing, and the sold sign is looked for in short standalone labels only,
// never in prose such as a description. `expect` ({ id, name }) says which
// listing the panel is working on; the result reports whether this page is it.
export function readListingInPage(map, signs, expect) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const text = (el) => (el && el.textContent ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const shown = (el) => (el.checkVisibility ? el.checkVisibility() : true);
  const visible = (el) => {
    if (!el || !el.isConnected || !shown(el)) return false;
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
    return norm(parts.join(' '));
  }
  // static text, top of the page first, capped so a long page stays cheap
  const skip = 'button, [role="button"], a, [role="link"], [role="menuitem"], [role="menu"], [role="dialog"], [role="alertdialog"], [role="tab"], [role="tablist"], input, textarea, select, script, style, noscript';
  const chunks = [];
  let total = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n && total < 6000; n = walker.nextNode()) {
    const s = n.nodeValue.replace(/\s+/g, ' ').trim();
    if (!s) continue;
    const p = n.parentElement;
    if (!p || p.closest(skip) || !shown(p)) continue;
    chunks.push(s);
    total += s.length + 1;
  }
  const body = chunks.join(' ');
  const prices = [...new Set((body.match(/\$\s?[\d,]{3,}/g) || []).map((p) => p.replace(/[^\d]/g, '')))];
  const re = (p) => { try { return new RegExp(p, 'i'); } catch (e) { return null; } };
  // a status label is a short chunk of its own ("Sold"), never a sentence
  const soldRe = signs && signs.sold ? re(signs.sold) : null;
  const sold = Boolean(soldRe) && chunks.some((c) => c.length <= 40 && soldRe.test(c));
  const unavailableRe = signs && signs.unavailable ? re(signs.unavailable) : null;
  const unavailable = Boolean(unavailableRe) && unavailableRe.test(body);
  // is this the listing the panel is working on?
  const want = expect || {};
  const matchesId = Boolean(want.id) && new RegExp('(^|\\D)' + String(want.id).replace(/\D/g, '') + '(\\D|$)').test(location.href);
  const tokens = String(want.name || '').toLowerCase().split(/\s+/).filter((t) => t.length >= 2).slice(0, 4);
  const hay = (document.title + ' ' + body.slice(0, 2000)).toLowerCase();
  const matchesName = tokens.length >= 2 && tokens.every((t) => hay.includes(t));
  // the edit form's Price box, found the same way fillPriceInPage finds it
  const spec = (map.fields || []).find((f) => f.key === 'price');
  const patterns = spec ? spec.name.map((p) => new RegExp(p, 'i')) : [/\bprice\b/i];
  const box = [...document.querySelectorAll('input:not([type="hidden"]):not([type="file"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="image"]), [role="textbox"]')]
    .filter(visible)
    .find((c) => patterns.some((re) => re.test(accessibleName(c))));
  return {
    url: location.href,
    title: document.title,
    prices,
    sold,
    unavailable,
    matchesId,
    matchesName,
    hasPriceBox: Boolean(box),
    priceBoxValue: box ? String(box.value || '') : '',
  };
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
