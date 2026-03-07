// ══════════════════════════════════════════════════════════════
// YANI ONLINE ORDER — Vercel Serverless API
// Connects to Supabase for online ordering platform
// Supports both GET (query params) and POST (body)
//
// Schema:
//   online_orders: id, order_ref, customer_name, customer_phone,
//     customer_email, delivery_address, delivery_notes, courier_type,
//     pickup_time, special_instructions, subtotal, total_amount,
//     payment_method, payment_proof_url, status, payment_status,
//     sms_sent, admin_notes, created_at, updated_at
//   online_order_items: id, order_id, order_ref, menu_item_id,
//     item_name, size, unit_price, quantity, subtotal, created_at
//   online_payments: id, order_id, order_ref, amount, payment_method,
//     proof_url, proof_filename, status, verified_by, verified_at,
//     rejection_reason, created_at, updated_at
// ══════════════════════════════════════════════════════════════

const SUPABASE_URL = 'https://hnynvclpvfxzlfjphefj.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_PQBb1nDY7U7SxNfgDYoXyg_GtoLowLM';
const SEMAPHORE_API_KEY = process.env.SEMAPHORE_API_KEY || '';
const SEMAPHORE_SENDER = process.env.SEMAPHORE_SENDER || 'YANI CAFE';
const GAS_URL = 'https://script.google.com/macros/s/AKfycbzprf6_LpDwcVujm8kcGFZE5JdkL0k9b6Wfg5l82gjZzFua8w1QWH8UoFFlhznc6EtL/exec';

// ── In-memory rate limiter (30 req/min per IP for order placement) ─────────────────
const _rlMap = new Map();
function checkRateLimit(ip, limit = 30) {
  const now = Date.now();
  const e = _rlMap.get(ip) || { count: 0, windowStart: now };
  if (now - e.windowStart > 60_000) { e.count = 1; e.windowStart = now; }
  else e.count++;
  _rlMap.set(ip, e);
  if (_rlMap.size > 500) { for (const [k,v] of _rlMap) { if (now - v.windowStart > 60_000) _rlMap.delete(k); } }
  return e.count <= limit;
}

// ── Input validation helpers ────────────────────────────────────────────────────
function isPhoneValid(p) { return typeof p === 'string' && /^(09|\+639)[0-9]{9}$/.test(p.replace(/\s/g,'')); }
function isNameValid(n) { return typeof n === 'string' && n.trim().length >= 2 && n.length <= 100; }
function isItemsValid(items) {
  if (!Array.isArray(items) || items.length === 0) return false;
  return items.every(i => {
    if (!i || typeof i.name !== 'string' || i.name.trim().length === 0) return false;
    // Accept id OR code (Supabase items use item_code/code)
    const hasId = (i.id !== undefined && i.id !== null) || (typeof i.code === 'string' && i.code.length > 0);
    if (!hasId) return false;
    // Accept qty OR quantity
    const qty = Number(i.qty !== undefined ? i.qty : (i.quantity !== undefined ? i.quantity : 0));
    if (qty < 1) return false;
    // Accept price OR unitPrice (allow 0 for free items/add-ons)
    const price = Number(i.price !== undefined ? i.price : (i.unitPrice !== undefined ? i.unitPrice : -1));
    if (price < 0) return false;
    return true;
  });
}

// ── Fire-and-forget GAS sync (non-blocking) ────────────────────────────────
async function callGAS(payload) {
  try {
    await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.warn('GAS sync failed (non-critical):', e.message);
  }
}

