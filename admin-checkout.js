// ══════════════════════════════════════════════════════════
// CHECKOUT MODAL — Payment + Discount + Complete in one flow
// ══════════════════════════════════════════════════════════
var coOrderId       = null;
var coPayMethod     = null;
var coDiscType      = null;
var coIdImageData   = null;
var coIdUploading   = false;

function openCheckoutModal(orderId) {
  // Pause order polling while modal open — stops re-renders stealing input focus
  if (typeof _pollPause === 'function') _pollPause(true);
  setTimeout(coLoadYaniCards, 300); // pre-warm dropdown
  coOrderId = orderId; coPayMethod = null; coDiscType = null; coIdImageData = null;

  var order = allOrders.find(function(o){ return o.orderId === orderId; });
  var total = order ? '₱' + parseFloat(order.discountedTotal || order.total || 0).toFixed(2) : '';
  document.getElementById('coOrderLabel').textContent = orderId + ' — ' + total;

  // Reset payment buttons
  ['GCASH','CASH','CARD','YANI_CARD'].forEach(function(k){
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
  // Reset Yani Card
  var yaniSec = document.getElementById('coYaniCardSection');
  if (yaniSec) yaniSec.style.display = 'none';
  var yaniIn = document.getElementById('coYaniCardNumber');
  if (yaniIn) yaniIn.value = '';
  var yaniSt = document.getElementById('coYaniCardStatus');
  if (yaniSt) yaniSt.textContent = '';
  var yaniBtn = document.getElementById('coDiscYANI');
  if (yaniBtn) yaniBtn.className = 'co-disc-btn';
  document.getElementById('coConfirmBtn').disabled = true;
  document.getElementById('coConfirmBtn').textContent = '✅ Confirm & Complete';

  // If order already has payment method pre-select it
  if (order && order.paymentMethod) {
    var pm = order.paymentMethod.split('+')[0];
    if (['GCASH','CASH','CARD','YANI_CARD'].includes(pm)) { coPayMethod = pm; var btn=document.getElementById('coBtnGCASH'.replace('GCASH',pm)); if(btn) btn.className = 'pm-btn selected'; }
    coUpdateConfirmBtn();
  }

  document.getElementById('checkoutOverlay').classList.add('open');
}

function closeCheckoutModal() {
  // Resume order polling
  if (typeof _pollPause === 'function') _pollPause(false);
  document.getElementById('checkoutOverlay').classList.remove('open');
  coOrderId = null; coPayMethod = null; coDiscType = null; coIdImageData = null;
}

function coSelectPM(method, ev) {
  if (ev) ev.stopPropagation();
  coPayMethod = method;
  ['GCASH','CASH','CARD','YANI_CARD'].forEach(function(k){
    var b = document.getElementById('coBtnGCASH'.replace('GCASH',k));
    if (b) b.className = 'pm-btn' + (k===method ? ' selected' : '');
  });
  // Yani Card = payment + discount in one tap
  if (method === 'YANI_CARD') {
    var discChk = document.getElementById('coHasDiscount');
    if (discChk && !discChk.checked) { discChk.checked = true; coToggleDiscount(); }
    coSelectDisc('YANI_CARD');
  } else if (coDiscType === 'YANI_CARD') {
    // Switched away — clear yani card discount
    var discChk2 = document.getElementById('coHasDiscount');
    if (discChk2) { discChk2.checked = false; coToggleDiscount(); }
    coDiscType = null;
  }
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
  ['PWD','SENIOR','BOTH','PROMO','YANI_CARD'].forEach(function(t){
    var id = 'coDisc' + (t==='YANI_CARD'?'YANI':t);
    var b = document.getElementById(id);
    if (b) b.className = 'co-disc-btn' + (t===type ? ' selected' : '');
  });
  // Show/hide pax vs promo vs yani card inputs
  var isPWD  = (type==='PWD'||type==='SENIOR'||type==='BOTH');
  document.getElementById('coPaxSection').style.display       = isPWD ? '' : 'none';
  document.getElementById('coPromoSection').style.display     = (type==='PROMO') ? '' : 'none';
  document.getElementById('coIdPhotoSection').style.display   = isPWD ? '' : 'none';
  var yaniSec = document.getElementById('coYaniCardSection');
  if (yaniSec) {
    yaniSec.style.display = (type === 'YANI_CARD') ? '' : 'none';
    if (type === 'YANI_CARD') coLoadYaniCards();
  }
  coCalcDiscount();
  coUpdateConfirmBtn();
}

function coCalcDiscount() {
  if (!coDiscType || !coOrderId) return;
  var order = allOrders.find(function(o){ return o.orderId === coOrderId; });
  if (!order) return;
  var baseTotal = parseFloat(order.discountedTotal || order.total || 0);

  var discAmt = 0;
  if (coDiscType === 'YANI_CARD') {
    // 10% flat on total — but only calculate if card is validated
    var yaniSt = document.getElementById('coYaniCardStatus');
    var isValid = yaniSt && yaniSt.dataset.valid === 'true';
    if (isValid) {
      discAmt = Math.round(baseTotal * 0.10 * 100) / 100;
    } else {
      document.getElementById('coDiscResult').style.display = 'none';
      return;
    }
  } else if (coDiscType === 'PROMO') {
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

// Load active Yani Cards into the dropdown — called when section opens
async function coLoadYaniCards() {
  var sel = document.getElementById('coYaniCardNumber');
  var status = document.getElementById('coYaniCardStatus');
  if (!sel) return;
  sel.innerHTML = '<option value="">⏳ Loading cards…</option>';
  try {
    var r = await fetch('/api/card', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'listCards', pin:'2026' }) });
    var d = await r.json();
    var active = (d.cards || []).filter(function(c){ return c.status === 'ACTIVE'; });
    if (!active.length) {
      sel.innerHTML = '<option value="">No active cards — activate one first</option>';
      return;
    }
    sel.innerHTML = '<option value="">— Select card —</option>'
      + active.map(function(c){
          var name = c.holder_name ? ' · ' + c.holder_name : '';
          return '<option value="' + c.card_number + '">'
            + c.card_number + name + ' · ₱' + parseFloat(c.balance).toFixed(2) + '</option>';
        }).join('');
  } catch(e) {
    sel.innerHTML = '<option value="">Error — try refreshing</option>';
  }
}

// Auto-validates when staff selects a card from dropdown
async function coValidateYaniCard() {
  var sel    = document.getElementById('coYaniCardNumber');
  var status = document.getElementById('coYaniCardStatus');
  if (!sel || !status) return;
  var cardNum = sel.value;
  status.dataset.valid   = 'false';
  status.dataset.cardNum = '';
  if (!cardNum) {
    status.textContent = '';
    coUpdateConfirmBtn(); return;
  }
  status.textContent = '⏳ Checking…';
  status.style.color = 'var(--timber)';
  try {
    var r = await fetch('/api/card', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'lookupCard', card_number: cardNum }) });
    var d = await r.json();
    if (!d.ok || !d.card) {
      status.textContent = '❌ Card not found'; status.style.color = '#B5443A';
    } else if (d.card.status !== 'ACTIVE') {
      status.textContent = '❌ Card ' + d.card.status; status.style.color = '#B5443A';
    } else {
      var bal = parseFloat(d.card.balance || 0);
      status.textContent = '✅ ' + (d.card.holder_name || cardNum) + ' · Balance: ₱' + bal.toFixed(2);
      status.style.color = '#065F46';
      status.dataset.valid   = 'true';
      status.dataset.cardNum = cardNum;
      status.dataset.balance = bal;
    }
  } catch(e) {
    status.textContent = '❌ Error checking card'; status.style.color = '#B5443A';
  }
  coCalcDiscount();
  coUpdateConfirmBtn();
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
  var needsId   = hasDisc && coDiscType && (coDiscType==='PWD'||coDiscType==='SENIOR'||coDiscType==='BOTH');
  var needsCard = hasDisc && coDiscType === 'YANI_CARD';
  var cardOk    = !needsCard || (function(){ var s=document.getElementById('coYaniCardStatus'); return s&&s.dataset.valid==='true'; })();
  var ok = !!coPayMethod && (!hasDisc || (!!coDiscType && (!needsId || !!coIdImageData) && cardOk));
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

      if (coDiscType === 'YANI_CARD') {
        var cardNum = (document.getElementById('coYaniCardStatus').dataset.cardNum || document.getElementById('coYaniCardNumber').value || '').trim().toUpperCase();
        discPayload.discountType = 'YANI_CARD';
        discPayload.yaniCardNumber = cardNum;
        discPayload.promoPct = 10;
      } else if (coDiscType === 'PROMO') {
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

    // 3. Complete the order first — then charge card only if order succeeds
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

      // 4. Charge Yani Card — ONLY after order is confirmed COMPLETED (prevents double charge on failed orders)
      if (completedPayMethod === 'YANI_CARD' || (hasDisc && coDiscType === 'YANI_CARD')) {
        var _r2 = document.getElementById('coYaniCardNumber') ? document.getElementById('coYaniCardNumber').value.trim() : '';
        var _st = document.getElementById('coYaniCardStatus');
        var _storedCardNum = _st && _st.dataset.cardNum; // use validated card number from Check step
        var cardNum2 = _storedCardNum || (/^\d+$/.test(_r2) ? 'YANI-' + _r2.padStart(4,'0') : _r2.toUpperCase());
        var grossAmt = parseFloat(order && order.total || 0);
        if (cardNum2 && grossAmt > 0) {
          fetch('/api/card', { method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ action:'chargeCard', card_number: cardNum2,
              gross_amount: grossAmt, order_id: completedOrderId,
              performed_by: currentUser && currentUser.userId || 'OWNER' })
          }).then(function(r){ return r.json(); }).then(function(d){
            if (d.ok) {
              showToast('💳 ' + cardNum2 + ' charged ₱' + parseFloat(d.charged||grossAmt*0.9).toFixed(2) + ' · Balance: ₱' + parseFloat(d.balance_after||0).toFixed(2), 3000);
            }
          }).catch(function(){});
        }
      }
      // Receipt printing: user can tap "Print Receipt" button on the order card
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

  // Reset all 4 buttons
  ['GCASH','CASH','CARD','YANI_CARD'].forEach(function(k) {
    var btn   = document.getElementById('pmBtn'   + k);
    var badge = document.getElementById('pmBadge' + k);
    if (btn)   btn.className = 'pm-btn';
    if (badge) badge.style.display = 'none';
  });
  // Hide Yani card section
  var yaniSec = document.getElementById('pmYaniCardSection');
  if (yaniSec) yaniSec.style.display = 'none';
  var yaniSt = document.getElementById('pmYaniCardStatus');
  if (yaniSt) { yaniSt.textContent = ''; yaniSt.dataset.valid = 'false'; yaniSt.dataset.cardNum = ''; }
  var splitInfo = document.getElementById('pmSplitInfo');
  if (splitInfo) splitInfo.classList.remove('show');
  var notes = document.getElementById('pmNotes');
  if (notes) notes.value = '';

  document.getElementById('pmOverlay').classList.add('open');
}

