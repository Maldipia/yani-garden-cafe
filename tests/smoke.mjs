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

async function call(payload) {
  try {
    const r = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return await r.json();
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

// ── run ────────────────────────────────────────────────────────────────────
const t0 = Date.now();
console.log(`\nYANI POS regression suite → ${BASE}`);
await publicSurfaces();
await authorisation();
await ownerAccess();
await payrollMath();
await pages();

console.log(`\n${'─'.repeat(58)}`);
console.log(`  passed ${pass}   failed ${fail}   (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
if (fail) {
  console.log('\n  failures:');
  failures.forEach(f => console.log('   - ' + f));
}
process.exit(fail ? 1 : 0);
