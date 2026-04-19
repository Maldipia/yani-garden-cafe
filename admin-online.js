// ══════════════════════════════════════════════════════════
// ONLINE ORDERS MANAGEMENT
// ══════════════════════════════════════════════════════════
async function loadOnlineOrders() {
  document.getElementById('onlineOrdersCount').textContent = 'Loading...';
  document.getElementById('onlineOrdersGrid').innerHTML = '<div class="empty-state"><div class="empty-icon">⏳</div><div class="empty-text">Loading online orders...</div></div>';
  try {
    var resp = await fetch('/api/online-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'getOnlineOrders', limit: 100 })
    });
    var data = await resp.json();
    if (!data.ok) throw new Error(data.error || 'Failed to load');
    allOnlineOrders = data.orders || [];
    onlineOrderPendingCount = allOnlineOrders.filter(function(o) { return o.status === 'PENDING'; }).length;
    renderOnlineOrderFilters();
    renderOnlineOrders();
    renderFilters(); // Update tab count
  } catch (e) {
    document.getElementById('onlineOrdersCount').textContent = 'Error: ' + e.message;
    document.getElementById('onlineOrdersGrid').innerHTML = '<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-text">Failed to load: ' + esc(e.message) + '</div></div>';
  }
}

function refreshOnlineOrders() { loadOnlineOrders(); }

function renderOnlineOrderFilters() {
  var counts = { ALL:0, PENDING:0, CONFIRMED:0, PREPARING:0, READY:0, COMPLETED:0, CANCELLED:0 };
  var submittedCount = 0;
  allOnlineOrders.forEach(function(o) {
    counts.ALL++;
    if (counts[o.status] !== undefined) counts[o.status]++;
    else counts[o.status] = 1;
    if (o.status === 'PENDING' && o.payment_status === 'SUBMITTED') submittedCount++;
  });
  var tabs = [
    { key:'PENDING', label:'⏳ Pending', count: counts.PENDING },
    { key:'CONFIRMED', label:'✅ Confirmed', count: counts.CONFIRMED },
    { key:'PREPARING', label:'👨\u200d🍳 Preparing', count: counts.PREPARING },
    { key:'READY', label:'✨ Ready', count: counts.READY },
    { key:'COMPLETED', label:'🎉 Done', count: counts.COMPLETED },
    { key:'ALL', label:'All', count: counts.ALL }
  ];
  document.getElementById('onlineOrderFilterBtns').innerHTML = tabs.map(function(t) {
    return '<button class="pay-filter-btn' + (onlineOrderFilter===t.key?' active':'') + '" onclick="setOnlineOrderFilter(\'' + t.key + '\')">' +
      t.label + ' <span style="opacity:.6">' + t.count + '</span></button>';
  }).join('');
  document.getElementById('onlineOrdersCount').textContent = allOnlineOrders.length + ' total orders · ' + onlineOrderPendingCount + ' need attention';
}

function setOnlineOrderFilter(f) {
  onlineOrderFilter = f;
  renderOnlineOrderFilters();
  renderOnlineOrders();
}

function renderOnlineOrders() {
  var filtered = allOnlineOrders.filter(function(o) {
    if (onlineOrderFilter === 'ALL') return true;
    return o.status === onlineOrderFilter;
  });
  filtered.sort(function(a,b) {
    var sortOrder = { PENDING:0, CONFIRMED:1, PREPARING:2, READY:3, COMPLETED:4, CANCELLED:5 };
    // Within PENDING, put SUBMITTED proof first
    var getSort = function(o) {
      var base = sortOrder[o.status] !== undefined ? sortOrder[o.status] * 10 : 90;
      if (o.status === 'PENDING' && o.payment_status === 'SUBMITTED') base = 0;
      else if (o.status === 'PENDING') base = 5;
      return base;
    };
    var sa = getSort(a);
    var sb = getSort(b);
    if (sa !== sb) return sa - sb;
    return new Date(b.created_at || 0) - new Date(a.created_at || 0);
  });
  if (!filtered.length) {
    document.getElementById('onlineOrdersGrid').innerHTML = '<div class="empty-state"><div class="empty-icon">🛕</div><div class="empty-text">No online orders here</div></div>';
    return;
  }
  document.getElementById('onlineOrdersGrid').innerHTML =
    '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:12px;padding:0">' +
    filtered.map(function(o) {
    var displayStatus, statusStyle;
    if (o.status === 'PENDING' && o.payment_status === 'SUBMITTED') {
      displayStatus = 'PROOF SUBMITTED';
      statusStyle = 'background:#DBEAFE;color:#1E40AF';
    } else if (o.status === 'PENDING') {
      displayStatus = 'AWAITING PAYMENT';
      statusStyle = 'background:#FEF3C7;color:#92400E';
    } else if (o.status === 'CONFIRMED') {
      displayStatus = 'CONFIRMED';
      statusStyle = 'background:#D1FAE5;color:#065F46';
    } else if (o.status === 'PREPARING') {
      displayStatus = 'PREPARING';
      statusStyle = 'background:#EDE9FE;color:#6D28D9';
    } else if (o.status === 'READY') {
      displayStatus = 'READY';
      statusStyle = 'background:#D1FAE5;color:#065F46';
    } else if (o.status === 'COMPLETED') {
      displayStatus = 'COMPLETED';
      statusStyle = 'background:var(--mist-light);color:var(--timber)';
    } else if (o.status === 'CANCELLED') {
      displayStatus = 'CANCELLED';
      statusStyle = 'background:#FEE2E2;color:#991B1B';
    } else {
      displayStatus = o.status;
      statusStyle = 'background:var(--mist-light);color:var(--timber)';
    }
    var timeStr = '';
    try { var d = new Date(o.created_at); timeStr = d.toLocaleString('en-PH', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit', hour12:true, timeZone:'Asia/Manila' }); } catch(e) {}
    var html = '<div class="order-card" data-status="' + esc(o.status) + '">';
    // Header
    html += '<div class="oc-header">';
    html += '<div class="oc-id">' + esc(o.order_ref || o.id) + '</div>';
    html += '<span class="oc-status-badge" style="' + statusStyle + '">' + esc(displayStatus) + '</span>';
    html += '<div class="oc-time">' + esc(timeStr) + '</div>';
    html += '</div>';
    // Customer info
    html += '<div style="padding:0 16px 10px;font-size:.82rem">';
    html += '<div style="font-weight:700">👤 ' + esc(o.customer_name || '') + '</div>';
    html += '<div style="color:var(--timber);margin-top:2px">📱 ' + esc(o.customer_phone || '') + '</div>';
    if (o.delivery_address) html += '<div style="color:var(--timber);margin-top:2px">📍 ' + esc(o.delivery_address) + '</div>';
    if (o.courier_type === 'YANI_DELIVERY') {
      var zoneLabel = o.delivery_zone ? 'Zone ' + o.delivery_zone : '';
      var feeLabel = o.delivery_fee > 0 ? '₱' + parseFloat(o.delivery_fee).toFixed(0) : (o.delivery_zone == 4 ? 'Custom quote' : 'FREE');
      html += '<div style="margin-top:6px;background:#dcfce7;border:1.5px solid #86efac;border-radius:8px;padding:5px 10px;font-size:.78rem;font-weight:700;color:#14532d;display:inline-flex;gap:8px;align-items:center">'
        + '🛵 YANI Delivery · ' + zoneLabel + ' · ' + feeLabel
        + (o.delivery_zone == 4 ? ' ⚠️ <span style="color:#b45309">Confirm fee w/ customer</span>' : '')
        + '</div>';
    } else if (o.courier_type) {
      html += '<div style="color:var(--timber);margin-top:2px">📦 Own courier: ' + esc(o.courier_type) + '</div>';
    }
    html += '</div>';
    // Special instructions
    if (o.special_instructions) {
      html += '<div style="margin:0 16px 8px;padding:8px 10px;background:#fff8f0;border-radius:6px;border:1px solid #fed7aa;font-size:.78rem;color:#92400e">'
        + '📝 <strong>Note:</strong> ' + esc(o.special_instructions) + '</div>';
    }
    // Items
    if (o.items && o.items.length) {
      html += '<div class="oc-items">';
      o.items.forEach(function(item) {
        var itemAddons = [];
        if (item.addons) {
          try { itemAddons = typeof item.addons === 'string' ? JSON.parse(item.addons) : item.addons; } catch(e){}
        }
        html += '<div class="oc-item">';
        html += '<div class="oc-item-qty">' + esc(String(item.quantity || 1)) + '</div>';
        html += '<div class="oc-item-info">';
        html += '<div class="oc-item-name">' + esc(item.item_name || item.name || '') + '</div>';
        if (item.size && item.size !== 'REGULAR') html += '<div class="oc-item-opts">' + esc(item.size) + '</div>';
        if (itemAddons && itemAddons.length) {
          html += '<div style="margin-top:3px;display:flex;flex-wrap:wrap;gap:3px">';
          itemAddons.forEach(function(a) {
            html += '<span style="background:#dcfce7;color:#14532d;border:1px solid #86efac;border-radius:5px;padding:1px 7px;font-size:.7rem;font-weight:700">➕ ' + esc(a.name) + ' +₱' + parseFloat(a.price||0).toFixed(0) + '</span>';
          });
          html += '</div>';
        }
        html += '</div>';
        html += '<div style="font-size:.82rem;font-weight:700;color:var(--terra)">₱' + Number(item.subtotal || (item.unit_price * item.quantity) || 0).toFixed(0) + '</div>';
        html += '</div>';
      });
      html += '</div>';
    }
    // Price breakdown
    html += '<div class="oc-total" style="padding:10px 16px;border-top:1px solid var(--mist)">';
    var foodSubtotal = Number(o.subtotal || 0);
    var delivFee     = Number(o.delivery_fee || 0);
    var grandTotal   = Number(o.total_amount || 0);
    if (delivFee > 0) {
      html += '<div style="display:flex;justify-content:space-between;font-size:.8rem;color:var(--timber);margin-bottom:4px">'
        + '<span>Food subtotal</span><span>₱' + foodSubtotal.toFixed(0) + '</span></div>';
      html += '<div style="display:flex;justify-content:space-between;font-size:.8rem;color:var(--timber);margin-bottom:6px">'
        + '<span>🚚 Delivery (Zone ' + (o.delivery_zone||'') + ')</span><span>₱' + delivFee.toFixed(0) + '</span></div>';
    }
    html += '<div style="display:flex;justify-content:space-between;font-size:.9rem;font-weight:800;color:var(--forest-deep)">'
      + '<span>Total</span><span>₱' + grandTotal.toFixed(0) + '</span></div>';
    if (o.payment_method) {
      html += '<div style="font-size:.72rem;color:var(--timber);margin-top:4px">💳 ' + esc(o.payment_method.toUpperCase()) + '</div>';
    }
    html += '</div>';
    // Payment proof
    if (o.payment_proof_url) {
      html += '<div style="padding:6px 16px 10px">';
      html += '<a href="' + esc(o.payment_proof_url) + '" target="_blank" style="font-size:.78rem;color:var(--forest);font-weight:600;text-decoration:none">📸 View Payment Proof</a>';
      html += '</div>';
    }
    // Actions
    var isOwner = (currentUser.role === 'OWNER');
    var isActive = (o.status !== 'COMPLETED' && o.status !== 'CANCELLED');
    html += '<div class="oc-actions" style="flex-wrap:wrap">';
    if (o.status === 'PENDING' && o.payment_status === 'SUBMITTED') {
      html += '<button class="oc-btn oc-btn-start" onclick="onlineOrderAction(\'' + esc(o.order_ref) + '\',\'CONFIRMED\')">✅ Confirm Payment</button>';
      html += '<button class="oc-btn oc-btn-cancel" onclick="onlineOrderAction(\'' + esc(o.order_ref) + '\',\'CANCELLED\')">✕ Reject</button>';
    } else if (o.status === 'PENDING') {
      html += '<span style="font-size:.75rem;color:var(--timber);padding:4px 0">⏳ Waiting for payment proof</span>';
      if (isOwner) html += '<button class="oc-btn oc-btn-cancel" onclick="onlineOrderAction(\'' + esc(o.order_ref) + '\',\'CANCELLED\')">✕ Cancel</button>';
    } else if (o.status === 'CONFIRMED') {
      html += '<button class="oc-btn oc-btn-start" onclick="onlineOrderAction(\'' + esc(o.order_ref) + '\',\'PREPARING\')">👨‍🍳 Start Preparing</button>';
      if (isOwner) html += '<button class="oc-btn oc-btn-cancel" onclick="onlineOrderAction(\'' + esc(o.order_ref) + '\',\'CANCELLED\')">✕ Cancel</button>';
    } else if (o.status === 'PREPARING') {
      html += '<button class="oc-btn oc-btn-ready" onclick="onlineOrderReadyAndSMS(\'' + esc(o.order_ref) + '\',\'' + esc(o.customer_phone || '') + '\',\'' + esc(o.customer_name || '') + '\')">✨ Mark Ready & SMS</button>';
      if (isOwner) html += '<button class="oc-btn oc-btn-cancel" onclick="onlineOrderAction(\'' + esc(o.order_ref) + '\',\'CANCELLED\')">✕ Cancel</button>';
    } else if (o.status === 'READY') {
      html += '<button class="oc-btn oc-btn-complete" onclick="onlineOrderAction(\'' + esc(o.order_ref) + '\',\'COMPLETED\')">🎉 Mark Completed</button>';
      if (isOwner) html += '<button class="oc-btn oc-btn-cancel" onclick="onlineOrderAction(\'' + esc(o.order_ref) + '\',\'CANCELLED\')">✕ Cancel</button>';
    }
    html += '</div>';
    // Print Receipt button (always visible for non-kitchen roles)
    if (currentUser.role !== 'KITCHEN') {
      html += '<div style="padding:0 12px 6px">';
      html += '<button class="oc-btn oc-btn-print" onclick="printOnlineReceipt(\'' + esc(o.order_ref) + '\')">🖨️ Print Receipt</button>';
      html += '</div>';
    }
    // Owner-only Edit button row (for all active orders)
    if (isOwner && isActive) {
      html += '<div style="padding:0 12px 12px">';
      html += '<button class="oc-btn" style="background:var(--gold);color:#fff;width:100%;font-size:.78rem" onclick="openOlEditModal(\'' + esc(o.order_ref) + '\')">✏️ Edit Order Details</button>';
      html += '</div>';
    }
    html += '</div>';
    return html;
  }).join('') + '</div>';
}

async function onlineOrderAction(orderRef, newStatus) {
  var confirmMsg, confirmTitle, confirmOk, confirmNo;
  if (newStatus === 'CANCELLED') {
    confirmTitle = '⚠️ Cancel Order';
    confirmMsg = 'Cancel online order ' + orderRef + '? This cannot be undone.';
    confirmOk = 'Yes, Cancel Order';
    confirmNo = 'Keep Order';
  } else {
    confirmTitle = 'Update Order';
    confirmMsg = 'Update order ' + orderRef + ' to ' + newStatus + '?';
    confirmOk = 'Confirm';
    confirmNo = 'Go Back';
  }
  var confirmed = await ygcConfirm(confirmTitle, confirmMsg, confirmOk, confirmNo);
  if (!confirmed) return;
  try {
    var resp = await fetch('/api/online-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'updateOnlineOrderStatus', orderRef: orderRef, status: newStatus, updatedBy: currentUser.username || 'Staff' })
    });
    var data = await resp.json();
    if (!data.ok) throw new Error(data.error || 'Failed');
    await loadOnlineOrders();
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

async function onlineOrderReadyAndSMS(orderRef, phone, name) {
  var confirmed = await ygcConfirm('📨 Send SMS', 'Mark order ' + orderRef + ' as READY and send SMS to ' + phone + '?', 'Send SMS', 'Cancel');
  if (!confirmed) return;
  try {
    var resp = await fetch('/api/online-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'sendReadySMS', orderRef: orderRef, customerPhone: phone, customerName: name, updatedBy: currentUser.username || 'Staff' })
    });
    var data = await resp.json();
    if (!data.ok) throw new Error(data.error || 'Failed');
    var smsMsg = data.smsSent ? '✅ Order marked READY and SMS sent!' : '✅ Order marked READY (SMS: ' + (data.smsError || 'not configured') + ')';
    showToast(smsMsg);
    await loadOnlineOrders();
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

// ════════════════════════════════════════════════════════
// ONLINE ORDER PRINT RECEIPT
// ════════════════════════════════════════════════════════
function printOnlineReceipt(orderRef) {
  var o = allOnlineOrders.find(function(x) { return x.order_ref === orderRef; });
  if (!o) { showToast('Order not found', 'error'); return; }
  var now = new Date();
  var printDate = now.toLocaleDateString('en-PH', {month:'short',day:'numeric',year:'numeric',timeZone:'Asia/Manila'}) + ' ' + now.toLocaleTimeString('en-PH', {hour:'2-digit',minute:'2-digit',hour12:true,timeZone:'Asia/Manila'});
  var itemRows = '';
  var itemsTotal = 0;
  if (o.items && o.items.length) {
    o.items.forEach(function(it) {
      var lineTotal = (it.unit_price || it.price || 0) * (it.quantity || 1);
      itemsTotal += lineTotal;
      itemRows += '<tr>' +
        '<td style="padding:3px 20px 3px 0;font-weight:bold;font-size:10pt">' + esc(it.item_name || it.name || '') +
        (it.size && it.size !== 'REGULAR' ? '<br><span style="font-size:9pt;color:#555">' + esc(it.size) + '</span>' : '') +
        '</td>' +
        '<td style="text-align:center;padding:3px 6px;font-size:10pt">' + (it.quantity || 1) + '</td>' +
        '<td style="text-align:right;padding:3px 6px;font-size:10pt">' + (it.unit_price || it.price || 0).toFixed(2) + '</td>' +
        '<td style="text-align:right;padding:3px 0 3px 6px;font-weight:bold;font-size:10pt">' + lineTotal.toFixed(2) + '</td>' +
        '</tr>';
    });
  }
  var grandTotal = parseFloat(o.total_amount || itemsTotal);
  var receiptHTML = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Receipt - ' + esc(orderRef) + '</title>' +
    '<style>* { margin:0; padding:0; box-sizing:border-box; } body { font-family:Arial,Helvetica,sans-serif; width:80mm; max-width:80mm; margin:0 auto; padding:0 2mm 0.5mm 2mm; font-size:11pt; color:#000; line-height:1.35; } .header { text-align:center; margin-bottom:0; } .header h1 { font-size:18pt; font-weight:bold; margin-bottom:1px; } .header p { font-size:10pt; color:#000; margin:0; line-height:1.3; } .divider { border-top:1px dashed #000; margin:1px 0; } .divider-thick { border-top:2px solid #000; margin:1px 0; } .info-row { display:flex; justify-content:space-between; font-size:11pt; margin:0; } .info-row .label { font-weight:bold; } table { width:100%; border-collapse:collapse; font-size:10pt; margin:0; } th { text-align:left; padding:4px 0 3px 0; border-bottom:1px solid #000; font-size:9pt; font-weight:bold; } th:nth-child(2),td:nth-child(2) { text-align:center; width:8%; } th:nth-child(3),td:nth-child(3) { text-align:right; width:15%; } th:nth-child(4),td:nth-child(4) { text-align:right; width:17%; } th,td { padding-left:6px; padding-right:6px; } th:first-child,td:first-child { padding-left:0; padding-right:20px; } th:last-child,td:last-child { padding-right:0; } td { padding:3px 0; vertical-align:top; } .total-row { display:flex; justify-content:space-between; margin:0; font-size:12pt; } .total-row.grand { font-size:18pt; font-weight:bold; } .footer { text-align:center; margin-top:0; } @media print { body { width:80mm; } }</style>' +
    '</head><body>' +
    '<div class="header"><h1>' + esc((APP_CONFIG&&APP_CONFIG.BUSINESS_NAME)||'My Cafe') + '</h1>' +
    '<p>' + esc((APP_CONFIG&&APP_CONFIG.ADDRESS)||'Purok 8 Daang Malinaw, Loma 4119') + '</p>' +
    '<p>TIN: 501-401-857-00005</p>' +'<p>Tel: 0967-400-0040</p>' +'<p>Amadeo, Cavite, Philippines</p>' +'<p>Non-VAT Registered</p></div>' +
    '<div class="divider-thick"></div>' +
    '<div class="info-row"><span class="label">Order:</span><span><b>' + esc(orderRef) + '</b></span></div>' +
    '<div class="info-row"><span class="label">Date:</span><span>' + esc(printDate) + '</span></div>' +
    '<div class="info-row"><span class="label">YANI ONLINE ORDER</span><span>📱 Online</span></div>' +
    '<div class="info-row"><span class="label">Customer:</span><span>' + esc(o.customer_name || '') + '</span></div>' +
    '<div class="info-row"><span class="label">Phone:</span><span>' + esc(o.customer_phone || '') + '</span></div>' +
    (o.delivery_address ? '<div class="info-row"><span class="label">Address:</span><span>' + esc(o.delivery_address) + '</span></div>' : '') +
    '<div class="divider"></div>' +
    '<table><tr><th>Item</th><th>Qty</th><th>Price</th><th>Total</th></tr>' + itemRows + '</table>' +
    '<div class="divider"></div>' +
    (parseFloat(o.delivery_fee||0)>0 ? '<div class="total-row"><span>Food Subtotal:</span><span>₱' + parseFloat(o.subtotal||0).toFixed(2) + '</span></div>' : '') +
    (parseFloat(o.delivery_fee||0)>0 ? '<div class="total-row"><span>Delivery Fee (Zone ' + (o.delivery_zone||'') + '):</span><span>₱' + parseFloat(o.delivery_fee).toFixed(2) + '</span></div>' : '') +
    '<div class="total-row grand"><span>TOTAL</span><span>₱' + grandTotal.toFixed(2) + '</span></div>' +
    '<div class="divider-thick"></div>' +
    '<div class="footer"><p style="font-size:10pt;margin-top:4px">Thank you for your order!</p>' +
    '<p style="font-size:9pt;margin-top:2px">Payment via: ' + esc(o.payment_method || 'Online') + '</p>' +
    '<p style="font-size:9pt;margin-top:2px">Status: ' + esc(o.status || '') + '</p></div>' +
    '</body></html>';
  // Use hidden iframe — bypasses popup blockers, works on mobile
  var existingFrame2 = document.getElementById('receiptPrintFrame');
  if (existingFrame2) existingFrame2.remove();
  var iframe2 = document.createElement('iframe');
  iframe2.id = 'receiptPrintFrame';
  iframe2.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:80mm;height:1px;border:none;visibility:hidden;';
  iframe2.onload = function() {
    setTimeout(function() {
      try {
        iframe2.contentWindow.focus();
        iframe2.contentWindow.print();
      } catch(e) {
        var w2 = window.open('', '_blank', 'width=420,height=750');
        if (w2) { w2.document.write(receiptHTML); w2.document.close();
          setTimeout(function(){ try{w2.focus();w2.print();}catch(e2){} }, 500); }
        else { showToast('⚠️ Allow popups to print receipts', 'error'); }
      }
    }, 400);
  };
  document.body.appendChild(iframe2);
  iframe2.contentWindow.document.open();
  iframe2.contentWindow.document.write(receiptHTML);
  iframe2.contentWindow.document.close();
  setTimeout(function() {
    try { iframe2.contentWindow.focus(); iframe2.contentWindow.print(); } catch(e) {}
  }, 2000);
}
// ════════════════════════════════════════════════════════
// ONLINE ORDER EDIT MODAL (OWNER only)
// ════════════════════════════════════════════════════════
var olEditOrderRef = null;

function openOlEditModal(orderRef) {
  var o = allOnlineOrders.find(function(x) { return x.order_ref === orderRef; });
  if (!o) { showToast('Order not found', 'error'); return; }
  olEditOrderRef = orderRef;
  document.getElementById('olEditTitle').textContent = '✏️ Edit Online Order — ' + orderRef;
  document.getElementById('olEditBody').innerHTML =
    '<div class="ol-edit-field">' +
      '<label class="ol-edit-label">Customer Name</label>' +
      '<input class="ol-edit-input" id="olEditName" type="text" value="' + esc(o.customer_name || '') + '" placeholder="Full name">' +
    '</div>' +
    '<div class="ol-edit-field">' +
      '<label class="ol-edit-label">Phone Number</label>' +
      '<input class="ol-edit-input" id="olEditPhone" type="tel" value="' + esc(o.customer_phone || '') + '" placeholder="09XXXXXXXXX">' +
    '</div>' +
    '<div class="ol-edit-field">' +
      '<label class="ol-edit-label">Special Instructions</label>' +
      '<textarea class="ol-edit-input ol-edit-textarea" id="olEditInstructions" placeholder="Any special requests...">' + esc(o.special_instructions || '') + '</textarea>' +
    '</div>' +
    '<div class="ol-edit-field">' +
      '<label class="ol-edit-label">Admin Notes (internal)</label>' +
      '<textarea class="ol-edit-input ol-edit-textarea" id="olEditAdminNotes" placeholder="Internal notes, not shown to customer...">' + esc(o.admin_notes || '') + '</textarea>' +
    '</div>';
  document.getElementById('olEditOverlay').classList.add('open');
}

function closeOlEditModal(evt) {
  if (evt && evt.target !== document.getElementById('olEditOverlay')) return;
  document.getElementById('olEditOverlay').classList.remove('open');
  olEditOrderRef = null;
}

async function olSaveEdit() {
  if (!olEditOrderRef) return;
  var name = (document.getElementById('olEditName').value || '').trim();
  var phone = (document.getElementById('olEditPhone').value || '').trim();
  var instructions = (document.getElementById('olEditInstructions').value || '').trim();
  var adminNotes = (document.getElementById('olEditAdminNotes').value || '').trim();
  if (!name) { showToast('Customer name is required', 'error'); return; }
  if (!phone) { showToast('Phone number is required', 'error'); return; }
  var btn = document.getElementById('olEditSaveBtn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    var resp = await fetch('/api/online-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'editOnlineOrder',
        orderRef: olEditOrderRef,
        customerName: name,
        customerPhone: phone,
        specialInstructions: instructions,
        adminNotes: adminNotes,
        updatedBy: currentUser.username || 'Owner'
      })
    });
    var data = await resp.json();
    if (!data.ok) throw new Error(data.error || 'Failed to save');
    showToast('✅ Order updated successfully');
    document.getElementById('olEditOverlay').classList.remove('open');
    olEditOrderRef = null;
    await loadOnlineOrders();
  } catch (e) {
    showToast('❌ Error: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '💾 Save Changes';
  }
}

async function olCancelOrder() {
  if (!olEditOrderRef) return;
  var confirmed = await ygcConfirm('✕ Cancel Online Order', 'Cancel order ' + olEditOrderRef + '? This cannot be undone.', 'Yes, Cancel', 'Keep Order');
  if (!confirmed) return;
  try {
    var resp = await fetch('/api/online-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'updateOnlineOrderStatus', orderRef: olEditOrderRef, status: 'CANCELLED', updatedBy: currentUser.username || 'Owner' })
    });
    var data = await resp.json();
    if (!data.ok) throw new Error(data.error || 'Failed');
    showToast('✅ Order cancelled');
    document.getElementById('olEditOverlay').classList.remove('open');
    olEditOrderRef = null;
    await loadOnlineOrders();
  } catch (e) {
    showToast('❌ Error: ' + e.message, 'error');
  }
}

