// ══════════════════════════════════════════════════════════
// PAYMENTS MANAGEMENT
// ══════════════════════════════════════════════════════════

async function loadPayments() {
  var result = await api('listPayments', { userId: currentUser && currentUser.userId });
  if (result.ok) {
    allPayments = result.payments || [];
    pendingPayCount = allPayments.filter(function(p){ return p.status === 'PENDING' }).length;
    document.getElementById('pendingCount').textContent = pendingPayCount;
    renderPayFilters();
    renderPayCards();
    renderFilters(); // Update the count on the Payments tab
  }
}

function renderPayFilters() {
  var counts = { ALL:0, PENDING:0, VERIFIED:0, REJECTED:0 };
  allPayments.forEach(function(p) {
    counts.ALL++;
    counts[p.status] = (counts[p.status] || 0) + 1;
  });

  var tabs = [
    { key:'PENDING', label:'⏳ Pending', count:counts.PENDING },
    { key:'VERIFIED', label:'✅ Verified', count:counts.VERIFIED },
    { key:'REJECTED', label:'❌ Rejected', count:counts.REJECTED },
    { key:'ALL', label:'All', count:counts.ALL }
  ];

  document.getElementById('payFilters').innerHTML = tabs.map(function(t) {
    return '<button class="pay-filter-btn' + (payFilter===t.key?' active':'') + '" onclick="setPayFilter(\'' + t.key + '\')">' +
      t.label + ' <span style="opacity:.6">' + t.count + '</span></button>';
  }).join('');
}

function setPayFilter(f) {
  payFilter = f;
  renderPayFilters();
  renderPayCards();
}

