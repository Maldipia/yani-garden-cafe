// ══════════════════════════════════════════════════════════════════════════
// admin-inventory.js — YANI Stock Control UI
// Phase: Stock (table-first) + Items + Settings. Module stays OFF.
// UI -> api() -> inv_* handler -> inv_* tables. orders.js NEVER touched.
// ══════════════════════════════════════════════════════════════════════════

var _invCfg   = {};
var _invRef   = { units: [], locations: [], suppliers: [], itemTypes: [] };
var _invItems = [];
var _invUnits2 = [];           // stock units
var _invDash  = null;
var _invTab   = 'stock';
var _invItemFilter = 'ALL';
// stock filters
var _invSearch = '';
var _invSType  = 'ALL';
var _invSLoc   = 'ALL';
var _invSStatus= 'ALL';
var _invSLowOnly = false;
var _invSExpiry  = 'ALL';

function _invIsOwner() { return currentUser && currentUser.role === 'OWNER'; }
function _invIsAdmin() { return currentUser && (currentUser.role === 'OWNER' || currentUser.role === 'ADMIN'); }
function _invEsc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
function _invNum(n){ var x=parseFloat(n); return isNaN(x)?0:x; }
function _invFmtQty(n){ var x=_invNum(n); return (x%1===0)? String(x) : x.toFixed(2).replace(/\.?0+$/,''); }
function _invDate(d){ if(!d) return '—'; try{ return new Date(d).toLocaleDateString('en-PH',{month:'short',day:'numeric'}); }catch(e){ return String(d).substring(0,10);} }
function _invDaysTo(d){ if(!d) return null; return Math.floor((new Date(d) - new Date())/864e5); }

var INV_TYPE_META = {
  RAW_MATERIAL:    { label:'Raw Material',        short:'Raw',       ico:'🌾', blurb:'Flour, milk, sugar, coffee — consumed in recipes. Partial use allowed.' },
  PURCHASED_READY: { label:'Purchased Ready-to-Sell', short:'Purchased', ico:'📦', blurb:'Croissants, bottled drinks, supplier cakes — sold as-is. No recipe.' },
  PREP:            { label:'Prep / Sub-Recipe',   short:'Prep',      ico:'🥣', blurb:'Sauces, creams, fillings — made in batches, used by other recipes.' },
  PRODUCED:        { label:'Produced',            short:'Produced',  ico:'🎂', blurb:'YANI-made cakes, brownies, cookies — made from ingredients.' },
  PORTIONABLE:     { label:'Portionable',         short:'Portion',   ico:'🍰', blurb:'Sold whole OR cut into portions (e.g. cake → slices).' },
};
function _invTypeShort(t){ return (INV_TYPE_META[t]||{short:t}).short; }
function _invTypeIco(t){ return (INV_TYPE_META[t]||{ico:'📦'}).ico; }

// status pill styling
function _invStatusPillBig(st){
  var c = _invStatusColor(st);
  return '<span style="font-size:.64rem;font-weight:800;letter-spacing:.3px;padding:2px 7px;border-radius:5px;background:'+c.bg+';color:'+c.fg+'">'+_invEsc(st||'—')+'</span>';
}
function _invStatusColor(st){
  st = String(st||'').toUpperCase();
  var m = {
    AVAILABLE:{bg:'#e7f3ea',fg:'#15803d'}, WHOLE:{bg:'#e7f3ea',fg:'#15803d'}, OPEN:{bg:'#eef5ff',fg:'#1d4ed8'},
    LOW:{bg:'#fef3c7',fg:'#b45309'}, EXPIRING:{bg:'#ffedd5',fg:'#c2410c'}, EXPIRED:{bg:'#fde8e8',fg:'#b91c1c'},
    PORTIONED:{bg:'#f3e8ff',fg:'#7e22ce'}, DEPLETED:{bg:'#eceef0',fg:'#64748b'}, WASTED:{bg:'#f1e0e0',fg:'#9b2c2c'},
    PARTIAL:{bg:'#eef5ff',fg:'#1d4ed8'}
  };
  return m[st] || {bg:'var(--mist-light)',fg:'var(--forest)'};
}

// derive a display status per unit (visual overlay without mutating data)
function _invUnitStatus(u){
  var base = String(u.status||'').toUpperCase();
  if (base==='PORTIONED'||base==='DEPLETED'||base==='WASTED') return base;
  var rem = _invNum(u.quantity_remaining), orig = _invNum(u.quantity_original);
  if (rem<=0) return 'DEPLETED';
  var d = _invDaysTo(u.expiry_date);
  if (d!==null && d<0) return 'EXPIRED';
  if (d!==null && d<=3) return 'EXPIRING';
  if (rem<orig) return 'OPEN';
  return base || 'AVAILABLE';
}

// ── ENTRY ──────────────────────────────────────────────────────────────────
async function initInventory() {
  var v = document.getElementById('inventoryView');
  if (!v) return;
  if (!_invIsAdmin()) { v.innerHTML = '<div style="padding:40px;text-align:center;color:var(--timber)">Stock Control is available to ADMIN and OWNER only.</div>'; return; }
  v.innerHTML = '<div style="padding:32px;text-align:center;color:var(--timber)">Loading Stock Control…</div>';
  await _invLoadAll();
  _invRender();
}

async function _invLoadAll() {
  try {
    var cfg = await api('invGetConfig', {}); _invCfg = (cfg && cfg.ok) ? (cfg.config||{}) : {};
    var ref = await api('invGetRefData', {}); if (ref && ref.ok) _invRef = { units:ref.units||[], locations:ref.locations||[], suppliers:ref.suppliers||[], itemTypes:ref.itemTypes||[] };
    await _invLoadItems();
    await _invLoadStock();
  } catch(e) {}
}
async function _invLoadItems(){ var b={activeOnly:true}; if(_invItemFilter!=='ALL')b.itemType=_invItemFilter; var r=await api('invListItems',b); _invItems=(r&&r.ok)?(r.items||r.data||[]):[]; }
async function _invLoadStock(){
  var r = await api('invListStockUnits', { limit:500 });
  _invUnits2 = (r&&r.ok)?(r.stockUnits||[]):[];
  var d = await api('invDashboard', {}); _invDash = (d&&d.ok)?d:null;
}

// ── SHELL ──────────────────────────────────────────────────────────────────
function _invRender() {
  var v = document.getElementById('inventoryView'); if (!v) return;
  var enabled = (_invCfg.module_enabled === 'true');
  var h = '<div style="max-width:1240px;margin:0 auto;padding:14px 14px 60px">';
  h += '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">';
  h += '<div><h2 style="margin:0;color:var(--forest-deep);font-size:1.25rem">Stock Control</h2>'
     + '<div style="font-size:.72rem;color:var(--timber);margin-top:1px">Track every physical stock unit, batch, expiry, usage and movement.</div></div>';
  h += '<div style="font-size:.68rem;font-weight:700;padding:5px 11px;border-radius:20px;'
     + (enabled?'background:#fde8e8;color:#b91c1c':'background:var(--mist-light);color:var(--forest)')+'">'+(enabled?'● LIVE':'○ MODULE OFF (safe)')+'</div>';
  h += '</div>';
  // tabs
  h += '<div style="display:flex;gap:4px;border-bottom:2px solid var(--mist-light);margin:10px 0 14px">';
  [['stock','📊 Stock'],['items','🏷️ Items'],['settings','⚙️ Settings']].forEach(function(t){
    var on=_invTab===t[0];
    h += '<button onclick="_invSetTab(\''+t[0]+'\')" style="background:none;border:none;cursor:pointer;padding:7px 14px;font-size:.8rem;font-weight:700;'
       + (on?'color:var(--forest-deep);border-bottom:3px solid var(--gold);margin-bottom:-2px':'color:var(--timber)')+'">'+t[1]+'</button>';
  });
  h += '</div><div id="invTabBody"></div></div>';
  h += '<div id="invDrawerHost"></div>';
  v.innerHTML = h;
  _invRenderTab();
}
function _invSetTab(t){ _invTab=t; _invRender(); }
function _invRenderTab(){
  var b=document.getElementById('invTabBody'); if(!b) return;
  if (_invTab==='stock') b.innerHTML=_invStockHtml();
  else if (_invTab==='items') b.innerHTML=_invItemsHtml();
  else b.innerHTML=_invSettingsHtml();
}

