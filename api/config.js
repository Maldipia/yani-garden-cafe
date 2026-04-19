// ── /api/config — Public white-label config endpoint ──────────────────────
// Returns safe tenant settings (no secrets, no JWT keys).
// Called on page load by all frontend pages to replace hardcoded values.

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://hnynvclpvfxzlfjphefj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
const ALLOWED = process.env.ALLOWED_ORIGINS || 'https://yanigardencafe.com';

const SAFE_KEYS = [
  'BUSINESS_NAME','ORDER_PREFIX','SERVICE_CHARGE','CURRENCY','TIMEZONE',
  'PRIMARY_COLOR','SECONDARY_COLOR','LOGO_URL','ADDRESS','TAGLINE',
  'ACCOUNT_NAME','SESSION_KEY','VAT_ENABLED','VAT_RATE',
  'GCASH_QR_URL','INSTAPAY_QR_URL','BDO_QR_URL','BPI_QR_URL','UNIONBANK_QR_URL',
  'BDO_ACCOUNT','BPI_ACCOUNT','UNIONBANK_ACCOUNT',
  'ADMIN_PHONE','GCASH_NUMBER','MAYA_NUMBER','RECEIPT_EMAIL','SUPABASE_ANON_KEY',
  'WELCOME_ENABLED','WELCOME_TITLE','WELCOME_STORY','WELCOME_TAGLINE',
  'WELCOME_GUIDE','WELCOME_BUTTON','WELCOME_AUTO_SECONDS','WELCOME_BG_URL',
];

// Cache for 5 min — config rarely changes
let _cache = null;
let _cacheAt = 0;

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  const allowed = ALLOWED.split(',').map(s => s.trim());
  if (allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', allowed[0]);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });

  // Serve from cache
  if (_cache && Date.now() - _cacheAt < 60 * 1000) { // 60s cache — edits show within 1 minute
    return res.status(200).json({ ok: true, config: _cache, cached: true });
  }

  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/settings?select=key,value&key=in.(${SAFE_KEYS.map(k => `"${k}"`).join(',')})`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await r.json();
    const config = {};
    (rows || []).forEach(({ key, value }) => { config[key] = value; });

    // Defaults for anything missing
    config.BUSINESS_NAME    = config.BUSINESS_NAME    || 'My Cafe';
    config.ORDER_PREFIX     = config.ORDER_PREFIX     || 'ORD';
    config.SERVICE_CHARGE   = config.SERVICE_CHARGE   || '0.10';
    config.PRIMARY_COLOR    = config.PRIMARY_COLOR    || '#2D5016';
    config.SECONDARY_COLOR  = config.SECONDARY_COLOR  || '#78350F';
    config.LOGO_URL         = config.LOGO_URL         || '/images/logo.png';
    config.CURRENCY         = config.CURRENCY         || 'PHP';
    config.SESSION_KEY      = config.SESSION_KEY      || 'pos_session_token';
    config.SUPABASE_ANON_KEY = config.SUPABASE_ANON_KEY || '';

    _cache = config;
    _cacheAt = Date.now();
    return res.status(200).json({ ok: true, config });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