function renderPayCards() {
  var filtered = allPayments.filter(function(p) {
    if (payFilter === 'ALL') return true;
    return p.status === payFilter;
  });

  // Sort: PENDING first, newest first
  filtered.sort(function(a,b) {
    var order = { PENDING:0, VERIFIED:1, REJECTED:2 };
    var sa = order[a.status] || 9, sb = order[b.status] || 9;
    if (sa !== sb) return sa - sb;
    return new Date(b.uploadedAt || 0) - new Date(a.uploadedAt || 0);
  });

  if (filtered.length === 0) {
    document.getElementById('payGrid').innerHTML =
      '<div class="empty-state"><div class="empty-icon">💳</div><div class="empty-text">No payments here</div></div>';
    return;
  }

  document.getElementById('payGrid').innerHTML = filtered.map(function(p) {
    var statusClass = p.status.toLowerCase();
    var cardClass = 'pay-card' + (statusClass !== 'pending' ? ' ' + statusClass : '');

    // Format time
    var timeStr = '';
    try {
      var d = new Date(p.uploadedAt);
      timeStr = d.toLocaleString('en-PH', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit', hour12:true, timeZone:'Asia/Manila' });
    } catch(e) { timeStr = p.uploadedAt || ''; }

    var html = '<div class="' + cardClass + '">';

    // Header
    html += '<div class="pay-header">' +
      '<div class="pay-id">' + esc(p.paymentId) + '</div>' +
      '<span class="pay-status ' + statusClass + '">' + esc(p.status) + '</span>' +
    '</div>';

    // Meta row 1: Order + Table + Time
    html += '<div class="pay-meta">' +
      '<div class="pay-meta-item">📋 ' + esc(p.orderId) + '</div>' +
      '<div class="pay-meta-item">🪑 Table ' + esc(String(p.tableNo || '?')) + '</div>' +
      '<div class="pay-meta-item">🕐 ' + esc(timeStr) + '</div>' +
    '</div>';

    // Customer details section
    var custName = p.customerNameFull || p.customerName || '';
    if (custName || p.customerAddress || p.customerTin || p.receiptEmail) {
      html += '<div style="padding:0 16px 8px;font-size:.75rem;border-top:1px solid var(--mist-light);margin:0 0 0;padding-top:8px;">';
      if (custName) html += '<div style="color:var(--forest);font-weight:600;">👤 ' + esc(custName) + '</div>';
      if (p.customerAddress) html += '<div style="color:var(--timber);margin-top:2px;">📍 ' + esc(p.customerAddress) + '</div>';
      if (p.customerTin) html += '<div style="color:var(--timber);margin-top:2px;">🏢 TIN: ' + esc(p.customerTin) + '</div>';
      if (p.receiptEmail) html += '<div style="color:var(--timber);margin-top:2px;">📧 ' + esc(p.receiptEmail) + '</div>';
      html += '</div>';
    }

    // Amount
    html += '<div class="pay-amount">₱' + Number(p.amount || 0).toLocaleString(undefined,{minimumFractionDigits:2}) + '</div>';

    // Receipt info
    if (p.receiptRequested === 'TRUE' || p.receiptType) {
      var rType = p.receiptType ? p.receiptType.toUpperCase() : '';
      var rDel = p.receiptDelivery ? p.receiptDelivery.toUpperCase() : '';
      var rStatus = p.receiptStatus || '';
      
      var rBadgeColor = rStatus === 'SENT' ? '#D1FAE5;color:#065F46' : (rStatus === 'SENT_TO_CAFE' ? '#FEF3C7;color:#92400E' : '#F3F0EB;color:var(--timber)');
      
      html += '<div style="padding:4px 16px 10px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;">';
      html += '<span style="padding:2px 8px;border-radius:8px;font-size:.68rem;font-weight:700;background:#EDE9FE;color:#6D28D9;">🧾 ' + esc(rType || 'RECEIPT') + '</span>';
      if (rDel) html += '<span style="padding:2px 8px;border-radius:8px;font-size:.68rem;font-weight:600;background:#F3F0EB;color:var(--timber);">' + (rDel === 'EMAIL' ? '📧' : '🖨️') + ' ' + esc(rDel) + '</span>';
      if (rStatus) html += '<span style="padding:2px 8px;border-radius:8px;font-size:.68rem;font-weight:600;background:' + rBadgeColor + ';">' + esc(rStatus) + '</span>';
      html += '</div>';
      
      // Receipt file link
      if (p.receiptFileUrl) {
        html += '<div style="padding:0 16px 8px;"><a href="' + esc(p.receiptFileUrl) + '" target="_blank" style="font-size:.72rem;color:var(--forest);font-weight:600;text-decoration:none;">📄 View Receipt PDF</a></div>';
      }
    }

    // Screenshot: if real Storage URL → show direct link + view button; else on-demand via API
    if (p.hasProof || p.fileUrl || p.imageUrl || p.proofUrl) {
      html += '<div class="pay-screenshot">';
      if (p.proofUrl) {
        html += '<a href="' + esc(p.proofUrl) + '" target="_blank" class="pay-screenshot-btn" style="display:inline-block;text-decoration:none;">📸 View Screenshot</a>';
      } else {
        html += '<button class="pay-screenshot-btn" onclick="viewPaymentProof(\'' + esc(p.paymentId) + '\')">📸 View Payment Screenshot</button>';
      }
      html += '</div>';
    }

    // Verified/Rejected info
    if (p.status === 'VERIFIED' && p.verifiedBy) {
      html += '<div style="padding:4px 16px 10px;font-size:.72rem;color:#065F46;">✅ Verified by ' + esc(p.verifiedBy) + (p.verifiedAt ? ' · ' + esc(p.verifiedAt) : '') + '</div>';
    }
    if (p.status === 'REJECTED' && p.notes) {
      html += '<div style="padding:4px 16px 10px;font-size:.72rem;color:#991B1B;">❌ ' + esc(p.notes) + '</div>';
    }

    // Actions (only for PENDING)
    if (p.status === 'PENDING') {
      html += '<div class="pay-actions">' +
        '<button class="pay-btn pay-btn-verify" onclick="doVerifyPayment(\'' + esc(p.paymentId) + '\')">✅ Verify</button>' +
        '<button class="pay-btn pay-btn-reject" onclick="doRejectPayment(\'' + esc(p.paymentId) + '\')">✕ Reject</button>' +
      '</div>';
    }

    html += '</div>';
    return html;
  }).join('');
}

function closeProofModal() {
  var m = document.getElementById('proofModalOverlay');
  if (m) m.remove();
}

// Opens proof photo + verify/reject for an order card Verify button
async function openVerifyFromOrder(orderId) {
  // Find the paymentId for this order from the payments list
  var r = await api('listPayments', { userId: currentUser && currentUser.userId });
  if (!r || !r.ok) { showToast('Could not load payment data', 'error'); return; }
  var payment = (r.payments || []).find(function(p) {
    return p.orderId === orderId && (p.status === 'SUBMITTED' || p.status === 'PENDING');
  });
  if (!payment) {
    // No payment record — maybe proof was uploaded directly to order
    // Fall back to opening the set payment modal
    openPaymentModal(orderId);
    return;
  }

  // Build a verify modal that shows proof + verify/reject buttons
  var existing = document.getElementById('proofModalOverlay');
  if (existing) existing.remove();
  var modal = document.createElement('div');
  modal.id = 'proofModalOverlay';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
  var uid = currentUser && currentUser.userId ? currentUser.userId : '';
  var imgSrc = '/api/payment-proof?id=' + encodeURIComponent(payment.paymentId) + '&userId=' + encodeURIComponent(uid);
  var amtStr = payment.amount ? '₱' + parseFloat(payment.amount).toFixed(2) : '';
  // Build modal using DOM (avoids string escaping issues with onerror)
  var inner = document.createElement('div');
  inner.style.cssText = 'background:#fff;border-radius:16px;padding:20px;max-width:92vw;width:500px;text-align:center';
  inner.innerHTML =
    '<div style="font-weight:700;font-size:1rem;margin-bottom:4px">Payment Proof</div>' +
    '<div style="font-size:.82rem;color:#6B7280;margin-bottom:12px">' + esc(orderId) + ' · ' + esc(payment.method || '') + ' ' + amtStr + '</div>' +
    '<div id="proofImgWrap2"><div style="color:#9CA3AF;padding:10px">Loading...</div></div>' +
    '<div style="display:flex;gap:10px;margin-top:16px;justify-content:center">' +
      '<button id="vfVerifyBtn" style="flex:1;max-width:160px;padding:10px;background:#16a34a;color:#fff;border:none;border-radius:10px;font-weight:700;cursor:pointer;font-size:.9rem">Verify</button>' +
      '<button id="vfRejectBtn" style="flex:1;max-width:160px;padding:10px;background:#dc2626;color:#fff;border:none;border-radius:10px;font-weight:700;cursor:pointer;font-size:.9rem">Reject</button>' +
    '</div>' +
    '<button id="vfCloseBtn" style="margin-top:10px;padding:8px 20px;background:transparent;color:#6B7280;border:1px solid #e5e7eb;border-radius:8px;cursor:pointer;font-size:.82rem">Close</button>';
  var img = document.createElement('img');
  img.src = imgSrc;
  img.style.cssText = 'max-width:100%;max-height:55vh;border-radius:8px;object-fit:contain;display:block;margin:0 auto;';
  img.onload  = function() { var p = this.previousSibling; if (p) p.remove(); };
  img.onerror = function() { this.parentNode.innerHTML = '<div style="color:#9CA3AF;padding:20px">No screenshot found</div>'; };
  inner.querySelector('#proofImgWrap2').appendChild(img);
  inner.querySelector('#vfVerifyBtn').onclick = function() { closeProofModal(); doVerifyPayment(payment.paymentId); };
  inner.querySelector('#vfRejectBtn').onclick = function() { closeProofModal(); doRejectPayment(payment.paymentId); };
  inner.querySelector('#vfCloseBtn').onclick  = function() { closeProofModal(); };
  modal.appendChild(inner);
  document.body.appendChild(modal);
}

async function viewPaymentProof(paymentId) {
  var existing = document.getElementById('proofModalOverlay');
  if (existing) existing.remove();
  var modal = document.createElement('div');
  modal.id = 'proofModalOverlay';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
  var uid = currentUser && currentUser.userId ? currentUser.userId : '';
  // Use dedicated image endpoint — returns raw bytes, much faster than base64-in-JSON
  var imgSrc = '/api/payment-proof?id=' + encodeURIComponent(paymentId) + '&userId=' + encodeURIComponent(uid);
  modal.innerHTML = '<div style="background:#fff;border-radius:16px;padding:20px;max-width:92vw;width:500px;text-align:center">' +
    '<div style="font-weight:700;margin-bottom:12px">📸 Payment Screenshot</div>' +
    '<div id="proofImgWrap">' +
      '<img src="' + imgSrc + '" ' +
        'style="max-width:100%;max-height:65vh;border-radius:8px;object-fit:contain;display:block;margin:0 auto;" ' +
        'onload="this.previousSibling && this.previousSibling.remove()" ' +
        'onerror="this.outerHTML=\'<div style=\\\'color:#9CA3AF;padding:20px;text-align:center\\\'>📭 No screenshot for this payment</div>\'"> ' +
    '</div>' +
    '<button onclick="closeProofModal()" style="margin-top:16px;padding:10px 24px;background:var(--forest);color:#fff;border:none;border-radius:10px;font-weight:700;cursor:pointer;">Close</button>' +
    '</div>';
  document.body.appendChild(modal);
}

async function doVerifyPayment(paymentId) {
  var confirmed = await ygcConfirm('✅ Verify Payment', 'Verify payment ' + paymentId + '? This will mark it as confirmed.', 'Verify', 'Cancel');
  if (!confirmed) return;

  var result = await api('verifyPayment', { paymentId: paymentId, verifiedBy: 'Staff', userId: currentUser && currentUser.userId });
  if (result.ok) {
    // Refresh payments
    loadPayments();
    // Also refresh orders to update payment badges
    var ordResult = await api('getOrders', { status:'ALL', limit:100 });
    if (ordResult.ok) {
      var seen2 = {};
      allOrders = (ordResult.orders || []).filter(function(o) {
        if (seen2[o.orderId]) return false; seen2[o.orderId] = true; return true;
      });
      renderStats();
    }
  } else {
    showToast('Failed: ' + (result.error || 'Unknown error'), 'error');
  }
}

async function doRejectPayment(paymentId) {
  var reason = await ygcPrompt('✕ Reject Payment', 'Enter reason for rejecting payment ' + paymentId + ':', 'e.g. Wrong amount, expired screenshot');
  if (reason === null) return; // Cancelled

  var result = await api('rejectPayment', { paymentId: paymentId, reason: reason, verifiedBy: 'Staff', userId: currentUser && currentUser.userId });
  if (result.ok) {
    loadPayments();
    var ordResult = await api('getOrders', { status:'ALL', limit:100 });
    if (ordResult.ok) {
      var seen3 = {};
      allOrders = (ordResult.orders || []).filter(function(o) {
        if (seen3[o.orderId]) return false; seen3[o.orderId] = true; return true;
      });
      renderStats();
    }
  } else {
    showToast('Failed: ' + (result.error || 'Unknown error'), 'error');
  }
}

// ══════════════════════════════════════════════════════════
// PLATFORM ORDER FLOW
// ══════════════════════════════════════════════════════════
var poMenuItems = [];
var poCart = [];
var poSelectedPlatform = 'GRAB';
var poSelectedCat = 'ALL';
var poAddingItem = null;  // item being configured (size/sugar)

// ══════════════════════════════════════════════════════════
// FAB SPEED-DIAL
// ══════════════════════════════════════════════════════════
var _fabOpen = false;
function toggleFab() {
  _fabOpen = !_fabOpen;
  document.getElementById('fabMenu').classList.toggle('open', _fabOpen);
  document.getElementById('fabMain').classList.toggle('open', _fabOpen);
}
function closeFab() {
  _fabOpen = false;
  document.getElementById('fabMenu').classList.remove('open');
  document.getElementById('fabMain').classList.remove('open');
}
// Close fab on outside click
document.addEventListener('click', function(e) {
  var wrap = document.getElementById('fabWrap');
  if (wrap && !wrap.contains(e.target)) closeFab();
});

// ══════════════════════════════════════════════════════════
// STAFF POS — Walk-up Order
// ══════════════════════════════════════════════════════════
var spCart = [];
var spOrderType = 'DINE_IN';
var spTableNo = '';
var spSelectedCat = 'ALL';
var spAddingItem = null;
var spMenuItems = [];
var spActiveOrderId = null; // tracks if we're adding to an existing order

function openStaffPOS() {
  spCart = []; spOrderType = 'DINE_IN'; spTableNo = ''; spSelectedCat = 'ALL'; spActiveOrderId = null;
  document.getElementById('spCustomerName').value = '';
  document.getElementById('spNotes').value = '';
  document.getElementById('spFooter').style.display = 'none';
  document.getElementById('spCart').style.display = 'none';
  document.getElementById('spOverlay').classList.add('open');
  spSelectType('DINE_IN');
  spLoadMenu();
}

function closeStaffPOS() {
  document.getElementById('spOverlay').classList.remove('open');
}

function spSelectType(type) {
  spOrderType = type;
  spTableNo = '';
  document.getElementById('spTypeDineIn').classList.toggle('active', type === 'DINE_IN');
  document.getElementById('spTypeTakeOut').classList.toggle('active', type === 'TAKE_OUT');
  var tblSection = document.getElementById('spTableSection');
  if (tblSection) tblSection.style.display = type === 'DINE_IN' ? '' : 'none';
  if (type === 'DINE_IN') spRenderTables();
  spUpdateFooter();
}

function spRenderTables() {
  var grid = document.getElementById('spTableGrid');
  if (!grid) return;
  // Map active orders by table
  var activeOrders = {};
  allOrders.forEach(function(o) {
    if (['NEW','PREPARING','READY'].includes(o.status) && !o.isTest && o.tableNo) {
      activeOrders[String(o.tableNo)] = o;
    }
  });
  var tables = _allTables.length > 0 ? _allTables : [];
  grid.innerHTML = tables.map(function(tbl) {
    var tno = String(tbl.table_number);
    var name = tbl.table_name || ('Table ' + tno);
    var activeOrder = activeOrders[tno];
    var isActive = spTableNo === tno;
    var cls = 'sp-tbl-btn' + (isActive ? ' active' : activeOrder ? ' occupied' : '');
    var label = name;
    if (activeOrder) {
      label += '<br><span style="font-size:.58rem">🔴 ' + (activeOrder.customerName||'Guest') + '</span>';
      label += '<br><span style="font-size:.56rem;opacity:.8">+ Add items</span>';
    }
    return '<button class="' + cls + '" onclick="spSelectTable(\'' + tno + '\')" title="' + esc(name) + '">'
      + label + '</button>';
  }).join('');
}

function spSelectTable(tno) {
  spTableNo = tno;
  // Check if this table has an active order
  var activeOrder = null;
  allOrders.forEach(function(o) {
    if (['NEW','PREPARING','READY'].includes(o.status) && !o.isTest && String(o.tableNo) === tno) {
      activeOrder = o;
    }
  });
  spActiveOrderId = activeOrder ? activeOrder.orderId : null;

  // Update mode label
  var modeEl = document.getElementById('spModeLabel');
  if (modeEl) {
    if (spActiveOrderId) {
      modeEl.innerHTML = '<div style="background:#DBEAFE;color:#1E40AF;border-radius:8px;padding:6px 10px;font-size:.75rem;font-weight:700;margin-bottom:8px">➕ Adding to existing order: ' + spActiveOrderId + '</div>';
    } else {
      modeEl.innerHTML = '';
    }
  }

  // Update submit button label
  var btn = document.getElementById('spSubmitBtn');
  if (btn) btn.textContent = spActiveOrderId ? '➕ Add to Order' : '✅ Place Order';

  spRenderTables();
  spUpdateFooter();
}

async function spLoadMenu() {
  if (spMenuItems.length === 0) {
    var r = await api('getMenu', {});
    if (r.ok) spMenuItems = r.items || [];
  }
  spRenderCats();
  spRenderMenu();
}

function spRenderCats() {
  var cats = ['ALL'];
  spMenuItems.forEach(function(it) { if (it.category && cats.indexOf(it.category) < 0) cats.push(it.category); });
  document.getElementById('spCats').innerHTML = cats.map(function(c) {
    return '<button class="po-cat-btn' + (spSelectedCat===c?' active':'') + '" onclick="spSetCat(\'' + esc(c) + '\')">' +
      (c==='ALL' ? '🍽️ All' : esc(c)) + '</button>';
  }).join('');
}

function spSetCat(c) { spSelectedCat = c; spRenderCats(); spRenderMenu(); }

function spRenderMenu() {
  var filtered = spMenuItems.filter(function(it) {
    return spSelectedCat === 'ALL' || it.category === spSelectedCat;
  });
  document.getElementById('spMenuGrid').innerHTML = filtered.map(function(it) {
    var priceStr = it.hasSizes ? ('₱' + it.priceShort + '–₱' + it.priceTall) : ('₱' + it.price);
    return '<div class="po-menu-item" onclick="spAddItem(\'' + esc(it.code) + '\')">' +
      '<div class="po-menu-item-cat">' + esc(it.category||'') + '</div>' +
      '<div class="po-menu-item-name">' + esc(it.name) + '</div>' +
      '<div class="po-menu-item-price">' + priceStr + '</div>' +
    '</div>';
  }).join('');
}

function spAddItem(code) {
  var item = spMenuItems.find(function(it){ return it.code === code; });
  if (!item) return;
  spAddingItem = { code:item.code, name:item.name, hasSizes:item.hasSizes, hasSugar:item.hasSugar,
    price:parseFloat(item.price)||0, priceShort:parseFloat(item.priceShort)||0, priceMedium:parseFloat(item.priceMedium)||0, priceTall:parseFloat(item.priceTall)||0,
    size:'', sugarLevel:'', qty:1 };
  // Redirect po-popup callbacks to sp handlers
  _spPopupMode = true;
  if (item.hasSizes) showSizePopup();
  else if (item.hasSugar) showSugarPopup();
  else spFinishAdd();
}

var _spPopupMode = false;

function spFinishAdd() {
  _spPopupMode = false;
  var it = spAddingItem;
  if (!it) return;
  var price = it.size === 'Short' ? it.priceShort : it.size === 'Medium' ? it.priceMedium : it.size === 'Tall' ? it.priceTall : it.price;
  // Check if same item+size+sugar already in cart
  var existing = spCart.find(function(c) { return c.code===it.code && c.size===it.size && c.sugarLevel===it.sugarLevel; });
  if (existing) { existing.qty++; }
  else { spCart.push({ code:it.code, name:it.name, size:it.size, sugarLevel:it.sugarLevel, price:price, qty:1 }); }
  spAddingItem = null;
  spRenderCart();
}

function spRenderCart() {
  var cartEl = document.getElementById('spCart');
  var itemsEl = document.getElementById('spCartItems');
  if (spCart.length === 0) { cartEl.style.display='none'; spUpdateFooter(); return; }
  cartEl.style.display = '';
  itemsEl.innerHTML = spCart.map(function(it, idx) {
    var opts = [it.size, it.sugarLevel].filter(Boolean).join(' · ');
    return '<div class="po-cart-item">' +
      '<div style="flex:1">' +
        '<div class="po-cart-item-name">' + esc(it.name) + '</div>' +
        (opts ? '<div class="po-cart-item-opts">' + esc(opts) + '</div>' : '') +
      '</div>' +
      '<div class="po-cart-qty">' +
        '<button onclick="spQty(' + idx + ',-1)">−</button>' +
        '<span style="font-size:.82rem;font-weight:700;min-width:20px;text-align:center">' + it.qty + '</span>' +
        '<button onclick="spQty(' + idx + ',1)">+</button>' +
      '</div>' +
      '<div class="po-cart-item-price">₱' + (it.price * it.qty).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2}) + '</div>' +
      '<span class="po-cart-remove" onclick="spRemove(' + idx + ')">✕</span>' +
    '</div>';
  }).join('');
  spUpdateFooter();
}

