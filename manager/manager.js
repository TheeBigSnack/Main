// The manager view's page: sign in by magic link when config.js names a
// Supabase project, read the dealership's rows with the anon key (row-level
// security decides what comes back; no service key anywhere near a browser),
// hand them to data.js and render. ?mock=1, or "Try with sample data" when
// nothing is configured, shows a made-up dealership without touching the
// network. Every number is computed in data.js so the tests cover it.
//
// The Billing card (Milestone 5) reads GET .../billing/status with the
// person's own token, starts the free pilot through the start_pilot()
// function in the database, and opens Stripe Checkout or the billing portal
// through POST .../billing/checkout and /portal: the function answers an
// address and the page goes there. Subscribe asks for a seat per salesperson
// the card shows, never fewer than the plan includes (data.js billingBody).
// Until config.js turns billing on (it comes with Stripe, docs/stripe-setup.md
// step 5) the page never calls the billing function: it reads the plan from
// the database as row-level security allows a member (data.js
// closedBillingStatus), a manager can still start the free pilot (it is the
// database's start_pilot(), not the function's), and the card says paying by
// card is not open yet, with no Subscribe or Manage billing.
// Stripe sends the manager back to this page with ?billing=success or
// ?billing=canceled, which becomes one note, and with ?dealership=<id>, so
// the page opens the dealership that paid (or opened the portal) and puts
// the note on its card only.
//
// The Invite codes card (managers only) lists the dealership's open codes
// through list_invites(), makes new ones with create_invite() and cancels one
// with revoke_invite(), all functions in the database that check the caller
// is a manager (the invites table itself has no read policy). Each code has
// Copy and Revoke; a code works once and for 7 days.
//
// Sign-in is a magic link in the PKCE flow: the link this page asks for
// carries a one-time code that supabase-js exchanges on this page (the code
// verifier waits in this browser's storage), so its tokens never travel in a
// URL, and the link only works in the browser that asked for it. The
// extension's emails land here too (the Site URL is this page); it sends a
// PKCE challenge whose verifier nobody keeps, so its link brings back only a
// code nothing can exchange. An address that still arrives with
// #access_token=... (a link asked for without a challenge) or the auth
// server's #error=... (and, for a refused link of this page's own, the same
// error in the query) is taken out of the address before supabase-js starts,
// the session those tokens opened is ended, and the sign-in form says why
// (data.js authFragment); a ?code= this browser could not exchange leaves
// the address the same way.
//
// Self-serve sign-up: a signed-in person in no dealership sees the Start your
// dealership form when config.js's selfServeSignup is on (otherwise the old
// "ask whoever set Lot Current up" line). It calls create_dealership() in the
// database, which is the real gate: it refuses while the owner has sign-up
// switched off, and its refusal is a sentence the form shows as it comes.
// ?mock=signup shows the form with create_dealership answered in this page.
//
// The Getting started card (managers only) sits above the other cards: four
// steps from a new dealership to two salespeople posting, from rows the page
// already reads (data.js gettingStarted), each with a button to the card that
// does it where there is one.

import { CONFIG } from './config.js';
import { summarize, mockData, managerCsv, csvFileName, fmtLocal, billingCard, billingBody, billingReturnNote, closedBillingStatus, inviteCard, teamCard, teamChangeNote, memberRole, gettingStarted, signupOriginNote, signupProblem, signupRefusal, mockCreateDealership, mockNewDealership, authFragment, authQueryError, readAll, UNUSED_CODE_NOTE, SIGNUP_WORDS, SIGNUP_EXAMPLE, OVERDUE_HOURS, INVITE_DAYS, DAY_MS } from './data.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const secs = (s) => (typeof s === 'number' ? `${s} s` : '—');
const hrs = (h) => (typeof h === 'number' ? `${h} h` : '—');
const money = (n) => (typeof n === 'number' ? '$' + n.toLocaleString('en-US') : '—');
const configured = () => Boolean(CONFIG.supabaseUrl && CONFIG.supabaseAnonKey);
const billingOpen = () => CONFIG.billing === true; // the billing function is deployed with its secrets
const trimSlash = (u) => String(u || '').trim().replace(/\/+$/, '');
// Where the Edge Functions answer: config.js's functionsUrl, else the
// project's own /functions/v1 (the extension derives it the same way).
const functionsUrl = () => trimSlash(CONFIG.functionsUrl) || trimSlash(CONFIG.supabaseUrl) + '/functions/v1';

const state = {
  mode: 'loading', // loading | unconfigured | signin | sent | signup | view | error
  mock: false,
  supabase: null,
  session: null,
  dealerships: [],
  dealershipId: null, // the dealership on screen, whose rows state.data holds: every button acts on it (loadLive sets it with the rows, never before)
  data: null, // { dealership, memberships, listings, todoItems, postAttempts, scans }
  billing: null, // { status, error }: GET .../billing/status's answer for the chosen dealership (the sample data carries its own)
  billingNote: '', // one line in the Billing card: back from Stripe, the pilot just started, or what a sample button would do
  billingNoteFor: '', // the dealership a note from Stripe's return is about ('' = the one on screen)
  invites: [], // the dealership's open codes (list_invites) and the ones made since: { code, role, dealership_id?, created_at, expires_at? }
  inviteNote: '', // one line in the Invite codes card: what a sample button would do
  inviteError: '', // the last failed create_invite or copy, shown in the card
  teamNote: '', // one line in the Team card: a change made, or what a sample button would do
  teamError: '', // the last refused change (the database's own sentence)
  teamConfirm: '', // the user id whose Remove was clicked once; the second click removes
};

// ---------- the page frame ----------

function setStatus(text, error = false) {
  const el = $('status');
  el.textContent = text || '';
  el.classList.toggle('error', Boolean(error && text));
}

function setActions(html) {
  $('actions').innerHTML = html;
}

function setDealer(text) {
  $('dealer').textContent = text;
}

// One query parameter set or removed in the address bar without a reload.
function setParam(name, value) {
  try {
    const url = new URL(location.href);
    if (value === null) url.searchParams.delete(name); else url.searchParams.set(name, value);
    history.replaceState(null, '', url.toString());
  } catch { /* some file:// pages refuse; the view is on screen either way */ }
}
const setUrlMock = (on) => setParam('mock', on ? '1' : null);

// This page's address with no query or fragment: where the sign-in link
// lands.
function pageUrl() {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  return url.toString();
}

