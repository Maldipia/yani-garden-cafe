// ── ANALYTICS HANDLERS ── auto-extracted from pos.js
'use strict';

module.exports = async function handle_analytics(action, body, req, res, ctx) {
  const {
    supa, supaFetch, checkAuth, checkAdminAuth, auditLog, pushToSheets, logSync,
    invalidateMenuCache, getSetting, menuCache, SUPABASE_URL, SUPABASE_KEY,
    ORDER_PREFIX, SERVICE_CHARGE_RATE, isNonEmptyString, isValidPrice,
    isValidItemCode, isValidOrderId, isNonEmptyArray, isValidPhone
  } = ctx;

    // ── getShiftSummary ────────────────────────────────────────────────────
    // Returns today's sales breakdown by payment method for end-of-day reconciliation
    if (action === 'getShiftSummary') {
      const authSh = await checkAuth(['OWNER','ADMIN','CASHIER']);
      if (!authSh.ok) return res.status(403).json({ ok: false, error: authSh.error });

      // Get timezone from settings (default Asia/Manila)
      const tz = await getSetting('TIMEZONE') || 'Asia/Manila';

      // Today's date in PH time
      const nowPH  = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
      const y = nowPH.getFullYear(), m = String(nowPH.getMonth()+1).padStart(2,'0'), d = String(nowPH.getDate()).padStart(2,'0');
      const todayStart = `${y}-${m}-${d}T00:00:00+08:00`;
      const todayEnd   = `${y}-${m}-${d}T23:59:59+08:00`;

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
        date: `${y}-${m}-${d}`,
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

    // ── getAnalytics ───────────────────────────────────────────────────────
    if (action === 'getAnalytics') {
      // OWNER / ADMIN only
      const authA = await checkAdminAuth();
      if (!authA.ok) return res.status(403).json({ ok: false, error: authA.error });

      const BASE = `${SUPABASE_URL}/rest/v1`;
      const H    = { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` };

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

      // Today vs yesterday — use Philippines time (UTC+8)
      const todayStr     = new Date(Date.now() + phOffset).toISOString().slice(0,10);
      const yesterdayStr = new Date(Date.now() + phOffset - 86400000).toISOString().slice(0,10);
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

      return res.status(200).json({
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
      });
    }

    // ── getStaff ───────────────────────────────────────────────────────────
    // ── getAuditLogs ───────────────────────────────────────────────────────
    if (action === 'getAuditLogs') {
      const authA = await checkAdminAuth();
      if (!authA.ok) return res.status(403).json({ ok: false, error: authA.error });
      const orderId = body.orderId ? String(body.orderId).trim() : null;
      const limit   = Math.min(parseInt(body.limit) || 100, 500);
      let url = `${SUPABASE_URL}/rest/v1/order_audit_logs?order=created_at.desc&limit=${limit}`;
      if (orderId) url += `&order_id=eq.${encodeURIComponent(orderId)}`;
      const r = await supaFetch(url);
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to fetch audit logs' });
      return res.status(200).json({ ok: true, logs: r.data || [] });
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
      return res.status(200).json({ ok: true, customers });
    }


  return res.status(400).json({ ok: false, error: `Unknown analytics action: ${action}` });
};
