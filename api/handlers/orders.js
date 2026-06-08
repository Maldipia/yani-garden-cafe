// ── Order action handlers ─────────────────────────────────────────────────
import { supaFetch, supa, auditLog, getSetting, logSync, pushToSheets } from '../lib/db.js';
import { menuCache, MENU_CACHE_TTL, invalidateMenuCache } from '../lib/cache.js';
import { getCategoryId, getCategoryName } from '../lib/categories.js';
import { isValidOrderId, isNonEmptyString } from '../lib/validation.js';
import { _maybeFireSoulSearcher, _maybeFireRainyDay } from '../lib/loyalty-events.js';
import { SUPABASE_URL, SERVICE_CHARGE_RATE, ORDER_PREFIX, BUSINESS_NAME } from '../lib/config.js';

export async function routeOrders(action, body, auth, req, res) {
  const { checkAuth, checkAdminAuth, jwtUser } = auth;

    if (action === 'placeOrder') {
      const isStaffOrder = body.staffOrder === true;
      const rawTableNo   = body.tableNo;
      const tableNo      = rawTableNo != null ? String(rawTableNo).trim() : '0';
      // Accept both 'token' (customer front-end) and 'tableToken' (legacy) field names
      const tableToken   = String(body.token || body.tableToken || '').trim();
      const customerName = String(body.customerName || body.customer || 'Guest').trim().substring(0, 100);
      // Optional customer_phone — contact info (no longer the loyalty identity)
      const rawPhone     = String(body.customerPhone || body.customer_phone || '').replace(/\D/g,'');
      const customerPhone= rawPhone.length >= 7 ? rawPhone.substring(0, 20) : null;
      // Optional customer_email — the loyalty identity. When present and matching
      // an existing loyalty account, auto-earn fires on order COMPLETED.
      const rawEmail     = String(body.customerEmail || body.customer_email || '').trim().toLowerCase();
      const customerEmail= /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail) ? rawEmail.substring(0, 254) : null;
      const notes        = String(body.notes || '').trim().substring(0, 500);
      const rawOrderType = String(body.orderType || '').toUpperCase().replace('_', '-');
      const orderType    = ['DINE-IN', 'TAKE-OUT'].includes(rawOrderType) ? rawOrderType : 'DINE-IN';
      const items        = Array.isArray(body.items) ? body.items : [];

      // Validate items
      if (items.length === 0) return res.status(400).json({ ok: false, error: 'Order must have at least one item' });
      if (items.some(i => (parseFloat(i.price) || 0) < 0)) {
        return res.status(400).json({ ok: false, error: 'Item prices cannot be negative' });
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
            const sentPriceRaw = item.price;
            const sentPrice = parseFloat(sentPriceRaw);
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
            // Only reject if client sent a nonzero price AND it doesn't match
            // If price is missing/0/null — skip check, server will use DB price anyway
            if (!isNaN(sentPrice) && sentPrice > 0 && Math.abs(sentPrice - validPrice) > 1.01) {
              return res.status(400).json({
                ok: false,
                error: `Invalid price for ${item.code}: sent ₱${sentPrice}, expected ₱${validPrice}`
              });
            }
          }
        }
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

      // Fetch addon prices from DB — never trust client-sent addon prices
      const addonR2 = await supaFetch(`${SUPABASE_URL}/rest/v1/menu_addons?is_active=eq.true&select=addon_code,price`);
      const addonMapForOrder = {};
      if (addonR2.ok && Array.isArray(addonR2.data)) {
        addonR2.data.forEach(a => { addonMapForOrder[a.addon_code] = parseFloat(a.price) || 0; });
      }

      const orderItems = [];
      let subtotal = 0;
      for (const item of items) {
        const menuItem = menuMap[item.code];
        if (!menuItem) continue; // skip unknown items
        let unitPrice = parseFloat(menuItem.base_price) || 0;
        if (menuItem.has_sizes && item.size) {
          const sizeKey = { SHORT: 'price_short', MEDIUM: 'price_medium', TALL: 'price_tall' }[String(item.size).toUpperCase()];
          if (sizeKey && menuItem[sizeKey] != null) unitPrice = parseFloat(menuItem[sizeKey]);
        }
        const qty = Math.max(1, parseInt(item.qty) || 1);
        // Addons: validate prices from DB, not client
        const itemAddons = Array.isArray(item.addons) ? item.addons : [];
        const addonPrice = itemAddons.reduce((sum, a) => {
          const code = a.code || a.addon_code || '';
          // Use DB addon price if available, fall back to 0 (never trust client addon price)
          const dbAddonPrice = addonMapForOrder[code] !== undefined ? addonMapForOrder[code] : 0;
          return sum + dbAddonPrice;
        }, 0);
        const finalUnitPrice = unitPrice + addonPrice;
        subtotal += finalUnitPrice * qty;
        orderItems.push({
          item_code:    item.code,
          item_name:    menuItem.name,
          unit_price:   finalUnitPrice,
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

      // ── Duplicate order prevention ─────────────────────────────────────────
      // Reject if same table + customer + total was placed within the last 15 seconds
      // Catches: double-tap, slow-response retries, network retry storms
      if (!isStaffOrder && tableNo !== '0') {
        const dedupeWindow = new Date(Date.now() - 15000).toISOString();
        const dupeR = await supaFetch(
          `${SUPABASE_URL}/rest/v1/dine_in_orders?table_no=eq.${encodeURIComponent(tableNo)}&customer_name=eq.${encodeURIComponent(customerName)}&total=eq.${total}&status=in.(NEW,PREPARING,READY)&is_deleted=eq.false&created_at=gte.${encodeURIComponent(dedupeWindow)}&select=order_id&limit=1`
        );
        if (dupeR.ok && dupeR.data && dupeR.data.length > 0) {
          const existingId = dupeR.data[0].order_id;
          // Return the existing order instead of creating a new one
          return res.status(200).json({ ok: true, orderId: existingId, duplicate: true, message: 'Order already placed' });
        }
      }

      // Generate order ID using sequence — with self-healing retry on duplicate key
      const TEST_TABLES = ['T99'];
      // ONLY flag orders that are clearly automated/system tests.
      // NEVER use generic names — real customers could be named anything.
      const TEST_NAMES  = ['e2e_test_auto', 'price_test_auto', 'healthcheck_auto', 'audit_auto'];
      const isTest = TEST_TABLES.includes(tableNo.toUpperCase()) ||
                     TEST_NAMES.includes(customerName.toLowerCase());

      // Yani Card discount — declared here so accessible after the for loop
      const yaniCardNum  = String(body.yaniCardNumber || '').trim().toUpperCase();
      const yaniDiscount = (body.discountType === 'YANI_CARD' && yaniCardNum)
        ? Math.round(total * 0.10 * 100) / 100
        : 0;
      const yaniTotal    = yaniDiscount > 0
        ? Math.max(0, Math.round((total - yaniDiscount) * 100) / 100)
        : null;

      // Cash / in-person Card: held until paid. Flag at creation so the order
      // surfaces on the board immediately as AWAITING_PAYMENT (alerts staff,
      // blocks prep). Ignored when a Yani Card discount is present.
      const paymentIntent = (!yaniDiscount && ['CASH', 'CARD'].includes(String(body.paymentIntent || '').toUpperCase()))
        ? String(body.paymentIntent).toUpperCase()
        : null;

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
          order_id:          orderId,
          order_no:          orderNo,
          table_no:          tableNo,
          customer_name:     customerName,
          customer_phone:    customerPhone,
          customer_email:    customerEmail,
          status:            'NEW',
          order_type:        orderType,
          subtotal:          subtotal,
          service_charge:    svcCharge,
          vat_amount:        vatAmt,
          total:             total,
          notes:             notes,
          source:            isStaffOrder ? 'STAFF' : 'QR',
          is_test:           isTest,
          ...(paymentIntent ? {
            payment_method:   paymentIntent,
            payment_status:   'AWAITING_PAYMENT',
          } : {}),
          ...(yaniDiscount > 0 ? {
            discount_type:    'YANI_CARD',
            discount_pct:     10,
            discount_amount:  yaniDiscount,
            discounted_total: yaniTotal,
            discount_note:    'Yani Card: ' + yaniCardNum,
            payment_method:   'YANI_CARD',
          } : {}),
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

      // CHARGE YANI CARD at order placement — MUST be awaited (Vercel kills process after response)
      if (yaniDiscount > 0 && yaniCardNum && !isTest) {
        try {
          const cardR = await supaFetch(
            `${SUPABASE_URL}/rest/v1/yani_cards?card_number=eq.${encodeURIComponent(yaniCardNum)}&select=qr_token,status&limit=1`
          );
          const cardRow = cardR.data?.[0];
          if (cardRow && cardRow.status === 'ACTIVE' && cardRow.qr_token) {
            await supaFetch(`${SUPABASE_URL}/rest/v1/rpc/charge_card`, {
              method: 'POST',
              body: JSON.stringify({
                p_qr_token:     cardRow.qr_token,
                p_gross_amount: total,
                p_order_id:     orderId,
                p_performed_by: 'CUSTOMER',
              })
            });
          }
        } catch(e) { console.error('Yani Card charge error:', e.message); }
      }

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

      const includeDeleted = body.includeDeleted === true || body.includeDeleted === 'true';
      let url = `${SUPABASE_URL}/rest/v1/dine_in_orders?order=created_at.desc&limit=${limit}${includeDeleted ? '' : '&is_deleted=eq.false'}&select=*`;
      if (orderId) url += `&order_id=eq.${encodeURIComponent(orderId)}`;
      else if (status === 'ACTIVE') url += `&status=in.(NEW,PREPARING,READY)`;
      else if (status === 'SCHEDULED') url += `&status=eq.SCHEDULED&is_preorder=eq.true`;
      else if (status && status !== 'ALL') url += `&status=eq.${encodeURIComponent(status)}`;
      // Always include SCHEDULED pre-orders in ALL/default view so admin sees them
      else if (!status) url += `&status=in.(SCHEDULED,NEW,PREPARING,READY,COMPLETED,CANCELLED)`;
      if (excludeTest) url += `&is_test=eq.false`;

      const ordersR = await supaFetch(url);
      if (!ordersR.ok) return res.status(502).json({ ok: false, orders: [], error: 'Failed to load orders' });

      // Fetch items for all orders (include created_at to show when items were added)
      const orderIds = ordersR.data.map(o => o.order_id);
      let itemsMap = {};
      if (orderIds.length > 0) {
        const itemsR = await supaFetch(
          `${SUPABASE_URL}/rest/v1/dine_in_order_items?order_id=in.(${orderIds.map(id => `"${id}"`).join(',')})&order=id.asc&select=id,order_id,item_code,item_name,unit_price,qty,size_choice,sugar_choice,item_notes,prepared,addons,created_at,prepared_at`
        );
        if (itemsR.ok && Array.isArray(itemsR.data)) {
          // Fetch categories for all unique item codes in one request
          const uniqueCodes = [...new Set(itemsR.data.map(it => it.item_code))];
          let catMap = {};
          try {
            const catR = await supaFetch(
              `${SUPABASE_URL}/rest/v1/menu_items?item_code=in.(${uniqueCodes.map(c => `"${c}"`).join(',')})&select=item_code,category_id`
            );
            if (catR.ok && Array.isArray(catR.data)) {
              catR.data.forEach(m => { catMap[m.item_code] = getCategoryName(m.category_id); });
            }
          } catch(_) {}

          itemsR.data.forEach(it => {
            if (!itemsMap[it.order_id]) itemsMap[it.order_id] = [];
            let parsedAddons = [];
            try { parsedAddons = it.addons ? JSON.parse(it.addons) : []; } catch(_) {}
            itemsMap[it.order_id].push({
              id:       it.id,
              code:     it.item_code,
              name:     it.item_name,
              category: catMap[it.item_code] || '',
              price:    parseFloat(it.unit_price) || 0,
              qty:      it.qty,
              size:     it.size_choice || '',
              sugar:    it.sugar_choice || '',
              notes:    it.item_notes || '',
              prepared: it.prepared || false,
              addons:   parsedAddons,
              addedAt:  it.created_at || null,
              preparedAt: it.prepared_at || null,
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
        isPreorder:    o.is_preorder || false,
        scheduledFor:  o.scheduled_for || null,
        preorderToken: o.preorder_token || null,
        items:         itemsMap[o.order_id] || [],
      }));

      return res.status(200).json({ ok: true, orders });
    }

    // ── updateOrderStatus ──────────────────────────────────────────────────
    if (action === 'updateOrderStatus') {
      // JWT auth first (preferred) — all roles allowed for kitchen workflow
      const authUO = await checkAuth(['OWNER','ADMIN','CASHIER','KITCHEN']);
      if (!authUO.ok) return res.status(403).json({ ok: false, error: authUO.error });

      const orderId      = String(body.orderId || '').trim();
      const newStatus    = String(body.status  || '').trim().toUpperCase();
      const cancelReason = body.cancelReason ? String(body.cancelReason).trim() : null;
      const validStatuses = ['NEW', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED'];
      if (!orderId)                           return res.status(400).json({ ok: false, error: 'orderId is required' });
      if (!isValidOrderId(orderId))           return res.status(400).json({ ok: false, error: 'Invalid orderId format' });
      if (!validStatuses.includes(newStatus)) return res.status(400).json({ ok: false, error: 'Invalid status: ' + newStatus });

      // Role derived from JWT (preferred) or legacy body.userId
      const userId = jwtUser ? jwtUser.userId : String(body.userId || '').trim();
      const staffRole = jwtUser ? jwtUser.role : (() => {
        // Legacy path: still validate via DB if no JWT
        return authUO.role;
      })();

      // Capture previous status for audit log
      const prevR = await supaFetch(`${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}&select=status,payment_status&limit=1`);
      const prevStatus  = (prevR.ok && prevR.data && prevR.data[0]) ? prevR.data[0].status : null;
      const prevPayStat = (prevR.ok && prevR.data && prevR.data[0]) ? String(prevR.data[0].payment_status || '').toUpperCase() : '';

      // ── Payment hold ──────────────────────────────────────────────────────
      // Cash/Card orders flagged AWAITING_PAYMENT cannot move forward (prepare,
      // ready, complete) until staff confirms payment was collected at the table.
      // Cancelling is always allowed.
      if (prevPayStat === 'AWAITING_PAYMENT' && ['PREPARING', 'READY', 'COMPLETED'].includes(newStatus)) {
        return res.status(409).json({ ok: false, holdForPayment: true,
          error: 'Order is on hold until payment is received. Collect payment, then mark it received.' });
      }

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

      // AUTO-EARN LEAVES when order is completed (YANI Roots Rewards)
      if (newStatus === 'COMPLETED') {
        try {
          const leavesEnabled = await getSetting('LEAVES_ENABLED');
          if (leavesEnabled !== 'false') {
            // Get full order — include both total (pre-discount, the basis for leaves)
            // and discounted_total (for total_spent tracking)
            const fullOrder = await supaFetch(
              `${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}&select=total,discounted_total,loyalty_account_id,points_earned,customer_name,customer_phone,customer_email,payment_method,table_no,is_test&limit=1`
            );
            const ord = fullOrder.data?.[0];
            // Yani Card payment: leaves were ALREADY earned when the card was
            // loaded (see _creditLeavesForCardLoad in api/card.js). Earning
            // again on consumption would double-count. Skip the auto-earn
            // entirely for card-paid orders.
            const paidWithYaniCard = ord && String(ord.payment_method||'').toUpperCase() === 'YANI_CARD';
            if (paidWithYaniCard) {
              // Still mark as processed so we don't loop on subsequent COMPLETED
              // events (defensive). Set points_earned=0 to indicate intentional.
              if (ord && !ord.points_earned) {
                await supaFetch(`${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}`, {
                  method: 'PATCH', body: JSON.stringify({ points_earned: 0 })
                });
                auditLog({ orderId, action: 'LEAVES_SKIPPED_YANI_CARD_PAYMENT', details: { reason: 'leaves earned at load time, not consumption' } });
              }
            } else if (ord && !ord.is_test && !ord.points_earned) {
              // ── Resolve loyalty account (same email-priority chain as before) ───
              let resolvedAccountId = ord.loyalty_account_id;

              if (!resolvedAccountId && ord.customer_email) {
                const cleanEmail = String(ord.customer_email).trim().toLowerCase();
                if (cleanEmail) {
                  const emailAccR = await supaFetch(
                    `${SUPABASE_URL}/rest/v1/loyalty_accounts?email=eq.${encodeURIComponent(cleanEmail)}&is_active=eq.true&select=id&limit=1`
                  );
                  if (emailAccR.ok && emailAccR.data?.length) {
                    resolvedAccountId = emailAccR.data[0].id;
                  }
                }
              }

              // Card-holder fallback (only for YANI_CARD-paid orders)
              const paidWithCardInit = String(ord.payment_method||'').toUpperCase() === 'YANI_CARD';
              if (!resolvedAccountId && paidWithCardInit) {
                const noteR = await supaFetch(
                  `${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}&select=discount_note&limit=1`
                );
                const note = noteR.data?.[0]?.discount_note || '';
                const cardMatch = note.match(/YANI-\d+/);
                const cardNumber = cardMatch ? cardMatch[0] : null;
                if (cardNumber) {
                  const cardR = await supaFetch(
                    `${SUPABASE_URL}/rest/v1/yani_cards?card_number=eq.${encodeURIComponent(cardNumber)}&select=card_number,holder_name,holder_phone,holder_email&limit=1`
                  );
                  const card = cardR.data?.[0];
                  if (card && card.holder_email) {
                    const cleanCardEmail = String(card.holder_email).trim().toLowerCase();
                    const cardEmailAccR = await supaFetch(
                      `${SUPABASE_URL}/rest/v1/loyalty_accounts?email=eq.${encodeURIComponent(cleanCardEmail)}&is_active=eq.true&select=id,linked_card_number&limit=1`
                    );
                    if (cardEmailAccR.ok && cardEmailAccR.data?.length) {
                      resolvedAccountId = cardEmailAccR.data[0].id;
                      if (!cardEmailAccR.data[0].linked_card_number) {
                        await supaFetch(`${SUPABASE_URL}/rest/v1/loyalty_accounts?id=eq.${encodeURIComponent(resolvedAccountId)}`, {
                          method: 'PATCH', headers: { 'Prefer': 'return=minimal' },
                          body: JSON.stringify({ linked_card_number: card.card_number, updated_at: new Date().toISOString() })
                        });
                      }
                    } else if (card.holder_name) {
                      const createR = await supaFetch(`${SUPABASE_URL}/rest/v1/loyalty_accounts`, {
                        method: 'POST',
                        body: JSON.stringify({
                          name:               card.holder_name,
                          email:              cleanCardEmail,
                          phone:              card.holder_phone ? String(card.holder_phone).replace(/\D/g,'') : null,
                          linked_card_number: card.card_number,
                          points_balance:     0, total_points_earned: 0, total_points_redeemed: 0,
                          tier:               'BRONZE',
                          total_spent:        0, visit_count: 0, is_active: true,
                        }),
                        headers: { 'Prefer': 'return=representation' }
                      });
                      if (createR.ok && createR.data?.[0]) {
                        resolvedAccountId = createR.data[0].id;
                        auditLog({ orderId, action: 'LOYALTY_ACCOUNT_AUTO_CREATED', details: { accountId: resolvedAccountId, cardNumber: card.card_number, source: 'card_payment' } });
                      }
                    }
                  }
                }
              }

              // Legacy phone fallback for non-card orders only
              if (!resolvedAccountId && !paidWithCardInit && ord.customer_phone) {
                const cleanPhone = String(ord.customer_phone).replace(/\D/g,'');
                if (cleanPhone) {
                  const phoneAccR = await supaFetch(
                    `${SUPABASE_URL}/rest/v1/loyalty_accounts?phone=eq.${encodeURIComponent(cleanPhone)}&is_active=eq.true&select=id&order=created_at.desc&limit=1`
                  );
                  if (phoneAccR.ok && phoneAccR.data?.length) {
                    resolvedAccountId = phoneAccR.data[0].id;
                  }
                }
              }

              if (resolvedAccountId) {
                // ── LEAVES EARN FORMULA ─────────────────────────────────────
                // 1. Base earn: floor(pre-discount total ÷ ₱500)
                // 2. Sunset bonus: order completed during sunset window → 2x multiplier
                //    (4-7 PM PHT by default, configurable via SURPRISE_SUNSET_*)
                // 3. After leaves are written, fire Soul Searcher + Rainy Day
                //    checks (both create surprise_rewards rows for staff fulfillment)
                const preDiscountTotal = parseFloat(ord.total || 0);
                const actualTotal      = parseFloat(ord.discounted_total || ord.total || 0);

                // Load all settings needed in one call
                const settKeys = '("LEAVES_PESOS_PER_LEAF","SURPRISE_SUNSET_ENABLED","SURPRISE_SUNSET_HOUR_START","SURPRISE_SUNSET_HOUR_END","SURPRISE_SUNSET_MULTIPLIER","SURPRISE_SOUL_SEARCHER_ENABLED","SURPRISE_SOUL_SEARCHER_VISITS","SURPRISE_SOUL_SEARCHER_WINDOW_DAYS","SURPRISE_SOUL_SEARCHER_COOLDOWN_DAYS","SURPRISE_RAINY_DAY_ENABLED","SURPRISE_RAINY_DAY_PRECIP_MM","SURPRISE_REWARD_EXPIRY_DAYS","WEATHER_LAT","WEATHER_LON")';
                const settR = await supaFetch(`${SUPABASE_URL}/rest/v1/settings?key=in.${settKeys}&select=key,value`);
                const sett = {};
                (settR.data||[]).forEach(s => { sett[s.key] = s.value; });

                const pesosPerLeaf = parseInt(sett.LEAVES_PESOS_PER_LEAF || '500') || 500;
                let leavesEarned   = Math.floor(preDiscountTotal / pesosPerLeaf);

                // ─── SUNSET MULTIPLIER (4-7 PM PHT by default) ─────────────
                // Get the order's hour in Manila time. Use the actual ord.completed
                // time which is "right now" — we're in the order-completion handler.
                let sunsetApplied = false;
                let sunsetBonus   = 0;
                if (leavesEarned > 0 && sett.SURPRISE_SUNSET_ENABLED !== 'false') {
                  // Parse PHT hour from current UTC time
                  const phtHourStr = new Date().toLocaleString('en-US', {
                    hour: 'numeric', hour12: false, timeZone: 'Asia/Manila'
                  });
                  const phtHour  = parseInt(phtHourStr);
                  const startH   = parseInt(sett.SURPRISE_SUNSET_HOUR_START || '16');
                  const endH     = parseInt(sett.SURPRISE_SUNSET_HOUR_END   || '19');
                  const multiplier = parseInt(sett.SURPRISE_SUNSET_MULTIPLIER || '2');
                  if (!isNaN(phtHour) && phtHour >= startH && phtHour < endH && multiplier > 1) {
                    sunsetBonus    = leavesEarned * (multiplier - 1);  // extra leaves on top of base
                    leavesEarned  += sunsetBonus;
                    sunsetApplied  = true;
                  }
                }

                if (leavesEarned > 0) {
                  const accR = await supaFetch(`${SUPABASE_URL}/rest/v1/loyalty_accounts?id=eq.${encodeURIComponent(resolvedAccountId)}&select=points_balance,total_points_earned,total_spent,visit_count&limit=1`);
                  if (accR.ok && accR.data?.length) {
                    const acc = accR.data[0];
                    const balBefore = acc.points_balance || 0;
                    const balAfter  = balBefore + leavesEarned;
                    const newTotalEarned = (acc.total_points_earned || 0) + leavesEarned;
                    const newTotalSpent  = (acc.total_spent || 0) + actualTotal;
                    const newVisits      = (acc.visit_count || 0) + 1;

                    await supaFetch(`${SUPABASE_URL}/rest/v1/loyalty_accounts?id=eq.${encodeURIComponent(resolvedAccountId)}`, {
                      method: 'PATCH', body: JSON.stringify({
                        points_balance:      balAfter,
                        total_points_earned: newTotalEarned,
                        total_spent:         newTotalSpent,
                        visit_count:         newVisits,
                        last_visit:          new Date().toISOString(),
                        last_earn_at:        new Date().toISOString(),
                        updated_at:          new Date().toISOString(),
                      })
                    });

                    const descSuffix = sunsetApplied
                      ? ` · 🌅 Sunset bonus (+${sunsetBonus} leaf${sunsetBonus===1?'':'s'})`
                      : '';
                    await supaFetch(`${SUPABASE_URL}/rest/v1/points_transactions`, {
                      method: 'POST', body: JSON.stringify({
                        account_id:     resolvedAccountId,
                        order_id:       orderId,
                        type:           'EARN',
                        points:         leavesEarned,
                        balance_before: balBefore,
                        balance_after:  balAfter,
                        description:    `Earned ${leavesEarned} leaf${leavesEarned===1?'':'s'} from order ${orderId} (₱${preDiscountTotal.toFixed(2)} ÷ ₱${pesosPerLeaf})` + descSuffix,
                        processed_by:   userId
                      })
                    });

                    const patchPayload = { points_earned: leavesEarned };
                    if (!ord.loyalty_account_id) patchPayload.loyalty_account_id = resolvedAccountId;
                    await supaFetch(`${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}`, {
                      method: 'PATCH', body: JSON.stringify(patchPayload)
                    });
                    auditLog({ orderId, action: 'LEAVES_EARNED', details: { accountId: resolvedAccountId, leavesEarned, balAfter, lifetime: newTotalEarned, preDiscountTotal, paidWithCard: paidWithCardInit, sunsetApplied, sunsetBonus } });

                    // ─── SURPRISE REWARDS (post-earn triggers) ───────────────────
                    // Both run fire-and-forget; failures here never affect the order.
                    // They check their own settings flags + cooldowns so we don't
                    // need to gate them at the call site.
                    try {
                      await _maybeFireSoulSearcher(resolvedAccountId, orderId, sett);
                    } catch(e) { console.error('Soul Searcher error:', e.message); }
                    try {
                      await _maybeFireRainyDay(resolvedAccountId, orderId, sett);
                    } catch(e) { console.error('Rainy Day error:', e.message); }
                  }
                }
              }
            }
          }
        } catch(loyaltyErr) {
          // Never fail the order completion because of loyalty error
          console.error('Loyalty auto-earn error:', loyaltyErr.message);
        }
      }

      if (newStatus === 'COMPLETED') {
        try {
          const yaniOrderR = await supaFetch(
            `${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}&select=payment_method,discount_type,discount_note,total,discounted_total,is_test&limit=1`
          );
          const yaniOrd = yaniOrderR.data?.[0];
          const isYaniCardOrder = yaniOrd && !yaniOrd.is_test &&
            yaniOrd.payment_method === 'YANI_CARD' &&
            (yaniOrd.discount_type === 'YANI_CARD' ||
              (yaniOrd.discount_type === 'CUSTOM' && String(yaniOrd.discount_note || '').toLowerCase().includes('yani card')) ||
              String(yaniOrd.discount_type || '').startsWith('YANI_CARD+'));

          if (isYaniCardOrder && yaniOrd.discount_note) {
            const cardNumMatch = String(yaniOrd.discount_note).match(/YANI-\d+/i);
            if (cardNumMatch) {
              const cardNum = cardNumMatch[0].toUpperCase();
              // Idempotency: skip if already charged
              const existR = await supaFetch(
                `${SUPABASE_URL}/rest/v1/card_transactions?order_id=eq.${encodeURIComponent(orderId)}&type=eq.CHARGE&select=id&limit=1`
              );
              if (!existR.data?.length) {
                const cardR = await supaFetch(
                  `${SUPABASE_URL}/rest/v1/yani_cards?card_number=eq.${encodeURIComponent(cardNum)}&select=qr_token,status,discount_pct&limit=1`
                );
                const cardRow = cardR.data?.[0];
                if (cardRow && cardRow.status === 'ACTIVE' && cardRow.qr_token) {
                  const isStacked = String(yaniOrd.discount_type || '').includes('+');
                  if (isStacked && yaniOrd.discounted_total) {
                    // Stacked discount: charge exact final amount (no extra 10%)
                    await supaFetch(`${SUPABASE_URL}/rest/v1/rpc/charge_card_exact`, {
                      method: 'POST',
                      body: JSON.stringify({
                        p_qr_token:     cardRow.qr_token,
                        p_net_amount:   parseFloat(yaniOrd.discounted_total),
                        p_order_id:     orderId,
                        p_performed_by: userId || 'SYSTEM',
                        p_description:  `Order ${orderId} — stacked discount final ₱${yaniOrd.discounted_total}`,
                      })
                    });
                  } else {
                    // Normal Yani Card: charge via RPC (applies 10% automatically)
                    await supaFetch(`${SUPABASE_URL}/rest/v1/rpc/charge_card`, {
                      method: 'POST',
                      body: JSON.stringify({
                        p_qr_token:     cardRow.qr_token,
                        p_gross_amount: parseFloat(yaniOrd.total),
                        p_order_id:     orderId,
                        p_performed_by: userId || 'SYSTEM',
                      })
                    });
                  }
                }
              }
            }
          }
        } catch(yaniErr) {
          console.error('Yani Card auto-charge error:', yaniErr.message);
        }
      }

      return res.status(200).json({ ok: true, orderId, status: newStatus });
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
        return res.status(400).json({ ok: false, error: 'Invalid amounts' });
      const patch = { service_charge: svc, total: tot, updated_at: new Date().toISOString() };
      const r = await supa('PATCH', 'dine_in_orders', patch, { order_id: `eq.${orderId}` });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to update order totals' });
      auditLog({ orderId, action: 'SERVICE_CHARGE_WAIVED', details: { serviceCharge: svc, total: tot, by: authT.userId } });
      return res.status(200).json({ ok: true, serviceCharge: svc, total: tot });
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
      return res.status(200).json({ ok: true, orderId });
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
        { prepared, prepared_at: prepared ? new Date().toISOString() : null },
        { id: `eq.${itemId}` }
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to update item' });
      // Return the order's current status so kitchen.html can auto-trigger PREPARING/READY
      let orderStatus = null;
      try {
        const oRes = await supa('GET', 'dine_in_order_items',
          null, { id: `eq.${itemId}`, select: 'order_id' }
        );
        if (oRes.ok && oRes.data && oRes.data[0]) {
          const orderId = oRes.data[0].order_id;
          const statusRes = await supa('GET', 'dine_in_orders',
            null, { order_id: `eq.${orderId}`, select: 'status' }
          );
          if (statusRes.ok && statusRes.data && statusRes.data[0]) {
            orderStatus = statusRes.data[0].status;
          }
        }
      } catch(_) {}
      return res.status(200).json({ ok: true, itemId, prepared, orderStatus });
    }

    // ── setPaymentMethod ──────────────────────────────────────────────────
    // Admin/Cashier/Owner sets how an order was paid.
    // method can be single (CASH) or split (GCASH+CASH, CARD+GCASH, etc.)
    // ── saveSplitBill ──────────────────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════
    // LOYALTY POINTS SYSTEM
    // ══════════════════════════════════════════════════════════════════════

    // ── getLoyaltySettings ─────────────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════
    // PRE-ORDERING SYSTEM
    // ══════════════════════════════════════════════════════════════════════

    // ── createPreOrder (public — customer-facing) ──────────────────────────
    if (action === 'createPreOrder') {
      const { customerName, customerPhone, items, scheduledFor, orderType, notes } = body;
      if (!customerName || !customerPhone || !items?.length || !scheduledFor) {
        return res.status(400).json({ ok: false, error: 'customerName, customerPhone, items, and scheduledFor required' });
      }

      // Validate scheduled time
      const pickupTime = new Date(scheduledFor);
      const now = new Date();
      const diffMins = (pickupTime - now) / 60000;

      const minR = await supaFetch(`${SUPABASE_URL}/rest/v1/settings?key=in.("PREORDER_MIN_ADVANCE","PREORDER_MAX_ADVANCE","PREORDER_ENABLED")&select=key,value`);
      const minSett = {};
      (minR.data||[]).forEach(s => { minSett[s.key] = s.value; });

      if (minSett.PREORDER_ENABLED === 'false') return res.status(400).json({ ok: false, error: 'Pre-ordering is currently disabled' });
      const minAdv = parseInt(minSett.PREORDER_MIN_ADVANCE || '30');
      const maxAdv = parseInt(minSett.PREORDER_MAX_ADVANCE || '1440');
      if (diffMins < minAdv) return res.status(400).json({ ok: false, error: `Must order at least ${minAdv} minutes in advance` });
      if (diffMins > maxAdv) return res.status(400).json({ ok: false, error: `Cannot order more than ${Math.round(maxAdv/60)} hours in advance` });

      // Build order
      const menuR = await supaFetch(`${SUPABASE_URL}/rest/v1/menu_items?is_active=eq.true&select=item_code,name,base_price,price_short,price_medium,price_tall,has_sizes`);
      const menuMap = {};
      (menuR.data||[]).forEach(m => { menuMap[m.item_code] = m; });

      let subtotal = 0;
      const orderItems = [];
      for (const it of items) {
        const menu = menuMap[it.code];
        if (!menu) return res.status(400).json({ ok: false, error: `Item not found: ${it.code}` });
        let price = parseFloat(menu.base_price||0);
        if (menu.has_sizes && it.size) {
          if (it.size === 'Short') price = parseFloat(menu.price_short||price);
          else if (it.size === 'Medium') price = parseFloat(menu.price_medium||price);
          else if (it.size === 'Tall') price = parseFloat(menu.price_tall||price);
        }
        const lineTotal = price * (it.qty||1);
        subtotal += lineTotal;
        orderItems.push({ code: it.code, name: menu.name, price, qty: it.qty||1, size: it.size||'', sugar: it.sugar||'', lineTotal });
      }

      const svcRate = parseFloat((await getSetting('SERVICE_CHARGE'))||'0.1');
      const svc = orderType === 'TAKE-OUT' ? 0 : Math.round(subtotal * svcRate * 100) / 100;
      const total = subtotal + svc;

      // Generate order ID and token
      const prefix = (await getSetting('ORDER_PREFIX'))||'YANI';
      const cntR = await supaFetch(`${SUPABASE_URL}/rest/v1/dine_in_orders?select=order_no&order=order_no.desc&limit=1`);
      const lastNo = cntR.data?.[0]?.order_no || 1000;
      const orderNo = lastNo + 1;
      const orderId = `${prefix}-${orderNo}`;
      const token = Math.random().toString(36).substring(2,10).toUpperCase();

      // Insert order
      const orderR = await supaFetch(`${SUPABASE_URL}/rest/v1/dine_in_orders`, {
        method: 'POST',
        headers: { 'Prefer': 'return=representation' },
        body: JSON.stringify({
          order_id: orderId, order_no: orderNo, status: 'SCHEDULED',
          order_type: orderType||'TAKE-OUT', source: 'QR',
          customer_name: customerName, table_no: 'PREORDER',
          subtotal, service_charge: svc, total,
          notes: notes||'', is_preorder: true,
          scheduled_for: pickupTime.toISOString(),
          preorder_token: token,
          payment_status: 'PENDING',
          items_json: JSON.stringify(orderItems)
        })
      });
      if (!orderR.ok) return res.status(500).json({ ok: false, error: 'Failed to create pre-order' });

      // Insert order items
      const itemRows = orderItems.map(it => ({
        order_id: orderId, order_no: orderNo, table_no: 'PREORDER',
        item_code: it.code, item_name: it.name, unit_price: it.price,
        qty: it.qty, size_choice: it.size||'', sugar_choice: it.sugar||''
      }));
      await supaFetch(`${SUPABASE_URL}/rest/v1/dine_in_order_items`, { method: 'POST', body: JSON.stringify(itemRows) });

      auditLog({ orderId, action: 'PREORDER_PLACED', details: { scheduledFor: pickupTime.toISOString(), customerName, total, items: orderItems.length } });

      return res.status(200).json({ ok: true, orderId, token, scheduledFor: pickupTime.toISOString(), total, subtotal, svc });
    }

    // ── getPreOrders (admin) ───────────────────────────────────────────────
    if (action === 'getPreOrders') {
      const auth = await checkAuth(['OWNER','ADMIN','CASHIER','KITCHEN']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/dine_in_orders?is_preorder=eq.true&status=in.("SCHEDULED","NEW","PREPARING","READY")&order=scheduled_for.asc&select=*&limit=100`
      );
      return res.status(200).json({ ok: true, orders: (r.data||[]).map(o => ({
        orderId: o.order_id, orderNo: o.order_no, status: o.status,
        customerName: o.customer_name, tableNo: o.table_no,
        orderType: o.order_type, subtotal: parseFloat(o.subtotal||0),
        serviceCharge: parseFloat(o.service_charge||0), total: parseFloat(o.total||0),
        notes: o.notes, scheduledFor: o.scheduled_for,
        paymentStatus: o.payment_status, paymentMethod: o.payment_method,
        createdAt: o.created_at, isPreorder: true,
        items: (() => { try { return JSON.parse(o.items_json||'[]'); } catch { return []; } })()
      })) });
    }

    // ── triggerScheduledOrders (called by admin poll + cron) ───────────────
    if (action === 'triggerScheduledOrders') {
      const auth = await checkAuth(['OWNER','ADMIN','CASHIER','KITCHEN']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });

      const bufferR = await supaFetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.PREORDER_PREP_BUFFER&select=value&limit=1`);
      const bufferMins = parseInt(bufferR.data?.[0]?.value || '15');
      const triggerTime = new Date(Date.now() + bufferMins * 60000).toISOString();

      // Find orders due to start
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/dine_in_orders?is_preorder=eq.true&status=eq.SCHEDULED&scheduled_for=lte.${encodeURIComponent(triggerTime)}&select=order_id,customer_name,scheduled_for`
      );
      const due = r.data || [];
      const triggered = [];

      for (const o of due) {
        await supaFetch(`${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(o.order_id)}`, {
          method: 'PATCH', body: JSON.stringify({ status: 'NEW', updated_at: new Date().toISOString() })
        });
        auditLog({ orderId: o.order_id, action: 'PREORDER_TRIGGERED', details: { scheduledFor: o.scheduled_for, triggeredAt: new Date().toISOString() } });
        triggered.push(o.order_id);
      }

      return res.status(200).json({ ok: true, triggered, count: triggered.length });
    }

    // ── getPreOrderStatus (public — customer tracking) ─────────────────────
    if (action === 'getPreOrderStatus') {
      const { orderId, token } = body;
      if (!orderId || !token) return res.status(400).json({ ok: false, error: 'orderId and token required' });
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}&preorder_token=eq.${encodeURIComponent(token)}&select=order_id,status,scheduled_for,customer_name,total,subtotal,service_charge,payment_status,items_json&limit=1`
      );
      if (!r.ok || !r.data?.length) return res.status(200).json({ ok: false, error: 'Order not found' });
      const o = r.data[0];
      return res.status(200).json({ ok: true, order: {
        orderId: o.order_id, status: o.status, scheduledFor: o.scheduled_for,
        customerName: o.customer_name, total: parseFloat(o.total||0),
        paymentStatus: o.payment_status,
        items: (() => { try { return JSON.parse(o.items_json||'[]'); } catch { return []; } })()
      }});
    }


  return false;
}
