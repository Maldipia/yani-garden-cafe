#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════
// REGISTRATION GUARD
// ──────────────────────────────────────────────────────────────────────────
// Every bug of this shape tonight came from the same cause: a thing has to be
// registered in TWO places, and nothing notices when it is registered in one.
//
//   implemented action + ACTIONS allow-list   -> "Unknown action" (3 times)
//   view shown         + view hidden          -> hrView bled onto every page
//
// These are static checks over the source. They run in a second and need no
// network, so they can gate a push rather than being discovered in the UI.
//
// Run: node scripts/check-registration.mjs
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = new URL('..', import.meta.url).pathname;
let failures = [];
const fail = (what, detail) => failures.push(`${what}\n      ${detail}`);
const ok   = what => console.log(`  \x1b[32m✓\x1b[0m ${what}`);

// ── 1. Implemented actions must be routable ───────────────────────────────
// A handler that keeps an ACTIONS allow-list returns false for anything not in
// it, BEFORE reaching the if-block — so the action is unreachable.
const handlerDir = join(ROOT, 'api', 'handlers');
for (const file of readdirSync(handlerDir).filter(f => f.endsWith('.js'))) {
  const src = readFileSync(join(handlerDir, file), 'utf8');

  // A file may keep SEVERAL sets (print.js has PRINT_ACTIONS and
  // STATION_ACTIONS) — collect them all, or the second one reads as unrouted.
  const lists = [...src.matchAll(/const \w*ACTIONS\w* = new Set\(\[([\s\S]*?)\]\)/g)];
  if (!lists.length) continue;                    // no allow-list, nothing to check

  const declared = new Set();
  for (const l of lists) for (const m of l[1].matchAll(/'([a-zA-Z_0-9]+)'/g)) declared.add(m[1]);

  // One if-block can serve several actions:
  //   if (action === 'a' || action === 'b') { ... }
  // Matching only the first would report the rest as missing handlers.
  const implemented = new Set();
  for (const m of src.matchAll(/if \(action === '[a-zA-Z_0-9]+'(?:\s*\|\|\s*action === '[a-zA-Z_0-9]+')*\)/g))
    for (const a of m[0].matchAll(/'([a-zA-Z_0-9]+)'/g)) implemented.add(a[1]);

  const unreachable = [...implemented].filter(a => !declared.has(a));
  if (unreachable.length) {
    fail(`${file}: action implemented but NOT in the allow-list — it will return "Unknown action"`,
         unreachable.join(', '));
  }

  const phantom = [...declared].filter(a => !implemented.has(a));
  if (phantom.length) {
    fail(`${file}: action in the allow-list with no handler`, phantom.join(', '));
  }
}
if (!failures.length) ok('every implemented action is routable');

// ── 2. Every view that is shown must also be hidden ───────────────────────
const core = readFileSync(join(ROOT, 'admin-core.js'), 'utf8');
const hideStart = core.indexOf('// Hide all views first');
if (hideStart < 0) {
  fail('admin-core.js: the "Hide all views first" block is missing', 'view switching cannot be verified');
} else {
  const block  = core.slice(hideStart, hideStart + 5000);
  const hidden = new Set([...block.matchAll(/(\w+View)\.style\.display\s*=\s*'none'/g)].map(m => m[1]));
  // Views are shown two ways: inline on the getElementById result, or via a
  // local variable. Catch both, then drop aliases that resolve to a real id.
  const shown = new Set([
    ...[...core.matchAll(/getElementById\('(\w+View)'\)[^\n]*display\s*=\s*'(?:flex|block|grid)'/g)].map(m => m[1]),
    ...[...core.matchAll(/(\w+View)\.style\.display\s*=\s*'(?:flex|block|grid)'/g)].map(m => m[1]),
  ]);
  // a local alias like `var expView = getElementById('expensesView')` is not an id
  const aliasOf = {};
  for (const m of core.matchAll(/var\s+(\w+View)\s*=\s*document\.getElementById\('(\w+View)'\)/g))
    aliasOf[m[1]] = m[2];
  for (const a of Object.keys(aliasOf)) if (shown.has(a)) { shown.delete(a); shown.add(aliasOf[a]); }
  const leaks = [...shown].filter(v => !hidden.has(v));
  if (leaks.length) {
    fail('admin-core.js: view is shown but never hidden — it will render under every other section',
         leaks.join(', '));
  } else {
    ok(`all ${shown.size} switchable views are hidden on navigation`);
  }
}

// ── 3. Routes that use checkAuth must destructure it ──────────────────────
// routeHR took `auth` and never unpacked checkAuth, so every call threw a
// ReferenceError that surfaced only as "Internal server error".
for (const file of readdirSync(handlerDir).filter(f => f.endsWith('.js'))) {
  const src = readFileSync(join(handlerDir, file), 'utf8');
  const usesCheckAuth = /[^.\w]checkAuth\s*\(/.test(src);
  const destructures  = /const\s*\{[^}]*\bcheckAuth\b[^}]*\}\s*=\s*auth/.test(src);
  if (usesCheckAuth && !destructures) {
    fail(`${file}: calls checkAuth() but never destructures it from auth`,
         'every call will throw ReferenceError at runtime');
  }
}
if (failures.length === 0) ok('every handler using checkAuth destructures it');

// ── 4. Cache-busted assets must exist ─────────────────────────────────────
const adminHtml = readFileSync(join(ROOT, 'admin.html'), 'utf8');
const assets = [...adminHtml.matchAll(/<script src="\/([a-zA-Z0-9_\-]+\.js)\?v=(\d+)"/g)];
const missing = assets.filter(([, f]) => {
  try { readFileSync(join(ROOT, f)); return false; } catch { return true; }
});
if (missing.length) fail('admin.html references a script that does not exist', missing.map(m => m[1]).join(', '));
else ok(`all ${assets.length} versioned admin scripts exist`);

// ── result ────────────────────────────────────────────────────────────────
if (failures.length) {
  console.log(`\n\x1b[31m✗ ${failures.length} registration problem(s)\x1b[0m\n`);
  failures.forEach(f => console.log('   • ' + f));
  process.exit(1);
}
console.log('\n  registration guard passed\n');
