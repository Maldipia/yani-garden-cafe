// YANI POS — Serverless Router (v5 — modular)
// ══════════════════════════════════════════════════════════════════════
// All business logic lives in api/handlers/*.js
// Shared utilities live in api/lib/*.js
// This file: CORS + rate limit + auth context + dispatch only.
// ══════════════════════════════════════════════════════════════════════

import { SUPABASE_URL, SUPABASE_KEY }   from './lib/config.js';
import { checkRateLimit, getRolePermissions } from './lib/cache.js';
import { verifyToken, buildAuthCtx }    from './lib/auth.js';
import { routeMenu }       from './handlers/menu.js';
import { routeOrders }     from './handlers/orders.js';
import { routeLoyalty }    from './handlers/loyalty.js';
import { routePayments }   from './handlers/payments.js';
import { routeAdmin }      from './handlers/admin.js';
import { routeHR }         from './handlers/hr.js';
import { routeCardPortal } from './handlers/card-portal.js';
import { routeExpenses }  from './handlers/expenses.js';
import { routeReviews }    from './handlers/reviews.js';
import { routeDocs }       from './handlers/docs.js';

const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ||
  'https://pos.yanigardencafe.com,https://yanigardencafe.com,https://admin.yanigardencafe.com'
).split(',').map(s => s.trim());

export default async function handler(req, res) {
  // ── CORS ───────────────────────────────────────────────────────────
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (!origin) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS[0] || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ ok: false, error: 'Method not allowed' });

  // ── Rate limit ─────────────────────────────────────────────────────
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (!await checkRateLimit(ip)) {
    return res.status(429).json({ ok: false, error: 'Too many requests. Please wait a moment.' });
  }

  try {
    const body = req.body;
    if (!body || !body.action) return res.status(400).json({ ok: false, error: 'Missing action' });

    const action = String(body.action).trim();
    if (!/^[a-zA-Z][a-zA-Z0-9_]{1,60}$/.test(action)) {
      return res.status(400).json({ ok: false, error: 'Invalid action name' });
    }

    // ── Auth context (per-request) ────────────────────────────────────
    const authHeader = (req.headers.authorization || req.headers.Authorization || '').trim();
    const rawToken   = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const jwtUser    = rawToken ? await verifyToken(rawToken) : null;
    const auth       = buildAuthCtx(jwtUser, body, action, getRolePermissions);

    // ── Dispatch to handler groups ────────────────────────────────────
    // Each route function returns the Express res object (truthy) if it handled
    // the action, or `false` if the action isn't in its group.
    const handled =
      await routeMenu       (action, body, auth, req, res) ||
      await routeOrders     (action, body, auth, req, res) ||
      await routeLoyalty    (action, body, auth, req, res) ||
      await routePayments   (action, body, auth, req, res) ||
      await routeCardPortal (action, body, auth, req, res) ||
      await routeExpenses   (action, body, auth, req, res) ||
      await routeReviews    (action, body, auth, req, res) ||
      await routeDocs       (action, body, auth, req, res) ||
      await routeHR         (action, body, auth, req, res) ||
      await routeAdmin      (action, body, auth, req, res);

    if (!handled) {
      return res.status(400).json({ ok: false, error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error('POS handler error:', err);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
}
