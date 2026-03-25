// ── PAYMENTS HANDLERS ── auto-extracted from pos.js
'use strict';

module.exports = async function handle_payments(action, body, req, res, ctx) {
  const {
    supa, supaFetch, checkAuth, checkAdminAuth, auditLog, pushToSheets, logSync,
    invalidateMenuCache, getSetting, menuCache, SUPABASE_URL, SUPABASE_KEY,
    ORDER_PREFIX, SERVICE_CHARGE_RATE, isNonEmptyString, isValidPrice,
    isValidItemCode, isValidOrderId, isNonEmptyArray, isValidPhone
  } = ctx;

    // ── setPaymentMethod ──────────────────────────────────────────────────
    // Admin/Cashier/Owner sets how an order was paid.
    // method can be single (CASH) or split (GCASH+CASH, CARD+GCASH, etc.)
    if (action === 'setPaymentMethod') {
      const authP = await checkAuth(['OWNER','ADMIN','CASHIER']);
      if (!authP.ok) return res.status(403).json({ ok: false, error: authP.error });

      const orderId = String(body.orderId || '').trim();
      const method  = String(body.method  || '').trim().toUpperCase();
      const notes   = String(body.notes   || '').trim().slice(0, 300);
      const VALID   = new Set(['CASH','CARD','GCASH','INSTAPAY','BDO','BPI','UNIONBANK','MAYA','OTHER']);

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
      if (!['PWD','SENIOR','BOTH','PROMO','CUSTOM','REMOVE'].includes(type))
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
      }

      const discountedTotal = Math.max(0, Math.round((total - discountAmount) * 100) / 100);

      const r = await supa('PATCH', 'dine_in_orders',
        { discount_type: type, discount_pax: qualPax, discount_pct: discountPct,
          discount_amount: discountAmount, discounted_total: discountedTotal,
          discount_note: note || null, updated_at: new Date().toISOString() },
        { order_id: `eq.${encodeURIComponent(orderId)}` }
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to apply discount' });
      auditLog({ orderId, action: 'DISCOUNT_APPLIED', actor: { userId: body.userId, role: authD.role }, newValue: type, details: { discountAmount, discountedTotal, note: body.note || null } });
      pushToSheets('updateOrderDiscount', { orderId, discountType: type, discountAmount, discountedTotal });
      return res.status(200).json({ ok: true, orderId, type, discountAmount, discountedTotal, total });
    }

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
      return res.status(200).json({ ok: true, paymentId });
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


  return res.status(400).json({ ok: false, error: `Unknown payments action: ${action}` });
};
