#!/usr/bin/env node
// Points the extension and the manager view at the production Supabase
// project in one step (docs/production-setup.md, step 4), so the two config
// files can never name different projects or carry a key a browser must not
// see. Both values it writes are public by design: the project URL and the
// publishable key (sb_publishable_..., or the legacy anon key while the
// project still has one). A secret or service_role key is refused and never
// written or printed.
//
//   npm run set-project -- https://<ref>.supabase.co sb_publishable_...
//   npm run set-project -- --check     (exit 1 unless the manager view is ready to deploy)
//
// --check is what the manager view's deploy workflow runs first: both files
// filled, the same project and key, a browser-safe key, and the supabase-js
// address pinned to an exact version served from the page's own folder (the
// page runs it with the manager's session, so a new release must not reach it
// unreviewed, and its Content-Security-Policy allows scripts from 'self' only).

import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { keyKind, isBrowserSafeKey } from './check-deploy.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
export const FILES = Object.freeze({
  account: { path: 'extension/src/accountConfig.js', url: 'url', key: 'anonKey' },
  manager: { path: 'manager/config.js', url: 'supabaseUrl', key: 'supabaseAnonKey' },
});

// A hosted project's own address: https://<20 lower-case letters or digits>.supabase.co.
// A custom domain is refused on purpose: manager/index.html's
// Content-Security-Policy lets the page call *.supabase.co only.
export function projectUrlProblem(url) {
  const u = String(url || '').trim().replace(/\/+$/, '');
  if (!u) return 'no project URL given';
  if (!/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(u)) return `${u} is not a project URL like https://<ref>.supabase.co (Project settings, Data API)`;
  return '';
}

export function keyProblem(key) {
  const kind = keyKind(key);
  if (kind === 'none') return 'no key given';
  if (kind === 'secret' || kind === 'service_role') return `that is the ${kind} key: it must never go in the extension or the page. Use the publishable key, and roll this one in the Dashboard (Project settings, API keys) if it was pasted anywhere else`;
  if (!isBrowserSafeKey(key)) return 'that is not a publishable key (sb_publishable_...) or an anon key';
  return '';
}

// supabase-js as the copy served next to the page at an exact version
// (./vendor/supabase-js-2.117.2.js). A CDN address is refused even when it is
// pinned: the page's Content-Security-Policy allows scripts from its own
// origin only, so the page would not load it (manager/config.js says why).
export function isPinnedClient(address) {
  return /^\.\/vendor\/supabase-js-\d+\.\d+\.\d+\.js$/.test(String(address || ''));
}

const quote = (v) => `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

// Sets `<field>: '<value>',` in a config file's text. Exactly one such line
// must exist, at the two-space indent both files use (a Windows checkout's
// CRLF endings kept as they are); anything else is an
// error rather than a guess.
export function setField(text, field, value) {
  const re = new RegExp(`^(  ${field}: )'(?:[^'\\\\]|\\\\.)*',(\\r?)$`, 'gm');
  const hits = text.match(re) || [];
  if (hits.length !== 1) throw new Error(`expected one "${field}: '...'," line, found ${hits.length}`);
  return text.replace(re, (_, lead, cr) => `${lead}${quote(value)},${cr}`);
}

export function applyProject(texts, url, key) {
  const problem = projectUrlProblem(url) || keyProblem(key);
  if (problem) throw new Error(problem);
  const u = String(url).trim().replace(/\/+$/, '');
  const k = String(key).trim();
  const out = {};
  for (const [name, f] of Object.entries(FILES)) out[name] = setField(setField(texts[name], f.url, u), f.key, k);
  return out;
}

// What --check reports: an empty list means the manager view may deploy.
export function readiness({ account = {}, manager = {} } = {}) {
  const problems = [];
  const mUrl = String(manager.supabaseUrl || '').replace(/\/+$/, '');
  const aUrl = String(account.url || '').replace(/\/+$/, '');
  const urlProblem = projectUrlProblem(mUrl);
  if (urlProblem) problems.push(`manager/config.js supabaseUrl: ${urlProblem}`);
  const kp = keyProblem(manager.supabaseAnonKey);
  if (kp) problems.push(`manager/config.js supabaseAnonKey: ${kp}`);
  if (aUrl !== mUrl || account.anonKey !== manager.supabaseAnonKey) problems.push('extension/src/accountConfig.js and manager/config.js name different projects or keys: run npm run set-project');
  if (!isPinnedClient(manager.supabaseJs)) problems.push(`manager/config.js supabaseJs is not pinned to an exact version served from manager/vendor/: ${manager.supabaseJs || '(empty)'}`);
  if (manager.functionsUrl) problems.push('manager/config.js functionsUrl is set: the page\'s Content-Security-Policy and this check expect the project\'s own /functions/v1');
  return problems;
}

async function main(argv) {
  if (argv[0] === '--check') {
    const { ACCOUNT } = await import('../extension/src/accountConfig.js');
    const { CONFIG } = await import('../manager/config.js');
    const problems = readiness({ account: ACCOUNT, manager: CONFIG });
    for (const p of problems) console.log(`FAIL  ${p}`);
    console.log(problems.length ? `${problems.length} problem(s): the manager view is not ready to deploy.` : 'The manager view is configured for the production project.');
    process.exitCode = problems.length ? 1 : 0;
    return;
  }
  const [url, key] = argv;
  if (!url || !key || argv.length !== 2) {
    console.log('usage: npm run set-project -- https://<ref>.supabase.co sb_publishable_...\n       npm run set-project -- --check');
    process.exitCode = 2;
    return;
  }
  const texts = {};
  for (const [name, f] of Object.entries(FILES)) texts[name] = await readFile(`${root}${f.path}`, 'utf8');
  let out;
  try {
    out = applyProject(texts, url, key);
  } catch (e) {
    console.log(`Nothing written: ${e.message}.`);
    process.exitCode = 1;
    return;
  }
  for (const [name, f] of Object.entries(FILES)) await writeFile(`${root}${f.path}`, out[name]);
  console.log(`Both config files now name ${String(url).trim().replace(/\/+$/, '')} with its ${keyKind(key)} key.`);
  if (keyKind(key) === 'anon') console.log('note: that is the legacy anon key, which Supabase retires by the end of 2026; switch to the publishable key when the project has one.');
  console.log('Next: npm run check-deploy, then commit both files.');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main(process.argv.slice(2));
