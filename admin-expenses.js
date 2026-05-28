// ══════════════════════════════════════════════════════════════════════════
// EXPENSES VIEW — Two tabs: Cash Flow + Business Expenses
// ══════════════════════════════════════════════════════════════════════════

var _expTab = 'cash'; // 'cash' | 'ledger'
var _cashExpenses = [];
var _bizExpenses  = [];
var _bizMonth = new Date().getMonth() + 1;
var _bizYear  = new Date().getFullYear();
var _bizCatFilter = 'All';

var SHIFT_CAT_EXP  = ['Supplies','Ingredients','Transport','Utilities','Other'];
var SHIFT_CAT_INC  = ['Refund / Credit','Petty cash return','Cash top-up','Other'];
var BIZ_CATEGORIES = ['Stocks & Groceries','Electricity','Water','Internet / Cable','Gas / Fuel','Rent','Equipment repair','Packaging','Other'];
var PAID_VIA_OPTS  = ['Cash','GCash','BPI','BDO','UnionBank','Auto-pay','Other'];

function peso(n){ return '₱' + Math.abs(parseFloat(n)||0).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2}); }

async function initExpenses() {
  await loadShiftExpenses();
  await loadBizExpenses();
  renderExpensesView();
}

async function loadShiftExpenses() {
  try {
    var today = new Date().toISOString().split('T')[0];
    var r = await api('getShiftExpenses',{ date: today });
    if (r.ok) _cashExpenses = r.expenses || [];
  } catch(e) { console.warn('loadShiftExpenses failed', e); }
}

async function loadBizExpenses() {
  try {
    var r = await api('getBusinessExpenses',{
      month: _bizMonth, year: _bizYear,
      category: _bizCatFilter !== 'All' ? _bizCatFilter : undefined,
    });
    if (r.ok) _bizExpenses = r.expenses || [];
  } catch(e) { console.warn('loadBizExpenses failed', e); }
}

function switchExpTab(tab) {
  _expTab = tab;
  renderExpensesView();
}

function renderExpensesView() {
  var view = document.getElementById('expensesView');
  if (!view) return;

  var totalExp = _cashExpenses.filter(function(e){ return e.type==='EXPENSE'; }).reduce(function(s,e){ return s+parseFloat(e.amount); },0);
  var totalInc = _cashExpenses.filter(function(e){ return e.type==='INCOME'; }).reduce(function(s,e){ return s+parseFloat(e.amount); },0);
  var bizTotal = _bizExpenses.reduce(function(s,e){ return s+parseFloat(e.amount); },0);

  var html = '<div style="padding:16px 20px 80px">';

  // Page header
  html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">'
    + '<h2 style="font-size:1.1rem;font-weight:700;color:var(--forest-deep)">💰 Expenses</h2>'
    + '<span style="font-size:.72rem;background:var(--mist-light);color:var(--timber);padding:3px 10px;border-radius:20px">OWNER / ADMIN</span>'
    + '</div>';

  // Tabs
  html += '<div style="display:flex;gap:0;border-bottom:1.5px solid var(--mist);margin-bottom:16px">';
  html += tabBtn('cash', 'Cash Flow', '💵');
  html += tabBtn('ledger', 'Business Expenses', '📒');
  html += '</div>';

  if (_expTab === 'cash') html += renderCashTab(totalExp, totalInc);
  else                    html += renderLedgerTab(bizTotal);

  html += '</div>';
  view.innerHTML = html;
}

function tabBtn(key, label, icon) {
  var active = _expTab === key;
  return '<button onclick="switchExpTab(\''+key+'\')" style="padding:9px 18px;font-size:.82rem;font-weight:'+(active?'700':'500')+';'
    + 'border:none;background:none;cursor:pointer;color:'+(active?'var(--forest-deep)':'var(--timber)')+';'
    + 'border-bottom:'+(active?'2.5px solid var(--forest-deep)':'2px solid transparent')+';margin-bottom:-1.5px">'
    + icon + ' ' + label + '</button>';
}

