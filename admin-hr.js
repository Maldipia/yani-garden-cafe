// admin-hr.js — YANI HR Module v1
// Employee management, clock-in, payroll prep, leave, announcements
'use strict';

// ── Color maps ────────────────────────────────────────────────────────────
const HR_ROLE_STYLE = {
  OWNER:          { bg:'#1a3a2a', fg:'#a8d8a8', label:'Owner' },
  MANAGER:        { bg:'#1e3a5f', fg:'#93c5fd', label:'Manager' },
  PAYROLL_ADMIN:  { bg:'#3b1f5e', fg:'#c4b5fd', label:'Payroll' },
  CASHIER:        { bg:'#78350f', fg:'#fde68a', label:'Cashier' },
  BARISTA:        { bg:'#3d1f0f', fg:'#fdba74', label:'Barista' },
  KITCHEN:        { bg:'#7f1d1d', fg:'#fca5a5', label:'Kitchen' },
  SERVICE_CREW:   { bg:'#064e3b', fg:'#6ee7b7', label:'Service' },
  WORKING_STUDENT:{ bg:'#1e1b4b', fg:'#a5b4fc', label:'Working Student' },
  STAFF:          { bg:'#374151', fg:'#d1d5db', label:'Staff' },
};
const HR_STATUS_STYLE = {
  ACTIVE:      { bg:'#dcfce7', fg:'#166534', label:'Active', dot:'#22c55e' },
  ON_LEAVE:    { bg:'#fef9c3', fg:'#854d0e', label:'On Leave', dot:'#eab308' },
  SUSPENDED:   { bg:'#fee2e2', fg:'#991b1b', label:'Suspended', dot:'#ef4444' },
  RESIGNED:    { bg:'#f3f4f6', fg:'#4b5563', label:'Resigned', dot:'#9ca3af' },
  TERMINATED:  { bg:'#fef2f2', fg:'#7f1d1d', label:'Terminated', dot:'#dc2626' },
  AWOL:        { bg:'#fff7ed', fg:'#9a3412', label:'AWOL', dot:'#f97316' },
};
const HR_EMPLOY_STYLE = {
  REGULAR:         { bg:'#dbeafe', fg:'#1e40af' },
  PROBATIONARY:    { bg:'#fef3c7', fg:'#92400e' },
  PART_TIME:       { bg:'#f3e8ff', fg:'#6b21a8' },
  WORKING_STUDENT: { bg:'#e0f2fe', fg:'#075985' },
  RELIEVER:        { bg:'#d1fae5', fg:'#065f46' },
  ON_CALL:         { bg:'#f1f5f9', fg:'#475569' },
};

function hrRoleBadge(role) {
  const s = HR_ROLE_STYLE[role] || HR_ROLE_STYLE.STAFF;
  return `<span class="hr-badge" style="background:${s.bg};color:${s.fg}">${s.label}</span>`;
}
function hrStatusBadge(status) {
  const s = HR_STATUS_STYLE[status] || HR_STATUS_STYLE.ACTIVE;
  return `<span class="hr-badge" style="background:${s.bg};color:${s.fg}"><span class="hr-dot" style="background:${s.dot}"></span>${s.label}</span>`;
}
function hrEmployBadge(type) {
  const s = HR_EMPLOY_STYLE[type] || HR_EMPLOY_STYLE.REGULAR;
  return `<span class="hr-badge-sm" style="background:${s.bg};color:${s.fg}">${(type||'').replace('_',' ')}</span>`;
}

// ── State ─────────────────────────────────────────────────────────────────
let _hrStaff = [];
let _hrSelected = null;
let _hrActiveTab = 'profile';
let _hrSearchTerm = '';
let _hrFilterStatus = 'ALL';

// ── Load staff from API ───────────────────────────────────────────────────
async function loadHRModule() {
  const el = document.getElementById('hrView');
  if (!el) return;
  el.innerHTML = '<div class="hr-loading">Loading staff...</div>';
  try {
    const r = await api('getHRStaff', { userId: currentUser?.userId });
    if (!r.ok) throw new Error(r.error || 'Failed to load staff');
    _hrStaff = r.staff || [];
    renderHRModule();
  } catch(e) {
    el.innerHTML = `<div class="hr-error">⚠️ ${esc(e.message)}</div>`;
  }
}