function spQty(idx, delta) {
  spCart[idx].qty += delta;
  if (spCart[idx].qty <= 0) spCart.splice(idx, 1);
  spRenderCart();
}
function spRemove(idx) { spCart.splice(idx,1); spRenderCart(); }

function spUpdateFooter() {
  var footer = document.getElementById('spFooter');
  if (spCart.length === 0) { footer.style.display='none'; return; }
  var subtotal = spCart.reduce(function(s,it){ return s + it.price*it.qty; }, 0);
  var svcCharge = spOrderType === 'DINE_IN' ? subtotal * 0.10 : 0;
  var total = subtotal + svcCharge;
  document.getElementById('spSubtotal').textContent = '₱' + subtotal.toFixed(2);
  document.getElementById('spService').textContent = '₱' + svcCharge.toFixed(2);
  document.getElementById('spTotal').textContent = '₱' + total.toFixed(2);
  var svcRow = document.getElementById('spServiceRow');
  if (svcRow) svcRow.style.display = spOrderType === 'DINE_IN' ? '' : 'none';
  footer.style.display = '';
}

async function submitStaffOrder() {
  if (spCart.length === 0) { showToast('Add items to cart first', 'error'); return; }
  if (spOrderType === 'DINE_IN' && !spTableNo) { showToast('Please select a table', 'error'); return; }

  var btn = document.getElementById('spSubmitBtn');
  btn.disabled = true;
  btn.textContent = spActiveOrderId ? '⏳ Adding…' : '⏳ Placing…';

  // MODE: Add to existing order
  if (spActiveOrderId) {
    var addItems = spCart.map(function(it) {
      return { code:it.code, name:it.name, price:it.price, qty:it.qty,
               size:it.size||null, sugarLevel:it.sugarLevel||null };
    });
    var r = await api('addItemsToOrder', {
      userId: currentUser && currentUser.userId,
      orderId: spActiveOrderId,
      items: addItems
    });
    btn.disabled = false; btn.textContent = '➕ Add to Order';
    if (r.ok) {
      closeStaffPOS();
      showToast('✅ Added ' + spCart.length + ' item(s) to ' + spActiveOrderId);
      await loadOrders();
    } else {
      showToast('❌ ' + (r.error||'Failed to add items'), 'error');
    }
    return;
  }

  // MODE: New order
  var subtotal = spCart.reduce(function(s,it){ return s + it.price*it.qty; }, 0);
  var svcCharge = spOrderType === 'DINE_IN' ? Math.round(subtotal * 10) / 100 : 0;
  var total = Math.round((subtotal + svcCharge) * 100) / 100;
  var items = spCart.map(function(it) {
    return { code:it.code, name:it.name, price:it.price, qty:it.qty,
             size:it.size||null, sugarLevel:it.sugarLevel||null };
  });
  var payload = {
    tableNo: spOrderType === 'DINE_IN' ? parseInt(spTableNo) : null,
    tableToken: spOrderType === 'DINE_IN' ? ((_allTables.find(function(t){return String(t.table_number)===spTableNo;})||{}).qr_token || 'staff') : 'takeout',
    orderType: spOrderType,
    customerName: (document.getElementById('spCustomerName').value||'').trim() || 'Staff',
    notes: (document.getElementById('spNotes').value||'').trim(),
    items: items,
    subtotal: subtotal,
    serviceCharge: svcCharge,
    total: total,
    staffOrder: true
  };
  var r = await api('placeOrder', payload);
  btn.disabled = false; btn.textContent = '✅ Place Order';
  if (r.ok) {
    closeStaffPOS();
    showToast('✅ Order ' + (r.orderId||'') + ' placed!', 'success');
    await loadOrders();
  } else {
    showToast('❌ ' + (r.error||'Failed to place order'), 'error');
  }
}

