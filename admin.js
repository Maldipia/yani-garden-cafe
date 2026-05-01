

  // ═══════════════════════════════════════════════════════
  // WHITE-LABEL CONFIG
  // ═══════════════════════════════════════════════════════
  var APP_CONFIG = {};
  async function loadAppConfig() {
    try {
      var r = await fetch('/api/config');
      var d = await r.json();
      if (d.ok) {
        APP_CONFIG = d.config;
        applyAdminConfig(d.config);
      }
    } catch(e) {}
  }
  function applyAdminConfig(cfg) {
    var bn = cfg.BUSINESS_NAME || 'My Cafe';
    document.title = bn + ' — Admin';
    document.querySelectorAll('.brand-name').forEach(function(el){ el.textContent = bn; });
    if (cfg.PRIMARY_COLOR) {
      document.documentElement.style.setProperty('--forest', cfg.PRIMARY_COLOR);
      document.documentElement.style.setProperty('--forest-deep', cfg.PRIMARY_COLOR);
    }
    if (cfg.LOGO_URL) document.querySelectorAll('.brand-logo').forEach(function(el){ el.src = cfg.LOGO_URL; });
    if (cfg.ORDER_PREFIX) window.ORDER_PREFIX = cfg.ORDER_PREFIX;
    if (cfg.SESSION_KEY) POS_SESSION_KEY = cfg.SESSION_KEY;
    if (cfg.SESSION_KEY) window.POS_SESSION_KEY = cfg.SESSION_KEY;
    if (cfg.SERVICE_CHARGE) window.SERVICE_CHARGE_RATE = parseFloat(cfg.SERVICE_CHARGE);
  }
  loadAppConfig();
// ══════════════════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════════════════
var API_URL = '/api/pos';
var UPLOAD_URL = '/api/upload-image';
var POLL_INTERVAL = 5000;
// Adaptive polling — faster when active orders exist, slower when tab hidden
var _pollActive = true;
document.addEventListener('visibilitychange', function() {
  _pollActive = !document.hidden;
  if (_pollActive && pollTimer) { clearInterval(pollTimer); startPolling(); }
});

// ── Supabase Realtime ─────────────────────────────────────────────────────
// Instant push when orders change — no polling needed when Realtime is live
var _supabaseClient = null;
var _realtimeChannel = null;
var _realtimeActive = false;

function initRealtime() {
  try {
    _supabaseClient = supabase.createClient(
      (window.SUPABASE_URL || (APP_CONFIG && APP_CONFIG.SUPABASE_URL) || 'https://hnynvclpvfxzlfjphefj.supabase.co'),
      (APP_CONFIG && APP_CONFIG.SUPABASE_ANON_KEY) || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhueW52Y2xwdmZ4emxmanBoZWZqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0NTg5MTMsImV4cCI6MjA4ODAzNDkxM30.cBIoq9dVUFC0d7Su5B7ubBG83-q-bffheKoOCTRDqXE'
    );
    _realtimeChannel = _supabaseClient
      .channel('order-board')
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'dine_in_orders'
      }, function(payload) {
        // Order changed — reload immediately instead of waiting for poll
        loadOrders();
      })
      .subscribe(function(status) {
        _realtimeActive = (status === 'SUBSCRIBED');
        if (_realtimeActive) {
          // Realtime connected — slow down polling to 30s fallback only
          if (pollTimer) { clearInterval(pollTimer); }
          pollTimer = setInterval(function() {
            if (!_realtimeActive) loadOrders(); // fallback only
          }, 30000);
          console.log('✅ Realtime connected — polling reduced to 30s fallback');
        } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
          _realtimeActive = false;
          // Realtime dropped — restore normal polling
          if (pollTimer) clearInterval(pollTimer);
          pollTimer = setInterval(function() { loadOrders(); }, POLL_INTERVAL);
          console.warn('⚠️ Realtime disconnected — falling back to polling');
        }
      });
  } catch(e) {
    console.warn('Realtime init failed:', e.message);
  }
}

// Known non-PNG extensions for menu images
var MENU_IMG_EXT = {
  'C009':'jpg','C013':'jpg','C016':'jpeg','F001':'jpg','H008':'jpg','H010':'jpg'
};
function getLocalMenuImgPath(code) {
  var ext = MENU_IMG_EXT[code] || 'png';
  return '/images/' + code + '.' + ext;
}
var pollTimer = null;
var currentFilter = 'ACTIVE';
var allOrders = [];
// Local status overrides — prevents polling from reverting optimistic UI updates.
// Key: orderId, Value: { status, ts } — expires after 90s once GAS has synced.
var _statusOverrides = {};
var lastOrderCount = 0;
var allPayments = [];

// ── Kitchen audio alert ──────────────────────────────────────────────────
window._knownOrderIds = null; // null = first load (skip alert on init)
var _audioCtx = null;
function playNewOrderAlert() {
  try {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    var ctx = _audioCtx;
    function tone(freq, start, dur, vol) {
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = 'sine'; osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, ctx.currentTime + start);
      gain.gain.linearRampToValueAtTime(vol, ctx.currentTime + start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + dur + 0.1);
    }
    tone(880,  0,   0.4, 0.3);
    tone(1100, 0.2, 0.5, 0.3);
    tone(880,  0.5, 0.6, 0.2);
  } catch(e) { /* audio blocked */ }
}

var pendingPayCount = 0;
var payFilter = 'PENDING';
var allOnlineOrders = [];
var onlineOrderPendingCount = 0;
var onlineOrderFilter = 'ALL';

// Session data — Phase 2: JWT token added
var currentUser = {
  userId:      null,
  username:    null,
  role:        null,
  token:       null,   // JWT issued by server on login
  expiresAt:   null,   // epoch ms when token expires
};
var POS_SESSION_KEY = (window.POS_SESSION_KEY || 'pos_session_token'); // localStorage key

var STATUS_CONFIG = {
  NEW:       { icon:'🔔', label:'New',       badge:'new',       actions:['start','cancel'] },
  PREPARING: { icon:'👨‍🍳', label:'Preparing', badge:'preparing', actions:['ready','cancel'] },
  READY:     { icon:'✨', label:'Ready',     badge:'ready',     actions:['complete','cancel'] },
  COMPLETED: { icon:'🎉', label:'Completed', badge:'completed', actions:[] },
  CANCELLED: { icon:'❌', label:'Cancelled', badge:'cancelled', actions:[] }
};

// ══════════════════════════════════════════════════════════
// SESSION MANAGEMENT
// ══════════════════════════════════════════════════════════
var SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
var sessionTimer = null;

function resetSessionTimer() {
  if (sessionTimer) clearTimeout(sessionTimer);
  sessionTimer = setTimeout(function() {
    showToast('⏰ Session expired. Please log in again.', 'error');
    logout();
  }, SESSION_TIMEOUT_MS);
}

// Reset timer on user activity
['click','keydown','touchstart'].forEach(function(evt) {
  document.addEventListener(evt, function() {
    if (currentUser.userId) resetSessionTimer();
  }, { passive: true });
});

function logout() {
  if (sessionTimer) clearTimeout(sessionTimer);
  currentUser = { userId: null, username: null, role: null, token: null, expiresAt: null };
  try { localStorage.removeItem(POS_SESSION_KEY); } catch(_) {}
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  document.getElementById('dashboard').style.display = 'none';
  document.getElementById('loginOverlay').classList.remove('hidden');
  document.getElementById('pinInput').value = '';
  document.getElementById('pinInput').focus();
  document.getElementById('topbarUser').style.display = 'none';
}

// ── Session restore ─────────────────────────────────────────
// On page load, try to restore from localStorage token so refreshing
// the page doesn't force staff to re-enter PIN every time.
function tryRestoreSession() {
  try {
    var stored = localStorage.getItem(POS_SESSION_KEY);
    if (!stored) return false;
    var s = JSON.parse(stored);
    if (!s.userId || !s.role) return false;
    // KITCHEN sessions are never auto-restored — kitchen staff re-enters PIN each time
    // This prevents kitchen session from blocking admin login on shared devices
    if (s.role === 'KITCHEN') {
      localStorage.removeItem(POS_SESSION_KEY);
      return false;
    }
    // If we have a token, check it's not expired
    if (s.expiresAt && Date.now() > s.expiresAt - 5 * 60 * 1000) {
      localStorage.removeItem(POS_SESSION_KEY);
      return false;
    }
    // No token (JWT not yet active) — still allow session restore via userId
    // Restore session state
    currentUser.userId    = s.userId;
    currentUser.username  = s.username;
    currentUser.role      = s.role;
    currentUser.token     = s.token;
    currentUser.expiresAt = s.expiresAt;
    return true;
  } catch(_) {
    return false;
  }
}

function applyRoleUI() {
  var role = currentUser.role || 'KITCHEN';
  
  // Update topbar user info
  document.getElementById('topbarUser').style.display = 'flex';
  document.getElementById('roleBadge').textContent = role;
  document.getElementById('roleBadge').className = 'role-badge ' + role;
  document.getElementById('usernameLabel').textContent = currentUser.username || '';
  // For KITCHEN: show "switch" hint since they can't access admin features
  var switchHint = document.getElementById('switchUserHint');
  if (switchHint) switchHint.style.display = (role === 'KITCHEN') ? '' : 'none';
  
  // Edit order button: ADMIN, OWNER, CASHIER
  var canEditOrders = (role === 'ADMIN' || role === 'OWNER' || role === 'CASHIER');
  window._canEditOrders = canEditOrders;
  
  // FAB (New Platform Order): SERVER, ADMIN, OWNER
  var canCreateOrder = (role !== 'KITCHEN');
  document.getElementById('fabWrap').style.display = canCreateOrder ? '' : 'none';
  
  // Quick links (Payments Sheet): SERVER, ADMIN, OWNER
  var canViewPayments = (role !== 'KITCHEN');
  document.getElementById('quickLinks').style.display = canViewPayments ? '' : 'none';

  // Build sidebar nav based on role
  renderSidebar();
}

// ══════════════════════════════════════════════════════════
// LOGIN
// ══════════════════════════════════════════════════════════

document.getElementById('pinInput').addEventListener('keyup', function(e) {
  if (e.key === 'Enter') login();
});

async function login() {
  var pin = document.getElementById('pinInput').value.trim();
  if (!pin) return;

  var btn = document.getElementById('pinBtn');
  btn.textContent = 'Verifying...';
  btn.disabled = true;

  try {
    // 55-second timeout (Vercel function max is 60s)
    var controller = new AbortController();
    var timeoutId = setTimeout(function(){ controller.abort(); }, 55000);
    var resp = await fetch(API_URL, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'verifyUserPin', pin: pin }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    var data = await resp.json();

    if (data.ok && data.userId) {
      // Successful login
      currentUser.userId    = data.userId;
      currentUser.username  = data.username;
      currentUser.role      = data.role;
      currentUser.token     = data.token || null;
      currentUser.expiresAt = data.token ? (Date.now() + (data.expiresIn || 28800) * 1000) : null;
      // Persist token so page refresh doesn't force re-login
      // Store session — but NOT for KITCHEN (they never get auto-restored)
      if (data.role !== 'KITCHEN') {
        try {
          localStorage.setItem(POS_SESSION_KEY, JSON.stringify({
            token:     data.token || null,
            userId:    data.userId,
            username:  data.username,
            role:      data.role,
            expiresAt: data.token ? currentUser.expiresAt : Date.now() + 8 * 60 * 60 * 1000,
          }));
        } catch(_) {}
      } else {
        // Clear any previous session so admin isn't stuck on kitchen
        try { localStorage.removeItem(POS_SESSION_KEY); } catch(_) {}
      }
      
      console.log('✅ Logged in as', data.username, '(' + data.role + ')');
      
      document.getElementById('loginOverlay').classList.add('hidden');
      document.getElementById('dashboard').style.display = 'block';
      // Defer heavy rendering to next frame so browser can paint the dashboard first
      setTimeout(function() {
        applyRoleUI();
        resetSessionTimer();
        startPolling();
        initRealtime();
        // Run health check for ADMIN/OWNER after login
        if (data.role === 'ADMIN' || data.role === 'OWNER') {
          setTimeout(runHealthCheck, 2000);
          // Initialize queue monitor panel
          setTimeout(initQueueMonitor, 1000);
        }
        // Cash session check — alert if no open session (OWNER/CASHIER/ADMIN)
        if (data.role === 'OWNER' || data.role === 'ADMIN' || data.role === 'CASHIER') {
          setTimeout(checkCashSessionOnLogin, 3000);
        }
      }, 0);
    } else {
      // Wrong PIN — show clear visible error
      var pinEl = document.getElementById('pinInput');
      var errEl = document.getElementById('pinErrorMsg');
      pinEl.classList.add('error');
      setTimeout(function(){ pinEl.classList.remove('error'); }, 800);
      pinEl.value = '';
      pinEl.focus();
      if (errEl) {
        var msg = (data.message && (data.message.indexOf('locked') >= 0 || data.message.indexOf('disabled') >= 0))
          ? '🔒 ' + data.message
          : '❌ Incorrect PIN. Please try again.';
        errEl.textContent = msg;
        errEl.style.display = 'block';
        setTimeout(function(){ errEl.style.display = 'none'; }, 3000);
      } else if (data.message) {
        showToast('⚠️ ' + data.message, 'warn');
      }
    }
  } catch(e) {
    if (e.name === 'AbortError') {
      showToast('⏱️ Login timed out. Please try again.', 'error');
    } else {
      showToast('Connection error: ' + e.message, 'error');
    }
  }
  btn.textContent = 'Enter Dashboard';
  btn.disabled = false;
}

// ══════════════════════════════════════════════════════════
// API
// ══════════════════════════════════════════════════════════
async function api(action, data) {
  try {
    var body = Object.assign({ action:action }, data || {});
    var headers = { 'Content-Type': 'application/json' };
    // Attach JWT token if we have one — server validates it, no longer trusts body.userId alone
    if (currentUser.token) headers['Authorization'] = 'Bearer ' + currentUser.token;
    var resp = await fetch(API_URL, { method:'POST', headers:headers, body:JSON.stringify(body) });
    var result = await resp.json();
    // Auto-logout ONLY on explicit token expiry — not on general 403 auth failures
    if (result && result.error === 'Token expired. Please log in again.') {
      showToast('⏰ Session expired. Please log in again.', 'error');
      logout();
      return { ok:false, error:'Session expired' };
    }
    return result;
  } catch(e) {
    return { ok:false, error:e.message };
  }
}

// ══════════════════════════════════════════════════════════
// POLLING
// ══════════════════════════════════════════════════════════
var _onlinePollTimer = null;
function startPolling() {
  loadOrders();
  loadMenuCache(); // pre-load menu for Edit Order modal
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(function() {
    if (document.hidden) return; // skip when tab not visible — saves API calls
    var hasActive = allOrders && allOrders.some(function(o){
      return o.status === 'NEW' || o.status === 'PREPARING' || o.status === 'READY';
    });
    // 3s when active orders exist, 5s otherwise
    var targetInterval = hasActive ? 3000 : 5000;
    if (pollTimer._interval !== targetInterval) {
      clearInterval(pollTimer);
      pollTimer = setInterval(arguments.callee, targetInterval);
      pollTimer._interval = targetInterval;
    }
    loadOrders();
  }, POLL_INTERVAL);
  pollTimer._interval = POLL_INTERVAL;
  // Separate slow timer (30s) for online orders
  if (_onlinePollTimer) clearInterval(_onlinePollTimer);
  _onlinePollTimer = setInterval(function() {
    if (currentFilter === 'ONLINE_ORDERS') {
      loadOnlineOrders().catch(function(){});
    } else {
      // Silently refresh badge count for all roles
      _refreshOnlineCount().catch(function(){});
    }
  }, 30000);
  // Load online count immediately on startup for all roles
  setTimeout(function(){ _refreshOnlineCount().catch(function(){}); }, 1500);
}

async function _refreshOnlineCount() {
  try {
    var resp = await fetch('/api/online-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'getOnlineOrders', limit: 100 })
    });
    var data = await resp.json();
    if (data.ok && data.orders) {
      allOnlineOrders = data.orders;
      onlineOrderPendingCount = data.orders.filter(function(o) {
        return o.status === 'PENDING' || o.payment_status === 'SUBMITTED';
      }).length;
      renderFilters(); // Update badge count on tab
    }
  } catch(e) {}
}

async function loadOrders() {
  var result = await api('getOrders');
  if (!result.ok || !result.orders) return;

  // Deduplicate by orderId (keep first occurrence — most recent from GAS)
  var seen = {};
  var freshOrders = result.orders.filter(function(o) {
    if (seen[o.orderId]) return false;
    seen[o.orderId] = true;
    return true;
  });

  // ── Kitchen audio alert + auto-print 2 copies for new orders ───────────
  if (window._knownOrderIds) {
    var newArrivals = freshOrders.filter(function(o) {
      return o.status === 'NEW' && !window._knownOrderIds[o.orderId];
    });
    if (newArrivals.length > 0) {
      playNewOrderAlert();
      // Auto-print 2 copies for each brand-new order (fires once per order)
      if (!window._autoPrintedOrders) window._autoPrintedOrders = {};
      newArrivals.forEach(function(o, idx) {
        if (window._autoPrintedOrders[o.orderId]) return;
        window._autoPrintedOrders[o.orderId] = true;
        // Stagger if multiple orders arrive simultaneously
        setTimeout(function() { printReceipt(o.orderId, 2); }, idx * 1800);
      });
    }
  }
  // Seed _autoPrintedOrders on very first poll so existing NEW orders don't auto-print
  if (!window._initialPollDone) {
    window._initialPollDone = true;
    if (!window._autoPrintedOrders) window._autoPrintedOrders = {};
    freshOrders.forEach(function(o) { window._autoPrintedOrders[o.orderId] = true; });
  }
  window._knownOrderIds = {};
  freshOrders.forEach(function(o) { window._knownOrderIds[o.orderId] = true; });

  // Change detection — only re-render if order data actually changed
  var freshHash = freshOrders.map(function(o){ return o.orderId+':'+o.status+':'+(o.paymentStatus||''); }).join('|');
  var changed = freshHash !== window._lastOrdersHash;
  window._lastOrdersHash = freshHash;

  allOrders = freshOrders;

  // Apply local status overrides
  var now = Date.now();
  Object.keys(_statusOverrides).forEach(function(oid) {
    var ov = _statusOverrides[oid];
    if (now - ov.ts > 90000) { delete _statusOverrides[oid]; return; }
    var order = allOrders.find(function(o) { return o.orderId === oid; });
    if (order) order.status = ov.status;
  });

  renderStats();
  renderFilters();
  if (changed) renderOrders(); // Only re-render cards if something changed
}

// Load menu into cache for Edit Order modal (called once after login)
async function loadMenuCache() {
  if (window._menuDataCache && window._menuDataCache.length) return; // already loaded
  try {
    var result = await api('getMenuAdmin', { userId: currentUser && currentUser.userId });
    if (result.ok && result.items) {
      window._menuDataCache = result.items;
    }
  } catch(e) { /* silent fail */ }
}

