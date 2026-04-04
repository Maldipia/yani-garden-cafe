// Weekly & Monthly Sales Report
// Cron 1: Every Monday 6 AM PHT (Sunday 22:00 UTC) → sends WEEKLY report (Mon-Sun)
// Cron 2: 1st of month 6 AM PHT → sends MONTHLY report (full previous month)
// Manual trigger: POST { secret, type: 'weekly'|'monthly' }
import ExcelJS from 'exceljs';

const SUPABASE_URL  = process.env.SUPABASE_URL || 'https://hnynvclpvfxzlfjphefj.supabase.co';
const SUPABASE_KEY  = (() => { const k = process.env.SUPABASE_SECRET_KEY; return k && k.startsWith('ey') ? k : process.env.SUPABASE_ANON_KEY || k; })();
const RESEND_KEY    = process.env.RESEND_API_KEY;
const REPORT_EMAIL  = process.env.REPORT_EMAIL  || 'tygfsb@gmail.com';
const FROM_EMAIL    = process.env.REPORT_FROM   || 'noreply@yanigardencafe.com';
const REPORT_SECRET = process.env.REPORT_SECRET || process.env.CRON_SECRET || '';
const PHT = 8 * 3600000; // UTC+8 offset in ms

async function supaFetch(path, params = {}, method = 'GET') {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const opts = {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
  };
  if (method !== 'GET') opts.body = JSON.stringify(params);
  const r = await fetch(url, opts);
  const data = r.ok ? await r.json() : null;
  return { ok: r.ok, data };
}

// ── Date helpers (6 AM PHT business day boundary) ─────────────────────────
function bizDayDate(isoStr) {
  // Returns YYYY-MM-DD in PHT, adjusted for 6AM boundary
  const d = new Date(new Date(isoStr).getTime() + PHT);
  if (d.getUTCHours() < 6) d.setTime(d.getTime() - 86400000);
  return d.toISOString().slice(0, 10);
}

function phtTime(isoStr) {
  try {
    const d = new Date(new Date(isoStr).getTime() + PHT);
    const h = d.getUTCHours(), m = String(d.getUTCMinutes()).padStart(2,'0');
    return `${String(h%12||12).padStart(2,'0')}:${m} ${h>=12?'PM':'AM'}`;
  } catch(_) { return ''; }
}

// ── Fetch orders for a date range ─────────────────────────────────────────
async function fetchOrders(startISO, endISO) {
  const ordersR = await supaFetch(
    `dine_in_orders?created_at=gte.${startISO}&created_at=lt.${endISO}&is_deleted=eq.false&is_test=eq.false` +
    `&select=order_id,status,total,discounted_total,discount_type,discount_amount,order_type,payment_method,created_at,customer_name,table_no,subtotal,service_charge` +
    `&order=created_at.asc`
  );
  const orders = ordersR.data || [];

  // Attach item text
  if (orders.length > 0) {
    const ids = orders.map(o => `"${o.order_id}"`).join(',');
    const itemsR = await supaFetch(
      `dine_in_order_items?order_id=in.(${ids})&select=order_id,item_name,qty,size_choice,sugar_choice`
    );
    if (itemsR.ok && itemsR.data) {
      const byOrder = {};
      itemsR.data.forEach(it => {
        if (!byOrder[it.order_id]) byOrder[it.order_id] = [];
        const opts = [it.size_choice, it.sugar_choice].filter(Boolean).join(' | ');
        byOrder[it.order_id].push(`${it.item_name} x${it.qty}${opts?' ('+opts+')':''}`);
      });
      orders.forEach(o => { o.items_text = (byOrder[o.order_id]||[]).join(' | '); });
    }
  }
  return orders;
}

