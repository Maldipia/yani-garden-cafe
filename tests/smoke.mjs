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
async function call(payload, attempt = 0) {
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

console.log(`\n${'─'.repeat(58)}`);
console.log(`  passed ${pass}   failed ${fail}   (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
if (fail) {
  console.log('\n  failures:');
  failures.forEach(f => console.log('   - ' + f));
}
process.exit(fail ? 1 : 0);
