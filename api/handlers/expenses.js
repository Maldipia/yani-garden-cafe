// ── EXPENSES HANDLER (ESM) ────────────────────────────────────────────────
import { supaFetch, supa }        from '../lib/db.js';
import { SUPABASE_URL }            from '../lib/config.js';

const EXPENSE_ACTIONS = new Set([
  'addShiftExpense','getShiftExpenses',
  'addBusinessExpense','getBusinessExpenses','deleteBusinessExpense',
  'updateExpense','voidExpense',
  'saveExpensePurchase','markExpenseReceived'
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
    const { description, amount, category, paidVia, referenceNo, notes, expenseDate, isPaid, qty, store, unit, unitPrice } = body;
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
      qty: qty ? String(qty).trim().substring(0,100) : null,
      store: store ? String(store).trim().substring(0,120) : null,
      unit: unit ? String(unit).trim().substring(0,40) : null,
      unit_price: (unitPrice!==undefined && unitPrice!==null && String(unitPrice).trim()!=='' && !isNaN(parseFloat(unitPrice))) ? parseFloat(unitPrice) : null,
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
    url += '&is_void=eq.false';
    url += '&select=*';
    const r = await supaFetch(url);
    if (!r.ok) return res.status(500).json({ ok:false, error:'Failed to fetch' });
    const items = r.data||[];
    const total = items.reduce(function(s,e){ return s+parseFloat(e.amount); },0);
    const byCat = {};
    items.forEach(function(e){ byCat[e.category]=(byCat[e.category]||0)+parseFloat(e.amount); });
    return res.status(200).json({ ok:true, expenses:items, total, byCat });
  }

  // ── saveExpensePurchase (multi-line, one supplier receipt) ───────────────
  if (action === 'saveExpensePurchase') {
    const a = await checkAdminAuth();
    if (!a.ok) return res.status(403).json({ ok:false, error:a.error });
    const { supplier, category, paidVia, referenceNo, expenseDate, notes, isPaid, lines } = body;
    if (!Array.isArray(lines) || !lines.length) return res.status(400).json({ ok:false, error:'At least one line item required' });
    const groupId = 'grp_' + Date.now() + '_' + Math.random().toString(36).slice(2,8);
    const date = expenseDate || new Date().toISOString().split('T')[0];
    const rows = [];
    for (const ln of lines) {
      const desc = String(ln.description||'').trim();
      const amt  = parseFloat(ln.amount);
      if (!desc)          return res.status(400).json({ ok:false, error:'Each line needs a description' });
      if (!amt || amt<=0) return res.status(400).json({ ok:false, error:'Each line needs a valid total' });
      rows.push({
        expense_group_id: groupId,
        description: desc.substring(0,300),
        amount: amt,
        category: String(category||'Other').trim(),
        paid_via: String(paidVia||'Cash').trim(),
        reference_no: referenceNo ? String(referenceNo).trim().substring(0,100) : null,
        notes: notes ? String(notes).trim().substring(0,500) : null,
        expense_date: date,
        is_paid: isPaid !== false,
        qty: (ln.qty!=null && String(ln.qty).trim()!=='') ? String(ln.qty).trim().substring(0,100) : null,
        store: supplier ? String(supplier).trim().substring(0,120) : null,
        unit: ln.unit ? String(ln.unit).trim().substring(0,40) : null,
        unit_price: (ln.unitPrice!=null && String(ln.unitPrice).trim()!=='' && !isNaN(parseFloat(ln.unitPrice))) ? parseFloat(ln.unitPrice) : null,
        added_by: a.userId||'staff', added_by_role: a.role||'',
      });
    }
    const r = await supa('POST','business_expenses', rows);
    if (!r.ok) return res.status(500).json({ ok:false, error:'Failed to save purchase' });
    return res.status(200).json({ ok:true, groupId, lines: rows.length });
  }

  // ── markExpenseReceived (explicit inventory linkage — never automatic) ────
  if (action === 'markExpenseReceived') {
    const a = await checkAdminAuth();
    if (!a.ok) return res.status(403).json({ ok:false, error:a.error });
    const id = String(body.id||'').trim();
    if (!id) return res.status(400).json({ ok:false, error:'id required' });
    const patch = { inv_received: true, inv_received_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    if (body.stockUnitId) patch.inv_stock_unit_id = parseInt(body.stockUnitId);
    const r = await supa('PATCH','business_expenses', patch, { id: `eq.${id}` });
    if (!r.ok) return res.status(500).json({ ok:false, error:'Failed to link expense to stock' });
    return res.status(200).json({ ok:true });
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

  // ── updateExpense (OWNER edit; propagates header fixes to purchase history) ─
  if (action === 'updateExpense') {
    const a = await checkAdminAuth();
    if (!a.ok) return res.status(403).json({ ok:false, error:a.error });
    if (a.role !== 'OWNER') return res.status(403).json({ ok:false, error:'OWNER only' });
    const id = String(body.id||'').trim();
    if (!id) return res.status(400).json({ ok:false, error:'id required' });
    const cur = await supaFetch(`${SUPABASE_URL}/rest/v1/business_expenses?id=eq.${id}&select=purchase_group`);
    const pg = cur.ok && cur.data && cur.data[0] ? cur.data[0].purchase_group : null;
    const patch = { updated_at: new Date().toISOString() };
    if (body.description !== undefined) patch.description = String(body.description).trim().substring(0,300);
    if (body.amount !== undefined && !isNaN(parseFloat(body.amount))) patch.amount = parseFloat(body.amount);
    if (body.category !== undefined) patch.category = String(body.category||'Other').trim();
    if (body.paidVia !== undefined) patch.paid_via = String(body.paidVia||'').trim();
    if (body.referenceNo !== undefined) patch.reference_no = body.referenceNo ? String(body.referenceNo).trim().substring(0,100) : null;
    if (body.notes !== undefined) patch.notes = body.notes ? String(body.notes).trim().substring(0,500) : null;
    if (body.expenseDate !== undefined) patch.expense_date = body.expenseDate;
    if (body.store !== undefined) patch.store = body.store ? String(body.store).trim().substring(0,120) : null;
    const r = await supa('PATCH','business_expenses', patch, { id:`eq.${id}` });
    if (!r.ok) return res.status(500).json({ ok:false, error:'Failed to update' });
    // header-only corrections carry to the immutable purchase-history rows (never prices)
    if (pg) {
      const hp = {};
      if (body.category !== undefined) hp.category = String(body.category||'Other').trim();
      if (body.referenceNo !== undefined) hp.reference_no = body.referenceNo ? String(body.referenceNo).trim() : null;
      if (body.expenseDate !== undefined) hp.purchase_date = body.expenseDate;
      if (body.store !== undefined) { hp.supplier_name = String(body.store||'').trim(); hp.store = String(body.store||'').trim(); }
      if (body.paidVia !== undefined) hp.payment_method = String(body.paidVia||'').trim();
      if (Object.keys(hp).length) { try { await supa('PATCH','inv_purchases', hp, { purchase_group:`eq.${pg}` }); } catch(_){} }
    }
    return res.status(200).json({ ok:true, purchase_group: pg||null });
  }

  // ── voidExpense (OWNER soft-void; keeps record for audit, drops from totals) ─
  if (action === 'voidExpense') {
    const a = await checkAdminAuth();
    if (!a.ok) return res.status(403).json({ ok:false, error:a.error });
    if (a.role !== 'OWNER') return res.status(403).json({ ok:false, error:'OWNER only' });
    const id = String(body.id||'').trim();
    if (!id) return res.status(400).json({ ok:false, error:'id required' });
    const cur = await supaFetch(`${SUPABASE_URL}/rest/v1/business_expenses?id=eq.${id}&select=purchase_group`);
    const pg = cur.ok && cur.data && cur.data[0] ? cur.data[0].purchase_group : null;
    const now = new Date().toISOString();
    const r = await supa('PATCH','business_expenses',
      { is_void:true, voided_at:now, voided_reason: body.reason ? String(body.reason).trim().substring(0,300) : null, updated_at:now },
      { id:`eq.${id}` });
    if (!r.ok) return res.status(500).json({ ok:false, error:'Failed to void' });
    if (pg) { try { await supa('PATCH','inv_purchases', { is_void:true, voided_at:now }, { purchase_group:`eq.${pg}` }); } catch(_){} }
    return res.status(200).json({ ok:true, voided:true, purchase_group: pg||null });
  }

  return false;
}
