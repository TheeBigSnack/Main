// Supabase (Milestone 4): the migrations, the SQL test and the two Edge
// Functions held to the rules a Node test can read off their source. Nothing
// here runs SQL or Deno (supabase/README.md says how to run rls.sql against
// a database); it keeps the rules from drifting: every table is under RLS,
// an invite code is matched ignoring case and spaces on both sides, the sync
// function's take-down rule compares server stamps only, both functions
// pick the dealership by the same origin comparison and refuse an unknown
// one, both refuse a lapsed dealership with 402 before writing or spending
// (Milestone 5), the sync answer carries the plan and the caller's posts
// today for the daily cap, and the README says what the code does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const schema = read('../supabase/migrations/0001_schema.sql');
const rls = read('../supabase/migrations/0002_rls.sql');
const rlsTest = read('../supabase/tests/rls.sql');
const http = read('../supabase/functions/_shared/http.ts');
const auth = read('../supabase/functions/_shared/auth.ts');
const billingShared = read('../supabase/functions/_shared/billing.mjs');
const sync = read('../supabase/functions/sync/index.ts');
const rewrite = read('../supabase/functions/rewrite/index.ts');
const billing = read('../supabase/functions/billing/index.ts');
const readme = read('../supabase/README.md');

// ---------- the schema ----------

