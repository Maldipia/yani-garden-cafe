// ══════════════════════════════════════════════════════════
// RENDER ORDERS
// ══════════════════════════════════════════════════════════
function renderOrders() {
  var filtered = allOrders.filter(function(o) {
    if (currentFilter === 'ALL') return true;
    if (currentFilter === 'ACTIVE') return !o.isTest && (o.status === 'NEW' || o.status === 'PREPARING' || o.status === 'READY');
    if (currentFilter === 'PLATFORM') return !!o.platform;
    if (currentFilter === 'DELETED') return !!(o.isDeleted || o.status === 'DELETED');
    if (currentFilter === 'SCHEDULED') return o.isPreorder && o.status === 'SCHEDULED';
    // For status-based filters (NEW/PREPARING/READY/COMPLETED/CANCELLED), hide test orders
    if (['NEW','PREPARING','READY'].includes(currentFilter)) return !o.isTest && o.status === currentFilter;
    return o.status === currentFilter;
  });

  // Sort: SCHEDULED first (by pickup time), then NEW/PREPARING/READY, newest first within status
  var statusOrder = { SCHEDULED:-1, NEW:0, PREPARING:1, READY:2, COMPLETED:3, CANCELLED:4 };
  filtered.sort(function(a,b) {
    var sa = statusOrder[a.status] || 9, sb = statusOrder[b.status] || 9;
    if (sa !== sb) return sa - sb;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  if (filtered.length === 0) {
    document.getElementById('orderGrid').innerHTML =
      '<div class="empty-state"><div class="empty-icon">☕</div><div class="empty-text">No orders here yet</div></div>';
    return;
  }

  document.getElementById('orderGrid').innerHTML = filtered.map(function(o) {
    var cfg = STATUS_CONFIG[o.status] || STATUS_CONFIG.NEW;
    var time = '';
    try {
      var d = new Date(o.createdAt);
      time = d.toLocaleTimeString('en-PH', { hour:'numeric', minute:'2-digit', hour12:true, timeZone:'Asia/Manila' });
    } catch(e) {}

    var elapsed = '';
    try {
      var mins = Math.floor((Date.now() - new Date(o.createdAt).getTime()) / 60000);
      if (mins < 1) elapsed = 'just now';
      else if (mins < 60) elapsed = mins + 'm ago';
      else elapsed = Math.floor(mins/60) + 'h ' + (mins%60) + 'm ago';
    } catch(e) {}

    var html = '<div class="order-card" data-status="' + o.status + '"' + (o.platform ? ' data-platform="' + esc(o.platform) + '"' : '') + '>';

    // Header
    html += '<div class="oc-header">' +
      '<div class="oc-id">' + esc(o.orderId) + '</div>';
    
    // Platform badge (if platform order)
    if (o.platform) {
      var platClass = o.platform === 'GRAB' ? 'grab' : (o.platform === 'FOODPANDA' ? 'foodpanda' : 'other');
      var platIcon = o.platform === 'GRAB' ? '🟢' : (o.platform === 'FOODPANDA' ? '🟠' : '🟣');
      html += '<span class="oc-platform-badge ' + platClass + '">' + platIcon + ' ' + esc(o.platform) + '</span>';
    }
    
    html += '<span class="oc-status-badge ' + cfg.badge + '">' + cfg.icon + ' ' + cfg.label + '</span>';
    if (o.isTest) html += '<span style="background:#f59e0b;color:#fff;font-size:.6rem;padding:2px 5px;border-radius:4px;font-weight:700;margin-left:4px">🧪 TEST</span>';
    if (o.isPreorder && o.scheduledFor) {
      var pickupPH = '';
      try {
        pickupPH = new Date(o.scheduledFor).toLocaleString('en-PH', { timeZone:'Asia/Manila', month:'short', day:'numeric', hour:'numeric', minute:'2-digit', hour12:true });
      } catch(e) {}
      html += '<span style="background:#EDE9FE;color:#5B21B6;font-size:.6rem;padding:2px 6px;border-radius:4px;font-weight:700;margin-left:4px">⏰ Pickup: ' + pickupPH + '</span>';
    }
    html += '</div>';

    // Platform ref (if exists)
    if (o.platformRef) {
      html += '<div class="oc-platform-ref">📦 Ref: ' + esc(o.platformRef) + '</div>';
    }

    // Meta
    var isPlatform = !!o.platform;
    var tableLabel = isPlatform ? '📦 ' + esc(o.platform) : '🪑 Table ' + esc(String(o.tableNo || '?'));
    var typeIcon = isPlatform ? '🚴' : (o.orderType==='TAKE-OUT'?'🥡':'🍽️');
    var typeLabel = isPlatform ? 'Rider Pickup' : esc(o.orderType || '');
    var typeBg    = isPlatform ? '#7c3aed' : (o.orderType==='TAKE-OUT' ? '#c2550a' : '#065f46');
    
    html += '<div class="oc-meta">' +
      '<div class="oc-meta-item">' + tableLabel + '</div>' +
      (o.customer ? '<div class="oc-meta-item">👤 ' + esc(o.customer) + '</div>' : '') +
      '<div class="oc-meta-item"><span style="background:' + typeBg + ';color:#fff;padding:2px 8px;border-radius:20px;font-size:.65rem;font-weight:800;letter-spacing:.3px">' + typeIcon + ' ' + typeLabel + '</span></div>' +
      '<div class="oc-meta-item">🕐 ' + esc(time) + '</div>' +
      '<div class="oc-meta-item" style="opacity:.6">' + esc(elapsed) + '</div>' +
    '</div>';

    // Items
    html += '<div class="oc-items">';
    var orderTotal = 0;
    var preparedCount = 0;
    if (o.items && o.items.length) {
      o.items.forEach(function(it) {
        if (it.prepared) preparedCount++;
        var lineTotal = (it.price || 0) * (it.qty || 1);
        orderTotal += lineTotal;
        var prepIcon = it.prepared ? '✅' : '⬜';
        var prepStyle = it.prepared ? 'opacity:.5;text-decoration:line-through;' : '';

        // Color-coded size pill
        var sizeColors = { short:'#2c6e9e', medium:'#2d6a3f', tall:'#065f46' };
        var sizeBgs    = { short:'#dbeafe', medium:'#dcfce7', tall:'#d1fae5' };
        var sizeKey = it.size ? it.size.toLowerCase() : '';
        var sizePill = it.size
          ? '<span style="background:' + (sizeBgs[sizeKey]||'#e5e7eb') + ';color:' + (sizeColors[sizeKey]||'#374151') + ';border-radius:6px;padding:2px 7px;font-size:.7rem;font-weight:800;margin-right:4px">' + capitalize(it.size) + '</span>'
          : '';

        // Color-coded sugar pill with percentage
        var sugarColors = { grounded:'#2d6a3f', yani:'#8a5220', comfort:'#b85a10', full:'#b91c1c' };
        var sugarBgs    = { grounded:'#dcfce7', yani:'#fef3c7', comfort:'#ffedd5', full:'#fee2e2' };
        var sugarPcts   = { grounded:'25%', yani:'50%', comfort:'75%', full:'100%' };
        var sugarKey = it.sugar ? it.sugar.toLowerCase() : '';
        var sugarPct = sugarPcts[sugarKey] || '';
        var sugarPill = it.sugar
          ? '<span style="background:' + (sugarBgs[sugarKey]||'#e5e7eb') + ';color:' + (sugarColors[sugarKey]||'#374151') + ';border-radius:6px;padding:2px 7px;font-size:.7rem;font-weight:800">' + capitalize(it.sugar) + (sugarPct ? ' <span style="font-size:.6rem;opacity:.7;font-weight:600">' + sugarPct + '</span>' : '') + '</span>'
          : '';

        var pillsHtml = (sizePill || sugarPill) ? '<div style="margin-top:3px">' + sizePill + sugarPill + '</div>' : '';

        html += '<div class="oc-item" data-item-id="' + (it.id||'') + '" style="' + prepStyle + 'cursor:pointer;user-select:none;" title="' + (it.prepared ? 'Tap to unmark' : 'Tap to mark prepared') + '" onclick="adminTogglePrep(this,\'' + esc(o.orderId) + '\',' + (it.id||0) + ',' + (it.prepared ? 1 : 0) + ')">' +
          '<span style="font-size:1.3rem;margin-right:6px;flex-shrink:0;line-height:1;">' + prepIcon + '</span>' +
          '<div class="oc-item-qty">' + (it.qty || 1) + '×</div>' +
          '<div class="oc-item-info">' +
            '<div class="oc-item-name">' + esc(it.name) + '</div>' +
            pillsHtml +
            (it.addons && it.addons.length ? '<div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:4px">' + it.addons.map(function(a){ return '<span style="background:#dcfce7;color:#14532d;border:1.5px solid #86efac;border-radius:6px;padding:2px 8px;font-size:.75rem;font-weight:800">➕ ' + esc(a.name) + ' +₱' + parseFloat(a.price||0).toFixed(0) + '</span>'; }).join('') + '</div>' : '') +
            (it.notes ? '<div class="oc-item-notes">"' + esc(it.notes) + '"</div>' : '') +
          '</div>' +
          '<div style="font-size:.78rem;font-weight:700;color:var(--forest-deep);white-space:nowrap;margin-left:auto;padding-left:8px;flex-shrink:0">₱' + lineTotal.toLocaleString() + '</div>' +
        '</div>';
      });
    }
    // Prep progress bar (only for PREPARING status or if any prepared)
    if (o.items && o.items.length && (o.status === 'PREPARING' || preparedCount > 0)) {
      var totalItems = o.items.length;
      var pct = Math.round((preparedCount / totalItems) * 100);
      var barColor = preparedCount === totalItems ? '#27ae60' : preparedCount > 0 ? '#f39c12' : '#ccc';
      html += '<div style="margin:6px 0 2px;display:flex;align-items:center;gap:8px;">' +
        '<div style="flex:1;height:5px;background:#e0e0e0;border-radius:3px;overflow:hidden;">' +
          '<div class="prep-bar-fill" style="height:100%;width:' + pct + '%;background:' + barColor + ';border-radius:3px;transition:width .3s;"></div>' +
        '</div>' +
        '<span class="prep-bar-label" style="font-size:.7rem;font-weight:700;color:' + barColor + ';white-space:nowrap;">' + preparedCount + '/' + totalItems + ' prepped</span>' +
      '</div>';
    }
    html += '</div>';

    // Total — use actual total from DB (now correctly parsed as float in getOrders)
    // Fallback to item sum + service charge if total is missing
    var displayTotal = o.total && o.total > 0 ? o.total : (orderTotal + (o.serviceCharge || 0));
    // Apply discounted total if set
    if (o.discountedTotal && o.discountedTotal > 0) displayTotal = o.discountedTotal;
    var scLine = (o.serviceCharge && o.serviceCharge > 0)
      ? ' <span style="font-size:.7rem;font-weight:500;color:var(--timber)">(incl. ₱' + o.serviceCharge.toLocaleString() + ' svc)</span>' : '';
    html += '<div class="oc-total">₱' + displayTotal.toLocaleString() + scLine + '</div>';

    // Payment status + method selector
    var canSetPayment = (currentUser.role === 'OWNER' || currentUser.role === 'ADMIN' || currentUser.role === 'CASHIER');
    var pmIcons = { CASH:'💵', CARD:'💳', GCASH:'📱', INSTAPAY:'🏦', BDO:'🏦', BPI:'🏦', UNIONBANK:'🏦', MAYA:'📱', OTHER:'💰' };
    if (o.paymentStatus === 'PLATFORM_PAID') {
      html += '<div class="oc-payment verified">📦 Platform Handles Payment</div>';
    } else if (o.paymentStatus === 'VERIFIED' && o.paymentMethod) {
      var pmParts = o.paymentMethod.split('+');
      var splitLabel = pmParts.map(function(p){ return (pmIcons[p.trim()] || '💰') + ' ' + p.trim(); }).join(' + ');
      html += '<div class="oc-payment-row">'
        + '<div class="oc-payment verified">' + splitLabel + ' · Paid ✅</div>';
      if (canSetPayment) {
        html += '<button class="oc-pm-change" onclick="openPaymentModal(\'' + esc(o.orderId) + '\')">Change</button>';
      }
      html += '</div>';
      if (o.paymentNotes) {
        html += '<div style="font-size:.68rem;color:#6B7280;padding:2px 16px 4px;font-style:italic">📝 ' + esc(o.paymentNotes) + '</div>';
      }
    } else if (o.paymentStatus === 'SUBMITTED') {
      html += '<div class="oc-payment-row">'
        + '<div class="oc-payment submitted">💳 Payment Submitted · Pending</div>';
      if (canSetPayment) {
        html += '<button class="oc-pm-change" onclick="openVerifyFromOrder(\'' + esc(o.orderId) + '\')">📸 Verify Payment</button>';
      }
      html += '</div>';
    } else {
      // Show customer's chosen payment method even before it's confirmed
      var chosenMethod = (o.paymentMethod || '').toUpperCase().trim();
      if (chosenMethod === 'YANI_CARD') {
        // Yani Card: pre-set by customer — show card ref + direct Complete button
        var cardRef = (o.discountNote || '').replace('Yani Card: ', '') || 'Yani Card';
        html += '<div class="oc-payment-row">'
          + '<div class="oc-payment pending-method">🌿 ' + esc(cardRef) + ' · Card payment</div>';
        if (canSetPayment && o.status !== 'COMPLETED' && o.status !== 'CANCELLED') {
          html += '<button class="oc-pm-set" style="background:var(--forest);color:#fff;border:none;font-weight:700" '
            + 'onclick="_completeYaniCardOrder(\'' + esc(o.orderId) + '\')">✅ Complete</button>';
        }
        html += '</div>';
      } else {
        var pmLabel = chosenMethod
          ? ((pmIcons[chosenMethod] || '💰') + ' ' + chosenMethod.charAt(0) + chosenMethod.slice(1).toLowerCase() + ' · Not yet confirmed')
          : '⏳ No payment yet';
        var pmClass = chosenMethod ? 'oc-payment pending-method' : 'oc-payment none';
        if (canSetPayment) {
          html += '<div class="oc-payment-row">'
            + '<div class="' + pmClass + '">' + pmLabel + '</div>'
            + '<button class="oc-pm-set" onclick="openPaymentModal(\'' + esc(o.orderId) + '\')">Set Payment</button>'
            + '</div>';
        } else {
          html += '<div class="' + pmClass + '">' + pmLabel + '</div>';
        }
      }
    }

    // Notes
    if (o.notes && typeof o.notes === 'string' && o.notes.trim()) {
      html += '<div class="oc-notes">📝 ' + esc(o.notes) + '</div>';
    }

    // Discount display
    var canDiscount = (currentUser.role === 'OWNER' || currentUser.role === 'ADMIN' || currentUser.role === 'CASHIER');
    if (o.discountType && parseFloat(o.discountAmount) > 0) {
      var dtLabel = {PWD:'PWD 20%',SENIOR:'Senior 20%',BOTH:'PWD+Senior',PROMO:'Promo',CUSTOM:'Custom',YANI_CARD:'🌿 Yani Card 10%'}[o.discountType] || o.discountType;
      html += '<div class="oc-discount-row">'
        + '<span class="oc-discount-badge">🏷️ ' + dtLabel + ' -₱' + parseFloat(o.discountAmount).toFixed(2) + '</span>';
      if (canDiscount && o.status !== 'CANCELLED') {
        html += '<button class="oc-pm-change" onclick="openDiscountModal(\'' + o.orderId + '\')">Edit</button>';
      }
      html += '</div>';
      if (o.discountedTotal) {
        html += '<div style="font-size:.7rem;color:var(--forest);font-weight:700;padding:0 16px 6px;">Final: ₱' + parseFloat(o.discountedTotal).toFixed(2) + '</div>';
      }
    }

    // Actions
    if (cfg.actions.length) {
      html += '<div class="oc-actions">';
      var canCancel = (currentUser.role !== 'KITCHEN');
      cfg.actions.forEach(function(act) {
        // START and READY removed — kitchen checkboxes auto-trigger these statuses
        // if (act === 'start') — handled automatically when first checkbox ticked
        // if (act === 'ready') — handled automatically when last checkbox ticked
        if (act === 'complete') html += '<button class="oc-btn oc-btn-complete" onclick="updateStatus(\'' + o.orderId + '\',\'COMPLETED\')">🙏 Complete</button>';
        if (act === 'cancel' && canCancel) html += '<button class="oc-btn oc-btn-cancel" onclick="updateStatus(\'' + o.orderId + '\',\'CANCELLED\')">✕</button>';
      });
      html += '</div>';
    }

    // Discount button (ADMIN/CASHIER/OWNER, non-cancelled orders)
    if (canDiscount && o.status !== 'CANCELLED') {
      html += '<button class="oc-btn" style="background:#FEF3C7;color:#92400E;border:1px solid #FCD34D;margin-top:4px;width:calc(100% - 32px);margin-left:16px;" onclick="openDiscountModal(\'' + o.orderId + '\')">🏷️ '
        + (o.discountType ? 'Edit Discount' : 'Apply Discount') + '</button>';
    }

    // Print Receipt button (SERVER, ADMIN, OWNER only)
    var canPrint = (currentUser.role !== 'KITCHEN');
    if (canPrint) {
      html += '<button class="oc-btn oc-btn-print" onclick="printReceipt(\'' + o.orderId + '\')">🖨️ Print Receipt</button>';
    }

    // Split Bill button (ADMIN/OWNER/CASHIER, active or completed orders)
    var canSplit = (currentUser.role === 'ADMIN' || currentUser.role === 'OWNER' || currentUser.role === 'CASHIER');
    if (canSplit && o.status !== 'CANCELLED') {
      html += '<button class="oc-btn" style="background:#F0FDF4;color:#166534;border:1px solid #86EFAC;margin-top:4px;width:calc(100% - 32px);margin-left:16px;font-size:.75rem;" '
        + 'onclick="openSplitBill(\'' + o.orderId + '\')">✂️ Split Bill</button>';
    }

    // Resend Receipt by Email (ADMIN/OWNER/CASHIER, completed orders)
    var canResend = (currentUser.role !== 'KITCHEN');
    if (canResend && o.status === 'COMPLETED') {
      html += '<button class="oc-btn" style="background:#EFF6FF;color:#1D4ED8;border:1px solid #BFDBFE;margin-top:4px;width:calc(100% - 32px);margin-left:16px;font-size:.75rem;" '
        + 'onclick="openResendReceiptModal(\'' + o.orderId + '\',\'' + esc(o.receiptEmail||'') + '\')">📧 Email Receipt</button>';
    }

    // Edit Order button (ADMIN/OWNER/CASHIER, for non-completed/non-cancelled orders)
    var canEdit = (currentUser.role === 'ADMIN' || currentUser.role === 'OWNER' || currentUser.role === 'CASHIER');
    if (canEdit && o.status !== 'COMPLETED' && o.status !== 'CANCELLED') {
      html += '<button class="oc-btn" style="background:var(--gold);color:#fff;margin-top:6px;width:100%" onclick="openEditOrder(\'' + o.orderId + '\')">✏️ Edit Order</button>';
    }
    // Delete button (ADMIN/OWNER only, for completed/cancelled orders)
    var canDelete = (currentUser.role === 'OWNER' || currentUser.role === 'ADMIN');
    if (canDelete && (o.status === 'COMPLETED' || o.status === 'CANCELLED')) {
      html += '<button class="oc-btn oc-btn-delete" onclick="deleteOrder(\'' + o.orderId + '\')">🗑️ Delete</button>';
    }
    // Service charge waiver (OWNER/ADMIN, active orders with service charge)
    if ((currentUser.role === 'OWNER' || currentUser.role === 'ADMIN') &&
        o.status !== 'COMPLETED' && o.status !== 'CANCELLED' &&
        o.orderType === 'DINE-IN') {
      var hasSvc = o.serviceCharge && parseFloat(o.serviceCharge) > 0;
      html += '<button class="oc-btn" style="background:' + (hasSvc ? '#FEF9C3' : '#F0FDF4') + ';color:' +
        (hasSvc ? '#92400E' : '#166534') + ';border:1px solid ' + (hasSvc ? '#FDE68A' : '#86EFAC') +
        ';margin-top:4px;width:calc(100% - 32px);margin-left:16px;font-size:.75rem;" ' +
        'onclick="toggleServiceCharge(\'' + o.orderId + '\', ' + (hasSvc ? 'true' : 'false') + ')" ' +
        'title="' + (hasSvc ? 'Waive service charge for this order' : 'Restore service charge') + '">' +
        (hasSvc ? '🚫 Waive Service Charge' : '✅ Restore Service Charge') + '</button>';
    }

    html += '</div>';
    return html;
  }).join('');
}

// ══════════════════════════════════════════════════════════
// STATUS UPDATE
// ══════════════════════════════════════════════════════════
// ── Service Charge Waiver ──────────────────────────────────────────────────
async function toggleServiceCharge(orderId, hasSvc) {
  var order = allOrders.find(function(o){ return o.orderId === orderId; });
  if (!order) return;
  var subtotal = parseFloat(order.subtotal) || 0;
  var newSvc = hasSvc ? 0 : Math.round(subtotal * 0.10 * 100) / 100;
  var newTotal = Math.round((subtotal + newSvc) * 100) / 100;
  var action = hasSvc ? 'Waive' : 'Restore';
  var svcMsg = action + ' service charge for ' + orderId + '? ' +
      (hasSvc ? 'New total: P' + newTotal.toFixed(2) + ' (no service charge)' :
                'Service charge +P' + newSvc.toFixed(2) + ' = Total P' + newTotal.toFixed(2));
  if (!confirm(svcMsg)) return;
  var result = await api('updateOrderTotals', {
    orderId: orderId,
    serviceCharge: newSvc,
    total: newTotal,
    userId: currentUser && currentUser.userId
  });
  if (result.ok) {
    showToast((hasSvc ? '🚫 Service charge waived' : '✅ Service charge restored') + ' for ' + orderId, 'success');
    // Update local order immediately
    order.serviceCharge = newSvc;
    order.total = newTotal;
    renderOrders();
  } else {
    showToast('❌ ' + (result.error || 'Failed to update'), 'error');
  }
}

async function adminTogglePrep(rowEl, orderId, itemId, currentPrepared) {
  if (!itemId) return;
  var newPrepared = currentPrepared ? 0 : 1;
  var icon = rowEl.querySelector('span');
  if (icon) icon.textContent = newPrepared ? '✅' : '⬜';
  rowEl.style.opacity = newPrepared ? '.5' : '1';
  rowEl.style.textDecoration = newPrepared ? 'line-through' : '';
  rowEl.setAttribute('onclick', 'adminTogglePrep(this,\'' + orderId + '\',' + itemId + ',' + newPrepared + ')');
  rowEl.title = newPrepared ? 'Tap to unmark' : 'Tap to mark prepared';
  // Update prep bar counts
  var card = rowEl.closest('.order-card') || rowEl.parentElement;
  while (card && !card.querySelector('.prep-bar-label')) { card = card.parentElement; }
  if (card) {
    var allRows = card.querySelectorAll('[data-item-id]');
    var prepCount = 0;
    allRows.forEach(function(r) {
      var ic = r.querySelector('span');
      if (ic && (ic.textContent === '✅' || ic.textContent.trim() === '✅')) prepCount++;
    });
    var label = card.querySelector('.prep-bar-label');
    if (label) label.textContent = prepCount + '/' + allRows.length + ' prepped';
    var fill = card.querySelector('.prep-bar-fill');
    if (fill && allRows.length > 0) fill.style.width = Math.round((prepCount/allRows.length)*100) + '%';

    // AUTO-READY: if all items prepped and order is still NEW or PREPARING
    if (newPrepared && prepCount === allRows.length && allRows.length > 0) {
      var order = allOrders.find(function(o){ return o.orderId === orderId; });
      if (order && (order.status === 'NEW' || order.status === 'PREPARING')) {
        showToast('✨ All items prepped — moving to READY');
        setTimeout(function(){ updateStatus(orderId, 'READY'); }, 600);
      }
    }
  }
  try {
    await api('toggleItemPrepared', {
      userId: currentUser && currentUser.userId,
      orderId: orderId, itemId: itemId, prepared: newPrepared
    });
  } catch(e) {
    // revert on error
    if (icon) icon.textContent = currentPrepared ? '✅' : '⬜';
    rowEl.style.opacity = currentPrepared ? '.5' : '1';
    rowEl.style.textDecoration = currentPrepared ? 'line-through' : '';
  }
}

// Direct complete for Yani Card orders — no payment modal needed
async function _completeYaniCardOrder(orderId) {
  if (!confirm('Complete ' + orderId + '?
Card will be charged automatically.')) return;
  var result = await api('updateOrderStatus', {
    orderId: orderId, status: 'COMPLETED',
    userId: currentUser && currentUser.userId
  });
  if (result && result.ok) {
    _statusOverrides[orderId] = { status: 'COMPLETED', ts: Date.now() };
    allOrders.forEach(function(o){ if (o.orderId===orderId) { o.status='COMPLETED'; } });
    renderStats(); renderFilters(); renderOrders();
    showToast(orderId + ' — Completed ✅ Card charged', 2500);
  } else {
    showToast('❌ ' + ((result && result.error) || 'Failed to complete'), 'error');
  }
}

async function updateStatus(orderId, newStatus) {
  if (newStatus === 'CANCELLED') {
    // Ask for cancel reason
    var reason = await ygcSelectPrompt(
      '✕ Cancel Order — ' + orderId,
      'Select a reason for cancellation:',
      [
        { value: 'wrong_order',       label: '🔄 Wrong order / Customer changed mind' },
        { value: 'customer_left',     label: '🚶 Customer left' },
        { value: 'duplicate',         label: '📋 Duplicate order' },
        { value: 'test_order',        label: '🧪 Test order' },
        { value: 'item_unavailable',  label: '❌ Item unavailable' },
        { value: 'other',             label: '💬 Other' },
      ]
    );
    if (!reason) return; // user dismissed
    var result = await api('updateOrderStatus', { orderId:orderId, status:newStatus, cancelReason:reason, userId: currentUser && currentUser.userId });
    if (result.ok) {
      _statusOverrides[orderId] = { status: newStatus, ts: Date.now() };
      allOrders.forEach(function(o) { if (o.orderId === orderId) { o.status = newStatus; o.cancelReason = reason; } });
      renderStats(); renderFilters(); renderOrders();
      showToast(orderId + ' → CANCELLED', 1800);
    } else {
      showToast('Failed: ' + (result.error || 'Unknown error'), 'error');
    }
    return;
  }

  // ── CHECKOUT FLOW before COMPLETE ──────────────────────────────────
  if (newStatus === 'COMPLETED') {
    var order = allOrders.find(function(o) { return o.orderId === orderId; });
    var canPay = (currentUser.role === 'OWNER' || currentUser.role === 'ADMIN' || currentUser.role === 'CASHIER');
    // Yani Card orders: payment already set — complete directly, card auto-charges
    if (order && order.paymentMethod === 'YANI_CARD' && order.discountType === 'YANI_CARD') {
      // fall through to direct complete below
    } else if (canPay && order && order.orderType !== 'PLATFORM') {
      openCheckoutModal(orderId);
      return;
    }
  }

  var result = await api('updateOrderStatus', { orderId:orderId, status:newStatus, userId: currentUser && currentUser.userId });
  if (result.ok) {
    // Pin this status so polling can't revert it before GAS syncs (90s window)
    _statusOverrides[orderId] = { status: newStatus, ts: Date.now() };
    // Update local state immediately for responsiveness
    allOrders.forEach(function(o) {
      if (o.orderId === orderId) o.status = newStatus;
    });
    renderStats();
    renderFilters();
    renderOrders();
    showToast(orderId + ' → ' + newStatus, 1800);
  } else {
    showToast('Failed: ' + (result.error || 'Unknown error'), 'error');
  }
}

// ══════════════════════════════════════════════════════════
// DELETE ORDER
// ══════════════════════════════════════════════════════════
async function deleteOrder(orderId) {
  var confirmed = await ygcConfirm(
    '⚠️ Delete Order',
    'Permanently delete order ' + orderId + '? This cannot be undone.',
    'Delete', 'Cancel'
  );
  if (!confirmed) return;
  
  try {
    var result = await api('deleteOrder', { orderId: orderId, userId: currentUser && currentUser.userId });
    
    if (result.ok) {
      // Remove from local state
      allOrders = allOrders.filter(function(o) { return o.orderId !== orderId; });
      
      renderStats();
      renderFilters();
      renderOrders();
      
      showToast('✅ Order ' + orderId + ' deleted');
    } else {
      showToast('❌ Failed to delete: ' + (result.error || 'Unknown error'), 'error');
    }
  } catch (error) {
    showToast('❌ Error: ' + error.message, 'error');
  }
}

// ════════════════════════════════════════════════════════
// EDIT ORDER MODAL
// ════════════════════════════════════════════════════════
var eoOrderId = null;       // current order being edited
var eoItems = [];           // mutable copy of order items
var eoMenuData = [];        // flat menu list for adding items
var eoActiveCat = null;     // active category in add-items section

function openEditOrder(orderId) {
  var o = allOrders.find(function(x) { return x.orderId === orderId; });
  if (!o) { showToast('Order not found', 'error'); return; }
  eoOrderId = orderId;
  window._eoHasDiscount  = parseFloat(o.discountAmount) > 0;
  window._eoDiscountType = (o.discountType || 'discount').replace('_',' ');
  // Deep-copy items so we can mutate without affecting allOrders
  eoItems = (o.items || []).map(function(it) {
    return { code: it.code, name: it.name, size: it.size || '', sugar: it.sugar || '',
             qty: Number(it.qty) || 1, price: Number(it.price) || 0, notes: it.notes || '' };
  });
  document.getElementById('eoTitle').textContent = '✏️ Edit ' + orderId;
  // Show cancel-order button only for non-completed/non-cancelled orders
  document.getElementById('eoCancelOrderBtn').style.display = '';
  document.getElementById('eoOverlay').classList.add('open');
  eoRenderBody();
}

function closeEditOrder(evt) {
  if (evt && evt.target !== document.getElementById('eoOverlay')) return;
  document.getElementById('eoOverlay').classList.remove('open');
  eoOrderId = null; eoItems = [];
}

function eoRenderBody() {
  var html = '';
  // --- Current Items ---
  html += '<div class="eo-section-title">🛒 Current Items</div>';
  if (eoItems.length === 0) {
    html += '<div style="font-size:.8rem;color:var(--timber);padding:8px 0">No items. Add items below.</div>';
  } else {
    eoItems.forEach(function(it, idx) {
      var opts = [];
      if (it.size) opts.push(it.size);
      if (it.sugar) opts.push(it.sugar);
      var lineTotal = it.price * it.qty;
      html += '<div class="eo-item">' +
        '<div class="eo-item-info">' +
          '<div class="eo-item-name">' + esc(it.name) + '</div>' +
          (opts.length ? '<div class="eo-item-opts">' + esc(opts.join(' · ')) + '</div>' : '') +
          (it.addons && it.addons.length ? '<div class="eo-item-opts" style="color:var(--forest)">+ ' + it.addons.map(function(a){ return esc(a.name) + ' (+₱' + parseFloat(a.price||0).toFixed(0) + ')'; }).join(', ') + '</div>' : '') +
          '<div class="eo-item-price">₱' + lineTotal.toLocaleString() + '</div>' +
        '</div>' +
        '<div class="eo-qty-ctrl">' +
          '<button class="eo-qty-btn" onclick="eoChangeQty(' + idx + ',-1)">−</button>' +
          '<span class="eo-qty-val">' + it.qty + '</span>' +
          '<button class="eo-qty-btn" onclick="eoChangeQty(' + idx + ',1)">+</button>' +
        '</div>' +
        '<button class="eo-remove-btn" onclick="eoRemoveItem(' + idx + ')" title="Remove">✕</button>' +
      '</div>';
    });
  }
  // --- Add Items ---
  html += '<div class="eo-section-title" style="margin-top:20px">➕ Add Items</div>';
  // Build category list from allMenuData (populated during menu load)
  var menuItems = window._menuDataCache || [];
  var cats = [];
  menuItems.forEach(function(m) { if (cats.indexOf(m.category) < 0) cats.push(m.category); });
  html += '<div class="eo-cats">';
  cats.forEach(function(cat) {
    var active = (cat === eoActiveCat || (!eoActiveCat && cat === cats[0])) ? ' active' : '';
    html += '<button class="eo-cat-btn' + active + '" onclick="eoSetCat(\'' + esc(cat) + '\')">' + esc(cat) + '</button>';
  });
  html += '</div>';
  var activeCat = eoActiveCat || (cats.length ? cats[0] : null);
  var filtered = menuItems.filter(function(m) { return m.category === activeCat && m.active; });
  html += '<div class="eo-menu-grid">';
  filtered.forEach(function(m) {
    html += '<div class="eo-menu-item" onclick="eoAddItem(\'' + esc(m.code) + '\')">'+
      '<div class="eo-menu-item-name">' + esc(m.name) + '</div>' +
      '<div class="eo-menu-item-price">₱' + (m.price || 0) + '</div>' +
    '</div>';
  });
  html += '</div>';
  // Live running total at bottom of edit modal
  var eoSubtotal = eoItems.reduce(function(s,it){ return s + (parseFloat(it.price)||0)*(it.qty||1); }, 0);
  var eoSvc = eoSubtotal * 0.10;
  var eoTotal = eoSubtotal + eoSvc;
  html += '<div style="margin:14px 16px 4px;padding:12px 16px;background:var(--forest);border-radius:10px;color:#fff">' +
    '<div style="display:flex;justify-content:space-between;font-size:.78rem;opacity:.8"><span>Subtotal</span><span>₱' + eoSubtotal.toFixed(2) + '</span></div>' +
    '<div style="display:flex;justify-content:space-between;font-size:.78rem;opacity:.8;margin-top:2px"><span>Service Charge (10%)</span><span>₱' + eoSvc.toFixed(2) + '</span></div>' +
    '<div style="display:flex;justify-content:space-between;font-size:.95rem;font-weight:800;margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,.25)"><span>NEW TOTAL</span><span>₱' + eoTotal.toFixed(2) + '</span></div>' +
  '</div>';
  document.getElementById('eoBody').innerHTML = html;
}

function eoSetCat(cat) {
  eoActiveCat = cat;
  eoRenderBody();
}

function eoChangeQty(idx, delta) {
  eoItems[idx].qty = Math.max(1, (eoItems[idx].qty || 1) + delta);
  eoRenderBody();
}

function eoRemoveItem(idx) {
  eoItems.splice(idx, 1);
  eoRenderBody();
}

function eoAddItem(code) {
  var menuItems = window._menuDataCache || [];
  var m = menuItems.find(function(x) { return x.code === code; });
  if (!m) return;
  // Check if already in list (same code, no size/sugar) — just bump qty
  var existing = eoItems.find(function(it) { return it.code === code && !it.size && !it.sugar; });
  if (existing) {
    existing.qty += 1;
  } else {
    eoItems.push({ code: m.code, name: m.name, size: '', sugar: '', qty: 1, price: parseFloat(m.price) || 0, notes: '' });
  }
  eoRenderBody();
}

async function eoCancelOrder() {
  if (!eoOrderId) return;
  var reason = await ygcSelectPrompt('✕ Cancel Order — ' + eoOrderId, 'Select a reason for cancellation:', [
    { value: 'wrong_order',      label: '🔄 Wrong order / Customer changed mind' },
    { value: 'customer_left',    label: '🚶 Customer left' },
    { value: 'duplicate',        label: '📋 Duplicate order' },
    { value: 'test_order',       label: '🧪 Test order' },
    { value: 'item_unavailable', label: '❌ Item unavailable' },
    { value: 'other',            label: '💬 Other' },
  ]);
  if (!reason) return;
  var result = await api('updateOrderStatus', { orderId: eoOrderId, status: 'CANCELLED', cancelReason: reason, userId: currentUser && currentUser.userId });
  if (result.ok) {
    allOrders.forEach(function(o) { if (o.orderId === eoOrderId) { o.status = 'CANCELLED'; o.cancelReason = reason; } });
    renderStats(); renderFilters(); renderOrders();
    document.getElementById('eoOverlay').classList.remove('open');
    eoOrderId = null; eoItems = [];
  } else {
    showToast('❌ Failed to cancel: ' + (result.error || 'Unknown error'), 'error');
  }
}

async function eoSaveChanges() {
  if (!eoOrderId) return;
  if (eoItems.length === 0) {
    var confirmed = await ygcConfirm('Empty Order', 'No items in order. Cancel the order instead?', 'Yes, Cancel', 'Go Back');
    if (!confirmed) return;
    return eoCancelOrder();
  }
  var btn = document.getElementById('eoSaveBtn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    var result = await api('editOrderItems', {
      userId: currentUser && currentUser.userId,
      orderId: eoOrderId,
      items: eoItems.map(function(it) {
        return { code: it.code, name: it.name, size: it.size, sugar: it.sugar,
                 qty: it.qty, price: it.price, notes: it.notes };
      })
    });
    if (result.ok) {
      // Close modal immediately so staff sees response
      document.getElementById('eoOverlay').classList.remove('open');
      eoOrderId = null; eoItems = [];
      // Reload fresh from DB — discount/total may have changed
      await loadOrders();
      renderStats(); renderFilters(); renderOrders();
    } else {
      showToast('❌ Save failed: ' + (result.error || 'Unknown error'), 'error');
    }
  } catch (err) {
    showToast('❌ Error: ' + err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '💾 Save Changes';
  }
}

// ══════════════════════════════════════════════════════════
// PRINT RECEIPT
// ══════════════════════════════════════════════════════════

// ── Resend Receipt by Email ────────────────────────────────────────────────
function openResendReceiptModal(orderId, prefillEmail) {
  var existing = document.getElementById('resendReceiptModal');
  if (existing) existing.remove();

  var modal = document.createElement('div');
  modal.id = 'resendReceiptModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:flex-end;justify-content:center';
  modal.innerHTML = '<div style="background:#fff;border-radius:20px 20px 0 0;padding:24px;width:100%;max-width:480px;box-shadow:0 -4px 20px rgba(0,0,0,.15)">'
    + '<div style="font-weight:800;font-size:1rem;color:var(--forest-deep);margin-bottom:4px">📧 Email Receipt</div>'
    + '<div style="font-size:.78rem;color:#6b7280;margin-bottom:16px">Order ' + orderId + '</div>'
    + '<div style="margin-bottom:12px">'
    +   '<label style="font-size:.78rem;font-weight:700;color:#374151;display:block;margin-bottom:4px">Send to email *</label>'
    +   '<input id="resendEmail" type="email" placeholder="customer@email.com" value="' + escAttr(prefillEmail) + '" '
    +   'style="width:100%;padding:10px 12px;border:1.5px solid var(--mist);border-radius:10px;font-size:.88rem;font-family:var(--font-body);box-sizing:border-box">'
    + '</div>'
    + '<div style="margin-bottom:16px">'
    +   '<label style="font-size:.78rem;font-weight:700;color:#374151;display:block;margin-bottom:6px">Receipt type</label>'
    +   '<div style="display:flex;gap:8px">'
    +     '<label style="flex:1;display:flex;align-items:center;gap:8px;padding:10px 12px;border:1.5px solid var(--mist);border-radius:10px;cursor:pointer">'
    +       '<input type="radio" name="resendType" value="simple" checked> <span style="font-size:.82rem">Sales Invoice</span>'
    +     '</label>'
    +     '<label style="flex:1;display:flex;align-items:center;gap:8px;padding:10px 12px;border:1.5px solid var(--mist);border-radius:10px;cursor:pointer">'
    +       '<input type="radio" name="resendType" value="bir"> <span style="font-size:.82rem">BIR Receipt</span>'
    +     '</label>'
    +   '</div>'
    + '</div>'
    + '<div style="display:flex;gap:8px">'
    +   '<button onclick="document.getElementById(\'resendReceiptModal\').remove()" '
    +   'style="flex:1;padding:12px;border:1.5px solid var(--mist);background:#fff;border-radius:12px;font-weight:700;font-size:.88rem;cursor:pointer">Cancel</button>'
    +   '<button id="resendSendBtn" onclick="submitResendReceipt(\'' + orderId + '\')" '
    +   'style="flex:2;padding:12px;background:var(--forest);color:#fff;border:none;border-radius:12px;font-weight:700;font-size:.88rem;cursor:pointer">Send Receipt</button>'
    + '</div>'
    + '</div>';
  document.body.appendChild(modal);
  setTimeout(function() { var el = document.getElementById('resendEmail'); if(el) el.focus(); }, 100);
}

async function submitResendReceipt(orderId) {
  var emailEl = document.getElementById('resendEmail');
  var email = emailEl ? emailEl.value.trim() : '';
  if (!email || !email.includes('@')) { showToast('Enter a valid email address', 'warning'); return; }
  var typeEl = document.querySelector('input[name="resendType"]:checked');
  var receiptType = typeEl ? typeEl.value : 'simple';

  var btn = document.getElementById('resendSendBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending...'; }

  var result = await api('resendReceipt', {
    orderId: orderId,
    email: email,
    receiptType: receiptType,
    userId: currentUser && currentUser.userId
  });

  if (result && result.ok) {
    showToast('✅ Receipt sent to ' + email, 'success');
    var modal = document.getElementById('resendReceiptModal');
    if (modal) modal.remove();
  } else {
    showToast('❌ ' + (result && result.error || 'Failed to send'), 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Send Receipt'; }
  }
}


function printReceipt(orderId, copies) {
  copies = copies || 1;
  var o = allOrders.find(function(x) { return x.orderId === orderId; });
  if (!o) { showToast('Order not found', 'error'); return; }

  // Calculate totals
  var itemsTotal = 0;
  var itemRows = '';
  if (o.items && o.items.length) {
    o.items.forEach(function(it) {
      var opts = [];
      if (it.size) opts.push(it.size);
      if (it.sugar) opts.push(it.sugar);
      var lineTotal = (it.price || 0) * (it.qty || 1);
      itemsTotal += lineTotal;
      itemRows += '<tr>' +
        '<td style="padding:3px 20px 3px 0;font-weight:bold;font-size:10pt !important;">' + esc(it.name) +
        (opts.length ? '<br><span style="font-size:9pt !important;color:#555;">' + esc(opts.join(' | ')) + '</span>' : '') +
        '</td>' +
        '<td style="text-align:center;padding:3px 6px;font-size:10pt !important;">' + (it.qty || 1) + '</td>' +
        '<td style="text-align:right;padding:3px 6px;font-size:10pt !important;">' + (it.price || 0).toFixed(2) + '</td>' +
        '<td style="text-align:right;padding:3px 0 3px 6px;font-weight:bold;font-size:10pt !important;">' + lineTotal.toFixed(2) + '</td>' +
        '</tr>';
    });
  }

  var subtotal = parseFloat(o.subtotal) > 0 ? parseFloat(o.subtotal) : itemsTotal;
  var serviceCharge = (o.serviceCharge && typeof o.serviceCharge === 'number') ? o.serviceCharge : 0;
  var vatAmount = (o.vatAmount && typeof o.vatAmount === 'number') ? o.vatAmount : 0;
  var vatEnabled = vatAmount > 0;
  var discountAmount = (o.discountAmount && typeof o.discountAmount === 'number') ? o.discountAmount : 0;
  var discountType   = o.discountType || '';
  // Use discountedTotal if available (discount was applied), otherwise subtotal + serviceCharge
  var _discounted = o.discountedTotal !== null && o.discountedTotal !== undefined ? parseFloat(o.discountedTotal) : NaN;
  var grandTotal = (!isNaN(_discounted) && _discounted > 0)
    ? _discounted
    : (subtotal + serviceCharge);

  // Calculate service charge percentage dynamically
  var scPct = subtotal > 0 ? ((serviceCharge / subtotal) * 100) : 0;

  var orderType = o.orderType || 'DINE-IN';
  var tableNo = o.tableNo || '?';
  var customerName = o.customer || '';
  var orderNotes = (o.notes && typeof o.notes === 'string') ? o.notes.trim() : '';
  
  // Receipt customer details (for BIR receipts)
  var hasReceiptDetails = o.receiptName || o.receiptAddress || o.receiptTIN;
  var receiptType = (o.receiptType || '').toLowerCase();
  var isBIRReceipt = receiptType === 'bir' || hasReceiptDetails;

  // Print date = NOW (when receipt is printed) - compact format
  var now = new Date();
  var printDate = now.toLocaleDateString('en-PH', {month:'short',day:'numeric',year:'numeric',timeZone:'Asia/Manila'}) + ' ' + now.toLocaleTimeString('en-PH', {hour:'2-digit',minute:'2-digit',hour12:true,timeZone:'Asia/Manila'});
  
  // Build customer details section (for BIR receipts)
  var customerSection = '';
  if (hasReceiptDetails) {
    customerSection = '<div class="divider"></div>' +
      '<div style="font-size:12pt !important;margin:5px 0;">' +
      '<div style="font-weight:bold;margin-bottom:4px;font-size:12pt !important;">SOLD TO:</div>' +
      (o.receiptName ? '<div style="font-size:12pt !important;">Name: ' + esc(o.receiptName) + '</div>' : '') +
      (o.receiptAddress ? '<div style="font-size:12pt !important;">Address: ' + esc(o.receiptAddress) + '</div>' : '') +
      (o.receiptTIN ? '<div style="font-size:12pt !important;">TIN: ' + esc(o.receiptTIN) + '</div>' : '') +
      '</div>' +
      '<!-- AUDIT: Customer data from ORDERS sheet columns U,V,W: CUSTOMER_TIN, CUSTOMER_NAME_FULL, CUSTOMER_ADDRESS -->';
  }

  var receiptHTML = '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
    '<title>Receipt - ' + esc(orderId) + '</title>' +
    '<!--' +
    '\n  POS RECEIPT - AUDIT TRAIL' +
    '\n  Generated: ' + printDate +
    '\n  Order ID: ' + esc(orderId) +
    '\n  ' +
    '\n  DATA SOURCE: POS System > ORDERS' +
    '\n  Column Mapping:' +
    '\n  - Order Info: A (ORDER_ID), D (TABLE_NO), E (CUSTOMER_NAME), F (STATUS)' +
    '\n  - Amounts: G (SUBTOTAL), H (SERVICE_CHARGE), I (TOTAL)' +
    '\n  - Receipt: N (RECEIPT_TYPE), O (RECEIPT_DELIVERY), P (RECEIPT_EMAIL)' +
    '\n  - Customer: U (CUSTOMER_TIN), V (CUSTOMER_NAME_FULL), W (CUSTOMER_ADDRESS)' +
    '\n  - Items: ORDER_ITEMS sheet with sizes/sugar in columns' +
    '\n-->' +
    '<style>' +
    '* { margin:0; padding:0; box-sizing:border-box; }' +
    'body { font-family: Arial, Helvetica, sans-serif; width:80mm; max-width:80mm; margin:0 auto; padding:0 2mm 0.5mm 2mm; font-size:11pt !important; color:#000; -webkit-print-color-adjust:exact; line-height:1.35; }' +
    '.header { text-align:center; margin-bottom:0; }' +
    '.header h1 { font-size:18pt !important; font-weight:bold; margin-bottom:1px; letter-spacing:0.5px; }' +
    '.header .subtitle { font-size:14pt !important; font-weight:bold; margin:1px 0; }' +
    '.header p { font-size:10pt !important; color:#000; margin:0; line-height:1.3; }' +
    '.divider { border-top:1px dashed #000; margin:1px 0; }' +
    '.divider-thick { border-top:2px solid #000; margin:1px 0; }' +
    '.info-row { display:flex; justify-content:space-between; font-size:11pt !important; margin:0; }' +
    '.info-row .label { font-weight:bold; }' +
    'table { width:100%; border-collapse:collapse; font-size:10pt !important; margin:0; }' +
    'th { text-align:left; padding:4px 0 3px 0; border-bottom:1px solid #000; font-size:9pt !important; font-weight:bold; }' +
    'th:nth-child(2) { text-align:center; width:8%; }' +
    'th:nth-child(3) { text-align:right; width:15%; }' +
    'th:nth-child(4) { text-align:right; width:17%; }' +
    'td { padding:3px 0; vertical-align:top; font-size:10pt !important; }' +
    'td:nth-child(2) { text-align:center; }' +
    'td:nth-child(3), td:nth-child(4) { text-align:right; }' +
    'th, td { padding-left:6px; padding-right:6px; }' +
    'th:first-child, td:first-child { padding-left:0; padding-right:20px; }' +
    'th:last-child, td:last-child { padding-right:0; }' +
    '.total-section { margin-top:0; }' +
    '.total-row { display:flex; justify-content:space-between; margin:0; font-size:12pt !important; }' +
    '.total-row.grand { font-size:18pt !important; font-weight:bold; margin:0; padding-top:0; }' +
    '.footer { text-align:center; margin-top:0; }' +
    '.footer p { margin:0; font-size:10pt !important; }' +
    '.footer .tagline { font-size:9pt !important; font-style:italic; margin:0; }' +
    '.footer .legal { font-size:8pt !important; margin-top:0; color:#333; }' +
    '.notes { border:1px solid #000; padding:5px 6px; margin:0; font-size:10pt !important; }' +
    '@media print { ' +
    'body { width:80mm; margin:0; padding:0 2mm 0.5mm 2mm; font-size:11pt !important; line-height:1.35; } ' +
    '.header h1 { font-size:18pt !important; } ' +
    '.header .subtitle { font-size:14pt !important; } ' +
    '.header p { font-size:10pt !important; } ' +
    '.info-row { font-size:11pt !important; } ' +
    'table { font-size:10pt !important; } ' +
    'td { font-size:10pt !important; } ' +
    'th { font-size:9pt !important; } ' +
    '.total-row { font-size:12pt !important; } ' +
    '.total-row.grand { font-size:18pt !important; } ' +
    '.footer p { font-size:10pt !important; } ' +
    '@page { size:80mm auto; margin:0; } ' +
    '}' +
    '</style></head><body>' +

    // Header
    '<div class="header">' +
    '<h1>' + esc((APP_CONFIG&&APP_CONFIG.BUSINESS_NAME)||'My Cafe') + '</h1>' +
    '<p class="subtitle">' + esc((APP_CONFIG&&APP_CONFIG.TAGLINE)||'') + '</p>' +
    '<p>' + esc((APP_CONFIG&&APP_CONFIG.ADDRESS)||'Purok 8 Daang Malinaw, Loma 4119') + '</p>' +
    '<p>Amadeo, Cavite, Philippines</p>' +
    '<p>TIN: 501-401-857-00005</p>' +
    '<p>Tel: 0967-400-0040</p>' +
    '<p style="margin-top:1px;">' + (vatEnabled ? 'VAT Registered' : 'Non-VAT Registered') + '</p>' +
    '</div>' +

    '<div class="divider-thick"></div>' +

    // Order Info
    '<div class="info-row"><span class="label">Order:</span><span><b>' + esc(orderId) + '</b></span></div>' +
    (o.orNumber ? '<div class="info-row"><span class="label">OR No.:</span><span><b>' + o.orNumber + '</b></span></div>' : '') +
    '<div class="info-row"><span class="label">Date:</span><span>' + esc(printDate) + '</span></div>' +
    '<div class="info-row"><span class="label">' + esc(orderType) + '</span><span>Table: <b>' + esc(String(tableNo)) + '</b></span></div>' +
    (customerName ? '<div class="info-row"><span class="label">Customer:</span><span>' + esc(customerName) + '</span></div>' : '') +

    // Customer Details (BIR Receipt)
    customerSection +

    '<div class="divider"></div>' +

    // Items Table
    '<table>' +
    '<tr><th>Item</th><th>Qty</th><th>Price</th><th>Total</th></tr>' +
    itemRows +
    '</table>' +

    '<div class="divider"></div>' +

    // Totals
    '<div class="total-section">' +
    '<div class="total-row"><span>Subtotal:</span><span>P ' + subtotal.toFixed(2) + '</span></div>' +
    (serviceCharge > 0 ? '<div class="total-row"><span>Service Charge (' + scPct.toFixed(1) + '%):</span><span>P ' + serviceCharge.toFixed(2) + '</span></div>' : '') +
    (vatEnabled ? '<div class="total-row"><span>VAT (12%, incl.):</span><span>P ' + vatAmount.toFixed(2) + '</span></div>' : '') +
    '<div class="divider-thick"></div>' +
    (discountAmount > 0 ? '<div class="total-row" style="color:#B45309"><span>Discount (' + esc(discountType) + '):</span><span>-P ' + discountAmount.toFixed(2) + '</span></div>' : '') +
    '<div class="divider-thick"></div>' +
    '<div class="total-row grand"><span>TOTAL:</span><span>P ' + grandTotal.toFixed(2) + '</span></div>' +
    '</div>' +

    // Notes
    (orderNotes ? '<div class="notes"><b>Note:</b> ' + esc(orderNotes) + '</div>' : '') +

    '<div class="divider"></div>' +

    // Footer
    '<div class="footer">' +
    '<p><b>Happy to serve. Visit us again soon.</b></p>' +
    '<p class="tagline">' + esc((APP_CONFIG&&APP_CONFIG.TAGLINE)||'Hold on a cup of blessing') + '</p>' +
    '<p style="margin-top:3px;font-size:9px;">FB: facebook.com/yourcafe</p>' +
    '<p style="font-size:9px;">IG: @yanigardencafe</p>' +
    '<div class="legal">' +
    (isBIRReceipt ? 
      '<p>This serves as an OFFICIAL RECEIPT</p>' +
      '<p>Valid for tax deduction purposes</p>' 
      : 
      '<p>This serves as your Sales Invoice</p>' +
      '<p>Not valid for input tax claim</p>'
    ) +
    '</div>' +
    '</div>' +

    // NO BOTTOM MARGIN - Cut immediately after footer

    // Auto-print
    '</body></html>';

  // Duplicate receipt for 2 copies in one print job
  if (copies >= 2) {
    // Insert a second copy after the first with a page break
    var copyLabel = '<div style="page-break-before:always;"></div>';
    // Add COPY label to each copy
    var copy1HTML = receiptHTML.replace('</body></html>',
      '<div style="text-align:center;font-size:9px;margin-top:4px;border-top:1px dashed #aaa;padding-top:4px;">--- COPY 1 ---</div></body></html>');
    var copy2 = receiptHTML
      .replace('<html>', '<html data-copy="2">')
      .replace('</body></html>',
        '<div style="text-align:center;font-size:9px;margin-top:4px;border-top:1px dashed #aaa;padding-top:4px;">--- COPY 2 ---</div></body></html>');
    // Extract body content of copy 2 and append after copy 1
    var bodyMatch = copy2.match(/<body[^>]*>([\s\S]*)<\/body>/);
    if (bodyMatch) {
      receiptHTML = copy1HTML.replace('</body></html>',
        copyLabel + bodyMatch[1] + '</body></html>');
    }
  }

  // Use hidden iframe — bypasses popup blockers, works on mobile
  var existingFrame = document.getElementById('receiptPrintFrame');
  if (existingFrame) existingFrame.remove();
  var iframe = document.createElement('iframe');
  iframe.id = 'receiptPrintFrame';
  iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:80mm;height:1px;border:none;visibility:hidden;';
  iframe.onload = function() {
    setTimeout(function() {
      try {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
      } catch(e) {
        // Fallback: open new window
        var w = window.open('', '_blank', 'width=420,height=750');
        if (w) { w.document.write(receiptHTML); w.document.close();
          setTimeout(function(){ try{w.focus();w.print();}catch(e2){} }, 500); }
        else { showToast('⚠️ Allow popups to print receipts', 'error'); }
      }
    }, 400);
  };
  document.body.appendChild(iframe);
  iframe.contentWindow.document.open();
  iframe.contentWindow.document.write(receiptHTML);
  iframe.contentWindow.document.close();
  // Safety fallback: if onload doesn't fire within 2s
  setTimeout(function() {
    try { iframe.contentWindow.focus(); iframe.contentWindow.print(); } catch(e) {}
  }, 2000);
}

// ══════════════════════════════════════════════════════════
// UTILS
// ══════════════════════════════════════════════════════════
function esc(s) {
  if (!s) return '';
  var d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function capitalize(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}
