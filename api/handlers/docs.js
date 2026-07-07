// ── DOCS HANDLER (ESM) ─────────────────────────────────────────────────────
// BIR daily-sales ledger (docs_daily_sales) + live POS transactions view.
// Moved server-side so the admin browser no longer reads/writes these tables
// with the anon key. All actions require ADMIN/OWNER. Service key bypasses RLS.
import { supaFetch, supa } from '../lib/db.js';
import { SUPABASE_URL }    from '../lib/config.js';

const DOCS_ACTIONS = new Set([
  'getDocsLedger', 'getDocsLive', 'lookupDocsOrder', 'saveDocsEntry', 'voidDocsEntry',
  'getDocsCardPayments'
]);

// Columns a client may write. status / void_reason / id / timestamps are server-managed.
const WRITABLE = [
  'si_no', 'sale_date', 'order_id', 'order_no', 'customer_name', 'customer_tin',
  'customer_address', 'items_desc', 'gross', 'discount_type', 'discount_amount',
  'withholding_tax', 'net_total', 'payment_bucket', 'sc_pwd_id', 'source', 'created_by'
];

function clean(record) {
  const out = {};
  if (record && typeof record === 'object') {
    for (const k of WRITABLE) if (record[k] !== undefined) out[k] = record[k];
  }
  return out;
}

