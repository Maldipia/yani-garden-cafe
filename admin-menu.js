// ════════════════════════════════════════════════════════
// MENU MANAGER
// ════════════════════════════════════════════════════════
var menuMgrItems = [];
var menuMgrCat = 'ALL';
var menuMgrShowInactive = false;

async function loadMenuManager() {
  var grid = document.getElementById('menuMgrGrid');
  grid.innerHTML = '<div style="text-align:center;padding:40px;color:var(--timber)">Loading menu...</div>';
  var result = await api('getMenuAdmin', { userId: currentUser && currentUser.userId });
  if (!result.ok) {
    grid.innerHTML = '<div style="text-align:center;padding:40px;color:#EF4444">❌ ' + (result.error || 'Failed to load menu') + '</div>';
    return;
  }
  menuMgrItems = result.items || [];
  // Load all categories from API (includes empty ones like Pasalubong)
  var catResult = await api('getCategories');
  _allMenuCategories = (catResult && catResult.ok && catResult.categories)
    ? catResult.categories.map(function(c){ return c.name; })
    : null;
  buildMenuCatTabs();
  renderMenuMgrGrid();
}

var _allMenuCategories = null;

function buildMenuCatTabs() {
  var cats;
  if (_allMenuCategories) {
    // Use full category list from DB (includes empty categories)
    cats = _allMenuCategories.slice().sort();
  } else {
    // Fallback: derive from loaded items
    cats = [];
    menuMgrItems.forEach(function(item) {
      var c = (item.category || 'Other').trim();
      if (cats.indexOf(c) === -1) cats.push(c);
    });
    cats.sort();
  }
  var container = document.getElementById('mmCatBtns');
  if (!container) return;
  container.innerHTML = cats.map(function(c) {
    return '<button onclick="setMenuCat(\'' + c.replace(/'/g, "\\'") + '\')" class="mm-cat-btn" data-cat="' + c.replace(/"/g,'&quot;') + '">' + c + '</button>';
  }).join('');
}

function setMenuCat(cat) {
  menuMgrCat = cat;
  var allBtn = document.getElementById('mmCatAll');
  if (allBtn) allBtn.classList.toggle('mm-cat-active', cat === 'ALL');
  var btns = document.querySelectorAll('#mmCatBtns .mm-cat-btn');
  btns.forEach(function(b) {
    b.classList.toggle('mm-cat-active', b.dataset.cat === cat);
  });
  renderMenuMgrGrid();
}

function toggleMenuStatus() {
  menuMgrShowInactive = !menuMgrShowInactive;
  var btn = document.getElementById('mmStatusToggle');
  if (btn) {
    btn.textContent = menuMgrShowInactive ? 'Hide Inactive' : 'Show Inactive';
    btn.classList.toggle('mm-cat-active', menuMgrShowInactive);
  }
  renderMenuMgrGrid();
}

