// A side panel in a second Chrome window can show a copy of the post that
// another window's side panel has under way. When that window has changed
// the post since (or has another car's post under way), a save of the copy
// is refused (sidepanel.js saveFlow), so it never writes over the newer
// post. src/notSaved.js decides what the panel then says and keeps: what
// happened and what to do, the text typed here (kept on screen to copy),
// and what else done here was not saved (photo and highlight picks, a
// rewrite, a colour guess, a VIN check), so the person can do it again.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notSavedReport, NOT_SAVED_STEPS } from '../extension/src/notSaved.js';
import { copyProblems } from './copyGuards.js';

const A = { vin: 'AAA', name: '2020 Make Model A' };
const TEMPLATE = 'The 2020 Make Model A. Sales consultant at Example Motors.';
// the post as the other window's side panel saved it, and as this panel brought it back from storage
const broughtBack = { vin: 'AAA', windowId: 1, step: 'review', vehicle: { vin: 'AAA', name: A.name }, description: TEMPLATE, descriptionSource: 'template', photoPick: null, highlights: null, colorGuess: null, vinCheck: { local: { ok: true }, online: null }, saveId: 'save-1' };
const formOpenThere = { ...broughtBack, step: 'publish', fbTabId: 100, saveId: 'save-2' };
const FORM = { where: 'form', ...A };
const REVIEW = { where: 'review', ...A };

test('a refused save of a copy brought back from another window says what happened and what to do, keeps the typed text and names what else was lost', () => {
  const typed = TEMPLATE + '\nAsk for me by name.';
  const copy = { ...broughtBack, description: typed, descriptionSource: 'edited', photoPick: ['https://img.example.test/2.jpg'], listingTyped: null };
  const r = notSavedReport({ copy, broughtBack, saved: formOpenThere, other: FORM });
  assert.equal(r.text, "2020 Make Model A's Marketplace form is open from the side panel in another Chrome window, and the post changed there after this side panel showed it, so what was done here was not saved. Finish the post there; opening the side panel in that window brings it back.");
  assert.deepEqual(r.kept, [{ key: 'description', label: 'Description', value: typed }], 'the description typed here is kept, whole, closing line and all');
  // the text is this side panel's, typed here or not (a description begun or rewritten here), and
  // anything that leaves this screen clears it: Back, closing the panel, a To do item, set-up, a post
  assert.equal(r.keptText, 'The text from this side panel is below, kept on this screen only: copy it before you leave this screen.');
  assert.deepEqual(r.notSaved, ['the photos picked']);
  assert.equal(r.notSavedText, 'Not saved either, so do it again in that window if you still want it: the photos picked.');

  // the other window has the post at review: finish or stop it there
  const atReview = notSavedReport({ copy, broughtBack, saved: { ...broughtBack, saveId: 'save-2', description: 'typed in window 1' }, other: REVIEW });
  assert.equal(atReview.text, '2020 Make Model A is being posted from the side panel in another Chrome window, and the post changed there after this side panel showed it, so what was done here was not saved. Finish or stop the post there.');
});

// Use original on a cropped photo is part of choosing what goes on the
// listing: it is folded into "the photos picked", so the list of five stays.
// The photo check itself (branding) is automatic and never named.
test('a photo set back to the website\'s original here counts as the photos picked; the automatic photo check never does', () => {
  const back = ['https://img.example.test/2.jpg'];
  const r = notSavedReport({ copy: { ...broughtBack, photoOriginals: back }, broughtBack, saved: formOpenThere, other: FORM });
  assert.deepEqual(r.notSaved, ['the photos picked']);
  // a pick and a Use original together are still named once
  assert.deepEqual(notSavedReport({ copy: { ...broughtBack, photoPick: back, photoOriginals: back }, broughtBack, saved: formOpenThere, other: FORM }).notSaved, ['the photos picked']);
  // the same choice made in the other window is in the saved post: nothing lost
  assert.deepEqual(notSavedReport({ copy: { ...broughtBack, photoOriginals: back }, broughtBack, saved: { ...formOpenThere, photoOriginals: back }, other: FORM }).notSaved, []);
  // set back and then put back to cropped here: the copy is as it was brought back
  assert.deepEqual(notSavedReport({ copy: { ...broughtBack, photoOriginals: null }, broughtBack: { ...broughtBack, photoOriginals: null }, saved: formOpenThere, other: FORM }).notSaved, []);
  // a save from before photoOriginals was kept (no field at all) reads the same as none set back
  assert.deepEqual(notSavedReport({ copy: { ...broughtBack, photoOriginals: [] }, broughtBack, saved: formOpenThere, other: FORM }).notSaved, []);
  // the photo check that ran here (or a new one) is the panel's own work, done again by itself
  const checked = { version: 1, vin: 'AAA', checkedAt: '2026-10-08T12:00:00.000Z', lot: 0, photos: { [back[0]]: { status: 'cropped', crop: { x: 0, y: 0, w: 640, h: 432 }, width: 640, height: 480 } } };
  assert.deepEqual(notSavedReport({ copy: { ...broughtBack, branding: checked }, broughtBack, saved: formOpenThere, other: FORM }).notSaved, []);
  // begun here, with a photo set back: it is this panel's choice
  const mine = { ...broughtBack, windowId: 2, photoOriginals: back };
  assert.deepEqual(notSavedReport({ copy: mine, broughtBack: null, saved: formOpenThere, other: FORM }).notSaved, ['the photos picked']);
});

