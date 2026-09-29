// The sign-in emails (supabase/templates/). Lot Sync signs people in with no
// password: the extension with the code from the email, the manager view
// with the link in the same email, both asked for with signInWithOtp. While
// config.toml's enable_confirmations is false every sign-in sends the
// magic_link template, a person's first one included; with confirmations on
// (a new hosted project's default) an address that has never signed in gets
// the confirmation template instead. So both carry the code and the link,
// and this file holds them to it: each says where the code and the link are
// used and for how long, loads nothing and tracks nothing, sets no colour
// (so a mail app's dark mode works), shows the address as text for a
// plain-text reader, and names no dealer and nothing of Meta. config.toml
// names each with a subject and a path that exists, the launch checklist
// names each as the Dashboard does with the same subject, and the code
// length the extension's boxes take and the time the emails give are the
// ones config.toml sets, or the CLI's defaults when it sets none (it sets
// neither today).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { ACCOUNT_WORDS } from '../extension/src/wizardSteps.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

// What applies when config.toml leaves a value out: the CLI's own config
// template sets otp_length = 6 and otp_expiry = 3600 (the auth server also
// falls back to 6 digits). Supabase's docs give a new hosted project the
// same hour; the checklist has the owner check both on the hosted project.
const CLI_DEFAULT_OTP_LENGTH = 6;
const CLI_DEFAULT_OTP_EXPIRY = 3600;

// How the emails say a code lifetime. A new otp_expiry needs its words here
// and in both templates.
const LIFETIME_WORDS = { 3600: 'one hour' };
const DIGIT_WORDS = { six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

// The templates signInWithOtp can send, and the name each has on the
// Dashboard's Email Templates page.
const SIGN_IN_TEMPLATES = { magic_link: 'Magic link or OTP', confirmation: 'Confirm sign up' };
// The only template variables they use: both are in the auth server's data
// for these two emails. A misspelt one would go out as an empty space.
const VARIABLES = ['.Token', '.ConfirmationURL'];
const IGNORE_LINE = 'If you did not ask to sign in, ignore this email: nobody can sign in without it.';

// Just enough TOML for config.toml: [section] headers and key = value lines
// whose values are written the way JSON writes them (strings, numbers,
// booleans, arrays). Keys before the first header land under ''.
function parseToml(text) {
  const out = { '': {} };
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const header = line.match(/^\[([\w.-]+)\]$/);
    if (header) {
      section = header[1];
      assert.ok(!out[section], `config.toml has [${section}] twice`);
      out[section] = {};
      continue;
    }
    const kv = line.match(/^([\w-]+)\s*=\s*(.+)$/);
    assert.ok(kv, `a config.toml line this test cannot read: ${line}`);
    out[section][kv[1]] = JSON.parse(kv[2]);
  }
  return out;
}

const config = parseToml(read('../supabase/config.toml'));
const email = config['auth.email'] || {};
const otpLength = email.otp_length ?? CLI_DEFAULT_OTP_LENGTH;
const otpExpiry = email.otp_expiry ?? CLI_DEFAULT_OTP_EXPIRY;

