// The manager view's page: sign in by magic link when config.js names a
// Supabase project, read the dealership's rows with the anon key (row-level
// security decides what comes back; no service key anywhere near a browser),
// hand them to data.js and render. ?mock=1, or "Try with sample data" when
// nothing is configured, shows a made-up dealership without touching the
// network. Every number is computed in data.js so the tests cover it.

import { CONFIG } from './config.js';
import { summarize, mockData, managerCsv, csvFileName, fmtLocal, OVERDUE_HOURS } from './data.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const secs = (s) => (typeof s === 'number' ? `${s} s` : '—');
const hrs = (h) => (typeof h === 'number' ? `${h} h` : '—');
const money = (n) => (typeof n === 'number' ? '$' + n.toLocaleString('en-US') : '—');
const configured = () => Boolean(CONFIG.supabaseUrl && CONFIG.supabaseAnonKey);

const state = {
  mode: 'loading', // loading | unconfigured | signin | sent | view | error
  mock: false,
  supabase: null,
  session: null,
  dealerships: [],
  dealershipId: null,
  data: null, // { dealership, memberships, listings, todoItems, postAttempts, scans }
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

function setUrlMock(on) {
  try {
    const url = new URL(location.href);
    if (on) url.searchParams.set('mock', '1'); else url.searchParams.delete('mock');
    history.replaceState(null, '', url.toString());
  } catch { /* some file:// pages refuse; the view is on screen either way */ }
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
    <p class="lead">The manager view shows who posted what, which sold cars are still listed and for how long, and which price changes have not reached the listing yet. It reads what the salespeople's Lot Sync extensions record: VINs, listing links, prices and times. Nothing from Facebook beyond the listing links they saved, and never a description or a buyer.</p>`;
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
      <p class="hint">Only people the dealership's Lot Sync account lists can sign in. If the link does not arrive, check the spam folder, then ask whoever set Lot Sync up for your store.</p>
      <div class="toolbar"><button type="button" class="ghost" data-action="mock">Try with sample data instead</button></div>
    </div>`;
  $('signin').addEventListener('submit', onSendLink);
}

function viewSent(email) {
  state.mode = 'sent';
  $('main').innerHTML = `
    <div class="signin">
      <h2>Check your email</h2>
      <p class="lead">A sign-in link is on its way to <b>${esc(email)}</b>. Open it on this device; it signs you in here.</p>
      <div class="toolbar"><button type="button" class="ghost" data-action="signin">Use another address</button></div>
    </div>`;
}

function viewError(message) {
  state.mode = 'error';
  setStatus(message, true);
  $('main').innerHTML = `<p class="empty">${esc(message)}</p><div class="toolbar"><button type="button" class="ghost" data-action="retry">Try again</button>${state.session ? '<button type="button" class="ghost" data-action="signout">Sign out</button>' : ''}</div>`;
}

function pill(cls, text) {
  return `<span class="pill ${cls}">${esc(text)}</span>`;
}

function viewData() {
  state.mode = 'view';
  const d = state.data;
  const s = summarize({ ...d, now: new Date().toISOString() });
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
  const sold = `<section><h2>Sold cars still listed ${pill(s.soldStillListed.length ? (s.soldStillListed.some((o) => o.overdue) ? 'bad' : 'warn') : 'good', String(s.soldStillListed.length))}</h2>
    ${s.soldStillListed.length
      ? `<div class="scroll"><table class="stats" id="soldStillListed"><thead><tr><th>Car</th><th class="n">Open for</th></tr></thead><tbody>${s.soldStillListed.map((o) => `<tr>${car(o)}${age(o)}</tr>`).join('')}</tbody></table></div>
         <p class="hint">Longest first. Red past ${OVERDUE_HOURS} hours. Hours run from the scan that flagged the car; the salesperson sees the same item on their To do tab.</p>`
      : '<p class="empty">Every sold car is off Marketplace.</p>'}
    ${s.takeDowns.done ? `<p class="hint">${s.takeDowns.done} taken down so far, median ${hrs(s.takeDowns.medianHours)} after the flagging scan${s.takeDowns.cleared ? `; ${s.takeDowns.cleared} cleared by the website (the car came back)` : ''}.</p>` : ''}
  </section>`;

  const priceCell = (o) => {
    const both = typeof o.fromPrice === 'number' && typeof o.toPrice === 'number';
    const dir = both ? (o.toPrice < o.fromPrice ? 'down' : 'up') : '';
    return `<td class="n">${money(o.fromPrice)} <span class="arrow">→</span> <span class="${dir}">${money(o.toPrice)}</span></td>`;
  };
  const prices = `<section><h2>Price changes not yet updated ${pill(s.priceMismatches.length ? (s.priceMismatches.some((o) => o.overdue) ? 'bad' : 'warn') : 'good', String(s.priceMismatches.length))}</h2>
    ${s.priceMismatches.length
      ? `<div class="scroll"><table class="stats" id="priceMismatches"><thead><tr><th>Car</th><th class="n">Listing → website</th><th class="n">Open for</th></tr></thead><tbody>${s.priceMismatches.map((o) => `<tr>${car(o)}${priceCell(o)}${age(o)}</tr>`).join('')}</tbody></table></div>
         <p class="hint">The listing price must match the website; the salesperson updates it from their To do tab. Red past ${OVERDUE_HOURS} hours.</p>`
      : '<p class="empty">Every listing shows the website price.</p>'}
    ${s.priceUpdates.done ? `<p class="hint">${s.priceUpdates.done} updated so far, median ${hrs(s.priceUpdates.medianHours)} after the flagging scan${s.priceUpdates.cleared ? `; ${s.priceUpdates.cleared} cleared by the website (the price went back)` : ''}.</p>` : ''}
  </section>`;

  $('main').innerHTML = scan + people + `<div class="grid two">${sold}${prices}</div>`;
  const sel = $('pickDealer');
  if (sel) sel.addEventListener('change', () => { state.dealershipId = sel.value; loadLive().catch((e) => viewError(e.message)); });
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
    default: break;
  }
});

function showMock() {
  state.mock = true;
  state.data = mockData(new Date().toISOString());
  state.dealerships = [state.data.dealership];
  state.dealershipId = state.data.dealership.id;
  setUrlMock(true);
  viewData();
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
    const { error } = await state.supabase.auth.signOut();
    if (error) return setStatus(`Couldn't sign out: ${error.message}`, true);
  }
  state.session = null;
  state.data = null;
  viewSignIn('Signed out.');
}

