// ══════════════════════════════════════════════════════════════════════════
// STOCK CONTROL — engine screens (loaded after admin-inventory.js)
// Dashboard · Current Stock · Movements (audit) · Receive · Waste
// Item detail (info · batches · history · explain) · Stock shortages · Add-ons
// Everything reads the append-only ledger + batch balances (inv_*).
// Nothing here edits or deletes a movement: corrections are reversals.
// ══════════════════════════════════════════════════════════════════════════
var _ieDash = null, _ieDashDate = null;
var _ieStock = [], _ieStockQ = '', _ieStockStatus = 'ACTIVE';
var _ieMoves = [], _ieMvF = { from:'', to:'', type:'', itemId:'', ref:'' };
var _ieRecent = [], _ieWasteRecent = [];
var _ieAddons = [];
var _ieAllItems = [];   // every active item, independent of the Items-tab filter
var IE_WASTE_REASONS = [['SPOILED','Spoiled'],['EXPIRED','Expired'],['DAMAGED','Damaged'],['BREAKAGE','Breakage'],['WASTE','Waste / dropped'],['STAFF_MEAL','Staff meal'],['COMPLIMENTARY','Complimentary']];
var IE_TYPE_COLORS = { 'PURCHASE':'#15803d','OPENING BALANCE':'#0f766e','POS SALE':'#1d4ed8','ONLINE SALE':'#4338ca','POS VOID':'#0369a1','ONLINE VOID':'#0369a1',
  'POS RETURN':'#0369a1','WASTE':'#b91c1c','SPOILAGE':'#b91c1c','BREAKAGE':'#b91c1c','STAFF MEAL':'#a16207','COMPLIMENTARY':'#a16207','PRODUCTION':'#7e22ce',
  'PRODUCTION CONSUMPTION':'#7e22ce','TRANSFER':'#475569','STOCK COUNT':'#c2410c','STOCK ADJUSTMENT':'#c2410c','RETURN TO SUPPLIER':'#475569','PORTIONING':'#7e22ce' };

