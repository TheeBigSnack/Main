// Supabase (Milestone 4): the migrations, the SQL test and the two Edge
// Functions held to the rules a Node test can read off their source. Nothing
// here runs SQL or Deno (supabase/README.md says how to run rls.sql against
// a database); it keeps the rules from drifting: every table is under RLS,
// keep_a_manager locks the dealership before it looks for another manager,
// the plain-Postgres shim grants what Supabase grants by default, an invite
// code is matched ignoring case and spaces on both sides, the sync
// function's take-down rule compares server stamps only, both functions
// pick the dealership by the same origin comparison and refuse an unknown
// one, both refuse a lapsed dealership with 402 before writing or spending
// (Milestone 5), the sync answer carries the plan and the caller's posts
// today for the daily cap, and the README says what the code does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { MIGRATIONS, migration, lastDefinition } from './migrations.js';

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

// The production project has applied 0001 to 0008. Supabase records a
// migration by its number and never reads an applied file again, so a change
// made inside one reaches a fresh build but never production, where the code
// that relies on it then fails. Those files stay exactly as deployed, comments
// included, and every change is a new numbered file (0009_cancel_at.sql was
// the first, 0010_backend_review_fixes.sql the next). Line endings are folded
// so a Windows checkout reads the same.
const APPLIED_MIGRATIONS = Object.freeze({
  '0001_schema.sql': 'a781dc0771958bacbe86448c3fe5ea1cd258583fe11a677a76955ff5bc3877d8',
  '0002_rls.sql': '25c73dc346820f882563b2ccc91ca58f3cff46d97bffbdbc678bc72de67e47c7',
  '0003_views.sql': 'e651faa63f595e94059b4b624c407570fc7c7c418fed11d7e139c8b5aa2d0ab2',
  '0004_billing.sql': '6e7f0637e6d74dd4bfab20f7d8cca26279d1d9e1683427820512f219ec58dc36',
  '0005_leads.sql': '3eed948aa5eebf1fa2746ff4c034d64132f017c1c42d45cbbc41fe5a5e93922f',
  '0006_privacy.sql': '11e44419ea8da5127325f6a49813bf823f2f313779d76dbbf466afd6a39c37e4',
  '0007_signup.sql': 'af23fca0fa04d4f292cfa9b86750d5515f48fb406b1e72203b7069ce4a58953e',
  '0008_usage.sql': 'd71bfb982b354490f58603559ce5e7f3a13bb08d6dc8fce64fece757ae46e022',
});

test('the migrations production applied (0001 to 0008) are the deployed files unchanged; every later change is a new numbered file', () => {
  for (const [file, sha] of Object.entries(APPLIED_MIGRATIONS)) {
    assert.ok(MIGRATIONS.includes(file), `${file} is applied in production and must stay`);
    const text = migration(file).replace(/\r\n/g, '\n');
    assert.equal(createHash('sha256').update(text).digest('hex'), sha, `${file} is applied in production and must not change, not even a comment: put the change in a new numbered migration and restore it (git checkout 8a09dc1 -- supabase/migrations/${file})`);
  }
  const last = Object.keys(APPLIED_MIGRATIONS).sort().pop();
  const later = MIGRATIONS.filter((x) => !Object.hasOwn(APPLIED_MIGRATIONS, x));
  for (const f of later) assert.ok(f.slice(0, 4) > last.slice(0, 4), `${f} sorts after ${last}, so it applies on top of what production has`);
  // one file per number, so applying 0001..N in order on the deployed project is the same as a fresh build
  const numbers = MIGRATIONS.map((f) => f.slice(0, 4));
  assert.equal(new Set(numbers).size, numbers.length, `two migrations share a number: ${MIGRATIONS.join(', ')}`);
  for (const f of later) {
    const text = migration(f);
    const code = text.replace(/--.*$/gm, '');
    assert.doesNotMatch(text, /changed in place/i, `${f}: nothing applied is changed in place`);
    assert.doesNotMatch(code, /^\s*create function /im, `${f}: a function is changed with create or replace`);
    // a replaced function keeps its security settings only when they are written out again
    const definers = (code.match(/security definer/g) || []).length;
    assert.equal((code.match(/security definer\s*\n\s*set search_path = ''/g) || []).length, definers, `${f}: every security definer function pins search_path`);
  }
  // the functions 0010 replaces keep the language, security and search_path they were made with
  for (const [name, file] of [['redeem_invite', '0002_rls.sql'], ['create_dealership', '0007_signup.sql'], ['usage_report', '0008_usage.sql']]) {
    const header = (sql) => {
      const start = sql.indexOf(`create or replace function public.${name}(`);
      return sql.slice(start, sql.indexOf('as $$', start));
    };
    const latest = lastDefinition(name);
    assert.notEqual(latest.file, file, `${name} is replaced by a later file`);
    assert.equal(header(latest.sql), header(migration(file)), `${latest.file} changes ${name}()'s signature, language, security or search_path`);
  }
  assert.match(readme, /The production project has applied `0001_schema\.sql` to `0008_usage\.sql`/, 'the README says the applied files are fixed');
  assert.doesNotMatch(readme, /Until the first project has applied them, a change to the schema is made in the file that defines it/, 'the README no longer says to change a migration in place');
});

