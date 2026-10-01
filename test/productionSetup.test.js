// The production deploy pieces (docs/production-setup.md): the manager
// view's response headers stay in step with its own page policy, and the two
// deploy workflows keep the rules the doc promises: Supabase deploys only by
// hand, to the committed project, with no input reaching a shell unchecked;
// the manager view deploys only from the default branch, only once it is
// configured, without the local demo server, with pinned tools.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

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

// set-project --check alone checks the URL's shape and that the two files
// agree; only the production ref says which project. The workflow and the
// doc promise a refusal of any other project, so the ref is compared.
test('the manager view deploy refuses a page set to any project but the one in SUPABASE_PROJECT_REF', () => {
  assert.match(manager, /PROJECT_REF: \$\{\{ vars\.SUPABASE_PROJECT_REF \}\}/);
  const step = manager.split(/\n      - /).find((x) => x.startsWith('name: The page names the production project'));
  assert.ok(step);
  assert.match(step, /if ! printf '%s' "\$PROJECT_REF" \| grep -Eq '\^\[a-z0-9\]\{20\}\$'; then echo "::error::[^"]*"; exit 1; fi\n\s+node scripts\/set-project\.mjs --check --project-ref "\$PROJECT_REF"/, 'a missing ref stops the deploy; a present one is compared');
  assert.match(manager, /variable SUPABASE_PROJECT_REF/);
  const doc = read('docs/production-setup.md');
  assert.match(doc, /`manager-view`, deployment branches: the default branch only; its environment secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, and the \*\*Environment variable\*\* `SUPABASE_PROJECT_REF`/);
  assert.match(doc, /names any project but the one in `SUPABASE_PROJECT_REF`/);
  assert.doesNotMatch(doc + manager, /refuses to (deploy|upload) a page (that is not configured for|that isn't set to) the production project/);
});

test('every manager view run ends with the hosting check; "check only" skips everything that deploys', () => {
  const steps = manager.split(/\n      - /);
  const last = steps.at(-1);
  assert.match(last, /^name: Check the hosted page and the DNS records\n\s+if: steps\.ready\.outputs\.go == 'true' \|\| env\.CHECK_ONLY == 'true'\n/, 'it runs on check-only runs too, even before Cloudflare is set up');
  assert.match(last, /if \[ "\$DEPLOYED" = true \]; then\n\s+pages=/, 'the pages.dev address is checked only once there is a deploy to check');
  assert.match(last, /node scripts\/check-hosting\.mjs "\$\{pages\[@\]\}"/);
  assert.match(last, /--sender "\$SENDER_DOMAIN"/);
  assert.match(last, /exit "\$status"/, 'a failed check fails the run');
  for (const s of steps.filter((x) => /set-project\.mjs --check|node --test|rsync|pages deploy/.test(x))) {
    assert.match(s, /if: steps\.ready\.outputs\.go == 'true' && env\.CHECK_ONLY != 'true'\n/, s.split('\n')[0]);
  }
  assert.match(manager, /CHECK_ONLY: \$\{\{ inputs\.check_only == true \}\}/);
  assert.match(manager, /test\/checkHosting\.test\.js/);
});

// Cloudflare gives a Pages project a suffixed pages.dev address when its
// name is taken there, so the workflow reads the address from the project
// itself and holds the page check and the app CNAME to it, never to
// <project>.pages.dev guessed from the name (someone else may hold that one).
test('the manager view workflow reads the project\'s pages.dev address from Cloudflare and checks that one, never a guess from the name', () => {
  const steps = manager.split(/\n      - /);
  const lookup = steps.find((x) => x.startsWith('name: Which pages.dev address the project has'));
  assert.ok(lookup, 'a step reads the address');
  assert.match(lookup, /^name: Which pages\.dev address the project has\n\s+id: pages\n\s+if: steps\.ready\.outputs\.go == 'true'\n/, 'only with the Cloudflare secrets');
  assert.match(lookup, /curl -fsS --max-time 30 -H "Authorization: Bearer \$CLOUDFLARE_API_TOKEN" "https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/\$CLOUDFLARE_ACCOUNT_ID\/pages\/projects\/\$PAGES_PROJECT" \| jq -r '\.result\.subdomain \/\/ empty'/);
  assert.match(lookup, /\*\[!a-z0-9\.-\]\*\) [^\n]*host='' ;;\n\s+\*\.pages\.dev\) [^\n]*\n\s+\*\) [^\n]*host='' ;;/, 'anything but a plain pages.dev address is dropped');
  assert.match(lookup, /echo "host=\$host" >> "\$GITHUB_OUTPUT"/);
  const check = steps.at(-1);
  assert.ok(steps.indexOf(lookup) < steps.indexOf(check));
  assert.match(check, /PAGES_HOST: \$\{\{ steps\.pages\.outputs\.host \}\}/);
  assert.match(check, /if \[ "\$DEPLOYED" = true \] && \[ -z "\$PAGES_HOST" \]; then\n\s+echo "::error::[^\n]*"\n\s+status=1/, 'an address that could not be read fails the run, it is not guessed');
  assert.match(check, /pages=\(--app "https:\/\/\$PAGES_HOST\/" --pages-host "\$PAGES_HOST"\)/);
  assert.match(check, /more\+=\(--app "\$MANAGER_URL" --pages-host "\$PAGES_HOST"\)/);
  assert.doesNotMatch(runText(manager), /\$PAGES_PROJECT\.pages\.dev/, 'no address made from the project\'s name');
  const doc = read('docs/production-setup.md');
  assert.doesNotMatch(doc, /CNAME points at `lotcurrent-app\.pages\.dev`/);
  assert.match(doc, /Cloudflare gives a suffixed one/);
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
  assert.match(read('package.json'), /"check-hosting": "node scripts\/check-hosting\.mjs"/);
  for (const s of ['npm run check-hosting', 'MANAGER_URL', 'SENDER_DOMAIN', 'scripts/check-hosting.mjs']) assert.ok(doc.includes(s), s);
});

