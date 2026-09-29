// The module hook for the Edge Function tests (registered by harness.mjs).
// The functions import the Supabase client the Deno way, as
// npm:@supabase/supabase-js@2, which Node cannot load; this points that
// specifier at fake-supabase.mjs, so the handlers run against the fake the
// tests set up. Any other npm:, jsr: or web import is a dependency the
// tests do not know about, and loading the function fails with its name
// instead of quietly reaching the network. Everything else resolves as
// usual (Node strips the types from the .ts files itself).

const FAKE_SUPABASE = new URL('./fake-supabase.mjs', import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (/^npm:@supabase\/supabase-js@2(\/|$)/.test(specifier)) return { url: FAKE_SUPABASE, shortCircuit: true };
  if (/^(npm|jsr|https?):/.test(specifier)) throw new Error(`the Edge Function tests have no stand-in for ${specifier}: add one to test/functions/loader.mjs`);
  return next(specifier, context);
}
