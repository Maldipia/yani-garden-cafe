// ── Admin: Card Load Requests ─────────────────────────────────────────────────
var _cardLoadsData = [];

async function initCardLoads() {
  await loadCardLoads('PENDING');
}

async function refreshPendingCardLoadsBadge() {
  try {
    var r = await apiAdmin('getCardLoadRequests', { status: 'PENDING' });
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
    var r = await apiAdmin('getCardLoadRequests', { status: statusFilter || 'PENDING' });
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
    var r = await apiAdmin('approveCardLoad', { requestId: reqId });
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
    var r = await apiAdmin('rejectCardLoad', { requestId: reqId, reason: reason.trim() });
    if (r && r.ok) {
      showToast('Request rejected.');
      await loadCardLoads('PENDING');
    } else {
      showToast('❌ ' + ((r&&r.error)||'Failed'), true);
      btn.disabled=false; btn.textContent='✕ Reject';
    }
  } catch(e) { showToast('❌ ' + e.message, true); btn.disabled=false; btn.textContent='✕ Reject'; }
}
