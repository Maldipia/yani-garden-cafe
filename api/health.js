// ══════════════════════════════════════════════════════════════
// YANI SYSTEM HEALTH CHECK — Vercel Serverless API  (v2 — GAS-free)
// Monitors Supabase, sheets-sync status, and menu integrity.
// GAS is no longer used — Google Sheets is a read-only mirror.
// ══════════════════════════════════════════════════════════════

const SUPABASE_URL = 'https://hnynvclpvfxzlfjphefj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;

const ALLOWED_ORIGINS = [
  'https://yanigardencafe.com',
  'https://pos.yanigardencafe.com',
  'https://admin.yanigardencafe.com',
  'https://yani-garden-cafe.vercel.app',
  'https://yani-cafe.vercel.app',
];

function setCorsHeaders(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');
}


// ── Check Supabase health ─────────────────────────────────────
async function checkSupabase() {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/menu_categories?limit=1`, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      },
      signal: controller.signal
    });
    clearTimeout(timeout);
    const latency = Date.now() - start;
    return { ok: resp.ok, latency, status: resp.status };
  } catch (e) {
    const latency = Date.now() - start;
    return { ok: false, latency, error: e.message };
  }
}

// ── Check sheets-sync backlog ─────────────────────────────────
async function checkSheetsSync() {
  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/sheets_sync_log?synced=eq.false&select=id&limit=1`,
      {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Prefer': 'count=exact',
          'Range': '0-0'
        }
      }
    );
    const contentRange = resp.headers.get('content-range') || '';
    const pendingCount = parseInt(contentRange.split('/')[1] || '0');
    return {
      ok: true,
      pendingCount,
      warning: pendingCount > 50 ? `${pendingCount} unsynced records pending Sheets mirror` : null
    };
  } catch (e) {
    return { ok: false, pendingCount: null, error: e.message };
  }
}

// ── Check menu integrity ──────────────────────────────────────
async function checkMenuIntegrity() {
  try {
    const sbResp = await fetch(`${SUPABASE_URL}/rest/v1/menu_items?select=item_code&is_active=eq.true`, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'count=exact',
        'Range': '0-0'
      }
    });
    const contentRange = sbResp.headers.get('content-range') || '';
    const activeCount = parseInt(contentRange.split('/')[1] || '0');
    return {
      ok: true,
      activeCount,
      warning: activeCount === 0 ? 'No active menu items found!' : null
    };
  } catch (e) {
    return { ok: false, activeCount: null, error: e.message };
  }
}

// ── Check recent orders (last 24h) ────────────────────────────
async function checkRecentOrders() {
  try {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/dine_in_orders?created_at=gte.${encodeURIComponent(since)}&select=order_id`,
      {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Prefer': 'count=exact',
          'Range': '0-0'
        }
      }
    );
    const contentRange = resp.headers.get('content-range') || '';
    const count = parseInt(contentRange.split('/')[1] || '0');
    return { ok: true, last24h: count };
  } catch (e) {
    return { ok: false, last24h: null, error: e.message };
  }
}

// ── Log health alert to Supabase logs table ───────────────────────────
export async function logHealthAlert(alerts) {
  if (!alerts || alerts.length === 0) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/logs`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        action: 'SYSTEM_HEALTH_ALERT',
        details: JSON.stringify({ alerts, timestamp: new Date().toISOString() })
      })
    });
  } catch (_) { /* silently ignore */ }
}

// ── Log system error ──────────────────────────────────────────
export async function logError(source, message, details = null) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/logs`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        action: `SYSTEM_ERROR:${source}`,
        details: JSON.stringify({ message, ...(details || {}) })
      })
    });
  } catch (_) { /* silently ignore */ }
}

// ── Main handler ──────────────────────────────────────────────
export default async function handler(req, res) {
  setCorsHeaders(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const [supabaseHealth, sheetsSync, menuIntegrity, recentOrders] = await Promise.all([
      checkSupabase(),
      checkSheetsSync(),
      checkMenuIntegrity(),
      checkRecentOrders(),
    ]);

    const allOk = supabaseHealth.ok;
    const alerts = [];

    if (!supabaseHealth.ok) {
      alerts.push({
        level: 'ERROR',
        source: 'Supabase',
        message: `Database is unreachable: ${supabaseHealth.error || 'Unknown error'}`,
        impact: 'All orders and menu will not work'
      });
    } else if (supabaseHealth.latency > 3000) {
      alerts.push({
        level: 'WARN',
        source: 'Supabase',
        message: `Database is slow (${supabaseHealth.latency}ms)`,
        impact: 'POS and ordering may be sluggish'
      });
    }

    if (sheetsSync.warning) {
      alerts.push({
        level: 'WARN',
        source: 'SheetsSync',
        message: sheetsSync.warning,
        impact: 'Google Sheets mirror may be behind'
      });
    }

    if (menuIntegrity.warning) {
      alerts.push({
        level: 'ERROR',
        source: 'Menu',
        message: menuIntegrity.warning,
        impact: 'Customers cannot place orders'
      });
    }

    if (alerts.length > 0) {
      logHealthAlert(alerts).catch(() => {});
    }

    return res.status(200).json({
      ok: allOk,
      timestamp: new Date().toISOString(),
      architecture: 'supabase-native-v3',
      services: {
        supabase:   { ok: supabaseHealth.ok, latency: supabaseHealth.latency, error: supabaseHealth.error || null },
        sheetsSync: { ok: sheetsSync.ok, pendingCount: sheetsSync.pendingCount, warning: sheetsSync.warning || null },
        menu:       { ok: menuIntegrity.ok, activeCount: menuIntegrity.activeCount, warning: menuIntegrity.warning || null },
      },
      orders: {
        last24h: recentOrders.last24h,
      },
      alerts,
      // Legacy field for admin dashboard compatibility
      gas: { ok: true, latency: 0, note: 'GAS removed — Supabase is now primary data store' },
    });

  } catch (err) {
    console.error('Health check error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
