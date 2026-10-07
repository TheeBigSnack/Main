// The module hook for test/backend.test.js: backend/server.js imports
// @anthropic-ai/sdk, which is not installed for the tests and must never
// reach the network from them; this points it at fake-anthropic.mjs.
// Everything else resolves as usual.

const FAKE = new URL('./fake-anthropic.mjs', import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === '@anthropic-ai/sdk') return { url: FAKE, shortCircuit: true };
  return next(specifier, context);
}
