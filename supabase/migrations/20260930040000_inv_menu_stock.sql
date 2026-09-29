-- Menu Stock: one list of every menu item with what's available now and today's movement.
-- No opening/closing shifts: staff add stock, waste it, or fix the count; sales deduct on their own.
-- Every action is still a ledger movement (nothing overwritten).

CREATE OR REPLACE FUNCTION public.inv_menu_stock(p_date date DEFAULT NULL)
RETURNS TABLE(row_key text, kind text, item_id bigint, menu_code text, name text, category text, menus text,
              unit text, available numeric, sold numeric, added numeric, wasted numeric, fixed numeric,
              price numeric, purchase_unit_id bigint, purchase_unit text, purchase_to_stock numeric,
              base_unit_id bigint, next_expiry date, last_at timestamptz, open_shortages int)
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
           MIN(me.base_price) AS price
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
         (SELECT count(*)::int FROM inv_stock_exceptions e WHERE e.item_id = t.id AND e.status = 'OPEN')
  FROM tracked t JOIN inv_units u ON u.id = t.base_unit_id LEFT JOIN inv_units pu ON pu.id = t.purchase_unit_id
  LEFT JOIN mv ON mv.item_id = t.id
  UNION ALL
  -- menu items with no stock yet: type a quantity to start tracking
  SELECT 'M' || me.item_code, 'NEW', NULL, me.item_code, me.name, me.cat, me.name, 'pc', NULL, NULL, NULL, NULL, NULL,
         me.base_price, NULL, NULL, NULL, NULL, NULL, NULL, 0
  FROM menu me
  WHERE COALESCE(me.deduct_mode,'') <> 'RECIPE'
    AND NOT (me.deduct_mode = 'DIRECT' AND me.inv_item_id IS NOT NULL AND inv_item_tracked(me.inv_item_id))
  UNION ALL
  -- made to order from a recipe (drinks): no count, stock comes from ingredients
  SELECT 'R' || me.item_code, 'RECIPE', me.inv_item_id, me.item_code, me.name, me.cat, me.name, NULL, NULL, NULL, NULL, NULL, NULL,
         me.base_price, NULL, NULL, NULL, NULL, NULL, NULL, 0
  FROM menu me WHERE me.deduct_mode = 'RECIPE'
$$;

-- + Add: starts tracking a new menu item, or adds a batch to a tracked one (optionally in the purchase unit)
CREATE OR REPLACE FUNCTION public.inv_menu_add(p_menu_code text, p_item_id bigint, p_qty numeric, p_unit_id bigint,
  p_unit_cost numeric, p_actor text, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_item bigint := p_item_id; r jsonb; it record;
BEGIN
  IF p_qty IS NULL OR p_qty <= 0 THEN RETURN jsonb_build_object('ok',false,'error','Enter how many'); END IF;
  IF v_item IS NULL THEN
    IF p_menu_code IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Pick an item'); END IF;
    r := inv_start_menu_count(p_menu_code, p_qty, p_actor, 'OPENING');
    RETURN r;
  END IF;
  SELECT * INTO it FROM inv_items WHERE id = v_item AND is_active;
  IF it.id IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Item not found'); END IF;
  r := inv_receive_stock(v_item, p_qty, COALESCE(p_unit_id, it.base_unit_id), COALESCE(p_unit_cost,0), NULL, NULL, NULL,
                         p_actor, NULLIF(btrim(COALESCE(p_note,'')),''), NULL, false, 'purchase');
  RETURN r || jsonb_build_object('available', inv_item_available(v_item));
END $$;

-- Fix count: what's really there. The difference is a STOCK COUNT movement (theoretical vs physical kept in notes).
CREATE OR REPLACE FUNCTION public.inv_menu_set_count(p_item_id bigint, p_actual numeric, p_actor text, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE r jsonb;
BEGIN
  IF p_actual IS NULL OR p_actual < 0 THEN RETURN jsonb_build_object('ok',false,'error','Enter what is really there'); END IF;
  IF NOT inv_item_tracked(p_item_id) THEN RETURN jsonb_build_object('ok',false,'error','Add stock first'); END IF;
  r := inv_submit_count(jsonb_build_array(jsonb_build_object('item_id', p_item_id, 'counted', p_actual,
          'reason', 'PHYSICAL_VARIANCE', 'note', NULLIF(btrim(COALESCE(p_note,'')),''))), p_actor, 'CLOSING');
  RETURN r || jsonb_build_object('available', inv_item_available(p_item_id));
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.inv_menu_stock(date)',
    'public.inv_menu_add(text,bigint,numeric,bigint,numeric,text,text)',
    'public.inv_menu_set_count(bigint,numeric,text,text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;
