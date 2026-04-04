// api/daily-report.js — Daily Sales Report (email to owner)
// Called by Vercel cron daily at 11 PM PHT (15:00 UTC)
import * as XLSX from 'xlsx';
// Also callable manually: POST { action:'sendDailyReport', secret:'...' }

const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://hnynvclpvfxzlfjphefj.supabase.co');
const SUPABASE_KEY = (() => {
  const k = process.env.SUPABASE_SECRET_KEY;
  if (!k) throw new Error('SUPABASE_SECRET_KEY not set');
  return k;
})();
const RESEND_KEY    = process.env.RESEND_API_KEY || '';
const REPORT_SECRET = process.env.REPORT_SECRET  || '';
const REPORT_EMAIL  = process.env.REPORT_EMAIL   || 'tygfsb@gmail.com';
const FROM_EMAIL    = process.env.REPORT_FROM    || 'onboarding@resend.dev';

async function supaFetch(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type':  'application/json',
      ...(opts.headers || {}),
    },
  });
  const data = r.ok ? await r.json() : null;
  return { ok: r.ok, status: r.status, data };
}

// ── Build report data ─────────────────────────────────────────────────────
async function buildReport() {
  // Business day = 6 AM PHT to 6 AM PHT (YANI opens 10 AM, closes 12 MN)
  // Report covers: yesterday 6:00 AM → today 5:59:59 AM PHT
  const now = new Date();
  const phtOffset = 8 * 60 * 60 * 1000;
  const BDAY_START_HOUR = 6; // 6 AM PHT = start of business day

  // Current time in PHT
  const nowPHT = new Date(now.getTime() + phtOffset);

  // Business day end = today at 6 AM PHT (UTC)
  const todayBdayEnd = new Date(nowPHT);
  todayBdayEnd.setUTCHours(BDAY_START_HOUR, 0, 0, 0);

  // Business day start = yesterday at 6 AM PHT (UTC)
  const yestBdayStart = new Date(todayBdayEnd.getTime() - 24 * 60 * 60 * 1000);

  const startISO = new Date(yestBdayStart.getTime() - phtOffset).toISOString();
  const endISO   = new Date(todayBdayEnd.getTime()  - phtOffset).toISOString();

  // Date label = the business day date (yesterday in PHT)
  const dateLabel = yestBdayStart.toLocaleDateString('en-PH', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'Asia/Manila',
  });

  // Fetch business name from settings
  let businessName = 'My Cafe';
  let businessAddress = 'Philippines';
  try {
    const settR = await supaFetch(`settings?key=in.("BUSINESS_NAME","ADDRESS")&select=key,value`);
    if (settR.ok && settR.data) {
      settR.data.forEach(s => {
        if (s.key === 'BUSINESS_NAME') businessName = s.value || businessName;
        if (s.key === 'ADDRESS') businessAddress = s.value || businessAddress;
      });
    }
  } catch(_) {}

  // ── Orders for yesterday ──────────────────────────────────────────────
  const ordersR = await supaFetch(
    `dine_in_orders?created_at=gte.${startISO}&created_at=lt.${endISO}&is_deleted=eq.false&is_test=eq.false&select=order_id,status,total,discounted_total,discount_type,discount_amount,order_type,payment_method,created_at,customer_name,table_no,subtotal,service_charge&order=created_at.asc`
  );
  const orders = ordersR.data || [];

  const completed = orders.filter(o => o.status === 'COMPLETED');
  const cancelled = orders.filter(o => o.status === 'CANCELLED');

  // Use discounted_total when available — reflects actual amount paid
  const getAmt = o => parseFloat(o.discounted_total ?? o.total ?? 0);

  const totalSales    = completed.reduce((s, o) => s + getAmt(o), 0);
  const totalDiscount = completed.reduce((s, o) => s + parseFloat(o.discount_amount || 0), 0);
  const avgOrder      = completed.length ? totalSales / completed.length : 0;

  // Payment method breakdown
  const payBreakdown = {};
  completed.forEach(o => {
    const pm = o.payment_method || 'Unknown';
    payBreakdown[pm] = (payBreakdown[pm] || 0) + getAmt(o);
  });

  // Order type breakdown — DB stores 'DINE-IN' and 'TAKE-OUT' (hyphens)
  const dineIn  = completed.filter(o => o.order_type === 'DINE-IN').length;
  const takeOut = completed.filter(o => o.order_type === 'TAKE-OUT').length;

  // ── Top items ─────────────────────────────────────────────────────────
  const orderIds = completed.map(o => o.order_id);
  let topItems = [];
  if (orderIds.length > 0) {
    const itemsR = await supaFetch(
      `dine_in_order_items?order_id=in.(${orderIds.map(id => `"${id}"`).join(',')})&select=item_name,qty,line_total`
    );
    const items = itemsR.data || [];
    const itemMap = {};
    items.forEach(it => {
      const key = it.item_name;
      if (!itemMap[key]) itemMap[key] = { name: it.item_name, qty: 0, revenue: 0 };
      itemMap[key].qty     += parseInt(it.qty || 1);
      itemMap[key].revenue += parseFloat(it.line_total || 0);
    });
    topItems = Object.values(itemMap)
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 5);
  }

  // ── Hourly breakdown ──────────────────────────────────────────────────
  const hourly = {};
  completed.forEach(o => {
    const phtHour = new Date(new Date(o.created_at).getTime() + phtOffset).getUTCHours();
    const label = `${String(phtHour).padStart(2,'0')}:00`;
    if (!hourly[label]) hourly[label] = { count: 0, revenue: 0 };
    hourly[label].count++;
    hourly[label].revenue += getAmt(o);
  });
  const peakHour = Object.entries(hourly).sort((a,b) => b[1].count - a[1].count)[0];

  return {
    dateLabel, startISO, endISO, businessName, businessAddress,
    orders,
    totalOrders: orders.length,
    completedOrders: completed.length,
    cancelledOrders: cancelled.length,
    totalSales, avgOrder, totalDiscount,
    dineIn, takeOut,
    payBreakdown, topItems,
    peakHour: peakHour ? { hour: peakHour[0], count: peakHour[1].count } : null,
    hourly,
    businessName, businessAddress,
  };
}