// ══════════════════════════════════════════════════════════
// STATS
// ══════════════════════════════════════════════════════════
function renderStats() {
  // Business day = 6 AM PHT to 6 AM PHT (YANI opens 10 AM, closes 12 MN)
  // Orders placed 12 MN–5:59 AM belong to the PREVIOUS business day
  var manilaOffset = 8 * 3600000;
  var nowPHT = new Date(Date.now() + manilaOffset);
  var curHour = nowPHT.getUTCHours(); // hour in PHT (0-23)
  // Business day start = today 6 AM PHT; if before 6 AM, start = yesterday 6 AM PHT
  var bdayStart = new Date(nowPHT);
  bdayStart.setUTCHours(6, 0, 0, 0);
  if (curHour < 6) bdayStart.setTime(bdayStart.getTime() - 86400000);
  var bdayEnd = new Date(bdayStart.getTime() + 86400000);
  var todayStr = bdayStart.toISOString().slice(0, 10); // label for "today's" biz day

  var todayOrders = allOrders.filter(function(o) {
    try {
      var raw = o.createdAt || '';
      if (raw && !raw.endsWith('Z') && !raw.includes('+') && raw.length > 10) raw = raw + '+00:00';
      var d = new Date(raw);
      if (isNaN(d.getTime())) return false;
      // Order is "today" if it falls within the current business day window
      return d.getTime() >= bdayStart.getTime() - manilaOffset &&
             d.getTime() <  bdayEnd.getTime()   - manilaOffset;
    } catch(e) { return false }
  });

  var totalSales = 0;
  var completed = 0;
  // Active = ALL orders with active status (not just today's)
  var active = allOrders.filter(function(o) {
    return o.status === 'NEW' || o.status === 'PREPARING' || o.status === 'READY';
  }).length;

  todayOrders.forEach(function(o) {
    // Sales = COMPLETED orders only (not READY/PREPARING — not paid yet)
    // Use discounted_total when available so discounts are reflected correctly
    if (o.status === 'COMPLETED') {
      completed++;
      // parseFloat handles both number and string from Supabase numeric columns
      var orderTotal = parseFloat(o.discountedTotal) > 0
        ? parseFloat(o.discountedTotal)
        : parseFloat(o.total) > 0
          ? parseFloat(o.total)
          : parseFloat(o.subtotal) > 0
            ? parseFloat(o.subtotal) + (parseFloat(o.serviceCharge) || 0)
            : (o.items || []).reduce(function(s,it){ return s + (parseFloat(it.price)||0)*(it.qty||1); }, 0);
      totalSales += orderTotal;
    }
  });

  document.getElementById('statSales').textContent = '₱' + totalSales.toLocaleString();
  document.getElementById('statOrders').textContent = completed; // COMPLETED orders only
  document.getElementById('statActive').textContent = active;

  // Count pending payments across all orders
  // Count orders with SUBMITTED payment (waiting for verification)
  var pendingPayments = allOrders.filter(function(o){ return o.paymentStatus === 'SUBMITTED' && !o.isTest }).length;
  // Use max of orders-derived count and actual payments count (whichever is higher)
  var displayCount = Math.max(pendingPayments, pendingPayCount || 0);
  document.getElementById('pendingCount').textContent = displayCount || '';
  if (!displayCount) document.getElementById('pendingCount').textContent = '0';
}

// ══════════════════════════════════════════════════════════
// FILTERS
// ══════════════════════════════════════════════════════════
function renderFilters() {
  // Only order-status chips — section navigation is now in the sidebar
  var counts = { ALL:0, ACTIVE:0, NEW:0, PREPARING:0, READY:0, COMPLETED:0, CANCELLED:0, PLATFORM:0 };
  allOrders.forEach(function(o) {
    counts.ALL++;
    if (!o.isTest) counts[o.status] = (counts[o.status] || 0) + 1;
    if (!o.isTest && (o.status === 'NEW' || o.status === 'PREPARING' || o.status === 'READY')) counts.ACTIVE++;
    if (o.platform) counts.PLATFORM++;
  });

  var chips = [
    { key:'ACTIVE',    label:'🔥 Active',    count:counts.ACTIVE },
    { key:'NEW',       label:'🔔 New',        count:counts.NEW },
    { key:'PREPARING', label:'👨‍🍳 Preparing', count:counts.PREPARING },
    { key:'READY',     label:'✨ Ready',       count:counts.READY },
    { key:'COMPLETED', label:'🎉 Done',        count:counts.COMPLETED },
    { key:'PLATFORM',  label:'📦 Platform',    count:counts.PLATFORM },
    { key:'ALL',       label:'All',            count:counts.ALL }
  ];

  var newHash = chips.map(function(t){return t.key+':'+t.count;}).join('|') + '|active:'+currentFilter;
  if (window._filterHash === newHash) return;
  window._filterHash = newHash;

  var isOrderView = ['ACTIVE','NEW','PREPARING','READY','COMPLETED','PLATFORM','ALL'].indexOf(currentFilter) >= 0;
  var fb = document.getElementById('filterBar');
  fb.style.display = isOrderView ? '' : 'none';

  fb.innerHTML = chips.map(function(t) {
    return '<button class="filter-btn' + (currentFilter===t.key?' active':'') + '" onclick="setFilter(\'' + t.key + '\')">' +
      t.label + '<span class="filter-count">' + t.count + '</span></button>';
  }).join('');

  renderSidebar();
}

function renderSidebar() {
  var role = currentUser ? currentUser.role : '';
  var isAdmin = role === 'ADMIN' || role === 'OWNER';
  var isOwner = role === 'OWNER';

  function item(key, icon, label, badge) {
    var active = currentFilter === key ? ' active' : '';
    var b = badge ? '<span class="sidebar-badge">' + badge + '</span>' : '';
    return '<button class="sidebar-item' + active + '" onclick="setFilter(\'' + key + '\');closeSidebarMobile()">' +
      '<span class="sidebar-icon">' + icon + '</span>' +
      '<span class="sidebar-label">' + label + '</span>' + b +
      '</button>';
  }

  var html = '';

  html += '<div class="sidebar-section-label">Operations</div>';
  html += item('ACTIVE', '🔥', 'Order Queue', '');
  if (role !== 'KITCHEN') html += item('PAYMENTS', '💳', 'Payments', pendingPayCount || '');
  html += item('ONLINE_ORDERS', '🛵', 'Online Orders', onlineOrderPendingCount || '');
  if (isOwner) html += item('REFUNDS', '↩️', 'Refunds', '');
  if (isOwner) html += item('CASH', '💵', 'Cash Sessions', '');

  if (isAdmin) {
    html += '<div class="sidebar-divider"></div>';
    html += '<div class="sidebar-section-label">Management</div>';
    html += item('MENU_MANAGER', '🍽️', 'Menu & Pricing', '');
    html += item('TABLES', '🪑', 'Tables & QR', '');
    html += item('FLOOR_MAP', '🗺️', 'Floor Plan', '');
    html += item('INVENTORY', '📦', 'Inventory', '');
    html += item('ADDONS', '➕', 'Add-ons', '');
  }

  if (isAdmin) {
    html += '<div class="sidebar-divider"></div>';
    html += '<div class="sidebar-section-label">Insights</div>';
    html += item('ANALYTICS', '📈', 'Analytics', '');
    html += item('SHEETS', '📊', 'Sheets Sync', '');
    if (isOwner) html += item('SHIFT', '📋', 'Shift Summary', '');
    if (isOwner) html += item('LOGS', '📜', 'Activity Logs', '');
    if (isOwner) html += item('COSTING', '🧮', 'Menu Costing', '');
  }

  if (isOwner) {
    html += '<div class="sidebar-divider"></div>';
    html += '<div class="sidebar-section-label">Settings</div>';
    html += item('STAFF', '👥', 'Staff & Roles', '');
    html += item('SETTINGS', '⚙️', 'Settings', '');
  }

  var el = document.getElementById('sidebar');
  if (el) el.innerHTML = html;
}

function toggleSidebar() {
  var sb = document.getElementById('sidebar');
  var ov = document.getElementById('sidebarOverlay');
  if (!sb) return;
  sb.classList.toggle('open');
  if (ov) ov.classList.toggle('open');
}

function closeSidebarMobile() {
  var sb = document.getElementById('sidebar');
  var ov = document.getElementById('sidebarOverlay');
  if (sb) sb.classList.remove('open');
  if (ov) ov.classList.remove('open');
}


function setFilter(f) {
  currentFilter = f;
  renderFilters();
  
  var orderGrid = document.getElementById('orderGrid');
  var paymentsView = document.getElementById('paymentsView');
  var menuManagerView = document.getElementById('menuManagerView');
  var onlineOrdersView = document.getElementById('onlineOrdersView');

  // Hide all views first
  orderGrid.style.display = 'none';
  paymentsView.style.display = 'none';
  menuManagerView.style.display = 'none';
  if (onlineOrdersView) onlineOrdersView.style.display = 'none';

  var sheetsView = document.getElementById('sheetsView');
  if (sheetsView) sheetsView.style.display = 'none';

  var analyticsView = document.getElementById('analyticsView');
  if (analyticsView) analyticsView.style.display = 'none';

  var tablesView = document.getElementById('tablesView');
  if (tablesView) tablesView.style.display = 'none';

  var settingsView = document.getElementById('settingsView');
  if (settingsView) settingsView.style.display = 'none';
  var staffView = document.getElementById('staffView');
  if (staffView) staffView.style.display = 'none';
  var shiftView = document.getElementById('shiftView');
  if (shiftView) shiftView.style.display = 'none';
  var logsView = document.getElementById('logsView');
  if (logsView) logsView.style.display = 'none';
  var floorMapView = document.getElementById('floorMapView');
  if (floorMapView) floorMapView.style.display = 'none';
  var inventoryView = document.getElementById('inventoryView');
  if (inventoryView) inventoryView.style.display = 'none';
  var addonsView = document.getElementById('addonsView');
  if (addonsView) addonsView.style.display = 'none';
  var refundsView = document.getElementById('refundsView');
  if (refundsView) refundsView.style.display = 'none';
  var cashView = document.getElementById('cashView');
  if (cashView) cashView.style.display = 'none';

  var costingView = document.getElementById('costingView');
  if (costingView) costingView.style.display = 'none';

  if (f === 'PAYMENTS') {
    paymentsView.style.display = 'block';
    loadPayments();
  } else if (f === 'MENU_MANAGER') {
    menuManagerView.style.display = 'block';
    loadMenuManager();
  } else if (f === 'ONLINE_ORDERS') {
    if (onlineOrdersView) onlineOrdersView.style.display = 'block';
    loadOnlineOrders();
  } else if (f === 'SHEETS') {
    if (sheetsView) sheetsView.style.display = 'block';
    loadSheetsData();
  } else if (f === 'ANALYTICS') {
    if (analyticsView) analyticsView.style.display = 'block';
    loadAnalytics();
  } else if (f === 'TABLES') {
    if (tablesView) tablesView.style.display = 'block';
    loadOrders().then(function() { loadTablesView(); });
  } else if (f === 'FLOOR_MAP') {
    if (floorMapView) floorMapView.style.display = 'block';
    loadFloorMap();
  } else if (f === 'INVENTORY') {
    if (inventoryView) inventoryView.style.display = 'block';
    loadInventoryView();
  } else if (f === 'ADDONS') {
    if (addonsView) addonsView.style.display = 'block';
    loadAddonsView();
  } else if (f === 'REFUNDS') {
    if (refundsView) refundsView.style.display = 'block';
    loadRefundsView();
  } else if (f === 'CASH') {
    if (cashView) cashView.style.display = 'block';
    loadCashView();
  } else if (f === 'SETTINGS') {
    if (settingsView) settingsView.style.display = 'block';
    loadSettings();
  } else if (f === 'STAFF') {
    var sv = document.getElementById('staffView');
    if (sv) sv.style.display = 'block';
    loadStaffTab();
  } else if (f === 'SHIFT') {
    var shv = document.getElementById('shiftView');
    if (shv) shv.style.display = 'block';
    loadShiftSummary();
  } else if (f === 'HISTORY') {
    renderHistoryTab();
  } else if (f === 'LOGS') {
    var lv = document.getElementById('logsView');
    if (lv) lv.style.display = 'block';
    loadAuditLogs();
  } else if (f === 'COSTING') {
    var cv2 = document.getElementById('costingView');
    if (cv2) cv2.style.display = 'block';
    loadCostingView();
  } else {
    orderGrid.style.display = '';
    renderOrders();
  }
}

