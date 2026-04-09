// ══════════════════════════════════════════════════════════
// CHECKOUT MODAL — Payment + Discount + Complete in one flow
// ══════════════════════════════════════════════════════════
var coOrderId       = null;
var coPayMethod     = null;
var coDiscType      = null;
var coIdImageData   = null;
var coIdUploading   = false;

function openCheckoutModal(orderId) {
  coOrderId = orderId; coPayMethod = null; coDiscType = null; coIdImageData = null;

  var order = allOrders.find(function(o){ return o.orderId === orderId; });
  var total = order ? '₱' + parseFloat(order.discountedTotal || order.total || 0).toFixed(2) : '';
  document.getElementById('coOrderLabel').textContent = orderId + ' — ' + total;

  // Reset payment buttons
  ['GCASH','CASH','CARD'].forEach(function(k){
    var b = document.getElementById('coBtnGCASH'.replace('GCASH',k));
    if (b) b.className = 'pm-btn';
  });

  // Reset discount section
  document.getElementById('coHasDiscount').checked = false;
  document.getElementById('coDiscountSection').style.display = 'none';
  ['PWD','SENIOR','BOTH','PROMO'].forEach(function(t){
    var b = document.getElementById('coDisc'+t);
    if (b) b.className = 'co-disc-btn';
  });
  document.getElementById('coPaxSection').style.display = 'none';
  document.getElementById('coPromoSection').style.display = 'none';
  document.getElementById('coIdPhotoSection').style.display = 'none';
  document.getElementById('coIdPreview').style.display = 'none';
  document.getElementById('coIdStatus').textContent = '';
  document.getElementById('coDiscResult').style.display = 'none';
  document.getElementById('coPaxTotal').value = 2;
  document.getElementById('coPaxQualified').value = 1;
  document.getElementById('coPromoPct').value = 10;
  document.getElementById('coNotes').value = '';
  document.getElementById('coConfirmBtn').disabled = true;
  document.getElementById('coConfirmBtn').textContent = '✅ Confirm & Complete';

  // If order already has payment method pre-select it
  if (order && order.paymentMethod) {
    var pm = order.paymentMethod.split('+')[0];
    if (['GCASH','CASH','CARD'].includes(pm)) { coPayMethod = pm; document.getElementById('coBtnGCASH'.replace('GCASH',pm)).className = 'pm-btn selected'; }
    coUpdateConfirmBtn();
  }

  document.getElementById('checkoutOverlay').classList.add('open');
}

function closeCheckoutModal() {
  document.getElementById('checkoutOverlay').classList.remove('open');
  coOrderId = null; coPayMethod = null; coDiscType = null; coIdImageData = null;
}

function coSelectPM(method, ev) {
  if (ev) ev.stopPropagation();
  coPayMethod = method;
  ['GCASH','CASH','CARD'].forEach(function(k){
    var b = document.getElementById('coBtnGCASH'.replace('GCASH',k));
    if (b) b.className = 'pm-btn' + (k===method ? ' selected' : '');
  });
  coUpdateConfirmBtn();
}

function coToggleDiscount() {
  var has = document.getElementById('coHasDiscount').checked;
  document.getElementById('coDiscountSection').style.display = has ? '' : 'none';
  if (!has) { coDiscType = null; document.getElementById('coDiscResult').style.display = 'none'; }
  coUpdateConfirmBtn();
}

function coSelectDisc(type) {
  coDiscType = type;
  ['PWD','SENIOR','BOTH','PROMO'].forEach(function(t){
    var b = document.getElementById('coDisc'+t);
    if (b) b.className = 'co-disc-btn' + (t===type ? ' selected' : '');
  });
  // Show/hide pax vs promo inputs
  document.getElementById('coPaxSection').style.display   = (type!=='PROMO') ? '' : 'none';
  document.getElementById('coPromoSection').style.display  = (type==='PROMO') ? '' : 'none';
  // ID photo required for PWD/Senior/Both
  document.getElementById('coIdPhotoSection').style.display = (type!=='PROMO') ? '' : 'none';
  coCalcDiscount();
  coUpdateConfirmBtn();
}

