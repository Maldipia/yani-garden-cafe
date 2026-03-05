// ══════════════════════════════════════════════════════════════
// YANI POS — Vercel Serverless API Proxy  (v2 — hardened)
// Forwards requests from frontend → Apps Script (server-to-server)
// Handles Apps Script's 302 redirect behavior
//
// DUAL-WRITE: addMenuItem / updateMenuItem / deleteMenuItem also
// sync to Supabase so both dine-in POS (GAS/Sheets) and the
// online order page (Supabase) stay in sync automatically.
//
// HARDENING (v2):
//   • Rate limiting: 60 req/min per IP (in-memory, resets per instance)
//   • Input validation on all menu mutation actions
//   • GAS requests include X-YGC-Secret header for auth
// ══════════════════════════════════════════════════════════════

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzprf6_LpDwcVujm8kcGFZE5JdkL0k9b6Wfg5l82gjZzFua8w1QWH8UoFFlhznc6EtL/exec';

// ── Manila timezone offset ────────────────────────────────────────────────
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000; // UTC+8

/**
 * Normalize a timestamp from GAS to a Manila-timezone ISO string.
 *
 * Two cases:
 *   1. GAS already returns a Manila ISO string with explicit offset (e.g. "2026-03-05T10:46:43+08:00")
 *      — this happens when the GAS is deployed with Utilities.formatDate.
 *      Pass it through unchanged (idempotent).
 *   2. GAS returns a bare UTC ISO string (e.g. "2026-03-05T02:46:43.000Z")
 *      — this happens with the old GAS code where getValue() serializes as UTC.
 *      Add 8 hours to convert to Manila time.
 *
 * The key: if the raw string already contains an explicit offset (+HH:MM or -HH:MM),
 * do NOT add 8 hours again.
 */
function toManilaIso(ts) {
  if (!ts) return ts;
  try {
    const str = String(ts);
    // If the timestamp already has an explicit timezone offset, it is already Manila time
    // from GAS Utilities.formatDate — return as-is to avoid double-offset.
    if (/[+-]\d{2}:\d{2}$/.test(str)) return str;
    // Bare UTC ISO (ends with Z or has no offset) — add 8h to get Manila time.
    const d = new Date(str);
    if (isNaN(d.getTime())) return ts;
    const manila = new Date(d.getTime() + MANILA_OFFSET_MS);
    const pad = (n) => String(n).padStart(2, '0');
    return `${manila.getUTCFullYear()}-${pad(manila.getUTCMonth()+1)}-${pad(manila.getUTCDate())}T${pad(manila.getUTCHours())}:${pad(manila.getUTCMinutes())}:${pad(manila.getUTCSeconds())}+08:00`;
  } catch (e) {
    return ts;
  }
}

/**
 * Fix timestamps in a GAS getOrders response.
 * Converts all createdAt fields from UTC ISO to Manila ISO strings.
 */
function fixOrderTimestamps(gasResult) {
  if (!gasResult || !gasResult.ok || !Array.isArray(gasResult.orders)) return gasResult;
  gasResult.orders = gasResult.orders.map(o => {
    if (o.createdAt) o.createdAt = toManilaIso(o.createdAt);
    return o;
  });
  return gasResult;
}

const SUPABASE_URL = 'https://hnynvclpvfxzlfjphefj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_ANON_KEY || 'sb_publishable_PQBb1nDY7U7SxNfgDYoXyg_GtoLowLM';

// GAS shared secret — set GAS_SECRET env var in Vercel AND in Code.gs
// If not set, falls back to no-auth (backwards compatible)
const GAS_SECRET = process.env.GAS_SECRET || null;

// ── In-memory rate limiter (per IP, 60 req/min) ───────────────────────────
const rateLimitMap = new Map();
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, windowStart: now };
  if (now - entry.windowStart > RATE_WINDOW_MS) {
    entry.count = 1;
    entry.windowStart = now;
  } else {
    entry.count++;
  }
  rateLimitMap.set(ip, entry);
  // Clean up old entries every 1000 requests to prevent memory leak
  if (rateLimitMap.size > 1000) {
    for (const [k, v] of rateLimitMap) {
      if (now - v.windowStart > RATE_WINDOW_MS) rateLimitMap.delete(k);
    }
  }
  return entry.count <= RATE_LIMIT;
}

// ── Input validation helpers ──────────────────────────────────────────────
function isNonEmptyString(v, maxLen = 200) {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= maxLen;
}
function isValidPrice(v) {
  return v === null || v === undefined || (typeof v === 'number' && v >= 0 && v < 100000);
}
function isValidItemCode(v) {
  return typeof v === 'string' && /^[A-Z0-9_]{2,40}$/i.test(v);
}