// The billing function writes a column only a migration after the applied
// ones adds (subscriptions.cancel_at, 0009_cancel_at.sql). Deployed by hand
// onto production without that push, every subscription event's upsert is
// refused and the webhook answers 500. So every command block in the docs
// that deploys billing pushes the migrations first, in the same block: the
// Stripe walk-through's step 5 is also where its live switch sends the owner.
test('every by-hand billing deploy in the docs applies the migrations first, in the same command block', () => {
  const later = readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter((f) => /^\d{4}_.+\.sql$/.test(f) && !Object.hasOwn(APPLIED_MIGRATIONS, f));
  const added = later.flatMap((f) => [...read(`../supabase/migrations/${f}`).matchAll(/alter table public\.(\w+) add column (?:if not exists )?(\w+)/gi)].map((m) => m[2]));
  assert.ok(added.includes('cancel_at'), 'a migration after the applied ones adds subscriptions.cancel_at');
  assert.match(billingShared, /patch\.cancel_at = /, 'and the billing function writes it');
  // a line that applies the migrations: `supabase db push`, with or without flags, but never
  // `--dry-run`, which only lists what would be applied and leaves the project without them
  const pushes = (l) => /^\s*supabase db push(\s|$)/.test(l) && !/(^|\s)--dry-run(\s|=|$)/.test(l);
  assert.ok(pushes('supabase db push') && pushes('   supabase db push --linked   # applies 0009'), 'a push, with or without flags');
  assert.ok(!pushes('supabase db push --dry-run') && !pushes('supabase db push --linked --dry-run') && !pushes('supabase db pushed'), 'a dry run is not a push');
  const docs = ['README.md', 'supabase/README.md', ...readdirSync(new URL('../docs/', import.meta.url)).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)];
  let deploys = 0;
  for (const doc of docs) {
    for (const [, block] of read(`../${doc}`).matchAll(/```[a-z]*\n([^]*?)```/g)) {
      const lines = block.split('\n');
      const at = lines.findIndex((l) => /^\s*supabase functions deploy billing\b/.test(l));
      if (at < 0) continue;
      deploys++;
      assert.ok(lines.slice(0, at).some(pushes), `${doc}: a block deploys billing without supabase db push (a dry run does not count) before it, so a project without ${later.join(', ')} gets a function that writes ${added.join(', ')}`);
    }
  }
  // the production walk-through (docs/stripe-setup.md step 5) deploys through the Supabase workflow, whose
  // functions step refuses while a migration is pending (test/productionSetup.test.js); only the README's
  // by-hand lines for a project of one's own deploy from a terminal
  assert.ok(deploys >= 1, 'supabase/README.md deploys billing by hand');
  assert.match(read('../docs/stripe-setup.md'), /\*\*database\*\* comes before \*\*functions\*\* every time: the billing function writes `subscriptions\.cancel_at`/);
});

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
  const { sql: redeemFile } = lastDefinition('redeem_invite');
  for (const text of [rls, redeemFile]) {
    assert.match(text, /where upper\(trim\(i\.code\)\) = upper\(trim\(redeem_invite\.code\)\)/);
    assert.doesNotMatch(text, /where i\.code = /, 'the stored code is never compared verbatim');
    assert.match(text, /where invites\.code = inv\.code;/, 'the used mark goes on the row that was found');
  }
  assert.doesNotMatch(rls, /on public\.invites for/, 'no policy on invites: read only inside redeem_invite');
  assert.doesNotMatch(rls, /grant [^;]*on public\.invites to (anon|authenticated)/);
  const definers = (rls.match(/security definer/g) || []).length;
  assert.ok(definers >= 4, 'is_member, is_manager, redeem_invite, create_invite');
  assert.equal((rls.match(/security definer\s*\n\s*set search_path = ''/g) || []).length, definers, 'every security definer function pins search_path');
  assert.match(rls, /revoke execute on function public\.redeem_invite\(text, text\) from public, anon;/);
  assert.match(rls, /revoke execute on function public\.create_invite\(uuid, text\) from public, anon;/);
});

