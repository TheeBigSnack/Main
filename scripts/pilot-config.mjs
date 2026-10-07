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
// then the committed accountsConfigured line, word for word, with nothing
// but // comments and blank lines around them) and refuses anything else
// rather than guess. The check's body is pinned and no other code may sit
// beside it because the pack loads the copy in Node, not in the extension: a
// check that read the browser, or a helper that changed what it means,
// could answer false here and true there.
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
// The committed check, word for word: a change to its body is a shape change.
export const CHECK_LINE = 'export const accountsConfigured = (config = ACCOUNT) => Boolean(config && config.url && config.anonKey);';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CHECK = new RegExp(`^${escapeRe(CHECK_LINE)}(?=\\r?$)`, 'm');
// Every line ending JavaScript knows: a // comment stops at any of them.
const LINE_END = /\r\n|[\n\r\u2028\u2029]/;

function shapeProblems(text) {
  if (!text.trim()) return ['the file is empty'];
  const problems = [];
  if (text.includes(PILOT_LINE)) problems.push('it is already a copy packed for a pilot');
  const imports = text.match(/^\s*import\b/gm) || [];
  if (imports.length) problems.push('it imports another module');
  const exports = [...text.matchAll(/^\s*export\s+(?:const|let|var|function|class|default|\{|\*)\s*(\w*)/gm)].map((m) => m[1] || '(another export)');
  if (exports.join() !== 'ACCOUNT,accountsConfigured') problems.push(`its exports are ${exports.join(', ') || 'none'}, not ACCOUNT then accountsConfigured`);
  if (!BLOCK.test(text)) problems.push(`ACCOUNT is not Object.freeze({ ${FIELDS.join(', ')} }) with one plain '...' string each, in that order`);
  if (!CHECK.test(text)) problems.push(`its accountsConfigured line is not the committed one, "${CHECK_LINE}"`);
  if (/\r(?!\n)|[\u2028\u2029]/.test(text)) problems.push('it has a line break other than \\n or \\r\\n (a lone carriage return or a Unicode line separator), which can end a comment early');
  // around the two exports: // comments and blank lines only
  const code = text.replace(BLOCK, '').replace(CHECK, '').split(LINE_END).filter((l) => l.trim() && !/^\s*\/\//.test(l));
  if (code.length) problems.push(`it has something besides // comments, ACCOUNT and accountsConfigured (${JSON.stringify(code[0].trim().slice(0, 80))}${code.length > 1 ? ` and ${code.length - 1} more line${code.length > 2 ? 's' : ''}` : ''})`);
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
