// ══════════════════════════════════════════════════════════

// Cache of tables from DB (so we don't re-fetch every render)
var _allTables = [];

var _activeTableTab = 'qr'; // qr | status | reservations

function switchTableTab(tab) {
  _activeTableTab = tab;
  document.getElementById('tableQrTab').style.display = tab === 'qr' ? '' : 'none';
  document.getElementById('tableStatusTab').style.display = tab === 'status' ? '' : 'none';
  document.getElementById('tableResTab').style.display = tab === 'reservations' ? '' : 'none';
  // Update button styles
  var tabBtnIds = { qr: 'tabQrBtn', status: 'tabStatusBtn', reservations: 'tabResBtn' };
  ['qr','status','reservations'].forEach(function(t) {
    var btn = document.getElementById(tabBtnIds[t]);
    if (!btn) return;
    if (t === tab) {
      btn.style.background = 'var(--forest)'; btn.style.color = '#fff'; btn.style.borderColor = 'var(--forest)';
    } else {
      btn.style.background = '#f8fafc'; btn.style.color = '#475569'; btn.style.borderColor = '#e2e8f0';
    }
  });
  if (tab === 'reservations') loadReservationsTab();
  if (tab === 'status') renderTableGrid([]);
}

async function loadTablesView() {
  if (!currentUser.userId) return;

  // Show "Add Table" button for OWNER/ADMIN
  var addBtn = document.getElementById('addTableBtn');
  if (addBtn) addBtn.style.display = (currentUser.role === 'OWNER' || currentUser.role === 'ADMIN') ? '' : 'none';

  // Load tables from DB
  var tr = await api('getTables', { userId: currentUser.userId });
  if (tr.ok) _allTables = tr.tables || [];

  // Update badge
  var badge = document.getElementById('tblTotalBadge');
  if (badge) badge.textContent = _allTables.length + ' tables';

  // Default to QR tab
  switchTableTab(_activeTableTab || 'qr');
  renderQrGrid();
  if (_activeTableTab === 'status') renderTableGrid([]);
}

function getTableOrderUrl(tbl) {
  // Customer-facing ordering page URL
  var base = window.location.origin;
  return base + '/index.html?table=' + tbl.table_number + '&token=' + tbl.qr_token;
}

function renderQrGrid() {
  var grid = document.getElementById('tableQrGrid');
  if (!grid) return;
  var isAdmin = currentUser.role === 'OWNER' || currentUser.role === 'ADMIN';

  grid.innerHTML = _allTables.map(function(tbl) {
    var orderUrl = getTableOrderUrl(tbl);
    var qrImgUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(orderUrl);
    var name = esc(tbl.table_name || ('Table ' + tbl.table_number));
    var seats = tbl.capacity || 4;
    var shortUrl = orderUrl.replace('https://','').replace('http://','');
    if (shortUrl.length > 42) shortUrl = shortUrl.slice(0,42) + '…';

    return '<div style="background:#fff;border:1.5px solid #e8edf2;border-radius:16px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.06);transition:box-shadow .15s" onmouseover="this.style.boxShadow=\'0 4px 16px rgba(0,0,0,.12)\'" onmouseout="this.style.boxShadow=\'0 1px 4px rgba(0,0,0,.06)\'">' +
      // QR Image + print hint
      '<div style="padding:16px 16px 8px;text-align:center;position:relative">' +
        (isAdmin ? '<div style="position:absolute;top:10px;right:10px;display:flex;gap:4px">' +
          '<button onclick="openEditTableModal(' + tbl.table_number + ')" title="Edit" style="background:#f1f5f9;border:none;border-radius:7px;width:28px;height:28px;cursor:pointer;font-size:.85rem;display:flex;align-items:center;justify-content:center">✏️</button>' +
          '<button onclick="confirmDeleteTable(' + tbl.table_number + ')" title="Delete" style="background:#fff1f2;border:none;border-radius:7px;width:28px;height:28px;cursor:pointer;font-size:.85rem;display:flex;align-items:center;justify-content:center">🗑️</button>' +
        '</div>' : '') +
        '<img src="' + qrImgUrl + '" style="width:160px;height:160px;border-radius:8px;cursor:pointer" ' +
          'onclick="printSingleQR(' + tbl.table_number + ')" ' +
          'title="Click to print" loading="lazy">' +
        '<div style="font-size:.7rem;color:#94a3b8;margin-top:5px">🖨️ Click to print</div>' +
      '</div>' +
      // Table info
      '<div style="padding:0 14px 14px">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">' +
          '<div style="font-weight:800;font-size:1rem;color:#0f172a">' + name + '</div>' +
        '</div>' +
        '<div style="font-size:.75rem;color:#64748b;margin-bottom:8px">👥 ' + seats + ' seats</div>' +
        '<div style="font-size:.68rem;color:#94a3b8;word-break:break-all;margin-bottom:10px;background:#f8fafc;border-radius:6px;padding:5px 7px">' + shortUrl + '</div>' +
        // Buttons
        '<div style="display:flex;gap:6px;margin-bottom:6px">' +
          '<button onclick="printSingleQR(' + tbl.table_number + ')" style="flex:1;background:#fff;color:#16a34a;border:1.5px solid #86efac;border-radius:8px;padding:7px 0;font-size:.78rem;font-weight:700;cursor:pointer">🖨️ Print</button>' +
          '<button onclick="downloadQR(' + tbl.table_number + ',\'' + name + '\')" style="flex:1;background:#fff;color:#16a34a;border:1.5px solid #86efac;border-radius:8px;padding:7px 0;font-size:.78rem;font-weight:700;cursor:pointer">⬇️ Download</button>' +
        '</div>' +
        '<a href="' + orderUrl + '" target="_blank" style="display:block;text-align:center;background:#f8fafc;color:#475569;border:1.5px solid #e2e8f0;border-radius:8px;padding:7px;font-size:.75rem;font-weight:600;text-decoration:none">🔗 Preview Order Page</a>' +
      '</div>' +
    '</div>';
  }).join('');
}

