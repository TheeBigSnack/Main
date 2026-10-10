// Lot Current rewrite service as a Supabase Edge Function (Milestone 4). It
// replaces backend/server.js once the owner deploys it: same request and
// answer shapes, so extension/src/rewriter.js needs nothing new but the
// address (…/functions/v1/rewrite) and, in place of the shared key, the
// signed-in person's token.
//
//   POST …/rewrite/rewrite   facts JSON  -> { ok, text, model, guardrails, costUsd, error }
//   POST …/rewrite/color     { photos, options, origin } -> { ok, exterior, interior, confidence, model, costUsd }
//   GET  …/rewrite/health    -> { ok, model, month, usd, capUsd, perMinute, dealership }
//
// Protection, in order: a valid Supabase user token (401), a per-user
// per-minute rate limit on /rewrite and /color (429, before the body or the
// database are read, as /sync's brake; kept in this instance's memory, so
// with several instances a burst can exceed it by that factor), the body
// (400), a membership in a dealership (403; the one for the `origin` sent
// with the facts, matched the way /sync matches it), the dealership's plan
// (402 with code 'lapsed' and the plan when its subscription has lapsed,
// the same answer /sync gives, on every route: nothing is spent for a
// store that no longer pays), and the dealership's monthly cost cap summed
// from rewrite_usage (429 with a plain message; the extension then uses
// its template). test/fn-rewrite.test.js holds the order. The Anthropic
// API key is a function secret; the browser never sees it. Claude is
// called with fetch, no SDK, through the Messages API.
//
// The draft is checked with the same guardrails the extension runs
// (_shared/guardrails.ts, ported from extension/src/rewriteTemplate.js) and
// regenerated once with the problems spelled out, then given up on.
//
// Time: the extension waits 25 seconds for an answer
// (extension/src/rewriter.js REWRITE_TIMEOUT_MS) and then shows its
// template, so nothing done after that reaches anyone and any cost of it is
// wasted. Each request therefore has one deadline under that, 20 seconds
// from its arrival (REWRITE_DEADLINE_MS), shared by every Anthropic call it
// makes: a call still running then is stopped (504), and a retry or a
// second draft starts only while at least 40% of it is left. A caller that
// goes away (req.signal) stops the call the same way. A stopped call
// records no usage.

import { buildRewritePrompt, type RewriteFacts } from '../_shared/rewritePrompt.ts';
import { runGuardrails, type GuardrailContext, type GuardrailResult } from '../_shared/guardrails.ts';
import { json, preflight, readJson, routeOf, isRecord, errorMessage, sameOrigin } from '../_shared/http.ts';
import { requireUser, membershipsOf, subscriptionRowOf, serviceClient, env, type Membership } from '../_shared/auth.ts';
import { planOf, lapsedAnswer } from '../_shared/billing.mjs';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

const config = {
  // Haiku 4.5 by default for cost and speed; REWRITE_MODEL=claude-sonnet-5 to switch.
  model: env('REWRITE_MODEL', 'claude-haiku-4-5'),
  perMinute: Number(env('RATE_LIMIT_PER_MINUTE')) || 20,
  monthlyCapUsd: Number(env('MONTHLY_COST_CAP_USD')) || 25,
  apiKey: env('ANTHROPIC_API_KEY'),
  anthropicUrl: 'https://api.anthropic.com/v1/messages',
  timeoutMs: 30_000,
  deadlineMs: Number(env('REWRITE_DEADLINE_MS')) || 20_000,
  bodyLimit: 64 * 1024,
};

// $ per million tokens (input, output), first-party API rates as of 2026-06,
// the same table as backend/server.js. An unknown model is priced high so
// the cap errs on the side of stopping.
const PRICES: Record<string, [number, number]> = { 'claude-haiku-4-5': [1, 5], 'claude-sonnet-5': [2, 10], 'claude-opus-5': [5, 25] };
function priceOf(model: string): [number, number] {
  const key = Object.keys(PRICES).find((m) => model.startsWith(m));
  return key ? PRICES[key] : [10, 50];
}

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
}