// ── STOCK TAB (table-first) ─────────────────────────────────────────────────
function _invSummaryCards(){
  var units=_invUnits2, today=new Date();
  var total=units.filter(function(u){return _invNum(u.quantity_remaining)>0 && String(u.status).toUpperCase()!=='PORTIONED';}).length;
  var expired=units.filter(function(u){var d=_invDaysTo(u.expiry_date);return d!==null&&d<0&&_invNum(u.quantity_remaining)>0;}).length;
  var expiring=units.filter(function(u){var d=_invDaysTo(u.expiry_date);return d!==null&&d>=0&&d<=7&&_invNum(u.quantity_remaining)>0;}).length;
  var partial=units.filter(function(u){var r=_invNum(u.quantity_remaining),o=_invNum(u.quantity_original);return r>0&&r<o;}).length;
  var low=(_invDash&&_invDash.lowStock)?_invDash.lowStock.length:0;
  var usageToday=0;
  if(_invDash&&_invDash.recentTransactions){ _invDash.recentTransactions.forEach(function(t){ var d=new Date(t.performed_at); if(d.toDateString()===today.toDateString() && String(t.transaction_type).toUpperCase().indexOf('CONSUM')>-1) usageToday++; }); }
  var cards=[
    ['Total Stock', total, '#314C47'],
    ['Low Stock', low, '#b45309'],
    ['Expiring Soon', expiring, '#c2410c'],
    ['Expired', expired, '#b91c1c'],
    ['Partial / Open', partial, '#1d4ed8'],
    ["Today's Usage", usageToday, '#15803d'],
  ];
  var h='<div style="display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin-bottom:12px">';
  cards.forEach(function(c){
    h+='<div style="background:#fff;border:1px solid var(--mist);border-radius:9px;padding:8px 10px">'
      +'<div style="font-size:.62rem;color:var(--timber);text-transform:uppercase;letter-spacing:.3px;font-weight:600">'+c[0]+'</div>'
      +'<div style="font-size:1.35rem;font-weight:800;color:'+c[2]+';line-height:1.1;margin-top:2px">'+c[1]+'</div></div>';
  });
  h+='</div>';
  return h;
}

function _invStockHtml(){
  var h='';
  h+=_invSummaryCards();
  // action buttons
  h+='<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">';
  var pa=[['+ Receive Stock','_invOpenReceive()',1],['+ Produce','_invOpenProduce()',0],['+ Portion','_invOpenPortion()',0],['Record Usage','_invOpenUse()',0],['Record Waste','_invOpenWaste()',0]];
  pa.forEach(function(a){
    h+='<button onclick="'+a[1]+'" style="font-size:.74rem;font-weight:700;border-radius:8px;padding:7px 13px;cursor:pointer;border:1.5px solid var(--forest);'
      +(a[2]?'background:var(--forest);color:#fff':'background:#fff;color:var(--forest)')+'">'+a[0]+'</button>';
  });
  h+='</div>';
  // filter bar
  h+='<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:10px">';
  h+='<input id="invSearch" value="'+_invEsc(_invSearch)+'" oninput="_invSearch=this.value;_invRenderStockTable()" placeholder="🔍 Search stock code, item, batch…" style="flex:1;min-width:180px;font-size:.76rem;padding:7px 10px;border:1.5px solid var(--mist);border-radius:8px">';
  var typeSel='<select onchange="_invSType=this.value;_invRenderStockTable()" style="font-size:.74rem;padding:7px 8px;border:1.5px solid var(--mist);border-radius:8px"><option value="ALL">All types</option>';
  Object.keys(INV_TYPE_META).forEach(function(k){ typeSel+='<option value="'+k+'"'+(_invSType===k?' selected':'')+'>'+INV_TYPE_META[k].label+'</option>'; });
  typeSel+='</select>'; h+=typeSel;
  var locSel='<select onchange="_invSLoc=this.value;_invRenderStockTable()" style="font-size:.74rem;padding:7px 8px;border:1.5px solid var(--mist);border-radius:8px"><option value="ALL">All locations</option>';
  _invRef.locations.forEach(function(l){ locSel+='<option value="'+_invEsc(l.name)+'"'+(_invSLoc===l.name?' selected':'')+'>'+_invEsc(l.name)+'</option>'; });
  locSel+='</select>'; h+=locSel;
  var stSel='<select onchange="_invSStatus=this.value;_invRenderStockTable()" style="font-size:.74rem;padding:7px 8px;border:1.5px solid var(--mist);border-radius:8px">';
  ['ALL','AVAILABLE','OPEN','LOW','EXPIRING','EXPIRED','PORTIONED','DEPLETED'].forEach(function(s){ stSel+='<option value="'+s+'"'+(_invSStatus===s?' selected':'')+'>'+(s==='ALL'?'All status':s)+'</option>'; });
  stSel+='</select>'; h+=stSel;
  h+='<label style="font-size:.72rem;color:var(--forest);display:flex;align-items:center;gap:5px;cursor:pointer"><input type="checkbox" '+(_invSLowOnly?'checked':'')+' onchange="_invSLowOnly=this.checked;_invRenderStockTable()"> Low stock only</label>';
  h+='</div>';
  // table container
  h+='<div id="invStockTableWrap"></div>';
  setTimeout(_invRenderStockTable,10);
  return h;
}

function _invFilteredUnits(){
  var q=_invSearch.trim().toLowerCase();
  return _invUnits2.filter(function(u){
    var it=u.inv_items||{}, loc=(u.inv_locations||{}).name||'';
    if(_invSType!=='ALL' && it.item_type!==_invSType) return false;
    if(_invSLoc!=='ALL' && loc!==_invSLoc) return false;
    if(_invSStatus!=='ALL'){ var ds=_invUnitStatus(u); if(ds!==_invSStatus) return false; }
    if(_invSLowOnly){ var r=_invNum(u.quantity_remaining),o=_invNum(u.quantity_original); if(!(o>0 && r/o<=0.2)) return false; }
    if(q){ var hay=((u.stock_unit_code||'')+' '+(it.name||'')+' '+(u.batch_id||'')).toLowerCase(); if(hay.indexOf(q)<0) return false; }
    return true;
  });
}

