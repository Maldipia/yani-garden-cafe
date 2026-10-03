-- Waste now needs the manager PIN (the same PIN as cancel/delete order). The API checks the PIN
-- (bcrypt, server-side) and passes p_pin_ok = true. With a verified PIN:
--   • the photo is optional (it is still saved if one is attached)
--   • the waste counts as manager-approved (approved_by = '<actor> · PIN'), so it doesn't
--     wait in the owner's approval queue
-- New function beside inv_record_spoilage (left as is, no longer called by the API).
-- Without p_pin_ok the old rule stays: a photo is needed above spoilage_photo_above.
CREATE OR REPLACE FUNCTION public.inv_record_waste(p_item_id bigint, p_qty numeric, p_reason text, p_notes text,
                                           p_actor text, p_photo text DEFAULT NULL, p_pin_ok boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_avail numeric; v_res jsonb; v_name text; v_val numeric; v_ref text;
BEGIN
  IF p_reason NOT IN ('SPOILED','EXPIRED','DAMAGED','BREAKAGE','WASTE','STAFF_MEAL','COMPLIMENTARY') THEN
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
  IF NOT COALESCE(p_pin_ok,false)
     AND v_val > COALESCE(NULLIF(inv_cfg('spoilage_photo_above'),'')::numeric, 100) AND COALESCE(p_photo,'') = '' THEN
    RETURN jsonb_build_object('ok',false,'error', v_name || ': add a photo (worth ₱' || trim(to_char(v_val,'FM999999990.00')) || ')', 'photo_required', true);
  END IF;
  v_ref := 'WASTE-' || lpad(nextval('inv_seq_waste')::text, 5, '0');
  v_res := inv_take_stock(p_item_id, p_qty, 'waste', p_reason, 'spoilage', v_ref, p_actor, p_notes, p_photo, v_ref);
  IF COALESCE(p_pin_ok,false) AND COALESCE((v_res->>'ok')::boolean, true) THEN
    UPDATE inv_stock_transactions SET approved_by = left(p_actor || ' · PIN', 80), approved_at = now()
     WHERE source_ref = v_ref AND transaction_type = 'waste' AND approved_by IS NULL;
  END IF;
  RETURN v_res || jsonb_build_object('item', v_name, 'remaining', inv_item_available(p_item_id), 'value', v_val,
                                     'source_ref', v_ref, 'pin_verified', COALESCE(p_pin_ok,false));
END $$;

REVOKE ALL ON FUNCTION public.inv_record_waste(bigint, numeric, text, text, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_record_waste(bigint, numeric, text, text, text, text, boolean) TO service_role;
