// Self-serve sign-up (supabase/migrations/0007_signup.sql), held to the
// rules a Node test can read off its source: nobody but the owner touches
// the two tables, create_dealership runs as its owner with a pinned
// search_path and only for signed-in people, its checks run in the order
// the README gives (signed in, open, throttle, fields, limits under a lock,
// website, then the insert), and the two answers that must survive the
// call are answered rather than raised. Nothing here runs SQL:
// supabase/tests/signup.sql proves the behaviour against a database, and
// this file holds it to every case of test/fixtures/website-origins.json.
// The last part holds supabase/README.md and docs/support.md to the code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const sql = read('../supabase/migrations/0007_signup.sql');
const code = sql.replace(/--.*$/gm, '');
const sqlTest = read('../supabase/tests/signup.sql');
const readme = read('../supabase/README.md');
const support = read('../docs/support.md');
const fixture = JSON.parse(read('./fixtures/website-origins.json'));

const body = (name) => {
  const start = code.indexOf(`create or replace function public.${name}(`);
  const end = code.indexOf(`comment on function public.${name}(`, start);
  assert.ok(start >= 0 && end > start, `0007_signup.sql has no ${name}() with a comment after it`);
  return code.slice(start, end);
};
const section = (text, heading) => {
  const start = text.indexOf(heading);
  assert.ok(start >= 0, `no "${heading}"`);
  const level = heading.match(/^#+ /)[0];
  const end = text.indexOf('\n' + level, start + heading.length);
  return text.slice(start, end > 0 ? end : undefined);
};
// a SQL string literal as signup.sql writes it
const literal = (s) => `'${s.replace(/'/g, "''")}'`;
// a message as the SQL holds it (doubled quotes) and as a person reads it
const said = (s) => s.replace(/''/g, "'");

const API_ROLES = 'public, anon, authenticated, service_role';

test('0007_signup.sql: one settings row, closed, with the two limits; attempts per account, created or taken', () => {
  assert.match(sql, /create table public\.signup_settings \(\n  id boolean primary key default true check \(id\),\n  open boolean not null default false,\n  per_account int not null default 1,\n  per_day int not null default 10\n\);/);
  assert.match(code, /^insert into public\.signup_settings default values;$/m, 'the migration inserts the one row');
  const attempts = /create table public\.signup_attempts \(([^]*?)\n\);/.exec(sql);
  assert.ok(attempts, 'signup_attempts is created');
  assert.match(attempts[1], /\n  user_id uuid not null references auth\.users \(id\) on delete cascade,/, 'an attempt goes with its account');
  assert.match(attempts[1], /\n  at timestamptz not null default now\(\),/);
  assert.match(attempts[1], /\n  outcome text not null check \(outcome in \('created', 'taken'\)\),/);
  assert.match(attempts[1], /\n  dealership_id uuid references public\.dealerships \(id\) on delete set null$/, 'and outlives its dealership, so per_account still counts it');
  // what the counts need: the caller's past hour and created rows, and everyone's created rows in the past day
  assert.match(code, /create index \w+ on public\.signup_attempts \(user_id, at\);/);
  assert.match(code, /create index \w+ on public\.signup_attempts \(at\) where outcome = 'created';/);
});

test('0007_signup.sql: no API role, the service role included, reads or writes either table or the sequence', () => {
  for (const t of ['signup_settings', 'signup_attempts']) {
    assert.match(code, new RegExp(`alter table public\\.${t} enable row level security;`), `${t} has RLS on`);
    assert.ok(code.includes(`revoke all on public.${t} from ${API_ROLES};`), `${t}: everything revoked from ${API_ROLES}`);
    assert.doesNotMatch(code, new RegExp(`\\bgrant\\b[^;]*\\bon (table )?public\\.${t}\\b`), `nothing on ${t} is granted`);
    assert.doesNotMatch(code, new RegExp(`create policy[^;]*on public\\.${t}\\b`), `no policy on ${t}`);
  }
  assert.ok(code.includes(`revoke all on sequence public.signup_attempts_id_seq from ${API_ROLES};`), 'the sequence too: "all tables" does not cover it');
  assert.doesNotMatch(code, /\bgrant\b[^;]*\bon sequence\b/);
});

test('create_dealership runs as its owner with a pinned search_path, and only a signed-in person may call it', () => {
  const fn = body('create_dealership');
  assert.match(fn, /^create or replace function public\.create_dealership\(name text, website text, your_name text\)\nreturns jsonb\nlanguage plpgsql security definer\nset search_path = ''\nas \$\$/);
  assert.ok(code.includes('revoke execute on function public.create_dealership(text, text, text) from public, anon, service_role;'));
  const grants = [...code.matchAll(/^grant [^;]*;$/gm)].map((m) => m[0]);
  assert.deepEqual(grants, ['grant execute on function public.create_dealership(text, text, text) to authenticated;'], 'one grant in the file, to authenticated');
  assert.doesNotMatch(code, /\bgrant\b[^;]*\banon\b/, 'nothing is granted to anon');

  const origin = body('website_origin_of');
  assert.match(origin, /^create or replace function public\.website_origin_of\(address text\)\nreturns text\nlanguage plpgsql immutable\nset search_path = ''\nas \$\$/);
  assert.doesNotMatch(origin, /security definer/);
  assert.ok(code.includes(`revoke execute on function public.website_origin_of(text) from ${API_ROLES};`), 'no API role calls website_origin_of');
});

test('create_dealership: the checks run in order a to g, and the limits are counted under the settings row\'s lock', () => {
  const fn = body('create_dealership');
  const at = (what) => {
    const i = typeof what === 'string' ? fn.indexOf(what) : fn.search(what);
    assert.ok(i >= 0, `create_dealership has no ${what}`);
    return i;
  };
  const a = at("if uid is null then\n    raise exception 'sign in first' using errcode = '42501';");
  const b = at("if not coalesce((select s.open from public.signup_settings s where s.id), false) then\n    raise exception '%', closed using errcode = 'P0008';");
  const c = at(/select count\(\*\) into n from public\.signup_attempts a where a\.user_id = uid and a\.at > now\(\) - interval '1 hour';\s+if n >= 5 then/);
  const d = at("errcode = '22023'");
  const lock = at('select * into settings from public.signup_settings s where s.id for update;');
  const perAccount = at(/select count\(\*\) into n from public\.signup_attempts a where a\.user_id = uid and a\.outcome = 'created';\s+if n >= settings\.per_account then\s+raise exception '[^']*(''[^']*)*' using errcode = 'P0010';/);
  const perDay = at(/select count\(\*\) into n from public\.signup_attempts a where a\.outcome = 'created' and a\.at > now\(\) - interval '24 hours';\s+if n >= settings\.per_day then\s+raise exception '[^']*(''[^']*)*' using errcode = 'P0011';/);
  const f = at('if exists (select 1 from public.dealerships d where d.website_origin = origin) then');
  const g = at('insert into public.dealerships as d (name, website_origin)');
  const order = { a, b, c, d, lock, perAccount, perDay, f, g };
  const names = Object.keys(order);
  for (let i = 1; i < names.length; i += 1) assert.ok(order[names[i - 1]] < order[names[i]], `${names[i - 1]} comes before ${names[i]}`);

  // the three fields, and the website through the one rule
  const origin = at('origin := public.website_origin_of(create_dealership.website);');
  assert.ok(d < origin && origin < lock, 'the website is checked with the fields, through website_origin_of');
  for (const [field, limit] of [['dealer_name', 120], ['person_name', 80]]) {
    assert.match(fn, new RegExp(`if length\\(${field}\\) not between 1 and ${limit} or ${field} ~ controls then\\s+raise exception '[^;]*' using errcode = '22023';`), `${field}: 1 to ${limit} characters, no control characters`);
  }
  assert.match(fn, /if origin is null or length\(origin\) > length\(split_part\(origin, ':\/\/', 1\)\) \+ 3 \+ 253 then\s+raise exception 'the website [^;]*' using errcode = '22023';/, 'a refused address, or a host longer than DNS allows');
  // only the one lock, taken once, and nothing counted for the limits before it
  assert.equal((fn.match(/\bfor update\b/g) || []).length, 1);
  assert.equal(fn.slice(0, lock).indexOf("a.outcome = 'created'"), -1, 'no limit is counted before the lock');
  // the insert makes the caller the manager and records the created attempt with the dealership
  assert.match(fn.slice(g), /^insert into public\.dealerships as d \(name, website_origin\)\s+values \(dealer_name, origin\)\s+on conflict \(website_origin\) do nothing\s+returning d\.id into new_id;/);
  assert.match(fn.slice(g), /insert into public\.memberships \(user_id, dealership_id, role, name\) values \(uid, new_id, 'manager', person_name\);/);
  assert.match(fn.slice(g), /insert into public\.signup_attempts \(user_id, outcome, dealership_id\) values \(uid, 'created', new_id\);\s+pilot := public\.start_pilot\(new_id\);/, 'the free pilot starts with the dealership, so a self-serve one never sits in the none state');
  assert.match(fn, /return jsonb_build_object\('dealership_id', new_id, 'name', dealer_name, 'website_origin', origin, 'pilot_ends_at', pilot -> 'pilot_ends_at'\);/);
});

test('create_dealership: P0005 and P0009 are answered, not raised, and a taken website is recorded before the answer', () => {
  const fn = body('create_dealership');
  assert.doesNotMatch(fn, /raise exception[^;]*'P000[59]'/, 'P0005 and P0009 are never raised: the attempt row must survive the call');
  assert.match(fn, /if n >= 5 then\s+perform set_config\('response\.status', '400', true\);\s+return jsonb_build_object\('code', 'P0005', 'message', 'too many attempts; try again in an hour', 'details', null::text, 'hint', null::text\);/);
  const taken = /insert into public\.signup_attempts \(user_id, outcome\) values \(uid, 'taken'\);\s+perform set_config\('response\.status', '400', true\);\s+return jsonb_build_object\('code', 'P0009', 'message', taken, 'details', null::text, 'hint', null::text\);/g;
  assert.equal((fn.match(taken) || []).length, 2, 'both the website check and a lost race record the attempt, set 400 and answer P0009');
  assert.match(fn, /if new_id is null then\s+insert into public\.signup_attempts \(user_id, outcome\) values \(uid, 'taken'\);/, 'a website taken between the check and the insert is answered as the check answers');
  assert.equal((fn.match(/'P0009'/g) || []).length, 2);
  // what each sentence says
  const constant = (name) => said(fn.match(new RegExp(`${name} constant text := '((?:[^']|'')*)';`))[1]);
  assert.match(constant('closed'), /^sign-up is not open: .*invite code, from Lot Sync or from your dealership's manager$/);
  assert.match(constant('taken'), /^that website already has a Lot Sync dealership: ask its manager for an invite code \(if nobody there uses Lot Sync, write to Lot Sync support\)$/);
});

test('the trim is JavaScript\'s trim(), in both functions, so the manager page\'s copy and the SQL agree', () => {
  const classes = [...code.matchAll(/ws constant text := '(\[[^']*\]\+)';/g)].map((m) => m[1]);
  assert.equal(classes.length, 2, 'website_origin_of and create_dealership each trim with the same class');
  assert.equal(classes[0], classes[1]);
  const ws = new RegExp(`^${classes[0]}$`);
  for (let cp = 0; cp <= 0xffff; cp += 1) {
    const ch = String.fromCharCode(cp);
    assert.equal(ws.test(ch), ch.trim() === '', `U+${cp.toString(16).padStart(4, '0')}: trimmed by ${ch.trim() === '' ? 'JavaScript only' : 'the SQL only'}`);
  }
});

test('tests/signup.sql writes out every case of the website-origins fixture with its expected origin', () => {
  assert.ok(fixture.cases.length >= 30, 'the fixture has its cases');
  for (const c of fixture.cases) {
    const row = `(${literal(c.input)}, ${c.origin === null ? 'null' : literal(c.origin)})`;
    assert.ok(sqlTest.includes(row), `signup.sql does not check ${row}`);
  }
  assert.ok(sqlTest.includes(`if n <> ${fixture.cases.length} then raise exception 'checked % cases, the fixture has ${fixture.cases.length}', n; end if;`), 'and counts them');
  assert.match(sqlTest, /if public\.website_origin_of\(c\.input\) is distinct from c\.origin then/);
});

test('tests/signup.sql checks the order, both limits, the throttle, the privileges and the new manager, and rolls back', () => {
  for (const words of [
    'a call with no user was answered with %', 'a sign-up while closed was answered with %', 'anon called create_dealership',
    'a signed-in person read signup_settings', 'a signed-in person wrote signup_attempts', 'anon drew from signup_attempts_id_seq',
    '% holds % on %', 'execute on create_dealership for %: %', 'was answered with %, not 22023 naming the %',
    'the sign-up was answered with %', 'p1 is not the manager of their new dealership, as Pat', 'create_invite answered %', 'start_pilot answered %', "the new dealership''s pilot did not start with it",
    'redeeming the new manager\'\'s invite answered %', 'a second sign-up by p1 was answered with %', 'a taken website from an account at its limit was answered with %',
    'a taken website was answered with %', 'the sixth attempt in an hour was answered with %', 'a throttled bad call was answered with %',
    'a throttled account was not told sign-up is closed first', 'p4, with five attempts two hours ago, was answered with %',
    'the fourth sign-up in 24 hours with per_day 3 was answered with %', 'a website taken between the check and the insert was answered with %',
  ]) {
    assert.ok(sqlTest.includes(words), `signup.sql does not check: ${words}`);
  }
  // auth.uid() comes from the claims, as in rls.sql
  assert.match(sqlTest, /select set_config\('request\.jwt\.claims', '\{"sub":"' \|\| :'p1' \|\| '","role":"authenticated"\}', true\) as claims \\gset\nset local role authenticated;/);
  assert.match(sqlTest, /^begin;$/m);
  assert.match(sqlTest, /^rollback;\n\n\\echo 'signup\.sql: every check passed \(all changes rolled back\)'\n$/m);
});

test('supabase/README.md: the Self-serve sign-up section says what the code does, and the file lists name it', () => {
  const s = section(readme, '## Self-serve sign-up');
  // off by default, and the owner's SQL for the switch and the limits
  assert.match(s, /It is \*\*off\*\* until you open it\./);
  for (const line of [
    'update public.signup_settings set open = true;', 'update public.signup_settings set open = false;',
    'update public.signup_settings set per_account = 1;', 'update public.signup_settings set per_day = 10;',
  ]) assert.ok(s.includes(line), `the section does not give: ${line}`);
  assert.match(sql, /per_account int not null default 1,\n  per_day int not null default 10/, 'the README gives the defaults the table has');
  // the page shows the form; the database decides
  assert.match(s, /`selfServeSignup: true` in `manager\/config\.js`/);
  assert.match(s, /\*\*Start your dealership\*\*/);
  assert.match(s, /the database switch is the real gate/);
  assert.match(s, /supabase\.rpc\('create_dealership', \{ name, website, your_name \}\)/);
  // each refusal, with the code's own sentence
  const fn = body('create_dealership');
  const constant = (name) => said(fn.match(new RegExp(`${name} constant text := '((?:[^']|'')*)';`))[1]);
  const raised = (code) => said(fn.match(new RegExp(`raise exception '((?:[^']|'')*)' using errcode = '${code}'`))[1]);
  const refusals = {
    42501: 'sign in first', P0008: constant('closed'), P0005: 'too many attempts; try again in an hour',
    P0010: raised('P0010'), P0011: raised('P0011'), P0009: constant('taken'),
  };
  for (const [code, message] of Object.entries(refusals)) {
    const row = s.split('\n').find((l) => l.startsWith(`| \`${code}\` |`));
    assert.ok(row, `the refusals table has no row for ${code}`);
    assert.ok(row.includes(message), `the ${code} row does not quote "${message}"`);
  }
  assert.ok(s.split('\n').some((l) => l.startsWith('| `22023` |') && /names the field/.test(l)));
  assert.match(s, /\*\*What `P0009` gives away\.\*\*[^\n]*a stranger can learn whether a store is a customer[^\n]*throttle/);
  assert.match(s, /`MONTHLY_COST_CAP_USD` caps that per dealership/, 'why per_day');
  assert.match(s, /step 5 \(a dealership row and a first-manager code\) is how a dealership starts/, 'the owner\'s SQL stays the way in');
  // the file table, the step 5 wording and the plain-Postgres recipe
  assert.match(readme, /^\| `migrations\/0007_signup\.sql` \| /m);
  assert.match(readme, /^\| `tests\/signup\.sql` \| /m);
  assert.doesNotMatch(readme, /there is no sign-up form/);
  const recipe = readme.slice(readme.indexOf('createdb lotsync_test'), readme.indexOf('```', readme.indexOf('createdb lotsync_test')));
  assert.ok(recipe.indexOf('-f supabase/migrations/0007_signup.sql') > recipe.indexOf('-f supabase/migrations/0006_privacy.sql'));
  assert.ok(recipe.includes('-f supabase/tests/signup.sql'));
});

test('docs/support.md: a taken website is settled by the store\'s own phone number, then SQL', () => {
  const s = section(support, '## A website is already taken');
  assert.match(s, /call the main phone number it shows\. Never call a number the requester gives/);
  assert.match(s, /where d\.website_origin = public\.website_origin_of\('<the address they typed>'\);/);
  assert.match(s, /from public\.signup_attempts a[^;]*a\.outcome = 'created';/, 'whether it was started through sign-up, and by whom');
  assert.match(s, /insert into public\.memberships \(user_id, dealership_id, role, name\)\s+values \('<their user id>', '<dealership id>', 'manager', '<their name>'\)\s+on conflict \(user_id, dealership_id\) do update set role = 'manager';/);
  assert.match(s, /select public\.delete_dealership\('<dealership id>', /, 'a squatted row is deleted, the owner\'s tool with its confirm');
  assert.match(s, /step 5 of `supabase\/README\.md`/);
});
