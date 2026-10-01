// Where the extension's accounts live (Milestone 4). The committed values
// name the production Supabase project (docs/production-setup.md step 1:
// `npm run set-project` writes them, and the deploy workflow refuses to run
// unless they name the project it deploys to). So every build made from
// this file has accounts switched on: set-up has its Account step and
// Settings offers sign-in, whether or not the project's functions, sign-in
// email and manager view are live yet (production-setup steps 3 to 6 say
// when they are). With both values empty, accountsConfigured() is false and
// the extension behaves exactly as it did without accounts: the Account
// section in Settings shows one line, nothing signs in, nothing syncs, and
// no request leaves the browser. The test drive (demo/) never reaches the
// project: its chrome-shim.js answers every request to it.
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
  url: 'https://dblbfgfkmzlfdwzbcvpj.supabase.co',
  anonKey: 'sb_publishable_dFXfRnfVqhUqZKxM2r_ylw_6uU4d2bt',
  functionsUrl: '',
});

export const accountsConfigured = (config = ACCOUNT) => Boolean(config && config.url && config.anonKey);
