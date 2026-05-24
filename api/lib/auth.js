// ── Auth helpers: JWT + DB-backed user lookup ─────────────────────────────
import jwt from 'jsonwebtoken';
import { supaFetch, getSetting } from './db.js';
import { SUPABASE_URL } from './config.js';

export const VALID_USER_ID = /^USR_\d{3,6}$/;
const JWT_EXPIRY = '12h';

let _jwtSecret = process.env.JWT_SECRET || null;
export async function getJwtSecret() {
  if (_jwtSecret) return _jwtSecret;
  try { _jwtSecret = await getSetting('JWT_SECRET'); } catch (_) {}
  return _jwtSecret;
}

export async function signToken(userId, role, displayName) {
  const secret = await getJwtSecret();
  if (!secret) return null;
  try {
    return jwt.sign(
      { sub: userId, role, displayName: displayName || '' },
      secret,
      { expiresIn: JWT_EXPIRY }
    );
  } catch { return null; }
}

export async function verifyToken(token) {
  if (!token) return null;
  const secret = await getJwtSecret();
  if (!secret) return null;
  try {
    const payload = jwt.verify(token, secret);
    return { userId: payload.sub, role: payload.role, displayName: payload.displayName || '' };
  } catch { return null; }
}

// DB-only auth check (legacy path when no JWT)
export async function requireAuth(body, allowedRoles) {
  const userId = String(body.userId || '').trim();
  if (!userId) return { ok: false, error: 'userId is required for this action' };
  if (!VALID_USER_ID.test(userId)) return { ok: false, error: 'Invalid userId format' };
  const r = await supaFetch(
    `${SUPABASE_URL}/rest/v1/staff_users?user_id=eq.${encodeURIComponent(userId)}&active=eq.true&select=role`
  );
  if (!r.ok || !r.data || !r.data.length) return { ok: false, error: 'Unauthorized: user not found' };
  const role = r.data[0].role;
  if (allowedRoles && allowedRoles.length && !allowedRoles.includes(role)) {
    return { ok: false, error: 'Unauthorized: insufficient role' };
  }
  return { ok: true, role };
}

// Build the per-request auth context (jwtUser already resolved by caller)
export function buildAuthCtx(jwtUser, body, action, getRolePermsFn) {
  async function checkAuth(allowedRoles) {
    if (jwtUser) {
      const dbPerms = await getRolePermsFn();
      const roles = (dbPerms && dbPerms[action]) ? dbPerms[action] : (allowedRoles || []);
      if (!roles.length || roles.includes(jwtUser.role)) {
        return { ok: true, role: jwtUser.role, userId: jwtUser.userId };
      }
      return { ok: false, error: 'Unauthorized: insufficient role' };
    }
    return requireAuth(body, allowedRoles);
  }
  async function checkAdminAuth() { return checkAuth(['ADMIN', 'OWNER']); }
  return { checkAuth, checkAdminAuth, jwtUser };
}
