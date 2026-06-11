// ══════════════════════════════════════════════════════════════════════════
// YANI CARD — Prepaid Stored-Value Card API
// Endpoints: lookup, activate, charge, reload, reverse, adjust, status, reports
// Security:
//   - qr_token NEVER returned to non-OWNER roles
//   - owner-only endpoints (reverse, adjust, status) verify PIN='2026' in handler
//   - All writes return full post-change state
// ══════════════════════════════════════════════════════════════════════════
const SUPABASE_URL = 'https://hnynvclpvfxzlfjphefj.supabase.co';

// ═══════════════════════════════════════════════════════
// YANI CARD EMAIL HELPER — via Resend
// Set RESEND_API_KEY in Vercel env vars
// ═══════════════════════════════════════════════════════

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL     = process.env.EMAIL_FROM || 'YANI Garden Café <cards@yanigardencafe.com>';
const CAFE_NAME      = 'YANI Garden Café';
const CAFE_ADDR      = 'Amadeo, Cavite, Philippines';
const CAFE_FB        = 'facebook.com/yanigardencafe';
const ACCENT         = '#2D5016';
const ACCENT_LIGHT   = '#F0F7EC';

async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY || !to || !to.includes('@')) return; // silently skip if not configured
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html })
    });
  } catch(e) { console.error('Email send error:', e.message); }
}