function _invRenderStockTable(){
  var wrap=document.getElementById('invStockTableWrap'); if(!wrap) return;
  var rows=_invFilteredUnits();
  if(!_invUnits2.length){
    wrap.innerHTML='<div style="background:#fff;border:1px dashed var(--mist);border-radius:12px;padding:44px 20px;text-align:center">'
      +'<div style="font-size:1.6rem">📦</div>'
      +'<div style="font-size:.9rem;font-weight:700;color:var(--forest-deep);margin-top:6px">No stock units yet</div>'
      +'<div style="font-size:.76rem;color:var(--timber);margin-top:4px;max-width:420px;margin-left:auto;margin-right:auto">Stock appears here once you receive it. Tap <b>+ Receive Stock</b> to add your first physical unit, or <b>+ Produce</b> to make one from a recipe.</div></div>';
    return;
  }
  var cols=['Stock Code','Item','Type','Qty','Unit','Batch','Received','Expiry','Location','Status'];
  var h='<div style="background:#fff;border:1px solid var(--mist);border-radius:10px;overflow:auto">';
  h+='<table style="width:100%;border-collapse:collapse;font-size:.73rem;min-width:900px">';
  h+='<thead><tr style="background:var(--forest-deep)">';
  cols.forEach(function(c,i){ h+='<th style="text-align:'+(i===3?'right':'left')+';padding:7px 9px;color:#fff;font-weight:700;font-size:.66rem;text-transform:uppercase;letter-spacing:.3px;white-space:nowrap">'+c+'</th>'; });
  h+='</tr></thead><tbody>';
  rows.forEach(function(u,idx){
    var it=u.inv_items||{}, un=(u.inv_units||{}).name||'', loc=(u.inv_locations||{}).name||'—';
    var ds=_invUnitStatus(u);
    var bg = idx%2 ? 'var(--mist-light)' : '#fff';
    h+='<tr onclick="_invOpenDrawer('+u.id+')" style="cursor:pointer;background:'+bg+';border-top:1px solid var(--mist-light)" onmouseover="this.style.background=\'#eef5f0\'" onmouseout="this.style.background=\''+bg+'\'">';
    h+='<td style="padding:6px 9px;font-weight:700;color:var(--forest);white-space:nowrap">'+_invEsc(u.stock_unit_code||'—')+'</td>';
    h+='<td style="padding:6px 9px;color:var(--forest-deep);font-weight:600;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+_invEsc(it.name||'—')+'</td>';
    h+='<td style="padding:6px 9px;white-space:nowrap"><span style="font-size:.64rem;background:var(--mist-light);color:var(--forest);padding:2px 6px;border-radius:5px;font-weight:700">'+_invTypeIco(it.item_type)+' '+_invEsc(_invTypeShort(it.item_type))+'</span></td>';
    h+='<td style="padding:6px 9px;text-align:right;font-weight:800;color:var(--forest-deep)">'+_invFmtQty(u.quantity_remaining)+'</td>';
    h+='<td style="padding:6px 9px;color:var(--timber)">'+_invEsc(un||'—')+'</td>';
    h+='<td style="padding:6px 9px;color:var(--timber);white-space:nowrap">'+_invEsc(u.batch_id||'—')+'</td>';
    h+='<td style="padding:6px 9px;color:var(--timber);white-space:nowrap">'+_invDate(u.date_received)+'</td>';
    var dexp=_invDaysTo(u.expiry_date);
    var expColor=(dexp!==null&&dexp<0)?'#b91c1c':(dexp!==null&&dexp<=3?'#c2410c':'var(--timber)');
    h+='<td style="padding:6px 9px;white-space:nowrap;color:'+expColor+';font-weight:'+(dexp!==null&&dexp<=3?'700':'400')+'">'+_invDate(u.expiry_date)+'</td>';
    h+='<td style="padding:6px 9px;color:var(--timber);white-space:nowrap">'+_invEsc(loc)+'</td>';
    h+='<td style="padding:6px 9px;white-space:nowrap">'+_invStatusPillBig(ds)+'</td>';
    h+='</tr>';
  });
  h+='</tbody></table></div>';
  h+='<div style="font-size:.68rem;color:var(--timber);margin-top:6px">'+rows.length+' of '+_invUnits2.length+' stock units'+(rows.length!==_invUnits2.length?' (filtered)':'')+'</div>';
  wrap.innerHTML=h;
}

// ── DETAIL DRAWER ───────────────────────────────────────────────────────────
async function _invOpenDrawer(id){
  var u=_invUnits2.filter(function(x){return x.id===id;})[0]; if(!u) return;
  var host=document.getElementById('invDrawerHost'); if(!host) return;
  var it=u.inv_items||{}, un=(u.inv_units||{}).name||'', loc=(u.inv_locations||{}).name||'—';
  var rem=_invFmtQty(u.quantity_remaining), orig=_invFmtQty(u.quantity_original);
  var ds=_invUnitStatus(u);
  host.innerHTML=
    '<div onclick="_invCloseDrawer(event)" id="invDrawerOv" style="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9998">'
    +'<div onclick="event.stopPropagation()" style="position:absolute;top:0;right:0;height:100%;width:390px;max-width:92vw;background:#fff;box-shadow:-4px 0 24px rgba(0,0,0,.18);overflow:auto;padding:18px">'
    +'<div style="display:flex;justify-content:space-between;align-items:flex-start">'
      +'<div><div style="font-size:.64rem;color:var(--timber);text-transform:uppercase;letter-spacing:.5px;font-weight:700">Stock Unit</div>'
      +'<div style="font-size:1.05rem;font-weight:800;color:var(--forest-deep)">'+_invEsc(u.stock_unit_code||'—')+'</div>'
      +'<div style="font-size:.82rem;color:var(--forest)">'+_invTypeIco(it.item_type)+' '+_invEsc(it.name||'—')+'</div></div>'
      +'<button onclick="_invCloseDrawer()" style="background:var(--mist-light);border:none;border-radius:8px;width:30px;height:30px;cursor:pointer;font-size:1rem;color:var(--forest)">✕</button>'
    +'</div>'
    +'<div style="display:flex;align-items:baseline;gap:8px;margin:12px 0 4px"><span style="font-size:1.9rem;font-weight:800;color:var(--forest-deep)">'+rem+'</span><span style="font-size:.9rem;color:var(--timber)">'+_invEsc(un)+' remaining</span> '+_invStatusPillBig(ds)+'</div>'
    +'<div style="font-size:.72rem;color:var(--timber);margin-bottom:12px">Original quantity: '+orig+' '+_invEsc(un)+'</div>'
    +_invDrawerRow('Received', _invDate(u.date_received))
    +_invDrawerRow('Expected use', _invDate(u.expected_use_date))
    +_invDrawerRow('Expiry', _invDate(u.expiry_date))
    +_invDrawerRow('Location', _invEsc(loc))
    +_invDrawerRow('Batch', _invEsc(u.batch_id||'—'))
    +_invDrawerRow('Unit cost', u.unit_cost?('₱'+_invNum(u.unit_cost).toFixed(2)):'—')
    +'<div style="font-size:.66rem;color:var(--timber);text-transform:uppercase;letter-spacing:.4px;font-weight:700;margin:14px 0 6px">Usage history</div>'
    +'<div id="invHist" style="font-size:.74rem;color:var(--timber)">Loading…</div>'
    +'<div style="font-size:.66rem;color:var(--timber);text-transform:uppercase;letter-spacing:.4px;font-weight:700;margin:16px 0 6px">Actions</div>'
    +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">'
      +_invDrawerBtn('Record Usage','_invOpenUse('+u.id+')')
      +_invDrawerBtn('Record Waste','_invOpenWaste('+u.id+')')
      +_invDrawerBtn('Adjust','_invOpenAdjust('+u.id+')')
      +_invDrawerBtn('Transfer','_invOpenTransfer('+u.id+')')
    +'</div>'
    +(it.is_portionable||it.item_type==='PORTIONABLE'||it.item_type==='PRODUCED'? '<button onclick="_invOpenPortion('+u.id+')" style="width:100%;margin-top:6px;font-size:.76rem;font-weight:700;background:#f3e8ff;color:#7e22ce;border:none;border-radius:8px;padding:9px;cursor:pointer">🍰 Portion / Cut this unit</button>':'')
    +'</div></div>';
  _invLoadHistory(id, un);
}
function _invDrawerRow(k,v){ return '<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--mist-light);font-size:.76rem"><span style="color:var(--timber)">'+k+'</span><span style="color:var(--forest-deep);font-weight:600">'+v+'</span></div>'; }
function _invDrawerBtn(label,onclick){ return '<button onclick="'+onclick+'" style="font-size:.74rem;font-weight:700;background:var(--mist-light);color:var(--forest);border:none;border-radius:8px;padding:9px;cursor:pointer">'+label+'</button>'; }
function _invCloseDrawer(e){ var h=document.getElementById('invDrawerHost'); if(h) h.innerHTML=''; }