function costOf(model: string, usage: Usage): number {
  const [inP, outP] = priceOf(model);
  return ((usage.input_tokens || 0) * inP + (usage.output_tokens || 0) * outP) / 1e6;
}

// ---------- per-user rate limit (this instance only) ----------

const recent = new Map<string, number[]>();
function allow(who: string): boolean {
  const now = Date.now();
  const list = (recent.get(who) || []).filter((t) => now - t < 60_000);
  if (list.length >= config.perMinute) return false;
  list.push(now);
  recent.set(who, list);
  if (recent.size > 5000) {
    for (const [k, v] of recent) if (!v.some((t) => now - t < 60_000)) recent.delete(k);
  }
  return true;
}

// ---------- monthly cost cap per dealership ----------

const monthOf = (d = new Date()): string => d.toISOString().slice(0, 7);
const monthStart = (d = new Date()): string => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();

// Sums this month's rows in pages (the API answers at most 1,000 rows at a
// time), so the cap holds however many calls a dealership makes.
async function monthSpend(service: SupabaseClient, dealershipId: string): Promise<number> {
  let usd = 0;
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await service.from('rewrite_usage').select('cost_usd').eq('dealership_id', dealershipId).gte('at', monthStart()).order('id', { ascending: true }).range(from, from + page - 1);
    if (error) throw new Error('could not read rewrite_usage: ' + error.message);
    const rows: unknown[] = Array.isArray(data) ? data : [];
    for (const r of rows) usd += Number((isRecord(r) ? r.cost_usd : 0) || 0);
    if (rows.length < page) break;
  }
  return usd;
}

interface Who {
  dealershipId: string;
  userId: string;
}

async function recordUsage(service: SupabaseClient, who: Who, kind: 'rewrite' | 'color', model: string, usage: Usage): Promise<number> {
  const cost = costOf(model, usage);
  const { error } = await service.from('rewrite_usage').insert({
    dealership_id: who.dealershipId,
    user_id: who.userId,
    model,
    input_tokens: usage.input_tokens ?? null,
    output_tokens: usage.output_tokens ?? null,
    cost_usd: Number(cost.toFixed(6)),
    kind,
  });
  // the answer still goes back; the next call's sum will be short by this one row
  if (error) console.error('rewrite_usage insert failed: ' + error.message);
  return cost;
}

// ---------- the Anthropic Messages API, by fetch ----------

interface AnthropicMessage {
  model?: string;
  stop_reason?: string | null;
  content?: Array<{ type: string; text?: string }>;
  usage?: Usage;
}

class UpstreamError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// The request's time: one signal that stops every call it makes, at the
// deadline or when the caller goes away, and whether enough of it is left
// to start another call.
interface Clock {
  signal: AbortSignal;
  roomFor(): boolean;
}
const MIN_LEFT = 0.4;
function clockFor(req: Request): Clock {
  const started = Date.now();
  return {
    signal: AbortSignal.any([req.signal, AbortSignal.timeout(config.deadlineMs)]),
    roomFor() {
      return !this.signal.aborted && config.deadlineMs - (Date.now() - started) >= config.deadlineMs * MIN_LEFT;
    },
  };
}
const OUT_OF_TIME = 'Claude took too long to answer, so it was stopped; the template is used instead';

