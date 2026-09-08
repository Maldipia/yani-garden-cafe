// ── Admin, auth, analytics, inventory, staff, tables, settings, misc ──────
import { supaFetch, supa, auditLog, getSetting, logSync } from '../lib/db.js';
import { GAS_SYNC_URL } from '../lib/config.js';
import { invalidateMenuCache, invalidateSettingsCache, _settingsCache, SETTINGS_CACHE_TTL } from '../lib/cache.js';
import { getCategoryName, getCategoryId, CATEGORY_ID_TO_NAME } from '../lib/categories.js';
import { isNonEmptyString, isValidOrderId, isValidItemCode } from '../lib/validation.js';
import { SUPABASE_URL, BUSINESS_NAME, SERVICE_CHARGE_RATE, SUPABASE_KEY, FROM_EMAIL, RESEND_KEY } from '../lib/config.js';
import { signToken, verifyToken, getJwtSecret } from '../lib/auth.js';
import { hrAudit } from '../lib/hr-audit.js';
import { uploadToGoogleDrive } from '../lib/drive.js';
import { sendReceiptEmail, buildReceiptHTML } from '../lib/receipt.js';
import bcrypt from 'bcryptjs';

export async function routeAdmin(action, body, auth, req, res) {
  const { checkAuth, checkAdminAuth, jwtUser } = auth;

  // ── getHRStaff ──────────────────────────────────────────────────────────
  // ── PAYROLL ────────────────────────────────────────────────────────────
  if (action === 'hrListCutoffs') {
    const authC = await checkAuth(['OWNER','ADMIN','MANAGER']);
    if (!authC.ok) return res.status(403).json({ok:false,error:'Unauthorized'});
    const TENANT_HR = '11111111-1111-4111-8111-111111111111';
    const r = await supaFetch(SUPABASE_URL+'/rest/v1/hr_payroll_cut_offs?tenant_id=eq.'+TENANT_HR+
      '&select=id,cutoff_name,start_date,end_date,pay_date,payroll_status&order=start_date.desc');
    return res.status(200).json({ok:r.ok, cutoffs:Array.isArray(r.data)?r.data:[]});
  }

  if (action === 'hrComputePayroll') {
    const authP = await checkAuth(['OWNER','ADMIN']);
    if (!authP.ok) return res.status(403).json({ok:false,error:'Unauthorized'});
    if (!body.cutoffId) return res.status(400).json({ok:false,error:'cutoffId required'});
    const r = await supaFetch(SUPABASE_URL+'/rest/v1/rpc/hr_compute_payroll',
      {method:'POST',body:JSON.stringify({p_cutoff_id:body.cutoffId, p_actor: body.userId||null})});
    if (!r.ok) return res.status(500).json({ok:false,error:'Payroll computation failed'});
    await hrAudit({ action:'PAYROLL_COMPUTED', module:'PAYROLL', recordId:body.cutoffId,
      next:{rows:Array.isArray(r.data)?r.data.length:0},
      actorCode: authP.userId || body.userId, role: authP.role, req });
    return res.status(200).json({ok:true, rows:r.data||[]});
  }

  if (action === 'hrGetPayroll') {
    const authG = await checkAuth(['OWNER','ADMIN','MANAGER']);
    if (!authG.ok) return res.status(403).json({ok:false,error:'Unauthorized'});
    if (!body.cutoffId) return res.status(400).json({ok:false,error:'cutoffId required'});
    const TENANT_HR = '11111111-1111-4111-8111-111111111111';
    const [rows, deds] = await Promise.all([
      supaFetch(SUPABASE_URL+'/rest/v1/hr_payroll_details?cutoff_id=eq.'+body.cutoffId+
        '&select=*,hr_staff_master(staff_code,full_name,role)&order=created_at.asc'),
      supaFetch(SUPABASE_URL+'/rest/v1/hr_deductions?cutoff_id=eq.'+body.cutoffId+
        '&select=*&order=deduction_date.asc'),
    ]);
    return res.status(200).json({ok:true,
      rows: Array.isArray(rows.data)?rows.data:[],
      deductions: Array.isArray(deds.data)?deds.data:[]});
  }

  if (action === 'hrAddDeduction') {
    const authD = await checkAuth(['OWNER','ADMIN']);
    if (!authD.ok) return res.status(403).json({ok:false,error:'Unauthorized'});
    const TENANT_HR = '11111111-1111-4111-8111-111111111111';
    const det = String(body.details||'').trim();
    if (!body.staffId || !body.cutoffId) return res.status(400).json({ok:false,error:'staffId + cutoffId required'});
    if (det.length < 3) return res.status(400).json({ok:false,error:'Details are required'});
    const amt = parseFloat(body.amount)||0;
    const ded = parseFloat(body.amountDeducted)|| amt;
    if (!(amt > 0)) return res.status(400).json({ok:false,error:'Amount must be greater than zero'});
    const r = await supaFetch(SUPABASE_URL+'/rest/v1/hr_deductions',
      {method:'POST',headers:{Prefer:'return=representation'},
       body:JSON.stringify({tenant_id:TENANT_HR, staff_id:body.staffId, cutoff_id:body.cutoffId,
         deduction_type: String(body.type||'OTHER').toUpperCase().substring(0,40),
         deduction_date: body.date || new Date().toISOString().slice(0,10),
         details: det.substring(0,300), amount: amt, amount_deducted: ded,
         balance_after: Math.round((amt - ded)*100)/100,
         status:'APPROVED', reason: det.substring(0,300)})});
    if (!r.ok) return res.status(500).json({ok:false,error:'Could not save deduction'});
    await hrAudit({ action:'DEDUCTION_ADDED', module:'PAYROLL', recordId:body.staffId,
      next:{type:body.type, amount:amt, deducted:ded}, reason:det,
      actorCode: authD.userId || body.userId, role: authD.role, req });
    return res.status(200).json({ok:true});
  }

  if (action === 'getHRStaff') {
    try {
      const TENANT_HR = '11111111-1111-4111-8111-111111111111';
      const rHR = await supaFetch(
        SUPABASE_URL + '/rest/v1/hr_staff_master?tenant_id=eq.' + TENANT_HR +
        '&select=id,staff_code,full_name,nickname,role,employment_type,employment_status,pay_basis,daily_rate,hourly_rate,standard_hours_per_day,overtime_allowed,mobile,email,date_of_birth,date_hired,department,payout_method,payout_details,gender,civil_status,notes,qr_token&order=full_name.asc'
      );
      if (!rHR.ok) return res.status(500).json({ ok:false, error:'Supabase HR error: ' + rHR.status });
      const staffRows = Array.isArray(rHR.data) ? rHR.data : [];

      // Enrich each row with what the HR list actually needs to show: can this
      // person clock in, and where are they right now. Never their pay.
      const today = new Date(Date.now() + 8*3600*1000).toISOString().slice(0,10);
      const [rLogin, rLogs] = await Promise.all([
        supaFetch(SUPABASE_URL + '/rest/v1/hr_staff_login?select=staff_id,pin_hash'),
        supaFetch(SUPABASE_URL + '/rest/v1/hr_time_logs?tenant_id=eq.' + TENANT_HR +
                  '&log_date=eq.' + today + '&select=staff_id,event_type,event_time&order=event_time.asc'),
      ]);
      const pinBy = {};
      (Array.isArray(rLogin.data) ? rLogin.data : []).forEach(l => { if (l.pin_hash) pinBy[l.staff_id] = true; });
      const lastBy = {};
      (Array.isArray(rLogs.data) ? rLogs.data : []).forEach(l => { lastBy[l.staff_id] = l.event_type; });
      const STATE = { CLOCK_IN:'IN', BREAK_END:'IN', BROKEN_TIME_END:'IN',
                      BREAK_START:'BREAK', BROKEN_TIME_START:'BREAK', CLOCK_OUT:'OUT' };

      staffRows.forEach(s => {
        s.has_pin    = !!pinBy[s.id];
        s.has_qr     = !!(s.qr_token && String(s.qr_token).trim());
        s.clock_state = STATE[lastBy[s.id]] || 'OUT';
      });
      return res.status(200).json({ ok:true, staff: staffRows });
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

    // Capture the BEFORE image so the audit trail holds previous -> new,
    // limited to the fields actually being changed.
    let beforeVals = null;
    try {
      const changing = Object.keys(masterPatch).filter(k => k !== 'updated_at');
      if (changing.length) {
        const rb = await supaFetch(SUPABASE_URL + '/rest/v1/hr_staff_master?id=eq.' + hrStaffId +
          '&select=' + encodeURIComponent(changing.join(',')));
        beforeVals = Array.isArray(rb.data) ? rb.data[0] : null;
      }
    } catch(_) {}

    const rMaster = await supaFetch(
      SUPABASE_URL + '/rest/v1/hr_staff_master?id=eq.' + hrStaffId,
      { method:'PATCH', body:JSON.stringify(masterPatch) }
    );
    if (!rMaster.ok) return res.status(500).json({ ok:false, error:'Staff update failed' });

    {
      const changed = { ...masterPatch }; delete changed.updated_at;
      if (Object.keys(changed).length) {
        const statusChanged = beforeVals && changed.employment_status &&
          beforeVals.employment_status !== changed.employment_status;
        await hrAudit({
          action: statusChanged ? 'EMPLOYEE_STATUS_CHANGED' : 'EMPLOYEE_UPDATED',
          module:'EMPLOYEE', recordId: hrStaffId,
          previous: beforeVals, next: changed,
          reason: body.reason || null,
          actorCode: authHR.userId || body.userId, role: authHR.role, req });
      }
    }
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
    const {staffId,event_type,log_date,event_time,notes} = body;
    // A manual entry alters paid hours, so it must say WHY and WHO.
    const reason = String(notes||'').trim();
    if (reason.length < 3) {
      return res.status(400).json({ok:false,error:'A reason is required for manual entries'});
    }
    const who = authT.userId || body.userId || 'UNKNOWN';
    const r = await supaFetch(SUPABASE_URL+'/rest/v1/hr_time_logs',
      {method:'POST',headers:{Prefer:'return=representation'},
       body:JSON.stringify({tenant_id:TENANT_HR2,staff_id:staffId,
         event_type,log_date,event_time,
         attendance_source:'MANUAL',      // never spoofable as a scan
         device:'ADMIN_PANEL',
         notes:'['+who+'] '+reason.substring(0,400),
         approval_status:'PENDING'})
      });
    if (r.ok) {
      await hrAudit({ action:'ATTENDANCE_MANUAL_ENTRY', module:'ATTENDANCE',
        recordId: staffId, next:{event_type, log_date, event_time},
        reason, actorCode: who, role: authT.role, req });
    }
    return res.status(200).json({ok:r.ok});
  }

  // ── hrLookupStaff — for clock-in page ────────────────────────────────────

  // ── hrVerifyPin — for clock-in PIN check ──────────────────────────────────

  // ── hrClockEvent — for clock-in page ──────────────────────────────────────

  // ── hrEmployeeLogin — for employee portal ─────────────────────────────────

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

  // ── hrSetPin — sets the ATTENDANCE PIN (clock-in/clock-out only) ───────────
  if (action === 'hrSetPin') {
    const authSP = await checkAuth(['OWNER','ADMIN','MANAGER']);
    if (!authSP.ok) return res.status(403).json({ok:false,error:authSP.error});
    const {staffId, pin} = body;
    if (!staffId||!pin) return res.status(400).json({ok:false,error:'staffId + pin required'});
    if (!/^\d{4,6}$/.test(String(pin))) return res.status(400).json({ok:false,error:'PIN must be 4-6 digits'});
    const r = await supaFetch(
      SUPABASE_URL+'/rest/v1/rpc/hr_set_pin',
      {method:'POST',body:JSON.stringify({p_staff_id:staffId,p_pin:String(pin)})}
    );
    if (!r.ok) return res.status(500).json({ok:false,error:'Failed to set attendance PIN'});
    await hrAudit({ action:'ATTENDANCE_PIN_SET', module:'SECURITY', recordId:staffId,
      reason: body.reason || null, actorCode: authSP.userId || body.userId, role: authSP.role, req });
    return res.status(200).json({ok:true});
  }

  // ── hrSetPortalPin — sets the PORTAL PIN (separate from attendance PIN) ────
  // Used for the employee self-service portal (payslips, leave, profile).
  // Deliberately a different secret from the attendance PIN so a PIN
  // shoulder-surfed at the clock-in kiosk can't unlock the portal.
  if (action === 'hrSetPortalPin') {
    const authSPP = await checkAuth(['OWNER','ADMIN','MANAGER']);
    if (!authSPP.ok) return res.status(403).json({ok:false,error:authSPP.error});
    const {staffId, pin} = body;
    if (!staffId||!pin) return res.status(400).json({ok:false,error:'staffId + pin required'});
    if (!/^\d{6,8}$/.test(String(pin))) return res.status(400).json({ok:false,error:'Portal PIN must be 6-8 digits'});
    const r = await supaFetch(
      SUPABASE_URL+'/rest/v1/rpc/hr_set_portal_pin',
      {method:'POST',body:JSON.stringify({p_staff_id:staffId,p_pin:String(pin)})}
    );
    if (!r.ok) return res.status(500).json({ok:false,error:'Failed to set portal PIN'});
    await hrAudit({ action:'PORTAL_PIN_SET', module:'SECURITY', recordId:staffId,
      reason: body.reason || null, actorCode: authSPP.userId || body.userId, role: authSPP.role, req });
    return res.status(200).json({ok:true});
  }

  // ── hrRotateQrToken — regenerates a staff's QR token, invalidating old QR ──
  // Any photo/copy of the previous QR code becomes useless immediately —
  // it no longer resolves to a valid staff record.
  if (action === 'hrRotateQrToken') {
    const authRQ = await checkAuth(['OWNER','ADMIN','MANAGER']);
    if (!authRQ.ok) return res.status(403).json({ok:false,error:authRQ.error});
    const {staffId} = body;
    if (!staffId) return res.status(400).json({ok:false,error:'staffId required'});
    const r = await supaFetch(
      SUPABASE_URL+'/rest/v1/rpc/hr_rotate_qr_token',
      {method:'POST',body:JSON.stringify({p_staff_id:staffId})}
    );
    if (!r.ok) return res.status(500).json({ok:false,error:'Failed to rotate QR token'});
    const newToken = Array.isArray(r.data) ? r.data[0] : r.data;
    // The token itself is a credential — record that it rotated, never its value.
    await hrAudit({ action:'QR_TOKEN_ROTATED', module:'SECURITY', recordId:staffId,
      reason: body.reason || 'QR regenerated — previous code invalidated',
      actorCode: authRQ.userId || body.userId, role: authRQ.role, req });
    return res.status(200).json({ok:true, qrToken:newToken});
  }

  return false;
}
