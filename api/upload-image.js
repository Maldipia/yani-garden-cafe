// ══════════════════════════════════════════════════════════════
// YANI POS — Image Upload Endpoint (Supabase Storage)
// Accepts a base64-encoded image, uploads to Supabase Storage
// bucket "menu-images", and updates image_path in menu_items.
// No GitHub token required — works permanently.
// ══════════════════════════════════════════════════════════════
const SUPABASE_URL = 'https://hnynvclpvfxzlfjphefj.supabase.co';

const ALLOWED_ORIGINS = [
  'https://yanigardencafe.com',
  'https://pos.yanigardencafe.com',
  'https://admin.yanigardencafe.com',
  'https://yani-garden-cafe.vercel.app',
  'https://yani-cafe.vercel.app',
];

function setCorsHeaders(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');
}

const SUPABASE_BUCKET = 'menu-images';

// Use service role key (env var) for server-side storage uploads — bypasses RLS
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;

const ALLOWED_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
const MAX_BASE64_LEN = 7_000_000; // ~5MB decoded

export default async function handler(req, res) {
  // ── CORS headers ──────────────────────────────────────────
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    // Support both old field name (base64) and new (image) for backwards compat
    const { image, base64: base64Legacy, ext, code } = req.body || {};
    const rawImage = image || base64Legacy;

    // ── Input validation ──────────────────────────────────────
    if (!rawImage || !ext || !code) {
      return res.status(400).json({ ok: false, error: 'Missing required fields: image, ext, code' });
    }
    const cleanExt = ext.toLowerCase().replace(/[^a-z]/g, '');
    if (!ALLOWED_EXTS.includes(cleanExt)) {
      return res.status(400).json({ ok: false, error: `Invalid file type. Allowed: ${ALLOWED_EXTS.join(', ')}` });
    }
    const cleanCode = code.replace(/[^a-zA-Z0-9_-]/g, '').toUpperCase();
    if (!cleanCode) {
      return res.status(400).json({ ok: false, error: 'Invalid item code' });
    }

    // ── Strip base64 data URI prefix if present ───────────────
    const base64 = rawImage.replace(/^data:image\/[a-z]+;base64,/, '');
    if (base64.length > MAX_BASE64_LEN) {
      return res.status(400).json({ ok: false, error: 'Image too large. Max 5MB.' });
    }

    // ── Convert base64 to binary buffer ───────────────────────
    const imageBuffer = Buffer.from(base64, 'base64');
    const mimeType = cleanExt === 'jpg' ? 'image/jpeg' : `image/${cleanExt}`;
    const fileName = `${cleanCode}.${cleanExt}`;

    // ── Upload to Supabase Storage (upsert = overwrite if exists) ──
    const uploadResp = await fetch(
      `${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/${fileName}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'apikey': SUPABASE_KEY,
          'Content-Type': mimeType,
          'x-upsert': 'true',
          'Cache-Control': '3600',
        },
        body: imageBuffer,
      }
    );

    if (!uploadResp.ok) {
      const errText = await uploadResp.text();
      console.error('Supabase Storage upload failed:', errText);
      return res.status(502).json({ ok: false, error: 'Failed to upload image. Try again.' });
    }

    // ── Build the public URL ───────────────────────────────────
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${fileName}`;

    // ── Update image_path in Supabase menu_items ──────────────
    try {
      const patchResp = await fetch(
        `${SUPABASE_URL}/rest/v1/menu_items?item_code=eq.${encodeURIComponent(cleanCode)}`,
        {
          method: 'PATCH',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal',
          },
          body: JSON.stringify({ image_path: publicUrl }),
        }
      );
      if (!patchResp.ok) {
        const patchErr = await patchResp.text();
        console.warn('Supabase image_path update failed (non-critical):', patchErr);
      }
    } catch (e) {
      console.warn('Supabase image_path update error (non-critical):', e.message);
    }

    return res.status(200).json({
      ok: true,
      path: publicUrl,
      message: 'Image uploaded successfully. It will appear on the menu immediately.',
    });

  } catch (err) {
    console.error('upload-image error:', err);
    return res.status(500).json({ ok: false, error: 'Server error: ' + err.message });
  }
}
