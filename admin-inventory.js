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
var _invTab   = 'menu';    // menu stock first
var _invItemFilter = 'ALL';
// stock filters
var _invSearch = '';
var _invSType  = 'ALL';
var _invSLoc   = 'ALL';
var _invSStatus= 'ACTIVE';
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
  if(_invTab==='count') _invCntLoad(); else if(typeof _ieLoadTab==='function') _ieLoadTab(_invTab);
}

async function _invLoadAll() {
  try {
    var cfg = await api('invGetConfig', {}); _invCfg = (cfg && cfg.ok) ? (cfg.config||{}) : {};
    var ref = await api('invGetRefData', {}); if (ref && ref.ok) _invRef = { units:ref.units||[], locations:ref.locations||[], suppliers:ref.suppliers||[], itemTypes:ref.itemTypes||[] };
    await _invLoadItems();
    await _invLoadStock();
    await _invLoadRecipes();
  } catch(e) {}
}
var _invRecipes=[];
async function _invLoadRecipes(){ var r=await api('invListRecipes',{}); _invRecipes=(r&&r.ok)?(r.recipes||[]):[]; }
// latest received unit-cost per ingredient item (client-side cost basis)
function _invIngredientCost(itemId){
  var best=null;
  _invUnits2.forEach(function(u){ if(u.item_id===itemId && u.unit_cost!=null){ if(best===null || new Date(u.date_received)>best.d){ best={c:_invNum(u.unit_cost),d:new Date(u.date_received)}; } } });
  return best?best.c:null;
}
async function _invLoadItems(){ var b={activeOnly:true}; if(_invItemFilter!=='ALL')b.itemType=_invItemFilter; var r=await api('invListItems',b); _invItems=(r&&r.ok)?(r.items||r.data||[]):[]; }
async function _invLoadStock(){
  var r = await api('invListStockUnits', { limit:500 });
  _invUnits2 = (r&&r.ok)?(r.stockUnits||[]):[];
}

// ── SHELL ──────────────────────────────────────────────────────────────────
function _invRender() {
  var v = document.getElementById('inventoryView'); if (!v) return;
  if (!document.getElementById('invStyles')) {
    var st=document.createElement('style'); st.id='invStyles';
    st.textContent='.inv-sumgrid{display:grid;grid-template-columns:repeat(6,1fr)}.inv-mob{display:none}'
      +'.invsec{font-size:.6rem;color:var(--timber);text-transform:uppercase;letter-spacing:.5px;font-weight:800;margin:12px 0 2px}'
      +'#invItemModal input,#invItemModal select,#invActionModal input,#invActionModal select{box-sizing:border-box;max-width:100%}'
      +'@media(max-width:640px){.inv-sumgrid{grid-template-columns:repeat(3,1fr)}.inv-desk{display:none !important}.inv-mob{display:block !important}}';
    document.head.appendChild(st);
  }
  var enabled = (_invCfg.module_enabled === 'true');
  var h = '<div style="max-width:1440px;margin:0 auto;padding:14px 14px 60px">';
  h += '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">';
  h += '<div><h2 style="margin:0;color:var(--forest-deep);font-size:1.25rem">Stock Control</h2>'
     + '<div style="font-size:.72rem;color:var(--timber);margin-top:1px">Track every physical stock unit, batch, expiry, usage and movement.</div></div>';
  h += '<div style="font-size:.68rem;font-weight:700;padding:5px 11px;border-radius:20px;'
     + (enabled?'background:#fde8e8;color:#b91c1c':'background:var(--mist-light);color:var(--forest)')+'">'+(enabled?'● LIVE':'○ MODULE OFF (safe)')+'</div>';
  h += '</div>';
  // tabs
  h += '<div style="display:flex;gap:2px;border-bottom:2px solid var(--mist-light);margin:10px 0 14px;overflow-x:auto;-webkit-overflow-scrolling:touch">';
  [['menu','🍰 Menu Stock'],['dash','📈 Dashboard'],['current','📦 Current Stock'],['moves','🧾 Movements'],['recipes','📖 Recipes'],['items','🏷️ Items'],['settings','⚙️ Settings']].forEach(function(t){
    var on=_invTab===t[0] || (t[0]==='current' && (_invTab==='receive'||_invTab==='waste'));
    h += '<button onclick="_invSetTab(\''+t[0]+'\')" style="background:none;border:none;cursor:pointer;padding:7px 12px;font-size:.8rem;font-weight:700;white-space:nowrap;flex-shrink:0;'
       + (on?'color:var(--forest-deep);border-bottom:3px solid var(--gold);margin-bottom:-2px':'color:var(--timber)')+'">'+t[1]+'</button>';
  });
  h += '</div><div id="invTabBody"></div></div>';
  h += '<div id="invDrawerHost"></div>';
  v.innerHTML = h;
  _invRenderTab();
}
function _invSetTab(t){ _invTab=t; _invRender(); if(t==='count') _invCntLoad(); else if(typeof _ieLoadTab==='function') _ieLoadTab(t); }
function _invRenderTab(){
  var b=document.getElementById('invTabBody'); if(!b) return;
  if (_invTab==='menu') b.innerHTML=_ieMenuHtml();
  else if (_invTab==='dash') b.innerHTML=_ieDashHtml();
  else if (_invTab==='current') b.innerHTML=_ieCurrentHtml();
  else if (_invTab==='moves') b.innerHTML=_ieMovesHtml();
  else if (_invTab==='receive') b.innerHTML=_ieReceiveHtml();
  else if (_invTab==='waste') b.innerHTML=_ieWasteHtml();
  else if (_invTab==='stock') b.innerHTML=_invStockHtml();
  else if (_invTab==='count') b.innerHTML=_invCntHtml();
  else if (_invTab==='recipes') b.innerHTML=_invRecipesHtml()+(typeof _ieAddonsHtml==='function'?_ieAddonsHtml():'');
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
  var filteredCount=_invFilteredUnits().length;
  var cards=[
    ['Low Stock', low, '#b45309'],
    ['Expiring Soon', expiring, '#c2410c'],
    ['Expired', expired, '#b91c1c'],
    ['Partial / Open', partial, '#1d4ed8'],
    ['Usage Events Today', usageToday, '#15803d'],
  ];
  var h='<div class="inv-sumgrid" style="gap:8px;margin-bottom:12px">';
  // Stock Units card — reflects the CURRENT filter so the count is never ambiguous
  h+='<div style="background:#fff;border:1px solid var(--mist);border-radius:9px;padding:8px 10px">'
    +'<div style="font-size:.62rem;color:var(--timber);text-transform:uppercase;letter-spacing:.3px;font-weight:600">Stock Units</div>'
    +'<div id="invSUCount" style="font-size:1.35rem;font-weight:800;color:#314C47;line-height:1.1;margin-top:2px">'+filteredCount+'</div>'
    +'<div id="invSULabel" style="font-size:.6rem;color:var(--forest);font-weight:700;text-transform:uppercase;letter-spacing:.3px">'+_invFilterLabel()+'</div></div>';
  cards.forEach(function(c){
    h+='<div style="background:#fff;border:1px solid var(--mist);border-radius:9px;padding:8px 10px">'
      +'<div style="font-size:.62rem;color:var(--timber);text-transform:uppercase;letter-spacing:.3px;font-weight:600">'+c[0]+'</div>'
      +'<div style="font-size:1.35rem;font-weight:800;color:'+c[2]+';line-height:1.1;margin-top:2px">'+c[1]+'</div></div>';
  });
  h+='</div>';
  return h;
}
function _invFilterLabel(){
  var m={ACTIVE:'Active',ALL:'All',AVAILABLE:'Available',LOW:'Low',OPEN:'Open',EXPIRING:'Expiring',EXPIRED:'Expired',PORTIONED:'Portioned',DEPLETED:'Depleted',WASTED:'Wasted'};
  return m[_invSStatus]||_invSStatus;
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
  var _stOpts=[['ACTIVE','Active stock'],['ALL','All status'],['AVAILABLE','Available'],['LOW','Low'],['OPEN','Open'],['EXPIRING','Expiring'],['EXPIRED','Expired'],['PORTIONED','Portioned'],['DEPLETED','Depleted'],['WASTED','Wasted']];
  _stOpts.forEach(function(s){ stSel+='<option value="'+s[0]+'"'+(_invSStatus===s[0]?' selected':'')+'>'+s[1]+'</option>'; });
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
    if(_invSStatus==='ACTIVE'){ var b=String(u.status||'').toUpperCase(); if(_invNum(u.quantity_remaining)<=0) return false; if(b==='PORTIONED'||b==='WASTED') return false; }
    else if(_invSStatus!=='ALL'){ var ds=_invUnitStatus(u); if(ds!==_invSStatus) return false; }
    if(_invSLowOnly){ var r=_invNum(u.quantity_remaining),o=_invNum(u.quantity_original); if(!(o>0 && r/o<=0.2)) return false; }
    if(q){ var hay=((u.stock_unit_code||'')+' '+(it.name||'')+' '+(u.batch_id||'')).toLowerCase(); if(hay.indexOf(q)<0) return false; }
    return true;
  });
}

