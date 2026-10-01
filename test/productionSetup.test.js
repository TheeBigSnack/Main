// The production deploy pieces (docs/production-setup.md): the manager
// view's response headers stay in step with its own page policy, and the two
// deploy workflows keep the rules the doc promises: Supabase deploys only by
// hand, to the committed project, with no input reaching a shell unchecked;
// the manager view deploys only from the default branch, only once it is
// configured, without the local demo server, with pinned tools.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const html = read('manager/index.html');
const headers = read('manager/_headers');
const supabase = read('.github/workflows/supabase.yml');
const manager = read('.github/workflows/manager.yml');
const ci = read('.github/workflows/ci.yml');

const metaCsp = () => html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
const header = (name) => {
  const m = headers.match(new RegExp(`^  ${name}: (.+)$`, 'm'));
  return m ? m[1] : null;
};
// the run: blocks' own text, with each step's env: and with: left out
const runText = (yml) => [...yml.matchAll(/^\s+run: (?:\|\n((?:\s{10,}.*\n?)+)|(.+))$/gm)].map((m) => m[1] || m[2]).join('\n');

test('manager/_headers: every path, the page\'s own policy plus frame-ancestors none, and the other headers', () => {
  assert.match(headers, /^\/\*$/m, 'one rule for every path');
  assert.equal(header('Content-Security-Policy'), `${metaCsp()}; frame-ancestors 'none'`);
  assert.equal(header('X-Frame-Options'), 'DENY');
  assert.equal(header('X-Content-Type-Options'), 'nosniff');
  assert.equal(header('Referrer-Policy'), 'no-referrer', 'the sign-in link\'s one-time code never leaves in a Referer');
  assert.ok(header('Permissions-Policy'));
});

test('the Supabase workflow runs by hand only, against the committed project, and ends with check-deploy', () => {
  assert.match(supabase, /^on:\n  workflow_dispatch:\n/m);
  assert.doesNotMatch(supabase, /^\s+(push|pull_request|schedule|workflow_run):/m, 'no automatic trigger');
  assert.match(supabase, /environment:\n\s+name: production/, 'the owner can require approval per run');
  assert.match(supabase, /^permissions:\n  contents: read$/m);
  assert.match(supabase, /accountConfig\.js[\s\S]*PROJECT_REF/, 'refuses a project the extension does not name');
  assert.match(supabase, /supabase db push --dry-run/);
  const steps = supabase.split(/\n      - /);
  assert.match(steps.at(-1), /npm run check-deploy/, 'the last step is the outside check');
  assert.match(steps.at(-1), /^name: Check the project from the outside\n\s+continue-on-error: \$\{\{ inputs\.step == 'plan' \|\| inputs\.step == 'database' \}\}\n\s+run:/, 'it runs for every step, and fails the run only once the functions should be there');
  assert.match(supabase, /run: supabase db push --yes\n/, 'the real push answers its own prompt');
});

test('no workflow input or secret is written straight into a shell script; function names are checked against the four', () => {
  for (const [name, yml] of [['supabase', supabase], ['manager', manager]]) {
    assert.doesNotMatch(runText(yml), /\$\{\{/, `${name}: inputs, vars and secrets reach run: blocks through env only`);
  }
  assert.match(supabase, /case "\$f" in\n\s+rewrite\|sync\|billing\|lead\) ;;\n\s+\*\) echo "::error::/);
  assert.match(supabase, /FUNCTIONS: \$\{\{ inputs\.functions \}\}/);
});

test('the Supabase CLI in the deploy is the one the CI stack job tests with', () => {
  const pin = (yml) => yml.match(/supabase\/setup-cli@v3\n\s+with:\n\s+version: ([\d.]+)/)[1];
  assert.equal(pin(supabase), pin(ci));
});

test('the manager view deploys from the default branch only, configured, tested, without serve.mjs, with an exact wrangler', () => {
  assert.match(manager, /if: github\.ref_name == github\.event\.repository\.default_branch/);
  assert.match(manager, /^permissions:\n  contents: read$/m);
  const order = ['node scripts/set-project.mjs --check', 'node --test test/manager.test.js', '--exclude serve.mjs', 'pages deploy'];
  const at = order.map((s) => manager.indexOf(s));
  assert.ok(at.every((i) => i > 0), JSON.stringify(at));
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'checked, then tested, then staged, then uploaded');
  const wranglers = [...manager.matchAll(/wrangler@([^\s]+)/g)].map((m) => m[1]);
  assert.ok(wranglers.length >= 2 && wranglers.every((v) => /^\d+\.\d+\.\d+$/.test(v)), 'an exact version every time');
  assert.match(manager, /go=false[\s\S]*::notice::|::notice::[\s\S]*go=false/, 'without the Cloudflare secrets it stops green with a notice');
  assert.match(manager, /pages deploy "\$RUNNER_TEMP\/manager"/, 'only the staged folder is uploaded');
});

test('docs/production-setup.md names every piece it relies on, and says the secret values never go in chat or git', () => {
  const doc = read('docs/production-setup.md');
  for (const p of ['scripts/set-project.mjs', '.github/workflows/supabase.yml', '.github/workflows/manager.yml', 'manager/_headers', 'npm run set-project', 'SUPABASE_ACCESS_TOKEN', 'SUPABASE_DB_PASSWORD', 'SUPABASE_PROJECT_REF', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) {
    assert.ok(doc.includes(p), p);
  }
  for (const s of ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_DB_PASSWORD', 'SUPABASE_PROJECT_REF']) assert.ok(supabase.includes(s), s);
  for (const s of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) assert.ok(manager.includes(s), s);
  assert.match(doc, /Never paste a password, a secret key or an access token/);
  assert.match(doc, /name it `production`[\s\S]*default branch only[\s\S]*Environment secrets/, 'the Supabase secrets live on the production environment');
  assert.match(doc, /`manager-view`, deployment branches: the default branch only; its environment secrets `CLOUDFLARE_API_TOKEN`/);
  assert.doesNotMatch(doc, /repository secret[s]?:/i, 'no secret goes in the repository-wide list');
  assert.match(manager, /environment:\n\s+name: manager-view/);
  assert.match(read('package.json'), /"set-project": "node scripts\/set-project\.mjs"/);
});
