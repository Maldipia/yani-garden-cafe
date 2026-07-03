// ── CUSTOMERS HANDLER (ESM) ───────────────────────────────────────────────
// Members → Customers tab. Reads/writes the `customers` table.
// All actions are OWNER/ADMIN only (customer PII).
import { supa, supaFetch } from '../lib/db.js';
import { SUPABASE_URL }     from '../lib/config.js';

const CUSTOMER_ACTIONS = new Set([
  'getCustomers', 'getCustomer', 'upsertCustomer', 'logAudit',
]);

export async function routeCustomers(action, body, auth, req, res) {
  if (!CUSTOMER_ACTIONS.has(action)) return false;
  const { checkAdminAuth } = auth;

  // ── logAudit — lightweight audit trail (login/logout/session events) ─────
  // Fire-and-forget from clients; never throws back a hard failure.
  if (action === 'logAudit') {
    const auditAction = String(body.auditAction || body.event || body.target || 'EVENT').substring(0, 60);
    const userId = body.userId ? String(body.userId).substring(0, 60) : null;
    try {
      await supa('POST', 'order_audit_logs', {
        order_id: 'SESSION',
        action: auditAction,
        actor_id: userId,
        actor_name: body.username ? String(body.username).substring(0, 80) : null,
        details: (body.details && typeof body.details === 'object') ? body.details
               : { note: String(body.details || '').substring(0, 300) },
      }, null, 'return=minimal');
    } catch (_) { /* audit is best-effort */ }
    return res.status(200).json({ ok: true });
  }

  // ── getCustomers — list (optional search by name/phone/email) ────────────
  if (action === 'getCustomers') {
    const a = await checkAdminAuth();
    if (!a.ok) return res.status(403).json({ ok: false, error: a.error });

    const limit  = Math.min(500, parseInt(body.limit) || 200);
    const search = String(body.search || '').trim();

    let url = `${SUPABASE_URL}/rest/v1/customers`
      + `?select=id,name,phone,email,notes,total_orders,total_spent,last_visit,created_at`
      + `&order=last_visit.desc.nullslast&limit=${limit}`;

    if (search) {
      // ilike across name/phone/email
      const s = encodeURIComponent(`*${search}*`);
      url += `&or=(name.ilike.${s},phone.ilike.${s},email.ilike.${s})`;
    }

    const r = await supaFetch(url);
    if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to load customers' });
    return res.status(200).json({ ok: true, customers: Array.isArray(r.data) ? r.data : [] });
  }

  // ── getCustomer — single customer + recent order history ─────────────────
  if (action === 'getCustomer') {
    const a = await checkAdminAuth();
    if (!a.ok) return res.status(403).json({ ok: false, error: a.error });

    const id = String(body.id || '').trim();
    if (!id) return res.status(400).json({ ok: false, error: 'Customer id required' });

    const cr = await supaFetch(
      `${SUPABASE_URL}/rest/v1/customers?id=eq.${encodeURIComponent(id)}`
      + `&select=id,name,phone,email,notes,total_orders,total_spent,last_visit,first_visit,created_at&limit=1`
    );
    if (!cr.ok || !Array.isArray(cr.data) || !cr.data.length) {
      return res.status(404).json({ ok: false, error: 'Customer not found' });
    }
    const customer = cr.data[0];

    // Recent orders for this customer (linked by customer_id)
    let orders = [];
    const or2 = await supaFetch(
      `${SUPABASE_URL}/rest/v1/dine_in_orders?customer_id=eq.${encodeURIComponent(id)}`
      + `&is_deleted=eq.false&select=order_id,total,status,created_at&order=created_at.desc&limit=10`
    );
    if (or2.ok && Array.isArray(or2.data)) orders = or2.data;

    return res.status(200).json({ ok: true, customer, orders });
  }

  // ── upsertCustomer — create (no id) or update (with id) ──────────────────
  if (action === 'upsertCustomer') {
    const a = await checkAdminAuth();
    if (!a.ok) return res.status(403).json({ ok: false, error: a.error });

    const id    = body.id ? String(body.id).trim() : null;
    const name  = String(body.name || '').trim().substring(0, 120);
    const phone = body.phone ? String(body.phone).trim().substring(0, 30) : null;
    const email = body.email ? String(body.email).trim().toLowerCase().substring(0, 254) : null;
    const notes = body.notes ? String(body.notes).trim().substring(0, 1000) : null;

    if (!name) return res.status(400).json({ ok: false, error: 'Customer name required' });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: 'Invalid email' });
    }

    if (id) {
      const r = await supa('PATCH', 'customers',
        { name, phone, email, notes, updated_at: new Date().toISOString() },
        { id: `eq.${id}` }, 'return=representation');
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to update customer' });
      const row = Array.isArray(r.data) ? r.data[0] : r.data;
      return res.status(200).json({ ok: true, action: 'updated', customer: row });
    } else {
      const r = await supa('POST', 'customers',
        { name, phone, email, notes }, null, 'return=representation');
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to create customer' });
      const row = Array.isArray(r.data) ? r.data[0] : r.data;
      return res.status(200).json({ ok: true, action: 'created', customer: row });
    }
  }

  return false;
}
