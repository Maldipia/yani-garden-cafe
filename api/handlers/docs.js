// ── DOCS HANDLER (ESM) ─────────────────────────────────────────────────────
// BIR daily-sales ledger (docs_daily_sales) + live POS transactions view.
// Moved server-side so the admin browser no longer reads/writes these tables
// with the anon key. All actions require ADMIN/OWNER. Service key bypasses RLS.
import { supaFetch, supa } from '../lib/db.js';
import { SUPABASE_URL }    from '../lib/config.js';

const DOCS_ACTIONS = new Set([
  'getDocsLedger', 'getDocsLive', 'lookupDocsOrder', 'saveDocsEntry', 'voidDocsEntry'
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

  // ── lookupDocsOrder: prefill from a single order ─────────────────────────
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
