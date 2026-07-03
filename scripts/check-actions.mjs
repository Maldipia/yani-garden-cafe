#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════
// ACTION CONTRACT GUARD
// ──────────────────────────────────────────────────────────────────────
// Locks the set of API actions the frontend depends on. If a future change
// deletes or renames a handler that the frontend still calls, this fails
// the build BEFORE it ships — this is exactly the class of regression that
// commit cc8a85e caused (46 actions silently deleted).
//
// Run: node scripts/check-actions.mjs
// CI:  runs automatically on every push (see .github/workflows/guard.yml)
//
// To intentionally RETIRE an action: remove it from BOTH the frontend AND
// scripts/action-manifest.txt in the same commit. The guard only complains
// when the frontend still calls something the backend can no longer answer.
// ══════════════════════════════════════════════════════════════════════
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => { try { return readFileSync(join(root, p), 'utf8'); } catch { return ''; } };

// 1) The locked contract: actions the frontend is allowed to rely on.
const manifest = read('scripts/action-manifest.txt')
  .split('\n').map(s => s.trim()).filter(Boolean);

// 2) What the frontend ACTUALLY calls right now.
const clientFiles = readdirSync(root).filter(f => /\.(html|js)$/.test(f));
const called = new Set();
for (const f of clientFiles) {
  const src = readFileSync(join(root, f), 'utf8');
  for (const m of src.matchAll(/api\(['"]([a-zA-Z][a-zA-Z0-9_]*)['"]/g)) called.add(m[1]);
  for (const m of src.matchAll(/action:\s*['"]([a-zA-Z][a-zA-Z0-9_]*)['"]/g)) called.add(m[1]);
}

// 3) What the backend can actually answer.
const handlerDir = join(root, 'api/handlers');
const handled = new Set();
const scan = (file) => {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/action === ['"]([a-zA-Z0-9_]*)['"]/g)) handled.add(m[1]);
};
for (const f of readdirSync(handlerDir)) if (f.endsWith('.js')) scan(join(handlerDir, f));
// Also scan top-level endpoint files (card.js, paymongo.js, online-order.js, etc.)
// which live at api/*.js and answer their own actions on separate routes.
const apiDir = join(root, 'api');
for (const f of readdirSync(apiDir)) {
  if (f.endsWith('.js')) { try { scan(join(apiDir, f)); } catch {} }
}
// capture other dispatch styles used by those files: action === "x", case 'x':
const extraScan = (file) => {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/case ['"]([a-zA-Z0-9_]*)['"]/g)) handled.add(m[1]);
};
for (const f of readdirSync(apiDir)) if (f.endsWith('.js')) { try { extraScan(join(apiDir, f)); } catch {} }

// ── CHECK A: every manifest action must still be handled ────────────────
const manifestBroken = manifest.filter(a => !handled.has(a));

// ── CHECK B: every action the frontend calls must be handled ────────────
const callBroken = [...called].filter(a => !handled.has(a)).sort();

// ── CHECK C: frontend calls something new not yet in the manifest ───────
// (a warning, not a failure — reminds you to lock new actions)
const notLocked = [...called].filter(a => !manifest.includes(a) && handled.has(a)).sort();

let failed = false;

if (manifestBroken.length) {
  failed = true;
  console.error('\n❌ LOCKED actions that lost their handler (REGRESSION):');
  manifestBroken.forEach(a => console.error('   - ' + a));
}
if (callBroken.length) {
  failed = true;
  console.error('\n❌ Frontend calls actions with NO handler (broken buttons):');
  callBroken.forEach(a => console.error('   - ' + a));
}
if (notLocked.length) {
  console.warn('\n⚠️  New actions in use but not yet locked in the manifest:');
  notLocked.forEach(a => console.warn('   - ' + a));
  console.warn('   → add them to scripts/action-manifest.txt to lock them in.');
}

if (failed) {
  console.error('\n🛑 Action contract check FAILED. Do not deploy.\n');
  process.exit(1);
}
console.log(`\n✅ Action contract OK — ${manifest.length} locked, ${handled.size} handled, 0 broken.\n`);
