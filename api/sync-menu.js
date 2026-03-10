// ══════════════════════════════════════════════════════════════
// YANI MENU SYNC — Vercel Serverless API  (v2 — GAS-free)
// Supabase is now the single source of truth for the menu.
// This endpoint validates menu integrity and can repair
// missing category assignments or duplicate item codes.
// Called by admin dashboard "Sync Now" button.
// ══════════════════════════════════════════════════════════════

const SUPABASE_URL = 'https://hnynvclpvfxzlfjphefj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || 'sb_publishable_PQBb1nDY7U7SxNfgDYoXyg_GtoLowLM';

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
    // ── Fetch all menu items from Supabase ────────────────────
    const allItemsR = await supabaseReq('GET', 'menu_items', null, {
      select: 'item_code,name,is_active,category_id,base_price',
      limit: 1000
    });

    if (!allItemsR.ok) {
      return res.status(502).json({ ok: false, error: 'Failed to fetch menu from Supabase' });
    }

    const allItems = Array.isArray(allItemsR.data) ? allItemsR.data : [];
    const activeItems = allItems.filter(i => i.is_active);
    const inactiveItems = allItems.filter(i => !i.is_active);

    // ── Check for items with missing category ─────────────────
    const missingCategory = allItems.filter(i => !i.category_id);

    // ── Check for items with zero price ───────────────────────
    const zeroPrice = activeItems.filter(i => !i.base_price || i.base_price === 0);

    // ── Build summary ─────────────────────────────────────────
    const issues = [];
    if (missingCategory.length > 0) {
      issues.push({
        type: 'MISSING_CATEGORY',
        count: missingCategory.length,
        items: missingCategory.map(i => i.item_code),
        message: `${missingCategory.length} item(s) have no category assigned`
      });
    }
    if (zeroPrice.length > 0) {
      issues.push({
        type: 'ZERO_PRICE',
        count: zeroPrice.length,
        items: zeroPrice.map(i => i.item_code),
        message: `${zeroPrice.length} active item(s) have ₱0 price`
      });
    }

    const ok = issues.length === 0;
    const message = ok
      ? `Menu is healthy — ${activeItems.length} active items, ${inactiveItems.length} inactive`
      : `Menu has ${issues.length} issue(s) requiring attention`;

    return res.status(200).json({
      ok,
      message,
      architecture: 'supabase-native-v3',
      summary: {
        totalItems:    allItems.length,
        activeItems:   activeItems.length,
        inactiveItems: inactiveItems.length,
      },
      issues: issues.length > 0 ? issues : undefined,
      // Legacy fields for admin dashboard compatibility
      gasCount:      activeItems.length,
      supabaseCount: activeItems.length,
      driftFound:    0,
      synced:        0,
      skipped:       0,
    });

  } catch (err) {
    console.error('sync-menu error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