// ── Supabase REST helper ───────────────────────────────────────
async function supabase(method, path, body = null, params = null) {
  let url = `${SUPABASE_URL}/rest/v1/${path}`;
  if (params) {
    url += '?' + new URLSearchParams(params).toString();
  }
  const opts = {
    method,
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Supabase ${method} ${path} failed ${res.status}: ${text}`);
  }
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

// ── Supabase PATCH helper ──────────────────────────────────────
async function supabasePatch(path, filter, data) {
  const url = `${SUPABASE_URL}/rest/v1/${path}?${filter}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(data)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PATCH ${path} failed ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

// ── Generate order ref: YANI-OL-XXXXXX ───────────────────────
async function generateOrderRef() {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_next_online_order_ref`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json'
      },
      body: '{}'
    });
    if (res.ok) {
      const ref = await res.json();
      if (ref && typeof ref === 'string') return ref;
    }
  } catch (e) {}
  // Fallback: use timestamp
  return 'YANI-OL-' + Date.now().toString().slice(-6);
}

// ── Send SMS via Semaphore ─────────────────────────────────────
async function sendSMS(phone, message) {
  if (!SEMAPHORE_API_KEY) return { ok: false, error: 'No SMS API key configured' };
  
  let normalized = phone.replace(/\D/g, '');
  if (normalized.startsWith('0')) normalized = '63' + normalized.slice(1);
  if (normalized.startsWith('+')) normalized = normalized.slice(1);
  
  const params = new URLSearchParams({
    apikey: SEMAPHORE_API_KEY,
    number: normalized,
    message: message,
    sendername: SEMAPHORE_SENDER
  });
  
  try {
    const res = await fetch('https://api.semaphore.co/api/v4/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    const data = await res.json();
    return { ok: res.ok, data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ══════════════════════════════════════════════════════════════
// MAIN HANDLER
// ══════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  // Support both GET (query params) and POST (body)
  let action, payload;
  if (req.method === 'GET') {
    action = req.query.action;
    const { action: _a, ...rest } = req.query;
    payload = rest;
  } else {
    const body = req.body || {};
    action = body.action;
    const { action: _a, ...rest } = body;
    payload = rest;
  }
  
  if (!action) return res.status(400).json({ ok: false, error: 'Missing action' });

  // ── Rate limiting ──────────────────────────────────────────────────────────
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  // Stricter limit for order placement (10/min), relaxed for reads (60/min)
  const isWriteAction = ['placeOnlineOrder','placeOrder','updateOrderStatus','verifyPayment','rejectPayment'].includes(action);
  const rateLimit = isWriteAction ? 10 : 60;
  if (!checkRateLimit(ip, rateLimit)) {
    return res.status(429).json({ ok: false, error: 'Too many requests. Please wait a moment.' });
  }

  try {
    // ── GET MENU ──────────────────────────────────────────────
    if (action === 'getOnlineMenu' || action === 'getMenu') {
      const categories = await supabase('GET', 'menu_categories', null, {
        'order': 'display_order.asc'
      });
      const items = await supabase('GET', 'menu_items', null, {
        'is_active': 'eq.true',
        'order': 'name.asc',
        'select': 'id,item_code,name,category_id,base_price,price_short,price_medium,price_tall,has_sizes,has_sugar_levels,image_path'
      });
      
      const catMap = {};
      (categories || []).forEach(c => { catMap[c.id] = c.name; });
      
      // Deduplicate items by normalized name — keep the best entry:
      // Priority: (1) has image + proper category, (2) has image, (3) has proper category, (4) first seen
      const deduped = [];
      const seenNames = {};
      (items || []).forEach(item => {
        const key = (item.name || '').trim().toLowerCase();
        const catName = catMap[item.category_id] || null;
        const hasImage = !!(item.image_path);
        const hasCategory = !!(item.category_id);
        const score = (hasImage ? 2 : 0) + (hasCategory ? 1 : 0);
        if (seenNames[key] === undefined || score > seenNames[key].score) {
          seenNames[key] = { item, score };
        }
      });
      const dedupedItems = Object.values(seenNames).map(v => v.item);

      const grouped = {};
      const mappedItems = (dedupedItems || []).map(item => {
        const catName = catMap[item.category_id] || 'OTHER';
        if (!grouped[catName]) grouped[catName] = [];
        const mapped = {
          id: item.id,
          code: item.item_code,
          name: item.name,
          category: catName,
          price: parseFloat(item.base_price || 0),
          priceShort: item.price_short ? parseFloat(item.price_short) : null,
          priceMedium: item.price_medium ? parseFloat(item.price_medium) : null,
          priceTall: item.price_tall ? parseFloat(item.price_tall) : null,
          hasSizes: item.has_sizes,
          hasSugar: item.has_sugar_levels,
          image: item.image_path
            ? (function(p) {
                // Convert Google Drive view URL to direct image URL
                const driveMatch = p.match(/drive\.google\.com\/file\/d\/([^/]+)/);
                if (driveMatch) return 'https://drive.google.com/uc?export=view&id=' + driveMatch[1];
                // Relative path → absolute
                if (!p.startsWith('http')) return 'https://' + (req.headers.host || 'yani-garden-cafe-d3l6.vercel.app') + p;
                return p;
              })(item.image_path)
            : null
        };
        grouped[catName].push(mapped);
        return mapped;
      });
      
      return res.status(200).json({ 
        ok: true, 
        categories: categories || [], 
        items: mappedItems, 
        grouped 
      });
    }

    // ── PLACE ORDER ───────────────────────────────────────────
    if (action === 'placeOnlineOrder' || action === 'placeOrder') {
      const { 
        customerName, customerPhone, customerEmail, 
        pickupTime, specialInstructions, paymentMethod,
        deliveryAddress, deliveryNotes, courierType,
        items: orderItems, total
      } = payload;
      
      // ── Input validation ──────────────────────────────────────────────────
      if (!isNameValid(customerName)) {
        return res.status(400).json({ ok: false, error: 'Customer name must be 2-100 characters' });
      }
      if (!isPhoneValid(customerPhone)) {
        return res.status(400).json({ ok: false, error: 'Phone number must be a valid PH mobile number (09XXXXXXXXX or +639XXXXXXXXX)' });
      }
      if (!isItemsValid(orderItems)) {
        return res.status(400).json({ ok: false, error: 'Order must contain at least one valid item' });
      }
      if (orderItems.length > 50) {
        return res.status(400).json({ ok: false, error: 'Order cannot contain more than 50 items' });
      }
      
      // Calculate subtotal from items
      const subtotal = orderItems.reduce((sum, item) => {
        const price = parseFloat(item.price || item.unitPrice || 0);
        const qty = parseInt(item.qty || item.quantity || 1);
        return sum + (price * qty);
      }, 0);
      
      const orderRef = await generateOrderRef();
      
      // Insert order
      const orders = await supabase('POST', 'online_orders', {
        order_ref: orderRef,
        customer_name: customerName.trim(),
        customer_phone: customerPhone.trim(),
        customer_email: customerEmail?.trim() || null,
        pickup_time: pickupTime || null,
        special_instructions: specialInstructions?.trim() || null,
        delivery_address: deliveryAddress?.trim() || null,
        courier_type: courierType?.trim() || 'PICKUP',
        delivery_notes: deliveryNotes?.trim() || null,
        subtotal: subtotal,
        total_amount: parseFloat(total || subtotal),
        payment_method: (paymentMethod || 'gcash').toUpperCase(),
        status: 'PENDING',
        payment_status: 'PENDING'
      });
      
      const order = Array.isArray(orders) ? orders[0] : orders;
      
      // Insert order items (subtotal is a generated column, do NOT insert it)
      const itemsToInsert = orderItems.map(item => ({
        order_id: order.id,
        order_ref: orderRef,
        menu_item_id: item.id || null,
        item_name: item.name,
        size: item.size || null,
        unit_price: parseFloat(item.price || item.unitPrice || 0),
        quantity: parseInt(item.qty || item.quantity || 1)
      }));
      
      await supabase('POST', 'online_order_items', itemsToInsert);

      // ── Sync to Google Sheets (fire-and-forget) ────────────────────────
      const itemsSummary = orderItems.map(i => {
        const sizePart = i.size ? ` (${i.size})` : '';
        return `${i.name}${sizePart} x${i.qty || i.quantity || 1}`;
      }).join(', ');
      callGAS({
        action: 'syncOnlineOrder',
        orderRef,
        createdAt: new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' }),
        customerName: customerName.trim(),
        customerPhone: customerPhone.trim(),
        pickupTime: pickupTime || '',
        itemsSummary,
        itemCount: orderItems.length,
        totalAmount: parseFloat(total || subtotal),
        paymentMethod: (paymentMethod || 'gcash').toUpperCase(),
        paymentStatus: 'PENDING',
        orderStatus: 'PENDING',
        specialInstructions: specialInstructions?.trim() || ''
      });
      
      return res.status(200).json({ 
        ok: true, 
        orderRef,
        orderId: order?.id,
        subtotal,
        message: 'Order placed successfully! Please upload your payment proof.'
      });
    }

    // ── GET ORDER STATUS (customer) ───────────────────────────
    if (action === 'getOrderStatus' || action === 'getOnlineOrder') {
      const orderRef = payload.orderRef || payload.order_ref;
      if (!orderRef) return res.status(400).json({ ok: false, error: 'Missing orderRef' });
      
      const orders = await supabase('GET', 'online_orders', null, {
        'order_ref': `eq.${orderRef}`,
        'limit': '1'
      });
      
      if (!orders?.length) {
        return res.status(404).json({ ok: false, error: 'Order not found' });
      }
      
      const order = orders[0];
      
      const items = await supabase('GET', 'online_order_items', null, {
        'order_ref': `eq.${orderRef}`
      });
      
      return res.status(200).json({ 
        ok: true, 
        order,
        items: items || []
      });
    }

    // ── GET ALL ONLINE ORDERS (admin) ─────────────────────────
    if (action === 'getOnlineOrders') {
      const { status, limit = 50 } = payload;
      
      const params = {
        'order': 'created_at.desc',
        'limit': String(limit)
      };
      if (status && status !== 'ALL' && status !== 'all') {
        params['status'] = `eq.${status.toUpperCase()}`;
      }
      
      const orders = await supabase('GET', 'online_orders', null, params);
      
      // Fetch items for each order
      const ordersWithItems = await Promise.all((orders || []).map(async (order) => {
        const items = await supabase('GET', 'online_order_items', null, {
          'order_ref': `eq.${order.order_ref}`
        });
        return { ...order, items: items || [] };
      }));
      
      return res.status(200).json({ ok: true, orders: ordersWithItems });
    }

    // ── UPDATE ORDER STATUS (admin) ───────────────────────────
    if (action === 'updateOnlineOrderStatus') {
      const { orderRef, status, adminNotes } = payload;
      if (!orderRef || !status) return res.status(400).json({ ok: false, error: 'Missing fields' });
      
      const updateData = { 
        status: status.toUpperCase(),
        updated_at: new Date().toISOString()
      };
      if (adminNotes) updateData.admin_notes = adminNotes;
      // When confirming payment, also mark payment as VERIFIED
      if (status.toUpperCase() === 'CONFIRMED') updateData.payment_status = 'VERIFIED';
      // When cancelling, also mark payment as REJECTED if it was submitted
      if (status.toUpperCase() === 'CANCELLED') updateData.payment_status = 'REJECTED';
      
      await supabasePatch('online_orders', `order_ref=eq.${orderRef}`, updateData);
      
      // If status is 'ready', send SMS notification
      let smsSent = false;
      let smsNote = '';
      if (status.toUpperCase() === 'READY') {
        try {
          const orders = await supabase('GET', 'online_orders', null, {
            'order_ref': `eq.${orderRef}`,
            'limit': '1'
          });
          if (orders?.length) {
            const order = orders[0];
            const message = `Hi ${order.customer_name}! Your Yani Garden Cafe order (${orderRef}) is now READY for pickup. Thank you for ordering!`;
            const smsResult = await sendSMS(order.customer_phone, message);
            smsSent = smsResult.ok;
            smsNote = smsResult.ok ? `SMS sent to ${order.customer_phone}` : `SMS failed: ${smsResult.error}`;
            
            // Mark SMS as sent
            if (smsSent) {
              await supabasePatch('online_orders', `order_ref=eq.${orderRef}`, { sms_sent: true });
            }
          }
        } catch (e) {
          smsNote = `SMS error: ${e.message}`;
        }
      }
      
      // ── Sync status update to Google Sheets (fire-and-forget) ────────────
      callGAS({
        action: 'updateOnlineOrderStatus',
        orderRef,
        orderStatus: status.toUpperCase()
      });

      return res.status(200).json({ 
        ok: true, 
        message: `Order ${orderRef} updated to ${status}`,
        smsSent,
        smsNote
      });
    }

    // ── VERIFY PAYMENT (admin) ────────────────────────────────
    if (action === 'verifyOnlinePayment') {
      const { orderRef, verified, rejectionReason } = payload;
      if (!orderRef) return res.status(400).json({ ok: false, error: 'Missing orderRef' });
      
      const paymentStatus = verified ? 'VERIFIED' : 'REJECTED';
      const orderStatus = verified ? 'CONFIRMED' : 'PENDING';
      
      await supabasePatch('online_orders', `order_ref=eq.${orderRef}`, { 
        payment_status: paymentStatus,
        status: orderStatus,
        updated_at: new Date().toISOString()
      });
      
      // Also update online_payments if exists
      try {
        const payments = await supabase('GET', 'online_payments', null, {
          'order_ref': `eq.${orderRef}`,
          'limit': '1'
        });
        if (payments?.length) {
          const updateData = {
            status: paymentStatus.toUpperCase(),
            verified_by: 'ADMIN',
            verified_at: new Date().toISOString()
          };
          if (!verified && rejectionReason) updateData.rejection_reason = rejectionReason;
          await supabasePatch('online_payments', `id=eq.${payments[0].id}`, updateData);
        }
      } catch (e) {}
      
      // ── Sync payment verification to Google Sheets (fire-and-forget) ──────
      callGAS({
        action: 'updateOnlineOrderStatus',
        orderRef,
        orderStatus: orderStatus,
        paymentStatus: paymentStatus
      });

      return res.status(200).json({ ok: true, message: `Payment ${paymentStatus} for ${orderRef}` });
    }

    // ── SEND READY SMS (admin) ────────────────────────────────
    if (action === 'sendReadySMS') {
      const { orderRef } = payload;
      if (!orderRef) return res.status(400).json({ ok: false, error: 'Missing orderRef' });
      
      const orders = await supabase('GET', 'online_orders', null, {
        'order_ref': `eq.${orderRef}`,
        'limit': '1'
      });
      
      if (!orders?.length) {
        return res.status(404).json({ ok: false, error: 'Order not found' });
      }
      
      const order = orders[0];
      const message = `Hi ${order.customer_name}! Your Yani Garden Cafe order (${orderRef}) is now READY for pickup. Thank you!`;
      
      const smsResult = await sendSMS(order.customer_phone, message);
      
      if (smsResult.ok) {
        await supabasePatch('online_orders', `order_ref=eq.${orderRef}`, { sms_sent: true });
      }
      
      return res.status(200).json({ 
        ok: true, 
        smsSent: smsResult.ok,
        message: smsResult.ok ? `SMS sent to ${order.customer_phone}` : `SMS failed: ${smsResult.error}`
      });
    }

    // ── SUBMIT PAYMENT PROOF (customer) ──────────────────────
    if (action === 'submitPaymentProof') {
      const { orderRef, proofUrl, proofFilename, paymentMethod } = payload;
      if (!orderRef) return res.status(400).json({ ok: false, error: 'Missing orderRef' });
      if (!proofUrl) return res.status(400).json({ ok: false, error: 'Missing proofUrl' });

      // Update order: keep status=PENDING, set payment_status=SUBMITTED
      // (online_order_status enum only has PENDING and CONFIRMED)
      await supabasePatch('online_orders', `order_ref=eq.${encodeURIComponent(orderRef)}`, {
        payment_proof_url: proofUrl,
        payment_status: 'SUBMITTED',
        updated_at: new Date().toISOString()
      });

      // Insert into online_payments table for admin review
      try {
        const orders = await supabase('GET', 'online_orders', null, {
          'order_ref': `eq.${orderRef}`, 'limit': '1'
        });
        if (orders?.length) {
          await supabase('POST', 'online_payments', {
            order_id: orders[0].id,
            order_ref: orderRef,
            amount: orders[0].total_amount,
            payment_method: (paymentMethod || orders[0].payment_method || 'GCASH').toUpperCase(),
            proof_url: proofUrl,
            proof_filename: proofFilename || null,
            status: 'PENDING'
          });
        }
      } catch (e) {
        console.warn('online_payments insert failed (non-critical):', e.message);
      }

      // Sync to GAS (fire-and-forget)
      callGAS({
        action: 'updateOnlineOrderStatus',
        orderRef,
        orderStatus: 'PAYMENT_SUBMITTED',
        paymentStatus: 'SUBMITTED'
      });

      return res.status(200).json({ ok: true, message: 'Payment proof submitted successfully' });
    }

    if (action === 'editOnlineOrder') {
      const { orderRef, customerName, customerPhone, specialInstructions, adminNotes, updatedBy } = payload;
      if (!orderRef) return res.status(400).json({ ok: false, error: 'Missing orderRef' });
      if (!customerName || customerName.trim().length < 2)
        return res.status(400).json({ ok: false, error: 'Customer name must be at least 2 characters' });
      if (!customerPhone || !/^(09|\+639)\d{9}$/.test(customerPhone.trim()))
        return res.status(400).json({ ok: false, error: 'Phone must be a valid PH mobile number (09XXXXXXXXX or +639XXXXXXXXX)' });

      const updateData = {
        customer_name: customerName.trim(),
        customer_phone: customerPhone.trim(),
        special_instructions: specialInstructions?.trim() || null,
        updated_at: new Date().toISOString()
      };
      if (adminNotes !== undefined) updateData.admin_notes = adminNotes.trim() || null;

      await supabasePatch('online_orders', `order_ref=eq.${encodeURIComponent(orderRef)}`, updateData);

      // Sync to GAS (fire-and-forget)
      callGAS({
        action: 'updateOnlineOrderStatus',
        orderRef,
        orderStatus: 'EDITED',
        updatedBy: updatedBy || 'Owner'
      });

      return res.status(200).json({ ok: true, message: `Order ${orderRef} updated` });
    }

    return res.status(400).json({ ok: false, error: `Unknown action: ${action}` });

  } catch (err) {
    console.error('Online order API error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
