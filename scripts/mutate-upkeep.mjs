// Mutation probe for the To do upkeep guards (extension/upkeep.js), the To do list reader (extension/src/rescan.js) and the
// side panel's request for the next To do item (extension/sidepanel.js, nextUpkeepRequest).
//
// Each mutant is one exact FIND/REPLACE in a fresh copy of the repo, and the test file that pins it runs in that copy. A
// mutant is killed when that run exits non-zero and its summary reports no cancelled test. Any other result is a survivor:
// a run that timed out has no summary, so it survives too. A FIND that does not occur exactly once is an error, not a
// kill. The base copies, with no change, must pass. The repo itself is not changed.
//
//   node scripts/mutate-upkeep.mjs <outDir> [mutant ids...]     (outDir: a new folder outside the repo)
//
// Prints one JSON line per mutant, with the names of its failing tests. Exits 1 if a base copy fails, a mutant is not
// killed, or a FIND does not match. Plain Node, no dependencies.

import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const UPKEEP = { file: 'extension/upkeep.js', test: 'test/upkeep.test.js' };
const RESCAN = { file: 'extension/src/rescan.js', test: 'test/rescan.test.js' };
const SIDE = { file: 'extension/sidepanel.js', test: 'test/panelFlow.test.js' };

const mutants = [
  { id: 'base', ...UPKEEP, find: null },
  { id: 'base-rescan', ...RESCAN, find: null },
  { id: 'base-side', ...SIDE, find: null },
  // the second finish of an item: the stale answer is reset, and an answer to an earlier finish is not written
  { id: 'S1-no-reset', ...UPKEEP, find: '  up.hasNext = false; // an answer an earlier finish of this item drew is not kept: the question below asks again\n', replace: '' },
  { id: 'S2-no-token', ...UPKEEP, find: 'if (ask !== finishes || run !== starts', replace: 'if (run !== starts' },
  { id: 'S3-open-no-hasnext', ...UPKEEP, find: "if (up.status !== 'done' || !up.hasNext) return; // the button is not drawn then", replace: "if (up.status !== 'done') return; // the button is not drawn then" },
  // the next-item question's own failure: a rejection reads as no next item
  { id: 'T3-no-catch', ...UPKEEP, find: '  try {\n    return Boolean(await ctx.nextItem?.());\n  } catch (e) {\n    return false;\n  }', replace: '  return Boolean(await ctx.nextItem?.());' },
  // the pilot write and the sync go to the item's own website and car
  { id: 'O1a-pilot-origin', ...UPKEEP, find: "await updatePilot(origin, (p) => resolveFlag(p, vin, price ? 'price' : null, { how }));", replace: "await updatePilot(up.origin, (p) => resolveFlag(p, vin, price ? 'price' : null, { how }));" },
  { id: 'O1b-sync-origin', ...UPKEEP, find: "{ type: 'syncNow', origin }", replace: "{ type: 'syncNow', origin: up.origin }" },
  { id: 'O1c-pilot-vin', ...UPKEEP, find: "resolveFlag(p, vin, price ? 'price' : null, { how })", replace: "resolveFlag(p, up.vin, price ? 'price' : null, { how })" },
  // the race guards from the earlier fix pass (proof 15)
  { id: 'M-A-opening-over', ...UPKEEP, find: 'if (run !== starts || !up.active || over()) return; // another item, Not now', replace: 'if (run !== starts || !up.active) return; // another item, Not now' },
  { id: 'M-B-catch-run', ...UPKEEP, find: 'if (run !== starts || !up.active || over()) return; // the failure is about an item that is no longer shown', replace: 'if (!up.active || over()) return; // the failure is about an item that is no longer shown' },
  { id: 'M-C-catch-over', ...UPKEEP, find: 'if (run !== starts || !up.active || over()) return; // the failure is about an item that is no longer shown', replace: 'if (run !== starts || !up.active) return; // the failure is about an item that is no longer shown' },
  { id: 'M-D-sleep-over', ...UPKEEP, find: 'if (run !== starts || !up.active || over()) return; // closed, or finished, meanwhile: no poll starts on it', replace: 'if (run !== starts || !up.active) return; // closed, or finished, meanwhile: no poll starts on it' },
  { id: 'M-E-finish-stop', ...UPKEEP, find: 'stopPolling(); // a poll that started while the writes were under way stops here, with the item done', replace: '// no stop here' },
  { id: 'M-F-poll-catch-over', ...UPKEEP, find: "if (stale() || over()) return;\n      const note = unreadTabNote(tab && tab.url, up.name);", replace: "if (stale() || up.status === 'done') return;\n      const note = unreadTabNote(tab && tab.url, up.name);" },
  { id: 'M-G-over-finding-half', ...UPKEEP, find: "const over = () => up.status === 'done' || up.status === 'finding';", replace: "const over = () => up.status === 'done';" },
  { id: 'M-H-pilot-flag-write', ...UPKEEP, find: "await updatePilot(origin, (p) => resolveFlag(p, vin, price ? 'price' : null, { how }));", replace: '// no pilot flag is written here' },
  // the finish tail during the next-item lookup (proof 16): no guard at all, and the over() guard that would also drop the second finish's own done
  { id: 'B1-no-finding-guard', ...UPKEEP, find: "if (run !== starts || !up.active || up.status === 'finding') return;", replace: 'if (run !== starts || !up.active) return;' },
  { id: 'B2-over-guard', ...UPKEEP, find: "if (run !== starts || !up.active || up.status === 'finding') return;", replace: 'if (run !== starts || !up.active || over()) return;' },
  { id: 'C1-catch-over', ...UPKEEP, find: 'if (run === starts && !over()) {', replace: 'if (run === starts) {' },
  // the poll's first read after the listing page (proof 17): a finished item reads nothing from the posted list
  { id: 'P1-poll-first-over', ...UPKEEP, find: 'if (stale() || !seen || over()) return;', replace: 'if (stale() || !seen) return;' },
  // a To do list entry that is not an object (proof 17): skipped, never read
  { id: 'R1-todo-object-filter', ...RESCAN, find: 'const list = Array.isArray(items) ? items.filter((x) => x && typeof x === \'object\') : [];', replace: 'const list = Array.isArray(items) ? items : [];' },
  // the side panel's Open next To do item request (proof 20): with no posted list, a price row that waits for the next scan is offered
  { id: 'SP1-request-posted-empty', ...SIDE, find: 'nextUpkeepItem({ diff: got[k.diff], posted, flags: got[k.pilot]?.flags', replace: 'nextUpkeepItem({ diff: got[k.diff], posted: {}, flags: got[k.pilot]?.flags' },
];

