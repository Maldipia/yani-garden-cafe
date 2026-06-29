// ── Admin, auth, analytics, inventory, staff, tables, settings, misc ──────
import { supaFetch, supa, auditLog, getSetting, logSync } from '../lib/db.js';
import { GAS_SYNC_URL } from '../lib/config.js';
import { invalidateMenuCache, invalidateSettingsCache, _settingsCache, SETTINGS_CACHE_TTL } from '../lib/cache.js';
import { getCategoryName, getCategoryId, CATEGORY_ID_TO_NAME } from '../lib/categories.js';
import { isNonEmptyString, isValidOrderId, isValidItemCode } from '../lib/validation.js';
import { SUPABASE_URL, BUSINESS_NAME, SERVICE_CHARGE_RATE, SUPABASE_KEY, FROM_EMAIL, RESEND_KEY } from '../lib/config.js';
import { signToken, verifyToken, getJwtSecret } from '../lib/auth.js';
import { uploadToGoogleDrive } from '../lib/drive.js';
import { sendReceiptEmail, buildReceiptHTML } from '../lib/receipt.js';
import bcrypt from 'bcryptjs';

export async function routeAdmin(action, body, auth, req, res) {
  const { checkAuth, checkAdminAuth, jwtUser } = auth;

  // ── getHRStaff ──────────────────────────────────────────────────────────
  if (action === 'getHRStaff') {
    try {
      const TENANT_HR = '11111111-1111-4111-8111-111111111111';
      const rHR = await supaFetch(
        SUPABASE_URL + '/rest/v1/hr_staff_master?tenant_id=eq.' + TENANT_HR +
        '&select=id,staff_code,full_name,nickname,role,employment_type,employment_status,pay_basis,daily_rate,hourly_rate,standard_hours_per_day,overtime_allowed,mobile,email,date_of_birth,date_hired,department,payout_method,payout_details&order=full_name.asc'
      );
      if (!rHR.ok) return res.status(500).json({ ok:false, error:'Supabase HR error: ' + rHR.status });
      return res.status(200).json({ ok:true, staff: Array.isArray(rHR.data) ? rHR.data : [] });
    } catch(hrErr) {
      return res.status(500).json({ ok:false, error:'HR fetch error: ' + hrErr.message });
    }
  }
  if (action === 'updateHRStaff') {
    const authHR = await checkAuth(['OWNER','ADMIN']);
    if (!authHR.ok) return res.status(403).json({ ok:false, error:'Unauthorized' });
    const hrStaffId = body.staffId;
    if (!hrStaffId) return res.status(400).json({ ok:false, error:'staffId required' });
    const hrAllowed = ['employment_status','full_name','role','daily_rate','hourly_rate','pay_basis','mobile','email','notes','overtime_allowed','department'];
    const hrPatch = { updated_at: new Date().toISOString() };
    hrAllowed.forEach(function(k){ if (body[k] !== undefined) hrPatch[k] = body[k]; });
    const rHR2 = await supaFetch(
      SUPABASE_URL + '/rest/v1/hr_staff_master?id=eq.' + hrStaffId,
      { method:'PATCH', body:JSON.stringify(hrPatch) }
    );
    if (!rHR2.ok) return res.status(500).json({ ok:false, error:'HR update failed' });
    return res.status(200).json({ ok:true });
  }
  if (action === 'updateHRStaff') {
    const authHR = await checkAdminAuth ? checkAdminAuth() : await checkAuth(['OWNER','ADMIN']);
    if (!authHR.ok) return res.status(403).json({ ok:false, error:'Unauthorized' });
    const hrStaffId = body.staffId;
    if (!hrStaffId) return res.status(400).json({ ok:false, error:'staffId required' });
    const hrAllowed = ['employment_status','full_name','role','daily_rate','hourly_rate','pay_basis','mobile','email','notes','overtime_allowed','department'];
    const hrPatch = { updated_at: new Date().toISOString() };
    hrAllowed.forEach(function(k){ if (body[k] !== undefined) hrPatch[k] = body[k]; });
    const rHR2 = await supaFetch(
      SUPABASE_URL + '/rest/v1/hr_staff_master?id=eq.' + hrStaffId,
      { method:'PATCH', body:JSON.stringify(hrPatch) }
    );
    if (!rHR2.ok) return res.status(500).json({ ok:false, error:'HR update failed' });
    return res.status(200).json({ ok:true });
  }

    if (action === 'changePin') {
      // REQUIRES VALID JWT — no legacy body.userId fallback allowed for PIN changes
      if (!jwtUser) {
        return res.status(403).json({ ok: false, error: 'A valid login token is required to change PINs' });
      }
      const authCP = await checkAuth(['OWNER','ADMIN','CASHIER','KITCHEN']);
      if (!authCP.ok) return res.status(403).json({ ok: false, error: authCP.error });

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

      // Auth check: use jwtUser directly (guaranteed valid JWT from check above)
      // NEVER use body.userId for role lookup — that was the original exploit
      const requesterId = jwtUser.userId;         // from validated JWT — cannot be spoofed
      const requesterRole = jwtUser.role;         // from validated JWT — cannot be spoofed
      let authorized = false;

      if (requesterRole === 'OWNER' || requesterRole === 'ADMIN') {
        // Only OWNER/ADMIN (verified via JWT) can change any PIN without currentPin
        authorized = true;
      } else if (currentPin) {
        // Non-admin changing their own PIN — must provide current PIN AND target must be themselves
        if (targetUserId !== requesterId) {
          return res.status(403).json({ ok: false, error: 'You can only change your own PIN' });
        }
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

    // ── verifyUserPin ──────────────────────────────────────────────────────
    if (action === 'testDriveUpload') {
      // Diagnostic only — OWNER only OR CRON_SECRET header
      const cronSecret = process.env.CRON_SECRET || '';
      const fromCron = cronSecret && (req.headers?.authorization || '') === 'Bearer ' + cronSecret;
      if (!fromCron) {
        const authTD = await checkAuth(['OWNER']);
        if (!authTD.ok) return res.status(403).json({ ok: false, error: authTD.error });
      }
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
      return res.status(200).json({ ok: !!driveUrl, driveUrl, driveError, saEmail, saSet });
    }

    if (action === 'verifyUserPin') {
      const pin = String(body.pin || '').trim();
      if (!pin || pin.length < 4) return res.status(400).json({ ok: false, error: 'PIN is required' });

      // ── Rate-limit check + staff fetch run in PARALLEL (saves ~600ms) ─────
      const loginIp = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
      const loginKey = `pin_brute:${loginIp}`;

      const [rlResult, r] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/rpc/upsert_rate_limit`,
          { method:'POST', headers:{'apikey':SUPABASE_KEY,'Authorization':`Bearer ${SUPABASE_KEY}`,'Content-Type':'application/json'},
            body: JSON.stringify({ p_key: loginKey, p_window: 300, p_limit: 10 }) }
        ).then(async res2 => { try { return await res2.json(); } catch { return true; } }).catch(() => true),
        supaFetch(`${SUPABASE_URL}/rest/v1/staff_users?active=eq.true&select=user_id,username,display_name,role,pin_hash,failed_attempts,locked_until`)
      ]);

      if (rlResult === false) {
        return res.status(429).json({ ok:false, error:'Too many failed attempts. Try again in 5 minutes.' });
      }
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
        return res.status(200).json({ ok: false, error: 'Invalid PIN' });
      }

      // Check if account is locked
      if (matchedUser.locked_until && new Date(matchedUser.locked_until) > new Date()) {
        return res.status(200).json({ ok: false, error: 'Account locked. Try again in 15 minutes.' });
      }

      // Issue JWT token immediately — don't block on DB writes
      let token = null;
      try { token = await signToken(matchedUser.user_id, matchedUser.role, matchedUser.display_name); }
      catch (_) { /* non-fatal */ }

      // Fire-and-forget post-login writes — PARALLEL, not awaited
      // User gets their response immediately; DB updates happen in background
      Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/rpc/upsert_rate_limit`,
          { method:'POST', headers:{'apikey':SUPABASE_KEY,'Authorization':`Bearer ${SUPABASE_KEY}`,'Content-Type':'application/json'},
            body: JSON.stringify({ p_key: loginKey, p_window: 1, p_limit: 9999 }) }
        ).catch(() => {}),
        supa('PATCH', 'staff_users', {
          last_login:      new Date().toISOString(),
          failed_attempts: 0,
          locked_until:    null,
        }, { user_id: `eq.${matchedUser.user_id}` }).catch(() => {})
      ]).catch(() => {});

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

    // ── getOnlineOrders ────────────────────────────────────────────────────
    if (action === 'getOnlineOrders') {
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/online_orders?order=created_at.desc&limit=200`
      );
      const rows = r.ok ? r.data : [];
      const orders = rows.map(o => ({
        orderRef:            o.order_ref,
        date:                o.created_at,
        customerName:        o.customer_name,
        phone:               o.customer_phone,
        email:               o.customer_email || '',
        pickupTime:          o.pickup_time || '',
        courierType:         o.courier_type || 'PICKUP',
        subtotal:            o.subtotal,
        totalAmount:         o.total_amount,
        paymentMethod:       o.payment_method,
        paymentStatus:       o.payment_status,
        orderStatus:         o.status,
        specialInstructions: o.special_instructions || '',
        adminNotes:          o.admin_notes || '',
        deliveryFee:         parseFloat(o.delivery_fee || 0),
        deliveryZone:        o.delivery_zone || null,
        lastUpdated:         o.updated_at,
      }));
      return res.status(200).json({ ok: true, orders });
    }

    // ── updateOnlineOrderStatus ────────────────────────────────────────────
    if (action === 'updateOnlineOrderStatus') {
      const authR = await checkAdminAuth();
      if (!authR.ok) return res.status(403).json({ ok: false, error: authR.error });
      const { orderRef, status, updatedBy } = body;
      if (!orderRef || !status) return res.status(400).json({ ok: false, error: 'orderRef and status are required' });
      const VALID_STATUSES = ['PENDING','CONFIRMED','PREPARING','READY','COMPLETED','CANCELLED'];
      if (!VALID_STATUSES.includes(status))
        return res.status(400).json({ ok: false, error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` });
      const r = await supa('PATCH', 'online_orders',
        { status, admin_notes: updatedBy ? `Status set to ${status} by ${updatedBy}` : undefined, updated_at: new Date().toISOString() },
        { order_ref: `eq.${orderRef}` }
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to update online order status' });
      auditLog({ orderId: orderRef, action: `ONLINE_ORDER_${status}`, actor: { userId: body.userId, displayName: updatedBy } });
      return res.status(200).json({ ok: true, orderRef, status });
    }

    // ── editOnlineOrder ────────────────────────────────────────────────────
    if (action === 'editOnlineOrder') {
      const authR = await checkAdminAuth();
      if (!authR.ok) return res.status(403).json({ ok: false, error: authR.error });
      const { orderRef, adminNotes, deliveryFee, deliveryZone, pickupTime, paymentStatus } = body;
      if (!orderRef) return res.status(400).json({ ok: false, error: 'orderRef is required' });
      const patch = { updated_at: new Date().toISOString() };
      if (adminNotes   !== undefined) patch.admin_notes    = adminNotes;
      if (deliveryFee  !== undefined) patch.delivery_fee   = parseFloat(deliveryFee) || 0;
      if (deliveryZone !== undefined) patch.delivery_zone  = deliveryZone;
      if (pickupTime   !== undefined) patch.pickup_time    = pickupTime || null;
      if (paymentStatus !== undefined) patch.payment_status = paymentStatus;
      const r = await supa('PATCH', 'online_orders', patch, { order_ref: `eq.${orderRef}` });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to update online order' });
      auditLog({ orderId: orderRef, action: 'ONLINE_ORDER_EDITED', actor: { userId: body.userId } });
      return res.status(200).json({ ok: true, orderRef });
    }

    // ── sendReadySMS ───────────────────────────────────────────────────────
    if (action === 'sendReadySMS') {
      const authR = await checkAdminAuth();
      if (!authR.ok) return res.status(403).json({ ok: false, error: authR.error });
      const { orderRef, customerPhone, customerName } = body;
      if (!orderRef || !customerPhone) return res.status(400).json({ ok: false, error: 'orderRef and customerPhone are required' });
      // Mark sms_sent in DB regardless (SMS provider not configured — log only)
      await supa('PATCH', 'online_orders', { sms_sent: true, updated_at: new Date().toISOString() }, { order_ref: `eq.${orderRef}` });
      auditLog({ orderId: orderRef, action: 'SMS_READY_SENT', actor: { userId: body.userId }, details: { phone: customerPhone, name: customerName } });
      // TODO: wire to Semaphore / Globe Labs / Twilio when SMS provider is configured
      return res.status(200).json({ ok: true, orderRef, smsSent: true, note: 'SMS logged. Connect SMS provider in Settings to send actual messages.' });
    }

    // ── retryDead ──────────────────────────────────────────────────────────
    if (action === 'retryDead') {
      const authR = await checkAdminAuth();
      if (!authR.ok) return res.status(403).json({ ok: false, error: authR.error });
      const { orderRef, queueId } = body;
      if (!orderRef) return res.status(400).json({ ok: false, error: 'orderRef is required' });
      // Reset queue item for retry
      const patch = { status: 'PENDING', retry_count: 0, error_message: null, updated_at: new Date().toISOString() };
      const filter = queueId ? { id: `eq.${queueId}` } : { order_ref: `eq.${orderRef}`, status: `eq.DEAD` };
      const r = await supa('PATCH', 'order_queue', patch, filter);
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to retry dead order' });
      auditLog({ orderId: orderRef, action: 'DEAD_ORDER_RETRY', actor: { userId: body.userId } });
      return res.status(200).json({ ok: true, orderRef, retried: true });
    }

    // ── getCustomers ───────────────────────────────────────────────────────
    // ── createReservation ─────────────────────────────────────────────────
    if (action === 'createReservation') {
      // ONLINE bookings (no userId) are allowed — staff bookings require admin role
      const isOnline = !body.userId;
      if (!isOnline) {
        const authR = await checkAdminAuth();
        if (!authR.ok) return res.status(403).json({ ok: false, error: authR.error });
      }

      const { guestName, guestPhone, guestEmail, tableNo, pax, resDate, resTime,
              notes, occasion, seatingPref, dietary } = body;

      if (!guestName || !resDate || !resTime)
        return res.status(400).json({ ok: false, error: 'guestName, resDate, resTime are required' });

      // Online bookings don't pick a specific table — staff assigns one
      const table = tableNo ? parseInt(tableNo) : null;
      if (table !== null && (table < 1 || table > 10))
        return res.status(400).json({ ok: false, error: 'tableNo must be 1-10' });

      // Validate date not in the past
      const today = new Date().toISOString().slice(0, 10);
      if (resDate < today)
        return res.status(400).json({ ok: false, error: 'Reservation date cannot be in the past' });

      // Get next res_id
      const seqR = await supaFetch(`${SUPABASE_URL}/rest/v1/rpc/get_next_res_id`, {
        method: 'POST', body: JSON.stringify({})
      });
      const resId = seqR.ok ? seqR.data : `RES-${Date.now()}`;

      const r = await supa('POST', 'reservations', {
        res_id:       resId,
        table_no:     table,
        guest_name:   String(guestName).trim(),
        guest_phone:  guestPhone  ? String(guestPhone).trim()  : null,
        guest_email:  guestEmail  ? String(guestEmail).trim()  : null,
        pax:          parseInt(pax) || 1,
        res_date:     resDate,
        res_time:     resTime,
        notes:        notes       ? String(notes).trim()       : null,
        occasion:     occasion    ? String(occasion).trim()    : null,
        seating_pref: seatingPref ? String(seatingPref).trim() : null,
        dietary:      dietary     ? String(dietary).trim()     : null,
        source:       isOnline ? 'ONLINE' : 'STAFF',
        status:       'CONFIRMED',
      });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to create reservation' });
      return res.status(200).json({ ok: true, resId });
    }

    // ── getTables ──────────────────────────────────────────────────────────
    if (action === 'getTables') {
      const authR = await checkAuth();
      if (!authR.ok) return res.status(403).json({ ok: false, error: authR.error });
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/cafe_tables?order=table_number.asc&select=table_number,qr_token,table_name,capacity`
      );
      return res.status(200).json({ ok: true, tables: r.data || [] });
    }

    // ── updateTable ────────────────────────────────────────────────────────
    if (action === 'updateTable') {
      const authR = await checkAdminAuth();
      if (!authR.ok) return res.status(403).json({ ok: false, error: authR.error });
      const { tableNo, tableName, capacity } = body;
      if (!tableNo) return res.status(400).json({ ok: false, error: 'tableNo required' });
      const updates = {};
      if (tableName !== undefined) updates.table_name = String(tableName).trim().slice(0, 50);
      if (capacity !== undefined) updates.capacity = parseInt(capacity) || 4;
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/cafe_tables?table_number=eq.${encodeURIComponent(tableNo)}`,
        { method: 'PATCH', body: JSON.stringify(updates) }
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to update table' });
      return res.status(200).json({ ok: true });
    }

    // ── deleteTable ────────────────────────────────────────────────────────
    if (action === 'deleteTable') {
      const authR = await checkAdminAuth();
      if (!authR.ok) return res.status(403).json({ ok: false, error: authR.error });
      const { tableNo } = body;
      if (!tableNo) return res.status(400).json({ ok: false, error: 'tableNo required' });
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/cafe_tables?table_number=eq.${encodeURIComponent(tableNo)}`,
        { method: 'DELETE' }
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to delete table' });
      return res.status(200).json({ ok: true });
    }

    // ── addTable ───────────────────────────────────────────────────────────
    if (action === 'addTable') {
      const authR = await checkAdminAuth();
      if (!authR.ok) return res.status(403).json({ ok: false, error: authR.error });
      const tableNo = parseInt(body.tableNo);
      if (!tableNo || tableNo < 1 || tableNo > 99)
        return res.status(400).json({ ok: false, error: 'Invalid table number (1-99)' });
      // Generate random 8-char hex token
      const token = Array.from({length:8}, () => Math.floor(Math.random()*16).toString(16)).join('');
      const tableName = body.tableName ? String(body.tableName).trim().slice(0,50) : `Table ${tableNo}`;
      const capacity = parseInt(body.capacity) || 4;
      const r = await supa('POST', 'cafe_tables', { table_number: tableNo, qr_token: token, table_name: tableName, capacity });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to add table — may already exist' });
      return res.status(200).json({ ok: true, tableNo, token });
    }

    // ── getReservations ────────────────────────────────────────────────────
    if (action === 'getReservations') {
      const authR = await checkAdminAuth();
      if (!authR.ok) return res.status(403).json({ ok: false, error: authR.error });

      const date = body.date ? String(body.date) : new Date().toISOString().slice(0,10);
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/reservations?res_date=eq.${date}&status=neq.CANCELLED&order=res_time.asc&select=*`
      );
      return res.status(200).json({ ok: true, reservations: r.data || [] });
    }

    // ── updateReservation ──────────────────────────────────────────────────
    if (action === 'updateReservation') {
      const authR = await checkAdminAuth();
      if (!authR.ok) return res.status(403).json({ ok: false, error: authR.error });

      const { resId, status, notes } = body;
      if (!resId) return res.status(400).json({ ok: false, error: 'resId is required' });
      const validStatuses = ['CONFIRMED','SEATED','COMPLETED','CANCELLED','NO_SHOW'];
      if (status && !validStatuses.includes(status))
        return res.status(400).json({ ok: false, error: 'Invalid status' });

      const patch = {};
      if (status) patch.status = status;
      if (notes !== undefined) patch.notes = notes;

      const r = await supa('PATCH', 'reservations', patch, { res_id: `eq.${resId}` });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to update reservation' });
      return res.status(200).json({ ok: true });
    }

    // getCustomers moved to customers table section below

    // ── getAnalytics ───────────────────────────────────────────────────────
    if (action === 'getAnalytics') {
      // OWNER / ADMIN only
      const authA = await checkAdminAuth();
      if (!authA.ok) return res.status(403).json({ ok: false, error: authA.error });

      const BASE = `${SUPABASE_URL}/rest/v1`;
      const H    = { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` };

      // ── Daily revenue last 30 days ─────────────────────────────────────
      const thirtyAgo = new Date(Date.now() - 30*24*3600*1000).toISOString();
      const ordersR = await fetch(
        `${BASE}/dine_in_orders?status=eq.COMPLETED&is_test=eq.false&is_deleted=eq.false&created_at=gte.${thirtyAgo}&select=created_at,total,discounted_total,order_type`,
        { headers: H }
      );
      const orders = ordersR.ok ? (await ordersR.json()) : [];

      // Daily revenue map
      const phOffset = 8 * 3600000; // UTC+8 Philippines time
      const dailyMap = {};
      orders.forEach(o => {
        // Use PH date (UTC+8) for day grouping
        const phDate = new Date(new Date(o.created_at).getTime() + phOffset);
        const day = phDate.toISOString().slice(0,10);
        if (!dailyMap[day]) dailyMap[day] = { revenue:0, count:0 };
        // Use discounted_total when available (reflects actual amount paid)
        dailyMap[day].revenue += parseFloat(o.discounted_total || o.total || 0);
        dailyMap[day].count   += 1;
      });
      const daily = Object.entries(dailyMap)
        .map(([day,v]) => ({ day, revenue: Math.round(v.revenue*100)/100, count: v.count }))
        .sort((a,b) => a.day.localeCompare(b.day));

      // Business day grouping: order belongs to business day based on 6 AM cutoff
      // e.g. order at 12:30 AM on Apr 4 belongs to Apr 3 business day
      function getBusinessDay(isoStr) {
        const phDate = new Date(new Date(isoStr).getTime() + phOffset);
        const h = phDate.getUTCHours();
        if (h < 6) phDate.setTime(phDate.getTime() - 86400000); // before 6 AM → prev biz day
        return phDate.toISOString().slice(0,10);
      }
      // Rebuild dailyMap with business day grouping
      const dailyMapBiz = {};
      orders.forEach(o => {
        const day = getBusinessDay(o.created_at);
        if (!dailyMapBiz[day]) dailyMapBiz[day] = { revenue:0, count:0 };
        dailyMapBiz[day].revenue += parseFloat(o.discounted_total || o.total || 0);
        dailyMapBiz[day].count   += 1;
      });
      Object.assign(dailyMap, dailyMapBiz); // replace with business-day version

      // Today vs yesterday — use business day logic
      const nowPHT2 = new Date(Date.now() + phOffset);
      const curH    = nowPHT2.getUTCHours();
      if (curH < 6) nowPHT2.setTime(nowPHT2.getTime() - 86400000);
      const todayStr     = nowPHT2.toISOString().slice(0,10);
      const yesterdayStr = new Date(nowPHT2.getTime() - 86400000).toISOString().slice(0,10);
      const todayData     = dailyMap[todayStr]     || { revenue:0, count:0 };
      const yesterdayData = dailyMap[yesterdayStr] || { revenue:0, count:0 };

      // Total last 7 days
      const sevenAgoStr = new Date(Date.now()-7*86400000).toISOString().slice(0,10);
      let rev7=0, cnt7=0;
      daily.forEach(d => { if (d.day >= sevenAgoStr) { rev7+=d.revenue; cnt7+=d.count; } });

      // ── Hourly distribution (today) ────────────────────────────────────
      const hourly = Array.from({length:24}, (_,i) => ({ hour:i, count:0, revenue:0 }));
      orders.filter(o => {
        const phDate = new Date(new Date(o.created_at).getTime() + phOffset);
        return phDate.toISOString().slice(0,10) === todayStr;
      }).forEach(o => {
        const phDate = new Date(new Date(o.created_at).getTime() + phOffset);
        const h = phDate.getUTCHours(); // hour in PH time
        hourly[h].count   += 1;
        hourly[h].revenue += parseFloat(o.discounted_total || o.total || 0);
      });

      // ── Order type split (last 30d) ───────────────────────────────────
      const typeSplit = { 'DINE-IN':0, 'TAKE-OUT':0 };
      orders.forEach(o => { typeSplit[o.order_type] = (typeSplit[o.order_type]||0)+1; });

      // ── Top items — use Supabase Management API raw SQL to avoid 1000-row REST limit ──
      // The REST API silently truncates at 1000 rows; with 1200+ order items this caused
      // wrong counts. Raw SQL via JOIN gives the correct aggregated result directly.
      const topItemsR = await fetch(
        `https://api.supabase.com/v1/projects/hnynvclpvfxzlfjphefj/database/query`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.SUPABASE_PAT || ''}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query: `
            SELECT i.item_name AS name,
                   SUM(i.qty)::int        AS qty,
                   SUM(i.line_total)::float AS revenue
            FROM dine_in_order_items i
            JOIN dine_in_orders o ON o.order_id = i.order_id
            WHERE o.status      = 'COMPLETED'
              AND o.is_test     = false
              AND o.is_deleted  = false
            GROUP BY i.item_name
            ORDER BY qty DESC
            LIMIT 20
          ` })
        }
      );
      let topItems = [];
      if (topItemsR.ok) {
        const topData = await topItemsR.json();
        topItems = Array.isArray(topData) ? topData.map(r => ({
          name: r.name, qty: r.qty, revenue: r.revenue
        })) : [];
      }
      // Fallback: if PAT not set, use the old method with higher limit
      if (topItems.length === 0) {
        const ordersWithId = await fetch(
          `${BASE}/dine_in_orders?status=eq.COMPLETED&is_test=eq.false&is_deleted=eq.false&select=order_id&limit=5000`,
          { headers: H }
        );
        const completedIds = new Set((ordersWithId.ok ? await ordersWithId.json() : []).map(o=>o.order_id));
        const rawItemsR = await fetch(
          `${BASE}/dine_in_order_items?select=item_name,qty,line_total,order_id&limit=5000`,
          { headers: H }
        );
        const rawItems = rawItemsR.ok ? (await rawItemsR.json()) : [];
        const itemMap = {};
        rawItems.forEach(i => {
          if (!completedIds.has(i.order_id)) return;
          const name = i.item_name || 'Unknown';
          if (!itemMap[name]) itemMap[name] = { name, qty:0, revenue:0 };
          itemMap[name].qty     += parseInt(i.qty || 0);
          itemMap[name].revenue += parseFloat(i.line_total || 0);
        });
        topItems = Object.values(itemMap).sort((a,b) => b.qty - a.qty).slice(0,20);
      }

      // ── Cancellation stats ────────────────────────────────────────────
      const cancelR = await fetch(
        `${BASE}/dine_in_orders?status=eq.CANCELLED&is_test=eq.false&is_deleted=eq.false&select=cancel_reason`,
        { headers: H }
      );
      const cancelled = cancelR.ok ? (await cancelR.json()) : [];
      const cancelMap = {};
      cancelled.forEach(o => {
        const r = o.cancel_reason || 'unspecified';
        cancelMap[r] = (cancelMap[r]||0)+1;
      });
      const realCancels = cancelled.filter(o => o.cancel_reason !== 'migration_cleanup').length;

      // ── Payment method breakdown (last 30d completed orders) ──────────
      const payR = await fetch(
        `${BASE}/dine_in_orders?status=eq.COMPLETED&is_test=eq.false&is_deleted=eq.false&created_at=gte.${thirtyAgo}&select=payment_method,total,discounted_total,discount_amount`,
        { headers: H }
      );
      const payOrders = payR.ok ? (await payR.json()) : [];
      const payBreakdown = {};
      let totalDiscounts30d = 0;
      payOrders.forEach(o => {
        const m = o.payment_method || 'UNRECORDED';
        if (!payBreakdown[m]) payBreakdown[m] = { count:0, revenue:0 };
        payBreakdown[m].count   += 1;
        payBreakdown[m].revenue += parseFloat(o.discounted_total || o.total || 0);
        totalDiscounts30d += parseFloat(o.discount_amount || 0);
      });

      return res.status(200).json({
        ok: true,
        // Flat aliases for dashboard compatibility
        todaySales:  Math.round(todayData.revenue*100)/100,
        todayOrders: todayData.count,
        summary: {
          today:     { revenue: Math.round(todayData.revenue*100)/100,     orders: todayData.count },
          yesterday: { revenue: Math.round(yesterdayData.revenue*100)/100, orders: yesterdayData.count },
          last7days: { revenue: Math.round(rev7*100)/100,                  orders: cnt7 },
          realCancellations: realCancels,
          totalOrders30d: orders.length,
          typeSplit,
          totalDiscounts30d: Math.round(totalDiscounts30d*100)/100,
        },
        daily,
        hourly,
        topItems,
        cancelBreakdown: cancelMap,
        paymentBreakdown: payBreakdown,
      });
    }

    // ── getStaff ───────────────────────────────────────────────────────────
    // ── getAuditLogs ───────────────────────────────────────────────────────
    if (action === 'getAuditLogs') {
      const authA = await checkAuth(['OWNER','ADMIN']);
      if (!authA.ok) return res.status(403).json({ ok: false, error: authA.error });
      const orderId = body.orderId ? String(body.orderId).trim() : null;
      const limit   = Math.min(parseInt(body.limit) || 100, 500);
      let url = `${SUPABASE_URL}/rest/v1/order_audit_logs?order=created_at.desc&limit=${limit}`;
      if (orderId) url += `&order_id=eq.${encodeURIComponent(orderId)}`;
      const r = await supaFetch(url);
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to fetch audit logs' });
      return res.status(200).json({ ok: true, logs: r.data || [] });
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

    // ── getCategories ──────────────────────────────────────────────────────
    if (action === 'getCategories') {
      const r = await supaFetch(`${SUPABASE_URL}/rest/v1/menu_categories?select=id,name&order=name.asc`);
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to fetch categories' });
      // Return Title Case names matching what menu items use (CATEGORY_ID_TO_NAME)
      const cats = (r.data || []).map(c => ({
        id: c.id,
        name: CATEGORY_ID_TO_NAME[c.id] || c.name
      }));
      return res.status(200).json({ ok: true, categories: cats });
    }

    // ── getCustomers ───────────────────────────────────────────────────────
    if (action === 'getCustomers') {
      const auth = await checkAuth(['ADMIN','OWNER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const limit = Math.min(parseInt(body.limit) || 100, 500);
      const search = body.search ? body.search.trim() : '';
      let url = `${SUPABASE_URL}/rest/v1/customers?order=last_visit.desc.nullsfirst&limit=${limit}&select=*`;
      if (search) url += `&or=(name.ilike.*${encodeURIComponent(search)}*,phone.ilike.*${encodeURIComponent(search)}*)`;
      const r = await supaFetch(url);
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to fetch customers' });
      return res.status(200).json({ ok: true, customers: r.data || [] });
    }

    // ── getCustomer ────────────────────────────────────────────────────────
    if (action === 'getCustomer') {
      const auth = await checkAuth(['ADMIN','OWNER','CASHIER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { id, phone } = body;
      let url;
      if (id) url = `${SUPABASE_URL}/rest/v1/customers?id=eq.${encodeURIComponent(id)}&select=*&limit=1`;
      else if (phone) url = `${SUPABASE_URL}/rest/v1/customers?phone=eq.${encodeURIComponent(phone)}&select=*&limit=1`;
      else return res.status(400).json({ ok: false, error: 'id or phone required' });
      const r = await supaFetch(url);
      if (!r.ok || !r.data.length) return res.status(404).json({ ok: false, error: 'Customer not found' });
      // Get order history
      const ordR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/dine_in_orders?customer_id=eq.${r.data[0].id}&order=created_at.desc&limit=20&select=order_id,created_at,total,status,discount_type`
      );
      return res.status(200).json({ ok: true, customer: r.data[0], orders: ordR.data || [] });
    }

    // ── upsertCustomer ─────────────────────────────────────────────────────
    if (action === 'upsertCustomer') {
      const auth = await checkAuth(['ADMIN','OWNER','CASHIER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { name, phone, email, notes } = body;
      if (!name) return res.status(400).json({ ok: false, error: 'name required' });
      // Check if customer exists by phone
      let existing = null;
      if (phone) {
        const ex = await supaFetch(`${SUPABASE_URL}/rest/v1/customers?phone=eq.${encodeURIComponent(phone)}&select=id&limit=1`);
        if (ex.ok && ex.data.length) existing = ex.data[0];
      }
      if (existing) {
        // Update
        const upd = { name, updated_at: new Date().toISOString() };
        if (email !== undefined) upd.email = email;
        if (notes !== undefined) upd.notes = notes;
        await supaFetch(`${SUPABASE_URL}/rest/v1/customers?id=eq.${existing.id}`, { method: 'PATCH', body: JSON.stringify(upd) });
        return res.status(200).json({ ok: true, id: existing.id, action: 'updated' });
      }
      // Create
      const payload = { name, phone: phone||null, email: email||null, notes: notes||null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      const r = await supaFetch(`${SUPABASE_URL}/rest/v1/customers`, { method: 'POST', body: JSON.stringify(payload), headers: { 'Prefer': 'return=representation' } });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to create customer' });
      return res.status(200).json({ ok: true, id: r.data[0]?.id, action: 'created' });
    }

    // ── updateCustomerStats ────────────────────────────────────────────────
    if (action === 'updateCustomerStats') {
      const authUCS = await checkAuth(['ADMIN', 'OWNER', 'CASHIER']);
      if (!authUCS.ok) return res.status(403).json({ ok: false, error: authUCS.error });
      const { customerId, orderId, total } = body;
      if (!customerId) return res.status(400).json({ ok: false, error: 'customerId required' });
      const cur = await supaFetch(`${SUPABASE_URL}/rest/v1/customers?id=eq.${encodeURIComponent(customerId)}&select=total_orders,total_spent`);
      if (!cur.ok || !cur.data.length) return res.status(404).json({ ok: false, error: 'Customer not found' });
      const c = cur.data[0];
      const upd = {
        total_orders: (parseInt(c.total_orders)||0) + 1,
        total_spent: Math.round(((parseFloat(c.total_spent)||0) + (parseFloat(total)||0)) * 100) / 100,
        last_visit: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await supaFetch(`${SUPABASE_URL}/rest/v1/customers?id=eq.${encodeURIComponent(customerId)}`, { method: 'PATCH', body: JSON.stringify(upd) });
      if (orderId) await supaFetch(`${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}`, { method: 'PATCH', body: JSON.stringify({ customer_id: customerId }) });
      return res.status(200).json({ ok: true });
    }

    // ── getSettings ────────────────────────────────────────────────────────
    if (action === 'getSettings') {
      const now2 = Date.now();
      if (_settingsCache.data && (now2 - _settingsCache.ts) < SETTINGS_CACHE_TTL) {
        return res.status(200).json({ ok: true, settings: _settingsCache.data, cached: true });
      }
      const r = await supaFetch(`${SUPABASE_URL}/rest/v1/settings?order=key.asc&select=key,value,description`);
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to fetch settings' });
      _settingsCache.data = r.data || [];
      _settingsCache.ts = now2;
      return res.status(200).json({ ok: true, settings: _settingsCache.data });
    }

    // ── updateSetting ──────────────────────────────────────────────────────
    if (action === 'updateSetting') {
      const authUS = await checkAuth(['OWNER']);
      if (!authUS.ok) return res.status(403).json({ ok: false, error: authUS.error });
      const { key, value } = body;
      if (!key) return res.status(400).json({ ok: false, error: 'key is required' });
      // Validate VAT-specific values
      if (key === 'VAT_ENABLED' && !['true','false'].includes(value)) {
        return res.status(400).json({ ok: false, error: 'VAT_ENABLED must be true or false' });
      }
      if (key === 'VAT_RATE') {
        const n = parseFloat(value);
        if (isNaN(n) || n < 0 || n > 1) return res.status(400).json({ ok: false, error: 'VAT_RATE must be between 0 and 1 (e.g. 0.12 for 12%)' });
      }
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/settings?key=eq.${encodeURIComponent(key)}`,
        { method: 'PATCH', body: JSON.stringify({ value: String(value), updated_at: new Date().toISOString() }) }
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to update setting' });
      invalidateSettingsCache();
      return res.status(200).json({ ok: true, key, value });
    }


    // ══════════════════════════════════════════════════════════════════════
    // TABLE OCCUPANCY STATUS
    // ══════════════════════════════════════════════════════════════════════

    // ── syncToSheets ──────────────────────────────────────────────────────
    // Manual trigger: re-queue all unsynced items + ping GAS URL to run immediately
    if (action === 'syncToSheets') {
      const authSync = await checkAdminAuth();
      if (!authSync.ok) return res.status(403).json({ ok: false, error: authSync.error });

      // Count unsynced items
      const countR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/sheets_sync_log?synced=eq.false&select=id`,
        { headers: { Prefer: 'count=exact' } }
      );
      const pending = Array.isArray(countR.data) ? countR.data.length : 0;

      // Ping GAS URL to trigger syncNow() immediately (fire-and-forget, no-cors OK)
      let gasPinged = false;
      if (GAS_SYNC_URL) {
        try {
          fetch(`${GAS_SYNC_URL}?action=sync`, { method: 'GET' }).catch(() => {});
          gasPinged = true;
        } catch (_) {}
      }

      auditLog({ orderId: 'MANUAL_SYNC', action: 'SHEETS_SYNC_TRIGGERED', actor: { userId: body.userId }, details: { pending, gasPinged } });
      return res.status(200).json({ ok: true, pending, gasPinged, message: `${pending} item(s) queued. GAS will sync within 1 minute.` });
    }

    // ── getPendingSync ─────────────────────────────────────────────────────
    // Called by GAS SheetsSync.gs — returns pending orders/payments to write to Sheets
    // No auth required (GAS runs as sheet owner, data is non-sensitive aggregate)
    if (action === 'getPendingSync') {
      const cronSecret = process.env.CRON_SECRET || '';
      const authHeader = (req.headers?.authorization || '');
      const fromCron   = cronSecret && authHeader === 'Bearer ' + cronSecret;
      if (!fromCron) {
        const authPS = await checkAdminAuth();
        if (!authPS.ok) return res.status(403).json({ ok: false, error: authPS.error });
      }

      // Get pending sync items (limit 100 per batch)
      const batchLimit = Math.min(parseInt(body.limit) || 50, 100);
      const pendingR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/sheets_sync_log?synced=eq.false&order=created_at.asc&limit=${batchLimit}&select=id,table_name,record_id,action`
      );
      if (!pendingR.ok) return res.status(500).json({ ok: false, error: 'Failed to read sync log' });
      const pending = pendingR.data || [];
      if (pending.length === 0) return res.status(200).json({ ok: true, items: [], total: 0 });

      // Fetch full data for each item
      const orderIds  = [...new Set(pending.filter(p=>p.table_name==='dine_in_orders').map(p=>p.record_id))];
      const payIds    = [...new Set(pending.filter(p=>p.table_name==='payments').map(p=>p.record_id))];
      const syncLogIds = pending.map(p=>p.id);

      // Fetch orders
      let ordersMap = {};
      if (orderIds.length > 0) {
        const oR = await supaFetch(
          `${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=in.(${orderIds.map(id=>`"${id}"`).join(',')})` +
          `&select=order_id,order_no,table_no,customer_name,status,order_type,subtotal,service_charge,` +
          `vat_amount,total,discounted_total,discount_type,discount_amount,payment_method,payment_status,` +
          `receipt_type,receipt_email,notes,cancel_reason,created_at,is_test`
        );
        if (oR.ok) (oR.data||[]).forEach(o => { ordersMap[o.order_id] = o; });
      }

      // Fetch order items (for INSERTs only)
      let itemsMap = {};
      const insertOrderIds = pending.filter(p=>p.table_name==='dine_in_orders'&&p.action==='INSERT').map(p=>p.record_id);
      if (insertOrderIds.length > 0) {
        const iR = await supaFetch(
          `${SUPABASE_URL}/rest/v1/dine_in_order_items?order_id=in.(${insertOrderIds.map(id=>`"${id}"`).join(',')})` +
          `&order=id.asc&select=order_id,item_code,item_name,unit_price,qty,line_total,size_choice,sugar_choice,item_notes,addons`
        );
        if (iR.ok) {
          (iR.data||[]).forEach(it => {
            if (!itemsMap[it.order_id]) itemsMap[it.order_id] = [];
            itemsMap[it.order_id].push(it);
          });
        }
      }

      // Fetch payments
      let paymentsMap = {};
      if (payIds.length > 0) {
        const pR = await supaFetch(
          `${SUPABASE_URL}/rest/v1/payments?payment_id=in.(${payIds.map(id=>`"${id}"`).join(',')})` +
          `&select=payment_id,order_id,amount,payment_method,status,proof_url,proof_filename,verified_by,verified_at,rejection_reason,created_at`
        );
        if (pR.ok) (pR.data||[]).forEach(p => { paymentsMap[p.payment_id] = p; });
      }

      // Build response items, collect skipped IDs to auto-mark synced
      const skippedSyncIds = [];
      const items = pending.map(p => {
        if (p.table_name === 'dine_in_orders') {
          const order = ordersMap[p.record_id];
          if (!order || order.is_test || order.is_deleted) {
            skippedSyncIds.push(p.id); // skip: test, deleted, or not found
            return null;
          }
          return {
            syncId: p.id, tableType: 'ORDER', action: p.action,
            order,
            orderItems: itemsMap[p.record_id] || []
          };
        } else if (p.table_name === 'payments') {
          const payment = paymentsMap[p.record_id];
          if (!payment) return null;
          // Convert base64 proof to Storage URL reference
          if (payment.proof_url && payment.proof_url.startsWith('data:')) {
            payment.proof_url = payment.proof_filename
              ? `${SUPABASE_URL}/storage/v1/object/public/payment-proofs/${payment.proof_filename}`
              : '[View in admin panel]';
          }
          return { syncId: p.id, tableType: 'PAYMENT', action: p.action, payment };
        }
        return { syncId: p.id, tableType: 'OTHER', action: p.action };
      }).filter(Boolean);

      // Auto-mark test/missing orders as synced so they don't pile up
      if (skippedSyncIds.length > 0) {
        supa('PATCH', 'sheets_sync_log',
          { synced: true, synced_at: new Date().toISOString() },
          { id: `in.(${skippedSyncIds.join(',')})` }
        ).catch(() => {});
      }

      return res.status(200).json({ ok: true, items, total: pending.length, syncLogIds, skipped: skippedSyncIds.length });
    }

    // ── markSynced ─────────────────────────────────────────────────────────
    // Called by GAS after successfully writing items to Sheets
    if (action === 'markSynced') {
      const cronSecret = process.env.CRON_SECRET || '';
      const authHeader = (req.headers?.authorization || '');
      const fromCron   = cronSecret && authHeader === 'Bearer ' + cronSecret;
      // Also accept legacy body.secret for backward compat (GAS caller)
      const legacySecret = String(body.secret || '').trim();
      const legacyOk     = cronSecret && legacySecret === cronSecret;
      if (!fromCron && !legacyOk) {
        const authMS = await checkAdminAuth();
        if (!authMS.ok) return res.status(403).json({ ok: false, error: authMS.error });
      }
      const ids = body.ids;
      if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ ok: false, error: 'ids array required' });
      const validIds = ids.filter(id => Number.isInteger(id) && id > 0);
      if (validIds.length === 0) return res.status(400).json({ ok: false, error: 'No valid ids' });

      const r = await supa('PATCH', 'sheets_sync_log',
        { synced: true, synced_at: new Date().toISOString() },
        { id: `in.(${validIds.join(',')})` }
      );
      return res.status(200).json({ ok: r.ok, marked: validIds.length });
    }

    // ── getTableStatus ─────────────────────────────────────────────────────
    if (action === 'getTableStatus') {
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/cafe_tables?select=id,table_number,table_name,capacity,qr_token,status&order=table_number.asc`
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to fetch tables' });
      return res.status(200).json({ ok: true, tables: r.data || [] });
    }

    // ── setTableStatus ─────────────────────────────────────────────────────
    if (action === 'setTableStatus') {
      const auth = await checkAuth(['OWNER','ADMIN','CASHIER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { tableNumber, status } = body;
      const valid = ['AVAILABLE','OCCUPIED','RESERVED','MAINTENANCE'];
      if (!valid.includes(status)) return res.status(400).json({ ok: false, error: 'Invalid status' });
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/cafe_tables?table_number=eq.${encodeURIComponent(tableNumber)}`,
        { method: 'PATCH', body: JSON.stringify({ status }) }
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to update table status' });
      return res.status(200).json({ ok: true, tableNumber, status });
    }

    // ══════════════════════════════════════════════════════════════════════
    // RESERVATIONS ↔ TABLE AUTO-LINK
    // ══════════════════════════════════════════════════════════════════════

    // ── linkReservationTable ───────────────────────────────────────────────
    if (action === 'linkReservationTable') {
      const auth = await checkAuth(['OWNER','ADMIN','CASHIER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { resId, tableNumber } = body;
      if (!resId) return res.status(400).json({ ok: false, error: 'resId required' });

      // Get table UUID from number
      let tableId = null;
      if (tableNumber) {
        const tRes = await supaFetch(
          `${SUPABASE_URL}/rest/v1/cafe_tables?table_number=eq.${encodeURIComponent(tableNumber)}&select=id`
        );
        if (tRes.ok && tRes.data && tRes.data[0]) tableId = tRes.data[0].id;
      }

      // Update reservation
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/reservations?res_id=eq.${encodeURIComponent(resId)}`,
        { method: 'PATCH', body: JSON.stringify({
          table_id: tableId,
          confirmed_by: body.userId,
          status: tableNumber ? 'CONFIRMED' : 'CONFIRMED'
        })}
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to link reservation' });

      // Auto-set table to RESERVED if tableNumber provided
      if (tableNumber) {
        await supaFetch(
          `${SUPABASE_URL}/rest/v1/cafe_tables?table_number=eq.${encodeURIComponent(tableNumber)}`,
          { method: 'PATCH', body: JSON.stringify({ status: 'RESERVED' }) }
        );
      }
      return res.status(200).json({ ok: true, resId, tableNumber, tableId });
    }

    // ── seatReservation ────────────────────────────────────────────────────
    if (action === 'seatReservation') {
      const auth = await checkAuth(['OWNER','ADMIN','CASHIER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { resId } = body;

      // Get reservation to find linked table
      const resRes = await supaFetch(
        `${SUPABASE_URL}/rest/v1/reservations?res_id=eq.${encodeURIComponent(resId)}&select=table_id,status`
      );
      if (!resRes.ok || !resRes.data || !resRes.data[0]) {
        return res.status(404).json({ ok: false, error: 'Reservation not found' });
      }
      const res_rec = resRes.data[0];

      // Mark reservation SEATED
      await supaFetch(
        `${SUPABASE_URL}/rest/v1/reservations?res_id=eq.${encodeURIComponent(resId)}`,
        { method: 'PATCH', body: JSON.stringify({ status: 'SEATED' }) }
      );

      // Set table OCCUPIED
      if (res_rec.table_id) {
        await supaFetch(
          `${SUPABASE_URL}/rest/v1/cafe_tables?id=eq.${res_rec.table_id}`,
          { method: 'PATCH', body: JSON.stringify({ status: 'OCCUPIED' }) }
        );
      }
      return res.status(200).json({ ok: true, resId, status: 'SEATED' });
    }

    // ══════════════════════════════════════════════════════════════════════
    // INVENTORY
    // ══════════════════════════════════════════════════════════════════════

    // ── getInventory ───────────────────────────────────────────────────────
    if (action === 'getInventory') {
      const auth = await checkAuth(['OWNER','ADMIN','CASHIER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/inventory?select=*&order=item_code.asc`
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to fetch inventory' });
      // Attach menu item names
      const menuR = await supaFetch(`${SUPABASE_URL}/rest/v1/menu_items?select=item_code,name,is_active`);
      const menuMap = {};
      (menuR.data || []).forEach(m => { menuMap[m.item_code] = m; });
      const items = (r.data || []).map(i => ({
        ...i,
        item_name: menuMap[i.item_code]?.name || i.item_code,
        item_active: menuMap[i.item_code]?.is_active ?? true,
        low_stock: i.stock_qty <= i.low_stock_threshold,
        selling_price: i.selling_price || 0,
        size_per_unit: i.size_per_unit || '',
        photo_url: i.photo_url || null,
      }));
      return res.status(200).json({ ok: true, items });
    }

    // ── uploadInventoryPhoto ───────────────────────────────────────────────
    if (action === 'uploadInventoryPhoto') {
      const auth = await checkAdminAuth();
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { itemCode, imageBase64, mimeType } = body;
      if (!itemCode || !imageBase64) return res.status(400).json({ ok: false, error: 'itemCode + imageBase64 required' });
      const ext = (mimeType || 'image/jpeg').split('/')[1] || 'jpg';
      const filename = `${itemCode.replace(/[^a-zA-Z0-9-_]/g, '_')}.${ext}`;
      // Decode base64 and upload to Supabase Storage
      const imgBuffer = Buffer.from(imageBase64, 'base64');
      const uploadResp = await fetch(`${SUPABASE_URL}/storage/v1/object/inventory/${filename}`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': mimeType || 'image/jpeg',
          'x-upsert': 'true',
        },
        body: imgBuffer,
      });
      if (!uploadResp.ok) {
        const errText = await uploadResp.text();
        return res.status(500).json({ ok: false, error: 'Upload failed: ' + errText });
      }
      const photoUrl = `${SUPABASE_URL}/storage/v1/object/public/inventory/${filename}`;
      // Save URL on inventory row
      await supaFetch(
        `${SUPABASE_URL}/rest/v1/inventory?item_code=eq.${encodeURIComponent(itemCode)}`,
        { method: 'PATCH', body: JSON.stringify({ photo_url: photoUrl, updated_at: new Date().toISOString() }) }
      );
      return res.status(200).json({ ok: true, photoUrl, filename });
    }

    // ── upsertInventory ────────────────────────────────────────────────────
    if (action === 'upsertInventory') {
      const auth = await checkAdminAuth();
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { itemCode, stockQty, lowStockThreshold, unit, costPerUnit, sellingPrice,
              sizePerUnit, autoDisable, restockNotes, photoUrl } = body;
      if (!itemCode) return res.status(400).json({ ok: false, error: 'itemCode required' });
      const row = {
        item_code: itemCode,
        stock_qty: parseFloat(stockQty) || 0,
        low_stock_threshold: parseFloat(lowStockThreshold) || 10,
        unit: unit || 'pcs',
        cost_per_unit: parseFloat(costPerUnit) || 0,
        selling_price: parseFloat(sellingPrice) || 0,
        size_per_unit: sizePerUnit || '',
        auto_disable: !!autoDisable,
        restock_notes: restockNotes || '',
        last_restocked_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      if (photoUrl) row.photo_url = photoUrl;
      // Try PATCH first (update existing), fallback to POST (create new)
      const existsR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/inventory?item_code=eq.${encodeURIComponent(itemCode)}&select=id`
      );
      const exists = Array.isArray(existsR.data) && existsR.data.length > 0;
      const r = exists
        ? await supaFetch(
            `${SUPABASE_URL}/rest/v1/inventory?item_code=eq.${encodeURIComponent(itemCode)}`,
            { method: 'PATCH', body: JSON.stringify(row) }
          )
        : await supaFetch(
            `${SUPABASE_URL}/rest/v1/inventory`,
            { method: 'POST', body: JSON.stringify(row),
              headers: { Prefer: 'return=representation' } }
          );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to save inventory' });
      // Log restock
      await supaFetch(`${SUPABASE_URL}/rest/v1/inventory_log`, {
        method: 'POST',
        body: JSON.stringify({
          item_code: itemCode, change_type: 'RESTOCK',
          qty_change: parseFloat(stockQty) || 0,
          qty_after: parseFloat(stockQty) || 0,
          notes: restockNotes || 'Manual restock', actor_id: body.userId,
        })
      });
      return res.status(200).json({ ok: true, item: r.data?.[0] || row });
    }

    // ── adjustInventory ────────────────────────────────────────────────────
    if (action === 'adjustInventory') {
      const auth = await checkAdminAuth();
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { itemCode, adjustment, changeType, notes, unitPrice, reference, direction } = body;
      if (!itemCode || adjustment === undefined) return res.status(400).json({ ok: false, error: 'itemCode + adjustment required' });
      // direction: 'IN' = positive (RESTOCK/RETURN), 'OUT' = negative (WASTE/SALE)
      // If direction provided, force the sign; otherwise trust the sign of adjustment
      let qty = parseFloat(adjustment);
      if (direction === 'IN' && qty < 0) qty = -qty;
      if (direction === 'OUT' && qty > 0) qty = -qty;
      const validTypes = ['RESTOCK','ADJUSTMENT','WASTE','RETURN','SALE'];
      let type = validTypes.includes(changeType) ? changeType : 'ADJUSTMENT';
      // Auto-assign type based on direction if not specified
      if (!changeType) type = direction === 'IN' ? 'RESTOCK' : direction === 'OUT' ? 'WASTE' : 'ADJUSTMENT';
      // Get current
      const cur = await supaFetch(`${SUPABASE_URL}/rest/v1/inventory?item_code=eq.${encodeURIComponent(itemCode)}&select=stock_qty,auto_disable`);
      const current = cur.data?.[0];
      if (!current) return res.status(404).json({ ok: false, error: 'Item not in inventory' });
      const newQty = Math.max(0, parseFloat(current.stock_qty) + qty);
      const updatePatch = { stock_qty: newQty, updated_at: new Date().toISOString() };
      if (direction === 'IN') updatePatch.last_restocked_at = new Date().toISOString();
      await supaFetch(`${SUPABASE_URL}/rest/v1/inventory?item_code=eq.${encodeURIComponent(itemCode)}`,
        { method: 'PATCH', body: JSON.stringify(updatePatch) });
      // Auto-disable menu item if stock hits 0
      if (newQty === 0 && current.auto_disable) {
        await supaFetch(`${SUPABASE_URL}/rest/v1/menu_items?item_code=eq.${encodeURIComponent(itemCode)}`,
          { method: 'PATCH', body: JSON.stringify({ is_active: false }) });
      }
      // Log with new fields
      await supaFetch(`${SUPABASE_URL}/rest/v1/inventory_log`, { method: 'POST',
        body: JSON.stringify({ item_code: itemCode, change_type: type,
          qty_before: parseFloat(current.stock_qty), qty_change: qty,
          qty_after: newQty, notes: notes || '', actor_id: body.userId,
          unit_price: parseFloat(unitPrice) || 0,
          reference: reference || '' }) });
      return res.status(200).json({ ok: true, itemCode, qtyBefore: current.stock_qty, qtyAfter: newQty, direction: qty >= 0 ? 'IN' : 'OUT' });
    }

    // ── getInventoryLog ────────────────────────────────────────────────────
    if (action === 'getInventoryLog') {
      const auth = await checkAuth(['OWNER','ADMIN']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const limit = Math.min(parseInt(body.limit) || 50, 200);
      const filter = body.itemCode ? `&item_code=eq.${encodeURIComponent(body.itemCode)}` : '';
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/inventory_log?select=*&order=created_at.desc&limit=${limit}${filter}`
      );
      return res.status(200).json({ ok: r.ok, logs: r.data || [] });
    }

    // ══════════════════════════════════════════════════════════════════════
    // ADD-ONS / MODIFIERS
    // ══════════════════════════════════════════════════════════════════════

    // ── getAddons ──────────────────────────────────────────────────────────
    if (action === 'getAddons') {
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/menu_addons?is_active=eq.true&order=sort_order.asc,name.asc`
      );
      return res.status(200).json({ ok: r.ok, addons: r.data || [] });
    }

    // ── getAddonsAdmin ─────────────────────────────────────────────────────
    if (action === 'getAddonsAdmin') {
      const auth = await checkAdminAuth();
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/menu_addons?order=sort_order.asc,name.asc`
      );
      return res.status(200).json({ ok: r.ok, addons: r.data || [] });
    }

    // ── saveAddon ──────────────────────────────────────────────────────────
    if (action === 'saveAddon') {
      const auth = await checkAdminAuth();
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { addonCode, name, price, appliesToAll, appliesToCodes, sortOrder } = body;
      if (!name) return res.status(400).json({ ok: false, error: 'name required' });
      const code = addonCode || 'ADD-' + Date.now();
      const row = {
        addon_code: code, name: String(name).trim().substring(0, 80),
        price: parseFloat(price) || 0,
        applies_to_all: appliesToAll !== false,
        applies_to_codes: Array.isArray(appliesToCodes) ? appliesToCodes : [],
        is_active: body.isActive !== false,
        sort_order: parseInt(sortOrder) || 0,
        updated_at: new Date().toISOString(),
      };
      const method = addonCode ? 'PATCH' : 'POST';
      const url = addonCode
        ? `${SUPABASE_URL}/rest/v1/menu_addons?addon_code=eq.${encodeURIComponent(addonCode)}`
        : `${SUPABASE_URL}/rest/v1/menu_addons`;
      const r = await supaFetch(url, { method, body: JSON.stringify(row),
        headers: method === 'POST' ? { Prefer: 'return=representation' } : {} });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to save addon' });
      return res.status(200).json({ ok: true, addon: method === 'POST' ? r.data?.[0] : row });
    }

    // ── deleteAddon ────────────────────────────────────────────────────────
    if (action === 'deleteAddon') {
      const auth = await checkAdminAuth();
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { addonCode } = body;
      if (!addonCode) return res.status(400).json({ ok: false, error: 'addonCode required' });
      // Soft delete
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/menu_addons?addon_code=eq.${encodeURIComponent(addonCode)}`,
        { method: 'PATCH', body: JSON.stringify({ is_active: false, updated_at: new Date().toISOString() }) }
      );
      return res.status(200).json({ ok: r.ok });
    }

    // ══════════════════════════════════════════════════════════════════════
    // VOID / REFUND WORKFLOW
    // ══════════════════════════════════════════════════════════════════════

    // ── processRefund ──────────────────────────────────────────────────────
    if (action === 'processRefund') {
      const auth = await checkAuth(['OWNER','ADMIN']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { orderId, refundType, refundAmount, reasonCode, reasonNote, refundMethod, itemsRefunded } = body;
      const validTypes = ['FULL','PARTIAL','VOID'];
      const validReasons = ['WRONG_ORDER','DUPLICATE','COMPLAINT','OVERCHARGE','ITEM_UNAVAILABLE','OTHER'];
      if (!orderId) return res.status(400).json({ ok: false, error: 'orderId required' });
      if (!validTypes.includes(refundType)) return res.status(400).json({ ok: false, error: 'Invalid refundType' });
      if (!validReasons.includes(reasonCode)) return res.status(400).json({ ok: false, error: 'Invalid reasonCode' });
      if (parseFloat(refundAmount) < 0) return res.status(400).json({ ok: false, error: 'refundAmount cannot be negative' });

      // Verify order exists
      const orderRes = await supaFetch(
        `${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}&select=order_id,total,status`
      );
      if (!orderRes.ok || !orderRes.data?.length) return res.status(404).json({ ok: false, error: 'Order not found' });

      const refundId = 'REF-' + Date.now();
      const row = {
        refund_id: refundId,
        order_id: orderId,
        refund_type: refundType,
        refund_amount: parseFloat(refundAmount) || 0,
        reason_code: reasonCode,
        reason_note: reasonNote || '',
        refund_method: refundMethod || '',
        items_refunded: Array.isArray(itemsRefunded) ? itemsRefunded : [],
        processed_by: body.userId,
        status: 'PROCESSED',
      };
      const r = await supaFetch(`${SUPABASE_URL}/rest/v1/refunds`,
        { method: 'POST', body: JSON.stringify(row), headers: { Prefer: 'return=representation' } });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to save refund' });

      // If VOID — cancel the order
      if (refundType === 'VOID') {
        await supaFetch(
          `${SUPABASE_URL}/rest/v1/dine_in_orders?order_id=eq.${encodeURIComponent(orderId)}`,
          { method: 'PATCH', body: JSON.stringify({ status: 'CANCELLED', cancel_reason: `VOID: ${reasonNote || reasonCode}` }) }
        );
      }
      // Audit log
      await supaFetch(`${SUPABASE_URL}/rest/v1/order_audit_logs`, { method: 'POST',
        body: JSON.stringify({ order_id: orderId, action: 'REFUND_PROCESSED',
          actor_id: body.userId, actor_name: auth.role,
          details: { refundId, refundType, refundAmount, reasonCode } }) });

      return res.status(200).json({ ok: true, refundId, refundType, refundAmount });
    }

    // ── getRefunds ─────────────────────────────────────────────────────────
    // ── getPromoCodes ──────────────────────────────────────────────────────
    // ── sendSalesReport ────────────────────────────────────────────────────
    if (action === 'sendSalesReport') {
      const auth = await checkAuth(['OWNER','ADMIN']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { toEmail, dateFrom, dateTo, reportHtml, subject } = body;
      if (!toEmail) return res.status(400).json({ ok: false, error: 'toEmail required' });
      if (!reportHtml) return res.status(400).json({ ok: false, error: 'reportHtml required' });
      try {
        const resp = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: `YANI Garden Cafe <${FROM_EMAIL}>`,
            to: [toEmail],
            subject: subject || `📊 YANI Sales Report — ${dateFrom} to ${dateTo}`,
            html: reportHtml,
          }),
        });
        const result = await resp.json();
        if (!resp.ok) return res.status(500).json({ ok: false, error: result.message || 'Email failed' });
        return res.status(200).json({ ok: true, emailId: result.id });
      } catch(e) {
        return res.status(500).json({ ok: false, error: e.message });
      }
    }

    if (action === 'getPromoCodes') {
      const auth = await checkAuth(['ADMIN','OWNER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const r = await supaFetch(`${SUPABASE_URL}/rest/v1/promo_codes?order=created_at.desc&select=*`);
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to fetch promo codes' });
      return res.status(200).json({ ok: true, codes: r.data || [] });
    }

    // ── createPromoCode ────────────────────────────────────────────────────
    if (action === 'createPromoCode') {
      const auth = await checkAuth(['ADMIN','OWNER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { code, discount_type, discount_value, valid_from, valid_until, max_uses, description } = body;
      if (!code || !discount_type || !discount_value) return res.status(400).json({ ok: false, error: 'code, discount_type, and discount_value required' });
      const payload = {
        code: String(code).toUpperCase().trim(),
        discount_type,
        discount_value: parseFloat(discount_value),
        valid_from: valid_from || null,
        valid_until: valid_until || null,
        max_uses: max_uses ? parseInt(max_uses) : null,
        description: description || null,
        used_count: 0,
        is_active: true,
        created_at: new Date().toISOString()
      };
      const r = await supaFetch(`${SUPABASE_URL}/rest/v1/promo_codes`, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Prefer': 'return=representation' }
      });
      if (!r.ok) return res.status(500).json({ ok: false, error: r.data?.message || 'Failed to create promo code' });
      return res.status(200).json({ ok: true, code: r.data[0] });
    }

    // ── updatePromoCode ────────────────────────────────────────────────────
    if (action === 'updatePromoCode') {
      const auth = await checkAuth(['ADMIN','OWNER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { id, is_active, discount_value, valid_until, max_uses, description } = body;
      if (!id) return res.status(400).json({ ok: false, error: 'id required' });
      const updates = {};
      if (is_active !== undefined) updates.is_active = is_active;
      if (discount_value !== undefined) updates.discount_value = parseFloat(discount_value);
      if (valid_until !== undefined) updates.valid_until = valid_until || null;
      if (max_uses !== undefined) updates.max_uses = max_uses ? parseInt(max_uses) : null;
      if (description !== undefined) updates.description = description;
      const r = await supaFetch(`${SUPABASE_URL}/rest/v1/promo_codes?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH', body: JSON.stringify(updates)
      });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to update promo code' });
      return res.status(200).json({ ok: true });
    }

    // ── deletePromoCode ────────────────────────────────────────────────────
    if (action === 'deletePromoCode') {
      const auth = await checkAuth(['OWNER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { id } = body;
      if (!id) return res.status(400).json({ ok: false, error: 'id required' });
      const r = await supaFetch(`${SUPABASE_URL}/rest/v1/promo_codes?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to delete promo code' });
      return res.status(200).json({ ok: true });
    }

    // ── validatePromoCode (used by customer POS) ───────────────────────────
    if (action === 'validatePromoCode') {
      const { code, subtotal } = body;
      if (!code) return res.status(400).json({ ok: false, error: 'code required' });
      const r = await supaFetch(`${SUPABASE_URL}/rest/v1/promo_codes?code=eq.${encodeURIComponent(code.toUpperCase())}&is_active=eq.true&select=*&limit=1`);
      if (!r.ok || !r.data?.length) return res.status(200).json({ ok: false, error: 'Invalid or expired promo code' });
      const pc = r.data[0];
      const now = new Date();
      if (pc.valid_from && new Date(pc.valid_from) > now) return res.status(200).json({ ok: false, error: 'Promo code not yet active' });
      if (pc.valid_until && new Date(pc.valid_until) < now) return res.status(200).json({ ok: false, error: 'Promo code has expired' });
      if (pc.max_uses && pc.used_count >= pc.max_uses) return res.status(200).json({ ok: false, error: 'Promo code usage limit reached' });
      const sub = parseFloat(subtotal) || 0;
      const discount = pc.discount_type === 'PERCENT' ? Math.round(sub * pc.discount_value / 100 * 100) / 100 : parseFloat(pc.discount_value);
      return res.status(200).json({ ok: true, code: pc.code, discount_type: pc.discount_type, discount_value: pc.discount_value, discount_amount: discount, description: pc.description });
    }

    if (action === 'getRefunds') {
      const auth = await checkAuth(['OWNER','ADMIN']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const limit = Math.min(parseInt(body.limit) || 50, 200);
      const filter = body.orderId ? `&order_id=eq.${encodeURIComponent(body.orderId)}` : '';
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/refunds?select=*&order=created_at.desc&limit=${limit}${filter}`
      );
      return res.status(200).json({ ok: r.ok, refunds: r.data || [] });
    }

    // ══════════════════════════════════════════════════════════════════════
    // CASH DRAWER / EOD RECONCILIATION
    // ══════════════════════════════════════════════════════════════════════

    // ── openCashSession ────────────────────────────────────────────────────
    if (action === 'openCashSession') {
      const auth = await checkAuth(['OWNER','ADMIN','CASHIER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      // Check no session is already open
      const existing = await supaFetch(
        `${SUPABASE_URL}/rest/v1/cash_sessions?status=eq.OPEN&select=session_id,opened_at,opened_by`
      );
      if (existing.ok && existing.data?.length) {
        return res.status(200).json({ ok: false, error: 'A cash session is already open',
          existingSession: existing.data[0] });
      }
      const sessionId = 'CASH-' + Date.now();
      const row = {
        session_id: sessionId,
        shift: body.shift || 'AM',
        opened_by: body.userId,
        opening_float: parseFloat(body.openingFloat) || 0,
        status: 'OPEN',
        opened_at: new Date().toISOString(),
      };
      const r = await supaFetch(`${SUPABASE_URL}/rest/v1/cash_sessions`,
        { method: 'POST', body: JSON.stringify(row), headers: { Prefer: 'return=representation' } });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to open cash session' });
      return res.status(200).json({ ok: true, sessionId, shift: row.shift, openingFloat: row.opening_float });
    }

    // ── closeCashSession ───────────────────────────────────────────────────
    if (action === 'closeCashSession') {
      const auth = await checkAuth(['OWNER','ADMIN','CASHIER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { sessionId, closingCount, denominationBreakdown, notes } = body;
      if (!sessionId) return res.status(400).json({ ok: false, error: 'sessionId required' });

      // Get session + compute expected cash (cash sales since session opened)
      const sessRes = await supaFetch(
        `${SUPABASE_URL}/rest/v1/cash_sessions?session_id=eq.${encodeURIComponent(sessionId)}&select=*`
      );
      if (!sessRes.ok || !sessRes.data?.length) return res.status(404).json({ ok: false, error: 'Session not found' });
      const sess = sessRes.data[0];

      // Sum cash sales since session opened — use Array.isArray guard to prevent .reduce crash
      const salesRes = await supaFetch(
        `${SUPABASE_URL}/rest/v1/dine_in_orders?status=eq.COMPLETED&is_deleted=eq.false&created_at=gte.${encodeURIComponent(sess.opened_at)}&select=total,payment_method,discounted_total`
      );
      const orders = Array.isArray(salesRes.data) ? salesRes.data : [];
      const totalSales = orders.reduce((s, o) => s + parseFloat(o.discounted_total || o.total || 0), 0);
      const cashSales = orders
        .filter(o => (o.payment_method || '').toUpperCase().includes('CASH'))
        .reduce((s, o) => s + parseFloat(o.discounted_total || o.total || 0), 0);
      const expectedCash = parseFloat(sess.opening_float || 0) + cashSales;
      const closing = parseFloat(closingCount) || 0;
      const variance = closing - expectedCash;

      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/cash_sessions?session_id=eq.${encodeURIComponent(sessionId)}`,
        { method: 'PATCH', body: JSON.stringify({
          closed_by: body.userId,
          closing_count: closing,
          expected_cash: expectedCash,
          variance,
          cash_sales: cashSales,
          total_sales: totalSales,
          denomination_breakdown: denominationBreakdown || {},
          notes: notes || '',
          status: 'CLOSED',
          closed_at: new Date().toISOString(),
        })}
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to close session' });
      return res.status(200).json({
        ok: true, sessionId, totalSales, cashSales,
        openingFloat: sess.opening_float, expectedCash, closingCount: closing, variance,
        overShort: variance >= 0 ? `OVER ₱${Math.abs(variance).toFixed(2)}` : `SHORT ₱${Math.abs(variance).toFixed(2)}`
      });
    }

    // ── getCashSessions ────────────────────────────────────────────────────
    if (action === 'getCashSessions') {
      const auth = await checkAuth(['OWNER','ADMIN']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const limit = Math.min(parseInt(body.limit) || 20, 100);
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/cash_sessions?select=*&order=created_at.desc&limit=${limit}`
      );
      return res.status(200).json({ ok: r.ok, sessions: r.data || [] });
    }

    // ── getOpenCashSession ─────────────────────────────────────────────────
    if (action === 'getOpenCashSession') {
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/cash_sessions?status=eq.OPEN&select=*&order=opened_at.desc&limit=1`
      );
      return res.status(200).json({ ok: r.ok, session: r.data?.[0] || null });
    }

    // ── runMigration (OWNER only - creates tables if not exist) ───────────────
    if (action === 'runMigration') {
      const auth = await checkAuth(['OWNER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const sql = `
        CREATE TABLE IF NOT EXISTS promo_codes (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          code text UNIQUE NOT NULL,
          discount_type text NOT NULL CHECK (discount_type IN ('PERCENT','FIXED')),
          discount_value numeric NOT NULL CHECK (discount_value > 0),
          description text,
          valid_from timestamptz,
          valid_until timestamptz,
          max_uses integer,
          used_count integer DEFAULT 0,
          is_active boolean DEFAULT true,
          created_at timestamptz DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS promo_codes_code_idx ON promo_codes(code);
        CREATE INDEX IF NOT EXISTS promo_codes_active_idx ON promo_codes(is_active);
      `;
      const r = await supaFetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
        method: 'POST', body: JSON.stringify({ sql })
      });
      // Try direct query endpoint as fallback
      const r2 = await fetch(`${SUPABASE_URL.replace('.supabase.co','')}/pg/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
        body: JSON.stringify({ query: sql })
      });
      return res.status(200).json({ ok: true, msg: 'Migration attempted' });
    }


  // ── HR Loan/Doc/Incident/Performance/Leave/Clock APIs ───────────────────
  const TENANT_HR = '11111111-1111-4111-8111-111111111111';

  if (action === 'getHRLoans') {
    const r = await supaFetch(SUPABASE_URL+'/rest/v1/hr_staff_loans?staff_id=eq.'+body.staffId+'&tenant_id=eq.'+TENANT_HR+'&order=created_at.desc');
    return res.status(200).json({ ok:true, loans: r.data||[] });
  }
  if (action === 'addHRLoan') {
    const authL = await checkAuth(['OWNER','ADMIN','MANAGER']);
    if (!authL.ok) return res.status(403).json({ok:false,error:'Unauthorized'});
    const {staffId,principal,notes,start_date,monthly_amortization} = body;
    const r = await supaFetch(SUPABASE_URL+'/rest/v1/hr_staff_loans',
      {method:'POST',headers:{Prefer:'return=representation'},
       body:JSON.stringify({tenant_id:TENANT_HR,staff_id:staffId,principal:parseFloat(principal),balance_remaining:parseFloat(principal),monthly_amortization:monthly_amortization?parseFloat(monthly_amortization):null,start_date:start_date||null,notes:notes||null,status:'ACTIVE'})});
    return res.status(200).json({ok:r.ok,loan:Array.isArray(r.data)?r.data[0]:r.data});
  }
  if (action === 'updateHRLoan') {
    const authL = await checkAuth(['OWNER','ADMIN','MANAGER']);
    if (!authL.ok) return res.status(403).json({ok:false,error:'Unauthorized'});
    const p={};['status','balance_remaining','notes','monthly_amortization'].forEach(k=>{if(body[k]!==undefined)p[k]=body[k];});
    const r = await supaFetch(SUPABASE_URL+'/rest/v1/hr_staff_loans?id=eq.'+body.loanId,{method:'PATCH',body:JSON.stringify(p)});
    return res.status(200).json({ok:r.ok});
  }
  if (action === 'getHRDocuments') {
    const r = await supaFetch(SUPABASE_URL+'/rest/v1/hr_staff_documents?staff_id=eq.'+body.staffId+'&tenant_id=eq.'+TENANT_HR+'&order=created_at.desc');
    return res.status(200).json({ok:true,documents:r.data||[]});
  }
  if (action === 'addHRDocument') {
    const authD = await checkAuth(['OWNER','ADMIN','MANAGER']);
    if (!authD.ok) return res.status(403).json({ok:false,error:'Unauthorized'});
    const {staffId,document_type,notes,expiry_date,file_link} = body;
    const r = await supaFetch(SUPABASE_URL+'/rest/v1/hr_staff_documents',
      {method:'POST',headers:{Prefer:'return=representation'},
       body:JSON.stringify({tenant_id:TENANT_HR,staff_id:staffId,document_type,notes:notes||null,expiry_date:expiry_date||null,file_link:file_link||null,verification_status:'PENDING'})});
    return res.status(200).json({ok:r.ok,document:Array.isArray(r.data)?r.data[0]:r.data});
  }
  if (action === 'getHRIncidents') {
    const r = await supaFetch(SUPABASE_URL+'/rest/v1/hr_staff_incidents?staff_id=eq.'+body.staffId+'&tenant_id=eq.'+TENANT_HR+'&order=incident_date.desc');
    return res.status(200).json({ok:true,incidents:r.data||[]});
  }
  if (action === 'addHRIncident') {
    const authI = await checkAuth(['OWNER','ADMIN','MANAGER']);
    if (!authI.ok) return res.status(403).json({ok:false,error:'Unauthorized'});
    const {staffId,incident_type,incident_date,description,action_taken} = body;
    const r = await supaFetch(SUPABASE_URL+'/rest/v1/hr_staff_incidents',
      {method:'POST',headers:{Prefer:'return=representation'},
       body:JSON.stringify({tenant_id:TENANT_HR,staff_id:staffId,incident_type,incident_date:incident_date||new Date().toISOString().split('T')[0],description:description||null,action_taken:action_taken||null,status:'OPEN'})});
    return res.status(200).json({ok:r.ok,incident:Array.isArray(r.data)?r.data[0]:r.data});
  }
  if (action === 'getHRPerformance') {
    const r = await supaFetch(SUPABASE_URL+'/rest/v1/hr_performance?staff_id=eq.'+body.staffId+'&tenant_id=eq.'+TENANT_HR+'&order=record_date.desc');
    return res.status(200).json({ok:true,records:r.data||[]});
  }
  if (action === 'addHRPerformance') {
    const authP = await checkAuth(['OWNER','ADMIN','MANAGER']);
    if (!authP.ok) return res.status(403).json({ok:false,error:'Unauthorized'});
    const {staffId,record_type,title,description,record_date,rating} = body;
    const r = await supaFetch(SUPABASE_URL+'/rest/v1/hr_performance',
      {method:'POST',headers:{Prefer:'return=representation'},
       body:JSON.stringify({tenant_id:TENANT_HR,staff_id:staffId,record_type,title,description:description||null,record_date:record_date||new Date().toISOString().split('T')[0],rating:rating||null,status:'ACTIVE'})});
    return res.status(200).json({ok:r.ok,record:Array.isArray(r.data)?r.data[0]:r.data});
  }
  if (action === 'getHRLeave') {
    const [reqs,bals] = await Promise.all([
      supaFetch(SUPABASE_URL+'/rest/v1/hr_leave_requests?staff_id=eq.'+body.staffId+'&tenant_id=eq.'+TENANT_HR+'&order=requested_at.desc&limit=20'),
      supaFetch(SUPABASE_URL+'/rest/v1/hr_leave_balances?staff_id=eq.'+body.staffId+'&tenant_id=eq.'+TENANT_HR)
    ]);
    return res.status(200).json({ok:true,requests:reqs.data||[],balances:bals.data||[]});
  }
  if (action === 'getHRTimeLogs') {
    const r = await supaFetch(SUPABASE_URL+'/rest/v1/hr_time_logs?staff_id=eq.'+body.staffId+'&tenant_id=eq.'+TENANT_HR+'&order=event_time.desc&limit='+(body.limit||20));
    return res.status(200).json({ok:true,logs:r.data||[]});
  }

  if (action === 'addHRStaff') {
    const authS = await checkAuth(['OWNER','ADMIN','MANAGER']);
    if (!authS.ok) return res.status(403).json({ok:false,error:'Unauthorized'});
    const {full_name,role,daily_rate,mobile} = body;
    if (!full_name) return res.status(400).json({ok:false,error:'full_name required'});
    const TENANT_HR2 = '11111111-1111-4111-8111-111111111111';
    // Get next staff code
    const existing = await supaFetch(SUPABASE_URL+'/rest/v1/hr_staff_master?tenant_id=eq.'+TENANT_HR2+'&select=staff_code&order=created_at.desc&limit=1');
    const lastCode = existing.data?.[0]?.staff_code || 'USR_000';
    const nextNum = parseInt(lastCode.replace('USR_','')) + 1;
    const staff_code = 'USR_' + String(nextNum).padStart(3,'0');
    const r = await supaFetch(SUPABASE_URL+'/rest/v1/hr_staff_master',
      {method:'POST',headers:{Prefer:'return=representation'},
       body:JSON.stringify({tenant_id:TENANT_HR2,staff_code,full_name,
         role:role||'STAFF',employment_type:'REGULAR',employment_status:'ACTIVE',
         pay_basis:'DAILY',daily_rate:daily_rate?parseFloat(daily_rate):null,
         mobile:mobile||null,date_hired:new Date().toISOString().split('T')[0]})
      });
    return res.status(200).json({ok:r.ok,staff:Array.isArray(r.data)?r.data[0]:r.data});
  }
  if (action === 'addHRLeaveRequest') {
    const TENANT_HR2 = '11111111-1111-4111-8111-111111111111';
    const {staffId,leave_type,start_date,end_date,number_of_days,reason} = body;
    const r = await supaFetch(SUPABASE_URL+'/rest/v1/hr_leave_requests',
      {method:'POST',headers:{Prefer:'return=representation'},
       body:JSON.stringify({tenant_id:TENANT_HR2,staff_id:staffId,leave_type,
         start_date,end_date,number_of_days:parseFloat(number_of_days),
         reason:reason||null,status:'PENDING',is_paid:false})
      });
    return res.status(200).json({ok:r.ok});
  }
  if (action === 'addHRTimeLog') {
    const authT = await checkAuth(['OWNER','ADMIN','MANAGER']);
    if (!authT.ok) return res.status(403).json({ok:false,error:'Unauthorized'});
    const TENANT_HR2 = '11111111-1111-4111-8111-111111111111';
    const {staffId,event_type,log_date,event_time,attendance_source,notes} = body;
    const r = await supaFetch(SUPABASE_URL+'/rest/v1/hr_time_logs',
      {method:'POST',headers:{Prefer:'return=representation'},
       body:JSON.stringify({tenant_id:TENANT_HR2,staff_id:staffId,
         event_type,log_date,event_time,
         attendance_source:attendance_source||'MANUAL',
         notes:notes||null,approval_status:'PENDING'})
      });
    return res.status(200).json({ok:r.ok});
  }

  // ── hrLookupStaff — for clock-in page ────────────────────────────────────
  if (action === 'hrLookupStaff') {
    const TENANT_HR = '11111111-1111-4111-8111-111111111111';
    const sc = String(body.staffCode||'').trim().toUpperCase();
    if (!sc) return res.status(400).json({ok:false,error:'staffCode required'});
    const r = await supaFetch(
      SUPABASE_URL+'/rest/v1/hr_staff_master?staff_code=eq.'+encodeURIComponent(sc)+
      '&tenant_id=eq.'+TENANT_HR+'&select=id,staff_code,full_name,role,employment_status,daily_rate&limit=1'
    );
    const staff = Array.isArray(r.data) ? r.data[0] : null;
    if (!staff) return res.status(200).json({ok:false,error:'Staff not found'});
    if (staff.employment_status !== 'ACTIVE') return res.status(200).json({ok:false,error:'Account inactive'});
    return res.status(200).json({ok:true,staff});
  }

  // ── hrVerifyPin — for clock-in PIN check ──────────────────────────────────
  if (action === 'hrVerifyPin') {
    const TENANT_HR = '11111111-1111-4111-8111-111111111111';
    const sc = String(body.staffCode||'').trim().toUpperCase();
    const pin = String(body.pin||'').trim();
    if (!sc||!pin) return res.status(400).json({ok:false,error:'staffCode + pin required'});
    const r = await supaFetch(
      SUPABASE_URL+'/rest/v1/rpc/hr_verify_pin',
      {method:'POST',body:JSON.stringify({p_tenant:TENANT_HR,p_staff_code:sc,p_pin:pin})}
    );
    const ok = r.data === true;
    return res.status(200).json({ok});
  }

  // ── hrClockEvent — for clock-in page ──────────────────────────────────────
  if (action === 'hrClockEvent') {
    const TENANT_HR = '11111111-1111-4111-8111-111111111111';
    const {staffCode, eventType, pin} = body;
    if (!staffCode||!eventType) return res.status(400).json({ok:false,error:'staffCode + eventType required'});
    // Verify PIN first (re-verify for security)
    if (pin) {
      const vr = await supaFetch(
        SUPABASE_URL+'/rest/v1/rpc/hr_verify_pin',
        {method:'POST',body:JSON.stringify({p_tenant:TENANT_HR,p_staff_code:staffCode.toUpperCase(),p_pin:pin})}
      );
      if (vr.data !== true) return res.status(403).json({ok:false,error:'Invalid PIN'});
    }
    // Get staff ID
    const sr = await supaFetch(
      SUPABASE_URL+'/rest/v1/hr_staff_master?staff_code=eq.'+staffCode.toUpperCase()+'&tenant_id=eq.'+TENANT_HR+'&select=id&limit=1'
    );
    const staffId = sr.data?.[0]?.id;
    if (!staffId) return res.status(404).json({ok:false,error:'Staff not found'});
    // Fire clock event
    const cr = await supaFetch(
      SUPABASE_URL+'/rest/v1/rpc/hr_clock_event',
      {method:'POST',body:JSON.stringify({
        p_tenant:TENANT_HR,p_staff_id:staffId,p_event_type:eventType,
        p_device:'WEB_PORTAL',p_location_ip:req.headers['x-forwarded-for']||''
      })}
    );
    return res.status(200).json({ok:cr.ok,event:cr.data});
  }

  // ── hrEmployeeLogin — for employee portal ─────────────────────────────────
  if (action === 'hrEmployeeLogin') {
    const TENANT_HR = '11111111-1111-4111-8111-111111111111';
    const {staffCode, pin} = body;
    if (!staffCode||!pin) return res.status(400).json({ok:false,error:'staffCode + pin required'});
    const vr = await supaFetch(
      SUPABASE_URL+'/rest/v1/rpc/hr_verify_pin',
      {method:'POST',body:JSON.stringify({p_tenant:TENANT_HR,p_staff_code:staffCode.toUpperCase(),p_pin:pin})}
    );
    if (vr.data !== true) return res.status(200).json({ok:false,error:'Incorrect staff code or PIN'});
    const sr = await supaFetch(
      SUPABASE_URL+'/rest/v1/hr_staff_master?staff_code=eq.'+staffCode.toUpperCase()+
      '&tenant_id=eq.'+TENANT_HR+'&select=id,staff_code,full_name,role,employment_type,employment_status,daily_rate,hourly_rate,pay_basis,mobile,email,date_hired,payout_method&limit=1'
    );
    const staff = sr.data?.[0];
    if (!staff) return res.status(200).json({ok:false,error:'Staff not found'});
    if (staff.employment_status !== 'ACTIVE') return res.status(200).json({ok:false,error:'Account inactive'});
    // Create session token
    const token = 'EP_'+Date.now()+'_'+Math.random().toString(36).slice(2,10).toUpperCase();
    await supaFetch(
      SUPABASE_URL+'/rest/v1/hr_portal_sessions',
      {method:'POST',body:JSON.stringify({token,tenant_id:TENANT_HR,staff_id:staff.id,staff_code:staff.staff_code})}
    );
    return res.status(200).json({ok:true,staff,token});
  }

  // ── hrCompute13thMonth ────────────────────────────────────────────────────
  if (action === 'hrCompute13thMonth') {
    const authHR = await checkAuth(['OWNER','ADMIN','MANAGER']);
    if (!authHR.ok) return res.status(403).json({ok:false,error:'Unauthorized'});
    const TENANT_HR = '11111111-1111-4111-8111-111111111111';
    const year = body.year || new Date().getFullYear();
    // Get all active staff with daily rates
    const sr = await supaFetch(
      SUPABASE_URL+'/rest/v1/hr_staff_master?tenant_id=eq.'+TENANT_HR+
      '&employment_status=eq.ACTIVE&daily_rate=not.is.null&select=id,full_name,daily_rate,pay_basis'
    );
    const staff = sr.data || [];
    const results = [];
    for (const s of staff) {
      // Simplified: total_basic_pay = daily_rate * 26 * months_worked (assume 12 months for now)
      const totalBasic = parseFloat(s.daily_rate) * 26; // 1 month basic
      const thirteenth = Math.round(totalBasic / 12 * 100) / 100;
      results.push({
        staff_id: s.id, name: s.full_name,
        daily_rate: parseFloat(s.daily_rate),
        total_basic_pay: totalBasic,
        thirteenth_month_pay: thirteenth
      });
    }
    return res.status(200).json({ok:true,year,results,note:'Based on current daily rate × 26 days. Update monthly actuals in HR > Loans.'});
  }

  // ── hrGetHolidays ─────────────────────────────────────────────────────────
  if (action === 'hrGetHolidays') {
    const TENANT_HR = '11111111-1111-4111-8111-111111111111';
    const year = body.year || new Date().getFullYear();
    const r = await supaFetch(
      SUPABASE_URL+'/rest/v1/hr_holiday_calendar?tenant_id=eq.'+TENANT_HR+
      '&holiday_date=gte.'+year+'-01-01&holiday_date=lte.'+year+'-12-31'+
      '&is_active=eq.true&order=holiday_date.asc'
    );
    return res.status(200).json({ok:true,holidays:r.data||[]});
  }


  return false;
}
