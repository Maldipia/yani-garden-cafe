// ── In-memory caches + rate limiter ──────────────────────────────────────
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

// ── Menu cache (15-min TTL, 1-min admin TTL, stale-while-valid fallback) ──
export const menuCache = { public: null, admin: null, tsPublic: 0, tsAdmin: 0 };
export const MENU_CACHE_TTL       = 15 * 60 * 1000;
export const MENU_CACHE_TTL_ADMIN =  1 * 60 * 1000;
export function invalidateMenuCache() {
  menuCache.public = null; menuCache.admin = null;
  menuCache.tsPublic = 0; menuCache.tsAdmin = 0;
}

// ── Settings cache (2-min TTL) ────────────────────────────────────────────
export const _settingsCache = { data: null, ts: 0 };
export const SETTINGS_CACHE_TTL = 2 * 60 * 1000;
export function invalidateSettingsCache() { _settingsCache.data = null; _settingsCache.ts = 0; }

// ── Permission cache (5-min TTL) ──────────────────────────────────────────
let _permCache = null;
let _permCacheAt = 0;
export async function getRolePermissions() {
  if (_permCache && Date.now() - _permCacheAt < 5 * 60 * 1000) return _permCache;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/role_permissions?select=action,roles`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    if (r.ok) {
      const rows = await r.json();
      if (Array.isArray(rows) && rows.length > 0) {
        _permCache = Object.fromEntries(rows.map(row => [row.action, row.roles]));
        _permCacheAt = Date.now();
        return _permCache;
      }
    }
  } catch(e) { console.warn('Permission table unavailable:', e.message); }
  return null;
}

// ── Rate limiter (60 req/min per IP, Supabase-backed, falls open) ─────────
const RATE_LIMIT    = 60;
const RATE_WINDOW_S = 60;
export async function checkRateLimit(ip) {
  if (Math.random() < 0.01) {
    fetch(`${SUPABASE_URL}/rest/v1/rpc/cleanup_old_rate_limits`, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }).catch(() => {});
  }
  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(ip);
    const hashBuf = await crypto.subtle.digest('SHA-256', data);
    const ipKey = Array.from(new Uint8Array(hashBuf))
      .map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/upsert_rate_limit`, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_key: ipKey, p_window: RATE_WINDOW_S, p_limit: RATE_LIMIT }),
    });
    if (!r.ok) return true;
    const result = await r.json();
    return result !== false;
  } catch { return true; }
}