test('0001_schema.sql: every table gets RLS in 0002_rls.sql; listings carry the server\'s created_at next to the client\'s posted_at', () => {
  const tables = [...schema.matchAll(/^create table public\.(\w+) \(/gm)].map((m) => m[1]);
  assert.ok(tables.includes('listings') && tables.includes('invites'), tables.join(', '));
  for (const t of tables) assert.ok(rls.includes(`alter table public.${t} enable row level security;`), `${t} has RLS on`);
  const listings = /create table public\.listings \(([^]*?)\n\);/.exec(schema)[1];
  assert.match(listings, /\n  posted_at timestamptz not null,\n/, 'posted_at is the client\'s stamp, required');
  assert.match(listings, /\n  created_at timestamptz not null default now\(\),\n/, 'created_at is the database\'s stamp, never sent');
  // an invite code is unique ignoring case and spaces, the way redeem_invite matches it
  assert.match(schema, /create unique index invites_code_folded_idx on public\.invites \(upper\(trim\(code\)\)\);/);
});

test('0002_rls.sql: redeem_invite folds both sides of the code; invites have no policy and no API privilege; every definer pins search_path', () => {
  assert.match(rls, /where upper\(trim\(i\.code\)\) = upper\(trim\(redeem_invite\.code\)\)/);
  assert.doesNotMatch(rls, /where i\.code = /, 'the stored code is never compared verbatim');
  assert.match(rls, /where invites\.code = inv\.code;/, 'the used mark goes on the row that was found');
  assert.doesNotMatch(rls, /on public\.invites for/, 'no policy on invites: read only inside redeem_invite');
  assert.doesNotMatch(rls, /grant [^;]*on public\.invites to (anon|authenticated)/);
  const definers = (rls.match(/security definer/g) || []).length;
  assert.ok(definers >= 4, 'is_member, is_manager, redeem_invite, create_invite');
  assert.equal((rls.match(/set search_path = ''/g) || []).length, definers, 'every security definer function pins search_path');
  assert.match(rls, /revoke execute on function public\.redeem_invite\(text, text\) from public, anon;/);
  assert.match(rls, /revoke execute on function public\.create_invite\(uuid, text\) from public, anon;/);
});

test('tests/rls.sql: an owner-made lower-case code is stored as typed and redeemed in upper case with spaces around it', () => {
  assert.match(rlsTest, /\('made-up-b002', :'dealer_b', 'manager',\s+null\)/, 'inserted by the owner in SQL, no creator');
  assert.match(rlsTest, /public\.redeem_invite\(' MADE-UP-B002 ', null\)/, 'typed as the extension sends codes');
  assert.match(rlsTest, /where code = 'made-up-b002' and used_by/, 'marked used under the stored spelling');
  assert.match(rlsTest, /public\.redeem_invite\(' newcomerb001 ', 'Riley'\)/, 'and an upper-case code typed in lower case');
});

// ---------- the sync function ----------

test('sync/index.ts: the take-down window is decided by created_at, never posted_at; serverTime is taken after the writes and before the reads', () => {
  assert.match(sync, /\.eq\('user_id', me\)\.eq\('status', 'listed'\)\.lte\('created_at', since\)/);
  assert.doesNotMatch(sync, /lte\('posted_at'/, 'the client\'s stamp is never compared with since');
  assert.doesNotMatch(sync, /created_at:/, 'the function never stamps created_at itself: the database does');
  assert.equal((sync.match(/const serverTime = /g) || []).length, 1);
  const at = sync.indexOf('const serverTime = new Date().toISOString();');
  assert.ok(at > sync.indexOf("// 5. this scan's counts"), 'after the last write');
  assert.ok(at < sync.indexOf("// 6. the dealership's current state"), 'before the state that goes back is read');
  assert.match(sync, /taken_down_at: new Date\(\)\.toISOString\(\)/, 'a take-down carries its own stamp');
  assert.match(sync, /const cutoff = since \?\? /);
});

// ---------- the origin both functions pick the dealership by ----------

test('_shared/http.ts: one sameOrigin for both functions, without spaces, trailing slashes or case', () => {
  assert.match(http, /export function sameOrigin\(a: string, b: string\): boolean \{/);
  assert.match(http, /s\.trim\(\)\.replace\(\/\\\/\+\$\/, ''\)\.toLowerCase\(\)/);
  for (const src of [sync, rewrite]) {
    assert.match(src, /import \{[^}]*\bsameOrigin\b[^}]*\} from '\.\.\/_shared\/http\.ts'/, 'imported, not copied');
    assert.doesNotMatch(src, /const sameOrigin\b/);
    assert.doesNotMatch(src, /website_origin ===/, 'never an exact comparison');
  }
  assert.match(sync, /memberships\.find\(\(m\) => m\.dealership !== null && sameOrigin\(m\.dealership\.website_origin, origin\)\)/);
});

test('rewrite/index.ts: the dealership comes from the origin sent with the facts; an unknown origin gets 403; the origin never reaches the prompt', () => {
  assert.match(rewrite, /const wantedOrigin = isRecord\(body\) && typeof body\.origin === 'string' \? body\.origin\.trim\(\)\.replace\(\/\\\/\+\$\/, ''\) : '';/);
  assert.match(rewrite, /const membership = wantedOrigin \? memberships\.find\(\(m\) => m\.dealership !== null && sameOrigin\(m\.dealership\.website_origin, wantedOrigin\)\) : memberships\[0\];/, 'memberships[0] only when no origin was sent');
  assert.match(rewrite, /if \(!membership\) return json\(req, 403, \{ ok: false, error: `your account is not a member of the dealership for \$\{wantedOrigin\}` \}\);/);
  assert.doesNotMatch(rewrite, /\|\| memberships\[0\]/, 'no silent fallback after a miss');
  const strip = rewrite.indexOf('delete facts.origin;');
  assert.ok(strip > 0 && strip < rewrite.indexOf('await rewrite(facts, who, service)'), 'origin is removed from the facts before the prompt');
});

// ---------- the plan gate and the daily cap's count (Milestone 5) ----------

test('sync/index.ts and rewrite/index.ts refuse a lapsed dealership with 402 and code lapsed, from the row read with the caller\'s client, before any write or spend', () => {
  const gate = /if \(plan\.state === 'lapsed'\) return json\(req, 402, lapsedAnswer\(plan\)\);/;
  for (const [name, src] of [['sync', sync], ['rewrite', rewrite]]) {
    assert.match(src, /import \{[^}]*\bplanOf\b[^}]*\blapsedAnswer\b[^}]*\} from '\.\.\/_shared\/billing\.mjs'/, `${name} takes the rule from the shared module`);
    assert.match(src, /import \{[^}]*\bsubscriptionRowOf\b[^}]*\} from '\.\.\/_shared\/auth\.ts'/, `${name} reads the row through the shared helper`);
    assert.equal((src.match(new RegExp(gate.source, 'g')) || []).length, 1, `${name} gates once`);
    assert.doesNotMatch(src, /json\(req, 402, \{/, `${name} never builds the 402 by hand`);
  }
  // sync: with the caller's client, after the membership and before the first write; no service role at all
  assert.match(sync, /plan = planOf\(await subscriptionRowOf\(client, dealershipId\)\);/);
  assert.doesNotMatch(sync, /serviceClient/, 'the sync function has no service-role client');
  const syncGate = sync.search(gate);
  assert.ok(syncGate > sync.indexOf('const dealershipId = membership.dealership_id;'), 'after the membership is picked');
  assert.ok(syncGate < sync.indexOf('  try {\n    // 1. the registry'), 'before the writes begin');
  assert.ok(syncGate < sync.indexOf('.insert('), 'before any insert');
  assert.ok(syncGate < sync.indexOf('.update('), 'before any update');
  assert.ok(syncGate < sync.indexOf('.upsert('), 'before any upsert');
  // rewrite: after the membership, before the cost cap and the model call; the health route is behind it too
  assert.match(rewrite, /plan = planOf\(await subscriptionRowOf\(caller\.client, who\.dealershipId\)\);/);
  const rewriteGate = rewrite.search(gate);
  assert.ok(rewriteGate > rewrite.indexOf('const who: Who = '), 'after the membership is picked');
  assert.ok(rewriteGate < rewrite.indexOf('spent = await monthSpend('), 'before the cost cap is read');
  assert.ok(rewriteGate < rewrite.indexOf('if (isHealth) {'), 'every route, health included');
  assert.ok(rewriteGate < rewrite.indexOf('await rewrite(facts, who, service)'), 'before the model call');
  assert.ok(rewriteGate < rewrite.indexOf('await guessColors('), 'before the color call');
  // the shared pieces: one query by dealership id under RLS; the answer's code and sentence
  assert.match(auth, /export async function subscriptionRowOf\(client: SupabaseClient, dealershipId: string\): Promise<SubscriptionRow \| null>/);
  assert.match(auth, /client\.from\('subscriptions'\)\.select\('\*'\)\.eq\('dealership_id', dealershipId\)\.maybeSingle\(\)/);
  assert.match(billingShared, /export const LAPSED_CODE = 'lapsed';/);
  assert.match(billingShared, /export const LAPSED_MESSAGE = "the dealership's Lot Sync subscription has lapsed: a manager can renew it in the manager view";/);
  assert.match(billingShared, /return \{ ok: false, error: LAPSED_MESSAGE, code: LAPSED_CODE, plan \};/);
  // the billing function is never gated: a lapsed dealership must be able to renew
  assert.doesNotMatch(billing, /lapsedAnswer|402/);
});

