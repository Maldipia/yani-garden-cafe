-- Audit 2026-09-30: close public read access found during the security audit.
-- The anon key is public (served to kitchen/track pages), so anything granted to anon/authenticated is world-readable.
-- These views run as their owner (bypass RLS) and were readable by anon:
--   inv_v_price_intel (supplier prices), inv_v_purchase_summary, inv_v_consumption_queue, account_with_progress (loyalty accounts).
-- Only the server (service_role) reads them, so revoking changes nothing for the app.
REVOKE ALL ON public.inv_v_price_intel, public.inv_v_purchase_summary, public.inv_v_consumption_queue,
              public.account_with_progress FROM anon, authenticated;
GRANT SELECT ON public.inv_v_price_intel, public.inv_v_purchase_summary, public.inv_v_consumption_queue,
                public.account_with_progress TO service_role;
-- and make them respect the caller's permissions from now on
ALTER VIEW public.inv_v_price_intel SET (security_invoker = true);
ALTER VIEW public.inv_v_purchase_summary SET (security_invoker = true);
ALTER VIEW public.inv_v_consumption_queue SET (security_invoker = true);
ALTER VIEW public.account_with_progress SET (security_invoker = true);

-- Inventory tables: RLS already blocks anon rows, but remove the leftover grants entirely (defence in depth).
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r' AND (c.relname LIKE 'inv\_%' OR c.relname = 'stock_consumption_guard') LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
  END LOOP;
END $$;

-- A trigger function that anyone could call over the REST API
REVOKE EXECUTE ON FUNCTION public.log_menu_item_active_change() FROM PUBLIC, anon, authenticated;

-- Pin the search path on the label helper used by the ledger trigger
ALTER FUNCTION public.inv_movement_label(text,text,text,text,text) SET search_path TO 'public';
