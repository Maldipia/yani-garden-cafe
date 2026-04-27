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
  'PAYMENT_IMAGE_URL','CARD_PAYMENT_MODE',
];

// Hardcoded fallback so site never goes blank when DB is slow/unavailable
const FALLBACK_CONFIG = {
  BUSINESS_NAME:    'Yani Garden Cafe',
  ORDER_PREFIX:     'YANI',
  SERVICE_CHARGE:   '0.10',
  CURRENCY:         'PHP',
  TIMEZONE:         'Asia/Manila',
  PRIMARY_COLOR:    '#2D5016',
  SECONDARY_COLOR:  '#78350F',
  LOGO_URL:         'https://hnynvclpvfxzlfjphefj.supabase.co/storage/v1/object/public/card-assets/ygc-logo.png',
  ADDRESS:          'Amadeo, Cavite',
  TAGLINE:          'Holding a cup of Yani everyday...',
  SESSION_KEY:      'pos_session_token',
  WELCOME_ENABLED:  'true',
  WELCOME_TITLE:    'YANI Garden Cafe',
  WELCOME_STORY:    'Behind YANI is a family\nYANI is not just a café.\n It\u2019s where flavors are created.\n\n hands-on, intentional, present in every detail.\n\nsome things were built. some were tested. \nsome failed... then perfected.\n\nOur sauces... combinations... process.\nfrom farm eggs to fresh calamansi,\n chosen, prepared, and used with purpose.\n\nFrom our coffee\u2026 to our sauces\u2026 \nto every plate we serve\nEverything here is made with care.\n\nYANI is still growing.\n Still learning.\n Still building.\n\nfrom: Pia, Myk, Mayo, Ivan, Chinlee, Mark , Aira , tita Fina, Nijhel and Weng\nWe Thank you for your patience.\n\nYou\u2019re part of this story now.',
  WELCOME_TAGLINE:  'Thank you for being here today. \ud83c\udf3f',
  WELCOME_GUIDE:    'Browse our menu by category, tap any item to add it to your order. Your order goes straight to our kitchen.',
  WELCOME_BUTTON:   'See Our Menu \u2192',
  WELCOME_AUTO_SECONDS: '0',
  WELCOME_BG_URL:   'https://hnynvclpvfxzlfjphefj.supabase.co/storage/v1/object/public/menu-images/WELCOME_BG.jpg',
  CARD_PAYMENT_MODE: 'manual',
};

// Long cache — 24 hours. Config rarely changes.
// Admin edits show after this window or after a redeploy.
let _cache = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

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

  // Serve from in-memory cache
  if (_cache && Date.now() - _cacheAt < CACHE_TTL_MS) {
    return res.status(200).json({ ok: true, config: _cache, cached: true });
  }

  // Try DB with a 5-second timeout
  let config = { ...FALLBACK_CONFIG };
  let source = 'fallback';
  try {
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/settings?select=key,value&key=in.(${SAFE_KEYS.map(k => `"${k}"`).join(',')})`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, signal: ctrl.signal }
    );
    clearTimeout(timeoutId);
    const rows = await r.json();
    if (Array.isArray(rows) && rows.length) {
      const dbConfig = {};
      rows.forEach(({ key, value }) => { dbConfig[key] = value; });
      // Merge: DB values override fallback
      config = { ...FALLBACK_CONFIG, ...dbConfig };
      source = 'db';
    }
  } catch (e) {
    console.error('Config DB fetch failed, serving fallback:', e.message);
  }

  // Cache result (even fallback, to avoid hammering DB)
  _cache = config;
  _cacheAt = Date.now();
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300, stale-while-revalidate=86400');
  return res.status(200).json({ ok: true, config, source });
};