// ════════════════════════════════════════════════════════
// SHEETS DATA VIEW (Online Orders + Customers from Google Sheets)
// ════════════════════════════════════════════════════════════
var sheetsOrdersData = [];
var sheetsCustomersData = [];
var currentSheetsTab = 'orders';


// ══════════════════════════════════════════════════════════
// ANALYTICS DASHBOARD
// ══════════════════════════════════════════════════════════
function fmt(n) { return '₱' + Number(n).toLocaleString('en-PH', {minimumFractionDigits:2,maximumFractionDigits:2}); }

async function loadAnalytics() {
  var el = document.getElementById('analyticsContent');
  if (!el) return;
  el.innerHTML = '<div style="text-align:center;padding:40px;color:var(--forest-mid)">Loading...</div>';

  try {
    var r = await api('getAnalytics', { userId: currentUser && currentUser.userId });
    if (!r || !r.ok) throw new Error(r && r.error || 'Failed');

    var s   = r.summary;
    var top = r.topItems || [];
    var hourly = r.hourly || [];

    // ── KPI cards ────────────────────────────────────────────────────────
    var todayChange = s.yesterday.revenue > 0
      ? ((s.today.revenue - s.yesterday.revenue) / s.yesterday.revenue * 100).toFixed(0)
      : null;
    var changeHtml = todayChange !== null
      ? '<span style="font-size:.75rem;color:' + (todayChange>=0?'#16a34a':'#dc2626') + '">' + (todayChange>=0?'▲':'▼') + Math.abs(todayChange) + '% vs yesterday</span>'
      : '';

    var dineIn   = s.typeSplit['DINE-IN']  || 0;
    var takeOut  = s.typeSplit['TAKE-OUT'] || 0;
    var typeTotal = dineIn + takeOut || 1;

    // ── Hourly bars (peak hours) ─────────────────────────────────────────
    var peakHours = hourly.filter(h=>h.count>0).slice(0,24);
    var maxCnt    = Math.max(1, ...hourly.map(h=>h.count));
    var hourlyHtml = '';
    var openHours  = [6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21];
    openHours.forEach(function(h) {
      var hd  = hourly[h] || { hour:h, count:0 };
      var pct = Math.round(hd.count / maxCnt * 100);
      var lbl = h < 12 ? h+'AM' : (h===12?'12PM':(h-12)+'PM');
      hourlyHtml += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">' +
        '<div style="width:40px;font-size:.72rem;color:var(--forest-mid);text-align:right">' + lbl + '</div>' +
        '<div style="flex:1;background:#f0f4f0;border-radius:4px;height:18px;overflow:hidden">' +
          '<div style="width:' + pct + '%;background:var(--forest);height:100%;border-radius:4px;transition:width .5s"></div>' +
        '</div>' +
        '<div style="width:28px;font-size:.72rem;color:var(--forest-mid)">' + (hd.count||'') + '</div>' +
      '</div>';
    });

    // ── Top items bars ───────────────────────────────────────────────────
    var maxQty   = Math.max(1, ...top.map(i=>i.qty));
    var topHtml  = '';
    top.forEach(function(item, idx) {
      var pct = Math.round(item.qty / maxQty * 100);
      topHtml += '<div style="margin-bottom:10px">' +
        '<div style="display:flex;justify-content:space-between;font-size:.82rem;margin-bottom:3px">' +
          '<span style="font-weight:600;color:var(--forest-deep)">' + (idx+1) + '. ' + esc(item.name) + '</span>' +
          '<span style="color:var(--forest-mid)">' + item.qty + ' sold · ' + fmt(item.revenue) + '</span>' +
        '</div>' +
        '<div style="background:#f0f4f0;border-radius:4px;height:10px;overflow:hidden">' +
          '<div style="width:' + pct + '%;background:var(--forest);height:100%;border-radius:4px"></div>' +
        '</div>' +
      '</div>';
    });

    // ── Daily sparkline (mini bars) ──────────────────────────────────────
    var daily    = r.daily || [];
    var maxRev   = Math.max(1, ...daily.map(d=>d.revenue));
    var spark    = daily.slice(-14); // last 14 days
    var sparkHtml = spark.map(function(d) {
      var h = Math.max(4, Math.round(d.revenue/maxRev*40));
      var isToday = d.day === new Date().toISOString().slice(0,10);
      return '<div title="' + d.day + ': ' + fmt(d.revenue) + ' (' + d.count + ' orders)" ' +
        'style="flex:1;display:flex;align-items:flex-end;padding:0 1px">' +
        '<div style="width:100%;height:' + h + 'px;background:' + (isToday?'var(--forest)':'#a8c5a0') + ';border-radius:2px 2px 0 0"></div>' +
        '</div>';
    }).join('');

    el.innerHTML =
      // KPI row
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px">' +
        kpiCard('Today\'s Revenue', fmt(s.today.revenue), s.today.orders + ' orders', changeHtml, '💰') +
        kpiCard('Last 7 Days', fmt(s.last7days.revenue), s.last7days.orders + ' orders', '', '📅') +
        kpiCard('Dine-In', dineIn + ' orders', Math.round(dineIn/typeTotal*100) + '% of orders', '', '🪑') +
        kpiCard('Take-Out', takeOut + ' orders', Math.round(takeOut/typeTotal*100) + '% of orders', '', '🥡') +
      '</div>' +

      // 14-day sparkline
      '<div style="background:#fff;border:1.5px solid var(--mist);border-radius:12px;padding:14px;margin-bottom:16px">' +
        '<div style="font-weight:700;font-size:.9rem;color:var(--forest-deep);margin-bottom:10px">📊 Daily Revenue — Last 14 Days</div>' +
        '<div style="display:flex;align-items:flex-end;height:44px;gap:0">' + sparkHtml + '</div>' +
        '<div style="display:flex;justify-content:space-between;font-size:.68rem;color:var(--forest-mid);margin-top:4px">' +
          '<span>' + (spark[0]&&spark[0].day||'') + '</span><span>Today</span>' +
        '</div>' +
      '</div>' +

      // Top items + Peak hours side by side
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px">' +
        '<div style="background:#fff;border:1.5px solid var(--mist);border-radius:12px;padding:14px">' +
          '<div style="font-weight:700;font-size:.9rem;color:var(--forest-deep);margin-bottom:12px">🏆 Top Items (All Time)</div>' +
          (topHtml || '<div style="color:var(--forest-mid);font-size:.82rem">No data yet</div>') +
        '</div>' +
        '<div style="background:#fff;border:1.5px solid var(--mist);border-radius:12px;padding:14px">' +
          '<div style="font-weight:700;font-size:.9rem;color:var(--forest-deep);margin-bottom:12px">⏰ Peak Hours (Today)</div>' +
          (hourlyHtml || '<div style="color:var(--forest-mid);font-size:.82rem">No orders today</div>') +
        '</div>' +
      '</div>' +

      // Payment method breakdown (30d)
      (function() {
        var pmIcons = {CASH:'💵',CARD:'💳',GCASH:'📱',MAYA:'📲',INSTAPAY:'🏦',BDO:'🏛️',BPI:'🏛️',UNIONBANK:'🏛️',OTHER:'💰',UNRECORDED:'⚠️'};
        var pb = r.paymentBreakdown || {};
        var pmKeys = Object.keys(pb).sort();
        var pmTotalRev = pmKeys.reduce(function(acc,k){ return acc + (pb[k].revenue||0); }, 0);
        var pmHtml = pmKeys.length === 0
          ? '<div style="color:var(--forest-mid);font-size:.82rem">No completed orders yet.</div>'
          : pmKeys.map(function(pm) {
              var d = pb[pm];
              var icon = pmIcons[pm] || '💰';
              var pct = pmTotalRev > 0 ? Math.round(d.revenue / pmTotalRev * 100) : 0;
              var isWarn = pm === 'UNRECORDED';
              return '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--mist)">' +
                '<span style="font-size:1rem">' + icon + '</span>' +
                '<div style="flex:1">' +
                  '<div style="font-size:.82rem;font-weight:700;color:' + (isWarn?'#92400E':'var(--forest-deep)') + '">' + pm + '</div>' +
                  '<div style="height:6px;background:#f0f4f0;border-radius:3px;margin-top:3px">' +
                    '<div style="width:' + pct + '%;height:100%;background:' + (isWarn?'#FCD34D':'var(--forest)') + ';border-radius:3px"></div>' +
                  '</div>' +
                '</div>' +
                '<div style="text-align:right">' +
                  '<div style="font-size:.8rem;font-weight:800;color:' + (isWarn?'#92400E':'var(--forest)') + '">₱' + parseFloat(d.revenue||0).toFixed(2) + '</div>' +
                  '<div style="font-size:.68rem;color:#9CA3AF">' + d.count + ' orders · ' + pct + '%</div>' +
                '</div>' +
              '</div>';
            }).join('');
        return '<div style="background:#fff;border:1.5px solid var(--mist);border-radius:12px;padding:14px;margin-bottom:16px">' +
          '<div style="font-weight:700;font-size:.9rem;color:var(--forest-deep);margin-bottom:4px">💳 Payment Methods (30d)</div>' +
          '<div style="font-size:.72rem;color:var(--forest-mid);margin-bottom:10px">Total discounts saved: <strong>₱' + parseFloat(s.totalDiscounts30d||0).toFixed(2) + '</strong></div>' +
          pmHtml + '</div>';
      })() +

      // Cancellation breakdown
      '<div style="background:#fff;border:1.5px solid var(--mist);border-radius:12px;padding:14px">' +
        '<div style="font-weight:700;font-size:.9rem;color:var(--forest-deep);margin-bottom:8px">❌ Cancellation Breakdown</div>' +
        '<div style="font-size:.82rem;color:var(--forest-mid);margin-bottom:8px">Real cancellations (excluding migration & test): <strong style="color:var(--forest-deep)">' + s.realCancellations + '</strong></div>' +
        Object.entries(r.cancelBreakdown||{}).map(function(kv) {
          return '<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--mist);font-size:.82rem">' +
            '<span style="color:var(--forest-deep)">' + esc(kv[0]) + '</span>' +
            '<span style="font-weight:700;color:var(--forest)">' + kv[1] + '</span>' +
          '</div>';
        }).join('') +
      '</div>';

  } catch(e) {
    el.innerHTML = '<div style="color:#dc2626;padding:20px">Error: ' + esc(String(e.message)) + '</div>';
  }
}

