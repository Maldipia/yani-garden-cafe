// ══════════════════════════════════════════════════════════════
// YANI POS — Vercel Serverless API Proxy
// Forwards requests from frontend → Apps Script (server-to-server)
// Handles Apps Script's 302 redirect behavior
//
// DUAL-WRITE: addMenuItem / updateMenuItem / deleteMenuItem also
// sync to Supabase so both dine-in POS (GAS/Sheets) and the
// online order page (Supabase) stay in sync automatically.
// ══════════════════════════════════════════════════════════════

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzprf6_LpDwcVujm8kcGFZE5JdkL0k9b6Wfg5l82gjZzFua8w1QWH8UoFFlhznc6EtL/exec';

const SUPABASE_URL = 'https://hnynvclpvfxzlfjphefj.supabase.co';
// Use secret key (env var) for server-side ops — bypasses RLS for menu management
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_ANON_KEY || 'sb_publishable_PQBb1nDY7U7SxNfgDYoXyg_GtoLowLM';

// ── Category name → Supabase UUID map ─────────────────────────────────────
// These are the fixed category IDs from the menu_categories table.
const CATEGORY_MAP = {
  'COLD BEVERAGE': 'dc95fd8d-ba61-4171-90aa-3707fbb4bdf5',
  'COFFEE':        'ba50e0a2-b99a-4481-800d-c8e962d95b43',
  'PASTRY':        '228b02da-1a81-46e4-aae2-794b5c88a990',
  'SODA':          'd0fb0824-2b84-4889-9441-eeeaee11cd51',
  'FOOD':          '4a072720-dc18-4065-9aa9-d8437bf01038',
};

function getCategoryId(categoryName) {
  if (!categoryName) return null;
  const upper = String(categoryName).trim().toUpperCase();
  return CATEGORY_MAP[upper] || null;
}

// ── Supabase helper ────────────────────────────────────────────────────────
async function supabaseRequest(method, table, body, params, preferOverride) {
  let url = `${SUPABASE_URL}/rest/v1/${table}`;
  if (params) {
    const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    url += '?' + qs;
  }
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': preferOverride || (method === 'POST' ? 'return=representation' : 'return=minimal'),
  };
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(url, opts);
  const text = await resp.text();
  try { return { ok: resp.ok, status: resp.status, data: JSON.parse(text) }; }
  catch { return { ok: resp.ok, status: resp.status, data: text }; }
}

// ── Sync a new menu item to Supabase ──────────────────────────────────────
async function syncAddToSupabase(payload, gasItemId) {
  try {
    const categoryId = getCategoryId(payload.category);
    // Normalise image_path: if it's a full URL keep as-is, otherwise use as path
    let imagePath = payload.image || null;

    const row = {
      item_code:        gasItemId || payload.itemId || null,
      name:             payload.name,
      category_id:      categoryId,
      base_price:       parseFloat(payload.price) || 0,
      has_sizes:        !!payload.hasSizes,
      has_sugar_levels: !!payload.hasSugar,
      price_short:      parseFloat(payload.priceShort) || null,
      price_medium:     parseFloat(payload.priceMedium) || null,
      price_tall:       parseFloat(payload.priceTall) || null,
      image_path:       imagePath,
      is_active:        (payload.status || 'ACTIVE').toUpperCase() === 'ACTIVE',
    };

    const result = await supabaseRequest('POST', 'menu_items', row);
    if (!result.ok) {
      console.warn('Supabase addMenuItem sync failed:', result.status, JSON.stringify(result.data));
    }
    return result;
  } catch (e) {
    console.warn('Supabase addMenuItem sync error:', e.message);
    return { ok: false };
  }
}