function _ieQ(n){ return _invFmtQty(Math.round(_invNum(n)*1000)/1000); }
function _ieSigned(n){ var x=_invNum(n); return (x>0?'+':x<0?'−':'')+_ieQ(Math.abs(x)); }
function _iePeso(n){ return n==null ? '—' : '₱'+_invNum(n).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function _ieWhen(ts){ if(!ts) return '—'; return _invDay(ts)+' '+_invTime(ts); }
function _ieTypePill(t){ var c=IE_TYPE_COLORS[t]||'#475569'; return '<span style="display:inline-block;font-size:.62rem;font-weight:800;letter-spacing:.3px;padding:2px 7px;border-radius:6px;background:'+c+'14;color:'+c+';border:1px solid '+c+'33;white-space:nowrap">'+_invEsc(t)+'</span>'; }
function _ieStatusPill(s){
  var m={OK:['#15803d','#e8f6ee'],LOW:['#b45309','#fff4e0'],OUT:['#b91c1c','#fde8e8'],'NOT TRACKED':['#64748b','#f1f5f9']}[s]||['#475569','#f1f5f9'];
  return '<span style="font-size:.62rem;font-weight:800;padding:2px 8px;border-radius:20px;background:'+m[1]+';color:'+m[0]+';white-space:nowrap">'+_invEsc(s)+'</span>';
}
function _ieCard(label, value, color, sub, onclick){
  return '<div'+(onclick?' onclick="'+onclick+'" style="cursor:pointer;':' style="')+'background:#fff;border:1px solid var(--mist);border-radius:10px;padding:10px 12px">'
    +'<div style="font-size:.6rem;color:var(--timber);text-transform:uppercase;letter-spacing:.4px;font-weight:700">'+label+'</div>'
    +'<div style="font-size:1.3rem;font-weight:800;color:'+(color||'var(--forest-deep)')+';line-height:1.15;margin-top:2px">'+value+'</div>'
    +(sub?'<div style="font-size:.64rem;color:var(--timber);margin-top:1px">'+sub+'</div>':'')+'</div>';
}
function _ieBox(title, inner, right){
  return '<div style="background:#fff;border:1px solid var(--mist);border-radius:12px;padding:12px 14px;margin-bottom:12px">'
    +'<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px"><div style="font-size:.84rem;font-weight:800;color:var(--forest-deep)">'+title+'</div>'+(right||'')+'</div>'
    +inner+'</div>';
}
function _ieEmpty(t){ return '<div style="font-size:.74rem;color:var(--timber);padding:8px 2px">'+t+'</div>'; }
function _ieBtn(label, onclick, primary, extra){
  return '<button onclick="'+onclick+'" style="font-size:.74rem;font-weight:700;border-radius:8px;padding:7px 12px;cursor:pointer;border:1.5px solid var(--forest);'
    +(primary?'background:var(--forest);color:#fff':'background:#fff;color:var(--forest)')+';'+(extra||'')+'">'+label+'</button>';
}
function _ieCss(){
  if(document.getElementById('ieStyles')) return;
  var st=document.createElement('style'); st.id='ieStyles';
  st.textContent='.ie-cards{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px}'
    +'.ie-2col{display:grid;grid-template-columns:1fr 1fr;gap:12px}'
    +'.ie-tbl{width:100%;border-collapse:collapse;font-size:.74rem}.ie-tbl th{position:sticky;top:0;background:var(--forest-deep);color:#fff;text-align:left;padding:7px 9px;font-size:.62rem;text-transform:uppercase;letter-spacing:.3px;white-space:nowrap;z-index:1}'
    +'.ie-tbl td{padding:7px 9px;border-top:1px solid var(--mist-light);vertical-align:top}.ie-tbl tr.ie-click{cursor:pointer}.ie-tbl tr.ie-click:hover td{background:#eef5f0}'
    +'.ie-num,.ie-tbl th.ie-num{text-align:right;white-space:nowrap}.ie-wrap{background:#fff;border:1px solid var(--mist);border-radius:10px;overflow:auto;max-height:calc(100vh - 300px)}'
    +'.ie-in{width:100%;box-sizing:border-box;margin-top:3px;font-size:.84rem;padding:9px;border:1.5px solid var(--mist);border-radius:8px;background:#fff}'
    +'.ie-lbl{font-size:.72rem;font-weight:700;color:var(--forest-deep);display:block;margin-top:10px}'
    +'.ie-chip{font-size:.74rem;font-weight:700;border-radius:20px;padding:7px 12px;cursor:pointer;border:1.5px solid var(--mist);background:#fff;color:var(--forest)}'
    +'.ie-chip.on{background:var(--forest);border-color:var(--forest);color:#fff}'
    +'.ie-mcards{display:none}'
    +'@media(max-width:760px){.ie-cards{grid-template-columns:repeat(2,1fr)}.ie-2col{grid-template-columns:1fr}.ie-desk{display:none}.ie-mcards{display:block}}';
  document.head.appendChild(st);
}
function _ieModal(html, wide){
  _ieCloseModal();
  var m=document.createElement('div'); m.id='ieModal';
  m.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10001;display:flex;align-items:flex-start;justify-content:center;padding:14px;overflow:auto';
  m.onclick=function(e){ if(e.target===m) _ieCloseModal(); };
  m.innerHTML='<div style="background:#fff;border-radius:14px;max-width:'+(wide?'880px':'520px')+';width:100%;padding:18px;margin-top:14px;position:relative">'
    +'<button onclick="_ieCloseModal()" aria-label="Close" style="position:absolute;top:12px;right:12px;background:var(--mist-light);border:none;border-radius:8px;width:30px;height:30px;cursor:pointer;color:var(--forest)">✕</button>'
    +html+'</div>';
  document.body.appendChild(m);
  return m;
}
function _ieCloseModal(){ var m=document.getElementById('ieModal'); if(m) m.remove(); }
function _ieKv(k,v){ return '<div style="display:flex;justify-content:space-between;gap:10px;padding:5px 0;border-bottom:1px solid var(--mist-light);font-size:.76rem"><span style="color:var(--timber)">'+k+'</span><span style="color:var(--forest-deep);font-weight:600;text-align:right">'+v+'</span></div>'; }

// ── loading per tab ────────────────────────────────────────────────────────
async function _ieLoadTab(t){
  _ieCss();
  if(t==='dash'){ var r=await api('invDashboardV2',{date:_ieDashDate||''}); _ieDash=(r&&r.ok)?r:null; }
  else if(t==='current'){ var s=await api('invCurrentStock',{}); _ieStock=(s&&s.ok)?(s.rows||[]):[]; }
  else if(t==='moves'){ await _ieLoadMoves(); if(!_ieStock.length){ var s2=await api('invCurrentStock',{}); _ieStock=(s2&&s2.ok)?(s2.rows||[]):[]; } }
  else if(t==='receive'){ await _ieLoadAllItems(); var p=await api('invMovements',{type:'PURCHASE',limit:15}); _ieRecent=(p&&p.ok)?(p.rows||[]):[]; }
  else if(t==='waste'){ var s3=await api('invCurrentStock',{}); _ieStock=(s3&&s3.ok)?(s3.rows||[]):[];
    var w=await api('invMovements',{limit:300,from:new Date(Date.now()-7*864e5).toISOString()});
    _ieWasteRecent=((w&&w.ok)?(w.rows||[]):[]).filter(function(m){ return ['WASTE','SPOILAGE','BREAKAGE','STAFF MEAL','COMPLIMENTARY'].indexOf(m.movement_type)>=0; }); }
  else if(t==='menu'){ await _ieLoadMenu(); _ieMenuAutoRefresh(); }
  else if(t==='recipes'){ await _ieLoadAllItems(); var a=await api('invListAddons',{}); _ieAddons=(a&&a.ok)?(a.addons||[]):[]; }
  if(_invTab===t) _invRenderTab();
}
function _ieLoading(){ return '<div style="padding:30px;text-align:center;color:var(--timber);font-size:.8rem">Loading…</div>'; }

// ══ DASHBOARD ═════════════════════════════════════════════════════════════
function _ieDashHtml(){
  if(!_ieDash) return _ieLoading();
  var d=_ieDash, h='';
  var today=_invManilaToday();
  h+='<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:10px">'
    +'<input type="date" value="'+_invEsc(d.date||today)+'" max="'+today+'" onchange="_ieDashDate=this.value;_ieDash=null;_invRenderTab();_ieLoadTab(\'dash\')" class="ie-in" style="width:auto;margin:0;padding:7px">'
    +'<div style="flex:1"></div>'+_ieBtn('🍰 Menu Stock','_invSetTab(\'menu\')',true)+'</div>';
  var fc = d.menu_food_cost_pct==null ? '—' : d.menu_food_cost_pct+'%';
  h+='<div class="ie-cards">'
    +_ieCard('Inventory value', _iePeso(d.inventory_value), null, 'at actual batch cost', '_invSetTab(\'menu\')')
    +_ieCard('Sales', _iePeso(d.sales), null, 'POS '+_iePeso(d.sales_pos)+' · Online '+_iePeso(d.sales_online))
    +_ieCard('Food cost %', fc, d.menu_food_cost_pct>40?'#b91c1c':'#15803d', d.cost_coverage_pct==null?'no sales yet':'on '+d.cost_coverage_pct+'% of sales that have a cost', '_ieScrollTo(\'ieMissing\')')
    +_ieCard('Waste / spoilage', _iePeso(d.waste_cost), d.waste_cost>0?'#b91c1c':null, 'at batch cost', '_invSetTab(\'menu\')')
    +_ieCard('Low / out of stock', d.low_stock, d.low_stock>0?'#b45309':null, 'below par or empty', '_invSetTab(\'menu\')')
    +_ieCard('Near expiry', d.near_expiry, d.near_expiry>0?'#c2410c':null, 'within 2 days', '_invSetTab(\'menu\')')
    +_ieCard('Expired', d.expired, d.expired>0?'#b91c1c':null, 'still in stock', '_invSetTab(\'menu\')')
    +_ieCard('Stock shortages', d.open_exceptions, d.open_exceptions>0?'#b91c1c':null, 'sold more than recorded', d.open_exceptions>0?'_ieScrollTo(\'ieExc\')':'')
    +'</div>';
  if(!d.moduleEnabled) h+='<div style="background:#fff7e6;border:1px solid #fde68a;color:#8a5a0b;border-radius:10px;padding:9px 12px;font-size:.76rem;margin-bottom:12px">The inventory module is OFF, so sales are not deducting stock. Turn it on in ⚙️ Settings.</div>';
  // items selling without a cost in Menu Costing
  var ms=d.missing_costs||[];
  if(ms.length) h+='<div id="ieMissing">'+_ieBox('💡 Add a cost in Menu Costing <span style="font-weight:600;color:var(--timber);font-size:.7rem">— these sold '+(d.date===_invManilaToday()?'today':'on this day')+' with no cost, so they\'re left out of food cost %</span>',
    ms.map(function(m){ return '<div style="display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-top:1px solid var(--mist-light);font-size:.78rem"><span>'+_invEsc(m.name)+' <span style="color:var(--timber)">×'+_ieQ(m.qty)+'</span></span><b>'+_iePeso(m.amount)+'</b></div>'; }).join(''))+'</div>';
  // shortages first — they need action
  var ex=d.exceptions||[];
  h+='<div id="ieExc">'+_ieBox('⚠️ Stock shortages <span style="font-weight:600;color:var(--timber);font-size:.7rem">— sold more than the system had. Sale completed; check the shelf.</span>',
    ex.length? ex.map(function(e){
      return '<div style="display:flex;gap:10px;align-items:center;justify-content:space-between;padding:7px 0;border-top:1px solid var(--mist-light)">'
        +'<div style="min-width:0"><div style="font-size:.8rem;font-weight:800;color:#b91c1c">STOCK SHORTAGE · '+_invEsc(e.item)+' · '+_ieQ(e.qty)+' '+_invEsc(e.unit||'')+'</div>'
        +'<div style="font-size:.68rem;color:var(--timber)">'+_invEsc(e.source)+' · '+_invEsc(e.detail||'')+' · '+_ieWhen(e.at)+'</div></div>'
        +_ieBtn('Resolve','_ieResolveExc('+e.id+')',false,'white-space:nowrap')+'</div>';
    }).join('') : _ieEmpty('None — every sale was covered by recorded stock.'))+'</div>';
  // alerts + waste
  var al=d.alerts||[];
  h+='<div class="ie-2col"><div>'+_ieBox('🔔 Stock alerts', al.length? al.slice(0,12).map(function(c){
      var why=[]; if(c.status==='OUT') why.push('out of stock'); else if(c.status==='LOW') why.push('below par '+_ieQ(c.par_level));
      if(_invNum(c.expired_qty)>0) why.push(_ieQ(c.expired_qty)+' expired'); if(_invNum(c.near_expiry_qty)>0) why.push(_ieQ(c.near_expiry_qty)+' expiring '+_invDate(c.next_expiry));
      return '<div onclick="_ieOpenItem('+c.item_id+')" style="cursor:pointer;display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-top:1px solid var(--mist-light)">'
        +'<div><div style="font-size:.78rem;font-weight:700;color:var(--forest-deep)">'+_invEsc(c.name)+'</div><div style="font-size:.66rem;color:#b45309">'+_invEsc(why.join(' · '))+'</div></div>'
        +'<div style="font-size:.8rem;font-weight:800;white-space:nowrap">'+_ieQ(c.stock_qty)+' '+_invEsc(c.unit)+'</div></div>';
    }).join('') : _ieEmpty('No alerts.'))+'</div>';
  var wt=d.waste_today||[];
  h+='<div>'+_ieBox('🗑️ Waste / spoilage', wt.length? wt.map(function(m){
      return '<div onclick="_ieOpenMove('+m.txn_id+')" style="cursor:pointer;display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-top:1px solid var(--mist-light)">'
        +'<div><div style="font-size:.78rem;font-weight:700;color:var(--forest-deep)">'+_invEsc(m.item_name)+' '+_ieTypePill(m.movement_type)+'</div>'
        +'<div style="font-size:.66rem;color:var(--timber)">'+_invEsc(INV_REASONS[m.reason]||m.reason||'')+' · '+_invEsc(m.performed_by_name||m.performed_by)+' · '+_invTime(m.performed_at)+'</div></div>'
        +'<div style="text-align:right;white-space:nowrap"><div style="font-size:.8rem;font-weight:800;color:#b91c1c">'+_ieSigned(m.qty)+' '+_invEsc(m.unit)+'</div><div style="font-size:.64rem;color:var(--timber)">'+_iePeso(-_invNum(m.cost_impact))+'</div></div></div>';
    }).join('') : _ieEmpty('No waste recorded on this day.'))+'</div></div>';
  // recent + top selling
  var rc=d.recent||[], ts=d.top_selling||[];
  h+='<div class="ie-2col"><div>'+_ieBox('🧾 Recent movements', rc.length? rc.map(_ieMoveLine).join('') : _ieEmpty('No movements yet.'), _ieBtn('All','_invSetTab(\'moves\')'))+'</div>';
  h+='<div>'+_ieBox('🏆 Top selling (POS)', ts.length? ts.map(function(t,i){
      return '<div style="display:flex;justify-content:space-between;padding:6px 0;border-top:1px solid var(--mist-light);font-size:.78rem"><span><b style="color:var(--gold)">'+(i+1)+'.</b> '+_invEsc(t.name)+'</span><b>'+_ieQ(t.qty)+'</b></div>';
    }).join('') : _ieEmpty('No completed sales on this day.'))+'</div></div>';
  return h;
}
function _ieScrollTo(id){ var e=document.getElementById(id); if(e) e.scrollIntoView({behavior:'smooth',block:'start'}); }
function _ieMoveLine(m){
  return '<div onclick="_ieOpenMove('+m.txn_id+')" style="cursor:pointer;display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-top:1px solid var(--mist-light)">'
    +'<div style="min-width:0"><div style="font-size:.76rem;font-weight:700;color:var(--forest-deep)">'+_ieTypePill(m.movement_type)+' '+_invEsc(m.item_name)+'</div>'
    +'<div style="font-size:.64rem;color:var(--timber)">'+_invEsc(m.source_ref)+' · '+_invEsc(m.performed_by_name||m.performed_by)+' · '+_ieWhen(m.performed_at)+'</div></div>'
    +'<div style="font-size:.8rem;font-weight:800;white-space:nowrap;color:'+(_invNum(m.qty)<0?'#b91c1c':'#15803d')+'">'+_ieSigned(m.qty)+' '+_invEsc(m.unit)+'</div></div>';
}
async function _ieResolveExc(id){
  var note=prompt('What did you find? (e.g. "2 slices were on the shelf but not received — received now")');
  if(!note||!note.trim()) return;
  var r=await api('invResolveException',{id:id,note:note.trim()});
  if(r&&r.ok){ showToast('Shortage resolved','success'); _ieLoadTab(_invTab); } else showToast((r&&r.error)||'Failed','error');
}

// ══ CURRENT STOCK ═════════════════════════════════════════════════════════
function _ieStockRows(){
  var q=_ieStockQ.trim().toLowerCase();
  return _ieStock.filter(function(r){
    if(_ieStockStatus==='ACTIVE' && !r.tracked) return false;
    if(_ieStockStatus==='LOW' && !(r.status==='LOW'||r.status==='OUT')) return false;
    if(_ieStockStatus==='EXPIRY' && !(_invNum(r.near_expiry_qty)>0||_invNum(r.expired_qty)>0)) return false;
    if(_ieStockStatus==='UNTRACKED' && r.tracked) return false;
    if(q && ((r.name||'')+' '+(r.item_code||'')).toLowerCase().indexOf(q)<0) return false;
    return true;
  });
}
function _ieCurrentHtml(){
  if(!_ieStock.length) return _ieLoading();
  var rows=_ieStockRows(), val=0; rows.forEach(function(r){ val+=_invNum(r.stock_value); });
  var h='<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:10px">'
    +_ieBtn('📥 Receive','_invSetTab(\'receive\')',true)+_ieBtn('🗑️ Waste','_invSetTab(\'waste\')',false,'border-color:#b91c1c;color:#b91c1c')
    +'<input id="ieStockQ" value="'+_invEsc(_ieStockQ)+'" oninput="_ieStockQ=this.value;_ieRenderStockTable()" placeholder="🔍 Search item…" class="ie-in" style="flex:1;min-width:180px;margin:0;padding:7px 10px">';
  [['ACTIVE','In stock system'],['LOW','Low / out'],['EXPIRY','Expiring / expired'],['UNTRACKED','Not tracked yet'],['ALL','All']].forEach(function(f){
    h+='<button class="ie-chip'+(_ieStockStatus===f[0]?' on':'')+'" onclick="_ieStockStatus=\''+f[0]+'\';_invRenderTab()">'+f[1]+'</button>';
  });
  h+='</div><div id="ieStockTbl"></div>';
  h+='<div style="font-size:.68rem;color:var(--timber);margin-top:6px">Stock = sum of batch balances, which always equals the sum of ledger movements. Value at each batch\'s actual cost. Tap a row for batches, history and “why is it this number?”.</div>';
  setTimeout(_ieRenderStockTable,0);
  return h;
}
function _ieRenderStockTable(){
  var box=document.getElementById('ieStockTbl'); if(!box) return;
  var rows=_ieStockRows();
  if(!rows.length){ box.innerHTML='<div style="background:#fff;border:1px dashed var(--mist);border-radius:12px;padding:30px;text-align:center;color:var(--timber);font-size:.8rem">'
    +(_ieStockStatus==='ACTIVE'?'No tracked stock yet. Receive stock (📥 Receive) or add an opening count (🧮 Count) to start.':'Nothing matches.')+'</div>'; return; }
  var total=0; rows.forEach(function(r){ total+=_invNum(r.stock_value); });
  var h='<div class="ie-wrap ie-desk"><table class="ie-tbl" style="min-width:860px"><thead><tr>'
    +'<th>Item</th><th class="ie-num">Stock</th><th>≈ Purchase units</th><th class="ie-num">Par</th><th>Status</th><th>Next expiry</th><th class="ie-num">Batches</th><th class="ie-num">Value</th></tr></thead><tbody>';
  rows.forEach(function(r){
    var pu=(r.purchase_unit && _invNum(r.purchase_to_stock)>0)? _ieQ(_invNum(r.stock_qty)/_invNum(r.purchase_to_stock))+' '+_invEsc(r.purchase_unit) : '—';
    var exp=r.next_expiry? _invDate(r.next_expiry) : '—'; var ed=_invDaysTo(r.next_expiry);
    var flags=(_invNum(r.expired_qty)>0?' <b style="color:#b91c1c">'+_ieQ(r.expired_qty)+' expired</b>':'')+(r.open_exceptions>0?' <span title="open stock shortage" style="color:#b91c1c">⚠️</span>':'');
    h+='<tr class="ie-click" onclick="_ieOpenItem('+r.item_id+')"><td><div style="font-weight:700;color:var(--forest-deep)">'+_invEsc(r.name)+flags+'</div><div style="font-size:.62rem;color:var(--timber)">'+_invEsc(_invTypeShort(r.item_type))+' · '+_invEsc(r.item_code)+'</div></td>'
      +'<td class="ie-num" style="font-weight:800;font-size:.82rem">'+(r.tracked?_ieQ(r.stock_qty)+' <span style="font-weight:600;color:var(--timber)">'+_invEsc(r.unit)+'</span>':'—')+'</td>'
      +'<td style="color:var(--timber)">'+pu+'</td><td class="ie-num">'+(r.par_level!=null?_ieQ(r.par_level):'—')+'</td>'
      +'<td>'+_ieStatusPill(r.status)+'</td>'
      +'<td style="white-space:nowrap;color:'+(ed!==null&&ed<=2?'#c2410c':'var(--timber)')+';font-weight:'+(ed!==null&&ed<=2?'700':'400')+'">'+exp+'</td>'
      +'<td class="ie-num">'+(r.batches||0)+'</td><td class="ie-num">'+_iePeso(r.stock_value)+'</td></tr>';
  });
  h+='</tbody><tfoot><tr><td colspan="7" style="padding:8px 9px;font-weight:800;text-align:right">Total value</td><td class="ie-num" style="padding:8px 9px;font-weight:800">'+_iePeso(total)+'</td></tr></tfoot></table></div>';
  h+='<div class="ie-mcards">';
  rows.forEach(function(r){
    h+='<div onclick="_ieOpenItem('+r.item_id+')" style="background:#fff;border:1px solid var(--mist);border-radius:10px;padding:10px 12px;margin-bottom:8px;cursor:pointer">'
      +'<div style="display:flex;justify-content:space-between;gap:8px"><div style="font-size:.86rem;font-weight:700;color:var(--forest-deep)">'+_invEsc(r.name)+'</div>'+_ieStatusPill(r.status)+'</div>'
      +'<div style="display:flex;justify-content:space-between;align-items:baseline;margin-top:4px"><div style="font-size:1.05rem;font-weight:800">'+(r.tracked?_ieQ(r.stock_qty)+' <span style="font-size:.76rem;color:var(--timber)">'+_invEsc(r.unit)+'</span>':'—')+'</div>'
      +'<div style="font-size:.68rem;color:var(--timber)">'+(r.next_expiry?'Exp '+_invDate(r.next_expiry)+' · ':'')+_iePeso(r.stock_value)+'</div></div></div>';
  });
  h+='</div>';
  box.innerHTML=h;
}

// ══ MOVEMENTS (ledger) ════════════════════════════════════════════════════
async function _ieLoadMoves(){
  var f=_ieMvF, b={limit:500};
  if(f.from) b.from=new Date(f.from+'T00:00:00+08:00').toISOString();
  if(f.to) b.to=new Date(new Date(f.to+'T00:00:00+08:00').getTime()+864e5).toISOString();
  if(f.type) b.type=f.type; if(f.itemId) b.itemId=+f.itemId; if(f.ref) b.sourceRef=f.ref.trim();
  var r=await api('invMovements',b); _ieMoves=(r&&r.ok)?(r.rows||[]):[];
}
function _ieMovesHtml(){
  var f=_ieMvF;
  var types=['','PURCHASE','OPENING BALANCE','POS SALE','ONLINE SALE','POS VOID','ONLINE VOID','WASTE','SPOILAGE','BREAKAGE','STAFF MEAL','COMPLIMENTARY','STOCK COUNT','STOCK ADJUSTMENT','PRODUCTION','PRODUCTION CONSUMPTION','TRANSFER','PORTIONING','RETURN TO SUPPLIER'];
  var itemOpts='<option value="">All items</option>'+_ieStock.filter(function(r){return r.tracked;}).map(function(r){ return '<option value="'+r.item_id+'"'+(String(f.itemId)===String(r.item_id)?' selected':'')+'>'+_invEsc(r.name)+'</option>'; }).join('');
  var h='<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:6px;margin-bottom:10px">'
    +'<label style="font-size:.64rem;color:var(--timber);font-weight:700">From<input type="date" class="ie-in" value="'+_invEsc(f.from)+'" onchange="_ieMvF.from=this.value"></label>'
    +'<label style="font-size:.64rem;color:var(--timber);font-weight:700">To<input type="date" class="ie-in" value="'+_invEsc(f.to)+'" onchange="_ieMvF.to=this.value"></label>'
    +'<label style="font-size:.64rem;color:var(--timber);font-weight:700">Type<select class="ie-in" onchange="_ieMvF.type=this.value">'+types.map(function(t){return '<option value="'+t+'"'+(f.type===t?' selected':'')+'>'+(t||'All types')+'</option>';}).join('')+'</select></label>'
    +'<label style="font-size:.64rem;color:var(--timber);font-weight:700">Item<select id="ieMvItem" class="ie-in" onchange="_ieMvF.itemId=this.value">'+itemOpts+'</select></label>'
    +'<label style="font-size:.64rem;color:var(--timber);font-weight:700">Reference<input class="ie-in" placeholder="POS-…, ONLINE-…, WASTE-…" value="'+_invEsc(f.ref)+'" onchange="_ieMvF.ref=this.value"></label>'
    +'<div style="display:flex;gap:6px;align-items:flex-end">'+_ieBtn('Apply','_ieApplyMv()',true,'flex:1;padding:9px')+_ieBtn('Clear','_ieMvF={from:\'\',to:\'\',type:\'\',itemId:\'\',ref:\'\'};_ieApplyMv()',false,'padding:9px')+'</div></div>';
  var rows=_ieMoves;
  if(!rows.length) return h+'<div style="background:#fff;border:1px dashed var(--mist);border-radius:12px;padding:30px;text-align:center;color:var(--timber);font-size:.8rem">No movements match.</div>';
  h+='<div class="ie-wrap ie-desk"><table class="ie-tbl" style="min-width:980px"><thead><tr><th>When</th><th>Type</th><th>Item</th><th class="ie-num">Qty</th><th>Batch</th><th>Reference</th><th>By</th><th>Reason / notes</th><th class="ie-num">Cost</th></tr></thead><tbody>';
  rows.forEach(function(m){
    h+='<tr class="ie-click" onclick="_ieOpenMove('+m.txn_id+')"><td style="white-space:nowrap">'+_ieWhen(m.performed_at)+'</td><td>'+_ieTypePill(m.movement_type)+(m.reversed?' <span style="font-size:.6rem;color:#b91c1c;font-weight:800">REVERSED</span>':'')+'</td>'
      +'<td style="font-weight:700;color:var(--forest-deep)">'+_invEsc(m.item_name)+'</td>'
      +'<td class="ie-num" style="font-weight:800;color:'+(_invNum(m.qty)<0?'#b91c1c':'#15803d')+'">'+_ieSigned(m.qty)+' '+_invEsc(m.unit)+'</td>'
      +'<td style="white-space:nowrap;color:var(--timber)">'+_invEsc(m.batch_code||m.stock_unit_code||'—')+'</td>'
      +'<td style="white-space:nowrap">'+_invEsc(m.source_ref)+'</td><td style="white-space:nowrap">'+_invEsc(m.performed_by_name||m.performed_by)+'</td>'
      +'<td style="max-width:240px;color:var(--timber)">'+_invEsc([INV_REASONS[m.reason]||m.reason, m.notes].filter(Boolean).join(' · '))+'</td>'
      +'<td class="ie-num">'+(m.cost_impact!=null?_iePeso(m.cost_impact):'—')+'</td></tr>';
  });
  h+='</tbody></table></div><div class="ie-mcards">'+rows.map(function(m){ return '<div style="background:#fff;border:1px solid var(--mist);border-radius:10px;padding:4px 12px;margin-bottom:6px">'+_ieMoveLine(m)+'</div>'; }).join('')+'</div>';
  h+='<div style="font-size:.68rem;color:var(--timber);margin-top:6px">'+rows.length+' movement'+(rows.length!==1?'s':'')+(rows.length>=500?' (latest 500 — narrow the filters)':'')+'. The ledger is append-only: nothing can be edited or deleted; a mistake is corrected by a reversal.</div>';
  setTimeout(function(){ var s=document.getElementById('ieMvItem'); if(s && s.options.length>15) _invSearchable(s); },0);
  return h;
}
async function _ieApplyMv(){ _ieMoves=[]; await _ieLoadMoves(); _invRenderTab(); }

// movement audit detail
async function _ieOpenMove(id){
  _ieCss();
  _ieModal('<div style="padding:20px;color:var(--timber)">Loading movement…</div>');
  var r=await api('invMovementDetail',{txnId:id});
  if(!r||!r.ok){ _ieModal('<div style="padding:10px;color:#b91c1c">'+_invEsc((r&&r.error)||'Could not load')+'</div>'); return; }
  var m=r.movement||{}, raw=r.raw||{}, b=r.batch||{};
  var qty=_invNum(m.qty), after=_invNum(raw.quantity_after);
  var h='<div style="font-size:.62rem;color:var(--timber);text-transform:uppercase;letter-spacing:.5px;font-weight:800">Movement #'+m.txn_id+'</div>'
    +'<div style="font-size:1.05rem;font-weight:800;color:var(--forest-deep);margin:2px 34px 2px 0">'+_ieTypePill(m.movement_type)+' '+_invEsc(m.item_name)+'</div>'
    +'<div style="font-size:1.6rem;font-weight:800;color:'+(qty<0?'#b91c1c':'#15803d')+'">'+_ieSigned(qty)+' <span style="font-size:.9rem;color:var(--timber)">'+_invEsc(m.unit)+'</span></div>'
    +(m.reversed?'<div style="background:#fde8e8;color:#b91c1c;border-radius:8px;padding:7px 10px;font-size:.74rem;font-weight:700;margin:6px 0">This movement was reversed'+(r.reversal?' by #'+r.reversal.txn_id+' ('+_invEsc(r.reversal.source_ref)+')':'')+'.</div>':'')
    +(m.parent_txn_id?'<div style="background:#eff6ff;color:#1d4ed8;border-radius:8px;padding:7px 10px;font-size:.74rem;font-weight:700;margin:6px 0;cursor:pointer" onclick="_ieOpenMove('+m.parent_txn_id+')">Reverses movement #'+m.parent_txn_id+' — open it</div>':'')
    +'<div style="margin-top:8px">'
    +_ieKv('Date & time', _ieWhen(m.performed_at))
    +_ieKv('Performed by', _invEsc((m.performed_by_name||'')+' ('+m.performed_by+')'))
    +_ieKv('Reference', _invEsc(m.source_ref))
    +_ieKv('Reason', _invEsc(INV_REASONS[m.reason]||m.reason||'—'))
    +_ieKv('Batch', _invEsc(m.batch_code||'—')+' · '+_invEsc(m.stock_unit_code||''))
    +_ieKv('Batch balance', _ieQ(after-_invNum(raw.quantity))+' → <b>'+_ieQ(after)+'</b> '+_invEsc(m.unit))
    +_ieKv('Location', _invEsc(m.location||'—'))
    +_ieKv('Unit cost (this batch)', _iePeso(m.unit_cost))
    +_ieKv('Cost impact', _iePeso(m.cost_impact))
    +(m.notes?_ieKv('Notes', _invEsc(m.notes)):'')
    +(raw.approved_by?_ieKv('Approved', _invEsc(raw.approved_by)+' · '+_ieWhen(raw.approved_at)):'')
    +'</div>';
  if(r.photo_url && /^https:\/\//i.test(r.photo_url)) h+='<a href="'+_invEsc(r.photo_url)+'" target="_blank" rel="noopener"><img src="'+_invEsc(r.photo_url)+'" alt="Photo" style="margin-top:10px;max-width:100%;max-height:220px;border-radius:10px;border:1px solid var(--mist)"></a>';
  if(b.batch||b.stock_unit) h+='<div class="invsec" style="margin-top:14px">Batch</div>'
    +_ieKv('Received', _invDate(b.received))+_ieKv('Expiry', _invDate(b.expiry))+_ieKv('Original / remaining now', _ieQ(b.original)+' / '+_ieQ(b.remaining))+_ieKv('Status', _invEsc(b.status||''));
  var ss=r.same_source||[];
  if(ss.length) h+='<div class="invsec" style="margin-top:14px">Same reference ('+_invEsc(m.source_ref)+')</div>'+ss.map(_ieMoveLine).join('');
  h+='<div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">'
    +_ieBtn('Open item','_ieOpenItem('+m.item_id+')',false)
    +((_invIsOwner() && !raw.approved_by && ['WASTE','SPOILAGE','BREAKAGE','STAFF MEAL','COMPLIMENTARY'].indexOf(m.movement_type)>=0)?_ieBtn('✓ Approve waste','_ieApproveWaste('+m.txn_id+')',true):'')
    +((!m.reversed && !m.parent_txn_id && qty!==0 && _invIsAdmin())?_ieBtn('↩ Reverse (correct a mistake)','_ieReverse('+m.txn_id+')',false,'border-color:#b91c1c;color:#b91c1c'):'')
    +'</div>';
  _ieModal(h);
}
async function _ieApproveWaste(id){
  var r=await api('invApproveSpoilage',{txnId:id});
  if(r&&r.ok){ showToast('Approved','success'); _ieOpenMove(id); } else showToast((r&&r.error)||'Failed','error');
}
async function _ieReverse(id){
  var reason=prompt('Why is this movement wrong? A reversal is added to the ledger — the original stays visible.');
  if(!reason||!reason.trim()) return;
  var r=await api('invReverseMovement',{txnId:id,reason:reason.trim()});
  if(r&&r.ok){ showToast('Reversed ('+(r.source_ref||'')+')','success'); _ieOpenMove(id); _ieLoadTab(_invTab); }
  else showToast((r&&r.error)||'Reversal failed','error');
}

// ══ ITEM DETAIL ═══════════════════════════════════════════════════════════
var _ieItemTab='overview', _ieItem=null, _ieExplain=null;
async function _ieOpenItem(id, tab){
  _ieCss(); _ieItemTab=tab||'overview'; _ieExplain=null;
  _ieModal('<div style="padding:20px;color:var(--timber)">Loading item…</div>', true);
  var r=await api('invItemDetail',{itemId:id});
  if(!r||!r.ok){ _ieModal('<div style="padding:10px;color:#b91c1c">'+_invEsc((r&&r.error)||'Could not load')+'</div>'); return; }
  _ieItem=r;
  if(_ieItemTab==='explain') await _ieLoadExplain();
  _ieRenderItem();
}
async function _ieLoadExplain(){ var e=await api('invExplainStock',{itemId:_ieItem.item.id}); _ieExplain=(e&&e.ok)?e:{error:(e&&e.error)||'Failed'}; }
async function _ieItemSetTab(t){ _ieItemTab=t; if(t==='explain' && !_ieExplain){ await _ieLoadExplain(); } _ieRenderItem(); }
function _ieRenderItem(){
  var d=_ieItem, it=d.item||{}, st=d.stock||{};
  var h='<div style="font-size:.62rem;color:var(--timber);text-transform:uppercase;letter-spacing:.5px;font-weight:800">'+_invEsc(_invTypeShort(it.type))+' · '+_invEsc(it.code)+'</div>'
    +'<div style="font-size:1.15rem;font-weight:800;color:var(--forest-deep);margin-right:34px">'+_invEsc(it.name)+'</div>'
    +'<div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;margin:6px 0 10px"><span style="font-size:1.8rem;font-weight:800;color:var(--forest-deep)">'+_ieQ(st.stock_qty)+'</span><span style="color:var(--timber)">'+_invEsc(it.stock_unit)+' in stock</span> '+_ieStatusPill(st.status||'')
    +(it.purchase_unit&&it.purchase_to_stock?'<span style="font-size:.74rem;color:var(--timber)">≈ '+_ieQ(_invNum(st.stock_qty)/_invNum(it.purchase_to_stock))+' '+_invEsc(it.purchase_unit)+'</span>':'')
    +'<span style="font-size:.74rem;color:var(--timber)">· value '+_iePeso(st.stock_value)+'</span></div>';
  h+='<div style="display:flex;gap:4px;border-bottom:2px solid var(--mist-light);margin-bottom:12px;overflow-x:auto">';
  [['overview','Overview'],['batches','Batches'],['history','History'],['explain','Why this number?']].forEach(function(t){
    var on=_ieItemTab===t[0];
    h+='<button onclick="_ieItemSetTab(\''+t[0]+'\')" style="background:none;border:none;cursor:pointer;padding:7px 12px;font-size:.78rem;font-weight:700;white-space:nowrap;'+(on?'color:var(--forest-deep);border-bottom:3px solid var(--gold);margin-bottom:-2px':'color:var(--timber)')+'">'+t[1]+'</button>';
  });
  h+='</div>';
  if(_ieItemTab==='overview'){
    var ex=d.exceptions||[];
    if(ex.length) h+='<div style="background:#fde8e8;color:#b91c1c;border-radius:10px;padding:9px 12px;font-size:.76rem;margin-bottom:10px"><b>STOCK SHORTAGE</b> — '+ex.map(function(e){ return _ieQ(e.qty_short)+' short on '+_invEsc(e.source_ref); }).join(' · ')+'</div>';
    h+='<div class="ie-2col"><div>'
      +_ieKv('Stock unit', _invEsc(it.stock_unit))
      +_ieKv('Purchase unit', it.purchase_unit? '1 '+_invEsc(it.purchase_unit)+' = <b>'+_ieQ(it.purchase_to_stock)+' '+_invEsc(it.stock_unit)+'</b>' : 'same as stock unit')
      +_ieKv('Cost per '+_invEsc(it.stock_unit), _iePeso(it.cost_per_stock_unit))
      +(it.purchase_unit?_ieKv('Cost per '+_invEsc(it.purchase_unit), _iePeso(it.cost_per_purchase_unit)):'')
      +_ieKv('Selling price', it.selling_price!=null?_iePeso(it.selling_price):'—')
      +_ieKv('Par level', it.par_level!=null?_ieQ(it.par_level)+' '+_invEsc(it.stock_unit):'—')
      +_ieKv('Shelf life', it.shelf_life_days!=null?it.shelf_life_days+' days':'—')
      +_ieKv('Rotation', it.rotation==='FIFO'?'FIFO (oldest received first)':'FEFO (soonest expiry first)')
      +_ieKv('Supplier', _invEsc(it.supplier||'—'))+_ieKv('Location', _invEsc(it.location||'—'))
      +'</div><div>'
      +'<div class="invsec" style="margin-top:0">Sold as</div>'
      +((it.menu_items||[]).length? it.menu_items.map(function(m){ return _ieKv(_invEsc(m.name), _iePeso(m.price)+' · '+_invEsc(m.mode)); }).join('') : _ieEmpty('Not linked to a menu item.'))
      +'<div class="invsec">Recipes</div>'
      +((it.recipes||[]).length? it.recipes.map(function(rc){ return '<div style="font-size:.74rem;padding:5px 0;border-bottom:1px solid var(--mist-light)"><b>'+_invEsc(rc.size)+'</b>: '+(rc.ingredients||[]).map(function(g){ return _ieQ(g.qty)+' '+_invEsc(g.unit)+' '+_invEsc(g.item); }).join(', ')+'</div>'; }).join('') : _ieEmpty('No recipe (sold as is).'))
      +'</div></div>';
    h+='<div style="display:flex;gap:6px;margin-top:12px;flex-wrap:wrap">'
      +_ieBtn('🍰 Add / Waste / Fix in Menu Stock','_ieCloseModal();_invSetTab(\'menu\')',true)
      +(_invIsAdmin()?_ieBtn('Edit units & settings','_ieCloseModal();_invOpenItemForm('+it.id+')'):'')+'</div>';
  } else if(_ieItemTab==='batches'){
    var bs=d.batches||[];
    h+= bs.length? '<div class="ie-wrap"><table class="ie-tbl" style="min-width:640px"><thead><tr><th>Batch</th><th>Received</th><th>Expiry</th><th class="ie-num">Original</th><th class="ie-num">Remaining</th><th class="ie-num">Unit cost</th><th>Location</th><th>Status</th></tr></thead><tbody>'
      +bs.map(function(b){ var ed=_invDaysTo(b.expiry);
        return '<tr style="'+(b.active?'':'color:#94a3b8')+'"><td style="font-weight:700">'+_invEsc(b.batch)+'</td><td>'+_invDate(b.received)+'</td>'
          +'<td style="color:'+(b.active&&ed!==null&&ed<0?'#b91c1c':b.active&&ed!==null&&ed<=2?'#c2410c':'inherit')+'">'+_invDate(b.expiry)+'</td>'
          +'<td class="ie-num">'+_ieQ(b.original)+'</td><td class="ie-num" style="font-weight:800">'+_ieQ(b.remaining)+'</td><td class="ie-num">'+_iePeso(b.unit_cost)+'</td>'
          +'<td>'+_invEsc(b.location||'—')+'</td><td>'+_invEsc(b.active?'active':(b.status||'used up'))+'</td></tr>'; }).join('')
      +'</tbody></table></div><div style="font-size:.66rem;color:var(--timber);margin-top:6px">Sales and waste take from the '+(it.rotation==='FIFO'?'oldest received':'soonest-expiring')+' active batch first.</div>'
      : _ieEmpty('No batches yet.');
  } else if(_ieItemTab==='history'){
    var mv=d.movements||[];
    h+= mv.length? mv.map(_ieMoveLine).join('') + (mv.length>=100?'<div style="font-size:.66rem;color:var(--timber);margin-top:6px">Latest 100 — see Movements for more.</div>':'') : _ieEmpty('No movements yet.');
  } else {
    var e=_ieExplain;
    if(!e) h+=_ieLoading();
    else if(e.error) h+='<div style="color:#b91c1c">'+_invEsc(e.error)+'</div>';
    else {
      h+='<div style="background:var(--mist-light);border-radius:12px;padding:14px;text-align:center;margin-bottom:12px"><div style="font-size:.64rem;color:var(--timber);text-transform:uppercase;letter-spacing:.5px;font-weight:800">Current stock is built from every movement</div>'
        +'<div style="font-size:1.05rem;font-weight:800;color:var(--forest-deep);margin-top:4px;word-break:break-word">'+_invEsc(e.formula)+'</div>'
        +'<div style="font-size:.72rem;margin-top:4px;color:'+(e.reconciles?'#15803d':'#b91c1c')+';font-weight:700">'+(e.reconciles?'✓ Matches the batch balances':'✗ Does not match batch balances — contact the owner')+'</div></div>';
      h+='<div class="invsec">By type</div>'+(e.by_type||[]).map(function(g){ return _ieKv(_ieTypePill(g.type), '<b style="color:'+(_invNum(g.qty)<0?'#b91c1c':'#15803d')+'">'+_ieSigned(g.qty)+' '+_invEsc(e.unit)+'</b>'); }).join('');
      h+='<div class="invsec">Batches now</div>'+((e.batches||[]).length? e.batches.map(function(b){ return _ieKv(_invEsc(b.batch)+' <span style="color:var(--timber)">exp '+_invDate(b.expiry)+'</span>', _ieQ(b.original)+' received → <b>'+_ieQ(b.remaining)+'</b> left'); }).join('') : _ieEmpty('No stock left.'));
      var lines=e.movements||[], run=_invNum(e.opening);
      h+='<div class="invsec">Every movement</div><div class="ie-wrap" style="max-height:320px"><table class="ie-tbl"><thead><tr><th>When</th><th>Type</th><th class="ie-num">Qty</th><th class="ie-num">Running</th><th>Batch</th><th>Reference</th><th>By</th></tr></thead><tbody>'
        +lines.map(function(l){ run+=_invNum(l.qty); return '<tr><td style="white-space:nowrap">'+_ieWhen(l.at)+'</td><td>'+_ieTypePill(l.type)+'</td><td class="ie-num" style="font-weight:800;color:'+(_invNum(l.qty)<0?'#b91c1c':'#15803d')+'">'+_ieSigned(l.qty)+'</td><td class="ie-num">'+_ieQ(run)+'</td><td>'+_invEsc(l.batch||'')+'</td><td>'+_invEsc(l.source||'')+'</td><td>'+_invEsc(l.by||'')+'</td></tr>'; }).join('')
        +'</tbody></table></div>';
    }
  }
  var box=document.querySelector('#ieModal > div');
  if(box){ box.innerHTML='<button onclick="_ieCloseModal()" aria-label="Close" style="position:absolute;top:12px;right:12px;background:var(--mist-light);border:none;border-radius:8px;width:30px;height:30px;cursor:pointer;color:var(--forest)">✕</button>'+h; }
  else _ieModal(h,true);
}

// ══ RECEIVE (staff: enter what you bought, in the unit you bought it) ═════
var _ieRcPreset=null, _ieWsPreset=null;
function _ieItems(){ return _ieAllItems.length ? _ieAllItems : _invItems; }
function _ieItemById(id){ return _ieItems().filter(function(x){ return x.id===+id; })[0]; }
async function _ieLoadAllItems(){ var r=await api('invListItems',{activeOnly:true}); if(r&&r.ok) _ieAllItems=r.items||r.data||[]; }
function _ieUnitName(id){ return (_invRef.units.filter(function(u){ return u.id===+id; })[0]||{}).name||''; }
function _ieReceiveHtml(){
  var items=_ieItems().filter(function(it){ return !it.merged_into_id; });
  var opts=items.map(function(it){ return '<option value="'+it.id+'"'+(_ieRcPreset===it.id?' selected':'')+'>'+_invEsc(it.name)+'</option>'; }).join('');
  var sup='<option value="">—</option>'+_invRef.suppliers.map(function(s){ return '<option value="'+s.id+'">'+_invEsc(s.name)+'</option>'; }).join('');
  var loc='<option value="">Default</option>'+_invRef.locations.map(function(l){ return '<option value="'+l.id+'">'+_invEsc(l.name)+'</option>'; }).join('');
  var h=_ieBackToStock()+'<div class="ie-2col"><div>'+_ieBox('📥 Receive stock',
      '<label class="ie-lbl">What did you receive?</label><select id="ieRcItem" class="ie-in" onchange="_ieRcChanged()">'+opts+'</select>'
      +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><div><label class="ie-lbl">How many?</label><input id="ieRcQty" type="number" min="0" step="any" inputmode="decimal" class="ie-in" oninput="_ieRcPreview()" placeholder="e.g. 2"></div>'
      +'<div><label class="ie-lbl">Unit</label><select id="ieRcUnit" class="ie-in" onchange="_ieRcPreview()"></select></div></div>'
      +'<div id="ieRcConv" style="display:none;background:#eef7f0;border:1px solid #cfe9d6;color:#14532d;border-radius:10px;padding:9px 11px;margin-top:10px;font-size:.82rem;font-weight:700"></div>'
      +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><div><label class="ie-lbl" id="ieRcCostLbl">Cost per unit ₱</label><input id="ieRcCost" type="number" min="0" step="any" inputmode="decimal" class="ie-in" oninput="_ieRcPreview()" placeholder="0"></div>'
      +'<div><label class="ie-lbl">Expiry date</label><input id="ieRcExp" type="date" class="ie-in"></div></div>'
      +'<div id="ieRcExpHint" style="font-size:.66rem;color:var(--timber);margin-top:3px"></div>'
      +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><div><label class="ie-lbl">Supplier</label><select id="ieRcSup" class="ie-in">'+sup+'</select></div>'
      +'<div><label class="ie-lbl">Location</label><select id="ieRcLoc" class="ie-in">'+loc+'</select></div></div>'
      +'<label class="ie-lbl">Notes</label><input id="ieRcNotes" class="ie-in" placeholder="delivery ref, OR number…">'
      +'<button id="ieRcBtn" onclick="_ieSubmitReceive()" style="width:100%;margin-top:14px;font-size:.9rem;font-weight:800;background:var(--forest);color:#fff;border:none;border-radius:10px;padding:12px;cursor:pointer">Receive</button>'
      +'<div style="font-size:.66rem;color:var(--timber);margin-top:6px">Each delivery becomes its own batch with its own cost and expiry. Nothing is overwritten.</div>')
    +'</div><div>'+_ieBox('Recently received', _ieRecent.length? _ieRecent.map(_ieMoveLine).join('') : _ieEmpty('Nothing received yet.'))+'</div></div>';
  setTimeout(function(){ var s=document.getElementById('ieRcItem'); if(s){ _invSearchable(s); if(_ieRcPreset) { s.value=_ieRcPreset; if(s._invSync) s._invSync(); } _ieRcChanged(); } _ieRcPreset=null; },0);
  return h;
}
function _ieBackToStock(){ return '<button onclick="_invSetTab(\'current\')" style="background:none;border:none;color:var(--forest);font-size:.76rem;font-weight:700;cursor:pointer;padding:0 0 8px">← Current Stock</button>'; }
function _ieRcChanged(){
  var it=_ieItemById((document.getElementById('ieRcItem')||{}).value); var us=document.getElementById('ieRcUnit'); if(!us) return;
  if(!it){ us.innerHTML=''; _ieRcPreview(); return; }
  var ids=[]; if(it.purchase_unit_id) ids.push(it.purchase_unit_id); if(ids.indexOf(it.base_unit_id)<0) ids.push(it.base_unit_id);
  var base=_invRef.units.filter(function(u){ return u.id===it.base_unit_id; })[0]||{};
  _invRef.units.forEach(function(u){ if(ids.indexOf(u.id)<0 && base.unit_type && u.unit_type===base.unit_type && base.unit_type!=='count') ids.push(u.id); });
  us.innerHTML=ids.map(function(id){ return '<option value="'+id+'">'+_invEsc(_ieUnitName(id))+(id===it.purchase_unit_id?' (as bought)':id===it.base_unit_id?' (stock unit)':'')+'</option>'; }).join('');
  var eh=document.getElementById('ieRcExpHint'); if(eh) eh.textContent= it.shelf_life_days? 'Leave empty to use the shelf life: '+it.shelf_life_days+' days from today.' : '';
  _ieRcPreview();
}
function _ieRcPreview(){
  var it=_ieItemById((document.getElementById('ieRcItem')||{}).value), box=document.getElementById('ieRcConv'); if(!box) return;
  var unit=+(document.getElementById('ieRcUnit')||{}).value, qty=parseFloat((document.getElementById('ieRcQty')||{}).value), cost=parseFloat((document.getElementById('ieRcCost')||{}).value);
  var lbl=document.getElementById('ieRcCostLbl'); if(lbl) lbl.textContent='Cost per '+(_ieUnitName(unit)||'unit')+' ₱';
  if(!it || !(qty>0)){ box.style.display='none'; return; }
  var sName=_ieUnitName(it.base_unit_id), uName=_ieUnitName(unit), t='';
  if(unit===it.purchase_unit_id && _invNum(it.purchase_to_stock)>0 && unit!==it.base_unit_id){
    var stock=qty*_invNum(it.purchase_to_stock);
    t=_ieQ(qty)+' '+uName+' × '+_ieQ(it.purchase_to_stock)+' = <span style="font-size:1rem">+'+_ieQ(stock)+' '+sName+'</span>';
    if(cost>0) t+='<div style="font-weight:600;font-size:.72rem;margin-top:2px">Total '+_iePeso(qty*cost)+' · '+_iePeso(cost/_invNum(it.purchase_to_stock))+' per '+sName+'</div>';
  } else {
    t='+'+_ieQ(qty)+' '+uName+(cost>0?'<div style="font-weight:600;font-size:.72rem;margin-top:2px">Total '+_iePeso(qty*cost)+'</div>':'');
    if(unit!==it.base_unit_id && !(unit===it.purchase_unit_id)) t+='<div style="font-weight:600;font-size:.7rem;margin-top:2px">Stocked in '+sName+'.</div>';
  }
  box.innerHTML=t; box.style.display='block';
}
async function _ieSubmitReceive(){
  var btn=document.getElementById('ieRcBtn'); if(btn&&btn.disabled) return;
  var itemId=+(document.getElementById('ieRcItem')||{}).value, qty=parseFloat((document.getElementById('ieRcQty')||{}).value), unitId=+(document.getElementById('ieRcUnit')||{}).value;
  if(!itemId){ showToast('Pick what you received','error'); return; }
  if(!(qty>0)){ showToast('Enter how many','error'); return; }
  if(btn){ btn.disabled=true; btn.textContent='Receiving…'; }
  var r=await api('invReceiveStock',{itemId:itemId,qty:qty,unitId:unitId,unitCost:parseFloat((document.getElementById('ieRcCost')||{}).value)||0,
    supplierId:+(document.getElementById('ieRcSup')||{}).value||null,locationId:+(document.getElementById('ieRcLoc')||{}).value||null,
    expiryDate:(document.getElementById('ieRcExp')||{}).value||null,notes:(document.getElementById('ieRcNotes')||{}).value||''});
  if(btn){ btn.disabled=false; btn.textContent='Receive'; }
  if(r&&r.ok){
    showToast('Received +'+_ieQ(r.qty_received)+' '+(r.stock_unit||'')+' · batch '+(r.batch_code||''),'success');
    ['ieRcQty','ieRcCost','ieRcExp','ieRcNotes'].forEach(function(id){ var e=document.getElementById(id); if(e) e.value=''; });
    await _invLoadStock(); _ieLoadTab('receive');
  } else showToast((r&&r.error)||'Receive failed','error');
}

// ══ WASTE ═════════════════════════════════════════════════════════════════
var _ieWsReason='', _ieWsPhoto='';
function _ieWasteHtml(){
  var inStock=_ieStock.filter(function(r){ return r.tracked && _invNum(r.stock_qty)>0; });
  var opts=inStock.map(function(r){ return '<option value="'+r.item_id+'"'+(_ieWsPreset===r.item_id?' selected':'')+'>'+_invEsc(r.name)+' — '+_ieQ(r.stock_qty)+' '+_invEsc(r.unit)+'</option>'; }).join('');
  var h=_ieBackToStock()+'<div class="ie-2col"><div>'+_ieBox('🗑️ Record waste / spoilage',
      (inStock.length? '<label class="ie-lbl">Item</label><select id="ieWsItem" class="ie-in" onchange="_ieWsChanged()">'+opts+'</select>'
      +'<label class="ie-lbl">How many?</label><div style="display:flex;gap:6px;align-items:center"><input id="ieWsQty" type="number" min="0" step="any" inputmode="decimal" class="ie-in" style="margin:0" oninput="_ieWsChanged()" placeholder="0"><span id="ieWsUnit" style="font-size:.8rem;color:var(--timber);white-space:nowrap"></span></div>'
      +'<div id="ieWsInfo" style="font-size:.7rem;color:var(--timber);margin-top:4px"></div>'
      +'<label class="ie-lbl">Why?</label><div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">'
      +IE_WASTE_REASONS.map(function(x){ return '<button class="ie-chip'+(_ieWsReason===x[0]?' on':'')+'" onclick="_ieWsReason=\''+x[0]+'\';this.parentNode.querySelectorAll(\'.ie-chip\').forEach(function(b){b.classList.remove(\'on\')});this.classList.add(\'on\')">'+x[1]+'</button>'; }).join('')+'</div>'
      +'<label class="ie-lbl">Note</label><input id="ieWsNote" class="ie-in" placeholder="what happened">'
      +'<label class="ie-lbl">Photo <span id="ieWsPhotoReq" style="font-weight:600;color:var(--timber)"></span></label>'
      +'<input type="file" accept="image/*" capture="environment" onchange="_ieWsPhotoPick(this)" class="ie-in" style="padding:6px">'
      +'<div id="ieWsPhotoOk" style="font-size:.7rem;color:#15803d;margin-top:3px">'+(_ieWsPhoto?'✓ Photo attached':'')+'</div>'
      +'<button id="ieWsBtn" onclick="_ieSubmitWaste()" style="width:100%;margin-top:14px;font-size:.9rem;font-weight:800;background:#b91c1c;color:#fff;border:none;border-radius:10px;padding:12px;cursor:pointer">Record waste</button>'
      +'<div style="font-size:.66rem;color:var(--timber);margin-top:6px">Taken from the '+'soonest-expiring batch and costed at that batch\'s price. Recorded with your name and the time.</div>'
      : _ieEmpty('Nothing is in stock yet, so there is nothing to waste.')))
    +'</div><div>'+_ieBox('Last 7 days', _ieWasteRecent.length? _ieWasteRecent.map(_ieMoveLine).join('') : _ieEmpty('No waste recorded.'))+'</div></div>';
  setTimeout(function(){ var s=document.getElementById('ieWsItem'); if(s){ if(s.options.length>15) _invSearchable(s); if(_ieWsPreset){ s.value=_ieWsPreset; if(s._invSync) s._invSync(); } _ieWsChanged(); } _ieWsPreset=null; },0);
  return h;
}
function _ieWsRow(){ var id=+(document.getElementById('ieWsItem')||{}).value; return _ieStock.filter(function(r){ return r.item_id===id; })[0]; }
function _ieWsChanged(){
  var r=_ieWsRow(); if(!r) return;
  var u=document.getElementById('ieWsUnit'); if(u) u.textContent=r.unit;
  var q=parseFloat((document.getElementById('ieWsQty')||{}).value)||0;
  var info=document.getElementById('ieWsInfo'); if(info) info.innerHTML='In stock: <b>'+_ieQ(r.stock_qty)+' '+_invEsc(r.unit)+'</b>'+(q>_invNum(r.stock_qty)?' · <b style="color:#b91c1c">more than in stock</b>':'');
  var pr=document.getElementById('ieWsPhotoReq'); if(pr) pr.textContent='(needed when the loss is over ₱'+_invPhotoAbove()+' at selling price)';
}
async function _ieWsPhotoPick(input){
  var f=input.files&&input.files[0]; if(!f) return;
  showToast('Uploading photo…','info'); var url=await _invUploadPhoto(f);
  if(url){ _ieWsPhoto=url; var ok=document.getElementById('ieWsPhotoOk'); if(ok) ok.textContent='✓ Photo attached'; }
}
async function _ieSubmitWaste(){
  var btn=document.getElementById('ieWsBtn'); if(btn&&btn.disabled) return;
  var r=_ieWsRow(), qty=parseFloat((document.getElementById('ieWsQty')||{}).value);
  if(!r){ showToast('Pick an item','error'); return; }
  if(!(qty>0)){ showToast('Enter how many','error'); return; }
  if(qty>_invNum(r.stock_qty)+1e-9){ showToast('Only '+_ieQ(r.stock_qty)+' '+r.unit+' in stock','error'); return; }
  if(!_ieWsReason){ showToast('Pick why','error'); return; }
  if(btn){ btn.disabled=true; btn.textContent='Saving…'; }
  var res=await api('invRecordSpoilage',{itemId:r.item_id,qty:qty,reason:_ieWsReason,notes:(document.getElementById('ieWsNote')||{}).value||'',photoUrl:_ieWsPhoto||null});
  if(btn){ btn.disabled=false; btn.textContent='Record waste'; }
  if(res&&res.ok){ showToast('Recorded '+(res.source_ref||'')+' · '+_iePeso(res.cost)+' at cost','success'); _ieWsReason=''; _ieWsPhoto=''; _ieLoadTab('waste'); }
  else showToast((res&&res.error)||'Failed','error');
}

// ══ ADD-ONS (recipes tab) ═════════════════════════════════════════════════
function _ieAddonsHtml(){
  if(!_ieAddons.length) return '';
  var h='<div style="margin-top:16px">'+_ieBox('➕ Add-ons use stock too <span style="font-weight:600;color:var(--timber);font-size:.7rem">— layered on top of the drink\'s size recipe</span>',
    _ieAddons.map(function(a,ai){
      var it=a.inv_item_id? _ieItemById(a.inv_item_id) : null;
      return '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:7px 0;border-top:1px solid var(--mist-light)">'
        +'<div><div style="font-size:.8rem;font-weight:700;color:var(--forest-deep)">'+_invEsc(a.name)+(a.is_active===false?' <span style="color:var(--timber);font-weight:600">(hidden)</span>':'')+'</div>'
        +'<div style="font-size:.68rem;color:'+(it?'#15803d':'var(--timber)')+'">'+(it? 'uses '+_ieQ(a.inv_qty)+' '+_invEsc(_ieUnitName(a.inv_unit_id))+' '+_invEsc(it.name) : 'not linked — selling it deducts nothing')+'</div></div>'
        +(_invIsAdmin()?_ieBtn(it?'Change':'Link','_ieAddonForm('+ai+')'):'')+'</div>';
    }).join(''))+'</div>';
  return h;
}
function _ieAddonForm(ai){
  var a=_ieAddons[ai]; if(!a) return;
  var ing=_ieItems().filter(function(it){ return it.item_type==='RAW_MATERIAL'||it.item_type==='PREP'||it.item_type==='PURCHASED_READY'; });
  var h='<div style="font-size:1rem;font-weight:800;color:var(--forest-deep);margin-right:34px">Add-on: '+_invEsc(a.name)+'</div>'
    +'<div style="font-size:.7rem;color:var(--timber);margin-bottom:6px">Each time it is sold, this much is taken from stock (on top of the drink\'s recipe).</div>'
    +'<label class="ie-lbl">Uses</label><select id="ieAdItem" class="ie-in"><option value="">— nothing (not linked) —</option>'+ing.map(function(it){ return '<option value="'+it.id+'"'+(a.inv_item_id===it.id?' selected':'')+'>'+_invEsc(it.name)+'</option>'; }).join('')+'</select>'
    +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><div><label class="ie-lbl">Quantity</label><input id="ieAdQty" type="number" step="any" class="ie-in" value="'+(a.inv_qty!=null?_invEsc(a.inv_qty):'')+'" placeholder="e.g. 18"></div>'
    +'<div><label class="ie-lbl">Unit</label><select id="ieAdUnit" class="ie-in">'+_invRef.units.map(function(u){ return '<option value="'+u.id+'"'+(a.inv_unit_id===u.id?' selected':'')+'>'+_invEsc(u.name)+'</option>'; }).join('')+'</select></div></div>'
    +'<button onclick="_ieSaveAddon('+ai+')" style="width:100%;margin-top:14px;font-size:.86rem;font-weight:800;background:var(--forest);color:#fff;border:none;border-radius:10px;padding:11px;cursor:pointer">Save</button>';
  _ieModal(h);
  var s=document.getElementById('ieAdItem'); if(s && s.options.length>15) _invSearchable(s);
}
async function _ieSaveAddon(ai){
  var code=(_ieAddons[ai]||{}).addon_code; if(!code) return;
  var itemId=+(document.getElementById('ieAdItem')||{}).value||null, qty=parseFloat((document.getElementById('ieAdQty')||{}).value), unit=+(document.getElementById('ieAdUnit')||{}).value;
  if(itemId && !(qty>0)){ showToast('Enter how much it uses','error'); return; }
  var r=await api('invSaveAddonMap',{addonCode:code,invItemId:itemId,invQty:itemId?qty:null,invUnitId:itemId?unit:null});
  if(r&&r.ok){ showToast('Add-on saved','success'); _ieCloseModal(); _ieLoadTab('recipes'); } else showToast((r&&r.error)||'Failed','error');
}

// ══ MENU STOCK — one list, no opening/closing ═════════════════════════════
// Every menu item: what's available now + today's movement. Sales deduct on
// their own; staff only Add, Waste, or Fix the count. Each is a ledger movement.
var _ieMenu = [], _ieMenuQ = '', _ieMenuMoves = [], _ieMenuNew = {}, _ieMenuShowRecipe = false, _ieMenuLoaded = false;
async function _ieLoadMenu(){
  var r=await api('invMenuStock',{}); _ieMenu=(r&&r.ok)?(r.rows||[]):[]; _ieMenuLoaded=true;
  var from=new Date(new Date(_invManilaToday()+'T00:00:00+08:00')).toISOString();
  var m=await api('invMovements',{from:from,limit:300});
  var ids={}; _ieMenu.forEach(function(x){ if(x.kind==='TRACKED') ids[x.item_id]=1; });
  _ieMenuMoves=((m&&m.ok)?(m.rows||[]):[]).filter(function(x){ return ids[x.item_id] && _invNum(x.qty)!==0; });
}
function _ieMenuMatch(x){ var q=_ieMenuQ.trim().toLowerCase(); return !q || ((x.name||'')+' '+(x.menus||'')+' '+(x.category||'')).toLowerCase().indexOf(q)>=0; }
var _ieMenuCat='ALL', _ieMenuOpenFresh={};
function _ieMenuCats(){
  var seen={}, out=[];
  _ieMenu.slice().sort(function(a,b){ return (a.cat_order||999)-(b.cat_order||999); }).forEach(function(x){
    var c=x.category||'OTHER'; if(!seen[c]){ seen[c]=1; out.push(c); } });
  return out;
}
function _ieMenuRowHtml(x){
  if(x.kind==='TRACKED'){
    var av=_invNum(x.available), col=av<=0?'#b91c1c':av<=3?'#b45309':'var(--forest-deep)';
    var today=[]; if(_invNum(x.added)) today.push('<span style="color:#15803d">+'+_ieQ(x.added)+' added</span>');
    if(_invNum(x.sold)) today.push('<span style="color:#1d4ed8">'+_ieQ(x.sold)+' sold</span>');
    if(_invNum(x.wasted)) today.push('<span style="color:#b91c1c">'+_ieQ(x.wasted)+' wasted</span>');
    if(_invNum(x.fixed)) today.push('<span style="color:#c2410c">'+_ieSigned(x.fixed)+' fixed</span>');
    if(_invNum(x.reserved)) today.push('<b style="color:#b45309">'+_ieQ(x.reserved)+' on open orders</b>');
    return '<div class="ms-row">'
      +'<div class="ms-name" onclick="_ieOpenItem('+x.item_id+',\'history\')"><div class="ms-t">'+_invEsc(x.name)+(x.open_shortages>0?' <span title="sold more than recorded" style="color:#b91c1c">⚠️</span>':'')+'</div>'
      +'<div class="ms-s">'+(today.length?'Today: '+today.join(' · '):'No movement today')+(x.next_expiry?' · exp '+_invDate(x.next_expiry):'')+'</div>'
      +'<div class="ms-s">'+_ieMenuCostLine(x)+'</div></div>'
      +'<div class="ms-av" style="color:'+col+'">'+_ieQ(av)+'<small>'+(av<=0?'SOLD OUT':_invEsc(x.unit)+' left')+'</small>'+(_invNum(x.reserved)?'<small style="color:#b45309">'+_ieQ(x.physical)+' on shelf</small>':'')+'</div>'
      +'<div class="ms-act">'+_ieBtn('+ Add','_ieMenuAddForm('+x.item_id+')',true,'padding:6px 10px')
      +_ieBtn('Waste','_ieMenuWasteForm('+x.item_id+')',false,'padding:6px 10px;border-color:#b91c1c;color:#b91c1c')
      +_ieBtn('Fix','_ieMenuFixForm('+x.item_id+')',false,'padding:6px 10px')+'</div></div>';
  }
  return '<div class="ms-row ms-new">'
    +'<div class="ms-name"><div class="ms-t" style="font-weight:600">'+_invEsc(x.name)+' <span style="color:var(--timber);font-size:.68rem;font-weight:600">'+_iePeso(x.price)+'</span></div>'
    +'<div class="ms-s">Not counted yet — type how many are available</div></div>'
    +'<div class="ms-act"><input type="number" min="0" step="any" inputmode="decimal" placeholder="qty" value="'+_invEsc(_ieMenuNew[x.menu_code]||'')+'" data-code="'+_invEsc(x.menu_code)+'" oninput="_ieMenuNew[this.dataset.code]=this.value;_ieMenuNewCount()" class="ie-in" style="width:92px;margin:0;padding:7px;text-align:right"></div></div>';
}
function _ieMenuCostLine(x){
  var c=_invNum(x.unit_cost), mcs=(x.menu_costs||[]).filter(function(m){ return _invNum(m.cost)>0; });
  var stock = c>0 ? _invEsc(x.unit)+' ₱'+_ieQ(c) : '';
  function mg(price,cost){ var p=_invNum(price); if(!(p>0)) return ''; var m=Math.round((p-cost)/p*100); return ' · <span style="color:'+(m<50?'#b45309':'#15803d')+'">'+m+'% margin</span>'; }
  if(mcs.length){
    // serving cost from Menu Costing (e.g. slice ₱50 + scoop ice cream ₱20 = ₱70)
    return mcs.map(function(m){
      return (mcs.length>1?_invEsc(m.name)+': ':'')+'Serving cost <b style="color:var(--forest-deep)">'+_iePeso(m.cost)+'</b>'
        +(stock?' <span style="color:var(--timber)">('+stock+' + extras)</span>':'')+' · sells '+_iePeso(m.price)+mg(m.price,_invNum(m.cost));
    }).join('<br>');
  }
  var p=_invNum(x.price);
  if(!(c>0)) return '<span style="color:#b45309;font-weight:700">Cost not set</span>'+(_invIsAdmin()?' · <a href="javascript:void 0" onclick="event.stopPropagation();_ieMenuCostForm('+x.item_id+')" style="color:var(--forest);font-weight:700">Set cost</a>':'')+(p?' · sells '+_iePeso(p):'');
  return 'Cost <b style="color:var(--forest-deep)">'+_iePeso(c)+'</b>/'+_invEsc(x.unit)+(p?' · sells '+_iePeso(p)+mg(p,c):'')
    +' <span style="color:var(--timber)">· add toppings/sides in Menu Costing</span>';
}
function _ieMenuCostForm(id){
  var x=_ieMenuRow(id); if(!x) return;
  _ieModal('<div style="font-size:1rem;font-weight:800;color:var(--forest-deep);margin-right:34px">Set cost: '+_invEsc(x.name)+'</div>'
    +'<div style="font-size:.72rem;color:var(--timber)">For the '+_ieQ(x.available)+' '+_invEsc(x.unit)+' on hand that have no cost yet. Later deliveries use the cost you enter on <b>+ Add</b>.</div>'
    +'<label class="ie-lbl">Cost per '+_invEsc(x.unit)+' ₱</label><input id="ieMcCost" type="number" min="0" step="any" inputmode="decimal" class="ie-in">'
    +(x.purchase_unit&&_invNum(x.purchase_to_stock)>0?'<div style="font-size:.7rem;color:var(--timber);margin-top:4px">Bought per '+_invEsc(x.purchase_unit)+'? Divide the '+_invEsc(x.purchase_unit)+' price by '+_ieQ(x.purchase_to_stock)+'.</div>':'')
    +'<button id="ieMcBtn" onclick="_ieMenuSetCost('+id+')" style="width:100%;margin-top:12px;font-size:.9rem;font-weight:800;background:var(--forest);color:#fff;border:none;border-radius:10px;padding:12px;cursor:pointer">Save cost</button>');
  setTimeout(function(){ var q=document.getElementById('ieMcCost'); if(q) q.focus(); },30);
}
async function _ieMenuSetCost(id){
  var b=document.getElementById('ieMcBtn'); if(b&&b.disabled) return;
  var c=parseFloat((document.getElementById('ieMcCost')||{}).value);
  if(!(c>0)){ showToast('Enter the cost','error'); return; }
  if(b){ b.disabled=true; b.textContent='Saving…'; }
  var r=await api('invMenuSetCost',{itemId:id,unitCost:c});
  if(r&&r.ok){ showToast('Cost saved · '+_iePeso(c)+' each','success'); _ieCloseModal(); await _ieLoadMenu(); _invRenderTab(); }
  else { if(b){ b.disabled=false; b.textContent='Save cost'; } showToast((r&&r.error)||'Failed','error'); }
}
function _ieMenuHtml(){
  _ieCss();
  if(!document.getElementById('msStyles')){
    var st=document.createElement('style'); st.id='msStyles';
    st.textContent='.ms-chips{display:flex;gap:6px;overflow-x:auto;padding:2px 0 10px;position:sticky;top:0;background:var(--mist-light,#f6f7f4);z-index:5;-webkit-overflow-scrolling:touch}'
      +'.ms-chips .ie-chip{white-space:nowrap;flex-shrink:0}'
      +'.ms-cat{background:#fff;border:1px solid var(--mist);border-radius:12px;margin-bottom:12px;overflow:hidden}'
      +'.ms-cath{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:var(--forest-deep);color:#fff}'
      +'.ms-cath b{font-size:.84rem;letter-spacing:.6px}.ms-cath span{font-size:.68rem;opacity:.85}'
      +'.ms-row{display:grid;grid-template-columns:1fr 110px auto;gap:10px;align-items:center;padding:9px 14px;border-top:1px solid var(--mist-light)}'
      +'.ms-row.ms-new{grid-template-columns:1fr auto;background:#fcfcfa}'
      +'.ms-name{min-width:0;cursor:pointer}.ms-new .ms-name{cursor:default}.ms-t{font-size:.86rem;font-weight:800;color:var(--forest-deep)}'
      +'.ms-s{font-size:.66rem;color:var(--timber);margin-top:1px}'
      +'.ms-av{text-align:right;font-size:1.25rem;font-weight:800;line-height:1}.ms-av small{display:block;font-size:.58rem;font-weight:700;color:var(--timber);margin-top:2px}'
      +'.ms-act{display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap}'
      +'.ms-fresh{padding:8px 14px;border-top:1px solid var(--mist-light);font-size:.72rem;color:var(--timber);display:flex;justify-content:space-between;align-items:center;gap:8px}'
      +'.ms-bar{position:sticky;bottom:10px;z-index:6;margin-top:6px}'
      +'@media(max-width:640px){.ms-row{grid-template-columns:1fr auto}.ms-row .ms-act{grid-column:1/-1;justify-content:stretch}.ms-row .ms-act button{flex:1}.ms-row.ms-new .ms-act{grid-column:auto}}';
    document.head.appendChild(st);
  }
  if(!_ieMenuLoaded) return _ieLoading();
  var q=_ieMenuQ.trim().toLowerCase(), cats=_ieMenuCats();
  if(_ieMenuCat!=='ALL' && cats.indexOf(_ieMenuCat)<0) _ieMenuCat='ALL';
  var h='<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">'
    +'<input id="ieMenuQ" value="'+_invEsc(_ieMenuQ)+'" oninput="_ieMenuQ=this.value;_ieMenuRerender()" placeholder="🔍 Search all menu items…" class="ie-in" style="flex:1;min-width:200px;margin:0;padding:8px 10px">'
    +(q?'<button onclick="_ieMenuQ=\'\';_invRenderTab()" aria-label="Clear search" style="border:1.5px solid var(--mist);background:#fff;border-radius:8px;padding:7px 11px;cursor:pointer;font-weight:800;color:var(--forest)">✕</button>':'')
    +'<div style="font-size:.72rem;color:var(--timber)">'+_invDateLong(_invManilaToday())+' · sales deduct automatically</div></div>';
  h+='<div class="ms-chips"><button class="ie-chip'+(!q&&_ieMenuCat==='ALL'?' on':'')+'" onclick="_ieMenuQ=\'\';_ieMenuCat=\'ALL\';_invRenderTab()">All</button>'
    +cats.map(function(c,i){ return '<button class="ie-chip'+(!q&&_ieMenuCat===c?' on':'')+'" onclick="_ieMenuQ=\'\';_ieMenuCat=_ieMenuCats()['+i+'];_invRenderTab()">'+_invEsc(c)+'</button>'; }).join('')+'</div>';
  var any=false;
  cats.forEach(function(c){
    if(!q && _ieMenuCat!=='ALL' && _ieMenuCat!==c) return;   // a search looks through every category
    var rows=_ieMenu.filter(function(x){ return (x.category||'OTHER')===c && (!q || ((x.name||'')+' '+(x.menus||'')).toLowerCase().indexOf(q)>=0); });
    if(!rows.length) return; any=true;
    rows.sort(function(a,b){ var k={TRACKED:0,NEW:1,RECIPE:2}; return (k[a.kind]-k[b.kind]) || String(a.name).localeCompare(String(b.name)); });
    var tr=rows.filter(function(x){ return x.kind==='TRACKED'; }), nw=rows.filter(function(x){ return x.kind==='NEW'; }), fr=rows.filter(function(x){ return x.kind==='RECIPE'; });
    var out=tr.filter(function(x){ return _invNum(x.available)<=0; }).length;
    h+='<div class="ms-cat"><div class="ms-cath"><b>'+_invEsc(c)+'</b><span>'+(tr.length?tr.length+' counted':'')+(out?' · '+out+' sold out':'')+(nw.length?(tr.length?' · ':'')+nw.length+' not counted':'')+(fr.length&&!tr.length&&!nw.length?'made fresh':'')+'</span></div>';
    tr.concat(nw).forEach(function(x){ h+=_ieMenuRowHtml(x); });
    if(fr.length){
      var open=_ieMenuOpenFresh[c] || !!q;
      h+='<div class="ms-fresh"><span>☕ '+fr.length+' made fresh to order — no count needed'+(open?': '+fr.map(function(x){ return _invEsc(x.name); }).join(', '):'')+'</span>'
        +(q?'':'<button class="ie-chip" style="padding:4px 10px" data-cat="'+_invEsc(c)+'" onclick="_ieMenuOpenFresh[this.dataset.cat]=!_ieMenuOpenFresh[this.dataset.cat];_invRenderTab()">'+(open?'Hide':'Show')+'</button>')+'</div>';
    }
    h+='</div>';
  });
  if(!any) h+='<div style="background:#fff;border:1px dashed var(--mist);border-radius:12px;padding:30px;text-align:center;color:var(--timber);font-size:.8rem">No menu item matches “'+_invEsc(_ieMenuQ)+'”. <a href="javascript:void 0" onclick="_ieMenuQ=\'\';_invRenderTab()" style="color:var(--forest);font-weight:700">Clear search</a></div>';
  var entered=Object.keys(_ieMenuNew).filter(function(k){ return _invNum(_ieMenuNew[k])>0; }).length;
  h+='<div class="ms-bar" id="ieMenuBar" style="display:'+(entered?'block':'none')+'"><button id="ieMenuStart" onclick="_ieMenuStartAll()" style="width:100%;font-size:.9rem;font-weight:800;background:var(--forest);color:#fff;border:none;border-radius:12px;padding:13px;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.18)">Start counting '+entered+' item'+(entered!==1?'s':'')+'</button></div>';
  h+='<div style="margin-top:14px">'+_ieBox('🧾 Today\'s menu movements', _ieMenuMoves.length? _ieMenuMoves.slice(0,60).map(_ieMoveLine).join('') : _ieEmpty('No movement yet today.'), _ieBtn('All history','_invSetTab(\'moves\')'))+'</div>';
  return h;
}
var _ieMenuTimer=null;
function _ieMenuAutoRefresh(){
  if(_ieMenuTimer) return;
  _ieMenuTimer=setInterval(async function(){
    var v=document.getElementById('inventoryView');
    if(_invTab!=='menu' || !v || v.offsetParent===null){ clearInterval(_ieMenuTimer); _ieMenuTimer=null; return; }
    if(document.getElementById('ieModal')) return;                        // a form is open
    var a=document.activeElement; if(a && a.tagName==='INPUT') return;      // someone is typing
    if(Object.keys(_ieMenuNew).some(function(k){ return _invNum(_ieMenuNew[k])>0; })) return;
    await _ieLoadMenu(); if(_invTab==='menu') _invRenderTab();
  }, 30000);
}
function _ieMenuRerender(){ var q=document.getElementById('ieMenuQ'); var pos=q?q.selectionStart:null; _invRenderTab(); var q2=document.getElementById('ieMenuQ'); if(q2&&pos!==null){ q2.focus(); q2.setSelectionRange(pos,pos); } }
function _ieMenuNewCount(){ var b=document.getElementById('ieMenuStart'), bar=document.getElementById('ieMenuBar'); if(!b) return; var n=Object.keys(_ieMenuNew).filter(function(k){ return _invNum(_ieMenuNew[k])>0; }).length; b.textContent='Start counting '+n+' item'+(n!==1?'s':''); if(bar) bar.style.display=n?'block':'none'; }
async function _ieMenuStartAll(){
  var codes=Object.keys(_ieMenuNew).filter(function(k){ return _invNum(_ieMenuNew[k])>0; });
  if(!codes.length){ showToast('Type a quantity next to at least one item','error'); return; }
  var b=document.getElementById('ieMenuStart'); if(b){ b.disabled=true; b.textContent='Saving…'; }
  var ok=0, fail=[];
  for(var i=0;i<codes.length;i++){
    var r=await api('invMenuAdd',{menuCode:codes[i],qty:parseFloat(_ieMenuNew[codes[i]])});
    if(r&&r.ok){ ok++; delete _ieMenuNew[codes[i]]; } else fail.push((r&&r.error)||codes[i]);
  }
  showToast(ok+' item'+(ok!==1?'s':'')+' now tracked'+(fail.length?' · '+fail.length+' failed: '+fail[0]:''), fail.length?'error':'success');
  await _ieLoadMenu(); _invRenderTab();
}
function _ieShelf(x){ return x.physical!=null ? _invNum(x.physical) : _invNum(x.available); }
function _ieMenuRow(id){ return _ieMenu.filter(function(x){ return x.kind==='TRACKED' && x.item_id===id; })[0]; }
function _ieMenuAddForm(id){
  var x=_ieMenuRow(id); if(!x) return;
  var units='<option value="'+x.base_unit_id+'">'+_invEsc(x.unit)+'</option>'+(x.purchase_unit_id&&x.purchase_unit_id!==x.base_unit_id?'<option value="'+x.purchase_unit_id+'">'+_invEsc(x.purchase_unit)+' (= '+_ieQ(x.purchase_to_stock)+' '+_invEsc(x.unit)+')</option>':'');
  _ieModal('<div style="font-size:1rem;font-weight:800;color:var(--forest-deep);margin-right:34px">+ Add: '+_invEsc(x.name)+'</div>'
    +'<div style="font-size:.72rem;color:var(--timber)">Now available: <b>'+_ieQ(x.available)+' '+_invEsc(x.unit)+'</b></div>'
    +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><div><label class="ie-lbl">How many?</label><input id="ieMaQty" type="number" min="0" step="any" inputmode="decimal" class="ie-in" oninput="_ieMaPrev('+id+')"></div>'
    +'<div><label class="ie-lbl">Unit</label><select id="ieMaUnit" class="ie-in" onchange="_ieMaUnitChanged('+id+')">'+units+'</select></div></div>'
    +'<label class="ie-lbl" id="ieMaCostL">Cost per '+_invEsc(x.unit)+' ₱</label><input id="ieMaCost" type="number" min="0" step="any" inputmode="decimal" class="ie-in" value="'+(_invNum(x.unit_cost)>0?_invEsc(x.unit_cost):'')+'" oninput="this.dataset.touched=1;_ieMaPrev('+id+')">'
    +'<label class="ie-lbl">Note</label><input id="ieMaNote" class="ie-in" placeholder="e.g. fresh batch from supplier">'
    +'<div id="ieMaPrev" style="margin-top:10px;font-size:.84rem;font-weight:800;color:#14532d"></div>'
    +'<button id="ieMaBtn" onclick="_ieMenuAdd('+id+')" style="width:100%;margin-top:12px;font-size:.9rem;font-weight:800;background:var(--forest);color:#fff;border:none;border-radius:10px;padding:12px;cursor:pointer">Add</button>');
  setTimeout(function(){ var q=document.getElementById('ieMaQty'); if(q) q.focus(); },30);
}
function _ieMaUnitChanged(id){
  var x=_ieMenuRow(id), c=document.getElementById('ieMaCost'), u=+(document.getElementById('ieMaUnit')||{}).value;
  if(c && !c.dataset.touched && _invNum(x.unit_cost)>0){
    var isPu = x.purchase_unit_id && u===x.purchase_unit_id && u!==x.base_unit_id;
    c.value = Math.round(_invNum(x.unit_cost)*(isPu?_invNum(x.purchase_to_stock):1)*100)/100;
  }
  _ieMaPrev(id);
}
function _ieMaPrev(id){
  var x=_ieMenuRow(id), q=parseFloat((document.getElementById('ieMaQty')||{}).value)||0, u=+(document.getElementById('ieMaUnit')||{}).value, c=parseFloat((document.getElementById('ieMaCost')||{}).value);
  var isPu = x.purchase_unit_id && u===x.purchase_unit_id && u!==x.base_unit_id;
  var add = isPu ? q*_invNum(x.purchase_to_stock) : q;
  var L=document.getElementById('ieMaCostL'); if(L) L.textContent='Cost per '+(isPu?x.purchase_unit:x.unit)+' ₱ (optional)';
  var p=document.getElementById('ieMaPrev'); if(p) p.innerHTML = q>0 ? (isPu? _ieQ(q)+' '+_invEsc(x.purchase_unit)+' × '+_ieQ(x.purchase_to_stock)+' = +'+_ieQ(add)+' '+_invEsc(x.unit) : '+'+_ieQ(add)+' '+_invEsc(x.unit))+' → <span style="color:var(--forest-deep)">'+_ieQ(_invNum(x.available)+add)+' available</span>'+(c>0?'<div style="font-weight:600;font-size:.72rem">'+_iePeso(isPu?c/_invNum(x.purchase_to_stock):c)+' per '+_invEsc(x.unit)+'</div>':'') : '';
}
async function _ieMenuAdd(id){
  var b=document.getElementById('ieMaBtn'); if(b&&b.disabled) return;
  var q=parseFloat((document.getElementById('ieMaQty')||{}).value);
  if(!(q>0)){ showToast('Enter how many','error'); return; }
  if(b){ b.disabled=true; b.textContent='Adding…'; }
  var r=await api('invMenuAdd',{itemId:id,qty:q,unitId:+(document.getElementById('ieMaUnit')||{}).value,unitCost:parseFloat((document.getElementById('ieMaCost')||{}).value)||null,note:(document.getElementById('ieMaNote')||{}).value||''});
  if(r&&r.ok){ showToast('Added +'+_ieQ(r.qty_received)+' · now '+_ieQ(r.available),'success'); _ieCloseModal(); await _ieLoadMenu(); _invRenderTab(); }
  else { if(b){ b.disabled=false; b.textContent='Add'; } showToast((r&&r.error)||'Failed','error'); }
}
function _ieMenuWasteForm(id){
  var x=_ieMenuRow(id); if(!x) return; _ieWsReason=''; _ieWsPhoto='';
  _ieModal('<div style="font-size:1rem;font-weight:800;color:#b91c1c;margin-right:34px">Waste: '+_invEsc(x.name)+'</div>'
    +'<div style="font-size:.72rem;color:var(--timber)">On the shelf: <b>'+_ieQ(_ieShelf(x))+' '+_invEsc(x.unit)+'</b></div>'
    +'<label class="ie-lbl">How many?</label><input id="ieMwQty" type="number" min="0" step="any" inputmode="decimal" class="ie-in">'
    +'<label class="ie-lbl">Why?</label><div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">'
    +IE_WASTE_REASONS.map(function(z){ return '<button class="ie-chip" onclick="_ieWsReason=\''+z[0]+'\';this.parentNode.querySelectorAll(\'.ie-chip\').forEach(function(b){b.classList.remove(\'on\')});this.classList.add(\'on\')">'+z[1]+'</button>'; }).join('')+'</div>'
    +'<label class="ie-lbl">Note</label><input id="ieMwNote" class="ie-in" placeholder="what happened">'
    +'<label class="ie-lbl">Photo <span style="font-weight:600;color:var(--timber)">(needed when over ₱'+_invPhotoAbove()+' at menu price)</span></label>'
    +'<input type="file" accept="image/*" capture="environment" onchange="_ieWsPhotoPick(this)" class="ie-in" style="padding:6px"><div id="ieWsPhotoOk" style="font-size:.7rem;color:#15803d;margin-top:3px"></div>'
    +'<button id="ieMwBtn" onclick="_ieMenuWaste('+id+')" style="width:100%;margin-top:12px;font-size:.9rem;font-weight:800;background:#b91c1c;color:#fff;border:none;border-radius:10px;padding:12px;cursor:pointer">Record waste</button>');
}
async function _ieMenuWaste(id){
  var x=_ieMenuRow(id), b=document.getElementById('ieMwBtn'); if(b&&b.disabled) return;
  var q=parseFloat((document.getElementById('ieMwQty')||{}).value);
  if(!(q>0)){ showToast('Enter how many','error'); return; }
  if(q>_ieShelf(x)+1e-9){ showToast('Only '+_ieQ(_ieShelf(x))+' on the shelf','error'); return; }
  if(!_ieWsReason){ showToast('Pick why','error'); return; }
  if(b){ b.disabled=true; b.textContent='Saving…'; }
  var r=await api('invRecordSpoilage',{itemId:id,qty:q,reason:_ieWsReason,notes:(document.getElementById('ieMwNote')||{}).value||'',photoUrl:_ieWsPhoto||null});
  if(r&&r.ok){ showToast('Waste recorded · '+_ieQ(r.remaining)+' left','success'); _ieCloseModal(); await _ieLoadMenu(); _invRenderTab(); }
  else { if(b){ b.disabled=false; b.textContent='Record waste'; } showToast((r&&r.error)||'Failed','error'); }
}
function _ieMenuFixForm(id){
  var x=_ieMenuRow(id); if(!x) return;
  _ieModal('<div style="font-size:1rem;font-weight:800;color:var(--forest-deep);margin-right:34px">Fix count: '+_invEsc(x.name)+'</div>'
    +'<div style="font-size:.72rem;color:var(--timber)">The system says <b>'+_ieQ(_ieShelf(x))+' '+_invEsc(x.unit)+' on the shelf</b>'+(_invNum(x.reserved)?' (including '+_ieQ(x.reserved)+' for orders not served yet)':'')+'. Enter what is really there — the difference is recorded with your name.</div>'
    +'<label class="ie-lbl">Really there</label><input id="ieMfQty" type="number" min="0" step="any" inputmode="decimal" class="ie-in" oninput="_ieMfPrev('+id+')">'
    +'<div id="ieMfPrev" style="margin-top:6px;font-size:.8rem;font-weight:800"></div>'
    +'<label class="ie-lbl">Note</label><input id="ieMfNote" class="ie-in" placeholder="e.g. 2 given to staff, not recorded">'
    +'<button id="ieMfBtn" onclick="_ieMenuFix('+id+')" style="width:100%;margin-top:12px;font-size:.9rem;font-weight:800;background:var(--forest);color:#fff;border:none;border-radius:10px;padding:12px;cursor:pointer">Save count</button>');
  setTimeout(function(){ var q=document.getElementById('ieMfQty'); if(q) q.focus(); },30);
}
function _ieMfPrev(id){
  var x=_ieMenuRow(id), v=(document.getElementById('ieMfQty')||{}).value, p=document.getElementById('ieMfPrev'); if(!p) return;
  if(v===''){ p.textContent=''; return; }
  var d=parseFloat(v)-_ieShelf(x);
  p.innerHTML = Math.abs(d)<1e-9 ? '<span style="color:#15803d">Matches ✓</span>' : '<span style="color:'+(d<0?'#b91c1c':'#15803d')+'">'+(d<0?'Missing ':'Extra ')+_ieQ(Math.abs(d))+' '+_invEsc(x.unit)+'</span>';
}
async function _ieMenuFix(id){
  var b=document.getElementById('ieMfBtn'); if(b&&b.disabled) return;
  var v=(document.getElementById('ieMfQty')||{}).value;
  if(v===''||!(parseFloat(v)>=0)){ showToast('Enter what is really there','error'); return; }
  if(b){ b.disabled=true; b.textContent='Saving…'; }
  var r=await api('invMenuSetCount',{itemId:id,actual:parseFloat(v),note:(document.getElementById('ieMfNote')||{}).value||''});
  if(r&&r.ok){ showToast('Count saved · '+_ieQ(r.available)+' available','success'); _ieCloseModal(); await _ieLoadMenu(); _invRenderTab(); }
  else { if(b){ b.disabled=false; b.textContent='Save count'; } showToast((r&&r.error)||'Failed','error'); }
}
