#!/usr/bin/env node
// Runs the Supabase SQL checks against a plain Postgres (CI's service
// container, or a local throwaway database): the shim that stands in for
// Supabase's auth schema, every migration in order, then every file in
// supabase/tests/ except the shim, each in its own psql run so a failure
// names its file. Each test file rolls itself back, so the order of the
// tests does not matter; the migrations are applied once.
//
//   PGHOST=... PGUSER=... PGPASSWORD=... PGDATABASE=... node scripts/sql-test.mjs
//
// Never point it at a Supabase project: the shim creates its own auth schema.

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIGRATIONS = join(ROOT, 'supabase/migrations');
const TESTS = join(ROOT, 'supabase/tests');
const SHIM = 'local-shim.sql';

export function plan(migrationFiles, testFiles) {
  const migrations = migrationFiles.filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const tests = testFiles.filter((f) => f.endsWith('.sql') && f !== SHIM).sort();
  return { setup: [join(TESTS, SHIM), ...migrations.map((f) => join(MIGRATIONS, f))], tests: tests.map((f) => join(TESTS, f)) };
}

function psql(files) {
  const args = ['-v', 'ON_ERROR_STOP=1', '-q', '-X'];
  for (const f of files) args.push('-f', f);
  return spawnSync('psql', args, { encoding: 'utf8' });
}

function main() {
  const { setup, tests } = plan(readdirSync(MIGRATIONS), readdirSync(TESTS));
  const s = psql(setup);
  if (s.status !== 0) {
    console.error(s.stdout + s.stderr);
    console.error('The migrations did not apply.');
    process.exit(1);
  }
  console.log(`Applied the shim and ${setup.length - 1} migration(s).`);
  let failed = 0;
  for (const file of tests) {
    const r = psql([file]);
    const last = (r.stdout.trim().split('\n').pop() || '').trim();
    if (r.status === 0) console.log(`ok    ${file.slice(ROOT.length)}: ${last}`);
    else {
      failed += 1;
      console.error(`FAIL  ${file.slice(ROOT.length)}\n${r.stdout}${r.stderr}`);
    }
  }
  console.log(failed ? `${failed} SQL test file(s) failed.` : `Every SQL test file passed (${tests.length}).`);
  process.exitCode = failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
