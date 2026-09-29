// scripts/sql-test.mjs: the shim first, then the migrations in number order,
// then every test file but the shim; and CI runs it on Postgres 16.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { plan } from '../scripts/sql-test.mjs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('the SQL plan: shim, migrations in order, every test file but the shim', () => {
  const p = plan(['0002_rls.sql', '0001_schema.sql', 'notes.md', '0010_later.sql'], ['rls.sql', 'local-shim.sql', 'billing.sql', 'port-check.mjs']);
  assert.deepEqual(p.setup.map((f) => f.split('/').pop()), ['local-shim.sql', '0001_schema.sql', '0002_rls.sql', '0010_later.sql']);
  assert.deepEqual(p.tests.map((f) => f.split('/').pop()), ['billing.sql', 'rls.sql']);
  // the real folders: every migration and every test file is picked up
  const real = plan(readdirSync(new URL('../supabase/migrations', import.meta.url)), readdirSync(new URL('../supabase/tests', import.meta.url)));
  assert.ok(real.setup.length >= 6, 'the shim and at least five migrations');
  assert.ok(real.tests.some((f) => f.endsWith('rls.sql')) && real.tests.some((f) => f.endsWith('billing.sql')));
});

test('CI runs the SQL checks on a Postgres 16 service container', () => {
  const ci = read('../.github/workflows/ci.yml');
  const job = ci.slice(ci.indexOf('  sql:'), ci.indexOf('  pack:'));
  assert.match(job, /image: postgres:16/);
  assert.match(job, /run: node scripts\/sql-test\.mjs/);
  assert.match(job, /PGHOST: 127\.0\.0\.1/);
});
