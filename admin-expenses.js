// ══════════════════════════════════════════════════════════════════════════
// EXPENSES — clean financial + purchasing screen (redesign)
// Preserves data (business_expenses) + wires purchases to immutable inv_purchases.
// Saving a purchase creates financial + purchase history ONLY — never inventory.
// ══════════════════════════════════════════════════════════════════════════
var _bizExpenses = [];
var _bizPurch    = {};          // purchase_group -> summary (received status)
var _expItems    = [];          // inv_items (mapping)
var _expUnits    = [];          // inv_units (normalization)
var _expLocs     = [];          // inv_locations
var _bizMonth = new Date().getMonth() + 1;
var _bizYear  = new Date().getFullYear();
var _expCat    = 'All';
var _expSupplier = 'All';
var _expSearch = '';
var _expQuick  = 'ALL';         // ALL | PURCHASES | UTILITIES | OPERATING
var _expLines  = [{}];

var BIZ_CATEGORIES = ['Stocks & Groceries','Utilities','Electricity','Water','Internet / Cable','Gas / Fuel','Rent','Equipment Repair','Packaging','Cleaning / Supplies','Office / Admin','Marketing','Transport / Delivery','Other'];
var PURCHASE_CATS  = ['Stocks & Groceries','Packaging','Cleaning / Supplies'];
var UTILITY_CATS   = ['Utilities','Electricity','Water','Internet / Cable','Gas / Fuel','Rent'];
var PAID_VIA_OPTS  = ['Cash','GCash','BPI','BDO','UnionBank','Auto-pay','Other'];
var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function peso(n){ return '₱' + Math.abs(parseFloat(n)||0).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function escH(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
function _expIsUtil(c){ return UTILITY_CATS.indexOf(c)>-1; }
// Parse pack count from item name: "24s"=24, "6s"=6, "190/4s"=4 (last N before a trailing s)
function _expPackCount(name){
  if(!name) return null; var m, last=null, re=/(\d+)\s*s\b/gi;
  while((m=re.exec(String(name)))!==null){ last=parseInt(m[1],10); }
  return (last && last>1) ? last : null;
}
function _expIsPurchCat(c){ return PURCHASE_CATS.indexOf(c)>-1; }

async function initExpenses(){
  var v=document.getElementById('expensesView'); if(v) v.innerHTML='<div style="padding:32px;text-align:center;color:var(--timber)">Loading expenses…</div>';
  await loadBizExpenses();
  try { var pr=await api('invListPurchases',{}); if(pr&&pr.ok){ _bizPurch={}; (pr.purchases||[]).forEach(function(p){_bizPurch[p.purchase_group]=p;}); } } catch(e){}
  try { var ir=await api('invListItems',{activeOnly:true}); _expItems=(ir&&ir.ok)?(ir.items||[]):[]; } catch(e){}
  try { var rr=await api('invGetRefData',{}); if(rr&&rr.ok){ _expUnits=rr.units||[]; _expLocs=rr.locations||[]; } } catch(e){}
  renderExpensesView();
}
async function loadBizExpenses(){
  try{ var r=await api('getBusinessExpenses',{month:_bizMonth,year:_bizYear}); if(r.ok) _bizExpenses=r.expenses||[]; }catch(e){}
}

// group business_expenses rows into records (purchase = grouped/purchase_group; else general)
function _expRecords(){
  var groups={}, order=[];
  (_bizExpenses||[]).forEach(function(e){
    var key = e.purchase_group || e.expense_group_id || ('_solo_'+e.id);
    if(!groups[key]){ groups[key]={key:key, pgroup:e.purchase_group||null, lines:[], supplier:e.store, date:e.expense_date, category:e.category, paid:e.paid_via, ref:e.reference_no, notes:e.notes, desc:e.description}; order.push(key); }
    groups[key].lines.push(e);
  });
  return order.map(function(k){ var g=groups[k];
    g.total=g.lines.reduce(function(s,l){return s+parseFloat(l.amount||0);},0);
    g.isPurchase = !!g.pgroup || g.lines.length>1 || (_expIsPurchCat(g.category) && (g.lines[0].unit||g.lines[0].qty));
    g.allReceived=g.lines.every(function(l){return l.inv_received;});
    g.anyReceived=g.lines.some(function(l){return l.inv_received;});
    if(g.pgroup && _bizPurch[g.pgroup]){ g.recStatus=_bizPurch[g.pgroup].receiving_status; g.lineCount=_bizPurch[g.pgroup].line_count; }
    else if(g.isPurchase){ g.recStatus = g.allReceived?'RECEIVED':(g.anyReceived?'PARTIAL':'NOT_RECEIVED'); g.lineCount=g.lines.length; }
    return g; });
}
function _expFiltered(){
  var recs=_expRecords(), q=_expSearch.trim().toLowerCase();
  return recs.filter(function(g){
    if(_expCat!=='All' && g.category!==_expCat) return false;
    if(_expSupplier!=='All' && (g.supplier||'')!==_expSupplier) return false;
    if(_expQuick==='PURCHASES' && !g.isPurchase) return false;
    if(_expQuick==='UTILITIES' && !_expIsUtil(g.category)) return false;
    if(_expQuick==='OPERATING' && (g.isPurchase||_expIsUtil(g.category))) return false;
    if(q){ var hay=((g.supplier||'')+' '+(g.desc||'')+' '+(g.category||'')+' '+(g.ref||'')).toLowerCase(); if(hay.indexOf(q)<0) return false; }
    return true;
  });
}

function renderExpensesView(){
  var view=document.getElementById('expensesView'); if(!view) return;
  if(!document.getElementById('expStyles')){ var stEl=document.createElement('style'); stEl.id='expStyles';
    stEl.textContent='@media(max-width:640px){.exp-sum{gap:6px !important}.exp-sum .exp-cardnum{font-size:1.05rem !important}}';
    document.head.appendChild(stEl); }
  var recs=_expRecords();
  var totalExp=recs.reduce(function(s,g){return s+g.total;},0);
  var purchTot=recs.filter(function(g){return g.isPurchase;}).reduce(function(s,g){return s+g.total;},0);
  var utilTot=recs.filter(function(g){return _expIsUtil(g.category);}).reduce(function(s,g){return s+g.total;},0);
  var period=MONTHS[_bizMonth-1]+' '+_bizYear;

  var h='<div style="max-width:1200px;margin:0 auto;padding:14px 16px 80px">';
  // header
  h+='<div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:14px">';
  h+='<div><h2 style="margin:0;color:var(--forest-deep);font-size:1.3rem">💰 Expenses</h2>'
    +'<div style="font-size:.74rem;color:var(--timber);margin-top:2px">Track business spending and build YANI\u2019s purchasing history.</div></div>';
  h+='<div style="display:flex;gap:8px;flex-wrap:wrap">'
    +'<button onclick="_expScanReceipt()" style="background:#fff;color:var(--forest);border:1.5px solid var(--forest);border-radius:var(--r-sm,8px);padding:9px 16px;font-size:.8rem;font-weight:700;cursor:pointer;white-space:nowrap">📷 Scan / Upload</button>'
    +'<button onclick="_expOpenRecord()" style="background:var(--forest);color:#fff;border:none;border-radius:var(--r-sm,8px);padding:9px 16px;font-size:.8rem;font-weight:700;cursor:pointer;white-space:nowrap">+ Record Purchase</button>'
    +'</div>';
  h+='</div>';
  // 3 summary cards
  h+='<div class="exp-sum" style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px">';
  h+=_expCard('Total Expenses',totalExp,period,'#15803d');
  h+=_expCard('Purchases',purchTot,period,'#b45309');
  h+=_expCard('Utilities & Bills',utilTot,period,'#1d4ed8');
  h+='</div>';
  // filter bar
  h+='<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:10px">';
  var mSel='<select onchange="_bizMonth=+this.value;initExpenses()" style="'+_expSelCss()+'">';
  for(var mi=1;mi<=12;mi++) mSel+='<option value="'+mi+'"'+(mi===_bizMonth?' selected':'')+'>'+MONTHS[mi-1]+'</option>';
  mSel+='</select>'; h+=mSel;
  var yNow=new Date().getFullYear(); var ySel='<select onchange="_bizYear=+this.value;initExpenses()" style="'+_expSelCss()+'">';
  for(var y=yNow;y>=yNow-3;y--) ySel+='<option value="'+y+'"'+(y===_bizYear?' selected':'')+'>'+y+'</option>';
  ySel+='</select>'; h+=ySel;
  var cSel='<select onchange="_expCat=this.value;renderExpensesView()" style="'+_expSelCss()+'"><option value="All">All Categories</option>';
  BIZ_CATEGORIES.forEach(function(c){ cSel+='<option value="'+escH(c)+'"'+(_expCat===c?' selected':'')+'>'+escH(c)+'</option>'; });
  cSel+='</select>'; h+=cSel;
  var sups=[]; _expRecords().forEach(function(g){ if(g.supplier && sups.indexOf(g.supplier)<0) sups.push(g.supplier); });
  var supSel='<select onchange="_expSupplier=this.value;renderExpensesView()" style="'+_expSelCss()+'"><option value="All">All Suppliers</option>';
  sups.sort().forEach(function(s){ supSel+='<option'+(_expSupplier===s?' selected':'')+'>'+escH(s)+'</option>'; });
  supSel+='</select>'; h+=supSel;
  h+='<input value="'+escH(_expSearch)+'" oninput="_expSearch=this.value;_expRenderTable()" placeholder="🔍 Search purchases…" style="flex:1;min-width:150px;font-size:.76rem;padding:7px 10px;border:1.5px solid var(--mist);border-radius:8px">';
  h+='</div>';
  // quick filters
  h+='<div style="display:flex;gap:6px;margin-bottom:12px">';
  [['ALL','All'],['PURCHASES','Purchases'],['UTILITIES','Utilities'],['OPERATING','Operating']].forEach(function(f){
    var on=_expQuick===f[0];
    h+='<button onclick="_expQuick=\''+f[0]+'\';renderExpensesView()" style="font-size:.72rem;font-weight:600;border-radius:20px;padding:5px 13px;cursor:pointer;border:1.5px solid '+(on?'var(--forest);background:var(--forest);color:#fff':'var(--mist);background:#fff;color:var(--timber)')+'">'+f[1]+'</button>';
  });
  h+='</div>';
  h+='<div id="expTableWrap"></div>';
  h+='</div><div id="expDrawerHost"></div>';
  view.innerHTML=h;
  _expRenderTable();
}
function _expSelCss(){ return 'font-size:.74rem;padding:7px 9px;border:1.5px solid var(--mist);border-radius:8px;background:#fff;color:var(--forest-deep)'; }
function _expCard(label,val,period,color){
  return '<div style="background:#fff;border:1px solid var(--mist);border-radius:12px;padding:13px 15px">'
    +'<div style="font-size:.64rem;color:var(--timber);text-transform:uppercase;letter-spacing:.4px;font-weight:700">'+label+'</div>'
    +'<div style="font-size:1.5rem;font-weight:800;color:'+color+';line-height:1.15;margin-top:3px">'+peso(val)+'</div>'
    +'<div style="font-size:.64rem;color:var(--timber);margin-top:1px">This period ('+period+')</div></div>';
}

function _expRenderTable(){
  var wrap=document.getElementById('expTableWrap'); if(!wrap) return;
  var recs=_expFiltered();
  if(!recs.length){ wrap.innerHTML='<div style="background:#fff;border:1px dashed var(--mist);border-radius:12px;padding:40px;text-align:center;color:var(--timber);font-size:.82rem">No records for this filter.</div>'; return; }
  var h='<div style="background:#fff;border:1px solid var(--mist);border-radius:12px;overflow:auto;max-height:calc(100vh - 300px)">';
  h+='<table style="width:100%;border-collapse:collapse;font-size:.76rem;min-width:1000px">';
  h+='<thead><tr style="background:var(--forest-deep)">';
  ['Date','Supplier / Store','Description','Qty','Unit Price','Category','Amount','Inventory','Status'].forEach(function(c,i){
    h+='<th style="position:sticky;top:0;z-index:2;background:var(--forest-deep);text-align:'+(i===6?'right':'left')+';padding:9px 12px;color:#fff;font-weight:700;font-size:.64rem;text-transform:uppercase;letter-spacing:.3px;white-space:nowrap">'+c+'</th>'; });
  h+='</tr></thead><tbody>';
  recs.forEach(function(g,idx){
    var bg=idx%2?'var(--mist-light)':'#fff';
    var _l0=g.lines[0];
    var _multi=(g.pgroup||g.lines.length>1);
    var _q=(_l0.qty!=null&&_l0.qty!=='')?_expFmt(_l0.qty):'';
    var _u=_l0.unit||'';
    var _up=(_l0.unit_price!=null&&_l0.unit_price!=='')?parseFloat(_l0.unit_price):null;
    // fall back to effective per-unit = amount / qty when unit_price missing
    if(_up==null && _q && parseFloat(_l0.qty)>0 && _l0.amount) _up=Math.round((parseFloat(_l0.amount)/parseFloat(_l0.qty))*100)/100;
    // pack count from item name ("24s" = 24 pcs, "6s" = 6, "190/4s" = 4) — only for pack-type units
    var _packUnits=['case','pk','pack','box','tray','set','bundle','dozen','ctn','carton'];
    var _pack=_expPackCount(_l0.description);
    var _perPc=(_pack && _up!=null && _packUnits.indexOf((_u||'').toLowerCase())>-1) ? Math.round((_up/_pack)*100)/100 : null;
    var _totalPcs=(_pack && _q) ? _expFmt(parseFloat(_l0.qty)*_pack) : null;
    var qtyCell = _multi ? '<span style="color:var(--timber)">'+((g.lineCount||g.lines.length)+' lines')+'</span>'
      : (_q ? '<span style="font-weight:600;color:var(--forest-deep)">'+_q+(_u?' '+escH(_u):'')+'</span>'+(_totalPcs?'<div style="font-size:.64rem;color:var(--timber)">'+_totalPcs+' pcs</div>':'') : '<span style="color:var(--timber)">—</span>');
    var upCell = _multi ? '<span style="color:var(--timber)">—</span>'
      : (_up!=null ? '<span style="color:var(--forest-deep)">'+peso(_up)+(_u?' <span style="color:var(--timber)">/ '+escH(_u)+'</span>':'')+'</span>'+(_perPc!=null?'<div style="font-size:.64rem;color:var(--gold);font-weight:700">'+peso(_perPc)+' / pc</div>':'') : '<span style="color:var(--timber)">—</span>');
    var desc;
    if(g.pgroup){ desc=escH((g.lineCount||1)+' item'+((g.lineCount||1)>1?'s':'')); }
    else if(g.lines.length>1){ desc=escH(g.lines.length+' items'); }
    else { desc=escH(_l0.description||g.desc||'—'); }
    var badge = g.isPurchase
      ? '<span style="font-size:.58rem;font-weight:700;background:#eef5ff;color:#1d4ed8;padding:1px 6px;border-radius:4px;margin-left:6px">Purchase</span>'
      : '<span style="font-size:.58rem;font-weight:700;background:var(--mist-light);color:var(--timber);padding:1px 6px;border-radius:4px;margin-left:6px">Expense</span>';
    var inv = !g.isPurchase ? '<span style="color:var(--timber)">—</span>'
      : (g.recStatus==='RECEIVED' ? '<span style="color:#15803d">received</span>'
        : g.recStatus==='PARTIAL' ? '<span style="color:#b45309">partial</span>'
        : '<span style="color:var(--timber)">not received</span>');
    var status = !g.isPurchase ? '<span style="font-size:.62rem;font-weight:700;color:var(--timber);background:var(--mist-light);padding:2px 8px;border-radius:5px">N/A</span>' : _expStatusBadge(g.recStatus);
    h+='<tr onclick="_expOpenDetail(\''+g.key+'\')" style="cursor:pointer;background:'+bg+';border-top:1px solid var(--mist-light)" onmouseover="this.style.background=\'#eef5f0\'" onmouseout="this.style.background=\''+bg+'\'">'
      +'<td style="padding:9px 12px;color:var(--forest-deep);font-weight:600;white-space:nowrap">'+_expDate(g.date)+'</td>'
      +'<td style="padding:9px 12px;color:var(--forest-deep);white-space:nowrap">'+escH(g.supplier||'—')+'</td>'
      +'<td style="padding:9px 12px;color:var(--forest-deep)">'+desc+badge+'</td>'
      +'<td style="padding:9px 12px;font-size:.74rem;white-space:nowrap">'+qtyCell+'</td>'
      +'<td style="padding:9px 12px;font-size:.74rem;white-space:nowrap">'+upCell+'</td>'
      +'<td style="padding:9px 12px;color:var(--timber);white-space:nowrap">'+escH(g.category||'—')+'</td>'
      +'<td style="padding:9px 12px;text-align:right;font-weight:700;color:#dc2626;white-space:nowrap">'+peso(g.total)+'</td>'
      +'<td style="padding:9px 12px;font-size:.72rem;white-space:nowrap">'+inv+'</td>'
      +'<td style="padding:9px 12px;white-space:nowrap">'+status+'</td></tr>';
  });
  h+='</tbody></table></div>';
  h+='<div style="font-size:.68rem;color:var(--timber);margin-top:6px">Showing '+recs.length+' record'+(recs.length!==1?'s':'')+'</div>';
  wrap.innerHTML=h;
}
function _expStatusBadge(st){
  var m={RECEIVED:{bg:'#e7f3ea',fg:'#15803d',t:'Received'},PARTIAL:{bg:'#fef3c7',fg:'#b45309',t:'Partial'},NOT_RECEIVED:{bg:'#fde8e8',fg:'#b91c1c',t:'Not Received'}};
  var c=m[st]||m.NOT_RECEIVED;
  return '<span style="font-size:.62rem;font-weight:700;color:'+c.fg+';background:'+c.bg+';padding:2px 8px;border-radius:5px">'+c.t+'</span>';
}
function _expDate(d){ if(!d) return '—'; try{ var x=new Date(d); return MONTHS[x.getMonth()]+' '+x.getDate(); }catch(e){ return String(d).substring(0,10);} }

// ── DETAIL DRAWERS ──────────────────────────────────────────────────────────
function _expCloseDrawer(e){ var h=document.getElementById('expDrawerHost'); if(h) h.innerHTML=''; }
function _expDrawerShell(inner){
  return '<div onclick="_expCloseDrawer(event)" style="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9998">'
    +'<div onclick="event.stopPropagation()" style="position:absolute;top:0;right:0;height:100%;width:410px;max-width:94vw;background:#fff;box-shadow:-4px 0 24px rgba(0,0,0,.18);overflow:auto;padding:20px">'+inner+'</div></div>';
}
function _expDrawerRow(k,v){ return '<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:.78rem"><span style="color:var(--timber)">'+k+'</span><span style="font-weight:600;color:var(--forest-deep)">'+v+'</span></div>'; }

async function _expOpenDetail(key){
  var g=_expRecords().filter(function(x){return x.key===key;})[0]; if(!g) return;
  var host=document.getElementById('expDrawerHost'); if(!host) return;
  if(!g.isPurchase){ host.innerHTML=_expGeneralDrawer(g); return; }
  host.innerHTML=_expDrawerShell('<div style="padding:30px;text-align:center;color:var(--timber)">Loading…</div>');
  // new-style purchase -> pull immutable normalized lines
  var lines=null, summary=null;
  if(g.pgroup){ try{ var r=await api('invGetPurchase',{purchaseGroup:g.pgroup}); if(r&&r.ok){ lines=r.lines; summary=r.summary; } }catch(e){} }
  host.innerHTML=_expPurchaseDrawer(g, lines, summary);
}

function _expPurchaseDrawer(g, lines, summary){
  var sup = (summary&&summary.supplier_name)||g.supplier||'Purchase';
  var date=(summary&&summary.purchase_date)||g.date, pay=(summary&&summary.payment_method)||g.paid, ref=(summary&&summary.reference_no)||g.ref, cat=(summary&&summary.category)||g.category;
  var h='<div style="display:flex;justify-content:space-between;align-items:flex-start">'
    +'<div><div style="font-size:.62rem;color:var(--timber);text-transform:uppercase;letter-spacing:.5px;font-weight:700">Purchase</div>'
    +'<div style="font-size:1.15rem;font-weight:800;color:var(--forest-deep)">'+escH(sup)+'</div></div>'
    +'<button onclick="_expCloseDrawer()" style="background:var(--mist-light);border:none;border-radius:8px;width:30px;height:30px;cursor:pointer;font-size:1rem;color:var(--forest)">✕</button></div>';
  h+='<div style="display:flex;gap:12px;flex-wrap:wrap;font-size:.72rem;color:var(--timber);margin:8px 0 4px">'
    +'<span>🗓 '+_expDateFull(date)+'</span>'+(pay?'<span>💳 '+escH(pay)+'</span>':'')+(ref?'<span>🧾 '+escH(ref)+'</span>':'')+'</div>';
  h+='<div style="font-size:.72rem;color:var(--timber);margin-bottom:10px">Category: <b style="color:var(--forest)">'+escH(cat||'—')+'</b></div>';
  if(g.notes) h+='<div style="font-size:.72rem;color:var(--forest-deep);margin:-6px 0 10px"><span style="color:var(--timber)">Notes:</span> '+escH(g.notes)+'</div>';
  // items
  h+='<div style="font-size:.64rem;color:var(--timber);text-transform:uppercase;letter-spacing:.4px;font-weight:700;margin:6px 0 4px">Items</div>';
  h+='<table style="width:100%;border-collapse:collapse;font-size:.72rem"><thead><tr style="color:var(--timber);font-size:.58rem;text-transform:uppercase"><th style="text-align:left;padding:3px 2px">Item</th><th style="text-align:right;padding:3px 2px">Qty</th><th style="text-align:right;padding:3px 2px">Unit ₱</th><th style="text-align:right;padding:3px 2px">Total</th></tr></thead><tbody>';
  var total=0;
  var rows = lines || g.lines.map(function(l){return {item_name:l.description, quantity:l.qty, purchase_unit:l.unit, unit_price:l.unit_price, total_price:l.amount, base_unit_cost:null, base_unit:null, _status:(l.inv_received?'RECEIVED':'NOT_RECEIVED')};});
  rows.forEach(function(l){
    total+=parseFloat(l.total_price||l.amount||0);
    h+='<tr style="border-top:1px solid var(--mist-light)"><td style="padding:5px 2px;color:var(--forest-deep);font-weight:600">'+escH(l.item_name)
      +(l._status==='RECEIVED'?' <span style="color:#15803d;font-size:.58rem">✓</span>':l._status==='PARTIAL'?' <span style="color:#b45309;font-size:.58rem">◐</span>':'')+'</td>'
      +'<td style="text-align:right;padding:5px 2px;color:var(--timber);white-space:nowrap">'+(l.quantity?escH(_expFmt(l.quantity))+(l.purchase_unit?' '+escH(l.purchase_unit):''):'—')+'</td>'
      +'<td style="text-align:right;padding:5px 2px;color:var(--timber)">'+(l.unit_price?peso(l.unit_price):'—')+'</td>'
      +'<td style="text-align:right;padding:5px 2px;font-weight:700;color:var(--forest-deep)">'+peso(l.total_price||l.amount)+'</td></tr>';
  });
  h+='</tbody></table>';
  h+='<div style="display:flex;justify-content:space-between;margin-top:8px;padding-top:8px;border-top:2px solid var(--mist);font-size:.95rem"><b style="color:var(--timber)">Total</b><b style="color:#dc2626">'+peso(total)+'</b></div>';
  // normalized purchase history (per line base unit cost)
  if(lines && lines.some(function(l){return l.base_unit_cost!=null;})){
    h+='<div style="font-size:.64rem;color:var(--timber);text-transform:uppercase;letter-spacing:.4px;font-weight:700;margin:14px 0 4px">Purchase history (normalized)</div>';
    lines.forEach(function(l){ if(l.base_unit_cost!=null) h+='<div style="display:flex;justify-content:space-between;font-size:.72rem;padding:2px 0"><span style="color:var(--forest-deep)">'+escH(l.item_name)+'</span><span style="color:var(--forest);font-weight:700">₱'+parseFloat(l.base_unit_cost).toFixed(2)+' / '+escH(l.base_unit||'')+'</span></div>'; });
  }
  // inventory status + receive
  h+='<div style="font-size:.64rem;color:var(--timber);text-transform:uppercase;letter-spacing:.4px;font-weight:700;margin:16px 0 6px">Inventory</div>';
  var st=g.recStatus||'NOT_RECEIVED';
  // per-line receiving detail (received / remaining / stock code)
  if(lines){
    h+='<div style="margin-bottom:8px">';
    lines.forEach(function(l){
      var pq=parseFloat(l.base_quantity||l.quantity||0), rq=parseFloat(l._received||0), rem=Math.max(0,pq-rq);
      var bu=l.base_unit||l.purchase_unit||'';
      var badge=l._status==='RECEIVED'?'<span style="color:#15803d;font-weight:700">received</span>':l._status==='PARTIAL'?'<span style="color:#b45309;font-weight:700">partial</span>':'<span style="color:var(--timber)">not received</span>';
      h+='<div style="font-size:.7rem;padding:5px 0;border-bottom:1px solid var(--mist-light)">'
        +'<div style="display:flex;justify-content:space-between"><span style="color:var(--forest-deep);font-weight:600">'+escH(l.item_name)+'</span>'+badge+'</div>'
        +'<div style="color:var(--timber);margin-top:1px">received '+_expFmt(rq)+' / '+_expFmt(pq)+' '+escH(bu)+' · remaining '+_expFmt(rem)+' '+escH(bu)
        +((l._received_codes&&l._received_codes.length)?(' · '+l._received_codes.map(escH).join(', ')):'')+'</div></div>';
    });
    h+='</div>';
  }
  if(st==='RECEIVED'){ h+='<div style="background:#e7f3ea;border-radius:8px;padding:10px 12px;font-size:.76rem;color:#15803d;font-weight:600">✓ All items received to inventory. Physical stock was created; the financial amount is not duplicated.</div>'; }
  else {
    h+='<div style="background:'+(st==='PARTIAL'?'#fef8ec':'#fff8ec')+';border:1px solid #f0d9a8;border-radius:8px;padding:10px 12px;margin-bottom:8px">'
      +'<div style="font-size:.78rem;font-weight:700;color:#b45309">'+(st==='PARTIAL'?'Partially received':'Not received to inventory yet')+'</div>'
      +'<div style="font-size:.68rem;color:var(--timber);margin-top:2px">Saving this purchase did not create stock. Receiving is explicit.</div></div>';
    if(lines){ lines.forEach(function(l){ if(l._status!=='RECEIVED' && l.item_id){ h+='<button onclick="_expOpenReceiveLine('+l.id+','+l.item_id+',\''+escH(l.item_name).replace(/\x27/g,'')+'\','+(l.base_quantity||l.quantity||0)+','+(l.base_unit_id||l.purchase_unit_id||'null')+','+(l.unit_price||0)+',\''+escH(ref||'')+'\',\''+escH(sup||'')+'\','+(l._received||0)+')" style="display:block;width:100%;text-align:left;font-size:.74rem;font-weight:700;background:#fff;color:var(--forest);border:1.5px solid var(--forest);border-radius:8px;padding:8px 10px;cursor:pointer;margin-bottom:6px">📦 Receive \u201c'+escH(l.item_name)+'\u201d to Inventory</button>'; } }); }
    else { h+='<div style="font-size:.68rem;color:var(--timber)">This purchase\u2019s items aren\u2019t mapped to inventory items, so receiving isn\u2019t available. Map items in Stock Control \u2192 Items to enable receiving.</div>'; }
  }
  return _expDrawerShell(h + _expOwnerActions(g));
}

function _expGeneralDrawer(g){
  var l=g.lines[0];
  var h='<div style="display:flex;justify-content:space-between;align-items:flex-start">'
    +'<div><div style="font-size:.62rem;color:var(--timber);text-transform:uppercase;letter-spacing:.5px;font-weight:700">Expense</div>'
    +'<div style="font-size:1.15rem;font-weight:800;color:var(--forest-deep)">'+escH(g.desc||l.description||'Expense')+'</div></div>'
    +'<button onclick="_expCloseDrawer()" style="background:var(--mist-light);border:none;border-radius:8px;width:30px;height:30px;cursor:pointer;font-size:1rem;color:var(--forest)">✕</button></div>';
  h+='<div style="font-size:.72rem;color:var(--timber);margin:6px 0 12px">🗓 '+_expDateFull(g.date)+'</div>';
  if(g.supplier||l.store) h+=_expDrawerRow('Supplier / Payee', escH(g.supplier||l.store));
  h+=_expDrawerRow('Category', escH(g.category||'—'));
  if(l.qty||l.unit_price!=null) h+=_expDrawerRow('Qty', escH(_expFmt(l.qty||''))+(l.unit?' '+escH(l.unit):'')+(l.unit_price!=null?' × '+peso(l.unit_price):''));
  h+=_expDrawerRow('Amount', '<span style="color:#dc2626">'+peso(g.total)+'</span>');
  h+=_expDrawerRow('Payment', escH(g.paid||'—'));
  h+=_expDrawerRow('Status', l.is_paid===false?'<span style="color:#b45309">Unpaid / Due</span>':'<span style="color:#15803d">Paid</span>');
  if(g.ref) h+=_expDrawerRow('Reference', escH(g.ref));
  if(g.notes) h+='<div style="margin-top:8px;font-size:.74rem;color:var(--forest-deep)"><span style="color:var(--timber)">Notes:</span> '+escH(g.notes)+'</div>';
  h+='<div style="font-size:.64rem;color:var(--timber);text-transform:uppercase;letter-spacing:.4px;font-weight:700;margin:16px 0 6px">Inventory</div>';
  h+='<div style="background:var(--mist-light);border-radius:8px;padding:10px 12px;font-size:.74rem;color:var(--timber)">ⓘ Not applicable — this is a '+escH(g.category||'general')+' expense, not physical stock.</div>';
  return _expDrawerShell(h + _expOwnerActions(g));
}
function _expDateFull(d){ if(!d)return '—'; try{ var x=new Date(d); return MONTHS[x.getMonth()]+' '+x.getDate()+', '+x.getFullYear(); }catch(e){ return String(d).substring(0,10);} }
function _expFmt(n){ var x=parseFloat(n); if(isNaN(x))return n; return x%1===0?String(x):x.toFixed(2).replace(/\.?0+$/,''); }

// ── RECORD FORM (Purchase / General Expense toggle) ─────────────────────────
var _expRecMode='purchase';
function _expModal(inner){
  var m=document.createElement('div'); m.id='expModal';
  m.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10000;display:flex;align-items:flex-start;justify-content:center;padding:16px;overflow:auto';
  m.innerHTML='<div style="background:#fff;border-radius:14px;max-width:560px;width:100%;padding:20px;margin-top:18px">'+inner+'</div>';
  document.body.appendChild(m);
}
function _expCloseModal(){ var m=document.getElementById('expModal'); if(m) m.remove(); }
function _expField(l,i){ return '<label style="font-size:.72rem;font-weight:700;color:var(--forest-deep);display:block;margin-top:8px">'+l+'</label>'+i; }
function _expInput(id,t,ph,v){ return '<input id="'+id+'" type="'+(t||'text')+'"'+(ph?' placeholder="'+ph+'"':'')+(v!=null?' value="'+escH(v)+'"':'')+' style="width:100%;margin-top:3px;font-size:.82rem;padding:8px;border:1.5px solid var(--mist);border-radius:8px">'; }
function _expSel(id,opts,onch){ return '<select id="'+id+'"'+(onch?' onchange="'+onch+'"':'')+' style="width:100%;margin-top:3px;font-size:.82rem;padding:8px;border:1.5px solid var(--mist);border-radius:8px">'+opts+'</select>'; }

function _expVal(id){ var e=document.getElementById(id); return e ? String(e.value||'').trim() : ''; }
function _expPaidOpts(isPaid){ return '<option value="PAID"'+(isPaid!==false?' selected':'')+'>Paid</option><option value="UNPAID"'+(isPaid===false?' selected':'')+'>Unpaid / Due</option>'; }
function _expOpenRecord(){ _expRecMode='purchase'; _expLines=[{}]; _expModal(_expRecordShell()); _expRenderLines(); }
function _expRecordShell(){
  var tab=function(m,label){ var on=_expRecMode===m; return '<button onclick="_expSetMode(\''+m+'\')" style="flex:1;padding:8px;font-size:.8rem;font-weight:700;border:none;cursor:pointer;border-radius:8px;'+(on?'background:var(--forest);color:#fff':'background:var(--mist-light);color:var(--timber)')+'">'+label+'</button>'; };
  return '<div style="display:flex;gap:6px;margin-bottom:14px">'+tab('purchase','Purchase')+tab('general','General Expense')+'</div>'
    +'<div id="expFormBody">'+(_expRecMode==='purchase'?_expPurchaseForm():_expGeneralForm())+'</div>';
}
function _expSetMode(m){ _expRecMode=m; var b=document.getElementById('expModal'); if(b) b.querySelector('div').innerHTML=_expRecordShell(); if(m==='purchase') _expRenderLines(); }

function _expPurchaseForm(){
  var catOpts=BIZ_CATEGORIES.map(function(c){return '<option'+(c==='Stocks & Groceries'?' selected':'')+'>'+escH(c)+'</option>';}).join('');
  var payOpts=PAID_VIA_OPTS.map(function(c){return '<option>'+escH(c)+'</option>';}).join('');
  var today=new Date().toISOString().split('T')[0];
  return '<div style="font-size:.64rem;color:var(--timber);margin-bottom:8px">Itemized purchase → financial + immutable purchasing history. Never creates stock.</div>'
    +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'
      +'<div>'+_expField('Supplier / Store *',_expInput('epSup','text','e.g. S&R'))+'</div>'
      +'<div>'+_expField('Purchase Date *',_expInput('epDate','date','',today))+'</div></div>'
    +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'
      +'<div>'+_expField('OR / Reference',_expInput('epRef','text','OR-12345'))+'</div>'
      +'<div>'+_expField('Payment Method *',_expSel('epPay',payOpts))+'</div></div>'
    +'<div style="font-size:.64rem;color:var(--timber);text-transform:uppercase;letter-spacing:.4px;font-weight:800;margin:14px 0 4px">Purchase items</div>'
    +'<datalist id="expItemList">'+_expItems.map(function(it){return '<option value="'+escH(it.name)+'">';}).join('')+'</datalist>'
    +'<div id="epLines"></div>'
    +'<button onclick="_expAddLine()" style="font-size:.72rem;font-weight:700;background:var(--mist-light);color:var(--forest);border:none;border-radius:7px;padding:7px 12px;cursor:pointer;margin-top:4px">+ Add Item</button>'
    +'<div id="epTotals" style="margin-top:10px;background:var(--mist-light);border-radius:8px;padding:9px 12px"></div>'
    +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:4px">'
      +'<div>'+_expField('Category',_expSel('epCat',catOpts))+'</div>'
      +'<div>'+_expField('Notes',_expInput('epNotes','text',''))+'</div></div>'
    +'<div style="display:flex;gap:8px;margin-top:16px"><button onclick="_expCloseModal()" style="flex:1;font-size:.82rem;font-weight:700;background:var(--mist-light);color:var(--forest);border:none;border-radius:8px;padding:10px;cursor:pointer">Cancel</button>'
    +'<button onclick="_expSavePurchase()" style="flex:2;font-size:.82rem;font-weight:700;background:var(--forest);color:#fff;border:none;border-radius:8px;padding:10px;cursor:pointer">Save Purchase</button></div>';
}
function _expUnitOpts(sel){ return '<option value="">unit</option>'+_expUnits.map(function(u){return '<option value="'+u.id+'"'+(sel==u.id?' selected':'')+'>'+escH(u.name)+'</option>';}).join(''); }
function _expRenderLines(){
  var box=document.getElementById('epLines'); if(!box) return;
  var G='display:grid;grid-template-columns:1fr 42px 48px 50px 58px 56px 18px;gap:3px';
  var h='<div style="'+G+';font-size:.54rem;color:var(--timber);font-weight:700;text-transform:uppercase;margin-bottom:2px"><span>Item</span><span>Qty</span><span>Unit</span><span>Unit ₱</span><span>₱/base</span><span>Total</span><span></span></div>';
  _expLines.forEach(function(l,i){
    h+='<div style="'+G+';margin-bottom:4px;align-items:center">'
      +'<input id="el_i_'+i+'" list="expItemList" value="'+(l.item!=null?escH(l.item):'')+'" placeholder="item" style="font-size:.72rem;padding:5px;border:1.5px solid var(--mist);border-radius:6px">'
      +'<input id="el_q_'+i+'" type="number" step="0.001" value="'+(l.qty!=null?escH(l.qty):'')+'" oninput="_expLineCalc('+i+')" style="font-size:.72rem;padding:5px;border:1.5px solid var(--mist);border-radius:6px">'
      +'<select id="el_u_'+i+'" onchange="_expLineCalc('+i+')" style="font-size:.66rem;padding:5px;border:1.5px solid var(--mist);border-radius:6px">'+_expUnitOpts(l.unitId)+'</select>'
      +'<input id="el_p_'+i+'" type="number" step="0.01" value="'+(l.unitPrice!=null?escH(l.unitPrice):'')+'" oninput="_expLineCalc('+i+')" style="font-size:.72rem;padding:5px;border:1.5px solid var(--mist);border-radius:6px">'
      +'<input id="el_n_'+i+'" readonly title="normalized cost per base unit" style="font-size:.66rem;padding:5px;border:1.5px solid var(--mist);border-radius:6px;background:#eef5ff;color:#1d4ed8;font-weight:700">'
      +'<input id="el_t_'+i+'" type="number" step="0.01" value="'+(l.total!=null?escH(l.total):'')+'" readonly style="font-size:.72rem;padding:5px;border:1.5px solid var(--mist);border-radius:6px;background:var(--mist-light)">'
      +'<button onclick="_expRemoveLine('+i+')" style="font-size:.8rem;background:none;border:none;color:#b91c1c;cursor:pointer">✕</button></div>';
  });
  box.innerHTML=h;
  _expLines.forEach(function(l,i){ _expLineCalc(i); });
  _expTotals();
}
function _expSyncLines(){ _expLines.forEach(function(l,i){
  var g=function(id){var e=document.getElementById(id);return e?e.value:undefined;};
  l.item=g('el_i_'+i); l.qty=g('el_q_'+i); l.unitId=g('el_u_'+i); l.unitPrice=g('el_p_'+i); l.total=g('el_t_'+i);
}); }
function _expLineCalc(i){
  var q=parseFloat((document.getElementById('el_q_'+i)||{}).value), p=parseFloat((document.getElementById('el_p_'+i)||{}).value);
  var t=document.getElementById('el_t_'+i), n=document.getElementById('el_n_'+i);
  if(t&&!isNaN(q)&&!isNaN(p)) t.value=Math.round(q*p*100)/100;
  if(n){ var uid=+(document.getElementById('el_u_'+i)||{}).value; var u=_expUnits.filter(function(x){return x.id===uid;})[0];
    if(u && !isNaN(p)){ var rate=parseFloat(u.conversion_rate)||1; var bc=p/rate; var b=u.base_unit_id?(_expUnits.filter(function(x){return x.id===u.base_unit_id;})[0]||{}).name:u.name; n.value='₱'+(Math.round(bc*100)/100)+'/'+(b||''); }
    else n.value=''; }
  _expTotals();
}
function _expTotals(){ _expSyncLines(); var box=document.getElementById('epTotals'); if(!box)return; var total=_expLines.reduce(function(s,l){return s+(parseFloat(l.total)||0);},0);
  box.innerHTML='<div style="display:flex;justify-content:space-between;font-size:.78rem;color:var(--timber)"><span>Subtotal</span><span>'+peso(total)+'</span></div>'
    +'<div style="display:flex;justify-content:space-between;font-size:.95rem;margin-top:3px;padding-top:3px;border-top:1px solid var(--mist)"><span style="color:var(--timber);font-weight:700">TOTAL</span><b style="color:#dc2626">'+peso(total)+'</b></div>'; }
function _expAddLine(){ _expSyncLines(); _expLines.push({}); _expRenderLines(); }
function _expRemoveLine(i){ _expSyncLines(); _expLines.splice(i,1); if(!_expLines.length)_expLines=[{}]; _expRenderLines(); }

function _expNormalize(qty, unitId){
  var u=_expUnits.filter(function(x){return x.id===+unitId;})[0];
  if(!u) return {baseUnitId:null, baseUnit:null, baseQuantity:qty};
  var rate=parseFloat(u.conversion_rate)||1;
  if(u.base_unit_id){ var b=_expUnits.filter(function(x){return x.id===u.base_unit_id;})[0]; return {baseUnitId:u.base_unit_id, baseUnit:b?b.name:null, baseQuantity:qty*rate}; }
  return {baseUnitId:u.id, baseUnit:u.name, baseQuantity:qty*rate};
}
async function _expSavePurchase(){
  _expSyncLines();
  var supplier=(document.getElementById('epSup')||{}).value.trim();
  var date=(document.getElementById('epDate')||{}).value;
  var ref=(document.getElementById('epRef')||{}).value.trim();
  var pay=(document.getElementById('epPay')||{}).value;
  var cat=(document.getElementById('epCat')||{}).value;
  var notes=(document.getElementById('epNotes')||{}).value.trim();
  if(!supplier){ showToast('Enter supplier / store','error'); return; }
  var lines=_expLines.filter(function(l){return (l.item||'').trim() && parseFloat(l.qty)>0 && parseFloat(l.unitPrice)>=0;});
  if(!lines.length){ showToast('Add at least one item with qty and price','error'); return; }
  var payload={ supplierName:supplier, store:supplier, purchaseDate:date, referenceNo:ref, paymentMethod:pay, category:cat, notes:notes,
    lines:lines.map(function(l){
      var name=l.item.trim(); var match=_expItems.filter(function(it){return it.name.toLowerCase()===name.toLowerCase();})[0];
      var uObj=_expUnits.filter(function(x){return x.id===+l.unitId;})[0];
      var norm=_expNormalize(parseFloat(l.qty), l.unitId);
      return { itemId:match?match.id:null, itemName:name, quantity:parseFloat(l.qty), purchaseUnitId:l.unitId?+l.unitId:null, purchaseUnit:uObj?uObj.name:'', unitPrice:parseFloat(l.unitPrice),
        baseUnitId:norm.baseUnitId, baseUnit:norm.baseUnit, baseQuantity:norm.baseQuantity };
    }) };
  var r=await api('invSavePurchase', payload);
  if(r&&r.ok){ showToast('Purchase recorded ('+r.lines+' item'+(r.lines>1?'s':'')+') ✅'); _expCloseModal(); await initExpenses(); }
  else showToast('Failed: '+((r&&r.error)||'Unknown'),'error');
}

function _expGeneralForm(){
  var catOpts=BIZ_CATEGORIES.map(function(c){return '<option'+(c==='Water'?'':'')+'>'+escH(c)+'</option>';}).join('');
  var payOpts=PAID_VIA_OPTS.map(function(c){return '<option>'+escH(c)+'</option>';}).join('');
  var today=new Date().toISOString().split('T')[0];
  return '<div style="font-size:.64rem;color:var(--timber);margin-bottom:8px">Simple expense — no itemization, no inventory link (water, rent, repairs, etc.).</div>'
    +_expField('Expense Title *',_expInput('geTitle','text','e.g. Water Bill'))
    +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'
      +'<div>'+_expField('Supplier / Payee',_expInput('geStore','text','e.g. Amadeo Water District'))+'</div>'
      +'<div>'+_expField('Category *',_expSel('geCat',catOpts))+'</div></div>'
    +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'
      +'<div>'+_expField('Expense Date *',_expInput('geDate','date','',today))+'</div>'
      +'<div>'+_expField('Amount *',_expInput('geAmt','number','0'))+'</div></div>'
    +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'
      +'<div>'+_expField('Payment Method *',_expSel('gePay',payOpts))+'</div>'
      +'<div>'+_expField('Status',_expSel('gePaid',_expPaidOpts(true)))+'</div></div>'
    +'<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">'
      +'<div>'+_expField('Qty',_expInput('geQty','text','optional'))+'</div>'
      +'<div>'+_expField('Unit',_expInput('geUnit','text','e.g. tank'))+'</div>'
      +'<div>'+_expField('Unit price',_expInput('geUP','number','optional'))+'</div></div>'
    +_expField('Reference No. (optional)',_expInput('geRef','text',''))
    +_expField('Notes (optional)',_expInput('geNotes','text',''))
    +'<div style="display:flex;gap:8px;margin-top:16px"><button onclick="_expCloseModal()" style="flex:1;font-size:.82rem;font-weight:700;background:var(--mist-light);color:var(--forest);border:none;border-radius:8px;padding:10px;cursor:pointer">Cancel</button>'
    +'<button onclick="_expSaveGeneral()" style="flex:2;font-size:.82rem;font-weight:700;background:var(--forest);color:#fff;border:none;border-radius:8px;padding:10px;cursor:pointer">Save Expense</button></div>';
}
async function _expSaveGeneral(){
  var title=(document.getElementById('geTitle')||{}).value.trim();
  var cat=(document.getElementById('geCat')||{}).value;
  var date=(document.getElementById('geDate')||{}).value;
  var amt=parseFloat((document.getElementById('geAmt')||{}).value);
  var pay=(document.getElementById('gePay')||{}).value;
  var ref=(document.getElementById('geRef')||{}).value.trim();
  var notes=(document.getElementById('geNotes')||{}).value.trim();
  var store=_expVal('geStore'), qty=_expVal('geQty'), unit=_expVal('geUnit'), up=_expVal('geUP');
  var paid=_expVal('gePaid')!=='UNPAID';
  if(!title){ showToast('Enter a title','error'); return; }
  if(!(amt>0)){ showToast('Enter amount','error'); return; }
  var r=await api('addBusinessExpense',{ description:title, amount:amt, category:cat, paidVia:pay, referenceNo:ref, notes:notes, expenseDate:date,
    store:store, qty:qty, unit:unit, unitPrice:up, isPaid:paid });
  if(r&&r.ok){ showToast('Expense saved ✅'); _expCloseModal(); await initExpenses(); }
  else showToast('Failed: '+((r&&r.error)||'Unknown'),'error');
}

// ── RECEIVE TO INVENTORY (explicit; from a purchase line) ───────────────────
function _expOpenReceiveLine(lineId,itemId,itemName,baseQty,baseUnitId,unitCost,ref,supplier,alreadyRecv){
  var unitOpts=_expUnits.map(function(u){return '<option value="'+u.id+'"'+(baseUnitId==u.id?' selected':'')+'>'+escH(u.name)+'</option>';}).join('');
  var pq=parseFloat(baseQty)||0, ar=parseFloat(alreadyRecv)||0, rem=Math.max(0,pq-ar);
  var bu=(_expUnits.filter(function(x){return x.id===+baseUnitId;})[0]||{}).name||'';
  var inner='<div style="font-size:1rem;font-weight:800;color:var(--forest-deep)">Receive to Inventory</div>'
    +'<div style="font-size:.66rem;color:var(--timber);margin-bottom:4px">From purchase: <b>'+escH(itemName)+'</b>'+(supplier?(' · '+escH(supplier)):'')+(ref?(' · '+escH(ref)):'')+'</div>'
    +'<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;background:var(--mist-light);border-radius:8px;padding:8px 10px;margin-bottom:10px;font-size:.66rem">'
      +'<div><div style="color:var(--timber)">Purchased</div><b style="color:var(--forest-deep)">'+_expFmt(pq)+' '+escH(bu)+'</b></div>'
      +'<div><div style="color:var(--timber)">Already received</div><b style="color:var(--forest-deep)">'+_expFmt(ar)+' '+escH(bu)+'</b></div>'
      +'<div><div style="color:var(--timber)">Remaining</div><b style="color:#b45309">'+_expFmt(rem)+' '+escH(bu)+'</b></div></div>'
    +'<div style="font-size:.64rem;color:#b45309;margin-bottom:10px">Confirm to create physical stock (inv_* module). The purchase & financial records are unchanged.</div>'
    +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><div>'+_expField('Receive now',_expInput('rvQty','number','',rem||''))+'</div><div>'+_expField('Unit',_expSel('rvUnit',unitOpts))+'</div></div>'
    +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><div>'+_expField('Unit cost ₱',_expInput('rvCost','number','',unitCost||''))+'</div><div>'+_expField('Location',_expSel('rvLoc','<option value="">—</option>'+(_expLocs||[]).map(function(l){return '<option value="'+l.id+'">'+escH(l.name)+'</option>';}).join('')))+'</div></div>'
    +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><div>'+_expField('Batch (optional)',_expInput('rvBatch','text',''))+'</div><div>'+_expField('Expiry (optional)',_expInput('rvExp','date'))+'</div></div>'
    +'<input type="hidden" id="rvLine" value="'+lineId+'"><input type="hidden" id="rvItem" value="'+itemId+'">'
    +'<div style="display:flex;gap:8px;margin-top:14px"><button onclick="_expCloseModal2()" style="flex:1;font-size:.82rem;font-weight:700;background:var(--mist-light);color:var(--forest);border:none;border-radius:8px;padding:10px;cursor:pointer">Cancel</button>'
    +'<button onclick="_expReceiveSubmit(\''+escH(ref||'')+'\',\''+escH(supplier||'')+'\')" style="flex:2;font-size:.82rem;font-weight:700;background:var(--forest);color:#fff;border:none;border-radius:8px;padding:10px;cursor:pointer">Confirm — Receive Stock</button></div>';
  var m=document.createElement('div'); m.id='expModal2'; m.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:10002;display:flex;align-items:flex-start;justify-content:center;padding:14px;overflow:auto';
  m.innerHTML='<div style="background:#fff;border-radius:14px;max-width:460px;width:100%;padding:18px;margin-top:20px">'+inner+'</div>';
  document.body.appendChild(m);
}
function _expCloseModal2(){ var m=document.getElementById('expModal2'); if(m) m.remove(); }
async function _expReceiveSubmit(ref,supplier){
  var lineId=+(document.getElementById('rvLine')||{}).value, itemId=+(document.getElementById('rvItem')||{}).value;
  var qty=parseFloat((document.getElementById('rvQty')||{}).value), unitId=+(document.getElementById('rvUnit')||{}).value;
  if(!(qty>0)){ showToast('Enter quantity','error'); return; }
  var r=await api('invReceiveStock',{ itemId:itemId, qty:qty, unitId:unitId, unitCost:parseFloat((document.getElementById('rvCost')||{}).value)||0, locationId:+(document.getElementById('rvLoc')||{}).value||null, expiryDate:(document.getElementById('rvExp')||{}).value||null, purchaseLineId:lineId, notes:'Received from purchase'+(ref?(' '+ref):'')+(supplier?(' · '+supplier):'')+(((document.getElementById('rvBatch')||{}).value)?(' · batch '+(document.getElementById('rvBatch')||{}).value):'') });
  if(r&&r.ok){ showToast('Received to inventory: '+(r.stock_unit_code||'')+' ✅'); _expCloseModal2(); _expCloseDrawer(); await initExpenses(); }
  else showToast('Failed: '+((r&&r.error)||'Unknown'),'error');
}

// ── OWNER edit / void (keeps record for audit; drops from totals) ───────────
function _expIsOwner(){ return currentUser && currentUser.role==='OWNER'; }
function _expOwnerActions(g){
  if(!_expIsOwner()) return '';
  return '<div style="display:flex;gap:8px;margin-top:18px;padding-top:12px;border-top:1px solid var(--mist-light)">'
    +'<button onclick="_expOpenEdit(\''+g.key+'\')" style="flex:1;font-size:.78rem;font-weight:700;background:var(--mist-light);color:var(--forest);border:none;border-radius:8px;padding:9px;cursor:pointer">✏️ Edit</button>'
    +'<button onclick="_expVoid(\''+g.key+'\')" style="flex:1;font-size:.78rem;font-weight:700;background:#fff;color:#b91c1c;border:1.5px solid #f0caca;border-radius:8px;padding:9px;cursor:pointer">🚫 Void</button>'
    +'</div>';
}
function _expOpenEdit(key){
  if(!_expIsOwner()){ showToast('OWNER only','error'); return; }
  var g=_expRecords().filter(function(x){return x.key===key;})[0]; if(!g) return;
  var l0=g.lines[0], isPurchase=g.isPurchase;
  var catOpts=BIZ_CATEGORIES.map(function(c){return '<option'+(g.category===c?' selected':'')+'>'+escH(c)+'</option>';}).join('');
  var payOpts=PAID_VIA_OPTS.map(function(c){return '<option'+(g.paid===c?' selected':'')+'>'+escH(c)+'</option>';}).join('');
  var body;
  if(isPurchase){
    body='<div style="font-size:.64rem;color:var(--timber);margin-bottom:8px">Edit the purchase header. Line prices are immutable — to change item prices, void this purchase and re-add it.</div>'
      +_expField('Supplier / Store',_expInput('edSup','text','',g.supplier||''))
      +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><div>'+_expField('Date',_expInput('edDate','date','',g.date))+'</div><div>'+_expField('Payment',_expSel('edPay',payOpts))+'</div></div>'
      +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><div>'+_expField('Category',_expSel('edCat',catOpts))+'</div><div>'+_expField('Reference',_expInput('edRef','text','',g.ref||''))+'</div></div>'
      +_expField('Notes',_expInput('edNotes','text','',g.notes||''));
  } else {
    body=_expField('Title',_expInput('edDesc','text','',g.desc||l0.description||''))
      +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><div>'+_expField('Supplier / Payee',_expInput('edStore','text','',g.supplier||l0.store||''))+'</div><div>'+_expField('Category',_expSel('edCat',catOpts))+'</div></div>'
      +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><div>'+_expField('Date',_expInput('edDate','date','',g.date))+'</div><div>'+_expField('Amount',_expInput('edAmt','number','',g.total))+'</div></div>'
      +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><div>'+_expField('Payment',_expSel('edPay',payOpts))+'</div><div>'+_expField('Status',_expSel('edPaid',_expPaidOpts(l0.is_paid)))+'</div></div>'
      +'<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">'
        +'<div>'+_expField('Qty',_expInput('edQty','text','',l0.qty||''))+'</div>'
        +'<div>'+_expField('Unit',_expInput('edUnit','text','',l0.unit||''))+'</div>'
        +'<div>'+_expField('Unit price',_expInput('edUP','number','',l0.unit_price!=null?l0.unit_price:''))+'</div></div>'
      +_expField('Reference',_expInput('edRef','text','',g.ref||''))
      +_expField('Notes',_expInput('edNotes','text','',g.notes||''));
  }
  _expModal('<div style="font-size:1rem;font-weight:800;color:var(--forest-deep);margin-bottom:8px">Edit '+(isPurchase?'purchase':'expense')+'</div>'+body
    +'<div style="display:flex;gap:8px;margin-top:16px"><button onclick="_expCloseModal()" style="flex:1;font-size:.82rem;font-weight:700;background:var(--mist-light);color:var(--forest);border:none;border-radius:8px;padding:10px;cursor:pointer">Cancel</button>'
    +'<button onclick="_expSaveEdit(\''+key+'\','+(isPurchase?'true':'false')+')" style="flex:2;font-size:.82rem;font-weight:700;background:var(--forest);color:#fff;border:none;border-radius:8px;padding:10px;cursor:pointer">Save changes</button></div>');
}
async function _expSaveEdit(key, isPurchase){
  var g=_expRecords().filter(function(x){return x.key===key;})[0]; if(!g) return;
  var V=function(id){var e=document.getElementById(id);return e?e.value:undefined;};
  var payload={};
  if(isPurchase){ payload={ store:V('edSup'), expenseDate:V('edDate'), paidVia:V('edPay'), category:V('edCat'), referenceNo:V('edRef'), notes:V('edNotes') }; }
  else { payload={ description:V('edDesc'), amount:V('edAmt'), expenseDate:V('edDate'), category:V('edCat'), paidVia:V('edPay'), referenceNo:V('edRef'), notes:V('edNotes'),
    store:V('edStore'), qty:V('edQty'), unit:V('edUnit'), unitPrice:V('edUP'), isPaid:(V('edPaid')!=='UNPAID') }; }
  var ok=true;
  for(var i=0;i<g.lines.length;i++){
    var r=await api('updateExpense', Object.assign({id:g.lines[i].id}, payload));
    if(!(r&&r.ok)) ok=false;
    if(!isPurchase) break;   // general expense is a single row
  }
  if(ok){ showToast('Saved ✅'); _expCloseModal(); _expCloseDrawer(); await initExpenses(); }
  else showToast('Failed to save','error');
}
async function _expVoid(key){
  if(!_expIsOwner()){ showToast('OWNER only','error'); return; }
  var g=_expRecords().filter(function(x){return x.key===key;})[0]; if(!g) return;
  var reason=prompt('Void "'+(g.supplier||g.desc||'this record')+'" (₱'+g.total.toFixed(2)+')?\n\nThe record is KEPT for audit but removed from your totals.\n\nReason (optional):');
  if(reason===null) return;
  var ok=true;
  for(var i=0;i<g.lines.length;i++){ var r=await api('voidExpense',{ id:g.lines[i].id, reason:reason }); if(!(r&&r.ok)) ok=false; }
  if(ok){ showToast('Voided ✅ (kept for audit)'); _expCloseDrawer(); await initExpenses(); }
  else showToast('Failed to void','error');
}

// ── SCAN RECEIPT (upload photo → Gemini reads → pre-fills the form) ─────────
function _expScanReceipt(){
  if(!_expIsOwner() && !(currentUser && currentUser.role==='ADMIN')){ showToast('ADMIN/OWNER only','error'); return; }
  var inp=document.createElement('input'); inp.type='file'; inp.accept='image/*';
  inp.onchange=function(){
    var f=inp.files && inp.files[0]; if(!f) return;
    if(f.size > 8*1024*1024){ showToast('Image too large (max 8MB) — retake smaller','error'); return; }
    var reader=new FileReader();
    reader.onload=async function(){
      var res=String(reader.result||''); var b64=res.split(',')[1]; var mime=f.type||'image/jpeg';
      if(!b64){ showToast('Could not read the image','error'); return; }
      showToast('📷 Reading receipt…');
      try{
        var r=await api('scanReceipt',{ imageBase64:b64, mimeType:mime });
        if(r&&r.ok&&r.extracted){ _expOpenFromScan(r.extracted); }
        else showToast((r&&r.error)||'Could not read the receipt','error');
      }catch(e){ showToast('Scan failed — try again or enter manually','error'); }
    };
    reader.readAsDataURL(f);
  };
  inp.click();
}
function _expUnitIdByName(n){ if(!n) return ''; var u=_expUnits.filter(function(x){return x.name.toLowerCase()===String(n).toLowerCase();})[0]; return u?u.id:''; }
function _expSetSelect(id,val){ var s=document.getElementById(id); if(!s||val==null)return; var v=String(val).toLowerCase(); for(var i=0;i<s.options.length;i++){ if(s.options[i].value.toLowerCase()===v||s.options[i].text.toLowerCase()===v){ s.selectedIndex=i; return; } } }
function _expOpenFromScan(d){
  var isPurchase = (d.kind!=='expense') && Array.isArray(d.lines) && d.lines.length>0;
  if(isPurchase){
    _expRecMode='purchase';
    _expLines = d.lines.map(function(l){ return { item:l.item||'', qty:l.qty, unitId:_expUnitIdByName(l.unit), unitPrice:l.unit_price, total:l.total }; });
    if(!_expLines.length) _expLines=[{}];
    _expModal(_expRecordShell());
    setTimeout(function(){
      var S=function(id,v){var e=document.getElementById(id); if(e&&v!=null&&v!=='') e.value=v;};
      S('epSup',d.supplier); S('epDate',d.date); S('epRef',d.reference_no);
      _expSetSelect('epPay',d.payment_method); _expSetSelect('epCat',d.category);
      _expRenderLines();
      showToast('✅ Receipt read — review each line & Save');
    },50);
  } else {
    _expRecMode='general';
    _expModal(_expRecordShell());
    setTimeout(function(){
      var S=function(id,v){var e=document.getElementById(id); if(e&&v!=null&&v!=='') e.value=v;};
      S('geTitle',d.description||d.supplier||d.reference_no||'Bill'); S('geStore',d.supplier);
      S('geAmt',d.grand_total); S('geDate',d.date); S('geRef',d.reference_no);
      _expSetSelect('geCat',d.category);
      showToast('✅ Bill read — review & Save');
    },50);
  }
}
