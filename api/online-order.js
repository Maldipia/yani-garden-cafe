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
      
      const grouped = {};
      const mappedItems = (items || []).map(item => {
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
          image: item.image_path ? `https://yani-garden-cafe-d3l6.vercel.app${item.image_path}` : null
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
        items: orderItems, total
      } = payload;
      
      if (!customerName || !customerPhone || !orderItems?.length) {
        return res.status(400).json({ 
          ok: false, 
          error: 'Missing required fields: customerName, customerPhone, items' 
        });
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
        delivery_address: null,
        courier_type: 'PICKUP',
        subtotal: subtotal,
        total_amount: parseFloat(total || subtotal),
        payment_method: (paymentMethod || 'gcash').toLowerCase(),
        status: 'pending',
        payment_status: 'pending'
      });
      
      const order = Array.isArray(orders) ? orders[0] : orders;
      
      // Insert order items
      const itemsToInsert = orderItems.map(item => ({
        order_id: order.id,
        order_ref: orderRef,
        menu_item_id: item.id || null,
        item_name: item.name,
        size: item.size || null,
        unit_price: parseFloat(item.price || item.unitPrice || 0),
        quantity: parseInt(item.qty || item.quantity || 1),
        subtotal: parseFloat(item.price || item.unitPrice || 0) * parseInt(item.qty || item.quantity || 1)
      }));
      
      await supabase('POST', 'online_order_items', itemsToInsert);
      
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
        params['status'] = `eq.${status.toLowerCase()}`;
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
        status: status.toLowerCase(),
        updated_at: new Date().toISOString()
      };
      if (adminNotes) updateData.admin_notes = adminNotes;
      
      await supabasePatch('online_orders', `order_ref=eq.${orderRef}`, updateData);
      
      // If status is 'ready', send SMS notification
      let smsSent = false;
      let smsNote = '';
      if (status.toLowerCase() === 'ready') {
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
      
      const paymentStatus = verified ? 'verified' : 'rejected';
      const orderStatus = verified ? 'confirmed' : 'pending';
      
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

    return res.status(400).json({ ok: false, error: `Unknown action: ${action}` });

  } catch (err) {
    console.error('Online order API error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
