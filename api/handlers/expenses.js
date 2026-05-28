// ── EXPENSES HANDLER (ESM) ────────────────────────────────────────────────
import { supaFetch, supa }        from '../lib/db.js';
import { SUPABASE_URL }            from '../lib/config.js';

const EXPENSE_ACTIONS = new Set([
  'addShiftExpense','getShiftExpenses',
  'addBusinessExpense','getBusinessExpenses','deleteBusinessExpense'
]);

export async function routeExpenses(action, body, auth, req, res) {
  if (!EXPENSE_ACTIONS.has(action)) return false;
  const { checkAdminAuth } = auth;

  // ── addShiftExpense ──────────────────────────────────────────────────────
  if (action === 'addShiftExpense') {
    const a = await checkAdminAuth();
    if (!a.ok) return res.status(403).json({ ok:false, error:a.error });
    const { description, amount, type, category, notes } = body;
    if (!description?.trim()) return res.status(400).json({ ok:false, error:'Description required' });
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return res.status(400).json({ ok:false, error:'Valid amount required' });
    if (!['EXPENSE','INCOME'].includes(type)) return res.status(400).json({ ok:false, error:'type must be EXPENSE or INCOME' });
    const r = await supa('POST','shift_expenses',{
      type, description: String(description).trim().substring(0,300),
      amount: amt, category: String(category||'Other').trim(),
      notes: notes ? String(notes).trim().substring(0,500) : null,
      added_by: a.userId||'staff', added_by_role: a.role||'',
      session_date: new Date().toISOString().split('T')[0],
    });
    if (!r.ok) return res.status(500).json({ ok:false, error:'Failed to save' });
    return res.status(200).json({ ok:true });
  }

  // ── getShiftExpenses ─────────────────────────────────────────────────────
  if (action === 'getShiftExpenses') {
    const a = await checkAdminAuth();
    if (!a.ok) return res.status(403).json({ ok:false, error:a.error });
    const date = String(body.date || new Date().toISOString().split('T')[0]);
    const r = await supaFetch(
      `${SUPABASE_URL}/rest/v1/shift_expenses?session_date=eq.${encodeURIComponent(date)}&order=created_at.asc&select=*`
    );
    if (!r.ok) return res.status(500).json({ ok:false, error:'Failed to fetch' });
    const expenses = r.data||[];
    const totalExpenses = expenses.filter(function(e){ return e.type==='EXPENSE'; }).reduce(function(s,e){ return s+parseFloat(e.amount); },0);
    const totalIncome   = expenses.filter(function(e){ return e.type==='INCOME';  }).reduce(function(s,e){ return s+parseFloat(e.amount); },0);
    return res.status(200).json({ ok:true, expenses, totalExpenses, totalIncome });
  }

  // ── addBusinessExpense ───────────────────────────────────────────────────
  if (action === 'addBusinessExpense') {
    const a = await checkAdminAuth();
    if (!a.ok) return res.status(403).json({ ok:false, error:a.error });
    const { description, amount, category, paidVia, referenceNo, notes, expenseDate, isPaid } = body;
    if (!description?.trim()) return res.status(400).json({ ok:false, error:'Description required' });
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return res.status(400).json({ ok:false, error:'Valid amount required' });
    const r = await supa('POST','business_expenses',{
      description: String(description).trim().substring(0,300),
      amount: amt, category: String(category||'Other').trim(),
      paid_via: String(paidVia||'Cash').trim(),
      reference_no: referenceNo ? String(referenceNo).trim().substring(0,100) : null,
      notes: notes ? String(notes).trim().substring(0,500) : null,
      expense_date: expenseDate || new Date().toISOString().split('T')[0],
      is_paid: isPaid !== false,
      added_by: a.userId||'staff', added_by_role: a.role||'',
    });
    if (!r.ok) return res.status(500).json({ ok:false, error:'Failed to save' });
    return res.status(200).json({ ok:true });
  }

  // ── getBusinessExpenses ──────────────────────────────────────────────────
  if (action === 'getBusinessExpenses') {
    const a = await checkAdminAuth();
    if (!a.ok) return res.status(403).json({ ok:false, error:a.error });
    const { month, year, category, limit } = body;
    let url = `${SUPABASE_URL}/rest/v1/business_expenses?order=expense_date.desc,created_at.desc&limit=${parseInt(limit)||100}`;
    if (month && year) {
      const from   = `${year}-${String(month).padStart(2,'0')}-01`;
      const toDate = new Date(parseInt(year), parseInt(month), 0).toISOString().split('T')[0];
      url += `&expense_date=gte.${from}&expense_date=lte.${toDate}`;
    }
    if (category && category !== 'All') url += `&category=eq.${encodeURIComponent(category)}`;
    url += '&select=*';
    const r = await supaFetch(url);
    if (!r.ok) return res.status(500).json({ ok:false, error:'Failed to fetch' });
    const items = r.data||[];
    const total = items.reduce(function(s,e){ return s+parseFloat(e.amount); },0);
    const byCat = {};
    items.forEach(function(e){ byCat[e.category]=(byCat[e.category]||0)+parseFloat(e.amount); });
    return res.status(200).json({ ok:true, expenses:items, total, byCat });
  }

  // ── deleteBusinessExpense ────────────────────────────────────────────────
  if (action === 'deleteBusinessExpense') {
    const a = await checkAdminAuth();
    if (!a.ok) return res.status(403).json({ ok:false, error:a.error });
    if (a.role !== 'OWNER') return res.status(403).json({ ok:false, error:'OWNER only' });
    const { expenseId } = body;
    if (!expenseId) return res.status(400).json({ ok:false, error:'expenseId required' });
    const r = await supa('DELETE','business_expenses',null,{ id:`eq.${expenseId}` });
    if (!r.ok) return res.status(500).json({ ok:false, error:'Failed to delete' });
    return res.status(200).json({ ok:true });
  }

  return false;
}
