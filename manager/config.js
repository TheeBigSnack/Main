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
// supabaseJs is the supabase-js client, loaded on demand only when the page
// is configured; the sample-data mode never touches the network. It is served
// from this folder (vendor/), so the Content-Security-Policy in index.html and
// _headers allows scripts from this origin alone: a CDN that serves any npm
// package or GitHub file would let an injected <script> load code of anyone's
// choosing. The client runs with the manager's session, so it is pinned to an
// exact version (`npm run set-project -- --check` and the deploy workflow
// refuse a bare @2 or a tag). The file is the npm package's own one-file
// build (dist/umd/supabase.js, every part bundled in, checked against the
// registry's integrity hash), unchanged, plus one line at the end that makes
// it an ES module; test/manager.test.js holds its hash, and vendor/LICENSES.txt
// carries the licenses of what it bundles. Move it on purpose, after reading
// that release's notes: download that version's tarball from the npm
// registry, check it against the registry's integrity value, copy its
// package/dist/umd/supabase.js to vendor/supabase-js-<version>.js with the
// same last line added, and change the hash in the test and the name here.
//
// selfServeSignup shows the "Start your dealership" form to a signed-in
// person who is in no dealership yet. It only shows the form: the real gate
// is the switch in the database (signup_settings.open, supabase/README.md
// "Self-serve sign-up"), and create_dealership refuses everyone while that
// is off, whatever this says. Turn both on together; with this false the
// page keeps saying "ask whoever set Lot Current up for your store".
//
// billing turns the Billing card's calls to the billing function on. Leave it
// false until that function is deployed with its Stripe secrets and this
// page's address is in ALLOWED_ORIGINS (docs/stripe-setup.md step 5, which
// then turns it on): until then the page calls no billing route and reads
// the plan straight from the database. A manager can still start the free
// pilot (start_pilot() is in the database), and the card says paying by card
// is not open yet, with no Subscribe or Manage billing.
export const CONFIG = {
  supabaseUrl: 'https://dblbfgfkmzlfdwzbcvpj.supabase.co',
  supabaseAnonKey: 'sb_publishable_dFXfRnfVqhUqZKxM2r_ylw_6uU4d2bt',
  functionsUrl: '',
  supabaseJs: './vendor/supabase-js-2.117.2.js',
  selfServeSignup: false,
  billing: false,
};
