-- Count sheet also lists ready-to-sell menu items that are not tracked yet.
-- Entering a number for one of them on the count is its opening balance:
-- stock is created (cost = latest purchase cost) and the item is tracked from then on.
DROP FUNCTION IF EXISTS public.inv_count_sheet();
CREATE FUNCTION public.inv_count_sheet()
RETURNS TABLE(item_id bigint, name text, unit text, standard_yield numeric, system_qty numeric,
              next_expiry date, last_received timestamptz, menu_names text, menu_price numeric,
              unit_cost numeric, last_counted timestamptz, tracked boolean)
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
           WHERE su.item_id = i.id AND t.reference_type = 'count'),
         inv_item_tracked(i.id)
  FROM inv_items i JOIN inv_units u ON u.id = i.base_unit_id
  WHERE i.is_active AND i.item_type = 'PURCHASED_READY'
    AND (inv_item_tracked(i.id) OR EXISTS (
          SELECT 1 FROM inv_menu_map mm JOIN menu_items m ON m.item_code = mm.menu_item_code
           WHERE mm.inv_item_id = i.id AND mm.is_active AND mm.deduct_mode = 'DIRECT' AND m.is_active))
  ORDER BY inv_item_tracked(i.id) DESC, i.name
$$;

CREATE OR REPLACE FUNCTION public.inv_submit_count(p_lines jsonb, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE l record; v_sys numeric; v_diff numeric; v_ref text; v_su record; v_res jsonb; v_name text;
        v_n int := 0; v_diffs int := 0; v_new int := 0; v_waste_cost numeric := 0; v_missing_cost numeric := 0;
        v_after numeric; v_base bigint; v_cost numeric;
BEGIN
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RETURN jsonb_build_object('ok',false,'error','Nothing to submit');
  END IF;
  FOR l IN SELECT * FROM jsonb_to_recordset(p_lines) AS x(item_id bigint, counted numeric, seen numeric, reason text, note text) LOOP
    SELECT name INTO v_name FROM inv_items WHERE id = l.item_id AND is_active;
    IF v_name IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Unknown item '||l.item_id); END IF;
    IF NOT inv_item_tracked(l.item_id) THEN
      IF l.counted IS NOT NULL AND l.counted < 0 THEN RETURN jsonb_build_object('ok',false,'error',v_name||': count cannot be negative'); END IF;
      CONTINUE;   -- opening balance: nothing to compare with
    END IF;
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
    IF NOT inv_item_tracked(l.item_id) THEN
      IF COALESCE(l.counted,0) <= 0 THEN CONTINUE; END IF;
      SELECT base_unit_id, standard_cost INTO v_base, v_cost FROM inv_items WHERE id = l.item_id;
      v_cost := COALESCE(
        (SELECT p.base_unit_cost FROM inv_purchases p WHERE p.item_id = l.item_id AND NOT COALESCE(p.is_void,false)
          AND p.base_unit_cost IS NOT NULL ORDER BY p.purchase_date DESC, p.id DESC LIMIT 1), v_cost, 0);
      v_res := inv_receive_stock(l.item_id, l.counted, v_base, v_cost, NULL, NULL, NULL, p_actor,
                                 'Opening balance from count' || COALESCE(' · '||l.note,''));
      SELECT id, quantity_remaining, unit_id INTO v_su FROM inv_stock_units WHERE id = (v_res->>'stock_unit_id')::bigint;
      INSERT INTO inv_stock_transactions (stock_unit_id, transaction_type, quantity, quantity_after, unit_id,
             reference_type, reference_id, performed_by, notes, reason)
      VALUES (v_su.id, 'count', 0, v_su.quantity_remaining, v_su.unit_id, 'count', v_ref, p_actor, 'opening balance', 'COUNTED');
      v_n := v_n + 1; v_new := v_new + 1;
      CONTINUE;
    END IF;
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
  IF v_n = 0 THEN RETURN jsonb_build_object('ok',false,'error','Enter at least one count'); END IF;
  RETURN jsonb_build_object('ok',true,'count_ref',v_ref,'items',v_n,'differences',v_diffs,'started',v_new,
                            'spoiled_cost',ROUND(v_waste_cost,2),'missing_cost',ROUND(v_missing_cost,2));
END $$;

REVOKE ALL ON FUNCTION public.inv_count_sheet() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_count_sheet() TO service_role;
REVOKE ALL ON FUNCTION public.inv_submit_count(jsonb,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_submit_count(jsonb,text) TO service_role;
