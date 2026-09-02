// ── INVENTORY & PRODUCTION HANDLER (ESM) ─────────────────────────────────
// ISOLATED MODULE. Touches only inv_* tables + the inv_menu_map bridge.
// Never writes to menu_items, dine_in_orders, inventory, costing_* or any
// other pre-existing table. Feature-flagged via inv_config.module_enabled.
// ─────────────────────────────────────────────────────────────────────────
import { supaFetch, supa } from '../lib/db.js';
import { SUPABASE_URL }    from '../lib/config.js';

const INV_ACTIONS = new Set([
  // meta
  'invGetConfig','invSetConfig','invGetRefData',
  // items
  'invListItems','invSaveItem','invArchiveItem',
  // recipes
  'invListRecipes','invSaveRecipe','invArchiveRecipe',
  // stock
  'invReceiveStock','invListStockUnits','invStockUnitHistory',
  'invAdjustStock','invConsumeOverride','invConsumptionQueue',
  // production / portioning
  'invProduce','invListProductionBatches','invPortion',
  // sale bridge
  'invConsumeOrder','invListMenuMap','invSaveMenuMap',
  // reports
  'invDashboard','invLowStock','invExpiringSoon','invTransactions',
]);

// ── helpers ──────────────────────────────────────────────────────────────
async function rpc(fn, args) {
  return supaFetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    body: JSON.stringify(args || {}),
  });
}
const q    = (s) => encodeURIComponent(String(s));
const num  = (v) => (v === null || v === undefined || v === '' ? null : parseFloat(v));
const int  = (v) => (v === null || v === undefined || v === '' ? null : parseInt(v, 10));
const str  = (v, max = 300) => (v === null || v === undefined ? null : String(v).trim().substring(0, max));
const bad  = (res, msg)  => res.status(400).json({ ok: false, error: msg });
const boom = (res, msg)  => res.status(500).json({ ok: false, error: msg });

// RPCs return jsonb {ok:...}. Surface business failures as 400, not 500.
function rpcResult(res, r, fallback) {
  if (!r.ok) return boom(res, fallback || 'Database error');
  const d = r.data;
  if (d && typeof d === 'object' && d.ok === false) {
    return res.status(400).json(d);
  }
  return res.status(200).json(d && typeof d === 'object' ? d : { ok: true, data: d });
}

const ITEM_TYPES = ['RAW_MATERIAL','PURCHASED_READY','PREP','PRODUCED','PORTIONABLE'];
const ADJ_TYPES  = ['waste','adjust','transfer','count','return'];