// ── Main render ───────────────────────────────────────────────────────────
function renderHRModule() {
  const el = document.getElementById('hrView');
  if (!el) return;
  el.innerHTML = `
    <div class="hr-wrap">
      <!-- LEFT: staff list -->
      <div class="hr-list-col" id="hrListCol">
        <div class="hr-list-hdr">
          <div class="hr-list-title">👥 Staff</div>
          <button class="hr-add-btn" onclick="openAddStaffModal()">+ Add</button>
        </div>
        <div class="hr-search-wrap">
          <input class="hr-search" type="text" placeholder="Search staff..." value="${esc(_hrSearchTerm)}"
            oninput="_hrSearchTerm=this.value;renderHRStaffList()">
        </div>
        <div class="hr-filter-row">
          ${['ALL','ACTIVE','ON_LEAVE','SUSPENDED'].map(s =>
            `<button class="hr-filter-btn${_hrFilterStatus===s?' active':''}" onclick="_hrFilterStatus='${s}';renderHRStaffList()">${s==='ALL'?'All':HR_STATUS_STYLE[s]?.label||s}</button>`
          ).join('')}
        </div>
        <div class="hr-staff-list" id="hrStaffList"></div>
      </div>

      <!-- RIGHT: detail panel -->
      <div class="hr-detail-col" id="hrDetailCol">
        <div id="hrDetailContent">
          <div class="hr-empty-state">
            <div style="font-size:2.5rem">👥</div>
            <div style="font-size:1rem;font-weight:600;margin-top:8px;color:var(--ink)">Select a staff member</div>
            <div style="font-size:.8rem;color:var(--timber);margin-top:4px">Click any name on the left to view their profile</div>
          </div>
        </div>
      </div>
    </div>
  `;
  renderHRStaffList();
  if (_hrSelected) renderHRDetail(_hrSelected);
}

// ── Staff list ────────────────────────────────────────────────────────────
function renderHRStaffList() {
  const el = document.getElementById('hrStaffList');
  if (!el) return;
  let list = _hrStaff;
  if (_hrSearchTerm) {
    const q = _hrSearchTerm.toLowerCase();
    list = list.filter(s => (s.full_name||'').toLowerCase().includes(q) || (s.role||'').toLowerCase().includes(q));
  }
  if (_hrFilterStatus !== 'ALL') {
    list = list.filter(s => s.employment_status === _hrFilterStatus);
  }
  if (!list.length) {
    el.innerHTML = '<div class="hr-list-empty">No staff found</div>';
    return;
  }
  el.innerHTML = list.map(s => {
    const rs = HR_ROLE_STYLE[s.role] || HR_ROLE_STYLE.STAFF;
    const ss = HR_STATUS_STYLE[s.employment_status] || HR_STATUS_STYLE.ACTIVE;
    const isSelected = _hrSelected && _hrSelected.id === s.id;
    return `<div class="hr-staff-card${isSelected?' selected':''}" onclick="selectHRStaff('${s.id}')">
      <div class="hr-avatar" style="background:${rs.bg};color:${rs.fg}">
        ${s.full_name?.charAt(0)?.toUpperCase() || '?'}
      </div>
      <div class="hr-card-info">
        <div class="hr-card-name">${esc(s.full_name || '—')}</div>
        <div class="hr-card-meta">${hrRoleBadge(s.role)}</div>
      </div>
      <div class="hr-card-right">
        <span class="hr-dot" style="background:${ss.dot}" title="${ss.label}"></span>
        <button class="hr-toggle${s.employment_status==='ACTIVE'?' on':''}"
          onclick="event.stopPropagation();toggleHRStatus('${s.id}','${s.employment_status}')"
          title="${s.employment_status==='ACTIVE'?'Deactivate':'Activate'}">
          <span class="hr-toggle-knob"></span>
        </button>
      </div>
    </div>`;
  }).join('');
}

// ── Select staff & show detail ────────────────────────────────────────────
function selectHRStaff(id) {
  _hrSelected = _hrStaff.find(s => s.id === id) || null;
  _hrActiveTab = 'profile';
  renderHRStaffList();
  renderHRDetail(_hrSelected);
  // Mobile: scroll to detail
  const dc = document.getElementById('hrDetailCol');
  if (dc && window.innerWidth < 768) dc.scrollIntoView({ behavior:'smooth' });
}

