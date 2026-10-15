// The side panel keeps the keyboard through a step's redraw: when the control
// the keyboard was on is drawn away (a button the person pressed, in a post
// step), the keyboard goes to the step's heading, or the panel itself, not to
// the top of the page (extension/sidepanel.js render, keyboardInPanel,
// keepKeyboard). The panel's own code runs here from its source with the page
// stubbed, as the popup and dropdown tests do.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

// A top-level function of sidepanel.js, from its header to the closing brace at column 0.
function topFunction(name) {
  const start = src.search(new RegExp(`\\nfunction ${name}\\(`));
  assert.ok(start >= 0, `${name} is a top-level function`);
  const end = src.indexOf('\n}\n', start);
  return src.slice(start + 1, end + 3);
}

// A panel with the given heading (or none), and a document whose focus can move.
function page({ heading = true } = {}) {
  const log = [];
  const focusOptions = [];
  const h3 = heading ? { tagName: 'H3', tabIndex: undefined, focus(o) { log.push('heading'); focusOptions.push(o); } } : null;
  const panel = {
    id: 'panel',
    tabIndex: undefined,
    contains: (el) => Boolean(el) && el.inPanel === true,
    querySelector: (sel) => (sel === 'h3' ? h3 : null),
    focus(o) { log.push('panel'); focusOptions.push(o); },
  };
  const doc = { activeElement: null, body: { tagName: 'BODY' } };
  const fns = new Function(
    'document', '$',
    `${topFunction('keyboardInPanel')}\n${topFunction('keepKeyboard')}\nreturn { keyboardInPanel, keepKeyboard };`,
  )(doc, (id) => (id === 'panel' ? panel : null));
  return { ...fns, doc, panel, log, focusOptions };
}

test('the keyboard in the panel is kept when the redraw removes its control: it goes to the step heading', () => {
  const p = page();
  p.doc.activeElement = { inPanel: true, id: 'fillAgain' };
  assert.equal(p.keyboardInPanel(), true);
  // the redraw removes the button: the keyboard falls to the body
  p.doc.activeElement = p.doc.body;
  assert.equal(p.keyboardInPanel(), false);
  p.doc.activeElement = { inPanel: true, id: 'fillAgain' };
  p.doc.activeElement = p.doc.body;
  p.keepKeyboard();
  assert.deepEqual(p.log, ['heading']);
});

test('a step with no heading takes the keyboard on the panel itself, so the next Tab is its first control', () => {
  const p = page({ heading: false });
  p.doc.activeElement = p.doc.body;
  p.keepKeyboard();
  assert.deepEqual(p.log, ['panel']);
  assert.equal(p.panel.tabIndex, -1);
});

test('the keyboard moves without scrolling the panel: the page does not jump to the step heading', () => {
  const p = page();
  p.doc.activeElement = p.doc.body;
  p.keepKeyboard();
  assert.deepEqual(p.focusOptions, [{ preventScroll: true }]);
  const bare = page({ heading: false });
  bare.doc.activeElement = bare.doc.body;
  bare.keepKeyboard();
  assert.deepEqual(bare.focusOptions, [{ preventScroll: true }]);
});

test('a redraw that leaves the keyboard in the panel moves nothing', () => {
  const p = page();
  p.doc.activeElement = { inPanel: true, id: 'copyDescription' };
  p.keepKeyboard();
  assert.deepEqual(p.log, []);
});

test('the keyboard on the page outside the panel is not the panel\'s to keep', () => {
  const p = page();
  p.doc.activeElement = { inPanel: false, id: 'site' };
  assert.equal(p.keyboardInPanel(), false);
});

test('render keeps the keyboard only when it was in the panel before the redraw', () => {
  const render = src.slice(src.indexOf('\nfunction render() {'), src.indexOf('\n}\n', src.indexOf('\nfunction render() {')));
  const before = render.indexOf('const inPanel = keyboardInPanel();');
  const draw = render.indexOf("$('panel').innerHTML = queueBar()");
  assert.ok(before >= 0 && before < draw, 'the focus is read before the panel is drawn');
  // a kept control the redraw drew but that cannot take focus (a heading, a disabled button) still falls back
  assert.match(render, /if \(kept\) refocus\(kept\);\n\s*if \(inPanel\) keepKeyboard\(\);/, 'the step takes the keyboard when the kept control did not get it');
});
