-- ══════════════════════════════════════════════════════════════════════
-- Inventory engine, part 2: functions
--  receive (purchase-unit conversion, batch always, shelf-life expiry)
--  allocation (per-item FIFO/FEFO, actual batch cost, allocation list)
--  one sales engine for every channel (POS, ONLINE, future) with size recipes,
--  add-ons, idempotency by source ref, shortage exceptions
--  waste refs, reversal of a movement, online-order hooks
-- ══════════════════════════════════════════════════════════════════════

-- explicit source refs pass straight through
CREATE OR REPLACE FUNCTION public.trg_inv_tx_fill()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE su record;
BEGIN
  SELECT location_id, unit_cost INTO su FROM inv_stock_units WHERE id = NEW.stock_unit_id;
  NEW.location_id := COALESCE(NEW.location_id, su.location_id);
  NEW.unit_cost   := COALESCE(NEW.unit_cost, su.unit_cost);
  NEW.cost_impact := COALESCE(NEW.cost_impact, ROUND(NEW.quantity * COALESCE(NEW.unit_cost,0), 4));
  NEW.source_ref  := COALESCE(NEW.source_ref, CASE
                       WHEN NEW.reference_type = 'sale' THEN 'POS-' || NEW.reference_id
                       WHEN NEW.reference_id ~ '^(COUNT|WASTE|ONLINE|POS|PRODUCTION|ADJ|OPENING|PURCHASE|MERGE)-' THEN NEW.reference_id
                       WHEN NEW.reference_id IS NOT NULL THEN upper(COALESCE(NEW.reference_type,'MANUAL')) || '-' || NEW.reference_id
                       ELSE upper(COALESCE(NEW.reference_type,'MANUAL')) || '-' || to_char(clock_timestamp(),'YYMMDDHH24MISSMS') END);
  NEW.movement_type := COALESCE(NEW.movement_type,
                       inv_movement_label(NEW.transaction_type, NEW.reference_type, NEW.reason, NEW.source_ref, NEW.notes));
  RETURN NEW;
END $$;

