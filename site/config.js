// Where the demo request form sends its message. This is the only place a
// destination is named; site.js sends nowhere else.
//
// demoEndpoint: when set, site.js POSTs the form as JSON here. It will be a
// Supabase Edge Function (Milestone 4/5). Empty until that exists.
// demoMailto: the fallback, and the form's own action when JavaScript is off.
export const SITE = {
  demoEndpoint: '',
  demoMailto: 'mailto:demo@lotsync.example'
};
