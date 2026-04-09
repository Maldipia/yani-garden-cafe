// api/handlers/refunds.js — processRefund, getRefunds

export async function handle_refunds(action, ctx) {
  const {
    action, body, jwtUser, checkAuth,
    supa, supaFetch, auditLog, getSetting, sendReceiptEmail,
    isNonEmptyString, isValidItemCode, isValidOrderId,
    validateMenuPayload, getCategoryId, getCategoryName,
    logSync, pushToSheets, invalidateMenuCache, signToken, uploadToGoogleDrive,
    SUPABASE_URL, SUPABASE_KEY, SERVICE_CHARGE_RATE, ORDER_PREFIX,
    menuCache, MENU_CACHE_TTL,
  } = ctx;
  const _owns = ['processRefund', 'getRefunds'];
  if (!_owns.includes(action)) return null;

    // VOID / REFUND WORKFLOW
    // ══════════════════════════════════════════════════════════════════════

    // ── processRefund ──────────────────────────────────────────────────────
    if (action === 'processRefund') {
      const auth = await checkAuth(['OWNER','ADMIN']);
      if (!auth.ok) return [403, { ok: false, error: auth.error }];
      const { orderId, refundType, refundAmount, reasonCode, reasonNote, refundMethod, itemsRefunded } = body;
      const validTypes = ['FULL','PARTIAL','VOID'];
      const validReasons = ['WRONG_ORDER','DUPLICATE','COMPLAINT','OVERCHARGE','ITEM_UNAVAILABLE','OTHER'];
      if (!orderId) return [400, { ok: false, error: 'orderId required' }];
      if (!validTypes.includes(refundType)) return [400, { ok: false, error: 'Invalid refundType' }];
      if (!validReasons.includes(reasonCode)) return [400, { ok: false, error: 'Invalid reasonCode' }];
      if (parseFloat(refundAmount) < 0) return [400, { ok: false, error: 'refundAmount cannot be negative' }];

      // Verify order exists
      const orderRes = await supaFetch(
        `${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}&select=order_id,total,status`
      );
      if (!orderRes.ok || !orderRes.data?.length) return [404, { ok: false, error: 'Order not found' }];

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
      if (!r.ok) return [500, { ok: false, error: 'Failed to save refund' }];

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

      return [200, { ok: true, refundId, refundType, refundAmount }];
    }

    // ── getRefunds ─────────────────────────────────────────────────────────
    if (action === 'getRefunds') {
      const auth = await checkAuth(['OWNER','ADMIN']);
      if (!auth.ok) return [403, { ok: false, error: auth.error }];
      const limit = Math.min(parseInt(body.limit) || 50, 200);
      const filter = body.orderId ? `&order_id=eq.${encodeURIComponent(body.orderId)}` : '';
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/refunds?select=*&order=created_at.desc&limit=${limit}${filter}`
      );
      return [200, { ok: r.ok, refunds: r.data || [] }];
    }

    // ══════════════════════════════════════════════════════════════════════
  return null;
}
