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
// The run: scripts' own text, with each step's env: and with: left out, in
// every style YAML allows: one line, quoted, a plain scalar over several
// lines, or a block (|, |-, |+, >, >-, >+, with an indent digit or a comment).
// A block runs to the first line indented less than its first line; any other
// value to the first line no deeper than the run: key. A run: whose value is
// a mapping (a job named run, defaults: run:) is not a script. Takes a whole
// workflow, or steps split off it (a step split from "- run:" starts at
// column 0, so only its block, if any, is read).
const runText = (yml) => {
  const lines = yml.split('\n');
  const indent = (l) => l.search(/\S/);
  const out = [];
  lines.forEach((line, i) => {
    const m = line.match(/^(\s*(?:- )?)run:(?=\s|$)(.*)$/);
    if (!m) return;
    const col = m[1].length;
    const value = m[2].replace(/(^|\s)#.*$/, '').trim();
    const rest = lines.slice(i + 1);
    const first = rest.find((l) => l.trim());
    if (/^[|>][1-9+-]{0,2}$/.test(value)) {
      const at = first ? indent(first) : 0;
      const end = rest.findIndex((l) => l.trim() && indent(l) < at);
      out.push((end < 0 ? rest : rest.slice(0, end)).join('\n'));
      return;
    }
    if (!value && first && /^\s*[\w-]+:(\s|$)/.test(first)) return;
    const end = col ? rest.findIndex((l) => l.trim() && indent(l) <= col) : 0;
    out.push([m[2], ...(end < 0 ? rest : rest.slice(0, end))].join('\n'));
  });
  return out.join('\n');
};

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
  // whatever style a later step's script is written in, an expression in it is caught, and the env: next to it is not read
  const injected = '${{ inputs.functions }}';
  const step = (run) => `jobs:\n  run:\n    runs-on: ubuntu-latest\n    env:\n      SAFE: \${{ inputs.step }}\n    steps:\n      - name: Deploy\n        ${run}\n        env:\n          FUNCTIONS: \${{ inputs.functions }}\n      - run: echo done\n`;
  const styles = [
    `run: supabase functions deploy ${injected}`,
    `run: "supabase functions deploy ${injected}"`,
    `run: supabase functions deploy\n          ${injected}`,
    ...['|', '|-', '|+', '>', '>-', '>+', '|2', '|-2', '| # the deploy'].map((ind) => `run: ${ind}\n          set -e\n\n          supabase functions deploy ${injected}`),
  ];
  for (const run of styles) assert.match(runText(step(run)), /\$\{\{ inputs\.functions \}\}/, `missed: ${run.split('\n')[0]}`);
  for (const run of styles) assert.doesNotMatch(runText(step(run.replace(injected, '"$FUNCTIONS"'))), /\$\{\{/, `the env: beside it, or the job named run, read as script: ${run.split('\n')[0]}`);
  assert.equal(runText(step('run: |-\n          a\n          b')).split('\n').filter((l) => l.trim()).map((l) => l.trim()).join(' '), 'a b echo done');
  assert.equal(runText('run: |\n          x\n        env:\n          A: ${{ secrets.A }}').trim(), 'x', 'a step split off "- run:" reads its block only');
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
  const order = ['node scripts/set-project.mjs --check', 'run: npm test\n', '--exclude serve.mjs', 'pages deploy'];
  const at = order.map((s) => manager.indexOf(s));
  assert.ok(at.every((i) => i > 0), JSON.stringify(at));
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'checked, then tested, then staged, then uploaded');
  const wranglers = [...manager.matchAll(/wrangler@([^\s]+)/g)].map((m) => m[1]);
  assert.ok(wranglers.length >= 2 && wranglers.every((v) => /^\d+\.\d+\.\d+$/.test(v)), 'an exact version every time');
  assert.match(manager, /go=false[\s\S]*::notice::|::notice::[\s\S]*go=false/, 'without the Cloudflare secrets it stops green with a notice');
  assert.match(manager, /pages deploy "\$RUNNER_TEMP\/manager"/, 'only the staged folder is uploaded');
  // A push deploys with no approval and without waiting for CI: the whole unit suite gates the upload, so the
  // page's copies of the billing rules (test/billing.test.js) are checked too, not only the page's own test files
  const steps = manager.split(/\n      - /);
  const unit = steps.find((st) => /^\s+run: npm test$/m.test(st));
  assert.ok(unit, 'the manager view workflow runs npm test');
  assert.doesNotMatch(unit, /continue-on-error/, 'a failure stops the deploy');
  assert.doesNotMatch(manager, /run: node --test /, 'not a hand-picked list of test files');
  assert.doesNotMatch(manager, /run: npm (ci|install)/, 'npm test needs no dependencies');
  assert.match(manager, /^  push:\n    paths:\n/m, 'it deploys on a push, so the header and the docs say no one approves it');
  assert.match(headerOf(manager), /A push deploys with no approval and does not wait for CI/);
  assert.match(read('docs/production-setup.md'), /that deploy waits for no one: the environment has no required reviewer, and the workflow does not wait for CI, so its own `npm test` is what stops a page that breaks a rule\./);
});

