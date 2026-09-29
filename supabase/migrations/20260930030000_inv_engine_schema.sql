-- ══════════════════════════════════════════════════════════════════════
-- Inventory engine, part 1: schema (additive only — nothing dropped)
--  • per-item purchase unit → stock unit conversion, par, shelf life, rotation
--  • size-specific recipes, add-on → inventory link
--  • ledger fields: movement_type, source_ref, location, unit cost, cost impact
--  • stock shortage exceptions
--  • movement_type derived centrally on insert; ledger append-only
-- ══════════════════════════════════════════════════════════════════════

-- 2. unit / conversion fields -----------------------------------------------
ALTER TABLE inv_items ADD COLUMN IF NOT EXISTS purchase_unit_id   bigint REFERENCES inv_units(id);
ALTER TABLE inv_items ADD COLUMN IF NOT EXISTS purchase_to_stock  numeric;          -- 1 purchase unit = N stock units
ALTER TABLE inv_items ADD COLUMN IF NOT EXISTS par_level          numeric;
ALTER TABLE inv_items ADD COLUMN IF NOT EXISTS shelf_life_days    integer;
ALTER TABLE inv_items ADD COLUMN IF NOT EXISTS rotation           text NOT NULL DEFAULT 'FEFO';
ALTER TABLE inv_items ADD COLUMN IF NOT EXISTS default_supplier_id bigint REFERENCES inv_suppliers(id);
ALTER TABLE inv_items ADD COLUMN IF NOT EXISTS default_location_id bigint REFERENCES inv_locations(id);
ALTER TABLE inv_items ADD COLUMN IF NOT EXISTS merged_into_id     bigint REFERENCES inv_items(id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inv_items_rotation_chk') THEN
    ALTER TABLE inv_items ADD CONSTRAINT inv_items_rotation_chk CHECK (rotation IN ('FEFO','FIFO'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inv_items_purchase_conv_chk') THEN
    ALTER TABLE inv_items ADD CONSTRAINT inv_items_purchase_conv_chk CHECK (purchase_to_stock IS NULL OR purchase_to_stock > 0);
  END IF;
END $$;

-- 9. size-specific recipes: NULL = the item's default recipe ------------------
ALTER TABLE inv_recipes ADD COLUMN IF NOT EXISTS size_code text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inv_recipes_size_chk') THEN
    ALTER TABLE inv_recipes ADD CONSTRAINT inv_recipes_size_chk CHECK (size_code IS NULL OR size_code IN ('SHORT','MEDIUM','TALL','SLICE','WHOLE'));
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS inv_recipes_one_active_per_size
  ON inv_recipes (item_id, COALESCE(size_code,'*')) WHERE is_active;

-- 10. add-ons → inventory ------------------------------------------------------
ALTER TABLE menu_addons ADD COLUMN IF NOT EXISTS inv_item_id bigint REFERENCES inv_items(id);
ALTER TABLE menu_addons ADD COLUMN IF NOT EXISTS inv_qty     numeric;
ALTER TABLE menu_addons ADD COLUMN IF NOT EXISTS inv_unit_id bigint REFERENCES inv_units(id);

-- 3. ledger fields --------------------------------------------------------------
ALTER TABLE inv_stock_transactions ADD COLUMN IF NOT EXISTS movement_type text;
ALTER TABLE inv_stock_transactions ADD COLUMN IF NOT EXISTS source_ref    text;
ALTER TABLE inv_stock_transactions ADD COLUMN IF NOT EXISTS location_id   bigint;
ALTER TABLE inv_stock_transactions ADD COLUMN IF NOT EXISTS unit_cost     numeric;
ALTER TABLE inv_stock_transactions ADD COLUMN IF NOT EXISTS cost_impact   numeric;
ALTER TABLE inv_stock_transactions DROP CONSTRAINT IF EXISTS inv_stock_transactions_reason_chk;
ALTER TABLE inv_stock_transactions ADD CONSTRAINT inv_stock_transactions_reason_chk
  CHECK (reason IS NULL OR reason IN ('SPOILED','EXPIRED','DAMAGED','BREAKAGE','WASTE','STAFF_MEAL','COMPLIMENTARY',
                                      'MISSING','FOUND','COUNTED','PHYSICAL_VARIANCE','CORRECTION','MERGE'));
CREATE INDEX IF NOT EXISTS inv_stock_tx_source_idx ON inv_stock_transactions (source_ref);
CREATE INDEX IF NOT EXISTS inv_stock_tx_movement_idx ON inv_stock_transactions (movement_type, performed_at);

-- stock shortage exceptions (sale completed, stock on record was not enough)
CREATE TABLE IF NOT EXISTS inv_stock_exceptions (
  id            bigserial PRIMARY KEY,
  item_id       bigint NOT NULL REFERENCES inv_items(id),
  qty_short     numeric NOT NULL CHECK (qty_short > 0),
  unit_id       bigint REFERENCES inv_units(id),
  source_ref    text NOT NULL,
  channel       text,
  menu_item_code text,
  detail        text,
  status        text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  resolved_by   text,
  resolved_at   timestamptz,
  resolution_note text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inv_stock_exceptions_open_idx ON inv_stock_exceptions (status, created_at DESC);
ALTER TABLE inv_stock_exceptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON inv_stock_exceptions FROM anon, authenticated;
REVOKE ALL ON SEQUENCE inv_stock_exceptions_id_seq FROM anon, authenticated;

-- one consumption event per sale: the guard key is the source ref (POS-…, ONLINE-…)
ALTER TABLE stock_consumption_guard ADD COLUMN IF NOT EXISTS channel text;

CREATE SEQUENCE IF NOT EXISTS inv_seq_waste;
CREATE SEQUENCE IF NOT EXISTS inv_seq_adjust;

-- central movement-type derivation (every writer gets it, old and new) ----------
CREATE OR REPLACE FUNCTION public.inv_movement_label(p_tx_type text, p_ref_type text, p_reason text, p_source text, p_notes text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_tx_type = 'receive' AND (p_ref_type = 'opening' OR p_notes ILIKE 'Opening balance%') THEN 'OPENING BALANCE'
    WHEN p_tx_type = 'receive' AND p_ref_type = 'transfer_in' THEN 'TRANSFER'
    WHEN p_tx_type = 'receive' THEN 'PURCHASE'
    WHEN p_tx_type = 'produce' THEN 'PRODUCTION'
    WHEN p_tx_type = 'consume' AND p_ref_type = 'production' THEN 'PRODUCTION CONSUMPTION'
    WHEN p_tx_type = 'consume' AND p_ref_type = 'sale' AND COALESCE(p_source,'') LIKE 'ONLINE-%' THEN 'ONLINE SALE'
    WHEN p_tx_type = 'consume' AND p_ref_type = 'sale' THEN 'POS SALE'
    WHEN p_tx_type = 'return' AND p_ref_type = 'sale_reversal' AND COALESCE(p_source,'') LIKE 'ONLINE-%' THEN 'ONLINE VOID'
    WHEN p_tx_type = 'return' AND p_ref_type = 'sale_reversal' THEN 'POS VOID'
    WHEN p_tx_type = 'return' AND p_ref_type = 'pos_return' THEN 'POS RETURN'
    WHEN p_tx_type = 'return' THEN 'RETURN TO SUPPLIER'
    WHEN p_tx_type = 'waste' AND p_reason IN ('SPOILED','EXPIRED') THEN 'SPOILAGE'
    WHEN p_tx_type = 'waste' AND p_reason IN ('DAMAGED','BREAKAGE') THEN 'BREAKAGE'
    WHEN p_tx_type = 'waste' AND p_reason = 'STAFF_MEAL' THEN 'STAFF MEAL'
    WHEN p_tx_type = 'waste' AND p_reason = 'COMPLIMENTARY' THEN 'COMPLIMENTARY'
    WHEN p_tx_type = 'waste' THEN 'WASTE'
    WHEN p_tx_type = 'count' THEN 'STOCK COUNT'
    WHEN p_tx_type = 'transfer' THEN 'TRANSFER'
    WHEN p_tx_type = 'portion' THEN 'PORTIONING'
    ELSE 'STOCK ADJUSTMENT'
  END
$$;

-- 4. backfill existing movements (before the ledger is locked) ----------------
UPDATE inv_stock_transactions t SET
  source_ref    = COALESCE(t.source_ref, CASE
                    WHEN t.reference_type = 'sale' THEN 'POS-' || t.reference_id
                    WHEN t.reference_id IS NOT NULL THEN upper(COALESCE(t.reference_type,'MANUAL')) || '-' || t.reference_id
                    ELSE upper(COALESCE(t.reference_type,'MANUAL')) || '-TX' || t.id END),
  location_id   = COALESCE(t.location_id, su.location_id),
  unit_cost     = COALESCE(t.unit_cost, su.unit_cost),
  cost_impact   = COALESCE(t.cost_impact, ROUND(t.quantity * COALESCE(su.unit_cost,0), 4)),
  movement_type = COALESCE(t.movement_type, inv_movement_label(t.transaction_type, t.reference_type, t.reason,
                    CASE WHEN t.reference_type='sale' THEN 'POS-' || t.reference_id END, t.notes))
FROM inv_stock_units su WHERE su.id = t.stock_unit_id;

ALTER TABLE inv_stock_transactions DROP CONSTRAINT IF EXISTS inv_stock_transactions_movement_chk;
ALTER TABLE inv_stock_transactions ADD CONSTRAINT inv_stock_transactions_movement_chk CHECK (movement_type IN (
  'PURCHASE','OPENING BALANCE','POS SALE','ONLINE SALE','POS VOID','ONLINE VOID','POS RETURN','WASTE','SPOILAGE',
  'BREAKAGE','STAFF MEAL','COMPLIMENTARY','PRODUCTION','PRODUCTION CONSUMPTION','TRANSFER','STOCK COUNT',
  'STOCK ADJUSTMENT','RETURN TO SUPPLIER','PORTIONING'));

-- fill the derived fields on every new movement
CREATE OR REPLACE FUNCTION public.trg_inv_tx_fill()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE su record;
BEGIN
  SELECT location_id, unit_cost INTO su FROM inv_stock_units WHERE id = NEW.stock_unit_id;
  NEW.location_id := COALESCE(NEW.location_id, su.location_id);
  NEW.unit_cost   := COALESCE(NEW.unit_cost, su.unit_cost);
  NEW.cost_impact := COALESCE(NEW.cost_impact, ROUND(NEW.quantity * COALESCE(NEW.unit_cost,0), 4));
  NEW.source_ref  := COALESCE(NEW.source_ref, CASE
                       WHEN NEW.reference_type = 'sale' THEN 'POS-' || NEW.reference_id
                       WHEN NEW.reference_id IS NOT NULL THEN upper(COALESCE(NEW.reference_type,'MANUAL')) || '-' || NEW.reference_id
                       ELSE upper(COALESCE(NEW.reference_type,'MANUAL')) || '-' || to_char(clock_timestamp(),'YYMMDDHH24MISSMS') END);
  NEW.movement_type := COALESCE(NEW.movement_type,
                       inv_movement_label(NEW.transaction_type, NEW.reference_type, NEW.reason, NEW.source_ref, NEW.notes));
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_inv_tx_fill ON inv_stock_transactions;
CREATE TRIGGER trg_inv_tx_fill BEFORE INSERT ON inv_stock_transactions
  FOR EACH ROW EXECUTE FUNCTION trg_inv_tx_fill();

ALTER TABLE inv_stock_transactions ALTER COLUMN movement_type SET NOT NULL;
ALTER TABLE inv_stock_transactions ALTER COLUMN source_ref SET NOT NULL;

-- 5. append-only ledger ----------------------------------------------------------
-- No edit, no delete. The only allowed change is stamping an approval once.
-- (The module self-test may clean up its own TST- items.)
CREATE OR REPLACE FUNCTION public.trg_inv_tx_append_only()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM inv_stock_units su JOIN inv_items i ON i.id = su.item_id
                WHERE su.id = OLD.stock_unit_id AND i.item_code LIKE 'TST-%') THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Stock movements cannot be deleted — record a reversal instead (movement %)', OLD.id;
  END IF;
  IF (to_jsonb(NEW) - 'approved_by' - 'approved_at') IS DISTINCT FROM (to_jsonb(OLD) - 'approved_by' - 'approved_at')
     OR (OLD.approved_by IS NOT NULL AND NEW.approved_by IS DISTINCT FROM OLD.approved_by) THEN
    RAISE EXCEPTION 'Stock movements cannot be edited — record a reversal instead (movement %)', OLD.id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_inv_tx_append_only ON inv_stock_transactions;
CREATE TRIGGER trg_inv_tx_append_only BEFORE UPDATE OR DELETE ON inv_stock_transactions
  FOR EACH ROW EXECUTE FUNCTION trg_inv_tx_append_only();
REVOKE UPDATE, DELETE, TRUNCATE ON inv_stock_transactions FROM anon, authenticated;

REVOKE ALL ON FUNCTION public.trg_inv_tx_fill() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_inv_tx_append_only() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.inv_movement_label(text,text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_movement_label(text,text,text,text,text) TO service_role;

-- Buco Melt Pie: bought by the box of 8, sold by the slice
UPDATE inv_items SET purchase_unit_id = (SELECT id FROM inv_units WHERE name='box'), purchase_to_stock = 8,
       rotation = 'FEFO'
 WHERE id = 178 AND purchase_unit_id IS NULL;
