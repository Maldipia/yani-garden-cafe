// ══════════════════════════════════════════════════════════════
// YANI CARDS — Admin Panel Tab
// Owner-only: list, activate, reload, adjust, suspend, view txns
// ══════════════════════════════════════════════════════════════

var _cardsData     = [];
var _cardsTxnData  = [];
var _cardsFilter   = 'ALL';

async function loadYaniCardsView() {
  var view = document.getElementById('yaniCardsView');
  if (!view) return;

  // Only OWNER can access this tab
  if (currentRole !== 'OWNER') {
    view.innerHTML = '<div style="padding:40px;text-align:center;color:var(--timber)">🔒 Owner access only</div>';
    return;
  }

  view.innerHTML = '<div style="padding:40px;text-align:center;color:var(--timber)">Loading cards…</div>';

  try {
    var r = await api('listCards', { pin: '2026' }, '/api/card');
    if (!r.ok) throw new Error(r.error || 'Failed to load cards');
    _cardsData = r.cards || [];
    renderYaniCardsView();
  } catch(e) {
    view.innerHTML = '<div style="padding:40px;text-align:center;color:#B5443A">❌ ' + e.message + '</div>';
  }
}

function renderYaniCardsView() {
  var view = document.getElementById('yaniCardsView');
  if (!view) return;

  var total   = _cardsData.length;
  var active  = _cardsData.filter(function(c){ return c.status === 'ACTIVE'; }).length;
  var inactive= _cardsData.filter(function(c){ return c.status === 'INACTIVE'; }).length;
  var suspended=_cardsData.filter(function(c){ return c.status === 'SUSPENDED'; }).length;
  var totalBal= _cardsData.reduce(function(s,c){ return s + parseFloat(c.balance||0); }, 0);

  var filtered = _cardsFilter === 'ALL' ? _cardsData
    : _cardsData.filter(function(c){ return c.status === _cardsFilter; });

  var html = '';

  // ── Header ──────────────────────────────────────────────────
  html += '<div style="padding:20px 20px 0">';
  html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">';
  html += '<h2 style="font-size:1.2rem;font-weight:800;color:var(--forest-deep);margin:0">💳 Yani Cards</h2>';
  html += '<button onclick="loadYaniCardsView()" style="background:var(--mist-light);border:none;border-radius:8px;padding:8px 14px;font-size:.8rem;font-weight:700;cursor:pointer;color:var(--timber)">🔄 Refresh</button>';
  html += '</div>';

  // ── Stats row ────────────────────────────────────────────────
  html += '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px">';
  html += _cardStat('Total Cards', total, '#065F46');
  html += _cardStat('Active', active, '#1D4ED8');
  html += _cardStat('Inactive', inactive, '#92400E');
  html += _cardStat('Total Balance', '₱' + totalBal.toFixed(2), '#5B21B6');
  html += '</div>';

  // ── Filter tabs ──────────────────────────────────────────────
  html += '<div style="display:flex;gap:8px;margin-bottom:14px">';
  for (var _f of ['ALL','ACTIVE','INACTIVE','SUSPENDED','EXPIRED']) {
    var _active = _cardsFilter === _f;
    html += '<button onclick="setCardsFilter(\'' + _f + '\')" style="padding:6px 14px;border-radius:20px;border:none;font-size:.78rem;font-weight:700;cursor:pointer;background:'
      + (_active ? 'var(--forest)' : 'var(--mist-light)') + ';color:'
      + (_active ? '#fff' : 'var(--timber)') + '">' + _f + '</button>';
  }
  html += '</div>';
  html += '</div>';

  // ── Cards table ──────────────────────────────────────────────
  html += '<div style="padding:0 20px">';
  if (filtered.length === 0) {
    html += '<div style="padding:40px;text-align:center;color:var(--timber)">No cards found</div>';
  } else {
    html += '<div style="overflow-x:auto">';
    html += '<table style="width:100%;border-collapse:collapse;font-size:.82rem">';
    html += '<thead><tr style="background:var(--mist-light)">';
    for (var _h of ['Card #','Holder','Tier','Balance','Loaded','Spent','Saved','Status','Actions']) {
      html += '<th style="padding:8px 10px;text-align:left;font-weight:700;color:var(--forest-deep);white-space:nowrap">' + _h + '</th>';
    }
    html += '</tr></thead><tbody>';

    filtered.forEach(function(c, idx) {
      var bg = idx % 2 === 0 ? '#fff' : 'var(--mist-light)';
      var statusColor = c.status==='ACTIVE' ? '#065F46' : c.status==='SUSPENDED' ? '#B5443A' : '#92400E';
      html += '<tr style="background:' + bg + ';border-bottom:1px solid var(--mist)">';
      html += '<td style="padding:8px 10px;font-weight:700;font-family:monospace">' + c.card_number + '</td>';
      html += '<td style="padding:8px 10px">' + (c.holder_name || '<span style="color:var(--timber);font-style:italic">Unassigned</span>') + '</td>';
      html += '<td style="padding:8px 10px"><span style="background:var(--mist-light);border-radius:4px;padding:2px 6px;font-weight:700">₱' + c.tier + '</span></td>';
      html += '<td style="padding:8px 10px;font-weight:800;color:var(--forest-deep)">₱' + parseFloat(c.balance||0).toFixed(2) + '</td>';
      html += '<td style="padding:8px 10px;color:var(--timber)">₱' + parseFloat(c.total_loaded||0).toFixed(2) + '</td>';
      html += '<td style="padding:8px 10px;color:var(--timber)">₱' + parseFloat(c.total_spent||0).toFixed(2) + '</td>';
      html += '<td style="padding:8px 10px;color:#065F46;font-weight:700">₱' + parseFloat(c.total_saved||0).toFixed(2) + '</td>';
      html += '<td style="padding:8px 10px"><span style="background:' + statusColor + ';color:#fff;border-radius:12px;padding:2px 8px;font-size:.72rem;font-weight:700">' + c.status + '</span></td>';
      html += '<td style="padding:8px 10px;white-space:nowrap">';

      if (c.status === 'INACTIVE') {
        html += '<button onclick="openCardActivate(\'' + c.card_number + '\')" style="background:var(--forest);color:#fff;border:none;border-radius:6px;padding:4px 10px;font-size:.75rem;font-weight:700;cursor:pointer;margin-right:4px">Activate</button>';
      }
      if (c.status === 'ACTIVE') {
        html += '<button onclick="openCardReload(\'' + c.card_number + '\')" style="background:#1D4ED8;color:#fff;border:none;border-radius:6px;padding:4px 10px;font-size:.75rem;font-weight:700;cursor:pointer;margin-right:4px">Reload</button>';
        html += '<button onclick="openCardSuspend(\'' + c.card_number + '\')" style="background:#B5443A;color:#fff;border:none;border-radius:6px;padding:4px 10px;font-size:.75rem;font-weight:700;cursor:pointer;margin-right:4px">Suspend</button>';
      }
      if (c.status === 'SUSPENDED') {
        html += '<button onclick="cardReinstate(\'' + c.card_number + '\')" style="background:var(--forest);color:#fff;border:none;border-radius:6px;padding:4px 10px;font-size:.75rem;font-weight:700;cursor:pointer;margin-right:4px">Reinstate</button>';
      }
      html += '<button onclick="openCardTxns(\'' + c.card_number + '\')" style="background:var(--mist-light);color:var(--timber);border:none;border-radius:6px;padding:4px 10px;font-size:.75rem;font-weight:700;cursor:pointer">History</button>';
      html += '</td></tr>';
    });

    html += '</tbody></table></div>';
  }
  html += '</div>';

  view.innerHTML = html;
}

