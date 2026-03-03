// ══════════════════════════════════════════════════════════════
// YANI MENU SYNC — Vercel Serverless API
// Detects drift between GAS (Google Sheets) and Supabase menu,
// then auto-repairs by upserting missing items into Supabase.
// Called by admin dashboard "Sync Now" button or health monitor.
// ══════════════════════════════════════════════════════════════

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzprf6_LpDwcVujm8kcGFZE5JdkL0k9b6Wfg5l82gjZzFua8w1QWH8UoFFlhznc6EtL/exec';
const SUPABASE_URL    = 'https://hnynvclpvfxzlfjphefj.supabase.co';
const SUPABASE_KEY    = process.env.SUPABASE_SECRET_KEY || 'sb_publishable_PQBb1nDY7U7SxNfgDYoXyg_GtoLowLM';

const CATEGORY_MAP = {
  'COLD BEVERAGE': 'dc95fd8d-ba61-4171-90aa-3707fbb4bdf5',
  'COFFEE':        'ba50e0a2-b99a-4481-800d-c8e962d95b43',
  'PASTRY':        '228b02da-1a81-46e4-aae2-794b5c88a990',
  'SODA':          'd0fb0824-2b84-4889-9441-eeeaee11cd51',
  'FOOD':          '4a072720-dc18-4065-9aa9-d8437bf01038',
};

function getCategoryId(name) {
  if (!name) return null;
  return CATEGORY_MAP[String(name).trim().toUpperCase()] || null;
}

async function supabaseReq(method, path, body, params, prefer) {
  let url = `${SUPABASE_URL}/rest/v1/${path}`;
  if (params) url += '?' + new URLSearchParams(params).toString();
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': prefer || (method === 'POST' ? 'return=representation' : 'return=minimal')
  };
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; }
  catch { return { ok: res.ok, status: res.status, data: text }; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // ── Step 1: Fetch all items from GAS ─────────────────────
    let gasItems = [];
    try {
      const gasResp = await fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'getMenuAdmin' }),
        redirect: 'follow'
      });
      if (gasResp.ok) {
        const text = await gasResp.text();
        const data = JSON.parse(text);
        gasItems = Array.isArray(data.items) ? data.items : [];
      }
    } catch (e) {
      return res.status(502).json({ ok: false, error: 'Could not reach GAS: ' + e.message });
    }

    if (!gasItems.length) {
      return res.status(200).json({ ok: true, message: 'GAS returned 0 items — nothing to sync', synced: 0, skipped: 0 });
    }

    // ── Step 2: Fetch all item_codes from Supabase ────────────
    const sbResult = await supabaseReq('GET', 'menu_items', null, {
      select: 'item_code',
      limit: 1000
    });
    const existingCodes = new Set(
      (Array.isArray(sbResult.data) ? sbResult.data : []).map(r => r.item_code).filter(Boolean)
    );

    // ── Step 3: Find GAS items missing from Supabase ──────────
    const missing = gasItems.filter(item => item.code && !existingCodes.has(item.code));
    const driftCount = missing.length;

    if (driftCount === 0) {
      return res.status(200).json({
        ok: true,
        message: 'Menu is in sync — no drift detected',
        gasCount: gasItems.length,
        supabaseCount: existingCodes.size,
        synced: 0,
        skipped: 0
      });
    }

    // ── Step 4: Upsert missing items into Supabase ────────────
    let synced = 0;
    let skipped = 0;
    const errors = [];

    for (const item of missing) {
      try {
        const row = {
          item_code:        item.code,
          name:             item.name,
          category_id:      getCategoryId(item.category),
          base_price:       parseFloat(item.price) || 0,
          has_sizes:        !!item.hasSizes,
          has_sugar_levels: !!item.hasSugar,
          price_short:      item.priceShort  ? parseFloat(item.priceShort)  : null,
          price_medium:     item.priceMedium ? parseFloat(item.priceMedium) : null,
          price_tall:       item.priceTall   ? parseFloat(item.priceTall)   : null,
          image_path:       item.image || null,
          is_active:        item.status ? item.status.toUpperCase() === 'ACTIVE' : true
        };
        const result = await supabaseReq('POST', 'menu_items', row, null, 'resolution=merge-duplicates');
        if (result.ok) {
          synced++;
        } else {
          skipped++;
          errors.push({ code: item.code, error: JSON.stringify(result.data) });
        }
      } catch (e) {
        skipped++;
        errors.push({ code: item.code, error: e.message });
      }
    }

    return res.status(200).json({
      ok: true,
      message: `Sync complete: ${synced} item(s) added to Supabase, ${skipped} skipped`,
      gasCount: gasItems.length,
      supabaseCount: existingCodes.size,
      driftFound: driftCount,
      synced,
      skipped,
      errors: errors.length ? errors : undefined
    });

  } catch (err) {
    console.error('sync-menu error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
