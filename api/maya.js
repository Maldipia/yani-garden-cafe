// ══════════════════════════════════════════════════════════════
// YANI POS — Maya Checkout Integration
// POST /api/maya
// Actions: createCheckout, getPaymentStatus, cancelPayment
// Webhooks: Maya calls this URL directly (CHECKOUT_SUCCESS / FAILURE / etc.)
//
// Maya Checkout is a hosted-redirect flow (docs: developers.maya.ph):
//   1. Create Checkout (Public Key)  → returns checkoutId + redirectUrl
//   2. Redirect customer to Maya's hosted page (valid 1 hour)
//   3. Customer pays (Visa/Mastercard/JCB/Maya)
//   4. Maya redirects back to success/failure/cancel URLs
//   5. Maya fires a webhook → we mark the order PAID (authoritative)
//   6. Money settles to the Maya merchant account (~1 business day)
//
// Environments:
//   sandbox    → https://pg-sandbox.paymaya.com   (test keys, mock cards)
//   production → https://pg.maya.ph               (live keys, real money)
// Controlled by MAYA_ENV. Keys: MAYA_PUBLIC_KEY (pk-...), MAYA_SECRET_KEY (sk-...).
// ══════════════════════════════════════════════════════════════

const MAYA_ENV        = (process.env.MAYA_ENV || 'sandbox').toLowerCase();
const MAYA_PUBLIC_KEY = process.env.MAYA_PUBLIC_KEY || '';
const MAYA_SECRET_KEY = process.env.MAYA_SECRET_KEY || '';
const MAYA_BASE       = MAYA_ENV === 'production'
  ? 'https://pg.maya.ph'
  : 'https://pg-sandbox.paymaya.com';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://hnynvclpvfxzlfjphefj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;

const ALLOWED_ORIGINS = [
  'https://yanigardencafe.com',
  'https://pos.yanigardencafe.com',
  'https://admin.yanigardencafe.com',
];

function setCors(req, res) {
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');
}

// Maya uses HTTP Basic auth: key as username, empty password.
function authHeader(key) {
  return 'Basic ' + Buffer.from(key + ':').toString('base64');
}