function printSingleQR(tableNo) {
  var tbl = _allTables.find(function(t){ return t.table_number === tableNo; });
  if (!tbl) return;
  var name = tbl.table_name || ('Table ' + tableNo);
  var orderUrl = getTableOrderUrl(tbl);
  var qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=' + encodeURIComponent(orderUrl);
  var w = window.open('','_blank','width=520,height=640');
  w.document.write('<html><head><title>QR – ' + name + '</title><style>body{font-family:sans-serif;text-align:center;padding:32px}h1{font-size:1.6rem;margin-bottom:4px}p{color:#666;margin:4px 0;font-size:.9rem}img{margin:16px auto;display:block}@media print{button{display:none}}</style></head><body>' +
    '<h1>' + name + '</h1>' +
    '<p>Scan to order</p>' +
    '<img src="' + qrUrl + '" width="300" height="300">' +
    '<p style="font-size:.72rem;color:#aaa;margin-top:16px;word-break:break-all">' + orderUrl + '</p>' +
    '<br><button onclick="window.print()" style="padding:10px 24px;background:#16a34a;color:#fff;border:none;border-radius:8px;font-size:1rem;cursor:pointer">🖨️ Print</button>' +
  '</body></html>');
  w.document.close();
}

function downloadQR(tableNo, name) {
  var tbl = _allTables.find(function(t){ return t.table_number === tableNo; });
  if (!tbl) return;
  var orderUrl = getTableOrderUrl(tbl);
  var qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=600x600&format=png&data=' + encodeURIComponent(orderUrl);
  var a = document.createElement('a');
  a.href = qrUrl;
  a.download = (name || 'table-' + tableNo) + '-qr.png';
  a.target = '_blank';
  a.click();
}

function printAllQR() {
  var html = '<html><head><title>All Table QR Codes</title><style>' +
    'body{font-family:sans-serif;padding:20px}' +
    '.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:24px}' +
    '.card{text-align:center;border:1px solid #e2e8f0;border-radius:12px;padding:16px;break-inside:avoid}' +
    'h2{margin:8px 0 2px;font-size:1.1rem}p{color:#888;font-size:.75rem;margin:2px 0}' +
    '@media print{button{display:none}}' +
  '</style></head><body>' +
    '<div style="text-align:right;margin-bottom:16px"><button onclick="window.print()" style="padding:8px 20px;background:#16a34a;color:#fff;border:none;border-radius:8px;font-size:.9rem;cursor:pointer">🖨️ Print All</button></div>' +
    '<div class="grid">';
  _allTables.forEach(function(tbl) {
    var orderUrl = getTableOrderUrl(tbl);
    var qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(orderUrl);
    var name = tbl.table_name || ('Table ' + tbl.table_number);
    html += '<div class="card"><img src="' + qrUrl + '" width="200" height="200"><h2>' + name + '</h2><p>👥 ' + (tbl.capacity||4) + ' seats</p></div>';
  });
  html += '</div></body></html>';
  var w = window.open('','_blank','width=900,height=700');
  w.document.write(html);
  w.document.close();
}

