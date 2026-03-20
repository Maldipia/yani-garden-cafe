// GET /api/payment-proof?id=PAY-xxx&userId=USR_001
// Returns raw image bytes — much faster than base64-in-JSON via pos.js

const SUPABASE_URL = 'https://hnynvclpvfxzlfjphefj.supabase.co';
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id, userId } = req.query;
  if (!id || !userId) return res.status(400).json({ error: 'id and userId required' });

  // Basic userId format check
  if (!/^USR_\d{3,6}$/.test(userId)) return res.status(403).json({ error: 'Unauthorized' });

  // Verify user exists and has admin role
  const staffR = await fetch(
    `${SUPABASE_URL}/rest/v1/staff_users?user_id=eq.${encodeURIComponent(userId)}&active=eq.true&select=role`,
    { headers: { apikey: SUPABASE_SECRET_KEY, Authorization: `Bearer ${SUPABASE_SECRET_KEY}` } }
  );
  const staff = await staffR.json();
  if (!staff?.length || !['OWNER','ADMIN','CASHIER','SERVER'].includes(staff[0].role)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  // Fetch proof_url from DB
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/payments?payment_id=eq.${encodeURIComponent(id)}&select=proof_url,proof_filename`,
    { headers: { apikey: SUPABASE_SECRET_KEY, Authorization: `Bearer ${SUPABASE_SECRET_KEY}` } }
  );
  const data = await r.json();
  if (!data?.length || !data[0].proof_url) {
    return res.status(404).json({ error: 'Proof not found' });
  }

  const proofUrl = data[0].proof_url;

  // If it's already a real URL (Supabase Storage), redirect to it
  if (proofUrl.startsWith('http')) {
    return res.redirect(302, proofUrl);
  }

  // It's base64 data URL — extract and return as raw image
  const match = proofUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return res.status(400).json({ error: 'Invalid proof format' });

  const contentType = match[1]; // e.g. image/jpeg
  const imageBuffer = Buffer.from(match[2], 'base64');

  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('Content-Length', imageBuffer.length);
  return res.status(200).send(imageBuffer);
}