// One retry on a network error or a 429/5xx while the request has time for
// it, then a plain message the extension shows (it falls back to the
// template either way).
async function callAnthropic(body: Record<string, unknown>, clock: Clock): Promise<AnthropicMessage> {
  for (let attempt = 0; ; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(config.anthropicUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body),
        signal: AbortSignal.any([clock.signal, AbortSignal.timeout(config.timeoutMs)]),
      });
    } catch {
      if (clock.signal.aborted) throw new UpstreamError(504, OUT_OF_TIME);
      if (attempt < 1 && clock.roomFor()) continue;
      throw new UpstreamError(502, 'could not reach the Anthropic API');
    }
    if (res.ok) {
      try {
        return (await res.json()) as AnthropicMessage;
      } catch (e) {
        if (clock.signal.aborted) throw new UpstreamError(504, OUT_OF_TIME);
        throw e;
      }
    }
    const status = res.status;
    let detail = '';
    try {
      const j: unknown = await res.json();
      if (isRecord(j) && isRecord(j.error) && typeof j.error.message === 'string') detail = j.error.message;
    } catch {
      /* no readable body */
    }
    const retryable = status === 429 || status === 529 || status >= 500;
    if (retryable && attempt < 1 && clock.roomFor()) {
      await new Promise((r) => setTimeout(r, 1000));
      if (clock.roomFor()) continue;
    }
    if (status === 401 || status === 403) throw new UpstreamError(502, 'the Anthropic API key was rejected');
    if (status === 429 || status === 529) throw new UpstreamError(503, 'the Anthropic API is rate limiting; try again shortly');
    throw new UpstreamError(502, `Anthropic API error ${status}${detail ? ': ' + detail : ''}`);
  }
}

const textOf = (m: AnthropicMessage): string => (m.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('\n').trim();

// ---------- /rewrite ----------

const NO_DEALER_NAME = "the dealership's name is missing: add it in Settings";
// read as the prompt and the guardrails read it
const dealerNameOf = (facts: RewriteFacts): string => String((isRecord(facts.dealer) && facts.dealer.name) || '').trim();

// The guardrails want a vehicle-shaped object; the facts are that object minus the VIN.
function guardrailContext(facts: RewriteFacts): GuardrailContext {
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
    dealer: isRecord(facts.dealer) ? facts.dealer : {},
    salesperson: isRecord(facts.salesperson) ? facts.salesperson : {}, // the role the sign-off must state
    priceNote: typeof facts.priceNote === 'string' ? facts.priceNote : '',
  };
}

// A draft cut off at max_tokens (600, several times the 120-word limit)
// always fails the too-long check, so it needs no flag of its own.
interface Draft {
  text: string;
  refused: boolean;
  cost: number;
  model: string;
}

async function draft(facts: RewriteFacts, fixes: string[], who: Who, service: SupabaseClient, clock: Clock): Promise<Draft> {
  const { system, user } = buildRewritePrompt(facts, fixes);
  const response = await callAnthropic({
    model: config.model,
    max_tokens: 600,
    system,
    messages: [{ role: 'user', content: user }],
  }, clock);
  const model = response.model || config.model;
  const cost = await recordUsage(service, who, 'rewrite', model, response.usage || {});
  if (response.stop_reason === 'refusal') return { text: '', refused: true, cost, model };
  return { text: textOf(response), refused: false, cost, model };
}

interface RewriteAnswer {
  ok: boolean;
  text: string;
  model: string;
  guardrails: GuardrailResult;
  costUsd: number;
  error: string;
}

async function rewrite(facts: RewriteFacts, who: Who, service: SupabaseClient, clock: Clock): Promise<RewriteAnswer> {
  const ctx = guardrailContext(facts);
  let d = await draft(facts, [], who, service, clock);
  let g = runGuardrails(d.text, ctx);
  let cost = d.cost;
  let tries = 1;
  if (!g.ok && !d.refused && clock.roomFor()) {
    // regenerate once with the problems spelled out, then give up (the extension falls back to its template)
    d = await draft(facts, g.problems.map((p) => p.text), who, service, clock);
    g = runGuardrails(d.text, ctx);
    cost += d.cost;
    tries = 2;
  }
  return {
    ok: g.ok,
    text: d.text,
    model: d.model,
    guardrails: g,
    costUsd: Number(cost.toFixed(5)),
    error: g.ok ? '' : d.refused ? 'the model declined this request' : tries === 2 ? 'the draft failed the checks twice' : 'the draft failed the checks, and there was no time for a second one',
  };
}

// ---------- /color ----------