function _invRenderStockTable(){
  var wrap=document.getElementById('invStockTableWrap'); if(!wrap) return;
  var rows=_invFilteredUnits();
  var suc=document.getElementById('invSUCount'); if(suc) suc.textContent=rows.length;
  var sul=document.getElementById('invSULabel'); if(sul) sul.textContent=_invFilterLabel();
  if(!_invUnits2.length){
    wrap.innerHTML='<div style="background:#fff;border:1px dashed var(--mist);border-radius:12px;padding:44px 20px;text-align:center">'
      +'<div style="font-size:1.6rem">📦</div>'
      +'<div style="font-size:.9rem;font-weight:700;color:var(--forest-deep);margin-top:6px">No stock units yet</div>'
      +'<div style="font-size:.76rem;color:var(--timber);margin-top:4px;max-width:420px;margin-left:auto;margin-right:auto">Stock appears here once you receive it. Tap <b>+ Receive Stock</b> to add your first physical unit, or <b>+ Produce</b> to make one from a recipe.</div></div>';
    return;
  }
  var cols=['Stock Code','Item','Type','Qty','Unit','Batch','Received','Expiry','Location','Status'];
  var h='<div class="inv-desk" style="background:#fff;border:1px solid var(--mist);border-radius:10px;overflow:auto;max-height:calc(100vh - 320px)">';
  h+='<table style="width:100%;border-collapse:collapse;font-size:.73rem;min-width:900px">';
  h+='<thead><tr style="background:var(--forest-deep)">';
  cols.forEach(function(c,i){ h+='<th style="position:sticky;top:0;z-index:2;background:var(--forest-deep);text-align:'+(i===3?'right':'left')+';padding:7px 9px;color:#fff;font-weight:700;font-size:.66rem;text-transform:uppercase;letter-spacing:.3px;white-space:nowrap">'+c+'</th>'; });
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
  // mobile: compact cards (no horizontal scroll)
  h+='<div class="inv-mob">';
  rows.forEach(function(u){
    var it=u.inv_items||{}, un=(u.inv_units||{}).name||'', loc=(u.inv_locations||{}).name||'—';
    var ds=_invUnitStatus(u); var dexp=_invDaysTo(u.expiry_date);
    var meta=[];
    if(u.expiry_date){ meta.push('Exp '+_invDate(u.expiry_date)); } else if(u.expected_use_date){ meta.push('Use by '+_invDate(u.expected_use_date)); }
    if(loc&&loc!=='—') meta.push(loc);
    h+='<div onclick="_invOpenDrawer('+u.id+')" style="background:#fff;border:1px solid var(--mist);border-radius:10px;padding:10px 12px;margin-bottom:8px;cursor:pointer">'
      +'<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">'
        +'<div style="min-width:0"><div style="font-size:.7rem;font-weight:700;color:var(--forest)">'+_invEsc(u.stock_unit_code||'—')+' <span style="font-weight:600;color:var(--timber)">'+_invTypeIco(it.item_type)+' '+_invEsc(_invTypeShort(it.item_type))+'</span></div>'
        +'<div style="font-size:.86rem;font-weight:700;color:var(--forest-deep);margin-top:1px">'+_invEsc(it.name||'—')+'</div></div>'
        +_invStatusPillBig(ds)
      +'</div>'
      +'<div style="display:flex;justify-content:space-between;align-items:baseline;margin-top:6px">'
        +'<div style="font-size:1.05rem;font-weight:800;color:var(--forest-deep)">'+_invFmtQty(u.quantity_remaining)+' <span style="font-size:.78rem;font-weight:600;color:var(--timber)">'+_invEsc(un)+'</span></div>'
        +'<div style="font-size:.68rem;color:'+((dexp!==null&&dexp<=3)?'#c2410c':'var(--timber)')+';font-weight:'+((dexp!==null&&dexp<=3)?'700':'400')+'">'+_invEsc(meta.join(' · '))+'</div>'
      +'</div></div>';
  });
  h+='</div>';
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
    +_invDrawerRow('Location', _invEsc(loc))
    +_invDrawerRow('Batch', _invEsc(u.batch_id||'—'))
    +_invDrawerRow('Unit cost', u.unit_cost?('₱'+_invNum(u.unit_cost).toFixed(2)):'—')
    +'<div class="invsec">Planning</div>'
    +_invDrawerRow('Expected use', _invDate(u.expected_use_date))
    +'<div style="font-size:.64rem;color:var(--timber);margin-top:2px">Planning info only — never deducts or consumes stock.</div>'
    +'<div class="invsec">Food safety</div>'
    +_invDrawerRow('Expiry', _invDate(u.expiry_date))
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
    + _invUnitsBlock(it)
    + '<label style="font-size:.72rem;font-weight:700;color:var(--forest-deep)">Notes (optional)</label>'
    + '<input id="invfDesc" value="'+(it?_invEsc(it.description||''):'')+'" style="width:100%;margin:4px 0 14px;font-size:.85rem;padding:9px;border:1.5px solid var(--mist);border-radius:8px">'
    + '<div style="display:flex;gap:8px">'
    + '<button onclick="_invCloseItemForm()" style="flex:1;font-size:.82rem;font-weight:700;background:var(--mist-light);color:var(--forest);border:none;border-radius:8px;padding:10px;cursor:pointer">Cancel</button>'
    + '<button onclick="_invSaveItem('+(it?it.id:'0')+')" style="flex:2;font-size:.82rem;font-weight:700;background:var(--forest);color:#fff;border:none;border-radius:8px;padding:10px;cursor:pointer">'+(it?'Save changes':'Create item')+'</button>'
    + '</div></div>';
  document.body.appendChild(m);
  _invItemTypeChanged();
  _invPuHint();
}
function _invCloseItemForm(){ var m=document.getElementById('invItemModal'); if(m) m.remove(); }

// purchase unit → stock unit, par, shelf life, rotation, supplier, location
function _invUnitsBlock(it){
  var o=function(list, sel, blank){ return (blank?'<option value="">'+blank+'</option>':'')+list.map(function(x){ return '<option value="'+x.id+'"'+(sel===x.id?' selected':'')+'>'+_invEsc(x.name)+'</option>'; }).join(''); };
  var fs='width:100%;margin-top:3px;font-size:.82rem;padding:8px;border:1.5px solid var(--mist);border-radius:8px';
  var lb='font-size:.7rem;font-weight:700;color:var(--forest-deep);display:block;margin-top:8px';
  return '<div style="background:var(--mist-light);border-radius:10px;padding:10px 12px;margin-bottom:10px">'
    + '<div style="font-size:.72rem;font-weight:800;color:var(--forest-deep)">How you buy it</div>'
    + '<div style="font-size:.66rem;color:var(--timber)">e.g. bought per <b>whole</b> cake, stocked and sold per <b>slice</b>: 1 whole = 16 slice.</div>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'
      + '<div><label style="'+lb+'">Purchase unit</label><select id="invfPU" onchange="_invPuHint()" style="'+fs+'">'+o(_invRef.units, it?it.purchase_unit_id:null, 'Same as stock unit')+'</select></div>'
      + '<div><label style="'+lb+'" id="invfPtsL">Stock units in 1</label><input id="invfPts" type="number" step="any" min="0" oninput="_invPuHint()" value="'+(it&&it.purchase_to_stock!=null?_invEsc(it.purchase_to_stock):'')+'" style="'+fs+'"></div>'
    + '</div><div id="invfPuHint" style="font-size:.7rem;color:#14532d;font-weight:700;margin-top:4px"></div>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">'
      + '<div><label style="'+lb+'">Par level</label><input id="invfPar" type="number" step="any" min="0" value="'+(it&&it.par_level!=null?_invEsc(it.par_level):'')+'" placeholder="low below" style="'+fs+'"></div>'
      + '<div><label style="'+lb+'">Shelf life (days)</label><input id="invfShelf" type="number" step="1" min="0" value="'+(it&&it.shelf_life_days!=null?_invEsc(it.shelf_life_days):'')+'" style="'+fs+'"></div>'
      + '<div><label style="'+lb+'">Use first</label><select id="invfRot" style="'+fs+'"><option value="FEFO"'+(!it||it.rotation!=='FIFO'?' selected':'')+'>Soonest expiry</option><option value="FIFO"'+(it&&it.rotation==='FIFO'?' selected':'')+'>Oldest received</option></select></div>'
    + '</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'
      + '<div><label style="'+lb+'">Default supplier</label><select id="invfSup" style="'+fs+'">'+o(_invRef.suppliers, it?it.default_supplier_id:null, '—')+'</select></div>'
      + '<div><label style="'+lb+'">Storage location</label><select id="invfLoc" style="'+fs+'">'+o(_invRef.locations, it?it.default_location_id:null, '—')+'</select></div>'
    + '</div></div>';
}
function _invPuHint(){
  var pu=document.getElementById('invfPU'), pts=document.getElementById('invfPts'), su=document.getElementById('invfUnit'), h=document.getElementById('invfPuHint'); if(!pu||!h) return;
  var pn=(_invRef.units.filter(function(u){return String(u.id)===pu.value;})[0]||{}).name, sn=(_invRef.units.filter(function(u){return String(u.id)===(su||{}).value;})[0]||{}).name||'unit';
  var L=document.getElementById('invfPtsL'); if(L) L.textContent=pn?(sn+'s in 1 '+pn):'Stock units in 1';
  if(pts) pts.disabled=!pn;
  h.textContent = (pn && parseFloat(pts.value)>0) ? ('Receiving 2 '+pn+' adds '+_invFmtQty(2*parseFloat(pts.value))+' '+sn) : '';
}

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
  var puEl=document.getElementById('invfPU');
  if (puEl) {
    var pu=parseInt(puEl.value,10)||null, pts=parseFloat((document.getElementById('invfPts')||{}).value);
    if (pu && pu!==parseInt(baseUnitId,10) && !(pts>0)) { showToast('Enter how many stock units are in one purchase unit','error'); return; }
    payload.purchaseUnitId = (pu && pu!==parseInt(baseUnitId,10)) ? pu : null;
    payload.purchaseToStock = payload.purchaseUnitId ? pts : null;
    var par=(document.getElementById('invfPar')||{}).value, sh=(document.getElementById('invfShelf')||{}).value;
    payload.parLevel = par===''?null:parseFloat(par);
    payload.shelfLifeDays = sh===''?null:parseInt(sh,10);
    payload.rotation = (document.getElementById('invfRot')||{}).value||'FEFO';
    payload.defaultSupplierId = parseInt((document.getElementById('invfSup')||{}).value,10)||null;
    payload.defaultLocationId = parseInt((document.getElementById('invfLoc')||{}).value,10)||null;
  }
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
  // long pickers become type-to-search (the <select> stays as the value holder)
  m.querySelectorAll('select').forEach(function(s){ if(s.options.length>15) _invSearchable(s); });
}

