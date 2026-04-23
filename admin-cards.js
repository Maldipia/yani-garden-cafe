// ══════════════════════════════════════════════════════════════
// YANI CARDS — Admin Tab
// Features: search, toggle, reload modal, QR per card, print sheet
// ══════════════════════════════════════════════════════════════

var _cardsAll    = [];   // without QR tokens (list view)
var _cardsWithQR = {};   // qr_token keyed by card_number (loaded on demand)
var _cardsFilter = 'ALL';
var _cardsSearch = '';
var _reloadCardNumber = '';

// ── Entry point ───────────────────────────────────────────────
async function loadYaniCardsView() {
  var view = document.getElementById('yaniCardsView');
  if (!view) return;
  if (currentUser.role !== 'OWNER') {
    view.innerHTML = '<div style="padding:60px;text-align:center;color:var(--timber)">🔒 Owner access only</div>';
    return;
  }
  view.innerHTML = _cardsShell();
  await _cardsFetch();
}

// ── Fetch cards (list view — no QR tokens) ────────────────────
async function _cardsFetch() {
  var loading = document.getElementById('cardsLoading');
  var wrap    = document.getElementById('cardsTableWrap');
  if (loading) loading.style.display = 'block';
  if (wrap)    wrap.innerHTML = '';
  try {
    var r = await _cardApi('listCards', { pin: '2026' });
    if (!r.ok) throw new Error(r.error || 'Failed to load cards');
    _cardsAll = r.cards || [];
    _cardsWithQR = {};  // clear cached QR tokens on refresh
    _cardsRender();
  } catch(e) {
    if (wrap) wrap.innerHTML = '<div style="padding:40px;text-align:center;color:#B5443A">❌ ' + e.message + '</div>';
  } finally {
    if (loading) loading.style.display = 'none';
  }
}

// ── Fetch QR tokens for ALL cards (owner-only, for print sheet) ─
async function _fetchAllQR() {
  var r = await _cardApi('listCardsWithQR', { pin: '2026' });
  if (!r.ok) throw new Error(r.error || 'Failed to load QR tokens');
  (r.cards || []).forEach(function(c) {
    _cardsWithQR[c.card_number] = c.qr_token;
  });
  return r.cards || [];
}

// ── Fetch QR token for a single card ─────────────────────────
async function _fetchOneQR(cardNumber) {
  if (_cardsWithQR[cardNumber]) return _cardsWithQR[cardNumber];
  var r = await _cardApi('lookupCard', { card_number: cardNumber, pin: '2026' });
  if (!r.ok) throw new Error(r.error || 'Not found');
  var token = r.card.qr_token;
  _cardsWithQR[cardNumber] = token;
  return token;
}

// ── QR image URL ──────────────────────────────────────────────
function _qrUrl(token, size) {
  return 'https://api.qrserver.com/v1/create-qr-code/?size=' + (size||300) + 'x' + (size||300)
    + '&margin=10&data=' + encodeURIComponent(token);
}

