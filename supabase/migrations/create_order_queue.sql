-- ══════════════════════════════════════════════════════════════
-- YANI POS — Order Queue System Migration
-- Creates order_queue table to decouple order placement from GAS
-- This eliminates the 30 concurrent execution limit on GAS
-- ══════════════════════════════════════════════════════════════

-- Create status enum for queue entries
DO $$ BEGIN
  CREATE TYPE queue_status AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'DEAD');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Create order_queue table
CREATE TABLE IF NOT EXISTS order_queue (
  id              BIGSERIAL PRIMARY KEY,
  order_ref       TEXT NOT NULL,
  order_type      TEXT NOT NULL DEFAULT 'ONLINE',   -- 'ONLINE' | 'TABLE' | 'WALKIN'
  order_data      JSONB NOT NULL,                    -- Full order payload for GAS
  status          queue_status NOT NULL DEFAULT 'PENDING',
  retry_count     INTEGER NOT NULL DEFAULT 0,
  max_retries     INTEGER NOT NULL DEFAULT 3,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at    TIMESTAMPTZ,
  next_retry_at   TIMESTAMPTZ,
  error_message   TEXT,
  worker_id       TEXT                               -- Which worker instance is processing
);

-- Indexes for efficient queue polling
CREATE INDEX IF NOT EXISTS idx_order_queue_status ON order_queue (status, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_order_queue_next_retry ON order_queue (next_retry_at) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_order_queue_order_ref ON order_queue (order_ref);

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_order_queue_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_order_queue_updated_at ON order_queue;
CREATE TRIGGER trg_order_queue_updated_at
  BEFORE UPDATE ON order_queue
  FOR EACH ROW EXECUTE FUNCTION update_order_queue_updated_at();

-- Row Level Security
ALTER TABLE order_queue ENABLE ROW LEVEL SECURITY;

-- Allow anon key to INSERT (for order placement)
CREATE POLICY "anon_insert_order_queue" ON order_queue
  FOR INSERT TO anon WITH CHECK (true);

-- Allow anon key to SELECT (for status checks)
CREATE POLICY "anon_select_order_queue" ON order_queue
  FOR SELECT TO anon USING (true);

-- Allow anon key to UPDATE (for worker to update status)
CREATE POLICY "anon_update_order_queue" ON order_queue
  FOR UPDATE TO anon USING (true);

-- ── Queue stats view for admin dashboard ──────────────────────
CREATE OR REPLACE VIEW order_queue_stats AS
SELECT
  status,
  COUNT(*) AS count,
  MIN(created_at) AS oldest,
  MAX(created_at) AS newest,
  AVG(retry_count) AS avg_retries
FROM order_queue
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY status;

-- Grant access to view
GRANT SELECT ON order_queue_stats TO anon;

-- ── Verify table created ──────────────────────────────────────
SELECT 
  'order_queue table created successfully' AS message,
  COUNT(*) AS row_count
FROM order_queue;
