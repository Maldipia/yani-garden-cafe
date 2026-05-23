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
// Loyalty-by-EMAIL map populated alongside the cards fetch so the row
// renderer can show a ⭐ indicator without an N+1 query per card.
// Email is the new loyalty identity (phone no longer unique).
var _loyaltyByEmail = {};
async function _cardsFetch() {
  var loading = document.getElementById('cardsLoading');
  var wrap    = document.getElementById('cardsTableWrap');
  if (loading) loading.style.display = 'block';
  if (wrap)    wrap.innerHTML = '';
  try {
    var [cardsR, loyaltyR] = await Promise.all([
      _cardApi('listCards', { pin: '2026' }),
      api('getLoyaltyAccounts', { userId: (currentUser && currentUser.userId) || 'USR_001', limit: 500 })
        .catch(function(){ return { ok:false, accounts:[] }; })
    ]);
    if (!cardsR.ok) throw new Error(cardsR.error || 'Failed');
    _cardsAll = cardsR.cards || [];
    _loyaltyByEmail = {};
    (loyaltyR.accounts || []).forEach(function(acc){
      var key = String(acc.email || '').trim().toLowerCase();
      if (key) _loyaltyByEmail[key] = acc;
    });
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
    + '<button onclick="openAddCardsModal()" style="background:var(--forest);color:#fff;border:none;border-radius:8px;padding:8px 14px;font-size:.78rem;font-weight:700;cursor:pointer">➕ Add Cards</button>'
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
    + '<div style="font-size:.8rem;font-weight:700;color:var(--timber);margin-bottom:6px;text-transform:uppercase;letter-spacing:.4px">💰 Reload Balance</div>'
    + '<div style="font-size:.72rem;color:var(--timber);margin-bottom:8px">Minimum reload: ₱500</div>'
    + '<div style="display:flex;gap:8px;margin-bottom:16px">'
    + '<input id="manageTopUpAmt" type="number" min="500" step="100" placeholder="Enter amount (e.g. 500, 1000…)" '
    + 'style="flex:1;padding:9px 12px;border:1.5px solid var(--mist);border-radius:8px;font-size:.9rem;font-family:var(--font-body)">'
    + '<button onclick="_submitTopUp()" style="padding:9px 20px;background:#1D4ED8;color:#fff;border:none;border-radius:8px;font-size:.82rem;font-weight:700;cursor:pointer">💰 Reload</button>'
    + '</div>'
    + '</div>'

    // ── SECTION: Adjust Balance (OWNER only — manual deduct/credit, requires reason) ──
    + '<div id="manageAdjustSection" style="display:none;border-top:1px solid var(--mist);padding-top:14px;margin-top:2px">'
    + '<div style="font-size:.8rem;font-weight:700;color:#92400E;margin-bottom:6px;text-transform:uppercase;letter-spacing:.4px">⚖️ Adjust Balance <span style="background:#92400E;color:#fff;font-size:.6rem;padding:1px 6px;border-radius:6px;margin-left:4px">OWNER</span></div>'
    + '<div style="font-size:.72rem;color:var(--timber);margin-bottom:8px;line-height:1.4">Use negative (e.g. <strong>-500</strong>) to deduct, positive to credit. Logged as ADJUST in card history with reason.</div>'
    + '<input id="manageAdjustAmt" type="number" step="0.01" placeholder="e.g. -500 to deduct, 100 to credit" '
    + 'style="width:100%;padding:9px 12px;border:1.5px solid #FCD34D;border-radius:8px;font-size:.9rem;font-family:var(--font-body);box-sizing:border-box;margin-bottom:8px">'
    + '<input id="manageAdjustReason" type="text" placeholder="Reason (required) — e.g. Refund void, correction, promo" '
    + 'style="width:100%;padding:9px 12px;border:1.5px solid #FCD34D;border-radius:8px;font-size:.85rem;font-family:var(--font-body);box-sizing:border-box;margin-bottom:10px">'
    + '<button onclick="_submitAdjust()" style="width:100%;padding:10px;background:#92400E;color:#fff;border:none;border-radius:8px;font-size:.82rem;font-weight:700;cursor:pointer">⚖️ Apply Adjustment</button>'
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

  // ── OWNER EDIT MODAL (full field edit with audit) ─────────────────────
  // Removes any stale version first so re-loading the script doesn't dup
  var prevOE = document.getElementById('cardOwnerEditModal'); if (prevOE) prevOE.remove();
  var oe = document.createElement('div');
  oe.id = 'cardOwnerEditModal';
  oe.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9100;align-items:center;justify-content:center;padding:20px;overflow-y:auto';
  oe.innerHTML = ''
    + '<div style="background:#fff;border-radius:16px;width:100%;max-width:520px;max-height:92vh;overflow-y:auto;padding:24px">'
    + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">'
    +   '<h3 id="oeTitle" style="font-size:1rem;font-weight:800;color:#92400E;margin:0">🔧 Owner Edit</h3>'
    +   '<button onclick="_closeOwnerEdit()" style="background:var(--mist-light);border:none;border-radius:8px;padding:6px 12px;cursor:pointer">✕</button>'
    + '</div>'
    + '<div style="font-size:.72rem;color:var(--timber);margin-bottom:14px;background:#FEF3C7;border-left:3px solid #92400E;padding:8px 10px;border-radius:6px;line-height:1.4">'
    +   '⚠️ <strong>Owner-only direct edit.</strong> Every changed field is logged. '
    +   'Leave fields blank/unchanged to keep current value. Reason is required.'
    + '</div>'

    // BALANCE
    + '<label style="font-size:.7rem;font-weight:700;color:var(--timber);display:block;margin-bottom:3px;text-transform:uppercase;letter-spacing:.4px">Balance (₱)</label>'
    + '<input id="oeBalance" type="number" step="0.01" min="0" style="width:100%;padding:8px 11px;border:1.5px solid var(--mist);border-radius:8px;font-size:.88rem;font-family:var(--font-body);box-sizing:border-box;margin-bottom:10px">'

    // CARD PIN
    + '<label style="font-size:.7rem;font-weight:700;color:var(--timber);display:block;margin-bottom:3px;text-transform:uppercase;letter-spacing:.4px">Card PIN (2 digits)</label>'
    + '<input id="oeCardPin" type="text" maxlength="2" pattern="\\d{2}" placeholder="e.g. 48" style="width:100%;padding:8px 11px;border:1.5px solid var(--mist);border-radius:8px;font-size:.88rem;font-family:monospace;box-sizing:border-box;margin-bottom:10px">'

    // TIER
    + '<label style="font-size:.7rem;font-weight:700;color:var(--timber);display:block;margin-bottom:3px;text-transform:uppercase;letter-spacing:.4px">Tier</label>'
    + '<select id="oeTier" style="width:100%;padding:8px 11px;border:1.5px solid var(--mist);border-radius:8px;font-size:.88rem;font-family:var(--font-body);box-sizing:border-box;margin-bottom:10px;background:#fff">'
    +   '<option value="500">₱500</option><option value="1000">₱1,000</option>'
    +   '<option value="2000">₱2,000</option><option value="3000">₱3,000</option>'
    + '</select>'

    // STATUS
    + '<label style="font-size:.7rem;font-weight:700;color:var(--timber);display:block;margin-bottom:3px;text-transform:uppercase;letter-spacing:.4px">Status</label>'
    + '<select id="oeStatus" style="width:100%;padding:8px 11px;border:1.5px solid var(--mist);border-radius:8px;font-size:.88rem;font-family:var(--font-body);box-sizing:border-box;margin-bottom:10px;background:#fff">'
    +   '<option value="ACTIVE">ACTIVE</option><option value="INACTIVE">INACTIVE</option>'
    +   '<option value="SUSPENDED">SUSPENDED</option><option value="EXPIRED">EXPIRED</option>'
    + '</select>'

    // EXPIRES_AT
    + '<label style="font-size:.7rem;font-weight:700;color:var(--timber);display:block;margin-bottom:3px;text-transform:uppercase;letter-spacing:.4px">Expires at <span style="font-weight:400;color:#9CA3AF">(blank = no expiry)</span></label>'
    + '<input id="oeExpires" type="date" style="width:100%;padding:8px 11px;border:1.5px solid var(--mist);border-radius:8px;font-size:.88rem;font-family:var(--font-body);box-sizing:border-box;margin-bottom:10px">'

    // HOLDER
    + '<label style="font-size:.7rem;font-weight:700;color:var(--timber);display:block;margin-bottom:3px;text-transform:uppercase;letter-spacing:.4px">Holder Name</label>'
    + '<input id="oeHolderName" type="text" style="width:100%;padding:8px 11px;border:1.5px solid var(--mist);border-radius:8px;font-size:.88rem;font-family:var(--font-body);box-sizing:border-box;margin-bottom:10px">'
    + '<label style="font-size:.7rem;font-weight:700;color:var(--timber);display:block;margin-bottom:3px;text-transform:uppercase;letter-spacing:.4px">Holder Phone</label>'
    + '<input id="oeHolderPhone" type="tel" style="width:100%;padding:8px 11px;border:1.5px solid var(--mist);border-radius:8px;font-size:.88rem;font-family:var(--font-body);box-sizing:border-box;margin-bottom:10px">'
    + '<label style="font-size:.7rem;font-weight:700;color:var(--timber);display:block;margin-bottom:3px;text-transform:uppercase;letter-spacing:.4px">Holder Email</label>'
    + '<input id="oeHolderEmail" type="email" style="width:100%;padding:8px 11px;border:1.5px solid var(--mist);border-radius:8px;font-size:.88rem;font-family:var(--font-body);box-sizing:border-box;margin-bottom:14px">'

    // REASON (required)
    + '<label style="font-size:.7rem;font-weight:700;color:#92400E;display:block;margin-bottom:3px;text-transform:uppercase;letter-spacing:.4px">Reason for edit *</label>'
    + '<input id="oeReason" type="text" placeholder="Required — e.g. Overload correction, PIN reset, status fix" style="width:100%;padding:9px 12px;border:1.5px solid #FCD34D;border-radius:8px;font-size:.85rem;font-family:var(--font-body);box-sizing:border-box;margin-bottom:14px">'

    + '<div style="display:flex;gap:8px">'
    +   '<button onclick="_closeOwnerEdit()" style="flex:1;padding:10px;background:var(--mist-light);border:none;border-radius:8px;font-size:.82rem;font-weight:700;cursor:pointer;color:var(--timber)">Cancel</button>'
    +   '<button onclick="_submitOwnerEdit()" style="flex:2;padding:10px;background:#92400E;color:#fff;border:none;border-radius:8px;font-size:.82rem;font-weight:700;cursor:pointer">🔧 Save Changes</button>'
    + '</div>'
    + '</div>';
  document.body.appendChild(oe);
}

// ── HTML escape (XSS-safe rendering of user-supplied fields) ──
// Used wherever user-controlled strings (holder_name/phone/email,
// reasons, descriptions) get concatenated into innerHTML. PostgREST
// stores raw text verbatim — escaping is the renderer's job.
function _esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


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
    html+='<td style="padding:9px 10px;font-weight:700;font-family:monospace;color:var(--forest-deep)">'+_esc(c.card_number)+(c.card_pin?'<span style="color:#9CA3AF;font-size:.78rem">-'+_esc(c.card_pin)+'</span>':'')+'</td>';
    // Holder cell — append ⭐+points badge when a loyalty account exists for this email.
    // Email is the new loyalty identity key (phone is no longer unique).
    // Holder cell — append 🍃+leaves badge when a loyalty account exists for this email.
    var loyAcc = c.holder_email ? _loyaltyByEmail[String(c.holder_email).trim().toLowerCase()] : null;
    var loyLeaves = loyAcc ? (loyAcc.total_points_earned || loyAcc.points_balance || 0) : 0;
    var loyBadge = loyAcc
      ? '<span title="YANI Roots Rewards · '+loyLeaves+' leaves · '+_esc(loyAcc.email)+'" '
        + 'style="margin-left:6px;display:inline-block;background:#DCFCE7;color:#065F46;border-radius:8px;padding:1px 6px;font-size:.66rem;font-weight:700;cursor:default">'
        + '🍃 '+loyLeaves+'</span>'
      : '';
    html+='<td style="padding:9px 10px">'+(c.holder_name?_esc(c.holder_name)+loyBadge:'<span style="color:#9CA3AF;font-style:italic">—</span>')+'</td>';
    html+='<td style="padding:9px 10px;color:var(--timber)">'+(c.holder_phone?_esc(c.holder_phone):'—')+'</td>';
    html+='<td style="padding:9px 10px"><span style="background:var(--mist-light);border-radius:4px;padding:2px 8px;font-weight:700;font-size:.78rem">₱'+_esc(c.tier)+'</span></td>';
    html+='<td style="padding:9px 10px;font-weight:800;color:var(--forest-deep)">₱'+parseFloat(c.balance||0).toFixed(2)+'</td>';
    html+='<td style="padding:9px 10px"><span style="background:'+sc+';color:#fff;border-radius:12px;padding:2px 9px;font-size:.72rem;font-weight:700">'+_esc(c.status)+'</span></td>';

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
    // OWNER-only: full edit modal for every card field
    if (currentUser && currentUser.role === 'OWNER') {
      html+='<button onclick="openOwnerEditCard(\''+c.card_number+'\')" '
        +'style="background:#92400E;color:#fff;border:none;border-radius:6px;padding:5px 11px;font-size:.78rem;font-weight:700;cursor:pointer;margin-right:4px" '
        +'title="Owner: edit all fields">🔧 Edit</button>';
    }
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

  var _cp=card&&card.card_pin?'-'+card.card_pin:''; document.getElementById('manageCardTitle').textContent='⚙️ '+cardNumber+_cp+' (Code: '+(cardNumber.replace('YANI-',''))+(card&&card.card_pin?card.card_pin:'')+')';
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

  // Show/hide Adjust section — OWNER only, hidden for INACTIVE cards
  var adjSec=document.getElementById('manageAdjustSection');
  if(adjSec){
    var isOwner = currentUser && currentUser.role === 'OWNER';
    adjSec.style.display = (isOwner && card.status !== 'INACTIVE') ? '' : 'none';
    // Clear previous inputs every open
    var adjAmt=document.getElementById('manageAdjustAmt'); if(adjAmt) adjAmt.value='';
    var adjRsn=document.getElementById('manageAdjustReason'); if(adjRsn) adjRsn.value='';
  }

  document.getElementById('cardManageModal').style.display='flex';
}
function _closeManageModal(){ document.getElementById('cardManageModal').style.display='none'; }

