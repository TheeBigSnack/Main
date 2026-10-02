// HTTP helpers shared by the Edge Functions: CORS for the extension's
// origin, JSON answers, a bounded JSON body reader, the route name, and the
// comparison that picks a caller's dealership by its website origin.

// Chrome sends Origin: chrome-extension://<id> for the extension's own
// requests. Those are always allowed; any other page origin is listed in the
// ALLOWED_ORIGINS secret, comma separated: the hosted manager view's, whose
// Billing card calls the billing function from the browser (without it the
// card cannot load; scripts/check-deploy.mjs checks it with
// LOTSYNC_MANAGER_ORIGIN), and a local manager page during development. A request from anywhere else gets no CORS header and the
// browser refuses to show it the answer. The token check is the real
// protection; this only keeps random pages from probing the functions.
const EXTENSION_ORIGIN = /^(chrome|moz)-extension:\/\/[a-z0-9-]+$/i;

function allowedOrigin(origin: string): boolean {
  if (!origin) return false;
  if (EXTENSION_ORIGIN.test(origin)) return true;
  const extra = (Deno.env.get('ALLOWED_ORIGINS') || '').split(',').map((s) => s.trim()).filter(Boolean);
  return extra.includes(origin);
}

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') || '';
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (allowedOrigin(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

export function json(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } });
}

export function preflight(req: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}

export type JsonBody = { ok: true; body: unknown } | { ok: false; error: string };

export async function readJson(req: Request, limit: number): Promise<JsonBody> {
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared > limit) return { ok: false, error: 'request too large' };
  let text = '';
  try {
    text = await req.text();
  } catch {
    return { ok: false, error: 'could not read the request' };
  }
  if (text.length > limit) return { ok: false, error: 'request too large' };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: 'bad JSON: ' + errorMessage(e) };
  }
}

// The last path segment: /functions/v1/rewrite/color -> color,
// /functions/v1/rewrite -> rewrite.
export function routeOf(req: Request): string {
  const parts = new URL(req.url).pathname.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

// The dealer website's origin the extension keys everything by
// (posted:<origin>, settings:<origin>), compared without surrounding spaces,
// trailing slashes or case, so a website_origin the owner typed with a
// slash or a capital letter still matches. Both /sync and /rewrite pick
// the caller's dealership with this, so they always agree on which one.
export function sameOrigin(a: string, b: string): boolean {
  const fold = (s: string): string => s.trim().replace(/\/+$/, '').toLowerCase();
  return fold(a) === fold(b);
}

export const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
