// Where the manager view reads from (Milestone 4, PLAN.md).
//
// supabaseUrl and supabaseAnonKey come from the owner's Supabase project:
// Project settings -> API -> "Project URL" and the "anon" (public) key. The
// anon key is meant to be shipped to browsers; row-level security on the
// tables is what keeps a member inside their own dealership. Never put the
// service key here or anywhere a browser can read.
//
// An empty supabaseUrl means "not set up yet": index.html says so and offers
// the sample data instead (?mock=1), so the page can be demoed and tested
// before the project exists.
//
// functionsUrl is where the Edge Functions answer (the Billing card calls
// .../billing/status, /checkout and /portal). Leave it empty to use the
// project's own <supabaseUrl>/functions/v1, as the extension does; set it
// only when the functions are served from somewhere else.
//
// supabaseJs is the supabase-js client, loaded on demand from a CDN only when
// the page is configured; the sample-data mode never touches the network.
// The client runs with the manager's session, so pin it before going live:
// either an exact version (`@supabase/supabase-js@2.x.y/+esm`, the version
// checked in the npm registry) or, better, the built file copied next to
// this page and named relatively (`./vendor/supabase-js-2.x.y.js`; the same
// import() loads it). index.html's Content-Security-Policy allows scripts
// from this folder and cdn.jsdelivr.net only; change it with this line.
//
// selfServeSignup shows the "Start your dealership" form to a signed-in
// person who is in no dealership yet. It only shows the form: the real gate
// is the switch in the database (signup_settings.open, supabase/README.md
// "Self-serve sign-up"), and create_dealership refuses everyone while that
// is off, whatever this says. Turn both on together; with this false the
// page keeps saying "ask whoever set Lot Sync up for your store".
export const CONFIG = {
  supabaseUrl: '',
  supabaseAnonKey: '',
  functionsUrl: '',
  supabaseJs: 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm',
  selfServeSignup: false,
};
