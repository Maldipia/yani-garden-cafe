// ── Virtual Yani Card Portal ──────────────────────────────────────────────────
// Public-facing actions for customer card portal (pos.yanigardencafe.com/card)
// Auth: PIN → session token. Session token required for all subsequent actions.
// ─────────────────────────────────────────────────────────────────────────────
import { supaFetch, supa, auditLog } from '../lib/db.js';
import { SUPABASE_URL, TNC_VERSION }              from '../lib/config.js';
import { checkRateLimit }            from '../lib/cache.js';

// ── helpers ───────────────────────────────────────────────────────────────────
function randomToken() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2,'0')).join('');
}

async function verifyPortalSession(token, cardNumber) {
  if (!token) return { ok: false, error: 'Session token required' };
  const r = await supaFetch(
    `${SUPABASE_URL}/rest/v1/card_portal_sessions?token=eq.${encodeURIComponent(token)}&card_number=eq.${encodeURIComponent(cardNumber)}&select=expires_at&limit=1`
  );
  if (!r.ok || !r.data?.length) return { ok: false, error: 'Invalid or expired session' };
  if (new Date(r.data[0].expires_at) < new Date()) {
    await supa('DELETE','card_portal_sessions',null,{token:`eq.${token}`});
    return { ok: false, error: 'Session expired — please log in again' };
  }
  return { ok: true };
}

async function cleanExpiredSessions() {
  try {
    await supaFetch(`${SUPABASE_URL}/rest/v1/card_portal_sessions?expires_at=lt.${new Date().toISOString()}`, {
      method: 'DELETE', headers: { 'Prefer': 'return=minimal' }
    });
  } catch(_) {}
}