function openPlatformOrder() {
  poCart = [];
  poSelectedPlatform = 'GRAB';
  poSelectedCat = 'ALL';
  document.getElementById('poRef').value = '';
  document.getElementById('poNotes').value = '';
  document.getElementById('poOverlay').classList.add('open');
  selectPlatform('GRAB');
  loadPlatformMenu();
}

function closePlatformOrder() {
  document.getElementById('poOverlay').classList.remove('open');
}

function selectPlatform(p) {
  poSelectedPlatform = p;
  var btns = document.querySelectorAll('.po-plat-btn');
  btns.forEach(function(btn) {
    btn.classList.toggle('active', btn.getAttribute('data-platform') === p);
  });
}

async function loadPlatformMenu() {
  var result = await api('getMenu', {});
  if (!result.ok || !result.items) return;
  poMenuItems = result.items;
  renderPoCats();
  renderPoMenu();
}

function renderPoCats() {
  var cats = ['ALL'];
  poMenuItems.forEach(function(it) {
    if (it.category && cats.indexOf(it.category) < 0) cats.push(it.category);
  });
  document.getElementById('poCats').innerHTML = cats.map(function(c) {
    return '<button class="po-cat-btn' + (poSelectedCat===c?' active':'') + '" onclick="setPoCategory(\'' + esc(c) + '\')">' +
      (c === 'ALL' ? '🍽️ All' : esc(c)) + '</button>';
  }).join('');
}

