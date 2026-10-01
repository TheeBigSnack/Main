#!/usr/bin/env node
// The outside check for what docs/production-setup.md steps 5 and 6 set up:
// the manager view where it is hosted, and the DNS records of the app address
// and of the sign-in email sender. It reads and never writes, and needs no
// key or password: every answer it looks at is public.
//
//   npm run check-hosting -- --app https://app.<domain>/ --sender mail.<domain>
//   npm run check-hosting -- --app https://<project>.pages.dev/      (the page only)
//
// --app       the manager view's address: the page answers over HTTPS with
//             manager/_headers' headers, serves the committed config.js (the
//             same project as this checkout), and not the local demo server.
//             For an address that is not *.pages.dev it also checks the CNAME
//             to <project>.pages.dev (--pages names the project; default
//             lotcurrent-app).
// --sender    the domain sign-in email is sent from: the records Resend asks
//             for (an MX and an SPF TXT on send.<domain>, the DKIM TXT on
//             resend._domainkey.<domain>), and a DMARC record on the sender or
//             its parent domain (a note if missing: mail still goes out, but
//             some inboxes trust it less).
//
// Exit code 0 when nothing failed; notes do not fail the run.

import { readFileSync } from 'node:fs';
import { promises as dnsPromises } from 'node:dns';
import { pathToFileURL } from 'node:url';

export const DEFAULT_PAGES_PROJECT = 'lotcurrent-app';

// The headers manager/_headers sets for every path, as { lower-case name: value }.
export function expectedHeaders(text) {
  const out = {};
  for (const m of String(text).matchAll(/^ {2}([A-Za-z-]+): (.+)$/gm)) out[m[1].toLowerCase()] = m[2].trim();
  return out;
}

// The supabaseUrl a config.js names, or '' (it is a module, not JSON).
export function configUrl(text) {
  const m = String(text || '').match(/^ {2}supabaseUrl: '([^']*)',/m);
  return m ? m[1].replace(/\/+$/, '') : '';
}

// lotcurrent.com for mail.lotcurrent.com: the last two labels. Good for a
// .com, .net or .org sender; under a two-part suffix (.co.uk) it names the
// suffix, and the DMARC line then reads as a note that names where it looked.
export const parentDomain = (host) => String(host).split('.').slice(-2).join('.');

// What goes in a DNS host's Name field for a record at <prefix>.<sender>,
// when the zone is the parent domain: send.mail for send.mail.lotcurrent.com,
// send for send.lotcurrent.com.
export function dnsName(prefix, sender) {
  const sub = String(sender).slice(0, -parentDomain(sender).length).replace(/\.$/, '');
  return sub ? `${prefix}.${sub}` : prefix;
}

// Each request gives up after 15 seconds, so an address that takes the
// connection and never answers is a FAIL line, not a run cut off by its timeout.
async function get(fetchImpl, url) {
  try {
    const res = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
    return { status: res.status, headers: res.headers, body: await res.text() };
  } catch (e) {
    return { status: 0, headers: new Map(), body: '', error: String((e && e.message) || e) };
  }
}
const h = (headers, name) => (headers && typeof headers.get === 'function' ? headers.get(name) : null);

/**
 * The manager view where it is hosted.
 * @param {object} deps { fetchImpl, appUrl, headersText, committedUrl }
 */
export async function checkPage({ fetchImpl = globalThis.fetch, appUrl, headersText, committedUrl }) {
  const out = [];
  let base;
  try {
    base = new URL(appUrl);
  } catch {
    return [{ check: 'a manager view address to check', ok: false, detail: `${appUrl || '(none)'} is not an address` }];
  }
  if (base.protocol !== 'https:') return [{ check: 'the manager view is on HTTPS', ok: false, detail: `${base.href}: the sign-in link must come back to an https address` }];
  if (!base.pathname.endsWith('/')) base.pathname += '/';

  const page = await get(fetchImpl, base.href);
  out.push({ check: `${base.href} answers with the manager view`, ok: page.status === 200 && /manager\.js/.test(page.body), detail: page.error || `${page.status}${page.status === 200 && !/manager\.js/.test(page.body) ? ', but not the manager page' : ''}` });
  if (page.status !== 200) return out;

  for (const [name, want] of Object.entries(expectedHeaders(headersText))) {
    const got = h(page.headers, name);
    out.push({ check: `sends ${name}`, ok: got === want, detail: got === want ? '' : got ? `got ${got}` : 'missing: is manager/_headers deployed with the page?' });
  }

  const config = await get(fetchImpl, new URL('config.js', base).href);
  const live = configUrl(config.body);
  out.push({ check: 'its config.js names the same project as this checkout', ok: config.status === 200 && Boolean(live) && live === committedUrl, detail: config.status !== 200 ? String(config.status) : `${live || '(empty)'}${live === committedUrl ? '' : ` vs ${committedUrl || '(empty)'}: deploy again`}` });

  // Pages answers an unknown path with the page itself, so "not served" means
  // the server's code is not in the answer, whatever the status.
  const server = await get(fetchImpl, new URL('serve.mjs', base).href);
  out.push({ check: 'the local demo server is not published', ok: !/createServer/.test(server.body), detail: /createServer/.test(server.body) ? 'serve.mjs is served: deploy the staged folder, not manager/' : '' });
  return out;
}

const lookupError = (e) => (e && e.code ? e.code : String((e && e.message) || e));
async function lookup(fn, name) {
  try {
    return { records: await fn(name) };
  } catch (e) {
    return { records: [], error: lookupError(e) };
  }
}
const txtValues = (records) => records.map((parts) => (Array.isArray(parts) ? parts.join('') : String(parts)));