// review 5 (G1): two managers stepping down or removing each other at the same moment must not both pass
test('0002_rls.sql: keep_a_manager locks the dealership row, as its own statement, before it looks for another manager', () => {
  const start = rls.indexOf('create or replace function public.keep_a_manager()');
  const fn = rls.slice(start, rls.indexOf('comment on function public.keep_a_manager()', start)).replace(/--.*$/gm, '');
  assert.ok(start >= 0 && fn.length > 0, 'keep_a_manager is defined with a comment after it');
  const branch = fn.indexOf("if old.role = 'manager' and (tg_op = 'DELETE' or new.role is distinct from 'manager') then");
  const lock = fn.indexOf('perform 1 from public.dealerships d where d.id = old.dealership_id for no key update;');
  const check = fn.indexOf('not exists (');
  assert.ok(branch > 0, 'only a change that removes or demotes a manager is checked (and locks)');
  assert.ok(lock > branch, 'the lock is taken inside that branch');
  assert.ok(check > lock, 'the lock comes before the check');
  assert.doesNotMatch(fn.slice(lock, check), /;[^;]*;/, 'nothing but the lock statement between them');
  assert.match(fn.slice(lock, check), /;\s+if found and $/, 'the check is a statement of its own, and is skipped when the dealership row is gone (the cascade)');
  assert.equal((fn.match(/\bfor (no key )?update\b/g) || []).length, 1, 'one lock, and never FOR UPDATE (it would block the key-share locks of inserts that reference the dealership)');
  assert.match(fn, /raise exception 'a dealership keeps at least one manager[^']*' using errcode = 'P0006';/);
  assert.match(rls, /create trigger memberships_keep_a_manager\s+before update or delete on public\.memberships\s+for each row execute function public\.keep_a_manager\(\);/);
});

// review 5 (G25): the plain-Postgres shim grants what Supabase grants, so a forgotten revoke fails a test
test('tests/local-shim.sql has Supabase\'s default privileges; 0002_rls.sql revokes tables and sequences from the API roles', () => {
  const shim = read('../supabase/tests/local-shim.sql').replace(/--.*$/gm, '');
  for (const kind of ['execute on functions', 'all on tables', 'all on sequences']) {
    assert.ok(shim.includes(`alter default privileges in schema public grant ${kind} to anon, authenticated, service_role;`), `the shim grants ${kind} by default`);
  }
  const code = rls.replace(/--.*$/gm, '');
  assert.match(code, /revoke all on all tables in schema public from anon;\s+revoke all on all tables in schema public from authenticated;/);
  assert.match(code, /revoke all on all sequences in schema public from anon, authenticated;/, '"all tables" does not cover sequences');
  // rls.sql holds every table and view to the privileges the policies use
  for (const words of ['anon holds % on public.%', 'authenticated holds % on public.%, not %', "when 'memberships'    then 'DELETE, SELECT, UPDATE (name, role)'", "when 'dealerships'    then 'SELECT, UPDATE (name)'", 'public.rewrite_usage_id_seq']) {
    assert.ok(rlsTest.includes(words), `rls.sql checks: ${words}`);
  }
});

