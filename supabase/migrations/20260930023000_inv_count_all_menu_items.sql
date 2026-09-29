-- Count list = every active menu item except the BEST WITH bundles.
-- Tracked stock items show first; every other menu item can be added to the
-- count. A menu item with no direct stock item gets one on its first count
-- (item code MENU-<menu code>, counted in pc) and its sales deduct 1 per order.
DROP FUNCTION IF EXISTS public.inv_count_sheet();
CREATE FUNCTION public.inv_count_sheet()
RETURNS TABLE(item_id bigint, menu_code text, name text, category text, unit text, standard_yield numeric,
              system_qty numeric, next_expiry date, received_at timestamptz, batch_code text,
              menu_names text, menu_price numeric, unit_cost numeric, last_counted timestamptz, tracked boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  WITH first_unit AS (
    SELECT DISTINCT ON (su.item_id) su.item_id, su.expiry_date, su.date_received,
           COALESCE(b.batch_code, su.stock_unit_code) AS code
    FROM inv_stock_units su LEFT JOIN inv_batches b ON b.id = su.batch_id
    WHERE su.status IN ('in_stock','opened','partially_used') AND su.quantity_remaining > 0
    ORDER BY su.item_id, su.expiry_date NULLS LAST, su.date_received, su.id),
  tracked AS (
    SELECT i.id AS item_id,
           (SELECT mm.menu_item_code FROM inv_menu_map mm WHERE mm.inv_item_id = i.id AND mm.is_active ORDER BY mm.id LIMIT 1) AS menu_code,
           i.name,
           (SELECT c.name FROM inv_menu_map mm JOIN menu_items m ON m.item_code = mm.menu_item_code
              LEFT JOIN menu_categories c ON c.id = m.category_id
             WHERE mm.inv_item_id = i.id AND mm.is_active ORDER BY mm.id LIMIT 1) AS category,
           u.name AS unit, i.standard_yield,
           ROUND(inv_item_available(i.id), 3) AS system_qty,
           fu.expiry_date, fu.date_received, fu.code,
           (SELECT string_agg(m.name, ' · ' ORDER BY m.name) FROM inv_menu_map mm
              JOIN menu_items m ON m.item_code = mm.menu_item_code
             WHERE mm.inv_item_id = i.id AND mm.is_active AND m.is_active) AS menu_names,
           inv_menu_unit_price(i.id) AS menu_price,
           (SELECT su.unit_cost FROM inv_stock_units su WHERE su.item_id = i.id ORDER BY su.date_received DESC, su.id DESC LIMIT 1) AS unit_cost,
           (SELECT max(t.performed_at) FROM inv_stock_transactions t JOIN inv_stock_units su ON su.id = t.stock_unit_id
             WHERE su.item_id = i.id AND t.reference_type = 'count') AS last_counted
    FROM inv_items i JOIN inv_units u ON u.id = i.base_unit_id
    LEFT JOIN first_unit fu ON fu.item_id = i.id
    WHERE i.is_active AND i.item_type = 'PURCHASED_READY' AND inv_item_tracked(i.id)),
  cand AS (
    SELECT DISTINCT ON (COALESCE('I'||i.id::text, 'M'||m.item_code))
           i.id AS item_id, m.item_code AS menu_code, COALESCE(i.name, m.name) AS name, c.name AS category,
           COALESCE(u.name, 'pc') AS unit, i.standard_yield, m.base_price, m.name AS menu_name
    FROM menu_items m
    LEFT JOIN menu_categories c ON c.id = m.category_id
    LEFT JOIN inv_menu_map mm ON mm.menu_item_code = m.item_code AND mm.is_active AND mm.deduct_mode = 'DIRECT' AND mm.sell_form = 'WHOLE'
    LEFT JOIN inv_items i ON i.id = mm.inv_item_id AND i.is_active
    LEFT JOIN inv_units u ON u.id = i.base_unit_id
    WHERE m.is_active AND upper(COALESCE(c.name,'')) <> 'BEST WITH'
      AND (i.id IS NULL OR NOT inv_item_tracked(i.id))
    ORDER BY COALESCE('I'||i.id::text, 'M'||m.item_code), m.name)
  SELECT t.item_id, t.menu_code, t.name, t.category, t.unit, t.standard_yield, t.system_qty, t.expiry_date,
         t.date_received, t.code, t.menu_names, t.menu_price, t.unit_cost, t.last_counted, true
  FROM tracked t
  UNION ALL
  SELECT c.item_id, c.menu_code, c.name, c.category, c.unit, c.standard_yield, 0, NULL, NULL, NULL,
         c.menu_name, c.base_price, NULL, NULL, false
  FROM cand c
  ORDER BY 15 DESC, 4, 3
$$;

-- Put a menu item on the count: reuse its direct stock item, or create one.
CREATE OR REPLACE FUNCTION public.inv_start_menu_count(p_menu_code text, p_qty numeric, p_actor text, p_shift text DEFAULT 'CLOSING')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE m record; v_item bigint; v_pc bigint; v_code text;
BEGIN
  IF p_qty IS NULL OR p_qty <= 0 THEN RETURN jsonb_build_object('ok',false,'error','Enter how many are on display'); END IF;
  SELECT mi.item_code, mi.name, upper(COALESCE(c.name,'')) AS cat INTO m
    FROM menu_items mi LEFT JOIN menu_categories c ON c.id = mi.category_id
   WHERE mi.item_code = p_menu_code AND mi.is_active;
  IF m.item_code IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Menu item not found'); END IF;
  IF m.cat = 'BEST WITH' THEN RETURN jsonb_build_object('ok',false,'error','Best With sets use the stock of their parts'); END IF;

  SELECT i.id INTO v_item FROM inv_menu_map mm JOIN inv_items i ON i.id = mm.inv_item_id AND i.is_active
   WHERE mm.menu_item_code = p_menu_code AND mm.is_active AND mm.deduct_mode = 'DIRECT' AND mm.sell_form = 'WHOLE' LIMIT 1;

  IF v_item IS NULL THEN
    v_code := 'MENU-' || p_menu_code;
    SELECT id INTO v_pc FROM inv_units WHERE name = 'pc';
    SELECT id INTO v_item FROM inv_items WHERE item_code = v_code;
    IF v_item IS NULL THEN
      INSERT INTO inv_items (item_code, name, item_type, base_unit_id, is_portionable, is_active, description)
      VALUES (v_code, m.name, 'PURCHASED_READY', v_pc, false, true, 'Counted per menu item (display count)')
      RETURNING id INTO v_item;
    ELSE
      UPDATE inv_items SET is_active = true, updated_at = now() WHERE id = v_item;
    END IF;
    INSERT INTO inv_menu_map (menu_item_code, inv_item_id, sell_form, deduct_mode, portions_per_sale, is_active)
    VALUES (p_menu_code, v_item, 'WHOLE', 'DIRECT', 1, true)
    ON CONFLICT (menu_item_code, sell_form) DO UPDATE
      SET inv_item_id = EXCLUDED.inv_item_id, deduct_mode = 'DIRECT', portions_per_sale = 1, is_active = true;
  END IF;

  IF inv_item_tracked(v_item) THEN
    RETURN jsonb_build_object('ok',false,'error',m.name||' is already on the count');
  END IF;
  RETURN inv_submit_count(jsonb_build_array(jsonb_build_object('item_id', v_item, 'counted', p_qty)), p_actor, p_shift)
         || jsonb_build_object('item_id', v_item);
END $$;

REVOKE ALL ON FUNCTION public.inv_count_sheet() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_count_sheet() TO service_role;
REVOKE ALL ON FUNCTION public.inv_start_menu_count(text,numeric,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_start_menu_count(text,numeric,text,text) TO service_role;
