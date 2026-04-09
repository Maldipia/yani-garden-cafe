// ── api/handlers/auth.js ────────────────────────────────────────────────────────────────
// Handles: changePin, testDriveUpload, verifyUserPin
// ctx: { action, body, req, res, jwtUser, checkAuth, supa, supaFetch, auditLog,
//          SUPABASE_URL, SUPABASE_KEY, SERVICE_CHARGE_RATE, ORDER_PREFIX, getSetting }

export async function handle_auth(action, ctx) {
  const { body, req, res, jwtUser, checkAuth, supa, supaFetch, auditLog,
          SUPABASE_URL, SUPABASE_KEY, SERVICE_CHARGE_RATE, ORDER_PREFIX, getSetting } = ctx;

    // ══════════════════════════════════════════════════════════════════════
    // AUTH ACTIONS
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
        res.status(404).json({ ok: false, error: 'User not found' }); return true;
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

      res.status(200).json({ ok: true, message: 'PIN updated successfully' }); return true;
    }

    // ── verifyUserPin ──────────────────────────────────────────────────────
    if (action === 'testDriveUpload') {
      // Diagnostic only — protected by secret key
      if (body.secret !== 'yani-drive-test-2026') return res.status(401).json({ ok: false, error: 'Bad secret' });
      const tinyPng = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==','base64');
      const driveResult = await uploadToGoogleDrive(tinyPng,'image/png',`TEST_${Date.now()}.png`,'1hDQlljGpRUwT9q33xHukbXvz_M8tk5lR');
      let testSaJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '';
      if (!testSaJson) {
        try {
          const testSaR = await fetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.GOOGLE_SA_JSON&select=value`,
            { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
          const testSaData = await testSaR.json();
          testSaJson = (testSaData && testSaData[0]) ? testSaData[0].value : '';
        } catch(_) {}
      }
      const saSet = !!(testSaJson);
      const saEmail = saSet ? JSON.parse(testSaJson).client_email : 'NOT SET';
      const driveError = (driveResult && typeof driveResult === 'object' && driveResult.error) ? driveResult.error : null;
      const driveUrl   = (driveResult && typeof driveResult === 'string') ? driveResult : null;
      res.status(200).json({ ok: !!driveUrl, driveUrl, driveError, saEmail, saSet }); return true;
    }

    if (action === 'verifyUserPin') {
      const pin = String(body.pin || '').trim();
      if (!pin || pin.length < 4) return res.status(400).json({ ok: false, error: 'PIN is required' });

      // ── IP-based brute-force protection ──────────────────────────────
      // 10 wrong PINs per IP in 5 minutes → 429 blocked
      const loginIp = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
      const loginKey = `pin_brute:${loginIp}`;
      try {
        const pinRlR = await fetch(
          `${SUPABASE_URL}/rest/v1/rpc/upsert_rate_limit`,
          { method:'POST', headers:{'apikey':SUPABASE_KEY,'Authorization':`Bearer ${SUPABASE_KEY}`,'Content-Type':'application/json'},
            body: JSON.stringify({ p_key: loginKey, p_window: 300, p_limit: 10 }) }
        );
        if (pinRlR.ok && await pinRlR.json() === false) {
          res.status(429).json({ ok:false, error:'Too many failed attempts. Try again in 5 minutes.' }); return true;
        }
      } catch(rlErr) { console.error('PIN rate limit:', rlErr.message); /* fail open */ }

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
        // Rate already tracked per IP above
        res.status(200).json({ ok: false, error: 'Invalid PIN' }); return true;
      }

      // Check if account is locked
      if (matchedUser.locked_until && new Date(matchedUser.locked_until) > new Date()) {
        res.status(200).json({ ok: false, error: 'Account locked. Try again in 15 minutes.' }); return true;
      }

      // PIN correct — reset rate limit + update last_login
      try {
        // Reset PIN brute-force counter on success
        await fetch(`${SUPABASE_URL}/rest/v1/rpc/upsert_rate_limit`,
          { method:'POST', headers:{'apikey':SUPABASE_KEY,'Authorization':`Bearer ${SUPABASE_KEY}`,'Content-Type':'application/json'},
            body: JSON.stringify({ p_key: loginKey, p_window: 1, p_limit: 9999 }) });
      } catch(_) {}
      await supa('PATCH', 'staff_users', {
        last_login:      new Date().toISOString(),
        failed_attempts: 0,
        locked_until:    null,
      }, { user_id: `eq.${matchedUser.user_id}` });

      // Issue JWT token — 8h expiry covers a full cafe shift
      let token = null;
      try { token = await signToken(matchedUser.user_id, matchedUser.role, matchedUser.display_name); }
      catch (_) { /* token generation failure non-fatal — client still works via legacy path */ }

      res.status(200).json({
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
      }); return true;
    }



  return false; // not handled by this module
}

  const _handled = ['changePin', 'testDriveUpload', 'verifyUserPin'];
  if (!_handled.includes(action)) return false;

