// ── PRINT QUEUE HANDLER (ESM) ────────────────────────────────────────────
// ISOLATED MODULE. Touches only print_jobs + the print_* RPCs.
// Never writes to dine_in_orders, menu_items or any pre-existing table.
//
// Flow:  iPad/admin  →  printEnqueueOrder   (creates one job per drink UNIT)
//        Windows agent → printClaim         (atomic, SKIP LOCKED)
//                      → printComplete      (PRINTED | FAILED)
//
// The agent authenticates with a shared station key, NOT an admin JWT, so a
// print station cannot read orders, payroll or anything else.
// ─────────────────────────────────────────────────────────────────────────
import { supaFetch, supa } from '../lib/db.js';
import { SUPABASE_URL }    from '../lib/config.js';

const PRINT_ACTIONS = new Set([
  'printEnqueueOrder', 'printQueue', 'printCancel', 'printReprint',
]);
// Station actions use the station key instead of admin auth
const STATION_ACTIONS = new Set(['printClaim', 'printComplete', 'printPing', 'stationSyncOrder']);

const bad  = (res, msg) => res.status(400).json({ ok: false, error: msg });
const boom = (res, msg) => res.status(500).json({ ok: false, error: msg });
const str  = (v, max = 300) => (v === null || v === undefined ? null : String(v).trim().substring(0, max));

async function rpc(fn, args) {
  return supaFetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    body: JSON.stringify(args || {}),
  });
}

let _keyCache = { value: null, ts: 0 };
const KEY_TTL = 60 * 1000;

async function getStationKey() {
  if (process.env.PRINT_STATION_KEY) return process.env.PRINT_STATION_KEY;
  if (_keyCache.value && Date.now() - _keyCache.ts < KEY_TTL) return _keyCache.value;
  const r = await supaFetch(`${SUPABASE_URL}/rest/v1/print_config?select=value&key=eq.station_key`);
  const v = r.ok && Array.isArray(r.data) && r.data[0] ? r.data[0].value : null;
  if (v) _keyCache = { value: v, ts: Date.now() };
  return v;
}