function setPoCategory(c) {
  poSelectedCat = c;
  renderPoCats();
  renderPoMenu();
}

function renderPoMenu() {
  var filtered = poMenuItems.filter(function(it) {
    if (poSelectedCat === 'ALL') return true;
    return it.category === poSelectedCat;
  });

  document.getElementById('poMenuGrid').innerHTML = filtered.map(function(it, idx) {
    var priceStr = it.hasSizes ? ('₱' + it.priceShort + ' - ₱' + it.priceTall) : ('₱' + it.price);
    return '<div class="po-menu-item" onclick="poAddItem(\'' + esc(it.code) + '\')">' +
      '<div class="po-menu-item-cat">' + esc(it.category || '') + '</div>' +
      '<div class="po-menu-item-name">' + esc(it.name) + '</div>' +
      '<div class="po-menu-item-price">' + priceStr + '</div>' +
    '</div>';
  }).join('');
}

function poAddItem(code) {
  var item = poMenuItems.find(function(it) { return it.code === code });
  if (!item) return;

  poAddingItem = {
    code: item.code,
    name: item.name,
    hasSizes: item.hasSizes,
    hasSugar: item.hasSugar,
    price: item.price,
    priceShort: item.priceShort,
    priceMedium: item.priceMedium,
    priceTall: item.priceTall,
    size: '',
    sugarLevel: '',
    qty: 1
  };

  // If has sizes → show size popup
  if (item.hasSizes) {
    showSizePopup();
  } else if (item.hasSugar) {
    showSugarPopup();
  } else {
    // No options — add directly
    poFinishAdd();
  }
}