// ── Type-to-search picker ────────────────────────────────────────────────
// Wraps a <select>: staff type part of a name ("buco", "milk fresh") and pick
// from the matches with a tap, Enter or arrow keys. The hidden select keeps the
// value and fires its own onchange, so every existing reader keeps working.
function _invSearchable(sel){
  if(!sel || sel._invSearch) return; sel._invSearch=true;
  var preset=false; for(var i=0;i<sel.options.length;i++){ if(sel.options[i].defaultSelected){ preset=true; break; } }
  if(!preset && sel.options[0] && sel.options[0].value!==''){ var ph=document.createElement('option'); ph.value=''; ph.text=''; sel.insertBefore(ph, sel.options[0]); sel.value=''; }
  var wrap=document.createElement('div'); wrap.style.cssText='position:relative;width:100%';
  var inp=document.createElement('input'); inp.type='text'; inp.autocomplete='off'; inp.setAttribute('role','combobox'); inp.setAttribute('aria-expanded','false');
  inp.placeholder='Type to search…';
  inp.style.cssText=(sel.getAttribute('style')||'')+';width:100%;box-sizing:border-box';
  if(sel.className) inp.className=sel.className;
  var list=document.createElement('div'); list.setAttribute('role','listbox');
  list.style.cssText='display:none;position:absolute;left:0;right:0;top:100%;margin-top:3px;background:#fff;border:1.5px solid var(--mist);border-radius:8px;box-shadow:0 8px 22px rgba(0,0,0,.14);max-height:240px;overflow:auto;z-index:10005';
  sel.parentNode.insertBefore(wrap, sel); wrap.appendChild(inp); wrap.appendChild(list); wrap.appendChild(sel); sel.style.display='none';
  var hits=[], hi=0;
  function curText(){ var o=sel.options[sel.selectedIndex]; return (o&&o.value!=='')?o.text:''; }
  inp.value=curText();
  sel._invSync=function(){ inp.value=curText(); };   // call after setting sel.value in code
  function norm(t){ return String(t||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,''); }
  function render(q){
    var toks=norm(q).split(/\s+/).filter(Boolean);
    hits=[];
    for(var i=0;i<sel.options.length;i++){ var o=sel.options[i]; if(o.value==='') continue;
      var t=norm(o.text); if(toks.every(function(k){ return t.indexOf(k)>=0; })) hits.push(o); }
    if(toks.length) hits.sort(function(a,b){ var aa=norm(a.text).indexOf(toks[0])===0?0:1, bb=norm(b.text).indexOf(toks[0])===0?0:1; return aa-bb; });
    hi=0;
    list.innerHTML=hits.length? hits.slice(0,60).map(function(o,i){
        return '<div data-i="'+i+'" role="option" style="padding:8px 10px;font-size:.8rem;cursor:pointer;border-bottom:1px solid var(--mist-light);'+(i===0?'background:var(--mist-light);':'')+'">'+_invEsc(o.text)+'</div>'; }).join('')
      : '<div style="padding:9px 10px;font-size:.76rem;color:var(--timber)">No match for “'+_invEsc(q)+'”</div>';
    list.style.display='block'; inp.setAttribute('aria-expanded','true');
  }
  function mark(){ var rows=list.querySelectorAll('[data-i]'); rows.forEach(function(r,i){ r.style.background=(i===hi)?'var(--mist-light)':''; }); if(rows[hi]) rows[hi].scrollIntoView({block:'nearest'}); }
  function choose(o){ if(!o) return; sel.value=o.value; inp.value=o.text; close(); sel.dispatchEvent(new Event('change',{bubbles:true})); }
  function close(){ list.style.display='none'; inp.setAttribute('aria-expanded','false'); }
  inp.addEventListener('focus', function(){ inp.select(); render(''); });
  inp.addEventListener('input', function(){ render(inp.value); });
  inp.addEventListener('keydown', function(e){
    if(list.style.display==='none' && (e.key==='ArrowDown')){ render(inp.value); return; }
    if(e.key==='ArrowDown'){ e.preventDefault(); hi=Math.min(hi+1, Math.min(hits.length,60)-1); mark(); }
    else if(e.key==='ArrowUp'){ e.preventDefault(); hi=Math.max(hi-1,0); mark(); }
    else if(e.key==='Enter'){ e.preventDefault(); if(hits.length) choose(hits[hi]); }
    else if(e.key==='Escape'){ close(); inp.value=curText(); }
  });
  list.addEventListener('mousedown', function(e){ var r=e.target.closest('[data-i]'); if(!r) return; e.preventDefault(); choose(hits[+r.getAttribute('data-i')]); });
  inp.addEventListener('blur', function(){ setTimeout(function(){ close(); inp.value=curText(); },120); });
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
  var itemOpts=_invItems.map(function(it){return '<option value="'+it.id+'" data-unit="'+it.base_unit_id+'" data-yield="'+(it.standard_yield||'')+'">'+_invEsc(it.name)+'</option>';}).join('');
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
    +_invField('Notes',_invInput('rcNotes','text','delivery ref, supplier…'))
    +'<div id="rcPackHint" style="display:none;font-size:.68rem;color:#8a5a0b;background:#fff7e6;border-radius:8px;padding:7px 9px;margin-top:8px"></div>';
  _invModal('Receive Stock', body, 'Receive', _invSubmitReceive);
  setTimeout(_invRcUnit,20);
}
function _invRcUnit(){ var s=document.getElementById('rcItem'); if(!s)return; var o=s.options[s.selectedIndex]; var u=o.getAttribute('data-unit'), y=o.getAttribute('data-yield'); var us=document.getElementById('rcUnit'); if(us&&u){ us.value=u; if(us._invSync) us._invSync(); }
  var hint=document.getElementById('rcPackHint'); if(!hint) return;
  var un=(_invRef.units.filter(function(x){return String(x.id)===String(u);})[0]||{}).name||'';
  if(y && (un==='slice'||un==='serving')){ var box=_invRef.units.filter(function(x){return x.name==='box';})[0]; if(box&&us){ us.value=box.id; if(us._invSync) us._invSync(); } hint.style.display='block'; hint.innerHTML='Stocked in '+un+'s. Pick unit <b>box</b> (or whole) and enter boxes — 1 box becomes <b>'+_invFmtQty(y)+' '+un+'s</b>. Unit cost is per box.'; }
  else { hint.style.display='none'; } }
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
  var _ut={}; _invRef.units.forEach(function(u){_ut[u.id]=u.unit_type;});
  var units=_invUnits2.filter(function(u){var it=u.inv_items||{};return _invNum(u.quantity_remaining)>0 && (it.is_portionable||it.item_type==='PORTIONABLE'||it.item_type==='PRODUCED') && _ut[u.unit_id]==='count' && String(u.status).toUpperCase()!=='PORTIONED';});
  if(!units.length){showToast('No whole-unit portionable stock available (portioning needs a count-based unit like whole/pc)','error');return;}
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

// ══ RECIPES TAB (definition only — never consumes stock) ════════════════════
var _invRecLines=[];   // working ingredient rows for the form
function _invRecipesHtml(){
  var h='';
  h+='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">';
  h+='<div style="font-size:.75rem;color:var(--timber)">A recipe defines what a made item consumes and how much it yields. Creating or editing a recipe <b>never</b> deducts stock.</div>';
  h+='<button onclick="_invOpenRecipeForm()" style="font-size:.78rem;font-weight:700;background:var(--forest);color:#fff;border:none;border-radius:8px;padding:7px 14px;cursor:pointer;white-space:nowrap">+ New Recipe</button>';
  h+='</div>';
  if(!_invRecipes.length){
    h+='<div style="background:#fff;border:1px dashed var(--mist);border-radius:12px;padding:40px;text-align:center;color:var(--timber);font-size:.82rem">No recipes yet. Tap <b>+ New Recipe</b> to define one (e.g. a cake from flour, eggs, sugar).</div>';
    return h;
  }
  h+='<div style="display:flex;flex-direction:column;gap:8px">';
  _invRecipes.forEach(function(rc){
    var out=(rc.inv_items||{}).name||'—';
    var yUnit=(_invRef.units.filter(function(u){return u.id===rc.yield_unit_id;})[0]||{}).name||'';
    var lines=rc.inv_recipe_ingredients||[];
    var cost=_invRecipeCostOf(lines);
    var cpy=(cost!=null && _invNum(rc.yield_qty)>0)? (cost/_invNum(rc.yield_qty)) : null;
    h+='<div style="background:#fff;border:1px solid var(--mist);border-radius:10px;padding:11px 13px">'
      +'<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">'
        +'<div><div style="font-size:.9rem;font-weight:700;color:var(--forest-deep)">📖 '+_invEsc(rc.name)+(rc.size_code?' <span style="font-size:.62rem;font-weight:800;background:#eef2ff;color:#4338ca;border-radius:6px;padding:2px 7px">'+_invEsc(rc.size_code)+'</span>':'')+'</div>'
        +'<div style="font-size:.7rem;color:var(--timber);margin-top:1px">makes <b>'+_invEsc(out)+'</b> · yields '+_invFmtQty(rc.yield_qty)+' '+_invEsc(yUnit)+' · '+lines.length+' ingredient'+(lines.length!==1?'s':'')+'</div></div>'
        +'<div style="text-align:right;white-space:nowrap"><div style="font-size:.62rem;color:var(--timber);text-transform:uppercase;letter-spacing:.3px">Cost</div>'
        +'<div style="font-size:.95rem;font-weight:800;color:var(--forest-deep)">'+(cost!=null?('₱'+cost.toFixed(2)):'—')+'</div>'
        +'<div style="font-size:.62rem;color:var(--timber)">'+(cpy!=null?('₱'+cpy.toFixed(2)+' / '+_invEsc(yUnit)):'cost pending')+'</div></div>'
      +'</div>'
      +'<div style="display:flex;gap:6px;margin-top:8px">'
        +'<button onclick="_invOpenRecipeForm('+rc.id+')" style="font-size:.7rem;font-weight:700;background:var(--mist-light);color:var(--forest);border:none;border-radius:7px;padding:6px 12px;cursor:pointer">Edit</button>'
        +(_invIsOwner()?'<button onclick="_invArchiveRecipe('+rc.id+',\''+_invEsc(rc.name).replace(/\x27/g,"")+'\')" style="font-size:.7rem;font-weight:700;background:#fff;color:#b91c1c;border:1px solid #f0caca;border-radius:7px;padding:6px 12px;cursor:pointer">Archive</button>':'')
      +'</div></div>';
  });
  h+='</div>';
  if(!_invUnits2.length) h+='<div style="font-size:.68rem;color:var(--timber);margin-top:10px">💡 Ingredient costs appear once you receive that ingredient into stock with a unit cost. Recipe definition works fully without costs.</div>';
  return h;
}
function _invRecipeCostOf(lines){
  var total=0, known=false;
  (lines||[]).forEach(function(l){
    var iid=l.ingredient_item_id||l.ingredientItemId;
    var c=_invIngredientCost(iid);
    if(c!=null){ known=true; total+=_invNum(l.quantity)*c; }
  });
  return known?total:null;
}

