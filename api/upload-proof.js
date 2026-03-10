// ══════════════════════════════════════════════════════════════
// YANI ONLINE ORDER — Payment Proof Upload API
// Stores payment proof as base64 in the online_orders table
// (Avoids Supabase Storage RLS issues)
// ══════════════════════════════════════════════════════════════
const SUPABASE_URL = 'https://hnynvclpvfxzlfjphefj.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_SECRET_KEY;

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
    
    // Ensure imageData is a proper data URL
    let dataUrl = imageData;
    if (!imageData.startsWith('data:')) {
      dataUrl = `data:${mimeType || 'image/jpeg'};base64,${imageData}`;
    }
    
    // Get the key to use (prefer service role for storage bypass)
    const authKey = process.env.SUPABASE_SECRET_KEY;
    
    // First try Supabase Storage upload
    let publicUrl = null;
    const BUCKET = 'payment-proofs';
    
    try {
      const base64Data = dataUrl.replace(/^data:[^;]+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      const ext = (mimeType || 'image/jpeg').split('/')[1] || 'jpg';
      const safeName = filename ? filename.replace(/[^a-zA-Z0-9._-]/g, '_') : `proof_${Date.now()}.${ext}`;
      const storagePath = `${orderRef}/${safeName}`;
      
      const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath}`, {
        method: 'POST',
        headers: {
          'apikey': authKey,
          'Authorization': `Bearer ${authKey}`,
          'Content-Type': mimeType || 'image/jpeg',
          'x-upsert': 'true'
        },
        body: buffer
      });
      
      if (uploadRes.ok) {
        publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${storagePath}`;
      }
    } catch (storageErr) {
      console.log('Storage upload failed, falling back to base64:', storageErr.message);
    }
    
    // If storage failed, use the data URL directly as the proof URL
    // Update the online_orders table with the proof URL
    const proofUrl = publicUrl || dataUrl;
    
    // Update the order with the payment proof URL
    const updateRes = await fetch(`${SUPABASE_URL}/rest/v1/online_orders?order_ref=eq.${encodeURIComponent(orderRef)}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        payment_proof_url: proofUrl,
        payment_status: 'SUBMITTED',
        updated_at: new Date().toISOString()
      })
    });
    
    if (!updateRes.ok) {
      const errText = await updateRes.text();
      console.error('Order update error:', errText);
      // Still return success - the proof URL is returned to the client
    }
    
    return res.status(200).json({ 
      ok: true, 
      url: proofUrl,
      stored: publicUrl ? 'storage' : 'inline'
    });
    
  } catch (err) {
    console.error('Upload proof error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