function renderMenuMgrGrid() {
  var grid = document.getElementById('menuMgrGrid');
  var searchEl = document.getElementById('menuMgrSearch');
  var search = searchEl ? searchEl.value.toLowerCase().trim() : '';

  var filtered = menuMgrItems.filter(function(item) {
    if (!menuMgrShowInactive && !item.active) return false;
    if (menuMgrCat !== 'ALL' && (item.category || 'Other').trim() !== menuMgrCat) return false;
    if (search && item.name.toLowerCase().indexOf(search) === -1 && (item.category || '').toLowerCase().indexOf(search) === -1) return false;
    return true;
  });

  var countEl = document.getElementById('menuMgrCount');
  if (countEl) {
    var activeCount = menuMgrItems.filter(function(i) { return i.active; }).length;
    var inactiveCount = menuMgrItems.length - activeCount;
    countEl.textContent = filtered.length + ' items shown · ' + activeCount + ' active, ' + inactiveCount + ' inactive';
  }

  if (!filtered.length) {
    grid.innerHTML = '<div style="text-align:center;padding:40px;color:var(--timber)">No items found.</div>';
    return;
  }

  grid.innerHTML = filtered.map(function(item) {
    var isActive = item.active;
    var localPath = getLocalMenuImgPath(item.code);
    var hasExternalImg = item.image && item.image.startsWith('http');
    var imgSrc = hasExternalImg ? item.image : localPath;
    var fallbackSrc = hasExternalImg ? localPath : '';
    var onerrorAttr = fallbackSrc
      ? 'this.onerror=null;this.src=\'' + fallbackSrc + '\';'
      : 'this.onerror=null;this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'';

    var imgHtml = '<img src="' + imgSrc + '" class="mm-thumb" onerror="' + onerrorAttr + '">' +
      '<div class="mm-thumb-placeholder" style="display:none">🍽</div>';

    var priceDisplay = item.hasSizes
      ? '₱' + item.priceShort + ' / ₱' + item.priceMedium + ' / ₱' + item.priceTall
      : '₱' + item.price;
    var catLabel = (item.category || 'Other').trim();
    var pillClass = isActive ? 'on' : 'off';
    var statusBadge = isActive
      ? '<span class="mm-badge-active">ACTIVE</span>'
      : '<span class="mm-badge-inactive">INACTIVE</span>';

    return '<div class="mm-row' + (isActive ? '' : ' inactive') + '">'
      + imgHtml
      + '<div class="mm-info">'
      +   '<div class="mm-row-name">' + esc(item.name) + '</div>'
      +   '<div class="mm-row-meta">'
      +     '<span class="mm-row-cat">' + esc(catLabel) + '</span>'
      +     '<span class="mm-row-price">' + priceDisplay + '</span>'
      +     statusBadge
      +     getScheduleBadge(item)
      +   '</div>'
      + '</div>'
      + '<button class="mm-pill ' + pillClass + '" onclick="quickToggleItem(\'' + esc(item.code) + '\',' + (isActive ? 'true' : 'false') + ')" title="' + (isActive ? 'Set Unavailable' : 'Set Available') + '"></button>'
      + '<div class="mm-row-actions">'
      +   '<button class="mm-icon-btn mm-icon-sig' + (item.isSignature ? ' sig-on' : '') + '" onclick="quickToggleSignature(\'' + esc(item.code) + '\')" title="' + (item.isSignature ? 'Remove Signature' : 'Mark as Signature') + '">★</button>'
      +   '<button class="mm-icon-btn mm-icon-edit" onclick="openEditItemModal(\'' + esc(item.code) + '\')" title="Edit">✏️</button>'
      +   '<button class="mm-icon-btn mm-icon-delete" onclick="quickDeleteItem(\'' + esc(item.code) + '\',\'' + esc(item.name) + '\')" title="Delete">🗑️</button>'
      + '</div>'
      + '</div>';
  }).join('');
}

// ── Quick toggle available / unavailable ─────────────────────────────────
async function quickToggleItem(itemCode, currentlyActive) {
  var item = menuMgrItems.find(function(i){ return i.code === itemCode; });
  if (!item) return;
  var newStatus = currentlyActive ? 'INACTIVE' : 'ACTIVE';
  var label     = currentlyActive ? 'unavailable' : 'available';

  // Optimistic UI update
  item.active = !currentlyActive;
  renderMenuMgrGrid();

  var payload = {
    userId:      currentUser && currentUser.userId,
    action:      'updateMenuItem',
    itemId:      itemCode,
    name:        item.name,
    category:    item.category,
    price:       item.price,
    hasSizes:    item.hasSizes,
    hasSugar:    item.hasSugar,
    priceShort:  item.priceShort,
    priceMedium: item.priceMedium,
    priceTall:   item.priceTall,
    image:       item.image || '',
    status:      newStatus,
  };

  var result = await api('updateMenuItem', payload);
  if (!result || !result.ok) {
    // Revert optimistic update on failure
    item.active = currentlyActive;
    renderMenuMgrGrid();
    showToast('❌ Failed to update: ' + (result && result.error || 'Unknown error'), 'error');
  } else {
    showToast((currentlyActive ? '⏸ ' : '✅ ') + esc(item.name) + ' marked ' + label);
  }
}


