// TEMPORARY — one-time RLS setup via Supabase Management API
// DELETE AFTER USE

const EXEC_SECRET = 'yani-rls-2026';
const PROJECT_REF = 'hnynvclpvfxzlfjphefj';
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;

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
];

async function runSQL(sql, mgmtToken) {
  const resp = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${mgmtToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: sql }),
    }
  );
  const text = await resp.text();
  return { status: resp.status, body: text.slice(0, 150) };
}

export default async function handler(req, res) {
  const token = req.headers['x-exec-secret'] || req.query.secret;
  if (token !== EXEC_SECRET) return res.status(403).json({ error: 'Forbidden' });

  // mgmt token can be passed as query param for one-time use
  const mgmtToken = req.query.mgmt || req.headers['x-mgmt-token'];
  if (!mgmtToken) {
    return res.status(400).json({ 
      error: 'Need Supabase Management API token',
      hint: 'Pass as ?mgmt=YOUR_SUPABASE_PAT or x-mgmt-token header',
      howToGet: 'https://supabase.com/dashboard/account/tokens → Generate new token'
    });
  }

  const results = [];
  for (const sql of STATEMENTS) {
    const r = await runSQL(sql, mgmtToken);
    results.push({ sql: sql.slice(0, 55), status: r.status, body: r.body });
  }

  const allOk = results.every(r => r.status < 300);
  return res.status(200).json({ ok: allOk, results });
}