function openEditTableModal(tableNo) {
  var tbl = _allTables.find(function(t){ return t.table_number === tableNo; });
  if (!tbl) return;
  var html = '<div id="editTableModal" style="position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:700;display:flex;align-items:center;justify-content:center;padding:20px">' +
    '<div style="background:#fff;border-radius:16px;width:100%;max-width:360px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.3)">' +
      '<div style="background:var(--forest-deep);color:#fff;padding:16px 20px;display:flex;align-items:center;justify-content:space-between">' +
        '<div style="font-weight:700;font-size:1rem">✏️ Edit Table ' + tableNo + '</div>' +
        '<button onclick="document.getElementById(\'editTableModal\').remove()" style="background:none;border:none;color:#fff;font-size:1.4rem;cursor:pointer">&times;</button>' +
      '</div>' +
      '<div style="padding:20px;display:flex;flex-direction:column;gap:14px">' +
        '<div>' +
          '<label style="font-size:.82rem;font-weight:700;color:var(--timber);display:block;margin-bottom:5px">Table Name</label>' +
          '<input id="editTblName" value="' + esc(tbl.table_name || '') + '" placeholder="e.g. Garden 1, Balcony A" style="width:100%;box-sizing:border-box;border:1.5px solid var(--mist);border-radius:10px;padding:10px 12px;font-size:.9rem;outline:none">' +
        '</div>' +
        '<div>' +
          '<label style="font-size:.82rem;font-weight:700;color:var(--timber);display:block;margin-bottom:5px">Seating Capacity</label>' +
          '<input id="editTblCap" type="number" min="1" max="50" value="' + (tbl.capacity||4) + '" style="width:100%;box-sizing:border-box;border:1.5px solid var(--mist);border-radius:10px;padding:10px 12px;font-size:.9rem;outline:none">' +
        '</div>' +
        '<div style="display:flex;gap:10px">' +
          '<button onclick="document.getElementById(\'editTableModal\').remove()" style="flex:1;background:#f1f5f9;color:#64748b;border:none;border-radius:10px;padding:12px;font-size:.9rem;font-weight:600;cursor:pointer">Cancel</button>' +
          '<button onclick="submitEditTable(' + tableNo + ')" id="editTblBtn" style="flex:1;background:var(--forest);color:#fff;border:none;border-radius:10px;padding:12px;font-size:.9rem;font-weight:700;cursor:pointer">✅ Save</button>' +
        '</div>' +
      '</div>' +
    '</div>' +
  '</div>';
  document.body.insertAdjacentHTML('beforeend', html);
  setTimeout(function(){ document.getElementById('editTblName').focus(); }, 100);
}

async function submitEditTable(tableNo) {
  var btn = document.getElementById('editTblBtn');
  if (btn) { btn.disabled=true; btn.textContent='Saving…'; }
  var name = document.getElementById('editTblName').value.trim();
  var cap = parseInt(document.getElementById('editTblCap').value) || 4;
  var r = await api('updateTable', { userId: currentUser.userId, tableNo, tableName: name, capacity: cap });
  document.getElementById('editTableModal').remove();
  if (r.ok) {
    _allTables = [];
    showToast('✅ Table updated!', 'success');
    await loadTablesView();
  } else {
    showToast('❌ ' + (r.error || 'Failed to update'), 'error');
  }
}

async function confirmDeleteTable(tableNo) {
  var tbl = _allTables.find(function(t){ return t.table_number === tableNo; });
  var name = tbl ? (tbl.table_name || 'Table ' + tableNo) : 'Table ' + tableNo;
  if (!confirm('Delete ' + name + '? This cannot be undone.')) return;
  var r = await api('deleteTable', { userId: currentUser.userId, tableNo });
  if (r.ok) {
    _allTables = [];
    showToast('🗑️ ' + name + ' deleted', 'success');
    await loadTablesView();
  } else {
    showToast('❌ ' + (r.error || 'Failed to delete'), 'error');
  }
}

async function loadReservationsTab() {
  var picker = document.getElementById('resDatePicker');
  if (!picker.value) picker.value = new Date().toISOString().slice(0,10);
  var date = picker.value;
  var rr = await api('getReservations', { date: date, userId: currentUser.userId });
  renderReservations(rr.ok ? (rr.reservations || []) : []);
}

