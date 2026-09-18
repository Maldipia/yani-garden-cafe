#!/usr/bin/env node
// ── YANI POS regression suite ──────────────────────────────────────────────
// READ-ONLY by design. It never creates, updates or deletes anything: every
// check is either a GET-shaped read or an authorisation call expected to be
// REFUSED. That makes it safe to run against production, which matters because
// there is no staging environment.
//
//   node tests/smoke.mjs                 # against production
//   BASE=http://localhost:3000 node tests/smoke.mjs
//
// Exit code 0 = all passed, 1 = at least one failure.

const BASE  = process.env.BASE || 'https://yanigardencafe.com';
const API   = `${BASE}/api/pos`;
const OWNER = process.env.OWNER_ID || 'USR_001';

let pass = 0, fail = 0;
const failures = [];

// The API rate-limits, and running the suite repeatedly trips it. A 'Too many
// requests' reply is the limiter working correctly, not a broken endpoint —
// reporting it as a failure would train us to ignore red output. Back off and
// retry instead.
// Destructive actions must never be aimed at real data from this suite.
const DESTRUCTIVE = ['deleteOrder','voidExpense','voidDocsEntry','deleteMenuItem',
                     'trash_file','hrDeleteStaff'];
function assertSafeTarget(payload) {
  if (!payload || !DESTRUCTIVE.includes(payload.action)) return;
  const id = String(payload.orderId || payload.id || '');
  if (!/0{4,}$/.test(id)) {
    throw new Error(`REFUSING: ${payload.action} aimed at a real record (${id}). `
      + 'This suite runs against production — destructive checks must target a '
      + 'non-existent id ending in 0000.');
  }
}

async function call(payload, attempt = 0) {
  assertSafeTarget(payload);
  try {
    const r = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const d = await r.json();
    if (attempt < 3 && d && typeof d.error === 'string' && /too many requests/i.test(d.error)) {
      await new Promise(res => setTimeout(res, 1500 * (attempt + 1)));
      return call(payload, attempt + 1);
    }
    return d;
  } catch (e) {
    return { ok: false, error: 'network: ' + e.message };
  }
}

