// Where the demo request form sends its message. This is the only place a
// destination is named; site.js sends nowhere else.
//
// demoEndpoint: when set, site.js POSTs the form as JSON here: the lead Edge
// Function, https://<ref>.supabase.co/functions/v1/lead, which stores the
// request in demo_requests (supabase/README.md, "Demo requests"). Set the
// function's LEAD_ORIGINS secret to this page's origin, or it refuses the
// request. Empty until the project exists: the form then opens the
// visitor's mail app.
// demoMailto: the fallback, and the form's own action when JavaScript is off.
export const SITE = {
  demoEndpoint: '',
  demoMailto: 'mailto:demo@lotsync.example'
};
