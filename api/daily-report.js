// api/daily-report.js — Daily Sales Report (email to owner)
// Called by Vercel cron daily at 11 PM PHT (15:00 UTC)
import ExcelJS from 'exceljs';
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

  // ── Attach item text to each order for xlsx ──────────────────────────
  if (orders.length > 0) {
    const allIds = orders.map(o=>o.order_id);
    const itemsR2 = await supaFetch(
      `dine_in_order_items?order_id=in.(${allIds.map(id=>`"${id}"`).join(',')})&select=order_id,item_name,qty,size_choice,sugar_choice`
    );
    if (itemsR2.ok && itemsR2.data) {
      const itemsByOrder = {};
      itemsR2.data.forEach(it => {
        if (!itemsByOrder[it.order_id]) itemsByOrder[it.order_id] = [];
        const opts = [it.size_choice, it.sugar_choice].filter(Boolean).join(' | ');
        itemsByOrder[it.order_id].push(`${it.item_name} x${it.qty}${opts?' ('+opts+')':''}`);
      });
      orders.forEach(o => { o.items_text = (itemsByOrder[o.order_id]||[]).join(' | '); });
    }
  }

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

// ── Build Excel attachment (fully formatted, same layout as manual report) ───
async function buildXlsx(r) {
  const phtTime = iso => {
    try {
      const d = new Date(new Date(iso).getTime() + 8*3600000);
      const h = d.getUTCHours(), m = String(d.getUTCMinutes()).padStart(2,'0');
      const ampm = h >= 12 ? 'PM' : 'AM';
      return `${String(h%12||12).padStart(2,'0')}:${m} ${ampm}`;
    } catch(_) { return ''; }
  };

  const completed = (r.orders||[]).filter(o => o.status==='COMPLETED');
  const cancelled = (r.orders||[]).filter(o => o.status==='CANCELLED');
  const getAmt = o => parseFloat(o.discounted_total||o.total||0);

  const cashAmt  = completed.filter(o=>o.payment_method==='CASH').reduce((s,o)=>s+getAmt(o),0);
  const gcashAmt = completed.filter(o=>o.payment_method==='GCASH').reduce((s,o)=>s+getAmt(o),0);
  const cardAmt  = completed.filter(o=>o.payment_method==='CARD').reduce((s,o)=>s+getAmt(o),0);
  const cashCnt  = completed.filter(o=>o.payment_method==='CASH').length;
  const gcashCnt = completed.filter(o=>o.payment_method==='GCASH').length;
  const cardCnt  = completed.filter(o=>o.payment_method==='CARD').length;
  const totalSales    = parseFloat(r.totalSales||0);
  const totalSubtotal = completed.reduce((s,o)=>s+parseFloat(o.subtotal||0),0);
  const totalSvc      = completed.reduce((s,o)=>s+parseFloat(o.service_charge||0),0);
  const totalDiscount = parseFloat(r.totalDiscount||0);

  // ── Colors ─────────────────────────────────────────────────────────────
  const FOREST  = '314C47';
  const FOREST2 = '3D5E57';
  const GOLD    = 'B8973A';
  const CREAM   = 'FAF8F4';
  const WHITE   = 'FFFFFFFF';
  const GREEN_F = 'E8F5E9';
  const RED_F   = 'FDECEA';
  const GREY    = 'F5F5F5';

  const hdrFont  = { name:'Arial', size:10, bold:true,  color:{argb:'FFFFFFFF'} };
  const bodyFont = { name:'Arial', size:9,  bold:false, color:{argb:'FF1E3530'} };
  const boldFont = { name:'Arial', size:9,  bold:true,  color:{argb:'FF1E3530'} };
  const whtFont  = { name:'Arial', size:10, bold:true,  color:{argb:'FFFFFFFF'} };
  const thinBorder = {
    top:{style:'thin',color:{argb:'FFCCCCCC'}}, bottom:{style:'thin',color:{argb:'FFCCCCCC'}},
    left:{style:'thin',color:{argb:'FFCCCCCC'}}, right:{style:'thin',color:{argb:'FFCCCCCC'}},
  };
  const fill = hex => ({ type:'pattern', pattern:'solid', fgColor:{argb:'FF'+hex} });
  const numFmt = '#,##0.00';
  const center = { horizontal:'center', vertical:'middle' };
  const right  = { horizontal:'right',  vertical:'middle' };
  const left   = { horizontal:'left',   vertical:'middle', indent:1 };

  const wb = new ExcelJS.Workbook();
  wb.creator = 'YANI POS';

  // ════════════════════════════════════════════════════════════════════════
  // SHEET 1 — SUMMARY
  // ════════════════════════════════════════════════════════════════════════
  const ws1 = wb.addWorksheet('Summary');
  ws1.views = [{ showGridLines: false }];
  ws1.columns = [
    {width:24},{width:18},{width:18},{width:30},{width:18},{width:18}
  ];

  // Title
  ws1.mergeCells('A1:F1');
  const t1 = ws1.getCell('A1');
  t1.value = 'YANI GARDEN CAFE';
  t1.font = { name:'Arial', size:18, bold:true, color:{argb:'FFFFFFFF'} };
  t1.fill = fill(FOREST); t1.alignment = center;
  ws1.getRow(1).height = 36;

  ws1.mergeCells('A2:F2');
  const t2 = ws1.getCell('A2');
  t2.value = `Daily Sales Report — ${r.dateLabel}  (Business Day: 6:00 AM → 6:00 AM PHT)`;
  t2.font = { name:'Arial', size:11, color:{argb:'FFFFFFFF'} };
  t2.fill = fill(FOREST2); t2.alignment = center;
  ws1.getRow(2).height = 22;

  ws1.getRow(3).height = 8;

  // Stat cards
  const statLabels = ['TOTAL SALES','COMPLETED ORDERS','CANCELLED ORDERS','CASH SALES','GCASH SALES','CARD SALES'];
  const statValues = [totalSales, completed.length, cancelled.length, cashAmt, gcashAmt, cardAmt];
  const statSubs   = ['','','', cashCnt+' orders', gcashCnt+' orders', cardCnt+' orders'];
  const cols = ['A','B','C','D','E','F'];
  ws1.getRow(4).height = 14;
  ws1.getRow(5).height = 30;
  ws1.getRow(6).height = 18;
  cols.forEach((col,i) => {
    const lc = ws1.getCell(`${col}4`);
    lc.value = statLabels[i]; lc.font = {name:'Arial',size:8,bold:true,color:{argb:'FF888888'}};
    lc.fill = fill(GREY.replace('#','')||'F5F5F5'); lc.alignment = center;

    const vc = ws1.getCell(`${col}5`);
    vc.value = (i===0||i>=3) ? totalSales===0&&i===0 ? '₱0.00' : statValues[i] : statValues[i];
    if (i===0||i>=3) { vc.numFmt = '"₱"#,##0.00'; }
    vc.font = { name:'Arial', size:14, bold:true, color:{argb: i===0?'FF'+FOREST:'FF1E3530'} };
    vc.fill = fill('FFFFFF'); vc.alignment = center;

    const sc = ws1.getCell(`${col}6`);
    sc.value = statSubs[i]; sc.font = {name:'Arial',size:8,color:{argb:'FF666666'}};
    sc.fill = fill('FFFFFF'); sc.alignment = center;
  });

  ws1.getRow(7).height = 8;
  ws1.getRow(8).height = 20;

  // Payment section header
  ws1.mergeCells('A8:C8');
  const ph = ws1.getCell('A8');
  ph.value='PAYMENT BREAKDOWN'; ph.font=hdrFont; ph.fill=fill(GOLD); ph.alignment=left;

  ws1.mergeCells('D8:F8');
  const oh = ws1.getCell('D8');
  oh.value='ORDER TOTALS BREAKDOWN'; oh.font=hdrFont; oh.fill=fill(GOLD); oh.alignment=left;

  const payRows = [
    ['Cash', cashCnt, cashAmt],
    ['GCash / QR', gcashCnt, gcashAmt],
    ['Card', cardCnt, cardAmt],
    ['TOTAL', completed.length, totalSales],
  ];
  const totRows = [
    ['Subtotal (before svc charge)', totalSubtotal],
    ['Service Charge (10%)', totalSvc],
    ['Discounts Applied', -totalDiscount],
    ['GRAND TOTAL', totalSales],
  ];
  payRows.forEach(([lbl,cnt,amt],i) => {
    const row = 9+i; ws1.getRow(row).height = 18;
    const isT = lbl==='TOTAL';
    const f = fill(isT ? FOREST : 'EEF0EB');
    const fn = isT ? whtFont : boldFont;
    ['A','B','C'].forEach(c => ws1.getCell(`${c}${row}`).fill=f);
    const la=ws1.getCell(`A${row}`); la.value=lbl; la.font=fn; la.alignment=left;
    const ca=ws1.getCell(`B${row}`); ca.value=cnt; ca.font=fn; ca.alignment=center;
    const aa=ws1.getCell(`C${row}`); aa.value=amt; aa.numFmt='"₱"#,##0.00'; aa.font=fn; aa.alignment=right;
  });
  totRows.forEach(([lbl,amt],i) => {
    const row = 9+i; const isT=lbl==='GRAND TOTAL';
    const f=fill(isT?FOREST:'EEF0EB'); const fn=isT?whtFont:boldFont;
    ['D','E','F'].forEach(c=>ws1.getCell(`${c}${row}`).fill=f);
    ws1.mergeCells(`E${row}:F${row}`);
    const ld=ws1.getCell(`D${row}`); ld.value=lbl; ld.font=fn; ld.alignment=left;
    const ad=ws1.getCell(`E${row}`); ad.value=amt; ad.numFmt='"₱"#,##0.00'; ad.font=fn; ad.alignment=right;
  });

  // Top items
  ws1.getRow(14).height = 8;
  ws1.getRow(15).height = 20;
  ws1.mergeCells('A15:F15');
  const ti = ws1.getCell('A15');
  ti.value='TOP 5 ITEMS'; ti.font=hdrFont; ti.fill=fill(FOREST2); ti.alignment=left;
  ['ITEM','QTY','REVENUE'].forEach((h,i)=>{
    const c=ws1.getCell(`${['A','B','C'][i]}16`);
    c.value=h; c.font=hdrFont; c.fill=fill(GOLD); c.alignment=center;
    ws1.getRow(16).height=18;
  });
  (r.topItems||[]).forEach((it,i)=>{
    const row=17+i; ws1.getRow(row).height=16;
    const bg = fill(i%2===0?'EEF0EB':'FFFFFF');
    const ia=ws1.getCell(`A${row}`); ia.value=it.name; ia.font=bodyFont; ia.fill=bg; ia.alignment={horizontal:'left',indent:1};
    const iq=ws1.getCell(`B${row}`); iq.value=it.qty; iq.font=bodyFont; iq.fill=bg; iq.alignment=center;
    const ir=ws1.getCell(`C${row}`); ir.value=parseFloat(it.revenue||0); ir.numFmt='"₱"#,##0.00'; ir.font=bodyFont; ir.fill=bg; ir.alignment=right;
  });

  // ════════════════════════════════════════════════════════════════════════
  // SHEET 2 — ALL ORDERS
  // ════════════════════════════════════════════════════════════════════════
  const ws2 = wb.addWorksheet('All Orders');
  ws2.views=[{showGridLines:false}];
  ws2.columns=[
    {width:14},{width:10},{width:20},{width:7},{width:12},{width:13},{width:10},{width:12},{width:12},{width:12},{width:12}
  ];

  ws2.mergeCells('A1:K1');
  const w2t = ws2.getCell('A1');
  w2t.value=`YANI GARDEN CAFE — All Orders | ${r.dateLabel}`;
  w2t.font={name:'Arial',size:13,bold:true,color:{argb:'FFFFFFFF'}};
  w2t.fill=fill(FOREST); w2t.alignment=center; ws2.getRow(1).height=28;

  const oh2=['Order ID','Time','Customer','Table','Type','Status','Payment','Subtotal','Svc Charge','Discount','Total'];
  const hw2=ws2.addRow(oh2); ws2.getRow(2).height=20;
  hw2.eachCell(c=>{c.font=hdrFont;c.fill=fill(FOREST2);c.alignment=center;c.border=thinBorder;});

  (r.orders||[]).forEach(o=>{
    const isDone=o.status==='COMPLETED', isCanc=o.status==='CANCELLED';
    const rf=fill(isDone?'E8F5E9':isCanc?'FDECEA':'FFFFFF');
    const fn={name:'Arial',size:9,bold:isDone,color:{argb:isDone?'FF1B5E20':isCanc?'FFB71C1C':'FF1E3530'}};
    const row=ws2.addRow([
      o.order_id, phtTime(o.created_at), o.customer_name||'Guest',
      o.table_no||'', o.order_type||'', o.status,
      o.payment_method||'—',
      parseFloat(o.subtotal||0), parseFloat(o.service_charge||0),
      parseFloat(o.discount_amount||0), getAmt(o),
    ]);
    row.height=16;
    row.eachCell((c,ci)=>{
      c.font=fn; c.fill=rf; c.border=thinBorder;
      if(ci>=8){c.numFmt=numFmt;c.alignment=right;}
      else if(ci===4||ci===6||ci===7){c.alignment=center;}
      else{c.alignment={horizontal:'left',indent:1};}
    });
  });

  // Totals row
  const tr2=ws2.addRow(['COMPLETED TOTALS','','','','','','',totalSubtotal,totalSvc,totalDiscount,totalSales]);
  tr2.height=20;
  tr2.eachCell((c,ci)=>{
    c.font=whtFont; c.fill=fill(FOREST);
    if(ci>=8){c.numFmt=numFmt;c.alignment=right;}
    else{c.alignment={horizontal:'right',indent:1};}
  });
  ws2.mergeCells(`A${tr2.number}:G${tr2.number}`);

  // ════════════════════════════════════════════════════════════════════════
  // SHEET 3 — COMPLETED ORDERS
  // ════════════════════════════════════════════════════════════════════════
  const ws3=wb.addWorksheet('Completed Orders');
  ws3.views=[{showGridLines:false}];
  ws3.columns=[
    {width:14},{width:10},{width:22},{width:7},{width:10},{width:12},{width:12},{width:12},{width:12},{width:12},{width:55}
  ];

  ws3.mergeCells('A1:K1');
  const w3t=ws3.getCell('A1');
  w3t.value=`YANI GARDEN CAFE — Completed Orders | ${r.dateLabel}`;
  w3t.font={name:'Arial',size:13,bold:true,color:{argb:'FFFFFFFF'}};
  w3t.fill=fill(FOREST); w3t.alignment=center; ws3.getRow(1).height=28;

  const oh3=['Order ID','Time','Customer','Table','Payment','Subtotal','Svc Charge','Discount','Total','Disc. Type','Items'];
  const hw3=ws3.addRow(oh3); ws3.getRow(2).height=20;
  hw3.eachCell(c=>{c.font=hdrFont;c.fill=fill(FOREST2);c.alignment=center;c.border=thinBorder;});

  completed.forEach((o,i)=>{
    const rf=fill(i%2===0?'E8F5E9':'FFFFFF');
    const row=ws3.addRow([
      o.order_id, phtTime(o.created_at), o.customer_name||'Guest', o.table_no||'',
      o.payment_method||'', parseFloat(o.subtotal||0), parseFloat(o.service_charge||0),
      parseFloat(o.discount_amount||0)||'', getAmt(o),
      o.discount_type||'', o.items_text||'',
    ]);
    row.height=28;
    row.eachCell((c,ci)=>{
      c.font=bodyFont; c.fill=rf; c.border=thinBorder;
      if(ci>=6&&ci<=9){c.numFmt=numFmt;c.alignment=right;}
      else if(ci===11){c.alignment={horizontal:'left',wrapText:true,indent:1};}
      else if(ci===4||ci===5||ci===10){c.alignment=center;}
      else{c.alignment={horizontal:'left',indent:1};}
      if(ci===8&&parseFloat(o.discount_amount||0)>0){c.font={...bodyFont,color:{argb:'FFB71C1C'}};}
    });
  });

  const tr3=ws3.addRow([`TOTAL  (${completed.length} orders)`,'','','','',totalSubtotal,totalSvc,totalDiscount,totalSales,'','']);
  tr3.height=22;
  tr3.eachCell((c,ci)=>{
    c.font=whtFont; c.fill=fill(FOREST);
    if(ci>=6&&ci<=9){c.numFmt=numFmt;c.alignment=right;}
    else{c.alignment={horizontal:'right',indent:1};}
  });
  ws3.mergeCells(`A${tr3.number}:E${tr3.number}`);

  // ════════════════════════════════════════════════════════════════════════
  // SHEET 4 — CANCELLED ORDERS
  // ════════════════════════════════════════════════════════════════════════
  const ws4=wb.addWorksheet('Cancelled Orders');
  ws4.views=[{showGridLines:false}];
  ws4.columns=[{width:14},{width:10},{width:22},{width:7},{width:14},{width:55}];

  ws4.mergeCells('A1:F1');
  const w4t=ws4.getCell('A1');
  w4t.value=`YANI GARDEN CAFE — Cancelled Orders | ${r.dateLabel}`;
  w4t.font={name:'Arial',size:13,bold:true,color:{argb:'FFFFFFFF'}};
  w4t.fill=fill('C0392B'); w4t.alignment=center; ws4.getRow(1).height=28;

  const oh4=['Order ID','Time','Customer','Table','Order Total','Items'];
  const hw4=ws4.addRow(oh4); ws4.getRow(2).height=20;
  hw4.eachCell(c=>{c.font=hdrFont;c.fill=fill('C0392B');c.alignment=center;c.border=thinBorder;});

  cancelled.forEach(o=>{
    const row=ws4.addRow([
      o.order_id, phtTime(o.created_at), o.customer_name||'Guest',
      o.table_no||'', parseFloat(o.total||0), o.items_text||'',
    ]);
    row.height=28;
    row.eachCell((c,ci)=>{
      c.font={name:'Arial',size:9,color:{argb:'FFB71C1C'}};
      c.fill=fill('FDECEA'); c.border=thinBorder;
      if(ci===5){c.numFmt=numFmt;c.alignment=right;}
      else if(ci===6){c.alignment={horizontal:'left',wrapText:true,indent:1};}
      else if(ci===4){c.alignment=center;}
      else{c.alignment={horizontal:'left',indent:1};}
    });
  });

  // ── Write to buffer → base64 ────────────────────────────────────────────
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf).toString('base64');
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
    try { xlsxBase64 = await buildXlsx(report); } catch(xlsxErr) { console.error('xlsx gen failed:', xlsxErr.message); }
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