function closePaymentModal() {
  document.getElementById('pmOverlay').classList.remove('open');
  var yaniSec = document.getElementById('pmYaniCardSection');
  if (yaniSec) yaniSec.style.display = 'none';
  var yaniSt = document.getElementById('pmYaniCardStatus');
  if (yaniSt) { yaniSt.textContent = ''; yaniSt.dataset.valid = 'false'; yaniSt.dataset.cardNum = ''; }
  var yaniIn = document.getElementById('pmYaniCardInput');
  if (yaniIn) yaniIn.value = '';
  var yaniSel = document.getElementById('pmYaniCardSelect');
  if (yaniSel) yaniSel.value = '';
  pmCurrentOrder = null; pmSelectedMethod = null; pmSelectedMethod2 = null; pmFromComplete = false;
}

// pmKey: 'GCASH' | 'CASH' | 'CARD' | 'YANI_CARD'
function selectPM(pmKey, ev) {
  if (ev) ev.stopPropagation();
  else if (typeof event !== 'undefined' && event) try { event.stopPropagation(); } catch(e) {}

  // YANI_CARD cannot be used as a split method (it applies a discount + deducts balance)
  if (pmKey === 'YANI_CARD' && pmSelectedMethod && pmSelectedMethod !== 'YANI_CARD') return;
  if (pmSelectedMethod2 && pmKey === 'YANI_CARD') return;

  var btn   = document.getElementById('pmBtn'   + pmKey);
  var badge = document.getElementById('pmBadge' + pmKey);
  var yaniSec = document.getElementById('pmYaniCardSection');
  var yaniSt  = document.getElementById('pmYaniCardStatus');

  if (!pmSelectedMethod) {
    // ── First selection ─────────────────────────────
    pmSelectedMethod = pmKey;
    if (btn)   btn.className = 'pm-btn selected';
    if (badge) { badge.textContent = '1st'; badge.style.display = ''; }
    var si = document.getElementById('pmSplitInfo');
    if (si) si.classList.add('show');

    // Show Yani Card section + load cards
    if (pmKey === 'YANI_CARD') {
      if (yaniSec) { yaniSec.style.display = ''; pmLoadYaniCards(); }
      document.getElementById('pmConfirmBtn').disabled = true; // wait for card selection
    } else {
      if (yaniSec) yaniSec.style.display = 'none';
      document.getElementById('pmConfirmBtn').disabled = false;
    }

  } else if (pmKey === pmSelectedMethod && !pmSelectedMethod2) {
    // ── Deselect first pick ─────────────────────────
    pmSelectedMethod = null;
    if (btn)   btn.className = 'pm-btn';
    if (badge) badge.style.display = 'none';
    if (yaniSec) yaniSec.style.display = 'none';
    if (yaniSt)  { yaniSt.textContent = ''; yaniSt.dataset.valid = 'false'; yaniSt.dataset.cardNum = ''; }
    var si = document.getElementById('pmSplitInfo');
    if (si) si.classList.remove('show');
    document.getElementById('pmConfirmBtn').disabled = true;

  } else if (!pmSelectedMethod2 && pmKey !== pmSelectedMethod) {
    // ── Second selection — split (YANI_CARD blocked above) ─────────────────
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

// ── Yani Card lookup for Set Payment modal ───────────────────────────────────
async function pmLoadYaniCards() {
  var sel = document.getElementById('pmYaniCardSelect');
  if (!sel) return;
  sel.innerHTML = '<option value="">Loading cards…</option>';
  try {
    var resp = await fetch('/api/card', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'listCards', pin: '2026', status: 'ACTIVE' })
    });
    var r = await resp.json();
    if (r && r.ok && r.cards && r.cards.length) {
      sel.innerHTML = '<option value="">— Pick from active cards —</option>'
        + r.cards.map(function(c) {
            var name = c.holder_name ? ' · ' + c.holder_name : '';
            return '<option value="' + c.card_number + '">'
              + c.card_number + name + ' · \u20b1' + parseFloat(c.balance).toFixed(2) + '</option>';
          }).join('');
    } else {
      sel.innerHTML = '<option value="">No active cards found</option>';
    }
  } catch(e) {
    sel.innerHTML = '<option value="">Error loading cards</option>';
  }
}

