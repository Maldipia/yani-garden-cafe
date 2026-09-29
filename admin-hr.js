// admin-hr.js — YANI HR Module v3 — Full wired tabs
'use strict';

// ── Color maps ─────────────────────────────────────────────────────────────
const HR_ROLE_STYLE = {
  OWNER:           {bg:'#1a3a2a',fg:'#a8d8a8',label:'Owner'},
  MANAGER:         {bg:'#1e3a5f',fg:'#93c5fd',label:'Manager'},
  PAYROLL_ADMIN:   {bg:'#3b1f5e',fg:'#c4b5fd',label:'Payroll'},
  CASHIER:         {bg:'#78350f',fg:'#fde68a',label:'Cashier'},
  BARISTA:         {bg:'#7c2d12',fg:'#fdba74',label:'Barista'},
  KITCHEN:         {bg:'#7f1d1d',fg:'#fca5a5',label:'Kitchen'},
  SERVICE_CREW:    {bg:'#064e3b',fg:'#6ee7b7',label:'Service'},
  WORKING_STUDENT: {bg:'#1e1b4b',fg:'#a5b4fc',label:'W.Student'},
  STAFF:           {bg:'#374151',fg:'#d1d5db',label:'Staff'},
  TRAINEE:         {bg:'#7c3aed',fg:'#ede9fe',label:'Trainee'},
};
const HR_STATUS_STYLE = {
  ACTIVE:     {bg:'#dcfce7',fg:'#166534',label:'Active',dot:'#22c55e'},
  ON_LEAVE:   {bg:'#fef9c3',fg:'#854d0e',label:'On Leave',dot:'#eab308'},
  SUSPENDED:  {bg:'#fee2e2',fg:'#991b1b',label:'Suspended',dot:'#ef4444'},
  RESIGNED:   {bg:'#f3f4f6',fg:'#4b5563',label:'Resigned',dot:'#9ca3af'},
  TERMINATED: {bg:'#fef2f2',fg:'#7f1d1d',label:'Terminated',dot:'#dc2626'},
  AWOL:       {bg:'#fff7ed',fg:'#9a3412',label:'AWOL',dot:'#f97316'},
};
const HR_EMPLOY_STYLE = {
  REGULAR:         {bg:'#dbeafe',fg:'#1e40af'},
  PROBATIONARY:    {bg:'#fef3c7',fg:'#92400e'},
  PART_TIME:       {bg:'#f3e8ff',fg:'#6b21a8'},
  WORKING_STUDENT: {bg:'#e0f2fe',fg:'#075985'},
  RELIEVER:        {bg:'#d1fae5',fg:'#065f46'},
  ON_CALL:         {bg:'#f1f5f9',fg:'#475569'},
};
const HR_LOAN_STATUS = {
  ACTIVE:   {bg:'#dcfce7',fg:'#166534'},
  PAUSED:   {bg:'#fef9c3',fg:'#854d0e'},
  SETTLED:  {bg:'#f3f4f6',fg:'#4b5563'},
  CANCELLED:{bg:'#fee2e2',fg:'#991b1b'},
};
const HR_INCIDENT_STYLE = {
  WARNING:        {bg:'#fef9c3',fg:'#854d0e',icon:'⚠️'},
  TARDINESS:      {bg:'#fff7ed',fg:'#9a3412',icon:'⏰'},
  ABSENCE:        {bg:'#fee2e2',fg:'#991b1b',icon:'❌'},
  MISCONDUCT:     {bg:'#fce7f3',fg:'#9d174d',icon:'🚨'},
  DAMAGE:         {bg:'#fef3c7',fg:'#92400e',icon:'💥'},
  CASH_SHORTAGE:  {bg:'#fef2f2',fg:'#7f1d1d',icon:'💸'},
  COMPLAINT:      {bg:'#f3e8ff',fg:'#6b21a8',icon:'📢'},
  OTHER:          {bg:'#f3f4f6',fg:'#374151',icon:'📋'},
};
const HR_PERF_STYLE = {
  COMMENDATION:  {bg:'#dcfce7',fg:'#166534',icon:'🌟'},
  WARNING:       {bg:'#fef9c3',fg:'#854d0e',icon:'⚠️'},
  EVALUATION:    {bg:'#dbeafe',fg:'#1e40af',icon:'📊'},
  TRAINING:      {bg:'#f3e8ff',fg:'#6b21a8',icon:'📚'},
  NTE:           {bg:'#fee2e2',fg:'#991b1b',icon:'📜'},
  MEMORANDUM:    {bg:'#fff7ed',fg:'#9a3412',icon:'📄'},
};
const HR_DOC_TYPES = [
  'Contract','NBI Clearance','Police Clearance','Health Certificate',
  'Medical Certificate','Government ID (SSS)','Government ID (PhilHealth)',
  'Government ID (PagIBIG)','Government ID (TIN)','Resume','Birth Certificate',
  'School Diploma','Training Certificate','Performance Evaluation','Incident Report',
  'NTE (Notice to Explain)','Other'
];