function kpiCard(title, value, sub, extra, icon) {
  return '<div style="background:#fff;border:1.5px solid var(--mist);border-radius:12px;padding:14px">' +
    '<div style="font-size:1.3rem;margin-bottom:4px">' + icon + '</div>' +
    '<div style="font-size:.78rem;color:var(--forest-mid);font-weight:600;text-transform:uppercase;letter-spacing:.04em">' + title + '</div>' +
    '<div style="font-size:1.3rem;font-weight:800;color:var(--forest-deep);margin:4px 0 2px">' + value + '</div>' +
    '<div style="font-size:.78rem;color:var(--forest-mid)">' + sub + '</div>' +
    (extra ? '<div style="margin-top:4px">' + extra + '</div>' : '') +
  '</div>';
}


async function loadSheetsData() {
  var countEl = document.getElementById('sheetsDataCount');
  if (countEl) countEl.textContent = 'Loading...';
  try {
    // Fetch online orders via Vercel proxy (avoids GAS auth redirect issue)
    var resp = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'getOnlineOrders' })
    });
    var data = await resp.json();
    sheetsOrdersData = (data.ok && data.orders) ? data.orders : [];

    // Fetch customers via Vercel proxy
    var custResp = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'getCustomers' })
    });
    var custData = await custResp.json();
    sheetsCustomersData = (custData.ok && custData.customers) ? custData.customers : [];

    if (countEl) countEl.textContent = sheetsOrdersData.length + ' orders · ' + sheetsCustomersData.length + ' customers';
    showSheetsTab(currentSheetsTab);
  } catch (e) {
    if (countEl) countEl.textContent = 'Error: ' + e.message;
    document.getElementById('sheetsOrdersTable').innerHTML = '<div style="text-align:center;padding:40px;color:#EF4444">⚠️ Failed to load: ' + esc(e.message) + '</div>';
  }
}

function showSheetsTab(tab) {
  currentSheetsTab = tab;
  var ordersPanel = document.getElementById('sheetsOrdersPanel');
  var customersPanel = document.getElementById('sheetsCustomersPanel');
  var tabOrders = document.getElementById('sheetsTabOrders');
  var tabCustomers = document.getElementById('sheetsTabCustomers');
  if (tab === 'orders') {
    ordersPanel.style.display = 'block';
    customersPanel.style.display = 'none';
    tabOrders.style.background = 'var(--forest)'; tabOrders.style.color = '#fff';
    tabCustomers.style.background = 'var(--mist-light)'; tabCustomers.style.color = 'var(--timber)';
    renderSheetsOrders();
  } else {
    ordersPanel.style.display = 'none';
    customersPanel.style.display = 'block';
    tabOrders.style.background = 'var(--mist-light)'; tabOrders.style.color = 'var(--timber)';
    tabCustomers.style.background = 'var(--forest)'; tabCustomers.style.color = '#fff';
    renderSheetsCustomers();
  }
}

