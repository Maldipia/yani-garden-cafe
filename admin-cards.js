// ══════════════════════════════════════════════════════════════
// YANI CARDS — Admin Tab  v7
// Search · Toggle · Manage (Edit + Top Up) · QR · Print
// ══════════════════════════════════════════════════════════════

var _cardsAll    = [];
var _cardsFilter = 'ALL';
var _cardsSearch = '';
var _manageCardNumber = '';

// ── Entry point ───────────────────────────────────────────────
async function loadYaniCardsView() {
  var view = document.getElementById('yaniCardsView');
  if (!view) return;
  if (currentUser.role !== 'OWNER') {
    view.innerHTML = '<div style="padding:60px;text-align:center;color:var(--timber)">🔒 Owner access only</div>';
    return;
  }
  view.innerHTML = _cardsShell();
  _appendCardModals();
  await _cardsFetch();
}

// ── Fetch ─────────────────────────────────────────────────────
async function _cardsFetch() {
  var loading = document.getElementById('cardsLoading');
  var wrap    = document.getElementById('cardsTableWrap');
  if (loading) loading.style.display = 'block';
  if (wrap)    wrap.innerHTML = '';
  try {
    var r = await _cardApi('listCards', { pin: '2026' });
    if (!r.ok) throw new Error(r.error || 'Failed');
    _cardsAll = r.cards || [];
    _cardsRender();
  } catch(e) {
    if (wrap) wrap.innerHTML = '<div style="padding:40px;text-align:center;color:#B5443A">❌ ' + e.message + '</div>';
  } finally {
    if (loading) loading.style.display = 'none';
  }
}

// ── Shell (no modals — appended separately) ───────────────────
function _cardsShell() {
  return '<div style="padding:18px 20px 0">'
    + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">'
    + '<h2 style="font-size:1.15rem;font-weight:800;color:var(--forest-deep);margin:0">💳 Yani Cards</h2>'
    + '<div style="display:flex;gap:8px">'
    + '<button onclick="openPrintAllSheet()" style="background:var(--terra);color:#fff;border:none;border-radius:8px;padding:8px 14px;font-size:.78rem;font-weight:700;cursor:pointer">🖨️ Print All QR</button>'
    + '<button onclick="_cardsFetch()" style="background:var(--mist-light);border:none;border-radius:8px;padding:8px 14px;font-size:.78rem;font-weight:700;cursor:pointer;color:var(--timber)">🔄 Refresh</button>'
    + '</div></div>'
    + '<div id="cardsStats" style="display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-bottom:14px"></div>'
    + '<div style="display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap;align-items:center">'
    + '<div style="position:relative;flex:1;min-width:180px">'
    + '<span style="position:absolute;left:10px;top:50%;transform:translateY(-50%);pointer-events:none">🔍</span>'
    + '<input id="cardsSearchInput" type="text" placeholder="Search card #, name, phone…" oninput="_cardsOnSearch(this.value)" '
    + 'style="width:100%;padding:9px 12px 9px 32px;border:1.5px solid var(--mist);border-radius:8px;font-size:.82rem;font-family:var(--font-body);box-sizing:border-box">'
    + '</div>'
    + '<div id="cardsFilterBtns" style="display:flex;gap:6px;flex-wrap:wrap"></div>'
    + '</div>'
    + '<div id="cardsLoading" style="padding:30px;text-align:center;color:var(--timber)">Loading cards…</div>'
    + '</div>'
    + '<div id="cardsTableWrap" style="padding:0 20px 100px;overflow-x:auto"></div>';
}

