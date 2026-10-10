// Where the extension's accounts live (Milestone 4). `npm run set-project`
// fills this in once the Supabase project exists (docs/production-setup.md,
// step 1). With url and anonKey filled, accountsConfigured() is true: the
// first-run wizard has its optional Account step and Settings offers
// sign-in. Those work only once the project's database, functions and
// sign-in email are set up (docs/production-setup.md, steps 3 to 5, with
// npm run check-deploy showing no FAIL), and docs/release.md says not to hand
// a build to anyone before then. Nothing is sent to the project until a
// salesperson asks for a sign-in code, and nothing syncs until one is signed
// in. The committed values name the production project (the deploy
// workflow refuses to run unless they name the project it deploys to), so
// every build made from this file offers sign-in, except the pilot zip
// (npm run pack -- --pilot), which empties the values in its own copy. The
// test drive (demo/) never reaches the project: its chrome-shim.js answers
// every request to it.
//
// With every value empty, accountsConfigured() is false and the extension
// behaves exactly as it did without accounts: the Account section in
// Settings shows one line, nothing signs in, nothing syncs, and no request
// goes to the account project. Website reads, photo downloads, the VIN
// lookup and, when the dealer turns it on, the rewrite service still leave
// the browser as they always did.
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
