// ── api/handlers/refunds.js ────────────────────────────────────────────────────────────────
// Handles: processRefund, getRefunds
// ctx: { action, body, req, res, jwtUser, checkAuth, supa, supaFetch, auditLog,
//          SUPABASE_URL, SUPABASE_KEY, SERVICE_CHARGE_RATE, ORDER_PREFIX, getSetting }

export async function handle_refunds(action, ctx) {
  const { body, req, res, jwtUser, checkAuth, supa, supaFetch, auditLog,
          SUPABASE_URL, SUPABASE_KEY, SERVICE_CHARGE_RATE, ORDER_PREFIX, getSetting } = ctx;

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

      res.status(200).json({ ok: true, refundId, refundType, refundAmount }); return true;
    }

    // ── getRefunds ─────────────────────────────────────────────────────────
    if (action === 'getRefunds') {
      const auth = await checkAuth(['OWNER','ADMIN']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const limit = Math.min(parseInt(body.limit) || 50, 200);
      const filter = body.orderId ? `&order_id=eq.${encodeURIComponent(body.orderId)}` : '';
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/refunds?select=*&order=created_at.desc&limit=${limit}${filter}`
      );
      res.status(200).json({ ok: r.ok, refunds: r.data || [] }); return true;
    }



  return false; // not handled by this module
}

  const _handled = ['processRefund', 'getRefunds'];
  if (!_handled.includes(action)) return false;

