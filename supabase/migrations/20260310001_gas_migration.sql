-- ══════════════════════════════════════════════════════════════
-- YANI POS — GAS Migration v2
-- Phase out Google Apps Script, Supabase becomes single source of truth
-- ══════════════════════════════════════════════════════════════

-- 1. DINE-IN ORDERS
CREATE TABLE IF NOT EXISTS dine_in_orders (
  id                    BIGSERIAL PRIMARY KEY,
  order_id              TEXT NOT NULL UNIQUE,
  order_no              INTEGER NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  table_no              TEXT NOT NULL DEFAULT '',
  customer_name         TEXT NOT NULL DEFAULT '',
  status                TEXT NOT NULL DEFAULT 'NEW',
  order_type            TEXT NOT NULL DEFAULT 'DINE-IN',
  subtotal              NUMERIC(10,2) NOT NULL DEFAULT 0,
  service_charge        NUMERIC(10,2) NOT NULL DEFAULT 0,
  total                 NUMERIC(10,2) NOT NULL DEFAULT 0,
  payment_method        TEXT DEFAULT '',
  payment_status        TEXT DEFAULT 'PENDING',
  notes                 TEXT DEFAULT '',
  source                TEXT DEFAULT 'QR',
  platform              TEXT DEFAULT '',
  platform_ref          TEXT DEFAULT '',
  commission_rate       NUMERIC(5,4) DEFAULT 0,
  commission_amt        NUMERIC(10,2) DEFAULT 0,
  net_revenue           NUMERIC(10,2) DEFAULT 0,
  receipt_type          TEXT DEFAULT '',
  receipt_delivery      TEXT DEFAULT '',
  receipt_email         TEXT DEFAULT '',
  receipt_name          TEXT DEFAULT '',
  receipt_address       TEXT DEFAULT '',
  receipt_tin           TEXT DEFAULT '',
  payment_proof_url     TEXT DEFAULT '',
  payment_proof_filename TEXT DEFAULT '',
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dine_in_orders_status   ON dine_in_orders (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dine_in_orders_order_id ON dine_in_orders (order_id);
CREATE INDEX IF NOT EXISTS idx_dine_in_orders_created  ON dine_in_orders (created_at DESC);

CREATE OR REPLACE FUNCTION update_dine_in_orders_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_dine_in_orders_updated_at ON dine_in_orders;
CREATE TRIGGER trg_dine_in_orders_updated_at
  BEFORE UPDATE ON dine_in_orders
  FOR EACH ROW EXECUTE FUNCTION update_dine_in_orders_updated_at();

-- 2. DINE-IN ORDER ITEMS
CREATE TABLE IF NOT EXISTS dine_in_order_items (
  id           BIGSERIAL PRIMARY KEY,
  order_id     TEXT NOT NULL REFERENCES dine_in_orders(order_id) ON DELETE CASCADE,
  order_no     INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  table_no     TEXT DEFAULT '',
  item_code    TEXT NOT NULL,
  item_name    TEXT NOT NULL,
  unit_price   NUMERIC(10,2) NOT NULL DEFAULT 0,
  qty          INTEGER NOT NULL DEFAULT 1,
  size_choice  TEXT DEFAULT '',
  sugar_choice TEXT DEFAULT '',
  item_notes   TEXT DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_dine_in_items_order_id ON dine_in_order_items (order_id);

-- 3. STAFF USERS
CREATE TABLE IF NOT EXISTS staff_users (
  id              BIGSERIAL PRIMARY KEY,
  user_id         TEXT NOT NULL UNIQUE,
  username        TEXT NOT NULL UNIQUE,
  display_name    TEXT NOT NULL DEFAULT '',
  role            TEXT NOT NULL DEFAULT 'KITCHEN',
  pin_hash        TEXT NOT NULL,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  last_login      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_staff_users_pin_hash ON staff_users (pin_hash);

CREATE OR REPLACE FUNCTION update_staff_users_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_staff_users_updated_at ON staff_users;
CREATE TRIGGER trg_staff_users_updated_at
  BEFORE UPDATE ON staff_users
  FOR EACH ROW EXECUTE FUNCTION update_staff_users_updated_at();

-- 4. PAYMENTS
CREATE TABLE IF NOT EXISTS payments (
  id               BIGSERIAL PRIMARY KEY,
  payment_id       TEXT NOT NULL UNIQUE,
  order_id         TEXT NOT NULL,
  order_type       TEXT NOT NULL DEFAULT 'DINE-IN',
  amount           NUMERIC(10,2) NOT NULL DEFAULT 0,
  payment_method   TEXT NOT NULL DEFAULT 'CASH',
  proof_url        TEXT DEFAULT '',
  proof_filename   TEXT DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'PENDING',
  verified_by      TEXT DEFAULT '',
  verified_at      TIMESTAMPTZ,
  rejection_reason TEXT DEFAULT '',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_order_id ON payments (order_id);
CREATE INDEX IF NOT EXISTS idx_payments_status   ON payments (status, created_at DESC);

CREATE OR REPLACE FUNCTION update_payments_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payments_updated_at ON payments;
CREATE TRIGGER trg_payments_updated_at
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION update_payments_updated_at();

-- 5. SETTINGS
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL DEFAULT '',
  description TEXT DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. SHEETS SYNC LOG
CREATE TABLE IF NOT EXISTS sheets_sync_log (
  id            BIGSERIAL PRIMARY KEY,
  table_name    TEXT NOT NULL,
  record_id     TEXT NOT NULL,
  action        TEXT NOT NULL,
  synced        BOOLEAN NOT NULL DEFAULT FALSE,
  synced_at     TIMESTAMPTZ,
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sheets_sync_unsynced ON sheets_sync_log (synced, created_at ASC) WHERE synced = FALSE;

-- 7. ORDER NUMBER SEQUENCE
CREATE SEQUENCE IF NOT EXISTS dine_in_order_seq START WITH 1001 INCREMENT BY 1;

CREATE OR REPLACE FUNCTION get_next_order_number()
RETURNS INTEGER AS $$ BEGIN RETURN nextval('dine_in_order_seq'); END; $$ LANGUAGE plpgsql;

-- 8. ROW LEVEL SECURITY
ALTER TABLE dine_in_orders      ENABLE ROW LEVEL SECURITY;
ALTER TABLE dine_in_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_users         ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments            ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings            ENABLE ROW LEVEL SECURITY;
ALTER TABLE sheets_sync_log     ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN CREATE POLICY "anon_insert_dine_in_orders" ON dine_in_orders FOR INSERT TO anon WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "anon_select_dine_in_orders" ON dine_in_orders FOR SELECT TO anon USING (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "anon_update_dine_in_orders" ON dine_in_orders FOR UPDATE TO anon USING (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "anon_delete_dine_in_orders" ON dine_in_orders FOR DELETE TO anon USING (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE POLICY "anon_insert_dine_in_items" ON dine_in_order_items FOR INSERT TO anon WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "anon_select_dine_in_items" ON dine_in_order_items FOR SELECT TO anon USING (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "anon_update_dine_in_items" ON dine_in_order_items FOR UPDATE TO anon USING (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "anon_delete_dine_in_items" ON dine_in_order_items FOR DELETE TO anon USING (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE POLICY "anon_select_staff_users" ON staff_users FOR SELECT TO anon USING (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "anon_update_staff_users" ON staff_users FOR UPDATE TO anon USING (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE POLICY "anon_insert_payments" ON payments FOR INSERT TO anon WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "anon_select_payments" ON payments FOR SELECT TO anon USING (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "anon_update_payments" ON payments FOR UPDATE TO anon USING (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE POLICY "anon_select_settings" ON settings FOR SELECT TO anon USING (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "anon_update_settings" ON settings FOR UPDATE TO anon USING (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE POLICY "anon_insert_sync_log" ON sheets_sync_log FOR INSERT TO anon WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "anon_select_sync_log" ON sheets_sync_log FOR SELECT TO anon USING (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "anon_update_sync_log" ON sheets_sync_log FOR UPDATE TO anon USING (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 9. DEFAULT SETTINGS
INSERT INTO settings (key, value, description) VALUES
  ('BUSINESS_NAME',  'Yani Garden Cafe', 'Business display name'),
  ('ORDER_PREFIX',   'YANI',             'Prefix for order IDs'),
  ('SERVICE_CHARGE', '0.10',             'Service charge rate (0.10 = 10%)'),
  ('CURRENCY',       'PHP',              'Currency code'),
  ('TIMEZONE',       'Asia/Manila',      'Business timezone'),
  ('RECEIPT_EMAIL',  '',                 'Default receipt email'),
  ('ADMIN_PHONE',    '',                 'Admin phone for notifications'),
  ('GCASH_NUMBER',   '',                 'GCash payment number'),
  ('MAYA_NUMBER',    '',                 'Maya payment number')
ON CONFLICT (key) DO NOTHING;

-- 10. DEFAULT STAFF USERS (SHA-256 hashed PINs)
-- PIN 1234 (Owner)   → 03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4
-- PIN 5678 (Admin)   → f8638b979b2f4f793ddb6dbd197e0ee25a7a6ea32b0ae22f5e3c5d119d839e75
-- PIN 9012 (Cashier) → 8cce10345c5e1de90d277b9869465f5972b828afbbbfd7ef08b1d835eedee993
-- PIN 3456 (Kitchen) → ceaa28bba4caba687dc31b1bbe79eca3c70c33f871f1ce8f528cf9ab5cfd76dd
INSERT INTO staff_users (user_id, username, display_name, role, pin_hash, active) VALUES
  ('USR_001', 'owner',   'Owner',   'OWNER',   '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4', TRUE),
  ('USR_002', 'admin',   'Admin',   'ADMIN',   'f8638b979b2f4f793ddb6dbd197e0ee25a7a6ea32b0ae22f5e3c5d119d839e75', TRUE),
  ('USR_003', 'cashier', 'Cashier', 'CASHIER', '8cce10345c5e1de90d277b9869465f5972b828afbbbfd7ef08b1d835eedee993', TRUE),
  ('USR_004', 'kitchen', 'Kitchen', 'KITCHEN', 'ceaa28bba4caba687dc31b1bbe79eca3c70c33f871f1ce8f528cf9ab5cfd76dd', TRUE)
ON CONFLICT (user_id) DO NOTHING;

-- 11. VERIFY
SELECT 'Migration 002 complete' AS message,
  (SELECT COUNT(*) FROM dine_in_orders)  AS dine_in_orders,
  (SELECT COUNT(*) FROM staff_users)     AS staff_users,
  (SELECT COUNT(*) FROM settings)        AS settings;
