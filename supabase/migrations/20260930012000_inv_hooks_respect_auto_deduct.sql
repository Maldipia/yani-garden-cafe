-- The existing Settings switch "auto_deduct_on_sale" now actually governs the
-- order hooks (module must be on AND auto-deduct on).
DO $mig$
DECLARE src text; n text;
BEGIN
  FOREACH src IN ARRAY ARRAY['public.trg_inv_order_status()','public.trg_inv_items_added()'] LOOP
    n := pg_get_functiondef(src::regprocedure);
    n := replace(n, 'IF inv_cfg(''module_enabled'') IS DISTINCT FROM ''true'' THEN',
                    'IF inv_cfg(''module_enabled'') IS DISTINCT FROM ''true'' OR inv_cfg(''auto_deduct_on_sale'') IS DISTINCT FROM ''true'' THEN');
    IF position('auto_deduct_on_sale' IN n) = 0 THEN RAISE EXCEPTION 'patch failed for %', src; END IF;
    EXECUTE n;
  END LOOP;
END $mig$;
