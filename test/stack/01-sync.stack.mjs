// The extension's own account and sync modules against the real /sync
// (supabase/README.md, "How the extension is configured" and "The two
// functions"): a dealership made the owner's way, its manager signed in from
// the real email, two salespeople invited by that manager, and a stranger.
// Two salespeople then see each other's posts, the manager sees both, a
// take-down on one machine reaches the other, and the stranger gets 403.
// test/accountFlow.test.js runs the same modules against a model of the
// function; this is the function itself, behind the real gateway and GoTrue.

import { redeemInvite, createInvite } from '../../extension/src/account.js';
import { syncOnce, describeSync } from '../../extension/src/accountFlow.js';
import { siteKeys } from '../../extension/src/storageKeys.js';

export const title = 'Two salespeople, their manager and a stranger sync through the real /sync';

export async function run(s) {
  const d = s.dealership('sync');
  const posted = siteKeys(d.origin).posted;
  const account = (who) => ({ url: s.url, anonKey: s.anonKey, session: who.session, fetchImpl: s.fetch });

  const manager = await s.person('manager', 'email');
  s.check('the manager signs in without a password', manager.session.user.email === manager.email, manager.how);
  const joined = await redeemInvite(d.managerCode, 'Stack Manager', account(manager));
  const m = joined.membership || {};
  if (!s.check('the manager redeems the first-manager code the owner made in SQL', joined.ok && m.role === 'manager' && m.dealershipId === d.id && m.websiteOrigin === d.origin, joined.ok ? `${m.role} of ${m.websiteOrigin}` : `${joined.status} ${joined.error}`)) return;

  const codes = [];
  for (let i = 0; i < 2; i += 1) codes.push(await createInvite(d.id, 'salesperson', account(manager)));
  if (!s.check('the manager makes two salesperson codes (create_invite)', codes.every((c) => c.ok && /^[0-9A-F]{12}$/.test(c.code) && c.role === 'salesperson'), codes.map((c) => (c.ok ? `${c.role}, ${c.code.length} characters` : `${c.status} ${c.error}`)).join('; '))) return;

  const a = await s.person('seller-a', 'code');
  s.check('salesperson A signs in without a password', a.session.user.email === a.email, a.how);
  const b = await s.person('seller-b', 'link');
  s.check('salesperson B signs in without a password', b.session.user.email === b.email, b.how);
  const joinedA = await redeemInvite(codes[0].code, 'Seller A', account(a));
  const joinedB = await redeemInvite(codes[1].code, 'Seller B', account(b));
  if (!s.check('both redeem their codes and join as salespeople', joinedA.ok && joinedB.ok && joinedA.membership.role === 'salesperson' && joinedB.membership.role === 'salesperson', [joinedA, joinedB].map((j) => (j.ok ? j.membership.role : `${j.status} ${j.error}`)).join('; '))) return;

  // A posts a car and syncs, with this scan's counts.
  const vinA = s.vin('A');
  const vinB = s.vin('B');
  const now = Date.now();
  a.storage.data[posted] = { [vinA]: { name: '2020 Stack Sedan LE', price: 18995, postedAt: new Date(now - 1000).toISOString(), salesperson: 'Seller A' } };
  const a1 = await syncOnce({ origin: d.origin, scan: { takenAt: new Date(now).toISOString(), cars: 12, ready: 9, takeDownCount: 0, priceUpdateCount: 0 }, deps: a.deps });
  s.info(`A: ${describeSync(a1)}`);
  if (!s.check("A's sync is accepted for the right dealership, as a salesperson", a1.ok && a1.dealership.id === d.id && a1.role === 'salesperson', a1.ok ? `${a1.dealership.name}, ${a1.role}` : `${a1.status} ${a1.error}`)) return;
  s.check("A's post is stored (counts.listingsInserted 1)", a1.counts.listingsInserted === 1, JSON.stringify(a1.counts));
  s.check('a dealership the owner made has no plan yet, and is served (plan.state none)', a1.state && a1.state.plan && a1.state.plan.state === 'none', JSON.stringify(a1.state && a1.state.plan));
  const day = a1.state && a1.state.postsToday;
  s.check("the server counts A's posts today for the daily cap (postsToday 1)", day && day.count === 1, JSON.stringify(day));
  const scans = Number(s.sql(`select count(*) from public.scan_summaries where dealership_id = ${s.lit(d.id)}`));
  s.check("the scan's counts are stored once", scans === 1, `${scans} row(s)`);

  // B posts another car; the answer brings A's.
  b.storage.data[posted] = { [vinB]: { name: '2018 Stack Hatchback', price: 12500, postedAt: new Date(now - 500).toISOString(), salesperson: 'Seller B' } };
  const b1 = await syncOnce({ origin: d.origin, deps: b.deps });
  s.info(`B: ${describeSync(b1)}`);
  const bReg = b.storage.data[posted] || {};
  s.check("B's post is stored", b1.ok && b1.counts.listingsInserted === 1, b1.ok ? JSON.stringify(b1.counts) : `${b1.status} ${b1.error}`);
  s.check("B now sees A's car, marked as a colleague's", bReg[vinA] && bReg[vinA].mine === false && bReg[vinA].userId === a.id && bReg[vinA].price === 18995, JSON.stringify(bReg[vinA] || null));
  s.check("B's own car stays B's", bReg[vinB] && bReg[vinB].mine === undefined, JSON.stringify(bReg[vinB] || null));

  const a2 = await syncOnce({ origin: d.origin, deps: a.deps });
  const aReg = a.storage.data[posted] || {};
  s.check("A's next sync brings B's car, marked as a colleague's", a2.ok && aReg[vinB] && aReg[vinB].mine === false && aReg[vinB].userId === b.id, JSON.stringify(aReg[vinB] || null));

  // The manager sees both, in the extension and the way the manager page reads.
  const m1 = await syncOnce({ origin: d.origin, deps: manager.deps });
  s.info(`manager: ${describeSync(m1)}`);
  const mReg = manager.storage.data[posted] || {};
  s.check('the manager syncs as manager and sees both cars', m1.ok && m1.role === 'manager' && m1.listed === 2 && mReg[vinA] && mReg[vinB], m1.ok ? `${m1.role}, ${m1.listed} listed` : `${m1.status} ${m1.error}`);
  const page = await s.rest('GET', `/rest/v1/listings?select=vin,user_id,salesperson,status&dealership_id=eq.${d.id}&order=vin`, { token: manager.token });
  const rows = Array.isArray(page.body) ? page.body : [];
  s.check("the manager page's read of listings returns both salespeople's rows", page.status === 200 && rows.length === 2 && rows.some((r) => r.user_id === a.id) && rows.some((r) => r.user_id === b.id), `HTTP ${page.status}, ${rows.length} row(s)`);

  // A takes the car down on this machine; the next syncs carry it everywhere.
  delete a.storage.data[posted][vinA];
  const a3 = await syncOnce({ origin: d.origin, deps: a.deps });
  s.check("A's take-down reaches the server (counts.takenDown 1)", a3.ok && a3.counts.takenDown === 1, a3.ok ? JSON.stringify(a3.counts) : `${a3.status} ${a3.error}`);
  const b2 = await syncOnce({ origin: d.origin, deps: b.deps });
  s.check("B's next sync drops A's taken-down car", b2.ok && !(b.storage.data[posted] || {})[vinA] && (b.storage.data[posted] || {})[vinB], Object.keys(b.storage.data[posted] || {}).join(', ') || 'nothing');

  // Someone signed in who belongs to no dealership.
  const stranger = await s.person('stranger', 'link');
  const x = await syncOnce({ origin: d.origin, deps: stranger.deps });
  s.check('a signed-in stranger gets 403 from /sync', !x.ok && x.status === 403 && x.notMember === true, `${x.status} ${x.error}`);
  const peek = await s.rest('GET', `/rest/v1/listings?select=vin&dealership_id=eq.${d.id}`, { token: stranger.token });
  s.check("the stranger reads none of the dealership's listings", peek.status === 200 && Array.isArray(peek.body) && peek.body.length === 0, `HTTP ${peek.status}, ${Array.isArray(peek.body) ? peek.body.length : '?'} row(s)`);
}
