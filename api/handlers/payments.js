// ── Billing, payments, receipts, refunds, promos ──────────────────────────
import { supaFetch, supa, auditLog, getSetting, logSync, pushToSheets } from '../lib/db.js';
import { invalidateMenuCache } from '../lib/cache.js';
import { isValidOrderId, isNonEmptyString } from '../lib/validation.js';
import { SUPABASE_URL, SERVICE_CHARGE_RATE, BUSINESS_NAME, ORDER_PREFIX, SUPABASE_KEY } from '../lib/config.js';
import { buildReceiptHTML, sendReceiptEmail } from '../lib/receipt.js';
import { uploadToGoogleDrive } from '../lib/drive.js';

export async function routePayments(action, body, auth, req, res) {
  const { checkAuth, checkAdminAuth, jwtUser } = auth;

    if (action === 'saveSplitBill') {
      const auth = await checkAuth(['OWNER','ADMIN','CASHIER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { orderId, splitData } = body;
      if (!orderId || !splitData) return res.status(400).json({ ok: false, error: 'orderId and splitData required' });
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}`,
        { method: 'PATCH', body: JSON.stringify({ split_data: splitData }) }
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to save split data' });
      await auditLog({ orderId, action: 'SPLIT_BILL', actor: { userId: body.userId },
        newValue: `split:${splitData.type}:${splitData.pax}pax`, details: splitData });
      return res.status(200).json({ ok: true });
    }

    // ── flagPaymentIntent (public — customer-facing) ───────────────────────
    // Called when a customer chooses CASH or CARD at the table. Records the
    // intended method and flags the order AWAITING_PAYMENT so it shows on the
    // admin board (server is alerted to collect) and is held from preparation
    // until staff confirms payment. Never overrides an already-confirmed payment.
    if (action === 'flagPaymentIntent') {
      const orderId = String(body.orderId || '').trim();
      const method  = String(body.method  || '').trim().toUpperCase();
      if (!orderId)                  return res.status(400).json({ ok: false, error: 'orderId required' });
      if (!isValidOrderId(orderId))  return res.status(400).json({ ok: false, error: 'Invalid orderId' });
      if (!['CASH', 'CARD'].includes(method))
        return res.status(400).json({ ok: false, error: 'method must be CASH or CARD' });

      // Load order — only flag live, unpaid orders. Never touch a VERIFIED /
      // PLATFORM_PAID / SUBMITTED order or one that's already closed.
      const ordR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}&select=status,payment_status&limit=1`
      );
      const ord = ordR.ok && ordR.data && ordR.data[0];
      if (!ord) return res.status(404).json({ ok: false, error: 'Order not found' });
      const curPay = String(ord.payment_status || '').toUpperCase();
      if (['VERIFIED', 'PLATFORM_PAID', 'SUBMITTED'].includes(curPay)) {
        return res.status(200).json({ ok: true, orderId, method, skipped: true });
      }
      if (['COMPLETED', 'CANCELLED'].includes(String(ord.status || '').toUpperCase())) {
        return res.status(200).json({ ok: true, orderId, method, skipped: true });
      }

      const r = await supa('PATCH', 'dine_in_orders',
        { payment_method: method, payment_status: 'AWAITING_PAYMENT', updated_at: new Date().toISOString() },
        { order_id: `eq.${encodeURIComponent(orderId)}` }
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to flag payment' });
      logSync('dine_in_orders', orderId, 'UPDATE');
      auditLog({ orderId, action: 'PAYMENT_INTENT', newValue: method, details: { source: 'customer', held: true } });
      pushToSheets('updateOrderPayment', { orderId, paymentMethod: method, paymentStatus: 'AWAITING_PAYMENT' });
      return res.status(200).json({ ok: true, orderId, method });
    }

    if (action === 'setPaymentMethod') {
      const authP = await checkAuth(['OWNER','ADMIN','CASHIER']);
      if (!authP.ok) return res.status(403).json({ ok: false, error: authP.error });

      const orderId = String(body.orderId || '').trim();
      const method  = String(body.method  || '').trim().toUpperCase();
      const notes   = String(body.notes   || '').trim().slice(0, 300);
      const VALID   = new Set(['CASH','CARD','GCASH','INSTAPAY','BDO','BPI','UNIONBANK','MAYA','OTHER','YANI_CARD']);

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
      const qualPax   = parseInt(body.qualifiedPax, 10) || 1;
      const promoPct  = parseFloat(body.promoPct) || 0;
      const customAmt = parseFloat(body.customAmt) || 0;
      const note      = String(body.note || '').trim().slice(0, 200);

      if (!orderId) return res.status(400).json({ ok: false, error: 'orderId required' });
      if (!isValidOrderId(orderId)) return res.status(400).json({ ok: false, error: 'Invalid orderId' });
      if (!['PWD','SENIOR','BOTH','PROMO','CUSTOM','REMOVE','YANI_CARD'].includes(type))
        return res.status(400).json({ ok: false, error: 'Invalid discountType' });

      // Fetch current order — need both original total AND any existing discount
      const orderR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}&select=total,discount_type,discount_amount,discounted_total,discount_note`
      );
      if (!orderR.ok || !orderR.data?.length)
        return res.status(404).json({ ok: false, error: 'Order not found' });

      const originalTotal   = parseFloat(orderR.data[0].total) || 0;
      const existingDiscType  = orderR.data[0].discount_type || null;
      const existingDiscAmt   = parseFloat(orderR.data[0].discount_amount) || 0;
      const existingDiscTotal = parseFloat(orderR.data[0].discounted_total) || originalTotal;
      const existingNote      = orderR.data[0].discount_note || '';

      // ── Stacking logic ────────────────────────────────────────────────────
      // If a Yani Card discount is already applied and staff is adding PWD/Senior/Promo/Custom,
      // compute the new discount on the POST-card total (not the original total).
      // Final = originalTotal - cardDisc - pwdDisc
      const isYaniCardDiscount = existingDiscType === 'YANI_CARD' ||
        (existingDiscType === 'CUSTOM' && existingNote.toLowerCase().includes('yani card'));
      const isStackingOnCard = isYaniCardDiscount &&
        ['PWD','SENIOR','BOTH','PROMO','CUSTOM'].includes(type);

      // Base for the incoming discount calculation
      const baseForCalc = isStackingOnCard ? existingDiscTotal : originalTotal;

      if (type === 'REMOVE') {
        const r = await supa('PATCH', 'dine_in_orders',
          { discount_type: null, discount_pax: 0, discount_pct: 0, discount_amount: 0,
            discounted_total: null, discount_note: null, updated_at: new Date().toISOString() },
          { order_id: `eq.${encodeURIComponent(orderId)}` }
        );
        if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to remove discount' });
        auditLog({ orderId, action: 'DISCOUNT_REMOVED', actor: { userId: body.userId, role: authD.role } });
        return res.status(200).json({ ok: true, orderId, discountRemoved: true });
      }

      let newDiscountAmount = 0;
      let discountPct = 0;

      if (type === 'PWD' || type === 'SENIOR') {
        const perPerson  = baseForCalc / Math.max(totalPax, 1);
        newDiscountAmount = Math.round(perPerson * qualPax * 0.20 * 100) / 100;
        discountPct = 20;
      } else if (type === 'BOTH') {
        const perPerson  = baseForCalc / Math.max(totalPax, 1);
        newDiscountAmount = Math.round(perPerson * qualPax * 0.20 * 100) / 100;
        discountPct = 20;
      } else if (type === 'PROMO') {
        discountPct      = Math.min(promoPct, 100);
        newDiscountAmount = Math.round(baseForCalc * (discountPct / 100) * 100) / 100;
      } else if (type === 'CUSTOM') {
        newDiscountAmount = Math.min(customAmt, baseForCalc);
        discountPct      = Math.round((newDiscountAmount / baseForCalc) * 100 * 100) / 100;
      } else if (type === 'YANI_CARD') {
        discountPct      = 10;
        newDiscountAmount = Math.round(originalTotal * 0.10 * 100) / 100;
      }

      // ── Combined totals when stacking ─────────────────────────────────────
      let finalDiscountAmount, discountedTotal, combinedNote, storedType;

      if (isStackingOnCard) {
        // Stack: total - cardDisc - newDisc
        finalDiscountAmount = Math.round((existingDiscAmt + newDiscountAmount) * 100) / 100;
        discountedTotal     = Math.max(0, Math.round((originalTotal - finalDiscountAmount) * 100) / 100);
        // Label: "YANI_CARD+PWD", "YANI_CARD+SENIOR", etc.
        storedType          = `YANI_CARD+${type}`;
        // Build combined note
        const cardNote   = existingNote ? existingNote : 'Yani Card 10%';
        const addNote    = note || `${type} ${qualPax}/${totalPax} pax`;
        combinedNote     = `${cardNote} | ${addNote}`;
      } else {
        finalDiscountAmount = newDiscountAmount;
        discountedTotal     = Math.max(0, Math.round((originalTotal - finalDiscountAmount) * 100) / 100);
        storedType          = type;
        combinedNote        = (type === 'YANI_CARD' && body.yaniCardNumber
          ? 'Yani Card: ' + String(body.yaniCardNumber).trim().toUpperCase()
          : note) || null;
      }

      const r = await supa('PATCH', 'dine_in_orders',
        { discount_type: storedType, discount_pax: qualPax, discount_pct: discountPct,
          discount_amount: finalDiscountAmount, discounted_total: discountedTotal,
          discount_note: combinedNote, updated_at: new Date().toISOString() },
        { order_id: `eq.${encodeURIComponent(orderId)}` }
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to apply discount' });

      // ── Wire stacked discount to Yani Card balance ────────────────────────
      // If the card was already charged at order placement, credit the additional
      // discount back to the card balance (ADJUST transaction).
      if (isStackingOnCard && newDiscountAmount > 0) {
        try {
          // Extract card number from note e.g. "Yani Card: YANI-1005"
          const cardMatch = String(existingNote || '').match(/YANI-\d+/i);
          if (cardMatch) {
            const cardNum = cardMatch[0].toUpperCase();
            // Check if card was already charged for this order
            const chkR = await supaFetch(
              `${SUPABASE_URL}/rest/v1/card_transactions?order_id=eq.${encodeURIComponent(orderId)}&type=eq.CHARGE&select=id&limit=1`
            );
            if (chkR.ok && chkR.data?.length > 0) {
              // Card was already charged → credit the additional discount back
              await supaFetch(`${SUPABASE_URL}/rest/v1/rpc/adjust_card_balance`, {
                method: 'POST',
                body: JSON.stringify({
                  p_card_number:  cardNum,
                  p_amount:       newDiscountAmount,
                  p_order_id:     orderId,
                  p_performed_by: body.userId || 'STAFF',
                  p_description:  `Stacked ${type} discount refund +₱${newDiscountAmount} (${combinedNote})`,
                })
              });
            }
            // If not yet charged, discounted_total is already updated → charge_card_exact
            // will be called at COMPLETED with the correct final amount
          }
        } catch(cardErr) {
          console.error('Card adjust error (non-fatal):', cardErr.message);
        }
      }

      auditLog({ orderId, action: 'DISCOUNT_APPLIED', actor: { userId: body.userId, role: authD.role },
        newValue: storedType, details: { finalDiscountAmount, discountedTotal, stacked: isStackingOnCard, note: combinedNote } });
      pushToSheets('updateOrderDiscount', { orderId, discountType: storedType, discountAmount: finalDiscountAmount, discountedTotal });

      return res.status(200).json({
        ok: true, orderId, type: storedType,
        discountAmount: finalDiscountAmount,
        discountedTotal, total: originalTotal,
        stacked: isStackingOnCard,
        breakdown: isStackingOnCard ? {
          originalTotal,
          cardDiscount:  existingDiscAmt,
          afterCard:     existingDiscTotal,
          pwdDiscount:   newDiscountAmount,
          finalTotal:    discountedTotal,
        } : null
      });
    }

    // ── getShiftSummary ────────────────────────────────────────────────────
    // Returns today's sales breakdown by payment method for end-of-day reconciliation
    if (action === 'getShiftSummary') {
      const authSh = await checkAuth(['OWNER','ADMIN','CASHIER']);
      if (!authSh.ok) return res.status(403).json({ ok: false, error: authSh.error });

      // Get timezone from settings (default Asia/Manila)
      const tz = await getSetting('TIMEZONE') || 'Asia/Manila';

      // Business day = 6 AM PHT to 6 AM PHT
      // If current PHT time is before 6 AM, business day started yesterday at 6 AM
      const nowUTC = new Date();
      const phtOff = 8 * 3600000;
      const nowPHT = new Date(nowUTC.getTime() + phtOff);
      const phtHour = nowPHT.getUTCHours();
      // Start of current business day (6 AM PHT)
      const bdayStart = new Date(nowPHT);
      bdayStart.setUTCHours(6, 0, 0, 0);
      if (phtHour < 6) bdayStart.setTime(bdayStart.getTime() - 86400000); // before 6 AM → prev day
      const bdayEnd = new Date(bdayStart.getTime() + 86400000); // +24h
      const todayStart = new Date(bdayStart.getTime() - phtOff).toISOString();
      const todayEnd   = new Date(bdayEnd.getTime()   - phtOff).toISOString();

      const ordersR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/dine_in_orders?created_at=gte.${encodeURIComponent(todayStart)}&created_at=lte.${encodeURIComponent(todayEnd)}&is_test=eq.false&select=status,total,discounted_total,payment_method,payment_status,discount_type,discount_amount,order_type,created_at&order=created_at.asc`
      );
      if (!ordersR.ok) return res.status(500).json({ ok: false, error: 'Failed to fetch shift data' });

      const orders = ordersR.data || [];
      const completed = orders.filter(o => o.status === 'COMPLETED');
      const cancelled = orders.filter(o => o.status === 'CANCELLED');

      // Payment method breakdown
      const pmBreakdown = {};
      let totalRevenue = 0;
      let discountTotal = 0;
      completed.forEach(o => {
        const revenue = parseFloat(o.discounted_total ?? o.total) || 0;
        totalRevenue += revenue;
        discountTotal += parseFloat(o.discount_amount) || 0;
        const pm = o.payment_method || 'UNRECORDED';
        if (!pmBreakdown[pm]) pmBreakdown[pm] = { count: 0, total: 0 };
        pmBreakdown[pm].count++;
        pmBreakdown[pm].total = Math.round((pmBreakdown[pm].total + revenue) * 100) / 100;
      });

      // Order type split
      const dineIn  = completed.filter(o => o.order_type === 'DINE-IN').length;
      const takeOut = completed.filter(o => o.order_type === 'TAKE-OUT').length;

      return res.status(200).json({
        ok: true,
        date: bdayStart.toISOString().slice(0,10),
        totalOrders: completed.length,
        cancelledOrders: cancelled.length,
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        totalDiscounts: Math.round(discountTotal * 100) / 100,
        unrecordedPayments: (pmBreakdown['UNRECORDED']?.count || 0),
        paymentBreakdown: pmBreakdown,
        orderTypeSplit: { dineIn, takeOut },
        orders: completed.map(o => ({
          orderId: o.order_id,
          total: o.discounted_total ?? o.total,
          paymentMethod: o.payment_method || null,
          discountType: o.discount_type || null,
          time: o.created_at,
        }))
      });
    }

    // ── addItemsToOrder (multi-table: append items to existing order) ──────
    if (action === 'addItemsToOrder') {
      const authA = await checkAuth(['OWNER','ADMIN','CASHIER','SERVER']);
      if (!authA.ok) return res.status(403).json({ ok: false, error: authA.error });

      const orderId = String(body.orderId || '').trim();
      const newItems = Array.isArray(body.items) ? body.items : [];
      if (!orderId) return res.status(400).json({ ok: false, error: 'orderId required' });
      if (!newItems.length) return res.status(400).json({ ok: false, error: 'items required' });

      // Fetch existing order
      const orderR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}&select=order_no,table_no,order_type,subtotal,service_charge,total,status`
      );
      if (!orderR.ok || !orderR.data.length) return res.status(404).json({ ok: false, error: 'Order not found' });
      const ord = orderR.data[0];
      if (['COMPLETED','CANCELLED'].includes(ord.status)) {
        return res.status(400).json({ ok: false, error: `Cannot add to a ${ord.status} order` });
      }

      // Build new item rows
      let addSubtotal = 0;
      const itemRows = newItems.map(it => {
        const qty = Math.max(1, parseInt(it.qty) || 1);
        const price = parseFloat(it.price) || 0;
        addSubtotal += price * qty;
        return {
          order_id:     orderId,
          order_no:     ord.order_no,
          table_no:     ord.table_no,
          item_code:    it.code || 'CUSTOM',
          item_name:    it.name || 'Item',
          unit_price:   price,
          qty,
          size_choice:  it.size || '',
          sugar_choice: it.sugarLevel || it.sugar || '',
          item_notes:   it.notes || '',
        };
      });

      // Insert new items
      const insertR = await supa('POST', 'dine_in_order_items', itemRows);
      if (!insertR.ok) return res.status(500).json({ ok: false, error: 'Failed to insert items' });

      // Recalculate totals from ALL items in DB (not from stored subtotal — prevents compounding errors)
      const allItemsR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/dine_in_order_items?order_id=eq.${encodeURIComponent(orderId)}&select=unit_price,qty`
      );
      const trueSubtotal = allItemsR.ok
        ? Math.round((allItemsR.data || []).reduce((s, i) => s + parseFloat(i.unit_price||0) * parseInt(i.qty||1), 0) * 100) / 100
        : Math.round((parseFloat(ord.subtotal || 0) + addSubtotal) * 100) / 100;

      const svcRate  = ord.order_type === 'TAKE-OUT' ? 0 : SERVICE_CHARGE_RATE;
      const newSvc   = Math.round(trueSubtotal * svcRate * 100) / 100;
      const newTotal = Math.round((trueSubtotal + newSvc) * 100) / 100;

      await supaFetch(`${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ subtotal: trueSubtotal, service_charge: newSvc, total: newTotal })
      });

      await auditLog({ orderId, action: 'ITEMS_ADDED', actor: { userId: authA.userId }, details: { added: newItems.length, addSubtotal, trueSubtotal, newTotal, items: newItems.map(function(i){ return (i.qty||1)+'x '+i.name; }) } });

      return res.status(200).json({ ok: true, orderId, added: newItems.length, newTotal });
    }

    // ── editOrderItems ─────────────────────────────────────────────────────
    if (action === 'editOrderItems') {
      const authE = await checkAuth(['OWNER','ADMIN','CASHIER']);
      if (!authE.ok) return res.status(403).json({ ok: false, error: authE.error });

      const orderId = String(body.orderId || '').trim();
      const items   = Array.isArray(body.items) ? body.items : [];
      if (!orderId) return res.status(400).json({ ok: false, error: 'orderId is required' });
      if (!isValidOrderId(orderId)) return res.status(400).json({ ok: false, error: 'Invalid orderId format' });

      // Get order to check it exists and get order_no/table_no
      const orderR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}&select=order_no,table_no,order_type,discounted_total,discount_amount,status`
      );
      if (!orderR.ok || !orderR.data.length) return res.status(404).json({ ok: false, error: 'Order not found' });
      const { order_no, table_no, order_type, discounted_total, discount_amount, status: orderStatus } = orderR.data[0];

      // Block editing completed or cancelled orders
      if (['COMPLETED','CANCELLED'].includes(orderStatus)) {
        return res.status(400).json({ ok: false, error: `Cannot edit a ${orderStatus} order` });
      }

      // Discount is handled below — editOrderItems recalculates discount proportionally

      // Fetch existing items to preserve their 'prepared' state AND original created_at
      const existItemsR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/dine_in_order_items?order_id=eq.${encodeURIComponent(orderId)}&select=item_code,size_choice,sugar_choice,item_notes,prepared,created_at`
      );
      const existItems = existItemsR.ok ? (existItemsR.data || []) : [];

      // Recalculate totals
      let subtotal = 0;
      const itemRows = items.map(it => {
        const qty = Math.max(1, parseInt(it.qty) || 1);
        const price = parseFloat(it.price) || 0;
        subtotal += price * qty;
        // Carry over prepared state AND original created_at if this item already existed
        const existMatch = existItems.find(e =>
          e.item_code === (it.code || 'CUSTOM') &&
          (e.size_choice || '') === (it.size || '') &&
          (e.sugar_choice || '') === (it.sugar || '')
        );
        return {
          order_id:     orderId,
          order_no:     order_no,
          table_no:     table_no,
          item_code:    it.code || 'CUSTOM',
          item_name:    it.name || 'Item',
          unit_price:   price,
          qty,
          size_choice:  it.size || '',
          sugar_choice: it.sugar || '',
          item_notes:   it.notes || '',
          prepared:     existMatch ? (existMatch.prepared || false) : false,
          // _origCreatedAt is ONLY used post-insert for UPDATE — not sent to Supabase
          _origCreatedAt: existMatch ? (existMatch.created_at || null) : null,
        };
      });

      const svcCharge  = order_type === 'TAKE-OUT' ? 0 : Math.round(subtotal * SERVICE_CHARGE_RATE * 100) / 100;
      const preTax2    = subtotal + svcCharge;
      const vatEnabled2 = (await getSetting('VAT_ENABLED')) === 'true';
      const vatRate2    = parseFloat(await getSetting('VAT_RATE') || '0.12');
      const vatAmt2     = vatEnabled2 ? Math.round(preTax2 * (vatRate2 / (1 + vatRate2)) * 100) / 100 : 0;
      const total       = Math.round(preTax2 * 100) / 100;

      // Delete old items and insert new ones (prepared state preserved above)
      // Strip internal _origCreatedAt field before sending to Supabase
      const insertRows = itemRows.map(function(r) {
        const row = Object.assign({}, r);
        delete row._origCreatedAt;
        return row;
      });
      await supa('DELETE', 'dine_in_order_items', null, { order_id: `eq.${orderId}` });
      if (insertRows.length > 0) {
        const insertR = await supa('POST', 'dine_in_order_items', insertRows);
        if (!insertR.ok) {
          console.error('editOrderItems: insert failed', insertR.status, JSON.stringify(insertR.data));
          return res.status(500).json({ ok: false, error: 'Failed to save order items' });
        }
      }

      // After insert, restore original created_at for items that existed before
      // This ensures the "added at X:XX AM" badge only shows on genuinely new items
      const itemsWithOrigTime = itemRows.filter(r => r._origCreatedAt);
      if (itemsWithOrigTime.length > 0) {
        // Fetch the newly inserted items to get their IDs
        const newItemsR = await supaFetch(
          `${SUPABASE_URL}/rest/v1/dine_in_order_items?order_id=eq.${encodeURIComponent(orderId)}&select=id,item_code,size_choice,sugar_choice&order=id.asc`
        );
        if (newItemsR.ok && newItemsR.data) {
          for (const orig of itemsWithOrigTime) {
            const match = newItemsR.data.find(ni =>
              ni.item_code === orig.item_code &&
              (ni.size_choice || '') === (orig.size_choice || '') &&
              (ni.sugar_choice || '') === (orig.sugar_choice || '')
            );
            if (match) {
              await supaFetch(
                `${SUPABASE_URL}/rest/v1/dine_in_order_items?id=eq.${match.id}`,
                { method: 'PATCH', body: JSON.stringify({ created_at: orig._origCreatedAt }) }
              );
            }
          }
        }
      }

      // Update order totals
      // If order had a discount, recalculate it proportionally on the new total
      // Use supaFetch with raw URL — supa() encodeURIComponent breaks select with commas
      const existOrder = await supaFetch(
        `${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}&select=discount_type,discount_amount,discounted_total,total`
      );
      let newDiscountAmt = 0, newDiscountedTotal = null, discountType = null;
      const ex = existOrder.ok && existOrder.data && existOrder.data[0];
      if (ex) {
        const exDiscAmt  = parseFloat(ex.discount_amount || 0);
        const exDisc     = parseFloat(ex.discounted_total || 0);
        const exTotal    = parseFloat(ex.total || 0);
        discountType     = ex.discount_type || null;
        if (discountType && exDiscAmt > 0 && exTotal > 0) {
          const pct = exDiscAmt / exTotal;           // e.g. 15.29/152.90 = 0.10
          newDiscountAmt     = Math.round(total * pct * 100) / 100;
          newDiscountedTotal = Math.round((total - newDiscountAmt) * 100) / 100;
        }
      }
      const patch = { subtotal, service_charge: svcCharge, vat_amount: vatAmt2, total };
      if (newDiscountedTotal !== null && discountType) {
        patch.discount_amount    = newDiscountAmt;
        patch.discounted_total   = newDiscountedTotal;
      } else {
        patch.discount_amount    = 0;
        patch.discounted_total   = null;
        patch.discount_type      = null;
      }
      await supa('PATCH', 'dine_in_orders', patch, { order_id: `eq.${orderId}` });

      logSync('dine_in_orders', orderId, 'UPDATE');
      auditLog({ orderId, action: 'ORDER_EDITED', actor: { userId: body.userId, role: authE.role }, details: { newTotal: total, itemCount: itemRows.length, discountRecalculated: !!newDiscountedTotal, items: itemRows.map(function(i){ return i.qty+'x '+i.item_name; }) } });
      return res.status(200).json({ ok: true, orderId, subtotal, serviceCharge: svcCharge, total, discountedTotal: newDiscountedTotal, discountAmount: newDiscountAmt });
    }

    // ── placePlatformOrder ─────────────────────────────────────────────────
    if (action === 'placePlatformOrder') {
      const authPPO = await checkAdminAuth();
      if (!authPPO.ok) return res.status(403).json({ ok: false, error: authPPO.error });
      const platform    = String(body.platform    || '').trim().toUpperCase();
      const platformRef = String(body.platformRef || '').trim().substring(0, 100);
      const notes       = String(body.notes       || '').trim().substring(0, 500);
      const items       = Array.isArray(body.items) ? body.items : [];

      if (!platform) return res.status(400).json({ ok: false, error: 'platform is required' });
      if (items.length === 0) return res.status(400).json({ ok: false, error: 'Order must have at least one item' });

      // Look up prices from menu
      const itemCodes = [...new Set(items.map(i => i.code))];
      const menuR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/menu_items?item_code=in.(${itemCodes.map(c => `"${c}"`).join(',')})&is_active=eq.true&select=item_code,name,base_price,has_sizes,price_short,price_medium,price_tall`
      );
      const menuMap = {};
      if (menuR.ok && Array.isArray(menuR.data)) {
        menuR.data.forEach(m => { menuMap[m.item_code] = m; });
      }

      const orderItems = [];
      let subtotal = 0;
      for (const item of items) {
        const menuItem = menuMap[item.code];
        if (!menuItem) continue;
        let unitPrice = menuItem.base_price;
        if (menuItem.has_sizes && item.size) {
          const sizeKey = { SHORT: 'price_short', MEDIUM: 'price_medium', TALL: 'price_tall' }[String(item.size).toUpperCase()];
          if (sizeKey && menuItem[sizeKey] != null) unitPrice = menuItem[sizeKey];
        }
        const qty = Math.max(1, parseInt(item.qty) || 1);
        subtotal += unitPrice * qty;
        orderItems.push({
          item_code:    item.code,
          item_name:    menuItem.name,
          unit_price:   unitPrice,
          qty,
          size_choice:  item.size || '',
          sugar_choice: item.sugarLevel || '',
          item_notes:   '',
        });
      }

      if (orderItems.length === 0) return res.status(400).json({ ok: false, error: 'No valid items in order' });

      const total = Math.round(subtotal * 100) / 100; // No service charge for platform orders

      // Generate order ID
      const seqR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/rpc/get_next_order_number`,
        { method: 'POST', body: '{}' }
      );
      const orderNo = seqR.ok ? (seqR.data || 1001) : Date.now() % 9000 + 1000;
      // Read ORDER_PREFIX from DB settings (same as dine-in orders)
      let olPrefix = ORDER_PREFIX;
      try {
        const olPfxR = await supaFetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.ORDER_PREFIX&select=value`);
        if (olPfxR.ok && olPfxR.data?.[0]?.value) olPrefix = olPfxR.data[0].value;
      } catch(_) {}
      const orderId = `${olPrefix}-${orderNo}`;

      const orderRow = {
        order_id:       orderId,
        order_no:       orderNo,
        table_no:       '',
        customer_name:  platform,
        status:         'NEW',
        order_type:     'PLATFORM',
        subtotal:       subtotal,
        service_charge: 0,
        total:          total,
        notes:          notes,
        source:         'PLATFORM',
        platform:       platform,
        platform_ref:   platformRef,
      };
      const orderR = await supa('POST', 'dine_in_orders', orderRow);
      if (!orderR.ok) return res.status(500).json({ ok: false, error: 'Failed to place platform order' });

      const itemRows = orderItems.map(it => ({
        order_id:     orderId,
        order_no:     orderNo,
        table_no:     '',
        item_code:    it.item_code,
        item_name:    it.item_name,
        unit_price:   it.unit_price,
        qty:          it.qty,
        size_choice:  it.size_choice,
        sugar_choice: it.sugar_choice,
        item_notes:   it.item_notes,
      }));
      await supa('POST', 'dine_in_order_items', itemRows);
      logSync('dine_in_orders', orderId, 'INSERT');
      auditLog({ orderId, action: 'PLATFORM_ORDER_PLACED', actor: { userId: body.userId }, details: { platform: body.platform, total } });

      return res.status(200).json({ ok: true, orderId, total, subtotal });
    }

    // ── requestReceipt ─────────────────────────────────────────────────────
    if (action === 'requestReceipt') {
      const orderId        = String(body.orderId        || '').trim();
      const receiptType    = String(body.receiptType    || 'simple').trim(); // 'simple' | 'bir'
      const deliveryMethod = String(body.deliveryMethod || body.delivery || '').trim(); // 'email' | 'printed'
      const email          = String(body.email          || '').trim().toLowerCase();
      const name           = String(body.name           || '').trim().slice(0, 200);
      const address        = String(body.address        || '').trim().slice(0, 500);
      const tin            = String(body.tin            || '').trim().slice(0, 50);

      if (!orderId) return res.status(400).json({ ok: false, error: 'orderId is required' });

      // 1. Assign OR number for BIR receipts
      let orNumber = null;
      if (receiptType === 'bir') {
        // Atomically increment OR_NUMBER_CURRENT
        const curR = await supaFetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.OR_NUMBER_CURRENT&select=value`);
        if (curR.ok && curR.data.length) {
          orNumber = parseInt(curR.data[0].value || '1001', 10);
          await supa('PATCH', 'settings', { value: String(orNumber + 1) }, { key: 'eq.OR_NUMBER_CURRENT' });
        }
      }

      // 2. Save receipt details to order record
      const updates = {
        receipt_type:     receiptType,
        receipt_delivery: deliveryMethod,
        receipt_email:    email,
        receipt_name:     name,
        receipt_address:  address,
        receipt_tin:      tin,
        ...(orNumber ? { or_number: orNumber } : {}),
      };
      await supa('PATCH', 'dine_in_orders', updates, { order_id: `eq.${orderId}` });

      // 2. If email delivery → fetch order + items → send email
      if (deliveryMethod === 'email') {
        if (!email || !email.includes('@'))
          return res.status(400).json({ ok: false, error: 'Valid email address required for email delivery' });

        // Fetch order details
        const orderR = await supaFetch(
          `${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}&limit=1`
        );
        if (!orderR.ok || !orderR.data.length)
          return res.status(404).json({ ok: false, error: 'Order not found' });
        const order = orderR.data[0];
        // Merge in the receipt fields we just saved (PATCH may not have flushed yet)
        Object.assign(order, { receipt_name: name, receipt_address: address, receipt_tin: tin });

        // Fetch order items
        const itemsR = await supaFetch(
          `${SUPABASE_URL}/rest/v1/dine_in_order_items?order_id=eq.${encodeURIComponent(orderId)}&order=id.asc`
        );
        const items = itemsR.ok ? (itemsR.data || []) : [];

        try {
          const emailId = await sendReceiptEmail({
            toEmail: email,
            order,
            items,
            isBIR: receiptType === 'bir',
          });
          auditLog({ orderId, action: 'RECEIPT_SENT', newValue: `email:${email}`, details: { type: receiptType, emailId } });
          return res.status(200).json({ ok: true, sent: true, emailId, message: `Receipt sent to ${email}` });
        } catch (emailErr) {
          return res.status(500).json({ ok: false, error: `Email failed: ${emailErr.message}` });
        }
      }

      // 3. Printed delivery → just saved the info, staff will handle at counter
      return res.status(200).json({ ok: true, sent: false, message: 'Receipt details saved. Print at counter.', orNumber: orNumber || null });
    }

    // ── resendReceipt ──────────────────────────────────────────────────────
    // Staff-triggered: resend receipt email for any completed order
    if (action === 'resendReceipt') {
      const authR = await checkAuth(['OWNER','ADMIN','CASHIER']);
      if (!authR.ok) return res.status(403).json({ ok: false, error: authR.error });

      const orderId   = String(body.orderId   || '').trim();
      const toEmail   = String(body.email     || '').trim().toLowerCase();
      const rcpType   = String(body.receiptType || 'simple').trim();

      if (!orderId) return res.status(400).json({ ok: false, error: 'orderId required' });
      if (!toEmail || !toEmail.includes('@')) return res.status(400).json({ ok: false, error: 'Valid email required' });

      const orderR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}&limit=1`
      );
      if (!orderR.ok || !orderR.data.length)
        return res.status(404).json({ ok: false, error: 'Order not found' });
      const order = orderR.data[0];

      const itemsR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/dine_in_order_items?order_id=eq.${encodeURIComponent(orderId)}&order=id.asc`
      );
      const items = itemsR.ok ? (itemsR.data || []) : [];

      try {
        const emailId = await sendReceiptEmail({ toEmail, order, items, isBIR: rcpType === 'bir' });
        auditLog({ orderId, action: 'RECEIPT_SENT', actor: { userId: body.userId },
          newValue: `resend:${toEmail}`, details: { type: rcpType, emailId } });
        return res.status(200).json({ ok: true, emailId, message: `Receipt resent to ${toEmail}` });
      } catch (e) {
        return res.status(500).json({ ok: false, error: `Email failed: ${e.message}` });
      }
    }

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
      return res.status(200).json({ ok: true, paymentId, proofUrl, filename: storedFilename });
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
      let orderId = null;
      if (payR.ok && payR.data.length > 0) {
        orderId = payR.data[0].order_id;
        await supa('PATCH', 'dine_in_orders', { payment_status: 'VERIFIED' }, { order_id: `eq.${orderId}` });
        // Auto-complete the order if not already done/cancelled
        const ordR = await supaFetch(
          `${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}&select=status`
        );
        if (ordR.ok && ordR.data.length > 0) {
          const currentStatus = ordR.data[0].status;
          // Only auto-complete if order is already READY (all items prepped)
          // If still NEW or PREPARING, payment is verified but kitchen still working
          if (currentStatus === 'READY') {
            await supa('PATCH', 'dine_in_orders', { status: 'COMPLETED' }, { order_id: `eq.${orderId}` });
          }
        }
      }

      logSync('payments', paymentId, 'UPDATE');
      return res.status(200).json({ ok: true, paymentId, orderId });
    }

    // ── rejectPayment ──────────────────────────────────────────────────────
    if (action === 'rejectPayment') {
      const authRP = await checkAdminAuth();
      if (!authRP.ok) return res.status(403).json({ ok: false, error: authRP.error });
      const paymentId  = String(body.paymentId  || '').trim();
      const reason     = String(body.reason     || '').trim().substring(0, 500);
      const verifiedBy = String(body.verifiedBy || authRP.role || 'Staff').trim().substring(0, 100);
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

    // ── changePin ──────────────────────────────────────────────────────────

  return false;
}
