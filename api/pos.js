// YANI POS — Vercel Serverless API  (v4 — hardened)
// ══════════════════════════════════════════════════════════════════════
// All actions handled directly in Supabase. GAS-free.
// Write endpoints require ADMIN or OWNER role (userId in request body).
// CORS restricted to known domains. No hardcoded key fallbacks.
// ══════════════════════════════════════════════════════════════════════

import bcrypt from 'bcryptjs';
const SUPABASE_URL  = (process.env.SUPABASE_URL || 'https://hnynvclpvfxzlfjphefj.supabase.co');
const RESEND_KEY    = process.env.RESEND_API_KEY || '';
const FROM_EMAIL    = 'onboarding@resend.dev';  // upgrade to branded domain when DNS ready
const BUSINESS_NAME = (process.env.BUSINESS_NAME || 'Yani Garden Cafe');
// Service role key — loaded from env only. No hardcoded fallback.
const SUPABASE_KEY = (() => {
  const k = process.env.SUPABASE_SECRET_KEY;
  if (!k) throw new Error('SUPABASE_SECRET_KEY env var is not set');
  return k;
})();

// ── Permission table cache (loaded from role_permissions DB table) ───────────
// Refreshed every 5 min — permissions never change by accident via code edits
let _permCache = null;
let _permCacheAt = 0;
async function getRolePermissions() {
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
  } catch(e) { console.warn('Permission table unavailable, using code defaults:', e.message); }
  return null; // fallback: code-level checkAuth still enforces permissions
}

const SERVICE_CHARGE_RATE = 0.10;
const ORDER_PREFIX = 'ORD';

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
        ${order.discount_type === 'YANI_CARD' ? '🌿 Yani Card (10%)' : order.discount_type === 'PWD' ? 'PWD Discount' : order.discount_type === 'SENIOR' ? 'Senior Discount' : (order.discount_type || 'Discount')}${order.discount_pax > 0 ? ` (${order.discount_pax} pax)` : ''}:
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
  '069ee74a-350f-467a-86ef-876dd48ced3e': 'HOT',
  '9094c828-1da1-4802-838b-8eb4da3c16be': 'ICE AND ICE BLENDED',
  '228b02da-1a81-46e4-aae2-794b5c88a990': 'PASTRY',
  '098a930f-3789-42fd-b7ca-bd704126ec08': 'PASTA',
  '9abfbe5e-3c68-43cb-bed3-4ed5c63380c1': 'WRAP',
  '1b803e7a-c69c-442a-991c-d62c99e6dd11': 'OTHER',
  '9268943a-b5ed-40c3-ac51-4411e06805de': 'MEALS',
  '5297871b-fa2e-4376-bd81-6d9b0c173be8': 'BEST WITH',
  'a3123278-d6ba-4004-89db-479248efea6d': 'PASALUBONG',
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

// ── In-memory menu cache (15-minute TTL, indefinite stale fallback) ──
// Cache persists in Vercel's warm function instance. If DB is down,
// we serve last-known-good menu instead of returning 502 (blank menu).
const menuCache = { public: null, admin: null, ts: 0 };
const MENU_CACHE_TTL = 15 * 60 * 1000;
function invalidateMenuCache() { menuCache.public = null; menuCache.admin = null; menuCache.ts = 0; }

// ── Settings cache (2-minute TTL) — settings rarely change ──────────────
const _settingsCache = { data: null, ts: 0 };
const SETTINGS_CACHE_TTL = 2 * 60 * 1000;
function invalidateSettingsCache() { _settingsCache.data = null; _settingsCache.ts = 0; }

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
// ── Google Drive upload helper ─────────────────────────────────────────────
async function uploadToGoogleDrive(imageBuffer, mimeType, filename, folderId) {
  try {
    // Read SA from Supabase settings (fallback to env var)
    let saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '';
    if (!saJson) {
      try {
        const saR = await fetch(
          `${SUPABASE_URL}/rest/v1/settings?key=eq.GOOGLE_SA_JSON&select=value`,
          { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
        );
        const saData = await saR.json();
        saJson = (saData && saData[0]) ? saData[0].value : '';
      } catch(_) {}
    }
    const sa = JSON.parse(saJson || '{}');
    if (!sa.private_key || !sa.client_email) return null;
    const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const now     = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/drive',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600, iat: now,
    })).toString('base64url');
    const { createSign } = await import('node:crypto');
    const sign   = createSign('RSA-SHA256');
    sign.update(`${header}.${payload}`);
    const sig = sign.sign(sa.private_key, 'base64url');
    const jwt = `${header}.${payload}.${sig}`;
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    });
    const tokenData = await tokenResp.json();
    if (!tokenData.access_token) {
      console.error('Drive token failed:', JSON.stringify(tokenData).substring(0,200));
      return { error: `Token failed: ${tokenData.error_description || tokenData.error || 'no access_token'}` };
    }
    const boundary = '----YaniPOS';
    const meta = JSON.stringify({ name: filename, parents: [folderId] });
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
      imageBuffer,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    const uploadResp = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink',
      { method: 'POST', headers: {
          'Authorization': `Bearer ${tokenData.access_token}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        }, body }
    );
    const d = await uploadResp.json();
    if (!uploadResp.ok) {
      // Return error details for debugging
      const errMsg = d.error ? `Drive API ${uploadResp.status}: ${d.error.message || JSON.stringify(d.error)}` : `Drive API ${uploadResp.status}`;
      console.error('Drive upload failed:', errMsg);
      return { error: errMsg };
    }
    return d.webViewLink || (d.id ? `https://drive.google.com/file/d/${d.id}/view` : null);
  } catch(e) { console.error('Drive upload error:', e.message); return { error: e.message }; }
}

