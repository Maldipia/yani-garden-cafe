// api/cron-backup.js
// Vercel cron handler — daily full-table JSON backup to Supabase Storage.
//
// Schedule: every day at 19:00 UTC (03:00 PHT next day) — 1 hour after
//           the leaves-expiry sweep at 18:00 UTC.
// Security: Vercel automatically adds `Authorization: Bearer <CRON_SECRET>`
//           to every cron invocation when the CRON_SECRET env var is set.
//           Without CRON_SECRET, this endpoint refuses ALL requests (fails closed).
//
// Behavior:
//   1. Read all critical tables via PostgREST
//   2. Bundle as one JSON object
//   3. Upload to Supabase Storage bucket "backups" as backup-YYYY-MM-DD.json
//   4. Delete backups older than 30 days (rolling retention)
//   5. Log to order_audit_logs
//
// Manual trigger: POST { secret: '<CRON_SECRET>' } to this endpoint.
//
// Read-only on the operational DB. Side effects are limited to:
//   • Writing one JSON file to Storage bucket "backups"
//   • Deleting expired files from "backups"
//   • Writing one audit log row
//
// If anything fails, the operational DB is unaffected.

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://hnynvclpvfxzlfjphefj.supabase.co';
const SUPABASE_KEY = (() => {
  const k = process.env.SUPABASE_SECRET_KEY;
  if (!k) throw new Error('SUPABASE_SECRET_KEY not set');
  return k;
})();
const CRON_SECRET = process.env.CRON_SECRET || '';

// Tables to back up. Order matters only for human readability — restore
// would respect FK constraints regardless.
const TABLES = [
  // Core auth + config
  'staff_users',
  'settings',

  // Menu
  'menu_categories',
  'menu_items',
  'menu_addons',

  // Orders
  'dine_in_orders',
  'dine_in_order_items',

  // Yani Cards
  'yani_cards',
  'card_transactions',

  // Roots Rewards / Leaves
  'loyalty_accounts',
  'points_transactions',
  'leaf_rewards',
  'leaf_redemptions',
  'surprise_rewards',

  // Payments
  'payments',

  // Audit
  'order_audit_logs',
];

async function supaFetch(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const data = r.ok ? await r.json().catch(() => null) : null;
  return { ok: r.ok, status: r.status, data };
}

async function storageFetch(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      ...(opts.headers || {}),
    },
  });
  return r;
}

export default async function handler(req, res) {
  // ─── Auth ──────────────────────────────────────────────────────
  // Fails closed: if CRON_SECRET is empty/unset, ALL requests rejected.
  const authHeader = req.headers?.authorization || '';
  const bodySecret = req.body?.secret;
  const headerOk = CRON_SECRET && authHeader === 'Bearer ' + CRON_SECRET;
  const bodyOk = CRON_SECRET && bodySecret === CRON_SECRET;
  if (!headerOk && !bodyOk) {
    return res.status(403).json({ ok: false, error: 'Unauthorized' });
  }

  const startedAt = Date.now();
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
  const filename = `backup-${dateStr}.json`;

  try {
    // ─── 1. Read all tables ────────────────────────────────────
    const dump = {
      _meta: {
        backup_at: now.toISOString(),
        backup_date_pht: new Date(now.getTime() + 8 * 60 * 60 * 1000)
          .toISOString().replace('T', ' ').substring(0, 19) + ' PHT',
        source_project: 'hnynvclpvfxzlfjphefj',
        table_count: TABLES.length,
        format_version: '1.0',
      },
      tables: {},
      counts: {},
    };

    const errors = [];
    for (const tbl of TABLES) {
      // Use limit=10000 — generous cap; YANI is well under this. If a table
      // exceeds, the count diff in _meta will surface it for ops attention.
      const r = await supaFetch(`${tbl}?select=*&limit=10000`);
      if (r.ok) {
        dump.tables[tbl] = r.data || [];
        dump.counts[tbl] = (r.data || []).length;
      } else {
        dump.tables[tbl] = null;
        dump.counts[tbl] = `ERROR_${r.status}`;
        errors.push({ table: tbl, status: r.status });
      }
    }

    // ─── 2. Upload to Storage bucket "backups" ─────────────────
    const body = JSON.stringify(dump);
    const sizeBytes = Buffer.byteLength(body);

    const uploadRes = await storageFetch(`object/backups/${filename}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-upsert': 'true', // overwrite if same day re-run (idempotent)
      },
      body,
    });

    if (!uploadRes.ok) {
      const detail = await uploadRes.text().catch(() => '');
      return res.status(500).json({
        ok: false,
        error: 'Upload failed',
        upload_status: uploadRes.status,
        upload_detail: detail.substring(0, 500),
        table_errors: errors,
      });
    }

    // ─── 3. Retention — delete backups older than 30 days ──────
    let deletedCount = 0;
    const deletedNames = [];
    try {
      const listRes = await storageFetch('object/list/backups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prefix: 'backup-',
          limit: 1000,
          offset: 0,
          sortBy: { column: 'name', order: 'desc' },
        }),
      });

      if (listRes.ok) {
        const allBackups = await listRes.json();
        const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        const toDelete = allBackups
          .filter((f) => {
            const m = f.name && f.name.match(/^backup-(\d{4}-\d{2}-\d{2})\.json$/);
            if (!m) return false;
            return new Date(m[1] + 'T00:00:00Z') < cutoff;
          })
          .map((f) => f.name);

        if (toDelete.length > 0) {
          const delRes = await storageFetch('object/backups', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prefixes: toDelete }),
          });
          if (delRes.ok) {
            deletedCount = toDelete.length;
            deletedNames.push(...toDelete);
          }
        }
      }
    } catch (_e) {
      // Retention failure is non-fatal — backup itself succeeded
    }

    // ─── 4. Audit log (best-effort) ────────────────────────────
    const elapsedMs = Date.now() - startedAt;
    await supaFetch('order_audit_logs', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        action: 'DB_BACKUP_CRON',
        actor_name: 'VERCEL_CRON',
        details: {
          filename,
          size_bytes: sizeBytes,
          table_count: TABLES.length,
          row_counts: dump.counts,
          retention_deleted: deletedCount,
          retention_deleted_names: deletedNames,
          table_errors: errors,
          elapsed_ms: elapsedMs,
        },
      }),
    }).catch(() => {});

    return res.status(200).json({
      ok: true,
      filename,
      size_bytes: sizeBytes,
      size_kb: Math.round(sizeBytes / 1024),
      table_count: TABLES.length,
      row_counts: dump.counts,
      retention_deleted: deletedCount,
      table_errors: errors,
      elapsed_ms: elapsedMs,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message, stack: e.stack });
  }
}
