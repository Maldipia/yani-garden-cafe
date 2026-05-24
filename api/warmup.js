// ── Warmup endpoint — keeps function warm during business hours ───────────
// Called by Vercel cron every 5 min (6am–11pm PHT = 22:00–15:00 UTC)
// A warm function eliminates the 1-3s cold start on first real request.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Warmed-At', new Date().toISOString());
  return res.status(200).json({
    ok: true,
    warmed: true,
    ts: Date.now(),
    msg: 'YANI POS function warm ☕',
  });
}