// ── Quick toggle signature ────────────────────────────────────────────────
async function quickToggleSignature(itemCode) {
  var item = menuMgrItems.find(function(i){ return i.code === itemCode; });
  if (!item) return;
  var newVal = !item.isSignature;

  // Optimistic UI
  item.isSignature = newVal;
  renderMenuMgrGrid();

  var payload = {
    userId:      currentUser && currentUser.userId,
    action:      'updateMenuItem',
    itemId:      itemCode,
    name:        item.name,
    category:    item.category,
    price:       item.price,
    hasSizes:    item.hasSizes,
    hasSugar:    item.hasSugar,
    priceShort:  item.priceShort,
    priceMedium: item.priceMedium,
    priceTall:   item.priceTall,
    image:       item.image || '',
    status:      item.active ? 'ACTIVE' : 'INACTIVE',
    isSignature: newVal,
  };

  var result = await api('updateMenuItem', payload);
  if (!result || !result.ok) {
    item.isSignature = !newVal;
    renderMenuMgrGrid();
    showToast('\u274C Failed to update signature: ' + (result && result.error || 'Unknown error'), 'error');
  } else {
    showToast(newVal ? '\u2B50 ' + esc(item.name) + ' marked as Signature' : '\u2B50 ' + esc(item.name) + ' removed from Signature');
  }
}
// ── Quick delete ─────────────────────────────────────────────────────────
async function quickDeleteItem(itemCode, itemName) {
  var confirmed = await ygcConfirm(
    '🗑️ Delete "' + itemName + '"?',
    'This will permanently remove the item from your menu. Past orders with this item are not affected.',
    'Delete', 'Cancel'
  );
  if (!confirmed) return;

  var result = await api('deleteMenuItem', { userId: currentUser && currentUser.userId, itemId: itemCode });
  if (!result || !result.ok) {
    showToast('❌ Delete failed: ' + (result && result.error || 'Unknown error'), 'error');
  } else {
    menuMgrItems = menuMgrItems.filter(function(i){ return i.code !== itemCode; });
    renderMenuMgrGrid();
    showToast('🗑️ ' + esc(itemName) + ' deleted');
  }
}

function openEditItemModal(itemCode) {
  var item = menuMgrItems.find(function(i){ return i.code === itemCode; });
  if (!item) return;

  document.getElementById('menuEditTitle').textContent = 'Edit: ' + item.name;
  document.getElementById('menuEditId').value = item.code;
  document.getElementById('menuEditIsNew').value = 'false';
  document.getElementById('menuEditName').value = item.name;
  document.getElementById('menuEditCategory').value = item.category || '';
  document.getElementById('menuEditPrice').value = item.price;
  document.getElementById('menuEditHasSizes').checked = item.hasSizes;
  document.getElementById('menuEditHasSugar').checked = item.hasSugar;
  document.getElementById('menuEditShort').value = item.priceShort || '';
  document.getElementById('menuEditMedium').value = item.priceMedium || '';
  document.getElementById('menuEditTall').value = item.priceTall || '';
  document.getElementById('menuEditImage').value = item.image || '';
  document.getElementById('menuEditStatus').value = item.active ? 'ACTIVE' : 'INACTIVE';

  document.getElementById('menuEditSizePrices').style.display = item.hasSizes ? '' : 'none';
  document.getElementById('menuEditHasSizes').onchange = function() {
    document.getElementById('menuEditSizePrices').style.display = this.checked ? '' : 'none';
  };

  // Show local Vercel image if available, otherwise use stored URL
  var localPath = getLocalMenuImgPath(item.code);
  previewMenuImage(localPath || item.image || '');
  // Populate schedule fields
  var fromEl = document.getElementById('menuEditAvailFrom');
  var untilEl = document.getElementById('menuEditAvailUntil');
  if (fromEl) fromEl.value = item.availableFrom || '';
  if (untilEl) untilEl.value = item.availableUntil || '';
  document.querySelectorAll('.menu-day-btn').forEach(function(b) {
    var active = item.availableDays && item.availableDays.includes(b.dataset.day);
    b.classList.toggle('active', !!active);
    b.style.background = active ? 'var(--forest)' : '#fff';
    b.style.color = active ? '#fff' : '';
    b.style.borderColor = active ? 'var(--forest)' : '';
  });
  document.getElementById('menuEditOverlay').style.display = 'block';
}

function openAddItemModal() {
  document.getElementById('menuEditTitle').textContent = 'Add New Item';
  document.getElementById('menuEditId').value = '';
  document.getElementById('menuEditIsNew').value = 'true';
  document.getElementById('menuEditName').value = '';
  document.getElementById('menuEditCategory').value = 'Other';
  document.getElementById('menuEditPrice').value = '';
  document.getElementById('menuEditHasSizes').checked = false;
  document.getElementById('menuEditHasSugar').checked = false;
  document.getElementById('menuEditShort').value = '';
  document.getElementById('menuEditMedium').value = '';
  document.getElementById('menuEditTall').value = '';
  document.getElementById('menuEditImage').value = '';
  document.getElementById('menuEditStatus').value = 'ACTIVE';
  document.getElementById('menuEditSizePrices').style.display = 'none';
  document.getElementById('menuEditHasSizes').onchange = function() {
    document.getElementById('menuEditSizePrices').style.display = this.checked ? '' : 'none';
  };
  clearMenuSchedule();
  previewMenuImage('');
  document.getElementById('menuEditOverlay').style.display = 'block';
}