export async function routeDocs(action, body, auth, req, res) {
  if (!DOCS_ACTIONS.has(action)) return false;
  const { checkAdminAuth } = auth;

  // ── getDocsLedger: manual SI ledger for a date ───────────────────────────
  if (action === 'getDocsLedger') {
    const a = await checkAdminAuth();
    if (!a.ok) return res.status(403).json({ ok: false, error: a.error });
    const date = String(body.date || '').trim();
    if (!date) return res.status(400).json({ ok: false, error: 'date required' });
    const r = await supaFetch(
      `${SUPABASE_URL}/rest/v1/docs_daily_sales?sale_date=eq.${encodeURIComponent(date)}&order=si_no.asc&select=*`
    );
    if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to load ledger' });
    return res.status(200).json({ ok: true, rows: r.data || [] });
  }

  // ── getDocsLive: today's completed POS transactions (read-only view) ──────
  if (action === 'getDocsLive') {
    const a = await checkAdminAuth();
    if (!a.ok) return res.status(403).json({ ok: false, error: a.error });
    const date = String(body.date || '').trim();
    if (!date) return res.status(400).json({ ok: false, error: 'date required' });
    const r = await supaFetch(
      `${SUPABASE_URL}/rest/v1/v_docs_daily_transactions?sale_date=eq.${encodeURIComponent(date)}&status=eq.COMPLETED&order=created_at.desc&select=*`
    );
    if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to load live sales' });
    return res.status(200).json({ ok: true, rows: r.data || [] });
  }

  // ── getDocsCardPayments: all CARD-terminal payments month-to-date ────────
  // For reconciling the Maya card terminal. Lists every CARD-paid completed
  // order from the 1st of the current month, with its SI reference (if invoiced).
  if (action === 'getDocsCardPayments') {
    const a = await checkAdminAuth();
    if (!a.ok) return res.status(403).json({ ok: false, error: a.error });

    // Month start (1st, 06:00 PH business-day boundary) in UTC
    const nowPH = new Date(Date.now() + 8 * 3600000);
    const monthStartUTC = new Date(Date.UTC(nowPH.getUTCFullYear(), nowPH.getUTCMonth(), 1, 6, 0, 0) - 8 * 3600000).toISOString();

    // CARD-paid completed orders MTD (also include split buckets containing CARD)
    const oR = await supaFetch(
      `${SUPABASE_URL}/rest/v1/dine_in_orders` +
      `?status=eq.COMPLETED&is_test=eq.false&is_deleted=eq.false` +
      `&payment_method=in.(CARD,"CARD+CASH","CARD+GCASH")` +
      `&created_at=gte.${monthStartUTC}` +
      `&order=created_at.desc` +
      `&select=order_id,order_no,customer_name,total,discounted_total,payment_method,paid_at,created_at`
    );
    if (!oR.ok) return res.status(500).json({ ok: false, error: 'Failed to load card payments' });
    const orders = oR.data || [];

    // Match SI numbers from the manual ledger (one query, keyed by order_id)
    let siMap = {};
    if (orders.length) {
      const ids = [...new Set(orders.map(o => o.order_id).filter(Boolean))];
      if (ids.length) {
        const dR = await supaFetch(
          `${SUPABASE_URL}/rest/v1/docs_daily_sales` +
          `?order_id=in.(${ids.map(id => `"${id}"`).join(',')})` +
          `&select=order_id,si_no`
        );
        if (dR.ok && Array.isArray(dR.data)) {
          for (const d of dR.data) if (d.order_id) siMap[d.order_id] = d.si_no;
        }
      }
    }

    const rows = orders.map(o => ({
      order_id:   o.order_id,
      order_no:   o.order_no,
      si_no:      siMap[o.order_id] || null,
      customer:   o.customer_name || '',
      amount:     parseFloat(o.discounted_total != null ? o.discounted_total : o.total) || 0,
      method:     o.payment_method,
      datetime:   o.paid_at || o.created_at,
    }));
    const total = rows.reduce((s, r) => s + r.amount, 0);

    return res.status(200).json({
      ok: true,
      rows,
      count: rows.length,
      total: Math.round(total * 100) / 100,
      period_start: monthStartUTC,
    });
  }

  if (action === 'lookupDocsOrder') {
    const a = await checkAdminAuth();
    if (!a.ok) return res.status(403).json({ ok: false, error: a.error });
    const oid = String(body.order_id || '').trim();
    if (!oid) return res.status(400).json({ ok: false, error: 'order_id required' });
    const r = await supaFetch(
      `${SUPABASE_URL}/rest/v1/v_docs_daily_transactions?order_id=eq.${encodeURIComponent(oid)}&limit=1&select=*`
    );
    if (!r.ok) return res.status(500).json({ ok: false, error: 'Lookup failed' });
    const row = (r.data && r.data.length) ? r.data[0] : null;
    return res.status(200).json({ ok: true, row });
  }

  // ── saveDocsEntry: insert (new) or update (edit) a ledger row ─────────────
  if (action === 'saveDocsEntry') {
    const a = await checkAdminAuth();
    if (!a.ok) return res.status(403).json({ ok: false, error: a.error });
    const rec = clean(body.record);
    if (rec.si_no === undefined || rec.si_no === null || rec.si_no === '')
      return res.status(400).json({ ok: false, error: 'si_no required' });
    if (!rec.sale_date) return res.status(400).json({ ok: false, error: 'sale_date required' });

    const editId = body.id;
    let r;
    if (editId) {
      rec.updated_at = new Date().toISOString();
      r = await supa('PATCH', 'docs_daily_sales', rec, { id: 'eq.' + editId }, 'return=representation');
    } else {
      r = await supa('POST', 'docs_daily_sales', rec);
    }
    if (!r.ok) {
      const code = r.data && r.data.code ? String(r.data.code) : '';
      if (code === '23505' || r.status === 409)
        return res.status(409).json({ ok: false, error: 'DUPLICATE_SI' });
      return res.status(500).json({ ok: false, error: 'Save failed' });
    }
    return res.status(200).json({ ok: true });
  }

  // ── voidDocsEntry: mark a serial VOID (never deleted) ────────────────────
  if (action === 'voidDocsEntry') {
    const a = await checkAdminAuth();
    if (!a.ok) return res.status(403).json({ ok: false, error: a.error });
    const id = body.id;
    if (!id) return res.status(400).json({ ok: false, error: 'id required' });
    const r = await supa('PATCH', 'docs_daily_sales', {
      status: 'VOID',
      void_reason: String(body.reason || 'voided').substring(0, 300),
      updated_at: new Date().toISOString(),
    }, { id: 'eq.' + id }, 'return=minimal');
    if (!r.ok) return res.status(500).json({ ok: false, error: 'Void failed' });
    return res.status(200).json({ ok: true });
  }

  return false;
}
