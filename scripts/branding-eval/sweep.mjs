// Sweeps module constants over every scenario and prints one row per tuning:
// the safety failures (false crops, false flags, lies), the misses, how many
// photos were cropped, the clean area lost, and which scenarios changed
// against the first tuning in the list (the baseline).
//   node scripts/branding-eval/sweep.mjs '[["base",{}],["tol 10",{"tol":10}]]' [--seeds=2] [--only=a,b] [--out=sweep-a.json]
// The sweep file goes to the harness's output folder (the path is printed).
// A tuning that brings any false crop, false flag or lie is not one to ship.
import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { open, outDir } from './serve.mjs';

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => {
  const i = a.indexOf('=');
  return i < 0 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)];
}));
const [variantsJson] = args.filter((a) => !a.startsWith('--'));
const variants = JSON.parse(variantsJson);
const seeds = Number(flags.seeds || 1);
const file = join(await outDir(), basename(flags.out || 'sweep.json'));
const { page, close } = await open();
const names = flags.only ? flags.only.split(',') : await page.evaluate(() => Object.keys(window.E.SCENARIOS));
const rows = [];
let base = null;
for (const [label, tuning] of variants) {
  const t = { falseCrops: 0, falseFlags: 0, lies: 0, misses: 0, cropped: 0, lostSum: 0, lostMax: 0, opaqueLeftMax: 0, insideReported: 0 };
  const per = {};
  const t0 = Date.now();
  for (const name of names) {
    const st = [];
    for (let k = 0; k < seeds; k++) {
      const r = await page.evaluate(([n, o]) => window.E.runScenario(n, o), [name, { tuning, seedOffset: k }]);
      for (const key of ['falseCrops', 'falseFlags', 'lies', 'misses', 'cropped', 'insideReported']) t[key] += r[key];
      t.lostSum += r.lostCleanMean * r.cropped;
      t.lostMax = Math.max(t.lostMax, r.lostCleanMax);
      t.opaqueLeftMax = Math.max(t.opaqueLeftMax, r.opaqueLeftMax);
      st.push(Object.entries(r.statuses).sort().map(([s, v]) => `${s}:${v}`).join(' '));
    }
    per[name] = st.join(' | ');
  }
  const lostMean = t.cropped ? t.lostSum / t.cropped : 0;
  const changed = base ? names.filter((n) => per[n] !== base[n]).map((n) => `${n} [${base[n]}] -> [${per[n]}]`) : [];
  if (!base) base = per;
  const row = { label, tuning, ...t, lostMean: +lostMean.toFixed(4), seconds: Math.round((Date.now() - t0) / 1000), changed, per };
  rows.push(row);
  console.log(`${label.padEnd(22)} falseCrops ${t.falseCrops} falseFlags ${t.falseFlags} lies ${t.lies} misses ${t.misses} cropped ${t.cropped} lost ${(lostMean * 100).toFixed(2)}%/${(t.lostMax * 100).toFixed(1)}% opqL ${t.opaqueLeftMax} inside ${t.insideReported} (${row.seconds}s)`);
  for (const c of changed) console.log('    ' + c);
  await writeFile(file, JSON.stringify({ seeds, rows }, null, 1));
}
await close();
console.log(`sweep: ${file}`);
