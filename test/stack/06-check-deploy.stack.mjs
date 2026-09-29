// scripts/check-deploy.mjs pointed at the local stack, the way the owner runs
// it after a deploy (supabase/README.md step 6): LOTSYNC_URL and
// LOTSYNC_ANON_KEY name the project, LOTSYNC_TEST_TOKEN is a signed-in
// account in no dealership, LOTSYNC_SITE_ORIGIN the landing page. Its live
// lines must all read ok or note. Its first lines judge the config files
// (extension/src/accountConfig.js, manager/config.js, site/config.js), which
// the owner fills with the hosted project; against a local stack they cannot
// pass, so they are listed here and not judged.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { configFindings } from '../../scripts/check-deploy.mjs';
import { ACCOUNT } from '../../extension/src/accountConfig.js';
import { CONFIG } from '../../manager/config.js';
import { SITE } from '../../site/config.js';

export const title = 'npm run check-deploy against the local stack';

// Lines that must read ok here, not note: each needs something the stack
// was given (a test token, LEAD_ORIGINS, STRIPE_WEBHOOK_SECRET).
const MUST_BE_OK = [
  'sync: a signed-in stranger gets 403',
  'redeem_invite: wrong codes are counted and the throttle answers P0005',
  'lead: refuses a page that is not the landing page',
  'billing: the webhook refuses an unsigned event',
];

// A CORS line whose answer is the local gateway's "*" (stack-test.mjs's
// preflight notes when the gateway answers CORS itself): it says nothing
// about the function, so it is listed and not judged.
const gatewaysCors = (text) => /CORS preflight/.test(text) && /allow-origin \*/.test(text);

export async function run(s) {
  const outsider = await s.person('outsider', 'link');
  const r = spawnSync(process.execPath, [join(s.root, 'scripts/check-deploy.mjs')], {
    cwd: s.root,
    encoding: 'utf8',
    env: { ...process.env, LOTSYNC_URL: s.url, LOTSYNC_ANON_KEY: s.anonKey, LOTSYNC_TEST_TOKEN: outsider.token, LOTSYNC_SITE_ORIGIN: s.siteOrigin },
    timeout: 180000,
  });
  const out = String(r.stdout || '');
  const configChecks = configFindings({ account: ACCOUNT, manager: CONFIG, site: SITE }).map((f) => f.check);
  const aboutConfig = (text) => configChecks.some((c) => text.startsWith(c));
  for (const l of out.split('\n')) {
    if (!l.trim()) continue;
    const text = l.replace(/^(ok  |note|FAIL)  /, '');
    const why = aboutConfig(text) ? '   [a config file the owner fills for the hosted project: not judged here]' : s.gatewayCors && gatewaysCors(text) ? '   [the local gateway answered this CORS preflight itself: not judged here]' : '';
    s.info(`check-deploy said: ${s.brief(l, 400)}${why}`);
  }
  if (String(r.stderr || '').trim()) s.info(`check-deploy stderr: ${s.brief(r.stderr, 600)}`);

  const lines = out.split('\n').map((l) => /^(ok  |note|FAIL)  (.+)$/.exec(l)).filter(Boolean).map((m) => ({ kind: m[1].trim(), text: m[2] }));
  const live = lines.filter((l) => !aboutConfig(l.text) && !(s.gatewayCors && gatewaysCors(l.text)));
  s.info(`${lines.length - live.length} line(s) not judged here: the config files are the hosted project's, and a CORS preflight the local gateway answered says nothing about the function`);
  const failed = live.filter((l) => l.kind === 'FAIL');
  s.check('check-deploy ran its live checks', live.length >= 20 && !r.error, r.error ? r.error.message : `${live.length} live line(s), exit code ${r.status}`);
  s.check('none of its live lines reads FAIL', failed.length === 0, failed.map((l) => l.text).join('; '));
  for (const name of MUST_BE_OK) {
    const hit = live.find((l) => l.text.startsWith(name));
    s.check(`check-deploy: "${name}" reads ok`, hit && hit.kind === 'ok', hit ? `${hit.kind}  ${hit.text}` : 'no such line');
  }
}
