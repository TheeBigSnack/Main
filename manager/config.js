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
// supabaseJs is the supabase-js client, loaded on demand from a CDN only when
// the page is configured; the sample-data mode never touches the network.
export const CONFIG = {
  supabaseUrl: '',
  supabaseAnonKey: '',
  supabaseJs: 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm',
};
