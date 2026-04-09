// ── api/handlers/tables.js ────────────────────────────────────────────────────────────────
// Handles: syncToSheets, getPendingSync, markSynced, getTableStatus, setTableStatus, linkReservationTable, seatReservation
// ctx: { action, body, req, res, jwtUser, checkAuth, supa, supaFetch, auditLog,
//          SUPABASE_URL, SUPABASE_KEY, SERVICE_CHARGE_RATE, ORDER_PREFIX, getSetting }

export async function handle_tables(action, ctx) {
  const { body, req, res, jwtUser, checkAuth, supa, supaFetch, auditLog,
          SUPABASE_URL, SUPABASE_KEY, SERVICE_CHARGE_RATE, ORDER_PREFIX, getSetting } = ctx;

    // ══════════════════════════════════════════════════════════════════════
    // TABLE OCCUPANCY STATUS
    // ══════════════════════════════════════════════════════════════════════

    // ── syncToSheets ──────────────────────────────────────────────────────
    // Manual trigger: re-queue all unsynced items + ping GAS URL to run immediately
    if (action === 'syncToSheets') {
      const authSync = await checkAdminAuth();
      if (!authSync.ok) return res.status(403).json({ ok: false, error: authSync.error });

      // Count unsynced items
      const countR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/sheets_sync_log?synced=eq.false&select=id`,
        { headers: { Prefer: 'count=exact' } }
      );
      const pending = Array.isArray(countR.data) ? countR.data.length : 0;

      // Ping GAS URL to trigger syncNow() immediately (fire-and-forget, no-cors OK)
      let gasPinged = false;
      if (GAS_SYNC_URL) {
        try {
          fetch(`${GAS_SYNC_URL}?action=sync`, { method: 'GET' }).catch(() => {});
          gasPinged = true;
        } catch (_) {}
      }

      auditLog({ orderId: 'MANUAL_SYNC', action: 'SHEETS_SYNC_TRIGGERED', actor: { userId: body.userId }, details: { pending, gasPinged } });
      res.status(200).json({ ok: true, pending, gasPinged, message: `${pending} item(s) queued. GAS will sync within 1 minute.` }); return true;
    }

    // ── getPendingSync ─────────────────────────────────────────────────────
    // Called by GAS SheetsSync.gs — returns pending orders/payments to write to Sheets
    // No auth required (GAS runs as sheet owner, data is non-sensitive aggregate)
    if (action === 'getPendingSync') {
      const secret = String(body.secret || '').trim();
      if (secret !== 'yani-sync-2026') return res.status(403).json({ ok: false, error: 'Invalid secret' });

      // Get pending sync items (limit 100 per batch)
      const batchLimit = Math.min(parseInt(body.limit) || 50, 100);
      const pendingR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/sheets_sync_log?synced=eq.false&order=created_at.asc&limit=${batchLimit}&select=id,table_name,record_id,action`
      );
      if (!pendingR.ok) return res.status(500).json({ ok: false, error: 'Failed to read sync log' });
      const pending = pendingR.data || [];
      if (pending.length === 0) return res.status(200).json({ ok: true, items: [], total: 0 });

      // Fetch full data for each item
      const orderIds  = [...new Set(pending.filter(p=>p.table_name==='dine_in_orders').map(p=>p.record_id))];
      const payIds    = [...new Set(pending.filter(p=>p.table_name==='payments').map(p=>p.record_id))];
      const syncLogIds = pending.map(p=>p.id);

      // Fetch orders
      let ordersMap = {};
      if (orderIds.length > 0) {
        const oR = await supaFetch(
          `${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=in.(${orderIds.map(id=>`"${id}"`).join(',')})` +
          `&select=order_id,order_no,table_no,customer_name,status,order_type,subtotal,service_charge,` +
          `vat_amount,total,discounted_total,discount_type,discount_amount,payment_method,payment_status,` +
          `receipt_type,receipt_email,notes,cancel_reason,created_at,is_test`
        );
        if (oR.ok) (oR.data||[]).forEach(o => { ordersMap[o.order_id] = o; });
      }

      // Fetch order items (for INSERTs only)
      let itemsMap = {};
      const insertOrderIds = pending.filter(p=>p.table_name==='dine_in_orders'&&p.action==='INSERT').map(p=>p.record_id);
      if (insertOrderIds.length > 0) {
        const iR = await supaFetch(
          `${SUPABASE_URL}/rest/v1/dine_in_order_items?order_id=in.(${insertOrderIds.map(id=>`"${id}"`).join(',')})` +
          `&order=id.asc&select=order_id,item_code,item_name,unit_price,qty,line_total,size_choice,sugar_choice,item_notes,addons`
        );
        if (iR.ok) {
          (iR.data||[]).forEach(it => {
            if (!itemsMap[it.order_id]) itemsMap[it.order_id] = [];
            itemsMap[it.order_id].push(it);
          });
        }
      }

      // Fetch payments
      let paymentsMap = {};
      if (payIds.length > 0) {
        const pR = await supaFetch(
          `${SUPABASE_URL}/rest/v1/payments?payment_id=in.(${payIds.map(id=>`"${id}"`).join(',')})` +
          `&select=payment_id,order_id,amount,payment_method,status,proof_url,proof_filename,verified_by,verified_at,rejection_reason,created_at`
        );
        if (pR.ok) (pR.data||[]).forEach(p => { paymentsMap[p.payment_id] = p; });
      }

      // Build response items, collect skipped IDs to auto-mark synced
      const skippedSyncIds = [];
      const items = pending.map(p => {
        if (p.table_name === 'dine_in_orders') {
          const order = ordersMap[p.record_id];
          if (!order || order.is_test || order.is_deleted) {
            skippedSyncIds.push(p.id); // skip: test, deleted, or not found
            return null;
          }
          return {
            syncId: p.id, tableType: 'ORDER', action: p.action,
            order,
            orderItems: itemsMap[p.record_id] || []
          };
        } else if (p.table_name === 'payments') {
          const payment = paymentsMap[p.record_id];
          if (!payment) return null;
          // Convert base64 proof to Storage URL reference
          if (payment.proof_url && payment.proof_url.startsWith('data:')) {
            payment.proof_url = payment.proof_filename
              ? `${SUPABASE_URL}/storage/v1/object/public/payment-proofs/${payment.proof_filename}`
              : '[View in admin panel]';
          }
          return { syncId: p.id, tableType: 'PAYMENT', action: p.action, payment };
        }
        return { syncId: p.id, tableType: 'OTHER', action: p.action };
      }).filter(Boolean);

      // Auto-mark test/missing orders as synced so they don't pile up
      if (skippedSyncIds.length > 0) {
        supa('PATCH', 'sheets_sync_log',
          { synced: true, synced_at: new Date().toISOString() },
          { id: `in.(${skippedSyncIds.join(',')})` }
        ).catch(() => {});
      }

      res.status(200).json({ ok: true, items, total: pending.length, syncLogIds, skipped: skippedSyncIds.length }); return true;
    }

    // ── markSynced ─────────────────────────────────────────────────────────
    // Called by GAS after successfully writing items to Sheets
    if (action === 'markSynced') {
      const secret = String(body.secret || '').trim();
      if (secret !== 'yani-sync-2026') return res.status(403).json({ ok: false, error: 'Invalid secret' });
      const ids = body.ids;
      if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ ok: false, error: 'ids array required' });
      const validIds = ids.filter(id => Number.isInteger(id) && id > 0);
      if (validIds.length === 0) return res.status(400).json({ ok: false, error: 'No valid ids' });

      const r = await supa('PATCH', 'sheets_sync_log',
        { synced: true, synced_at: new Date().toISOString() },
        { id: `in.(${validIds.join(',')})` }
      );
      res.status(200).json({ ok: r.ok, marked: validIds.length }); return true;
    }

    // ── getTableStatus ─────────────────────────────────────────────────────
    if (action === 'getTableStatus') {
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/cafe_tables?select=id,table_number,table_name,capacity,qr_token,status&order=table_number.asc`
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to fetch tables' });
      res.status(200).json({ ok: true, tables: r.data || [] }); return true;
    }

    // ── setTableStatus ─────────────────────────────────────────────────────
    if (action === 'setTableStatus') {
      const auth = await checkAuth(['OWNER','ADMIN','CASHIER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { tableNumber, status } = body;
      const valid = ['AVAILABLE','OCCUPIED','RESERVED','MAINTENANCE'];
      if (!valid.includes(status)) return res.status(400).json({ ok: false, error: 'Invalid status' });
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/cafe_tables?table_number=eq.${encodeURIComponent(tableNumber)}`,
        { method: 'PATCH', body: JSON.stringify({ status }) }
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to update table status' });
      res.status(200).json({ ok: true, tableNumber, status }); return true;
    }


    // ══════════════════════════════════════════════════════════════════════
    // RESERVATIONS ↔ TABLE AUTO-LINK
    // ══════════════════════════════════════════════════════════════════════

    // ── linkReservationTable ───────────────────────────────────────────────
    if (action === 'linkReservationTable') {
      const auth = await checkAuth(['OWNER','ADMIN','CASHIER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { resId, tableNumber } = body;
      if (!resId) return res.status(400).json({ ok: false, error: 'resId required' });

      // Get table UUID from number
      let tableId = null;
      if (tableNumber) {
        const tRes = await supaFetch(
          `${SUPABASE_URL}/rest/v1/cafe_tables?table_number=eq.${encodeURIComponent(tableNumber)}&select=id`
        );
        if (tRes.ok && tRes.data && tRes.data[0]) tableId = tRes.data[0].id;
      }

      // Update reservation
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/reservations?res_id=eq.${encodeURIComponent(resId)}`,
        { method: 'PATCH', body: JSON.stringify({
          table_id: tableId,
          confirmed_by: body.userId,
          status: tableNumber ? 'CONFIRMED' : 'CONFIRMED'
        })}
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to link reservation' });

      // Auto-set table to RESERVED if tableNumber provided
      if (tableNumber) {
        await supaFetch(
          `${SUPABASE_URL}/rest/v1/cafe_tables?table_number=eq.${encodeURIComponent(tableNumber)}`,
          { method: 'PATCH', body: JSON.stringify({ status: 'RESERVED' }) }
        );
      }
      res.status(200).json({ ok: true, resId, tableNumber, tableId }); return true;
    }

    // ── seatReservation ────────────────────────────────────────────────────
    if (action === 'seatReservation') {
      const auth = await checkAuth(['OWNER','ADMIN','CASHIER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { resId } = body;

      // Get reservation to find linked table
      const resRes = await supaFetch(
        `${SUPABASE_URL}/rest/v1/reservations?res_id=eq.${encodeURIComponent(resId)}&select=table_id,status`
      );
      if (!resRes.ok || !resRes.data || !resRes.data[0]) {
        res.status(404).json({ ok: false, error: 'Reservation not found' }); return true;
      }
      const res_rec = resRes.data[0];

      // Mark reservation SEATED
      await supaFetch(
        `${SUPABASE_URL}/rest/v1/reservations?res_id=eq.${encodeURIComponent(resId)}`,
        { method: 'PATCH', body: JSON.stringify({ status: 'SEATED' }) }
      );

      // Set table OCCUPIED
      if (res_rec.table_id) {
        await supaFetch(
          `${SUPABASE_URL}/rest/v1/cafe_tables?id=eq.${res_rec.table_id}`,
          { method: 'PATCH', body: JSON.stringify({ status: 'OCCUPIED' }) }
        );
      }
      res.status(200).json({ ok: true, resId, status: 'SEATED' }); return true;
    }



  return false; // not handled by this module
}

  const _handled = ['syncToSheets', 'getPendingSync', 'markSynced', 'getTableStatus', 'setTableStatus', 'linkReservationTable', 'seatReservation'];
  if (!_handled.includes(action)) return false;

