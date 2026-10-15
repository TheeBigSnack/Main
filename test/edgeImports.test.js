// The Edge Functions pull their libraries from npm at deploy time. A bare
// `npm:...@2` lets the runtime pick whatever 2.x is newest on the day of the
// deploy, so the code that reads a salesperson's data would change without a
// line of this repo changing. Each one is pinned to the exact release the
// manager page vendors (manager/config.js), so both move on purpose.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const functionsDir = new URL('../supabase/functions/', import.meta.url);

// Every .ts or .mjs file under supabase/functions (the shared helpers too).
const sources = readdirSync(functionsDir, { recursive: true })
  .filter((f) => /\.(ts|mjs|js)$/.test(f))
  .map((f) => ({ name: f, text: readFileSync(new URL(f, functionsDir), 'utf8') }));

// Every npm: specifier named in the functions, with the file it sits in.
const npmSpecs = sources.flatMap(({ name, text }) => [...text.matchAll(/npm:(@?[^'"\s]+)/g)].map((m) => ({ name, spec: m[1] })));

// The version the manager page vendors, the one this repo reviewed.
const managerPin = read('../manager/config.js').match(/supabase-js-(\d+\.\d+\.\d+)\.js/);

test('the Edge Functions name at least one npm library, all of it supabase-js', () => {
  assert.ok(npmSpecs.length > 0, 'the functions import supabase-js from npm');
  assert.ok(npmSpecs.every(({ spec }) => spec.startsWith('@supabase/supabase-js@')), JSON.stringify(npmSpecs));
});

test('every npm import in the Edge Functions is pinned to an exact version, not a range', () => {
  const loose = npmSpecs.filter(({ spec }) => !/@\d+\.\d+\.\d+$/.test(spec));
  assert.deepEqual(loose.map(({ name, spec }) => `${name}: ${spec}`), []);
});

test('the Edge Functions pin the same supabase-js the manager page vendors', () => {
  assert.ok(managerPin, 'manager/config.js names the vendored supabase-js version');
  for (const { name, spec } of npmSpecs) {
    assert.equal(spec, `@supabase/supabase-js@${managerPin[1]}`, `${name} imports ${spec}; manager/config.js vendors ${managerPin[1]}`);
  }
});
