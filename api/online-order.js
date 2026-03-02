// ══════════════════════════════════════════════════════════════
// YANI ONLINE ORDER — Vercel Serverless API
// Connects to Supabase for online ordering platform
// Actions: getMenu, placeOrder, uploadProof, getOrder,
//          getOnlineOrders (admin), updateOnlineOrderStatus (admin),
//          verifyOnlinePayment (admin), sendReadySMS (admin)
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

// ── Generate order ref: YANI-OL-001 ───────────────────────────
async function generateOrderRef() {
  // Use Supabase RPC function to get next order ref
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_next_online_order_ref`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json'
    },
    body: '{}'
  });
  if (!res.ok) {
    // Fallback: use timestamp
    return 'YANI-OL-' + Date.now().toString().slice(-6);
  }
  const ref = await res.json();
  return ref;
}

// ── Send SMS via Semaphore ─────────────────────────────────────
async function sendSMS(phone, message) {
  if (!SEMAPHORE_API_KEY) return { ok: false, error: 'No SMS API key configured' };
  
  // Normalize Philippine phone number
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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const { action, ...payload } = req.body || {};
  if (!action) return res.status(400).json({ ok: false, error: 'Missing action' });

  try {
    // ── GET MENU ──────────────────────────────────────────────
    if (action === 'getOnlineMenu') {
      const categories = await supabase('GET', 'menu_categories', null, {
        'order': 'display_order.asc'
      });
      const items = await supabase('GET', 'menu_items', null, {
        'is_active': 'eq.true',
        'order': 'name.asc',
        'select': 'id,item_code,name,category_id,base_price,price_short,price_medium,price_tall,has_sizes,has_sugar_levels,image_path'
      });
      
      // Group items by category
      const catMap = {};
      (categories || []).forEach(c => { catMap[c.id] = c.name; });
      
      const grouped = {};
      (items || []).forEach(item => {
        const catName = catMap[item.category_id] || 'OTHER';
        if (!grouped[catName]) grouped[catName] = [];
        grouped[catName].push({
          id: item.id,
          code: item.item_code,
          name: item.name,
          category: catName,
          price: parseFloat(item.base_price),
          priceShort: item.price_short ? parseFloat(item.price_short) : null,
          priceMedium: item.price_medium ? parseFloat(item.price_medium) : null,
          priceTall: item.price_tall ? parseFloat(item.price_tall) : null,
          hasSizes: item.has_sizes,
          hasSugar: item.has_sugar_levels,
          image: item.image_path ? `https://yani-garden-cafe-d3l6.vercel.app${item.image_path}` : null
        });
      });
      
      return res.status(200).json({ ok: true, categories: categories || [], items: items || [], grouped });
    }

    // ── PLACE ORDER ───────────────────────────────────────────
    if (action === 'placeOnlineOrder') {
      const { customerName, customerPhone, customerEmail, deliveryAddress, deliveryNotes, courierType, items: orderItems } = payload;
      
      if (!customerName || !customerPhone || !deliveryAddress || !orderItems?.length) {
        return res.status(400).json({ ok: false, error: 'Missing required fields' });
      }
      
      // Calculate subtotal
      const subtotal = orderItems.reduce((sum, item) => sum + (item.unitPrice * item.quantity), 0);
      
      // Generate order ref
      const orderRef = await generateOrderRef();
      
      // Insert order
      const orders = await supabase('POST', 'online_orders', {
        order_ref: orderRef,
        customer_name: customerName.trim(),
        customer_phone: customerPhone.trim(),
        customer_email: customerEmail?.trim() || null,
        delivery_address: deliveryAddress.trim(),
        delivery_notes: deliveryNotes?.trim() || null,
        courier_type: courierType || 'LALAMOVE',
        subtotal: subtotal,
        status: 'PENDING',
        payment_status: 'PENDING'
      });
      
      const order = Array.isArray(orders) ? orders[0] : orders;
      
      // Insert order items
      const itemsToInsert = orderItems.map(item => ({
        order_id: order.id,
        menu_item_id: item.code || item.id || '',
        item_name: item.name,
        size: item.size || 'REGULAR',
        unit_price: item.unitPrice,
        quantity: item.quantity
      }));
      
      await supabase('POST', 'online_order_items', itemsToInsert);
      
      // Create payment record
      await supabase('POST', 'online_payments', {
        order_id: order.id,
        order_ref: orderRef,
        amount: subtotal,
        payment_method: payload.paymentMethod || 'GCASH',
        status: 'PENDING'
      });
      
      return res.status(200).json({ 
        ok: true, 
        orderRef,
        orderId: order.id,
        subtotal,
        message: 'Order placed successfully! Please upload your payment proof.'
      });
    }

    // ── UPLOAD PAYMENT PROOF ──────────────────────────────────
    if (action === 'submitPaymentProof') {
      const { orderRef, proofUrl, proofFilename, paymentMethod } = payload;
      
      if (!orderRef || !proofUrl) {
        return res.status(400).json({ ok: false, error: 'Missing orderRef or proofUrl' });
      }
      
      // Find the payment record
      const payments = await supabase('GET', 'online_payments', null, {
        'order_ref': `eq.${orderRef}`,
        'limit': '1'
      });
      
      if (!payments?.length) {
        return res.status(404).json({ ok: false, error: 'Order not found' });
      }
      
      const payment = payments[0];
      
      // Update payment with proof
      await fetch(`${SUPABASE_URL}/rest/v1/online_payments?id=eq.${payment.id}`, {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          proof_url: proofUrl,
          proof_filename: proofFilename || 'payment_proof',
          payment_method: paymentMethod || payment.payment_method,
          status: 'SUBMITTED'
        })
      });
      
      // Update order payment status
      await fetch(`${SUPABASE_URL}/rest/v1/online_orders?order_ref=eq.${orderRef}`, {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ payment_status: 'SUBMITTED' })
      });
      
      return res.status(200).json({ ok: true, message: 'Payment proof submitted successfully!' });
    }

    // ── GET ORDER STATUS (customer) ───────────────────────────
    if (action === 'getOnlineOrder') {
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
      
      const items = await supabase('GET', 'online_order_items', null, {
        'order_id': `eq.${order.id}`
      });
      
      const payments = await supabase('GET', 'online_payments', null, {
        'order_id': `eq.${order.id}`,
        'limit': '1'
      });
      
      return res.status(200).json({ 
        ok: true, 
        order,
        items: items || [],
        payment: payments?.[0] || null
      });
    }

    // ── GET ALL ONLINE ORDERS (admin) ─────────────────────────
    if (action === 'getOnlineOrders') {
      const { status, limit = 50 } = payload;
      
      const params = {
        'order': 'created_at.desc',
        'limit': String(limit)
      };
      if (status && status !== 'ALL') {
        params['status'] = `eq.${status}`;
      }
      
      const orders = await supabase('GET', 'online_orders', null, params);
      
      // Fetch items for each order
      const ordersWithItems = await Promise.all((orders || []).map(async (order) => {
        const items = await supabase('GET', 'online_order_items', null, {
          'order_id': `eq.${order.id}`
        });
        const payments = await supabase('GET', 'online_payments', null, {
          'order_id': `eq.${order.id}`,
          'limit': '1'
        });
        return { ...order, items: items || [], payment: payments?.[0] || null };
      }));
      
      return res.status(200).json({ ok: true, orders: ordersWithItems });
    }

    // ── UPDATE ORDER STATUS (admin) ───────────────────────────
    if (action === 'updateOnlineOrderStatus') {
      const { orderRef, status, adminNotes } = payload;
      if (!orderRef || !status) return res.status(400).json({ ok: false, error: 'Missing fields' });
      
      const updateData = { status };
      if (adminNotes) updateData.admin_notes = adminNotes;
      
      await fetch(`${SUPABASE_URL}/rest/v1/online_orders?order_ref=eq.${orderRef}`, {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(updateData)
      });
      
      return res.status(200).json({ ok: true, message: `Order ${orderRef} updated to ${status}` });
    }

    // ── VERIFY PAYMENT (admin) ────────────────────────────────
    if (action === 'verifyOnlinePayment') {
      const { orderRef, verified, rejectionReason, verifiedBy } = payload;
      if (!orderRef) return res.status(400).json({ ok: false, error: 'Missing orderRef' });
      
      const paymentStatus = verified ? 'VERIFIED' : 'REJECTED';
      const orderStatus = verified ? 'CONFIRMED' : 'PENDING';
      
      // Update payment
      const payments = await supabase('GET', 'online_payments', null, {
        'order_ref': `eq.${orderRef}`,
        'limit': '1'
      });
      
      if (payments?.length) {
        const updateData = {
          status: paymentStatus,
          verified_by: verifiedBy || 'ADMIN',
          verified_at: new Date().toISOString()
        };
        if (!verified && rejectionReason) updateData.rejection_reason = rejectionReason;
        
        await fetch(`${SUPABASE_URL}/rest/v1/online_payments?id=eq.${payments[0].id}`, {
          method: 'PATCH',
          headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(updateData)
        });
      }
      
      // Update order
      await fetch(`${SUPABASE_URL}/rest/v1/online_orders?order_ref=eq.${orderRef}`, {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ 
          payment_status: paymentStatus,
          status: orderStatus
        })
      });
      
      return res.status(200).json({ ok: true, message: `Payment ${paymentStatus.toLowerCase()} for ${orderRef}` });
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
      const message = `Hi ${order.customer_name}! Your Yani Garden Cafe order (${orderRef}) is now READY for courier pickup. Please book your Lalamove/Grab Express now. Pick up at: Yani Garden Cafe. Thank you!`;
      
      const smsResult = await sendSMS(order.customer_phone, message);
      
      // Mark SMS as sent
      await fetch(`${SUPABASE_URL}/rest/v1/online_orders?order_ref=eq.${orderRef}`, {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ 
          status: 'READY',
          sms_sent: smsResult.ok 
        })
      });
      
      return res.status(200).json({ 
        ok: true, 
        smsSent: smsResult.ok,
        message: smsResult.ok ? `SMS sent to ${order.customer_phone}` : `Order marked ready (SMS failed: ${smsResult.error})`
      });
    }

    return res.status(400).json({ ok: false, error: `Unknown action: ${action}` });

  } catch (err) {
    console.error('Online order API error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
