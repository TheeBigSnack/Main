#!/usr/bin/env node
// Lot Sync against a real local Supabase stack (docs/stack-test.md, the CI
// job `stack`): the migrations as `supabase start` applied them, PostgREST,
// GoTrue, the mail catcher and the four functions as `supabase functions
// serve` runs them. The unit tests fake every one of those. This runs the
// extension's own account and sync modules and the manager page's calls
// against the real thing and prints what the real thing answered, so a
// difference from supabase/README.md shows up before the owner's first deploy.
//
//   supabase start
//   supabase functions serve --env-file <the file in docs/stack-test.md>
//   npm run test:stack                  (or: node scripts/stack-test.mjs 03 to run one file)
//
// Where the stack is: LOTSYNC_STACK_URL, _ANON_KEY, _SERVICE_KEY, _DB_URL and
// _MAIL_URL (the CI job sets them), else the names `supabase status -o env`
// prints (API_URL, ANON_KEY, SERVICE_ROLE_KEY, DB_URL, MAILPIT_URL or
// INBUCKET_URL) from the environment, else it runs `supabase status -o env`
// itself. LOTSYNC_STACK_SITE_ORIGIN must be the LEAD_ORIGINS the functions
// were served with (SITE_ORIGIN below when unset).
//
// Nobody signs in with a password (Lot Sync has none): a person gets in with
// the admin API's magic link (generate_link, with the service key) or with
// the email the local mail catcher received, through the extension's own
// signInFinish and exchangeTokenFromUrl. SQL goes to the stack's database
// with psql, or through `docker exec` into its database container when psql
// is not installed.
//
// The CLI's local gateway answers CORS preflights itself and puts
// "allow-origin *" on every answer, so the functions' own CORS answers are
// not visible through it: the readiness checks reach each function's code
// instead, and a CORS line that only shows the gateway's answer is noted,
// not judged.
//
// Then it runs each test/stack/*.stack.mjs in name order (the .stack.mjs
// name keeps them out of `npm test`). Every check prints one line: ok, FAIL
// or note; `info` lines say what the stack answered, and the `>` and `$`
// lines under them are the requests and the SQL behind them. Exit code 1
// when any check failed. No key and no token is ever printed.
//
// Everything a run makes carries its run id and is deleted at the end
// (dealerships, accounts, invite misses, demo requests), and the sign-up
// switch is set back, so it can run again on the same stack. It refuses any
// address but this computer's: it opens self-serve sign-up and writes rows.

import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { signInStart, signInFinish } from '../extension/src/accountFlow.js';
import { exchangeTokenFromUrl, storeSession } from '../extension/src/account.js';
import { EXTENSION_ORIGIN } from './check-deploy.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STACK_DIR = join(ROOT, 'test/stack');
const MIGRATIONS = join(ROOT, 'supabase/migrations');

// The landing page's origin the functions' LEAD_ORIGINS names when nothing
// else is said (docs/stack-test.md's env file and the CI job use it too).
export const SITE_ORIGIN = 'https://site.lotsync-stack.test';
// Every account and demo request a run makes is <label>-<run>@ this domain,
// a reserved name (RFC 2606) that no mail server answers for; the local
// stack's mail never leaves its mail catcher anyway.
export const EMAIL_DOMAIN = 'lotsync-stack.test';
const SIGN_IN_WAIT_MS = 20000; // how long the mail catcher gets to show the sign-in email
const SYNC_TIMEOUT_MS = 60000; // a function's first request also loads its imports

// ---------- settings ----------

// `supabase status -o env` prints KEY="value" lines (numbers unquoted).
export function parseEnvLines(text) {
  const out = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(raw.trim());
    if (!m) continue;
    let value = m[2].trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/\\"/g, '"');
    out[m[1]] = value;
  }
  return out;
}

const trimUrl = (u) => String(u || '').trim().replace(/\/+$/, '');