// ── Build Excel workbook ───────────────────────────────────────────────────
async function buildXlsx(orders, periodLabel, dayBreakdown) {
  const FOREST='314C47', FOREST2='3D5E57', GOLD='B8973A';
  const fill = hex => ({type:'pattern',pattern:'solid',fgColor:{argb:'FF'+hex}});
  const hf   = (sz=10,bold=true) => ({name:'Arial',size:sz,bold,color:{argb:'FFFFFFFF'}});
  const bf   = (sz=9,bold=false) => ({name:'Arial',size:sz,bold,color:{argb:'FF1E3530'}});
  const wf   = (sz=10) => ({name:'Arial',size:sz,bold:true,color:{argb:'FFFFFFFF'}});
  const thin = {style:'thin',color:{argb:'FFCCCCCC'}};
  const bdr  = {top:thin,bottom:thin,left:thin,right:thin};
  const ctr  = {horizontal:'center',vertical:'center'};
  const rgt  = {horizontal:'right',vertical:'center'};
  const lft  = {horizontal:'left',vertical:'center',indent:1};
  const peso = '"₱"#,##0.00';

  const completed = orders.filter(o=>o.status==='COMPLETED');
  const cancelled = orders.filter(o=>o.status==='CANCELLED');
  const getAmt = o => parseFloat(o.discounted_total||o.total||0);
  const totalSales = completed.reduce((s,o)=>s+getAmt(o),0);
  const cashAmt  = completed.filter(o=>o.payment_method==='CASH').reduce((s,o)=>s+getAmt(o),0);
  const gcashAmt = completed.filter(o=>o.payment_method==='GCASH').reduce((s,o)=>s+getAmt(o),0);
  const cardAmt  = completed.filter(o=>o.payment_method==='CARD').reduce((s,o)=>s+getAmt(o),0);
  const otherAmt = totalSales - cashAmt - gcashAmt - cardAmt;

  const wb = new ExcelJS.Workbook();

  // ── Sheet 1: Summary ──────────────────────────────────────────────────
  const ws1 = wb.addWorksheet('Summary');
  ws1.views = [{showGridLines:false}];
  ws1.columns = [{width:26},{width:16},{width:16},{width:16},{width:4},{width:16},{width:16},{width:16}];

  ws1.mergeCells('A1:H1');
  Object.assign(ws1.getCell('A1'), {value:'YANI GARDEN CAFE', font:{name:'Arial',size:18,bold:true,color:{argb:'FFFFFFFF'}}, fill:fill(FOREST), alignment:ctr});
  ws1.getRow(1).height=36;

  ws1.mergeCells('A2:H2');
  Object.assign(ws1.getCell('A2'), {value:`${periodLabel}`, font:hf(11,false), fill:fill(FOREST2), alignment:ctr});
  ws1.getRow(2).height=22;
  ws1.getRow(3).height=8;

  // Stat cards
  const statL=['TOTAL SALES','COMPLETED ORDERS','CANCELLED ORDERS','AVG ORDER VALUE'];
  const statV=[totalSales,completed.length,cancelled.length,completed.length?totalSales/completed.length:0];
  const statS=['','orders','cancelled','per order'];
  ['A','B','C','D'].forEach((col,i)=>{
    ws1.getRow(4).height=14; ws1.getRow(5).height=30; ws1.getRow(6).height=18;
    const lc=ws1.getCell(`${col}4`); lc.value=statL[i]; lc.font={name:'Arial',size:8,bold:true,color:{argb:'FF888888'}}; lc.fill=fill('F5F5F5'); lc.alignment=ctr;
    const vc=ws1.getCell(`${col}5`); vc.value=statV[i];
    if(i===0||i===3){vc.numFmt=peso;}
    vc.font={name:'Arial',size:14,bold:true,color:{argb:i===0?'FF'+FOREST:'FF1E3530'}}; vc.fill=fill('FFFFFF'); vc.alignment=ctr;
    const sc=ws1.getCell(`${col}6`); sc.value=statS[i]; sc.font={name:'Arial',size:8,color:{argb:'FF666666'}}; sc.fill=fill('FFFFFF'); sc.alignment=ctr;
  });

  ws1.getRow(7).height=8;
  ws1.getRow(8).height=20;
  ws1.mergeCells('A8:D8');
  Object.assign(ws1.getCell('A8'),{value:'PAYMENT BREAKDOWN',font:hf(),fill:fill(GOLD),alignment:lft});
  ws1.mergeCells('F8:H8');
  Object.assign(ws1.getCell('F8'),{value:'SALES BY ORDER TYPE',font:hf(),fill:fill(GOLD),alignment:lft});

  [['Cash',cashAmt,completed.filter(o=>o.payment_method==='CASH').length],
   ['GCash / QR',gcashAmt,completed.filter(o=>o.payment_method==='GCASH').length],
   ['Card',cardAmt,completed.filter(o=>o.payment_method==='CARD').length],
   ['Other / Unknown',otherAmt,completed.filter(o=>!['CASH','GCASH','CARD'].includes(o.payment_method)).length],
   ['TOTAL',totalSales,completed.length]].forEach(([lbl,amt,cnt],i)=>{
    const row=9+i; ws1.getRow(row).height=18; const isT=lbl==='TOTAL';
    const f=fill(isT?FOREST:'EEF0EB');
    ['A','B','C','D'].forEach(c=>ws1.getCell(`${c}${row}`).fill=f);
    const la=ws1.getCell(`A${row}`); la.value=lbl; la.font=isT?wf():bf(9,true); la.alignment=lft;
    const cb=ws1.getCell(`B${row}`); cb.value=cnt; cb.font=isT?wf():bf(); cb.alignment=ctr;
    const ca=ws1.getCell(`C${row}`); ca.value=amt; ca.numFmt=peso; ca.font=isT?wf():bf(); ca.alignment=rgt;
    const cp=ws1.getCell(`D${row}`); cp.value=totalSales>0?amt/totalSales:0; cp.numFmt='0.0%'; cp.font=isT?wf():bf(); cp.alignment=ctr;
  });

  const dineIn = completed.filter(o=>o.order_type==='DINE-IN');
  const takeOut = completed.filter(o=>o.order_type==='TAKE-OUT');
  [['Dine-In',dineIn.length,dineIn.reduce((s,o)=>s+getAmt(o),0)],
   ['Take-Out',takeOut.length,takeOut.reduce((s,o)=>s+getAmt(o),0)]].forEach(([lbl,cnt,amt],i)=>{
    const row=9+i; const f=fill('EEF0EB');
    ['F','G','H'].forEach(c=>ws1.getCell(`${c}${row}`).fill=f);
    const lf=ws1.getCell(`F${row}`); lf.value=lbl; lf.font=bf(9,true); lf.alignment=lft;
    const cf=ws1.getCell(`G${row}`); cf.value=cnt; cf.font=bf(); cf.alignment=ctr;
    const af=ws1.getCell(`H${row}`); af.value=amt; af.numFmt=peso; af.font=bf(); af.alignment=rgt;
  });

  // Day-by-day breakdown
  if (dayBreakdown && dayBreakdown.length > 0) {
    ws1.getRow(15).height=8;
    ws1.getRow(16).height=20;
    ws1.mergeCells('A16:H16');
    Object.assign(ws1.getCell('A16'),{value:'DAILY BREAKDOWN',font:hf(),fill:fill(FOREST2),alignment:lft});
    const dayHdrs=['Date','Completed','Cancelled','Cash','GCash','Card','Total Sales','Avg Order'];
    const dhr=ws1.addRow(dayHdrs); ws1.getRow(17).height=18;
    dhr.eachCell(c=>{c.font=hf(9);c.fill=fill(FOREST2);c.alignment=ctr;c.border=bdr;});
    dayBreakdown.forEach((d,i)=>{
      const row=ws1.addRow([
        d.date, d.completed, d.cancelled, d.cash, d.gcash, d.card, d.total, d.avg
      ]);
      row.height=16;
      row.eachCell((c,ci)=>{
        c.fill=fill(i%2===0?'EEF0EB':'FFFFFF'); c.font=bf(); c.border=bdr;
        if(ci>=4){c.numFmt=peso;c.alignment=rgt;}
        else if(ci>=2){c.alignment=ctr;}
        else{c.alignment=lft;}
      });
    });
    // Totals
    const totRow=ws1.addRow(['TOTAL',completed.length,cancelled.length,cashAmt,gcashAmt,cardAmt,totalSales,completed.length?totalSales/completed.length:0]);
    totRow.height=20;
    totRow.eachCell((c,ci)=>{
      c.font=wf(); c.fill=fill(FOREST);
      if(ci>=4){c.numFmt=peso;c.alignment=rgt;}
      else if(ci>=2){c.alignment=ctr;}
      else{c.alignment=lft;}
    });
  }

  // ── Sheet 2: All Orders ───────────────────────────────────────────────
  const ws2=wb.addWorksheet('All Orders');
  ws2.views=[{showGridLines:false}];
  ws2.columns=[{width:14},{width:11},{width:9},{width:20},{width:7},{width:12},{width:13},{width:10},{width:12},{width:12},{width:12},{width:12},{width:55}];
  ws2.mergeCells('A1:M1');
  Object.assign(ws2.getCell('A1'),{value:`YANI GARDEN CAFE — All Orders | ${periodLabel}`,font:{name:'Arial',size:13,bold:true,color:{argb:'FFFFFFFF'}},fill:fill(FOREST),alignment:ctr});
  ws2.getRow(1).height=28;

  const hdrs=['Biz Day','Order ID','Time','Customer','Table','Type','Status','Payment','Subtotal','Svc','Discount','Total','Items'];
  const hr=ws2.addRow(hdrs); ws2.getRow(2).height=18;
  hr.eachCell(c=>{c.font=hf(9);c.fill=fill(FOREST2);c.alignment=ctr;c.border=bdr;});

  orders.forEach(o=>{
    const isDone=o.status==='COMPLETED', isCanc=o.status==='CANCELLED';
    const rfHex=isDone?'C8E6C9':isCanc?'FFCDD2':'FFFFFF';
    const fn={name:'Arial',size:9,bold:isDone,color:{argb:isDone?'FF1B5E20':isCanc?'FFB71C1C':'FF1E3530'}};
    const row=ws2.addRow([
      bizDayDate(o.created_at),o.order_id,phtTime(o.created_at),o.customer_name||'Guest',
      o.table_no||'',o.order_type||'',o.status,o.payment_method||'—',
      parseFloat(o.subtotal||0),parseFloat(o.service_charge||0),
      parseFloat(o.discount_amount||0)||'',getAmt(o),o.items_text||'',
    ]);
    row.height=28;
    row.eachCell((c,ci)=>{
      c.font=fn; c.fill=fill(rfHex); c.border=bdr;
      if(ci>=9&&ci<=12){c.numFmt=peso;c.alignment=rgt;}
      else if(ci===13){c.alignment={horizontal:'left',wrapText:true,indent:1};}
      else if([5,6,7,8].includes(ci)){c.alignment=ctr;}
      else{c.alignment=lft;}
    });
  });

  const totalSubtotal=completed.reduce((s,o)=>s+parseFloat(o.subtotal||0),0);
  const totalSvc=completed.reduce((s,o)=>s+parseFloat(o.service_charge||0),0);
  const totalDisc=completed.reduce((s,o)=>s+parseFloat(o.discount_amount||0),0);
  const tr=ws2.addRow([`TOTAL (${completed.length} completed)`,...Array(7).fill(''),totalSubtotal,totalSvc,totalDisc,totalSales,'']);
  tr.height=22; ws2.mergeCells(`A${tr.number}:H${tr.number}`);
  tr.eachCell((c,ci)=>{c.font=wf();c.fill=fill(FOREST);if(ci>=9&&ci<=12){c.numFmt=peso;c.alignment=rgt;}else{c.alignment={horizontal:'right',indent:1};}});

  const buf=await wb.xlsx.writeBuffer();
  return Buffer.from(buf).toString('base64');
}

