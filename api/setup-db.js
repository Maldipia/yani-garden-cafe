// One-time DB setup endpoint - creates tables that don't exist
// Call: POST /api/setup-db with {"secret": "yani-cron-2026"}
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  
  const { secret } = req.body || {};
  if (secret !== (process.env.CRON_SECRET || 'yani-cron-2026')) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL || 'https://hnynvclpvfxzlfjphefj.supabase.co',
    process.env.SUPABASE_SECRET_KEY
  );

  const results = [];

  // Create promo_codes table
  const { error: e1 } = await supabase.rpc('create_promo_codes_if_not_exists');
  if (e1) {
    // Table creation via RPC failed - try direct insert to detect if table exists
    const { error: e2 } = await supabase.from('promo_codes').select('id').limit(1);
    if (e2 && e2.code === 'PGRST205') {
      results.push({ table: 'promo_codes', status: 'NEEDS_MANUAL_CREATION', sql_file: 'supabase/migrations/20260411001_create_promo_codes.sql' });
    } else if (!e2) {
      results.push({ table: 'promo_codes', status: 'EXISTS' });
    }
  } else {
    results.push({ table: 'promo_codes', status: 'CREATED' });
  }

  // Check if table exists now
  const { error: check } = await supabase.from('promo_codes').select('id').limit(1);
  
  return res.status(200).json({ 
    ok: !check,
    tableExists: !check,
    results,
    message: check ? 'Run SQL from supabase/migrations/20260411001_create_promo_codes.sql in Supabase dashboard' : 'promo_codes table is ready'
  });
}
