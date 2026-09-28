// Lot Sync rewrite service. One endpoint, POST /rewrite, that asks Claude for
// a Marketplace description from a JSON object of facts, checks the draft with
// the same guardrails the extension uses, and returns it. The Anthropic API
// key lives here, in backend/.env, never in the extension.
//
// Run:  npm ci && npm start   (Node 20+). See backend/README.md.
//
// Protection: it listens on 127.0.0.1 unless HOST says otherwise (any other
// address requires REWRITE_KEY), an optional shared key the extension must
// send, a per-minute rate limit per caller, and a monthly cost cap (tracked
// in usage.json).

import http from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { buildRewritePrompt } from './rewritePrompt.js';
import { runGuardrails } from '../extension/src/rewriteTemplate.js';

const here = dirname(fileURLToPath(import.meta.url));

function loadEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv(join(here, '.env'));

const config = {
  port: Number(process.env.PORT) || 8787,
  // Haiku 4.5 by default for cost and speed; REWRITE_MODEL=claude-sonnet-5 to switch.
  model: process.env.REWRITE_MODEL || 'claude-haiku-4-5',
  key: process.env.REWRITE_KEY || '', // shared secret the extension must send; empty = open (local use only)
  perMinute: Number(process.env.RATE_LIMIT_PER_MINUTE) || 20,
  monthlyCapUsd: Number(process.env.MONTHLY_COST_CAP_USD) || 25,
  usageFile: join(here, 'usage.json'),
};

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set. Copy backend/.env.example to backend/.env and add your key.');
  process.exit(1);
}
const client = new Anthropic({ timeout: 30_000, maxRetries: 2 });

// $ per million tokens (input, output), first-party API rates as of 2026-06.
const PRICES = { 'claude-haiku-4-5': [1, 5], 'claude-sonnet-5': [2, 10], 'claude-opus-5': [5, 25] };
const priceOf = (model) => PRICES[Object.keys(PRICES).find((m) => String(model).startsWith(m))] || [10, 50];

// ---------- monthly cost cap ----------
const month = () => new Date().toISOString().slice(0, 7);
function loadUsage() {
  try {
    const u = JSON.parse(readFileSync(config.usageFile, 'utf8'));
    if (u && u.month === month()) return u;
  } catch (e) { /* first run */ }
  return { month: month(), usd: 0, requests: 0 };
}
let usage = loadUsage();
function addUsage(model, u) {
  const [inP, outP] = priceOf(model);
  const usd = ((u.input_tokens || 0) * inP + (u.output_tokens || 0) * outP) / 1e6;
  if (usage.month !== month()) usage = { month: month(), usd: 0, requests: 0 };
  usage.usd += usd;
  usage.requests += 1;
  try { writeFileSync(config.usageFile, JSON.stringify(usage)); } catch (e) { /* read-only disk: cap still works in memory */ }
  return usd;
}

// ---------- per-caller rate limit ----------
const recent = new Map();
function allow(who) {
  const now = Date.now();
  const list = (recent.get(who) || []).filter((t) => now - t < 60_000);
  if (list.length >= config.perMinute) return false;
  list.push(now);
  recent.set(who, list);
  return true;
}

// The guardrails want a vehicle-shaped object; the facts are that object minus the VIN.
function guardrailContext(facts) {
  return {
    vehicle: {
      year: facts.year, make: facts.make, model: facts.model, trim: facts.trim, mileage: facts.mileage, stock: facts.stock,
      engine: facts.engine, transmission: facts.transmission, drivetrain: facts.drivetrain,
      exteriorColor: facts.exteriorColor, interiorColor: facts.interiorColor, bodyType: facts.bodyType, fuelType: facts.fuelType,
      features: Array.isArray(facts.features) ? facts.features : [],
      descriptionRaw: Array.isArray(facts.narrative) ? facts.narrative.join(' ') : '',
      carfaxOneOwner: facts.carfaxOneOwner === true,
      carfaxUrl: facts.carfax ? 'yes' : null,
    },
    dealer: facts.dealer || {},
    priceNote: facts.priceNote || '',
  };
}

async function draft(facts, fixes) {
  const { system, user } = buildRewritePrompt(facts, fixes);
  const response = await client.messages.create({
    model: config.model,
    max_tokens: 600,
    system,
    messages: [{ role: 'user', content: user }],
  });
  const cost = addUsage(response.model || config.model, response.usage || {});
  if (response.stop_reason === 'refusal') return { text: '', refused: true, cost, model: response.model };
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  return { text, cost, model: response.model, truncated: response.stop_reason === 'max_tokens' };
}

async function rewrite(facts) {
  const ctx = guardrailContext(facts);
  let d = await draft(facts, []);
  let g = runGuardrails(d.text, ctx);
  let cost = d.cost;
  if (!g.ok && !d.refused) {
    // regenerate once with the problems spelled out, then give up (the extension falls back to its template)
    d = await draft(facts, g.problems.map((p) => p.text));
    g = runGuardrails(d.text, ctx);
    cost += d.cost;
  }
  return {
    ok: g.ok,
    text: d.text,
    model: d.model,
    guardrails: g,
    costUsd: Number(cost.toFixed(5)),
    error: g.ok ? '' : d.refused ? 'the model declined this request' : 'the draft failed the checks twice',
  };
}

