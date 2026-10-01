// The first-run wizard's pure parts (wizard.js draws them): which steps it
// has, and what the Account step shows. The Account step is there only when
// the extension has an account server to talk to (src/accountConfig.js
// accountsConfigured()): the committed config names the production project,
// so the shipped build has it (eleven steps); with an empty config the
// wizard has exactly the ten steps it had before accounts. The step's words are Settings' own
// (popup.js accountFieldset), so a salesperson who skips it and signs in
// later under Settings, Account meets the same labels.

const BASE_STEPS = Object.freeze(['welcome', 'scan', 'store', 'you', 'address', 'price', 'permission', 'rules', 'terms', 'done']);

// The steps in order, with 'account' right after 'you' when accounts are configured.
export function wizardSteps(configured = false) {
  if (!configured) return [...BASE_STEPS];
  const at = BASE_STEPS.indexOf('you') + 1;
  return [...BASE_STEPS.slice(0, at), 'account', ...BASE_STEPS.slice(at)];
}

export const ACCOUNT_WORDS = Object.freeze({
  intro: 'Sign in to share your posted list with your dealership: every salesperson sees the same listings and your manager sees who posted what. No password: a six-digit code is emailed to you.',
  email: 'Your email',
  sendCode: 'Send me a sign-in code',
  code: 'Code from the email',
  signIn: 'Sign in',
  signedInAs: 'Signed in as',
  invite: 'Join a dealership with an invite code.',
  inviteHint: 'Your manager gives you one; it works once.',
  inviteCode: 'Invite code',
  join: 'Join',
});

// Signing in never holds up set-up: the step always says how to go on without it.
export const LATER = Object.freeze({
  signIn: 'Signing in is optional here: click Skip for now and sign in later under Settings, Account.',
  join: 'No code yet? Click Next. If you started your dealership in the manager view, you are in it already and need no code; otherwise join later under Settings, Account.',
});

// The Terms step's summary of what Lot Current keeps, in plain text. With
// accounts configured a person can be signed in (here or later under
// Settings, Account), and then their posted list, post timings, to-do items
// and scan counts go to the dealership's account (src/sync.js syncPayload),
// so the summary says so in the words Settings' Saved data uses; it never
// says the data stays in the browser alone.
export function termsSummary(configured = false) {
  const synced = configured
    ? " While you are signed in, your posted list (each car's VIN, name and price, when you posted and updated it, the listing link and your name), your post timings, your to-do items (with the old and new price of a price change) and each scan's counts also sync to your dealership's account in Lot Current's database."
    : '';
  return "In short: Lot Current reads your dealership's website and the Marketplace form you open, keeps its data in your browser, records the usage numbers for the pilot (how long each post took, which fields it couldn't fill, how long sold cars and price changes stayed listed, each with the car's VIN and name, your name from Settings and, for a price change, the website's old and new price), and never your Facebook login."
    + synced
    + ' You publish every post yourself. Lot Current is not affiliated with Meta Platforms, Inc.';
}

const trimSlash = (u) => String(u || '').trim().replace(/\/+$/, '');
const sameAddress = (a, b) => trimSlash(a).toLowerCase() === trimSlash(b).toLowerCase();
const str = (v) => (typeof v === 'string' ? v : '');

// What the wizard keeps of a redeemed invite (src/account.js redeemInvite's
// membership): what the step says, nothing else.
export function joinedFrom(membership) {
  const m = membership && typeof membership === 'object' ? membership : {};
  return { dealershipName: str(m.dealershipName), role: str(m.role), websiteOrigin: str(m.websiteOrigin) };
}

// The sentence a Join answers with, as Settings says it; when the
// dealership's website is another one, where its listings sync.
export function joinedText(joined, origin = '') {
  if (!joined || typeof joined !== 'object') return '';
  let text = `Joined ${joined.dealershipName || 'the dealership'} as ${joined.role || 'a member'}.`;
  if (origin && joined.websiteOrigin && !sameAddress(joined.websiteOrigin, origin)) text += ` Its website is ${joined.websiteOrigin}: open it there to sync its listings.`;
  return text;
}

// On sign-in the rewrite service's address becomes the account's own
// function, as Settings does it (popup.js pointRewriteAtAccount): the address
// only. Whether the writer is used stays the person's choice, and a key typed
// for a self-hosted service is kept in case they switch back. The same object
// comes back when nothing changes.
export function rewriteAtAccount(rewrite, endpoint) {
  const rw = rewrite && typeof rewrite === 'object' ? rewrite : {};
  if (!endpoint || sameAddress(rw.endpoint, endpoint)) return rw;
  return { ...rw, endpoint };
}

/**
 * What the Account step shows.
 *   configured  accountsConfigured(); without it there is no step
 *   session     the stored session or null; only its user's email is read
 *   joined      joinedFrom(membership) once an invite code worked
 *   email       the address typed so far
 *   note        the last message while signed out (the code is on its way)
 *   error       the last failure, in the server's words
 *   origin      the website being set up
 * state is 'signedOut', 'codeSent', 'signedIn' or 'joined'. The Next button
 * reads "Skip for now" until the person is signed in, and works either way.
 */
export function accountStepModel({ configured = false, session = null, joined = null, email = '', note = '', error = '', origin = '' } = {}) {
  if (!configured) return { show: false, state: 'off', next: 'Next' };
  const signedIn = Boolean(session);
  const who = str(session && session.user && session.user.email) || str(email);
  const isJoined = signedIn && Boolean(joined && typeof joined === 'object');
  const state = !signedIn ? (note ? 'codeSent' : 'signedOut') : isJoined ? 'joined' : 'signedIn';
  const W = ACCOUNT_WORDS;
  return {
    show: true,
    state,
    heading: 'Your account',
    intro: signedIn ? '' : W.intro,
    signIn: signedIn ? null : { emailLabel: W.email, email: str(email), sendCode: W.sendCode, codeLabel: W.code, signIn: W.signIn },
    status: signedIn ? (who ? `${W.signedInAs} ${who}` : 'Signed in') : '',
    invite: signedIn && !isJoined ? { heading: W.invite, hint: W.inviteHint, label: W.inviteCode, join: W.join } : null,
    joined: isJoined ? joinedText(joined, origin) : '',
    note: signedIn ? '' : str(note),
    error: str(error),
    later: !signedIn ? LATER.signIn : !isJoined ? LATER.join : '',
    next: signedIn ? 'Next' : 'Skip for now',
  };
}
