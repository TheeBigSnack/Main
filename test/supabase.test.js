// Supabase (Milestone 4): the migrations, the SQL test and the two Edge
// Functions held to the rules a Node test can read off their source. Nothing
// here runs SQL or Deno (supabase/README.md says how to run rls.sql against
// a database); it keeps the rules from drifting: every table is under RLS,
// an invite code is matched ignoring case and spaces on both sides, the sync
// function's take-down rule compares server stamps only, both functions
// pick the dealership by the same origin comparison and refuse an unknown
// one, and the README says what the code does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const schema = read('../supabase/migrations/0001_schema.sql');
const rls = read('../supabase/migrations/0002_rls.sql');
const rlsTest = read('../supabase/tests/rls.sql');
const http = read('../supabase/functions/_shared/http.ts');
const sync = read('../supabase/functions/sync/index.ts');
const rewrite = read('../supabase/functions/rewrite/index.ts');
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

// ---------- the README ----------

test('supabase/README.md says what the code does: the code folding, the created_at rule, the rewrite origin rule, in-place migrations', () => {
  assert.match(readme, /any text works as a code \(matched ignoring case and surrounding spaces\)/);
  assert.match(readme, /`listings\.created_at`, stamped by the server when the row arrived/);
  assert.match(readme, /the client's `postedAt` is never compared with `since`/);
  assert.match(readme, /matches none of their dealerships gets 403/);
  assert.match(readme, /Until the first project has applied them, a change to the schema is made in the file that defines it/);
  assert.match(readme, /The pilot lists are the one place a client clock still meets `since`/);
});