async function mayaFetch(path, method, key, body) {
  const opts = {
    method,
    headers: {
      'Authorization': authHeader(key),
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(MAYA_BASE + path, opts);
  let data = null;
  try { data = await r.json(); } catch (e) { data = null; }
  return { ok: r.ok, status: r.status, data };
}

async function supaUpdate(table, match, payload) {
  const params = Object.entries(match).map(([k, v]) => `${k}=eq.${encodeURIComponent(v)}`).join('&');
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

async function supaSelect(table, params) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  return r.ok ? await r.json() : [];
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Webhook from Maya ─────────────────────────────────────────
  // Maya POSTs the payment resource directly. We identify it by the
  // presence of a status field and no `action` in the body.
  const bodyIn = req.body || {};
  const looksLikeWebhook = req.method === 'POST' && !bodyIn.action &&
    (bodyIn.status || bodyIn.paymentStatus || bodyIn.id) && bodyIn.requestReferenceNumber;

  if (looksLikeWebhook) {
    const orderId = bodyIn.requestReferenceNumber;           // we set this = our order_id
    const status  = String(bodyIn.status || bodyIn.paymentStatus || '').toUpperCase();
    const paymentId = bodyIn.id || bodyIn.paymentId || null;
    const amount  = bodyIn.totalAmount?.value ? parseFloat(bodyIn.totalAmount.value)
                    : (bodyIn.amount ? parseFloat(bodyIn.amount) : null);
    const rrn     = bodyIn.receiptNumber || bodyIn.rrn || null;

    console.log('Maya webhook:', orderId, status);

    if (orderId) {
      if (status === 'PAYMENT_SUCCESS' || status === 'SUCCESS' || status === 'COMPLETED') {
        await supaUpdate('dine_in_orders', { order_id: orderId }, {
          payment_status:      'PAID',
          payment_method:      'CARD',
          paid_at:             new Date().toISOString(),
          ...(amount != null ? { payment_amount: amount } : {}),
          maya_payment_id:     paymentId,
          maya_rrn:            rrn,
          maya_payment_status: status,
          maya_settlement:     'pending',
        });
        console.log(`Order ${orderId} marked PAID via Maya (pay=${paymentId})`);
      } else if (status === 'PAYMENT_FAILED' || status === 'FAILED' || status === 'EXPIRED') {
        await supaUpdate('dine_in_orders', { order_id: orderId }, {
          payment_status:      'FAILED',
          maya_payment_status: status,
        });
      } else if (status === 'PAYMENT_CANCELLED' || status === 'CANCELLED' || status === 'VOIDED') {
        await supaUpdate('dine_in_orders', { order_id: orderId }, {
          payment_status:      'PAYMENT_CANCELLED',
          maya_payment_status: status,
        });
      }
    }
    return res.status(200).json({ received: true });
  }

  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const { action, orderId, amount, description, customerName, customerEmail } = bodyIn;

  // ── createCheckout ────────────────────────────────────────────
  if (action === 'createCheckout') {
    if (!MAYA_PUBLIC_KEY) return res.status(500).json({ ok: false, error: 'Maya not configured (missing public key)', code: 'NO_KEY' });
    if (!orderId || !amount) return res.status(400).json({ ok: false, error: 'orderId and amount required' });

    const amt = parseFloat(amount);
    if (isNaN(amt) || amt < 1) return res.status(400).json({ ok: false, error: 'Invalid amount' });

    // ── Duplicate-session guard ───────────────────────────────────
    // Reuse an existing unpaid checkout for this order instead of making
    // a new one on repeat taps (prevents double payment).
    const existing = (await supaSelect('dine_in_orders',
      `order_id=eq.${encodeURIComponent(orderId)}&select=payment_status,maya_checkout_id&limit=1`))[0];
    if (existing) {
      if (existing.payment_status === 'PAID') {
        return res.status(409).json({ ok: false, error: 'This order is already paid.', code: 'ALREADY_PAID' });
      }
      if (existing.maya_checkout_id) {
        // Retrieve the existing checkout; reuse if still payable.
        const chk = await mayaFetch(`/checkout/v1/checkouts/${existing.maya_checkout_id}`, 'GET', MAYA_SECRET_KEY);
        const st  = String(chk.data?.status || '').toUpperCase();
        const url = chk.data?.redirectUrl || chk.data?.paymentUrl;
        if (chk.ok && url && !['PAYMENT_SUCCESS', 'EXPIRED', 'PAYMENT_FAILED', 'PAYMENT_CANCELLED'].includes(st)) {
          return res.status(200).json({ ok: true, redirectUrl: url, checkoutId: existing.maya_checkout_id, reused: true });
        }
        // else fall through and create a fresh checkout
      }
    }

    const payload = {
      totalAmount: { value: Number(amt.toFixed(2)), currency: 'PHP' },
      requestReferenceNumber: orderId,  // our order id — echoed back in redirect + webhook
      redirectUrl: {
        success: `https://pos.yanigardencafe.com/index-customer.html?maya=success&ref=${encodeURIComponent(orderId)}`,
        failure: `https://pos.yanigardencafe.com/index-customer.html?maya=failure&ref=${encodeURIComponent(orderId)}`,
        cancel:  `https://pos.yanigardencafe.com/index-customer.html?maya=cancel&ref=${encodeURIComponent(orderId)}`,
      },
      items: [{
        name: (description || `YANI Garden Cafe order ${orderId}`).slice(0, 200),
        quantity: 1,
        totalAmount: { value: Number(amt.toFixed(2)), currency: 'PHP' },
      }],
      ...(customerName || customerEmail ? {
        buyer: {
          firstName: (customerName || 'Guest').slice(0, 100),
          ...(customerEmail ? { contact: { email: customerEmail } } : {}),
        }
      } : {}),
    };

    const mk = await mayaFetch('/checkout/v1/checkouts', 'POST', MAYA_PUBLIC_KEY, payload);
    if (!mk.ok) {
      console.error('Maya checkout creation failed:', mk.status, mk.data);
      const detail = mk.data?.error || mk.data?.message || 'Checkout creation failed';
      return res.status(502).json({ ok: false, error: detail });
    }

    const checkoutId  = mk.data.checkoutId;
    const redirectUrl = mk.data.redirectUrl;

    await supaUpdate('dine_in_orders', { order_id: orderId }, {
      payment_status:   'PENDING',
      payment_method:   'CARD',
      maya_checkout_id: checkoutId,
    });

    return res.status(200).json({ ok: true, redirectUrl, checkoutId, amount: amt });
  }

  // ── getPaymentStatus ──────────────────────────────────────────
  // UI polling helper. Read-only: does NOT flip PAID (webhook is authoritative);
  // but will reconcile if Maya reports success and webhook was missed.
  if (action === 'getPaymentStatus') {
    if (!orderId) return res.status(400).json({ ok: false, error: 'orderId required' });
    const row = (await supaSelect('dine_in_orders',
      `order_id=eq.${encodeURIComponent(orderId)}&select=payment_status,maya_checkout_id,payment_amount&limit=1`))[0];
    if (!row) return res.status(404).json({ ok: false, error: 'Order not found' });

    if (row.payment_status === 'PAID') {
      return res.status(200).json({ ok: true, status: 'PAID', amount: row.payment_amount });
    }
    if (row.maya_checkout_id && MAYA_SECRET_KEY) {
      const chk = await mayaFetch(`/checkout/v1/checkouts/${row.maya_checkout_id}`, 'GET', MAYA_SECRET_KEY);
      const st  = String(chk.data?.paymentStatus || chk.data?.status || '').toUpperCase();
      if (chk.ok && (st === 'PAYMENT_SUCCESS' || st === 'SUCCESS')) {
        // Safety reconcile if webhook was missed.
        await supaUpdate('dine_in_orders', { order_id: orderId }, {
          payment_status: 'PAID', payment_method: 'CARD', paid_at: new Date().toISOString(),
          maya_payment_status: st, maya_settlement: 'pending',
        });
        return res.status(200).json({ ok: true, status: 'PAID' });
      }
      return res.status(200).json({ ok: true, status: st || row.payment_status || 'PENDING' });
    }
    return res.status(200).json({ ok: true, status: row.payment_status || 'PENDING' });
  }

  // ── cancelPayment ─────────────────────────────────────────────
  // Customer backed out. Mark PAYMENT_CANCELLED (never override PAID).
  if (action === 'cancelPayment') {
    if (!orderId) return res.status(400).json({ ok: false, error: 'orderId required' });
    const row = (await supaSelect('dine_in_orders',
      `order_id=eq.${encodeURIComponent(orderId)}&select=payment_status&limit=1`))[0];
    if (row?.payment_status === 'PAID') {
      return res.status(200).json({ ok: true, status: 'PAID', note: 'Already paid — not cancelled.' });
    }
    await supaUpdate('dine_in_orders', { order_id: orderId }, { payment_status: 'PAYMENT_CANCELLED' });
    return res.status(200).json({ ok: true, status: 'PAYMENT_CANCELLED' });
  }

  return res.status(400).json({ ok: false, error: 'Unknown action' });
}
