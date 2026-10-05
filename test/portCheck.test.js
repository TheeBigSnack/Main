// The Edge Function's copies of the guardrails and the rewrite prompt
// (supabase/functions/_shared/guardrails.ts and rewritePrompt.ts) must say
// exactly what their originals say (extension/src/rewriteTemplate.js and
// backend/rewritePrompt.js), or the hosted service writes and checks drafts
// on old rules. supabase/tests/port-check.mjs compares them and throws at
// the first difference; importing it here puts it in npm test, and so in CI.

import { test } from 'node:test';

test('the Edge Function copies of the guardrails and the rewrite prompt match their originals', async () => {
  if (!process.features.typescript) throw new Error('the port check needs Node 22.18 or later, which runs .ts files as they are (.nvmrc says 22)');
  await import('../supabase/tests/port-check.mjs');
});