// ══════════════════════════════════════════════════════════
// RENDER ORDERS
// ══════════════════════════════════════════════════════════
function renderOrders() {
  var filtered = allOrders.filter(function(o) {
    if (currentFilter === 'ALL') return true;
    if (currentFilter === 'ACTIVE') return !o.isTest && (o.status === 'NEW' || o.status === 'PREPARING' || o.status === 'READY');
    if (currentFilter === 'PLATFORM') return !!o.platform;
    // For status-based filters (NEW/PREPARING/READY/COMPLETED/CANCELLED), hide test orders
    if (['NEW','PREPARING','READY'].includes(currentFilter)) return !o.isTest && o.status === currentFilter;
    return o.status === currentFilter;
  });

  // Sort: NEW first, then PREPARING, then READY, newest first within status
  var statusOrder = { NEW:0, PREPARING:1, READY:2, COMPLETED:3, CANCELLED:4 };
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
    
    html += '<div class="oc-meta">' +
      '<div class="oc-meta-item">' + tableLabel + '</div>' +
      (o.customer ? '<div class="oc-meta-item">👤 ' + esc(o.customer) + '</div>' : '') +
      '<div class="oc-meta-item">' + typeIcon + ' ' + typeLabel + '</div>' +
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
        var opts = [];
        if (it.size) opts.push(capitalize(it.size));
        if (it.sugar) opts.push(capitalize(it.sugar));
        var lineTotal = (it.price || 0) * (it.qty || 1);
        orderTotal += lineTotal;
        var prepIcon = it.prepared ? '✅' : '⬜';
        var prepStyle = it.prepared ? 'opacity:.5;text-decoration:line-through;' : '';
        html += '<div class="oc-item" data-item-id="' + (it.id||'') + '" style="' + prepStyle + 'cursor:pointer;user-select:none;" title="' + (it.prepared ? 'Tap to unmark' : 'Tap to mark prepared') + '" onclick="adminTogglePrep(this,\'' + esc(o.orderId) + '\',' + (it.id||0) + ',' + (it.prepared ? 1 : 0) + ')">' +
          '<span style="font-size:1.3rem;margin-right:6px;flex-shrink:0;line-height:1;">' + prepIcon + '</span>' +
          '<div class="oc-item-qty">' + (it.qty || 1) + '×</div>' +
          '<div class="oc-item-info">' +
            '<div class="oc-item-name">' + esc(it.name) + '</div>' +
            (opts.length ? '<div class="oc-item-opts">' + esc(opts.join(' · ')) + '</div>' : '') +
            (it.addons && it.addons.length ? '<div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:4px">' + it.addons.map(function(a){ return '<span style="background:#dcfce7;color:#14532d;border:1.5px solid #86efac;border-radius:6px;padding:2px 8px;font-size:.75rem;font-weight:800">➕ ' + esc(a.name) + ' +₱' + parseFloat(a.price||0).toFixed(0) + '</span>'; }).join('') + '</div>' : '') +
            (it.notes ? '<div class="oc-item-notes">"' + esc(it.notes) + '"</div>' : '') +
          '</div>' +
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
      if (canSetPayment) {
        html += '<div class="oc-payment-row">'
          + '<div class="oc-payment none">⏳ No payment yet</div>'
          + '<button class="oc-pm-set" onclick="openPaymentModal(\'' + esc(o.orderId) + '\')">Set Payment</button>'
          + '</div>';
      } else {
        html += '<div class="oc-payment none">⏳ No payment yet</div>';
      }
    }

    // Notes
    if (o.notes && typeof o.notes === 'string' && o.notes.trim()) {
      html += '<div class="oc-notes">📝 ' + esc(o.notes) + '</div>';
    }

    // Discount display
    var canDiscount = (currentUser.role === 'OWNER' || currentUser.role === 'ADMIN' || currentUser.role === 'CASHIER');
    if (o.discountType && parseFloat(o.discountAmount) > 0) {
      var dtLabel = {PWD:'PWD 20%',SENIOR:'Senior 20%',BOTH:'PWD+Senior',PROMO:'Promo',CUSTOM:'Custom'}[o.discountType] || o.discountType;
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
        if (act === 'start') html += '<button class="oc-btn oc-btn-start" onclick="updateStatus(\'' + o.orderId + '\',\'PREPARING\')">☕ Start Preparing</button>';
        if (act === 'ready') html += '<button class="oc-btn oc-btn-ready" onclick="updateStatus(\'' + o.orderId + '\',\'READY\')">✨ Mark Ready</button>';
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
    if (canPay && order && order.orderType !== 'PLATFORM') {
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

function openStaffPOS() {
  spCart = []; spOrderType = 'DINE_IN'; spTableNo = ''; spSelectedCat = 'ALL';
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
  // Map occupied tables
  var occupied = {};
  allOrders.forEach(function(o) {
    if (['NEW','PREPARING','READY'].includes(o.status) && !o.isTest && o.tableNo) occupied[String(o.tableNo)] = true;
  });
  var tables = _allTables.length > 0 ? _allTables : [];
  grid.innerHTML = tables.map(function(tbl) {
    var tno = String(tbl.table_number);
    var name = tbl.table_name || ('Table ' + tno);
    var isOcc = !!occupied[tno];
    var isActive = spTableNo === tno;
    var cls = 'sp-tbl-btn' + (isActive ? ' active' : isOcc ? ' occupied' : '');
    return '<button class="' + cls + '" onclick="spSelectTable(\'' + tno + '\')" title="' + esc(name) + '">' +
      esc(name) + (isOcc ? '<br><span style="font-size:.58rem">🔴 busy</span>' : '') +
    '</button>';
  }).join('');
}

function spSelectTable(tno) {
  spTableNo = tno;
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
  btn.disabled = true; btn.textContent = '⏳ Placing…';

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
  buildMenuCatTabs();
  renderMenuMgrGrid();
}

function buildMenuCatTabs() {
  var cats = [];
  menuMgrItems.forEach(function(item) {
    var c = (item.category || 'Other').trim();
    if (cats.indexOf(c) === -1) cats.push(c);
  });
  cats.sort();
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

  // Confirmation required when DEACTIVATING to prevent accidental toggles
  if (currentlyActive) {
    var confirmed = confirm('Hide "' + item.name + '" from the menu?\n\nCustomers will not see it on the QR menu until you turn it back on.');
    if (!confirmed) return; // User cancelled — do nothing
  }

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

// ══════════════════════════════════════════════════════════
// MENU COSTING VIEW (OWNER only)
// ══════════════════════════════════════════════════════════
var _costingTab = 'dashboard';
var _costingIngredients = [];
var _costingRecipes = [];
var _activeRecipeId = null;

async function loadCostingView() {
  var view = document.getElementById('costingView');
  if (!view) return;
  view.innerHTML = '<div style="padding:24px;text-align:center;color:var(--timber)">Loading costing data...</div>';
  try {
    var sb = _supabaseClient;
    var [ingRes, recRes, riRes] = await Promise.all([
      sb.from('costing_ingredients').select('*').order('category').order('name'),
      sb.from('costing_recipes').select('*').order('category').order('name'),
      sb.from('costing_recipe_ingredients').select('*')
    ]);
    _costingIngredients = ingRes.data || [];
    _costingRecipes = (recRes.data || []).map(function(r) {
      r.ingredients = (riRes.data || []).filter(function(ri) { return ri.recipe_id === r.id; });
      return r;
    });
  } catch(e) {
    view.innerHTML = '<div style="padding:24px;color:var(--terra)">Error loading costing data: ' + e.message + '</div>';
    return;
  }
  renderCostingShell();
}

function recipeTotalCost(r) {
  return (r.ingredients || []).reduce(function(s, ri) {
    var ing = _costingIngredients.find(function(i) { return i.id === ri.ingredient_id; });
    return s + (ing ? Number(ing.cost_per_unit) * Number(ri.qty) : 0);
  }, 0);
}

function fcPct(cost, price) {
  if (!price || price === 0) return null;
  return cost / price * 100;
}

function fcPill(pct) {
  if (pct === null) return '<span style="font-size:.72rem;color:var(--timber)">—</span>';
  var color = pct < 28 ? '#15803d' : pct < 35 ? '#0f766e' : pct < 40 ? '#b45309' : '#dc2626';
  var bg    = pct < 28 ? '#dcfce7' : pct < 35 ? '#ccfbf1' : pct < 40 ? '#fef3c7' : '#fee2e2';
  return '<span style="background:' + bg + ';color:' + color + ';padding:2px 8px;border-radius:20px;font-size:.7rem;font-weight:700;font-family:var(--font-body)">' + pct.toFixed(1) + '%</span>';
}

function fcStatus(pct) {
  if (pct === null) return '—';
  if (pct < 28) return '✅ Excellent';
  if (pct < 35) return '🟢 Good';
  if (pct < 40) return '🟡 Review';
  return '🔴 Critical';
}

function phpFmt(n) {
  return '₱' + Number(n).toLocaleString('en-PH', {minimumFractionDigits:2, maximumFractionDigits:2});
}

function renderCostingShell() {
  var view = document.getElementById('costingView');
  var costed = _costingRecipes.filter(function(r) { return recipeTotalCost(r) > 0; });
  var avgFC = costed.length ? costed.reduce(function(s,r){return s+fcPct(recipeTotalCost(r),r.selling_price);},0)/costed.length : null;
  var critical = costed.filter(function(r){return fcPct(recipeTotalCost(r),r.selling_price)>=40;}).length;
  var avgProfit = costed.length ? costed.reduce(function(s,r){return s+(r.selling_price-recipeTotalCost(r));},0)/costed.length : null;

  var fcColor = avgFC===null?'var(--timber)':avgFC<28?'#15803d':avgFC<35?'#0f766e':avgFC<40?'#b45309':'#dc2626';

  var tabs = ['dashboard','inventory','recipe','pricing'];
  var tabLabels = {'dashboard':'📊 Dashboard','inventory':'🥛 Ingredients','recipe':'📋 Recipe Costing','pricing':'💰 Menu Pricing'};

  var html = '<div style="padding:16px 16px 0">';
  // Header
  html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px">';
  html += '<div><div style="font-family:var(--font-soul);font-size:1.3rem;font-weight:700;color:var(--forest-deep)">🧮 Menu Costing</div>';
  html += '<div style="font-size:.72rem;color:var(--timber);margin-top:2px">Food cost analysis • Ingredient costing • Margin tracking</div></div>';
  html += '</div>';
  // Metric cards
  html += '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px">';
  html += '<div style="background:var(--white);border-radius:var(--r-md);padding:12px 14px;box-shadow:var(--shadow-sm)">';
  html += '<div style="font-size:.65rem;color:var(--timber);font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Menu Items</div>';
  html += '<div style="font-family:var(--font-soul);font-size:1.5rem;font-weight:700;color:var(--forest)">' + _costingRecipes.length + '</div></div>';
  html += '<div style="background:var(--white);border-radius:var(--r-md);padding:12px 14px;box-shadow:var(--shadow-sm)">';
  html += '<div style="font-size:.65rem;color:var(--timber);font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Avg Food Cost</div>';
  html += '<div style="font-family:var(--font-soul);font-size:1.5rem;font-weight:700;color:' + fcColor + '">' + (avgFC !== null ? avgFC.toFixed(1) + '%' : '—') + '</div></div>';
  html += '<div style="background:var(--white);border-radius:var(--r-md);padding:12px 14px;box-shadow:var(--shadow-sm)">';
  html += '<div style="font-size:.65rem;color:var(--timber);font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Avg Gross Profit</div>';
  html += '<div style="font-family:var(--font-soul);font-size:1.5rem;font-weight:700;color:var(--forest)">' + (avgProfit !== null ? phpFmt(avgProfit) : '—') + '</div></div>';
  html += '<div style="background:var(--white);border-radius:var(--r-md);padding:12px 14px;box-shadow:var(--shadow-sm)">';
  html += '<div style="font-size:.65rem;color:var(--timber);font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Critical Items</div>';
  html += '<div style="font-family:var(--font-soul);font-size:1.5rem;font-weight:700;color:' + (critical > 0 ? '#dc2626' : '#15803d') + '">' + (costed.length ? critical : '—') + '</div></div>';
  html += '</div>';
  // Sub-tabs
  html += '<div style="display:flex;gap:2px;border-bottom:2px solid var(--mist);margin-bottom:0">';
  tabs.forEach(function(t) {
    var active = _costingTab === t;
    html += '<button onclick="setCostingTab(\'' + t + '\')" style="padding:9px 14px;font-size:.75rem;font-weight:700;font-family:var(--font-body);border:none;cursor:pointer;background:transparent;color:' + (active?'var(--forest)':'var(--timber)') + ';border-bottom:2px solid ' + (active?'var(--forest)':'transparent') + ';margin-bottom:-2px;white-space:nowrap">' + tabLabels[t] + '</button>';
  });
  html += '</div></div>';
  // Panel area
  html += '<div id="costing-panel" style="padding:16px"></div>';
  view.innerHTML = html;
  renderCostingPanel();
}

function setCostingTab(t) {
  _costingTab = t;
  _activeRecipeId = null;
  renderCostingShell();
}

function renderCostingPanel() {
  var panel = document.getElementById('costing-panel');
  if (!panel) return;
  if (_costingTab === 'dashboard') renderCostingDashboard(panel);
  else if (_costingTab === 'inventory') renderCostingInventory(panel);
  else if (_costingTab === 'recipe') renderCostingRecipe(panel);
  else if (_costingTab === 'pricing') renderCostingPricing(panel);
}

function costingCard(content) {
  return '<div style="background:var(--white);border-radius:var(--r-lg);box-shadow:var(--shadow-sm);padding:16px;margin-bottom:14px">' + content + '</div>';
}

function costingSectionTitle(t) {
  return '<div style="font-size:.65rem;font-weight:700;color:var(--timber);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">' + t + '</div>';
}

function renderCostingDashboard(panel) {
  var costed = _costingRecipes.filter(function(r) { return recipeTotalCost(r) > 0; });
  if (!costed.length) { panel.innerHTML = '<div style="padding:2rem;text-align:center;color:var(--timber)">No recipes costed yet. Go to Recipe Costing tab to add ingredients.</div>'; return; }

  var sorted = costed.slice().sort(function(a,b) { return fcPct(recipeTotalCost(a),a.selling_price)-fcPct(recipeTotalCost(b),b.selling_price); });
  var best = sorted.slice(0,5);
  var worst = sorted.slice(-5).reverse();

  var html = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">';
  // Best margin
  html += '<div>' + costingCard(costingSectionTitle('Best margin items') + best.map(function(r) {
    var pct = fcPct(recipeTotalCost(r),r.selling_price);
    var barW = Math.min(100, 100 - pct);
    return '<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--mist-light)">'
      + '<div><div style="font-size:.78rem;font-weight:600;color:var(--forest-deep)">' + r.name + '</div>'
      + '<div style="background:var(--mist);border-radius:4px;height:5px;width:120px;margin-top:3px;overflow:hidden"><div style="height:100%;background:#15803d;width:' + barW + '%"></div></div></div>'
      + fcPill(pct) + '</div>';
  }).join('')) + '</div>';

  // Highest FC
  html += '<div>' + costingCard(costingSectionTitle('Highest food cost — review pricing') + worst.map(function(r) {
    var pct = fcPct(recipeTotalCost(r),r.selling_price);
    var barColor = pct >= 40 ? '#dc2626' : pct >= 35 ? '#b45309' : '#0f766e';
    var barW = Math.min(100, pct * 2);
    return '<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--mist-light)">'
      + '<div><div style="font-size:.78rem;font-weight:600;color:var(--forest-deep)">' + r.name + '</div>'
      + '<div style="background:var(--mist);border-radius:4px;height:5px;width:120px;margin-top:3px;overflow:hidden"><div style="height:100%;background:' + barColor + ';width:' + barW + '%"></div></div></div>'
      + fcPill(pct) + '</div>';
  }).join('')) + '</div>';

  html += '</div>';

  // All items table
  html += costingCard(costingSectionTitle('All costed items')
    + '<div style="overflow-x:auto;max-height:440px;overflow-y:auto"><table style="width:100%;border-collapse:collapse;font-size:.78rem">'
    + '<thead><tr style="border-bottom:2px solid var(--mist)">'
    + '<th style="text-align:left;padding:6px 8px;color:var(--timber);font-weight:600;position:sticky;top:0;z-index:2;background:var(--white)">Item</th>'
    + '<th style="text-align:left;padding:6px 8px;color:var(--timber);font-weight:600;position:sticky;top:0;z-index:2;background:var(--white)">Category</th>'
    + '<th style="text-align:right;padding:6px 8px;color:var(--timber);font-weight:600;position:sticky;top:0;z-index:2;background:var(--white)">Cost</th>'
    + '<th style="text-align:right;padding:6px 8px;color:var(--timber);font-weight:600;position:sticky;top:0;z-index:2;background:var(--white)">Price</th>'
    + '<th style="text-align:center;padding:6px 8px;color:var(--timber);font-weight:600;position:sticky;top:0;z-index:2;background:var(--white)">FC%</th>'
    + '<th style="text-align:right;padding:6px 8px;color:var(--timber);font-weight:600;position:sticky;top:0;z-index:2;background:var(--white)">Profit</th>'
    + '</tr></thead><tbody>'
    + costed.map(function(r) {
        var cost = recipeTotalCost(r);
        var pct = fcPct(cost, r.selling_price);
        var profit = r.selling_price - cost;
        return '<tr style="border-bottom:1px solid var(--mist-light)">'
          + '<td style="padding:7px 8px;font-weight:600;color:var(--forest-deep)">' + r.name + '</td>'
          + '<td style="padding:7px 8px"><span style="font-size:.65rem;color:var(--timber);text-transform:uppercase">' + r.category + '</span></td>'
          + '<td style="padding:7px 8px;text-align:right;font-family:monospace">' + phpFmt(cost) + '</td>'
          + '<td style="padding:7px 8px;text-align:right;font-family:monospace">' + phpFmt(r.selling_price) + '</td>'
          + '<td style="padding:7px 8px;text-align:center">' + fcPill(pct) + '</td>'
          + '<td style="padding:7px 8px;text-align:right;font-family:monospace;color:' + (profit >= 0 ? '#15803d' : '#dc2626') + '">' + phpFmt(profit) + '</td>'
          + '</tr>';
      }).join('')
    + '</tbody></table></div>');

  panel.innerHTML = html;
}

function renderCostingInventory(panel) {
  var catGroups = {};
  _costingIngredients.forEach(function(i) {
    var c = i.category || 'Other';
    if (!catGroups[c]) catGroups[c] = [];
    catGroups[c].push(i);
  });

  var html = '<div style="display:flex;justify-content:flex-end;margin-bottom:12px">'
    + '<button onclick="openCostingIngModal()" style="padding:8px 16px;background:var(--forest);color:var(--white);border:none;border-radius:var(--r-md);font-size:.78rem;font-weight:700;font-family:var(--font-body);cursor:pointer">+ Add ingredient</button>'
    + '</div>';

  Object.keys(catGroups).sort().forEach(function(cat) {
    var isCoffee = cat === 'Coffee';
    var thead = '<thead><tr>'
      + '<th style="text-align:left;padding:5px 8px;color:var(--timber);font-weight:600;position:sticky;top:0;z-index:2;background:var(--mist-light)">Ingredient</th>'
      + '<th style="text-align:center;padding:5px 8px;color:var(--timber);font-weight:600;position:sticky;top:0;z-index:2;background:var(--mist-light)">Unit</th>'
      + '<th style="text-align:right;padding:5px 8px;color:var(--timber);font-weight:600;position:sticky;top:0;z-index:2;background:var(--mist-light)">Cost / g</th>'
      + (isCoffee ? '<th style="text-align:right;padding:5px 8px;color:var(--terra);font-weight:600;position:sticky;top:0;z-index:2;background:var(--mist-light)">1 shot (9g)</th><th style="text-align:right;padding:5px 8px;color:var(--forest);font-weight:600;position:sticky;top:0;z-index:2;background:var(--mist-light)">2 shots (18g)</th>' : '')
      + '<th style="text-align:right;padding:5px 8px;position:sticky;top:0;z-index:2;background:var(--mist-light)"></th></tr></thead>';

    html += costingCard(costingSectionTitle(cat)
      + '<div style="overflow-x:auto;max-height:360px;overflow-y:auto"><table style="width:100%;border-collapse:collapse;font-size:.78rem">'
      + thead + '<tbody>'
      + catGroups[cat].map(function(i) {
          var shot1 = (Number(i.cost_per_unit) * 9).toFixed(2);
          var shot2 = (Number(i.cost_per_unit) * 18).toFixed(2);
          return '<tr style="border-top:1px solid var(--mist-light)">'
            + '<td style="padding:7px 8px;font-weight:600;color:var(--forest-deep)">' + i.name + '</td>'
            + '<td style="padding:7px 8px;text-align:center;color:var(--timber)">' + i.unit + '</td>'
            + '<td style="padding:7px 8px;text-align:right;font-family:monospace">' + phpFmt(i.cost_per_unit) + ' / ' + i.unit + '</td>'
            + (isCoffee
              ? '<td style="padding:7px 8px;text-align:right;font-family:monospace;color:var(--terra);font-weight:600">₱' + shot1 + '</td>'
              + '<td style="padding:7px 8px;text-align:right;font-family:monospace;color:var(--forest);font-weight:700">₱' + shot2 + '</td>'
              : '')
            + '<td style="padding:7px 8px;text-align:right;white-space:nowrap">'
            + '<button onclick="openCostingIngModal(' + i.id + ')" style="padding:3px 10px;font-size:.68rem;font-weight:700;font-family:var(--font-body);border:1.5px solid var(--mist);background:transparent;border-radius:var(--r-sm);cursor:pointer;color:var(--timber);margin-right:4px">Edit</button>'
            + '<button onclick="deleteCostingIng(' + i.id + ')" style="padding:3px 10px;font-size:.68rem;font-weight:700;font-family:var(--font-body);border:1.5px solid #fca5a5;background:transparent;border-radius:var(--r-sm);cursor:pointer;color:#dc2626">Remove</button>'
            + '</td></tr>';
        }).join('')
      + '</tbody></table></div>');
  });

  if (!_costingIngredients.length) html += '<div style="padding:2rem;text-align:center;color:var(--timber)">No ingredients yet. Add your first one.</div>';

  // Inline add/edit modal
  html += '<div id="costing-ing-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:500;align-items:center;justify-content:center">'
    + '<div style="background:var(--white);border-radius:var(--r-xl);padding:24px;width:340px;max-width:90vw;box-shadow:var(--shadow-md)">'
    + '<div id="costing-ing-modal-title" style="font-family:var(--font-soul);font-size:1.1rem;font-weight:700;color:var(--forest-deep);margin-bottom:16px">Add ingredient</div>'
    + '<input type="hidden" id="cing-id">'
    + '<div style="margin-bottom:12px"><label style="font-size:.72rem;font-weight:700;color:var(--timber);display:block;margin-bottom:4px">Ingredient name</label>'
    + '<input id="cing-name" placeholder="e.g. Espresso beans" style="width:100%;padding:9px 12px;border:1.5px solid var(--mist);border-radius:var(--r-md);font-size:.85rem;font-family:var(--font-body);outline:none"></div>'
    + '<div style="margin-bottom:12px"><label style="font-size:.72rem;font-weight:700;color:var(--timber);display:block;margin-bottom:4px">Unit</label>'
    + '<select id="cing-unit" style="width:100%;padding:9px 12px;border:1.5px solid var(--mist);border-radius:var(--r-md);font-size:.85rem;font-family:var(--font-body)">'
    + ['g','ml','pc','kg','L','tsp','tbsp','cup','sachet','pack'].map(function(u){return'<option>'+u+'</option>';}).join('')
    + '</select></div>'
    + '<div style="margin-bottom:12px"><label style="font-size:.72rem;font-weight:700;color:var(--timber);display:block;margin-bottom:4px">Cost per unit (₱)</label>'
    + '<input id="cing-cost" type="number" step="0.001" placeholder="0.00" style="width:100%;padding:9px 12px;border:1.5px solid var(--mist);border-radius:var(--r-md);font-size:.85rem;font-family:var(--font-body);outline:none"></div>'
    + '<div style="margin-bottom:16px"><label style="font-size:.72rem;font-weight:700;color:var(--timber);display:block;margin-bottom:4px">Category</label>'
    + '<select id="cing-cat" style="width:100%;padding:9px 12px;border:1.5px solid var(--mist);border-radius:var(--r-md);font-size:.85rem;font-family:var(--font-body)">'
    + ['Coffee','Dairy','Syrups & Powder','Bread & Pastry','Packaging','Other'].map(function(c){return'<option>'+c+'</option>';}).join('')
    + '</select></div>'
    + '<div style="display:flex;gap:10px;justify-content:flex-end">'
    + '<button onclick="closeCostingIngModal()" style="padding:9px 18px;border:1.5px solid var(--mist);background:transparent;border-radius:var(--r-md);font-size:.78rem;font-weight:700;font-family:var(--font-body);cursor:pointer;color:var(--timber)">Cancel</button>'
    + '<button onclick="saveCostingIng()" style="padding:9px 18px;background:var(--forest);color:var(--white);border:none;border-radius:var(--r-md);font-size:.78rem;font-weight:700;font-family:var(--font-body);cursor:pointer">Save</button>'
    + '</div></div></div>';

  panel.innerHTML = html;
}

function openCostingIngModal(id) {
  var modal = document.getElementById('costing-ing-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  if (id) {
    var ing = _costingIngredients.find(function(i){return i.id===id;});
    if (ing) {
      document.getElementById('costing-ing-modal-title').textContent = 'Edit ingredient';
      document.getElementById('cing-id').value = id;
      document.getElementById('cing-name').value = ing.name;
      document.getElementById('cing-unit').value = ing.unit;
      document.getElementById('cing-cost').value = ing.cost_per_unit;
      document.getElementById('cing-cat').value = ing.category || 'Other';
    }
  } else {
    document.getElementById('costing-ing-modal-title').textContent = 'Add ingredient';
    document.getElementById('cing-id').value = '';
    document.getElementById('cing-name').value = '';
    document.getElementById('cing-cost').value = '';
  }
}

function closeCostingIngModal() {
  var modal = document.getElementById('costing-ing-modal');
  if (modal) modal.style.display = 'none';
}

async function saveCostingIng() {
  var id = document.getElementById('cing-id').value;
  var payload = {
    name: document.getElementById('cing-name').value.trim(),
    unit: document.getElementById('cing-unit').value,
    cost_per_unit: parseFloat(document.getElementById('cing-cost').value),
    category: document.getElementById('cing-cat').value
  };
  if (!payload.name || isNaN(payload.cost_per_unit)) { showToast('Name and cost required'); return; }
  var sb = _supabaseClient;
  if (id) {
    await sb.from('costing_ingredients').update(payload).eq('id', parseInt(id));
  } else {
    await sb.from('costing_ingredients').insert(payload);
  }
  closeCostingIngModal();
  await loadCostingView();
  setCostingTab('inventory');
}

async function deleteCostingIng(id) {
  if (!confirm('Remove this ingredient? It will be removed from all recipes.')) return;
  await _supabaseClient.from('costing_ingredients').delete().eq('id', id);
  await loadCostingView();
  setCostingTab('inventory');
}

var _costingCatFilter = 'ALL';

function getCostingCatStyle(cat) {
  var map = {
    'HOT':         {bg:'#fef3c7',color:'#92400e'},
    'ICE BLENDED': {bg:'#dbeafe',color:'#1e40af'},
    'COLD':        {bg:'#e0f2fe',color:'#0369a1'},
    'PASTRY':      {bg:'#fce7f3',color:'#9d174d'},
    'PASTA':       {bg:'#fef9c3',color:'#854d0e'},
    'MEAL':        {bg:'#d1fae5',color:'#065f46'},
    'BEST WITH':   {bg:'#ede9fe',color:'#5b21b6'},
    'OTHER':       {bg:'#f1f5f9',color:'#475569'},
  };
  return map[cat] || {bg:'#f1f5f9',color:'#475569'};
}

function renderCostingRecipe(panel) {
  var allCats = ['ALL'];
  _costingRecipes.forEach(function(r) { if (r.category && allCats.indexOf(r.category) < 0) allCats.push(r.category); });
  var catOrder = ['ALL','HOT','ICE BLENDED','COLD','PASTRY','PASTA','MEAL','BEST WITH','OTHER'];
  allCats.sort(function(a,b){ var ai=catOrder.indexOf(a),bi=catOrder.indexOf(b); return (ai<0?99:ai)-(bi<0?99:bi); });

  var filtered = _costingCatFilter === 'ALL' ? _costingRecipes : _costingRecipes.filter(function(r){return r.category===_costingCatFilter;});

  // Category filter chips
  var chipsHtml = '<div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:10px">';
  allCats.forEach(function(c) {
    var active = _costingCatFilter === c;
    var st = c === 'ALL' ? {bg:'var(--forest)',color:'var(--white)'} : getCostingCatStyle(c);
    chipsHtml += '<button onclick="setCostingRecCat(\'' + c + '\')" style="padding:3px 10px;font-size:.62rem;font-weight:700;font-family:var(--font-body);border:1.5px solid ' + (active?(c==='ALL'?'var(--forest)':st.color):'var(--mist)') + ';background:' + (active?(c==='ALL'?'var(--forest)':st.bg):'transparent') + ';color:' + (active?(c==='ALL'?'var(--white)':st.color):'var(--timber)') + ';border-radius:20px;cursor:pointer;white-space:nowrap">' + (c==='ALL'?'All ('+_costingRecipes.length+')':c+' ('+_costingRecipes.filter(function(r){return r.category===c;}).length+')') + '</button>';
  });
  chipsHtml += '</div>';

  var listHtml = filtered.map(function(r) {
    var cost = recipeTotalCost(r);
    var pct = fcPct(cost, r.selling_price);
    var active = _activeRecipeId === r.id;
    var st = getCostingCatStyle(r.category);
    return '<div onclick="selectCostingRecipe(' + r.id + ')" style="cursor:pointer;padding:9px 11px;border-radius:var(--r-md);border:1.5px solid ' + (active?'var(--forest)':'var(--mist)') + ';background:' + (active?'#f0fdf4':'var(--white)') + ';margin-bottom:6px;transition:all .15s">'
      + '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:4px">'
      + '<div style="font-size:.75rem;font-weight:700;color:var(--forest-deep);line-height:1.3">' + r.name + '</div>'
      + '<span style="background:' + st.bg + ';color:' + st.color + ';font-size:.55rem;font-weight:700;padding:1px 6px;border-radius:20px;white-space:nowrap;flex-shrink:0">' + r.category + '</span>'
      + '</div>'
      + '<div style="font-size:.65rem;color:' + (cost>0?(pct>=40?'#dc2626':pct>=35?'#b45309':'var(--timber)'):'var(--timber)') + ';margin-top:2px">'
      + (cost > 0 ? phpFmt(cost) + ' cost · ' + (pct ? pct.toFixed(1) + '% FC' : '') : '<span style="color:var(--mist-light)">— no recipe yet</span>')
      + '</div></div>';
  }).join('') || '<div style="color:var(--timber);font-size:.78rem;padding:8px 0">No items in this category</div>';

  var editorHtml = '';
  if (_activeRecipeId) {
    var rec = _costingRecipes.find(function(r){return r.id===_activeRecipeId;});
    if (rec) {
      var cost = recipeTotalCost(rec);
      var pct = fcPct(cost, rec.selling_price);
      var profit = rec.selling_price - cost;
      var suggestedPrice = cost > 0 ? Math.ceil(cost / 0.30 / 5) * 5 : null;

      var ingRows = (rec.ingredients || []).map(function(ri, idx) {
        var ing = _costingIngredients.find(function(i){return i.id===ri.ingredient_id;});
        var rowCost = ing ? Number(ing.cost_per_unit) * Number(ri.qty) : 0;
        var opts = _costingIngredients.map(function(i){return '<option value="'+i.id+'"'+(i.id===ri.ingredient_id?' selected':'')+'>'+i.name+' (₱'+i.cost_per_unit+'/'+i.unit+')</option>';}).join('');
        return '<div style="display:grid;grid-template-columns:1fr 80px 90px auto;gap:8px;align-items:center;margin-bottom:8px">'
          + '<select onchange="updateRecipeIng('+rec.id+','+idx+',\'iid\',this.value)" style="padding:6px 8px;font-size:.72rem;border:1.5px solid var(--mist);border-radius:var(--r-sm);font-family:var(--font-body);background:var(--white)">' + opts + '</select>'
          + '<input type="number" step="0.1" value="'+ri.qty+'" onchange="updateRecipeIng('+rec.id+','+idx+',\'qty\',this.value)" oninput="updateRecipeIng('+rec.id+','+idx+',\'qty\',this.value)" style="padding:6px 8px;font-size:.72rem;border:1.5px solid var(--mist);border-radius:var(--r-sm);text-align:right;width:100%">'
          + '<div style="font-size:.68rem;color:var(--timber);text-align:right;padding:0 4px">'+(ing?'= '+phpFmt(rowCost):'')+'</div>'
          + '<button onclick="removeRecipeIng('+rec.id+','+idx+')" style="padding:4px 8px;border:1.5px solid #fca5a5;background:transparent;border-radius:var(--r-sm);font-size:.7rem;cursor:pointer;color:#dc2626;font-family:var(--font-body)">×</button>'
          + '</div>';
      }).join('');

      editorHtml = '<div style="background:var(--white);border-radius:var(--r-lg);box-shadow:var(--shadow-sm);padding:16px">'
        + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px">'
        + '<div style="font-family:var(--font-soul);font-size:1.05rem;font-weight:700;color:var(--forest-deep)">' + rec.name + '</div>'
        + '<div style="display:flex;gap:6px"><button onclick="openCostingRecModal('+rec.id+')" style="padding:5px 12px;border:1.5px solid var(--mist);background:transparent;border-radius:var(--r-sm);font-size:.7rem;font-weight:700;font-family:var(--font-body);cursor:pointer;color:var(--timber)">Edit</button>'
        + '<button onclick="deleteCostingRec('+rec.id+')" style="padding:5px 12px;border:1.5px solid #fca5a5;background:transparent;border-radius:var(--r-sm);font-size:.7rem;font-weight:700;font-family:var(--font-body);cursor:pointer;color:#dc2626">Delete</button></div>'
        + '</div>'
        + '<div style="font-size:.72rem;color:var(--timber);margin-bottom:12px">Selling price: <strong style="color:var(--forest-deep)">' + phpFmt(rec.selling_price) + '</strong></div>'
        + '<div style="font-size:.65rem;font-weight:700;color:var(--timber);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Ingredients</div>'
        + '<div style="font-size:.65rem;color:var(--timber);display:grid;grid-template-columns:1fr 80px 90px auto;gap:8px;margin-bottom:6px;padding:0 4px">'
        + '<span>Ingredient</span><span style="text-align:right">Qty</span><span style="text-align:right">Line cost</span><span></span></div>'
        + ingRows
        + '<button onclick="addRecipeIng('+rec.id+')" style="margin-top:4px;padding:6px 14px;border:1.5px dashed var(--mist);background:transparent;border-radius:var(--r-sm);font-size:.72rem;font-weight:600;font-family:var(--font-body);cursor:pointer;color:var(--timber)">+ Add ingredient</button>'
        + '<div style="background:var(--mist-light);border-radius:var(--r-md);padding:12px 14px;margin-top:14px">'
        + '<div style="display:flex;justify-content:space-between;font-size:.78rem;padding:4px 0;border-bottom:1px solid var(--mist)"><span style="color:var(--timber)">Total recipe cost</span><span style="font-family:monospace;font-weight:700">' + phpFmt(cost) + '</span></div>'
        + '<div style="display:flex;justify-content:space-between;font-size:.78rem;padding:4px 0;border-bottom:1px solid var(--mist)"><span style="color:var(--timber)">Selling price</span><span style="font-family:monospace;font-weight:700">' + phpFmt(rec.selling_price) + '</span></div>'
        + '<div style="display:flex;justify-content:space-between;font-size:.82rem;padding:8px 0 4px;font-weight:700"><span>Food cost %</span>' + fcPill(pct) + '</div>'
        + '<div style="display:flex;justify-content:space-between;font-size:.78rem;padding:4px 0"><span style="color:var(--timber)">Gross profit</span><span style="font-family:monospace;font-weight:700;color:' + (profit>=0?'#15803d':'#dc2626') + '">' + phpFmt(profit) + '</span></div>'
        + '<div style="display:flex;justify-content:space-between;font-size:.72rem;padding:4px 0;border-top:1px solid var(--mist);margin-top:4px"><span style="color:var(--timber)">Suggested price (30% FC target)</span><span style="font-family:monospace;color:var(--terra);font-weight:700">' + (suggestedPrice ? phpFmt(suggestedPrice) : '—') + '</span></div>'
        + '</div></div>';
    }
  } else {
    editorHtml = '<div style="padding:3rem;text-align:center;color:var(--timber);font-size:.82rem;background:var(--white);border-radius:var(--r-lg);box-shadow:var(--shadow-sm)">Select a menu item to edit its recipe</div>';
  }

  panel.innerHTML = '<div style="display:grid;grid-template-columns:260px 1fr;gap:14px">'
    + '<div>'
    + '<div style="font-size:.65rem;font-weight:700;color:var(--timber);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Menu Items</div>'
    + chipsHtml
    + listHtml
    + '<button onclick="openCostingRecModal()" style="width:100%;margin-top:8px;padding:8px;border:1.5px dashed var(--mist);background:transparent;border-radius:var(--r-md);font-size:.72rem;font-weight:700;font-family:var(--font-body);cursor:pointer;color:var(--timber)">+ Add menu item</button>'
    + '</div>'
    + '<div>' + editorHtml + '</div></div>'
    + renderCostingRecModal();
}

function setCostingRecCat(cat) {
  _costingCatFilter = cat;
  _activeRecipeId = null;
  var panel = document.getElementById('costing-panel');
  if (panel) renderCostingRecipe(panel);
}

function renderCostingRecModal() {
  return '<div id="costing-rec-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:500;align-items:center;justify-content:center">'
    + '<div style="background:var(--white);border-radius:var(--r-xl);padding:24px;width:340px;max-width:90vw;box-shadow:var(--shadow-md)">'
    + '<div id="crm-title" style="font-family:var(--font-soul);font-size:1.1rem;font-weight:700;color:var(--forest-deep);margin-bottom:16px">Add menu item</div>'
    + '<input type="hidden" id="crm-id">'
    + '<div style="margin-bottom:12px"><label style="font-size:.72rem;font-weight:700;color:var(--timber);display:block;margin-bottom:4px">Item name</label>'
    + '<input id="crm-name" placeholder="e.g. Hot Americano" style="width:100%;padding:9px 12px;border:1.5px solid var(--mist);border-radius:var(--r-md);font-size:.85rem;font-family:var(--font-body);outline:none"></div>'
    + '<div style="margin-bottom:12px"><label style="font-size:.72rem;font-weight:700;color:var(--timber);display:block;margin-bottom:4px">Category</label>'
    + '<select id="crm-cat" style="width:100%;padding:9px 12px;border:1.5px solid var(--mist);border-radius:var(--r-md);font-size:.85rem;font-family:var(--font-body)">'
    + '<option value="HOT">HOT</option>'
    + '<option value="ICE BLENDED">ICE BLENDED</option>'
    + '<option value="COLD">COLD</option>'
    + '<option value="PASTRY">PASTRY</option>'
    + '<option value="PASTA">PASTA</option>'
    + '<option value="MEAL">MEAL</option>'
    + '<option value="BEST WITH">BEST WITH</option>'
    + '<option value="OTHER">OTHER</option>'
    + '</select></div>'
    + '<div style="margin-bottom:16px"><label style="font-size:.72rem;font-weight:700;color:var(--timber);display:block;margin-bottom:4px">Selling price (₱)</label>'
    + '<input id="crm-price" type="number" step="0.01" placeholder="0.00" style="width:100%;padding:9px 12px;border:1.5px solid var(--mist);border-radius:var(--r-md);font-size:.85rem;font-family:var(--font-body);outline:none"></div>'
    + '<div style="display:flex;gap:10px;justify-content:flex-end">'
    + '<button onclick="closeCostingRecModal()" style="padding:9px 18px;border:1.5px solid var(--mist);background:transparent;border-radius:var(--r-md);font-size:.78rem;font-weight:700;font-family:var(--font-body);cursor:pointer;color:var(--timber)">Cancel</button>'
    + '<button onclick="saveCostingRec()" style="padding:9px 18px;background:var(--forest);color:var(--white);border:none;border-radius:var(--r-md);font-size:.78rem;font-weight:700;font-family:var(--font-body);cursor:pointer">Save</button>'
    + '</div></div></div>';
}

function openCostingRecModal(id) {
  var modal = document.getElementById('costing-rec-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  var rec = id ? _costingRecipes.find(function(r){return r.id===id;}) : null;
  document.getElementById('crm-title').textContent = id ? 'Edit menu item' : 'Add menu item';
  document.getElementById('crm-id').value = id || '';
  document.getElementById('crm-name').value = rec ? rec.name : '';
  document.getElementById('crm-cat').value = rec ? rec.category : 'HOT';
  document.getElementById('crm-price').value = rec ? rec.selling_price : '';
}

function closeCostingRecModal() {
  var modal = document.getElementById('costing-rec-modal');
  if (modal) modal.style.display = 'none';
}

async function saveCostingRec() {
  var id = document.getElementById('crm-id').value;
  var payload = {
    name: document.getElementById('crm-name').value.trim(),
    category: document.getElementById('crm-cat').value,
    selling_price: parseFloat(document.getElementById('crm-price').value)
  };
  if (!payload.name || isNaN(payload.selling_price)) { showToast('Name and price required'); return; }
  var sb = _supabaseClient;
  var res;
  if (id) {
    res = await sb.from('costing_recipes').update(payload).eq('id', parseInt(id)).select();
  } else {
    res = await sb.from('costing_recipes').insert(payload).select();
    if (res.data && res.data[0]) _activeRecipeId = res.data[0].id;
  }
  closeCostingRecModal();
  await loadCostingView();
  setCostingTab('recipe');
}

async function deleteCostingRec(id) {
  if (!confirm('Delete this menu item and its recipe?')) return;
  await _supabaseClient.from('costing_recipes').delete().eq('id', id);
  _activeRecipeId = null;
  await loadCostingView();
  setCostingTab('recipe');
}

function selectCostingRecipe(id) {
  _activeRecipeId = id;
  renderCostingPanel();
}

function updateRecipeIng(rid, idx, field, val) {
  var rec = _costingRecipes.find(function(r){return r.id===rid;});
  if (!rec || !rec.ingredients[idx]) return;
  if (field === 'iid') rec.ingredients[idx].ingredient_id = parseInt(val);
  if (field === 'qty') rec.ingredients[idx].qty = parseFloat(val) || 0;
  saveRecipeIngsToDB(rid);
  var panel = document.getElementById('costing-panel');
  if (panel) renderCostingRecipe(panel);
}

function addRecipeIng(rid) {
  var rec = _costingRecipes.find(function(r){return r.id===rid;});
  if (!rec) return;
  if (!rec.ingredients) rec.ingredients = [];
  rec.ingredients.push({ingredient_id: _costingIngredients[0] ? _costingIngredients[0].id : 1, qty: 0, recipe_id: rid, _new: true});
  var panel = document.getElementById('costing-panel');
  if (panel) renderCostingRecipe(panel);
}

function removeRecipeIng(rid, idx) {
  var rec = _costingRecipes.find(function(r){return r.id===rid;});
  if (!rec || !rec.ingredients[idx]) return;
  rec.ingredients.splice(idx, 1);
  saveRecipeIngsToDB(rid);
  var panel = document.getElementById('costing-panel');
  if (panel) renderCostingRecipe(panel);
}

async function saveRecipeIngsToDB(rid) {
  var rec = _costingRecipes.find(function(r){return r.id===rid;});
  if (!rec) return;
  var sb = _supabaseClient;
  await sb.from('costing_recipe_ingredients').delete().eq('recipe_id', rid);
  var toInsert = rec.ingredients.filter(function(ri){return ri.qty > 0;}).map(function(ri){
    return {recipe_id: rid, ingredient_id: ri.ingredient_id, qty: ri.qty};
  });
  if (toInsert.length) await sb.from('costing_recipe_ingredients').insert(toInsert);
}

function renderCostingPricing(panel) {
  var cats = ['ALL','HOT','ICE BLENDED','COLD','PASTRY','PASTA','MEAL','BEST WITH','OTHER'];
  var activeCat = window._costingPricingCat || 'ALL';
  var filtered = activeCat === 'ALL' ? _costingRecipes : _costingRecipes.filter(function(r){return r.category===activeCat;});

  var html = '<div style="display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap">';
  cats.forEach(function(c) {
    html += '<button onclick="setCostingPricingCat(\''+c+'\')" style="padding:6px 14px;font-size:.72rem;font-weight:700;font-family:var(--font-body);border:1.5px solid '+(activeCat===c?'var(--forest)':'var(--mist)')+';background:'+(activeCat===c?'var(--forest)':'transparent')+';color:'+(activeCat===c?'var(--white)':'var(--timber)')+';border-radius:20px;cursor:pointer">'+(c==='ALL'?'All':c)+'</button>';
  });
  html += '</div>';

  html += '<div style="overflow-x:auto;max-height:520px;overflow-y:auto;border-radius:var(--r-lg);box-shadow:var(--shadow-sm)"><table style="width:100%;border-collapse:collapse;font-size:.78rem;background:var(--white)">'
    + '<thead><tr style="background:var(--mist-light)">'
    + '<th style="padding:10px 12px;text-align:left;color:var(--timber);font-weight:700;position:sticky;top:0;z-index:2;background:var(--mist-light)">Menu Item</th>'
    + '<th style="padding:10px 12px;text-align:left;color:var(--timber);font-weight:700;position:sticky;top:0;z-index:2;background:var(--mist-light)">Cat</th>'
    + '<th style="padding:10px 12px;text-align:right;color:var(--timber);font-weight:700;position:sticky;top:0;z-index:2;background:var(--mist-light)">Recipe Cost</th>'
    + '<th style="padding:10px 12px;text-align:right;color:var(--timber);font-weight:700;position:sticky;top:0;z-index:2;background:var(--mist-light)">Selling Price</th>'
    + '<th style="padding:10px 12px;text-align:center;color:var(--timber);font-weight:700;position:sticky;top:0;z-index:2;background:var(--mist-light)">Food Cost %</th>'
    + '<th style="padding:10px 12px;text-align:right;color:var(--timber);font-weight:700;position:sticky;top:0;z-index:2;background:var(--mist-light)">Gross Profit</th>'
    + '<th style="padding:10px 12px;text-align:center;color:var(--timber);font-weight:700;position:sticky;top:0;z-index:2;background:var(--mist-light)">Margin</th>'
    + '<th style="padding:10px 12px;text-align:center;color:var(--timber);font-weight:700;position:sticky;top:0;z-index:2;background:var(--mist-light)">Status</th>'
    + '</tr></thead><tbody>'
    + filtered.map(function(r) {
        var cost = recipeTotalCost(r);
        var pct = fcPct(cost, r.selling_price);
        var profit = r.selling_price - cost;
        var margin = pct !== null ? (100 - pct) : null;
        return '<tr style="border-top:1px solid var(--mist-light)">'
          + '<td style="padding:9px 12px;font-weight:700;color:var(--forest-deep)">' + r.name + '</td>'
          + '<td style="padding:9px 12px"><span style="background:'+(getCostingCatStyle(r.category).bg)+';color:'+(getCostingCatStyle(r.category).color)+';font-size:.6rem;font-weight:700;padding:2px 7px;border-radius:20px">' + r.category + '</span></td>'
          + '<td style="padding:9px 12px;text-align:right;font-family:monospace">' + (cost > 0 ? phpFmt(cost) : '<span style="color:var(--timber)">—</span>') + '</td>'
          + '<td style="padding:9px 12px;text-align:right">'
          + '<input type="number" value="'+r.selling_price+'" step="1" onchange="updateCostingPrice('+r.id+',this.value)" style="width:76px;text-align:right;padding:4px 6px;font-size:.75rem;border:1.5px solid var(--mist);border-radius:var(--r-sm);font-family:monospace;background:var(--white)">'
          + '</td>'
          + '<td style="padding:9px 12px;text-align:center">' + fcPill(pct) + '</td>'
          + '<td style="padding:9px 12px;text-align:right;font-family:monospace;font-weight:700;color:' + (profit>=0?'#15803d':'#dc2626') + '">' + (cost>0?phpFmt(profit):'—') + '</td>'
          + '<td style="padding:9px 12px;text-align:center;font-family:monospace;font-size:.72rem;color:' + (margin===null?'var(--timber)':margin>65?'#15803d':margin>50?'#b45309':'#dc2626') + '">' + (margin!==null?margin.toFixed(1)+'%':'—') + '</td>'
          + '<td style="padding:9px 12px;text-align:center;font-size:.72rem;font-weight:700">' + fcStatus(pct) + '</td>'
          + '</tr>';
      }).join('') + '</tbody></table></div>';

  html += '<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">'
    + '<span style="font-size:.72rem;color:var(--timber)">Food cost target:</span>'
    + '<span style="background:#dcfce7;color:#15803d;padding:2px 10px;border-radius:20px;font-size:.68rem;font-weight:700">Excellent &lt;28%</span>'
    + '<span style="background:#ccfbf1;color:#0f766e;padding:2px 10px;border-radius:20px;font-size:.68rem;font-weight:700">Good 28–35%</span>'
    + '<span style="background:#fef3c7;color:#b45309;padding:2px 10px;border-radius:20px;font-size:.68rem;font-weight:700">Review 35–40%</span>'
    + '<span style="background:#fee2e2;color:#dc2626;padding:2px 10px;border-radius:20px;font-size:.68rem;font-weight:700">Critical &gt;40%</span>'
    + '</div>';

  panel.innerHTML = html;
}

function setCostingPricingCat(cat) {
  window._costingPricingCat = cat;
  var panel = document.getElementById('costing-panel');
  if (panel) renderCostingPricing(panel);
}

async function updateCostingPrice(rid, val) {
  var price = parseFloat(val);
  if (isNaN(price)) return;
  var rec = _costingRecipes.find(function(r){return r.id===rid;});
  if (rec) {
    rec.selling_price = price;
    await _supabaseClient.from('costing_recipes').update({selling_price: price}).eq('id', rid);
  }
}

// ══════════════════════════════════════════════════════════
// AUDIT LOGS TAB
// ══════════════════════════════════════════════════════════
// HISTORY TAB — all orders today including cancelled + deleted
// ══════════════════════════════════════════════════════════
async function renderHistoryTab() {
  var container = document.getElementById('mainContent');
  if (!container) return;
  container.innerHTML = '<div style="padding:32px;text-align:center;color:var(--timber);font-size:.9rem">Loading order history...</div>';
  try {
    var result = await api('getOrders', { includeDeleted: true, limit: 500 });
    if (!result.ok) { container.innerHTML = '<div style="padding:32px;color:red">Failed to load history</div>'; return; }
    var orders = result.orders || [];
    // Filter to today's business day (6AM PHT)
    var phtOffset = 8 * 3600000;
    var nowPHT = new Date(Date.now() + phtOffset);
    if (nowPHT.getUTCHours() < 6) nowPHT.setUTCDate(nowPHT.getUTCDate() - 1);
    var bizDayStart = new Date(Date.UTC(nowPHT.getUTCFullYear(), nowPHT.getUTCMonth(), nowPHT.getUTCDate(), 6, 0, 0) - phtOffset);
    orders = orders.filter(function(o) { return new Date(o.createdAt || o.created_at) >= bizDayStart; });

    if (orders.length === 0) { container.innerHTML = '<div style="padding:32px;text-align:center;color:var(--timber)">No orders today.</div>'; return; }

    var sc = {
      COMPLETED: { bg:'#F0FDF4', bdr:'#86EFAC', badge:'#16A34A' },
      CANCELLED: { bg:'#FEF2F2', bdr:'#FECACA', badge:'#DC2626' },
      READY:     { bg:'#FFFBEB', bdr:'#FDE68A', badge:'#D97706' },
      PREPARING: { bg:'#EFF6FF', bdr:'#BFDBFE', badge:'#2563EB' },
      NEW:       { bg:'#F5F3FF', bdr:'#DDD6FE', badge:'#7C3AED' },
    };

    var html = '<div style="padding:16px">';
    html += '<div style="font-size:.75rem;font-weight:700;color:var(--timber);text-transform:uppercase;letter-spacing:.06em;margin-bottom:14px">Today — ' + orders.length + ' orders (including cancelled &amp; deleted)</div>';

    orders.forEach(function(o) {
      var isDeleted = o.isDeleted;
      var s = sc[o.status] || { bg:'#F9FAFB', bdr:'#E5E7EB', badge:'#6B7280' };
      var amt = parseFloat(o.discountedTotal) > 0 ? parseFloat(o.discountedTotal) : parseFloat(o.total);
      var time = '';
      try {
        var d = new Date(new Date(o.createdAt || o.created_at).getTime() + phtOffset);
        var h = d.getUTCHours(), m = String(d.getUTCMinutes()).padStart(2,'0');
        time = (h%12||12) + ':' + m + ' ' + (h>=12?'PM':'AM');
      } catch(e) {}
      var items = (o.items||[]).map(function(it){ return it.name + ' ×' + it.qty; }).join(', ') || '—';

      html += '<div style="background:' + s.bg + ';border:1px solid ' + s.bdr + ';border-radius:12px;padding:14px 16px;margin-bottom:10px' + (isDeleted ? ';opacity:.6' : '') + '">';
      html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">';
      html += '<div style="display:flex;align-items:center;gap:6px">';
      html += '<span style="font-weight:700;font-size:.88rem">' + esc(o.orderId) + '</span>';
      if (isDeleted) html += '<span style="background:#EF4444;color:#fff;font-size:.62rem;font-weight:700;padding:2px 6px;border-radius:8px">DELETED</span>';
      html += '<span style="background:' + s.badge + ';color:#fff;font-size:.62rem;font-weight:700;padding:2px 6px;border-radius:8px">' + o.status + '</span>';
      html += '</div>';
      html += '<span style="font-weight:700;color:var(--forest)">₱' + (isNaN(amt)?'?':amt.toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2})) + '</span>';
      html += '</div>';
      html += '<div style="font-size:.76rem;color:var(--timber);display:flex;gap:10px;flex-wrap:wrap;margin-bottom:5px">';
      html += '<span>🕐 ' + time + '</span><span>🪑 T' + (o.tableNo||'?') + '</span><span>' + (o.orderType||'') + '</span>';
      if (o.paymentMethod && o.paymentMethod !== 'UNKNOWN') html += '<span>💳 ' + o.paymentMethod + '</span>';
      if (o.customerName && o.customerName !== 'Guest') html += '<span>👤 ' + esc(o.customerName) + '</span>';
      html += '</div>';
      html += '<div style="font-size:.76rem;color:var(--forest-d)">' + esc(items) + '</div>';
      if (parseFloat(o.discountAmount) > 0) {
        html += '<div style="font-size:.72rem;color:#D97706;margin-top:3px">🏷️ ' + (o.discountType||'Discount') + ' −₱' + parseFloat(o.discountAmount).toFixed(2) + ' → Final ₱' + parseFloat(o.discountedTotal).toFixed(2) + '</div>';
      }
      if (isDeleted && (currentUser.role === 'OWNER' || currentUser.role === 'ADMIN')) {
        html += '<button onclick="restoreOrder(\'' + esc(o.orderId) + '\')" style="margin-top:8px;padding:5px 14px;background:var(--forest);color:#fff;border:none;border-radius:8px;font-size:.74rem;font-weight:700;cursor:pointer">↩️ Restore to Board</button>';
      }
      html += '</div>';
    });
    html += '</div>';
    container.innerHTML = html;
  } catch(e) {
    container.innerHTML = '<div style="padding:32px;color:red">Error: ' + e.message + '</div>';
  }
}

async function restoreOrder(orderId) {
  if (!confirm('Restore ' + orderId + ' back to the board?')) return;
  var result = await api('restoreOrder', { orderId: orderId, userId: currentUser && currentUser.userId });
  if (result.ok) {
    showToast('✅ ' + orderId + ' restored', 'success');
    await loadOrders();
    renderHistoryTab();
  } else {
    showToast('❌ ' + (result.error || 'Failed'), 'error');
  }
}

// ══════════════════════════════════════════════════════════
var _auditLogsCache = [];
var _auditFilter = '';

async function loadAuditLogs(filterOrderId) {
  var view = document.getElementById('logsView');
  if (!view) return;
  view.innerHTML = '<div style="padding:24px;text-align:center;color:var(--bark)">Loading logs...</div>';

  var payload = { userId: currentUser && currentUser.userId, limit: 200 };
  if (filterOrderId) payload.orderId = filterOrderId;

  var r = await api('getAuditLogs', payload);
  if (!r || !r.ok) {
    view.innerHTML = '<div style="padding:20px;color:#EF4444">Failed to load logs.</div>';
    return;
  }
  _auditLogsCache = r.logs || [];
  _auditFilter = filterOrderId || '';
  renderAuditLogs();
}

function renderAuditLogs() {
  var view = document.getElementById('logsView');
  if (!view) return;

  var actionMeta = {
    ORDER_PLACED:         { icon:'🛎️',  color:'#059669', label:'Order Placed' },
    STATUS_CHANGED:       { icon:'🔄',  color:'#2563EB', label:'Status Changed' },
    ORDER_DELETED:        { icon:'🗑️',  color:'#EF4444', label:'Order Deleted' },
    PAYMENT_SET:          { icon:'💳',  color:'#7C3AED', label:'Payment Set' },
    DISCOUNT_APPLIED:     { icon:'🏷️',  color:'#D97706', label:'Discount Applied' },
    DISCOUNT_REMOVED:     { icon:'✕',   color:'#6B7280', label:'Discount Removed' },
    ORDER_EDITED:         { icon:'✏️',  color:'#0891B2', label:'Order Edited' },
    PLATFORM_ORDER_PLACED:{ icon:'📦',  color:'#059669', label:'Platform Order' },
  };

  var logs = _auditLogsCache;
  var searchVal = (document.getElementById('logSearch') || {}).value || '';
  if (searchVal) {
    var q = searchVal.toLowerCase();
    logs = logs.filter(function(l) {
      return (l.order_id||'').toLowerCase().includes(q)
          || (l.action||'').toLowerCase().includes(q)
          || (l.actor_name||'').toLowerCase().includes(q)
          || (l.actor_id||'').toLowerCase().includes(q)
          || (l.new_value||'').toLowerCase().includes(q)
          || (l.old_value||'').toLowerCase().includes(q);
    });
  }

  var html = '<div style="padding:14px 16px 100px">';

  // Search bar + filter chip
  html += '<div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">'
    + '<input id="logSearch" type="text" placeholder="Search orders, actions, staff…" value="' + escAttr(searchVal) + '" '
    + 'oninput="renderAuditLogs()" '
    + 'style="flex:1;padding:8px 12px;border:1.5px solid var(--mist);border-radius:10px;font-size:.82rem;font-family:var(--font-body)">'
    + (_auditFilter
        ? '<button onclick="loadAuditLogs()" style="padding:6px 12px;background:#EFF6FF;border:1.5px solid #BFDBFE;border-radius:8px;font-size:.72rem;font-weight:700;color:#1D4ED8;cursor:pointer;white-space:nowrap">✕ Clear filter</button>'
        : '')
    + '</div>';

  html += '<div style="font-size:.72rem;color:#9CA3AF;margin-bottom:10px">'
    + logs.length + ' log entr' + (logs.length===1?'y':'ies')
    + (_auditFilter ? ' for ' + _auditFilter : '')
    + '</div>';

  if (logs.length === 0) {
    html += '<div style="text-align:center;padding:40px 20px;color:#9CA3AF">'
      + '<div style="font-size:2rem;margin-bottom:8px">📭</div>'
      + '<div style="font-size:.85rem">No logs yet. Actions will appear here as orders are placed and updated.</div>'
      + '</div>';
  } else {
    // Group by date
    var byDate = {};
    logs.forEach(function(l) {
      var d = new Date(l.created_at);
      var key = d.toLocaleDateString('en-PH', { weekday:'short', month:'short', day:'numeric', year:'numeric' });
      if (!byDate[key]) byDate[key] = [];
      byDate[key].push(l);
    });

    Object.keys(byDate).forEach(function(date) {
      html += '<div style="font-size:.68rem;font-weight:800;color:var(--bark);text-transform:uppercase;letter-spacing:.06em;padding:8px 0 6px;">' + date + '</div>';

      byDate[date].forEach(function(l) {
        var m = actionMeta[l.action] || { icon:'📝', color:'#6B7280', label: l.action };
        var time = new Date(l.created_at).toLocaleTimeString('en-PH', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
        var actor = l.actor_name || l.actor_id || 'System';

        // Build detail string
        var detail = '';
        if (l.action === 'STATUS_CHANGED' && l.old_value && l.new_value) {
          detail = l.old_value + ' → ' + l.new_value;
        } else if (l.action === 'PAYMENT_SET' && l.new_value) {
          detail = l.new_value;
          if (l.details && l.details.notes) detail += ' · ' + l.details.notes;
        } else if (l.action === 'DISCOUNT_APPLIED' && l.details) {
          detail = l.new_value;
          if (l.details.discountAmount) detail += ' · -₱' + parseFloat(l.details.discountAmount).toFixed(2);
          if (l.details.discountedTotal) detail += ' → ₱' + parseFloat(l.details.discountedTotal).toFixed(2);
        } else if (l.action === 'ORDER_PLACED' && l.details) {
          detail = (l.details.orderType||'') + ' · ' + (l.details.itemCount||0) + ' item(s) · ₱' + parseFloat(l.details.total||0).toFixed(2);
        } else if (l.action === 'ORDER_EDITED' && l.details) {
          detail = (l.details.itemCount||0) + ' item(s) · New total ₱' + parseFloat(l.details.newTotal||0).toFixed(2);
        } else if (l.new_value) {
          detail = l.new_value;
        }

        html += '<div style="background:#fff;border-radius:12px;padding:10px 12px;margin-bottom:6px;display:flex;gap:10px;align-items:flex-start;box-shadow:0 1px 3px rgba(0,0,0,.06)">'
          + '<div style="width:30px;height:30px;border-radius:50%;background:' + m.color + '18;display:flex;align-items:center;justify-content:center;font-size:.9rem;flex-shrink:0;margin-top:1px">' + m.icon + '</div>'
          + '<div style="flex:1;min-width:0">'
            + '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">'
              + '<span style="font-weight:700;font-size:.8rem;color:' + m.color + '">' + m.label + '</span>'
              + (l.order_id ? '<span onclick="loadAuditLogs(\'' + esc(l.order_id) + '\')" style="font-size:.68rem;color:#2563EB;background:#EFF6FF;padding:1px 7px;border-radius:10px;cursor:pointer;font-weight:600">' + l.order_id + '</span>' : '')
            + '</div>'
            + (detail ? '<div style="font-size:.75rem;color:#374151;margin-top:2px">' + esc(detail) + '</div>' : '')
            + '<div style="font-size:.67rem;color:#9CA3AF;margin-top:3px">' + esc(actor) + ' · ' + time + '</div>'
          + '</div>'
          + '</div>';
      });
    });
  }

  html += '</div>';
  view.innerHTML = html;
  // Re-focus search if user was typing
  if (searchVal) {
    var s = document.getElementById('logSearch');
    if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
  }
}

function escAttr(s) { return String(s||'').replace(/"/g,'&quot;'); }

// ══════════════════════════════════════════════════════════
// STAFF TAB
// ══════════════════════════════════════════════════════════
async function loadStaffTab() {
  var view = document.getElementById('staffView');
  if (!view) return;
  view.innerHTML = '<div style="padding:20px;text-align:center;color:var(--bark)">Loading staff...</div>';
  var r = await api('getStaff', { userId: currentUser && currentUser.userId });
  if (!r || !r.ok) {
    view.innerHTML = '<div style="padding:20px;color:#EF4444">Failed to load staff.</div>';
    return;
  }
  var roleColors = { OWNER:'#7C3AED', ADMIN:'#2563EB', CASHIER:'#059669', KITCHEN:'#D97706' };
  var html = '<div style="padding:16px 16px 100px">';
  html += '<div style="font-size:.85rem;color:var(--bark);margin-bottom:14px;">' + r.users.length + ' active staff accounts</div>';
  r.users.forEach(function(u) {
    var lastLogin = u.last_login ? new Date(u.last_login).toLocaleString('en-PH',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : 'Never';
    var roleColor = roleColors[u.role] || '#6B7280';
    html += '<div style="background:#fff;border-radius:14px;padding:14px 16px;margin-bottom:10px;box-shadow:0 1px 4px rgba(0,0,0,.07);display:flex;align-items:center;gap:12px">'
      + '<div style="width:40px;height:40px;border-radius:50%;background:' + roleColor + '20;display:flex;align-items:center;justify-content:center;font-size:1.2rem;flex-shrink:0">'
        + (u.role==='OWNER'?'👑':u.role==='ADMIN'?'🛡️':u.role==='CASHIER'?'💵':'👨‍🍳') + '</div>'
      + '<div style="flex:1;min-width:0">'
        + '<div style="font-weight:700;font-size:.88rem;color:var(--bark)">' + (u.display_name || u.username) + '</div>'
        + '<div style="font-size:.72rem;color:#9CA3AF;margin-top:2px">@' + u.username + ' · Last login: ' + lastLogin + '</div>'
        + (u.failed_attempts > 0 ? '<div style="font-size:.68rem;color:#EF4444;margin-top:2px">⚠️ ' + u.failed_attempts + ' failed attempt(s)</div>' : '')
      + '</div>'
      + '<span style="font-size:.68rem;font-weight:700;color:' + roleColor + ';background:' + roleColor + '18;padding:3px 10px;border-radius:20px">' + u.role + '</span>'
      + '</div>';
  });
  html += '<div style="background:#FEF3C7;border:1px solid #FCD34D;border-radius:12px;padding:12px 14px;margin-top:8px;font-size:.75rem;color:#92400E">'
    + '💡 To change PINs, use the <strong>Change PIN</strong> option in Settings. Staff management (add/remove) coming soon.</div>';
  html += '</div>';
  view.innerHTML = html;
}

// ══════════════════════════════════════════════════════════
// SHIFT SUMMARY (End-of-Day)
// ══════════════════════════════════════════════════════════
async function loadShiftSummary() {
  var view = document.getElementById('shiftView');
  if (!view) return;
  view.innerHTML = '<div style="padding:24px;text-align:center;color:var(--bark)">Loading shift summary...</div>';
  var r = await api('getShiftSummary', { userId: currentUser && currentUser.userId });
  if (!r || !r.ok) {
    view.innerHTML = '<div style="padding:20px;color:#EF4444">Failed to load shift data.</div>';
    return;
  }
  var pmIcons = {CASH:'💵',CARD:'💳',GCASH:'📱',MAYA:'📲',INSTAPAY:'🏦',BDO:'🏛️',BPI:'🏛️',UNIONBANK:'🏛️',OTHER:'💰',UNRECORDED:'⚠️'};
  var html = '<div style="padding:16px 16px 100px">';
  // Date + header
  html += '<div style="font-size:.8rem;color:var(--bark);margin-bottom:12px">📅 ' + r.date + ' · Today\'s Shift</div>';
  // Summary cards
  html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px">';
  html += statCard('💰 Revenue', '₱' + parseFloat(r.totalRevenue).toFixed(2), '#059669', '#F0FDF4');
  html += statCard('📋 Orders', r.totalOrders, '#2563EB', '#EFF6FF');
  html += statCard('🏷️ Discounts', '₱' + parseFloat(r.totalDiscounts).toFixed(2), '#7C3AED', '#F5F3FF');
  html += statCard('❌ Cancelled', r.cancelledOrders, '#EF4444', '#FEF2F2');
  html += '</div>';
  // Unrecorded warning
  if (r.unrecordedPayments > 0) {
    html += '<div style="background:#FEF3C7;border:1.5px solid #FCD34D;border-radius:12px;padding:12px 14px;margin-bottom:14px">'
      + '<div style="font-weight:700;color:#92400E;font-size:.82rem">⚠️ ' + r.unrecordedPayments + ' completed order(s) with no payment method logged!</div>'
      + '<div style="font-size:.72rem;color:#B45309;margin-top:3px">Go to those orders and set payment method for accurate reconciliation.</div>'
      + '</div>';
  }
  // Payment breakdown
  html += '<div style="font-size:.75rem;font-weight:700;color:var(--bark);margin-bottom:8px;text-transform:uppercase;letter-spacing:.04em">Payment Breakdown</div>';
  var breakdown = r.paymentBreakdown || {};
  var pmKeys = Object.keys(breakdown).sort();
  if (pmKeys.length === 0) {
    html += '<div style="color:#9CA3AF;font-size:.8rem;padding:8px 0">No completed orders yet today.</div>';
  } else {
    pmKeys.forEach(function(pm) {
      var d = breakdown[pm];
      var icon = pmIcons[pm] || '💰';
      var isWarning = pm === 'UNRECORDED';
      html += '<div style="background:' + (isWarning?'#FEF3C7':'#fff') + ';border-radius:12px;padding:12px 14px;margin-bottom:8px;display:flex;align-items:center;gap:10px;box-shadow:0 1px 3px rgba(0,0,0,.06)">'
        + '<span style="font-size:1.1rem">' + icon + '</span>'
        + '<div style="flex:1"><div style="font-weight:700;font-size:.83rem;color:' + (isWarning?'#92400E':'var(--bark)') + '">' + pm + '</div>'
        + '<div style="font-size:.7rem;color:#9CA3AF">' + d.count + ' order(s)</div></div>'
        + '<div style="font-weight:800;font-size:.9rem;color:' + (isWarning?'#92400E':'var(--forest)') + '">₱' + parseFloat(d.total).toFixed(2) + '</div>'
        + '</div>';
    });
  }
  // Dine-in vs Take-out
  html += '<div style="font-size:.75rem;font-weight:700;color:var(--bark);margin-top:14px;margin-bottom:8px;text-transform:uppercase;letter-spacing:.04em">Order Types</div>';
  html += '<div style="display:flex;gap:8px">'
    + '<div style="flex:1;background:#fff;border-radius:12px;padding:12px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.06)">'
      + '<div style="font-size:1.2rem">🍽️</div><div style="font-weight:700;font-size:1.1rem;color:var(--forest)">' + r.orderTypeSplit.dineIn + '</div>'
      + '<div style="font-size:.68rem;color:#9CA3AF">Dine-In</div></div>'
    + '<div style="flex:1;background:#fff;border-radius:12px;padding:12px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.06)">'
      + '<div style="font-size:1.2rem">🛍️</div><div style="font-weight:700;font-size:1.1rem;color:var(--forest)">' + r.orderTypeSplit.takeOut + '</div>'
      + '<div style="font-size:.68rem;color:#9CA3AF">Take-Out</div></div>'
    + '</div>';
  html += '</div>';

  // Manual daily report button (OWNER/ADMIN only)
  if (currentUser && (currentUser.role === 'OWNER' || currentUser.role === 'ADMIN')) {
    html += '<div style="margin-top:16px;padding:0 4px">' +
      '<button onclick="triggerManualDailyReport(this)" ' +
        'style="width:100%;background:var(--forest-deep);color:#fff;border:none;border-radius:12px;padding:12px;font-size:.88rem;font-weight:700;cursor:pointer">' +
        '📧 Send Daily Report Now</button>' +
      '<div style="font-size:.7rem;color:var(--timber);text-align:center;margin-top:6px">Sends today\'s sales summary email</div>' +
    '</div>';
  }

  view.innerHTML = html;
}

async function triggerManualDailyReport(btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Sending...'; }
  try {
    var token = (currentUser && currentUser.token) || '';
    var resp = await fetch('/api/daily-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ manual: true })
    });
    var d = await resp.json();
    if (d.ok || d.sent) {
      showToast('✅ Daily report sent!');
    } else {
      showToast('⚠️ ' + (d.error || 'Report may not have sent — check email'), 'warn');
    }
  } catch(e) {
    showToast('❌ ' + e.message, 'error');
  }
  if (btn) { btn.disabled = false; btn.textContent = '📧 Send Daily Report Now'; }
}

function statCard(label, value, color, bg) {
  return '<div style="background:' + bg + ';border-radius:12px;padding:12px;text-align:center">'
    + '<div style="font-size:.68rem;color:' + color + ';font-weight:700;margin-bottom:4px">' + label + '</div>'
    + '<div style="font-size:1.1rem;font-weight:800;color:' + color + '">' + value + '</div>'
    + '</div>';
}

// ══════════════════════════════════════════════════════════
// GENERIC MODAL HELPER
// ══════════════════════════════════════════════════════════
function showModal(title, bodyHtml) {
  document.getElementById('genericModalTitle').textContent = title;
  document.getElementById('genericModalBody').innerHTML = bodyHtml;
  document.getElementById('genericModal').classList.add('open');
}
function closeModal() {
  document.getElementById('genericModal').classList.remove('open');
}

// ══════════════════════════════════════════════════════════
// FLOOR MAP — Table occupancy + Reservation auto-link
// ══════════════════════════════════════════════════════════
var _floorTables = [];
var _floorReservations = [];

async function loadFloorMap() {
  var el = document.getElementById('floorMapView');
  el.innerHTML = '<div style="padding:20px;color:#888">Loading floor map…</div>';
  var [tr, rr] = await Promise.all([
    api('getTableStatus'),
    api('getReservations', { userId: currentUser.userId })
  ]);
  _floorTables = (tr.tables || []);
  _floorReservations = (rr.reservations || []).filter(function(r) {
    return r.status === 'CONFIRMED' || r.status === 'SEATED';
  });
  renderFloorMap();
}

function renderFloorMap() {
  var el = document.getElementById('floorMapView');
  var statusColors = { AVAILABLE:'#22c55e', OCCUPIED:'#ef4444', RESERVED:'#f59e0b', MAINTENANCE:'#94a3b8' };
  var statusLabels = { AVAILABLE:'Available', OCCUPIED:'Occupied', RESERVED:'Reserved', MAINTENANCE:'Maintenance' };

  var legendHtml = Object.keys(statusColors).map(function(s) {
    return '<span style="display:inline-flex;align-items:center;gap:5px;margin-right:14px;font-size:.75rem">'
      + '<span style="width:12px;height:12px;border-radius:3px;background:' + statusColors[s] + '"></span>' + statusLabels[s] + '</span>';
  }).join('');

  var gridHtml = _floorTables.map(function(t) {
    var st = t.status || 'AVAILABLE';
    var col = statusColors[st] || '#22c55e';
    // Find linked reservation
    var linked = _floorReservations.find(function(r) { return r.table_id === t.id; });
    var resHtml = linked
      ? '<div style="font-size:.65rem;margin-top:3px;color:#fff;opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'
        + '📅 ' + linked.guest_name + '</div>' : '';

    return '<div style="background:' + col + ';border-radius:14px;padding:14px 10px;text-align:center;cursor:pointer;min-width:80px;box-shadow:0 2px 8px rgba(0,0,0,.12);transition:transform .1s" '
      + 'onclick="openFloorTableMenu(' + t.table_number + ')">'
      + '<div style="font-size:1.4rem">🪑</div>'
      + '<div style="font-weight:800;font-size:.85rem;color:#fff;margin-top:2px">'
      + (t.table_name || 'Table ' + t.table_number) + '</div>'
      + '<div style="font-size:.65rem;color:#fff;opacity:.9;margin-top:1px">' + statusLabels[st] + '</div>'
      + resHtml
      + '</div>';
  }).join('');

  // Pending reservations (no table linked)
  var unlinked = _floorReservations.filter(function(r) { return !r.table_id; });
  var pendingHtml = unlinked.length ? '<div style="margin:20px 0 8px;font-weight:700;font-size:.85rem;color:#92400e">📅 Reservations Awaiting Table Assignment (' + unlinked.length + ')</div>'
    + unlinked.map(function(r) {
      return '<div style="background:#fef3c7;border:1.5px solid #fbbf24;border-radius:10px;padding:12px 14px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between">'
        + '<div><div style="font-weight:700;font-size:.85rem">' + r.guest_name + ' — ' + r.pax + ' pax</div>'
        + '<div style="font-size:.72rem;color:#92400e">' + r.res_date + ' ' + r.res_time + '</div></div>'
        + '<div style="display:flex;gap:8px">'
        + _floorTables.filter(function(t){return t.status==='AVAILABLE';}).slice(0,1).length
          ? '<select id="rlkSel_' + r.res_id + '" style="font-size:.75rem;padding:4px 6px;border-radius:7px;border:1px solid #fbbf24">'
            + _floorTables.filter(function(t){return t.status==='AVAILABLE';}).map(function(t){
              return '<option value="' + t.table_number + '">' + (t.table_name||'T'+t.table_number) + '</option>';
            }).join('') + '</select>'
          : '<span style="font-size:.72rem;color:#ef4444">No tables free</span>'
        + '<button onclick="assignResTable(\'' + r.res_id + '\')" style="background:#f59e0b;color:#fff;border:none;border-radius:7px;padding:5px 10px;font-size:.75rem;font-weight:700;cursor:pointer">Assign</button>'
        + '</div></div>';
    }).join('') : '';

  el.innerHTML = '<div style="padding:16px 16px 0">'
    + '<div style="font-weight:800;font-size:1.05rem;color:var(--forest-deep);margin-bottom:10px">🗺️ Floor Map</div>'
    + '<div style="margin-bottom:14px">' + legendHtml + '</div>'
    + '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:10px">' + gridHtml + '</div>'
    + pendingHtml
    + '</div>';
}

async function assignResTable(resId) {
  var sel = document.getElementById('rlkSel_' + resId);
  if (!sel) return;
  var tableNo = parseInt(sel.value);
  var r = await api('linkReservationTable', { userId: currentUser.userId, resId: resId, tableNumber: tableNo });
  if (r.ok) { showToast('Table assigned ✅'); loadFloorMap(); }
  else showToast('Error: ' + r.error, true);
}

function openFloorTableMenu(tableNo) {
  var t = _floorTables.find(function(x){ return x.table_number === tableNo; });
  if (!t) return;
  var statusOptions = ['AVAILABLE','OCCUPIED','RESERVED','MAINTENANCE'];
  var labels = { AVAILABLE:'✅ Available', OCCUPIED:'🔴 Occupied', RESERVED:'📅 Reserved', MAINTENANCE:'🔧 Maintenance' };
  var curStatus = t.status || 'AVAILABLE';
  showModal('Table ' + (t.table_name || tableNo),
    '<div style="margin-bottom:14px;font-size:.85rem;color:#64748b">Current: <strong>' + curStatus + '</strong></div>'
    + '<div style="display:flex;flex-direction:column;gap:8px">'
    + statusOptions.filter(function(s){ return s !== curStatus; }).map(function(s) {
      return '<button onclick="setFloorTableStatus(' + tableNo + ',\'' + s + '\')" '
        + 'style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:10px;padding:10px;font-size:.85rem;font-weight:600;cursor:pointer;text-align:left">'
        + labels[s] + '</button>';
    }).join('')
    + '</div>'
  );
}

async function setFloorTableStatus(tableNo, status) {
  closeModal();
  var r = await api('setTableStatus', { userId: currentUser.userId, tableNumber: tableNo, status: status });
  if (r.ok) { showToast('Table ' + tableNo + ' → ' + status); loadFloorMap(); }
  else showToast('Error: ' + r.error, true);
}

// ══════════════════════════════════════════════════════════
// INVENTORY
// ══════════════════════════════════════════════════════════
var _inventoryItems = [];

async function loadInventoryView() {
  var el = document.getElementById('inventoryView');
  el.innerHTML = '<div style="padding:20px;color:#888">Loading inventory…</div>';
  var r = await api('getInventory', { userId: currentUser.userId });
  _inventoryItems = r.items || [];
  renderInventoryView();
}

function renderInventoryView() {
  var el = document.getElementById('inventoryView');
  var lowCount = _inventoryItems.filter(function(i){ return i.low_stock; }).length;
  var outCount = _inventoryItems.filter(function(i){ return parseFloat(i.stock_qty) === 0; }).length;

  var rowsHtml = _inventoryItems.length === 0
    ? '<div style="text-align:center;padding:40px;color:#94a3b8">No inventory tracked yet. Click <strong>+ Add Item</strong> to start.</div>'
    : _inventoryItems.map(function(i) {
      var badge = parseFloat(i.stock_qty) === 0
        ? '<span style="background:#fef2f2;color:#ef4444;border-radius:6px;padding:2px 8px;font-size:.68rem;font-weight:700;flex-shrink:0">OUT</span>'
        : i.low_stock
        ? '<span style="background:#fff7ed;color:#f59e0b;border-radius:6px;padding:2px 8px;font-size:.68rem;font-weight:700;flex-shrink:0">LOW</span>'
        : '<span style="background:#f0fdf4;color:#22c55e;border-radius:6px;padding:2px 8px;font-size:.68rem;font-weight:700;flex-shrink:0">OK</span>';

      var photoHtml = i.photo_url
        ? '<img src="' + esc(i.photo_url) + '" style="width:44px;height:44px;border-radius:8px;object-fit:cover;flex-shrink:0" onerror="this.style.display=&quot;none&quot;">'
        : '<div style="width:44px;height:44px;border-radius:8px;background:#f1f5f9;display:flex;align-items:center;justify-content:center;font-size:1.3rem;flex-shrink:0">📦</div>';

      var sizeLabel = i.size_per_unit ? ' · ' + esc(i.size_per_unit) : '';
      var sellLabel = i.selling_price > 0 ? ' · Sell ₱' + parseFloat(i.selling_price).toFixed(0) : '';
      var qty = parseFloat(i.stock_qty);
      var qtyDisplay = qty === Math.floor(qty) ? qty.toFixed(0) : qty.toFixed(1);

      return '<div style="background:#fff;border-radius:12px;box-shadow:0 1px 6px rgba(0,0,0,.07);padding:12px 14px;display:flex;align-items:center;gap:10px;margin-bottom:8px">'
        + photoHtml
        + '<div style="flex:1;min-width:0">'
        + '<div style="font-weight:700;font-size:.88rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(i.item_name || i.item_code) + '</div>'
        + '<div style="font-size:.7rem;color:#64748b;margin-top:1px">' + esc(i.item_code) + ' · ' + esc(i.unit) + sizeLabel + ' · Cost ₱' + parseFloat(i.cost_per_unit||0).toFixed(2) + sellLabel + '</div>'
        + '<div style="font-size:.68rem;color:#94a3b8;margin-top:1px">Threshold: ' + i.low_stock_threshold + ' ' + esc(i.unit) + '</div>'
        + '</div>'
        + badge
        + '<div style="font-size:1.15rem;font-weight:800;min-width:40px;text-align:center;color:' + (parseFloat(i.stock_qty)===0?'#ef4444':i.low_stock?'#f59e0b':'#065f46') + '">' + qtyDisplay + '</div>'
        + '<div style="display:flex;flex-direction:column;gap:4px">'
        + '<button onclick="invQuickIn(\'' + i.item_code + '\')" style="background:#f0fdf4;color:#16a34a;border:1.5px solid #bbf7d0;border-radius:7px;padding:4px 10px;font-size:.78rem;font-weight:700;cursor:pointer;white-space:nowrap">▲ IN</button>'
        + '<button onclick="invQuickOut(\'' + i.item_code + '\')" style="background:#fef2f2;color:#dc2626;border:1.5px solid #fecaca;border-radius:7px;padding:4px 10px;font-size:.78rem;font-weight:700;cursor:pointer;white-space:nowrap">▼ OUT</button>'
        + '</div>'
        + '<button onclick="openInvEdit(\'' + i.item_code + '\')" style="background:#f8fafc;color:#64748b;border:1px solid #e2e8f0;border-radius:8px;padding:6px 10px;font-size:.78rem;cursor:pointer;flex-shrink:0">⚙️</button>'
        + '</div>';
    }).join('');

  var summaryBadges = '';
  if (outCount > 0) summaryBadges += '<span style="background:#fef2f2;color:#ef4444;border-radius:8px;padding:3px 10px;font-size:.75rem;font-weight:700;margin-right:6px">⚠️ ' + outCount + ' OUT OF STOCK</span>';
  if (lowCount > 0) summaryBadges += '<span style="background:#fff7ed;color:#f59e0b;border-radius:8px;padding:3px 10px;font-size:.75rem;font-weight:700">⚠️ ' + lowCount + ' LOW STOCK</span>';

  el.innerHTML = '<div style="padding:16px 16px 0">'
    + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">'
    + '<div><div style="font-weight:800;font-size:1.05rem;color:var(--forest-deep)">📦 Inventory</div>'
    + (summaryBadges ? '<div style="margin-top:4px">' + summaryBadges + '</div>' : '') + '</div>'
    + '<button onclick="openInvAdd()" style="background:var(--forest-deep);color:#fff;border:none;border-radius:10px;padding:8px 14px;font-size:.82rem;font-weight:700;cursor:pointer">+ Add Item</button>'
    + '</div>'
    + rowsHtml + '</div>';
}

// ── Quick IN modal ─────────────────────────────────────────
function invQuickIn(code) {
  var item = _inventoryItems.find(function(i){ return i.item_code === code; });
  var name = item ? (item.item_name || code) : code;
  var cur = item ? parseFloat(item.stock_qty) : 0;
  showModal('▲ Stock IN — ' + name,
    '<div style="background:#f0fdf4;border-radius:10px;padding:10px 14px;margin-bottom:12px;display:flex;justify-content:space-between">'
    + '<span style="font-size:.82rem;color:#166534">Current stock</span>'
    + '<strong style="color:#166534">' + cur + ' ' + (item?item.unit:'') + '</strong></div>'
    + '<div style="display:flex;flex-direction:column;gap:10px">'
    + '<label style="font-size:.8rem;font-weight:600">Qty IN (how much arriving?)<br>'
    + '<input id="qInQty" type="number" value="1" min="0.1" step="any" autofocus style="width:100%;padding:10px;border:2px solid #bbf7d0;border-radius:8px;font-size:1rem;font-weight:700;margin-top:3px"></label>'
    + '<label style="font-size:.8rem;font-weight:600">Type<br>'
    + '<select id="qInType" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px">'
    + '<option value="RESTOCK">🛒 Restock / Delivery</option>'
    + '<option value="RETURN">↩️ Return / Unused</option>'
    + '<option value="ADJUSTMENT">✏️ Manual Correction</option>'
    + '</select></label>'
    + '<label style="font-size:.8rem;font-weight:600">Cost per unit this delivery (₱) <span style="font-weight:400;opacity:.6">optional</span><br>'
    + '<input id="qInPrice" type="number" value="' + (item?parseFloat(item.cost_per_unit||0):'0') + '" min="0" step="0.01" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px"></label>'
    + '<label style="font-size:.8rem;font-weight:600">Ref / Supplier note <span style="font-weight:400;opacity:.6">optional</span><br>'
    + '<input id="qInRef" placeholder="e.g. Supplier: ABC, PO-123" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px"></label>'
    + '<button onclick="doQuickIn(\'' + code + '\')" style="background:#16a34a;color:#fff;border:none;border-radius:10px;padding:12px;font-weight:700;cursor:pointer;font-size:.95rem">▲ Add to Stock</button>'
    + '</div>'
  );
}

async function doQuickIn(code) {
  var qty = parseFloat(document.getElementById('qInQty').value) || 0;
  if (qty <= 0) { showToast('Enter a quantity > 0', true); return; }
  var r = await api('adjustInventory', {
    userId: currentUser.userId, itemCode: code,
    adjustment: qty, direction: 'IN',
    changeType: document.getElementById('qInType').value,
    unitPrice: parseFloat(document.getElementById('qInPrice').value) || 0,
    reference: document.getElementById('qInRef').value,
    notes: document.getElementById('qInRef').value,
  });
  closeModal();
  if (r.ok) { showToast('✅ +' + qty + ' added — stock now ' + r.qtyAfter); loadInventoryView(); }
  else showToast('Error: ' + r.error, true);
}

// ── Quick OUT modal ────────────────────────────────────────
function invQuickOut(code) {
  var item = _inventoryItems.find(function(i){ return i.item_code === code; });
  var name = item ? (item.item_name || code) : code;
  var cur = item ? parseFloat(item.stock_qty) : 0;
  showModal('▼ Stock OUT — ' + name,
    '<div style="background:#fef2f2;border-radius:10px;padding:10px 14px;margin-bottom:12px;display:flex;justify-content:space-between">'
    + '<span style="font-size:.82rem;color:#991b1b">Current stock</span>'
    + '<strong style="color:#991b1b">' + cur + ' ' + (item?item.unit:'') + '</strong></div>'
    + '<div style="display:flex;flex-direction:column;gap:10px">'
    + '<label style="font-size:.8rem;font-weight:600">Qty OUT (how much used/removed?)<br>'
    + '<input id="qOutQty" type="number" value="1" min="0.1" step="any" autofocus style="width:100%;padding:10px;border:2px solid #fecaca;border-radius:8px;font-size:1rem;font-weight:700;margin-top:3px"></label>'
    + '<label style="font-size:.8rem;font-weight:600">Reason<br>'
    + '<select id="qOutType" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px">'
    + '<option value="WASTE">🗑️ Waste / Spoilage / Expired</option>'
    + '<option value="ADJUSTMENT">✏️ Manual Correction</option>'
    + '<option value="SALE">💰 Manual Sale Deduction</option>'
    + '</select></label>'
    + '<label style="font-size:.8rem;font-weight:600">Notes <span style="font-weight:400;opacity:.6">optional</span><br>'
    + '<input id="qOutNotes" placeholder="e.g. Spoiled, wrong order..." style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px"></label>'
    + '<button onclick="doQuickOut(\'' + code + '\')" style="background:#dc2626;color:#fff;border:none;border-radius:10px;padding:12px;font-weight:700;cursor:pointer;font-size:.95rem">▼ Remove from Stock</button>'
    + '</div>'
  );
}

async function doQuickOut(code) {
  var qty = parseFloat(document.getElementById('qOutQty').value) || 0;
  if (qty <= 0) { showToast('Enter a quantity > 0', true); return; }
  var r = await api('adjustInventory', {
    userId: currentUser.userId, itemCode: code,
    adjustment: qty, direction: 'OUT',
    changeType: document.getElementById('qOutType').value,
    notes: document.getElementById('qOutNotes').value,
  });
  closeModal();
  if (r.ok) { showToast('▼ -' + qty + ' removed — stock now ' + r.qtyAfter); loadInventoryView(); }
  else showToast('Error: ' + r.error, true);
}

async function openInvAdd() {
  var menuItems = menuMgrItems.length > 0 ? menuMgrItems
    : (window._menuDataCache && window._menuDataCache.length ? window._menuDataCache : null);
  if (!menuItems) {
    var r = await api('getMenuAdmin', { userId: currentUser && currentUser.userId });
    menuItems = r.items || [];
  }
  var invR = await api('getInventory', { userId: currentUser && currentUser.userId });
  var trackedCodes = new Set((invR.items || []).map(function(i){ return i.item_code; }));

  var options = '<option value="">— Select a menu item —</option>'
    + menuItems.map(function(m) {
      var tracked = trackedCodes.has(m.code || m.item_code);
      var code = m.code || m.item_code;
      return '<option value="' + esc(code) + '"' + (tracked ? ' disabled' : '') + '>'
        + esc(m.name) + ' (' + esc(code) + ')' + (tracked ? ' — already tracked' : '') + '</option>';
    }).join('')
    + '<option value="__CUSTOM__">✏️ Enter code manually…</option>';

  showModal('Add Inventory Item',
    '<div style="display:flex;flex-direction:column;gap:10px">'
    + '<label style="font-size:.8rem;font-weight:600">Menu Item<br>'
    + '<select id="invItemSelect" onchange="invSelectChange(this)" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px">' + options + '</select></label>'
    + '<div id="invManualCodeWrap" style="display:none"><label style="font-size:.8rem;font-weight:600">Item Code (manual)<br>'
    + '<input id="invItemCode" placeholder="e.g. H001" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px"></label></div>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'
    + '<label style="font-size:.8rem;font-weight:600">Initial Stock Qty<br><input id="invQty" type="number" value="0" min="0" step="any" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px"></label>'
    + '<label style="font-size:.8rem;font-weight:600">Low Stock Threshold<br><input id="invThreshold" type="number" value="10" min="0" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px"></label>'
    + '</div>'
    + '<label style="font-size:.8rem;font-weight:600">Unit<br>'
    + '<select id="invUnit" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px">'
    + '<option>pcs</option><option>cups</option><option>shots</option><option>bottles</option><option>sachets</option>'
    + '<option>bags</option><option>boxes</option><option>g</option><option>kg</option>'
    + '<option>mL</option><option>L</option><option>tbsp</option><option>tsp</option><option>oz</option>'
    + '</select></label>'
    + '<label style="font-size:.8rem;font-weight:600">Size per unit <span style="font-weight:400;opacity:.6">e.g. 250g, 1L, 500mL</span><br>'
    + '<input id="invSizePer" placeholder="e.g. 1kg, 500mL, 250g" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px"></label>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'
    + '<label style="font-size:.8rem;font-weight:600">Cost Price (₱/unit)<br><input id="invCost" type="number" value="0" min="0" step="0.01" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px"></label>'
    + '<label style="font-size:.8rem;font-weight:600">Selling Price (₱/unit)<br><input id="invSell" type="number" value="0" min="0" step="0.01" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px"></label>'
    + '</div>'
    + '<label style="font-size:.8rem;font-weight:600">Photo <span style="font-weight:400;opacity:.6">optional</span><br>'
    + '<div style="display:flex;align-items:center;gap:10px;margin-top:4px">'
    + '<div id="invPhotoPreview" style="width:56px;height:56px;border-radius:8px;background:#f1f5f9;display:flex;align-items:center;justify-content:center;font-size:1.5rem;flex-shrink:0;overflow:hidden">📦</div>'
    + '<label style="flex:1;background:#eff6ff;color:#2563eb;border:1.5px dashed #93c5fd;border-radius:8px;padding:10px;text-align:center;cursor:pointer;font-size:.82rem;font-weight:600">'
    + '📷 Choose Photo<input type="file" id="invPhotoFile" accept="image/*" onchange="invPreviewPhoto(this)" style="display:none"></label>'
    + '</div></label>'
    + '<label style="display:flex;align-items:center;gap:8px;font-size:.8rem;font-weight:600;cursor:pointer">'
    + '<input type="checkbox" id="invAutoDisable"> Auto-disable menu item when stock = 0</label>'
    + '<button onclick="saveInvItem(null)" style="background:var(--forest-deep);color:#fff;border:none;border-radius:10px;padding:10px;font-weight:700;cursor:pointer;font-size:.9rem">Save Item</button>'
    + '</div>'
  );
}

function invPreviewPhoto(input) {
  if (!input.files || !input.files[0]) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    var prev = document.getElementById('invPhotoPreview');
    if (prev) prev.innerHTML = '<img src="' + e.target.result + '" style="width:100%;height:100%;object-fit:cover">';
  };
  reader.readAsDataURL(input.files[0]);
}

function invSelectChange(sel) {
  var wrap = document.getElementById('invManualCodeWrap');
  wrap.style.display = sel.value === '__CUSTOM__' ? 'block' : 'none';
  if (sel.value !== '__CUSTOM__' && document.getElementById('invItemCode'))
    document.getElementById('invItemCode').value = '';
}

function openInvEdit(itemCode) {
  var item = _inventoryItems.find(function(i){ return i.item_code === itemCode; });
  if (!item) return;
  var unitOpts = ['pcs','cups','shots','bottles','sachets','bags','boxes','g','kg','mL','L','tbsp','tsp','oz'];
  var curUnit = item.unit || 'pcs';

  showModal('⚙️ Edit: ' + esc(item.item_name || itemCode),
    '<div style="display:flex;flex-direction:column;gap:10px">'
    + '<div style="display:flex;gap:10px;align-items:center;margin-bottom:4px">'
    + '<div id="invEditPhotoPreview" style="width:64px;height:64px;border-radius:10px;background:#f1f5f9;display:flex;align-items:center;justify-content:center;font-size:1.8rem;flex-shrink:0;overflow:hidden">'
    + (item.photo_url ? '<img src="' + esc(item.photo_url) + '" style="width:100%;height:100%;object-fit:cover" onerror="this.parentElement.textContent=&quot;📦&quot;">' : '📦')
    + '</div>'
    + '<label style="flex:1;background:#eff6ff;color:#2563eb;border:1.5px dashed #93c5fd;border-radius:8px;padding:10px;text-align:center;cursor:pointer;font-size:.8rem;font-weight:600">'
    + '📷 Change Photo<input type="file" id="invEditPhotoFile" accept="image/*" onchange="invPreviewPhotoEdit(this)" style="display:none"></label>'
    + '</div>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'
    + '<label style="font-size:.8rem;font-weight:600">Low Stock Threshold<br><input id="invThreshold" type="number" value="' + item.low_stock_threshold + '" min="0" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px"></label>'
    + '<label style="font-size:.8rem;font-weight:600">Unit<br><select id="invUnit" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px">'
    + unitOpts.map(function(u){ return '<option' + (u===curUnit?' selected':'') + '>' + u + '</option>'; }).join('')
    + '</select></label>'
    + '</div>'
    + '<label style="font-size:.8rem;font-weight:600">Size per unit <span style="font-weight:400;opacity:.6">e.g. 250g, 1L</span><br>'
    + '<input id="invSizePer" value="' + esc(item.size_per_unit||'') + '" placeholder="e.g. 1kg, 500mL" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px"></label>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'
    + '<label style="font-size:.8rem;font-weight:600">Cost Price (₱/unit)<br><input id="invCost" type="number" value="' + (item.cost_per_unit||0) + '" step="0.01" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px"></label>'
    + '<label style="font-size:.8rem;font-weight:600">Selling Price (₱/unit)<br><input id="invSell" type="number" value="' + (item.selling_price||0) + '" step="0.01" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px"></label>'
    + '</div>'
    + '<label style="display:flex;align-items:center;gap:8px;font-size:.8rem;font-weight:600;cursor:pointer">'
    + '<input type="checkbox" id="invAutoDisable"' + (item.auto_disable?' checked':'') + '> Auto-disable menu item when stock = 0</label>'
    + '<button onclick="saveInvItem(\'' + itemCode + '\')" style="background:var(--forest-deep);color:#fff;border:none;border-radius:10px;padding:10px;font-weight:700;cursor:pointer;font-size:.9rem">Save Changes</button>'
    + '</div>'
  );
}

function invPreviewPhotoEdit(input) {
  if (!input.files || !input.files[0]) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    var prev = document.getElementById('invEditPhotoPreview');
    if (prev) prev.innerHTML = '<img src="' + e.target.result + '" style="width:100%;height:100%;object-fit:cover">';
  };
  reader.readAsDataURL(input.files[0]);
}

async function saveInvItem(existingCode) {
  var code = existingCode;
  if (!code) {
    var sel = document.getElementById('invItemSelect');
    var manual = document.getElementById('invItemCode');
    if (sel && sel.value && sel.value !== '__CUSTOM__' && sel.value !== '') {
      code = sel.value;
    } else if (manual && manual.value.trim()) {
      code = manual.value.trim();
    }
  }
  if (!code) { showToast('Please select a menu item', true); return; }

  // Handle photo upload first if a file was chosen
  var photoInputId = existingCode ? 'invEditPhotoFile' : 'invPhotoFile';
  var photoInput = document.getElementById(photoInputId);
  var photoUrl = null;
  if (photoInput && photoInput.files && photoInput.files[0]) {
    var file = photoInput.files[0];
    var reader = new FileReader();
    var b64 = await new Promise(function(res) {
      reader.onload = function(e) { res(e.target.result.split(',')[1]); };
      reader.readAsDataURL(file);
    });
    var uploadR = await api('uploadInventoryPhoto', {
      userId: currentUser.userId,
      itemCode: code,
      imageBase64: b64,
      mimeType: file.type || 'image/jpeg',
    });
    if (uploadR.ok) photoUrl = uploadR.photoUrl;
    else showToast('Photo upload failed: ' + uploadR.error, true);
  }

  var payload = {
    userId: currentUser.userId,
    itemCode: code,
    lowStockThreshold: document.getElementById('invThreshold').value,
    unit: document.getElementById('invUnit').value,
    sizePerUnit: (document.getElementById('invSizePer') || {value:''}).value,
    costPerUnit: document.getElementById('invCost').value,
    sellingPrice: (document.getElementById('invSell') || {value:0}).value,
    autoDisable: document.getElementById('invAutoDisable').checked,
  };
  if (!existingCode) {
    payload.stockQty = (document.getElementById('invQty')||{value:0}).value;
  }
  if (photoUrl) payload.photoUrl = photoUrl;

  var r = await api('upsertInventory', payload);
  closeModal();
  if (r.ok) { showToast('Inventory saved ✅'); loadInventoryView(); }
  else showToast('Error: ' + r.error, true);
}

function openInvAdjust(code, name, currentQty) { invQuickIn(code); } // legacy alias

async function doInvAdjust(code) {} // legacy stub

// ══════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════
// ADD-ONS / MODIFIERS
// ══════════════════════════════════════════════════════════
var _addons = [];

async function loadAddonsView() {
  var el = document.getElementById('addonsView');
  el.innerHTML = '<div style="padding:20px;color:#888">Loading add-ons…</div>';
  var r = await api('getAddonsAdmin', { userId: currentUser.userId });
  _addons = r.addons || [];
  renderAddonsView();
}

function renderAddonsView() {
  var el = document.getElementById('addonsView');
  var rowsHtml = _addons.length === 0
    ? '<div style="text-align:center;padding:40px;color:#94a3b8">No add-ons yet. Click <strong>+ Add</strong> to create your first modifier.</div>'
    : _addons.map(function(a) {
      var scopeLabel = a.applies_to_all ? 'All items' : (a.applies_to_codes||[]).join(', ') || 'Specific items';
      return '<div style="background:#fff;border-radius:12px;box-shadow:0 1px 6px rgba(0,0,0,.07);padding:14px 16px;display:flex;align-items:center;gap:12px;margin-bottom:8px;opacity:' + (a.is_active?'1':'.5') + '">'
        + '<div style="flex:1;min-width:0">'
        + '<div style="font-weight:700;font-size:.87rem">' + a.name + ' ' + (a.is_active?'':'<span style="background:#f1f5f9;color:#94a3b8;font-size:.68rem;padding:1px 6px;border-radius:4px">Inactive</span>') + '</div>'
        + '<div style="font-size:.72rem;color:#64748b;margin-top:2px">+₱' + parseFloat(a.price||0).toFixed(2) + ' · ' + scopeLabel + '</div>'
        + '</div>'
        + '<button onclick="openAddonEdit(\'' + a.addon_code + '\')" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:6px 10px;font-size:.78rem;cursor:pointer">Edit</button>'
        + '<button onclick="deleteAddon(\'' + a.addon_code + '\')" style="background:#fef2f2;color:#ef4444;border:none;border-radius:8px;padding:6px 10px;font-size:.78rem;cursor:pointer">Del</button>'
        + '</div>';
    }).join('');

  el.innerHTML = '<div style="padding:16px 16px 0">'
    + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">'
    + '<div style="font-weight:800;font-size:1.05rem;color:var(--forest-deep)">➕ Add-ons & Modifiers</div>'
    + '<button onclick="openAddonAdd()" style="background:var(--forest-deep);color:#fff;border:none;border-radius:10px;padding:8px 14px;font-size:.82rem;font-weight:700;cursor:pointer">+ Add</button>'
    + '</div>'
    + '<div style="font-size:.75rem;color:#64748b;margin-bottom:12px">Add-ons appear as options when customers add items to their cart.</div>'
    + rowsHtml + '</div>';
}

function addonForm(data) {
  data = data || {};
  var appliesToAll = data.applies_to_all !== false;
  var selectedCodes = data.applies_to_codes || [];

  // Build menu item checkboxes grouped by category
  var cats = {};
  var _menuForAddon = window._menuDataCache || eoMenuData || [];
  _menuForAddon.forEach(function(it) {
    var cat = it.category || 'Other';
    if (!cats[cat]) cats[cat] = [];
    cats[cat].push(it);
  });

  var itemsHtml = '';
  Object.keys(cats).sort().forEach(function(cat) {
    itemsHtml += '<div style="font-size:.72rem;font-weight:700;color:#64748b;text-transform:uppercase;margin:8px 0 4px">' + esc(cat) + '</div>';
    cats[cat].forEach(function(it) {
      var chk = selectedCodes.includes(it.code) ? ' checked' : '';
      itemsHtml += '<label style="display:flex;align-items:center;gap:8px;font-size:.8rem;cursor:pointer;padding:3px 0">'
        + '<input type="checkbox" class="addonItemChk" value="' + esc(it.code) + '"' + chk + '>'
        + esc(it.name) + ' <span style="color:#94a3b8;font-size:.72rem">' + it.code + '</span>'
        + '</label>';
    });
  });

  return '<div style="display:flex;flex-direction:column;gap:10px">'
    + '<label style="font-size:.8rem;font-weight:600">Name<br>'
    + '<input id="addonName" value="' + esc(data.name||'') + '" placeholder="e.g. Extra Shot, Nata De Coco" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px"></label>'
    + '<label style="font-size:.8rem;font-weight:600">Price (₱)<br>'
    + '<input id="addonPrice" type="number" value="' + (data.price||0) + '" min="0" step="1" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px"></label>'
    + '<label style="display:flex;align-items:center;gap:8px;font-size:.8rem;font-weight:600;cursor:pointer">'
    + '<input type="checkbox" id="addonAll" onchange="toggleAddonAllItems(this)"' + (appliesToAll?' checked':'') + '> Apply to ALL menu items</label>'
    + '<div id="addonItemsSection" style="' + (appliesToAll?'display:none':'') + ';border:1px solid #e2e8f0;border-radius:8px;padding:10px;max-height:240px;overflow-y:auto">'
    + '<div style="font-size:.75rem;font-weight:700;color:var(--forest);margin-bottom:6px">Select which drinks/items this applies to:</div>'
    + '<div style="display:flex;gap:8px;margin-bottom:8px">'
    + '<button type="button" onclick="addonCheckAll(true)" style="font-size:.7rem;padding:3px 10px;border:1px solid #e2e8f0;border-radius:6px;cursor:pointer;background:#f8fafc">All</button>'
    + '<button type="button" onclick="addonCheckAll(false)" style="font-size:.7rem;padding:3px 10px;border:1px solid #e2e8f0;border-radius:6px;cursor:pointer;background:#f8fafc">None</button>'
    + '</div>'
    + itemsHtml
    + '</div>'
    + '<label style="display:flex;align-items:center;gap:8px;font-size:.8rem;font-weight:600;cursor:pointer">'
    + '<input type="checkbox" id="addonActive"' + (data.is_active!==false?' checked':'') + '> Active</label>'
    + '<button onclick="saveAddonForm(\'' + (data.addon_code||'') + '\')" style="background:var(--forest-deep);color:#fff;border:none;border-radius:10px;padding:10px;font-weight:700;cursor:pointer;font-size:.9rem">Save</button>'
    + '</div>';
}

function toggleAddonAllItems(cb) {
  document.getElementById('addonItemsSection').style.display = cb.checked ? 'none' : '';
}
function addonCheckAll(val) {
  document.querySelectorAll('.addonItemChk').forEach(function(c){ c.checked = val; });
}

function openAddonAdd() {
  loadMenuCache().then(function() { showModal('New Add-on', addonForm({})); });
}
function openAddonEdit(code) {
  var a = _addons.find(function(x){ return x.addon_code === code; });
  if (!a) return;
  loadMenuCache().then(function() { showModal('Edit Add-on', addonForm(a)); });
}

async function saveAddonForm(existingCode) {
  var appliesToAll = document.getElementById('addonAll').checked;
  var appliesTo = [];
  if (!appliesToAll) {
    document.querySelectorAll('.addonItemChk:checked').forEach(function(c){ appliesTo.push(c.value); });
  }
  var r = await api('saveAddon', {
    userId: currentUser.userId,
    addonCode: existingCode || undefined,
    name: document.getElementById('addonName').value.trim(),
    price: parseFloat(document.getElementById('addonPrice').value) || 0,
    sortOrder: 0,
    appliesToAll: appliesToAll,
    appliesToCodes: appliesTo,
    isActive: document.getElementById('addonActive').checked,
  });
  closeModal();
  if (r.ok) { showToast('Add-on saved ✅'); loadAddonsView(); }
  else showToast('Error: ' + r.error, true);
}

async function deleteAddon(code) {
  if (!confirm('Remove this add-on?')) return;
  var r = await api('deleteAddon', { userId: currentUser.userId, addonCode: code });
  if (r.ok) { showToast('Add-on removed'); loadAddonsView(); }
  else showToast('Error: ' + r.error, true);
}

// ══════════════════════════════════════════════════════════
// VOID / REFUND WORKFLOW
// ══════════════════════════════════════════════════════════
var _refunds = [];

async function loadRefundsView() {
  var el = document.getElementById('refundsView');
  el.innerHTML = '<div style="padding:20px;color:#888">Loading refunds…</div>';
  var r = await api('getRefunds', { userId: currentUser.userId, limit: 50 });
  _refunds = r.refunds || [];
  renderRefundsView();
}

function renderRefundsView() {
  var el = document.getElementById('refundsView');
  var typeColors = { FULL:'#ef4444', PARTIAL:'#f59e0b', VOID:'#8b5cf6' };
  var reasonLabels = { WRONG_ORDER:'Wrong Order', DUPLICATE:'Duplicate', COMPLAINT:'Complaint',
    OVERCHARGE:'Overcharge', ITEM_UNAVAILABLE:'Item N/A', OTHER:'Other' };

  var rowsHtml = _refunds.length === 0
    ? '<div style="text-align:center;padding:40px;color:#94a3b8">No refunds yet.</div>'
    : _refunds.map(function(r) {
      var col = typeColors[r.refund_type] || '#64748b';
      return '<div style="background:#fff;border-radius:12px;box-shadow:0 1px 6px rgba(0,0,0,.07);padding:14px 16px;margin-bottom:8px">'
        + '<div style="display:flex;align-items:center;justify-content:space-between">'
        + '<div>'
        + '<span style="background:' + col + '22;color:' + col + ';border-radius:6px;padding:2px 8px;font-size:.7rem;font-weight:700;margin-right:6px">' + r.refund_type + '</span>'
        + '<span style="font-weight:700;font-size:.85rem">' + r.refund_id + '</span>'
        + '</div>'
        + '<div style="font-weight:800;color:#ef4444">-₱' + parseFloat(r.refund_amount).toFixed(2) + '</div>'
        + '</div>'
        + '<div style="font-size:.75rem;color:#64748b;margin-top:4px">'
        + 'Order: ' + r.order_id + ' · ' + (reasonLabels[r.reason_code]||r.reason_code)
        + (r.reason_note ? ' · ' + r.reason_note : '')
        + ' · ' + (r.refund_method||'—')
        + '</div>'
        + '<div style="font-size:.68rem;color:#94a3b8;margin-top:2px">' + new Date(r.created_at).toLocaleString('en-PH') + ' · ' + (r.processed_by||'—') + '</div>'
        + '</div>';
    }).join('');

  el.innerHTML = '<div style="padding:16px 16px 0">'
    + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">'
    + '<div style="font-weight:800;font-size:1.05rem;color:var(--forest-deep)">↩️ Void / Refunds</div>'
    + '<button onclick="openRefundForm()" style="background:#ef4444;color:#fff;border:none;border-radius:10px;padding:8px 14px;font-size:.82rem;font-weight:700;cursor:pointer">+ Process</button>'
    + '</div>'
    + rowsHtml + '</div>';
}

function openRefundForm(prefillOrderId) {
  showModal('Process Refund / Void',
    '<div style="display:flex;flex-direction:column;gap:10px">'
    + '<label style="font-size:.8rem;font-weight:600">Order ID<br>'
    + '<input id="rfOrderId" value="' + (prefillOrderId||'') + '" placeholder="ORD-XXXX" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px"></label>'
    + '<label style="font-size:.8rem;font-weight:600">Type<br>'
    + '<select id="rfType" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px">'
    + '<option value="FULL">Full Refund</option><option value="PARTIAL">Partial Refund</option><option value="VOID">Void (Cancel Order)</option>'
    + '</select></label>'
    + '<label style="font-size:.8rem;font-weight:600">Refund Amount (₱)<br>'
    + '<input id="rfAmount" type="number" value="0" min="0" step="0.01" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px"></label>'
    + '<label style="font-size:.8rem;font-weight:600">Reason<br>'
    + '<select id="rfReason" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px">'
    + '<option value="WRONG_ORDER">Wrong Order</option><option value="COMPLAINT">Complaint</option>'
    + '<option value="OVERCHARGE">Overcharge</option><option value="ITEM_UNAVAILABLE">Item Unavailable</option>'
    + '<option value="DUPLICATE">Duplicate Order</option><option value="OTHER">Other</option>'
    + '</select></label>'
    + '<label style="font-size:.8rem;font-weight:600">Notes<br>'
    + '<input id="rfNote" placeholder="Optional details" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px"></label>'
    + '<label style="font-size:.8rem;font-weight:600">Refund Method<br>'
    + '<select id="rfMethod" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px">'
    + '<option value="CASH">Cash</option><option value="GCASH">GCash</option>'
    + '<option value="BANK_TRANSFER">Bank Transfer</option><option value="STORE_CREDIT">Store Credit</option>'
    + '</select></label>'
    + '<div style="background:#fef2f2;border-radius:8px;padding:10px;font-size:.75rem;color:#991b1b">⚠️ Void will also cancel the order in the system and cannot be undone.</div>'
    + '<button onclick="submitRefund()" style="background:#ef4444;color:#fff;border:none;border-radius:10px;padding:10px;font-weight:700;cursor:pointer;font-size:.9rem">Process Refund / Void</button>'
    + '</div>'
  );
}

async function submitRefund() {
  var orderId = document.getElementById('rfOrderId').value.trim();
  var refundType = document.getElementById('rfType').value;
  var refundAmount = parseFloat(document.getElementById('rfAmount').value) || 0;
  var reasonCode = document.getElementById('rfReason').value;
  var reasonNote = document.getElementById('rfNote').value.trim();
  var refundMethod = document.getElementById('rfMethod').value;
  if (!orderId) { showToast('Order ID required', true); return; }
  if (refundType !== 'VOID' && refundAmount <= 0) { showToast('Enter refund amount', true); return; }
  var r = await api('processRefund', {
    userId: currentUser.userId, orderId, refundType, refundAmount, reasonCode, reasonNote, refundMethod
  });
  closeModal();
  if (r.ok) { showToast('Refund processed: ' + r.refundId + ' ✅'); loadRefundsView(); }
  else showToast('Error: ' + r.error, true);
}

// ══════════════════════════════════════════════════════════
// CASH DRAWER / EOD RECONCILIATION
// ══════════════════════════════════════════════════════════
var _openCashSession = null;
var _cashSessions = [];

// ── Cash session automation ─────────────────────────────────────────────────
async function checkCashSessionOnLogin() {
  if (!currentUser) return;
  var r = await api('getOpenCashSession');
  if (!r.ok) return;

  var session = r.session;

  if (!session) {
    // No open session — show banner prompting to open one
    showCashSessionBanner('no_session');
  } else {
    // Session is open — check if it's been open too long (>10h = end-of-day prompt)
    var openedAt = new Date(session.opened_at);
    var hoursOpen = (Date.now() - openedAt.getTime()) / (1000 * 60 * 60);
    if (hoursOpen >= 10) {
      showCashSessionBanner('close_prompt', session, hoursOpen);
    }
    _openCashSession = session;
  }
}

function showCashSessionBanner(type, session, hours) {
  // Remove any existing banner
  var existing = document.getElementById('cashSessionBanner');
  if (existing) existing.remove();

  var banner = document.createElement('div');
  banner.id = 'cashSessionBanner';
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;padding:10px 16px;display:flex;align-items:center;justify-content:space-between;font-size:.82rem;font-weight:600;box-shadow:0 2px 8px rgba(0,0,0,.15)';

  if (type === 'no_session') {
    banner.style.background = '#FEF3C7';
    banner.style.color = '#92400E';
    banner.style.borderBottom = '2px solid #F59E0B';
    banner.innerHTML =
      '<span>⚠️ No cash session open. Open one before taking orders.</span>' +
      '<div style="display:flex;gap:8px">' +
        '<button onclick="setFilter(\'CASH\');document.getElementById(\'cashSessionBanner\').remove()" ' +
          'style="background:#F59E0B;color:#fff;border:none;border-radius:6px;padding:5px 12px;cursor:pointer;font-weight:700;font-size:.78rem">Open Session</button>' +
        '<button onclick="document.getElementById(\'cashSessionBanner\').remove()" ' +
          'style="background:transparent;border:1px solid #F59E0B;border-radius:6px;padding:5px 10px;cursor:pointer;color:#92400E;font-size:.78rem">Dismiss</button>' +
      '</div>';
  } else if (type === 'close_prompt') {
    var h = Math.floor(hours || 0);
    banner.style.background = '#FEE2E2';
    banner.style.color = '#991B1B';
    banner.style.borderBottom = '2px solid #EF4444';
    banner.innerHTML =
      '<span>🔔 Cash session has been open ' + h + ' hours. End of shift — time to close and reconcile.</span>' +
      '<div style="display:flex;gap:8px">' +
        '<button onclick="setFilter(\'CASH\');document.getElementById(\'cashSessionBanner\').remove()" ' +
          'style="background:#EF4444;color:#fff;border:none;border-radius:6px;padding:5px 12px;cursor:pointer;font-weight:700;font-size:.78rem">Close Session</button>' +
        '<button onclick="document.getElementById(\'cashSessionBanner\').remove()" ' +
          'style="background:transparent;border:1px solid #EF4444;border-radius:6px;padding:5px 10px;cursor:pointer;color:#991B1B;font-size:.78rem">Dismiss</button>' +
      '</div>';
  }

  document.body.insertBefore(banner, document.body.firstChild);
  // Auto-dismiss after 30 seconds
  setTimeout(function() { if (banner.parentNode) banner.remove(); }, 30000);
}

async function loadCashView() {
  var el = document.getElementById('cashView');
  el.innerHTML = '<div style="padding:20px;color:#888">Loading cash sessions…</div>';
  var [openR, histR] = await Promise.all([
    api('getOpenCashSession'),
    api('getCashSessions', { userId: currentUser.userId, limit: 10 })
  ]);
  _openCashSession = openR.session || null;
  _cashSessions = histR.sessions || [];
  renderCashView();
}

function renderCashView() {
  var el = document.getElementById('cashView');
  var sessionHtml = '';

  if (_openCashSession) {
    var s = _openCashSession;
    sessionHtml = '<div style="background:linear-gradient(135deg,#064e3b,#065f46);border-radius:16px;padding:18px;color:#fff;margin-bottom:16px">'
      + '<div style="font-size:.72rem;opacity:.7;margin-bottom:2px">OPEN SESSION · ' + (s.shift||'AM') + ' SHIFT</div>'
      + '<div style="font-weight:800;font-size:1.05rem">' + s.session_id + '</div>'
      + '<div style="display:flex;gap:16px;margin-top:10px">'
      + '<div><div style="font-size:.68rem;opacity:.7">Opening Float</div><div style="font-weight:700">₱' + parseFloat(s.opening_float||0).toFixed(2) + '</div></div>'
      + '<div><div style="font-size:.68rem;opacity:.7">Opened At</div><div style="font-weight:700">' + new Date(s.opened_at).toLocaleTimeString('en-PH',{hour:'2-digit',minute:'2-digit'}) + '</div></div>'
      + '<div><div style="font-size:.68rem;opacity:.7">Opened By</div><div style="font-weight:700">' + (s.opened_by||'—') + '</div></div>'
      + '</div>'
      + '<button onclick="openCloseSessionModal()" style="margin-top:12px;width:100%;background:rgba(255,255,255,.15);color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:10px;padding:10px;font-weight:700;cursor:pointer;font-size:.88rem">🔒 Close Session / EOD Count</button>'
      + '</div>';
  } else {
    sessionHtml = '<div style="background:#f0fdf4;border:2px dashed #bbf7d0;border-radius:16px;padding:20px;text-align:center;margin-bottom:16px">'
      + '<div style="font-size:1.5rem;margin-bottom:6px">💵</div>'
      + '<div style="font-weight:700;color:#065f46;margin-bottom:4px">No Open Cash Session</div>'
      + '<div style="font-size:.78rem;color:#64748b;margin-bottom:12px">Open a session at the start of each shift to track cash sales and reconcile at end of day.</div>'
      + '<button onclick="openOpenSessionModal()" style="background:var(--forest-deep);color:#fff;border:none;border-radius:10px;padding:10px 20px;font-weight:700;cursor:pointer">Open Cash Session</button>'
      + '</div>';
  }

  var histHtml = _cashSessions.filter(function(s){ return s.status === 'CLOSED'; }).length === 0
    ? '<div style="text-align:center;padding:20px;color:#94a3b8;font-size:.82rem">No closed sessions yet.</div>'
    : _cashSessions.filter(function(s){ return s.status === 'CLOSED'; }).map(function(s) {
      var varColor = parseFloat(s.variance||0) === 0 ? '#64748b' : parseFloat(s.variance||0) > 0 ? '#22c55e' : '#ef4444';
      var varLabel = parseFloat(s.variance||0) === 0 ? 'Exact' : parseFloat(s.variance||0) > 0 ? 'OVER ₱' + Math.abs(s.variance).toFixed(2) : 'SHORT ₱' + Math.abs(s.variance).toFixed(2);
      return '<div style="background:#fff;border-radius:12px;box-shadow:0 1px 6px rgba(0,0,0,.07);padding:14px 16px;margin-bottom:8px">'
        + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">'
        + '<div><span style="font-weight:700;font-size:.85rem">' + s.session_id + '</span>'
        + ' <span style="font-size:.72rem;color:#64748b">' + (s.shift||'') + '</span></div>'
        + '<span style="font-weight:700;color:' + varColor + ';font-size:.82rem">' + varLabel + '</span>'
        + '</div>'
        + '<div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:6px">'
        + statCard('Float', '₱' + parseFloat(s.opening_float||0).toFixed(0), '#64748b', '#f8fafc')
        + statCard('Cash Sales', '₱' + parseFloat(s.cash_sales||0).toFixed(0), '#0284c7', '#eff6ff')
        + statCard('Expected', '₱' + parseFloat(s.expected_cash||0).toFixed(0), '#065f46', '#f0fdf4')
        + statCard('Counted', '₱' + parseFloat(s.closing_count||0).toFixed(0), varColor, varColor === '#ef4444' ? '#fef2f2' : '#f0fdf4')
        + '</div>'
        + '<div style="font-size:.68rem;color:#94a3b8;margin-top:6px">'
        + new Date(s.opened_at).toLocaleDateString('en-PH',{month:'short',day:'numeric'})
        + ' ' + new Date(s.opened_at).toLocaleTimeString('en-PH',{hour:'2-digit',minute:'2-digit'})
        + ' → ' + (s.closed_at ? new Date(s.closed_at).toLocaleTimeString('en-PH',{hour:'2-digit',minute:'2-digit'}) : '—')
        + ' · ' + (s.closed_by||'—')
        + (s.notes ? ' · ' + s.notes : '')
        + '</div></div>';
    }).join('');

  el.innerHTML = '<div style="padding:16px 16px 0">'
    + '<div style="font-weight:800;font-size:1.05rem;color:var(--forest-deep);margin-bottom:14px">💵 Cash Drawer</div>'
    + sessionHtml
    + '<div style="font-weight:700;font-size:.85rem;color:#475569;margin-bottom:8px">Session History</div>'
    + histHtml + '</div>';
}

function openOpenSessionModal() {
  var shiftSel = '<select id="cashShift" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px">'
    + '<option value="AM">AM Shift</option><option value="PM">PM Shift</option>'
    + '<option value="FULL">Full Day</option><option value="CUSTOM">Custom</option></select>';
  showModal('Open Cash Session',
    '<div style="display:flex;flex-direction:column;gap:10px">'
    + '<label style="font-size:.8rem;font-weight:600">Shift<br>' + shiftSel + '</label>'
    + '<label style="font-size:.8rem;font-weight:600">Opening Float (₱) — Cash in drawer at start<br>'
    + '<input id="cashFloat" type="number" value="500" min="0" step="50" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px"></label>'
    + '<button onclick="doOpenSession()" style="background:var(--forest-deep);color:#fff;border:none;border-radius:10px;padding:10px;font-weight:700;cursor:pointer;font-size:.9rem">Open Session</button>'
    + '</div>'
  );
}

async function doOpenSession() {
  var r = await api('openCashSession', {
    userId: currentUser.userId,
    shift: document.getElementById('cashShift').value,
    openingFloat: parseFloat(document.getElementById('cashFloat').value) || 0,
  });
  closeModal();
  if (r.ok) { showToast('Cash session opened ✅'); loadCashView(); }
  else showToast(r.error || 'Error', true);
}

function openCloseSessionModal() {
  if (!_openCashSession) return;
  var denominations = [1000, 500, 200, 100, 50, 20, 10, 5, 1];
  var denomHtml = denominations.map(function(d) {
    return '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">'
      + '<span style="min-width:50px;font-size:.8rem;font-weight:600">₱' + d + '</span>'
      + '<input type="number" id="denom_' + d + '" value="0" min="0" placeholder="0" '
      + 'oninput="calcDenomTotal()" '
      + 'style="width:80px;padding:6px;border:1px solid #e2e8f0;border-radius:7px;font-size:.85rem">'
      + '<span style="font-size:.78rem;color:#64748b">pcs</span>'
      + '<span id="denomAmt_' + d + '" style="font-size:.78rem;color:#475569;min-width:60px;text-align:right">= ₱0</span>'
      + '</div>';
  }).join('');

  showModal('Close Session — EOD Count',
    '<div style="display:flex;flex-direction:column;gap:10px">'
    + '<div style="font-size:.8rem;font-weight:700;color:#475569;margin-bottom:4px">Count denominations (or enter total directly):</div>'
    + denomHtml
    + '<div style="background:#f8fafc;border-radius:10px;padding:10px;display:flex;justify-content:space-between;align-items:center">'
    + '<span style="font-weight:700;font-size:.85rem">Total Counted:</span>'
    + '<span id="denomTotal" style="font-weight:800;font-size:1.05rem;color:var(--forest-deep)">₱0.00</span>'
    + '</div>'
    + '<label style="font-size:.8rem;font-weight:600">Or enter total directly (₱):<br>'
    + '<input id="cashClosingCount" type="number" value="" placeholder="Leave blank to use denomination count" '
    + 'style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px"></label>'
    + '<label style="font-size:.8rem;font-weight:600">Notes<br>'
    + '<input id="cashCloseNotes" placeholder="Optional shift notes" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px"></label>'
    + '<button onclick="doCloseSession()" style="background:#064e3b;color:#fff;border:none;border-radius:10px;padding:10px;font-weight:700;cursor:pointer;font-size:.9rem">Close Session & Reconcile</button>'
    + '</div>'
  );
}

function calcDenomTotal() {
  var denominations = [1000,500,200,100,50,20,10,5,1];
  var total = 0;
  denominations.forEach(function(d) {
    var count = parseInt(document.getElementById('denom_' + d).value) || 0;
    var amt = count * d;
    total += amt;
    document.getElementById('denomAmt_' + d).textContent = '= ₱' + amt.toLocaleString();
  });
  document.getElementById('denomTotal').textContent = '₱' + total.toLocaleString('en-PH', {minimumFractionDigits:2});
  // Update closing count field
  var ccInput = document.getElementById('cashClosingCount');
  if (ccInput && !ccInput.value) ccInput.placeholder = total.toFixed(2);
}

async function doCloseSession() {
  var denominations = [1000,500,200,100,50,20,10,5,1];
  var denomBreakdown = {};
  var denomTotal = 0;
  denominations.forEach(function(d) {
    var count = parseInt(document.getElementById('denom_' + d).value) || 0;
    if (count > 0) { denomBreakdown[d] = count; denomTotal += count * d; }
  });
  var manualTotal = parseFloat(document.getElementById('cashClosingCount').value);
  var closingCount = isNaN(manualTotal) ? denomTotal : manualTotal;
  var r = await api('closeCashSession', {
    userId: currentUser.userId,
    sessionId: _openCashSession.session_id,
    closingCount: closingCount,
    denominationBreakdown: denomBreakdown,
    notes: document.getElementById('cashCloseNotes').value,
  });
  closeModal();
  if (r.ok) {
    var msg = '✅ Session closed — ' + r.overShort
      + ' | Total Sales: ₱' + parseFloat(r.totalSales).toFixed(2);
    showToast(msg);
    loadCashView();
  } else showToast('Error: ' + r.error, true);
}

// ══════════════════════════════════════════════════════════
// QUICK REFUND button on order cards
// ══════════════════════════════════════════════════════════
function showRefundFromOrder(orderId) {
  setFilter('REFUNDS');
  setTimeout(function() { openRefundForm(orderId); }, 300);
}
