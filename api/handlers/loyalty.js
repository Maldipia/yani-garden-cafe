// ── Loyalty action handlers ───────────────────────────────────────────────
import { supaFetch, supa, auditLog, getSetting } from '../lib/db.js';
import { _settingsCache, SETTINGS_CACHE_TTL, invalidateSettingsCache } from '../lib/cache.js';
import { signToken } from '../lib/auth.js';
import { isNonEmptyString, isValidOrderId } from '../lib/validation.js';
import { SUPABASE_URL, BUSINESS_NAME, TNC_VERSION } from '../lib/config.js';
import { _maybeFireSoulSearcher, _maybeFireRainyDay } from '../lib/loyalty-events.js';

export async function routeLoyalty(action, body, auth, req, res) {
  const { checkAuth, checkAdminAuth, jwtUser } = auth;

    if (action === 'getLoyaltySettings') {
      const keys = ['LOYALTY_ENABLED','LOYALTY_EARN_RATE','LOYALTY_REDEEM_RATE',
                    'LOYALTY_MIN_REDEEM','LOYALTY_SILVER_THRESHOLD','LOYALTY_GOLD_THRESHOLD','LOYALTY_PLATINUM_THRESHOLD'];
      const r = await supaFetch(`${SUPABASE_URL}/rest/v1/settings?key=in.(${keys.map(k=>`"${k}"`).join(',')})&select=key,value`);
      const settings = {};
      (r.data||[]).forEach(s => { settings[s.key] = s.value; });
      return res.status(200).json({ ok: true, settings });
    }

    // ── lookupLoyalty (by phone — public, used at POS checkout) ───────────
    if (action === 'lookupLoyalty') {
      // Lookup by email (primary) — phone accepted but only useful when paired
      // with a card lookup (phone alone is no longer unique across loyalty rows).
      const { email, phone } = body;
      if (!email && !phone) return res.status(400).json({ ok: false, error: 'email or phone required' });

      let r;
      if (email) {
        const cleanEmail = String(email).trim().toLowerCase();
        r = await supaFetch(`${SUPABASE_URL}/rest/v1/loyalty_accounts?email=eq.${encodeURIComponent(cleanEmail)}&select=*&limit=1`);
      } else {
        // Phone fallback (legacy callers) — returns first match only since phone
        // is no longer unique. Caller should prefer email when possible.
        const cleanPhone = String(phone).replace(/\D/g,'');
        r = await supaFetch(`${SUPABASE_URL}/rest/v1/loyalty_accounts?phone=eq.${encodeURIComponent(cleanPhone)}&select=*&order=created_at.desc&limit=1`);
      }
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Loyalty lookup failed' });
      if (!r.data?.length) return res.status(200).json({ ok: true, found: false, account: null });
      return res.status(200).json({ ok: true, account: r.data[0] });
    }

    // ── joinLoyalty (CUSTOMER-FACING — no staff auth required) ─────────────
    // Email is the unique identity for loyalty accounts (one email = one
    // account). Phone is contact-only and may be shared across people.
    // Idempotent: if email already registered, returns existing account.
    // Refuses if LOYALTY_REQUIRE_CONSENT=true and consent flag is not true.
    if (action === 'joinLoyalty') {
      const { name, email, phone, consent } = body;
      if (!name || !email) return res.status(400).json({ ok: false, error: 'name and email required' });
      const requireConsent = await getSetting('LOYALTY_REQUIRE_CONSENT');
      if (requireConsent === 'true' && consent !== true) {
        return res.status(400).json({ ok: false, error: 'Consent required to join loyalty program' });
      }
      const cleanEmail = String(email).trim().toLowerCase();
      // Basic email shape check — full RFC validation isn't worth it; this
      // catches typos like missing @ or @ with no domain.
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
        return res.status(400).json({ ok: false, error: 'Invalid email format' });
      }
      const cleanPhone = phone ? String(phone).replace(/\D/g,'') : null;

      // Idempotency: existing email returns the account as-is
      const existing = await supaFetch(`${SUPABASE_URL}/rest/v1/loyalty_accounts?email=eq.${encodeURIComponent(cleanEmail)}&select=*&limit=1`);
      if (existing.ok && existing.data?.length) {
        return res.status(200).json({ ok: true, account: existing.data[0], already_existed: true });
      }

      // Auto-link to a Yani Card if one exists with the same email.
      // Priority (when multiple cards share an email, e.g. personal +
      // business cards owned by the same person):
      //   1. ACTIVE card with holder_name matching the joining customer's name
      //   2. ACTIVE card (most recently activated)
      //   3. Any card with that email
      const allCards = await supaFetch(
        `${SUPABASE_URL}/rest/v1/yani_cards?holder_email=eq.${encodeURIComponent(cleanEmail)}&select=card_number,holder_name,status,activated_at`
      );
      let linkedCardNumber = null;
      if (allCards.ok && allCards.data?.length) {
        const cards = allCards.data;
        const cleanName = String(name).trim().toLowerCase();
        let pick = cards.find(c =>
          c.status === 'ACTIVE' &&
          c.holder_name &&
          String(c.holder_name).trim().toLowerCase() === cleanName
        );
        if (!pick) {
          const active = cards.filter(c => c.status === 'ACTIVE')
            .sort((a, b) => new Date(b.activated_at||0) - new Date(a.activated_at||0));
          pick = active[0];
        }
        if (!pick) pick = cards[0];
        if (pick) linkedCardNumber = pick.card_number;
      }

      const r = await supaFetch(`${SUPABASE_URL}/rest/v1/loyalty_accounts`, {
        method: 'POST',
        body: JSON.stringify({
          name:               String(name).trim(),
          email:              cleanEmail,
          phone:              cleanPhone,
          linked_card_number: linkedCardNumber,
          points_balance:     0,
          total_points_earned:0,
          total_points_redeemed:0,
          tier:               'BRONZE',
          total_spent:        0,
          visit_count:        0,
          is_active:          true,
        }),
        headers: { 'Prefer': 'return=representation' }
      });
      if (!r.ok) return res.status(500).json({ ok: false, error: r.data?.message || 'Failed to create account' });
      return res.status(200).json({ ok: true, account: r.data[0], already_existed: false });
    }

    // ── registerForRewards ──────────────────────────────────────────────────
    // Public endpoint used by the /rewards landing page. Same idea as
    // joinLoyalty but captures three extra signals: registration_source
    // (always 'website' here), card_tier_request (which physical card tier
    // they want, if any), and free-form signup_notes. If a card tier is
    // chosen we flip card_request_status to 'PENDING' so it lands in the
    // staff "Pending Card Requests" queue.
    //
    // Idempotency: if the email already exists we DO NOT overwrite the
    // existing account — but we do upgrade card_tier_request from NULL to
    // a chosen tier (lets a customer change their mind from "no card" to
    // "yes I want one"). We never downgrade.
    if (action === 'registerForRewards') {
      const { name, email, phone, cardTier, notes, consent, tncAccepted, tncVersion } = body;
      if (!name || !email) return res.status(400).json({ ok: false, error: 'name and email required' });
      if (consent !== true) return res.status(400).json({ ok: false, error: 'consent required' });
      // ── Mandatory T&C acceptance (legal compliance) ──────────────────────
      if (tncAccepted !== true) {
        return res.status(400).json({ ok: false, error: 'You must read and accept the YANI Card Terms & Conditions to register.', code: 'TNC_REQUIRED' });
      }

      const cleanEmail = String(email).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
        return res.status(400).json({ ok: false, error: 'Invalid email format' });
      }
      const cleanName  = String(name).trim();
      if (cleanName.length < 2 || cleanName.length > 100) {
        return res.status(400).json({ ok: false, error: 'name must be 2-100 characters' });
      }
      const cleanPhone = phone ? String(phone).replace(/\D/g,'').substring(0,13) : null;
      const cleanNotes = notes ? String(notes).trim().substring(0, 500) : null;

      // ── Record T&C acceptance (append-only audit) ────────────────────────
      // Fire-and-forget: never block registration on the audit write.
      try {
        await supaFetch(`${SUPABASE_URL}/rest/v1/tnc_acceptances`, {
          method: 'POST',
          headers: { 'Prefer': 'return=minimal' },
          body: JSON.stringify({
            context:     'REGISTRATION',
            tnc_version: String(tncVersion || TNC_VERSION),
            email:       cleanEmail,
            phone:       cleanPhone,
            user_agent:  String(req?.headers?.['user-agent'] || '').substring(0, 300),
            ip_hint:     String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].substring(0, 60) || null,
          })
        });
      } catch(e) { console.error('T&C acceptance log (registration) failed:', e.message); }

      // Validate card tier — only the four published options (or no card).
      let tierInt = null;
      if (cardTier !== undefined && cardTier !== null && cardTier !== '' && cardTier !== 0) {
        tierInt = parseInt(cardTier);
        if (![500,1000,2000,3000].includes(tierInt)) {
          return res.status(400).json({ ok: false, error: 'cardTier must be 500, 1000, 2000, or 3000' });
        }
      }

      // ─── AUTO-ASSIGN A YANI CARD ─────────────────────────────────────
      // When a customer reserves a card via /rewards, grab the next free
      // INACTIVE card from the inventory and "reserve" it by writing the
      // customer's holder_name/email/phone onto it. The card stays INACTIVE
      // (no balance, no transactions) until staff fulfills the request
      // after verifying payment — that's when it flips to ACTIVE.
      //
      // Preference order:
      //   1. INACTIVE card where tier already matches the request (no tier flip needed)
      //   2. Fallback: lowest-numbered INACTIVE card, update its tier to match
      //
      // We auto-assign for BOTH new signups and existing accounts that are
      // upgrading from no-card to wanting-card.
      async function reserveNextCard() {
        // Always reserve a slot even if no tier chosen — default to 500
        const requestedTier = tierInt || 500;
        // Try matching-tier first
        let r = await supaFetch(
          `${SUPABASE_URL}/rest/v1/yani_cards?status=eq.INACTIVE&holder_name=is.null&tier=eq.${requestedTier}&select=card_number,tier&order=card_number.asc&limit=1`
        );
        let chosen = r.ok && r.data?.[0];
        // Fallback: any INACTIVE unassigned card
        if (!chosen) {
          r = await supaFetch(
            `${SUPABASE_URL}/rest/v1/yani_cards?status=eq.INACTIVE&holder_name=is.null&select=card_number,tier&order=card_number.asc&limit=1`
          );
          chosen = r.ok && r.data?.[0];
        }
        if (!chosen) return null;  // inventory empty — staff needs to add more cards
        // Reserve it: write holder details + flip tier to requested
        const upd = await supaFetch(
          `${SUPABASE_URL}/rest/v1/yani_cards?card_number=eq.${encodeURIComponent(chosen.card_number)}`,
          {
            method: 'PATCH',
            body: JSON.stringify({
              holder_name:  cleanName,
              holder_email: cleanEmail,
              holder_phone: cleanPhone,
              tier:         String(requestedTier),
              updated_at:   new Date().toISOString(),
            }),
            headers: { 'Prefer': 'return=minimal' }
          }
        );
        if (!upd.ok) return null;
        return chosen.card_number;
      }

      // Auto-link to an EXISTING active Yani Card if one already has this email
      // (different scenario from auto-assigning a fresh card — this is a customer
      // who already had an ACTIVE card from a prior in-person activation).
      let linkedCardNumber = null;
      const allCards = await supaFetch(
        `${SUPABASE_URL}/rest/v1/yani_cards?holder_email=eq.${encodeURIComponent(cleanEmail)}&select=card_number,holder_name,status,activated_at`
      );
      if (allCards.ok && allCards.data?.length) {
        const cards = allCards.data;
        const nameLC = cleanName.toLowerCase();
        let pick = cards.find(c => c.status === 'ACTIVE' && c.holder_name && String(c.holder_name).trim().toLowerCase() === nameLC);
        if (!pick) {
          const active = cards.filter(c => c.status === 'ACTIVE').sort((a,b) => new Date(b.activated_at||0) - new Date(a.activated_at||0));
          pick = active[0] || cards[0];
        }
        if (pick) linkedCardNumber = pick.card_number;
      }

      // Idempotency: returning visitor with same email
      const existing = await supaFetch(`${SUPABASE_URL}/rest/v1/loyalty_accounts?email=eq.${encodeURIComponent(cleanEmail)}&select=*&limit=1`);
      if (existing.ok && existing.data?.length) {
        const acc = existing.data[0];
        // If they now want a card and didn't before, upgrade the request + auto-assign
        const upgrades = {};
        let reservedCardNumber = null;
        if (tierInt && !acc.card_tier_request) {
          upgrades.card_tier_request   = tierInt;
          upgrades.card_request_status = 'PENDING';
          reservedCardNumber = await reserveNextCard();
          if (reservedCardNumber && !acc.linked_card_number) {
            upgrades.linked_card_number = reservedCardNumber;
          }
        }
        if (cleanPhone && !acc.phone) upgrades.phone = cleanPhone;
        if (cleanNotes) upgrades.signup_notes = cleanNotes;
        if (Object.keys(upgrades).length) {
          await supaFetch(`${SUPABASE_URL}/rest/v1/loyalty_accounts?id=eq.${acc.id}`, {
            method: 'PATCH',
            body: JSON.stringify(upgrades),
          });
        }
        return res.status(200).json({
          ok: true,
          already_existed: true,
          account: { ...acc, ...upgrades },
          assigned_card_number: reservedCardNumber || acc.linked_card_number || null,
          message: tierInt
            ? `🌱 Welcome back, ${cleanName.split(' ')[0]}!${reservedCardNumber ? ' Card ' + reservedCardNumber + ' is reserved for you.' : ''} Visit us at YANI in Amadeo to claim your ₱${tierInt.toLocaleString()} card.`
            : `🌱 Welcome back, ${cleanName.split(' ')[0]}! Your leaves are still growing.`,
        });
      }

      // Reserve a card BEFORE inserting the loyalty_account so we can set linked_card_number atomically.
      const reservedCardNumber = await reserveNextCard();

      // New signup
      const r = await supaFetch(`${SUPABASE_URL}/rest/v1/loyalty_accounts`, {
        method: 'POST',
        body: JSON.stringify({
          name:                  cleanName,
          email:                 cleanEmail,
          phone:                 cleanPhone,
          linked_card_number:    reservedCardNumber || linkedCardNumber,
          points_balance:        0,
          total_points_earned:   0,
          total_points_redeemed: 0,
          tier:                  'BRONZE',
          total_spent:           0,
          visit_count:           0,
          is_active:             true,
          registration_source:   'website',
          card_tier_request:     tierInt,
          card_request_status:   tierInt ? 'PENDING' : null,
          signup_notes:          cleanNotes,
        }),
        headers: { 'Prefer': 'return=representation' }
      });
      if (!r.ok) {
        // Rollback the card reservation if we got one but couldn't create the account
        if (reservedCardNumber) {
          await supaFetch(`${SUPABASE_URL}/rest/v1/yani_cards?card_number=eq.${encodeURIComponent(reservedCardNumber)}`, {
            method: 'PATCH',
            body: JSON.stringify({ holder_name: null, holder_email: null, holder_phone: null }),
            headers: { 'Prefer': 'return=minimal' }
          });
        }
        return res.status(500).json({ ok: false, error: r.data?.message || 'Failed to create account' });
      }

      return res.status(200).json({
        ok: true,
        already_existed: false,
        account: r.data[0],
        assigned_card_number: reservedCardNumber || null,
        message: tierInt
          ? (reservedCardNumber
              ? `🌱 Welcome to Roots Rewards! Card ${reservedCardNumber} is reserved for you. Visit us at YANI in Amadeo to claim your ₱${tierInt.toLocaleString()} card.`
              : `🌱 Welcome to Roots Rewards! Visit us at YANI in Amadeo to claim your ₱${tierInt.toLocaleString()} card.`)
          : `🌱 Welcome to Roots Rewards! Enter your email at checkout to start earning leaves.`,
      });
    }

    // ── listPendingCardRequests (staff) ─────────────────────────────────────
    // Powers the "Pending Card Requests" badge in the admin Members hub.
    // Returns rows where someone signed up via /rewards and asked for a
    // physical card tier but hasn't been fulfilled yet.
    if (action === 'listPendingCardRequests') {
      const auth = await checkAuth(['OWNER','ADMIN','CASHIER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/loyalty_accounts?card_request_status=eq.PENDING&select=id,name,email,phone,card_tier_request,linked_card_number,signup_notes,registration_source,created_at&order=created_at.desc`
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'DB error' });
      return res.status(200).json({ ok: true, requests: r.data || [] });
    }

    // ── markCardRequestFulfilled (staff) ────────────────────────────────────
    // After staff has activated the physical card for a customer who
    // signed up online, flip their card_request_status to FULFILLED.
    if (action === 'markCardRequestFulfilled') {
      const auth = await checkAuth(['OWNER','ADMIN','CASHIER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { accountId, status } = body;
      if (!accountId) return res.status(400).json({ ok: false, error: 'accountId required' });
      const newStatus = (status === 'CANCELLED') ? 'CANCELLED' : 'FULFILLED';
      const r = await supaFetch(`${SUPABASE_URL}/rest/v1/loyalty_accounts?id=eq.${accountId}`, {
        method: 'PATCH',
        body: JSON.stringify({ card_request_status: newStatus }),
        headers: { 'Prefer': 'return=representation' }
      });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'DB error' });
      return res.status(200).json({ ok: true, account: r.data?.[0] });
    }

    // ── updateCardRequestStatus (ADMIN/OWNER — activate or cancel) ───────
    // Two paths:
    //   FULFILLED  → ACTIVATE the linked card. Sets status ACTIVE, balance
    //                = tier, total_loaded = tier, activated_at = now. Inserts
    //                an ACTIVATE row in card_transactions, credits the leaves
    //                that match floor(tier/500), and writes the EARN row to
    //                points_transactions. After this the card is fully live
    //                and the customer can transact with it.
    //   CANCELLED  → un-reserve the linked card (clear holder fields,
    //                status stays INACTIVE so it returns to the inventory).
    if (action === 'updateCardRequestStatus') {
      const auth = await checkAuth(['OWNER','ADMIN','CASHIER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });

      const { accountId, status } = body;
      if (!accountId) return res.status(400).json({ ok: false, error: 'accountId required' });
      if (!['PENDING','FULFILLED','CANCELLED'].includes(status)) {
        return res.status(400).json({ ok: false, error: 'status must be PENDING, FULFILLED, or CANCELLED' });
      }

      // Load the loyalty account to find the linked card + tier
      const accR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/loyalty_accounts?id=eq.${encodeURIComponent(accountId)}&select=*&limit=1`
      );
      const acc = accR.ok && accR.data?.[0];
      if (!acc) return res.status(404).json({ ok: false, error: 'Account not found' });

      const linkedCard = acc.linked_card_number;
      const tierStr    = acc.card_tier_request ? String(acc.card_tier_request) : null;
      const tierInt    = acc.card_tier_request ? parseInt(acc.card_tier_request) : 0;
      let activatedCardNumber = null;
      let leavesEarned = 0;

      if (status === 'FULFILLED' && linkedCard && tierInt > 0) {
        // Look up the card — must be INACTIVE (haven't been activated already)
        const cardR = await supaFetch(
          `${SUPABASE_URL}/rest/v1/yani_cards?card_number=eq.${encodeURIComponent(linkedCard)}&select=id,card_number,status,balance,total_loaded&limit=1`
        );
        const card = cardR.ok && cardR.data?.[0];
        if (card && card.status === 'INACTIVE') {
          const nowISO = new Date().toISOString();
          // 1. Activate the card
          const actR = await supaFetch(
            `${SUPABASE_URL}/rest/v1/yani_cards?card_number=eq.${encodeURIComponent(linkedCard)}`,
            {
              method: 'PATCH',
              body: JSON.stringify({
                status:        'ACTIVE',
                tier:          tierStr,
                balance:       tierInt,
                total_loaded:  tierInt,
                activated_at:  nowISO,
                updated_at:    nowISO,
              }),
              headers: { 'Prefer': 'return=minimal' }
            }
          );
          if (actR.ok) {
            activatedCardNumber = linkedCard;

            // 2. Insert ACTIVATE row in card_transactions (audit trail)
            //    card_id is NOT NULL, must include the card's uuid.
            await supaFetch(`${SUPABASE_URL}/rest/v1/card_transactions`, {
              method: 'POST',
              body: JSON.stringify({
                card_id:        card.id,
                card_number:    linkedCard,
                type:           'ACTIVATE',
                amount:         tierInt,
                balance_before: 0,
                balance_after:  tierInt,
                description:    `Card activated via /rewards web signup (₱${tierInt.toLocaleString()} initial load)`,
                performed_by:   auth.userId || 'OWNER',
                created_at:     nowISO,
              }),
              headers: { 'Prefer': 'return=minimal' }
            });

            // 3. Credit leaves: floor(tier/500). Lookup the pesos-per-leaf
            //    setting in case it ever changes (current value: 500).
            const settR = await supaFetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.LEAVES_PESOS_PER_LEAF&select=value&limit=1`);
            const pesosPerLeaf = parseInt(settR.data?.[0]?.value || '500') || 500;
            leavesEarned = Math.floor(tierInt / pesosPerLeaf);

            if (leavesEarned > 0) {
              const balBefore = parseInt(acc.points_balance || 0);
              const balAfter  = balBefore + leavesEarned;
              const liftBefore = parseInt(acc.total_points_earned || 0);
              const liftAfter  = liftBefore + leavesEarned;

              // 3a. Update loyalty_account balance + lifetime + last_earn_at
              await supaFetch(`${SUPABASE_URL}/rest/v1/loyalty_accounts?id=eq.${accountId}`, {
                method: 'PATCH',
                body: JSON.stringify({
                  points_balance:      balAfter,
                  total_points_earned: liftAfter,
                  last_earn_at:        nowISO,
                  updated_at:          nowISO,
                }),
                headers: { 'Prefer': 'return=minimal' }
              });

              // 3b. Audit row in points_transactions
              await supaFetch(`${SUPABASE_URL}/rest/v1/points_transactions`, {
                method: 'POST',
                body: JSON.stringify({
                  account_id:     accountId,
                  type:           'EARN',
                  points:         leavesEarned,
                  balance_before: balBefore,
                  balance_after:  balAfter,
                  description:    `+${leavesEarned} ${leavesEarned===1?'leaf':'leaves'} from Yani Card ${linkedCard} ACTIVATE (₱${tierInt.toLocaleString()} load; ₱${tierInt.toLocaleString()} ÷ ₱${pesosPerLeaf} = ${leavesEarned} ${leavesEarned===1?'leaf':'leaves'})`,
                  processed_by:   auth.userId || 'OWNER',
                  created_at:     nowISO,
                }),
                headers: { 'Prefer': 'return=minimal' }
              });
            }
          }
        }
      } else if (status === 'CANCELLED' && linkedCard) {
        // Un-reserve the card if it's still INACTIVE (don't touch active cards)
        const cardR = await supaFetch(
          `${SUPABASE_URL}/rest/v1/yani_cards?card_number=eq.${encodeURIComponent(linkedCard)}&select=status&limit=1`
        );
        const card = cardR.ok && cardR.data?.[0];
        if (card && card.status === 'INACTIVE') {
          await supaFetch(`${SUPABASE_URL}/rest/v1/yani_cards?card_number=eq.${encodeURIComponent(linkedCard)}`, {
            method: 'PATCH',
            body: JSON.stringify({
              holder_name:  null,
              holder_email: null,
              holder_phone: null,
              updated_at:   new Date().toISOString(),
            }),
            headers: { 'Prefer': 'return=minimal' }
          });
        }
        // Also clear linked_card_number from the loyalty_account so it's clean
        await supaFetch(`${SUPABASE_URL}/rest/v1/loyalty_accounts?id=eq.${accountId}`, {
          method: 'PATCH',
          body: JSON.stringify({ linked_card_number: null }),
          headers: { 'Prefer': 'return=minimal' }
        });
      }

      // Finally, update card_request_status
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/loyalty_accounts?id=eq.${encodeURIComponent(accountId)}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ card_request_status: status }),
          headers: { 'Prefer': 'return=representation' }
        }
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to update card request' });

      return res.status(200).json({
        ok: true,
        account: r.data?.[0] || null,
        activated_card_number: activatedCardNumber,
        leaves_earned: leavesEarned,
      });
    }

    // ── redeemPointsToCard (CUSTOMER-FACING — requires email match w/ card) ─
    // Atomic via redeem_points_to_card RPC. Deducts points + credits card balance.
    // Either:
    //   accountId + cardNumber  → direct lookup
    //   email   + cardNumber  → resolve account by email first (customer flow)
    if (action === 'redeemPointsToCard') {
      const authRPC = await checkAuth(['ADMIN', 'OWNER', 'CASHIER']);
      if (!authRPC.ok) return res.status(403).json({ ok: false, error: authRPC.error });
      let { accountId, cardNumber, points, email, performedBy } = body;
      if (!cardNumber || !points) return res.status(400).json({ ok: false, error: 'cardNumber and points required' });

      // Resolve accountId from email if not provided directly
      if (!accountId && email) {
        const cleanEmail = String(email).trim().toLowerCase();
        const accR = await supaFetch(`${SUPABASE_URL}/rest/v1/loyalty_accounts?email=eq.${encodeURIComponent(cleanEmail)}&select=id&limit=1`);
        if (accR.ok && accR.data?.length) accountId = accR.data[0].id;
      }
      if (!accountId) return res.status(400).json({ ok: false, error: 'accountId or email required' });

      // Normalize card_number: accept bare digits ("1004"), no-dash ("YANI1004"), or "YANI-1004"
      let cn = String(cardNumber).trim().toUpperCase().replace(/[^A-Z0-9]/g,'');
      if (/^\d{1,4}$/.test(cn)) cn = 'YANI-' + cn;
      else if (cn.startsWith('YANI') && /^\d+$/.test(cn.substring(4))) cn = 'YANI-' + cn.substring(4);

      const ptsInt = parseInt(points);
      if (isNaN(ptsInt) || ptsInt <= 0) return res.status(400).json({ ok: false, error: 'Invalid points amount' });

      const r = await supaFetch(`${SUPABASE_URL}/rest/v1/rpc/redeem_points_to_card`, {
        method: 'POST',
        body: JSON.stringify({
          p_account_id:   accountId,
          p_card_number:  cn,
          p_points:       ptsInt,
          p_performed_by: performedBy || 'CUSTOMER',
        }),
      });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'DB error', detail: r.data });
      return res.status(200).json(r.data);
    }

    // ── listLeafRewards (public — UI ladder display) ─────────────────────
    // Returns the active tier ladder. No auth needed since rewards are not secret.
    if (action === 'listLeafRewards') {
      const r = await supaFetch(`${SUPABASE_URL}/rest/v1/leaf_rewards?is_active=eq.true&select=tier_order,threshold,reward_name,reward_emoji,description&order=tier_order.asc`);
      if (!r.ok) return res.status(500).json({ ok: false, error: 'DB error' });
      return res.status(200).json({ ok: true, rewards: r.data || [] });
    }

    // ── getLeavesProfile (CUSTOMER-FACING — lookup by email) ─────────────
    // One-shot endpoint for the customer POS to render the leaves UI:
    // returns account, progress (next tier, leaves to next), claimed tiers,
    // pending redemptions, expiry date. Uses the account_with_progress view.
    if (action === 'getLeavesProfile') {
      const { email, accountId } = body;
      if (!email && !accountId) return res.status(400).json({ ok: false, error: 'email or accountId required' });
      let url = `${SUPABASE_URL}/rest/v1/account_with_progress?select=*&limit=1`;
      if (accountId) {
        url += `&id=eq.${encodeURIComponent(accountId)}`;
      } else {
        const cleanEmail = String(email).trim().toLowerCase();
        url += `&email=eq.${encodeURIComponent(cleanEmail)}`;
      }
      const r = await supaFetch(url);
      if (!r.ok) return res.status(500).json({ ok: false, error: 'DB error' });
      if (!r.data?.length) return res.status(200).json({ ok: true, found: false, account: null });
      return res.status(200).json({ ok: true, account: r.data[0] });
    }

    // ── claimLeafReward (STAFF-INITIATED — claim a tier on customer's behalf) ──
    // Staff at counter verifies the customer + leaves, then claims via this
    // endpoint. RPC enforces: account exists, lifetime_leaves >= threshold,
    // not already claimed; atomic via FOR UPDATE row lock; creates a
    // FULFILLED leaf_redemptions row immediately (no two-step).
    // Auth: any staff role. performedBy derived from authenticated user
    // (NOT from body — the request body cannot impersonate.)
    if (action === 'claimLeafReward') {
      const authCL = await checkAuth(['OWNER','ADMIN','CASHIER','KITCHEN']);
      if (!authCL.ok) return res.status(403).json({ ok: false, error: authCL.error || 'Auth required' });

      let { accountId, email, tierOrder, orderId: claimOrderId, notes: claimNotes } = body;
      if (!tierOrder) return res.status(400).json({ ok: false, error: 'tierOrder required' });

      if (!accountId && email) {
        const cleanEmail = String(email).trim().toLowerCase();
        const accR = await supaFetch(`${SUPABASE_URL}/rest/v1/loyalty_accounts?email=eq.${encodeURIComponent(cleanEmail)}&select=id&limit=1`);
        if (accR.ok && accR.data?.length) accountId = accR.data[0].id;
      }
      if (!accountId) return res.status(400).json({ ok: false, error: 'accountId or email required' });

      const tierInt = parseInt(tierOrder);
      if (isNaN(tierInt) || tierInt < 1) return res.status(400).json({ ok: false, error: 'Invalid tierOrder' });

      // performedBy is derived from auth, NOT request body — prevents impersonation.
      const performedBy = (authCL.role || 'STAFF') + ':' + (authCL.userId || '');

      const r = await supaFetch(`${SUPABASE_URL}/rest/v1/rpc/claim_leaf_reward`, {
        method: 'POST',
        body: JSON.stringify({
          p_account_id:   accountId,
          p_tier_order:   tierInt,
          p_performed_by: performedBy,
          p_order_id:     claimOrderId || null,
          p_notes:        claimNotes || null,
        }),
      });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'DB error', detail: r.data });

      // Audit log on success
      if (r.data && r.data.ok) {
        try {
          await supaFetch(`${SUPABASE_URL}/rest/v1/order_audit_logs`, {
            method: 'POST',
            body: JSON.stringify({
              action: 'LEAF_REWARD_CLAIMED',
              actor_name: authCL.role || 'STAFF',
              details: r.data,
            }),
          });
        } catch (e) { /* non-blocking — audit failure shouldn't roll back the claim */ }
      }

      return res.status(200).json(r.data);
    }

    // ── getMemberLeafState (STAFF — read 5-tier claim checklist) ─────────
    // Returns the per-tier state for the admin Members UI: claimed/eligible/
    // locked, plus leaves_short_by for locked tiers so we can show
    // "(needs 2 more 🍃)" inline.
    if (action === 'getMemberLeafState') {
      const authGM = await checkAuth(['OWNER','ADMIN','CASHIER','KITCHEN']);
      if (!authGM.ok) return res.status(403).json({ ok: false, error: authGM.error || 'Auth required' });
      const { accountId } = body;
      if (!accountId) return res.status(400).json({ ok: false, error: 'accountId required' });

      const r = await supaFetch(`${SUPABASE_URL}/rest/v1/rpc/get_leaf_claim_state`, {
        method: 'POST',
        body: JSON.stringify({ p_account_id: accountId }),
      });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'DB error', detail: r.data });
      return res.status(200).json(r.data);
    }

    // ── revokeLeafReward (OWNER-only — un-claim a tier within a window) ──
    // Use case: staff accidentally claimed wrong tier; owner reverts.
    // Removes tier from claimed_tiers AND marks the most recent FULFILLED
    // leaf_redemptions row as CANCELLED with audit note. Reason is required.
    if (action === 'revokeLeafReward') {
      const authRV = await checkAuth(['OWNER']);
      if (!authRV.ok) return res.status(403).json({ ok: false, error: authRV.error || 'Owner only' });
      const { accountId, tierOrder, reason } = body;
      if (!accountId) return res.status(400).json({ ok: false, error: 'accountId required' });
      if (!tierOrder) return res.status(400).json({ ok: false, error: 'tierOrder required' });
      if (!reason || !String(reason).trim()) return res.status(400).json({ ok: false, error: 'reason required' });

      const tierInt = parseInt(tierOrder);
      if (isNaN(tierInt) || tierInt < 1) return res.status(400).json({ ok: false, error: 'Invalid tierOrder' });

      const performedBy = 'OWNER:' + (authRV.userId || '');

      const r = await supaFetch(`${SUPABASE_URL}/rest/v1/rpc/revoke_leaf_reward`, {
        method: 'POST',
        body: JSON.stringify({
          p_account_id:   accountId,
          p_tier_order:   tierInt,
          p_performed_by: performedBy,
          p_reason:       String(reason).trim(),
        }),
      });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'DB error', detail: r.data });

      // Audit on success
      if (r.data && r.data.ok) {
        try {
          await supaFetch(`${SUPABASE_URL}/rest/v1/order_audit_logs`, {
            method: 'POST',
            body: JSON.stringify({
              action: 'LEAF_REWARD_REVOKED',
              actor_name: 'OWNER',
              details: r.data,
            }),
          });
        } catch (e) { /* non-blocking */ }
      }

      return res.status(200).json(r.data);
    }

    // ── fulfillLeafReward (STAFF — mark a PENDING claim as FULFILLED) ────
    // Requires staff auth (any role can fulfill, since it's a counter action).
    if (action === 'fulfillLeafReward') {
      const auth = await checkAuth(['OWNER','ADMIN','CASHIER','KITCHEN']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { redemptionId } = body;
      if (!redemptionId) return res.status(400).json({ ok: false, error: 'redemptionId required' });
      const r = await supaFetch(`${SUPABASE_URL}/rest/v1/rpc/fulfill_leaf_reward`, {
        method: 'POST',
        body: JSON.stringify({ p_redemption_id: redemptionId, p_performed_by: auth.userId || 'STAFF' }),
      });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'DB error' });
      return res.status(200).json(r.data);
    }

    // ── listPendingRedemptions (STAFF — fulfillment queue) ───────────────
    if (action === 'listPendingRedemptions') {
      const auth = await checkAuth(['OWNER','ADMIN','CASHIER','KITCHEN']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/leaf_redemptions?status=eq.PENDING&select=id,tier_order,reward_name,claimed_at,order_id,account_id,loyalty_accounts(name,email,phone)&order=claimed_at.asc`
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'DB error' });
      return res.status(200).json({ ok: true, redemptions: r.data || [] });
    }

    // ── fulfillSurpriseReward (STAFF — mark a surprise as delivered) ─────
    // Surprises (Soul Searcher / Rainy Day) auto-fire on the customer's account.
    // Customer doesn't claim them — they just show up in their profile. Staff
    // fulfills at counter and confirms via this endpoint.
    if (action === 'fulfillSurpriseReward') {
      const auth = await checkAuth(['OWNER','ADMIN','CASHIER','KITCHEN']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { surpriseId, orderId: applyOrderId } = body;
      if (!surpriseId) return res.status(400).json({ ok: false, error: 'surpriseId required' });
      const r = await supaFetch(`${SUPABASE_URL}/rest/v1/rpc/fulfill_surprise_reward`, {
        method: 'POST',
        body: JSON.stringify({ p_surprise_id: surpriseId, p_performed_by: auth.userId || 'STAFF', p_order_id: applyOrderId || null }),
      });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'DB error' });
      return res.status(200).json(r.data);
    }

    // ── listPendingSurprises (STAFF — fulfillment queue for surprises) ───
    if (action === 'listPendingSurprises') {
      const auth = await checkAuth(['OWNER','ADMIN','CASHIER','KITCHEN']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/surprise_rewards?status=eq.PENDING&select=id,reward_type,reward_name,triggered_at,expires_at,notes,account_id,triggered_by_order_id,loyalty_accounts(name,email,phone,linked_card_number)&order=triggered_at.asc`
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'DB error' });
      return res.status(200).json({ ok: true, surprises: r.data || [] });
    }

    // ── expireLeaves (CRON or OWNER manual trigger) ──────────────────────
    // Calls the expire_leaves() DB function. Two paths to invoke:
    //   1. Vercel cron → header authorization: bearer <CRON_SECRET>
    //   2. Owner manual → standard staff auth (OWNER role required)
    if (action === 'expireLeaves') {
      const cronSecret = process.env.CRON_SECRET || '';
      const authHeader = req.headers?.authorization || '';
      const fromCron   = cronSecret && authHeader === 'Bearer ' + cronSecret;
      let fromOwner    = false;
      if (!fromCron) {
        const auth = await checkAuth(['OWNER']);
        fromOwner = !!auth.ok;
      }
      if (!fromCron && !fromOwner) return res.status(403).json({ ok: false, error: 'Owner login or CRON_SECRET required' });

      const r = await supaFetch(`${SUPABASE_URL}/rest/v1/rpc/expire_leaves`, {
        method: 'POST', body: JSON.stringify({})
      });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'DB error' });
      await auditLog({ action: 'LEAVES_EXPIRY_SWEEP', details: { ...r.data, source: fromCron ? 'CRON' : 'OWNER_MANUAL' } });
      return res.status(200).json(r.data);
    }

    // ── getLoyaltyAccounts (admin list) ───────────────────────────────────
    if (action === 'getLoyaltyAccounts') {
      const auth = await checkAuth(['OWNER','ADMIN','CASHIER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { search, limit = 100 } = body;
      let url = `${SUPABASE_URL}/rest/v1/loyalty_accounts?select=*&order=created_at.desc&limit=${limit}`;
      if (search) url += `&or=(name.ilike.*${encodeURIComponent(search)}*,phone.ilike.*${encodeURIComponent(search)}*)`;
      const r = await supaFetch(url);
      return res.status(200).json({ ok: true, accounts: r.data || [] });
    }

    // ── getLoyaltyAccount (single + transaction history) ──────────────────
    if (action === 'getLoyaltyAccount') {
      const auth = await checkAuth(['OWNER','ADMIN','CASHIER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { id, phone } = body;
      let accR;
      if (id) accR = await supaFetch(`${SUPABASE_URL}/rest/v1/loyalty_accounts?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
      else if (phone) accR = await supaFetch(`${SUPABASE_URL}/rest/v1/loyalty_accounts?phone=eq.${encodeURIComponent(phone.replace(/\D/g,''))}&select=*&limit=1`);
      else return res.status(400).json({ ok: false, error: 'id or phone required' });
      if (!accR.ok || !accR.data?.length) return res.status(200).json({ ok: false, error: 'Account not found' });
      const account = accR.data[0];
      const txR = await supaFetch(`${SUPABASE_URL}/rest/v1/points_transactions?account_id=eq.${encodeURIComponent(account.id)}&order=created_at.desc&limit=50`);
      return res.status(200).json({ ok: true, account, transactions: txR.data || [] });
    }

    // ── createLoyaltyAccount ──────────────────────────────────────────────
    if (action === 'createLoyaltyAccount') {
      const auth = await checkAuth(['OWNER','ADMIN','CASHIER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { name, phone, email } = body;
      if (!name || !phone) return res.status(400).json({ ok: false, error: 'name and phone required' });
      const clean = phone.replace(/\D/g,'');
      const existing = await supaFetch(`${SUPABASE_URL}/rest/v1/loyalty_accounts?phone=eq.${encodeURIComponent(clean)}&select=id&limit=1`);
      if (existing.data?.length) return res.status(200).json({ ok: false, error: 'Phone already registered' });
      const r = await supaFetch(`${SUPABASE_URL}/rest/v1/loyalty_accounts`, {
        method: 'POST',
        body: JSON.stringify({ name, phone: clean, email: email||null, points_balance:0, total_points_earned:0, total_points_redeemed:0, tier:'BRONZE', total_spent:0, visit_count:0 }),
        headers: { 'Prefer': 'return=representation' }
      });
      if (!r.ok) return res.status(500).json({ ok: false, error: r.data?.message || 'Failed to create account' });
      return res.status(200).json({ ok: true, account: r.data[0] });
    }

    // ── earnPoints (called after order completion) ─────────────────────────
    if (action === 'earnPoints') {
      const auth = await checkAuth(['OWNER','ADMIN','CASHIER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { accountId, orderId, orderTotal, description } = body;
      if (!accountId || !orderTotal) return res.status(400).json({ ok: false, error: 'accountId and orderTotal required' });

      // Get earn rate from settings
      const rateR = await supaFetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.LOYALTY_EARN_RATE&select=value&limit=1`);
      const earnRate = parseFloat(rateR.data?.[0]?.value || '1');
      const pointsEarned = Math.floor(parseFloat(orderTotal) * earnRate);
      if (pointsEarned <= 0) return res.status(200).json({ ok: true, pointsEarned: 0 });

      // Get current balance
      const accR = await supaFetch(`${SUPABASE_URL}/rest/v1/loyalty_accounts?id=eq.${encodeURIComponent(accountId)}&select=points_balance,total_points_earned,total_spent,visit_count&limit=1`);
      if (!accR.ok || !accR.data?.length) return res.status(404).json({ ok: false, error: 'Account not found' });
      const acc = accR.data[0];
      const balBefore = acc.points_balance;
      const balAfter = balBefore + pointsEarned;
      const newTotalEarned = (acc.total_points_earned||0) + pointsEarned;
      const newTotalSpent = (acc.total_spent||0) + parseFloat(orderTotal);
      const newVisits = (acc.visit_count||0) + 1;

      // Determine tier
      const tierThresholds = await supaFetch(`${SUPABASE_URL}/rest/v1/settings?key=in.("LOYALTY_SILVER_THRESHOLD","LOYALTY_GOLD_THRESHOLD","LOYALTY_PLATINUM_THRESHOLD")&select=key,value`);
      const th = {};
      (tierThresholds.data||[]).forEach(s => { th[s.key] = parseInt(s.value); });
      let tier = 'BRONZE';
      if (newTotalEarned >= (th.LOYALTY_PLATINUM_THRESHOLD||40000)) tier = 'PLATINUM';
      else if (newTotalEarned >= (th.LOYALTY_GOLD_THRESHOLD||15000)) tier = 'GOLD';
      else if (newTotalEarned >= (th.LOYALTY_SILVER_THRESHOLD||5000)) tier = 'SILVER';

      // Update account
      await supaFetch(`${SUPABASE_URL}/rest/v1/loyalty_accounts?id=eq.${encodeURIComponent(accountId)}`, {
        method: 'PATCH', body: JSON.stringify({ points_balance: balAfter, total_points_earned: newTotalEarned, total_spent: newTotalSpent, visit_count: newVisits, tier, last_visit: new Date().toISOString(), updated_at: new Date().toISOString() })
      });

      // Log transaction
      await supaFetch(`${SUPABASE_URL}/rest/v1/points_transactions`, {
        method: 'POST', body: JSON.stringify({ account_id: accountId, order_id: orderId||null, type: 'EARN', points: pointsEarned, balance_before: balBefore, balance_after: balAfter, description: description || `Earned from order ${orderId||''}`, processed_by: body.userId })
      });

      // Update order with points earned
      if (orderId) {
        await supaFetch(`${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}`, {
          method: 'PATCH', body: JSON.stringify({ loyalty_account_id: accountId, points_earned: pointsEarned })
        });
      }

      return res.status(200).json({ ok: true, pointsEarned, balanceBefore: balBefore, balanceAfter: balAfter, tier });
    }

    // ── redeemPoints ──────────────────────────────────────────────────────
    if (action === 'redeemPoints') {
      const auth = await checkAuth(['OWNER','ADMIN','CASHIER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { accountId, pointsToRedeem, orderId } = body;
      if (!accountId || !pointsToRedeem) return res.status(400).json({ ok: false, error: 'accountId and pointsToRedeem required' });

      // Get settings
      const settR = await supaFetch(`${SUPABASE_URL}/rest/v1/settings?key=in.("LOYALTY_REDEEM_RATE","LOYALTY_MIN_REDEEM")&select=key,value`);
      const sett = {};
      (settR.data||[]).forEach(s => { sett[s.key] = s.value; });
      const redeemRate = parseInt(sett.LOYALTY_REDEEM_RATE || '100'); // points per ₱1
      const minRedeem = parseInt(sett.LOYALTY_MIN_REDEEM || '500');

      if (pointsToRedeem < minRedeem) return res.status(400).json({ ok: false, error: `Minimum ${minRedeem} points to redeem` });

      const accR = await supaFetch(`${SUPABASE_URL}/rest/v1/loyalty_accounts?id=eq.${encodeURIComponent(accountId)}&select=points_balance,total_points_redeemed&limit=1`);
      if (!accR.ok || !accR.data?.length) return res.status(404).json({ ok: false, error: 'Account not found' });
      const acc = accR.data[0];
      if (acc.points_balance < pointsToRedeem) return res.status(400).json({ ok: false, error: `Insufficient points. Balance: ${acc.points_balance}` });

      const discountAmount = Math.floor(pointsToRedeem / redeemRate * 100) / 100;
      const balBefore = acc.points_balance;
      const balAfter  = balBefore - pointsToRedeem;

      // Update account
      await supaFetch(`${SUPABASE_URL}/rest/v1/loyalty_accounts?id=eq.${encodeURIComponent(accountId)}`, {
        method: 'PATCH', body: JSON.stringify({ points_balance: balAfter, total_points_redeemed: (acc.total_points_redeemed||0) + pointsToRedeem, updated_at: new Date().toISOString() })
      });

      // Log transaction
      await supaFetch(`${SUPABASE_URL}/rest/v1/points_transactions`, {
        method: 'POST', body: JSON.stringify({ account_id: accountId, order_id: orderId||null, type: 'REDEEM', points: -pointsToRedeem, balance_before: balBefore, balance_after: balAfter, description: `Redeemed ${pointsToRedeem} pts = ₱${discountAmount} off`, processed_by: body.userId })
      });

      // Update order
      if (orderId) {
        await supaFetch(`${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}`, {
          method: 'PATCH', body: JSON.stringify({ loyalty_account_id: accountId, points_redeemed: pointsToRedeem, points_discount: discountAmount })
        });
      }

      return res.status(200).json({ ok: true, pointsRedeemed: pointsToRedeem, discountAmount, balanceBefore: balBefore, balanceAfter: balAfter });
    }

    // ── adjustPoints (manual adjustment by OWNER) ─────────────────────────
    if (action === 'adjustPoints') {
      const auth = await checkAuth(['OWNER','ADMIN']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { accountId, points, reason } = body;
      if (!accountId || points === undefined) return res.status(400).json({ ok: false, error: 'accountId and points required' });

      const accR = await supaFetch(`${SUPABASE_URL}/rest/v1/loyalty_accounts?id=eq.${encodeURIComponent(accountId)}&select=points_balance&limit=1`);
      if (!accR.ok || !accR.data?.length) return res.status(404).json({ ok: false, error: 'Account not found' });
      const balBefore = accR.data[0].points_balance;
      const balAfter  = Math.max(0, balBefore + parseInt(points));

      await supaFetch(`${SUPABASE_URL}/rest/v1/loyalty_accounts?id=eq.${encodeURIComponent(accountId)}`, {
        method: 'PATCH', body: JSON.stringify({ points_balance: balAfter, updated_at: new Date().toISOString() })
      });
      await supaFetch(`${SUPABASE_URL}/rest/v1/points_transactions`, {
        method: 'POST', body: JSON.stringify({ account_id: accountId, type: 'ADJUST', points: parseInt(points), balance_before: balBefore, balance_after: balAfter, description: reason || 'Manual adjustment', processed_by: body.userId })
      });

      return res.status(200).json({ ok: true, balanceBefore: balBefore, balanceAfter: balAfter });
    }


  return false;
}
