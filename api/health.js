// ══════════════════════════════════════════════════════════════
// YANI SYSTEM HEALTH CHECK — Vercel Serverless API
// Monitors GAS web app, Supabase, and menu sync status.
// Used by the admin dashboard to show system health alerts.
// ══════════════════════════════════════════════════════════════

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzprf6_LpDwcVujm8kcGFZE5JdkL0k9b6Wfg5l82gjZzFua8w1QWH8UoFFlhznc6EtL/exec';
const SUPABASE_URL    = 'https://hnynvclpvfxzlfjphefj.supabase.co';
const SUPABASE_KEY    = process.env.SUPABASE_SECRET_KEY || 'sb_publishable_PQBb1nDY7U7SxNfgDYoXyg_GtoLowLM';

// ── Check GAS web app health ──────────────────────────────────
async function checkGAS() {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'ping' }),
      redirect: 'manual',
      signal: controller.signal
    });
    clearTimeout(timeout);
    const latency = Date.now() - start;

    // GAS returns 302 redirect for valid requests — that's healthy
    if (resp.status === 302 || resp.status === 200) {
      return { ok: true, latency, status: resp.status };
    }
    return { ok: false, latency, status: resp.status, error: `Unexpected status ${resp.status}` };
  } catch (e) {
    const latency = Date.now() - start;
    if (e.name === 'AbortError') {
      return { ok: false, latency, error: 'GAS timed out (>8s)' };
    }
    return { ok: false, latency, error: e.message };
  }
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

// ── Check menu drift: compare GAS item count vs Supabase ─────
async function checkMenuDrift() {
  try {
    // Get Supabase active item count only (matches GAS which only returns active items)
    const sbResp = await fetch(`${SUPABASE_URL}/rest/v1/menu_items?select=item_code&is_active=eq.true`, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'count=exact',
        'Range': '0-0'
      }
    });
    const contentRange = sbResp.headers.get('content-range') || '';
    const supabaseCount = parseInt(contentRange.split('/')[1] || '0');

    // Get GAS item count via POST
    let gasCount = null;
    try {
      const gasResp = await fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'getMenuAdmin' }),
        redirect: 'follow'
      });
      if (gasResp.ok) {
        const text = await gasResp.text();
        try {
          const data = JSON.parse(text);
          gasCount = Array.isArray(data.items) ? data.items.length : null;
        } catch (_) {}
      }
    } catch (_) {}

    const drift = gasCount !== null ? Math.abs(gasCount - supabaseCount) : null;
    return {
      supabaseCount,
      gasCount,
      drift,
      inSync: drift === 0,
      warning: drift !== null && drift > 0 ? `${drift} item(s) out of sync between GAS and Supabase` : null
    };
  } catch (e) {
    return { error: e.message, inSync: null };
  }
}

// ── Log system event to Supabase logs table ─────────────────────────────
// logs table schema: id, action, actor_id, order_id, details, created_at
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

// ── Main handler ──────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const [gasHealth, supabaseHealth, menuDrift] = await Promise.all([
      checkGAS(),
      checkSupabase(),
      checkMenuDrift()
    ]);

    const allOk = gasHealth.ok && supabaseHealth.ok;
    const alerts = [];
    // Log alerts to Supabase if any issues found
    const shouldLog = !gasHealth.ok || !supabaseHealth.ok || menuDrift.warning;

    if (!gasHealth.ok) {
      alerts.push({
        level: 'ERROR',
        source: 'GAS',
        message: `Google Apps Script is unreachable: ${gasHealth.error || 'Unknown error'}`,
        impact: 'Dine-in orders and menu sync may not work'
      });
    } else if (gasHealth.latency > 5000) {
      alerts.push({
        level: 'WARN',
        source: 'GAS',
        message: `Google Apps Script is slow (${gasHealth.latency}ms)`,
        impact: 'Dine-in POS may be sluggish'
      });
    }

    if (!supabaseHealth.ok) {
      alerts.push({
        level: 'ERROR',
        source: 'Supabase',
        message: `Database is unreachable: ${supabaseHealth.error || 'Unknown error'}`,
        impact: 'Online orders and menu will not load'
      });
    }

    if (menuDrift.warning) {
      alerts.push({
        level: 'WARN',
        source: 'MenuSync',
        message: menuDrift.warning,
        impact: 'Some items may appear differently on dine-in POS vs online order page'
      });
    }

    // Log to Supabase if any alerts were triggered
    if (shouldLog && alerts.length > 0) {
      logHealthAlert(alerts).catch(() => {});
    }

    return res.status(200).json({
      ok: allOk,
      timestamp: new Date().toISOString(),
      services: {
        gas:      { ok: gasHealth.ok,      latency: gasHealth.latency,      error: gasHealth.error || null },
        supabase: { ok: supabaseHealth.ok, latency: supabaseHealth.latency, error: supabaseHealth.error || null }
      },
      menu: {
        supabaseCount: menuDrift.supabaseCount,
        gasCount:      menuDrift.gasCount,
        drift:         menuDrift.drift,
        inSync:        menuDrift.inSync
      },
      alerts
    });

  } catch (err) {
    console.error('Health check error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