// Colors from the photos, for cars whose website record gives no usable
// color. Claude looks at up to four photo URLs and picks from the list.
const COLOR_MAX_PHOTOS = 4;
const DEFAULT_COLORS = ['Black', 'Blue', 'Brown', 'Gold', 'Green', 'Gray', 'Pink', 'Purple', 'Red', 'Silver', 'Orange', 'White', 'Yellow', 'Charcoal', 'Tan', 'Beige', 'Burgundy', 'Turquoise', 'Off white'];

type ColorAnswer =
  | { ok: true; exterior: string; interior: string; confidence: string; model: string; costUsd: number }
  | { ok: false; error: string; costUsd: number };

async function guessColors(photos: string[], options: string[], who: Who, service: SupabaseClient, clock: Clock): Promise<ColorAnswer> {
  const content: Array<Record<string, unknown>> = photos.slice(0, COLOR_MAX_PHOTOS).map((url) => ({ type: 'image', source: { type: 'url', url } }));
  content.push({
    type: 'text',
    text: `These are a car dealer's photos of one used vehicle. From this list only, pick the exterior paint color and the interior color: ${options.join(', ')}. ` +
      'If no photo shows the interior, answer "unknown" for interior; if the exterior is not clearly visible, answer "unknown". ' +
      'Reply with JSON only, like {"exterior":"Gray","interior":"Black","confidence":"high"} where confidence is high, medium or low.',
  });
  const response = await callAnthropic({ model: config.model, max_tokens: 120, messages: [{ role: 'user', content }] }, clock);
  const model = response.model || config.model;
  const cost = await recordUsage(service, who, 'color', model, response.usage || {});
  if (response.stop_reason === 'refusal') return { ok: false, error: 'the model declined to look at these photos', costUsd: Number(cost.toFixed(5)) };
  const m = /\{[\s\S]*\}/.exec(textOf(response));
  let j: Record<string, unknown> = {};
  try {
    const parsed: unknown = m ? JSON.parse(m[0]) : {};
    j = isRecord(parsed) ? parsed : {};
  } catch {
    return { ok: false, error: 'the model did not answer in the expected form', costUsd: Number(cost.toFixed(5)) };
  }
  const pick = (val: unknown): string => options.find((o) => o.toLowerCase() === String(val || '').trim().toLowerCase()) || '';
  const confidence = ['high', 'medium', 'low'].includes(String(j.confidence)) ? String(j.confidence) : 'low';
  return { ok: true, exterior: pick(j.exterior), interior: pick(j.interior), confidence, model, costUsd: Number(cost.toFixed(5)) };
}

// ---------- the handler ----------