test('only what was done in this panel, and is not in the post the other window saved, is kept or named', () => {
  // nothing done here (the car read again at Open the Marketplace form, say): the panel says where
  // the post is and what to do, claims nothing was lost, and keeps and names nothing
  const idle = notSavedReport({ copy: { ...broughtBack }, broughtBack, saved: formOpenThere, other: FORM });
  assert.equal(idle.text, "2020 Make Model A's Marketplace form is open from the side panel in another Chrome window, and the post changed there after this side panel showed it. Finish the post there; opening the side panel in that window brings it back.");
  assert.deepEqual([idle.kept, idle.keptText, idle.notSaved, idle.notSavedText], [[], '', [], '']);
  assert.equal(notSavedReport({ copy: { ...broughtBack }, broughtBack, saved: { ...broughtBack, saveId: 'save-2' }, other: REVIEW }).text, '2020 Make Model A is being posted from the side panel in another Chrome window, and the post changed there after this side panel showed it. Finish or stop the post there.');

  // what the other window changed itself is its own, not something lost here
  const theirs = { ...formOpenThere, description: 'typed in window 1', photoPick: ['https://img.example.test/5.jpg'], colorGuess: { exterior: 'Red', interior: 'Black', confidence: 'high' } };
  const untouched = notSavedReport({ copy: { ...broughtBack }, broughtBack, saved: theirs, other: FORM });
  assert.deepEqual([untouched.kept, untouched.notSaved], [[], []], 'the copy as it was brought back loses nothing');

  // the same change made in both windows is in the saved post: nothing of it is lost
  const both = { photoPick: ['https://img.example.test/2.jpg'], description: TEMPLATE + ' Same.' };
  const same = notSavedReport({ copy: { ...broughtBack, ...both, descriptionSource: 'edited' }, broughtBack, saved: { ...formOpenThere, ...both }, other: FORM });
  assert.deepEqual([same.kept, same.notSaved], [[], []]);

  // every kind of change, each named once, in a fixed order; a rewrite's text is in the kept box
  const everything = {
    ...broughtBack,
    description: 'Rewritten here. Sales consultant at Example Motors.',
    descriptionSource: 'claude',
    photoPick: [],
    highlights: ['Heated seats'],
    colorGuess: { exterior: 'Blue', interior: 'Gray', confidence: 'medium' },
    vinCheck: { local: { ok: true }, online: { ok: true, decoded: {}, compare: [] } },
    listingTyped: ' https://www.facebook.com/marketplace/item/123/ ',
  };
  const all = notSavedReport({ copy: everything, broughtBack, saved: formOpenThere, other: FORM });
  assert.deepEqual(all.kept.map((k) => [k.key, k.label]), [['description', 'Description'], ['listingTyped', 'Listing link']]);
  assert.equal(all.kept[1].value, 'https://www.facebook.com/marketplace/item/123/', 'the link typed into Listing link, which no save keeps');
  assert.deepEqual(all.notSaved, ['the photos picked', 'the highlights picked', 'the rewrite with Claude (its text is below)', 'the colour guess from the photos', 'the VIN check with NHTSA']);
  assert.equal(all.notSavedText, 'Not saved either, so do them again in that window if you still want them: the photos picked, the highlights picked, the rewrite with Claude (its text is below), the colour guess from the photos, the VIN check with NHTSA.');

  // a colour guess that failed, or a VIN check that got no answer, is nothing to do again
  const failed = notSavedReport({ copy: { ...broughtBack, colorGuess: { error: 'no photos to look at' }, vinCheck: { local: { ok: true }, online: { ok: false, error: 'offline' } } }, broughtBack, saved: formOpenThere, other: FORM });
  assert.deepEqual(failed.notSaved, []);
  // nor is a blank Listing link box
  assert.deepEqual(notSavedReport({ copy: { ...broughtBack, listingTyped: '   ' }, broughtBack, saved: formOpenThere, other: FORM }).kept, []);
});