test('sync/index.ts answers plan and postsToday; postsToday counts the caller\'s own rows, any status, in the day the extension sent, after the writes', () => {
  assert.match(sync, /import \{[^}]*\btodayRange\b[^}]*\} from '\.\.\/_shared\/billing\.mjs'/);
  assert.match(sync, /const today = todayRange\(body\.today\);/, 'the request\'s day is taken through the shared check, or it is null');
  const count = /const postsToday = today \? await countOf\(client\.from\('listings'\)\.select\('id', \{ count: 'exact', head: true \}\)\.eq\('dealership_id', dealershipId\)\.eq\('user_id', me\)\.gte\('posted_at', today\.from\)\.lt\('posted_at', today\.to\), 'could not count listings'\) : null;/;
  assert.match(sync, count);
  assert.ok(sync.search(count) > sync.indexOf('const serverTime = new Date().toISOString();'), 'after the writes, so the posts this call brought are in the count');
  assert.doesNotMatch(sync, /gte\('posted_at', since\)|lt\('posted_at', since\)|lte\('posted_at', since\)/, 'the day is the only thing posted_at is compared with');
  assert.match(sync, /\n      role: membership\.role,\n      plan,\n      postsToday,\n      counts,\n/, 'both fields in the answer');
  assert.match(sync, /-> 402 \{ ok: false, error, code: 'lapsed', plan \}/, 'the header says what a lapsed dealership gets');
  assert.match(sync, /today: \{ from, to \} \| null \}/, 'and what the request carries');
});

// ---------- the README ----------

test('supabase/README.md names today, postsToday, plan, the 402 rule and the Billing card', () => {
  assert.match(readme, /`today` is `\{ from, to \}`, two ISO stamps bounding the caller's local calendar day/);
  assert.match(readme, /answers 402 `\{ ok: false, error, code: "lapsed", plan \}` and writes nothing/);
  assert.match(readme, /`plan` is `\{ state, pilotEndsAt, currentPeriodEnd, seats \}`/);
  assert.match(readme, /`postsToday` is the number of the caller's own listings rows, any status/);
  assert.match(readme, /the daily cap takes the larger of its local count and the server's/);
  assert.match(readme, /gets 402 `\{ ok: false, error, code: "lapsed", plan \}` on every route of the function/, 'the rewrite paragraph');
  assert.match(readme, /402 \(the dealership's subscription has lapsed/, 'the error list');
  assert.match(readme, /The billing routes are never gated/);
  // the Billing card: one row per state, and which route each button calls
  const card = readme.slice(readme.indexOf("### The manager page's Billing card"), readme.indexOf('### Testing with Stripe'));
  assert.ok(card.length > 0, 'the card has its own section');
  for (const state of ['none', 'pilot', 'active', 'lapsed']) assert.match(card, new RegExp(`^\\| \`${state}\` \\|`, 'm'), `a row for ${state}`);
  assert.match(card, /`GET \/billing\/status\?dealershipId=/);
  assert.match(card, /\*\*Start the free pilot\*\* runs `supabase\.rpc\('start_pilot', \{ dealership_id \}\)`/);
  assert.match(card, /\*\*Subscribe\*\* POSTs `\{ returnUrl, dealershipId \}` to `\/billing\/checkout`/);
  assert.match(card, /\*\*Manage billing\*\* POSTs `\{ returnUrl, dealershipId \}` to `\/billing\/portal`/);
  assert.match(card, /salespeople see the line and no buttons/);
  assert.doesNotMatch(readme, /not wired in this step/, 'the card is wired now');
});

test('supabase/README.md says what the code does: the code folding, the created_at rule, the rewrite origin rule, in-place migrations', () => {
  assert.match(readme, /any text works as a code \(matched ignoring case and surrounding spaces\)/);
  assert.match(readme, /`listings\.created_at`, stamped by the server when the row arrived/);
  assert.match(readme, /the client's `postedAt` is never compared with `since`/);
  assert.match(readme, /matches none of their dealerships gets 403/);
  assert.match(readme, /Until the first project has applied them, a change to the schema is made in the file that defines it/);
  assert.match(readme, /The pilot lists are the one place a client clock still meets `since`/);
});
