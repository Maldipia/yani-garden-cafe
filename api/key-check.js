export default async function handler(req, res) {
  const key = process.env.SUPABASE_SECRET_KEY || 'NOT_SET';
  const SUPABASE_URL = 'https://hnynvclpvfxzlfjphefj.supabase.co';
  
  // Test if key can read from Supabase
  let canRead = false;
  let canWrite = false;
  
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/menu_categories?limit=1`, {
      headers: { 'apikey': key, 'Authorization': `Bearer ${key}` }
    });
    canRead = r.ok;
  } catch(e) {}
  
  // Test write (PATCH on non-existent item = no-op but tests RLS)
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/menu_items?item_code=eq.NOEXIST_TEST`, {
      method: 'PATCH',
      headers: { 
        'apikey': key, 
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ name: 'test' })
    });
    canWrite = r.ok;
  } catch(e) {}
  
  return res.status(200).json({
    hasKey: key !== 'NOT_SET',
    keyPrefix: key.substring(0, 20),
    isSecret: key.startsWith('sb_secret_'),
    isAnon: key.startsWith('sb_publishable_'),
    canRead,
    canWrite,
  });
}
