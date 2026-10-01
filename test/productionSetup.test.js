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

// The workflow's leading comment block as one line of text
const headerOf = (yml) => yml.split('\n').filter((l) => l.startsWith('#')).map((l) => l.replace(/^#\s?/, '')).join(' ').replace(/\s+/g, ' ');

test('the workflow and the doc say a run waits for the owner only once he is a required reviewer', () => {
  // A run with no required reviewer on the environment starts at once; saying it "waits for the owner's approval" told him a gate existed that did not
  const header = headerOf(supabase);
  assert.doesNotMatch(header, /default branch only and waits for the owner's approval/);
  assert.match(header, /Only that second setting makes a run wait for his approval: without it nothing pauses, and a run starts the moment anyone who can dispatch it does\./);
  const doc = read('docs/production-setup.md');
  assert.match(doc, /\*\*Required reviewers\*\*: tick it and add yourself\.[^\n]*Without it nothing waits[^\n]*it is off until one does\.[^\n]*"Waiting for review"/);
  // the branch limit is a setting too, and the approval is his own
  assert.doesNotMatch(header, /limits that environment to the default branch, so a workflow on another branch cannot read them/);
  assert.match(header, /\(once that is set, a workflow on another branch cannot read them\)/);
  assert.match(header, /a session working with his GitHub access could approve a run through GitHub's API too, and leaves that to him\./);
  assert.match(doc, /add the default branch only\. Until this is set, a workflow on any branch that names this environment can read the secrets below\./);
  assert.match(doc, /a session working with your GitHub access could approve a run through GitHub's API too, and leaves that to you\./);
});

test('no workflow input or secret is written straight into a shell script; function names are checked against the four', () => {
  for (const [name, yml] of [['supabase', supabase], ['manager', manager]]) {
    assert.doesNotMatch(runText(yml), /\$\{\{/, `${name}: inputs, vars and secrets reach run: blocks through env only`);
  }
  assert.match(supabase, /case "\$f" in\n\s+rewrite\|sync\|billing\|lead\) ;;\n\s+\*\) echo "::error::/);
  assert.match(supabase, /FUNCTIONS: \$\{\{ inputs\.functions \}\}/);
});

// The function folders the repository deploys (supabase/functions, less _shared)
const FUNCTION_DIRS = readdirSync(new URL('../supabase/functions/', import.meta.url), { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== '_shared').map((d) => d.name).sort();
// A Supabase CLI (or other) command that changes the project, its secrets or its data
const WRITES = /\bsupabase (db push(?! --dry-run)|db reset|db pull|migration (repair|up|squash|fetch)|functions (deploy|delete)|secrets (set|unset)|config push|storage (cp|mv|rm)|seed)\b|\bpsql\b|\bcurl\b/;

test('verify compares production with the repository, and nothing it runs can write to the project', () => {
  // Production was deployed by hand before this workflow first ran; plan only lists migration versions and check-deploy only probes from outside
  assert.match(supabase, /options: \[plan, database, functions, verify, check\]/, 'verify is one of the choices');
  const steps = supabase.split(/\n      - /);
  const ifOf = (step) => (step.match(/^\s+if: (.+)$/m) || [, ''])[1];
  const verify = steps.filter((st) => /inputs\.step == 'verify'/.test(ifOf(st)));
  assert.equal(verify.length, 3, 'three comparisons');
  const said = runText(verify.join('\n'));
  for (const cmd of ['supabase migration list --linked', 'supabase db push --dry-run', 'supabase db diff --linked --schema public', 'supabase functions download "$f" --project-ref "$PROJECT_REF" --use-api']) {
    assert.ok(said.includes(cmd), `verify runs ${cmd}`);
  }
  assert.doesNotMatch(said, WRITES, 'verify writes nothing');
  assert.match(said, /Remote database is up to date[\s\S]*exit 1/, 'migrations not applied turn the run red');
  assert.match(said, /grep -q '\[\^\[:space:\]\]' "\$RUNNER_TEMP\/schema-diff\.sql"[\s\S]*exit 1/, 'a schema difference turns the run red');
  assert.match(said, /for dir in supabase\/functions\/\*\/; do[\s\S]*_shared[\s\S]*git diff --quiet -- supabase\/functions[\s\S]*exit "\$status"/, 'every function folder is compared, and a difference turns the run red');
  // the only steps that write run for database or functions alone, so plan, verify and check never reach them
  for (const st of steps.filter((x) => WRITES.test(runText(x)))) {
    assert.ok(["inputs.step == 'database'", "inputs.step == 'functions'"].includes(ifOf(st)), `${st.split('\n')[0]} writes and must run for database or functions only`);
  }
  assert.match(supabase, /if \[ "\$STEP" = plan \] \|\| \[ "\$STEP" = database \] \|\| \[ "\$STEP" = functions \] \|\| \[ "\$STEP" = verify \]; then\n\s+if \[ -z "\$SUPABASE_DB_PASSWORD" \]/, 'every step that reads the database needs its password');
});

// The pinned CLI (2.117.0), without --use-api and with Docker running, as on a
// GitHub-hosted runner, unpacks a download in an edge-runtime container that
// writes into supabase/functions as the container's user; the runner then
// cannot rewrite or restore those files, so verify would stop on the first
// function before comparing anything. With --use-api the CLI writes each file
// itself, as the runner, beside the function's entrypoint and never outside
// supabase/functions.
test('verify downloads each function over the API, so the runner owns what it compares and puts back', () => {
  const said = runText(supabase);
  const downloads = said.split('\n').filter((l) => /\bsupabase functions download\b/.test(l));
  assert.ok(downloads.length >= 1, 'verify downloads the functions');
  for (const l of downloads) assert.match(l, /--use-api\b/, `${l.trim()}: the download unpacks on Supabase's side and the CLI writes the files as the runner`);
  assert.doesNotMatch(said, /--use-docker\b/);
  assert.match(read('supabase/README.md'), /`supabase functions download <name> --use-api`/, 'the by-hand command is the workflow\'s');
});

// verify is three separate comparisons; one that fails must not hide the
// others (on a branch that adds a migration, the migrations check always
// fails before the first deploy, and the schema and functions went unread).
test('every verify comparison reports, once the project is linked, even after another one failed', () => {
  const steps = supabase.split(/\n      - /);
  assert.match(steps.find((st) => /^name: Link the project\n/.test(st)), /^\s+id: link$/m);
  const verify = steps.filter((st) => /^\s+if: .*inputs\.step == 'verify'/m.test(st));
  assert.equal(verify.length, 3);
  for (const st of verify) {
    assert.match(st, /^\s+if: \$\{\{ !cancelled\(\) && inputs\.step == 'verify' && steps\.link\.outcome == 'success' \}\}$/m, `${st.split('\n')[0]}: runs after another comparison failed, never without the link`);
  }
});

// A function from the repository may write a column only its migration adds
// (0009_cancel_at.sql and billing): deployed before that migration, its
// webhook answers 500 until database runs. The docs say database first; the
// functions step enforces it.
test('the functions step deploys nothing while production has a migration to apply', () => {
  const steps = supabase.split(/\n      - /);
  const deploy = runText(steps.find((st) => /^name: Deploy the functions\n/.test(st)));
  const check = deploy.indexOf('supabase db push --dry-run');
  assert.ok(check > 0, 'the deploy step asks db push what it would apply');
  assert.ok(check < deploy.indexOf('supabase functions deploy'), 'before deploying anything');
  assert.match(deploy.slice(check), /if ! grep -q 'Remote database is up to date' "\$RUNNER_TEMP\/push-plan\.txt"; then\n[^\n]*::error::[^\n]*\n\s+exit 1\n\s+fi\n\s+for f in \$FUNCTIONS; do supabase functions deploy/);
  assert.match(read('docs/production-setup.md'), /\*\*functions\*\* checks: it deploys nothing while a migration is still to be applied\./);
});

test('the functions box deploys every function in supabase/functions by default, and accepts no other name', () => {
  assert.deepEqual(FUNCTION_DIRS, ['billing', 'lead', 'rewrite', 'sync'], 'a new function folder: add it to the default and the case below');
  const box = supabase.match(/      functions:\n        description: .+\n        type: string\n        default: (.+)\n/);
  assert.ok(box, 'the functions input');
  assert.deepEqual(box[1].trim().split(/\s+/).sort(), FUNCTION_DIRS, 'the default deploys all of them: production runs all of them');
  const allowed = supabase.match(/case "\$f" in\n\s+([a-z|]+)\) ;;/)[1].split('|').sort();
  assert.deepEqual(allowed, FUNCTION_DIRS);
});

test('the docs say what verify compares and when to run it', () => {
  const doc = read('docs/production-setup.md');
  assert.match(doc, /\*\*verify\*\*: compares production with the repository and changes nothing\./);
  assert.match(doc, /Run it before the first deploy from this workflow, and again after anything is changed outside it/);
  assert.match(doc, /\*\*functions\*\*: deploys the functions named in the box\. The default is all four/);
  assert.doesNotMatch(doc, /\*\*functions\*\* with `rewrite sync`/);
  const readme = read('supabase/README.md');
  assert.match(readme, /\*\*verify\*\* step \(`\.github\/workflows\/supabase\.yml`/);
  assert.match(readme, /Run it after anything deployed by hand/);
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
