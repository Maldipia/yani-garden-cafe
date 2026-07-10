// api/handlers/hr.js — HR clock-in, employee portal, public HR actions
import { supaFetch } from '../lib/db.js';
import { SUPABASE_URL } from '../lib/config.js';

const TENANT_HR = '11111111-1111-4111-8111-111111111111';

export async function routeHR(action, body, auth, req, res) {

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

    // "Today" in Asia/Manila (UTC+8), matching the hr_clock_event() SQL function
    const phNow = new Date(Date.now() + 8*60*60*1000);
    const todayPH = phNow.toISOString().slice(0,10);

    const lr = await supaFetch(
      SUPABASE_URL+'/rest/v1/hr_time_logs?staff_id=eq.'+staffId+'&tenant_id=eq.'+TENANT_HR+
      '&log_date=eq.'+todayPH+'&select=event_type,event_time&order=event_time.desc,created_at.desc&limit=1'
    );
    const last = lr.data?.[0] || null;
    const lastType = last?.event_type || null;

    let state = 'OUT';
    if (lastType === 'CLOCK_IN' || lastType === 'BREAK_END' || lastType === 'BROKEN_TIME_END') state = 'IN';
    else if (lastType === 'BREAK_START') state = 'ON_BREAK';
    else if (lastType === 'BROKEN_TIME_START') state = 'ON_BROKEN';
    else if (lastType === 'CLOCK_OUT') state = 'OUT';
    // else (no logs today) stays 'OUT'

    return res.status(200).json({ok:true, state, lastEvent:lastType, lastEventTime:last?.event_time||null});
  }

  // ── hrGetDailyHours ─────────────────────────────────────────────────────
  // Worked-hours summary for the broken-time / phone-surrender model.
  // Sums all logged-in intervals; regular ≤ standard (8h), overtime beyond.
  if (action === 'hrGetDailyHours') {
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

  // ── hrClockEvent ───────────────────────────────────────────────────────
  if (action === 'hrClockEvent') {
    const {staffCode, eventType, pin} = body;
    if (!staffCode||!eventType) return res.status(400).json({ok:false,error:'staffCode + eventType required'});
    // Verify PIN
    if (pin) {
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
      '&tenant_id=eq.'+TENANT_HR+'&select=id&limit=1'
    );
    const staffId = sr.data?.[0]?.id;
    if (!staffId) return res.status(200).json({ok:false,error:'Staff not found'});
    // Fire clock event via SECURITY DEFINER function
    const cr = await supaFetch(
      SUPABASE_URL+'/rest/v1/rpc/hr_clock_event',
      {method:'POST',body:JSON.stringify({
        p_tenant:TENANT_HR, p_staff_id:staffId, p_event_type:eventType,
        p_device:'WEB_PORTAL', p_location_ip:req.headers['x-forwarded-for']||''
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