function validateMenuPayload(body, requireItemId = false) {
  const errors = [];
  if (requireItemId && !isValidItemCode(body.itemId)) {
    errors.push('itemId must be a valid item code (letters, digits, underscores, 2-40 chars)');
  }
  if (body.name !== undefined && !isNonEmptyString(body.name, 100)) {
    errors.push('name must be a non-empty string (max 100 chars)');
  }
  if (body.price !== undefined && !isValidPrice(Number(body.price))) {
    errors.push('price must be a non-negative number under 100000');
  }
  if (body.priceShort  !== undefined && body.priceShort  !== null && !isValidPrice(Number(body.priceShort)))  errors.push('priceShort invalid');
  if (body.priceMedium !== undefined && body.priceMedium !== null && !isValidPrice(Number(body.priceMedium))) errors.push('priceMedium invalid');
  if (body.priceTall   !== undefined && body.priceTall   !== null && !isValidPrice(Number(body.priceTall)))   errors.push('priceTall invalid');
  if (body.status !== undefined && !['ACTIVE', 'INACTIVE'].includes(String(body.status).toUpperCase())) {
    errors.push('status must be ACTIVE or INACTIVE');
  }
  return errors;
}

// ── Category name → Supabase UUID map ─────────────────────────────────────
const CATEGORY_MAP = {
  'COLD BEVERAGE': 'dc95fd8d-ba61-4171-90aa-3707fbb4bdf5',
  'COFFEE':        'ba50e0a2-b99a-4481-800d-c8e962d95b43',
  'PASTRY':        '228b02da-1a81-46e4-aae2-794b5c88a990',
  'SODA':          'd0fb0824-2b84-4889-9441-eeeaee11cd51',
  'FOOD':          '4a072720-dc18-4065-9aa9-d8437bf01038',
};

function getCategoryId(categoryName) {
  if (!categoryName) return null;
  return CATEGORY_MAP[String(categoryName).trim().toUpperCase()] || null;
}

// ── Supabase helper ────────────────────────────────────────────────────────
async function supabaseRequest(method, table, body, params, preferOverride) {
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

// ── Sync helpers ──────────────────────────────────────────────────────────
async function syncAddToSupabase(payload, gasItemId) {
  try {
    const row = {
      item_code:        gasItemId || payload.itemId || null,
      name:             payload.name,
      category_id:      getCategoryId(payload.category),
      base_price:       parseFloat(payload.price) || 0,
      has_sizes:        !!payload.hasSizes,
      has_sugar_levels: !!payload.hasSugar,
      price_short:      parseFloat(payload.priceShort) || null,
      price_medium:     parseFloat(payload.priceMedium) || null,
      price_tall:       parseFloat(payload.priceTall) || null,
      image_path:       payload.image || null,
      is_active:        (payload.status || 'ACTIVE').toUpperCase() === 'ACTIVE',
    };
    const result = await supabaseRequest('POST', 'menu_items', row);
    if (!result.ok) console.warn('Supabase addMenuItem sync failed:', result.status, JSON.stringify(result.data));
    return result;
  } catch (e) {
    console.warn('Supabase addMenuItem sync error:', e.message);
    return { ok: false };
  }
}

async function syncUpdateToSupabase(payload) {
  try {
    const itemCode = payload.itemId;
    if (!itemCode) return;
    const updates = {};
    if (payload.name      !== undefined) updates.name             = payload.name;
    if (payload.category  !== undefined) updates.category_id      = getCategoryId(payload.category);
    if (payload.price     !== undefined) updates.base_price        = parseFloat(payload.price) || 0;
    if (payload.hasSizes  !== undefined) updates.has_sizes         = !!payload.hasSizes;
    if (payload.hasSugar  !== undefined) updates.has_sugar_levels  = !!payload.hasSugar;
    if (payload.priceShort  !== undefined) updates.price_short     = parseFloat(payload.priceShort) || null;
    if (payload.priceMedium !== undefined) updates.price_medium    = parseFloat(payload.priceMedium) || null;
    if (payload.priceTall   !== undefined) updates.price_tall      = parseFloat(payload.priceTall) || null;
    if (payload.image     !== undefined) updates.image_path        = payload.image || null;
    if (payload.status    !== undefined) updates.is_active         = (payload.status || 'ACTIVE').toUpperCase() === 'ACTIVE';
    if (Object.keys(updates).length === 0) return;
    const result = await supabaseRequest('PATCH', 'menu_items', updates, { item_code: `eq.${itemCode}` });
    if (!result.ok) console.warn('Supabase updateMenuItem sync failed:', result.status, JSON.stringify(result.data));
    return result;
  } catch (e) {
    console.warn('Supabase updateMenuItem sync error:', e.message);
    return { ok: false };
  }
}

async function syncDeleteToSupabase(itemCode) {
  try {
    if (!itemCode) return;
    const result = await supabaseRequest('PATCH', 'menu_items', { is_active: false }, { item_code: `eq.${itemCode}` });
    if (!result.ok) console.warn('Supabase deleteMenuItem sync failed:', result.status, JSON.stringify(result.data));
    return result;
  } catch (e) {
    console.warn('Supabase deleteMenuItem sync error:', e.message);
    return { ok: false };
  }
}

// ── Forward request to Apps Script ────────────────────────────────────────
async function callAppsScript(body) {
  const headers = { 'Content-Type': 'application/json' };
  if (GAS_SECRET) headers['X-YGC-Secret'] = GAS_SECRET;

  const postResponse = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    redirect: 'manual'
  });

  let responseText;
  if (postResponse.status === 302 || postResponse.status === 301) {
    const redirectUrl = postResponse.headers.get('location');
    if (!redirectUrl) throw new Error('Backend redirect missing location');
    const getResponse = await fetch(redirectUrl, { method: 'GET', redirect: 'follow' });
    responseText = await getResponse.text();
  } else {
    responseText = await postResponse.text();
  }

  try {
    return JSON.parse(responseText);
  } catch (e) {
    console.error('Apps Script returned non-JSON:', responseText.substring(0, 300));
    throw new Error('Backend returned invalid response');
  }
}