// Supabase's CAPTCHA protection refuses /auth/v1/otp without a captcha token,
// and neither the extension's code request nor the manager view's link
// request sends one: a doc that tells the owner to turn it on would stop
// every new sign-in. The check lifts itself once client code sends a token.
test('no doc tells the owner to turn CAPTCHA on while neither sign-in request sends a captcha token', () => {
  const code = ['extension', 'manager']
    .flatMap((dir) => readdirSync(new URL(`../${dir}/`, import.meta.url), { recursive: true }).filter((f) => /\.(m?js|html)$/.test(f)).map((f) => read(`${dir}/${f}`)))
    .join('\n');
  const sendsToken = /captcha_?token|gotrue_meta_security/i.test(code);
  const docs = ['docs/production-setup.md', 'supabase/README.md', 'docs/stack-test.md', 'docs/launch-checklist.md', 'docs/release.md', 'README.md', 'PILOT.md'];
  const turnOn = /\b(?:turn|switch)\s+on\b|\b(?:turn|switch)\s+(?:\*\*)?captcha\b[^.]*?\bon\b|\benabl/i;
  if (!sendsToken) {
    for (const doc of docs) {
      for (const sentence of read(doc).split(/(?<=[.!?])\s+|\n/).filter((x) => /captcha/i.test(x))) {
        assert.doesNotMatch(sentence, turnOn, `${doc} tells the owner to turn CAPTCHA on, and no client sends a captcha token: "${sentence.trim()}"`);
      }
    }
    assert.match(read('docs/production-setup.md'), /leave CAPTCHA off\. Neither the extension nor the manager view sends a captcha token/);
    assert.match(read('supabase/README.md'), /Leave \*\*CAPTCHA protection\*\* \(Authentication, Attack protection\) off: neither/);
  }
  // the old instruction, in either doc's words, as a failing example
  assert.match('5. Later, once the manager view is public: **Attack protection**, turn on CAPTCHA.', turnOn);
  assert.match('and turn on **CAPTCHA protection** (Authentication, Attack protection) once the manager page is public.', turnOn);
});

// The page forbids pasting an access token into a chat, so the step that
// needs one (check-deploy's signed-in checks) is the owner's to run in their
// own terminal, with only the access_token field: the stored entry also
// holds the refresh token.
test('the signed-in deploy check is run by the owner in their own terminal, with the access token alone, never through the chat', () => {
  const doc = read('docs/production-setup.md');
  const readme = read('supabase/README.md');
  const step = doc.slice(doc.indexOf('## Step 7.'), doc.indexOf('\n---', doc.indexOf('## Step 7.')));
  const item = step.split(/\n(?=\d+\. )/).find((x) => x.includes('LOTSYNC_TEST_TOKEN'));
  assert.ok(item, 'step 7 runs check-deploy with LOTSYNC_TEST_TOKEN');
  assert.match(item, /^2\. \*\*\[Owner\]\*\*/, 'an owner step');
  assert.doesNotMatch(item, /Claude (?:says|runs|takes|uses)[^.]*(?:token|check-deploy)/, 'Claude would need the token pasted into the chat to run it');
  assert.doesNotMatch(item, /\[Claude\]/);
  assert.match(item, /never goes into the chat/);
  assert.match(item, /copy only the value of its `access_token` field[^.]*never the whole entry/);
  assert.match(item, /\$env:LOTSYNC_TEST_TOKEN = Read-Host '[^']+'\n\s+npm run check-deploy\n\s+Remove-Item Env:LOTSYNC_TEST_TOKEN/, 'the PowerShell form, and the variable removed afterwards');
  // the token is pasted at a prompt, never typed into a command, so no shell history keeps it
  assert.doesNotMatch(item, /LOTSYNC_TEST_TOKEN\s*=\s*'?</, 'no command carries the token itself');
  assert.match(item, /read -rs LOTSYNC_TEST_TOKEN[^.]*unset LOTSYNC_TEST_TOKEN/, 'the macOS and Linux form reads it without showing it, and removes it afterwards');
  assert.match(item, /\*\*Sign out\*\*/, 'the test session is ended afterwards');
  assert.match(readme, /copy only the `access_token` field[^.]*never the whole entry/);
  assert.doesNotMatch(readme, /copy `access_token` from the browser's local storage/);
});