// ── Submit Top Up ──────────────────────────────────────────────
async function _submitTopUp(){
  var amt=parseFloat(document.getElementById('manageTopUpAmt').value);
  if(isNaN(amt)||amt<500){ showToast('❌ Minimum reload is ₱500','error'); return; }
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

// ── Submit Balance Adjustment (OWNER only) ─────────────────────
// Owner-only because the API requires the owner PIN. Confirm step + reason are
// required because adjust_card_balance permanently shifts the card balance
// without a corresponding charge/reload.
async function _submitAdjust(){
  var rawAmt=document.getElementById('manageAdjustAmt').value.trim();
  var reason=document.getElementById('manageAdjustReason').value.trim();
  var delta=parseFloat(rawAmt);
  if(isNaN(delta)||delta===0){ showToast('❌ Enter a non-zero amount (use - to deduct)','error'); return; }
  if(!reason){ showToast('❌ Reason is required for any balance adjustment','error'); return; }
  if(reason.length<4){ showToast('❌ Give a clearer reason (4+ characters)','error'); return; }

  // Find current card to show before/after preview in confirm
  var card=_cardsAll.find(function(c){return c.card_number===_manageCardNumber;});
  var balBefore=card?parseFloat(card.balance||0):0;
  var balAfter=balBefore+delta;
  if(balAfter<0){
    showToast('❌ Adjustment would make balance negative (₱'+balAfter.toFixed(2)+')','error');
    return;
  }
  var verb=delta<0?'DEDUCT':'CREDIT';
  var absAmt=Math.abs(delta).toFixed(2);
  var msg=verb+' ₱'+absAmt+' on '+_manageCardNumber+'?\n\n'
    +'Balance: ₱'+balBefore.toFixed(2)+' → ₱'+balAfter.toFixed(2)+'\n'
    +'Reason: '+reason+'\n\n'
    +'This is logged as an ADJUST transaction. Cannot be undone via this UI '
    +'(only via Void in card History).';
  if(!confirm(msg)) return;

  try{
    var r=await _cardApi('adjustCard',{pin:'2026',card_number:_manageCardNumber,delta:delta,reason:reason});
    if(r&&r.ok){
      showToast('✅ '+verb+' ₱'+absAmt+' → Balance: ₱'+parseFloat(r.balance_after!=null?r.balance_after:balAfter).toFixed(2));
      // Update modal balance + clear inputs
      document.getElementById('manageCardBal').textContent='₱'+parseFloat(r.balance_after!=null?r.balance_after:balAfter).toFixed(2);
      document.getElementById('manageAdjustAmt').value='';
      document.getElementById('manageAdjustReason').value='';
      await _cardsFetch();
    } else {
      showToast('❌ '+((r&&r.error)||'Adjustment failed'),'error');
    }
  }catch(e){ showToast('❌ '+e.message,'error'); }
}

// ── Owner Edit Modal (full field edit) ─────────────────────────
var _oeCardNumber = null;
var _oeOriginal   = null; // snapshot of card before edit, used for diff display

function openOwnerEditCard(cardNumber){
  if (!currentUser || currentUser.role !== 'OWNER') {
    showToast('❌ Owner role required','error'); return;
  }
  var card = _cardsAll.find(function(c){return c.card_number===cardNumber;});
  if (!card) { showToast('❌ Card not found','error'); return; }
  _oeCardNumber = cardNumber;
  _oeOriginal   = card;

  document.getElementById('oeTitle').textContent = '🔧 Owner Edit — ' + cardNumber +
    (card.card_pin ? '-' + card.card_pin : '');

  // Pre-fill all fields with current values
  document.getElementById('oeBalance').value     = parseFloat(card.balance || 0).toFixed(2);
  document.getElementById('oeCardPin').value     = card.card_pin || '';
  document.getElementById('oeTier').value        = String(card.tier || '500');
  document.getElementById('oeStatus').value      = card.status || 'INACTIVE';
  document.getElementById('oeExpires').value     = card.expires_at ? card.expires_at.substring(0,10) : '';
  document.getElementById('oeHolderName').value  = card.holder_name  || '';
  document.getElementById('oeHolderPhone').value = card.holder_phone || '';
  document.getElementById('oeHolderEmail').value = card.holder_email || '';
  document.getElementById('oeReason').value      = '';

  document.getElementById('cardOwnerEditModal').style.display = 'flex';
}
function _closeOwnerEdit(){
  document.getElementById('cardOwnerEditModal').style.display = 'none';
  _oeCardNumber = null; _oeOriginal = null;
}

async function _submitOwnerEdit(){
  if (!_oeCardNumber || !_oeOriginal) return;
  var reason = document.getElementById('oeReason').value.trim();
  if (!reason || reason.length < 4) {
    showToast('❌ Reason required (4+ chars)','error');
    document.getElementById('oeReason').focus();
    return;
  }

  // Collect raw form values
  var form = {
    balance:      document.getElementById('oeBalance').value,
    card_pin:     document.getElementById('oeCardPin').value.trim(),
    tier:         document.getElementById('oeTier').value,
    status:       document.getElementById('oeStatus').value,
    expires_at:   document.getElementById('oeExpires').value, // YYYY-MM-DD or ''
    holder_name:  document.getElementById('oeHolderName').value.trim(),
    holder_phone: document.getElementById('oeHolderPhone').value.trim(),
    holder_email: document.getElementById('oeHolderEmail').value.trim(),
  };

  // Build a human-readable diff preview vs original
  var orig = _oeOriginal;
  var diffs = [];
  function rowIfChanged(label, oldV, newV, isPin) {
    var o = oldV === null || oldV === undefined ? '' : String(oldV);
    var n = newV === null || newV === undefined ? '' : String(newV);
    if (o === n) return;
    if (isPin) { o = '••'; n = '••'; }
    diffs.push(label + ': "' + (o||'∅') + '" → "' + (n||'∅') + '"');
  }
  // Balance — compare numerically
  var newBal = parseFloat(form.balance);
  if (!isNaN(newBal) && Math.abs(newBal - parseFloat(orig.balance||0)) > 0.001) {
    diffs.push('Balance: ₱' + parseFloat(orig.balance||0).toFixed(2) + ' → ₱' + newBal.toFixed(2));
  }
  rowIfChanged('PIN',     orig.card_pin,     form.card_pin, true);
  rowIfChanged('Tier',    '₱'+orig.tier,     '₱'+form.tier);
  rowIfChanged('Status',  orig.status,       form.status);
  // Expires: compare YYYY-MM-DD slices
  var origExp = orig.expires_at ? orig.expires_at.substring(0,10) : '';
  if (origExp !== form.expires_at) {
    diffs.push('Expires: ' + (origExp || 'never') + ' → ' + (form.expires_at || 'never'));
  }
  rowIfChanged('Name',    orig.holder_name,  form.holder_name);
  rowIfChanged('Phone',   orig.holder_phone, form.holder_phone);
  rowIfChanged('Email',   orig.holder_email, form.holder_email);

  if (diffs.length === 0) {
    showToast('No changes to save'); return;
  }

  var msg = '🔧 OWNER EDIT — ' + _oeCardNumber + '\n\n'
    + diffs.join('\n')
    + '\n\nReason: ' + reason
    + '\n\nEvery change is logged to card History. Continue?';
  if (!confirm(msg)) return;

  // Send only what user typed; backend diffs vs DB to avoid race conditions
  var payload = {
    pin:          '2026',
    card_number:  _oeCardNumber,
    reason:       reason,
    balance:      form.balance === '' ? undefined : parseFloat(form.balance),
    card_pin:     form.card_pin || undefined,
    tier:         form.tier,
    status:       form.status,
    // expires_at: empty string means CLEAR. ISO date appended to noon UTC so
    // local-tz off-by-one-day doesn't push it to the wrong calendar day.
    expires_at:   form.expires_at === '' ? null : (form.expires_at + 'T12:00:00Z'),
    holder_name:  form.holder_name  === '' ? null : form.holder_name,
    holder_phone: form.holder_phone === '' ? null : form.holder_phone,
    holder_email: form.holder_email === '' ? null : form.holder_email,
  };

  try {
    var r = await _cardApi('ownerEditCard', payload);
    if (r && r.ok) {
      if (r.no_changes) { showToast('No changes detected'); return; }
      var n = r.change_count || (r.changed_fields ? r.changed_fields.length : 0);
      showToast('✅ ' + _oeCardNumber + ' updated · ' + n + ' field' + (n===1?'':'s') + ' changed');
      _closeOwnerEdit();
      await _cardsFetch();
    } else {
      showToast('❌ ' + ((r && r.error) || 'Edit failed'), 'error');
    }
  } catch(e) {
    showToast('❌ ' + e.message, 'error');
  }
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
      +'<div style="margin-top:10px;font-size:.78rem;color:var(--timber);background:var(--mist-light);border-radius:6px;padding:6px 10px;word-break:break-all">'+_esc(token)+'</div>'
      +'<div style="margin-top:10px;font-size:.78rem;color:var(--timber)"><strong>'+_esc(cardNumber)+'</strong>'
      +(card.holder_name?' · '+_esc(card.holder_name):'')
      +' · ₱'+_esc(card.tier)+' tier<br>Balance: ₱'+parseFloat(card.balance||0).toFixed(2)
      +' · <span style="color:'+(card.status==='ACTIVE'?'#065F46':'#B5443A')+'">'+_esc(card.status)+'</span></div>';
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
var _txnCurrentCard=''; async function openCardTxns(cardNumber){ _txnCurrentCard=cardNumber;
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
    ['Date/Time','Type','Amount','Saved','Before','After','Order','By',''].forEach(function(h){
      html+='<th style="padding:7px 9px;text-align:left;font-weight:700;color:var(--forest-deep);white-space:nowrap">'+h+'</th>';
    });
    html+='</tr></thead><tbody>';
    var isOwner = currentUser && currentUser.role === 'OWNER';
    txns.forEach(function(t,i){
      var bg=i%2===0?'#fff':'var(--mist-light)';
      var dt=new Date(t.created_at);
      var ds=dt.toLocaleDateString('en-PH',{month:'short',day:'numeric',year:'2-digit'})+' '+dt.toLocaleTimeString('en-PH',{hour:'2-digit',minute:'2-digit'});
      var disc=parseFloat(t.discount_amount||0);
      var canVoid=isOwner&&(t.type==='CHARGE'||t.type==='RELOAD')&&!t.reversed_by_txn;
      html+='<tr style="background:'+bg+';border-bottom:1px solid var(--mist)">'        +'<td style="padding:7px 9px;white-space:nowrap;color:var(--timber)">'+ds+'</td>'        +'<td style="padding:7px 9px"><span style="background:'+(tc[t.type]||'#374151')+';color:#fff;border-radius:10px;padding:2px 8px;font-size:.7rem;font-weight:700">'+_esc(t.type)+'</span></td>'        +'<td style="padding:7px 9px;font-weight:700">₱'+parseFloat(t.amount||0).toFixed(2)+'</td>'        +'<td style="padding:7px 9px;color:#065F46;font-weight:700">'+(disc>0?'₱'+disc.toFixed(2):'—')+'</td>'        +'<td style="padding:7px 9px">₱'+parseFloat(t.balance_before||0).toFixed(2)+'</td>'        +'<td style="padding:7px 9px;font-weight:700">₱'+parseFloat(t.balance_after||0).toFixed(2)+'</td>'        +'<td style="padding:7px 9px;font-size:.72rem;color:var(--timber)">'+_esc(t.order_id||'—')+'</td>'        +'<td style="padding:7px 9px;font-size:.72rem;color:var(--timber)">'+_esc(t.performed_by||'—')+'</td>'        +'<td style="padding:4px 9px">'+(t.reversed_by_txn          ?'<span style="color:#9CA3AF;font-size:.68rem;font-style:italic">Voided</span>'          :(canVoid?('<button onclick="_voidTxn(&quot;'+_esc(t.id)+'&quot;,&quot;'+_esc(_txnCurrentCard)+'&quot;)" style="padding:4px 10px;background:#B5443A;color:#fff;border:none;border-radius:6px;font-size:.72rem;font-weight:700;cursor:pointer">Void</button>'):''))        +'</td>'        +'</tr>';
    });;
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
    // Defense-in-depth: holder_name is the obvious XSS sink (user-input field),
    // but escape every interpolated value here. Even system fields like
    // card_number/tier/status get escaped — cheap insurance vs assuming the
    // backend always sanitizes.
    return '<div class="card">'
      +'<div class="logo">🌿 YANI</div>'
      +'<img class="qr" src="'+_esc(qrSrc)+'" alt="QR">'
      +'<div class="num">'+_esc(c.card_number)+'</div>'
      +'<div class="holder">'+(c.holder_name?_esc(c.holder_name):'&nbsp;')+'</div>'
      +'<div class="tier">₱'+_esc(c.tier)+' Stored-Value Card · 10% discount every order</div>'
      +'<div class="status">'+_esc(c.status)+'</div>'
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

// ── Add Cards Modal ──────────────────────────────────────────
function openAddCardsModal() {
  var nums = _cardsAll.map(function(c){ return parseInt(c.card_number.replace('YANI-','')); });
  var lastNum = nums.length > 0 ? Math.max.apply(null, nums) : 1000;
  var nextNum = lastNum + 1;

  // Build a simple modal dynamically
  var existing = document.getElementById('addCardsModal');
  if (existing) existing.remove();

  var m = document.createElement('div');
  m.id = 'addCardsModal';
  m.style.cssText = 'display:flex;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9002;align-items:center;justify-content:center;padding:20px';
  m.innerHTML = '<div style="background:#fff;border-radius:16px;width:100%;max-width:380px;padding:24px">'
    + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">'
    + '<h3 style="font-size:1rem;font-weight:800;color:var(--forest-deep);margin:0">➕ Add New Cards</h3>'
    + '<button onclick="document.getElementById(\'addCardsModal\').remove()" style="background:var(--mist-light);border:none;border-radius:8px;padding:6px 12px;cursor:pointer">✕</button>'
    + '</div>'
    + '<div style="background:var(--mist-light);border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:.82rem;color:var(--timber)">'
    + 'Next card will be: <strong style="color:var(--forest-deep)">YANI-' + String(nextNum).padStart(4,'0') + '</strong>'
    + '</div>'
    + '<label style="font-size:.72rem;font-weight:700;color:var(--timber);display:block;margin-bottom:4px">HOW MANY CARDS TO ADD?</label>'
    + '<input id="addCardsCount" type="number" min="1" max="100" value="10" '
    + 'style="width:100%;padding:9px 12px;border:1.5px solid var(--mist);border-radius:8px;font-size:.95rem;font-family:var(--font-body);box-sizing:border-box;margin-bottom:12px">'
    + '<label style="font-size:.72rem;font-weight:700;color:var(--timber);display:block;margin-bottom:4px">CARD TIER</label>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:16px">'
    + '<label style="display:flex;align-items:center;gap:6px;padding:8px;border:1.5px solid var(--mist);border-radius:8px;cursor:pointer;font-size:.82rem">'
    + '<input type="radio" name="addCardsTier" value="500" checked> ₱500 only</label>'
    + '<label style="display:flex;align-items:center;gap:6px;padding:8px;border:1.5px solid var(--mist);border-radius:8px;cursor:pointer;font-size:.82rem">'
    + '<input type="radio" name="addCardsTier" value="1000"> ₱1000 only</label>'
    + '<label style="display:flex;align-items:center;gap:6px;padding:8px;border:1.5px solid var(--mist);border-radius:8px;cursor:pointer;font-size:.82rem">'
    + '<input type="radio" name="addCardsTier" value="mix"> Mix (50/50)</label>'
    + '</div>'
    + '<div style="display:flex;gap:8px">'
    + '<button onclick="document.getElementById(\'addCardsModal\').remove()" style="flex:1;padding:10px;background:var(--mist-light);border:none;border-radius:8px;font-size:.82rem;font-weight:700;cursor:pointer;color:var(--timber)">Cancel</button>'
    + '<button onclick="_submitAddCards(' + nextNum + ')" style="flex:1;padding:10px;background:var(--forest);color:#fff;border:none;border-radius:8px;font-size:.82rem;font-weight:700;cursor:pointer">Create Cards</button>'
    + '</div>'
    + '</div>';
  document.body.appendChild(m);
}

async function _submitAddCards(startNumber) {
  var count = parseInt(document.getElementById('addCardsCount').value);
  if (isNaN(count) || count < 1 || count > 100) { showToast('❌ Enter 1–100 cards','error'); return; }
  var tierEl = document.querySelector('input[name="addCardsTier"]:checked');
  var tier   = tierEl ? tierEl.value : '500';
  document.getElementById('addCardsModal').remove();
  showToast('Creating ' + count + ' cards…');
  try {
    var r = await _cardApi('batchCreateCards', {
      pin: '2026',
      count: count,
      start_number: startNumber,
      tier: tier
    });
    if (r.ok) {
      showToast('✅ ' + r.created + ' cards created (YANI-' + String(startNumber).padStart(4,'0') + ' to YANI-' + String(startNumber+count-1).padStart(4,'0') + ')');
      await _cardsFetch();
    } else {
      showToast('❌ ' + (r.error||'Failed'),'error');
    }
  } catch(e) { showToast('❌ '+e.message,'error'); }
}

// ── Void transaction (OWNER only) ────────────────────────────────────────
async function _voidTxn(txnId, cardNumber) {
  txnId = String(txnId).trim();
  if (!confirm('Void this transaction? The balance will be reversed.')) return;
  var reason = prompt('Reason for void (required):');
  if (!reason || !reason.trim()) { showToast('❌ Reason required','error'); return; }
  try {
    var r = await _cardApi('reverseTransaction', { pin:'2026', txn_id:txnId, reason:reason.trim() });
    if (r.ok) {
      showToast('✅ Transaction voided — balance restored');
      await openCardTxns(cardNumber);
      await _cardsFetch();
    } else {
      showToast('❌ ' + (r.error||'Void failed'),'error');
    }
  } catch(e) { showToast('❌ '+e.message,'error'); }
}

// ── API helper ────────────────────────────────────────────────
async function _cardApi(action,body){
  var r=await fetch('/api/card',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({action:action},body||{}))});
  return r.json();
}