// ── Modals appended to body (separate from shell) ─────────────
function _appendCardModals() {
  // Remove existing modals to avoid duplicates on re-render
  ['cardManageModal','cardQRModal','cardTxnModal'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.remove();
  });

  // ── MANAGE MODAL (Edit + Top Up + Activate) ──────────────
  var m = document.createElement('div');
  m.id = 'cardManageModal';
  m.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9000;align-items:center;justify-content:center;padding:20px';
  m.innerHTML = ''
    + '<div style="background:#fff;border-radius:16px;width:100%;max-width:420px;max-height:90vh;overflow-y:auto;padding:24px">'
    + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">'
    + '<h3 id="manageCardTitle" style="font-size:1rem;font-weight:800;color:var(--forest-deep);margin:0"></h3>'
    + '<button onclick="_closeManageModal()" style="background:var(--mist-light);border:none;border-radius:8px;padding:6px 12px;cursor:pointer">✕</button>'
    + '</div>'

    // Card status badge
    + '<div id="manageCardInfo" style="background:var(--mist-light);border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:.82rem;display:flex;justify-content:space-between;align-items:center">'
    + '<div><span id="manageCardBal" style="font-size:1.1rem;font-weight:800;color:var(--forest-deep)"></span><span style="color:var(--timber);font-size:.75rem;margin-left:6px">balance</span></div>'
    + '<span id="manageCardStatus" style="border-radius:10px;padding:3px 10px;font-size:.72rem;font-weight:700;color:#fff"></span>'
    + '</div>'

    // ── SECTION: Top Up ──────────────────────────────────────
    + '<div id="manageTopUpSection">'
    + '<div style="font-size:.8rem;font-weight:700;color:var(--timber);margin-bottom:8px;text-transform:uppercase;letter-spacing:.4px">💰 Top Up (Add Balance)</div>'
    + '<div style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap">'
    + '<button onclick="document.getElementById(\'manageTopUpAmt\').value=100" style="flex:1;min-width:60px;padding:7px;background:var(--mist-light);border:1.5px solid var(--mist);border-radius:6px;font-size:.8rem;font-weight:700;cursor:pointer">₱100</button>'
    + '<button onclick="document.getElementById(\'manageTopUpAmt\').value=200" style="flex:1;min-width:60px;padding:7px;background:var(--mist-light);border:1.5px solid var(--mist);border-radius:6px;font-size:.8rem;font-weight:700;cursor:pointer">₱200</button>'
    + '<button onclick="document.getElementById(\'manageTopUpAmt\').value=500" style="flex:1;min-width:60px;padding:7px;background:var(--forest);color:#fff;border:none;border-radius:6px;font-size:.8rem;font-weight:700;cursor:pointer">₱500</button>'
    + '<button onclick="document.getElementById(\'manageTopUpAmt\').value=1000" style="flex:1;min-width:60px;padding:7px;background:var(--forest);color:#fff;border:none;border-radius:6px;font-size:.8rem;font-weight:700;cursor:pointer">₱1000</button>'
    + '</div>'
    + '<div style="display:flex;gap:8px;margin-bottom:16px">'
    + '<input id="manageTopUpAmt" type="number" min="50" step="50" placeholder="Or type custom amount…" '
    + 'style="flex:1;padding:9px 12px;border:1.5px solid var(--mist);border-radius:8px;font-size:.9rem;font-family:var(--font-body)">'
    + '<button onclick="_submitTopUp()" style="padding:9px 18px;background:#1D4ED8;color:#fff;border:none;border-radius:8px;font-size:.82rem;font-weight:700;cursor:pointer">Add</button>'
    + '</div>'
    + '</div>'

    // ── SECTION: Edit Holder ─────────────────────────────────
    + '<div style="border-top:1px solid var(--mist);padding-top:14px;margin-top:2px">'
    + '<div style="font-size:.8rem;font-weight:700;color:var(--timber);margin-bottom:10px;text-transform:uppercase;letter-spacing:.4px">✏️ Card Holder Info</div>'
    + '<label style="font-size:.72rem;font-weight:700;color:var(--timber);display:block;margin-bottom:3px">FULL NAME</label>'
    + '<input id="manageHolderName" type="text" placeholder="e.g. Maria Santos" '
    + 'style="width:100%;padding:9px 12px;border:1.5px solid var(--mist);border-radius:8px;font-size:.88rem;font-family:var(--font-body);box-sizing:border-box;margin-bottom:8px">'
    + '<label style="font-size:.72rem;font-weight:700;color:var(--timber);display:block;margin-bottom:3px">PHONE</label>'
    + '<input id="manageHolderPhone" type="tel" placeholder="e.g. 09171234567" '
    + 'style="width:100%;padding:9px 12px;border:1.5px solid var(--mist);border-radius:8px;font-size:.88rem;font-family:var(--font-body);box-sizing:border-box;margin-bottom:8px">'
    + '<label style="font-size:.72rem;font-weight:700;color:var(--timber);display:block;margin-bottom:3px">EMAIL <span style="font-weight:400;color:#9CA3AF">(optional)</span></label>'
    + '<input id="manageHolderEmail" type="email" placeholder="e.g. maria@email.com" '
    + 'style="width:100%;padding:9px 12px;border:1.5px solid var(--mist);border-radius:8px;font-size:.88rem;font-family:var(--font-body);box-sizing:border-box;margin-bottom:14px">'
    + '<div style="display:flex;gap:8px">'
    + '<button onclick="_closeManageModal()" style="flex:1;padding:10px;background:var(--mist-light);border:none;border-radius:8px;font-size:.82rem;font-weight:700;cursor:pointer;color:var(--timber)">Cancel</button>'
    + '<button onclick="_submitEditHolder()" style="flex:1;padding:10px;background:var(--forest);color:#fff;border:none;border-radius:8px;font-size:.82rem;font-weight:700;cursor:pointer">Save Info</button>'
    + '</div>'
    + '</div>'
    + '</div>';
  document.body.appendChild(m);

  // ── QR MODAL ────────────────────────────────────────────────
  var q = document.createElement('div');
  q.id = 'cardQRModal';
  q.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9001;align-items:center;justify-content:center;padding:20px';
  q.innerHTML = '<div style="background:#fff;border-radius:16px;width:100%;max-width:380px;padding:28px;text-align:center">'
    + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">'
    + '<h3 id="qrModalTitle" style="font-size:1rem;font-weight:800;color:var(--forest-deep);margin:0"></h3>'
    + '<button onclick="document.getElementById(\'cardQRModal\').style.display=\'none\'" style="background:var(--mist-light);border:none;border-radius:8px;padding:6px 12px;font-size:.8rem;cursor:pointer">✕</button>'
    + '</div>'
    + '<div id="qrModalContent"></div>'
    + '<div style="display:flex;gap:8px;margin-top:16px">'
    + '<button onclick="_printSingleCard()" style="flex:1;padding:10px;background:var(--forest);color:#fff;border:none;border-radius:8px;font-size:.82rem;font-weight:700;cursor:pointer">🖨️ Print Card</button>'
    + '<button onclick="document.getElementById(\'cardQRModal\').style.display=\'none\'" style="flex:1;padding:10px;background:var(--mist-light);border:none;border-radius:8px;font-size:.82rem;font-weight:700;cursor:pointer;color:var(--timber)">Close</button>'
    + '</div></div>';
  document.body.appendChild(q);

  // ── TXN MODAL ───────────────────────────────────────────────
  var t = document.createElement('div');
  t.id = 'cardTxnModal';
  t.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9001;overflow-y:auto;padding:20px';
  t.innerHTML = '<div style="background:#fff;border-radius:16px;max-width:760px;margin:0 auto;padding:24px">'
    + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">'
    + '<h3 id="cardTxnTitle" style="font-size:1rem;font-weight:800;color:var(--forest-deep);margin:0"></h3>'
    + '<button onclick="document.getElementById(\'cardTxnModal\').style.display=\'none\'" style="background:var(--mist-light);border:none;border-radius:8px;padding:6px 14px;font-size:.8rem;cursor:pointer">✕ Close</button>'
    + '</div><div id="cardTxnBody">Loading…</div></div>';
  document.body.appendChild(t);
}