// Colors from the photos, for cars whose website record gives no usable
// color. Claude looks at up to four photo URLs and picks from the list.
const COLOR_MAX_PHOTOS = 4;
const DEFAULT_COLORS = ['Black', 'Blue', 'Brown', 'Gold', 'Green', 'Gray', 'Pink', 'Purple', 'Red', 'Silver', 'Orange', 'White', 'Yellow', 'Charcoal', 'Tan', 'Beige', 'Burgundy', 'Turquoise', 'Off white'];

async function guessColors(photos, options) {
  const content = photos.slice(0, COLOR_MAX_PHOTOS).map((url) => ({ type: 'image', source: { type: 'url', url } }));
  content.push({
    type: 'text',
    text: `These are a car dealer's photos of one used vehicle. From this list only, pick the exterior paint color and the interior color: ${options.join(', ')}. ` +
      'If no photo shows the interior, answer "unknown" for interior; if the exterior is not clearly visible, answer "unknown". ' +
      'Reply with JSON only, like {"exterior":"Gray","interior":"Black","confidence":"high"} where confidence is high, medium or low.',
  });
  const response = await client.messages.create({ model: config.model, max_tokens: 120, messages: [{ role: 'user', content }] });
  const cost = addUsage(response.model || config.model, response.usage || {});
  if (response.stop_reason === 'refusal') return { ok: false, error: 'the model declined to look at these photos', costUsd: cost };
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const m = /\{[\s\S]*\}/.exec(text);
  let j = {};
  try { j = m ? JSON.parse(m[0]) : {}; } catch (e) { return { ok: false, error: 'the model did not answer in the expected form', costUsd: cost }; }
  const pick = (val) => options.find((o) => o.toLowerCase() === String(val || '').trim().toLowerCase()) || '';
  return { ok: true, exterior: pick(j.exterior), interior: pick(j.interior), confidence: ['high', 'medium', 'low'].includes(j.confidence) ? j.confidence : 'low', model: response.model, costUsd: Number(cost.toFixed(5)) };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) { reject(new Error('request too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' };

const server = http.createServer(async (req, res) => {
  const send = (status, body) => { res.writeHead(status, { ...CORS, 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (req.method === 'GET' && req.url === '/health') {
    return send(200, { ok: true, model: config.model, month: usage.month, usd: Number(usage.usd.toFixed(4)), capUsd: config.monthlyCapUsd, requests: usage.requests });
  }
  if (req.method !== 'POST' || !['/rewrite', '/color'].includes(req.url)) return send(404, { ok: false, error: 'not found' });
  if (config.key && req.headers.authorization !== `Bearer ${config.key}`) return send(401, { ok: false, error: 'bad or missing service key' });
  if (!allow(req.socket.remoteAddress || 'unknown')) return send(429, { ok: false, error: 'too many requests; slow down' });
  if (usage.month === month() && usage.usd >= config.monthlyCapUsd) return send(429, { ok: false, error: `monthly cost cap of $${config.monthlyCapUsd} reached` });

  let body;
  try {
    body = JSON.parse(await readBody(req, 64 * 1024));
  } catch (e) {
    return send(400, { ok: false, error: 'bad JSON: ' + e.message });
  }

  try {
    if (req.url === '/color') {
      const photos = Array.isArray(body && body.photos) ? body.photos.filter((u) => typeof u === 'string' && /^https:\/\//i.test(u)).slice(0, COLOR_MAX_PHOTOS) : [];
      if (!photos.length) return send(400, { ok: false, error: 'photos are missing (1 to 4 https addresses)' });
      const options = Array.isArray(body.options) && body.options.length ? body.options.map(String).slice(0, 40) : DEFAULT_COLORS;
      const out = await guessColors(photos, options);
      console.log(`${new Date().toISOString()} color ${photos.length} photo(s) -> ${out.ok ? `${out.exterior || '?'} / ${out.interior || '?'} (${out.confidence})` : out.error} $${out.costUsd} (month $${usage.usd.toFixed(2)})`);
      return send(200, out);
    }
    const facts = body;
    if (!facts || typeof facts !== 'object' || !facts.make || !facts.model) return send(400, { ok: false, error: 'facts are missing (year, make, model, ...)' });
    const out = await rewrite(facts);
    console.log(`${new Date().toISOString()} rewrite ${facts.year} ${facts.make} ${facts.model} -> ${out.ok ? 'ok' : 'failed checks'} $${out.costUsd} (month $${usage.usd.toFixed(2)})`);
    return send(200, out);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return send(502, { ok: false, error: 'the Anthropic API key was rejected' });
    if (e instanceof Anthropic.RateLimitError) return send(503, { ok: false, error: 'the Anthropic API is rate limiting; try again shortly' });
    if (e instanceof Anthropic.APIConnectionError) return send(502, { ok: false, error: 'could not reach the Anthropic API' });
    if (e instanceof Anthropic.APIError) return send(502, { ok: false, error: `Anthropic API error ${e.status}: ${e.message}` });
    console.error(e);
    return send(500, { ok: false, error: String((e && e.message) || e) });
  }
});

// Loopback only unless HOST says otherwise. Any other address puts the service
// on the network, so it must then have the shared key.
const host = process.env.HOST || '127.0.0.1';
if (host !== '127.0.0.1' && host !== 'localhost' && !config.key) {
  console.error('REWRITE_KEY is required when HOST is not 127.0.0.1');
  process.exit(1);
}
server.listen(config.port, host, () => {
  console.log(`Lot Sync rewrite service on http://${host}:${config.port} (model ${config.model}, cap $${config.monthlyCapUsd}/month${config.key ? ', key required' : ', NO KEY: local use only'})`);
});
