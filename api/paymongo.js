// ══════════════════════════════════════════════════════════════
// YANI POS — PayMongo Integration
// POST /api/paymongo
// Actions: createPaymentLink, getPaymentStatus, webhook
// ══════════════════════════════════════════════════════════════

const PAYMONGO_SECRET = process.env.PAYMONGO_SECRET_KEY;
const SUPABASE_URL    = process.env.SUPABASE_URL || 'https://hnynvclpvfxzlfjphefj.supabase.co';
const SUPABASE_KEY    = process.env.SUPABASE_SECRET_KEY;

const ALLOWED_ORIGINS = [
  'https://yanigardencafe.com',
  'https://pos.yanigardencafe.com',
  'https://admin.yanigardencafe.com',
];

function setCors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS[0]);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');
}

async function pmFetch(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      'Authorization': 'Basic ' + Buffer.from(PAYMONGO_SECRET + ':').toString('base64'),
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch('https://api.paymongo.com/v1' + path, opts);
  const data = await r.json();
  return { ok: r.ok, status: r.status, data };
}

async function supaUpdate(table, match, payload) {
  const params = Object.entries(match).map(([k,v]) => `${k}=eq.${encodeURIComponent(v)}`).join('&');
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(payload),
  });
  return r.ok;
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Webhook from PayMongo ─────────────────────────────────
  // PayMongo calls this URL directly — no action param
  if (req.method === 'POST' && req.headers['paymongo-signature']) {
    // Verify webhook signature
    const WEBHOOK_SECRET = process.env.PAYMONGO_WEBHOOK_SECRET || '';
    const sigHeader = req.headers['paymongo-signature'] || '';
    if (WEBHOOK_SECRET && sigHeader) {
      // PayMongo signature format: t=timestamp,te=hash,li=hash
      const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      const parts   = Object.fromEntries(sigHeader.split(',').map(p => p.split('=')));
      const timestamp = parts.t || '';
      const toSign    = timestamp + '.' + rawBody;
      const crypto    = await import('crypto');
      const expected  = crypto.createHmac('sha256', WEBHOOK_SECRET).update(toSign).digest('hex');
      const received  = parts.te || parts.li || '';
      if (received && expected !== received) {
        console.warn('PayMongo webhook signature mismatch');
        return res.status(400).json({ error: 'Invalid signature' });
      }
    }

    const event = req.body;
    const type  = event?.data?.attributes?.type;
    const attrs = event?.data?.attributes?.data?.attributes || {};

    console.log('PayMongo webhook:', type);

    if (type === 'payment.paid') {
      const metadata = attrs.metadata || {};
      const orderId  = metadata.order_id;
      const amount   = (attrs.amount || 0) / 100; // convert centavos

      if (orderId) {
        // Extract the richest reconciliation detail PayMongo gives us.
        const paymentId   = event?.data?.attributes?.data?.id || attrs.payment_id || null;
        const source      = attrs.source || {};
        const brand       = (source.brand || source.type || attrs.payment_method_used || '').toLowerCase() || null;
        const refNo       = attrs.external_reference_number || attrs.reference_number || source.reference || null;
        // Mark order PAID — webhook is the authoritative source of truth.
        await supaUpdate('dine_in_orders', { order_id: orderId }, {
          payment_status:        'PAID',
          payment_method:        'CARD',
          paid_at:               new Date().toISOString(),
          payment_amount:        amount,
          paymongo_payment_id:   paymentId,
          payment_brand:         brand,
          payment_ref_no:        refNo,
          settlement_status:     'pending',
        });
        console.log(`Order ${orderId} marked PAID ₱${amount} (${brand||'card'}, pay=${paymentId})`);
      }
    }

    if (type === 'payment.failed') {
      const metadata = (event?.data?.attributes?.data?.attributes?.metadata) || {};
      const orderId  = metadata.order_id;
      if (orderId) {
        await supaUpdate('dine_in_orders', { order_id: orderId }, {
          payment_status: 'FAILED',
        });
      }
    }

    return res.status(200).json({ received: true });
  }

  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const { action, orderId, amount, description, customerName, customerEmail } = req.body || {};

  // ── createPaymentLink ─────────────────────────────────────
  if (action === 'createPaymentLink') {
    if (!orderId || !amount) {
      return res.status(400).json({ ok: false, error: 'orderId and amount required' });
    }

    const amountInCentavos = Math.round(parseFloat(amount) * 100);
    if (amountInCentavos < 2000) { // PayMongo min = ₱20
      return res.status(400).json({ ok: false, error: 'Minimum amount is ₱20' });
    }

    // ── Duplicate-session guard (checklist #3) ────────────────────────────
    // If this order already has a PayMongo link and it isn't paid yet, reuse
    // the SAME link so multiple taps never create multiple payable sessions.
    {
      const existR = await fetch(
        `${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}&select=payment_status,paymongo_link_id&limit=1`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      const existRows = existR.ok ? await existR.json() : [];
      const existing  = existRows[0];
      if (existing) {
        if (existing.payment_status === 'PAID') {
          return res.status(409).json({ ok: false, error: 'This order is already paid.', code: 'ALREADY_PAID' });
        }
        if (existing.paymongo_link_id) {
          // Confirm the existing link is still usable (not paid/expired) and reuse it.
          const chk = await pmFetch(`/links/${existing.paymongo_link_id}`);
          if (chk.ok) {
            const st  = chk.data.data?.attributes?.status;
            const url = chk.data.data?.attributes?.checkout_url;
            if (st === 'paid') {
              await supaUpdate('dine_in_orders', { order_id: orderId }, { payment_status: 'PAID' });
              return res.status(409).json({ ok: false, error: 'This order is already paid.', code: 'ALREADY_PAID' });
            }
            if (url && (st === 'unpaid' || st === 'pending')) {
              return res.status(200).json({ ok: true, checkoutUrl: url, linkId: existing.paymongo_link_id, amount: amountInCentavos / 100, reused: true });
            }
          }
          // else: link missing/expired → fall through and create a fresh one
        }
      }
    }

    const payload = {
      data: {
        attributes: {
          amount: amountInCentavos,
          currency: 'PHP',
          description: description || `YANI Garden Cafe — ${orderId}`,
          remarks: orderId,
          // Payment methods enabled: card, gcash, maya, grab_pay, brankas
          payment_method_allowed: ['card', 'gcash', 'paymaya'],
          metadata: { order_id: orderId },
          success_url: `https://pos.yanigardencafe.com/index-customer.html?payment=success&ref=${orderId}`,
          failure_url: `https://pos.yanigardencafe.com/index-customer.html?payment=failed&ref=${orderId}`,
          ...(customerEmail ? {
            billing: {
              name: customerName || 'Guest',
              email: customerEmail,
            }
          } : {}),
        }
      }
    };

    const pm = await pmFetch('/links', 'POST', payload);

    if (!pm.ok) {
      console.error('PayMongo link creation failed:', pm.data);
      const detail = pm.data?.errors?.[0]?.detail || 'Payment link creation failed';
      return res.status(502).json({ ok: false, error: detail });
    }

    const link      = pm.data.data;
    const checkoutUrl = link.attributes.checkout_url;
    const linkId    = link.id;

    // Save payment link reference to order
    await supaUpdate('dine_in_orders', { order_id: orderId }, {
      payment_status: 'PENDING',
      payment_method: 'CARD',
      paymongo_link_id: linkId,
      paymongo_checkout_ref: linkId,
    });

    return res.status(200).json({
      ok: true,
      checkoutUrl,
      linkId,
      amount: amountInCentavos / 100,
    });
  }

  // ── getPaymentStatus ──────────────────────────────────────
  if (action === 'getPaymentStatus') {
    if (!orderId) return res.status(400).json({ ok: false, error: 'orderId required' });

    // Get linkId from order
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}&select=payment_status,paymongo_link_id,payment_amount`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await r.json();
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Order not found' });

    const { payment_status, paymongo_link_id, payment_amount } = rows[0];

    // If already marked paid, return cached status
    if (payment_status === 'PAID') {
      return res.status(200).json({ ok: true, status: 'PAID', amount: payment_amount });
    }

    // Check live status from PayMongo if we have a link
    if (paymongo_link_id) {
      const pm = await pmFetch(`/links/${paymongo_link_id}`);
      if (pm.ok) {
        const pmStatus = pm.data.data?.attributes?.status;
        if (pmStatus === 'paid') {
          const pmAmount = (pm.data.data?.attributes?.amount || 0) / 100;
          await supaUpdate('dine_in_orders', { order_id: orderId }, {
            payment_status: 'PAID',
            payment_amount: pmAmount,
            paid_at: new Date().toISOString(),
          });
          return res.status(200).json({ ok: true, status: 'PAID', amount: pmAmount });
        }
        return res.status(200).json({ ok: true, status: pmStatus || payment_status || 'PENDING' });
      }
    }

    return res.status(200).json({ ok: true, status: payment_status || 'PENDING' });
  }

  // ── cancelPayment ─────────────────────────────────────────
  // Customer backed out of the PayMongo checkout. Mark the order's payment
  // CANCELLED (not stuck PENDING) so they can re-pick a method. The order
  // itself is preserved — only payment intent is reset.
  if (action === 'cancelPayment') {
    if (!orderId) return res.status(400).json({ ok: false, error: 'orderId required' });
    // Never override an already-paid order.
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}&select=payment_status&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = r.ok ? await r.json() : [];
    if (rows[0]?.payment_status === 'PAID') {
      return res.status(200).json({ ok: true, status: 'PAID', note: 'Already paid — not cancelled.' });
    }
    await supaUpdate('dine_in_orders', { order_id: orderId }, { payment_status: 'PAYMENT_CANCELLED' });
    return res.status(200).json({ ok: true, status: 'PAYMENT_CANCELLED' });
  }

  return res.status(400).json({ ok: false, error: 'Unknown action' });
}