// ── Render table ──────────────────────────────────────────────
function _cardsRender() {
  var cards   = _cardsFiltered();
  var total   = _cardsAll.length;
  var active  = _cardsAll.filter(function(c){ return c.status==='ACTIVE'; }).length;
  var inactive= _cardsAll.filter(function(c){ return c.status==='INACTIVE'; }).length;
  var susp    = _cardsAll.filter(function(c){ return c.status==='SUSPENDED'; }).length;
  var totBal  = _cardsAll.reduce(function(s,c){ return s+parseFloat(c.balance||0); },0);

  var sEl = document.getElementById('cardsStats');
  if (sEl) sEl.innerHTML =
    _cStat('Total','#065F46',total)+_cStat('Active','#1D4ED8',active)
    +_cStat('Inactive','#92400E',inactive)+_cStat('Suspended','#B5443A',susp)
    +_cStat('Total Balance','#5B21B6','₱'+totBal.toFixed(2));

  var fbEl = document.getElementById('cardsFilterBtns');
  if (fbEl) fbEl.innerHTML = ['ALL','ACTIVE','INACTIVE','SUSPENDED','EXPIRED'].map(function(f){
    var on=_cardsFilter===f;
    var cnt=f==='ALL'?_cardsAll.length:_cardsAll.filter(function(c){return c.status===f;}).length;
    return '<button onclick="_cardsSetFilter(\''+f+'\')" style="padding:6px 12px;border-radius:20px;border:none;font-size:.75rem;font-weight:700;cursor:pointer;background:'+(on?'var(--forest)':'var(--mist-light)')+';color:'+(on?'#fff':'var(--timber)')+'">'+f+' ('+cnt+')</button>';
  }).join('');

  var wrap = document.getElementById('cardsTableWrap');
  if (!wrap) return;
  if (!cards.length) { wrap.innerHTML='<div style="padding:40px;text-align:center;color:var(--timber)">No cards match your search</div>'; return; }

  var html='<table style="width:100%;border-collapse:collapse;font-size:.82rem">'
    +'<thead><tr style="background:var(--mist-light)">';
  ['Card #','Holder','Phone','Tier','Balance','Status','ON/OFF','Actions'].forEach(function(h){
    html+='<th style="padding:9px 10px;text-align:left;font-weight:700;color:var(--forest-deep);white-space:nowrap">'+h+'</th>';
  });
  html+='</tr></thead><tbody>';

  cards.forEach(function(c,i){
    var bg=i%2===0?'#fff':'var(--mist-light)';
    var sc=c.status==='ACTIVE'?'#065F46':c.status==='SUSPENDED'?'#B5443A':'#92400E';
    var isOn=c.status==='ACTIVE';
    var togBg=isOn?'#22c55e':'#d1d5db';
    var togPos=isOn?'translateX(18px)':'translateX(2px)';
    var togFn=isOn?"_cardToggleOff('"+c.card_number+"')"
      :(c.status==='INACTIVE'?"openCardActivate('"+c.card_number+"')"
        :"_cardToggleOn('"+c.card_number+"')");

    html+='<tr style="background:'+bg+';border-bottom:1px solid var(--mist)">';
    html+='<td style="padding:9px 10px;font-weight:700;font-family:monospace;color:var(--forest-deep)">'+c.card_number+'</td>';
    html+='<td style="padding:9px 10px">'+(c.holder_name||'<span style="color:#9CA3AF;font-style:italic">—</span>')+'</td>';
    html+='<td style="padding:9px 10px;color:var(--timber)">'+(c.holder_phone||'—')+'</td>';
    html+='<td style="padding:9px 10px"><span style="background:var(--mist-light);border-radius:4px;padding:2px 8px;font-weight:700;font-size:.78rem">₱'+c.tier+'</span></td>';
    html+='<td style="padding:9px 10px;font-weight:800;color:var(--forest-deep)">₱'+parseFloat(c.balance||0).toFixed(2)+'</td>';
    html+='<td style="padding:9px 10px"><span style="background:'+sc+';color:#fff;border-radius:12px;padding:2px 9px;font-size:.72rem;font-weight:700">'+c.status+'</span></td>';

    // Toggle
    html+='<td style="padding:9px 10px">'
      +'<div onclick="'+togFn+'" title="'+(isOn?'Suspend':'Activate')+'" '
      +'style="width:40px;height:22px;background:'+togBg+';border-radius:11px;cursor:pointer;position:relative;transition:background .2s;display:inline-block">'
      +'<div style="position:absolute;top:2px;width:18px;height:18px;background:#fff;border-radius:50%;transform:'+togPos+';transition:transform .2s;box-shadow:0 1px 3px rgba(0,0,0,.25)"></div>'
      +'</div></td>';

    // Actions — Manage button covers Edit+TopUp+Activate
    html+='<td style="padding:9px 10px;white-space:nowrap">';
    html+='<button onclick="openManageCard(\''+c.card_number+'\')" '
      +'style="background:var(--forest);color:#fff;border:none;border-radius:6px;padding:5px 11px;font-size:.78rem;font-weight:700;cursor:pointer;margin-right:4px">⚙️ Manage</button>';
    html+='<button onclick="openCardQR(\''+c.card_number+'\')" '
      +'style="background:var(--mist-light);color:var(--timber);border:none;border-radius:6px;padding:5px 11px;font-size:.78rem;font-weight:700;cursor:pointer;margin-right:4px">📱 QR</button>';
    html+='<button onclick="openCardTxns(\''+c.card_number+'\')" '
      +'style="background:var(--mist-light);color:var(--timber);border:none;border-radius:6px;padding:5px 11px;font-size:.78rem;font-weight:700;cursor:pointer">History</button>';
    html+='</td></tr>';
  });

  html+='</tbody></table>';
  wrap.innerHTML=html;
}

