// Everything that needs the site's own address or an inbox derives from this
// one object. Nothing here is guessed: a value stays '' until the owner has
// the real thing, and the pages, the generator and the tests say so.
//
// siteUrl: the site's address once the domain exists: an https origin with
// no path and no trailing slash. While '', scripts/site-pages.mjs writes no
// canonical, og:url, og:image, sitemap.xml or CNAME and reports "siteUrl is
// not set: the site is not ready to publish"; set it, run npm run site-pages
// and npm run legal-pages, and commit (docs/website.md).
//
// demoEndpoint: when set, site.js POSTs the demo form as JSON here: the lead
// Edge Function, https://<ref>.supabase.co/functions/v1/lead, which stores the
// request in demo_requests (supabase/README.md, "Demo requests"). Set the
// function's LEAD_ORIGINS secret to siteUrl, or it refuses the request. The
// pages' Content-Security-Policy lets site.js call only this site and
// https://*.supabase.co; change scripts/site-pages.mjs with this line if the
// function is ever served from another host.
// demoMailto: 'mailto:<a real inbox>' once one exists: the form's own action
// when JavaScript is off and the fallback when demoEndpoint is ''. A reserved
// domain nobody can serve (RFC 2606) is refused by the tests. While both
// demoEndpoint and demoMailto are '', the home page says the demo request
// form is not open yet and shows no address.
// supportEmail: a plain address, shown on /support/ once it exists; '' shows
// no address.
//
// signupUrl: the manager view's address (where manager/ is hosted), set once
// the owner has opened self-serve sign-up (supabase/README.md,
// "Self-serve sign-up") and set selfServeSignup in manager/config.js. When
// set, the hero and the pricing page show "Start a free pilot" linking to
// it, next to the demo request, which stays. Empty: nothing about it shows.
// An https address or a path on this site; anything else is ignored.
//
// business: the LocalBusiness record for the home page's structured data.
// Either every required field (name, streetAddress, addressLocality,
// addressRegion, postalCode, addressCountry) is filled or none is: with none,
// the pages carry Organization, WebSite and SoftwareApplication; with all,
// LocalBusiness replaces Organization; partly filled, the generator refuses to
// write. The optional fields are left out when ''. openingHours is a list of
// schema.org strings such as 'Mo-Fr 09:00-17:00'; areaServed a place name.
export const SITE = {
  siteUrl: 'https://lotcurrent.com',
  demoEndpoint: '',
  demoMailto: 'mailto:blawrence@lotcurrent.com',
  supportEmail: 'blawrence@lotcurrent.com',
  signupUrl: '',
  business: {
    name: '',
    legalName: '',
    streetAddress: '',
    addressLocality: '',
    addressRegion: '',
    postalCode: '',
    addressCountry: '',
    telephone: '',
    email: '',
    url: '',
    openingHours: [],
    areaServed: ''
  }
};