Deno.serve(async (req: Request): Promise<Response> => {
  const clock = clockFor(req);
  if (req.method === 'OPTIONS') return preflight(req);
  const route = routeOf(req);
  const isHealth = req.method === 'GET' && route === 'health';
  if (!isHealth && (req.method !== 'POST' || !['rewrite', 'color'].includes(route))) return json(req, 404, { ok: false, error: 'not found' });

  const auth = await requireUser(req);
  if (!auth.ok) return json(req, auth.status, { ok: false, error: auth.error });
  const { caller } = auth;
  if (!isHealth && !allow(caller.user.id)) return json(req, 429, { ok: false, error: 'too many requests; slow down' });

  let body: unknown = {};
  if (!isHealth) {
    const read = await readJson(req, config.bodyLimit);
    if (!read.ok) return json(req, 400, { ok: false, error: read.error });
    body = read.body;
  }

  let memberships: Membership[];
  try {
    memberships = await membershipsOf(caller.client, caller.user.id);
  } catch (e) {
    return json(req, 500, { ok: false, error: errorMessage(e) });
  }
  if (!memberships.length) return json(req, 403, { ok: false, error: 'your account is not in a dealership yet: redeem an invite code first' });
  // the extension sends the dealer website's `origin` with the facts, which
  // picks the dealership for a person in several (sister stores), compared
  // as /sync compares it; an origin that matches none of their dealerships
  // is refused as /sync refuses it, so a store is never billed or capped
  // for another store's cars. Only a body without an origin (the health
  // route, an older extension) falls back to the first membership.
  const wantedOrigin = isRecord(body) && typeof body.origin === 'string' ? body.origin.trim().replace(/\/+$/, '') : '';
  const membership = wantedOrigin ? memberships.find((m) => m.dealership !== null && sameOrigin(m.dealership.website_origin, wantedOrigin)) : memberships[0];
  if (!membership) return json(req, 403, { ok: false, error: `your account is not a member of the dealership for ${wantedOrigin}` });
  const who: Who = { dealershipId: membership.dealership_id, userId: caller.user.id };

  // The plan next, before the cost cap and the model call: a lapsed
  // dealership gets 402 and nothing is spent on it. The row is read with
  // the caller's own client (a member may read their dealership's row), the
  // way /sync reads it, so the two functions always agree on the state.
  let plan: ReturnType<typeof planOf>;
  try {
    plan = planOf(await subscriptionRowOf(caller.client, who.dealershipId));
  } catch (e) {
    return json(req, 500, { ok: false, error: errorMessage(e) });
  }
  if (plan.state === 'lapsed') return json(req, 402, lapsedAnswer(plan));

  let service: SupabaseClient;
  let spent: number;
  try {
    service = serviceClient();
    spent = await monthSpend(service, who.dealershipId);
  } catch (e) {
    return json(req, 500, { ok: false, error: errorMessage(e) });
  }
  if (isHealth) {
    return json(req, 200, { ok: true, model: config.model, month: monthOf(), usd: Number(spent.toFixed(4)), capUsd: config.monthlyCapUsd, perMinute: config.perMinute, dealership: membership.dealership ? membership.dealership.name : '' });
  }
  if (!config.apiKey) return json(req, 500, { ok: false, error: 'ANTHROPIC_API_KEY is not set on the function' });
  if (spent >= config.monthlyCapUsd) {
    return json(req, 429, { ok: false, error: `monthly cost cap of $${config.monthlyCapUsd} reached for your dealership; descriptions come from the built-in template until next month` });
  }

  try {
    if (route === 'color') {
      const b = isRecord(body) ? body : {};
      const photos = Array.isArray(b.photos) ? b.photos.filter((u): u is string => typeof u === 'string' && /^https:\/\//i.test(u)).slice(0, COLOR_MAX_PHOTOS) : [];
      if (!photos.length) return json(req, 400, { ok: false, error: 'photos are missing (1 to 4 https addresses)' });
      const options = Array.isArray(b.options) && b.options.length ? b.options.map(String).slice(0, 40) : DEFAULT_COLORS;
      const out = await guessColors(photos, options, who, service, clock);
      console.log(`${new Date().toISOString()} color ${photos.length} photo(s) -> ${out.ok ? `${out.exterior || '?'} / ${out.interior || '?'} (${out.confidence})` : out.error} $${out.costUsd} (month $${(spent + out.costUsd).toFixed(2)})`);
      return json(req, 200, out);
    }
    const facts: RewriteFacts = isRecord(body) ? { ...body } : {};
    delete facts.origin; // ours, not a fact about the car
    if (!facts.make || !facts.model) return json(req, 400, { ok: false, error: 'facts are missing (year, make, model, ...)' });
    // every description must name the dealership (the guardrails' no-dealer),
    // so without its name no draft can pass: nothing is asked or paid for
    if (!dealerNameOf(facts)) return json(req, 400, { ok: false, error: NO_DEALER_NAME });
    const out = await rewrite(facts, who, service, clock);
    console.log(`${new Date().toISOString()} rewrite ${facts.year} ${facts.make} ${facts.model} -> ${out.ok ? 'ok' : 'failed checks'} $${out.costUsd} (month $${(spent + out.costUsd).toFixed(2)})`);
    return json(req, 200, out);
  } catch (e) {
    if (e instanceof UpstreamError) return json(req, e.status, { ok: false, error: e.message });
    console.error(e);
    return json(req, 500, { ok: false, error: errorMessage(e) });
  }
});