function _cardStat(label, val, color) {
  return '<div style="background:var(--mist-light);border-radius:10px;padding:12px 14px;border-left:3px solid ' + color + '">'
    + '<div style="font-size:.68rem;font-weight:700;color:var(--timber);text-transform:uppercase;margin-bottom:4px">' + label + '</div>'
    + '<div style="font-size:1.2rem;font-weight:800;color:' + color + '">' + val + '</div>'
    + '</div>';
}

function setCardsFilter(f) {
  _cardsFilter = f;
  renderYaniCardsView();
}

// ── ACTIVATE ────────────────────────────────────────────────────
function openCardActivate(cardNumber) {
  var holder = prompt('Holder name (or leave blank):');
  if (holder === null) return; // cancelled
  var phone = prompt('Holder phone (or leave blank):');
  if (phone === null) return;

  // Update holder info then activate
  (async function() {
    try {
      // Set holder info via pos API
      if (holder || phone) {
        await apiPost('/api/pos', { action: 'updateCardHolder', card_number: cardNumber, holder_name: holder, holder_phone: phone, userId: currentUserId, token: currentToken });
      }
      var r = await api('activateCard', { card_number: cardNumber, performed_by: currentUserId }, '/api/card');
      if (r.ok) {
        showToast('✅ ' + cardNumber + ' activated! Balance: ₱' + parseFloat(r.balance_after||0).toFixed(2));
        loadYaniCardsView();
      } else {
        showToast('❌ ' + (r.error || 'Activation failed'), 'error');
      }
    } catch(e) {
      showToast('❌ ' + e.message, 'error');
    }
  })();
}