/** The app address's CNAME to Cloudflare Pages. A *.pages.dev address has nothing to check. */
export async function checkAppDns({ resolver, appUrl, pagesProject = DEFAULT_PAGES_PROJECT }) {
  let host;
  try {
    host = new URL(appUrl).hostname;
  } catch {
    return [];
  }
  if (host.endsWith('.pages.dev')) return [];
  const want = `${pagesProject}.pages.dev`;
  const { records, error } = await lookup((n) => resolver.resolveCname(n), host);
  const ok = records.some((r) => r.replace(/\.$/, '') === want);
  return [{ check: `${host} points at ${want}`, ok, detail: ok ? '' : records.length ? `CNAME ${records.join(', ')}` : `no CNAME (${error || 'none'}): add it in the domain's DNS (step 6), after the custom domain in Cloudflare` }];
}

/** The sign-in sender's records, as Resend asks for them. */
export async function checkSenderDns({ resolver, sender }) {
  const d = String(sender || '').trim().replace(/\.$/, '');
  if (!d) return [];
  const out = [];
  const mx = await lookup((n) => resolver.resolveMx(n), `send.${d}`);
  const mxOk = mx.records.some((r) => /amazonses\.com\.?$/.test(r.exchange));
  out.push({ check: `send.${d} has Resend's MX record`, ok: mxOk, detail: mxOk ? '' : mx.records.length ? `MX ${mx.records.map((r) => r.exchange).join(', ')}` : `none (${mx.error || 'empty'}): the Name in the domain's DNS is ${dnsName('send', d)}` });

  const spf = await lookup((n) => resolver.resolveTxt(n), `send.${d}`);
  const spfValues = txtValues(spf.records).filter((v) => v.startsWith('v=spf1'));
  const spfOk = spfValues.length === 1 && /include:amazonses\.com/.test(spfValues[0]);
  out.push({ check: `send.${d} has Resend's SPF record`, ok: spfOk, detail: spfOk ? '' : spfValues.length > 1 ? `${spfValues.length} SPF records: a name may have only one` : spfValues[0] || `none (${spf.error || 'empty'})` });

  const dkim = await lookup((n) => resolver.resolveTxt(n), `resend._domainkey.${d}`);
  const dkimOk = txtValues(dkim.records).some((v) => /(^|;\s*)p=[A-Za-z0-9+/=]{20,}/.test(v));
  out.push({ check: `resend._domainkey.${d} has the DKIM key`, ok: dkimOk, detail: dkimOk ? '' : `none (${dkim.error || 'no p= value'}): copy it from Resend's domain page` });

  const dmarcAt = [...new Set([`_dmarc.${d}`, `_dmarc.${parentDomain(d)}`])];
  let dmarc = '';
  for (const name of dmarcAt) {
    const r = await lookup((n) => resolver.resolveTxt(n), name);
    const v = txtValues(r.records).find((x) => /^v=DMARC1/i.test(x));
    if (v) {
      dmarc = `${name}: ${v}`;
      break;
    }
  }
  out.push({ check: 'a DMARC record covers the sender', ok: Boolean(dmarc), warnOnly: true, detail: dmarc || `none at ${dmarcAt.join(' or ')}: add TXT ${dnsName('_dmarc', d)} = v=DMARC1; p=none; (step 5)` });
  return out;
}

export function report(findings) {
  const lines = findings.map((f) => `${f.ok ? 'ok  ' : f.warnOnly ? 'note' : 'FAIL'}  ${f.check}${f.detail ? ` (${f.detail})` : ''}`);
  const failed = findings.filter((f) => !f.ok && !f.warnOnly).length;
  const notes = findings.filter((f) => !f.ok && f.warnOnly).length;
  lines.push('', failed ? `${failed} check(s) failed.` : notes ? `Nothing failed; ${notes} note(s) above.` : 'Every check passed.');
  return { text: lines.join('\n'), failed, notes };
}

export function parseArgs(argv) {
  const opts = { app: '', sender: '', pages: DEFAULT_PAGES_PROJECT };
  for (let i = 0; i < argv.length; i += 1) {
    const key = { '--app': 'app', '--sender': 'sender', '--pages': 'pages' }[argv[i]];
    if (!key || !argv[i + 1]) throw new Error(`unexpected ${argv[i]}`);
    opts[key] = argv[i + 1];
    i += 1;
  }
  if (!opts.app && !opts.sender) throw new Error('give --app, --sender or both');
  return opts;
}

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.log(`${e.message}\nusage: npm run check-hosting -- [--app https://app.<domain>/] [--sender mail.<domain>] [--pages <Pages project>]`);
    process.exitCode = 2;
    return;
  }
  const { CONFIG } = await import('../manager/config.js');
  const findings = [];
  if (opts.app) {
    findings.push(...await checkPage({
      appUrl: opts.app,
      headersText: readFileSync(new URL('../manager/_headers', import.meta.url), 'utf8'),
      committedUrl: String(CONFIG.supabaseUrl || '').replace(/\/+$/, ''),
    }));
    findings.push(...await checkAppDns({ resolver: dnsPromises, appUrl: opts.app, pagesProject: opts.pages }));
  }
  if (opts.sender) findings.push(...await checkSenderDns({ resolver: dnsPromises, sender: opts.sender }));
  const { text, failed } = report(findings);
  console.log(text);
  process.exitCode = failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main(process.argv.slice(2));
