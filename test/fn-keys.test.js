// Which API key the Edge Functions use (supabase/functions/_shared/auth.ts).
// Supabase is retiring the legacy anon and service_role keys by the end of
// 2026; the runtime hands the new publishable and secret keys over as JSON
// objects keyed by name. The new key wins when there is one, the legacy one
// stands in until then, and a malformed set falls back instead of breaking
// sign-in (docs/production-setup.md, "API keys").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFunction, invoke, fake, hermetic, uuid, ANON_KEY, SERVICE_KEY } from './functions/harness.mjs';
// After the harness: its module hook is what resolves auth.ts's npm: import.
const { keyFromSet } = await import('../supabase/functions/_shared/auth.ts');

hermetic();

const PUBLISHABLE = 'sb_publishable_for-the-function-tests';
const SECRET = 'sb_secret_for-the-function-tests';
const SITE = 'https://site.example.test';
const TOKEN = 'token-of-a-stranger';
const FORM = { name: 'Pat Doe', dealership: 'Example Motors', website: 'www.example-motors.test', email: 'pat@example-motors.test', phone: '', message: '', company_url: '' };

function world() {
  fake.reset({ users: { [TOKEN]: { id: uuid(21), email: 'new@example.test' } }, rows: {} });
}
const sync = (handler) => invoke(handler, { path: 'sync', token: TOKEN, body: { origin: 'https://www.example-motors.test', posted: {}, pilot: { posts: [], flags: [] }, scan: null, since: null } });
const lead = (handler) => invoke(handler, { path: 'lead', origin: SITE, body: FORM, headers: { 'cf-connecting-ip': '192.0.2.1' } });

test('keyFromSet: the key named default, else the first one; empty for nothing, malformed JSON or a non-object', () => {
  assert.equal(keyFromSet(JSON.stringify({ default: 'a', other: 'b' })), 'a');
  assert.equal(keyFromSet(JSON.stringify({ other: 'b', more: 'c' })), 'b');
  assert.equal(keyFromSet(JSON.stringify({ default: '', other: 'b' })), 'b', 'an empty default is no key');
  for (const bad of ['', 'not json', '"a string"', '["a"]', 'null', '{}', JSON.stringify({ default: 42 })]) assert.equal(keyFromSet(bad), '', JSON.stringify(bad));
});

test('the caller\'s client: the publishable key when the runtime has one, the legacy anon key otherwise', async () => {
  world();
  const fresh = await loadFunction('sync', { SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: PUBLISHABLE }) });
  assert.equal((await sync(fresh)).status, 403, 'a signed-in stranger');
  assert.ok(fake.calls.length > 0);
  for (const c of fake.calls) assert.equal(c.key, PUBLISHABLE, `${c.kind} ${c.op || ''}`);

  world();
  const legacy = await loadFunction('sync');
  assert.equal((await sync(legacy)).status, 403);
  for (const c of fake.calls) assert.equal(c.key, ANON_KEY);

  world();
  const broken = await loadFunction('sync', { SUPABASE_PUBLISHABLE_KEYS: '{not json' });
  assert.equal((await sync(broken)).status, 403, 'a malformed set falls back to the legacy key');
  for (const c of fake.calls) assert.equal(c.key, ANON_KEY);

  world();
  const onlyNew = await loadFunction('sync', { SUPABASE_ANON_KEY: undefined, SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: PUBLISHABLE }) });
  assert.equal((await sync(onlyNew)).status, 403, 'works with the legacy key turned off');
});

test('the service client: the secret key when the runtime has one, the legacy service_role key otherwise, never the publishable one', async () => {
  world();
  const fresh = await loadFunction('lead', { LEAD_ORIGINS: SITE, SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: PUBLISHABLE }), SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET }) });
  assert.equal((await lead(fresh)).status, 200);
  assert.equal(fake.writes('demo_requests').length, 1);
  assert.deepEqual([...new Set(fake.clients.map((c) => c.key))], [SECRET]);

  world();
  const legacy = await loadFunction('lead', { LEAD_ORIGINS: SITE });
  assert.equal((await lead(legacy)).status, 200);
  assert.deepEqual([...new Set(fake.clients.map((c) => c.key))], [SERVICE_KEY]);

  world();
  const onlyNew = await loadFunction('lead', { LEAD_ORIGINS: SITE, SUPABASE_SERVICE_ROLE_KEY: undefined, SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET }) });
  assert.equal((await lead(onlyNew)).status, 200, 'works with the legacy key turned off');
});