// Called when user picks from dropdown — fills text input then looks up
function pmPickFromDropdown() {
  var sel = document.getElementById('pmYaniCardSelect');
  var inp = document.getElementById('pmYaniCardInput');
  if (sel && inp && sel.value) {
    inp.value = sel.value;
    pmLookupYaniCard();
  }
}

// Called on every keystroke in text input OR after dropdown pick
async function pmLookupYaniCard() {
  var inp    = document.getElementById('pmYaniCardInput');
  var st     = document.getElementById('pmYaniCardStatus');
  var btn    = document.getElementById('pmConfirmBtn');
  var raw    = inp ? inp.value.trim().toUpperCase() : '';

  // Normalise: "1004" or "YANI1004" → "YANI-1004"
  var cardNum = raw;
  if (raw && !raw.startsWith('YANI-')) {
    var digits = raw.replace(/^YANI/i, '').replace(/\D/g, '');
    cardNum = digits ? 'YANI-' + digits : '';
  }

  if (st) { st.textContent = ''; st.dataset.valid = 'false'; st.dataset.cardNum = ''; }
  if (btn) btn.disabled = true;
  if (!cardNum) return;

  var order = (typeof allOrders !== 'undefined') && allOrders.find(function(o){ return o.orderId === pmCurrentOrder; });
  var orderTotal = order ? parseFloat(order.total || 0) : 0; // always gross

  try {
    var resp2 = await fetch('/api/card', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'lookupCard', card_number: cardNum })
    });
    var r = await resp2.json();
    if (r && r.ok && r.card) {
      var c = r.card;
      var bal = parseFloat(c.balance);
      var discPct = parseFloat(c.discount_pct || 10);
      var discount = Math.round(orderTotal * discPct / 100 * 100) / 100;
      var charge   = Math.round((orderTotal - discount) * 100) / 100;
      var sufficient = bal >= charge;
      if (st) {
        st.dataset.valid   = sufficient ? 'true' : 'false';
        st.dataset.cardNum = cardNum;
        if (!sufficient) {
          st.innerHTML = '❌ Insufficient balance · ₱' + bal.toFixed(2) + ' available, ₱' + charge.toFixed(2) + ' needed';
          st.style.color = '#DC2626';
        } else {
          st.innerHTML = '✅ <strong>' + (c.holder_name || cardNum) + '</strong>'
            + ' · Balance: ₱' + bal.toFixed(2)
            + (orderTotal > 0 ? ' · Charge: ₱' + charge.toFixed(2) + ' <span style="color:#4b7a5a">(save ₱' + discount.toFixed(2) + ')</span>' : '');
          st.style.color = '#065f46';
          if (btn) btn.disabled = false;
        }
      }
    } else {
      if (st) { st.innerHTML = '❌ ' + (r && r.error ? r.error : 'Card not found or inactive'); st.style.color = '#DC2626'; }
    }
  } catch(e) {
    if (st) { st.innerHTML = '❌ Lookup failed'; st.style.color = '#DC2626'; }
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

  // Yani Card: validate card is selected and valid
  if (pmSelectedMethod === 'YANI_CARD') {
    var yaniSt  = document.getElementById('pmYaniCardStatus');
    var cardNum = yaniSt && yaniSt.dataset.cardNum;
    if (!cardNum || yaniSt.dataset.valid !== 'true') {
      showToast('❌ Select a valid Yani Card first', 3500);
      btn.disabled = false; btn.textContent = '✅ Confirm Payment'; return;
    }
    // Store card number in notes for the charge_card RPC trigger on COMPLETED
    if (!notes) notes = 'Yani Card: ' + cardNum;
    else notes = 'Yani Card: ' + cardNum + ' · ' + notes;
  }

  try {
    var r = await api('setPaymentMethod', {
      userId: currentUser && currentUser.userId,
      orderId: pmCurrentOrder,
      method: finalMethod,
      notes: notes || undefined
    });
    if (r && r.ok) {
      // If Yani Card — also apply the discount before completing
      if (pmSelectedMethod === 'YANI_CARD') {
        var yaniSt2 = document.getElementById('pmYaniCardStatus');
        var cNum = yaniSt2 && yaniSt2.dataset.cardNum;
        if (cNum) {
          await api('applyDiscount', {
            userId: currentUser && currentUser.userId,
            orderId: pmCurrentOrder,
            discountType: 'YANI_CARD',
            yaniCardNumber: cNum
          });
        }
      }
      closePaymentModal();
      var order = allOrders.find(function(o){ return o.orderId === pmCurrentOrder; });
      var needsComplete = order && (order.status === 'READY' || order.status === 'PREPARING' || order.status === 'NEW');
      if (pmFromComplete || needsComplete) {
        await updateStatus(pmCurrentOrder || r.orderId, 'COMPLETED');
        showToast('✅ Paid + Completed: ' + finalMethod, 3500);
      } else {
        await loadOrders();
        var label = pmSelectedMethod2
          ? '✅ Split: ' + pmSelectedMethod + ' + ' + pmSelectedMethod2
          : '✅ Payment: ' + finalMethod;
        showToast(label, 3500);
      }
    } else {
      showToast('❌ ' + (r && r.error ? r.error : 'Failed to save'), 3500);
      btn.disabled = false; btn.textContent = '✅ Confirm Payment';
    }
  } catch(e) {
    showToast('❌ Network error', 3500);
    btn.disabled = false; btn.textContent = '✅ Confirm Payment';
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

// ══════════════════════════════════════════════════════════
// SPLIT BILLING
// ══════════════════════════════════════════════════════════
var _splitOrder = null;
var _splitMode  = 'EQUAL'; // 'EQUAL' | 'ITEMS'
var _splitPax   = 2;
var _itemAssign = {}; // { itemIdx: personIdx (0-based) }

function openSplitBill(orderId) {
  _splitOrder  = allOrders.find(function(o) { return o.orderId === orderId; });
  if (!_splitOrder) return;
  _splitMode   = 'EQUAL';
  _splitPax    = 2;
  _itemAssign  = {};

  // Build modal if not exists
  if (!document.getElementById('splitBillOverlay')) {
    var el = document.createElement('div');
    el.id = 'splitBillOverlay';
    el.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:900;align-items:center;justify-content:center;padding:16px;overflow-y:auto';
    el.innerHTML =
      '<div id="splitBillModal" style="background:#fff;border-radius:16px;width:100%;max-width:520px;padding:0;box-shadow:0 20px 60px rgba(0,0,0,.25);overflow:hidden">'
      + '<div id="splitBillContent"></div>'
      + '</div>';
    document.body.appendChild(el);
  }

  document.getElementById('splitBillOverlay').style.display = 'flex';
  renderSplitBill();
}

function closeSplitBill() {
  var el = document.getElementById('splitBillOverlay');
  if (el) el.style.display = 'none';
  _splitOrder = null;
}

function renderSplitBill() {
  var o = _splitOrder;
  if (!o) return;
  var total = parseFloat(o.discountedTotal || o.total || 0);
  var subtotal = parseFloat(o.subtotal || 0);
  var svc = parseFloat(o.serviceCharge || 0);
  var items = o.items || [];
  var content = document.getElementById('splitBillContent');
  if (!content) return;

  var html = '';

  // Header
  html += '<div style="background:#1a3a2a;padding:18px 20px;display:flex;justify-content:space-between;align-items:center">'
    + '<div>'
    + '<div style="color:#a3d9a5;font-weight:800;font-size:.95rem">✂️ Split Bill</div>'
    + '<div style="color:#c8e6c9;font-size:.75rem;margin-top:2px">' + esc(o.orderId) + ' · ₱' + total.toFixed(2) + ' total</div>'
    + '</div>'
    + '<button onclick="closeSplitBill()" style="background:rgba(255,255,255,.15);border:none;color:#fff;border-radius:8px;padding:6px 12px;cursor:pointer;font-size:.8rem">✕ Close</button>'
    + '</div>';

  // Mode tabs
  html += '<div style="display:flex;border-bottom:2px solid #e5e7eb">'
    + '<button onclick="setSplitMode(\'EQUAL\')" style="flex:1;padding:12px;border:none;cursor:pointer;font-weight:700;font-size:.85rem;'
    + (_splitMode==='EQUAL' ? 'background:#f0fdf4;color:#166534;border-bottom:3px solid #22c55e;' : 'background:#f9fafb;color:#6b7280;') + '">⚖️ Equal Split</button>'
    + '<button onclick="setSplitMode(\'ITEMS\')" style="flex:1;padding:12px;border:none;cursor:pointer;font-weight:700;font-size:.85rem;'
    + (_splitMode==='ITEMS' ? 'background:#f0fdf4;color:#166534;border-bottom:3px solid #22c55e;' : 'background:#f9fafb;color:#6b7280;') + '">📋 Split by Items</button>'
    + '</div>';

  html += '<div style="padding:20px">';

  if (_splitMode === 'EQUAL') {
    // ── EQUAL SPLIT ────────────────────────────────────────────────────────
    html += '<div style="margin-bottom:16px">'
      + '<label style="font-size:.8rem;font-weight:700;color:#374151;display:block;margin-bottom:8px">Number of People</label>'
      + '<div style="display:flex;align-items:center;gap:12px">'
      + '<button onclick="changePax(-1)" style="width:38px;height:38px;border-radius:50%;border:2px solid #e5e7eb;background:#fff;font-size:1.2rem;cursor:pointer;font-weight:700">−</button>'
      + '<span id="splitPaxNum" style="font-size:1.8rem;font-weight:800;color:#1a3a2a;min-width:40px;text-align:center">' + _splitPax + '</span>'
      + '<button onclick="changePax(1)" style="width:38px;height:38px;border-radius:50%;border:2px solid #e5e7eb;background:#fff;font-size:1.2rem;cursor:pointer;font-weight:700">+</button>'
      + '</div></div>';

    var perPerson = total / _splitPax;
    var perSvc    = svc / _splitPax;
    var perSub    = subtotal / _splitPax;

    html += '<div style="background:#f0fdf4;border-radius:12px;padding:16px;margin-bottom:16px">'
      + '<div style="font-weight:700;font-size:.8rem;color:#166534;margin-bottom:10px">Each person pays:</div>';

    for (var i = 0; i < _splitPax; i++) {
      html += '<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #dcfce7;font-size:.88rem">'
        + '<span style="color:#374151">Person ' + (i+1) + '</span>'
        + '<span style="font-weight:800;color:#1a3a2a">₱' + perPerson.toFixed(2) + '</span>'
        + '</div>';
    }

    html += '<div style="display:flex;justify-content:space-between;padding:8px 0;font-size:.75rem;color:#6b7280;margin-top:4px">'
      + '<span>Subtotal / person</span><span>₱' + perSub.toFixed(2) + '</span></div>'
      + '<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:.75rem;color:#6b7280">'
      + '<span>Service charge / person</span><span>₱' + perSvc.toFixed(2) + '</span></div>'
      + '</div>';

    // Printable split receipt area
    html += '<button onclick="printSplitReceipts()" style="width:100%;padding:12px;background:#1a3a2a;color:#fff;border:none;border-radius:10px;font-weight:700;font-size:.9rem;cursor:pointer;margin-bottom:8px">🖨️ Print Split Receipts</button>';
    html += '<button onclick="printReceipt(_splitOrder&&_splitOrder.orderId)" style="width:100%;padding:11px;background:#f0fdf4;color:#166534;border:1.5px solid #86EFAC;border-radius:10px;font-weight:700;font-size:.85rem;cursor:pointer;margin-bottom:8px">🧾 Print Combined Bill</button>';
    html += '<button onclick="saveSplitBillData()" style="width:100%;padding:11px;background:#f9fafb;color:#374151;border:1.5px solid #e5e7eb;border-radius:10px;font-weight:700;font-size:.85rem;cursor:pointer">💾 Save Split Record</button>';

  } else {
    // ── SPLIT BY ITEMS ─────────────────────────────────────────────────────
    html += '<div style="margin-bottom:14px">'
      + '<label style="font-size:.8rem;font-weight:700;color:#374151;display:block;margin-bottom:8px">Number of People</label>'
      + '<div style="display:flex;align-items:center;gap:12px">'
      + '<button onclick="changePax(-1)" style="width:34px;height:34px;border-radius:50%;border:2px solid #e5e7eb;background:#fff;font-size:1.1rem;cursor:pointer;font-weight:700">−</button>'
      + '<span id="splitPaxNum" style="font-size:1.5rem;font-weight:800;color:#1a3a2a;min-width:32px;text-align:center">' + _splitPax + '</span>'
      + '<button onclick="changePax(1)" style="width:34px;height:34px;border-radius:50%;border:2px solid #e5e7eb;background:#fff;font-size:1.1rem;cursor:pointer;font-weight:700">+</button>'
      + '</div></div>';

    // Person tabs for filter
    var pTabs = '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">';
    for (var p = 0; p < _splitPax; p++) {
      var pc = _getPersonColor(p);
      pTabs += '<div style="padding:4px 10px;border-radius:20px;font-size:.72rem;font-weight:700;background:' + pc.bg + ';color:' + pc.text + '">Person ' + (p+1) + '</div>';
    }
    pTabs += '</div>';
    html += pTabs;

    // Item assignment list
    html += '<div style="margin-bottom:14px">'
      + '<div style="font-size:.78rem;font-weight:700;color:#374151;margin-bottom:8px">Assign items to people (tap to cycle):</div>';

    items.forEach(function(it, idx) {
      var assigned = _itemAssign[idx];
      var pc = (assigned !== undefined) ? _getPersonColor(assigned) : { bg:'#f3f4f6', text:'#9ca3af' };
      var label = (assigned !== undefined) ? 'Person ' + (assigned+1) : 'Unassigned';
      var lineTotal = parseFloat(it.price || 0) * parseInt(it.qty || 1);
      html += '<div onclick="cycleItemAssign(' + idx + ')" style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border-radius:8px;margin-bottom:5px;cursor:pointer;border:1.5px solid ' + (assigned!==undefined?pc.bg:'#e5e7eb') + ';background:' + pc.bg + '">'
        + '<div style="flex:1">'
        + '<div style="font-size:.82rem;font-weight:600;color:#1a3a2a">' + esc(it.name||'') + (it.size?' ('+esc(it.size)+')':'') + '</div>'
        + '<div style="font-size:.7rem;color:#6b7280">x' + (it.qty||1) + ' · ₱' + lineTotal.toFixed(2) + '</div>'
        + '</div>'
        + '<div style="padding:3px 10px;border-radius:12px;font-size:.7rem;font-weight:700;background:' + (assigned!==undefined?'rgba(255,255,255,.6)':'#e5e7eb') + ';color:' + pc.text + '">' + label + '</div>'
        + '</div>';
    });
    html += '</div>';

    // Per-person totals
    var personTotals = _calcItemSplitTotals(items, svc);
    html += '<div style="background:#f0fdf4;border-radius:12px;padding:14px;margin-bottom:14px">'
      + '<div style="font-weight:700;font-size:.78rem;color:#166534;margin-bottom:8px">Per Person Total:</div>';
    for (var pp = 0; pp < _splitPax; pp++) {
      var ptotal = personTotals[pp] || { subtotal:0, svc:0, total:0 };
      html += '<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #dcfce7;font-size:.83rem">'
        + '<span style="color:#374151">Person ' + (pp+1) + '</span>'
        + '<span style="font-weight:800;color:#1a3a2a">₱' + ptotal.total.toFixed(2) + '</span>'
        + '</div>';
    }
    var unassignedTotal = personTotals['unassigned'] || { total:0 };
    if (unassignedTotal.total > 0) {
      html += '<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:.78rem;color:#DC2626">'
        + '<span>⚠️ Unassigned</span><span>₱' + unassignedTotal.total.toFixed(2) + '</span></div>';
    }
    html += '</div>';

    html += '<button onclick="printItemSplitReceipts()" style="width:100%;padding:12px;background:#1a3a2a;color:#fff;border:none;border-radius:10px;font-weight:700;font-size:.9rem;cursor:pointer;margin-bottom:8px">🖨️ Print Split Receipts</button>';
    html += '<button onclick="printReceipt(_splitOrder&&_splitOrder.orderId)" style="width:100%;padding:11px;background:#f0fdf4;color:#166534;border:1.5px solid #86EFAC;border-radius:10px;font-weight:700;font-size:.85rem;cursor:pointer;margin-bottom:8px">🧾 Print Combined Bill</button>';
    html += '<button onclick="saveSplitBillData()" style="width:100%;padding:11px;background:#f9fafb;color:#374151;border:1.5px solid #e5e7eb;border-radius:10px;font-weight:700;font-size:.85rem;cursor:pointer">💾 Save Split Record</button>';
  }

  html += '</div>'; // end padding div
  content.innerHTML = html;
}

function _getPersonColor(idx) {
  var colors = [
    { bg:'#DBEAFE', text:'#1E40AF' },
    { bg:'#FCE7F3', text:'#9D174D' },
    { bg:'#FEF3C7', text:'#92400E' },
    { bg:'#D1FAE5', text:'#065F46' },
    { bg:'#EDE9FE', text:'#5B21B6' },
    { bg:'#FEE2E2', text:'#991B1B' },
  ];
  return colors[idx % colors.length];
}

function _calcItemSplitTotals(items, totalSvc) {
  var personSubs = {};
  var totalSub = 0;
  items.forEach(function(it, idx) {
    var lineTotal = parseFloat(it.price||0) * parseInt(it.qty||1);
    totalSub += lineTotal;
    var assigned = _itemAssign[idx];
    if (assigned !== undefined) {
      personSubs[assigned] = (personSubs[assigned]||0) + lineTotal;
    } else {
      personSubs['unassigned'] = (personSubs['unassigned']||0) + lineTotal;
    }
  });
  var result = {};
  Object.keys(personSubs).forEach(function(key) {
    var sub = personSubs[key];
    var svcPortion = totalSub > 0 ? (sub / totalSub) * totalSvc : 0;
    result[key] = { subtotal: sub, svc: svcPortion, total: sub + svcPortion };
  });
  return result;
}

function setSplitMode(mode) {
  _splitMode = mode;
  renderSplitBill();
}

function changePax(delta) {
  _splitPax = Math.max(2, Math.min(10, _splitPax + delta));
  // Reset item assignments if pax decreases
  Object.keys(_itemAssign).forEach(function(k) {
    if (_itemAssign[k] >= _splitPax) delete _itemAssign[k];
  });
  renderSplitBill();
}

function cycleItemAssign(idx) {
  var current = _itemAssign[idx];
  if (current === undefined) {
    _itemAssign[idx] = 0;
  } else if (current < _splitPax - 1) {
    _itemAssign[idx] = current + 1;
  } else {
    delete _itemAssign[idx]; // cycle back to unassigned
  }
  renderSplitBill();
}

function printSplitReceipts() {
  if (!_splitOrder) return;
  var o = _splitOrder;
  var total = parseFloat(o.discountedTotal || o.total || 0);
  var svc   = parseFloat(o.serviceCharge || 0);
  var sub   = parseFloat(o.subtotal || 0);
  var perPerson = total / _splitPax;
  var perSvc    = Math.round((svc / _splitPax) * 100) / 100;
  var perSub    = Math.round((sub / _splitPax) * 100) / 100;
  var now = new Date();
  var printDate = now.toLocaleDateString('en-PH',{month:'short',day:'numeric',year:'numeric',timeZone:'Asia/Manila'}) + ' ' + now.toLocaleTimeString('en-PH',{hour:'2-digit',minute:'2-digit',hour12:true,timeZone:'Asia/Manila'});
  var bizName = (window.APP_CONFIG&&window.APP_CONFIG.BUSINESS_NAME)||'YANI Garden Café';

  function receiptStyle() {
    return '<style>*{margin:0;padding:0;box-sizing:border-box}'
      + 'body{font-family:Arial,Helvetica,sans-serif;width:80mm;max-width:80mm;margin:0 auto;padding:0 2mm 8mm 2mm;font-size:11pt;color:#000;line-height:1.35}'
      + '.center{text-align:center}.bold{font-weight:bold}'
      + '.dash{border-top:1px dashed #000;margin:3px 0}'
      + '.row{display:flex;justify-content:space-between;font-size:11pt;margin:1px 0}'
      + '.grand{font-size:16pt;font-weight:bold}'
      + '@media print{@page{size:80mm auto;margin:0}body{padding:0 2mm 8mm 2mm}button{display:none}}'
      + '</style>';
  }

  var allReceipts = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Split Receipts</title>' + receiptStyle() + '</head><body>';
  for (var i = 0; i < _splitPax; i++) {
    var isLast = i === _splitPax - 1;
    allReceipts += '<div style="' + (!isLast ? 'page-break-after:always;' : '') + '">'
      + '<div class="center bold" style="font-size:16pt">' + esc(bizName) + '</div>'
      + '<div class="center" style="font-size:10pt">Amadeo, Cavite · 0967-400-0040</div>'
      + '<div class="dash" style="border-top:2px solid #000;margin:4px 0"></div>'
      + '<div class="center bold" style="font-size:12pt">SPLIT RECEIPT</div>'
      + '<div class="center" style="font-size:11pt">Person ' + (i+1) + ' of ' + _splitPax + '</div>'
      + '<div class="dash"></div>'
      + '<div class="row"><span>Order:</span><span><b>' + esc(o.orderId) + '</b></span></div>'
      + '<div class="row"><span>Table:</span><span>' + (o.tableNo||'-') + '</span></div>'
      + '<div class="row"><span>Date:</span><span>' + printDate + '</span></div>'
      + '<div class="dash"></div>'
      + '<div class="row"><span>Subtotal (your share):</span><span>₱' + perSub.toFixed(2) + '</span></div>'
      + (perSvc > 0 ? '<div class="row"><span>Service Charge:</span><span>₱' + perSvc.toFixed(2) + '</span></div>' : '')
      + '<div class="dash" style="border-top:2px solid #000;margin:3px 0"></div>'
      + '<div class="row grand"><span>YOUR TOTAL:</span><span>₱' + perPerson.toFixed(2) + '</span></div>'
      + '<div class="dash"></div>'
      + '<div class="center" style="margin-top:4px;font-size:10pt">Thank you for dining with us! 🌿</div>'
      + '</div>';
  }
  allReceipts += '</body></html>';

  // Use iframe to avoid popup blockers
  var existingFrame = document.getElementById('receiptPrintFrame');
  if (existingFrame) existingFrame.remove();
  var iframe = document.createElement('iframe');
  iframe.id = 'receiptPrintFrame';
  iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:80mm;height:1px;border:none;visibility:hidden;';
  iframe.onload = function() {
    setTimeout(function() {
      try { iframe.contentWindow.focus(); iframe.contentWindow.print(); }
      catch(e) { var w=window.open('','_blank','width=420,height=700'); if(w){w.document.write(allReceipts);w.document.close();setTimeout(function(){w.print();},500);} }
    }, 400);
  };
  document.body.appendChild(iframe);
  iframe.contentWindow.document.open();
  iframe.contentWindow.document.write(allReceipts);
  iframe.contentWindow.document.close();
}

function printItemSplitReceipts() {
  if (!_splitOrder) return;
  var o = _splitOrder;
  var items = o.items || [];
  var svc   = parseFloat(o.serviceCharge || 0);
  var personTotals = _calcItemSplitTotals(items, svc);
  var now = new Date();
  var printDate = now.toLocaleDateString('en-PH',{month:'short',day:'numeric',year:'numeric',timeZone:'Asia/Manila'}) + ' ' + now.toLocaleTimeString('en-PH',{hour:'2-digit',minute:'2-digit',hour12:true,timeZone:'Asia/Manila'});
  var bizName = (window.APP_CONFIG&&window.APP_CONFIG.BUSINESS_NAME)||'YANI Garden Café';

  var allReceipts = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Split Receipts</title>'
    + '<style>*{margin:0;padding:0;box-sizing:border-box}'
    + 'body{font-family:Arial,Helvetica,sans-serif;width:80mm;max-width:80mm;margin:0 auto;padding:0 2mm 8mm 2mm;font-size:11pt;color:#000;line-height:1.35}'
    + '.center{text-align:center}.bold{font-weight:bold}'
    + '.dash{border-top:1px dashed #000;margin:3px 0}'
    + '.row{display:flex;justify-content:space-between;font-size:11pt;margin:1px 0}'
    + '.grand{font-size:16pt;font-weight:bold}'
    + '@media print{@page{size:80mm auto;margin:0}body{padding:0 2mm 8mm 2mm}button{display:none}}'
    + '</style></head><body>';

  for (var i = 0; i < _splitPax; i++) {
    var myItems = items.filter(function(_, idx) { return _itemAssign[idx] === i; });
    var ptotal  = personTotals[i] || { subtotal:0, svc:0, total:0 };
    var isLast  = i === _splitPax - 1;

    allReceipts += '<div style="' + (!isLast ? 'page-break-after:always;' : '') + '">'
      + '<div class="center bold" style="font-size:16pt">' + esc(bizName) + '</div>'
      + '<div class="center" style="font-size:10pt">Amadeo, Cavite · 0967-400-0040</div>'
      + '<div class="dash" style="border-top:2px solid #000;margin:4px 0"></div>'
      + '<div class="center bold" style="font-size:12pt">SPLIT RECEIPT</div>'
      + '<div class="center" style="font-size:11pt">Person ' + (i+1) + ' of ' + _splitPax + '</div>'
      + '<div class="dash"></div>'
      + '<div class="row"><span>Order:</span><span><b>' + esc(o.orderId) + '</b></span></div>'
      + '<div class="row"><span>Table:</span><span>' + (o.tableNo||'-') + '</span></div>'
      + '<div class="row"><span>Date:</span><span>' + printDate + '</span></div>'
      + '<div class="dash"></div>'
      + '<table style="width:100%;font-size:10pt;border-collapse:collapse">'
      + '<tr><th style="text-align:left;padding-bottom:3px;border-bottom:1px solid #000">Item</th><th style="text-align:center;width:8%">Qty</th><th style="text-align:right;width:22%">Total</th></tr>';

    if (myItems.length === 0) {
      allReceipts += '<tr><td colspan="3" style="font-style:italic;color:#888;padding:4px 0">No items assigned</td></tr>';
    } else {
      myItems.forEach(function(it) {
        var lt = parseFloat(it.price||0) * parseInt(it.qty||1);
        allReceipts += '<tr><td style="padding:2px 0">' + esc(it.name||'') + '</td><td style="text-align:center">' + (it.qty||1) + '</td><td style="text-align:right">₱' + lt.toFixed(2) + '</td></tr>';
      });
    }

    allReceipts += '</table>'
      + '<div class="dash" style="margin-top:3px"></div>'
      + '<div class="row"><span>Subtotal:</span><span>₱' + ptotal.subtotal.toFixed(2) + '</span></div>'
      + (ptotal.svc > 0 ? '<div class="row"><span>Service Charge:</span><span>₱' + ptotal.svc.toFixed(2) + '</span></div>' : '')
      + '<div class="dash" style="border-top:2px solid #000;margin:3px 0"></div>'
      + '<div class="row grand"><span>YOUR TOTAL:</span><span>₱' + ptotal.total.toFixed(2) + '</span></div>'
      + '<div class="dash"></div>'
      + '<div class="center" style="margin-top:4px;font-size:10pt">Thank you for dining with us! 🌿</div>'
      + '</div>';
  }
  allReceipts += '</body></html>';

  var existingFrame = document.getElementById('receiptPrintFrame');
  if (existingFrame) existingFrame.remove();
  var iframe = document.createElement('iframe');
  iframe.id = 'receiptPrintFrame';
  iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:80mm;height:1px;border:none;visibility:hidden;';
  iframe.onload = function() {
    setTimeout(function() {
      try { iframe.contentWindow.focus(); iframe.contentWindow.print(); }
      catch(e) { var w=window.open('','_blank','width=420,height=700'); if(w){w.document.write(allReceipts);w.document.close();setTimeout(function(){w.print();},500);} }
    }, 400);
  };
  document.body.appendChild(iframe);
  iframe.contentWindow.document.open();
  iframe.contentWindow.document.write(allReceipts);
  iframe.contentWindow.document.close();
}

async function saveSplitBillData() {
  if (!_splitOrder) return;
  var o = _splitOrder;
  var total = parseFloat(o.discountedTotal || o.total || 0);
  var svc   = parseFloat(o.serviceCharge || 0);
  var sub   = parseFloat(o.subtotal || 0);
  var items = o.items || [];
  var splits = [];

  if (_splitMode === 'EQUAL') {
    var perPerson = total / _splitPax;
    for (var i = 0; i < _splitPax; i++) {
      splits.push({ label: 'Person ' + (i+1), subtotal: sub/_splitPax, svc: svc/_splitPax, total: perPerson });
    }
  } else {
    var personTotals = _calcItemSplitTotals(items, svc);
    for (var pp = 0; pp < _splitPax; pp++) {
      var myItems = items.filter(function(_, idx) { return _itemAssign[idx] === pp; });
      var pt = personTotals[pp] || { subtotal:0, svc:0, total:0 };
      splits.push({ label: 'Person ' + (pp+1), items: myItems.map(function(it){ return it.name; }), subtotal: pt.subtotal, svc: pt.svc, total: pt.total });
    }
  }

  var splitData = { type: _splitMode, pax: _splitPax, splits: splits, savedAt: new Date().toISOString() };
  var r = await api('saveSplitBill', { userId: currentUser && currentUser.userId, orderId: o.orderId, splitData: splitData });
  if (r.ok) {
    showToast('✅ Split record saved for ' + o.orderId);
    closeSplitBill();
  } else {
    showToast('❌ ' + (r.error||'Failed to save'), 'error');
  }
}
