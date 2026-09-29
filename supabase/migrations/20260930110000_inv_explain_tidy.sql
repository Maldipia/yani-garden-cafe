-- "Why this number?" shows only the item's own ledger (a merged duplicate keeps its own history)
-- and leaves out movement types that net to zero (e.g. a cost correction: −20 then +20).
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
  WHERE i.id = p_item_id AND t.performed_at < COALESCE(p_to, 'infinity')
$$;
DO $$
DECLARE d text;
BEGIN
  d := pg_get_functiondef('public.inv_explain_stock(bigint,timestamptz,timestamptz)'::regprocedure);
  IF position('HAVING abs(SUM(qty))' in d) = 0 THEN
    d := replace(d, 'WHERE performed_at >= v_from AND qty <> 0 GROUP BY movement_type) g;',
                    'WHERE performed_at >= v_from AND qty <> 0 GROUP BY movement_type HAVING abs(SUM(qty)) > 0.0005) g;');
    IF position('HAVING abs(SUM(qty))' in d) = 0 THEN RAISE EXCEPTION 'explain patch did not apply'; END IF;
    EXECUTE d;
  END IF;
END $$;