function _invOpenRecipeForm(id){
  if(!_invIsAdmin()){showToast('ADMIN/OWNER only','error');return;}
  var rc = id ? _invRecipes.filter(function(x){return x.id===id;})[0] : null;
  // output items = PRODUCED or PREP; ingredients = RAW_MATERIAL or PREP
  var outOpts=_invItems.filter(function(it){return it.item_type==='PRODUCED'||it.item_type==='PREP'||it.item_type==='PORTIONABLE';})
    .map(function(it){return '<option value="'+it.id+'"'+(rc&&rc.item_id===it.id?' selected':'')+'>'+INV_TYPE_META[it.item_type].ico+' '+_invEsc(it.name)+'</option>';}).join('');
  if(!outOpts){showToast('Create a Produced or Prep item first (Items tab)','error');return;}
  var unitOpts=_invRef.units.map(function(u){return '<option value="'+u.id+'"'+(rc&&rc.yield_unit_id===u.id?' selected':'')+'>'+_invEsc(u.name)+'</option>';}).join('');
  // init working lines
  _invRecLines = rc ? (rc.inv_recipe_ingredients||[]).map(function(l){return {ingredientItemId:l.ingredient_item_id,quantity:l.quantity,unitId:l.unit_id,yieldLossPct:l.yield_loss_pct};}) : [{}];
  if(!_invRecLines.length) _invRecLines=[{}];
  var m=document.createElement('div'); m.id='invActionModal';
  m.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10000;display:flex;align-items:flex-start;justify-content:center;padding:14px;overflow:auto';
  m.innerHTML='<div style="background:#fff;border-radius:14px;max-width:560px;width:100%;padding:18px;margin-top:16px">'
    +'<div style="font-size:1rem;font-weight:800;color:var(--forest-deep)">'+(rc?'Edit recipe':'New recipe')+'</div>'
    +'<div style="font-size:.66rem;color:var(--timber);margin-bottom:12px">Definition only — saving does NOT deduct stock. Writes to inv_recipes / inv_recipe_ingredients.</div>'
    +_invField('Recipe name',_invInput('rcName','text','e.g. Chocolate Cake 4\\" recipe', rc?rc.name:''))
    +_invField('This recipe makes (output item)',_invSelect('rcOut',outOpts))
    +_invField('Size (drinks: one recipe per size, with the real amounts)',_invSelect('rcSize',[['','Any size / no sizes'],['SHORT','Short'],['MEDIUM','Medium'],['TALL','Tall'],['SLICE','Slice'],['WHOLE','Whole']].map(function(z){ return '<option value="'+z[0]+'"'+((rc&&(rc.size_code||'')===z[0])?' selected':'')+'>'+z[1]+'</option>'; }).join('')))
    +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'
      +'<div>'+_invField('Yield quantity',_invInput('rcYQty','number','1', rc?rc.yield_qty:''))+'</div>'
      +'<div>'+_invField('Yield unit',_invSelect('rcYUnit',unitOpts))+'</div></div>'
    +'<div style="font-size:.66rem;color:var(--timber);text-transform:uppercase;letter-spacing:.4px;font-weight:800;margin:14px 0 4px">Ingredients</div>'
    +'<div id="recLines"></div>'
    +'<button onclick="_invRecipeAddLine()" style="font-size:.72rem;font-weight:700;background:var(--mist-light);color:var(--forest);border:none;border-radius:7px;padding:7px 12px;cursor:pointer;margin-top:4px">+ Add ingredient</button>'
    +'<div id="recCost" style="margin-top:12px;background:var(--mist-light);border-radius:8px;padding:10px 12px"></div>'
    +_invField('Notes (optional)',_invInput('rcNotes','text','', rc?(rc.notes||''):''))
    +'<div style="display:flex;gap:8px;margin-top:14px"><button onclick="_invCloseModal()" style="flex:1;font-size:.82rem;font-weight:700;background:var(--mist-light);color:var(--forest);border:none;border-radius:8px;padding:10px;cursor:pointer">Cancel</button>'
    +'<button onclick="_invSaveRecipe('+(rc?rc.id:'0')+')" style="flex:2;font-size:.82rem;font-weight:700;background:var(--forest);color:#fff;border:none;border-radius:8px;padding:10px;cursor:pointer">'+(rc?'Save changes':'Create recipe')+'</button></div></div>';
  document.body.appendChild(m);
  _invRecipeRenderLines();
}
function _invRecipeIngOpts(sel){
  return _invItems.filter(function(it){return it.item_type==='RAW_MATERIAL'||it.item_type==='PREP';})
    .map(function(it){return '<option value="'+it.id+'"'+(sel==it.id?' selected':'')+'>'+INV_TYPE_META[it.item_type].ico+' '+_invEsc(it.name)+'</option>';}).join('');
}
function _invRecipeUnitOpts(sel){ return _invRef.units.map(function(u){return '<option value="'+u.id+'"'+(sel==u.id?' selected':'')+'>'+_invEsc(u.name)+'</option>';}).join(''); }
function _invRecipeRenderLines(){
  var box=document.getElementById('recLines'); if(!box) return;
  var h='';
  _invRecLines.forEach(function(l,i){
    h+='<div style="display:grid;grid-template-columns:1fr 64px 70px 30px;gap:5px;margin-bottom:5px;align-items:center">'
      +'<select id="rl_ing_'+i+'" oninput="_invRecipeCostLive()" onchange="_invRecipeCostLive()" style="font-size:.76rem;padding:6px;border:1.5px solid var(--mist);border-radius:7px">'+_invRecipeIngOpts(l.ingredientItemId)+'</select>'
      +'<input id="rl_qty_'+i+'" type="number" step="0.001" value="'+(l.quantity!=null?_invEsc(l.quantity):'')+'" placeholder="qty" oninput="_invRecipeCostLive()" style="font-size:.76rem;padding:6px;border:1.5px solid var(--mist);border-radius:7px">'
      +'<select id="rl_unit_'+i+'" style="font-size:.74rem;padding:6px;border:1.5px solid var(--mist);border-radius:7px">'+_invRecipeUnitOpts(l.unitId)+'</select>'
      +'<button onclick="_invRecipeRemoveLine('+i+')" style="font-size:.9rem;background:none;border:none;color:#b91c1c;cursor:pointer">✕</button>'
      +'</div>';
  });
  box.innerHTML=h;
  _invRecLines.forEach(function(l,i){ var s=document.getElementById('rl_ing_'+i); if(s) _invSearchable(s); });
  _invRecipeCostLive();
}
function _invRecipeSyncDom(){
  _invRecLines.forEach(function(l,i){
    var ing=document.getElementById('rl_ing_'+i), qty=document.getElementById('rl_qty_'+i), un=document.getElementById('rl_unit_'+i);
    if(ing) l.ingredientItemId=+ing.value;
    if(qty) l.quantity=parseFloat(qty.value)||0;
    if(un) l.unitId=+un.value;
  });
}
function _invRecipeAddLine(){ _invRecipeSyncDom(); _invRecLines.push({}); _invRecipeRenderLines(); }
function _invRecipeRemoveLine(i){ _invRecipeSyncDom(); _invRecLines.splice(i,1); if(!_invRecLines.length)_invRecLines=[{}]; _invRecipeRenderLines(); }
function _invRecipeCostLive(){
  _invRecipeSyncDom();
  var box=document.getElementById('recCost'); if(!box) return;
  var total=0, known=false, anyLine=false;
  _invRecLines.forEach(function(l){
    if(l.ingredientItemId && l.quantity>0){ anyLine=true; var c=_invIngredientCost(l.ingredientItemId); if(c!=null){ known=true; total+=l.quantity*c; } }
  });
  var yq=parseFloat((document.getElementById('rcYQty')||{}).value)||0;
  var yu=(_invRef.units.filter(function(u){return u.id===+(document.getElementById('rcYUnit')||{}).value;})[0]||{}).name||'';
  var cpy=(known && yq>0)?(total/yq):null;
  box.innerHTML='<div style="display:flex;justify-content:space-between;font-size:.82rem"><span style="color:var(--timber)">Recipe cost</span><b style="color:var(--forest-deep)">'+(known?('₱'+total.toFixed(2)):'—')+'</b></div>'
    +'<div style="display:flex;justify-content:space-between;font-size:.78rem;margin-top:3px"><span style="color:var(--timber)">Cost per yield unit</span><b style="color:var(--forest)">'+(cpy!=null?('₱'+cpy.toFixed(2)+' / '+_invEsc(yu)):'—')+'</b></div>'
    +(!known&&anyLine?'<div style="font-size:.64rem;color:var(--timber);margin-top:4px">Cost appears once these ingredients are received into stock with a unit cost.</div>':'');
}
async function _invSaveRecipe(id){
  _invRecipeSyncDom();
  var name=(document.getElementById('rcName')||{}).value.trim();
  var itemId=+(document.getElementById('rcOut')||{}).value;
  var yieldQty=parseFloat((document.getElementById('rcYQty')||{}).value)||1;
  var yieldUnitId=+(document.getElementById('rcYUnit')||{}).value;
  var yUnit=_invRef.units.filter(function(u){return u.id===yieldUnitId;})[0]||{};
  var yieldType = (yUnit.name==='whole')?'whole':(yUnit.unit_type||'count');
  var notes=(document.getElementById('rcNotes')||{}).value.trim();
  if(!name){showToast('Enter a recipe name','error');return;}
  if(!itemId){showToast('Pick the output item','error');return;}
  var lines=_invRecLines.filter(function(l){return l.ingredientItemId && l.quantity>0 && l.unitId;});
  if(!lines.length){showToast('Add at least one ingredient','error');return;}
  if(lines.some(function(l){return l.ingredientItemId===itemId;})){showToast('A recipe cannot use its own output as an ingredient','error');return;}
  var payload={name:name,itemId:itemId,yieldQty:yieldQty,yieldUnitId:yieldUnitId,yieldType:yieldType,notes:notes,sizeCode:(document.getElementById('rcSize')||{}).value||null,
    ingredients:lines.map(function(l){return {ingredientItemId:l.ingredientItemId,quantity:l.quantity,unitId:l.unitId};})};
  if(id) payload.id=id;
  var r=await api('invSaveRecipe',payload);
  if(r&&r.ok){ showToast(id?'Recipe updated':'Recipe created','success'); _invCloseModal(); await _invLoadRecipes(); _invRenderTab(); }
  else showToast((r&&r.error)||'Failed to save recipe','error');
}
async function _invArchiveRecipe(id,name){
  if(!_invIsOwner()){showToast('OWNER only','error');return;}
  if(!confirm('Archive recipe "'+name+'"? It will be hidden but not deleted.')) return;
  var r=await api('invArchiveRecipe',{id:id});
  if(r&&r.ok){ showToast('Recipe archived','success'); await _invLoadRecipes(); _invRenderTab(); }
  else showToast((r&&r.error)||'Failed','error');
}

// ── COUNT TAB: Display Count (ready-to-sell, per menu) ──────────────────────
// Opening / Closing count with a Spoiled column, per-row expiry and batch,
// spoilage log with photo and owner approval, History, and a live preview of
// what customers see on the QR menu. Every change is a ledger row.
var _invCntDate  = null;   // YYYY-MM-DD (Manila)
var _invCntShift = null;   // 'OPENING' | 'CLOSING' | 'HISTORY'
var _invCntSheet = [];     // items (tracked + not yet tracked)
var _invCntVals  = {};     // itemId -> {counted, spoiled, spoilReason, photo, reason, touched}
var _invCntLog   = [];     // day log rows
var _invCntHist  = [];     // recent counts
var _invCntBusy  = false;
var _invCntLoaded = false;
var _invCntStarted = null; // when this screen was opened
var _invCntAddOpen = false, _invCntAddQ = '', _invCntAddQty = {};
var INV_REASONS = { SPOILED:'Spoiled', EXPIRED:'Expired', DAMAGED:'Damaged', STAFF_MEAL:'Staff meal', COMPLIMENTARY:'Complimentary', MISSING:'Missing', FOUND:'Found (extra)', COUNTED:'Counted' };
var INV_SPOIL_REASONS = ['SPOILED','EXPIRED','DAMAGED','STAFF_MEAL','COMPLIMENTARY'];

function _invManilaToday(){ return new Date(Date.now()+8*3600e3).toISOString().slice(0,10); }
function _invPeso(n){ return '₱'+(_invNum(n)).toLocaleString('en-PH',{minimumFractionDigits:0,maximumFractionDigits:2}); }
function _invDateLong(d){ try{ return new Date(d+'T00:00:00+08:00').toLocaleDateString('en-PH',{weekday:'short',month:'short',day:'numeric',year:'numeric',timeZone:'Asia/Manila'}); }catch(e){ return d; } }
function _invTime(ts){ try{ return new Date(ts).toLocaleTimeString('en-PH',{hour:'numeric',minute:'2-digit',timeZone:'Asia/Manila'}); }catch(e){ return ''; } }
function _invDay(ts){ try{ return new Date(ts).toLocaleDateString('en-PH',{month:'short',day:'numeric',timeZone:'Asia/Manila'}); }catch(e){ return ''; } }
function _invPhotoAbove(){ return _invNum(_invCfg.spoilage_photo_above||100); }
function _invApprovalAbove(){ return _invNum(_invCfg.spoilage_approval_above||200); }
function _invDraftKey(){ return 'invCountDraft:'+_invCntDate+':'+_invCntShift; }