// ── Build email HTML ───────────────────────────────────────────────────────
function buildEmailHTML(orders, periodLabel, type, dayBreakdown) {
  const completed = orders.filter(o=>o.status==='COMPLETED');
  const cancelled = orders.filter(o=>o.status==='CANCELLED');
  const getAmt = o => parseFloat(o.discounted_total||o.total||0);
  const totalSales = completed.reduce((s,o)=>s+getAmt(o),0);
  const cashAmt  = completed.filter(o=>o.payment_method==='CASH').reduce((s,o)=>s+getAmt(o),0);
  const gcashAmt = completed.filter(o=>o.payment_method==='GCASH').reduce((s,o)=>s+getAmt(o),0);
  const cardAmt  = completed.filter(o=>o.payment_method==='CARD').reduce((s,o)=>s+getAmt(o),0);
  const fmt = n => '₱' + parseFloat(n).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2});
  const icon = type==='monthly' ? '📅' : '📊';

  const dayRows = (dayBreakdown||[]).map(d=>`
    <tr style="border-bottom:1px solid #f0f0f0;">
      <td style="padding:8px 16px;font-weight:600;">${d.date}</td>
      <td style="padding:8px 16px;text-align:center;">${d.completed}</td>
      <td style="padding:8px 16px;text-align:right;color:#16a34a;font-weight:700;">${fmt(d.total)}</td>
      <td style="padding:8px 16px;text-align:right;">${fmt(d.avg)}</td>
    </tr>`).join('');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:20px;background:#f8fafc;font-family:Arial,sans-serif;">