// Where Stripe sends the manager back from Checkout or the portal: this page
// with the dealership the button was pressed for, so a manager of more than
// one comes back to that one (the billing function adds ?billing=... and
// keeps the rest; allowedReturnUrl checks only the origin).
function returnUrl(dealershipId) {
  const url = new URL(pageUrl());
  if (dealershipId) url.searchParams.set('dealership', dealershipId);
  return url.toString();
}

// ---------- the views ----------

function viewUnconfigured() {
  state.mode = 'unconfigured';
  setDealer('Manager view');
  setActions('');
  setStatus('');
  $('main').innerHTML = `
    <div class="banner setup">
      <p><b>Not set up yet.</b> This page has no account server to read from. The owner fills in <code>manager/config.js</code> with the Supabase project's address and public key (Milestone 4); until then there is nothing to sign in to.</p>
      <p>You can still see what the page will show:</p>
      <div class="toolbar"><button type="button" class="primary" data-action="mock">Try with sample data</button></div>
    </div>
    <p class="lead">The manager view shows who posted what, which sold cars are still listed and for how long, and which price changes have not reached the listing yet. It reads what the salespeople's Lot Current extensions record: VINs, listing links, prices and times. Nothing from Facebook beyond the listing links they saved, and never a description or a buyer.</p>`;
}

function viewSignIn(note = '') {
  state.mode = 'signin';
  setDealer('Manager view');
  setActions('');
  setStatus(note, false);
  $('main').innerHTML = `
    <div class="signin">
      <h2>Sign in</h2>
      <p class="lead">Managers get a sign-in link by email. There is no password.</p>
      <form id="signin">
        <input type="email" name="email" required autocomplete="email" placeholder="you@yourdealership.com" aria-label="Your email">
        <button type="submit" class="primary">Send me a sign-in link</button>
      </form>
      <p class="hint">Only people the dealership's Lot Current account lists can sign in. If the link does not arrive, check the spam folder, then ask whoever set Lot Current up for your store.</p>
      <div class="toolbar"><button type="button" class="ghost" data-action="mock">Try with sample data instead</button></div>
    </div>`;
  $('signin').addEventListener('submit', onSendLink);
}

function viewSent(email) {
  state.mode = 'sent';
  $('main').innerHTML = `
    <div class="signin">
      <h2>Check your email</h2>
      <p class="lead">A sign-in link is on its way to <b>${esc(email)}</b>. Open it in this browser on this device; it signs you in here, and it will not work in another browser.</p>
      <div class="toolbar"><button type="button" class="ghost" data-action="signin">Use another address</button></div>
    </div>`;
}

function viewError(message) {
  state.mode = 'error';
  setStatus(message, true);
  $('main').innerHTML = `<p class="empty">${esc(message)}</p><div class="toolbar"><button type="button" class="ghost" data-action="retry">Try again</button>${state.session ? '<button type="button" class="ghost" data-action="signout">Sign out</button>' : ''}</div>`;
}

// The Start your dealership form, for a signed-in person in no dealership.
// The line under the address box follows the typing: the origin Lot Current will
// keep, or why the address cannot be used. #signupError is the form's live
// region, on the page from the start so a screen reader announces what lands
// in it; the boxes keep what was typed whatever the answer.
function viewSignup() {
  state.mode = 'signup';
  setDealer('Manager view');
  const who = state.mock ? 'Sample data' : esc(state.session?.user?.email || '');
  setActions(`<span class="who">${who}</span><button type="button" class="ghost" data-action="signout">${state.mock ? 'Leave sample data' : 'Sign out'}</button>`);
  setStatus(state.mock ? 'Sample data: an account that is signed in and in no dealership yet. Starting one here calls nothing; it opens a new, empty sample dealership.' : '');
  const W = SIGNUP_WORDS;
  $('main').innerHTML = `
    <section class="card signup" id="startDealership">
      <h2>${esc(W.heading)}</h2>
      <p class="plan">${esc(W.lead)}</p>
      <form id="signup" novalidate>
        <label for="suName">${esc(W.name)}</label>
        <input type="text" id="suName" name="name" required autocomplete="organization">
        <label for="suWebsite">${esc(W.website)}</label>
        <input type="text" id="suWebsite" name="website" required inputmode="url" autocomplete="url" autocapitalize="off" spellcheck="false" placeholder="${esc(SIGNUP_EXAMPLE)}" aria-describedby="suOrigin">
        <p class="hint origin" id="suOrigin">${originNoteHtml('')}</p>
        <label for="suYou">${esc(W.yourName)}</label>
        <input type="text" id="suYou" name="your_name" required autocomplete="name">
        <div class="toolbar"><button type="submit" class="primary">${esc(W.submit)}</button></div>
        <p class="banner warn error" id="signupError" role="alert"></p>
      </form>
      <p class="hint">${esc(W.already)}</p>
    </section>`;
  $('signup').addEventListener('submit', onSignup);
  $('suWebsite').addEventListener('input', (ev) => {
    const el = $('suOrigin');
    el.innerHTML = originNoteHtml(ev.currentTarget.value);
    el.classList.toggle('unusable', Boolean(ev.currentTarget.value.trim()) && !signupOriginNote(ev.currentTarget.value).usable);
  });
}

function originNoteHtml(value) {
  const n = signupOriginNote(value);
  return `${n.keep ? `<b>${esc(n.keep)}</b> ` : ''}${esc(n.line)}`;
}

function pill(cls, text) {
  return `<span class="pill ${cls}">${esc(text)}</span>`;
}

// The Getting started card, for a manager: the four steps as a numbered list,
// each Done or To do in words, with one sentence and, for a step done on this
// page, a button to the card that does it. Once all four are done it is one
// line. The data is what the page already read: the plan, the open codes, the
// members and the listings.
function gettingStartedHtml() {
  if (!state.data || myRole() !== 'manager') return '';
  const g = gettingStarted({
    billing: state.mock ? state.data.billing : state.billing?.status,
    invites: state.invites,
    memberships: state.data.memberships,
    listings: state.data.listings,
    dealershipId: state.dealershipId,
    now: new Date().toISOString(),
    billingOpen: state.mock || billingOpen(), // the sample shows the whole page
  });
  if (g.allDone) return `<section class="card slim" id="gettingStarted"><h2>Getting started ${pill('good', g.line)}</h2></section>`;
  const steps = g.steps.map((s) => `<li><div class="row"><span class="name">${esc(s.title)}</span>${pill(s.done ? 'good' : '', s.done ? 'Done' : 'To do')}${s.action ? `<button type="button" class="ghost" data-action="goto" data-target="${esc(s.action.target)}">${esc(s.action.label)}</button>` : ''}</div><p class="hint">${esc(s.line)}</p></li>`).join('');
  return `<section class="card" id="gettingStarted"><h2>Getting started ${pill('', g.line)}</h2><ol class="steps">${steps}</ol></section>`;
}

