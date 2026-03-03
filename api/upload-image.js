// ══════════════════════════════════════════════════════════════
// YANI POS — Image Upload Endpoint
// Accepts a base64-encoded image and commits it to GitHub repo
// so Vercel auto-deploys it to /images/{code}.{ext}
// Also updates image_path in Supabase menu_items so the online
// order page shows the new image immediately.
// ══════════════════════════════════════════════════════════════

const SUPABASE_URL = 'https://hnynvclpvfxzlfjphefj.supabase.co';
// Use secret key (env var) for server-side ops — bypasses RLS for image path updates
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_ANON_KEY || 'sb_publishable_PQBb1nDY7U7SxNfgDYoXyg_GtoLowLM';

const GITHUB_OWNER  = 'Maldipia';
const GITHUB_REPO   = 'yani-garden-cafe';
const GITHUB_BRANCH = 'main';
const VERCEL_ALIAS  = 'yani-garden-cafe-d3l6.vercel.app';
const VERCEL_PROJECT_ID = 'prj_sAaageyafER4acIM59K5FUhQ4020';

// Required Vercel environment variables:
//   GITHUB_TOKEN   — GitHub PAT with repo write access
//   VERCEL_TOKEN   — Vercel API token (for alias promotion)
//   VERCEL_TEAM_ID — Vercel team ID

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    const { code, ext, base64 } = req.body || {};

    // Basic validation
    if (!code || !ext || !base64) {
      return res.status(400).json({ ok: false, error: 'Missing code, ext, or base64 data' });
    }

    // Validate item code format (letters + digits, 2-30 chars, allows underscore for ITEM_ codes)
    if (!/^[A-Z0-9_]{2,30}$/i.test(code)) {
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
      content: base64,
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

    // ── Update image_path in Supabase so online order page shows image ──
    // Fire-and-forget: non-blocking, won't fail the upload if Supabase is slow
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/menu_items?item_code=eq.${encodeURIComponent(code.toUpperCase())}`, {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({ image_path: localPath })
      });
    } catch (e) {
      console.warn('Supabase image_path update failed (non-critical):', e.message);
    }

    // ── Promote latest READY deployment to production alias ──────────
    // This ensures the uploaded image is served immediately after Vercel
    // builds the new deployment triggered by the GitHub commit above.
    // We do this asynchronously so it doesn't block the response.
    const VERCEL_TOKEN  = process.env.VERCEL_TOKEN;
    const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID;
    if (VERCEL_TOKEN && VERCEL_TEAM_ID) {
      // Fire-and-forget alias promotion after a short delay
      // (Vercel needs ~60-90s to build after the GitHub commit)
      // We schedule it via a background fetch with no await
      promoteLatestDeployment(VERCEL_TOKEN, VERCEL_TEAM_ID).catch(e => {
        console.warn('Alias promotion failed (non-critical):', e.message);
      });
    }

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

// Promote the latest READY deployment to the production alias
async function promoteLatestDeployment(vercelToken, teamId) {
  try {
    // Wait 90 seconds for Vercel to build
    await new Promise(r => setTimeout(r, 90_000));

    // Get latest READY deployment
    const listResp = await fetch(
      `https://api.vercel.com/v6/deployments?projectId=${VERCEL_PROJECT_ID}&teamId=${teamId}&limit=5`,
      { headers: { 'Authorization': `Bearer ${vercelToken}` } }
    );
    if (!listResp.ok) return;
    const listData = await listResp.json();
    const latest = (listData.deployments || []).find(d => d.state === 'READY');
    if (!latest) return;

    // Assign alias
    await fetch(
      `https://api.vercel.com/v2/deployments/${latest.uid}/aliases?teamId=${teamId}`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${vercelToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ alias: VERCEL_ALIAS })
      }
    );
    console.log('Alias promoted to:', latest.uid);
  } catch (e) {
    console.warn('promoteLatestDeployment error:', e.message);
  }
}