function coCalcDiscount() {
  if (!coDiscType || !coOrderId) return;
  var order = allOrders.find(function(o){ return o.orderId === coOrderId; });
  if (!order) return;
  var baseTotal = parseFloat(order.discountedTotal || order.total || 0);

  var discAmt = 0;
  if (coDiscType === 'PROMO') {
    var pct = parseFloat(document.getElementById('coPromoPct').value) || 0;
    discAmt = Math.round(baseTotal * (pct/100) * 100) / 100;
  } else {
    var totalPax = parseInt(document.getElementById('coPaxTotal').value) || 1;
    var qualPax  = parseInt(document.getElementById('coPaxQualified').value) || 1;
    qualPax = Math.min(qualPax, totalPax);
    var perPerson = baseTotal / totalPax;
    var multiplier = (coDiscType === 'BOTH') ? qualPax * 2 : qualPax;
    discAmt = Math.round(perPerson * 0.20 * Math.min(multiplier, totalPax) * 100) / 100;
  }

  var newTotal = Math.max(0, baseTotal - discAmt);
  document.getElementById('coDiscAmount').textContent = '−₱' + discAmt.toFixed(2);
  document.getElementById('coNewTotal').textContent = '₱' + newTotal.toFixed(2);
  document.getElementById('coDiscResult').style.display = '';
}

function coHandleIdPhoto(ev) {
  var file = ev.target.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    coIdImageData = e.target.result;
    var img = document.getElementById('coIdPreview');
    img.src = coIdImageData;
    img.style.display = '';
    document.getElementById('coIdStatus').textContent = '✅ ID photo ready';
    document.getElementById('coIdDropzone').style.borderColor = 'var(--forest)';
    coUpdateConfirmBtn();
  };
  reader.readAsDataURL(file);
}

function coUpdateConfirmBtn() {
  var btn = document.getElementById('coConfirmBtn');
  var hasDisc = document.getElementById('coHasDiscount').checked;
  // Requirements: payment selected; if discount → type selected; if PWD/Senior/Both → ID photo
  var needsId = hasDisc && coDiscType && coDiscType !== 'PROMO';
  var ok = !!coPayMethod && (!hasDisc || (!!coDiscType && (!needsId || !!coIdImageData)));
  btn.disabled = !ok;
}

