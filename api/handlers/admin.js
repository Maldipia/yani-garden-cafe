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
        '&select=id,staff_code,full_name,nickname,role,employment_type,employment_status,pay_basis,daily_rate,hourly_rate,standard_hours_per_day,overtime_allowed,mobile,email,date_of_birth,date_hired,department,payout_method,payout_details,gender,civil_status,notes&order=full_name.asc'
      );
      if (!rHR.ok) return res.status(500).json({ ok:false, error:'Supabase HR error: ' + rHR.status });
      return res.status(200).json({ ok:true, staff: Array.isArray(rHR.data) ? rHR.data : [] });
    } catch(hrErr) {
      return res.status(500).json({ ok:false, error:'HR fetch error: ' + hrErr.message });
    }
  }

  if (action === 'getHRProfile') {
    const { staffId } = body;
    if (!staffId) return res.status(400).json({ok:false,error:'staffId required'});
    const TENANT_HR = '11111111-1111-4111-8111-111111111111';
    const r = await supaFetch(
      SUPABASE_URL+'/rest/v1/hr_employee_profile?staff_id=eq.'+staffId+'&tenant_id=eq.'+TENANT_HR+'&limit=1'
    );
    const profile = Array.isArray(r.data) ? r.data[0] : null;
    return res.status(200).json({ok:true, profile: profile||{}});
  }

  if (action === 'updateHRStaff') {
    const authHR = await checkAuth(['OWNER','ADMIN','MANAGER']);
    if (!authHR.ok) return res.status(403).json({ok:false, error:'Unauthorized'});
    const hrStaffId = body.staffId;
    if (!hrStaffId) return res.status(400).json({ok:false, error:'staffId required'});
    const TENANT_HR = '11111111-1111-4111-8111-111111111111';
    // ── hr_staff_master ──────────────────────────────────────────────────────
    const masterAllowed = [
      'employment_status','full_name','nickname','role','employment_type',
      'daily_rate','hourly_rate','pay_basis','mobile','email','notes',
      'overtime_allowed','department','date_hired','date_of_birth',
      'gender','civil_status','payout_method','payout_details'
    ];
    const masterPatch = { updated_at: new Date().toISOString() };
    masterAllowed.forEach(function(k){ if (body[k] !== undefined) masterPatch[k] = body[k]; });
    const rMaster = await supaFetch(
      SUPABASE_URL + '/rest/v1/hr_staff_master?id=eq.' + hrStaffId,
      { method:'PATCH', body:JSON.stringify(masterPatch) }
    );
    if (!rMaster.ok) return res.status(500).json({ ok:false, error:'Staff update failed' });
    // ── hr_employee_profile (government numbers) ─────────────────────────────
    if (body._sss !== undefined || body._ph !== undefined || body._pig !== undefined || body._tin !== undefined) {
      const profilePatch = { updated_at: new Date().toISOString() };
      if (body._sss  !== undefined) profilePatch.sss_no        = body._sss  || null;
      if (body._ph   !== undefined) profilePatch.philhealth_no  = body._ph   || null;
      if (body._pig  !== undefined) profilePatch.pagibig_no     = body._pig  || null;
      if (body._tin  !== undefined) profilePatch.tin_no         = body._tin  || null;
      const existing = await supaFetch(
        SUPABASE_URL+'/rest/v1/hr_employee_profile?staff_id=eq.'+hrStaffId+'&tenant_id=eq.'+TENANT_HR+'&select=id&limit=1'
      );
      if (Array.isArray(existing.data) && existing.data.length > 0) {
        await supaFetch(
          SUPABASE_URL+'/rest/v1/hr_employee_profile?staff_id=eq.'+hrStaffId,
          { method:'PATCH', body:JSON.stringify(profilePatch) }
        );
      } else {
        await supaFetch(
          SUPABASE_URL+'/rest/v1/hr_employee_profile',
          { method:'POST', body:JSON.stringify({ tenant_id:TENANT_HR, staff_id:hrStaffId, ...profilePatch }) }
        );
      }
    }
    return res.status(200).json({ ok:true });
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
