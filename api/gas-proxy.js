// ══════════════════════════════════════════════════════════════════════
// YANI POS — GAS Proxy API  /api/gas-proxy
//
// GAS cannot reach Supabase directly (network restriction).
// This endpoint acts as a bridge:
//   GAS  →  yanigardencafe.com/api/gas-proxy  →  Supabase
//
// Actions (GET params or POST JSON):
//   ?action=getPending          — returns up to 100 unsynced items with full data
//   ?action=getOrders&ids=...   — returns order rows for given IDs (comma-separated)
//   ?action=getPayments&ids=... — returns payment rows for given IDs
//   ?action=getItems&orderId=.. — returns order items for an order
//   ?action=markSynced&ids=...  — marks sync_log IDs as synced=true
//   ?action=health              — returns { ok: true } for connectivity test
//
// Auth: simple shared secret in ?secret= param
// ══════════════════════════════════════════════════════════════════════

const SUPABASE_URL = 'https://hnynvclpvfxzlfjphefj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
const PROXY_SECRET = process.env.GAS_SYNC_SECRET || 'yani-sync-2026';

const ALLOWED_ORIGINS = [
  'https://yanigardencafe.com',
  'https://pos.yanigardencafe.com',
  'https://admin.yanigardencafe.com',
];

export default async function handler(req, res) {
  // CORS
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    // Allow GAS (no origin header) and same-origin
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Parse params from GET or POST
  let params = {};
  if (req.method === 'GET') {
    params = req.query || {};
  } else if (req.method === 'POST') {
    try { params = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
    catch (_) { params = {}; }
  }

  const { action, secret, ids, orderId } = params;

  // Auth check (skip for health)
  if (action !== 'health' && secret !== PROXY_SECRET) {
    return res.status(403).json({ ok: false, error: 'Unauthorized' });
  }

  const supa = async (path) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
      }
    });
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
    return r.json();
  };

  const supaPatch = async (path, data) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(data),
    });
    return r.ok;
  };

  try {

    // ── health ─────────────────────────────────────────────────────────
    if (!action || action === 'health') {
      const rows = await supa('/sheets_sync_log?synced=eq.false&limit=1&select=id');
      return res.status(200).json({
        ok: true,
        supabaseReachable: true,
        pendingCount: Array.isArray(rows) ? 'check getPending' : 0,
        timestamp: new Date().toISOString(),
      });
    }

    // ── getPending ─────────────────────────────────────────────────────
    if (action === 'getPending') {
      const pending = await supa(
        '/sheets_sync_log?synced=eq.false&order=created_at.asc&limit=100&select=id,table_name,record_id,action,created_at'
      );
      return res.status(200).json({ ok: true, items: pending || [], count: (pending || []).length });
    }

    // ── getOrders ──────────────────────────────────────────────────────
    if (action === 'getOrders') {
      if (!ids) return res.status(400).json({ ok: false, error: 'ids required' });
      const idList = String(ids).split(',').slice(0, 50).map(i => `"${i.trim()}"`).join(',');
      const orders = await supa(
        `/dine_in_orders?order_id=in.(${idList})&select=order_id,order_no,table_no,customer_name,status,order_type,subtotal,service_charge,vat_amount,total,discounted_total,discount_type,discount_amount,payment_method,payment_status,receipt_type,receipt_email,notes,cancel_reason,created_at,is_test`
      );
      return res.status(200).json({ ok: true, orders: orders || [] });
    }

    // ── getPayments ────────────────────────────────────────────────────
    if (action === 'getPayments') {
      if (!ids) return res.status(400).json({ ok: false, error: 'ids required' });
      const idList = String(ids).split(',').slice(0, 50).map(i => `"${i.trim()}"`).join(',');
      const payments = await supa(
        `/payments?payment_id=in.(${idList})&select=payment_id,order_id,amount,payment_method,status,proof_url,proof_filename,verified_by,verified_at,rejection_reason,created_at`
      );
      return res.status(200).json({ ok: true, payments: payments || [] });
    }

    // ── getItems ───────────────────────────────────────────────────────
    if (action === 'getItems') {
      if (!orderId) return res.status(400).json({ ok: false, error: 'orderId required' });
      const items = await supa(
        `/dine_in_order_items?order_id=eq.${encodeURIComponent(orderId)}&order=id.asc&select=order_id,item_code,item_name,unit_price,qty,line_total,size_choice,sugar_choice,item_notes,addons`
      );
      return res.status(200).json({ ok: true, items: items || [] });
    }

    // ── markSynced ─────────────────────────────────────────────────────
    if (action === 'markSynced') {
      if (!ids) return res.status(400).json({ ok: false, error: 'ids required' });
      const idList = String(ids).split(',').slice(0, 100).map(i => i.trim()).join(',');
      await supaPatch(
        `/sheets_sync_log?id=in.(${idList})`,
        { synced: true, synced_at: new Date().toISOString() }
      );
      return res.status(200).json({ ok: true, marked: idList.split(',').length });
    }

    return res.status(400).json({ ok: false, error: `Unknown action: ${action}` });

  } catch (e) {
    console.error('gas-proxy error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
