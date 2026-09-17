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

// ── 5. No duplicate handlers or client functions ──────────────────────────
// Two restoreOrder handlers existed in orders.js; the first was incomplete and
// shadowed the second, so the working one never ran. A duplicate client
// function in admin-costing.js overrode the one in admin-orders.js the same
// way. Both were invisible until behaviour was tested directly.
for (const file of readdirSync(handlerDir).filter(f => f.endsWith('.js'))) {
  const src = readFileSync(join(handlerDir, file), 'utf8');
  const seen = {};
  for (const m of src.matchAll(/if \(action === '([a-zA-Z_0-9]+)'/g)) {
    seen[m[1]] = (seen[m[1]] || 0) + 1;
  }
  const dupes = Object.entries(seen).filter(([, n]) => n > 1).map(([a]) => a);
  if (dupes.length) {
    fail(`${file}: the same action is handled twice — the first one wins and shadows the rest`,
         dupes.join(', '));
  }
}

const clientFiles = readdirSync(ROOT).filter(f => /^admin.*\.js$/.test(f));
const fnOwners = {};
for (const f of clientFiles) {
  const src = readFileSync(join(ROOT, f), 'utf8');
  // TOP-LEVEL only. A nested function is scoped to its parent and shadows
  // nothing; matching indented declarations reported fmt and cleanup as
  // clashes when both were local, which is exactly the false alarm that
  // teaches people to ignore a guard.
  for (const m of src.matchAll(/^(?:async\s+)?function\s+([a-zA-Z_0-9]+)\s*\(/gm)) {
    (fnOwners[m[1]] = fnOwners[m[1]] || []).push(f);
  }
}
const clashes = Object.entries(fnOwners)
  .filter(([, files]) => new Set(files).size > 1)
  .map(([fn, files]) => `${fn} (${[...new Set(files)].join(' + ')})`);
if (clashes.length) {
  fail('the same function is defined in more than one admin script — the last loaded wins',
       clashes.slice(0, 8).join(' | '));
} else {
  ok('no duplicate handlers or client function names');
}

// ── 6. Inline CSS must parse with no dropped rules ────────────────────────
// A stray '}' had sat before .menu-img-wrap since April. Browsers silently
// drop the rule that follows a parse error, so the photo frame never received
// its size — and five successive fixes were written into a rule no browser
// ever read. Brace counting cannot catch this (a stray '}' after a stray '{'
// balances). Instead: the rule after every top-level '}' must begin with a
// selector or at-rule, never another '}'.
for (const page of ['index-customer.html','online-order.html','admin.html','clockin.html']) {
  let html; try { html = readFileSync(join(ROOT, page), 'utf8'); } catch { continue; }
  const blocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]);
  const problems = [];
  blocks.forEach((css, bi) => {
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
    // find '}' immediately followed (ignoring whitespace) by another '}' at depth 0
    let depth = 0;
    for (let i = 0; i < clean.length; i++) {
      const ch = clean[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth < 0) {
          const line = clean.slice(0, i).split('\n').length;
          const ctx  = clean.slice(i + 1, i + 60).replace(/\s+/g, ' ').trim().slice(0, 40);
          problems.push(`style block ${bi}, line ${line}: stray '}' — the next rule (${ctx}…) will be DROPPED by the browser`);
          depth = 0;
        }
      }
    }
    if (depth > 0) problems.push(`style block ${bi}: ${depth} unclosed '{'`);
  });
  if (problems.length) fail(`${page}: CSS parse problem`, problems.slice(0, 3).join(' | '));
}
if (!failures.some(f => f.includes('CSS parse problem'))) ok('inline CSS parses with no dropped rules');

// ── 7. Version markers must be unique per file ────────────────────────────
// Bumping ?v= by hand is error-prone: a sed that matches nothing fails
// silently, and the page then requests a stale version string while the file
// has changed. That happened three times in one session.
const dupes = {};
for (const [, file, ver] of assets) {
  dupes[file] = dupes[file] || new Set();
  dupes[file].add(ver);
}
const multi = Object.entries(dupes).filter(([, v]) => v.size > 1);
if (multi.length) {
  fail('admin.html references the same script at two different versions',
       multi.map(([f, v]) => `${f}: ${[...v].join(', ')}`).join(' | '));
} else {
  ok('each script is referenced at exactly one version');
}

// ── result ────────────────────────────────────────────────────────────────
if (failures.length) {
  console.log(`\n\x1b[31m✗ ${failures.length} registration problem(s)\x1b[0m\n`);
  failures.forEach(f => console.log('   • ' + f));
  process.exit(1);
}
console.log('\n  registration guard passed\n');
