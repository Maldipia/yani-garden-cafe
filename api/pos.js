// ══════════════════════════════════════════════════════════════
// YANI POS — Vercel Serverless API Proxy
// Forwards requests from frontend → Apps Script (server-to-server)
// Handles Apps Script's 302 redirect behavior
// ══════════════════════════════════════════════════════════════

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbytCV-jiFSOoon7Ijww5a-AABRYzhiNZPXVubaaa2zoVBOFxvcgkDH-6e4CfksMA7LC/exec';

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const body = req.body;
    
    if (!body || !body.action) {
      return res.status(400).json({ ok: false, error: 'Missing action' });
    }

    // Step 1: POST to Apps Script with raw JSON
    // Use redirect: 'manual' to catch the 302 redirect
    const postResponse = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'manual'
    });

    let responseText;

    if (postResponse.status === 302 || postResponse.status === 301) {
      // Step 2: Follow the redirect URL with GET to get the actual response
      const redirectUrl = postResponse.headers.get('location');
      if (!redirectUrl) {
        return res.status(502).json({ ok: false, error: 'Backend redirect missing location' });
      }

      const getResponse = await fetch(redirectUrl, {
        method: 'GET',
        redirect: 'follow'
      });
      responseText = await getResponse.text();
    } else {
      // Non-redirect response
      responseText = await postResponse.text();
    }

    // Parse and return JSON
    try {
      const data = JSON.parse(responseText);
      return res.status(200).json(data);
    } catch (e) {
      console.error('Apps Script returned non-JSON:', responseText.substring(0, 300));
      return res.status(502).json({ 
        ok: false, 
        error: 'Backend returned invalid response. Please try again.' 
      });
    }
  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(500).json({ ok: false, error: 'Server error: ' + err.message });
  }
}
