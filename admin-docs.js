// ════════════════════════════════════════════════════════════════════════
// DOCS — BIR documents center (Management)
//   Panel 1: Daily Sales — standalone manual SI ledger (table: docs_daily_sales)
//            insert / edit / void, SI No. unique-enforced, skipped-serial flag,
//            pre-fill from a POS order.  Decoupled from live orders by design.
//   Panel 2: Daily Transactions — read-only, auto-updating, wired from current
//            sales (view: v_docs_daily_transactions), split CASH / CARD / QR,
//            with reconciliation vs the ledger.
//   Self-contained: reuses the global Supabase client, defines its own helpers,
//   and is fully wrapped so a failure here never crashes the rest of admin.
// ════════════════════════════════════════════════════════════════════════

var _docsDate      = null;     // yyyy-mm-dd currently viewed (ledger)
var _docsLedger    = [];       // docs_daily_sales rows for _docsDate
var _docsLive      = [];       // v_docs_daily_transactions rows for today
var _docsEditId    = null;     // id of row being edited (null = new)
var _docsPrefilled = false;    // was the open form pre-filled from an order?
var _docsLiveTimer = null;     // live panel auto-refresh interval
var _docsSiMin     = 1;        // current booklet serial range (informational)
var _docsSiMax     = 500;

function _docsSb() {
  try {
    if (typeof _supabaseClient !== 'undefined' && _supabaseClient) return _supabaseClient;
    var url = (typeof APP_CONFIG !== 'undefined' && APP_CONFIG.SUPABASE_URL) ||
              (window.SUPABASE_URL) || 'https://hnynvclpvfxzlfjphefj.supabase.co';
    var key = (typeof APP_CONFIG !== 'undefined' && APP_CONFIG.SUPABASE_ANON_KEY) ||
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhueW52Y2xwdmZ4emxmanBoZWZqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0NTg5MTMsImV4cCI6MjA4ODAzNDkxM30.cBIoq9dVUFC0d7Su5B7ubBG83-q-bffheKoOCTRDqXE';
    if (!key || typeof supabase === 'undefined') return null;
    if (!window._docsSbClient) window._docsSbClient = supabase.createClient(url, key);
    return window._docsSbClient;
  } catch (e) { return null; }
}