function renderGettingStarted() {
  const el = $('gettingStarted');
  if (el) el.outerHTML = gettingStartedHtml();
}

// A Getting started button: the card that does the step comes into view and
// takes the keyboard focus, so Tab goes on from that card's first button.
function goToCard(id) {
  const el = $(id);
  if (!el) return;
  el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: true });
  const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
}

// The Billing card: the plan in one sentence, the seat line (a manager's:
// the salespeople against the seats included or paid for, and a warning
// when there are more salespeople than paid seats) and the buttons the
// status answer allows (managers only; data.js decides). In sample-data mode
// the buttons only explain themselves. A status that could not be read gets
// a Try again button and leaves the rest of the page alone.
function billingHtml() {
  const status = state.mock ? state.data?.billing : state.billing?.status;
  const error = state.mock ? '' : (state.billing && state.billing.error) || '';
  const card = billingCard(status, { now: new Date().toISOString() });
  const note = state.billingNote ? `<p class="banner info">${esc(state.billingNote)}</p>` : '';
  const seatLine = card.seatLine ? `<p class="plan">${esc(card.seatLine)}</p>` : '';
  const seatNote = card.seatNote ? `<p class="${card.seatTone === 'warn' ? 'banner warn' : 'hint'}">${esc(card.seatNote)}</p>` : '';
  const body = error
    ? `<p class="plan">Couldn't read the plan: ${esc(error)}</p><p class="hint">The rest of the page does not depend on it.</p>`
    : `<p class="plan">${esc(card.line)}</p>${seatLine}${card.detail ? `<p class="hint">${esc(card.detail)}</p>` : ''}${seatNote}`;
  const buttons = error
    ? '<button type="button" class="ghost" data-action="billing" data-billing="reload">Try again</button>'
    : card.buttons.map((b, i) => `<button type="button" class="${i === 0 ? 'primary' : 'ghost'}" data-action="billing" data-billing="${esc(b.action)}" data-does="${esc(b.does)}">${esc(b.label)}</button>`).join('');
  return `<section class="card" id="billing"><h2>Billing ${error ? pill('warn', 'Unknown') : pill(card.tone, card.label)}</h2>${note}${body}${buttons ? `<div class="toolbar">${buttons}</div>` : ''}</section>`;
}

function renderBilling() {
  const el = $('billing');
  if (el) el.outerHTML = billingHtml();
  renderGettingStarted(); // the plan is step 1
}

// The signed-in person's role in the chosen dealership: the memberships rows
// say so (a manager reads every row, a salesperson their own); the billing
// answer is the fallback when memberships could not be read. The sample is
// seen by its manager.
function myRole() {
  if (state.mock) return state.data?.billing?.role || '';
  return memberRole(state.data?.memberships, state.session?.user?.id) || state.billing?.status?.role || '';
}

// The Invite codes card: Invite a salesperson and Invite a manager, then
// each code made on this page in a box with Copy and the one sentence on
// what the person does with it. Drawn only for a manager (data.js decides);
// in sample-data mode the buttons only explain themselves.
function invitesHtml() {
  const card = inviteCard(state.invites, { role: myRole(), dealershipId: state.dealershipId, now: new Date().toISOString() });
  if (!card.manager) return '';
  const note = state.inviteNote ? `<p class="banner info">${esc(state.inviteNote)}</p>` : '';
  const error = state.inviteError ? `<p class="banner warn">${esc(state.inviteError)}</p>` : '';
  const buttons = card.buttons.map((b) => `<button type="button" class="ghost" data-action="invite" data-role="${esc(b.role)}" data-does="${esc(b.does)}">${esc(b.label)}</button>`).join('');
  const codes = card.codes.length
    ? `<ul class="codes">${card.codes.map((c) => `<li><div class="row"><span class="code">${esc(c.code)}</span><button type="button" class="ghost" data-action="copy" data-copy="${esc(c.copyText)}">Copy</button><button type="button" class="ghost" data-action="revoke" data-code="${esc(c.code)}">Revoke</button><span class="meta">${esc(c.line)}</span></div><p class="hint">${esc(c.sentence)}</p></li>`).join('')}</ul>`
    : '<p class="empty">No open codes.</p>';
  return `<section class="card" id="invites"><h2>Invite codes${card.codes.length ? ` ${pill('', `${card.codes.length} open`)}` : ''}</h2>${note}${error}<p class="plan">${esc(card.line)}</p><div class="toolbar">${buttons}</div>${codes}<p class="hint">${esc(card.hint)}</p></section>`;
}

// The Team card (managers only): each member with their role, Make manager or
// Make salesperson, and Remove (two clicks). The database refuses to leave the
// dealership without a manager; its sentence is shown as it comes.
function teamHtml() {
  const card = teamCard(state.data?.memberships, { role: myRole(), userId: state.mock ? '' : state.session?.user?.id, dealershipId: state.dealershipId, confirm: state.teamConfirm });
  if (!card.manager) return '';
  const note = state.teamNote ? `<p class="banner info">${esc(state.teamNote)}</p>` : '';
  const error = state.teamError ? `<p class="banner warn">${esc(state.teamError)}</p>` : '';
  const rowsHtml = card.members.map((m) => `<li><div class="row"><span class="name">${esc(m.name)}${m.you ? ' <span class="meta">(you)</span>' : ''}</span>${pill(m.role === 'manager' ? 'good' : '', m.role)}${m.roleAction ? `<button type="button" class="ghost" data-action="role" data-user="${esc(m.userId)}" data-to="${esc(m.roleAction.to)}">${esc(m.roleAction.label)}</button>` : ''}${m.remove ? `<button type="button" class="ghost${m.remove.armed ? ' danger' : ''}" data-action="remove" data-user="${esc(m.userId)}">${esc(m.remove.label)}</button>` : ''}${m.note ? `<span class="meta">${esc(m.note)}</span>` : ''}</div></li>`).join('');
  return `<section class="card" id="team"><h2>Team ${pill('', `${card.members.length}`)}</h2>${note}${error}<p class="plan">${esc(card.line)}</p><ul class="codes team">${rowsHtml}</ul><p class="hint">${esc(card.hint)}</p></section>`;
}

