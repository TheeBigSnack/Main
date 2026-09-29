// Lot Sync landing page. Two jobs: fill the pricing section from pricing.json
// (the one pricing config, copied from marketing/) and send the demo request
// form. Everything else on the page works with this file switched off; the
// pricing numbers are already in the HTML as fallback text.

import { SITE } from './config.js';

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

async function fillPricing() {
  let pricing;
  try {
    const res = await fetch('./pricing.json', { cache: 'no-store' });
    if (!res.ok) return;
    pricing = await res.json();
  } catch {
    return; // the fallback text in the HTML stays
  }
  for (const el of document.querySelectorAll('[data-pricing]')) {
    const key = el.dataset.pricing;
    const fmt = FORMAT[key];
    if (key === 'foundingDealerTerm') el.textContent = fmt(pricing);
    else if (pricing[key] !== undefined) el.textContent = fmt ? fmt(pricing[key]) : String(pricing[key]);
  }
}

function fields(form) {
  const out = {};
  for (const [k, v] of new FormData(form).entries()) out[k] = String(v).trim();
  return out;
}

function mailtoFor(data) {
  const lines = Object.entries(data).filter(([k]) => k !== 'company_url').map(([k, v]) => `${k}: ${v}`);
  const sep = SITE.demoMailto.includes('?') ? '&' : '?';
  return `${SITE.demoMailto}${sep}subject=${encodeURIComponent('Lot Sync demo request')}&body=${encodeURIComponent(lines.join('\n'))}`;
}

function wireForm() {
  const form = document.getElementById('demo-form');
  const status = document.getElementById('demo-status');
  if (!form || !status) return;
  const say = (text, kind) => {
    status.textContent = text;
    status.className = 'status ' + (kind || '');
  };
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const data = fields(form);
    if (!SITE.demoEndpoint) {
      // No endpoint yet: open the visitor's own mail app with the fields in the body.
      window.location.href = mailtoFor(data);
      say('Your email app should open with the request filled in. If it did not, email ' + SITE.demoMailto.replace(/^mailto:/, '') + '.', 'ok');
      return;
    }
    // SITE.demoEndpoint is the lead Edge Function, which stores the request in
    // demo_requests (PLAN.md M5). The form is sent there and nowhere else.
    const button = form.querySelector('button[type="submit"]');
    if (button) button.disabled = true;
    say('Sending…');
    try {
      const res = await fetch(SITE.demoEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      if (!res.ok) {
        // 400 names the field that needs fixing; 429 says to wait or email. Both are sentences meant for the visitor.
        const answer = await res.json().catch(() => ({}));
        const field = answer && answer.field ? form.elements.namedItem(answer.field) : null;
        if (field && typeof field.focus === 'function') field.focus();
        const why = answer && typeof answer.error === 'string' && (res.status === 400 || res.status === 429) ? answer.error.charAt(0).toUpperCase() + answer.error.slice(1) + '. ' : '';
        say(why + 'You can also email ' + SITE.demoMailto.replace(/^mailto:/, '') + '.', 'error');
        return;
      }
      form.reset();
      say('Thank you. We have your request and will reply by email.', 'ok');
    } catch {
      say('That did not send. Please try again, or email ' + SITE.demoMailto.replace(/^mailto:/, '') + '.', 'error');
    } finally {
      if (button) button.disabled = false;
    }
  });
}

fillPricing();
wireForm();
