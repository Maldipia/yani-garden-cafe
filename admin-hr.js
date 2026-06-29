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
  if(!list.length) { el.innerHTML='<div class="hr-list-empty">No staff found</div>'; return; }
  el.innerHTML=list.map(s=>{
    const rs=HR_ROLE_STYLE[s.role]||HR_ROLE_STYLE.STAFF;
    const ss=HR_STATUS_STYLE[s.employment_status]||HR_STATUS_STYLE.ACTIVE;
    const sel=_hrSelected&&_hrSelected.id===s.id;
    return `<div class="hr-staff-card${sel?' selected':''}" onclick="selectHRStaff('${s.id}')">
      <div class="hr-avatar" style="background:${rs.bg};color:${rs.fg}">${(s.full_name||'?').charAt(0).toUpperCase()}</div>
      <div class="hr-card-info">
        <div class="hr-card-name">${esc(s.full_name||'—')}</div>
        <div class="hr-card-sub">${esc(s.role||'')}${s.daily_rate?' · ₱'+parseFloat(s.daily_rate).toLocaleString('en-PH'):''}</div>
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
  const dc=document.getElementById('hrDetailCol');
  if(dc&&window.innerWidth<768) dc.scrollIntoView({behavior:'smooth'});
}

// ── Detail panel ───────────────────────────────────────────────────────────
function renderHRDetail(s) {
  const el=document.getElementById('hrDetailContent');
  if(!el||!s) return;
  const rs=HR_ROLE_STYLE[s.role]||HR_ROLE_STYLE.STAFF;
  const age=s.date_of_birth?Math.floor((Date.now()-new Date(s.date_of_birth))/31557600000):'';
  el.innerHTML=`
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
      case 'profile':    tc.innerHTML=renderProfileTab(s); break;
      case 'pay':        tc.innerHTML=renderPayTab(s); break;
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
    <div class="hr-section">
      <div class="hr-section-title">Government Numbers
        <span style="font-size:.65rem;color:#5a4a3a;font-weight:400">(fill via Edit)</span>
      </div>
      <div class="hr-grid-2">
        ${hf('SSS','—')} ${hf('PhilHealth','—')} ${hf('PagIBIG','—')} ${hf('TIN','—')}
      </div>
    </div>
    <div class="hr-section">
      <div class="hr-section-title">🔲 Employee QR Code
        <span style="font-size:.65rem;color:#5a4a3a;font-weight:400">— for clock-in/out</span>
      </div>
      <div style="display:flex;align-items:flex-start;gap:16px;background:#f0fdf4;border-radius:10px;padding:14px">
        <img src="https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent('YANI-CLOCKIN:'+s.staff_code)}&bgcolor=ffffff&color=1a3a2a&margin=4"
          style="width:90px;height:90px;border-radius:8px;border:2px solid #1a3a2a;flex-shrink:0"
          alt="QR Code for ${esc(s.staff_code)}">
        <div>
          <div style="font-size:.82rem;font-weight:700;color:#111;margin-bottom:4px">${esc(s.full_name||'—')}</div>
          <div style="font-size:.75rem;color:#5a4a3a;margin-bottom:8px">${esc(s.staff_code||'')} · ${esc(s.role||'')}</div>
          <div style="font-size:.7rem;color:#5a4a3a;margin-bottom:8px;line-height:1.5">Staff scans this QR to clock in/out.<br>Encodes: <code style="background:#e5e7eb;padding:1px 5px;border-radius:4px">YANI-CLOCKIN:${esc(s.staff_code||'')}</code></div>
          <button onclick="printHRQR('${esc(s.staff_code||'')}','${esc(s.full_name||'')}')" style="font-size:.72rem;background:#1a3a2a;color:#fff;border:none;border-radius:8px;padding:5px 12px;cursor:pointer">🖨️ Print QR</button>
        </div>
      </div>
    </div>`;
}

function renderPayTab(s) {
  const rate=s.daily_rate?hrPeso(s.daily_rate):'Not set';
  const monthly=s.daily_rate?hrPeso(parseFloat(s.daily_rate)*26):'—';
  return `
    <div class="hr-section">
      <div class="hr-pay-card">
        <div class="hr-pay-label">DAILY RATE</div>
        <div class="hr-pay-amount">${rate}</div>
        <div class="hr-pay-sub">Est. monthly (26 days): ${monthly}</div>
      </div>
      <div class="hr-grid-2" style="margin-top:10px">
        ${hf('Pay basis',s.pay_basis||'DAILY')}
        ${hf('Hourly rate',s.hourly_rate?hrPeso(s.hourly_rate)+'/hr':'Auto (÷8)')}
        ${hf('Std hrs/day',s.standard_hours_per_day||8)}
        ${hf('OT allowed',s.overtime_allowed?'✅ Yes':'❌ No')}
      </div>
    </div>
    <div class="hr-section">
      <div class="hr-section-title">Payroll History</div>
      <div class="hr-empty-sm">No payroll runs yet. Will appear once payroll is processed.</div>
    </div>`;
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
async function loadClockTab(s,tc) {
  const r=await api('getHRTimeLogs',{userId:currentUser?.userId,staffId:s.id,limit:14});
  const logs=r.logs||[];
  const EVENT_COLOR={CLOCK_IN:'#dcfce7',CLOCK_OUT:'#fee2e2',BREAK_START:'#fef9c3',BREAK_END:'#fef3c7',BROKEN_TIME_START:'#e0f2fe',BROKEN_TIME_END:'#dbeafe'};
  tc.innerHTML=`
    <div class="hr-section">
      <div class="hr-section-hdr">
        <div class="hr-section-title">⏱ Recent Clock Events</div>
        <button class="hr-action-btn hr-btn-primary" onclick="openManualClockModal('${s.id}')">+ Manual Entry</button>
      </div>
      ${logs.length===0
        ?'<div class="hr-empty-sm">No clock-in records yet. Staff must clock in via the employee portal or manual entry.</div>'
        :`<div class="hr-list-table">
          <div class="hr-table-hdr"><span>Date</span><span>Time</span><span>Event</span><span>Source</span></div>
          ${logs.map(l=>{ const bg=EVENT_COLOR[l.event_type]||'#f3f4f6';
            return `<div class="hr-table-row">
              <span class="hr-td-date">${hrDate(l.log_date)}</span>
              <span>${l.event_time?new Date(l.event_time).toLocaleTimeString('en-PH',{hour:'2-digit',minute:'2-digit'}):'—'}</span>
              <span><span class="hr-badge-sm" style="background:${bg};color:#1a1a1a">${esc(l.event_type||'').replace(/_/g,' ')}</span></span>
              <span style="font-size:.7rem;color:#5a4a3a">${esc(l.attendance_source||'MANUAL')}</span>
            </div>`;
          }).join('')}
        </div>`
      }
    </div>`;
}

function openManualClockModal(staffId) {
  const now=new Date();
  hrModal('Manual Clock Entry',`
    <div class="hr-edit-row"><label class="hr-edit-label">Event type *</label>
      <select class="hr-edit-input" id="clkEvent">
        <option value="CLOCK_IN">Clock In</option>
        <option value="CLOCK_OUT">Clock Out</option>
        <option value="BREAK_START">Break Start</option>
        <option value="BREAK_END">Break End</option>
      </select>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="hr-edit-row"><label class="hr-edit-label">Date *</label><input class="hr-edit-input" id="clkDate" type="date" value="${now.toISOString().split('T')[0]}"></div>
      <div class="hr-edit-row"><label class="hr-edit-label">Time *</label><input class="hr-edit-input" id="clkTime" type="time" value="${now.toTimeString().slice(0,5)}"></div>
    </div>
    <div class="hr-edit-row"><label class="hr-edit-label">Notes</label>
      <input class="hr-edit-input" id="clkNotes" type="text" placeholder="Optional note">
    </div>
  `,async function(){
    const date=document.getElementById('clkDate').value;
    const time=document.getElementById('clkTime').value;
    if(!date||!time){showToast('Date and time required','error');return false;}
    const eventTime=new Date(date+'T'+time).toISOString();
    // Insert directly
    const r=await api('addHRTimeLog',{userId:currentUser?.userId,staffId,
      event_type:document.getElementById('clkEvent').value,
      log_date:date,event_time:eventTime,
      attendance_source:'MANUAL',
      notes:document.getElementById('clkNotes').value||null
    });
    showToast('Clock entry saved ✅','success');
    if(_hrSelected?.id===staffId) await loadHRTab(_hrSelected,'clock');
  });
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
async function loadPayrollTab(s,tc) {
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
function openEditStaffModal(id) {
  const s=_hrStaff.find(x=>x.id===id); if(!s) return;
  // Load profile data if not already loaded
  api('getHRProfile',{userId:currentUser?.userId,staffId:id}).then(function(r){
    if(r.ok&&r.profile) {
      s._profile_sss=r.profile.sss_no||'';
      s._profile_ph=r.profile.philhealth_no||'';
      s._profile_pig=r.profile.pagibig_no||'';
      s._profile_tin=r.profile.tin_no||'';
    }
  }).catch(function(){});
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
function printHRQR(staffCode, name) {
  var url = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data='+encodeURIComponent('YANI-CLOCKIN:'+staffCode)+'&bgcolor=ffffff&color=1a3a2a&margin=8';
  var w = window.open('','_blank','width=400,height=500');
  w.document.write('<html><body style="text-align:center;font-family:sans-serif;padding:20px">'+
    '<h2 style="color:#1a3a2a;margin:0 0 4px">YANI Garden Cafe</h2>'+
    '<p style="margin:0 0 12px;font-size:.85rem;color:#555">Employee Clock-in QR Code</p>'+
    '<img src="'+url+'" style="width:200px;height:200px;display:block;margin:0 auto 12px">'+
    '<div style="font-size:1.1rem;font-weight:700;color:#1a3a2a">'+name+'</div>'+
    '<div style="font-size:.85rem;color:#555;margin-top:4px">'+staffCode+'</div>'+
    '<button onclick="window.print()" style="margin-top:16px;padding:8px 20px;background:#1a3a2a;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:.9rem">🖨️ Print</button>'+
    '</body></html>');
  w.document.close();
}

function hf(label,value){return`<div class="hr-field"><div class="hr-field-label">${esc(label)}</div><div class="hr-field-value">${esc(String(value??'—'))}</div></div>`;}
