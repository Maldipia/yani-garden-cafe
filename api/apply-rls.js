// TEMPORARY — one-time RLS setup endpoint. DELETE AFTER USE.
// Protected by a secret token so only we can call it.

export const config = { api: { bodyParser: true } };

const SUPABASE_URL = 'https://hnynvclpvfxzlfjphefj.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;
const EXEC_SECRET = process.env.RLS_EXEC_SECRET || 'yani-rls-2026';

// Execute SQL via Supabase's PostgREST RPC
// We'll create the helper function first, use it, then drop it
async function sbFetch(path, method = 'GET', body = null) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: resp.status, body: await resp.text() };
}

// Use Supabase's pg-meta internal API which IS accessible with service role
async function execSQL(sql) {
  const resp = await fetch(`${SUPABASE_URL}/pg/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });
  return { status: resp.status, body: await resp.text() };
}

const RLS_STATEMENTS = [
  // Enable RLS
  'ALTER TABLE public.menu_items ENABLE ROW LEVEL SECURITY',
  'ALTER TABLE public.menu_categories ENABLE ROW LEVEL SECURITY',
  'ALTER TABLE public.dine_in_orders ENABLE ROW LEVEL SECURITY',
  'ALTER TABLE public.dine_in_order_items ENABLE ROW LEVEL SECURITY',
  'ALTER TABLE public.staff_users ENABLE ROW LEVEL SECURITY',
  'ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY',
  'ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY',
  'ALTER TABLE public.sheets_sync_log ENABLE ROW LEVEL SECURITY',
  'ALTER TABLE public.online_orders ENABLE ROW LEVEL SECURITY',

  // Drop existing policies
  `DO $$ DECLARE r RECORD; BEGIN FOR r IN SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public' LOOP EXECUTE 'DROP POLICY IF EXISTS "' || r.policyname || '" ON public.' || r.tablename; END LOOP; END $$`,

  // menu_items: anon reads active only
  `CREATE POLICY "anon_read_active_menu" ON public.menu_items FOR SELECT TO anon USING (is_active = true)`,

  // menu_categories: anon reads all
  `CREATE POLICY "anon_read_categories" ON public.menu_categories FOR SELECT TO anon USING (true)`,

  // settings: anon reads all  
  `CREATE POLICY "anon_read_settings" ON public.settings FOR SELECT TO anon USING (true)`,

  // Revoke dangerous defaults
  'REVOKE ALL ON public.dine_in_orders FROM anon',
  'REVOKE ALL ON public.dine_in_order_items FROM anon',
  'REVOKE ALL ON public.staff_users FROM anon',
  'REVOKE ALL ON public.payments FROM anon',
  'REVOKE ALL ON public.sheets_sync_log FROM anon',
  'REVOKE ALL ON public.online_orders FROM anon',

  // Re-grant only what anon needs
  'GRANT SELECT ON public.menu_items TO anon',
  'GRANT SELECT ON public.menu_categories TO anon',
  'GRANT SELECT ON public.settings TO anon',
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://admin.yanigardencafe.com');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth check
  const token = req.headers['x-exec-secret'] || req.query.secret;
  if (token !== EXEC_SECRET) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }

  const results = [];
  for (const sql of RLS_STATEMENTS) {
    try {
      const r = await execSQL(sql);
      results.push({ sql: sql.slice(0, 60) + '...', status: r.status, body: r.body.slice(0, 100) });
    } catch (e) {
      results.push({ sql: sql.slice(0, 60) + '...', error: e.message });
    }
  }

  return res.status(200).json({ ok: true, results });
}