// ── CASH FLOW TAB ─────────────────────────────────────────────────────────
function renderCashTab(totalExp, totalInc) {
  var html = '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px">';
  html += statCard('Total deductions', '-' + peso(totalExp), '#dc2626');
  html += statCard('Total additions', '+' + peso(totalInc), '#16a34a');
  html += statCard('Net cash adjustment', (totalInc - totalExp >= 0 ? '+' : '') + peso(totalInc - totalExp), totalInc-totalExp >= 0 ? '#16a34a' : '#dc2626');
  html += '</div>';

  html += '<div style="display:grid;grid-template-columns:1fr 300px;gap:14px">';

  // Expense log
  html += '<div style="background:var(--white);border-radius:var(--r-lg);border:1.5px solid var(--mist);overflow:hidden">';
  html += '<div style="padding:10px 16px;border-bottom:1px solid var(--mist);display:flex;align-items:center;justify-content:space-between">';
  html += '<span style="font-weight:700;font-size:.82rem;color:var(--forest-deep)">Today\'s cash entries</span>';
  html += '<span style="font-size:.68rem;background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:20px">affects cash balance</span>';
  html += '</div>';

  if (!_cashExpenses.length) {
    html += '<div style="padding:24px;text-align:center;color:var(--timber);font-size:.8rem">No entries today yet</div>';
  } else {
    _cashExpenses.forEach(function(e) {
      var isExp = e.type === 'EXPENSE';
      var ph = new Date(e.created_at).toLocaleTimeString('en-PH',{timeZone:'Asia/Manila',hour:'numeric',minute:'2-digit'});
      html += '<div style="display:flex;align-items:center;gap:10px;padding:9px 16px;border-bottom:0.5px solid var(--mist-light)">';
      html += '<div style="width:28px;height:28px;border-radius:8px;background:'+(isExp?'#fee2e2':'#dcfce7')+';display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:14px">'+(isExp?'−':'+')+' </div>';
      html += '<div style="flex:1"><div style="font-size:.8rem;font-weight:600;color:var(--forest-deep)">'+escH(e.description)+'</div>';
      html += '<div style="font-size:.68rem;color:var(--timber)">'+escH(e.category)+' · '+ph+' · '+escH(e.added_by_role||'staff')+'</div></div>';
      html += '<div style="font-size:.85rem;font-weight:700;color:'+(isExp?'#dc2626':'#16a34a')+'">'+(isExp?'-':'+')+peso(e.amount)+'</div>';
      html += '</div>';
    });
  }
  html += '</div>';

  // Add entry form
  html += '<div style="background:var(--white);border-radius:var(--r-lg);border:1.5px solid var(--mist);padding:16px">';
  html += '<div style="font-weight:700;font-size:.85rem;color:var(--forest-deep);margin-bottom:12px">➕ Add cash entry</div>';

  // Type toggle
  html += '<div style="display:grid;grid-template-columns:1fr 1fr;border:1.5px solid var(--mist);border-radius:var(--r-sm);overflow:hidden;margin-bottom:11px">';
  html += '<button id="ceTypExp" onclick="setCashType(\'EXPENSE\')" style="padding:8px;font-size:.78rem;font-weight:700;background:#fee2e2;color:#dc2626;border:none;cursor:pointer">− Deduct</button>';
  html += '<button id="ceTypInc" onclick="setCashType(\'INCOME\')" style="padding:8px;font-size:.78rem;font-weight:700;background:var(--mist-light);color:var(--timber);border:none;cursor:pointer">+ Add</button>';
  html += '</div>';

  html += '<input id="ceDesc" type="text" placeholder="Description..." style="width:100%;margin-bottom:8px;font-size:.82rem;padding:8px 10px;border:1.5px solid var(--mist);border-radius:var(--r-sm)">';
  html += '<input id="ceAmt" type="number" placeholder="Amount ₱" style="width:100%;margin-bottom:8px;font-size:.82rem;padding:8px 10px;border:1.5px solid var(--mist);border-radius:var(--r-sm)">';
  html += '<select id="ceCat" style="width:100%;margin-bottom:10px;font-size:.82rem;padding:8px 10px;border:1.5px solid var(--mist);border-radius:var(--r-sm)">';
  SHIFT_CAT_EXP.forEach(function(c){ html += '<option>'+c+'</option>'; });
  html += '</select>';
  html += '<button onclick="submitCashExpense()" style="width:100%;padding:9px;background:var(--forest);color:#fff;border:none;border-radius:var(--r-sm);font-weight:700;font-size:.82rem;cursor:pointer">💾 Save &amp; adjust cash</button>';
  html += '<div style="font-size:.68rem;color:var(--timber);margin-top:10px;line-height:1.5">ℹ️ Logged with staff name and time. Visible in Shift Summary report.</div>';
  html += '</div>';

  html += '</div>'; // end grid
  return html;
}

