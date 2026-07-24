// ── Admin: Card Load Requests ─────────────────────────────────────────────────
var _cardLoadsData = [];
var _cardLoadsTab = 'PENDING'; // PENDING | AI_REVIEW

async function initCardLoads() {
  _renderCardLoadsTabs();
  await loadCardLoads('PENDING');
}

// Tab strip: manual queue vs AI daily review
function _renderCardLoadsTabs() {
  var host = document.getElementById('cardLoadsTabs');
  if (!host) {
    var grid = document.getElementById('cardLoadsGrid');
    if (grid && grid.parentNode) {
      host = document.createElement('div');
      host.id = 'cardLoadsTabs';
      host.style.cssText = 'display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap';
      grid.parentNode.insertBefore(host, grid);
    }
  }
  if (!host) return;
  var mk = function(key,label){
    var active = _cardLoadsTab===key;
    return '<button onclick="switchCardLoadsTab(\''+key+'\')" style="padding:7px 14px;border-radius:18px;border:1.5px solid '+(active?'var(--forest)':'var(--mist)')+';background:'+(active?'var(--forest)':'#fff')+';color:'+(active?'#fff':'var(--timber)')+';font-size:.78rem;font-weight:700;cursor:pointer">'+label+'</button>';
  };
  host.innerHTML = mk('PENDING','📋 Manual Queue') + mk('AI_REVIEW','🤖 AI Auto-Credits (Today)');
}

function switchCardLoadsTab(tab) {
  _cardLoadsTab = tab;
  _renderCardLoadsTabs();
  if (tab === 'AI_REVIEW') loadAiCreditedLoads();
  else loadCardLoads('PENDING');
}

// Daily review of AI auto-credited (and AI-held) loads
async function loadAiCreditedLoads() {
  var grid = document.getElementById('cardLoadsGrid');
  if (!grid) return;
  grid.innerHTML = '<div style="text-align:center;padding:40px;color:var(--timber)">Loading AI activity…</div>';
  try {
    var today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' }); // YYYY-MM-DD
    var r = await api('getAiCreditedLoads', { date: today });
    var loads = (r && r.loads) || [];
    var sum = (r && r.summary) || { auto_credited:0, auto_credited_total:0, held:0 };
    var head = '<div style="background:var(--mist-light);border-radius:12px;padding:14px 16px;margin-bottom:14px;display:flex;gap:20px;flex-wrap:wrap">'
      + '<div><div style="font-size:1.3rem;font-weight:800;color:var(--forest-deep)">'+sum.auto_credited+'</div><div style="font-size:.72rem;color:var(--timber)">auto-credited today</div></div>'
      + '<div><div style="font-size:1.3rem;font-weight:800;color:var(--forest-deep)">₱'+(sum.auto_credited_total||0).toLocaleString()+'</div><div style="font-size:.72rem;color:var(--timber)">total credited</div></div>'
      + '<div><div style="font-size:1.3rem;font-weight:800;color:#c2410c">'+sum.held+'</div><div style="font-size:.72rem;color:var(--timber)">held for review</div></div>'
      + '<div style="flex:1;min-width:180px;font-size:.72rem;color:var(--timber);align-self:center;font-style:italic">Spot-check these against your GCash inbox using the reference numbers.</div>'
      + '</div>';
    if (!loads.length) {
      grid.innerHTML = head + '<div style="text-align:center;padding:40px;color:var(--timber);font-size:.85rem">No AI activity today yet.</div>';
      return;
    }
    grid.innerHTML = head + loads.map(_renderAiLoadCard).join('');
  } catch(e) {
    grid.innerHTML = '<div style="padding:20px;color:#dc2626">Failed to load AI activity: ' + e.message + '</div>';
  }
}