// ── Static shell ──────────────────────────────────────────────
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
    + '<div id="cardsTableWrap" style="padding:0 20px 100px;overflow-x:auto"></div>'

    // ── QR Modal ──────────────────────────────────────────────
    + '<div id="cardQRModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9000;align-items:center;justify-content:center;padding:20px">'
    + '<div style="background:#fff;border-radius:16px;width:100%;max-width:380px;padding:28px;text-align:center">'
    + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">'
    + '<h3 id="qrModalTitle" style="font-size:1rem;font-weight:800;color:var(--forest-deep);margin:0"></h3>'
    + '<button onclick="document.getElementById(\'cardQRModal\').style.display=\'none\'" style="background:var(--mist-light);border:none;border-radius:8px;padding:6px 12px;font-size:.8rem;cursor:pointer">✕</button>'
    + '</div>'
    + '<div id="qrModalContent"></div>'
    + '<div style="display:flex;gap:8px;margin-top:16px">'
    + '<button onclick="_printSingleCard()" style="flex:1;padding:10px;background:var(--forest);color:#fff;border:none;border-radius:8px;font-size:.82rem;font-weight:700;cursor:pointer">🖨️ Print This Card</button>'
    + '<button onclick="document.getElementById(\'cardQRModal\').style.display=\'none\'" style="flex:1;padding:10px;background:var(--mist-light);border:none;border-radius:8px;font-size:.82rem;font-weight:700;cursor:pointer;color:var(--timber)">Close</button>'
    + '</div></div></div>'

    // ── Txn Modal ─────────────────────────────────────────────
    + '<div id="cardTxnModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9000;overflow-y:auto;padding:20px">'
    + '<div style="background:#fff;border-radius:16px;max-width:760px;margin:0 auto;padding:24px">'
    + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">'
    + '<h3 id="cardTxnTitle" style="font-size:1rem;font-weight:800;color:var(--forest-deep);margin:0"></h3>'
    + '<button onclick="document.getElementById(\'cardTxnModal\').style.display=\'none\'" style="background:var(--mist-light);border:none;border-radius:8px;padding:6px 14px;font-size:.8rem;cursor:pointer">✕ Close</button>'
    + '</div><div id="cardTxnBody">Loading…</div></div></div>'

    // ── Reload Modal ──────────────────────────────────────────
    + '<div id="cardReloadModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9000;align-items:center;justify-content:center;padding:20px">'
    + '<div style="background:#fff;border-radius:16px;width:100%;max-width:360px;padding:24px">'
    + '<h3 style="font-size:1rem;font-weight:800;color:var(--forest-deep);margin:0 0 14px">💰 Reload Card</h3>'
    + '<div style="font-size:.82rem;margin-bottom:4px">Card: <strong id="reloadCardNum"></strong></div>'
    + '<div style="font-size:.82rem;margin-bottom:14px;color:var(--timber)">Balance: <strong id="reloadCardBal"></strong></div>'
    + '<label style="font-size:.75rem;font-weight:700;color:var(--timber);display:block;margin-bottom:4px">AMOUNT (₱)</label>'
    + '<input id="reloadAmtInput" type="number" min="100" step="100" placeholder="e.g. 500" '
    + 'style="width:100%;padding:10px 12px;border:1.5px solid var(--mist);border-radius:8px;font-size:.95rem;font-family:var(--font-body);box-sizing:border-box;margin-bottom:8px">'
    + '<div style="display:flex;gap:6px;margin-bottom:14px">'
    + '<button onclick="document.getElementById(\'reloadAmtInput\').value=100" style="flex:1;padding:6px;background:var(--mist-light);border:none;border-radius:6px;font-size:.78rem;font-weight:700;cursor:pointer">₱100</button>'
    + '<button onclick="document.getElementById(\'reloadAmtInput\').value=200" style="flex:1;padding:6px;background:var(--mist-light);border:none;border-radius:6px;font-size:.78rem;font-weight:700;cursor:pointer">₱200</button>'
    + '<button onclick="document.getElementById(\'reloadAmtInput\').value=500" style="flex:1;padding:6px;background:var(--mist-light);border:none;border-radius:6px;font-size:.78rem;font-weight:700;cursor:pointer">₱500</button>'
    + '<button onclick="document.getElementById(\'reloadAmtInput\').value=1000" style="flex:1;padding:6px;background:var(--mist-light);border:none;border-radius:6px;font-size:.78rem;font-weight:700;cursor:pointer">₱1000</button>'
    + '</div>'
    + '<div style="display:flex;gap:8px">'
    + '<button onclick="_closeReloadModal()" style="flex:1;padding:10px;background:var(--mist-light);border:none;border-radius:8px;font-size:.82rem;font-weight:700;cursor:pointer;color:var(--timber)">Cancel</button>'
    + '<button onclick="_submitReload()" style="flex:1;padding:10px;background:#1D4ED8;color:#fff;border:none;border-radius:8px;font-size:.82rem;font-weight:700;cursor:pointer">Reload</button>'
    + '</div></div></div>';
}

