// Where the demo request form sends its message, and where Start a free
// pilot leads. This is the only place a destination is named; site.js sends
// nowhere else.
//
// demoEndpoint: when set, site.js POSTs the form as JSON here: the lead Edge
// Function, https://<ref>.supabase.co/functions/v1/lead, which stores the
// request in demo_requests (supabase/README.md, "Demo requests"). Set the
// function's LEAD_ORIGINS secret to this page's origin, or it refuses the
// request. Empty until the project exists: the form then opens the
// visitor's mail app. index.html's Content-Security-Policy lets the page
// call only this site and https://*.supabase.co; change it with this line if
// the function is ever served from another host.
// demoMailto: the fallback, and the form's own action when JavaScript is off.
//
// signupUrl: the manager view's address (where manager/ is hosted), set once
// the owner has opened self-serve sign-up (supabase/README.md, "Self-serve
// sign-up") and set selfServeSignup in manager/config.js. When set, the hero
// and the pricing section show "Start a free pilot" linking to it, next to
// the demo request, which stays. Empty: nothing about it shows. An https
// address or a path on this site; anything else is ignored.
export const SITE = {
  demoEndpoint: '',
  demoMailto: 'mailto:demo@lotsync.example',
  signupUrl: ''
};
