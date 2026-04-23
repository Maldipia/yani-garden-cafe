// ══════════════════════════════════════════════════════════════════════════
// YANI CARD — Prepaid Stored-Value Card API
// Endpoints: lookup, activate, charge, reload, reverse, adjust, status, reports
// Security:
//   - qr_token NEVER returned to non-OWNER roles
//   - owner-only endpoints (reverse, adjust, status) verify PIN='2026' in handler
//   - All writes return full post-change state
// ══════════════════════════════════════════════════════════════════════════
const SUPABASE_URL = 'https://hnynvclpvfxzlfjphefj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY;
const OWNER_PIN = '2026';

const ALLOWED_ORIGINS = [
  'https://yanigardencafe.com',
  'https://pos.yanigardencafe.com',
  'https://admin.yanigardencafe.com',
];

function cors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');
}

async function supa(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}${path}`, {
    ...opts,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
      ...(opts.headers || {}),
    },
  });
  const data = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, data };
}

// Call a Postgres RPC function
async function rpc(fn, params) {
  return supa(`/rest/v1/rpc/${fn}`, {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

// Verify staff PIN against DB (reuse pos.js logic via JWT check)
async function verifyOwnerPin(pin) {
  if (pin !== OWNER_PIN) return false;
  // Double-check via DB that USR_001/OWNER is active
  const r = await supa(`/rest/v1/staff_users?user_id=eq.USR_001&role=eq.OWNER&active=eq.true&select=user_id`);
  return r.ok && Array.isArray(r.data) && r.data.length > 0;
}

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Security headers
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  try {
    const { action, ...body } = req.body || {};
    if (!action) return res.status(400).json({ ok: false, error: 'action required' });

    // ── PUBLIC: lookup card by card_number (staff use) ──────────────────
    // Returns card info WITHOUT qr_token
    if (action === 'lookupCard') {
      const { card_number, pin } = body;
      if (!card_number) return res.status(400).json({ ok: false, error: 'card_number required' });
      const cleanNum = card_number.trim().toUpperCase();
      const r = await supa(`/rest/v1/yani_cards?card_number=eq.${encodeURIComponent(cleanNum)}&select=card_number,holder_name,holder_phone,tier,balance,total_loaded,total_spent,total_saved,discount_pct,status,activated_at,expires_at`);
      if (!r.ok || !r.data || r.data.length === 0)
        return res.status(404).json({ ok: false, error: 'Card not found' });
      const card = r.data[0];

      // Owner gets qr_token too
      if (pin === OWNER_PIN) {
        const ro = await supa(`/rest/v1/yani_cards?card_number=eq.${encodeURIComponent(cleanNum)}&select=qr_token`);
        if (ro.ok && ro.data && ro.data.length > 0) card.qr_token = ro.data[0].qr_token;
      }
      return res.status(200).json({ ok: true, card });
    }

    // ── PUBLIC: lookup by QR token (customer scans) ──────────────────────
    if (action === 'lookupCardByQR') {
      const { qr_token } = body;
      if (!qr_token) return res.status(400).json({ ok: false, error: 'qr_token required' });
      const r = await supa(`/rest/v1/yani_cards?qr_token=eq.${encodeURIComponent(qr_token)}&select=card_number,holder_name,tier,balance,discount_pct,status`);
      if (!r.ok || !r.data || r.data.length === 0)
        return res.status(404).json({ ok: false, error: 'Card not found' });
      return res.status(200).json({ ok: true, card: r.data[0] });
    }

    // ── STAFF: activate card ─────────────────────────────────────────────
    if (action === 'activateCard') {
      const { card_number, performed_by } = body;
      if (!card_number) return res.status(400).json({ ok: false, error: 'card_number required' });
      const r = await rpc('activate_card', {
        p_card_number: card_number.trim().toUpperCase(),
        p_performed_by: performed_by || 'STAFF',
      });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'DB error' });
      return res.status(200).json(r.data);
    }

    // ── STAFF: charge card ───────────────────────────────────────────────
    if (action === 'chargeCard') {
      const { qr_token, gross_amount, order_id, performed_by } = body;
      if (!qr_token)     return res.status(400).json({ ok: false, error: 'qr_token required' });
      if (!gross_amount) return res.status(400).json({ ok: false, error: 'gross_amount required' });
      const amount = parseFloat(gross_amount);
      if (isNaN(amount) || amount <= 0)
        return res.status(400).json({ ok: false, error: 'Invalid amount' });
      const r = await rpc('charge_card', {
        p_qr_token:     qr_token,
        p_gross_amount: amount,
        p_order_id:     order_id || null,
        p_performed_by: performed_by || 'STAFF',
      });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'DB error' });
      return res.status(200).json(r.data);
    }

    // ── STAFF: reload card ───────────────────────────────────────────────
    if (action === 'reloadCard') {
      const { card_number, amount, performed_by } = body;
      if (!card_number) return res.status(400).json({ ok: false, error: 'card_number required' });
      if (!amount)      return res.status(400).json({ ok: false, error: 'amount required' });
      const amt = parseFloat(amount);
      if (isNaN(amt) || amt <= 0)
        return res.status(400).json({ ok: false, error: 'Invalid amount' });
      const r = await rpc('reload_card', {
        p_card_number:  card_number.trim().toUpperCase(),
        p_amount:       amt,
        p_performed_by: performed_by || 'STAFF',
      });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'DB error' });
      return res.status(200).json(r.data);
    }

    // ── OWNER ONLY: reverse transaction ──────────────────────────────────
    if (action === 'reverseTransaction') {
      const { pin, txn_id, reason } = body;
      const isOwner = await verifyOwnerPin(pin);
      if (!isOwner) return res.status(403).json({ ok: false, error: 'Owner PIN required' });
      if (!txn_id)  return res.status(400).json({ ok: false, error: 'txn_id required' });
      const r = await rpc('reverse_transaction', {
        p_txn_id:       txn_id,
        p_performed_by: 'OWNER',
        p_reason:       reason || null,
      });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'DB error' });
      return res.status(200).json(r.data);
    }

    // ── OWNER ONLY: adjust balance ────────────────────────────────────────
    if (action === 'adjustCard') {
      const { pin, card_number, delta, reason } = body;
      const isOwner = await verifyOwnerPin(pin);
      if (!isOwner)    return res.status(403).json({ ok: false, error: 'Owner PIN required' });
      if (!card_number) return res.status(400).json({ ok: false, error: 'card_number required' });
      if (delta === undefined) return res.status(400).json({ ok: false, error: 'delta required' });
      if (!reason)     return res.status(400).json({ ok: false, error: 'reason required' });
      const d = parseFloat(delta);
      if (isNaN(d)) return res.status(400).json({ ok: false, error: 'Invalid delta' });
      const r = await rpc('adjust_card_balance', {
        p_card_number:  card_number.trim().toUpperCase(),
        p_delta:        d,
        p_reason:       reason,
        p_performed_by: 'OWNER',
      });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'DB error' });
      return res.status(200).json(r.data);
    }

    // ── OWNER ONLY: set card status ───────────────────────────────────────
    if (action === 'setCardStatus') {
      const { pin, card_number, status, reason } = body;
      const isOwner = await verifyOwnerPin(pin);
      if (!isOwner)    return res.status(403).json({ ok: false, error: 'Owner PIN required' });
      if (!card_number) return res.status(400).json({ ok: false, error: 'card_number required' });
      if (!status)     return res.status(400).json({ ok: false, error: 'status required' });
      const r = await rpc('set_card_status', {
        p_card_number:  card_number.trim().toUpperCase(),
        p_status:       status,
        p_reason:       reason || null,
        p_performed_by: 'OWNER',
      });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'DB error' });
      return res.status(200).json(r.data);
    }

    // ── OWNER: card transactions history ─────────────────────────────────
    if (action === 'getCardTransactions') {
      const { pin, card_number, limit = 50 } = body;
      const isOwner = await verifyOwnerPin(pin);
      if (!isOwner) return res.status(403).json({ ok: false, error: 'Owner PIN required' });
      let url = `/rest/v1/card_transactions?order=created_at.desc&limit=${parseInt(limit) || 50}`;
      if (card_number) url += `&card_number=eq.${encodeURIComponent(card_number.trim().toUpperCase())}`;
      const r = await supa(url);
      return res.status(200).json({ ok: true, transactions: r.data || [] });
    }

    // ── OWNER: list all cards ─────────────────────────────────────────────
    if (action === 'listCards') {
      const { pin, status } = body;
      const isOwner = await verifyOwnerPin(pin);
      if (!isOwner) return res.status(403).json({ ok: false, error: 'Owner PIN required' });
      let url = '/rest/v1/yani_cards?select=card_number,holder_name,holder_phone,holder_email,tier,balance,status,total_loaded,total_spent,total_saved,activated_at&order=card_number.asc';
      if (status) url += `&status=eq.${encodeURIComponent(status)}`;
      const r = await supa(url);
      return res.status(200).json({ ok: true, cards: r.data || [] });
    }

    // ── OWNER: integrity report ───────────────────────────────────────────
    if (action === 'cardIntegrityReport') {
      const { pin } = body;
      const isOwner = await verifyOwnerPin(pin);
      if (!isOwner) return res.status(403).json({ ok: false, error: 'Owner PIN required' });
      const r = await rpc('verify_card_integrity', {});
      return res.status(200).json({ ok: true, discrepancies: r.data || [] });
    }

    // ── OWNER: list all cards WITH qr_token (for printing) ──────────────
    if (action === 'listCardsWithQR') {
      const { pin } = body;
      const isOwner = await verifyOwnerPin(pin);
      if (!isOwner) return res.status(403).json({ ok: false, error: 'Owner PIN required' });
      const r = await supa('/rest/v1/yani_cards?select=card_number,holder_name,holder_phone,holder_email,tier,balance,status,qr_token,activated_at&order=card_number.asc');
      return res.status(200).json({ ok: true, cards: r.data || [] });
    }

    // ── OWNER: update card holder info ──────────────────────────────────
    if (action === 'updateCardHolder') {
      const { pin, card_number, holder_name, holder_phone, holder_email } = body;
      const isOwner = await verifyOwnerPin(pin);
      if (!isOwner) return res.status(403).json({ ok: false, error: 'Owner PIN required' });
      if (!card_number) return res.status(400).json({ ok: false, error: 'card_number required' });
      const cleanNum = card_number.trim().toUpperCase();
      const patch = {};
      if (holder_name  !== undefined) patch.holder_name  = holder_name;
      if (holder_phone !== undefined) patch.holder_phone = holder_phone;
      if (holder_email !== undefined) patch.holder_email = holder_email;
      patch.updated_at = new Date().toISOString();
      const r = await supa(
        `/rest/v1/yani_cards?card_number=eq.${encodeURIComponent(cleanNum)}`,
        { method: 'PATCH', body: JSON.stringify(patch),
          headers: { 'Prefer': 'return=representation' } }
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Update failed' });
      return res.status(200).json({ ok: true, card: (r.data||[])[0] || null });
    }

    return res.status(400).json({ ok: false, error: `Unknown action: ${action}` });

  } catch (err) {
    console.error('card.js error:', err);
    return res.status(500).json({ ok: false, error: 'Server error: ' + err.message });
  }
}
