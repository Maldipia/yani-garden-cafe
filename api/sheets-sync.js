// ══════════════════════════════════════════════════════════════
// YANI POS — Google Sheets Live Mirror Sync  (v1)
// Pushes new/updated orders from Supabase → Google Sheets.
// Google Sheets is a READ-ONLY mirror for the owner's reference.
// Supabase is the single source of truth.
//
// Triggered by:
//   - Vercel Cron Job (every 2 minutes via vercel.json)
//   - Manual call: POST /api/sheets-sync
//
// Requirements:
//   - GOOGLE_SERVICE_ACCOUNT_JSON env var (service account JSON)
//   - GOOGLE_SHEETS_ID env var (spreadsheet ID)
//
// Sheet tabs synced:
//   - "Orders"  ← dine_in_orders (last 200 orders, newest first)
//   - "Payments" ← payments (last 200 payments, newest first)
// ══════════════════════════════════════════════════════════════

const SUPABASE_URL = 'https://hnynvclpvfxzlfjphefj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_ANON_KEY || 'sb_publishable_PQBb1nDY7U7SxNfgDYoXyg_GtoLowLM';
const SHEETS_ID    = process.env.GOOGLE_SHEETS_ID || '';
const SA_JSON_STR  = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '';

// ── Supabase fetch helper ──────────────────────────────────────
async function supaFetch(url) {
  const resp = await fetch(url, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    }
  });
  if (!resp.ok) throw new Error(`Supabase fetch failed: ${resp.status}`);
  return resp.json();
}

// ── Get Google OAuth2 access token via service account JWT ────
async function getGoogleAccessToken(saJson) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: saJson.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  // Encode header and payload
  const b64 = obj => btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const sigInput = `${b64(header)}.${b64(payload)}`;

  // Import private key
  const pemKey = saJson.private_key
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');
  const keyData = Uint8Array.from(atob(pemKey), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', keyData.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );

  // Sign
  const encoder = new TextEncoder();
  const sigBuffer = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, encoder.encode(sigInput));
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuffer)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const jwt = `${sigInput}.${sig}`;

  // Exchange JWT for access token
  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  if (!tokenResp.ok) {
    const err = await tokenResp.text();
    throw new Error(`Google OAuth failed: ${err.slice(0, 200)}`);
  }
  const tokenData = await tokenResp.json();
  return tokenData.access_token;
}

// ── Write data to a Google Sheets tab ─────────────────────────
async function writeToSheet(accessToken, sheetId, tabName, rows) {
  // Clear the tab first, then write
  const range = `${tabName}!A1:Z1000`;

  // Clear
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}:clear`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: '{}',
    }
  );

  // Write
  const writeResp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ range, majorDimension: 'ROWS', values: rows }),
    }
  );
  if (!writeResp.ok) {
    const err = await writeResp.text();
    throw new Error(`Sheets write failed for ${tabName}: ${err.slice(0, 200)}`);
  }
  return writeResp.json();
}

// ── Format date for Sheets (Manila time, readable) ────────────
function fmtDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const manila = new Date(d.getTime() + 8 * 3600 * 1000);
    return manila.toISOString().replace('T', ' ').slice(0, 19);
  } catch { return iso; }
}

// ── Main handler ──────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const startTime = Date.now();

  // ── Check if Sheets integration is configured ─────────────
  if (!SHEETS_ID || !SA_JSON_STR) {
    return res.status(200).json({
      ok: true,
      skipped: true,
      message: 'Google Sheets sync not configured (GOOGLE_SHEETS_ID or GOOGLE_SERVICE_ACCOUNT_JSON not set). Set these env vars in Vercel to enable Sheets mirroring.',
    });
  }

  try {
    // ── Parse service account JSON ────────────────────────────
    let saJson;
    try {
      saJson = JSON.parse(SA_JSON_STR);
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON' });
    }

    // ── Fetch data from Supabase ──────────────────────────────
    const [ordersRaw, paymentsRaw] = await Promise.all([
      supaFetch(`${SUPABASE_URL}/rest/v1/dine_in_orders?order=created_at.desc&limit=200`),
      supaFetch(`${SUPABASE_URL}/rest/v1/payments?order=created_at.desc&limit=200`),
    ]);

    // ── Fetch order items for all orders ──────────────────────
    const orderIds = ordersRaw.map(o => o.order_id);
    let itemsMap = {};
    if (orderIds.length > 0) {
      const itemsRaw = await supaFetch(
        `${SUPABASE_URL}/rest/v1/dine_in_order_items?order_id=in.(${orderIds.map(id => `"${id}"`).join(',')})&order=id.asc`
      );
      itemsRaw.forEach(it => {
        if (!itemsMap[it.order_id]) itemsMap[it.order_id] = [];
        itemsMap[it.order_id].push(`${it.item_name}${it.size_choice ? ' (' + it.size_choice + ')' : ''} x${it.qty}`);
      });
    }

    // ── Build Orders sheet rows ───────────────────────────────
    const ordersHeader = [
      'Order ID', 'Order No', 'Date (Manila)', 'Table', 'Customer',
      'Status', 'Type', 'Items', 'Subtotal', 'Service Charge', 'Total',
      'Payment Method', 'Payment Status', 'Notes', 'Source', 'Platform', 'Platform Ref'
    ];
    const ordersRows = [ordersHeader, ...ordersRaw.map(o => [
      o.order_id,
      o.order_no,
      fmtDate(o.created_at),
      o.table_no || '',
      o.customer_name || '',
      o.status,
      o.order_type,
      (itemsMap[o.order_id] || []).join('; '),
      o.subtotal,
      o.service_charge,
      o.total,
      o.payment_method || '',
      o.payment_status || '',
      o.notes || '',
      o.source || '',
      o.platform || '',
      o.platform_ref || '',
    ])];

    // ── Build Payments sheet rows ─────────────────────────────
    const paymentsHeader = [
      'Payment ID', 'Order ID', 'Date (Manila)', 'Amount', 'Method',
      'Status', 'Verified By', 'Verified At', 'Notes'
    ];
    const paymentsRows = [paymentsHeader, ...paymentsRaw.map(p => [
      p.payment_id,
      p.order_id,
      fmtDate(p.created_at),
      p.amount,
      p.payment_method,
      p.status,
      p.verified_by || '',
      p.verified_at ? fmtDate(p.verified_at) : '',
      p.rejection_reason || '',
    ])];

    // ── Get Google access token ───────────────────────────────
    const accessToken = await getGoogleAccessToken(saJson);

    // ── Write to Sheets ───────────────────────────────────────
    await Promise.all([
      writeToSheet(accessToken, SHEETS_ID, 'Orders', ordersRows),
      writeToSheet(accessToken, SHEETS_ID, 'Payments', paymentsRows),
    ]);

    // ── Mark all pending sync log entries as synced ───────────
    await fetch(`${SUPABASE_URL}/rest/v1/sheets_sync_log?synced=eq.false`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ synced: true, synced_at: new Date().toISOString() }),
    });

    const elapsed = Date.now() - startTime;
    return res.status(200).json({
      ok: true,
      message: `Sheets sync complete`,
      ordersWritten:   ordersRaw.length,
      paymentsWritten: paymentsRaw.length,
      elapsedMs: elapsed,
    });

  } catch (err) {
    console.error('sheets-sync error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
