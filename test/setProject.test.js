// scripts/set-project.mjs: the one way the production project's address and
// publishable key reach extension/src/accountConfig.js and manager/config.js
// (docs/production-setup.md), and the --check the manager view's deploy
// workflow runs before anything is uploaded.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyProject, setField, readiness, projectUrlProblem, keyProblem, isPinnedClient, FILES } from '../scripts/set-project.mjs';
import { CONFIG } from '../manager/config.js';
import { ACCOUNT } from '../extension/src/accountConfig.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const texts = () => ({ account: read(FILES.account.path), manager: read(FILES.manager.path) });
const URL_ = 'https://abcdefghijklmnopqrst.supabase.co';
const KEY = 'sb_publishable_abcDEF123_xyz';
const jwt = (role) => ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', Buffer.from(JSON.stringify({ role })).toString('base64url'), 'sig'].join('.');
const load = async (text) => import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`);

test('applyProject writes the same URL and key into both files and changes nothing else', async () => {
  const before = texts();
  const out = applyProject(before, `${URL_}/`, `  ${KEY} `);
  const { ACCOUNT: a } = await load(out.account);
  const { CONFIG: m } = await load(out.manager);
  assert.deepEqual([a.url, a.anonKey, a.functionsUrl], [URL_, KEY, '']);
  assert.deepEqual([m.supabaseUrl, m.supabaseAnonKey, m.functionsUrl, m.supabaseJs, m.selfServeSignup], [URL_, KEY, '', CONFIG.supabaseJs, false]);
  const changed = (x, y) => x.split('\n').filter((line, i) => line !== y.split('\n')[i]).length;
  assert.equal(changed(before.account, out.account), 2);
  assert.equal(changed(before.manager, out.manager), 2);
  assert.deepEqual(readiness({ account: a, manager: m }), []);
  // running it again with another project replaces, never appends
  const again = applyProject(out, 'https://zyxwvutsrqponmlkjihg.supabase.co', jwt('anon'));
  assert.equal((await load(again.manager)).CONFIG.supabaseUrl, 'https://zyxwvutsrqponmlkjihg.supabase.co');
});

test('a secret key, a service_role key or something else is refused and the message never repeats it', () => {
  for (const bad of ['sb_secret_leakedvalue', jwt('service_role'), 'anon-key', '']) {
    assert.throws(() => applyProject(texts(), URL_, bad), (e) => {
      assert.doesNotMatch(e.message, /leakedvalue|sig\b/);
      return true;
    }, bad);
  }
  assert.match(keyProblem('sb_secret_x'), /roll this one/);
  assert.equal(keyProblem(KEY), '');
  assert.equal(keyProblem(jwt('anon')), '', 'the legacy anon key still works until Supabase retires it');
});

test('only a hosted project address is taken: https, <20-character ref>.supabase.co, no path', () => {
  assert.equal(projectUrlProblem(URL_), '');
  assert.equal(projectUrlProblem(`${URL_}/`), '');
  for (const bad of ['', 'http://abcdefghijklmnopqrst.supabase.co', 'https://abc.supabase.co', `${URL_}/rest/v1`, 'https://api.lotcurrent.example', 'http://127.0.0.1:54321', 'https://ABCDEFGHIJKLMNOPQRST.supabase.co']) {
    assert.notEqual(projectUrlProblem(bad), '', bad);
  }
});

test('setField refuses a file it cannot read the one line from, and quotes what it writes', () => {
  assert.throws(() => setField("  url: '',\n  url: '',\n", 'url', 'x'), /found 2/);
  assert.throws(() => setField('export const A = {};\n', 'url', 'x'), /found 0/);
  assert.equal(setField("  url: 'old',\n", 'url', "it's"), "  url: 'it\\'s',\n");
});

test('the supabase-js address is pinned to an exact version; a bare major or a tag is not', () => {
  assert.ok(isPinnedClient(CONFIG.supabaseJs), CONFIG.supabaseJs);
  assert.ok(isPinnedClient('./vendor/supabase-js-2.117.2.js'));
  for (const loose of ['https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm', 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@latest/+esm', 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm', 'https://esm.sh/@supabase/supabase-js@2.117.2', '']) {
    assert.equal(isPinnedClient(loose), false, loose);
  }
});

test('--check: the committed files are not ready until the project exists, and say why', () => {
  const problems = readiness({ account: ACCOUNT, manager: CONFIG });
  if (!CONFIG.supabaseUrl) {
    assert.ok(problems.some((p) => /supabaseUrl: no project URL/.test(p)));
    assert.ok(problems.some((p) => /supabaseAnonKey: no key/.test(p)));
  } else {
    assert.deepEqual(problems, [], 'once filled, the committed files are ready to deploy');
  }
  const mixed = readiness({ account: { url: URL_, anonKey: KEY }, manager: { ...CONFIG, supabaseUrl: URL_, supabaseAnonKey: 'sb_publishable_other' } });
  assert.ok(mixed.some((p) => /different projects or keys/.test(p)));
  const loose = readiness({ account: { url: URL_, anonKey: KEY }, manager: { ...CONFIG, supabaseUrl: URL_, supabaseAnonKey: KEY, supabaseJs: 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm' } });
  assert.deepEqual(loose.length, 1);
  assert.match(loose[0], /not pinned/);
});
