-- ══════════════════════════════════════════════════════════════════════
-- Inventory engine, part 3: read-only reporting
--  current stock · movements · movement detail · item detail · explain stock
--  dashboard · exceptions · ledger reconciliation
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.inv_current_stock()
RETURNS TABLE(item_id bigint, item_code text, name text, item_type text, unit text, stock_qty numeric,
              par_level numeric, status text, near_expiry_qty numeric, expired_qty numeric, next_expiry date,
              locations text, stock_value numeric, batches int, tracked boolean,
              purchase_unit text, purchase_to_stock numeric, open_exceptions int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  WITH act AS (
    SELECT su.item_id, su.id, inv_convert(su.quantity_remaining, su.unit_id, i.base_unit_id) AS q,
           su.quantity_remaining * COALESCE(su.unit_cost,0) AS v, su.expiry_date, su.location_id, su.batch_id
    FROM inv_stock_units su JOIN inv_items i ON i.id = su.item_id
    WHERE su.status IN ('in_stock','opened','partially_used') AND su.quantity_remaining > 0)
  SELECT i.id, i.item_code, i.name, i.item_type, u.name,
         ROUND(COALESCE(SUM(a.q),0),3),
         i.par_level,
         CASE WHEN NOT inv_item_tracked(i.id) THEN 'NOT TRACKED'
              WHEN COALESCE(SUM(a.q),0) <= 0 THEN 'OUT'
              WHEN i.par_level IS NOT NULL AND COALESCE(SUM(a.q),0) < i.par_level THEN 'LOW'
              ELSE 'OK' END,
         ROUND(COALESCE(SUM(a.q) FILTER (WHERE a.expiry_date >= (now() AT TIME ZONE 'Asia/Manila')::date
                                           AND a.expiry_date <= (now() AT TIME ZONE 'Asia/Manila')::date + 2),0),3),
         ROUND(COALESCE(SUM(a.q) FILTER (WHERE a.expiry_date < (now() AT TIME ZONE 'Asia/Manila')::date),0),3),
         MIN(a.expiry_date),
         (SELECT string_agg(DISTINCT l.name, ', ') FROM act a2 JOIN inv_locations l ON l.id = a2.location_id WHERE a2.item_id = i.id),
         ROUND(COALESCE(SUM(a.v),0),2),
         COUNT(DISTINCT COALESCE(a.batch_id, -a.id))::int,
         inv_item_tracked(i.id),
         pu.name, i.purchase_to_stock,
         (SELECT count(*)::int FROM inv_stock_exceptions e WHERE e.item_id = i.id AND e.status = 'OPEN')
  FROM inv_items i
  JOIN inv_units u ON u.id = i.base_unit_id
  LEFT JOIN inv_units pu ON pu.id = i.purchase_unit_id
  LEFT JOIN act a ON a.item_id = i.id
  WHERE i.is_active AND i.merged_into_id IS NULL
  GROUP BY i.id, i.item_code, i.name, i.item_type, u.name, i.par_level, pu.name, i.purchase_to_stock
$$;

CREATE OR REPLACE FUNCTION public.inv_movements(p_from timestamptz DEFAULT NULL, p_to timestamptz DEFAULT NULL,
  p_item_id bigint DEFAULT NULL, p_type text DEFAULT NULL, p_limit int DEFAULT 200,
  p_txn_id bigint DEFAULT NULL, p_source_ref text DEFAULT NULL)
RETURNS TABLE(txn_id bigint, performed_at timestamptz, item_id bigint, item_name text, movement_type text,
              qty numeric, unit text, batch_code text, stock_unit_code text, source_ref text, reason text,
              performed_by text, performed_by_name text, location text, unit_cost numeric, cost_impact numeric,
              notes text, parent_txn_id bigint, reversed boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT t.id, t.performed_at, i.id, i.name, t.movement_type,
         ROUND(inv_convert(t.quantity, t.unit_id, i.base_unit_id), 3), bu.name,
         b.batch_code, su.stock_unit_code, t.source_ref, t.reason, t.performed_by,
         (SELECT s.display_name FROM staff_users s WHERE s.user_id = t.performed_by LIMIT 1),
         l.name, t.unit_cost, t.cost_impact, t.notes, t.parent_txn_id,
         EXISTS (SELECT 1 FROM inv_stock_transactions r WHERE r.parent_txn_id = t.id)
  FROM inv_stock_transactions t
  JOIN inv_stock_units su ON su.id = t.stock_unit_id
  JOIN inv_items i ON i.id = su.item_id
  JOIN inv_units bu ON bu.id = i.base_unit_id
  LEFT JOIN inv_batches b ON b.id = su.batch_id
  LEFT JOIN inv_locations l ON l.id = t.location_id
  WHERE (p_from IS NULL OR t.performed_at >= p_from) AND (p_to IS NULL OR t.performed_at < p_to)
    AND (p_item_id IS NULL OR i.id = p_item_id OR i.merged_into_id = p_item_id)
    AND (p_type IS NULL OR t.movement_type = p_type)
    AND (p_txn_id IS NULL OR t.id = p_txn_id OR t.parent_txn_id = p_txn_id)
    AND (p_source_ref IS NULL OR t.source_ref = p_source_ref)
    AND NOT (t.movement_type = 'STOCK COUNT' AND t.quantity = 0 AND p_item_id IS NULL AND p_txn_id IS NULL AND p_source_ref IS NULL)
  ORDER BY t.performed_at DESC, t.id DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit,200),1),1000)