function renderSheetsOrders() {
  var el = document.getElementById('sheetsOrdersTable');
  if (!sheetsOrdersData.length) {
    el.innerHTML = '<div style="text-align:center;padding:40px;color:var(--timber)">No online orders in Google Sheets yet.<br><small>Orders will appear here after customers place orders online.</small></div>';
    return;
  }
  var statusColors = {
    'PENDING': '#FEF3C7', 'CONFIRMED': '#D1FAE5', 'PREPARING': '#EDE9FE',
    'READY': '#D1FAE5', 'COMPLETED': '#F3F4F6', 'CANCELLED': '#FEE2E2'
  };
  var html = '<table style="width:100%;border-collapse:collapse;font-size:.82rem;min-width:700px">';
  html += '<thead><tr style="background:var(--forest-deep);color:#fff">';
  ['Order Ref','Date','Customer','Phone','Type','Total','Payment','Pay Status','Order Status'].forEach(function(h) {
    html += '<th style="padding:8px 10px;text-align:left;white-space:nowrap">' + h + '</th>';
  });
  html += '</tr></thead><tbody>';
  sheetsOrdersData.forEach(function(o, i) {
    var bg = i % 2 === 0 ? '#fff' : '#f9fafb';
    var statusBg = statusColors[String(o.orderStatus || '').toUpperCase()] || '#f3f4f6';
    var dateStr = o.date ? new Date(o.date).toLocaleString('en-PH', {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '';
    html += '<tr style="background:' + bg + ';border-bottom:1px solid #e5e7eb">';
    html += '<td style="padding:8px 10px;font-weight:700;color:var(--forest-deep)">' + esc(String(o.orderRef || '')) + '</td>';
    html += '<td style="padding:8px 10px;white-space:nowrap">' + esc(dateStr) + '</td>';
    html += '<td style="padding:8px 10px;font-weight:600">' + esc(String(o.customerName || '')) + '</td>';
    html += '<td style="padding:8px 10px">' + esc(String(o.phone || '')) + '</td>';
    html += '<td style="padding:8px 10px">' + esc(String(o.courierType || 'PICKUP')) + '</td>';
    html += '<td style="padding:8px 10px;font-weight:700;color:var(--forest-deep)">₱' + parseFloat(o.totalAmount || 0).toLocaleString() + '</td>';
    html += '<td style="padding:8px 10px">' + esc(String(o.paymentMethod || '')) + '</td>';
    html += '<td style="padding:8px 10px">' + esc(String(o.paymentStatus || '')) + '</td>';
    html += '<td style="padding:8px 10px"><span style="background:' + statusBg + ';padding:3px 8px;border-radius:10px;font-size:.75rem;font-weight:700">' + esc(String(o.orderStatus || '')) + '</span></td>';
    html += '</tr>';
  });
  html += '</tbody></table>';
  el.innerHTML = html;
}

function renderSheetsCustomers() {
  var el = document.getElementById('sheetsCustomersTable');
  if (!sheetsCustomersData.length) {
    el.innerHTML = '<div style="text-align:center;padding:40px;color:var(--timber)">No customer data in Google Sheets yet.<br><small>Customer records are created automatically when orders are placed.</small></div>';
    return;
  }
  var html = '<table style="width:100%;border-collapse:collapse;font-size:.82rem;min-width:500px">';
  html += '<thead><tr style="background:var(--forest-deep);color:#fff">';
  ['Phone','Customer Name','First Order','Last Order','Total Orders','Total Spend'].forEach(function(h) {
    html += '<th style="padding:8px 10px;text-align:left;white-space:nowrap">' + h + '</th>';
  });
  html += '</tr></thead><tbody>';
  sheetsCustomersData.forEach(function(c, i) {
    var bg = i % 2 === 0 ? '#fff' : '#f9fafb';
    var firstDate = c.firstOrderDate ? new Date(c.firstOrderDate).toLocaleDateString('en-PH', {month:'short',day:'numeric',year:'numeric'}) : '';
    var lastDate  = c.lastOrderDate  ? new Date(c.lastOrderDate).toLocaleDateString('en-PH', {month:'short',day:'numeric',year:'numeric'}) : '';
    html += '<tr style="background:' + bg + ';border-bottom:1px solid #e5e7eb">';
    html += '<td style="padding:8px 10px;font-weight:600">' + esc(String(c.phone || '')) + '</td>';
    html += '<td style="padding:8px 10px;font-weight:700;color:var(--forest-deep)">' + esc(String(c.customerName || '')) + '</td>';
    html += '<td style="padding:8px 10px;white-space:nowrap">' + esc(firstDate) + '</td>';
    html += '<td style="padding:8px 10px;white-space:nowrap">' + esc(lastDate) + '</td>';
    html += '<td style="padding:8px 10px;text-align:center;font-weight:700">' + esc(String(c.totalOrders || 0)) + '</td>';
    html += '<td style="padding:8px 10px;font-weight:700;color:var(--forest-deep)">₱' + parseFloat(c.totalSpend || 0).toLocaleString() + '</td>';
    html += '</tr>';
  });
  html += '</tbody></table>';
  el.innerHTML = html;
}

// ══════════════════════════════════════════════════════════
// SYSTEM HEALTH CHECK & MENU SYNC
// ══════════════════════════════════════════════════════════

async function runHealthCheck() {
  if (!currentUser || (currentUser.role !== 'ADMIN' && currentUser.role !== 'OWNER')) return;
  try {
    var resp = await fetch('/api/health');
    var data = await resp.json();
    var banner = document.getElementById('healthBanner');
    var bannerTitle = document.getElementById('healthBannerTitle');
    var bannerBody = document.getElementById('healthBannerBody');

    if (!data.alerts || data.alerts.length === 0) {
      banner.style.display = 'none';
      return;
    }

    var hasError = data.alerts.some(function(a){ return a.level === 'ERROR'; });
    banner.className = 'health-banner ' + (hasError ? 'error' : 'warn');
    bannerTitle.textContent = hasError ? '🔴 System Issue Detected' : '⚠️ System Warning';

    var lines = data.alerts.map(function(a) {
      return '<div style="margin-bottom:3px"><strong>' + esc(a.source) + ':</strong> ' + esc(a.message) +
        (a.impact ? ' <span style="opacity:.75">— ' + esc(a.impact) + '</span>' : '') + '</div>';
    });

    // Add menu sync status
    if (data.menu && data.menu.drift !== null && data.menu.drift > 0) {
      lines.push('<div style="margin-top:4px;opacity:.8">Menu drift: ' + data.menu.gasCount + ' items in GAS vs ' + data.menu.supabaseCount + ' in Supabase (' + data.menu.drift + ' out of sync)</div>');
    }

    bannerBody.innerHTML = lines.join('');
    banner.style.display = 'block';
  } catch(e) {
    console.warn('Health check failed:', e.message);
  }
}

async function runMenuSync() {
  var btn = event && event.target;
  if (btn) { btn.textContent = '⏳ Syncing...'; btn.disabled = true; }
  try {
    var resp = await fetch('/api/sync-menu', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
    var data = await resp.json();
    if (data.ok) {
      showToast('✅ ' + (data.message || 'Menu sync complete'));
    } else {
      showToast('❌ Sync failed: ' + (data.error || 'Unknown error'), 'error');
    }
  } catch (e) {
    showToast('❌ Sync error: ' + e.message, 'error');
  }
  if (btn) { btn.textContent = '🔧 Sync Menu Now'; btn.disabled = false; }
}

// ══════════════════════════════════════════════════════════
// NON-BLOCKING PROMPT DIALOG (fixes INP on reject payment button)
// ══════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════
// SELECT PROMPT (cancel reason dropdown)
// ══════════════════════════════════════════════════════════
function ygcSelectPrompt(title, msg, options) {
  return new Promise(function(resolve) {
    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
    var box = document.createElement('div');
    box.style.cssText = 'background:#fff;border-radius:16px;padding:24px;max-width:380px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.3)';
    var html = '<div style="font-weight:700;font-size:16px;margin-bottom:8px;color:#1a1a1a">'+title+'</div>'
             + '<div style="font-size:13px;color:#666;margin-bottom:16px">'+msg+'</div>';
    options.forEach(function(opt,i) {
      html += '<label style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:8px;cursor:pointer;margin-bottom:6px;border:1.5px solid #e5e7eb;font-size:13px">'
            + '<input type="radio" name="ygcReason" value="'+opt.value+'"'+(i===0?' checked':'')+' style="accent-color:#3b82f6">'
            + opt.label+'</label>';
    });
    html += '<div style="display:flex;gap:10px;margin-top:18px">'
          + '<button id="ygcSelCancel" style="flex:1;padding:10px;border-radius:8px;border:1.5px solid #e5e7eb;background:#fff;cursor:pointer;font-weight:600;color:#666">Keep Order</button>'
          + '<button id="ygcSelOk" style="flex:1;padding:10px;border-radius:8px;border:none;background:#ef4444;color:#fff;cursor:pointer;font-weight:700">Cancel Order</button>'
          + '</div>';
    box.innerHTML = html;
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    function cleanup() { document.body.removeChild(overlay); }
    document.getElementById('ygcSelOk').onclick = function() {
      var sel = box.querySelector('input[name="ygcReason"]:checked');
      cleanup(); resolve(sel ? sel.value : options[0].value);
    };
    document.getElementById('ygcSelCancel').onclick = function() { cleanup(); resolve(null); };
    overlay.onclick = function(e) { if (e.target === overlay) { cleanup(); resolve(null); } };
  });
}

// ══════════════════════════════════════════════════════════
// NON-BLOCKING PROMPT DIALOG
// ══════════════════════════════════════════════════════════
function ygcPrompt(title, msg, placeholder) {
  return new Promise(function(resolve) {
    var overlay = document.getElementById('ygcPromptOverlay');
    document.getElementById('ygcPromptTitle').textContent = title || 'Enter value';
    document.getElementById('ygcPromptMsg').textContent = msg || '';
    var inp = document.getElementById('ygcPromptInput');
    inp.value = '';
    inp.placeholder = placeholder || '';
    overlay.classList.add('open');
    setTimeout(function() { inp.focus(); }, 50);
    function cleanup() { overlay.classList.remove('open'); }
    document.getElementById('ygcPromptOkBtn').onclick = function() {
      var val = inp.value.trim();
      cleanup(); resolve(val === '' ? null : val);
    };
    document.getElementById('ygcPromptCancelBtn').onclick = function() { cleanup(); resolve(null); };
    overlay.onclick = function(e) { if (e.target === overlay) { cleanup(); resolve(null); } };
    inp.onkeydown = function(e) {
      if (e.key === 'Enter') { var val = inp.value.trim(); cleanup(); resolve(val === '' ? null : val); }
      if (e.key === 'Escape') { cleanup(); resolve(null); }
    };
  });
}

// ══════════════════════════════════════════════════════════
// NON-BLOCKING CONFIRM DIALOG (fixes INP on cancel/delete buttons)
// ══════════════════════════════════════════════════════════
function ygcConfirm(title, msg, okLabel, cancelLabel) {
  return new Promise(function(resolve) {
    var overlay = document.getElementById('ygcConfirmOverlay');
    document.getElementById('ygcConfirmTitle').textContent = title || 'Confirm';
    document.getElementById('ygcConfirmMsg').textContent = msg || '';
    document.getElementById('ygcConfirmOkBtn').textContent = okLabel || 'OK';
    document.getElementById('ygcConfirmCancelBtn').textContent = cancelLabel || 'Cancel';
    overlay.classList.add('open');
    function cleanup() { overlay.classList.remove('open'); }
    document.getElementById('ygcConfirmOkBtn').onclick = function() { cleanup(); resolve(true); };
    document.getElementById('ygcConfirmCancelBtn').onclick = function() { cleanup(); resolve(false); };
    overlay.onclick = function(e) { if (e.target === overlay) { cleanup(); resolve(false); } };
  });
}

// Non-blocking toast notification (replaces alert() for success messages)
function showToast(msg, durationMs) {
  var existing = document.getElementById('ygcToast');
  if (existing) existing.remove();
  var toast = document.createElement('div');
  toast.id = 'ygcToast';
  toast.textContent = msg;
  toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1a3a2a;color:#fff;padding:12px 24px;border-radius:10px;font-size:.9rem;font-weight:600;z-index:9999;box-shadow:0 4px 16px rgba(0,0,0,.3);pointer-events:none;transition:opacity .3s';
  document.body.appendChild(toast);
  setTimeout(function() {
    toast.style.opacity = '0';
    setTimeout(function() { if (toast.parentNode) toast.remove(); }, 350);
  }, durationMs || 2500);
}

// ══════════════════════════════════════════════════════════════
// QUEUE MONITOR — Admin panel for order queue visibility
// ══════════════════════════════════════════════════════════════
var _qmOpen = false;
var _qmDeadOrders = [];
var _qmDeadListOpen = false;
var _qmRefreshTimer = null;

function initQueueMonitor() {
  const panel = document.getElementById('queueMonitor');
  if (panel) {
    panel.style.display = 'block';
    loadQueueStats();
    // Auto-refresh every 30 seconds
    _qmRefreshTimer = setInterval(loadQueueStats, 30000);
  }
}

function toggleQueueMonitor() {
  _qmOpen = !_qmOpen;
  const body = document.getElementById('qmBody');
  const icon = document.getElementById('qmToggleIcon');
  if (body) body.classList.toggle('open', _qmOpen);
  if (icon) icon.textContent = _qmOpen ? '▲' : '▼';
}

async function loadQueueStats() {
  const dot = document.getElementById('qmDot');
  const summary = document.getElementById('qmSummary');
  try {
    const r = await fetch('/api/queue-status?action=getQueueStats');
    const data = await r.json();
    if (!data.ok) throw new Error(data.error);
    const s = data.stats;
    document.getElementById('qmPending').textContent = s.pending;
    document.getElementById('qmProcessing').textContent = s.processing;
    document.getElementById('qmCompleted').textContent = s.completed;
    document.getElementById('qmDead').textContent = s.dead;
    // Update dot color
    if (dot) {
      dot.className = 'qm-dot';
      if (s.dead > 0) dot.classList.add('error');
      else if (s.pending > 0 || s.processing > 0) dot.classList.add('busy');
    }
    // Summary text
    if (summary) {
      if (s.pending === 0 && s.processing === 0 && s.dead === 0) {
        summary.textContent = 'All clear';
      } else {
        const parts = [];
        if (s.pending > 0) parts.push(s.pending + ' pending');
        if (s.processing > 0) parts.push(s.processing + ' processing');
        if (s.dead > 0) parts.push(s.dead + ' dead');
        summary.textContent = parts.join(' · ');
      }
    }
    // Avg processing time
    const avgEl = document.getElementById('qmAvgTime');
    if (avgEl && s.avgProcessingTimeMs) {
      avgEl.textContent = 'Avg processing time: ' + (s.avgProcessingTimeMs / 1000).toFixed(1) + 's (last 24h)';
    }
    // Show/hide dead order buttons
    const retryBtn = document.getElementById('qmRetryAllBtn');
    const viewBtn = document.getElementById('qmViewDeadBtn');
    if (retryBtn) retryBtn.style.display = s.dead > 0 ? '' : 'none';
    if (viewBtn) viewBtn.style.display = s.dead > 0 ? '' : 'none';
  } catch (e) {
    if (summary) summary.textContent = 'Error loading stats';
    if (dot) { dot.className = 'qm-dot error'; }
  }
}

async function toggleDeadList() {
  _qmDeadListOpen = !_qmDeadListOpen;
  const list = document.getElementById('qmDeadList');
  const btn = document.getElementById('qmViewDeadBtn');
  if (!_qmDeadListOpen) {
    if (list) list.style.display = 'none';
    if (btn) btn.textContent = '📋 View Dead Orders';
    return;
  }
  if (btn) btn.textContent = '📋 Hide Dead Orders';
  try {
    const r = await fetch('/api/queue-status?action=getDeadOrders');
    const data = await r.json();
    _qmDeadOrders = data.orders || [];
    renderDeadList();
    if (list) list.style.display = 'block';
  } catch (e) {
    showToast('Failed to load dead orders: ' + e.message, 3000);
  }
}

function renderDeadList() {
  const list = document.getElementById('qmDeadList');
  if (!list) return;
  if (_qmDeadOrders.length === 0) {
    list.innerHTML = '<div style="font-size:.72rem;color:var(--timber);padding:8px">No dead orders</div>';
    return;
  }
  list.innerHTML = _qmDeadOrders.map(o => `
    <div class="queue-dead-item">
      <div class="queue-dead-ref">${o.order_ref} <span style="font-weight:400;color:var(--timber)">${new Date(o.created_at).toLocaleString('en-PH')}</span></div>
      <div class="queue-dead-err">${o.error_message || 'No error message'}</div>
      <div class="queue-dead-actions">
        <button class="queue-dead-retry-btn" onclick="retrySingleDead('${o.order_ref}', ${o.id})">↩ Retry</button>
      </div>
    </div>
  `).join('');
}

async function retrySingleDead(orderRef, queueId) {
  try {
    const r = await fetch('/api/queue-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'retryDead', orderRef, queueId })
    });
    const data = await r.json();
    if (data.ok) {
      showToast('Order ' + orderRef + ' queued for retry', 2500);
      loadQueueStats();
      _qmDeadOrders = _qmDeadOrders.filter(o => o.order_ref !== orderRef);
      renderDeadList();
    } else {
      showToast('Retry failed: ' + data.error, 3000);
    }
  } catch (e) {
    showToast('Error: ' + e.message, 3000);
  }
}

async function retryAllDead() {
  if (!_qmDeadOrders.length) {
    // Fetch dead orders first
    const r = await fetch('/api/queue-status?action=getDeadOrders');
    const data = await r.json();
    _qmDeadOrders = data.orders || [];
  }
  if (_qmDeadOrders.length === 0) {
    showToast('No dead orders to retry', 2000);
    return;
  }
  let retried = 0;
  for (const o of _qmDeadOrders) {
    try {
      await fetch('/api/queue-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'retryDead', orderRef: o.order_ref, queueId: o.id })
      });
      retried++;
    } catch (e) {}
  }
  showToast(retried + ' dead orders queued for retry', 2500);
  _qmDeadOrders = [];
  loadQueueStats();
  if (_qmDeadListOpen) renderDeadList();
}

// ══════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════
// SETTINGS
// ══════════════════════════════════════════════════════════
var _settings = {};

var _currentSettingsTab = 'general';

async function loadSettings() {
  var r = await api('getSettings', { userId: currentUser.userId });
  if (!r.ok) { showToast('Failed to load settings', 'error'); return; }
  _settings = {};
  (r.settings || []).forEach(function(s) { _settings[s.key] = s.value; });
  switchSettingsTab(_currentSettingsTab);
}

function switchSettingsTab(tab) {
  _currentSettingsTab = tab;
  ['general','payment','branding','operations'].forEach(function(t) {
    var el = document.getElementById('stab-' + t);
    if (el) el.className = 's-tab' + (t === tab ? ' active' : '');
  });
  var content = document.getElementById('settingsContent');
  if (!content) return;
  if (tab === 'general') content.innerHTML = _settingsGeneral();
  else if (tab === 'payment') content.innerHTML = _settingsPayment();
  else if (tab === 'branding') content.innerHTML = _settingsBranding();
  else if (tab === 'operations') content.innerHTML = _settingsOperations();
}

function _sField(id, label, val, type, placeholder) {
  type = type || 'text';
  return '<div class="s-field"><label>' + label + '</label>'
    + (type === 'textarea'
      ? '<textarea id="' + id + '" rows="2">' + (val||'') + '</textarea>'
      : '<input type="' + type + '" id="' + id + '" value="' + (val||'') + '" placeholder="' + (placeholder||'') + '">')
    + '</div>';
}

function _sToggle(id, label, sub, checked) {
  return '<div class="s-toggle-row"><div><div class="s-toggle-label">' + label + '</div>'
    + '<div class="s-toggle-sub">' + sub + '</div></div>'
    + '<label class="s-toggle"><input type="checkbox" id="' + id + '"' + (checked ? ' checked' : '') + '>'
    + '<span class="s-toggle-slider"></span></label></div>';
}

function _settingsGeneral() {
  var s = _settings;
  return '<div class="s-card"><div class="s-card-title">🏪 Business Information</div>'
    + _sField('s_business_name', 'Business Name', s.BUSINESS_NAME, 'text')
    + _sField('s_tagline', 'Tagline', s.TAGLINE, 'text', 'e.g. Garden Cafe')
    + _sField('s_account_name', 'Account Name (for receipts)', s.ACCOUNT_NAME, 'text')
    + _sField('s_address', 'Address', s.ADDRESS, 'text')
    + _sField('s_admin_phone', 'Contact Number', s.ADMIN_PHONE, 'text', '+63 9XX XXX XXXX')
    + _sField('s_receipt_email', 'Receipt Email', s.RECEIPT_EMAIL, 'email')
    + '</div>'
    + '<div class="s-card"><div class="s-card-title">🧾 Receipt Settings</div>'
    + _sField('s_order_prefix', 'Order ID Prefix', s.ORDER_PREFIX, 'text', 'e.g. YANI')
    + _sField('s_or_start', 'OR Number Start', s.OR_NUMBER_START, 'number')
    + _sField('s_receipt_footer', 'Receipt Footer Message', s.RECEIPT_FOOTER, 'textarea')
    + '</div>'
    + '<button class="s-save-btn" onclick="saveGeneralSettings(this)">💾 Save General Settings</button>';
}

function _settingsPayment() {
  var s = _settings;
  function qrCard(title, code, urlKey, accountKey, accountLabel) {
    var url = s[urlKey] || '';
    var acc = accountKey ? (s[accountKey] || '') : '';
    var inputId = 's_' + urlKey.toLowerCase();
    var fileId = 'qrfile_' + code.toLowerCase();
    var previewId = 'qrprev_' + code.toLowerCase();
    // Google Drive URLs don't render in img tags — only warn for actual Drive URLs
    var isDrive = url && url.indexOf('drive.google.com') >= 0;
    var isSupabase = url && url.indexOf('supabase.co') >= 0;
    var isLocal = url && (url.startsWith('/images/') || url.startsWith('/api/'));
    isDrive = isDrive && !isSupabase && !isLocal; // don't warn if already migrated
    var showImg = url && !isDrive;
    return '<div class="s-card">'
      + '<div class="s-card-title">' + title + '</div>'
      + (isDrive ? '<div id="drivewarn_' + code.toLowerCase() + '" style="background:#FEF3C7;border:1px solid #FCD34D;border-radius:8px;padding:8px 12px;margin-bottom:12px;font-size:.75rem;color:#92400E">⚠️ Your current QR is stored on Google Drive which can\'t preview here. Use <strong>Upload Image</strong> to move it to the server.</div>' : '')
      + '<div style="display:flex;gap:14px;align-items:flex-start;margin-bottom:12px">'
      + '<div style="flex-shrink:0">'
      + '<img id="' + previewId + '" src="' + (showImg ? url : '') + '" onerror="this.style.display=\'none\';var ph=document.getElementById(\'' + previewId + '_placeholder\');if(ph)ph.style.display=\'flex\';" style="width:80px;height:80px;object-fit:contain;border-radius:8px;border:1.5px solid var(--mist);background:#f8f8f8;display:' + (showImg ? 'block' : 'none') + '">'
      + '<div id="' + previewId + '_placeholder" style="width:80px;height:80px;border-radius:8px;border:2px dashed var(--mist);display:' + (showImg ? 'none' : 'flex') + ';align-items:center;justify-content:center;font-size:.65rem;color:var(--timber);text-align:center;flex-direction:column">📷<br>' + (isDrive ? 'Drive URL' : 'No QR') + '</div>'
      + '</div>'
      + '<div style="flex:1">'
      + '<div class="s-field" style="margin-bottom:8px"><label>QR Code Image URL</label>'
      + '<input type="url" id="' + inputId + '" value="' + (url||'') + '" placeholder="https://..." oninput="updateQrPreview(\'' + previewId + '\',this.value)">'

      + '</div>'
      + '<input type="file" id="' + fileId + '" accept="image/png,image/jpeg,image/webp" style="display:none" onchange="uploadQrCode(\'' + code + '\',\'' + inputId + '\',\'' + previewId + '\',this)">'
      + '<button onclick="document.getElementById(\'' + fileId + '\').click()" style="padding:7px 14px;background:var(--forest);color:#fff;border:none;border-radius:8px;font-size:.78rem;font-weight:700;cursor:pointer">⬆️ Upload Image</button>'
      + '<span id="' + fileId + '_status" style="font-size:.72rem;color:var(--timber);margin-left:8px"></span>'
      + '</div>'
      + '</div>'
      + (accountKey ? '<div class="s-field"><label>' + (accountLabel||'Account Number') + '</label><input type="text" id="s_' + accountKey.toLowerCase() + '" value="' + acc + '"></div>' : '')
      + '</div>';
  }
  return qrCard('📱 GCash', 'GCASH', 'GCASH_QR_URL', 'GCASH_NUMBER', 'GCash Number')
    + qrCard('🏦 InstaPay', 'INSTAPAY', 'INSTAPAY_QR_URL', null, null)
    + qrCard('🏛️ BDO', 'BDO', 'BDO_QR_URL', 'BDO_ACCOUNT', 'BDO Account Number')
    + qrCard('🏛️ BPI', 'BPI', 'BPI_QR_URL', 'BPI_ACCOUNT', 'BPI Account Number')
    + qrCard('🏛️ UnionBank', 'UNIONBANK', 'UNIONBANK_QR_URL', 'UNIONBANK_ACCOUNT', 'UnionBank Account Number')
    + '<button class="s-save-btn" onclick="savePaymentSettings(this)">💾 Save Payment Settings</button>';
}

async function uploadLogoImage(fileInput) {
  var statusEl = document.getElementById('logoUploadStatus');
  var file = fileInput.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) { statusEl.textContent = '❌ Max 2MB'; statusEl.style.color = '#e04444'; return; }

  statusEl.textContent = 'Uploading...';
  statusEl.style.color = 'var(--timber)';

  var formData = new FormData();
  formData.append('file', file);
  formData.append('folder', 'logos');
  formData.append('filename', 'logo_' + Date.now() + '_' + file.name.replace(/[^a-zA-Z0-9._-]/g, '_'));

  try {
    var resp = await fetch('/api/upload-image', { method: 'POST', body: formData });
    var result = await resp.json();
    if (!resp.ok || !result.url) throw new Error(result.error || 'Upload failed');

    // Update preview + URL field
    var urlEl = document.getElementById('s_logo_url');
    var preview = document.getElementById('logoPreview');
    if (urlEl) urlEl.value = result.url;
    if (preview) { preview.src = result.url; preview.style.display = 'block'; }

    statusEl.textContent = '✅ Uploaded!';
    statusEl.style.color = '#059669';
  } catch(e) {
    statusEl.textContent = '❌ ' + e.message;
    statusEl.style.color = '#e04444';
  }
}

