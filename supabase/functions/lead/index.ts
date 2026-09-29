// Lot Sync lead function: a demo request from the landing page (PLAN.md M5).
//
//   POST …/lead  { name, dealership, website, email, phone?, message?, company_url? }
//     -> 200 { ok: true }                      stored (or a bot's honeypot: stored nowhere, same answer)
//     -> 400 { ok: false, error, field }       a field is missing or does not look right
//     -> 403 { ok: false, error }              the request did not come from the landing page's origin
//     -> 429 { ok: false, error }              too many from one address, or from everyone, in an hour
//
// No sign-in: visitors are anonymous, so config.toml turns the gateway's token
// check off for this function. What stands in its place: the browser's Origin
// must be one of LEAD_ORIGINS (the landing page's own address; anything else
// gets 403 and no CORS header), a honeypot field, field limits
// (_shared/lead.mjs), a per-address brake in this instance's memory (the
// address is hashed and forgotten within the hour) and a table-wide cap per
// hour, so a flood cannot fill the table. The row is written with the service
// role; no API role can read demo_requests (migrations/0005_leads.sql).

import { readJson, isRecord, errorMessage } from '../_shared/http.ts';
import { serviceClient, env } from '../_shared/auth.ts';
import { validateLead, parseOrigins, originAllowed, PER_ADDRESS_PER_HOUR, PER_HOUR_TOTAL } from '../_shared/lead.mjs';

const BODY_LIMIT = 16 * 1024;
const HOUR = 3600_000;

function cors(origin: string, allowed: string[]): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (originAllowed(origin, allowed)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function answer(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}

// ---------- per-address brake (this instance only) ----------

const recent = new Map<string, number[]>();
async function addressKey(req: Request): Promise<string> {
  const raw = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(digest).slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}
function allow(key: string): boolean {
  const now = Date.now();
  const list = (recent.get(key) || []).filter((t) => now - t < HOUR);
  if (list.length >= PER_ADDRESS_PER_HOUR) return false;
  list.push(now);
  recent.set(key, list);
  if (recent.size > 5000) {
    for (const [k, v] of recent) if (!v.some((t) => now - t < HOUR)) recent.delete(k);
  }
  return true;
}

// ---------- the handler ----------

Deno.serve(async (req: Request): Promise<Response> => {
  const allowed = parseOrigins(env('LEAD_ORIGINS'));
  const origin = req.headers.get('origin') || '';
  const headers = cors(origin, allowed);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') return answer(405, { ok: false, error: 'POST only' }, headers);
  if (!originAllowed(origin, allowed)) return answer(403, { ok: false, error: 'demo requests come from the Lot Sync website only' }, headers);
  if (!allow(await addressKey(req))) return answer(429, { ok: false, error: 'too many requests from here; please try again in an hour or email us' }, headers);

  const read = await readJson(req, BODY_LIMIT);
  if (!read.ok) return answer(400, { ok: false, error: read.error, field: '' }, headers);
  const checked = validateLead(isRecord(read.body) ? read.body : null);
  if (!checked.ok) return answer(400, { ok: false, error: checked.error, field: checked.field }, headers);
  if (checked.bot) return answer(200, { ok: true }, headers);

  try {
    const service = serviceClient();
    const since = new Date(Date.now() - HOUR).toISOString();
    const { count, error: countError } = await service.from('demo_requests').select('id', { count: 'exact', head: true }).gte('received_at', since);
    if (countError) throw new Error(countError.message);
    if ((count ?? 0) >= PER_HOUR_TOTAL) return answer(429, { ok: false, error: 'we are receiving a lot of requests right now; please email us instead' }, headers);
    const lead = checked.lead;
    const { error } = await service.from('demo_requests').insert({
      name: lead.name, dealership: lead.dealership, website: lead.website, email: lead.email,
      phone: lead.phone || null, message: lead.message || null, page_origin: origin,
    });
    if (error) throw new Error(error.message);
    return answer(200, { ok: true }, headers);
  } catch (e) {
    console.error('lead: ' + errorMessage(e));
    return answer(500, { ok: false, error: 'the request could not be saved; please email us instead' }, headers);
  }
});
