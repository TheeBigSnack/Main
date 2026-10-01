// Runs the Playwright end-to-end flows (test/e2e/*.e2e.mjs) as child
// processes, a few at a time, and reports how each one did.
//
//   node scripts/e2e-all.mjs                one after another (the default: the queue flow's
//                                           60-second waits time out when two Chromiums compete)
//   node scripts/e2e-all.mjs --parallel 2   two at a time (each flow has its own ports, profile and extension copy)
//   node scripts/e2e-all.mjs --serial       one after another, said explicitly
//   node scripts/e2e-all.mjs post queue     only these flows
//
// The flags exist because `LOTSYNC_E2E_PARALLEL=1 node ...` does not work in
// Windows cmd. Flows can run side by side: each starts its own mock servers
// on free ports and makes its own browser profile and extension copy in
// fresh temp folders. Every line of a flow's output is prefixed with its
// name; the exit code is 1 if any flow failed. Plain Node, no dependencies.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FLOWS = ['popup', 'post', 'queue', 'wizard', 'upkeep', 'standard', 'platforms'];
const root = fileURLToPath(new URL('..', import.meta.url));

function usage(problem) {
  const out = problem ? process.stderr : process.stdout;
  if (problem) out.write(`e2e-all: ${problem}\n`);
  out.write(`Usage: node scripts/e2e-all.mjs [--serial | --parallel N] [${FLOWS.join('|')} ...]\n`);
  process.exit(problem ? 2 : 0);
}

function parseArgs(argv, env) {
  const positive = (value, what) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) usage(`${what} must be a whole number of 1 or more, got "${value ?? ''}"`);
    return n;
  };
  let parallel = env.LOTSYNC_E2E_PARALLEL ? positive(env.LOTSYNC_E2E_PARALLEL, 'LOTSYNC_E2E_PARALLEL') : 1;
  const flows = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--serial') parallel = 1;
    else if (a === '--parallel') { i += 1; parallel = positive(argv[i], '--parallel'); }
    else if (a.startsWith('--parallel=')) parallel = positive(a.slice('--parallel='.length), '--parallel');
    else if (a === '--help' || a === '-h') usage();
    else if (FLOWS.includes(a)) flows.push(a);
    else usage(`unknown argument "${a}"`);
  }
  return { parallel, flows: flows.length ? [...new Set(flows)] : FLOWS };
}

const running = new Set();
let interrupted = false;

function runFlow(flow) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [join('test', 'e2e', `${flow}.e2e.mjs`)], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    running.add(child);
    const prefix = `[${flow}] `;
    const relay = (stream, out) => createInterface({ input: stream }).on('line', (line) => out.write(prefix + line + '\n'));
    relay(child.stdout, process.stdout);
    relay(child.stderr, process.stderr);
    const done = (ok, how) => { running.delete(child); resolve({ flow, ok, how, ms: Date.now() - started }); };
    child.on('error', (e) => done(false, `could not start: ${e.message}`));
    child.on('close', (code, signal) => done(code === 0, code === 0 ? 'passed' : signal ? `killed by ${signal}` : `exit code ${code}`));
  });
}

const { parallel, flows } = parseArgs(process.argv.slice(2), process.env);
const width = Math.min(parallel, flows.length);
console.log(`Running ${flows.length} e2e flow${flows.length === 1 ? '' : 's'} (${flows.join(', ')}), ${width === 1 ? 'one at a time' : `${width} at a time`}.`);
process.on('SIGINT', () => {
  interrupted = true;
  for (const child of running) child.kill('SIGTERM');
});

const startedAt = Date.now();
const queue = [...flows];
const results = [];
async function worker() {
  while (queue.length && !interrupted) results.push(await runFlow(queue.shift()));
}
await Promise.all(Array.from({ length: width }, worker));

const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
const nameWidth = Math.max(...FLOWS.map((f) => f.length)); // keeps the columns lined up
console.log('');
for (const flow of flows) {
  const r = results.find((x) => x.flow === flow);
  console.log(r ? `${r.ok ? 'PASS' : 'FAIL'}  ${flow.padEnd(nameWidth)} ${secs(r.ms).padStart(7)}  ${r.how}` : `SKIP  ${flow.padEnd(nameWidth)}          not run`);
}
const failed = results.filter((r) => !r.ok).length;
const notRun = flows.length - results.length;
console.log(`${failed ? `${failed} of ${results.length} flows failed` : `All ${results.length} flows passed`}${notRun ? `, ${notRun} not run` : ''} in ${secs(Date.now() - startedAt)}.`);
process.exitCode = interrupted ? 130 : failed ? 1 : 0;
