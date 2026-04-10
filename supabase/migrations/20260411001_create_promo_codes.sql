-- Create promo_codes table for discount code management
CREATE TABLE IF NOT EXISTS promo_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL,
  discount_type text NOT NULL CHECK (discount_type IN ('PERCENT','FIXED')),
  discount_value numeric NOT NULL CHECK (discount_value > 0),
  description text,
  valid_from timestamptz,
  valid_until timestamptz,
  max_uses integer,
  used_count integer DEFAULT 0,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS promo_codes_code_idx ON promo_codes(code);
CREATE INDEX IF NOT EXISTS promo_codes_active_idx ON promo_codes(is_active);
