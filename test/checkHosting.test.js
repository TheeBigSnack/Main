// scripts/check-hosting.mjs: the outside check for the hosted manager view
// and the sign-in sender's DNS (docs/production-setup.md steps 5 and 6),
// against a fake web server and a fake resolver.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { expectedHeaders, configUrl, parentDomain, dnsName, checkPage, checkAppDns, checkSenderDns, report, parseArgs, pagesHostOf } from '../scripts/check-hosting.mjs';

const headersText = readFileSync(new URL('../manager/_headers', import.meta.url), 'utf8');
const WANT = expectedHeaders(headersText);
const PROJECT = 'https://abcdefghijklmnopqrst.supabase.co';
const APP = 'https://app.example-product.com/';

// A host serving the deployed folder: the page with its headers, config.js,
// and (like Cloudflare Pages) the page itself for any unknown path.
function fakeHost({ headers = WANT, config = `export const CONFIG = {\n  supabaseUrl: '${PROJECT}',\n};\n`, serveMjs = null, pageStatus = 200 } = {}) {
  const seen = [];
  const page = '<!doctype html><script type="module" src="./manager.js"></script>';
  const fetchImpl = async (url) => {
    seen.push(url);
    const path = new URL(url).pathname;
    const body = path.endsWith('/config.js') ? config : path.endsWith('/serve.mjs') && serveMjs ? serveMjs : page;
    return { status: path.endsWith('/') ? pageStatus : 200, headers: new Headers(headers), text: async () => body };
  };
  return { fetchImpl, seen };
}

const failedChecks = (findings) => findings.filter((f) => !f.ok && !f.warnOnly).map((f) => f.check);

test('expectedHeaders reads every header of manager/_headers', () => {
  assert.equal(WANT['x-frame-options'], 'DENY');
  assert.match(WANT['content-security-policy'], /frame-ancestors 'none'$/);
  assert.equal(Object.keys(WANT).length, 5);
});

test('configUrl and the domain helpers', () => {
  assert.equal(configUrl(`  supabaseUrl: '${PROJECT}/',`), PROJECT);
  assert.equal(configUrl('nothing here'), '');
  assert.equal(parentDomain('mail.example-product.com'), 'example-product.com');
  assert.equal(dnsName('send', 'mail.example-product.com'), 'send.mail');
  assert.equal(dnsName('send', 'example-product.com'), 'send');
  assert.equal(dnsName('_dmarc', 'mail.example-product.com'), '_dmarc.mail');
});

test('a correctly deployed page passes every page check', async () => {
  const { fetchImpl, seen } = fakeHost();
  const findings = await checkPage({ fetchImpl, appUrl: APP, headersText, committedUrl: PROJECT });
  assert.deepEqual(failedChecks(findings), []);
  assert.equal(findings.length, 1 + 5 + 2);
  assert.deepEqual(seen, [APP, `${APP}config.js`, `${APP}serve.mjs`]);
});

test('a page without its headers, with another project, or with the demo server fails, naming each', async () => {
  const { fetchImpl } = fakeHost({
    headers: { 'x-frame-options': 'SAMEORIGIN' },
    config: "  supabaseUrl: 'https://zzzzzzzzzzzzzzzzzzzz.supabase.co',\n",
    serveMjs: "import { createServer } from 'node:http';",
  });
  const findings = await checkPage({ fetchImpl, appUrl: APP, headersText, committedUrl: PROJECT });
  const failed = failedChecks(findings);
  assert.ok(failed.includes('sends x-frame-options'));
  assert.ok(failed.includes('sends content-security-policy'));
  assert.ok(failed.includes('its config.js names the same project as this checkout'));
  assert.ok(failed.includes('the local demo server is not published'));
  assert.match(findings.find((f) => f.check === 'sends x-frame-options').detail, /got SAMEORIGIN/);
});

