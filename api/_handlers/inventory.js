// ── INVENTORY HANDLERS ── auto-extracted from pos.js
'use strict';

module.exports = async function handle_inventory(action, body, req, res, ctx) {
  const {
    supa, supaFetch, checkAuth, checkAdminAuth, auditLog, pushToSheets, logSync,
    invalidateMenuCache, getSetting, menuCache, SUPABASE_URL, SUPABASE_KEY,
    ORDER_PREFIX, SERVICE_CHARGE_RATE, isNonEmptyString, isValidPrice,
    isValidItemCode, isValidOrderId, isNonEmptyArray, isValidPhone
  } = ctx;

    // ── getInventory ───────────────────────────────────────────────────────
    if (action === 'getInventory') {
      const auth = await checkAuth(['OWNER','ADMIN','CASHIER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/inventory?select=*&order=item_code.asc`
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to fetch inventory' });
      // Attach menu item names
      const menuR = await supaFetch(`${SUPABASE_URL}/rest/v1/menu_items?select=item_code,name,is_active`);
      const menuMap = {};
      (menuR.data || []).forEach(m => { menuMap[m.item_code] = m; });
      const items = (r.data || []).map(i => ({
        ...i,
        item_name: menuMap[i.item_code]?.name || i.item_code,
        item_active: menuMap[i.item_code]?.is_active ?? true,
        low_stock: i.stock_qty <= i.low_stock_threshold,
        selling_price: i.selling_price || 0,
        size_per_unit: i.size_per_unit || '',
        photo_url: i.photo_url || null,
      }));
      return res.status(200).json({ ok: true, items });
    }

    // ── uploadInventoryPhoto ───────────────────────────────────────────────
    if (action === 'uploadInventoryPhoto') {
      const auth = await checkAdminAuth();
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { itemCode, imageBase64, mimeType } = body;
      if (!itemCode || !imageBase64) return res.status(400).json({ ok: false, error: 'itemCode + imageBase64 required' });
      const ext = (mimeType || 'image/jpeg').split('/')[1] || 'jpg';
      const filename = `${itemCode.replace(/[^a-zA-Z0-9-_]/g, '_')}.${ext}`;
      // Decode base64 and upload to Supabase Storage
      const imgBuffer = Buffer.from(imageBase64, 'base64');
      const uploadResp = await fetch(`${SUPABASE_URL}/storage/v1/object/inventory/${filename}`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': mimeType || 'image/jpeg',
          'x-upsert': 'true',
        },
        body: imgBuffer,
      });
      if (!uploadResp.ok) {
        const errText = await uploadResp.text();
        return res.status(500).json({ ok: false, error: 'Upload failed: ' + errText });
      }
      const photoUrl = `${SUPABASE_URL}/storage/v1/object/public/inventory/${filename}`;
      // Save URL on inventory row
      await supaFetch(
        `${SUPABASE_URL}/rest/v1/inventory?item_code=eq.${encodeURIComponent(itemCode)}`,
        { method: 'PATCH', body: JSON.stringify({ photo_url: photoUrl, updated_at: new Date().toISOString() }) }
      );
      return res.status(200).json({ ok: true, photoUrl, filename });
    }

    // ── upsertInventory ────────────────────────────────────────────────────
    if (action === 'upsertInventory') {
      const auth = await checkAdminAuth();
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { itemCode, stockQty, lowStockThreshold, unit, costPerUnit, sellingPrice,
              sizePerUnit, autoDisable, restockNotes, photoUrl } = body;
      if (!itemCode) return res.status(400).json({ ok: false, error: 'itemCode required' });
      const row = {
        item_code: itemCode,
        stock_qty: parseFloat(stockQty) || 0,
        low_stock_threshold: parseFloat(lowStockThreshold) || 10,
        unit: unit || 'pcs',
        cost_per_unit: parseFloat(costPerUnit) || 0,
        selling_price: parseFloat(sellingPrice) || 0,
        size_per_unit: sizePerUnit || '',
        auto_disable: !!autoDisable,
        restock_notes: restockNotes || '',
        last_restocked_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      if (photoUrl) row.photo_url = photoUrl;
      // Try PATCH first (update existing), fallback to POST (create new)
      const existsR = await supaFetch(
        `${SUPABASE_URL}/rest/v1/inventory?item_code=eq.${encodeURIComponent(itemCode)}&select=id`
      );
      const exists = Array.isArray(existsR.data) && existsR.data.length > 0;
      const r = exists
        ? await supaFetch(
            `${SUPABASE_URL}/rest/v1/inventory?item_code=eq.${encodeURIComponent(itemCode)}`,
            { method: 'PATCH', body: JSON.stringify(row) }
          )
        : await supaFetch(
            `${SUPABASE_URL}/rest/v1/inventory`,
            { method: 'POST', body: JSON.stringify(row),
              headers: { Prefer: 'return=representation' } }
          );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to save inventory' });
      // Log restock
      await supaFetch(`${SUPABASE_URL}/rest/v1/inventory_log`, {
        method: 'POST',
        body: JSON.stringify({
          item_code: itemCode, change_type: 'RESTOCK',
          qty_change: parseFloat(stockQty) || 0,
          qty_after: parseFloat(stockQty) || 0,
          notes: restockNotes || 'Manual restock', actor_id: body.userId,
        })
      });
      return res.status(200).json({ ok: true, item: r.data?.[0] || row });
    }

    // ── adjustInventory ────────────────────────────────────────────────────
    if (action === 'adjustInventory') {
      const auth = await checkAdminAuth();
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { itemCode, adjustment, changeType, notes, unitPrice, reference, direction } = body;
      if (!itemCode || adjustment === undefined) return res.status(400).json({ ok: false, error: 'itemCode + adjustment required' });
      // direction: 'IN' = positive (RESTOCK/RETURN), 'OUT' = negative (WASTE/SALE)
      // If direction provided, force the sign; otherwise trust the sign of adjustment
      let qty = parseFloat(adjustment);
      if (direction === 'IN' && qty < 0) qty = -qty;
      if (direction === 'OUT' && qty > 0) qty = -qty;
      const validTypes = ['RESTOCK','ADJUSTMENT','WASTE','RETURN','SALE'];
      let type = validTypes.includes(changeType) ? changeType : 'ADJUSTMENT';
      // Auto-assign type based on direction if not specified
      if (!changeType) type = direction === 'IN' ? 'RESTOCK' : direction === 'OUT' ? 'WASTE' : 'ADJUSTMENT';
      // Get current
      const cur = await supaFetch(`${SUPABASE_URL}/rest/v1/inventory?item_code=eq.${encodeURIComponent(itemCode)}&select=stock_qty,auto_disable`);
      const current = cur.data?.[0];
      if (!current) return res.status(404).json({ ok: false, error: 'Item not in inventory' });
      const newQty = Math.max(0, parseFloat(current.stock_qty) + qty);
      const updatePatch = { stock_qty: newQty, updated_at: new Date().toISOString() };
      if (direction === 'IN') updatePatch.last_restocked_at = new Date().toISOString();
      await supaFetch(`${SUPABASE_URL}/rest/v1/inventory?item_code=eq.${encodeURIComponent(itemCode)}`,
        { method: 'PATCH', body: JSON.stringify(updatePatch) });
      // Auto-disable menu item if stock hits 0
      if (newQty === 0 && current.auto_disable) {
        await supaFetch(`${SUPABASE_URL}/rest/v1/menu_items?item_code=eq.${encodeURIComponent(itemCode)}`,
          { method: 'PATCH', body: JSON.stringify({ is_active: false }) });
      }
      // Log with new fields
      await supaFetch(`${SUPABASE_URL}/rest/v1/inventory_log`, { method: 'POST',
        body: JSON.stringify({ item_code: itemCode, change_type: type,
          qty_before: parseFloat(current.stock_qty), qty_change: qty,
          qty_after: newQty, notes: notes || '', actor_id: body.userId,
          unit_price: parseFloat(unitPrice) || 0,
          reference: reference || '' }) });
      return res.status(200).json({ ok: true, itemCode, qtyBefore: current.stock_qty, qtyAfter: newQty, direction: qty >= 0 ? 'IN' : 'OUT' });
    }

    // ── getInventoryLog ────────────────────────────────────────────────────
    if (action === 'getInventoryLog') {
      const auth = await checkAuth(['OWNER','ADMIN']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const limit = Math.min(parseInt(body.limit) || 50, 200);
      const filter = body.itemCode ? `&item_code=eq.${encodeURIComponent(body.itemCode)}` : '';
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/inventory_log?select=*&order=created_at.desc&limit=${limit}${filter}`
      );
      return res.status(200).json({ ok: r.ok, logs: r.data || [] });
    }

    // ══════════════════════════════════════════════════════════════════════
    // ADD-ONS / MODIFIERS
    // ══════════════════════════════════════════════════════════════════════


  return res.status(400).json({ ok: false, error: `Unknown inventory action: ${action}` });
};