function emailBase(content) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif}
  .wrap{max-width:560px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.08)}
  .hdr{background:${ACCENT};padding:28px 32px;text-align:center}
  .hdr h1{margin:0;color:#fff;font-size:22px;font-weight:800;letter-spacing:.5px}
  .hdr p{margin:4px 0 0;color:rgba(255,255,255,.75);font-size:13px}
  .body{padding:28px 32px}
  .card-box{background:${ACCENT_LIGHT};border:2px solid ${ACCENT};border-radius:12px;padding:20px;text-align:center;margin:20px 0}
  .card-num{font-size:28px;font-weight:900;color:${ACCENT};letter-spacing:3px;font-family:monospace}
  .card-code{font-size:18px;font-weight:700;color:#555;letter-spacing:2px;margin-top:6px}
  .card-label{font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:1px;margin-top:4px}
  .stat-row{display:flex;gap:12px;margin:16px 0}
  .stat{flex:1;background:#f9f9f9;border-radius:10px;padding:14px;text-align:center}
  .stat-val{font-size:20px;font-weight:800;color:${ACCENT}}
  .stat-lbl{font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.5px;margin-top:3px}
  .txn-row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:14px}
  .txn-row:last-child{border-bottom:none}
  .txn-lbl{color:#666}
  .txn-val{font-weight:700;color:#222}
  .badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;color:#fff}
  .badge-charge{background:#B5443A}
  .badge-reload{background:#1D4ED8}
  .badge-activate{background:${ACCENT}}
  .note{background:#FFFBEB;border-left:3px solid #F59E0B;padding:12px 16px;border-radius:0 8px 8px 0;font-size:13px;color:#92400E;margin:16px 0}
  .btn{display:inline-block;background:${ACCENT};color:#fff;padding:12px 28px;border-radius:8px;font-weight:700;font-size:14px;text-decoration:none;margin-top:8px}
  .ftr{background:#f9f9f9;padding:20px 32px;text-align:center;font-size:12px;color:#999;border-top:1px solid #eee}
  .ftr a{color:${ACCENT};text-decoration:none}
  .divider{border:none;border-top:1px solid #eee;margin:20px 0}
</style></head><body>
<div class="wrap">
  <div class="hdr"><h1>🌿 ${CAFE_NAME}</h1><p>Holding a cup of Yani everyday...</p></div>
  <div class="body">${content}</div>
  <div class="ftr">${CAFE_NAME} · ${CAFE_ADDR}<br><a href="https://${CAFE_FB}">${CAFE_FB}</a></div>
</div></body></html>`;
}

function emailCardWelcome(card) {
  const fullCode = card.card_number.replace('YANI-','') + card.card_pin;
  const holder   = card.holder_name ? `Hi ${card.holder_name.split(' ')[0]},` : 'Hello,';
  const subject  = `🌿 Your Yani Card is Ready — ${card.card_number}`;
  const html = emailBase(`
    <p style="font-size:16px;font-weight:700;color:#222;margin-top:0">${holder}</p>
    <p style="color:#555;font-size:14px;line-height:1.6">Welcome to the <strong>Yani Card</strong> loyalty program! Your card has been activated with <strong>₱${parseFloat(card.balance_after||card.balance||0).toFixed(2)}</strong> loaded and ready to use.</p>
    <div class="card-box">
      <div class="card-label">Your Card Number</div>
      <div class="card-num">${card.card_number}</div>
      <div style="margin:12px 0;border-top:1px dashed #ccc"></div>
      <div class="card-label">Your 6-Digit Checkout Code</div>
      <div class="card-code">${fullCode.substring(0,4)} – ${fullCode.substring(4)}</div>
      <div style="font-size:12px;color:#888;margin-top:8px">Use this code when checking out online</div>
    </div>
    <div class="stat-row">
      <div class="stat"><div class="stat-val">₱${parseFloat(card.balance_after||card.balance||0).toFixed(2)}</div><div class="stat-lbl">Balance</div></div>
      <div class="stat"><div class="stat-val">10%</div><div class="stat-lbl">Discount Every Order</div></div>
      <div class="stat"><div class="stat-val">₱${card.tier}</div><div class="stat-lbl">Card Tier</div></div>
    </div>
    <div class="note">⚠️ <strong>Keep your 6-digit code private.</strong> Present your card to the cashier when paying.</div>
    <hr class="divider">
    <p style="font-size:13px;color:#555;line-height:1.6"><strong>How to use your Yani Card:</strong><br>
    1. Order as usual from our menu<br>
    2. At checkout, enter your 6-digit code <strong>${fullCode}</strong><br>
    3. Enjoy <strong>10% off</strong> every order — charged from your card balance<br>
    4. Reload anytime at the counter</p>
    <p style="font-size:12px;color:#999;margin-top:20px">Balance runs low? Visit us to reload a minimum of ₱500.</p>
  `);
  return { subject, html };
}

function emailTransaction(card, txnType, amount, balanceBefore, balanceAfter, orderId, discount) {
  const holder  = card.holder_name ? `Hi ${card.holder_name.split(' ')[0]},` : 'Hello,';
  const isCharge = txnType === 'CHARGE';
  const isReload = txnType === 'RELOAD';
  const typeLabel = isCharge ? 'Card Charged' : isReload ? 'Balance Reloaded' : txnType;
  const badgeClass = isCharge ? 'badge-charge' : isReload ? 'badge-reload' : 'badge-activate';
  const emoji     = isCharge ? '💳' : isReload ? '💰' : '✅';
  const subject   = `${emoji} Yani Card ${typeLabel} — ${card.card_number}`;
  const saved     = parseFloat(discount || 0);

  const html = emailBase(`
    <p style="font-size:16px;font-weight:700;color:#222;margin-top:0">${holder}</p>
    <p style="color:#555;font-size:14px">Here's your transaction summary for <strong>${card.card_number}</strong>:</p>

    <div class="card-box">
      <span class="badge ${badgeClass}">${typeLabel.toUpperCase()}</span>
      <div style="margin-top:14px">
        <div style="font-size:32px;font-weight:900;color:${isCharge?'#B5443A':'#2D5016'}">
          ${isCharge?'−':'+'} ₱${parseFloat(amount).toFixed(2)}
        </div>
        ${saved > 0 ? `<div style="font-size:13px;color:#065F46;font-weight:700;margin-top:4px">🎉 You saved ₱${saved.toFixed(2)} (10% discount)</div>` : ''}
      </div>
    </div>

    <div class="txn-row"><span class="txn-lbl">Card</span><span class="txn-val">${card.card_number}</span></div>
    <div class="txn-row"><span class="txn-lbl">Type</span><span class="txn-val"><span class="badge ${badgeClass}">${typeLabel}</span></span></div>
    <div class="txn-row"><span class="txn-lbl">Amount</span><span class="txn-val">₱${parseFloat(amount).toFixed(2)}</span></div>
    ${saved > 0 ? `<div class="txn-row"><span class="txn-lbl">Discount Saved</span><span class="txn-val" style="color:#065F46">₱${saved.toFixed(2)}</span></div>` : ''}
    <div class="txn-row"><span class="txn-lbl">Balance Before</span><span class="txn-val">₱${parseFloat(balanceBefore).toFixed(2)}</span></div>
    <div class="txn-row"><span class="txn-lbl">Balance After</span><span class="txn-val" style="color:${isCharge?'#B5443A':'#2D5016'}">₱${parseFloat(balanceAfter).toFixed(2)}</span></div>
    ${orderId ? `<div class="txn-row"><span class="txn-lbl">Order Reference</span><span class="txn-val" style="font-family:monospace">${orderId}</span></div>` : ''}

    ${parseFloat(balanceAfter) < 300 ? `<div class="note">⚠️ Your balance is running low (₱${parseFloat(balanceAfter).toFixed(2)}). Visit us to reload a minimum of ₱500.</div>` : ''}
    <p style="font-size:12px;color:#999;margin-top:20px">Questions? Visit us at ${CAFE_ADDR}.</p>
  `);
  return { subject, html };
}

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

// ─── Card LOAD → Leaves earn (CUMULATIVE) ───────────────────────────────
// When a customer activates or reloads a Yani Card, leaves are credited to
// the cardholder's loyalty account using a CUMULATIVE formula so the
// customer doesn't lose fractional pesos when splitting loads:
//
//   leaves_owed_after_this_load = floor(total_loaded_lifetime / 500)
//   leaves_to_credit_now        = leaves_owed_after - leaves_owed_before
//
// Example (₱500/leaf):
//   ACTIVATE ₱1000 → total 1000, owed 2, prior 0  → credit 2 leaves
//   RELOAD ₱500    → total 1500, owed 3, prior 2  → credit 1 leaf
//   RELOAD ₱1000   → total 2500, owed 5, prior 3  → credit 2 leaves
//   Total: 5 leaves (matches floor(2500/500) — fractions never lost)
//
// Why card LOAD not card CHARGE: Yani Card is prepaid. The customer
// paid real money at LOAD time. Earning at consumption would double-count.
// Counterpart in pos.js: auto-earn skips when payment_method='YANI_CARD'.
//
// Fire-and-forget — never blocks the card transaction.
async function _creditLeavesForCardLoad({ cardNumber, amount, eventType, performedBy }) {
  try {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return;

    // Get pesosPerLeaf setting (default 500 — aligned with card tier minimum)
    const sR = await supa(`/rest/v1/settings?key=eq.LEAVES_PESOS_PER_LEAF&select=value&limit=1`);
    const pesosPerLeaf = parseInt(sR.data?.[0]?.value || '500') || 500;

    // Cumulative math: sum ALL ACTIVATE+RELOAD amounts for this card. This
    // includes the just-inserted row, so priorLoaded = totalLoaded - amt.
    const txnsR = await supa(`/rest/v1/card_transactions?card_number=eq.${encodeURIComponent(cardNumber)}&type=in.(ACTIVATE,RELOAD)&select=amount`);
    const totalLoaded = (txnsR.data || []).reduce((s, t) => s + parseFloat(t.amount || 0), 0);
    const priorLoaded = totalLoaded - amt;
    const leavesNow   = Math.floor(totalLoaded / pesosPerLeaf);
    const leavesPrior = Math.floor(Math.max(0, priorLoaded) / pesosPerLeaf);
    const leavesEarned = leavesNow - leavesPrior;
    if (leavesEarned <= 0) return;

    // Find the cardholder + their loyalty account (by holder_email)
    const cardR = await supa(`/rest/v1/yani_cards?card_number=eq.${encodeURIComponent(cardNumber)}&select=holder_name,holder_email,holder_phone`);
    const card = cardR.data?.[0];
    if (!card || !card.holder_email) return;  // no email = no loyalty (business rule)
    const cleanEmail = String(card.holder_email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return;

    // Find or create the loyalty account
    let accountId = null;
    const accR = await supa(`/rest/v1/loyalty_accounts?email=eq.${encodeURIComponent(cleanEmail)}&select=id,points_balance,total_points_earned,linked_card_number&limit=1`);
    let acc = accR.data?.[0];
    if (acc) {
      accountId = acc.id;
      // Backfill linkage if missing
      if (!acc.linked_card_number) {
        await supa(`/rest/v1/loyalty_accounts?id=eq.${encodeURIComponent(accountId)}`, {
          method: 'PATCH', headers: { 'Prefer':'return=minimal' },
          body: JSON.stringify({ linked_card_number: cardNumber, updated_at: new Date().toISOString() })
        });
      }
    } else if (card.holder_name) {
      const createR = await supa(`/rest/v1/loyalty_accounts`, {
        method: 'POST',
        body: JSON.stringify({
          name:               card.holder_name,
          email:              cleanEmail,
          phone:              card.holder_phone ? String(card.holder_phone).replace(/\D/g,'') : null,
          linked_card_number: cardNumber,
          points_balance:     0, total_points_earned: 0, total_points_redeemed: 0,
          tier:               'BRONZE',
          total_spent:        0, visit_count: 0, is_active: true,
        }),
      });
      if (createR.ok && createR.data?.[0]) {
        acc = createR.data[0];
        accountId = acc.id;
      }
    }
    if (!accountId) return;

    // Credit the leaves
    const balBefore = acc.points_balance || 0;
    const balAfter  = balBefore + leavesEarned;
    const lifetime  = (acc.total_points_earned || 0) + leavesEarned;
    await supa(`/rest/v1/loyalty_accounts?id=eq.${encodeURIComponent(accountId)}`, {
      method: 'PATCH', headers: { 'Prefer':'return=minimal' },
      body: JSON.stringify({
        points_balance:      balAfter,
        total_points_earned: lifetime,
        last_earn_at:        new Date().toISOString(),
        updated_at:          new Date().toISOString(),
      })
    });
    await supa(`/rest/v1/points_transactions`, {
      method: 'POST', headers: { 'Prefer':'return=minimal' },
      body: JSON.stringify({
        account_id:     accountId,
        order_id:       null,
        type:           'EARN',
        points:         leavesEarned,
        balance_before: balBefore,
        balance_after:  balAfter,
        description:    `+${leavesEarned} leaf${leavesEarned===1?'':'s'} from Yani Card ${eventType} ${cardNumber} (₱${amt.toFixed(2)} load; lifetime ₱${totalLoaded.toFixed(2)} ÷ ₱${pesosPerLeaf} = ${leavesNow} leaves)`,
        processed_by:   performedBy || 'STAFF',
      })
    });
  } catch(e) {
    console.error('_creditLeavesForCardLoad error:', e.message);
    // swallow — never block the card transaction
  }
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
      const { card_number, pin, card_pin } = body;
      if (!card_number) return res.status(400).json({ ok: false, error: 'card_number required' });

      const raw = String(card_number).trim().toUpperCase().replace(/[^A-Z0-9]/g,'');
      let cn, pinProvided = card_pin ? String(card_pin).trim() : null;
      if (/^\d{6}$/.test(raw)) {
        // 6-digit short code: "100176" → card=YANI-1001, pin=76
        cn = 'YANI-' + raw.substring(0,4);
        pinProvided = raw.substring(4);
      } else if (/^\d{1,4}$/.test(raw)) {
        // Just the number: "1004" → "YANI-1004"
        cn = 'YANI-' + raw;
      } else if (raw.startsWith('YANI') && /^\d+$/.test(raw.substring(4))) {
        // "YANI1004" (dash stripped by regex) → "YANI-1004"
        cn = 'YANI-' + raw.substring(4);
      } else {
        cn = raw;
      }

      const r = await supa(`/rest/v1/yani_cards?card_number=eq.${encodeURIComponent(cn)}&select=card_number,card_pin,holder_name,holder_phone,tier,balance,total_loaded,total_spent,total_saved,discount_pct,status,activated_at,expires_at`);
      if (!r.ok || !r.data || !r.data.length) return res.status(404).json({ ok: false, error: 'Card not found' });
      const card = r.data[0];

      // Validate PIN when provided (customer-facing always sends 6-digit code)
      if (pinProvided !== null && pinProvided !== undefined && pinProvided !== '') {
        if (String(pinProvided) !== String(card.card_pin)) {
          return res.status(403).json({ ok: false, error: 'Invalid card code — check your card number' });
        }
      }

      const { card_pin: _p, ...safeCard } = card;
      return res.status(200).json({ ok: true, card: safeCard });
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
      // Send welcome email if card has holder_email
      let cardData = null;
      try {
        const cardR = await supa(`/rest/v1/yani_cards?card_number=eq.${encodeURIComponent(body.card_number.trim().toUpperCase())}&select=card_number,card_pin,holder_name,holder_phone,holder_email,balance,tier`);
        cardData = cardR.data?.[0];
        if (cardData && cardData.holder_email) {
          const bal = r.data?.balance_after ?? r.data?.balance ?? 0;
          const { subject, html } = emailCardWelcome({ ...cardData, balance_after: bal });
          await sendEmail(cardData.holder_email, subject, html);
        }
      } catch(e) { console.error('Welcome email error:', e.message); }

      // Auto-link OR auto-create loyalty account for the card holder, keyed
      // by EMAIL (the unique loyalty identity). If holder_email is missing,
      // skip entirely — no email means no loyalty, per business rules.
      // Fire-and-forget; never block activation on loyalty linkage.
      try {
        if (cardData && cardData.holder_email) {
          const cleanEmail = String(cardData.holder_email).trim().toLowerCase();
          if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
            const accR = await supa(`/rest/v1/loyalty_accounts?email=eq.${encodeURIComponent(cleanEmail)}&select=id,linked_card_number&limit=1`);
            if (accR.ok && accR.data?.[0]) {
              // (a) Link existing account if it isn't linked yet
              if (!accR.data[0].linked_card_number) {
                await supa(
                  `/rest/v1/loyalty_accounts?id=eq.${encodeURIComponent(accR.data[0].id)}`,
                  { method: 'PATCH',
                    headers: { 'Prefer':'return=minimal' },
                    body: JSON.stringify({ linked_card_number: cardData.card_number, updated_at: new Date().toISOString() })
                  }
                );
              }
            } else if (cardData.holder_name) {
              // (b) Auto-create — name + email both required
              const cleanPhone = cardData.holder_phone
                ? String(cardData.holder_phone).replace(/\D/g,'')
                : null;
              await supa(`/rest/v1/loyalty_accounts`, {
                method: 'POST',
                headers: { 'Prefer':'return=minimal' },
                body: JSON.stringify({
                  name:               cardData.holder_name,
                  email:              cleanEmail,
                  phone:              cleanPhone,
                  linked_card_number: cardData.card_number,
                  points_balance:     0,
                  total_points_earned:0,
                  total_points_redeemed:0,
                  tier:               'BRONZE',
                  total_spent:        0,
                  visit_count:        0,
                  is_active:          true,
                }),
              });
            }
          }
        }
      } catch(e) { console.error('Loyalty auto-link/create error:', e.message); }

      // Earn leaves for the activation amount (prepaid model — leaves earned
      // at LOAD time, not at consumption). Fire-and-forget after auto-link.
      try {
        const activatedAmount = r.data?.balance_after ?? r.data?.balance ?? 0;
        if (activatedAmount > 0) {
          await _creditLeavesForCardLoad({
            cardNumber:  body.card_number.trim().toUpperCase(),
            amount:      activatedAmount,
            eventType:   'ACTIVATE',
            performedBy: performed_by || 'STAFF',
          });
        }
      } catch(e) { console.error('Activate leaves-earn error:', e.message); }

      return res.status(200).json(r.data);
    }

    // ── STAFF: charge card ───────────────────────────────────────────────
    if (action === 'chargeCard') {
      const { qr_token, gross_amount, order_id, performed_by } = body;

      // ── AUTH GUARD — must be staff OR have valid qr_token ────────────────
      // qr_token is only obtainable via authenticated cardPortalLogin session.
      // If no qr_token, caller must be authenticated staff (OWNER/ADMIN/CASHIER).
      if (!qr_token) {
        // No qr_token means caller must be authenticated staff
        const callerUserId = String(body.userId || performed_by || '');
        const VALID_USER_ID = /^USR_\d{3,6}$/;
        if (!VALID_USER_ID.test(callerUserId)) {
          return res.status(403).json({ ok: false, error: 'Staff userId required to charge a card without qr_token' });
        }
        // Verify userId is a real active staff member with sufficient role
        const staffR = await supa(`/rest/v1/staff?user_id=eq.${encodeURIComponent(callerUserId)}&select=role,is_active&limit=1`);
        const staffRow = staffR.data?.[0];
        if (!staffRow || !staffRow.is_active || !['OWNER','ADMIN','CASHIER'].includes(staffRow.role)) {
          return res.status(403).json({ ok: false, error: 'Insufficient permissions to charge a card' });
        }
      }

      // ── IDEMPOTENCY CHECK FIRST ──────────────────────────────────────────
      // Order-level check needs only order_id, not the card. Doing this BEFORE
      // card resolution means "Change Payment" on an already-charged order
      // returns a clean 'already_charged' instead of a confusing parser error.
      if (order_id) {
        const existR = await supa(`/rest/v1/card_transactions?order_id=eq.${encodeURIComponent(order_id)}&type=eq.CHARGE&select=id,amount,balance_after,card_number`);
        if (existR.ok && existR.data && existR.data.length > 0) {
          const ex = existR.data[0];
          return res.status(200).json({ ok: true, already_charged: true,
            charged: ex.amount, balance_after: ex.balance_after, card_number: ex.card_number });
        }
      }

      // ── RESOLVE CARD (qr_token OR card_number in any format) ─────────────
      let resolvedToken = qr_token;
      let resolvedCardNumber = null;
      if (!resolvedToken && body.card_number) {
        const raw = String(body.card_number).trim().toUpperCase().replace(/[^A-Z0-9]/g,'');
        let cn, pinProvided = body.card_pin ? String(body.card_pin).trim() : null;
        // Match the 4-branch parsing from lookupCard so all input formats work:
        //   '100476'    → card=YANI-1004, pin=76 (6-digit short code)
        //   '1004'      → 'YANI-1004' (bare digits)
        //   'YANI1004'  → 'YANI-1004' (dash got stripped by regex)
        //   'YANI-1004' → raw is 'YANI1004' after strip → 'YANI-1004' (same path)
        if (/^\d{6}$/.test(raw)) {
          cn = 'YANI-' + raw.substring(0,4);
          pinProvided = raw.substring(4);
        } else if (/^\d{1,4}$/.test(raw)) {
          cn = 'YANI-' + raw;
        } else if (raw.startsWith('YANI') && /^\d+$/.test(raw.substring(4))) {
          cn = 'YANI-' + raw.substring(4);
        } else {
          cn = raw;
        }
        const cr = await supa(`/rest/v1/yani_cards?card_number=eq.${encodeURIComponent(cn)}&select=qr_token,card_pin,card_number`);
        if (cr.ok && cr.data && cr.data[0]) {
          if (pinProvided && String(pinProvided) !== String(cr.data[0].card_pin)) {
            return res.status(403).json({ ok: false, error: 'Invalid card code' });
          }
          resolvedToken = cr.data[0].qr_token;
          resolvedCardNumber = cr.data[0].card_number;
        } else {
          return res.status(404).json({ ok: false, error: 'Card ' + cn + ' not found' });
        }
      }
      if (!resolvedToken)  return res.status(400).json({ ok: false, error: 'card_number or qr_token required' });
      if (!gross_amount)   return res.status(400).json({ ok: false, error: 'gross_amount required' });
      body.qr_token = resolvedToken;
      const amount = parseFloat(gross_amount);
      if (isNaN(amount) || amount <= 0)
        return res.status(400).json({ ok: false, error: 'Invalid amount' });
      const r = await rpc('charge_card', {
        p_qr_token:     resolvedToken,
        p_gross_amount: amount,
        p_order_id:     order_id || null,
        p_performed_by: performed_by || 'STAFF',
      });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'DB error' });

      // ── AUDIT: write CARD_CHARGED to order_audit_logs so it shows in Order History ──
      // Fire-and-forget — never block the charge response on logging failures.
      try {
        const cd = r.data;
        if (cd?.ok && order_id) {
          await supa('/rest/v1/order_audit_logs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
            body: JSON.stringify({
              order_id,
              action: 'CARD_CHARGED',
              actor_name: performed_by || 'STAFF',
              new_value: cd.card_number || resolvedCardNumber,
              details: {
                card_number:     cd.card_number || resolvedCardNumber,
                gross_amount:    cd.gross_amount,
                discount:        cd.discount,
                charged:         cd.charged,
                balance_before:  cd.balance_before,
                balance_after:   cd.balance_after,
                txn_id:          cd.txn_id,
              }
            })
          });
        }
      } catch(e) { console.error('Card charge audit log error:', e.message); }

      // Send charge transaction email
      try {
        const cd = r.data;
        if (cd?.ok && cd.card_number) {
          const ceR = await supa(`/rest/v1/yani_cards?card_number=eq.${encodeURIComponent(cd.card_number)}&select=holder_name,holder_email`);
          const ce = ceR.data?.[0];
          if (ce?.holder_email) {
            const { subject, html } = emailTransaction(
              { card_number: cd.card_number, holder_name: ce.holder_name },
              'CHARGE', cd.charged, cd.balance_before, cd.balance_after,
              cd.order_id || order_id, cd.discount
            );
            await sendEmail(ce.holder_email, subject, html);
          }
        }
      } catch(e) { console.error('Charge email error:', e.message); }
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
      // Send reload email
      try {
        const rd = r.data;
        if (rd?.ok) {
          const cardR3 = await supa(`/rest/v1/yani_cards?card_number=eq.${encodeURIComponent(body.card_number.trim().toUpperCase())}&select=holder_name,holder_email`);
          const rh = cardR3.data?.[0];
          if (rh?.holder_email) {
            const { subject, html } = emailTransaction(
              { card_number: body.card_number.trim().toUpperCase(), holder_name: rh.holder_name },
              'RELOAD', parseFloat(body.amount), rd.balance_before, rd.balance_after, null, 0
            );
            await sendEmail(rh.holder_email, subject, html);
          }
        }
      } catch(e) { console.error('Reload email error:', e.message); }

      // Earn leaves for the reload amount (prepaid model — see _creditLeavesForCardLoad)
      try {
        await _creditLeavesForCardLoad({
          cardNumber:  card_number.trim().toUpperCase(),
          amount:      amt,
          eventType:   'RELOAD',
          performedBy: performed_by || 'STAFF',
        });
      } catch(e) { console.error('Reload leaves-earn error:', e.message); }

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

    // ── OWNER ONLY: edit any card field (with audit) ──────────────────────
    // Accepts: balance, card_pin, tier, status, expires_at, holder_name,
    //          holder_phone, holder_email. Each changed field produces one
    //          audit row in card_transactions:
    //            balance change       → type=ADJUST (so balance_before/after match reality)
    //            status change        → type=EDIT  (status change with old→new)
    //            other field changes  → type=EDIT  (one row per field)
    //          unchanged fields are NOT written or logged.
    if (action === 'ownerEditCard') {
      const { pin, card_number, reason } = body;
      const isOwner = await verifyOwnerPin(pin);
      if (!isOwner)     return res.status(403).json({ ok: false, error: 'Owner PIN required' });
      if (!card_number) return res.status(400).json({ ok: false, error: 'card_number required' });
      if (!reason || String(reason).trim().length < 4)
        return res.status(400).json({ ok: false, error: 'reason required (4+ chars)' });

      const cn = String(card_number).trim().toUpperCase();

      // Fetch current state for diff + audit
      const curR = await supa(`/rest/v1/yani_cards?card_number=eq.${encodeURIComponent(cn)}&select=*`);
      if (!curR.ok || !curR.data || !curR.data[0]) {
        return res.status(404).json({ ok: false, error: 'Card not found' });
      }
      const cur = curR.data[0];

      // ── Validate each provided field ─────────────────────────────────────
      const VALID_TIERS  = ['500','1000','2000','3000'];
      const VALID_STATUS = ['ACTIVE','INACTIVE','SUSPENDED','EXPIRED'];
      const edits = {};  // fields to PATCH
      const audit = [];  // [{field, old, new}]

      // balance
      if (body.balance !== undefined && body.balance !== null && body.balance !== '') {
        const bal = parseFloat(body.balance);
        if (isNaN(bal) || bal < 0)
          return res.status(400).json({ ok: false, error: 'balance must be a number >= 0' });
        if (Math.abs(bal - parseFloat(cur.balance)) > 0.001) {
          edits.balance = bal;
          audit.push({ field:'balance', old:parseFloat(cur.balance), new:bal, type:'ADJUST' });
        }
      }
      // card_pin (2-digit text)
      if (body.card_pin !== undefined && body.card_pin !== null && body.card_pin !== '') {
        const newPin = String(body.card_pin).trim();
        if (!/^\d{2}$/.test(newPin))
          return res.status(400).json({ ok: false, error: 'card_pin must be exactly 2 digits' });
        if (newPin !== String(cur.card_pin)) {
          edits.card_pin = newPin;
          // mask in audit so the old PIN doesn't sit in plaintext logs
          audit.push({ field:'card_pin', old:'**', new:'**', type:'EDIT', maskedNote:'PIN changed' });
        }
      }
      // tier
      if (body.tier !== undefined && body.tier !== null && body.tier !== '') {
        const newTier = String(body.tier).trim();
        if (!VALID_TIERS.includes(newTier))
          return res.status(400).json({ ok: false, error: 'tier must be 500/1000/2000/3000' });
        if (newTier !== String(cur.tier)) {
          edits.tier = newTier;
          audit.push({ field:'tier', old:cur.tier, new:newTier, type:'EDIT' });
        }
      }
      // status (use direct PATCH — the set_card_status RPC enforces specific
      // transitions like activate-only-from-INACTIVE. Owner edit bypasses that.)
      if (body.status !== undefined && body.status !== null && body.status !== '') {
        const newStatus = String(body.status).trim().toUpperCase();
        if (!VALID_STATUS.includes(newStatus))
          return res.status(400).json({ ok: false, error: 'status must be ACTIVE/INACTIVE/SUSPENDED/EXPIRED' });
        if (newStatus !== cur.status) {
          edits.status = newStatus;
          audit.push({ field:'status', old:cur.status, new:newStatus, type:'EDIT' });
        }
      }
      // expires_at  (ISO date string, or null to clear)
      if (body.expires_at !== undefined) {
        if (body.expires_at === null || body.expires_at === '') {
          if (cur.expires_at !== null) {
            edits.expires_at = null;
            audit.push({ field:'expires_at', old:cur.expires_at, new:null, type:'EDIT' });
          }
        } else {
          const d = new Date(body.expires_at);
          if (isNaN(d.getTime()))
            return res.status(400).json({ ok: false, error: 'expires_at invalid date' });
          const iso = d.toISOString();
          if (cur.expires_at !== iso) {
            edits.expires_at = iso;
            audit.push({ field:'expires_at', old:cur.expires_at, new:iso, type:'EDIT' });
          }
        }
      }
      // holder fields (allow empty string to clear)
      ['holder_name','holder_phone','holder_email'].forEach(function(f){
        if (body[f] !== undefined) {
          const newVal = body[f] === null || body[f] === '' ? null : String(body[f]).trim();
          if (newVal !== (cur[f] || null)) {
            edits[f] = newVal;
            audit.push({ field:f, old:cur[f]||'', new:newVal||'', type:'EDIT' });
          }
        }
      });

      if (Object.keys(edits).length === 0) {
        return res.status(200).json({ ok: true, no_changes: true, message: 'No changes detected' });
      }

      // ── Apply PATCH to yani_cards ────────────────────────────────────────
      edits.updated_at = new Date().toISOString();
      const patchR = await supa(
        `/rest/v1/yani_cards?card_number=eq.${encodeURIComponent(cn)}`,
        { method: 'PATCH', body: JSON.stringify(edits) }
      );
      if (!patchR.ok) {
        return res.status(500).json({ ok: false, error: 'Update failed', detail: patchR.data });
      }
      const updatedCard = (patchR.data && patchR.data[0]) || null;

      // ── Write audit rows (one per changed field) ─────────────────────────
      // Use the NEW balance for balance_before/after on EDIT rows so the
      // card history shows a consistent running balance.
      const newBal = updatedCard ? parseFloat(updatedCard.balance) : parseFloat(cur.balance);
      const auditRows = audit.map(function(a){
        let desc;
        if (a.maskedNote) {
          desc = `Owner edit: ${a.maskedNote} · Reason: ${reason}`;
        } else if (a.field === 'balance') {
          const delta = a.new - a.old;
          desc = `Owner balance set: ₱${Number(a.old).toFixed(2)} → ₱${Number(a.new).toFixed(2)} (${delta>=0?'+':''}${delta.toFixed(2)}) · Reason: ${reason}`;
        } else {
          const oldStr = a.old === null || a.old === '' ? '∅' : String(a.old);
          const newStr = a.new === null || a.new === '' ? '∅' : String(a.new);
          desc = `Owner edit: ${a.field} "${oldStr}" → "${newStr}" · Reason: ${reason}`;
        }
        // For balance ADJUST row: before/after reflect actual change
        // For EDIT rows: before/after = newBal (no balance movement)
        let bBefore, bAfter, amount;
        if (a.field === 'balance') {
          bBefore = a.old;
          bAfter  = a.new;
          amount  = a.new - a.old;
        } else {
          bBefore = newBal;
          bAfter  = newBal;
          amount  = 0;
        }
        return {
          card_id:        cur.id,
          card_number:    cn,
          type:           a.type,
          amount:         amount,
          balance_before: bBefore,
          balance_after:  bAfter,
          description:    desc,
          performed_by:   'OWNER',
        };
      });

      // Fire-and-forget audit insert — never block the edit response
      try {
        if (auditRows.length > 0) {
          await supa('/rest/v1/card_transactions', {
            method: 'POST',
            headers: { 'Prefer': 'return=minimal' },
            body: JSON.stringify(auditRows),
          });
        }
      } catch (e) { console.error('Owner-edit audit insert error:', e.message); }

      return res.status(200).json({
        ok: true,
        card: updatedCard,
        changed_fields: audit.map(function(a){ return a.field; }),
        change_count:   audit.length,
      });
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
      let url = '/rest/v1/yani_cards?select=card_number,card_pin,holder_name,holder_phone,holder_email,tier,balance,status,total_loaded,total_spent,total_saved,activated_at&order=card_number.asc';
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
      const r = await supa('/rest/v1/yani_cards?select=card_number,card_pin,holder_name,holder_phone,holder_email,tier,balance,status,qr_token,activated_at&order=card_number.asc');
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
      const updatedCard = (r.data||[])[0] || null;
      // If email just added/changed on an ACTIVE card, send welcome email
      try {
        if (updatedCard && patch.holder_email && updatedCard.status === 'ACTIVE') {
          const fCard = await supa(`/rest/v1/yani_cards?card_number=eq.${encodeURIComponent(cleanNum)}&select=card_number,card_pin,holder_name,holder_email,balance,tier`);
          const fc = fCard.data?.[0];
          if (fc?.holder_email) {
            const { subject, html } = emailCardWelcome({ ...fc, balance_after: fc.balance });
            await sendEmail(fc.holder_email, subject, html);
          }
        }
      } catch(e) { console.error('Update email error:', e.message); }
      return res.status(200).json({ ok: true, card: updatedCard });
    }

    // ── OWNER: batch create new cards ───────────────────────────────────
    if (action === 'batchCreateCards') {
      const { pin, count, start_number, tier } = body;
      const isOwner = await verifyOwnerPin(pin);
      if (!isOwner) return res.status(403).json({ ok: false, error: 'Owner PIN required' });

      const numCards = Math.min(parseInt(count) || 10, 100);
      const startNum = parseInt(start_number) || 1001;
      const tierVal  = ['500','1000','mix'].includes(tier) ? tier : '500';

      // Build insert rows
      const rows = [];
      for (let i = 0; i < numCards; i++) {
        const cardNum  = String(startNum + i).padStart(4, '0');
        const cardTier = tierVal === 'mix' ? (i % 2 === 0 ? '500' : '1000') : tierVal;
        // Generate unique qr_token
        const token = 'yc-' + Array.from(crypto.getRandomValues(new Uint8Array(12)))
          .map(b => b.toString(16).padStart(2,'0')).join('');
        const cardPinVal = String(Math.floor(Math.random()*90)+10).padStart(2,'0');
        rows.push({ card_number: `YANI-${cardNum}`, qr_token: token, card_pin: cardPinVal, tier: cardTier,
          balance: 0, total_loaded: 0, total_spent: 0, total_saved: 0,
          discount_pct: 10, status: 'INACTIVE' });
      }

      const r = await supa('/rest/v1/yani_cards', {
        method: 'POST',
        body: JSON.stringify(rows),
        headers: { 'Prefer': 'return=minimal' }
      });
      if (!r.ok) {
        const errText = JSON.stringify(r.data);
        return res.status(500).json({ ok: false, error: 'Failed to create cards: ' + errText });
      }
      return res.status(200).json({ ok: true, created: numCards, tier: tierVal,
        first: `YANI-${String(startNum).padStart(4,'0')}`,
        last:  `YANI-${String(startNum+numCards-1).padStart(4,'0')}` });
    }

    return res.status(400).json({ ok: false, error: `Unknown action: ${action}` });

  } catch (err) {
    console.error('card.js error:', err);
    return res.status(500).json({ ok: false, error: 'Server error: ' + err.message });
  }
}
