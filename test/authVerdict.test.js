// The sign-in check's verdict on an auth error (supabase/functions/_shared/authVerdict.mjs,
// used by requireUser in _shared/auth.ts): a 4xx from the auth server refuses the token,
// anything else leaves the check unreachable, so an outage never signs anyone out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authVerdict } from '../supabase/functions/_shared/authVerdict.mjs';

test('authVerdict: a 4xx answer from the auth server refuses the token', () => {
  assert.deepEqual([authVerdict({ status: 401 }), authVerdict({ status: 403, code: 'bad_jwt' })], ['refused', 'refused']);
});

test('authVerdict: no answer, a network failure, a 5xx or a status that is not a number leaves the check unreachable', () => {
  const verdicts = [{ message: 'fetch failed' }, { status: 0 }, { status: 500 }, { status: 503 }, { status: '401' }].map(authVerdict);
  assert.deepEqual(verdicts, ['unreachable', 'unreachable', 'unreachable', 'unreachable', 'unreachable']);
});