var _cashType = 'EXPENSE';
function setCashType(t) {
  _cashType = t;
  var expBtn = document.getElementById('ceTypExp');
  var incBtn = document.getElementById('ceTypInc');
  if (!expBtn||!incBtn) return;
  expBtn.style.background = t==='EXPENSE' ? '#fee2e2' : 'var(--mist-light)';
  expBtn.style.color       = t==='EXPENSE' ? '#dc2626' : 'var(--timber)';
  incBtn.style.background  = t==='INCOME'  ? '#dcfce7' : 'var(--mist-light)';
  incBtn.style.color        = t==='INCOME'  ? '#16a34a' : 'var(--timber)';
  var catSel = document.getElementById('ceCat');
  if (catSel) {
    catSel.innerHTML = '';
    var cats = t==='EXPENSE' ? SHIFT_CAT_EXP : SHIFT_CAT_INC;
    cats.forEach(function(c){ catSel.innerHTML += '<option>'+c+'</option>'; });
  }
}

async function submitCashExpense() {
  var desc = (document.getElementById('ceDesc')||{}).value?.trim();
  var amt  = parseFloat((document.getElementById('ceAmt')||{}).value||0);
  var cat  = (document.getElementById('ceCat')||{}).value;
  if (!desc) { showToast('Enter description','error'); return; }
  if (!amt||amt<=0) { showToast('Enter valid amount','error'); return; }

  var r = await api('addShiftExpense',{ type:_cashType, description:desc, amount:amt, category:cat });
  if (r.ok) {
    showToast((_cashType==='EXPENSE'?'-':'+')+'₱'+amt.toFixed(2)+' saved ✅');
    document.getElementById('ceDesc').value = '';
    document.getElementById('ceAmt').value  = '';
    await loadShiftExpenses();
    renderExpensesView();
  } else {
    showToast('Failed: '+(r.error||'Unknown error'), 'error');
  }
}