function renderHRDetail(s) {
  const el = document.getElementById('hrDetailContent');
  if (!el || !s) return;
  const rs = HR_ROLE_STYLE[s.role] || HR_ROLE_STYLE.STAFF;
  const ss = HR_STATUS_STYLE[s.employment_status] || HR_STATUS_STYLE.ACTIVE;
  el.innerHTML = `
    <div class="hr-detail-hdr" style="border-left:4px solid ${rs.bg}">
      <div class="hr-detail-avatar" style="background:${rs.bg};color:${rs.fg}">
        ${s.full_name?.charAt(0)?.toUpperCase() || '?'}
      </div>
      <div class="hr-detail-hdr-info">
        <div class="hr-detail-name">${esc(s.full_name || '—')}</div>
        <div class="hr-detail-badges">
          ${hrRoleBadge(s.role)}
          ${hrStatusBadge(s.employment_status)}
          ${hrEmployBadge(s.employment_type)}
        </div>
        <div class="hr-detail-code">Staff code: ${esc(s.staff_code || '—')}</div>
      </div>
      <div class="hr-detail-actions">
        <button class="hr-edit-btn" onclick="openEditStaffModal('${s.id}')">✏️ Edit</button>
      </div>
    </div>

    <div class="hr-tabs">
      ${[
        {k:'profile',   label:'👤 Profile'},
        {k:'pay',       label:'💰 Pay'},
        {k:'schedule',  label:'📅 Schedule'},
        {k:'leave',     label:'🌿 Leave'},
        {k:'clock',     label:'⏱ Clock-in'},
        {k:'performance',label:'⭐ Performance'},
        {k:'documents', label:'📄 Documents'},
      ].map(t => `<button class="hr-tab${_hrActiveTab===t.k?' active':''}" onclick="switchHRTab('${s.id}','${t.k}')">${t.label}</button>`).join('')}
    </div>

    <div class="hr-tab-content" id="hrTabContent">
      ${renderHRTab(s, _hrActiveTab)}
    </div>
  `;
}

function switchHRTab(id, tab) {
  _hrActiveTab = tab;
  const tc = document.getElementById('hrTabContent');
  if (tc && _hrSelected) tc.innerHTML = renderHRTab(_hrSelected, tab);
  // Update tab buttons
  document.querySelectorAll('.hr-tab').forEach(b => {
    b.classList.toggle('active', b.textContent.includes(tab) || b.onclick?.toString().includes(`'${tab}'`));
  });
  renderHRDetail(_hrSelected);
}

// ── Tab content renderers ─────────────────────────────────────────────────
function renderHRTab(s, tab) {
  switch(tab) {
    case 'profile':     return renderProfileTab(s);
    case 'pay':         return renderPayTab(s);
    case 'schedule':    return renderScheduleTab(s);
    case 'leave':       return renderLeaveTab(s);
    case 'clock':       return renderClockTab(s);
    case 'performance': return renderPerformanceTab(s);
    case 'documents':   return renderDocumentsTab(s);
    default: return '<div class="hr-tab-empty">Coming soon</div>';
  }
}

function renderProfileTab(s) {
  const age = s.date_of_birth ? Math.floor((Date.now() - new Date(s.date_of_birth)) / 31557600000) : '—';
  return `
    <div class="hr-section">
      <div class="hr-section-title">Personal Information</div>
      <div class="hr-grid-2">
        ${hrField('Full name', s.full_name)}
        ${hrField('Nickname', s.nickname)}
        ${hrField('Date of birth', s.date_of_birth ? new Date(s.date_of_birth).toLocaleDateString('en-PH',{year:'numeric',month:'long',day:'numeric'}) : '—')}
        ${hrField('Age', age !== '—' ? age + ' years old' : '—')}
        ${hrField('Gender', s.gender || '—')}
        ${hrField('Civil status', s.civil_status || '—')}
      </div>
    </div>
    <div class="hr-section">
      <div class="hr-section-title">Employment Details</div>
      <div class="hr-grid-2">
        ${hrField('Staff code', s.staff_code)}
        ${hrField('Role', s.role)}
        ${hrField('Employment type', s.employment_type)}
        ${hrField('Date hired', s.date_hired || '—')}
        ${hrField('Status', s.employment_status)}
        ${hrField('Department', s.department || '—')}
      </div>
    </div>
    <div class="hr-section">
      <div class="hr-section-title">Contact & Payout</div>
      <div class="hr-grid-2">
        ${hrField('Phone', s.mobile || '—')}
        ${hrField('Email', s.email || '—')}
        ${hrField('Payout method', s.payout_method || '—')}
        ${hrField('GCash / Bank', s.payout_details || '— (to be filled)')}
      </div>
    </div>
    <div class="hr-section">
      <div class="hr-section-title">Government Numbers <span style="font-size:.7rem;color:var(--timber)">(add later)</span></div>
      <div class="hr-grid-2">
        ${hrField('SSS No.', '—')}
        ${hrField('PhilHealth No.', '—')}
        ${hrField('PagIBIG No.', '—')}
        ${hrField('TIN', '—')}
      </div>
    </div>
  `;
}