async function stationOk(body) {
  const expected = await getStationKey();
  if (!expected) return false;              // no key configured = station disabled, fail closed
  const given = String(body.stationKey || '');
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export async function routePrint(action, body, auth, req, res) {
  const isStation = STATION_ACTIONS.has(action);
  if (!PRINT_ACTIONS.has(action) && !isStation) return false;

  // ══ STATION SURFACE ═══════════════════════════════════════════════════
  if (isStation) {
    if (!(await stationOk(body))) return res.status(403).json({ ok: false, error: 'Invalid station key' });
    const station = str(body.station, 60) || 'station';

    if (action === 'printPing') {
      return res.status(200).json({ ok: true, station, serverTime: new Date().toISOString() });
    }

    if (action === 'printClaim') {
      const limit = Math.min(Math.max(parseInt(body.limit, 10) || 5, 1), 20);
      const r = await rpc('print_claim_next', { p_station: station, p_limit: limit });
      if (!r.ok) return boom(res, 'Claim failed');
      return res.status(200).json({ ok: true, jobs: Array.isArray(r.data) ? r.data : [] });
    }

    if (action === 'stationSyncOrder') {
      // Orders taken on the counter PC while the internet was down.
      // Stored with their offline order_id so the printed label always matches
      // the record, and flagged so they are distinguishable in reports.
      const o = body.order || {};
      const localId = str(o.order_id, 60);
      if (!localId) return bad(res, 'order.order_id required');
      if (!Array.isArray(o.items) || !o.items.length) return bad(res, 'order.items required');

      const dup = await supaFetch(
        `${SUPABASE_URL}/rest/v1/dine_in_orders?select=order_id&order_id=eq.${encodeURIComponent(localId)}`
      );
      if (dup.ok && Array.isArray(dup.data) && dup.data.length) {
        return res.status(200).json({ ok: true, orderId: localId, duplicate: true });
      }

      const num = (v) => (v === null || v === undefined || v === '' ? 0 : parseFloat(v) || 0);
      const ins = await supa('POST', 'dine_in_orders', {
        order_id: localId,
        table_no: str(o.tableNo, 10) || '0',
        customer_name: str(o.customerName, 100) || 'Guest',
        order_type: o.orderType === 'TAKE-OUT' ? 'TAKE-OUT' : 'DINE-IN',
        status: 'COMPLETED',
        subtotal: num(o.subtotal),
        service_charge: num(o.serviceCharge),
        total: num(o.total),
        notes: str(o.notes, 500),
        payment_method: str(o.paymentMethod, 30) || 'CASH',
        payment_status: 'PAID',
        created_at: o.created_at || new Date().toISOString(),
      });
      if (!ins.ok) return boom(res, 'Order insert failed');

      const rows = o.items.map((it) => {
        const q = parseInt(it.qty, 10) || 1;
        const p = num(it.price);
        return {
          order_id: localId,
          table_no: str(o.tableNo, 10) || '0',
          item_code: str(it.item_code, 40),
          item_name: str(it.name, 200),
          qty: q,
          unit_price: p,
          line_total: Math.round(p * q * 100) / 100,
          size_choice: str(it.size, 60),
          sugar_choice: str(it.sugar, 60),
          item_notes: str(it.note, 300),
          created_at: o.created_at || new Date().toISOString(),
        };
      });
      const insItems = await supa('POST', 'dine_in_order_items', rows);
      if (!insItems.ok) return boom(res, 'Order items insert failed');

      return res.status(200).json({ ok: true, orderId: localId, items: rows.length });
    }

    if (action === 'printComplete') {
      const id = str(body.id, 60);
      if (!id) return bad(res, 'id required');
      const okFlag = body.success !== false;
      const patch = okFlag
        ? { status: 'PRINTED', printed_at: new Date().toISOString(), last_error: null }
        : { status: 'FAILED',  last_error: str(body.error, 500) || 'Unknown print error' };
      const r = await supa('PATCH', 'print_jobs', patch, { id: `eq.${id}` });
      if (!r.ok) return boom(res, 'Update failed');
      return res.status(200).json({ ok: true });
    }
  }

  // ══ ADMIN SURFACE ═════════════════════════════════════════════════════
  const { checkAdminAuth } = auth;
  const a = await checkAdminAuth();
  if (!a.ok) return res.status(403).json({ ok: false, error: a.error });

  if (action === 'printEnqueueOrder') {
    const orderId = str(body.orderId, 60);
    if (!orderId) return bad(res, 'orderId required');
    const r = await rpc('print_enqueue_order', {
      p_order_id: orderId,
      p_categories: Array.isArray(body.categories) ? body.categories : null,
      p_force: !!body.force,
    });
    if (!r.ok) return boom(res, 'Enqueue failed');
    const row = Array.isArray(r.data) ? r.data[0] : r.data;
    return res.status(200).json({ ok: true, ...(row || {}) });
  }

  if (action === 'printReprint') {
    // Reprint ONE label without regenerating the whole order
    const id = str(body.id, 60);
    if (!id) return bad(res, 'id required');
    const r = await supa('PATCH', 'print_jobs',
      { status: 'QUEUED', claimed_by: null, claimed_at: null, printed_at: null, last_error: null },
      { id: `eq.${id}` });
    if (!r.ok) return boom(res, 'Reprint failed');
    return res.status(200).json({ ok: true });
  }

  if (action === 'printCancel') {
    const orderId = str(body.orderId, 60);
    const id      = str(body.id, 60);
    if (!orderId && !id) return bad(res, 'orderId or id required');
    const filter = id ? { id: `eq.${id}` } : { order_id: `eq.${orderId}`, status: 'in.(QUEUED,CLAIMED)' };
    const r = await supa('PATCH', 'print_jobs', { status: 'CANCELLED' }, filter);
    if (!r.ok) return boom(res, 'Cancel failed');
    return res.status(200).json({ ok: true });
  }

  if (action === 'printQueue') {
    const status = str(body.status, 20);
    const f = status ? `&status=eq.${encodeURIComponent(status)}` : '';
    const r = await supaFetch(
      `${SUPABASE_URL}/rest/v1/print_jobs?select=*${f}&order=created_at.desc&limit=100`
    );
    if (!r.ok) return boom(res, 'Query failed');
    return res.status(200).json({ ok: true, jobs: r.data || [] });
  }

  return false;
}
