// ══════════════════════════════════════════════════════════════
// YANI POS — Image Upload Endpoint
// Accepts a base64-encoded image and commits it to GitHub repo
// so Vercel auto-deploys it to /images/{code}.{ext}
// ══════════════════════════════════════════════════════════════

const GITHUB_OWNER = 'Maldipia';
const GITHUB_REPO  = 'yani-garden-cafe';
const GITHUB_BRANCH = 'main';
// GitHub token must be set as Vercel environment variable: GITHUB_TOKEN
// (Settings → Environment Variables in Vercel dashboard)

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    const { code, ext, base64, pin } = req.body || {};

    // Basic validation
    if (!code || !ext || !base64) {
      return res.status(400).json({ ok: false, error: 'Missing code, ext, or base64 data' });
    }

    // Validate item code format (letters + digits only, 2-6 chars)
    if (!/^[A-Z0-9]{2,8}$/i.test(code)) {
      return res.status(400).json({ ok: false, error: 'Invalid item code format' });
    }

    // Validate extension
    const allowedExt = ['png', 'jpg', 'jpeg', 'webp'];
    const cleanExt = ext.toLowerCase().replace('.', '');
    if (!allowedExt.includes(cleanExt)) {
      return res.status(400).json({ ok: false, error: 'Invalid file extension. Use png, jpg, jpeg, or webp.' });
    }

    // Validate base64 size (max 5MB decoded ≈ ~6.7MB base64)
    if (base64.length > 7_000_000) {
      return res.status(400).json({ ok: false, error: 'Image too large. Max 5MB.' });
    }

    const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    if (!GITHUB_TOKEN) {
      return res.status(500).json({ ok: false, error: 'Server not configured for image uploads. Contact admin.' });
    }

    const filePath = `images/${code.toUpperCase()}.${cleanExt}`;
    const apiBase = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`;

    // Check if file already exists (to get its SHA for update)
    let existingSha = null;
    try {
      const checkResp = await fetch(apiBase + `?ref=${GITHUB_BRANCH}`, {
        headers: {
          'Authorization': `token ${GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'YaniPOS-ImageUpload'
        }
      });
      if (checkResp.ok) {
        const checkData = await checkResp.json();
        existingSha = checkData.sha || null;
      }
    } catch (_) { /* file doesn't exist yet, that's fine */ }

    // Commit the image to GitHub
    const commitBody = {
      message: `feat: upload menu image for ${code.toUpperCase()}`,
      content: base64, // must be base64-encoded
      branch: GITHUB_BRANCH
    };
    if (existingSha) commitBody.sha = existingSha;

    const commitResp = await fetch(apiBase, {
      method: 'PUT',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'YaniPOS-ImageUpload'
      },
      body: JSON.stringify(commitBody)
    });

    if (!commitResp.ok) {
      const errText = await commitResp.text();
      console.error('GitHub commit failed:', errText);
      return res.status(502).json({ ok: false, error: 'Failed to save image to GitHub. Try again.' });
    }

    const commitData = await commitResp.json();
    const localPath = `/images/${code.toUpperCase()}.${cleanExt}`;

    return res.status(200).json({
      ok: true,
      path: localPath,
      sha: commitData.content && commitData.content.sha,
      message: 'Image uploaded. It will appear on the menu within 1-2 minutes after Vercel deploys.'
    });

  } catch (err) {
    console.error('upload-image error:', err);
    return res.status(500).json({ ok: false, error: 'Server error: ' + err.message });
  }
}