function renderPayTab(s) {
  const rate = s.daily_rate ? '₱' + parseFloat(s.daily_rate).toLocaleString('en-PH') : '—';
  const monthly = s.daily_rate ? '₱' + (parseFloat(s.daily_rate) * 26).toLocaleString('en-PH') : '—';
  return `
    <div class="hr-section">
      <div class="hr-section-title">Current Rate</div>
      <div class="hr-pay-highlight" style="background:#f0fdf4;border:1.5px solid #86efac;border-radius:10px;padding:16px 18px;margin-bottom:14px">
        <div style="font-size:.75rem;color:var(--timber);margin-bottom:4px">DAILY RATE</div>
        <div style="font-size:2rem;font-weight:700;color:#166534">${rate}</div>
        <div style="font-size:.8rem;color:var(--timber);margin-top:4px">Est. monthly (26 days): ${monthly}</div>
      </div>
      <div class="hr-grid-2">
        ${hrField('Pay basis', s.pay_basis || 'DAILY')}
        ${hrField('Hourly rate', s.hourly_rate ? '₱'+parseFloat(s.hourly_rate).toFixed(2)+'/hr' : 'Auto (daily ÷ 8)')}
        ${hrField('Standard hours/day', s.standard_hours_per_day || 8)}
        ${hrField('OT allowed', s.overtime_allowed ? '✅ Yes' : '❌ No')}
      </div>
    </div>
    <div class="hr-section">
      <div class="hr-section-title">Allowances <span style="font-size:.7rem;color:var(--timber)">(none added yet)</span></div>
      <div class="hr-empty-sm">No allowances configured. <button class="hr-link-btn" onclick="openAddAllowanceModal('${s.id}')">+ Add allowance</button></div>
    </div>
    <div class="hr-section">
      <div class="hr-section-title">Payroll History</div>
      <div class="hr-empty-sm">No payroll runs yet. Payroll will appear here once processed.</div>
    </div>
  `;
}

function renderScheduleTab(s) {
  return `
    <div class="hr-section">
      <div class="hr-section-title">Weekly Schedule</div>
      <div class="hr-empty-sm">No schedule set yet. <button class="hr-link-btn">+ Create schedule</button></div>
    </div>
    <div class="hr-section">
      <div class="hr-section-title">Shift Templates</div>
      <div class="hr-empty-sm">No shifts configured. Shifts let you set standard clock-in/out times.</div>
    </div>
  `;
}

function renderLeaveTab(s) {
  return `
    <div class="hr-section">
      <div class="hr-section-title">Leave Balances</div>
      <div class="hr-leave-grid">
        ${['Vacation','Sick','Emergency','Birthday'].map(t =>
          `<div class="hr-leave-card">
            <div class="hr-leave-type">${t} Leave</div>
            <div class="hr-leave-bal">0 <span>days</span></div>
            <div class="hr-leave-used">0 used</div>
          </div>`
        ).join('')}
      </div>
    </div>
    <div class="hr-section">
      <div class="hr-section-title">Leave Requests</div>
      <div class="hr-empty-sm">No leave requests. <button class="hr-link-btn">+ File leave</button></div>
    </div>
  `;
}

function renderClockTab(s) {
  return `
    <div class="hr-section">
      <div class="hr-section-title">Time Logs <span style="font-size:.7rem;color:var(--timber)">— today</span></div>
      <div class="hr-empty-sm">No clock-ins recorded today.</div>
    </div>
    <div class="hr-section">
      <div class="hr-section-title">Recent Attendance (last 7 days)</div>
      <div class="hr-empty-sm">No attendance records yet. Staff will appear here after clocking in.</div>
    </div>
    <div style="margin-top:12px">
      <button class="hr-primary-btn" onclick="openClockInModal()">⏱ Manual Clock-in/out</button>
    </div>
  `;
}

function renderPerformanceTab(s) {
  return `
    <div class="hr-section">
      <div class="hr-section-title">Performance Records</div>
      <div class="hr-empty-sm">No records yet.</div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="hr-success-btn" onclick="openPerformanceModal('${s.id}','COMMENDATION')">🌟 Add Commendation</button>
        <button class="hr-warn-btn" onclick="openPerformanceModal('${s.id}','WARNING')">⚠️ Add Warning</button>
      </div>
    </div>
  `;
}

