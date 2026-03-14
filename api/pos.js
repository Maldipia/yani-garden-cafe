// YANI POS — Vercel Serverless API  (v4 — hardened)
// ══════════════════════════════════════════════════════════════════════
// All actions handled directly in Supabase. GAS-free.
// Write endpoints require ADMIN or OWNER role (userId in request body).
// CORS restricted to known domains. No hardcoded key fallbacks.
// ══════════════════════════════════════════════════════════════════════

import bcrypt from 'bcryptjs';
const SUPABASE_URL  = 'https://hnynvclpvfxzlfjphefj.supabase.co';
const RESEND_KEY    = process.env.RESEND_API_KEY || '';
const FROM_EMAIL    = 'onboarding@resend.dev';  // upgrade to branded domain when DNS ready
const BUSINESS_NAME = 'Yani Garden Cafe';
// Service role key — loaded from env only. No hardcoded fallback.
const SUPABASE_KEY = (() => {
  const k = process.env.SUPABASE_SECRET_KEY;
  if (!k) throw new Error('SUPABASE_SECRET_KEY env var is not set');
  return k;
})();

const SERVICE_CHARGE_RATE = 0.10;
const ORDER_PREFIX = 'YANI';

// ── Fetch a single setting value from DB ───────────────────────────────────
async function getSetting(key) {
  try {
    const r = await supaFetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`);
    if (r.ok && r.data && r.data.length > 0) return r.data[0].value;
  } catch (_) {}
  return null;
}

// ── Audit logger — fire-and-forget, never throws ──────────────────────────
// Inserts a row into order_audit_logs. Called after every mutating action.
// actor: { userId, role, displayName }   (all optional)
// meta:  { orderId, action, oldValue, newValue, details:{} }
async function auditLog({ orderId, action, actor, oldValue, newValue, details } = {}) {
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
  } catch (_) { /* never block the main action */ }
}

// ── Receipt email sender ───────────────────────────────────────────────────
function buildReceiptHTML({ order, items, isBIR }) {
  const fmt = (n) => `₱${parseFloat(n||0).toFixed(2)}`;
  const phTime = new Date(order.created_at || Date.now())
    .toLocaleString('en-PH', { timeZone:'Asia/Manila', dateStyle:'medium', timeStyle:'short' });

  const itemRows = (items || []).map(it => {
    const sub = [];
    if (it.size_choice)  sub.push(it.size_choice);
    if (it.sugar_choice) sub.push(it.sugar_choice);
    const subLine = sub.length ? `<div style="font-size:11px;color:#888">${sub.join(' · ')}</div>` : '';
    return `
      <tr>
        <td style="padding:6px 0;border-bottom:1px solid #f0f0f0">
          <div style="font-weight:600">${it.item_name}</div>${subLine}
        </td>
        <td style="padding:6px 0;border-bottom:1px solid #f0f0f0;text-align:center">${it.qty}</td>
        <td style="padding:6px 0;border-bottom:1px solid #f0f0f0;text-align:right">${fmt(it.unit_price)}</td>
        <td style="padding:6px 0;border-bottom:1px solid #f0f0f0;text-align:right">${fmt(it.line_total)}</td>
      </tr>`;
  }).join('');

  const discountRow = (order.discount_amount > 0) ? `
    <tr>
      <td colspan="2" style="text-align:right;padding:4px 0;font-size:13px">
        ${order.discount_type || 'Discount'}${order.discount_pax > 0 ? ` (${order.discount_pax} pax)` : ''}:
      </td>
      <td colspan="2" style="text-align:right;padding:4px 0;font-size:13px;color:#DC2626">
        -${fmt(order.discount_amount)}
      </td>
    </tr>
    <tr>
      <td colspan="2" style="text-align:right;padding:4px 0;font-weight:700">TOTAL PAID:</td>
      <td colspan="2" style="text-align:right;padding:4px 0;font-weight:700">${fmt(order.discounted_total || order.total)}</td>
    </tr>` : `
    <tr>
      <td colspan="2" style="text-align:right;padding:4px 0;font-weight:700">TOTAL:</td>
      <td colspan="2" style="text-align:right;padding:4px 0;font-weight:700">${fmt(order.total)}</td>
    </tr>`;

  const vatLine = order.vat_amount > 0 ? `
    <tr>
      <td colspan="2" style="text-align:right;padding:2px 0;font-size:12px;color:#888">VAT (incl.):</td>
      <td colspan="2" style="text-align:right;padding:2px 0;font-size:12px;color:#888">${fmt(order.vat_amount)}</td>
    </tr>` : `<tr><td colspan="4" style="text-align:right;padding:2px 0;font-size:11px;color:#aaa">This is a Non-VAT receipt</td></tr>`;

  const birSection = isBIR && order.receipt_name ? `
    <div style="background:#f9f9f9;border:1px solid #e5e5e5;border-radius:8px;padding:12px;margin-bottom:16px;font-size:13px">
      <div style="font-weight:700;margin-bottom:6px;color:#374151">Issued to:</div>
      <div>${order.receipt_name}</div>
      ${order.receipt_address ? `<div>${order.receipt_address}</div>` : ''}
      ${order.receipt_tin ? `<div>TIN: ${order.receipt_tin}</div>` : ''}
    </div>` : '';

  const receiptLabel = isBIR ? 'OFFICIAL RECEIPT' : 'SALES INVOICE';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${receiptLabel} - ${order.order_id}</title></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
  <div style="max-width:480px;margin:20px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.12)">
    <!-- Header -->
    <div style="background:#1a3a2a;padding:24px;text-align:center">
      <div style="color:#a3d9a5;font-size:24px;font-weight:800;letter-spacing:1px">${BUSINESS_NAME.toUpperCase()}</div>
      <div style="color:#c8e6c9;font-size:12px;margin-top:4px">Amadeo, Cavite</div>
      <div style="color:#fff;font-size:18px;font-weight:700;margin-top:12px;background:rgba(255,255,255,.15);padding:6px 16px;border-radius:20px;display:inline-block">${receiptLabel}</div>
    </div>
    <!-- Body -->
    <div style="padding:20px">
      <!-- Order meta -->
      <div style="display:flex;justify-content:space-between;font-size:13px;color:#6b7280;margin-bottom:16px;flex-wrap:wrap;gap:8px">
        <div><strong>Order:</strong> ${order.order_id}</div>
        <div><strong>Table:</strong> ${order.table_no || '-'}</div>
        <div><strong>Type:</strong> ${order.order_type || 'DINE-IN'}</div>
        <div><strong>Date:</strong> ${phTime}</div>
      </div>
      ${birSection}
      <!-- Items -->
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="border-bottom:2px solid #e5e7eb">
            <th style="text-align:left;padding:6px 0;color:#374151">Item</th>
            <th style="text-align:center;padding:6px 0;color:#374151">Qty</th>
            <th style="text-align:right;padding:6px 0;color:#374151">Price</th>
            <th style="text-align:right;padding:6px 0;color:#374151">Total</th>
          </tr>
        </thead>
        <tbody>${itemRows}</tbody>
        <tfoot>
          <tr><td colspan="4" style="padding:8px 0"></td></tr>
          <tr>
            <td colspan="2" style="text-align:right;padding:3px 0;font-size:13px;color:#6b7280">Subtotal:</td>
            <td colspan="2" style="text-align:right;padding:3px 0;font-size:13px">${fmt(order.subtotal)}</td>
          </tr>
          <tr>
            <td colspan="2" style="text-align:right;padding:3px 0;font-size:13px;color:#6b7280">Service Charge (10%):</td>
            <td colspan="2" style="text-align:right;padding:3px 0;font-size:13px">${fmt(order.service_charge)}</td>
          </tr>
          ${vatLine}
          ${discountRow}
        </tfoot>
      </table>
      <!-- Footer note -->
      <div style="margin-top:20px;padding-top:16px;border-top:1px dashed #e5e7eb;text-align:center;color:#9ca3af;font-size:12px">
        <div style="margin-bottom:4px">Thank you for visiting ${BUSINESS_NAME}! 🌿</div>
        <div>Please come again ♥</div>
        ${isBIR ? '<div style="margin-top:8px;font-size:11px">This serves as your Official Receipt for tax purposes.</div>' : ''}
      </div>
    </div>
  </div>
</body>
</html>`;
}

async function sendReceiptEmail({ toEmail, order, items, isBIR }) {
  if (!RESEND_KEY) throw new Error('Email service not configured');
  if (!toEmail)   throw new Error('No email address provided');

  const receiptType = isBIR ? 'Official Receipt' : 'Sales Invoice';
  const html = buildReceiptHTML({ order, items, isBIR });

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      from:    `${BUSINESS_NAME} <${FROM_EMAIL}>`,
      to:      [toEmail],
      subject: `Your ${receiptType} — ${order.order_id} | ${BUSINESS_NAME}`,
      html,
    }),
  });
  const result = await resp.json();
  if (!resp.ok) throw new Error(result.message || 'Resend API error');
  return result.id;
}



// ── Supabase-backed rate limiter (per IP, 60 req/min) ─────────────────────
// Persists across Vercel cold starts via api_rate_limits table.
// Falls open (allows request) if Supabase is unreachable — never blocks ops.
const RATE_LIMIT    = 60;
const RATE_WINDOW_S = 60;