function updateQrPreview(previewId, url) {
  var img = document.getElementById(previewId);
  var ph = document.getElementById(previewId + '_placeholder');
  if (!img) return;
  if (url) {
    img.src = url;
    img.style.display = 'block';
    if (ph) ph.style.display = 'none';
    // onerror on img handles failed loads (e.g. Google Drive CORS blocks)
  } else {
    img.style.display = 'none';
    img.src = '';
    if (ph) ph.style.display = 'flex';
  }
}

async function uploadQrCode(code, inputId, previewId, fileInput) {
  var file = fileInput.files[0];
  if (!file) return;
  var statusEl = document.getElementById(fileInput.id + '_status');
  statusEl.textContent = 'Uploading…';
  try {
    var base64 = await new Promise(function(res, rej) {
      var r = new FileReader();
      r.onload = function(e) { res(e.target.result.split(',')[1]); };
      r.onerror = rej;
      r.readAsDataURL(file);
    });
    var ext = file.name.split('.').pop().toLowerCase();
    var resp = await fetch('/api/upload-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'QR_' + code, ext: ext, base64: base64 })
    });
    var result = await resp.json();
    if (result.ok) {
      var urlInput = document.getElementById(inputId);
      urlInput.value = result.path;
      updateQrPreview(previewId, result.path);
      statusEl.textContent = '✅ Uploaded!';
      statusEl.style.color = '#059669';
      // Hide Drive warning banner if present
      var warn = document.getElementById('drivewarn_' + code.toLowerCase());
      if (warn) warn.style.display = 'none';
    } else {
      statusEl.textContent = '❌ ' + (result.error || 'Upload failed');
      statusEl.style.color = '#EF4444';
    }
  } catch(e) {
    statusEl.textContent = '❌ Error: ' + e.message;
    statusEl.style.color = '#EF4444';
  }
}

function _settingsBranding() {
  var s = _settings;
  return '<div class="s-card"><div class="s-card-title">🎨 Brand Colors</div>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">'
    + '<div class="s-field"><label>Primary Color</label><div style="display:flex;gap:8px;align-items:center"><input type="color" id="s_primary_color" value="' + (s.PRIMARY_COLOR||'#314C47') + '" style="width:44px;height:36px;padding:2px;border-radius:6px;cursor:pointer"><input type="text" id="s_primary_color_hex" value="' + (s.PRIMARY_COLOR||'#314C47') + '" oninput="document.getElementById(\'s_primary_color\').value=this.value" style="flex:1"></div></div>'
    + '<div class="s-field"><label>Accent Color</label><div style="display:flex;gap:8px;align-items:center"><input type="color" id="s_secondary_color" value="' + (s.SECONDARY_COLOR||'#C4704B') + '" style="width:44px;height:36px;padding:2px;border-radius:6px;cursor:pointer"><input type="text" id="s_secondary_color_hex" value="' + (s.SECONDARY_COLOR||'#C4704B') + '" oninput="document.getElementById(\'s_secondary_color\').value=this.value" style="flex:1"></div></div>'
    + '</div>'
    + '<div style="margin-top:12px;padding:12px;background:var(--mist-light);border-radius:10px">'
    + '<div style="font-size:.72rem;color:var(--timber);margin-bottom:8px;font-weight:600">PREVIEW</div>'
    + '<div id="s_color_preview" style="background:var(--forest);color:#fff;padding:10px 16px;border-radius:8px;font-weight:700;text-align:center">' + (s.BUSINESS_NAME||'Your Cafe') + '</div>'
    + '</div></div>'
    + '<div class="s-card"><div class="s-card-title">🖼️ Logo</div>'
    + '<div style="display:flex;align-items:flex-start;gap:16px;margin-bottom:12px">'
    + '<div style="flex-shrink:0">'
    + (s.LOGO_URL ? '<img id="logoPreview" src="' + s.LOGO_URL + '" onerror="this.style.display=\'none\'" style="width:80px;height:80px;object-fit:contain;border-radius:8px;border:1.5px solid var(--mist);background:#f8f8f8">'
                  : '<div id="logoPreview" style="width:80px;height:80px;border-radius:8px;border:2px dashed var(--mist);display:flex;align-items:center;justify-content:center;font-size:.65rem;color:var(--timber);text-align:center">No Logo</div>')
    + '</div>'
    + '<div style="flex:1">'
    + '<div style="font-size:.72rem;font-weight:600;color:var(--timber);text-transform:uppercase;margin-bottom:6px">Logo Image URL</div>'
    + '<input id="s_logo_url" type="text" value="' + (s.LOGO_URL||'') + '" placeholder="/images/logo.png" style="width:100%;padding:7px 10px;border:1.5px solid var(--mist);border-radius:8px;font-size:.82rem;box-sizing:border-box;font-family:var(--font-body);margin-bottom:8px" oninput="document.getElementById(\'logoPreview\').src=this.value">'
    + '<div style="display:flex;align-items:center;gap:10px">'
    + '<label style="padding:7px 14px;background:var(--forest);color:#fff;border-radius:8px;font-size:.78rem;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:6px">'
    + '📤 Upload Logo<input type="file" accept="image/*" onchange="uploadLogoImage(this)" style="display:none"></label>'
    + '<span id="logoUploadStatus" style="font-size:.72rem;color:var(--timber)"></span>'
    + '</div>'
    + '<div style="font-size:.68rem;color:var(--timber);margin-top:6px">PNG or JPG recommended. Appears on receipts and the POS header.</div>'
    + '</div></div>'
    + '</div>'
    + '<div class="s-card"><div class="s-card-title">🌿 Welcome Screen</div>'
    + '<div style="font-size:.75rem;color:var(--timber);margin-bottom:14px">This intro screen appears when a customer first scans a table QR. Edit the story, tagline and guide anytime — no code needed.</div>'
    + _sToggle('s_welcome_enabled', 'Welcome Screen Enabled', 'Show intro story before the menu', _settings.WELCOME_ENABLED !== 'false')
    + _sField('s_welcome_title', 'Title', _settings.WELCOME_TITLE, 'text', 'e.g. Welcome to YANI Garden Cafe')
    + '<div class="s-field"><label>Story <span style="font-size:.68rem;opacity:.6">(main paragraph)</span></label><textarea id="s_welcome_story" rows="4" style="width:100%;padding:8px 10px;border:1.5px solid var(--mist);border-radius:8px;font-size:.82rem;font-family:var(--font-body);resize:vertical">' + (_settings.WELCOME_STORY||'') + '</textarea></div>'
    + _sField('s_welcome_tagline', 'Tagline', _settings.WELCOME_TAGLINE, 'text', 'e.g. Thank you for being here today. 🌿')
    + '<div class="s-field"><label>Guide Text <span style="font-size:.68rem;opacity:.6">(how to order tip)</span></label><textarea id="s_welcome_guide" rows="2" style="width:100%;padding:8px 10px;border:1.5px solid var(--mist);border-radius:8px;font-size:.82rem;font-family:var(--font-body);resize:vertical">' + (_settings.WELCOME_GUIDE||'') + '</textarea></div>'
    + _sField('s_welcome_button', 'Button Text', _settings.WELCOME_BUTTON, 'text', 'e.g. See Our Menu →')
    + '<div class="s-field"><label>Auto-advance <span style="font-size:.68rem;opacity:.6">(seconds, 0 = wait for tap)</span></label><input type="number" id="s_welcome_auto" value="' + (_settings.WELCOME_AUTO_SECONDS||'0') + '" min="0" max="30" style="width:80px;padding:8px;border:1.5px solid var(--mist);border-radius:8px;font-size:.95rem;font-weight:700;text-align:center"> <span style="font-size:.75rem;color:var(--timber)">0 = customer taps the button</span></div>'
    + '</div>'
    + '<button class="s-save-btn" onclick="saveBrandingSettings(this)">💾 Save Branding</button>';
}

function _settingsOperations() {
  var s = _settings;
  var svcPct = Math.round(parseFloat(s.SERVICE_CHARGE||'0.10') * 100);
  var vatEnabled = s.VAT_ENABLED === 'true';
  var vatRate = Math.round(parseFloat(s.VAT_RATE||'0.12') * 100);
  return '<div class="s-card"><div class="s-card-title">📲 Ordering</div>'
    + _sToggle('s_online_ordering', 'Online Ordering Enabled', 'Customers can browse menu and place orders', s.ONLINE_ORDERING_ENABLED !== 'false')
    + _sToggle('s_require_name', 'Require Customer Name', 'Customer must enter their name when ordering', s.REQUIRE_CUSTOMER_NAME !== 'false')
    + _sToggle('s_require_phone', 'Require Phone Number', 'Collect customer phone for notifications', s.REQUIRE_PHONE_NUMBER === 'true')
    + '</div>'
    + '<div class="s-card"><div class="s-card-title">💰 Tax & Discounts</div>'
    + _sToggle('s_vat_enabled', 'VAT Enabled (12%)', vatEnabled ? 'Currently: VAT Registered (12%)' : 'Currently: Non-VAT Registered', vatEnabled)
    + _sToggle('s_pwd_senior', 'PWD / Senior Citizen Discount', '20% discount (RA 9994 / RA 7277) — staff verifies ID', s.PWD_SENIOR_ENABLED !== 'false')
    + '<div style="padding:10px 0;border-bottom:1px solid var(--mist-light)">'
    + '<div class="s-toggle-label">Service Charge</div><div class="s-toggle-sub">Added to dine-in orders (not applied on PWD/Senior)</div>'
    + '<div style="display:flex;align-items:center;gap:8px;margin-top:8px"><input type="number" id="s_service_charge" value="' + svcPct + '" min="0" max="30" style="width:70px;padding:8px;border:1.5px solid var(--mist);border-radius:8px;font-size:.95rem;font-weight:700;text-align:center"><span style="font-weight:600">%</span></div>'
    + '</div>'
    + '<div style="padding:10px 0">'
    + '<div class="s-toggle-label">Avg Prep Time</div><div class="s-toggle-sub">Used for order tracking ETA</div>'
    + '<div style="display:flex;align-items:center;gap:8px;margin-top:8px"><input type="number" id="s_avg_prep" value="' + (s.AVG_PREP_TIME||'10') + '" min="1" max="120" style="width:70px;padding:8px;border:1.5px solid var(--mist);border-radius:8px;font-size:.95rem;font-weight:700;text-align:center"><span style="font-weight:600">minutes</span></div>'
    + '</div></div>'
    // VAT Receipt Preview
    + '<div class="s-card"><div class="s-card-title">🧾 Receipt Preview (Sample Order ₱526.90)</div>'
    + '<div style="font-family:monospace;font-size:.78rem;line-height:1.9;color:#333;background:#f9f9f9;border-radius:8px;padding:12px">'
    + 'Subtotal:        ₱479.00<br>'
    + 'Service Charge:  ₱ 47.90<br>'
    + (vatEnabled ? '<span style="color:var(--forest);font-weight:700">VAT (12%, incl.):  ₱ ' + (526.90 * 0.12 / 1.12).toFixed(2) + '</span><br>' : '')
    + '──────────────────────<br>'
    + '<strong>TOTAL:           ₱526.90</strong><br><br>'
    + '<span style="color:#888">' + (vatEnabled ? '✅ VAT Registered' : 'Non-VAT Registered') + '</span>'
    + '</div></div>'
    + '<button class="s-save-btn" onclick="saveOperationsSettings(this)">💾 Save Operations</button>';
}

async function saveGeneralSettings(btn) {
  var fields = {
    BUSINESS_NAME: document.getElementById('s_business_name').value,
    TAGLINE: document.getElementById('s_tagline').value,
    ACCOUNT_NAME: document.getElementById('s_account_name').value,
    ADDRESS: document.getElementById('s_address').value,
    ADMIN_PHONE: document.getElementById('s_admin_phone').value,
    RECEIPT_EMAIL: document.getElementById('s_receipt_email').value,
    ORDER_PREFIX: document.getElementById('s_order_prefix').value,
    OR_NUMBER_START: document.getElementById('s_or_start').value,
    RECEIPT_FOOTER: document.getElementById('s_receipt_footer').value,
  };
  await _saveSettingsMap(fields, 'General settings saved ✅', btn);
}

async function savePaymentSettings(btn) {
  var fields = {
    GCASH_QR_URL: document.getElementById('s_gcash_qr_url').value,
    GCASH_NUMBER: document.getElementById('s_gcash_number').value,
    INSTAPAY_QR_URL: document.getElementById('s_instapay_qr_url').value,
    BDO_QR_URL: document.getElementById('s_bdo_qr_url').value,
    BDO_ACCOUNT: document.getElementById('s_bdo_account').value,
    BPI_QR_URL: document.getElementById('s_bpi_qr_url').value,
    BPI_ACCOUNT: document.getElementById('s_bpi_account').value,
    UNIONBANK_QR_URL: document.getElementById('s_unionbank_qr_url').value,
    UNIONBANK_ACCOUNT: document.getElementById('s_unionbank_account').value,
  };
  await _saveSettingsMap(fields, 'Payment settings saved ✅', btn);
}

