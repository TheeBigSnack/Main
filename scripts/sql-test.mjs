#!/usr/bin/env node
// Runs the Supabase SQL checks against a plain Postgres (CI's service
// container, or a local throwaway database): the shim that stands in for
// Supabase's auth schema, every migration in order, then every file in
// supabase/tests/ except the shim, each in its own psql run so a failure
// names its file. The migrations are applied once, so every test file must
// leave the database as it found it: most roll themselves back, and
// concurrency.sql, whose two dblink sessions have to commit, removes what it
// made. The script checks that after each file (FINGERPRINT below), so the
// order of the tests does not matter and a file that leaves something
// behind fails by name.
//
//   PGHOST=... PGUSER=... PGPASSWORD=... PGDATABASE=... node scripts/sql-test.mjs
//
// Never point it at a Supabase project: the shim creates its own auth schema,
// and concurrency.sql needs a superuser and commits rows (then removes them).

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

// What a test file must leave as it found it: the row count of every table
// in public and auth, the installed extensions and the schemas (a session's
// temporary schemas aside, which Postgres keeps for reuse).
export const FINGERPRINT = `select concat_ws(E'\\n',
  (select string_agg(format('%I.%I %s', t.schemaname, t.tablename,
            (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', t.schemaname, t.tablename), false, true, '')))[1]::text),
          E'\\n' order by t.schemaname, t.tablename)
   from pg_tables t where t.schemaname in ('public', 'auth')),
  (select 'extensions ' || string_agg(e.extname, ' ' order by e.extname) from pg_extension e),
  (select 'schemas ' || string_agg(n.nspname, ' ' order by n.nspname) from pg_namespace n where n.nspname !~ '^pg_(toast_)?temp_'))`;

// The lines of `before` and `after` that differ, for the failure message.
export function changed(before, after) {
  const a = new Set(before.split('\n'));
  const b = new Set(after.split('\n'));
  return [...[...a].filter((l) => !b.has(l)).map((l) => `- ${l}`), ...[...b].filter((l) => !a.has(l)).map((l) => `+ ${l}`)];
}

function psql(files) {
  const args = ['-v', 'ON_ERROR_STOP=1', '-q', '-X'];
  for (const f of files) args.push('-f', f);
  return spawnSync('psql', args, { encoding: 'utf8' });
}

function fingerprint() {
  const r = spawnSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '-X', '-A', '-t', '-c', FINGERPRINT], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`could not read the database's state: ${r.stderr}`);
  return r.stdout.trim();
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
  let state = fingerprint();
  for (const file of tests) {
    const r = psql([file]);
    const last = (r.stdout.trim().split('\n').pop() || '').trim();
    const now = fingerprint();
    const left = changed(state, now);
    state = now;
    if (r.status === 0 && left.length === 0) console.log(`ok    ${file.slice(ROOT.length)}: ${last}`);
    else {
      failed += 1;
      const note = left.length ? `It left the database changed:\n${left.join('\n')}\n` : '';
      console.error(`FAIL  ${file.slice(ROOT.length)}\n${r.stdout}${r.stderr}${note}`);
    }
  }
  console.log(failed ? `${failed} SQL test file(s) failed.` : `Every SQL test file passed (${tests.length}).`);
  process.exitCode = failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