async function _invLoadHistory(id, unitName){
  var box=document.getElementById('invHist'); if(!box) return;
  var r=await api('invStockUnitHistory',{stockUnitId:id});
  var tx=(r&&r.ok)?(r.transactions||[]):[];
  if(!tx.length){ box.innerHTML='<div style="color:var(--timber)">No movements recorded yet.</div>'; return; }
  var h='<div style="border-left:2px solid var(--mist);padding-left:10px">';
  tx.forEach(function(t){
    var q=_invNum(t.quantity), sign=q>0?'+':'';
    var when=(t.performed_at||'').replace('T',' ').substring(0,16);
    h+='<div style="position:relative;padding:5px 0">'
      +'<span style="position:absolute;left:-16px;top:9px;width:7px;height:7px;border-radius:50%;background:var(--gold)"></span>'
      +'<b style="color:var(--forest-deep)">'+_invEsc(t.transaction_type)+'</b> '+sign+_invFmtQty(q)+' '+_invEsc(unitName||'')
      +' <span style="color:var(--timber)">→ '+_invFmtQty(t.quantity_after)+' left</span>'
      +'<div style="font-size:.66rem;color:var(--timber)">'+when+(t.override_reason?(' · '+_invEsc(t.override_reason)):'')+(t.notes?(' · '+_invEsc(t.notes)):'')+'</div>'
      +'</div>';
  });
  h+='</div>';
  box.innerHTML=h;
}
// ── SETTINGS TAB ────────────────────────────────────────────────────────────
function _card(title, inner, note){
  return '<div style="background:#fff;border:1px solid var(--mist);border-radius:12px;padding:14px 16px;margin-bottom:12px">'
    + '<div style="font-size:.85rem;font-weight:700;color:var(--forest-deep);margin-bottom:8px">'+title+'</div>'
    + inner
    + (note ? '<div style="font-size:.68rem;color:var(--timber);margin-top:8px">'+note+'</div>' : '')
    + '</div>';
}
function _statusPill(on, onLabel, offLabel){
  return '<span style="font-size:.72rem;font-weight:700;padding:3px 10px;border-radius:12px;'
    + (on ? 'background:#fde8e8;color:#b91c1c' : 'background:#e7f3ea;color:#15803d')+'">'+(on?onLabel:offLabel)+'</span>';
}

function _invSettingsHtml(){
  var owner = _invIsOwner();
  var neg = (_invCfg.allow_negative === 'true');
  var h = '';

  // Sale-activation flags (LOCKED this phase)
  var lockNote = 'Locked during setup. Sale activation is a separate, approved phase — it will never be flipped from here without your go-ahead.';
  h += _card('Module status & sale deduction',
    '<div style="display:flex;flex-direction:column;gap:10px">'
    + '<div style="display:flex;align-items:center;justify-content:space-between"><span style="font-size:.8rem">Inventory module</span>'
      + _statusPill(_invCfg.module_enabled==='true','LIVE','OFF')+'</div>'
    + '<div style="display:flex;align-items:center;justify-content:space-between"><span style="font-size:.8rem">Auto-deduct on sale</span>'
      + _statusPill(_invCfg.auto_deduct_on_sale==='true','ON','OFF')+'</div>'
    + '<div style="display:flex;align-items:center;justify-content:space-between"><span style="font-size:.8rem">Deduct trigger</span>'
      + '<span style="font-size:.74rem;color:var(--forest);font-weight:600">'+_invEsc(_invCfg.deduct_trigger||'COMPLETED')+'</span></div>'
    + '<div style="background:var(--mist-light);border-radius:8px;padding:8px 10px;font-size:.7rem;color:var(--forest)">🔒 '+lockNote+'</div>'
    + '</div>');

  // Negative inventory override (OWNER + confirm + reason + audit)
  var negInner =
    '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">'
    + '<div><span style="font-size:.8rem">Allow negative inventory</span> '+_statusPill(neg,'ALLOWED (risky)','BLOCKED (safe)')+'</div>';
  if (owner) {
    if (!neg) negInner += '<button onclick="_invOpenNegModal()" style="font-size:.74rem;font-weight:700;background:#fff;color:#b91c1c;border:1.5px solid #b91c1c;border-radius:8px;padding:6px 12px;cursor:pointer">Allow (with reason)</button>';
    else negInner += '<button onclick="_invDisableNeg()" style="font-size:.74rem;font-weight:700;background:var(--forest);color:#fff;border:none;border-radius:8px;padding:6px 12px;cursor:pointer">Turn back to safe</button>';
  } else {
    negInner += '<span style="font-size:.7rem;color:var(--timber)">OWNER only</span>';
  }
  negInner += '</div>';
  h += _card('Negative inventory override', negInner,
    'When BLOCKED (recommended), the system refuses any sale/production that would drive stock below zero. Enabling requires OWNER, a typed reason, and is written to the audit log.');

  // Costing method + default location (OWNER editable)
  var cm = _invCfg.costing_method || 'FEFO';
  var cmInner = '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px">'
    + '<span style="font-size:.8rem">Costing method</span>';
  if (owner) {
    cmInner += '<select onchange="_invSetVal(\'costing_method\', this.value)" style="font-size:.78rem;padding:5px 8px;border:1.5px solid var(--mist);border-radius:8px">'
      + '<option'+(cm==='FEFO'?' selected':'')+'>FEFO</option><option'+(cm==='FIFO'?' selected':'')+'>FIFO</option></select>';
  } else cmInner += '<span style="font-size:.74rem;color:var(--forest);font-weight:600">'+_invEsc(cm)+'</span>';
  cmInner += '</div>';
  var dl = _invCfg.default_location || 'Main Storage';
  var locOpts = _invRef.locations.map(function(l){return '<option'+(l.name===dl?' selected':'')+'>'+_invEsc(l.name)+'</option>';}).join('');
  cmInner += '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:10px">'
    + '<span style="font-size:.8rem">Default location</span>';
  if (owner && locOpts) cmInner += '<select onchange="_invSetVal(\'default_location\', this.value)" style="font-size:.78rem;padding:5px 8px;border:1.5px solid var(--mist);border-radius:8px">'+locOpts+'</select>';
  else cmInner += '<span style="font-size:.74rem;color:var(--forest);font-weight:600">'+_invEsc(dl)+'</span>';
  cmInner += '</div>';
  h += _card('Costing & location', cmInner, owner ? '' : 'OWNER can change these.');

  // Reference data (read-only this phase)
  var uHtml = _invRef.units.length
    ? _invRef.units.map(function(u){return '<span style="display:inline-block;font-size:.7rem;background:var(--mist-light);color:var(--forest);border-radius:8px;padding:3px 8px;margin:2px">'+_invEsc(u.name)+(u.unit_type?' · '+_invEsc(u.unit_type):'')+'</span>';}).join('')
    : '<span style="font-size:.72rem;color:var(--timber)">No units yet.</span>';
  h += _card('Units ('+_invRef.units.length+')', uHtml, 'Add/edit units is a later screen — read-only for now.');

  var lHtml = _invRef.locations.length ? _invRef.locations.map(function(l){return '<span style="display:inline-block;font-size:.7rem;background:var(--mist-light);color:var(--forest);border-radius:8px;padding:3px 8px;margin:2px">📍 '+_invEsc(l.name)+'</span>';}).join('') : '<span style="font-size:.72rem;color:var(--timber)">No locations yet.</span>';
  h += _card('Locations ('+_invRef.locations.length+')', lHtml, 'Read-only for now.');

  var sHtml = _invRef.suppliers.length ? _invRef.suppliers.map(function(s){return '<span style="display:inline-block;font-size:.7rem;background:var(--mist-light);color:var(--forest);border-radius:8px;padding:3px 8px;margin:2px">🏭 '+_invEsc(s.name)+'</span>';}).join('') : '<span style="font-size:.72rem;color:var(--timber)">No suppliers yet.</span>';
  h += _card('Suppliers ('+_invRef.suppliers.length+')', sHtml, 'Read-only for now.');

  // Permissions (enforced in code — shown for transparency)
  h += _card('Inventory permissions',
    '<div style="font-size:.75rem;color:var(--forest);line-height:1.7">'
    + '<b>OWNER</b> — configuration, archive, negative-stock override, major adjustments<br>'
    + '<b>ADMIN</b> — receive, produce, portion, waste, adjust, manage recipes/items<br>'
    + '<b>CASHIER / KITCHEN</b> — no inventory administration'
    + '</div>',
    'Enforced server-side on every inventory action (ADMIN/OWNER gate; OWNER-only for the items above). This panel is a read-only view of the live rule.');

  // Audit log
  h += _card('Setting change audit', '<div id="invAuditBox" style="font-size:.72rem;color:var(--timber)">Loading…</div>', 'Every settings change (who / when / old → new / reason) is recorded, append-only.');

  // load audit async
  setTimeout(_invLoadAudit, 30);
  return h;
}