-- ── allocation: FEFO/FIFO per item, actual batch cost, never raises ─────────
DROP FUNCTION IF EXISTS public.inv_take_stock(bigint,numeric,text,text,text,text,text,text,text);
CREATE FUNCTION public.inv_take_stock(
  p_item_id bigint, p_qty numeric, p_type text, p_reason text,
  p_ref_type text, p_ref_id text, p_actor text, p_notes text DEFAULT NULL, p_photo text DEFAULT NULL,
  p_source_ref text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_base bigint; v_fefo boolean; v_need numeric := p_qty; v_su record;
        v_take numeric; v_take_u numeric; v_after numeric; v_cost numeric := 0; v_units int := 0; v_taken numeric := 0;
        v_alloc jsonb := '[]'::jsonb;
BEGIN
  IF p_type NOT IN ('consume','waste','count') THEN RETURN jsonb_build_object('ok',false,'error','bad_type'); END IF;
  IF p_qty IS NULL OR p_qty <= 0 THEN RETURN jsonb_build_object('ok',true,'taken',0,'shortfall',0,'cost',0,'units',0,'allocations','[]'::jsonb); END IF;
  SELECT base_unit_id, (rotation = 'FEFO') INTO v_base, v_fefo FROM inv_items WHERE id = p_item_id;
  IF v_base IS NULL THEN RETURN jsonb_build_object('ok',false,'error','item_not_found'); END IF;

  FOR v_su IN
    SELECT su.id, su.quantity_remaining, su.unit_id, su.unit_cost, su.stock_unit_code,
           COALESCE(b.batch_code, su.stock_unit_code) AS batch
    FROM inv_stock_units su LEFT JOIN inv_batches b ON b.id = su.batch_id
    WHERE su.item_id = p_item_id AND su.status IN ('in_stock','opened','partially_used') AND su.quantity_remaining > 0
    ORDER BY CASE WHEN v_fefo THEN su.expiry_date END NULLS LAST, su.date_received, su.id
    FOR UPDATE OF su
  LOOP
    EXIT WHEN v_need <= 0;
    v_take   := LEAST(v_need, inv_convert(v_su.quantity_remaining, v_su.unit_id, v_base));
    v_take_u := inv_convert(v_take, v_base, v_su.unit_id);
    v_after  := v_su.quantity_remaining - v_take_u;
    UPDATE inv_stock_units
       SET quantity_remaining = v_after,
           status = CASE WHEN v_after <= 0 THEN (CASE WHEN p_type='waste' THEN 'wasted' ELSE 'consumed' END)
                         ELSE 'partially_used' END,
           updated_at = now()
     WHERE id = v_su.id;
    INSERT INTO inv_stock_transactions
      (stock_unit_id, transaction_type, quantity, quantity_after, unit_id, reference_type, reference_id,
       performed_by, notes, reason, photo_url, source_ref)
    VALUES (v_su.id, p_type, -v_take_u, v_after, v_su.unit_id,
            p_ref_type, p_ref_id, p_actor, p_notes, p_reason, p_photo, p_source_ref);
    v_cost  := v_cost + v_take_u * COALESCE(v_su.unit_cost, 0);
    v_alloc := v_alloc || jsonb_build_object('batch', v_su.batch, 'stock_unit', v_su.stock_unit_code,
                                             'qty', v_take, 'before', inv_convert(v_su.quantity_remaining, v_su.unit_id, v_base),
                                             'after', inv_convert(v_after, v_su.unit_id, v_base), 'unit_cost', v_su.unit_cost);
    v_units := v_units + 1; v_taken := v_taken + v_take; v_need := v_need - v_take;
  END LOOP;

  RETURN jsonb_build_object('ok',true,'taken',v_taken,'shortfall',GREATEST(v_need,0),
                            'cost',ROUND(v_cost,4),'units',v_units,'allocations',v_alloc);
END $$;

-- ── receiving: enter the purchase unit, stock the stock unit ─────────────
DROP FUNCTION IF EXISTS public.inv_receive_stock(bigint,numeric,bigint,numeric,bigint,bigint,date,text,text,date,boolean);
CREATE FUNCTION public.inv_receive_stock(p_item_id bigint, p_qty numeric, p_unit_id bigint, p_unit_cost numeric DEFAULT 0,
  p_supplier_id bigint DEFAULT NULL, p_location_id bigint DEFAULT NULL, p_expiry date DEFAULT NULL,
  p_actor text DEFAULT 'SYSTEM', p_notes text DEFAULT NULL, p_expected_use date DEFAULT NULL,
  p_split_units boolean DEFAULT false, p_ref_type text DEFAULT 'purchase', p_source_ref text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  it record; v_code text; v_su bigint; v_batch bigint; v_bcode text; v_loc bigint; v_exp date;
  v_n int; v_i int; v_each numeric; v_codes jsonb := '[]'::jsonb; v_ids jsonb := '[]'::jsonb;
  v_qty numeric := p_qty; v_unit bigint := p_unit_id; v_cost numeric := COALESCE(p_unit_cost,0);
  v_conv numeric := NULL; v_note text; v_src text;
BEGIN
  IF p_qty IS NULL OR p_qty <= 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'bad_qty'); END IF;
  SELECT i.*, bu.name AS base_name, pu.name AS pu_name INTO it
    FROM inv_items i JOIN inv_units bu ON bu.id = i.base_unit_id LEFT JOIN inv_units pu ON pu.id = i.purchase_unit_id
   WHERE i.id = p_item_id AND i.is_active;
  IF it.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'item_not_found'); END IF;
  IF it.merged_into_id IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'item_merged_use_canonical'); END IF;
  IF NOT EXISTS (SELECT 1 FROM inv_units WHERE id = p_unit_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unit_not_found'); END IF;

  -- purchase unit → stock unit (1 cake = 16 slices)
  IF it.purchase_unit_id IS NOT NULL AND it.purchase_to_stock IS NOT NULL AND p_unit_id = it.purchase_unit_id
     AND p_unit_id <> it.base_unit_id THEN
    v_conv := it.purchase_to_stock;
  -- legacy portion items without a purchase unit set: box/whole/pack of a slice/serving item
  ELSIF it.purchase_to_stock IS NULL AND it.standard_yield > 0 AND p_unit_id <> it.base_unit_id
     AND it.base_name IN ('slice','serving')
     AND (SELECT name FROM inv_units WHERE id = p_unit_id) IN ('whole','box','pack','tray','pc') THEN
    v_conv := it.standard_yield;
  END IF;
  IF v_conv IS NOT NULL THEN
    v_qty := p_qty * v_conv; v_unit := it.base_unit_id; v_cost := v_cost / v_conv;
    v_note := p_qty || ' ' || COALESCE((SELECT name FROM inv_units WHERE id = p_unit_id),'unit') || ' × ' || v_conv || ' = ' || v_qty || ' ' || it.base_name;
  END IF;

  v_loc := COALESCE(p_location_id, it.default_location_id, (SELECT id FROM inv_locations WHERE name = inv_cfg('default_location')));
  v_exp := COALESCE(p_expiry, CASE WHEN it.shelf_life_days IS NOT NULL THEN (now() AT TIME ZONE 'Asia/Manila')::date + it.shelf_life_days END);
  v_bcode := upper(regexp_replace(COALESCE(NULLIF(it.item_code,''),'ITEM'), '[^A-Za-z0-9]+', '', 'g'));
  v_bcode := left(v_bcode, 10) || '-' || to_char(clock_timestamp() AT TIME ZONE 'Asia/Manila','YYMMDD') || '-' || lpad(nextval('inv_seq_batch')::text, 3, '0');
  INSERT INTO inv_batches(item_id, batch_code, supplier_id, expiry_date, notes)
  VALUES (p_item_id, v_bcode, COALESCE(p_supplier_id, it.default_supplier_id), v_exp, p_notes)
  RETURNING id INTO v_batch;

  v_src := COALESCE(p_source_ref, CASE WHEN p_ref_type = 'opening' THEN 'OPENING-' ELSE 'PURCHASE-' END || v_bcode);
  v_n    := CASE WHEN p_split_units AND v_conv IS NULL THEN GREATEST(1, FLOOR(v_qty)::int) ELSE 1 END;
  v_each := CASE WHEN p_split_units AND v_conv IS NULL THEN v_qty / v_n ELSE v_qty END;

  FOR v_i IN 1..v_n LOOP
    v_code := inv_next_stock_code(it.item_type);
    INSERT INTO inv_stock_units
      (stock_unit_code, item_id, batch_id, quantity_original, quantity_remaining,
       unit_id, unit_cost, status, location_id, expiry_date, expected_use_date, created_by, notes)
    VALUES (v_code, p_item_id, v_batch, v_each, v_each, v_unit, ROUND(v_cost,4),
            'in_stock', v_loc, v_exp, p_expected_use, p_actor, p_notes)
    RETURNING id INTO v_su;
    INSERT INTO inv_stock_transactions
      (stock_unit_id, transaction_type, quantity, quantity_after, unit_id, reference_type, reference_id,
       performed_by, notes, source_ref)
    VALUES (v_su, 'receive', v_each, v_each, v_unit, COALESCE(p_ref_type,'purchase'), v_bcode, p_actor,
            CONCAT_WS(' · ', NULLIF(p_notes,''), v_note), v_src);
    v_codes := v_codes || to_jsonb(v_code);
    v_ids   := v_ids   || to_jsonb(v_su);
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'units_created', v_n, 'stock_unit_id', v_su,
                            'stock_unit_code', v_code, 'stock_unit_ids', v_ids, 'stock_unit_codes', v_codes,
                            'batch_id', v_batch, 'batch_code', v_bcode, 'expiry', v_exp,
                            'qty_received', v_qty, 'stock_unit', it.base_name,
                            'converted_from_packs', v_conv IS NOT NULL, 'conversion', v_conv, 'unit_cost', ROUND(v_cost,4),
                            'source_ref', v_src);