async function _invCntLoad(){
  if(!_invCntDate) _invCntDate=_invManilaToday();
  if(!_invCntShift) _invCntShift=(new Date(Date.now()+8*3600e3).getUTCHours()<15)?'OPENING':'CLOSING';
  if(!_invCntStarted) _invCntStarted=new Date();
  var isToday=(_invCntDate===_invManilaToday());
  var res=await Promise.all([api('invDayLog',{date:_invCntDate}), api('invCountSheet',{}), api('invCountHistory',{days:30})]);
  _invCntLog=(res[0]&&res[0].ok)?(res[0].rows||[]):[];
  _invCntSheet=(res[1]&&res[1].ok)?(res[1].items||[]):[];
  _invCntHist=(res[2]&&res[2].ok)?(res[2].counts||[]):[];
  _invCntLoaded=true;
  _invCntResetVals(true);
  if(_invTab==='count') _invRenderTab();
}
function _invCntResetVals(useDraft){
  _invCntVals={};
  _invCntSheet.forEach(function(it){ _invCntVals[it.item_id]={counted:it.tracked?_invNum(it.system_qty):null,spoiled:0,spoilReason:'',photo:'',reason:'',touched:false}; });
  if(useDraft){ try{ var d=JSON.parse(localStorage.getItem(_invDraftKey())||'null');
    if(d&&d.vals){ Object.keys(d.vals).forEach(function(k){ var it=_invCntSheet.filter(function(x){return String(x.item_id)===k;})[0];
      if(it&&it.tracked&&Math.abs(_invNum(d.seen&&d.seen[k])-_invNum(it.system_qty))<1e-9) _invCntVals[k]=d.vals[k]; }); _invCntDraftAt=d.at; } }catch(e){} }
}
var _invCntDraftAt=null;
function _invCntSaveDraft(){
  try{ var seen={}; _invCntSheet.forEach(function(it){ seen[it.item_id]=it.system_qty; });
    localStorage.setItem(_invDraftKey(), JSON.stringify({vals:_invCntVals,seen:seen,at:new Date().toISOString()}));
    _invCntDraftAt=new Date().toISOString(); showToast('Draft saved on this device','success'); _invRenderTab(); }
  catch(e){ showToast('Could not save draft on this device','error'); }
}
function _invCntClearDraft(){ try{ localStorage.removeItem(_invDraftKey()); }catch(e){} _invCntDraftAt=null; }
function _invCntShiftTab(s){ _invCntShift=s; if(s!=='HISTORY'){ _invCntResetVals(true); } _invRenderTab(); }
function _invCntMove(days){
  var d=new Date((_invCntDate||_invManilaToday())+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+days);
  var nd=d.toISOString().slice(0,10); if(nd>_invManilaToday()) return;
  _invCntDate=nd; _invCntLoad();
}
function _invCntPick(v){ if(!v) return; if(v>_invManilaToday()) v=_invManilaToday(); _invCntDate=v; _invCntLoad(); }

function _invCntCss(){
  if(document.getElementById('invCntCss')) return;
  var st=document.createElement('style'); st.id='invCntCss';
  st.textContent=''
   +'.dc-wrap{display:flex;gap:18px;align-items:flex-start}'
   +'.dc-card{flex:1;min-width:0;background:#fbf8f3;border:1px solid #ddd3c4;border-radius:14px;overflow:hidden}'
   +'.dc-top{background:var(--forest-deep,#1a3a2a);color:#fff;padding:14px 18px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}'
   +'.dc-top h3{margin:0;font:600 1.15rem Georgia,serif}.dc-top small{opacity:.85;font-size:.72rem}'
   +'.dc-body{padding:14px 18px}'
   +'.dc-bar{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px}'
   +'.dc-pill{padding:7px 15px;border-radius:20px;border:1px solid #cfc5b4;font-size:.8rem;background:#fff;cursor:pointer;color:var(--forest-deep)}'
   +'.dc-pill.on{background:var(--forest-deep,#1a3a2a);color:#fff;border-color:var(--forest-deep,#1a3a2a)}'
   +'.dc-nav{width:32px;height:34px;border:1px solid #cfc5b4;border-radius:9px;background:#fff;color:var(--forest);cursor:pointer}'
   +'.dc-date{border:1px solid #cfc5b4;border-radius:9px;padding:6px 10px;font-size:.84rem;font-weight:700;background:#fff}'
   +'.dc-meta{font-size:.72rem;color:#6b6f66;margin-bottom:6px}'
   +'.dc-scroll{overflow-x:auto}'
   +'.dc-t{width:100%;border-collapse:collapse;min-width:900px}'
   +'.dc-t th{font-size:.62rem;letter-spacing:.7px;color:#7a7d73;text-align:left;padding:8px 6px;border-bottom:1px solid #e3dccf;font-weight:700;text-transform:uppercase;position:sticky;top:0;background:#fbf8f3}'
   +'.dc-t td{padding:10px 6px;border-bottom:1px solid #eee7da;font-size:.84rem;vertical-align:middle}'
   +'.dc-nm{font-weight:700;color:#1f2a22}.dc-sub{font-size:.68rem;color:#7a7d73;margin-top:2px}'
   +'.dc-also{display:inline-block;margin-top:4px;font-size:.62rem;background:#f3eee3;color:#6b5a3a;padding:2px 8px;border-radius:10px}'
   +'.dc-step{display:flex;align-items:center;gap:5px}'
   +'.dc-step button{width:30px;height:32px;border-radius:8px;border:1px solid #cfc5b4;background:#fff;font-size:1rem;color:var(--forest);cursor:pointer}'
   +'.dc-step input{width:46px;height:32px;border-radius:8px;border:2px solid var(--forest-deep,#1a3a2a);background:#fff;font-size:.95rem;font-weight:700;text-align:center}'
   +'.dc-step input.chg{border-color:#c0762a;background:#fff6ea}.dc-step input.sp{border-color:#b3261e;background:#fdf0ee;color:#8a2a22}.dc-step input.z{border-color:#d9d2c4;color:#9aa093}'
   +'.dc-mini{margin-top:4px;display:flex;gap:4px;align-items:center;font-size:.66rem;color:#6b6f66}'
   +'.dc-mini select{font-size:.66rem;padding:2px 4px;border-radius:6px;border:1px solid #e0b4ae;background:#fdf0ee;color:#8a2a22}'
   +'.dc-mini label{cursor:pointer;color:var(--forest);text-decoration:underline}'
   +'.dc-rsn{font-size:.72rem;border:1px solid #e0b4ae;background:#fdf0ee;color:#8a2a22;border-radius:8px;padding:5px 6px}'
   +'.dc-ok{font-size:.72rem;color:#3b6d11}'
   +'.dc-sum{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin-top:12px}'
   +'.dc-sc{background:#fff;border:1px solid #e3dccf;border-radius:10px;padding:10px 12px}.dc-sc b{font-size:1.2rem;display:block}.dc-sc span{font-size:.66rem;color:#7a7d73}'
   +'.dc-h4{font:600 .95rem Georgia,serif;margin:18px 0 6px;display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap}.dc-h4 small{font:400 .68rem sans-serif;color:#7a7d73}'
   +'.dc-log{width:100%;border-collapse:collapse;min-width:760px}.dc-log th{font-size:.6rem;letter-spacing:.6px;color:#7a7d73;text-align:left;padding:7px 6px;border-bottom:1px solid #e3dccf;text-transform:uppercase}'
   +'.dc-log td{padding:8px 6px;border-bottom:1px solid #eee7da;font-size:.8rem}'
   +'.dc-tag{font-size:.62rem;font-weight:700;padding:2px 8px;border-radius:10px}'
   +'.dc-foot{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:14px;flex-wrap:wrap}'
   +'.dc-btn{padding:10px 18px;border-radius:9px;font-size:.84rem;border:1px solid #cfc5b4;background:#fff;cursor:pointer;color:var(--forest-deep)}'
   +'.dc-btn.p{background:var(--forest-deep,#1a3a2a);color:#fff;border-color:var(--forest-deep,#1a3a2a);font-weight:700}'
   +'.dc-btn.r{border-color:#e0b4ae;color:#8a2a22;background:#fdf0ee}'
   +'.dc-phone{width:300px;flex:none;background:#1b1b1b;border-radius:34px;padding:11px;position:sticky;top:10px}'
   +'.dc-scr{background:#fbf8f3;border-radius:24px;overflow:hidden;min-height:520px}'
   +'.dc-ph{background:var(--forest-deep,#1a3a2a);color:#fff;padding:20px 14px 12px}.dc-ph b{font:600 1rem Georgia,serif;display:block}.dc-ph small{opacity:.85;font-size:.68rem}'
   +'.dc-it{display:flex;justify-content:space-between;align-items:center;background:#fff;border:1px solid #e8e0d2;border-radius:12px;margin:8px 12px;padding:10px}'
   +'.dc-it .t{font-weight:700;font-size:.8rem}.dc-it .p{font-size:.72rem;color:#6b6f66;margin-top:2px}'
   +'.dc-add{width:30px;height:30px;border-radius:50%;background:var(--forest-deep,#1a3a2a);color:#fff;display:flex;align-items:center;justify-content:center;font-size:1.1rem}'
   +'.dc-so{font-size:.6rem;font-weight:700;background:#fbe3e0;color:#a4261d;padding:4px 9px;border-radius:12px}'
   +'.dc-left{font-size:.6rem;font-weight:700;background:#fbeed5;color:#8a5a0b;padding:3px 8px;border-radius:12px;margin-right:6px}'
   +'.ic-add-row{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--mist-light)}'
   +'.dc-t td.nw,.dc-t td .dc-sub.nw{white-space:nowrap}.dc-rsn{min-width:112px}'
   +'@media(max-width:1180px){.dc-side{display:none}}'
   +'@media(max-width:760px){.dc-sum{grid-template-columns:repeat(2,minmax(0,1fr))}.dc-body{padding:12px}.dc-top{padding:12px}'
   +'.dc-t{min-width:0}.dc-t thead{display:none}.dc-t,.dc-t tbody,.dc-t tr,.dc-t td{display:block;width:auto}'
   +'.dc-t tr{background:#fff;border:1px solid #e3dccf;border-radius:12px;margin:0 0 10px;padding:6px 12px}'
   +'.dc-t td{border:none;padding:6px 0;display:flex;justify-content:space-between;align-items:center;gap:10px;text-align:right!important}'
   +'.dc-t td:first-child{display:block;text-align:left!important;border-bottom:1px solid #eee7da;padding-bottom:8px}'
   +'.dc-t td[data-l]::before{content:attr(data-l);font-size:.62rem;letter-spacing:.6px;text-transform:uppercase;color:#7a7d73;font-weight:700;text-align:left}'
   +'.dc-t td>div{margin-left:auto}.dc-mini{justify-content:flex-end}}';
  document.head.appendChild(st);
}