<table width="600" cellpadding="0" cellspacing="0" style="margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08);">
  <tr><td style="background:#314C47;padding:32px 40px;text-align:center;">
    <div style="font-size:28px;font-weight:800;color:#fff;letter-spacing:-0.5px;">☕ YANI GARDEN CAFE</div>
    <div style="font-size:14px;color:rgba(255,255,255,.75);margin-top:6px;">${icon} ${type==='monthly'?'Monthly':'Weekly'} Sales Report</div>
    <div style="font-size:13px;color:rgba(255,255,255,.6);margin-top:4px;">${periodLabel}</div>
  </td></tr>

  <tr><td style="padding:32px 40px;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td width="48%" style="background:#f0fdf4;border-radius:10px;padding:20px;text-align:center;">
          <div style="font-size:28px;font-weight:800;color:#314C47;">${fmt(totalSales)}</div>
          <div style="font-size:12px;color:#6b7280;margin-top:4px;">TOTAL SALES</div>
        </td>
        <td width="4%"></td>
        <td width="48%" style="background:#fff7ed;border-radius:10px;padding:20px;text-align:center;">
          <div style="font-size:28px;font-weight:800;color:#b8973a;">${completed.length}</div>
          <div style="font-size:12px;color:#6b7280;margin-top:4px;">COMPLETED ORDERS</div>
        </td>
      </tr>
    </table>

    <div style="margin:24px 0;display:flex;gap:12px;">
      <div style="flex:1;background:#f8fafc;border-radius:8px;padding:14px;text-align:center;">
        <div style="font-size:18px;font-weight:700;color:#1e3530;">${fmt(cashAmt)}</div>
        <div style="font-size:11px;color:#6b7280;margin-top:2px;">💵 Cash</div>
      </div>
      <div style="flex:1;background:#f8fafc;border-radius:8px;padding:14px;text-align:center;">
        <div style="font-size:18px;font-weight:700;color:#1e3530;">${fmt(gcashAmt)}</div>
        <div style="font-size:11px;color:#6b7280;margin-top:2px;">📱 GCash</div>
      </div>
      <div style="flex:1;background:#f8fafc;border-radius:8px;padding:14px;text-align:center;">
        <div style="font-size:18px;font-weight:700;color:#1e3530;">${fmt(cardAmt)}</div>
        <div style="font-size:11px;color:#6b7280;margin-top:2px;">💳 Card</div>
      </div>
    </div>

    ${dayRows ? `
    <div style="margin-top:24px;">
      <div style="font-size:13px;font-weight:700;color:#314C47;margin-bottom:12px;text-transform:uppercase;letter-spacing:.5px;">Daily Breakdown</div>
      <table width="100%" style="border-collapse:collapse;border-radius:8px;overflow:hidden;">
        <tr style="background:#314C47;">
          <th style="padding:10px 16px;text-align:left;color:#fff;font-size:12px;">Date</th>
          <th style="padding:10px 16px;text-align:center;color:#fff;font-size:12px;">Orders</th>
          <th style="padding:10px 16px;text-align:right;color:#fff;font-size:12px;">Sales</th>
          <th style="padding:10px 16px;text-align:right;color:#fff;font-size:12px;">Avg</th>
        </tr>
        ${dayRows}
      </table>
    </div>` : ''}

    <div style="margin-top:20px;font-size:12px;color:#6b7280;text-align:center;">
      ${cancelled.length} cancelled orders not included in totals<br>
      Avg order value: ${fmt(completed.length ? totalSales/completed.length : 0)}
    </div>
  </td></tr>

  <tr><td style="background:#f8fafc;padding:20px 40px;text-align:center;border-top:1px solid #e2e8f0;">
    <p style="margin:0;color:#94a3b8;font-size:12px;">☕ YANI Garden Cafe · Amadeo, Cavite<br>
    This is an automated ${type} report. Excel file attached.</p>
  </td></tr>