function showSizePopup() {
  var it = _spPopupMode ? spAddingItem : poAddingItem;
  var html = '<div class="po-popup-title">' + esc(it.name) + '</div>'
    + '<div class="po-popup-sub">Choose size</div>'
    + '<div class="po-option" onclick="poSelectSize(\'Short\',' + it.priceShort + ')">'
    +   '<span class="po-option-label">Short (12oz)</span><span class="po-option-price">₱' + it.priceShort + '</span>'
    + '</div>'
    + '<div class="po-option" onclick="poSelectSize(\'Medium\',' + it.priceMedium + ')">'
    +   '<span class="po-option-label">Medium (16oz)</span><span class="po-option-price">₱' + it.priceMedium + '</span>'
    + '</div>'
    + '<div class="po-option" onclick="poSelectSize(\'Tall\',' + it.priceTall + ')">'
    +   '<span class="po-option-label">Tall (22oz)</span><span class="po-option-price">₱' + it.priceTall + '</span>'
    + '</div>';

  document.getElementById('poPopupBox').innerHTML = html;
  document.getElementById('poPopup').classList.add('open');
}

function poSelectSize(size, price) {
  var item = _spPopupMode ? spAddingItem : poAddingItem;
  item.size = size;
  item.price = price;
  document.getElementById('poPopup').classList.remove('open');

  if (item.hasSugar) {
    setTimeout(showSugarPopup, 200);
  } else {
    _spPopupMode ? spFinishAdd() : poFinishAdd();
  }
}

