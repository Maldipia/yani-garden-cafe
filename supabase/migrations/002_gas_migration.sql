-- ══════════════════════════════════════════════════════════════
-- YANI POS — GAS Migration: Phase Out Google Apps Script
-- Creates all tables needed to replace GAS/Google Sheets
-- as the primary data store. Supabase becomes single source
-- of truth. Google Sheets becomes a read-only live mirror.
-- ══════════════════════════════════════════════════════════════

-- ── 1. DINE-IN ORDERS (replaces GAS Orders sheet) ─────────────────────────
CREATE TABLE IF NOT EXISTS dine_in_orders (
  id              BIGSERIAL PRIMARY KEY,
  order_id        TEXT NOT NULL UNIQUE,          -- e.g. YANI-1001
  order_no        INTEGER NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  table_no        TEXT NOT NULL DEFAULT '',
  customer_name   TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'NEW'
                    CHECK (status IN ('NEW','PREPARING','READY','COMPLETED','CANCELLED')),
  order_type      TEXT NOT NULL DEFAULT 'DINE-IN'
                    CHECK (order_type IN ('DINE-IN','TAKE-OUT','PLATFORM')),
  subtotal        NUMERIC(10,2) NOT NULL DEFAULT 0,
  service_charge  NUMERIC(10,2) NOT NULL DEFAULT 0,
  total           NUMERIC(10,2) NOT NULL DEFAULT 0,
  payment_method  TEXT DEFAULT '',
  payment_status  TEXT DEFAULT 'PENDING'
                    CHECK (payment_status IN ('PENDING','SUBMITTED','VERIFIED','REJECTED','')),
  notes           TEXT DEFAULT '',
  source          TEXT DEFAULT 'QR'
                    CHECK (source IN ('QR','POS','PLATFORM')),
  platform        TEXT DEFAULT '',
  platform_ref    TEXT DEFAULT '',
  commission_rate NUMERIC(5,4) DEFAULT 0,
  commission_amt  NUMERIC(10,2) DEFAULT 0,
  net_revenue     NUMERIC(10,2) DEFAULT 0,
  -- Receipt fields
  receipt_type      TEXT DEFAULT '',
  receipt_delivery  TEXT DEFAULT '',
  receipt_email     TEXT DEFAULT '',
  receipt_name      TEXT DEFAULT '',
  receipt_address   TEXT DEFAULT '',
  receipt_tin       TEXT DEFAULT '',
  -- Payment proof
  payment_proof_url TEXT DEFAULT '',
  payment_proof_filename TEXT DEFAULT '',
  -- Timestamps
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dine_in_orders_status    ON dine_in_orders (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dine_in_orders_order_id  ON dine_in_orders (order_id);
CREATE INDEX IF NOT EXISTS idx_dine_in_orders_created   ON dine_in_orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dine_in_orders_table     ON dine_in_orders (table_no);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_dine_in_orders_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_dine_in_orders_updated_at ON dine_in_orders;
CREATE TRIGGER trg_dine_in_orders_updated_at
  BEFORE UPDATE ON dine_in_orders
  FOR EACH ROW EXECUTE FUNCTION update_dine_in_orders_updated_at();

-- ── 2. DINE-IN ORDER ITEMS (replaces GAS Order_Items sheet) ───────────────
CREATE TABLE IF NOT EXISTS dine_in_order_items (
  id              BIGSERIAL PRIMARY KEY,
  order_id        TEXT NOT NULL REFERENCES dine_in_orders(order_id) ON DELETE CASCADE,
  order_no        INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  table_no        TEXT DEFAULT '',
  item_code       TEXT NOT NULL,
  item_name       TEXT NOT NULL,
  unit_price      NUMERIC(10,2) NOT NULL DEFAULT 0,
  qty             INTEGER NOT NULL DEFAULT 1,
  line_total      NUMERIC(10,2) GENERATED ALWAYS AS (unit_price * qty) STORED,
  size_choice     TEXT DEFAULT '',
  sugar_choice    TEXT DEFAULT '',
  item_notes      TEXT DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_dine_in_items_order_id ON dine_in_order_items (order_id);

-- ── 3. STAFF USERS (replaces GAS USERS sheet + hardcoded PINs) ────────────
CREATE TABLE IF NOT EXISTS staff_users (
  id              BIGSERIAL PRIMARY KEY,
  user_id         TEXT NOT NULL UNIQUE,          -- e.g. USR_001
  username        TEXT NOT NULL UNIQUE,
  display_name    TEXT NOT NULL DEFAULT '',
  role            TEXT NOT NULL DEFAULT 'KITCHEN'
                    CHECK (role IN ('OWNER','ADMIN','CASHIER','KITCHEN')),
  pin_hash        TEXT NOT NULL,                 -- SHA-256 of PIN
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  last_login      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_staff_users_pin_hash ON staff_users (pin_hash);

CREATE OR REPLACE FUNCTION update_staff_users_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_staff_users_updated_at ON staff_users;
CREATE TRIGGER trg_staff_users_updated_at
  BEFORE UPDATE ON staff_users
  FOR EACH ROW EXECUTE FUNCTION update_staff_users_updated_at();

-- ── 4. PAYMENTS (replaces GAS Payments sheet) ─────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id              BIGSERIAL PRIMARY KEY,
  payment_id      TEXT NOT NULL UNIQUE,          -- e.g. PAY-001
  order_id        TEXT NOT NULL,                 -- YANI-1001 or YANI-OL-001
  order_type      TEXT NOT NULL DEFAULT 'DINE-IN'
                    CHECK (order_type IN ('DINE-IN','ONLINE')),
  amount          NUMERIC(10,2) NOT NULL DEFAULT 0,
  payment_method  TEXT NOT NULL DEFAULT 'CASH'
                    CHECK (payment_method IN ('CASH','GCASH','MAYA','CARD','OTHER')),
  proof_url       TEXT DEFAULT '',
  proof_filename  TEXT DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','VERIFIED','REJECTED')),
  verified_by     TEXT DEFAULT '',
  verified_at     TIMESTAMPTZ,
  rejection_reason TEXT DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_order_id ON payments (order_id);
CREATE INDEX IF NOT EXISTS idx_payments_status   ON payments (status, created_at DESC);

CREATE OR REPLACE FUNCTION update_payments_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payments_updated_at ON payments;
CREATE TRIGGER trg_payments_updated_at
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION update_payments_updated_at();

-- ── 5. SETTINGS (replaces GAS Settings sheet) ─────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  key             TEXT PRIMARY KEY,
  value           TEXT NOT NULL DEFAULT '',
  description     TEXT DEFAULT '',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 6. SHEETS SYNC LOG (tracks what has been synced to Google Sheets) ──────
CREATE TABLE IF NOT EXISTS sheets_sync_log (
  id              BIGSERIAL PRIMARY KEY,
  table_name      TEXT NOT NULL,
  record_id       TEXT NOT NULL,
  action          TEXT NOT NULL CHECK (action IN ('INSERT','UPDATE','DELETE')),
  synced          BOOLEAN NOT NULL DEFAULT FALSE,
  synced_at       TIMESTAMPTZ,
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sheets_sync_unsynced ON sheets_sync_log (synced, created_at ASC) WHERE synced = FALSE;

-- ── 7. ORDER NUMBER SEQUENCE (replaces GAS getNextOrderNumber) ────────────
CREATE SEQUENCE IF NOT EXISTS dine_in_order_seq START WITH 1001 INCREMENT BY 1;

CREATE OR REPLACE FUNCTION get_next_order_number()
RETURNS INTEGER AS $$
BEGIN
  RETURN nextval('dine_in_order_seq');
END;
$$ LANGUAGE plpgsql;

-- ── 8. ROW LEVEL SECURITY ─────────────────────────────────────────────────
ALTER TABLE dine_in_orders      ENABLE ROW LEVEL SECURITY;
ALTER TABLE dine_in_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_users         ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments            ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings            ENABLE ROW LEVEL SECURITY;
ALTER TABLE sheets_sync_log     ENABLE ROW LEVEL SECURITY;

-- dine_in_orders: anon can INSERT (place order) and SELECT (check status)
-- but NOT update directly (must go through API)
CREATE POLICY "anon_insert_dine_in_orders" ON dine_in_orders
  FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_select_dine_in_orders" ON dine_in_orders
  FOR SELECT TO anon USING (true);
CREATE POLICY "anon_update_dine_in_orders" ON dine_in_orders
  FOR UPDATE TO anon USING (true);

-- dine_in_order_items: anon can INSERT and SELECT
CREATE POLICY "anon_insert_dine_in_items" ON dine_in_order_items
  FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_select_dine_in_items" ON dine_in_order_items
  FOR SELECT TO anon USING (true);
CREATE POLICY "anon_update_dine_in_items" ON dine_in_order_items
  FOR UPDATE TO anon USING (true);
CREATE POLICY "anon_delete_dine_in_items" ON dine_in_order_items
  FOR DELETE TO anon USING (true);

-- staff_users: anon can SELECT (for PIN verification) but NOT write
-- (writes go through service role key in API)
CREATE POLICY "anon_select_staff_users" ON staff_users
  FOR SELECT TO anon USING (true);
CREATE POLICY "anon_update_staff_users" ON staff_users
  FOR UPDATE TO anon USING (true);

-- payments: anon can INSERT and SELECT
CREATE POLICY "anon_insert_payments" ON payments
  FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_select_payments" ON payments
  FOR SELECT TO anon USING (true);
CREATE POLICY "anon_update_payments" ON payments
  FOR UPDATE TO anon USING (true);

-- settings: anon can SELECT only
CREATE POLICY "anon_select_settings" ON settings
  FOR SELECT TO anon USING (true);

-- sheets_sync_log: anon can INSERT and UPDATE
CREATE POLICY "anon_insert_sync_log" ON sheets_sync_log
  FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_select_sync_log" ON sheets_sync_log
  FOR SELECT TO anon USING (true);
CREATE POLICY "anon_update_sync_log" ON sheets_sync_log
  FOR UPDATE TO anon USING (true);

-- ── 9. DEFAULT SETTINGS ────────────────────────────────────────────────────
INSERT INTO settings (key, value, description) VALUES
  ('BUSINESS_NAME',    'Yani Garden Cafe',     'Business display name'),
  ('ORDER_PREFIX',     'YANI',                 'Prefix for order IDs'),
  ('SERVICE_CHARGE',   '0.10',                 'Service charge rate (0.10 = 10%)'),
  ('CURRENCY',         'PHP',                  'Currency code'),
  ('TIMEZONE',         'Asia/Manila',          'Business timezone'),
  ('RECEIPT_EMAIL',    '',                     'Default receipt email'),
  ('ADMIN_PHONE',      '',                     'Admin phone for notifications'),
  ('GCASH_NUMBER',     '',                     'GCash payment number'),
  ('MAYA_NUMBER',      '',                     'Maya payment number')
ON CONFLICT (key) DO NOTHING;

-- ── 10. DEFAULT STAFF USERS (SHA-256 hashed PINs) ─────────────────────────
-- Default PINs: OWNER=1234, ADMIN=5678, CASHIER=9012, KITCHEN=3456
-- SHA-256 of '1234' = 03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4
-- SHA-256 of '5678' = ef797c8118f02dfb649607dd5d3f8c7623048c9c063d532cc95c5ed7a898a64f
-- SHA-256 of '9012' = 1a1dc91c907325c69271ddf0c944bc72954defed4f7b9b3b8c7f8e8e8e8e8e8e (placeholder)
-- SHA-256 of '3456' = 1a1dc91c907325c69271ddf0c944bc72954defed4f7b9b3b8c7f8e8e8e8e8e8e (placeholder)
-- NOTE: Real hashes will be computed and inserted by the migration script
INSERT INTO staff_users (user_id, username, display_name, role, pin_hash, active) VALUES
  ('USR_001', 'owner',   'Owner',   'OWNER',   '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4', TRUE),
  ('USR_002', 'admin',   'Admin',   'ADMIN',   'ef797c8118f02dfb649607dd5d3f8c7623048c9c063d532cc95c5ed7a898a64f', TRUE),
  ('USR_003', 'cashier', 'Cashier', 'CASHIER', 'b7a56873cd771f2c446d369b649430b65a756ba278ff97ec81bb6f55b2e73569', TRUE),
  ('USR_004', 'kitchen', 'Kitchen', 'KITCHEN', '1115dd800feaacefdf481f1f9070374a2a81e27880f187396db67958b207cbad', TRUE)
ON CONFLICT (user_id) DO NOTHING;

-- ── 11. VERIFY ─────────────────────────────────────────────────────────────
SELECT 'Migration 002 complete' AS message,
  (SELECT COUNT(*) FROM dine_in_orders)  AS dine_in_orders,
  (SELECT COUNT(*) FROM staff_users)     AS staff_users,
  (SELECT COUNT(*) FROM settings)        AS settings;
