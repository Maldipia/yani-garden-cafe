// ══════════════════════════════════════════════════════════════════════
// lib/supabase.js — Shared Supabase client for all YANI API routes
// Single source of truth for Supabase URL and key.
// ══════════════════════════════════════════════════════════════════════

export const SUPABASE_URL = 'https://hnynvclpvfxzlfjphefj.supabase.co';

// Service role key — loaded from env only. No hardcoded fallback.
// If missing, the function will fail loudly rather than silently
// downgrading to the anon key.
export function getSupabaseKey() {
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!key) throw new Error('SUPABASE_SECRET_KEY environment variable is not set');
  return key;
}

// The public anon key is safe to expose in client-side code.
// It is used ONLY for public-facing endpoints (online-order, upload-proof)
// where the user is not authenticated.
export const SUPABASE_ANON_KEY = 'sb_publishable_PQBb1nDY7U7SxNfgDYoXyg_GtoLowLM';

// ── Supabase REST helper (uses service role key by default) ──────────────
export async function supa(method, table, body, params, preferOverride, key) {
  const SUPABASE_KEY = key || getSupabaseKey();
  let url = `${SUPABASE_URL}/rest/v1/${table}`;
  if (params) {
    const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    url += '?' + qs;
  }
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': preferOverride || (method === 'POST' ? 'return=representation' : 'return=minimal'),
  };
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(url, opts);
  const text = await resp.text();
  try { return { ok: resp.ok, status: resp.status, data: JSON.parse(text) }; }
  catch { return { ok: resp.ok, status: resp.status, data: text }; }
}

// ── Raw Supabase fetch (for complex queries with URL-level filters) ───────
export async function supaFetch(url, opts = {}, key) {
  const SUPABASE_KEY = key || getSupabaseKey();
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...opts.headers,
  };
  const resp = await fetch(url, { ...opts, headers });
  const text = await resp.text();
  try { return { ok: resp.ok, status: resp.status, data: JSON.parse(text) }; }
  catch { return { ok: resp.ok, status: resp.status, data: text }; }
}