function _cStat(label,color,val){
  return '<div style="background:var(--mist-light);border-radius:10px;padding:10px 12px;border-left:3px solid '+color+'">'
    +'<div style="font-size:.65rem;font-weight:700;color:var(--timber);text-transform:uppercase;letter-spacing:.4px">'+label+'</div>'
    +'<div style="font-size:1.1rem;font-weight:800;color:'+color+';margin-top:2px">'+val+'</div>'
    +'</div>';
}

// ── Search & filter ────────────────────────────────────────────
function _cardsOnSearch(val){ _cardsSearch=val.toLowerCase().trim(); _cardsRender(); }
function _cardsSetFilter(f){ _cardsFilter=f; _cardsRender(); }
function _cardsFiltered(){
  return _cardsAll.filter(function(c){
    var mf=_cardsFilter==='ALL'||c.status===_cardsFilter;
    var q=_cardsSearch;
    var ms=!q||(c.card_number||'').toLowerCase().includes(q)||(c.holder_name||'').toLowerCase().includes(q)||(c.holder_phone||'').toLowerCase().includes(q);
    return mf&&ms;
  });
}

// ── MANAGE MODAL ──────────────────────────────────────────────
function openManageCard(cardNumber){
  var card=_cardsAll.find(function(c){return c.card_number===cardNumber;});
  if(!card) return;
  _manageCardNumber=cardNumber;

  document.getElementById('manageCardTitle').textContent='⚙️ '+cardNumber;
  document.getElementById('manageCardBal').textContent='₱'+parseFloat(card.balance||0).toFixed(2);
  var statusEl=document.getElementById('manageCardStatus');
  statusEl.textContent=card.status;
  statusEl.style.background=card.status==='ACTIVE'?'#065F46':card.status==='SUSPENDED'?'#B5443A':'#92400E';

  // Pre-fill holder info
  document.getElementById('manageHolderName').value=card.holder_name||'';
  document.getElementById('manageHolderPhone').value=card.holder_phone||'';
  document.getElementById('manageHolderEmail').value=card.holder_email||'';
  document.getElementById('manageTopUpAmt').value='';

  // Show/hide top-up section based on status
  var topUpSec=document.getElementById('manageTopUpSection');
  if(topUpSec) topUpSec.style.display=(card.status==='INACTIVE')?'none':'';

  document.getElementById('cardManageModal').style.display='flex';
}
function _closeManageModal(){ document.getElementById('cardManageModal').style.display='none'; }