function showSugarPopup() {
  var it = _spPopupMode ? spAddingItem : poAddingItem;
  var sizeLabel = it.size ? ' · ' + it.size : '';
  var html = '<div class="po-popup-title">' + esc(it.name) + '</div>'
    + '<div class="po-popup-sub">₱' + it.price + sizeLabel + ' — Choose sugar level</div>'
    + '<div class="po-option" onclick="poSelectSugar(\'Grounded\')"><span class="po-option-label">Grounded (25%)</span></div>'
    + '<div class="po-option" onclick="poSelectSugar(\'YANI\')"><span class="po-option-label">YANI (50%) — Signature</span></div>'
    + '<div class="po-option" onclick="poSelectSugar(\'Comfort\')"><span class="po-option-label">Comfort (75%)</span></div>'
    + '<div class="po-option" onclick="poSelectSugar(\'Full Sweet\')"><span class="po-option-label">Full Sweet (100%)</span></div>';

  document.getElementById('poPopupBox').innerHTML = html;
  document.getElementById('poPopup').classList.add('open');
}

function poSelectSugar(level) {
  var item = _spPopupMode ? spAddingItem : poAddingItem;
  item.sugarLevel = level;
  document.getElementById('poPopup').classList.remove('open');
  _spPopupMode ? spFinishAdd() : poFinishAdd();
}