// ── Render stats + filters + table ────────────────────────────
function _cardsRender() {
  var cards   = _cardsFiltered();
  var total   = _cardsAll.length;
  var active  = _cardsAll.filter(function(c){ return c.status==='ACTIVE'; }).length;
  var inactive= _cardsAll.filter(function(c){ return c.status==='INACTIVE'; }).length;
  var susp    = _cardsAll.filter(function(c){ return c.status==='SUSPENDED'; }).length;
  var totBal  = _cardsAll.reduce(function(s,c){ return s+parseFloat(c.balance||0); },0);

  var sEl = document.getElementById('cardsStats');
  if (sEl) sEl.innerHTML =
    _cStat('Total','#065F46',total) + _cStat('Active','#1D4ED8',active)
    + _cStat('Inactive','#92400E',inactive) + _cStat('Suspended','#B5443A',susp)
    + _cStat('Total Balance','#5B21B6','₱'+totBal.toFixed(2));

  var fbEl = document.getElementById('cardsFilterBtns');
  if (fbEl) {
    fbEl.innerHTML = ['ALL','ACTIVE','INACTIVE','SUSPENDED','EXPIRED'].map(function(f) {
      var on = _cardsFilter===f;
      var cnt = f==='ALL'?_cardsAll.length:_cardsAll.filter(function(c){return c.status===f;}).length;
      return '<button onclick="_cardsSetFilter(\''+f+'\')" style="padding:6px 12px;border-radius:20px;border:none;font-size:.75rem;font-weight:700;cursor:pointer;background:'
        +(on?'var(--forest)':'var(--mist-light)')+';color:'+(on?'#fff':'var(--timber)')+'">'+f+' ('+cnt+')</button>';
    }).join('');
  }

  var wrap = document.getElementById('cardsTableWrap');
  if (!wrap) return;
  if (cards.length===0) {
    wrap.innerHTML = '<div style="padding:40px;text-align:center;color:var(--timber)">No cards match your search</div>';
    return;
  }

  var html = '<table style="width:100%;border-collapse:collapse;font-size:.82rem">';
  html += '<thead><tr style="background:var(--mist-light)">';
  ['Card #','Holder','Phone','Tier','Balance','Status','ON/OFF','Actions'].forEach(function(h) {
    html += '<th style="padding:9px 10px;text-align:left;font-weight:700;color:var(--forest-deep);white-space:nowrap">'+h+'</th>';
  });
  html += '</tr></thead><tbody>';

  cards.forEach(function(c, i) {
    var bg   = i%2===0 ? '#fff' : 'var(--mist-light)';
    var sc   = c.status==='ACTIVE' ? '#065F46' : c.status==='SUSPENDED' ? '#B5443A' : '#92400E';
    var isOn = c.status==='ACTIVE';
    var togBg  = isOn ? '#22c55e' : '#d1d5db';
    var togPos = isOn ? 'translateX(18px)' : 'translateX(2px)';
    var togFn  = isOn ? "_cardToggleOff('"+c.card_number+"')"
      : (c.status==='INACTIVE' ? "openCardActivate('"+c.card_number+"')" : "_cardToggleOn('"+c.card_number+"')");

    html += '<tr style="background:'+bg+';border-bottom:1px solid var(--mist)">';
    html += '<td style="padding:9px 10px;font-weight:700;font-family:monospace;color:var(--forest-deep)">'+c.card_number+'</td>';
    html += '<td style="padding:9px 10px">'+(c.holder_name||'<span style="color:#9CA3AF;font-style:italic">—</span>')+'</td>';
    html += '<td style="padding:9px 10px;color:var(--timber)">'+(c.holder_phone||'—')+'</td>';
    html += '<td style="padding:9px 10px"><span style="background:var(--mist-light);border-radius:4px;padding:2px 8px;font-weight:700;font-size:.78rem">₱'+c.tier+'</span></td>';
    html += '<td style="padding:9px 10px;font-weight:800;color:var(--forest-deep)">₱'+parseFloat(c.balance||0).toFixed(2)+'</td>';
    html += '<td style="padding:9px 10px"><span style="background:'+sc+';color:#fff;border-radius:12px;padding:2px 9px;font-size:.72rem;font-weight:700">'+c.status+'</span></td>';

    // Toggle
    html += '<td style="padding:9px 10px">'
      + '<div onclick="'+togFn+'" title="'+(isOn?'Click to suspend':'Click to activate')+'" '
      + 'style="width:40px;height:22px;background:'+togBg+';border-radius:11px;cursor:pointer;position:relative;transition:background .2s;display:inline-block">'
      + '<div style="position:absolute;top:2px;width:18px;height:18px;background:#fff;border-radius:50%;transform:'+togPos+';transition:transform .2s;box-shadow:0 1px 3px rgba(0,0,0,.25)"></div>'
      + '</div></td>';

    // Actions
    html += '<td style="padding:9px 10px;white-space:nowrap">';
    html += '<button onclick="openCardQR(\''+c.card_number+'\')" title="Show QR Code" style="background:var(--forest);color:#fff;border:none;border-radius:6px;padding:5px 10px;font-size:.8rem;cursor:pointer;margin-right:4px">📱 QR</button>';
    if (c.status==='INACTIVE') {
      html += '<button onclick="openCardActivate(\''+c.card_number+'\')" style="background:#92400E;color:#fff;border:none;border-radius:6px;padding:5px 10px;font-size:.75rem;font-weight:700;cursor:pointer;margin-right:4px">Activate</button>';
    }
    if (c.status==='ACTIVE') {
      html += '<button onclick="openCardReload(\''+c.card_number+'\',\''+parseFloat(c.balance||0).toFixed(2)+'\')" style="background:#1D4ED8;color:#fff;border:none;border-radius:6px;padding:5px 10px;font-size:.75rem;font-weight:700;cursor:pointer;margin-right:4px">Reload</button>';
    }
    html += '<button onclick="openCardTxns(\''+c.card_number+'\')" style="background:var(--mist-light);color:var(--timber);border:none;border-radius:6px;padding:5px 10px;font-size:.75rem;font-weight:700;cursor:pointer">History</button>';
    html += '</td></tr>';
  });

  html += '</tbody></table>';
  wrap.innerHTML = html;
}