// ── BUSINESS EXPENSES TAB ─────────────────────────────────────────────────
function renderLedgerTab(bizTotal) {
  var byCat = {};
  _bizExpenses.forEach(function(e){ byCat[e.category]=(byCat[e.category]||0)+parseFloat(e.amount); });

  var html = '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px">';
  html += statCard('This period total', peso(bizTotal), '#dc2626');
  html += statCard('Stocks & Groceries', peso(byCat['Stocks & Groceries']||0), '#92400e');
  html += statCard('Utilities & Bills', peso((byCat['Electricity']||0)+(byCat['Water']||0)+(byCat['Internet / Cable']||0)), '#1d4ed8');
  html += '</div>';

  // Month/year + category filters
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  html += '<div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">';
  html += '<select id="bizMonth" onchange="updateBizFilter()" style="font-size:.78rem;padding:5px 8px;border:1.5px solid var(--mist);border-radius:var(--r-sm)">';
  months.forEach(function(m,i){ html += '<option value="'+(i+1)+'"'+(i+1===_bizMonth?' selected':'')+'>'+m+'</option>'; });
  html += '</select>';
  html += '<input id="bizYear" type="number" value="'+_bizYear+'" onchange="updateBizFilter()" style="width:70px;font-size:.78rem;padding:5px 8px;border:1.5px solid var(--mist);border-radius:var(--r-sm)">';
  ['All'].concat(BIZ_CATEGORIES).forEach(function(c){
    var on = _bizCatFilter === c;
    html += '<button onclick="setBizCat(\''+c+'\')" style="padding:3px 10px;border-radius:20px;font-size:.7rem;border:1.5px solid '+(on?'var(--forest)':'var(--mist)')+';background:'+(on?'var(--forest)':'transparent')+';color:'+(on?'#fff':'var(--timber)')+';cursor:pointer">'+c+'</button>';
  });
  html += '</div>';

  html += '<div style="display:grid;grid-template-columns:1fr 310px;gap:14px">';

  // Records list
  html += '<div style="background:var(--white);border-radius:var(--r-lg);border:1.5px solid var(--mist);overflow:hidden">';
  html += '<div style="padding:10px 16px;border-bottom:1px solid var(--mist);display:flex;align-items:center;justify-content:space-between">';
  html += '<span style="font-weight:700;font-size:.82rem;color:var(--forest-deep)">📒 Expense records — '+months[_bizMonth-1]+' '+_bizYear+'</span>';
  html += '<span style="font-size:.68rem;color:var(--timber)">record only · not tied to cash</span>';
  html += '</div>';

  if (!_bizExpenses.length) {
    html += '<div style="padding:24px;text-align:center;color:var(--timber);font-size:.8rem">No records for this period</div>';
  } else {
    _bizExpenses.forEach(function(e) {
      var catIcon = {'Electricity':'⚡','Water':'💧','Internet / Cable':'📶','Stocks & Groceries':'🛒','Gas / Fuel':'⛽','Rent':'🏠','Equipment repair':'🔧','Packaging':'📦','Other':'💼'};
      html += '<div style="display:flex;align-items:flex-start;gap:10px;padding:9px 16px;border-bottom:0.5px solid var(--mist-light)">';
      html += '<div style="font-size:18px;flex-shrink:0;margin-top:2px">'+(catIcon[e.category]||'💼')+'</div>';
      html += '<div style="flex:1"><div style="font-size:.8rem;font-weight:600;color:var(--forest-deep)">'+escH(e.description)+'</div>';
      html += '<div style="font-size:.68rem;color:var(--timber);margin-top:2px">'
        +escH(e.category)+' · '+(e.expense_date||'').substring(0,10)+' · via '+escH(e.paid_via)
        +(e.reference_no ? ' · <span style="color:var(--forest)">'+escH(e.reference_no)+'</span>' : '')
        +(e.is_paid ? ' · <span style="color:#16a34a">paid</span>' : ' · <span style="color:#dc2626">unpaid</span>')
        +'</div></div>';
      html += '<div style="text-align:right">';
      html += '<div style="font-size:.85rem;font-weight:700;color:#dc2626">'+peso(e.amount)+'</div>';
      if (currentUser && currentUser.role==='OWNER') {
        html += '<button onclick="deleteBizExp(\''+e.id+'\')" style="font-size:.65rem;color:var(--timber);background:none;border:none;cursor:pointer;margin-top:2px">🗑️</button>';
      }
      html += '</div></div>';
    });
  }
  html += '</div>';

  // Add record form
  html += '<div style="background:var(--white);border-radius:var(--r-lg);border:1.5px solid var(--mist);padding:16px">';
  html += '<div style="font-weight:700;font-size:.85rem;color:var(--forest-deep);margin-bottom:11px">📝 Record expense</div>';
  html += '<input id="beDesc" type="text" placeholder="Meralco bill, weekly groceries..." style="width:100%;margin-bottom:8px;font-size:.8rem;padding:7px 10px;border:1.5px solid var(--mist);border-radius:var(--r-sm)">';
  html += '<input id="beAmt" type="number" placeholder="Amount ₱" style="width:100%;margin-bottom:8px;font-size:.8rem;padding:7px 10px;border:1.5px solid var(--mist);border-radius:var(--r-sm)">';
  html += '<input id="beDate" type="date" value="'+new Date().toISOString().split('T')[0]+'" style="width:100%;margin-bottom:8px;font-size:.8rem;padding:7px 10px;border:1.5px solid var(--mist);border-radius:var(--r-sm)">';
  html += '<select id="beCat" style="width:100%;margin-bottom:8px;font-size:.8rem;padding:7px 10px;border:1.5px solid var(--mist);border-radius:var(--r-sm)">';
  BIZ_CATEGORIES.forEach(function(c){ html += '<option>'+c+'</option>'; });
  html += '</select>';
  html += '<select id="bePaid" style="width:100%;margin-bottom:8px;font-size:.8rem;padding:7px 10px;border:1.5px solid var(--mist);border-radius:var(--r-sm)">';
  PAID_VIA_OPTS.forEach(function(c){ html += '<option>'+c+'</option>'; });
  html += '</select>';
  html += '<input id="beRef" type="text" placeholder="OR / reference no. (optional)" style="width:100%;margin-bottom:8px;font-size:.8rem;padding:7px 10px;border:1.5px solid var(--mist);border-radius:var(--r-sm)">';
  html += '<textarea id="beNotes" placeholder="Notes, supplier name..." style="width:100%;height:48px;resize:none;margin-bottom:10px;font-size:.8rem;padding:7px 10px;border:1.5px solid var(--mist);border-radius:var(--r-sm)"></textarea>';
  html += '<button onclick="submitBizExpense()" style="width:100%;padding:9px;background:var(--forest);color:#fff;border:none;border-radius:var(--r-sm);font-weight:700;font-size:.82rem;cursor:pointer">💾 Save record</button>';
  html += '<div style="font-size:.68rem;color:var(--timber);margin-top:9px;line-height:1.5">ℹ️ Record only — does not affect cash on hand or sales totals. Shows in monthly report.</div>';
  html += '</div>';

  html += '</div>';
  return html;
}

