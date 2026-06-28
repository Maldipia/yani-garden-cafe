// ── Receipt HTML builder + email sender ───────────────────────────────────
import { BUSINESS_NAME, FROM_EMAIL, RESEND_KEY } from './config.js';

export function buildReceiptHTML({ order, items, isBIR }) {
  const fmt = (n) => `₱${parseFloat(n||0).toFixed(2)}`;
  const phTime = new Date(order.created_at || Date.now())
    .toLocaleString('en-PH', { timeZone:'Asia/Manila', dateStyle:'medium', timeStyle:'short' });

  const itemRows = (items || []).map(it => {
    const sub = [];
    if (it.size_choice)  sub.push(it.size_choice);
    if (it.sugar_choice) sub.push(it.sugar_choice);
    const subLine = sub.length ? `<div style="font-size:11px;color:#888">${sub.join(' · ')}</div>` : '';
    return `
      <tr>
        <td style="padding:6px 0;border-bottom:1px solid #f0f0f0">
          <div style="font-weight:600">${it.item_name}</div>${subLine}
        </td>
        <td style="padding:6px 0;border-bottom:1px solid #f0f0f0;text-align:center">${it.qty}</td>
        <td style="padding:6px 0;border-bottom:1px solid #f0f0f0;text-align:right">${fmt(it.unit_price)}</td>
        <td style="padding:6px 0;border-bottom:1px solid #f0f0f0;text-align:right">${fmt(it.line_total)}</td>
      </tr>`;
  }).join('');

  const discountRow = (order.discount_amount > 0) ? `
    <tr>
      <td colspan="2" style="text-align:right;padding:4px 0;font-size:13px">
        ${order.discount_type === 'YANI_CARD' ? '🌿 Yani Card (10%)' : order.discount_type === 'PWD' ? 'PWD Discount' : order.discount_type === 'SENIOR' ? 'Senior Discount' : (order.discount_type || 'Discount')}${order.discount_pax > 0 ? ` (${order.discount_pax} pax)` : ''}:
      </td>
      <td colspan="2" style="text-align:right;padding:4px 0;font-size:13px;color:#DC2626">
        -${fmt(order.discount_amount)}
      </td>
    </tr>
    <tr>
      <td colspan="2" style="text-align:right;padding:4px 0;font-weight:700">TOTAL PAID:</td>
      <td colspan="2" style="text-align:right;padding:4px 0;font-weight:700">${fmt(order.discounted_total || order.total)}</td>
    </tr>` : `
    <tr>
      <td colspan="2" style="text-align:right;padding:4px 0;font-weight:700">TOTAL:</td>
      <td colspan="2" style="text-align:right;padding:4px 0;font-weight:700">${fmt(order.total)}</td>
    </tr>`;

  const vatLine = order.vat_amount > 0 ? `
    <tr>
      <td colspan="2" style="text-align:right;padding:2px 0;font-size:12px;color:#888">VAT (incl.):</td>
      <td colspan="2" style="text-align:right;padding:2px 0;font-size:12px;color:#888">${fmt(order.vat_amount)}</td>
    </tr>` : `<tr><td colspan="4" style="text-align:right;padding:2px 0;font-size:11px;color:#aaa">This is a Non-VAT receipt</td></tr>`;

  const birSection = isBIR && order.receipt_name ? `
    <div style="background:#f9f9f9;border:1px solid #e5e5e5;border-radius:8px;padding:12px;margin-bottom:16px;font-size:13px">
      <div style="font-weight:700;margin-bottom:6px;color:#374151">Issued to:</div>
      <div>${order.receipt_name}</div>
      ${order.receipt_address ? `<div>${order.receipt_address}</div>` : ''}
      ${order.receipt_tin ? `<div>TIN: ${order.receipt_tin}</div>` : ''}
    </div>` : '';

  const receiptLabel = isBIR ? 'OFFICIAL RECEIPT' : 'SALES INVOICE';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${receiptLabel} - ${order.order_id}</title></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
  <div style="max-width:480px;margin:20px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.12)">
    <div style="background:#1a3a2a;padding:24px;text-align:center">
      <div style="color:#a3d9a5;font-size:24px;font-weight:800;letter-spacing:1px">${BUSINESS_NAME.toUpperCase()}</div>
      <div style="color:#c8e6c9;font-size:12px;margin-top:4px">Amadeo, Cavite</div>
      <div style="color:#fff;font-size:18px;font-weight:700;margin-top:12px;background:rgba(255,255,255,.15);padding:6px 16px;border-radius:20px;display:inline-block">${receiptLabel}</div>
    </div>
    <div style="padding:20px">
      <div style="display:flex;justify-content:space-between;font-size:13px;color:#6b7280;margin-bottom:16px;flex-wrap:wrap;gap:8px">
        <div><strong>Order:</strong> ${order.order_id}</div>
        <div><strong>Table:</strong> ${order.table_no || '-'}</div>
        <div><strong>Type:</strong> ${order.order_type || 'DINE-IN'}</div>
        <div><strong>Date:</strong> ${phTime}</div>
      </div>
      ${birSection}
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="border-bottom:2px solid #e5e7eb">
            <th style="text-align:left;padding:6px 0;color:#374151">Item</th>
            <th style="text-align:center;padding:6px 0;color:#374151">Qty</th>
            <th style="text-align:right;padding:6px 0;color:#374151">Price</th>
            <th style="text-align:right;padding:6px 0;color:#374151">Total</th>
          </tr>
        </thead>
        <tbody>${itemRows}</tbody>
        <tfoot>
          <tr><td colspan="4" style="padding:8px 0"></td></tr>
          <tr>
            <td colspan="2" style="text-align:right;padding:3px 0;font-size:13px;color:#6b7280">Subtotal:</td>
            <td colspan="2" style="text-align:right;padding:3px 0;font-size:13px">${fmt(order.subtotal)}</td>
          </tr>
          <tr>
            <td colspan="2" style="text-align:right;padding:3px 0;font-size:13px;color:#6b7280">${parseFloat(order.service_charge||0)===0 ? 'Service Charge:' : (String(order.order_type||'').toUpperCase().includes('TAKE') ? 'Packaging Fee (10%):' : 'Service Charge (10%):')}</td>
            <td colspan="2" style="text-align:right;padding:3px 0;font-size:13px;color:${parseFloat(order.service_charge||0)===0 ? '#16a34a' : 'inherit'}">${parseFloat(order.service_charge||0)===0 ? '<em>Waived</em>' : fmt(order.service_charge)}</td>
          </tr>
          ${vatLine}
          ${discountRow}
        </tfoot>
      </table>
      <div style="margin-top:20px;padding-top:16px;border-top:1px dashed #e5e7eb;text-align:center;color:#9ca3af;font-size:12px">
        <div style="margin-bottom:4px">Thank you for visiting ${BUSINESS_NAME}! 🌿</div>
        <div>Please come again ♥</div>
        ${isBIR ? '<div style="margin-top:8px;font-size:11px">This serves as your Official Receipt for tax purposes.</div>' : ''}
      </div>
    </div>
  </div>
</body>
</html>`;
}

export async function sendReceiptEmail({ toEmail, order, items, isBIR }) {
  if (!RESEND_KEY) throw new Error('Email service not configured');
  if (!toEmail)   throw new Error('No email address provided');
  const receiptType = isBIR ? 'Official Receipt' : 'Sales Invoice';
  const html = buildReceiptHTML({ order, items, isBIR });
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from:    `${BUSINESS_NAME} <${FROM_EMAIL}>`,
      to:      [toEmail],
      subject: `Your ${receiptType} — ${order.order_id} | ${BUSINESS_NAME}`,
      html,
    }),
  });
  const result = await resp.json();
  if (!resp.ok) throw new Error(result.message || 'Resend API error');
  return result.id;
}