function renderTeam() {
  const el = $('team');
  if (el) el.outerHTML = teamHtml();
}

// Make manager / Make salesperson: an update of the member's role, which RLS
// allows a manager of the dealership and the column grant limits to role and
// name. Remove: the first click arms the button, the second deletes the
// membership (the trigger then cancels the invite codes they made).
// Both ask for the changed row back, and the card says what the answer
// shows (data.js teamChangeNote): no row means nothing changed. The reload
// after it has its own sentence, so a failed read never reads as a failed
// change.
// A change answers after the manager may have picked another dealership: its
// sentence is then about a card no longer shown, so it is dropped, and the
// pick is not undone by a reload of the old one.
async function onTeam(kind, userId, to) {
  state.teamError = '';
  const member = (state.data?.memberships || []).find((m) => m.user_id === userId);
  const who = (member && member.name) || 'this person';
  if (kind === 'remove' && state.teamConfirm !== userId) {
    state.teamConfirm = userId;
    state.teamNote = '';
    return renderTeam();
  }
  state.teamConfirm = '';
  if (state.mock) {
    state.teamNote = kind === 'remove' ? `Sample data: "Remove" would take ${who} out of the dealership and cancel the codes they made. Nothing is called here.` : `Sample data: this would make ${who} a ${to}. Nothing is called here.`;
    return renderTeam();
  }
  const dealershipId = state.dealershipId; // the dealership on screen when it was pressed
  try {
    const q = state.supabase.from('memberships');
    const { data, error } = kind === 'remove'
      ? await q.delete().eq('user_id', userId).eq('dealership_id', dealershipId).select('user_id')
      : await q.update({ role: to }).eq('user_id', userId).eq('dealership_id', dealershipId).select('user_id');
    if (error) throw new Error(error.message);
    if (shownOrPicked() !== dealershipId) return;
    state.teamNote = teamChangeNote(kind, member && member.name, to, data);
  } catch (e) {
    const said = `Couldn't change the team: ${(e && e.message) || e}`;
    if (shownOrPicked() !== dealershipId) return setStatus(said, true); // not on another dealership's Team card
    state.teamError = said;
    return renderTeam();
  }
  try {
    await loadLive(dealershipId);
  } catch (e) {
    setStatus('');
    state.teamError = `Couldn't refresh the page afterwards: ${(e && e.message) || e}. Reload the page to see the team as it is now.`;
    renderTeam();
  }
}

function renderInvites() {
  const el = $('invites');
  if (el) el.outerHTML = invitesHtml();
  renderGettingStarted(); // an open code is step 2
}