function _invCntHtml(){
  _invCntCss();
  var today=_invManilaToday(); if(!_invCntDate) _invCntDate=today;
  if(!_invCntShift) _invCntShift='CLOSING';
  var isToday=(_invCntDate===today);
  var who=(currentUser&&(currentUser.displayName||currentUser.username||currentUser.role))||'';
  var h='';
  if(_invCfg.module_enabled!=='true'){
    h+='<div style="background:#fff7e6;border:1px solid #f3d9a4;color:#8a5a0b;border-radius:10px;padding:10px 12px;font-size:.74rem;margin-bottom:10px"><b>Stock Control is OFF.</b> Counts save, but sales won’t deduct and the QR menu won’t show sold out until it’s turned on in ⚙️ Settings.</div>';
  }
  h+='<div class="dc-wrap"><div class="dc-card">';
  h+='<div class="dc-top"><div><h3>Display Count</h3><small>Ready-to-sell items · per menu</small></div>'
    +'<small>'+(who?('Counted by '+_invEsc(who)+' · '):'')+'started '+_invTime(_invCntStarted||new Date())+'</small></div>';
  h+='<div class="dc-body">';
  // tabs + date
  h+='<div class="dc-bar"><div style="display:flex;gap:8px">'
    +[['OPENING','Opening'],['CLOSING','Closing'],['HISTORY','History']].map(function(t){ return '<button class="dc-pill'+(_invCntShift===t[0]?' on':'')+'" onclick="_invCntShiftTab(\''+t[0]+'\')">'+t[1]+'</button>'; }).join('')
    +'</div><div style="display:flex;align-items:center;gap:6px"><span style="font-size:.74rem;color:#6b6f66">Count date</span>'
    +'<button class="dc-nav" onclick="_invCntMove(-1)" aria-label="Previous day">‹</button>'
    +'<input class="dc-date" type="date" value="'+_invCntDate+'" max="'+today+'" onchange="_invCntPick(this.value)" aria-label="Count date">'
    +'<button class="dc-nav" onclick="_invCntMove(1)" '+(isToday?'disabled style="opacity:.4"':'')+' aria-label="Next day">›</button></div></div>';

  if(!_invCntLoaded){ return h+'<div style="padding:30px;text-align:center;color:#6b6f66">Loading…</div></div></div></div>'; }

  if(_invCntShift==='HISTORY'){ h+=_invCntHistoryHtml(); }
  else if(!isToday){
    var done=_invCntHist.filter(function(c){ return _invDayKey(c.counted_at)===_invCntDate; });
    h+='<div class="dc-meta">'+_invDateLong(_invCntDate)+' — past day (read-only). '+(done.length?done.map(function(c){return (c.shift==='OPENING'?'Opening':'Closing')+' count at '+_invTime(c.counted_at)+' by '+_invEsc(c.performed_by_name||'—');}).join(' · '):'No count was submitted this day.')+'</div>';
  } else {
    h+='<div class="dc-meta">Expected = system qty − spoiled. Diff = on display − expected. Only an unexplained diff needs a reason.</div>';
    h+=_invCntTableHtml();
  }
  h+=_invCntSummaryHtml(isToday);
  h+=_invCntLogHtml(isToday);
  if(isToday && _invCntShift!=='HISTORY'){
    h+='<div class="dc-foot"><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="dc-btn r" onclick="_invOpenSpoilage()">+ Record spoilage</button>'
      +'<button class="dc-btn" onclick="_invCntToggleAdd(!_invCntAddOpen)">+ Add item to count</button></div>'
      +'<div style="display:flex;gap:8px;align-items:center">'+(_invCntDraftAt?'<span style="font-size:.66rem;color:#6b6f66">draft '+_invTime(_invCntDraftAt)+'</span>':'')
      +'<button class="dc-btn" onclick="_invCntSaveDraft()">Save draft</button>'
      +'<button id="invCntSubmitBtn" class="dc-btn p" onclick="_invCntSubmit()">Submit '+(_invCntShift==='OPENING'?'opening':'closing')+' count</button></div></div>';
    if(_invCntAddOpen) h+=_invCntAddHtml(_invCntSheet.filter(function(it){return !it.tracked;}));
  }
  h+='</div></div>';
  h+=_invCntPhoneHtml();
  h+='</div>';
  return h;
}
function _invDayKey(ts){ return new Date(new Date(ts).getTime()+8*3600e3).toISOString().slice(0,10); }

function _invCntRowCalc(it){
  var v=_invCntVals[it.item_id]; var sys=_invNum(it.system_qty), sp=_invNum(v.spoiled);
  var exp=sys-sp, diff=Math.round((_invNum(v.counted)-exp)*1000)/1000;
  return {v:v,sys:sys,sp:sp,exp:exp,diff:diff};
}
function _invCntTableHtml(){
  var tracked=_invCntSheet.filter(function(it){return it.tracked;});
  if(!tracked.length){
    return '<div style="background:#fff;border:1px dashed #cfc5b4;border-radius:12px;padding:22px;text-align:center;margin:8px 0">'
      +'<div style="font-weight:700;color:#1f2a22">No items on the count yet</div>'
      +'<div style="font-size:.76rem;color:#6b6f66;margin:4px 0 10px">Tap <b>+ Add item to count</b> below, pick an item and enter how many are on display. It stays on the count every day after.</div></div>';
  }
  var h='<div class="dc-scroll"><table class="dc-t"><thead><tr><th>Item</th><th>Received</th><th>Expiry</th><th style="text-align:center">System</th><th>Spoiled</th><th>On display</th><th style="text-align:center">Diff</th><th>Reason</th></tr></thead><tbody>';
  tracked.forEach(function(it){
    var c=_invCntRowCalc(it), v=c.v, id=it.item_id;
    var dl=_invDaysTo(it.next_expiry);
    var expCell=it.next_expiry?('<b style="color:'+(dl<=0?'#b3261e':(dl<=1?'#9a5b06':'#1f2a22'))+'">'+_invDate(it.next_expiry)+'</b><div class="dc-sub" style="'+(dl<=0?'color:#b3261e':'')+'">'+(dl<0?'expired':(dl===0?'expires today':(dl+' day'+(dl>1?'s':'')+' left')))+'</div>'):'<span class="dc-sub">—</span>';
    var also=(it.menu_names||'').split(' · ').filter(function(n){return n && n!==it.name;});
    var spMini='';
    if(c.sp>0){
      spMini='<div class="dc-mini"><select onchange="_invCntSetV('+id+',\'spoilReason\',this.value)"><option value="">why?</option>'
        +INV_SPOIL_REASONS.map(function(k){return '<option value="'+k+'"'+(v.spoilReason===k?' selected':'')+'>'+INV_REASONS[k]+'</option>';}).join('')+'</select>'
        +'<label>📷 '+(v.photo?'photo ✓':'photo')+'<input type="file" accept="image/*" capture="environment" style="display:none" onchange="_invCntPhoto('+id+',this)"></label></div>';
    }
    var reason;
    if(c.diff<0){
      reason='<select class="dc-rsn" onchange="_invCntSetV('+id+',\'reason\',this.value)"><option value="">Reason…</option>'
        +['MISSING','SPOILED','EXPIRED','DAMAGED','STAFF_MEAL','COMPLIMENTARY'].map(function(k){return '<option value="'+k+'"'+(v.reason===k?' selected':'')+'>'+INV_REASONS[k]+'</option>';}).join('')+'</select>';
    } else if(c.diff>0){ reason='<span class="dc-ok">Found — added back</span>'; }
    else reason='<span class="dc-ok">✓ '+(c.sp>0?'explained':'matches')+'</span>';
    h+='<tr>'
      +'<td><div class="dc-nm">'+_invEsc(it.name)+'</div><div class="dc-sub">'+_invEsc(it.unit)+(it.standard_yield?(' · 1 box = '+_invFmtQty(it.standard_yield)):'')+'</div>'+(also.length?'<span class="dc-also">also: '+_invEsc(also.join(', '))+'</span>':'')+'</td>'
      +'<td class="nw" data-l="Received"><div>'+(it.received_at?_invDay(it.received_at):'—')+'<div class="dc-sub nw">'+_invEsc(it.batch_code||'')+'</div></div></td>'
      +'<td class="nw" data-l="Expiry"><div>'+expCell+'</div></td>'
      +'<td data-l="System" style="text-align:center;font-size:1rem;color:#6b6f66">'+_invFmtQty(c.sys)+'</td>'
      +'<td data-l="Spoiled"><div><div class="dc-step"><button onclick="_invCntSpoil('+id+',-1)" aria-label="Less spoiled">−</button><input type="number" min="0" step="1" value="'+_invFmtQty(c.sp)+'" class="'+(c.sp>0?'sp':'z')+'" onchange="_invCntSpoilSet('+id+',this.value)" aria-label="Spoiled"><button onclick="_invCntSpoil('+id+',1)" aria-label="More spoiled">+</button></div>'+spMini+'</div></td>'
      +'<td data-l="On display"><div class="dc-step"><button onclick="_invCntStep('+id+',-1)" aria-label="Less">−</button><input type="number" min="0" step="1" value="'+_invFmtQty(v.counted)+'" class="'+(_invNum(v.counted)!==c.sys?'chg':'')+'" onchange="_invCntSet('+id+',\'counted\',this.value)" aria-label="On display"><button onclick="_invCntStep('+id+',1)" aria-label="More">+</button></div></td>'
      +'<td data-l="Diff" style="text-align:center;font-weight:700;color:'+(c.diff<0?'#b3261e':'#3b6d11')+'">'+(c.diff>0?'+':'')+_invFmtQty(c.diff)+'</td>'
      +'<td data-l="Reason">'+reason+'</td></tr>';
  });
  return h+'</tbody></table></div>';
}
function _invCntSet(id,k,val){
  var v=_invCntVals[id]; if(!v) return;
  if(k==='counted'){ var n=parseFloat(val); v.counted=(isNaN(n)||n<0)?0:n; v.touched=true; }
  _invRenderTab();
}
function _invCntSetV(id,k,val){ var v=_invCntVals[id]; if(!v) return; v[k]=val; _invRenderTab(); }
function _invCntStep(id,d){ var v=_invCntVals[id]; if(!v) return; v.counted=Math.max(0,_invNum(v.counted)+d); v.touched=true; _invRenderTab(); }
function _invCntSpoilSet(id,val){
  var it=_invCntSheet.filter(function(x){return x.item_id===id;})[0], v=_invCntVals[id]; if(!it||!v) return;
  var before=_invNum(it.system_qty)-_invNum(v.spoiled);
  var n=parseFloat(val); n=(isNaN(n)||n<0)?0:Math.min(n,_invNum(it.system_qty));
  v.spoiled=n;
  if(!v.touched || _invNum(v.counted)===before) v.counted=Math.max(0,_invNum(it.system_qty)-n);   // follow spoiled until staff type their own
  _invRenderTab();
}
function _invCntSpoil(id,d){ var v=_invCntVals[id]; if(!v) return; _invCntSpoilSet(id,_invNum(v.spoiled)+d); }
async function _invCntPhoto(id,input){
  var f=input.files&&input.files[0]; if(!f) return;
  showToast('Uploading photo…','info');
  var url=await _invUploadPhoto(f);
  if(url){ _invCntVals[id].photo=url; showToast('Photo attached','success'); _invRenderTab(); }
}
function _invUploadPhoto(file){
  return new Promise(function(resolve){
    if(file.size>5*1024*1024){ showToast('Photo too large (max 5MB)','error'); return resolve(null); }
    var rd=new FileReader();
    rd.onload=async function(e){
      try{
        var ext=(file.name.split('.').pop()||'jpg').toLowerCase(); if(['jpg','jpeg','png','webp'].indexOf(ext)<0) ext='jpg';
        var resp=await fetch('/api/upload-image',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image:e.target.result,ext:ext,code:'SPOIL_'+Date.now()+'_'+Math.floor(Math.random()*1e4)})});
        var j=await resp.json(); if(!resp.ok||!j.path) throw new Error(j.error||'Upload failed');
        resolve(j.path);
      }catch(err){ showToast('Photo upload failed: '+err.message,'error'); resolve(null); }
    };
    rd.readAsDataURL(file);
  });
}
function _invCntReset(){ _invCntClearDraft(); _invCntResetVals(false); _invRenderTab(); }

