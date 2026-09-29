// api/handlers/hr.js — HR clock-in, employee portal, public HR actions
import { supaFetch } from '../lib/db.js';
import { SUPABASE_URL } from '../lib/config.js';
import { verifyToken } from '../lib/auth.js';

const TENANT_HR = '11111111-1111-4111-8111-111111111111';

export async function routeHR(action, body, auth, req, res) {
  const { checkAuth } = auth;   // routeHR never destructured this; any handler
                                // calling checkAuth threw a ReferenceError and
                                // surfaced only as 'Internal server error'.

  // ── hrLookupStaff ──────────────────────────────────────────────────────
  // Accepts EITHER staffCode (manual entry) OR qrToken (QR scan). The QR
  // token is a separate rotatable secret — see hrRotateQrToken — so a
  // photographed/old QR can be invalidated without affecting staffCode.
  // Backward-compat: if qrToken doesn't match any qr_token (e.g. an
  // already-printed QR still encoding the plain staff_code), falls back
  // to matching it as a staff_code so existing printed QR codes keep working.
  if (action === 'hrLookupStaff') {
    const sc = String(body.staffCode||'').trim().toUpperCase();
    const qr = String(body.qrToken||'').trim();
    if (!sc && !qr) return res.status(400).json({ok:false,error:'staffCode or qrToken required'});

    let staff = null;
    if (qr) {
      const rQr = await supaFetch(
        SUPABASE_URL+'/rest/v1/hr_staff_master?qr_token=eq.'+encodeURIComponent(qr)+
        '&tenant_id=eq.'+TENANT_HR+'&select=id,staff_code,full_name,role,employment_status,daily_rate&limit=1'
      );
      staff = Array.isArray(rQr.data) ? rQr.data[0] : null;
      if (!staff) {
        // Fallback: treat the scanned value as a legacy plain staff_code
        const rLegacy = await supaFetch(
          SUPABASE_URL+'/rest/v1/hr_staff_master?staff_code=eq.'+encodeURIComponent(qr.toUpperCase())+
          '&tenant_id=eq.'+TENANT_HR+'&select=id,staff_code,full_name,role,employment_status,daily_rate&limit=1'
        );
        staff = Array.isArray(rLegacy.data) ? rLegacy.data[0] : null;
      }
    } else {
      const r = await supaFetch(
        SUPABASE_URL+'/rest/v1/hr_staff_master?staff_code=eq.'+encodeURIComponent(sc)+
        '&tenant_id=eq.'+TENANT_HR+'&select=id,staff_code,full_name,role,employment_status,daily_rate&limit=1'
      );
      staff = Array.isArray(r.data) ? r.data[0] : null;
    }

    if (!staff) return res.status(200).json({ok:false,error:qr?'QR code not recognized':'Staff not found'});
    if (staff.employment_status !== 'ACTIVE') return res.status(200).json({ok:false,error:'Account inactive'});
    return res.status(200).json({ok:true,staff});
  }

  // ── hrVerifyPin ────────────────────────────────────────────────────────
  if (action === 'hrVerifyPin') {
    const sc  = String(body.staffCode||'').trim().toUpperCase();
    const pin = String(body.pin||'').trim();
    if (!sc||!pin) return res.status(400).json({ok:false,error:'staffCode + pin required'});
    const r = await supaFetch(
      SUPABASE_URL+'/rest/v1/rpc/hr_verify_pin',
      {method:'POST',body:JSON.stringify({p_tenant:TENANT_HR,p_staff_code:sc,p_pin:pin})}
    );
    const ok = Array.isArray(r.data) && r.data.length > 0;
    return res.status(200).json({ok});
  }

  // ── hrGetClockStatus ───────────────────────────────────────────────────
  // Returns the staff member's current clock state so the UI can show only
  // the valid next action (e.g. if already clocked in, only offer Clock Out
  // / Break Start — not Clock In again).
  if (action === 'hrGetClockStatus') {
    const sc = String(body.staffCode||'').trim().toUpperCase();
    if (!sc) return res.status(400).json({ok:false,error:'staffCode required'});
    const sr = await supaFetch(
      SUPABASE_URL+'/rest/v1/hr_staff_master?staff_code=eq.'+encodeURIComponent(sc)+
      '&tenant_id=eq.'+TENANT_HR+'&select=id&limit=1'
    );
    const staffId = sr.data?.[0]?.id;
    if (!staffId) return res.status(200).json({ok:false,error:'Staff not found'});

    // One rule for "which shift is this person on", shared with the
    // hr_clock_event() gate: a shift left open at midnight is still the live
    // shift until 06:00. Reading only today's log_date here made the kiosk
    // show "OUT" to closers at 12:30 AM, auto-clock them IN, and split every
    // late shift in two on payroll.
    const st = await supaFetch(SUPABASE_URL+'/rest/v1/rpc/hr_clock_state',
      {method:'POST',body:JSON.stringify({p_tenant:TENANT_HR, p_staff_id:staffId})});
    const row = Array.isArray(st.data) ? st.data[0] : null;
    if (!st.ok || !row) return res.status(200).json({ok:false,error:'Could not read clock state'});

    const phToday = new Date(Date.now() + 8*60*60*1000).toISOString().slice(0,10);
    return res.status(200).json({
      ok:true, state: row.state, lastEvent: row.last_event || null,
      lastEventTime: row.last_event_time || null,
      shiftDate: row.shift_date,                 // the day this tap will be filed under
      shiftIsYesterday: row.shift_date !== phToday,
    });
  }

  // ── hrDailySummary — per-day worked hours for the Clock-in tab ──────────
  // The tab listed raw events and never showed how long anyone worked.
  if (action === 'hrDailySummary') {
    const authDS = await checkAuth(['OWNER']);
    if (!authDS.ok) return res.status(403).json({ok:false,error:'Unauthorized'});
    if (!body.staffId) return res.status(400).json({ok:false,error:'staffId required'});
    const today = new Date(Date.now() + 8*3600*1000).toISOString().slice(0,10);
    const days  = Math.min(parseInt(body.days) || 14, 60);
    const from  = new Date(Date.now() + 8*3600*1000 - days*86400000).toISOString().slice(0,10);
    const r = await supaFetch(SUPABASE_URL+'/rest/v1/rpc/hr_daily_summary',
      {method:'POST',body:JSON.stringify({p_staff_id:body.staffId,p_from:from,p_to:today})});
    if (!r.ok) return res.status(500).json({ok:false,error:'Could not build the summary'});
    const days2 = (Array.isArray(r.data) ? r.data : []).map(d => {
      // 10.19 decimal hours is 10h 11m, not 10h 19m — the single easiest
      // number on this screen to misread. Send both: hm for people, decimal
      // for payroll.
      const hm = v => {
        const n = parseFloat(v || 0);
        if (!n) return null;
        const h = Math.floor(n), m = Math.round((n - h) * 60);
        return (h ? h + 'h ' : '') + (m ? m + 'm' : (h ? '' : '0m'));
      };
      return { ...d,
        worked_hm:    hm(d.worked_hours),
        ot_hm:        hm(d.ot_hours),
        undertime_hm: hm(d.undertime_hours),
        break_hm:     hm((parseFloat(d.break_mins) || 0) / 60) };
    });
    return res.status(200).json({ok:true, from, to:today, days: days2});
  }

  // ── hrGetDailyHours ─────────────────────────────────────────────────────
  // Worked-hours summary for the broken-time / phone-surrender model.
  // Sums all logged-in intervals; regular ≤ standard (8h), overtime beyond.
  if (action === 'hrGetDailyHours') {
    const authDH = await checkAuth(['OWNER']);
    if (!authDH.ok) return res.status(403).json({ok:false,error:'Unauthorized'});
    const { staffCode, date } = body;
    if (!staffCode) return res.status(400).json({ok:false,error:'staffCode required'});
    // Resolve staff id
    const sr = await supaFetch(
      SUPABASE_URL+'/rest/v1/hr_staff_master?staff_code=eq.'+encodeURIComponent(String(staffCode).toUpperCase())+
      '&tenant_id=eq.'+TENANT_HR+'&select=id,full_name&limit=1'
    );
    const staff = sr.data?.[0];
    if (!staff) return res.status(200).json({ok:false,error:'Staff not found'});
    // Date default = today (Asia/Manila)
    const phNow = new Date(Date.now() + 8*60*60*1000);
    const theDate = date || phNow.toISOString().slice(0,10);
    const hr = await supaFetch(
      SUPABASE_URL+'/rest/v1/rpc/hr_daily_hours',
      {method:'POST',body:JSON.stringify({p_tenant:TENANT_HR,p_staff_id:staff.id,p_date:theDate})}
    );
    const row = Array.isArray(hr.data) ? hr.data[0] : hr.data;
    if (!row) return res.status(200).json({ok:false,error:'No data'});
    return res.status(200).json({
      ok:true,
      staffCode: String(staffCode).toUpperCase(),
      fullName: staff.full_name,
      date: theDate,
      workedHours:   Number(row.worked_hours),
      regularHours:  Number(row.regular_hours),
      overtimeHours: Number(row.overtime_hours),
      standardHours: Number(row.standard_hours),
      sessionCount:  Number(row.session_count),
      isOpen:        !!row.is_open,
      firstIn:       row.first_in,
      lastEvent:     row.last_event,
    });
  }

  // ── hrKioskBoard ───────────────────────────────────────────────────────
  // Attendance summary for the HR kiosk home screen. Kiosk-token only: it
  // returns staff names and today's clock events, nothing financial.
  if (action === 'hrKioskBoard') {
    const k = body.kioskToken ? await verifyToken(String(body.kioskToken)) : null;
    if (!k || k.role !== 'TIMEKEEPER') {
      return res.status(403).json({ok:false,error:'Kiosk not authorised'});
    }
    const today = new Date(Date.now() + 8*3600*1000).toISOString().slice(0,10); // PH date
    // State and hours per staff come from hr_clock_state_all(): the same
    // shift rule as the clock-in gate, so a closer at 12:30 AM still shows IN
    // with the full shift's hours instead of resetting to OUT / 0h at midnight.
    const [staffR, stateR] = await Promise.all([
      supaFetch(SUPABASE_URL+'/rest/v1/hr_staff_master?tenant_id=eq.'+TENANT_HR+
        '&employment_status=eq.ACTIVE&select=id,staff_code,full_name,role,qr_token&order=full_name.asc'),
      supaFetch(SUPABASE_URL+'/rest/v1/rpc/hr_clock_state_all',
        {method:'POST',body:JSON.stringify({p_tenant:TENANT_HR})}),
    ]);
    const staff  = Array.isArray(staffR.data) ? staffR.data : [];
    const states = Array.isArray(stateR.data) ? stateR.data : [];
    const stBy = {};
    for (const r of states) stBy[r.staff_id] = r;

    const STATE = { IN:'IN', ON_BREAK:'BREAK', ON_BROKEN:'BREAK', OUT:'OUT' };
    let events = 0;
    const board = staff.map(s => {
      const st = stBy[s.id] || null;
      events += st ? Number(st.event_count || 0) : 0;
      return {
        staffCode: s.staff_code, name: s.full_name, role: s.role,
        hasQr: !!s.qr_token,
        state: st ? (STATE[st.state] || 'OUT') : 'OUT',
        lastEvent: st ? (st.last_event || null) : null,
        lastEventTime: st ? (st.last_event_time || null) : null,
        hoursToday: st ? Math.round((Number(st.worked_seconds || 0)/3600) * 100) / 100 : 0,
        shiftDate: st ? st.shift_date : today,
      };
    });
    return res.status(200).json({
      ok: true, date: today, board,
      counts: {
        total: board.length,
        in: board.filter(b => b.state === 'IN').length,
        onBreak: board.filter(b => b.state === 'BREAK').length,
        out: board.filter(b => b.state === 'OUT').length,
      },
      events,
    });
  }

  // ── hrClockEvent ───────────────────────────────────────────────────────
  if (action === 'hrClockEvent') {
    const {staffCode, eventType, pin} = body;
    if (!staffCode||!eventType) return res.status(400).json({ok:false,error:'staffCode + eventType required'});
    // Authorisation: EITHER the staff member's own PIN, OR a signed-in kiosk.
    // The kiosk token is the TIMEKEEPER (HR) session, so a PIN-less scan only
    // works on a device that an owner deliberately signed in as HR. Without
    // one of the two, this is refused — never open like it used to be.
    let kioskOk = false;
    if (body.kioskToken) {
      const k = await verifyToken(String(body.kioskToken));
      kioskOk = !!(k && k.role === 'TIMEKEEPER');
    }
    if (!kioskOk && (!pin || !String(pin).trim())) {
      return res.status(200).json({ok:false,error:'PIN required'});
    }
    if (!kioskOk) {
      const vr = await supaFetch(
        SUPABASE_URL+'/rest/v1/rpc/hr_verify_pin',
        {method:'POST',body:JSON.stringify({p_tenant:TENANT_HR,p_staff_code:staffCode.toUpperCase(),p_pin:pin})}
      );
      if (!(Array.isArray(vr.data) && vr.data.length > 0)) {
        return res.status(200).json({ok:false,error:'Invalid PIN'});
      }
    }
    // Get staff ID
    const sr = await supaFetch(
      SUPABASE_URL+'/rest/v1/hr_staff_master?staff_code=eq.'+staffCode.toUpperCase()+
      '&tenant_id=eq.'+TENANT_HR+'&select=id,employment_status&limit=1'
    );
    const staffRow = sr.data?.[0];
    const staffId = staffRow?.id;
    if (!staffId) return res.status(200).json({ok:false,error:'Staff not found'});
    // hrLookupStaff blocks inactive accounts, but the API does not require that call
    // first — a suspended staff member with a live PIN could clock in directly.
    if (staffRow.employment_status !== 'ACTIVE') {
      return res.status(200).json({ok:false,error:'Account inactive'});
    }
    // Record HOW this event happened. Previously device and source were
    // hardcoded, so every row read 'MANUAL / WEB_PORTAL' even for a QR scan.
    const rawSrc = String(body.source || '').toUpperCase();
    const SOURCES = ['QR','KIOSK','PIN','MANUAL'];   // matches the DB check constraint
    let source = SOURCES.includes(rawSrc) ? rawSrc : (kioskOk ? 'KIOSK' : 'PIN');
    if (source === 'QR' && !kioskOk) source = 'PIN';   // only a kiosk can claim a scan
    if (source === 'MANUAL') source = kioskOk ? 'KIOSK' : 'PIN'; // MANUAL is admin-only
    const device = kioskOk ? 'KIOSK' : 'WEB_PORTAL';

    const cr = await supaFetch(
      SUPABASE_URL+'/rest/v1/rpc/hr_clock_event',
      {method:'POST',body:JSON.stringify({
        p_tenant:TENANT_HR, p_staff_id:staffId, p_event_type:eventType,
        p_device:device, p_location_ip:req.headers['x-forwarded-for']||'',
        p_source:source, p_build: body.build ? String(body.build).substring(0,12) : null
      })}
    );
    if (!cr.ok) return res.status(200).json({ok:false,error:'Clock event failed: '+cr.status});
    // hr_clock_event() returns TABLE(ok boolean, message text, event_id uuid) — a HTTP 200
    // here only means the RPC call itself succeeded, NOT that the clock transition was
    // valid (e.g. clocking in twice, or clocking out while still on break are rejected
    // by the function but still come back as HTTP 200 with ok:false inside the payload).
    // Must unwrap and surface that inner result, or the client shows a false success screen.
    const inner = Array.isArray(cr.data) ? cr.data[0] : null;
    if (!inner || inner.ok !== true) {
      return res.status(200).json({ok:false, error: inner?.message || 'Clock event rejected'});
    }
    return res.status(200).json({ok:true, event:inner});
  }

  // ── hrEmployeeLogin ────────────────────────────────────────────────────
  // Uses the PORTAL PIN (hr_verify_portal_pin / password_hash column) —
  // intentionally separate from the attendance PIN (hr_verify_pin / pin_hash)
  // used at the clock-in kiosk. A shoulder-surfed attendance PIN at the
  // counter can no longer be used to view payslips or personal info.
  if (action === 'hrEmployeeLogin') {
    const {staffCode, pin} = body;
    if (!staffCode||!pin) return res.status(400).json({ok:false,error:'staffCode + portal PIN required'});
    const vr = await supaFetch(
      SUPABASE_URL+'/rest/v1/rpc/hr_verify_portal_pin',
      {method:'POST',body:JSON.stringify({p_tenant:TENANT_HR,p_staff_code:staffCode.toUpperCase(),p_pin:pin})}
    );
    if (!(Array.isArray(vr.data) && vr.data.length > 0)) {
      return res.status(200).json({ok:false,error:'Incorrect staff code or portal PIN'});
    }
    const sr = await supaFetch(
      SUPABASE_URL+'/rest/v1/hr_staff_master?staff_code=eq.'+staffCode.toUpperCase()+
      '&tenant_id=eq.'+TENANT_HR+
      '&select=id,staff_code,full_name,role,employment_type,employment_status,daily_rate,hourly_rate,pay_basis,mobile,email,date_hired,payout_method&limit=1'
    );
    const staff = sr.data?.[0];
    if (!staff) return res.status(200).json({ok:false,error:'Staff not found'});
    const token = 'EP_'+Date.now()+'_'+Math.random().toString(36).slice(2,10).toUpperCase();
    await supaFetch(
      SUPABASE_URL+'/rest/v1/hr_portal_sessions',
      {method:'POST',body:JSON.stringify({token,tenant_id:TENANT_HR,staff_id:staff.id,staff_code:staff.staff_code})}
    );
    return res.status(200).json({ok:true, staff, token});
  }

  return false;
}
