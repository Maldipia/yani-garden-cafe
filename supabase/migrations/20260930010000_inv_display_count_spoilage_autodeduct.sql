-- ══════════════════════════════════════════════════════════════════════
-- Stock Control, wired end to end (ready-to-sell items first)
--   receive (box → slices) → sale deducts on COMPLETED → sold out on menu
--   → spoilage with reason → closing count with reasons → reversal on cancel
-- Rules:
--   • An item is TRACKED once stock has ever been received for it. Nothing
--     else is touched, so switching the module on changes nothing until the
--     first Receive.
--   • A sale is never blocked or failed by stock: every hook swallows errors.
--   • No new tables. One reason (+ optional photo) column on the ledger.
-- ══════════════════════════════════════════════════════════════════════

ALTER TABLE inv_stock_transactions ADD COLUMN IF NOT EXISTS reason text;
ALTER TABLE inv_stock_transactions ADD COLUMN IF NOT EXISTS photo_url text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inv_stock_transactions_reason_chk') THEN
    ALTER TABLE inv_stock_transactions ADD CONSTRAINT inv_stock_transactions_reason_chk
      CHECK (reason IS NULL OR reason IN ('SPOILED','EXPIRED','DAMAGED','STAFF_MEAL','COMPLIMENTARY','MISSING','FOUND','COUNTED'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS inv_stock_tx_ref_idx  ON inv_stock_transactions (reference_type, reference_id);
CREATE INDEX IF NOT EXISTS inv_stock_tx_perf_idx ON inv_stock_transactions (performed_at);
CREATE INDEX IF NOT EXISTS inv_stock_units_item_idx ON inv_stock_units (item_id);

-- ── helpers ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.inv_item_tracked(p_item_id bigint)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (SELECT 1 FROM inv_stock_units WHERE item_id = p_item_id)
$$;

CREATE OR REPLACE FUNCTION public.inv_item_available(p_item_id bigint)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE(SUM(inv_convert(su.quantity_remaining, su.unit_id, i.base_unit_id)), 0)
  FROM inv_stock_units su JOIN inv_items i ON i.id = su.item_id
  WHERE su.item_id = p_item_id
    AND su.status IN ('in_stock','opened','partially_used')
    AND su.quantity_remaining > 0
$$;

-- Take stock out FEFO/FIFO, up to what exists. Never raises for a shortage.
CREATE OR REPLACE FUNCTION public.inv_take_stock(
  p_item_id bigint, p_qty numeric, p_type text, p_reason text,
  p_ref_type text, p_ref_id text, p_actor text, p_notes text DEFAULT NULL, p_photo text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_base bigint; v_fefo boolean; v_need numeric := p_qty; v_su record;
        v_take numeric; v_after numeric; v_cost numeric := 0; v_units int := 0; v_taken numeric := 0;
BEGIN
  IF p_type NOT IN ('consume','waste','count') THEN RETURN jsonb_build_object('ok',false,'error','bad_type'); END IF;
  IF p_qty IS NULL OR p_qty <= 0 THEN RETURN jsonb_build_object('ok',true,'taken',0,'shortfall',0,'cost',0,'units',0); END IF;
  SELECT base_unit_id INTO v_base FROM inv_items WHERE id = p_item_id;
  IF v_base IS NULL THEN RETURN jsonb_build_object('ok',false,'error','item_not_found'); END IF;
  v_fefo := (inv_cfg('costing_method') = 'FEFO');

  FOR v_su IN
    SELECT id, quantity_remaining, unit_id, unit_cost FROM inv_stock_units
    WHERE item_id = p_item_id AND status IN ('in_stock','opened','partially_used') AND quantity_remaining > 0
    ORDER BY CASE WHEN v_fefo THEN expiry_date END NULLS LAST, date_received, id
    FOR UPDATE
  LOOP
    EXIT WHEN v_need <= 0;
    v_take  := LEAST(v_need, inv_convert(v_su.quantity_remaining, v_su.unit_id, v_base));
    v_after := v_su.quantity_remaining - inv_convert(v_take, v_base, v_su.unit_id);
    UPDATE inv_stock_units
       SET quantity_remaining = v_after,
           status = CASE WHEN v_after <= 0 THEN (CASE WHEN p_type='waste' THEN 'wasted' ELSE 'consumed' END)
                         ELSE 'partially_used' END,
           updated_at = now()
     WHERE id = v_su.id;
    INSERT INTO inv_stock_transactions
      (stock_unit_id, transaction_type, quantity, quantity_after, unit_id, reference_type, reference_id,
       performed_by, notes, reason, photo_url)
    VALUES (v_su.id, p_type, -inv_convert(v_take, v_base, v_su.unit_id), v_after, v_su.unit_id,
            p_ref_type, p_ref_id, p_actor, p_notes, p_reason, p_photo);
    v_cost  := v_cost + inv_convert(v_take, v_base, v_su.unit_id) * COALESCE(v_su.unit_cost, 0);
    v_units := v_units + 1; v_taken := v_taken + v_take; v_need := v_need - v_take;
  END LOOP;

  RETURN jsonb_build_object('ok',true,'taken',v_taken,'shortfall',GREATEST(v_need,0),
                            'cost',ROUND(v_cost,4),'units',v_units);
END $$;

-- ── Receive: a pack of a portioned item becomes its portions ─────────────
-- "1 box" of Buco Melt Pie (yield 8, stocked in slices) → 8 slices, cost ÷ 8.
CREATE OR REPLACE FUNCTION public.inv_receive_stock(p_item_id bigint, p_qty numeric, p_unit_id bigint, p_unit_cost numeric DEFAULT 0, p_supplier_id bigint DEFAULT NULL::bigint, p_location_id bigint DEFAULT NULL::bigint, p_expiry date DEFAULT NULL::date, p_actor text DEFAULT 'SYSTEM'::text, p_notes text DEFAULT NULL::text, p_expected_use date DEFAULT NULL::date, p_split_units boolean DEFAULT false)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_type text; v_code text; v_su bigint; v_batch bigint; v_loc bigint;
  v_n int; v_i int; v_each numeric; v_codes jsonb := '[]'::jsonb; v_ids jsonb := '[]'::jsonb;
  v_base bigint; v_yield numeric; v_qty numeric := p_qty; v_unit bigint := p_unit_id; v_cost numeric := COALESCE(p_unit_cost,0);
  v_packed boolean := false;
BEGIN
  IF p_qty IS NULL OR p_qty <= 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'bad_qty'); END IF;
  SELECT item_type, base_unit_id, standard_yield INTO v_type, v_base, v_yield FROM inv_items WHERE id = p_item_id AND is_active;
  IF v_type IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'item_not_found'); END IF;
  IF NOT EXISTS (SELECT 1 FROM inv_units WHERE id = p_unit_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unit_not_found'); END IF;

  IF v_yield IS NOT NULL AND v_yield > 0 AND p_unit_id <> v_base
     AND (SELECT name FROM inv_units WHERE id = v_base)   IN ('slice','serving')
     AND (SELECT name FROM inv_units WHERE id = p_unit_id) IN ('whole','box','pack','tray','pc') THEN
    v_qty := p_qty * v_yield; v_unit := v_base; v_cost := v_cost / v_yield; v_packed := true;
  END IF;

  v_loc := COALESCE(p_location_id, (SELECT id FROM inv_locations WHERE name = inv_cfg('default_location')));

  IF p_supplier_id IS NOT NULL OR p_expiry IS NOT NULL THEN
    INSERT INTO inv_batches(item_id, batch_code, supplier_id, expiry_date, notes)
    VALUES (p_item_id, 'B-' || to_char(clock_timestamp(),'YYMMDD') || '-' || nextval('inv_seq_batch'),
            p_supplier_id, p_expiry, p_notes)
    RETURNING id INTO v_batch;
  END IF;

  v_n    := CASE WHEN p_split_units AND NOT v_packed THEN GREATEST(1, FLOOR(v_qty)::int) ELSE 1 END;
  v_each := CASE WHEN p_split_units AND NOT v_packed THEN v_qty / v_n ELSE v_qty END;

  FOR v_i IN 1..v_n LOOP
    v_code := inv_next_stock_code(v_type);
    INSERT INTO inv_stock_units
      (stock_unit_code, item_id, batch_id, quantity_original, quantity_remaining,
       unit_id, unit_cost, status, location_id, expiry_date, expected_use_date, created_by, notes)
    VALUES (v_code, p_item_id, v_batch, v_each, v_each, v_unit, ROUND(v_cost,4),
            'in_stock', v_loc, p_expiry, p_expected_use, p_actor, p_notes)
    RETURNING id INTO v_su;
    INSERT INTO inv_stock_transactions
      (stock_unit_id, transaction_type, quantity, quantity_after, unit_id, reference_type, performed_by, notes)
    VALUES (v_su, 'receive', v_each, v_each, v_unit, 'purchase', p_actor,
            CASE WHEN v_packed THEN COALESCE(p_notes||' · ','') || p_qty || ' × ' || v_yield || ' = ' || v_qty
                 ELSE p_notes END);
    v_codes := v_codes || to_jsonb(v_code);
    v_ids   := v_ids   || to_jsonb(v_su);
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'units_created', v_n, 'stock_unit_id', v_su,
                            'stock_unit_code', v_code, 'stock_unit_ids', v_ids,
                            'stock_unit_codes', v_codes, 'batch_id', v_batch,
                            'qty_received', v_qty, 'converted_from_packs', v_packed);
END;
$function$;

-- ── Sale: deduct tracked items for one order (idempotent, never raises) ──
CREATE OR REPLACE FUNCTION public.inv_consume_order(p_order_id text, p_actor text DEFAULT 'SYSTEM'::text, p_dry_run boolean DEFAULT false)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_line record; v_ing record; v_res jsonb; v_rc int; v_need numeric;
  v_direct int := 0; v_rec int := 0; v_skip int := 0;
  v_short jsonb := '[]'::jsonb; v_cost numeric := 0;
BEGIN
  IF inv_cfg('module_enabled') <> 'true' THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'module_disabled');
  END IF;
  IF p_order_id IS NULL OR btrim(p_order_id) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_order_id');
  END IF;
  -- An order row can arrive before its items (offline sync). No guard until items exist.
  IF NOT EXISTS (SELECT 1 FROM dine_in_order_items WHERE order_id = p_order_id) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'no_items');
  END IF;

  IF NOT p_dry_run THEN
    INSERT INTO stock_consumption_guard(order_id, actor_id) VALUES (p_order_id, p_actor)
    ON CONFLICT (order_id) DO NOTHING;
    GET DIAGNOSTICS v_rc = ROW_COUNT;
    IF v_rc = 0 THEN
      RETURN jsonb_build_object('ok', true, 'already_consumed', true, 'order_id', p_order_id);
    END IF;
  END IF;

  FOR v_line IN
    SELECT oi.item_code,
           SUM(oi.qty * CASE WHEN lower(COALESCE(oi.size_choice,'')) = 'whole' AND ii.standard_yield > 0
                             THEN ii.standard_yield ELSE 1 END)::numeric AS qty,
           mm.inv_item_id, mm.deduct_mode, COALESCE(mm.portions_per_sale,1) AS pps
    FROM dine_in_order_items oi
    LEFT JOIN inv_menu_map mm ON mm.menu_item_code = oi.item_code AND mm.is_active AND mm.sell_form = 'WHOLE'
    LEFT JOIN inv_items ii ON ii.id = mm.inv_item_id
    WHERE oi.order_id = p_order_id
    GROUP BY oi.item_code, mm.inv_item_id, mm.deduct_mode, mm.portions_per_sale
  LOOP
    IF v_line.inv_item_id IS NULL OR v_line.deduct_mode = 'NONE' THEN v_skip := v_skip + 1; CONTINUE; END IF;

    IF v_line.deduct_mode = 'DIRECT' THEN
      IF NOT inv_item_tracked(v_line.inv_item_id) THEN v_skip := v_skip + 1; CONTINUE; END IF;
      v_need := v_line.qty * v_line.pps;
      IF NOT p_dry_run THEN
        BEGIN
          v_res := inv_take_stock(v_line.inv_item_id, v_need, 'consume', NULL, 'sale', p_order_id, p_actor,
                                  'sale ' || v_line.item_code);
          v_cost := v_cost + COALESCE((v_res->>'cost')::numeric,0);
          IF COALESCE((v_res->>'shortfall')::numeric,0) > 0 THEN
            v_short := v_short || jsonb_build_object('item', v_line.item_code, 'short', (v_res->>'shortfall')::numeric);
          END IF;
        EXCEPTION WHEN OTHERS THEN
          v_short := v_short || jsonb_build_object('item', v_line.item_code, 'error', SQLERRM);
        END;
      END IF;
      v_direct := v_direct + 1;

    ELSIF v_line.deduct_mode = 'RECIPE' THEN
      FOR v_ing IN
        SELECT ri.ingredient_item_id, ri.quantity, ri.unit_id, COALESCE(ri.yield_loss_pct,0) AS yl, ii.name, ii.base_unit_id
        FROM inv_recipes r
        JOIN inv_recipe_ingredients ri ON ri.recipe_id = r.id
        JOIN inv_items ii ON ii.id = ri.ingredient_item_id
        WHERE r.item_id = v_line.inv_item_id AND r.is_active
      LOOP
        IF NOT inv_item_tracked(v_ing.ingredient_item_id) THEN CONTINUE; END IF;
        IF NOT p_dry_run THEN
          BEGIN
            v_need := inv_convert(v_ing.quantity * v_line.qty * (100.0 / (100.0 - v_ing.yl)), v_ing.unit_id, v_ing.base_unit_id);
            v_res := inv_take_stock(v_ing.ingredient_item_id, v_need, 'consume', NULL, 'sale', p_order_id, p_actor,
                                    'sale ' || v_line.item_code);
            v_cost := v_cost + COALESCE((v_res->>'cost')::numeric,0);
            IF COALESCE((v_res->>'shortfall')::numeric,0) > 0 THEN
              v_short := v_short || jsonb_build_object('ingredient', v_ing.name, 'short', (v_res->>'shortfall')::numeric);
            END IF;
          EXCEPTION WHEN OTHERS THEN
            v_short := v_short || jsonb_build_object('ingredient', v_ing.name, 'error', SQLERRM);
          END;
        END IF;
        v_rec := v_rec + 1;
      END LOOP;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'order_id', p_order_id, 'dry_run', p_dry_run,
                            'direct_lines', v_direct, 'recipe_deductions', v_rec,
                            'skipped', v_skip, 'cogs', ROUND(v_cost,4), 'shortfalls', v_short);