// ── Build HTML email ──────────────────────────────────────────────────────
function buildEmailHTML(r) {
  const fmt = n => '₱' + parseFloat(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = (a, b) => b ? Math.round(a / b * 100) + '%' : '0%';

  const topItemsRows = r.topItems.length
    ? r.topItems.map((it, i) => `
        <tr style="border-bottom:1px solid #f0f0f0;">
          <td style="padding:10px 16px;color:#64748b;">${['🥇','🥈','🥉','4️⃣','5️⃣'][i]}</td>
          <td style="padding:10px 16px;font-weight:600;">${it.name}</td>
          <td style="padding:10px 16px;text-align:center;">${it.qty}x</td>
          <td style="padding:10px 16px;text-align:right;color:#16a34a;font-weight:600;">${fmt(it.revenue)}</td>
        </tr>`).join('')
    : `<tr><td colspan="4" style="padding:16px;text-align:center;color:#94a3b8;">No completed orders</td></tr>`;

  const payRows = Object.entries(r.payBreakdown).length
    ? Object.entries(r.payBreakdown)
        .sort((a,b) => b[1]-a[1])
        .map(([method, amt]) => `
          <tr>
            <td style="padding:8px 16px;">${method || 'Unknown'}</td>
            <td style="padding:8px 16px;text-align:right;font-weight:600;">${fmt(amt)}</td>
            <td style="padding:8px 16px;text-align:right;color:#64748b;">${pct(amt, r.totalSales)}</td>
          </tr>`).join('')
    : `<tr><td colspan="3" style="padding:16px;text-align:center;color:#94a3b8;">N/A</td></tr>`;

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:32px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);">

  <!-- HEADER -->
  <tr><td style="background:linear-gradient(135deg,#854d0e 0%,#a16207 100%);padding:36px 40px;text-align:center;">
    <div style="font-size:32px;margin-bottom:8px;">☕</div>
    <h1 style="color:white;margin:0;font-size:24px;font-weight:800;letter-spacing:.5px;">Daily Sales Report</h1>
    <p style="color:rgba(255,255,255,.75);margin:8px 0 0;font-size:15px;">${r.dateLabel}</p>
  </td></tr>

  <!-- SUMMARY STATS -->
  <tr><td style="padding:32px 40px;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td width="50%" style="padding:0 8px 0 0;">
          <div style="background:#f0fdf4;border-radius:12px;padding:20px;text-align:center;">
            <div style="font-size:30px;font-weight:900;color:#16a34a;">${fmt(r.totalSales)}</div>
            <div style="font-size:13px;color:#64748b;margin-top:4px;font-weight:600;">TOTAL SALES</div>
          </div>
        </td>
        <td width="50%" style="padding:0 0 0 8px;">
          <div style="background:#eff6ff;border-radius:12px;padding:20px;text-align:center;">
            <div style="font-size:30px;font-weight:900;color:#2563eb;">${r.completedOrders}</div>
            <div style="font-size:13px;color:#64748b;margin-top:4px;font-weight:600;">ORDERS COMPLETED</div>
          </div>
        </td>
      </tr>
      <tr><td colspan="2" style="padding:12px 0 0;"></td></tr>
      <tr>
        <td width="50%" style="padding:0 8px 0 0;">
          <div style="background:#fefce8;border-radius:12px;padding:16px;text-align:center;">
            <div style="font-size:24px;font-weight:800;color:#ca8a04;">${fmt(r.avgOrder)}</div>
            <div style="font-size:12px;color:#64748b;margin-top:2px;">AVG ORDER VALUE</div>
          </div>
        </td>
        <td width="50%" style="padding:0 0 0 8px;">
          <div style="background:#fdf4ff;border-radius:12px;padding:16px;text-align:center;">
            <div style="font-size:24px;font-weight:800;color:#9333ea;">${r.cancelledOrders}</div>
            <div style="font-size:12px;color:#64748b;margin-top:2px;">CANCELLED ORDERS</div>
          </div>
        </td>
      </tr>
    </table>
    ${r.totalDiscount > 0 ? `
    <div style="margin-top:12px;background:#fff7ed;border-radius:10px;padding:12px 16px;font-size:13px;color:#92400e;">
      💸 Total discounts applied: <strong>${fmt(r.totalDiscount)}</strong> (PWD / Senior / Promo)
    </div>` : ''}
  </td></tr>

  <!-- ORDER TYPE -->
  <tr><td style="padding:0 40px 24px;">
    <div style="background:#f8fafc;border-radius:12px;padding:16px 20px;">
      <div style="font-size:13px;font-weight:700;color:#475569;margin-bottom:12px;">ORDER TYPE SPLIT</div>
      <div style="display:flex;gap:24px;">
        <span>🪑 <strong>${r.dineIn}</strong> Dine-In &nbsp;(${pct(r.dineIn, r.completedOrders)})</span>
        <span>🥡 <strong>${r.takeOut}</strong> Take-Out &nbsp;(${pct(r.takeOut, r.completedOrders)})</span>
        ${r.peakHour ? `<span>🔥 Peak: <strong>${r.peakHour.hour}</strong> (${r.peakHour.count} orders)</span>` : ''}
      </div>
    </div>
  </td></tr>

  <!-- TOP ITEMS -->
  <tr><td style="padding:0 40px 24px;">
    <h2 style="font-size:16px;font-weight:700;color:#1e293b;margin:0 0 12px;">🏆 Top Items</h2>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
      <tr style="background:#f8fafc;">
        <th style="padding:10px 16px;text-align:left;font-size:12px;color:#64748b;font-weight:600;">#</th>
        <th style="padding:10px 16px;text-align:left;font-size:12px;color:#64748b;font-weight:600;">ITEM</th>
        <th style="padding:10px 16px;text-align:center;font-size:12px;color:#64748b;font-weight:600;">QTY</th>
        <th style="padding:10px 16px;text-align:right;font-size:12px;color:#64748b;font-weight:600;">REVENUE</th>
      </tr>
      ${topItemsRows}
    </table>
  </td></tr>

  <!-- PAYMENT BREAKDOWN -->
  <tr><td style="padding:0 40px 32px;">
    <h2 style="font-size:16px;font-weight:700;color:#1e293b;margin:0 0 12px;">💳 Payment Breakdown</h2>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
      <tr style="background:#f8fafc;">
        <th style="padding:10px 16px;text-align:left;font-size:12px;color:#64748b;font-weight:600;">METHOD</th>
        <th style="padding:10px 16px;text-align:right;font-size:12px;color:#64748b;font-weight:600;">AMOUNT</th>
        <th style="padding:10px 16px;text-align:right;font-size:12px;color:#64748b;font-weight:600;">SHARE</th>
      </tr>
      ${payRows}
    </table>
  </td></tr>

  <!-- FOOTER -->
  <tr><td style="background:#f8fafc;padding:20px 40px;text-align:center;border-top:1px solid #e2e8f0;">
    <p style="margin:0;color:#94a3b8;font-size:12px;">
      ☕ ${r.businessName||'My Cafe'} · ${r.businessAddress||'Philippines'}<br>
      This is an automated daily report. Do not reply to this email.
    </p>
  </td></tr>

</table>
</td></tr></table>
</body></html>`;
}

// ── Build Excel attachment ───────────────────────────────────────────────────
function buildXlsx(r) {
  const fmt = n => parseFloat(n || 0).toFixed(2);
  const phtLabel = iso => {
    try {
      const d = new Date(new Date(iso).getTime() + 8*3600000);
      return d.toISOString().slice(11,16); // HH:MM
    } catch(_) { return ''; }
  };

  const completed = (r.orders || []).filter(o => o.status === 'COMPLETED');
  const cancelled = (r.orders || []).filter(o => o.status === 'CANCELLED');

  const wb = XLSX.utils.book_new();

  // ── Sheet 1: Summary ───────────────────────────────────────────────────
  const cashAmt  = completed.filter(o=>o.payment_method==='CASH').reduce((s,o)=>s+parseFloat(o.discounted_total||o.total||0),0);
  const gcashAmt = completed.filter(o=>o.payment_method==='GCASH').reduce((s,o)=>s+parseFloat(o.discounted_total||o.total||0),0);
  const cardAmt  = completed.filter(o=>o.payment_method==='CARD').reduce((s,o)=>s+parseFloat(o.discounted_total||o.total||0),0);

  const summaryData = [
    ['YANI GARDEN CAFE — Daily Sales Report', '', ''],
    [r.dateLabel, '', ''],
    ['Business Day: 6:00 AM → 6:00 AM PHT', '', ''],
    ['', '', ''],
    ['METRIC', 'VALUE', ''],
    ['Total Sales', parseFloat(r.totalSales||0), ''],
    ['Completed Orders', r.completedOrders || 0, ''],
    ['Cancelled Orders', r.cancelledOrders || 0, ''],
    ['Average Order Value', parseFloat(r.avgOrder||0), ''],
    ['Total Discounts', parseFloat(r.totalDiscount||0), ''],
    ['', '', ''],
    ['PAYMENT BREAKDOWN', 'AMOUNT', 'ORDERS'],
    ['Cash', cashAmt, completed.filter(o=>o.payment_method==='CASH').length],
    ['GCash / QR', gcashAmt, completed.filter(o=>o.payment_method==='GCASH').length],
    ['Card', cardAmt, completed.filter(o=>o.payment_method==='CARD').length],
    ['TOTAL', parseFloat(r.totalSales||0), r.completedOrders||0],
    ['', '', ''],
    ['TOP ITEMS', 'QTY', 'REVENUE'],
    ...(r.topItems||[]).map(it => [it.name, it.qty, parseFloat(it.revenue||0)]),
  ];
  const ws1 = XLSX.utils.aoa_to_sheet(summaryData);
  ws1['!cols'] = [{wch:40},{wch:16},{wch:12}];
  XLSX.utils.book_append_sheet(wb, ws1, 'Summary');

  // ── Sheet 2: All Orders ────────────────────────────────────────────────
  const orderHeaders = ['Order ID','Time','Customer','Table','Type','Status','Payment','Subtotal','Svc Charge','Discount','Total'];
  const orderRows = (r.orders||[]).map(o => [
    o.order_id,
    phtLabel(o.created_at),
    o.customer_name || 'Guest',
    o.table_no || '',
    o.order_type || '',
    o.status,
    o.payment_method || '—',
    parseFloat(o.subtotal||0),
    parseFloat(o.service_charge||0),
    parseFloat(o.discount_amount||0),
    parseFloat(o.discounted_total||o.total||0),
  ]);
  const ws2 = XLSX.utils.aoa_to_sheet([orderHeaders, ...orderRows]);
  ws2['!cols'] = [{wch:14},{wch:8},{wch:20},{wch:7},{wch:10},{wch:13},{wch:10},{wch:12},{wch:12},{wch:12},{wch:12}];
  XLSX.utils.book_append_sheet(wb, ws2, 'All Orders');

  // ── Sheet 3: Completed Orders ──────────────────────────────────────────
  const compHeaders = ['Order ID','Time','Customer','Table','Payment','Subtotal','Svc Charge','Discount','Total'];
  const compRows = completed.map(o => [
    o.order_id,
    phtLabel(o.created_at),
    o.customer_name || 'Guest',
    o.table_no || '',
    o.payment_method || '',
    parseFloat(o.subtotal||0),
    parseFloat(o.service_charge||0),
    parseFloat(o.discount_amount||0),
    parseFloat(o.discounted_total||o.total||0),
  ]);
  // Totals row
  compRows.push(['TOTAL','','','','',
    completed.reduce((s,o)=>s+parseFloat(o.subtotal||0),0),
    completed.reduce((s,o)=>s+parseFloat(o.service_charge||0),0),
    completed.reduce((s,o)=>s+parseFloat(o.discount_amount||0),0),
    parseFloat(r.totalSales||0),
  ]);
  const ws3 = XLSX.utils.aoa_to_sheet([compHeaders, ...compRows]);
  ws3['!cols'] = [{wch:14},{wch:8},{wch:20},{wch:7},{wch:10},{wch:12},{wch:12},{wch:12},{wch:12}];
  XLSX.utils.book_append_sheet(wb, ws3, 'Completed Orders');

  // ── Sheet 4: Cancelled Orders ──────────────────────────────────────────
  const cancHeaders = ['Order ID','Time','Customer','Table','Order Total'];
  const cancRows = cancelled.map(o => [
    o.order_id,
    phtLabel(o.created_at),
    o.customer_name || 'Guest',
    o.table_no || '',
    parseFloat(o.total||0),
  ]);
  const ws4 = XLSX.utils.aoa_to_sheet([cancHeaders, ...cancRows]);
  ws4['!cols'] = [{wch:14},{wch:8},{wch:20},{wch:7},{wch:14}];
  XLSX.utils.book_append_sheet(wb, ws4, 'Cancelled Orders');

  // Return as base64 string for email attachment
  const buf = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
  return buf;
}

// ── Send via Resend ───────────────────────────────────────────────────────
async function sendEmail(html, dateLabel, businessName, xlsxBase64) {
  if (!RESEND_KEY) throw new Error('RESEND_API_KEY not set');

  // Format filename: YANI_Sales_Report_April3_2026.xlsx
  const safeDate = dateLabel.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g,'_');
  const filename = `YANI_Sales_Report_${safeDate}.xlsx`;

  const body = {
    from:    FROM_EMAIL,
    to:      [REPORT_EMAIL],
    subject: `☕ ${businessName} Daily Report — ${dateLabel}`,
    html,
  };

  // Attach xlsx if generated successfully
  if (xlsxBase64) {
    body.attachments = [{
      filename,
      content: xlsxBase64,
    }];
  }

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.message || 'Resend error');
  return data.id;
}

// ── Handler ───────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Allow GET (Vercel cron) or POST (manual trigger)
  const isGet  = req.method === 'GET';
  const isPost = req.method === 'POST';
  if (!isGet && !isPost) return res.status(405).end();

  // Auth: cron uses Authorization header, manual POST uses secret in body
  const cronAuth = req.headers['authorization'];
  const bodySecret = isPost ? (req.body?.secret || '') : '';

  const cronOk   = cronAuth === `Bearer ${process.env.CRON_SECRET || ''}`;
  // REPORT_SECRET for manual trigger; fall back to CRON_SECRET if not set
  const effectiveSecret = REPORT_SECRET || process.env.CRON_SECRET || '';
  const manualOk = effectiveSecret && bodySecret === effectiveSecret;

  // Also allow: admin JWT token in Authorization header (for admin dashboard trigger)
  let jwtAdminOk = false;
  if (!cronOk && !manualOk && cronAuth && cronAuth.startsWith('Bearer ') && cronAuth !== `Bearer ${process.env.CRON_SECRET || ''}`) {
    try {
      // Verify JWT using same approach as pos.js (jsonwebtoken is CJS)
      const jwtMod = await import('jsonwebtoken');
      const jwtLib = jwtMod.default || jwtMod;
      const decoded = jwtLib.verify(cronAuth.replace('Bearer ', ''), process.env.JWT_SECRET || '');
      if (decoded && (decoded.role === 'OWNER' || decoded.role === 'ADMIN')) jwtAdminOk = true;
    } catch(e) { /* invalid token */ }
  }
  // Also allow: body.secret === REPORT_SECRET for dashboard button
  if (!cronOk && !manualOk && !jwtAdminOk && body && body.secret && REPORT_SECRET && body.secret === REPORT_SECRET) {
    jwtAdminOk = true;
  }

  if (!cronOk && !manualOk && !jwtAdminOk) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    const report  = await buildReport();
    const html    = buildEmailHTML(report);
    let xlsxBase64 = null;
    try { xlsxBase64 = buildXlsx(report); } catch(xlsxErr) { console.error('xlsx gen failed:', xlsxErr.message); }
    const emailId = await sendEmail(html, report.dateLabel, report.businessName || 'My Cafe', xlsxBase64);

    return res.status(200).json({
      ok: true,
      emailId,
      summary: {
        date:       report.dateLabel,
        totalSales: report.totalSales,
        orders:     report.completedOrders,
        topItem:    report.topItems[0]?.name || 'N/A',
      },
    });
  } catch (err) {
    console.error('daily-report error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
