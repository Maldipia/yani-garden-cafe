// ── api/handlers/online-orders.js ────────────────────────────────────────────────────────────────
// Handles: getOnlineOrders, createReservation, getTables, updateTable, deleteTable, addTable, getReservations, updateReservation, getCustomers, getAnalytics
// ctx: { action, body, req, res, jwtUser, checkAuth, supa, supaFetch, auditLog,
//          SUPABASE_URL, SUPABASE_KEY, SERVICE_CHARGE_RATE, ORDER_PREFIX, getSetting }

export async function handle_online_orders(action, ctx) {
  const { body, req, res, jwtUser, checkAuth, supa, supaFetch, auditLog,
          SUPABASE_URL, SUPABASE_KEY, SERVICE_CHARGE_RATE, ORDER_PREFIX, getSetting } = ctx;

    // ══════════════════════════════════════════════════════════════════════
    // ONLINE ORDER ACTIONS (pass-through to Supabase)
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
      res.status(200).json({ ok: true, orders }); return true;
    }

    // ── getCustomers ───────────────────────────────────────────────────────
    // ── createReservation ─────────────────────────────────────────────────
    if (action === 'createReservation') {
      // ONLINE bookings (no userId) are allowed — staff bookings require admin role
      const isOnline = !body.userId;
      if (!isOnline) {
        const authR = await checkAdminAuth();
        if (!authR.ok) return res.status(403).json({ ok: false, error: authR.error });
      }

      const { guestName, guestPhone, guestEmail, tableNo, pax, resDate, resTime,
              notes, occasion, seatingPref, dietary } = body;

      if (!guestName || !resDate || !resTime)
        res.status(400).json({ ok: false, error: 'guestName, resDate, resTime are required' }); return true;

      // Online bookings don't pick a specific table — staff assigns one
      const table = tableNo ? parseInt(tableNo) : null;
      if (table !== null && (table < 1 || table > 10))
        res.status(400).json({ ok: false, error: 'tableNo must be 1-10' }); return true;

      // Validate date not in the past
      const today = new Date().toISOString().slice(0, 10);
      if (resDate < today)
        res.status(400).json({ ok: false, error: 'Reservation date cannot be in the past' }); return true;

      // Get next res_id
      const seqR = await supaFetch(`${SUPABASE_URL}/rest/v1/rpc/get_next_res_id`, {
        method: 'POST', body: JSON.stringify({})
      });
      const resId = seqR.ok ? seqR.data : `RES-${Date.now()}`;

      const r = await supa('POST', 'reservations', {
        res_id:       resId,
        table_no:     table,
        guest_name:   String(guestName).trim(),
        guest_phone:  guestPhone  ? String(guestPhone).trim()  : null,
        guest_email:  guestEmail  ? String(guestEmail).trim()  : null,
        pax:          parseInt(pax) || 1,
        res_date:     resDate,
        res_time:     resTime,
        notes:        notes       ? String(notes).trim()       : null,
        occasion:     occasion    ? String(occasion).trim()    : null,
        seating_pref: seatingPref ? String(seatingPref).trim() : null,
        dietary:      dietary     ? String(dietary).trim()     : null,
        source:       isOnline ? 'ONLINE' : 'STAFF',
        status:       'CONFIRMED',
      });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to create reservation' });
      res.status(200).json({ ok: true, resId }); return true;
    }

    // ── getTables ──────────────────────────────────────────────────────────
    if (action === 'getTables') {
      const authR = await checkAuth();
      if (!authR.ok) return res.status(403).json({ ok: false, error: authR.error });
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/cafe_tables?order=table_number.asc&select=table_number,qr_token,table_name,capacity`
      );
      res.status(200).json({ ok: true, tables: r.data || [] }); return true;
    }

    // ── updateTable ────────────────────────────────────────────────────────
    if (action === 'updateTable') {
      const authR = await checkAdminAuth();
      if (!authR.ok) return res.status(403).json({ ok: false, error: authR.error });
      const { tableNo, tableName, capacity } = body;
      if (!tableNo) return res.status(400).json({ ok: false, error: 'tableNo required' });
      const updates = {};
      if (tableName !== undefined) updates.table_name = String(tableName).trim().slice(0, 50);
      if (capacity !== undefined) updates.capacity = parseInt(capacity) || 4;
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/cafe_tables?table_number=eq.${encodeURIComponent(tableNo)}`,
        { method: 'PATCH', body: JSON.stringify(updates) }
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to update table' });
      res.status(200).json({ ok: true }); return true;
    }

    // ── deleteTable ────────────────────────────────────────────────────────
    if (action === 'deleteTable') {
      const authR = await checkAdminAuth();
      if (!authR.ok) return res.status(403).json({ ok: false, error: authR.error });
      const { tableNo } = body;
      if (!tableNo) return res.status(400).json({ ok: false, error: 'tableNo required' });
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/cafe_tables?table_number=eq.${encodeURIComponent(tableNo)}`,
        { method: 'DELETE' }
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to delete table' });
      res.status(200).json({ ok: true }); return true;
    }

    // ── addTable ───────────────────────────────────────────────────────────
    if (action === 'addTable') {
      const authR = await checkAdminAuth();
      if (!authR.ok) return res.status(403).json({ ok: false, error: authR.error });
      const tableNo = parseInt(body.tableNo);
      if (!tableNo || tableNo < 1 || tableNo > 99)
        res.status(400).json({ ok: false, error: 'Invalid table number (1-99)' }); return true;
      // Generate random 8-char hex token
      const token = Array.from({length:8}, () => Math.floor(Math.random()*16).toString(16)).join('');
      const tableName = body.tableName ? String(body.tableName).trim().slice(0,50) : `Table ${tableNo}`;
      const capacity = parseInt(body.capacity) || 4;
      const r = await supa('POST', 'cafe_tables', { table_number: tableNo, qr_token: token, table_name: tableName, capacity });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to add table — may already exist' });
      res.status(200).json({ ok: true, tableNo, token }); return true;
    }

    // ── getReservations ────────────────────────────────────────────────────
    if (action === 'getReservations') {
      const authR = await checkAdminAuth();
      if (!authR.ok) return res.status(403).json({ ok: false, error: authR.error });

      const date = body.date ? String(body.date) : new Date().toISOString().slice(0,10);
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/reservations?res_date=eq.${date}&status=neq.CANCELLED&order=res_time.asc&select=*`
      );
      res.status(200).json({ ok: true, reservations: r.data || [] }); return true;
    }

    // ── updateReservation ──────────────────────────────────────────────────
    if (action === 'updateReservation') {
      const authR = await checkAdminAuth();
      if (!authR.ok) return res.status(403).json({ ok: false, error: authR.error });

      const { resId, status, notes } = body;
      if (!resId) return res.status(400).json({ ok: false, error: 'resId is required' });
      const validStatuses = ['CONFIRMED','SEATED','COMPLETED','CANCELLED','NO_SHOW'];
      if (status && !validStatuses.includes(status))
        res.status(400).json({ ok: false, error: 'Invalid status' }); return true;

      const patch = {};
      if (status) patch.status = status;
      if (notes !== undefined) patch.notes = notes;

      const r = await supa('PATCH', 'reservations', patch, { res_id: `eq.${resId}` });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to update reservation' });
      res.status(200).json({ ok: true }); return true;
    }

    if (action === 'getCustomers') {
      const authGC = await checkAdminAuth();
      if (!authGC.ok) return res.status(403).json({ ok: false, error: authGC.error });
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/online_orders?order=created_at.asc&limit=500&select=customer_phone,customer_name,created_at,total_amount,order_ref`
      );
      const rows = r.ok ? r.data : [];
      const custMap = {};
      rows.forEach(o => {
        const phone = o.customer_phone || 'Unknown';
        if (!custMap[phone]) {
          custMap[phone] = {
            phone,
            customerName:   o.customer_name,
            firstOrderDate: o.created_at,
            lastOrderDate:  o.created_at,
            totalOrders:    0,
            totalSpend:     0,
          };
        }
        custMap[phone].lastOrderDate  = o.created_at;
        custMap[phone].totalOrders   += 1;
        custMap[phone].totalSpend    += parseFloat(o.total_amount || 0);
      });
      const customers = Object.values(custMap)
        .sort((a, b) => new Date(b.lastOrderDate) - new Date(a.lastOrderDate));
      res.status(200).json({ ok: true, customers }); return true;
    }

    // ── getAnalytics ───────────────────────────────────────────────────────
    if (action === 'getAnalytics') {
      // OWNER / ADMIN only
      const authA = await checkAdminAuth();
      if (!authA.ok) return res.status(403).json({ ok: false, error: authA.error });

      const BASE = `${SUPABASE_URL}/rest/v1`;
      const H    = { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` };

  const _handled = ['getOnlineOrders', 'createReservation', 'getTables', 'updateTable', 'deleteTable', 'addTable', 'getReservations', 'updateReservation', 'getCustomers', 'getAnalytics', 'getAuditLogs', 'getStaff', 'getSettings', 'updateSetting'];
  if (!_handled.includes(action)) return false;


      // ── Daily revenue last 30 days ─────────────────────────────────────
      const thirtyAgo = new Date(Date.now() - 30*24*3600*1000).toISOString();
      const ordersR = await fetch(
        `${BASE}/dine_in_orders?status=eq.COMPLETED&is_test=eq.false&is_deleted=eq.false&created_at=gte.${thirtyAgo}&select=created_at,total,discounted_total,order_type`,
        { headers: H }
      );
      const orders = ordersR.ok ? (await ordersR.json()) : [];

      // Daily revenue map
      const phOffset = 8 * 3600000; // UTC+8 Philippines time
      const dailyMap = {};
      orders.forEach(o => {
        // Use PH date (UTC+8) for day grouping
        const phDate = new Date(new Date(o.created_at).getTime() + phOffset);
        const day = phDate.toISOString().slice(0,10);
        if (!dailyMap[day]) dailyMap[day] = { revenue:0, count:0 };
        // Use discounted_total when available (reflects actual amount paid)
        dailyMap[day].revenue += parseFloat(o.discounted_total || o.total || 0);
        dailyMap[day].count   += 1;
      });
      const daily = Object.entries(dailyMap)
        .map(([day,v]) => ({ day, revenue: Math.round(v.revenue*100)/100, count: v.count }))
        .sort((a,b) => a.day.localeCompare(b.day));

      // Business day grouping: order belongs to business day based on 6 AM cutoff
      // e.g. order at 12:30 AM on Apr 4 belongs to Apr 3 business day
      function getBusinessDay(isoStr) {
        const phDate = new Date(new Date(isoStr).getTime() + phOffset);
        const h = phDate.getUTCHours();
        if (h < 6) phDate.setTime(phDate.getTime() - 86400000); // before 6 AM → prev biz day
        return phDate.toISOString().slice(0,10);
      }
      // Rebuild dailyMap with business day grouping
      const dailyMapBiz = {};
      orders.forEach(o => {
        const day = getBusinessDay(o.created_at);
        if (!dailyMapBiz[day]) dailyMapBiz[day] = { revenue:0, count:0 };
        dailyMapBiz[day].revenue += parseFloat(o.discounted_total || o.total || 0);
        dailyMapBiz[day].count   += 1;
      });
      Object.assign(dailyMap, dailyMapBiz); // replace with business-day version

      // Today vs yesterday — use business day logic
      const nowPHT2 = new Date(Date.now() + phOffset);
      const curH    = nowPHT2.getUTCHours();
      if (curH < 6) nowPHT2.setTime(nowPHT2.getTime() - 86400000);
      const todayStr     = nowPHT2.toISOString().slice(0,10);
      const yesterdayStr = new Date(nowPHT2.getTime() - 86400000).toISOString().slice(0,10);
      const todayData     = dailyMap[todayStr]     || { revenue:0, count:0 };
      const yesterdayData = dailyMap[yesterdayStr] || { revenue:0, count:0 };

      // Total last 7 days
      const sevenAgoStr = new Date(Date.now()-7*86400000).toISOString().slice(0,10);
      let rev7=0, cnt7=0;
      daily.forEach(d => { if (d.day >= sevenAgoStr) { rev7+=d.revenue; cnt7+=d.count; } });

      // ── Hourly distribution (today) ────────────────────────────────────
      const hourly = Array.from({length:24}, (_,i) => ({ hour:i, count:0, revenue:0 }));
      orders.filter(o => {
        const phDate = new Date(new Date(o.created_at).getTime() + phOffset);
        return phDate.toISOString().slice(0,10) === todayStr;
      }).forEach(o => {
        const phDate = new Date(new Date(o.created_at).getTime() + phOffset);
        const h = phDate.getUTCHours(); // hour in PH time
        hourly[h].count   += 1;
        hourly[h].revenue += parseFloat(o.discounted_total || o.total || 0);
      });

      // ── Order type split (last 30d) ───────────────────────────────────
      const typeSplit = { 'DINE-IN':0, 'TAKE-OUT':0 };
      orders.forEach(o => { typeSplit[o.order_type] = (typeSplit[o.order_type]||0)+1; });

      // ── Top items — use Supabase Management API raw SQL to avoid 1000-row REST limit ──
      // The REST API silently truncates at 1000 rows; with 1200+ order items this caused
      // wrong counts. Raw SQL via JOIN gives the correct aggregated result directly.
      const topItemsR = await fetch(
        `https://api.supabase.com/v1/projects/hnynvclpvfxzlfjphefj/database/query`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.SUPABASE_PAT || ''}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query: `
            SELECT i.item_name AS name,
                   SUM(i.qty)::int        AS qty,
                   SUM(i.line_total)::float AS revenue
            FROM dine_in_order_items i
            JOIN dine_in_orders o ON o.order_id = i.order_id
            WHERE o.status      = 'COMPLETED'
              AND o.is_test     = false
              AND o.is_deleted  = false
            GROUP BY i.item_name
            ORDER BY qty DESC
            LIMIT 20
          ` })
        }
      );
      let topItems = [];
      if (topItemsR.ok) {
        const topData = await topItemsR.json();
        topItems = Array.isArray(topData) ? topData.map(r => ({
          name: r.name, qty: r.qty, revenue: r.revenue
        })) : [];
      }
      // Fallback: if PAT not set, use the old method with higher limit
      if (topItems.length === 0) {
        const ordersWithId = await fetch(
          `${BASE}/dine_in_orders?status=eq.COMPLETED&is_test=eq.false&is_deleted=eq.false&select=order_id&limit=5000`,
          { headers: H }
        );
        const completedIds = new Set((ordersWithId.ok ? await ordersWithId.json() : []).map(o=>o.order_id));
        const rawItemsR = await fetch(
          `${BASE}/dine_in_order_items?select=item_name,qty,line_total,order_id&limit=5000`,
          { headers: H }
        );
        const rawItems = rawItemsR.ok ? (await rawItemsR.json()) : [];
        const itemMap = {};
        rawItems.forEach(i => {
          if (!completedIds.has(i.order_id)) return;
          const name = i.item_name || 'Unknown';
          if (!itemMap[name]) itemMap[name] = { name, qty:0, revenue:0 };
          itemMap[name].qty     += parseInt(i.qty || 0);
          itemMap[name].revenue += parseFloat(i.line_total || 0);
        });
        topItems = Object.values(itemMap).sort((a,b) => b.qty - a.qty).slice(0,20);
      }

      // ── Cancellation stats ────────────────────────────────────────────
      const cancelR = await fetch(
        `${BASE}/dine_in_orders?status=eq.CANCELLED&is_test=eq.false&is_deleted=eq.false&select=cancel_reason`,
        { headers: H }
      );
      const cancelled = cancelR.ok ? (await cancelR.json()) : [];
      const cancelMap = {};
      cancelled.forEach(o => {
        const r = o.cancel_reason || 'unspecified';
        cancelMap[r] = (cancelMap[r]||0)+1;
      });
      const realCancels = cancelled.filter(o => o.cancel_reason !== 'migration_cleanup').length;

      // ── Payment method breakdown (last 30d completed orders) ──────────
      const payR = await fetch(
        `${BASE}/dine_in_orders?status=eq.COMPLETED&is_test=eq.false&is_deleted=eq.false&created_at=gte.${thirtyAgo}&select=payment_method,total,discounted_total,discount_amount`,
        { headers: H }
      );
      const payOrders = payR.ok ? (await payR.json()) : [];
      const payBreakdown = {};
      let totalDiscounts30d = 0;
      payOrders.forEach(o => {
        const m = o.payment_method || 'UNRECORDED';
        if (!payBreakdown[m]) payBreakdown[m] = { count:0, revenue:0 };
        payBreakdown[m].count   += 1;
        payBreakdown[m].revenue += parseFloat(o.discounted_total || o.total || 0);
        totalDiscounts30d += parseFloat(o.discount_amount || 0);
      });

      res.status(200).json({
        ok: true,
        // Flat aliases for dashboard compatibility
        todaySales:  Math.round(todayData.revenue*100)/100,
        todayOrders: todayData.count,
        summary: {
          today:     { revenue: Math.round(todayData.revenue*100)/100,     orders: todayData.count },
          yesterday: { revenue: Math.round(yesterdayData.revenue*100)/100, orders: yesterdayData.count },
          last7days: { revenue: Math.round(rev7*100)/100,                  orders: cnt7 },
          realCancellations: realCancels,
          totalOrders30d: orders.length,
          typeSplit,
          totalDiscounts30d: Math.round(totalDiscounts30d*100)/100,
        },
        daily,
        hourly,
        topItems,
        cancelBreakdown: cancelMap,
        paymentBreakdown: payBreakdown,
      }); return true;
    }

    // ── getStaff ───────────────────────────────────────────────────────────
    // ── getAuditLogs ───────────────────────────────────────────────────────
    if (action === 'getAuditLogs') {
      const authA = await checkAuth(['OWNER','ADMIN']);
      if (!authA.ok) return res.status(403).json({ ok: false, error: authA.error });
      const orderId = body.orderId ? String(body.orderId).trim() : null;
      const limit   = Math.min(parseInt(body.limit) || 100, 500);
      let url = `${SUPABASE_URL}/rest/v1/order_audit_logs?order=created_at.desc&limit=${limit}`;
      if (orderId) url += `&order_id=eq.${encodeURIComponent(orderId)}`;
      const r = await supaFetch(url);
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to fetch audit logs' });
      res.status(200).json({ ok: true, logs: r.data || [] }); return true;
    }

    if (action === 'getStaff') {
      const authS = await checkAdminAuth();
      if (!authS.ok) return res.status(403).json({ ok: false, error: authS.error });
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/staff_users?active=eq.true&order=user_id.asc&select=user_id,username,display_name,role,last_login,failed_attempts`
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to fetch staff' });
      const staffList = r.data || [];
      res.status(200).json({ ok: true, staff: staffList, users: staffList }); return true;
    }

    // ── getSettings ────────────────────────────────────────────────────────
    if (action === 'getSettings') {
      const r = await supaFetch(`${SUPABASE_URL}/rest/v1/settings?order=key.asc&select=key,value,description`);
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to fetch settings' });
      res.status(200).json({ ok: true, settings: r.data || [] }); return true;
    }

    // ── updateSetting ──────────────────────────────────────────────────────
    if (action === 'updateSetting') {
      const authUS = await checkAuth(['OWNER']);
      if (!authUS.ok) return res.status(403).json({ ok: false, error: authUS.error });
      const { key, value } = body;
      if (!key) return res.status(400).json({ ok: false, error: 'key is required' });
      // Validate VAT-specific values
      if (key === 'VAT_ENABLED' && !['true','false'].includes(value)) {
        res.status(400).json({ ok: false, error: 'VAT_ENABLED must be true or false' }); return true;
      }
      if (key === 'VAT_RATE') {
        const n = parseFloat(value);
        if (isNaN(n) || n < 0 || n > 1) return res.status(400).json({ ok: false, error: 'VAT_RATE must be between 0 and 1 (e.g. 0.12 for 12%)' });
      }
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/settings?key=eq.${encodeURIComponent(key)}`,
        { method: 'PATCH', body: JSON.stringify({ value: String(value), updated_at: new Date().toISOString() }) }
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to update setting' });
      res.status(200).json({ ok: true, key, value }); return true;
    }




  return false; // not handled by this module
}
