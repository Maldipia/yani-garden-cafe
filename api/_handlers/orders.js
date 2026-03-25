// ── ORDERS HANDLERS ── auto-extracted from pos.js
'use strict';

module.exports = async function handle_orders(action, body, req, res, ctx) {
  const {
    supa, supaFetch, checkAuth, checkAdminAuth, auditLog, pushToSheets, logSync,
    invalidateMenuCache, getSetting, menuCache, SUPABASE_URL, SUPABASE_KEY,
    ORDER_PREFIX, SERVICE_CHARGE_RATE, isNonEmptyString, isValidPrice,
    isValidItemCode, isValidOrderId, isNonEmptyArray, isValidPhone
  } = ctx;

    // ── placeOrder ─────────────────────────────────────────────────────────
    if (action === 'placeOrder') {
      const isStaffOrder = body.staffOrder === true;
      const rawTableNo   = body.tableNo;
      const tableNo      = rawTableNo != null ? String(rawTableNo).trim() : '0';
      // Accept both 'token' (customer front-end) and 'tableToken' (legacy) field names
      const tableToken   = String(body.token || body.tableToken || '').trim();
      const customerName = String(body.customerName || body.customer || 'Guest').trim().substring(0, 100);
      const notes        = String(body.notes || '').trim().substring(0, 500);
      const rawOrderType = String(body.orderType || '').toUpperCase().replace('_', '-');
      const orderType    = ['DINE-IN', 'TAKE-OUT'].includes(rawOrderType) ? rawOrderType : 'DINE-IN';
      const items        = Array.isArray(body.items) ? body.items : [];

      // Validate items
      if (items.length === 0) return res.status(400).json({ ok: false, error: 'Order must have at least one item' });
      if (items.some(i => (parseFloat(i.price) || 0) < 0)) {
        return res.status(400).json({ ok: false, error: 'Item prices cannot be negative' });
      }

      // Validate table token against DB — mandatory for customer (non-staff) dine-in orders
      if (!isStaffOrder && tableNo !== '0') {
        if (!tableToken) {
          return res.status(403).json({ ok: false, error: 'Table token required' });
        }
        const tokenR = await supaFetch(
          `${SUPABASE_URL}/rest/v1/cafe_tables?table_number=eq.${encodeURIComponent(tableNo)}&qr_token=eq.${encodeURIComponent(tableToken)}&select=table_number`
        );
        if (!tokenR.ok || !tokenR.data || tokenR.data.length === 0) {
          return res.status(403).json({ ok: false, error: 'Invalid table token' });
        }
      }

      // Look up prices from menu
      const itemCodes = [...new Set(items.map(i => i.code))];
      const menuR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/menu_items?item_code=in.(${itemCodes.map(c => `"${c}"`).join(',')})&is_active=eq.true&select=item_code,name,base_price,has_sizes,price_short,price_medium,price_tall`
      );
      const menuMap = {};
      if (menuR.ok && Array.isArray(menuR.data)) {
        menuR.data.forEach(m => { menuMap[m.item_code] = m; });
      }

      // Build order items with prices
      const orderItems = [];
      let subtotal = 0;
      for (const item of items) {
        const menuItem = menuMap[item.code];
        if (!menuItem) continue; // skip unknown items
        let unitPrice = menuItem.base_price;
        if (menuItem.has_sizes && item.size) {
          const sizeKey = { SHORT: 'price_short', MEDIUM: 'price_medium', TALL: 'price_tall' }[String(item.size).toUpperCase()];
          if (sizeKey && menuItem[sizeKey] != null) unitPrice = menuItem[sizeKey];
        }
        const qty = Math.max(1, parseInt(item.qty) || 1);
        subtotal += unitPrice * qty;
        // Collect addons for this item
        const itemAddons = Array.isArray(item.addons) ? item.addons : [];
        const addonPrice = itemAddons.reduce((sum, a) => sum + (parseFloat(a.price) || 0), 0);
        unitPrice += addonPrice; // addons already baked into the unit price from frontend
        orderItems.push({
          item_code:    item.code,
          item_name:    menuItem.name,
          unit_price:   unitPrice,
          qty,
          size_choice:  item.size || '',
          sugar_choice: item.sugarLevel || item.sugar || '',
          item_notes:   item.notes || '',
          addons:       itemAddons,
        });
      }

      if (orderItems.length === 0) return res.status(400).json({ ok: false, error: 'No valid items in order' });

      const svcCharge = orderType === 'DINE-IN' ? Math.round(subtotal * SERVICE_CHARGE_RATE * 100) / 100 : 0;
      const preTax    = subtotal + svcCharge;

      // VAT — read live from settings table
      const vatEnabled = (await getSetting('VAT_ENABLED')) === 'true';
      const vatRate    = parseFloat(await getSetting('VAT_RATE') || '0.12');
      // VAT-inclusive: vat = preTax × rate / (1 + rate)  ← back-calculate from VAT-inclusive price
      const vatAmt     = vatEnabled ? Math.round(preTax * (vatRate / (1 + vatRate)) * 100) / 100 : 0;
      const total      = Math.round(preTax * 100) / 100; // total stays the same; VAT is shown as breakdown

      if (total <= 0) return res.status(400).json({ ok: false, error: 'Order total must be greater than zero' });

      // Generate order ID using sequence — with self-healing retry on duplicate key
      const TEST_TABLES = ['T99', '0', 'T0'];
      // Only specific programmatic test names — NOT 'guest' (real customers don't enter names)
      const TEST_NAMES  = ['e2e test', 'price test', 'logtest', 'healthcheck'];
      const isTest = TEST_TABLES.includes(tableNo.toUpperCase()) ||
                     TEST_NAMES.includes(customerName.toLowerCase());

      let orderR, orderId, orderNo;
      for (let attempt = 0; attempt < 3; attempt++) {
        const seqR = await supaFetch(
          `${SUPABASE_URL}/rest/v1/rpc/get_next_order_number`,
          { method: 'POST', body: '{}' }
        );
        orderNo = seqR.ok ? (seqR.data || 1001) : Date.now() % 9000 + 1000;
        orderId = `${ORDER_PREFIX}-${orderNo}`;

        const orderRow = {
          order_id:       orderId,
          order_no:       orderNo,
          table_no:       tableNo,
          customer_name:  customerName,
          status:         'NEW',
          order_type:     orderType,
          subtotal:       subtotal,
          service_charge: svcCharge,
          vat_amount:     vatAmt,
          total:          total,
          notes:          notes,
          source:         'QR',
          is_test:        isTest,
        };
        orderR = await supa('POST', 'dine_in_orders', orderRow);
        if (orderR.ok) break; // success

        const errCode = orderR.data && orderR.data.code;
        if (errCode === '23505') {
          // Duplicate key — sequence is behind actual data; auto-advance and retry
          console.warn(`placeOrder: duplicate order_id ${orderId}, advancing sequence (attempt ${attempt+1})`);
          await supaFetch(
            `${SUPABASE_URL}/rest/v1/rpc/advance_order_sequence`,
            { method: 'POST', body: '{}' }
          ).catch(() => {}); // best-effort
          continue;
        }
        break; // non-duplicate error, stop retrying
      }
      if (!orderR || !orderR.ok) {
        console.error('placeOrder insert failed:', orderR && orderR.status, JSON.stringify(orderR && orderR.data));
        return res.status(500).json({ ok: false, error: 'Failed to place order' });
      }

      // Insert order items
      const itemRows = orderItems.map(it => ({
        order_id:     orderId,
        order_no:     orderNo,
        table_no:     tableNo,
        item_code:    it.item_code,
        item_name:    it.item_name,
        unit_price:   it.unit_price,
        qty:          it.qty,
        size_choice:  it.size_choice,
        sugar_choice: it.sugar_choice,
        item_notes:   it.item_notes,
        addons:       it.addons && it.addons.length > 0 ? JSON.stringify(it.addons) : null,
      }));
      await supa('POST', 'dine_in_order_items', itemRows);

      // Log for Sheets sync
      logSync('dine_in_orders', orderId, 'INSERT');
      auditLog({ orderId, action: 'ORDER_PLACED', details: { tableNo, customerName, orderType, total, itemCount: orderItems.length } });

      // Deduct inventory (fire-and-forget, non-blocking)
      Promise.all(orderItems.map(async item => {
        try {
          const inv = await supaFetch(
            `${SUPABASE_URL}/rest/v1/inventory?item_code=eq.${encodeURIComponent(item.item_code)}&select=stock_qty,auto_disable`
          );
          if (!inv.ok || !inv.data?.length) return;
          const cur = inv.data[0];
          const newQty = Math.max(0, parseFloat(cur.stock_qty) - parseFloat(item.qty || 1));
          await supaFetch(
            `${SUPABASE_URL}/rest/v1/inventory?item_code=eq.${encodeURIComponent(item.item_code)}`,
            { method: 'PATCH', body: JSON.stringify({ stock_qty: newQty, updated_at: new Date().toISOString() }) }
          );
          if (newQty === 0 && cur.auto_disable) {
            await supaFetch(
              `${SUPABASE_URL}/rest/v1/menu_items?item_code=eq.${encodeURIComponent(item.item_code)}`,
              { method: 'PATCH', body: JSON.stringify({ is_active: false }) }
            );
          }
          await supaFetch(`${SUPABASE_URL}/rest/v1/inventory_log`, { method: 'POST',
            body: JSON.stringify({ item_code: item.item_code, change_type: 'SALE',
              qty_before: parseFloat(cur.stock_qty), qty_change: -parseFloat(item.qty || 1),
              qty_after: newQty, order_id: orderId }) });
        } catch (_) {}
      })).catch(() => {});

      // Auto-set table OCCUPIED
      if (tableNo && tableNo !== '0' && orderType === 'DINE-IN') {
        supaFetch(
          `${SUPABASE_URL}/rest/v1/cafe_tables?table_number=eq.${encodeURIComponent(tableNo)}`,
          { method: 'PATCH', body: JSON.stringify({ status: 'OCCUPIED' }) }
        ).catch(() => {});
      }

      // Push to Google Sheets (fire-and-forget)
      pushToSheets('syncOrder', { order: {
        orderId, tableNo, customerName, status: 'NEW',
        orderType, subtotal, serviceCharge: svcCharge, vatAmount: vatAmt, total,
        createdAt: new Date().toISOString(),
        notes,
      }});
      pushToSheets('syncOrderItems', { orderId, items: orderItems.map(it => ({
        code: it.item_code, name: it.item_name, size: it.size_choice,
        price: it.unit_price, qty: it.qty,
        lineTotal: Math.round(it.unit_price * it.qty * 100) / 100,
        sugar: it.sugar_choice, notes: it.item_notes,
      }))});

      return res.status(200).json({
        ok: true,
        orderId,
        ORDER_ID: orderId,
        orderNo,
        subtotal,
        serviceCharge: svcCharge,
        vatAmount: vatAmt,
        vatEnabled,
        total,
      });
    }

    // ── getOrders ──────────────────────────────────────────────────────────
    if (action === 'getOrders') {
      const orderId     = body.orderId ? String(body.orderId).trim() : null;
      const status      = body.status  ? String(body.status).toUpperCase() : null;
      const limit       = Math.min(parseInt(body.limit) || 200, 500);
      const excludeTest = body.excludeTest === true || body.excludeTest === 'true';

      let url = `${SUPABASE_URL}/rest/v1/dine_in_orders?order=created_at.desc&limit=${limit}&is_deleted=eq.false&select=*`;
      if (orderId) url += `&order_id=eq.${encodeURIComponent(orderId)}`;
      else if (status === 'ACTIVE') url += `&status=in.(NEW,PREPARING,READY)`;
      else if (status && status !== 'ALL') url += `&status=eq.${encodeURIComponent(status)}`;
      if (excludeTest) url += `&is_test=eq.false`;

      const ordersR = await supaFetch(url);
      if (!ordersR.ok) return res.status(502).json({ ok: false, orders: [], error: 'Failed to load orders' });

      // Fetch items for all orders
      const orderIds = ordersR.data.map(o => o.order_id);
      let itemsMap = {};
      if (orderIds.length > 0) {
        const itemsR = await supaFetch(
          `${SUPABASE_URL}/rest/v1/dine_in_order_items?order_id=in.(${orderIds.map(id => `"${id}"`).join(',')})&order=id.asc`
        );
        if (itemsR.ok && Array.isArray(itemsR.data)) {
          itemsR.data.forEach(it => {
            if (!itemsMap[it.order_id]) itemsMap[it.order_id] = [];
            // Parse addons from JSON if stored
            let parsedAddons = [];
            try { parsedAddons = it.addons ? JSON.parse(it.addons) : []; } catch(_) {}
            itemsMap[it.order_id].push({
              id:       it.id,
              code:     it.item_code,
              name:     it.item_name,
              price:    it.unit_price,
              qty:      it.qty,
              size:     it.size_choice || '',
              sugar:    it.sugar_choice || '',
              notes:    it.item_notes || '',
              prepared: it.prepared || false,
              addons:   parsedAddons,
            });
          });
        }
      }

      const orders = ordersR.data.map(o => ({
        orderId:       o.order_id,
        orderNo:       o.order_no,
        tableNo:       o.table_no,
        customer:      o.customer_name,   // alias used by printReceipt
        customerName:  o.customer_name,
        status:        o.status,
        orderType:     o.order_type,
        subtotal:      o.subtotal,
        serviceCharge: o.service_charge,
        vatAmount:     o.vat_amount || 0,
        total:         o.total,
        discountedTotal: o.discounted_total || null,
        notes:         o.notes || '',
        receiptType:     o.receipt_type     || '',
        receiptDelivery: o.receipt_delivery || '',
        receiptEmail:    o.receipt_email    || '',
        receiptName:     o.receipt_name     || '',
        receiptAddress:  o.receipt_address  || '',
        receiptTIN:      o.receipt_tin      || '',
        source:        o.source || 'QR',
        platform:      o.platform || '',
        platformRef:   o.platform_ref || '',
        paymentMethod: o.payment_method || '',
        paymentStatus: o.payment_status || '',
        discountType:    o.discount_type    || null,
        discountAmount:  o.discount_amount  || 0,
        discountedTotal: o.discounted_total || null,
        discountNote:    o.discount_note    || null,
        paymentNotes:    o.payment_notes    || null,
        createdAt:     o.created_at ? (o.created_at.endsWith('Z') || o.created_at.includes('+') ? o.created_at : o.created_at + '+00:00') : null,
        updatedAt:     o.updated_at,
        isTest:        o.is_test || false,
        items:         itemsMap[o.order_id] || [],
      }));

      return res.status(200).json({ ok: true, orders });
    }

    // ── updateOrderStatus ──────────────────────────────────────────────────
    if (action === 'updateOrderStatus') {
      const orderId      = String(body.orderId || '').trim();
      const newStatus    = String(body.status  || '').trim().toUpperCase();
      const cancelReason = body.cancelReason ? String(body.cancelReason).trim() : null;
      const validStatuses = ['NEW', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED'];
      if (!orderId)                           return res.status(400).json({ ok: false, error: 'orderId is required' });
      if (!isValidOrderId(orderId))           return res.status(400).json({ ok: false, error: 'Invalid orderId format' });
      if (!validStatuses.includes(newStatus)) return res.status(400).json({ ok: false, error: 'Invalid status: ' + newStatus });

      // Role guard — staff only (all roles permitted for kitchen workflow)
      const userId = String(body.userId || '').trim();
      if (!userId) return res.status(403).json({ ok: false, error: 'userId is required to update order status' });
      const staffR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/staff_users?user_id=eq.${encodeURIComponent(userId)}&active=eq.true&select=role`
      );
      if (!staffR.ok || !staffR.data.length) return res.status(403).json({ ok: false, error: 'Unauthorized: invalid user' });
      const staffRole = staffR.data[0].role;
      const allowedRoles = ['KITCHEN', 'CASHIER', 'ADMIN', 'OWNER'];
      if (!allowedRoles.includes(staffRole)) return res.status(403).json({ ok: false, error: 'Unauthorized: insufficient role' });

      // Capture previous status for audit log
      const prevR = await supaFetch(`${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}&select=status&limit=1`);
      const prevStatus = (prevR.ok && prevR.data && prevR.data[0]) ? prevR.data[0].status : null;

      const patch = { status: newStatus };
      if (newStatus === 'CANCELLED' && cancelReason) patch.cancel_reason = cancelReason;

      const r = await supa('PATCH', 'dine_in_orders', patch, { order_id: `eq.${orderId}` });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to update status' });

      logSync('dine_in_orders', orderId, 'UPDATE');
      auditLog({ orderId, action: 'STATUS_CHANGED', actor: { userId, role: staffRole }, oldValue: prevStatus, newValue: newStatus });
      // Push status update to Sheets
      pushToSheets('updateOrderStatus', { orderId, status: newStatus });

      // Auto-release table when order COMPLETED or CANCELLED
      if (newStatus === 'COMPLETED' || newStatus === 'CANCELLED') {
        const orderRes = await supaFetch(
          `${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}&select=table_no,order_type`
        );
        const tableNo = orderRes.data?.[0]?.table_no;
        if (tableNo && tableNo !== '0' && tableNo !== '') {
          // Only free if no other active orders on same table
          const activeR = await supaFetch(
            `${SUPABASE_URL}/rest/v1/dine_in_orders?table_no=eq.${encodeURIComponent(tableNo)}&status=in.(NEW,PREPARING,READY)&is_deleted=eq.false&select=order_id`
          );
          if (!activeR.data?.length) {
            supaFetch(
              `${SUPABASE_URL}/rest/v1/cafe_tables?table_number=eq.${encodeURIComponent(tableNo)}`,
              { method: 'PATCH', body: JSON.stringify({ status: 'AVAILABLE' }) }
            ).catch(() => {});
          }
        }
      }

      return res.status(200).json({ ok: true, orderId, status: newStatus });
    }

    // ── deleteOrder ────────────────────────────────────────────────────────
    if (action === 'deleteOrder') {
      const authDO = await checkAdminAuth();
      if (!authDO.ok) return res.status(403).json({ ok: false, error: authDO.error });
      const orderId = String(body.orderId || '').trim();
      if (!orderId) return res.status(400).json({ ok: false, error: 'orderId is required' });
      if (!isValidOrderId(orderId)) return res.status(400).json({ ok: false, error: 'Invalid orderId format' });

      // Soft delete — preserve order history for analytics/audit
      const r = await supa('PATCH', 'dine_in_orders',
        { is_deleted: true, deleted_at: new Date().toISOString() },
        { order_id: `eq.${orderId}` }
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to delete order' });

      logSync('dine_in_orders', orderId, 'DELETE');
      auditLog({ orderId, action: 'ORDER_DELETED', actor: { userId: body.userId } });
      return res.status(200).json({ ok: true, orderId });
    }

    // ── toggleItemPrepared ────────────────────────────────────────────────
    // Kitchen taps an item to mark it prepared (or un-prepared).
    // Allowed for KITCHEN, CASHIER, ADMIN, OWNER.
    if (action === 'toggleItemPrepared') {
      const authK = await checkAuth();
      if (!authK.ok) return res.status(403).json({ ok: false, error: authK.error });

      const itemId  = parseInt(body.itemId, 10);
      const prepared = Boolean(body.prepared);
      if (!itemId || isNaN(itemId)) return res.status(400).json({ ok: false, error: 'itemId is required' });

      const r = await supa('PATCH', 'dine_in_order_items',
        { prepared },
        { id: `eq.${itemId}` }
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to update item' });
      return res.status(200).json({ ok: true, itemId, prepared });
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
        `${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}&select=order_no,table_no,order_type`
      );
      if (!orderR.ok || !orderR.data.length) return res.status(404).json({ ok: false, error: 'Order not found' });
      const { order_no, table_no, order_type } = orderR.data[0];

      // Recalculate totals
      let subtotal = 0;
      const itemRows = items.map(it => {
        const qty = Math.max(1, parseInt(it.qty) || 1);
        const price = parseFloat(it.price) || 0;
        subtotal += price * qty;
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
        };
      });

      const svcCharge  = order_type === 'TAKE-OUT' ? 0 : Math.round(subtotal * SERVICE_CHARGE_RATE * 100) / 100;
      const preTax2    = subtotal + svcCharge;
      const vatEnabled2 = (await getSetting('VAT_ENABLED')) === 'true';
      const vatRate2    = parseFloat(await getSetting('VAT_RATE') || '0.12');
      const vatAmt2     = vatEnabled2 ? Math.round(preTax2 * (vatRate2 / (1 + vatRate2)) * 100) / 100 : 0;
      const total       = Math.round(preTax2 * 100) / 100;

      // Delete old items and insert new ones
      await supa('DELETE', 'dine_in_order_items', null, { order_id: `eq.${orderId}` });
      if (itemRows.length > 0) await supa('POST', 'dine_in_order_items', itemRows);

      // Update order totals
      await supa('PATCH', 'dine_in_orders', { subtotal, service_charge: svcCharge, vat_amount: vatAmt2, total }, { order_id: `eq.${orderId}` });

      logSync('dine_in_orders', orderId, 'UPDATE');
      auditLog({ orderId, action: 'ORDER_EDITED', actor: { userId: body.userId, role: authE.role }, details: { newTotal: total, itemCount: itemRows.length } });
      return res.status(200).json({ ok: true, orderId, subtotal, serviceCharge: svcCharge, total });
    }

    // ── placePlatformOrder ─────────────────────────────────────────────────
    if (action === 'placePlatformOrder') {
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
      const orderId = `${ORDER_PREFIX}-${orderNo}`;

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

      // 1. Save receipt details to order record
      const updates = {
        receipt_type:     receiptType,
        receipt_delivery: deliveryMethod,
        receipt_email:    email,
        receipt_name:     name,
        receipt_address:  address,
        receipt_tin:      tin,
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
      return res.status(200).json({ ok: true, sent: false, message: 'Receipt details saved. Print at counter.' });
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

    // ── getOnlineOrders ────────────────────────────────────────────────────
    if (action === 'getOnlineOrders') {
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/online_orders?order=created_at.desc&limit=200`
      );
      const rows = r.ok ? r.data : [];
      const orders = rows.map(o => ({
        orderRef:            o.order_ref,
        date:                o.created_at,
        customerName:        o.customer_name,
        phone:               o.customer_phone,
        email:               o.customer_email || '',
        pickupTime:          o.pickup_time || '',
        courierType:         o.courier_type || 'PICKUP',
        subtotal:            o.subtotal,
        totalAmount:         o.total_amount,
        paymentMethod:       o.payment_method,
        paymentStatus:       o.payment_status,
        orderStatus:         o.status,
        specialInstructions: o.special_instructions || '',
        adminNotes:          o.admin_notes || '',
        deliveryFee:         parseFloat(o.delivery_fee || 0),
        deliveryZone:        o.delivery_zone || null,
        lastUpdated:         o.updated_at,
      }));
      return res.status(200).json({ ok: true, orders });
    }

    // ── getCustomers ───────────────────────────────────────────────────────

  return res.status(400).json({ ok: false, error: `Unknown orders action: ${action}` });
};