// ── Submit Top Up ──────────────────────────────────────────────
async function _submitTopUp(){
  var amt=parseFloat(document.getElementById('manageTopUpAmt').value);
  if(isNaN(amt)||amt<50){ showToast('❌ Minimum top up is ₱50','error'); return; }
  try{
    var r=await _cardApi('reloadCard',{card_number:_manageCardNumber,amount:amt,performed_by:currentUser.userId||'OWNER'});
    if(r.ok){
      showToast('✅ Added ₱'+amt.toFixed(2)+' → Balance: ₱'+parseFloat(r.balance||0).toFixed(2));
      document.getElementById('manageTopUpAmt').value='';
      // Update balance display in modal
      document.getElementById('manageCardBal').textContent='₱'+parseFloat(r.balance||0).toFixed(2);
      await _cardsFetch();
    } else showToast('❌ '+(r.error||'Top up failed'),'error');
  }catch(e){ showToast('❌ '+e.message,'error'); }
}

// ── Submit Edit Holder ─────────────────────────────────────────
async function _submitEditHolder(){
  var name=document.getElementById('manageHolderName').value.trim();
  var phone=document.getElementById('manageHolderPhone').value.trim();
  var email=document.getElementById('manageHolderEmail').value.trim();
  if(!name&&!phone){ showToast('❌ Enter at least a name or phone','error'); return; }
  try{
    var r=await _cardApi('updateCardHolder',{pin:'2026',card_number:_manageCardNumber,
      holder_name:name||null,holder_phone:phone||null,holder_email:email||null});
    if(r.ok){ showToast('✅ Card holder updated'); _closeManageModal(); await _cardsFetch(); }
    else showToast('❌ '+(r.error||'Update failed'),'error');
  }catch(e){ showToast('❌ '+e.message,'error'); }
}