function _cStat(label, color, val) {
  return '<div style="background:var(--mist-light);border-radius:10px;padding:10px 12px;border-left:3px solid '+color+'">'
    +'<div style="font-size:.65rem;font-weight:700;color:var(--timber);text-transform:uppercase;letter-spacing:.4px">'+label+'</div>'
    +'<div style="font-size:1.1rem;font-weight:800;color:'+color+';margin-top:2px">'+val+'</div>'
    +'</div>';
}

// ── QR Modal — show one card's QR ──────────────────────────────
var _qrCurrentCard = null;
async function openCardQR(cardNumber) {
  var card = _cardsAll.find(function(c){ return c.card_number===cardNumber; });
  if (!card) return;
  _qrCurrentCard = card;

  document.getElementById('qrModalTitle').textContent = '📱 QR — ' + cardNumber;
  document.getElementById('qrModalContent').innerHTML = '<div style="padding:20px;text-align:center;color:var(--timber)">Loading QR…</div>';
  document.getElementById('cardQRModal').style.display = 'flex';

  try {
    var token = await _fetchOneQR(cardNumber);
    var qrSrc = _qrUrl(token, 280);
    document.getElementById('qrModalContent').innerHTML =
      '<img src="'+qrSrc+'" style="width:200px;height:200px;border-radius:8px;border:2px solid var(--mist)" alt="QR Code"><br>'
      + '<div style="margin-top:12px;font-family:monospace;font-size:.78rem;color:var(--timber);word-break:break-all;background:var(--mist-light);border-radius:6px;padding:6px 10px">'+token+'</div>'
      + '<div style="margin-top:10px;font-size:.78rem;color:var(--timber)">'
      + '<strong>'+cardNumber+'</strong>'
      + (card.holder_name ? ' · '+card.holder_name : '')
      + ' · ₱'+card.tier+' tier'
      + '<br>Balance: ₱'+parseFloat(card.balance||0).toFixed(2)
      + ' · <span style="color:'+(card.status==='ACTIVE'?'#065F46':'#B5443A')+'">'+card.status+'</span>'
      + '</div>';
  } catch(e) {
    document.getElementById('qrModalContent').innerHTML = '<p style="color:#B5443A">❌ '+e.message+'</p>';
  }
}