// ── RELOAD ──────────────────────────────────────────────────────
function openCardReload(cardNumber) {
  var amtStr = prompt('Reload amount (₱):');
  if (amtStr === null) return;
  var amt = parseFloat(amtStr);
  if (isNaN(amt) || amt <= 0) { showToast('❌ Invalid amount', 'error'); return; }

  (async function() {
    try {
      var r = await api('reloadCard', { card_number: cardNumber, amount: amt, performed_by: currentUserId }, '/api/card');
      if (r.ok) {
        showToast('✅ Reloaded ₱' + amt.toFixed(2) + ' → Balance: ₱' + parseFloat(r.balance||0).toFixed(2));
        loadYaniCardsView();
      } else {
        showToast('❌ ' + (r.error || 'Reload failed'), 'error');
      }
    } catch(e) {
      showToast('❌ ' + e.message, 'error');
    }
  })();
}

// ── SUSPEND ─────────────────────────────────────────────────────
function openCardSuspend(cardNumber) {
  var reason = prompt('Reason for suspension:');
  if (reason === null) return;
  if (!reason.trim()) { showToast('❌ Reason required', 'error'); return; }

  (async function() {
    try {
      var r = await api('setCardStatus', { pin: '2026', card_number: cardNumber, status: 'SUSPENDED', reason: reason }, '/api/card');
      if (r.ok) {
        showToast('⚠️ ' + cardNumber + ' suspended');
        loadYaniCardsView();
      } else {
        showToast('❌ ' + (r.error || 'Failed'), 'error');
      }
    } catch(e) {
      showToast('❌ ' + e.message, 'error');
    }
  })();
}

// ── REINSTATE ───────────────────────────────────────────────────
function cardReinstate(cardNumber) {
  (async function() {
    try {
      var r = await api('setCardStatus', { pin: '2026', card_number: cardNumber, status: 'ACTIVE', reason: 'Reinstated by owner' }, '/api/card');
      if (r.ok) {
        showToast('✅ ' + cardNumber + ' reinstated');
        loadYaniCardsView();
      } else {
        showToast('❌ ' + (r.error || 'Failed'), 'error');
      }
    } catch(e) {
      showToast('❌ ' + e.message, 'error');
    }
  })();
}