// review 5 (G24): only the column grant may stop a manager of two stores moving a member between them
test('tests/rls.sql: a_mgr manages A and B, so the refused move proves the column grant; C is the wall a manager\'s checks run against', () => {
  assert.match(rlsTest, /\(:'a_mgr',\s+:'dealer_a', 'manager',\s+'Jamie'\),\s+\(:'a_mgr',\s+:'dealer_b', 'manager',\s+'Jamie'\)/);
  assert.match(rlsTest, /update public\.memberships set dealership_id = b where user_id = a_sales and dealership_id = a;\s+raise exception 'a_mgr moved a member to another dealership';\s+exception when insufficient_privilege then null;\s+end;\s+if not exists \(select 1 from public\.memberships where user_id = a_sales and dealership_id = a\)/);
  for (const words of ['a_mgr can see a membership of C', 'a_mgr updated a listing of C', 'a_mgr created an invite for C', 'a_mgr listed C\'\'s invites', 'a_mgr revoked a code of C', 'removing a_mgr from A took the code they made for B']) {
    assert.ok(rlsTest.includes(words), `rls.sql checks: ${words}`);
  }
});

test('tests/rls.sql: an owner-made lower-case code is stored as typed and redeemed in upper case with spaces around it', () => {
  assert.match(rlsTest, /\('made-up-b002', :'dealer_b', 'manager',\s+null\)/, 'inserted by the owner in SQL, no creator');
  assert.match(rlsTest, /public\.redeem_invite\(' MADE-UP-B002 ', null\)/, 'typed as the extension sends codes');
  assert.match(rlsTest, /where code = 'made-up-b002' and used_by/, 'marked used under the stored spelling');
  assert.match(rlsTest, /public\.redeem_invite\(' newcomerb001 ', 'Riley'\)/, 'and an upper-case code typed in lower case');
});

// ---------- the sync function ----------

