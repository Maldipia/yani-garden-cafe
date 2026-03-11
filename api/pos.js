// YANI POS — Vercel Serverless API  (v4 — hardened)
// ══════════════════════════════════════════════════════════════════════
// All actions handled directly in Supabase. GAS-free.
// Write endpoints require ADMIN or OWNER role (userId in request body).
// CORS restricted to known domains. No hardcoded key fallbacks.
// ══════════════════════════════════════════════════════════════════════

const SUPABASE_URL = 'https://hnynvclpvfxzlfjphefj.supabase.co';
// Service role key — loaded from env only. No hardcoded fallback.
const SUPABASE_KEY = (() => {
  const k = process.env.SUPABASE_SECRET_KEY;
  if (!k) throw new Error('SUPABASE_SECRET_KEY env var is not set');
  return k;
})();

const SERVICE_CHARGE_RATE = 0.10;
const ORDER_PREFIX = 'YANI';

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

// ── SHA-256 hash (for PIN verification) ───────────────────────────────────
async function sha256(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Log to sheets_sync_log (fire-and-forget) ──────────────────────────────
function logSync(tableName, recordId, action) {
  supa('POST', 'sheets_sync_log', {
    table_name: tableName,
    record_id: String(recordId),
    action,
    synced: false,
  }).catch(() => {});
}

// ── In-memory menu cache (5-minute TTL) ──────────────────────────────────
const menuCache = { public: null, admin: null, ts: 0 };
const MENU_CACHE_TTL = 5 * 60 * 1000;
function invalidateMenuCache() { menuCache.public = null; menuCache.admin = null; menuCache.ts = 0; }

// ── Admin role guard ──────────────────────────────────────────────────────
// Verifies that body.userId belongs to an active ADMIN or OWNER staff user.
async function requireAdminRole(body) {
  const userId = String(body.userId || '').trim();
  if (!userId) return { ok: false, error: 'userId is required for this action' };
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
  if (!checkRateLimit(ip)) {
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
      const tableNo      = String(body.tableNo || '1').trim();
      const tableToken   = String(body.tableToken || '').trim();
      const customerName = String(body.customerName || 'Guest').trim().substring(0, 100);
      const notes        = String(body.notes || '').trim().substring(0, 500);
      const orderType    = String(body.orderType || 'DINE-IN').toUpperCase();
      const items        = Array.isArray(body.items) ? body.items : [];

      if (items.length === 0) return res.status(400).json({ ok: false, error: 'Order must have at least one item' });

      // Validate table token against DB (skip for take-out with no tableNo)
      if (tableToken) {
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
      const total     = Math.round((subtotal + svcCharge) * 100) / 100;

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

      return res.status(200).json({
        ok: true,
        orderId,
        ORDER_ID: orderId,
        orderNo,
        subtotal,
        serviceCharge: svcCharge,
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
              code:  it.item_code,
              name:  it.item_name,
              price: it.unit_price,
              qty:   it.qty,
              size:  it.size_choice || '',
              sugar: it.sugar_choice || '',
              notes: it.item_notes || '',
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
        total:         o.total,
        notes:         o.notes || '',
        source:        o.source || 'QR',
        platform:      o.platform || '',
        platformRef:   o.platform_ref || '',
        paymentMethod: o.payment_method || '',
        paymentStatus: o.payment_status || '',
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

      const patch = { status: newStatus };
      if (newStatus === 'CANCELLED' && cancelReason) patch.cancel_reason = cancelReason;

      const r = await supa('PATCH', 'dine_in_orders', patch, { order_id: `eq.${orderId}` });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to update status' });

      logSync('dine_in_orders', orderId, 'UPDATE');
      return res.status(200).json({ ok: true, orderId, status: newStatus });
    }

    // ── deleteOrder ────────────────────────────────────────────────────────
    if (action === 'deleteOrder') {
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
      return res.status(200).json({ ok: true, orderId });
    }

    // ── editOrderItems ─────────────────────────────────────────────────────
    if (action === 'editOrderItems') {
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

      const svcCharge = Math.round(subtotal * SERVICE_CHARGE_RATE * 100) / 100;
      const total     = Math.round((subtotal + svcCharge) * 100) / 100;

      // Delete old items and insert new ones
      await supa('DELETE', 'dine_in_order_items', null, { order_id: `eq.${orderId}` });
      if (itemRows.length > 0) await supa('POST', 'dine_in_order_items', itemRows);

      // Update order totals
      await supa('PATCH', 'dine_in_orders', { subtotal, service_charge: svcCharge, total }, { order_id: `eq.${orderId}` });

      logSync('dine_in_orders', orderId, 'UPDATE');
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

      return res.status(200).json({ ok: true, orderId, total, subtotal });
    }

    // ── requestReceipt ─────────────────────────────────────────────────────
    if (action === 'requestReceipt') {
      const orderId = String(body.orderId || '').trim();
      if (!orderId) return res.status(400).json({ ok: false, error: 'orderId is required' });

      const updates = {
        receipt_type:     body.receiptType     || '',
        receipt_delivery: body.delivery        || '',
        receipt_email:    body.email           || '',
        receipt_name:     body.name            || '',
        receipt_address:  body.address         || '',
        receipt_tin:      body.tin             || '',
      };
      await supa('PATCH', 'dine_in_orders', updates, { order_id: `eq.${orderId}` });
      return res.status(200).json({ ok: true });
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

    // ── verifyUserPin ──────────────────────────────────────────────────────
    if (action === 'verifyUserPin') {
      const pin = String(body.pin || '').trim();
      if (!pin || pin.length < 4) return res.status(400).json({ ok: false, error: 'PIN is required' });

      const pinHash = await sha256(pin);

      // Check for locked accounts first
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/staff_users?pin_hash=eq.${encodeURIComponent(pinHash)}&active=eq.true&select=user_id,username,display_name,role,active,locked_until`
      );

      if (!r.ok || !r.data.length) {
        // Increment failed attempts on all users (we don't know which one)
        // Just return invalid PIN
        return res.status(200).json({ ok: false, error: 'Invalid PIN' });
      }

      const user = r.data[0];

      // Check if locked
      if (user.locked_until && new Date(user.locked_until) > new Date()) {
        return res.status(200).json({ ok: false, error: 'Account locked. Please wait.' });
      }

      // Update last_login and reset failed_attempts
      await supa('PATCH', 'staff_users', {
        last_login:      new Date().toISOString(),
        failed_attempts: 0,
        locked_until:    null,
      }, { user_id: `eq.${user.user_id}` });

      // Return flat fields for admin.html compatibility
      return res.status(200).json({
        ok: true,
        userId:      user.user_id,
        username:    user.username,
        displayName: user.display_name,
        role:        user.role,
        // Also include nested user object for future clients
        user: {
          userId:      user.user_id,
          username:    user.username,
          displayName: user.display_name,
          role:        user.role,
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
    if (action === 'getCustomers') {
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
      return res.status(200).json({ success: true, customers });
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
        },
        daily,
        hourly,
        topItems,
        cancelBreakdown: cancelMap,
      });
    }

    // ── getStaff ───────────────────────────────────────────────────────────
    if (action === 'getStaff') {
      const authS = await requireAdminRole(body);
      if (!authS.ok) return res.status(403).json({ ok: false, error: authS.error });
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/staff_users?active=eq.true&order=user_id.asc&select=user_id,username,display_name,role,last_login,failed_attempts`
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to fetch staff' });
      return res.status(200).json({ ok: true, users: r.data || [] });
    }

    // ── Unknown action ─────────────────────────────────────────────────────
    return res.status(400).json({ ok: false, error: `Unknown action: ${action}` });

  } catch (err) {
    console.error('API error:', err);
    return res.status(500).json({ ok: false, error: 'Server error: ' + err.message });
  }
}
