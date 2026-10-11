import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('npm run test:branding-eval runs the dealer-branding check on one seed of every scenario, without the timing runs', () => {
  const scripts = JSON.parse(read('../package.json')).scripts;
  assert.equal(scripts['test:branding-eval'], 'node scripts/branding-eval/run.mjs --seeds=1 --no-timing');
});

test('CI runs the branding eval in the demo job, and the eval exits 1 on a false crop, a lie or a false flag', () => {
  const ci = read('../.github/workflows/ci.yml');
  const demo = ci.match(/\n  demo:\n[\s\S]*?\n(?=  [a-z#])/);
  assert.ok(demo, 'the demo job is not found in ci.yml');
  assert.match(demo[0], /- run: npm run test:branding-eval/, 'the demo job does not run the branding eval');
  assert.match(read('../scripts/branding-eval/run.mjs'), /if \(failing\.length\) process\.exitCode = 1;/, 'run.mjs no longer fails on a bad scenario');
});