END;
$function$;

-- ── Cancel / delete a consumed order: put its stock back ───────────────
CREATE OR REPLACE FUNCTION public.inv_reverse_order(p_order_id text, p_actor text DEFAULT 'SYSTEM')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE t record; v_after numeric; v_n int := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM stock_consumption_guard WHERE order_id = p_order_id) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'not_consumed');
  END IF;
  FOR t IN
    SELECT x.* FROM inv_stock_transactions x
    WHERE x.reference_type = 'sale' AND x.reference_id = p_order_id AND x.transaction_type = 'consume'
      AND x.quantity < 0
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
       performed_by, notes, parent_txn_id)
    VALUES (t.stock_unit_id, 'return', -t.quantity, v_after, t.unit_id, 'sale_reversal', p_order_id,
            p_actor, 'order cancelled — stock returned', t.id);
    v_n := v_n + 1;
  END LOOP;
  DELETE FROM stock_consumption_guard WHERE order_id = p_order_id;
  RETURN jsonb_build_object('ok', true, 'order_id', p_order_id, 'reversed_lines', v_n);
END $$;

-- ── Hooks on orders: every path that completes / cancels / deletes ─────
CREATE OR REPLACE FUNCTION public.trg_inv_order_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_new_live boolean; v_old_live boolean; v_old_gone boolean; v_new_gone boolean;
BEGIN
  IF inv_cfg('module_enabled') IS DISTINCT FROM 'true' THEN RETURN NEW; END IF;
  v_new_live := NEW.status = 'COMPLETED' AND NOT COALESCE(NEW.is_deleted,false) AND NOT COALESCE(NEW.is_test,false);
  v_old_live := OLD.status = 'COMPLETED' AND NOT COALESCE(OLD.is_deleted,false) AND NOT COALESCE(OLD.is_test,false);
  v_new_gone := NEW.status = 'CANCELLED' OR COALESCE(NEW.is_deleted,false);
  v_old_gone := OLD.status = 'CANCELLED' OR COALESCE(OLD.is_deleted,false);
  BEGIN
    IF v_new_live AND NOT v_old_live THEN
      PERFORM inv_consume_order(NEW.order_id, 'SYSTEM', false);
    ELSIF v_new_gone AND NOT v_old_gone THEN
      PERFORM inv_reverse_order(NEW.order_id, 'SYSTEM');
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'inventory hook skipped for %: %', NEW.order_id, SQLERRM;
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_inv_order_status ON dine_in_orders;
CREATE TRIGGER trg_inv_order_status
  AFTER UPDATE OF status, is_deleted ON dine_in_orders
  FOR EACH ROW EXECUTE FUNCTION trg_inv_order_status();