test('an http address, a bad address and a page that is not there stop early', async () => {
  const { fetchImpl, seen } = fakeHost({ pageStatus: 404 });
  assert.deepEqual(failedChecks(await checkPage({ fetchImpl, appUrl: 'http://app.example-product.com/', headersText, committedUrl: PROJECT })), ['the manager view is on HTTPS']);
  assert.equal(failedChecks(await checkPage({ fetchImpl, appUrl: 'not a url', headersText, committedUrl: PROJECT })).length, 1);
  const findings = await checkPage({ fetchImpl, appUrl: 'https://app.example-product.com', headersText, committedUrl: PROJECT });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].ok, false);
  assert.deepEqual(seen, ['https://app.example-product.com/'], 'a path without the trailing slash is checked as the folder');
});

test('a fetch that throws is a failure with its message, not a crash', async () => {
  const fetchImpl = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
  const findings = await checkPage({ fetchImpl, appUrl: APP, headersText, committedUrl: PROJECT });
  assert.equal(findings[0].ok, false);
  assert.match(findings[0].detail, /ENOTFOUND/);
});

const noRecord = () => Object.assign(new Error('queryTxt ENODATA'), { code: 'ENODATA' });
function fakeResolver(zone) {
  const pick = (type) => async (name) => {
    const r = zone[`${type} ${name}`];
    if (!r) throw noRecord();
    return r;
  };
  return { resolveCname: pick('CNAME'), resolveMx: pick('MX'), resolveTxt: pick('TXT') };
}

test('the app CNAME: right target passes, missing or wrong fails, a pages.dev address has nothing to check', async () => {
  const right = fakeResolver({ 'CNAME app.example-product.com': ['lotcurrent-app.pages.dev'] });
  assert.deepEqual(failedChecks(await checkAppDns({ resolver: right, appUrl: APP })), []);
  const wrong = fakeResolver({ 'CNAME app.example-product.com': ['other.pages.dev'] });
  assert.equal(failedChecks(await checkAppDns({ resolver: wrong, appUrl: APP })).length, 1);
  const named = await checkAppDns({ resolver: wrong, appUrl: APP, pagesProject: 'other' });
  assert.deepEqual(failedChecks(named), []);
  const none = await checkAppDns({ resolver: fakeResolver({}), appUrl: APP });
  assert.match(none[0].detail, /no CNAME \(ENODATA\)/);
  assert.deepEqual(await checkAppDns({ resolver: fakeResolver({}), appUrl: 'https://lotcurrent-app.pages.dev/' }), []);
});

// Cloudflare gives a project a suffixed pages.dev address when its name is
// taken there (production-setup.md step 6.6: "usually lotcurrent-app.pages.dev").
// The CNAME the owner sets to the address Cloudflare shows is right, and the
// check holds it to that address, never to the guess from the project's name.
test('the app CNAME: a suffixed pages.dev address Cloudflare gave the project passes when given, and the guess no longer steers the owner to it', async () => {
  const suffixed = fakeResolver({ 'CNAME app.example-product.com': ['lotcurrent-app-4xk.pages.dev.'] });
  assert.deepEqual(failedChecks(await checkAppDns({ resolver: suffixed, appUrl: APP, pagesHost: 'lotcurrent-app-4xk.pages.dev' })), []);
  const [given] = await checkAppDns({ resolver: suffixed, appUrl: APP, pagesHost: 'lotcurrent-app-4xk.pages.dev' });
  assert.equal(given.check, 'app.example-product.com points at lotcurrent-app-4xk.pages.dev');
  // the unsuffixed name, someone else's project, is a failure when Cloudflare named the suffixed one
  const squatted = fakeResolver({ 'CNAME app.example-product.com': ['lotcurrent-app.pages.dev'] });
  const [held] = await checkAppDns({ resolver: squatted, appUrl: APP, pagesHost: 'lotcurrent-app-4xk.pages.dev' });
  assert.equal(held.ok, false);
  assert.doesNotMatch(held.detail, /--pages-host/, 'the address was given: no hint to give it');
  // without it, the guess fails, and the line says the address Cloudflare shows is the right one
  const [guess] = await checkAppDns({ resolver: suffixed, appUrl: APP });
  assert.equal(guess.ok, false);
  assert.match(guess.detail, /^CNAME lotcurrent-app-4xk\.pages\.dev\.; if Cloudflare shows another \.pages\.dev address for the project, that one is right: give it with --pages-host$/);
  // only a pages.dev address counts as one
  assert.equal(pagesHostOf(' Lotcurrent-App-4xk.pages.dev. '), 'lotcurrent-app-4xk.pages.dev');
  for (const bad of ['', 'lotcurrent-app', 'evil.example.com', 'x.pages.dev.evil.com', '-x.pages.dev', 'https://x.pages.dev/', 'a b.pages.dev']) assert.equal(pagesHostOf(bad), '', bad);
  const junk = await checkAppDns({ resolver: squatted, appUrl: APP, pagesHost: 'evil.example.com' });
  assert.equal(junk[0].check, 'app.example-product.com points at lotcurrent-app.pages.dev', 'a host that is not pages.dev is ignored, not trusted');
});

