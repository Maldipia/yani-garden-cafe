-- A menu item made from a recipe (lattes, frappes…) is stocked through its ingredients.
-- "Add item to count" must never switch its mapping from RECIPE to DIRECT.
DO $$
DECLARE d text;
BEGIN
  -- 1. refuse in inv_start_menu_count
  d := pg_get_functiondef('public.inv_start_menu_count(text,numeric,text,text)'::regprocedure);
  IF position('made from a recipe' in d) = 0 THEN
    d := replace(d, $q$  SELECT i.id INTO v_item FROM inv_menu_map mm JOIN inv_items i ON i.id = mm.inv_item_id AND i.is_active$q$,
$q$  IF EXISTS (SELECT 1 FROM inv_menu_map r WHERE r.menu_item_code = p_menu_code AND r.is_active AND r.deduct_mode = 'RECIPE') THEN
    RETURN jsonb_build_object('ok',false,'error',m.name||' is made from a recipe — count its ingredients instead');
  END IF;
  SELECT i.id INTO v_item FROM inv_menu_map mm JOIN inv_items i ON i.id = mm.inv_item_id AND i.is_active$q$);
    IF position('made from a recipe' in d) = 0 THEN RAISE EXCEPTION 'inv_start_menu_count patch did not apply'; END IF;
    EXECUTE d;
  END IF;

  -- 2. hide recipe-made menu items from the count candidates
  d := pg_get_functiondef('public.inv_count_sheet()'::regprocedure);
  IF position('rm.deduct_mode = ''RECIPE''' in d) = 0 THEN
    d := replace(d, $q$      AND (i.id IS NULL OR NOT inv_item_tracked(i.id))$q$,
$q$      AND (i.id IS NULL OR NOT inv_item_tracked(i.id))
      AND NOT EXISTS (SELECT 1 FROM inv_menu_map rm WHERE rm.menu_item_code = m.item_code AND rm.is_active AND rm.deduct_mode = 'RECIPE')$q$);
    IF position('rm.deduct_mode = ''RECIPE''' in d) = 0 THEN RAISE EXCEPTION 'inv_count_sheet patch did not apply'; END IF;
    EXECUTE d;
  END IF;
END $$;