test('every manager view run ends with the hosting check; "check only" skips everything that deploys', () => {
  const steps = manager.split(/\n      - /);
  const last = steps.at(-1);
  assert.match(last, /^name: Check the hosted page and the DNS records\n\s+if: steps\.ready\.outputs\.go == 'true' \|\| env\.CHECK_ONLY == 'true'\n/, 'it runs on check-only runs too, even before Cloudflare is set up');
  assert.match(last, /if \[ "\$DEPLOYED" = true \]; then\n\s+pages=/, 'the pages.dev address is checked only once there is a deploy to check');
  assert.match(last, /node scripts\/check-hosting\.mjs "\$\{pages\[@\]\}"/);
  assert.match(last, /--sender "\$SENDER_DOMAIN"/);
  assert.match(last, /exit "\$status"/, 'a failed check fails the run');
  for (const s of steps.slice(1).filter((x) => /set-project\.mjs --check|run: npm test|rsync|pages deploy/.test(x))) {
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

// The production project gets its database and functions only through the
// Supabase workflow (the committed code, the pinned CLI, the project the
// config files name). The Stripe walk-through once sent the owner through a
// local link, db push and functions deploy instead.
test('docs/stripe-setup.md deploys billing through the Supabase workflow, never from a terminal', () => {
  const doc = read('docs/stripe-setup.md');
  const blocks = [...doc.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n');
  assert.doesNotMatch(blocks, /\bsupabase (db push|functions deploy|link|login)\b/, 'no local deploy command to copy');
  assert.doesNotMatch(doc, /`supabase\/README\.md` steps 1 to 6/, 'the prerequisite is the production order of work');
  assert.match(doc, /`docs\/production-setup\.md` steps 1 to 3/);
  const step5 = doc.slice(doc.indexOf('## 5. '), doc.indexOf('## 6. '));
  assert.match(step5, /the \*\*Supabase\*\* workflow \(`docs\/production-setup\.md`, step 3\)/);
  assert.match(step5, /\*\*functions\*\* with `billing` in the box/);
  assert.match(step5, /Edge Functions, Secrets/, 'secrets in the Dashboard');
  assert.doesNotMatch(doc, /--no-verify-jwt/);
  const live = doc.slice(doc.indexOf('## Later: switching to live mode'));
  assert.doesNotMatch(live, /`npm run check-deploy`\.?$/m, 'the live switch checks through the workflow too');
  // the workflow's deploy takes the flag from config.toml
  const toml = read('supabase/config.toml');
  for (const f of ['billing', 'lead']) assert.match(toml, new RegExp(`\\[functions\\.${f}\\]\\nverify_jwt = false`), f);
  // the reference's by-hand lines say that production goes through the workflow
  const readme = read('supabase/README.md');
  assert.match(readme, /On the production project the database and every function go up through the \*\*Supabase\*\* workflow/);
  for (const [from, to] of [['## Demo requests', 'supabase functions deploy lead'], ['Then the secrets and the function', 'supabase functions deploy billing']]) {
    const part = readme.slice(readme.indexOf(from), readme.indexOf(to));
    assert.match(part, /On the production project[^\n]*Supabase workflow/, from);
  }
});

// A secret in a job's env reaches every step of the job, the third-party
// actions included (supabase/setup-cli runs at a movable tag), and every
// script that runs there. Each deploy secret goes only to the steps that use
// it: the supabase command's steps, the deploy that runs wrangler, and the
// check that the settings exist.
test('the deploy secrets reach only the steps that use them, never an action or the outside checks', () => {
  const jobEnv = (yml) => (yml.match(/^ {4}env:\n((?: {6}.+\n)+)/m) || [, ''])[1];
  const value = /\$\{\{ secrets\.[A-Z_]+ \}\}/;
  for (const [name, yml] of [['supabase', supabase], ['manager', manager]]) {
    assert.ok(jobEnv(yml).length > 0, `${name}: the job env is found`);
    assert.doesNotMatch(jobEnv(yml), /secrets\./, `${name}: no secret in the job's env`);
    for (const st of yml.split(/\n      - /).slice(1)) {
      if (/(^|\n\s*)uses: /.test(st)) assert.doesNotMatch(st, /secrets\./, `${name}: ${st.split('\n')[0]} is an action and gets no secret`);
    }
  }
  const steps = supabase.split(/\n      - /).slice(1);
  const cli = steps.filter((st) => /\bsupabase (link|db|migration|functions)\b/.test(runText(st)));
  assert.ok(cli.length >= 7, 'link, the dry run, the push, the deploy and the three verify steps');
  for (const st of cli) {
    assert.match(st, /SUPABASE_ACCESS_TOKEN: \$\{\{ secrets\.SUPABASE_ACCESS_TOKEN \}\}/, st.split('\n')[0]);
    assert.match(st, /SUPABASE_DB_PASSWORD: \$\{\{ secrets\.SUPABASE_DB_PASSWORD \}\}/, st.split('\n')[0]);
  }
  for (const st of steps.filter((x) => value.test(x))) {
    assert.ok(cli.includes(st) || st.startsWith('name: The settings are there'), `${st.split('\n')[0]} gets a secret it does not use`);
  }
  assert.doesNotMatch(steps.at(-1), /secrets\./, 'check-deploy runs without the token');
  const mine = manager.split(/\n      - /).slice(1);
  const holders = mine.filter((st) => value.test(st));
  assert.deepEqual(holders.map((st) => st.split('\n')[0]), ['name: Deploy to Cloudflare Pages'], 'only the deploy holds the Cloudflare token');
  assert.match(mine.find((st) => st.startsWith('name: Is Cloudflare set up?')), /HAS_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN != '' \}\}/, 'the first step learns only whether it is set');
});

// The doc says an access token never goes into a chat, so the check that
// needs one is the owner's to run: the token is set at a prompt in the
// owner's own terminal and only the printed checklist reaches the thread.
test('the signed-in deploy check is run by the owner with the token set at a prompt; only its output reaches Claude', () => {
  const doc = read('docs/production-setup.md');
  const step = doc.split('\n').find((l) => /^2\. \*\*\[Owner\]\*\* Signs in once in the manager view/.test(l));
  assert.ok(step, 'step 7.2 moved: update this test');
  assert.doesNotMatch(step, /Claude[^.]*runs `check-deploy`|Claude[^.]*with it \(`LOTSYNC_TEST_TOKEN`\)/, 'Claude would need the token');
  assert.ok(step.includes("$env:LOTSYNC_TEST_TOKEN = Read-Host 'access token'"), 'PowerShell reads the token at a prompt');
  assert.ok(step.includes('read -rs LOTSYNC_TEST_TOKEN && export LOTSYNC_TEST_TOKEN'), 'macOS and Linux read it at a prompt');
  assert.match(step, /`npm run check-deploy`/);
  assert.match(step, /Reads the printed checklist[^.]*: it carries no token or key/);
  // and check-deploy reads the token from its own environment only
  const src = read('scripts/check-deploy.mjs');
  assert.match(src, /testToken: process\.env\.LOTSYNC_TEST_TOKEN \|\| ''/);
});
