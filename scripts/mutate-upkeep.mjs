// Mutation probe for the To do upkeep guards (extension/upkeep.js), the To do list reader (extension/src/rescan.js) and the
// side panel's request for the next To do item (extension/sidepanel.js, nextUpkeepRequest), its checks line and Settings
// sentences for each description source, an edited or Claude-written one included (extension/sidepanel.js), the description's
// stop wording (extension/src/rewriteTemplate.js), and the done panel of a finished To do item (extension/upkeep.js): its
// filled-price banner and the lines drawn around the banner after a take-down or a price update.
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
const TEMPLATE = { file: 'extension/src/rewriteTemplate.js', test: 'test/panelFlow.test.js' };

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
  // an error drawn while the account is read (proof 21): the done panel keeps none, so the clear before done is pinned
  { id: 'F1-done-keeps-error', ...UPKEEP, find: "  up.error = '';\n  up.status = 'done';", replace: "  up.status = 'done';" },
  // the poll's first read after the listing page (proof 17): a finished item reads nothing from the posted list
  { id: 'P1-poll-first-over', ...UPKEEP, find: 'if (stale() || !seen || over()) return;', replace: 'if (stale() || !seen) return;' },
  // the filled-price banner is pinned as one element (proof 22): a sentence added after its last sentence is caught
  { id: 'D1-banner-end', ...UPKEEP, find: '${saversLine}</div>`', replace: '${saversLine} Check it.</div>`' },
  // the run half of the guards after the tab opens and after the wait (proof 22): another item's start leaves the tab and the poll alone
  { id: 'X8-tab-run-guard', ...UPKEEP, find: 'if (run !== starts || !up.active || over()) return; // another item, Not now, or the item finished, meanwhile: the tab stays as it is', replace: 'if (!up.active || over()) return; // another item, Not now, or the item finished, meanwhile: the tab stays as it is' },
  { id: 'X9-wait-run-guard', ...UPKEEP, find: 'if (run !== starts || !up.active || over()) return; // closed, or finished, meanwhile: no poll starts on it', replace: 'if (!up.active || over()) return; // closed, or finished, meanwhile: no poll starts on it' },
  // a To do list entry that is not an object (proof 17): skipped, never read
  { id: 'R1-todo-object-filter', ...RESCAN, find: 'const list = Array.isArray(items) ? items.filter((x) => x && typeof x === \'object\') : [];', replace: 'const list = Array.isArray(items) ? items : [];' },
  // the side panel's Open next To do item request (proof 20): with no posted list, a price row that waits for the next scan is offered
  { id: 'SP1-request-posted-empty', ...SIDE, find: 'nextUpkeepItem({ diff: got[k.diff], posted, flags: got[k.pilot]?.flags', replace: 'nextUpkeepItem({ diff: got[k.diff], posted: {}, flags: got[k.pilot]?.flags' },
  // the Settings sentence for an edited or Claude-written description (proof 21): each mutant adds a contradictory "Save Settings"
  // sentence on one surface (the status line, the checks line, the stale-read line); the strengthened pins must fail on it
  { id: 'SP2-status-edited-sentence', ...SIDE, find: "const fix = settingsFix(stops, state.descriptionSource) || 'Fix the description (or use Reset to template) first.';", replace: "const fix = settingsFix(stops, state.descriptionSource) || (['edited', 'claude'].includes(state.descriptionSource) ? 'Save Settings to write the description again. Fix the description (or use Reset to template) first.' : 'Fix the description (or use Reset to template) first.');" },
  { id: 'SP3-checks-edited-sentence', ...SIDE, find: '  const fix = settingsFix(stops, source);', replace: "  const fix = settingsFix(stops, source) || (['edited', 'claude'].includes(source) ? 'Save Settings to write the description again.' : '');" },
  { id: 'SP4-stale-edited-sentence', ...SIDE, find: '    : ` The description no longer matches it: ${why}', replace: "    : ` ${['edited', 'claude'].includes(state.descriptionSource) ? 'Save Settings to write the description again. ' : ''}The description no longer matches it: ${why}" },
  // the next To do item request's listing link is the posted entry's, not the To do row's url (the car's page on the dealer's website; proof 24)
  { id: 'SP5-request-row-link', ...SIDE, find: "listingUrl: p.listingUrl || '',", replace: "listingUrl: item.url || p.listingUrl || ''," },
  // the status line's joined-sentence stop and the checks line's Settings stop are pinned as whole lines (proof 22): a change in the middle of either is caught
  { id: 'TP1-joined-status-middle', ...TEMPLATE, find: 'start the one after it with a capital letter', replace: 'start the one after it with a small letter' },
  { id: 'TP2-role-stop-wording', ...TEMPLATE, find: '; change it in Settings (${w.field})${how}', replace: '; change it in the Settings page (${w.field})${how}' },
  // a contradictory "Save Settings" sentence ahead of the reasons, when the only stops are Settings stops and the description was edited or written by Claude (proof 23): the end-anchored pins pass it
  { id: 'W1-status-settings-sentence', ...SIDE, find: 'that must pass before the form is filled: ${why}', replace: "that must pass before the form is filled: ${(settingsFix(stops, state.descriptionSource) && ['edited', 'claude'].includes(state.descriptionSource)) ? 'Save Settings to write the description again. ' : ''}${why}" },
  { id: 'W2-checks-settings-sentence', ...SIDE, find: 'Fix before the form can be filled:${list(stops)}', replace: "Fix before the form can be filled:${(fix && ['edited', 'claude'].includes(source)) ? '<p>Save Settings to write the description again.</p>' : ''}${list(stops)}" },
  { id: 'W3-stale-settings-sentence', ...SIDE, find: '    : ` The description no longer matches it: ${why}', replace: "    : ` ${fix && ['edited', 'claude'].includes(state.descriptionSource) ? 'Save Settings to write the description again. ' : ''}The description no longer matches it: ${why}" },
  // the mixed stops of a refused price note (a missing note beside the note's own phrase, so Settings alone gives no fix) for an edited or
  // Claude-written description (proof 24): a sentence "After you save Settings" is caught on the status line, the checks line and the stale-read line
  { id: 'W4-status-mixed-sentence', ...SIDE, find: 'that must pass before the form is filled: ${why}', replace: "that must pass before the form is filled: ${(stops.length > 1 && ['edited', 'claude'].includes(state.descriptionSource)) ? 'After you save Settings, click Reset to template to write the description again. ' : ''}${why}" },
  { id: 'W5-checks-mixed-sentence', ...SIDE, find: 'Fix before the form can be filled:${list(stops)}', replace: "Fix before the form can be filled:${list(stops)}${(stops.length > 1 && ['edited', 'claude'].includes(source)) ? '<p>After you save Settings, click Reset to template to write the description again.</p>' : ''}" },
  { id: 'W6-stale-mixed-sentence', ...SIDE, find: '    : ` The description no longer matches it: ${why}', replace: "    : ` ${(stops.length > 1 && ['edited', 'claude'].includes(state.descriptionSource)) ? 'After you save Settings, click Reset to template to write the description again. ' : ''}The description no longer matches it: ${why}" },
  // a sentence ahead of the reasons when a stop says "Says" (proof 25): the pins as they stand kill it, so it checks the sentence, not how a pin is anchored
  { id: 'W7-says-front-sentence', ...SIDE, find: 'that must pass before the form is filled: ${why}', replace: "that must pass before the form is filled: ${stops.some((p) => /^Says/.test(p.text)) ? 'After you save Settings, click Reset to template. ' : ''}${why}" },
  // a paragraph after the checks line's list when a stop says "Doesn't" (proof 25): the pins as they stand kill it, so it checks the sentence, not how a pin is anchored
  { id: 'W8-checks-doesnt-paragraph', ...SIDE, find: 'Fix before the form can be filled:${list(stops)}', replace: "Fix before the form can be filled:${list(stops)}${stops.some((p) => /^Doesn/.test(p.text)) ? '<p>Change the dealership name in Settings.</p>' : ''}" },
  { id: 'Mw1-checks-warn-prefix', ...SIDE, find: "${warns.length ? `Worth fixing (the form can still be filled):${list(warns)}` : ''}", replace: "${warns.length ? `${stops.length ? '' : '<p>After you save Settings, click Reset to template.</p>'}Worth fixing (the form can still be filled):${list(warns)}` : ''}" },
  { id: 'Mw2-checks-stop-after-warns', ...SIDE, find: "${warns.length ? `Worth fixing (the form can still be filled):${list(warns)}` : ''}", replace: "${warns.length ? `Worth fixing (the form can still be filled):${list(warns)}${stops.length && !fix ? '<p>After you save Settings, click Reset to template.</p>' : ''}` : ''}" },
  { id: 'Mu1-done-panel-step', ...UPKEEP, find: 'else if (up.status === \'done\') body = `<div class="banner good" id="upkeepDone">Done. ${esc(up.note)}</div>`;', replace: 'else if (up.status === \'done\') body = `<p class="hint">Now click <b>Delete</b> on Facebook to finish.</p><div class="banner good" id="upkeepDone">Done. ${esc(up.note)}</div>`;' },
  { id: 'SP6-request-listed-from', ...SIDE, find: 'listedPrice: p.price || null,', replace: "listedPrice: (kind === 'price' && item.from) || p.price || null," },
  // a take-down's done panel draws a step the price update's panel does not (proof 27): only the price update's panel is pinned whole
  { id: 'Mu2-done-panel-takedown-step', ...UPKEEP, find: 'else if (up.status === \'done\') body = `<div class="banner good" id="upkeepDone">Done. ${esc(up.note)}</div>`;', replace: "else if (up.status === 'done') body = `${up.kind === 'takeDown' ? '<p class=\"hint\">Now click <b>Delete</b> on Facebook to finish.</p>' : ''}<div class=\"banner good\" id=\"upkeepDone\">Done. ${esc(up.note)}</div>`;" },
  // a Mark as sold step after the done banner of a car marked done by hand (proof 27)
  { id: 'Mu3-done-panel-marked-step', ...UPKEEP, find: 'else if (up.status === \'done\') body = `<div class="banner good" id="upkeepDone">Done. ${esc(up.note)}</div>`;', replace: "else if (up.status === 'done') body = `<div class=\"banner good\" id=\"upkeepDone\">Done. ${esc(up.note)}</div>${up.note === 'Marked done.' ? '<p class=\"hint\">Now click <b>Mark as sold</b> on Facebook.</p>' : ''}`;" },
  // a take-down the listing shows as sold or removed draws a Delete step ahead of its banner: only the car marked done by hand was pinned whole (proof 27)
  { id: 'Mu4-done-panel-sold-step', ...UPKEEP, find: 'else if (up.status === \'done\') body = `<div class="banner good" id="upkeepDone">Done. ${esc(up.note)}</div>`;', replace: "else if (up.status === 'done') body = `${up.note === 'The listing shows it as sold or removed.' ? '<p class=\"hint\">Now click <b>Delete</b> on Facebook to finish.</p>' : ''}<div class=\"banner good\" id=\"upkeepDone\">Done. ${esc(up.note)}</div>`;" },
  // an extra Settings sentence ahead of the warnings, for an edited or Claude-written description only (proof 27)
  { id: 'Mw3-checks-warn-edited-sentence', ...SIDE, find: "${warns.length ? `Worth fixing (the form can still be filled):${list(warns)}` : ''}", replace: "${warns.length ? `${fix && source !== 'template' ? '<p>Change it in Settings.</p>' : ''}Worth fixing (the form can still be filled):${list(warns)}` : ''}" },
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