function hrRoleBadge(role) {
  const s=HR_ROLE_STYLE[role]||HR_ROLE_STYLE.STAFF;
  return `<span class="hr-badge" style="background:${s.bg};color:${s.fg}">${s.label}</span>`;
}
function hrStatusBadge(status) {
  const s=HR_STATUS_STYLE[status]||HR_STATUS_STYLE.ACTIVE;
  return `<span class="hr-badge" style="background:${s.bg};color:${s.fg}"><span class="hr-dot" style="background:${s.dot}"></span>${s.label}</span>`;
}
function hrEmployBadge(type) {
  const s=HR_EMPLOY_STYLE[type]||HR_EMPLOY_STYLE.REGULAR;
  return `<span class="hr-badge-sm" style="background:${s.bg};color:${s.fg}">${(type||'').replace(/_/g,' ')}</span>`;
}
function hrPeso(n) { return '₱'+(parseFloat(n||0)).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function hrDate(d) { if(!d) return '—'; try { return new Date(d).toLocaleDateString('en-PH',{year:'numeric',month:'short',day:'numeric'}); } catch(e){ return d; } }

// ── State ──────────────────────────────────────────────────────────────────
let _hrStaff=[], _hrSelected=null, _hrActiveTab='profile', _hrSearchTerm='', _hrFilterStatus='ALL';
// 7 of 12 staff are suspended placeholders, so the list defaults to active only.
let _hrHideInactive = (function(){ try{ return localStorage.getItem('hr_show_inactive')!=='1'; }catch(_){ return true; } })();
function toggleInactiveStaff(){
  _hrHideInactive = !_hrHideInactive;
  try{ localStorage.setItem('hr_show_inactive', _hrHideInactive?'0':'1'); }catch(_){}
  renderHRStaffList();
}
let _hrTabCache={};  // {staffId_tab: data}

// ── Load module ────────────────────────────────────────────────────────────
async function loadHRModule() {
  const el=document.getElementById('hrView');
  if(!el) return;
  el.innerHTML='<div class="hr-loading">⏳ Loading staff...</div>';
  try {
    const r=await api('getHRStaff',{userId:currentUser?.userId});
    if(!r.ok) throw new Error(r.error||'Failed');
    _hrStaff=r.staff||[];
    _hrTabCache={};
    renderHRModule();
  } catch(e) { el.innerHTML=`<div class="hr-error">⚠️ ${esc(e.message)}</div>`; }
}

// ── Main layout ────────────────────────────────────────────────────────────
function renderHRModule() {
  const el=document.getElementById('hrView');
  if(!el) return;
  el.innerHTML=`
    <div class="hr-wrap">
      <div class="hr-list-col" id="hrListCol">
        <div class="hr-list-hdr">
          <div class="hr-list-title">👥 Staff <span style="font-size:.7rem;color:#5a4a3a;font-weight:400">${_hrStaff.length} total</span></div>
          <button class="hr-add-btn" onclick="openAddStaffModal()">+ Add</button>
        </div>
        <div class="hr-search-wrap">
          <input class="hr-search" type="text" placeholder="🔍 Search name or role..." value="${esc(_hrSearchTerm)}"
            oninput="_hrSearchTerm=this.value;renderHRStaffList()">
        </div>
        <div class="hr-filter-row">
          ${['ALL','ACTIVE','ON_LEAVE','SUSPENDED'].map(s=>
            `<button class="hr-filter-btn${_hrFilterStatus===s?' active':''}" onclick="_hrFilterStatus='${s}';renderHRStaffList()">${s==='ALL'?'All':(HR_STATUS_STYLE[s]?.label||s)}</button>`
          ).join('')}
          <button class="hr-filter-btn" id="hrInactiveToggle" onclick="toggleInactiveStaff()"
            title="Show or hide staff who are not active"
            style="margin-left:auto">${_hrHideInactive?'👁 Show inactive':'🙈 Hide inactive'}${
              _hrHideInactive ? ` (${(_hrStaff||[]).filter(x=>x.employment_status!=='ACTIVE').length})` : ''}</button>
        </div>
        <div class="hr-staff-list" id="hrStaffList"></div>
      </div>
      <div class="hr-detail-col" id="hrDetailCol">
        <div id="hrDetailContent">
          <div class="hr-empty-state">
            <div style="font-size:3rem">👥</div>
            <div style="font-size:1rem;font-weight:600;margin-top:10px;color:#111">Select a staff member</div>
            <div style="font-size:.8rem;color:#5a4a3a;margin-top:6px">Click any name from the list to view their full profile</div>
          </div>
        </div>
      </div>
    </div>`;
  renderHRStaffList();
  if(_hrSelected) renderHRDetail(_hrSelected);
}

// ── Staff list ─────────────────────────────────────────────────────────────
function renderHRStaffList() {
  const el=document.getElementById('hrStaffList');
  if(!el) return;
  let list=_hrStaff;
  if(_hrSearchTerm) { const q=_hrSearchTerm.toLowerCase(); list=list.filter(s=>(s.full_name||'').toLowerCase().includes(q)||(s.role||'').toLowerCase().includes(q)); }
  if(_hrFilterStatus!=='ALL') list=list.filter(s=>s.employment_status===_hrFilterStatus);
  else if(_hrHideInactive)    list=list.filter(s=>s.employment_status==='ACTIVE');
  if(!list.length) { el.innerHTML='<div class="hr-list-empty">No staff found'+((_hrHideInactive&&_hrFilterStatus==='ALL')?' — inactive staff are hidden':'')+'</div>'; return; }
  el.innerHTML=list.map(s=>{
    const rs=HR_ROLE_STYLE[s.role]||HR_ROLE_STYLE.STAFF;
    const ss=HR_STATUS_STYLE[s.employment_status]||HR_STATUS_STYLE.ACTIVE;
    const sel=_hrSelected&&_hrSelected.id===s.id;
    return `<div class="hr-staff-card${sel?' selected':''}" onclick="selectHRStaff('${s.id}')">
      <div class="hr-avatar" style="background:${rs.bg};color:${rs.fg}">${(s.full_name||'?').charAt(0).toUpperCase()}</div>
      <div class="hr-card-info">
        <div class="hr-card-name">${esc(s.full_name||'—')}</div>
        <div class="hr-card-sub">${esc(s.role||'')}${hrRowBadges(s)}</div>
      </div>
      <div class="hr-card-right">
        <span class="hr-dot-lg" style="background:${ss.dot}" title="${ss.label}"></span>
        <label class="hr-toggle${s.employment_status==='ACTIVE'?' on':''}" onclick="event.stopPropagation()" title="${s.employment_status==='ACTIVE'?'Deactivate':'Activate'}">
          <input type="checkbox" style="display:none" ${s.employment_status==='ACTIVE'?'checked':''} onchange="toggleHRStatus('${s.id}','${s.employment_status}')">
          <span class="hr-toggle-knob"></span>
        </label>
      </div>
    </div>`;
  }).join('');
}

// ── Select staff ───────────────────────────────────────────────────────────
function selectHRStaff(id) {
  _hrSelected=_hrStaff.find(s=>s.id===id)||null;
  _hrActiveTab='profile';
  renderHRStaffList();
  renderHRDetail(_hrSelected);
  // On a phone the two-column layout does not fit: the list was capped at
  // 240px so only two staff showed, then an empty 'Select a staff member'
  // panel filled the rest of the screen. Show ONE pane at a time instead.
  _hrSyncMobilePane();
  const dc=document.getElementById('hrDetailCol');
  if(dc&&window.innerWidth<768) dc.scrollTop=0;
}

// Toggle which pane is visible on narrow screens. Desktop is unaffected —
// the class only has meaning inside the mobile media query.
function _hrSyncMobilePane(){
  const wrap=document.querySelector('.hr-wrap');
  if(wrap) wrap.classList.toggle('has-selection', !!_hrSelected);
}

// Back to the list from a staff profile on mobile.
function hrBackToList(){
  _hrSelected=null;
  renderHRStaffList();
  renderHRDetail(null);
  _hrSyncMobilePane();
  const lc=document.querySelector('.hr-list-col');
  if(lc) lc.scrollTop=0;
}

// ── Detail panel ───────────────────────────────────────────────────────────
function renderHRDetail(s) {
  const el=document.getElementById('hrDetailContent');
  if(!el||!s) return;
  const rs=HR_ROLE_STYLE[s.role]||HR_ROLE_STYLE.STAFF;
  const age=s.date_of_birth?Math.floor((Date.now()-new Date(s.date_of_birth))/31557600000):'';
  el.innerHTML=`
    <button class="hr-back-btn" onclick="hrBackToList()">← All staff</button>
    <div class="hr-detail-hdr" style="border-top:3px solid ${rs.bg}">
      <div class="hr-detail-avatar" style="background:${rs.bg};color:${rs.fg}">${(s.full_name||'?').charAt(0).toUpperCase()}</div>
      <div class="hr-detail-hdr-info">
        <div class="hr-detail-name">${esc(s.full_name||'—')}</div>
        <div class="hr-detail-badges">
          ${hrRoleBadge(s.role)}${hrStatusBadge(s.employment_status)}${hrEmployBadge(s.employment_type)}
        </div>
        <div class="hr-detail-code">${esc(s.staff_code||'')}${age?' · '+age+' yrs':''}</div>
      </div>
      <div><button class="hr-edit-btn" onclick="openEditStaffModal('${s.id}')">✏️ Edit</button></div>
    </div>
    <div class="hr-tabs" id="hrTabBar">
      ${[
        {k:'profile',  l:'👤 Profile'},
        {k:'pay',      l:'💰 Pay'},
        {k:'loans',    l:'🏦 Loans'},
        {k:'schedule', l:'📅 Schedule'},
        {k:'leave',    l:'🌿 Leave'},
        {k:'clock',    l:'⏱ Clock-in'},
        {k:'performance',l:'⭐ Performance'},
        {k:'documents',l:'📄 Documents'},
        {k:'payroll',  l:'🧮 Payroll'},
      ].map(t=>`<button class="hr-tab${_hrActiveTab===t.k?' active':''}" onclick="switchHRTab('${s.id}','${t.k}')">${t.l}</button>`).join('')}
    </div>
    <div class="hr-tab-content" id="hrTabContent"><div class="hr-loading">Loading...</div></div>`;
  loadHRTab(s,_hrActiveTab);
}

function switchHRTab(id,tab) {
  if(_hrSelected?.id!==id) return;
  _hrActiveTab=tab;
  document.querySelectorAll('.hr-tab').forEach(b=>b.classList.remove('active'));
  document.querySelectorAll('.hr-tab').forEach(b=>{ if(b.onclick?.toString().includes("'"+tab+"'")) b.classList.add('active'); });
  loadHRTab(_hrSelected,tab);
}

async function loadHRTab(s,tab) {
  const tc=document.getElementById('hrTabContent');
  if(!tc) return;
  tc.innerHTML='<div class="hr-loading">⏳ Loading...</div>';
  try {
    switch(tab) {
      case 'profile':
        tc.innerHTML=renderProfileTab(s);
        loadGovtNumbers(s);
        break;
      case 'pay':        await loadPayTab(s,tc); break;
      case 'loans':      await loadLoansTab(s,tc); break;
      case 'schedule':   tc.innerHTML=renderScheduleTab(s); break;
      case 'leave':      await loadLeaveTab(s,tc); break;
      case 'clock':      await loadClockTab(s,tc); break;
      case 'performance':await loadPerformanceTab(s,tc); break;
      case 'documents':  await loadDocumentsTab(s,tc); break;
      case 'payroll':    await loadPayrollTab(s,tc); break;
      default: tc.innerHTML='<div class="hr-empty-sm">Coming soon</div>';
    }
  } catch(e) { tc.innerHTML=`<div class="hr-error">⚠️ ${esc(e.message)}</div>`; }
}

// ══ TAB RENDERERS ══════════════════════════════════════════════════════════

function renderProfileTab(s) {
  return `
    <div class="hr-section">
      <div class="hr-section-title">Personal Information</div>
      <div class="hr-grid-2">
        ${hf('Full name',s.full_name)} ${hf('Nickname',s.nickname)}
        ${hf('Date of birth',hrDate(s.date_of_birth))} ${hf('Gender',s.gender)}
        ${hf('Civil status',s.civil_status)} ${hf('Mobile',s.mobile)}
        ${hf('Email',s.email)} ${hf('Department',s.department)}
      </div>
    </div>
    <div class="hr-section">
      <div class="hr-section-title">Employment Details</div>
      <div class="hr-grid-2">
        ${hf('Staff code',s.staff_code)} ${hf('Role',s.role)}
        ${hf('Type',s.employment_type)} ${hf('Status',s.employment_status)}
        ${hf('Date hired',hrDate(s.date_hired))} ${hf('OT allowed',s.overtime_allowed?'✅ Yes':'❌ No')}
      </div>
    </div>
    <div class="hr-section">
      <div class="hr-section-title">Payout
        <span style="font-size:.65rem;color:#5a4a3a;font-weight:400">(update via Edit)</span>
      </div>
      <div class="hr-grid-2">
        ${hf('Method',s.payout_method||'—')} ${hf('GCash / Bank',s.payout_details||'—')}
      </div>
    </div>
    <div class="hr-section" id="hrGovtSection_${esc(s.id)}">
      <div class="hr-section-title">Government Numbers
        <span style="font-size:.65rem;color:#5a4a3a;font-weight:400">(fill via Edit)</span>
      </div>
      <div class="hr-grid-2" id="hrGovtGrid_${esc(s.id)}">
        <div class="hr-field"><div class="hr-field-label">SSS</div><div class="hr-field-value" id="hrSSS_${esc(s.id)}">⏳</div></div>
        <div class="hr-field"><div class="hr-field-label">PhilHealth</div><div class="hr-field-value" id="hrPH_${esc(s.id)}">⏳</div></div>
        <div class="hr-field"><div class="hr-field-label">PagIBIG</div><div class="hr-field-value" id="hrPIG_${esc(s.id)}">⏳</div></div>
        <div class="hr-field"><div class="hr-field-label">TIN</div><div class="hr-field-value" id="hrTIN_${esc(s.id)}">⏳</div></div>
      </div>
    </div>
    <div class="hr-section">
      <div class="hr-section-title">🔲 Employee QR Code
        <span style="font-size:.65rem;color:#5a4a3a;font-weight:400">— for clock-in/out only</span>
      </div>
      <div style="display:flex;align-items:flex-start;gap:16px;background:#f0fdf4;border-radius:10px;padding:14px">
        <img id="hrQrImg_${esc(s.id)}" src="https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent('YANI-CLOCKIN:'+(s.qr_token||s.staff_code))}&bgcolor=ffffff&color=1a3a2a&margin=4"
          style="width:90px;height:90px;border-radius:8px;border:2px solid #1a3a2a;flex-shrink:0"
          alt="QR Code for ${esc(s.staff_code)}">
        <div>
          <div style="font-size:.82rem;font-weight:700;color:#111;margin-bottom:4px">${esc(s.full_name||'—')}</div>
          <div style="font-size:.75rem;color:#5a4a3a;margin-bottom:8px">${esc(s.staff_code||'')} · ${esc(s.role||'')}</div>
          <div style="font-size:.68rem;color:#5a4a3a;margin-bottom:8px;line-height:1.5">This QR only identifies the staff member — a PIN is still required to clock in. If lost or copied, regenerate it below to invalidate the old code.</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <button onclick="printHRQR('${esc(s.qr_token||s.staff_code)}','${esc(s.full_name||'')}','${esc(s.staff_code||'')}')" style="font-size:.7rem;background:#1a3a2a;color:#fff;border:none;border-radius:8px;padding:5px 11px;cursor:pointer">🖨️ Print QR</button>
            <button onclick="regenerateHRQR('${esc(s.id)}')" style="font-size:.7rem;background:#fff;color:#991b1b;border:1.5px solid #991b1b;border-radius:8px;padding:5px 11px;cursor:pointer">🔄 Regenerate QR</button>
          </div>
        </div>
      </div>
    </div>
    <div class="hr-section">
      <div class="hr-section-title">🔐 PIN Management
        <span style="font-size:.65rem;color:#5a4a3a;font-weight:400">— two separate secrets, by design</span>
      </div>
      <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:12px 14px;margin-bottom:10px">
        <div style="font-size:.7rem;color:#854d0e;line-height:1.6">
          <b>Attendance PIN</b> (4–6 digits) — used only at the clock-in kiosk for Clock In/Out/Break. Fast, shared-device friendly.<br>
          <b>Portal PIN</b> (6–8 digits) — used only to log into the employee portal (payslips, leave, profile). Deliberately separate, so a PIN seen at the counter can't be used to view personal/payroll info.
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button onclick="setHRPin('${esc(s.id)}','${esc(s.full_name||'')}','attendance')" style="font-size:.72rem;background:#1a3a2a;color:#fff;border:none;border-radius:8px;padding:7px 13px;cursor:pointer">⏱ Set Attendance PIN</button>
        <button onclick="setHRPin('${esc(s.id)}','${esc(s.full_name||'')}','portal')" style="font-size:.72rem;background:#fff;color:#1a3a2a;border:1.5px solid #1a3a2a;border-radius:8px;padding:7px 13px;cursor:pointer">🌐 Set Portal PIN</button>
      </div>
    </div>`;
}

function regenerateHRQR(staffId) {
  if (!confirm('Regenerate this QR code? The old printed QR will stop working immediately.')) return;
  api('hrRotateQrToken', {userId: currentUser?.userId, staffId}).then(function(r){
    if (!r.ok) { showToast('Error: '+(r.error||'Failed to regenerate'), 'error'); return; }
    var img = document.getElementById('hrQrImg_'+staffId);
    if (img) img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=120x120&data='+encodeURIComponent('YANI-CLOCKIN:'+r.qrToken)+'&bgcolor=ffffff&color=1a3a2a&margin=4';
    var s = _hrStaff.find(function(x){ return x.id === staffId; });
    if (s) s.qr_token = r.qrToken;
    showToast('QR regenerated — old code is now invalid ✅', 'success');
  });
}

function setHRPin(staffId, name, kind) {
  var isPortal = kind === 'portal';
  var minLen = isPortal ? 6 : 4;
  var maxLen = isPortal ? 8 : 6;
  hrModal((isPortal ? '🌐 Set Portal PIN' : '⏱ Set Attendance PIN') + ' — ' + esc(name), `
    <div class="hr-edit-row">
      <label class="hr-edit-label">${isPortal ? 'Portal' : 'Attendance'} PIN (${minLen}-${maxLen} digits)</label>
      <input class="hr-edit-input" id="hrNewPin" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="${maxLen}" placeholder="${isPortal ? '6-8 digits' : '4-6 digits'}">
    </div>
    <div style="font-size:.7rem;color:#5a4a3a;margin-top:6px">${isPortal ? 'Used only for the employee portal login — separate from the clock-in PIN.' : 'Used only at the clock-in kiosk — staff will use this with their QR or staff code.'}</div>
  `, async function(){
    var pin = document.getElementById('hrNewPin').value.trim();
    var re = isPortal ? /^\d{6,8}$/ : /^\d{4,6}$/;
    if (!re.test(pin)) { showToast('PIN must be '+minLen+'-'+maxLen+' digits', 'error'); return false; }
    var r = await api(isPortal ? 'hrSetPortalPin' : 'hrSetPin', {userId: currentUser?.userId, staffId, pin});
    if (!r.ok) { showToast('Error: '+(r.error||'Failed'), 'error'); return false; }
    showToast((isPortal ? 'Portal' : 'Attendance') + ' PIN set ✅', 'success');
  });
}

async function loadPayTab(s,tc) {
  const r = await api('hrGetRateHistory',{userId:currentUser?.userId,staffId:s.id});
  const rows = (r&&r.rows)||[];
  const cur = r&&r.current;
  const N=v=>parseFloat(v||0);
  const std = N(s.standard_hours_per_day)||8;
  const unit = b => b==='HOURLY'?'/hr':b==='MONTHLY'?'/month':'/day';
  const rate = cur && cur.basic_rate!=null ? hrPeso(cur.basic_rate)+unit(cur.pay_basis) : (s.daily_rate?hrPeso(s.daily_rate)+'/day':'Not set');
  const hourly = cur ? hrPeso(cur.hourly) : (s.daily_rate?hrPeso(N(s.daily_rate)/std):'—');
  const since = cur && cur.effective_date ? 'since '+hrDate(cur.effective_date) : '';
  const today = r&&r.today;
  const hist = rows.length ? rows.map((h,i)=>{
    const future = today && h.effective_date > today;
    const isCur = cur && cur.effective_date===h.effective_date;
    return `<div class="hr-table-row" style="${isCur?'background:#f0fdf4':''}">
      <span class="hr-td-date">${hrDate(h.effective_date)}${future?' <span style="font-size:.58rem;font-weight:700;background:#e0e7ff;color:#4338ca;padding:1px 5px;border-radius:20px">UPCOMING</span>':''}${isCur?' <span style="font-size:.58rem;font-weight:700;background:#dcfce7;color:#15803d;padding:1px 5px;border-radius:20px">CURRENT</span>':''}</span>
      <span><b>${hrPeso(h.basic_rate)}</b>${unit(h.pay_basis)} <span style="color:#6b7280;font-size:.68rem">= ${hrPeso(h.pay_basis==='HOURLY'?N(h.basic_rate):h.pay_basis==='MONTHLY'?N(h.basic_rate)*12/(52*6*std):N(h.basic_rate)/std)}/hr</span></span>
      <span style="font-size:.7rem;color:#6b7280">${esc(h.reason_for_change||'')}</span>
    </div>`; }).join('') : '<div class="hr-empty-sm">No rate on record yet — add one with "+ Rate change".</div>';
  tc.innerHTML=`
    <div class="hr-section">
      <div class="hr-pay-card">
        <div class="hr-pay-label">CURRENT RATE ${since?'<span style="font-weight:400;text-transform:none;letter-spacing:0">· '+since+'</span>':''}</div>
        <div class="hr-pay-amount">${rate}</div>
        <div class="hr-pay-sub">${hourly}/hr · est. monthly (26 days): ${cur&&cur.pay_basis==='DAILY'?hrPeso(N(cur.basic_rate)*26):(s.daily_rate?hrPeso(N(s.daily_rate)*26):'—')}</div>
      </div>
      <div class="hr-grid-2" style="margin-top:10px">
        ${hf('Pay basis',(cur&&cur.pay_basis)||s.pay_basis||'DAILY')}
        ${hf('Std hrs/day',std)}
        ${hf('OT allowed',s.overtime_allowed?'✅ Yes':'❌ No')}
        ${hf('Art. 82 exempt',s.art82_exempt?'Yes — no OT / ND':'No')}
      </div>
    </div>
    <div class="hr-section">
      <div class="hr-section-hdr">
        <div>
          <div class="hr-section-title">📈 Rate history</div>
          <div style="font-size:.68rem;color:#6b7280;margin-top:2px">Payroll pays each day at the rate in force on that day — a change mid cut-off applies from its date.</div>
        </div>
        <button class="hr-action-btn hr-btn-primary" onclick="openRateChangeModal('${s.id}')">+ Rate change</button>
      </div>
      <div class="hr-list-table">
        <div class="hr-table-hdr"><span>Effective</span><span>Rate</span><span>Reason</span></div>
        ${hist}
      </div>
    </div>`;
}

function openRateChangeModal(staffId){
  const s=_hrSelected||{};
  const today=new Date(Date.now()+8*3600*1000).toISOString().slice(0,10);
  hrModal('Rate change', `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="hr-edit-row"><label class="hr-edit-label">Effective date *</label>
        <input class="hr-edit-input" id="rcDate" type="date" value="${today}"></div>
      <div class="hr-edit-row"><label class="hr-edit-label">Pay basis</label>
        <select class="hr-edit-input" id="rcBasis">
          <option value="DAILY"${(s.pay_basis||'DAILY')==='DAILY'?' selected':''}>Daily</option>
          <option value="HOURLY"${s.pay_basis==='HOURLY'?' selected':''}>Hourly</option>
          <option value="MONTHLY"${s.pay_basis==='MONTHLY'?' selected':''}>Monthly</option>
        </select></div>
    </div>
    <div class="hr-edit-row"><label class="hr-edit-label">New rate (₱) *</label>
      <input class="hr-edit-input" id="rcRate" type="number" step="0.01" min="0" placeholder="600.00"></div>
    <div class="hr-edit-row"><label class="hr-edit-label">Reason (required)</label>
      <input class="hr-edit-input" id="rcReason" type="text" placeholder="e.g. Regularized after training"></div>
    <div style="font-size:.66rem;color:#6b7280;margin-top:4px">Days from the effective date onward are paid at the new rate; earlier days keep the old one. Open cut-offs it touches are recomputed. A finalized or paid cut-off must be reopened first.</div>
  `, async function(){
    const v=id=>document.getElementById(id).value;
    if(!v('rcDate')||!(parseFloat(v('rcRate'))>0)){ showToast('Effective date and a rate are required','error'); return false; }
    if((v('rcReason')||'').trim().length<3){ showToast('A reason is required','error'); return false; }
    const r=await api('hrAddRateChange',{userId:currentUser?.userId,staffId,effective_date:v('rcDate'),
      pay_basis:v('rcBasis'),basic_rate:v('rcRate'),reason:v('rcReason').trim()});
    if(!r||!r.ok){ showToast(r&&r.error?r.error:'Could not save','error'); return false; }
    showToast('Rate saved'+((r.recomputed||[]).length?' · recomputed '+r.recomputed.join(', '):'')+' ✅','success');
    // refresh the staff record so the header/profile shows the current rate
    try{ const st=await api('getHRStaff',{userId:currentUser?.userId}); const me=(st.staff||[]).find(x=>x.id===staffId); if(me){ _hrSelected=me; const i=_hrStaff.findIndex(x=>x.id===staffId); if(i>=0)_hrStaff[i]=me; } }catch(_){}
    await loadHRTab(_hrSelected,'pay');
  });
}

// ── LOANS TAB ──────────────────────────────────────────────────────────────
async function loadLoansTab(s,tc) {
  const r=await api('getHRLoans',{userId:currentUser?.userId,staffId:s.id});
  const loans=r.loans||[];
  const total=loans.reduce((sum,l)=>sum+(l.status==='ACTIVE'?parseFloat(l.balance_remaining||0):0),0);
  tc.innerHTML=`
    <div class="hr-section">
      <div class="hr-section-hdr">
        <div>
          <div class="hr-section-title">🏦 Loans & Advances</div>
          ${total>0?`<div style="font-size:.75rem;color:#dc2626;font-weight:600;margin-top:2px">Outstanding balance: ${hrPeso(total)}</div>`:''}
        </div>
        <button class="hr-action-btn hr-btn-primary" onclick="openAddLoanModal('${s.id}')">+ Add Entry</button>
      </div>
      ${loans.length===0
        ?'<div class="hr-empty-sm">No loan entries yet. Use "+ Add Entry" to add a loan or deduction.</div>'
        :`<div class="hr-list-table">
          <div class="hr-table-hdr"><span>Date</span><span>Description</span><span class="r">Amount</span><span class="r">Balance</span><span>Status</span></div>
          ${loans.map(l=>{
            const ls=HR_LOAN_STATUS[l.status]||HR_LOAN_STATUS.ACTIVE;
            const amt=parseFloat(l.principal||0);
            return `<div class="hr-table-row">
              <span class="hr-td-date">${hrDate(l.start_date||l.created_at)}</span>
              <span class="hr-td-desc">${esc(l.notes||'Loan')}</span>
              <span class="r hr-td-amt ${amt<0?'hr-green':'hr-red'}">${amt<0?'−':'+'} ${hrPeso(Math.abs(amt))}</span>
              <span class="r hr-td-amt">${hrPeso(l.balance_remaining||0)}</span>
              <span><span class="hr-badge-sm" style="background:${ls.bg};color:${ls.fg}">${l.status}</span></span>
            </div>`;
          }).join('')}
        </div>`
      }
    </div>`;
}

function openAddLoanModal(staffId) {
  hrModal('Add Loan / Deduction Entry',`
    <div class="hr-edit-row"><label class="hr-edit-label">Type</label>
      <select class="hr-edit-input" id="loanType">
        <option value="loan">+ Loan (amount owed)</option>
        <option value="deduction">− Deduction / Cash advance</option>
      </select>
    </div>
    <div class="hr-edit-row"><label class="hr-edit-label">Amount (₱) *</label>
      <input class="hr-edit-input" id="loanAmt" type="number" min="1" step="0.01" placeholder="e.g. 2000">
    </div>
    <div class="hr-edit-row"><label class="hr-edit-label">Date</label>
      <input class="hr-edit-input" id="loanDate" type="date" value="${new Date().toISOString().split('T')[0]}">
    </div>
    <div class="hr-edit-row"><label class="hr-edit-label">Monthly deduction (₱)</label>
      <input class="hr-edit-input" id="loanAmort" type="number" min="0" step="0.01" placeholder="optional">
    </div>
    <div class="hr-edit-row"><label class="hr-edit-label">Notes / Description</label>
      <input class="hr-edit-input" id="loanNotes" type="text" placeholder="e.g. Emergency cash advance">
    </div>
  `,async function(){
    const typeVal=document.getElementById('loanType').value;
    const amt=parseFloat(document.getElementById('loanAmt').value);
    if(!amt||amt<=0){showToast('Enter a valid amount','error');return false;}
    const principal=typeVal==='deduction'?-Math.abs(amt):Math.abs(amt);
    const r=await api('addHRLoan',{userId:currentUser?.userId,staffId,
      principal,
      start_date:document.getElementById('loanDate').value,
      monthly_amortization:document.getElementById('loanAmort').value||null,
      notes:document.getElementById('loanNotes').value||null
    });
    if(!r.ok){showToast('Error: '+(r.error||'Failed'),'error');return false;}
    showToast(typeVal==='deduction'?'Deduction recorded ✅':'Loan recorded ✅','success');
    if(_hrSelected?.id===staffId) await loadHRTab(_hrSelected,'loans');
  });
}

// ── loadGovtNumbers — async fetch and populate profile tab ─────────────
async function loadGovtNumbers(s) {
  try {
    const r = await api('getHRProfile', {userId:currentUser?.userId, staffId:s.id});
    if (!r.ok) return;
    const p = r.profile || {};
    s._profile_sss  = p.sss_no        || '';
    s._profile_ph   = p.philhealth_no  || '';
    s._profile_pig  = p.pagibig_no     || '';
    s._profile_tin  = p.tin_no         || '';
    // Update DOM if elements exist
    const set = function(id, val) {
      var el = document.getElementById(id);
      if (el) el.textContent = val || '—';
    };
    set('hrSSS_'+s.id,  s._profile_sss  || '—');
    set('hrPH_'+s.id,   s._profile_ph   || '—');
    set('hrPIG_'+s.id,  s._profile_pig  || '—');
    set('hrTIN_'+s.id,  s._profile_tin  || '—');
  } catch(e) { /* silent fail */ }
}

// ── LEAVE TAB ──────────────────────────────────────────────────────────────
async function loadLeaveTab(s,tc) {
  const r=await api('getHRLeave',{userId:currentUser?.userId,staffId:s.id});
  const bals=r.balances||[];
  const reqs=r.requests||[];
  const LEAVE_TYPES=['VACATION','SICK','EMERGENCY','BIRTHDAY','BEREAVEMENT','UNPAID'];
  tc.innerHTML=`
    <div class="hr-section">
      <div class="hr-section-title">Leave Balances</div>
      <div class="hr-leave-grid">
        ${LEAVE_TYPES.map(t=>{
          const b=bals.find(x=>x.leave_type===t);
          const entitled=b?parseFloat(b.entitled_days):0;
          const used=b?parseFloat(b.used_days):0;
          const rem=entitled-used;
          return `<div class="hr-leave-card">
            <div class="hr-leave-type">${t.replace('_',' ')}</div>
            <div class="hr-leave-bal" style="color:${rem>0?'#166534':'#991b1b'}">${rem} <span>days left</span></div>
            <div class="hr-leave-used">${used} used / ${entitled} entitled</div>
          </div>`;
        }).join('')}
      </div>
    </div>
    <div class="hr-section">
      <div class="hr-section-hdr">
        <div class="hr-section-title">Leave Requests</div>
        <button class="hr-action-btn hr-btn-primary" onclick="openFileLeaveModal('${s.id}')">+ File Leave</button>
      </div>
      ${reqs.length===0
        ?'<div class="hr-empty-sm">No leave requests yet.</div>'
        :`<div class="hr-list-table">
          <div class="hr-table-hdr"><span>Date filed</span><span>Type</span><span>Days</span><span>Status</span></div>
          ${reqs.map(r=>`<div class="hr-table-row">
            <span class="hr-td-date">${hrDate(r.requested_at)}</span>
            <span>${esc(r.leave_type||'')}</span>
            <span>${r.number_of_days}</span>
            <span>${hrLeaveBadge(r.status)}</span>
          </div>`).join('')}
        </div>`
      }
    </div>`;
}
function hrLeaveBadge(s){const map={PENDING:{b:'#fef9c3',f:'#854d0e'},APPROVED:{b:'#dcfce7',f:'#166534'},REJECTED:{b:'#fee2e2',f:'#991b1b'},CANCELLED:{b:'#f3f4f6',f:'#4b5563'}};const c=map[s]||map.PENDING;return`<span class="hr-badge-sm" style="background:${c.b};color:${c.f}">${s}</span>`;}

function openFileLeaveModal(staffId) {
  hrModal('File Leave Request',`
    <div class="hr-edit-row"><label class="hr-edit-label">Leave type *</label>
      <select class="hr-edit-input" id="lvType">
        ${['VACATION','SICK','EMERGENCY','BIRTHDAY','BEREAVEMENT','MATERNITY','PATERNITY','UNPAID','OTHER'].map(t=>`<option value="${t}">${t.replace('_',' ')}</option>`).join('')}
      </select>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="hr-edit-row"><label class="hr-edit-label">From *</label><input class="hr-edit-input" id="lvFrom" type="date"></div>
      <div class="hr-edit-row"><label class="hr-edit-label">To *</label><input class="hr-edit-input" id="lvTo" type="date"></div>
    </div>
    <div class="hr-edit-row"><label class="hr-edit-label">Reason</label>
      <textarea class="hr-edit-input" id="lvReason" rows="2" placeholder="Optional reason"></textarea>
    </div>
  `,async function(){
    const from=document.getElementById('lvFrom').value;
    const to=document.getElementById('lvTo').value;
    if(!from||!to){showToast('Start and end dates required','error');return false;}
    const days=Math.ceil((new Date(to)-new Date(from))/86400000)+1;
    const r=await api('addHRLeaveRequest',{userId:currentUser?.userId,staffId,
      leave_type:document.getElementById('lvType').value,
      start_date:from,end_date:to,number_of_days:days,
      reason:document.getElementById('lvReason').value||null
    });
    if(!r||r.error){showToast('Filed! (pending approval)','success');}
    else showToast('Leave filed ✅','success');
    if(_hrSelected?.id===staffId) await loadHRTab(_hrSelected,'leave');
  });
}

// ── CLOCK-IN TAB ───────────────────────────────────────────────────────────

// Worked hours per day. The events list alone never answered the only question
// that matters — how long did this person actually work — so a 10-hour day
// looked identical to a 2-hour one.
function _hrWorkedHoursTable(days){
  if(!days.length) return '<div class="hr-empty-sm">No attendance in the last 14 days.</div>';
  const n=v=>parseFloat(v||0);
  const hm=v=>{ const x=n(v); if(!x) return null;
    const h=Math.floor(x), m=Math.round((x-h)*60);
    return (h?h+'h ':'')+(m?m+'m':(h?'':'0m')); };
  let tw=0, tot=0, tut=0, tbr=0;
  const rows=days.slice().reverse().map(function(d){
    tw+=n(d.worked_hours); tot+=n(d.ot_hours); tut+=n(d.undertime_hours); tbr+=n(d.break_mins);
    const open=d.is_open;
    const dt=new Date(d.work_date+'T00:00:00');
    const nice=dt.toLocaleDateString('en-PH',{weekday:'short',month:'short',day:'numeric'});
    return `<tr style="border-bottom:1px solid var(--mist-light,#eef1ec)${open?';background:#f0fdf4':''}">
      <td style="padding:9px 10px;white-space:nowrap;font-weight:600">${esc(nice)}</td>
      <td style="padding:9px 10px;white-space:nowrap">${esc(d.first_in||'—')}</td>
      <td style="padding:9px 10px;white-space:nowrap">${
        open?'<span style="color:#15803d;font-weight:700">still in</span>':esc(d.last_out||'—')}</td>
      <td style="padding:9px 10px;text-align:right;white-space:nowrap">
        <span style="font-weight:800;font-size:.86rem">${d.worked_hm||hm(d.worked_hours)||'0m'}</span>
        <span style="display:block;font-size:.6rem;color:#9ca3af">${n(d.worked_hours).toFixed(2)} hrs</span></td>
      <td style="padding:9px 10px;text-align:right;white-space:nowrap${n(d.ot_hours)>0?';color:#1d4ed8;font-weight:700':';color:#cbd5e1'}">${
        n(d.ot_hours)>0?(d.ot_hm||hm(d.ot_hours)):'—'}</td>
      <td style="padding:9px 10px;text-align:right;white-space:nowrap${n(d.undertime_hours)>0?';color:#b45309;font-weight:700':';color:#cbd5e1'}">${
        n(d.undertime_hours)>0?(d.undertime_hm||hm(d.undertime_hours)):'—'}</td>
      <td style="padding:9px 10px;font-size:.68rem;color:#6b7280;white-space:nowrap">${
        d.break_detail?esc(d.break_detail)+' <b>('+Math.round(n(d.break_mins))+'m)</b>':'—'}</td>
    </tr>`;
  }).join('');
  const many = days.length > 1;
  return `<div style="overflow-x:auto;border:1px solid var(--mist,#e2e5df);border-radius:8px">
    <table style="width:100%;border-collapse:collapse;font-size:.76rem;white-space:nowrap">
      <thead><tr style="background:var(--mist-light,#f1f5f9);text-align:left;color:#475569">
        <th style="padding:7px 10px">DAY</th>
        <th style="padding:7px 10px">CLOCK IN</th>
        <th style="padding:7px 10px">CLOCK OUT</th>
        <th style="padding:7px 10px;text-align:right">WORKED</th>
        <th style="padding:7px 10px;text-align:right" title="Beyond the standard day">OVERTIME</th>
        <th style="padding:7px 10px;text-align:right" title="Short of the standard day">SHORT</th>
        <th style="padding:7px 10px">BREAKS (unpaid)</th>
      </tr></thead>
      <tbody>${rows}</tbody>
      ${many?`<tfoot><tr style="border-top:2px solid #d8ddd5;font-weight:800;background:#fafbfa">
        <td colspan="3" style="padding:9px 10px">${days.length} days</td>
        <td style="padding:9px 10px;text-align:right">${hm(tw)||'0m'}</td>
        <td style="padding:9px 10px;text-align:right;color:#1d4ed8">${tot>0?hm(tot):'—'}</td>
        <td style="padding:9px 10px;text-align:right;color:#b45309">${tut>0?hm(tut):'—'}</td>
        <td style="padding:9px 10px;color:#6b7280">${Math.round(tbr)}m total</td>
      </tr></tfoot>`:''}
    </table></div>`;
}

async function loadClockTab(s,tc) {
  const [r, sum] = await Promise.all([
    api('getHRTimeLogs',{userId:currentUser?.userId,staffId:s.id,limit:14}),
    api('hrDailySummary',{userId:currentUser?.userId,staffId:s.id,days:14}),
  ]);
  const logs=r.logs||[];
  const days=(sum && sum.days)||[];
  const EVENT_COLOR={CLOCK_IN:'#dcfce7',CLOCK_OUT:'#fee2e2',BREAK_START:'#fef9c3',BREAK_END:'#fef3c7',BROKEN_TIME_START:'#e0f2fe',BROKEN_TIME_END:'#dbeafe'};
  tc.innerHTML=`
    <div class="hr-section">
      <div class="hr-section-hdr">
        <div class="hr-section-title">⏱ Worked Hours</div>
        <button class="hr-action-btn hr-btn-primary" onclick="openManualClockModal('${s.id}')">+ Manual Entry</button>
      </div>
      ${_hrWorkedHoursTable(days)}
      <details style="margin-top:16px">
        <summary style="cursor:pointer;font-size:.75rem;font-weight:700;color:var(--forest-deep,#1f3d2b);padding:4px 0">
          🕐 Show every clock event (${logs.length})</summary>
      ${logs.length===0
        ?'<div class="hr-empty-sm">No clock-in records yet. Staff must clock in via the employee portal or manual entry.</div>'
        :`<div class="hr-list-table">
          <div class="hr-table-hdr"><span>Date</span><span>Time</span><span>Event</span><span>Source</span></div>
          ${logs.map(l=>{ const bg=EVENT_COLOR[l.event_type]||'#f3f4f6';
            return `<div class="hr-table-row">
              <span class="hr-td-date">${hrDate(l.log_date)}</span>
              <span>${l.event_time?new Date(l.event_time).toLocaleTimeString('en-PH',{hour:'2-digit',minute:'2-digit'}):'—'}
                <a href="#" onclick="openEditTimeModal('${s.id}',{id:'${l.id}',date:'${esc(l.log_date)}',event:'${esc(l.event_type)}',current:'${l.event_time?new Date(l.event_time).toLocaleTimeString('en-PH',{hour:'2-digit',minute:'2-digit'}):''}',iso:'${esc(l.event_time||'')}'});return false" title="Correct this time" style="font-size:.7rem;text-decoration:none;margin-left:4px">✎</a></span>
              <span><span class="hr-badge-sm" style="background:${bg};color:#1a1a1a">${esc(l.event_type||'').replace(/_/g,' ')}</span></span>
              <span style="font-size:.63rem;font-weight:700;padding:2px 7px;border-radius:20px;${
  (l.attendance_source==='QR') ? 'background:#dcfce7;color:#15803d' :
  (l.attendance_source==='MANUAL')  ? 'background:#fef3c7;color:#b45309' :
                                      'background:#e0e7ff;color:#4338ca'}">${
  esc(l.attendance_source||'MANUAL')}</span>${
  l.notes?`<div style="font-size:.62rem;color:#8a7a6a;margin-top:2px">${esc(l.notes)}</div>`:''}
            </div>`;
          }).join('')}
        </div>`
      }
      </details>
    </div>`;
}

function openManualClockModal(staffId, preset) {
  const now=new Date();
  preset = preset || {};
  const presetDate = /^\d{4}-\d{2}-\d{2}$/.test(preset.date||'') ? preset.date : now.toISOString().split('T')[0];
  const presetEv = preset.event || 'CLOCK_IN';
  const presetTime = preset.date ? '' : now.toTimeString().slice(0,5);
  const opt = (v,l)=>`<option value="${v}"${presetEv===v?' selected':''}>${l}</option>`;
  hrModal('Manual Clock Entry',`
    <div class="hr-edit-row"><label class="hr-edit-label">Event type *</label>
      <select class="hr-edit-input" id="clkEvent">
        ${opt('CLOCK_IN','Clock In')}${opt('CLOCK_OUT','Clock Out')}${opt('BREAK_START','Break Start')}${opt('BREAK_END','Break End')}
      </select>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="hr-edit-row"><label class="hr-edit-label">Shift date *</label><input class="hr-edit-input" id="clkDate" type="date" value="${presetDate}"></div>
      <div class="hr-edit-row"><label class="hr-edit-label">Time *</label><input class="hr-edit-input" id="clkTime" type="time" value="${presetTime}"></div>
    </div>
    ${preset.taps?`<div style="font-size:.7rem;color:#475569;background:#f1f5f9;border-radius:6px;padding:6px 10px;margin:-4px 0 8px">Taps already on this day: <b>${esc(preset.taps)}</b>. A time-out must be later than the last one.</div>`:''}
    <div id="clkNextDay" style="display:none;font-size:.7rem;color:#b45309;background:#fef3c7;border-radius:6px;padding:6px 10px;margin:-4px 0 8px">
      🌙 Before 6:00 AM — this will be filed as the end of the <b id="clkNextDayLbl"></b> shift (early the next morning).
    </div>
    <div class="hr-edit-row"><label class="hr-edit-label">Reason (required)</label>
      <input class="hr-edit-input" id="clkNotes" type="text" placeholder="e.g. forgot to clock out, kiosk offline">
    </div>
  `,async function(){
    const date=document.getElementById('clkDate').value;
    const time=document.getElementById('clkTime').value;
    if(!date||!time){showToast('Date and time required','error');return false;}
    const reason=(document.getElementById('clkNotes').value||'').trim();
    if(reason.length<3){showToast('A reason is required for manual entries','error');return false;}
    const eventType=document.getElementById('clkEvent').value;
    // "Shift date" + a time before 6:00 AM (for anything but a clock-in) means
    // the early hours of the NEXT morning — closers leave at 12:15–1:40 AM and
    // that time-out belongs to the shift that started the day before.
    const calDate=_clkIsNextMorning(eventType,time)?_clkAddDay(date):date;
    const eventTime=new Date(calDate+'T'+time).toISOString();
    const r=await api('addHRTimeLog',{userId:currentUser?.userId,staffId,
      event_type:eventType,
      log_date:date,event_time:eventTime,
      notes:reason
    });
    if(!r||!r.ok){showToast(r&&r.error?r.error:'Could not save the entry','error');return false;}
    showToast('Clock entry saved ✅','success');
    if(_hrSelected?.id===staffId) await loadHRTab(_hrSelected, _hrActiveTab==='payroll' ? 'payroll' : 'clock');
  });
  setTimeout(_clkRefreshNextDayHint,0);
  ['clkEvent','clkDate','clkTime'].forEach(function(id){
    const el=document.getElementById(id); if(el) el.addEventListener('input',_clkRefreshNextDayHint);
    if(el) el.addEventListener('change',_clkRefreshNextDayHint);
  });
}
// Correct one existing time. Works for a kiosk tap too: the row becomes a
// MANUAL "corrected from …" row and the original value goes to the audit.
function openEditTimeModal(staffId, ref){
  ref = ref || {};
  const label = String(ref.event||'').replace(/_/g,' ').toLowerCase();
  // current time as HH:MM for the input (from ISO when we have it, else parse the label)
  let hhmm = '';
  if (ref.iso) { const d=new Date(new Date(ref.iso).getTime()+8*3600*1000); hhmm = String(d.getUTCHours()).padStart(2,'0')+':'+String(d.getUTCMinutes()).padStart(2,'0'); }
  else { const m=/(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(ref.current||''); if(m){ let H=parseInt(m[1],10)%12; if(/pm/i.test(m[3])) H+=12; hhmm=String(H).padStart(2,'0')+':'+m[2]; } }
  const nextMorning = /\+1/.test(ref.current||'') || (ref.iso && new Date(new Date(ref.iso).getTime()+8*3600*1000).toISOString().slice(0,10) > ref.date);
  hrModal('Correct '+label+' — '+hrDate(ref.date), `
    <div style="font-size:.74rem;color:#475569;margin-bottom:8px">Currently <b>${esc(ref.current||'—')}</b>. Enter the correct time; the original is kept in the audit and the cell will show ✎.</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="hr-edit-row"><label class="hr-edit-label">Correct time *</label><input class="hr-edit-input" id="etTime" type="time" value="${hhmm}"></div>
      <div class="hr-edit-row"><label class="hr-edit-label">Day</label>
        <select class="hr-edit-input" id="etDay">
          <option value="0"${nextMorning?'':' selected'}>${hrDate(ref.date)} (shift date)</option>
          <option value="1"${nextMorning?' selected':''}>Next morning (after midnight)</option>
        </select></div>
    </div>
    <div class="hr-edit-row"><label class="hr-edit-label">Reason (required)</label>
      <input class="hr-edit-input" id="etReason" type="text" placeholder="e.g. tapped out late, actual time per CCTV"></div>
  `, async function(){
    const t=document.getElementById('etTime').value, day=document.getElementById('etDay').value, reason=(document.getElementById('etReason').value||'').trim();
    if(!t){ showToast('Enter the correct time','error'); return false; }
    if(reason.length<3){ showToast('A reason is required','error'); return false; }
    const calDate = day==='1' ? _clkAddDay(ref.date) : ref.date;
    const newIso = new Date(calDate+'T'+t+':00+08:00').toISOString();
    const payload = {userId:currentUser?.userId, new_time:newIso, reason};
    if (ref.id) payload.id = ref.id; else Object.assign(payload,{staffId, log_date:ref.date, event_type:ref.event, which:ref.which||'last'});
    const r=await api('editHRTimeLog', payload);
    if(!r||!r.ok){ showToast(r&&r.error?r.error:'Could not save the correction','error'); return false; }
    showToast('Time corrected ✅','success');
    if(_hrSelected?.id===staffId) await loadHRTab(_hrSelected, _hrActiveTab==='payroll' ? 'payroll' : 'clock');
  });
}

async function removeManualEntry(staffId, date, evType){
  const label = evType.replace('_',' ').toLowerCase();
  const reason = prompt('Remove the manual '+label+' on '+date+'? Reason (required):');
  if(reason===null) return;
  if(reason.trim().length<3){ showToast('A reason is required','error'); return; }
  const r=await api('removeHRManualEntry',{userId:currentUser?.userId,staffId,log_date:date,event_type:evType,reason:reason.trim()});
  if(!r||!r.ok){ showToast(r&&r.error?r.error:'Could not remove','error'); return; }
  showToast('Manual entry removed','success');
  if(_hrSelected?.id===staffId) await loadHRTab(_hrSelected, _hrActiveTab==='payroll' ? 'payroll' : 'clock');
}
function _clkIsNextMorning(eventType,time){
  return eventType!=='CLOCK_IN' && /^\d{2}:\d{2}/.test(time||'') && parseInt(time.slice(0,2),10) < 6;
}
function _clkAddDay(ymd){
  const d=new Date(ymd+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+1); return d.toISOString().slice(0,10);
}
function _clkRefreshNextDayHint(){
  const ev=document.getElementById('clkEvent'), dt=document.getElementById('clkDate'), tm=document.getElementById('clkTime'),
        box=document.getElementById('clkNextDay'), lbl=document.getElementById('clkNextDayLbl');
  if(!ev||!dt||!tm||!box) return;
  const on=_clkIsNextMorning(ev.value,tm.value);
  box.style.display=on?'block':'none';
  if(on&&lbl) lbl.textContent=hrDate(dt.value);
}

// ── PERFORMANCE TAB ────────────────────────────────────────────────────────
async function loadPerformanceTab(s,tc) {
  const r=await api('getHRPerformance',{userId:currentUser?.userId,staffId:s.id});
  const recs=r.records||[];
  tc.innerHTML=`
    <div class="hr-section">
      <div class="hr-section-hdr">
        <div class="hr-section-title">⭐ Performance Records</div>
        <div style="display:flex;gap:6px">
          <button class="hr-action-btn hr-btn-success" onclick="openPerfModal('${s.id}','COMMENDATION')">🌟 Commend</button>
          <button class="hr-action-btn hr-btn-warning" onclick="openPerfModal('${s.id}','WARNING')">⚠️ Warning</button>
          <button class="hr-action-btn" onclick="openPerfModal('${s.id}','EVALUATION')">📊 Evaluate</button>
        </div>
      </div>
      ${recs.length===0
        ?'<div class="hr-empty-sm">No performance records yet.</div>'
        :recs.map(r=>{
          const ps=HR_PERF_STYLE[r.record_type]||HR_PERF_STYLE.EVALUATION;
          return `<div class="hr-perf-card" style="border-left:3px solid ${ps.fg}">
            <div class="hr-perf-hdr">
              <span class="hr-badge-sm" style="background:${ps.bg};color:${ps.fg}">${ps.icon} ${esc(r.record_type)}</span>
              <span class="hr-td-date">${hrDate(r.record_date)}</span>
            </div>
            <div class="hr-perf-title">${esc(r.title)}</div>
            ${r.description?`<div class="hr-perf-desc">${esc(r.description)}</div>`:''}
            ${r.rating?`<div class="hr-perf-rating">${'⭐'.repeat(r.rating)} (${r.rating}/5)</div>`:''}
          </div>`;
        }).join('')
      }
    </div>`;
}

function openPerfModal(staffId,type) {
  const ps=HR_PERF_STYLE[type]||HR_PERF_STYLE.EVALUATION;
  hrModal(`${ps.icon} Add ${type.charAt(0)+type.slice(1).toLowerCase()}`,`
    <div class="hr-edit-row"><label class="hr-edit-label">Title *</label>
      <input class="hr-edit-input" id="perfTitle" type="text" placeholder="${type==='COMMENDATION'?'e.g. Excellent service during Father\'s Day':type==='WARNING'?'e.g. Tardiness - 3rd offense':'e.g. Q2 2026 Performance Review'}">
    </div>
    <div class="hr-edit-row"><label class="hr-edit-label">Details</label>
      <textarea class="hr-edit-input" id="perfDesc" rows="3" placeholder="Describe the incident, achievement, or evaluation..."></textarea>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="hr-edit-row"><label class="hr-edit-label">Date</label>
        <input class="hr-edit-input" id="perfDate" type="date" value="${new Date().toISOString().split('T')[0]}">
      </div>
      ${type==='EVALUATION'?`<div class="hr-edit-row"><label class="hr-edit-label">Rating (1–5)</label>
        <select class="hr-edit-input" id="perfRating"><option value="">—</option>${[1,2,3,4,5].map(n=>`<option value="${n}">${'⭐'.repeat(n)} (${n})</option>`).join('')}</select>
      </div>`:'<div></div>'}
    </div>
  `,async function(){
    const title=document.getElementById('perfTitle').value.trim();
    if(!title){showToast('Title required','error');return false;}
    const r=await api('addHRPerformance',{userId:currentUser?.userId,staffId,record_type:type,
      title,description:document.getElementById('perfDesc').value||null,
      record_date:document.getElementById('perfDate').value,
      rating:document.getElementById('perfRating')?.value||null
    });
    if(!r.ok){showToast('Error: '+(r.error||'Failed'),'error');return false;}
    showToast(type+' added ✅','success');
    if(_hrSelected?.id===staffId) await loadHRTab(_hrSelected,'performance');
  });
}

// ── DOCUMENTS TAB ──────────────────────────────────────────────────────────
async function loadDocumentsTab(s,tc) {
  const [docR,incR]=await Promise.all([
    api('getHRDocuments',{userId:currentUser?.userId,staffId:s.id}),
    api('getHRIncidents',{userId:currentUser?.userId,staffId:s.id})
  ]);
  const docs=docR.documents||[];
  const incidents=incR.incidents||[];

  const VS={PENDING:{b:'#fef9c3',f:'#854d0e'},VERIFIED:{b:'#dcfce7',f:'#166534'},REJECTED:{b:'#fee2e2',f:'#991b1b'},EXPIRED:{b:'#f3f4f6',f:'#4b5563'}};

  tc.innerHTML=`
    <div class="hr-section">
      <div class="hr-section-hdr">
        <div class="hr-section-title">📄 Documents</div>
        <button class="hr-action-btn hr-btn-primary" onclick="openAddDocModal('${s.id}')">+ Add Document</button>
      </div>
      ${docs.length===0
        ?'<div class="hr-empty-sm">No documents uploaded yet.</div>'
        :docs.map(d=>{
          const vs=VS[d.verification_status]||VS.PENDING;
          return `<div class="hr-doc-row">
            <div class="hr-doc-icon">📎</div>
            <div class="hr-doc-info">
              <div class="hr-doc-name">${esc(d.document_type)}</div>
              <div class="hr-doc-meta">${hrDate(d.created_at)}${d.expiry_date?' · Expires: '+hrDate(d.expiry_date):''}${d.notes?' · '+esc(d.notes):''}</div>
            </div>
            <div style="display:flex;align-items:center;gap:8px">
              <span class="hr-badge-sm" style="background:${vs.b};color:${vs.f}">${d.verification_status}</span>
              ${d.file_link?`<a href="${esc(d.file_link)}" target="_blank" class="hr-link-btn">View</a>`:''}
            </div>
          </div>`;
        }).join('')
      }
    </div>

    <div class="hr-section">
      <div class="hr-section-hdr">
        <div class="hr-section-title">🚨 Incident Reports</div>
        <button class="hr-action-btn hr-btn-danger" onclick="openAddIncidentModal('${s.id}')">+ File Incident</button>
      </div>
      ${incidents.length===0
        ?'<div class="hr-empty-sm">No incident reports on file.</div>'
        :incidents.map(i=>{
          const is=HR_INCIDENT_STYLE[i.incident_type]||HR_INCIDENT_STYLE.OTHER;
          const ss={OPEN:{b:'#fee2e2',f:'#991b1b'},UNDER_REVIEW:{b:'#fef9c3',f:'#854d0e'},RESOLVED:{b:'#dcfce7',f:'#166534'},DISMISSED:{b:'#f3f4f6',f:'#4b5563'}};
          const sc=ss[i.status]||ss.OPEN;
          return `<div class="hr-incident-card" style="border-left:3px solid ${is.fg}">
            <div class="hr-perf-hdr">
              <span class="hr-badge-sm" style="background:${is.bg};color:${is.fg}">${is.icon} ${esc(i.incident_type)}</span>
              <span class="hr-badge-sm" style="background:${sc.b};color:${sc.f}">${i.status}</span>
              <span class="hr-td-date">${hrDate(i.incident_date)}</span>
            </div>
            ${i.description?`<div class="hr-perf-desc" style="margin-top:6px">${esc(i.description)}</div>`:''}
            ${i.action_taken?`<div class="hr-perf-desc" style="color:#166534;margin-top:4px">✅ Action: ${esc(i.action_taken)}</div>`:''}
          </div>`;
        }).join('')
      }
    </div>`;
}

function openAddDocModal(staffId) {
  hrModal('Add Document',`
    <div class="hr-edit-row"><label class="hr-edit-label">Document type *</label>
      <select class="hr-edit-input" id="docType">
        ${HR_DOC_TYPES.map(t=>`<option value="${t}">${t}</option>`).join('')}
      </select>
    </div>
    <div class="hr-edit-row"><label class="hr-edit-label">Notes</label>
      <input class="hr-edit-input" id="docNotes" type="text" placeholder="Optional details">
    </div>
    <div class="hr-edit-row"><label class="hr-edit-label">Expiry date</label>
      <input class="hr-edit-input" id="docExpiry" type="date">
    </div>
    <div class="hr-edit-row"><label class="hr-edit-label">File link (URL)</label>
      <input class="hr-edit-input" id="docLink" type="url" placeholder="https://drive.google.com/...">
    </div>
  `,async function(){
    const docType=document.getElementById('docType').value;
    const r=await api('addHRDocument',{userId:currentUser?.userId,staffId,
      document_type:docType,
      notes:document.getElementById('docNotes').value||null,
      expiry_date:document.getElementById('docExpiry').value||null,
      file_link:document.getElementById('docLink').value||null
    });
    if(!r.ok){showToast('Error: '+(r.error||'Failed'),'error');return false;}
    showToast('Document saved ✅','success');
    if(_hrSelected?.id===staffId) await loadHRTab(_hrSelected,'documents');
  });
}

function openAddIncidentModal(staffId) {
  hrModal('File Incident Report',`
    <div class="hr-edit-row"><label class="hr-edit-label">Type *</label>
      <select class="hr-edit-input" id="incType">
        ${Object.keys(HR_INCIDENT_STYLE).map(t=>`<option value="${t}">${HR_INCIDENT_STYLE[t].icon} ${t.replace('_',' ')}</option>`).join('')}
      </select>
    </div>
    <div class="hr-edit-row"><label class="hr-edit-label">Date *</label>
      <input class="hr-edit-input" id="incDate" type="date" value="${new Date().toISOString().split('T')[0]}">
    </div>
    <div class="hr-edit-row"><label class="hr-edit-label">Description *</label>
      <textarea class="hr-edit-input" id="incDesc" rows="3" placeholder="Describe what happened..."></textarea>
    </div>
    <div class="hr-edit-row"><label class="hr-edit-label">Action taken</label>
      <textarea class="hr-edit-input" id="incAction" rows="2" placeholder="What was done / verbal warning / written warning..."></textarea>
    </div>
  `,async function(){
    const desc=document.getElementById('incDesc').value.trim();
    if(!desc){showToast('Description required','error');return false;}
    const r=await api('addHRIncident',{userId:currentUser?.userId,staffId,
      incident_type:document.getElementById('incType').value,
      incident_date:document.getElementById('incDate').value,
      description:desc,
      action_taken:document.getElementById('incAction').value||null
    });
    if(!r.ok){showToast('Error: '+(r.error||'Failed'),'error');return false;}
    showToast('Incident report filed ✅','success');
    if(_hrSelected?.id===staffId) await loadHRTab(_hrSelected,'documents');
  });
}

// ── SCHEDULE TAB ───────────────────────────────────────────────────────────
function renderScheduleTab(s) {
  const DAYS=['MON','TUE','WED','THU','FRI','SAT','SUN'];
  return `
    <div class="hr-section">
      <div class="hr-section-title">Weekly Schedule</div>
      <div class="hr-week-grid">
        ${DAYS.map(d=>`<div class="hr-day-col">
          <div class="hr-day-label">${d}</div>
          <div class="hr-day-slot">—</div>
        </div>`).join('')}
      </div>
      <div class="hr-empty-sm" style="margin-top:12px">No schedule set. <button class="hr-link-btn">+ Create schedule</button></div>
    </div>`;
}

// ── PAYROLL TAB ───────────────────────────────────────────────────────────
// Payroll cutoff selector + computed detail for the selected staff member.
let _hrCutoffs=[], _hrCutoffId=null, _hrPayRow=null;

async function loadPayrollTab(s,tc) {
  const cs = await api('hrListCutoffs', {userId:currentUser?.userId});
  _hrCutoffs = cs.cutoffs||[];
  if(!_hrCutoffId || !_hrCutoffs.some(c=>c.id===_hrCutoffId)) _hrCutoffId = _hrCutoffs[0]?.id || null;
  tc.innerHTML = '<div class="hr-section"><div class="hr-empty-sm">Loading payroll…</div></div>';
  await renderPayrollSection(s, tc);
}

async function renderPayrollSection(s, tc){
  if(!_hrCutoffs.length){
    tc.innerHTML = '<div class="hr-section"><div class="hr-section-title">🧮 Payroll</div>'
      + '<div class="hr-empty-sm">No payroll cut-offs exist yet.</div></div>';
    return;
  }
  const [pr, br] = await Promise.all([
    _hrCutoffId ? api('hrGetPayroll',{userId:currentUser?.userId,cutoffId:_hrCutoffId}) : Promise.resolve({rows:[],deductions:[]}),
    _hrCutoffId ? api('hrPayrollDaily',{userId:currentUser?.userId,cutoffId:_hrCutoffId,staffId:s.id}) : Promise.resolve({days:[]}),
  ]);
  const cut = _hrCutoffs.find(c=>c.id===_hrCutoffId)||{};
  const mine = (pr.rows||[]).find(r=>r.staff_id===s.id);
  _hrPayRow = mine || null;
  const myDeds = (pr.deductions||[]).filter(d=>d.staff_id===s.id);

  const opts = _hrCutoffs.map(c=>`<option value="${c.id}"${c.id===_hrCutoffId?' selected':''}>`
    + `${esc(c.cutoff_name)} · ${c.payroll_status}</option>`).join('');

  const money = v => hrPeso(parseFloat(v||0));
  const N = v => parseFloat(v||0);
  const R2 = v => Math.round(v*100)/100;
  const rate0 = N(((br.days||[])[0]||{}).hourly_rate);
  const otRate = R2(rate0*1.25), ndRate = R2(rate0*0.10);
  // Contiguous runs of days on the same hourly rate, e.g. 62.50 (09-03–09-15) → 75.00 (09-16–09-30)
  const rateSpans = [];
  (br.days||[]).forEach(x=>{ const rt=N(x.hourly_rate); const last=rateSpans[rateSpans.length-1];
    if(last && last.rate===rt) last.to=x.work_date; else rateSpans.push({rate:rt,from:x.work_date,to:x.work_date}); });
  const rateCap = (mult, suffix) => rateSpans.length>1
    ? rateSpans.map(x=>money(R2(x.rate*mult))+' from '+x.from.slice(5)).join(' · ')+'/h'+suffix
    : '@ '+money(R2(rate0*mult))+'/h'+suffix;
  let totHrs=0, totOt=0, totPay=0, totUt=0, totNd=0, totNdPay=0, totNdPaid=0;
  let totWorked=0, totRegPay=0, totOtPaid=0, totOtPay=0, totNdPayPaid=0, totBrkMin=0;
  const hm = mins => { mins=Math.round(mins); const h=Math.floor(mins/60), m=mins%60; return h ? h+'h '+(m?m+'m':'') : m+'m'; };
  const dayRows = (br.days||[]).length ? (br.days||[]).map(function(x){
    var rate = N(x.hourly_rate), reg = N(x.regular_hours), ot = N(x.ot_hours), otPaid = N(x.ot_paid_hours);
    var nd = N(x.night_hours), ndPaid = N(x.nd_paid_hours), ut = N(x.undertime_hours), worked = N(x.worked_hours);
    var regPay = R2(reg*rate), otPay = R2(otPaid*rate*1.25), ndPay = R2(ndPaid*rate*0.10);
    totHrs += reg; totOt += ot; totPay += N(x.day_pay); totNdPaid += ndPaid; totUt += ut; totNd += nd;
    totNdPay += N(x.night_diff_suggested); totWorked += worked; totRegPay += regPay; totOtPaid += otPaid;
    totOtPay += otPay; totNdPayPaid += ndPay; totBrkMin += N(x.break_mins);
    var rowBg = x.is_holiday ? '#fff7ed' : '';
    var td = (v, style, title) => `<td style="padding:5px 7px;text-align:right${style||''}"${title?` title="${esc(title)}"`:''}>${v}</td>`;
    var grey = ';color:#9ca3af';
    // A typed-in time is shown on amber with ✎ and can be undone; a tap cannot.
    var manualStyle = 'background:#fef3c7;color:#92400e;border-radius:4px;padding:1px 5px;font-weight:700';
    var manual = (label, evType) => `<a href="#" onclick="openEditTimeModal('${s.id}',{date:'${esc(x.work_date)}',event:'${evType}',which:'${evType==='CLOCK_IN'?'first':'last'}',current:'${label}'});return false" style="${manualStyle};text-decoration:none" title="${esc('Entered manually: '+(x.manual_note||'')+' — click to correct')}">✎ ${label}</a> <a href="#" onclick="removeManualEntry('${s.id}','${esc(x.work_date)}','${evType}');return false" title="Remove this manual entry" style="font-size:.62rem;color:#b91c1c;text-decoration:none">✕</a>`;
    return `<tr${rowBg?' style="background:'+rowBg+'"':''}>
      <td style="padding:5px 7px">${esc(x.work_date)}${x.is_holiday?` <span title="${esc(x.holiday_name||'')}" style="font-size:.58rem;font-weight:700;background:#ffedd5;color:#c2410c;padding:1px 5px;border-radius:20px">HOL</span>`:''}</td>
      <td style="padding:5px 7px">${x.clock_in ? (x.in_manual ? manual(esc(x.clock_in),'CLOCK_IN') : `<a href="#" onclick="openEditTimeModal('${s.id}',{date:'${esc(x.work_date)}',event:'CLOCK_IN',which:'first',current:'${esc(x.clock_in)}'});return false" title="Click to correct this time" style="color:inherit;text-decoration:none;border-bottom:1px dotted #9ca3af">${esc(x.clock_in)}</a>`) : '—'}</td>
      <td style="padding:5px 7px">${x.clock_out ? (x.out_manual ? manual(esc(x.clock_out),'CLOCK_OUT') : `<a href="#" onclick="openEditTimeModal('${s.id}',{date:'${esc(x.work_date)}',event:'CLOCK_OUT',which:'last',current:'${esc(x.clock_out)}'});return false" title="Click to correct this time" style="color:inherit;text-decoration:none;border-bottom:1px dotted #9ca3af">${esc(x.clock_out)}</a>`)
        : (x.assumed_out
            ? `<span style="color:#6b7280;font-style:italic" title="No time-out was tapped — assumed ${esc(x.assumed_out)} (10:00 PM policy, or the last tap if later). Hours are counted to then.">${esc(x.assumed_out)} <span style="font-size:.6rem;font-weight:700;background:#f1f5f9;color:#475569;padding:1px 5px;border-radius:20px;font-style:normal">AUTO</span></span> <a href="#" onclick="openManualClockModal('${s.id}',{date:'${esc(x.work_date)}',event:'CLOCK_OUT',taps:'${esc(('in '+(x.clock_in||'—')+(x.break_detail?' · breaks '+x.break_detail:'')+(x.break_end?' · last break end '+x.break_end:'')).replace(/'/g,''))}'});return false" style="font-size:.62rem;color:#1d4ed8;text-decoration:none;white-space:nowrap">set actual</a>`
            : `<span style="color:#b45309;font-weight:700" title="No time-out was tapped">—</span> <a href="#" onclick="openManualClockModal('${s.id}',{date:'${esc(x.work_date)}',event:'CLOCK_OUT',taps:'${esc(('in '+(x.clock_in||'—')+(x.break_detail?' · breaks '+x.break_detail:'')+(x.break_end?' · last break end '+x.break_end:'')).replace(/'/g,''))}'});return false" style="font-size:.62rem;color:#1d4ed8;text-decoration:none;white-space:nowrap">+ add time-out</a>`)}</td>
      ${x.break_manual
        ? `<td style="padding:5px 7px;text-align:right"><span style="${manualStyle}" title="${esc('Break entered manually: '+(x.manual_note||''))}">✎ ${N(x.break_mins)>0 ? hm(N(x.break_mins)) : '—'}</span></td>`
        : td(N(x.break_mins)>0 ? hm(N(x.break_mins)) : '—', N(x.break_mins)>0?'':grey, x.break_detail ? 'Breaks: '+x.break_detail+(N(x.break_count)>1?' ('+N(x.break_count)+' breaks)':'') : 'No break tapped')}
      ${td(worked.toFixed(2), '', 'Clock in → out minus breaks')}
      ${td(reg.toFixed(2), ';font-weight:700')}
      ${td(hrPeso(regPay), '')}
      ${td(ot>0?ot.toFixed(2):'—', ot>0?';color:#1d4ed8;font-weight:700':grey)}
      ${td(ot>0?(otPaid>0?hrPeso(otPay):'₱0'):'—', otPaid>0?';color:#1d4ed8;font-weight:700':grey, ot>0&&otPaid===0?'Not approved — '+hrPeso(R2(ot*otRate))+' if approved':(otPaid>0?otPaid.toFixed(2)+' h approved × '+hrPeso(otRate):''))}
      ${td(nd>0?nd.toFixed(2):'—', nd>0?';color:#6d28d9;font-weight:700':grey)}
      ${td(nd>0?(ndPaid>0?hrPeso(ndPay):'₱0'):'—', ndPaid>0?';color:#6d28d9;font-weight:700':grey, nd>0&&ndPaid===0?'Not approved — '+hrPeso(R2(nd*ndRate))+' if approved':(ndPaid>0?ndPaid.toFixed(2)+' h approved × '+hrPeso(ndRate):''))}
      ${td(ut>0?ut.toFixed(2):'—', ut>0?';color:#b45309;font-weight:700':grey)}
      ${td(hrPeso(N(x.day_pay)), ';font-weight:800')}
    </tr>`;
  }).join('') : '<tr><td colspan="13" style="padding:10px;color:#9ca3af;font-size:.75rem">No attendance in this cut-off</td></tr>';

  const dedRows = myDeds.length ? myDeds.map(d=>`<tr>
      <td style="padding:6px 8px">${esc(d.deduction_date||'—')}</td>
      <td style="padding:6px 8px">${esc(d.details||d.reason||d.deduction_type||'—')}</td>
      <td style="padding:6px 8px;text-align:right">${money(d.amount)}</td>
      <td style="padding:6px 8px;text-align:right;font-weight:700">${money(d.amount_deducted!=null?d.amount_deducted:d.amount)}</td>
      <td style="padding:6px 8px;text-align:right;color:#6b7280">${d.balance_after!=null?money(d.balance_after):'—'}</td>
    </tr>`).join('')
    : '<tr><td colspan="5" style="padding:10px;color:#9ca3af;font-size:.75rem">No deductions in this cut-off</td></tr>';

  tc.innerHTML = `
    <div class="hr-section">
      <div class="hr-section-title">🧮 Payroll</div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
        <select id="cutoffSel" onchange="_hrCutoffId=this.value;loadHRTab(_hrSelected,'payroll')"
          style="flex:1;min-width:220px;font-size:.82rem;padding:8px;border:1.5px solid #d8ddd5;border-radius:8px">${opts}</select>
        <button onclick="recomputePayroll()" style="font-size:.78rem;font-weight:700;background:#1f3d2b;color:#fff;border:none;border-radius:8px;padding:9px 14px;cursor:pointer">↻ Recompute</button>
      </div>
      <div style="font-size:.7rem;color:#6b7280;margin-bottom:10px">
        ${esc(cut.start_date||'')} → ${esc(cut.end_date||'')} · pay date ${esc(cut.pay_date||'—')}
      </div>
      ${(_hrSelected||{}).art82_exempt?`<div style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:8px;padding:9px 12px;margin-bottom:12px;font-size:.7rem;color:#475569">
        <b>Art. 82 exempt</b> — managerial employee or field personnel. Not entitled to overtime,
        night differential, holiday pay or service incentive leave. Hours are still recorded.
      </div>`:''}
      ${(totNd>0 && !(_hrSelected||{}).art82_exempt)?'':''}
      ${mine ? `
      <div class="hr-grid-2">
        <div class="hr-pay-card"><div class="hr-pay-label">GROSS PAY</div>
          <div class="hr-pay-amount">${money(mine.gross_pay)}</div>
          <div class="hr-pay-sub">${parseFloat(mine.approved_regular_hours||0)} reg hrs @ ${rateSpans.length>1 ? rateSpans.map(x=>money(x.rate)+'/hr ('+x.from.slice(5)+'–'+x.to.slice(5)+')').join(' → ') : money(mine.hourly_rate)+'/hr'}</div>
          <div class="hr-pay-sub" style="margin-top:3px">
            ${parseFloat(mine.approved_ot_hours||0)>0?`<span style="color:#1d4ed8;font-weight:700">OT ${parseFloat(mine.approved_ot_hours).toFixed(2)} hrs</span> `:''}
            ${parseFloat(mine.night_diff_hours||0)>0?`<span style="color:#6d28d9;font-weight:700">🌙 ND ${parseFloat(mine.night_diff_hours).toFixed(2)} hrs = ${money(mine.night_diff_pay)}</span> `:''}
            ${parseFloat(mine.undertime_minutes||0)>0?`<span style="color:#b45309;font-weight:700">⚠ Undertime ${(parseFloat(mine.undertime_minutes)/60).toFixed(2)} hrs</span>`:''}
            ${(parseFloat(mine.approved_ot_hours||0)===0&&parseFloat(mine.night_diff_hours||0)===0&&parseFloat(mine.undertime_minutes||0)===0)?'No OT, night differential or undertime':''}
          </div></div>
        <div class="hr-pay-card"><div class="hr-pay-label">NET PAY</div>
          <div class="hr-pay-amount" style="color:#15803d">${money(mine.net_pay)}</div>
          <div class="hr-pay-sub">after ${money(mine.total_deductions)} deductions</div>
          <div class="hr-pay-sub" style="margin-top:3px">
            ${parseFloat(mine.tips_share||0)>0?`Tips/SC ${money(mine.tips_share)} · `:''}
            ${parseFloat(mine.government_deduction||0)>0?`Gov't ${money(mine.government_deduction)} · `:''}
            ${parseFloat(mine.thirteenth_month_accrual||0)>0?`13th accrual ${money(mine.thirteenth_month_accrual)}`:'13th: not eligible'}
          </div></div>
      </div>
      <div style="font-size:.66rem;color:#9ca3af;margin:6px 0 14px">${esc(mine.notes||'')}</div>
      ` : '<div class="hr-empty-sm">Not computed for this cut-off yet — press Recompute.</div>'}

      <div class="hr-section-title" style="margin-top:14px">📅 Daily breakdown — how this was computed</div>
      <div style="overflow-x:auto;overflow-y:auto;max-height:420px;border:1px solid var(--mist,#e2e5df);border-radius:8px">
      <table style="width:100%;border-collapse:collapse;font-size:.72rem;white-space:nowrap">
        <thead><tr style="background:var(--mist-light,#f1f5f9);text-align:left">
          <th style="padding:5px 7px">DATE</th><th style="padding:5px 7px">IN</th><th style="padding:5px 7px">OUT</th>
          <th style="padding:5px 7px;text-align:right" title="Unpaid; hover a cell for the exact times">BREAK</th>
          <th style="padding:5px 7px;text-align:right" title="Clock in → out, minus breaks">HRS</th>
          <th style="padding:5px 7px;text-align:right">REG h</th>
          <th style="padding:5px 7px;text-align:right">REG ₱<div style="font-size:.58rem;font-weight:400;color:#6b7280">${rateCap(1,'')}</div></th>
          <th style="padding:5px 7px;text-align:right;color:#1d4ed8">OT h</th>
          <th style="padding:5px 7px;text-align:right;color:#1d4ed8">OT ₱<div style="font-size:.58rem;font-weight:400;color:#6b7280">${rateCap(1.25,' (×1.25)')}</div></th>
          <th style="padding:5px 7px;text-align:right;color:#6d28d9">ND h</th>
          <th style="padding:5px 7px;text-align:right;color:#6d28d9">ND ₱<div style="font-size:.58rem;font-weight:400;color:#6b7280">${rateCap(0.10,' (10%)')}</div></th>
          <th style="padding:5px 7px;text-align:right;color:#b45309">UT h</th>
          <th style="padding:5px 7px;text-align:right">DAY PAY</th>
        </tr></thead>
        <tbody>${dayRows}</tbody>
        <tfoot><tr style="border-top:2px solid #d8ddd5;font-weight:700">
          <td colspan="3" style="padding:7px">${(br.days||[]).length} day(s)</td>
          <td style="padding:7px;text-align:right" title="Total unpaid break time">${totBrkMin>0?hm(totBrkMin):'—'}</td>
          <td style="padding:7px;text-align:right">${totWorked.toFixed(2)}</td>
          <td style="padding:7px;text-align:right">${totHrs.toFixed(2)}</td>
          <td style="padding:7px;text-align:right">${money(totRegPay)}</td>
          <td style="padding:7px;text-align:right;color:#1d4ed8">${totOt.toFixed(2)}</td>
          <td style="padding:7px;text-align:right;color:#1d4ed8" title="${totOtPaid.toFixed(2)} h approved">${money(totOtPay)}</td>
          <td style="padding:7px;text-align:right;color:#6d28d9">${totNd>0?totNd.toFixed(2):'—'}</td>
          <td style="padding:7px;text-align:right;color:#6d28d9" title="${totNdPaid.toFixed(2)} h approved">${totNd>0?money(totNdPayPaid):'—'}</td>
          <td style="padding:7px;text-align:right;color:#b45309">${totUt>0?totUt.toFixed(2):'—'}</td>
          <td style="padding:7px;text-align:right;font-size:.85rem">${money(totPay)}</td></tr></tfoot>
      </table></div>
      <div style="font-size:.66rem;color:#6b7280;margin-top:6px">
        Click any IN / OUT time to correct it (reason required; the original stays in the audit) · <i>AUTO</i> = no time-out was tapped, so the day ends at 10:00 PM (or the last tap if later) — "set actual" replaces it · <span style="${'background:#fef3c7;color:#92400e;border-radius:4px;padding:0 5px;font-weight:700'}">✎ amber</span> = entered or corrected by an admin (hover for who and why; ✕ removes a typed entry) ·
        ${rateSpans.length>1 ? 'Rate changed inside this cut-off — each day is paid at the rate in force that day (see Pay tab › Rate history)' : 'Rate '+money(rate0)+'/h = daily rate ÷ '+N(((br.days||[])[0]||{}).standard_hours||8).toFixed(0)+' h'} · REG capped at ${N(((br.days||[])[0]||{}).standard_hours||8).toFixed(0)} h/day · OT and ND pay only on <u>approved</u> hours (grey ₱0 = not yet approved; hover for the value) · breaks unpaid · DAY PAY = REG ₱ + OT ₱ + ND ₱.
      </div>

      <div class="hr-section-title" style="margin-top:14px">💸 Deductions</div>
      <table style="width:100%;border-collapse:collapse;font-size:.76rem">
        <thead><tr style="background:var(--mist-light,#f1f5f9);text-align:left">
          <th style="padding:6px 8px">DATE</th><th style="padding:6px 8px">DETAILS</th>
          <th style="padding:6px 8px;text-align:right">AMOUNT</th>
          <th style="padding:6px 8px;text-align:right">DEDUCTED</th>
          <th style="padding:6px 8px;text-align:right">BALANCE</th>
        </tr></thead>
        <tbody>${dedRows}</tbody>
      </table>
      <button onclick="addDeductionDialog()" style="margin-top:10px;font-size:.78rem;font-weight:700;background:#fff;color:#1f3d2b;border:1.5px solid #d8ddd5;border-radius:8px;padding:8px 14px;cursor:pointer">+ Add deduction</button>
      ${(mine && !(_hrSelected||{}).art82_exempt && parseFloat(mine.actual_ot_hours||0) > parseFloat(mine.approved_ot_hours||0)) ? `
      <div style="background:#eff6ff;border:1.5px solid #bfdbfe;border-radius:8px;padding:10px 12px;margin-bottom:12px">
        <div style="font-size:.78rem;font-weight:700;color:#1d4ed8">
          ⏱ ${(parseFloat(mine.actual_ot_hours)-parseFloat(mine.approved_ot_hours||0)).toFixed(2)} hrs of overtime worked but not approved
        </div>
        <div style="font-size:.68rem;color:#475569;margin:3px 0 8px">
          Worked ${parseFloat(mine.actual_ot_hours).toFixed(2)} hrs · approved ${parseFloat(mine.approved_ot_hours||0).toFixed(2)} hrs.
          Only approved overtime is paid — worth ${money(( parseFloat(mine.actual_ot_hours)-parseFloat(mine.approved_ot_hours||0))*parseFloat(mine.hourly_rate||0)*1.25)} if approved.
        </div>
        <button onclick="decideOvertime(true)" style="font-size:.74rem;font-weight:700;background:#1d4ed8;color:#fff;border:none;border-radius:7px;padding:7px 13px;cursor:pointer">Approve overtime</button>
        <button onclick="decideOvertime(false)" style="font-size:.74rem;font-weight:700;background:#fff;color:#b91c1c;border:1.5px solid #fecaca;border-radius:7px;padding:7px 13px;margin-left:6px;cursor:pointer">Reject</button>
      </div>`:''}
      ${(mine && totNd - totNdPaid > 0.005 && !(_hrSelected||{}).art82_exempt) ? `
      <div style="background:#f5f3ff;border:1.5px solid #ddd6fe;border-radius:8px;padding:10px 12px;margin-bottom:12px">
        <div style="font-size:.78rem;font-weight:700;color:#6d28d9">
          🌙 ${(totNd-totNdPaid).toFixed(2)} hrs worked between 10:00 PM and 6:00 AM but not approved
        </div>
        <div style="font-size:.68rem;color:#475569;margin:3px 0 8px">
          Worked ${totNd.toFixed(2)} hrs · approved ${totNdPaid.toFixed(2)} hrs.
          Night differential is +10% of the hourly rate — worth ${money((totNd-totNdPaid)*parseFloat(mine.hourly_rate||0)*0.10)} if approved.
        </div>
        <button onclick="decideNightDiff(true)" style="font-size:.74rem;font-weight:700;background:#6d28d9;color:#fff;border:none;border-radius:7px;padding:7px 13px;cursor:pointer">Approve night differential</button>
        <button onclick="decideNightDiff(false)" style="font-size:.74rem;font-weight:700;background:#fff;color:#b91c1c;border:1.5px solid #fecaca;border-radius:7px;padding:7px 13px;margin-left:6px;cursor:pointer">Reject</button>
      </div>`:''}
      ${mine?`<button onclick="manualPayDialog()" style="margin-top:10px;margin-left:8px;font-size:.78rem;font-weight:700;background:#fff;color:#1f3d2b;border:1.5px solid #d8ddd5;border-radius:8px;padding:8px 14px;cursor:pointer">✎ Tips / premiums / gov't</button>`:''}
      ${mine?`<button onclick="printPayslip()" style="margin-top:10px;margin-left:8px;font-size:.78rem;font-weight:700;background:#1f3d2b;color:#fff;border:none;border-radius:8px;padding:9px 16px;cursor:pointer">🧾 Print payslip</button>`:''}
    </div>`;
}


// ── PAYSLIP ────────────────────────────────────────────────────────────────
// Opens a printable payslip the staff member keeps. Shows the full working —
// every day, the rate, and each deduction itemised — because a payslip the
// employee cannot verify is worth nothing in a dispute.
async function printPayslip(){
  const s=_hrSelected; if(!s||!_hrCutoffId) return;
  const [pr, br] = await Promise.all([
    api('hrGetPayroll',{userId:currentUser?.userId,cutoffId:_hrCutoffId}),
    api('hrPayrollDaily',{userId:currentUser?.userId,cutoffId:_hrCutoffId,staffId:s.id}),
  ]);
  const row=(pr.rows||[]).find(r=>r.staff_id===s.id);
  if(!row){ showToast('Compute payroll first','error'); return; }
  const deds=(pr.deductions||[]).filter(d=>d.staff_id===s.id);
  const cut=_hrCutoffs.find(c=>c.id===_hrCutoffId)||{};
  const days=br.days||[];
  const N=v=>parseFloat(v||0);
  const P=v=>N(v).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2});
  const stdH=N(s.standard_hours_per_day)||8;
  const totUt=days.reduce((a,x)=>a+N(x.undertime_hours),0);
  const totBrk=days.reduce((a,x)=>a+N(x.break_mins),0);
  const holDays=days.filter(x=>x.is_holiday);

  const earn=[
    ['Basic pay', `${N(row.approved_regular_hours).toFixed(2)} hrs \u00d7 ${P(row.hourly_rate)}`, row.regular_pay],
    ['Overtime',  N(row.approved_ot_hours)>0?`${N(row.approved_ot_hours).toFixed(2)} hrs \u00d7 1.25`:'', row.overtime_pay],
    ['Holiday premium','', row.holiday_pay],
    ['Rest day premium','', row.rest_day_pay],
    ['Night differential','', row.night_diff_pay],
    ['Allowances','', row.allowances],
    ['Incentives','', row.incentives],
    ['Tips / service charge','RA 11360 share', row.tips_share],
  ].filter(r=>N(r[2])>0);

  const govt=N(row.government_deduction);
  const dedLines=[];
  if(govt>0) dedLines.push(['Government contributions','SSS / PhilHealth / Pag-IBIG',govt]);
  deds.forEach(d=>dedLines.push([
    (d.deduction_type||'OTHER').replace(/_/g,' '),
    (d.details||d.reason||'')+(d.balance_after!=null?` \u00b7 balance ${P(d.balance_after)}`:''),
    d.amount_deducted!=null?d.amount_deducted:d.amount]));

  const eRows=earn.map(r=>`<tr><td>${esc(r[0])}<span class="m">${esc(r[1])}</span></td><td class="r">${P(r[2])}</td></tr>`).join('')
    || '<tr><td colspan="2" class="m">None</td></tr>';
  const dRows=dedLines.length?dedLines.map(r=>`<tr><td>${esc(r[0])}<span class="m">${esc(r[1])}</span></td><td class="r">${P(r[2])}</td></tr>`).join('')
    : '<tr><td colspan="2" class="m">None</td></tr>';

  // Every peso on the slip traces to an hour on this table: hours, then the
  // amount those hours earned, for regular / overtime / night differential.
  const R2=v=>Math.round(v*100)/100;
  let psReg=0, psOt=0, psNd=0;
  const psRates=[...new Set(days.map(x=>N(x.hourly_rate)))];
  const psMixed=psRates.length>1;
  const dayRows=days.map(x=>{
    const rate=N(x.hourly_rate), reg=N(x.regular_hours), otP=N(x.ot_paid_hours), ndP=N(x.nd_paid_hours);
    const regPay=R2(reg*rate), otPay=R2(otP*rate*1.25), ndPay=R2(ndP*rate*0.10);
    psReg+=regPay; psOt+=otPay; psNd+=ndPay;
    return `<tr${x.is_holiday?' class="hol"':''}>
    <td>${x.work_date.slice(5)}${x.is_holiday?' <b>H</b>':''}${psMixed?' <span style="color:#777">@₱'+P(rate)+'</span>':''}</td>
    <td>${x.clock_in||'-'}</td><td>${esc(x.break_detail||'-')}</td><td>${x.clock_out||(x.assumed_out?x.assumed_out+'*':'-')}</td>
    <td class="r">${N(x.worked_hours).toFixed(2)}</td>
    <td class="r">${reg.toFixed(2)}</td><td class="r">${P(regPay)}</td>
    <td class="r">${N(x.ot_hours)>0?N(x.ot_hours).toFixed(2):'-'}</td>
    <td class="r">${otP>0?otP.toFixed(2):'-'}</td><td class="r">${otPay>0?P(otPay):'-'}</td>
    <td class="r nd">${N(x.night_hours)>0?N(x.night_hours).toFixed(2):'-'}</td>
    <td class="r nd">${ndP>0?ndP.toFixed(2):'-'}</td><td class="r nd">${ndPay>0?P(ndPay):'-'}</td>
    <td class="r ut">${N(x.undertime_hours)>0?N(x.undertime_hours).toFixed(2):'-'}</td>
    <td class="r"><b>${P(x.day_pay)}</b></td></tr>`;}).join('');
  const totNd=days.reduce((a,x)=>a+N(x.night_hours),0);
  const totNdPay=days.reduce((a,x)=>a+N(x.night_diff_suggested),0);

  const ref='PS-'+(cut.end_date||'').replace(/-/g,'')+'-'+(s.staff_code||'').replace(/[^A-Z0-9]/gi,'');

  const w=window.open('','_blank','width=900,height=1100');
  w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${ref}</title><style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font:11.5px/1.45 "Helvetica Neue",Arial,sans-serif;color:#1a1a1a;background:#fff;padding:30px;max-width:800px;margin:0 auto}
  .top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2.5px solid #1f3d2b;padding-bottom:12px}
  .co{font-size:19px;font-weight:800;letter-spacing:-.3px;color:#1f3d2b}
  .coa{font-size:10px;color:#666;margin-top:2px}
  .doc{text-align:right}
  .doc h2{font-size:15px;letter-spacing:2.5px;color:#1f3d2b;font-weight:700}
  .doc .ref{font-size:9.5px;color:#777;margin-top:3px;font-family:ui-monospace,Menlo,monospace}
  .meta{display:grid;grid-template-columns:1fr 1fr;gap:0;border:1px solid #dcdcdc;border-radius:4px;margin:14px 0;overflow:hidden}
  .meta>div{padding:9px 12px}
  .meta>div:first-child{border-right:1px solid #dcdcdc;background:#fafafa}
  .fld{display:flex;justify-content:space-between;padding:2.5px 0;font-size:11px}
  .fld span:first-child{color:#777}
  .fld span:last-child{font-weight:600;text-align:right}
  .strip{display:grid;grid-template-columns:repeat(5,1fr);border:1px solid #dcdcdc;border-radius:4px;margin-bottom:14px;overflow:hidden}
  .strip>div{padding:8px 6px;text-align:center;border-right:1px solid #eee}
  .strip>div:last-child{border-right:none}
  .strip .k{font-size:8.5px;letter-spacing:.7px;color:#888;text-transform:uppercase}
  .strip .v{font-size:15px;font-weight:700;margin-top:2px}
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  .card{border:1px solid #dcdcdc;border-radius:4px;overflow:hidden}
  .card h3{font-size:9.5px;letter-spacing:1.2px;text-transform:uppercase;padding:7px 11px;background:#f4f6f4;color:#1f3d2b;border-bottom:1px solid #dcdcdc}
  .card table{width:100%;border-collapse:collapse}
  .card td{padding:6px 11px;border-bottom:1px solid #f2f2f2;vertical-align:top}
  .card tr:last-child td{border-bottom:none}
  .m{display:block;font-size:9.5px;color:#888;margin-top:1px}
  .r{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
  .sub{display:flex;justify-content:space-between;padding:8px 11px;background:#fafafa;border-top:1.5px solid #ddd;font-weight:700;font-size:11.5px}
  .net{display:flex;justify-content:space-between;align-items:center;background:#1f3d2b;color:#fff;border-radius:4px;padding:14px 18px;margin-top:14px}
  .net .l{font-size:11px;letter-spacing:2px;text-transform:uppercase;opacity:.85}
  .net .v{font-size:25px;font-weight:800;font-variant-numeric:tabular-nums}
  h4{font-size:9.5px;letter-spacing:1.2px;text-transform:uppercase;color:#1f3d2b;margin:16px 0 5px}
  .att{width:100%;border-collapse:collapse;font-size:10px}
  .att th{background:#f4f6f4;text-align:left;padding:5px 7px;font-size:8.5px;letter-spacing:.5px;color:#666;border-bottom:1px solid #dcdcdc}
  .att td{padding:4px 7px;border-bottom:1px solid #f4f4f4}
  .att tfoot td{font-weight:700;border-top:1.5px solid #bbb;background:#fafafa}
  .att .hol{background:#fffaf3}
  .att .ut{color:#b45309}
  .att .nd{color:#6d28d9}
  .note{font-size:9.5px;color:#666;line-height:1.6;margin-top:12px;padding:9px 11px;background:#fafafa;border-left:2.5px solid #d4d4d4;border-radius:0 3px 3px 0}
  .sig{display:grid;grid-template-columns:1fr 1fr;gap:50px;margin-top:32px}
  .sig .line{border-top:1px solid #333;padding-top:4px;font-size:9.5px;color:#666}
  .foot{margin-top:22px;padding-top:8px;border-top:1px solid #eee;font-size:8.5px;color:#999;display:flex;justify-content:space-between}
  @media print{body{padding:12mm;max-width:none} .noprint{display:none} .att{page-break-inside:auto}}
  </style></head><body>

  <div class="top">
    <div><div class="co">YANI GARDEN CAFE</div><div class="coa">Amadeo, Cavite, Philippines</div></div>
    <div class="doc"><h2>PAYSLIP</h2><div class="ref">${ref}</div></div>
  </div>

  <div class="meta">
    <div>
      <div class="fld"><span>Employee</span><span>${esc(s.full_name||'')}</span></div>
      <div class="fld"><span>Employee no.</span><span>${esc(s.staff_code||'-')}</span></div>
      <div class="fld"><span>Position</span><span>${esc((s.role||'-').replace(/_/g,' '))}</span></div>
      <div class="fld"><span>Employment</span><span>${esc(row.employment_type||'-')}</span></div>
    </div>
    <div>
      <div class="fld"><span>Pay period</span><span>${cut.start_date} to ${cut.end_date}</span></div>
      <div class="fld"><span>Pay date</span><span>${cut.pay_date||'-'}</span></div>
      <div class="fld"><span>Pay basis</span><span>${esc(row.pay_basis||'-')} \u00b7 ${P(row.daily_rate)}/day</span></div>
      <div class="fld"><span>Hourly rate</span><span>${P(row.hourly_rate)} (${stdH} hrs/day)</span></div>
    </div>
  </div>

  <div class="strip">
    <div><div class="k">Days</div><div class="v">${days.length}</div></div>
    <div><div class="k">Regular hrs</div><div class="v">${N(row.approved_regular_hours).toFixed(2)}</div></div>
    <div><div class="k">Overtime</div><div class="v" style="color:#1d4ed8">${N(row.approved_ot_hours).toFixed(2)}</div></div>
    <div><div class="k">Undertime</div><div class="v" style="color:${totUt>0?'#b45309':'#1a1a1a'}">${totUt.toFixed(2)}</div></div>
    <div><div class="k">Unpaid breaks</div><div class="v">${(totBrk/60).toFixed(1)}h</div></div>
  </div>

  <div class="cols">
    <div class="card"><h3>Earnings</h3><table>${eRows}</table>
      <div class="sub"><span>Gross pay</span><span>${P(row.gross_pay)}</span></div></div>
    <div class="card"><h3>Deductions</h3><table>${dRows}</table>
      <div class="sub"><span>Total deductions</span><span>${P(row.total_deductions)}</span></div></div>
  </div>

  <div class="net"><span class="l">Net pay</span><span class="v">PHP ${P(row.net_pay)}</span></div>

  <h4>Attendance detail</h4>
  <table class="att">
    <thead>
      <tr><th rowspan="2">DATE</th><th rowspan="2">IN</th><th rowspan="2">BREAKS</th><th rowspan="2">OUT</th>
        <th class="r" rowspan="2">WORKED<br>HRS</th>
        <th class="r" colspan="2" style="text-align:center">REGULAR (× ${psMixed?'day rate':'₱'+P(N(row.hourly_rate))})</th>
        <th class="r" colspan="3" style="text-align:center">OVERTIME (× ${psMixed?'day rate':'₱'+P(N(row.hourly_rate))} × 1.25)</th>
        <th class="r" colspan="3" style="text-align:center">NIGHT DIFF 10PM–6AM (× ${psMixed?'day rate':'₱'+P(N(row.hourly_rate))} × 10%)</th>
        <th class="r" rowspan="2">UT<br>HRS</th><th class="r" rowspan="2">DAY PAY</th></tr>
      <tr><th class="r">HRS</th><th class="r">PAY</th>
        <th class="r">WORKED</th><th class="r">APPROVED</th><th class="r">PAY</th>
        <th class="r">HRS</th><th class="r">APPROVED</th><th class="r">PAY</th></tr>
    </thead>
    <tbody>${dayRows}</tbody>
    <tfoot><tr><td colspan="4">${days.length} day(s)</td>
      <td class="r">${days.reduce((a,x)=>a+N(x.worked_hours),0).toFixed(2)}</td>
      <td class="r">${N(row.approved_regular_hours).toFixed(2)}</td><td class="r">${P(psReg)}</td>
      <td class="r">${N(row.actual_ot_hours).toFixed(2)}</td>
      <td class="r">${N(row.approved_ot_hours).toFixed(2)}</td><td class="r">${P(psOt)}</td>
      <td class="r">${totNd>0?totNd.toFixed(2):'-'}</td>
      <td class="r">${N(row.night_diff_hours)>0?N(row.night_diff_hours).toFixed(2):'-'}</td><td class="r">${psNd>0?P(psNd):'-'}</td>
      <td class="r">${totUt>0?totUt.toFixed(2):'-'}</td>
      <td class="r"><b>${P(N(row.regular_pay)+N(row.overtime_pay)+N(row.night_diff_pay))}</b></td></tr></tfoot>
  </table>

  <div class="note">
    <b>How this was computed.</b> ${psMixed ? 'The rate changed during this cut-off; each day is paid at the rate in force that day (shown beside the date).' : 'Hourly rate \u20b1'+P(N(row.hourly_rate))+' = daily rate \u20b1'+P(N(row.daily_rate))+' \u00f7 '+stdH+' hours.'}
    Worked hours = clock-in to clock-out minus tapped breaks (meal and rest breaks are unpaid).
    Regular pay = worked hours up to ${stdH} a day \u00d7 hourly rate.
    Overtime = hours beyond ${stdH} that were approved \u00d7 hourly rate \u00d7 1.25; unapproved overtime hours are listed but unpaid.
    Night differential = approved hours between 10:00 PM and 6:00 AM \u00d7 hourly rate \u00d7 10%.
    Day pay = regular + overtime + night differential. Undertime is the shortfall against the ${stdH}-hour standard day and is already reflected in the lower regular pay.
    ${days.some(x=>!x.clock_out&&x.assumed_out)?'<br><b>*</b> No time-out was recorded that day; the shift is taken to end at 10:00 PM (or the last recorded tap if later), per house policy.':''}
    ${holDays.length?`<br><b>H</b> marks a declared holiday (${holDays.map(x=>esc(x.holiday_name||x.work_date)).join(', ')}).${N(row.holiday_pay)>0?'':' No holiday premium has been applied.'}`:''}
    ${s.art82_exempt?'<br><b>Art. 82.</b> This employee is a managerial employee or field personnel and is not covered by the hours-of-work provisions — overtime, night differential, holiday pay and service incentive leave do not apply.':''}
    ${(!s.art82_exempt && holDays.length && N(row.holiday_pay)===0)?'<br>This establishment is a retail/service establishment regularly employing fewer than ten (10) workers and is exempt from regular holiday pay under Art. 94(a).':''}
    ${totNd>0
      ? (N(row.night_diff_pay)>0
          ? `<br><b>ND</b> = hours worked between 10:00 PM and 6:00 AM (${totNd.toFixed(2)} hrs this period), paid at +10% of the hourly rate.`
          : `<br><b>ND</b> = ${totNd.toFixed(2)} hrs worked between 10:00 PM and 6:00 AM. Night differential (${P(totNdPay)}) was not approved for this cut-off and is not included.`)
      : '<br>No hours were worked between 10:00 PM and 6:00 AM this period.'}
    ${govt>0?'':'<br>Government contributions (SSS, PhilHealth, Pag-IBIG) are not included in this computation.'}
    <br>Please review and raise any discrepancy with management within five (5) days of receipt.
  </div>

  <div class="sig">
    <div><div class="line">Prepared by \u00b7 Date</div></div>
    <div><div class="line">Received by \u00b7 ${esc(s.full_name||'')} \u00b7 Date</div></div>
  </div>

  <div class="foot"><span>${ref} \u00b7 Confidential</span>
    <span>Generated ${new Date().toLocaleString('en-PH')}</span></div>

  <div class="noprint" style="margin-top:22px;text-align:center">
    <button onclick="window.print()" style="padding:10px 26px;font-size:12px;font-weight:700;background:#1f3d2b;color:#fff;border:none;border-radius:5px;cursor:pointer">Print / Save as PDF</button>
  </div>
  </body></html>`);
  w.document.close();
  api('hrIssuePayslip',{userId:currentUser?.userId,staffId:s.id,cutoffId:_hrCutoffId});
}


async function decideOvertime(approve){
  const s=_hrSelected; if(!s||!_hrCutoffId) return;
  const note = prompt(approve ? 'Reason for approving this overtime (optional):'
                              : 'Reason for rejecting this overtime:') ;
  if(note===null) return;
  if(!approve && !note.trim()){ showToast('A reason is required to reject','error'); return; }
  const r=await api('hrOvertimeDecide',{userId:currentUser?.userId,staffId:s.id,
    cutoffId:_hrCutoffId, approve:approve, note:note});
  if(!r.ok){ showToast(r.error||'Failed','error'); return; }
  showToast(approve?'Overtime approved and payroll recomputed ✅':'Overtime rejected','success');
  await loadHRTab(_hrSelected,'payroll');
}

async function decideNightDiff(approve){
  const s=_hrSelected; if(!s||!_hrCutoffId) return;
  const note = prompt(approve ? 'Reason for approving this night differential (optional):'
                              : 'Reason for rejecting this night differential:') ;
  if(note===null) return;
  if(!approve && !note.trim()){ showToast('A reason is required to reject','error'); return; }
  const r=await api('hrNightDiffDecide',{userId:currentUser?.userId,staffId:s.id,
    cutoffId:_hrCutoffId, approve:approve, note:note});
  if(!r.ok){ showToast(r.error||'Failed','error'); return; }
  showToast(approve?'Night differential approved and payroll recomputed ✅':'Night differential rejected','success');
  await loadHRTab(_hrSelected,'payroll');
}

// Tips / premiums / gov't. Night differential is deliberately NOT here any
// more — it is approved per cut-off like overtime (decideNightDiff).
function manualPayDialog(){
  const s=_hrSelected; if(!s||!_hrCutoffId) return;
  const row=_hrPayRow||{};
  const f=(id,label,val,hint)=>`<div class="hr-edit-row"><label class="hr-edit-label">${label}</label>
      <input class="hr-edit-input" id="${id}" type="number" step="0.01" min="0" value="${parseFloat(val||0)||''}" placeholder="0.00">
      ${hint?`<div style="font-size:.62rem;color:#8a7a6a;margin-top:2px">${hint}</div>`:''}</div>`;
  hrModal('Tips / premiums / gov\'t — this cut-off', `
    ${f('mpTips','Tips / service charge share (₱)',row.tips_share,'RA 11360 — 85% of collected service charge, shared among staff')}
    ${f('mpHoliday','Holiday premium (₱)',row.holiday_pay,'Regular holiday worked = +100% of the day; special day worked = +30%')}
    ${f('mpRest','Rest-day premium (₱)',row.rest_day_pay,'Work on the scheduled rest day = +30%')}
    ${f('mpAllow','Allowances (₱)',row.allowances,'')}
    ${f('mpInc','Incentives (₱)',row.incentives,'')}
    ${f('mpGovt','Government contributions to deduct (₱)',row.government_deduction,'SSS / PhilHealth / Pag-IBIG employee share')}
    <div class="hr-edit-row"><label class="hr-edit-label">Reason / note</label>
      <input class="hr-edit-input" id="mpReason" type="text" placeholder="e.g. Sept 1–15 service charge share"></div>
  `, async function(){
    const v=id=>document.getElementById(id).value;
    const r=await api('hrSavePayrollManual',{userId:currentUser?.userId,staffId:s.id,cutoffId:_hrCutoffId,
      tipsShare:v('mpTips'), holidayPay:v('mpHoliday'), restDayPay:v('mpRest'),
      allowances:v('mpAllow'), incentives:v('mpInc'), governmentDeduction:v('mpGovt'),
      reason:v('mpReason')});
    if(!r.ok){ showToast(r.error||'Could not save','error'); return false; }
    showToast('Saved and payroll recomputed ✅','success');
    await loadHRTab(_hrSelected,'payroll');
  });
}

async function recomputePayroll(){
  if(!_hrCutoffId) return;
  showToast('Computing payroll…','info');
  const r = await api('hrComputePayroll',{userId:currentUser?.userId,cutoffId:_hrCutoffId});
  if(!r.ok){ showToast(r.error||'Computation failed','error'); return; }
  showToast('Payroll computed for '+(r.rows?.length||0)+' staff ✅','success');
  await loadHRTab(_hrSelected,'payroll');
}

function addDeductionDialog(){
  const s=_hrSelected; if(!s||!_hrCutoffId) return;
  hrModal('Add deduction', `
    <div class="hr-edit-row"><label class="hr-edit-label">Date</label>
      <input class="hr-edit-input" id="dedDate" type="date" value="${new Date().toISOString().slice(0,10)}"></div>
    <div class="hr-edit-row"><label class="hr-edit-label">Type</label>
      <select class="hr-edit-input" id="dedType">
        <option>CASH_ADVANCE</option><option>UNIFORM</option><option>LOAN</option>
        <option>CASH_SHORTAGE</option><option>OTHER</option></select></div>
    <div class="hr-edit-row"><label class="hr-edit-label">Details (required)</label>
      <input class="hr-edit-input" id="dedDetails" type="text" placeholder="e.g. Cash advance for transport"></div>
    <div class="hr-edit-row"><label class="hr-edit-label">Full amount</label>
      <input class="hr-edit-input" id="dedAmount" type="number" placeholder="2000"></div>
    <div class="hr-edit-row"><label class="hr-edit-label">Deduct this cut-off</label>
      <input class="hr-edit-input" id="dedTake" type="number" placeholder="500"></div>
  `, async function(){
    const det=(document.getElementById('dedDetails').value||'').trim();
    if(det.length<3){ showToast('Details are required','error'); return false; }
    const r=await api('hrAddDeduction',{userId:currentUser?.userId,staffId:s.id,cutoffId:_hrCutoffId,
      date:document.getElementById('dedDate').value, type:document.getElementById('dedType').value,
      details:det, amount:document.getElementById('dedAmount').value,
      amountDeducted:document.getElementById('dedTake').value});
    if(!r.ok){ showToast(r.error||'Failed','error'); return false; }
    showToast('Deduction added ✅','success');
    await loadHRTab(_hrSelected,'payroll');
  });
}

async function loadPayrollTabLegacy(s,tc) {
  const [h13, hols] = await Promise.all([
    api('hrCompute13thMonth', {userId:currentUser?.userId, year:new Date().getFullYear()}),
    api('hrGetHolidays', {userId:currentUser?.userId, year:new Date().getFullYear()})
  ]);

  const my13 = (h13.records||[]).find(r=>r.staff_id===s.id);
  const holidays = hols.holidays||[];

  tc.innerHTML = `
    <div class="hr-section">
      <div class="hr-section-title">🎄 13th Month Pay (${new Date().getFullYear()})</div>
      <div class="hr-pay-card" style="margin-bottom:10px">
        <div class="hr-pay-label">ESTIMATED 13TH MONTH</div>
        <div class="hr-pay-amount">${my13 ? hrPeso(my13.thirteenth_month_pay) : '—'}</div>
        <div class="hr-pay-sub">${my13 ? 'Based on ₱'+parseFloat(my13.daily_rate).toLocaleString('en-PH')+'/day × 26 days ÷ 12' : 'Set daily rate to compute'}</div>
      </div>
      <div style="font-size:.72rem;color:#6b7280;padding:8px 0">
        ⚖️ Per RA 8187: 13th month = Total basic salary paid for the year ÷ 12. Must be paid on or before Dec 24.
      </div>
    </div>

    <div class="hr-section">
      <div class="hr-section-title">📋 Government Deductions (2026 estimates)</div>
      <div class="hr-list-table">
        <div class="hr-table-hdr" style="grid-template-columns:2fr 1fr 1fr 1fr"><span>Contribution</span><span class="r">Employee</span><span class="r">Employer</span><span class="r">Total</span></div>
        ${[
          {n:'SSS',    ee:581.30, er:1208.70},
          {n:'PhilHealth', ee:parseFloat(s.daily_rate||0)*26*0.025, er:parseFloat(s.daily_rate||0)*26*0.025},
          {n:'PagIBIG', ee:100,   er:100},
        ].map(g=>`<div class="hr-table-row" style="grid-template-columns:2fr 1fr 1fr 1fr">
          <span style="font-weight:600">${g.n}</span>
          <span class="r hr-red">${hrPeso(g.ee)}</span>
          <span class="r" style="color:#6b7280">${hrPeso(g.er)}</span>
          <span class="r">${hrPeso(g.ee+g.er)}</span>
        </div>`).join('')}
      </div>
      <div style="font-size:.7rem;color:#6b7280;margin-top:8px">* SSS based on standard bracket. PhilHealth at 5% of basic (shared equally). PagIBIG minimum ₱100 each.</div>
    </div>

    <div class="hr-section">
      <div class="hr-section-title">📅 PH Holidays 2026 (${holidays.length} days)</div>
      <div class="hr-list-table">
        <div class="hr-table-hdr" style="grid-template-columns:1fr 2fr 1fr"><span>Date</span><span>Holiday</span><span class="r">Pay Rate</span></div>
        ${holidays.map(h=>{
          const isReg = h.holiday_type==='REGULAR_HOLIDAY';
          return `<div class="hr-table-row" style="grid-template-columns:1fr 2fr 1fr">
            <span class="hr-td-date">${hrDate(h.holiday_date)}</span>
            <span style="font-weight:${isReg?700:400}">${esc(h.holiday_name)}</span>
            <span class="r"><span class="hr-badge-sm" style="background:${isReg?'#fee2e2':'#fef9c3'};color:${isReg?'#991b1b':'#854d0e'}">${h.pay_multiplier}×</span></span>
          </div>`;
        }).join('')}
      </div>
    </div>`;
}

// ── Shared helper modal ────────────────────────────────────────────────────
function hrModal(title, body, onSave) {
  var ex=document.getElementById('hrModal2'); if(ex) ex.remove();
  const m=document.createElement('div');
  m.id='hrModal2';
  m.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px';
  m.innerHTML=`
    <div style="background:#fff;border-radius:16px;width:100%;max-width:460px;max-height:90vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.3)">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 18px 12px;border-bottom:0.5px solid #e5e7eb">
        <div style="font-size:.95rem;font-weight:700;color:#111">${title}</div>
        <button onclick="document.getElementById('hrModal2').remove()" style="width:28px;height:28px;border-radius:50%;border:none;background:#e5e7eb;cursor:pointer;font-size:.9rem">✕</button>
      </div>
      <div style="padding:18px;display:flex;flex-direction:column;gap:12px" id="hrModal2Body">${body}</div>
      <div style="display:flex;gap:10px;padding:0 18px 18px">
        <button onclick="document.getElementById('hrModal2').remove()" style="flex:1;padding:11px;border-radius:10px;border:1.5px solid #e5e7eb;background:#f9fafb;color:#374151;font-size:.82rem;font-weight:600;cursor:pointer">Cancel</button>
        <button id="hrModal2Save" style="flex:2;padding:11px;border-radius:10px;border:none;background:#1a3a2a;color:#fff;font-size:.82rem;font-weight:700;cursor:pointer">💾 Save</button>
      </div>
    </div>`;
  document.body.appendChild(m);
  m.addEventListener('click',function(e){if(e.target===m)m.remove();});
  document.getElementById('hrModal2Save').onclick=async function(){
    this.disabled=true; this.textContent='Saving...';
    const result=await onSave();
    if(result===false){this.disabled=false;this.textContent='Save';}
    else m.remove();
  };
}

// ── Toggle status ──────────────────────────────────────────────────────────
async function toggleHRStatus(id,currentStatus) {
  const s=_hrStaff.find(x=>x.id===id); if(!s) return;
  const newStatus=currentStatus==='ACTIVE'?'SUSPENDED':'ACTIVE';
  if(!confirm(`${newStatus==='ACTIVE'?'Activate':'Deactivate'} ${s.full_name}?`)) return;
  const r=await api('updateHRStaff',{userId:currentUser?.userId,staffId:id,employment_status:newStatus});
  if(!r.ok){showToast('Failed: '+(r.error||'Unknown error'),'error');return;}
  s.employment_status=newStatus;
  if(_hrSelected?.id===id) _hrSelected.employment_status=newStatus;
  renderHRStaffList();
  if(_hrSelected?.id===id) renderHRDetail(_hrSelected);
  showToast(s.full_name+' '+(newStatus==='ACTIVE'?'activated ✅':'deactivated'),'success');
}

// ── Add staff stub ─────────────────────────────────────────────────────────
function openAddStaffModal() {
  hrModal('Add New Staff',`
    <div class="hr-edit-row"><label class="hr-edit-label">Full name *</label><input class="hr-edit-input" id="nsName" type="text" placeholder="First Last"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="hr-edit-row"><label class="hr-edit-label">Role *</label>
        <select class="hr-edit-input" id="nsRole">
          ${Object.keys(HR_ROLE_STYLE).map(r=>`<option value="${r}">${HR_ROLE_STYLE[r].label}</option>`).join('')}
        </select>
      </div>
      <div class="hr-edit-row"><label class="hr-edit-label">Daily rate (₱)</label>
        <input class="hr-edit-input" id="nsRate" type="number" min="0" step="0.01">
      </div>
    </div>
    <div class="hr-edit-row"><label class="hr-edit-label">Phone</label><input class="hr-edit-input" id="nsPhone" type="text"></div>
  `,async function(){
    const name=document.getElementById('nsName').value.trim();
    if(!name){showToast('Name required','error');return false;}
    const r=await api('addHRStaff',{userId:currentUser?.userId,
      full_name:name,role:document.getElementById('nsRole').value,
      daily_rate:document.getElementById('nsRate').value||null,
      mobile:document.getElementById('nsPhone').value||null
    });
    if(!r.ok){showToast('Error: '+(r.error||'Failed'),'error');return false;}
    showToast(name+' added ✅','success');
    await loadHRModule();
  });
}

// ── Edit staff (full modal) ────────────────────────────────────────────────
async function openEditStaffModal(id) {
  const s=_hrStaff.find(x=>x.id===id); if(!s) return;
  // WAIT for profile before building modal so fields are pre-filled
  try {
    const pr = await api('getHRProfile',{userId:currentUser?.userId,staffId:id});
    if(pr.ok && pr.profile) {
      s._profile_sss  = pr.profile.sss_no        || '';
      s._profile_ph   = pr.profile.philhealth_no  || '';
      s._profile_pig  = pr.profile.pagibig_no     || '';
      s._profile_tin  = pr.profile.tin_no         || '';
    } else {
      s._profile_sss = s._profile_sss || '';
      s._profile_ph  = s._profile_ph  || '';
      s._profile_pig = s._profile_pig || '';
      s._profile_tin = s._profile_tin || '';
    }
  } catch(e) {}
  const ROLES=Object.keys(HR_ROLE_STYLE);
  const STATUSES=Object.keys(HR_STATUS_STYLE);
  hrModal('Edit Staff — '+esc(s.full_name),`
    <!-- ── Basic ── -->
    <div class="hef-section-label">👤 Basic Information</div>
    <div class="hr-edit-row"><label class="hr-edit-label">Full Name *</label><input class="hr-edit-input" id="hef_name" value="${esc(s.full_name||'')}"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="hr-edit-row"><label class="hr-edit-label">Nickname</label><input class="hr-edit-input" id="hef_nick" value="${esc(s.nickname||'')}"></div>
      <div class="hr-edit-row"><label class="hr-edit-label">Date of Birth</label><input class="hr-edit-input" id="hef_dob" type="date" value="${s.date_of_birth?s.date_of_birth.slice(0,10):''}"></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="hr-edit-row"><label class="hr-edit-label">Gender</label>
        <select class="hr-edit-input" id="hef_gender">
          <option value="">—</option>
          ${['MALE','FEMALE','OTHER'].map(g=>`<option value="${g}"${g===(s.gender||'')?' selected':''}>${g}</option>`).join('')}
        </select>
      </div>
      <div class="hr-edit-row"><label class="hr-edit-label">Civil Status</label>
        <select class="hr-edit-input" id="hef_civil">
          <option value="">—</option>
          ${['SINGLE','MARRIED','WIDOWED','SEPARATED'].map(g=>`<option value="${g}"${g===(s.civil_status||'')?' selected':''}>${g}</option>`).join('')}
        </select>
      </div>
    </div>
    <!-- ── Employment ── -->
    <div class="hef-section-label" style="margin-top:4px">💼 Employment</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="hr-edit-row"><label class="hr-edit-label">Role *</label>
        <select class="hr-edit-input" id="hef_role">${ROLES.map(r=>`<option value="${r}"${r===s.role?' selected':''}>${HR_ROLE_STYLE[r].label}</option>`).join('')}</select>
      </div>
      <div class="hr-edit-row"><label class="hr-edit-label">Status *</label>
        <select class="hr-edit-input" id="hef_status">${STATUSES.map(st=>`<option value="${st}"${st===s.employment_status?' selected':''}>${HR_STATUS_STYLE[st].label}</option>`).join('')}</select>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="hr-edit-row"><label class="hr-edit-label">Employment type</label>
        <select class="hr-edit-input" id="hef_emptype">
          ${['REGULAR','PROBATIONARY','PART_TIME','WORKING_STUDENT','RELIEVER','ON_CALL','TRAINEE'].map(t=>`<option value="${t}"${t===(s.employment_type||'REGULAR')?' selected':''}>${t.replace(/_/g,' ')}</option>`).join('')}
        </select>
      </div>
      <div class="hr-edit-row"><label class="hr-edit-label">Date Hired</label>
        <input class="hr-edit-input" id="hef_hired" type="date" value="${s.date_hired?s.date_hired.slice(0,10):''}">
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="hr-edit-row"><label class="hr-edit-label">Department</label><input class="hr-edit-input" id="hef_dept" value="${esc(s.department||'')}"></div>
      <div class="hr-edit-row"><label class="hr-edit-label">OT Allowed</label>
        <select class="hr-edit-input" id="hef_ot">
          <option value="false"${!s.overtime_allowed?' selected':''}>❌ No</option>
          <option value="true"${s.overtime_allowed?' selected':''}>✅ Yes</option>
        </select>
      </div>
    </div>
    <!-- ── Pay ── -->
    <div class="hef-section-label" style="margin-top:4px">💰 Pay</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="hr-edit-row"><label class="hr-edit-label">Pay basis</label>
        <select class="hr-edit-input" id="hef_basis">${['DAILY','HOURLY','MONTHLY'].map(p=>`<option value="${p}"${p===(s.pay_basis||'DAILY')?' selected':''}>${p}</option>`).join('')}</select>
      </div>
      <div class="hr-edit-row"><label class="hr-edit-label">Daily rate (₱)</label>
        <input class="hr-edit-input" id="hef_rate" type="number" min="0" step="0.01" value="${s.daily_rate||''}">
      </div>
    </div>
    <!-- ── Contact ── -->
    <div class="hef-section-label" style="margin-top:4px">📞 Contact</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="hr-edit-row"><label class="hr-edit-label">Phone</label><input class="hr-edit-input" id="hef_phone" value="${esc(s.mobile||'')}"></div>
      <div class="hr-edit-row"><label class="hr-edit-label">Email</label><input class="hr-edit-input" id="hef_email" type="email" value="${esc(s.email||'')}"></div>
    </div>
    <!-- ── Payout ── -->
    <div class="hef-section-label" style="margin-top:4px">💳 Payout</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="hr-edit-row"><label class="hr-edit-label">Method</label>
        <select class="hr-edit-input" id="hef_paymethod">
          <option value="">—</option>
          ${['CASH','GCASH','MAYA','BANK'].map(m=>`<option value="${m}"${m===(s.payout_method||'')?' selected':''}>${m}</option>`).join('')}
        </select>
      </div>
      <div class="hr-edit-row"><label class="hr-edit-label">GCash / Account No.</label>
        <input class="hr-edit-input" id="hef_paydetail" value="${esc(s.payout_details||'')}" placeholder="09XX XXX XXXX">
      </div>
    </div>
    <!-- ── Government ── -->
    <div class="hef-section-label" style="margin-top:4px">🏛️ Government Numbers</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="hr-edit-row"><label class="hr-edit-label">SSS No.</label><input class="hr-edit-input" id="hef_sss" value="${esc(s._profile_sss||'')}" placeholder="00-0000000-0"></div>
      <div class="hr-edit-row"><label class="hr-edit-label">PhilHealth No.</label><input class="hr-edit-input" id="hef_ph" value="${esc(s._profile_ph||'')}" placeholder="00-000000000-0"></div>
      <div class="hr-edit-row"><label class="hr-edit-label">PagIBIG No.</label><input class="hr-edit-input" id="hef_pig" value="${esc(s._profile_pig||'')}" placeholder="0000-0000-0000"></div>
      <div class="hr-edit-row"><label class="hr-edit-label">TIN</label><input class="hr-edit-input" id="hef_tin" value="${esc(s._profile_tin||'')}" placeholder="000-000-000-000"></div>
    </div>
    <!-- ── Notes ── -->
    <div class="hr-edit-row" style="margin-top:4px"><label class="hr-edit-label">Notes</label><textarea class="hr-edit-input" id="hef_notes" rows="2">${esc(s.notes||'')}</textarea></div>
  `,async function(){
    const name=document.getElementById('hef_name').value.trim();
    if(!name){showToast('Name required','error');return false;}
    const gv=function(id){return document.getElementById(id)?.value?.trim()||null;};
    const upd={
      full_name:name, nickname:gv('hef_nick'),
      role:gv('hef_role'), employment_status:gv('hef_status'),
      employment_type:gv('hef_emptype'),
      pay_basis:gv('hef_basis'),
      daily_rate:parseFloat(gv('hef_rate'))||null,
      mobile:gv('hef_phone'), email:gv('hef_email'),
      department:gv('hef_dept'), notes:gv('hef_notes'),
      overtime_allowed: document.getElementById('hef_ot')?.value==='true',
      date_hired:gv('hef_hired'), date_of_birth:gv('hef_dob'),
      gender:gv('hef_gender'), civil_status:gv('hef_civil'),
      payout_method:gv('hef_paymethod'), payout_details:gv('hef_paydetail'),
      // profile fields
      _sss:gv('hef_sss'), _ph:gv('hef_ph'), _pig:gv('hef_pig'), _tin:gv('hef_tin'),
    };
    const r=await api('updateHRStaff',{userId:currentUser?.userId,staffId:id,...upd});
    if(!r.ok){showToast('Error: '+(r.error||'Failed'),'error');return false;}
    Object.assign(s,upd); if(_hrSelected?.id===id) Object.assign(_hrSelected,upd);
    renderHRStaffList();
    if(_hrSelected?.id===id) renderHRDetail(_hrSelected);
    showToast(name+' updated ✅','success');
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────
function printHRQR(qrToken, name, staffCode) {
  var url = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data='+encodeURIComponent('YANI-CLOCKIN:'+qrToken)+'&bgcolor=ffffff&color=1a3a2a&margin=8';
  var w = window.open('','_blank','width=400,height=500');
  w.document.write('<html><body style="text-align:center;font-family:sans-serif;padding:20px">'+
    '<h2 style="color:#1a3a2a;margin:0 0 4px">YANI Garden Cafe</h2>'+
    '<p style="margin:0 0 12px;font-size:.85rem;color:#555">Employee Clock-in QR Code</p>'+
    '<img src="'+url+'" style="width:200px;height:200px;display:block;margin:0 auto 12px">'+
    '<div style="font-size:1.1rem;font-weight:700;color:#1a3a2a">'+name+'</div>'+
    '<div style="font-size:.85rem;color:#555;margin-top:4px">'+(staffCode||'')+'</div>'+
    '<button onclick="window.print()" style="margin-top:16px;padding:8px 20px;background:#1a3a2a;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:.9rem">🖨️ Print</button>'+
    '</body></html>');
  w.document.close();
}

function hf(label,value){return`<div class="hr-field"><div class="hr-field-label">${esc(label)}</div><div class="hr-field-value">${esc(String(value??'—'))}</div></div>`;}

// Row badges for the staff list. Shows what needs DOING (missing PIN or QR)
// and where the person is right now — never their pay, which was previously
// printed next to every name on a screen visible from the counter.
function hrRowBadges(s){
  var out=[];
  if(s.employment_status==='ACTIVE'){
    // A QR always exists — the generator falls back to encoding the staff code,
    // and lookup accepts that. What matters is whether it is a ROTATABLE token:
    // a staff-code QR cannot be invalidated if someone photographs it.
    if(!s.has_qr)  out.push(['Legacy QR','#fef3c7','#b45309','QR encodes the staff code and cannot be invalidated. Regenerate to get a rotatable token.']);
    // PIN is only needed for manual code entry and the employee portal —
    // scanning on the kiosk works without one.
    if(!s.has_pin) out.push(['No PIN','#f1f5f9','#64748b','No attendance PIN. Scanning still works; typing the staff code does not.']);
    if(s.art82_exempt) out.push(['Art.82','#f1f5f9','#475569','Managerial / field personnel — no OT, night differential, holiday pay or SIL entitlement']);
    if(s.clock_state==='IN')    out.push(['In','#dcfce7','#15803d','Clocked in']);
    if(s.clock_state==='BREAK') out.push(['Break','#ffedd5','#c2410c','On break']);
  }
  if(!out.length) return '';
  return ' ' + out.map(function(b){
    return '<span title="'+b[3]+'" style="font-size:.58rem;font-weight:700;padding:1px 6px;'
      + 'border-radius:20px;background:'+b[1]+';color:'+b[2]+';margin-left:4px;white-space:nowrap">'+b[0]+'</span>';
  }).join('');
}

