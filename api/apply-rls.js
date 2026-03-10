// TEMPORARY: One-time RLS policy setup endpoint
// DELETE THIS FILE after running once
export default async function handler(req, res) {
  const SECRET = process.env.SUPABASE_SECRET_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://hnynvclpvfxzlfjphefj.supabase.co';

  if (!SECRET) {
    return res.status(500).json({ ok: false, error: 'No SUPABASE_SECRET_KEY env var set' });
  }

  // Use the service role key to write to menu_items directly
  // This tests if the service key works
  const testUrl = `${SUPABASE_URL}/rest/v1/menu_items?item_code=eq.C022`;
  const testResp = await fetch(testUrl, {
    method: 'PATCH',
    headers: {
      'apikey': SECRET,
      'Authorization': `Bearer ${SECRET}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify({ category_id: '9094c828-1da1-4802-838b-8eb4da3c16be' }),
  });
  const testText = await testResp.text();

  return res.status(200).json({
    ok: testResp.ok,
    status: testResp.status,
    result: testText.substring(0, 500),
    hasSecret: !!SECRET,
    secretPrefix: SECRET ? SECRET.substring(0, 20) + '...' : 'none',
  });
}