async function confirmCheckout() {
  if (!coOrderId || !coPayMethod) return;
  var btn = document.getElementById('coConfirmBtn');
  btn.disabled = true; btn.textContent = 'Processing...';

  var order = allOrders.find(function(o){ return o.orderId === coOrderId; });
  var hasDisc = document.getElementById('coHasDiscount').checked;
  var notes   = document.getElementById('coNotes').value.trim();

  try {
    // 1. Set payment method
    var pmResult = await api('setPaymentMethod', {
      userId: currentUser && currentUser.userId,
      orderId: coOrderId,
      method: coPayMethod,
      notes: notes || undefined
    });
    if (!pmResult || !pmResult.ok) throw new Error(pmResult && pmResult.error || 'Failed to set payment');

    // 2. Apply discount (if any)
    if (hasDisc && coDiscType) {
      var baseTotal = parseFloat(order && (order.discountedTotal || order.total) || 0);
      var discPayload = { userId: currentUser && currentUser.userId, orderId: coOrderId };

      if (coDiscType === 'PROMO') {
        discPayload.discountType = 'PROMO';
        discPayload.promoPct = parseFloat(document.getElementById('coPromoPct').value) || 10;
      } else {
        var totalPax = parseInt(document.getElementById('coPaxTotal').value) || 1;
        var qualPax  = parseInt(document.getElementById('coPaxQualified').value) || 1;
        qualPax = Math.min(qualPax, totalPax);
        if (coDiscType === 'BOTH') {
          discPayload.discountType = 'BOTH';
          discPayload.totalPax    = totalPax;
          discPayload.qualifiedPax = qualPax * 2;
        } else {
          discPayload.discountType = coDiscType;
          discPayload.totalPax    = totalPax;
          discPayload.qualifiedPax = qualPax;
        }
      }

      // Upload ID photo first if present
      if (coIdImageData) {
        try {
          var uploadRes = await api('uploadInventoryPhoto', {
            userId: currentUser && currentUser.userId,
            itemCode: 'DISC_ID_' + coOrderId + '_' + Date.now(),
            imageBase64: coIdImageData.split(',')[1],
            mimeType: 'image/jpeg'
          });
          if (uploadRes && uploadRes.photoUrl) {
            discPayload.idPhotoUrl = uploadRes.photoUrl;
          }
        } catch(e) { /* non-critical — continue even if photo upload fails */ }
      }

      var discResult = await api('applyDiscount', discPayload);
      if (!discResult || !discResult.ok) {
        showToast('⚠️ Discount failed: ' + (discResult && discResult.error || 'Error') + ' — completing without discount', 'warn');
      } else {
        // Update local order total so stats refresh correctly
        allOrders.forEach(function(o){
          if (o.orderId === coOrderId) {
            o.discountedTotal = discResult.discountedTotal;
            o.discountType    = coDiscType;
            o.discountAmount  = discResult.discountAmount;
          }
        });
      }
    }

    // 3. Complete the order
    var completedOrderId = coOrderId; // capture before closeCheckoutModal nulls it
    var completedPayMethod = coPayMethod;
    closeCheckoutModal();
    var completeResult = await api('updateOrderStatus', {
      orderId: completedOrderId,
      status: 'COMPLETED',
      userId: currentUser && currentUser.userId
    });
    if (completeResult && completeResult.ok) {
      _statusOverrides[completedOrderId] = { status: 'COMPLETED', ts: Date.now() };
      allOrders.forEach(function(o){ if (o.orderId === completedOrderId) { o.status = 'COMPLETED'; o.paymentMethod = completedPayMethod; } });
      renderStats(); renderFilters(); renderOrders();
      showToast(completedOrderId + ' — Completed' + (hasDisc && coDiscType ? ' · Discount applied' : '') + ' · ' + completedPayMethod, 2200);
      // Show tap-to-print button (auto-print via setTimeout is blocked on mobile — needs user gesture)
      var _pid = completedOrderId;
      setTimeout(function() {
        var toastEl = document.createElement('div');
        toastEl.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#2D5016;color:#fff;padding:12px 24px;border-radius:12px;font-size:15px;cursor:pointer;z-index:9999;box-shadow:0 4px 16px rgba(0,0,0,.3);white-space:nowrap;';
        toastEl.innerHTML = '🖨️ Tap to print receipt — ' + _pid;
        toastEl.onclick = function() { printReceipt(_pid); document.body.removeChild(toastEl); };
        document.body.appendChild(toastEl);
        setTimeout(function() { if (document.body.contains(toastEl)) document.body.removeChild(toastEl); }, 8000);
      }, 400);
    } else {
      throw new Error(completeResult && completeResult.error || 'Failed to complete');
    }

  } catch(e) {
    btn.disabled = false; btn.textContent = '✅ Confirm & Complete';
    showToast('❌ ' + e.message, 'error');
  }
}

function openPaymentModal(orderId, fromComplete) {
  pmCurrentOrder   = orderId;
  pmSelectedMethod = null;
  pmSelectedMethod2= null;
  pmFromComplete   = !!fromComplete;

  var order = (typeof allOrders !== 'undefined') && allOrders.find(function(o){ return o.orderId === orderId; });
  var total = order ? ' — ₱' + parseFloat(order.discountedTotal || order.total).toFixed(2) : '';
  var label = (fromComplete ? 'Payment required: ' : '') + orderId + total;
  document.getElementById('pmOrderLabel').textContent = label;

  var confirmBtn = document.getElementById('pmConfirmBtn');
  confirmBtn.textContent = fromComplete ? '✅ Set Payment & Complete' : '✅ Confirm Payment';
  confirmBtn.disabled = true;

  // Reset all 3 buttons
  ['GCASH','CASH','CARD'].forEach(function(k) {
    var btn   = document.getElementById('pmBtn'   + k);
    var badge = document.getElementById('pmBadge' + k);
    if (btn)   btn.className = 'pm-btn';
    if (badge) badge.style.display = 'none';
  });
  var splitInfo = document.getElementById('pmSplitInfo');
  if (splitInfo) splitInfo.classList.remove('show');
  var notes = document.getElementById('pmNotes');
  if (notes) notes.value = '';

  document.getElementById('pmOverlay').classList.add('open');
}