function renderDocumentsTab(s) {
  return `
    <div class="hr-section">
      <div class="hr-section-title">Staff Documents</div>
      <div class="hr-doc-checklist">
        ${['Contract','NBI Clearance','Health Certificate','Government IDs','Resume','Medical Certificate'].map(d =>
          `<div class="hr-doc-item">
            <span class="hr-doc-status hr-doc-missing">○</span>
            <span class="hr-doc-name">${d}</span>
            <button class="hr-link-btn">Upload</button>
          </div>`
        ).join('')}
      </div>
    </div>
  `;
}

// ── Toggle active status ──────────────────────────────────────────────────
async function toggleHRStatus(id, currentStatus) {
  const s = _hrStaff.find(x => x.id === id);
  if (!s) return;
  const newStatus = currentStatus === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
  const msg = newStatus === 'ACTIVE'
    ? `Activate ${s.full_name}?`
    : `Deactivate ${s.full_name}? They will not be able to clock in.`;
  if (!confirm(msg)) return;
  try {
    const r = await api('updateHRStaff', { userId: currentUser?.userId, staffId: id, employment_status: newStatus });
    if (!r.ok) throw new Error(r.error);
    s.employment_status = newStatus;
    renderHRStaffList();
    if (_hrSelected?.id === id) { _hrSelected = s; renderHRDetail(s); }
    showToast(`${s.full_name} ${newStatus === 'ACTIVE' ? 'activated ✅' : 'deactivated'}`, 'success');
  } catch(e) { showToast('Failed: ' + e.message, 'error'); }
}

// ── Helpers ───────────────────────────────────────────────────────────────
function hrField(label, value) {
  return `<div class="hr-field">
    <div class="hr-field-label">${esc(label)}</div>
    <div class="hr-field-value">${esc(String(value ?? '—'))}</div>
  </div>`;
}