// ── Activate card ──────────────────────────────────────────────
function openCardActivate(cardNumber){
  _manageCardNumber=cardNumber;
  var card=_cardsAll.find(function(c){return c.card_number===cardNumber;});
  if(!card) return;
  document.getElementById('manageCardTitle').textContent='⚙️ '+cardNumber+' — Activate';
  document.getElementById('manageCardBal').textContent='₱0.00';
  var statusEl=document.getElementById('manageCardStatus');
  statusEl.textContent='INACTIVE'; statusEl.style.background='#92400E';
  document.getElementById('manageHolderName').value=card.holder_name||'';
  document.getElementById('manageHolderPhone').value=card.holder_phone||'';
  document.getElementById('manageHolderEmail').value=card.holder_email||'';
  document.getElementById('manageTopUpAmt').value='';
  var topUpSec=document.getElementById('manageTopUpSection');
  if(topUpSec) topUpSec.style.display='none'; // hidden until activated
  document.getElementById('cardManageModal').style.display='flex';

  // Override save to activate instead
  var saveBtn=document.querySelector('#cardManageModal button[onclick="_submitEditHolder()"]');
  if(saveBtn){ saveBtn.textContent='✅ Activate'; saveBtn.setAttribute('onclick','_activateFromManage()'); }
}

async function _activateFromManage(){
  var name=document.getElementById('manageHolderName').value.trim();
  var phone=document.getElementById('manageHolderPhone').value.trim();
  var email=document.getElementById('manageHolderEmail').value.trim();
  try{
    if(name||phone||email){
      await _cardApi('updateCardHolder',{pin:'2026',card_number:_manageCardNumber,
        holder_name:name||null,holder_phone:phone||null,holder_email:email||null});
    }
    var r=await _cardApi('activateCard',{card_number:_manageCardNumber,performed_by:currentUser.userId||'OWNER'});
    if(r.ok){ showToast('✅ '+_manageCardNumber+' activated! Balance: ₱'+parseFloat(r.balance_after||0).toFixed(2)); _closeManageModal(); await _cardsFetch(); }
    else showToast('❌ '+(r.error||'Activation failed'),'error');
  }catch(e){ showToast('❌ '+e.message,'error'); }
}

// ── Toggle ON/OFF ─────────────────────────────────────────────
async function _cardToggleOn(cardNumber){
  try{
    var r=await _cardApi('setCardStatus',{pin:'2026',card_number:cardNumber,status:'ACTIVE',reason:'Reinstated by owner'});
    if(r.ok){ showToast('✅ '+cardNumber+' reinstated'); await _cardsFetch(); }
    else showToast('❌ '+(r.error||'Failed'),'error');
  }catch(e){ showToast('❌ '+e.message,'error'); }
}
async function _cardToggleOff(cardNumber){
  if(!confirm('Suspend '+cardNumber+'? Customer won\'t be able to use it until reinstated.')) return;
  try{
    var r=await _cardApi('setCardStatus',{pin:'2026',card_number:cardNumber,status:'SUSPENDED',reason:'Suspended by owner'});
    if(r.ok){ showToast('⚠️ '+cardNumber+' suspended'); await _cardsFetch(); }
    else showToast('❌ '+(r.error||'Failed'),'error');
  }catch(e){ showToast('❌ '+e.message,'error'); }
}

