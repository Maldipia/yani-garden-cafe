// ── Supabase DB helpers ───────────────────────────────────────────────────
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

// Raw fetch with auth headers
export async function supaFetch(url, opts = {}) {
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

// REST helper: supa(method, table, body, params, preferOverride)
export async function supa(method, table, body, params, preferOverride) {
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

// Fetch a single setting value from DB
export async function getSetting(key) {
  try {
    const r = await supaFetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`);
    if (r.ok && r.data && r.data.length > 0) return r.data[0].value;
  } catch (_) {}
  return null;
}

// Fire-and-forget audit log
export async function auditLog({ orderId, action, actor, oldValue, newValue, details } = {}) {
  try {
    await supaFetch(`${SUPABASE_URL}/rest/v1/order_audit_logs`, {
      method: 'POST',
      headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        order_id:   orderId   || null,
        action:     action    || 'UNKNOWN',
        actor_id:   (actor && actor.userId)      || null,
        actor_name: (actor && actor.displayName) || (actor && actor.role) || null,
        old_value:  oldValue  != null ? String(oldValue)  : null,
        new_value:  newValue  != null ? String(newValue)  : null,
        details:    details   || null,
      })
    });
  } catch (_) {}
}

// No-op stubs (GAS sync removed)
export function logSync() {}
export async function pushToSheets() {}
