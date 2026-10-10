#!/usr/bin/env node
// Measures the dealer-branding check (extension/src/photoBranding.js) on
// synthetic galleries in Chromium and prints one row per scenario. Exits 1
// on any false crop (a photo cropped that carries no overlay), any lie (a
// crop called clean with an overlay pixel left in it) or any flag on a
// negative (a gallery with no overlay where a photo was cropped or kept).
// See README.md in this folder.
//
//   node scripts/branding-eval/run.mjs                every scenario + timing (a few minutes)
//   node scripts/branding-eval/run.mjs bottom-band neg-studio   only these (no timing)
//   --seeds=N        every scenario with N different cars and scenes (default 1)
//   --sheets         also write <scenario>.png contact sheets (first seed)
//   --tuning=JSON    override module constants, e.g. --tuning='{"tol":10}'
//   --quality=low    decode with imageSmoothingQuality 'low' (default high)
//   --no-timing      skip the timing runs
//   --detail         keep every photo's metrics in the results file
//   --out=name.json  results file name (default results[-low][-seeds][-partial].json)
// Results go to the OS temp folder (the path is printed at the end); then
// node scripts/branding-eval/table.mjs <file> [--groups] prints Markdown tables.
import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { open, outDir } from './serve.mjs';

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => {
  const i = a.indexOf('=');
  return i < 0 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)];
}));
const names = args.filter((a) => !a.startsWith('--'));
const tuning = flags.tuning ? JSON.parse(flags.tuning) : null;
const seeds = Number(flags.seeds || 1);
if (!Number.isInteger(seeds) || seeds < 1) throw new Error('--seeds must be a whole number of 1 or more');
const quality = flags.quality || 'high';
const dir = await outDir();
const { page, close } = await open();
const all = await page.evaluate(() => Object.keys(window.E.SCENARIOS));
const unknown = names.filter((n) => !all.includes(n));
if (unknown.length) {
  await close();
  throw new Error(`no such scenario: ${unknown.join(', ')}`);
}
const run = names.length ? names : all;
const results = [];
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
console.log(pad('scenario', 30), pad('exp', 4), 'n  ', pad('statuses', 46), 'falseC miss lies opqL fringe maxA  strip  lost%(mean/max) checkms');

// one row per scenario over every seed: sums of failures, worst cases, mean loss
const merge = (list) => {
  const a = { ...list[0], statuses: {}, groups: undefined, seeds: list.length };
  for (const k of ['falseCrops', 'falseFlags', 'misses', 'lies', 'insideReported', 'cropped']) a[k] = list.reduce((s, r) => s + r[k], 0);
  for (const k of ['opaqueLeftMax', 'fringeMax', 'stripMax', 'maxAlphaInMax', 'lostCleanMax']) a[k] = Math.max(...list.map((r) => r[k]));
  const c = list.reduce((s, r) => s + r.cropped, 0);
  a.lostCleanMean = c ? +(list.reduce((s, r) => s + r.lostCleanMean * r.cropped, 0) / c).toFixed(4) : 0;
  for (const r of list) for (const [k, v] of Object.entries(r.statuses)) a.statuses[k] = (a.statuses[k] || 0) + v;
  a.ms = { check: +(list.reduce((s, r) => s + r.ms.check, 0) / list.length).toFixed(1), checkMax: Math.max(...list.map((r) => r.ms.check)), decodeAvg: list[0].ms.decodeAvg };
  a.photos = list.reduce((s, r) => s + r.photos, 0);
  a.perSeed = list.map((r) => ({ statuses: r.statuses, groups: (r.groups || []).map((g) => `${g.lot ? 'LOT ' : ''}${g.size} n${g.distinct} ${g.status} ${g.parts.join(' ')}`) }));
  return a;
};

const sheets = [];
for (const name of run) {
  const list = [];
  for (let k = 0; k < seeds; k++) {
    list.push(await page.evaluate(([n, o]) => window.E.runScenario(n, o), [name, { quality, sheet: Boolean(flags.sheets) && k === 0, detail: Boolean(flags.detail), tuning, seedOffset: k }]));
  }
  const sheet = list[0].sheet;
  for (const r of list) delete r.sheet;
  const res = seeds > 1 ? merge(list) : list[0];
  if (sheet) {
    const file = join(dir, `${name.replace(/[^a-z0-9+-]/gi, '_')}.png`);
    await writeFile(file, Buffer.from(sheet, 'base64'));
    sheets.push(file);
  }
  results.push(res);
  const st = Object.entries(res.statuses).map(([k, v]) => `${k}:${v}`).join(' ');
  const bad = res.falseCrops || res.lies || (res.expect === 'negative' && res.falseFlags) ? '  <-- FAIL' : res.misses ? '  (miss)' : '';
  console.log(pad(name, 30), pad(res.expect.slice(0, 3), 4), pad(res.photos, 3), pad(st, 46), pad(res.falseCrops + '/' + res.falseFlags, 6), pad(res.misses, 4), pad(res.lies, 4), pad(res.opaqueLeftMax, 4), pad(res.fringeMax, 6), pad(res.maxAlphaInMax, 5), pad(res.stripMax, 6), pad((res.lostCleanMean * 100).toFixed(1) + '/' + (res.lostCleanMax * 100).toFixed(1), 16), res.ms.check + bad);
}
const sum = (k, list = results) => list.reduce((a, r) => a + r[k], 0);
const failing = results.filter((r) => r.falseCrops || r.lies || (r.expect === 'negative' && r.falseFlags));
console.log(`totals: ${results.length} scenarios x ${seeds} seed(s), ${sum('photos')} photos: false crops ${sum('falseCrops')}, false flags ${sum('falseFlags')}, lies ${sum('lies')}, misses ${sum('misses')}, cropped ${sum('cropped')}${failing.length ? `; FAIL: ${failing.map((r) => r.name).join(', ')}` : ''}`);
if (failing.length) process.exitCode = 1;

const timing = [];
if (!flags['no-timing'] && !names.length) {
  for (const [W, H] of [[1024, 768], [2048, 1536]]) for (const n of [20, 40]) {
    const t = await page.evaluate(([w, h, c, q]) => window.E.runTiming(w, h, c, { quality: q }), [W, H, n, quality]);
    timing.push(t);
    console.log('timing', JSON.stringify(t));
  }
}
const out = join(dir, basename(flags.out || `results${quality === 'low' ? '-low' : ''}${seeds > 1 ? '-seeds' : ''}${names.length ? '-partial' : ''}.json`));
await writeFile(out, JSON.stringify({ when: new Date().toISOString(), quality, seeds, tuning, results, timing }, null, 1));
await close();
console.log(`results: ${out}`);
for (const f of sheets) console.log(`sheet: ${f}`);
