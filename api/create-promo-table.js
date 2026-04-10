// Temporary migration endpoint - deletes itself after running
// POST /api/create-promo-table with {"secret": "yani-cron-2026"}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { secret } = req.body || {};
  if (secret !== (process.env.CRON_SECRET || 'yani-cron-2026')) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://hnynvclpvfxzlfjphefj.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;

  // Try to create the table using Supabase's pg-meta endpoint
  // which is available at a special internal URL in Vercel
  
  const sql = `CREATE TABLE IF NOT EXISTS promo_codes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code text UNIQUE NOT NULL,
    discount_type text NOT NULL CHECK (discount_type IN ('PERCENT','FIXED')),
    discount_value numeric NOT NULL CHECK (discount_value > 0),
    description text,
    valid_from timestamptz,
    valid_until timestamptz,
    max_uses integer,
    used_count integer DEFAULT 0,
    is_active boolean DEFAULT true,
    created_at timestamptz DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS promo_codes_code_idx ON promo_codes(code);
  CREATE INDEX IF NOT EXISTS promo_codes_active_idx ON promo_codes(is_active);`;

  // Method 1: Try via Supabase's pg connection string
  // Supabase provides POSTGRES_URL in some setups
  const pgUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  
  if (pgUrl) {
    try {
      const { Pool } = await import('pg');
      const pool = new Pool({ connectionString: pgUrl, ssl: { rejectUnauthorized: false } });
      await pool.query(sql);
      await pool.end();
      return res.json({ ok: true, method: 'pg', message: 'Table created!' });
    } catch(e) {
      console.error('pg failed:', e.message);
    }
  }

  // Method 2: Try Supabase Management API
  const mgmt = await fetch('https://api.supabase.com/v1/projects/hnynvclpvfxzlfjphefj/database/query', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql })
  });
  
  if (mgmt.ok) {
    return res.json({ ok: true, method: 'mgmt', message: 'Table created!' });
  }

  // Method 3: Check if table already exists
  const check = await fetch(`${SUPABASE_URL}/rest/v1/promo_codes?limit=0`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  
  if (check.ok) {
    return res.json({ ok: true, method: 'exists', message: 'Table already exists!' });
  }

  const mgmtErr = await mgmt.text();
  return res.json({ 
    ok: false, 
    error: 'Could not create table automatically',
    mgmtError: mgmtErr.substring(0, 200),
    instruction: 'Please run the SQL manually in Supabase SQL Editor',
    sql: sql
  });
}
