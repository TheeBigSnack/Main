// Who is calling: the Supabase user behind the Bearer token, which
// dealerships they belong to, and where a dealership stands with billing
// (its subscriptions row). Every function starts here.
//
// The caller's own client (anon key + their token) is what the functions
// read and write with, so row-level security decides what they can touch.
// The service-role client exists for one job, the rewrite function's usage
// log, and is created only inside the function process; the key is a
// function secret and never reaches a browser.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { isRecord } from './http.ts';

export interface CallerUser {
  id: string;
  email: string | null;
}

export interface Caller {
  user: CallerUser;
  token: string;
  client: SupabaseClient;
}

export interface Dealership {
  id: string;
  name: string;
  website_origin: string;
}

export interface Membership {
  dealership_id: string;
  role: string;
  name: string | null;
  dealership: Dealership | null;
}

export function env(name: string, fallback = ''): string {
  const v = Deno.env.get(name);
  return v === undefined || v === '' ? fallback : v;
}

const clientOptions = (token?: string) => ({
  ...(token ? { global: { headers: { Authorization: `Bearer ${token}` } } } : {}),
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

export type AuthResult = { ok: true; caller: Caller } | { ok: false; status: number; error: string };

// 401 without a user. The token is checked with the auth server
// (auth.getUser), not just decoded, so a revoked or expired one is refused.
export async function requireUser(req: Request): Promise<AuthResult> {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') || '');
  if (!m) return { ok: false, status: 401, error: 'sign in to use this (no token was sent)' };
  const token = m[1].trim();
  const url = env('SUPABASE_URL');
  const anon = env('SUPABASE_ANON_KEY');
  if (!url || !anon) return { ok: false, status: 500, error: 'the function is missing SUPABASE_URL or SUPABASE_ANON_KEY' };
  const client = createClient(url, anon, clientOptions(token));
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) return { ok: false, status: 401, error: 'sign in again (the token was rejected or has expired)' };
  return { ok: true, caller: { user: { id: data.user.id, email: data.user.email ?? null }, token, client } };
}

// The caller's memberships with their dealerships, through the caller's own
// client (a user reads their own membership rows; members read their
// dealership). Empty when the person has not redeemed an invite yet.
export async function membershipsOf(client: SupabaseClient, userId: string): Promise<Membership[]> {
  const { data, error } = await client
    .from('memberships')
    .select('dealership_id, role, name, dealerships ( id, name, website_origin )')
    .eq('user_id', userId);
  if (error) throw new Error('could not read memberships: ' + error.message);
  const rows: unknown[] = Array.isArray(data) ? data : [];
  return rows.map((row) => {
    const r = isRecord(row) ? row : {};
    const raw = Array.isArray(r.dealerships) ? r.dealerships[0] : r.dealerships;
    const d = isRecord(raw) ? raw : null;
    return {
      dealership_id: String(r.dealership_id ?? ''),
      role: String(r.role ?? ''),
      name: typeof r.name === 'string' ? r.name : null,
      dealership: d ? { id: String(d.id ?? ''), name: String(d.name ?? ''), website_origin: String(d.website_origin ?? '') } : null,
    };
  });
}

export type SubscriptionRow = Record<string, unknown>;

// The dealership's subscriptions row (migrations/0004_billing.sql), or null
// when it has none yet, through the caller's own client: a member may read
// their dealership's row and nobody else's, so no service-role key is
// needed to learn the plan. /sync and /rewrite read it first and refuse a
// lapsed dealership (402) before doing anything else; the billing function
// reads it with the service role because it also writes it.
export async function subscriptionRowOf(client: SupabaseClient, dealershipId: string): Promise<SubscriptionRow | null> {
  const { data, error } = await client.from('subscriptions').select('*').eq('dealership_id', dealershipId).maybeSingle();
  if (error) throw new Error('could not read subscriptions: ' + error.message);
  return isRecord(data) ? data : null;
}

// Bypasses row-level security. Only for the usage log, only in here.
export function serviceClient(): SupabaseClient {
  const url = env('SUPABASE_URL');
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('the function is missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key, clientOptions());
}