$$;

CREATE OR REPLACE FUNCTION public.inv_movement_detail(p_txn_id bigint)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT jsonb_build_object(
    'movement', to_jsonb(m) ,
    'raw', (SELECT to_jsonb(t) - 'photo_url' FROM inv_stock_transactions t WHERE t.id = p_txn_id),
    'photo_url', (SELECT photo_url FROM inv_stock_transactions WHERE id = p_txn_id),
    'batch', (SELECT jsonb_build_object('stock_unit', su.stock_unit_code, 'batch', b.batch_code, 'received', su.date_received,
                     'expiry', su.expiry_date, 'original', su.quantity_original, 'remaining', su.quantity_remaining,
                     'unit_cost', su.unit_cost, 'status', su.status)
              FROM inv_stock_transactions t JOIN inv_stock_units su ON su.id = t.stock_unit_id
              LEFT JOIN inv_batches b ON b.id = su.batch_id WHERE t.id = p_txn_id),
    'same_source', (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.txn_id), '[]'::jsonb)
                    FROM inv_movements(NULL, NULL, NULL, NULL, 1000, NULL, m.source_ref) x
                    WHERE x.txn_id <> p_txn_id),
    'reversal', (SELECT to_jsonb(x) FROM inv_movements(NULL,NULL,NULL,NULL,5,p_txn_id,NULL) x WHERE x.parent_txn_id = p_txn_id LIMIT 1))
  FROM inv_movements(NULL, NULL, NULL, NULL, 5, p_txn_id, NULL) m WHERE m.txn_id = p_txn_id
$$;

CREATE OR REPLACE FUNCTION public.inv_item_detail(p_item_id bigint)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT jsonb_build_object(
    'item', jsonb_build_object('id', i.id, 'code', i.item_code, 'name', i.name, 'type', i.item_type,
        'stock_unit', bu.name, 'purchase_unit', pu.name, 'purchase_to_stock', i.purchase_to_stock,
        'par_level', i.par_level, 'shelf_life_days', i.shelf_life_days, 'rotation', i.rotation,
        'supplier', (SELECT name FROM inv_suppliers WHERE id = i.default_supplier_id),
        'location', (SELECT name FROM inv_locations WHERE id = i.default_location_id),
        'tracked', inv_item_tracked(i.id), 'merged_into', i.merged_into_id,
        'cost_per_stock_unit', (SELECT su.unit_cost FROM inv_stock_units su WHERE su.item_id = i.id ORDER BY su.date_received DESC, su.id DESC LIMIT 1),
        'cost_per_purchase_unit', (SELECT su.unit_cost * COALESCE(i.purchase_to_stock,1) FROM inv_stock_units su WHERE su.item_id = i.id ORDER BY su.date_received DESC, su.id DESC LIMIT 1),
        'selling_price', inv_menu_unit_price(i.id),
        'menu_items', (SELECT COALESCE(jsonb_agg(jsonb_build_object('code', m.item_code, 'name', m.name, 'price', m.base_price, 'mode', mm.deduct_mode)), '[]'::jsonb)
                       FROM inv_menu_map mm JOIN menu_items m ON m.item_code = mm.menu_item_code
                       WHERE mm.inv_item_id = i.id AND mm.is_active),
        'recipes', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', r.id, 'size', COALESCE(r.size_code,'DEFAULT'),
                       'ingredients', (SELECT jsonb_agg(jsonb_build_object('item', ii.name, 'qty', ri.quantity, 'unit', uu.name))
                                        FROM inv_recipe_ingredients ri JOIN inv_items ii ON ii.id = ri.ingredient_item_id
                                        JOIN inv_units uu ON uu.id = ri.unit_id WHERE ri.recipe_id = r.id))), '[]'::jsonb)
                    FROM inv_recipes r WHERE r.item_id = i.id AND r.is_active)),
    'stock', (SELECT to_jsonb(c) FROM inv_current_stock() c WHERE c.item_id = i.id),
    'batches', (SELECT COALESCE(jsonb_agg(x ORDER BY x.active DESC, x.expiry NULLS LAST, x.received), '[]'::jsonb) FROM (
                  SELECT su.id, COALESCE(b.batch_code, su.stock_unit_code) AS batch, su.stock_unit_code, su.date_received AS received,
                         su.expiry_date AS expiry, inv_convert(su.quantity_original, su.unit_id, i.base_unit_id) AS original,
                         inv_convert(su.quantity_remaining, su.unit_id, i.base_unit_id) AS remaining,
                         l.name AS location, su.unit_cost, su.status,
                         (su.status IN ('in_stock','opened','partially_used') AND su.quantity_remaining > 0) AS active,
                         (SELECT name FROM inv_suppliers WHERE id = b.supplier_id) AS supplier
                  FROM inv_stock_units su LEFT JOIN inv_batches b ON b.id = su.batch_id LEFT JOIN inv_locations l ON l.id = su.location_id
                  WHERE su.item_id = i.id ORDER BY su.date_received DESC LIMIT 40) x),
    'movements', (SELECT COALESCE(jsonb_agg(to_jsonb(m)), '[]'::jsonb) FROM inv_movements(NULL, NULL, i.id, NULL, 100) m),
    'exceptions', (SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.created_at DESC), '[]'::jsonb)
                   FROM inv_stock_exceptions e WHERE e.item_id = i.id AND e.status = 'OPEN'))
  FROM inv_items i JOIN inv_units bu ON bu.id = i.base_unit_id LEFT JOIN inv_units pu ON pu.id = i.purchase_unit_id
  WHERE i.id = p_item_id