function closePaymentModal() {
  document.getElementById('pmOverlay').classList.remove('open');
  pmCurrentOrder = null; pmSelectedMethod = null; pmSelectedMethod2 = null; pmFromComplete = false;
}

// pmKey: 'GCASH' | 'CASH' | 'CARD'  (also the DB method value)
function selectPM(pmKey, ev) {
  if (ev) ev.stopPropagation();
  else if (typeof event !== 'undefined' && event) try { event.stopPropagation(); } catch(e) {}
  var btn   = document.getElementById('pmBtn'   + pmKey);
  var badge = document.getElementById('pmBadge' + pmKey);

  if (!pmSelectedMethod) {
    // ── First selection ─────────────────────────────
    pmSelectedMethod = pmKey;
    if (btn)   btn.className = 'pm-btn selected';
    if (badge) { badge.textContent = '1st'; badge.style.display = ''; }
    var si = document.getElementById('pmSplitInfo');
    if (si) si.classList.add('show');
    document.getElementById('pmConfirmBtn').disabled = false;

  } else if (pmKey === pmSelectedMethod && !pmSelectedMethod2) {
    // ── Deselect first pick ─────────────────────────
    pmSelectedMethod = null;
    if (btn)   btn.className = 'pm-btn';
    if (badge) badge.style.display = 'none';
    var si = document.getElementById('pmSplitInfo');
    if (si) si.classList.remove('show');
    document.getElementById('pmConfirmBtn').disabled = true;

  } else if (!pmSelectedMethod2 && pmKey !== pmSelectedMethod) {
    // ── Second selection — split ────────────────────
    pmSelectedMethod2 = pmKey;
    if (btn)   btn.className = 'pm-btn selected-2';
    if (badge) { badge.textContent = '2nd'; badge.style.display = ''; }
    document.getElementById('pmConfirmBtn').textContent =
      '✅ Split: ' + pmSelectedMethod + ' + ' + pmSelectedMethod2;

  } else if (pmKey === pmSelectedMethod2) {
    // ── Deselect second pick ────────────────────────
    pmSelectedMethod2 = null;
    if (btn)   btn.className = 'pm-btn';
    if (badge) badge.style.display = 'none';
    document.getElementById('pmConfirmBtn').textContent =
      pmFromComplete ? '✅ Set Payment & Complete' : '✅ Confirm Payment';
  }
}

async function confirmPaymentMethod() {
  if (!pmCurrentOrder || !pmSelectedMethod) return;
  var btn = document.getElementById('pmConfirmBtn');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  // Build the method string — split joins with '+'
  var finalMethod = pmSelectedMethod2
    ? pmSelectedMethod + '+' + pmSelectedMethod2
    : pmSelectedMethod;
  var notes = (document.getElementById('pmNotes') && document.getElementById('pmNotes').value.trim()) || '';

  try {
    var r = await api('setPaymentMethod', {
      userId: currentUser && currentUser.userId,
      orderId: pmCurrentOrder,
      method: finalMethod,
      notes: notes || undefined
    });
    if (r && r.ok) {
      closePaymentModal();
      if (pmFromComplete) {
        await updateStatus(pmCurrentOrder || r.orderId, 'COMPLETED');
      } else {
        await loadOrders();
        var label = pmSelectedMethod2
          ? '✅ Split: ' + pmSelectedMethod + ' + ' + pmSelectedMethod2
          : '✅ Payment: ' + finalMethod;
        showToast(label);
      }
    } else {
      showToast('\u274C ' + (r && r.error ? r.error : 'Failed to save'));
      btn.disabled = false;
      btn.textContent = '\u2705 Confirm Payment';
    }

  } catch(e) {
    showToast('\u274C Network error');
    btn.disabled = false;
    btn.textContent = '\u2705 Confirm Payment';
  }
}

