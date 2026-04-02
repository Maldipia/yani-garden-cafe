-- ============================================================
-- TYG POS — New Tenant Migration Script
-- Run this on a fresh Supabase project to set up everything.
-- After running, fill in the settings table with tenant values.
-- ============================================================

-- ── ENUMS ─────────────────────────────────────────────────────
CREATE TYPE IF NOT EXISTS payment_status AS ENUM ('PENDING','SUBMITTED','VERIFIED','REJECTED');
CREATE TYPE IF NOT EXISTS online_order_status AS ENUM ('PENDING','CONFIRMED','PREPARING','READY','COMPLETED','CANCELLED');
CREATE TYPE IF NOT EXISTS online_payment_status AS ENUM ('PENDING','SUBMITTED','VERIFIED','REJECTED');

-- ── SEQUENCES ─────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS dine_in_order_seq START 1001;
CREATE SEQUENCE IF NOT EXISTS online_order_seq  START 1;
CREATE SEQUENCE IF NOT EXISTS reservation_seq   START 1;

-- ── SETTINGS ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL DEFAULT '',
  description TEXT          DEFAULT '',
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- ── STAFF USERS ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS staff_users (
  id              BIGSERIAL PRIMARY KEY,
  user_id         TEXT UNIQUE NOT NULL,
  username        TEXT UNIQUE NOT NULL,
  display_name    TEXT        NOT NULL DEFAULT '',
  role            TEXT        NOT NULL DEFAULT 'KITCHEN'
                    CHECK (role IN ('OWNER','ADMIN','CASHIER','KITCHEN')),
  pin_hash        TEXT        NOT NULL,
  active          BOOLEAN     NOT NULL DEFAULT true,
  failed_attempts INTEGER     NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  last_login      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── MENU ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS menu_categories (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT UNIQUE NOT NULL,
  display_order SMALLINT    NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS menu_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_code        TEXT UNIQUE NOT NULL,
  name             TEXT        NOT NULL,
  description      TEXT,
  category_id      UUID REFERENCES menu_categories(id),
  base_price       NUMERIC     NOT NULL,
  image_path       TEXT,
  is_active        BOOLEAN     NOT NULL DEFAULT true,
  has_sizes        BOOLEAN     NOT NULL DEFAULT false,
  price_short      NUMERIC,
  price_medium     NUMERIC,
  price_tall       NUMERIC,
  has_sugar_levels BOOLEAN     NOT NULL DEFAULT false,
  is_signature     BOOLEAN     NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS menu_addons (
  id               BIGSERIAL PRIMARY KEY,
  addon_code       TEXT UNIQUE NOT NULL,
  name             TEXT        NOT NULL,
  price            NUMERIC              DEFAULT 0,
  applies_to_all   BOOLEAN              DEFAULT true,
  applies_to_codes TEXT[]               DEFAULT '{}',
  is_active        BOOLEAN              DEFAULT true,
  sort_order       SMALLINT             DEFAULT 0,
  created_at       TIMESTAMPTZ          DEFAULT now(),
  updated_at       TIMESTAMPTZ          DEFAULT now()
);

-- ── TABLES & RESERVATIONS ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS cafe_tables (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_number SMALLINT UNIQUE NOT NULL,
  qr_token     TEXT UNIQUE     NOT NULL,
  table_name   TEXT,
  capacity     INTEGER         DEFAULT 4,
  status       TEXT            DEFAULT 'AVAILABLE'
                 CHECK (status IN ('AVAILABLE','OCCUPIED','RESERVED','MAINTENANCE'))
);

CREATE TABLE IF NOT EXISTS reservations (
  id           BIGSERIAL PRIMARY KEY,
  res_id       TEXT UNIQUE NOT NULL,
  table_no     INTEGER CHECK (table_no >= 1 AND table_no <= 100),
  table_id     UUID REFERENCES cafe_tables(id),
  guest_name   TEXT NOT NULL,
  guest_phone  TEXT,
  guest_email  TEXT,
  pax          INTEGER NOT NULL DEFAULT 1 CHECK (pax >= 1 AND pax <= 50),
  res_date     DATE NOT NULL,
  res_time     TIME NOT NULL,
  occasion     TEXT,
  seating_pref TEXT,
  dietary      TEXT,
  notes        TEXT,
  status       TEXT NOT NULL DEFAULT 'CONFIRMED'
                 CHECK (status IN ('CONFIRMED','SEATED','COMPLETED','CANCELLED','NO_SHOW')),
  source       TEXT DEFAULT 'ONLINE',
  confirmed_by TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── DINE-IN ORDERS ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dine_in_orders (
  id                     BIGSERIAL PRIMARY KEY,
  order_id               TEXT UNIQUE NOT NULL,
  order_no               INTEGER     NOT NULL,
  table_no               TEXT        NOT NULL DEFAULT '',
  customer_name          TEXT        NOT NULL DEFAULT '',
  status                 TEXT        NOT NULL DEFAULT 'NEW'
                           CHECK (status IN ('NEW','PREPARING','READY','COMPLETED','CANCELLED')),
  order_type             TEXT        NOT NULL DEFAULT 'DINE-IN'
                           CHECK (order_type IN ('DINE-IN','TAKE-OUT','PLATFORM')),
  subtotal               NUMERIC     NOT NULL DEFAULT 0,
  service_charge         NUMERIC     NOT NULL DEFAULT 0,
  vat_amount             NUMERIC              DEFAULT 0,
  total                  NUMERIC     NOT NULL DEFAULT 0,
  payment_method         TEXT                 DEFAULT '',
  payment_status         TEXT                 DEFAULT 'PENDING'
                           CHECK (payment_status IN ('PENDING','SUBMITTED','VERIFIED','REJECTED','')),
  notes                  TEXT                 DEFAULT '',
  source                 TEXT                 DEFAULT 'QR'
                           CHECK (source IN ('QR','POS','PLATFORM')),
  platform               TEXT                 DEFAULT '',
  platform_ref           TEXT                 DEFAULT '',
  commission_rate        NUMERIC              DEFAULT 0,
  commission_amt         NUMERIC              DEFAULT 0,
  net_revenue            NUMERIC              DEFAULT 0,
  receipt_type           TEXT                 DEFAULT '',
  receipt_delivery       TEXT                 DEFAULT '',
  receipt_email          TEXT                 DEFAULT '',
  receipt_name           TEXT                 DEFAULT '',
  receipt_address        TEXT                 DEFAULT '',
  receipt_tin            TEXT                 DEFAULT '',
  payment_proof_url      TEXT                 DEFAULT '',
  payment_proof_filename TEXT                 DEFAULT '',
  discount_type          VARCHAR,
  discount_pax           INTEGER              DEFAULT 0,
  discount_pct           NUMERIC              DEFAULT 0,
  discount_amount        NUMERIC              DEFAULT 0,
  discounted_total       NUMERIC,
  discount_note          TEXT,
  payment_notes          TEXT,
  or_number              INTEGER,
  is_test                BOOLEAN              DEFAULT false,
  cancel_reason          TEXT,
  is_deleted             BOOLEAN              DEFAULT false,
  deleted_at             TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dine_in_order_items (
  id         BIGSERIAL PRIMARY KEY,
  order_id   TEXT NOT NULL REFERENCES dine_in_orders(order_id),
  order_no   INTEGER      DEFAULT 0,
  table_no   TEXT         DEFAULT '',
  item_code  TEXT         NOT NULL,
  item_name  TEXT         NOT NULL,
  unit_price NUMERIC      NOT NULL DEFAULT 0,
  qty        INTEGER      NOT NULL DEFAULT 1,
  line_total NUMERIC GENERATED ALWAYS AS (unit_price * qty) STORED,
  size_choice  TEXT       DEFAULT '',
  sugar_choice TEXT       DEFAULT '',
  item_notes   TEXT       DEFAULT '',
  notes        TEXT       DEFAULT '',
  prepared     BOOLEAN    DEFAULT false,
  addons       JSONB      DEFAULT '[]',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── PAYMENTS ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id       TEXT UNIQUE,
  order_id         TEXT        NOT NULL,
  order_type       TEXT                 DEFAULT 'DINE-IN',
  amount           NUMERIC     NOT NULL,
  method           TEXT        NOT NULL,
  payment_method   TEXT,
  status           payment_status NOT NULL DEFAULT 'SUBMITTED',
  proof_url        TEXT,
  proof_file_url   TEXT,
  proof_filename   TEXT,
  verified_by      TEXT,
  verified_at      TIMESTAMPTZ,
  rejection_reason TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ          DEFAULT now()
);

-- ── ONLINE ORDERS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS online_orders (
  id                   BIGSERIAL PRIMARY KEY,
  order_ref            TEXT UNIQUE NOT NULL,
  customer_name        TEXT        NOT NULL,
  customer_phone       TEXT        NOT NULL,
  customer_email       TEXT,
  delivery_address     TEXT,
  delivery_notes       TEXT,
  courier_type         TEXT                 DEFAULT 'LALAMOVE',
  delivery_fee         NUMERIC              DEFAULT 0,
  delivery_zone        TEXT,
  subtotal             NUMERIC     NOT NULL DEFAULT 0,
  total_amount         NUMERIC,
  status               online_order_status  NOT NULL DEFAULT 'PENDING',
  payment_status       online_payment_status NOT NULL DEFAULT 'PENDING',
  payment_method       VARCHAR              DEFAULT 'gcash',
  payment_proof_url    TEXT,
  special_instructions TEXT,
  pickup_time          TIMESTAMPTZ,
  sms_sent             BOOLEAN              DEFAULT false,
  admin_notes          TEXT,
  created_at           TIMESTAMPTZ          DEFAULT now(),
  updated_at           TIMESTAMPTZ          DEFAULT now()
);

CREATE TABLE IF NOT EXISTS online_order_items (
  id           BIGSERIAL PRIMARY KEY,
  order_id     BIGINT NOT NULL REFERENCES online_orders(id),
  order_ref    VARCHAR,
  menu_item_id TEXT,
  item_name    TEXT    NOT NULL,
  size         TEXT            DEFAULT 'REGULAR',
  unit_price   NUMERIC NOT NULL,
  quantity     INTEGER NOT NULL DEFAULT 1,
  subtotal     NUMERIC GENERATED ALWAYS AS (unit_price * quantity) STORED,
  addons       JSONB,
  created_at   TIMESTAMPTZ     DEFAULT now()
);

CREATE TABLE IF NOT EXISTS online_payments (
  id               BIGSERIAL PRIMARY KEY,
  order_id         BIGINT NOT NULL REFERENCES online_orders(id),
  order_ref        TEXT   NOT NULL,
  amount           NUMERIC NOT NULL,
  payment_method   TEXT    NOT NULL DEFAULT 'GCASH',
  proof_url        TEXT,
  proof_filename   TEXT,
  status           online_payment_status NOT NULL DEFAULT 'PENDING',
  verified_by      TEXT,
  verified_at      TIMESTAMPTZ,
  rejection_reason TEXT,
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now()
);

-- ── INVENTORY ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventory (
  id                BIGSERIAL PRIMARY KEY,
  item_code         TEXT UNIQUE NOT NULL,
  stock_qty         NUMERIC              DEFAULT 0,
  low_stock_threshold NUMERIC            DEFAULT 10,
  unit              TEXT                 DEFAULT 'pcs',
  cost_per_unit     NUMERIC              DEFAULT 0,
  selling_price     NUMERIC              DEFAULT 0,
  size_per_unit     TEXT                 DEFAULT '',
  auto_disable      BOOLEAN              DEFAULT false,
  last_restocked_at TIMESTAMPTZ,
  restock_notes     TEXT,
  photo_url         TEXT,
  created_at        TIMESTAMPTZ          DEFAULT now(),
  updated_at        TIMESTAMPTZ          DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory_log (
  id          BIGSERIAL PRIMARY KEY,
  item_code   TEXT    NOT NULL,
  change_type TEXT    NOT NULL
                CHECK (change_type IN ('RESTOCK','SALE','ADJUSTMENT','WASTE','RETURN')),
  qty_before  NUMERIC,
  qty_change  NUMERIC NOT NULL,
  qty_after   NUMERIC,
  order_id    TEXT,
  reference   TEXT    DEFAULT '',
  unit_price  NUMERIC DEFAULT 0,
  notes       TEXT,
  actor_id    TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- ── CASH SESSIONS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cash_sessions (
  id                     BIGSERIAL PRIMARY KEY,
  session_id             TEXT UNIQUE NOT NULL,
  shift                  TEXT        DEFAULT 'AM'
                           CHECK (shift IN ('AM','PM','FULL','CUSTOM')),
  opened_by              TEXT,
  closed_by              TEXT,
  opening_float          NUMERIC     DEFAULT 0,
  closing_count          NUMERIC,
  expected_cash          NUMERIC,
  variance               NUMERIC,
  cash_sales             NUMERIC     DEFAULT 0,
  total_sales            NUMERIC     DEFAULT 0,
  denomination_breakdown JSONB       DEFAULT '{}',
  notes                  TEXT,
  status                 TEXT        DEFAULT 'OPEN'
                           CHECK (status IN ('OPEN','CLOSED')),
  opened_at              TIMESTAMPTZ DEFAULT now(),
  closed_at              TIMESTAMPTZ,
  created_at             TIMESTAMPTZ DEFAULT now()
);

-- ── REFUNDS ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS refunds (
  id              BIGSERIAL PRIMARY KEY,
  refund_id       TEXT UNIQUE NOT NULL,
  order_id        TEXT        NOT NULL,
  refund_type     TEXT        NOT NULL
                    CHECK (refund_type IN ('FULL','PARTIAL','VOID')),
  refund_amount   NUMERIC     NOT NULL DEFAULT 0,
  reason_code     TEXT        NOT NULL
                    CHECK (reason_code IN ('WRONG_ORDER','DUPLICATE','COMPLAINT','OVERCHARGE','ITEM_UNAVAILABLE','OTHER')),
  reason_note     TEXT,
  refund_method   TEXT,
  items_refunded  JSONB       DEFAULT '[]',
  processed_by    TEXT,
  status          TEXT        DEFAULT 'PROCESSED'
                    CHECK (status IN ('PENDING','PROCESSED','REJECTED')),
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- ── AUDIT & RATE LIMITING ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS order_audit_logs (
  id         BIGSERIAL PRIMARY KEY,
  order_id   TEXT,
  action     TEXT NOT NULL,
  actor_id   TEXT,
  actor_name TEXT,
  old_value  TEXT,
  new_value  TEXT,
  details    JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_rate_limits (
  key          TEXT PRIMARY KEY,
  count        INTEGER NOT NULL DEFAULT 1,
  window_start BIGINT  NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_queue (
  id           BIGSERIAL PRIMARY KEY,
  order_ref    TEXT        NOT NULL,
  order_type   TEXT        NOT NULL DEFAULT 'ONLINE',
  order_data   JSONB       NOT NULL,
  status       TEXT        NOT NULL DEFAULT 'PENDING'
                 CHECK (status IN ('PENDING','PROCESSING','COMPLETED','FAILED','DEAD')),
  retry_count  INTEGER     NOT NULL DEFAULT 0,
  max_retries  INTEGER     NOT NULL DEFAULT 3,
  next_retry_at TIMESTAMPTZ,
  processed_at  TIMESTAMPTZ,
  error_message TEXT,
  worker_id     TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── FUNCTIONS ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_next_order_number()
RETURNS BIGINT LANGUAGE plpgsql AS $$
BEGIN RETURN nextval('dine_in_order_seq'); END;
$$;

CREATE OR REPLACE FUNCTION get_next_online_order_ref()
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE next_val BIGINT;
BEGIN
  next_val := nextval('online_order_seq');
  RETURN 'OL-' || LPAD(next_val::TEXT, 3, '0');
END;
$$;

CREATE OR REPLACE FUNCTION get_next_res_id()
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE v_next BIGINT;
BEGIN
  v_next := nextval('reservation_seq');
  RETURN 'RES-' || LPAD(v_next::TEXT, 3, '0');
END;
$$;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

CREATE OR REPLACE FUNCTION upsert_rate_limit(p_key TEXT, p_window INTEGER, p_limit INTEGER)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE
  v_now   BIGINT := EXTRACT(EPOCH FROM NOW())::BIGINT;
  v_count INTEGER;
BEGIN
  INSERT INTO api_rate_limits (key, count, window_start, updated_at)
    VALUES (p_key, 1, v_now, NOW())
  ON CONFLICT (key) DO UPDATE SET
    count = CASE WHEN v_now - api_rate_limits.window_start > p_window
                 THEN 1 ELSE api_rate_limits.count + 1 END,
    window_start = CASE WHEN v_now - api_rate_limits.window_start > p_window
                        THEN v_now ELSE api_rate_limits.window_start END,
    updated_at = NOW()
  RETURNING count INTO v_count;
  RETURN v_count <= p_limit;
END;
$$;

-- ── TRIGGERS ──────────────────────────────────────────────────
CREATE TRIGGER trg_staff_users_updated_at
  BEFORE UPDATE ON staff_users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_dine_in_orders_updated_at
  BEFORE UPDATE ON dine_in_orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_payments_updated_at
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_online_orders_updated_at
  BEFORE UPDATE ON online_orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_online_payments_updated_at
  BEFORE UPDATE ON online_payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_inventory_updated_at
  BEFORE UPDATE ON inventory
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_reservations_updated_at
  BEFORE UPDATE ON reservations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── RLS POLICIES ──────────────────────────────────────────────
-- All tables: service role has full access (your API uses service key)
-- Public anon can read menu, place orders, upload proofs

ALTER TABLE settings           ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_users        ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_categories    ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_items         ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_addons        ENABLE ROW LEVEL SECURITY;
ALTER TABLE cafe_tables        ENABLE ROW LEVEL SECURITY;
ALTER TABLE dine_in_orders     ENABLE ROW LEVEL SECURITY;
ALTER TABLE dine_in_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments           ENABLE ROW LEVEL SECURITY;
ALTER TABLE online_orders      ENABLE ROW LEVEL SECURITY;
ALTER TABLE online_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE online_payments    ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory          ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_log      ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_sessions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE refunds            ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS automatically in Supabase
-- Anon role: read-only on menu; insert on orders/payments
CREATE POLICY "anon_read_menu_categories" ON menu_categories FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read_menu_items"      ON menu_items      FOR SELECT TO anon USING (is_active = true);
CREATE POLICY "anon_read_menu_addons"     ON menu_addons     FOR SELECT TO anon USING (is_active = true);
CREATE POLICY "anon_read_cafe_tables"     ON cafe_tables     FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read_settings"        ON settings        FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_orders"        ON dine_in_orders  FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_read_own_order"       ON dine_in_orders  FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_order_items"   ON dine_in_order_items FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_read_order_items"     ON dine_in_order_items FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_payments"      ON payments        FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_read_payments"        ON payments        FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_online_orders" ON online_orders   FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_read_online_orders"   ON online_orders   FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_ol_items"      ON online_order_items FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_insert_ol_payments"   ON online_payments FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_read_ol_payments"     ON online_payments FOR SELECT TO anon USING (true);

-- ── STORAGE BUCKETS ───────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public) VALUES
  ('menu-images',    'menu-images',    true),
  ('payment-proofs', 'payment-proofs', true),
  ('inventory',      'inventory',      true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "public_read_menu_images"    ON storage.objects FOR SELECT TO anon USING (bucket_id = 'menu-images');
CREATE POLICY "public_read_payment_proofs" ON storage.objects FOR SELECT TO anon USING (bucket_id = 'payment-proofs');
CREATE POLICY "anon_upload_payment_proofs" ON storage.objects FOR INSERT TO anon WITH CHECK (bucket_id = 'payment-proofs');
CREATE POLICY "service_all_storage"        ON storage.objects FOR ALL TO service_role USING (true);

-- ── GRANTS ────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON api_rate_limits TO anon, authenticated;
GRANT USAGE ON SEQUENCE dine_in_order_seq  TO anon, authenticated;
GRANT USAGE ON SEQUENCE online_order_seq   TO anon, authenticated;
GRANT USAGE ON SEQUENCE reservation_seq    TO anon, authenticated;
GRANT EXECUTE ON FUNCTION get_next_order_number()       TO anon, authenticated;
GRANT EXECUTE ON FUNCTION get_next_online_order_ref()   TO anon, authenticated;
GRANT EXECUTE ON FUNCTION get_next_res_id()             TO anon, authenticated;
GRANT EXECUTE ON FUNCTION upsert_rate_limit(TEXT,INTEGER,INTEGER) TO anon, authenticated;

-- ── DEFAULT SETTINGS (tenant fills these in) ──────────────────
INSERT INTO settings (key, value, description) VALUES
  ('BUSINESS_NAME',    'My Cafe',        'Display name shown everywhere'),
  ('ORDER_PREFIX',     'ORD',            'Order ID prefix e.g. ORD, CAFE, etc.'),
  ('SERVICE_CHARGE',   '0.10',           'Service charge rate (0.10 = 10%)'),
  ('VAT_ENABLED',      'false',          'Enable VAT on orders'),
  ('VAT_RATE',         '0.12',           '12% VAT rate'),
  ('CURRENCY',         'PHP',            'Currency code'),
  ('TIMEZONE',         'Asia/Manila',    'Timezone for reports'),
  ('PRIMARY_COLOR',    '#2D5016',        'Brand primary color (hex)'),
  ('SECONDARY_COLOR',  '#78350F',        'Brand secondary color (hex)'),
  ('LOGO_URL',         '/images/logo.png','Logo image URL'),
  ('TAGLINE',          '',               'Short tagline shown on menu'),
  ('ADDRESS',          '',               'Business address'),
  ('ACCOUNT_NAME',     '',               'GCash / bank account name'),
  ('GCASH_NUMBER',     '',               'GCash mobile number'),
  ('GCASH_QR_URL',     '',               'GCash QR code image URL'),
  ('INSTAPAY_QR_URL',  '',               'InstaPay QR code image URL'),
  ('BDO_ACCOUNT',      '',               'BDO account number'),
  ('BDO_QR_URL',       '',               'BDO QR code image URL'),
  ('BPI_ACCOUNT',      '',               'BPI account number'),
  ('BPI_QR_URL',       '',               'BPI QR code image URL'),
  ('UNIONBANK_ACCOUNT','',               'UnionBank account number'),
  ('UNIONBANK_QR_URL', '',               'UnionBank QR code image URL'),
  ('MAYA_NUMBER',      '',               'Maya mobile number'),
  ('ADMIN_PHONE',      '',               'Admin contact number'),
  ('RECEIPT_EMAIL',    '',               'Email for daily reports'),
  ('SESSION_KEY',      'pos_session_token','localStorage key for session'),
  ('OR_NUMBER_START',  '1001',           'First OR number for BIR receipts'),
  ('OR_NUMBER_CURRENT','1001',           'Current OR number counter')
ON CONFLICT (key) DO NOTHING;

-- ── DEFAULT TABLES (10 tables with tokens) ────────────────────
INSERT INTO cafe_tables (table_number, qr_token, table_name, capacity) VALUES
  (1,  md5(random()::text || '1')::text,  'Table 1',  4),
  (2,  md5(random()::text || '2')::text,  'Table 2',  4),
  (3,  md5(random()::text || '3')::text,  'Table 3',  4),
  (4,  md5(random()::text || '4')::text,  'Table 4',  4),
  (5,  md5(random()::text || '5')::text,  'Table 5',  4),
  (6,  md5(random()::text || '6')::text,  'Table 6',  4),
  (7,  md5(random()::text || '7')::text,  'Table 7',  4),
  (8,  md5(random()::text || '8')::text,  'Table 8',  4),
  (9,  md5(random()::text || '9')::text,  'Table 9',  4),
  (10, md5(random()::text || '10')::text, 'Table 10', 6)
ON CONFLICT (table_number) DO NOTHING;

-- ── INDEXES (performance) ─────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_dine_in_orders_status     ON dine_in_orders (status);
CREATE INDEX IF NOT EXISTS idx_dine_in_orders_created_at ON dine_in_orders (created_at);
CREATE INDEX IF NOT EXISTS idx_dine_in_order_items_order ON dine_in_order_items (order_id);
CREATE INDEX IF NOT EXISTS idx_payments_order_id         ON payments (order_id);
CREATE INDEX IF NOT EXISTS idx_online_orders_status      ON online_orders (status);
CREATE INDEX IF NOT EXISTS idx_inventory_item_code       ON inventory (item_code);
CREATE INDEX IF NOT EXISTS idx_audit_logs_order_id       ON order_audit_logs (order_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at     ON order_audit_logs (created_at);

-- ============================================================
-- DONE. Next steps:
-- 1. Create a staff user (OWNER) via the API's changePin flow
--    or insert directly:
--    INSERT INTO staff_users (user_id, username, display_name, role, pin_hash)
--    VALUES ('USR_001', 'owner', 'Owner', 'OWNER', crypt('YOUR_PIN', gen_salt('bf')));
-- 2. Set Vercel env vars: SUPABASE_URL, SUPABASE_SECRET_KEY, JWT_SECRET
-- 3. Fill in settings table with tenant's real values
-- 4. Upload menu items via Admin → Menu
-- 5. Point domain to Vercel project
-- ============================================================
