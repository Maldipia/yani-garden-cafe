// TEMPORARY — one-time RLS setup. DELETE AFTER USE.
const EXEC_SECRET = 'yani-rls-2026';
const PROJECT = 'hnynvclpvfxzlfjphefj';

const STATEMENTS = [
  // Ensure RLS is on (idempotent)
  `ALTER TABLE public.dine_in_orders ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE public.dine_in_order_items ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE public.online_orders ENABLE ROW LEVEL SECURITY`,

  // Revoke ALL (including SELECT) from anon on private tables
  `REVOKE ALL ON public.dine_in_orders FROM anon`,
  `REVOKE ALL ON public.dine_in_order_items FROM anon`,
  `REVOKE ALL ON public.online_orders FROM anon`,
  `REVOKE ALL ON public.staff_users FROM anon`,
  `REVOKE ALL ON public.payments FROM anon`,
  `REVOKE ALL ON public.sheets_sync_log FROM anon`,

  // Re-confirm allowed anon grants
  `GRANT SELECT ON public.menu_items TO anon`,
  `GRANT SELECT ON public.menu_categories TO anon`,
  `GRANT SELECT ON public.settings TO anon`,
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const secret = req.headers['x-exec-secret'] || req.query.secret;
  if (secret !== EXEC_SECRET) return res.status(403).json({ error: 'Forbidden' });

  const pat = req.headers['x-pat'] || req.query.pat;
  if (!pat) return res.status(400).json({ error: 'Missing PAT' });

  const results = [];
  for (const sql of STATEMENTS) {
    const r = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${pat}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql }),
    });
    const text = await r.text();
    results.push({ sql: sql.slice(0, 60), status: r.status, ok: r.status < 300, body: text.slice(0, 60) });
  }

  return res.status(200).json({ ok: results.every(r=>r.ok), passed: results.filter(r=>r.ok).length, total: results.length, results });
}