async function saveBrandingSettings(btn) {
  var fields = {
    PRIMARY_COLOR: document.getElementById('s_primary_color').value,
    SECONDARY_COLOR: document.getElementById('s_secondary_color').value,
    LOGO_URL: document.getElementById('s_logo_url').value,
    WELCOME_ENABLED:      String(document.getElementById('s_welcome_enabled').checked),
    WELCOME_TITLE:        document.getElementById('s_welcome_title').value,
    WELCOME_STORY:        document.getElementById('s_welcome_story').value,
    WELCOME_TAGLINE:      document.getElementById('s_welcome_tagline').value,
    WELCOME_GUIDE:        document.getElementById('s_welcome_guide').value,
    WELCOME_BUTTON:       document.getElementById('s_welcome_button').value,
    WELCOME_AUTO_SECONDS: document.getElementById('s_welcome_auto').value,
  };
  await _saveSettingsMap(fields, 'Branding saved ✅', btn);
}

async function saveOperationsSettings(btn) {
  var svc = parseFloat(document.getElementById('s_service_charge').value) / 100;
  var fields = {
    ONLINE_ORDERING_ENABLED: String(document.getElementById('s_online_ordering').checked),
    REQUIRE_CUSTOMER_NAME: String(document.getElementById('s_require_name').checked),
    REQUIRE_PHONE_NUMBER: String(document.getElementById('s_require_phone').checked),
    VAT_ENABLED: String(document.getElementById('s_vat_enabled').checked),
    PWD_SENIOR_ENABLED: String(document.getElementById('s_pwd_senior').checked),
    SERVICE_CHARGE: String(isNaN(svc) ? 0.10 : svc),
    AVG_PREP_TIME: document.getElementById('s_avg_prep').value,
  };
  await _saveSettingsMap(fields, 'Operations settings saved ✅', btn);
}

async function _saveSettingsMap(fields, successMsg, btnEl) {
  if (btnEl) { btnEl.disabled = true; btnEl.textContent = 'Saving…'; }
  var errors = [];
  for (var key in fields) {
    var r = await api('updateSetting', { userId: currentUser.userId, key: key, value: fields[key] });
    if (!r.ok) errors.push(key);
    else _settings[key] = fields[key];
  }
  if (btnEl) { btnEl.disabled = false; btnEl.textContent = '💾 Save'; }
  if (errors.length) showToast('Failed to save: ' + errors.join(', '), 'error');
  else showToast(successMsg, 'success');
}


// TABLES & RESERVATIONS
// ══════════════════════════════════════════════════════════
// PROMO CODES
// ══════════════════════════════════════════════════════════
var _promoCodes = [];

async function loadPromoCodesView() {
  var el = document.getElementById('promoCodesView');
  if (!el) return;
  el.innerHTML = '<div style="padding:20px;color:var(--timber)">Loading promo codes...</div>';
  var r = await api('getPromoCodes', { userId: currentUser && currentUser.userId });
  if (!r.ok) {
    el.innerHTML = '<div style="padding:20px;color:#EF4444">❌ ' + (r.error || 'Failed to load') + '</div>';
    return;
  }
  _promoCodes = r.codes || [];
  renderPromoCodesView();
}

function renderPromoCodesView() {
  var el = document.getElementById('promoCodesView');
  if (!el) return;

  var html = '<div style="padding:16px 16px 0;max-width:760px">';
  // Header
  html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">';
  html += '<div>';
  html += '<div style="font-weight:800;font-size:1.1rem;color:var(--forest-deep)">🏷️ Promo Codes</div>';
  html += '<div style="font-size:.78rem;color:var(--timber);margin-top:2px">Discount codes for customer orders</div>';
  html += '</div>';
  html += '<button onclick="openPromoModal()" style="padding:10px 18px;background:var(--forest);color:#fff;border:none;border-radius:10px;font-size:.85rem;font-weight:700;cursor:pointer;font-family:var(--font-body)">+ New Code</button>';
  html += '</div>';

  if (_promoCodes.length === 0) {
    html += '<div style="background:#fff;border-radius:14px;padding:40px;text-align:center;color:var(--timber);box-shadow:var(--shadow-sm)">';
    html += '<div style="font-size:2rem;margin-bottom:8px">🏷️</div>';
    html += '<div style="font-weight:700">No promo codes yet</div>';
    html += '<div style="font-size:.8rem;margin-top:4px">Create your first discount code</div></div>';
  } else {
    _promoCodes.forEach(function(pc) {
      var isActive = pc.is_active;
      var isExpired = pc.valid_until && new Date(pc.valid_until) < new Date();
      var badgeColor = isExpired ? '#94a3b8' : isActive ? '#059669' : '#94a3b8';
      var badgeBg = isExpired ? '#f1f5f9' : isActive ? '#d1fae5' : '#f1f5f9';
      var badgeText = isExpired ? 'Expired' : isActive ? 'Active' : 'Inactive';
      var discLabel = pc.discount_type === 'PERCENT'
        ? pc.discount_value + '% off'
        : '₱' + parseFloat(pc.discount_value).toFixed(0) + ' off';

      html += '<div style="background:#fff;border-radius:14px;box-shadow:var(--shadow-sm);padding:16px 18px;margin-bottom:10px;display:flex;align-items:center;gap:14px">';
      // Code + badge
      html += '<div style="flex:1;min-width:0">';
      html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">';
      html += '<span style="font-weight:800;font-size:.95rem;color:var(--forest-deep);font-family:monospace;letter-spacing:.5px">' + esc(pc.code) + '</span>';
      html += '<span style="font-size:.68rem;font-weight:700;padding:2px 8px;border-radius:8px;background:' + badgeBg + ';color:' + badgeColor + '">' + badgeText + '</span>';
      html += '</div>';
      html += '<div style="font-size:.82rem;font-weight:700;color:var(--terra)">' + discLabel + '</div>';
      if (pc.description) html += '<div style="font-size:.75rem;color:var(--timber);margin-top:2px">' + esc(pc.description) + '</div>';
      html += '<div style="display:flex;gap:12px;margin-top:6px;font-size:.72rem;color:var(--timber)">';
      html += '<span>Used: <b>' + (pc.used_count || 0) + '</b>' + (pc.max_uses ? ' / ' + pc.max_uses : '') + '</span>';
      if (pc.valid_until) html += '<span>Expires: <b>' + new Date(pc.valid_until).toLocaleDateString('en-PH') + '</b></span>';
      if (pc.valid_from) html += '<span>From: <b>' + new Date(pc.valid_from).toLocaleDateString('en-PH') + '</b></span>';
      html += '</div></div>';
      // Actions
      html += '<div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0">';
      html += '<button onclick="togglePromoActive(\'' + pc.id + '\',' + !isActive + ')" style="padding:6px 12px;background:' + (isActive ? '#FEF3C7' : '#D1FAE5') + ';color:' + (isActive ? '#92400E' : '#065F46') + ';border:none;border-radius:8px;font-size:.72rem;font-weight:700;cursor:pointer">' + (isActive ? 'Deactivate' : 'Activate') + '</button>';
      html += '<button onclick="deletePromoCode(\'' + pc.id + '\',\'' + esc(pc.code) + '\')" style="padding:6px 12px;background:#FEE2E2;color:#991B1B;border:none;border-radius:8px;font-size:.72rem;font-weight:700;cursor:pointer">Delete</button>';
      html += '</div></div>';
    });
  }
  html += '</div>';
  el.innerHTML = html;

  // Also render the create modal (hidden)
  if (!document.getElementById('promoModal')) {
    var modal = document.createElement('div');
    modal.id = 'promoModal';
    modal.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:800;align-items:center;justify-content:center;padding:20px';
    modal.innerHTML = '<div style="background:#fff;border-radius:16px;width:100%;max-width:440px;padding:24px;box-shadow:0 20px 60px rgba(0,0,0,.2)">'
      + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px">'
      + '<div style="font-weight:800;font-size:1rem;color:var(--forest-deep)">🏷️ New Promo Code</div>'
      + '<button onclick="closePromoModal()" style="background:none;border:none;font-size:1.4rem;cursor:pointer;color:var(--timber)">&times;</button>'
      + '</div>'
      + '<div class="s-field"><label>Code <span style="color:#e04444">*</span></label><input id="pm_code" type="text" placeholder="e.g. SAVE10" style="text-transform:uppercase" oninput="this.value=this.value.toUpperCase()"></div>'
      + '<div class="s-field"><label>Description</label><input id="pm_desc" type="text" placeholder="e.g. 10% off all orders"></div>'
      + '<div class="s-field"><label>Discount Type <span style="color:#e04444">*</span></label>'
      + '<select id="pm_type"><option value="PERCENT">Percent (%)</option><option value="FIXED">Fixed Amount (₱)</option></select></div>'
      + '<div class="s-field"><label>Discount Value <span style="color:#e04444">*</span></label><input id="pm_val" type="number" min="1" placeholder="e.g. 10"></div>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">'
      + '<div class="s-field"><label>Valid From</label><input id="pm_from" type="date"></div>'
      + '<div class="s-field"><label>Valid Until</label><input id="pm_until" type="date"></div>'
      + '</div>'
      + '<div class="s-field"><label>Max Uses <span style="font-size:.7rem;color:var(--timber);font-weight:400">(leave blank = unlimited)</span></label><input id="pm_max" type="number" min="1" placeholder="Unlimited"></div>'
      + '<button id="pm_save_btn" onclick="savePromoCode()" style="width:100%;padding:12px;background:var(--forest);color:#fff;border:none;border-radius:10px;font-size:.9rem;font-weight:700;cursor:pointer;font-family:var(--font-body);margin-top:4px">✅ Create Promo Code</button>'
      + '</div>';
    document.body.appendChild(modal);
  }
}

function openPromoModal() {
  var m = document.getElementById('promoModal');
  if (m) { m.style.display = 'flex'; document.getElementById('pm_code').focus(); }
}

function closePromoModal() {
  var m = document.getElementById('promoModal');
  if (m) m.style.display = 'none';
  ['pm_code','pm_desc','pm_val','pm_from','pm_until','pm_max'].forEach(function(id) {
    var el = document.getElementById(id); if (el) el.value = '';
  });
  var t = document.getElementById('pm_type'); if (t) t.value = 'PERCENT';
}

async function savePromoCode() {
  var code = (document.getElementById('pm_code').value || '').trim().toUpperCase();
  var desc = (document.getElementById('pm_desc').value || '').trim();
  var type = document.getElementById('pm_type').value;
  var val  = parseFloat(document.getElementById('pm_val').value);
  var from = document.getElementById('pm_from').value || null;
  var until= document.getElementById('pm_until').value || null;
  var max  = document.getElementById('pm_max').value || null;

  if (!code) { showToast('Enter a promo code', 'error'); return; }
  if (!val || val <= 0) { showToast('Enter a discount value', 'error'); return; }
  if (type === 'PERCENT' && val > 100) { showToast('Percent discount cannot exceed 100%', 'error'); return; }

  var btn = document.getElementById('pm_save_btn');
  btn.disabled = true; btn.textContent = 'Saving...';

  var r = await api('createPromoCode', {
    userId: currentUser && currentUser.userId,
    code: code, discount_type: type, discount_value: val,
    description: desc || null,
    valid_from: from ? from + 'T00:00:00+08:00' : null,
    valid_until: until ? until + 'T23:59:59+08:00' : null,
    max_uses: max ? parseInt(max) : null
  });

  btn.disabled = false; btn.textContent = '✅ Create Promo Code';

  if (r.ok) {
    showToast('✅ Promo code ' + code + ' created!');
    closePromoModal();
    loadPromoCodesView();
  } else {
    showToast('❌ ' + (r.error || 'Failed to create'), 'error');
  }
}

async function togglePromoActive(id, newActive) {
  var r = await api('updatePromoCode', { userId: currentUser && currentUser.userId, id: id, is_active: newActive });
  if (r.ok) {
    showToast(newActive ? '✅ Activated' : '⏸️ Deactivated');
    loadPromoCodesView();
  } else {
    showToast('❌ Failed to update', 'error');
  }
}

async function deletePromoCode(id, code) {
  if (!confirm('Delete promo code ' + code + '? This cannot be undone.')) return;
  var r = await api('deletePromoCode', { userId: currentUser && currentUser.userId, id: id });
  if (r.ok) {
    showToast('🗑️ ' + code + ' deleted');
    loadPromoCodesView();
  } else {
    showToast('❌ Failed to delete', 'error');
  }
}

// ══════════════════════════════════════════════════════════
// CUSTOMER DATABASE
// ══════════════════════════════════════════════════════════
var _customers = [];
var _custSearch = '';

async function loadCustomersView() {
  var el = document.getElementById('customersView');
  if (!el) return;
  el.innerHTML = '<div style="padding:20px;color:var(--timber)">Loading customers...</div>';
  var r = await api('getCustomers', { userId: currentUser && currentUser.userId, search: _custSearch, limit: 100 });
  if (!r.ok) { el.innerHTML = '<div style="padding:20px;color:#EF4444">❌ ' + (r.error||'Failed') + '</div>'; return; }
  _customers = r.customers || [];
  renderCustomersView();
}

function renderCustomersView() {
  var el = document.getElementById('customersView');
  if (!el) return;

  var html = '<div style="padding:16px;max-width:820px">';
  // Header
  html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:10px">';
  html += '<div><div style="font-weight:800;font-size:1.1rem;color:var(--forest-deep)">👥 Customer Database</div>';
  html += '<div style="font-size:.78rem;color:var(--timber);margin-top:2px">' + _customers.length + ' customers</div></div>';
  html += '<button onclick="openAddCustomerModal()" style="padding:9px 16px;background:var(--forest);color:#fff;border:none;border-radius:10px;font-size:.82rem;font-weight:700;cursor:pointer;font-family:var(--font-body)">+ Add Customer</button>';
  html += '</div>';

  // Search
  html += '<div style="position:relative;margin-bottom:14px">';
  html += '<input id="custSearchInput" type="text" placeholder="🔍 Search by name or phone..." value="' + esc(_custSearch) + '" '
    + 'oninput="_custSearch=this.value;renderCustomersFiltered()" '
    + 'style="width:100%;padding:9px 14px;border:1.5px solid var(--mist);border-radius:10px;font-size:.85rem;box-sizing:border-box;font-family:var(--font-body)">';
  html += '</div>';

  // Table
  if (_customers.length === 0) {
    html += '<div style="background:#fff;border-radius:14px;padding:40px;text-align:center;color:var(--timber);box-shadow:var(--shadow-sm)">';
    html += '<div style="font-size:2rem;margin-bottom:8px">👥</div>';
    html += '<div style="font-weight:700">No customers yet</div>';
    html += '<div style="font-size:.8rem;margin-top:4px">Customers appear here when added manually or after orders</div>';
    html += '</div>';
  } else {
    html += '<div id="custListContainer">';
    html += renderCustomerRows(_customers);
    html += '</div>';
  }
  html += '</div>';
  el.innerHTML = html;

  // Customer detail modal
  if (!document.getElementById('custModal')) {
    var m = document.createElement('div');
    m.id = 'custModal';
    m.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:800;align-items:center;justify-content:center;padding:16px';
    m.innerHTML = '<div style="background:#fff;border-radius:16px;width:100%;max-width:480px;max-height:90vh;overflow-y:auto;padding:22px;box-shadow:0 20px 60px rgba(0,0,0,.2)">'
      + '<div id="custModalBody"></div>'
      + '</div>';
    document.body.appendChild(m);
  }

  // Add customer modal
  if (!document.getElementById('addCustModal')) {
    var m2 = document.createElement('div');
    m2.id = 'addCustModal';
    m2.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:800;align-items:center;justify-content:center;padding:16px';
    m2.innerHTML = '<div style="background:#fff;border-radius:16px;width:100%;max-width:420px;padding:22px;box-shadow:0 20px 60px rgba(0,0,0,.2)">'
      + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">'
      + '<div style="font-weight:800;font-size:1rem;color:var(--forest-deep)">👤 Add Customer</div>'
      + '<button onclick="closeAddCustomerModal()" style="background:none;border:none;font-size:1.4rem;cursor:pointer;color:var(--timber)">&times;</button>'
      + '</div>'
      + '<div class="s-field"><label>Full Name <span style="color:#e04444">*</span></label><input id="ac_name" type="text" placeholder="e.g. Maria Santos"></div>'
      + '<div class="s-field"><label>Phone</label><input id="ac_phone" type="tel" placeholder="e.g. 09171234567"></div>'
      + '<div class="s-field"><label>Email</label><input id="ac_email" type="email" placeholder="e.g. maria@email.com"></div>'
      + '<div class="s-field"><label>Notes</label><textarea id="ac_notes" rows="2" placeholder="Birthday, preferences, etc." style="width:100%;padding:8px 10px;border:1.5px solid var(--mist);border-radius:8px;font-size:.85rem;box-sizing:border-box;font-family:var(--font-body);resize:vertical"></textarea></div>'
      + '<button id="ac_save_btn" onclick="saveNewCustomer()" style="width:100%;padding:12px;background:var(--forest);color:#fff;border:none;border-radius:10px;font-size:.9rem;font-weight:700;cursor:pointer;font-family:var(--font-body);margin-top:4px">✅ Save Customer</button>'
      + '</div>';
    document.body.appendChild(m2);
  }
}

