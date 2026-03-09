// ══════════════════════════════════════════════════════════════
// YANI POS — Order Queue Worker
// Processes orders from order_queue table sequentially,
// forwarding each to Google Apps Script.
//
// This eliminates the 30 concurrent GAS execution limit by
// processing orders one-at-a-time through a controlled worker.
//
// Triggered by:
//   - Vercel Cron Job (every minute via vercel.json)
//   - Manual call: POST /api/queue-worker { action: 'process' }
//   - Internal call from online-order.js after enqueuing
//
// Flow:
//   1. Claim up to BATCH_SIZE PENDING orders (atomic UPDATE)
//   2. Process each sequentially → call GAS
//   3. Mark COMPLETED or FAILED with retry logic
//   4. Dead-letter after max_retries exceeded
// ══════════════════════════════════════════════════════════════

const SUPABASE_URL = 'https://hnynvclpvfxzlfjphefj.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_PQBb1nDY7U7SxNfgDYoXyg_GtoLowLM';
const GAS_URL = 'https://script.google.com/macros/s/AKfycbzprf6_LpDwcVujm8kcGFZE5JdkL0k9b6Wfg5l82gjZzFua8w1QWH8UoFFlhznc6EtL/exec';
const WORKER_SECRET = process.env.QUEUE_WORKER_SECRET || null;

// Max orders to process per invocation (keeps execution under 30s)
const BATCH_SIZE = 5;
// GAS call timeout in ms
const GAS_TIMEOUT_MS = 20000;
// Exponential backoff delays per retry (ms)
const RETRY_DELAYS = [30000, 120000, 300000]; // 30s, 2min, 5min

// ── Supabase REST helper ───────────────────────────────────────
async function sb(method, path, body = null, params = null) {
  let url = `${SUPABASE_URL}/rest/v1/${path}`;
  if (params) url += '?' + new URLSearchParams(params).toString();
  const opts = {
    method,
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation' : 'return=representation'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${method} ${path}: ${res.status} ${text}`);
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

async function sbPatch(path, filter, data) {
  const url = `${SUPABASE_URL}/rest/v1/${path}?${filter}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(data)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PATCH ${path}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

// ── Claim pending orders atomically ───────────────────────────
// Uses PATCH with status filter to prevent double-processing
async function claimPendingOrders(workerId) {
  const now = new Date().toISOString();
  // Fetch PENDING orders that are ready to process
  // (either no next_retry_at, or next_retry_at is in the past)
  const orders = await sb('GET', 'order_queue', null, {
    'status': 'eq.PENDING',
    'order': 'created_at.asc',
    'limit': String(BATCH_SIZE),
    'or': `(next_retry_at.is.null,next_retry_at.lte.${now})`
  });
  
  if (!orders || orders.length === 0) return [];
  
  // Claim each order by setting status to PROCESSING
  const claimed = [];
  for (const order of orders) {
    try {
      const updated = await sbPatch(
        'order_queue',
        `id=eq.${order.id}&status=eq.PENDING`,
        { status: 'PROCESSING', worker_id: workerId, updated_at: now }
      );
      if (updated && updated.length > 0) {
        claimed.push(updated[0]);
      }
    } catch (e) {
      // Another worker claimed it — skip
      console.log(`Order ${order.id} already claimed, skipping`);
    }
  }
  return claimed;
}

// ── Call Google Apps Script with timeout ──────────────────────
async function callGAS(payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GAS_TIMEOUT_MS);
  
  try {
    const res = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timer);
    
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GAS returned ${res.status}: ${text.slice(0, 200)}`);
    }
    
    const text = await res.text();
    try {
      const data = JSON.parse(text);
      if (data && data.success === false) {
        throw new Error(`GAS error: ${data.error || 'Unknown GAS error'}`);
      }
      return { ok: true, data };
    } catch (parseErr) {
      // GAS sometimes returns non-JSON on success
      return { ok: true, data: text };
    }
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      throw new Error(`GAS call timed out after ${GAS_TIMEOUT_MS}ms`);
    }
    throw e;
  }
}