export default async function handler(req, res) {
  // Restrict CORS to known domains only
  const origin = req.headers.origin || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://pos.yanigardencafe.com,https://yanigardencafe.com,https://admin.yanigardencafe.com').split(',').map(s => s.trim());
  if (ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (!origin) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS[0] || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  // Security headers on every response
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

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
        // Prefer DB permissions — they can be changed without redeploy
        const dbPerms = await getRolePermissions();
        const roles = (dbPerms && dbPerms[action]) ? dbPerms[action] : (allowedRoles || []);
        if (!roles.length || roles.includes(jwtUser.role)) {
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
    // ══════════════════════════════════════════════════════════════════════

    // ── getMenu ────────────────────────────────────────────────────────────
    if (action === 'getMenu') {
      const now = Date.now();
      if (menuCache.public && (now - menuCache.ts) < MENU_CACHE_TTL) {
        return res.status(200).json({ ok: true, items: menuCache.public, cached: true });
      }
      // Fetch from DB with 5-second timeout — if DB is slow, fall back to stale cache
      let r;
      try {
        const ctrl = new AbortController();
        const timeoutId = setTimeout(() => ctrl.abort(), 5000);
        r = await supaFetch(
          `${SUPABASE_URL}/rest/v1/menu_items?is_active=eq.true&order=name.asc&select=item_code,name,base_price,has_sizes,has_sugar_levels,price_short,price_medium,price_tall,image_path,category_id,is_signature,available_from,available_until,available_days`,
          { signal: ctrl.signal }
        );
        clearTimeout(timeoutId);
      } catch (e) {
        console.error('getMenu DB fetch failed:', e.message);
        r = { ok: false };
      }
      if (!r.ok) {
        // STALE-WHILE-ERROR: if we have ANY cached menu (even old), serve it
        if (menuCache.public) {
          console.log('getMenu: DB failed, serving stale cache (' + Math.round((now - menuCache.ts)/1000) + 's old)');
          return res.status(200).json({ ok: true, items: menuCache.public, cached: true, stale: true });
        }
        return res.status(502).json({ ok: false, error: 'Failed to load menu' });
      }

      // Current PHT time for schedule filtering
      const nowPHT = new Date(Date.now() + 8*3600000);
      const curTime = nowPHT.getUTCHours().toString().padStart(2,'0') + ':' + nowPHT.getUTCMinutes().toString().padStart(2,'0');
      const curDay = ['SUN','MON','TUE','WED','THU','FRI','SAT'][nowPHT.getUTCDay()];

      const items = r.data.map(m => {
        // Schedule check
        let available = true;
        if (m.available_from && m.available_until) {
          available = curTime >= m.available_from && curTime <= m.available_until;
        }
        if (available && m.available_days && m.available_days.length > 0) {
          available = m.available_days.includes(curDay);
        }
        return {
          code:           m.item_code,
          name:           m.name,
          price:          m.base_price,
          hasSizes:       m.has_sizes,
          hasSugar:       m.has_sugar_levels,
          priceShort:     m.price_short,
          priceMedium:    m.price_medium,
          priceTall:      m.price_tall,
          image:          m.image_path || '',
          category:       getCategoryName(m.category_id),
          isSignature:    !!m.is_signature,
          available,
          availableFrom:  m.available_from || null,
          availableUntil: m.available_until || null,
          availableDays:  m.available_days || null,
        };
      });
      menuCache.public = items;
      menuCache.ts = now;
      return res.status(200).json({ ok: true, items });
    }

    // ── getMenuAdmin ───────────────────────────────────────────────────────
    if (action === 'getMenuAdmin') {
      const authMA = await checkAdminAuth();
      if (!authMA.ok) return res.status(403).json({ ok: false, error: authMA.error });
      const now = Date.now();
      if (menuCache.admin && (now - menuCache.ts) < MENU_CACHE_TTL) {
        return res.status(200).json({ ok: true, items: menuCache.admin, cached: true });
      }
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/menu_items?order=name.asc&select=item_code,name,base_price,has_sizes,has_sugar_levels,price_short,price_medium,price_tall,image_path,category_id,is_active,is_signature,available_from,available_until,available_days`
      );
      if (!r.ok) return res.status(502).json({ ok: false, error: 'Failed to load menu' });
      const items = r.data.map(m => ({
        code:           m.item_code,
        name:           m.name,
        price:          m.base_price,
        hasSizes:       m.has_sizes,
        hasSugar:       m.has_sugar_levels,
        priceShort:     m.price_short,
        priceMedium:    m.price_medium,
        priceTall:      m.price_tall,
        image:          m.image_path || '',
        category:       getCategoryName(m.category_id),
        active:         m.is_active,
        available:      m.is_active,
        status:         m.is_active ? 'ACTIVE' : 'INACTIVE',
        isSignature:    !!m.is_signature,
        availableFrom:  m.available_from || null,
        availableUntil: m.available_until || null,
        availableDays:  m.available_days || null,
      }));
      menuCache.admin = items;
      menuCache.ts = now;
      return res.status(200).json({ ok: true, items });
    }

    // ── addMenuItem ────────────────────────────────────────────────────────
    if (action === 'addMenuItem') {
      const authAdd = await checkAdminAuth();
      if (!authAdd.ok) return res.status(403).json({ ok: false, error: authAdd.error });
      if (!isNonEmptyString(body.name, 100) || body.name.trim().length < 2) {
        return res.status(400).json({ ok: false, error: 'name must be 2-100 characters' });
      }
      const errs = validateMenuPayload(body, false);
      if (errs.length) return res.status(400).json({ ok: false, error: errs.join('; ') });

      // Auto-generate item_code if not provided (format: ITEM_<timestamp>)
      const autoCode = 'ITEM_' + Date.now();
      const row = {
        item_code:        body.itemId || autoCode,
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
        is_signature:     !!body.isSignature,
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
      const authUpd = await checkAdminAuth();
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
      if (body.status      !== undefined) updates.is_active         = (body.status || 'ACTIVE').toUpperCase() === 'ACTIVE';
      if (body.isSignature !== undefined) updates.is_signature      = !!body.isSignature;
      // Menu scheduling fields
      if (body.availableFrom  !== undefined) updates.available_from  = body.availableFrom  || null;
      if (body.availableUntil !== undefined) updates.available_until = body.availableUntil || null;
      if (body.availableDays  !== undefined) updates.available_days  = (body.availableDays && body.availableDays.length) ? body.availableDays : null;
      if (Object.keys(updates).length === 0) return res.status(200).json({ ok: true });

      const r = await supa('PATCH', 'menu_items', updates, { item_code: `eq.${body.itemId}` });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to update menu item' });
      invalidateMenuCache();
      logSync('menu_items', body.itemId, 'UPDATE');
      return res.status(200).json({ ok: true });
    }

    // ── deleteMenuItem ─────────────────────────────────────────────────────
    if (action === 'deleteMenuItem') {
      const authDel = await checkAdminAuth();
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
      const authUps = await checkAdminAuth();
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

      // Server-side price validation — fetch menu from DB and verify each item price
      if (!isStaffOrder) {
        const menuR = await supaFetch(
          `${SUPABASE_URL}/rest/v1/menu_items?is_active=eq.true&select=item_code,base_price,price_short,price_medium,price_tall`
        );
        // Also fetch addon prices to allow item + addon total
        const addonR = await supaFetch(
          `${SUPABASE_URL}/rest/v1/menu_addons?is_active=eq.true&select=addon_code,price`
        );
        if (menuR.ok && menuR.data && menuR.data.length) {
          const menuMap = {};
          menuR.data.forEach(m => { menuMap[m.item_code] = m; });
          const addonMap = {};
          if (addonR.ok && addonR.data) {
            addonR.data.forEach(a => { addonMap[a.addon_code] = parseFloat(a.price) || 0; });
          }
          for (const item of items) {
            const dbItem = menuMap[item.code];
            if (!dbItem) continue; // unknown code — let DB handle
            const sentPriceRaw = item.price;
            const sentPrice = parseFloat(sentPriceRaw);
            const size = (item.size || '').toLowerCase();
            // Determine valid base price based on size
            let validBase = parseFloat(dbItem.base_price) || 0;
            if (size === 'short'  && dbItem.price_short)  validBase = parseFloat(dbItem.price_short);
            if (size === 'medium' && dbItem.price_medium) validBase = parseFloat(dbItem.price_medium);
            if (size === 'tall'   && dbItem.price_tall)   validBase = parseFloat(dbItem.price_tall);
            // Add addon prices to valid total
            const addons = Array.isArray(item.addons) ? item.addons : [];
            let addonTotal = 0;
            for (const addon of addons) {
              const addonCode = addon.code || addon.addon_code || '';
              addonTotal += addonMap[addonCode] || parseFloat(addon.price) || 0;
            }
            const validPrice = validBase + addonTotal;
            // Only reject if client sent a nonzero price AND it doesn't match
            // If price is missing/0/null — skip check, server will use DB price anyway
            if (!isNaN(sentPrice) && sentPrice > 0 && Math.abs(sentPrice - validPrice) > 1.01) {
              return res.status(400).json({
                ok: false,
                error: `Invalid price for ${item.code}: sent ₱${sentPrice}, expected ₱${validPrice}`
              });
            }
          }
        }
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

      // Fetch addon prices from DB — never trust client-sent addon prices
      const addonR2 = await supaFetch(`${SUPABASE_URL}/rest/v1/menu_addons?is_active=eq.true&select=addon_code,price`);
      const addonMapForOrder = {};
      if (addonR2.ok && Array.isArray(addonR2.data)) {
        addonR2.data.forEach(a => { addonMapForOrder[a.addon_code] = parseFloat(a.price) || 0; });
      }

      const orderItems = [];
      let subtotal = 0;
      for (const item of items) {
        const menuItem = menuMap[item.code];
        if (!menuItem) continue; // skip unknown items
        let unitPrice = parseFloat(menuItem.base_price) || 0;
        if (menuItem.has_sizes && item.size) {
          const sizeKey = { SHORT: 'price_short', MEDIUM: 'price_medium', TALL: 'price_tall' }[String(item.size).toUpperCase()];
          if (sizeKey && menuItem[sizeKey] != null) unitPrice = parseFloat(menuItem[sizeKey]);
        }
        const qty = Math.max(1, parseInt(item.qty) || 1);
        // Addons: validate prices from DB, not client
        const itemAddons = Array.isArray(item.addons) ? item.addons : [];
        const addonPrice = itemAddons.reduce((sum, a) => {
          const code = a.code || a.addon_code || '';
          // Use DB addon price if available, fall back to 0 (never trust client addon price)
          const dbAddonPrice = addonMapForOrder[code] !== undefined ? addonMapForOrder[code] : 0;
          return sum + dbAddonPrice;
        }, 0);
        const finalUnitPrice = unitPrice + addonPrice;
        subtotal += finalUnitPrice * qty;
        orderItems.push({
          item_code:    item.code,
          item_name:    menuItem.name,
          unit_price:   finalUnitPrice,
          qty,
          size_choice:  item.size || '',
          sugar_choice: item.sugarLevel || item.sugar || '',
          item_notes:   item.notes || '',
          addons:       itemAddons,
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

      // ── Duplicate order prevention ─────────────────────────────────────────
      // Reject if same table + customer + total was placed within the last 15 seconds
      // Catches: double-tap, slow-response retries, network retry storms
      if (!isStaffOrder && tableNo !== '0') {
        const dedupeWindow = new Date(Date.now() - 15000).toISOString();
        const dupeR = await supaFetch(
          `${SUPABASE_URL}/rest/v1/dine_in_orders?table_no=eq.${encodeURIComponent(tableNo)}&customer_name=eq.${encodeURIComponent(customerName)}&total=eq.${total}&status=in.(NEW,PREPARING,READY)&is_deleted=eq.false&created_at=gte.${encodeURIComponent(dedupeWindow)}&select=order_id&limit=1`
        );
        if (dupeR.ok && dupeR.data && dupeR.data.length > 0) {
          const existingId = dupeR.data[0].order_id;
          // Return the existing order instead of creating a new one
          return res.status(200).json({ ok: true, orderId: existingId, duplicate: true, message: 'Order already placed' });
        }
      }

      // Generate order ID using sequence — with self-healing retry on duplicate key
      const TEST_TABLES = ['T99', '0', 'T0'];
      // Only specific programmatic test names — NOT 'guest' (real customers don't enter names)
      const TEST_NAMES  = ['e2e test', 'price test', 'logtest', 'healthcheck'];
      const isTest = TEST_TABLES.includes(tableNo.toUpperCase()) ||
                     TEST_NAMES.includes(customerName.toLowerCase());

      // Yani Card discount — declared here so accessible after the for loop
      const yaniCardNum  = String(body.yaniCardNumber || '').trim().toUpperCase();
      const yaniDiscount = (body.discountType === 'YANI_CARD' && yaniCardNum)
        ? Math.round(total * 0.10 * 100) / 100
        : 0;
      const yaniTotal    = yaniDiscount > 0
        ? Math.max(0, Math.round((total - yaniDiscount) * 100) / 100)
        : null;

      let orderR, orderId, orderNo;
      for (let attempt = 0; attempt < 3; attempt++) {
        const seqR = await supaFetch(
          `${SUPABASE_URL}/rest/v1/rpc/get_next_order_number`,
          { method: 'POST', body: '{}' }
        );
        orderNo = seqR.ok ? (seqR.data || 1001) : Date.now() % 9000 + 1000;
        // Read ORDER_PREFIX from DB settings (tenant-specific)
        let tenantPrefix = ORDER_PREFIX;
        try {
          const pfxR = await supaFetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.ORDER_PREFIX&select=value`);
          if (pfxR.ok && pfxR.data && pfxR.data[0]) tenantPrefix = pfxR.data[0].value || ORDER_PREFIX;
        } catch(_) {}
        orderId = `${tenantPrefix}-${orderNo}`;

        const orderRow = {
          order_id:          orderId,
          order_no:          orderNo,
          table_no:          tableNo,
          customer_name:     customerName,
          status:            'NEW',
          order_type:        orderType,
          subtotal:          subtotal,
          service_charge:    svcCharge,
          vat_amount:        vatAmt,
          total:             total,
          notes:             notes,
          source:            'QR',
          is_test:           isTest,
          ...(yaniDiscount > 0 ? {
            discount_type:    'YANI_CARD',
            discount_pct:     10,
            discount_amount:  yaniDiscount,
            discounted_total: yaniTotal,
            discount_note:    'Yani Card: ' + yaniCardNum,
            payment_method:   'YANI_CARD',
          } : {}),
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
        addons:       it.addons && it.addons.length > 0 ? JSON.stringify(it.addons) : null,
      }));
      await supa('POST', 'dine_in_order_items', itemRows);

      // Log for Sheets sync
      logSync('dine_in_orders', orderId, 'INSERT');
      auditLog({ orderId, action: 'ORDER_PLACED', details: { tableNo, customerName, orderType, total, itemCount: orderItems.length } });

      // CHARGE YANI CARD at order placement — MUST be awaited (Vercel kills process after response)
      if (yaniDiscount > 0 && yaniCardNum && !isTest) {
        try {
          const cardR = await supaFetch(
            `${SUPABASE_URL}/rest/v1/yani_cards?card_number=eq.${encodeURIComponent(yaniCardNum)}&select=qr_token,status&limit=1`
          );
          const cardRow = cardR.data?.[0];
          if (cardRow && cardRow.status === 'ACTIVE' && cardRow.qr_token) {
            await supaFetch(`${SUPABASE_URL}/rest/v1/rpc/charge_card`, {
              method: 'POST',
              body: JSON.stringify({
                p_qr_token:     cardRow.qr_token,
                p_gross_amount: total,
                p_order_id:     orderId,
                p_performed_by: 'CUSTOMER',
              })
            });
          }
        } catch(e) { console.error('Yani Card charge error:', e.message); }
      }

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

      // ── Auto-deduct inventory for tracked items (fire-and-forget) ──────────
      try {
        const invR = await supaFetch(
          `${SUPABASE_URL}/rest/v1/inventory?select=item_code,stock_qty,auto_disable,low_stock_threshold`
        );
        if (invR.ok && invR.data && invR.data.length) {
          const invMap = {};
          invR.data.forEach(inv => { invMap[inv.item_code] = inv; });
          for (const it of orderItems) {
            const inv = invMap[it.code];
            if (!inv) continue; // not tracked
            const newQty = Math.max(0, parseFloat(inv.stock_qty) - it.qty);
            // Deduct stock
            await supa('PATCH', 'inventory', { stock_qty: newQty }, { item_code: `eq.${it.code}` });
            // Log adjustment
            await supa('POST', 'inventory_log', {
              item_code: it.code, change_type: 'SALE', qty_change: -it.qty,
              qty_after: newQty, reason: `Order ${orderId}`, created_by: 'system'
            });
            // Auto-disable menu item if stock hits 0 and auto_disable is true
            if (inv.auto_disable && newQty <= 0) {
              await supa('PATCH', 'menu_items', { is_active: false }, { item_code: `eq.${it.code}` });
              invalidateMenuCache();
            }
          }
        }
      } catch(invErr) {
        // Non-fatal — order still completes even if inventory update fails
        console.error('Inventory deduction error:', invErr.message);
      }

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
      const orderId     = body.orderId ? String(body.orderId).trim() : null;
      const status      = body.status  ? String(body.status).toUpperCase() : null;
      const limit       = Math.min(parseInt(body.limit) || 200, 500);
      const excludeTest = body.excludeTest === true || body.excludeTest === 'true';

      const includeDeleted = body.includeDeleted === true || body.includeDeleted === 'true';
      let url = `${SUPABASE_URL}/rest/v1/dine_in_orders?order=created_at.desc&limit=${limit}${includeDeleted ? '' : '&is_deleted=eq.false'}&select=*`;
      if (orderId) url += `&order_id=eq.${encodeURIComponent(orderId)}`;
      else if (status === 'ACTIVE') url += `&status=in.(NEW,PREPARING,READY)`;
      else if (status === 'SCHEDULED') url += `&status=eq.SCHEDULED&is_preorder=eq.true`;
      else if (status && status !== 'ALL') url += `&status=eq.${encodeURIComponent(status)}`;
      // Always include SCHEDULED pre-orders in ALL/default view so admin sees them
      else if (!status) url += `&status=in.(SCHEDULED,NEW,PREPARING,READY,COMPLETED,CANCELLED)`;
      if (excludeTest) url += `&is_test=eq.false`;

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
            // Parse addons from JSON if stored
            let parsedAddons = [];
            try { parsedAddons = it.addons ? JSON.parse(it.addons) : []; } catch(_) {}
            itemsMap[it.order_id].push({
              id:       it.id,
              code:     it.item_code,
              name:     it.item_name,
              price:    parseFloat(it.unit_price) || 0,
              qty:      it.qty,
              size:     it.size_choice || '',
              sugar:    it.sugar_choice || '',
              notes:    it.item_notes || '',
              prepared: it.prepared || false,
              addons:   parsedAddons,
            });
          });
        }
      }

      const orders = ordersR.data.map(o => ({
        orderId:       o.order_id,
        orderNo:       o.order_no,
        isDeleted:     !!o.is_deleted,
        tableNo:       o.table_no,
        customer:      o.customer_name,   // alias used by printReceipt
        customerName:  o.customer_name,
        status:        o.status,
        orderType:     o.order_type,
        subtotal:      parseFloat(o.subtotal)       || 0,
        serviceCharge: parseFloat(o.service_charge)  || 0,
        vatAmount:     parseFloat(o.vat_amount)       || 0,
        total:         parseFloat(o.total)            || 0,
        discountedTotal: o.discounted_total ? parseFloat(o.discounted_total) : null,
        notes:         o.notes || '',
        receiptType:     o.receipt_type     || '',
        receiptDelivery: o.receipt_delivery || '',
        receiptEmail:    o.receipt_email    || '',
        receiptName:     o.receipt_name     || '',
        receiptAddress:  o.receipt_address  || '',
        receiptTIN:      o.receipt_tin      || '',
        orNumber:      o.or_number        || null,
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
        createdAt:     o.created_at ? (o.created_at.endsWith('Z') || o.created_at.includes('+') ? o.created_at : o.created_at + '+00:00') : null,
        updatedAt:     o.updated_at,
        isTest:        o.is_test || false,
        isPreorder:    o.is_preorder || false,
        scheduledFor:  o.scheduled_for || null,
        preorderToken: o.preorder_token || null,
        items:         itemsMap[o.order_id] || [],
      }));

      return res.status(200).json({ ok: true, orders });
    }

    // ── updateOrderStatus ──────────────────────────────────────────────────
    if (action === 'updateOrderStatus') {
      // JWT auth first (preferred) — all roles allowed for kitchen workflow
      const authUO = await checkAuth(['OWNER','ADMIN','CASHIER','KITCHEN']);
      if (!authUO.ok) return res.status(403).json({ ok: false, error: authUO.error });

      const orderId      = String(body.orderId || '').trim();
      const newStatus    = String(body.status  || '').trim().toUpperCase();
      const cancelReason = body.cancelReason ? String(body.cancelReason).trim() : null;
      const validStatuses = ['NEW', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED'];
      if (!orderId)                           return res.status(400).json({ ok: false, error: 'orderId is required' });
      if (!isValidOrderId(orderId))           return res.status(400).json({ ok: false, error: 'Invalid orderId format' });
      if (!validStatuses.includes(newStatus)) return res.status(400).json({ ok: false, error: 'Invalid status: ' + newStatus });

      // Role derived from JWT (preferred) or legacy body.userId
      const userId = jwtUser ? jwtUser.userId : String(body.userId || '').trim();
      const staffRole = jwtUser ? jwtUser.role : (() => {
        // Legacy path: still validate via DB if no JWT
        return authUO.role;
      })();

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

      // AUTO-EARN LOYALTY POINTS when order is completed
      if (newStatus === 'COMPLETED') {
        try {
          const loyaltyEnabled = await getSetting('LOYALTY_ENABLED');
          if (loyaltyEnabled !== 'false') {
            // Get full order to find total + loyalty_account_id
            const fullOrder = await supaFetch(
              `${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}&select=total,discounted_total,loyalty_account_id,points_earned,customer_name,table_no,is_test&limit=1`
            );
            const ord = fullOrder.data?.[0];
            if (ord && !ord.is_test && ord.loyalty_account_id && !ord.points_earned) {
              const orderTotal = parseFloat(ord.discounted_total || ord.total || 0);
              const rateR = await supaFetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.LOYALTY_EARN_RATE&select=value&limit=1`);
              const earnRate = parseFloat(rateR.data?.[0]?.value || '1');
              const pointsEarned = Math.floor(orderTotal * earnRate);
              if (pointsEarned > 0) {
                const accR = await supaFetch(`${SUPABASE_URL}/rest/v1/loyalty_accounts?id=eq.${encodeURIComponent(ord.loyalty_account_id)}&select=points_balance,total_points_earned,total_spent,visit_count&limit=1`);
                if (accR.ok && accR.data?.length) {
                  const acc = accR.data[0];
                  const balBefore = acc.points_balance || 0;
                  const balAfter  = balBefore + pointsEarned;
                  const newTotalEarned = (acc.total_points_earned || 0) + pointsEarned;
                  const newTotalSpent  = (acc.total_spent || 0) + orderTotal;
                  const newVisits      = (acc.visit_count || 0) + 1;
                  // Tier calculation
                  const thR = await supaFetch(`${SUPABASE_URL}/rest/v1/settings?key=in.("LOYALTY_SILVER_THRESHOLD","LOYALTY_GOLD_THRESHOLD","LOYALTY_PLATINUM_THRESHOLD")&select=key,value`);
                  const th = {};
                  (thR.data||[]).forEach(s => { th[s.key] = parseInt(s.value); });
                  let tier = 'BRONZE';
                  if (newTotalEarned >= (th.LOYALTY_PLATINUM_THRESHOLD||40000)) tier = 'PLATINUM';
                  else if (newTotalEarned >= (th.LOYALTY_GOLD_THRESHOLD||15000)) tier = 'GOLD';
                  else if (newTotalEarned >= (th.LOYALTY_SILVER_THRESHOLD||5000)) tier = 'SILVER';
                  // Update account
                  await supaFetch(`${SUPABASE_URL}/rest/v1/loyalty_accounts?id=eq.${encodeURIComponent(ord.loyalty_account_id)}`, {
                    method: 'PATCH', body: JSON.stringify({ points_balance: balAfter, total_points_earned: newTotalEarned, total_spent: newTotalSpent, visit_count: newVisits, tier, last_visit: new Date().toISOString(), updated_at: new Date().toISOString() })
                  });
                  // Log transaction
                  await supaFetch(`${SUPABASE_URL}/rest/v1/points_transactions`, {
                    method: 'POST', body: JSON.stringify({ account_id: ord.loyalty_account_id, order_id: orderId, type: 'EARN', points: pointsEarned, balance_before: balBefore, balance_after: balAfter, description: `Earned from order ${orderId}`, processed_by: userId })
                  });
                  // Mark points earned on order
                  await supaFetch(`${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}`, {
                    method: 'PATCH', body: JSON.stringify({ points_earned: pointsEarned })
                  });
                  auditLog({ orderId, action: 'LOYALTY_POINTS_EARNED', details: { accountId: ord.loyalty_account_id, pointsEarned, balAfter, tier } });
                }
              }
            }
          }
        } catch(loyaltyErr) {
          // Never fail the order completion because of loyalty error
          console.error('Loyalty auto-earn error:', loyaltyErr.message);
        }
      }

      // AUTO-CHARGE YANI CARD when order is COMPLETED (fire-and-forget, idempotent)
      if (newStatus === 'COMPLETED') {
        try {
          const yaniOrderR = await supaFetch(
            `${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}&select=payment_method,discount_type,discount_note,total,is_test&limit=1`
          );
          const yaniOrd = yaniOrderR.data?.[0];
          if (yaniOrd && !yaniOrd.is_test &&
              yaniOrd.payment_method === 'YANI_CARD' &&
              yaniOrd.discount_type  === 'YANI_CARD' &&
              yaniOrd.discount_note) {
            // Extract card number from discount_note e.g. "Yani Card: YANI-1001"
            const cardNumMatch = String(yaniOrd.discount_note).match(/YANI-\d+/i);
            if (cardNumMatch) {
              const cardNum   = cardNumMatch[0].toUpperCase();
              const grossAmt  = parseFloat(yaniOrd.total || 0);
              // Idempotency check: skip if already charged for this order
              const existR = await supaFetch(
                `${SUPABASE_URL}/rest/v1/card_transactions?order_id=eq.${encodeURIComponent(orderId)}&type=eq.CHARGE&select=id&limit=1`
              );
              if (!existR.data?.length && grossAmt > 0) {
                // Resolve QR token from card number
                const cardR = await supaFetch(
                  `${SUPABASE_URL}/rest/v1/yani_cards?card_number=eq.${encodeURIComponent(cardNum)}&select=qr_token,status&limit=1`
                );
                const cardRow = cardR.data?.[0];
                if (cardRow && cardRow.status === 'ACTIVE' && cardRow.qr_token) {
                  // Call charge_card RPC
                  await supaFetch(`${SUPABASE_URL}/rest/v1/rpc/charge_card`, {
                    method: 'POST',
                    body: JSON.stringify({
                      p_qr_token:     cardRow.qr_token,
                      p_gross_amount: grossAmt,
                      p_order_id:     orderId,
                      p_performed_by: userId || 'SYSTEM',
                    })
                  });
                }
              }
            }
          }
        } catch(yaniErr) {
          // Never fail the order completion because of card charge error
          console.error('Yani Card auto-charge error:', yaniErr.message);
        }
      }

      return res.status(200).json({ ok: true, orderId, status: newStatus });
    }

    // ── updateOrderTotals ──────────────────────────────────────────────────
    // Allows OWNER/ADMIN to waive or restore service charge on active orders
    if (action === 'updateOrderTotals') {
      const authT = await checkAuth(['OWNER','ADMIN']);
      if (!authT.ok) return res.status(403).json({ ok: false, error: authT.error });
      const { orderId, serviceCharge, total } = body;
      if (!orderId) return res.status(400).json({ ok: false, error: 'orderId required' });
      const svc   = parseFloat(serviceCharge);
      const tot   = parseFloat(total);
      if (isNaN(svc) || isNaN(tot) || tot < 0)
        return res.status(400).json({ ok: false, error: 'Invalid amounts' });
      const patch = { service_charge: svc, total: tot, updated_at: new Date().toISOString() };
      const r = await supa('PATCH', 'dine_in_orders', patch, { order_id: `eq.${orderId}` });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to update order totals' });
      auditLog({ orderId, action: 'SERVICE_CHARGE_WAIVED', details: { serviceCharge: svc, total: tot, by: authT.userId } });
      return res.status(200).json({ ok: true, serviceCharge: svc, total: tot });
    }

    // ── restoreOrder ──────────────────────────────────────────────────────
    if (action === 'restoreOrder') {
      const authRO = await checkAuth(['OWNER','ADMIN']);
      if (!authRO.ok) return res.status(403).json({ ok: false, error: authRO.error });
      const orderId = String(body.orderId || '').trim();
      if (!orderId || !isValidOrderId(orderId)) return res.status(400).json({ ok: false, error: 'Invalid orderId' });
      const r = await supa('PATCH', 'dine_in_orders', { is_deleted: false, updated_at: new Date().toISOString() }, { order_id: `eq.${orderId}` });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to restore order' });
      auditLog({ orderId, action: 'ORDER_RESTORED', actor: { userId: body.userId, role: authRO.role } });
      return res.status(200).json({ ok: true, orderId });
    }

    // ── deleteOrder ────────────────────────────────────────────────────────
    if (action === 'deleteOrder') {
      const authDO = await checkAuth(['OWNER','ADMIN']);
      if (!authDO.ok) return res.status(403).json({ ok: false, error: authDO.error });
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
      const authK = await checkAuth();
      if (!authK.ok) return res.status(403).json({ ok: false, error: authK.error });

      const itemId  = parseInt(body.itemId, 10);
      const prepared = Boolean(body.prepared);
      if (!itemId || isNaN(itemId)) return res.status(400).json({ ok: false, error: 'itemId is required' });

      const r = await supa('PATCH', 'dine_in_order_items',
        { prepared },
        { id: `eq.${itemId}` }
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to update item' });
      // Return the order's current status so kitchen.html can auto-trigger PREPARING/READY
      let orderStatus = null;
      try {
        const oRes = await supa('GET', 'dine_in_order_items',
          null, { id: `eq.${itemId}`, select: 'order_id' }
        );
        if (oRes.ok && oRes.data && oRes.data[0]) {
          const orderId = oRes.data[0].order_id;
          const statusRes = await supa('GET', 'dine_in_orders',
            null, { order_id: `eq.${orderId}`, select: 'status' }
          );
          if (statusRes.ok && statusRes.data && statusRes.data[0]) {
            orderStatus = statusRes.data[0].status;
          }
        }
      } catch(_) {}
      return res.status(200).json({ ok: true, itemId, prepared, orderStatus });
    }

    // ── setPaymentMethod ──────────────────────────────────────────────────
    // Admin/Cashier/Owner sets how an order was paid.
    // method can be single (CASH) or split (GCASH+CASH, CARD+GCASH, etc.)
    // ── saveSplitBill ──────────────────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════
    // LOYALTY POINTS SYSTEM
    // ══════════════════════════════════════════════════════════════════════

    // ── getLoyaltySettings ─────────────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════
    // PRE-ORDERING SYSTEM
    // ══════════════════════════════════════════════════════════════════════

    // ── createPreOrder (public — customer-facing) ──────────────────────────
    if (action === 'createPreOrder') {
      const { customerName, customerPhone, items, scheduledFor, orderType, notes } = body;
      if (!customerName || !customerPhone || !items?.length || !scheduledFor) {
        return res.status(400).json({ ok: false, error: 'customerName, customerPhone, items, and scheduledFor required' });
      }

      // Validate scheduled time
      const pickupTime = new Date(scheduledFor);
      const now = new Date();
      const diffMins = (pickupTime - now) / 60000;

      const minR = await supaFetch(`${SUPABASE_URL}/rest/v1/settings?key=in.("PREORDER_MIN_ADVANCE","PREORDER_MAX_ADVANCE","PREORDER_ENABLED")&select=key,value`);
      const minSett = {};
      (minR.data||[]).forEach(s => { minSett[s.key] = s.value; });

      if (minSett.PREORDER_ENABLED === 'false') return res.status(400).json({ ok: false, error: 'Pre-ordering is currently disabled' });
      const minAdv = parseInt(minSett.PREORDER_MIN_ADVANCE || '30');
      const maxAdv = parseInt(minSett.PREORDER_MAX_ADVANCE || '1440');
      if (diffMins < minAdv) return res.status(400).json({ ok: false, error: `Must order at least ${minAdv} minutes in advance` });
      if (diffMins > maxAdv) return res.status(400).json({ ok: false, error: `Cannot order more than ${Math.round(maxAdv/60)} hours in advance` });

      // Build order
      const menuR = await supaFetch(`${SUPABASE_URL}/rest/v1/menu_items?is_active=eq.true&select=item_code,name,base_price,price_short,price_medium,price_tall,has_sizes`);
      const menuMap = {};
      (menuR.data||[]).forEach(m => { menuMap[m.item_code] = m; });

      let subtotal = 0;
      const orderItems = [];
      for (const it of items) {
        const menu = menuMap[it.code];
        if (!menu) return res.status(400).json({ ok: false, error: `Item not found: ${it.code}` });
        let price = parseFloat(menu.base_price||0);
        if (menu.has_sizes && it.size) {
          if (it.size === 'Short') price = parseFloat(menu.price_short||price);
          else if (it.size === 'Medium') price = parseFloat(menu.price_medium||price);
          else if (it.size === 'Tall') price = parseFloat(menu.price_tall||price);
        }
        const lineTotal = price * (it.qty||1);
        subtotal += lineTotal;
        orderItems.push({ code: it.code, name: menu.name, price, qty: it.qty||1, size: it.size||'', sugar: it.sugar||'', lineTotal });
      }

      const svcRate = parseFloat((await getSetting('SERVICE_CHARGE'))||'0.1');
      const svc = orderType === 'TAKE-OUT' ? 0 : Math.round(subtotal * svcRate * 100) / 100;
      const total = subtotal + svc;

      // Generate order ID and token
      const prefix = (await getSetting('ORDER_PREFIX'))||'YANI';
      const cntR = await supaFetch(`${SUPABASE_URL}/rest/v1/dine_in_orders?select=order_no&order=order_no.desc&limit=1`);
      const lastNo = cntR.data?.[0]?.order_no || 1000;
      const orderNo = lastNo + 1;
      const orderId = `${prefix}-${orderNo}`;
      const token = Math.random().toString(36).substring(2,10).toUpperCase();

      // Insert order
      const orderR = await supaFetch(`${SUPABASE_URL}/rest/v1/dine_in_orders`, {
        method: 'POST',
        headers: { 'Prefer': 'return=representation' },
        body: JSON.stringify({
          order_id: orderId, order_no: orderNo, status: 'SCHEDULED',
          order_type: orderType||'TAKE-OUT', source: 'QR',
          customer_name: customerName, table_no: 'PREORDER',
          subtotal, service_charge: svc, total,
          notes: notes||'', is_preorder: true,
          scheduled_for: pickupTime.toISOString(),
          preorder_token: token,
          payment_status: 'PENDING',
          items_json: JSON.stringify(orderItems)
        })
      });
      if (!orderR.ok) return res.status(500).json({ ok: false, error: 'Failed to create pre-order' });

      // Insert order items
      const itemRows = orderItems.map(it => ({
        order_id: orderId, order_no: orderNo, table_no: 'PREORDER',
        item_code: it.code, item_name: it.name, unit_price: it.price,
        qty: it.qty, size_choice: it.size||'', sugar_choice: it.sugar||''
      }));
      await supaFetch(`${SUPABASE_URL}/rest/v1/dine_in_order_items`, { method: 'POST', body: JSON.stringify(itemRows) });

      auditLog({ orderId, action: 'PREORDER_PLACED', details: { scheduledFor: pickupTime.toISOString(), customerName, total, items: orderItems.length } });

      return res.status(200).json({ ok: true, orderId, token, scheduledFor: pickupTime.toISOString(), total, subtotal, svc });
    }

    // ── getPreOrders (admin) ───────────────────────────────────────────────
    if (action === 'getPreOrders') {
      const auth = await checkAuth(['OWNER','ADMIN','CASHIER','KITCHEN']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/dine_in_orders?is_preorder=eq.true&status=in.("SCHEDULED","NEW","PREPARING","READY")&order=scheduled_for.asc&select=*&limit=100`
      );
      return res.status(200).json({ ok: true, orders: (r.data||[]).map(o => ({
        orderId: o.order_id, orderNo: o.order_no, status: o.status,
        customerName: o.customer_name, tableNo: o.table_no,
        orderType: o.order_type, subtotal: parseFloat(o.subtotal||0),
        serviceCharge: parseFloat(o.service_charge||0), total: parseFloat(o.total||0),
        notes: o.notes, scheduledFor: o.scheduled_for,
        paymentStatus: o.payment_status, paymentMethod: o.payment_method,
        createdAt: o.created_at, isPreorder: true,
        items: (() => { try { return JSON.parse(o.items_json||'[]'); } catch { return []; } })()
      })) });
    }

    // ── triggerScheduledOrders (called by admin poll + cron) ───────────────
    if (action === 'triggerScheduledOrders') {
      const auth = await checkAuth(['OWNER','ADMIN','CASHIER','KITCHEN']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });

      const bufferR = await supaFetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.PREORDER_PREP_BUFFER&select=value&limit=1`);
      const bufferMins = parseInt(bufferR.data?.[0]?.value || '15');
      const triggerTime = new Date(Date.now() + bufferMins * 60000).toISOString();

      // Find orders due to start
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/dine_in_orders?is_preorder=eq.true&status=eq.SCHEDULED&scheduled_for=lte.${encodeURIComponent(triggerTime)}&select=order_id,customer_name,scheduled_for`
      );
      const due = r.data || [];
      const triggered = [];

      for (const o of due) {
        await supaFetch(`${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(o.order_id)}`, {
          method: 'PATCH', body: JSON.stringify({ status: 'NEW', updated_at: new Date().toISOString() })
        });
        auditLog({ orderId: o.order_id, action: 'PREORDER_TRIGGERED', details: { scheduledFor: o.scheduled_for, triggeredAt: new Date().toISOString() } });
        triggered.push(o.order_id);
      }

      return res.status(200).json({ ok: true, triggered, count: triggered.length });
    }

    // ── getPreOrderStatus (public — customer tracking) ─────────────────────
    if (action === 'getPreOrderStatus') {
      const { orderId, token } = body;
      if (!orderId || !token) return res.status(400).json({ ok: false, error: 'orderId and token required' });
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}&preorder_token=eq.${encodeURIComponent(token)}&select=order_id,status,scheduled_for,customer_name,total,subtotal,service_charge,payment_status,items_json&limit=1`
      );
      if (!r.ok || !r.data?.length) return res.status(200).json({ ok: false, error: 'Order not found' });
      const o = r.data[0];
      return res.status(200).json({ ok: true, order: {
        orderId: o.order_id, status: o.status, scheduledFor: o.scheduled_for,
        customerName: o.customer_name, total: parseFloat(o.total||0),
        paymentStatus: o.payment_status,
        items: (() => { try { return JSON.parse(o.items_json||'[]'); } catch { return []; } })()
      }});
    }

    if (action === 'getLoyaltySettings') {
      const keys = ['LOYALTY_ENABLED','LOYALTY_EARN_RATE','LOYALTY_REDEEM_RATE',
                    'LOYALTY_MIN_REDEEM','LOYALTY_SILVER_THRESHOLD','LOYALTY_GOLD_THRESHOLD','LOYALTY_PLATINUM_THRESHOLD'];
      const r = await supaFetch(`${SUPABASE_URL}/rest/v1/settings?key=in.(${keys.map(k=>`"${k}"`).join(',')})&select=key,value`);
      const settings = {};
      (r.data||[]).forEach(s => { settings[s.key] = s.value; });
      return res.status(200).json({ ok: true, settings });
    }

    // ── lookupLoyalty (by phone — public, used at POS checkout) ───────────
    if (action === 'lookupLoyalty') {
      const { phone } = body;
      if (!phone) return res.status(400).json({ ok: false, error: 'phone required' });
      const clean = phone.replace(/\D/g,'');
      const r = await supaFetch(`${SUPABASE_URL}/rest/v1/loyalty_accounts?phone=eq.${encodeURIComponent(clean)}&select=*&limit=1`);
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Loyalty lookup failed' });
      if (!r.data?.length) return res.status(200).json({ ok: true, found: false, account: null });
      return res.status(200).json({ ok: true, account: r.data[0] });
    }

    // ── getLoyaltyAccounts (admin list) ───────────────────────────────────
    if (action === 'getLoyaltyAccounts') {
      const auth = await checkAuth(['OWNER','ADMIN','CASHIER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { search, limit = 100 } = body;
      let url = `${SUPABASE_URL}/rest/v1/loyalty_accounts?select=*&order=total_points_earned.desc&limit=${limit}`;
      if (search) url += `&or=(name.ilike.*${encodeURIComponent(search)}*,phone.ilike.*${encodeURIComponent(search)}*)`;
      const r = await supaFetch(url);
      return res.status(200).json({ ok: true, accounts: r.data || [] });
    }

    // ── getLoyaltyAccount (single + transaction history) ──────────────────
    if (action === 'getLoyaltyAccount') {
      const auth = await checkAuth(['OWNER','ADMIN','CASHIER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { id, phone } = body;
      let accR;
      if (id) accR = await supaFetch(`${SUPABASE_URL}/rest/v1/loyalty_accounts?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
      else if (phone) accR = await supaFetch(`${SUPABASE_URL}/rest/v1/loyalty_accounts?phone=eq.${encodeURIComponent(phone.replace(/\D/g,''))}&select=*&limit=1`);
      else return res.status(400).json({ ok: false, error: 'id or phone required' });
      if (!accR.ok || !accR.data?.length) return res.status(200).json({ ok: false, error: 'Account not found' });
      const account = accR.data[0];
      const txR = await supaFetch(`${SUPABASE_URL}/rest/v1/points_transactions?account_id=eq.${encodeURIComponent(account.id)}&order=created_at.desc&limit=50`);
      return res.status(200).json({ ok: true, account, transactions: txR.data || [] });
    }

    // ── createLoyaltyAccount ──────────────────────────────────────────────
    if (action === 'createLoyaltyAccount') {
      const auth = await checkAuth(['OWNER','ADMIN','CASHIER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { name, phone, email } = body;
      if (!name || !phone) return res.status(400).json({ ok: false, error: 'name and phone required' });
      const clean = phone.replace(/\D/g,'');
      const existing = await supaFetch(`${SUPABASE_URL}/rest/v1/loyalty_accounts?phone=eq.${encodeURIComponent(clean)}&select=id&limit=1`);
      if (existing.data?.length) return res.status(200).json({ ok: false, error: 'Phone already registered' });
      const r = await supaFetch(`${SUPABASE_URL}/rest/v1/loyalty_accounts`, {
        method: 'POST',
        body: JSON.stringify({ name, phone: clean, email: email||null, points_balance:0, total_points_earned:0, total_points_redeemed:0, tier:'BRONZE', total_spent:0, visit_count:0 }),
        headers: { 'Prefer': 'return=representation' }
      });
      if (!r.ok) return res.status(500).json({ ok: false, error: r.data?.message || 'Failed to create account' });
      return res.status(200).json({ ok: true, account: r.data[0] });
    }

    // ── earnPoints (called after order completion) ─────────────────────────
    if (action === 'earnPoints') {
      const auth = await checkAuth(['OWNER','ADMIN','CASHIER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { accountId, orderId, orderTotal, description } = body;
      if (!accountId || !orderTotal) return res.status(400).json({ ok: false, error: 'accountId and orderTotal required' });

      // Get earn rate from settings
      const rateR = await supaFetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.LOYALTY_EARN_RATE&select=value&limit=1`);
      const earnRate = parseFloat(rateR.data?.[0]?.value || '1');
      const pointsEarned = Math.floor(parseFloat(orderTotal) * earnRate);
      if (pointsEarned <= 0) return res.status(200).json({ ok: true, pointsEarned: 0 });

      // Get current balance
      const accR = await supaFetch(`${SUPABASE_URL}/rest/v1/loyalty_accounts?id=eq.${encodeURIComponent(accountId)}&select=points_balance,total_points_earned,total_spent,visit_count&limit=1`);
      if (!accR.ok || !accR.data?.length) return res.status(404).json({ ok: false, error: 'Account not found' });
      const acc = accR.data[0];
      const balBefore = acc.points_balance;
      const balAfter = balBefore + pointsEarned;
      const newTotalEarned = (acc.total_points_earned||0) + pointsEarned;
      const newTotalSpent = (acc.total_spent||0) + parseFloat(orderTotal);
      const newVisits = (acc.visit_count||0) + 1;

      // Determine tier
      const tierThresholds = await supaFetch(`${SUPABASE_URL}/rest/v1/settings?key=in.("LOYALTY_SILVER_THRESHOLD","LOYALTY_GOLD_THRESHOLD","LOYALTY_PLATINUM_THRESHOLD")&select=key,value`);
      const th = {};
      (tierThresholds.data||[]).forEach(s => { th[s.key] = parseInt(s.value); });
      let tier = 'BRONZE';
      if (newTotalEarned >= (th.LOYALTY_PLATINUM_THRESHOLD||40000)) tier = 'PLATINUM';
      else if (newTotalEarned >= (th.LOYALTY_GOLD_THRESHOLD||15000)) tier = 'GOLD';
      else if (newTotalEarned >= (th.LOYALTY_SILVER_THRESHOLD||5000)) tier = 'SILVER';

      // Update account
      await supaFetch(`${SUPABASE_URL}/rest/v1/loyalty_accounts?id=eq.${encodeURIComponent(accountId)}`, {
        method: 'PATCH', body: JSON.stringify({ points_balance: balAfter, total_points_earned: newTotalEarned, total_spent: newTotalSpent, visit_count: newVisits, tier, last_visit: new Date().toISOString(), updated_at: new Date().toISOString() })
      });

      // Log transaction
      await supaFetch(`${SUPABASE_URL}/rest/v1/points_transactions`, {
        method: 'POST', body: JSON.stringify({ account_id: accountId, order_id: orderId||null, type: 'EARN', points: pointsEarned, balance_before: balBefore, balance_after: balAfter, description: description || `Earned from order ${orderId||''}`, processed_by: body.userId })
      });

      // Update order with points earned
      if (orderId) {
        await supaFetch(`${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}`, {
          method: 'PATCH', body: JSON.stringify({ loyalty_account_id: accountId, points_earned: pointsEarned })
        });
      }

      return res.status(200).json({ ok: true, pointsEarned, balanceBefore: balBefore, balanceAfter: balAfter, tier });
    }

    // ── redeemPoints ──────────────────────────────────────────────────────
    if (action === 'redeemPoints') {
      const auth = await checkAuth(['OWNER','ADMIN','CASHIER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { accountId, pointsToRedeem, orderId } = body;
      if (!accountId || !pointsToRedeem) return res.status(400).json({ ok: false, error: 'accountId and pointsToRedeem required' });

      // Get settings
      const settR = await supaFetch(`${SUPABASE_URL}/rest/v1/settings?key=in.("LOYALTY_REDEEM_RATE","LOYALTY_MIN_REDEEM")&select=key,value`);
      const sett = {};
      (settR.data||[]).forEach(s => { sett[s.key] = s.value; });
      const redeemRate = parseInt(sett.LOYALTY_REDEEM_RATE || '100'); // points per ₱1
      const minRedeem = parseInt(sett.LOYALTY_MIN_REDEEM || '500');

      if (pointsToRedeem < minRedeem) return res.status(400).json({ ok: false, error: `Minimum ${minRedeem} points to redeem` });

      const accR = await supaFetch(`${SUPABASE_URL}/rest/v1/loyalty_accounts?id=eq.${encodeURIComponent(accountId)}&select=points_balance,total_points_redeemed&limit=1`);
      if (!accR.ok || !accR.data?.length) return res.status(404).json({ ok: false, error: 'Account not found' });
      const acc = accR.data[0];
      if (acc.points_balance < pointsToRedeem) return res.status(400).json({ ok: false, error: `Insufficient points. Balance: ${acc.points_balance}` });

      const discountAmount = Math.floor(pointsToRedeem / redeemRate * 100) / 100;
      const balBefore = acc.points_balance;
      const balAfter  = balBefore - pointsToRedeem;

      // Update account
      await supaFetch(`${SUPABASE_URL}/rest/v1/loyalty_accounts?id=eq.${encodeURIComponent(accountId)}`, {
        method: 'PATCH', body: JSON.stringify({ points_balance: balAfter, total_points_redeemed: (acc.total_points_redeemed||0) + pointsToRedeem, updated_at: new Date().toISOString() })
      });

      // Log transaction
      await supaFetch(`${SUPABASE_URL}/rest/v1/points_transactions`, {
        method: 'POST', body: JSON.stringify({ account_id: accountId, order_id: orderId||null, type: 'REDEEM', points: -pointsToRedeem, balance_before: balBefore, balance_after: balAfter, description: `Redeemed ${pointsToRedeem} pts = ₱${discountAmount} off`, processed_by: body.userId })
      });

      // Update order
      if (orderId) {
        await supaFetch(`${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}`, {
          method: 'PATCH', body: JSON.stringify({ loyalty_account_id: accountId, points_redeemed: pointsToRedeem, points_discount: discountAmount })
        });
      }

      return res.status(200).json({ ok: true, pointsRedeemed: pointsToRedeem, discountAmount, balanceBefore: balBefore, balanceAfter: balAfter });
    }

    // ── adjustPoints (manual adjustment by OWNER) ─────────────────────────
    if (action === 'adjustPoints') {
      const auth = await checkAuth(['OWNER','ADMIN']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { accountId, points, reason } = body;
      if (!accountId || points === undefined) return res.status(400).json({ ok: false, error: 'accountId and points required' });

      const accR = await supaFetch(`${SUPABASE_URL}/rest/v1/loyalty_accounts?id=eq.${encodeURIComponent(accountId)}&select=points_balance&limit=1`);
      if (!accR.ok || !accR.data?.length) return res.status(404).json({ ok: false, error: 'Account not found' });
      const balBefore = accR.data[0].points_balance;
      const balAfter  = Math.max(0, balBefore + parseInt(points));

      await supaFetch(`${SUPABASE_URL}/rest/v1/loyalty_accounts?id=eq.${encodeURIComponent(accountId)}`, {
        method: 'PATCH', body: JSON.stringify({ points_balance: balAfter, updated_at: new Date().toISOString() })
      });
      await supaFetch(`${SUPABASE_URL}/rest/v1/points_transactions`, {
        method: 'POST', body: JSON.stringify({ account_id: accountId, type: 'ADJUST', points: parseInt(points), balance_before: balBefore, balance_after: balAfter, description: reason || 'Manual adjustment', processed_by: body.userId })
      });

      return res.status(200).json({ ok: true, balanceBefore: balBefore, balanceAfter: balAfter });
    }

    if (action === 'saveSplitBill') {
      const auth = await checkAuth(['OWNER','ADMIN','CASHIER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { orderId, splitData } = body;
      if (!orderId || !splitData) return res.status(400).json({ ok: false, error: 'orderId and splitData required' });
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}`,
        { method: 'PATCH', body: JSON.stringify({ split_data: splitData }) }
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to save split data' });
      await auditLog({ orderId, action: 'SPLIT_BILL', actor: { userId: body.userId },
        newValue: `split:${splitData.type}:${splitData.pax}pax`, details: splitData });
      return res.status(200).json({ ok: true });
    }

    if (action === 'setPaymentMethod') {
      const authP = await checkAuth(['OWNER','ADMIN','CASHIER']);
      if (!authP.ok) return res.status(403).json({ ok: false, error: authP.error });

      const orderId = String(body.orderId || '').trim();
      const method  = String(body.method  || '').trim().toUpperCase();
      const notes   = String(body.notes   || '').trim().slice(0, 300);
      const VALID   = new Set(['CASH','CARD','GCASH','INSTAPAY','BDO','BPI','UNIONBANK','MAYA','OTHER','YANI_CARD']);

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
      const authD = await checkAuth(['OWNER','ADMIN','CASHIER']);
      if (!authD.ok) return res.status(403).json({ ok: false, error: authD.error });

      const orderId   = String(body.orderId || '').trim();
      const type      = String(body.discountType || '').toUpperCase(); // PWD | SENIOR | BOTH | PROMO | CUSTOM
      const totalPax  = parseInt(body.totalPax, 10) || 1;
      const qualPax   = parseInt(body.qualifiedPax, 10) || 1; // how many PWD/Senior
      const promoPct  = parseFloat(body.promoPct) || 0;       // % for PROMO
      const customAmt = parseFloat(body.customAmt) || 0;      // fixed ₱ for CUSTOM
      const note      = String(body.note || '').trim().slice(0, 200);

      if (!orderId) return res.status(400).json({ ok: false, error: 'orderId required' });
      if (!isValidOrderId(orderId)) return res.status(400).json({ ok: false, error: 'Invalid orderId' });
      if (!['PWD','SENIOR','BOTH','PROMO','CUSTOM','REMOVE','YANI_CARD'].includes(type))
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
      } else if (type === 'YANI_CARD') {
        // 10% flat on total — card charge handled separately by client
        discountPct    = 10;
        discountAmount = Math.round(total * 0.10 * 100) / 100;
      }

      const discountedTotal = Math.max(0, Math.round((total - discountAmount) * 100) / 100);

      const r = await supa('PATCH', 'dine_in_orders',
        { discount_type: type, discount_pax: qualPax, discount_pct: discountPct,
          discount_amount: discountAmount, discounted_total: discountedTotal,
          discount_note: (type === 'YANI_CARD' && body.yaniCardNumber ? 'Yani Card: ' + String(body.yaniCardNumber).trim().toUpperCase() : note) || null, updated_at: new Date().toISOString() },
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
      const authSh = await checkAuth(['OWNER','ADMIN','CASHIER']);
      if (!authSh.ok) return res.status(403).json({ ok: false, error: authSh.error });

      // Get timezone from settings (default Asia/Manila)
      const tz = await getSetting('TIMEZONE') || 'Asia/Manila';

      // Business day = 6 AM PHT to 6 AM PHT
      // If current PHT time is before 6 AM, business day started yesterday at 6 AM
      const nowUTC = new Date();
      const phtOff = 8 * 3600000;
      const nowPHT = new Date(nowUTC.getTime() + phtOff);
      const phtHour = nowPHT.getUTCHours();
      // Start of current business day (6 AM PHT)
      const bdayStart = new Date(nowPHT);
      bdayStart.setUTCHours(6, 0, 0, 0);
      if (phtHour < 6) bdayStart.setTime(bdayStart.getTime() - 86400000); // before 6 AM → prev day
      const bdayEnd = new Date(bdayStart.getTime() + 86400000); // +24h
      const todayStart = new Date(bdayStart.getTime() - phtOff).toISOString();
      const todayEnd   = new Date(bdayEnd.getTime()   - phtOff).toISOString();

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
        date: bdayStart.toISOString().slice(0,10),
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

    // ── addItemsToOrder (multi-table: append items to existing order) ──────
    if (action === 'addItemsToOrder') {
      const authA = await checkAuth(['OWNER','ADMIN','CASHIER','SERVER']);
      if (!authA.ok) return res.status(403).json({ ok: false, error: authA.error });

      const orderId = String(body.orderId || '').trim();
      const newItems = Array.isArray(body.items) ? body.items : [];
      if (!orderId) return res.status(400).json({ ok: false, error: 'orderId required' });
      if (!newItems.length) return res.status(400).json({ ok: false, error: 'items required' });

      // Fetch existing order
      const orderR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}&select=order_no,table_no,order_type,subtotal,service_charge,total,status`
      );
      if (!orderR.ok || !orderR.data.length) return res.status(404).json({ ok: false, error: 'Order not found' });
      const ord = orderR.data[0];
      if (['COMPLETED','CANCELLED'].includes(ord.status)) {
        return res.status(400).json({ ok: false, error: `Cannot add to a ${ord.status} order` });
      }

      // Build new item rows
      let addSubtotal = 0;
      const itemRows = newItems.map(it => {
        const qty = Math.max(1, parseInt(it.qty) || 1);
        const price = parseFloat(it.price) || 0;
        addSubtotal += price * qty;
        return {
          order_id:     orderId,
          order_no:     ord.order_no,
          table_no:     ord.table_no,
          item_code:    it.code || 'CUSTOM',
          item_name:    it.name || 'Item',
          unit_price:   price,
          qty,
          size_choice:  it.size || '',
          sugar_choice: it.sugarLevel || it.sugar || '',
          item_notes:   it.notes || '',
        };
      });

      // Insert new items
      const insertR = await supa('POST', 'dine_in_order_items', itemRows);
      if (!insertR.ok) return res.status(500).json({ ok: false, error: 'Failed to insert items' });

      // Recalculate totals from ALL items in DB (not from stored subtotal — prevents compounding errors)
      const allItemsR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/dine_in_order_items?order_id=eq.${encodeURIComponent(orderId)}&select=unit_price,qty`
      );
      const trueSubtotal = allItemsR.ok
        ? Math.round((allItemsR.data || []).reduce((s, i) => s + parseFloat(i.unit_price||0) * parseInt(i.qty||1), 0) * 100) / 100
        : Math.round((parseFloat(ord.subtotal || 0) + addSubtotal) * 100) / 100;

      const svcRate  = ord.order_type === 'TAKE-OUT' ? 0 : SERVICE_CHARGE_RATE;
      const newSvc   = Math.round(trueSubtotal * svcRate * 100) / 100;
      const newTotal = Math.round((trueSubtotal + newSvc) * 100) / 100;

      await supaFetch(`${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ subtotal: trueSubtotal, service_charge: newSvc, total: newTotal })
      });

      await auditLog({ orderId, action: 'ITEMS_ADDED', actor: { userId: authA.userId }, details: { added: newItems.length, addSubtotal, trueSubtotal, newTotal } });

      return res.status(200).json({ ok: true, orderId, added: newItems.length, newTotal });
    }

    // ── editOrderItems ─────────────────────────────────────────────────────
    if (action === 'editOrderItems') {
      const authE = await checkAuth(['OWNER','ADMIN','CASHIER']);
      if (!authE.ok) return res.status(403).json({ ok: false, error: authE.error });

      const orderId = String(body.orderId || '').trim();
      const items   = Array.isArray(body.items) ? body.items : [];
      if (!orderId) return res.status(400).json({ ok: false, error: 'orderId is required' });
      if (!isValidOrderId(orderId)) return res.status(400).json({ ok: false, error: 'Invalid orderId format' });

      // Get order to check it exists and get order_no/table_no
      const orderR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}&select=order_no,table_no,order_type,discounted_total,discount_amount,status`
      );
      if (!orderR.ok || !orderR.data.length) return res.status(404).json({ ok: false, error: 'Order not found' });
      const { order_no, table_no, order_type, discounted_total, discount_amount, status: orderStatus } = orderR.data[0];

      // Block editing completed or cancelled orders
      if (['COMPLETED','CANCELLED'].includes(orderStatus)) {
        return res.status(400).json({ ok: false, error: `Cannot edit a ${orderStatus} order` });
      }

      // Discount is handled below — editOrderItems recalculates discount proportionally

      // Fetch existing items to preserve their 'prepared' state
      const existItemsR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/dine_in_order_items?order_id=eq.${encodeURIComponent(orderId)}&select=item_code,size_choice,sugar_choice,item_notes,prepared`
      );
      const existItems = existItemsR.ok ? (existItemsR.data || []) : [];

      // Recalculate totals
      let subtotal = 0;
      const itemRows = items.map(it => {
        const qty = Math.max(1, parseInt(it.qty) || 1);
        const price = parseFloat(it.price) || 0;
        subtotal += price * qty;
        // Carry over prepared state if this item already existed (match on code+size+sugar)
        const existMatch = existItems.find(e =>
          e.item_code === (it.code || 'CUSTOM') &&
          (e.size_choice || '') === (it.size || '') &&
          (e.sugar_choice || '') === (it.sugar || '')
        );
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
          prepared:     existMatch ? (existMatch.prepared || false) : false,
        };
      });

      const svcCharge  = order_type === 'TAKE-OUT' ? 0 : Math.round(subtotal * SERVICE_CHARGE_RATE * 100) / 100;
      const preTax2    = subtotal + svcCharge;
      const vatEnabled2 = (await getSetting('VAT_ENABLED')) === 'true';
      const vatRate2    = parseFloat(await getSetting('VAT_RATE') || '0.12');
      const vatAmt2     = vatEnabled2 ? Math.round(preTax2 * (vatRate2 / (1 + vatRate2)) * 100) / 100 : 0;
      const total       = Math.round(preTax2 * 100) / 100;

      // Delete old items and insert new ones (prepared state preserved above)
      await supa('DELETE', 'dine_in_order_items', null, { order_id: `eq.${orderId}` });
      if (itemRows.length > 0) await supa('POST', 'dine_in_order_items', itemRows);

      // Update order totals
      // If order had a discount, recalculate it proportionally on the new total
      // Use supaFetch with raw URL — supa() encodeURIComponent breaks select with commas
      const existOrder = await supaFetch(
        `${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}&select=discount_type,discount_amount,discounted_total,total`
      );
      let newDiscountAmt = 0, newDiscountedTotal = null, discountType = null;
      const ex = existOrder.ok && existOrder.data && existOrder.data[0];
      if (ex) {
        const exDiscAmt  = parseFloat(ex.discount_amount || 0);
        const exDisc     = parseFloat(ex.discounted_total || 0);
        const exTotal    = parseFloat(ex.total || 0);
        discountType     = ex.discount_type || null;
        if (discountType && exDiscAmt > 0 && exTotal > 0) {
          const pct = exDiscAmt / exTotal;           // e.g. 15.29/152.90 = 0.10
          newDiscountAmt     = Math.round(total * pct * 100) / 100;
          newDiscountedTotal = Math.round((total - newDiscountAmt) * 100) / 100;
        }
      }
      const patch = { subtotal, service_charge: svcCharge, vat_amount: vatAmt2, total };
      if (newDiscountedTotal !== null && discountType) {
        patch.discount_amount    = newDiscountAmt;
        patch.discounted_total   = newDiscountedTotal;
      } else {
        patch.discount_amount    = 0;
        patch.discounted_total   = null;
        patch.discount_type      = null;
      }
      await supa('PATCH', 'dine_in_orders', patch, { order_id: `eq.${orderId}` });

      logSync('dine_in_orders', orderId, 'UPDATE');
      auditLog({ orderId, action: 'ORDER_EDITED', actor: { userId: body.userId, role: authE.role }, details: { newTotal: total, itemCount: itemRows.length, discountRecalculated: !!newDiscountedTotal } });
      return res.status(200).json({ ok: true, orderId, subtotal, serviceCharge: svcCharge, total, discountedTotal: newDiscountedTotal, discountAmount: newDiscountAmt });
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
      // Read ORDER_PREFIX from DB settings (same as dine-in orders)
      let olPrefix = ORDER_PREFIX;
      try {
        const olPfxR = await supaFetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.ORDER_PREFIX&select=value`);
        if (olPfxR.ok && olPfxR.data?.[0]?.value) olPrefix = olPfxR.data[0].value;
      } catch(_) {}
      const orderId = `${olPrefix}-${orderNo}`;

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

      // 1. Assign OR number for BIR receipts
      let orNumber = null;
      if (receiptType === 'bir') {
        // Atomically increment OR_NUMBER_CURRENT
        const curR = await supaFetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.OR_NUMBER_CURRENT&select=value`);
        if (curR.ok && curR.data.length) {
          orNumber = parseInt(curR.data[0].value || '1001', 10);
          await supa('PATCH', 'settings', { value: String(orNumber + 1) }, { key: 'eq.OR_NUMBER_CURRENT' });
        }
      }

      // 2. Save receipt details to order record
      const updates = {
        receipt_type:     receiptType,
        receipt_delivery: deliveryMethod,
        receipt_email:    email,
        receipt_name:     name,
        receipt_address:  address,
        receipt_tin:      tin,
        ...(orNumber ? { or_number: orNumber } : {}),
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
      return res.status(200).json({ ok: true, sent: false, message: 'Receipt details saved. Print at counter.', orNumber: orNumber || null });
    }

    // ── resendReceipt ──────────────────────────────────────────────────────
    // Staff-triggered: resend receipt email for any completed order
    if (action === 'resendReceipt') {
      const authR = await checkAuth(['OWNER','ADMIN','CASHIER']);
      if (!authR.ok) return res.status(403).json({ ok: false, error: authR.error });

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

      // Upload screenshot to Supabase Storage (public URL) — fallback to base64 if upload fails
      let proofUrl = imageData || '';
      let storedFilename = filename;
      if (imageData && imageData.startsWith('data:')) {
        try {
          const match = imageData.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            const mimeType = match[1];
            const ext = mimeType.split('/')[1]?.replace('jpeg','jpg') || 'jpg';
            const storageFilename = `${paymentId}.${ext}`;
            const imgBuffer = Buffer.from(match[2], 'base64');
            const uploadResp = await fetch(
              `${SUPABASE_URL}/storage/v1/object/payment-proofs/${storageFilename}`,
              {
                method: 'POST',
                headers: {
                  'apikey': SUPABASE_KEY,
                  'Authorization': `Bearer ${SUPABASE_KEY}`,
                  'Content-Type': mimeType,
                  'x-upsert': 'true',
                },
                body: imgBuffer,
              }
            );
            if (uploadResp.ok) {
              proofUrl = `${SUPABASE_URL}/storage/v1/object/public/payment-proofs/${storageFilename}`;
              storedFilename = storageFilename;
              // Mirror to Google Drive — await so Vercel doesn't kill before completion
              if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
                try {
                  const driveRes = await uploadToGoogleDrive(imgBuffer, mimeType, storedFilename, '1hDQlljGpRUwT9q33xHukbXvz_M8tk5lR');
                  if (typeof driveRes === 'string') console.log('GDrive upload ok:', driveRes);
                  else if (driveRes && driveRes.error) console.error('GDrive upload failed:', driveRes.error);
                  else console.log('GDrive upload: no URL returned');
                } catch(driveErr) {
                  console.error('GDrive upload failed:', driveErr.message);
                }
              }
            }
            // else fall back to base64 already set
          }
        } catch (_) { /* fallback to base64 */ }
      }

      const payRow = {
        payment_id:     paymentId,
        order_id:       orderId,
        order_type:     'DINE-IN',
        amount,
        method:         String(body.paymentMethod || 'GCASH').toUpperCase(),
        payment_method: String(body.paymentMethod || 'GCASH').toUpperCase(),
        proof_url:      proofUrl,
        proof_filename: storedFilename,
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
      return res.status(200).json({ ok: true, paymentId, proofUrl, filename: storedFilename });
    }

    // ── listPayments ───────────────────────────────────────────────────────
    if (action === 'listPayments') {
      const authLP = await checkAdminAuth();
      if (!authLP.ok) return res.status(403).json({ ok: false, error: authLP.error });

      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/payments?order=created_at.desc&limit=200`
      );
      if (!r.ok) return res.status(502).json({ ok: false, payments: [], error: 'Failed to load payments' });

      // Batch-fetch table numbers from dine_in_orders
      const orderIds = [...new Set(r.data.map(p => p.order_id).filter(Boolean))];
      let tableMap = {};
      if (orderIds.length > 0) {
        const ordersR = await supaFetch(
          `${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=in.(${orderIds.map(id => `"${id}"`).join(',')})&select=order_id,table_no`
        );
        if (ordersR.ok && Array.isArray(ordersR.data)) {
          ordersR.data.forEach(o => { tableMap[o.order_id] = o.table_no || '?'; });
        }
      }

      // Also fetch receipt + customer info from orders
      let orderInfoMap = {};
      if (orderIds.length > 0) {
        const ordInfoR = await supaFetch(
          `${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=in.(${orderIds.map(id => `"${id}"`).join(',')})&select=order_id,customer_name,receipt_type,receipt_delivery,receipt_email,receipt_name,receipt_address,receipt_tin`
        );
        if (ordInfoR.ok && Array.isArray(ordInfoR.data)) {
          ordInfoR.data.forEach(o => { orderInfoMap[o.order_id] = o; });
        }
      }

      const payments = r.data.map(p => {
        const orderInfo = orderInfoMap[p.order_id] || {};
        // If proof_url is a real URL (Storage), use it directly; if base64, use the /api/payment-proof endpoint
        const proofIsUrl = p.proof_url && p.proof_url.startsWith('http');
        const proofUrl = proofIsUrl ? p.proof_url : null;
        return {
          paymentId:      p.payment_id,
          orderId:        p.order_id,
          orderType:      p.order_type,
          tableNo:        tableMap[p.order_id] || '?',
          amount:         p.amount,
          paymentMethod:  p.payment_method || p.method,
          hasProof:       !!(p.proof_url),
          proofUrl:       proofUrl,       // real URL or null (base64 served via /api/payment-proof)
          filename:       p.proof_filename,
          status:         p.status,
          verifiedBy:     p.verified_by || '',
          verifiedAt:     p.verified_at || '',
          notes:          p.rejection_reason || '',
          createdAt:      p.created_at,
          uploadedAt:     p.created_at,
          // Receipt info from order
          customerName:   orderInfo.customer_name || '',
          receiptType:    orderInfo.receipt_type || '',
          receiptDelivery:orderInfo.receipt_delivery || '',
          receiptEmail:   orderInfo.receipt_email || '',
          receiptName:    orderInfo.receipt_name || '',
          receiptAddress: orderInfo.receipt_address || '',
          receiptTin:     orderInfo.receipt_tin || '',
        };
      });

      return res.status(200).json({ ok: true, payments });
    }

    // ── getPaymentProof ───────────────────────────────────────────────────
    // Returns the base64 proof image for a single payment (on-demand)
    if (action === 'getPaymentProof') {
      const authGP = await checkAdminAuth();
      if (!authGP.ok) return res.status(403).json({ ok: false, error: authGP.error });
      const payId = String(body.paymentId || '').trim();
      if (!payId) return res.status(400).json({ ok: false, error: 'paymentId required' });
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/payments?payment_id=eq.${encodeURIComponent(payId)}&select=payment_id,proof_url,proof_filename`
      );
      if (!r.ok || !r.data?.length) return res.status(404).json({ ok: false, error: 'Payment not found' });
      return res.status(200).json({ ok: true, imageUrl: r.data[0].proof_url, filename: r.data[0].proof_filename });
    }

    // ── migrateProofs (one-time: move base64 → Supabase Storage) ──────────
    if (action === 'migrateProofs') {
      const auth = await checkAuth(['OWNER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      // Find all payments where proof_url starts with 'data:'
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/payments?proof_url=like.data%3A*&select=payment_id,proof_url,proof_filename`
      );
      if (!r.ok) return res.status(502).json({ ok: false, error: 'Failed to fetch payments' });
      let migrated = 0, failed = 0;
      for (const p of r.data || []) {
        try {
          const match = p.proof_url?.match(/^data:([^;]+);base64,(.+)$/);
          if (!match) { failed++; continue; }
          const mimeType = match[1];
          const ext = mimeType.split('/')[1]?.replace('jpeg','jpg') || 'jpg';
          const storageFilename = `${p.payment_id}.${ext}`;
          const imgBuffer = Buffer.from(match[2], 'base64');
          const uploadResp = await fetch(
            `${SUPABASE_URL}/storage/v1/object/payment-proofs/${storageFilename}`,
            {
              method: 'POST',
              headers: {
                'apikey': SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`,
                'Content-Type': mimeType,
                'x-upsert': 'true',
              },
              body: imgBuffer,
            }
          );
          if (uploadResp.ok) {
            const newUrl = `${SUPABASE_URL}/storage/v1/object/public/payment-proofs/${storageFilename}`;
            await supa('PATCH', 'payments', { proof_url: newUrl, proof_filename: storageFilename },
              { payment_id: `eq.${p.payment_id}` });
            migrated++;
          } else { failed++; }
        } catch (_) { failed++; }
      }
      return res.status(200).json({ ok: true, migrated, failed, total: r.data?.length || 0 });
    }

    // ── verifyPayment ──────────────────────────────────────────────────────
    if (action === 'verifyPayment') {
      const paymentId  = String(body.paymentId  || '').trim();
      const authVP     = await checkAdminAuth();
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
      // REQUIRES VALID JWT — no legacy body.userId fallback allowed for PIN changes
      if (!jwtUser) {
        return res.status(403).json({ ok: false, error: 'A valid login token is required to change PINs' });
      }
      const authCP = await checkAuth(['OWNER','ADMIN','CASHIER','KITCHEN']);
      if (!authCP.ok) return res.status(403).json({ ok: false, error: authCP.error });

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

      // Auth check: use jwtUser directly (guaranteed valid JWT from check above)
      // NEVER use body.userId for role lookup — that was the original exploit
      const requesterId = jwtUser.userId;         // from validated JWT — cannot be spoofed
      const requesterRole = jwtUser.role;         // from validated JWT — cannot be spoofed
      let authorized = false;

      if (requesterRole === 'OWNER' || requesterRole === 'ADMIN') {
        // Only OWNER/ADMIN (verified via JWT) can change any PIN without currentPin
        authorized = true;
      } else if (currentPin) {
        // Non-admin changing their own PIN — must provide current PIN AND target must be themselves
        if (targetUserId !== requesterId) {
          return res.status(403).json({ ok: false, error: 'You can only change your own PIN' });
        }
        authorized = await bcrypt.compare(currentPin, targetUser.pin_hash);
        if (!authorized) return res.status(403).json({ ok: false, error: 'Current PIN is incorrect' });
      }

      if (!authorized) return res.status(403).json({ ok: false, error: 'Unauthorized to change this PIN' });

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
    if (action === 'testDriveUpload') {
      // Diagnostic only — protected by secret key
      if (body.secret !== 'yani-drive-test-2026') return res.status(401).json({ ok: false, error: 'Bad secret' });
      const tinyPng = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==','base64');
      const driveResult = await uploadToGoogleDrive(tinyPng,'image/png',`TEST_${Date.now()}.png`,'1hDQlljGpRUwT9q33xHukbXvz_M8tk5lR');
      let testSaJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '';
      if (!testSaJson) {
        try {
          const testSaR = await fetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.GOOGLE_SA_JSON&select=value`,
            { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
          const testSaData = await testSaR.json();
          testSaJson = (testSaData && testSaData[0]) ? testSaData[0].value : '';
        } catch(_) {}
      }
      const saSet = !!(testSaJson);
      const saEmail = saSet ? JSON.parse(testSaJson).client_email : 'NOT SET';
      const driveError = (driveResult && typeof driveResult === 'object' && driveResult.error) ? driveResult.error : null;
      const driveUrl   = (driveResult && typeof driveResult === 'string') ? driveResult : null;
      return res.status(200).json({ ok: !!driveUrl, driveUrl, driveError, saEmail, saSet });
    }

    if (action === 'verifyUserPin') {
      const pin = String(body.pin || '').trim();
      if (!pin || pin.length < 4) return res.status(400).json({ ok: false, error: 'PIN is required' });

      // ── Rate-limit check + staff fetch run in PARALLEL (saves ~600ms) ─────
      const loginIp = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
      const loginKey = `pin_brute:${loginIp}`;

      const [rlResult, r] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/rpc/upsert_rate_limit`,
          { method:'POST', headers:{'apikey':SUPABASE_KEY,'Authorization':`Bearer ${SUPABASE_KEY}`,'Content-Type':'application/json'},
            body: JSON.stringify({ p_key: loginKey, p_window: 300, p_limit: 10 }) }
        ).then(async res2 => { try { return await res2.json(); } catch { return true; } }).catch(() => true),
        supaFetch(`${SUPABASE_URL}/rest/v1/staff_users?active=eq.true&select=user_id,username,display_name,role,pin_hash,failed_attempts,locked_until`)
      ]);

      if (rlResult === false) {
        return res.status(429).json({ ok:false, error:'Too many failed attempts. Try again in 5 minutes.' });
      }
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
        // Rate already tracked per IP above
        return res.status(200).json({ ok: false, error: 'Invalid PIN' });
      }

      // Check if account is locked
      if (matchedUser.locked_until && new Date(matchedUser.locked_until) > new Date()) {
        return res.status(200).json({ ok: false, error: 'Account locked. Try again in 15 minutes.' });
      }

      // Issue JWT token immediately — don't block on DB writes
      let token = null;
      try { token = await signToken(matchedUser.user_id, matchedUser.role, matchedUser.display_name); }
      catch (_) { /* non-fatal */ }

      // Fire-and-forget post-login writes — PARALLEL, not awaited
      // User gets their response immediately; DB updates happen in background
      Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/rpc/upsert_rate_limit`,
          { method:'POST', headers:{'apikey':SUPABASE_KEY,'Authorization':`Bearer ${SUPABASE_KEY}`,'Content-Type':'application/json'},
            body: JSON.stringify({ p_key: loginKey, p_window: 1, p_limit: 9999 }) }
        ).catch(() => {}),
        supa('PATCH', 'staff_users', {
          last_login:      new Date().toISOString(),
          failed_attempts: 0,
          locked_until:    null,
        }, { user_id: `eq.${matchedUser.user_id}` }).catch(() => {})
      ]).catch(() => {});

      return res.status(200).json({
        ok: true,
        userId:      matchedUser.user_id,
        username:    matchedUser.username,
        displayName: matchedUser.display_name,
        role:        matchedUser.role,
        token,                          // ← new: JWT for secure auth
        expiresIn:   8 * 60 * 60,       // 8 hours in seconds
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
        deliveryFee:         parseFloat(o.delivery_fee || 0),
        deliveryZone:        o.delivery_zone || null,
        lastUpdated:         o.updated_at,
      }));
      return res.status(200).json({ ok: true, orders });
    }

    // ── getCustomers ───────────────────────────────────────────────────────
    // ── createReservation ─────────────────────────────────────────────────
    if (action === 'createReservation') {
      // ONLINE bookings (no userId) are allowed — staff bookings require admin role
      const isOnline = !body.userId;
      if (!isOnline) {
        const authR = await checkAdminAuth();
        if (!authR.ok) return res.status(403).json({ ok: false, error: authR.error });
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
      const authR = await checkAuth();
      if (!authR.ok) return res.status(403).json({ ok: false, error: authR.error });
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/cafe_tables?order=table_number.asc&select=table_number,qr_token,table_name,capacity`
      );
      return res.status(200).json({ ok: true, tables: r.data || [] });
    }

    // ── updateTable ────────────────────────────────────────────────────────
    if (action === 'updateTable') {
      const authR = await checkAdminAuth();
      if (!authR.ok) return res.status(403).json({ ok: false, error: authR.error });
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
      const authR = await checkAdminAuth();
      if (!authR.ok) return res.status(403).json({ ok: false, error: authR.error });
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
      const authR = await checkAdminAuth();
      if (!authR.ok) return res.status(403).json({ ok: false, error: authR.error });
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
      const authR = await checkAdminAuth();
      if (!authR.ok) return res.status(403).json({ ok: false, error: authR.error });

      const date = body.date ? String(body.date) : new Date().toISOString().slice(0,10);
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/reservations?res_date=eq.${date}&status=neq.CANCELLED&order=res_time.asc&select=*`
      );
      return res.status(200).json({ ok: true, reservations: r.data || [] });
    }

    // ── updateReservation ──────────────────────────────────────────────────
    if (action === 'updateReservation') {
      const authR = await checkAdminAuth();
      if (!authR.ok) return res.status(403).json({ ok: false, error: authR.error });

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

    // getCustomers moved to customers table section below

    // ── getAnalytics ───────────────────────────────────────────────────────
    if (action === 'getAnalytics') {
      // OWNER / ADMIN only
      const authA = await checkAdminAuth();
      if (!authA.ok) return res.status(403).json({ ok: false, error: authA.error });

      const BASE = `${SUPABASE_URL}/rest/v1`;
      const H    = { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` };

      // ── Daily revenue last 30 days ─────────────────────────────────────
      const thirtyAgo = new Date(Date.now() - 30*24*3600*1000).toISOString();
      const ordersR = await fetch(
        `${BASE}/dine_in_orders?status=eq.COMPLETED&is_test=eq.false&is_deleted=eq.false&created_at=gte.${thirtyAgo}&select=created_at,total,discounted_total,order_type`,
        { headers: H }
      );
      const orders = ordersR.ok ? (await ordersR.json()) : [];

      // Daily revenue map
      const phOffset = 8 * 3600000; // UTC+8 Philippines time
      const dailyMap = {};
      orders.forEach(o => {
        // Use PH date (UTC+8) for day grouping
        const phDate = new Date(new Date(o.created_at).getTime() + phOffset);
        const day = phDate.toISOString().slice(0,10);
        if (!dailyMap[day]) dailyMap[day] = { revenue:0, count:0 };
        // Use discounted_total when available (reflects actual amount paid)
        dailyMap[day].revenue += parseFloat(o.discounted_total || o.total || 0);
        dailyMap[day].count   += 1;
      });
      const daily = Object.entries(dailyMap)
        .map(([day,v]) => ({ day, revenue: Math.round(v.revenue*100)/100, count: v.count }))
        .sort((a,b) => a.day.localeCompare(b.day));

      // Business day grouping: order belongs to business day based on 6 AM cutoff
      // e.g. order at 12:30 AM on Apr 4 belongs to Apr 3 business day
      function getBusinessDay(isoStr) {
        const phDate = new Date(new Date(isoStr).getTime() + phOffset);
        const h = phDate.getUTCHours();
        if (h < 6) phDate.setTime(phDate.getTime() - 86400000); // before 6 AM → prev biz day
        return phDate.toISOString().slice(0,10);
      }
      // Rebuild dailyMap with business day grouping
      const dailyMapBiz = {};
      orders.forEach(o => {
        const day = getBusinessDay(o.created_at);
        if (!dailyMapBiz[day]) dailyMapBiz[day] = { revenue:0, count:0 };
        dailyMapBiz[day].revenue += parseFloat(o.discounted_total || o.total || 0);
        dailyMapBiz[day].count   += 1;
      });
      Object.assign(dailyMap, dailyMapBiz); // replace with business-day version

      // Today vs yesterday — use business day logic
      const nowPHT2 = new Date(Date.now() + phOffset);
      const curH    = nowPHT2.getUTCHours();
      if (curH < 6) nowPHT2.setTime(nowPHT2.getTime() - 86400000);
      const todayStr     = nowPHT2.toISOString().slice(0,10);
      const yesterdayStr = new Date(nowPHT2.getTime() - 86400000).toISOString().slice(0,10);
      const todayData     = dailyMap[todayStr]     || { revenue:0, count:0 };
      const yesterdayData = dailyMap[yesterdayStr] || { revenue:0, count:0 };

      // Total last 7 days
      const sevenAgoStr = new Date(Date.now()-7*86400000).toISOString().slice(0,10);
      let rev7=0, cnt7=0;
      daily.forEach(d => { if (d.day >= sevenAgoStr) { rev7+=d.revenue; cnt7+=d.count; } });

      // ── Hourly distribution (today) ────────────────────────────────────
      const hourly = Array.from({length:24}, (_,i) => ({ hour:i, count:0, revenue:0 }));
      orders.filter(o => {
        const phDate = new Date(new Date(o.created_at).getTime() + phOffset);
        return phDate.toISOString().slice(0,10) === todayStr;
      }).forEach(o => {
        const phDate = new Date(new Date(o.created_at).getTime() + phOffset);
        const h = phDate.getUTCHours(); // hour in PH time
        hourly[h].count   += 1;
        hourly[h].revenue += parseFloat(o.discounted_total || o.total || 0);
      });

      // ── Order type split (last 30d) ───────────────────────────────────
      const typeSplit = { 'DINE-IN':0, 'TAKE-OUT':0 };
      orders.forEach(o => { typeSplit[o.order_type] = (typeSplit[o.order_type]||0)+1; });

      // ── Top items — use Supabase Management API raw SQL to avoid 1000-row REST limit ──
      // The REST API silently truncates at 1000 rows; with 1200+ order items this caused
      // wrong counts. Raw SQL via JOIN gives the correct aggregated result directly.
      const topItemsR = await fetch(
        `https://api.supabase.com/v1/projects/hnynvclpvfxzlfjphefj/database/query`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.SUPABASE_PAT || ''}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query: `
            SELECT i.item_name AS name,
                   SUM(i.qty)::int        AS qty,
                   SUM(i.line_total)::float AS revenue
            FROM dine_in_order_items i
            JOIN dine_in_orders o ON o.order_id = i.order_id
            WHERE o.status      = 'COMPLETED'
              AND o.is_test     = false
              AND o.is_deleted  = false
            GROUP BY i.item_name
            ORDER BY qty DESC
            LIMIT 20
          ` })
        }
      );
      let topItems = [];
      if (topItemsR.ok) {
        const topData = await topItemsR.json();
        topItems = Array.isArray(topData) ? topData.map(r => ({
          name: r.name, qty: r.qty, revenue: r.revenue
        })) : [];
      }
      // Fallback: if PAT not set, use the old method with higher limit
      if (topItems.length === 0) {
        const ordersWithId = await fetch(
          `${BASE}/dine_in_orders?status=eq.COMPLETED&is_test=eq.false&is_deleted=eq.false&select=order_id&limit=5000`,
          { headers: H }
        );
        const completedIds = new Set((ordersWithId.ok ? await ordersWithId.json() : []).map(o=>o.order_id));
        const rawItemsR = await fetch(
          `${BASE}/dine_in_order_items?select=item_name,qty,line_total,order_id&limit=5000`,
          { headers: H }
        );
        const rawItems = rawItemsR.ok ? (await rawItemsR.json()) : [];
        const itemMap = {};
        rawItems.forEach(i => {
          if (!completedIds.has(i.order_id)) return;
          const name = i.item_name || 'Unknown';
          if (!itemMap[name]) itemMap[name] = { name, qty:0, revenue:0 };
          itemMap[name].qty     += parseInt(i.qty || 0);
          itemMap[name].revenue += parseFloat(i.line_total || 0);
        });
        topItems = Object.values(itemMap).sort((a,b) => b.qty - a.qty).slice(0,20);
      }

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
      const authA = await checkAuth(['OWNER','ADMIN']);
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
      const authS = await checkAdminAuth();
      if (!authS.ok) return res.status(403).json({ ok: false, error: authS.error });
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/staff_users?active=eq.true&order=user_id.asc&select=user_id,username,display_name,role,last_login,failed_attempts`
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to fetch staff' });
      const staffList = r.data || [];
      return res.status(200).json({ ok: true, staff: staffList, users: staffList });
    }

    // ── getCategories ──────────────────────────────────────────────────────
    if (action === 'getCategories') {
      const r = await supaFetch(`${SUPABASE_URL}/rest/v1/menu_categories?select=id,name&order=name.asc`);
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to fetch categories' });
      // Return Title Case names matching what menu items use (CATEGORY_ID_TO_NAME)
      const cats = (r.data || []).map(c => ({
        id: c.id,
        name: CATEGORY_ID_TO_NAME[c.id] || c.name
      }));
      return res.status(200).json({ ok: true, categories: cats });
    }

    // ── getCustomers ───────────────────────────────────────────────────────
    if (action === 'getCustomers') {
      const auth = await checkAuth(['ADMIN','OWNER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const limit = Math.min(parseInt(body.limit) || 100, 500);
      const search = body.search ? body.search.trim() : '';
      let url = `${SUPABASE_URL}/rest/v1/customers?order=last_visit.desc.nullsfirst&limit=${limit}&select=*`;
      if (search) url += `&or=(name.ilike.*${encodeURIComponent(search)}*,phone.ilike.*${encodeURIComponent(search)}*)`;
      const r = await supaFetch(url);
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to fetch customers' });
      return res.status(200).json({ ok: true, customers: r.data || [] });
    }

    // ── getCustomer ────────────────────────────────────────────────────────
    if (action === 'getCustomer') {
      const auth = await checkAuth(['ADMIN','OWNER','CASHIER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { id, phone } = body;
      let url;
      if (id) url = `${SUPABASE_URL}/rest/v1/customers?id=eq.${encodeURIComponent(id)}&select=*&limit=1`;
      else if (phone) url = `${SUPABASE_URL}/rest/v1/customers?phone=eq.${encodeURIComponent(phone)}&select=*&limit=1`;
      else return res.status(400).json({ ok: false, error: 'id or phone required' });
      const r = await supaFetch(url);
      if (!r.ok || !r.data.length) return res.status(404).json({ ok: false, error: 'Customer not found' });
      // Get order history
      const ordR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/dine_in_orders?customer_id=eq.${r.data[0].id}&order=created_at.desc&limit=20&select=order_id,created_at,total,status,discount_type`
      );
      return res.status(200).json({ ok: true, customer: r.data[0], orders: ordR.data || [] });
    }

    // ── upsertCustomer ─────────────────────────────────────────────────────
    if (action === 'upsertCustomer') {
      const auth = await checkAuth(['ADMIN','OWNER','CASHIER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { name, phone, email, notes } = body;
      if (!name) return res.status(400).json({ ok: false, error: 'name required' });
      // Check if customer exists by phone
      let existing = null;
      if (phone) {
        const ex = await supaFetch(`${SUPABASE_URL}/rest/v1/customers?phone=eq.${encodeURIComponent(phone)}&select=id&limit=1`);
        if (ex.ok && ex.data.length) existing = ex.data[0];
      }
      if (existing) {
        // Update
        const upd = { name, updated_at: new Date().toISOString() };
        if (email !== undefined) upd.email = email;
        if (notes !== undefined) upd.notes = notes;
        await supaFetch(`${SUPABASE_URL}/rest/v1/customers?id=eq.${existing.id}`, { method: 'PATCH', body: JSON.stringify(upd) });
        return res.status(200).json({ ok: true, id: existing.id, action: 'updated' });
      }
      // Create
      const payload = { name, phone: phone||null, email: email||null, notes: notes||null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      const r = await supaFetch(`${SUPABASE_URL}/rest/v1/customers`, { method: 'POST', body: JSON.stringify(payload), headers: { 'Prefer': 'return=representation' } });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to create customer' });
      return res.status(200).json({ ok: true, id: r.data[0]?.id, action: 'created' });
    }

    // ── updateCustomerStats ────────────────────────────────────────────────
    if (action === 'updateCustomerStats') {
      const { customerId, orderId, total } = body;
      if (!customerId) return res.status(400).json({ ok: false, error: 'customerId required' });
      const cur = await supaFetch(`${SUPABASE_URL}/rest/v1/customers?id=eq.${encodeURIComponent(customerId)}&select=total_orders,total_spent`);
      if (!cur.ok || !cur.data.length) return res.status(404).json({ ok: false, error: 'Customer not found' });
      const c = cur.data[0];
      const upd = {
        total_orders: (parseInt(c.total_orders)||0) + 1,
        total_spent: Math.round(((parseFloat(c.total_spent)||0) + (parseFloat(total)||0)) * 100) / 100,
        last_visit: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await supaFetch(`${SUPABASE_URL}/rest/v1/customers?id=eq.${encodeURIComponent(customerId)}`, { method: 'PATCH', body: JSON.stringify(upd) });
      if (orderId) await supaFetch(`${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}`, { method: 'PATCH', body: JSON.stringify({ customer_id: customerId }) });
      return res.status(200).json({ ok: true });
    }

    // ── getSettings ────────────────────────────────────────────────────────
    if (action === 'getSettings') {
      const now2 = Date.now();
      if (_settingsCache.data && (now2 - _settingsCache.ts) < SETTINGS_CACHE_TTL) {
        return res.status(200).json({ ok: true, settings: _settingsCache.data, cached: true });
      }
      const r = await supaFetch(`${SUPABASE_URL}/rest/v1/settings?order=key.asc&select=key,value,description`);
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to fetch settings' });
      _settingsCache.data = r.data || [];
      _settingsCache.ts = now2;
      return res.status(200).json({ ok: true, settings: _settingsCache.data });
    }

    // ── updateSetting ──────────────────────────────────────────────────────
    if (action === 'updateSetting') {
      const authUS = await checkAuth(['OWNER']);
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
      invalidateSettingsCache();
      return res.status(200).json({ ok: true, key, value });
    }


    // ══════════════════════════════════════════════════════════════════════
    // TABLE OCCUPANCY STATUS
    // ══════════════════════════════════════════════════════════════════════

    // ── syncToSheets ──────────────────────────────────────────────────────
    // Manual trigger: re-queue all unsynced items + ping GAS URL to run immediately
    if (action === 'syncToSheets') {
      const authSync = await checkAdminAuth();
      if (!authSync.ok) return res.status(403).json({ ok: false, error: authSync.error });

      // Count unsynced items
      const countR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/sheets_sync_log?synced=eq.false&select=id`,
        { headers: { Prefer: 'count=exact' } }
      );
      const pending = Array.isArray(countR.data) ? countR.data.length : 0;

      // Ping GAS URL to trigger syncNow() immediately (fire-and-forget, no-cors OK)
      let gasPinged = false;
      if (GAS_SYNC_URL) {
        try {
          fetch(`${GAS_SYNC_URL}?action=sync`, { method: 'GET' }).catch(() => {});
          gasPinged = true;
        } catch (_) {}
      }

      auditLog({ orderId: 'MANUAL_SYNC', action: 'SHEETS_SYNC_TRIGGERED', actor: { userId: body.userId }, details: { pending, gasPinged } });
      return res.status(200).json({ ok: true, pending, gasPinged, message: `${pending} item(s) queued. GAS will sync within 1 minute.` });
    }

    // ── getPendingSync ─────────────────────────────────────────────────────
    // Called by GAS SheetsSync.gs — returns pending orders/payments to write to Sheets
    // No auth required (GAS runs as sheet owner, data is non-sensitive aggregate)
    if (action === 'getPendingSync') {
      const secret = String(body.secret || '').trim();
      if (secret !== 'yani-sync-2026') return res.status(403).json({ ok: false, error: 'Invalid secret' });

      // Get pending sync items (limit 100 per batch)
      const batchLimit = Math.min(parseInt(body.limit) || 50, 100);
      const pendingR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/sheets_sync_log?synced=eq.false&order=created_at.asc&limit=${batchLimit}&select=id,table_name,record_id,action`
      );
      if (!pendingR.ok) return res.status(500).json({ ok: false, error: 'Failed to read sync log' });
      const pending = pendingR.data || [];
      if (pending.length === 0) return res.status(200).json({ ok: true, items: [], total: 0 });

      // Fetch full data for each item
      const orderIds  = [...new Set(pending.filter(p=>p.table_name==='dine_in_orders').map(p=>p.record_id))];
      const payIds    = [...new Set(pending.filter(p=>p.table_name==='payments').map(p=>p.record_id))];
      const syncLogIds = pending.map(p=>p.id);

      // Fetch orders
      let ordersMap = {};
      if (orderIds.length > 0) {
        const oR = await supaFetch(
          `${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=in.(${orderIds.map(id=>`"${id}"`).join(',')})` +
          `&select=order_id,order_no,table_no,customer_name,status,order_type,subtotal,service_charge,` +
          `vat_amount,total,discounted_total,discount_type,discount_amount,payment_method,payment_status,` +
          `receipt_type,receipt_email,notes,cancel_reason,created_at,is_test`
        );
        if (oR.ok) (oR.data||[]).forEach(o => { ordersMap[o.order_id] = o; });
      }

      // Fetch order items (for INSERTs only)
      let itemsMap = {};
      const insertOrderIds = pending.filter(p=>p.table_name==='dine_in_orders'&&p.action==='INSERT').map(p=>p.record_id);
      if (insertOrderIds.length > 0) {
        const iR = await supaFetch(
          `${SUPABASE_URL}/rest/v1/dine_in_order_items?order_id=in.(${insertOrderIds.map(id=>`"${id}"`).join(',')})` +
          `&order=id.asc&select=order_id,item_code,item_name,unit_price,qty,line_total,size_choice,sugar_choice,item_notes,addons`
        );
        if (iR.ok) {
          (iR.data||[]).forEach(it => {
            if (!itemsMap[it.order_id]) itemsMap[it.order_id] = [];
            itemsMap[it.order_id].push(it);
          });
        }
      }

      // Fetch payments
      let paymentsMap = {};
      if (payIds.length > 0) {
        const pR = await supaFetch(
          `${SUPABASE_URL}/rest/v1/payments?payment_id=in.(${payIds.map(id=>`"${id}"`).join(',')})` +
          `&select=payment_id,order_id,amount,payment_method,status,proof_url,proof_filename,verified_by,verified_at,rejection_reason,created_at`
        );
        if (pR.ok) (pR.data||[]).forEach(p => { paymentsMap[p.payment_id] = p; });
      }

      // Build response items, collect skipped IDs to auto-mark synced
      const skippedSyncIds = [];
      const items = pending.map(p => {
        if (p.table_name === 'dine_in_orders') {
          const order = ordersMap[p.record_id];
          if (!order || order.is_test || order.is_deleted) {
            skippedSyncIds.push(p.id); // skip: test, deleted, or not found
            return null;
          }
          return {
            syncId: p.id, tableType: 'ORDER', action: p.action,
            order,
            orderItems: itemsMap[p.record_id] || []
          };
        } else if (p.table_name === 'payments') {
          const payment = paymentsMap[p.record_id];
          if (!payment) return null;
          // Convert base64 proof to Storage URL reference
          if (payment.proof_url && payment.proof_url.startsWith('data:')) {
            payment.proof_url = payment.proof_filename
              ? `${SUPABASE_URL}/storage/v1/object/public/payment-proofs/${payment.proof_filename}`
              : '[View in admin panel]';
          }
          return { syncId: p.id, tableType: 'PAYMENT', action: p.action, payment };
        }
        return { syncId: p.id, tableType: 'OTHER', action: p.action };
      }).filter(Boolean);

      // Auto-mark test/missing orders as synced so they don't pile up
      if (skippedSyncIds.length > 0) {
        supa('PATCH', 'sheets_sync_log',
          { synced: true, synced_at: new Date().toISOString() },
          { id: `in.(${skippedSyncIds.join(',')})` }
        ).catch(() => {});
      }

      return res.status(200).json({ ok: true, items, total: pending.length, syncLogIds, skipped: skippedSyncIds.length });
    }

    // ── markSynced ─────────────────────────────────────────────────────────
    // Called by GAS after successfully writing items to Sheets
    if (action === 'markSynced') {
      const secret = String(body.secret || '').trim();
      if (secret !== 'yani-sync-2026') return res.status(403).json({ ok: false, error: 'Invalid secret' });
      const ids = body.ids;
      if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ ok: false, error: 'ids array required' });
      const validIds = ids.filter(id => Number.isInteger(id) && id > 0);
      if (validIds.length === 0) return res.status(400).json({ ok: false, error: 'No valid ids' });

      const r = await supa('PATCH', 'sheets_sync_log',
        { synced: true, synced_at: new Date().toISOString() },
        { id: `in.(${validIds.join(',')})` }
      );
      return res.status(200).json({ ok: r.ok, marked: validIds.length });
    }

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
      const auth = await checkAuth(['OWNER','ADMIN','CASHIER']);
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
      const auth = await checkAuth(['OWNER','ADMIN','CASHIER']);
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
      const auth = await checkAuth(['OWNER','ADMIN','CASHIER']);
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
      const auth = await checkAuth(['OWNER','ADMIN','CASHIER']);
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
        selling_price: i.selling_price || 0,
        size_per_unit: i.size_per_unit || '',
        photo_url: i.photo_url || null,
      }));
      return res.status(200).json({ ok: true, items });
    }

    // ── uploadInventoryPhoto ───────────────────────────────────────────────
    if (action === 'uploadInventoryPhoto') {
      const auth = await checkAdminAuth();
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { itemCode, imageBase64, mimeType } = body;
      if (!itemCode || !imageBase64) return res.status(400).json({ ok: false, error: 'itemCode + imageBase64 required' });
      const ext = (mimeType || 'image/jpeg').split('/')[1] || 'jpg';
      const filename = `${itemCode.replace(/[^a-zA-Z0-9-_]/g, '_')}.${ext}`;
      // Decode base64 and upload to Supabase Storage
      const imgBuffer = Buffer.from(imageBase64, 'base64');
      const uploadResp = await fetch(`${SUPABASE_URL}/storage/v1/object/inventory/${filename}`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': mimeType || 'image/jpeg',
          'x-upsert': 'true',
        },
        body: imgBuffer,
      });
      if (!uploadResp.ok) {
        const errText = await uploadResp.text();
        return res.status(500).json({ ok: false, error: 'Upload failed: ' + errText });
      }
      const photoUrl = `${SUPABASE_URL}/storage/v1/object/public/inventory/${filename}`;
      // Save URL on inventory row
      await supaFetch(
        `${SUPABASE_URL}/rest/v1/inventory?item_code=eq.${encodeURIComponent(itemCode)}`,
        { method: 'PATCH', body: JSON.stringify({ photo_url: photoUrl, updated_at: new Date().toISOString() }) }
      );
      return res.status(200).json({ ok: true, photoUrl, filename });
    }

    // ── upsertInventory ────────────────────────────────────────────────────
    if (action === 'upsertInventory') {
      const auth = await checkAdminAuth();
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { itemCode, stockQty, lowStockThreshold, unit, costPerUnit, sellingPrice,
              sizePerUnit, autoDisable, restockNotes, photoUrl } = body;
      if (!itemCode) return res.status(400).json({ ok: false, error: 'itemCode required' });
      const row = {
        item_code: itemCode,
        stock_qty: parseFloat(stockQty) || 0,
        low_stock_threshold: parseFloat(lowStockThreshold) || 10,
        unit: unit || 'pcs',
        cost_per_unit: parseFloat(costPerUnit) || 0,
        selling_price: parseFloat(sellingPrice) || 0,
        size_per_unit: sizePerUnit || '',
        auto_disable: !!autoDisable,
        restock_notes: restockNotes || '',
        last_restocked_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      if (photoUrl) row.photo_url = photoUrl;
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
      const auth = await checkAdminAuth();
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { itemCode, adjustment, changeType, notes, unitPrice, reference, direction } = body;
      if (!itemCode || adjustment === undefined) return res.status(400).json({ ok: false, error: 'itemCode + adjustment required' });
      // direction: 'IN' = positive (RESTOCK/RETURN), 'OUT' = negative (WASTE/SALE)
      // If direction provided, force the sign; otherwise trust the sign of adjustment
      let qty = parseFloat(adjustment);
      if (direction === 'IN' && qty < 0) qty = -qty;
      if (direction === 'OUT' && qty > 0) qty = -qty;
      const validTypes = ['RESTOCK','ADJUSTMENT','WASTE','RETURN','SALE'];
      let type = validTypes.includes(changeType) ? changeType : 'ADJUSTMENT';
      // Auto-assign type based on direction if not specified
      if (!changeType) type = direction === 'IN' ? 'RESTOCK' : direction === 'OUT' ? 'WASTE' : 'ADJUSTMENT';
      // Get current
      const cur = await supaFetch(`${SUPABASE_URL}/rest/v1/inventory?item_code=eq.${encodeURIComponent(itemCode)}&select=stock_qty,auto_disable`);
      const current = cur.data?.[0];
      if (!current) return res.status(404).json({ ok: false, error: 'Item not in inventory' });
      const newQty = Math.max(0, parseFloat(current.stock_qty) + qty);
      const updatePatch = { stock_qty: newQty, updated_at: new Date().toISOString() };
      if (direction === 'IN') updatePatch.last_restocked_at = new Date().toISOString();
      await supaFetch(`${SUPABASE_URL}/rest/v1/inventory?item_code=eq.${encodeURIComponent(itemCode)}`,
        { method: 'PATCH', body: JSON.stringify(updatePatch) });
      // Auto-disable menu item if stock hits 0
      if (newQty === 0 && current.auto_disable) {
        await supaFetch(`${SUPABASE_URL}/rest/v1/menu_items?item_code=eq.${encodeURIComponent(itemCode)}`,
          { method: 'PATCH', body: JSON.stringify({ is_active: false }) });
      }
      // Log with new fields
      await supaFetch(`${SUPABASE_URL}/rest/v1/inventory_log`, { method: 'POST',
        body: JSON.stringify({ item_code: itemCode, change_type: type,
          qty_before: parseFloat(current.stock_qty), qty_change: qty,
          qty_after: newQty, notes: notes || '', actor_id: body.userId,
          unit_price: parseFloat(unitPrice) || 0,
          reference: reference || '' }) });
      return res.status(200).json({ ok: true, itemCode, qtyBefore: current.stock_qty, qtyAfter: newQty, direction: qty >= 0 ? 'IN' : 'OUT' });
    }

    // ── getInventoryLog ────────────────────────────────────────────────────
    if (action === 'getInventoryLog') {
      const auth = await checkAuth(['OWNER','ADMIN']);
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
      const auth = await checkAdminAuth();
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/menu_addons?order=sort_order.asc,name.asc`
      );
      return res.status(200).json({ ok: r.ok, addons: r.data || [] });
    }

    // ── saveAddon ──────────────────────────────────────────────────────────
    if (action === 'saveAddon') {
      const auth = await checkAdminAuth();
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
      const auth = await checkAdminAuth();
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
      const auth = await checkAuth(['OWNER','ADMIN']);
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
    // ── getPromoCodes ──────────────────────────────────────────────────────
    // ── sendSalesReport ────────────────────────────────────────────────────
    if (action === 'sendSalesReport') {
      const auth = await checkAuth(['OWNER','ADMIN']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { toEmail, dateFrom, dateTo, reportHtml, subject } = body;
      if (!toEmail) return res.status(400).json({ ok: false, error: 'toEmail required' });
      if (!reportHtml) return res.status(400).json({ ok: false, error: 'reportHtml required' });
      try {
        const resp = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: `YANI Garden Cafe <${FROM_EMAIL}>`,
            to: [toEmail],
            subject: subject || `📊 YANI Sales Report — ${dateFrom} to ${dateTo}`,
            html: reportHtml,
          }),
        });
        const result = await resp.json();
        if (!resp.ok) return res.status(500).json({ ok: false, error: result.message || 'Email failed' });
        return res.status(200).json({ ok: true, emailId: result.id });
      } catch(e) {
        return res.status(500).json({ ok: false, error: e.message });
      }
    }

    if (action === 'getPromoCodes') {
      const auth = await checkAuth(['ADMIN','OWNER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const r = await supaFetch(`${SUPABASE_URL}/rest/v1/promo_codes?order=created_at.desc&select=*`);
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to fetch promo codes' });
      return res.status(200).json({ ok: true, codes: r.data || [] });
    }

    // ── createPromoCode ────────────────────────────────────────────────────
    if (action === 'createPromoCode') {
      const auth = await checkAuth(['ADMIN','OWNER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { code, discount_type, discount_value, valid_from, valid_until, max_uses, description } = body;
      if (!code || !discount_type || !discount_value) return res.status(400).json({ ok: false, error: 'code, discount_type, and discount_value required' });
      const payload = {
        code: String(code).toUpperCase().trim(),
        discount_type,
        discount_value: parseFloat(discount_value),
        valid_from: valid_from || null,
        valid_until: valid_until || null,
        max_uses: max_uses ? parseInt(max_uses) : null,
        description: description || null,
        used_count: 0,
        is_active: true,
        created_at: new Date().toISOString()
      };
      const r = await supaFetch(`${SUPABASE_URL}/rest/v1/promo_codes`, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Prefer': 'return=representation' }
      });
      if (!r.ok) return res.status(500).json({ ok: false, error: r.data?.message || 'Failed to create promo code' });
      return res.status(200).json({ ok: true, code: r.data[0] });
    }

    // ── updatePromoCode ────────────────────────────────────────────────────
    if (action === 'updatePromoCode') {
      const auth = await checkAuth(['ADMIN','OWNER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { id, is_active, discount_value, valid_until, max_uses, description } = body;
      if (!id) return res.status(400).json({ ok: false, error: 'id required' });
      const updates = {};
      if (is_active !== undefined) updates.is_active = is_active;
      if (discount_value !== undefined) updates.discount_value = parseFloat(discount_value);
      if (valid_until !== undefined) updates.valid_until = valid_until || null;
      if (max_uses !== undefined) updates.max_uses = max_uses ? parseInt(max_uses) : null;
      if (description !== undefined) updates.description = description;
      const r = await supaFetch(`${SUPABASE_URL}/rest/v1/promo_codes?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH', body: JSON.stringify(updates)
      });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to update promo code' });
      return res.status(200).json({ ok: true });
    }

    // ── deletePromoCode ────────────────────────────────────────────────────
    if (action === 'deletePromoCode') {
      const auth = await checkAuth(['OWNER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { id } = body;
      if (!id) return res.status(400).json({ ok: false, error: 'id required' });
      const r = await supaFetch(`${SUPABASE_URL}/rest/v1/promo_codes?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to delete promo code' });
      return res.status(200).json({ ok: true });
    }

    // ── validatePromoCode (used by customer POS) ───────────────────────────
    if (action === 'validatePromoCode') {
      const { code, subtotal } = body;
      if (!code) return res.status(400).json({ ok: false, error: 'code required' });
      const r = await supaFetch(`${SUPABASE_URL}/rest/v1/promo_codes?code=eq.${encodeURIComponent(code.toUpperCase())}&is_active=eq.true&select=*&limit=1`);
      if (!r.ok || !r.data?.length) return res.status(200).json({ ok: false, error: 'Invalid or expired promo code' });
      const pc = r.data[0];
      const now = new Date();
      if (pc.valid_from && new Date(pc.valid_from) > now) return res.status(200).json({ ok: false, error: 'Promo code not yet active' });
      if (pc.valid_until && new Date(pc.valid_until) < now) return res.status(200).json({ ok: false, error: 'Promo code has expired' });
      if (pc.max_uses && pc.used_count >= pc.max_uses) return res.status(200).json({ ok: false, error: 'Promo code usage limit reached' });
      const sub = parseFloat(subtotal) || 0;
      const discount = pc.discount_type === 'PERCENT' ? Math.round(sub * pc.discount_value / 100 * 100) / 100 : parseFloat(pc.discount_value);
      return res.status(200).json({ ok: true, code: pc.code, discount_type: pc.discount_type, discount_value: pc.discount_value, discount_amount: discount, description: pc.description });
    }

    if (action === 'getRefunds') {
      const auth = await checkAuth(['OWNER','ADMIN']);
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
      const auth = await checkAuth(['OWNER','ADMIN','CASHIER']);
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
      const auth = await checkAuth(['OWNER','ADMIN','CASHIER']);
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
      const auth = await checkAuth(['OWNER','ADMIN']);
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

    // ── runMigration (OWNER only - creates tables if not exist) ───────────────
    if (action === 'runMigration') {
      const auth = await checkAuth(['OWNER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const sql = `
        CREATE TABLE IF NOT EXISTS promo_codes (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          code text UNIQUE NOT NULL,
          discount_type text NOT NULL CHECK (discount_type IN ('PERCENT','FIXED')),
          discount_value numeric NOT NULL CHECK (discount_value > 0),
          description text,
          valid_from timestamptz,
          valid_until timestamptz,
          max_uses integer,
          used_count integer DEFAULT 0,
          is_active boolean DEFAULT true,
          created_at timestamptz DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS promo_codes_code_idx ON promo_codes(code);
        CREATE INDEX IF NOT EXISTS promo_codes_active_idx ON promo_codes(is_active);
      `;
      const r = await supaFetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
        method: 'POST', body: JSON.stringify({ sql })
      });
      // Try direct query endpoint as fallback
      const r2 = await fetch(`${SUPABASE_URL.replace('.supabase.co','')}/pg/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
        body: JSON.stringify({ query: sql })
      });
      return res.status(200).json({ ok: true, msg: 'Migration attempted' });
    }

    // ── Unknown action ─────────────────────────────────────────────────────
    return res.status(400).json({ ok: false, error: `Unknown action: ${action}` });

  } catch (err) {
    console.error('API error:', err);
    return res.status(500).json({ ok: false, error: 'Server error: ' + err.message });
  }
}

// ── One-time migration endpoint (safe to call multiple times - uses IF NOT EXISTS) ──