// ── TRANSACTION HISTORY ─────────────────────────────────────────
function openCardTxns(cardNumber) {
  var modal = document.getElementById('cardTxnModal');
  if (!modal) {
    // Create modal
    var m = document.createElement('div');
    m.id = 'cardTxnModal';
    m.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9000;overflow-y:auto;padding:20px';
    m.innerHTML = '<div style="background:#fff;border-radius:16px;max-width:700px;margin:0 auto;padding:24px">'
      + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">'
      + '<h3 id="cardTxnTitle" style="font-size:1rem;font-weight:800;color:var(--forest-deep);margin:0"></h3>'
      + '<button onclick="document.getElementById(\'cardTxnModal\').style.display=\'none\'" style="background:var(--mist-light);border:none;border-radius:8px;padding:6px 12px;font-size:.8rem;cursor:pointer">✕ Close</button>'
      + '</div>'
      + '<div id="cardTxnBody">Loading…</div>'
      + '</div>';
    document.body.appendChild(m);
    modal = m;
  }
  document.getElementById('cardTxnTitle').textContent = '📋 Transaction History — ' + cardNumber;
  document.getElementById('cardTxnBody').innerHTML = 'Loading…';
  modal.style.display = 'block';

  (async function() {
    try {
      var r = await api('getCardTransactions', { pin: '2026', card_number: cardNumber, limit: 50 }, '/api/card');
      if (!r.ok) throw new Error(r.error || 'Failed');
      var txns = r.transactions || [];
      if (txns.length === 0) {
        document.getElementById('cardTxnBody').innerHTML = '<p style="text-align:center;color:var(--timber)">No transactions yet</p>';
        return;
      }
      var html = '<table style="width:100%;border-collapse:collapse;font-size:.8rem">';
      html += '<thead><tr style="background:var(--mist-light)">';
      for (var h of ['Date','Type','Amount','Discount','Balance Before','Balance After','Order','By']) {
        html += '<th style="padding:6px 8px;text-align:left;font-weight:700;color:var(--forest-deep)">' + h + '</th>';
      }
      html += '</tr></thead><tbody>';
      txns.forEach(function(t, i) {
        var bg = i%2===0?'#fff':'var(--mist-light)';
        var typeColor = t.type==='CHARGE'?'#B5443A':t.type==='RELOAD'?'#1D4ED8':t.type==='ACTIVATE'?'#065F46':'#92400E';
        var dt = new Date(t.created_at);
        var dtStr = dt.toLocaleDateString('en-PH',{month:'short',day:'numeric'}) + ' ' + dt.toLocaleTimeString('en-PH',{hour:'2-digit',minute:'2-digit'});
        html += '<tr style="background:' + bg + ';border-bottom:1px solid var(--mist)">';
        html += '<td style="padding:6px 8px;white-space:nowrap">' + dtStr + '</td>';
        html += '<td style="padding:6px 8px"><span style="background:' + typeColor + ';color:#fff;border-radius:10px;padding:1px 7px;font-size:.7rem;font-weight:700">' + t.type + '</span></td>';
        html += '<td style="padding:6px 8px;font-weight:700">₱' + parseFloat(t.amount||0).toFixed(2) + '</td>';
        html += '<td style="padding:6px 8px;color:#065F46">' + (parseFloat(t.discount_amount||0) > 0 ? '₱'+parseFloat(t.discount_amount).toFixed(2) : '—') + '</td>';
        html += '<td style="padding:6px 8px">₱' + parseFloat(t.balance_before||0).toFixed(2) + '</td>';
        html += '<td style="padding:6px 8px;font-weight:700">₱' + parseFloat(t.balance_after||0).toFixed(2) + '</td>';
        html += '<td style="padding:6px 8px;font-size:.72rem;color:var(--timber)">' + (t.order_id || '—') + '</td>';
        html += '<td style="padding:6px 8px;font-size:.72rem;color:var(--timber)">' + (t.performed_by || '—') + '</td>';
        html += '</tr>';
      });
      html += '</tbody></table>';
      document.getElementById('cardTxnBody').innerHTML = html;
    } catch(e) {
      document.getElementById('cardTxnBody').innerHTML = '<p style="color:#B5443A">❌ ' + e.message + '</p>';
    }
  })();
}

// ── Helper: POST to card API ──────────────────────────────────────
async function api(action, body, endpoint) {
  var url = endpoint || '/api/pos';
  var r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ action: action }, body))
  });
  return r.json();
}

async function apiPost(url, body) {
  var r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return r.json();
}