-- Items that arrive for an order already COMPLETED (offline sync inserts the
-- order as COMPLETED first, then its items).
CREATE OR REPLACE FUNCTION public.trg_inv_items_added()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE o record;
BEGIN
  IF inv_cfg('module_enabled') IS DISTINCT FROM 'true' THEN RETURN NULL; END IF;
  FOR o IN
    SELECT DISTINCT d.order_id FROM new_items n JOIN dine_in_orders d ON d.order_id = n.order_id
    WHERE d.status = 'COMPLETED' AND NOT COALESCE(d.is_deleted,false) AND NOT COALESCE(d.is_test,false)
  LOOP
    BEGIN
      PERFORM inv_consume_order(o.order_id, 'SYSTEM', false);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'inventory hook skipped for %: %', o.order_id, SQLERRM;
    END;
  END LOOP;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_inv_items_added ON dine_in_order_items;
CREATE TRIGGER trg_inv_items_added
  AFTER INSERT ON dine_in_order_items
  REFERENCING NEW TABLE AS new_items
  FOR EACH STATEMENT EXECUTE FUNCTION trg_inv_items_added();

-- ── Spoilage ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.inv_record_spoilage(
  p_item_id bigint, p_qty numeric, p_reason text, p_notes text, p_actor text, p_photo text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_avail numeric; v_res jsonb; v_name text;
BEGIN
  IF p_reason NOT IN ('SPOILED','EXPIRED','DAMAGED','STAFF_MEAL','COMPLIMENTARY') THEN
    RETURN jsonb_build_object('ok',false,'error','Pick a reason');
  END IF;
  IF p_qty IS NULL OR p_qty <= 0 THEN RETURN jsonb_build_object('ok',false,'error','Enter a quantity'); END IF;
  SELECT name INTO v_name FROM inv_items WHERE id = p_item_id;
  IF v_name IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Item not found'); END IF;
  v_avail := inv_item_available(p_item_id);
  IF p_qty > v_avail + 0.0001 THEN
    RETURN jsonb_build_object('ok',false,'error', v_name || ': only ' || trim(to_char(v_avail,'FM999999990.##')) || ' in stock');
  END IF;
  v_res := inv_take_stock(p_item_id, p_qty, 'waste', p_reason, 'spoilage', NULL, p_actor, p_notes, p_photo);
  RETURN v_res || jsonb_build_object('item', v_name, 'remaining', inv_item_available(p_item_id));
END $$;

-- ── Closing count sheet: tracked ready-to-sell items ─────────────────────
CREATE OR REPLACE FUNCTION public.inv_count_sheet()
RETURNS TABLE(item_id bigint, name text, unit text, standard_yield numeric, system_qty numeric,
              next_expiry date, last_received timestamptz, menu_names text, menu_price numeric,
              unit_cost numeric, last_counted timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT i.id, i.name, u.name, i.standard_yield,
         ROUND(inv_item_available(i.id), 3),
         (SELECT min(su.expiry_date) FROM inv_stock_units su WHERE su.item_id = i.id
            AND su.status IN ('in_stock','opened','partially_used') AND su.quantity_remaining > 0),
         (SELECT max(su.date_received) FROM inv_stock_units su WHERE su.item_id = i.id),
         (SELECT string_agg(m.name, ' · ' ORDER BY m.name) FROM inv_menu_map mm
            JOIN menu_items m ON m.item_code = mm.menu_item_code
           WHERE mm.inv_item_id = i.id AND mm.is_active AND m.is_active),
         (SELECT min(m.base_price) FROM inv_menu_map mm JOIN menu_items m ON m.item_code = mm.menu_item_code
           WHERE mm.inv_item_id = i.id AND mm.is_active AND m.is_active AND mm.deduct_mode = 'DIRECT'
             AND COALESCE(mm.portions_per_sale,1) = 1),
         (SELECT su.unit_cost FROM inv_stock_units su WHERE su.item_id = i.id ORDER BY su.date_received DESC, su.id DESC LIMIT 1),
         (SELECT max(t.performed_at) FROM inv_stock_transactions t JOIN inv_stock_units su ON su.id = t.stock_unit_id
           WHERE su.item_id = i.id AND t.reference_type = 'count')
  FROM inv_items i JOIN inv_units u ON u.id = i.base_unit_id
  WHERE i.is_active AND i.item_type = 'PURCHASED_READY' AND inv_item_tracked(i.id)
  ORDER BY i.name
$$;

-- ── Submit a count. Lines: [{item_id, counted, seen, reason, note}] ──────
CREATE OR REPLACE FUNCTION public.inv_submit_count(p_lines jsonb, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE l record; v_sys numeric; v_diff numeric; v_ref text; v_su record; v_res jsonb; v_name text;
        v_n int := 0; v_diffs int := 0; v_waste_cost numeric := 0; v_missing_cost numeric := 0; v_after numeric;
BEGIN
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RETURN jsonb_build_object('ok',false,'error','Nothing to submit');
  END IF;
  -- validate everything first; change nothing unless all lines are good
  FOR l IN SELECT * FROM jsonb_to_recordset(p_lines) AS x(item_id bigint, counted numeric, seen numeric, reason text, note text) LOOP
    SELECT name INTO v_name FROM inv_items WHERE id = l.item_id;
    IF v_name IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Unknown item '||l.item_id); END IF;
    IF l.counted IS NULL OR l.counted < 0 THEN RETURN jsonb_build_object('ok',false,'error',v_name||': enter the count'); END IF;
    v_sys := inv_item_available(l.item_id);
    IF l.seen IS NOT NULL AND abs(l.seen - v_sys) > 0.0001 THEN
      RETURN jsonb_build_object('ok',false,'error',v_name||' changed while counting (a sale or spoilage). Reload and count again.','stock_changed',true);
    END IF;
    v_diff := l.counted - v_sys;
    IF v_diff < -0.0001 AND COALESCE(l.reason,'') NOT IN ('SPOILED','EXPIRED','DAMAGED','STAFF_MEAL','COMPLIMENTARY','MISSING') THEN
      RETURN jsonb_build_object('ok',false,'error',v_name||': pick a reason for the missing '||trim(to_char(-v_diff,'FM999999990.##')));
    END IF;
  END LOOP;

  v_ref := 'COUNT-' || to_char(clock_timestamp() AT TIME ZONE 'Asia/Manila', 'YYYYMMDD-HH24MISS');
  FOR l IN SELECT * FROM jsonb_to_recordset(p_lines) AS x(item_id bigint, counted numeric, seen numeric, reason text, note text) LOOP
    v_sys := inv_item_available(l.item_id);
    v_diff := l.counted - v_sys;
    v_n := v_n + 1;
    IF abs(v_diff) <= 0.0001 THEN
      SELECT id, quantity_remaining, unit_id INTO v_su FROM inv_stock_units WHERE item_id = l.item_id
       ORDER BY (status IN ('in_stock','opened','partially_used') AND quantity_remaining > 0) DESC, expiry_date NULLS LAST, date_received DESC, id DESC LIMIT 1;
      INSERT INTO inv_stock_transactions (stock_unit_id, transaction_type, quantity, quantity_after, unit_id,
             reference_type, reference_id, performed_by, notes, reason)
      VALUES (v_su.id, 'count', 0, v_su.quantity_remaining, v_su.unit_id, 'count', v_ref, p_actor, l.note, 'COUNTED');
    ELSIF v_diff < 0 THEN
      v_diffs := v_diffs + 1;
      IF l.reason = 'MISSING' THEN
        v_res := inv_take_stock(l.item_id, -v_diff, 'count', 'MISSING', 'count', v_ref, p_actor, l.note);
        v_missing_cost := v_missing_cost + COALESCE((v_res->>'cost')::numeric,0);
      ELSE
        v_res := inv_take_stock(l.item_id, -v_diff, 'waste', l.reason, 'count', v_ref, p_actor, l.note);
        v_waste_cost := v_waste_cost + COALESCE((v_res->>'cost')::numeric,0);
      END IF;
    ELSE
      v_diffs := v_diffs + 1;
      SELECT su.id, su.unit_id, i.base_unit_id INTO v_su FROM inv_stock_units su JOIN inv_items i ON i.id = su.item_id
       WHERE su.item_id = l.item_id ORDER BY su.date_received DESC, su.id DESC LIMIT 1;
      UPDATE inv_stock_units
         SET quantity_remaining = quantity_remaining + inv_convert(v_diff, v_su.base_unit_id, v_su.unit_id),
             status = CASE WHEN status IN ('consumed','wasted','expired') THEN 'partially_used' ELSE status END,
             updated_at = now()
       WHERE id = v_su.id RETURNING quantity_remaining INTO v_after;
      INSERT INTO inv_stock_transactions (stock_unit_id, transaction_type, quantity, quantity_after, unit_id,
             reference_type, reference_id, performed_by, notes, reason)
      VALUES (v_su.id, 'count', inv_convert(v_diff, v_su.base_unit_id, v_su.unit_id), v_after, v_su.unit_id,
              'count', v_ref, p_actor, l.note, 'FOUND');
    END IF;
  END LOOP;
  RETURN jsonb_build_object('ok',true,'count_ref',v_ref,'items',v_n,'differences',v_diffs,
                            'spoiled_cost',ROUND(v_waste_cost,2),'missing_cost',ROUND(v_missing_cost,2));
END $$;

-- ── Day log: counts, spoilage, missing/found, for one Manila date ─────────
CREATE OR REPLACE FUNCTION public.inv_day_log(p_date date)
RETURNS TABLE(txn_id bigint, performed_at timestamptz, item_id bigint, item_name text, unit text,
              qty numeric, kind text, reason text, notes text, photo_url text, performed_by text,
              performed_by_name text, reference_id text, value_cost numeric, value_menu numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT t.id, t.performed_at, i.id, i.name, bu.name,
         inv_convert(t.quantity, t.unit_id, i.base_unit_id),
         CASE WHEN t.reference_type = 'count' THEN 'COUNT' ELSE 'SPOILAGE' END,
         COALESCE(t.reason, CASE WHEN t.transaction_type='waste' THEN 'SPOILED' END),
         t.notes, t.photo_url, t.performed_by,
         (SELECT su2.display_name FROM staff_users su2 WHERE su2.user_id = t.performed_by LIMIT 1),
         t.reference_id,
         ROUND(abs(t.quantity) * COALESCE(su.unit_cost,0), 2),
         ROUND(abs(inv_convert(t.quantity, t.unit_id, i.base_unit_id)) *
               COALESCE((SELECT min(m.base_price) FROM inv_menu_map mm JOIN menu_items m ON m.item_code = mm.menu_item_code
                          WHERE mm.inv_item_id = i.id AND mm.is_active AND mm.deduct_mode='DIRECT'
                            AND COALESCE(mm.portions_per_sale,1) = 1), 0), 2)
  FROM inv_stock_transactions t
  JOIN inv_stock_units su ON su.id = t.stock_unit_id
  JOIN inv_items i ON i.id = su.item_id
  JOIN inv_units bu ON bu.id = i.base_unit_id
  WHERE (t.performed_at AT TIME ZONE 'Asia/Manila')::date = p_date
    AND (t.transaction_type = 'waste' OR t.reference_type = 'count')
  ORDER BY t.performed_at DESC, t.id DESC
$$;

-- ── Menu availability (sold out) for tracked DIRECT items ──────────────
CREATE OR REPLACE FUNCTION public.inv_menu_availability()
RETURNS TABLE(menu_item_code text, inv_item_id bigint, portions_per_sale numeric, item_available numeric, available int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT mm.menu_item_code, mm.inv_item_id, COALESCE(mm.portions_per_sale,1),
         inv_item_available(mm.inv_item_id),
         FLOOR(inv_item_available(mm.inv_item_id) / GREATEST(COALESCE(mm.portions_per_sale,1), 0.0001))::int
  FROM inv_menu_map mm JOIN inv_items i ON i.id = mm.inv_item_id
  WHERE inv_cfg('module_enabled') = 'true'
    AND mm.is_active AND mm.deduct_mode = 'DIRECT' AND mm.sell_form = 'WHOLE'
    AND i.is_active AND inv_item_tracked(i.id)
$$;

-- Menu cache stamp also changes when stock moves, so sold-out shows at once.
CREATE OR REPLACE FUNCTION public.menu_version()
 RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT count(*)::text || '|' || COALESCE(max(updated_at)::text, '')
         || '|' || COALESCE((SELECT max(id) FROM inv_stock_transactions)::text, '')
         || '|' || COALESCE((SELECT value FROM inv_config WHERE key = 'module_enabled'), '')
  FROM menu_items;
$function$;

-- ── Lock down: service_role only (API server) ────────────────────────────
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.inv_item_tracked(bigint)', 'public.inv_item_available(bigint)',
    'public.inv_take_stock(bigint,numeric,text,text,text,text,text,text,text)',
    'public.inv_reverse_order(text,text)', 'public.trg_inv_order_status()', 'public.trg_inv_items_added()',
    'public.inv_record_spoilage(bigint,numeric,text,text,text,text)', 'public.inv_count_sheet()',
    'public.inv_submit_count(jsonb,text)', 'public.inv_day_log(date)', 'public.inv_menu_availability()',
    'public.inv_receive_stock(bigint,numeric,bigint,numeric,bigint,bigint,date,text,text,date,boolean)',
    'public.inv_consume_order(text,text,boolean)', 'public.menu_version()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;
