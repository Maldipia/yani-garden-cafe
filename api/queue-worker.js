// ══════════════════════════════════════════════════════════════
// YANI POS — Queue Worker  (v2 — GAS-free)
// Previously forwarded orders to Google Apps Script.
// Now processes sheets_sync_log entries to keep Google Sheets
// as a live read-only mirror of Supabase data.
//
// Triggered by:
//   - Vercel Cron Job (every 2 minutes via vercel.json)
//   - Manual call: POST /api/queue-worker { action: 'process' }
//
// Flow:
//   1. Fetch up to BATCH_SIZE unsynced records from sheets_sync_log
//   2. For each record, push the latest data to Google Sheets via
//      the Sheets API (using the service account in SHEETS_SA_KEY)
//   3. Mark as synced = true
// ══════════════════════════════════════════════════════════════

const SUPABASE_URL = 'https://hnynvclpvfxzlfjphefj.supabase.co';

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

const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
const WORKER_SECRET = process.env.QUEUE_WORKER_SECRET || null;
const BATCH_SIZE = 20;

// ── Supabase REST helper ───────────────────────────────────────
async function sb(method, path, body = null, params = null, prefer = null) {
  let url = `${SUPABASE_URL}/rest/v1/${path}`;
  if (params) url += '?' + new URLSearchParams(params).toString();
  const opts = {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': prefer || (method === 'POST' ? 'return=representation' : 'return=minimal')
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

async function sbPatch(path, filter, data) {
  const url = `${SUPABASE_URL}/rest/v1/${path}?${filter}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(data)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PATCH ${path}: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

// ── Fetch pending sync entries ─────────────────────────────────
async function fetchPendingSyncEntries() {
  const entries = await sb('GET', 'sheets_sync_log', null, {
    'synced': 'eq.false',
    'order': 'created_at.asc',
    'limit': String(BATCH_SIZE),
    'select': 'id,table_name,record_id,action,created_at'
  });
  return Array.isArray(entries) ? entries : [];
}

// ── Mark sync entry as done ────────────────────────────────────
async function markSynced(id, error = null) {
  await sbPatch('sheets_sync_log', `id=eq.${id}`, {
    synced: error ? false : true,
    synced_at: error ? null : new Date().toISOString(),
    error_message: error || null,
  });
}

// ── Process a single sync entry ────────────────────────────────
// For now: just marks it as synced (Sheets API integration can be
// added later via SHEETS_SA_KEY env var). The primary purpose of
// this worker is to keep the sync log clean and provide a hook
// for future Sheets integration.
async function processSyncEntry(entry) {
  const { id, table_name, record_id, action } = entry;
  try {
    // TODO: When SHEETS_SA_KEY is configured, push data to Google Sheets here.
    // For now, mark as synced to keep the log clean.
    // The Sheets mirror is updated by the /api/sheets-sync endpoint (if deployed).
    await markSynced(id);
    return { success: true, id, table_name, record_id, action };
  } catch (err) {
    await markSynced(id, err.message);
    return { success: false, id, table_name, record_id, error: err.message };
  }
}

// ══════════════════════════════════════════════════════════════
// MAIN HANDLER
// ══════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  setCorsHeaders(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Verify worker secret if configured
  if (WORKER_SECRET) {
    const authHeader = req.headers['authorization'] || '';
    const providedSecret = authHeader.replace('Bearer ', '');
    if (providedSecret !== WORKER_SECRET) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
  }

  const workerId = `worker-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const startTime = Date.now();

  try {
    const pending = await fetchPendingSyncEntries();

    if (pending.length === 0) {
      return res.status(200).json({
        ok: true,
        workerId,
        processed: 0,
        message: 'Sync queue is empty'
      });
    }

    const results = [];
    for (const entry of pending) {
      const result = await processSyncEntry(entry);
      results.push(result);
    }

    const succeeded = results.filter(r => r.success).length;
    const failed    = results.filter(r => !r.success).length;
    const elapsed   = Date.now() - startTime;

    return res.status(200).json({
      ok: true,
      workerId,
      processed: pending.length,
      succeeded,
      failed,
      elapsedMs: elapsed,
      results
    });

  } catch (err) {
    console.error('Queue worker error:', err);
    return res.status(500).json({ ok: false, workerId, error: err.message });
  }
}