END;
$function$;

-- ── consume one inventory item for a sale (recipe explode if it's made to order) ──
CREATE OR REPLACE FUNCTION public.inv_sale_consume_item(
  p_item_id bigint, p_qty_base numeric, p_size text, p_source_ref text, p_channel text,
  p_menu_code text, p_actor text, p_depth int DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_rec bigint; v_ing record; v_res jsonb; v_cost numeric := 0; v_n int := 0; v_short int := 0; v_need numeric;
        v_base bigint;
BEGIN
  IF p_qty_base IS NULL OR p_qty_base <= 0 THEN RETURN jsonb_build_object('cost',0,'lines',0,'shortages',0); END IF;
  -- stocked item: take it
  IF inv_item_tracked(p_item_id) THEN
    v_res := inv_take_stock(p_item_id, p_qty_base, 'consume', NULL, 'sale', p_source_ref, p_actor,
                            p_channel || ' sale ' || COALESCE(p_menu_code,''), NULL, p_source_ref);
    IF COALESCE((v_res->>'shortfall')::numeric,0) > 0 THEN
      SELECT base_unit_id INTO v_base FROM inv_items WHERE id = p_item_id;
      INSERT INTO inv_stock_exceptions(item_id, qty_short, unit_id, source_ref, channel, menu_item_code, detail)
      VALUES (p_item_id, (v_res->>'shortfall')::numeric, v_base, p_source_ref, p_channel, p_menu_code,
              'Sold ' || p_qty_base || ', recorded stock covered ' || (v_res->>'taken'));
      v_short := 1;
    END IF;
    RETURN jsonb_build_object('cost', COALESCE((v_res->>'cost')::numeric,0), 'lines', 1, 'shortages', v_short,
                              'allocations', v_res->'allocations');
  END IF;
  -- made to order: explode its recipe (size recipe first, then the default), one level deep
  IF p_depth > 1 THEN RETURN jsonb_build_object('cost',0,'lines',0,'shortages',0); END IF;
  SELECT r.id INTO v_rec FROM inv_recipes r
   WHERE r.item_id = p_item_id AND r.is_active AND (r.size_code = p_size OR r.size_code IS NULL)
   ORDER BY (r.size_code = p_size) DESC NULLS LAST LIMIT 1;
  IF v_rec IS NULL THEN RETURN jsonb_build_object('cost',0,'lines',0,'shortages',0,'untracked',true); END IF;
  FOR v_ing IN
    SELECT ri.ingredient_item_id, ri.quantity, ri.unit_id, COALESCE(ri.yield_loss_pct,0) yl, ii.base_unit_id,
           COALESCE(NULLIF(r.yield_qty,0),1) AS yq
    FROM inv_recipe_ingredients ri JOIN inv_items ii ON ii.id = ri.ingredient_item_id
    JOIN inv_recipes r ON r.id = ri.recipe_id
    WHERE ri.recipe_id = v_rec
  LOOP
    BEGIN
      v_need := inv_convert(v_ing.quantity * (100.0/(100.0 - v_ing.yl)), v_ing.unit_id, v_ing.base_unit_id) * p_qty_base / v_ing.yq;
      v_res := inv_sale_consume_item(v_ing.ingredient_item_id, v_need, NULL, p_source_ref, p_channel, p_menu_code, p_actor, p_depth + 1);
      v_cost := v_cost + COALESCE((v_res->>'cost')::numeric,0);
      v_n := v_n + COALESCE((v_res->>'lines')::int,0);
      v_short := v_short + COALESCE((v_res->>'shortages')::int,0);
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO inv_stock_exceptions(item_id, qty_short, source_ref, channel, menu_item_code, detail)
      VALUES (v_ing.ingredient_item_id, GREATEST(v_ing.quantity,0.0001), p_source_ref, p_channel, p_menu_code, 'Could not deduct: ' || SQLERRM);
      v_short := v_short + 1;
    END;
  END LOOP;
  RETURN jsonb_build_object('cost', v_cost, 'lines', v_n, 'shortages', v_short, 'recipe_id', v_rec);
END $$;

-- ── one sales engine for every channel ───────────────────────────────────
-- p_lines: [{menu_code, qty, size, addons:[{code}]|null, name}]
CREATE OR REPLACE FUNCTION public.inv_consume_sale(p_channel text, p_source_ref text, p_lines jsonb,
                                                   p_actor text DEFAULT 'SYSTEM', p_dry_run boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE l record; mm record; a record; v_rc int; v_size text; v_qty numeric; v_res jsonb; v_code text;
        v_cost numeric := 0; v_lines int := 0; v_short int := 0; v_skip int := 0; v_ad jsonb; v_mult numeric;
BEGIN
  IF inv_cfg('module_enabled') <> 'true' THEN RETURN jsonb_build_object('ok', true, 'skipped', 'module_disabled'); END IF;
  IF p_source_ref IS NULL OR btrim(p_source_ref) = '' THEN RETURN jsonb_build_object('ok',false,'error','missing_source_ref'); END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'no_items');
  END IF;
  IF p_dry_run THEN RETURN jsonb_build_object('ok', true, 'dry_run', true, 'lines', jsonb_array_length(p_lines)); END IF;

  -- idempotency: one consumption event per source (trigger re-fire, retry, refresh, webhook)
  INSERT INTO stock_consumption_guard(order_id, actor_id, channel) VALUES (p_source_ref, p_actor, p_channel)
  ON CONFLICT (order_id) DO NOTHING;
  GET DIAGNOSTICS v_rc = ROW_COUNT;
  IF v_rc = 0 THEN RETURN jsonb_build_object('ok', true, 'already_consumed', true, 'source_ref', p_source_ref); END IF;

  FOR l IN SELECT * FROM jsonb_to_recordset(p_lines) AS x(menu_code text, qty numeric, size text, addons jsonb, name text) LOOP
    v_code := l.menu_code;
    IF v_code IS NULL AND l.name IS NOT NULL THEN
      SELECT item_code INTO v_code FROM menu_items WHERE lower(btrim(name)) = lower(btrim(l.name)) ORDER BY is_active DESC LIMIT 1;
    END IF;
    IF v_code IS NULL THEN v_skip := v_skip + 1; CONTINUE; END IF;
    v_qty  := COALESCE(l.qty, 1);
    v_size := upper(btrim(split_part(COALESCE(l.size,''), '·', 1)));
    v_size := CASE WHEN v_size IN ('SHORT','MEDIUM','TALL','SLICE','WHOLE') THEN v_size END;

    mm := NULL;
    SELECT m.inv_item_id, m.deduct_mode, COALESCE(m.portions_per_sale,1) pps, i.purchase_to_stock, i.standard_yield
      INTO mm FROM inv_menu_map m JOIN inv_items i ON i.id = m.inv_item_id
     WHERE m.menu_item_code = v_code AND m.is_active AND m.sell_form = 'WHOLE' AND i.is_active LIMIT 1;

    IF mm.inv_item_id IS NOT NULL AND mm.deduct_mode <> 'NONE' THEN
      BEGIN
        IF mm.deduct_mode = 'DIRECT' THEN
          -- a WHOLE of a portioned item = all its portions (1 whole pie = 8 slices)
          v_mult := CASE WHEN v_size = 'WHOLE' THEN COALESCE(mm.purchase_to_stock, mm.standard_yield, 1) ELSE 1 END;
          v_res := inv_sale_consume_item(mm.inv_item_id, v_qty * mm.pps * v_mult, v_size, p_source_ref, p_channel, v_code, p_actor, 2);
        ELSE
          v_res := inv_sale_consume_item(mm.inv_item_id, v_qty, v_size, p_source_ref, p_channel, v_code, p_actor, 0);
        END IF;
        v_cost := v_cost + COALESCE((v_res->>'cost')::numeric,0);
        v_lines := v_lines + COALESCE((v_res->>'lines')::int,0);
        v_short := v_short + COALESCE((v_res->>'shortages')::int,0);
      EXCEPTION WHEN OTHERS THEN
        v_short := v_short + 1;
        INSERT INTO inv_stock_exceptions(item_id, qty_short, source_ref, channel, menu_item_code, detail)
        VALUES (mm.inv_item_id, v_qty, p_source_ref, p_channel, v_code, 'Could not deduct: ' || SQLERRM);
      END;
    ELSE
      v_skip := v_skip + 1;
    END IF;

    -- add-ons layered on top of the size recipe (extra shot → +18g coffee)
    IF l.addons IS NOT NULL AND jsonb_typeof(l.addons) = 'array' THEN
      FOR v_ad IN SELECT * FROM jsonb_array_elements(l.addons) LOOP
        a := NULL;
        SELECT ma.inv_item_id, ma.inv_qty, ma.inv_unit_id, ma.addon_code, i.base_unit_id INTO a
          FROM menu_addons ma JOIN inv_items i ON i.id = ma.inv_item_id
         WHERE ma.addon_code = COALESCE(v_ad->>'code', v_ad->>'addon_code') AND ma.inv_item_id IS NOT NULL;
        IF a.inv_item_id IS NULL THEN CONTINUE; END IF;
        BEGIN
          v_res := inv_sale_consume_item(a.inv_item_id,
                     inv_convert(COALESCE(a.inv_qty,1), COALESCE(a.inv_unit_id, a.base_unit_id), a.base_unit_id) * v_qty,
                     NULL, p_source_ref, p_channel, v_code || '+' || a.addon_code, p_actor, 0);
          v_cost := v_cost + COALESCE((v_res->>'cost')::numeric,0);
          v_lines := v_lines + COALESCE((v_res->>'lines')::int,0);
          v_short := v_short + COALESCE((v_res->>'shortages')::int,0);
        EXCEPTION WHEN OTHERS THEN
          v_short := v_short + 1;
          INSERT INTO inv_stock_exceptions(item_id, qty_short, source_ref, channel, menu_item_code, detail)
          VALUES (a.inv_item_id, COALESCE(a.inv_qty,1) * v_qty, p_source_ref, p_channel, v_code || '+' || a.addon_code, 'Could not deduct add-on: ' || SQLERRM);
        END;
      END LOOP;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'source_ref', p_source_ref, 'channel', p_channel,
                            'movements', v_lines, 'shortages', v_short, 'skipped', v_skip, 'cogs', ROUND(v_cost,4));
END $$;

-- POS wrapper (keeps the existing signature used by triggers/API)
CREATE OR REPLACE FUNCTION public.inv_consume_order(p_order_id text, p_actor text DEFAULT 'SYSTEM'::text, p_dry_run boolean DEFAULT false)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_lines jsonb;
BEGIN
  SELECT jsonb_agg(jsonb_build_object('menu_code', oi.item_code, 'qty', oi.qty, 'size', oi.size_choice,
                                      'addons', CASE WHEN jsonb_typeof(oi.addons) = 'string' THEN (oi.addons #>> '{}')::jsonb ELSE oi.addons END,
                                      'name', oi.item_name) ORDER BY oi.id)
    INTO v_lines FROM dine_in_order_items oi WHERE oi.order_id = p_order_id;
  RETURN inv_consume_sale('POS', 'POS-' || p_order_id, v_lines, p_actor, p_dry_run);
END;
$function$;

-- Online wrapper
CREATE OR REPLACE FUNCTION public.inv_consume_online(p_order_ref text, p_actor text DEFAULT 'SYSTEM', p_dry_run boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_lines jsonb;
BEGIN
  SELECT jsonb_agg(jsonb_build_object('menu_code', NULLIF(oi.menu_item_id,''), 'qty', oi.quantity, 'size', oi.size,
                                      'addons', CASE WHEN jsonb_typeof(oi.addons) = 'string' THEN (oi.addons #>> '{}')::jsonb ELSE oi.addons END,
                                      'name', oi.item_name) ORDER BY oi.id)
    INTO v_lines
    FROM online_order_items oi JOIN online_orders o ON o.id = oi.order_id
   WHERE o.order_ref = p_order_ref;
  RETURN inv_consume_sale('ONLINE', 'ONLINE-' || p_order_ref, v_lines, p_actor, p_dry_run);
END $$;

-- ── reversal of a whole sale (void/cancel/delete) ─────────────────────────
CREATE OR REPLACE FUNCTION public.inv_reverse_sale(p_source_ref text, p_actor text DEFAULT 'SYSTEM')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE t record; v_after numeric; v_n int := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM stock_consumption_guard WHERE order_id = p_source_ref) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'not_consumed');
  END IF;
  FOR t IN
    SELECT x.* FROM inv_stock_transactions x
    WHERE x.source_ref = p_source_ref AND x.transaction_type = 'consume' AND x.quantity < 0
      AND NOT EXISTS (SELECT 1 FROM inv_stock_transactions r WHERE r.parent_txn_id = x.id)
    ORDER BY x.id
  LOOP
    UPDATE inv_stock_units
       SET quantity_remaining = quantity_remaining - t.quantity,
           status = CASE WHEN quantity_remaining - t.quantity >= quantity_original THEN 'in_stock' ELSE 'partially_used' END,
           updated_at = now()
     WHERE id = t.stock_unit_id
    RETURNING quantity_remaining INTO v_after;
    INSERT INTO inv_stock_transactions
      (stock_unit_id, transaction_type, quantity, quantity_after, unit_id, reference_type, reference_id,
       performed_by, notes, parent_txn_id, source_ref, unit_cost)
    VALUES (t.stock_unit_id, 'return', -t.quantity, v_after, t.unit_id, 'sale_reversal', t.reference_id,
            p_actor, 'sale voided — stock returned', t.id, p_source_ref, t.unit_cost);
    v_n := v_n + 1;
  END LOOP;
  UPDATE inv_stock_exceptions SET status='RESOLVED', resolved_by=p_actor, resolved_at=now(),
         resolution_note='sale voided' WHERE source_ref = p_source_ref AND status='OPEN';
  DELETE FROM stock_consumption_guard WHERE order_id = p_source_ref;
  RETURN jsonb_build_object('ok', true, 'source_ref', p_source_ref, 'reversed_lines', v_n);
END $$;

CREATE OR REPLACE FUNCTION public.inv_reverse_order(p_order_id text, p_actor text DEFAULT 'SYSTEM')
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT inv_reverse_sale('POS-' || p_order_id, p_actor)
$$;

-- ── correct one movement: equal and opposite movement, linked ──────────────
CREATE OR REPLACE FUNCTION public.inv_reverse_movement(p_txn_id bigint, p_reason text, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE t record; v_after numeric; v_ref text; v_id bigint;
BEGIN
  IF COALESCE(btrim(p_reason),'') = '' THEN RETURN jsonb_build_object('ok',false,'error','A reason is required'); END IF;
  SELECT * INTO t FROM inv_stock_transactions WHERE id = p_txn_id;
  IF t.id IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Movement not found'); END IF;
  IF t.quantity = 0 THEN RETURN jsonb_build_object('ok',false,'error','Nothing to reverse'); END IF;
  IF EXISTS (SELECT 1 FROM inv_stock_transactions WHERE parent_txn_id = t.id) THEN
    RETURN jsonb_build_object('ok',false,'error','Already reversed'); END IF;
  IF t.quantity > 0 AND (SELECT quantity_remaining FROM inv_stock_units WHERE id = t.stock_unit_id) < t.quantity THEN
    RETURN jsonb_build_object('ok',false,'error','That batch no longer has enough to reverse — record an adjustment instead'); END IF;
  UPDATE inv_stock_units
     SET quantity_remaining = quantity_remaining - t.quantity,
         status = CASE WHEN quantity_remaining - t.quantity <= 0 THEN 'consumed'
                       WHEN quantity_remaining - t.quantity >= quantity_original THEN 'in_stock' ELSE 'partially_used' END,
         updated_at = now()
   WHERE id = t.stock_unit_id RETURNING quantity_remaining INTO v_after;
  v_ref := 'ADJ-' || lpad(nextval('inv_seq_adjust')::text, 5, '0');
  INSERT INTO inv_stock_transactions (stock_unit_id, transaction_type, quantity, quantity_after, unit_id, reference_type,
         reference_id, performed_by, notes, parent_txn_id, reason, source_ref, unit_cost, movement_type)
  VALUES (t.stock_unit_id, 'adjust', -t.quantity, v_after, t.unit_id, 'reversal', t.source_ref, p_actor,
          'Reversal of movement #' || t.id || ' (' || t.movement_type || '): ' || p_reason, t.id, 'CORRECTION', v_ref,
          t.unit_cost, 'STOCK ADJUSTMENT')
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok',true,'reversal_id',v_id,'source_ref',v_ref);
END $$;

-- ── waste / spoilage: own ref, batch picked automatically ─────────────────
CREATE OR REPLACE FUNCTION public.inv_record_spoilage(
  p_item_id bigint, p_qty numeric, p_reason text, p_notes text, p_actor text, p_photo text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_avail numeric; v_res jsonb; v_name text; v_val numeric; v_ref text;
BEGIN
  IF p_reason NOT IN ('SPOILED','EXPIRED','DAMAGED','BREAKAGE','WASTE','STAFF_MEAL','COMPLIMENTARY') THEN
    RETURN jsonb_build_object('ok',false,'error','Pick a reason');
  END IF;
  IF p_qty IS NULL OR p_qty <= 0 THEN RETURN jsonb_build_object('ok',false,'error','Enter a quantity'); END IF;
  SELECT name INTO v_name FROM inv_items WHERE id = p_item_id;
  IF v_name IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Item not found'); END IF;
  v_avail := inv_item_available(p_item_id);
  IF p_qty > v_avail + 0.0001 THEN
    RETURN jsonb_build_object('ok',false,'error', v_name || ': only ' || trim(to_char(v_avail,'FM999999990.##')) || ' in stock');
  END IF;
  v_val := p_qty * inv_menu_unit_price(p_item_id);
  IF v_val > COALESCE(NULLIF(inv_cfg('spoilage_photo_above'),'')::numeric, 100) AND COALESCE(p_photo,'') = '' THEN
    RETURN jsonb_build_object('ok',false,'error', v_name || ': add a photo (worth ₱' || trim(to_char(v_val,'FM999999990.00')) || ')', 'photo_required', true);
  END IF;
  v_ref := 'WASTE-' || lpad(nextval('inv_seq_waste')::text, 5, '0');
  v_res := inv_take_stock(p_item_id, p_qty, 'waste', p_reason, 'spoilage', v_ref, p_actor, p_notes, p_photo, v_ref);
  RETURN v_res || jsonb_build_object('item', v_name, 'remaining', inv_item_available(p_item_id), 'value', v_val, 'source_ref', v_ref);
END $$;

-- ── online order hooks: COMPLETED deducts once, CANCELLED reverses ─────────
CREATE OR REPLACE FUNCTION public.trg_inv_online_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF inv_cfg('module_enabled') IS DISTINCT FROM 'true' OR inv_cfg('auto_deduct_on_sale') IS DISTINCT FROM 'true' THEN RETURN NEW; END IF;
  BEGIN
    IF NEW.status::text = 'COMPLETED' AND OLD.status::text IS DISTINCT FROM 'COMPLETED' THEN
      PERFORM inv_consume_online(NEW.order_ref, 'SYSTEM', false);
    ELSIF NEW.status::text = 'CANCELLED' AND OLD.status::text IS DISTINCT FROM 'CANCELLED' THEN
      PERFORM inv_reverse_sale('ONLINE-' || NEW.order_ref, 'SYSTEM');
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'inventory hook skipped for online %: %', NEW.order_ref, SQLERRM;
  END;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_inv_online_status ON online_orders;
CREATE TRIGGER trg_inv_online_status AFTER UPDATE OF status ON online_orders
  FOR EACH ROW EXECUTE FUNCTION trg_inv_online_status();

-- ── grants: service_role only ─────────────────────────────────────────────
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.trg_inv_tx_fill()',
    'public.inv_take_stock(bigint,numeric,text,text,text,text,text,text,text,text)',
    'public.inv_receive_stock(bigint,numeric,bigint,numeric,bigint,bigint,date,text,text,date,boolean,text,text)',
    'public.inv_sale_consume_item(bigint,numeric,text,text,text,text,text,integer)',
    'public.inv_consume_sale(text,text,jsonb,text,boolean)',
    'public.inv_consume_order(text,text,boolean)', 'public.inv_consume_online(text,text,boolean)',
    'public.inv_reverse_sale(text,text)', 'public.inv_reverse_order(text,text)',
    'public.inv_reverse_movement(bigint,text,text)',
    'public.inv_record_spoilage(bigint,numeric,text,text,text,text)',
    'public.trg_inv_online_status()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;

-- opening balance from a count is labelled OPENING BALANCE with the count's ref
DO $mig$
DECLARE src text; n text;
BEGIN
  src := pg_get_functiondef('public.inv_submit_count(jsonb,text,text)'::regprocedure);
  n := replace(src, $a$'Opening balance from count' || COALESCE(' · '||l.note,''));$a$,
                    $b$'Opening balance from count' || COALESCE(' · '||l.note,''), NULL, false, 'opening', v_ref);$b$);
  IF n = src THEN RAISE EXCEPTION 'inv_submit_count patch did not apply'; END IF;
  EXECUTE n;
END $mig$;