// content_path starts at the folder that holds supabase/ (the CLI reads it so).
const fromRoot = (path) => new URL('../' + path.replace(/^\.\//, ''), import.meta.url);
const templates = Object.keys(SIGN_IN_TEMPLATES).map((name) => {
  const section = config[`auth.email.template.${name}`] || {};
  const path = section.content_path || '';
  const html = path && existsSync(fromRoot(path)) ? readFileSync(fromRoot(path), 'utf8') : '';
  return { name, subject: section.subject, path, html };
});

const withoutComments = (html) => html.replace(/<!--[\s\S]*?-->/g, '');
// What a mail app that shows only text would show.
const textOf = (html) => withoutComments(html)
  .replace(/<head>[\s\S]*?<\/head>/i, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&quot;/g, '"')
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim();

test('config.toml names both sign-in templates with a Lot Sync subject and a path to a file in supabase/templates/', () => {
  for (const t of templates) {
    assert.ok(config[`auth.email.template.${t.name}`], `config.toml has no [auth.email.template.${t.name}]`);
    assert.equal(typeof t.subject, 'string', `[auth.email.template.${t.name}] has no subject`);
    assert.match(t.subject, /Lot Sync/, `the ${t.name} subject does not name Lot Sync`);
    assert.match(t.path, /^\.\/supabase\/templates\/[\w-]+\.html$/, `[auth.email.template.${t.name}] content_path is not a file in ./supabase/templates/`);
    assert.ok(t.html, `${t.path}, named for ${t.name} in config.toml, does not exist`);
  }
  // every template section points at a real file, and no file sits unused
  const named = Object.entries(config).filter(([k]) => k.startsWith('auth.email.template.'));
  for (const [key, section] of named) assert.ok(section.content_path && existsSync(fromRoot(section.content_path)), `[${key}] content_path does not exist`);
  const paths = named.map(([, s]) => s.content_path);
  for (const file of readdirSync(new URL('../supabase/templates/', import.meta.url))) {
    assert.ok(paths.includes(`./supabase/templates/${file}`), `supabase/templates/${file} is named by no [auth.email.template.*] in config.toml`);
  }
});

test('each sign-in template carries the code and the link, each with the line that says where it is used', () => {
  assert.equal(ACCOUNT_WORDS.code, 'Code from the email', 'the extension renamed its code box: say the new name in both templates');
  assert.match(read('../extension/popup.js'), /field\('Code from the email', 'accountCode'/);
  for (const t of templates) {
    const text = textOf(t.html);
    assert.ok(t.html.includes('{{ .Token }}'), `${t.name} has no {{ .Token }}: the extension signs in with the code`);
    assert.ok(t.html.includes('<a href="{{ .ConfirmationURL }}">'), `${t.name} has no link to {{ .ConfirmationURL }}: the manager view signs in with it`);
    assert.ok(text.includes(`Signing in to the Lot Sync extension? Type this code into "${ACCOUNT_WORDS.code}": {{ .Token }}`), `${t.name}: the code does not follow the line that says it is for the extension`);
    assert.ok(text.includes('Signing in to the manager view? Open this link in the same browser you asked from:'), `${t.name}: no line saying the link is for the manager view, in the browser that asked (PKCE)`);
    assert.ok(text.includes(IGNORE_LINE), `${t.name} lacks: ${IGNORE_LINE}`);
    const actions = [...t.html.matchAll(/\{\{-?\s*(.*?)\s*-?\}\}/g)].map((m) => m[1]);
    for (const a of actions) assert.ok(VARIABLES.includes(a), `${t.name} uses {{ ${a} }}, which is not one of ${VARIABLES.join(', ')}`);
    assert.match(t.html, /<h1[^>]*>Sign in to Lot Sync<\/h1>/, `${t.name} does not open with "Sign in to Lot Sync"`);
    const title = (t.html.match(/<title>([^<]*)<\/title>/) || [])[1];
    assert.equal(title, t.subject, `${t.name}: the <title> is not the subject config.toml gives it`);
  }
});

test('the two templates say the same things; confirmation only adds that it confirms the address', () => {
  const [magic, confirmation] = templates.map((t) => withoutComments(t.html));
  const extra = /<p[^>]*>This is the first sign-in for this email address, so using the code or the link also confirms that the address is yours\.<\/p>\n/;
  assert.match(confirmation, extra, 'confirmation.html does not say that it also confirms the address');
  assert.equal(confirmation.replace(extra, ''), magic, 'magic_link.html and confirmation.html differ beyond that one line: change both');
});

test('the sign-in templates load nothing, run nothing and track nothing', () => {
  for (const t of templates) {
    const tags = t.html.match(/<(img|script|link|style|iframe|object|embed|form|input|video|audio|source|picture|svg|base|meta http-equiv)\b/gi);
    assert.equal(tags, null, `${t.name} has ${tags && tags.join(', ')}`);
    for (const [re, what] of [
      [/url\(/i, 'a CSS url()'],
      [/@import/i, 'a CSS import'],
      [/\s(src|srcset|background|action|poster)\s*=/i, 'an attribute that loads something'],
      [/\son[a-z]+\s*=/i, 'an event handler'],
      [/javascript:/i, 'a javascript: address'],
      [/:\/\//, 'a web address (the only address is {{ .ConfirmationURL }})'],
      [/\bwww\./i, 'a web address'],
      [/utm_|[?&](ref|source|campaign|mc_[a-z]+)=/i, 'a tracking parameter'],
    ]) assert.doesNotMatch(t.html, re, `${t.name} has ${what}`);
    const hrefs = [...t.html.matchAll(/href\s*=\s*"([^"]*)"/gi)].map((m) => m[1]);
    assert.ok(hrefs.length, `${t.name} has no link`);
    for (const h of hrefs) assert.equal(h, '{{ .ConfirmationURL }}', `${t.name} links to ${h}: the only link is the sign-in address, with nothing added to it`);
  }
});

test('the sign-in templates read in dark mode and as plain text', () => {
  for (const t of templates) {
    // a mail app recolours an email that sets no colours; the one border is a middle grey that shows on both
    assert.doesNotMatch(t.html, /(^|[;"\s])(color|background(-color|-image)?)\s*:/i, `${t.name} sets a text or background colour, which breaks dark mode in some mail apps`);
    assert.doesNotMatch(t.html, /\s(bgcolor|color|text|link|vlink|alink)\s*=|<font\b/i, `${t.name} sets a colour in HTML`);
    assert.match(t.html, /<meta name="color-scheme" content="light dark">/, `${t.name} does not say it works in light and dark`);
    for (const style of t.html.match(/style="[^"]*"/g) || []) assert.doesNotMatch(style, /'/, `${t.name}: keep quotes out of inline styles (${style})`);
    const text = textOf(t.html);
    // with the tags gone, the address must still be there: the link's own href is not text
    assert.ok(text.includes('paste this address into that browser: {{ .ConfirmationURL }}'), `${t.name} shows the address only inside the link; a plain-text reader needs it as text too`);
    assert.match(text, /^Sign in to Lot Sync /, `${t.name}'s text does not start with what it is`);
  }
});

test('the sign-in emails name no dealer, nothing of Meta and nobody invented', () => {
  for (const t of templates) {
    const all = t.html + '\n' + t.subject;
    assert.doesNotMatch(all, /Waynesburg|Ron Lewis|Chrysler|Dodge|Jeep|\bRam\b/i, `${t.name} names a dealer`);
    // case matters for Meta only: <meta> is a tag
    assert.doesNotMatch(all, /\bMeta\b|Facebook|Marketplace|Instagram/, `${t.name} names Meta or its products; a sign-in email has no reason to`);
    assert.doesNotMatch(all, /facebook|marketplace|instagram/i, `${t.name} names Meta's products; a sign-in email has no reason to`);
    assert.doesNotMatch(all, /©|&copy;|\b(Inc|LLC|Ltd|Corp)\b|\bSuite\b|\bP\.?O\.? Box\b/i, `${t.name} gives a company name or address the owner has not chosen`);
  }
});

test('the time the emails give is the code lifetime config.toml sets, or the CLI default of 3600 seconds when it sets none', () => {
  const words = LIFETIME_WORDS[otpExpiry];
  assert.ok(words, `config.toml sets otp_expiry = ${otpExpiry}: say that time in both templates and add its words to LIFETIME_WORDS`);
  for (const t of templates) {
    assert.ok(textOf(t.html).includes(`The code and the link work once, for ${words}. If you ask for another email, only the newest one works.`), `${t.name} does not say the code and the link work once, for ${words}`);
    assert.doesNotMatch(textOf(t.html).replace(`for ${words}`, ''), /\b(minute|hour|day)s?\b/i, `${t.name} gives another lifetime too`);
  }
});

test('the code length the extension takes is the otp_length config.toml sets, or the CLI default of 6 when it sets none', () => {
  // the two boxes a salesperson types the code into
  const boxes = [
    ['extension/popup.js', /field\('Code from the email', 'accountCode', '', '[^']*maxlength="(\d+)"[^']*placeholder="(\d+) digits"'\)/],
    ['extension/wizard.js', /id="wizCode"[^>]*maxlength="(\d+)"[^>]*placeholder="(\d+) digits"/],
  ];
  for (const [file, re] of boxes) {
    const m = read('../' + file).match(re);
    assert.ok(m, `${file}: no code box with a maxlength and a "N digits" placeholder`);
    assert.equal(Number(m[1]), otpLength, `${file}'s code box takes ${m[1]} characters; the emailed code has ${otpLength} digits`);
    assert.equal(Number(m[2]), otpLength, `${file}'s code box asks for ${m[2]} digits; the emailed code has ${otpLength}`);
  }
  // the sentences and comments that say how long the code is
  for (const file of ['extension/popup.js', 'extension/src/wizardSteps.js', 'extension/src/accountFlow.js', 'extension/src/account.js']) {
    const said = [...read('../' + file).matchAll(/\b(\w+)-digit (?:sign-in )?code\b/g)].map((m) => m[1]);
    assert.ok(said.length, `${file} no longer says how many digits the code has`);
    for (const w of said) assert.equal(DIGIT_WORDS[w.toLowerCase()] ?? Number(w), otpLength, `${file} says a ${w}-digit code; the emailed code has ${otpLength} digits`);
  }
});

test('docs/launch-checklist.md gives each template its Dashboard name and config.toml subject, and the sender item names what SMTP needs', () => {
  const checklist = read('../docs/launch-checklist.md');
  const item = checklist.split('\n').find((l) => l.startsWith('- [ ] **Paste the sign-in email templates into the hosted project'));
  assert.ok(item, 'the checklist has no item for pasting the templates');
  // file, Dashboard name and subject together, so one template's subject cannot drift behind the other's
  for (const t of templates) {
    const says = `\`${t.path.replace(/^\.\//, '')}\` into **${SIGN_IN_TEMPLATES[t.name]}** with the subject "${t.subject}"`;
    assert.ok(item.includes(says), `the item does not say: ${says}`);
  }
  assert.match(item, new RegExp(`\\b${otpLength} digits\\b`), `the item does not have the owner check the hosted code length (${otpLength} digits)`);
  assert.match(item, new RegExp(`\\b${otpExpiry} seconds\\b`), `the item does not have the owner check the hosted code lifetime (${otpExpiry} seconds)`);
  const sender = checklist.split('\n').find((l) => l.startsWith('- [ ] **Choose the sender'));
  assert.ok(sender, 'the checklist has no item for the sender');
  for (const w of ['host', 'port', 'user', 'password', 'sender address', 'paid service', 'spam']) assert.ok(sender.includes(w), `the sender item does not mention "${w}"`);
});
