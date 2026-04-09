

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
  var counts = { ALL:0, ACTIVE:0, NEW:0, PREPARING:0, READY:0, COMPLETED:0, CANCELLED:0, PLATFORM:0 };
  allOrders.forEach(function(o) {
    counts.ALL++;
    if (!o.isTest) counts[o.status] = (counts[o.status] || 0) + 1; // exclude test from status counts
    if (!o.isTest && (o.status === 'NEW' || o.status === 'PREPARING' || o.status === 'READY')) counts.ACTIVE++;
    if (o.platform) counts.PLATFORM++;
  });

  var tabs = [
    { key:'ACTIVE', label:'🔥 Active', count:counts.ACTIVE },
    { key:'NEW', label:'🔔 New', count:counts.NEW },
    { key:'PREPARING', label:'👨‍🍳 Preparing', count:counts.PREPARING },
    { key:'READY', label:'✨ Ready', count:counts.READY },
    { key:'COMPLETED', label:'🎉 Done', count:counts.COMPLETED },
    { key:'PLATFORM', label:'📦 Platform', count:counts.PLATFORM },
    { key:'ALL', label:'All', count:counts.ALL }
  ];
  // Payments tab: SERVER, ADMIN, OWNER only
  if (currentUser.role !== 'KITCHEN') {
    tabs.push({ key:'PAYMENTS', label:'💳 Payments', count:pendingPayCount });
  }
  // Menu Manager tab: ADMIN and OWNER only
  if (currentUser.role === 'ADMIN' || currentUser.role === 'OWNER') {
    tabs.push({ key:'MENU_MANAGER', label:'🍽️ Menu', count:'' });
  }
  // Online Orders tab: ALL roles can see it
  tabs.push({ key:'ONLINE_ORDERS', label:'🛵 Online', count:onlineOrderPendingCount || '' });
  // Sheets tab: ADMIN and OWNER only
  if (currentUser.role === 'ADMIN' || currentUser.role === 'OWNER') {
    tabs.push({ key:'SHEETS', label:'📊 Sheets', count:'' });
  }
  // Analytics tab: OWNER and ADMIN only
  if (currentUser.role === 'ADMIN' || currentUser.role === 'OWNER') {
    tabs.push({ key:'ANALYTICS', label:'📈 Analytics', count:'' });
  }
  // Tables & Reservations: ADMIN and OWNER only
  if (currentUser.role === 'ADMIN' || currentUser.role === 'OWNER') {
    tabs.push({ key:'TABLES', label:'🪑 Tables', count:'' });
    tabs.push({ key:'FLOOR_MAP', label:'🗺️ Floor', count:'' });
  }
  // Inventory: ADMIN and OWNER only
  if (currentUser.role === 'ADMIN' || currentUser.role === 'OWNER') {
    tabs.push({ key:'INVENTORY', label:'📦 Inventory', count:'' });
    tabs.push({ key:'ADDONS', label:'➕ Add-ons', count:'' });
  }
  // Refunds & Cash: OWNER only
  if (currentUser.role === 'OWNER') {
    tabs.push({ key:'REFUNDS', label:'↩️ Refunds', count:'' });
    tabs.push({ key:'CASH', label:'💵 Cash', count:'' });
  }
  // Settings: OWNER only
  if (currentUser.role === 'OWNER') {
    tabs.push({ key:'SETTINGS', label:'⚙️ Settings', count:'' });
    tabs.push({ key:'STAFF', label:'👥 Staff', count:'' });
    tabs.push({ key:'SHIFT', label:'📋 Shift', count:'' });
    tabs.push({ key:'LOGS', label:'📜 Logs', count:'' });
    tabs.push({ key:'COSTING', label:'🧮 Costing', count:'' });
  }

  // Only rebuild DOM if tab counts changed — prevents flicker on every 5s poll
  var newHash = tabs.map(function(t){return t.key+':'+t.count;}).join('|') + '|active:'+currentFilter;
  if (window._filterHash === newHash) return; // nothing changed, skip DOM rebuild
  window._filterHash = newHash;

  document.getElementById('filterBar').innerHTML = tabs.map(function(t) {
    return '<button class="filter-btn' + (currentFilter===t.key?' active':'') + '" onclick="setFilter(\'' + t.key + '\')">' +
      t.label + '<span class="filter-count">' + t.count + '</span></button>';
  }).join('');
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
