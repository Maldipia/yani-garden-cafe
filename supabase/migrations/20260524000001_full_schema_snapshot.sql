-- =============================================================================
-- FULL SCHEMA SNAPSHOT — YANI Garden Cafe POS
-- Generated: 2026-05-24
-- This file documents the complete DB state as of this date.
-- All prior migrations exist as stubs above; this is the authoritative reference.
-- DO NOT apply this to a DB that already has the tables — it will fail.
-- Use this to spin up a fresh DB or as a reference when building TYG POS SaaS.
-- =============================================================================

-- ─── CORE TABLES ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS menu_categories (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  display_order smallint NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS menu_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_code       text NOT NULL UNIQUE,
  name            text NOT NULL,
  description     text,
  category_id     uuid REFERENCES menu_categories(id),
  base_price      numeric NOT NULL,
  image_path      text,
  is_active       boolean NOT NULL DEFAULT true,
  has_sizes       boolean NOT NULL DEFAULT false,
  price_short     numeric,
  price_medium    numeric,
  price_tall      numeric,
  has_sugar_levels boolean NOT NULL DEFAULT false,
  is_signature    boolean NOT NULL DEFAULT false,
  available_from  time,
  available_until time,
  available_days  text[],
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS menu_addons (
  id              bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  addon_code      text NOT NULL UNIQUE,
  name            text NOT NULL,
  price           numeric DEFAULT 0,
  applies_to_all  boolean DEFAULT true,
  applies_to_codes text[] DEFAULT '{}',
  is_active       boolean DEFAULT true,
  sort_order      smallint DEFAULT 0,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cafe_tables (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_number smallint NOT NULL UNIQUE,
  qr_token     text NOT NULL,
  table_name   text,
  capacity     integer DEFAULT 4,
  status       text DEFAULT 'AVAILABLE'
);

CREATE TABLE IF NOT EXISTS staff_users (
  id              bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id         text NOT NULL UNIQUE,
  username        text NOT NULL,
  display_name    text NOT NULL DEFAULT '',
  role            text NOT NULL DEFAULT 'KITCHEN',
  pin_hash        text NOT NULL,
  active          boolean NOT NULL DEFAULT true,
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  last_login      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  key         text PRIMARY KEY,
  value       text NOT NULL DEFAULT '',
  description text DEFAULT '',
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ─── ORDERS ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS dine_in_orders (
  id                   bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  order_id             text NOT NULL UNIQUE,
  order_no             integer NOT NULL,
  table_no             text NOT NULL DEFAULT '',
  customer_name        text NOT NULL DEFAULT '',
  status               text NOT NULL DEFAULT 'NEW',
  order_type           text NOT NULL DEFAULT 'DINE-IN',
  subtotal             numeric NOT NULL DEFAULT 0,
  service_charge       numeric NOT NULL DEFAULT 0,
  total                numeric NOT NULL DEFAULT 0,
  payment_method       text DEFAULT '',
  payment_status       text DEFAULT 'PENDING',
  notes                text DEFAULT '',
  source               text DEFAULT 'QR',
  platform             text DEFAULT '',
  platform_ref         text DEFAULT '',
  commission_rate      numeric DEFAULT 0,
  commission_amt       numeric DEFAULT 0,
  net_revenue          numeric DEFAULT 0,
  receipt_type         text DEFAULT '',
  receipt_delivery     text DEFAULT '',
  receipt_email        text DEFAULT '',
  receipt_name         text DEFAULT '',
  receipt_address      text DEFAULT '',
  receipt_tin          text DEFAULT '',
  payment_proof_url    text DEFAULT '',
  payment_proof_filename text DEFAULT '',
  is_test              boolean DEFAULT false,
  cancel_reason        text,
  is_deleted           boolean DEFAULT false,
  deleted_at           timestamptz,
  vat_amount           numeric DEFAULT 0,
  discount_type        varchar,
  discount_pax         integer DEFAULT 0,
  discount_pct         numeric DEFAULT 0,
  discount_amount      numeric DEFAULT 0,
  discounted_total     numeric,
  discount_note        text,
  payment_notes        text,
  or_number            integer,
  customer_id          uuid,
  split_data           jsonb,
  loyalty_account_id   uuid,
  points_earned        integer DEFAULT 0,
  points_redeemed      integer DEFAULT 0,
  points_discount      numeric DEFAULT 0,
  is_preorder          boolean NOT NULL DEFAULT false,
  scheduled_for        timestamptz,
  preorder_token       text,
  items_json           text,
  paymongo_link_id     text,
  payment_amount       numeric,
  paid_at              timestamptz,
  customer_phone       text,
  customer_email       text,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dine_in_order_items (
  id          bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  order_id    text NOT NULL,
  order_no    integer NOT NULL DEFAULT 0,
  table_no    text DEFAULT '',
  item_code   text NOT NULL,
  item_name   text NOT NULL,
  unit_price  numeric NOT NULL DEFAULT 0,
  qty         integer NOT NULL DEFAULT 1,
  line_total  numeric,
  size_choice  text DEFAULT '',
  sugar_choice text DEFAULT '',
  item_notes  text DEFAULT '',
  notes       text DEFAULT '',
  prepared    boolean DEFAULT false,
  addons      jsonb DEFAULT '[]',
  prepared_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         text NOT NULL,
  amount           numeric NOT NULL,
  method           text NOT NULL,
  status           text NOT NULL DEFAULT 'SUBMITTED',
  proof_file_url   text,
  payment_id       text,
  payment_method   text,
  proof_url        text,
  proof_filename   text,
  order_type       text DEFAULT 'DINE-IN',
  rejection_reason text,
  verified_by      text,
  verified_at      timestamptz,
  updated_at       timestamptz DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_audit_logs (
  id         bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  order_id   text,
  action     text NOT NULL,
  actor_id   text,
  actor_name text,
  old_value  text,
  new_value  text,
  details    jsonb,
  created_at timestamptz DEFAULT now()
);

-- ─── ONLINE ORDERS ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS online_orders (
  id                   bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  order_ref            text NOT NULL UNIQUE,
  customer_name        text NOT NULL,
  customer_phone       text NOT NULL,
  customer_email       text,
  delivery_address     text,
  delivery_notes       text,
  courier_type         text DEFAULT 'LALAMOVE',
  subtotal             numeric NOT NULL DEFAULT 0,
  total_amount         numeric,
  delivery_fee         numeric DEFAULT 0,
  delivery_zone        text,
  payment_method       varchar DEFAULT 'gcash',
  payment_proof_url    text,
  status               text NOT NULL DEFAULT 'PENDING',
  payment_status       text NOT NULL DEFAULT 'PENDING',
  sms_sent             boolean DEFAULT false,
  admin_notes          text,
  special_instructions text,
  pickup_time          timestamptz,
  created_at           timestamptz DEFAULT now(),
  updated_at           timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS online_order_items (
  id           bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  order_id     bigint NOT NULL,
  order_ref    varchar,
  menu_item_id text,
  item_name    text NOT NULL,
  size         text DEFAULT 'REGULAR',
  unit_price   numeric NOT NULL,
  quantity     integer NOT NULL DEFAULT 1,
  subtotal     numeric,
  addons       jsonb,
  created_at   timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS online_payments (
  id              bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  order_id        bigint NOT NULL,
  order_ref       text NOT NULL,
  amount          numeric NOT NULL,
  payment_method  text NOT NULL DEFAULT 'GCASH',
  proof_url       text,
  proof_filename  text,
  status          text NOT NULL DEFAULT 'PENDING',
  rejection_reason text,
  verified_by     text,
  verified_at     timestamptz,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_queue (
  id            bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  order_ref     text NOT NULL,
  order_type    text NOT NULL DEFAULT 'ONLINE',
  order_data    jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'PENDING',
  retry_count   integer NOT NULL DEFAULT 0,
  max_retries   integer NOT NULL DEFAULT 3,
  error_message text,
  worker_id     text,
  next_retry_at timestamptz,
  processed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ─── INVENTORY ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS inventory (
  id                 bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  item_code          text NOT NULL UNIQUE,
  stock_qty          numeric DEFAULT 0,
  low_stock_threshold numeric DEFAULT 10,
  unit               text DEFAULT 'pcs',
  cost_per_unit      numeric DEFAULT 0,
  selling_price      numeric DEFAULT 0,
  size_per_unit      text DEFAULT '',
  auto_disable       boolean DEFAULT false,
  photo_url          text,
  restock_notes      text,
  last_restocked_at  timestamptz,
  created_at         timestamptz DEFAULT now(),
  updated_at         timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory_log (
  id           bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  item_code    text NOT NULL,
  change_type  text NOT NULL,
  qty_before   numeric,
  qty_change   numeric NOT NULL,
  qty_after    numeric,
  order_id     text,
  unit_price   numeric DEFAULT 0,
  reference    text DEFAULT '',
  notes        text,
  actor_id     text,
  created_at   timestamptz DEFAULT now()
);

-- ─── FINANCIAL ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cash_sessions (
  id                   bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  session_id           text NOT NULL UNIQUE,
  shift                text DEFAULT 'AM',
  opened_by            text,
  closed_by            text,
  opening_float        numeric DEFAULT 0,
  closing_count        numeric,
  expected_cash        numeric,
  variance             numeric,
  cash_sales           numeric DEFAULT 0,
  total_sales          numeric DEFAULT 0,
  denomination_breakdown jsonb DEFAULT '{}',
  notes                text,
  status               text DEFAULT 'OPEN',
  opened_at            timestamptz DEFAULT now(),
  closed_at            timestamptz,
  created_at           timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS refunds (
  id              bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  refund_id       text NOT NULL UNIQUE,
  order_id        text NOT NULL,
  refund_type     text NOT NULL,
  refund_amount   numeric NOT NULL DEFAULT 0,
  reason_code     text NOT NULL,
  reason_note     text,
  refund_method   text,
  items_refunded  jsonb DEFAULT '[]',
  processed_by    text,
  status          text DEFAULT 'PROCESSED',
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

-- ─── CRM ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS customers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  phone         text,
  email         text,
  notes         text,
  total_orders  integer DEFAULT 0,
  total_spent   numeric DEFAULT 0,
  last_visit    timestamptz,
  first_visit   timestamptz DEFAULT now(),
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reservations (
  id            bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  res_id        text NOT NULL UNIQUE,
  table_no      integer,
  table_id      uuid,
  guest_name    text NOT NULL,
  guest_phone   text,
  guest_email   text,
  pax           integer NOT NULL DEFAULT 1,
  res_date      date NOT NULL,
  res_time      time NOT NULL,
  occasion      text,
  seating_pref  text,
  dietary       text,
  notes         text,
  status        text NOT NULL DEFAULT 'CONFIRMED',
  source        text DEFAULT 'ONLINE',
  confirmed_by  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ─── LOYALTY ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS loyalty_accounts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,
  email                 text NOT NULL UNIQUE,
  phone                 text,
  points_balance        integer NOT NULL DEFAULT 0,
  total_points_earned   integer NOT NULL DEFAULT 0,
  total_points_redeemed integer NOT NULL DEFAULT 0,
  tier                  text NOT NULL DEFAULT 'BRONZE',
  total_spent           numeric NOT NULL DEFAULT 0,
  visit_count           integer NOT NULL DEFAULT 0,
  last_visit            timestamptz,
  last_earn_at          timestamptz,
  is_active             boolean NOT NULL DEFAULT true,
  linked_card_number    text,
  registration_source   text DEFAULT 'in_cafe',
  card_tier_request     integer,
  card_request_status   text,
  signup_notes          text,
  claimed_tiers         integer[] NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS points_transactions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES loyalty_accounts(id),
  order_id       text,
  type           text NOT NULL,
  points         integer NOT NULL,
  balance_before integer NOT NULL DEFAULT 0,
  balance_after  integer NOT NULL DEFAULT 0,
  description    text,
  processed_by   text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS leaf_rewards (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tier_order   integer NOT NULL UNIQUE,
  threshold    integer NOT NULL,
  reward_name  text NOT NULL,
  reward_emoji text DEFAULT '🍃',
  description  text,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS leaf_redemptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES loyalty_accounts(id),
  reward_id       uuid NOT NULL REFERENCES leaf_rewards(id),
  tier_order      integer NOT NULL,
  reward_name     text NOT NULL,
  threshold       integer NOT NULL,
  leaves_at_claim integer NOT NULL,
  status          text NOT NULL DEFAULT 'PENDING',
  order_id        text,
  notes           text,
  fulfilled_by    text,
  fulfilled_at    timestamptz,
  claimed_at      timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS surprise_rewards (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            uuid NOT NULL REFERENCES loyalty_accounts(id),
  reward_type           text NOT NULL,
  reward_name           text NOT NULL,
  reward_value          text,
  status                text NOT NULL DEFAULT 'PENDING',
  triggered_by_order_id text,
  triggered_at          timestamptz NOT NULL DEFAULT now(),
  fulfilled_at          timestamptz,
  fulfilled_by          text,
  fulfilled_order_id    text,
  expires_at            timestamptz,
  notes                 text
);

-- ─── YANI PREPAID CARDS ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS yani_cards (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_number  text NOT NULL UNIQUE,
  qr_token     text NOT NULL UNIQUE,
  holder_name  text,
  holder_phone text,
  holder_email text,
  tier         text NOT NULL DEFAULT '500',
  balance      numeric NOT NULL DEFAULT 0,
  total_loaded numeric NOT NULL DEFAULT 0,
  total_spent  numeric NOT NULL DEFAULT 0,
  total_saved  numeric NOT NULL DEFAULT 0,
  discount_pct numeric NOT NULL DEFAULT 10,
  card_pin     text NOT NULL DEFAULT lpad(((floor(random()*90)+10)::text), 2, '0'),
  status       text NOT NULL DEFAULT 'INACTIVE',
  activated_at timestamptz,
  expires_at   timestamptz,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS card_transactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id         uuid NOT NULL REFERENCES yani_cards(id),
  card_number     text NOT NULL,
  type            text NOT NULL,
  amount          numeric NOT NULL DEFAULT 0,
  discount_amount numeric NOT NULL DEFAULT 0,
  balance_before  numeric NOT NULL,
  balance_after   numeric NOT NULL,
  order_id        text,
  description     text,
  performed_by    text,
  reversed_by_txn uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ─── COSTING ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS costing_ingredients (
  id            bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  name          text NOT NULL,
  unit          text NOT NULL DEFAULT 'g',
  cost_per_unit numeric NOT NULL DEFAULT 0,
  category      text DEFAULT 'Other',
  notes         text,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS costing_recipes (
  id            bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  name          text NOT NULL,
  category      text NOT NULL DEFAULT 'HOT',
  selling_price numeric NOT NULL DEFAULT 0,
  notes         text,
  is_active     boolean DEFAULT true,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS costing_recipe_ingredients (
  id            bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  recipe_id     bigint NOT NULL REFERENCES costing_recipes(id),
  ingredient_id bigint NOT NULL REFERENCES costing_ingredients(id),
  qty           numeric NOT NULL DEFAULT 0,
  notes         text,
  created_at    timestamptz DEFAULT now()
);

-- ─── MISC ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS promo_codes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL UNIQUE,
  discount_type  text NOT NULL,
  discount_value numeric NOT NULL,
  description    text,
  valid_from     timestamptz,
  valid_until    timestamptz,
  max_uses       integer,
  used_count     integer DEFAULT 0,
  is_active      boolean DEFAULT true,
  created_at     timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS saas_leads (
  id            bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  business_name text NOT NULL,
  business_type text,
  owner_name    text NOT NULL,
  phone         text NOT NULL,
  location      text,
  plan_interest text DEFAULT 'Business',
  notes         text,
  source        text DEFAULT 'saas_landing',
  status        text DEFAULT 'NEW',
  created_at    timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS role_permissions (
  action      text PRIMARY KEY,
  roles       text[] NOT NULL,
  description text,
  updated_at  timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_rate_limits (
  key          text PRIMARY KEY,
  count        integer NOT NULL DEFAULT 1,
  window_start bigint NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS weather_cache (
  cache_date        date NOT NULL,
  location          text NOT NULL DEFAULT 'Amadeo,PH',
  precipitation_mm  numeric,
  conditions        text,
  raw_response      jsonb,
  fetched_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cache_date, location)
);

CREATE TABLE IF NOT EXISTS menu_items_audit (
  id          bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  item_code   text NOT NULL,
  item_name   text,
  old_active  boolean,
  new_active  boolean,
  changed_at  timestamptz DEFAULT now(),
  changed_by  text DEFAULT CURRENT_USER,
  app_name    text DEFAULT current_setting('application_name', true),
  client_addr text DEFAULT inet_client_addr()::text
);

-- =============================================================================
-- END OF SCHEMA SNAPSHOT
-- =============================================================================