// ── Process a single queued order ─────────────────────────────
async function processOrder(queueEntry) {
  const { id, order_ref, order_data, retry_count, max_retries } = queueEntry;
  const now = new Date().toISOString();
  
  console.log(`Processing queue entry ${id} (${order_ref}), attempt ${retry_count + 1}/${max_retries + 1}`);
  
  try {
    // Call GAS with the stored order payload
    await callGAS(order_data);
    
    // Mark as COMPLETED
    await sbPatch('order_queue', `id=eq.${id}`, {
      status: 'COMPLETED',
      processed_at: now,
      updated_at: now,
      error_message: null
    });
    
    console.log(`Queue entry ${id} (${order_ref}) completed successfully`);
    return { success: true, id, order_ref };
    
  } catch (err) {
    const errorMsg = err.message || 'Unknown error';
    const newRetryCount = retry_count + 1;
    
    console.error(`Queue entry ${id} (${order_ref}) failed: ${errorMsg}`);
    
    if (newRetryCount >= max_retries) {
      // Dead-letter: max retries exceeded
      await sbPatch('order_queue', `id=eq.${id}`, {
        status: 'DEAD',
        retry_count: newRetryCount,
        error_message: `DEAD after ${newRetryCount} retries. Last error: ${errorMsg}`,
        updated_at: now
      });
      console.error(`Queue entry ${id} (${order_ref}) moved to DEAD after ${newRetryCount} retries`);
      return { success: false, id, order_ref, dead: true, error: errorMsg };
    } else {
      // Schedule retry with exponential backoff
      const delayMs = RETRY_DELAYS[newRetryCount - 1] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
      const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
      
      await sbPatch('order_queue', `id=eq.${id}`, {
        status: 'PENDING',
        retry_count: newRetryCount,
        next_retry_at: nextRetryAt,
        error_message: `Retry ${newRetryCount}/${max_retries}: ${errorMsg}`,
        updated_at: now
      });
      
      console.log(`Queue entry ${id} (${order_ref}) scheduled for retry at ${nextRetryAt}`);
      return { success: false, id, order_ref, retrying: true, nextRetryAt, error: errorMsg };
    }
  }
}

// ══════════════════════════════════════════════════════════════
// MAIN HANDLER
// ══════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  
  // Verify worker secret if configured (for manual calls)
  // Cron jobs from Vercel include Authorization: Bearer <CRON_SECRET>
  if (WORKER_SECRET) {
    const authHeader = req.headers['authorization'] || '';
    const providedSecret = authHeader.replace('Bearer ', '');
    if (providedSecret !== WORKER_SECRET) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
  }
  
  // Generate unique worker ID for this invocation
  const workerId = `worker-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const startTime = Date.now();
  
  try {
    // Check queue stats first
    const stats = await sb('GET', 'order_queue', null, {
      'status': 'eq.PENDING',
      'select': 'id',
      'limit': '100'
    });
    const pendingCount = stats ? stats.length : 0;
    
    if (pendingCount === 0) {
      return res.status(200).json({
        ok: true,
        workerId,
        processed: 0,
        message: 'Queue is empty'
      });
    }
    
    // Claim and process orders
    const claimed = await claimPendingOrders(workerId);
    
    if (claimed.length === 0) {
      return res.status(200).json({
        ok: true,
        workerId,
        processed: 0,
        message: 'No orders available to claim (may be claimed by another worker)'
      });
    }
    
    // Process sequentially (not parallel) to avoid overwhelming GAS
    const results = [];
    for (const order of claimed) {
      const result = await processOrder(order);
      results.push(result);
    }
    
    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success && !r.dead).length;
    const dead = results.filter(r => r.dead).length;
    const elapsed = Date.now() - startTime;
    
    return res.status(200).json({
      ok: true,
      workerId,
      processed: claimed.length,
      succeeded,
      failed,
      dead,
      remainingPending: Math.max(0, pendingCount - claimed.length),
      elapsedMs: elapsed,
      results
    });
    
  } catch (err) {
    console.error('Queue worker error:', err);
    return res.status(500).json({
      ok: false,
      workerId,
      error: err.message
    });
  }
}