function run(dir, test) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', test], { cwd: dir });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 400000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

async function check(outDir, m) {
  const dir = join(outDir, m.id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const p of ['extension', 'test', 'package.json']) cpSync(join(root, p), join(dir, p), { recursive: true });
  if (m.find !== null) {
    const file = join(dir, m.file);
    const src = readFileSync(file, 'utf8');
    const count = src.split(m.find).length - 1;
    if (count !== 1) return { id: m.id, error: `FIND occurs ${count} times in ${m.file}` };
    writeFileSync(file, src.replace(m.find, () => m.replace));
  }
  const { code, out } = await run(dir, m.test);
  const failing = [...out.matchAll(/^\s*not ok \d+ - (.*)$/gm)].map((x) => x[1]);
  // node --test's summary lines: "# pass 63", "# fail 0", "# cancelled 0"
  const count = (name) => {
    const line = out.split('\n').find((l) => l.startsWith(`# ${name} `));
    return line ? Number(line.split(' ').pop()) : null;
  };
  return { id: m.id, exit: code, pass: count('pass'), fail: count('fail'), cancelled: count('cancelled'), failing };
}

const [outArg, ...only] = process.argv.slice(2);
if (!outArg) {
  process.stderr.write('Usage: node scripts/mutate-upkeep.mjs <outDir> [mutant ids...]\n');
  process.exit(2);
}
const chosen = only.length ? mutants.filter((m) => m.id.startsWith('base') || only.includes(m.id)) : mutants;
const outDir = resolve(outArg); // outside the repo: each copy is a full tree of extension/ and test/
// a few copies at a time: each run is a separate process with its own storage, so the copies do not interfere
const results = [];
for (let i = 0; i < chosen.length; i += 4) {
  results.push(...await Promise.all(chosen.slice(i, i + 4).map((m) => check(outDir, m))));
}
let bad = 0;
for (const r of results) {
  const isBase = r.id.startsWith('base');
  const ok = r.error ? false : isBase ? r.exit === 0 : r.exit !== 0 && r.cancelled === 0;
  if (!ok) bad += 1;
  console.log(JSON.stringify({ ...r, ok }));
}
process.exit(bad ? 1 : 0);
