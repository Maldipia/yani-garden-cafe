-- Dashboard food cost % from Menu Costing: every completed sale × its recipe serving cost,
-- over the sales that have a cost; plus how much of sales is covered and the top items still missing a cost.
CREATE OR REPLACE FUNCTION public.inv_dashboard_v2(p_date date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE d date := COALESCE(p_date, (now() AT TIME ZONE 'Asia/Manila')::date);
        f timestamptz; t timestamptz; v_sales numeric; v_online numeric; v_cogs numeric; v_waste numeric; v_value numeric;
        mc record;
BEGIN
  f := (d::timestamp AT TIME ZONE 'Asia/Manila'); t := f + interval '1 day';
  SELECT COALESCE(SUM(COALESCE(discounted_total, total)),0) INTO v_sales FROM dine_in_orders
   WHERE status = 'COMPLETED' AND NOT COALESCE(is_test,false) AND NOT COALESCE(is_deleted,false) AND created_at >= f AND created_at < t;
  SELECT COALESCE(SUM(total_amount),0) INTO v_online FROM online_orders WHERE status::text = 'COMPLETED' AND created_at >= f AND created_at < t;
  SELECT COALESCE(-SUM(cost_impact),0) INTO v_cogs FROM inv_stock_transactions
   WHERE performed_at >= f AND performed_at < t AND movement_type IN ('POS SALE','ONLINE SALE','POS VOID','ONLINE VOID','POS RETURN');
  SELECT COALESCE(-SUM(cost_impact),0) INTO v_waste FROM inv_stock_transactions
   WHERE performed_at >= f AND performed_at < t AND movement_type IN ('WASTE','SPOILAGE','BREAKAGE','STAFF MEAL','COMPLIMENTARY');
  SELECT COALESCE(SUM(stock_value),0) INTO v_value FROM inv_current_stock();
  -- food cost from Menu Costing: each completed sale × its recipe serving cost
  WITH rc AS (
    SELECT cr.item_code, SUM(ri.qty * ci.cost_per_unit) AS cost
    FROM costing_recipes cr JOIN costing_recipe_ingredients ri ON ri.recipe_id = cr.id
    JOIN costing_ingredients ci ON ci.id = ri.ingredient_id
    WHERE cr.is_active AND cr.item_code IS NOT NULL GROUP BY cr.item_code),
  lines AS (
    SELECT oi.item_code AS code, oi.qty AS qty, oi.qty * oi.unit_price AS amount
    FROM dine_in_order_items oi JOIN dine_in_orders o ON o.order_id = oi.order_id
    WHERE o.status = 'COMPLETED' AND NOT COALESCE(o.is_test,false) AND NOT COALESCE(o.is_deleted,false)
      AND o.created_at >= f AND o.created_at < t
    UNION ALL
    SELECT COALESCE(NULLIF(oi.menu_item_id,''), (SELECT mi.item_code FROM menu_items mi WHERE lower(btrim(mi.name)) = lower(btrim(oi.item_name)) ORDER BY mi.is_active DESC LIMIT 1)),
           oi.quantity, oi.quantity * oi.unit_price
    FROM online_order_items oi JOIN online_orders o ON o.id = oi.order_id
    WHERE o.status::text = 'COMPLETED' AND o.created_at >= f AND o.created_at < t)
  SELECT COALESCE(SUM(l.qty * rc.cost),0) AS cost,
         COALESCE(SUM(l.amount) FILTER (WHERE rc.cost > 0),0) AS covered,
         COALESCE(SUM(l.amount),0) AS total,
         (SELECT COALESCE(jsonb_agg(x ORDER BY x.amount DESC),'[]'::jsonb) FROM (
            SELECT MAX(COALESCE(mi.name, l2.code)) AS name, SUM(l2.qty) AS qty, SUM(l2.amount) AS amount
            FROM lines l2 LEFT JOIN rc r2 ON r2.item_code = l2.code LEFT JOIN menu_items mi ON mi.item_code = l2.code
            WHERE COALESCE(r2.cost,0) = 0 GROUP BY l2.code ORDER BY SUM(l2.amount) DESC LIMIT 8) x) AS missing
    INTO mc
    FROM lines l LEFT JOIN rc ON rc.item_code = l.code;
  RETURN jsonb_build_object(
    'date', d,
    'inventory_value', ROUND(v_value,2),
    'sales', ROUND(v_sales + v_online,2), 'sales_pos', ROUND(v_sales,2), 'sales_online', ROUND(v_online,2),
    'actual_cogs', ROUND(v_cogs,2),
    'food_cost_pct', CASE WHEN v_sales + v_online > 0 THEN ROUND(v_cogs / (v_sales + v_online) * 100, 1) END,
    'waste_cost', ROUND(v_waste,2),
    'menu_cost', ROUND(mc.cost,2),
    'menu_food_cost_pct', CASE WHEN mc.covered > 0 THEN ROUND(mc.cost / mc.covered * 100, 1) END,
    'cost_coverage_pct', CASE WHEN mc.total > 0 THEN ROUND(mc.covered / mc.total * 100) END,
    'menu_profit', ROUND(mc.covered - mc.cost, 2),
    'missing_costs', mc.missing,
    'low_stock', (SELECT count(*) FROM inv_current_stock() WHERE status IN ('LOW','OUT')),
    'near_expiry', (SELECT count(*) FROM inv_current_stock() WHERE near_expiry_qty > 0),
    'expired', (SELECT count(*) FROM inv_current_stock() WHERE expired_qty > 0),
    'open_exceptions', (SELECT count(*) FROM inv_stock_exceptions WHERE status = 'OPEN'),
    'alerts', (SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY CASE c.status WHEN 'OUT' THEN 0 WHEN 'LOW' THEN 1 ELSE 2 END, c.next_expiry NULLS LAST), '[]'::jsonb)
               FROM inv_current_stock() c WHERE c.status IN ('LOW','OUT') OR c.near_expiry_qty > 0 OR c.expired_qty > 0),
    'waste_today', (SELECT COALESCE(jsonb_agg(to_jsonb(m)), '[]'::jsonb) FROM inv_movements(f, t, NULL, NULL, 200) m
                    WHERE m.movement_type IN ('WASTE','SPOILAGE','BREAKAGE','STAFF MEAL','COMPLIMENTARY')),
    'recent', (SELECT COALESCE(jsonb_agg(to_jsonb(m)), '[]'::jsonb) FROM inv_movements(NULL, NULL, NULL, NULL, 12) m),
    'top_selling', (SELECT COALESCE(jsonb_agg(x ORDER BY x.qty DESC), '[]'::jsonb) FROM (
                      SELECT oi.item_name AS name, SUM(oi.qty) AS qty FROM dine_in_order_items oi
                      JOIN dine_in_orders o ON o.order_id = oi.order_id
                      WHERE o.status = 'COMPLETED' AND NOT COALESCE(o.is_test,false) AND NOT COALESCE(o.is_deleted,false)
                        AND o.created_at >= f AND o.created_at < t
                      GROUP BY oi.item_name ORDER BY SUM(oi.qty) DESC LIMIT 5) x),
    'exceptions', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', e.id, 'item', i.name, 'qty', e.qty_short, 'unit', u.name,
                       'source', e.source_ref, 'channel', e.channel, 'menu', e.menu_item_code, 'detail', e.detail, 'at', e.created_at)
                       ORDER BY e.created_at DESC), '[]'::jsonb)
                   FROM inv_stock_exceptions e JOIN inv_items i ON i.id = e.item_id LEFT JOIN inv_units u ON u.id = e.unit_id
                   WHERE e.status = 'OPEN'));
END $$;

REVOKE ALL ON FUNCTION public.inv_dashboard_v2(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_dashboard_v2(date) TO service_role;
