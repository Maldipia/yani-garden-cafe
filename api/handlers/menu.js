// ── Menu action handlers ──────────────────────────────────────────────────
import { supaFetch, supa, auditLog, logSync } from '../lib/db.js';
import { menuCache, MENU_CACHE_TTL, MENU_CACHE_TTL_ADMIN, invalidateMenuCache, _settingsCache, SETTINGS_CACHE_TTL } from '../lib/cache.js';
import { getCategoryId, getCategoryName, CATEGORY_ID_TO_NAME } from '../lib/categories.js';
import { isNonEmptyString, isValidItemCode, validateMenuPayload } from '../lib/validation.js';
import { SUPABASE_URL, BUSINESS_NAME, SERVICE_CHARGE_RATE } from '../lib/config.js';

export async function routeMenu(action, body, auth, req, res) {
  const { checkAuth, checkAdminAuth, jwtUser } = auth;

    if (action === 'getMenu') {
      const now = Date.now();
      if (menuCache.public && (now - menuCache.tsPublic) < MENU_CACHE_TTL) {
        return res.status(200).json({ ok: true, items: menuCache.public, cached: true });
      }
      // Fetch from DB with 5-second timeout — if DB is slow, fall back to stale cache
      let r;
      try {
        const ctrl = new AbortController();
        const timeoutId = setTimeout(() => ctrl.abort(), 5000);
        r = await supaFetch(
          `${SUPABASE_URL}/rest/v1/menu_items?is_active=eq.true&order=name.asc&select=item_code,name,base_price,has_sizes,has_sugar_levels,price_short,price_medium,price_tall,image_path,category_id,is_signature,available_from,available_until,available_days`,
          { signal: ctrl.signal }
        );
        clearTimeout(timeoutId);
      } catch (e) {
        console.error('getMenu DB fetch failed:', e.message);
        r = { ok: false };
      }
      if (!r.ok) {
        // STALE-WHILE-ERROR: if we have ANY cached menu (even old), serve it
        if (menuCache.public) {
          console.log('getMenu: DB failed, serving stale cache (' + Math.round((now - menuCache.tsPublic)/1000) + 's old)');
          return res.status(200).json({ ok: true, items: menuCache.public, cached: true, stale: true });
        }
        return res.status(502).json({ ok: false, error: 'Failed to load menu' });
      }

      // Current PHT time for schedule filtering
      const nowPHT = new Date(Date.now() + 8*3600000);
      const curTime = nowPHT.getUTCHours().toString().padStart(2,'0') + ':' + nowPHT.getUTCMinutes().toString().padStart(2,'0');
      const curDay = ['SUN','MON','TUE','WED','THU','FRI','SAT'][nowPHT.getUTCDay()];

      const items = r.data.map(m => {
        // Schedule check
        let available = true;
        if (m.available_from && m.available_until) {
          available = curTime >= m.available_from && curTime <= m.available_until;
        }
        if (available && m.available_days && m.available_days.length > 0) {
          available = m.available_days.includes(curDay);
        }
        return {
          code:           m.item_code,
          name:           m.name,
          price:          m.base_price,
          hasSizes:       m.has_sizes,
          hasSugar:       m.has_sugar_levels,
          priceShort:     m.price_short,
          priceMedium:    m.price_medium,
          priceTall:      m.price_tall,
          image:          m.image_path || '',
          category:       getCategoryName(m.category_id),
          isSignature:    !!m.is_signature,
          hasCoffee:      !!m.has_coffee,
          hasTea:         !!m.has_tea,
          hasChocolate:   !!m.has_chocolate,
          hasMatcha:      !!m.has_matcha,
          hasCaffeine:    !!m.has_caffeine,
          isCaffeineFree: !!m.is_caffeine_free,
          isFood:         !!m.is_food,
          available,
          availableFrom:  m.available_from || null,
          availableUntil: m.available_until || null,
          availableDays:  m.available_days || null,
        };
      });
      menuCache.public = items;
      menuCache.tsPublic = now;
      return res.status(200).json({ ok: true, items });
    }

    // ── getMenuAdmin ───────────────────────────────────────────────────────
    if (action === 'getMenuAdmin') {
      const authMA = await checkAdminAuth();
      if (!authMA.ok) return res.status(403).json({ ok: false, error: authMA.error });
      const now = Date.now();
      if (menuCache.admin && (now - menuCache.tsAdmin) < MENU_CACHE_TTL_ADMIN) {
        return res.status(200).json({ ok: true, items: menuCache.admin, cached: true });
      }
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/menu_items?order=name.asc&select=item_code,name,base_price,has_sizes,has_sugar_levels,price_short,price_medium,price_tall,image_path,category_id,is_active,is_signature,available_from,available_until,available_days,has_coffee,has_tea,has_chocolate,has_matcha,has_caffeine,is_caffeine_free,is_food`
      );
      if (!r.ok) return res.status(502).json({ ok: false, error: 'Failed to load menu' });
      const items = r.data.map(m => ({
        code:           m.item_code,
        name:           m.name,
        price:          m.base_price,
        hasSizes:       m.has_sizes,
        hasSugar:       m.has_sugar_levels,
        priceShort:     m.price_short,
        priceMedium:    m.price_medium,
        priceTall:      m.price_tall,
        image:          m.image_path || '',
        category:       getCategoryName(m.category_id),
        active:         m.is_active,
        available:      m.is_active,
        status:         m.is_active ? 'ACTIVE' : 'INACTIVE',
        isSignature:    !!m.is_signature,
        availableFrom:  m.available_from || null,
        availableUntil: m.available_until || null,
        availableDays:  m.available_days || null,
      }));
      menuCache.admin = items;
      menuCache.tsAdmin = now;
      return res.status(200).json({ ok: true, items });
    }

    // ── addMenuItem ────────────────────────────────────────────────────────
    if (action === 'addMenuItem') {
      const authAdd = await checkAdminAuth();
      if (!authAdd.ok) return res.status(403).json({ ok: false, error: authAdd.error });
      if (!isNonEmptyString(body.name, 100) || body.name.trim().length < 2) {
        return res.status(400).json({ ok: false, error: 'name must be 2-100 characters' });
      }
      const errs = validateMenuPayload(body, false);
      if (errs.length) return res.status(400).json({ ok: false, error: errs.join('; ') });

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
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to add menu item: ' + JSON.stringify(r.data) });
      const newItem = Array.isArray(r.data) ? r.data[0] : r.data;
      invalidateMenuCache();
      logSync('menu_items', newItem?.item_code || body.itemId || 'new', 'INSERT');
      return res.status(200).json({ ok: true, itemId: newItem?.item_code || body.itemId });
    }

    // ── updateMenuItem ─────────────────────────────────────────────────────
    if (action === 'updateMenuItem') {
      const authUpd = await checkAdminAuth();
      if (!authUpd.ok) return res.status(403).json({ ok: false, error: authUpd.error });
      if (!isValidItemCode(body.itemId)) {
        return res.status(400).json({ ok: false, error: 'itemId is required and must be a valid item code' });
      }
      const errs = validateMenuPayload(body, false);
      if (errs.length) return res.status(400).json({ ok: false, error: errs.join('; ') });

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
      if (body.hasCoffee      !== undefined) updates.has_coffee       = !!body.hasCoffee;
      if (body.hasTea         !== undefined) updates.has_tea          = !!body.hasTea;
      if (body.hasChocolate   !== undefined) updates.has_chocolate    = !!body.hasChocolate;
      if (body.hasMatcha      !== undefined) updates.has_matcha       = !!body.hasMatcha;
      if (body.hasCaffeine    !== undefined) updates.has_caffeine     = !!body.hasCaffeine;
      if (body.isCaffeineFree !== undefined) updates.is_caffeine_free = !!body.isCaffeineFree;
      if (body.isFood         !== undefined) updates.is_food          = !!body.isFood;
      if (body.status      !== undefined) updates.is_active         = (body.status || 'ACTIVE').toUpperCase() === 'ACTIVE';
      if (body.isSignature !== undefined) updates.is_signature      = !!body.isSignature;
      // Menu scheduling fields
      if (body.availableFrom  !== undefined) updates.available_from  = body.availableFrom  || null;
      if (body.availableUntil !== undefined) updates.available_until = body.availableUntil || null;
      if (body.availableDays  !== undefined) updates.available_days  = (body.availableDays && body.availableDays.length) ? body.availableDays : null;
      if (Object.keys(updates).length === 0) return res.status(200).json({ ok: true });

      const r = await supa('PATCH', 'menu_items', updates, { item_code: `eq.${body.itemId}` });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to update menu item' });
      invalidateMenuCache();
      logSync('menu_items', body.itemId, 'UPDATE');
      return res.status(200).json({ ok: true });
    }

    // ── deleteMenuItem ─────────────────────────────────────────────────────
    if (action === 'deleteMenuItem') {
      const authDel = await checkAdminAuth();
      if (!authDel.ok) return res.status(403).json({ ok: false, error: authDel.error });
      if (!isValidItemCode(body.itemId)) {
        return res.status(400).json({ ok: false, error: 'itemId is required and must be a valid item code' });
      }
      // Hard delete — permanently removes menu item. Order items store snapshots so no FK risk.
      const r = await supa('DELETE', 'menu_items', null, { item_code: `eq.${body.itemId}` });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to delete menu item' });
      invalidateMenuCache();
      logSync('menu_items', body.itemId, 'DELETE');
      return res.status(200).json({ ok: true });
    }

    // ── upsertToSupabase (backfill helper — ADMIN/OWNER only) ──────────────
    // NOTE: is_active is intentionally EXCLUDED here. Active/inactive status
    // must only change via quickToggleItem (admin UI) or direct SQL.
    // Including is_active here caused GAS Sheets sync to silently deactivate
    // items whenever the Sheet had them stored as INACTIVE.
    if (action === 'upsertToSupabase') {
      const authUps = await checkAdminAuth();
      if (!authUps.ok) return res.status(403).json({ ok: false, error: authUps.error });
      if (!isValidItemCode(body.itemId)) {
        return res.status(400).json({ ok: false, error: 'itemId is required' });
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
        // is_active deliberately NOT included — toggle only via quickToggleItem
      };
      const r = await supa('POST', 'menu_items', row, null, 'resolution=merge-duplicates');
      return res.status(200).json({ ok: r.ok, data: r.data });
    }

    // ══════════════════════════════════════════════════════════════════════
    // ORDER ACTIONS
    // ══════════════════════════════════════════════════════════════════════

    // ── placeOrder ─────────────────────────────────────────────────────────

  return false;
}