async function _invCntSubmit(){
  if(_invCntBusy) return;
  var lines=[], diffs=0, problem=null, spoils=0;
  _invCntSheet.forEach(function(it){
    if(!it.tracked || problem) return;
    var c=_invCntRowCalc(it), v=c.v;
    if(c.sp>0){ spoils++;
      if(!v.spoilReason) problem='Pick why '+it.name+' was spoiled';
      else if(c.sp*_invNum(it.menu_price)>_invPhotoAbove() && !v.photo) problem='Add a photo of the spoiled '+it.name;
    }
    if(Math.abs(c.diff)>1e-9){ diffs++; if(c.diff<0 && !v.reason) problem=problem||('Pick a reason for '+it.name); }
    lines.push({itemId:it.item_id, counted:_invNum(v.counted), seen:c.sys, spoiled:c.sp, spoilReason:v.spoilReason||null, photoUrl:v.photo||null, reason:(c.diff<0?v.reason:null)||null});
  });
  if(problem){ showToast(problem,'error'); return; }
  if(!lines.length){ showToast('Add an item to the count first','error'); return; }
  var label=(_invCntShift==='OPENING'?'opening':'closing');
  if(!confirm('Submit '+label+' count for '+lines.length+' item'+(lines.length>1?'s':'')+'?'+(spoils?('\n'+spoils+' with spoilage.'):'')+(diffs?('\n'+diffs+' with a difference.'):'')+((!spoils&&!diffs)?'\nEverything matches.':''))) return;
  _invCntBusy=true; var b=document.getElementById('invCntSubmitBtn'); if(b){ b.disabled=true; b.textContent='Saving…'; }
  var r=await api('invSubmitCount',{lines:lines, shift:_invCntShift});
  _invCntBusy=false;
  if(r&&r.ok){ _invCntClearDraft(); showToast((_invCntShift==='OPENING'?'Opening':'Closing')+' count saved','success'); await _invCntLoad(); }
  else { showToast((r&&r.error)||'Count failed','error'); if(r&&r.stock_changed) await _invCntLoad(); else if(b){ b.disabled=false; b.textContent='Submit '+label+' count'; } }
}

function _invCntSummaryHtml(isToday){
  var spN=0, spV=0, miN=0, miV=0;
  _invCntLog.forEach(function(r){
    var isSpoil=(r.kind==='SPOILAGE') || (r.kind==='COUNT' && INV_SPOIL_REASONS.indexOf(r.reason)>=0);
    var countable=['g','ml','kg','L'].indexOf(r.unit)<0;
    if(isSpoil){ if(countable) spN+=Math.abs(_invNum(r.qty)); spV+=_invNum(r.value_menu); }
    if(r.reason==='MISSING'){ if(countable) miN+=Math.abs(_invNum(r.qty)); miV+=_invNum(r.value_menu); }
  });
  var tracked=_invCntSheet.filter(function(it){return it.tracked;});
  var counted=tracked.length, soon=0, soldOut=0;
  if(isToday && _invCntShift!=='HISTORY'){
    tracked.forEach(function(it){ var c=_invCntRowCalc(it);
      spN+=c.sp; spV+=c.sp*_invNum(it.menu_price);
      if(c.diff<0 && c.v.reason==='MISSING'){ miN+=-c.diff; miV+=(-c.diff)*_invNum(it.menu_price); }
      var dl=_invDaysTo(it.next_expiry); if(it.next_expiry && dl<=1) soon++;
      if(_invNum(c.v.counted)<=0) soldOut++; });
  } else { counted=(_invCntLog.filter(function(r){return r.kind==='COUNT';}).map(function(r){return r.item_id;}).filter(function(x,i,a){return a.indexOf(x)===i;})).length; }
  var sc=function(b,l,c){ return '<div class="dc-sc"><b style="color:'+(c||'#1f2a22')+'">'+b+'</b><span>'+l+'</span></div>'; };
  return '<div class="dc-sum">'
    +sc(counted,'items counted')
    +sc(_invFmtQty(spN)+' · '+_invPeso(spV),'spoiled '+(isToday?'today':'this day')+' (at menu price)', spN?'#8a2a22':null)
    +sc(_invFmtQty(miN)+' · '+_invPeso(miV),'unexplained / missing', miN?'#b3261e':null)
    +sc(isToday?soon:'—','expire within 1 day', soon?'#9a5b06':null)
    +sc(isToday?soldOut:'—','now sold out on QR menu', soldOut?'#b3261e':null)
  +'</div>';
}

function _invCntLogHtml(isToday){
  var rows=_invCntLog.filter(function(r){ return !(r.kind==='COUNT' && r.reason==='COUNTED'); });
  var tagc={SPOILED:'#efe3f7;color:#5b2a86',EXPIRED:'#fbe3e0;color:#a4261d',DAMAGED:'#fbeed5;color:#8a5a0b',STAFF_MEAL:'#e6f0f7;color:#185fa5',COMPLIMENTARY:'#e6f0f7;color:#185fa5',MISSING:'#fbe3e0;color:#a4261d',FOUND:'#e6f0da;color:#3b6d11'};
  var h='<div class="dc-h4"><span>Spoilage log · '+_invDateLong(_invCntDate)+'</span><small>Every spoiled item removes stock and is logged — not just edited</small></div>';
  if(!rows.length) h+='<div style="font-size:.76rem;color:#6b6f66;background:#fff;border:1px solid #e3dccf;border-radius:10px;padding:12px">No spoilage or count differences '+(isToday?'yet today':'on this day')+'.</div>';
  else {
    h+='<div class="dc-scroll"><table class="dc-log"><thead><tr><th>Time</th><th>Item</th><th>Batch</th><th style="text-align:right">Qty</th><th>Reason</th><th>Note</th><th>Photo</th><th>By</th><th>Status</th></tr></thead><tbody>';
    rows.forEach(function(r){
      var q=_invNum(r.qty), st;
      if(r.reason==='MISSING') st='<span class="dc-tag" style="background:#fbe3e0;color:#a4261d">Unexplained</span>';
      else if(r.reason==='FOUND') st='<span class="dc-tag" style="background:#e6f0da;color:#3b6d11">Added back</span>';
      else if(r.needs_approval) st=(_invIsOwner()?'<button onclick="_invApproveSpoil('+r.txn_id+')" style="font-size:.66rem;font-weight:700;border:1px solid #e0c48f;background:#fbeed5;color:#8a5a0b;border-radius:10px;padding:3px 9px;cursor:pointer">Approve</button>':'<span class="dc-tag" style="background:#fbeed5;color:#8a5a0b">Needs approval</span>');
      else if(r.approved_by_name) st='<span class="dc-tag" style="background:#e6f0da;color:#3b6d11">Approved · '+_invEsc(r.approved_by_name)+'</span>';
      else st='<span class="dc-tag" style="background:#eef0ec;color:#5f5e5a">Recorded</span>';
      h+='<tr><td style="white-space:nowrap">'+_invTime(r.performed_at)+'</td><td>'+_invEsc(r.item_name)+'</td><td style="color:#6b6f66">'+_invEsc(r.batch_code||'')+'</td>'
        +'<td style="text-align:right;white-space:nowrap">'+_invFmtQty(Math.abs(q))+' '+_invEsc(r.unit)+((Math.abs(q)===1||['g','ml','kg','L'].indexOf(r.unit)>=0)?'':'s')+'</td>'
        +'<td><span class="dc-tag" style="background:'+(tagc[r.reason]||'#eee;color:#555')+'">'+_invEsc(INV_REASONS[r.reason]||r.reason||'Waste')+'</span></td>'
        +'<td style="color:#6b6f66">'+_invEsc(r.notes||'')+'</td>'
        +'<td>'+(r.photo_url?'<a href="'+_invEsc(r.photo_url)+'" target="_blank" rel="noopener" style="color:var(--forest)">view</a>':'—')+'</td>'
        +'<td>'+_invEsc(r.performed_by_name||r.performed_by||'')+'</td><td>'+st+'</td></tr>';
    });
    h+='</tbody></table></div>';
  }
  h+='<div style="font-size:.66rem;color:#6b6f66;margin-top:6px">Reasons: Spoiled · Expired · Damaged · Staff meal · Complimentary · Missing. Photo required above '+_invPeso(_invPhotoAbove())+'; owner approval above '+_invPeso(_invApprovalAbove())+'.</div>';
  return h;
}
async function _invApproveSpoil(id){
  var r=await api('invApproveSpoilage',{txnId:id});
  if(r&&r.ok){ showToast('Approved','success'); await _invCntLoad(); } else showToast((r&&r.error)||'Failed','error');
}

function _invCntHistoryHtml(){
  if(!_invCntHist.length) return '<div style="font-size:.78rem;color:#6b6f66;background:#fff;border:1px solid #e3dccf;border-radius:10px;padding:14px;margin:6px 0">No counts in the last 30 days.</div>';
  var h='<div class="dc-scroll"><table class="dc-log"><thead><tr><th>Date</th><th>Count</th><th>Time</th><th>By</th><th style="text-align:right">Items</th><th style="text-align:right">Differences</th><th style="text-align:right">Spoiled</th><th style="text-align:right">Missing</th><th></th></tr></thead><tbody>';
  _invCntHist.forEach(function(c){
    var d=_invDayKey(c.counted_at);
    h+='<tr><td>'+_invDateLong(d)+'</td><td>'+(c.shift==='OPENING'?'Opening':'Closing')+'</td><td>'+_invTime(c.counted_at)+'</td><td>'+_invEsc(c.performed_by_name||'—')+'</td>'
      +'<td style="text-align:right">'+c.items+'</td><td style="text-align:right">'+c.differences+'</td>'
      +'<td style="text-align:right;color:'+(_invNum(c.spoiled_value)?'#8a2a22':'inherit')+'">'+_invPeso(c.spoiled_value)+'</td>'
      +'<td style="text-align:right;color:'+(_invNum(c.missing_value)?'#b3261e':'inherit')+'">'+_invPeso(c.missing_value)+'</td>'
      +'<td><button onclick="_invCntShift=\'CLOSING\';_invCntPick(\''+d+'\')" style="font-size:.7rem;border:none;background:none;color:var(--forest);font-weight:700;cursor:pointer">Open day ›</button></td></tr>';
  });
  return h+'</tbody></table></div>';
}

