-- Audit fixes
-- 1. inv_reverse_movement: lock the movement and its batch so two clicks can't both reverse it,
--    and refuse to reverse a reversal (correct the original instead).
-- 2. inv_menu_add: only the item's stock unit or its purchase unit is accepted (anything else can't convert).
DO $$
DECLARE d text;
BEGIN
  d := pg_get_functiondef('public.inv_reverse_movement(bigint,text,text)'::regprocedure);
  IF position('FOR UPDATE' in d) = 0 THEN
    d := replace(d, $q$  SELECT * INTO t FROM inv_stock_transactions WHERE id = p_txn_id;$q$,
$q$  SELECT * INTO t FROM inv_stock_transactions WHERE id = p_txn_id FOR UPDATE;
  PERFORM 1 FROM inv_stock_units WHERE id = t.stock_unit_id FOR UPDATE;
  IF t.parent_txn_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok',false,'error','This is already a correction — reverse the original movement instead'); END IF;$q$);
    IF position('FOR UPDATE' in d) = 0 THEN RAISE EXCEPTION 'inv_reverse_movement patch did not apply'; END IF;
    EXECUTE d;
  END IF;

  d := pg_get_functiondef('public.inv_menu_add(text,bigint,numeric,bigint,numeric,text,text)'::regprocedure);
  IF position('unit_not_allowed' in d) = 0 THEN
    d := replace(d, $q$  IF it.id IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Item not found'); END IF;$q$,
$q$  IF it.id IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Item not found'); END IF;
  IF p_unit_id IS NOT NULL AND p_unit_id <> it.base_unit_id AND p_unit_id IS DISTINCT FROM it.purchase_unit_id THEN
    RETURN jsonb_build_object('ok',false,'error','Use the item''s own unit','code','unit_not_allowed'); END IF;$q$);
    IF position('unit_not_allowed' in d) = 0 THEN RAISE EXCEPTION 'inv_menu_add patch did not apply'; END IF;
    EXECUTE d;
  END IF;
END $$;
