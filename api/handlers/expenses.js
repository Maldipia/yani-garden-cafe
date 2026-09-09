// ── EXPENSES HANDLER (ESM) ────────────────────────────────────────────────
import { supaFetch, supa }        from '../lib/db.js';
import { SUPABASE_URL }            from '../lib/config.js';

const EXPENSE_ACTIONS = new Set([
  'addShiftExpense','getShiftExpenses',
  'addBusinessExpense','getBusinessExpenses','deleteBusinessExpense',
  'updateExpense','voidExpense','scanReceipt','aiListModels',
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
    const { description, amount, category, paidVia, referenceNo, notes, expenseDate, isPaid, qty, store, unit, unitPrice, sizePerUnit } = body;
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
      size_per_unit: (sizePerUnit!==undefined && sizePerUnit!==null && String(sizePerUnit).trim()!=='' && !isNaN(parseFloat(sizePerUnit))) ? parseFloat(sizePerUnit) : null,
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
    if (body.qty !== undefined) patch.qty = body.qty ? String(body.qty).trim().substring(0,100) : null;
    if (body.unit !== undefined) patch.unit = body.unit ? String(body.unit).trim().substring(0,40) : null;
    if (body.unitPrice !== undefined) patch.unit_price = (body.unitPrice !== null && String(body.unitPrice).trim() !== '' && !isNaN(parseFloat(body.unitPrice))) ? parseFloat(body.unitPrice) : null;
    if (body.sizePerUnit !== undefined) patch.size_per_unit = (body.sizePerUnit !== null && String(body.sizePerUnit).trim() !== '' && !isNaN(parseFloat(body.sizePerUnit))) ? parseFloat(body.sizePerUnit) : null;
    if (body.isPaid !== undefined) patch.is_paid = body.isPaid !== false;
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

  // ── aiListModels (diagnostic: what can this key actually call?) ──────────
  // Model names get retired without notice and the failure looks identical to
  // an outage. This asks Google directly instead of guessing.
  if (action === 'aiListModels') {
    const a = await checkAdminAuth();
    if (!a.ok) return res.status(403).json({ ok:false, error:a.error });
    let key = process.env.GEMINI_API_KEY;
    if (!key) {
      try {
        const cf = await supaFetch(`${SUPABASE_URL}/rest/v1/secure_config?key=eq.GEMINI_API_KEY&select=value`);
        if (cf.ok && cf.data && cf.data[0]) key = cf.data[0].value;
      } catch(_) {}
    }
    if (!key) return res.status(500).json({ ok:false, error:'GEMINI_API_KEY missing' });
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=100`);
      const j = await r.json();
      if (!r.ok) return res.status(200).json({ ok:false, status:r.status, error: j?.error?.message?.slice(0,200) });
      const models = (j.models||[])
        .filter(m => (m.supportedGenerationMethods||[]).includes('generateContent'))
        .map(m => m.name.replace('models/',''));
      return res.status(200).json({ ok:true, count: models.length, models });
    } catch (e) {
      return res.status(200).json({ ok:false, error: String(e.message).slice(0,200) });
    }
  }

  // ── scanReceipt (AI reads a receipt photo → structured data for the form) ──
  if (action === 'scanReceipt') {
    const a = await checkAdminAuth();
    if (!a.ok) return res.status(403).json({ ok:false, error:a.error });
    let key = process.env.GEMINI_API_KEY;
    if (!key) {
      try {
        const cf = await supaFetch(`${SUPABASE_URL}/rest/v1/secure_config?key=eq.GEMINI_API_KEY&select=value`);
        if (cf.ok && cf.data && cf.data[0]) key = cf.data[0].value;
      } catch(_) {}
    }
    if (!key) return res.status(500).json({ ok:false, error:'Scan not set up yet (GEMINI_API_KEY missing)' });
    const imageBase64 = String(body.imageBase64 || '');
    const mimeType = String(body.mimeType || 'image/jpeg');
    if (!imageBase64) return res.status(400).json({ ok:false, error:'image required' });
    const prompt = 'You are reading a Philippine business receipt/bill for a cafe. Return ONLY JSON (no markdown) with this exact schema:\n'
      + '{"kind":"purchase|expense","supplier":"","date":"YYYY-MM-DD","reference_no":"","payment_method":"","category":"",\n'
      + ' "lines":[{"item":"","qty":0,"unit":"pc|kg|g|L|ml|case|pk|box|btl","unit_price":0,"total":0}],"grand_total":0}\n'
      + 'Rules: kind="expense" for utility bills (water/electric/internet/rent/repair) with lines=[]; kind="purchase" for itemized goods. '
      + 'Use the actual TRANSACTION date (not any accreditation/permit date). category must be one of: '
      + 'Stocks & Groceries, Utilities, Electricity, Water, Internet / Cable, Gas / Fuel, Rent, Equipment Repair, Packaging, Cleaning / Supplies, Office / Admin, Marketing, Transport / Delivery, Other. '
      + 'unit_price is per single unit; total is the line amount. Numbers only for numeric fields.';
    const gBody = {
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: imageBase64 } }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json' },
    };
    // Each attempt is bounded. Previously three vision calls ran back to back
    // with no timeout, so one slow upstream response blew the whole serverless
    // function limit and the user saw FUNCTION_INVOCATION_TIMEOUT rather than
    // a useful error.
    // Google retires model names; 2.5-flash and 2.0-flash both now return 404
    // pointing at gemini-3.6-flash. -latest is kept as a moving fallback.
    // gemini-3.6 (no suffix) is not a generateContent model — dropped.
    // Vision inference on a receipt regularly needs more than 12s, which is why
    // both valid models were being aborted before they could answer.
    const MODELS = ['gemini-flash-latest', 'gemini-3.6-flash'];
    const PER_CALL_MS = 22000;            // function limit is 60s (vercel.json)
    const started = Date.now();
    const BUDGET_MS = 46000;              // must leave room for a full call + response
    const diag = [];

    // 503/429 from Google is transient overload, so each model gets one retry
    // with a short backoff before moving on.
    // Interleaved: try each model once, then retry each. A model that is busy
    // now may be free in two seconds, and the alternate model may answer first.
    const attempts = [];
    for (const m of MODELS) attempts.push([m, 0]);
    for (const m of MODELS) attempts.push([m, 1]);

    for (const [model, retry] of attempts) {
      // Budget must account for the call ABOUT to run, not just elapsed time —
      // checking only elapsed allowed a 24s call to start at 40s and blow the
      // 60s function limit, which is exactly what happened in testing.
      if (Date.now() - started + PER_CALL_MS > BUDGET_MS) { diag.push('budget exhausted'); break; }
      if (retry) await new Promise(r => setTimeout(r, 1200));
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), PER_CALL_MS);
      try {
        const gr = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
          { method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify(gBody), signal: ac.signal });
        clearTimeout(timer);
        if (gr.status === 503 || gr.status === 429) {
          diag.push(`${model}:${gr.status} busy${retry ? ' (retry)' : ''}`);
          continue;                       // transient — the retry pass will try again
        }
        if (!gr.ok) {
          let detail = '';
          try { const e = await gr.json(); detail = e?.error?.message?.slice(0,120) || ''; } catch(_) {}
          diag.push(`${model}:${gr.status} ${detail}`);
          if (gr.status === 404 || gr.status === 400 || gr.status === 403) {
            // permanent for this model — skip its retry slot too
            const idx = attempts.findIndex(([m, r]) => m === model && r === 1);
            if (idx >= 0) attempts.splice(idx, 1);
          }
          continue;
        }
        const gj = await gr.json();
        const txt = gj?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!txt) { diag.push(`${model}: empty response`); continue; }
        let data; try { data = JSON.parse(txt); } catch(_) { diag.push(`${model}: unparseable JSON`); continue; }
        return res.status(200).json({ ok:true, extracted: data, model });
      } catch (e) {
        clearTimeout(timer);
        diag.push(`${model}: ${e.name === 'AbortError' ? ('timed out after ' + (PER_CALL_MS/1000) + 's') : (e.message||'failed').slice(0,80)}`);
      }
    }
    // Surface WHY, so a bad key or a retired model name is diagnosable instead
    // of being reported as a generic failure.
    return res.status(502).json({ ok:false,
      error:'Could not read the receipt — enter it manually.',
      detail: diag.join(' | ').slice(0, 400) });
  }

  return false;
}