function openAddStaffModal() { showToast('Select a staff and click ✏️ Edit to update details. New staff — coming soon.', 'info'); }
function openEditStaffModal(id) {
  const s = _hrStaff.find(x => x.id === id);
  if (!s) return;

  // Remove existing modal if any
  var existing = document.getElementById('hrEditModal');
  if (existing) existing.remove();

  const rs = HR_ROLE_STYLE[s.role] || HR_ROLE_STYLE.STAFF;
  const ROLES = ['MANAGER','BARISTA','CASHIER','KITCHEN','SERVICE_CREW','WORKING_STUDENT','STAFF','OWNER','PAYROLL_ADMIN'];
  const STATUSES = ['ACTIVE','ON_LEAVE','SUSPENDED','RESIGNED','TERMINATED','AWOL'];
  const PAY_BASIS = ['DAILY','HOURLY','MONTHLY'];

  const modal = document.createElement('div');
  modal.id = 'hrEditModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
  modal.innerHTML = `
    <div style="background:var(--bg);border-radius:16px;width:100%;max-width:480px;max-height:90vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.3)">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:18px 20px 14px;border-bottom:0.5px solid var(--mist)">
        <div>
          <div style="font-size:1rem;font-weight:700;color:var(--ink)">Edit Staff</div>
          <div style="font-size:.75rem;color:var(--timber);margin-top:2px">${esc(s.full_name)} · ${esc(s.staff_code)}</div>
        </div>
        <button onclick="document.getElementById('hrEditModal').remove()" style="width:32px;height:32px;border-radius:50%;border:none;background:var(--mist);cursor:pointer;font-size:1rem;display:flex;align-items:center;justify-content:center">✕</button>
      </div>
      <div style="padding:20px;display:flex;flex-direction:column;gap:14px">

        <div class="hr-edit-row">
          <label class="hr-edit-label">Full Name *</label>
          <input class="hr-edit-input" id="hef_name" type="text" value="${esc(s.full_name||'')}">
        </div>

        <div class="hr-edit-row">
          <label class="hr-edit-label">Nickname</label>
          <input class="hr-edit-input" id="hef_nick" type="text" value="${esc(s.nickname||'')}">
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="hr-edit-row">
            <label class="hr-edit-label">Role *</label>
            <select class="hr-edit-input" id="hef_role">
              ${ROLES.map(r => `<option value="${r}"${r===s.role?' selected':''}>${r.replace('_',' ')}</option>`).join('')}
            </select>
          </div>
          <div class="hr-edit-row">
            <label class="hr-edit-label">Status *</label>
            <select class="hr-edit-input" id="hef_status">
              ${STATUSES.map(st => `<option value="${st}"${st===s.employment_status?' selected':''}>${st.replace('_',' ')}</option>`).join('')}
            </select>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="hr-edit-row">
            <label class="hr-edit-label">Pay Basis</label>
            <select class="hr-edit-input" id="hef_paybasis">
              ${PAY_BASIS.map(p => `<option value="${p}"${p===(s.pay_basis||'DAILY')?' selected':''}>${p}</option>`).join('')}
            </select>
          </div>
          <div class="hr-edit-row">
            <label class="hr-edit-label">Daily Rate (₱)</label>
            <input class="hr-edit-input" id="hef_rate" type="number" min="0" step="0.01" value="${s.daily_rate||''}">
          </div>
        </div>

        <div class="hr-edit-row">
          <label class="hr-edit-label">Phone</label>
          <input class="hr-edit-input" id="hef_phone" type="text" placeholder="09XX XXX XXXX" value="${esc(s.mobile||'')}">
        </div>

        <div class="hr-edit-row">
          <label class="hr-edit-label">Email</label>
          <input class="hr-edit-input" id="hef_email" type="email" value="${esc(s.email||'')}">
        </div>

        <div class="hr-edit-row">
          <label class="hr-edit-label">Department</label>
          <input class="hr-edit-input" id="hef_dept" type="text" placeholder="e.g. Bar, Kitchen, Service" value="${esc(s.department||'')}">
        </div>

        <div class="hr-edit-row">
          <label class="hr-edit-label">Notes</label>
          <textarea class="hr-edit-input" id="hef_notes" rows="2" placeholder="Internal notes...">${esc(s.notes||'')}</textarea>
        </div>

        <div style="display:flex;gap:10px;padding-top:6px">
          <button onclick="document.getElementById('hrEditModal').remove()"
            style="flex:1;padding:12px;border-radius:10px;border:1.5px solid var(--mist);background:transparent;color:var(--ink);font-size:.85rem;font-weight:600;cursor:pointer">
            Cancel
          </button>
          <button onclick="saveHRStaffEdit('${s.id}')"
            style="flex:2;padding:12px;border-radius:10px;border:none;background:var(--forest);color:#fff;font-size:.85rem;font-weight:700;cursor:pointer">
            💾 Save Changes
          </button>
        </div>

      </div>
    </div>
  `;
  document.body.appendChild(modal);
  // Close on backdrop click
  modal.addEventListener('click', function(e){ if(e.target===modal) modal.remove(); });
  // Focus first input
  setTimeout(function(){ document.getElementById('hef_name')?.focus(); }, 50);
}

async function saveHRStaffEdit(id) {
  const get = function(eid){ return document.getElementById(eid)?.value?.trim() || ''; };
  const name = get('hef_name');
  if (!name) { showToast('Full name is required', 'error'); return; }

  const btn = document.querySelector('#hrEditModal button[onclick*="saveHRStaffEdit"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }

  const updates = {
    full_name:         name,
    nickname:          get('hef_nick') || null,
    role:              get('hef_role'),
    employment_status: get('hef_status'),
    pay_basis:         get('hef_paybasis'),
    daily_rate:        parseFloat(get('hef_rate')) || null,
    mobile:            get('hef_phone') || null,
    email:             get('hef_email') || null,
    department:        get('hef_dept') || null,
    notes:             get('hef_notes') || null,
  };

  try {
    const r = await api('updateHRStaff', { userId: currentUser?.userId, staffId: id, ...updates });
    if (!r.ok) throw new Error(r.error || 'Save failed');

    // Update local state
    const idx = _hrStaff.findIndex(x => x.id === id);
    if (idx >= 0) Object.assign(_hrStaff[idx], updates);
    if (_hrSelected?.id === id) Object.assign(_hrSelected, updates);

    document.getElementById('hrEditModal')?.remove();
    renderHRStaffList();
    if (_hrSelected?.id === id) renderHRDetail(_hrSelected);
    showToast(name + ' updated ✅', 'success');
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = '💾 Save Changes'; }
  }
}
function openAddAllowanceModal(id) { showToast('Add allowance — coming next session', 'info'); }
function openClockInModal() { showToast('Manual clock-in — coming next session', 'info'); }
function openPerformanceModal(id, type) { showToast(`${type} form — coming next session`, 'info'); }