$$;

-- "18 + 16 − 3 − 2 = 29": opening, every movement in the window, closing, batch balances
CREATE OR REPLACE FUNCTION public.inv_item_ledger(p_item_id bigint, p_to timestamptz DEFAULT 'infinity')
RETURNS TABLE(txn_id bigint, performed_at timestamptz, movement_type text, qty numeric, batch text, source_ref text,
              by_name text, reason text, cost numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT t.id, t.performed_at, t.movement_type, inv_convert(t.quantity, t.unit_id, i.base_unit_id),
         COALESCE(b.batch_code, su.stock_unit_code), t.source_ref,
         COALESCE((SELECT s.display_name FROM staff_users s WHERE s.user_id = t.performed_by LIMIT 1), t.performed_by),
         t.reason, t.cost_impact
  FROM inv_stock_transactions t JOIN inv_stock_units su ON su.id = t.stock_unit_id
  JOIN inv_items i ON i.id = su.item_id LEFT JOIN inv_batches b ON b.id = su.batch_id
  WHERE (i.id = p_item_id OR i.merged_into_id = p_item_id) AND t.performed_at < COALESCE(p_to, 'infinity')
$$;

CREATE OR REPLACE FUNCTION public.inv_explain_stock(p_item_id bigint, p_from timestamptz DEFAULT NULL, p_to timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_open numeric; v_sum numeric; v_close numeric; v_now numeric; v_lines jsonb; v_groups jsonb; v_unit text; v_formula text;
        v_to timestamptz := COALESCE(p_to, 'infinity'); v_from timestamptz := COALESCE(p_from, '-infinity');
BEGIN
  SELECT u.name INTO v_unit FROM inv_items i JOIN inv_units u ON u.id = i.base_unit_id WHERE i.id = p_item_id;
  IF v_unit IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Item not found'); END IF;
  SELECT COALESCE(SUM(qty),0) INTO v_open FROM inv_item_ledger(p_item_id, v_to) WHERE performed_at < v_from;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('at', performed_at, 'type', movement_type, 'qty', qty, 'batch', batch,
                                               'source', source_ref, 'by', by_name, 'reason', reason, 'cost', cost)
                            ORDER BY performed_at, txn_id), '[]'::jsonb), COALESCE(SUM(qty),0)
    INTO v_lines, v_sum FROM inv_item_ledger(p_item_id, v_to) WHERE performed_at >= v_from AND qty <> 0;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('type', movement_type, 'qty', q) ORDER BY first_at), '[]'::jsonb),
         string_agg(CASE WHEN q >= 0 THEN ' + ' ELSE ' − ' END || trim(to_char(abs(q),'FM999999990.###')) || ' ' || lower(movement_type), '' ORDER BY first_at)
    INTO v_groups, v_formula
    FROM (SELECT movement_type, SUM(qty) q, MIN(performed_at) first_at FROM inv_item_ledger(p_item_id, v_to)
          WHERE performed_at >= v_from AND qty <> 0 GROUP BY movement_type) g;
  v_close := v_open + v_sum;
  v_now := inv_item_available(p_item_id);
  RETURN jsonb_build_object('ok', true, 'item_id', p_item_id, 'unit', v_unit,
    'opening', v_open, 'movements', v_lines, 'by_type', v_groups, 'closing', v_close,
    'formula', trim(to_char(v_open,'FM999999990.###')) || COALESCE(v_formula,'') || ' = ' || trim(to_char(v_close,'FM999999990.###')) || ' ' || v_unit,
    'current_stock', v_now,
    'reconciles', (p_to IS NOT NULL OR abs(v_close - v_now) < 0.0005),
    'batches', (SELECT COALESCE(jsonb_agg(jsonb_build_object('batch', COALESCE(b.batch_code, su.stock_unit_code),
                    'received', su.date_received, 'expiry', su.expiry_date,
                    'original', inv_convert(su.quantity_original, su.unit_id, i.base_unit_id),
                    'remaining', inv_convert(su.quantity_remaining, su.unit_id, i.base_unit_id), 'unit_cost', su.unit_cost)
                    ORDER BY su.expiry_date NULLS LAST, su.date_received), '[]'::jsonb)
                FROM inv_stock_units su JOIN inv_items i ON i.id = su.item_id LEFT JOIN inv_batches b ON b.id = su.batch_id
                WHERE su.item_id = p_item_id AND su.quantity_remaining > 0));
