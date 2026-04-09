// ── api/handlers/cash.js ────────────────────────────────────────────────────────────────
// Handles: openCashSession, closeCashSession, getCashSessions, getOpenCashSession
// ctx: { action, body, req, res, jwtUser, checkAuth, supa, supaFetch, auditLog,
//          SUPABASE_URL, SUPABASE_KEY, SERVICE_CHARGE_RATE, ORDER_PREFIX, getSetting }

export async function handle_cash(action, ctx) {
  const { body, req, res, jwtUser, checkAuth, supa, supaFetch, auditLog,
          SUPABASE_URL, SUPABASE_KEY, SERVICE_CHARGE_RATE, ORDER_PREFIX, getSetting } = ctx;

    // ══════════════════════════════════════════════════════════════════════
    // CASH DRAWER / EOD RECONCILIATION
    // ══════════════════════════════════════════════════════════════════════

    // ── openCashSession ────────────────────────────────────────────────────
    if (action === 'openCashSession') {
      const auth = await checkAuth(['OWNER','ADMIN','CASHIER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      // Check no session is already open
      const existing = await supaFetch(
        `${SUPABASE_URL}/rest/v1/cash_sessions?status=eq.OPEN&select=session_id,opened_at,opened_by`
      );
      if (existing.ok && existing.data?.length) {
        res.status(200).json({ ok: false, error: 'A cash session is already open',
          existingSession: existing.data[0] }); return true;
      }
      const sessionId = 'CASH-' + Date.now();
      const row = {
        session_id: sessionId,
        shift: body.shift || 'AM',
        opened_by: body.userId,
        opening_float: parseFloat(body.openingFloat) || 0,
        status: 'OPEN',
        opened_at: new Date().toISOString(),
      };
      const r = await supaFetch(`${SUPABASE_URL}/rest/v1/cash_sessions`,
        { method: 'POST', body: JSON.stringify(row), headers: { Prefer: 'return=representation' } });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to open cash session' });
      res.status(200).json({ ok: true, sessionId, shift: row.shift, openingFloat: row.opening_float }); return true;
    }

    // ── closeCashSession ───────────────────────────────────────────────────
    if (action === 'closeCashSession') {
      const auth = await checkAuth(['OWNER','ADMIN','CASHIER']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const { sessionId, closingCount, denominationBreakdown, notes } = body;
      if (!sessionId) return res.status(400).json({ ok: false, error: 'sessionId required' });

      // Get session + compute expected cash (cash sales since session opened)
      const sessRes = await supaFetch(
        `${SUPABASE_URL}/rest/v1/cash_sessions?session_id=eq.${encodeURIComponent(sessionId)}&select=*`
      );
      if (!sessRes.ok || !sessRes.data?.length) return res.status(404).json({ ok: false, error: 'Session not found' });
      const sess = sessRes.data[0];

      // Sum cash sales since session opened — use Array.isArray guard to prevent .reduce crash
      const salesRes = await supaFetch(
        `${SUPABASE_URL}/rest/v1/dine_in_orders?status=eq.COMPLETED&is_deleted=eq.false&created_at=gte.${encodeURIComponent(sess.opened_at)}&select=total,payment_method,discounted_total`
      );
      const orders = Array.isArray(salesRes.data) ? salesRes.data : [];
      const totalSales = orders.reduce((s, o) => s + parseFloat(o.discounted_total || o.total || 0), 0);
      const cashSales = orders
        .filter(o => (o.payment_method || '').toUpperCase().includes('CASH'))
        .reduce((s, o) => s + parseFloat(o.discounted_total || o.total || 0), 0);
      const expectedCash = parseFloat(sess.opening_float || 0) + cashSales;
      const closing = parseFloat(closingCount) || 0;
      const variance = closing - expectedCash;

      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/cash_sessions?session_id=eq.${encodeURIComponent(sessionId)}`,
        { method: 'PATCH', body: JSON.stringify({
          closed_by: body.userId,
          closing_count: closing,
          expected_cash: expectedCash,
          variance,
          cash_sales: cashSales,
          total_sales: totalSales,
          denomination_breakdown: denominationBreakdown || {},
          notes: notes || '',
          status: 'CLOSED',
          closed_at: new Date().toISOString(),
        })}
      );
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to close session' });
      res.status(200).json({
        ok: true, sessionId, totalSales, cashSales,
        openingFloat: sess.opening_float, expectedCash, closingCount: closing, variance,
        overShort: variance >= 0 ? `OVER ₱${Math.abs(variance).toFixed(2)}` : `SHORT ₱${Math.abs(variance).toFixed(2)}`
      }); return true;
    }

    // ── getCashSessions ────────────────────────────────────────────────────
    if (action === 'getCashSessions') {
      const auth = await checkAuth(['OWNER','ADMIN']);
      if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
      const limit = Math.min(parseInt(body.limit) || 20, 100);
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/cash_sessions?select=*&order=created_at.desc&limit=${limit}`
      );
      res.status(200).json({ ok: r.ok, sessions: r.data || [] }); return true;
    }

    // ── getOpenCashSession ─────────────────────────────────────────────────
    if (action === 'getOpenCashSession') {
      const r = await supaFetch(
        `${SUPABASE_URL}/rest/v1/cash_sessions?status=eq.OPEN&select=*&order=opened_at.desc&limit=1`
      );
      res.status(200).json({ ok: r.ok, session: r.data?.[0] || null }); return true;
    }

    // ── Unknown action ─────────────────────────────────────────────────────
    res.status(400).json({ ok: false, error: `Unknown action: ${action}` }); return true;

  } catch (err) {
    console.error('API error:', err);
    res.status(500).json({ ok: false, error: 'Server error: ' + err.message }); return true;
  }


  return false; // not handled by this module
}

  const _handled = ['openCashSession', 'closeCashSession', 'getCashSessions', 'getOpenCashSession'];
  if (!_handled.includes(action)) return false;

