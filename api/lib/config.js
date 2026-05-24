// ── Shared constants & env vars ──────────────────────────────────────────
export const SUPABASE_URL    = process.env.SUPABASE_URL || 'https://hnynvclpvfxzlfjphefj.supabase.co';
export const RESEND_KEY      = process.env.RESEND_API_KEY || '';
export const FROM_EMAIL      = 'onboarding@resend.dev';
export const BUSINESS_NAME   = process.env.BUSINESS_NAME || 'Yani Garden Cafe';
export const SERVICE_CHARGE_RATE = 0.10;
export const ORDER_PREFIX    = 'ORD';

export const SUPABASE_KEY = (() => {
  const k = process.env.SUPABASE_SECRET_KEY;
  if (!k) throw new Error('SUPABASE_SECRET_KEY env var is not set');
  return k;
})();

// pgBouncer / Supabase Pooler (Transaction mode, port 6543)
// Used by any direct-postgres library (pg, postgres.js). REST API is already pooled via PostgREST.
// Set DATABASE_URL in Vercel env vars to:
//   postgresql://postgres.hnynvclpvfxzlfjphefj:[PASSWORD]@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres
// Session mode (port 5432 on pooler host) if you need SET/advisory locks.
export const DATABASE_URL = process.env.DATABASE_URL || null;