function statCard(lbl, val, color) {
  return '<div style="background:var(--white);border:1.5px solid var(--mist);border-radius:var(--r-md);padding:10px 14px">'
    + '<div style="font-size:.68rem;color:var(--timber);margin-bottom:3px">'+lbl+'</div>'
    + '<div style="font-size:1.1rem;font-weight:800;color:'+color+'">'+val+'</div>'
    + '</div>';
}

function escH(s) { var d=document.createElement('div');d.textContent=String(s||'');return d.innerHTML; }

async function updateBizFilter() {
  _bizMonth = parseInt(document.getElementById('bizMonth')?.value || _bizMonth);
  _bizYear  = parseInt(document.getElementById('bizYear')?.value  || _bizYear);
  await loadBizExpenses();
  renderExpensesView();
}

function setBizCat(cat) {
  _bizCatFilter = cat;
  loadBizExpenses().then(function(){ renderExpensesView(); });
}

async function submitBizExpense() {
  var desc = (document.getElementById('beDesc')||{}).value?.trim();
  var amt  = parseFloat((document.getElementById('beAmt')||{}).value||0);
  var cat  = (document.getElementById('beCat')||{}).value;
  var paid = (document.getElementById('bePaid')||{}).value;
  var ref  = (document.getElementById('beRef')||{}).value?.trim();
  var notes= (document.getElementById('beNotes')||{}).value?.trim();
  var date = (document.getElementById('beDate')||{}).value;

  if (!desc) { showToast('Enter description','error'); return; }
  if (!amt||amt<=0) { showToast('Enter valid amount','error'); return; }

  var r = await api('addBusinessExpense',{ description:desc, amount:amt, category:cat, paidVia:paid, referenceNo:ref, notes:notes, expenseDate:date });
  if (r.ok) {
    showToast('Expense recorded ✅');
    ['beDesc','beAmt','beRef','beNotes'].forEach(function(id){ var el=document.getElementById(id); if(el)el.value=''; });
    await loadBizExpenses();
    renderExpensesView();
  } else {
    showToast('Failed: '+(r.error||'Unknown error'),'error');
  }
}

async function deleteBizExp(id) {
  if (!confirm('Delete this expense record?')) return;
  var r = await api('deleteBusinessExpense',{ expenseId:id });
  if (r.ok) { showToast('Deleted'); await loadBizExpenses(); renderExpensesView(); }
  else showToast('Failed: '+(r.error||''),'error');
}