test('a copy of a post begun in this panel, or of another car than the one under way, counts everything in it as done here', () => {
  // begun here (nothing brought back): its text and what was asked for here are all its own
  const mine = { vin: 'AAA', windowId: 2, step: 'review', vehicle: { vin: 'AAA', name: A.name }, description: TEMPLATE, descriptionSource: 'template', photoPick: null, highlights: null, colorGuess: { exterior: 'Red', interior: '', confidence: 'low' }, vinCheck: { local: { ok: true }, online: null } };
  const r = notSavedReport({ copy: mine, broughtBack: null, saved: { ...formOpenThere, windowId: 1, description: 'typed in window 1' }, other: FORM });
  assert.deepEqual(r.kept, [{ key: 'description', label: 'Description', value: TEMPLATE }]);
  assert.deepEqual(r.notSaved, ['the colour guess from the photos'], 'nothing picked (null) is nothing lost');
  // the same text in the post the other window saved is not lost
  assert.deepEqual(notSavedReport({ copy: mine, broughtBack: null, saved: { ...formOpenThere, windowId: 1 }, other: FORM }).kept, []);

  // another car's post holds the website: none of this car's work is in it, and it is done again when this car is posted
  const other = { where: 'review', vin: 'BBB', name: '2021 Make Model B' };
  const elsewhere = notSavedReport({ copy: { ...broughtBack, photoPick: ['https://img.example.test/1.jpg'] }, broughtBack, saved: { vin: 'BBB', windowId: 1, step: 'review', vehicle: { name: other.name } }, other });
  assert.equal(elsewhere.text, '2021 Make Model B is being posted from the side panel in another Chrome window. One post from a website goes at a time, so what was done here for 2020 Make Model A was not saved. Finish or stop that post there first.');
  assert.equal(elsewhere.notSavedText, 'Not saved, so do it again when you post 2020 Make Model A if you still want it: the photos picked.', 'no kept text before it: no "either"');
  // the car already recorded as posted (from that other window, say): nothing says to redo it at its post
  const posted = notSavedReport({ copy: { ...broughtBack, photoPick: ['https://img.example.test/1.jpg'] }, broughtBack, saved: null, other, alreadyPosted: true });
  assert.equal(posted.notSavedText, 'Not saved, so do it again if you still want it: the photos picked.');
  const form = notSavedReport({ copy: { ...broughtBack, highlights: ['Heated seats'] }, broughtBack, saved: null, other: { ...other, where: 'form' } });
  assert.equal(form.text, "2021 Make Model B's Marketplace form is open from the side panel in another Chrome window. One post from a website goes at a time, so what was done here for 2020 Make Model A was not saved. Finish that post there first; opening the side panel in that window brings it back.");
  // nothing done here for this car: nothing is said to be lost
  assert.equal(notSavedReport({ copy: { ...broughtBack }, broughtBack, saved: null, other: { ...other, where: 'form' } }).text, "2021 Make Model B's Marketplace form is open from the side panel in another Chrome window. One post from a website goes at a time, so this side panel leaves its copy of 2020 Make Model A's post. Finish that post there first; opening the side panel in that window brings it back.");
  assert.equal(notSavedReport({ copy: { ...broughtBack }, broughtBack, saved: null, other }).text, "2021 Make Model B is being posted from the side panel in another Chrome window. One post from a website goes at a time, so this side panel leaves its copy of 2020 Make Model A's post. Finish or stop that post there first.");
  // a car with no name read yet goes by its VIN
  assert.match(notSavedReport({ copy: { ...broughtBack, vehicle: null, description: 'typed' }, broughtBack, saved: null, other }).text, /what was done here for AAA was not saved/);
  assert.match(notSavedReport({ copy: { ...broughtBack, vehicle: null }, broughtBack, saved: null, other }).text, /leaves its copy of AAA's post/);
});

test('a refused save is said only from a review, a fields check or a form waiting for Publish', () => {
  assert.deepEqual(NOT_SAVED_STEPS, ['review', 'probe', 'publish']);
  const copyAt = (step) => ({ ...broughtBack, step, description: 'typed here' });
  for (const step of NOT_SAVED_STEPS) assert.ok(notSavedReport({ copy: copyAt(step), broughtBack, saved: formOpenThere, other: FORM }), step);
  // a post recorded (the posted list has it), a car stopped (nothing to lose), a post starting or
  // opening its form (startFlow and openForm give way and say so themselves), or no post at all
  for (const step of ['done', 'blocked', 'checking', 'filling', 'idle', 'rules']) {
    assert.equal(notSavedReport({ copy: copyAt(step), broughtBack, saved: formOpenThere, other: FORM }), null, step);
  }
  assert.equal(notSavedReport({ copy: { ...copyAt('review'), vin: null }, broughtBack, saved: formOpenThere, other: FORM }), null, 'no car');
  assert.equal(notSavedReport({ copy: copyAt('review'), broughtBack, saved: formOpenThere, other: null }), null, 'not refused');
});

test('what the panel says of a refused save passes the copy checks', () => {
  const everything = { ...broughtBack, description: 'x', descriptionSource: 'claude', photoPick: [], highlights: ['a'], colorGuess: { exterior: 'Blue' }, vinCheck: { online: { ok: true } }, listingTyped: 'y' };
  for (const other of [FORM, REVIEW, { where: 'form', vin: 'BBB', name: 'B' }, { where: 'review', vin: 'BBB', name: 'B' }]) {
    for (const copy of [everything, { ...broughtBack }]) {
      const r = notSavedReport({ copy, broughtBack, saved: formOpenThere, other });
      for (const text of [r.text, r.keptText, r.notSavedText, ...r.kept.map((k) => k.label)]) assert.deepEqual(copyProblems(text), [], text);
    }
  }
});
