// Where the extension's accounts live (Milestone 4). The owner fills this in
// once the Supabase project exists (supabase/README.md, "What to create,
// once"); until then every value is empty, accountsConfigured() is false,
// and the extension behaves exactly as it did without accounts: the Account
// section in Settings shows one line, nothing signs in, nothing syncs, and
// no request leaves the browser.
//
//   url          the project URL from Project settings, API, like
//                https://<ref>.supabase.co
//   anonKey      the "anon" (public) key from the same page. It is meant to
//                be shipped to browsers: row-level security on the tables
//                is what keeps a signed-in person inside their own
//                dealership. The service_role key never goes here.
//   functionsUrl where the two Edge Functions answer. Leave it empty to use
//                url + '/functions/v1' (the default on Supabase); set it only
//                when the functions are served from somewhere else.
//
// Both values are public by design; the manager page has the same two in
// manager/config.js (supabaseUrl, supabaseAnonKey). Nothing secret belongs
// in this file or anywhere else in the extension.

export const ACCOUNT = Object.freeze({
  url: '',
  anonKey: '',
  functionsUrl: '',
});

export const accountsConfigured = (config = ACCOUNT) => Boolean(config && config.url && config.anonKey);
