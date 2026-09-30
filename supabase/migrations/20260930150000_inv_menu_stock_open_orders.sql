-- Menu Stock: Available = on shelf − open orders (NEW/PREPARING/READY), so an order shows immediately.
-- The stock movement itself still posts at COMPLETED (cancel before serving = nothing to reverse).
DROP FUNCTION IF EXISTS public.inv_menu_stock(date);
CREATE FUNCTION public.inv_menu_stock(p_date date DEFAULT NULL)
RETURNS TABLE(row_key text, kind text, item_id bigint, menu_code text, name text, category text, menus text,
              unit text, available numeric, sold numeric, added numeric, wasted numeric, fixed numeric,
              price numeric, purchase_unit_id bigint, purchase_unit text, purchase_to_stock numeric,
              base_unit_id bigint, next_expiry date, last_at timestamptz, open_shortages int, cat_order int, unit_cost numeric, menu_costs jsonb, physical numeric, reserved numeric)
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
  res AS (SELECT DISTINCT inv_item_id, reserved FROM inv_menu_availability()),
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
         ROUND(GREATEST(inv_item_available(t.id) - COALESCE(res.reserved,0), 0), 3),
         ROUND(COALESCE(mv.sold,0),3), ROUND(COALESCE(mv.added,0),3), ROUND(COALESCE(mv.wasted,0),3), ROUND(COALESCE(mv.fixed,0),3),
         t.price, t.purchase_unit_id, pu.name, t.purchase_to_stock, t.base_unit_id,
         (SELECT MIN(su.expiry_date) FROM inv_stock_units su WHERE su.item_id = t.id AND su.quantity_remaining > 0
             AND su.status IN ('in_stock','opened','partially_used')),
         (SELECT MAX(x.performed_at) FROM inv_stock_transactions x JOIN inv_stock_units su ON su.id = x.stock_unit_id WHERE su.item_id = t.id AND x.quantity <> 0),
         (SELECT count(*)::int FROM inv_stock_exceptions e WHERE e.item_id = t.id AND e.status = 'OPEN'),
         t.cat_sort,
         (SELECT ROUND(COALESCE(SUM(su.quantity_remaining * su.unit_cost) / NULLIF(SUM(su.quantity_remaining) FILTER (WHERE su.unit_cost > 0),0), NULL), 2)
            FROM inv_stock_units su WHERE su.item_id = t.id AND su.quantity_remaining > 0 AND su.unit_cost > 0),
         (SELECT jsonb_agg(jsonb_build_object('name', m.name, 'price', m.base_price,
             'cost', (SELECT ROUND(SUM(ri.qty * ci.cost_per_unit), 2) FROM costing_recipes cr
                        JOIN costing_recipe_ingredients ri ON ri.recipe_id = cr.id
                        JOIN costing_ingredients ci ON ci.id = ri.ingredient_id
                       WHERE cr.item_code = m.item_code AND cr.is_active)) ORDER BY m.base_price, m.name)
            FROM inv_menu_map mm2 JOIN menu_items m ON m.item_code = mm2.menu_item_code AND m.is_active
           WHERE mm2.inv_item_id = t.id AND mm2.is_active AND mm2.deduct_mode = 'DIRECT'),
         ROUND(inv_item_available(t.id), 3), ROUND(COALESCE(res.reserved,0), 3)
  FROM tracked t JOIN inv_units u ON u.id = t.base_unit_id LEFT JOIN inv_units pu ON pu.id = t.purchase_unit_id
  LEFT JOIN mv ON mv.item_id = t.id LEFT JOIN res ON res.inv_item_id = t.id
  UNION ALL
  -- menu items with no stock yet: type a quantity to start tracking
  SELECT 'M' || me.item_code, 'NEW', NULL, me.item_code, me.name, me.cat, me.name, 'pc', NULL, NULL, NULL, NULL, NULL,
         me.base_price, NULL, NULL, NULL, NULL, NULL, NULL, 0, me.cat_sort, NULL::numeric, NULL::jsonb, NULL::numeric, NULL::numeric
  FROM menu me
  WHERE COALESCE(me.deduct_mode,'') <> 'RECIPE'
    AND NOT (me.deduct_mode = 'DIRECT' AND me.inv_item_id IS NOT NULL AND inv_item_tracked(me.inv_item_id))
  UNION ALL
  -- made to order from a recipe (drinks): no count, stock comes from ingredients
  SELECT 'R' || me.item_code, 'RECIPE', me.inv_item_id, me.item_code, me.name, me.cat, me.name, NULL, NULL, NULL, NULL, NULL, NULL,
         me.base_price, NULL, NULL, NULL, NULL, NULL, NULL, 0, me.cat_sort, NULL::numeric, NULL::jsonb, NULL::numeric, NULL::numeric
  FROM menu me WHERE me.deduct_mode = 'RECIPE'
$$;

REVOKE ALL ON FUNCTION public.inv_menu_stock(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_menu_stock(date) TO service_role;