test('sync/index.ts: take-downs are the known keys missing from the registry, no time compared; take-downs and closed to-do items come back from a margin before since', () => {
  assert.match(sync, /const known = knownKeys\(body\.known\);/);
  assert.match(sync, /const dropped = \[\.\.\.known\.keys\]\.filter\(\(k\) => !inRegistry\.has\(k\)\);/);
  assert.match(sync, /\.eq\('user_id', me\)\.eq\('status', 'listed'\)\.in\('vin', part\)/, 'only the caller\'s own listed rows');
  assert.doesNotMatch(sync, /'created_at'/, 'created_at is never read: the database\'s clock never meets the function\'s');
  assert.doesNotMatch(sync, /lte\('posted_at'/, 'the client\'s stamp is never compared with since');
  assert.doesNotMatch(sync, /created_at:/, 'the function never stamps created_at itself: the database does');
  assert.equal((sync.match(/const serverTime = /g) || []).length, 1);
  const at = sync.indexOf('const serverTime = new Date().toISOString();');
  assert.ok(at > sync.indexOf("// 5. this scan's counts"), 'after the last write');
  assert.ok(at < sync.indexOf("// 6. the dealership's current state"), 'before the state that goes back is read');
  assert.match(sync, /taken_down_at: new Date\(\)\.toISOString\(\)/, 'a take-down carries its own stamp');
  assert.match(sync, /const CUTOFF_MARGIN_MS = 10 \* 60 \* 1000;/);
  assert.match(sync, /const cutoff = since \? new Date\(Date\.parse\(since\) - CUTOFF_MARGIN_MS\)\.toISOString\(\) : /);
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
  assert.ok(strip > 0 && strip < rewrite.indexOf('await rewrite(facts, who, service, clock)'), 'origin is removed from the facts before the prompt');
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
  assert.ok(rewriteGate < rewrite.indexOf('await rewrite(facts, who, service, clock)'), 'before the model call');
  assert.ok(rewriteGate < rewrite.indexOf('await guessColors('), 'before the color call');
  // the shared pieces: one query by dealership id under RLS; the answer's code and sentence
  assert.match(auth, /export async function subscriptionRowOf\(client: SupabaseClient, dealershipId: string\): Promise<SubscriptionRow \| null>/);
  assert.match(auth, /client\.from\('subscriptions'\)\.select\('\*'\)\.eq\('dealership_id', dealershipId\)\.maybeSingle\(\)/);
  assert.match(billingShared, /export const LAPSED_CODE = 'lapsed';/);
  assert.match(billingShared, /export const LAPSED_MESSAGE = "the dealership's Lot Current subscription has lapsed: a manager can renew it, and the manager view's Billing card says how";/);
  assert.match(billingShared, /return \{ ok: false, error: LAPSED_MESSAGE, code: LAPSED_CODE, plan \};/);
  // the billing function is never gated: a lapsed dealership must be able to renew
  assert.doesNotMatch(billing, /lapsedAnswer|402/);
});

test('sync/index.ts answers plan and postsToday; postsToday counts the caller\'s own rows, any status, in the day the extension sent, after the writes, less the ones listed before that day', () => {
  assert.match(sync, /import \{[^}]*\btodayRange\b[^}]*\} from '\.\.\/_shared\/billing\.mjs'/);
  assert.match(sync, /const today = todayRange\(body\.today\);/, 'the request\'s day is taken through the shared check, or it is null');
  const count = /const postsToday = today \? await countOf\(client\.from\('listings'\)\.select\('id', \{ count: 'exact', head: true \}\)\.eq\('dealership_id', dealershipId\)\.eq\('user_id', me\)\.eq\('listed_before', false\)\.gte\('posted_at', today\.from\)\.lt\('posted_at', today\.to\), 'could not count listings'\) : null;/;
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
  assert.match(card, /\*\*Subscribe\*\* POSTs `\{ returnUrl, dealershipId, seats \}` to `\/billing\/checkout`/);
  assert.match(card, /\*\*Manage billing\*\* POSTs `\{ returnUrl, dealershipId \}` to `\/billing\/portal`/);
  assert.match(card, /salespeople see the line and no buttons/);
  assert.doesNotMatch(readme, /not wired in this step/, 'the card is wired now');
});

