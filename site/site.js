// Lot Current website. Three jobs: fill the pricing numbers from pricing.json
// (the one pricing config, copied from marketing/), send the demo request
// form, and show the Start a free pilot links once config.js names the
// manager view. Every page works with this file switched off; the pricing
// numbers are already in the HTML as fallback text. The home page and the
// pricing page load it; <html data-root> says where site/ is from the page.

import { SITE } from './config.js';

// Where site/ is from this page ('./' on the home page, '../' on /pricing/),
// written by scripts/site-pages.mjs into <html data-root>.
const ROOT = (typeof document !== 'undefined' && document.documentElement && document.documentElement.dataset && document.documentElement.dataset.root) || './';

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const money = (n) => '$' + Number(n).toLocaleString('en-US');
const word = (n) => (Number.isInteger(n) && n >= 0 && n <= 10 ? WORDS[n] : String(n));

// How each data-pricing key is shown. Keys not listed are shown as plain text.
const FORMAT = {
  perRooftopMonthly: money,
  extraSalespersonMonthly: money,
  foundingDealerMonthly: money,
  includedSalespeople: word,
  foundingDealerCount: word,
  pilotDays: String,
  foundingDealerTerm: (p) => (p.foundingDealerMonths === 12 ? 'first year' : `first ${p.foundingDealerMonths} months`)
};

// Answers the pricing it read, or null when the fallback text stays.
async function fillPricing() {
  let pricing;
  try {
    const res = await fetch(ROOT + 'pricing.json', { cache: 'no-store' });
    if (!res.ok) return null;
    pricing = await res.json();
  } catch {
    return null; // the fallback text in the HTML stays
  }
  for (const el of document.querySelectorAll('[data-pricing]')) {
    const key = el.dataset.pricing;
    const fmt = FORMAT[key];
    if (key === 'foundingDealerTerm') el.textContent = fmt(pricing);
    else if (pricing[key] !== undefined) el.textContent = fmt ? fmt(pricing[key]) : String(pricing[key]);
  }
  return pricing;
}

// SITE.signupUrl as a link target: an https address or a path on this site.
// Anything else (a typo, a bare host, another scheme) shows nothing rather
// than a link that goes nowhere or somewhere unintended.
const signupTarget = (value) => {
  const url = String(value || '').trim();
  return /^(https:\/\/[^\s/]|\/(?!\/)|\.\.?\/)\S*$/i.test(url) ? url : '';
};

// The Start a free pilot links are hidden in the HTML, so a page whose
// config.js has no signupUrl says nothing about sign-up. The pilot's length
// is pricing.json's, like every other number here; when that could not be
// read the link just says "Start a free pilot".
function showSignup(pricing) {
  const url = signupTarget(SITE.signupUrl);
  if (!url) return;
  const days = pricing && Number.isInteger(pricing.pilotDays) && pricing.pilotDays > 0 ? FORMAT.pilotDays(pricing.pilotDays) : '';
  for (const link of document.querySelectorAll('a[data-signup]')) {
    link.href = url;
    link.textContent = days ? `Start a free ${days}-day pilot` : 'Start a free pilot';
    link.hidden = false;
  }
}

function fields(form) {
  const out = {};
  for (const [k, v] of new FormData(form).entries()) out[k] = String(v).trim();
  return out;
}

// Only reached when SITE.demoMailto is set.
function mailtoFor(data) {
  const lines = Object.entries(data).filter(([k]) => k !== 'company_url').map(([k, v]) => `${k}: ${v}`);
  const sep = SITE.demoMailto.includes('?') ? '&' : '?';
  return `${SITE.demoMailto}${sep}subject=${encodeURIComponent('Lot Current demo request')}&body=${encodeURIComponent(lines.join('\r\n'))}`;
}

// The demo request form is open once config.js names an endpoint or an
// inbox. Until then the form stays hidden and the page says it is not open
// yet, without any address.
function wireForm() {
  const form = document.getElementById('demo-form');
  const status = document.getElementById('demo-status');
  const closed = document.getElementById('demo-closed');
  if (!form || !status) return;
  const endpoint = String(SITE.demoEndpoint || '');
  const mailto = String(SITE.demoMailto || '');
  if (!endpoint && !mailto) {
    form.hidden = true;
    if (closed) closed.hidden = false;
    return;
  }
  form.hidden = false;
  if (closed) closed.hidden = true;
  const button = form.querySelector('button[type="submit"]');
  if (button) button.disabled = false;
  const say = (text, kind) => {
    status.textContent = text;
    status.className = 'status ' + (kind || '');
  };
  const mail = mailto.replace(/^mailto:/, '').replace(/\?.*$/, '');
  const failed = 'That did not send. Please try again' + (mail ? ', or email ' + mail + '.' : '.');
  const also = mail ? ' You can also email ' + mail + '.' : '';
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const data = fields(form);
    if (!endpoint) {
      // No endpoint yet: open the visitor's own mail app with the fields in the body.
      window.location.href = mailtoFor(data);
      say('Your email app should open with the request filled in. If it did not, email ' + mail + '.', 'ok');
      return;
    }
    // SITE.demoEndpoint is the lead Edge Function, which stores the request in
    // demo_requests (PLAN.md M5). The form is sent there and nowhere else.
    if (button) button.disabled = true;
    say('Sending…');
    try {
      const res = await fetch(SITE.demoEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      if (!res.ok) {
        // 400 names the field that needs fixing; 429 says to wait or email. Both are sentences meant for the
        // visitor. Any other answer (403, 500, a gateway's error page) is a failure: say the request did not send.
        const answer = await res.json().catch(() => ({}));
        const own = (res.status === 400 || res.status === 429) && answer && typeof answer.error === 'string' && answer.error.trim() !== '';
        if (!own) {
          say(failed, 'error');
          return;
        }
        const field = answer.field ? form.elements.namedItem(answer.field) : null;
        if (field && typeof field.focus === 'function') field.focus();
        say(answer.error.charAt(0).toUpperCase() + answer.error.slice(1) + '.' + also, 'error');
        return;
      }
      form.reset();
      say('Thank you. We have your request and will reply by email.', 'ok');
    } catch {
      say(failed, 'error');
    } finally {
      if (button) button.disabled = false;
    }
  });
}

fillPricing().then(showSignup);
wireForm();