</table></body></html>`;
}

// ── Main handler ───────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

  const cronAuth = req.headers['authorization'];
  const body = req.method==='POST' ? (req.body||{}) : {};
  const cronOk   = cronAuth === `Bearer ${process.env.CRON_SECRET||''}`;
  const manualOk = REPORT_SECRET && body.secret === REPORT_SECRET;
  if (!cronOk && !manualOk) return res.status(401).json({ok:false,error:'Unauthorized'});

  // Determine report type: weekly or monthly
  // Cron schedule "0 22 * * 0" = Sunday → weekly report for Mon-Sun just passed
  // Cron schedule "0 22 1 * *" = 1st of month → monthly report
  const now = new Date();
  const nowPHT = new Date(now.getTime() + PHT);
  let type = body.type || 'weekly'; // manual can specify; cron auto-detects

  if (cronOk && !body.type) {
    // Auto-detect: if today (PHT) is the 1st, it's monthly; else weekly
    type = nowPHT.getUTCDate() === 2 ? 'monthly' : 'weekly'; // cron fires at 10PM UTC = 6AM PHT next day
  }

  let startISO, endISO, periodLabel;
  const phDayStart = (d) => new Date(d.getTime() - PHT - (d.getUTCHours()<6?86400000:0));

  if (type === 'monthly') {
    // Previous full calendar month
    const firstOfThisMonth = new Date(Date.UTC(nowPHT.getUTCFullYear(), nowPHT.getUTCMonth(), 1));
    const firstOfLastMonth = new Date(Date.UTC(nowPHT.getUTCFullYear(), nowPHT.getUTCMonth()-1, 1));
    // 6AM PHT of first of last month = 10PM UTC of prev day
    startISO = new Date(firstOfLastMonth.getTime() - PHT + 6*3600000).toISOString();
    endISO   = new Date(firstOfThisMonth.getTime()  - PHT + 6*3600000).toISOString();
    const monthName = firstOfLastMonth.toLocaleDateString('en-PH',{month:'long',year:'numeric',timeZone:'Asia/Manila'});
    periodLabel = `Monthly Report — ${monthName}`;
  } else {
    // Previous full week Mon-Sun (6AM Mon PHT to 6AM Mon PHT)
    const dayOfWeek = nowPHT.getUTCDay(); // 0=Sun,1=Mon,...6=Sat
    // We fire on Monday 6AM PHT. Previous Monday = 7 days ago.
    const thisMon = new Date(nowPHT);
    thisMon.setUTCHours(6,0,0,0);
    const daysToMon = (dayOfWeek===1) ? 0 : (dayOfWeek===0?1:dayOfWeek-1);
    const lastMonStart = new Date(thisMon.getTime() - (7+daysToMon)*86400000);
    const lastMonEnd   = new Date(lastMonStart.getTime() + 7*86400000);
    startISO = new Date(lastMonStart.getTime() - PHT).toISOString();
    endISO   = new Date(lastMonEnd.getTime()   - PHT).toISOString();
    const s=lastMonStart.toLocaleDateString('en-PH',{month:'short',day:'numeric',timeZone:'Asia/Manila'});
    const e=new Date(lastMonEnd.getTime()-86400000).toLocaleDateString('en-PH',{month:'short',day:'numeric',year:'numeric',timeZone:'Asia/Manila'});
    periodLabel = `Weekly Report — ${s} to ${e}`;
  }

  try {
    const orders = await fetchOrders(startISO, endISO);
    const completed = orders.filter(o=>o.status==='COMPLETED');

    // Build day-by-day breakdown
    const dayMap = {};
    orders.forEach(o=>{
      const day = bizDayDate(o.created_at);
      if(!dayMap[day]) dayMap[day]={date:day,completed:0,cancelled:0,cash:0,gcash:0,card:0,total:0};
      const amt = parseFloat(o.discounted_total||o.total||0);
      if(o.status==='COMPLETED'){
        dayMap[day].completed++;
        dayMap[day].total+=amt;
        if(o.payment_method==='CASH') dayMap[day].cash+=amt;
        else if(o.payment_method==='GCASH') dayMap[day].gcash+=amt;
        else if(o.payment_method==='CARD') dayMap[day].card+=amt;
      } else if(o.status==='CANCELLED') dayMap[day].cancelled++;
    });
    const dayBreakdown = Object.values(dayMap)
      .sort((a,b)=>a.date.localeCompare(b.date))
      .map(d=>({...d, avg:d.completed?d.total/d.completed:0}));

    const html    = buildEmailHTML(orders, periodLabel, type, dayBreakdown);
    let xlsxBase64 = null;
    try { xlsxBase64 = await buildXlsx(orders, periodLabel, dayBreakdown); } catch(e) { console.error('xlsx err:',e.message); }

    const safeLabel = periodLabel.replace(/[^a-zA-Z0-9]/g,'_').replace(/_+/g,'_');
    const filename  = `YANI_${safeLabel}.xlsx`;
    const emailBody = {
      from: FROM_EMAIL,
      to: [REPORT_EMAIL],
      subject: `${type==='monthly'?'📅 Monthly':'📊 Weekly'} Report — ${periodLabel}`,
      html,
    };
    if (xlsxBase64) emailBody.attachments = [{filename, content:xlsxBase64}];

    const er = await fetch('https://api.resend.com/emails', {
      method:'POST',
      headers:{'Authorization':`Bearer ${RESEND_KEY}`,'Content-Type':'application/json'},
      body: JSON.stringify(emailBody),
    });
    const ed = await er.json();
    if (!er.ok) throw new Error(ed.message||'Resend error');

    return res.status(200).json({
      ok:true, type, periodLabel, emailId:ed.id,
      summary:{ totalOrders:orders.length, completed:completed.length, totalSales:completed.reduce((s,o)=>s+parseFloat(o.discounted_total||o.total||0),0) }
    });
  } catch(err) {
    console.error('weekly-report error:', err.message);
    return res.status(500).json({ok:false,error:err.message});
  }
}