// ── Main handler ──────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  // ── Rate limiting ────────────────────────────────────────────────────────
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ ok: false, error: 'Too many requests. Please wait a moment.' });
  }

  try {
    const body = req.body;
    if (!body || !body.action) return res.status(400).json({ ok: false, error: 'Missing action' });

    const action = String(body.action).trim();

    // ── Validate action name (prevent injection) ──────────────────────────
    if (!/^[a-zA-Z][a-zA-Z0-9_]{1,60}$/.test(action)) {
      return res.status(400).json({ ok: false, error: 'Invalid action name' });
    }

    // ── Input validation for menu mutations ───────────────────────────────
    if (action === 'addMenuItem') {
      if (!isNonEmptyString(body.name, 100)) {
        return res.status(400).json({ ok: false, error: 'name is required and must be under 100 chars' });
      }
      const errs = validateMenuPayload(body, false);
      if (errs.length) return res.status(400).json({ ok: false, error: errs.join('; ') });
    }

    if (action === 'updateMenuItem') {
      if (!isValidItemCode(body.itemId)) {
        return res.status(400).json({ ok: false, error: 'itemId is required and must be a valid item code' });
      }
      const errs = validateMenuPayload(body, false);
      if (errs.length) return res.status(400).json({ ok: false, error: errs.join('; ') });
    }

    if (action === 'deleteMenuItem') {
      if (!isValidItemCode(body.itemId)) {
        return res.status(400).json({ ok: false, error: 'itemId is required and must be a valid item code' });
      }
    }

    // ── Special: direct Supabase upsert (for backfilling existing GAS items) ─
    if (action === 'upsertToSupabase') {
      if (!isValidItemCode(body.itemId)) {
        return res.status(400).json({ ok: false, error: 'itemId is required' });
      }
      const categoryId = getCategoryId(body.category);
      const row = {
        item_code:        body.itemId,
        name:             body.name,
        category_id:      categoryId,
        base_price:       parseFloat(body.price) || 0,
        has_sizes:        !!body.hasSizes,
        has_sugar_levels: !!body.hasSugar,
        price_short:      parseFloat(body.priceShort) || null,
        price_medium:     parseFloat(body.priceMedium) || null,
        price_tall:       parseFloat(body.priceTall) || null,
        image_path:       body.image || null,
        is_active:        (body.status || 'ACTIVE').toUpperCase() === 'ACTIVE',
      };
      const result = await supabaseRequest('POST', 'menu_items', row, null, 'resolution=merge-duplicates');
      return res.status(200).json({ ok: result.ok, data: result.data });
    }

    // ── Forward to Apps Script ────────────────────────────────────────────
    let gasResult;
    try {
      gasResult = await callAppsScript(body);
    } catch (err) {
      console.error('GAS call failed for action:', action, err.message);
      return res.status(502).json({ ok: false, error: 'Backend unavailable: ' + err.message });
    }

    // ── Dual-write: sync menu changes to Supabase ─────────────────────────
    if (gasResult && gasResult.ok) {
      if (action === 'addMenuItem') {
        const gasItemId = gasResult.itemId || body.itemId || null;
        syncAddToSupabase(body, gasItemId).catch(() => {});
      } else if (action === 'updateMenuItem') {
        syncUpdateToSupabase(body).catch(() => {});
      } else if (action === 'deleteMenuItem') {
        syncDeleteToSupabase(body.itemId).catch(() => {});
      }
    }

     // ── Fix timestamps: normalize GAS UTC ISO dates to Manila +08:00 ────────────
    if (action === 'getOrders') {
      fixOrderTimestamps(gasResult);
    }
    return res.status(200).json(gasResult);
  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(500).json({ ok: false, error: 'Server error: ' + err.message });
  }
}
