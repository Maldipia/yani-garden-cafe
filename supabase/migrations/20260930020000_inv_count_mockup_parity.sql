-- Display Count as designed: Opening/Closing shifts, a Spoiled column inside the
-- count, batch + received date per row, spoilage approval above a threshold,
-- photo required above a threshold, count history.
ALTER TABLE inv_stock_transactions ADD COLUMN IF NOT EXISTS approved_by text;
ALTER TABLE inv_stock_transactions ADD COLUMN IF NOT EXISTS approved_at timestamptz;
INSERT INTO inv_config(key, value, description) VALUES
  ('spoilage_photo_above','100','Spoilage worth more than this (₱, menu price) needs a photo.'),
  ('spoilage_approval_above','200','Spoilage worth more than this (₱, menu price) waits for owner approval.')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.inv_menu_unit_price(p_item_id bigint)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE((SELECT min(m.base_price) FROM inv_menu_map mm JOIN menu_items m ON m.item_code = mm.menu_item_code
                    WHERE mm.inv_item_id = p_item_id AND mm.is_active AND m.is_active AND mm.deduct_mode='DIRECT'
                      AND COALESCE(mm.portions_per_sale,1) = 1), 0)
$$;

DROP FUNCTION IF EXISTS public.inv_count_sheet();
CREATE FUNCTION public.inv_count_sheet()
RETURNS TABLE(item_id bigint, name text, unit text, standard_yield numeric, system_qty numeric,
              next_expiry date, received_at timestamptz, batch_code text, menu_names text, menu_price numeric,
              unit_cost numeric, last_counted timestamptz, tracked boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  WITH first_unit AS (
    SELECT DISTINCT ON (su.item_id) su.item_id, su.expiry_date, su.date_received,
           COALESCE(b.batch_code, su.stock_unit_code) AS code
    FROM inv_stock_units su LEFT JOIN inv_batches b ON b.id = su.batch_id
    WHERE su.status IN ('in_stock','opened','partially_used') AND su.quantity_remaining > 0
    ORDER BY su.item_id, su.expiry_date NULLS LAST, su.date_received, su.id)
  SELECT i.id, i.name, u.name, i.standard_yield,
         ROUND(inv_item_available(i.id), 3),
         fu.expiry_date, fu.date_received, fu.code,
         (SELECT string_agg(m.name, ' · ' ORDER BY m.name) FROM inv_menu_map mm
            JOIN menu_items m ON m.item_code = mm.menu_item_code
           WHERE mm.inv_item_id = i.id AND mm.is_active AND m.is_active),
         inv_menu_unit_price(i.id),
         (SELECT su.unit_cost FROM inv_stock_units su WHERE su.item_id = i.id ORDER BY su.date_received DESC, su.id DESC LIMIT 1),
         (SELECT max(t.performed_at) FROM inv_stock_transactions t JOIN inv_stock_units su ON su.id = t.stock_unit_id
           WHERE su.item_id = i.id AND t.reference_type = 'count'),
         inv_item_tracked(i.id)
  FROM inv_items i JOIN inv_units u ON u.id = i.base_unit_id
  LEFT JOIN first_unit fu ON fu.item_id = i.id
  WHERE i.is_active AND i.item_type = 'PURCHASED_READY'
    AND (inv_item_tracked(i.id) OR EXISTS (
          SELECT 1 FROM inv_menu_map mm JOIN menu_items m ON m.item_code = mm.menu_item_code
           WHERE mm.inv_item_id = i.id AND mm.is_active AND mm.deduct_mode = 'DIRECT' AND m.is_active))
  ORDER BY inv_item_tracked(i.id) DESC, i.name
$$;

-- Spoilage: photo above threshold is required
CREATE OR REPLACE FUNCTION public.inv_record_spoilage(
  p_item_id bigint, p_qty numeric, p_reason text, p_notes text, p_actor text, p_photo text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_avail numeric; v_res jsonb; v_name text; v_val numeric;
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
  v_val := p_qty * inv_menu_unit_price(p_item_id);
  IF v_val > COALESCE(NULLIF(inv_cfg('spoilage_photo_above'),'')::numeric, 100) AND COALESCE(p_photo,'') = '' THEN
    RETURN jsonb_build_object('ok',false,'error', v_name || ': add a photo (worth ₱' || trim(to_char(v_val,'FM999999990.00')) || ')', 'photo_required', true);
  END IF;
  v_res := inv_take_stock(p_item_id, p_qty, 'waste', p_reason, 'spoilage', NULL, p_actor, p_notes, p_photo);
  RETURN v_res || jsonb_build_object('item', v_name, 'remaining', inv_item_available(p_item_id), 'value', v_val);
END $$;

-- Count with shift + spoiled column. Lines:
--   [{item_id, counted, seen, spoiled, spoil_reason, photo, reason, note}]
DROP FUNCTION IF EXISTS public.inv_submit_count(jsonb, text);
CREATE FUNCTION public.inv_submit_count(p_lines jsonb, p_actor text, p_shift text DEFAULT 'CLOSING')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE l record; v_sys numeric; v_exp numeric; v_diff numeric; v_ref text; v_su record; v_res jsonb; v_name text;
        v_n int := 0; v_diffs int := 0; v_new int := 0; v_spoil int := 0; v_waste_cost numeric := 0; v_missing_cost numeric := 0;
        v_after numeric; v_base bigint; v_cost numeric; v_sp numeric; v_val numeric;
BEGIN
  IF p_shift NOT IN ('OPENING','CLOSING') THEN RETURN jsonb_build_object('ok',false,'error','Pick Opening or Closing'); END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RETURN jsonb_build_object('ok',false,'error','Nothing to submit');
  END IF;
  FOR l IN SELECT * FROM jsonb_to_recordset(p_lines) AS x(item_id bigint, counted numeric, seen numeric, spoiled numeric,
                spoil_reason text, photo text, reason text, note text) LOOP
    SELECT name INTO v_name FROM inv_items WHERE id = l.item_id AND is_active;
    IF v_name IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Unknown item '||l.item_id); END IF;
    IF NOT inv_item_tracked(l.item_id) THEN
      IF l.counted IS NOT NULL AND l.counted < 0 THEN RETURN jsonb_build_object('ok',false,'error',v_name||': count cannot be negative'); END IF;
      CONTINUE;
    END IF;
    IF l.counted IS NULL OR l.counted < 0 THEN RETURN jsonb_build_object('ok',false,'error',v_name||': enter the count'); END IF;
    v_sys := inv_item_available(l.item_id);
    IF l.seen IS NOT NULL AND abs(l.seen - v_sys) > 0.0001 THEN
      RETURN jsonb_build_object('ok',false,'error',v_name||' changed while counting (a sale or spoilage). Reload and count again.','stock_changed',true);
    END IF;
    v_sp := COALESCE(l.spoiled,0);
    IF v_sp < 0 THEN RETURN jsonb_build_object('ok',false,'error',v_name||': spoiled cannot be negative'); END IF;
    IF v_sp > v_sys + 0.0001 THEN RETURN jsonb_build_object('ok',false,'error',v_name||': spoiled is more than the system has'); END IF;
    IF v_sp > 0 AND COALESCE(l.spoil_reason,'') NOT IN ('SPOILED','EXPIRED','DAMAGED','STAFF_MEAL','COMPLIMENTARY') THEN
      RETURN jsonb_build_object('ok',false,'error',v_name||': pick why it was spoiled');
    END IF;
    v_val := v_sp * inv_menu_unit_price(l.item_id);
    IF v_sp > 0 AND v_val > COALESCE(NULLIF(inv_cfg('spoilage_photo_above'),'')::numeric,100) AND COALESCE(l.photo,'') = '' THEN
      RETURN jsonb_build_object('ok',false,'error',v_name||': add a photo of the spoiled items','photo_required',true);
    END IF;
    v_diff := l.counted - (v_sys - v_sp);
    IF v_diff < -0.0001 AND COALESCE(l.reason,'') NOT IN ('SPOILED','EXPIRED','DAMAGED','STAFF_MEAL','COMPLIMENTARY','MISSING') THEN
      RETURN jsonb_build_object('ok',false,'error',v_name||': pick a reason for the missing '||trim(to_char(-v_diff,'FM999999990.##')));
    END IF;
  END LOOP;

  v_ref := 'COUNT-' || p_shift || '-' || to_char(clock_timestamp() AT TIME ZONE 'Asia/Manila', 'YYYYMMDD-HH24MISS');
  FOR l IN SELECT * FROM jsonb_to_recordset(p_lines) AS x(item_id bigint, counted numeric, seen numeric, spoiled numeric,
                spoil_reason text, photo text, reason text, note text) LOOP
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
    v_n := v_n + 1;
    v_sp := COALESCE(l.spoiled,0);
    IF v_sp > 0 THEN
      v_res := inv_take_stock(l.item_id, v_sp, 'waste', l.spoil_reason, 'count', v_ref, p_actor, l.note, NULLIF(l.photo,''));
      v_waste_cost := v_waste_cost + COALESCE((v_res->>'cost')::numeric,0);
      v_spoil := v_spoil + 1;
    END IF;
    v_exp := inv_item_available(l.item_id);
    v_diff := l.counted - v_exp;
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
  RETURN jsonb_build_object('ok',true,'count_ref',v_ref,'shift',p_shift,'items',v_n,'differences',v_diffs,'spoiled_lines',v_spoil,
                            'started',v_new,'spoiled_cost',ROUND(v_waste_cost,2),'missing_cost',ROUND(v_missing_cost,2));
END $$;

DROP FUNCTION IF EXISTS public.inv_day_log(date);
CREATE FUNCTION public.inv_day_log(p_date date)
RETURNS TABLE(txn_id bigint, performed_at timestamptz, item_id bigint, item_name text, unit text,
              qty numeric, kind text, reason text, notes text, photo_url text, performed_by text,
              performed_by_name text, reference_id text, batch_code text, value_cost numeric, value_menu numeric,
              needs_approval boolean, approved_by_name text, approved_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT t.id, t.performed_at, i.id, i.name, bu.name,
         inv_convert(t.quantity, t.unit_id, i.base_unit_id),
         CASE WHEN t.reference_type = 'count' THEN 'COUNT' ELSE 'SPOILAGE' END,
         COALESCE(t.reason, CASE WHEN t.transaction_type='waste' THEN 'SPOILED' END),
         t.notes, t.photo_url, t.performed_by,
         (SELECT s.display_name FROM staff_users s WHERE s.user_id = t.performed_by LIMIT 1),
         t.reference_id,
         COALESCE(b.batch_code, su.stock_unit_code),
         ROUND(abs(t.quantity) * COALESCE(su.unit_cost,0), 2),
         ROUND(abs(inv_convert(t.quantity, t.unit_id, i.base_unit_id)) * inv_menu_unit_price(i.id), 2),
         (t.transaction_type = 'waste' AND t.approved_by IS NULL
           AND abs(inv_convert(t.quantity, t.unit_id, i.base_unit_id)) * inv_menu_unit_price(i.id)
               > COALESCE(NULLIF(inv_cfg('spoilage_approval_above'),'')::numeric, 200)),
         (SELECT s.display_name FROM staff_users s WHERE s.user_id = t.approved_by LIMIT 1),
         t.approved_at
  FROM inv_stock_transactions t
  JOIN inv_stock_units su ON su.id = t.stock_unit_id
  LEFT JOIN inv_batches b ON b.id = su.batch_id
  JOIN inv_items i ON i.id = su.item_id
  JOIN inv_units bu ON bu.id = i.base_unit_id
  WHERE (t.performed_at AT TIME ZONE 'Asia/Manila')::date = p_date
    AND (t.transaction_type = 'waste' OR t.reference_type = 'count')
  ORDER BY t.performed_at DESC, t.id DESC
$$;

CREATE OR REPLACE FUNCTION public.inv_approve_spoilage(p_txn_id bigint, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  UPDATE inv_stock_transactions SET approved_by = p_actor, approved_at = now()
   WHERE id = p_txn_id AND transaction_type = 'waste' AND approved_by IS NULL;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','Not found or already approved'); END IF;
  RETURN jsonb_build_object('ok',true,'txn_id',p_txn_id);
END $$;

-- Recent counts for the History tab
CREATE OR REPLACE FUNCTION public.inv_count_history(p_days int DEFAULT 14)
RETURNS TABLE(count_ref text, shift text, counted_at timestamptz, performed_by_name text,
              items int, differences int, spoiled_value numeric, missing_value numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT t.reference_id,
         CASE WHEN t.reference_id LIKE 'COUNT-OPENING-%' THEN 'OPENING' ELSE 'CLOSING' END,
         min(t.performed_at),
         (SELECT s.display_name FROM staff_users s WHERE s.user_id = min(t.performed_by) LIMIT 1),
         count(DISTINCT su.item_id)::int,
         count(*) FILTER (WHERE t.reason IN ('MISSING','FOUND') OR (t.transaction_type='waste'))::int,
         ROUND(COALESCE(sum(abs(inv_convert(t.quantity,t.unit_id,i.base_unit_id)) * inv_menu_unit_price(i.id))
               FILTER (WHERE t.transaction_type='waste'),0),2),
         ROUND(COALESCE(sum(abs(inv_convert(t.quantity,t.unit_id,i.base_unit_id)) * inv_menu_unit_price(i.id))
               FILTER (WHERE t.reason='MISSING'),0),2)
  FROM inv_stock_transactions t
  JOIN inv_stock_units su ON su.id = t.stock_unit_id
  JOIN inv_items i ON i.id = su.item_id
  WHERE t.reference_type = 'count' AND t.performed_at > now() - make_interval(days => GREATEST(p_days,1))
  GROUP BY t.reference_id
  ORDER BY min(t.performed_at) DESC
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.inv_menu_unit_price(bigint)','public.inv_count_sheet()',
    'public.inv_record_spoilage(bigint,numeric,text,text,text,text)','public.inv_submit_count(jsonb,text,text)',
    'public.inv_day_log(date)','public.inv_approve_spoilage(bigint,text)','public.inv_count_history(integer)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;
