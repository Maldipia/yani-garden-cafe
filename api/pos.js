// ══════════════════════════════════════════════════════════════
// YANI POS — Vercel Serverless API Proxy
// Forwards requests from frontend → Apps Script (server-to-server)
// This eliminates ALL CORS issues permanently
// ══════════════════════════════════════════════════════════════

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbytCV-jiFSOoon7Ijww5a-AABRYzhiNZPXVubaaa2zoVBOFxvcgkDH-6e4CfksMA7LC/exec';

export default async function handler(req, res) {
  // CORS headers for the frontend
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

    // Forward to Apps Script
    const response = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(JSON.stringify(body)),
      redirect: 'follow'
    });

    const text = await response.text();
    
    // Try to parse as JSON
    try {
      const data = JSON.parse(text);
      return res.status(200).json(data);
    } catch (e) {
      // If Apps Script returns HTML (redirect/error), return a friendly error
      console.error('Apps Script returned non-JSON:', text.substring(0, 200));
      return res.status(502).json({ 
        ok: false, 
        error: 'Backend returned invalid response. Please try again.' 
      });
    }
  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(500).json({ ok: false, error: 'Server error. Please try again.' });
  }
}
