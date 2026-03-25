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
  // Opportunistically clean old entries ~1% of calls (avoids table bloat)
  if (Math.random() < 0.01) {
    supaFetch(`${SUPABASE_URL}/rest/v1/rpc/cleanup_old_rate_limits`, {
      method: 'POST', body: JSON.stringify({}),
    }).catch(() => {});
  }
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
// Fires async, never blocks the response.
// GAS SheetsSync.gs reads synced=false rows via time trigger (every 1 min)
// We log synced=false; GAS marks them synced=true after writing to sheet.
function logSync() {} // GAS/Sheets sync removed — no-op

// Stub — no longer pushes directly to GAS
async function pushToSheets() {}

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

async function checkAdminAuth() {
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

// ══════════════════════════════════════════════════════════════════════
// JWT AUTH LAYER — jsonwebtoken (CJS-compatible, ^9.0.2)
import jwt from 'jsonwebtoken';
const JWT_EXPIRY = '12h';

// JWT_SECRET: env var takes priority; falls back to settings table (no redeploy needed).
let _jwtSecret = process.env.JWT_SECRET || null;
async function getJwtSecret() {
  if (_jwtSecret) return _jwtSecret;
  try { _jwtSecret = await getSetting('JWT_SECRET'); } catch (_) {}
  return _jwtSecret;
}

async function signToken(userId, role, displayName) {
  const secret = await getJwtSecret();
  if (!secret) return null;
  try {
    return jwt.sign(
      { sub: userId, role, displayName: displayName || '' },
      secret,
      { expiresIn: JWT_EXPIRY }
    );
  } catch { return null; }
}

async function verifyToken(token) {
  if (!token) return null;
  const secret = await getJwtSecret();
  if (!secret) return null;
  try {
    const payload = jwt.verify(token, secret);
    return { userId: payload.sub, role: payload.role, displayName: payload.displayName || '' };
  } catch { return null; }  // expired / invalid / tampered → fall through to legacy DB auth
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

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

    // ── Identify caller ───────────────────────────────────────────────────
    // Try JWT token from Authorization header first (secure path).
    // Falls back to body.userId lookup in DB (legacy backward-compat path).
    const authHeader = (req.headers.authorization || req.headers.Authorization || '').trim();
    const rawToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const jwtUser = rawToken ? await verifyToken(rawToken) : null;

    // checkAuth(allowedRoles): use inside any action handler instead of requireAuth/requireAdminRole.
    // Returns { ok, role, userId } — no DB hit if JWT is valid.
    async function checkAuth(allowedRoles) {
      if (jwtUser) {
        if (!allowedRoles || !allowedRoles.length || allowedRoles.includes(jwtUser.role)) {
          return { ok: true, role: jwtUser.role, userId: jwtUser.userId };
        }
        return { ok: false, error: 'Unauthorized: insufficient role' };
      }
      // Legacy: validate body.userId against DB
      return requireAuth(body, allowedRoles);
    }
    async function checkAdminAuth() { return checkAuth(['ADMIN', 'OWNER']); }

    // ══════════════════════════════════════════════════════════════════════
    // MENU ACTIONS
    // ══════════════════════════════════════════════════════════════════════const handle_menu = require('./_handlers/menu');
const handle_orders = require('./_handlers/orders');
const handle_payments = require('./_handlers/payments');
const handle_auth = require('./_handlers/auth');
const handle_analytics = require('./_handlers/analytics');
const handle_tables = require('./_handlers/tables');
const handle_settings = require('./_handlers/settings');
const handle_inventory = require('./_handlers/inventory');
const handle_cash = require('./_handlers/cash');

  // ── Route to handler module ──────────────────────────────────────
  const ctx = { supa, supaFetch, checkAuth, checkAdminAuth, auditLog,
    pushToSheets, logSync, invalidateMenuCache, getSetting, menuCache,
    SUPABASE_URL, SUPABASE_KEY, ORDER_PREFIX, SERVICE_CHARGE_RATE,
    isNonEmptyString, isValidPrice, isValidItemCode, isValidOrderId,
    isNonEmptyArray, isValidPhone };

  if (['getMenu', 'getMenuAdmin', 'addMenuItem', 'updateMenuItem', 'deleteMenuItem', 'upsertToSupabase', 'getAddons', 'getAddonsAdmin', 'saveAddon', 'deleteAddon'].includes(action)) {
    return handle_menu(action, body, req, res, ctx);
  }

  if (['placeOrder', 'getOrders', 'updateOrderStatus', 'deleteOrder', 'toggleItemPrepared', 'editOrderItems', 'placePlatformOrder', 'requestReceipt', 'resendReceipt', 'getOnlineOrders'].includes(action)) {
    return handle_orders(action, body, req, res, ctx);
  }

  if (['setPaymentMethod', 'applyDiscount', 'uploadPayment', 'listPayments', 'getPaymentProof', 'migrateProofs', 'verifyPayment', 'rejectPayment', 'processRefund', 'getRefunds'].includes(action)) {
    return handle_payments(action, body, req, res, ctx);
  }

  if (['verifyUserPin', 'changePin', 'getStaff'].includes(action)) {
    return handle_auth(action, body, req, res, ctx);
  }

  if (['getShiftSummary', 'getAnalytics', 'getAuditLogs', 'getCustomers'].includes(action)) {
    return handle_analytics(action, body, req, res, ctx);
  }

  if (['getTables', 'updateTable', 'deleteTable', 'addTable', 'getTableStatus', 'setTableStatus', 'getReservations', 'createReservation', 'updateReservation', 'linkReservationTable', 'seatReservation'].includes(action)) {
    return handle_tables(action, body, req, res, ctx);
  }

  if (['getSettings', 'updateSetting', 'syncToSheets', 'getPendingSync', 'markSynced'].includes(action)) {
    return handle_settings(action, body, req, res, ctx);
  }

  if (['getInventory', 'uploadInventoryPhoto', 'upsertInventory', 'adjustInventory', 'getInventoryLog'].includes(action)) {
    return handle_inventory(action, body, req, res, ctx);
  }

  if (['openCashSession', 'closeCashSession', 'getCashSessions', 'getOpenCashSession'].includes(action)) {
    return handle_cash(action, body, req, res, ctx);
  }

  return res.status(400).json({ ok: false, error: `Unknown action: ${action}` });
}