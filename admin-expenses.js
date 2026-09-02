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
var BIZ_CATEGORIES = ['Stocks & Groceries','Utilities','Electricity','Water','Internet / Cable','Gas / Fuel','Rent','Equipment repair','Packaging','Cleaning / Supplies','Office / Admin','Marketing','Transport / Delivery','Other'];
var BIZ_CAT_ICON = {'Stocks & Groceries':'🛒','Utilities':'🧾','Electricity':'⚡','Water':'💧','Internet / Cable':'📶','Gas / Fuel':'⛽','Rent':'🏠','Equipment repair':'🔧','Packaging':'📦','Cleaning / Supplies':'🧴','Office / Admin':'🗂️','Marketing':'📣','Transport / Delivery':'🚚','Other':'💼'};
var BIZ_INV_CATS = ['Stocks & Groceries','Packaging','Cleaning / Supplies']; // eligible for optional inventory receiving
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
  var util=(byCat['Utilities']||0)+(byCat['Electricity']||0)+(byCat['Water']||0)+(byCat['Internet / Cable']||0);
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  var html = '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px">';
  html += statCard('This period total', peso(bizTotal), '#dc2626');
  html += statCard('Stocks & Groceries', peso(byCat['Stocks & Groceries']||0), '#92400e');
  html += statCard('Utilities & Bills', peso(util), '#1d4ed8');
  html += '</div>';

  // filters + record purchase
  html += '<div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">';
  html += '<select id="bizMonth" onchange="updateBizFilter()" style="font-size:.78rem;padding:5px 8px;border:1.5px solid var(--mist);border-radius:var(--r-sm)">';
  months.forEach(function(m,i){ html += '<option value="'+(i+1)+'"'+(i+1===_bizMonth?' selected':'')+'>'+m+'</option>'; });
  html += '</select>';
  html += '<input id="bizYear" type="number" value="'+_bizYear+'" onchange="updateBizFilter()" style="width:70px;font-size:.78rem;padding:5px 8px;border:1.5px solid var(--mist);border-radius:var(--r-sm)">';
  html += '<div style="flex:1"></div>';
  html += '<button onclick="_expOpenPurchaseForm()" style="padding:7px 14px;background:var(--forest);color:#fff;border:none;border-radius:var(--r-sm);font-size:.78rem;font-weight:700;cursor:pointer;white-space:nowrap">+ Record Purchase</button>';
  html += '</div>';
  // category chips
  html += '<div style="display:flex;gap:5px;align-items:center;margin-bottom:12px;flex-wrap:wrap">';
  ['All'].concat(BIZ_CATEGORIES).forEach(function(c){
    var on = _bizCatFilter === c;
    html += '<button onclick="setBizCat(\''+c+'\')" style="padding:3px 9px;border-radius:20px;font-size:.68rem;border:1.5px solid '+(on?'var(--forest)':'var(--mist)')+';background:'+(on?'var(--forest)':'transparent')+';color:'+(on?'#fff':'var(--timber)')+';cursor:pointer">'+(c!=='All'?(BIZ_CAT_ICON[c]||'')+' ':'')+c+'</button>';
  });
  html += '</div>';

  // grouped records
  html += '<div style="background:var(--white);border-radius:var(--r-lg);border:1.5px solid var(--mist);overflow:hidden">';
  html += '<div style="padding:10px 16px;border-bottom:1px solid var(--mist);display:flex;align-items:center;justify-content:space-between">';
  html += '<span style="font-weight:700;font-size:.82rem;color:var(--forest-deep)">📒 Purchases & expenses — '+months[_bizMonth-1]+' '+_bizYear+'</span>';
  html += '<span style="font-size:.68rem;color:var(--timber)">financial record · not tied to cash</span>';
  html += '</div>';

  var groups = _expGroupRecords(_bizExpenses);
  if(!groups.length){
    html += '<div style="padding:28px;text-align:center;color:var(--timber);font-size:.82rem">No records for this period. Tap <b>+ Record Purchase</b> to add an itemized expense.</div>';
  } else {
    groups.forEach(function(g){
      var multi = g.lines.length>1;
      var ico = BIZ_CAT_ICON[g.category]||'💼';
      var invEligible = BIZ_INV_CATS.indexOf(g.category)>-1;
      html += '<div onclick="_expOpenDetail(\''+g.key+'\')" style="padding:11px 16px;border-bottom:0.5px solid var(--mist-light);cursor:pointer" onmouseover="this.style.background=\'var(--mist-light)\'" onmouseout="this.style.background=\'transparent\'">';
      html += '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">';
      html += '<div style="min-width:0"><div style="font-size:.84rem;font-weight:700;color:var(--forest-deep)">'+ico+' '+escH(g.supplier || g.lines[0].description)+'</div>';
      html += '<div style="font-size:.68rem;color:var(--timber);margin-top:2px">'+(g.date||'').substring(0,10)+' · <b style="color:var(--forest)">'+escH(g.category)+'</b> · '+escH(g.paid)+(g.ref?(' · '+escH(g.ref)):'')+'</div></div>';
      html += '<div style="text-align:right;white-space:nowrap"><div style="font-size:.9rem;font-weight:800;color:#dc2626">'+peso(g.total)+'</div>'+(multi?'<div style="font-size:.62rem;color:var(--timber)">'+g.lines.length+' items</div>':'')+'</div>';
      html += '</div>';
      if(multi){
        html += '<div style="margin-top:6px;padding-left:4px">';
        g.lines.slice(0,4).forEach(function(l){
          var q=(l.qty?escH(l.qty)+(l.unit?' '+escH(l.unit):'')+' × ':'');
          html += '<div style="display:flex;justify-content:space-between;font-size:.7rem;color:var(--timber);padding:1px 0"><span>'+q+escH(l.description)+'</span><span>'+peso(l.amount)+'</span></div>';
        });
        if(g.lines.length>4) html += '<div style="font-size:.66rem;color:var(--timber)">+ '+(g.lines.length-4)+' more…</div>';
        html += '</div>';
      }
      // inventory linkage badge
      if(g.allReceived) html += '<div style="margin-top:6px;font-size:.66rem;color:#15803d;font-weight:700">✓ Received to Inventory</div>';
      else if(g.received) html += '<div style="margin-top:6px;font-size:.66rem;color:#b45309;font-weight:700">◑ Partially received to Inventory</div>';
      else if(invEligible) html += '<div style="margin-top:6px;font-size:.66rem;color:var(--timber)">Not linked to inventory · tap to receive</div>';
      else html += '<div style="margin-top:6px;font-size:.66rem;color:var(--timber)">No inventory linkage</div>';
      html += '</div>';
    });
  }
  html += '</div>';
  html += '<div id="expDrawerHost"></div>';
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