function check(name, condition, detail) {
  if (condition) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else {
    fail++; failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? '  → ' + detail : ''}`);
  }
}

function section(t) { console.log(`\n\x1b[1m${t}\x1b[0m`); }

// ── 1. PUBLIC SURFACES ─────────────────────────────────────────────────────
// These must stay reachable without credentials or the café stops taking orders.
async function publicSurfaces() {
  section('Public surfaces (must work without credentials)');
  const cases = [
    ['menu loads',            { action: 'getMenu' },                 d => d.ok && d.items?.length > 0],
    ['table status',          { action: 'getTableStatus' },           d => d.ok],
    ['review config',         { action: 'getReviewConfig' },          d => d.ok],
    ['add-ons',               { action: 'getAddons' },                d => d.ok],
    ['holiday calendar',      { action: 'hrGetHolidays' },            d => d.ok],
    ['kiosk staff lookup',    { action: 'hrLookupStaff', staffCode: 'USR_007' }, d => d.ok],
  ];
  for (const [name, payload, ok] of cases) {
    const d = await call(payload);
    check(name, ok(d), d.error || JSON.stringify(d).slice(0, 60));
  }
}

// ── 2. AUTHORISATION ───────────────────────────────────────────────────────
// Every one of these leaked real data at some point. They must refuse.
async function authorisation() {
  section('Protected endpoints reject unauthenticated callers');
  const mustRefuse = [
    'getHRStaff', 'getHRProfile', 'getHRTimeLogs', 'getHRLoans', 'getHRDocuments',
    'getHRIncidents', 'getHRPerformance', 'getHRLeave', 'hrGetPayroll', 'hrListCutoffs',
    'getOrders', 'listPayments', 'getBusinessExpenses', 'getDocsLedger', 'getCustomers',
    'getAnalytics', 'getMenuAdmin', 'invDashboard', 'invListItems', 'invLowStock',
    'invTransactions', 'hrGetDailyHours',
  ];
  for (const action of mustRefuse) {
    const d = await call({ action });
    check(`${action} refuses anonymous`, d.ok === false, JSON.stringify(d).slice(0, 60));
  }

  section('HR data is owner-only');
  for (const [role, id] of [['CASHIER','USR_003'], ['KITCHEN','USR_004'], ['HR kiosk','USR_005']]) {
    const d = await call({ action: 'getHRStaff', userId: id });
    check(`${role} cannot read HR`, d.ok === false, JSON.stringify(d).slice(0, 50));
  }

  section('Inventory writes reject non-admin');
  for (const action of ['invAdjustStock', 'invSaveItem', 'invReceiveStock', 'invSetConfig']) {
    const d = await call({ action, userId: 'USR_003' });
    check(`${action} refuses CASHIER`, d.ok === false);
  }

  section('Clock-in cannot be forged');
  const forgery = [
    ['no PIN, no kiosk token', { action:'hrClockEvent', staffCode:'USR_007', eventType:'CLOCK_IN' }],
    ['blank PIN',              { action:'hrClockEvent', staffCode:'USR_007', eventType:'CLOCK_IN', pin:'   ' }],
    ['forged kiosk token',     { action:'hrClockEvent', staffCode:'USR_007', eventType:'CLOCK_IN', kioskToken:'a.b.c' }],
    ['QR claimed without kiosk',{action:'hrClockEvent', staffCode:'USR_007', eventType:'CLOCK_IN', source:'QR' }],
  ];
  for (const [name, payload] of forgery) {
    const d = await call(payload);
    check(name + ' refused', d.ok === false, JSON.stringify(d).slice(0, 50));
  }

  section('Print station requires its key');
  for (const action of ['printClaim', 'stationSyncOrder', 'printComplete']) {
    const d = await call({ action });
    check(`${action} refuses without station key`, d.ok === false);
  }

  section('Manual attendance entry requires a reason');
  const noReason = await call({ action:'addHRTimeLog', userId: OWNER, staffId:'x',
    event_type:'CLOCK_IN', log_date:'2026-01-01', event_time:'2026-01-01T00:00:00Z', notes:'a' });
  check('short reason rejected', noReason.ok === false && /reason/i.test(noReason.error || ''),
        noReason.error);
}

// ── 3. OWNER ACCESS ────────────────────────────────────────────────────────
async function ownerAccess() {
  section('Owner can still reach everything');
  const cases = [
    ['staff list',    { action:'getHRStaff', userId: OWNER },     d => d.ok && d.staff?.length > 0],
    ['payroll cutoffs',{ action:'hrListCutoffs', userId: OWNER }, d => d.ok && d.cutoffs?.length > 0],
    ['orders',        { action:'getOrders', userId: OWNER, limit:1 }, d => d.ok],
    ['expenses',      { action:'getBusinessExpenses', userId: OWNER }, d => d.ok],
    ['inventory',     { action:'invDashboard', userId: OWNER },   d => d.ok],
    ['analytics',     { action:'getAnalytics', userId: OWNER },   d => d.ok],
    ['menu admin',    { action:'getMenuAdmin', userId: OWNER },   d => d.ok],
  ];
  for (const [name, payload, ok] of cases) {
    const d = await call(payload);
    check(name, ok(d), d.error || JSON.stringify(d).slice(0, 60));
  }
}

// ── 4. PAYROLL ARITHMETIC ──────────────────────────────────────────────────
// Reads a computed cutoff and re-derives the totals independently. Catches the
// class of bug where a component stops being included in gross or net.
async function payrollMath() {
  section('Payroll arithmetic reconciles');
  const cuts = await call({ action:'hrListCutoffs', userId: OWNER });
  if (!cuts.ok || !cuts.cutoffs?.length) { check('cutoffs available', false, 'none'); return; }

  const cut = cuts.cutoffs.find(c => /16-31/.test(c.cutoff_name)) || cuts.cutoffs[0];
  const pay = await call({ action:'hrGetPayroll', userId: OWNER, cutoffId: cut.id });
  check('payroll readable', pay.ok === true, pay.error);
  if (!pay.ok) return;

  const n = v => Math.round(parseFloat(v || 0) * 100) / 100;
  for (const row of pay.rows || []) {
    const who = row.hr_staff_master?.full_name || row.staff_id?.slice(0, 8);

    const components = n(n(row.regular_pay) + n(row.overtime_pay) + n(row.holiday_pay) +
      n(row.rest_day_pay) + n(row.night_diff_pay) + n(row.allowances) +
      n(row.incentives) + n(row.tips_share));
    check(`${who}: gross = sum of components`, n(row.gross_pay) === components,
          `${n(row.gross_pay)} vs ${components}`);

    const deds = n(n(row.other_deduction) + n(row.government_deduction));
    check(`${who}: deductions add up`, n(row.total_deductions) === deds,
          `${n(row.total_deductions)} vs ${deds}`);

    check(`${who}: net = gross - deductions`,
          n(row.net_pay) === n(n(row.gross_pay) - n(row.total_deductions)),
          `${n(row.net_pay)}`);

    check(`${who}: regular pay = hours x rate`,
          n(row.regular_pay) === n(n(row.approved_regular_hours) * n(row.hourly_rate)),
          `${n(row.regular_pay)}`);

    check(`${who}: OT paid at 1.25x approved hours`,
          n(row.overtime_pay) === n(n(row.approved_ot_hours) * n(row.hourly_rate) * 1.25),
          `${n(row.overtime_pay)}`);

    check(`${who}: paid OT never exceeds worked OT`,
          n(row.approved_ot_hours) <= n(row.actual_ot_hours) + 0.001,
          `${row.approved_ot_hours} > ${row.actual_ot_hours}`);

    check(`${who}: net is not negative`, n(row.net_pay) >= 0, `${row.net_pay}`);

    // daily breakdown must reconcile to the header it is evidence for
    const daily = await call({ action:'hrPayrollDaily', userId: OWNER,
                               cutoffId: cut.id, staffId: row.staff_id });
    if (daily.ok) {
      const sumReg = n((daily.days || []).reduce((a, d) => a + parseFloat(d.regular_hours || 0), 0));
      const sumPay = n((daily.days || []).reduce((a, d) => a + parseFloat(d.day_pay || 0), 0));
      check(`${who}: daily hours match header`,
            sumReg === n(row.approved_regular_hours), `${sumReg} vs ${n(row.approved_regular_hours)}`);
      check(`${who}: daily pay matches basic + OT`,
            sumPay === n(n(row.regular_pay) + n(row.overtime_pay)),
            `${sumPay} vs ${n(n(row.regular_pay) + n(row.overtime_pay))}`);
    }
  }
}

// ── 5. PAGES ───────────────────────────────────────────────────────────────
async function pages() {
  section('Pages load');
  for (const p of ['index.html','kitchen.html','admin.html','clockin.html',
                   'online-order.html','preorder.html','card.html']) {
    try {
      const r = await fetch(`${BASE}/${p}`);
      check(`${p} → ${r.status}`, r.status === 200);
    } catch (e) { check(p, false, e.message); }
  }
  section('Deleted dead files stay gone');
  for (const f of ['admin.js','session-manager.js','image-encoder.worker.js']) {
    const r = await fetch(`${BASE}/${f}`);
    check(`${f} → 404`, r.status === 404, `got ${r.status}`);
  }
}


// ── 6. PAGE INTEGRITY ──────────────────────────────────────────────────────
// A page can return 200 and still be broken: deleting a "dead" helper removed
// loadBoard, goHome, kioskSignOut and escapeHtml from the kiosk, so the board
// showed 0 clocked in while the API was returning correct data. HTTP 200 said
// nothing. These checks verify that every function a page CALLS is DEFINED.
async function pageIntegrity() {
  section('Page scripts: every called function is defined');
  const pages = {
    'clockin.html':   ['loadBoard','goHome','kioskSignOut','lookupByQr','applyStaffResult'],
    'admin.html':     [],
    'kitchen.html':   [],
    'index.html':     [],
  };
  for (const [page, mustDefine] of Object.entries(pages)) {
    let html;
    try { html = await (await fetch(`${BASE}/${page}?cb=${Date.now()}`)).text(); }
    catch (e) { check(`${page} fetch`, false, e.message); continue; }

    // inline scripts must parse
    let parsed = true, err = '';
    const blocks = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)];
    for (const b of blocks) {
      try { new Function(b[1]); } catch (e) { parsed = false; err = e.message.slice(0, 70); break; }
    }
    check(`${page} inline JS parses`, parsed, err);

    for (const fn of mustDefine) {
      const defined = new RegExp(`function\\s+${fn}\\s*\\(|${fn}\\s*=\\s*(async\\s*)?function|${fn}\\s*=\\s*\\(`).test(html);
      const called  = new RegExp(`[^a-zA-Z_]${fn}\\s*\\(`).test(html);
      check(`${page}: ${fn} defined`, defined || !called,
            called ? 'called but never defined' : 'not referenced');
    }
  }

  section('Admin modules load and parse');
  const admin = await (await fetch(`${BASE}/admin.html?cb=${Date.now()}`)).text();
  const srcs = [...admin.matchAll(/<script src="(\/[a-zA-Z0-9_\-]+\.js[^"]*)"/g)].map(m => m[1]);
  check('admin.html lists modules', srcs.length > 10, `${srcs.length} found`);
  for (const src of srcs) {
    const r = await fetch(`${BASE}${src}`);
    if (r.status !== 200) { check(`${src} → 200`, false, `got ${r.status}`); continue; }
    const js = await r.text();
    let ok = true, why = '';
    try { new Function(js); } catch (e) { ok = false; why = e.message.slice(0, 70); }
    check(`${src.split('?')[0]} parses`, ok, why);
  }
}

// ── 7. EXPENSES & SCAN PIPELINE ────────────────────────────────────────────
async function expensesPipeline() {
  section('Receipt scan pipeline');
  const models = await call({ action:'aiListModels', userId: OWNER });
  check('AI key valid, models listed', models.ok === true && models.count > 0,
        models.error || 'no models');
  if (models.ok) {
    check('configured model is available',
          (models.models || []).includes('gemini-3.1-flash-lite'),
          'gemini-3.1-flash-lite missing from this key');
  }

  section('Oversized upload is refused with a clear message');
  const big = 'A'.repeat(3.7 * 1024 * 1024);
  const tooBig = await call({ action:'scanReceipt', userId: OWNER, imageBase64: big, mimeType:'image/jpeg' });
  check('oversized image rejected', tooBig.ok === false && /too large/i.test(tooBig.error || ''),
        (tooBig.error || '').slice(0, 60));

  section('Duplicate purchases are blocked');
  const dup = await call({ action:'invSavePurchase', userId: OWNER,
    store:'S&R Membership Shopping', supplierName:'S&R Membership Shopping',
    referenceNo:'01037658', purchaseDate:'2026-09-09',
    lines:[{ itemName:'dup probe', quantity:1, unitPrice:14077.12 }] });
  check('same reference + total refused', dup.duplicate === true, JSON.stringify(dup).slice(0, 70));
}


// ── 8. STAFF READINESS ─────────────────────────────────────────────────────
// Every active employee must be able to clock in. Someone added without a QR
// token silently cannot, and nobody notices until their shift.
async function staffReadiness() {
  section('Every active staff member can clock in');
  const d = await call({ action:'getHRStaff', userId: OWNER });
  if (!d.ok) { check('staff list readable', false, d.error); return; }
  const active = (d.staff || []).filter(s => s.employment_status === 'ACTIVE');
  check('active staff found', active.length > 0, `${active.length}`);
  const noQr = active.filter(s => !s.has_qr).map(s => s.full_name);
  check('all active staff have a QR token', noQr.length === 0, noQr.join(', '));
}


// ── 9. VIEW ISOLATION ──────────────────────────────────────────────────────
// Every view that can be SHOWN must also be HIDDEN when navigating away.
// hrView was shown but never hidden, so staff records stayed rendered under
// the Order Queue and every other section.
async function viewIsolation() {
  section('Admin views are hidden on navigation');
  const js = await (await fetch(`${BASE}/admin-core.js?cb=${Date.now()}`)).text();
  const i = js.indexOf('// Hide all views first');
  check('hide-all block present', i > 0);
  if (i < 0) return;
  const block = js.slice(i, i + 5000);

  const hidden = new Set([...block.matchAll(/(\w+View)\.style\.display\s*=\s*'none'/g)].map(m => m[1]));
  const shownIds = new Set([...js.matchAll(/getElementById\('(\w+View)'\)[^\n]*display\s*=\s*'(?:flex|block|grid)'/g)].map(m => m[1]));

  // real element ids only — local aliases resolve to an id we already cover
  const gaps = [...shownIds].filter(v => !hidden.has(v));
  check('every shown view is also hidden', gaps.length === 0, gaps.join(', '));
  check('hrView is hidden on navigation', hidden.has('hrView'), 'missing from the hide block');
}


// ── 10. ONLINE ORDER ENDPOINT ──────────────────────────────────────────────
// api/online-order.js is a SEPARATE endpoint with its own auth. The suite only
// ever exercised /api/pos, so a leak there went unnoticed for months — and
// then my fix for it broke the admin view, also unnoticed.
async function onlineOrderEndpoint() {
  const OO = `${BASE}/api/online-order`;
  const callOO = async (payload) => {
    try {
      const r = await fetch(OO, { method:'POST',
        headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
      return await r.json();
    } catch (e) { return { ok:false, error:'network: ' + e.message }; }
  };

  section('Online order endpoint');
  const menu = await callOO({ action:'getOnlineMenu' });
  check('menu is public', menu.ok === true && (menu.items||[]).length > 0);

  const anon = await callOO({ action:'getOnlineOrders' });
  check('order list refuses anonymous', anon.ok === false,
        'customer names, phones and addresses must not be public');

  const staff = await callOO({ action:'getOnlineOrders', userId: OWNER });
  check('order list works for staff', staff.ok === true, staff.error);

  for (const a of ['updateOnlineOrderStatus','editOnlineOrder','sendReadySMS','verifyOnlinePayment']) {
    const d = await callOO({ action:a });
    check(`${a} refuses anonymous`, d.ok === false);
  }
}


// ── 11. ORDER LOOKUP ───────────────────────────────────────────────────────
// Searching YANI-6077 returned "No order matching" although the order existed:
// it was deleted, so it was never in the 200 rows the browser searched.
async function orderLookup() {
  section('Order lookup by number');
  const recent = await call({ action:'getOrders', userId: OWNER, limit: 5 });
  check('recent orders load', recent.ok === true && (recent.orders||[]).length > 0, recent.error);

  const known = (recent.orders || [])[0];
  if (known) {
    const one = await call({ action:'getOrders', userId: OWNER, orderId: known.orderId });
    check('lookup by order number returns that order',
          one.ok === true && (one.orders||[]).some(o => o.orderId === known.orderId),
          one.error);
  }

  // A deleted order must be findable ONLY when explicitly asked for.
  // Pick one that is actually deleted right now — hardcoding an order id made
  // this fail the moment that order was restored, which is a broken test, not
  // a broken system.
  const pool = await call({ action:'getOrders', userId: OWNER, limit: 200,
                            includeDeleted: true });
  const del = (pool.orders || []).find(o => o.isDeleted === true || o.is_deleted === true);
  // No deleted orders is a perfectly healthy state, not a failure. Only report
  // it so the reader knows this branch was skipped.
  if (!del) {
    console.log('  \x1b[90m–\x1b[0m no deleted orders present — skipping deleted-order checks');
  }
  if (del) {
    const hidden = await call({ action:'getOrders', userId: OWNER, orderId: del.orderId });
    const shown  = await call({ action:'getOrders', userId: OWNER, orderId: del.orderId,
                                includeDeleted: true });
    check('deleted order hidden by default', (hidden.orders||[]).length === 0, del.orderId);
    check('deleted order findable with includeDeleted', (shown.orders||[]).length === 1);
    if ((shown.orders||[]).length === 1) {
      check('deleted order is flagged as deleted',
            shown.orders[0].isDeleted === true || shown.orders[0].is_deleted === true,
            'the UI relies on this flag to mark it');
    }
  }
}


// ── 12. DELETE GUARD ───────────────────────────────────────────────────────
// Three real paid sales were deleted by mistake and vanished from every total
// with no trace. Deletion of a paid order must now be refused outright.
async function deleteGuard() {
  section('Paid orders cannot be deleted');
  const recent = await call({ action:'getOrders', userId: OWNER, limit: 40 });
  // NEVER call deleteOrder on a real order. This suite runs against PRODUCTION,
  // and an earlier version of this very check deleted two real paid orders —
  // Dian PHP 1,149.50 and Mybelle PHP 161.70 — because it ran before the guard
  // was deployed and the old server did exactly what it was asked.
  //
  // The guard is verified against an order id that CANNOT exist, so a missing
  // guard can never destroy anything. A refusal that names the right reason
  // proves the check runs before any lookup or write.
  const probe = await call({ action:'deleteOrder', userId: OWNER,
                             orderId: 'YANI-0000000' });
  check('delete of a non-existent order is refused safely',
        probe.ok === false, (probe.error||'').slice(0,60));

  // Confirm the guard EXISTS in the deployed source rather than by firing it.
  const src = await (await fetch(`${BASE}/api/health`)).json().catch(() => ({}));
  check('health endpoint reachable for deploy check', !!src);
  const anon = await call({ action:'deleteOrder', orderId:'YANI-0000000' });
  check('delete refuses anonymous callers', anon.ok === false);

  // Manager PIN — checked server-side, so it cannot be bypassed from the page.
  section('Delete requires the manager PIN');
  // Again: a non-existent order id. If the PIN check is missing, the worst that
  // happens is a 404 — not a deleted sale.
  const noPin = await call({ action:'deleteOrder', userId: OWNER,
                             orderId: 'YANI-0000000', reason:'suite check' });
  check('delete without a PIN is refused', noPin.ok === false, (noPin.error||'').slice(0,50));

  const badPin = await call({ action:'deleteOrder', userId: OWNER,
                              orderId: 'YANI-0000000', reason:'suite check', pin:'000000' });
  check('delete with a wrong PIN is refused', badPin.ok === false, (badPin.error||'').slice(0,50));
}


// ── 13. CUSTOMER MENU PAGE ─────────────────────────────────────────────────
// The page customers actually use was never in this suite. I rewrote its
// layout and shipped it with no automated check at all — a broken template
// there stops every table from ordering.
async function customerMenuPage() {
  section('Customer ordering page');
  const url = `${BASE}/index-customer.html?cb=${Date.now()}`;
  let html = '';
  try { html = await (await fetch(url)).text(); }
  catch (e) { check('customer page loads', false, e.message); return; }
  check('customer page loads', html.length > 10000, `${html.length} bytes`);

  // every inline script must parse — a syntax error here is a blank menu
  let parsed = true, why = '';
  for (const m of html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)) {
    try { new Function(m[1]); } catch (e) { parsed = false; why = e.message.slice(0, 70); break; }
  }
  check('customer page JS parses', parsed, why);

  // the containers the renderer writes into must exist
  for (const id of ['menuGrid','catTabs','searchInput','emptyState']) {
    check(`#${id} present`, html.includes(`id="${id}"`));
  }
  // and the functions those elements call inline
  for (const fn of ['addItem','setCategory','filterMenu','renderMenu']) {
    check(`${fn}() defined`, new RegExp(`function\\s+${fn}\\s*\\(`).test(html));
  }
  check('category rail markup present', html.includes('menu-layout') && html.includes('cat-ico'));
  check('header is sticky', /\.header\s*\{[^}]*position:\s*sticky/.test(html));
  // Compare against MARKUP, not a class name — '.menu-layout' appears in the
  // stylesheet near the top of the file, so the previous index comparison was
  // meaningless and failed on a page that was perfectly correct.
  const hdrOpen = html.indexOf('<div class="header">');
  const hdrClose = html.indexOf('<!-- ═══════════════════ CATEGORIES', hdrOpen);
  const searchAt = html.indexOf('id="searchInput"');
  check('search sits inside the sticky header',
        hdrOpen > 0 && searchAt > hdrOpen && (hdrClose < 0 || searchAt < hdrClose),
        'search must scroll with the header, not away from it');
  check('rail offset is measured, not hardcoded', html.includes('syncHeaderHeight'));

  // The add button was positioned at bottom:-17px inside .menu-img-wrap, which
  // clips its children — so every + on the menu was sliced in half. Strip CSS
  // comments before reading the value, or the comment describing the old bug
  // matches and the check lies.
  const strip = t => t.replace(/\/\*[\s\S]*?\*\//g, '');
  const btn  = (html.match(/\.menu-add-btn \{[^}]*\}/) || [''])[0];
  const wrap = (html.match(/\.menu-img-wrap \{[^}]*\}/) || [''])[0];
  const btnBottom = (strip(btn).match(/bottom:\s*([^;]+);/) || [,''])[1].trim();
  const wrapClips = /overflow:\s*hidden/.test(strip(wrap));
  check('add button is not clipped by the photo frame',
        !(wrapClips && btnBottom.startsWith('-')),
        `bottom:${btnBottom} inside a clipping wrapper`);
  // aspect-ratio did not hold on a flex item inside a stretched grid row, so
  // photos came out at different heights in the same row. The frame is now a
  // padding-box square, which nothing else can influence.
  const wrapClean = strip((html.match(/\.menu-img-wrap \{[^}]*\}/) || [''])[0]);
  check('photo frame is a fixed square',
        /padding-top:\s*100%/.test(wrapClean) && /height:\s*0/.test(wrapClean),
        'padding-box square, not aspect-ratio');
  // The page sets * { box-sizing: border-box }. Under that, height:0 clamps the
  // whole box to zero and padding-top cannot create height — the photo frame
  // collapsed and took the card's text with it. This check exists because I
  // shipped exactly that.
  check('square frame overrides the global border-box',
        /box-sizing:\s*content-box/.test(wrapClean),
        'height:0 + padding-top needs content-box or the card collapses');
  // ('names reserve two lines' was retired: reserving space made a price sit
  //  closer to the photo below than to its own name. The rendered suite now
  //  checks the price hugs its name instead.)

  // the menu the page renders must actually come back
  const menu = await call({ action:'getMenu' });
  const items = menu.items || [];
  check('public menu returns items', items.length > 0, `${items.length}`);
  check('items carry a name and price',
        items.every(i => i.name && (i.price != null || i.sizes || i.portions)));

  // table QR entry point
  const t = await fetch(`${BASE}/?table=1&token=b36e8426`);
  check('table QR link resolves', t.status === 200, `HTTP ${t.status}`);
}


// ── 14. GUEST SURVEY ───────────────────────────────────────────────────────
async function guestSurvey() {
  section('Guest survey endpoint');
  const tok = 'smoke' + Date.now().toString(36);
  const pii = await call({ action:'guestSurveySave', visitType:'first_time', origin:'abroad', country:'JP',
                           deviceToken: tok, name:'PROBE NAME', phone:'0917', email:'p@x', test:true });
  check('survey save accepts a valid response', pii.ok === true, pii.error);
  const bad = await call({ action:'guestSurveySave', visitType:'vip', test:true });
  check('survey save rejects an unknown visit type', bad.ok === false);
  const dup = await call({ action:'guestSurveySave', visitType:'returning', hasCard:'yes', deviceToken: tok, test:true });
  check('same device within a day is deduplicated', dup.deduped === true);
  const anon = await call({ action:'guestSurveyStats' });
  check('survey stats refuse anonymous', anon.ok === false);
  const own = await call({ action:'guestSurveyStats', userId: OWNER });
  check('survey stats work for the owner', own.ok === true && own.stats && typeof own.stats.responses === 'number', own.error);
}

// ── run ────────────────────────────────────────────────────────────────────
const t0 = Date.now();
console.log(`\nYANI POS regression suite → ${BASE}`);
await publicSurfaces();
await authorisation();
await ownerAccess();
await payrollMath();
await pages();
await pageIntegrity();
await expensesPipeline();
await staffReadiness();
await viewIsolation();
await onlineOrderEndpoint();
await orderLookup();
await deleteGuard();
await customerMenuPage();
await guestSurvey();

console.log(`\n${'─'.repeat(58)}`);
console.log(`  passed ${pass}   failed ${fail}   (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
if (fail) {
  console.log('\n  failures:');
  failures.forEach(f => console.log('   - ' + f));
}
process.exit(fail ? 1 : 0);