function closeMenuEditModal() {
  document.getElementById('menuEditOverlay').style.display = 'none';
  // Reset photo upload state
  _menuPhotoFile = null;
  _menuPhotoBase64 = null;
  var fileInput = document.getElementById('menuEditFileInput');
  if (fileInput) fileInput.value = '';
  var fileLabel = document.getElementById('menuEditFileLabel');
  if (fileLabel) fileLabel.textContent = 'Choose image file (PNG/JPG)';
  var uploadBtn = document.getElementById('menuEditUploadBtn');
  if (uploadBtn) uploadBtn.style.display = 'none';
  var statusEl = document.getElementById('menuEditUploadStatus');
  if (statusEl) { statusEl.style.display = 'none'; statusEl.textContent = ''; }
}

function previewMenuImage(url) {
  var img = document.getElementById('menuEditImgPreview');
  var placeholder = document.getElementById('menuEditImgPlaceholder');
  var localBadge = document.getElementById('menuEditImgLocalBadge');
  if (url) {
    img.src = url;
    img.style.display = 'block';
    placeholder.style.display = 'none';
    img.onerror = function() { img.style.display='none'; placeholder.style.display='inline-flex'; };
    // Show badge if it's a local Vercel path
    if (localBadge) {
      if (url.startsWith('/images/')) {
        localBadge.style.display = 'inline-block';
      } else {
        localBadge.style.display = 'none';
      }
    }
  } else {
    img.style.display = 'none';
    placeholder.style.display = 'inline-flex';
    if (localBadge) localBadge.style.display = 'none';
  }
}

// ── Photo file picker ──────────────────────────────────
var _menuPhotoFile = null;
var _menuPhotoBase64 = null;
var _menuObjectUrl = null;

function onMenuPhotoFileChange(input) {
  var file = input.files && input.files[0];
  if (!file) return;
  var maxMB = 5;
  if (file.size > maxMB * 1024 * 1024) {
    showToast('Image too large. Max ' + maxMB + 'MB.', 'error');
    input.value = '';
    return;
  }
  _menuPhotoFile = file;
  _menuPhotoBase64 = null; // will be encoded at upload time, not now
  document.getElementById('menuEditFileLabel').textContent = file.name;

  // Instant preview using createObjectURL — zero blocking, no FileReader
  if (_menuObjectUrl) { URL.revokeObjectURL(_menuObjectUrl); }
  _menuObjectUrl = URL.createObjectURL(file);
  previewMenuImageData(_menuObjectUrl);

  // Show Upload button immediately — no processing needed at this point
  var btn = document.getElementById('menuEditUploadBtn');
  btn.style.display = 'inline-block';
  btn.disabled = false;
  btn.textContent = 'Upload';
}