function _dEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function _dPeso(n) {
  var v = Number(n || 0);
  return '\u20b1' + v.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function _dTodayManila() {
  // en-CA gives yyyy-mm-dd; pin to Manila so "today" matches the cafe day
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
}
function _dTime(ts) {
  try { return new Date(ts).toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' }); }
  catch (e) { return ''; }
}
function _dUser() {
  try { return (typeof currentUser !== 'undefined' && currentUser && currentUser.username) ? currentUser.username : 'admin'; }
  catch (e) { return 'admin'; }
}
var _DOCS_BUCKET_STYLE = {
  CASH:         { bg: '#dcfce7', fg: '#166534', label: 'CASH' },
  CARD:         { bg: '#ede9fe', fg: '#5b21b6', label: 'CARD' },
  QR:           { bg: '#dbeafe', fg: '#1e40af', label: 'QR' },
  SPLIT:        { bg: '#fef3c7', fg: '#92400e', label: 'SPLIT' },
  UNCLASSIFIED: { bg: '#f1f5f9', fg: '#475569', label: 'N/A' }
};
function _docsBadge(bucket) {
  var s = _DOCS_BUCKET_STYLE[bucket] || _DOCS_BUCKET_STYLE.UNCLASSIFIED;
  return '<span style="font-size:.62rem;font-weight:700;padding:2px 8px;border-radius:20px;background:' +
    s.bg + ';color:' + s.fg + '">' + s.label + '</span>';
}

// ── Entry point (called by setFilter('DOCS')) ──────────────────────────────
async function loadDocsView() {
  var view = document.getElementById('docsView');
  if (!view) return;
  if (!_docsDate) _docsDate = _dTodayManila();
  view.innerHTML = '<div style="padding:32px;text-align:center;color:var(--timber)">Loading DOCS…</div>';
  try {
    await Promise.all([loadDocsLedger(), loadDocsLive()]);
    renderDocsView();
    _docsStartLive();
  } catch (e) {
    console.warn('loadDocsView failed', e);
    view.innerHTML = '<div style="padding:32px;text-align:center;color:#dc2626">Could not load DOCS. ' + _dEsc(e.message || e) + '</div>';
  }
}

async function loadDocsLedger() {
  var sb = _docsSb(); if (!sb) { _docsLedger = []; return; }
  var r = await sb.from('docs_daily_sales').select('*').eq('sale_date', _docsDate).order('si_no', { ascending: true });
  if (r.error) throw r.error;
  _docsLedger = r.data || [];
}
async function loadDocsLive() {
  var sb = _docsSb(); if (!sb) { _docsLive = []; return; }
  var today = _dTodayManila();
  var r = await sb.from('v_docs_daily_transactions').select('*')
    .eq('sale_date', today).eq('status', 'COMPLETED')
    .order('created_at', { ascending: false });
  if (r.error) throw r.error;
  _docsLive = r.data || [];
}

// ── Live panel auto-refresh (stops itself when the view is hidden) ─────────
function _docsStartLive() {
  if (_docsLiveTimer) clearInterval(_docsLiveTimer);
  _docsLiveTimer = setInterval(async function () {
    var v = document.getElementById('docsView');
    if (!v || v.style.display === 'none') { clearInterval(_docsLiveTimer); _docsLiveTimer = null; return; }
    try { await loadDocsLive(); _renderLivePanel(); } catch (e) { /* silent */ }
  }, 25000);
}

// ── Render ─────────────────────────────────────────────────────────────────
function renderDocsView() {
  var view = document.getElementById('docsView');
  if (!view) return;
  var html = '';
  html += '<div style="max-width:1100px;margin:0 auto">';
  html += '<div style="display:flex;align-items:center;gap:10px;margin:4px 0 18px">';
  html += '<span style="font-size:1.4rem">\ud83d\udcc4</span>';
  html += '<div><div style="font-family:var(--font-soul);font-weight:700;font-size:1.15rem;color:var(--forest-deep)">DOCS</div>';
  html += '<div style="font-size:.7rem;color:var(--timber)">BIR sales records · Management</div></div></div>';
  html += _renderLedgerPanelShell();
  html += '<div style="height:26px"></div>';
  html += '<div id="docsLivePanel"></div>';
  html += '</div>';
  view.innerHTML = html;
  _renderLivePanel();
}

function _renderLedgerPanelShell() {
  var active = _docsLedger.filter(function (r) { return r.status === 'ACTIVE'; });
  var sum = function (k) { return active.reduce(function (a, r) { return a + Number(r[k] || 0); }, 0); };
  var net = sum('net_total'), disc = sum('discount_amount');
  var byBucket = { CASH: 0, CARD: 0, QR: 0 };
  active.forEach(function (r) { if (byBucket[r.payment_bucket] != null) byBucket[r.payment_bucket] += Number(r.net_total || 0); });

  var h = '';
  h += '<div style="background:var(--white);border:1.5px solid var(--mist);border-radius:var(--r-lg);overflow:hidden">';
  // header
  h += '<div style="padding:12px 16px;border-bottom:1px solid var(--mist);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">';
  h += '<div style="display:flex;align-items:center;gap:8px"><span style="font-weight:700;color:var(--forest-deep)">Daily sales</span>';
  h += '<span style="font-size:.6rem;font-weight:700;background:#dcfce7;color:#166534;padding:2px 8px;border-radius:20px">MANUAL LEDGER · BIR</span></div>';
  h += '<div style="display:flex;align-items:center;gap:8px">';
  h += '<input id="docsDatePick" type="date" value="' + _dEsc(_docsDate) + '" onchange="docsChangeDate(this.value)" style="font-size:.78rem;padding:6px 8px;border:1.5px solid var(--mist);border-radius:var(--r-sm)">';
  h += '<button onclick="docsResetForm(true)" style="font-size:.74rem;padding:7px 12px;background:var(--forest);color:#fff;border:none;border-radius:var(--r-sm);font-weight:700;cursor:pointer">+ New entry</button>';
  h += '</div></div>';

  // summary cards
  h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;padding:14px 16px">';
  h += _docsStat('Net sales logged', _dPeso(net), 'var(--forest)');
  h += _docsStat('Invoices', String(active.length) + (_docsLedger.length - active.length ? '  +' + (_docsLedger.length - active.length) + ' void' : ''), 'var(--forest)');
  h += _docsStat('Cash', _dPeso(byBucket.CASH), '#166534');
  h += _docsStat('Card', _dPeso(byBucket.CARD), '#5b21b6');
  h += _docsStat('QR', _dPeso(byBucket.QR), '#1e40af');
  h += _docsStat('Discounts', '-' + _dPeso(disc), '#dc2626');
  h += '</div>';

  // entry form
  h += _renderEntryForm();

  // ledger rows + gap detection
  h += '<div style="padding:4px 16px 16px">';
  h += _renderLedgerRows();
  h += '</div>';

  h += '<div style="padding:0 16px 14px;font-size:.66rem;color:var(--timber);line-height:1.6">';
  h += 'SI No. unique-enforced · duplicates blocked, gaps flagged · voids keep the serial (never deleted)</div>';

  h += '</div>';
  return h;
}

function _docsStat(label, value, color) {
  return '<div style="background:var(--cream);border-radius:var(--r-sm);padding:10px 12px">' +
    '<div style="font-size:.62rem;color:var(--timber);font-weight:600;text-transform:uppercase;letter-spacing:.4px">' + _dEsc(label) + '</div>' +
    '<div style="font-size:1.05rem;font-weight:700;color:' + color + ';margin-top:2px">' + value + '</div></div>';
}

function _renderEntryForm() {
  var editing = !!_docsEditId;
  var inp = function (id, ph, type, val, extra) {
    return '<input id="' + id + '" type="' + (type || 'text') + '" placeholder="' + _dEsc(ph) + '" value="' + _dEsc(val == null ? '' : val) + '" ' +
      (extra || '') + ' style="width:100%;font-size:.8rem;padding:7px 9px;border:1.5px solid var(--mist);border-radius:var(--r-sm)">';
  };
  var h = '';
  h += '<div style="margin:0 16px 14px;padding:14px;border:1.5px solid var(--mist);border-radius:var(--r-lg);background:var(--cream)">';
  h += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:11px">';
  h += '<span style="font-weight:700;font-size:.82rem;color:var(--forest-deep)">' + (editing ? '\u270e Edit invoice' : '\u270d New invoice') + '</span>';
  // pre-fill helper
  h += '<span style="display:flex;gap:6px"><input id="docsPrefillOrder" placeholder="Order # e.g. YANI-1043" style="font-size:.74rem;padding:6px 8px;border:1.5px dashed #2563eb;border-radius:var(--r-sm)">' +
    '<button onclick="docsPrefillFromOrder()" style="font-size:.72rem;padding:6px 10px;background:#dbeafe;color:#1e40af;border:none;border-radius:var(--r-sm);font-weight:700;cursor:pointer">Pre-fill</button></span>';
  h += '</div>';

  h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-bottom:8px">';
  h += '<div><label style="font-size:.62rem;color:var(--timber)">SI No.*</label>' + inp('docsSiNo', '382', 'number', '', 'min="1"') + '</div>';
  h += '<div><label style="font-size:.62rem;color:var(--timber)">Order # (optional)</label>' + inp('docsOrderRef', 'YANI-1043', 'text', '') + '</div>';
  h += '<div><label style="font-size:.62rem;color:var(--timber)">Payment</label>' +
    '<select id="docsBucket" style="width:100%;font-size:.8rem;padding:7px 9px;border:1.5px solid var(--mist);border-radius:var(--r-sm)">' +
    '<option value="CASH">CASH</option><option value="CARD">CARD</option><option value="QR">QR</option></select></div>';
  h += '</div>';

  h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-bottom:8px">';
  h += '<div><label style="font-size:.62rem;color:var(--timber)">Registered name</label>' + inp('docsCustName', 'Walk-in / Member', 'text', '') + '</div>';
  h += '<div><label style="font-size:.62rem;color:var(--timber)">TIN</label>' + inp('docsCustTin', '', 'text', '') + '</div>';
  h += '<div><label style="font-size:.62rem;color:var(--timber)">Address</label>' + inp('docsCustAddr', '', 'text', '') + '</div>';
  h += '</div>';

  h += '<div style="margin-bottom:8px"><label style="font-size:.62rem;color:var(--timber)">Items / nature of service</label>' + inp('docsItems', 'Iced Dark Cacao (Tall|Comfort); Hot Americano…', 'text', '') + '</div>';

  h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:8px">';
  h += '<div><label style="font-size:.62rem;color:var(--timber)">Gross*</label>' + inp('docsGross', '0.00', 'number', '', 'step="0.01" oninput="docsRecalcNet()"') + '</div>';
  h += '<div><label style="font-size:.62rem;color:var(--timber)">Discount type</label>' +
    '<select id="docsDiscType" style="width:100%;font-size:.8rem;padding:7px 9px;border:1.5px solid var(--mist);border-radius:var(--r-sm)">' +
    '<option value="">none</option><option>SC</option><option>PWD</option><option>NAAC</option><option>MOV</option><option>SP</option><option>PROMO</option></select></div>';
  h += '<div><label style="font-size:.62rem;color:var(--timber)">Discount ₱</label>' + inp('docsDiscAmt', '0.00', 'number', '0', 'step="0.01" oninput="docsRecalcNet()"') + '</div>';
  h += '<div><label style="font-size:.62rem;color:var(--timber)">Withholding ₱</label>' + inp('docsWht', '0.00', 'number', '0', 'step="0.01" oninput="docsRecalcNet()"') + '</div>';
  h += '<div><label style="font-size:.62rem;color:var(--timber)">SC/PWD ID</label>' + inp('docsScId', '', 'text', '') + '</div>';
  h += '</div>';

  h += '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:6px">';
  h += '<div style="font-size:.9rem;font-weight:700;color:var(--forest-deep)">Total due: <span id="docsNetOut">\u20b10.00</span></div>';
  h += '<div style="display:flex;gap:8px">';
  if (editing) h += '<button onclick="docsResetForm(false)" style="font-size:.78rem;padding:8px 14px;background:var(--mist);color:var(--forest-deep);border:none;border-radius:var(--r-sm);font-weight:700;cursor:pointer">Cancel</button>';
  h += '<button onclick="docsSaveEntry()" style="font-size:.8rem;padding:8px 18px;background:var(--forest);color:#fff;border:none;border-radius:var(--r-sm);font-weight:700;cursor:pointer">' + (editing ? '\ud83d\udcbe Update' : '\ud83d\udcbe Save to ledger') + '</button>';
  h += '</div></div>';
  h += '</div>';
  return h;
}

function _renderLedgerRows() {
  if (!_docsLedger.length) {
    return '<div style="padding:22px;text-align:center;color:var(--timber);font-size:.8rem">No invoices logged for this date yet.</div>';
  }
  var h = '';
  // gap detection across the logged serials
  var nums = _docsLedger.map(function (r) { return Number(r.si_no); }).sort(function (a, b) { return a - b; });
  var gaps = [];
  for (var i = 1; i < nums.length; i++) {
    for (var n = nums[i - 1] + 1; n < nums[i]; n++) gaps.push(n);
  }
  _docsLedger.forEach(function (r) {
    var voided = r.status === 'VOID';
    var strike = voided ? 'text-decoration:line-through;color:var(--timber)' : '';
    h += '<div style="display:flex;align-items:center;gap:10px;padding:9px 6px;border-bottom:0.5px solid var(--mist)' + (voided ? ';opacity:.65' : '') + '">';
    h += '<div style="min-width:0;flex:1">';
    h += '<div style="font-family:var(--font-mono,monospace);font-size:.8rem;font-weight:700;color:var(--forest-deep);' + strike + '">No. ' + String(r.si_no).padStart(7, '0') + '</div>';
    h += '<div style="font-size:.66rem;color:var(--timber)">' + (r.order_id ? _dEsc(r.order_id) + ' · ' : '') + _dTime(r.created_at) +
      (r.discount_type ? ' · ' + _dEsc(r.discount_type) + ' -' + _dPeso(r.discount_amount) : '') +
      (voided && r.void_reason ? ' · void: ' + _dEsc(r.void_reason) : '') + '</div>';
    h += '</div>';
    h += '<div>' + (voided ? '<span style="font-size:.62rem;font-weight:700;padding:2px 8px;border-radius:20px;background:#fee2e2;color:#991b1b">VOID</span>' : _docsBadge(r.payment_bucket)) + '</div>';
    h += '<div style="text-align:right;min-width:84px;font-size:.85rem;font-weight:700;color:var(--forest-deep);' + strike + '">' + _dPeso(r.net_total) + '</div>';
    h += '<div style="display:flex;gap:4px">';
    if (!voided) {
      h += '<button title="Edit" onclick="docsEditEntry(' + r.id + ')" style="border:1px solid var(--mist);background:#fff;border-radius:6px;padding:4px 7px;cursor:pointer;font-size:.7rem">\u270e</button>';
      h += '<button title="Void" onclick="docsVoidEntry(' + r.id + ')" style="border:1px solid #fecaca;background:#fff;color:#dc2626;border-radius:6px;padding:4px 7px;cursor:pointer;font-size:.7rem">\u2298</button>';
    }
    h += '</div></div>';
  });
  if (gaps.length) {
    h += '<div style="margin-top:8px;display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:var(--r-sm);background:#fffbeb;color:#92400e;font-size:.7rem">' +
      '\u26a0\ufe0f Skipped serial' + (gaps.length > 1 ? 's' : '') + ': ' + gaps.map(function (n) { return 'No. ' + String(n).padStart(7, '0'); }).join(', ') + '</div>';
  }
  return h;
}

function _renderLivePanel() {
  var el = document.getElementById('docsLivePanel');
  if (!el) return;
  var isToday = _docsDate === _dTodayManila();
  var bucket = { CARD: { n: 0, amt: 0 }, QR: { n: 0, amt: 0 }, CASH: { n: 0, amt: 0 } };
  var liveTotal = 0;
  _docsLive.forEach(function (r) {
    liveTotal += Number(r.total || 0);
    if (bucket[r.payment_bucket]) { bucket[r.payment_bucket].n++; bucket[r.payment_bucket].amt += Number(r.total || 0); }
  });
  var ledgerNet = _docsLedger.filter(function (r) { return r.status === 'ACTIVE'; })
    .reduce(function (a, r) { return a + Number(r.net_total || 0); }, 0);

  var h = '';
  h += '<div style="background:var(--white);border:1.5px solid var(--mist);border-radius:var(--r-lg);overflow:hidden">';
  h += '<div style="padding:12px 16px;border-bottom:1px solid var(--mist);display:flex;align-items:center;gap:10px">';
  h += '<span style="font-weight:700;color:var(--forest-deep)">Daily transactions</span>';
  h += '<span style="display:inline-flex;align-items:center;gap:5px;font-size:.62rem;color:#dc2626"><span style="width:7px;height:7px;border-radius:50%;background:#dc2626;display:inline-block"></span>LIVE</span>';
  h += '<span style="font-size:.66rem;color:var(--timber)">auto-updates from current sales · today</span></div>';

  // bucket rows
  var row = function (key, ico, name) {
    var b = bucket[key], s = _DOCS_BUCKET_STYLE[key];
    return '<div style="display:flex;align-items:center;justify-content:space-between;padding:11px 12px;border-radius:var(--r-sm);background:' + s.bg + ';margin-bottom:8px">' +
      '<span style="color:' + s.fg + ';font-size:.82rem;font-weight:600">' + ico + ' ' + name + '</span>' +
      '<span style="color:' + s.fg + ';font-weight:700">' + _dPeso(b.amt) + ' <span style="font-size:.7rem;font-weight:400">· ' + b.n + '</span></span></div>';
  };
  h += '<div style="padding:14px 16px 6px">';
  h += row('CARD', '\ud83d\udcb3', 'Card (Yani Card)');
  h += row('QR', '\ud83d\udcf1', 'QR (GCash / bank)');
  h += row('CASH', '\ud83d\udcb5', 'Cash');
  h += '</div>';

  // live feed
  h += '<div style="padding:0 16px 8px"><div style="font-size:.66rem;font-weight:700;color:var(--timber);margin-bottom:6px">Live feed</div>';
  if (!_docsLive.length) {
    h += '<div style="padding:14px;text-align:center;color:var(--timber);font-size:.76rem">No completed sales yet today.</div>';
  } else {
    _docsLive.slice(0, 8).forEach(function (r) {
      h += '<div style="display:flex;align-items:center;gap:10px;padding:7px 4px;border-bottom:0.5px solid var(--mist)">';
      h += '<span style="font-size:.66rem;color:var(--timber);min-width:48px">' + _dTime(r.created_at) + '</span>';
      h += '<span style="flex:1;font-size:.78rem;color:var(--forest-deep)">' + _dEsc(r.order_id || '') + '</span>';
      h += _docsBadge(r.payment_bucket);
      h += '<span style="font-size:.78rem;font-weight:700;color:var(--forest-deep);min-width:78px;text-align:right">' + _dPeso(r.total) + '</span>';
      h += '</div>';
    });
  }
  h += '</div>';

  // reconciliation
  if (isToday) {
    var gap = liveTotal - ledgerNet;
    var gapColor = Math.abs(gap) < 0.01 ? '#166534' : '#92400e';
    var gapBg = Math.abs(gap) < 0.01 ? '#dcfce7' : '#fffbeb';
    h += '<div style="margin:8px 16px 16px;display:flex;align-items:flex-start;gap:10px;padding:12px;border-radius:var(--r-sm);background:' + gapBg + '">';
    h += '<span style="font-size:1rem">\u21c4</span><div><div style="font-size:.74rem;font-weight:700;color:' + gapColor + ';margin-bottom:2px">Reconciliation</div>';
    h += '<div style="font-size:.7rem;color:' + gapColor + ';line-height:1.6">Live POS today ' + _dPeso(liveTotal) + ' · Ledger ' + _dPeso(ledgerNet) + ' · ' +
      (Math.abs(gap) < 0.01 ? 'fully invoiced \u2713' : '<strong>' + _dPeso(gap) + ' not yet invoiced</strong>') + '</div></div></div>';
  }

  h += '</div>';
  el.innerHTML = h;
}

// ── Actions ──────────────────────────────────────────────────────────────
function docsChangeDate(d) { _docsDate = d || _dTodayManila(); _docsResetFormState(); loadDocsView(); }

function docsRecalcNet() {
  var g = parseFloat((document.getElementById('docsGross') || {}).value) || 0;
  var d = parseFloat((document.getElementById('docsDiscAmt') || {}).value) || 0;
  var w = parseFloat((document.getElementById('docsWht') || {}).value) || 0;
  var out = document.getElementById('docsNetOut');
  if (out) out.textContent = _dPeso(g - d - w);
}

function _docsResetFormState() { _docsEditId = null; _docsPrefilled = false; }

function docsResetForm(scroll) {
  _docsResetFormState();
  renderDocsView();
  if (scroll) { var f = document.getElementById('docsSiNo'); if (f) { f.scrollIntoView({ behavior: 'smooth', block: 'center' }); f.focus(); } }
}

async function docsPrefillFromOrder() {
  var oid = (document.getElementById('docsPrefillOrder') || {}).value;
  if (!oid) return;
  oid = oid.trim();
  var sb = _docsSb(); if (!sb) { alert('Not connected.'); return; }
  try {
    var r = await sb.from('v_docs_daily_transactions').select('*').eq('order_id', oid).limit(1);
    if (r.error) throw r.error;
    if (!r.data || !r.data.length) { alert('Order ' + oid + ' not found in current sales.'); return; }
    var o = r.data[0];
    var set = function (id, v) { var e = document.getElementById(id); if (e) e.value = (v == null ? '' : v); };
    set('docsOrderRef', o.order_id);
    set('docsCustName', o.receipt_name || o.customer_name || '');
    set('docsCustTin', o.receipt_tin || '');
    set('docsCustAddr', o.receipt_address || '');
    set('docsGross', Number(o.total || 0).toFixed(2));
    set('docsDiscAmt', Number(o.discount_amount || 0).toFixed(2));
    var dt = document.getElementById('docsDiscType'); if (dt && o.discount_type) dt.value = (o.discount_type + '').toUpperCase().slice(0, 5);
    var bk = document.getElementById('docsBucket'); if (bk && ['CASH', 'CARD', 'QR'].indexOf(o.payment_bucket) >= 0) bk.value = o.payment_bucket;
    _docsPrefilled = true;
    docsRecalcNet();
  } catch (e) { alert('Pre-fill failed: ' + (e.message || e)); }
}

async function docsSaveEntry() {
  var sb = _docsSb(); if (!sb) { alert('Not connected.'); return; }
  var val = function (id) { var e = document.getElementById(id); return e ? e.value : ''; };
  var siNo = parseInt(val('docsSiNo'), 10);
  var gross = parseFloat(val('docsGross')) || 0;
  var disc = parseFloat(val('docsDiscAmt')) || 0;
  var wht = parseFloat(val('docsWht')) || 0;
  if (!siNo || siNo < 1) { alert('Enter a valid SI No.'); return; }
  if (gross <= 0) { alert('Enter the gross amount.'); return; }

  var rec = {
    si_no: siNo,
    sale_date: _docsDate,
    order_id: val('docsOrderRef') || null,
    customer_name: val('docsCustName') || null,
    customer_tin: val('docsCustTin') || null,
    customer_address: val('docsCustAddr') || null,
    items_desc: val('docsItems') || null,
    gross: gross,
    discount_type: val('docsDiscType') || null,
    discount_amount: disc,
    withholding_tax: wht,
    net_total: gross - disc - wht,
    payment_bucket: val('docsBucket') || 'CASH',
    sc_pwd_id: val('docsScId') || null,
    source: _docsPrefilled ? 'PREFILL' : 'MANUAL',
    created_by: _dUser()
  };

  try {
    var res;
    if (_docsEditId) {
      rec.updated_at = new Date().toISOString();
      res = await sb.from('docs_daily_sales').update(rec).eq('id', _docsEditId);
    } else {
      res = await sb.from('docs_daily_sales').insert(rec);
    }
    if (res.error) {
      if (res.error.code === '23505') { alert('SI No. ' + siNo + ' is already used. Each serial can only be logged once.'); return; }
      throw res.error;
    }
    _docsResetFormState();
    await loadDocsLedger();
    renderDocsView();
  } catch (e) { alert('Save failed: ' + (e.message || e)); }
}

async function docsEditEntry(id) {
  var row = _docsLedger.filter(function (r) { return r.id === id; })[0];
  if (!row) return;
  _docsEditId = id; _docsPrefilled = (row.source === 'PREFILL');
  renderDocsView();
  var set = function (f, v) { var e = document.getElementById(f); if (e) e.value = (v == null ? '' : v); };
  set('docsSiNo', row.si_no); set('docsOrderRef', row.order_id); set('docsCustName', row.customer_name);
  set('docsCustTin', row.customer_tin); set('docsCustAddr', row.customer_address); set('docsItems', row.items_desc);
  set('docsGross', Number(row.gross).toFixed(2)); set('docsDiscAmt', Number(row.discount_amount).toFixed(2));
  set('docsWht', Number(row.withholding_tax).toFixed(2)); set('docsScId', row.sc_pwd_id);
  var dt = document.getElementById('docsDiscType'); if (dt) dt.value = row.discount_type || '';
  var bk = document.getElementById('docsBucket'); if (bk) bk.value = row.payment_bucket || 'CASH';
  docsRecalcNet();
  var f = document.getElementById('docsSiNo'); if (f) f.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function docsVoidEntry(id) {
  var row = _docsLedger.filter(function (r) { return r.id === id; })[0];
  if (!row) return;
  var reason = prompt('Void SI No. ' + String(row.si_no).padStart(7, '0') + '? The serial stays in the ledger (not deleted).\n\nReason:');
  if (reason === null) return;
  var sb = _docsSb(); if (!sb) { alert('Not connected.'); return; }
  try {
    var res = await sb.from('docs_daily_sales').update({ status: 'VOID', void_reason: reason || 'voided', updated_at: new Date().toISOString() }).eq('id', id);
    if (res.error) throw res.error;
    await loadDocsLedger();
    renderDocsView();
  } catch (e) { alert('Void failed: ' + (e.message || e)); }
}