function viewData() {
  state.mode = 'view';
  const d = state.data;
  const s = summarize({ ...d, wholeTeam: myRole() === 'manager', now: new Date().toISOString() }); // a manager reads every membership row
  const dealer = d.dealership?.name || 'Your dealership';
  setDealer(dealer);
  const who = state.mock ? 'Sample data' : esc(state.session?.user?.email || '');
  const pick = state.dealerships.length > 1
    ? `<select id="pickDealer" aria-label="Dealership">${state.dealerships.map((x) => `<option value="${esc(x.id)}"${x.id === state.dealershipId ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select>`
    : '';
  setActions(`<span class="who">${who}</span>${pick}<button type="button" class="ghost go" data-action="csv">Download CSV</button><button type="button" class="ghost" data-action="signout">${state.mock ? 'Leave sample data' : 'Sign out'}</button>`);
  setStatus(state.mock ? 'Sample data: a made-up dealership so the page can be tried before an account exists. Nothing here is real.' : '');

  const scan = s.lastScan
    ? `<p class="meta">${esc(s.lastScan.line)} ${s.lastScan.stale ? pill('warn', `${hrs(s.lastScan.hoursAgo)} ago; rescans run every 3 hours while a salesperson's Chrome is open`) : pill('', `${hrs(s.lastScan.hoursAgo)} ago`)}</p>`
    : '<p class="meta">No scan recorded yet. The numbers start with the first scan from a salesperson\'s extension.</p>';

  const peopleRows = s.salespeople.length
    ? s.salespeople.map((p) => `<tr><td class="name">${esc(p.name)}</td><td class="n">${p.postedThisWeek}</td><td class="n">${p.postedAllTime}</td><td class="n">${secs(p.medianSeconds)}</td><td class="n">${p.listed}</td><td class="n hide-narrow">${p.takenDown}</td></tr>`).join('')
    : '<tr><td colspan="6" class="empty">No salesperson has posted yet.</td></tr>';
  const people = `<h2>Salespeople ${pill(s.totals.postedThisWeek ? 'good' : '', `${s.totals.postedThisWeek} posted this week`)}</h2>
    <div class="scroll"><table class="stats" id="salespeople">
      <thead><tr><th>Salesperson</th><th class="n">Posted this week</th><th class="n">All time</th><th class="n">Median seconds per post</th><th class="n">Listings up</th><th class="n hide-narrow">Taken down</th></tr></thead>
      <tbody>${peopleRows}</tbody>
      <tfoot><tr><td>Everyone</td><td class="n">${s.totals.postedThisWeek}</td><td class="n">${s.totals.postedAllTime}</td><td class="n">${secs(s.totals.medianSeconds)}</td><td class="n">${s.totals.listed}</td><td class="n hide-narrow">${s.totals.takenDown}</td></tr></tfoot>
    </table></div>
    <p class="hint">"This week" is the last 7 days. Seconds per post run from the click on Post to "It's posted", the salesperson's own review and Publish click included.</p>`;

  const car = (o) => `<td class="name">${o.listingUrl ? `<a href="${esc(o.listingUrl)}" target="_blank" rel="noopener">${esc(o.name)}</a>` : esc(o.name)}<div class="sub">${esc(o.salesperson || 'no salesperson on record')} · ${esc(o.vin)}</div></td>`;
  const age = (o) => `<td class="n">${pill(o.overdue ? 'bad' : '', hrs(o.hoursOpen))}</td>`;
  const sold = `<section><h2>Sold cars still listed ${pill(s.soldStillListed.length ? (s.soldStillListed.some((o) => o.overdue) ? 'bad' : 'warn') : s.clear.sold.tone, String(s.soldStillListed.length))}</h2>
    ${s.soldStillListed.length
      ? `<div class="scroll"><table class="stats" id="soldStillListed"><thead><tr><th>Car</th><th class="n">Open for</th></tr></thead><tbody>${s.soldStillListed.map((o) => `<tr>${car(o)}${age(o)}</tr>`).join('')}</tbody></table></div>
         <p class="hint">Longest first. Red past ${OVERDUE_HOURS} hours. Hours run from the scan that flagged the car; the salesperson sees the same item on their To do tab.</p>`
      : `<p class="empty">${esc(s.clear.sold.line)}</p>`}
    ${s.takeDowns.done ? `<p class="hint">${s.takeDowns.done} taken down so far, median ${hrs(s.takeDowns.medianHours)} after the flagging scan${s.takeDowns.cleared ? `; ${s.takeDowns.cleared} cleared by the website (the car came back)` : ''}.</p>` : ''}
  </section>`;

  const priceCell = (o) => {
    const both = typeof o.fromPrice === 'number' && typeof o.toPrice === 'number';
    const dir = both ? (o.toPrice < o.fromPrice ? 'down' : 'up') : '';
    return `<td class="n">${money(o.fromPrice)} <span class="arrow">→</span> <span class="${dir}">${money(o.toPrice)}</span></td>`;
  };
  const prices = `<section><h2>Price changes not yet updated ${pill(s.priceMismatches.length ? (s.priceMismatches.some((o) => o.overdue) ? 'bad' : 'warn') : s.clear.price.tone, String(s.priceMismatches.length))}</h2>
    ${s.priceMismatches.length
      ? `<div class="scroll"><table class="stats" id="priceMismatches"><thead><tr><th>Car</th><th class="n">Listing → website</th><th class="n">Open for</th></tr></thead><tbody>${s.priceMismatches.map((o) => `<tr>${car(o)}${priceCell(o)}${age(o)}</tr>`).join('')}</tbody></table></div>
         <p class="hint">The listing price must match the website; the salesperson updates it from their To do tab. Red past ${OVERDUE_HOURS} hours.</p>`
      : `<p class="empty">${esc(s.clear.price.line)}</p>`}
    ${s.priceUpdates.done ? `<p class="hint">${s.priceUpdates.done} updated so far, median ${hrs(s.priceUpdates.medianHours)} after the flagging scan${s.priceUpdates.cleared ? `; ${s.priceUpdates.cleared} cleared by the website (the price went back)` : ''}.</p>` : ''}
  </section>`;

  // listings up from people no longer in the dealership (a manager's view only): nobody's extension rescans them
  const unwatched = s.unwatched.length
    ? `<section id="unwatched"><h2>Listings nobody's extension watches ${pill('warn', String(s.unwatched.length))}</h2>
    <div class="scroll"><table class="stats"><thead><tr><th>Car</th><th class="n">Posted</th></tr></thead><tbody>${s.unwatched.map((o) => `<tr>${car(o)}<td class="n">${esc(fmtLocal(o.postedAt))}</td></tr>`).join('')}</tbody></table></div>
    <p class="hint">Posted by people who are no longer in the dealership's Lot Current account. Lot Current still counts them as up, but no extension rescans them now, so a sale or a price change on them is not flagged here, and Lot Current cannot see whether they are still on Marketplace.</p></section>`
    : '';

  $('main').innerHTML = gettingStartedHtml() + scan + billingHtml() + invitesHtml() + teamHtml() + people + `<div class="grid two">${sold}${prices}</div>` + unwatched;
  const sel = $('pickDealer');
  // the page and its buttons stay on the shown dealership until the chosen one's rows are in (loadLive)
  if (sel) sel.addEventListener('change', () => { state.billingNote = ''; state.inviteNote = ''; state.inviteError = ''; state.teamNote = ''; state.teamError = ''; state.teamConfirm = ''; loadLive(sel.value).catch((e) => viewError(e.message)); });
}

// ---------- actions ----------

document.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-action]');
  if (!btn) return;
  switch (btn.dataset.action) {
    case 'mock': showMock(); break;
    case 'csv': downloadCsv(); break;
    case 'signin': viewSignIn(); break;
    case 'retry': start(); break;
    case 'signout': signOut(); break;
    case 'billing': onBilling(btn.dataset.billing, btn); break;
    case 'invite': onInvite(btn.dataset.role, btn); break;
    case 'copy': copyCode(btn.dataset.copy, btn); break;
    case 'revoke': onRevoke(btn.dataset.code, btn); break;
    case 'role': onTeam('role', btn.dataset.user, btn.dataset.to); break;
    case 'remove': onTeam('remove', btn.dataset.user); break;
    case 'goto': goToCard(btn.dataset.target); break;
    default: break;
  }
});

function showMock() {
  loads += 1; // a live load still running draws nothing over the sample
  state.mock = true;
  state.data = mockData(new Date().toISOString());
  state.dealerships = [state.data.dealership];
  state.dealershipId = state.data.dealership.id;
  state.invites = state.data.invites || [];
  state.inviteNote = '';
  state.inviteError = '';
  setUrlMock(true);
  viewData();
}

// ?mock=signup: an account that is signed in and in no dealership, shown the
// Start your dealership form whatever config.js says. mockClient answers
// create_dealership, and the form lands in a new, empty sample dealership.
function showMockSignup() {
  loads += 1;
  state.mock = true;
  state.data = null;
  state.dealerships = [];
  state.dealershipId = null;
  state.invites = [];
  state.inviteNote = '';
  state.inviteError = '';
  viewSignup();
}

// ---------- sign-up ----------

// The sample-data stand-in for the Supabase client: create_dealership is
// answered in the page (data.js mockCreateDealership) and nothing else is
// called. No network.
const mockClient = {
  rpc: async (fn, args) => (fn === 'create_dealership' ? mockCreateDealership(args) : { data: null, error: { message: 'sample data: nothing is called here' } }),
};

// One line in the form's live region. It is emptied first and filled a
// moment later, so the same sentence twice in a row is announced twice.
function signupSay(text) {
  const el = $('signupError');
  if (!el) return;
  el.textContent = '';
  if (text) setTimeout(() => { el.textContent = text; }, 50);
}

