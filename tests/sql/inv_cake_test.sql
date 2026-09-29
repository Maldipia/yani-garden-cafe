-- Required acceptance test (Chocolate Cake) + engine checks.
-- Runs entirely inside one DO block and ALWAYS ends with RAISE EXCEPTION, so every write is rolled back.
-- Read the result JSON from the error message: {"pass": true|false, "checks": {...}}
DO $$
DECLARE
  r jsonb := '{}'::jsonb; ok boolean := true; x jsonb; v numeric;
  cake bigint; coffee bigint; milk bigint; drink bigint; rs bigint; rt bigint;
  v_oid bigint; oref text := 'TST-ONL-' || floor(random()*1e6)::text; pos text := 'TST-POS-' || floor(random()*1e6)::text;
  b_old bigint; b_new bigint;
BEGIN
  -- ── setup: Chocolate Cake, stock unit slice, purchase unit whole, 1 cake = 16 slices
  INSERT INTO inv_items(item_code, name, item_type, base_unit_id, purchase_unit_id, purchase_to_stock, shelf_life_days, rotation, is_active)
  VALUES ('TST-CAKE', 'TST Chocolate Cake', 'PURCHASED_READY', 8, 7, 16, 3, 'FEFO', true) RETURNING id INTO cake;
  INSERT INTO menu_items(item_code, name, base_price) VALUES ('TST-M-CAKE', 'TST Chocolate Cake Slice', 150);
  INSERT INTO inv_menu_map(menu_item_code, inv_item_id, deduct_mode, sell_form, is_active) VALUES ('TST-M-CAKE', cake, 'DIRECT', 'WHOLE', true);

  -- opening 18 slices (older batch, expires sooner)
  x := inv_receive_stock(cake, 18, 8, 40, NULL, NULL, (now() AT TIME ZONE 'Asia/Manila')::date + 1, 'USR_001', 'opening', NULL, false, 'opening');
  b_old := (x->>'stock_unit_id')::bigint;
  -- receive 1 whole cake @ ₱800
  x := inv_receive_stock(cake, 1, 7, 800, NULL, NULL, NULL, 'USR_001', NULL, NULL, false, 'purchase');
  b_new := (x->>'stock_unit_id')::bigint;
  r := r || jsonb_build_object('receive_conversion', x->>'conversion', 'receive_qty', x->>'qty_received', 'receive_unit_cost', x->>'unit_cost');
  v := inv_item_available(cake); r := r || jsonb_build_object('after_receive', v); ok := ok AND v = 34 AND (x->>'qty_received')::numeric = 16;

  -- POS sale of 3 slices, completed through the real trigger
  INSERT INTO dine_in_orders(order_id, order_no, status, total, is_test) VALUES (pos, 999901, 'NEW', 450, false);  -- live-shaped order (is_test orders are skipped by design); rolled back
  INSERT INTO dine_in_order_items(order_id, item_code, item_name, qty, size_choice) VALUES (pos, 'TST-M-CAKE', 'TST Chocolate Cake Slice', 3, 'Slice');
  UPDATE dine_in_orders SET status = 'COMPLETED' WHERE order_id = pos;
  v := inv_item_available(cake); r := r || jsonb_build_object('after_sale', v); ok := ok AND v = 31;
  -- re-fire (retry / refresh) must not deduct twice
  x := inv_consume_order(pos, 'SYSTEM');
  r := r || jsonb_build_object('pos_retry', x->'already_consumed'); ok := ok AND (x->>'already_consumed')::boolean;
  UPDATE dine_in_orders SET status = 'COMPLETED', updated_at = now() WHERE order_id = pos;
  v := inv_item_available(cake); ok := ok AND v = 31;

  -- waste 2
  x := inv_record_spoilage(cake, 2, 'WASTE', 'dropped', 'USR_001', 'https://example.test/spoil.jpg');
  r := r || jsonb_build_object('waste_result', x);
  v := inv_item_available(cake); r := r || jsonb_build_object('after_waste', v); ok := ok AND v = 29;

  -- batches: old 18 → 15 → 13, new 16 → 16
  r := r || jsonb_build_object('batch_old', (SELECT quantity_remaining FROM inv_stock_units WHERE id = b_old),
                               'batch_new', (SELECT quantity_remaining FROM inv_stock_units WHERE id = b_new));
  ok := ok AND (SELECT quantity_remaining FROM inv_stock_units WHERE id = b_old) = 13
           AND (SELECT quantity_remaining FROM inv_stock_units WHERE id = b_new) = 16;

  -- ledger + explain
  r := r || jsonb_build_object('ledger', (SELECT jsonb_agg(movement_type || ' ' || CASE WHEN qty > 0 THEN '+' ELSE '' END || trim(to_char(qty,'FM999990.###')) ORDER BY txn_id)
                                          FROM inv_movements(NULL,NULL,cake,NULL,50) WHERE qty <> 0));
  ok := ok AND (SELECT jsonb_agg(movement_type || ' ' || CASE WHEN qty > 0 THEN '+' ELSE '' END || trim(to_char(qty,'FM999990.###')) ORDER BY txn_id)
                FROM inv_movements(NULL,NULL,cake,NULL,50) WHERE qty <> 0)
               = '["OPENING BALANCE +18", "PURCHASE +16", "POS SALE -3", "WASTE -2"]'::jsonb;
  x := inv_explain_stock(cake);
  r := r || jsonb_build_object('formula', x->'formula', 'reconciles', x->'reconciles');
  ok := ok AND (x->>'formula') = '18 + 16 purchase − 3 pos sale − 2 waste = 29 slice' AND (x->>'reconciles')::boolean;
  r := r || jsonb_build_object('cogs_pos', (SELECT -SUM(cost_impact) FROM inv_stock_transactions WHERE source_ref = 'POS-' || pos));

  -- stock count: theoretical 29, physical 27 → −2 variance, no overwrite
  x := inv_submit_count(jsonb_build_array(jsonb_build_object('item_id', cake, 'counted', 27, 'reason', 'PHYSICAL_VARIANCE')), 'USR_001', 'CLOSING');
  r := r || jsonb_build_object('count_ok', x->'ok',
          'count_movement', (SELECT jsonb_build_object('type', movement_type, 'qty', qty, 'notes', notes) FROM inv_movements(NULL,NULL,cake,'STOCK COUNT',5) WHERE qty <> 0 LIMIT 1));
  v := inv_item_available(cake); r := r || jsonb_build_object('after_count', v); ok := ok AND v = 27
       AND EXISTS (SELECT 1 FROM inv_movements(NULL,NULL,cake,'STOCK COUNT',5) WHERE qty = -2 AND reason = 'PHYSICAL_VARIANCE'
                   AND notes LIKE 'theoretical 29, physical 27%');

  -- shortage: sell 30 with 27 on hand → sale completes, 27 consumed, exception for 3
  x := inv_consume_sale('POS', 'POS-' || pos || '-B', jsonb_build_array(jsonb_build_object('menu_code','TST-M-CAKE','qty',30,'size','Slice')), 'SYSTEM');
  r := r || jsonb_build_object('shortage_result', x, 'shortage_exc', (SELECT jsonb_agg(jsonb_build_object('qty', qty_short, 'detail', detail)) FROM inv_stock_exceptions WHERE source_ref = 'POS-' || pos || '-B'));
  v := inv_item_available(cake); r := r || jsonb_build_object('after_short', v); ok := ok AND v = 0 AND (x->>'shortages')::int = 1
        AND (SELECT qty_short FROM inv_stock_exceptions WHERE source_ref = 'POS-' || pos || '-B') = 3
        AND (SELECT min(quantity_remaining) FROM inv_stock_units WHERE item_id = cake) >= 0;

  -- reversal of that sale restores 27 and resolves the exception
  x := inv_reverse_sale('POS-' || pos || '-B', 'USR_001');
  v := inv_item_available(cake); r := r || jsonb_build_object('after_reverse', v, 'reverse', x->'ok'); ok := ok AND v = 27
       AND NOT EXISTS (SELECT 1 FROM inv_stock_exceptions WHERE source_ref = 'POS-' || pos || '-B' AND status = 'OPEN');

  -- ── size recipes + add-on: TST Latte, Short 14 g / Tall 22 g coffee, extra shot +18 g
  INSERT INTO inv_items(item_code, name, item_type, base_unit_id, is_active) VALUES ('TST-COF', 'TST Coffee Beans', 'RAW_MATERIAL', 1, true) RETURNING id INTO coffee;
  INSERT INTO inv_items(item_code, name, item_type, base_unit_id, is_active) VALUES ('TST-MILK', 'TST Milk', 'RAW_MATERIAL', 2, true) RETURNING id INTO milk;
  INSERT INTO inv_items(item_code, name, item_type, base_unit_id, is_active) VALUES ('TST-LATTE', 'TST Iced Latte', 'PREP', 9, true) RETURNING id INTO drink;
  PERFORM inv_receive_stock(coffee, 1000, 1, 1.2, NULL, NULL, NULL, 'USR_001');
  PERFORM inv_receive_stock(milk, 5000, 2, 0.1, NULL, NULL, NULL, 'USR_001');
  INSERT INTO inv_recipes(item_id, name, yield_unit_id, yield_qty, size_code, is_active) VALUES (drink, 'Latte Short', 9, 1, 'SHORT', true) RETURNING id INTO rs;
  INSERT INTO inv_recipes(item_id, name, yield_unit_id, yield_qty, size_code, is_active) VALUES (drink, 'Latte Tall', 9, 1, 'TALL', true) RETURNING id INTO rt;
  INSERT INTO inv_recipe_ingredients(recipe_id, ingredient_item_id, quantity, unit_id) VALUES (rs, coffee, 14, 1), (rs, milk, 180, 2), (rt, coffee, 22, 1), (rt, milk, 300, 2);
  INSERT INTO menu_items(item_code, name, base_price) VALUES ('TST-M-LATTE', 'TST Iced Latte', 150);
  INSERT INTO inv_menu_map(menu_item_code, inv_item_id, deduct_mode, sell_form, is_active) VALUES ('TST-M-LATTE', drink, 'RECIPE', 'WHOLE', true);
  INSERT INTO menu_addons(addon_code, name, inv_item_id, inv_qty, inv_unit_id) VALUES ('TST-ADD-SHOT', 'TST extra shot', coffee, 18, 1);

  -- online order: 1 Tall + extra shot, 2 Short → coffee 22+18+28 = 68 g, milk 300+360 = 660 ml
  INSERT INTO online_orders(order_ref, customer_name, customer_phone, status, total_amount) VALUES (oref, 'TST', '0000', 'PENDING', 450) RETURNING id INTO v_oid;
  INSERT INTO online_order_items(order_id, item_name, unit_price, quantity, size, menu_item_id, addons) VALUES
    (v_oid, 'TST Iced Latte', 150, 1, 'Tall · Comfort', 'TST-M-LATTE', '[{"code":"TST-ADD-SHOT","name":"TST extra shot","price":30}]'::jsonb),
    (v_oid, 'TST Iced Latte', 150, 2, 'Short · YANI', NULL, NULL);   -- no code: name fallback
  UPDATE online_orders SET status = 'COMPLETED' WHERE id = v_oid;
  r := r || jsonb_build_object('coffee_left', inv_item_available(coffee), 'milk_left', inv_item_available(milk),
          'online_types', (SELECT jsonb_agg(DISTINCT movement_type) FROM inv_stock_transactions WHERE source_ref = 'ONLINE-' || oref));
  ok := ok AND inv_item_available(coffee) = 932 AND inv_item_available(milk) = 4340;
  -- webhook retry: once only
  x := inv_consume_online(oref, 'SYSTEM');
  r := r || jsonb_build_object('online_retry', x->'already_consumed'); ok := ok AND (x->>'already_consumed')::boolean AND inv_item_available(coffee) = 932;
  -- cancel after completion → ONLINE VOID returns stock
  UPDATE online_orders SET status = 'CANCELLED' WHERE id = v_oid;
  r := r || jsonb_build_object('coffee_after_cancel', inv_item_available(coffee)); ok := ok AND inv_item_available(coffee) = 1000;

  -- append-only: editing a real movement must fail
  BEGIN
    UPDATE inv_stock_transactions SET quantity = 99 WHERE id = (SELECT min(id) FROM inv_stock_transactions WHERE stock_unit_id = b_new);
    r := r || jsonb_build_object('append_only', 'NOT ENFORCED'); ok := false;
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('append_only', 'blocked');
  END;


  -- audit guards: reversal of a reversal refused; + Add refuses a foreign unit
  x := inv_reverse_movement((SELECT min(t.id) FROM inv_stock_transactions t JOIN inv_stock_units su ON su.id=t.stock_unit_id WHERE su.item_id=cake AND t.movement_type='WASTE'), 'test', 'USR_001');
  x := inv_reverse_movement((SELECT max(t.id) FROM inv_stock_transactions t WHERE t.parent_txn_id IS NOT NULL), 'test', 'USR_001');
  r := r || jsonb_build_object('reverse_reversal_refused', NOT (x->>'ok')::boolean); ok := ok AND NOT (x->>'ok')::boolean;
  x := inv_menu_add(NULL, cake, 1, 1, 0, 'USR_001', NULL);
  r := r || jsonb_build_object('foreign_unit_refused', x->>'code'); ok := ok AND x->>'code' = 'unit_not_allowed';
  r := r || jsonb_build_object('ledger_check', (SELECT COALESCE(jsonb_agg(to_jsonb(c)),'[]') FROM inv_ledger_check() c));
  ok := ok AND NOT EXISTS (SELECT 1 FROM inv_ledger_check());
  RAISE EXCEPTION 'INVTEST %', jsonb_build_object('pass', ok, 'checks', r)::text;
END $$;