// The billing function lets a browser page call it only from an origin in
// ALLOWED_ORIGINS, and the hosted manager view's Billing card calls it from
// its own: a setup that sets ALLOWED_RETURN_ORIGINS and not ALLOWED_ORIGINS
// leaves the card at "Couldn't read the plan" while check-deploy's extension
// lines read ok.
test('every command block that sets ALLOWED_RETURN_ORIGINS sets ALLOWED_ORIGINS to the manager view too, and no doc calls it optional', () => {
  for (const doc of ['supabase/README.md', 'docs/stripe-setup.md', 'docs/production-setup.md']) {
    const text = read(`../${doc}`);
    const blocks = [...text.matchAll(/```[a-z]*\n([^]*?)```/g)].map((m) => m[1]).filter((b) => /secrets set ALLOWED_RETURN_ORIGINS=/.test(b));
    // or in the Supabase Dashboard's secrets, as a table of names and values (docs/stripe-setup.md step 5)
    const table = /^\| `ALLOWED_RETURN_ORIGINS` \| ([^|\n]+) \|$/m.exec(text);
    if (table) assert.ok(text.includes(`| \`ALLOWED_ORIGINS\` | ${table[1].trim()} |`), `${doc}: the secrets table sets ALLOWED_RETURN_ORIGINS without ALLOWED_ORIGINS to the same address`);
    if (doc !== 'docs/production-setup.md') assert.ok(blocks.length >= 1 || table, `${doc} sets the billing secrets in a command block or a secrets table`);
    for (const b of blocks) {
      const back = /secrets set ALLOWED_RETURN_ORIGINS=(\S+)/.exec(b)[1];
      assert.ok(b.includes(`secrets set ALLOWED_ORIGINS=${back}`), `${doc}: a block sets ALLOWED_RETURN_ORIGINS=${back} without ALLOWED_ORIGINS=${back}`);
    }
    assert.doesNotMatch(text, /`ALLOWED_ORIGINS` \| function secret, optional/, `${doc} calls ALLOWED_ORIGINS optional`);
  }
  assert.match(readme, /\| `ALLOWED_ORIGINS` \| function secret \| [^\n]*The hosted manager view's origin must be in it/);
  assert.doesNotMatch(http, /\(the manager\s*\n?\/\/ page during development, say\)/, 'http.ts says the hosted manager view needs it');
});

test('supabase/README.md says what the code does: the code folding, the known-keys rule, the rewrite origin rule, the migrations rule', () => {
  assert.match(readme, /a code works once and for 7 days/);
  assert.match(readme, /marks as taken down the caller's listed rows whose key is in `known` and missing from `posted` \(no time decides it/);
  assert.match(readme, /a request without `known` takes nothing down/);
  assert.match(readme, /the answer looks back 10 minutes before `since`/);
  assert.match(readme, /matches none of their dealerships gets 403/);
  assert.match(readme, /The production project has applied `0001_schema\.sql` to `0008_usage\.sql`, and `db push` never runs a file again once it has applied it, so those files are never edited, not even their comments/);
  assert.doesNotMatch(readme, /Until the first project has applied them/, 'the in-place rule ended when production applied the files');
  // the pilot lists go up by the machine's own clock, never by the server's `since`
  assert.match(readme, /The pilot lists never meet `since`: their stamps are the machine's own clock/);
  assert.match(readme, /`localSince`, its own clock when its last successful sync began/);
  assert.doesNotMatch(readme, /a clock running far behind can keep an attempt or a flag from going up/);
});

test('supabase/README.md says how the webhook settles events from one second and two deliveries at once', () => {
  assert.match(readme, /a tie is settled by Stripe's own lifecycle: a subscription is incomplete only when it is created, and canceled and incomplete_expired are final/);
  assert.match(readme, /an event's change is written only onto the row as it was read/);
});

// Security audit (2026-09-29): invite codes expire, die with their maker, give one answer and are throttled;
// managers list and revoke them; the website origin is not a manager's to change; the deployment steps never
// leave a guessable code, a localhost Site URL or the default email budget behind.
test('invite codes: 7-day expiry, one answer for every bad code, a throttle, list and revoke for managers, gone with their maker', () => {
  assert.match(schema, /expires_at timestamptz not null default \(now\(\) \+ interval '7 days'\)/);
  assert.match(schema, /create table public\.invite_misses/);
  assert.match(rls, /revoke all on public\.invite_misses from anon, authenticated, service_role;/);
  assert.match(rls, /alter table public\.invite_misses enable row level security;/);
  // the definition the database runs: the last migration that creates the function
  const { sql: redeemFile } = lastDefinition('redeem_invite');
  const redeem = redeemFile.slice(redeemFile.indexOf('create or replace function public.redeem_invite'), redeemFile.indexOf('comment on function public.redeem_invite'));
  assert.ok(redeem.indexOf('invite_misses') < redeem.indexOf('from public.invites'), 'the throttle runs before the code is looked up');
  // answered, not raised: a raise would roll back the delete of every account's old misses that runs first
  assert.match(redeem, /if misses >= 10 then\s+perform set_config\('response\.status', '400', true\);\s+return jsonb_build_object\('code', 'P0005', 'message', 'too many attempts; try again in an hour', 'details', null::text, 'hint', null::text\);/);
  assert.doesNotMatch(redeem, /raise exception[^;]*'P0005'/, 'the throttle is never raised');
  assert.ok(rlsTest.includes('another account\'\'s miss from three hours ago survived a throttled redeem_invite'), 'rls.sql checks a throttled call keeps its delete');
  // round H review: misses older than an hour go at anyone's call (docs/data-inventory.md's retention line), which rls.sql proves
  assert.match(rlsTest, /insert into public\.invite_misses \(user_id, at\) values\s+\(:'b_sales', now\(\) - interval '2 hours'\),\s+\(:'c_sales', now\(\) - interval '5 minutes'\);/);
  for (const words of ['another account\'\'s miss from two hours ago survived the newcomer\'\'s redeem_invite', 'another account\'\'s miss from five minutes ago was dropped']) {
    assert.ok(rlsTest.includes(words), `rls.sql checks: ${words}`);
  }
  assert.match(redeem, /inv\.expires_at <= now\(\)/);
  assert.match(redeem, /m\.role = 'manager'/, 'a code dies with its maker\'s manager role');
  assert.match(redeem, /'code', 'P0002', 'message', 'that invite code is not valid'/);
  assert.doesNotMatch(redeem, /P0003|already used|was not found/, 'no second answer that tells a used code from an unknown one');
  for (const fn of ['list_invites(uuid)', 'revoke_invite(text)']) {
    assert.ok(rls.includes(`revoke execute on function public.${fn} from public, anon;`), fn);
    assert.ok(rls.includes(`grant execute on function public.${fn} to authenticated, service_role;`), fn);
  }
  assert.match(rls, /not public\.is_manager\(list_invites\.dealership_id\)[\s\S]*?errcode = '42501'/);
  assert.match(rls, /and public\.is_manager\(i\.dealership_id\);\s+get diagnostics n = row_count;\s+return n > 0;/);
  assert.match(rls, /create trigger memberships_forget_invites\s+after delete on public\.memberships/);
  // making a manager a salesperson cancels their unused codes too, or one would work again the day they were promoted back
  assert.match(rls, /create trigger memberships_forget_invites_on_demote\s+after update of role on public\.memberships\s+for each row when \(old\.role = 'manager' and new\.role is distinct from 'manager'\)\s+execute function public\.forget_invites_of_removed_member\(\);/);
  // a stored salesperson name is changed only by the owner, so a full sync cannot write an old name back
  const keep = rls.slice(rls.indexOf('create or replace function public.keep_stored_salesperson()'), rls.indexOf('comment on function public.keep_stored_salesperson()'));
  assert.match(keep, /if current_user in \('anon', 'authenticated'\) and old\.salesperson is not null then\s+new\.salesperson := old\.salesperson;/);
  assert.doesNotMatch(keep, /security definer/, 'current_user must be the caller');
  for (const table of ['listings', 'post_attempts']) {
    assert.match(rls, new RegExp(`create trigger ${table}_keep_salesperson\\s+before update of salesperson on public\\.${table}\\s+for each row execute function public\\.keep_stored_salesperson\\(\\);`), table);
  }
  assert.match(rls, /grant select on public\.dealerships to authenticated;\s[\s\S]*?grant update \(name\) on public\.dealerships to authenticated;/);
  assert.doesNotMatch(rls, /grant select, update on public\.dealerships/);
  for (const words of ['a refused code made the newcomer a member', 'the eleventh try inside an hour was answered % with status %', 'a_mgr changed the website of A', 'a removed manager\'\'s unused codes survived', 'a salesperson listed their dealership\'\'s invites', 'a revoked code was revoked twice', 'making a manager a salesperson kept the unused code they made', 'a salesperson changed a stored salesperson name through the API', 'a_sales made themselves a manager', 'a_sales renamed a member', 'a_sales removed another member', 'a_sales renamed their dealership', 'redeeming a salesperson code made a manager a salesperson', 'a manager who already belongs used up the code meant for a new hire', 'a salesperson redeeming a second salesperson code was answered with %', 'a salesperson who already belongs used up a second salesperson code']) {
    assert.ok(rlsTest.includes(words), `rls.sql checks: ${words}`);
  }
});

test('the deployment steps leave no guessable first code, no localhost sign-in and no open email budget', () => {
  assert.doesNotMatch(readme, /any text works/);
  assert.match(readme, /values \(upper\(substr\(md5\(gen_random_uuid\(\)::text \|\| clock_timestamp\(\)::text\), 1, 12\)\), '<the id returned above>', 'manager'\)\s+returning code;/);
  assert.ok(rls.includes("upper(substr(md5(gen_random_uuid()::text || clock_timestamp()::text), 1, 12))"), 'the README mints the first code the way create_invite does');
  assert.doesNotMatch(readme, /signin\.html/);
  assert.match(readme, /set \*\*Site URL\*\* to the manager page's own address/);
  assert.match(readme, /Never leave the Site URL at the `http:\/\/localhost:3000` default/);
  assert.doesNotMatch(readme, /defaults are fine/);
  assert.match(readme, /Rate limits: lower them/);
  const config = read('../supabase/config.toml');
  assert.doesNotMatch(config, /site_url = "http:\/\/localhost:3000"/);
  assert.match(config, /\[auth\.rate_limit\]\s+email_sent = 30\s+sign_in_sign_ups = 30/);
  assert.match(config, /\[functions\.billing\]\s+verify_jwt = false/);
  // the sync limits and the billing rules are written down with the code's numbers
  assert.match(readme, /more than 12 calls by one user in a minute get 429/);
  assert.match(sync, /const PER_MINUTE = 12;/);
  assert.match(readme, /a body over 512 KiB, or more than 2,000 listings/);
  assert.match(sync, /const BODY_LIMIT = 512 \* 1024;/);
  assert.match(sync, /const MAX_ROWS = 2000;/);
  assert.match(readme, /`counts\.conflicts`/);
  assert.match(readme, /code: "open-subscription"/);
});

// ---------- a pilot of the length the agreement names ----------

// start_pilot gives pricing.json's pilotDays and takes no length from the
// caller; a signed pilot agreement may name another length, so the owner
// records it (or extends a pilot) with one statement in SQL. billing.sql runs
// that statement exactly as the README writes it, with values in its two
// brackets.
test('the owner\'s pilot of an agreed length: the README\'s statement is the one billing.sql runs, and start_pilot still takes no length', () => {
  const block = readme.match(/```sql\n\s*(-- owner only: a free pilot[\s\S]*?returning dealership_id, status, pilot_ends_at;)\n\s*```/);
  assert.ok(block, 'supabase/README.md step 5 carries the owner\'s pilot statement');
  const norm = (x) => x.replace(/\s+/g, ' ').trim();
  const stmt = norm(block[1]);
  assert.match(stmt, /^-- owner only: .* insert into public\.subscriptions as s \(dealership_id, status, pilot_ends_at\) values \('<the id returned above>', 'pilot', '<[^>]+>'\) on conflict \(dealership_id\) do update set status = 'pilot', pilot_ends_at = excluded\.pilot_ends_at, updated_at = now\(\) where s\.stripe_subscription_id is null returning /, 'a pilot row, never over a Stripe subscription');
  const escape = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(stmt.split(/'<[^>]*>'/).map(escape).join("'[^']*'"), 'g');
  assert.equal((norm(read('../supabase/tests/billing.sql')).match(pattern) || []).length, 3, 'billing.sql runs the README\'s statement as written: the agreed pilot, its extension, and a dealership with a Stripe subscription');
  const billingSql = read('../supabase/migrations/0004_billing.sql');
  assert.match(billingSql, /create or replace function public\.start_pilot\(dealership_id uuid\)\n/, 'start_pilot takes the dealership only: no manager sets their own pilot length');
  assert.match(readme, /When the signed agreement names another length, record the pilot yourself before the manager signs in/);
  const pilot = read('../PILOT.md');
  assert.match(pilot, /A pilot on the accounts is extended by the owner's statement in `supabase\/README\.md` step 5/, 'PILOT.md says how "extend the pilot" is done');
  // every pilot dealership gets the statement, whatever its length (test/privacy.test.js: its clock starts the day it is made)
  assert.match(pilot, /its pilot row with the signed agreement's start date and length \(the README's pilot statement, "A pilot of the length a signed pilot agreement names", with the agreed end date, run before the manager signs in whatever the length\)/);
});