// What customers see right now on the QR menu (tracked items)
function _invCntPhoneHtml(){
  var tracked=_invCntSheet.filter(function(it){return it.tracked;});
  var h='<div class="dc-side"><div style="font-size:.66rem;letter-spacing:.6px;color:#6b6f66;font-weight:700;margin:0 0 6px 6px">CUSTOMER · QR MENU</div><div class="dc-phone"><div class="dc-scr">'
    +'<div class="dc-ph"><b>Yani Garden Café</b><small>'+_invDateLong(_invManilaToday())+'</small></div>';
  if(!tracked.length) h+='<div style="padding:16px;font-size:.72rem;color:#6b6f66">Items you count appear here the way customers see them.</div>';
  tracked.forEach(function(it){
    var left=Math.floor(_invNum(it.system_qty)), nm=(it.menu_names||it.name).split(' · ')[0];
    h+='<div class="dc-it" style="'+(left<=0?'opacity:.55':'')+'"><div><div class="t">'+_invEsc(nm)+'</div><div class="p">'+(it.menu_price?_invPeso(it.menu_price):'')+'</div></div>'
      +(left<=0?'<span class="dc-so">SOLD OUT</span>':(left<=3?'<div style="display:flex;align-items:center"><span class="dc-left">'+left+' left</span><div class="dc-add">+</div></div>':'<div class="dc-add">+</div>'))+'</div>';
  });
  h+='<div style="font-size:.64rem;color:#6b6f66;padding:6px 14px 16px;line-height:1.5">Live: updates after every sale, spoilage and submitted count. Sold-out items can’t be ordered.</div></div></div></div>';
  return h;
}

// Add an item to the count (first count = opening stock)
function _invCntToggleAdd(on){ _invCntAddOpen=!!on; if(!on) _invCntAddQ=''; _invRenderTab(); if(on) setTimeout(function(){ var s=document.getElementById('icAddSearch'); if(s){ s.focus(); s.scrollIntoView({block:'center'}); } },30); }
function _invCntAddKey(it){ return it.menu_code || ('I'+it.item_id); }
function _invCntAddHtml(untracked){
  var q=String(_invCntAddQ||'').toLowerCase().split(/\s+/).filter(Boolean);
  var list=untracked.filter(function(it){ var t=(it.name+' '+(it.menu_names||'')+' '+(it.category||'')).toLowerCase(); return q.every(function(k){return t.indexOf(k)>=0;}); });
  var entered=Object.keys(_invCntAddQty).filter(function(k){ return _invNum(_invCntAddQty[k])>0; }).length;
  var h='<div style="background:#fff;border:1.5px solid var(--forest);border-radius:12px;margin:12px 0 4px;overflow:hidden">'
    +'<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:12px 14px;background:#f3f7ef;flex-wrap:wrap">'
      +'<div><div style="font-weight:800;color:var(--forest-deep);font-size:.9rem">Add menu items to the count <span style="font-weight:600;color:var(--timber);font-size:.72rem">· '+untracked.length+' not counted yet</span></div>'
      +'<div style="font-size:.68rem;color:var(--timber)">Every menu item except Best With sets. Type how many are on display now, then Add. Blank = skip.</div></div>'
      +'<div style="display:flex;gap:8px;align-items:center"><button id="icAddAllBtn" onclick="_invCntAddAll()" style="font-size:.76rem;font-weight:800;background:var(--forest);color:#fff;border:none;border-radius:10px;padding:9px 14px;cursor:pointer">Add all entered'+(entered?(' ('+entered+')'):'')+'</button>'
      +'<button onclick="_invCntToggleAdd(false)" style="border:none;background:none;font-size:1.2rem;color:var(--timber);cursor:pointer" aria-label="Close">✕</button></div></div>'
    +'<div style="padding:10px 14px;border-bottom:1px solid var(--mist-light)"><input id="icAddSearch" type="text" placeholder="🔍 Search, e.g. buco, latte, beans, pastry" value="'+_invEsc(_invCntAddQ)+'" oninput="_invCntAddSearch(this.value)" style="width:100%;box-sizing:border-box;font-size:.86rem;padding:10px 12px;border:1.5px solid var(--mist);border-radius:10px"></div>'
    +'<div id="icAddList" style="max-height:56vh;overflow:auto">';
  if(!list.length) h+='<div style="padding:16px;font-size:.76rem;color:var(--timber);text-align:center">'+(untracked.length?'No match.':'Every menu item is already on the count.')+'</div>';
  var lastCat=null;
  list.forEach(function(it){
    var key=_invCntAddKey(it), qv=_invCntAddQty[key]; qv=(qv==null?'':qv);
    if((it.category||'OTHER')!==lastCat){ lastCat=it.category||'OTHER'; h+='<div style="padding:7px 14px;background:#faf7f1;font-size:.62rem;font-weight:800;letter-spacing:.6px;color:var(--timber);text-transform:uppercase;border-bottom:1px solid var(--mist-light)">'+_invEsc(lastCat)+'</div>'; }
    h+='<div class="ic-add-row"><div style="flex:1;min-width:0"><div style="font-weight:700;color:var(--forest-deep);font-size:.84rem">'+_invEsc(it.menu_names||it.name)+'</div>'
        +'<div style="font-size:.64rem;color:var(--timber)">'+(it.menu_price?_invPeso(it.menu_price)+' · ':'')+'count in '+_invEsc(it.unit)+'s'+(it.unit==='slice'&&it.standard_yield?(' (1 box = '+_invFmtQty(it.standard_yield)+')'):'')+'</div></div>'
      +'<input type="number" inputmode="numeric" min="0" step="1" placeholder="qty" value="'+_invEsc(qv)+'" oninput="_invCntAddQty[\''+key+'\']=this.value;_invCntAddCount()" onkeydown="if(event.key===\'Enter\')_invCntStartKey(\''+key+'\')" style="width:70px;height:38px;text-align:center;font-weight:800;font-size:.95rem;border:1.5px solid var(--mist);border-radius:10px">'
      +'<button onclick="_invCntStartKey(\''+key+'\')" style="height:38px;font-size:.78rem;font-weight:800;background:#fff;color:var(--forest);border:1.5px solid var(--forest);border-radius:10px;padding:0 14px;cursor:pointer">Add</button></div>';
  });
  return h+'</div></div>';
}
function _invCntAddCount(){ var b=document.getElementById('icAddAllBtn'); if(!b) return; var n=Object.keys(_invCntAddQty).filter(function(k){ return _invNum(_invCntAddQty[k])>0; }).length; b.textContent='Add all entered'+(n?(' ('+n+')'):''); }
function _invCntAddSearch(v){
  _invCntAddQ=v;
  var tmp=document.createElement('div'); tmp.innerHTML=_invCntAddHtml(_invCntSheet.filter(function(it){return !it.tracked;}));
  var nl=tmp.querySelector('#icAddList'), ol=document.getElementById('icAddList');
  if(nl&&ol) ol.innerHTML=nl.innerHTML;
}
function _invCntFindKey(key){ return _invCntSheet.filter(function(x){ return !x.tracked && _invCntAddKey(x)===key; })[0]; }
async function _invCntStartOne(key){
  var it=_invCntFindKey(key); if(!it) return {ok:false,error:'Not found'};
  var q=parseFloat(_invCntAddQty[key]);
  if(!(q>0)) return {ok:false,error:'Enter how many '+(it.menu_names||it.name)+' are on display'};
  var shift=(_invCntShift==='OPENING'?'OPENING':'CLOSING');
  var r = it.menu_code ? await api('invStartMenuCount',{menuCode:it.menu_code, qty:q, shift:shift})
                       : await api('invSubmitCount',{lines:[{itemId:it.item_id,counted:q,seen:null}], shift:shift});
  if(r&&r.ok) delete _invCntAddQty[key];
  return r||{ok:false,error:'Failed'};
}
async function _invCntStartKey(key){
  var r=await _invCntStartOne(key);
  if(r.ok){ showToast('Added to the count','success'); await _invCntLoad(); } else showToast(r.error||'Failed','error');
}
async function _invCntAddAll(){
  var keys=Object.keys(_invCntAddQty).filter(function(k){ return _invNum(_invCntAddQty[k])>0; });
  if(!keys.length){ showToast('Type a quantity for the items you want to add','error'); return; }
  var b=document.getElementById('icAddAllBtn'); if(b){ b.disabled=true; b.textContent='Adding…'; }
  var ok=0, fails=[];
  for(var i=0;i<keys.length;i++){ var r=await _invCntStartOne(keys[i]); if(r.ok) ok++; else fails.push(r.error); }
  showToast(ok+' added'+(fails.length?(' · '+fails.length+' failed: '+fails[0]):''), fails.length?'error':'success');
  await _invCntLoad();
}

// Record spoilage any time (not only during the count)
async function _invOpenSpoilage(){
  var tracked=_invCntSheet.filter(function(it){return it.tracked;});
  if(!tracked.length){ showToast('Add an item to the count first — spoilage needs stock','error'); return; }
  var opts='<option value="">Pick item…</option>'+tracked.map(function(it){ return '<option value="'+it.item_id+'">'+_invEsc(it.name)+' — '+_invFmtQty(it.system_qty)+' '+_invEsc(it.unit)+' left</option>'; }).join('');
  var ropts=INV_SPOIL_REASONS.map(function(k){ return '<option value="'+k+'">'+INV_REASONS[k]+'</option>'; }).join('');
  var body=_invField('Item',_invSelect('spItem',opts))
    +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'
      +'<div>'+_invField('Quantity',_invInput('spQty','number','1','1'))+'</div>'
      +'<div>'+_invField('Reason',_invSelect('spReason','<option value="">Pick…</option>'+ropts))+'</div></div>'
    +_invField('Note',_invInput('spNote','text','e.g. dropped while plating'))
    +_invField('Photo','<input id="spPhoto" type="file" accept="image/*" capture="environment" style="width:100%;margin-top:3px;font-size:.8rem">')
    +'<div style="font-size:.66rem;color:var(--timber);margin-top:8px">Photo required above '+_invPeso(_invPhotoAbove())+'. Above '+_invPeso(_invApprovalAbove())+' it waits for owner approval. Stock goes down right away.</div>';
  _invModal('Record Spoilage', body, 'Record spoilage', async function(){
    var id=+(document.getElementById('spItem')||{}).value, qty=parseFloat((document.getElementById('spQty')||{}).value), reason=(document.getElementById('spReason')||{}).value, note=(document.getElementById('spNote')||{}).value||'';
    var file=(document.getElementById('spPhoto')||{}).files; file=file&&file[0];
    if(!id){ showToast('Pick an item','error'); return; }
    if(!(qty>0)){ showToast('Enter a quantity','error'); return; }
    if(!reason){ showToast('Pick a reason','error'); return; }
    var it=tracked.filter(function(x){return x.item_id===id;})[0];
    if(it && qty*_invNum(it.menu_price)>_invPhotoAbove() && !file){ showToast('Add a photo — worth '+_invPeso(qty*_invNum(it.menu_price)),'error'); return; }
    var btn=document.getElementById('invModalSubmit'); if(btn){ btn.disabled=true; btn.textContent='Saving…'; }
    var photo=null; if(file){ photo=await _invUploadPhoto(file); if(!photo){ if(btn){ btn.disabled=false; btn.textContent='Record spoilage'; } return; } }
    var r=await api('invRecordSpoilage',{itemId:id,qty:qty,reason:reason,notes:note,photoUrl:photo});
    if(r&&r.ok){ showToast('Spoilage recorded · '+_invFmtQty(r.remaining)+' left','success'); _invCloseModal(); _invCntDate=_invManilaToday(); await _invCntLoad(); await _invLoadStock(); }
    else { showToast((r&&r.error)||'Failed','error'); if(btn){ btn.disabled=false; btn.textContent='Record spoilage'; } }
  });
}