function _renderAiLoadCard(x) {
  var dt = new Date(x.requested_at).toLocaleString('en-PH',{timeZone:'Asia/Manila',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
  var statusMeta = {
    AUTO_CREDITED: { label:'✅ Auto-credited', color:'#166534', bg:'#dcfce7' },
    HELD_MISMATCH: { label:'⚠️ Held — amount mismatch', color:'#9a3412', bg:'#ffedd5' },
    HELD_OVER_CAP: { label:'⚠️ Held — over cap', color:'#9a3412', bg:'#ffedd5' },
    HELD_DUPLICATE:{ label:'⚠️ Held — duplicate ref', color:'#9a3412', bg:'#ffedd5' },
    HELD_OCR_FAIL: { label:'⚠️ Held — could not read', color:'#6b7280', bg:'#f3f4f6' }
  }[x.ai_status] || { label:x.ai_status, color:'#666', bg:'#f3f4f6' };
  var readAmt = x.ai_read_amount!=null ? '₱'+parseFloat(x.ai_read_amount).toLocaleString() : '—';
  var typedAmt = '₱'+parseFloat(x.amount).toLocaleString();
  var matchIcon = x.ai_match ? '✓' : '✕';
  return '<div style="background:#fff;border-radius:12px;border:1.5px solid var(--mist);border-left:5px solid '+statusMeta.color+';padding:14px 16px;margin-bottom:10px">'
    + '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap">'
      + '<div><div style="font-weight:800;color:var(--forest-deep)">'+esc(x.card_number)+' <span style="font-weight:600;font-size:.8rem;color:var(--timber)">'+esc(x.holder_name||'')+'</span></div>'
      + '<div style="font-size:.78rem;color:var(--timber);margin-top:3px">Customer typed <b>'+typedAmt+'</b> · AI read <b>'+readAmt+'</b> '+matchIcon+'</div>'
      + (x.ai_read_reference ? '<div style="font-size:.74rem;color:var(--timber);margin-top:2px">Ref: <b>'+esc(x.ai_read_reference)+'</b></div>' : '')
      + '</div>'
      + '<div style="text-align:right"><span style="font-size:.68rem;font-weight:700;padding:3px 8px;border-radius:6px;background:'+statusMeta.bg+';color:'+statusMeta.color+'">'+statusMeta.label+'</span>'
      + '<div style="font-size:.68rem;color:var(--timber);margin-top:4px">'+dt+'</div></div>'
    + '</div>'
    + (x.proof_url ? '<a href="'+esc(x.proof_url)+'" target="_blank" style="font-size:.72rem;color:var(--forest);font-weight:700;text-decoration:none;display:inline-block;margin-top:6px">🔗 View proof</a>' : '')
  + '</div>';
}

async function refreshPendingCardLoadsBadge() {
  try {
    var r = await api('getCardLoadRequests', { status: 'PENDING' });
    var count = ((r && r.requests) || []).length;
    window._pendingCardLoads = count || '';
    // Update sidebar badge if visible
    var badge = document.querySelector('[data-view="CARD_LOADS"] .sidebar-badge');
    if (badge) badge.textContent = count || '';
  } catch(_) {}
}

async function loadCardLoads(statusFilter) {
  var grid = document.getElementById('cardLoadsGrid');
  if (!grid) return;
  grid.innerHTML = '<div style="text-align:center;padding:40px;color:var(--timber)">Loading…</div>';
  try {
    var r = await api('getCardLoadRequests', { status: statusFilter || 'PENDING' });
    _cardLoadsData = (r && r.requests) || [];
    window._pendingCardLoads = _cardLoadsData.filter(function(x){ return x.status==='PENDING'; }).length || '';
    renderCardLoads();
  } catch(e) {
    grid.innerHTML = '<div style="padding:20px;color:#dc2626">Failed to load requests: ' + e.message + '</div>';
  }
}

function renderCardLoads() {
  var grid = document.getElementById('cardLoadsGrid');
  if (!grid) return;
  var data = _cardLoadsData;
  if (!data.length) {
    grid.innerHTML = '<div style="text-align:center;padding:48px;color:var(--timber);font-size:.88rem">No load requests found.</div>';
    return;
  }
  grid.innerHTML = data.map(function(req) {
    var dt = new Date(req.requested_at).toLocaleString('en-PH',{timeZone:'Asia/Manila',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
    var statusColor = req.status==='PENDING'?'#92400e':req.status==='APPROVED'?'#14532d':'#991b1b';
    var statusBg    = req.status==='PENDING'?'#fef9c3':req.status==='APPROVED'?'#dcfce7':'#fee2e2';
    var actions = '';
    if (req.status === 'PENDING') {
      actions = '<button onclick="approveLoad(\''+req.id+'\',this)" style="padding:7px 14px;background:var(--forest);color:#fff;border:none;border-radius:8px;font-size:.78rem;font-weight:700;cursor:pointer;margin-right:6px">✅ Approve</button>'
              + '<button onclick="rejectLoad(\''+req.id+'\',this)" style="padding:7px 14px;background:#fee2e2;color:#991b1b;border:1px solid #fca5a5;border-radius:8px;font-size:.78rem;font-weight:700;cursor:pointer">✕ Reject</button>';
    } else if (req.status === 'REJECTED' && req.rejection_reason) {
      actions = '<span style="font-size:.72rem;color:#991b1b">Reason: ' + esc(req.rejection_reason) + '</span>';
    }
    var proofHtml = req.proof_url
      ? '<a href="' + esc(req.proof_url) + '" target="_blank" style="font-size:.72rem;color:var(--forest);font-weight:700;text-decoration:none">📷 View proof →</a>'
      : '<span style="font-size:.72rem;color:var(--timber)">No proof uploaded</span>';

    return '<div style="background:#fff;border:1px solid var(--mist);border-radius:14px;padding:16px;margin-bottom:12px">'
      + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">'
      +   '<div>'
      +     '<div style="font-weight:800;font-size:1rem;color:var(--forest-deep)">' + esc(req.card_number) + '</div>'
      +     '<div style="font-size:.75rem;color:var(--timber);margin-top:2px">' + esc(req.holder_name||'') + ' · ' + esc(dt) + '</div>'
      +   '</div>'
      +   '<span style="background:'+statusBg+';color:'+statusColor+';font-size:.72rem;font-weight:700;padding:3px 10px;border-radius:20px">' + req.status + '</span>'
      + '</div>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">'
      +   '<div style="background:var(--mist-light);border-radius:8px;padding:10px;text-align:center">'
      +     '<div style="font-size:1.2rem;font-weight:800;color:var(--forest)">₱' + parseFloat(req.amount).toFixed(2) + '</div>'
      +     '<div style="font-size:.68rem;color:var(--timber);text-transform:uppercase">Amount</div>'
      +   '</div>'
      +   '<div style="background:var(--mist-light);border-radius:8px;padding:10px;text-align:center">'
      +     '<div style="font-size:.9rem;font-weight:700;color:var(--forest)">' + esc(req.payment_method) + '</div>'
      +     '<div style="font-size:.68rem;color:var(--timber);text-transform:uppercase">Method</div>'
      +   '</div>'
      + '</div>'
      + '<div style="margin-bottom:10px">' + proofHtml + '</div>'
      + '<div>' + actions + '</div>'
      + '</div>';
  }).join('');
}

async function approveLoad(reqId, btn) {
  if (!confirm('Approve this load request? This will credit the card immediately.')) return;
  btn.disabled = true; btn.textContent = 'Processing…';
  try {
    var r = await api('approveCardLoad', { requestId: reqId });
    if (r && r.ok) {
      showToast('✅ Card credited ₱' + (r.amount||'') + ' → New balance: ₱' + parseFloat(r.newBalance||0).toFixed(2));
      await loadCardLoads('PENDING');
    } else {
      showToast('❌ ' + ((r&&r.error)||'Failed'), true);
      btn.disabled = false; btn.textContent = '✅ Approve';
    }
  } catch(e) { showToast('❌ ' + e.message, true); btn.disabled=false; btn.textContent='✅ Approve'; }
}

async function rejectLoad(reqId, btn) {
  var reason = prompt('Reason for rejection (required):');
  if (!reason || !reason.trim()) return;
  btn.disabled = true; btn.textContent = 'Rejecting…';
  try {
    var r = await api('rejectCardLoad', { requestId: reqId, reason: reason.trim() });
    if (r && r.ok) {
      showToast('Request rejected.');
      await loadCardLoads('PENDING');
    } else {
      showToast('❌ ' + ((r&&r.error)||'Failed'), true);
      btn.disabled=false; btn.textContent='✕ Reject';
    }
  } catch(e) { showToast('❌ ' + e.message, true); btn.disabled=false; btn.textContent='✕ Reject'; }
}
