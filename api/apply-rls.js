// TEMPORARY — one-time RLS setup. DELETE AFTER USE.
const EXEC_SECRET = 'yani-rls-2026';
const PROJECT = 'hnynvclpvfxzlfjphefj';

const STATEMENTS = [
  `ALTER TABLE public.menu_items ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE public.menu_categories ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE public.dine_in_orders ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE public.dine_in_order_items ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE public.staff_users ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE public.sheets_sync_log ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE public.online_orders ENABLE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS "anon_read_active_menu" ON public.menu_items`,
  `DROP POLICY IF EXISTS "anon_read_categories" ON public.menu_categories`,
  `DROP POLICY IF EXISTS "anon_read_settings" ON public.settings`,
  `CREATE POLICY "anon_read_active_menu" ON public.menu_items FOR SELECT TO anon USING (is_active = true)`,
  `CREATE POLICY "anon_read_categories" ON public.menu_categories FOR SELECT TO anon USING (true)`,
  `CREATE POLICY "anon_read_settings" ON public.settings FOR SELECT TO anon USING (true)`,
  `REVOKE INSERT, UPDATE, DELETE ON public.dine_in_orders FROM anon`,
  `REVOKE INSERT, UPDATE, DELETE ON public.dine_in_order_items FROM anon`,
  `REVOKE ALL ON public.staff_users FROM anon`,
  `REVOKE ALL ON public.payments FROM anon`,
  `REVOKE ALL ON public.sheets_sync_log FROM anon`,
  `REVOKE INSERT, UPDATE, DELETE ON public.online_orders FROM anon`,
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
  if (!pat) return res.status(400).json({ error: 'Missing PAT — pass as x-pat header' });

  const results = [];
  for (const sql of STATEMENTS) {
    try {
      const r = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${pat}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: sql }),
      });
      const text = await r.text();
      const ok = r.status < 300 || text.toLowerCase().includes('already');
      results.push({ sql: sql.slice(0, 55), status: r.status, ok, body: text.slice(0, 80) });
    } catch (e) {
      results.push({ sql: sql.slice(0, 55), status: 0, ok: false, body: e.message });
    }
  }

  const allOk = results.every(r => r.ok);
  return res.status(200).json({ ok: allOk, total: results.length, passed: results.filter(r=>r.ok).length, results });
}