// ── Print single card ──────────────────────────────────────────
function _printSingleCard() {
  if (!_qrCurrentCard) return;
  var c = _qrCurrentCard;
  var token = _cardsWithQR[c.card_number];
  if (!token) { showToast('❌ QR token not loaded yet','error'); return; }
  _openPrintWindow([c], { token: token });
}

// ── Print ALL cards sheet ──────────────────────────────────────
async function openPrintAllSheet() {
  showToast('Loading QR codes for all cards…');
  try {
    var cards = await _fetchAllQR();
    _openPrintWindow(cards, null);
  } catch(e) {
    showToast('❌ '+e.message,'error');
  }
}

// ── Build print window ─────────────────────────────────────────
function _openPrintWindow(cards, single) {
  var w = window.open('','_blank','width=900,height=700');
  if (!w) { showToast('❌ Allow pop-ups to print','error'); return; }

  var cardsHtml = cards.map(function(c) {
    var token = single ? single.token : c.qr_token;
    var qrSrc = _qrUrl(token, 220);
    return '<div class="card">'
      + '<div class="card-logo">🌿 YANI</div>'
      + '<img class="card-qr" src="'+qrSrc+'" alt="QR">'
      + '<div class="card-num">'+c.card_number+'</div>'
      + '<div class="card-holder">'+(c.holder_name||'&nbsp;')+'</div>'
      + '<div class="card-tier">₱'+c.tier+' Stored-Value Card · 10% discount every order</div>'
      + '<div class="card-status">'+c.status+'</div>'
      + '</div>';
  }).join('');

  w.document.write('<!DOCTYPE html><html><head><title>Yani Cards — QR Codes</title>'
    + '<style>'
    + 'body{margin:0;padding:20px;font-family:Arial,sans-serif;background:#f5f5f5}'
    + 'h1{text-align:center;font-size:1.1rem;color:#1a3c1a;margin-bottom:20px}'
    + '.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}'
    + '.card{background:#fff;border-radius:12px;padding:16px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.12);break-inside:avoid}'
    + '.card-logo{font-size:1rem;font-weight:800;color:#1a3c1a;letter-spacing:2px;margin-bottom:8px}'
    + '.card-qr{width:140px;height:140px;border-radius:6px;border:2px solid #e5e7eb}'
    + '.card-num{font-family:monospace;font-size:.95rem;font-weight:700;color:#1a3c1a;margin-top:8px}'
    + '.card-holder{font-size:.78rem;color:#555;min-height:18px;margin-top:2px}'
    + '.card-tier{font-size:.68rem;color:#777;margin-top:4px}'
    + '.card-status{display:inline-block;margin-top:6px;font-size:.65rem;font-weight:700;padding:2px 8px;border-radius:10px;background:#e5e7eb;color:#374151}'
    + '@media print{body{background:#fff;padding:0}.no-print{display:none}}'
    + '</style></head><body>'
    + '<h1 class="no-print">🌿 Yani Cards — Print Sheet ('+cards.length+' cards)</h1>'
    + '<div class="no-print" style="text-align:center;margin-bottom:16px">'
    + '<button onclick="window.print()" style="padding:10px 24px;background:#1a3c1a;color:#fff;border:none;border-radius:8px;font-size:.9rem;font-weight:700;cursor:pointer">🖨️ Print</button>'
    + '</div>'
    + '<div class="grid">'+cardsHtml+'</div>'
    + '</body></html>');
  w.document.close();
}