function renderCustomerRows(list) {
  if (!list.length) return '<div style="padding:20px;text-align:center;color:var(--timber);font-size:.85rem">No customers match</div>';
  return list.map(function(c) {
    var initials = (c.name||'?').split(' ').map(function(w){return w[0];}).slice(0,2).join('').toUpperCase();
    var totalSpent = parseFloat(c.total_spent||0);
    var lastVisit = c.last_visit ? new Date(c.last_visit).toLocaleDateString('en-PH',{month:'short',day:'numeric',year:'numeric'}) : '—';
    return '<div onclick="openCustomerDetail(\'' + c.id + '\')" style="background:#fff;border-radius:12px;box-shadow:var(--shadow-sm);padding:14px 16px;margin-bottom:8px;display:flex;align-items:center;gap:14px;cursor:pointer;transition:box-shadow .15s" onmouseover="this.style.boxShadow=\'0 4px 16px rgba(0,0,0,.1)\'" onmouseout="this.style.boxShadow=\'var(--shadow-sm)\'">'
      + '<div style="width:42px;height:42px;border-radius:50%;background:var(--forest);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:.9rem;color:#fff;flex-shrink:0">' + esc(initials) + '</div>'
      + '<div style="flex:1;min-width:0">'
      + '<div style="font-weight:700;font-size:.9rem;color:var(--forest-deep)">' + esc(c.name||'Unknown') + '</div>'
      + '<div style="font-size:.75rem;color:var(--timber);margin-top:2px">' + (c.phone ? '📞 ' + esc(c.phone) : '') + (c.email ? (c.phone?' · ':'') + '✉️ ' + esc(c.email) : '') + '</div>'
      + '</div>'
      + '<div style="text-align:right;flex-shrink:0">'
      + '<div style="font-weight:700;font-size:.82rem;color:var(--terra)">₱' + totalSpent.toLocaleString('en-PH',{minimumFractionDigits:0}) + '</div>'
      + '<div style="font-size:.68rem;color:var(--timber)">' + (c.total_orders||0) + ' order' + ((c.total_orders||0)===1?'':'s') + '</div>'
      + '<div style="font-size:.65rem;color:var(--timber);margin-top:1px">Last: ' + lastVisit + '</div>'
      + '</div>'
      + '</div>';
  }).join('');
}

function renderCustomersFiltered() {
  var q = (_custSearch||'').toLowerCase().trim();
  var filtered = q ? _customers.filter(function(c) {
    return (c.name||'').toLowerCase().includes(q) || (c.phone||'').includes(q) || (c.email||'').toLowerCase().includes(q);
  }) : _customers;
  var container = document.getElementById('custListContainer');
  if (container) container.innerHTML = renderCustomerRows(filtered);
}

async function openCustomerDetail(id) {
  var m = document.getElementById('custModal');
  var body = document.getElementById('custModalBody');
  if (!m || !body) return;
  body.innerHTML = '<div style="padding:10px;text-align:center;color:var(--timber)">Loading...</div>';
  m.style.display = 'flex';

  var r = await api('getCustomer', { userId: currentUser && currentUser.userId, id: id });
  if (!r.ok) { body.innerHTML = '<div style="color:#EF4444">Failed to load customer</div>'; return; }
  var c = r.customer || {};
  var orders = r.orders || [];

  var totalSpent = parseFloat(c.total_spent||0);
  var firstVisit = c.first_visit ? new Date(c.first_visit).toLocaleDateString('en-PH',{month:'long',day:'numeric',year:'numeric'}) : '—';
  var lastVisit  = c.last_visit  ? new Date(c.last_visit).toLocaleDateString('en-PH',{month:'long',day:'numeric',year:'numeric'}) : '—';

  body.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px">'
    + '<div style="font-weight:800;font-size:1.05rem;color:var(--forest-deep)">👤 ' + esc(c.name||'') + '</div>'
    + '<button onclick="document.getElementById(\'custModal\').style.display=\'none\'" style="background:none;border:none;font-size:1.4rem;cursor:pointer;color:var(--timber)">&times;</button>'
    + '</div>'
    // Stats row
    + '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:16px">'
    + _cStatBox('Total Spent', '₱' + totalSpent.toLocaleString('en-PH',{minimumFractionDigits:0}))
    + _cStatBox('Orders', String(c.total_orders||0))
    + _cStatBox('Avg Order', c.total_orders ? '₱' + Math.round(totalSpent/(c.total_orders||1)).toLocaleString('en-PH') : '—')
    + '</div>'
    // Info
    + '<div style="background:#f8fafc;border-radius:10px;padding:12px 14px;margin-bottom:14px;font-size:.82rem;display:flex;flex-direction:column;gap:5px">'
    + (c.phone ? '<div>📞 ' + esc(c.phone) + '</div>' : '')
    + (c.email ? '<div>✉️ ' + esc(c.email) + '</div>' : '')
    + '<div style="color:var(--timber)">🗓 First visit: ' + firstVisit + '</div>'
    + '<div style="color:var(--timber)">🕐 Last visit: ' + lastVisit + '</div>'
    + (c.notes ? '<div style="color:var(--timber)">📝 ' + esc(c.notes) + '</div>' : '')
    + '</div>'
    // Order history
    + '<div style="font-weight:700;font-size:.85rem;color:var(--forest-deep);margin-bottom:8px">Order History</div>'
    + (orders.length === 0
        ? '<div style="font-size:.8rem;color:var(--timber);text-align:center;padding:16px">No orders yet</div>'
        : orders.slice(0,10).map(function(o) {
            return '<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--mist);font-size:.8rem">'
              + '<div><span style="font-weight:700;color:var(--forest)">' + esc(o.order_id||o.orderId||'') + '</span>'
              + ' <span style="color:var(--timber)">' + (o.created_at ? new Date(o.created_at).toLocaleDateString('en-PH',{month:'short',day:'numeric'}) : '') + '</span></div>'
              + '<div style="font-weight:700">₱' + parseFloat(o.total||o.total_amount||0).toLocaleString('en-PH',{minimumFractionDigits:0}) + '</div>'
              + '</div>';
          }).join(''))
    + (orders.length > 10 ? '<div style="font-size:.72rem;color:var(--timber);margin-top:6px;text-align:center">Showing last 10 orders</div>' : '')
    // Edit button
    + '<button onclick="openEditCustomerModal(\'' + c.id + '\')" style="width:100%;margin-top:16px;padding:10px;background:var(--forest);color:#fff;border:none;border-radius:10px;font-size:.85rem;font-weight:700;cursor:pointer;font-family:var(--font-body)">✏️ Edit Customer</button>';
}

function _cStatBox(label, val) {
  return '<div style="background:#f0fdf4;border-radius:10px;padding:10px 8px;text-align:center">'
    + '<div style="font-weight:800;font-size:.95rem;color:var(--forest)">' + val + '</div>'
    + '<div style="font-size:.65rem;color:var(--timber);margin-top:2px">' + label + '</div>'
    + '</div>';
}

function openAddCustomerModal() {
  var m = document.getElementById('addCustModal');
  if (m) { m.style.display = 'flex'; document.getElementById('ac_name').focus(); }
}

function closeAddCustomerModal() {
  var m = document.getElementById('addCustModal');
  if (m) m.style.display = 'none';
  ['ac_name','ac_phone','ac_email','ac_notes'].forEach(function(id){
    var el = document.getElementById(id); if (el) el.value = '';
  });
}

async function saveNewCustomer() {
  var name  = (document.getElementById('ac_name').value||'').trim();
  var phone = (document.getElementById('ac_phone').value||'').trim();
  var email = (document.getElementById('ac_email').value||'').trim();
  var notes = (document.getElementById('ac_notes').value||'').trim();
  if (!name) { showToast('Please enter a name', 'error'); return; }

  var btn = document.getElementById('ac_save_btn');
  btn.disabled = true; btn.textContent = 'Saving...';

  var r = await api('upsertCustomer', { userId: currentUser && currentUser.userId, name, phone: phone||null, email: email||null, notes: notes||null });
  btn.disabled = false; btn.textContent = '✅ Save Customer';

  if (r.ok) {
    showToast('✅ Customer ' + (r.action==='created'?'added':'updated') + '!');
    closeAddCustomerModal();
    loadCustomersView();
  } else {
    showToast('❌ ' + (r.error||'Failed'), 'error');
  }
}

async function openEditCustomerModal(id) {
  var c = null;
  var r = await api('getCustomer', { userId: currentUser && currentUser.userId, id: id });
  if (!r.ok) return;
  c = r.customer;
  // Close detail modal
  var dm = document.getElementById('custModal');
  if (dm) dm.style.display = 'none';
  // Pre-fill add modal
  openAddCustomerModal();
  document.getElementById('ac_name').value  = c.name  || '';
  document.getElementById('ac_phone').value = c.phone || '';
  document.getElementById('ac_email').value = c.email || '';
  document.getElementById('ac_notes').value = c.notes || '';
  // Store ID for update
  var btn = document.getElementById('ac_save_btn');
  btn.onclick = async function() { await updateExistingCustomer(id); };
}

async function updateExistingCustomer(id) {
  var name  = (document.getElementById('ac_name').value||'').trim();
  var phone = (document.getElementById('ac_phone').value||'').trim();
  var email = (document.getElementById('ac_email').value||'').trim();
  var notes = (document.getElementById('ac_notes').value||'').trim();
  if (!name) { showToast('Please enter a name', 'error'); return; }

  var btn = document.getElementById('ac_save_btn');
  btn.disabled = true; btn.textContent = 'Saving...';

  var r = await api('upsertCustomer', { userId: currentUser && currentUser.userId, id, name, phone: phone||null, email: email||null, notes: notes||null });
  btn.disabled = false; btn.textContent = '✅ Save Customer';
  // Reset onclick back to default
  btn.onclick = saveNewCustomer;

  if (r.ok) {
    showToast('✅ Customer updated!');
    closeAddCustomerModal();
    loadCustomersView();
  } else {
    showToast('❌ ' + (r.error||'Failed'), 'error');
  }
}

// ══════════════════════════════════════════════════════════
// LOYALTY POINTS SYSTEM
// ══════════════════════════════════════════════════════════
var _loyaltyAccounts = [];
var _loyaltySearch   = '';
var _loyaltySettings = {};

async function loadLoyaltyView() {
  var el = document.getElementById('loyaltyView');
  if (!el) return;
  el.innerHTML = '<div style="padding:20px;color:var(--timber)">Loading loyalty data...</div>';

  var [r1, r2] = await Promise.all([
    api('getLoyaltyAccounts', { userId: currentUser && currentUser.userId, limit: 200 }),
    api('getLoyaltySettings')
  ]);

  _loyaltyAccounts = r1.accounts || [];
  _loyaltySettings = r2.settings || {};
  renderLoyaltyView();
}

function renderLoyaltyView() {
  var el = document.getElementById('loyaltyView');
  if (!el) return;

  var earnRate   = parseFloat(_loyaltySettings.LOYALTY_EARN_RATE || '1');
  var redeemRate = parseInt(_loyaltySettings.LOYALTY_REDEEM_RATE || '100');
  var minRedeem  = parseInt(_loyaltySettings.LOYALTY_MIN_REDEEM  || '500');
  var enabled    = _loyaltySettings.LOYALTY_ENABLED !== 'false';

  var tierColors = { BRONZE:'#CD7F32', SILVER:'#94a3b8', GOLD:'#F59E0B', PLATINUM:'#7C3AED' };
  var tierBg     = { BRONZE:'#FEF3E2', SILVER:'#F1F5F9', GOLD:'#FFFBEB', PLATINUM:'#F5F3FF' };

  // Stats
  var total   = _loyaltyAccounts.length;
  var bronze  = _loyaltyAccounts.filter(function(a){ return a.tier==='BRONZE'; }).length;
  var silver  = _loyaltyAccounts.filter(function(a){ return a.tier==='SILVER'; }).length;
  var gold    = _loyaltyAccounts.filter(function(a){ return a.tier==='GOLD'; }).length;
  var plat    = _loyaltyAccounts.filter(function(a){ return a.tier==='PLATINUM'; }).length;
  var totalPts = _loyaltyAccounts.reduce(function(s,a){ return s + (a.points_balance||0); }, 0);

  var html = '<div style="padding:16px;max-width:860px">';

  // Header
  html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:10px">';
  html += '<div><div style="font-weight:800;font-size:1.1rem;color:var(--forest-deep)">⭐ Loyalty Points</div>';
  html += '<div style="font-size:.78rem;color:var(--timber);margin-top:2px">' + total + ' members · ₱1 = ' + earnRate + ' pt · ' + redeemRate + ' pts = ₱1</div></div>';
  html += '<div style="display:flex;gap:8px">';
  html += '<button onclick="openLoyaltySettings()" style="padding:8px 14px;background:#f8f8f4;color:var(--forest-deep);border:1.5px solid var(--mist);border-radius:10px;font-size:.8rem;font-weight:700;cursor:pointer">⚙️ Settings</button>';
  html += '<button onclick="openAddLoyaltyModal()" style="padding:9px 16px;background:var(--forest);color:#fff;border:none;border-radius:10px;font-size:.82rem;font-weight:700;cursor:pointer;font-family:var(--font-body)">+ Enroll Member</button>';
  html += '</div></div>';

  // Stats row
  html += '<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:16px">';
  html += _lyStatCard('Total Members', total, '#1a3a2a');
  html += _lyStatCard('🥉 Bronze', bronze, '#CD7F32');
  html += _lyStatCard('🥈 Silver', silver, '#64748b');
  html += _lyStatCard('🥇 Gold', gold, '#D97706');
  html += _lyStatCard('💎 Platinum', plat, '#7C3AED');
  html += '</div>';

  // Search
  html += '<div style="position:relative;margin-bottom:14px">';
  html += '<input id="loyaltySearchInput" type="text" placeholder="🔍 Search by name or phone..." value="' + esc(_loyaltySearch) + '" '
    + 'oninput="_loyaltySearch=this.value;renderLoyaltyFiltered()" '
    + 'style="width:100%;padding:9px 14px;border:1.5px solid var(--mist);border-radius:10px;font-size:.85rem;box-sizing:border-box;font-family:var(--font-body)">';
  html += '</div>';

  // Members list
  if (_loyaltyAccounts.length === 0) {
    html += '<div style="background:#fff;border-radius:14px;padding:40px;text-align:center;color:var(--timber);box-shadow:var(--shadow-sm)">';
    html += '<div style="font-size:2rem;margin-bottom:8px">⭐</div>';
    html += '<div style="font-weight:700">No loyalty members yet</div>';
    html += '<div style="font-size:.8rem;margin-top:4px">Enroll your first customer to get started</div></div>';
  } else {
    html += '<div id="loyaltyListContainer">' + renderLoyaltyRows(_loyaltyAccounts) + '</div>';
  }

  html += '</div>';
  el.innerHTML = html;

  // Ensure modals exist
  _ensureLoyaltyModals();
}

function _lyStatCard(label, val, color) {
  return '<div style="background:#fff;border-radius:12px;box-shadow:var(--shadow-sm);padding:14px;text-align:center">'
    + '<div style="font-weight:800;font-size:1.2rem;color:' + color + '">' + val + '</div>'
    + '<div style="font-size:.68rem;color:var(--timber);margin-top:3px">' + label + '</div></div>';
}

