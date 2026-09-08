// ── HR AUDIT ─────────────────────────────────────────────────────────────
// Immutable trail for every change to an HR record. hr_audit_log has UPDATE
// and DELETE revoked from client roles, so entries can be added but never
// altered or removed.
//
// Deliberately NEVER throws: an audit failure must not block the operation
// the user asked for. It returns false so the caller can log if it wants.
import { supaFetch } from './db.js';
import { SUPABASE_URL } from './config.js';

const TENANT_HR = '11111111-1111-4111-8111-111111111111';

export async function hrAudit({ action, module, recordId, previous, next, reason, actorCode, role, req }) {
  try {
    if (!action) return false;
    const ip = req?.headers?.['x-forwarded-for'] || req?.headers?.['x-real-ip'] || null;
    // MUST be awaited by the caller: on serverless the function is torn down
    // as soon as the response is sent, so an un-awaited write silently vanishes.
    const r = await supaFetch(`${SUPABASE_URL}/rest/v1/hr_audit_log`, {
      method: 'POST',
      body: JSON.stringify({
        tenant_id: TENANT_HR,
        occurred_at: new Date().toISOString(),
        actor_code: actorCode ? String(actorCode).substring(0, 40) : null,
        user_role: role ? String(role).substring(0, 40) : null,
        action: String(action).substring(0, 80),
        module: module ? String(module).substring(0, 40) : null,
        record_id: recordId ? String(recordId).substring(0, 80) : null,
        previous_value: previous ?? null,
        new_value: next ?? null,
        reason: reason ? String(reason).substring(0, 500) : null,
        device_ip: ip ? String(ip).substring(0, 60) : null,
      }),
    });
    return !!r.ok;
  } catch (_) {
    return false;
  }
}