// The stack's settings from our own names first, then the status names.
export function stackSettings(env = {}) {
  const pick = (...names) => {
    for (const n of names) if (env[n] && String(env[n]).trim()) return String(env[n]).trim();
    return '';
  };
  return {
    url: trimUrl(pick('LOTSYNC_STACK_URL', 'API_URL')),
    anonKey: pick('LOTSYNC_STACK_ANON_KEY', 'ANON_KEY'),
    serviceKey: pick('LOTSYNC_STACK_SERVICE_KEY', 'SERVICE_ROLE_KEY'),
    dbUrl: pick('LOTSYNC_STACK_DB_URL', 'DB_URL'),
    mailUrl: trimUrl(pick('LOTSYNC_STACK_MAIL_URL', 'MAILPIT_URL', 'INBUCKET_URL')),
    siteOrigin: trimUrl(pick('LOTSYNC_STACK_SITE_ORIGIN') || SITE_ORIGIN),
  };
}

// Only this computer: a hosted project must never get this script's rows.
export function isLocal(url) {
  return /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(trimUrl(url));
}

// The Supabase CLI names the database container supabase_db_<project_id>.
function projectId() {
  try {
    const m = /^\s*project_id\s*=\s*"([^"]+)"/m.exec(readFileSync(join(ROOT, 'supabase/config.toml'), 'utf8'));
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

// ---------- printing, without keys or tokens ----------

const HIDDEN_FIELDS = new Set(['access_token', 'refresh_token', 'provider_token', 'provider_refresh_token', 'hashed_token', 'email_otp', 'action_link', 'token', 'token_hash', 'confirmation_token', 'recovery_token']);
const JWT_LIKE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;
const API_KEY_LIKE = /sb_(secret|publishable)_[A-Za-z0-9_-]+/g;

export function redact(value) {
  if (typeof value === 'string') return value.replace(JWT_LIKE, '<token>').replace(API_KEY_LIKE, '<key>');
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = HIDDEN_FIELDS.has(k) && v ? '<hidden>' : redact(v);
    return out;
  }
  return value;
}

// One short, safe line for a body (parsed JSON or text).
export function brief(body, max = 300) {
  let text;
  if (typeof body === 'string') {
    try {
      text = JSON.stringify(redact(JSON.parse(body)));
    } catch {
      text = redact(body);
    }
  } else {
    text = body === undefined ? '' : JSON.stringify(redact(body));
  }
  text = String(text ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) + '…' : text;
}

const pathOf = (u) => {
  try {
    const x = new URL(u);
    return (x.pathname + x.search).replace(/((?:^|[?&])token(?:_hash)?=)[^&]+/g, '$1<hidden>');
  } catch {
    return String(u);
  }
};

const lit = (v) => (v === null || v === undefined ? 'null' : `'${String(v).replace(/'/g, "''")}'`);

// What a person reads in an email: the text part, or the HTML without its
// styles, tags and addresses, so a colour like #000000 or a number inside a
// link is never taken for the six-digit code.
export function readableText({ text = '', html = '' } = {}) {
  const source = String(text).trim()
    ? String(text)
    : String(html).replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/\sstyle="[^"]*"/gi, ' ').replace(/<[^>]*>/g, ' ');
  return source.replace(/&amp;/g, '&').replace(/https?:\/\/\S+/g, ' ').replace(/#[0-9a-f]{3,8}\b/gi, ' ');
}

// chrome.storage.local's shape, one per person: get(key | keys), set(obj), remove(key | keys).
function fakeStorage() {
  const data = {};
  return {
    data,
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.map((k) => [k, data[k]]));
    },
    async set(obj) {
      Object.assign(data, JSON.parse(JSON.stringify(obj)));
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    },
  };
}

// ---------- the context every stack file gets ----------

