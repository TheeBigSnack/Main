#!/usr/bin/env node
// Checks, or with --apply creates, the Stripe objects billing needs: the
// product, the rooftop and extra-salesperson prices from
// marketing/pricing.json, the founding-dealer coupon, the Billing Portal
// configuration and the webhook endpoint (scripts/stripe-setup-lib.mjs says
// what each must look like). Then it prints the `supabase secrets set` lines
// for the ids. docs/stripe-setup.md is the owner's step-by-step.
//
//   npm run stripe-setup                                       read only: what exists, what is missing
//   npm run stripe-setup -- --apply --webhook-url <project ref>
//
//   --apply            create what is missing; set the portal's features and the webhook's events back
//   --webhook-url X    a Supabase project ref, or the full https address ending in /billing/webhook
//   --site-url X       the website's https origin, for the portal's Terms and Privacy links; give it once
//                      the legal pages are final (legal/legal-status.json), not while they are drafts
//   --product-name X   the product's name on Checkout and invoices (default: Lot Current)
//   --reprice          with --apply, replace a price whose amount differs from pricing.json
//   --live             allow a live key (sk_live_ / rk_live_); refused without it
//
// The key is read from STRIPE_SECRET_KEY in the environment and never
// printed. Set it at a prompt, not in a command a shell's history file keeps:
// on Windows PowerShell $env:STRIPE_SECRET_KEY = Read-Host 'Stripe secret key',
// on macOS or Linux read -rs STRIPE_SECRET_KEY && export STRIPE_SECRET_KEY
// (docs/stripe-setup.md, step 3).
// Exit code 0 when nothing failed.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runSetup, secretsCommands, webhookSecretLines } from './stripe-setup-lib.mjs';

export function parseArgs(argv) {
  const out = { apply: false, live: false, reprice: false, webhookUrl: '', siteUrl: '', productName: 'Lot Current', unknown: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = () => {
      const [, inline] = a.split(/=(.*)/s);
      if (inline !== undefined) return inline;
      i += 1;
      return argv[i] ?? '';
    };
    if (a === '--apply') out.apply = true;
    else if (a === '--live') out.live = true;
    else if (a === '--reprice') out.reprice = true;
    else if ((a === '--webhook-url' || a.startsWith('--webhook-url='))) out.webhookUrl = value();
    else if ((a === '--site-url' || a.startsWith('--site-url='))) out.siteUrl = value();
    else if ((a === '--product-name' || a.startsWith('--product-name='))) out.productName = value();
    else out.unknown.push(a);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.unknown.length) {
    console.error(`unknown option: ${args.unknown.join(' ')} (see the top of scripts/stripe-setup.mjs)`);
    process.exit(2);
  }
  const pricing = JSON.parse(readFileSync(new URL('../marketing/pricing.json', import.meta.url), 'utf8'));
  const result = await runSetup({ ...args, key: process.env.STRIPE_SECRET_KEY || '', pricing });
  for (const l of result.lines) console.log(`${l.ok ? 'ok  ' : l.note ? 'note' : 'FAIL'}  ${l.check}${l.detail ? ': ' + l.detail : ''}`);
  const commands = secretsCommands(result);
  if (commands.length) {
    console.log('\nPut these ids in the billing function\'s secrets (and STRIPE_SECRET_KEY yourself, in the Supabase Dashboard, if it is not set yet):');
    for (const c of commands) console.log('  ' + c);
  }
  const webhook = webhookSecretLines(result);
  if (webhook.length) console.log('\n' + webhook.join('\n'));
  if (result.mode === 'test' && result.ok) console.log('\nTest mode: nobody is charged. Stripe keeps test and live objects apart, so the live switch runs this again with the live key and --live.');
  console.log(result.ok ? '\nNothing failed.' : '\nSomething failed: see the FAIL lines.');
  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