// ── route ─────────────────────────────────────────────────────────────────────
export async function routeCardPortal(action, body, auth, req, res) {

  // ── cardPortalLogin ─────────────────────────────────────────────────────────
  if (action === 'cardPortalLogin') {
    const cardNumber = String(body.cardNumber || '').trim().toUpperCase();
    const pin        = String(body.pin || '').trim();

    if (!cardNumber || !pin)
      return res.status(400).json({ ok: false, error: 'Card number and PIN required' });
    if (!/^YANI-\d{1,6}$/i.test(cardNumber))
      return res.status(400).json({ ok: false, error: 'Invalid card number format' });
    if (!/^\d{2,8}$/.test(pin))
      return res.status(400).json({ ok: false, error: 'Invalid PIN format' });

    // Brute-force check
    const lockR = await supaFetch(
      `${SUPABASE_URL}/rest/v1/card_pin_attempts?card_number=eq.${encodeURIComponent(cardNumber)}&select=attempts,locked_until&limit=1`
    );
    if (lockR.ok && lockR.data?.length) {
      const rec = lockR.data[0];
      if (rec.locked_until && new Date(rec.locked_until) > new Date()) {
        const mins = Math.ceil((new Date(rec.locked_until)-new Date())/60000);
        return res.status(429).json({ ok: false, error: `Too many attempts. Try again in ${mins} minute${mins===1?'':'s'}.` });
      }
    }

    // Fetch card + verify PIN
    const cardR = await supaFetch(
      `${SUPABASE_URL}/rest/v1/yani_cards?card_number=eq.${encodeURIComponent(cardNumber)}&select=card_number,holder_name,holder_phone,holder_email,tier,balance,total_loaded,total_spent,total_saved,discount_pct,status,card_pin&limit=1`
    );
    if (!cardR.ok || !cardR.data?.length)
      return res.status(404).json({ ok: false, error: 'Card not found' });

    const card    = cardR.data[0];
    const storedPin = String(card.card_pin || '').trim();

    if (storedPin !== pin) {
      // Log failed attempt
      const attempts = lockR.ok && lockR.data?.length ? (lockR.data[0].attempts || 0) + 1 : 1;
      const locked   = attempts >= 5 ? new Date(Date.now() + 15*60*1000).toISOString() : null;
      await supaFetch(`${SUPABASE_URL}/rest/v1/card_pin_attempts`, {
        method: 'POST',
        headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ card_number: cardNumber, attempts, locked_until: locked, last_attempt: new Date().toISOString() })
      });
      const left = Math.max(0, 5 - attempts);
      return res.status(401).json({ ok: false, error: `Incorrect PIN.${left > 0 ? ` ${left} attempt${left===1?'':'s'} remaining.` : ' Card locked for 15 minutes.'}` });
    }

    if (card.status !== 'ACTIVE')
      return res.status(403).json({ ok: false, error: `Card is ${card.status}. Please contact the cafe.` });

    // Clear failed attempts on success
    await supa('DELETE','card_pin_attempts',null,{card_number:`eq.${cardNumber}`});
    // Clean old sessions for this card
    cleanExpiredSessions();
    await supaFetch(`${SUPABASE_URL}/rest/v1/card_portal_sessions?card_number=eq.${encodeURIComponent(cardNumber)}`, {
      method: 'DELETE', headers: { 'Prefer': 'return=minimal' }
    });

    // Create session
    const token = randomToken();
    await supa('POST','card_portal_sessions',{
      token, card_number: cardNumber,
      expires_at: new Date(Date.now() + 24*60*60*1000).toISOString(),
    });

    return res.status(200).json({
      ok: true,
      token,
      card: {
        cardNumber:  card.card_number,
        holderName:  card.holder_name  || '',
        holderPhone: card.holder_phone || '',
        holderEmail: card.holder_email || '',
        tier:        card.tier,
        balance:     parseFloat(card.balance),
        totalLoaded: parseFloat(card.total_loaded),
        totalSpent:  parseFloat(card.total_spent),
        totalSaved:  parseFloat(card.total_saved),
        discountPct: parseFloat(card.discount_pct),
        status:      card.status,
      }
    });
  }

  // ── cardPortalData ──────────────────────────────────────────────────────────
  if (action === 'cardPortalData') {
    const { cardNumber, sessionToken } = body;
    if (!cardNumber) return res.status(400).json({ ok: false, error: 'cardNumber required' });
    const sessR = await verifyPortalSession(sessionToken, cardNumber);
    if (!sessR.ok) return res.status(401).json({ ok: false, error: sessR.error });

    const [cardR, txnR, reqR] = await Promise.all([
      supaFetch(`${SUPABASE_URL}/rest/v1/yani_cards?card_number=eq.${encodeURIComponent(cardNumber)}&select=card_number,holder_name,tier,balance,total_loaded,total_spent,total_saved,discount_pct,qr_token,status&limit=1`),
      supaFetch(`${SUPABASE_URL}/rest/v1/card_transactions?card_number=eq.${encodeURIComponent(cardNumber)}&order=created_at.desc&limit=50&select=type,amount,discount_amount,balance_before,balance_after,order_id,description,created_at`),
      supaFetch(`${SUPABASE_URL}/rest/v1/card_load_requests?card_number=eq.${encodeURIComponent(cardNumber)}&order=requested_at.desc&limit=10&select=id,amount,payment_method,status,rejection_reason,requested_at,reviewed_at`),
    ]);

    if (!cardR.ok || !cardR.data?.length)
      return res.status(404).json({ ok: false, error: 'Card not found' });

    // Fetch leaf balance from loyalty_accounts
    let leafBalance = 0;
    let leafTier = 'BRONZE';
    try {
      const loyaltyR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/loyalty_accounts?linked_card_number=eq.${encodeURIComponent(cardNumber)}&select=points_balance,tier&limit=1`
      );
      if (loyaltyR.ok && loyaltyR.data?.length) {
        leafBalance = parseInt(loyaltyR.data[0].points_balance) || 0;
        leafTier    = loyaltyR.data[0].tier || 'BRONZE';
      }
    } catch(_) {}

    // Fetch leaf rewards tiers
    let leafRewards = [];
    try {
      const rewardsR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/leaf_rewards?is_active=eq.true&order=tier_order.asc&select=tier_order,threshold,reward_name,reward_emoji`
      );
      if (rewardsR.ok && rewardsR.data) leafRewards = rewardsR.data;
    } catch(_) {}

    const card = cardR.data[0];
    return res.status(200).json({
      ok: true,
      card: {
        cardNumber:  card.card_number,
        holderName:  card.holder_name || '',
        tier:        card.tier,
        balance:     parseFloat(card.balance),
        totalLoaded: parseFloat(card.total_loaded),
        totalSpent:  parseFloat(card.total_spent),
        totalSaved:  parseFloat(card.total_saved),
        discountPct: parseFloat(card.discount_pct),
        qrToken:     card.qr_token,
        status:      card.status,
        leafBalance,
        leafTier,
      },
      leafRewards,
      transactions: (txnR.ok && txnR.data) ? txnR.data.map(t => ({
        type:          t.type,
        amount:        parseFloat(t.amount),
        discountAmt:   parseFloat(t.discount_amount || 0),
        balanceBefore: parseFloat(t.balance_before),
        balanceAfter:  parseFloat(t.balance_after),
        orderId:       t.order_id || null,
        description:   t.description || '',
        date:          t.created_at,
      })) : [],
      loadRequests: (reqR.ok && reqR.data) ? reqR.data : [],
    });
  }

  // ── requestCardLoad ─────────────────────────────────────────────────────────
  if (action === 'requestCardLoad') {
    const { cardNumber, sessionToken, amount, paymentMethod, proofBase64, proofExt, tncAccepted, tncVersion } = body;
    if (!cardNumber) return res.status(400).json({ ok: false, error: 'cardNumber required' });
    const sessR = await verifyPortalSession(sessionToken, cardNumber);
    if (!sessR.ok) return res.status(401).json({ ok: false, error: sessR.error });

    // ── Mandatory T&C confirmation before reload (legal compliance) ──────────
    if (tncAccepted !== true) {
      return res.status(400).json({ ok: false, error: 'Please confirm you agree to the reload terms before proceeding.', code: 'TNC_REQUIRED' });
    }

    const amt = parseFloat(amount);
    if (isNaN(amt) || amt < 1 || amt > 10000)
      return res.status(400).json({ ok: false, error: 'Reload amount must be between ₱1 and ₱10,000' });
    const VALID_METHODS = ['GCASH','BDO','BPI','UNIONBANK','INSTAPAY','QR'];
    const method = String(paymentMethod || 'GCASH').toUpperCase();
    if (!VALID_METHODS.includes(method))
      return res.status(400).json({ ok: false, error: 'Invalid payment method' });

    // Check not too many pending requests
    const pendingR = await supaFetch(
      `${SUPABASE_URL}/rest/v1/card_load_requests?card_number=eq.${encodeURIComponent(cardNumber)}&status=eq.PENDING&select=id`
    );
    if (pendingR.ok && pendingR.data?.length >= 3)
      return res.status(429).json({ ok: false, error: 'You already have 3 pending load requests. Wait for staff to process them first.' });

    // Upload proof if provided
    let proofUrl = null, proofFilename = null;
    if (proofBase64 && proofExt) {
      try {
        const ext      = String(proofExt).toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,4) || 'jpg';
        const filename = `CARDLOAD_${cardNumber.replace('-','')}_${Date.now()}.${ext}`;
        const bucket   = 'menu-images';
        const imgBuf   = Buffer.from(proofBase64, 'base64');
        const upR = await fetch(
          `${SUPABASE_URL}/storage/v1/object/${bucket}/${filename}`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
              'apikey':        process.env.SUPABASE_SECRET_KEY,
              'Content-Type':  ext === 'png' ? 'image/png' : 'image/jpeg',
              'x-upsert':      'true',
              'Cache-Control': '3600',
            },
            body: imgBuf,
          }
        );
        if (upR.ok) {
          proofUrl      = `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${filename}`;
          proofFilename = filename;
        }
      } catch(e) { console.error('Proof upload error:', e.message); }
    }

    const cardInfoR = await supaFetch(
      `${SUPABASE_URL}/rest/v1/yani_cards?card_number=eq.${encodeURIComponent(cardNumber)}&select=holder_name&limit=1`
    );
    const holderName = cardInfoR.data?.[0]?.holder_name || '';

    const reqR = await supa('POST','card_load_requests',{
      card_number:    cardNumber,
      holder_name:    holderName,
      amount:         amt,
      payment_method: method,
      proof_url:      proofUrl,
      proof_filename: proofFilename,
      status:         'PENDING',
    });
    if (!reqR.ok)
      return res.status(500).json({ ok: false, error: 'Failed to submit load request' });

    auditLog({ action: 'CARD_LOAD_REQUESTED', details: { cardNumber, amount: amt, method } });

    // ── Record T&C acceptance for this reload (append-only audit) ────────────
    try {
      await supaFetch(`${SUPABASE_URL}/rest/v1/tnc_acceptances`, {
        method: 'POST',
        headers: { 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          context:     'RELOAD',
          tnc_version: String(tncVersion || TNC_VERSION),
          card_number: cardNumber,
          amount:      amt,
          order_ref:   reqR.data?.[0]?.id || null,
          user_agent:  String(req?.headers?.['user-agent'] || '').substring(0, 300),
          ip_hint:     String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].substring(0, 60) || null,
        })
      });
    } catch(e) { console.error('T&C acceptance log (reload) failed:', e.message); }

    return res.status(200).json({ ok: true, message: `Load request for ₱${amt} submitted. Staff will credit your card shortly.`, requestId: reqR.data?.[0]?.id });
  }

  // ── getCardLoadRequests (ADMIN) ─────────────────────────────────────────────
  if (action === 'getCardLoadRequests') {
    const { checkAdminAuth } = auth;
    const authR = await checkAdminAuth();
    if (!authR.ok) return res.status(403).json({ ok: false, error: authR.error });

    const status = body.status || 'PENDING';
    const cardFilter = body.cardNumber
      ? `&card_number=eq.${encodeURIComponent(String(body.cardNumber).toUpperCase())}`
      : '';
    const url = status === 'ALL'
      ? `${SUPABASE_URL}/rest/v1/card_load_requests?order=requested_at.desc&limit=100&select=*${cardFilter}`
      : `${SUPABASE_URL}/rest/v1/card_load_requests?status=eq.${status}&order=requested_at.desc&limit=100&select=*${cardFilter}`;
    const r = await supaFetch(url);
    return res.status(200).json({ ok: true, requests: r.ok ? r.data : [] });
  }

  // ── approveCardLoad (ADMIN) ─────────────────────────────────────────────────
  if (action === 'approveCardLoad') {
    const { checkAdminAuth } = auth;
    const authR = await checkAdminAuth();
    if (!authR.ok) return res.status(403).json({ ok: false, error: authR.error });

    const reqId = String(body.requestId || '').trim();
    if (!reqId) return res.status(400).json({ ok: false, error: 'requestId required' });

    const reqR = await supaFetch(
      `${SUPABASE_URL}/rest/v1/card_load_requests?id=eq.${encodeURIComponent(reqId)}&select=*&limit=1`
    );
    if (!reqR.ok || !reqR.data?.length)
      return res.status(404).json({ ok: false, error: 'Load request not found' });

    const req = reqR.data[0];
    if (req.status !== 'PENDING')
      return res.status(400).json({ ok: false, error: `Request is already ${req.status}` });

    // Credit card balance using the proper reloadCard flow
    // (updates total_loaded, total_saved, fires email, credits leaves)
    const CARD_API = `${SUPABASE_URL.replace('supabase.co','supabase.co')}`; // same host
    const reloadR = await supaFetch(`${SUPABASE_URL}/rest/v1/rpc/reload_card`, {
      method: 'POST',
      body: JSON.stringify({
        p_card_number:  req.card_number,
        p_amount:       parseFloat(req.amount),
        p_performed_by: body.userId || 'STAFF',
      })
    });
    if (!reloadR.ok || reloadR.data?.ok === false)
      return res.status(500).json({ ok: false, error: 'Failed to credit card: ' + (reloadR.data?.error || '') });

    // Update request status
    await supa('PATCH','card_load_requests',
      { status: 'APPROVED', reviewed_by: body.userId, reviewed_at: new Date().toISOString(), txn_id: reloadR.data?.txn_id || null },
      { id: `eq.${reqId}` }
    );
    // reload_card RPC already handles balance, total_loaded, total_saved

    auditLog({ action: 'CARD_LOAD_APPROVED', actor: { userId: body.userId }, details: { cardNumber: req.card_number, amount: req.amount, reqId } });
    return res.status(200).json({ ok: true, cardNumber: req.card_number, amount: req.amount, newBalance: reloadR.data?.balance_after });
  }

  // ── rejectCardLoad (ADMIN) ──────────────────────────────────────────────────
  if (action === 'rejectCardLoad') {
    const { checkAdminAuth } = auth;
    const authR = await checkAdminAuth();
    if (!authR.ok) return res.status(403).json({ ok: false, error: authR.error });

    const reqId  = String(body.requestId || '').trim();
    const reason = String(body.reason || '').trim().slice(0, 200);
    if (!reqId)  return res.status(400).json({ ok: false, error: 'requestId required' });
    if (!reason) return res.status(400).json({ ok: false, error: 'reason required' });

    const reqR = await supaFetch(
      `${SUPABASE_URL}/rest/v1/card_load_requests?id=eq.${encodeURIComponent(reqId)}&select=status,card_number,amount&limit=1`
    );
    if (!reqR.ok || !reqR.data?.length)
      return res.status(404).json({ ok: false, error: 'Request not found' });
    if (reqR.data[0].status !== 'PENDING')
      return res.status(400).json({ ok: false, error: `Request already ${reqR.data[0].status}` });

    await supa('PATCH','card_load_requests',
      { status: 'REJECTED', rejection_reason: reason, reviewed_by: body.userId, reviewed_at: new Date().toISOString() },
      { id: `eq.${reqId}` }
    );
    auditLog({ action: 'CARD_LOAD_REJECTED', actor: { userId: body.userId }, details: { reqId, reason, cardNumber: reqR.data[0].card_number } });
    return res.status(200).json({ ok: true, reqId, reason });
  }

  return false;
}
