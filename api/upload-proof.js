// ══════════════════════════════════════════════════════════════
// YANI ONLINE ORDER — Payment Proof Upload API
// Uploads payment proof images to Supabase Storage
// ══════════════════════════════════════════════════════════════

const SUPABASE_URL = 'https://hnynvclpvfxzlfjphefj.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_PQBb1nDY7U7SxNfgDYoXyg_GtoLowLM';
const BUCKET = 'payment-proofs';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '6mb',
    },
  },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    const { orderRef, imageData, mimeType, filename } = req.body;
    
    if (!orderRef || !imageData) {
      return res.status(400).json({ ok: false, error: 'Missing orderRef or imageData' });
    }
    
    // Decode base64 image
    const base64Data = imageData.replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    
    // Generate unique filename
    const ext = (mimeType || 'image/jpeg').split('/')[1] || 'jpg';
    const safeName = filename ? filename.replace(/[^a-zA-Z0-9._-]/g, '_') : `proof_${Date.now()}.${ext}`;
    const storagePath = `${orderRef}/${safeName}`;
    
    // Upload to Supabase Storage
    const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath}`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': mimeType || 'image/jpeg',
        'x-upsert': 'true'
      },
      body: buffer
    });
    
    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      console.error('Supabase upload error:', errText);
      return res.status(500).json({ ok: false, error: 'Upload failed: ' + errText });
    }
    
    // Get public URL
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${storagePath}`;
    
    return res.status(200).json({ 
      ok: true, 
      url: publicUrl,
      path: storagePath
    });
    
  } catch (err) {
    console.error('Upload proof error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