function makeContext(settings) {
  const run = Date.now().toString(36).slice(-5) + randomBytes(2).toString('hex');
  const tally = { ok: 0, fail: 0, note: 0 };
  const dbContainer = `supabase_db_${projectId() || 'lot-sync'}`;
  const dbPassword = (/^postgres(?:ql)?:\/\/[^:/@]+:([^@]*)@/.exec(settings.dbUrl || '') || [])[1] || 'postgres'; // the local stack's default
  let psqlBy = settings.dbUrl ? 'psql' : 'docker';
  const say = (kind, text) => console.log(`${kind.padEnd(5)} ${text}`);
  const trace = (text) => console.log(`        ${text}`);

  // fetch that prints each request and its answer, for the extension's modules too
  const tracedFetch = async (url, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      trace(`> ${method} ${pathOf(url)} -> no answer: ${(e && e.message) || e}`);
      throw e;
    }
    let text = '';
    try {
      text = await res.clone().text();
    } catch {
      text = '';
    }
    trace(`> ${method} ${pathOf(url)} -> ${res.status} ${brief(text)}`);
    return res;
  };

  // One HTTP call to the stack. body: an object (sent as JSON) or a string.
  async function http(method, path, { token = '', apikey = '', headers = {}, body, quiet = false } = {}) {
    const h = { ...headers };
    if (apikey) h.apikey = apikey;
    if (token) h.Authorization = `Bearer ${token}`;
    let payload;
    if (body !== undefined) {
      payload = typeof body === 'string' ? body : JSON.stringify(body);
      if (!Object.keys(h).some((k) => k.toLowerCase() === 'content-type')) h['Content-Type'] = 'application/json';
    }
    const f = quiet ? fetch : tracedFetch;
    const res = await f(settings.url + path, { method, headers: h, body: payload });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed, text, headers: res.headers };
  }

  // The database API as the manager page and the extension call it: the anon
  // key as apikey, the person's token (or the anon key) as the bearer.
  const rest = (method, path, { token = '', body, prefer = '', headers = {} } = {}) =>
    http(method, path, { apikey: settings.anonKey, token: token || settings.anonKey, body, headers: { ...headers, ...(prefer ? { Prefer: prefer } : {}) } });
  const rpc = (name, args, token) => rest('POST', `/rest/v1/rpc/${name}`, { token, body: args });
  const admin = (method, path, body) => http(method, path, { apikey: settings.serviceKey, token: settings.serviceKey, body });

  function sql(query) {
    trace(`$ ${query.replace(/\s+/g, ' ').slice(0, 200)}`);
    const args = ['-v', 'ON_ERROR_STOP=1', '-X', '-q', '-A', '-t', '-c', query];
    let r = null;
    if (psqlBy === 'psql') {
      r = spawnSync('psql', [settings.dbUrl, ...args], { encoding: 'utf8' });
      if (r.error && r.error.code === 'ENOENT') {
        psqlBy = 'docker';
        r = null;
      }
    }
    if (!r) r = spawnSync('docker', ['exec', '-i', '-e', `PGPASSWORD=${dbPassword}`, dbContainer, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres', ...args], { encoding: 'utf8' });
    if (r.error) throw new Error(`could not run psql (${psqlBy}): ${r.error.message}`);
    if (r.status !== 0) throw new Error(`the SQL failed: ${String(r.stderr || r.stdout).trim()}`);
    return r.stdout.trim();
  }

  // The sign-in email for this address from the local mail catcher: Mailpit
  // (the CLI's current one) or Inbucket (older CLIs), whichever answers.
  async function readSignInEmail(email) {
    const until = Date.now() + SIGN_IN_WAIT_MS;
    let lastError = '';
    while (Date.now() < until) {
      try {
        const list = await fetch(`${settings.mailUrl}/api/v1/messages?limit=50`);
        if (list.ok) {
          const body = await list.json();
          const hit = (Array.isArray(body.messages) ? body.messages : []).find((m) => (m.To || []).some((t) => String(t.Address || '').toLowerCase() === email));
          if (hit) {
            const one = await (await fetch(`${settings.mailUrl}/api/v1/message/${encodeURIComponent(hit.ID)}`)).json();
            return { catcher: 'Mailpit', subject: String(one.Subject || hit.Subject || ''), text: String(one.Text || ''), html: String(one.HTML || '') };
          }
        } else {
          const box = email.split('@')[0];
          const inbucket = await fetch(`${settings.mailUrl}/api/v1/mailbox/${encodeURIComponent(box)}`);
          if (inbucket.ok) {
            const items = await inbucket.json();
            const hit = Array.isArray(items) && items.length ? items[items.length - 1] : null;
            if (hit) {
              const one = await (await fetch(`${settings.mailUrl}/api/v1/mailbox/${encodeURIComponent(box)}/${encodeURIComponent(hit.id)}`)).json();
              return { catcher: 'Inbucket', subject: String(hit.subject || ''), text: String((one.body && one.body.text) || ''), html: String((one.body && one.body.html) || '') };
            }
          } else {
            lastError = `the mail catcher answered ${list.status} (Mailpit) and ${inbucket.status} (Inbucket)`;
          }
        }
      } catch (e) {
        lastError = `the mail catcher at ${settings.mailUrl} did not answer: ${(e && e.message) || e}`;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`no sign-in email for ${email} within ${SIGN_IN_WAIT_MS / 1000} s${lastError ? `: ${lastError}` : ''}`);
  }

  const config = Object.freeze({ url: settings.url, anonKey: settings.anonKey, functionsUrl: '' });

  /**
   * A new person of this run, signed in the way `via` says, with their own
   * chrome.storage.local holding the session (what syncOnce reads):
   *   'code'  generate_link's six-digit code, typed into the extension's signInFinish
   *   'link'  generate_link's token hash, through the extension's exchangeTokenFromUrl
   *   'email' the extension's signInStart, then the real email in the mail catcher:
   *           its six-digit code when it carries one, else its link's token hash
   */
  async function person(label, via = 'link') {
    const email = `${label}-${run}@${EMAIL_DOMAIN}`;
    const storage = fakeStorage();
    const deps = { config, storage, fetchImpl: tracedFetch, timeoutMs: SYNC_TIMEOUT_MS };
    let session = null;
    let how = '';
    if (via === 'email') {
      const asked = await signInStart(email, deps);
      if (!asked.ok) throw new Error(`the extension's signInStart was refused for ${email}: ${asked.status || ''} ${asked.error}`);
      const mail = await readSignInEmail(email);
      const words = `${mail.text}\n${mail.html}`.replace(/&amp;/g, '&');
      const code = /(?<![#\w])(\d{6})(?!\w)/.exec(readableText(mail));
      if (code) {
        const r = await signInFinish(email, code[1], deps);
        if (!r.ok) throw new Error(`the extension's signInFinish refused the emailed code: ${r.status || ''} ${r.error}`);
        session = r.session;
        how = `the six-digit code from the real email (${mail.catcher}), typed into the extension's signInFinish`;
      } else {
        const hash = /[?&]token=([A-Za-z0-9_-]+)/.exec(words);
        const type = /[?&]type=([a-z_]+)/.exec(words);
        if (!hash) throw new Error(`the sign-in email (${mail.catcher}, "${mail.subject}") has neither a six-digit code nor a link with a token: ${brief(words, 400)}`);
        const r = await exchangeTokenFromUrl(`https://lotsync.invalid/?token_hash=${hash[1]}&type=${type ? type[1] : 'magiclink'}`, { url: settings.url, anonKey: settings.anonKey, fetchImpl: tracedFetch });
        if (!r.ok) throw new Error(`the extension's exchangeTokenFromUrl refused the emailed link: ${r.status || ''} ${r.error}`);
        await storeSession(r.session, storage);
        session = r.session;
        how = `the link in the real email (${mail.catcher}), through the extension's exchangeTokenFromUrl; the email carries no six-digit code`;
      }
    } else {
      const made = await admin('POST', '/auth/v1/admin/users', { email, email_confirm: true });
      if (![200, 201].includes(made.status)) throw new Error(`the admin API did not create ${email}: HTTP ${made.status} ${brief(made.body)}`);
      const link = await admin('POST', '/auth/v1/admin/generate_link', { type: 'magiclink', email });
      if (link.status !== 200 || !link.body || !link.body.hashed_token) throw new Error(`generate_link gave no magic link for ${email}: HTTP ${link.status} ${brief(link.body)}`);
      if (via === 'code') {
        const r = await signInFinish(email, link.body.email_otp, deps);
        if (!r.ok) throw new Error(`the extension's signInFinish refused generate_link's code: ${r.status || ''} ${r.error}`);
        session = r.session;
        how = "generate_link's six-digit code, typed into the extension's signInFinish";
      } else {
        const type = link.body.verification_type || 'magiclink';
        const r = await exchangeTokenFromUrl(`https://lotsync.invalid/?token_hash=${encodeURIComponent(link.body.hashed_token)}&type=${encodeURIComponent(type)}`, { url: settings.url, anonKey: settings.anonKey, fetchImpl: tracedFetch });
        if (!r.ok) throw new Error(`the extension's exchangeTokenFromUrl refused generate_link's token hash: ${r.status || ''} ${r.error}`);
        await storeSession(r.session, storage);
        session = r.session;
        how = `generate_link's token hash (${type}), through the extension's exchangeTokenFromUrl`;
      }
    }
    if (!session || !session.accessToken || !session.user || !session.user.id) throw new Error(`signing ${email} in gave no session with a user id`);
    return { label, email, id: session.user.id, token: session.accessToken, session, storage, deps, how };
  }

  // A dealership the owner's way (supabase/README.md step 5): the row and one
  // first-manager code, in SQL. Its origin is https://www.<label>-<run>.example.
  function dealership(label) {
    const origin = `https://www.${label}-${run}.example`;
    const name = `Stack Test Motors ${label} ${run}`;
    const id = sql(`insert into public.dealerships (name, website_origin) values (${lit(name)}, ${lit(origin)}) returning id`);
    const managerCode = sql(`insert into public.invites (code, dealership_id, role) values (upper(substr(md5(gen_random_uuid()::text || clock_timestamp()::text), 1, 12)), ${lit(id)}, 'manager') returning code`);
    return { id, origin, name, managerCode };
  }

  const s = {
    run,
    root: ROOT,
    url: settings.url,
    anonKey: settings.anonKey,
    siteOrigin: settings.siteOrigin,
    config,
    fetch: tracedFetch,
    signupOpenBefore: null,
    gatewayCors: false, // the gateway answers CORS itself (preflight, below)
    tally,
    check(name, pass, detail = '') {
      const ok = Boolean(pass);
      tally[ok ? 'ok' : 'fail'] += 1;
      say(ok ? 'ok' : 'FAIL', `${name}${detail ? ` (${detail})` : ''}`);
      return ok;
    },
    note(name, detail = '') {
      tally.note += 1;
      say('note', `${name}${detail ? ` (${detail})` : ''}`);
    },
    info(text) {
      say('info', text);
    },
    brief,
    lit,
    http,
    rest,
    rpc,
    admin,
    sql,
    person,
    dealership,
    vin: (tag) => (String(tag) + run).toUpperCase().replace(/[^A-Z0-9]/g, '').padEnd(17, '0').slice(0, 17),
    psqlBy: () => (psqlBy === 'psql' ? 'psql' : `docker exec ${dbContainer}`),
  };
  return s;
}

// ---------- before and after the files ----------

// False when nothing else can run: no gateway, no auth server, or no
// migrations. A function that is not served yet fails its own line and the
// files still run, so every other part of the stack still gets its say.
async function preflight(s, settings) {
  const health = await s.http('GET', '/auth/v1/health', { apikey: settings.anonKey });
  if (!s.check('the stack answers (GoTrue health through the gateway)', health.status === 200, `HTTP ${health.status}`)) return false;

  let applied = [];
  try {
    applied = s.sql('select version from supabase_migrations.schema_migrations order by version').split('\n').filter(Boolean);
  } catch (e) {
    s.check('the migrations were applied by supabase start', false, e.message);
    return false;
  }
  const files = readdirSync(MIGRATIONS).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const missing = files.filter((f) => !applied.includes(f.split('_')[0]));
  s.check(`every file in supabase/migrations is applied (${files.length})`, missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `applied: ${applied.join(' ')}`);
  s.info(`SQL goes through ${s.psqlBy()}`);

  // Each function answers a request that reaches its own code, and the two
  // that read the env file show they got it: an unsigned webhook is refused
  // for its signature (400) only once STRIPE_WEBHOOK_SECRET is set, and an
  // empty form from the landing page gets past the origin check (400) only
  // once LEAD_ORIGINS names it (it counts once toward the lead brake).
  const served = [
    ['sync', 'POST', '/functions/v1/sync', {}, {}, [401], 'a call with no token gets 401'],
    ['rewrite', 'POST', '/functions/v1/rewrite/rewrite', {}, {}, [401], 'a call with no token gets 401'],
    ['billing', 'POST', '/functions/v1/billing/webhook', {}, {}, [400], 'an unsigned webhook gets 400, so STRIPE_WEBHOOK_SECRET is set'],
    ['lead', 'POST', '/functions/v1/lead', { Origin: settings.siteOrigin }, {}, [400], `an empty form from ${settings.siteOrigin} gets 400, so LEAD_ORIGINS names it`],
  ];
  for (const [name, method, path, headers, body, want, meaning] of served) {
    const r = await s.http(method, path, { headers, body });
    let hint = '';
    if (name === 'billing' && r.status === 500) hint = ': the functions run without the env file (docs/stack-test.md)';
    if (name === 'lead' && r.status === 403) hint = `: LEAD_ORIGINS in the functions' env file must be ${settings.siteOrigin} (LOTSYNC_STACK_SITE_ORIGIN)`;
    if (name === 'lead' && r.status === 429) hint = ': the brake still holds this machine from an earlier run; restart `supabase functions serve`';
    s.check(`${name} is served: ${meaning}`, want.includes(r.status), `HTTP ${r.status} ${brief(r.body)}${hint}`);
  }

  // Who answers a CORS preflight. supabase/README.md has each function answer
  // it; the CLI's local gateway (Kong's cors plugin) may answer it first, for
  // every origin, and then put "*" on every answer, so the functions' own
  // CORS answers cannot be seen through it (test/fn-*.test.js cover them, and
  // npm run check-deploy checks them on the hosted project).
  const pre = await s.http('OPTIONS', '/functions/v1/sync', { headers: { Origin: EXTENSION_ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, apikey, content-type' } });
  const allow = pre.headers.get('access-control-allow-origin') || '';
  s.gatewayCors = allow === '*';
  if (s.gatewayCors) s.note('the local gateway answers CORS itself', `a preflight from the extension got HTTP ${pre.status} with allow-origin *, so the functions' own CORS answers are not visible here; the lines about CORS below say so`);
  else s.check("sync answers the extension's CORS preflight itself", pre.status >= 200 && pre.status < 300 && allow === EXTENSION_ORIGIN, `HTTP ${pre.status}, allow-origin ${allow || 'none'}`);
  return true;
}

// Everything this run made, found by the run id in its email addresses and
// website origins; the dealerships first, so the last manager's membership
// goes with its dealership (keep_a_manager lets a dealership's own deletion through).
function cleanup(s) {
  const emails = lit(`%-${s.run}@${EMAIL_DOMAIN}`);
  const statements = [
    `delete from public.dealerships where website_origin like ${lit(`https://www.%-${s.run}.example`)}`,
    `delete from public.invite_misses where user_id in (select id from auth.users where email like ${emails})`,
    `delete from public.demo_requests where email like ${emails}`,
    `delete from auth.users where email like ${emails}`,
  ];
  if (s.signupOpenBefore !== null) statements.push(`update public.signup_settings set open = ${s.signupOpenBefore ? 'true' : 'false'}`);
  try {
    s.sql(statements.join('; '));
    s.info(`removed what run ${s.run} made; self-serve sign-up is ${s.signupOpenBefore ? 'open' : 'closed'} again, as it was`);
  } catch (e) {
    s.note('cleaning up after the run', `${e.message}; the rows carry "${s.run}" in their email or website`);
  }
}

async function main() {
  let settings = stackSettings(process.env);
  let source = 'the environment';
  if (!settings.url || !settings.anonKey || !settings.serviceKey) {
    const r = spawnSync('supabase', ['status', '-o', 'env'], { cwd: ROOT, encoding: 'utf8' });
    if (r.status === 0) {
      settings = stackSettings({ ...parseEnvLines(r.stdout), ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('LOTSYNC_STACK_'))) });
      source = '`supabase status -o env`';
    }
  }
  const missing = [['url', 'LOTSYNC_STACK_URL'], ['anonKey', 'LOTSYNC_STACK_ANON_KEY'], ['serviceKey', 'LOTSYNC_STACK_SERVICE_KEY']].filter(([k]) => !settings[k]).map(([, n]) => n);
  if (missing.length) {
    console.error(`No local stack to test: ${missing.join(', ')} not set, and \`supabase status -o env\` did not answer. Start one with \`supabase start\` (docs/stack-test.md).`);
    process.exit(1);
  }
  if (!isLocal(settings.url)) {
    console.error(`Refusing ${settings.url}: this test writes rows and opens self-serve sign-up, so it runs against a local stack only (http://127.0.0.1:<port>).`);
    process.exit(1);
  }
  if (!settings.mailUrl) settings.mailUrl = settings.url.replace(/:\d+$/, ':54324'); // the CLI's default mail catcher port
  if (!settings.dbUrl) settings.dbUrl = '';

  const only = process.argv.slice(2);
  const files = readdirSync(STACK_DIR).filter((f) => f.endsWith('.stack.mjs')).sort().filter((f) => !only.length || only.some((o) => f.includes(o)));
  const s = makeContext(settings);
  console.log(`Lot Sync stack test, run ${s.run}, against ${settings.url} (settings from ${source}; mail catcher ${settings.mailUrl}; landing page origin ${settings.siteOrigin})`);
  console.log(`Files: ${files.join(', ') || 'none'}\n`);

  let ready = false;
  try {
    ready = await preflight(s, settings);
  } catch (e) {
    s.check('the stack is ready', false, (e && e.message) || String(e));
  }
  if (ready) {
    try {
      s.signupOpenBefore = s.sql('select open from public.signup_settings') === 't';
    } catch (e) {
      s.note('reading the sign-up switch', e.message);
    }
    try {
      for (const f of files) {
        const mod = await import(pathToFileURL(join(STACK_DIR, f)).href);
        console.log(`\n== ${mod.title || f} (test/stack/${f})`);
        try {
          await mod.run(s);
        } catch (e) {
          s.check(`${f} ran to the end`, false, `stopped: ${(e && e.message) || e}`);
          if (e && e.stack) console.log(redact(String(e.stack)).split('\n').slice(1, 6).map((l) => `        ${l.trim()}`).join('\n'));
        }
      }
    } finally {
      console.log('');
      cleanup(s);
    }
  } else {
    console.log('\nThe stack is not ready, so no test file ran. docs/stack-test.md says how to start it.');
  }
  const { ok, fail, note } = s.tally;
  console.log(`\n${ok} ok, ${fail} failed, ${note} note(s).${fail ? '' : ' Nothing failed.'}`);
  process.exitCode = fail ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
