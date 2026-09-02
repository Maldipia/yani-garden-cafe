// ══════════════════════════════════════════════════════════════════════════
// admin-inventory.js — YANI Inventory (Stock Control) UI
// Phase: Settings + Items only. Module stays OFF. Never touches orders.js.
// All writes go UI -> api() -> inv_* handler -> inv_* tables (verified).
// ══════════════════════════════════════════════════════════════════════════

var _invCfg   = {};      // key -> value
var _invRef   = { units: [], locations: [], suppliers: [], itemTypes: [] };
var _invItems = [];
var _invTab   = 'settings';
var _invItemFilter = 'ALL';
var _invLoading = false;

function _invIsOwner() { return currentUser && currentUser.role === 'OWNER'; }
function _invIsAdmin() { return currentUser && (currentUser.role === 'OWNER' || currentUser.role === 'ADMIN'); }
function _invEsc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }

var INV_TYPE_META = {
  RAW_MATERIAL:    { label:'Raw Material',        ico:'🌾', blurb:'Flour, milk, sugar, coffee — consumed in recipes. Partial use allowed.' },
  PURCHASED_READY: { label:'Purchased Ready-to-Sell', ico:'📦', blurb:'Croissants, bottled drinks, supplier cakes — sold as-is. No recipe.' },
  PREP:            { label:'Prep / Sub-Recipe',   ico:'🥣', blurb:'Sauces, creams, fillings — made in batches, used by other recipes.' },
  PRODUCED:        { label:'Produced',            ico:'🎂', blurb:'YANI-made cakes, brownies, cookies — made from ingredients.' },
  PORTIONABLE:     { label:'Portionable',         ico:'🍰', blurb:'Sold whole OR cut into portions (e.g. cake → slices).' },
};

// ── ENTRY ──────────────────────────────────────────────────────────────────
async function initInventory() {
  var v = document.getElementById('inventoryView');
  if (!v) return;
  if (!_invIsAdmin()) {
    v.innerHTML = '<div style="padding:40px;text-align:center;color:var(--timber)">Inventory is available to ADMIN and OWNER only.</div>';
    return;
  }
  v.innerHTML = '<div style="padding:32px;text-align:center;color:var(--timber)">Loading inventory…</div>';
  await _invLoadAll();
  _invRender();
}

async function _invLoadAll() {
  _invLoading = true;
  try {
    var cfg = await api('invGetConfig', {});
    _invCfg = (cfg && cfg.ok) ? (cfg.config || {}) : {};
    var ref = await api('invGetRefData', {});
    if (ref && ref.ok) _invRef = { units: ref.units||[], locations: ref.locations||[], suppliers: ref.suppliers||[], itemTypes: ref.itemTypes||[] };
    await _invLoadItems();
  } catch(e) {}
  _invLoading = false;
}

async function _invLoadItems() {
  var body = { activeOnly: true };
  if (_invItemFilter !== 'ALL') body.itemType = _invItemFilter;
  var r = await api('invListItems', body);
  _invItems = (r && r.ok) ? (r.items || r.data || []) : [];
}

// ── SHELL ──────────────────────────────────────────────────────────────────
function _invRender() {
  var v = document.getElementById('inventoryView'); if (!v) return;
  var enabled = (_invCfg.module_enabled === 'true');
  var h = '';
  h += '<div style="max-width:1100px;margin:0 auto;padding:16px 16px 60px">';

  // header + module status banner
  h += '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:6px">';
  h += '<div><h2 style="margin:0;color:var(--forest-deep);font-size:1.3rem">🏬 Stock Control <span style="font-size:.6rem;background:var(--gold);color:#fff;padding:2px 7px;border-radius:10px;vertical-align:middle;letter-spacing:.5px">NEW</span></h2>';
  h += '<div style="font-size:.72rem;color:var(--timber);margin-top:2px">Isolated inventory & production module — currently in setup.</div></div>';
  h += '<div style="font-size:.72rem;font-weight:700;padding:6px 12px;border-radius:20px;'
     + (enabled ? 'background:#fde8e8;color:#b91c1c' : 'background:var(--mist-light);color:var(--forest)')
     + '">'+(enabled ? '● LIVE' : '○ MODULE OFF (safe)')+'</div>';
  h += '</div>';

  // tabs
  h += '<div style="display:flex;gap:6px;border-bottom:2px solid var(--mist-light);margin:12px 0 16px">';
  [['settings','⚙️ Settings'],['items','🏷️ Items']].forEach(function(t){
    var on = _invTab===t[0];
    h += '<button onclick="_invSetTab(\''+t[0]+'\')" style="background:none;border:none;cursor:pointer;padding:8px 14px;font-size:.82rem;font-weight:700;'
       + (on ? 'color:var(--forest-deep);border-bottom:3px solid var(--gold);margin-bottom:-2px' : 'color:var(--timber)')+'">'+t[1]+'</button>';
  });
  h += '</div>';

  h += '<div id="invTabBody"></div>';
  h += '</div>';
  v.innerHTML = h;
  _invRenderTab();
}

function _invSetTab(t){ _invTab = t; _invRenderTab();
  document.querySelectorAll('#inventoryView button').forEach(function(){});
  _invRender();
}
function _invRenderTab(){
  var b = document.getElementById('invTabBody'); if(!b) return;
  b.innerHTML = (_invTab==='settings') ? _invSettingsHtml() : _invItemsHtml();
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
