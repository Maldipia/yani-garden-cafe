// ── api/handlers/orders.js ────────────────────────────────────────────────────────────────
// Handles: placeOrder, getOrders, updateOrderStatus, updateOrderTotals, restoreOrder, deleteOrder, toggleItemPrepared, setPaymentMethod, applyDiscount, getShiftSummary
// ctx: { action, body, req, res, jwtUser, checkAuth, supa, supaFetch, auditLog,
//          SUPABASE_URL, SUPABASE_KEY, SERVICE_CHARGE_RATE, ORDER_PREFIX, getSetting }

export async function handle_orders(action, ctx) {
  const { body, req, res, jwtUser, checkAuth, supa, supaFetch, auditLog,
          SUPABASE_URL, SUPABASE_KEY, SERVICE_CHARGE_RATE, ORDER_PREFIX, getSetting } = ctx;

    // ══════════════════════════════════════════════════════════════════════
    // ORDER ACTIONS
    // ══════════════════════════════════════════════════════════════════════

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
        res.status(400).json({ ok: false, error: 'Item prices cannot be negative' }); return true;
      }

      // Server-side price validation — fetch menu from DB and verify each item price
      if (!isStaffOrder) {
        const menuR = await supaFetch(
          `${SUPABASE_URL}/rest/v1/menu_items?is_active=eq.true&select=item_code,base_price,price_short,price_medium,price_tall`
        );
        // Also fetch addon prices to allow item + addon total
        const addonR = await supaFetch(
          `${SUPABASE_URL}/rest/v1/menu_addons?is_active=eq.true&select=addon_code,price`
        );
        if (menuR.ok && menuR.data && menuR.data.length) {
          const menuMap = {};
          menuR.data.forEach(m => { menuMap[m.item_code] = m; });
          const addonMap = {};
          if (addonR.ok && addonR.data) {
            addonR.data.forEach(a => { addonMap[a.addon_code] = parseFloat(a.price) || 0; });
          }
          for (const item of items) {
            const dbItem = menuMap[item.code];
            if (!dbItem) continue; // unknown code — let DB handle
            const sentPrice = parseFloat(item.price) || 0;
            const size = (item.size || '').toLowerCase();
            // Determine valid base price based on size
            let validBase = parseFloat(dbItem.base_price) || 0;
            if (size === 'short'  && dbItem.price_short)  validBase = parseFloat(dbItem.price_short);
            if (size === 'medium' && dbItem.price_medium) validBase = parseFloat(dbItem.price_medium);
            if (size === 'tall'   && dbItem.price_tall)   validBase = parseFloat(dbItem.price_tall);
            // Add addon prices to valid total
            const addons = Array.isArray(item.addons) ? item.addons : [];
            let addonTotal = 0;
            for (const addon of addons) {
              const addonCode = addon.code || addon.addon_code || '';
              addonTotal += addonMap[addonCode] || parseFloat(addon.price) || 0;
            }
            const validPrice = validBase + addonTotal;
            // Allow 1 peso tolerance for floating point
            if (Math.abs(sentPrice - validPrice) > 1.01) {
              res.status(400).json({
                ok: false,
                error: `Invalid price for ${item.code}: sent ₱${sentPrice}, expected ₱${validPrice}`
              }); return true;
            }
          }
        }
      }

      // Validate table token against DB — mandatory for customer (non-staff) dine-in orders
      if (!isStaffOrder && tableNo !== '0') {
        if (!tableToken) {
          res.status(403).json({ ok: false, error: 'Table token required' }); return true;
        }
        const tokenR = await supaFetch(
          `${SUPABASE_URL}/rest/v1/cafe_tables?table_number=eq.${encodeURIComponent(tableNo)}&qr_token=eq.${encodeURIComponent(tableToken)}&select=table_number`
        );
        if (!tokenR.ok || !tokenR.data || tokenR.data.length === 0) {
          res.status(403).json({ ok: false, error: 'Invalid table token' }); return true;
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
        // Read ORDER_PREFIX from DB settings (tenant-specific)
        let tenantPrefix = ORDER_PREFIX;
        try {
          const pfxR = await supaFetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.ORDER_PREFIX&select=value`);
          if (pfxR.ok && pfxR.data && pfxR.data[0]) tenantPrefix = pfxR.data[0].value || ORDER_PREFIX;
        } catch(_) {}
        orderId = `${tenantPrefix}-${orderNo}`;

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
        res.status(500).json({ ok: false, error: 'Failed to place order' }); return true;
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

      // ── Auto-deduct inventory for tracked items (fire-and-forget) ──────────
      try {
        const invR = await supaFetch(
          `${SUPABASE_URL}/rest/v1/inventory?select=item_code,stock_qty,auto_disable,low_stock_threshold`
        );
        if (invR.ok && invR.data && invR.data.length) {
          const invMap = {};
          invR.data.forEach(inv => { invMap[inv.item_code] = inv; });
          for (const it of orderItems) {
            const inv = invMap[it.code];
            if (!inv) continue; // not tracked
            const newQty = Math.max(0, parseFloat(inv.stock_qty) - it.qty);
            // Deduct stock
            await supa('PATCH', 'inventory', { stock_qty: newQty }, { item_code: `eq.${it.code}` });
            // Log adjustment
            await supa('POST', 'inventory_log', {
              item_code: it.code, change_type: 'SALE', qty_change: -it.qty,
              qty_after: newQty, reason: `Order ${orderId}`, created_by: 'system'
            });
            // Auto-disable menu item if stock hits 0 and auto_disable is true
            if (inv.auto_disable && newQty <= 0) {
              await supa('PATCH', 'menu_items', { is_active: false }, { item_code: `eq.${it.code}` });
              invalidateMenuCache();
            }
          }
        }
      } catch(invErr) {
        // Non-fatal — order still completes even if inventory update fails
        console.error('Inventory deduction error:', invErr.message);
      }

            res.status(200).json({
        ok: true,
        orderId,
        ORDER_ID: orderId,
        orderNo,
        subtotal,
        serviceCharge: svcCharge,
        vatAmount: vatAmt,
        vatEnabled,
        total,
      }); return true;
    }

    // ── getOrders ──────────────────────────────────────────────────────────
    if (action === 'getOrders') {
      const orderId     = body.orderId ? String(body.orderId).trim() : null;
      const status      = body.status  ? String(body.status).toUpperCase() : null;
      const limit       = Math.min(parseInt(body.limit) || 200, 500);
      const excludeTest = body.excludeTest === true || body.excludeTest === 'true';

      const includeDeleted = body.includeDeleted === true || body.includeDeleted === 'true';
      let url = `${SUPABASE_URL}/rest/v1/dine_in_orders?order=created_at.desc&limit=${limit}${includeDeleted ? '' : '&is_deleted=eq.false'}&select=*`;
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
              price:    parseFloat(it.unit_price) || 0,
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
        isDeleted:     !!o.is_deleted,
        tableNo:       o.table_no,
        customer:      o.customer_name,   // alias used by printReceipt
        customerName:  o.customer_name,
        status:        o.status,
        orderType:     o.order_type,
        subtotal:      parseFloat(o.subtotal)       || 0,
        serviceCharge: parseFloat(o.service_charge)  || 0,
        vatAmount:     parseFloat(o.vat_amount)       || 0,
        total:         parseFloat(o.total)            || 0,
        discountedTotal: o.discounted_total ? parseFloat(o.discounted_total) : null,
        notes:         o.notes || '',
        receiptType:     o.receipt_type     || '',
        receiptDelivery: o.receipt_delivery || '',
        receiptEmail:    o.receipt_email    || '',
        receiptName:     o.receipt_name     || '',
        receiptAddress:  o.receipt_address  || '',
        receiptTIN:      o.receipt_tin      || '',
        orNumber:      o.or_number        || null,
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

      res.status(200).json({ ok: true, orders }); return true;
    }

    // ── updateOrderStatus ──────────────────────────────────────────────────
    if (action === 'updateOrderStatus') {
      const orderId      = String(body.orderId || '').trim();
      const newStatus    = String(body.status  || '').trim().toUpperCase();
      const cancelReason = body.cancelReason ? String(body.cancelReason).trim() : null;
      const validStatuses = ['NEW', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED'];
      if (!orderId)                           res.status(400).json({ ok: false, error: 'orderId is required' }); return true;
      if (!isValidOrderId(orderId))           res.status(400).json({ ok: false, error: 'Invalid orderId format' }); return true;
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

      res.status(200).json({ ok: true, orderId, status: newStatus }); return true;
    }

    // ── updateOrderTotals ──────────────────────────────────────────────────
    // Allows OWNER/ADMIN to waive or restore service charge on active orders
    if (action === 'updateOrderTotals') {
      const authT = await checkAuth(['OWNER','ADMIN']);
      if (!authT.ok) return res.status(403).json({ ok: false, error: authT.error });
      const { orderId, serviceCharge, total } = body;
      if (!orderId) return res.status(400).json({ ok: false, error: 'orderId required' });
      const svc   = parseFloat(serviceCharge);
      const tot   = parseFloat(total);
      if (isNaN(svc) || isNaN(tot) || tot < 0)
        res.status(400).json({ ok: false, error: 'Invalid amounts' }); return true;
      const patch = { service_charge: svc, total: tot, updated_at: new Date().toISOString() };
      const r = await supa('PATCH', 'dine_in_orders', patch, { order_id: `eq.${orderId}` });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to update order totals' });
      auditLog({ orderId, action: 'SERVICE_CHARGE_WAIVED', details: { serviceCharge: svc, total: tot, by: authT.userId } });
      res.status(200).json({ ok: true, serviceCharge: svc, total: tot }); return true;
    }

    // ── restoreOrder ──────────────────────────────────────────────────────
    if (action === 'restoreOrder') {
      const authRO = await checkAuth(['OWNER','ADMIN']);
      if (!authRO.ok) return res.status(403).json({ ok: false, error: authRO.error });
      const orderId = String(body.orderId || '').trim();
      if (!orderId || !isValidOrderId(orderId)) return res.status(400).json({ ok: false, error: 'Invalid orderId' });
      const r = await supa('PATCH', 'dine_in_orders', { is_deleted: false, updated_at: new Date().toISOString() }, { order_id: `eq.${orderId}` });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to restore order' });
      auditLog({ orderId, action: 'ORDER_RESTORED', actor: { userId: body.userId, role: authRO.role } });
      res.status(200).json({ ok: true, orderId }); return true;
    }

    // ── deleteOrder ────────────────────────────────────────────────────────
    if (action === 'deleteOrder') {
      const authDO = await checkAuth(['OWNER','ADMIN']);
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
      res.status(200).json({ ok: true, orderId }); return true;
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
      res.status(200).json({ ok: true, itemId, prepared }); return true;
    }

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
        res.status(400).json({ ok: false, error: 'Invalid payment method: ' + method }); return true;

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
      res.status(200).json({ ok: true, orderId, method, split: parts.length === 2 }); return true;
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
        res.status(400).json({ ok: false, error: 'Invalid discountType' }); return true;

      // Fetch current order total
      const orderR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}&select=total`
      );
      if (!orderR.ok || !orderR.data?.length)
        res.status(404).json({ ok: false, error: 'Order not found' }); return true;
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
        res.status(200).json({ ok: true, orderId, discountRemoved: true }); return true;
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
      res.status(200).json({ ok: true, orderId, type, discountAmount, discountedTotal, total }); return true;
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

      res.status(200).json({
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
      }); return true;
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
        res.status(400).json({ ok: false, error: `Cannot edit a ${orderStatus} order` }); return true;
      }

      // Discount is handled below — editOrderItems recalculates discount proportionally

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
      auditLog({ orderId, action: 'ORDER_EDITED', actor: { userId: body.userId, role: authE.role }, details: { newTotal: total, itemCount: itemRows.length, discountRecalculated: !!newDiscountedTotal } });
      res.status(200).json({ ok: true, orderId, subtotal, serviceCharge: svcCharge, total, discountedTotal: newDiscountedTotal, discountAmount: newDiscountAmt }); return true;
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

      res.status(200).json({ ok: true, orderId, total, subtotal }); return true;
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
          res.status(400).json({ ok: false, error: 'Valid email address required for email delivery' }); return true;

        // Fetch order details
        const orderR = await supaFetch(
          `${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}&limit=1`
        );
        if (!orderR.ok || !orderR.data.length)
          res.status(404).json({ ok: false, error: 'Order not found' }); return true;
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
          res.status(200).json({ ok: true, sent: true, emailId, message: `Receipt sent to ${email}` }); return true;
        } catch (emailErr) {
          res.status(500).json({ ok: false, error: `Email failed: ${emailErr.message}` }); return true;
        }
      }

      // 3. Printed delivery → just saved the info, staff will handle at counter
      res.status(200).json({ ok: true, sent: false, message: 'Receipt details saved. Print at counter.', orNumber: orNumber || null }); return true;
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
        res.status(404).json({ ok: false, error: 'Order not found' }); return true;
      const order = orderR.data[0];

      const itemsR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/dine_in_order_items?order_id=eq.${encodeURIComponent(orderId)}&order=id.asc`
      );
      const items = itemsR.ok ? (itemsR.data || []) : [];

      try {
        const emailId = await sendReceiptEmail({ toEmail, order, items, isBIR: rcpType === 'bir' });
        auditLog({ orderId, action: 'RECEIPT_SENT', actor: { userId: body.userId },
          newValue: `resend:${toEmail}`, details: { type: rcpType, emailId } });
        res.status(200).json({ ok: true, emailId, message: `Receipt resent to ${toEmail}` }); return true;
      } catch (e) {
        res.status(500).json({ ok: false, error: `Email failed: ${e.message}` }); return true;
      }
    }



  return false; // not handled by this module
}

  const _handled = ['placeOrder', 'getOrders', 'updateOrderStatus', 'updateOrderTotals', 'restoreOrder', 'deleteOrder', 'toggleItemPrepared', 'setPaymentMethod', 'applyDiscount', 'getShiftSummary', 'editOrderItems', 'placePlatformOrder', 'requestReceipt', 'resendReceipt'];
  if (!_handled.includes(action)) return false;

