// Prints the metrics of a results file of run.mjs as a Markdown table.
//   node scripts/branding-eval/table.mjs results-seeds.json            one row per scenario
//   node scripts/branding-eval/table.mjs results-seeds.json --groups   one row per kind of scenario
// A bare file name is looked up in the harness's output folder (OUT_DIR).
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { OUT_DIR } from './serve.mjs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--')) || 'results.json';
const grouped = args.includes('--groups');
const path = isAbsolute(file) || existsSync(file) ? file : join(OUT_DIR, file);
const { results, seeds, quality, timing } = JSON.parse(await readFile(path, 'utf8'));
const pct = (v) => (v * 100).toFixed(1);
const short = { cropped: 'crop', none: 'none', 'kept/too-much': 'kept', 'unchecked/too-few': 'too-few', 'unchecked/too-alike': 'too-alike', 'unchecked/too-small': 'too-small', 'cropped/inside': 'crop+inside' };
const sum = (k, list = results) => list.reduce((s, r) => s + r[k], 0);
console.log(`${file}: ${seeds || 1} seed(s), decode quality ${quality}`);

// the kind of each scenario, by name
const KINDS = [
  ['band + see-through watermark (band cropped, watermark stays)', (n) => n === 'band+watermark'],
  ['see-through watermark only (not looked for)', (n) => /watermark/.test(n)],
  ['cover-only banner (lot of other cars)', (n) => /^cover-banner/.test(n)],
  ['overlay on under 80% of photos', (n) => /^(two-without-of-8|band-on-14-of-20)$/.test(n)],
  ['gallery of 3', (n) => n === 'gallery-3-band'],
  ['semi-opaque band', (n) => /^semi-opaque/.test(n)],
  ['band with shadow', (n) => /^band-with-shadow/.test(n)],
  ['opaque logo inside the photo', (n) => n === 'centre-logo-opaque'],
  ['frame', (n) => /frame/.test(n)],
  ['corner logo', (n) => /corner-badge|corner-tab|badge-/.test(n)],
  ['negative: fixed camera or booth', (n) => /^neg-(fixed|booth|studio-mostly)/.test(n)],
  ['negative: same spot', (n) => /^neg-(same-spot|lot-same-spot|lot-4-same-spot)/.test(n)],
  ['negative: placeholders, duplicates, small', (n) => /^neg-(tiny|big|dupes|duplicates|gallery-3)/.test(n)],
  ['negative: letterbox (not branding)', (n) => n === 'neg-letterbox'],
  ['negative: other', (n) => /^neg-/.test(n)],
  ['edge band (bottom, top+bottom, tab, sizes, JPEG, CDN)', () => true],
];
const kindOf = (n) => KINDS.find(([, f]) => f(n))[0];

const fringeOf = (list) => {
  const worst = list.reduce((a, r) => (r.fringeMax > (a ? a.fringeMax : 0) ? r : a), null);
  return worst ? `${worst.fringeMax} (${worst.maxAlphaInMax || worst.stripMax})` : '0';
};
const lostOf = (list) => {
  const c = sum('cropped', list);
  if (!c) return '-';
  const mean = list.reduce((s, r) => s + r.lostCleanMean * r.cropped, 0) / c;
  return `${pct(mean)} / ${pct(Math.max(...list.map((r) => r.lostCleanMax)))}`;
};
const statusesOf = (list) => {
  const st = {};
  for (const r of list) for (const [k, v] of Object.entries(r.statuses)) st[k] = (st[k] || 0) + v;
  return Object.entries(st).map(([k, v]) => `${short[k] || k} ${v}`).join(', ');
};

if (grouped) {
  const head = ['kind', 'scenarios', 'photos', 'statuses', 'false crops (+flags)', 'misses', 'lies', 'opaque px left', 'see-through px left (max alpha)', 'clean lost % mean / max'];
  console.log(`| ${head.join(' | ')} |`);
  console.log(`|${head.map(() => '---').join('|')}|`);
  for (const [kind] of KINDS) {
    const list = results.filter((r) => kindOf(r.name) === kind);
    if (!list.length) continue;
    console.log(`| ${kind} | ${list.length} | ${sum('photos', list)} | ${statusesOf(list)} | ${sum('falseCrops', list) + sum('falseFlags', list)} | ${sum('misses', list)} | ${sum('lies', list)} | ${Math.max(...list.map((r) => r.opaqueLeftMax))} | ${fringeOf(list)} | ${lostOf(list)} |`);
  }
} else {
  const head = ['scenario', 'expect', 'photos', 'statuses', 'false crops (+flags)', 'misses', 'lies', 'opaque px left', 'see-through px left (max alpha)', 'clean lost % mean / max'];
  console.log(`| ${head.join(' | ')} |`);
  console.log(`|${head.map(() => '---').join('|')}|`);
  for (const r of results) console.log(`| ${r.name} | ${r.expect} | ${r.photos} | ${statusesOf([r])} | ${r.falseCrops + r.falseFlags} | ${r.misses} | ${r.lies} | ${r.opaqueLeftMax} | ${fringeOf([r])} | ${lostOf([r])} |`);
}
const neg = results.filter((r) => r.expect === 'negative');
console.log(`\nTotals: ${results.length} scenarios, ${sum('photos')} photos; false crops ${sum('falseCrops')}, false flags ${sum('falseFlags')}, lies ${sum('lies')}, misses ${sum('misses')}, cropped ${sum('cropped')}; negatives ${neg.length} scenarios / ${sum('photos', neg)} photos, false crops on them ${sum('falseCrops', neg)}; max opaque px left in a clean crop ${Math.max(...results.map((r) => r.opaqueLeftMax))}.`);
if (timing && timing.length) for (const t of timing) console.log('timing', JSON.stringify(t));
