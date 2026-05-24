// ── Google Drive upload helper ─────────────────────────────────────────────
import { supaFetch } from './db.js';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

export async function uploadToGoogleDrive(imageBuffer, mimeType, filename, folderId) {
  try {
    // Read SA from Supabase settings (fallback to env var)
    let saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '';
    if (!saJson) {
      try {
        const saR = await fetch(
          `${SUPABASE_URL}/rest/v1/settings?key=eq.GOOGLE_SA_JSON&select=value`,
          { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
        );
        const saData = await saR.json();
        saJson = (saData && saData[0]) ? saData[0].value : '';
      } catch(_) {}
    }
    const sa = JSON.parse(saJson || '{}');
    if (!sa.private_key || !sa.client_email) return null;
    const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const now     = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/drive',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600, iat: now,
    })).toString('base64url');
    const { createSign } = await import('node:crypto');
    const sign   = createSign('RSA-SHA256');
    sign.update(`${header}.${payload}`);
    const sig = sign.sign(sa.private_key, 'base64url');
    const jwt = `${header}.${payload}.${sig}`;
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    });
    const tokenData = await tokenResp.json();
    if (!tokenData.access_token) {
      console.error('Drive token failed:', JSON.stringify(tokenData).substring(0,200));
      return { error: `Token failed: ${tokenData.error_description || tokenData.error || 'no access_token'}` };
    }
    const boundary = '----YaniPOS';
    const meta = JSON.stringify({ name: filename, parents: [folderId] });
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
      imageBuffer,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    const uploadResp = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink',
      { method: 'POST', headers: {
          'Authorization': `Bearer ${tokenData.access_token}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        }, body }
    );
    const d = await uploadResp.json();
    if (!uploadResp.ok) {
      // Return error details for debugging
      const errMsg = d.error ? `Drive API ${uploadResp.status}: ${d.error.message || JSON.stringify(d.error)}` : `Drive API ${uploadResp.status}`;
      console.error('Drive upload failed:', errMsg);
      return { error: errMsg };
    }
    return d.webViewLink || (d.id ? `https://drive.google.com/file/d/${d.id}/view` : null);
  } catch(e) { console.error('Drive upload error:', e.message); return { error: e.message }; }
}

