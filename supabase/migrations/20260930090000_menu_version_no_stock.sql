-- Owner decision 2026-09-30: the customer menu never shows stock, so the menu cache
-- no longer needs to change on stock movements or open-order reservations.
CREATE OR REPLACE FUNCTION public.menu_version()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT count(*)::text || '|' || COALESCE(max(updated_at)::text, '')
  FROM menu_items;
$function$;
