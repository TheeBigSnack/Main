// The set-up wizard keeps the keyboard through a step's redraw. Every press
// draws the step again, which removes the control the keyboard was on. The
// control the step keeps takes the focus back (wizardFocusId); when it cannot
// (none drawn, or drawn disabled: Next on the posting rules until the box is
// ticked, Read while the website is read, Finish while it saves), the keyboard
// goes to the step's heading, or to the panel itself when the step has none
// (the finished set-up). A keyboard that was not in the panel before the draw
// is not moved (extension/sidepanel.js render, refocusWizard, keyboardInPanel,
// keepKeyboard). The helpers and the set-up branch of render run here from
// their source, with the page stubbed, as test/panelKeyboard.test.js does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { wizardFocusId } from '../extension/src/wizardSteps.js';

const src = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

// A top-level function of sidepanel.js, from its header to the closing brace at column 0.
function topFunction(name) {
  const start = src.search(new RegExp(`\\nfunction ${name}\\(`));
  assert.ok(start >= 0, `${name} is a top-level function`);
  const end = src.indexOf('\n}\n', start);
  return src.slice(start + 1, end + 3);
}

// The line that reads the keyboard, and render's set-up branch, as the source has them.
function setupCode() {
  const start = src.indexOf('\nfunction render() {');
  const render = src.slice(start, src.indexOf('\n}\n', start));
  const read = render.match(/\n  const inPanel = keyboardInPanel\(\);[^\n]*/);
  const at = render.indexOf("\n  if (state.step === 'wizard') {");
  assert.ok(read && at >= 0, 'render reads the keyboard and has a set-up branch');
  return `${read[0]}\n${render.slice(at, render.indexOf('\n  }\n', at) + 5)}`;
}

// The page as a redraw leaves it. A draw sets the panel's HTML: whatever had
// the keyboard inside the panel is removed (the keyboard falls to the body, as
// in a browser), and the step's controls and heading are drawn. A disabled
// control cannot take the focus.
function page() {
  const log = [];
  const focusOptions = [];
  const doc = { activeElement: null, body: { tagName: 'BODY' } };
  let controls = new Map();
  let heading = null;
  let step = {};
  const panel = {
    id: 'panel',
    tabIndex: undefined,
    contains: (el) => el === panel || Boolean(el && el.inPanel),
    querySelectorAll: () => [...controls.values()],
    querySelector: (sel) => (sel === 'h3' ? heading : null),
    focus(options) { doc.activeElement = panel; log.push('panel'); focusOptions.push(options); },
    set innerHTML(_) {
      if (doc.activeElement && doc.activeElement.inPanel) doc.activeElement = doc.body;
      controls = new Map((step.ids || []).map((id) => [id, {
        id,
        inPanel: true,
        disabled: (step.disabled || []).includes(id),
        focus() { if (!this.disabled) { doc.activeElement = this; log.push(id); } },
      }]));
      heading = step.heading === false ? null : {
        tagName: 'H3',
        tabIndex: undefined,
        inPanel: true,
        focus(options) { doc.activeElement = this; log.push('heading'); focusOptions.push(options); },
      };
    },
  };
  const $ = (id) => (id === 'panel' ? panel : controls.get(id) || null);
  const helpers = new Function(
    'document', '$', 'wizardFocusId',
    `${topFunction('focusNow')}\n${topFunction('keyboardInPanel')}\n${topFunction('keepKeyboard')}\n${topFunction('refocusWizard')}\nreturn { focusNow, keyboardInPanel, keepKeyboard, refocusWizard };`,
  )(doc, $, wizardFocusId);
  const branch = new Function(
    'state', '$', 'focusNow', 'keyboardInPanel', 'keepKeyboard', 'refocusWizard', 'wizardHtml',
    setupCode(),
  );
  const focused = () => {
    const el = doc.activeElement;
    if (!el || el === doc.body) return 'body';
    if (el === panel) return 'panel';
    return el === heading ? 'heading' : el.id;
  };
  return {
    panel, log, focusOptions, focused,
    // the step drawn: a redraw of the set-up, as render draws it
    draw(next) {
      step = { ...next };
      branch({ step: 'wizard' }, $, helpers.focusNow, helpers.keyboardInPanel, helpers.keepKeyboard, helpers.refocusWizard, () => '');
    },
    // the person's keyboard lands on a control of the step, as a Tab or a press does
    focus(id) { $(id).focus(); },
  };
}

test('Next into a step whose Next waits for a tick (the posting rules) moves the keyboard to the heading, not the body', () => {
  const p = page();
  p.draw({ ids: ['wizBack', 'wizNext'] }); // the permission step
  p.focus('wizNext');
  p.draw({ ids: ['wizBack', 'wizNext'], disabled: ['wizNext'] }); // the rules step: Next is drawn disabled until the box is ticked
  assert.equal(p.focused(), 'heading');
  assert.deepEqual(p.focusOptions.at(-1), { preventScroll: true });
});

test('Read keeps the keyboard on the step while the website is read: its button is drawn disabled, so the heading takes it', () => {
  const p = page();
  p.draw({ ids: ['wizBack', 'wizScan', 'wizQuit'] }); // the scan step, before Read
  p.focus('wizScan');
  p.draw({ ids: ['wizBack', 'wizScan', 'wizQuit'], disabled: ['wizScan'] }); // Read's busy redraw
  assert.equal(p.focused(), 'heading');
});

test('Finish hands the keyboard on to the finished set-up, which has no heading: the panel itself takes it, so the next Tab is its first control', () => {
  const p = page();
  p.draw({ ids: ['wizBack', 'wizFinish', 'wizQuit'] }); // the terms step
  p.focus('wizFinish');
  p.draw({ ids: ['wizBack', 'wizFinish', 'wizQuit'], disabled: ['wizFinish'] }); // Finish's busy redraw
  p.draw({ ids: ['wizClose'], heading: false }); // the done step
  assert.equal(p.focused(), 'panel');
  assert.equal(p.panel.tabIndex, -1);
  assert.deepEqual(p.focusOptions.at(-1), { preventScroll: true });
});

test('a redraw with the keyboard outside the set-up (on the page body) does not move it', () => {
  const p = page();
  p.draw({ ids: ['wizNext'], heading: true }); // the first draw: nothing has the keyboard
  assert.equal(p.focused(), 'body');
  p.draw({ ids: ['wizNext', 'wizBack'] }); // a redraw with the keyboard still on the page
  assert.equal(p.focused(), 'body');
  assert.deepEqual(p.log, []);
});

test('a control the step keeps takes the keyboard back, so Back stays where it was', () => {
  const p = page();
  p.draw({ ids: ['wizBack', 'wizNext'] });
  p.focus('wizBack');
  p.draw({ ids: ['wizBack', 'wizNext'] }); // the same step drawn again
  assert.equal(p.focused(), 'wizBack');
  assert.equal(p.log.at(-1), 'wizBack', 'the last focus move is Back, not the heading');
});

test('render reads the keyboard before the set-up is drawn, and gives it back only when it was in the panel', () => {
  const start = src.indexOf('\nfunction render() {');
  const render = src.slice(start, src.indexOf('\n}\n', start));
  const read = render.indexOf('const inPanel = keyboardInPanel();');
  const branch = render.indexOf("if (state.step === 'wizard') {");
  assert.ok(read >= 0 && read < branch, 'the keyboard is read before the set-up branch draws');
  assert.match(render, /refocusWizard\(kept\);\n\s+if \(inPanel\) keepKeyboard\(\);/, 'the keyboard goes to the heading (or the panel) only when it was in the panel');
});