// ══════════════════════════════════════════════════════════
// DISCOUNT MODAL
// ══════════════════════════════════════════════════════════
var dmCurrentOrder = null;
var dmSelectedType = null;

function openDiscountModal(orderId) {
  dmCurrentOrder = orderId;
  dmSelectedType = null;
  var order = allOrders.find(function(o){ return o.orderId === orderId; });
  document.getElementById('dmOrderLabel').textContent = 'Order: ' + orderId
    + (order ? ' — Total: ₱' + parseFloat(order.total).toFixed(2) : '');
  document.querySelectorAll('.dm-type-btn').forEach(function(b){ b.classList.remove('selected'); });
  document.getElementById('dmPaxSection').style.display = 'none';
  document.getElementById('dmPromoSection').style.display = 'none';
  document.getElementById('dmCustomSection').style.display = 'none';
  document.getElementById('dmPreview').style.display = 'none';
  document.getElementById('dmConfirmBtn').disabled = true;
  document.getElementById('dmConfirmBtn').textContent = '✅ Apply Discount';
  document.getElementById('dmNote').value = (order && order.discountNote) || '';
  document.getElementById('discountOverlay').classList.add('open');
}
function closeDiscountModal() {
  document.getElementById('discountOverlay').classList.remove('open');
  dmCurrentOrder = null; dmSelectedType = null;
}
function selectDmType(type, ev) {
  dmSelectedType = type;
  document.querySelectorAll('.dm-type-btn').forEach(function(b){ b.classList.remove('selected'); });
  if (ev && ev.currentTarget) ev.currentTarget.classList.add('selected');
  document.getElementById('dmPaxSection').style.display   = (type==='PWD'||type==='SENIOR'||type==='BOTH') ? 'block' : 'none';
  document.getElementById('dmPromoSection').style.display = (type==='PROMO') ? 'block' : 'none';
  document.getElementById('dmCustomSection').style.display= (type==='CUSTOM') ? 'block' : 'none';
  document.getElementById('dmNoteSection').style.display  = (type==='REMOVE') ? 'none' : 'block';
  var btn = document.getElementById('dmConfirmBtn');
  btn.disabled = false;
  btn.textContent = type === 'REMOVE' ? '✕ Remove Discount' : '✅ Apply Discount';
  if (type !== 'REMOVE') updateDmPreview();
  else document.getElementById('dmPreview').style.display = 'none';
}
function updateDmPreview() {
  var order = allOrders.find(function(o){ return o.orderId === dmCurrentOrder; });
  if (!order || !dmSelectedType || dmSelectedType === 'REMOVE') return;
  var total = parseFloat(order.total) || 0;
  var discount = 0;
  if (dmSelectedType === 'PWD' || dmSelectedType === 'SENIOR' || dmSelectedType === 'BOTH') {
    var tp = parseInt(document.getElementById('dmTotalPax').value) || 1;
    var qp = parseInt(document.getElementById('dmQualPax').value)  || 1;
    discount = Math.round((total / Math.max(tp,1)) * qp * 0.20 * 100) / 100;
  } else if (dmSelectedType === 'PROMO') {
    var pct = parseFloat(document.getElementById('dmPromoPct').value) || 0;
    discount = Math.round(total * (pct/100) * 100) / 100;
  } else if (dmSelectedType === 'CUSTOM') {
    discount = parseFloat(document.getElementById('dmCustomAmt').value) || 0;
  }
  var finalTotal = Math.max(0, Math.round((total - discount) * 100) / 100);
  var breakdownHtml = '';
  if (dmSelectedType === 'PWD' || dmSelectedType === 'SENIOR' || dmSelectedType === 'BOTH') {
    var perPax = total / Math.max(tp, 1);
    var typeLabel = dmSelectedType === 'BOTH' ? 'PWD+Senior' : dmSelectedType;
    breakdownHtml =
      '<div style="font-size:.78rem;color:#166534;line-height:1.7;font-family:monospace">' +
      '₱' + total.toFixed(2) + ' ÷ ' + tp + ' pax = ₱' + perPax.toFixed(2) + '/person<br>' +
      '₱' + perPax.toFixed(2) + ' × 20% × ' + qp + ' ' + typeLabel + ' = <strong style="color:#DC2626">−₱' + discount.toFixed(2) + '</strong><br>' +
      '<span style="border-top:1px solid #86EFAC;display:block;margin-top:4px;padding-top:4px">' +
      'New total: <strong style="font-size:.95rem">₱' + finalTotal.toFixed(2) + '</strong></span>' +
      '</div>';
  } else if (dmSelectedType === 'PROMO') {
    breakdownHtml =
      '<div style="font-size:.78rem;color:#166534;font-family:monospace">' +
      '₱' + total.toFixed(2) + ' × ' + pct.toFixed(0) + '% = <strong style="color:#DC2626">−₱' + discount.toFixed(2) + '</strong><br>' +
      'New total: <strong style="font-size:.95rem">₱' + finalTotal.toFixed(2) + '</strong>' +
      '</div>';
  } else {
    breakdownHtml = '₱' + total.toFixed(2) + ' − ₱' + discount.toFixed(2) + ' = <strong>₱' + finalTotal.toFixed(2) + '</strong>';
  }
  document.getElementById('dmPreviewText').innerHTML = breakdownHtml;
  document.getElementById('dmPreview').style.display = 'block';
}
// Wire preview on input change
document.addEventListener('DOMContentLoaded', function() {
  // Try to restore previous session so page refresh doesn't force re-login
  if (tryRestoreSession()) {
    document.getElementById('loginOverlay').classList.add('hidden');
    document.getElementById('dashboard').style.display = 'block';
    applyRoleUI();
    resetSessionTimer();
    startPolling();
    initRealtime();
    if (currentUser.role === 'ADMIN' || currentUser.role === 'OWNER') {
      setTimeout(runHealthCheck, 2000);
      setTimeout(initQueueMonitor, 1000);
    }
    if (currentUser.role === 'OWNER' || currentUser.role === 'ADMIN' || currentUser.role === 'CASHIER') {
      setTimeout(checkCashSessionOnLogin, 3000);
    }
  }
  ['dmTotalPax','dmQualPax','dmPromoPct','dmCustomAmt'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('input', function(){ if(dmSelectedType) updateDmPreview(); });
  });
});
async function submitDiscount() {
  if (!dmCurrentOrder || !dmSelectedType) return;
  var btn = document.getElementById('dmConfirmBtn');
  btn.disabled = true; btn.textContent = 'Saving...';
  var payload = {
    userId: currentUser && currentUser.userId,
    orderId: dmCurrentOrder,
    discountType: dmSelectedType,
    note: document.getElementById('dmNote').value || ''
  };
  if (dmSelectedType === 'PWD' || dmSelectedType === 'SENIOR' || dmSelectedType === 'BOTH') {
    payload.totalPax   = parseInt(document.getElementById('dmTotalPax').value) || 1;
    payload.qualifiedPax = parseInt(document.getElementById('dmQualPax').value) || 1;
  } else if (dmSelectedType === 'PROMO') {
    payload.promoPct = parseFloat(document.getElementById('dmPromoPct').value) || 0;
  } else if (dmSelectedType === 'CUSTOM') {
    payload.customAmt = parseFloat(document.getElementById('dmCustomAmt').value) || 0;
  }
  try {
    var r = await api('applyDiscount', payload);
    if (r && r.ok) {
      closeDiscountModal();
      await loadOrders();
      if (dmSelectedType === 'REMOVE') {
        showToast('Discount removed');
      } else {
        showToast('🏷️ Discount applied: -₱' + (r.discountAmount || 0).toFixed(2) + ' → Final ₱' + (r.discountedTotal || 0).toFixed(2));
      }
    } else {
      showToast('❌ ' + (r && r.error ? r.error : 'Failed'));
      btn.disabled = false;
      btn.textContent = '✅ Apply Discount';
    }
  } catch(e) {
    showToast('❌ Network error');
    btn.disabled = false;
    btn.textContent = '✅ Apply Discount';
  }
}