export async function routeInventory(action, body, auth, req, res) {
  if (!INV_ACTIONS.has(action)) return false;
  const { checkAdminAuth } = auth;

  // Every inventory action is ADMIN/OWNER. No anon surface at all.
  const a = await checkAdminAuth();
  if (!a.ok) return res.status(403).json({ ok: false, error: a.error });
  const actor = a.userId || 'SYSTEM';
  const isOwner = a.role === 'OWNER';

  // ══ META ══════════════════════════════════════════════════════════════
  if (action === 'invGetConfig') {
    const r = await supaFetch(`${SUPABASE_URL}/rest/v1/inv_config?select=*&order=key.asc`);
    if (!r.ok) return boom(res, 'Failed to load config');
    const cfg = {};
    (r.data || []).forEach(c => { cfg[c.key] = c.value; });
    return res.status(200).json({ ok: true, config: cfg, rows: r.data || [] });
  }

  if (action === 'invSetConfig') {
    if (!isOwner) return res.status(403).json({ ok: false, error: 'OWNER only' });
    const key = str(body.key, 60);
    const value = str(body.value, 200);
    if (!key || value === null) return bad(res, 'key and value required');
    const r = await supa('PATCH', 'inv_config', { value, updated_at: new Date().toISOString() },
                         { key: `eq.${key}` });
    if (!r.ok) return boom(res, 'Failed to update config');
    return res.status(200).json({ ok: true, key, value });
  }

  if (action === 'invGetRefData') {
    const [u, l, s] = await Promise.all([
      supaFetch(`${SUPABASE_URL}/rest/v1/inv_units?is_active=eq.true&select=*&order=unit_type.asc,name.asc`),
      supaFetch(`${SUPABASE_URL}/rest/v1/inv_locations?is_active=eq.true&select=*&order=name.asc`),
      supaFetch(`${SUPABASE_URL}/rest/v1/inv_suppliers?is_active=eq.true&select=*&order=name.asc`),
    ]);
    return res.status(200).json({
      ok: true, units: u.data || [], locations: l.data || [], suppliers: s.data || [],
      itemTypes: ITEM_TYPES,
    });
  }

  // ══ ITEMS ═════════════════════════════════════════════════════════════
  if (action === 'invListItems') {
    const type = body.itemType && ITEM_TYPES.includes(body.itemType) ? body.itemType : null;
    let url = `${SUPABASE_URL}/rest/v1/inv_items?select=*,inv_units!inv_items_base_unit_id_fkey(name,unit_type)`;
    if (type) url += `&item_type=eq.${q(type)}`;
    if (body.activeOnly !== false) url += `&is_active=eq.true`;
    url += `&order=item_type.asc,name.asc`;
    const r = await supaFetch(url);
    if (!r.ok) return boom(res, 'Failed to load items');
    return res.status(200).json({ ok: true, items: r.data || [] });
  }

  if (action === 'invSaveItem') {
    const id = int(body.id);
    const name = str(body.name, 200);
    const itemType = body.itemType;
    const baseUnitId = int(body.baseUnitId);
    if (!name) return bad(res, 'name required');
    if (!ITEM_TYPES.includes(itemType)) return bad(res, `itemType must be one of ${ITEM_TYPES.join(', ')}`);
    if (!baseUnitId) return bad(res, 'baseUnitId required');

    const payload = {
      name, item_type: itemType, base_unit_id: baseUnitId,
      is_portionable: !!body.isPortionable,
      standard_yield: num(body.standardYield),
      description: str(body.description, 500),
      updated_at: new Date().toISOString(),
    };

    if (id) {
      const r = await supa('PATCH', 'inv_items', payload, { id: `eq.${id}` });
      if (!r.ok) return boom(res, 'Failed to update item');
      return res.status(200).json({ ok: true, id });
    }
    const code = str(body.itemCode, 60) || `INV-${Date.now()}`;
    const r = await supa('POST', 'inv_items', { ...payload, item_code: code });
    if (!r.ok) {
      if (r.status === 409) return bad(res, 'item_code already exists');
      return boom(res, 'Failed to create item');
    }
    return res.status(200).json({ ok: true, item: (r.data || [])[0] || null });
  }

  if (action === 'invArchiveItem') {
    if (!isOwner) return res.status(403).json({ ok: false, error: 'OWNER only' });
    const id = int(body.id);
    if (!id) return bad(res, 'id required');
    // archive, never hard delete — preserves the audit ledger
    const r = await supa('PATCH', 'inv_items', { is_active: false }, { id: `eq.${id}` });
    if (!r.ok) return boom(res, 'Failed to archive item');
    return res.status(200).json({ ok: true, id, archived: true });
  }

  // ══ RECIPES ═══════════════════════════════════════════════════════════
  if (action === 'invListRecipes') {
    const r = await supaFetch(
      `${SUPABASE_URL}/rest/v1/inv_recipes?select=*,inv_items!inv_recipes_item_id_fkey(item_code,name,item_type),` +
      `inv_recipe_ingredients(id,ingredient_item_id,quantity,unit_id,yield_loss_pct,notes)` +
      `&is_active=eq.true&order=name.asc`
    );
    if (!r.ok) return boom(res, 'Failed to load recipes');
    return res.status(200).json({ ok: true, recipes: r.data || [] });
  }

  if (action === 'invSaveRecipe') {
    const id = int(body.id);
    const itemId = int(body.itemId);
    const name = str(body.name, 200);
    const lines = Array.isArray(body.ingredients) ? body.ingredients : [];
    if (!name) return bad(res, 'name required');
    if (!itemId) return bad(res, 'itemId required');
    if (!lines.length) return bad(res, 'at least one ingredient required');

    for (const ln of lines) {
      if (!int(ln.ingredientItemId)) return bad(res, 'each ingredient needs ingredientItemId');
      if (!(num(ln.quantity) > 0))   return bad(res, 'each ingredient needs quantity > 0');
      if (!int(ln.unitId))           return bad(res, 'each ingredient needs unitId');
      if (int(ln.ingredientItemId) === itemId) return bad(res, 'a recipe cannot consume its own output');
    }

    const head = {
      item_id: itemId, name,
      yield_qty: num(body.yieldQty) || 1,
      yield_unit_id: int(body.yieldUnitId),
      yield_type: ['whole','weight','volume','count'].includes(body.yieldType) ? body.yieldType : 'count',
      notes: str(body.notes, 500),
      updated_at: new Date().toISOString(),
    };
    if (!head.yield_unit_id) return bad(res, 'yieldUnitId required');

    let recipeId = id;
    if (recipeId) {
      const up = await supa('PATCH', 'inv_recipes', head, { id: `eq.${recipeId}` });
      if (!up.ok) return boom(res, 'Failed to update recipe');
      const del = await supa('DELETE', 'inv_recipe_ingredients', null, { recipe_id: `eq.${recipeId}` });
      if (!del.ok) return boom(res, 'Failed to replace recipe lines');
    } else {
      const ins = await supa('POST', 'inv_recipes', head);
      if (!ins.ok) return boom(res, 'Failed to create recipe');
      recipeId = (ins.data || [])[0]?.id;
      if (!recipeId) return boom(res, 'Recipe id not returned');
    }

    const rows = lines.map(ln => ({
      recipe_id: recipeId,
      ingredient_item_id: int(ln.ingredientItemId),
      quantity: num(ln.quantity),
      unit_id: int(ln.unitId),
      yield_loss_pct: Math.min(Math.max(num(ln.yieldLossPct) || 0, 0), 99),
      notes: str(ln.notes, 300),
    }));
    const li = await supa('POST', 'inv_recipe_ingredients', rows);
    if (!li.ok) return boom(res, 'Failed to save recipe lines');
    return res.status(200).json({ ok: true, recipeId, lines: rows.length });
  }

  if (action === 'invArchiveRecipe') {
    const id = int(body.id);
    if (!id) return bad(res, 'id required');
    const r = await supa('PATCH', 'inv_recipes', { is_active: false }, { id: `eq.${id}` });
    if (!r.ok) return boom(res, 'Failed to archive recipe');
    return res.status(200).json({ ok: true, id, archived: true });
  }

  // ══ STOCK ═════════════════════════════════════════════════════════════
  if (action === 'invReceiveStock') {
    const itemId = int(body.itemId), qty = num(body.qty), unitId = int(body.unitId);
    if (!itemId) return bad(res, 'itemId required');
    if (!(qty > 0)) return bad(res, 'qty must be > 0');
    if (!unitId)  return bad(res, 'unitId required');
    const r = await rpc('inv_receive_stock', {
      p_item_id: itemId, p_qty: qty, p_unit_id: unitId,
      p_unit_cost: num(body.unitCost) || 0,
      p_supplier_id: int(body.supplierId),
      p_location_id: int(body.locationId),
      p_expiry: body.expiryDate || null,
      p_actor: actor,
      p_notes: str(body.notes, 500),
      p_expected_use: body.expectedUseDate || null,   // PLANNING ONLY — never deducts
      p_split_units: !!body.splitUnits,
    });
    return rpcResult(res, r, 'Receive failed');
  }

  if (action === 'invListStockUnits') {
    let url = `${SUPABASE_URL}/rest/v1/inv_stock_units?select=*,inv_items(item_code,name,item_type),` +
              `inv_units(name),inv_locations(name)`;
    if (int(body.itemId))    url += `&item_id=eq.${int(body.itemId)}`;
    if (int(body.locationId))url += `&location_id=eq.${int(body.locationId)}`;
    if (body.status)         url += `&status=eq.${q(body.status)}`;
    if (body.availableOnly)  url += `&quantity_remaining=gt.0`;
    url += `&order=date_received.desc,id.desc&limit=${Math.min(int(body.limit) || 200, 500)}`;
    const r = await supaFetch(url);
    if (!r.ok) return boom(res, 'Failed to load stock units');
    return res.status(200).json({ ok: true, stockUnits: r.data || [] });
  }

  if (action === 'invStockUnitHistory') {
    const id = int(body.stockUnitId);
    if (!id) return bad(res, 'stockUnitId required');
    const r = await supaFetch(
      `${SUPABASE_URL}/rest/v1/inv_stock_transactions?stock_unit_id=eq.${id}&select=*&order=performed_at.asc`
    );
    if (!r.ok) return boom(res, 'Failed to load history');
    return res.status(200).json({ ok: true, transactions: r.data || [] });
  }

  if (action === 'invConsumptionQueue') {
    let url = `${SUPABASE_URL}/rest/v1/inv_v_consumption_queue?select=*`;
    if (int(body.itemId)) url += `&item_id=eq.${int(body.itemId)}`;
    url += `&order=item_id.asc,consume_rank.asc&limit=200`;
    const r = await supaFetch(url);
    if (!r.ok) return boom(res, 'Failed to load queue');
    return res.status(200).json({ ok: true, queue: r.data || [] });
  }

  if (action === 'invAdjustStock') {
    const id = int(body.stockUnitId), type = body.adjustType;
    const qtyChange = num(body.qtyChange);
    if (!id) return bad(res, 'stockUnitId required');
    if (!ADJ_TYPES.includes(type)) return bad(res, `adjustType must be one of ${ADJ_TYPES.join(', ')}`);
    if (qtyChange === null || Number.isNaN(qtyChange)) return bad(res, 'qtyChange required');
    if (!str(body.reason, 300)) return bad(res, 'reason required — inventory is never changed silently');
    const r = await rpc('inv_adjust_stock_unit', {
      p_stock_unit_id: id, p_qty_change: qtyChange, p_type: type,
      p_actor: actor, p_notes: str(body.reason, 500),
    });
    return rpcResult(res, r, 'Adjustment failed');
  }

  if (action === 'invConsumeOverride') {
    const id = int(body.stockUnitId);
    if (!id) return bad(res, 'stockUnitId required');
    if (!(num(body.qty) > 0)) return bad(res, 'qty must be > 0');
    if (!int(body.unitId)) return bad(res, 'unitId required');
    if (!str(body.overrideReason, 300)) return bad(res, 'overrideReason required');
    const r = await rpc('inv_consume_from_unit', {
      p_stock_unit_id: id, p_qty: num(body.qty), p_unit_id: int(body.unitId),
      p_ref_type: str(body.refType, 40) || 'manual',
      p_ref_id: str(body.refId, 60),
      p_actor: actor, p_override_reason: str(body.overrideReason, 500),
    });
    return rpcResult(res, r, 'Override consume failed');
  }

  // ══ PRODUCTION ════════════════════════════════════════════════════════
  if (action === 'invProduce') {
    const recipeId = int(body.recipeId);
    const qty = num(body.qty) || 1;
    if (!recipeId) return bad(res, 'recipeId required');
    if (!(qty > 0)) return bad(res, 'qty must be > 0');
    // allowShortfall is OWNER-only: it lets production run past available stock
    const allowShortfall = !!body.allowShortfall && isOwner;
    const r = await rpc('inv_produce', {
      p_recipe_id: recipeId, p_qty_to_produce: qty, p_actor: actor,
      p_expiry: body.expiryDate || null,
      p_location_id: int(body.locationId),
      p_notes: str(body.notes, 500),
      p_allow_shortfall: allowShortfall,
      p_expected_use: body.expectedUseDate || null,
    });
    return rpcResult(res, r, 'Production failed');
  }

  if (action === 'invListProductionBatches') {
    const r = await supaFetch(
      `${SUPABASE_URL}/rest/v1/inv_production_batches?select=*,inv_items!inv_production_batches_produced_item_id_fkey(item_code,name)` +
      `&order=production_date.desc,id.desc&limit=${Math.min(int(body.limit) || 100, 300)}`
    );
    if (!r.ok) return boom(res, 'Failed to load production batches');
    return res.status(200).json({ ok: true, batches: r.data || [] });
  }

  // ══ PORTIONING ════════════════════════════════════════════════════════
  if (action === 'invPortion') {
    const id = int(body.stockUnitId), portions = num(body.portions);
    if (!id) return bad(res, 'stockUnitId required');
    if (!(portions > 0)) return bad(res, 'portions must be > 0');
    const r = await rpc('inv_portion', {
      p_stock_unit_id: id, p_portions: portions,
      p_actor: actor, p_notes: str(body.notes, 500),
    });
    return rpcResult(res, r, 'Portioning failed');
  }

  // ══ SALE BRIDGE ═══════════════════════════════════════════════════════
  if (action === 'invConsumeOrder') {
    const orderId = str(body.orderId, 60);
    if (!orderId) return bad(res, 'orderId required');
    const r = await rpc('inv_consume_order', {
      p_order_id: orderId, p_actor: actor, p_dry_run: !!body.dryRun,
    });
    return rpcResult(res, r, 'Consumption failed');
  }

  if (action === 'invListMenuMap') {
    const r = await supaFetch(
      `${SUPABASE_URL}/rest/v1/inv_menu_map?select=*,inv_items(item_code,name,item_type)&order=menu_item_code.asc`
    );
    if (!r.ok) return boom(res, 'Failed to load menu map');
    return res.status(200).json({ ok: true, map: r.data || [] });
  }

  if (action === 'invSaveMenuMap') {
    const menuItemCode = str(body.menuItemCode, 60);
    const invItemId = int(body.invItemId);
    const sellForm = ['WHOLE','PORTION'].includes(body.sellForm) ? body.sellForm : 'WHOLE';
    const deductMode = ['DIRECT','RECIPE','NONE'].includes(body.deductMode) ? body.deductMode : 'NONE';
    if (!menuItemCode) return bad(res, 'menuItemCode required');
    if (!invItemId) return bad(res, 'invItemId required');
    const row = {
      menu_item_code: menuItemCode, inv_item_id: invItemId,
      sell_form: sellForm, deduct_mode: deductMode,
      portions_per_sale: num(body.portionsPerSale) || 1,
      is_active: body.isActive !== false,
    };
    const r = await supa('POST', 'inv_menu_map', row, null,
                         'resolution=merge-duplicates,return=representation');
    if (!r.ok) return boom(res, 'Failed to save mapping');
    return res.status(200).json({ ok: true, mapping: (r.data || [])[0] || row });
  }

  // ══ REPORTS ═══════════════════════════════════════════════════════════
  if (action === 'invDashboard') {
    const [items, units, low, exp, tx] = await Promise.all([
      supaFetch(`${SUPABASE_URL}/rest/v1/inv_items?is_active=eq.true&select=id,item_type`),
      supaFetch(`${SUPABASE_URL}/rest/v1/inv_stock_units?quantity_remaining=gt.0&select=item_id,quantity_remaining,unit_cost,expiry_date`),
      supaFetch(`${SUPABASE_URL}/rest/v1/inv_v_consumption_queue?select=item_id,item_name,quantity_remaining,unit&order=quantity_remaining.asc&limit=10`),
      supaFetch(`${SUPABASE_URL}/rest/v1/inv_stock_units?quantity_remaining=gt.0&expiry_date=lte.${q(new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10))}&select=stock_unit_code,item_id,expiry_date,quantity_remaining&order=expiry_date.asc&limit=20`),
      supaFetch(`${SUPABASE_URL}/rest/v1/inv_stock_transactions?select=*&order=performed_at.desc&limit=15`),
    ]);
    const byType = {};
    (items.data || []).forEach(i => { byType[i.item_type] = (byType[i.item_type] || 0) + 1; });
    const totalValue = (units.data || []).reduce(
      (s, u) => s + (parseFloat(u.quantity_remaining) || 0) * (parseFloat(u.unit_cost) || 0), 0);
    return res.status(200).json({
      ok: true,
      totalInventoryValue: Math.round(totalValue * 100) / 100,
      countsByType: byType,
      lowStock: low.data || [],
      expiringSoon: exp.data || [],
      recentTransactions: tx.data || [],
    });
  }

  if (action === 'invLowStock') {
    const r = await supaFetch(
      `${SUPABASE_URL}/rest/v1/inv_v_consumption_queue?select=*&order=quantity_remaining.asc&limit=${Math.min(int(body.limit) || 50, 200)}`
    );
    if (!r.ok) return boom(res, 'Failed to load low stock');
    return res.status(200).json({ ok: true, items: r.data || [] });
  }

  if (action === 'invExpiringSoon') {
    const days = Math.min(Math.max(int(body.days) || 7, 1), 90);
    const cutoff = new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
    const r = await supaFetch(
      `${SUPABASE_URL}/rest/v1/inv_stock_units?quantity_remaining=gt.0&expiry_date=lte.${q(cutoff)}` +
      `&select=*,inv_items(item_code,name),inv_units(name)&order=expiry_date.asc&limit=200`
    );
    if (!r.ok) return boom(res, 'Failed to load expiring stock');
    return res.status(200).json({ ok: true, days, items: r.data || [] });
  }

  if (action === 'invTransactions') {
    let url = `${SUPABASE_URL}/rest/v1/inv_stock_transactions?select=*,inv_stock_units(stock_unit_code,item_id)`;
    if (body.transactionType) url += `&transaction_type=eq.${q(body.transactionType)}`;
    if (body.dateFrom)        url += `&performed_at=gte.${q(body.dateFrom)}`;
    if (body.dateTo)          url += `&performed_at=lte.${q(body.dateTo)}`;
    if (body.overridesOnly)   url += `&is_override=eq.true`;
    url += `&order=performed_at.desc&limit=${Math.min(int(body.limit) || 100, 500)}`;
    const r = await supaFetch(url);
    if (!r.ok) return boom(res, 'Failed to load transactions');
    return res.status(200).json({ ok: true, transactions: r.data || [] });
  }

  return false;
}
