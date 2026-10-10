// A side panel in a second Chrome window can show a copy of the post that
// another window's side panel has under way (sidepanel.js resumeFlow). Once
// that window has changed the post (its form opened there, text typed
// there), or has another car's post from the website under way, a save of
// the copy is refused (sidepanel.js saveFlow): nothing is written over the
// newer post. This decides what the side panel then says and keeps on
// screen. Plain data in, plain data out; the panel draws it and gives way.

// The steps whose refused save is said: a review, a fields check, a form
// waiting for Publish. A post recorded (done: the posted list has it) loses
// nothing; a car the re-check stopped (blocked) shows why it stopped, and
// nothing more, as it does in one window, where its text is not shown again
// either; a post just starting or opening its form gives way and says so
// itself (startFlow, openForm).
export const NOT_SAVED_STEPS = Object.freeze(['review', 'probe', 'publish']);

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const text = (s) => String(s ?? '');

// The parts of a post a person changes in the side panel, in the order they
// are named: how each is read from a post, and what it is called once lost.
const description = (p) => text(p.description);
const photoPick = (p) => p.photoPick ?? null;
const highlights = (p) => p.highlights ?? null;
// a guess that failed, or a check that got no answer, is nothing to do again
const colorGuess = (p) => (p.colorGuess && !p.colorGuess.error ? p.colorGuess : null);
const vinOnline = (p) => (p.vinCheck && p.vinCheck.online && p.vinCheck.online.ok ? p.vinCheck.online : null);

/**
 * What the side panel says and keeps when a save of its copy of a post is refused.
 *   copy: the panel's post as it stands (the saved post's fields, the
 *     description as the box shows it, and listingTyped: what was typed into
 *     Listing link, which no save keeps).
 *   broughtBack: that post as the panel brought it back from storage, or null
 *     for a post begun in this panel (everything in it was done here).
 *   saved: the post saved for the website now, which the save left in place.
 *   other: whose post holds the website (sidepanel.js liveElsewhere):
 *     { where: 'form' | 'review', vin, name }.
 *   alreadyPosted: true when the copy's car (another car than other's) is
 *     already recorded as posted, so the text does not say to redo things
 *     when it is posted.
 * Returns null when nothing is said (no car, not refused, or a step outside
 * NOT_SAVED_STEPS). Otherwise { text, kept, keptText,
 * notSaved, notSavedText }: text says what happened and what to do; kept
 * lists the text typed or written here ({ key, label, value }) that the
 * panel shows to copy; notSaved names what else done here was lost. The
 * text says something was lost only when kept or notSaved has anything.
 * Something counts as done here when it changed since the copy was brought
 * back, and as lost when the saved post does not have it as well (another
 * car's post has none of it).
 */
export function notSavedReport({ copy, broughtBack = null, saved = null, other, alreadyPosted = false }) {
  if (!copy || !copy.vin || !other || !NOT_SAVED_STEPS.includes(copy.step)) return null;
  const sameCar = other.vin === copy.vin;
  const name = (copy.vehicle && copy.vehicle.name) || (sameCar && other.name) || copy.vin;
  const doneHere = (read) => (broughtBack ? !same(read(copy), read(broughtBack)) : read(copy) !== null && read(copy) !== '');
  const lost = (read) => doneHere(read) && !(sameCar && saved && same(read(copy), read(saved)));

  const kept = [];
  const keptDescription = description(copy).trim() !== '' && lost(description);
  if (keptDescription) kept.push({ key: 'description', label: 'Description', value: description(copy) });
  const link = text(copy.listingTyped).trim();
  if (link) kept.push({ key: 'listingTyped', label: 'Listing link', value: link });

  const notSaved = [];
  if (lost(photoPick)) notSaved.push('the photos picked');
  if (lost(highlights)) notSaved.push('the highlights picked');
  if (keptDescription && copy.descriptionSource === 'claude') notSaved.push('the rewrite with Claude (its text is below)');
  if (lost(colorGuess)) notSaved.push('the colour guess from the photos');
  if (lost(vinOnline)) notSaved.push('the VIN check with NHTSA');

  // what was lost is said only when something was (the car read again at
  // Open the Marketplace form loses nothing the person did)
  const lostAny = kept.length > 0 || notSaved.length > 0;
  let said;
  if (sameCar) {
    const changed = `the post changed there after this side panel showed it${lostAny ? ', so what was done here was not saved' : ''}`;
    said = other.where === 'form'
      ? `${name}'s Marketplace form is open from the side panel in another Chrome window, and ${changed}. Finish the post there; opening the side panel in that window brings it back.`
      : `${name} is being posted from the side panel in another Chrome window, and ${changed}. Finish or stop the post there.`;
  } else {
    const oneAtATime = `One post from a website goes at a time, so ${lostAny ? `what was done here for ${name} was not saved` : `this side panel leaves its copy of ${name}'s post`}.`;
    said = other.where === 'form'
      ? `${other.name}'s Marketplace form is open from the side panel in another Chrome window. ${oneAtATime} Finish that post there first; opening the side panel in that window brings it back.`
      : `${other.name} is being posted from the side panel in another Chrome window. ${oneAtATime} Finish or stop that post there first.`;
  }
  const one = notSaved.length === 1;
  // another car already recorded as posted is not posted again
  const again = sameCar ? ' in that window' : alreadyPosted ? '' : ` when you post ${name}`;
  const redo = `do ${one ? 'it' : 'them'} again${again} if you still want ${one ? 'it' : 'them'}`;
  return {
    text: said,
    kept,
    // the text may not have been typed here (a description begun or rewritten
    // here), and anything that takes this screen's place clears it
    keptText: kept.length ? 'The text from this side panel is below, kept on this screen only: copy it before you leave this screen.' : '',
    notSaved,
    notSavedText: notSaved.length ? `Not saved${kept.length ? ' either' : ''}, so ${redo}: ${notSaved.join(', ')}.` : '',
  };
}
