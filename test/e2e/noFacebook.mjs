// The real facebook.com is never contacted in tests (CLAUDE.md). Two things
// make sure of it in every flow:
//   - the flow's test copy of the extension may script only the local mock
//     servers (manifest.host_permissions = ['http://127.0.0.1/*']), so
//     nothing of Lot Current's can be injected into a Facebook page or read
//     from one;
//   - blockFacebook() below stops any Facebook address from loading at all,
//     should the form map's test overrides (devOverrides) ever fail to
//     apply, and assertNone() then fails the flow naming what was asked for.
// test/posting.test.js checks that every flow does both.

import assert from 'node:assert/strict';

export const FACEBOOK_ADDRESS = /^https?:\/\/([^/?#]*\.)?(facebook\.com|fb\.com|fbcdn\.net|messenger\.com)(:\d+)?([/?#]|$)/i;

export async function blockFacebook(context) {
  const blocked = [];
  await context.route(FACEBOOK_ADDRESS, (route) => {
    blocked.push(route.request().url());
    return route.abort('blockedbyclient');
  });
  return {
    blocked,
    assertNone() {
      assert.deepEqual(blocked, [], `the flow asked for the real Facebook: ${blocked.join(', ')}`);
    },
  };
}