// ── Sync an updated menu item to Supabase ─────────────────────────────────
async function syncUpdateToSupabase(payload) {
  try {
    const itemCode = payload.itemId;
    if (!itemCode) return;

    const updates = {};
    if (payload.name      !== undefined) updates.name             = payload.name;
    if (payload.category  !== undefined) updates.category_id      = getCategoryId(payload.category);
    if (payload.price     !== undefined) updates.base_price        = parseFloat(payload.price) || 0;
    if (payload.hasSizes  !== undefined) updates.has_sizes         = !!payload.hasSizes;
    if (payload.hasSugar  !== undefined) updates.has_sugar_levels  = !!payload.hasSugar;
    if (payload.priceShort  !== undefined) updates.price_short     = parseFloat(payload.priceShort) || null;
    if (payload.priceMedium !== undefined) updates.price_medium    = parseFloat(payload.priceMedium) || null;
    if (payload.priceTall   !== undefined) updates.price_tall      = parseFloat(payload.priceTall) || null;
    if (payload.image     !== undefined) updates.image_path        = payload.image || null;
    if (payload.status    !== undefined) updates.is_active         = (payload.status || 'ACTIVE').toUpperCase() === 'ACTIVE';

    if (Object.keys(updates).length === 0) return;

    const result = await supabaseRequest('PATCH', 'menu_items', updates, { item_code: `eq.${itemCode}` });
    if (!result.ok) {
      console.warn('Supabase updateMenuItem sync failed:', result.status, JSON.stringify(result.data));
    }
    return result;
  } catch (e) {
    console.warn('Supabase updateMenuItem sync error:', e.message);
    return { ok: false };
  }
}

// ── Sync a deleted (deactivated) menu item to Supabase ────────────────────
async function syncDeleteToSupabase(itemCode) {
  try {
    if (!itemCode) return;
    const result = await supabaseRequest('PATCH', 'menu_items', { is_active: false }, { item_code: `eq.${itemCode}` });
    if (!result.ok) {
      console.warn('Supabase deleteMenuItem sync failed:', result.status, JSON.stringify(result.data));
    }
    return result;
  } catch (e) {
    console.warn('Supabase deleteMenuItem sync error:', e.message);
    return { ok: false };
  }
}

// ── Forward request to Apps Script ────────────────────────────────────────
async function callAppsScript(body) {
  const postResponse = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'manual'
  });

  let responseText;
  if (postResponse.status === 302 || postResponse.status === 301) {
    const redirectUrl = postResponse.headers.get('location');
    if (!redirectUrl) throw new Error('Backend redirect missing location');
    const getResponse = await fetch(redirectUrl, { method: 'GET', redirect: 'follow' });
    responseText = await getResponse.text();
  } else {
    responseText = await postResponse.text();
  }

  try {
    return JSON.parse(responseText);
  } catch (e) {
    console.error('Apps Script returned non-JSON:', responseText.substring(0, 300));
    throw new Error('Backend returned invalid response');
  }
}

// ── Main handler ──────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    const body = req.body;
    if (!body || !body.action) return res.status(400).json({ ok: false, error: 'Missing action' });

    const action = body.action;

    // ── Special: direct Supabase upsert (for backfilling existing GAS items) ─
    if (action === 'upsertToSupabase') {
      const categoryId = getCategoryId(body.category);
      const row = {
        item_code:        body.itemId,
        name:             body.name,
        category_id:      categoryId,
        base_price:       parseFloat(body.price) || 0,
        has_sizes:        !!body.hasSizes,
        has_sugar_levels: !!body.hasSugar,
        price_short:      parseFloat(body.priceShort) || null,
        price_medium:     parseFloat(body.priceMedium) || null,
        price_tall:       parseFloat(body.priceTall) || null,
        image_path:       body.image || null,
        is_active:        (body.status || 'ACTIVE').toUpperCase() === 'ACTIVE',
      };
      const result = await supabaseRequest('POST', 'menu_items', row,
        null, 'resolution=merge-duplicates');
      return res.status(200).json({ ok: result.ok, data: result.data });
    }

    // ── Forward to Apps Script first ──────────────────────────────────────
    let gasResult;
    try {
      gasResult = await callAppsScript(body);
    } catch (err) {
      return res.status(502).json({ ok: false, error: err.message });
    }

    // ── Dual-write: sync menu changes to Supabase ─────────────────────────
    if (gasResult && gasResult.ok) {
      if (action === 'addMenuItem') {
        // GAS returns the generated itemId in gasResult.itemId
        const gasItemId = gasResult.itemId || body.itemId || null;
        syncAddToSupabase(body, gasItemId).catch(() => {});
      } else if (action === 'updateMenuItem') {
        syncUpdateToSupabase(body).catch(() => {});
      } else if (action === 'deleteMenuItem') {
        syncDeleteToSupabase(body.itemId).catch(() => {});
      }
    }

    return res.status(200).json(gasResult);

  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(500).json({ ok: false, error: 'Server error: ' + err.message });
  }
}
