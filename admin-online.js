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
  document.getElementById('onlineOrdersGrid').innerHTML = filtered.map(function(o) {
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
    var html = '<div class="order-card" data-status="' + esc(o.status) + '" style="margin-bottom:12px">';
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
  }).join('');
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

async function loadSettings() {
  var r = await api('getSettings', { userId: currentUser.userId });
  if (!r.ok) { showToast('Failed to load settings', 'error'); return; }
  _settings = {};
  (r.settings || []).forEach(function(s) { _settings[s.key] = s.value; });

  var vatEnabled = _settings['VAT_ENABLED'] === 'true';
  var vatRate = parseFloat(_settings['VAT_RATE'] || '0.12') * 100;

  // Update toggle
  var toggle = document.getElementById('vatToggle');
  if (toggle) toggle.checked = vatEnabled;
  applyVatToggleUI(vatEnabled, vatRate);
}

function applyVatToggleUI(enabled, ratePct) {
  var slider = document.getElementById('vatSlider');
  var knob = document.getElementById('vatKnob');
  var rateRow = document.getElementById('vatRateRow');
  var statusNote = document.getElementById('vatStatusNote');
  var rateInput = document.getElementById('vatRateInput');

  if (slider) slider.style.background = enabled ? 'var(--forest)' : '#ccc';
  if (knob) knob.style.left = enabled ? '27px' : '3px';
  if (rateRow) rateRow.style.display = enabled ? 'block' : 'none';
  if (statusNote) {
    statusNote.textContent = enabled ? 'Currently: VAT Registered (12%)' : 'Currently: Non-VAT Registered';
    statusNote.style.color = enabled ? '#27ae60' : '#e67e22';
  }
  if (rateInput && ratePct) rateInput.value = ratePct;
  renderVatPreview(enabled, ratePct || 12);
}

function renderVatPreview(enabled, ratePct) {
  var box = document.getElementById('vatPreview');
  if (!box) return;
  var sample = 479, svc = 47.90, total = 526.90;
  var vatAmt = enabled ? (total * (ratePct / 100) / (1 + ratePct / 100)).toFixed(2) : null;
  box.innerHTML =
    '<div style="color:#888;font-size:.7rem;margin-bottom:4px">Receipt preview (sample order ₱526.90):</div>' +
    'Subtotal:        P 479.00<br>' +
    'Service Charge:  P  47.90<br>' +
    (enabled ? '<span style="color:var(--forest);font-weight:700">VAT ('+ratePct+'%, incl.): P  ' + vatAmt + '</span><br>' : '') +
    '──────────────────────<br>' +
    '<b>TOTAL:           P 526.90</b><br>' +
    '<br>' +
    '<span style="color:#888">' + (enabled ? 'VAT Registered' : 'Non-VAT Registered') + '</span>';
}

async function handleVatToggle(el) {
  var enabled = el.checked;
  var ratePct = parseFloat(document.getElementById('vatRateInput').value) || 12;
  applyVatToggleUI(enabled, ratePct);

  var r = await api('updateSetting', { userId: currentUser.userId, key: 'VAT_ENABLED', value: String(enabled) });
  if (!r.ok) {
    showToast('Failed to save VAT setting', 'error');
    el.checked = !enabled; // revert
    applyVatToggleUI(!enabled, ratePct);
    return;
  }
  showToast(enabled ? '✅ VAT enabled — receipts will show VAT breakdown' : '✅ VAT disabled — receipts show Non-VAT Registered', 'success');
  _settings['VAT_ENABLED'] = String(enabled);
}

async function handleVatRateChange(el) {
  var rate = parseFloat(el.value);
  if (isNaN(rate) || rate < 1 || rate > 30) { showToast('VAT rate must be 1–30%', 'error'); el.value = 12; return; }
  renderVatPreview(true, rate);
  var r = await api('updateSetting', { userId: currentUser.userId, key: 'VAT_RATE', value: (rate / 100).toFixed(4) });
  if (!r.ok) { showToast('Failed to save VAT rate', 'error'); return; }
  showToast('✅ VAT rate set to ' + rate + '%', 'success');
  _settings['VAT_RATE'] = (rate / 100).toFixed(4);
}

// TABLES & RESERVATIONS