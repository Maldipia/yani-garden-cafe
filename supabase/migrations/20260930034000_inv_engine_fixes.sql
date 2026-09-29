-- Fixes found by the cake acceptance test
-- 1. stock count accepts PHYSICAL_VARIANCE (unexplained difference) as the reason for a shortfall;
--    it is recorded as a STOCK COUNT movement with reason PHYSICAL_VARIANCE, theoretical/physical in notes.
-- 2. explain-stock orders movements by ledger id (same-transaction rows share a timestamp)
--    and starts the formula from the opening balance: "18 + 16 purchase − 3 pos sale − 2 waste = 29 slice".

DO $$
DECLARE d text;
BEGIN
  d := pg_get_functiondef('public.inv_submit_count(jsonb,text,text)'::regprocedure);
  IF position('PHYSICAL_VARIANCE' in d) = 0 THEN
    d := replace(d, $q$NOT IN ('SPOILED','EXPIRED','DAMAGED','STAFF_MEAL','COMPLIMENTARY','MISSING')$q$,
                    $q$NOT IN ('SPOILED','EXPIRED','DAMAGED','STAFF_MEAL','COMPLIMENTARY','MISSING','PHYSICAL_VARIANCE')$q$);
    d := replace(d, $q$IF l.reason = 'MISSING' THEN$q$, $q$IF l.reason IN ('MISSING','PHYSICAL_VARIANCE') THEN$q$);
    d := replace(d, $q$v_res := inv_take_stock(l.item_id, -v_diff, 'count', 'MISSING', 'count'$q$,
                    $q$v_res := inv_take_stock(l.item_id, -v_diff, 'count', l.reason, 'count'$q$);
    IF position('PHYSICAL_VARIANCE' in d) = 0 OR position($q$'count', l.reason, 'count'$q$ in d) = 0 THEN
      RAISE EXCEPTION 'inv_submit_count patch did not apply';
    END IF;
    EXECUTE d;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.inv_explain_stock(p_item_id bigint, p_from timestamptz DEFAULT NULL, p_to timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_open numeric; v_start numeric; v_sum numeric; v_close numeric; v_now numeric; v_lines jsonb; v_groups jsonb;
        v_unit text; v_formula text;
        v_to timestamptz := COALESCE(p_to, 'infinity'); v_from timestamptz := COALESCE(p_from, '-infinity');
BEGIN
  SELECT u.name INTO v_unit FROM inv_items i JOIN inv_units u ON u.id = i.base_unit_id WHERE i.id = p_item_id;
  IF v_unit IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Item not found'); END IF;
  SELECT COALESCE(SUM(qty),0) INTO v_open FROM inv_item_ledger(p_item_id, v_to) WHERE performed_at < v_from;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', txn_id, 'at', performed_at, 'type', movement_type, 'qty', qty, 'batch', batch,
                                               'source', source_ref, 'by', by_name, 'reason', reason, 'cost', cost)
                            ORDER BY txn_id), '[]'::jsonb), COALESCE(SUM(qty),0)
    INTO v_lines, v_sum FROM inv_item_ledger(p_item_id, v_to) WHERE performed_at >= v_from AND qty <> 0;
  -- opening balances inside the window are the starting stock, not a movement to add
  SELECT v_open + COALESCE(SUM(qty),0) INTO v_start FROM inv_item_ledger(p_item_id, v_to)
   WHERE performed_at >= v_from AND movement_type = 'OPENING BALANCE';
  SELECT COALESCE(jsonb_agg(jsonb_build_object('type', movement_type, 'qty', q) ORDER BY first_id), '[]'::jsonb),
         string_agg(CASE WHEN q >= 0 THEN ' + ' ELSE ' − ' END || trim(to_char(abs(q),'FM999999990.###')) || ' ' || lower(movement_type), ''
                    ORDER BY first_id) FILTER (WHERE movement_type <> 'OPENING BALANCE')
    INTO v_groups, v_formula
    FROM (SELECT movement_type, SUM(qty) q, MIN(txn_id) first_id FROM inv_item_ledger(p_item_id, v_to)
          WHERE performed_at >= v_from AND qty <> 0 GROUP BY movement_type) g;
  v_close := v_open + v_sum;
  v_now := inv_item_available(p_item_id);
  RETURN jsonb_build_object('ok', true, 'item_id', p_item_id, 'unit', v_unit,
    'opening', v_open, 'starting', v_start, 'movements', v_lines, 'by_type', v_groups, 'closing', v_close,
    'formula', trim(to_char(v_start,'FM999999990.###')) || COALESCE(v_formula,'') || ' = ' || trim(to_char(v_close,'FM999999990.###')) || ' ' || v_unit,
    'current_stock', v_now,
    'reconciles', (p_to IS NOT NULL OR abs(v_close - v_now) < 0.0005),
    'batches', (SELECT COALESCE(jsonb_agg(jsonb_build_object('batch', COALESCE(b.batch_code, su.stock_unit_code),
                    'received', su.date_received, 'expiry', su.expiry_date,
                    'original', inv_convert(su.quantity_original, su.unit_id, i.base_unit_id),
                    'remaining', inv_convert(su.quantity_remaining, su.unit_id, i.base_unit_id), 'unit_cost', su.unit_cost)
                    ORDER BY su.expiry_date NULLS LAST, su.date_received, su.id), '[]'::jsonb)
                FROM inv_stock_units su JOIN inv_items i ON i.id = su.item_id LEFT JOIN inv_batches b ON b.id = su.batch_id
                WHERE su.item_id = p_item_id AND su.quantity_remaining > 0));
END $$;

REVOKE ALL ON FUNCTION public.inv_explain_stock(bigint,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_explain_stock(bigint,timestamptz,timestamptz) TO service_role;
