-- Menu Stock shows cost per unit, and the owner can fill in a missing cost.
-- Costs are never edited in place: a batch with no cost (₱0) is moved, same quantity, into a new batch
-- at the given cost with two linked STOCK ADJUSTMENT movements (reason CORRECTION). Real costs are never overwritten.
DROP FUNCTION IF EXISTS public.inv_menu_stock(date);
CREATE FUNCTION public.inv_menu_stock(p_date date DEFAULT NULL)
RETURNS TABLE(row_key text, kind text, item_id bigint, menu_code text, name text, category text, menus text,
              unit text, available numeric, sold numeric, added numeric, wasted numeric, fixed numeric,
              price numeric, purchase_unit_id bigint, purchase_unit text, purchase_to_stock numeric,
              base_unit_id bigint, next_expiry date, last_at timestamptz, open_shortages int, cat_order int, unit_cost numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  WITH d AS (SELECT (COALESCE(p_date, (now() AT TIME ZONE 'Asia/Manila')::date)::timestamp AT TIME ZONE 'Asia/Manila') AS f),
  menu AS (
    SELECT m.item_code, m.name, m.base_price, c.name AS cat, COALESCE(c.display_order, 999) AS cat_sort,
           mm.inv_item_id, mm.deduct_mode
    FROM menu_items m
    LEFT JOIN menu_categories c ON c.id = m.category_id
    LEFT JOIN inv_menu_map mm ON mm.menu_item_code = m.item_code AND mm.is_active AND mm.sell_form = 'WHOLE'
    WHERE m.is_active AND upper(COALESCE(c.name,'')) <> 'BEST WITH'),
  tracked AS (   -- one row per stocked item (several menu items can share one, e.g. Buco + Buco w/ coffee)
    SELECT i.id, i.name, i.base_unit_id, i.purchase_unit_id, i.purchase_to_stock,
           (array_agg(me.cat ORDER BY me.cat_sort, me.name))[1] AS cat,
           (array_agg(me.item_code ORDER BY me.base_price, me.name))[1] AS code,
           string_agg(me.name, ' · ' ORDER BY me.base_price, me.name) AS menus,
           MIN(me.base_price) AS price,
           (array_agg(me.cat_sort ORDER BY me.cat_sort, me.name))[1] AS cat_sort
    FROM menu me JOIN inv_items i ON i.id = me.inv_item_id AND i.is_active
    WHERE me.deduct_mode = 'DIRECT' AND inv_item_tracked(i.id)
    GROUP BY i.id, i.name, i.base_unit_id, i.purchase_unit_id, i.purchase_to_stock),
  mv AS (
    SELECT su.item_id,
      SUM(-inv_convert(t.quantity, t.unit_id, i.base_unit_id)) FILTER (WHERE t.movement_type IN ('POS SALE','ONLINE SALE','POS VOID','ONLINE VOID','POS RETURN')) AS sold,
      SUM(inv_convert(t.quantity, t.unit_id, i.base_unit_id)) FILTER (WHERE t.movement_type IN ('PURCHASE','OPENING BALANCE','PRODUCTION')) AS added,
      SUM(-inv_convert(t.quantity, t.unit_id, i.base_unit_id)) FILTER (WHERE t.movement_type IN ('WASTE','SPOILAGE','BREAKAGE','STAFF MEAL','COMPLIMENTARY')) AS wasted,
      SUM(inv_convert(t.quantity, t.unit_id, i.base_unit_id)) FILTER (WHERE t.movement_type IN ('STOCK COUNT','STOCK ADJUSTMENT')) AS fixed
    FROM inv_stock_transactions t JOIN inv_stock_units su ON su.id = t.stock_unit_id JOIN inv_items i ON i.id = su.item_id, d
    WHERE t.performed_at >= d.f AND t.performed_at < d.f + interval '1 day'
    GROUP BY su.item_id)
  SELECT 'I' || t.id, 'TRACKED', t.id, t.code, t.name, t.cat, t.menus, u.name,
         ROUND(inv_item_available(t.id), 3),
         ROUND(COALESCE(mv.sold,0),3), ROUND(COALESCE(mv.added,0),3), ROUND(COALESCE(mv.wasted,0),3), ROUND(COALESCE(mv.fixed,0),3),
         t.price, t.purchase_unit_id, pu.name, t.purchase_to_stock, t.base_unit_id,
         (SELECT MIN(su.expiry_date) FROM inv_stock_units su WHERE su.item_id = t.id AND su.quantity_remaining > 0
             AND su.status IN ('in_stock','opened','partially_used')),
         (SELECT MAX(x.performed_at) FROM inv_stock_transactions x JOIN inv_stock_units su ON su.id = x.stock_unit_id WHERE su.item_id = t.id AND x.quantity <> 0),
         (SELECT count(*)::int FROM inv_stock_exceptions e WHERE e.item_id = t.id AND e.status = 'OPEN'),
         t.cat_sort,
         (SELECT ROUND(COALESCE(SUM(su.quantity_remaining * su.unit_cost) / NULLIF(SUM(su.quantity_remaining) FILTER (WHERE su.unit_cost > 0),0), NULL), 2)
            FROM inv_stock_units su WHERE su.item_id = t.id AND su.quantity_remaining > 0 AND su.unit_cost > 0)
  FROM tracked t JOIN inv_units u ON u.id = t.base_unit_id LEFT JOIN inv_units pu ON pu.id = t.purchase_unit_id
  LEFT JOIN mv ON mv.item_id = t.id
  UNION ALL
  -- menu items with no stock yet: type a quantity to start tracking
  SELECT 'M' || me.item_code, 'NEW', NULL, me.item_code, me.name, me.cat, me.name, 'pc', NULL, NULL, NULL, NULL, NULL,
         me.base_price, NULL, NULL, NULL, NULL, NULL, NULL, 0, me.cat_sort, NULL::numeric
  FROM menu me
  WHERE COALESCE(me.deduct_mode,'') <> 'RECIPE'
    AND NOT (me.deduct_mode = 'DIRECT' AND me.inv_item_id IS NOT NULL AND inv_item_tracked(me.inv_item_id))
  UNION ALL
  -- made to order from a recipe (drinks): no count, stock comes from ingredients
  SELECT 'R' || me.item_code, 'RECIPE', me.inv_item_id, me.item_code, me.name, me.cat, me.name, NULL, NULL, NULL, NULL, NULL, NULL,
         me.base_price, NULL, NULL, NULL, NULL, NULL, NULL, 0, me.cat_sort, NULL::numeric
  FROM menu me WHERE me.deduct_mode = 'RECIPE'
$$;

REVOKE ALL ON FUNCTION public.inv_menu_stock(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_menu_stock(date) TO service_role;

CREATE OR REPLACE FUNCTION public.inv_menu_set_cost(p_item_id bigint, p_unit_cost numeric, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE it record; su record; v_ref text; v_new bigint; v_code text; v_out bigint; n int := 0; q numeric := 0;
BEGIN
  IF p_unit_cost IS NULL OR p_unit_cost <= 0 THEN RETURN jsonb_build_object('ok',false,'error','Enter the cost'); END IF;
  SELECT * INTO it FROM inv_items WHERE id = p_item_id AND is_active;
  IF it.id IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Item not found'); END IF;
  v_ref := 'ADJ-' || lpad(nextval('inv_seq_adjust')::text, 5, '0');
  FOR su IN SELECT * FROM inv_stock_units WHERE item_id = p_item_id AND quantity_remaining > 0
            AND COALESCE(unit_cost,0) = 0 AND status IN ('in_stock','opened','partially_used') FOR UPDATE LOOP
    -- out of the no-cost batch
    UPDATE inv_stock_units SET quantity_remaining = 0, status = 'consumed', updated_at = now() WHERE id = su.id;
    INSERT INTO inv_stock_transactions (stock_unit_id, transaction_type, quantity, quantity_after, unit_id, reference_type,
           reference_id, performed_by, notes, reason, source_ref, unit_cost, cost_impact, movement_type)
    VALUES (su.id, 'adjust', -su.quantity_remaining, 0, su.unit_id, 'cost_correction', v_ref, p_actor,
            'Cost correction: no cost recorded → ₱' || trim(to_char(p_unit_cost,'FM999999990.00')) || ' per unit (quantity unchanged)',
            'CORRECTION', v_ref, 0, 0, 'STOCK ADJUSTMENT')
    RETURNING id INTO v_out;
    -- into a batch at the real cost, same quantity / expiry / location
    v_code := inv_next_stock_code(it.item_type);
    INSERT INTO inv_stock_units (stock_unit_code, item_id, batch_id, quantity_original, quantity_remaining, unit_id, unit_cost,
           status, location_id, expiry_date, expected_use_date, created_by, notes, date_received)
    VALUES (v_code, p_item_id, su.batch_id, su.quantity_remaining, su.quantity_remaining, su.unit_id, p_unit_cost,
            'in_stock', su.location_id, su.expiry_date, su.expected_use_date, p_actor,
            'Cost correction of ' || su.stock_unit_code, su.date_received)
    RETURNING id INTO v_new;
    INSERT INTO inv_stock_transactions (stock_unit_id, transaction_type, quantity, quantity_after, unit_id, reference_type,
           reference_id, performed_by, notes, reason, source_ref, unit_cost, movement_type, parent_txn_id)
    VALUES (v_new, 'adjust', su.quantity_remaining, su.quantity_remaining, su.unit_id, 'cost_correction', v_ref, p_actor,
            'Cost correction of ' || su.stock_unit_code || ': ₱' || trim(to_char(p_unit_cost,'FM999999990.00')) || ' per unit',
            'CORRECTION', v_ref, p_unit_cost, 'STOCK ADJUSTMENT', NULL);
    n := n + 1; q := q + su.quantity_remaining;
  END LOOP;
  UPDATE inv_items SET standard_cost = p_unit_cost, updated_at = now() WHERE id = p_item_id;
  RETURN jsonb_build_object('ok',true,'source_ref',v_ref,'batches_corrected',n,'qty',q,'unit_cost',p_unit_cost,
                            'available', inv_item_available(p_item_id));
END $$;
REVOKE ALL ON FUNCTION public.inv_menu_set_cost(bigint,numeric,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_menu_set_cost(bigint,numeric,text) TO service_role;