END $$;

CREATE OR REPLACE FUNCTION public.inv_dashboard_v2(p_date date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE d date := COALESCE(p_date, (now() AT TIME ZONE 'Asia/Manila')::date);
        f timestamptz; t timestamptz; v_sales numeric; v_online numeric; v_cogs numeric; v_waste numeric; v_value numeric;
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
  RETURN jsonb_build_object(
    'date', d,
    'inventory_value', ROUND(v_value,2),
    'sales', ROUND(v_sales + v_online,2), 'sales_pos', ROUND(v_sales,2), 'sales_online', ROUND(v_online,2),
    'actual_cogs', ROUND(v_cogs,2),
    'food_cost_pct', CASE WHEN v_sales + v_online > 0 THEN ROUND(v_cogs / (v_sales + v_online) * 100, 1) END,
    'waste_cost', ROUND(v_waste,2),
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

CREATE OR REPLACE FUNCTION public.inv_resolve_exception(p_id bigint, p_note text, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF COALESCE(btrim(p_note),'') = '' THEN RETURN jsonb_build_object('ok',false,'error','Write what was found'); END IF;
  UPDATE inv_stock_exceptions SET status='RESOLVED', resolved_by=p_actor, resolved_at=now(), resolution_note=p_note
   WHERE id = p_id AND status = 'OPEN';
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','Not found or already resolved'); END IF;
  RETURN jsonb_build_object('ok',true);
END $$;

-- every batch balance must equal the sum of its movements
CREATE OR REPLACE FUNCTION public.inv_ledger_check()
RETURNS TABLE(stock_unit_id bigint, stock_unit_code text, item_name text, remaining numeric, ledger_sum numeric, difference numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT su.id, su.stock_unit_code, i.name, su.quantity_remaining, COALESCE(SUM(t.quantity),0),
         su.quantity_remaining - COALESCE(SUM(t.quantity),0)
  FROM inv_stock_units su JOIN inv_items i ON i.id = su.item_id
  LEFT JOIN inv_stock_transactions t ON t.stock_unit_id = su.id
  GROUP BY su.id, su.stock_unit_code, i.name, su.quantity_remaining
  HAVING abs(su.quantity_remaining - COALESCE(SUM(t.quantity),0)) > 0.0005
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.inv_current_stock()',
    'public.inv_movements(timestamptz,timestamptz,bigint,text,integer,bigint,text)', 'public.inv_movement_detail(bigint)',
    'public.inv_item_detail(bigint)', 'public.inv_explain_stock(bigint,timestamptz,timestamptz)', 'public.inv_item_ledger(bigint,timestamptz)',
    'public.inv_dashboard_v2(date)', 'public.inv_resolve_exception(bigint,text,text)', 'public.inv_ledger_check()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;