// Start the dealership: the form's own checks first (the three boxes and a
// usable address), then create_dealership(name, website, your_name) in the
// database, which becomes this person's dealership with them as its manager
// and answers { dealership_id, name, website_origin }. A refusal is the
// database's sentence in the live region, and every box keeps what was
// typed. Success reads the page again, into the new dealership.
async function onSignup(ev) {
  ev.preventDefault();
  const form = ev.currentTarget;
  const box = (n) => form.elements.namedItem(n);
  const name = box('name').value.trim();
  const website = box('website').value.trim();
  const yourName = box('your_name').value.trim();
  const problem = signupProblem({ name, website, yourName });
  if (problem) {
    signupSay(problem.message);
    box(problem.field).focus();
    return;
  }
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  signupSay('');
  setStatus('Starting the dealership…');
  let answer;
  try {
    const client = state.mock ? mockClient : state.supabase;
    answer = await client.rpc('create_dealership', { name, website, your_name: yourName });
  } catch (e) {
    answer = { data: null, error: { message: (e && e.message) || String(e) } };
  }
  setStatus('');
  if (!answer || answer.error) {
    button.disabled = false;
    if (!document.activeElement || document.activeElement === document.body) button.focus(); // a disabled button drops the focus
    return signupSay(signupRefusal(answer && answer.error));
  }
  const made = answer.data && typeof answer.data === 'object' ? answer.data : {};
  state.billingNote = '';
  state.inviteNote = '';
  state.inviteError = '';
  state.teamNote = '';
  state.teamError = '';
  state.teamConfirm = '';
  if (state.mock) {
    state.data = mockNewDealership(made, { yourName, now: new Date().toISOString() });
    state.dealerships = [state.data.dealership];
    state.dealershipId = state.data.dealership.id;
    state.invites = [];
    viewData();
  } else {
    try {
      await loadLive(made.dealership_id || null);
    } catch (e) {
      return viewError(`The dealership is started, but the page couldn't read it: ${(e && e.message) || e}`);
    }
  }
  if (state.mode === 'view') goToCard('gettingStarted'); // the whole page changed: the keyboard starts at the first step
}

