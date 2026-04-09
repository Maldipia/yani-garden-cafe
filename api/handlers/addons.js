// api/handlers/addons.js — getAddons, getAddonsAdmin, saveAddon, deleteAddon

export async function handle_addons(action, ctx) {
  const {
    action, body, jwtUser, checkAuth,
    supa, supaFetch, auditLog, getSetting, sendReceiptEmail,
    isNonEmptyString, isValidItemCode, isValidOrderId,
    validateMenuPayload, getCategoryId, getCategoryName,
    logSync, pushToSheets, invalidateMenuCache, signToken, uploadToGoogleDrive,
    SUPABASE_URL, SUPABASE_KEY, SERVICE_CHARGE_RATE, ORDER_PREFIX,
    menuCache, MENU_CACHE_TTL,
  } = ctx;
  const _owns = ['getAddons', 'getAddonsAdmin', 'saveAddon', 'deleteAddon'];
  if (!_owns.includes(action)) return null;

    // ADD-ONS / MODIFIERS
    // ══════════════════════════════════════════════════════════════════════

    // ── getAddons ──────────────────────────────────────────────────────────
    if (action === 'getAddons') {
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/menu_addons?is_active=eq.true&order=sort_order.asc,name.asc`
      );
      return [200, { ok: r.ok, addons: r.data || [] }];
    }

    // ── getAddonsAdmin ─────────────────────────────────────────────────────
    if (action === 'getAddonsAdmin') {
      const auth = await checkAdminAuth();
      if (!auth.ok) return [403, { ok: false, error: auth.error }];
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/menu_addons?order=sort_order.asc,name.asc`
      );
      return [200, { ok: r.ok, addons: r.data || [] }];
    }

    // ── saveAddon ──────────────────────────────────────────────────────────
    if (action === 'saveAddon') {
      const auth = await checkAdminAuth();
      if (!auth.ok) return [403, { ok: false, error: auth.error }];
      const { addonCode, name, price, appliesToAll, appliesToCodes, sortOrder } = body;
      if (!name) return [400, { ok: false, error: 'name required' }];
      const code = addonCode || 'ADD-' + Date.now();
      const row = {
        addon_code: code, name: String(name).trim().substring(0, 80),
        price: parseFloat(price) || 0,
        applies_to_all: appliesToAll !== false,
        applies_to_codes: Array.isArray(appliesToCodes) ? appliesToCodes : [],
        is_active: body.isActive !== false,
        sort_order: parseInt(sortOrder) || 0,
        updated_at: new Date().toISOString(),
      };
      const method = addonCode ? 'PATCH' : 'POST';
      const url = addonCode
        ? `${SUPABASE_URL}/rest/v1/menu_addons?addon_code=eq.${encodeURIComponent(addonCode)}`
        : `${SUPABASE_URL}/rest/v1/menu_addons`;
      const r = await supaFetch(url, { method, body: JSON.stringify(row),
        headers: method === 'POST' ? { Prefer: 'return=representation' } : {} });
      if (!r.ok) return [500, { ok: false, error: 'Failed to save addon' }];
      return [200, { ok: true, addon: method === 'POST' ? r.data?.[0] : row }];
    }

    // ── deleteAddon ────────────────────────────────────────────────────────
    if (action === 'deleteAddon') {
      const auth = await checkAdminAuth();
      if (!auth.ok) return [403, { ok: false, error: auth.error }];
      const { addonCode } = body;
      if (!addonCode) return [400, { ok: false, error: 'addonCode required' }];
      // Soft delete
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/menu_addons?addon_code=eq.${encodeURIComponent(addonCode)}`,
        { method: 'PATCH', body: JSON.stringify({ is_active: false, updated_at: new Date().toISOString() }) }
      );
      return [200, { ok: r.ok }];
    }

    // ══════════════════════════════════════════════════════════════════════
  return null;
}
