// ── api/handlers/payments.js ────────────────────────────────────────────────────────────────
// Handles: uploadPayment, listPayments, getPaymentProof, migrateProofs, verifyPayment, rejectPayment
// ctx: { action, body, req, res, jwtUser, checkAuth, supa, supaFetch, auditLog,
//          SUPABASE_URL, SUPABASE_KEY, SERVICE_CHARGE_RATE, ORDER_PREFIX, getSetting }

export async function handle_payments(action, ctx) {
  const { body, req, res, jwtUser, checkAuth, supa, supaFetch, auditLog,
          SUPABASE_URL, SUPABASE_KEY, SERVICE_CHARGE_RATE, ORDER_PREFIX, getSetting } = ctx;

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
      res.status(200).json({ ok: true, paymentId, proofUrl, filename: storedFilename }); return true;
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

      res.status(200).json({ ok: true, payments }); return true;
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
      res.status(200).json({ ok: true, imageUrl: r.data[0].proof_url, filename: r.data[0].proof_filename }); return true;
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
      res.status(200).json({ ok: true, migrated, failed, total: r.data?.length || 0 }); return true;
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
      res.status(200).json({ ok: true, paymentId }); return true;
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
      res.status(200).json({ ok: true, paymentId }); return true;
    }



  return false; // not handled by this module
}

  const _handled = ['uploadPayment', 'listPayments', 'getPaymentProof', 'migrateProofs', 'verifyPayment', 'rejectPayment'];
  if (!_handled.includes(action)) return false;