function downloadCsv() {
  if (!state.data) return;
  const now = new Date().toISOString();
  const dealer = state.data.dealership?.name || '';
  const csv = managerCsv(state.data, { now, dealer, origin: state.data.dealership?.website_origin || '' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = csvFileName(now, { dealer });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function signOut() {
  state.billingNote = '';
  state.invites = []; // the sample's code, or codes that belong to the person signing out
  state.inviteNote = '';
  state.inviteError = '';
  if (state.mock) {
    state.mock = false;
    state.data = null;
    setUrlMock(false);
    if (configured()) {
      if (state.session) return loadLive().catch((e) => viewError(e.message));
      return viewSignIn();
    }
    return viewUnconfigured();
  }
  if (state.supabase) {
    // scope local: this browser's session only; the person's extension and other browsers stay signed in
    const { error } = await state.supabase.auth.signOut({ scope: 'local' });
    if (error) return setStatus(`Couldn't sign out: ${error.message}`, true);
  }
  loads += 1; // a load still running for the signed-out person draws nothing
  state.session = null;
  state.data = null;
  state.billing = null;
  viewSignIn('Signed out.');
}

// ---------- invite codes ----------

// Invite a salesperson or Invite a manager: create_invite() in the database
// answers { code, dealership_id, role } for a manager of the dealership and
// refuses anyone else; the answer joins state.invites and the card redraws.
// A failure is one line in the card, never the page's. The sample data only
// says what the button would do.
async function onInvite(role, btn) {
  const label = btn.textContent;
  state.inviteError = '';
  if (state.mock) {
    state.inviteNote = `Sample data: "${label}" ${btn.dataset.does || 'would ask the account server for a code'}. Nothing is called here.`;
    return renderInvites();
  }
  btn.disabled = true;
  const dealershipId = state.dealershipId;
  try {
    const { data, error } = await state.supabase.rpc('create_invite', { dealership_id: dealershipId, role });
    if (error) throw new Error(error.message);
    const answer = data && typeof data === 'object' ? data : {};
    if (!answer.code) throw new Error('the server answered without a code');
    const made = new Date();
    state.invites.unshift({ code: answer.code, role: answer.role || role, dealership_id: answer.dealership_id || dealershipId, created_at: made.toISOString(), expires_at: answer.expires_at || new Date(made.getTime() + INVITE_DAYS * DAY_MS).toISOString() });
    state.inviteNote = '';
  } catch (e) {
    state.inviteError = `Couldn't ${label.toLowerCase()}: ${(e && e.message) || e}`;
  }
  renderInvites();
}

// Revoke: revoke_invite() deletes an unused code of a dealership the caller
// manages and answers true, or false without saying why (an unknown code, a
// used one and another dealership's read the same). Either way the code
// leaves the card: false means it was not open anyway.
async function onRevoke(code, btn) {
  state.inviteError = '';
  if (state.mock) {
    state.inviteNote = `Sample data: "Revoke" would cancel ${code} so nobody can use it. Nothing is called here.`;
    return renderInvites();
  }
  btn.disabled = true;
  try {
    const { data, error } = await state.supabase.rpc('revoke_invite', { code });
    if (error) throw new Error(error.message);
    state.invites = state.invites.filter((i) => String(i.code).toUpperCase() !== String(code).toUpperCase());
    state.inviteNote = data === true ? `${code} is revoked; nobody can use it now.` : `${code} was no longer open (used, expired or revoked already).`;
  } catch (e) {
    state.inviteError = `Couldn't revoke ${code}: ${(e && e.message) || e}`;
  }
  renderInvites();
}

// The dealership's open codes, for a manager; anyone else gets an empty list
// without asking (the function would answer 42501). A failed read is the
// card's error line.
async function loadInvites(dealershipId, role) {
  if (role !== 'manager') return { invites: [], error: '' };
  const { data, error } = await state.supabase.rpc('list_invites', { dealership_id: dealershipId });
  if (error) return { invites: [], error: `Couldn't read the open codes: ${error.message}` };
  return { invites: (Array.isArray(data) ? data : []).map((i) => ({ ...i, dealership_id: dealershipId })), error: '' };
}

// Copy puts the code alone on the clipboard (the install email has a
// [code] bracket for it). A page opened from disk or over plain http has no
// clipboard; the code is selectable either way.
async function copyCode(code, btn) {
  try {
    await navigator.clipboard.writeText(code);
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  } catch {
    state.inviteError = 'Couldn\'t reach the clipboard: select the code and copy it by hand.';
    renderInvites();
  }
}

// ---------- billing ----------

// Start the free pilot, Subscribe, Manage billing, or Try again after a
// failed status read. Checkout and the portal answer an address to open;
// the page goes there and comes back with ?billing=... The sample data only
// says what the button would do.
async function onBilling(kind, btn) {
  if (kind === 'reload') return reloadBilling();
  const label = btn.textContent;
  if (state.mock) {
    state.billingNote = `Sample data: "${label}" ${btn.dataset.does || 'would act on a real dealership'}. Nothing is called here.`;
    return renderBilling();
  }
  btn.disabled = true;
  setStatus('');
  try {
    if (kind === 'pilot') {
      const dealershipId = state.dealershipId; // the dealership on screen when it was pressed
      const { data, error } = await state.supabase.rpc('start_pilot', { dealership_id: dealershipId });
      if (error) throw new Error(error.message);
      if (shownOrPicked() !== dealershipId) return; // another dealership was picked since: the sentence is not about it
      state.billingNote = data && data.started === false ? 'The pilot was not started again; the plan below is where the dealership stands.' : 'The free pilot has started.';
      return reloadBilling();
    }
    const route = kind === 'portal' ? 'portal' : 'checkout';
    const answer = await callFunction('POST', `billing/${route}`, billingBody(route, state.billing?.status, { returnUrl: returnUrl(state.dealershipId), dealershipId: state.dealershipId }));
    if (!answer.url) throw new Error('the server returned no address to open');
    setStatus(route === 'portal' ? 'Opening the billing portal…' : 'Opening Checkout…');
    location.assign(answer.url);
  } catch (e) {
    btn.disabled = false;
    setStatus(`Couldn't ${label.toLowerCase()}: ${(e && e.message) || e}`, true);
  }
}

// The Edge Functions want the person's token as the bearer and the anon
// key as apikey (the extension sends the same pair). supabase-js refreshes
// the token on its own; asking for the session gets the current one.
async function freshToken() {
  const { data, error } = await state.supabase.auth.getSession();
  if (error || !data.session) throw new Error('not signed in');
  state.session = data.session;
  return data.session.access_token;
}

async function callFunction(method, path, body = null) {
  const headers = { apikey: CONFIG.supabaseAnonKey, Authorization: `Bearer ${await freshToken()}` };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${functionsUrl()}/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let answer = null;
  try {
    answer = await res.json();
  } catch {
    answer = null;
  }
  const a = answer && typeof answer === 'object' ? answer : {};
  if (!res.ok || !a.ok) throw new Error(a.error || a.msg || a.message || (res.status === 401 ? 'not signed in' : `the server answered ${res.status}`));
  return a;
}

// GET .../billing/status for one dealership, or before billing opens the
// plan as the database shows it to a member (readPlan); a failure becomes
// the card's error line, never the page's.
async function loadBilling(dealershipId) {
  try {
    const status = billingOpen() ? await callFunction('GET', `billing/status?dealershipId=${encodeURIComponent(dealershipId)}`) : await readPlan(dealershipId);
    return { status, error: '' };
  } catch (e) {
    return { status: null, error: (e && e.message) || String(e) };
  }
}

// Before billing opens: the dealership's subscriptions row (a member reads
// their own dealership's, 0004_billing.sql) and subscription_state(), the
// word /sync serves by, so a pilot the owner recorded by agreement shows
// with its end date. No billing function, so nothing a browser's origin
// could be refused for. The function's answer would carry the caller's role;
// this one gets it from the page's own memberships (withRole), which decide
// whether Start the free pilot shows.
async function readPlan(dealershipId) {
  const [row, word] = await Promise.all([
    state.supabase.from('subscriptions').select('*').eq('dealership_id', dealershipId),
    state.supabase.rpc('subscription_state', { dealership_id: dealershipId }),
  ]);
  if (row.error) throw new Error(row.error.message);
  if (word.error) throw new Error(word.error.message);
  return closedBillingStatus(word.data, Array.isArray(row.data) ? row.data[0] || null : null);
}

function withRole(billing, role) {
  const s = billing && billing.status;
  return s && s.open === false ? { ...billing, status: closedBillingStatus(s.state, s.subscription, { role }) } : billing;
}

async function reloadBilling() {
  const dealershipId = state.dealershipId;
  const billing = await loadBilling(dealershipId);
  if (state.dealershipId !== dealershipId) return; // another dealership is on screen now: its own plan is there
  state.billing = withRole(billing, myRole());
  renderBilling();
}

async function onSendLink(ev) {
  ev.preventDefault();
  const form = ev.currentTarget;
  const email = form.elements.email.value.trim();
  if (!email) return;
  const button = form.querySelector('button');
  button.disabled = true;
  setStatus('Sending the link…');
  try {
    const supabase = state.supabase || (await connect()); // after "Leave sample data" the client may not exist yet
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: pageUrl() } });
    if (error) throw new Error(error.message);
  } catch (e) {
    button.disabled = false;
    return setStatus(`Couldn't send the link: ${(e && e.message) || e}`, true);
  }
  button.disabled = false;
  setStatus('');
  viewSent(email);
}

// ---------- live data ----------

async function connect() {
  if (state.supabase) return state.supabase;
  const mod = await import(CONFIG.supabaseJs);
  // PKCE: the magic link brings back a one-time code, which supabase-js exchanges here (detectSessionInUrl)
  state.supabase = mod.createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, { auth: { flowType: 'pkce' } });
  state.supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_IN' && !state.session) {
      state.session = session;
      if (!state.mock) loadLive().catch((e) => viewError(e.message));
    } else if (event === 'SIGNED_OUT' && state.session) {
      loads += 1;
      state.session = null;
      state.data = null;
      if (!state.mock) viewSignIn('Signed out.');
    }
  });
  return state.supabase;
}

