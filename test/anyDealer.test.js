// CLAUDE.md, "Build for any dealer": the pilot dealer is a fixture, not a
// default. No value that belongs to one store may sit in the code that ships
// (comments may still record what the live runs taught).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './helpers.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const PILOT = /Waynesburg|Ron Lewis|Cranberry|Pleasant Hills|15370|\$\s?490\b|\bRoger\b|ronlewis/i;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(m?js|ts|html|json)$/.test(name)) out.push(full);
  }
  return out;
}

// The hosted rewrite service's prompt and guardrails (supabase/functions)
// are code that ships too, in TypeScript and .mjs.
test('the shipped code and the rewrite services carry no pilot-dealer value', () => {
  const files = [...walk(join(root, 'extension')), ...walk(join(root, 'backend')).filter((f) => !/package(-lock)?\.json$/.test(f)), ...walk(join(root, 'supabase', 'functions'))];
  assert.ok(files.length > 30);
  for (const shipped of ['supabase/functions/_shared/rewritePrompt.ts', 'supabase/functions/_shared/guardrails.ts', 'supabase/functions/rewrite/index.ts', 'supabase/functions/_shared/billing.mjs']) {
    assert.ok(files.includes(join(root, shipped)), `${shipped} is checked`);
  }
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const code = /\.(m?js|ts)$/.test(file) ? stripComments(src, { trailing: true }) : src;
    const hit = code.match(PILOT);
    assert.equal(hit, null, `${file.slice(root.length)} contains "${hit && hit[0]}" outside a comment`);
  }
});

test('the manifest and the popup speak to any dealership', () => {
  const manifest = readFileSync(join(root, 'extension/manifest.json'), 'utf8');
  assert.doesNotMatch(manifest, /Waynesburg|Ron Lewis/);
  const popup = readFileSync(join(root, 'extension/popup.js'), 'utf8');
  assert.doesNotMatch(popup, /placeholder="(e\.g\. )?(Roger|PA|15370)"/);
});
