// api/handlers/menu.js
// Actions: getMenu, getMenuAdmin, addMenuItem, updateMenuItem, deleteMenuItem, upsertToSupabase
// Returns [statusCode, responseData] or null (not handled)

export async function handle_menu(action, ctx) {
  const { body, jwtUser, checkAuth, supa, supaFetch, auditLog, getSetting,
          SUPABASE_URL, SUPABASE_KEY, SERVICE_CHARGE_RATE, ORDER_PREFIX } = ctx;

  // Fast path — skip if not our action
  const _owns = ['getMenu', 'getMenuAdmin', 'addMenuItem', 'updateMenuItem', 'deleteMenuItem', 'upsertToSupabase'];
  if (!_owns.includes(action)) return null;

    // MENU ACTIONS
    // ══════════════════════════════════════════════════════════════════════

    // ── getMenu ────────────────────────────────────────────────────────────
    if (action === 'getMenu') {
      const now = Date.now();
      if (menuCache.public && (now - menuCache.ts) < MENU_CACHE_TTL) {
        return [200, { ok: true, items: menuCache.public, cached: true }];
      }
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/menu_items?is_active=eq.true&order=name.asc&select=item_code,name,base_price,has_sizes,has_sugar_levels,price_short,price_medium,price_tall,image_path,category_id,is_signature`
      );
      if (!r.ok) return [502, { ok: false, error: 'Failed to load menu' }];
      const items = r.data.map(m => ({
        code:        m.item_code,
        name:        m.name,
        price:       m.base_price,
        hasSizes:    m.has_sizes,
        hasSugar:    m.has_sugar_levels,
        priceShort:  m.price_short,
        priceMedium: m.price_medium,
        priceTall:   m.price_tall,
        image:       m.image_path || '',
        category:    getCategoryName(m.category_id),
        isSignature: !!m.is_signature,
        available:   true,
      }));
      menuCache.public = items;
      menuCache.ts = now;
      return [200, { ok: true, items }];
    }

    // ── getMenuAdmin ───────────────────────────────────────────────────────
    if (action === 'getMenuAdmin') {
      const authMA = await checkAdminAuth();
      if (!authMA.ok) return [403, { ok: false, error: authMA.error }];
      const now = Date.now();
      if (menuCache.admin && (now - menuCache.ts) < MENU_CACHE_TTL) {
        return [200, { ok: true, items: menuCache.admin, cached: true }];
      }
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/menu_items?order=name.asc&select=item_code,name,base_price,has_sizes,has_sugar_levels,price_short,price_medium,price_tall,image_path,category_id,is_active,is_signature`
      );
      if (!r.ok) return [502, { ok: false, error: 'Failed to load menu' }];
      const items = r.data.map(m => ({
        code:        m.item_code,
        name:        m.name,
        price:       m.base_price,
        hasSizes:    m.has_sizes,
        hasSugar:    m.has_sugar_levels,
        priceShort:  m.price_short,
        priceMedium: m.price_medium,
        priceTall:   m.price_tall,
        image:       m.image_path || '',
        category:    getCategoryName(m.category_id),
        active:      m.is_active,
        available:   m.is_active,
        status:      m.is_active ? 'ACTIVE' : 'INACTIVE',
        isSignature: !!m.is_signature,
      }));
      menuCache.admin = items;
      menuCache.ts = now;
      return [200, { ok: true, items }];
    }

    // ── addMenuItem ────────────────────────────────────────────────────────
    if (action === 'addMenuItem') {
      const authAdd = await checkAdminAuth();
      if (!authAdd.ok) return [403, { ok: false, error: authAdd.error }];
      if (!isNonEmptyString(body.name, 100) || body.name.trim().length < 2) {
        return [400, { ok: false, error: 'name must be 2-100 characters' }];
      }
      const errs = validateMenuPayload(body, false);
      if (errs.length) return [400, { ok: false, error: errs.join('; ') }];

      // Auto-generate item_code if not provided (format: ITEM_<timestamp>)
      const autoCode = 'ITEM_' + Date.now();
      const row = {
        item_code:        body.itemId || autoCode,
        name:             body.name.trim(),
        category_id:      getCategoryId(body.category),
        base_price:       parseFloat(body.price) || 0,
        has_sizes:        !!body.hasSizes,
        has_sugar_levels: !!body.hasSugar,
        price_short:      body.priceShort  != null ? parseFloat(body.priceShort)  : null,
        price_medium:     body.priceMedium != null ? parseFloat(body.priceMedium) : null,
        price_tall:       body.priceTall   != null ? parseFloat(body.priceTall)   : null,
        image_path:       body.image || null,
        is_active:        (body.status || 'ACTIVE').toUpperCase() === 'ACTIVE',
        is_signature:     !!body.isSignature,
      };
      const r = await supa('POST', 'menu_items', row);
      if (!r.ok) return [500, { ok: false, error: 'Failed to add menu item: ' + JSON.stringify(r.data) }];
      const newItem = Array.isArray(r.data) ? r.data[0] : r.data;
      invalidateMenuCache();
      logSync('menu_items', newItem?.item_code || body.itemId || 'new', 'INSERT');
      return [200, { ok: true, itemId: newItem?.item_code || body.itemId }];
    }

    // ── updateMenuItem ─────────────────────────────────────────────────────
    if (action === 'updateMenuItem') {
      const authUpd = await checkAdminAuth();
      if (!authUpd.ok) return [403, { ok: false, error: authUpd.error }];
      if (!isValidItemCode(body.itemId)) {
        return [400, { ok: false, error: 'itemId is required and must be a valid item code' }];
      }
      const errs = validateMenuPayload(body, false);
      if (errs.length) return [400, { ok: false, error: errs.join('; ') }];

      const updates = {};
      if (body.name      !== undefined) updates.name             = body.name;
      if (body.category  !== undefined) updates.category_id      = getCategoryId(body.category);
      if (body.price     !== undefined) updates.base_price        = parseFloat(body.price) || 0;
      if (body.hasSizes  !== undefined) updates.has_sizes         = !!body.hasSizes;
      if (body.hasSugar  !== undefined) updates.has_sugar_levels  = !!body.hasSugar;
      if (body.priceShort  !== undefined) updates.price_short     = body.priceShort  != null ? parseFloat(body.priceShort)  : null;
      if (body.priceMedium !== undefined) updates.price_medium    = body.priceMedium != null ? parseFloat(body.priceMedium) : null;
      if (body.priceTall   !== undefined) updates.price_tall      = body.priceTall   != null ? parseFloat(body.priceTall)   : null;
      if (body.image     !== undefined) updates.image_path        = body.image || null;
      if (body.status      !== undefined) updates.is_active         = (body.status || 'ACTIVE').toUpperCase() === 'ACTIVE';
      if (body.isSignature !== undefined) updates.is_signature      = !!body.isSignature;
      if (Object.keys(updates).length === 0) return [200, { ok: true }];

      const r = await supa('PATCH', 'menu_items', updates, { item_code: `eq.${body.itemId}` });
      if (!r.ok) return [500, { ok: false, error: 'Failed to update menu item' }];
      invalidateMenuCache();
      logSync('menu_items', body.itemId, 'UPDATE');
      return [200, { ok: true }];
    }

    // ── deleteMenuItem ─────────────────────────────────────────────────────
    if (action === 'deleteMenuItem') {
      const authDel = await checkAdminAuth();
      if (!authDel.ok) return [403, { ok: false, error: authDel.error }];
      if (!isValidItemCode(body.itemId)) {
        return [400, { ok: false, error: 'itemId is required and must be a valid item code' }];
      }
      // Hard delete — permanently removes menu item. Order items store snapshots so no FK risk.
      const r = await supa('DELETE', 'menu_items', null, { item_code: `eq.${body.itemId}` });
      if (!r.ok) return [500, { ok: false, error: 'Failed to delete menu item' }];
      invalidateMenuCache();
      logSync('menu_items', body.itemId, 'DELETE');
      return [200, { ok: true }];
    }

    // ── upsertToSupabase (backfill helper — ADMIN/OWNER only) ──────────────
    if (action === 'upsertToSupabase') {
      const authUps = await checkAdminAuth();
      if (!authUps.ok) return [403, { ok: false, error: authUps.error }];
      if (!isValidItemCode(body.itemId)) {
        return [400, { ok: false, error: 'itemId is required' }];
      }
      const row = {
        item_code:        body.itemId,
        name:             body.name,
        category_id:      getCategoryId(body.category),
        base_price:       parseFloat(body.price) || 0,
        has_sizes:        !!body.hasSizes,
        has_sugar_levels: !!body.hasSugar,
        price_short:      parseFloat(body.priceShort) || null,
        price_medium:     parseFloat(body.priceMedium) || null,
        price_tall:       parseFloat(body.priceTall) || null,
        image_path:       body.image || null,
        is_active:        (body.status || 'ACTIVE').toUpperCase() === 'ACTIVE',
      };
      const r = await supa('POST', 'menu_items', row, null, 'resolution=merge-duplicates');
      return [200, { ok: r.ok, data: r.data }];
    }

    // ══════════════════════════════════════════════════════════════════════
  return null;
}