const SENDER = 'mail.example-product.com';
const goodZone = {
  [`MX send.${SENDER}`]: [{ exchange: 'feedback-smtp.us-east-1.amazonses.com', priority: 10 }],
  [`TXT send.${SENDER}`]: [['v=spf1 include:amazonses.com ~all']],
  [`TXT resend._domainkey.${SENDER}`]: [['p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQ', 'Cabc123']],
  'TXT _dmarc.example-product.com': [['v=DMARC1; p=none;']],
};

test('the sender: Resend\'s records and a parent-domain DMARC pass', async () => {
  const findings = await checkSenderDns({ resolver: fakeResolver(goodZone), sender: SENDER });
  assert.equal(findings.length, 4);
  assert.ok(findings.every((f) => f.ok), JSON.stringify(findings));
  assert.match(findings[3].detail, /^_dmarc\.example-product\.com: /, 'looked at the sender first, then its parent');
});

test('the sender: nothing added yet fails three checks and notes DMARC, naming the DNS Name to use', async () => {
  const findings = await checkSenderDns({ resolver: fakeResolver({}), sender: SENDER });
  assert.equal(failedChecks(findings).length, 3);
  const dmarc = findings.find((f) => f.check === 'a DMARC record covers the sender');
  assert.equal(dmarc.warnOnly, true);
  assert.match(dmarc.detail, /_dmarc\.mail = v=DMARC1/);
  assert.match(findings[0].detail, /Name in the domain's DNS is send\.mail/);
});

test('the sender: two SPF records, a foreign MX and an empty DKIM each fail', async () => {
  const zone = {
    ...goodZone,
    [`MX send.${SENDER}`]: [{ exchange: 'mx.other-mail.example', priority: 10 }],
    [`TXT send.${SENDER}`]: [['v=spf1 include:amazonses.com ~all'], ['v=spf1 -all']],
    [`TXT resend._domainkey.${SENDER}`]: [['p=']],
  };
  const failed = failedChecks(await checkSenderDns({ resolver: fakeResolver(zone), sender: SENDER }));
  assert.equal(failed.length, 3);
});

test('report and parseArgs', () => {
  const r = report([{ check: 'a', ok: true }, { check: 'b', ok: false, warnOnly: true, detail: 'x' }]);
  assert.equal(r.failed, 0);
  assert.equal(r.notes, 1);
  assert.match(r.text, /^note {2}b \(x\)$/m);
  assert.equal(report([{ check: 'c', ok: false }]).failed, 1);
  assert.deepEqual(parseArgs(['--app', APP, '--sender', SENDER]), { app: APP, sender: SENDER, pages: 'lotcurrent-app', pagesHost: '' });
  assert.equal(parseArgs(['--app', APP, '--pages-host', 'Lotcurrent-App-4xk.pages.dev']).pagesHost, 'lotcurrent-app-4xk.pages.dev');
  assert.throws(() => parseArgs(['--app', APP, '--pages-host', 'app.example-product.com']), /--pages-host app\.example-product\.com is not a \.pages\.dev address/);
  assert.throws(() => parseArgs([]), /give --app, --sender or both/);
  assert.throws(() => parseArgs(['--app']), /unexpected --app/);
  assert.throws(() => parseArgs(['--bogus', 'x']), /unexpected --bogus/);
});