async function renderTableGrid(reservations) {
  var grid = document.getElementById('tableGrid');
  if (!grid) return;

  // If no reservations passed, fetch today's
  if (!reservations || reservations.length === 0) {
    var today = new Date().toISOString().slice(0,10);
    var rr = await api('getReservations', { date: today, userId: currentUser.userId });
    if (rr.ok) reservations = rr.reservations || [];
  }

  // Map active orders by table number
  var occupiedTables = {};
  allOrders.forEach(function(o) {
    if (['NEW','PREPARING','READY'].includes(o.status) && !o.isTest && o.tableNo) {
      occupiedTables[String(o.tableNo)] = o;
    }
  });

  // Map reservations by table number
  var resByTable = {};
  reservations.forEach(function(r) {
    if (r.table_no && ['CONFIRMED','SEATED'].includes(r.status)) {
      resByTable[String(r.table_no)] = r;
    }
  });

  var tables = _allTables.length > 0 ? _allTables : Array.from({length:10}, function(_,i){ return {table_number:i+1}; });
  var free = 0, occ = 0, res = 0;

  grid.innerHTML = tables.map(function(tbl) {
    var tno = String(tbl.table_number);
    var name = tbl.table_name || ('Table ' + tno);
    var seats = tbl.capacity || 4;
    var order = occupiedTables[tno];
    var reservation = resByTable[tno];
    var isOccupied = !!order;
    var isReserved = !isOccupied && !!reservation;

    if (isOccupied) occ++; else if (isReserved) res++; else free++;

    var bg, border, badge, detail = '';
    if (isOccupied) {
      bg = '#fffbeb'; border = '#f59e0b';
      var elapsed = order.createdAt ? Math.floor((Date.now() - new Date(order.createdAt).getTime()) / 60000) : 0;
      var sIcon = order.status === 'NEW' ? '🔔' : order.status === 'PREPARING' ? '👨‍🍳' : '✨';
      badge = '<span style="background:#fde68a;color:#92400e;font-size:.7rem;font-weight:700;border-radius:6px;padding:2px 8px">' + sIcon + ' ' + order.status + '</span>';
      detail = '<div style="font-size:.72rem;color:#78350f;margin-top:5px;font-weight:600">' + esc(order.customerName || order.orderId || '') + '</div>' +
        (elapsed > 0 ? '<div style="font-size:.68rem;color:#a16207;margin-top:2px">⏱ ' + elapsed + 'min</div>' : '');
    } else if (isReserved) {
      bg = '#eff6ff'; border = '#3b82f6';
      badge = '<span style="background:#dbeafe;color:#1d4ed8;font-size:.7rem;font-weight:700;border-radius:6px;padding:2px 8px">📅 RESERVED</span>';
      detail = '<div style="font-size:.7rem;color:#1e40af;margin-top:5px;font-weight:600">' + esc(reservation.guest_name) + '</div>' +
        '<div style="font-size:.67rem;color:#3b82f6;margin-top:2px">🕐 ' + fmtTime(reservation.res_time) + ' · ' + reservation.pax + ' pax</div>';
    } else {
      bg = '#f0fdf4'; border = '#86efac';
      badge = '<span style="color:#15803d;font-size:.72rem;font-weight:700">🟢 FREE</span>';
    }

    return '<div style="background:' + bg + ';border:2px solid ' + border + ';border-radius:14px;padding:16px 12px;text-align:center;transition:box-shadow .15s" ' +
      'onmouseover="this.style.boxShadow=\'0 4px 12px rgba(0,0,0,.1)\'" onmouseout="this.style.boxShadow=\'none\'">' +
      '<div style="font-weight:900;font-size:1.1rem;color:#0f172a;margin-bottom:2px">' + esc(name) + '</div>' +
      '<div style="font-size:.7rem;color:#94a3b8;margin-bottom:8px">👥 ' + seats + ' seats</div>' +
      badge + detail +
    '</div>';
  }).join('');

  // Update counters
  document.getElementById('tblFreeCount').textContent = '🟢 ' + free + ' Free';
  document.getElementById('tblOccCount').textContent  = '🔴 ' + occ  + ' Occupied';
  document.getElementById('tblResCount').textContent  = '📅 ' + res  + ' Reserved';
}

function fmtTime(t) {
  if (!t) return '';
  var parts = t.slice(0,5).split(':');
  var h = parseInt(parts[0]), m = parts[1];
  return (h % 12 || 12) + ':' + m + (h >= 12 ? ' PM' : ' AM');
}

