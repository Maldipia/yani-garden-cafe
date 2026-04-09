// api/low-stock.js — Low stock alert
// Called by Supabase cron at 8 AM and 2 PM PHT
// Also callable manually: POST { secret: CRON_SECRET }
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://hnynvclpvfxzlfjphefj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
const RESEND_KEY   = process.env.RESEND_API_KEY || '';
const REPORT_EMAIL = process.env.REPORT_EMAIL || 'tygfsb@gmail.com';
const REPORT_FROM  = process.env.REPORT_FROM  || 'YANI POS Alert <reports@yanigardencafe.com>';
const CRON_SECRET  = process.env.CRON_SECRET  || '';

const CORS = {
  'Access-Control-Allow-Origin': 'https://admin.yanigardencafe.com',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function db(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  return r.json();
}

export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k,v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  // Validate secret
  const body = req.body || {};
  const secret = body.secret || req.headers['x-cron-secret'] || '';
  if (CRON_SECRET && secret !== CRON_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    // Fetch inventory with menu item names
    const [inv, menu] = await Promise.all([
      db('inventory?select=item_code,stock_qty,low_stock_threshold,unit,auto_disable'),
      db('menu_items?select=item_code,name,is_active'),
    ]);

    const menuMap = {};
    menu.forEach(m => { menuMap[m.item_code] = { name: m.name, active: m.is_active }; });

    // Items at or below threshold
    const lowItems = inv.filter(i => {
      const qty = parseFloat(i.stock_qty ?? 0);
      const thr = parseFloat(i.low_stock_threshold ?? 0);
      return thr > 0 && qty <= thr;
    });

    const zeroItems = lowItems.filter(i => parseFloat(i.stock_qty) <= 0);

    if (lowItems.length === 0) {
      const now = new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' });
      console.log(`[${now}] Low stock check: all items OK`);
      return res.status(200).json({ ok: true, lowStock: 0, zeroStock: 0, message: 'All items OK' });
    }

    const rowBg = (qty, thr) => {
      if (qty <= 0) return '#fef2f2';
      if (qty <= thr * 0.5) return '#fff7ed';
      return '#fffbeb';
    };

    const rows = lowItems.map(i => {
      const qty  = parseFloat(i.stock_qty ?? 0);
      const thr  = parseFloat(i.low_stock_threshold ?? 0);
      const code = i.item_code;
      const name = menuMap[code]?.name ?? code;
      const active = menuMap[code]?.active ?? true;
      const badge = qty <= 0 ? '🔴 OUT OF STOCK' : qty <= thr * 0.5 ? '🟠 Critical' : '🟡 Low';
      return `<tr style="background:${rowBg(qty,thr)}">
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${name}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:center;font-weight:700">${qty} ${i.unit}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:center;color:#6b7280">${thr} ${i.unit}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${badge}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-size:12px;color:${active ? '#16a34a' : '#dc2626'}">${active ? 'Visible' : 'Hidden from menu'}</td>
      </tr>`;
    }).join('');

    const now = new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' });
    const html = `
<div style="font-family:sans-serif;max-width:680px;margin:0 auto">
  <div style="background:#78350f;color:#fff;padding:16px 24px;border-radius:8px 8px 0 0">
    <h2 style="margin:0;font-size:18px">⚠️ Low Stock Alert — ${lowItems.length} item${lowItems.length > 1 ? 's' : ''} need restocking</h2>
    <p style="margin:4px 0 0;font-size:13px;opacity:.85">${now} · YANI Garden Cafe</p>
  </div>
  <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 8px 8px">
    ${zeroItems.length > 0 ? `<div style="background:#fef2f2;border-radius:8px;padding:12px 16px;margin-bottom:20px;font-size:14px;color:#991b1b">
      <strong>${zeroItems.length} item${zeroItems.length > 1 ? 's are' : ' is'} OUT OF STOCK</strong> and automatically hidden from the customer menu.
    </div>` : ''}
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="background:#f9fafb">
        <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #e5e7eb">Item</th>
        <th style="padding:8px 12px;text-align:center;border-bottom:2px solid #e5e7eb">Current stock</th>
        <th style="padding:8px 12px;text-align:center;border-bottom:2px solid #e5e7eb">Alert threshold</th>
        <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #e5e7eb">Status</th>
        <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #e5e7eb">Menu visibility</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div style="margin-top:20px;padding:12px 16px;background:#fffbeb;border-radius:6px;font-size:13px;color:#92400e">
      <strong>To restock:</strong> Go to <a href="https://admin.yanigardencafe.com" style="color:#92400e">admin.yanigardencafe.com</a> → Inventory tab → update quantities.
    </div>
  </div>
</div>`;

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: REPORT_FROM,
        to: [REPORT_EMAIL],
        subject: `⚠️ YANI POS — ${lowItems.length} low stock item${lowItems.length > 1 ? 's' : ''}${zeroItems.length > 0 ? ` (${zeroItems.length} out of stock)` : ''}`,
        html,
      }),
    });
    const emailData = await emailRes.json();
    console.log(`[${now}] Low stock alert: ${lowItems.length} items — emailId=${emailData.id}`);

    return res.status(200).json({
      ok: true,
      lowStock: lowItems.length,
      zeroStock: zeroItems.length,
      emailId: emailData.id,
      items: lowItems.map(i => ({ code: i.item_code, name: menuMap[i.item_code]?.name, qty: parseFloat(i.stock_qty), threshold: parseFloat(i.low_stock_threshold) })),
    });

  } catch (err) {
    console.error('Low stock alert error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