async function checkRateLimit(ip) {
  try {
    // Hash IP for privacy — we only need uniqueness, not the real IP
    const encoder = new TextEncoder();
    const data = encoder.encode(ip);
    const hashBuf = await crypto.subtle.digest('SHA-256', data);
    const ipKey = Array.from(new Uint8Array(hashBuf))
      .map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);

    const now   = Math.floor(Date.now() / 1000);
    const winStart = now - RATE_WINDOW_S;

    // Upsert: increment count if same window, else reset
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/upsert_rate_limit`,
      {
        method: 'POST',
        headers: {
          'apikey':        SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({ p_key: ipKey, p_window: RATE_WINDOW_S, p_limit: RATE_LIMIT }),
      }
    );
    if (!r.ok) return true; // fail open
    const result = await r.json();
    return result !== false; // function returns false when over limit
  } catch {
    return true; // fail open — never block real traffic on rate limit errors
  }
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
function isValidOrderId(v) {
  // Must match format: PREFIX-NUMBER e.g. YANI-1001, BRWN-0042
  return typeof v === 'string' && /^[A-Z0-9]{2,10}-\d{1,8}$/.test(v);
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

// ── Category UUID ↔ name maps (from menu_categories table) ──────────────────
const CATEGORY_ID_TO_NAME = {
  '228b02da-1a81-46e4-aae2-794b5c88a990': 'Pastry',
  '069ee74a-350f-467a-86ef-876dd48ced3e': 'Hot',
  '9094c828-1da1-4802-838b-8eb4da3c16be': 'Ice And Ice Blended',
  '098a930f-3789-42fd-b7ca-bd704126ec08': 'Pasta',
  '1b803e7a-c69c-442a-991c-d62c99e6dd11': 'Other',
  '9abfbe5e-3c68-43cb-bed3-4ed5c63380c1': 'Wrap',
  '5297871b-fa2e-4376-bd81-6d9b0c173be8': 'Best With',
};
const CATEGORY_NAME_TO_ID = Object.fromEntries(
  Object.entries(CATEGORY_ID_TO_NAME).map(([id, name]) => [name.toUpperCase(), id])
);

function getCategoryId(categoryName) {
  if (!categoryName) return null;
  return CATEGORY_NAME_TO_ID[String(categoryName).trim().toUpperCase()] || null;
}
function getCategoryName(categoryId) {
  return CATEGORY_ID_TO_NAME[categoryId] || 'Other';
}

// ── Supabase REST helper ───────────────────────────────────────────────────
async function supa(method, table, body, params, preferOverride) {
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

// ── Raw Supabase fetch (for complex queries with filters) ──────────────────
async function supaFetch(url, opts = {}) {
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

// ── PIN verification uses bcrypt (cost 12) — see verifyUserPin handler ──

// ── Log to sheets_sync_log (fire-and-forget) ──────────────────────────────
// ── Sheets write-through sync ──────────────────────────────────────────────
// Fires async, never blocks the response. Requires GAS_SYNC_URL env var.
const GAS_SYNC_URL    = process.env.GAS_SYNC_URL;
const GAS_SYNC_SECRET = process.env.GAS_SYNC_SECRET || 'yani-sync-2026';

async function pushToSheets(action, payload) {
  if (!GAS_SYNC_URL) return; // disabled until env var is set
  try {
    fetch(GAS_SYNC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: GAS_SYNC_SECRET, action, ...payload }),
    }).catch(e => console.warn('Sheets sync error:', e.message));
  } catch (_) {}
}

function logSync(tableName, recordId, action) {
  // Keep legacy sync log entry for audit trail
  supa('POST', 'sheets_sync_log', {
    table_name: tableName,
    record_id: String(recordId),
    action,
    synced: !!GAS_SYNC_URL,
  }).catch(() => {});
}

// ── In-memory menu cache (5-minute TTL) ──────────────────────────────────
const menuCache = { public: null, admin: null, ts: 0 };
const MENU_CACHE_TTL = 5 * 60 * 1000;
function invalidateMenuCache() { menuCache.public = null; menuCache.admin = null; menuCache.ts = 0; }

// ── Admin role guard ──────────────────────────────────────────────────────
// Verifies that body.userId belongs to an active ADMIN or OWNER staff user.
const VALID_USER_ID = /^USR_\d{3,6}$/;

async function requireAuth(body, allowedRoles) {
  const userId = String(body.userId || '').trim();
  if (!userId) return { ok: false, error: 'userId is required for this action' };
  if (!VALID_USER_ID.test(userId)) return { ok: false, error: 'Invalid userId format' };
  const r = await supaFetch(
    `${SUPABASE_URL}/rest/v1/staff_users?user_id=eq.${encodeURIComponent(userId)}&active=eq.true&select=role`
  );
  if (!r.ok || !r.data || !r.data.length) return { ok: false, error: 'Unauthorized: user not found' };
  const role = r.data[0].role;
  if (allowedRoles && allowedRoles.length && !allowedRoles.includes(role)) {
    return { ok: false, error: 'Unauthorized: insufficient role' };
  }
  return { ok: true, role };
}

async function requireAdminRole(body) {
  const userId = String(body.userId || '').trim();
  if (!userId) return { ok: false, error: 'userId is required for this action' };
  if (!VALID_USER_ID.test(userId)) return { ok: false, error: 'Invalid userId format' };
  const r = await supaFetch(
    `${SUPABASE_URL}/rest/v1/staff_users?user_id=eq.${encodeURIComponent(userId)}&active=eq.true&select=role`
  );
  if (!r.ok || !r.data || !r.data.length) return { ok: false, error: 'Unauthorized: user not found' };
  const role = r.data[0].role;
  if (!['ADMIN', 'OWNER'].includes(role)) return { ok: false, error: 'Unauthorized: insufficient role' };
  return { ok: true, role };
}

// ── Main handler ──────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Restrict CORS to known domains only
  const origin = req.headers.origin || '';
  const allowedOrigins = ['https://yanigardencafe.com', 'https://pos.yanigardencafe.com', 'https://admin.yanigardencafe.com'];
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (!origin) {
    res.setHeader('Access-Control-Allow-Origin', 'https://yanigardencafe.com');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (!await checkRateLimit(ip)) {
    return res.status(429).json({ ok: false, error: 'Too many requests. Please wait a moment.' });
  }

  try {
    const body = req.body;
    if (!body || !body.action) return res.status(400).json({ ok: false, error: 'Missing action' });

    const action = String(body.action).trim();
    if (!/^[a-zA-Z][a-zA-Z0-9_]{1,60}$/.test(action)) {
      return res.status(400).json({ ok: false, error: 'Invalid action name' });
    }

    // ══════════════════════════════════════════════════════════════════════
    // MENU ACTIONS
    // ══════════════════════════════════════════════════════════════════════

    // ── getMenu ────────────────────────────────────────────────────────────
    if (action === 'getMenu') {
      const now = Date.now();
      if (menuCache.public && (now - menuCache.ts) < MENU_CACHE_TTL) {
        return res.status(200).json({ ok: true, items: menuCache.public, cached: true });
      }
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/menu_items?is_active=eq.true&order=name.asc&select=item_code,name,base_price,has_sizes,has_sugar_levels,price_short,price_medium,price_tall,image_path,category_id`
      );
      if (!r.ok) return res.status(502).json({ ok: false, error: 'Failed to load menu' });
      const items = r.data.map(m => ({
        code:        m.item_code,
        name:        m.name,
        price:       m.base_price,
        hasSizes:    m.has_sizes,
        hasSugar:    m.has_sugar_levels,
        priceShort:  m.price_short,
        priceMedium: m.price_medium,
        priceTall:   m.price_tall,
        image:       m.image_path || '',
        category:    getCategoryName(m.category_id),
        available:   true,
      }));
      menuCache.public = items;
      menuCache.ts = now;
      return res.status(200).json({ ok: true, items });
    }

    // ── getMenuAdmin ───────────────────────────────────────────────────────
    if (action === 'getMenuAdmin') {
      const authMA = await requireAuth(body);
      if (!authMA.ok) return res.status(403).json({ ok: false, error: authMA.error });
      if (authMA.role === 'KITCHEN') return res.status(403).json({ ok: false, error: 'Kitchen staff cannot access menu admin' });
      const now = Date.now();
      if (menuCache.admin && (now - menuCache.ts) < MENU_CACHE_TTL) {
        return res.status(200).json({ ok: true, items: menuCache.admin, cached: true });
      }
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/menu_items?order=name.asc&select=item_code,name,base_price,has_sizes,has_sugar_levels,price_short,price_medium,price_tall,image_path,category_id,is_active`
      );
      if (!r.ok) return res.status(502).json({ ok: false, error: 'Failed to load menu' });
      const items = r.data.map(m => ({
        code:        m.item_code,
        name:        m.name,
        price:       m.base_price,
        hasSizes:    m.has_sizes,
        hasSugar:    m.has_sugar_levels,
        priceShort:  m.price_short,
        priceMedium: m.price_medium,
        priceTall:   m.price_tall,
        image:       m.image_path || '',
        category:    getCategoryName(m.category_id),
        active:      m.is_active,
        available:   m.is_active,
        status:      m.is_active ? 'ACTIVE' : 'INACTIVE',
      }));
      menuCache.admin = items;
      menuCache.ts = now;
      return res.status(200).json({ ok: true, items });
    }

    // ── addMenuItem ────────────────────────────────────────────────────────
    if (action === 'addMenuItem') {
      const authAdd = await requireAdminRole(body);
      if (!authAdd.ok) return res.status(403).json({ ok: false, error: authAdd.error });
      if (!isNonEmptyString(body.name, 100) || body.name.trim().length < 2) {
        return res.status(400).json({ ok: false, error: 'name must be 2-100 characters' });
      }
      const errs = validateMenuPayload(body, false);
      if (errs.length) return res.status(400).json({ ok: false, error: errs.join('; ') });

      const row = {
        item_code:        body.itemId || null,
        name:             body.name.trim(),
        category_id:      getCategoryId(body.category),
        base_price:       parseFloat(body.price) || 0,
        has_sizes:        !!body.hasSizes,
        has_sugar_levels: !!body.hasSugar,
        price_short:      body.priceShort  != null ? parseFloat(body.priceShort)  : null,
        price_medium:     body.priceMedium != null ? parseFloat(body.priceMedium) : null,
        price_tall:       body.priceTall   != null ? parseFloat(body.priceTall)   : null,
        image_path:       body.image || null,
        is_active:        (body.status || 'ACTIVE').toUpperCase() === 'ACTIVE',
      };
      const r = await supa('POST', 'menu_items', row);
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to add menu item: ' + JSON.stringify(r.data) });
      const newItem = Array.isArray(r.data) ? r.data[0] : r.data;
      invalidateMenuCache();
      logSync('menu_items', newItem?.item_code || body.itemId || 'new', 'INSERT');
      return res.status(200).json({ ok: true, itemId: newItem?.item_code || body.itemId });
    }

    // ── updateMenuItem ─────────────────────────────────────────────────────
    if (action === 'updateMenuItem') {
      const authUpd = await requireAdminRole(body);
      if (!authUpd.ok) return res.status(403).json({ ok: false, error: authUpd.error });
      if (!isValidItemCode(body.itemId)) {
        return res.status(400).json({ ok: false, error: 'itemId is required and must be a valid item code' });
      }
      const errs = validateMenuPayload(body, false);
      if (errs.length) return res.status(400).json({ ok: false, error: errs.join('; ') });

      const updates = {};
      if (body.name      !== undefined) updates.name             = body.name;
      if (body.category  !== undefined) updates.category_id      = getCategoryId(body.category);
      if (body.price     !== undefined) updates.base_price        = parseFloat(body.price) || 0;
      if (body.hasSizes  !== undefined) updates.has_sizes         = !!body.hasSizes;
      if (body.hasSugar  !== undefined) updates.has_sugar_levels  = !!body.hasSugar;
      if (body.priceShort  !== undefined) updates.price_short     = body.priceShort  != null ? parseFloat(body.priceShort)  : null;
      if (body.priceMedium !== undefined) updates.price_medium    = body.priceMedium != null ? parseFloat(body.priceMedium) : null;
      if (body.priceTall   !== undefined) updates.price_tall      = body.priceTall   != null ? parseFloat(body.priceTall)   : null;
      if (body.image     !== undefined) updates.image_path        = body.image || null;
      if (body.status    !== undefined) updates.is_active         = (body.status || 'ACTIVE').toUpperCase() === 'ACTIVE';
      if (Object.keys(updates).length === 0) return res.status(200).json({ ok: true });

      const r = await supa('PATCH', 'menu_items', updates, { item_code: `eq.${body.itemId}` });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to update menu item' });
      invalidateMenuCache();
      logSync('menu_items', body.itemId, 'UPDATE');
      return res.status(200).json({ ok: true });
    }

    // ── deleteMenuItem ─────────────────────────────────────────────────────
    if (action === 'deleteMenuItem') {
      const authDel = await requireAdminRole(body);
      if (!authDel.ok) return res.status(403).json({ ok: false, error: authDel.error });
      if (!isValidItemCode(body.itemId)) {
        return res.status(400).json({ ok: false, error: 'itemId is required and must be a valid item code' });
      }
      // Hard delete — permanently removes menu item. Order items store snapshots so no FK risk.
      const r = await supa('DELETE', 'menu_items', null, { item_code: `eq.${body.itemId}` });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to delete menu item' });
      invalidateMenuCache();
      logSync('menu_items', body.itemId, 'DELETE');
      return res.status(200).json({ ok: true });
    }

    // ── upsertToSupabase (backfill helper — ADMIN/OWNER only) ──────────────
    if (action === 'upsertToSupabase') {
      const authUps = await requireAdminRole(body);
      if (!authUps.ok) return res.status(403).json({ ok: false, error: authUps.error });
      if (!isValidItemCode(body.itemId)) {
        return res.status(400).json({ ok: false, error: 'itemId is required' });
      }
      const row = {
        item_code:        body.itemId,
        name:             body.name,
        category_id:      getCategoryId(body.category),
        base_price:       parseFloat(body.price) || 0,
        has_sizes:        !!body.hasSizes,
        has_sugar_levels: !!body.hasSugar,
        price_short:      parseFloat(body.priceShort) || null,
        price_medium:     parseFloat(body.priceMedium) || null,
        price_tall:       parseFloat(body.priceTall) || null,
        image_path:       body.image || null,
        is_active:        (body.status || 'ACTIVE').toUpperCase() === 'ACTIVE',
      };
      const r = await supa('POST', 'menu_items', row, null, 'resolution=merge-duplicates');
      return res.status(200).json({ ok: r.ok, data: r.data });
    }

    // ══════════════════════════════════════════════════════════════════════
    // ORDER ACTIONS
    // ══════════════════════════════════════════════════════════════════════

    // ── placeOrder ─────────────────────────────────────────────────────────
    if (action === 'placeOrder') {
      const isStaffOrder = body.staffOrder === true;
      const rawTableNo   = body.tableNo;
      const tableNo      = rawTableNo != null ? String(rawTableNo).trim() : '0';
      // Accept both 'token' (customer front-end) and 'tableToken' (legacy) field names
      const tableToken   = String(body.token || body.tableToken || '').trim();
      const customerName = String(body.customerName || body.customer || 'Guest').trim().substring(0, 100);
      const notes        = String(body.notes || '').trim().substring(0, 500);
      const rawOrderType = String(body.orderType || '').toUpperCase().replace('_', '-');
      const orderType    = ['DINE-IN', 'TAKE-OUT'].includes(rawOrderType) ? rawOrderType : 'DINE-IN';
      const items        = Array.isArray(body.items) ? body.items : [];

      // Validate items
      if (items.length === 0) return res.status(400).json({ ok: false, error: 'Order must have at least one item' });
      if (items.some(i => (parseFloat(i.price) || 0) < 0)) {
        return res.status(400).json({ ok: false, error: 'Item prices cannot be negative' });
      }

      // Validate table token against DB — mandatory for customer (non-staff) dine-in orders
      if (!isStaffOrder && tableNo !== '0') {
        if (!tableToken) {
          return res.status(403).json({ ok: false, error: 'Table token required' });
        }
        const tokenR = await supaFetch(
          `${SUPABASE_URL}/rest/v1/cafe_tables?table_number=eq.${encodeURIComponent(tableNo)}&qr_token=eq.${encodeURIComponent(tableToken)}&select=table_number`
        );
        if (!tokenR.ok || !tokenR.data || tokenR.data.length === 0) {
          return res.status(403).json({ ok: false, error: 'Invalid table token' });
        }
      }

      // Look up prices from menu
      const itemCodes = [...new Set(items.map(i => i.code))];
      const menuR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/menu_items?item_code=in.(${itemCodes.map(c => `"${c}"`).join(',')})&is_active=eq.true&select=item_code,name,base_price,has_sizes,price_short,price_medium,price_tall`
      );
      const menuMap = {};
      if (menuR.ok && Array.isArray(menuR.data)) {
        menuR.data.forEach(m => { menuMap[m.item_code] = m; });
      }

      // Build order items with prices
      const orderItems = [];
      let subtotal = 0;
      for (const item of items) {
        const menuItem = menuMap[item.code];
        if (!menuItem) continue; // skip unknown items
        let unitPrice = menuItem.base_price;
        if (menuItem.has_sizes && item.size) {
          const sizeKey = { SHORT: 'price_short', MEDIUM: 'price_medium', TALL: 'price_tall' }[String(item.size).toUpperCase()];
          if (sizeKey && menuItem[sizeKey] != null) unitPrice = menuItem[sizeKey];
        }
        const qty = Math.max(1, parseInt(item.qty) || 1);
        subtotal += unitPrice * qty;
        orderItems.push({
          item_code:    item.code,
          item_name:    menuItem.name,
          unit_price:   unitPrice,
          qty,
          size_choice:  item.size || '',
          sugar_choice: item.sugarLevel || item.sugar || '',
          item_notes:   item.notes || '',
        });
      }

      if (orderItems.length === 0) return res.status(400).json({ ok: false, error: 'No valid items in order' });

      const svcCharge = orderType === 'DINE-IN' ? Math.round(subtotal * SERVICE_CHARGE_RATE * 100) / 100 : 0;
      const preTax    = subtotal + svcCharge;

      // VAT — read live from settings table
      const vatEnabled = (await getSetting('VAT_ENABLED')) === 'true';
      const vatRate    = parseFloat(await getSetting('VAT_RATE') || '0.12');
      // VAT-inclusive: vat = preTax × rate / (1 + rate)  ← back-calculate from VAT-inclusive price
      const vatAmt     = vatEnabled ? Math.round(preTax * (vatRate / (1 + vatRate)) * 100) / 100 : 0;
      const total      = Math.round(preTax * 100) / 100; // total stays the same; VAT is shown as breakdown

      if (total <= 0) return res.status(400).json({ ok: false, error: 'Order total must be greater than zero' });

      // Generate order ID using sequence — with self-healing retry on duplicate key
      const TEST_TABLES = ['T99', '0', 'T0'];
      const TEST_NAMES  = ['juan dela cruz', 'maria santos', 'price test', 'guest', 'pia test', 'e2e test'];
      const isTest = TEST_TABLES.includes(tableNo.toUpperCase()) ||
                     TEST_NAMES.includes(customerName.toLowerCase());

      let orderR, orderId, orderNo;
      for (let attempt = 0; attempt < 3; attempt++) {
        const seqR = await supaFetch(
          `${SUPABASE_URL}/rest/v1/rpc/get_next_order_number`,
          { method: 'POST', body: '{}' }
        );
        orderNo = seqR.ok ? (seqR.data || 1001) : Date.now() % 9000 + 1000;
        orderId = `${ORDER_PREFIX}-${orderNo}`;

        const orderRow = {
          order_id:       orderId,
          order_no:       orderNo,
          table_no:       tableNo,
          customer_name:  customerName,
          status:         'NEW',
          order_type:     orderType,
          subtotal:       subtotal,
          service_charge: svcCharge,
          vat_amount:     vatAmt,
          total:          total,
          notes:          notes,
          source:         'QR',
          is_test:        isTest,
        };
        orderR = await supa('POST', 'dine_in_orders', orderRow);
        if (orderR.ok) break; // success

        const errCode = orderR.data && orderR.data.code;
        if (errCode === '23505') {
          // Duplicate key — sequence is behind actual data; auto-advance and retry
          console.warn(`placeOrder: duplicate order_id ${orderId}, advancing sequence (attempt ${attempt+1})`);
          await supaFetch(
            `${SUPABASE_URL}/rest/v1/rpc/advance_order_sequence`,
            { method: 'POST', body: '{}' }
          ).catch(() => {}); // best-effort
          continue;
        }
        break; // non-duplicate error, stop retrying
      }
      if (!orderR || !orderR.ok) {
        console.error('placeOrder insert failed:', orderR && orderR.status, JSON.stringify(orderR && orderR.data));
        return res.status(500).json({ ok: false, error: 'Failed to place order' });
      }

      // Insert order items
      const itemRows = orderItems.map(it => ({
        order_id:     orderId,
        order_no:     orderNo,
        table_no:     tableNo,
        item_code:    it.item_code,
        item_name:    it.item_name,
        unit_price:   it.unit_price,
        qty:          it.qty,
        size_choice:  it.size_choice,
        sugar_choice: it.sugar_choice,
        item_notes:   it.item_notes,
      }));
      await supa('POST', 'dine_in_order_items', itemRows);

      // Log for Sheets sync
      logSync('dine_in_orders', orderId, 'INSERT');
      auditLog({ orderId, action: 'ORDER_PLACED', details: { tableNo, customerName, orderType, total, itemCount: orderItems.length } });

      // Deduct inventory (fire-and-forget, non-blocking)
      Promise.all(orderItems.map(async item => {
        try {
          const inv = await supaFetch(
            `${SUPABASE_URL}/rest/v1/inventory?item_code=eq.${encodeURIComponent(item.item_code)}&select=stock_qty,auto_disable`
          );
          if (!inv.ok || !inv.data?.length) return;
          const cur = inv.data[0];
          const newQty = Math.max(0, parseFloat(cur.stock_qty) - parseFloat(item.qty || 1));
          await supaFetch(
            `${SUPABASE_URL}/rest/v1/inventory?item_code=eq.${encodeURIComponent(item.item_code)}`,
            { method: 'PATCH', body: JSON.stringify({ stock_qty: newQty, updated_at: new Date().toISOString() }) }
          );
          if (newQty === 0 && cur.auto_disable) {
            await supaFetch(
              `${SUPABASE_URL}/rest/v1/menu_items?item_code=eq.${encodeURIComponent(item.item_code)}`,
              { method: 'PATCH', body: JSON.stringify({ is_active: false }) }
            );
          }
          await supaFetch(`${SUPABASE_URL}/rest/v1/inventory_log`, { method: 'POST',
            body: JSON.stringify({ item_code: item.item_code, change_type: 'SALE',
              qty_before: parseFloat(cur.stock_qty), qty_change: -parseFloat(item.qty || 1),
              qty_after: newQty, order_id: orderId }) });
        } catch (_) {}
      })).catch(() => {});

      // Auto-set table OCCUPIED
      if (tableNo && tableNo !== '0' && orderType === 'DINE-IN') {
        supaFetch(
          `${SUPABASE_URL}/rest/v1/cafe_tables?table_number=eq.${encodeURIComponent(tableNo)}`,
          { method: 'PATCH', body: JSON.stringify({ status: 'OCCUPIED' }) }
        ).catch(() => {});
      }

      // Push to Google Sheets (fire-and-forget)
      pushToSheets('syncOrder', { order: {
        orderId, tableNo, customerName, status: 'NEW',
        orderType, subtotal, serviceCharge: svcCharge, vatAmount: vatAmt, total,
        createdAt: new Date().toISOString(),
        notes,
      }});
      pushToSheets('syncOrderItems', { orderId, items: orderItems.map(it => ({
        code: it.item_code, name: it.item_name, size: it.size_choice,
        price: it.unit_price, qty: it.qty,
        lineTotal: Math.round(it.unit_price * it.qty * 100) / 100,
        sugar: it.sugar_choice, notes: it.item_notes,
      }))});

      return res.status(200).json({
        ok: true,
        orderId,
        ORDER_ID: orderId,
        orderNo,
        subtotal,
        serviceCharge: svcCharge,
        vatAmount: vatAmt,
        vatEnabled,
        total,
      });
    }

    // ── getOrders ──────────────────────────────────────────────────────────
    if (action === 'getOrders') {
      const orderId = body.orderId ? String(body.orderId).trim() : null;
      const status  = body.status  ? String(body.status).toUpperCase() : null;
      const limit   = Math.min(parseInt(body.limit) || 200, 500);

      let url = `${SUPABASE_URL}/rest/v1/dine_in_orders?order=created_at.desc&limit=${limit}&is_deleted=eq.false`;
      if (orderId) url += `&order_id=eq.${encodeURIComponent(orderId)}`;
      else if (status && status !== 'ALL') url += `&status=eq.${encodeURIComponent(status)}`;

      const ordersR = await supaFetch(url);
      if (!ordersR.ok) return res.status(502).json({ ok: false, orders: [], error: 'Failed to load orders' });

      // Fetch items for all orders
      const orderIds = ordersR.data.map(o => o.order_id);
      let itemsMap = {};
      if (orderIds.length > 0) {
        const itemsR = await supaFetch(
          `${SUPABASE_URL}/rest/v1/dine_in_order_items?order_id=in.(${orderIds.map(id => `"${id}"`).join(',')})&order=id.asc`
        );
        if (itemsR.ok && Array.isArray(itemsR.data)) {
          itemsR.data.forEach(it => {
            if (!itemsMap[it.order_id]) itemsMap[it.order_id] = [];
            itemsMap[it.order_id].push({
              id:       it.id,
              code:     it.item_code,
              name:     it.item_name,
              price:    it.unit_price,
              qty:      it.qty,
              size:     it.size_choice || '',
              sugar:    it.sugar_choice || '',
              notes:    it.item_notes || '',
              prepared: it.prepared || false,
            });
          });
        }
      }

      const orders = ordersR.data.map(o => ({
        orderId:       o.order_id,
        orderNo:       o.order_no,
        tableNo:       o.table_no,
        customerName:  o.customer_name,
        status:        o.status,
        orderType:     o.order_type,
        subtotal:      o.subtotal,
        serviceCharge: o.service_charge,
        vatAmount:     o.vat_amount || 0,
        total:         o.total,
        notes:         o.notes || '',
        source:        o.source || 'QR',
        platform:      o.platform || '',
        platformRef:   o.platform_ref || '',
        paymentMethod: o.payment_method || '',
        paymentStatus: o.payment_status || '',
        discountType:    o.discount_type    || null,
        discountAmount:  o.discount_amount  || 0,
        discountedTotal: o.discounted_total || null,
        discountNote:    o.discount_note    || null,
        paymentNotes:    o.payment_notes    || null,
        createdAt:     o.created_at,
        updatedAt:     o.updated_at,
        isTest:        o.is_test || false,
        items:         itemsMap[o.order_id] || [],
      }));

      return res.status(200).json({ ok: true, orders });
    }

    // ── updateOrderStatus ──────────────────────────────────────────────────
    if (action === 'updateOrderStatus') {
      const orderId      = String(body.orderId || '').trim();
      const newStatus    = String(body.status  || '').trim().toUpperCase();
      const cancelReason = body.cancelReason ? String(body.cancelReason).trim() : null;
      const validStatuses = ['NEW', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED'];
      if (!orderId)                           return res.status(400).json({ ok: false, error: 'orderId is required' });
      if (!isValidOrderId(orderId))           return res.status(400).json({ ok: false, error: 'Invalid orderId format' });
      if (!validStatuses.includes(newStatus)) return res.status(400).json({ ok: false, error: 'Invalid status: ' + newStatus });

      // Role guard — staff only (all roles permitted for kitchen workflow)
      const userId = String(body.userId || '').trim();
      if (!userId) return res.status(401).json({ ok: false, error: 'userId is required to update order status' });
      const staffR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/staff_users?user_id=eq.${encodeURIComponent(userId)}&active=eq.true&select=role`
      );
      if (!staffR.ok || !staffR.data.length) return res.status(403).json({ ok: false, error: 'Unauthorized: invalid user' });
      const staffRole = staffR.data[0].role;
      const allowedRoles = ['KITCHEN', 'CASHIER', 'ADMIN', 'OWNER'];
      if (!allowedRoles.includes(staffRole)) return res.status(403).json({ ok: false, error: 'Unauthorized: insufficient role' });

      // Capture previous status for audit log
      const prevR = await supaFetch(`${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}&select=status&limit=1`);
      const prevStatus = (prevR.ok && prevR.data && prevR.data[0]) ? prevR.data[0].status : null;

      const patch = { status: newStatus };
      if (newStatus === 'CANCELLED' && cancelReason) patch.cancel_reason = cancelReason;

      const r = await supa('PATCH', 'dine_in_orders', patch, { order_id: `eq.${orderId}` });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to update status' });

      logSync('dine_in_orders', orderId, 'UPDATE');
      auditLog({ orderId, action: 'STATUS_CHANGED', actor: { userId, role: staffRole }, oldValue: prevStatus, newValue: newStatus });
      // Push status update to Sheets
      pushToSheets('updateOrderStatus', { orderId, status: newStatus });

      // Auto-release table when order COMPLETED or CANCELLED
      if (newStatus === 'COMPLETED' || newStatus === 'CANCELLED') {
        const orderRes = await supaFetch(
          `${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}&select=table_no,order_type`
        );
        const tableNo = orderRes.data?.[0]?.table_no;
        if (tableNo && tableNo !== '0' && tableNo !== '') {
          // Only free if no other active orders on same table
          const activeR = await supaFetch(
            `${SUPABASE_URL}/rest/v1/dine_in_orders?table_no=eq.${encodeURIComponent(tableNo)}&status=in.(NEW,PREPARING,READY)&is_deleted=eq.false&select=order_id`
          );
          if (!activeR.data?.length) {
            supaFetch(
              `${SUPABASE_URL}/rest/v1/cafe_tables?table_number=eq.${encodeURIComponent(tableNo)}`,
              { method: 'PATCH', body: JSON.stringify({ status: 'AVAILABLE' }) }
            ).catch(() => {});
          }
        }
      }

      return res.status(200).json({ ok: true, orderId, status: newStatus });
    }

    // ── deleteOrder ────────────────────────────────────────────────────────
    if (action === 'deleteOrder') {
      const authDO = await requireAdminRole(body);
      if (!authDO.ok) return res.status(401).json({ ok: false, error: authDO.error });
      const orderId = String(body.orderId || '').trim();
      if (!orderId) return res.status(400).json({ ok: false, error: 'orderId is required' });
      if (!isValidOrderId(orderId)) return res.status(400).json({ ok: false, error: 'Invalid orderId format' });

      // Soft delete — preserve order history for analytics/audit
      const r = await supa('PATCH', 'dine_in_orders',
        { is_deleted: true, deleted_at: new Date().toISOString() },
        { order_id: `eq.${orderId}` }
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to delete order' });

      logSync('dine_in_orders', orderId, 'DELETE');
      auditLog({ orderId, action: 'ORDER_DELETED', actor: { userId: body.userId } });
      return res.status(200).json({ ok: true, orderId });
    }

    // ── toggleItemPrepared ────────────────────────────────────────────────
    // Kitchen taps an item to mark it prepared (or un-prepared).
    // Allowed for KITCHEN, CASHIER, ADMIN, OWNER.
    if (action === 'toggleItemPrepared') {
      const authK = await requireAuth(body);
      if (!authK.ok) return res.status(401).json({ ok: false, error: authK.error });

      const itemId  = parseInt(body.itemId, 10);
      const prepared = Boolean(body.prepared);
      if (!itemId || isNaN(itemId)) return res.status(400).json({ ok: false, error: 'itemId is required' });

      const r = await supa('PATCH', 'dine_in_order_items',
        { prepared },
        { id: `eq.${itemId}` }
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to update item' });
      return res.status(200).json({ ok: true, itemId, prepared });
    }

    // ── setPaymentMethod ──────────────────────────────────────────────────
    // Admin/Cashier/Owner sets how an order was paid.
    // method can be single (CASH) or split (GCASH+CASH, CARD+GCASH, etc.)
    if (action === 'setPaymentMethod') {
      const authP = await requireAuth(body, ['OWNER','ADMIN','CASHIER']);
      if (!authP.ok) return res.status(401).json({ ok: false, error: authP.error });

      const orderId = String(body.orderId || '').trim();
      const method  = String(body.method  || '').trim().toUpperCase();
      const notes   = String(body.notes   || '').trim().slice(0, 300);
      const VALID   = new Set(['CASH','CARD','GCASH','INSTAPAY','BDO','BPI','UNIONBANK','MAYA','OTHER']);

      if (!orderId) return res.status(400).json({ ok: false, error: 'orderId required' });
      if (!isValidOrderId(orderId)) return res.status(400).json({ ok: false, error: 'Invalid orderId' });

      // Accept single or split methods (e.g. "GCASH+CASH")
      const parts = method.split('+').map(s => s.trim());
      if (parts.length > 2 || parts.some(p => !VALID.has(p)))
        return res.status(400).json({ ok: false, error: 'Invalid payment method: ' + method });

      const patchData = {
        payment_method: method,
        payment_status: 'VERIFIED',
        updated_at: new Date().toISOString()
      };
      if (notes) patchData.payment_notes = notes;

      const r = await supa('PATCH', 'dine_in_orders', patchData,
        { order_id: `eq.${encodeURIComponent(orderId)}` }
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to update payment method' });
      auditLog({ orderId, action: 'PAYMENT_SET', actor: { userId: body.userId, role: authP.role }, newValue: method, details: { notes: notes || null } });
      pushToSheets('updateOrderPayment', { orderId, paymentMethod: method, paymentStatus: 'VERIFIED' });
      return res.status(200).json({ ok: true, orderId, method, split: parts.length === 2 });
    }

    // ── applyDiscount ─────────────────────────────────────────────────────
    // OWNER/ADMIN/CASHIER can apply PWD, SENIOR, PROMO, or CUSTOM discount
    if (action === 'applyDiscount') {
      const authD = await requireAuth(body, ['OWNER','ADMIN','CASHIER']);
      if (!authD.ok) return res.status(401).json({ ok: false, error: authD.error });

      const orderId   = String(body.orderId || '').trim();
      const type      = String(body.discountType || '').toUpperCase(); // PWD | SENIOR | BOTH | PROMO | CUSTOM
      const totalPax  = parseInt(body.totalPax, 10) || 1;
      const qualPax   = parseInt(body.qualifiedPax, 10) || 1; // how many PWD/Senior
      const promoPct  = parseFloat(body.promoPct) || 0;       // % for PROMO
      const customAmt = parseFloat(body.customAmt) || 0;      // fixed ₱ for CUSTOM
      const note      = String(body.note || '').trim().slice(0, 200);

      if (!orderId) return res.status(400).json({ ok: false, error: 'orderId required' });
      if (!isValidOrderId(orderId)) return res.status(400).json({ ok: false, error: 'Invalid orderId' });
      if (!['PWD','SENIOR','BOTH','PROMO','CUSTOM','REMOVE'].includes(type))
        return res.status(400).json({ ok: false, error: 'Invalid discountType' });

      // Fetch current order total
      const orderR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}&select=total`
      );
      if (!orderR.ok || !orderR.data?.length)
        return res.status(404).json({ ok: false, error: 'Order not found' });
      const total = parseFloat(orderR.data[0].total) || 0;

      let discountAmount = 0;
      let discountPct = 0;

      if (type === 'REMOVE') {
        // Remove discount entirely
        const r = await supa('PATCH', 'dine_in_orders',
          { discount_type: null, discount_pax: 0, discount_pct: 0, discount_amount: 0,
            discounted_total: null, discount_note: null, updated_at: new Date().toISOString() },
          { order_id: `eq.${encodeURIComponent(orderId)}` }
        );
        if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to remove discount' });
        auditLog({ orderId, action: 'DISCOUNT_REMOVED', actor: { userId: body.userId, role: authD.role } });
        return res.status(200).json({ ok: true, orderId, discountRemoved: true });
      }

      if (type === 'PWD' || type === 'SENIOR') {
        // 20% per qualifying person, split equally among all pax
        const perPerson = total / Math.max(totalPax, 1);
        discountAmount  = Math.round(perPerson * qualPax * 0.20 * 100) / 100;
        discountPct     = 20;
      } else if (type === 'BOTH') {
        // Both PWD and Senior in same party
        const perPerson = total / Math.max(totalPax, 1);
        discountAmount  = Math.round(perPerson * qualPax * 0.20 * 100) / 100;
        discountPct     = 20;
      } else if (type === 'PROMO') {
        discountPct    = Math.min(promoPct, 100);
        discountAmount = Math.round(total * (discountPct / 100) * 100) / 100;
      } else if (type === 'CUSTOM') {
        discountAmount = Math.min(customAmt, total);
        discountPct    = Math.round((discountAmount / total) * 100 * 100) / 100;
      }

      const discountedTotal = Math.max(0, Math.round((total - discountAmount) * 100) / 100);

      const r = await supa('PATCH', 'dine_in_orders',
        { discount_type: type, discount_pax: qualPax, discount_pct: discountPct,
          discount_amount: discountAmount, discounted_total: discountedTotal,
          discount_note: note || null, updated_at: new Date().toISOString() },
        { order_id: `eq.${encodeURIComponent(orderId)}` }
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to apply discount' });
      auditLog({ orderId, action: 'DISCOUNT_APPLIED', actor: { userId: body.userId, role: authD.role }, newValue: type, details: { discountAmount, discountedTotal, note: body.note || null } });
      pushToSheets('updateOrderDiscount', { orderId, discountType: type, discountAmount, discountedTotal });
      return res.status(200).json({ ok: true, orderId, type, discountAmount, discountedTotal, total });
    }

    // ── getShiftSummary ────────────────────────────────────────────────────
    // Returns today's sales breakdown by payment method for end-of-day reconciliation
    if (action === 'getShiftSummary') {
      const authSh = await requireAuth(body, ['OWNER','ADMIN','CASHIER']);
      if (!authSh.ok) return res.status(401).json({ ok: false, error: authSh.error });

      // Get timezone from settings (default Asia/Manila)
      const tz = await getSetting('TIMEZONE') || 'Asia/Manila';

      // Today's date in PH time
      const nowPH  = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
      const y = nowPH.getFullYear(), m = String(nowPH.getMonth()+1).padStart(2,'0'), d = String(nowPH.getDate()).padStart(2,'0');
      const todayStart = `${y}-${m}-${d}T00:00:00+08:00`;
      const todayEnd   = `${y}-${m}-${d}T23:59:59+08:00`;

      const ordersR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/dine_in_orders?created_at=gte.${encodeURIComponent(todayStart)}&created_at=lte.${encodeURIComponent(todayEnd)}&is_test=eq.false&select=status,total,discounted_total,payment_method,payment_status,discount_type,discount_amount,order_type,created_at&order=created_at.asc`
      );
      if (!ordersR.ok) return res.status(500).json({ ok: false, error: 'Failed to fetch shift data' });

      const orders = ordersR.data || [];
      const completed = orders.filter(o => o.status === 'COMPLETED');
      const cancelled = orders.filter(o => o.status === 'CANCELLED');

      // Payment method breakdown
      const pmBreakdown = {};
      let totalRevenue = 0;
      let discountTotal = 0;
      completed.forEach(o => {
        const revenue = parseFloat(o.discounted_total ?? o.total) || 0;
        totalRevenue += revenue;
        discountTotal += parseFloat(o.discount_amount) || 0;
        const pm = o.payment_method || 'UNRECORDED';
        if (!pmBreakdown[pm]) pmBreakdown[pm] = { count: 0, total: 0 };
        pmBreakdown[pm].count++;
        pmBreakdown[pm].total = Math.round((pmBreakdown[pm].total + revenue) * 100) / 100;
      });

      // Order type split
      const dineIn  = completed.filter(o => o.order_type === 'DINE-IN').length;
      const takeOut = completed.filter(o => o.order_type === 'TAKE-OUT').length;

      return res.status(200).json({
        ok: true,
        date: `${y}-${m}-${d}`,
        totalOrders: completed.length,
        cancelledOrders: cancelled.length,
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        totalDiscounts: Math.round(discountTotal * 100) / 100,
        unrecordedPayments: (pmBreakdown['UNRECORDED']?.count || 0),
        paymentBreakdown: pmBreakdown,
        orderTypeSplit: { dineIn, takeOut },
        orders: completed.map(o => ({
          orderId: o.order_id,
          total: o.discounted_total ?? o.total,
          paymentMethod: o.payment_method || null,
          discountType: o.discount_type || null,
          time: o.created_at,
        }))
      });
    }

    // ── editOrderItems ─────────────────────────────────────────────────────
    if (action === 'editOrderItems') {
      const authE = await requireAuth(body, ['OWNER','ADMIN','CASHIER']);
      if (!authE.ok) return res.status(401).json({ ok: false, error: authE.error });

      const orderId = String(body.orderId || '').trim();
      const items   = Array.isArray(body.items) ? body.items : [];
      if (!orderId) return res.status(400).json({ ok: false, error: 'orderId is required' });
      if (!isValidOrderId(orderId)) return res.status(400).json({ ok: false, error: 'Invalid orderId format' });

      // Get order to check it exists and get order_no/table_no
      const orderR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}&select=order_no,table_no`
      );
      if (!orderR.ok || !orderR.data.length) return res.status(404).json({ ok: false, error: 'Order not found' });
      const { order_no, table_no } = orderR.data[0];

      // Recalculate totals
      let subtotal = 0;
      const itemRows = items.map(it => {
        const qty = Math.max(1, parseInt(it.qty) || 1);
        const price = parseFloat(it.price) || 0;
        subtotal += price * qty;
        return {
          order_id:     orderId,
          order_no:     order_no,
          table_no:     table_no,
          item_code:    it.code || 'CUSTOM',
          item_name:    it.name || 'Item',
          unit_price:   price,
          qty,
          size_choice:  it.size || '',
          sugar_choice: it.sugar || '',
          item_notes:   it.notes || '',
        };
      });

      const svcCharge  = Math.round(subtotal * SERVICE_CHARGE_RATE * 100) / 100;
      const preTax2    = subtotal + svcCharge;
      const vatEnabled2 = (await getSetting('VAT_ENABLED')) === 'true';
      const vatRate2    = parseFloat(await getSetting('VAT_RATE') || '0.12');
      const vatAmt2     = vatEnabled2 ? Math.round(preTax2 * (vatRate2 / (1 + vatRate2)) * 100) / 100 : 0;
      const total       = Math.round(preTax2 * 100) / 100;

      // Delete old items and insert new ones
      await supa('DELETE', 'dine_in_order_items', null, { order_id: `eq.${orderId}` });
      if (itemRows.length > 0) await supa('POST', 'dine_in_order_items', itemRows);

      // Update order totals
      await supa('PATCH', 'dine_in_orders', { subtotal, service_charge: svcCharge, vat_amount: vatAmt2, total }, { order_id: `eq.${orderId}` });

      logSync('dine_in_orders', orderId, 'UPDATE');
      auditLog({ orderId, action: 'ORDER_EDITED', actor: { userId: body.userId, role: authE.role }, details: { newTotal: total, itemCount: itemRows.length } });
      return res.status(200).json({ ok: true, orderId, subtotal, serviceCharge: svcCharge, total });
    }

    // ── placePlatformOrder ─────────────────────────────────────────────────
    if (action === 'placePlatformOrder') {
      const platform    = String(body.platform    || '').trim().toUpperCase();
      const platformRef = String(body.platformRef || '').trim().substring(0, 100);
      const notes       = String(body.notes       || '').trim().substring(0, 500);
      const items       = Array.isArray(body.items) ? body.items : [];

      if (!platform) return res.status(400).json({ ok: false, error: 'platform is required' });
      if (items.length === 0) return res.status(400).json({ ok: false, error: 'Order must have at least one item' });

      // Look up prices from menu
      const itemCodes = [...new Set(items.map(i => i.code))];
      const menuR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/menu_items?item_code=in.(${itemCodes.map(c => `"${c}"`).join(',')})&is_active=eq.true&select=item_code,name,base_price,has_sizes,price_short,price_medium,price_tall`
      );
      const menuMap = {};
      if (menuR.ok && Array.isArray(menuR.data)) {
        menuR.data.forEach(m => { menuMap[m.item_code] = m; });
      }

      const orderItems = [];
      let subtotal = 0;
      for (const item of items) {
        const menuItem = menuMap[item.code];
        if (!menuItem) continue;
        let unitPrice = menuItem.base_price;
        if (menuItem.has_sizes && item.size) {
          const sizeKey = { SHORT: 'price_short', MEDIUM: 'price_medium', TALL: 'price_tall' }[String(item.size).toUpperCase()];
          if (sizeKey && menuItem[sizeKey] != null) unitPrice = menuItem[sizeKey];
        }
        const qty = Math.max(1, parseInt(item.qty) || 1);
        subtotal += unitPrice * qty;
        orderItems.push({
          item_code:    item.code,
          item_name:    menuItem.name,
          unit_price:   unitPrice,
          qty,
          size_choice:  item.size || '',
          sugar_choice: item.sugarLevel || '',
          item_notes:   '',
        });
      }

      if (orderItems.length === 0) return res.status(400).json({ ok: false, error: 'No valid items in order' });

      const total = Math.round(subtotal * 100) / 100; // No service charge for platform orders

      // Generate order ID
      const seqR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/rpc/get_next_order_number`,
        { method: 'POST', body: '{}' }
      );
      const orderNo = seqR.ok ? (seqR.data || 1001) : Date.now() % 9000 + 1000;
      const orderId = `${ORDER_PREFIX}-${orderNo}`;

      const orderRow = {
        order_id:       orderId,
        order_no:       orderNo,
        table_no:       '',
        customer_name:  platform,
        status:         'NEW',
        order_type:     'PLATFORM',
        subtotal:       subtotal,
        service_charge: 0,
        total:          total,
        notes:          notes,
        source:         'PLATFORM',
        platform:       platform,
        platform_ref:   platformRef,
      };
      const orderR = await supa('POST', 'dine_in_orders', orderRow);
      if (!orderR.ok) return res.status(500).json({ ok: false, error: 'Failed to place platform order' });

      const itemRows = orderItems.map(it => ({
        order_id:     orderId,
        order_no:     orderNo,
        table_no:     '',
        item_code:    it.item_code,
        item_name:    it.item_name,
        unit_price:   it.unit_price,
        qty:          it.qty,
        size_choice:  it.size_choice,
        sugar_choice: it.sugar_choice,
        item_notes:   it.item_notes,
      }));
      await supa('POST', 'dine_in_order_items', itemRows);
      logSync('dine_in_orders', orderId, 'INSERT');
      auditLog({ orderId, action: 'PLATFORM_ORDER_PLACED', actor: { userId: body.userId }, details: { platform: body.platform, total } });

      return res.status(200).json({ ok: true, orderId, total, subtotal });
    }

    // ── requestReceipt ─────────────────────────────────────────────────────
    if (action === 'requestReceipt') {
      const orderId        = String(body.orderId        || '').trim();
      const receiptType    = String(body.receiptType    || 'simple').trim(); // 'simple' | 'bir'
      const deliveryMethod = String(body.deliveryMethod || body.delivery || '').trim(); // 'email' | 'printed'
      const email          = String(body.email          || '').trim().toLowerCase();
      const name           = String(body.name           || '').trim().slice(0, 200);
      const address        = String(body.address        || '').trim().slice(0, 500);
      const tin            = String(body.tin            || '').trim().slice(0, 50);

      if (!orderId) return res.status(400).json({ ok: false, error: 'orderId is required' });

      // 1. Save receipt details to order record
      const updates = {
        receipt_type:     receiptType,
        receipt_delivery: deliveryMethod,
        receipt_email:    email,
        receipt_name:     name,
        receipt_address:  address,
        receipt_tin:      tin,
      };
      await supa('PATCH', 'dine_in_orders', updates, { order_id: `eq.${orderId}` });

      // 2. If email delivery → fetch order + items → send email
      if (deliveryMethod === 'email') {
        if (!email || !email.includes('@'))
          return res.status(400).json({ ok: false, error: 'Valid email address required for email delivery' });

        // Fetch order details
        const orderR = await supaFetch(
          `${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}&limit=1`
        );
        if (!orderR.ok || !orderR.data.length)
          return res.status(404).json({ ok: false, error: 'Order not found' });
        const order = orderR.data[0];
        // Merge in the receipt fields we just saved (PATCH may not have flushed yet)
        Object.assign(order, { receipt_name: name, receipt_address: address, receipt_tin: tin });

        // Fetch order items
        const itemsR = await supaFetch(
          `${SUPABASE_URL}/rest/v1/dine_in_order_items?order_id=eq.${encodeURIComponent(orderId)}&order=id.asc`
        );
        const items = itemsR.ok ? (itemsR.data || []) : [];

        try {
          const emailId = await sendReceiptEmail({
            toEmail: email,
            order,
            items,
            isBIR: receiptType === 'bir',
          });
          auditLog({ orderId, action: 'RECEIPT_SENT', newValue: `email:${email}`, details: { type: receiptType, emailId } });
          return res.status(200).json({ ok: true, sent: true, emailId, message: `Receipt sent to ${email}` });
        } catch (emailErr) {
          return res.status(500).json({ ok: false, error: `Email failed: ${emailErr.message}` });
        }
      }

      // 3. Printed delivery → just saved the info, staff will handle at counter
      return res.status(200).json({ ok: true, sent: false, message: 'Receipt details saved. Print at counter.' });
    }

    // ── resendReceipt ──────────────────────────────────────────────────────
    // Staff-triggered: resend receipt email for any completed order
    if (action === 'resendReceipt') {
      const authR = await requireAuth(body, ['OWNER','ADMIN','CASHIER']);
      if (!authR.ok) return res.status(401).json({ ok: false, error: authR.error });

      const orderId   = String(body.orderId   || '').trim();
      const toEmail   = String(body.email     || '').trim().toLowerCase();
      const rcpType   = String(body.receiptType || 'simple').trim();

      if (!orderId) return res.status(400).json({ ok: false, error: 'orderId required' });
      if (!toEmail || !toEmail.includes('@')) return res.status(400).json({ ok: false, error: 'Valid email required' });

      const orderR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}&limit=1`
      );
      if (!orderR.ok || !orderR.data.length)
        return res.status(404).json({ ok: false, error: 'Order not found' });
      const order = orderR.data[0];

      const itemsR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/dine_in_order_items?order_id=eq.${encodeURIComponent(orderId)}&order=id.asc`
      );
      const items = itemsR.ok ? (itemsR.data || []) : [];

      try {
        const emailId = await sendReceiptEmail({ toEmail, order, items, isBIR: rcpType === 'bir' });
        auditLog({ orderId, action: 'RECEIPT_SENT', actor: { userId: body.userId },
          newValue: `resend:${toEmail}`, details: { type: rcpType, emailId } });
        return res.status(200).json({ ok: true, emailId, message: `Receipt resent to ${toEmail}` });
      } catch (e) {
        return res.status(500).json({ ok: false, error: `Email failed: ${e.message}` });
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // PAYMENT ACTIONS
    // ══════════════════════════════════════════════════════════════════════

    // ── uploadPayment ──────────────────────────────────────────────────────
    if (action === 'uploadPayment') {
      const orderId      = String(body.orderId      || '').trim();
      const tableNo      = String(body.tableNo      || '').trim();
      const customerName = String(body.customerName || '').trim().substring(0, 100);
      const amount       = parseFloat(body.amount) || 0;
      const notes        = String(body.notes        || '').trim().substring(0, 500);
      const imageData    = body.imageData || '';
      const filename     = String(body.filename     || '').trim().substring(0, 200);

      if (!orderId) return res.status(400).json({ ok: false, error: 'orderId is required' });
      if (amount <= 0) return res.status(400).json({ ok: false, error: 'amount must be positive' });

      // Generate payment ID
      const paymentId = `PAY-${Date.now().toString(36).toUpperCase()}`;

      // Store image as base64 data URL in proof_url (for now — can be upgraded to S3 later)
      const proofUrl = imageData || '';

      const payRow = {
        payment_id:     paymentId,
        order_id:       orderId,
        order_type:     'DINE-IN',
        amount,
        method:         String(body.paymentMethod || 'GCASH').toUpperCase(), // DB column is 'method'
        payment_method: String(body.paymentMethod || 'GCASH').toUpperCase(), // extra col for compat
        proof_url:      proofUrl,
        proof_filename: filename,
        status:         'PENDING',
      };
      const r = await supa('POST', 'payments', payRow);
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to submit payment' });

      // Update order payment status
      await supa('PATCH', 'dine_in_orders', {
        payment_status: 'SUBMITTED',
        payment_method: 'GCASH',
      }, { order_id: `eq.${orderId}` });

      logSync('payments', paymentId, 'INSERT');
      return res.status(200).json({ ok: true, paymentId });
    }

    // ── listPayments ───────────────────────────────────────────────────────
    if (action === 'listPayments') {
      const authLP = await requireAdminRole(body);
      if (!authLP.ok) return res.status(403).json({ ok: false, error: authLP.error });

      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/payments?order=created_at.desc&limit=200`
      );
      if (!r.ok) return res.status(502).json({ ok: false, payments: [], error: 'Failed to load payments' });

      const payments = r.data.map(p => ({
        paymentId:    p.payment_id,
        orderId:      p.order_id,
        orderType:    p.order_type,
        amount:       p.amount,
        paymentMethod: p.payment_method,
        imageUrl:     p.proof_url,
        filename:     p.proof_filename,
        status:       p.status,
        verifiedBy:   p.verified_by || '',
        verifiedAt:   p.verified_at || '',
        notes:        p.rejection_reason || '',
        createdAt:    p.created_at,
      }));

      return res.status(200).json({ ok: true, payments });
    }

    // ── verifyPayment ──────────────────────────────────────────────────────
    if (action === 'verifyPayment') {
      const paymentId  = String(body.paymentId  || '').trim();
      const authVP     = await requireAdminRole(body);
      if (!authVP.ok) return res.status(403).json({ ok: false, error: authVP.error });
      if (!paymentId) return res.status(400).json({ ok: false, error: 'paymentId is required' });

      const r = await supa('PATCH', 'payments', {
        status:      'VERIFIED',
        verified_by: String(body.userId || 'Staff').trim(),
        verified_at: new Date().toISOString(),
      }, { payment_id: `eq.${paymentId}` });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to verify payment' });

      // Get the order_id to update order payment status
      const payR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/payments?payment_id=eq.${encodeURIComponent(paymentId)}&select=order_id`
      );
      if (payR.ok && payR.data.length > 0) {
        await supa('PATCH', 'dine_in_orders', { payment_status: 'VERIFIED' }, { order_id: `eq.${payR.data[0].order_id}` });
      }

      logSync('payments', paymentId, 'UPDATE');
      return res.status(200).json({ ok: true, paymentId });
    }

    // ── rejectPayment ──────────────────────────────────────────────────────
    if (action === 'rejectPayment') {
      const paymentId  = String(body.paymentId  || '').trim();
      const reason     = String(body.reason     || '').trim().substring(0, 500);
      const verifiedBy = String(body.verifiedBy || 'Staff').trim().substring(0, 100);
      if (!paymentId) return res.status(400).json({ ok: false, error: 'paymentId is required' });

      const r = await supa('PATCH', 'payments', {
        status:           'REJECTED',
        verified_by:      verifiedBy,
        verified_at:      new Date().toISOString(),
        rejection_reason: reason,
      }, { payment_id: `eq.${paymentId}` });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to reject payment' });

      // Get the order_id to update order payment status
      const payR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/payments?payment_id=eq.${encodeURIComponent(paymentId)}&select=order_id`
      );
      if (payR.ok && payR.data.length > 0) {
        await supa('PATCH', 'dine_in_orders', { payment_status: 'REJECTED' }, { order_id: `eq.${payR.data[0].order_id}` });
      }

      logSync('payments', paymentId, 'UPDATE');
      return res.status(200).json({ ok: true, paymentId });
    }

    // ══════════════════════════════════════════════════════════════════════
    // AUTH ACTIONS
    // ══════════════════════════════════════════════════════════════════════

    // ── changePin ──────────────────────────────────────────────────────────
    if (action === 'changePin') {
      // Requires OWNER or ADMIN to change any PIN
      // OR the user themselves (must provide currentPin to verify identity)
      const targetUserId = String(body.targetUserId || '').trim();
      const newPin       = String(body.newPin || '').trim();
      const currentPin   = String(body.currentPin || '').trim();

      if (!targetUserId) return res.status(400).json({ ok: false, error: 'targetUserId is required' });
      if (!newPin || newPin.length < 4) return res.status(400).json({ ok: false, error: 'New PIN must be at least 4 digits' });
      if (!/^\d{4,8}$/.test(newPin)) return res.status(400).json({ ok: false, error: 'PIN must be 4-8 digits only' });

      // Fetch the target user
      const targetR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/staff_users?user_id=eq.${encodeURIComponent(targetUserId)}&active=eq.true&select=user_id,pin_hash,role`
      );
      if (!targetR.ok || !targetR.data?.length) {
        return res.status(404).json({ ok: false, error: 'User not found' });
      }
      const targetUser = targetR.data[0];

      // Auth check:
      // 1. OWNER/ADMIN changing any PIN (including their own) — always allowed, no currentPin needed
      // 2. CASHIER/KITCHEN changing their own PIN — must provide currentPin
      const requesterId = String(body.userId || '').trim();
      let authorized = false;
      let requesterRole = null;

      if (requesterId) {
        const reqR = await supaFetch(
          `${SUPABASE_URL}/rest/v1/staff_users?user_id=eq.${encodeURIComponent(requesterId)}&active=eq.true&select=role`
        );
        if (reqR.ok && reqR.data?.length) requesterRole = reqR.data[0].role;
      }

      if (requesterRole === 'OWNER' || requesterRole === 'ADMIN') {
        // OWNER/ADMIN can change any PIN — no current PIN required
        authorized = true;
      } else if (currentPin) {
        // Non-admin (or no userId sent) changing their own PIN — verify current PIN
        authorized = await bcrypt.compare(currentPin, targetUser.pin_hash);
        if (!authorized) return res.status(401).json({ ok: false, error: 'Current PIN is incorrect' });
      }

      if (!authorized) return res.status(401).json({ ok: false, error: 'Unauthorized to change this PIN' });

      // Hash new PIN and save
      const newHash = await bcrypt.hash(newPin, 12);
      const upd = await supa('PATCH', 'staff_users',
        { pin_hash: newHash, failed_attempts: 0, locked_until: null },
        { user_id: `eq.${targetUserId}` }
      );
      if (!upd.ok) return res.status(500).json({ ok: false, error: 'Failed to update PIN' });

      return res.status(200).json({ ok: true, message: 'PIN updated successfully' });
    }

    // ── verifyUserPin ──────────────────────────────────────────────────────
    if (action === 'verifyUserPin') {
      const pin = String(body.pin || '').trim();
      if (!pin || pin.length < 4) return res.status(400).json({ ok: false, error: 'PIN is required' });

      // Fetch all active staff — we need to bcrypt.compare against each hash
      // (bcrypt cannot reverse-lookup; we must compare, not query by hash)
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/staff_users?active=eq.true&select=user_id,username,display_name,role,pin_hash,failed_attempts,locked_until`
      );
      if (!r.ok || !r.data) return res.status(500).json({ ok: false, error: 'Auth service error' });

      // Find matching user — try each active staff member
      let matchedUser = null;
      for (const candidate of r.data) {
        if (!candidate.pin_hash) continue;
        try {
          const match = await bcrypt.compare(pin, candidate.pin_hash);
          if (match) { matchedUser = candidate; break; }
        } catch { continue; } // malformed hash — skip
      }

      if (!matchedUser) {
        return res.status(200).json({ ok: false, error: 'Invalid PIN' });
      }

      // Check if account is locked
      if (matchedUser.locked_until && new Date(matchedUser.locked_until) > new Date()) {
        return res.status(200).json({ ok: false, error: 'Account locked. Please try again later.' });
      }

      // PIN correct — reset counters, update last_login
      await supa('PATCH', 'staff_users', {
        last_login:      new Date().toISOString(),
        failed_attempts: 0,
        locked_until:    null,
      }, { user_id: `eq.${matchedUser.user_id}` });

      return res.status(200).json({
        ok: true,
        userId:      matchedUser.user_id,
        username:    matchedUser.username,
        displayName: matchedUser.display_name,
        role:        matchedUser.role,
        user: {
          userId:      matchedUser.user_id,
          username:    matchedUser.username,
          displayName: matchedUser.display_name,
          role:        matchedUser.role,
        },
      });
    }

    // ══════════════════════════════════════════════════════════════════════
    // ONLINE ORDER ACTIONS (pass-through to Supabase)
    // ══════════════════════════════════════════════════════════════════════

    // ── getOnlineOrders ────────────────────────────────────────────────────
    if (action === 'getOnlineOrders') {
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/online_orders?order=created_at.desc&limit=200`
      );
      const rows = r.ok ? r.data : [];
      const orders = rows.map(o => ({
        orderRef:            o.order_ref,
        date:                o.created_at,
        customerName:        o.customer_name,
        phone:               o.customer_phone,
        email:               o.customer_email || '',
        pickupTime:          o.pickup_time || '',
        courierType:         o.courier_type || 'PICKUP',
        subtotal:            o.subtotal,
        totalAmount:         o.total_amount,
        paymentMethod:       o.payment_method,
        paymentStatus:       o.payment_status,
        orderStatus:         o.status,
        specialInstructions: o.special_instructions || '',
        adminNotes:          o.admin_notes || '',
        lastUpdated:         o.updated_at,
      }));
      return res.status(200).json({ success: true, orders });
    }

    // ── getCustomers ───────────────────────────────────────────────────────
    // ── createReservation ─────────────────────────────────────────────────
    if (action === 'createReservation') {
      // ONLINE bookings (no userId) are allowed — staff bookings require admin role
      const isOnline = !body.userId;
      if (!isOnline) {
        const authR = await requireAdminRole(body);
        if (!authR.ok) return res.status(401).json({ ok: false, error: authR.error });
      }

      const { guestName, guestPhone, guestEmail, tableNo, pax, resDate, resTime,
              notes, occasion, seatingPref, dietary } = body;

      if (!guestName || !resDate || !resTime)
        return res.status(400).json({ ok: false, error: 'guestName, resDate, resTime are required' });

      // Online bookings don't pick a specific table — staff assigns one
      const table = tableNo ? parseInt(tableNo) : null;
      if (table !== null && (table < 1 || table > 10))
        return res.status(400).json({ ok: false, error: 'tableNo must be 1-10' });

      // Validate date not in the past
      const today = new Date().toISOString().slice(0, 10);
      if (resDate < today)
        return res.status(400).json({ ok: false, error: 'Reservation date cannot be in the past' });

      // Get next res_id
      const seqR = await supaFetch(`${SUPABASE_URL}/rest/v1/rpc/get_next_res_id`, {
        method: 'POST', body: JSON.stringify({})
      });
      const resId = seqR.ok ? seqR.data : `RES-${Date.now()}`;

      const r = await supa('POST', 'reservations', {
        res_id:       resId,
        table_no:     table,
        guest_name:   String(guestName).trim(),
        guest_phone:  guestPhone  ? String(guestPhone).trim()  : null,
        guest_email:  guestEmail  ? String(guestEmail).trim()  : null,
        pax:          parseInt(pax) || 1,
        res_date:     resDate,
        res_time:     resTime,
        notes:        notes       ? String(notes).trim()       : null,
        occasion:     occasion    ? String(occasion).trim()    : null,
        seating_pref: seatingPref ? String(seatingPref).trim() : null,
        dietary:      dietary     ? String(dietary).trim()     : null,
        source:       isOnline ? 'ONLINE' : 'STAFF',
        status:       'CONFIRMED',
      });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to create reservation' });
      return res.status(200).json({ ok: true, resId });
    }

    // ── getTables ──────────────────────────────────────────────────────────
    if (action === 'getTables') {
      const authR = await requireAuth(body);
      if (!authR.ok) return res.status(401).json({ ok: false, error: authR.error });
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/cafe_tables?order=table_number.asc&select=table_number,qr_token,table_name,capacity`
      );
      return res.status(200).json({ ok: true, tables: r.data || [] });
    }

    // ── updateTable ────────────────────────────────────────────────────────
    if (action === 'updateTable') {
      const authR = await requireAdminRole(body);
      if (!authR.ok) return res.status(401).json({ ok: false, error: authR.error });
      const { tableNo, tableName, capacity } = body;
      if (!tableNo) return res.status(400).json({ ok: false, error: 'tableNo required' });
      const updates = {};
      if (tableName !== undefined) updates.table_name = String(tableName).trim().slice(0, 50);
      if (capacity !== undefined) updates.capacity = parseInt(capacity) || 4;
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/cafe_tables?table_number=eq.${encodeURIComponent(tableNo)}`,
        { method: 'PATCH', body: JSON.stringify(updates) }
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to update table' });
      return res.status(200).json({ ok: true });
    }

    // ── deleteTable ────────────────────────────────────────────────────────
    if (action === 'deleteTable') {
      const authR = await requireAdminRole(body);
      if (!authR.ok) return res.status(401).json({ ok: false, error: authR.error });
      const { tableNo } = body;
      if (!tableNo) return res.status(400).json({ ok: false, error: 'tableNo required' });
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/cafe_tables?table_number=eq.${encodeURIComponent(tableNo)}`,
        { method: 'DELETE' }
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to delete table' });
      return res.status(200).json({ ok: true });
    }

    // ── addTable ───────────────────────────────────────────────────────────
    if (action === 'addTable') {
      const authR = await requireAdminRole(body);
      if (!authR.ok) return res.status(401).json({ ok: false, error: authR.error });
      const tableNo = parseInt(body.tableNo);
      if (!tableNo || tableNo < 1 || tableNo > 99)
        return res.status(400).json({ ok: false, error: 'Invalid table number (1-99)' });
      // Generate random 8-char hex token
      const token = Array.from({length:8}, () => Math.floor(Math.random()*16).toString(16)).join('');
      const tableName = body.tableName ? String(body.tableName).trim().slice(0,50) : `Table ${tableNo}`;
      const capacity = parseInt(body.capacity) || 4;
      const r = await supa('POST', 'cafe_tables', { table_number: tableNo, qr_token: token, table_name: tableName, capacity });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to add table — may already exist' });
      return res.status(200).json({ ok: true, tableNo, token });
    }

    // ── getReservations ────────────────────────────────────────────────────
    if (action === 'getReservations') {
      const authR = await requireAdminRole(body);
      if (!authR.ok) return res.status(401).json({ ok: false, error: authR.error });

      const date = body.date ? String(body.date) : new Date().toISOString().slice(0,10);
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/reservations?res_date=eq.${date}&status=neq.CANCELLED&order=res_time.asc&select=*`
      );
      return res.status(200).json({ ok: true, reservations: r.data || [] });
    }

    // ── updateReservation ──────────────────────────────────────────────────
    if (action === 'updateReservation') {
      const authR = await requireAdminRole(body);
      if (!authR.ok) return res.status(401).json({ ok: false, error: authR.error });

      const { resId, status, notes } = body;
      if (!resId) return res.status(400).json({ ok: false, error: 'resId is required' });
      const validStatuses = ['CONFIRMED','SEATED','COMPLETED','CANCELLED','NO_SHOW'];
      if (status && !validStatuses.includes(status))
        return res.status(400).json({ ok: false, error: 'Invalid status' });

      const patch = {};
      if (status) patch.status = status;
      if (notes !== undefined) patch.notes = notes;

      const r = await supa('PATCH', 'reservations', patch, { res_id: `eq.${resId}` });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to update reservation' });
      return res.status(200).json({ ok: true });
    }

    if (action === 'getCustomers') {
      const authGC = await requireAdminRole(body);
      if (!authGC.ok) return res.status(401).json({ ok: false, error: authGC.error });
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/online_orders?order=created_at.asc&limit=500&select=customer_phone,customer_name,created_at,total_amount,order_ref`
      );
      const rows = r.ok ? r.data : [];
      const custMap = {};
      rows.forEach(o => {
        const phone = o.customer_phone || 'Unknown';
        if (!custMap[phone]) {
          custMap[phone] = {
            phone,
            customerName:   o.customer_name,
            firstOrderDate: o.created_at,
            lastOrderDate:  o.created_at,
            totalOrders:    0,
            totalSpend:     0,
          };
        }
        custMap[phone].lastOrderDate  = o.created_at;
        custMap[phone].totalOrders   += 1;
        custMap[phone].totalSpend    += parseFloat(o.total_amount || 0);
      });
      const customers = Object.values(custMap)
        .sort((a, b) => new Date(b.lastOrderDate) - new Date(a.lastOrderDate));
      return res.status(200).json({ ok: true, customers });
    }

    // ── getAnalytics ───────────────────────────────────────────────────────
    if (action === 'getAnalytics') {
      // OWNER / ADMIN only
      const authA = await requireAdminRole(body);
      if (!authA.ok) return res.status(403).json({ ok: false, error: authA.error });

      const BASE = `${SUPABASE_URL}/rest/v1`;
      const H    = { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` };

      // ── Daily revenue last 30 days ─────────────────────────────────────
      const thirtyAgo = new Date(Date.now() - 30*24*3600*1000).toISOString();
      const ordersR = await fetch(
        `${BASE}/dine_in_orders?status=eq.COMPLETED&is_test=eq.false&is_deleted=eq.false&created_at=gte.${thirtyAgo}&select=created_at,total,order_type`,
        { headers: H }
      );
      const orders = ordersR.ok ? (await ordersR.json()) : [];

      // Daily revenue map
      const dailyMap = {};
      orders.forEach(o => {
        const day = o.created_at.slice(0,10);
        if (!dailyMap[day]) dailyMap[day] = { revenue:0, count:0 };
        dailyMap[day].revenue += parseFloat(o.total || 0);
        dailyMap[day].count   += 1;
      });
      const daily = Object.entries(dailyMap)
        .map(([day,v]) => ({ day, revenue: Math.round(v.revenue*100)/100, count: v.count }))
        .sort((a,b) => a.day.localeCompare(b.day));

      // Today vs yesterday
      const todayStr     = new Date().toISOString().slice(0,10);
      const yesterdayStr = new Date(Date.now()-86400000).toISOString().slice(0,10);
      const todayData     = dailyMap[todayStr]     || { revenue:0, count:0 };
      const yesterdayData = dailyMap[yesterdayStr] || { revenue:0, count:0 };

      // Total last 7 days
      const sevenAgoStr = new Date(Date.now()-7*86400000).toISOString().slice(0,10);
      let rev7=0, cnt7=0;
      daily.forEach(d => { if (d.day >= sevenAgoStr) { rev7+=d.revenue; cnt7+=d.count; } });

      // ── Hourly distribution (today) ────────────────────────────────────
      const hourly = Array.from({length:24}, (_,i) => ({ hour:i, count:0, revenue:0 }));
      orders.filter(o => o.created_at.slice(0,10) === todayStr).forEach(o => {
        const h = parseInt(o.created_at.slice(11,13));
        hourly[h].count   += 1;
        hourly[h].revenue += parseFloat(o.total || 0);
      });

      // ── Order type split (last 30d) ───────────────────────────────────
      const typeSplit = { 'DINE-IN':0, 'TAKE-OUT':0 };
      orders.forEach(o => { typeSplit[o.order_type] = (typeSplit[o.order_type]||0)+1; });

      // ── Top items ─────────────────────────────────────────────────────
      const itemsR = await fetch(
        `${BASE}/dine_in_order_items?select=item_name,qty,line_total,order_id`,
        { headers: H }
      );
      const rawItems = itemsR.ok ? (await itemsR.json()) : [];

      // Filter items to completed, non-test orders only
      // dine_in_order_items.order_id matches dine_in_orders.order_id (e.g. "YANI-1063")
      const ordersWithId = await fetch(
        `${BASE}/dine_in_orders?status=eq.COMPLETED&is_test=eq.false&is_deleted=eq.false&created_at=gte.${thirtyAgo}&select=order_id`,
        { headers: H }
      );
      const completedIds = new Set((ordersWithId.ok ? await ordersWithId.json() : []).map(o=>o.order_id));

      const itemMap = {};
      rawItems.forEach(i => {
        if (!completedIds.has(i.order_id)) return;
        const name = i.item_name || 'Unknown';
        if (!itemMap[name]) itemMap[name] = { name, qty:0, revenue:0 };
        itemMap[name].qty     += parseInt(i.qty || 0);
        itemMap[name].revenue += parseFloat(i.line_total || 0);
      });
      const topItems = Object.values(itemMap)
        .sort((a,b) => b.qty - a.qty)
        .slice(0,10);

      // ── Cancellation stats ────────────────────────────────────────────
      const cancelR = await fetch(
        `${BASE}/dine_in_orders?status=eq.CANCELLED&is_test=eq.false&is_deleted=eq.false&select=cancel_reason`,
        { headers: H }
      );
      const cancelled = cancelR.ok ? (await cancelR.json()) : [];
      const cancelMap = {};
      cancelled.forEach(o => {
        const r = o.cancel_reason || 'unspecified';
        cancelMap[r] = (cancelMap[r]||0)+1;
      });
      const realCancels = cancelled.filter(o => o.cancel_reason !== 'migration_cleanup').length;

      // ── Payment method breakdown (last 30d completed orders) ──────────
      const payR = await fetch(
        `${BASE}/dine_in_orders?status=eq.COMPLETED&is_test=eq.false&is_deleted=eq.false&created_at=gte.${thirtyAgo}&select=payment_method,total,discounted_total,discount_amount`,
        { headers: H }
      );
      const payOrders = payR.ok ? (await payR.json()) : [];
      const payBreakdown = {};
      let totalDiscounts30d = 0;
      payOrders.forEach(o => {
        const m = o.payment_method || 'UNRECORDED';
        if (!payBreakdown[m]) payBreakdown[m] = { count:0, revenue:0 };
        payBreakdown[m].count   += 1;
        payBreakdown[m].revenue += parseFloat(o.discounted_total || o.total || 0);
        totalDiscounts30d += parseFloat(o.discount_amount || 0);
      });

      return res.status(200).json({
        ok: true,
        // Flat aliases for dashboard compatibility
        todaySales:  Math.round(todayData.revenue*100)/100,
        todayOrders: todayData.count,
        summary: {
          today:     { revenue: Math.round(todayData.revenue*100)/100,     orders: todayData.count },
          yesterday: { revenue: Math.round(yesterdayData.revenue*100)/100, orders: yesterdayData.count },
          last7days: { revenue: Math.round(rev7*100)/100,                  orders: cnt7 },
          realCancellations: realCancels,
          totalOrders30d: orders.length,
          typeSplit,
          totalDiscounts30d: Math.round(totalDiscounts30d*100)/100,
        },
        daily,
        hourly,
        topItems,
        cancelBreakdown: cancelMap,
        paymentBreakdown: payBreakdown,
      });
    }

    // ── getStaff ───────────────────────────────────────────────────────────
    // ── getAuditLogs ───────────────────────────────────────────────────────
    if (action === 'getAuditLogs') {
      const authA = await requireAdminRole(body);
      if (!authA.ok) return res.status(403).json({ ok: false, error: authA.error });
      const orderId = body.orderId ? String(body.orderId).trim() : null;
      const limit   = Math.min(parseInt(body.limit) || 100, 500);
      let url = `${SUPABASE_URL}/rest/v1/order_audit_logs?order=created_at.desc&limit=${limit}`;
      if (orderId) url += `&order_id=eq.${encodeURIComponent(orderId)}`;
      const r = await supaFetch(url);
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to fetch audit logs' });
      return res.status(200).json({ ok: true, logs: r.data || [] });
    }

    if (action === 'getStaff') {
      const authS = await requireAdminRole(body);
      if (!authS.ok) return res.status(403).json({ ok: false, error: authS.error });
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/staff_users?active=eq.true&order=user_id.asc&select=user_id,username,display_name,role,last_login,failed_attempts`
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to fetch staff' });
      const staffList = r.data || [];
      return res.status(200).json({ ok: true, staff: staffList, users: staffList });
    }

    // ── getSettings ────────────────────────────────────────────────────────
    if (action === 'getSettings') {
      const r = await supaFetch(`${SUPABASE_URL}/rest/v1/settings?order=key.asc&select=key,value,description`);
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to fetch settings' });
      return res.status(200).json({ ok: true, settings: r.data || [] });
    }

    // ── updateSetting ──────────────────────────────────────────────────────
    if (action === 'updateSetting') {
      const authUS = await requireAdminRole(body);
      if (!authUS.ok) return res.status(403).json({ ok: false, error: authUS.error });
      const { key, value } = body;
      if (!key) return res.status(400).json({ ok: false, error: 'key is required' });
      // Validate VAT-specific values
      if (key === 'VAT_ENABLED' && !['true','false'].includes(value)) {
        return res.status(400).json({ ok: false, error: 'VAT_ENABLED must be true or false' });
      }
      if (key === 'VAT_RATE') {
        const n = parseFloat(value);
        if (isNaN(n) || n < 0 || n > 1) return res.status(400).json({ ok: false, error: 'VAT_RATE must be between 0 and 1 (e.g. 0.12 for 12%)' });
      }
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/settings?key=eq.${encodeURIComponent(key)}`,
        { method: 'PATCH', body: JSON.stringify({ value: String(value), updated_at: new Date().toISOString() }) }
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to update setting' });
      return res.status(200).json({ ok: true, key, value });
    }


    // ══════════════════════════════════════════════════════════════════════
    // TABLE OCCUPANCY STATUS
    // ══════════════════════════════════════════════════════════════════════

    // ── getTableStatus ─────────────────────────────────────────────────────
    if (action === 'getTableStatus') {
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/cafe_tables?select=id,table_number,table_name,capacity,qr_token,status&order=table_number.asc`
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to fetch tables' });
      return res.status(200).json({ ok: true, tables: r.data || [] });
    }

    // ── setTableStatus ─────────────────────────────────────────────────────
    if (action === 'setTableStatus') {
      const auth = await requireAuth(body, ['OWNER','ADMIN','CASHIER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { tableNumber, status } = body;
      const valid = ['AVAILABLE','OCCUPIED','RESERVED','MAINTENANCE'];
      if (!valid.includes(status)) return res.status(400).json({ ok: false, error: 'Invalid status' });
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/cafe_tables?table_number=eq.${encodeURIComponent(tableNumber)}`,
        { method: 'PATCH', body: JSON.stringify({ status }) }
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to update table status' });
      return res.status(200).json({ ok: true, tableNumber, status });
    }

    // ══════════════════════════════════════════════════════════════════════
    // RESERVATIONS ↔ TABLE AUTO-LINK
    // ══════════════════════════════════════════════════════════════════════

    // ── linkReservationTable ───────────────────────────────────────────────
    if (action === 'linkReservationTable') {
      const auth = await requireAuth(body, ['OWNER','ADMIN','CASHIER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { resId, tableNumber } = body;
      if (!resId) return res.status(400).json({ ok: false, error: 'resId required' });

      // Get table UUID from number
      let tableId = null;
      if (tableNumber) {
        const tRes = await supaFetch(
          `${SUPABASE_URL}/rest/v1/cafe_tables?table_number=eq.${encodeURIComponent(tableNumber)}&select=id`
        );
        if (tRes.ok && tRes.data && tRes.data[0]) tableId = tRes.data[0].id;
      }

      // Update reservation
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/reservations?res_id=eq.${encodeURIComponent(resId)}`,
        { method: 'PATCH', body: JSON.stringify({
          table_id: tableId,
          confirmed_by: body.userId,
          status: tableNumber ? 'CONFIRMED' : 'CONFIRMED'
        })}
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to link reservation' });

      // Auto-set table to RESERVED if tableNumber provided
      if (tableNumber) {
        await supaFetch(
          `${SUPABASE_URL}/rest/v1/cafe_tables?table_number=eq.${encodeURIComponent(tableNumber)}`,
          { method: 'PATCH', body: JSON.stringify({ status: 'RESERVED' }) }
        );
      }
      return res.status(200).json({ ok: true, resId, tableNumber, tableId });
    }

    // ── seatReservation ────────────────────────────────────────────────────
    if (action === 'seatReservation') {
      const auth = await requireAuth(body, ['OWNER','ADMIN','CASHIER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { resId } = body;

      // Get reservation to find linked table
      const resRes = await supaFetch(
        `${SUPABASE_URL}/rest/v1/reservations?res_id=eq.${encodeURIComponent(resId)}&select=table_id,status`
      );
      if (!resRes.ok || !resRes.data || !resRes.data[0]) {
        return res.status(404).json({ ok: false, error: 'Reservation not found' });
      }
      const res_rec = resRes.data[0];

      // Mark reservation SEATED
      await supaFetch(
        `${SUPABASE_URL}/rest/v1/reservations?res_id=eq.${encodeURIComponent(resId)}`,
        { method: 'PATCH', body: JSON.stringify({ status: 'SEATED' }) }
      );

      // Set table OCCUPIED
      if (res_rec.table_id) {
        await supaFetch(
          `${SUPABASE_URL}/rest/v1/cafe_tables?id=eq.${res_rec.table_id}`,
          { method: 'PATCH', body: JSON.stringify({ status: 'OCCUPIED' }) }
        );
      }
      return res.status(200).json({ ok: true, resId, status: 'SEATED' });
    }

    // ══════════════════════════════════════════════════════════════════════
    // INVENTORY
    // ══════════════════════════════════════════════════════════════════════

    // ── getInventory ───────────────────────────────────────────────────────
    if (action === 'getInventory') {
      const auth = await requireAuth(body, ['OWNER','ADMIN','CASHIER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/inventory?select=*&order=item_code.asc`
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to fetch inventory' });
      // Attach menu item names
      const menuR = await supaFetch(`${SUPABASE_URL}/rest/v1/menu_items?select=item_code,name,is_active`);
      const menuMap = {};
      (menuR.data || []).forEach(m => { menuMap[m.item_code] = m; });
      const items = (r.data || []).map(i => ({
        ...i,
        item_name: menuMap[i.item_code]?.name || i.item_code,
        item_active: menuMap[i.item_code]?.is_active ?? true,
        low_stock: i.stock_qty <= i.low_stock_threshold,
      }));
      return res.status(200).json({ ok: true, items });
    }

    // ── upsertInventory ────────────────────────────────────────────────────
    if (action === 'upsertInventory') {
      const auth = await requireAdminRole(body);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { itemCode, stockQty, lowStockThreshold, unit, costPerUnit, autoDisable, restockNotes } = body;
      if (!itemCode) return res.status(400).json({ ok: false, error: 'itemCode required' });
      const row = {
        item_code: itemCode,
        stock_qty: parseFloat(stockQty) || 0,
        low_stock_threshold: parseFloat(lowStockThreshold) || 10,
        unit: unit || 'pcs',
        cost_per_unit: parseFloat(costPerUnit) || 0,
        auto_disable: !!autoDisable,
        restock_notes: restockNotes || '',
        last_restocked_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      // Try PATCH first (update existing), fallback to POST (create new)
      const existsR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/inventory?item_code=eq.${encodeURIComponent(itemCode)}&select=id`
      );
      const exists = Array.isArray(existsR.data) && existsR.data.length > 0;
      const r = exists
        ? await supaFetch(
            `${SUPABASE_URL}/rest/v1/inventory?item_code=eq.${encodeURIComponent(itemCode)}`,
            { method: 'PATCH', body: JSON.stringify(row) }
          )
        : await supaFetch(
            `${SUPABASE_URL}/rest/v1/inventory`,
            { method: 'POST', body: JSON.stringify(row),
              headers: { Prefer: 'return=representation' } }
          );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to save inventory' });
      // Log restock
      await supaFetch(`${SUPABASE_URL}/rest/v1/inventory_log`, {
        method: 'POST',
        body: JSON.stringify({
          item_code: itemCode, change_type: 'RESTOCK',
          qty_change: parseFloat(stockQty) || 0,
          qty_after: parseFloat(stockQty) || 0,
          notes: restockNotes || 'Manual restock', actor_id: body.userId,
        })
      });
      return res.status(200).json({ ok: true, item: r.data?.[0] || row });
    }

    // ── adjustInventory ────────────────────────────────────────────────────
    if (action === 'adjustInventory') {
      const auth = await requireAdminRole(body);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { itemCode, adjustment, changeType, notes } = body;
      if (!itemCode || adjustment === undefined) return res.status(400).json({ ok: false, error: 'itemCode + adjustment required' });
      const validTypes = ['RESTOCK','ADJUSTMENT','WASTE','RETURN'];
      const type = validTypes.includes(changeType) ? changeType : 'ADJUSTMENT';
      // Get current
      const cur = await supaFetch(`${SUPABASE_URL}/rest/v1/inventory?item_code=eq.${encodeURIComponent(itemCode)}&select=stock_qty,auto_disable`);
      const current = cur.data?.[0];
      if (!current) return res.status(404).json({ ok: false, error: 'Item not in inventory' });
      const newQty = Math.max(0, parseFloat(current.stock_qty) + parseFloat(adjustment));
      await supaFetch(`${SUPABASE_URL}/rest/v1/inventory?item_code=eq.${encodeURIComponent(itemCode)}`,
        { method: 'PATCH', body: JSON.stringify({ stock_qty: newQty, updated_at: new Date().toISOString() }) });
      // Auto-disable menu item if stock hits 0
      if (newQty === 0 && current.auto_disable) {
        await supaFetch(`${SUPABASE_URL}/rest/v1/menu_items?item_code=eq.${encodeURIComponent(itemCode)}`,
          { method: 'PATCH', body: JSON.stringify({ is_active: false }) });
      }
      // Log
      await supaFetch(`${SUPABASE_URL}/rest/v1/inventory_log`, { method: 'POST',
        body: JSON.stringify({ item_code: itemCode, change_type: type,
          qty_before: parseFloat(current.stock_qty), qty_change: parseFloat(adjustment),
          qty_after: newQty, notes: notes || '', actor_id: body.userId }) });
      return res.status(200).json({ ok: true, itemCode, qtyBefore: current.stock_qty, qtyAfter: newQty });
    }

    // ── getInventoryLog ────────────────────────────────────────────────────
    if (action === 'getInventoryLog') {
      const auth = await requireAuth(body, ['OWNER','ADMIN']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const limit = Math.min(parseInt(body.limit) || 50, 200);
      const filter = body.itemCode ? `&item_code=eq.${encodeURIComponent(body.itemCode)}` : '';
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/inventory_log?select=*&order=created_at.desc&limit=${limit}${filter}`
      );
      return res.status(200).json({ ok: r.ok, logs: r.data || [] });
    }

    // ══════════════════════════════════════════════════════════════════════
    // ADD-ONS / MODIFIERS
    // ══════════════════════════════════════════════════════════════════════

    // ── getAddons ──────────────────────────────────────────────────────────
    if (action === 'getAddons') {
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/menu_addons?is_active=eq.true&order=sort_order.asc,name.asc`
      );
      return res.status(200).json({ ok: r.ok, addons: r.data || [] });
    }

    // ── getAddonsAdmin ─────────────────────────────────────────────────────
    if (action === 'getAddonsAdmin') {
      const auth = await requireAdminRole(body);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/menu_addons?order=sort_order.asc,name.asc`
      );
      return res.status(200).json({ ok: r.ok, addons: r.data || [] });
    }

    // ── saveAddon ──────────────────────────────────────────────────────────
    if (action === 'saveAddon') {
      const auth = await requireAdminRole(body);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { addonCode, name, price, appliesToAll, appliesToCodes, sortOrder } = body;
      if (!name) return res.status(400).json({ ok: false, error: 'name required' });
      const code = addonCode || 'ADD-' + Date.now();
      const row = {
        addon_code: code, name: String(name).trim().substring(0, 80),
        price: parseFloat(price) || 0,
        applies_to_all: appliesToAll !== false,
        applies_to_codes: Array.isArray(appliesToCodes) ? appliesToCodes : [],
        is_active: body.isActive !== false,
        sort_order: parseInt(sortOrder) || 0,
        updated_at: new Date().toISOString(),
      };
      const method = addonCode ? 'PATCH' : 'POST';
      const url = addonCode
        ? `${SUPABASE_URL}/rest/v1/menu_addons?addon_code=eq.${encodeURIComponent(addonCode)}`
        : `${SUPABASE_URL}/rest/v1/menu_addons`;
      const r = await supaFetch(url, { method, body: JSON.stringify(row),
        headers: method === 'POST' ? { Prefer: 'return=representation' } : {} });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to save addon' });
      return res.status(200).json({ ok: true, addon: method === 'POST' ? r.data?.[0] : row });
    }

    // ── deleteAddon ────────────────────────────────────────────────────────
    if (action === 'deleteAddon') {
      const auth = await requireAdminRole(body);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { addonCode } = body;
      if (!addonCode) return res.status(400).json({ ok: false, error: 'addonCode required' });
      // Soft delete
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/menu_addons?addon_code=eq.${encodeURIComponent(addonCode)}`,
        { method: 'PATCH', body: JSON.stringify({ is_active: false, updated_at: new Date().toISOString() }) }
      );
      return res.status(200).json({ ok: r.ok });
    }

    // ══════════════════════════════════════════════════════════════════════
    // VOID / REFUND WORKFLOW
    // ══════════════════════════════════════════════════════════════════════

    // ── processRefund ──────────────────────────────────────────────────────
    if (action === 'processRefund') {
      const auth = await requireAuth(body, ['OWNER','ADMIN']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { orderId, refundType, refundAmount, reasonCode, reasonNote, refundMethod, itemsRefunded } = body;
      const validTypes = ['FULL','PARTIAL','VOID'];
      const validReasons = ['WRONG_ORDER','DUPLICATE','COMPLAINT','OVERCHARGE','ITEM_UNAVAILABLE','OTHER'];
      if (!orderId) return res.status(400).json({ ok: false, error: 'orderId required' });
      if (!validTypes.includes(refundType)) return res.status(400).json({ ok: false, error: 'Invalid refundType' });
      if (!validReasons.includes(reasonCode)) return res.status(400).json({ ok: false, error: 'Invalid reasonCode' });
      if (parseFloat(refundAmount) < 0) return res.status(400).json({ ok: false, error: 'refundAmount cannot be negative' });

      // Verify order exists
      const orderRes = await supaFetch(
        `${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}&select=order_id,total,status`
      );
      if (!orderRes.ok || !orderRes.data?.length) return res.status(404).json({ ok: false, error: 'Order not found' });

      const refundId = 'REF-' + Date.now();
      const row = {
        refund_id: refundId,
        order_id: orderId,
        refund_type: refundType,
        refund_amount: parseFloat(refundAmount) || 0,
        reason_code: reasonCode,
        reason_note: reasonNote || '',
        refund_method: refundMethod || '',
        items_refunded: Array.isArray(itemsRefunded) ? itemsRefunded : [],
        processed_by: body.userId,
        status: 'PROCESSED',
      };
      const r = await supaFetch(`${SUPABASE_URL}/rest/v1/refunds`,
        { method: 'POST', body: JSON.stringify(row), headers: { Prefer: 'return=representation' } });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to save refund' });

      // If VOID — cancel the order
      if (refundType === 'VOID') {
        await supaFetch(
          `${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}`,
          { method: 'PATCH', body: JSON.stringify({ status: 'CANCELLED', cancel_reason: `VOID: ${reasonNote || reasonCode}` }) }
        );
      }
      // Audit log
      await supaFetch(`${SUPABASE_URL}/rest/v1/order_audit_logs`, { method: 'POST',
        body: JSON.stringify({ order_id: orderId, action: 'REFUND_PROCESSED',
          actor_id: body.userId, actor_name: auth.role,
          details: { refundId, refundType, refundAmount, reasonCode } }) });

      return res.status(200).json({ ok: true, refundId, refundType, refundAmount });
    }

    // ── getRefunds ─────────────────────────────────────────────────────────
    if (action === 'getRefunds') {
      const auth = await requireAuth(body, ['OWNER','ADMIN']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const limit = Math.min(parseInt(body.limit) || 50, 200);
      const filter = body.orderId ? `&order_id=eq.${encodeURIComponent(body.orderId)}` : '';
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/refunds?select=*&order=created_at.desc&limit=${limit}${filter}`
      );
      return res.status(200).json({ ok: r.ok, refunds: r.data || [] });
    }

    // ══════════════════════════════════════════════════════════════════════
    // CASH DRAWER / EOD RECONCILIATION
    // ══════════════════════════════════════════════════════════════════════

    // ── openCashSession ────────────────────────────────────────────────────
    if (action === 'openCashSession') {
      const auth = await requireAuth(body, ['OWNER','ADMIN','CASHIER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      // Check no session is already open
      const existing = await supaFetch(
        `${SUPABASE_URL}/rest/v1/cash_sessions?status=eq.OPEN&select=session_id,opened_at,opened_by`
      );
      if (existing.ok && existing.data?.length) {
        return res.status(200).json({ ok: false, error: 'A cash session is already open',
          existingSession: existing.data[0] });
      }
      const sessionId = 'CASH-' + Date.now();
      const row = {
        session_id: sessionId,
        shift: body.shift || 'AM',
        opened_by: body.userId,
        opening_float: parseFloat(body.openingFloat) || 0,
        status: 'OPEN',
        opened_at: new Date().toISOString(),
      };
      const r = await supaFetch(`${SUPABASE_URL}/rest/v1/cash_sessions`,
        { method: 'POST', body: JSON.stringify(row), headers: { Prefer: 'return=representation' } });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to open cash session' });
      return res.status(200).json({ ok: true, sessionId, shift: row.shift, openingFloat: row.opening_float });
    }

    // ── closeCashSession ───────────────────────────────────────────────────
    if (action === 'closeCashSession') {
      const auth = await requireAuth(body, ['OWNER','ADMIN','CASHIER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { sessionId, closingCount, denominationBreakdown, notes } = body;
      if (!sessionId) return res.status(400).json({ ok: false, error: 'sessionId required' });

      // Get session + compute expected cash (cash sales since session opened)
      const sessRes = await supaFetch(
        `${SUPABASE_URL}/rest/v1/cash_sessions?session_id=eq.${encodeURIComponent(sessionId)}&select=*`
      );
      if (!sessRes.ok || !sessRes.data?.length) return res.status(404).json({ ok: false, error: 'Session not found' });
      const sess = sessRes.data[0];

      // Sum cash sales since session opened — use Array.isArray guard to prevent .reduce crash
      const salesRes = await supaFetch(
        `${SUPABASE_URL}/rest/v1/dine_in_orders?status=eq.COMPLETED&is_deleted=eq.false&created_at=gte.${encodeURIComponent(sess.opened_at)}&select=total,payment_method,discounted_total`
      );
      const orders = Array.isArray(salesRes.data) ? salesRes.data : [];
      const totalSales = orders.reduce((s, o) => s + parseFloat(o.discounted_total || o.total || 0), 0);
      const cashSales = orders
        .filter(o => (o.payment_method || '').toUpperCase().includes('CASH'))
        .reduce((s, o) => s + parseFloat(o.discounted_total || o.total || 0), 0);
      const expectedCash = parseFloat(sess.opening_float || 0) + cashSales;
      const closing = parseFloat(closingCount) || 0;
      const variance = closing - expectedCash;

      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/cash_sessions?session_id=eq.${encodeURIComponent(sessionId)}`,
        { method: 'PATCH', body: JSON.stringify({
          closed_by: body.userId,
          closing_count: closing,
          expected_cash: expectedCash,
          variance,
          cash_sales: cashSales,
          total_sales: totalSales,
          denomination_breakdown: denominationBreakdown || {},
          notes: notes || '',
          status: 'CLOSED',
          closed_at: new Date().toISOString(),
        })}
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to close session' });
      return res.status(200).json({
        ok: true, sessionId, totalSales, cashSales,
        openingFloat: sess.opening_float, expectedCash, closingCount: closing, variance,
        overShort: variance >= 0 ? `OVER ₱${Math.abs(variance).toFixed(2)}` : `SHORT ₱${Math.abs(variance).toFixed(2)}`
      });
    }

    // ── getCashSessions ────────────────────────────────────────────────────
    if (action === 'getCashSessions') {
      const auth = await requireAuth(body, ['OWNER','ADMIN']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const limit = Math.min(parseInt(body.limit) || 20, 100);
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/cash_sessions?select=*&order=created_at.desc&limit=${limit}`
      );
      return res.status(200).json({ ok: r.ok, sessions: r.data || [] });
    }

    // ── getOpenCashSession ─────────────────────────────────────────────────
    if (action === 'getOpenCashSession') {
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/cash_sessions?status=eq.OPEN&select=*&order=opened_at.desc&limit=1`
      );
      return res.status(200).json({ ok: r.ok, session: r.data?.[0] || null });
    }

    // ── Unknown action ─────────────────────────────────────────────────────
    return res.status(400).json({ ok: false, error: `Unknown action: ${action}` });

  } catch (err) {
    console.error('API error:', err);
    return res.status(500).json({ ok: false, error: 'Server error: ' + err.message });
  }
}