// ── Helpers ───────────────────────────────────────────────────
function _cardsOnSearch(val) { _cardsSearch=val.toLowerCase().trim(); _cardsRender(); }
function _cardsSetFilter(f)  { _cardsFilter=f; _cardsRender(); }
function _cardsFiltered() {
  return _cardsAll.filter(function(c) {
    var mf = _cardsFilter==='ALL' || c.status===_cardsFilter;
    var q  = _cardsSearch;
    var ms = !q
      || (c.card_number||'').toLowerCase().includes(q)
      || (c.holder_name||'').toLowerCase().includes(q)
      || (c.holder_phone||'').toLowerCase().includes(q);
    return mf && ms;
  });
}

// ── Toggle ON ─────────────────────────────────────────────────
async function _cardToggleOn(cardNumber) {
  try {
    var r = await _cardApi('setCardStatus',{pin:'2026',card_number:cardNumber,status:'ACTIVE',reason:'Reinstated by owner'});
    if (r.ok) { showToast('✅ '+cardNumber+' reinstated'); await _cardsFetch(); }
    else showToast('❌ '+(r.error||'Failed'),'error');
  } catch(e) { showToast('❌ '+e.message,'error'); }
}

// ── Toggle OFF ────────────────────────────────────────────────
async function _cardToggleOff(cardNumber) {
  if (!confirm('Suspend '+cardNumber+'?\nCustomer won\'t be able to use it until reinstated.')) return;
  try {
    var r = await _cardApi('setCardStatus',{pin:'2026',card_number:cardNumber,status:'SUSPENDED',reason:'Suspended by owner'});
    if (r.ok) { showToast('⚠️ '+cardNumber+' suspended'); await _cardsFetch(); }
    else showToast('❌ '+(r.error||'Failed'),'error');
  } catch(e) { showToast('❌ '+e.message,'error'); }
}

// ── Activate ──────────────────────────────────────────────────
function openCardActivate(cardNumber) {
  var holder = prompt('Holder name (press OK to skip):');
  if (holder===null) return;
  var phone  = prompt('Holder phone (press OK to skip):');
  if (phone===null) return;
  (async function() {
    try {
      if ((holder||'').trim()||(phone||'').trim()) {
        await fetch('/api/pos',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({action:'setCardHolder',card_number:cardNumber,holder_name:holder||null,holder_phone:phone||null,userId:currentUser.userId,token:currentUser.token})});
      }
      var r = await _cardApi('activateCard',{card_number:cardNumber,performed_by:currentUser.userId||'OWNER'});
      if (r.ok) { showToast('✅ '+cardNumber+' activated! Balance: ₱'+parseFloat(r.balance_after||0).toFixed(2)); await _cardsFetch(); }
      else showToast('❌ '+(r.error||'Activation failed'),'error');
    } catch(e) { showToast('❌ '+e.message,'error'); }
  })();
}

// ── Reload modal ──────────────────────────────────────────────
function openCardReload(cardNumber, currentBal) {
  _reloadCardNumber = cardNumber;
  document.getElementById('reloadCardNum').textContent = cardNumber;
  document.getElementById('reloadCardBal').textContent = '₱'+currentBal;
  document.getElementById('reloadAmtInput').value = '';
  document.getElementById('cardReloadModal').style.display = 'flex';
}
function _closeReloadModal() { document.getElementById('cardReloadModal').style.display='none'; }
async function _submitReload() {
  var amt = parseFloat(document.getElementById('reloadAmtInput').value);
  if (isNaN(amt)||amt<=0) { showToast('❌ Enter a valid amount','error'); return; }
  _closeReloadModal();
  try {
    var r = await _cardApi('reloadCard',{card_number:_reloadCardNumber,amount:amt,performed_by:currentUser.userId||'OWNER'});
    if (r.ok) { showToast('✅ Reloaded ₱'+amt.toFixed(2)+' → Balance: ₱'+parseFloat(r.balance||0).toFixed(2)); await _cardsFetch(); }
    else showToast('❌ '+(r.error||'Reload failed'),'error');
  } catch(e) { showToast('❌ '+e.message,'error'); }
}