function renderReservations(reservations) {
  var list = document.getElementById('resList');
  if (!list) return;
  if (reservations.length === 0) {
    list.innerHTML = '<div style="text-align:center;padding:28px 16px;color:var(--timber);background:#fff;border-radius:12px;border:1.5px dashed var(--mist)">' +
      '<div style="font-size:2rem;margin-bottom:8px">📅</div>' +
      '<div style="font-weight:600;font-size:.9rem">No reservations</div>' +
      '<div style="font-size:.78rem;margin-top:4px">Tap "📅 Reserve" to add one</div></div>';
    return;
  }
  list.innerHTML = reservations.map(function(r) {
    var statusColors = {
      CONFIRMED: { bg:'#eff6ff', border:'#3b82f6', text:'#1d4ed8', label:'Confirmed' },
      SEATED:    { bg:'#f0fdf4', border:'#22c55e', text:'#15803d', label:'Seated' },
      COMPLETED: { bg:'#f8fafc', border:'#94a3b8', text:'#64748b', label:'Done' },
      NO_SHOW:   { bg:'#fff1f2', border:'#f43f5e', text:'#be123c', label:'No Show' },
    };
    var sc = statusColors[r.status] || statusColors.CONFIRMED;
    var timeStr = fmtTime(r.res_time);
    return '<div style="background:' + sc.bg + ';border:1.5px solid ' + sc.border + ';border-radius:12px;padding:12px 14px">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">' +
        '<div style="display:flex;gap:10px;align-items:center">' +
          '<div style="font-size:1.4rem;font-weight:900;color:' + sc.text + ';min-width:32px;text-align:center;background:#fff;border-radius:8px;padding:4px 6px;border:1.5px solid ' + sc.border + '">T' + (r.table_no || '?') + '</div>' +
          '<div>' +
            '<div style="font-weight:700;font-size:.88rem;color:#1e293b">' + esc(r.guest_name) + '</div>' +
            '<div style="font-size:.74rem;color:var(--timber);margin-top:2px">' +
              '🕐 ' + timeStr + ' &nbsp;·&nbsp; 👥 ' + r.pax + ' pax' +
              (r.guest_phone ? '<br>📱 ' + esc(r.guest_phone) : '') +
            '</div>' +
            (r.notes ? '<div style="font-size:.72rem;color:#ef4444;margin-top:3px;font-style:italic">📝 ' + esc(r.notes) + '</div>' : '') +
          '</div>' +
        '</div>' +
        '<span style="font-size:.68rem;font-weight:700;padding:3px 8px;border-radius:20px;background:' + sc.border + ';color:#fff;white-space:nowrap;flex-shrink:0">' + sc.label + '</span>' +
      '</div>' +
      '<div style="display:flex;gap:6px;margin-top:10px;justify-content:flex-end">' +
        (r.status === 'CONFIRMED' ?
          '<button onclick="updateRes(\'' + r.res_id + '\',\'SEATED\')" style="background:#22c55e;color:#fff;border:none;border-radius:8px;padding:5px 12px;font-size:.75rem;font-weight:700;cursor:pointer">✅ Seat</button>' +
          '<button onclick="updateRes(\'' + r.res_id + '\',\'NO_SHOW\')" style="background:#f43f5e;color:#fff;border:none;border-radius:8px;padding:5px 10px;font-size:.75rem;font-weight:700;cursor:pointer">❌ No Show</button>' : '') +
        (r.status === 'SEATED' ?
          '<button onclick="updateRes(\'' + r.res_id + '\',\'COMPLETED\')" style="background:#64748b;color:#fff;border:none;border-radius:8px;padding:5px 12px;font-size:.75rem;font-weight:700;cursor:pointer">✔ Done</button>' : '') +
        '<button onclick="updateRes(\'' + r.res_id + '\',\'CANCELLED\')" style="background:#fee2e2;color:#ef4444;border:none;border-radius:8px;padding:5px 10px;font-size:.75rem;cursor:pointer;font-weight:700">✕</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

async function updateRes(resId, status) {
  var r = await api('updateReservation', { resId: resId, status: status, userId: currentUser.userId });
  if (r.ok) {
    var date = document.getElementById('resDatePicker').value || new Date().toISOString().slice(0,10);
    // Re-fetch reservations only
    var rr = await api('getReservations', { date: date, userId: currentUser.userId });
    var reservations = rr.ok ? (rr.reservations || []) : [];
    renderTableGrid(reservations);
    renderReservations(reservations);
  } else {
    alert('Error: ' + (r.error || 'Failed'));
  }
}

// ── ADD TABLE MODAL ──────────────────────────────────────────────────────
function openAddTableModal() {
  var nextNo = _allTables.length > 0 ? Math.max.apply(null, _allTables.map(function(t){ return t.table_number; })) + 1 : 11;
  var html = '<div id="addTableModal" style="position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:700;display:flex;align-items:center;justify-content:center;padding:20px">' +
    '<div style="background:#fff;border-radius:16px;width:100%;max-width:380px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.3)">' +
      '<div style="background:var(--forest-deep);color:#fff;padding:16px 20px;display:flex;align-items:center;justify-content:space-between">' +
        '<div style="font-weight:700;font-size:1rem">＋ Add New Table</div>' +
        '<button onclick="document.getElementById(\'addTableModal\').remove()" style="background:none;border:none;color:#fff;font-size:1.4rem;cursor:pointer">&times;</button>' +
      '</div>' +
      '<div style="padding:20px;display:flex;flex-direction:column;gap:14px">' +
        '<div>' +
          '<label style="font-size:.82rem;font-weight:700;color:var(--timber);display:block;margin-bottom:5px">Table Name <span style="color:#94a3b8;font-weight:400">(optional)</span></label>' +
          '<input id="newTblName" placeholder="e.g. Garden 1, Balcony A, Private Room" ' +
            'style="width:100%;box-sizing:border-box;border:1.5px solid var(--mist);border-radius:10px;padding:10px 12px;font-size:.9rem;outline:none;transition:border .2s" ' +
            'onfocus="this.style.borderColor=\'var(--forest)\'" onblur="this.style.borderColor=\'var(--mist)\'">' +
          '<div style="font-size:.72rem;color:#94a3b8;margin-top:4px">Leave blank to auto-name as "Table ' + nextNo + '"</div>' +
        '</div>' +
        '<div>' +
          '<label style="font-size:.82rem;font-weight:700;color:var(--timber);display:block;margin-bottom:5px">Seating Capacity</label>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
            [2,4,6,8,10,12].map(function(n) {
              return '<button type="button" onclick="selectCapacity(' + n + ')" id="cap' + n + '" ' +
                'style="background:#f1f5f9;color:#475569;border:2px solid #e2e8f0;border-radius:8px;padding:8px 14px;font-size:.85rem;font-weight:600;cursor:pointer;transition:all .15s">' + n + '</button>';
            }).join('') +
          '</div>' +
          '<input type="hidden" id="newTblCap" value="4">' +
        '</div>' +
        '<div style="background:#f0fdf4;border-radius:10px;padding:12px;font-size:.8rem;color:#15803d">' +
          '✅ A unique QR code will be auto-generated<br>' +
          '✅ Table appears instantly in the ordering screen' +
        '</div>' +
        '<div style="display:flex;gap:10px">' +
          '<button onclick="document.getElementById(\'addTableModal\').remove()" style="flex:1;background:#f1f5f9;color:#64748b;border:none;border-radius:10px;padding:12px;font-size:.9rem;font-weight:600;cursor:pointer">Cancel</button>' +
          '<button onclick="submitAddTable(' + nextNo + ')" id="addTableSubmitBtn" style="flex:1;background:var(--forest);color:#fff;border:none;border-radius:10px;padding:12px;font-size:.9rem;font-weight:700;cursor:pointer">＋ Add Table</button>' +
        '</div>' +
      '</div>' +
    '</div>' +
  '</div>';
  document.body.insertAdjacentHTML('beforeend', html);
  // Pre-select 4 seats
  setTimeout(function(){ selectCapacity(4); document.getElementById('newTblName').focus(); }, 50);
}

function selectCapacity(n) {
  [2,4,6,8,10,12].forEach(function(v) {
    var btn = document.getElementById('cap' + v);
    if (!btn) return;
    if (v === n) {
      btn.style.background = 'var(--forest)'; btn.style.color = '#fff'; btn.style.borderColor = 'var(--forest)';
    } else {
      btn.style.background = '#f1f5f9'; btn.style.color = '#475569'; btn.style.borderColor = '#e2e8f0';
    }
  });
  document.getElementById('newTblCap').value = n;
}

async function submitAddTable(tableNo) {
  var btn = document.getElementById('addTableSubmitBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
  var name = (document.getElementById('newTblName').value || '').trim();
  var cap = parseInt(document.getElementById('newTblCap').value) || 4;
  var r = await api('addTable', { userId: currentUser.userId, tableNo: tableNo, tableName: name || null, capacity: cap });
  var m = document.getElementById('addTableModal');
  if (m) m.remove();
  if (r.ok) {
    _allTables = [];
    showToast('✅ Table added successfully!', 'success');
    await loadTablesView();
  } else {
    showToast('❌ ' + (r.error || 'Failed to add table'), 'error');
  }
}

// ── RESERVATION MODAL ─────────────────────────────────────────────────────
function openResModal() {
  var today = new Date().toISOString().slice(0,10);
  var picked = document.getElementById('resDatePicker').value || today;
  var modalHtml = '<div id="resModal" style="position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:600;display:flex;align-items:center;justify-content:center;padding:20px">' +
    '<div style="background:#fff;border-radius:16px;width:100%;max-width:420px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.3)">' +
      '<div style="background:var(--forest-deep);color:#fff;padding:16px 20px;display:flex;align-items:center;justify-content:space-between">' +
        '<div style="font-weight:700;font-size:1rem">📅 New Reservation</div>' +
        '<button onclick="closeResModal()" style="background:none;border:none;color:#fff;font-size:1.4rem;cursor:pointer">&times;</button>' +
      '</div>' +
      '<div style="padding:20px;display:flex;flex-direction:column;gap:14px">' +
        '<div>' +
          '<label style="font-size:.78rem;font-weight:700;color:var(--timber);display:block;margin-bottom:4px">GUEST NAME *</label>' +
          '<input id="resName" placeholder="Juan Dela Cruz" style="width:100%;border:1.5px solid var(--mist);border-radius:8px;padding:10px 12px;font-size:.9rem;outline:none;box-sizing:border-box">' +
        '</div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
          '<div>' +
            '<label style="font-size:.78rem;font-weight:700;color:var(--timber);display:block;margin-bottom:4px">PHONE</label>' +
            '<input id="resPhone" placeholder="09xxxxxxxxx" style="width:100%;border:1.5px solid var(--mist);border-radius:8px;padding:10px 12px;font-size:.9rem;outline:none;box-sizing:border-box">' +
          '</div>' +
          '<div>' +
            '<label style="font-size:.78rem;font-weight:700;color:var(--timber);display:block;margin-bottom:4px">PAX *</label>' +
            '<input id="resPax" type="number" min="1" max="20" value="2" style="width:100%;border:1.5px solid var(--mist);border-radius:8px;padding:10px 12px;font-size:.9rem;outline:none;box-sizing:border-box">' +
          '</div>' +
        '</div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
          '<div>' +
            '<label style="font-size:.78rem;font-weight:700;color:var(--timber);display:block;margin-bottom:4px">TABLE *</label>' +
            '<select id="resTable" style="width:100%;border:1.5px solid var(--mist);border-radius:8px;padding:10px 12px;font-size:.9rem;outline:none;background:#fff;box-sizing:border-box">' +
              (_allTables.length > 0 ? _allTables : Array.from({length:10},function(_,i){return {table_number:i+1};})).map(function(t){ return '<option value="'+t.table_number+'">Table '+t.table_number+'</option>'; }).join('') +
            '</select>' +
          '</div>' +
          '<div>' +
            '<label style="font-size:.78rem;font-weight:700;color:var(--timber);display:block;margin-bottom:4px">TIME *</label>' +
            '<input id="resTime" type="time" value="12:00" style="width:100%;border:1.5px solid var(--mist);border-radius:8px;padding:10px 12px;font-size:.9rem;outline:none;box-sizing:border-box">' +
          '</div>' +
        '</div>' +
        '<div>' +
          '<label style="font-size:.78rem;font-weight:700;color:var(--timber);display:block;margin-bottom:4px">DATE *</label>' +
          '<input id="resDate" type="date" value="' + picked + '" style="width:100%;border:1.5px solid var(--mist);border-radius:8px;padding:10px 12px;font-size:.9rem;outline:none;box-sizing:border-box">' +
        '</div>' +
        '<div>' +
          '<label style="font-size:.78rem;font-weight:700;color:var(--timber);display:block;margin-bottom:4px">NOTES</label>' +
          '<input id="resNotes" placeholder="e.g. Birthday celebration, window seat preference" style="width:100%;border:1.5px solid var(--mist);border-radius:8px;padding:10px 12px;font-size:.9rem;outline:none;box-sizing:border-box">' +
        '</div>' +
        '<button onclick="submitReservation()" style="background:var(--forest);color:#fff;border:none;border-radius:10px;padding:14px;font-size:.95rem;font-weight:700;cursor:pointer;width:100%;margin-top:4px">✅ Confirm Reservation</button>' +
      '</div>' +
    '</div>' +
  '</div>';
  document.body.insertAdjacentHTML('beforeend', modalHtml);
}

function closeResModal() {
  var m = document.getElementById('resModal');
  if (m) m.remove();
}

async function submitReservation() {
  var name  = document.getElementById('resName').value.trim();
  var phone = document.getElementById('resPhone').value.trim();
  var pax   = document.getElementById('resPax').value;
  var table = document.getElementById('resTable').value;
  var time  = document.getElementById('resTime').value;
  var date  = document.getElementById('resDate').value;
  var notes = document.getElementById('resNotes').value.trim();

  if (!name || !table || !time || !date) {
    alert('Please fill in all required fields (Name, Table, Time, Date)');
    return;
  }
  var btn = document.querySelector('#resModal button[onclick="submitReservation()"]');
  btn.disabled = true; btn.textContent = 'Saving...';

  var r = await api('createReservation', {
    userId: currentUser && currentUser.userId,
    guestName: name, guestPhone: phone || null,
    tableNo: parseInt(table), pax: parseInt(pax) || 2,
    resDate: date, resTime: time, notes: notes || null
  });
  if (r.ok) {
    closeResModal();
    document.getElementById('resDatePicker').value = date;
    await loadTablesView();
  } else {
    alert('Error: ' + (r.error || 'Failed to save'));
    btn.disabled = false; btn.textContent = '✅ Confirm Reservation';
  }
}


// ══════════════════════════════════════════════════════════
// CHANGE PIN
// ══════════════════════════════════════════════════════════
function openChangePinModal() {
  var overlay = document.getElementById('changePinOverlay');
  overlay.style.display = 'flex';

  // If OWNER or ADMIN — can change any user's PIN (no current PIN needed)
  // If CASHIER or KITCHEN — can only change own PIN (needs current PIN)
  var isAdminOrOwner = currentUser.role === 'ADMIN' || currentUser.role === 'OWNER';

  var staffRow    = document.getElementById('changePinStaffRow');
  var currentRow  = document.getElementById('changePinCurrentRow');

  if (isAdminOrOwner) {
    staffRow.style.display   = 'block';
    currentRow.style.display = 'none';
    // Pre-select logged-in user but allow changing others
    var sel = document.getElementById('changePinTarget');
    sel.value = currentUser.userId || 'USR_001';
    if (sel.selectedIndex < 0) sel.selectedIndex = 0;
  } else {
    // Non-admin: can only change own PIN, must verify current
    staffRow.style.display   = 'none';
    currentRow.style.display = 'block';
  }

  // Clear fields
  document.getElementById('changePinCurrent').value = '';
  document.getElementById('changePinNew').value      = '';
  document.getElementById('changePinConfirm').value  = '';
  document.getElementById('changePinErr').textContent = '';
  document.getElementById('changePinBtn').disabled   = false;
  document.getElementById('changePinBtn').textContent = '✅ Update PIN';
}

function closeChangePinModal() {
  document.getElementById('changePinOverlay').style.display = 'none';
}

async function submitChangePin() {
  var isAdminOrOwner = currentUser.role === 'ADMIN' || currentUser.role === 'OWNER';
  var targetUserId   = isAdminOrOwner
    ? document.getElementById('changePinTarget').value
    : currentUser.userId;
  var currentPin  = document.getElementById('changePinCurrent').value.trim();
  var newPin      = document.getElementById('changePinNew').value.trim();
  var confirmPin  = document.getElementById('changePinConfirm').value.trim();
  var errEl       = document.getElementById('changePinErr');

  errEl.textContent = '';

  if (!newPin || newPin.length < 4) {
    errEl.textContent = 'New PIN must be at least 4 digits'; return;
  }
  if (!/^\d{4,8}$/.test(newPin)) {
    errEl.textContent = 'PIN must be digits only (4–8 digits)'; return;
  }
  if (newPin !== confirmPin) {
    errEl.textContent = 'PINs do not match'; return;
  }
  if (!isAdminOrOwner && !currentPin) {
    errEl.textContent = 'Please enter your current PIN'; return;
  }

  var btn = document.getElementById('changePinBtn');
  btn.disabled = true; btn.textContent = 'Updating...';

  var payload = {
    targetUserId: targetUserId,
    newPin:       newPin,
  };
  if (isAdminOrOwner) {
    payload.userId = currentUser.userId; // requester identity
  } else {
    payload.currentPin = currentPin; // self-change verification
  }

  var r = await api('changePin', payload);
  if (r.ok) {
    closeChangePinModal();
    // Show brief success
    var toast = document.createElement('div');
    toast.textContent = '✅ PIN updated successfully!';
    toast.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#16a34a;color:#fff;padding:12px 20px;border-radius:10px;font-weight:700;z-index:999;font-size:.9rem;';
    document.body.appendChild(toast);
    setTimeout(function(){ toast.remove(); }, 3000);

    // If user changed their own PIN, log them out so they re-login with new PIN
    if (targetUserId === currentUser.userId) {
      setTimeout(function(){
        alert('Your PIN was changed. Please log in again with your new PIN.');
        logout();
      }, 1000);
    }
  } else {
    errEl.textContent = r.error || 'Failed to update PIN';
    btn.disabled = false; btn.textContent = '✅ Update PIN';
  }
}

// Close modal on overlay click
document.addEventListener('click', function(e) {
  var overlay = document.getElementById('changePinOverlay');
  if (e.target === overlay) closeChangePinModal();
});

// ══════════════════════════════════════════════════════════
// SYNC TO SHEETS
// ══════════════════════════════════════════════════════════
function openSheetsLink() {
  window.open('https://docs.google.com/spreadsheets/d/14wSvfCy5LUrlgi4d48jcGjnFpy310XYUsCWCg5VMg0g/edit', '_blank');
}

async function triggerGasSync() {
  var btn = document.getElementById('syncSheetsBtn');
  var lbl = document.getElementById('syncSheetsLabel');
  if (lbl) lbl.textContent = '⏳ Syncing…';
  if (btn) btn.disabled = true;
  try {
    var GAS_URL = 'https://script.google.com/macros/s/AKfycbzprf6_LpDwcVujm8kcGFZE5JdkL0k9b6Wfg5l82gjZzFua8w1QWH8UoFFlhznc6EtL/exec?action=sync';
    var r = await fetch(GAS_URL, { method:'GET', mode:'no-cors' });
    // no-cors means we can't read response but the GAS runs
    showToast('✅ Sync triggered — Sheets will update within 1 minute');
  } catch(e) {
    showToast('Sync signal sent (Sheets updates within 1 min)', false);
  } finally {
    setTimeout(function() {
      if (lbl) lbl.textContent = 'Sync to Sheets';
      if (btn) btn.disabled = false;
    }, 3000);
  }
}

async function syncToSheets() {
  var btn = document.getElementById('syncSheetsBtn');
  var lbl = document.getElementById('syncSheetsLabel');
  if (!btn || !lbl) return;
  lbl.textContent = 'Syncing...';
  btn.style.opacity = '.6';
  btn.disabled = true;
  try {
    var r = await api('syncToSheets', { userId: currentUser && currentUser.userId });
    if (r.ok) {
      lbl.textContent = '✅ Synced!';
      showToast('✅ Synced ' + (r.synced || 0) + ' orders to Google Sheets!');
      setTimeout(function(){ lbl.textContent = 'Sync to Sheets'; }, 3000);
    } else {
      lbl.textContent = '❌ Failed';
      showToast('❌ Sync failed: ' + (r.error || 'Unknown error'));
      setTimeout(function(){ lbl.textContent = 'Sync to Sheets'; }, 3000);
    }
  } catch(e) {
    lbl.textContent = '❌ Error';
    showToast('❌ Sync error: ' + e.message);
    setTimeout(function(){ lbl.textContent = 'Sync to Sheets'; }, 3000);
  } finally {
    btn.style.opacity = '';
    btn.disabled = false;
  }
}




var pmCurrentOrder = null;
var pmSelectedMethod  = null;   // first pick  (GCASH | CASH | CARD)
var pmSelectedMethod2 = null;   // second pick for split
var pmFromComplete = false;