// select() under row-level security: a member gets their own dealership's
// rows and nothing else, whatever this page asks for. The eq() on
// dealership_id only matters for someone who belongs to more than one.
// Every table is read whole, page by page (data.js readAll: the API answers
// at most its row cap per request and drops the rest silently), in an order
// that ends on a unique column so the pages neither overlap nor skip; only
// the scans stop at the latest 50, which is all the page shows of them.
//
// `wanted` is the dealership to open (the picker's choice, a new sign-up's);
// by default the one on screen, else the first by name. Loads can overlap (a
// manager picks one store and then another, a cold function answers late),
// so each load is numbered, and only the latest writes anything: it sets
// the rows, the plan, the codes and state.dealershipId together and draws
// them, and an older one's answer, or its error, is dropped. Until then the
// page and its buttons stay on the dealership already shown.
let loads = 0;
let loading = null; // { seq, wanted }: the dealership the latest load opens, while it runs
async function loadLive(wanted = state.dealershipId) {
  const seq = ++loads;
  loading = { seq, wanted };
  try {
    return await loadDealership(wanted, () => seq === loads);
  } catch (e) {
    if (seq === loads) throw e;
  } finally {
    if (loading && loading.seq === seq) loading = null;
  }
}

// The dealership a button's answer is for when it comes back: the one a load
// still running is opening (a manager's pick), else the one on screen. An
// answer about another one leaves the page alone.
function shownOrPicked() {
  return loading && loading.seq === loads ? loading.wanted : state.dealershipId;
}

async function loadDealership(wanted, current) {
  const supabase = state.supabase;
  setStatus('Loading…');
  const read = async (table, build = (q) => q) => {
    try {
      return await readAll((from, to) => build(supabase.from(table).select('*', from === 0 ? { count: 'exact' } : undefined)).range(from, to));
    } catch (e) {
      throw new Error(`Couldn't read ${table}: ${(e && e.message) || e}`);
    }
  };
  const latest = async (table, build) => {
    const { data, error } = await build(supabase.from(table).select('*'));
    if (error) throw new Error(`Couldn't read ${table}: ${error.message}`);
    return data || [];
  };
  const dealerships = await read('dealerships', (q) => q.order('name').order('id'));
  if (!current()) return;
  if (!dealerships.length) {
    setStatus('');
    state.dealerships = [];
    state.dealershipId = null;
    state.data = null;
    // the flag only shows the form; create_dealership refuses while the owner's switch in the database is off
    if (CONFIG.selfServeSignup) return viewSignup();
    $('main').innerHTML = '<p class="empty">Your account is not a member of any dealership yet. Ask whoever set Lot Current up for your store to add you.</p><div class="toolbar"><button type="button" class="ghost" data-action="signout">Sign out</button></div>';
    setActions(`<span class="who">${esc(state.session?.user?.email || '')}</span>`);
    state.mode = 'view';
    return;
  }
  const dealership = dealerships.find((d) => d.id === wanted) || dealerships[0];
  const own = (q) => q.eq('dealership_id', dealership.id);
  const [memberships, listings, todoItems, postAttempts, scans, billing] = await Promise.all([
    read('memberships', (q) => own(q).order('user_id')),
    read('listings', (q) => own(q).order('posted_at', { ascending: false }).order('id')),
    read('todo_items', (q) => own(q).order('flagged_at', { ascending: false }).order('id')),
    read('post_attempts', (q) => own(q).order('started_at', { ascending: false }).order('id')),
    latest('scan_summaries', (q) => own(q).order('taken_at', { ascending: false }).limit(50)),
    loadBilling(dealership.id),
  ]);
  if (!current()) return;
  // the signed-in person's role there, as myRole() reads it once these rows are the page's
  const role = memberRole(memberships, state.session?.user?.id) || billing.status?.role || '';
  const invites = await loadInvites(dealership.id, role);
  if (!current()) return;
  // a note from Stripe's return is about the dealership it names: none on another one's card
  if (state.billingNoteFor && state.billingNoteFor !== dealership.id) state.billingNote = '';
  state.billingNoteFor = '';
  state.dealerships = dealerships;
  state.dealershipId = dealership.id;
  state.data = { dealership, memberships, listings, todoItems, postAttempts, scans };
  state.billing = withRole(billing, role);
  state.invites = invites.invites;
  state.inviteError = invites.error;
  viewData();
}

// ---------- start ----------

// A sign-in answer this page did not ask for (data.js authFragment), or a
// refused link's error in the query (data.js authQueryError): the fragment
// and the error parameters leave the address at once, before supabase-js
// reads it, so the tokens and the error leave the address bar and a session
// this browser holds is kept. The session stray tokens opened is ended with
// its own token (scope local: no other session of the person's), and nothing
// waits on that answer. Returns the sentence for the sign-in form, or ''.
function dropAuthFragment() {
  const found = authFragment(location.hash);
  const failed = authQueryError(location.search);
  if (!found && !failed) return '';
  try {
    const url = new URL(location.href);
    if (found) url.hash = '';
    if (failed) for (const name of failed.params) url.searchParams.delete(name);
    history.replaceState(null, '', url.toString());
  } catch { /* some file:// pages refuse */ }
  if (!found) return failed.note;
  if (found.accessToken && configured()) {
    fetch(`${trimSlash(CONFIG.supabaseUrl)}/auth/v1/logout?scope=local`, {
      method: 'POST',
      keepalive: true,
      headers: { apikey: CONFIG.supabaseAnonKey, Authorization: `Bearer ${found.accessToken}` },
    }).catch(() => { /* the address is clean either way */ });
  }
  return found.note;
}

async function start() {
  const linkNote = dropAuthFragment();
  const params = new URLSearchParams(location.search);
  // back from Stripe: the dealership the button was pressed for opens first (nothing is on screen yet, so no button reads it
  // before its rows are in), the flag becomes one note on its Billing card, and both leave the address so a reload does not repeat them
  const back = params.get('dealership') || '';
  if (params.has('dealership')) setParam('dealership', null);
  if (back) state.dealershipId = back;
  if (params.has('billing')) {
    state.billingNote = billingReturnNote(params.get('billing'));
    state.billingNoteFor = back;
    setParam('billing', null);
  }
  if (params.get('mock') === '1') return showMock();
  if (params.get('mock') === 'signup') return showMockSignup();
  if (!configured()) return viewUnconfigured();
  try {
    const supabase = await connect();
    const { data, error } = await supabase.auth.getSession();
    if (error) throw new Error(`Couldn't check the sign-in: ${error.message}`);
    state.session = data.session || null;
    // supabase-js takes a code it exchanged out of the address; one still there was not (another browser's, the extension's, or used)
    const deadCode = new URL(location.href).searchParams.has('code');
    if (deadCode) setParam('code', null);
    if (!state.session) return viewSignIn(linkNote || (deadCode ? UNUSED_CODE_NOTE : ''));
    await loadLive();
  } catch (e) {
    viewError(e && e.message ? e.message : String(e));
  }
}

start();