async function _invLoadAudit(){
  var box = document.getElementById('invAuditBox'); if(!box) return;
  var r = await api('invSettingAudit', {});
  var rows = (r && r.ok) ? (r.rows||[]) : [];
  if (!rows.length){ box.innerHTML = 'No changes recorded yet.'; return; }
  box.innerHTML = rows.slice(0,10).map(function(a){
    var when = (a.changed_at||'').replace('T',' ').substring(0,16);
    return '<div style="padding:6px 0;border-bottom:1px solid var(--mist-light)">'
      + '<b style="color:var(--forest)">'+_invEsc(a.key)+'</b>: '+_invEsc(a.old_value)+' → <b>'+_invEsc(a.new_value)+'</b>'
      + ' <span style="color:var(--timber)">· '+_invEsc(a.changed_by)+' · '+when+'</span>'
      + (a.reason ? '<br><span style="color:var(--timber)">reason: '+_invEsc(a.reason)+'</span>' : '')
      + '</div>';
  }).join('');
}

// ── negative override modal (OWNER + confirm + typed reason) ────────────────
function _invOpenNegModal(){
  if (!_invIsOwner()) { showToast('OWNER only','error'); return; }
  var m = document.createElement('div');
  m.id = 'invNegModal';
  m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
  m.innerHTML =
    '<div style="background:#fff;border-radius:14px;max-width:440px;width:100%;padding:20px">'
    + '<div style="font-size:1rem;font-weight:800;color:#b91c1c;margin-bottom:6px">⚠️ Allow negative inventory?</div>'
    + '<div style="font-size:.78rem;color:var(--forest);line-height:1.5;margin-bottom:12px">This lets stock go below zero — sales/production will no longer be blocked when stock runs out. Use only for a deliberate, temporary reason. This action is logged with your name.</div>'
    + '<label style="font-size:.72rem;font-weight:700;color:var(--forest-deep)">Reason (required)</label>'
    + '<textarea id="invNegReason" rows="3" placeholder="e.g. Physical count pending; allowing oversell for tonight only" style="width:100%;margin-top:4px;font-size:.8rem;padding:8px;border:1.5px solid var(--mist);border-radius:8px;resize:vertical"></textarea>'
    + '<div style="display:flex;gap:8px;margin-top:14px">'
    + '<button onclick="_invCloseNegModal()" style="flex:1;font-size:.8rem;font-weight:700;background:var(--mist-light);color:var(--forest);border:none;border-radius:8px;padding:9px;cursor:pointer">Cancel</button>'
    + '<button onclick="_invConfirmNeg()" style="flex:1;font-size:.8rem;font-weight:700;background:#b91c1c;color:#fff;border:none;border-radius:8px;padding:9px;cursor:pointer">Allow negative</button>'
    + '</div></div>';
  document.body.appendChild(m);
}
function _invCloseNegModal(){ var m=document.getElementById('invNegModal'); if(m) m.remove(); }
async function _invConfirmNeg(){
  var reason = (document.getElementById('invNegReason')||{}).value || '';
  reason = reason.trim();
  if (reason.length < 5) { showToast('Please type a clear reason','error'); return; }
  var r = await api('invSetConfig', { key:'allow_negative', value:'true', reason:reason });
  _invCloseNegModal();
  if (r && r.ok) { showToast('Negative inventory ALLOWED — logged','success'); _invCfg.allow_negative='true'; _invRenderTab(); }
  else showToast((r&&r.error)||'Failed','error');
}
async function _invDisableNeg(){
  var r = await api('invSetConfig', { key:'allow_negative', value:'false', reason:'Reverted to safe default' });
  if (r && r.ok) { showToast('Negative inventory BLOCKED (safe)','success'); _invCfg.allow_negative='false'; _invRenderTab(); }
  else showToast((r&&r.error)||'Failed','error');
}
async function _invSetVal(key, value){
  var r = await api('invSetConfig', { key:key, value:value });
  if (r && r.ok) { _invCfg[key]=value; showToast('Saved','success'); }
  else showToast((r&&r.error)||'Failed','error');
}