function beAutoTotal() {
  var q = parseFloat((document.getElementById('beQty')||{}).value);
  var u = parseFloat((document.getElementById('beUnitPrice')||{}).value);
  var amtEl = document.getElementById('beAmt');
  if (amtEl && !isNaN(q) && !isNaN(u)) { amtEl.value = (Math.round(q*u*100)/100); }
}

async function submitBizExpense() {
  var desc = (document.getElementById('beDesc')||{}).value?.trim();
  var qty  = (document.getElementById('beQty')||{}).value?.trim();
  var amt  = parseFloat((document.getElementById('beAmt')||{}).value||0);
  var cat  = (document.getElementById('beCat')||{}).value;
  var paid = (document.getElementById('bePaid')||{}).value;
  var ref  = (document.getElementById('beRef')||{}).value?.trim();
  var notes= (document.getElementById('beNotes')||{}).value?.trim();
  var date = (document.getElementById('beDate')||{}).value;
  var store= (document.getElementById('beStore')||{}).value?.trim();
  var unit = (document.getElementById('beUnit')||{}).value?.trim();
  var uprice=(document.getElementById('beUnitPrice')||{}).value?.trim();

  if (!desc) { showToast('Enter description','error'); return; }
  if (!amt||amt<=0) { showToast('Enter valid amount','error'); return; }

  var r = await api('addBusinessExpense',{ description:desc, amount:amt, qty:qty, category:cat, paidVia:paid, referenceNo:ref, notes:notes, expenseDate:date, store:store, unit:unit, unitPrice:uprice });
  if (r.ok) {
    showToast('Expense recorded ✅');
    ['beDesc','beAmt','beQty','beRef','beNotes','beStore','beUnit','beUnitPrice'].forEach(function(id){ var el=document.getElementById(id); if(el)el.value=''; });
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

// ══ EXPENSE REDESIGN: grouping, purchase form, detail drawer, receive flow ══
function _expGroupRecords(list){
  var groups={}, order=[];
  (list||[]).forEach(function(e){
    var key = e.expense_group_id || ('_solo_'+e.id);
    if(!groups[key]){ groups[key]={key:key, lines:[], supplier:e.store, date:e.expense_date, category:e.category, paid:e.paid_via, ref:e.reference_no, notes:e.notes}; order.push(key); }
    groups[key].lines.push(e);
  });
  return order.map(function(k){ var g=groups[k];
    g.total=g.lines.reduce(function(s,l){return s+parseFloat(l.amount);},0);
    g.received=g.lines.some(function(l){return l.inv_received;});
    g.allReceived=g.lines.every(function(l){return l.inv_received;});
    return g; });
}

// ── multi-line purchase form ─────────────────────────────────────────────────
var _expLines=[{}];
function _expModal(inner){
  var m=document.createElement('div'); m.id='expModal';
  m.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10000;display:flex;align-items:flex-start;justify-content:center;padding:14px;overflow:auto';
  m.innerHTML='<div style="background:#fff;border-radius:14px;max-width:600px;width:100%;padding:18px;margin-top:16px">'+inner+'</div>';
  document.body.appendChild(m);
}
function _expCloseModal(){ var m=document.getElementById('expModal'); if(m) m.remove(); }
function _expField(l,i){ return '<label style="font-size:.72rem;font-weight:700;color:var(--forest-deep);display:block;margin-top:8px">'+l+'</label>'+i; }
function _expInput(id,t,ph,v){ return '<input id="'+id+'" type="'+(t||'text')+'"'+(ph?' placeholder="'+ph+'"':'')+(v!=null?' value="'+escH(v)+'"':'')+' style="width:100%;margin-top:3px;font-size:.82rem;padding:8px;border:1.5px solid var(--mist);border-radius:8px">'; }

function _expOpenPurchaseForm(){
  _expLines=[{}];
  var catOpts=BIZ_CATEGORIES.map(function(c){return '<option'+(c==='Stocks & Groceries'?' selected':'')+'>'+c+'</option>';}).join('');
  var payOpts=PAID_VIA_OPTS.map(function(c){return '<option>'+c+'</option>';}).join('');
  var inner='<div style="font-size:1rem;font-weight:800;color:var(--forest-deep)">Record Purchase / Expense</div>'
    +'<div style="font-size:.66rem;color:var(--timber);margin-bottom:10px">One receipt can hold many line items. Financial record only — never deducts stock.</div>'
    +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'
      +'<div>'+_expField('Supplier / store',_expInput('epSupplier','text','e.g. S&R, Meralco'))+'</div>'
      +'<div>'+_expField('Date',_expInput('epDate','date','',new Date().toISOString().split('T')[0]))+'</div></div>'
    +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'
      +'<div>'+_expField('Category','<select id="epCat" style="width:100%;margin-top:3px;font-size:.82rem;padding:8px;border:1.5px solid var(--mist);border-radius:8px">'+catOpts+'</select>')+'</div>'
      +'<div>'+_expField('Payment','<select id="epPaid" style="width:100%;margin-top:3px;font-size:.82rem;padding:8px;border:1.5px solid var(--mist);border-radius:8px">'+payOpts+'</select>')+'</div></div>'
    +_expField('OR / Reference no. (optional)',_expInput('epRef','text','OR-12345'))
    +'<div style="font-size:.66rem;color:var(--timber);text-transform:uppercase;letter-spacing:.4px;font-weight:800;margin:14px 0 4px">Line items</div>'
    +'<div id="epLines"></div>'
    +'<button onclick="_expAddLine()" style="font-size:.72rem;font-weight:700;background:var(--mist-light);color:var(--forest);border:none;border-radius:7px;padding:7px 12px;cursor:pointer;margin-top:4px">+ Add line</button>'
    +'<div id="epTotals" style="margin-top:12px;background:var(--mist-light);border-radius:8px;padding:10px 12px"></div>'
    +_expField('Notes (optional)',_expInput('epNotes','text',''))
    +'<div style="display:flex;gap:8px;margin-top:14px"><button onclick="_expCloseModal()" style="flex:1;font-size:.82rem;font-weight:700;background:var(--mist-light);color:var(--forest);border:none;border-radius:8px;padding:10px;cursor:pointer">Cancel</button>'
    +'<button onclick="_expSavePurchase()" style="flex:2;font-size:.82rem;font-weight:700;background:var(--forest);color:#fff;border:none;border-radius:8px;padding:10px;cursor:pointer">Save purchase</button></div>';
  _expModal(inner);
  _expRenderLines();
}
function _expRenderLines(){
  var box=document.getElementById('epLines'); if(!box) return;
  var h='<div style="display:grid;grid-template-columns:1fr 52px 54px 62px 62px 24px;gap:4px;font-size:.6rem;color:var(--timber);font-weight:700;text-transform:uppercase;margin-bottom:2px"><span>Item</span><span>Qty</span><span>Unit</span><span>Unit ₱</span><span>Total</span><span></span></div>';
  _expLines.forEach(function(l,i){
    h+='<div style="display:grid;grid-template-columns:1fr 52px 54px 62px 62px 24px;gap:4px;margin-bottom:4px;align-items:center">'
      +'<input id="el_d_'+i+'" value="'+(l.description!=null?escH(l.description):'')+'" placeholder="item" style="font-size:.76rem;padding:6px;border:1.5px solid var(--mist);border-radius:6px">'
      +'<input id="el_q_'+i+'" type="number" step="0.001" value="'+(l.qty!=null?escH(l.qty):'')+'" oninput="_expLineCalc('+i+')" style="font-size:.76rem;padding:6px;border:1.5px solid var(--mist);border-radius:6px">'
      +'<input id="el_u_'+i+'" value="'+(l.unit!=null?escH(l.unit):'')+'" placeholder="pc" style="font-size:.74rem;padding:6px;border:1.5px solid var(--mist);border-radius:6px">'
      +'<input id="el_p_'+i+'" type="number" step="0.01" value="'+(l.unitPrice!=null?escH(l.unitPrice):'')+'" oninput="_expLineCalc('+i+')" style="font-size:.76rem;padding:6px;border:1.5px solid var(--mist);border-radius:6px">'
      +'<input id="el_t_'+i+'" type="number" step="0.01" value="'+(l.amount!=null?escH(l.amount):'')+'" oninput="_expTotals()" style="font-size:.76rem;padding:6px;border:1.5px solid var(--mist);border-radius:6px">'
      +'<button onclick="_expRemoveLine('+i+')" style="font-size:.85rem;background:none;border:none;color:#b91c1c;cursor:pointer">✕</button>'
      +'</div>';
  });
  box.innerHTML=h;
  _expTotals();
}
function _expSyncLines(){
  _expLines.forEach(function(l,i){
    var d=document.getElementById('el_d_'+i),q=document.getElementById('el_q_'+i),u=document.getElementById('el_u_'+i),p=document.getElementById('el_p_'+i),t=document.getElementById('el_t_'+i);
    if(d)l.description=d.value; if(q)l.qty=q.value; if(u)l.unit=u.value; if(p)l.unitPrice=p.value; if(t)l.amount=t.value;
  });
}
function _expLineCalc(i){
  var q=parseFloat((document.getElementById('el_q_'+i)||{}).value), p=parseFloat((document.getElementById('el_p_'+i)||{}).value), t=document.getElementById('el_t_'+i);
  if(t && !isNaN(q) && !isNaN(p)) t.value=Math.round(q*p*100)/100;
  _expTotals();
}
function _expTotals(){
  _expSyncLines();
  var box=document.getElementById('epTotals'); if(!box) return;
  var total=_expLines.reduce(function(s,l){return s+(parseFloat(l.amount)||0);},0);
  box.innerHTML='<div style="display:flex;justify-content:space-between;font-size:.9rem"><span style="color:var(--timber)">Total</span><b style="color:#dc2626">'+peso(total)+'</b></div>';
}
function _expAddLine(){ _expSyncLines(); _expLines.push({}); _expRenderLines(); }
function _expRemoveLine(i){ _expSyncLines(); _expLines.splice(i,1); if(!_expLines.length)_expLines=[{}]; _expRenderLines(); }
async function _expSavePurchase(){
  _expSyncLines();
  var supplier=(document.getElementById('epSupplier')||{}).value.trim();
  var category=(document.getElementById('epCat')||{}).value;
  var paidVia=(document.getElementById('epPaid')||{}).value;
  var referenceNo=(document.getElementById('epRef')||{}).value.trim();
  var expenseDate=(document.getElementById('epDate')||{}).value;
  var notes=(document.getElementById('epNotes')||{}).value.trim();
  var lines=_expLines.filter(function(l){return (l.description||'').trim() && parseFloat(l.amount)>0;})
    .map(function(l){return {description:l.description.trim(), qty:l.qty, unit:l.unit, unitPrice:l.unitPrice, amount:parseFloat(l.amount)};});
  if(!lines.length){ showToast('Add at least one line item with a total','error'); return; }
  var r=await api('saveExpensePurchase',{supplier:supplier,category:category,paidVia:paidVia,referenceNo:referenceNo,expenseDate:expenseDate,notes:notes,lines:lines});
  if(r&&r.ok){ showToast('Purchase recorded ('+r.lines+' item'+(r.lines>1?'s':'')+') ✅'); _expCloseModal(); await loadBizExpenses(); renderExpensesView(); }
  else showToast('Failed: '+((r&&r.error)||'Unknown'),'error');
}

// ── detail drawer ────────────────────────────────────────────────────────────
function _expOpenDetail(key){
  var g=_expGroupRecords(_bizExpenses).filter(function(x){return x.key===key;})[0]; if(!g) return;
  var host=document.getElementById('expDrawerHost'); if(!host) return;
  var ico=BIZ_CAT_ICON[g.category]||'💼';
  var invEligible=BIZ_INV_CATS.indexOf(g.category)>-1;
  var h='<div onclick="_expCloseDrawer(event)" style="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9998">'
    +'<div onclick="event.stopPropagation()" style="position:absolute;top:0;right:0;height:100%;width:400px;max-width:93vw;background:#fff;box-shadow:-4px 0 24px rgba(0,0,0,.18);overflow:auto;padding:18px">'
    +'<div style="display:flex;justify-content:space-between;align-items:flex-start"><div><div style="font-size:.62rem;color:var(--timber);text-transform:uppercase;letter-spacing:.5px;font-weight:700">Purchase / Expense</div>'
    +'<div style="font-size:1.05rem;font-weight:800;color:var(--forest-deep)">'+ico+' '+escH(g.supplier||g.lines[0].description)+'</div></div>'
    +'<button onclick="_expCloseDrawer()" style="background:var(--mist-light);border:none;border-radius:8px;width:30px;height:30px;cursor:pointer;font-size:1rem;color:var(--forest)">✕</button></div>'
    +'<div style="margin:10px 0"><div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--mist-light);font-size:.76rem"><span style="color:var(--timber)">Date</span><span style="font-weight:600;color:var(--forest-deep)">'+(g.date||'').substring(0,10)+'</span></div>'
    +'<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--mist-light);font-size:.76rem"><span style="color:var(--timber)">Category</span><span style="font-weight:700;color:var(--forest)">'+escH(g.category)+'</span></div>'
    +'<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--mist-light);font-size:.76rem"><span style="color:var(--timber)">Payment</span><span style="font-weight:600;color:var(--forest-deep)">'+escH(g.paid)+'</span></div>'
    +(g.ref?'<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--mist-light);font-size:.76rem"><span style="color:var(--timber)">Reference</span><span style="font-weight:600;color:var(--forest-deep)">'+escH(g.ref)+'</span></div>':'')
    +'</div>'
    +'<div style="font-size:.66rem;color:var(--timber);text-transform:uppercase;letter-spacing:.4px;font-weight:700;margin:8px 0 4px">Itemized lines</div>'
    +'<table style="width:100%;border-collapse:collapse;font-size:.74rem"><thead><tr style="color:var(--timber);font-size:.62rem;text-transform:uppercase"><th style="text-align:left;padding:3px">Item</th><th style="text-align:right;padding:3px">Qty</th><th style="text-align:right;padding:3px">Unit ₱</th><th style="text-align:right;padding:3px">Total</th></tr></thead><tbody>';
  g.lines.forEach(function(l){
    h+='<tr style="border-top:1px solid var(--mist-light)"><td style="padding:4px 3px;color:var(--forest-deep)">'+escH(l.description)+(l.inv_received?' <span style="color:#15803d;font-size:.6rem">✓ received</span>':'')+'</td>'
      +'<td style="text-align:right;padding:4px 3px;color:var(--timber)">'+(l.qty?escH(l.qty)+(l.unit?' '+escH(l.unit):''):'—')+'</td>'
      +'<td style="text-align:right;padding:4px 3px;color:var(--timber)">'+(l.unit_price?peso(l.unit_price):'—')+'</td>'
      +'<td style="text-align:right;padding:4px 3px;font-weight:700;color:var(--forest-deep)">'+peso(l.amount)+'</td></tr>';
  });
  h+='</tbody></table>';
  h+='<div style="display:flex;justify-content:space-between;margin-top:8px;padding-top:8px;border-top:2px solid var(--mist);font-size:.9rem"><b style="color:var(--timber)">Total</b><b style="color:#dc2626">'+peso(g.total)+'</b></div>';
  // inventory linkage
  h+='<div style="font-size:.66rem;color:var(--timber);text-transform:uppercase;letter-spacing:.4px;font-weight:700;margin:16px 0 6px">Inventory linkage</div>';
  if(g.allReceived){
    h+='<div style="background:#e7f3ea;border-radius:8px;padding:10px 12px;font-size:.76rem;color:#15803d;font-weight:600">✓ All items received to Inventory. Physical stock units were created in Stock Control. The financial amount is not duplicated.</div>';
  } else if(invEligible){
    h+='<div style="font-size:.72rem;color:var(--timber);margin-bottom:8px">This is a physical purchase. You can optionally receive items into Stock Control (creates physical stock units). This is explicit — saving the expense did not create any stock.</div>';
    g.lines.filter(function(l){return !l.inv_received;}).forEach(function(l){
      h+='<button onclick="_expOpenReceive(\''+l.id+'\')" style="display:block;width:100%;text-align:left;font-size:.74rem;font-weight:700;background:#fff;color:var(--forest);border:1.5px solid var(--forest);border-radius:8px;padding:8px 10px;cursor:pointer;margin-bottom:6px">📦 Receive "'+escH(l.description)+'" to Inventory</button>';
    });
  } else {
    h+='<div style="background:var(--mist-light);border-radius:8px;padding:10px 12px;font-size:.74rem;color:var(--timber)">No inventory linkage — this is a '+escH(g.category)+' expense (not physical stock).</div>';
  }
  h+='</div></div>';
  host.innerHTML=h;
}
function _expCloseDrawer(e){ var h=document.getElementById('expDrawerHost'); if(h) h.innerHTML=''; }

// ── receive-to-inventory flow (explicit; pre-filled from expense) ────────────
async function _expOpenReceive(expenseId){
  var line=null; _bizExpenses.forEach(function(e){ if(String(e.id)===String(expenseId)) line=e; });
  if(!line){ showToast('Line not found','error'); return; }
  // fetch inv items + units + locations fresh
  var itemsR=await api('invListItems',{activeOnly:true}); var items=(itemsR&&itemsR.ok)?(itemsR.items||[]):[];
  var refR=await api('invGetRefData',{}); var units=(refR&&refR.ok)?(refR.units||[]):[]; var locs=(refR&&refR.ok)?(refR.locations||[]):[];
  if(!items.length){ showToast('Create matching inventory Items first (Stock Control → Items)','error'); return; }
  var itemOpts=items.map(function(it){return '<option value="'+it.id+'" data-unit="'+it.base_unit_id+'">'+escH(it.name)+'</option>';}).join('');
  var unitOpts=units.map(function(u){return '<option value="'+u.id+'">'+escH(u.name)+'</option>';}).join('');
  var locOpts='<option value="">—</option>'+locs.map(function(l){return '<option value="'+l.id+'">'+escH(l.name)+'</option>';}).join('');
  var qtyPre = line.qty ? parseFloat(line.qty)||'' : '';
  var costPre = line.unit_price!=null ? line.unit_price : '';
  var inner='<div style="font-size:1rem;font-weight:800;color:var(--forest-deep)">Receive to Inventory</div>'
    +'<div style="font-size:.66rem;color:var(--timber);margin-bottom:4px">Pre-filled from expense: <b>'+escH(line.description)+'</b>'+(line.store?(' · '+escH(line.store)):'')+'</div>'
    +'<div style="font-size:.64rem;color:#b45309;margin-bottom:10px">You must pick the matching inventory item and confirm. Only then is physical stock created (inv_* module). The expense record is unchanged; the financial amount is not duplicated.</div>'
    +_expField('Inventory item',' <select id="rvItem" onchange="_expRvUnit()" style="width:100%;margin-top:3px;font-size:.82rem;padding:8px;border:1.5px solid var(--mist);border-radius:8px">'+itemOpts+'</select>')
    +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><div>'+_expField('Quantity',_expInput('rvQty','number','',qtyPre))+'</div><div>'+_expField('Unit','<select id="rvUnit" style="width:100%;margin-top:3px;font-size:.82rem;padding:8px;border:1.5px solid var(--mist);border-radius:8px">'+unitOpts+'</select>')+'</div></div>'
    +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><div>'+_expField('Unit cost ₱',_expInput('rvCost','number','',costPre))+'</div><div>'+_expField('Location','<select id="rvLoc" style="width:100%;margin-top:3px;font-size:.82rem;padding:8px;border:1.5px solid var(--mist);border-radius:8px">'+locOpts+'</select>')+'</div></div>'
    +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><div>'+_expField('Expiry (optional)',_expInput('rvExp','date'))+'</div><div>'+_expField('Expected use (optional)',_expInput('rvUse','date'))+'</div></div>'
    +'<input type="hidden" id="rvExpId" value="'+escH(line.id)+'">'
    +'<div style="display:flex;gap:8px;margin-top:14px"><button onclick="_expCloseModal2()" style="flex:1;font-size:.82rem;font-weight:700;background:var(--mist-light);color:var(--forest);border:none;border-radius:8px;padding:10px;cursor:pointer">Cancel</button>'
    +'<button onclick="_expReceiveSubmit(\''+escH(line.reference_no||'')+'\',\''+escH(line.expense_date||'')+'\',\''+escH(line.store||'')+'\')" style="flex:2;font-size:.82rem;font-weight:700;background:var(--forest);color:#fff;border:none;border-radius:8px;padding:10px;cursor:pointer">Confirm — Receive Stock</button></div>';
  var m=document.createElement('div'); m.id='expModal2';
  m.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:10001;display:flex;align-items:flex-start;justify-content:center;padding:14px;overflow:auto';
  m.innerHTML='<div style="background:#fff;border-radius:14px;max-width:460px;width:100%;padding:18px;margin-top:16px">'+inner+'</div>';
  document.body.appendChild(m);
  setTimeout(_expRvUnit,20);
}
function _expCloseModal2(){ var m=document.getElementById('expModal2'); if(m) m.remove(); }
function _expRvUnit(){ var s=document.getElementById('rvItem'); if(!s)return; var u=s.options[s.selectedIndex].getAttribute('data-unit'); var us=document.getElementById('rvUnit'); if(us&&u)us.value=u; }
async function _expReceiveSubmit(ref, date, supplier){
  var itemId=+(document.getElementById('rvItem')||{}).value;
  var qty=parseFloat((document.getElementById('rvQty')||{}).value);
  var unitId=+(document.getElementById('rvUnit')||{}).value;
  var expId=(document.getElementById('rvExpId')||{}).value;
  if(!itemId){ showToast('Pick an inventory item','error'); return; }
  if(!(qty>0)){ showToast('Enter quantity','error'); return; }
  var r=await api('invReceiveStock',{itemId:itemId,qty:qty,unitId:unitId,
    unitCost:parseFloat((document.getElementById('rvCost')||{}).value)||0,
    locationId:+(document.getElementById('rvLoc')||{}).value||null,
    expiryDate:(document.getElementById('rvExp')||{}).value||null,
    expectedUseDate:(document.getElementById('rvUse')||{}).value||null,
    notes:'From expense'+(ref?(' '+ref):'')+(supplier?(' · '+supplier):'')});
  if(r&&r.ok){
    await api('markExpenseReceived',{id:expId, stockUnitId:r.stock_unit_id});
    showToast('Received to inventory: '+(r.stock_unit_code||'')+' ✅');
    _expCloseModal2(); _expCloseDrawer(); await loadBizExpenses(); renderExpensesView();
  } else showToast('Receive failed: '+((r&&r.error)||''),'error');
}