function poFinishAdd() {
  // Check if same item+size+sugar exists in cart → increment qty
  var existing = poCart.find(function(c) {
    return c.code === poAddingItem.code && c.size === poAddingItem.size && c.sugarLevel === poAddingItem.sugarLevel;
  });

  if (existing) {
    existing.qty++;
  } else {
    poCart.push({
      code: poAddingItem.code,
      name: poAddingItem.name,
      size: poAddingItem.size,
      sugarLevel: poAddingItem.sugarLevel,
      price: poAddingItem.price,
      qty: 1
    });
  }

  poAddingItem = null;
  renderPoCart();
}

function renderPoCart() {
  var cartEl = document.getElementById('poCart');
  var footerEl = document.getElementById('poFooter');

  if (poCart.length === 0) {
    cartEl.style.display = 'none';
    footerEl.style.display = 'none';
    return;
  }

  cartEl.style.display = '';
  footerEl.style.display = '';

  var total = 0;
  var html = '';
  poCart.forEach(function(c, idx) {
    var lineTotal = c.price * c.qty;
    total += lineTotal;
    var opts = [];
    if (c.size) opts.push(c.size);
    if (c.sugarLevel) opts.push(c.sugarLevel);

    html += '<div class="po-cart-item">'
      + '<div style="flex:1">'
      +   '<div class="po-cart-item-name">' + esc(c.name) + '</div>'
      +   (opts.length ? '<div class="po-cart-item-opts">' + esc(opts.join(' · ')) + '</div>' : '')
      + '</div>'
      + '<div class="po-cart-qty">'
      +   '<button onclick="poCartQty(' + idx + ',-1)">−</button>'
      +   '<span style="min-width:20px;text-align:center;font-weight:700;font-size:.8rem">' + c.qty + '</span>'
      +   '<button onclick="poCartQty(' + idx + ',1)">+</button>'
      + '</div>'
      + '<div class="po-cart-item-price">₱' + lineTotal.toLocaleString() + '</div>'
      + '<span class="po-cart-remove" onclick="poCartRemove(' + idx + ')">🗑</span>'
      + '</div>';
  });

  document.getElementById('poCartItems').innerHTML = html;
  document.getElementById('poTotal').textContent = '₱' + total.toLocaleString();
}

function poCartQty(idx, delta) {
  poCart[idx].qty += delta;
  if (poCart[idx].qty < 1) poCart.splice(idx, 1);
  renderPoCart();
}

function poCartRemove(idx) {
  poCart.splice(idx, 1);
  renderPoCart();
}

async function submitPlatformOrder() {
  if (poCart.length === 0) { showToast('Cart is empty', 'warn'); return; }

  var btn = document.getElementById('poSubmitBtn');
  btn.disabled = true;
  btn.textContent = 'Placing order...';

  var items = poCart.map(function(c) {
    return { code: c.code, size: c.size, sugarLevel: c.sugarLevel, qty: c.qty };
  });

  var result = await api('placePlatformOrder', {
    platform: poSelectedPlatform,
    platformRef: document.getElementById('poRef').value.trim(),
    notes: document.getElementById('poNotes').value.trim(),
    items: items
  });

  btn.disabled = false;
  btn.textContent = '📦 Place Platform Order';

  if (result.ok) {
    closePlatformOrder();
    // Refresh orders
    loadOrders();
    showToast('✅ ' + poSelectedPlatform + ' order placed! Order: ' + result.orderId + ' · ₱' + Number(result.total).toLocaleString());
  } else {
    showToast('❌ Failed: ' + (result.error || 'Unknown error'), 'error');
  }
}
