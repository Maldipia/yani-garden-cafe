-- Audit fix: stock is deducted when an order is COMPLETED, so orders still being prepared
-- must reserve what they will take. Otherwise the QR menu could sell the same last slice twice.
-- available = physical stock − open orders (POS NEW/PREPARING/READY + online PENDING/CONFIRMED/PREPARING/READY,
-- last 24 h, not test/deleted). Also returns whole_mult so a WHOLE order is checked as all its portions.
DROP FUNCTION IF EXISTS public.inv_menu_availability();
CREATE FUNCTION public.inv_menu_availability()
RETURNS TABLE(menu_item_code text, inv_item_id bigint, portions_per_sale numeric, item_available numeric,
              available integer, reserved numeric, physical numeric, whole_mult numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  WITH maps AS (
    SELECT mm.menu_item_code, mm.inv_item_id, COALESCE(mm.portions_per_sale,1) AS pps,
           COALESCE(i.purchase_to_stock, i.standard_yield, 1) AS wm
    FROM inv_menu_map mm JOIN inv_items i ON i.id = mm.inv_item_id
    WHERE inv_cfg('module_enabled') = 'true'
      AND mm.is_active AND mm.deduct_mode = 'DIRECT' AND mm.sell_form = 'WHOLE'
      AND i.is_active AND inv_item_tracked(i.id)),
  pos_open AS (
    SELECT m.inv_item_id,
           SUM(COALESCE(oi.qty,1) * m.pps * CASE WHEN upper(btrim(COALESCE(oi.size_choice,''))) = 'WHOLE' THEN m.wm ELSE 1 END) AS q
    FROM dine_in_orders o JOIN dine_in_order_items oi ON oi.order_id = o.order_id
    JOIN maps m ON m.menu_item_code = oi.item_code
    WHERE o.status IN ('NEW','PREPARING','READY') AND NOT COALESCE(o.is_test,false) AND NOT COALESCE(o.is_deleted,false)
      AND o.created_at > now() - interval '24 hours'
    GROUP BY m.inv_item_id),
  onl_open AS (
    SELECT m.inv_item_id,
           SUM(COALESCE(oi.quantity,1) * m.pps
               * CASE WHEN upper(btrim(split_part(COALESCE(oi.size,''),'·',1))) = 'WHOLE' THEN m.wm ELSE 1 END) AS q
    FROM online_orders o JOIN online_order_items oi ON oi.order_id = o.id
    JOIN maps m ON m.menu_item_code = COALESCE(NULLIF(oi.menu_item_id,''),
         (SELECT mi.item_code FROM menu_items mi WHERE lower(btrim(mi.name)) = lower(btrim(oi.item_name)) ORDER BY mi.is_active DESC LIMIT 1))
    WHERE o.status::text IN ('PENDING','CONFIRMED','PREPARING','READY') AND o.created_at > now() - interval '24 hours'
    GROUP BY m.inv_item_id),
  per_item AS (
    SELECT DISTINCT m.inv_item_id, inv_item_available(m.inv_item_id) AS phys,
           COALESCE(p.q,0) + COALESCE(n.q,0) AS res
    FROM maps m LEFT JOIN pos_open p ON p.inv_item_id = m.inv_item_id LEFT JOIN onl_open n ON n.inv_item_id = m.inv_item_id)
  SELECT m.menu_item_code, m.inv_item_id, m.pps,
         GREATEST(pi.phys - pi.res, 0),
         FLOOR(GREATEST(pi.phys - pi.res, 0) / GREATEST(m.pps, 0.0001))::int,
         pi.res, pi.phys, m.wm
  FROM maps m JOIN per_item pi ON pi.inv_item_id = m.inv_item_id
$$;
REVOKE ALL ON FUNCTION public.inv_menu_availability() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_menu_availability() TO service_role;

-- menu cache stamp: also change when open orders reserve stock, so "Only N left" / Sold out is never stale
CREATE OR REPLACE FUNCTION public.menu_version()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT count(*)::text || '|' || COALESCE(max(updated_at)::text, '')
         || '|' || COALESCE((SELECT max(id) FROM inv_stock_transactions)::text, '')
         || '|' || COALESCE((SELECT value FROM inv_config WHERE key = 'module_enabled'), '')
         || '|' || COALESCE((SELECT md5(string_agg(a.menu_item_code || ':' || a.available, ',' ORDER BY a.menu_item_code))
                             FROM inv_menu_availability() a), '')
  FROM menu_items;
$function$;