// ── Transaction history ───────────────────────────────────────
async function openCardTxns(cardNumber) {
  document.getElementById('cardTxnTitle').textContent = '📋 History — '+cardNumber;
  document.getElementById('cardTxnBody').innerHTML = 'Loading…';
  document.getElementById('cardTxnModal').style.display = 'block';
  try {
    var r = await _cardApi('getCardTransactions',{pin:'2026',card_number:cardNumber,limit:50});
    if (!r.ok) throw new Error(r.error||'Failed');
    var txns = r.transactions||[];
    if (!txns.length) {
      document.getElementById('cardTxnBody').innerHTML='<p style="text-align:center;padding:30px;color:var(--timber)">No transactions yet</p>';
      return;
    }
    var tc={'CHARGE':'#B5443A','RELOAD':'#1D4ED8','ACTIVATE':'#065F46','REVERSE':'#92400E','SUSPEND':'#6B7280','REINSTATE':'#065F46','ADJUST':'#5B21B6'};
    var html='<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:.8rem">';
    html+='<thead><tr style="background:var(--mist-light)">';
    ['Date/Time','Type','Amount','Saved','Before','After','Order','By'].forEach(function(h){
      html+='<th style="padding:7px 9px;text-align:left;font-weight:700;color:var(--forest-deep);white-space:nowrap">'+h+'</th>';
    });
    html+='</tr></thead><tbody>';
    txns.forEach(function(t,i){
      var bg=i%2===0?'#fff':'var(--mist-light)';
      var dt=new Date(t.created_at);
      var ds=dt.toLocaleDateString('en-PH',{month:'short',day:'numeric',year:'2-digit'})+' '+dt.toLocaleTimeString('en-PH',{hour:'2-digit',minute:'2-digit'});
      var disc=parseFloat(t.discount_amount||0);
      html+='<tr style="background:'+bg+';border-bottom:1px solid var(--mist)">';
      html+='<td style="padding:7px 9px;white-space:nowrap;color:var(--timber)">'+ds+'</td>';
      html+='<td style="padding:7px 9px"><span style="background:'+(tc[t.type]||'#374151')+';color:#fff;border-radius:10px;padding:2px 8px;font-size:.7rem;font-weight:700">'+t.type+'</span></td>';
      html+='<td style="padding:7px 9px;font-weight:700">₱'+parseFloat(t.amount||0).toFixed(2)+'</td>';
      html+='<td style="padding:7px 9px;color:#065F46;font-weight:700">'+(disc>0?'₱'+disc.toFixed(2):'—')+'</td>';
      html+='<td style="padding:7px 9px">₱'+parseFloat(t.balance_before||0).toFixed(2)+'</td>';
      html+='<td style="padding:7px 9px;font-weight:700">₱'+parseFloat(t.balance_after||0).toFixed(2)+'</td>';
      html+='<td style="padding:7px 9px;font-size:.72rem;color:var(--timber)">'+(t.order_id||'—')+'</td>';
      html+='<td style="padding:7px 9px;font-size:.72rem;color:var(--timber)">'+(t.performed_by||'—')+'</td>';
      html+='</tr>';
    });
    html+='</tbody></table></div>';
    document.getElementById('cardTxnBody').innerHTML=html;
  } catch(e) {
    document.getElementById('cardTxnBody').innerHTML='<p style="color:#B5443A;padding:20px">❌ '+e.message+'</p>';
  }
}

// ── API helper ────────────────────────────────────────────────
async function _cardApi(action, body) {
  var r = await fetch('/api/card',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(Object.assign({action:action},body||{}))
  });
  return r.json();
}
