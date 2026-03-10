// ══════════════════════════════════════════════════════════════
// YANI POS — Queue Status API
// Allows customers and admin to check order queue status
//
// Endpoints:
//   GET  /api/queue-status?action=getOrderStatus&orderRef=YANI-OL-XXXXXX
//   GET  /api/queue-status?action=getQueueStats   (admin)
//   GET  /api/queue-status?action=getDeadOrders   (admin)
//   POST /api/queue-status { action: 'retryDead', orderRef: '...' }
// ══════════════════════════════════════════════════════════════

const SUPABASE_URL = 'https://hnynvclpvfxzlfjphefj.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_SECRET_KEY;

async function sb(method, path, body = null, params = null) {
  let url = `${SUPABASE_URL}/rest/v1/${path}`;
  if (params) url += '?' + new URLSearchParams(params).toString();
  const opts = {
    method,
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal'
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
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(data)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PATCH ${path}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

// ── Status label for customer-facing messages ─────────────────
function getStatusMessage(status, retryCount) {
  switch (status) {
    case 'PENDING':
      return retryCount > 0
        ? `Order is queued for retry (attempt ${retryCount + 1})`
        : 'Order received and queued for processing';
    case 'PROCESSING':
      return 'Order is being processed now';
    case 'COMPLETED':
      return 'Order has been sent to the kitchen';
    case 'FAILED':
      return 'Order processing encountered an issue';
    case 'DEAD':
      return 'Order could not be processed after multiple attempts — please contact staff';
    default:
      return 'Unknown status';
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  
  let action, payload;
  if (req.method === 'GET') {
    action = req.query.action;
    const { action: _a, ...rest } = req.query;
    payload = rest;
  } else {
    const body = req.body || {};
    action = body.action;
    const { action: _a, ...rest } = body;
    payload = rest;
  }
  
  if (!action) return res.status(400).json({ ok: false, error: 'Missing action' });
  
  try {
    // ── GET ORDER QUEUE STATUS (customer) ─────────────────────
    if (action === 'getOrderStatus') {
      const { orderRef } = payload;
      if (!orderRef) return res.status(400).json({ ok: false, error: 'Missing orderRef' });
      
      const entries = await sb('GET', 'order_queue', null, {
        'order_ref': `eq.${orderRef}`,
        'order': 'created_at.desc',
        'limit': '1'
      });
      
      if (!entries || entries.length === 0) {
        return res.status(404).json({ ok: false, error: 'Order not found in queue' });
      }
      
      const entry = entries[0];
      return res.status(200).json({
        ok: true,
        orderRef,
        queueStatus: entry.status,
        retryCount: entry.retry_count,
        message: getStatusMessage(entry.status, entry.retry_count),
        createdAt: entry.created_at,
        processedAt: entry.processed_at,
        nextRetryAt: entry.next_retry_at,
        errorMessage: entry.status === 'DEAD' ? entry.error_message : null
      });
    }
    
    // ── GET QUEUE STATS (admin) ────────────────────────────────
    if (action === 'getQueueStats') {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      
      const allEntries = await sb('GET', 'order_queue', null, {
        'created_at': `gte.${since}`,
        'select': 'status,retry_count,created_at,processed_at,error_message',
        'order': 'created_at.desc',
        'limit': '500'
      });
      
      const entries = allEntries || [];
      
      // Aggregate stats
      const stats = {
        total: entries.length,
        pending: entries.filter(e => e.status === 'PENDING').length,
        processing: entries.filter(e => e.status === 'PROCESSING').length,
        completed: entries.filter(e => e.status === 'COMPLETED').length,
        failed: entries.filter(e => e.status === 'FAILED').length,
        dead: entries.filter(e => e.status === 'DEAD').length,
        avgRetries: entries.length > 0
          ? (entries.reduce((s, e) => s + e.retry_count, 0) / entries.length).toFixed(2)
          : 0,
        oldestPending: null,
        avgProcessingTimeMs: null
      };
      
      // Oldest pending order
      const pending = entries.filter(e => e.status === 'PENDING');
      if (pending.length > 0) {
        stats.oldestPending = pending[pending.length - 1].created_at;
        stats.oldestPendingAgeMs = Date.now() - new Date(stats.oldestPending).getTime();
      }
      
      // Average processing time for completed orders
      const completed = entries.filter(e => e.status === 'COMPLETED' && e.processed_at);
      if (completed.length > 0) {
        const avgMs = completed.reduce((sum, e) => {
          return sum + (new Date(e.processed_at) - new Date(e.created_at));
        }, 0) / completed.length;
        stats.avgProcessingTimeMs = Math.round(avgMs);
      }
      
      return res.status(200).json({ ok: true, stats, since });
    }
    
    // ── GET DEAD ORDERS (admin) ────────────────────────────────
    if (action === 'getDeadOrders') {
      const dead = await sb('GET', 'order_queue', null, {
        'status': 'eq.DEAD',
        'order': 'created_at.desc',
        'limit': '50'
      });
      
      return res.status(200).json({ ok: true, orders: dead || [] });
    }
    
    // ── RETRY DEAD ORDER (admin) ───────────────────────────────
    if (action === 'retryDead') {
      const { orderRef, queueId } = payload;
      if (!orderRef && !queueId) {
        return res.status(400).json({ ok: false, error: 'Missing orderRef or queueId' });
      }
      
      const filter = queueId
        ? `id=eq.${queueId}&status=eq.DEAD`
        : `order_ref=eq.${orderRef}&status=eq.DEAD`;
      
      await sbPatch('order_queue', filter, {
        status: 'PENDING',
        retry_count: 0,
        next_retry_at: null,
        error_message: 'Manually retried by admin',
        updated_at: new Date().toISOString()
      });
      
      return res.status(200).json({
        ok: true,
        message: `Order ${orderRef || queueId} reset to PENDING for retry`
      });
    }
    
    // ── GET RECENT QUEUE ENTRIES (admin) ──────────────────────
    if (action === 'getRecentQueue') {
      const { limit = 20, status } = payload;
      const params = {
        'order': 'created_at.desc',
        'limit': String(Math.min(parseInt(limit) || 20, 100))
      };
      if (status && status !== 'ALL') {
        params['status'] = `eq.${status.toUpperCase()}`;
      }
      
      const entries = await sb('GET', 'order_queue', null, params);
      return res.status(200).json({ ok: true, entries: entries || [] });
    }
    
    return res.status(400).json({ ok: false, error: `Unknown action: ${action}` });
    
  } catch (err) {
    console.error('Queue status API error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
