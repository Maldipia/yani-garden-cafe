// Temporary migration endpoint — DELETE AFTER USE
export default async function handler(req, res) {
  const SECRET = req.headers['x-migrate-secret'];
  if (SECRET !== 'yani-migrate-2026') return res.status(403).json({ error: 'Forbidden' });

  const PAT = 'sbp_e6e7db31bb7c4c096f567cae3aa16c6b2a0637df';
  const PROJECT = 'hnynvclpvfxzlfjphefj';

  const sqls = [
    `ALTER TABLE dine_in_orders ADD COLUMN IF NOT EXISTS is_test BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE dine_in_orders ADD COLUMN IF NOT EXISTS cancel_reason TEXT`,
    `ALTER TABLE dine_in_orders ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE dine_in_orders ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`,
    `ALTER TABLE dine_in_order_items ADD COLUMN IF NOT EXISTS line_total NUMERIC(10,2)`,
    `UPDATE dine_in_order_items SET line_total = ROUND((unit_price * qty)::numeric, 2) WHERE line_total IS NULL`,
    `UPDATE dine_in_orders SET is_test = TRUE WHERE customer_name IN ('Juan Dela Cruz','Maria Santos','Price Test','Guest','Pia Test') OR table_no IN ('T99','0')`,
    `UPDATE dine_in_orders SET cancel_reason = 'migration_cleanup' WHERE status = 'CANCELLED' AND updated_at BETWEEN '2026-03-10 11:38:00' AND '2026-03-10 11:41:00'`,
  ];

  const results = [];
  for (const sql of sqls) {
    try {
      const r = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${PAT}`,
        },
        body: JSON.stringify({ query: sql }),
      });
      const data = await r.json().catch(() => ({}));
      results.push({ sql: sql.substring(0, 70), status: r.status, ok: r.ok, data });
    } catch(e) {
      results.push({ sql: sql.substring(0, 70), error: e.message });
    }
  }
  return res.status(200).json({ ok: true, results });
}
