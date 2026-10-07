// The one file the pilot zip changes (npm run pack -- --pilot; docs/release.md).
//
// The committed extension/src/accountConfig.js names the production account
// project, and must (the deploy workflow refuses a config that does not name
// the project it deploys to), so every build made from it offers sign-in.
// While the pilot runs signed out (PILOT.md, "No sign-in while the texts are
// drafts") testers get a zip whose copy of that file has every value empty:
// accountsConfigured() is then false, so set-up has no Account step,
// Settings shows one line instead of a sign-in, nothing syncs and nothing is
// sent to the account server.
//
// pilotAccountConfig() is a text edit of that one file, built in memory: the
// committed file is never written. It knows exactly one shape (the frozen
// ACCOUNT with url, anonKey and functionsUrl as plain strings, in that order,
// and accountsConfigured) and refuses anything else rather than guess.
// accountsOffProblems() then loads the result as a module, from a data: URL,
// and says what stops it from giving accounts off. scripts/pack.mjs and
// scripts/store-check.mjs both use the two.

export const PILOT_CONFIG_PATH = 'src/accountConfig.js';

// The line the pilot copy gets at its top, above the committed comments.
export const PILOT_LINE = '// Packed for a pilot without accounts (npm run pack -- --pilot): every value below is empty, so this copy offers no sign-in, syncs nothing and contacts no account server.';

const FIELDS = Object.freeze(['url', 'anonKey', 'functionsUrl']);
// A single-quoted string with no line break in it.
const STRING = "'(?:[^'\\\\\\r\\n]|\\\\.)*'";
// The frozen ACCOUNT object, its three values in order, each line kept with
// its own ending (a Windows checkout's CRLF stays CRLF).
const BLOCK = new RegExp(
  '^export const ACCOUNT = Object\\.freeze\\(\\{\\r?\\n'
  + FIELDS.map((f) => ` {2}${f}: ${STRING},\\r?\\n`).join('')
  + '\\}\\);(?=\\r?$)',
  'm',
);
const VALUE = new RegExp(`^( {2}(?:${FIELDS.join('|')}): )${STRING},`, 'gm');

function shapeProblems(text) {
  if (!text.trim()) return ['the file is empty'];
  const problems = [];
  if (text.includes(PILOT_LINE)) problems.push('it is already a copy packed for a pilot');
  const imports = text.match(/^\s*import\b/gm) || [];
  if (imports.length) problems.push('it imports another module');
  const exports = [...text.matchAll(/^\s*export\s+(?:const|let|var|function|class|default|\{|\*)\s*(\w*)/gm)].map((m) => m[1] || '(another export)');
  if (exports.join() !== 'ACCOUNT,accountsConfigured') problems.push(`its exports are ${exports.join(', ') || 'none'}, not ACCOUNT then accountsConfigured`);
  if (!BLOCK.test(text)) problems.push(`ACCOUNT is not Object.freeze({ ${FIELDS.join(', ')} }) with one plain '...' string each, in that order`);
  if (!/^export const accountsConfigured = /m.test(text)) problems.push('there is no "export const accountsConfigured = " line');
  return problems;
}

// The pilot copy of the account config: every value emptied, the comments
// and the code kept, PILOT_LINE added at the top. Throws, naming what is
// different, when the text is not the shape above.
export function pilotAccountConfig(source) {
  const text = String(source ?? '');
  const problems = shapeProblems(text);
  if (problems.length) {
    throw new Error(`extension/${PILOT_CONFIG_PATH} does not have the shape the pilot pack rewrites (${problems.join('; ')}). Nothing was packed: change scripts/pilot-config.mjs and test/pilotPack.test.js with it.`);
  }
  const eol = /^[^\n]*\r\n/.test(text) ? '\r\n' : '\n';
  return PILOT_LINE + eol + text.replace(BLOCK, (block) => block.replace(VALUE, "$1'',"));
}

// A module from its text, with no file: what the packed copy gives a browser.
export function loadAccountConfig(text) {
  return import(`data:text/javascript;base64,${Buffer.from(String(text), 'utf8').toString('base64')}`);
}

// What stops a config's text from giving accounts off, once loaded as a
// module: [] when it exports only a frozen ACCOUNT whose three values are
// empty and an accountsConfigured() that answers false.
export async function accountsOffProblems(text) {
  let mod;
  try {
    mod = await loadAccountConfig(text);
  } catch (e) {
    return [`it does not load as a module: ${e.message}`];
  }
  const problems = [];
  const names = Object.keys(mod).sort();
  if (names.join() !== 'ACCOUNT,accountsConfigured') problems.push(`it exports ${names.join(', ') || 'nothing'}, not ACCOUNT and accountsConfigured`);
  const account = mod.ACCOUNT;
  if (!account || typeof account !== 'object' || !Object.isFrozen(account)) {
    problems.push('ACCOUNT is not a frozen object');
  } else {
    const keys = Object.keys(account);
    if (keys.join() !== FIELDS.join()) problems.push(`ACCOUNT holds ${keys.join(', ') || 'nothing'}, not ${FIELDS.join(', ')}`);
    for (const f of FIELDS) if (account[f] !== '') problems.push(`ACCOUNT.${f} is ${JSON.stringify(account[f])}, not empty`);
  }
  if (typeof mod.accountsConfigured !== 'function') {
    problems.push('accountsConfigured is not a function');
  } else {
    let answer;
    try {
      answer = mod.accountsConfigured();
    } catch (e) {
      answer = `an error (${e.message})`;
    }
    if (answer !== false) problems.push(`accountsConfigured() gives ${typeof answer === 'string' ? answer : JSON.stringify(answer)}, not false`);
  }
  return problems;
}
