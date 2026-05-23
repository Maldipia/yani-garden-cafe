// api/cron-leaves-expiry.js
// Vercel cron handler — runs the expire_leaves() Postgres function nightly.
//
// Schedule: every day at 18:00 UTC (02:00 PHT next day) — quiet hour.
// Security: Vercel automatically adds `Authorization: Bearer <CRON_SECRET>`
//           to every cron invocation when the CRON_SECRET env var is set.
//           We verify it before running.
//
// Side effects:
//   • Zeroes out leaf balances for accounts inactive >= LEAVES_EXPIRY_MONTHS
//     (default 6 months), logged as 'EXPIRE' rows in points_transactions
//   • Sets status='EXPIRED' on PENDING surprise_rewards older than
//     SURPRISE_REWARD_EXPIRY_DAYS (default 30 days)
//   • Writes one LEAVES_EXPIRY_SWEEP row to order_audit_logs
//
// Manual trigger: POST { secret: '<CRON_SECRET>' } to this endpoint.
// (Owner-PIN manual trigger is available via the main pos.js action
//  'expireLeaves' for use from the admin UI.)

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://hnynvclpvfxzlfjphefj.supabase.co';
const SUPABASE_KEY = (() => {
  const k = process.env.SUPABASE_SECRET_KEY;
  if (!k) throw new Error('SUPABASE_SECRET_KEY not set');
  return k;
})();
const CRON_SECRET  = process.env.CRON_SECRET || '';

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

export default async function handler(req, res) {
  // Allow GET (Vercel cron uses GET) and POST (manual call)
  const authHeader = req.headers?.authorization || '';
  const bodySecret = req.body?.secret;
  const headerOk   = CRON_SECRET && authHeader === 'Bearer ' + CRON_SECRET;
  const bodyOk     = CRON_SECRET && bodySecret  === CRON_SECRET;
  if (!headerOk && !bodyOk) {
    return res.status(403).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    const r = await supaFetch('rpc/expire_leaves', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    if (!r.ok) {
      return res.status(500).json({ ok: false, error: 'DB error', detail: r.data });
    }

    // Audit log entry (best-effort)
    await supaFetch('order_audit_logs', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        action: 'LEAVES_EXPIRY_SWEEP_CRON',
        actor_name: 'VERCEL_CRON',
        details: r.data,
      }),
    }).catch(() => {});

    return res.status(200).json(r.data);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