// ── ITEMS TAB ───────────────────────────────────────────────────────────────
function _invItemsHtml(){
  var h = '';
  // filter chips
  h += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;align-items:center">';
  [['ALL','All']].concat(Object.keys(INV_TYPE_META).map(function(k){return [k, INV_TYPE_META[k].ico+' '+INV_TYPE_META[k].label];})).forEach(function(f){
    var on = _invItemFilter===f[0];
    h += '<button onclick="_invSetItemFilter(\''+f[0]+'\')" style="font-size:.72rem;font-weight:600;border-radius:20px;padding:5px 12px;cursor:pointer;border:1.5px solid '
      + (on?'var(--forest);background:var(--forest);color:#fff':'var(--mist);background:#fff;color:var(--forest)')+'">'+f[1]+'</button>';
  });
  h += '<div style="flex:1"></div>';
  h += '<button onclick="_invOpenItemForm()" style="font-size:.78rem;font-weight:700;background:var(--forest);color:#fff;border:none;border-radius:8px;padding:7px 14px;cursor:pointer">+ Add Item</button>';
  h += '</div>';

  // list
  if (!_invItems.length) {
    h += '<div style="background:#fff;border:1px dashed var(--mist);border-radius:12px;padding:40px;text-align:center;color:var(--timber);font-size:.82rem">No items'+(_invItemFilter!=='ALL'?' of this type':'')+' yet. Tap <b>+ Add Item</b> to create one.</div>';
  } else {
    h += '<div style="display:flex;flex-direction:column;gap:8px">';
    _invItems.forEach(function(it){
      var meta = INV_TYPE_META[it.item_type] || {ico:'📦',label:it.item_type};
      var unit = (it.inv_units && it.inv_units.name) ? it.inv_units.name : '';
      h += '<div style="background:#fff;border:1px solid var(--mist);border-radius:10px;padding:10px 12px;display:flex;align-items:center;gap:10px">'
        + '<div style="font-size:1.2rem">'+meta.ico+'</div>'
        + '<div style="flex:1;min-width:0">'
          + '<div style="font-size:.85rem;font-weight:700;color:var(--forest-deep)">'+_invEsc(it.name)+'</div>'
          + '<div style="font-size:.68rem;color:var(--timber);margin-top:1px">'+_invEsc(meta.label)
            + (unit?' · base unit '+_invEsc(unit):'')
            + (it.is_portionable?' · <span style="color:var(--gold);font-weight:700">portionable ×'+_invEsc(it.standard_yield||'?')+'</span>':'')
            + ' · <span style="color:#9aa89d">'+_invEsc(it.item_code)+'</span></div>'
        + '</div>';
      if (_invIsAdmin()) h += '<button onclick="_invOpenItemForm('+it.id+')" style="font-size:.7rem;font-weight:700;background:var(--mist-light);color:var(--forest);border:none;border-radius:7px;padding:6px 10px;cursor:pointer">Edit</button>';
      if (_invIsOwner()) h += '<button onclick="_invArchive('+it.id+',\''+_invEsc(it.name).replace(/'/g,"")+'\')" style="font-size:.7rem;font-weight:700;background:#fff;color:#b91c1c;border:1px solid #f0caca;border-radius:7px;padding:6px 10px;cursor:pointer;margin-left:6px">Archive</button>';
      h += '</div>';
    });
    h += '</div>';
  }
  return h;
}
async function _invSetItemFilter(f){ _invItemFilter=f; await _invLoadItems(); _invRenderTab(); }

// ── item form (TYPE FIRST, dynamic fields) ──────────────────────────────────
function _invOpenItemForm(id){
  if (!_invIsAdmin()) { showToast('ADMIN/OWNER only','error'); return; }
  var it = id ? _invItems.filter(function(x){return x.id===id;})[0] : null;
  var m = document.createElement('div');
  m.id='invItemModal';
  m.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:20px;overflow:auto';
  var typeOpts = Object.keys(INV_TYPE_META).map(function(k){
    var sel = it && it.item_type===k ? ' selected':'';
    return '<option value="'+k+'"'+sel+'>'+INV_TYPE_META[k].ico+'  '+INV_TYPE_META[k].label+'</option>';
  }).join('');
  var unitOpts = _invRef.units.map(function(u){
    var sel = it && it.base_unit_id===u.id ? ' selected':'';
    return '<option value="'+u.id+'"'+sel+'>'+_invEsc(u.name)+(u.unit_type?' ('+_invEsc(u.unit_type)+')':'')+'</option>';
  }).join('');
  m.innerHTML =
    '<div style="background:#fff;border-radius:14px;max-width:480px;width:100%;padding:20px;margin-top:20px">'
    + '<div style="font-size:1rem;font-weight:800;color:var(--forest-deep);margin-bottom:4px">'+(it?'Edit item':'New item')+'</div>'
    + '<div style="font-size:.72rem;color:var(--timber);margin-bottom:14px">Writes only to <b>inv_items</b>. Validated server-side.</div>'
    + (it?'':'<label style="font-size:.72rem;font-weight:700;color:var(--forest-deep)">What type of item is this?</label>')
    + (it?'<input type="hidden" id="invfType" value="'+_invEsc(it.item_type)+'">'
         :'<select id="invfType" onchange="_invItemTypeChanged()" style="width:100%;margin:4px 0 4px;font-size:.85rem;padding:9px;border:1.5px solid var(--mist);border-radius:8px">'+typeOpts+'</select>')
    + '<div id="invfTypeBlurb" style="font-size:.68rem;color:var(--timber);margin-bottom:10px"></div>'
    + '<label style="font-size:.72rem;font-weight:700;color:var(--forest-deep)">Item name</label>'
    + '<input id="invfName" value="'+(it?_invEsc(it.name):'')+'" placeholder="e.g. Chocolate Cake 4\\"" style="width:100%;margin:4px 0 10px;font-size:.85rem;padding:9px;border:1.5px solid var(--mist);border-radius:8px">'
    + '<label style="font-size:.72rem;font-weight:700;color:var(--forest-deep)" id="invfUnitLabel">Base unit</label>'
    + '<select id="invfUnit" style="width:100%;margin:4px 0 10px;font-size:.85rem;padding:9px;border:1.5px solid var(--mist);border-radius:8px">'+unitOpts+'</select>'
    + '<div id="invfPortionWrap" style="display:none;background:var(--mist-light);border-radius:8px;padding:10px;margin-bottom:10px">'
      + '<label style="display:flex;align-items:center;gap:8px;font-size:.8rem;font-weight:600;color:var(--forest)"><input type="checkbox" id="invfPortion" onchange="_invPortionToggled()"'+(it&&it.is_portionable?' checked':'')+'> Can be portioned (sold whole OR cut)</label>'
      + '<div id="invfYieldWrap" style="display:'+(it&&it.is_portionable?'block':'none')+';margin-top:8px">'
        + '<label style="font-size:.72rem;font-weight:700;color:var(--forest-deep)" id="invfYieldLabel">Standard portion yield (e.g. 4 slices)</label>'
        + '<input id="invfYield" type="number" step="0.01" value="'+(it&&it.standard_yield?_invEsc(it.standard_yield):'')+'" style="width:100%;margin-top:4px;font-size:.85rem;padding:9px;border:1.5px solid var(--mist);border-radius:8px">'
      + '</div>'
    + '</div>'
    + '<label style="font-size:.72rem;font-weight:700;color:var(--forest-deep)">Notes (optional)</label>'
    + '<input id="invfDesc" value="'+(it?_invEsc(it.description||''):'')+'" style="width:100%;margin:4px 0 14px;font-size:.85rem;padding:9px;border:1.5px solid var(--mist);border-radius:8px">'
    + '<div style="display:flex;gap:8px">'
    + '<button onclick="_invCloseItemForm()" style="flex:1;font-size:.82rem;font-weight:700;background:var(--mist-light);color:var(--forest);border:none;border-radius:8px;padding:10px;cursor:pointer">Cancel</button>'
    + '<button onclick="_invSaveItem('+(it?it.id:'0')+')" style="flex:2;font-size:.82rem;font-weight:700;background:var(--forest);color:#fff;border:none;border-radius:8px;padding:10px;cursor:pointer">'+(it?'Save changes':'Create item')+'</button>'
    + '</div></div>';
  document.body.appendChild(m);
  _invItemTypeChanged();
}
function _invCloseItemForm(){ var m=document.getElementById('invItemModal'); if(m) m.remove(); }

function _invItemTypeChanged(){
  var t = (document.getElementById('invfType')||{}).value;
  var meta = INV_TYPE_META[t]||{};
  var blurb = document.getElementById('invfTypeBlurb'); if(blurb) blurb.textContent = meta.blurb||'';
  var portionWrap = document.getElementById('invfPortionWrap');
  var unitLabel = document.getElementById('invfUnitLabel');
  var yieldLabel = document.getElementById('invfYieldLabel');
  // portioning is relevant to sellable wholes: PRODUCED, PURCHASED_READY, PORTIONABLE
  var canPortion = (t==='PRODUCED' || t==='PURCHASED_READY' || t==='PORTIONABLE');
  if (portionWrap) portionWrap.style.display = canPortion ? 'block' : 'none';
  if (t==='PORTIONABLE'){ var cb=document.getElementById('invfPortion'); if(cb && !cb.checked){ cb.checked=true; _invPortionToggled(); } }
  // unit label hint per type
  if (unitLabel){
    if (t==='PREP') unitLabel.textContent='Output unit (e.g. g, ml)';
    else if (t==='RAW_MATERIAL') unitLabel.textContent='Unit (e.g. L, kg, g — partial use allowed)';
    else if (t==='PURCHASED_READY') unitLabel.textContent='Unit (e.g. pc, bottle)';
    else unitLabel.textContent='Base unit (e.g. Whole, pc)';
  }
  if (yieldLabel) yieldLabel.textContent = (t==='PREP') ? 'Standard batch yield (e.g. 1000 g)' : 'Standard portion yield (e.g. 4 slices)';
  // PREP shows batch yield without the portion checkbox
  if (t==='PREP' && portionWrap){
    portionWrap.style.display='block';
    var cb=document.getElementById('invfPortion'); if(cb){ cb.parentElement.style.display='none'; cb.checked=false; }
    var yw=document.getElementById('invfYieldWrap'); if(yw) yw.style.display='block';
  } else {
    var cb2=document.getElementById('invfPortion'); if(cb2) cb2.parentElement.style.display='flex';
  }
}
function _invPortionToggled(){
  var cb=document.getElementById('invfPortion');
  var yw=document.getElementById('invfYieldWrap');
  if (yw) yw.style.display = (cb && cb.checked) ? 'block':'none';
}

async function _invSaveItem(id){
  var name = (document.getElementById('invfName')||{}).value || '';
  var itemType = (document.getElementById('invfType')||{}).value;
  var baseUnitId = (document.getElementById('invfUnit')||{}).value;
  var descEl = document.getElementById('invfDesc');
  var portionCb = document.getElementById('invfPortion');
  var yieldEl = document.getElementById('invfYield');
  name = name.trim();
  if (!name) { showToast('Enter item name','error'); return; }
  if (!baseUnitId) { showToast('Pick a base unit','error'); return; }
  var isPortionable = false, standardYield = null;
  if (itemType==='PREP') { standardYield = yieldEl ? parseFloat(yieldEl.value)||null : null; }
  else if (portionCb && portionCb.checked) { isPortionable = true; standardYield = yieldEl ? parseFloat(yieldEl.value)||null : null; }
  var payload = { name:name, itemType:itemType, baseUnitId:parseInt(baseUnitId,10),
    isPortionable:isPortionable, standardYield:standardYield, description:(descEl?descEl.value.trim():'') };
  if (id) payload.id = id;
  var r = await api('invSaveItem', payload);
  if (r && r.ok) {
    showToast(id?'Item updated':'Item created','success');
    _invCloseItemForm();
    await _invLoadItems(); _invRenderTab();
  } else showToast((r&&r.error)||'Failed to save','error');
}

async function _invArchive(id, name){
  if (!_invIsOwner()) { showToast('OWNER only','error'); return; }
  if (!confirm('Archive "'+name+'"? It will be hidden but not deleted (ledger preserved).')) return;
  var r = await api('invArchiveItem', { id:id });
  if (r && r.ok) { showToast('Archived','success'); await _invLoadItems(); _invRenderTab(); }
  else showToast((r&&r.error)||'Failed','error');
}

// ── ACTION FORMS (UI only → existing validated endpoints) ───────────────────
function _invModal(title, bodyHtml, submitLabel, submitFn){
  var m=document.createElement('div'); m.id='invActionModal';
  m.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10000;display:flex;align-items:flex-start;justify-content:center;padding:16px;overflow:auto';
  m.innerHTML='<div style="background:#fff;border-radius:14px;max-width:440px;width:100%;padding:18px;margin-top:24px">'
    +'<div style="font-size:1rem;font-weight:800;color:var(--forest-deep)">'+title+'</div>'
    +'<div style="font-size:.66rem;color:var(--timber);margin-bottom:10px">Validated write to inv_* tables. Existing POS untouched.</div>'
    +bodyHtml
    +'<div style="display:flex;gap:8px;margin-top:14px"><button onclick="_invCloseModal()" style="flex:1;font-size:.8rem;font-weight:700;background:var(--mist-light);color:var(--forest);border:none;border-radius:8px;padding:10px;cursor:pointer">Cancel</button>'
    +'<button id="invModalSubmit" style="flex:2;font-size:.8rem;font-weight:700;background:var(--forest);color:#fff;border:none;border-radius:8px;padding:10px;cursor:pointer">'+submitLabel+'</button></div></div>';
  document.body.appendChild(m);
  document.getElementById('invModalSubmit').onclick=submitFn;
}
function _invCloseModal(){ var m=document.getElementById('invActionModal'); if(m) m.remove(); }
function _invField(label, inner){ return '<label style="font-size:.72rem;font-weight:700;color:var(--forest-deep);display:block;margin-top:8px">'+label+'</label>'+inner; }
function _invInput(id, type, ph, val){ return '<input id="'+id+'" type="'+(type||'text')+'"'+(ph?' placeholder="'+ph+'"':'')+(val!=null?' value="'+_invEsc(val)+'"':'')+' style="width:100%;margin-top:3px;font-size:.82rem;padding:8px;border:1.5px solid var(--mist);border-radius:8px">'; }
function _invSelect(id, opts, onchange){ return '<select id="'+id+'"'+(onchange?' onchange="'+onchange+'"':'')+' style="width:100%;margin-top:3px;font-size:.82rem;padding:8px;border:1.5px solid var(--mist);border-radius:8px">'+opts+'</select>'; }
function _invUnitOf(id){ return _invUnits2.filter(function(u){return u.id===id;})[0]; }
function _invUnitPicker(id, sel){
  var opts=_invUnits2.filter(function(u){return _invNum(u.quantity_remaining)>0;}).map(function(u){return '<option value="'+u.id+'"'+(sel==u.id?' selected':'')+'>'+_invEsc(u.stock_unit_code)+' — '+_invEsc((u.inv_items||{}).name||'')+' ('+_invFmtQty(u.quantity_remaining)+')</option>';}).join('');
  return _invSelect(id, opts);
}

function _invOpenReceive(){
  if(!_invIsAdmin()){showToast('ADMIN/OWNER only','error');return;}
  if(!_invItems.length){showToast('Create an item first (Items tab)','error');return;}
  var itemOpts=_invItems.map(function(it){return '<option value="'+it.id+'" data-unit="'+it.base_unit_id+'">'+_invEsc(it.name)+'</option>';}).join('');
  var unitOpts=_invRef.units.map(function(u){return '<option value="'+u.id+'">'+_invEsc(u.name)+'</option>';}).join('');
  var locOpts='<option value="">—</option>'+_invRef.locations.map(function(l){return '<option value="'+l.id+'">'+_invEsc(l.name)+'</option>';}).join('');
  var body=_invField('Item',_invSelect('rcItem',itemOpts,'_invRcUnit()'))
    +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'
      +'<div>'+_invField('Quantity',_invInput('rcQty','number','e.g. 1000'))+'</div>'
      +'<div>'+_invField('Unit',_invSelect('rcUnit',unitOpts))+'</div></div>'
    +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'
      +'<div>'+_invField('Unit cost ₱',_invInput('rcCost','number','0'))+'</div>'
      +'<div>'+_invField('Location',_invSelect('rcLoc',locOpts))+'</div></div>'
    +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'
      +'<div>'+_invField('Expiry date',_invInput('rcExp','date'))+'</div>'
      +'<div>'+_invField('Expected use',_invInput('rcUse','date'))+'</div></div>'
    +_invField('Notes',_invInput('rcNotes','text','delivery ref, supplier…'));
  _invModal('Receive Stock', body, 'Receive', _invSubmitReceive);
  setTimeout(_invRcUnit,20);
}
function _invRcUnit(){ var s=document.getElementById('rcItem'); if(!s)return; var u=s.options[s.selectedIndex].getAttribute('data-unit'); var us=document.getElementById('rcUnit'); if(us&&u) us.value=u; }
async function _invSubmitReceive(){
  var itemId=+(document.getElementById('rcItem')||{}).value, qty=parseFloat((document.getElementById('rcQty')||{}).value), unitId=+(document.getElementById('rcUnit')||{}).value;
  if(!itemId){showToast('Pick an item','error');return;}
  if(!(qty>0)){showToast('Enter quantity','error');return;}
  var r=await api('invReceiveStock',{itemId:itemId,qty:qty,unitId:unitId,unitCost:parseFloat((document.getElementById('rcCost')||{}).value)||0,locationId:+(document.getElementById('rcLoc')||{}).value||null,expiryDate:(document.getElementById('rcExp')||{}).value||null,expectedUseDate:(document.getElementById('rcUse')||{}).value||null,notes:(document.getElementById('rcNotes')||{}).value||''});
  if(r&&r.ok){showToast('Stock received '+(r.stock_unit_code||''),'success');_invCloseModal();await _invLoadStock();_invRenderTab();}
  else showToast((r&&r.error)||'Failed','error');
}

async function _invOpenProduce(){
  if(!_invIsAdmin()){showToast('ADMIN/OWNER only','error');return;}
  var rr=await api('invListRecipes',{}); var recipes=(rr&&rr.ok)?(rr.recipes||rr.data||[]):[];
  if(!recipes.length){showToast('No recipes yet — Recipes screen comes in a later phase','error');return;}
  var body=_invField('Recipe',_invSelect('pdRecipe',recipes.map(function(x){return '<option value="'+x.id+'">'+_invEsc(x.name||('Recipe '+x.id))+'</option>';}).join('')))
    +_invField('Batches to produce',_invInput('pdQty','number','1'))
    +_invField('Expiry date',_invInput('pdExp','date'))
    +_invField('Notes',_invInput('pdNotes','text',''));
  _invModal('Produce (run a recipe)', body, 'Produce', async function(){
    var r=await api('invProduce',{recipeId:+(document.getElementById('pdRecipe')||{}).value,qty:parseFloat((document.getElementById('pdQty')||{}).value)||1,expiryDate:(document.getElementById('pdExp')||{}).value||null,notes:(document.getElementById('pdNotes')||{}).value||''});
    if(r&&r.ok){showToast('Produced '+(r.stock_unit_code||''),'success');_invCloseModal();await _invLoadStock();_invRenderTab();}
    else if(r&&r.error==='insufficient_ingredients'){showToast('Not enough ingredients','error');}
    else showToast((r&&r.error)||'Failed','error');
  });
}

function _invOpenPortion(stockUnitId){
  if(!_invIsAdmin()){showToast('ADMIN/OWNER only','error');return;}
  var units=_invUnits2.filter(function(u){var it=u.inv_items||{};return _invNum(u.quantity_remaining)>0 && (it.is_portionable||it.item_type==='PORTIONABLE'||it.item_type==='PRODUCED') && String(u.status).toUpperCase()!=='PORTIONED';});
  if(!units.length){showToast('No portionable stock units available','error');return;}
  var opts=units.map(function(u){return '<option value="'+u.id+'"'+(stockUnitId==u.id?' selected':'')+'>'+_invEsc(u.stock_unit_code)+' — '+_invEsc((u.inv_items||{}).name||'')+'</option>';}).join('');
  var body=_invField('Whole unit to portion',_invSelect('ptUnit',opts))
    +_invField('Number of portions',_invInput('ptN','number','4'))
    +'<div style="font-size:.68rem;color:var(--timber);margin-top:6px">The whole unit becomes PORTIONED (no longer sold as whole). Portions become a child stock unit — no double-counting.</div>';
  _invModal('Portion / Cut', body, 'Portion', async function(){
    var id=+(document.getElementById('ptUnit')||{}).value, n=parseFloat((document.getElementById('ptN')||{}).value);
    if(!(n>0)){showToast('Enter portions','error');return;}
    var r=await api('invPortion',{stockUnitId:id,portions:n});
    if(r&&r.ok){showToast('Portioned','success');_invCloseModal();_invCloseDrawer();await _invLoadStock();_invRenderTab();}
    else showToast((r&&r.error)||'Failed','error');
  });
}

function _invOpenUse(stockUnitId){
  if(!_invIsAdmin()){showToast('ADMIN/OWNER only','error');return;}
  if(!_invUnits2.filter(function(u){return _invNum(u.quantity_remaining)>0;}).length){showToast('No stock to use','error');return;}
  var body=(stockUnitId?'':_invField('Stock unit',_invUnitPicker('useUnit',stockUnitId)))
    +_invField('Quantity used',_invInput('useQty','number',''))
    +_invField('Reason / note (required)',_invInput('useReason','text','e.g. used in latte'));
  _invModal('Record Usage', body, 'Record', async function(){
    var id=stockUnitId||+(document.getElementById('useUnit')||{}).value, u=_invUnitOf(id);
    if(!u){showToast('Pick a unit','error');return;}
    var qty=parseFloat((document.getElementById('useQty')||{}).value), reason=(document.getElementById('useReason')||{}).value||'';
    if(!(qty>0)){showToast('Enter quantity','error');return;}
    if(!reason){showToast('Reason required','error');return;}
    var r=await api('invConsumeOverride',{stockUnitId:id,qty:qty,unitId:u.unit_id,overrideReason:reason});
    if(r&&r.ok){showToast('Usage recorded','success');_invCloseModal();_invCloseDrawer();await _invLoadStock();_invRenderTab();}
    else showToast((r&&r.error)||'Failed','error');
  });
}

function _invOpenWaste(stockUnitId){
  if(!_invIsAdmin()){showToast('ADMIN/OWNER only','error');return;}
  var body=(stockUnitId?'':_invField('Stock unit',_invUnitPicker('wsUnit',stockUnitId)))
    +_invField('Quantity wasted',_invInput('wsQty','number',''))
    +_invField('Reason (required)',_invInput('wsReason','text','e.g. spoiled overnight'));
  _invModal('Record Waste', body, 'Record waste', async function(){
    var id=stockUnitId||+(document.getElementById('wsUnit')||{}).value, qty=parseFloat((document.getElementById('wsQty')||{}).value), reason=(document.getElementById('wsReason')||{}).value||'';
    if(!id){showToast('Pick a unit','error');return;}
    if(!(qty>0)){showToast('Enter quantity','error');return;}
    if(!reason){showToast('Reason required','error');return;}
    var r=await api('invAdjustStock',{stockUnitId:id,adjustType:'waste',qtyChange:-Math.abs(qty),reason:reason});
    if(r&&r.ok){showToast('Waste recorded','success');_invCloseModal();_invCloseDrawer();await _invLoadStock();_invRenderTab();}
    else showToast((r&&r.error)||'Failed','error');
  });
}

function _invOpenAdjust(stockUnitId){
  if(!_invIsAdmin()){showToast('ADMIN/OWNER only','error');return;}
  var body=_invField('Adjustment type',_invSelect('ajType','<option value="count">Stock count (set exact amount)</option><option value="adjust">Adjust (+/- change)</option>'))
    +_invField('Value',_invInput('ajQty','number',''))
    +_invField('Reason (required)',_invInput('ajReason','text','e.g. physical count correction'));
  _invModal('Adjust stock', body, 'Apply', async function(){
    var type=(document.getElementById('ajType')||{}).value, val=parseFloat((document.getElementById('ajQty')||{}).value), reason=(document.getElementById('ajReason')||{}).value||'';
    if(isNaN(val)){showToast('Enter a value','error');return;}
    if(!reason){showToast('Reason required','error');return;}
    var r=await api('invAdjustStock',{stockUnitId:stockUnitId,adjustType:type,qtyChange:val,reason:reason});
    if(r&&r.ok){showToast('Adjusted','success');_invCloseModal();_invCloseDrawer();await _invLoadStock();_invRenderTab();}
    else showToast((r&&r.error)||'Failed','error');
  });
}

function _invOpenTransfer(stockUnitId){
  if(!_invIsAdmin()){showToast('ADMIN/OWNER only','error');return;}
  var locOpts=_invRef.locations.map(function(l){return '<option value="'+_invEsc(l.name)+'">'+_invEsc(l.name)+'</option>';}).join('');
  var body=_invField('Move to location',_invSelect('trLoc',locOpts))
    +_invField('Note',_invInput('trReason','text','e.g. moved to bar'));
  _invModal('Transfer stock', body, 'Transfer', async function(){
    var loc=(document.getElementById('trLoc')||{}).value||'', note=(document.getElementById('trReason')||{}).value||'';
    var reason='Transfer to '+loc+(note?(' — '+note):'');
    var r=await api('invAdjustStock',{stockUnitId:stockUnitId,adjustType:'transfer',qtyChange:0,reason:reason});
    if(r&&r.ok){showToast('Transfer recorded','success');_invCloseModal();_invCloseDrawer();await _invLoadStock();_invRenderTab();}
    else showToast((r&&r.error)||'Failed','error');
  });
}