async function onSendLink(ev) {
  ev.preventDefault();
  const form = ev.currentTarget;
  const email = form.elements.email.value.trim();
  if (!email) return;
  const button = form.querySelector('button');
  button.disabled = true;
  setStatus('Sending the link…');
  const redirect = new URL(location.href);
  redirect.search = '';
  redirect.hash = '';
  const { error } = await state.supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: redirect.toString() } });
  button.disabled = false;
  if (error) return setStatus(`Couldn't send the link: ${error.message}`, true);
  setStatus('');
  viewSent(email);
}

// ---------- live data ----------

async function connect() {
  if (state.supabase) return state.supabase;
  const mod = await import(CONFIG.supabaseJs);
  state.supabase = mod.createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey);
  state.supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_IN' && !state.session) {
      state.session = session;
      if (!state.mock) loadLive().catch((e) => viewError(e.message));
    } else if (event === 'SIGNED_OUT' && state.session) {
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
async function loadLive() {
  const supabase = state.supabase;
  setStatus('Loading…');
  const read = async (table, build = (q) => q) => {
    const { data, error } = await build(supabase.from(table).select('*'));
    if (error) throw new Error(`Couldn't read ${table}: ${error.message}`);
    return data || [];
  };
  const dealerships = await read('dealerships', (q) => q.order('name'));
  if (!dealerships.length) {
    setStatus('');
    $('main').innerHTML = '<p class="empty">Your account is not a member of any dealership yet. Ask whoever set Lot Sync up for your store to add you.</p><div class="toolbar"><button type="button" class="ghost" data-action="signout">Sign out</button></div>';
    setActions(`<span class="who">${esc(state.session?.user?.email || '')}</span>`);
    state.mode = 'view';
    return;
  }
  state.dealerships = dealerships;
  const dealership = dealerships.find((d) => d.id === state.dealershipId) || dealerships[0];
  state.dealershipId = dealership.id;
  const own = (q) => q.eq('dealership_id', dealership.id);
  const [memberships, listings, todoItems, postAttempts, scans] = await Promise.all([
    read('memberships', own),
    read('listings', (q) => own(q).order('posted_at', { ascending: false })),
    read('todo_items', (q) => own(q).order('flagged_at', { ascending: false })),
    read('post_attempts', (q) => own(q).order('started_at', { ascending: false })),
    read('scan_summaries', (q) => own(q).order('taken_at', { ascending: false }).limit(50)),
  ]);
  state.data = { dealership, memberships, listings, todoItems, postAttempts, scans };
  viewData();
}

// ---------- start ----------

async function start() {
  const params = new URLSearchParams(location.search);
  if (params.get('mock') === '1') return showMock();
  if (!configured()) return viewUnconfigured();
  try {
    const supabase = await connect();
    const { data, error } = await supabase.auth.getSession();
    if (error) throw new Error(`Couldn't check the sign-in: ${error.message}`);
    state.session = data.session || null;
    if (!state.session) return viewSignIn();
    await loadLive();
  } catch (e) {
    viewError(e && e.message ? e.message : String(e));
  }
}

start();