function renderLoyaltyRows(list) {
  if (!list.length) return '<div style="padding:20px;text-align:center;color:var(--timber);font-size:.85rem">No members match</div>';
  var tierColors = { BRONZE:'#CD7F32', SILVER:'#64748b', GOLD:'#D97706', PLATINUM:'#7C3AED' };
  var tierIcons  = { BRONZE:'🥉', SILVER:'🥈', GOLD:'🥇', PLATINUM:'💎' };
  return list.map(function(a) {
    var tc = tierColors[a.tier] || '#CD7F32';
    var ti = tierIcons[a.tier]  || '🥉';
    var lastVisit = a.last_visit ? new Date(a.last_visit).toLocaleDateString('en-PH',{month:'short',day:'numeric',year:'numeric'}) : '—';
    return '<div onclick="openLoyaltyDetail(\'' + a.id + '\')" style="background:#fff;border-radius:12px;box-shadow:var(--shadow-sm);padding:14px 16px;margin-bottom:8px;display:flex;align-items:center;gap:14px;cursor:pointer">'
      + '<div style="width:42px;height:42px;border-radius:50%;background:' + tc + ';display:flex;align-items:center;justify-content:center;font-size:1.1rem;flex-shrink:0">' + ti + '</div>'
      + '<div style="flex:1;min-width:0">'
      + '<div style="font-weight:700;font-size:.9rem;color:var(--forest-deep)">' + esc(a.name) + '</div>'
      + '<div style="font-size:.75rem;color:var(--timber);margin-top:2px">📞 ' + esc(a.phone) + (a.email ? ' · ✉️ ' + esc(a.email) : '') + '</div>'
      + '</div>'
      + '<div style="text-align:right;flex-shrink:0">'
      + '<div style="font-weight:800;font-size:.95rem;color:' + tc + '">' + (a.points_balance||0).toLocaleString() + ' pts</div>'
      + '<div style="font-size:.68rem;color:var(--timber)">' + a.tier + ' · ' + (a.visit_count||0) + ' visits</div>'
      + '<div style="font-size:.65rem;color:var(--timber)">Last: ' + lastVisit + '</div>'
      + '</div></div>';
  }).join('');
}

function renderLoyaltyFiltered() {
  var q = (_loyaltySearch||'').toLowerCase().trim();
  var filtered = q ? _loyaltyAccounts.filter(function(a) {
    return (a.name||'').toLowerCase().includes(q) || (a.phone||'').includes(q);
  }) : _loyaltyAccounts;
  var c = document.getElementById('loyaltyListContainer');
  if (c) c.innerHTML = renderLoyaltyRows(filtered);
}

async function openLoyaltyDetail(id) {
  var m = document.getElementById('loyaltyDetailModal');
  var body = document.getElementById('loyaltyDetailBody');
  if (!m || !body) return;
  body.innerHTML = '<div style="padding:10px;text-align:center;color:var(--timber)">Loading...</div>';
  m.style.display = 'flex';

  var r = await api('getLoyaltyAccount', { userId: currentUser && currentUser.userId, id: id });
  if (!r.ok) { body.innerHTML = '<div style="color:#EF4444">Failed to load</div>'; return; }
  var a = r.account;
  var txs = r.transactions || [];
  var tierColors = { BRONZE:'#CD7F32', SILVER:'#64748b', GOLD:'#D97706', PLATINUM:'#7C3AED' };
  var tc = tierColors[a.tier] || '#CD7F32';
  var redeemRate = parseInt(_loyaltySettings.LOYALTY_REDEEM_RATE || '100');
  var minRedeem  = parseInt(_loyaltySettings.LOYALTY_MIN_REDEEM || '500');
  var redeemValue = Math.floor((a.points_balance||0) / redeemRate * 100) / 100;

  body.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px">'
    + '<div style="font-weight:800;font-size:1rem;color:var(--forest-deep)">⭐ ' + esc(a.name) + '</div>'
    + '<button onclick="document.getElementById(\'loyaltyDetailModal\').style.display=\'none\'" style="background:none;border:none;font-size:1.4rem;cursor:pointer;color:var(--timber)">&times;</button>'
    + '</div>'
    // Tier badge + points
    + '<div style="background:' + tc + ';color:#fff;border-radius:10px;padding:14px 16px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center">'
    + '<div><div style="font-size:.72rem;opacity:.85">' + a.tier + ' MEMBER</div><div style="font-size:1.8rem;font-weight:800">' + (a.points_balance||0).toLocaleString() + '<span style="font-size:.9rem;font-weight:400"> pts</span></div>'
    + '<div style="font-size:.72rem;opacity:.85;margin-top:2px">Worth ₱' + redeemValue.toFixed(2) + ' in discounts</div></div>'
    + '<div style="text-align:right;font-size:.72rem;opacity:.85"><div>' + (a.visit_count||0) + ' visits</div><div>₱' + parseFloat(a.total_spent||0).toLocaleString() + ' spent</div></div>'
    + '</div>'
    // Info
    + '<div style="background:#f8fafc;border-radius:10px;padding:10px 14px;margin-bottom:14px;font-size:.8rem;display:flex;flex-direction:column;gap:4px">'
    + '<div>📞 ' + esc(a.phone) + '</div>'
    + (a.email ? '<div>✉️ ' + esc(a.email) + '</div>' : '')
    + '<div style="color:var(--timber)">Total earned: ' + (a.total_points_earned||0).toLocaleString() + ' pts</div>'
    + '<div style="color:var(--timber)">Total redeemed: ' + (a.total_points_redeemed||0).toLocaleString() + ' pts</div>'
    + '</div>'
    // Action buttons
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px">'
    + '<button onclick="openEarnPointsModal(\'' + a.id + '\')" style="padding:10px;background:#D1FAE5;color:#065F46;border:none;border-radius:10px;font-size:.8rem;font-weight:700;cursor:pointer">➕ Add Points</button>'
    + (a.points_balance >= minRedeem
        ? '<button onclick="openRedeemModal(\'' + a.id + '\',' + a.points_balance + ')" style="padding:10px;background:#FEF3C7;color:#92400E;border:none;border-radius:10px;font-size:.8rem;font-weight:700;cursor:pointer">💰 Redeem Points</button>'
        : '<div style="padding:10px;background:#f3f4f6;color:#9ca3af;border-radius:10px;font-size:.75rem;text-align:center">Need ' + minRedeem + ' pts to redeem</div>')
    + '</div>'
    // Transaction history
    + '<div style="font-weight:700;font-size:.83rem;color:var(--forest-deep);margin-bottom:8px">Transaction History</div>'
    + (txs.length === 0
        ? '<div style="font-size:.8rem;color:var(--timber);text-align:center;padding:12px">No transactions yet</div>'
        : txs.slice(0,15).map(function(tx) {
            var isEarn = tx.type === 'EARN';
            var isRedeem = tx.type === 'REDEEM';
            var col = isEarn ? '#059669' : isRedeem ? '#DC2626' : '#6b7280';
            var sign = isEarn ? '+' : '';
            return '<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--mist);font-size:.78rem">'
              + '<div><div style="font-weight:600;color:' + col + '">' + tx.type + '</div>'
              + '<div style="color:var(--timber);font-size:.7rem">' + esc(tx.description||'') + '</div>'
              + '<div style="color:var(--timber);font-size:.65rem">' + new Date(tx.created_at).toLocaleDateString('en-PH',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) + '</div></div>'
              + '<div style="text-align:right"><div style="font-weight:700;color:' + col + '">' + sign + tx.points + ' pts</div>'
              + '<div style="font-size:.65rem;color:var(--timber)">Bal: ' + tx.balance_after + '</div></div>'
              + '</div>';
          }).join(''));
}

function openAddLoyaltyModal() {
  var m = document.getElementById('addLoyaltyModal');
  if (m) { m.style.display = 'flex'; document.getElementById('ly_name').focus(); }
}

function closeAddLoyaltyModal() {
  var m = document.getElementById('addLoyaltyModal');
  if (m) m.style.display = 'none';
  ['ly_name','ly_phone','ly_email'].forEach(function(id){ var el=document.getElementById(id); if(el) el.value=''; });
}

async function saveNewLoyaltyMember() {
  var name  = (document.getElementById('ly_name').value||'').trim();
  var phone = (document.getElementById('ly_phone').value||'').trim();
  var email = (document.getElementById('ly_email').value||'').trim();
  if (!name)  { showToast('Enter member name', 'error'); return; }
  if (!phone) { showToast('Enter phone number', 'error'); return; }

  var btn = document.getElementById('ly_save_btn');
  btn.disabled = true; btn.textContent = 'Saving...';

  var r = await api('createLoyaltyAccount', { userId: currentUser && currentUser.userId, name, phone, email: email||null });
  btn.disabled = false; btn.textContent = '✅ Enroll Member';

  if (r.ok) {
    showToast('✅ ' + name + ' enrolled!');
    closeAddLoyaltyModal();
    loadLoyaltyView();
  } else {
    showToast('❌ ' + (r.error||'Failed'), 'error');
  }
}

function openEarnPointsModal(accountId) {
  document.getElementById('loyaltyDetailModal').style.display = 'none';
  var pts = prompt('Add how many points? (Manual adjustment)');
  if (!pts || isNaN(parseInt(pts))) return;
  var reason = prompt('Reason (optional):') || 'Manual adjustment';
  api('adjustPoints', { userId: currentUser && currentUser.userId, accountId: accountId, points: parseInt(pts), reason: reason })
    .then(function(r) {
      if (r.ok) { showToast('✅ Points updated! New balance: ' + r.balanceAfter); loadLoyaltyView(); }
      else showToast('❌ ' + (r.error||'Failed'), 'error');
    });
}

function openRedeemModal(accountId, balance) {
  var redeemRate = parseInt(_loyaltySettings.LOYALTY_REDEEM_RATE || '100');
  var minRedeem  = parseInt(_loyaltySettings.LOYALTY_MIN_REDEEM || '500');
  var maxDiscount = Math.floor(balance / redeemRate * 100) / 100;
  var pts = prompt('Redeem how many points? (Balance: ' + balance + ' pts = ₱' + maxDiscount + ')\nMinimum: ' + minRedeem + ' pts');
  if (!pts || isNaN(parseInt(pts))) return;
  var toRedeem = parseInt(pts);
  if (toRedeem < minRedeem) { showToast('Minimum ' + minRedeem + ' points', 'error'); return; }
  if (toRedeem > balance) { showToast('Insufficient points', 'error'); return; }
  var orderId = prompt('Order ID to apply to (optional, e.g. YANI-1234):') || null;
  api('redeemPoints', { userId: currentUser && currentUser.userId, accountId: accountId, pointsToRedeem: toRedeem, orderId: orderId||null })
    .then(function(r) {
      if (r.ok) {
        showToast('✅ Redeemed ' + toRedeem + ' pts = ₱' + r.discountAmount + ' off');
        document.getElementById('loyaltyDetailModal').style.display = 'none';
        loadLoyaltyView();
      } else showToast('❌ ' + (r.error||'Failed'), 'error');
    });
}

function openLoyaltySettings() {
  var sett = _loyaltySettings;
  var html = '<div style="padding:16px;max-width:400px;margin:auto">'
    + '<div style="font-weight:800;font-size:.95rem;color:var(--forest-deep);margin-bottom:14px">⚙️ Loyalty Settings</div>'
    + '<div class="s-field"><label>Earn Rate (pts per ₱1 spent)</label><input id="ly_earn_rate" type="number" min="0.1" step="0.1" value="' + (sett.LOYALTY_EARN_RATE||'1') + '"></div>'
    + '<div class="s-field"><label>Redeem Rate (pts per ₱1 discount)</label><input id="ly_redeem_rate" type="number" min="1" value="' + (sett.LOYALTY_REDEEM_RATE||'100') + '"></div>'
    + '<div class="s-field"><label>Minimum Points to Redeem</label><input id="ly_min_redeem" type="number" min="100" value="' + (sett.LOYALTY_MIN_REDEEM||'500') + '"></div>'
    + '<div class="s-field"><label>Silver Tier Threshold (total pts earned)</label><input id="ly_silver" type="number" value="' + (sett.LOYALTY_SILVER_THRESHOLD||'5000') + '"></div>'
    + '<div class="s-field"><label>Gold Tier Threshold</label><input id="ly_gold" type="number" value="' + (sett.LOYALTY_GOLD_THRESHOLD||'15000') + '"></div>'
    + '<div class="s-field"><label>Platinum Tier Threshold</label><input id="ly_plat" type="number" value="' + (sett.LOYALTY_PLATINUM_THRESHOLD||'40000') + '"></div>'
    + '<button onclick="saveLoyaltySettings(this)" style="width:100%;padding:11px;background:var(--forest);color:#fff;border:none;border-radius:10px;font-size:.88rem;font-weight:700;cursor:pointer;font-family:var(--font-body);margin-top:4px">💾 Save Settings</button>'
    + '</div>';
  showModal('Loyalty Settings', html);
}

async function saveLoyaltySettings(btn) {
  btn.disabled = true; btn.textContent = 'Saving...';
  var keys = [
    ['LOYALTY_EARN_RATE', document.getElementById('ly_earn_rate').value],
    ['LOYALTY_REDEEM_RATE', document.getElementById('ly_redeem_rate').value],
    ['LOYALTY_MIN_REDEEM', document.getElementById('ly_min_redeem').value],
    ['LOYALTY_SILVER_THRESHOLD', document.getElementById('ly_silver').value],
    ['LOYALTY_GOLD_THRESHOLD', document.getElementById('ly_gold').value],
    ['LOYALTY_PLATINUM_THRESHOLD', document.getElementById('ly_plat').value],
  ];
  var promises = keys.map(function(kv) {
    return api('updateSetting', { userId: currentUser && currentUser.userId, key: kv[0], value: kv[1] });
  });
  await Promise.all(promises);
  btn.disabled = false; btn.textContent = '💾 Save Settings';
  showToast('✅ Loyalty settings saved');
  closeModal();
  loadLoyaltyView();
}

function _ensureLoyaltyModals() {
  // Detail modal
  if (!document.getElementById('loyaltyDetailModal')) {
    var m = document.createElement('div');
    m.id = 'loyaltyDetailModal';
    m.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:800;align-items:center;justify-content:center;padding:16px';
    m.innerHTML = '<div style="background:#fff;border-radius:16px;width:100%;max-width:460px;max-height:90vh;overflow-y:auto;padding:22px;box-shadow:0 20px 60px rgba(0,0,0,.2)">'
      + '<div id="loyaltyDetailBody"></div></div>';
    document.body.appendChild(m);
  }
  // Add member modal
  if (!document.getElementById('addLoyaltyModal')) {
    var m2 = document.createElement('div');
    m2.id = 'addLoyaltyModal';
    m2.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:800;align-items:center;justify-content:center;padding:16px';
    m2.innerHTML = '<div style="background:#fff;border-radius:16px;width:100%;max-width:400px;padding:22px;box-shadow:0 20px 60px rgba(0,0,0,.2)">'
      + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">'
      + '<div style="font-weight:800;font-size:1rem;color:var(--forest-deep)">⭐ Enroll New Member</div>'
      + '<button onclick="closeAddLoyaltyModal()" style="background:none;border:none;font-size:1.4rem;cursor:pointer;color:var(--timber)">&times;</button>'
      + '</div>'
      + '<div class="s-field"><label>Full Name <span style="color:#e04444">*</span></label><input id="ly_name" type="text" placeholder="e.g. Maria Santos"></div>'
      + '<div class="s-field"><label>Phone <span style="color:#e04444">*</span></label><input id="ly_phone" type="tel" placeholder="e.g. 09171234567"></div>'
      + '<div class="s-field"><label>Email (optional)</label><input id="ly_email" type="email" placeholder="e.g. maria@email.com"></div>'
      + '<button id="ly_save_btn" onclick="saveNewLoyaltyMember()" style="width:100%;padding:12px;background:var(--forest);color:#fff;border:none;border-radius:10px;font-size:.9rem;font-weight:700;cursor:pointer;font-family:var(--font-body);margin-top:4px">✅ Enroll Member</button>'
      + '</div>';
    document.body.appendChild(m2);
  }
}
