// ── AUTH HANDLERS ── auto-extracted from pos.js
'use strict';

module.exports = async function handle_auth(action, body, req, res, ctx) {
  const {
    supa, supaFetch, checkAuth, checkAdminAuth, auditLog, pushToSheets, logSync,
    invalidateMenuCache, getSetting, menuCache, SUPABASE_URL, SUPABASE_KEY,
    ORDER_PREFIX, SERVICE_CHARGE_RATE, isNonEmptyString, isValidPrice,
    isValidItemCode, isValidOrderId, isNonEmptyArray, isValidPhone
  } = ctx;

    // ── verifyUserPin ──────────────────────────────────────────────────────
    if (action === 'verifyUserPin') {
      const pin = String(body.pin || '').trim();
      if (!pin || pin.length < 4) return res.status(400).json({ ok: false, error: 'PIN is required' });

      // Fetch all active staff — we need to bcrypt.compare against each hash
      // (bcrypt cannot reverse-lookup; we must compare, not query by hash)
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/staff_users?active=eq.true&select=user_id,username,display_name,role,pin_hash,failed_attempts,locked_until`
      );
      if (!r.ok || !r.data) return res.status(500).json({ ok: false, error: 'Auth service error' });

      // Find matching user — try each active staff member
      let matchedUser = null;
      for (const candidate of r.data) {
        if (!candidate.pin_hash) continue;
        try {
          const match = await bcrypt.compare(pin, candidate.pin_hash);
          if (match) { matchedUser = candidate; break; }
        } catch { continue; } // malformed hash — skip
      }

      if (!matchedUser) {
        return res.status(200).json({ ok: false, error: 'Invalid PIN' });
      }

      // Check if account is locked
      if (matchedUser.locked_until && new Date(matchedUser.locked_until) > new Date()) {
        return res.status(200).json({ ok: false, error: 'Account locked. Please try again later.' });
      }

      // PIN correct — reset counters, update last_login
      await supa('PATCH', 'staff_users', {
        last_login:      new Date().toISOString(),
        failed_attempts: 0,
        locked_until:    null,
      }, { user_id: `eq.${matchedUser.user_id}` });

      // Issue JWT token — 8h expiry covers a full cafe shift
      let token = null;
      try { token = await signToken(matchedUser.user_id, matchedUser.role, matchedUser.display_name); }
      catch (_) { /* token generation failure non-fatal — client still works via legacy path */ }

      return res.status(200).json({
        ok: true,
        userId:      matchedUser.user_id,
        username:    matchedUser.username,
        displayName: matchedUser.display_name,
        role:        matchedUser.role,
        token,                          // ← new: JWT for secure auth
        expiresIn:   8 * 60 * 60,       // 8 hours in seconds
        user: {
          userId:      matchedUser.user_id,
          username:    matchedUser.username,
          displayName: matchedUser.display_name,
          role:        matchedUser.role,
        },
      });
    }

    // ══════════════════════════════════════════════════════════════════════
    // ONLINE ORDER ACTIONS (pass-through to Supabase)
    // ══════════════════════════════════════════════════════════════════════

    // ── changePin ──────────────────────────────────────────────────────────
    if (action === 'changePin') {
      // Requires OWNER or ADMIN to change any PIN
      // OR the user themselves (must provide currentPin to verify identity)
      const targetUserId = String(body.targetUserId || '').trim();
      const newPin       = String(body.newPin || '').trim();
      const currentPin   = String(body.currentPin || '').trim();

      if (!targetUserId) return res.status(400).json({ ok: false, error: 'targetUserId is required' });
      if (!newPin || newPin.length < 4) return res.status(400).json({ ok: false, error: 'New PIN must be at least 4 digits' });
      if (!/^\d{4,8}$/.test(newPin)) return res.status(400).json({ ok: false, error: 'PIN must be 4-8 digits only' });

      // Fetch the target user
      const targetR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/staff_users?user_id=eq.${encodeURIComponent(targetUserId)}&active=eq.true&select=user_id,pin_hash,role`
      );
      if (!targetR.ok || !targetR.data?.length) {
        return res.status(404).json({ ok: false, error: 'User not found' });
      }
      const targetUser = targetR.data[0];

      // Auth check:
      // 1. OWNER/ADMIN changing any PIN (including their own) — always allowed, no currentPin needed
      // 2. CASHIER/KITCHEN changing their own PIN — must provide currentPin
      const requesterId = String(body.userId || '').trim();
      let authorized = false;
      let requesterRole = null;

      if (requesterId) {
        const reqR = await supaFetch(
          `${SUPABASE_URL}/rest/v1/staff_users?user_id=eq.${encodeURIComponent(requesterId)}&active=eq.true&select=role`
        );
        if (reqR.ok && reqR.data?.length) requesterRole = reqR.data[0].role;
      }

      if (requesterRole === 'OWNER' || requesterRole === 'ADMIN') {
        // OWNER/ADMIN can change any PIN — no current PIN required
        authorized = true;
      } else if (currentPin) {
        // Non-admin (or no userId sent) changing their own PIN — verify current PIN
        authorized = await bcrypt.compare(currentPin, targetUser.pin_hash);
        if (!authorized) return res.status(403).json({ ok: false, error: 'Current PIN is incorrect' });
      }

      if (!authorized) return res.status(403).json({ ok: false, error: 'Unauthorized to change this PIN' });

      // Hash new PIN and save
      const newHash = await bcrypt.hash(newPin, 12);
      const upd = await supa('PATCH', 'staff_users',
        { pin_hash: newHash, failed_attempts: 0, locked_until: null },
        { user_id: `eq.${targetUserId}` }
      );
      if (!upd.ok) return res.status(500).json({ ok: false, error: 'Failed to update PIN' });

      return res.status(200).json({ ok: true, message: 'PIN updated successfully' });
    }

if (action === 'getStaff') {
      const authS = await checkAdminAuth();
      if (!authS.ok) return res.status(403).json({ ok: false, error: authS.error });
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/staff_users?active=eq.true&order=user_id.asc&select=user_id,username,display_name,role,last_login,failed_attempts`
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to fetch staff' });
      const staffList = r.data || [];
      return res.status(200).json({ ok: true, staff: staffList, users: staffList });
    }


  return res.status(400).json({ ok: false, error: `Unknown auth action: ${action}` });
};