// ── QR Modal ──────────────────────────────────────────────────
var _qrCurrentCard=null;
async function openCardQR(cardNumber){
  var card=_cardsAll.find(function(c){return c.card_number===cardNumber;});
  if(!card) return;
  _qrCurrentCard=card;
  document.getElementById('qrModalTitle').textContent='📱 QR — '+cardNumber;
  document.getElementById('qrModalContent').innerHTML='<div style="padding:20px;text-align:center;color:var(--timber)">Loading QR…</div>';
  document.getElementById('cardQRModal').style.display='flex';
  try{
    var token=await _fetchOneQR(cardNumber);
    var qrSrc=_qrUrl(token,280);
    document.getElementById('qrModalContent').innerHTML=
      '<img src="'+qrSrc+'" style="width:200px;height:200px;border-radius:8px;border:2px solid var(--mist)" alt="QR"><br>'
      +'<div style="margin-top:10px;font-size:.78rem;color:var(--timber);background:var(--mist-light);border-radius:6px;padding:6px 10px;word-break:break-all">'+token+'</div>'
      +'<div style="margin-top:10px;font-size:.78rem;color:var(--timber)"><strong>'+cardNumber+'</strong>'
      +(card.holder_name?' · '+card.holder_name:'')
      +' · ₱'+card.tier+' tier<br>Balance: ₱'+parseFloat(card.balance||0).toFixed(2)
      +' · <span style="color:'+(card.status==='ACTIVE'?'#065F46':'#B5443A')+'">'+card.status+'</span></div>';
  }catch(e){
    document.getElementById('qrModalContent').innerHTML='<p style="color:#B5443A">❌ '+e.message+'</p>';
  }
}
function _printSingleCard(){
  if(!_qrCurrentCard) return;
  var token=_cardsWithQR[_qrCurrentCard.card_number];
  if(!token){ showToast('❌ QR not loaded','error'); return; }
  _openPrintWindow([_qrCurrentCard],{token:token});
}

// ── Transaction History ───────────────────────────────────────
async function openCardTxns(cardNumber){
  document.getElementById('cardTxnTitle').textContent='📋 History — '+cardNumber;
  document.getElementById('cardTxnBody').innerHTML='Loading…';
  document.getElementById('cardTxnModal').style.display='block';
  try{
    var r=await _cardApi('getCardTransactions',{pin:'2026',card_number:cardNumber,limit:50});
    if(!r.ok) throw new Error(r.error||'Failed');
    var txns=r.transactions||[];
    if(!txns.length){ document.getElementById('cardTxnBody').innerHTML='<p style="text-align:center;padding:30px;color:var(--timber)">No transactions yet</p>'; return; }
    var tc={CHARGE:'#B5443A',RELOAD:'#1D4ED8',ACTIVATE:'#065F46',REVERSE:'#92400E',SUSPEND:'#6B7280',REINSTATE:'#065F46',ADJUST:'#5B21B6'};
    var html='<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:.8rem">'
      +'<thead><tr style="background:var(--mist-light)">';
    ['Date/Time','Type','Amount','Saved','Before','After','Order','By'].forEach(function(h){
      html+='<th style="padding:7px 9px;text-align:left;font-weight:700;color:var(--forest-deep);white-space:nowrap">'+h+'</th>';
    });
    html+='</tr></thead><tbody>';
    txns.forEach(function(t,i){
      var bg=i%2===0?'#fff':'var(--mist-light)';
      var dt=new Date(t.created_at);
      var ds=dt.toLocaleDateString('en-PH',{month:'short',day:'numeric',year:'2-digit'})+' '+dt.toLocaleTimeString('en-PH',{hour:'2-digit',minute:'2-digit'});
      var disc=parseFloat(t.discount_amount||0);
      html+='<tr style="background:'+bg+';border-bottom:1px solid var(--mist)">'
        +'<td style="padding:7px 9px;white-space:nowrap;color:var(--timber)">'+ds+'</td>'
        +'<td style="padding:7px 9px"><span style="background:'+(tc[t.type]||'#374151')+';color:#fff;border-radius:10px;padding:2px 8px;font-size:.7rem;font-weight:700">'+t.type+'</span></td>'
        +'<td style="padding:7px 9px;font-weight:700">₱'+parseFloat(t.amount||0).toFixed(2)+'</td>'
        +'<td style="padding:7px 9px;color:#065F46;font-weight:700">'+(disc>0?'₱'+disc.toFixed(2):'—')+'</td>'
        +'<td style="padding:7px 9px">₱'+parseFloat(t.balance_before||0).toFixed(2)+'</td>'
        +'<td style="padding:7px 9px;font-weight:700">₱'+parseFloat(t.balance_after||0).toFixed(2)+'</td>'
        +'<td style="padding:7px 9px;font-size:.72rem;color:var(--timber)">'+(t.order_id||'—')+'</td>'
        +'<td style="padding:7px 9px;font-size:.72rem;color:var(--timber)">'+(t.performed_by||'—')+'</td>'
        +'</tr>';
    });
    html+='</tbody></table></div>';
    document.getElementById('cardTxnBody').innerHTML=html;
  }catch(e){ document.getElementById('cardTxnBody').innerHTML='<p style="color:#B5443A;padding:20px">❌ '+e.message+'</p>'; }
}