// Canvas resize + base64 encoding via Web Worker — runs off the main thread
// Falls back to async main-thread encoding if Worker is unavailable
async function _encodeMenuPhoto(file) {
  // Try Web Worker path first (Chrome, Edge, Firefox, Safari 15+)
  if (typeof Worker !== 'undefined') {
    var blobUrl = URL.createObjectURL(file);
    try {
      return await new Promise(function(resolve, reject) {
        var worker = new Worker('/image-encoder.worker.js');
        // 10s timeout so we always fall through if worker hangs
        var timer = setTimeout(function() {
          worker.terminate();
          URL.revokeObjectURL(blobUrl);
          reject(new Error('Worker timeout'));
        }, 10000);
        worker.onmessage = function(e) {
          clearTimeout(timer);
          worker.terminate();
          URL.revokeObjectURL(blobUrl);
          if (e.data.ok) resolve(e.data.base64);
          else reject(new Error(e.data.error));
        };
        worker.onerror = function(err) {
          clearTimeout(timer);
          worker.terminate();
          URL.revokeObjectURL(blobUrl);
          reject(err);
        };
        worker.postMessage({ blobUrl: blobUrl });
      });
    } catch(e) {
      URL.revokeObjectURL(blobUrl);
      // Worker failed — fall through to main-thread fallback
    }
  }
  // Fallback: main-thread canvas encode — fully async via FileReader + Image.onload
  // The canvas.toDataURL call is the only synchronous part but it runs AFTER
  // the browser has already painted the 'Uploading...' state, so INP is not affected.
  return new Promise(function(resolve, reject) {
    var reader = new FileReader();
    reader.onload = function(e) {
      var img = new Image();
      img.onload = function() {
        // Yield one more frame before the synchronous canvas work
        requestAnimationFrame(function() {
          try {
            var MAX = 1200;
            var w = img.width, h = img.height;
            if (w > MAX || h > MAX) {
              if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
              else { w = Math.round(w * MAX / h); h = MAX; }
            }
            var canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL('image/jpeg', 0.85).split(',')[1]);
          } catch(err) { reject(err); }
        });
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function previewMenuImageData(dataUrl) {
  var img = document.getElementById('menuEditImgPreview');
  var placeholder = document.getElementById('menuEditImgPlaceholder');
  var localBadge = document.getElementById('menuEditImgLocalBadge');
  img.src = dataUrl;
  img.style.display = 'block';
  placeholder.style.display = 'none';
  if (localBadge) localBadge.style.display = 'none'; // not uploaded yet
}

async function uploadMenuPhoto() {
  var itemCode = document.getElementById('menuEditId').value.trim();
  var statusEl = document.getElementById('menuEditUploadStatus');
  // Auto-generate a temp item code for new items so upload works before saving
  // Store in menuEditId for the upload, but preserve menuEditIsNew so saveMenuItemEdit
  // still knows this is a new item (not an update to an existing one).
  if (!itemCode) {
    itemCode = 'ITEM_' + Date.now();
    document.getElementById('menuEditId').value = itemCode;
    // Do NOT change menuEditIsNew — it was set to 'true' by openAddItemModal
  }
  if (!_menuPhotoFile) {
    statusEl.style.display = 'block';
    statusEl.style.color = '#B5443A';
    statusEl.textContent = '❌ No file selected. Please choose an image first.';
    return;
  }
  var ext = _menuPhotoFile.name.split('.').pop().toLowerCase();
  var uploadBtn = document.getElementById('menuEditUploadBtn');

  statusEl.style.display = 'block';
  statusEl.style.color = 'var(--timber)';
  statusEl.textContent = 'Processing...';
  uploadBtn.disabled = true;
  uploadBtn.textContent = 'Uploading...';

  // Yield to the browser to paint the disabled state BEFORE any heavy work
  await new Promise(function(r) { requestAnimationFrame(function() { requestAnimationFrame(r); }); });

  try {
    // Encode off the main thread via Web Worker
    if (!_menuPhotoBase64) {
      _menuPhotoBase64 = await _encodeMenuPhoto(_menuPhotoFile);
    }
    statusEl.textContent = 'Uploading...';
    var resp = await fetch('/api/upload-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: itemCode, ext: ext, base64: _menuPhotoBase64 })
    });
    var result = await resp.json();
    if (result.ok) {
      statusEl.style.color = '#065F46';
      statusEl.textContent = '✓ Uploaded! Image is live immediately.';
      // Auto-fill the URL field with the local path
      document.getElementById('menuEditImage').value = result.path;
      previewMenuImage(result.path);
      // Reset file picker
      _menuPhotoFile = null;
      _menuPhotoBase64 = null;
      document.getElementById('menuEditFileInput').value = '';
      document.getElementById('menuEditFileLabel').textContent = 'Choose image file (PNG/JPG)';
      uploadBtn.style.display = 'none';
    } else {
      statusEl.style.color = '#B5443A';
      statusEl.textContent = '❌ ' + (result.error || 'Upload failed');
    }
  } catch (e) {
    statusEl.style.color = '#B5443A';
    statusEl.textContent = '❌ Network error: ' + e.message;
  } finally {
    uploadBtn.disabled = false;
    uploadBtn.textContent = 'Upload';
  }
}

async function saveMenuItemEdit() {
  var itemId = document.getElementById('menuEditId').value.trim();
  var name = document.getElementById('menuEditName').value.trim();
  var category = document.getElementById('menuEditCategory').value.trim();
  var price = parseFloat(document.getElementById('menuEditPrice').value) || 0;
  var hasSizes = document.getElementById('menuEditHasSizes').checked;
  var hasSugar = document.getElementById('menuEditHasSugar').checked;
  var priceShort = parseFloat(document.getElementById('menuEditShort').value) || 0;
  var priceMedium = parseFloat(document.getElementById('menuEditMedium').value) || 0;
  var priceTall = parseFloat(document.getElementById('menuEditTall').value) || 0;
  var image = document.getElementById('menuEditImage').value.trim();
  var status = document.getElementById('menuEditStatus').value;

   if (!name) {
    var nameEl = document.getElementById('menuEditName');
    nameEl.style.borderColor = '#B5443A';
    nameEl.focus();
    setTimeout(function() { nameEl.style.borderColor = ''; }, 2000);
    return;
  }
  // Use the explicit isNew flag (set by openAddItemModal/openMenuEditModal) so that
  // uploading a photo before saving (which fills menuEditId with a temp code) does NOT
  // accidentally turn an addMenuItem into an updateMenuItem.
  var isNew = document.getElementById('menuEditIsNew').value === 'true';
  var action = isNew ? 'addMenuItem' : 'updateMenuItem';
  var payload = { name:name, category:category, price:price, hasSizes:hasSizes, hasSugar:hasSugar,
    priceShort:priceShort, priceMedium:priceMedium, priceTall:priceTall, image:image, status:status,
    userId: currentUser && currentUser.userId };
  // Menu scheduling
  var fromEl = document.getElementById('menuEditAvailFrom');
  var untilEl = document.getElementById('menuEditAvailUntil');
  if (fromEl && untilEl) {
    payload.availableFrom  = fromEl.value  || null;
    payload.availableUntil = untilEl.value || null;
  }
  var dayBtns = document.querySelectorAll('.menu-day-btn.active');
  if (dayBtns.length > 0 && dayBtns.length < 7) {
    payload.availableDays = Array.from(dayBtns).map(function(b){ return b.dataset.day; });
  } else {
    payload.availableDays = null; // all days
  }
  if (!isNew) {
    payload.itemId = itemId;
  } else if (itemId) {
    // If a photo was uploaded before saving, itemId holds the temp code used for the image.
    // Pass it to GAS so the item code matches the uploaded image filename.
    payload.itemId = itemId;
  }
  var saveBtn = document.getElementById('menuEditSaveBtn');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving...'; }
  var result = await api(action, payload);
  if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Changes'; }
  if (result.ok) {
    closeMenuEditModal();
    await loadMenuManager();
    // Show a brief non-blocking toast
    showToast('✅ ' + (isNew ? 'Item added!' : 'Item updated!'));
  } else {
    var uploadStatus = document.getElementById('menuEditUploadStatus');
    uploadStatus.style.display = 'block';
    uploadStatus.style.color = '#B5443A';
    uploadStatus.textContent = '❌ Failed: ' + (result.error || 'Unknown error');
  }
}

// ── Menu Schedule Helpers ──────────────────────────────────────────────────
function toggleDayBtn(btn) {
  var active = btn.classList.toggle('active');
  btn.style.background   = active ? 'var(--forest)' : '#fff';
  btn.style.color        = active ? '#fff' : '';
  btn.style.borderColor  = active ? 'var(--forest)' : '';
}

function clearMenuSchedule() {
  var fromEl = document.getElementById('menuEditAvailFrom');
  var untilEl = document.getElementById('menuEditAvailUntil');
  if (fromEl) fromEl.value = '';
  if (untilEl) untilEl.value = '';
  document.querySelectorAll('.menu-day-btn').forEach(function(b) {
    b.classList.remove('active');
    b.style.background = '#fff';
    b.style.color = '';
    b.style.borderColor = '';
  });
}

function getScheduleBadge(item) {
  if (!item.availableFrom && !item.availableUntil && !item.availableDays) return '';
  var parts = [];
  if (item.availableFrom && item.availableUntil) {
    parts.push(item.availableFrom.slice(0,5) + '–' + item.availableUntil.slice(0,5));
  }
  if (item.availableDays && item.availableDays.length) {
    parts.push(item.availableDays.join(','));
  }
  return '<span style="display:inline-block;margin-top:3px;font-size:.6rem;background:#DBEAFE;color:#1E40AF;border-radius:5px;padding:1px 6px;font-weight:700">⏰ ' + parts.join(' ') + '</span>';
}