// ── QR helpers ────────────────────────────────────────────────
var _cardsWithQR={};
async function _fetchOneQR(cardNumber){
  if(_cardsWithQR[cardNumber]) return _cardsWithQR[cardNumber];
  var r=await _cardApi('lookupCard',{card_number:cardNumber,pin:'2026'});
  if(!r.ok) throw new Error(r.error||'Not found');
  _cardsWithQR[cardNumber]=r.card.qr_token;
  return r.card.qr_token;
}
async function _fetchAllQR(){
  var r=await _cardApi('listCardsWithQR',{pin:'2026'});
  if(!r.ok) throw new Error(r.error||'Failed');
  (r.cards||[]).forEach(function(c){ _cardsWithQR[c.card_number]=c.qr_token; });
  return r.cards||[];
}
function _qrUrl(token,size){
  return 'https://api.qrserver.com/v1/create-qr-code/?size='+(size||300)+'x'+(size||300)+'&margin=10&data='+encodeURIComponent(token);
}
async function openPrintAllSheet(){
  showToast('Loading QR codes for all cards…');
  try{ var cards=await _fetchAllQR(); _openPrintWindow(cards,null); }
  catch(e){ showToast('❌ '+e.message,'error'); }
}
function _openPrintWindow(cards,single){
  var w=window.open('','_blank','width=900,height=700');
  if(!w){ showToast('❌ Allow pop-ups to print','error'); return; }
  var ch=cards.map(function(c){
    var token=single?single.token:c.qr_token;
    var qrSrc=_qrUrl(token,220);
    return '<div class="card">'
      +'<div class="logo">🌿 YANI</div>'
      +'<img class="qr" src="'+qrSrc+'" alt="QR">'
      +'<div class="num">'+c.card_number+'</div>'
      +'<div class="holder">'+(c.holder_name||'&nbsp;')+'</div>'
      +'<div class="tier">₱'+c.tier+' Stored-Value Card · 10% discount every order</div>'
      +'<div class="status">'+c.status+'</div>'
      +'</div>';
  }).join('');
  w.document.write('<!DOCTYPE html><html><head><title>Yani Cards</title>'
    +'<style>body{margin:0;padding:20px;font-family:Arial,sans-serif;background:#f5f5f5}'
    +'h1{text-align:center;font-size:1.1rem;color:#1a3c1a;margin-bottom:20px}'
    +'.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}'
    +'.card{background:#fff;border-radius:12px;padding:16px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.12);break-inside:avoid}'
    +'.logo{font-size:1rem;font-weight:800;color:#1a3c1a;letter-spacing:2px;margin-bottom:8px}'
    +'.qr{width:140px;height:140px;border-radius:6px;border:2px solid #e5e7eb}'
    +'.num{font-family:monospace;font-size:.95rem;font-weight:700;color:#1a3c1a;margin-top:8px}'
    +'.holder{font-size:.78rem;color:#555;min-height:18px;margin-top:2px}'
    +'.tier{font-size:.68rem;color:#777;margin-top:4px}'
    +'.status{display:inline-block;margin-top:6px;font-size:.65rem;font-weight:700;padding:2px 8px;border-radius:10px;background:#e5e7eb;color:#374151}'
    +'@media print{body{background:#fff;padding:0}.no-print{display:none}}'
    +'</style></head><body>'
    +'<h1 class="no-print">🌿 Yani Cards ('+cards.length+')</h1>'
    +'<div class="no-print" style="text-align:center;margin-bottom:16px">'
    +'<button onclick="window.print()" style="padding:10px 24px;background:#1a3c1a;color:#fff;border:none;border-radius:8px;font-size:.9rem;font-weight:700;cursor:pointer">🖨️ Print</button>'
    +'</div><div class="grid">'+ch+'</div></body></html>');
  w.document.close();
}

// ── API helper ────────────────────────────────────────────────
async function _cardApi(action,body){
  var r=await fetch('/api/card',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({action:action},body||{}))});
  return r.json();
}
