// ══════════════════════════════════════════════════════════
// MENU COSTING VIEW (OWNER only)
// ══════════════════════════════════════════════════════════
var _costingTab = 'dashboard';
var _costingIngredients = [];
var _costingRecipes = [];
var _activeRecipeId = null;

function _getSB() {
  if (!_supabaseClient) initRealtime();
  return _supabaseClient;
}


async function loadCostingView() {
  var view = document.getElementById('costingView');
  if (!view) return;
  view.innerHTML = '<div style="padding:24px;text-align:center;color:var(--timber)">Loading costing data...</div>';
  // Wait for supabase client if not ready yet
  if (!_supabaseClient) {
    initRealtime();
    await new Promise(function(r){ setTimeout(r, 800); });
  }
  if (!_supabaseClient) {
    view.innerHTML = '<div style="padding:24px;color:var(--terra)">⚠️ Database not connected. Please refresh the page and try again.</div>';
    return;
  }
  try {
    var sb = _getSB();
    var [ingRes, recRes, riRes] = await Promise.all([
      sb.from('costing_ingredients').select('*').order('category').order('name'),
      sb.from('costing_recipes').select('*').order('category').order('name'),
      sb.from('costing_recipe_ingredients').select('*')
    ]);
    _costingIngredients = ingRes.data || [];
    _costingRecipes = (recRes.data || []).map(function(r) {
      r.ingredients = (riRes.data || []).filter(function(ri) { return ri.recipe_id === r.id; });
      return r;
    });
  } catch(e) {
    view.innerHTML = '<div style="padding:24px;color:var(--terra)">Error loading costing data: ' + e.message + '</div>';
    return;
  }
  renderCostingShell();
}

function recipeTotalCost(r) {
  return (r.ingredients || []).reduce(function(s, ri) {
    var ing = _costingIngredients.find(function(i) { return i.id === ri.ingredient_id; });
    return s + (ing ? Number(ing.cost_per_unit) * Number(ri.qty) : 0);
  }, 0);
}

function fcPct(cost, price) {
  if (!price || price === 0) return null;
  return cost / price * 100;
}

function fcPill(pct) {
  if (pct === null) return '<span style="font-size:.72rem;color:var(--timber)">—</span>';
  var color = pct < 28 ? '#15803d' : pct < 35 ? '#0f766e' : pct < 40 ? '#b45309' : '#dc2626';
  var bg    = pct < 28 ? '#dcfce7' : pct < 35 ? '#ccfbf1' : pct < 40 ? '#fef3c7' : '#fee2e2';
  return '<span style="background:' + bg + ';color:' + color + ';padding:2px 8px;border-radius:20px;font-size:.7rem;font-weight:700;font-family:var(--font-body)">' + pct.toFixed(1) + '%</span>';
}

function fcStatus(pct) {
  if (pct === null) return '—';
  if (pct < 28) return '✅ Excellent';
  if (pct < 35) return '🟢 Good';
  if (pct < 40) return '🟡 Review';
  return '🔴 Critical';
}

function phpFmt(n) {
  return '₱' + Number(n).toLocaleString('en-PH', {minimumFractionDigits:2, maximumFractionDigits:2});
}

function renderCostingShell() {
  var view = document.getElementById('costingView');
  var costed = _costingRecipes.filter(function(r) { return recipeTotalCost(r) > 0; });
  var avgFC = costed.length ? costed.reduce(function(s,r){return s+fcPct(recipeTotalCost(r),r.selling_price);},0)/costed.length : null;
  var critical = costed.filter(function(r){return fcPct(recipeTotalCost(r),r.selling_price)>=40;}).length;
  var avgProfit = costed.length ? costed.reduce(function(s,r){return s+(r.selling_price-recipeTotalCost(r));},0)/costed.length : null;

  var fcColor = avgFC===null?'var(--timber)':avgFC<28?'#15803d':avgFC<35?'#0f766e':avgFC<40?'#b45309':'#dc2626';

  var tabs = ['dashboard','inventory','recipe','pricing'];
  var tabLabels = {'dashboard':'📊 Dashboard','inventory':'🥛 Ingredients','recipe':'📋 Recipe Costing','pricing':'💰 Menu Pricing'};

  var html = '<div style="padding:16px 16px 0">';
  // Header
  html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px">';
  html += '<div><div style="font-family:var(--font-soul);font-size:1.3rem;font-weight:700;color:var(--forest-deep)">🧮 Menu Costing</div>';
  html += '<div style="font-size:.72rem;color:var(--timber);margin-top:2px">Food cost analysis • Ingredient costing • Margin tracking</div></div>';
  html += '</div>';
  // Metric cards
  html += '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px">';
  html += '<div style="background:var(--white);border-radius:var(--r-md);padding:12px 14px;box-shadow:var(--shadow-sm)">';
  html += '<div style="font-size:.65rem;color:var(--timber);font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Menu Items</div>';
  html += '<div style="font-family:var(--font-soul);font-size:1.5rem;font-weight:700;color:var(--forest)">' + _costingRecipes.length + '</div></div>';
  html += '<div style="background:var(--white);border-radius:var(--r-md);padding:12px 14px;box-shadow:var(--shadow-sm)">';
  html += '<div style="font-size:.65rem;color:var(--timber);font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Avg Food Cost</div>';
  html += '<div style="font-family:var(--font-soul);font-size:1.5rem;font-weight:700;color:' + fcColor + '">' + (avgFC !== null ? avgFC.toFixed(1) + '%' : '—') + '</div></div>';
  html += '<div style="background:var(--white);border-radius:var(--r-md);padding:12px 14px;box-shadow:var(--shadow-sm)">';
  html += '<div style="font-size:.65rem;color:var(--timber);font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Avg Gross Profit</div>';
  html += '<div style="font-family:var(--font-soul);font-size:1.5rem;font-weight:700;color:var(--forest)">' + (avgProfit !== null ? phpFmt(avgProfit) : '—') + '</div></div>';
  html += '<div style="background:var(--white);border-radius:var(--r-md);padding:12px 14px;box-shadow:var(--shadow-sm)">';
  html += '<div style="font-size:.65rem;color:var(--timber);font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Critical Items</div>';
  html += '<div style="font-family:var(--font-soul);font-size:1.5rem;font-weight:700;color:' + (critical > 0 ? '#dc2626' : '#15803d') + '">' + (costed.length ? critical : '—') + '</div></div>';
  html += '</div>';
  // Sub-tabs
  html += '<div style="display:flex;gap:2px;border-bottom:2px solid var(--mist);margin-bottom:0">';
  tabs.forEach(function(t) {
    var active = _costingTab === t;
    html += '<button onclick="setCostingTab(\'' + t + '\')" style="padding:9px 14px;font-size:.75rem;font-weight:700;font-family:var(--font-body);border:none;cursor:pointer;background:transparent;color:' + (active?'var(--forest)':'var(--timber)') + ';border-bottom:2px solid ' + (active?'var(--forest)':'transparent') + ';margin-bottom:-2px;white-space:nowrap">' + tabLabels[t] + '</button>';
  });
  html += '</div></div>';
  // Panel area
  html += '<div id="costing-panel" style="padding:16px"></div>';
  view.innerHTML = html;
  renderCostingPanel();
}

function setCostingTab(t) {
  _costingTab = t;
  _activeRecipeId = null;
  renderCostingShell();
}

function renderCostingPanel() {
  var panel = document.getElementById('costing-panel');
  if (!panel) return;
  if (_costingTab === 'dashboard') renderCostingDashboard(panel);
  else if (_costingTab === 'inventory') renderCostingInventory(panel);
  else if (_costingTab === 'recipe') renderCostingRecipe(panel);
  else if (_costingTab === 'pricing') renderCostingPricing(panel);
}

function costingCard(content) {
  return '<div style="background:var(--white);border-radius:var(--r-lg);box-shadow:var(--shadow-sm);padding:16px;margin-bottom:14px">' + content + '</div>';
}

function costingSectionTitle(t) {
  return '<div style="font-size:.65rem;font-weight:700;color:var(--timber);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">' + t + '</div>';
}

function renderCostingDashboard(panel) {
  var costed = _costingRecipes.filter(function(r) { return recipeTotalCost(r) > 0; });
  if (!costed.length) { panel.innerHTML = '<div style="padding:2rem;text-align:center;color:var(--timber)">No recipes costed yet. Go to Recipe Costing tab to add ingredients.</div>'; return; }

  var sorted = costed.slice().sort(function(a,b) { return fcPct(recipeTotalCost(a),a.selling_price)-fcPct(recipeTotalCost(b),b.selling_price); });
  var best = sorted.slice(0,5);
  var worst = sorted.slice(-5).reverse();

  var html = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">';
  // Best margin
  html += '<div>' + costingCard(costingSectionTitle('Best margin items') + best.map(function(r) {
    var pct = fcPct(recipeTotalCost(r),r.selling_price);
    var barW = Math.min(100, 100 - pct);
    return '<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--mist-light)">'
      + '<div><div style="font-size:.78rem;font-weight:600;color:var(--forest-deep)">' + r.name + '</div>'
      + '<div style="background:var(--mist);border-radius:4px;height:5px;width:120px;margin-top:3px;overflow:hidden"><div style="height:100%;background:#15803d;width:' + barW + '%"></div></div></div>'
      + fcPill(pct) + '</div>';
  }).join('')) + '</div>';

  // Highest FC
  html += '<div>' + costingCard(costingSectionTitle('Highest food cost — review pricing') + worst.map(function(r) {
    var pct = fcPct(recipeTotalCost(r),r.selling_price);
    var barColor = pct >= 40 ? '#dc2626' : pct >= 35 ? '#b45309' : '#0f766e';
    var barW = Math.min(100, pct * 2);
    return '<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--mist-light)">'
      + '<div><div style="font-size:.78rem;font-weight:600;color:var(--forest-deep)">' + r.name + '</div>'
      + '<div style="background:var(--mist);border-radius:4px;height:5px;width:120px;margin-top:3px;overflow:hidden"><div style="height:100%;background:' + barColor + ';width:' + barW + '%"></div></div></div>'
      + fcPill(pct) + '</div>';
  }).join('')) + '</div>';

  html += '</div>';

  // All items table
  html += costingCard(costingSectionTitle('All costed items')
    + '<div style="overflow-x:auto;max-height:440px;overflow-y:auto"><table style="width:100%;border-collapse:collapse;font-size:.78rem">'
    + '<thead><tr style="border-bottom:2px solid var(--mist)">'
    + '<th style="text-align:left;padding:6px 8px;color:var(--timber);font-weight:600;position:sticky;top:0;z-index:2;background:var(--white)">Item</th>'
    + '<th style="text-align:left;padding:6px 8px;color:var(--timber);font-weight:600;position:sticky;top:0;z-index:2;background:var(--white)">Category</th>'
    + '<th style="text-align:right;padding:6px 8px;color:var(--timber);font-weight:600;position:sticky;top:0;z-index:2;background:var(--white)">Cost</th>'
    + '<th style="text-align:right;padding:6px 8px;color:var(--timber);font-weight:600;position:sticky;top:0;z-index:2;background:var(--white)">Price</th>'
    + '<th style="text-align:center;padding:6px 8px;color:var(--timber);font-weight:600;position:sticky;top:0;z-index:2;background:var(--white)">FC%</th>'
    + '<th style="text-align:right;padding:6px 8px;color:var(--timber);font-weight:600;position:sticky;top:0;z-index:2;background:var(--white)">Profit</th>'
    + '</tr></thead><tbody>'
    + costed.map(function(r) {
        var cost = recipeTotalCost(r);
        var pct = fcPct(cost, r.selling_price);
        var profit = r.selling_price - cost;
        return '<tr style="border-bottom:1px solid var(--mist-light)">'
          + '<td style="padding:7px 8px;font-weight:600;color:var(--forest-deep)">' + r.name + '</td>'
          + '<td style="padding:7px 8px"><span style="font-size:.65rem;color:var(--timber);text-transform:uppercase">' + r.category + '</span></td>'
          + '<td style="padding:7px 8px;text-align:right;font-family:monospace">' + phpFmt(cost) + '</td>'
          + '<td style="padding:7px 8px;text-align:right;font-family:monospace">' + phpFmt(r.selling_price) + '</td>'
          + '<td style="padding:7px 8px;text-align:center">' + fcPill(pct) + '</td>'
          + '<td style="padding:7px 8px;text-align:right;font-family:monospace;color:' + (profit >= 0 ? '#15803d' : '#dc2626') + '">' + phpFmt(profit) + '</td>'
          + '</tr>';
      }).join('')
    + '</tbody></table></div>');

  panel.innerHTML = html;
}

function renderCostingInventory(panel) {
  var catGroups = {};
  _costingIngredients.forEach(function(i) {
    var c = i.category || 'Other';
    if (!catGroups[c]) catGroups[c] = [];
    catGroups[c].push(i);
  });

  var html = '<div style="display:flex;justify-content:flex-end;margin-bottom:12px">'
    + '<button onclick="openCostingIngModal()" style="padding:8px 16px;background:var(--forest);color:var(--white);border:none;border-radius:var(--r-md);font-size:.78rem;font-weight:700;font-family:var(--font-body);cursor:pointer">+ Add ingredient</button>'
    + '</div>';

  Object.keys(catGroups).sort().forEach(function(cat) {
    var isCoffee = cat === 'Coffee';
    var thead = '<thead><tr>'
      + '<th style="text-align:left;padding:5px 8px;color:var(--timber);font-weight:600;position:sticky;top:0;z-index:2;background:var(--mist-light)">Ingredient</th>'
      + '<th style="text-align:center;padding:5px 8px;color:var(--timber);font-weight:600;position:sticky;top:0;z-index:2;background:var(--mist-light)">Unit</th>'
      + '<th style="text-align:right;padding:5px 8px;color:var(--timber);font-weight:600;position:sticky;top:0;z-index:2;background:var(--mist-light)">Cost / g</th>'
      + (isCoffee ? '<th style="text-align:right;padding:5px 8px;color:var(--terra);font-weight:600;position:sticky;top:0;z-index:2;background:var(--mist-light)">1 shot (9g)</th><th style="text-align:right;padding:5px 8px;color:var(--forest);font-weight:600;position:sticky;top:0;z-index:2;background:var(--mist-light)">2 shots (18g)</th>' : '')
      + '<th style="text-align:right;padding:5px 8px;position:sticky;top:0;z-index:2;background:var(--mist-light)"></th></tr></thead>';

    html += costingCard(costingSectionTitle(cat)
      + '<div style="overflow-x:auto;max-height:360px;overflow-y:auto"><table style="width:100%;border-collapse:collapse;font-size:.78rem">'
      + thead + '<tbody>'
      + catGroups[cat].map(function(i) {
          var shot1 = (Number(i.cost_per_unit) * 9).toFixed(2);
          var shot2 = (Number(i.cost_per_unit) * 18).toFixed(2);
          return '<tr style="border-top:1px solid var(--mist-light)">'
            + '<td style="padding:7px 8px;font-weight:600;color:var(--forest-deep)">' + i.name + '</td>'
            + '<td style="padding:7px 8px;text-align:center;color:var(--timber)">' + i.unit + '</td>'
            + '<td style="padding:7px 8px;text-align:right;font-family:monospace">' + phpFmt(i.cost_per_unit) + ' / ' + i.unit + '</td>'
            + (isCoffee
              ? '<td style="padding:7px 8px;text-align:right;font-family:monospace;color:var(--terra);font-weight:600">₱' + shot1 + '</td>'
              + '<td style="padding:7px 8px;text-align:right;font-family:monospace;color:var(--forest);font-weight:700">₱' + shot2 + '</td>'
              : '')
            + '<td style="padding:7px 8px;text-align:right;white-space:nowrap">'
            + '<button onclick="openCostingIngModal(' + i.id + ')" style="padding:3px 10px;font-size:.68rem;font-weight:700;font-family:var(--font-body);border:1.5px solid var(--mist);background:transparent;border-radius:var(--r-sm);cursor:pointer;color:var(--timber);margin-right:4px">Edit</button>'
            + '<button onclick="deleteCostingIng(' + i.id + ')" style="padding:3px 10px;font-size:.68rem;font-weight:700;font-family:var(--font-body);border:1.5px solid #fca5a5;background:transparent;border-radius:var(--r-sm);cursor:pointer;color:#dc2626">Remove</button>'
            + '</td></tr>';
        }).join('')
      + '</tbody></table></div>');
  });

  if (!_costingIngredients.length) html += '<div style="padding:2rem;text-align:center;color:var(--timber)">No ingredients yet. Add your first one.</div>';

  // Inline add/edit modal
  html += '<div id="costing-ing-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:500;align-items:center;justify-content:center">'
    + '<div style="background:var(--white);border-radius:var(--r-xl);padding:24px;width:340px;max-width:90vw;box-shadow:var(--shadow-md)">'
    + '<div id="costing-ing-modal-title" style="font-family:var(--font-soul);font-size:1.1rem;font-weight:700;color:var(--forest-deep);margin-bottom:16px">Add ingredient</div>'
    + '<input type="hidden" id="cing-id">'
    + '<div style="margin-bottom:12px"><label style="font-size:.72rem;font-weight:700;color:var(--timber);display:block;margin-bottom:4px">Ingredient name</label>'
    + '<input id="cing-name" placeholder="e.g. Espresso beans" style="width:100%;padding:9px 12px;border:1.5px solid var(--mist);border-radius:var(--r-md);font-size:.85rem;font-family:var(--font-body);outline:none"></div>'
    + '<div style="margin-bottom:12px"><label style="font-size:.72rem;font-weight:700;color:var(--timber);display:block;margin-bottom:4px">Unit</label>'
    + '<select id="cing-unit" style="width:100%;padding:9px 12px;border:1.5px solid var(--mist);border-radius:var(--r-md);font-size:.85rem;font-family:var(--font-body)">'
    + ['g','ml','pc','kg','L','tsp','tbsp','cup','sachet','pack'].map(function(u){return'<option>'+u+'</option>';}).join('')
    + '</select></div>'
    + '<div style="margin-bottom:12px"><label style="font-size:.72rem;font-weight:700;color:var(--timber);display:block;margin-bottom:4px">Cost per unit (₱)</label>'
    + '<input id="cing-cost" type="number" step="0.001" placeholder="0.00" style="width:100%;padding:9px 12px;border:1.5px solid var(--mist);border-radius:var(--r-md);font-size:.85rem;font-family:var(--font-body);outline:none"></div>'
    + '<div style="margin-bottom:16px"><label style="font-size:.72rem;font-weight:700;color:var(--timber);display:block;margin-bottom:4px">Category</label>'
    + '<select id="cing-cat" style="width:100%;padding:9px 12px;border:1.5px solid var(--mist);border-radius:var(--r-md);font-size:.85rem;font-family:var(--font-body)">'
    + ['Coffee','Dairy','Syrups & Powder','Bread & Pastry','Packaging','Other'].map(function(c){return'<option>'+c+'</option>';}).join('')
    + '</select></div>'
    + '<div style="display:flex;gap:10px;justify-content:flex-end">'
    + '<button onclick="closeCostingIngModal()" style="padding:9px 18px;border:1.5px solid var(--mist);background:transparent;border-radius:var(--r-md);font-size:.78rem;font-weight:700;font-family:var(--font-body);cursor:pointer;color:var(--timber)">Cancel</button>'
    + '<button onclick="saveCostingIng()" style="padding:9px 18px;background:var(--forest);color:var(--white);border:none;border-radius:var(--r-md);font-size:.78rem;font-weight:700;font-family:var(--font-body);cursor:pointer">Save</button>'
    + '</div></div></div>';

  panel.innerHTML = html;
}

function openCostingIngModal(id) {
  var modal = document.getElementById('costing-ing-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  if (id) {
    var ing = _costingIngredients.find(function(i){return i.id===id;});
    if (ing) {
      document.getElementById('costing-ing-modal-title').textContent = 'Edit ingredient';
      document.getElementById('cing-id').value = id;
      document.getElementById('cing-name').value = ing.name;
      document.getElementById('cing-unit').value = ing.unit;
      document.getElementById('cing-cost').value = ing.cost_per_unit;
      document.getElementById('cing-cat').value = ing.category || 'Other';
    }
  } else {
    document.getElementById('costing-ing-modal-title').textContent = 'Add ingredient';
    document.getElementById('cing-id').value = '';
    document.getElementById('cing-name').value = '';
    document.getElementById('cing-cost').value = '';
  }
}

function closeCostingIngModal() {
  var modal = document.getElementById('costing-ing-modal');
  if (modal) modal.style.display = 'none';
}

async function saveCostingIng() {
  var id = document.getElementById('cing-id').value;
  var payload = {
    name: document.getElementById('cing-name').value.trim(),
    unit: document.getElementById('cing-unit').value,
    cost_per_unit: parseFloat(document.getElementById('cing-cost').value),
    category: document.getElementById('cing-cat').value
  };
  if (!payload.name || isNaN(payload.cost_per_unit)) { showToast('Name and cost required'); return; }
  var sb = _getSB();
  if (id) {
    await sb.from('costing_ingredients').update(payload).eq('id', parseInt(id));
  } else {
    await sb.from('costing_ingredients').insert(payload);
  }
  closeCostingIngModal();
  await loadCostingView();
  setCostingTab('inventory');
}

async function deleteCostingIng(id) {
  if (!confirm('Remove this ingredient? It will be removed from all recipes.')) return;
  await _getSB().from('costing_ingredients').delete().eq('id', id);
  await loadCostingView();
  setCostingTab('inventory');
}

var _costingCatFilter = 'ALL';

function getCostingCatStyle(cat) {
  var map = {
    'HOT':         {bg:'#fef3c7',color:'#92400e'},
    'ICE BLENDED': {bg:'#dbeafe',color:'#1e40af'},
    'COLD':        {bg:'#e0f2fe',color:'#0369a1'},
    'PASTRY':      {bg:'#fce7f3',color:'#9d174d'},
    'PASTA':       {bg:'#fef9c3',color:'#854d0e'},
    'MEAL':        {bg:'#d1fae5',color:'#065f46'},
    'BEST WITH':   {bg:'#ede9fe',color:'#5b21b6'},
    'OTHER':       {bg:'#f1f5f9',color:'#475569'},
  };
  return map[cat] || {bg:'#f1f5f9',color:'#475569'};
}

function renderCostingRecipe(panel) {
  var allCats = ['ALL'];
  _costingRecipes.forEach(function(r) { if (r.category && allCats.indexOf(r.category) < 0) allCats.push(r.category); });
  var catOrder = ['ALL','HOT','ICE BLENDED','COLD','PASTRY','PASTA','MEAL','BEST WITH','OTHER'];
  allCats.sort(function(a,b){ var ai=catOrder.indexOf(a),bi=catOrder.indexOf(b); return (ai<0?99:ai)-(bi<0?99:bi); });

  var filtered = _costingCatFilter === 'ALL' ? _costingRecipes : _costingRecipes.filter(function(r){return r.category===_costingCatFilter;});

  // Category filter chips
  var chipsHtml = '<div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:10px">';
  allCats.forEach(function(c) {
    var active = _costingCatFilter === c;
    var st = c === 'ALL' ? {bg:'var(--forest)',color:'var(--white)'} : getCostingCatStyle(c);
    chipsHtml += '<button onclick="setCostingRecCat(\'' + c + '\')" style="padding:3px 10px;font-size:.62rem;font-weight:700;font-family:var(--font-body);border:1.5px solid ' + (active?(c==='ALL'?'var(--forest)':st.color):'var(--mist)') + ';background:' + (active?(c==='ALL'?'var(--forest)':st.bg):'transparent') + ';color:' + (active?(c==='ALL'?'var(--white)':st.color):'var(--timber)') + ';border-radius:20px;cursor:pointer;white-space:nowrap">' + (c==='ALL'?'All ('+_costingRecipes.length+')':c+' ('+_costingRecipes.filter(function(r){return r.category===c;}).length+')') + '</button>';
  });
  chipsHtml += '</div>';

  var listHtml = filtered.map(function(r) {
    var cost = recipeTotalCost(r);
    var pct = fcPct(cost, r.selling_price);
    var active = _activeRecipeId === r.id;
    var st = getCostingCatStyle(r.category);
    return '<div onclick="selectCostingRecipe(' + r.id + ')" style="cursor:pointer;padding:9px 11px;border-radius:var(--r-md);border:1.5px solid ' + (active?'var(--forest)':'var(--mist)') + ';background:' + (active?'#f0fdf4':'var(--white)') + ';margin-bottom:6px;transition:all .15s">'
      + '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:4px">'
      + '<div style="font-size:.75rem;font-weight:700;color:var(--forest-deep);line-height:1.3">' + r.name + '</div>'
      + '<span style="background:' + st.bg + ';color:' + st.color + ';font-size:.55rem;font-weight:700;padding:1px 6px;border-radius:20px;white-space:nowrap;flex-shrink:0">' + r.category + '</span>'
      + '</div>'
      + '<div style="font-size:.65rem;color:' + (cost>0?(pct>=40?'#dc2626':pct>=35?'#b45309':'var(--timber)'):'var(--timber)') + ';margin-top:2px">'
      + (cost > 0 ? phpFmt(cost) + ' cost · ' + (pct ? pct.toFixed(1) + '% FC' : '') : '<span style="color:var(--mist-light)">— no recipe yet</span>')
      + '</div></div>';
  }).join('') || '<div style="color:var(--timber);font-size:.78rem;padding:8px 0">No items in this category</div>';

  var editorHtml = '';
  if (_activeRecipeId) {
    var rec = _costingRecipes.find(function(r){return r.id===_activeRecipeId;});
    if (rec) {
      var cost = recipeTotalCost(rec);
      var pct = fcPct(cost, rec.selling_price);
      var profit = rec.selling_price - cost;
      var suggestedPrice = cost > 0 ? Math.ceil(cost / 0.30 / 5) * 5 : null;

      var ingRows = (rec.ingredients || []).map(function(ri, idx) {
        var ing = _costingIngredients.find(function(i){return i.id===ri.ingredient_id;});
        var rowCost = ing ? Number(ing.cost_per_unit) * Number(ri.qty) : 0;
        var opts = _costingIngredients.map(function(i){return '<option value="'+i.id+'"'+(i.id===ri.ingredient_id?' selected':'')+'>'+i.name+' (₱'+i.cost_per_unit+'/'+i.unit+')</option>';}).join('');
        return '<div style="display:grid;grid-template-columns:1fr 80px 90px auto;gap:8px;align-items:center;margin-bottom:8px">'
          + '<select onchange="updateRecipeIng('+rec.id+','+idx+',\'iid\',this.value)" style="padding:6px 8px;font-size:.72rem;border:1.5px solid var(--mist);border-radius:var(--r-sm);font-family:var(--font-body);background:var(--white)">' + opts + '</select>'
          + '<input type="number" step="0.1" value="'+ri.qty+'" onchange="updateRecipeIng('+rec.id+','+idx+',\'qty\',this.value)" oninput="updateRecipeIng('+rec.id+','+idx+',\'qty\',this.value)" style="padding:6px 8px;font-size:.72rem;border:1.5px solid var(--mist);border-radius:var(--r-sm);text-align:right;width:100%">'
          + '<div style="font-size:.68rem;color:var(--timber);text-align:right;padding:0 4px">'+(ing?'= '+phpFmt(rowCost):'')+'</div>'
          + '<button onclick="removeRecipeIng('+rec.id+','+idx+')" style="padding:4px 8px;border:1.5px solid #fca5a5;background:transparent;border-radius:var(--r-sm);font-size:.7rem;cursor:pointer;color:#dc2626;font-family:var(--font-body)">×</button>'
          + '</div>';
      }).join('');

      editorHtml = '<div style="background:var(--white);border-radius:var(--r-lg);box-shadow:var(--shadow-sm);padding:16px">'
        + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px">'
        + '<div style="font-family:var(--font-soul);font-size:1.05rem;font-weight:700;color:var(--forest-deep)">' + rec.name + '</div>'
        + '<div style="display:flex;gap:6px"><button onclick="openCostingRecModal('+rec.id+')" style="padding:5px 12px;border:1.5px solid var(--mist);background:transparent;border-radius:var(--r-sm);font-size:.7rem;font-weight:700;font-family:var(--font-body);cursor:pointer;color:var(--timber)">Edit</button>'
        + '<button onclick="deleteCostingRec('+rec.id+')" style="padding:5px 12px;border:1.5px solid #fca5a5;background:transparent;border-radius:var(--r-sm);font-size:.7rem;font-weight:700;font-family:var(--font-body);cursor:pointer;color:#dc2626">Delete</button></div>'
        + '</div>'
        + '<div style="font-size:.72rem;color:var(--timber);margin-bottom:12px">Selling price: <strong style="color:var(--forest-deep)">' + phpFmt(rec.selling_price) + '</strong></div>'
        + '<div style="font-size:.65rem;font-weight:700;color:var(--timber);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Ingredients</div>'
        + '<div style="font-size:.65rem;color:var(--timber);display:grid;grid-template-columns:1fr 80px 90px auto;gap:8px;margin-bottom:6px;padding:0 4px">'
        + '<span>Ingredient</span><span style="text-align:right">Qty</span><span style="text-align:right">Line cost</span><span></span></div>'
        + ingRows
        + '<button onclick="addRecipeIng('+rec.id+')" style="margin-top:4px;padding:6px 14px;border:1.5px dashed var(--mist);background:transparent;border-radius:var(--r-sm);font-size:.72rem;font-weight:600;font-family:var(--font-body);cursor:pointer;color:var(--timber)">+ Add ingredient</button>'
        + '<div style="background:var(--mist-light);border-radius:var(--r-md);padding:12px 14px;margin-top:14px">'
        + '<div style="display:flex;justify-content:space-between;font-size:.78rem;padding:4px 0;border-bottom:1px solid var(--mist)"><span style="color:var(--timber)">Total recipe cost</span><span style="font-family:monospace;font-weight:700">' + phpFmt(cost) + '</span></div>'
        + '<div style="display:flex;justify-content:space-between;font-size:.78rem;padding:4px 0;border-bottom:1px solid var(--mist)"><span style="color:var(--timber)">Selling price</span><span style="font-family:monospace;font-weight:700">' + phpFmt(rec.selling_price) + '</span></div>'
        + '<div style="display:flex;justify-content:space-between;font-size:.82rem;padding:8px 0 4px;font-weight:700"><span>Food cost %</span>' + fcPill(pct) + '</div>'
        + '<div style="display:flex;justify-content:space-between;font-size:.78rem;padding:4px 0"><span style="color:var(--timber)">Gross profit</span><span style="font-family:monospace;font-weight:700;color:' + (profit>=0?'#15803d':'#dc2626') + '">' + phpFmt(profit) + '</span></div>'
        + '<div style="display:flex;justify-content:space-between;font-size:.72rem;padding:4px 0;border-top:1px solid var(--mist);margin-top:4px"><span style="color:var(--timber)">Suggested price (30% FC target)</span><span style="font-family:monospace;color:var(--terra);font-weight:700">' + (suggestedPrice ? phpFmt(suggestedPrice) : '—') + '</span></div>'
        + '</div></div>';
    }
  } else {
    editorHtml = '<div style="padding:3rem;text-align:center;color:var(--timber);font-size:.82rem;background:var(--white);border-radius:var(--r-lg);box-shadow:var(--shadow-sm)">Select a menu item to edit its recipe</div>';
  }

  panel.innerHTML = '<div style="display:grid;grid-template-columns:260px 1fr;gap:14px">'
    + '<div>'
    + '<div style="font-size:.65rem;font-weight:700;color:var(--timber);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Menu Items</div>'
    + chipsHtml
    + listHtml
    + '<button onclick="openCostingRecModal()" style="width:100%;margin-top:8px;padding:8px;border:1.5px dashed var(--mist);background:transparent;border-radius:var(--r-md);font-size:.72rem;font-weight:700;font-family:var(--font-body);cursor:pointer;color:var(--timber)">+ Add menu item</button>'
    + '</div>'
    + '<div>' + editorHtml + '</div></div>'
    + renderCostingRecModal();
}

function setCostingRecCat(cat) {
  _costingCatFilter = cat;
  _activeRecipeId = null;
  var panel = document.getElementById('costing-panel');
  if (panel) renderCostingRecipe(panel);
}

function renderCostingRecModal() {
  return '<div id="costing-rec-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:500;align-items:center;justify-content:center">'
    + '<div style="background:var(--white);border-radius:var(--r-xl);padding:24px;width:340px;max-width:90vw;box-shadow:var(--shadow-md)">'
    + '<div id="crm-title" style="font-family:var(--font-soul);font-size:1.1rem;font-weight:700;color:var(--forest-deep);margin-bottom:16px">Add menu item</div>'
    + '<input type="hidden" id="crm-id">'
    + '<div style="margin-bottom:12px"><label style="font-size:.72rem;font-weight:700;color:var(--timber);display:block;margin-bottom:4px">Item name</label>'
    + '<input id="crm-name" placeholder="e.g. Hot Americano" style="width:100%;padding:9px 12px;border:1.5px solid var(--mist);border-radius:var(--r-md);font-size:.85rem;font-family:var(--font-body);outline:none"></div>'
    + '<div style="margin-bottom:12px"><label style="font-size:.72rem;font-weight:700;color:var(--timber);display:block;margin-bottom:4px">Category</label>'
    + '<select id="crm-cat" style="width:100%;padding:9px 12px;border:1.5px solid var(--mist);border-radius:var(--r-md);font-size:.85rem;font-family:var(--font-body)">'
    + '<option value="HOT">HOT</option>'
    + '<option value="ICE BLENDED">ICE BLENDED</option>'
    + '<option value="COLD">COLD</option>'
    + '<option value="PASTRY">PASTRY</option>'
    + '<option value="PASTA">PASTA</option>'
    + '<option value="MEAL">MEAL</option>'
    + '<option value="BEST WITH">BEST WITH</option>'
    + '<option value="OTHER">OTHER</option>'
    + '</select></div>'
    + '<div style="margin-bottom:16px"><label style="font-size:.72rem;font-weight:700;color:var(--timber);display:block;margin-bottom:4px">Selling price (₱)</label>'
    + '<input id="crm-price" type="number" step="0.01" placeholder="0.00" style="width:100%;padding:9px 12px;border:1.5px solid var(--mist);border-radius:var(--r-md);font-size:.85rem;font-family:var(--font-body);outline:none"></div>'
    + '<div style="display:flex;gap:10px;justify-content:flex-end">'
    + '<button onclick="closeCostingRecModal()" style="padding:9px 18px;border:1.5px solid var(--mist);background:transparent;border-radius:var(--r-md);font-size:.78rem;font-weight:700;font-family:var(--font-body);cursor:pointer;color:var(--timber)">Cancel</button>'
    + '<button onclick="saveCostingRec()" style="padding:9px 18px;background:var(--forest);color:var(--white);border:none;border-radius:var(--r-md);font-size:.78rem;font-weight:700;font-family:var(--font-body);cursor:pointer">Save</button>'
    + '</div></div></div>';
}

function openCostingRecModal(id) {
  var modal = document.getElementById('costing-rec-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  var rec = id ? _costingRecipes.find(function(r){return r.id===id;}) : null;
  document.getElementById('crm-title').textContent = id ? 'Edit menu item' : 'Add menu item';
  document.getElementById('crm-id').value = id || '';
  document.getElementById('crm-name').value = rec ? rec.name : '';
  document.getElementById('crm-cat').value = rec ? rec.category : 'HOT';
  document.getElementById('crm-price').value = rec ? rec.selling_price : '';
}

function closeCostingRecModal() {
  var modal = document.getElementById('costing-rec-modal');
  if (modal) modal.style.display = 'none';
}

async function saveCostingRec() {
  var id = document.getElementById('crm-id').value;
  var payload = {
    name: document.getElementById('crm-name').value.trim(),
    category: document.getElementById('crm-cat').value,
    selling_price: parseFloat(document.getElementById('crm-price').value)
  };
  if (!payload.name || isNaN(payload.selling_price)) { showToast('Name and price required'); return; }
  var sb = _getSB();
  var res;
  if (id) {
    res = await sb.from('costing_recipes').update(payload).eq('id', parseInt(id)).select();
  } else {
    res = await sb.from('costing_recipes').insert(payload).select();
    if (res.data && res.data[0]) _activeRecipeId = res.data[0].id;
  }
  closeCostingRecModal();
  await loadCostingView();
  setCostingTab('recipe');
}

async function deleteCostingRec(id) {
  if (!confirm('Delete this menu item and its recipe?')) return;
  await _getSB().from('costing_recipes').delete().eq('id', id);
  _activeRecipeId = null;
  await loadCostingView();
  setCostingTab('recipe');
}

function selectCostingRecipe(id) {
  _activeRecipeId = id;
  renderCostingPanel();
}

function updateRecipeIng(rid, idx, field, val) {
  var rec = _costingRecipes.find(function(r){return r.id===rid;});
  if (!rec || !rec.ingredients[idx]) return;
  if (field === 'iid') rec.ingredients[idx].ingredient_id = parseInt(val);
  if (field === 'qty') rec.ingredients[idx].qty = parseFloat(val) || 0;
  saveRecipeIngsToDB(rid);
  var panel = document.getElementById('costing-panel');
  if (panel) renderCostingRecipe(panel);
}

function addRecipeIng(rid) {
  var rec = _costingRecipes.find(function(r){return r.id===rid;});
  if (!rec) return;
  if (!rec.ingredients) rec.ingredients = [];
  rec.ingredients.push({ingredient_id: _costingIngredients[0] ? _costingIngredients[0].id : 1, qty: 0, recipe_id: rid, _new: true});
  var panel = document.getElementById('costing-panel');
  if (panel) renderCostingRecipe(panel);
}

function removeRecipeIng(rid, idx) {
  var rec = _costingRecipes.find(function(r){return r.id===rid;});
  if (!rec || !rec.ingredients[idx]) return;
  rec.ingredients.splice(idx, 1);
  saveRecipeIngsToDB(rid);
  var panel = document.getElementById('costing-panel');
  if (panel) renderCostingRecipe(panel);
}

async function saveRecipeIngsToDB(rid) {
  var rec = _costingRecipes.find(function(r){return r.id===rid;});
  if (!rec) return;
  var sb = _getSB();
  await sb.from('costing_recipe_ingredients').delete().eq('recipe_id', rid);
  var toInsert = rec.ingredients.filter(function(ri){return ri.qty > 0;}).map(function(ri){
    return {recipe_id: rid, ingredient_id: ri.ingredient_id, qty: ri.qty};
  });
  if (toInsert.length) await sb.from('costing_recipe_ingredients').insert(toInsert);
}

function renderCostingPricing(panel) {
  var cats = ['ALL','HOT','ICE BLENDED','COLD','PASTRY','PASTA','MEAL','BEST WITH','OTHER'];
  var activeCat = window._costingPricingCat || 'ALL';
  var filtered = activeCat === 'ALL' ? _costingRecipes : _costingRecipes.filter(function(r){return r.category===activeCat;});

  var html = '<div style="display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap">';
  cats.forEach(function(c) {
    html += '<button onclick="setCostingPricingCat(\''+c+'\')" style="padding:6px 14px;font-size:.72rem;font-weight:700;font-family:var(--font-body);border:1.5px solid '+(activeCat===c?'var(--forest)':'var(--mist)')+';background:'+(activeCat===c?'var(--forest)':'transparent')+';color:'+(activeCat===c?'var(--white)':'var(--timber)')+';border-radius:20px;cursor:pointer">'+(c==='ALL'?'All':c)+'</button>';
  });
  html += '</div>';

  html += '<div style="overflow-x:auto;max-height:520px;overflow-y:auto;border-radius:var(--r-lg);box-shadow:var(--shadow-sm)"><table style="width:100%;border-collapse:collapse;font-size:.78rem;background:var(--white)">'
    + '<thead><tr style="background:var(--mist-light)">'
    + '<th style="padding:10px 12px;text-align:left;color:var(--timber);font-weight:700;position:sticky;top:0;z-index:2;background:var(--mist-light)">Menu Item</th>'
    + '<th style="padding:10px 12px;text-align:left;color:var(--timber);font-weight:700;position:sticky;top:0;z-index:2;background:var(--mist-light)">Cat</th>'
    + '<th style="padding:10px 12px;text-align:right;color:var(--timber);font-weight:700;position:sticky;top:0;z-index:2;background:var(--mist-light)">Recipe Cost</th>'
    + '<th style="padding:10px 12px;text-align:right;color:var(--timber);font-weight:700;position:sticky;top:0;z-index:2;background:var(--mist-light)">Selling Price</th>'
    + '<th style="padding:10px 12px;text-align:center;color:var(--timber);font-weight:700;position:sticky;top:0;z-index:2;background:var(--mist-light)">Food Cost %</th>'
    + '<th style="padding:10px 12px;text-align:right;color:var(--timber);font-weight:700;position:sticky;top:0;z-index:2;background:var(--mist-light)">Gross Profit</th>'
    + '<th style="padding:10px 12px;text-align:center;color:var(--timber);font-weight:700;position:sticky;top:0;z-index:2;background:var(--mist-light)">Margin</th>'
    + '<th style="padding:10px 12px;text-align:center;color:var(--timber);font-weight:700;position:sticky;top:0;z-index:2;background:var(--mist-light)">Status</th>'
    + '</tr></thead><tbody>'
    + filtered.map(function(r) {
        var cost = recipeTotalCost(r);
        var pct = fcPct(cost, r.selling_price);
        var profit = r.selling_price - cost;
        var margin = pct !== null ? (100 - pct) : null;
        return '<tr style="border-top:1px solid var(--mist-light)">'
          + '<td style="padding:9px 12px;font-weight:700;color:var(--forest-deep)">' + r.name + '</td>'
          + '<td style="padding:9px 12px"><span style="background:'+(getCostingCatStyle(r.category).bg)+';color:'+(getCostingCatStyle(r.category).color)+';font-size:.6rem;font-weight:700;padding:2px 7px;border-radius:20px">' + r.category + '</span></td>'
          + '<td style="padding:9px 12px;text-align:right;font-family:monospace">' + (cost > 0 ? phpFmt(cost) : '<span style="color:var(--timber)">—</span>') + '</td>'
          + '<td style="padding:9px 12px;text-align:right">'
          + '<input type="number" value="'+r.selling_price+'" step="1" onchange="updateCostingPrice('+r.id+',this.value)" style="width:76px;text-align:right;padding:4px 6px;font-size:.75rem;border:1.5px solid var(--mist);border-radius:var(--r-sm);font-family:monospace;background:var(--white)">'
          + '</td>'
          + '<td style="padding:9px 12px;text-align:center">' + fcPill(pct) + '</td>'
          + '<td style="padding:9px 12px;text-align:right;font-family:monospace;font-weight:700;color:' + (profit>=0?'#15803d':'#dc2626') + '">' + (cost>0?phpFmt(profit):'—') + '</td>'
          + '<td style="padding:9px 12px;text-align:center;font-family:monospace;font-size:.72rem;color:' + (margin===null?'var(--timber)':margin>65?'#15803d':margin>50?'#b45309':'#dc2626') + '">' + (margin!==null?margin.toFixed(1)+'%':'—') + '</td>'
          + '<td style="padding:9px 12px;text-align:center;font-size:.72rem;font-weight:700">' + fcStatus(pct) + '</td>'
          + '</tr>';
      }).join('') + '</tbody></table></div>';

  html += '<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">'
    + '<span style="font-size:.72rem;color:var(--timber)">Food cost target:</span>'
    + '<span style="background:#dcfce7;color:#15803d;padding:2px 10px;border-radius:20px;font-size:.68rem;font-weight:700">Excellent &lt;28%</span>'
    + '<span style="background:#ccfbf1;color:#0f766e;padding:2px 10px;border-radius:20px;font-size:.68rem;font-weight:700">Good 28–35%</span>'
    + '<span style="background:#fef3c7;color:#b45309;padding:2px 10px;border-radius:20px;font-size:.68rem;font-weight:700">Review 35–40%</span>'
    + '<span style="background:#fee2e2;color:#dc2626;padding:2px 10px;border-radius:20px;font-size:.68rem;font-weight:700">Critical &gt;40%</span>'
    + '</div>';

  panel.innerHTML = html;
}

function setCostingPricingCat(cat) {
  window._costingPricingCat = cat;
  var panel = document.getElementById('costing-panel');
  if (panel) renderCostingPricing(panel);
}

async function updateCostingPrice(rid, val) {
  var price = parseFloat(val);
  if (isNaN(price)) return;
  var rec = _costingRecipes.find(function(r){return r.id===rid;});
  if (rec) {
    rec.selling_price = price;
    await _getSB().from('costing_recipes').update({selling_price: price}).eq('id', rid);
  }
}

// ══════════════════════════════════════════════════════════
// AUDIT LOGS TAB
// ══════════════════════════════════════════════════════════
// HISTORY TAB — all orders today including cancelled + deleted
// ══════════════════════════════════════════════════════════
async function renderHistoryTab() {
  var container = document.getElementById('mainContent');
  if (!container) return;
  container.innerHTML = '<div style="padding:32px;text-align:center;color:var(--timber);font-size:.9rem">Loading order history...</div>';
  try {
    var result = await api('getOrders', { includeDeleted: true, limit: 500 });
    if (!result.ok) { container.innerHTML = '<div style="padding:32px;color:red">Failed to load history</div>'; return; }
    var orders = result.orders || [];
    // Filter to today's business day (6AM PHT)
    var phtOffset = 8 * 3600000;
    var nowPHT = new Date(Date.now() + phtOffset);
    if (nowPHT.getUTCHours() < 6) nowPHT.setUTCDate(nowPHT.getUTCDate() - 1);
    var bizDayStart = new Date(Date.UTC(nowPHT.getUTCFullYear(), nowPHT.getUTCMonth(), nowPHT.getUTCDate(), 6, 0, 0) - phtOffset);
    orders = orders.filter(function(o) { return new Date(o.createdAt || o.created_at) >= bizDayStart; });

    if (orders.length === 0) { container.innerHTML = '<div style="padding:32px;text-align:center;color:var(--timber)">No orders today.</div>'; return; }

    var sc = {
      COMPLETED: { bg:'#F0FDF4', bdr:'#86EFAC', badge:'#16A34A' },
      CANCELLED: { bg:'#FEF2F2', bdr:'#FECACA', badge:'#DC2626' },
      READY:     { bg:'#FFFBEB', bdr:'#FDE68A', badge:'#D97706' },
      PREPARING: { bg:'#EFF6FF', bdr:'#BFDBFE', badge:'#2563EB' },
      NEW:       { bg:'#F5F3FF', bdr:'#DDD6FE', badge:'#7C3AED' },
    };

    var html = '<div style="padding:16px">';
    html += '<div style="font-size:.75rem;font-weight:700;color:var(--timber);text-transform:uppercase;letter-spacing:.06em;margin-bottom:14px">Today — ' + orders.length + ' orders (including cancelled &amp; deleted)</div>';

    orders.forEach(function(o) {
      var isDeleted = o.isDeleted;
      var s = sc[o.status] || { bg:'#F9FAFB', bdr:'#E5E7EB', badge:'#6B7280' };
      var amt = parseFloat(o.discountedTotal) > 0 ? parseFloat(o.discountedTotal) : parseFloat(o.total);
      var time = '';
      try {
        var d = new Date(new Date(o.createdAt || o.created_at).getTime() + phtOffset);
        var h = d.getUTCHours(), m = String(d.getUTCMinutes()).padStart(2,'0');
        time = (h%12||12) + ':' + m + ' ' + (h>=12?'PM':'AM');
      } catch(e) {}
      var items = (o.items||[]).map(function(it){ return it.name + ' ×' + it.qty; }).join(', ') || '—';

      html += '<div style="background:' + s.bg + ';border:1px solid ' + s.bdr + ';border-radius:12px;padding:14px 16px;margin-bottom:10px' + (isDeleted ? ';opacity:.6' : '') + '">';
      html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">';
      html += '<div style="display:flex;align-items:center;gap:6px">';
      html += '<span style="font-weight:700;font-size:.88rem">' + esc(o.orderId) + '</span>';
      if (isDeleted) html += '<span style="background:#EF4444;color:#fff;font-size:.62rem;font-weight:700;padding:2px 6px;border-radius:8px">DELETED</span>';
      html += '<span style="background:' + s.badge + ';color:#fff;font-size:.62rem;font-weight:700;padding:2px 6px;border-radius:8px">' + o.status + '</span>';
      html += '</div>';
      html += '<span style="font-weight:700;color:var(--forest)">₱' + (isNaN(amt)?'?':amt.toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2})) + '</span>';
      html += '</div>';
      html += '<div style="font-size:.76rem;color:var(--timber);display:flex;gap:10px;flex-wrap:wrap;margin-bottom:5px">';
      html += '<span>🕐 ' + time + '</span><span>🪑 T' + (o.tableNo||'?') + '</span><span>' + (o.orderType||'') + '</span>';
      if (o.paymentMethod && o.paymentMethod !== 'UNKNOWN') html += '<span>💳 ' + o.paymentMethod + '</span>';
      if (o.customerName && o.customerName !== 'Guest') html += '<span>👤 ' + esc(o.customerName) + '</span>';
      html += '</div>';
      html += '<div style="font-size:.76rem;color:var(--forest-d)">' + esc(items) + '</div>';
      if (parseFloat(o.discountAmount) > 0) {
        html += '<div style="font-size:.72rem;color:#D97706;margin-top:3px">🏷️ ' + (o.discountType||'Discount') + ' −₱' + parseFloat(o.discountAmount).toFixed(2) + ' → Final ₱' + parseFloat(o.discountedTotal).toFixed(2) + '</div>';
      }
      if (isDeleted && (currentUser.role === 'OWNER' || currentUser.role === 'ADMIN')) {
        html += '<button onclick="restoreOrder(\'' + esc(o.orderId) + '\')" style="margin-top:8px;padding:5px 14px;background:var(--forest);color:#fff;border:none;border-radius:8px;font-size:.74rem;font-weight:700;cursor:pointer">↩️ Restore to Board</button>';
      }
      html += '</div>';
    });
    html += '</div>';
    container.innerHTML = html;
  } catch(e) {
    container.innerHTML = '<div style="padding:32px;color:red">Error: ' + e.message + '</div>';
  }
}

async function restoreOrder(orderId) {
  if (!confirm('Restore ' + orderId + ' back to the board?')) return;
  var result = await api('restoreOrder', { orderId: orderId, userId: currentUser && currentUser.userId });
  if (result.ok) {
    showToast('✅ ' + orderId + ' restored', 'success');
    await loadOrders();
    renderHistoryTab();
  } else {
    showToast('❌ ' + (result.error || 'Failed'), 'error');
  }
}

// ══════════════════════════════════════════════════════════
var _auditLogsCache = [];
var _auditFilter = '';

async function loadAuditLogs(filterOrderId) {
  var view = document.getElementById('logsView');
  if (!view) return;
  view.innerHTML = '<div style="padding:24px;text-align:center;color:var(--bark)">Loading logs...</div>';

  var payload = { userId: currentUser && currentUser.userId, limit: 200 };
  if (filterOrderId) payload.orderId = filterOrderId;

  var r = await api('getAuditLogs', payload);
  if (!r || !r.ok) {
    view.innerHTML = '<div style="padding:20px;color:#EF4444">Failed to load logs.</div>';
    return;
  }
  _auditLogsCache = r.logs || [];
  _auditFilter = filterOrderId || '';
  renderAuditLogs();
}

function renderAuditLogs() {
  var view = document.getElementById('logsView');
  if (!view) return;

  var actionMeta = {
    ORDER_PLACED:         { icon:'🛎️',  color:'#059669', label:'Order Placed' },
    STATUS_CHANGED:       { icon:'🔄',  color:'#2563EB', label:'Status Changed' },
    ORDER_DELETED:        { icon:'🗑️',  color:'#EF4444', label:'Order Deleted' },
    PAYMENT_SET:          { icon:'💳',  color:'#7C3AED', label:'Payment Set' },
    DISCOUNT_APPLIED:     { icon:'🏷️',  color:'#D97706', label:'Discount Applied' },
    DISCOUNT_REMOVED:     { icon:'✕',   color:'#6B7280', label:'Discount Removed' },
    ORDER_EDITED:         { icon:'✏️',  color:'#0891B2', label:'Order Edited' },
    PLATFORM_ORDER_PLACED:{ icon:'📦',  color:'#059669', label:'Platform Order' },
  };

  var logs = _auditLogsCache;
  var searchVal = (document.getElementById('logSearch') || {}).value || '';
  if (searchVal) {
    var q = searchVal.toLowerCase();
    logs = logs.filter(function(l) {
      return (l.order_id||'').toLowerCase().includes(q)
          || (l.action||'').toLowerCase().includes(q)
          || (l.actor_name||'').toLowerCase().includes(q)
          || (l.actor_id||'').toLowerCase().includes(q)
          || (l.new_value||'').toLowerCase().includes(q)
          || (l.old_value||'').toLowerCase().includes(q);
    });
  }

  var html = '<div style="padding:14px 16px 100px">';

  // Search bar + filter chip
  html += '<div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">'
    + '<input id="logSearch" type="text" placeholder="Search orders, actions, staff…" value="' + escAttr(searchVal) + '" '
    + 'oninput="renderAuditLogs()" '
    + 'style="flex:1;padding:8px 12px;border:1.5px solid var(--mist);border-radius:10px;font-size:.82rem;font-family:var(--font-body)">'
    + (_auditFilter
        ? '<button onclick="loadAuditLogs()" style="padding:6px 12px;background:#EFF6FF;border:1.5px solid #BFDBFE;border-radius:8px;font-size:.72rem;font-weight:700;color:#1D4ED8;cursor:pointer;white-space:nowrap">✕ Clear filter</button>'
        : '')
    + '</div>';

  html += '<div style="font-size:.72rem;color:#9CA3AF;margin-bottom:10px">'
    + logs.length + ' log entr' + (logs.length===1?'y':'ies')
    + (_auditFilter ? ' for ' + _auditFilter : '')
    + '</div>';

  if (logs.length === 0) {
    html += '<div style="text-align:center;padding:40px 20px;color:#9CA3AF">'
      + '<div style="font-size:2rem;margin-bottom:8px">📭</div>'
      + '<div style="font-size:.85rem">No logs yet. Actions will appear here as orders are placed and updated.</div>'
      + '</div>';
  } else {
    // Group by date
    var byDate = {};
    logs.forEach(function(l) {
      var d = new Date(l.created_at);
      var key = d.toLocaleDateString('en-PH', { weekday:'short', month:'short', day:'numeric', year:'numeric' });
      if (!byDate[key]) byDate[key] = [];
      byDate[key].push(l);
    });

    Object.keys(byDate).forEach(function(date) {
      html += '<div style="font-size:.68rem;font-weight:800;color:var(--bark);text-transform:uppercase;letter-spacing:.06em;padding:8px 0 6px;">' + date + '</div>';

      byDate[date].forEach(function(l) {
        var m = actionMeta[l.action] || { icon:'📝', color:'#6B7280', label: l.action };
        var time = new Date(l.created_at).toLocaleTimeString('en-PH', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
        var actor = l.actor_name || l.actor_id || 'System';

        // Build detail string
        var detail = '';
        if (l.action === 'STATUS_CHANGED' && l.old_value && l.new_value) {
          detail = l.old_value + ' → ' + l.new_value;
        } else if (l.action === 'PAYMENT_SET' && l.new_value) {
          detail = l.new_value;
          if (l.details && l.details.notes) detail += ' · ' + l.details.notes;
        } else if (l.action === 'DISCOUNT_APPLIED' && l.details) {
          detail = l.new_value;
          if (l.details.discountAmount) detail += ' · -₱' + parseFloat(l.details.discountAmount).toFixed(2);
          if (l.details.discountedTotal) detail += ' → ₱' + parseFloat(l.details.discountedTotal).toFixed(2);
        } else if (l.action === 'ORDER_PLACED' && l.details) {
          detail = (l.details.orderType||'') + ' · ' + (l.details.itemCount||0) + ' item(s) · ₱' + parseFloat(l.details.total||0).toFixed(2);
        } else if (l.action === 'ORDER_EDITED' && l.details) {
          detail = (l.details.itemCount||0) + ' item(s) · New total ₱' + parseFloat(l.details.newTotal||0).toFixed(2);
        } else if (l.new_value) {
          detail = l.new_value;
        }

        html += '<div style="background:#fff;border-radius:12px;padding:10px 12px;margin-bottom:6px;display:flex;gap:10px;align-items:flex-start;box-shadow:0 1px 3px rgba(0,0,0,.06)">'
          + '<div style="width:30px;height:30px;border-radius:50%;background:' + m.color + '18;display:flex;align-items:center;justify-content:center;font-size:.9rem;flex-shrink:0;margin-top:1px">' + m.icon + '</div>'
          + '<div style="flex:1;min-width:0">'
            + '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">'
              + '<span style="font-weight:700;font-size:.8rem;color:' + m.color + '">' + m.label + '</span>'
              + (l.order_id ? '<span onclick="loadAuditLogs(\'' + esc(l.order_id) + '\')" style="font-size:.68rem;color:#2563EB;background:#EFF6FF;padding:1px 7px;border-radius:10px;cursor:pointer;font-weight:600">' + l.order_id + '</span>' : '')
            + '</div>'
            + (detail ? '<div style="font-size:.75rem;color:#374151;margin-top:2px">' + esc(detail) + '</div>' : '')
            + '<div style="font-size:.67rem;color:#9CA3AF;margin-top:3px">' + esc(actor) + ' · ' + time + '</div>'
          + '</div>'
          + '</div>';
      });
    });
  }

  html += '</div>';
  view.innerHTML = html;
  // Re-focus search if user was typing
  if (searchVal) {
    var s = document.getElementById('logSearch');
    if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
  }
}

function escAttr(s) { return String(s||'').replace(/"/g,'&quot;'); }

// ══════════════════════════════════════════════════════════
// STAFF TAB
// ══════════════════════════════════════════════════════════
async function loadStaffTab() {
  var view = document.getElementById('staffView');
  if (!view) return;
  view.innerHTML = '<div style="padding:20px;text-align:center;color:var(--bark)">Loading staff...</div>';
  var r = await api('getStaff', { userId: currentUser && currentUser.userId });
  if (!r || !r.ok) {
    view.innerHTML = '<div style="padding:20px;color:#EF4444">Failed to load staff.</div>';
    return;
  }
  var roleColors = { OWNER:'#7C3AED', ADMIN:'#2563EB', CASHIER:'#059669', KITCHEN:'#D97706' };
  var html = '<div style="padding:16px 16px 100px;max-width:960px">';
  html += '<div style="font-size:.85rem;color:var(--bark);margin-bottom:14px;">' + r.users.length + ' active staff accounts</div>';
  r.users.forEach(function(u) {
    var lastLogin = u.last_login ? new Date(u.last_login).toLocaleString('en-PH',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : 'Never';
    var roleColor = roleColors[u.role] || '#6B7280';
    html += '<div style="background:#fff;border-radius:14px;padding:14px 16px;margin-bottom:10px;box-shadow:0 1px 4px rgba(0,0,0,.07);display:flex;align-items:center;gap:12px">'
      + '<div style="width:40px;height:40px;border-radius:50%;background:' + roleColor + '20;display:flex;align-items:center;justify-content:center;font-size:1.2rem;flex-shrink:0">'
        + (u.role==='OWNER'?'👑':u.role==='ADMIN'?'🛡️':u.role==='CASHIER'?'💵':'👨‍🍳') + '</div>'
      + '<div style="flex:1;min-width:0">'
        + '<div style="font-weight:700;font-size:.88rem;color:var(--bark)">' + (u.display_name || u.username) + '</div>'
        + '<div style="font-size:.72rem;color:#9CA3AF;margin-top:2px">@' + u.username + ' · Last login: ' + lastLogin + '</div>'
        + (u.failed_attempts > 0 ? '<div style="font-size:.68rem;color:#EF4444;margin-top:2px">⚠️ ' + u.failed_attempts + ' failed attempt(s)</div>' : '')
      + '</div>'
      + '<span style="font-size:.68rem;font-weight:700;color:' + roleColor + ';background:' + roleColor + '18;padding:3px 10px;border-radius:20px">' + u.role + '</span>'
      + '</div>';
  });
  html += '<div style="background:#FEF3C7;border:1px solid #FCD34D;border-radius:12px;padding:12px 14px;margin-top:8px;font-size:.75rem;color:#92400E">'
    + '💡 To change PINs, use the <strong>Change PIN</strong> option in Settings. Staff management (add/remove) coming soon.</div>';
  html += '</div>';
  view.innerHTML = html;
}

// ══════════════════════════════════════════════════════════
// SHIFT SUMMARY (End-of-Day)
// ══════════════════════════════════════════════════════════
async function loadShiftSummary() {
  var view = document.getElementById('shiftView');
  if (!view) return;
  view.innerHTML = '<div style="padding:24px;text-align:center;color:var(--bark)">Loading shift summary...</div>';
  var r = await api('getShiftSummary', { userId: currentUser && currentUser.userId });
  if (!r || !r.ok) {
    view.innerHTML = '<div style="padding:20px;color:#EF4444">Failed to load shift data.</div>';
    return;
  }
  var pmIcons = {CASH:'💵',CARD:'💳',GCASH:'📱',MAYA:'📲',INSTAPAY:'🏦',BDO:'🏛️',BPI:'🏛️',UNIONBANK:'🏛️',OTHER:'💰',UNRECORDED:'⚠️'};
  var html = '<div style="padding:16px 16px 100px;max-width:960px">';
  // Date + header
  html += '<div style="font-size:.8rem;color:var(--bark);margin-bottom:12px">📅 ' + r.date + ' · Today\'s Shift</div>';
  // Summary cards
  html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px">';
  html += statCard('💰 Revenue', '₱' + parseFloat(r.totalRevenue).toFixed(2), '#059669', '#F0FDF4');
  html += statCard('📋 Orders', r.totalOrders, '#2563EB', '#EFF6FF');
  html += statCard('🏷️ Discounts', '₱' + parseFloat(r.totalDiscounts).toFixed(2), '#7C3AED', '#F5F3FF');
  html += statCard('❌ Cancelled', r.cancelledOrders, '#EF4444', '#FEF2F2');
  html += '</div>';
  // Unrecorded warning
  if (r.unrecordedPayments > 0) {
    html += '<div style="background:#FEF3C7;border:1.5px solid #FCD34D;border-radius:12px;padding:12px 14px;margin-bottom:14px">'
      + '<div style="font-weight:700;color:#92400E;font-size:.82rem">⚠️ ' + r.unrecordedPayments + ' completed order(s) with no payment method logged!</div>'
      + '<div style="font-size:.72rem;color:#B45309;margin-top:3px">Go to those orders and set payment method for accurate reconciliation.</div>'
      + '</div>';
  }
  // Payment breakdown
  html += '<div style="font-size:.75rem;font-weight:700;color:var(--bark);margin-bottom:8px;text-transform:uppercase;letter-spacing:.04em">Payment Breakdown</div>';
  var breakdown = r.paymentBreakdown || {};
  var pmKeys = Object.keys(breakdown).sort();
  if (pmKeys.length === 0) {
    html += '<div style="color:#9CA3AF;font-size:.8rem;padding:8px 0">No completed orders yet today.</div>';
  } else {
    pmKeys.forEach(function(pm) {
      var d = breakdown[pm];
      var icon = pmIcons[pm] || '💰';
      var isWarning = pm === 'UNRECORDED';
      html += '<div style="background:' + (isWarning?'#FEF3C7':'#fff') + ';border-radius:12px;padding:12px 14px;margin-bottom:8px;display:flex;align-items:center;gap:10px;box-shadow:0 1px 3px rgba(0,0,0,.06)">'
        + '<span style="font-size:1.1rem">' + icon + '</span>'
        + '<div style="flex:1"><div style="font-weight:700;font-size:.83rem;color:' + (isWarning?'#92400E':'var(--bark)') + '">' + pm + '</div>'
        + '<div style="font-size:.7rem;color:#9CA3AF">' + d.count + ' order(s)</div></div>'
        + '<div style="font-weight:800;font-size:.9rem;color:' + (isWarning?'#92400E':'var(--forest)') + '">₱' + parseFloat(d.total).toFixed(2) + '</div>'
        + '</div>';
    });
  }
  // Dine-in vs Take-out
  html += '<div style="font-size:.75rem;font-weight:700;color:var(--bark);margin-top:14px;margin-bottom:8px;text-transform:uppercase;letter-spacing:.04em">Order Types</div>';
  html += '<div style="display:flex;gap:8px">'
    + '<div style="flex:1;background:#fff;border-radius:12px;padding:12px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.06)">'
      + '<div style="font-size:1.2rem">🍽️</div><div style="font-weight:700;font-size:1.1rem;color:var(--forest)">' + r.orderTypeSplit.dineIn + '</div>'
      + '<div style="font-size:.68rem;color:#9CA3AF">Dine-In</div></div>'
    + '<div style="flex:1;background:#fff;border-radius:12px;padding:12px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.06)">'
      + '<div style="font-size:1.2rem">🛍️</div><div style="font-weight:700;font-size:1.1rem;color:var(--forest)">' + r.orderTypeSplit.takeOut + '</div>'
      + '<div style="font-size:.68rem;color:#9CA3AF">Take-Out</div></div>'
    + '</div>';
  html += '</div>';

  // Manual daily report button (OWNER/ADMIN only)
  if (currentUser && (currentUser.role === 'OWNER' || currentUser.role === 'ADMIN')) {
    html += '<div style="margin-top:16px;padding:0 4px">' +
      '<button onclick="triggerManualDailyReport(this)" ' +
        'style="width:100%;background:var(--forest-deep);color:#fff;border:none;border-radius:12px;padding:12px;font-size:.88rem;font-weight:700;cursor:pointer">' +
        '📧 Send Daily Report Now</button>' +
      '<div style="font-size:.7rem;color:var(--timber);text-align:center;margin-top:6px">Sends today\'s sales summary email</div>' +
    '</div>';
  }

  view.innerHTML = html;
}

async function triggerManualDailyReport(btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Sending...'; }
  try {
    var token = (currentUser && currentUser.token) || '';
    var resp = await fetch('/api/daily-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ manual: true })
    });
    var d = await resp.json();
    if (d.ok || d.sent) {
      showToast('✅ Daily report sent!');
    } else {
      showToast('⚠️ ' + (d.error || 'Report may not have sent — check email'), 'warn');
    }
  } catch(e) {
    showToast('❌ ' + e.message, 'error');
  }
  if (btn) { btn.disabled = false; btn.textContent = '📧 Send Daily Report Now'; }
}

function statCard(label, value, color, bg) {
  return '<div style="background:' + bg + ';border-radius:12px;padding:12px;text-align:center">'
    + '<div style="font-size:.68rem;color:' + color + ';font-weight:700;margin-bottom:4px">' + label + '</div>'
    + '<div style="font-size:1.1rem;font-weight:800;color:' + color + '">' + value + '</div>'
    + '</div>';
}

// ══════════════════════════════════════════════════════════
// GENERIC MODAL HELPER
// ══════════════════════════════════════════════════════════
function showModal(title, bodyHtml) {
  document.getElementById('genericModalTitle').textContent = title;
  document.getElementById('genericModalBody').innerHTML = bodyHtml;
  document.getElementById('genericModal').classList.add('open');
}
function closeModal() {
  document.getElementById('genericModal').classList.remove('open');
}

// ══════════════════════════════════════════════════════════
// FLOOR MAP — Table occupancy + Reservation auto-link
// ══════════════════════════════════════════════════════════
var _floorTables = [];
var _floorReservations = [];

async function loadFloorMap() {
  var el = document.getElementById('floorMapView');
  el.innerHTML = '<div style="padding:20px;color:#888">Loading floor map…</div>';
  var [tr, rr] = await Promise.all([
    api('getTableStatus'),
    api('getReservations', { userId: currentUser.userId })
  ]);
  _floorTables = (tr.tables || []);
  _floorReservations = (rr.reservations || []).filter(function(r) {
    return r.status === 'CONFIRMED' || r.status === 'SEATED';
  });
  renderFloorMap();
}

function renderFloorMap() {
  var el = document.getElementById('floorMapView');
  var statusColors = { AVAILABLE:'#22c55e', OCCUPIED:'#ef4444', RESERVED:'#f59e0b', MAINTENANCE:'#94a3b8' };
  var statusLabels = { AVAILABLE:'Available', OCCUPIED:'Occupied', RESERVED:'Reserved', MAINTENANCE:'Maintenance' };

  // Auto-detect occupied from active orders in real-time
  var activeByTable = {};
  if (typeof allOrders !== 'undefined') {
    allOrders.forEach(function(o) {
      if (['NEW','PREPARING','READY'].includes(o.status) && !o.isTest && o.tableNo) {
        activeByTable[String(o.tableNo)] = o;
      }
    });
  }

  var legendHtml = Object.keys(statusColors).map(function(s) {
    return '<span style="display:inline-flex;align-items:center;gap:5px;margin-right:14px;font-size:.75rem">'
      + '<span style="width:12px;height:12px;border-radius:3px;background:' + statusColors[s] + '"></span>' + statusLabels[s] + '</span>';
  }).join('');

  var gridHtml = _floorTables.map(function(t) {
    var tno = String(t.table_number);
    var activeOrder = activeByTable[tno];
    var st = activeOrder ? 'OCCUPIED' : (t.status || 'AVAILABLE');
    var col = statusColors[st] || '#22c55e';
    var linked = _floorReservations.find(function(r) { return r.table_id === t.id; });

    var actionHtml = '';
    if (activeOrder) {
      actionHtml = '<div style="font-size:.62rem;color:#fff;opacity:.9;margin-top:3px">' + esc(activeOrder.customerName||'Guest') + '</div>'
        + '<div style="font-size:.6rem;color:#fff;opacity:.8">₱' + (parseFloat(activeOrder.total)||0).toLocaleString() + '</div>'
        + '<button onclick="event.stopPropagation();quickFreeTable(' + t.table_number + ')" style="margin-top:6px;background:rgba(255,255,255,.25);color:#fff;border:none;border-radius:6px;padding:3px 8px;font-size:.6rem;font-weight:700;cursor:pointer;width:100%">✓ Free Table</button>';
    } else if (st === 'AVAILABLE') {
      actionHtml = '<button onclick="event.stopPropagation();quickOccupyTable(' + t.table_number + ')" style="margin-top:6px;background:rgba(255,255,255,.2);color:#fff;border:none;border-radius:6px;padding:3px 8px;font-size:.6rem;font-weight:700;cursor:pointer;width:100%">● Occupy</button>';
    }
    if (linked) {
      actionHtml += '<div style="font-size:.6rem;margin-top:3px;color:#fff;opacity:.85">📅 ' + esc(linked.guest_name) + '</div>';
    }

    return '<div style="background:' + col + ';border-radius:14px;padding:12px 8px;text-align:center;cursor:pointer;min-width:82px;box-shadow:0 2px 8px rgba(0,0,0,.12);transition:transform .1s"'
      + ' onclick="openFloorTableMenu(' + t.table_number + ')">'
      + '<div style="font-size:1.2rem">🪑</div>'
      + '<div style="font-weight:800;font-size:.82rem;color:#fff;margin-top:2px">'
      + esc(t.table_name || 'Table ' + t.table_number) + '</div>'
      + '<div style="font-size:.62rem;color:#fff;opacity:.9;margin-top:1px">' + statusLabels[st] + '</div>'
      + actionHtml
      + '</div>';
  }).join('');

  // Pending reservations (no table linked)
  var unlinked = _floorReservations.filter(function(r) { return !r.table_id; });
  var pendingHtml = unlinked.length ? '<div style="margin:20px 0 8px;font-weight:700;font-size:.85rem;color:#92400e">📅 Reservations Awaiting Table (' + unlinked.length + ')</div>'
    + unlinked.map(function(r) {
      return '<div style="background:#fef3c7;border:1.5px solid #fbbf24;border-radius:10px;padding:12px 14px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between">'
        + '<div><div style="font-weight:700;font-size:.85rem">' + esc(r.guest_name) + ' — ' + r.pax + ' pax</div>'
        + '<div style="font-size:.72rem;color:#92400e">' + r.res_date + ' ' + r.res_time + '</div></div>'
        + '<button onclick="assignResTable(\'' + r.res_id + '\')" style="background:#f59e0b;color:#fff;border:none;border-radius:7px;padding:5px 10px;font-size:.75rem;font-weight:700;cursor:pointer">Assign</button>'
        + '</div>';
    }).join('') : '';

  el.innerHTML = '<div style="padding:16px 16px 0;max-width:960px">'
    + '<div style="font-weight:800;font-size:1.05rem;color:var(--forest-deep);margin-bottom:10px">🗺️ Floor Map</div>'
    + '<div style="margin-bottom:14px">' + legendHtml + '</div>'
    + '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:10px">' + gridHtml + '</div>'
    + pendingHtml
    + '</div>';
}

async function quickOccupyTable(tableNo) {
  var r = await api('setTableStatus', { userId: currentUser && currentUser.userId, tableNumber: tableNo, status: 'OCCUPIED' });
  if (r.ok) { showToast('Table ' + tableNo + ' → Occupied'); loadFloorMap(); }
}

async function quickFreeTable(tableNo) {
  var r = await api('setTableStatus', { userId: currentUser && currentUser.userId, tableNumber: tableNo, status: 'AVAILABLE' });
  if (r.ok) { showToast('Table ' + tableNo + ' → Available ✅'); loadFloorMap(); }
}

async function assignResTable(resId) {
  var sel = document.getElementById('rlkSel_' + resId);
  if (!sel) return;
  var tableNo = parseInt(sel.value);
  var r = await api('linkReservationTable', { userId: currentUser.userId, resId: resId, tableNumber: tableNo });
  if (r.ok) { showToast('Table assigned ✅'); loadFloorMap(); }
  else showToast('Error: ' + r.error, true);
}

function openFloorTableMenu(tableNo) {
  var t = _floorTables.find(function(x){ return x.table_number === tableNo; });
  if (!t) return;
  var statusOptions = ['AVAILABLE','OCCUPIED','RESERVED','MAINTENANCE'];
  var labels = { AVAILABLE:'✅ Available', OCCUPIED:'🔴 Occupied', RESERVED:'📅 Reserved', MAINTENANCE:'🔧 Maintenance' };
  var curStatus = t.status || 'AVAILABLE';
  showModal('Table ' + (t.table_name || tableNo),
    '<div style="margin-bottom:14px;font-size:.85rem;color:#64748b">Current: <strong>' + curStatus + '</strong></div>'
    + '<div style="display:flex;flex-direction:column;gap:8px">'
    + statusOptions.filter(function(s){ return s !== curStatus; }).map(function(s) {
      return '<button onclick="setFloorTableStatus(' + tableNo + ',\'' + s + '\')" '
        + 'style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:10px;padding:10px;font-size:.85rem;font-weight:600;cursor:pointer;text-align:left">'
        + labels[s] + '</button>';
    }).join('')
    + '</div>'
  );
}

async function setFloorTableStatus(tableNo, status) {
  closeModal();
  var r = await api('setTableStatus', { userId: currentUser.userId, tableNumber: tableNo, status: status });
  if (r.ok) { showToast('Table ' + tableNo + ' → ' + status); loadFloorMap(); }
  else showToast('Error: ' + r.error, true);
}

// ══════════════════════════════════════════════════════════
// INVENTORY
// ══════════════════════════════════════════════════════════
var _inventoryItems = [];

async function loadInventoryView() {
  var el = document.getElementById('inventoryView');
  el.innerHTML = '<div style="padding:20px;color:#888">Loading inventory…</div>';
  var r = await api('getInventory', { userId: currentUser.userId });
  _inventoryItems = r.items || [];
  renderInventoryView();
}

function renderInventoryView() {
  var el = document.getElementById('inventoryView');
  var lowCount = _inventoryItems.filter(function(i){ return i.low_stock; }).length;
  var outCount = _inventoryItems.filter(function(i){ return parseFloat(i.stock_qty) === 0; }).length;

  var rowsHtml = _inventoryItems.length === 0
    ? '<div style="text-align:center;padding:40px;color:#94a3b8">No inventory tracked yet. Click <strong>+ Add Item</strong> to start.</div>'
    : _inventoryItems.map(function(i) {
      var badge = parseFloat(i.stock_qty) === 0
        ? '<span style="background:#fef2f2;color:#ef4444;border-radius:6px;padding:2px 8px;font-size:.68rem;font-weight:700;flex-shrink:0">OUT</span>'
        : i.low_stock
        ? '<span style="background:#fff7ed;color:#f59e0b;border-radius:6px;padding:2px 8px;font-size:.68rem;font-weight:700;flex-shrink:0">LOW</span>'
        : '<span style="background:#f0fdf4;color:#22c55e;border-radius:6px;padding:2px 8px;font-size:.68rem;font-weight:700;flex-shrink:0">OK</span>';

      var photoHtml = i.photo_url
        ? '<img src="' + esc(i.photo_url) + '" style="width:44px;height:44px;border-radius:8px;object-fit:cover;flex-shrink:0" onerror="this.style.display=&quot;none&quot;">'
        : '<div style="width:44px;height:44px;border-radius:8px;background:#f1f5f9;display:flex;align-items:center;justify-content:center;font-size:1.3rem;flex-shrink:0">📦</div>';

      var sizeLabel = i.size_per_unit ? ' · ' + esc(i.size_per_unit) : '';
      var sellLabel = i.selling_price > 0 ? ' · Sell ₱' + parseFloat(i.selling_price).toFixed(0) : '';
      var qty = parseFloat(i.stock_qty);
      var qtyDisplay = qty === Math.floor(qty) ? qty.toFixed(0) : qty.toFixed(1);

      return '<div style="background:#fff;border-radius:12px;box-shadow:0 1px 6px rgba(0,0,0,.07);padding:12px 14px;display:flex;align-items:center;gap:10px;margin-bottom:8px">'
        + photoHtml
        + '<div style="flex:1;min-width:0">'
        + '<div style="font-weight:700;font-size:.88rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(i.item_name || i.item_code) + '</div>'
        + '<div style="font-size:.7rem;color:#64748b;margin-top:1px">' + esc(i.item_code) + ' · ' + esc(i.unit) + sizeLabel + ' · Cost ₱' + parseFloat(i.cost_per_unit||0).toFixed(2) + sellLabel + '</div>'
        + '<div style="font-size:.68rem;color:#94a3b8;margin-top:1px">Threshold: ' + i.low_stock_threshold + ' ' + esc(i.unit) + '</div>'
        + '</div>'
        + badge
        + '<div style="font-size:1.15rem;font-weight:800;min-width:40px;text-align:center;color:' + (parseFloat(i.stock_qty)===0?'#ef4444':i.low_stock?'#f59e0b':'#065f46') + '">' + qtyDisplay + '</div>'
        + '<div style="display:flex;flex-direction:column;gap:4px">'
        + '<button onclick="invQuickIn(\'' + i.item_code + '\')" style="background:#f0fdf4;color:#16a34a;border:1.5px solid #bbf7d0;border-radius:7px;padding:4px 10px;font-size:.78rem;font-weight:700;cursor:pointer;white-space:nowrap">▲ IN</button>'
        + '<button onclick="invQuickOut(\'' + i.item_code + '\')" style="background:#fef2f2;color:#dc2626;border:1.5px solid #fecaca;border-radius:7px;padding:4px 10px;font-size:.78rem;font-weight:700;cursor:pointer;white-space:nowrap">▼ OUT</button>'
        + '</div>'
        + '<button onclick="openInvEdit(\'' + i.item_code + '\')" style="background:#f8fafc;color:#64748b;border:1px solid #e2e8f0;border-radius:8px;padding:6px 10px;font-size:.78rem;cursor:pointer;flex-shrink:0">⚙️</button>'
        + '</div>';
    }).join('');

  var summaryBadges = '';
  if (outCount > 0) summaryBadges += '<span style="background:#fef2f2;color:#ef4444;border-radius:8px;padding:3px 10px;font-size:.75rem;font-weight:700;margin-right:6px">⚠️ ' + outCount + ' OUT OF STOCK</span>';
  if (lowCount > 0) summaryBadges += '<span style="background:#fff7ed;color:#f59e0b;border-radius:8px;padding:3px 10px;font-size:.75rem;font-weight:700">⚠️ ' + lowCount + ' LOW STOCK</span>';

  el.innerHTML = '<div style="padding:16px 16px 0;max-width:960px">'
    + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">'
    + '<div><div style="font-weight:800;font-size:1.05rem;color:var(--forest-deep)">📦 Inventory</div>'
    + (summaryBadges ? '<div style="margin-top:4px">' + summaryBadges + '</div>' : '') + '</div>'
    + '<button onclick="openInvAdd()" style="background:var(--forest-deep);color:#fff;border:none;border-radius:10px;padding:8px 14px;font-size:.82rem;font-weight:700;cursor:pointer">+ Add Item</button>'
    + '</div>'
    + rowsHtml + '</div>';
}

// ── Quick IN modal ─────────────────────────────────────────
function invQuickIn(code) {
  var item = _inventoryItems.find(function(i){ return i.item_code === code; });
  var name = item ? (item.item_name || code) : code;
  var cur = item ? parseFloat(item.stock_qty) : 0;
  showModal('▲ Stock IN — ' + name,
    '<div style="background:#f0fdf4;border-radius:10px;padding:10px 14px;margin-bottom:12px;display:flex;justify-content:space-between">'
    + '<span style="font-size:.82rem;color:#166534">Current stock</span>'
    + '<strong style="color:#166534">' + cur + ' ' + (item?item.unit:'') + '</strong></div>'
    + '<div style="display:flex;flex-direction:column;gap:10px">'
    + '<label style="font-size:.8rem;font-weight:600">Qty IN (how much arriving?)<br>'
    + '<input id="qInQty" type="number" value="1" min="0.1" step="any" autofocus style="width:100%;padding:10px;border:2px solid #bbf7d0;border-radius:8px;font-size:1rem;font-weight:700;margin-top:3px"></label>'
    + '<label style="font-size:.8rem;font-weight:600">Type<br>'
    + '<select id="qInType" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px">'
    + '<option value="RESTOCK">🛒 Restock / Delivery</option>'
    + '<option value="RETURN">↩️ Return / Unused</option>'
    + '<option value="ADJUSTMENT">✏️ Manual Correction</option>'
    + '</select></label>'
    + '<label style="font-size:.8rem;font-weight:600">Cost per unit this delivery (₱) <span style="font-weight:400;opacity:.6">optional</span><br>'
    + '<input id="qInPrice" type="number" value="' + (item?parseFloat(item.cost_per_unit||0):'0') + '" min="0" step="0.01" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px"></label>'
    + '<label style="font-size:.8rem;font-weight:600">Ref / Supplier note <span style="font-weight:400;opacity:.6">optional</span><br>'
    + '<input id="qInRef" placeholder="e.g. Supplier: ABC, PO-123" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px"></label>'
    + '<button onclick="doQuickIn(\'' + code + '\')" style="background:#16a34a;color:#fff;border:none;border-radius:10px;padding:12px;font-weight:700;cursor:pointer;font-size:.95rem">▲ Add to Stock</button>'
    + '</div>'
  );
}

async function doQuickIn(code) {
  var qty = parseFloat(document.getElementById('qInQty').value) || 0;
  if (qty <= 0) { showToast('Enter a quantity > 0', true); return; }
  var r = await api('adjustInventory', {
    userId: currentUser.userId, itemCode: code,
    adjustment: qty, direction: 'IN',
    changeType: document.getElementById('qInType').value,
    unitPrice: parseFloat(document.getElementById('qInPrice').value) || 0,
    reference: document.getElementById('qInRef').value,
    notes: document.getElementById('qInRef').value,
  });
  closeModal();
  if (r.ok) { showToast('✅ +' + qty + ' added — stock now ' + r.qtyAfter); loadInventoryView(); }
  else showToast('Error: ' + r.error, true);
}

// ── Quick OUT modal ────────────────────────────────────────
function invQuickOut(code) {
  var item = _inventoryItems.find(function(i){ return i.item_code === code; });
  var name = item ? (item.item_name || code) : code;
  var cur = item ? parseFloat(item.stock_qty) : 0;
  showModal('▼ Stock OUT — ' + name,
    '<div style="background:#fef2f2;border-radius:10px;padding:10px 14px;margin-bottom:12px;display:flex;justify-content:space-between">'
    + '<span style="font-size:.82rem;color:#991b1b">Current stock</span>'
    + '<strong style="color:#991b1b">' + cur + ' ' + (item?item.unit:'') + '</strong></div>'
    + '<div style="display:flex;flex-direction:column;gap:10px">'
    + '<label style="font-size:.8rem;font-weight:600">Qty OUT (how much used/removed?)<br>'
    + '<input id="qOutQty" type="number" value="1" min="0.1" step="any" autofocus style="width:100%;padding:10px;border:2px solid #fecaca;border-radius:8px;font-size:1rem;font-weight:700;margin-top:3px"></label>'
    + '<label style="font-size:.8rem;font-weight:600">Reason<br>'
    + '<select id="qOutType" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px">'
    + '<option value="WASTE">🗑️ Waste / Spoilage / Expired</option>'
    + '<option value="ADJUSTMENT">✏️ Manual Correction</option>'
    + '<option value="SALE">💰 Manual Sale Deduction</option>'
    + '</select></label>'
    + '<label style="font-size:.8rem;font-weight:600">Notes <span style="font-weight:400;opacity:.6">optional</span><br>'
    + '<input id="qOutNotes" placeholder="e.g. Spoiled, wrong order..." style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px"></label>'
    + '<button onclick="doQuickOut(\'' + code + '\')" style="background:#dc2626;color:#fff;border:none;border-radius:10px;padding:12px;font-weight:700;cursor:pointer;font-size:.95rem">▼ Remove from Stock</button>'
    + '</div>'
  );
}

async function doQuickOut(code) {
  var qty = parseFloat(document.getElementById('qOutQty').value) || 0;
  if (qty <= 0) { showToast('Enter a quantity > 0', true); return; }
  var r = await api('adjustInventory', {
    userId: currentUser.userId, itemCode: code,
    adjustment: qty, direction: 'OUT',
    changeType: document.getElementById('qOutType').value,
    notes: document.getElementById('qOutNotes').value,
  });
  closeModal();
  if (r.ok) { showToast('▼ -' + qty + ' removed — stock now ' + r.qtyAfter); loadInventoryView(); }
  else showToast('Error: ' + r.error, true);
}

async function openInvAdd() {
  var menuItems = menuMgrItems.length > 0 ? menuMgrItems
    : (window._menuDataCache && window._menuDataCache.length ? window._menuDataCache : null);
  if (!menuItems) {
    var r = await api('getMenuAdmin', { userId: currentUser && currentUser.userId });
    menuItems = r.items || [];
  }
  var invR = await api('getInventory', { userId: currentUser && currentUser.userId });
  var trackedCodes = new Set((invR.items || []).map(function(i){ return i.item_code; }));

  var options = '<option value="">— Select a menu item —</option>'
    + menuItems.map(function(m) {
      var tracked = trackedCodes.has(m.code || m.item_code);
      var code = m.code || m.item_code;
      return '<option value="' + esc(code) + '"' + (tracked ? ' disabled' : '') + '>'
        + esc(m.name) + ' (' + esc(code) + ')' + (tracked ? ' — already tracked' : '') + '</option>';
    }).join('')
    + '<option value="__CUSTOM__">✏️ Enter code manually…</option>';

  showModal('Add Inventory Item',
    '<div style="display:flex;flex-direction:column;gap:10px">'
    + '<label style="font-size:.8rem;font-weight:600">Menu Item<br>'
    + '<select id="invItemSelect" onchange="invSelectChange(this)" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px">' + options + '</select></label>'
    + '<div id="invManualCodeWrap" style="display:none"><label style="font-size:.8rem;font-weight:600">Item Code (manual)<br>'
    + '<input id="invItemCode" placeholder="e.g. H001" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px"></label></div>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'
    + '<label style="font-size:.8rem;font-weight:600">Initial Stock Qty<br><input id="invQty" type="number" value="0" min="0" step="any" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px"></label>'
    + '<label style="font-size:.8rem;font-weight:600">Low Stock Threshold<br><input id="invThreshold" type="number" value="10" min="0" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px"></label>'
    + '</div>'
    + '<label style="font-size:.8rem;font-weight:600">Unit<br>'
    + '<select id="invUnit" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px">'
    + '<option>pcs</option><option>cups</option><option>shots</option><option>bottles</option><option>sachets</option>'
    + '<option>bags</option><option>boxes</option><option>g</option><option>kg</option>'
    + '<option>mL</option><option>L</option><option>tbsp</option><option>tsp</option><option>oz</option>'
    + '</select></label>'
    + '<label style="font-size:.8rem;font-weight:600">Size per unit <span style="font-weight:400;opacity:.6">e.g. 250g, 1L, 500mL</span><br>'
    + '<input id="invSizePer" placeholder="e.g. 1kg, 500mL, 250g" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px"></label>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'
    + '<label style="font-size:.8rem;font-weight:600">Cost Price (₱/unit)<br><input id="invCost" type="number" value="0" min="0" step="0.01" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px"></label>'
    + '<label style="font-size:.8rem;font-weight:600">Selling Price (₱/unit)<br><input id="invSell" type="number" value="0" min="0" step="0.01" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px"></label>'
    + '</div>'
    + '<label style="font-size:.8rem;font-weight:600">Photo <span style="font-weight:400;opacity:.6">optional</span><br>'
    + '<div style="display:flex;align-items:center;gap:10px;margin-top:4px">'
    + '<div id="invPhotoPreview" style="width:56px;height:56px;border-radius:8px;background:#f1f5f9;display:flex;align-items:center;justify-content:center;font-size:1.5rem;flex-shrink:0;overflow:hidden">📦</div>'
    + '<label style="flex:1;background:#eff6ff;color:#2563eb;border:1.5px dashed #93c5fd;border-radius:8px;padding:10px;text-align:center;cursor:pointer;font-size:.82rem;font-weight:600">'
    + '📷 Choose Photo<input type="file" id="invPhotoFile" accept="image/*" onchange="invPreviewPhoto(this)" style="display:none"></label>'
    + '</div></label>'
    + '<label style="display:flex;align-items:center;gap:8px;font-size:.8rem;font-weight:600;cursor:pointer">'
    + '<input type="checkbox" id="invAutoDisable"> Auto-disable menu item when stock = 0</label>'
    + '<button onclick="saveInvItem(null)" style="background:var(--forest-deep);color:#fff;border:none;border-radius:10px;padding:10px;font-weight:700;cursor:pointer;font-size:.9rem">Save Item</button>'
    + '</div>'
  );
}

function invPreviewPhoto(input) {
  if (!input.files || !input.files[0]) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    var prev = document.getElementById('invPhotoPreview');
    if (prev) prev.innerHTML = '<img src="' + e.target.result + '" style="width:100%;height:100%;object-fit:cover">';
  };
  reader.readAsDataURL(input.files[0]);
}

function invSelectChange(sel) {
  var wrap = document.getElementById('invManualCodeWrap');
  wrap.style.display = sel.value === '__CUSTOM__' ? 'block' : 'none';
  if (sel.value !== '__CUSTOM__' && document.getElementById('invItemCode'))
    document.getElementById('invItemCode').value = '';
}

function openInvEdit(itemCode) {
  var item = _inventoryItems.find(function(i){ return i.item_code === itemCode; });
  if (!item) return;
  var unitOpts = ['pcs','cups','shots','bottles','sachets','bags','boxes','g','kg','mL','L','tbsp','tsp','oz'];
  var curUnit = item.unit || 'pcs';

  showModal('⚙️ Edit: ' + esc(item.item_name || itemCode),
    '<div style="display:flex;flex-direction:column;gap:10px">'
    + '<div style="display:flex;gap:10px;align-items:center;margin-bottom:4px">'
    + '<div id="invEditPhotoPreview" style="width:64px;height:64px;border-radius:10px;background:#f1f5f9;display:flex;align-items:center;justify-content:center;font-size:1.8rem;flex-shrink:0;overflow:hidden">'
    + (item.photo_url ? '<img src="' + esc(item.photo_url) + '" style="width:100%;height:100%;object-fit:cover" onerror="this.parentElement.textContent=&quot;📦&quot;">' : '📦')
    + '</div>'
    + '<label style="flex:1;background:#eff6ff;color:#2563eb;border:1.5px dashed #93c5fd;border-radius:8px;padding:10px;text-align:center;cursor:pointer;font-size:.8rem;font-weight:600">'
    + '📷 Change Photo<input type="file" id="invEditPhotoFile" accept="image/*" onchange="invPreviewPhotoEdit(this)" style="display:none"></label>'
    + '</div>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'
    + '<label style="font-size:.8rem;font-weight:600">Low Stock Threshold<br><input id="invThreshold" type="number" value="' + item.low_stock_threshold + '" min="0" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px"></label>'
    + '<label style="font-size:.8rem;font-weight:600">Unit<br><select id="invUnit" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px">'
    + unitOpts.map(function(u){ return '<option' + (u===curUnit?' selected':'') + '>' + u + '</option>'; }).join('')
    + '</select></label>'
    + '</div>'
    + '<label style="font-size:.8rem;font-weight:600">Size per unit <span style="font-weight:400;opacity:.6">e.g. 250g, 1L</span><br>'
    + '<input id="invSizePer" value="' + esc(item.size_per_unit||'') + '" placeholder="e.g. 1kg, 500mL" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px"></label>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'
    + '<label style="font-size:.8rem;font-weight:600">Cost Price (₱/unit)<br><input id="invCost" type="number" value="' + (item.cost_per_unit||0) + '" step="0.01" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px"></label>'
    + '<label style="font-size:.8rem;font-weight:600">Selling Price (₱/unit)<br><input id="invSell" type="number" value="' + (item.selling_price||0) + '" step="0.01" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px"></label>'
    + '</div>'
    + '<label style="display:flex;align-items:center;gap:8px;font-size:.8rem;font-weight:600;cursor:pointer">'
    + '<input type="checkbox" id="invAutoDisable"' + (item.auto_disable?' checked':'') + '> Auto-disable menu item when stock = 0</label>'
    + '<button onclick="saveInvItem(\'' + itemCode + '\')" style="background:var(--forest-deep);color:#fff;border:none;border-radius:10px;padding:10px;font-weight:700;cursor:pointer;font-size:.9rem">Save Changes</button>'
    + '</div>'
  );
}

function invPreviewPhotoEdit(input) {
  if (!input.files || !input.files[0]) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    var prev = document.getElementById('invEditPhotoPreview');
    if (prev) prev.innerHTML = '<img src="' + e.target.result + '" style="width:100%;height:100%;object-fit:cover">';
  };
  reader.readAsDataURL(input.files[0]);
}

async function saveInvItem(existingCode) {
  var code = existingCode;
  if (!code) {
    var sel = document.getElementById('invItemSelect');
    var manual = document.getElementById('invItemCode');
    if (sel && sel.value && sel.value !== '__CUSTOM__' && sel.value !== '') {
      code = sel.value;
    } else if (manual && manual.value.trim()) {
      code = manual.value.trim();
    }
  }
  if (!code) { showToast('Please select a menu item', true); return; }

  // Handle photo upload first if a file was chosen
  var photoInputId = existingCode ? 'invEditPhotoFile' : 'invPhotoFile';
  var photoInput = document.getElementById(photoInputId);
  var photoUrl = null;
  if (photoInput && photoInput.files && photoInput.files[0]) {
    var file = photoInput.files[0];
    var reader = new FileReader();
    var b64 = await new Promise(function(res) {
      reader.onload = function(e) { res(e.target.result.split(',')[1]); };
      reader.readAsDataURL(file);
    });
    var uploadR = await api('uploadInventoryPhoto', {
      userId: currentUser.userId,
      itemCode: code,
      imageBase64: b64,
      mimeType: file.type || 'image/jpeg',
    });
    if (uploadR.ok) photoUrl = uploadR.photoUrl;
    else showToast('Photo upload failed: ' + uploadR.error, true);
  }

  var payload = {
    userId: currentUser.userId,
    itemCode: code,
    lowStockThreshold: document.getElementById('invThreshold').value,
    unit: document.getElementById('invUnit').value,
    sizePerUnit: (document.getElementById('invSizePer') || {value:''}).value,
    costPerUnit: document.getElementById('invCost').value,
    sellingPrice: (document.getElementById('invSell') || {value:0}).value,
    autoDisable: document.getElementById('invAutoDisable').checked,
  };
  if (!existingCode) {
    payload.stockQty = (document.getElementById('invQty')||{value:0}).value;
  }
  if (photoUrl) payload.photoUrl = photoUrl;

  var r = await api('upsertInventory', payload);
  closeModal();
  if (r.ok) { showToast('Inventory saved ✅'); loadInventoryView(); }
  else showToast('Error: ' + r.error, true);
}

function openInvAdjust(code, name, currentQty) { invQuickIn(code); } // legacy alias

async function doInvAdjust(code) {} // legacy stub

// ══════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════
// ADD-ONS / MODIFIERS
// ══════════════════════════════════════════════════════════
var _addons = [];

async function loadAddonsView() {
  var el = document.getElementById('addonsView');
  el.innerHTML = '<div style="padding:20px;color:#888">Loading add-ons…</div>';
  var r = await api('getAddonsAdmin', { userId: currentUser.userId });
  _addons = r.addons || [];
  renderAddonsView();
}

function renderAddonsView() {
  var el = document.getElementById('addonsView');
  var rowsHtml = _addons.length === 0
    ? '<div style="text-align:center;padding:40px;color:#94a3b8">No add-ons yet. Click <strong>+ Add</strong> to create your first modifier.</div>'
    : _addons.map(function(a) {
      var scopeLabel = a.applies_to_all ? 'All items' : (a.applies_to_codes||[]).join(', ') || 'Specific items';
      return '<div style="background:#fff;border-radius:12px;box-shadow:0 1px 6px rgba(0,0,0,.07);padding:14px 16px;display:flex;align-items:center;gap:12px;margin-bottom:8px;opacity:' + (a.is_active?'1':'.5') + '">'
        + '<div style="flex:1;min-width:0">'
        + '<div style="font-weight:700;font-size:.87rem">' + a.name + ' ' + (a.is_active?'':'<span style="background:#f1f5f9;color:#94a3b8;font-size:.68rem;padding:1px 6px;border-radius:4px">Inactive</span>') + '</div>'
        + '<div style="font-size:.72rem;color:#64748b;margin-top:2px">+₱' + parseFloat(a.price||0).toFixed(2) + ' · ' + scopeLabel + '</div>'
        + '</div>'
        + '<button onclick="openAddonEdit(\'' + a.addon_code + '\')" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:6px 10px;font-size:.78rem;cursor:pointer">Edit</button>'
        + '<button onclick="deleteAddon(\'' + a.addon_code + '\')" style="background:#fef2f2;color:#ef4444;border:none;border-radius:8px;padding:6px 10px;font-size:.78rem;cursor:pointer">Del</button>'
        + '</div>';
    }).join('');

  el.innerHTML = '<div style="padding:16px 16px 0;max-width:960px">'
    + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">'
    + '<div style="font-weight:800;font-size:1.05rem;color:var(--forest-deep)">➕ Add-ons & Modifiers</div>'
    + '<button onclick="openAddonAdd()" style="background:var(--forest-deep);color:#fff;border:none;border-radius:10px;padding:8px 14px;font-size:.82rem;font-weight:700;cursor:pointer">+ Add</button>'
    + '</div>'
    + '<div style="font-size:.75rem;color:#64748b;margin-bottom:12px">Add-ons appear as options when customers add items to their cart.</div>'
    + rowsHtml + '</div>';
}

function addonForm(data) {
  data = data || {};
  var appliesToAll = data.applies_to_all !== false;
  var selectedCodes = data.applies_to_codes || [];

  // Build menu item checkboxes grouped by category
  var cats = {};
  var _menuForAddon = window._menuDataCache || eoMenuData || [];
  _menuForAddon.forEach(function(it) {
    var cat = it.category || 'Other';
    if (!cats[cat]) cats[cat] = [];
    cats[cat].push(it);
  });

  var itemsHtml = '';
  Object.keys(cats).sort().forEach(function(cat) {
    itemsHtml += '<div style="font-size:.72rem;font-weight:700;color:#64748b;text-transform:uppercase;margin:8px 0 4px">' + esc(cat) + '</div>';
    cats[cat].forEach(function(it) {
      var chk = selectedCodes.includes(it.code) ? ' checked' : '';
      itemsHtml += '<label style="display:flex;align-items:center;gap:8px;font-size:.8rem;cursor:pointer;padding:3px 0">'
        + '<input type="checkbox" class="addonItemChk" value="' + esc(it.code) + '"' + chk + '>'
        + esc(it.name) + ' <span style="color:#94a3b8;font-size:.72rem">' + it.code + '</span>'
        + '</label>';
    });
  });

  return '<div style="display:flex;flex-direction:column;gap:10px">'
    + '<label style="font-size:.8rem;font-weight:600">Name<br>'
    + '<input id="addonName" value="' + esc(data.name||'') + '" placeholder="e.g. Extra Shot, Nata De Coco" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px"></label>'
    + '<label style="font-size:.8rem;font-weight:600">Price (₱)<br>'
    + '<input id="addonPrice" type="number" value="' + (data.price||0) + '" min="0" step="1" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px"></label>'
    + '<label style="display:flex;align-items:center;gap:8px;font-size:.8rem;font-weight:600;cursor:pointer">'
    + '<input type="checkbox" id="addonAll" onchange="toggleAddonAllItems(this)"' + (appliesToAll?' checked':'') + '> Apply to ALL menu items</label>'
    + '<div id="addonItemsSection" style="' + (appliesToAll?'display:none':'') + ';border:1px solid #e2e8f0;border-radius:8px;padding:10px;max-height:240px;overflow-y:auto">'
    + '<div style="font-size:.75rem;font-weight:700;color:var(--forest);margin-bottom:6px">Select which drinks/items this applies to:</div>'
    + '<div style="display:flex;gap:8px;margin-bottom:8px">'
    + '<button type="button" onclick="addonCheckAll(true)" style="font-size:.7rem;padding:3px 10px;border:1px solid #e2e8f0;border-radius:6px;cursor:pointer;background:#f8fafc">All</button>'
    + '<button type="button" onclick="addonCheckAll(false)" style="font-size:.7rem;padding:3px 10px;border:1px solid #e2e8f0;border-radius:6px;cursor:pointer;background:#f8fafc">None</button>'
    + '</div>'
    + itemsHtml
    + '</div>'
    + '<label style="display:flex;align-items:center;gap:8px;font-size:.8rem;font-weight:600;cursor:pointer">'
    + '<input type="checkbox" id="addonActive"' + (data.is_active!==false?' checked':'') + '> Active</label>'
    + '<button onclick="saveAddonForm(\'' + (data.addon_code||'') + '\')" style="background:var(--forest-deep);color:#fff;border:none;border-radius:10px;padding:10px;font-weight:700;cursor:pointer;font-size:.9rem">Save</button>'
    + '</div>';
}

function toggleAddonAllItems(cb) {
  document.getElementById('addonItemsSection').style.display = cb.checked ? 'none' : '';
}
function addonCheckAll(val) {
  document.querySelectorAll('.addonItemChk').forEach(function(c){ c.checked = val; });
}

function openAddonAdd() {
  loadMenuCache().then(function() { showModal('New Add-on', addonForm({})); });
}
function openAddonEdit(code) {
  var a = _addons.find(function(x){ return x.addon_code === code; });
  if (!a) return;
  loadMenuCache().then(function() { showModal('Edit Add-on', addonForm(a)); });
}

async function saveAddonForm(existingCode) {
  var appliesToAll = document.getElementById('addonAll').checked;
  var appliesTo = [];
  if (!appliesToAll) {
    document.querySelectorAll('.addonItemChk:checked').forEach(function(c){ appliesTo.push(c.value); });
  }
  var r = await api('saveAddon', {
    userId: currentUser.userId,
    addonCode: existingCode || undefined,
    name: document.getElementById('addonName').value.trim(),
    price: parseFloat(document.getElementById('addonPrice').value) || 0,
    sortOrder: 0,
    appliesToAll: appliesToAll,
    appliesToCodes: appliesTo,
    isActive: document.getElementById('addonActive').checked,
  });
  closeModal();
  if (r.ok) { showToast('Add-on saved ✅'); loadAddonsView(); }
  else showToast('Error: ' + r.error, true);
}

async function deleteAddon(code) {
  if (!confirm('Remove this add-on?')) return;
  var r = await api('deleteAddon', { userId: currentUser.userId, addonCode: code });
  if (r.ok) { showToast('Add-on removed'); loadAddonsView(); }
  else showToast('Error: ' + r.error, true);
}

// ══════════════════════════════════════════════════════════
// VOID / REFUND WORKFLOW
// ══════════════════════════════════════════════════════════
var _refunds = [];

async function loadRefundsView() {
  var el = document.getElementById('refundsView');
  el.innerHTML = '<div style="padding:20px;color:#888">Loading refunds…</div>';
  var r = await api('getRefunds', { userId: currentUser.userId, limit: 50 });
  _refunds = r.refunds || [];
  renderRefundsView();
}

function renderRefundsView() {
  var el = document.getElementById('refundsView');
  var typeColors = { FULL:'#ef4444', PARTIAL:'#f59e0b', VOID:'#8b5cf6' };
  var reasonLabels = { WRONG_ORDER:'Wrong Order', DUPLICATE:'Duplicate', COMPLAINT:'Complaint',
    OVERCHARGE:'Overcharge', ITEM_UNAVAILABLE:'Item N/A', OTHER:'Other' };

  var rowsHtml = _refunds.length === 0
    ? '<div style="text-align:center;padding:40px;color:#94a3b8">No refunds yet.</div>'
    : _refunds.map(function(r) {
      var col = typeColors[r.refund_type] || '#64748b';
      return '<div style="background:#fff;border-radius:12px;box-shadow:0 1px 6px rgba(0,0,0,.07);padding:14px 16px;margin-bottom:8px">'
        + '<div style="display:flex;align-items:center;justify-content:space-between">'
        + '<div>'
        + '<span style="background:' + col + '22;color:' + col + ';border-radius:6px;padding:2px 8px;font-size:.7rem;font-weight:700;margin-right:6px">' + r.refund_type + '</span>'
        + '<span style="font-weight:700;font-size:.85rem">' + r.refund_id + '</span>'
        + '</div>'
        + '<div style="font-weight:800;color:#ef4444">-₱' + parseFloat(r.refund_amount).toFixed(2) + '</div>'
        + '</div>'
        + '<div style="font-size:.75rem;color:#64748b;margin-top:4px">'
        + 'Order: ' + r.order_id + ' · ' + (reasonLabels[r.reason_code]||r.reason_code)
        + (r.reason_note ? ' · ' + r.reason_note : '')
        + ' · ' + (r.refund_method||'—')
        + '</div>'
        + '<div style="font-size:.68rem;color:#94a3b8;margin-top:2px">' + new Date(r.created_at).toLocaleString('en-PH') + ' · ' + (r.processed_by||'—') + '</div>'
        + '</div>';
    }).join('');

  el.innerHTML = '<div style="padding:16px 16px 0;max-width:960px">'
    + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">'
    + '<div style="font-weight:800;font-size:1.05rem;color:var(--forest-deep)">↩️ Void / Refunds</div>'
    + '<button onclick="openRefundForm()" style="background:#ef4444;color:#fff;border:none;border-radius:10px;padding:8px 14px;font-size:.82rem;font-weight:700;cursor:pointer">+ Process</button>'
    + '</div>'
    + rowsHtml + '</div>';
}

function openRefundForm(prefillOrderId) {
  showModal('Process Refund / Void',
    '<div style="display:flex;flex-direction:column;gap:10px">'
    + '<label style="font-size:.8rem;font-weight:600">Order ID<br>'
    + '<input id="rfOrderId" value="' + (prefillOrderId||'') + '" placeholder="ORD-XXXX" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px"></label>'
    + '<label style="font-size:.8rem;font-weight:600">Type<br>'
    + '<select id="rfType" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px">'
    + '<option value="FULL">Full Refund</option><option value="PARTIAL">Partial Refund</option><option value="VOID">Void (Cancel Order)</option>'
    + '</select></label>'
    + '<label style="font-size:.8rem;font-weight:600">Refund Amount (₱)<br>'
    + '<input id="rfAmount" type="number" value="0" min="0" step="0.01" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px"></label>'
    + '<label style="font-size:.8rem;font-weight:600">Reason<br>'
    + '<select id="rfReason" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px">'
    + '<option value="WRONG_ORDER">Wrong Order</option><option value="COMPLAINT">Complaint</option>'
    + '<option value="OVERCHARGE">Overcharge</option><option value="ITEM_UNAVAILABLE">Item Unavailable</option>'
    + '<option value="DUPLICATE">Duplicate Order</option><option value="OTHER">Other</option>'
    + '</select></label>'
    + '<label style="font-size:.8rem;font-weight:600">Notes<br>'
    + '<input id="rfNote" placeholder="Optional details" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px"></label>'
    + '<label style="font-size:.8rem;font-weight:600">Refund Method<br>'
    + '<select id="rfMethod" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px">'
    + '<option value="CASH">Cash</option><option value="GCASH">GCash</option>'
    + '<option value="BANK_TRANSFER">Bank Transfer</option><option value="STORE_CREDIT">Store Credit</option>'
    + '</select></label>'
    + '<div style="background:#fef2f2;border-radius:8px;padding:10px;font-size:.75rem;color:#991b1b">⚠️ Void will also cancel the order in the system and cannot be undone.</div>'
    + '<button onclick="submitRefund()" style="background:#ef4444;color:#fff;border:none;border-radius:10px;padding:10px;font-weight:700;cursor:pointer;font-size:.9rem">Process Refund / Void</button>'
    + '</div>'
  );
}

async function submitRefund() {
  var orderId = document.getElementById('rfOrderId').value.trim();
  var refundType = document.getElementById('rfType').value;
  var refundAmount = parseFloat(document.getElementById('rfAmount').value) || 0;
  var reasonCode = document.getElementById('rfReason').value;
  var reasonNote = document.getElementById('rfNote').value.trim();
  var refundMethod = document.getElementById('rfMethod').value;
  if (!orderId) { showToast('Order ID required', true); return; }
  if (refundType !== 'VOID' && refundAmount <= 0) { showToast('Enter refund amount', true); return; }
  var r = await api('processRefund', {
    userId: currentUser.userId, orderId, refundType, refundAmount, reasonCode, reasonNote, refundMethod
  });
  closeModal();
  if (r.ok) { showToast('Refund processed: ' + r.refundId + ' ✅'); loadRefundsView(); }
  else showToast('Error: ' + r.error, true);
}

// ══════════════════════════════════════════════════════════
// CASH DRAWER / EOD RECONCILIATION
// ══════════════════════════════════════════════════════════
var _openCashSession = null;
var _cashSessions = [];

// ── Cash session automation ─────────────────────────────────────────────────
async function checkCashSessionOnLogin() {
  if (!currentUser) return;
  var r = await api('getOpenCashSession');
  if (!r.ok) return;

  var session = r.session;

  if (!session) {
    // No open session — show banner prompting to open one
    showCashSessionBanner('no_session');
  } else {
    // Session is open — check if it's been open too long (>10h = end-of-day prompt)
    var openedAt = new Date(session.opened_at);
    var hoursOpen = (Date.now() - openedAt.getTime()) / (1000 * 60 * 60);
    if (hoursOpen >= 10) {
      showCashSessionBanner('close_prompt', session, hoursOpen);
    }
    _openCashSession = session;
  }
}

function showCashSessionBanner(type, session, hours) {
  // Remove any existing banner
  var existing = document.getElementById('cashSessionBanner');
  if (existing) existing.remove();

  var banner = document.createElement('div');
  banner.id = 'cashSessionBanner';
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;padding:10px 16px;display:flex;align-items:center;justify-content:space-between;font-size:.82rem;font-weight:600;box-shadow:0 2px 8px rgba(0,0,0,.15)';

  if (type === 'no_session') {
    banner.style.background = '#FEF3C7';
    banner.style.color = '#92400E';
    banner.style.borderBottom = '2px solid #F59E0B';
    banner.innerHTML =
      '<span>⚠️ No cash session open. Open one before taking orders.</span>' +
      '<div style="display:flex;gap:8px">' +
        '<button onclick="setFilter(\'CASH\');document.getElementById(\'cashSessionBanner\').remove()" ' +
          'style="background:#F59E0B;color:#fff;border:none;border-radius:6px;padding:5px 12px;cursor:pointer;font-weight:700;font-size:.78rem">Open Session</button>' +
        '<button onclick="document.getElementById(\'cashSessionBanner\').remove()" ' +
          'style="background:transparent;border:1px solid #F59E0B;border-radius:6px;padding:5px 10px;cursor:pointer;color:#92400E;font-size:.78rem">Dismiss</button>' +
      '</div>';
  } else if (type === 'close_prompt') {
    var h = Math.floor(hours || 0);
    banner.style.background = '#FEE2E2';
    banner.style.color = '#991B1B';
    banner.style.borderBottom = '2px solid #EF4444';
    banner.innerHTML =
      '<span>🔔 Cash session has been open ' + h + ' hours. End of shift — time to close and reconcile.</span>' +
      '<div style="display:flex;gap:8px">' +
        '<button onclick="setFilter(\'CASH\');document.getElementById(\'cashSessionBanner\').remove()" ' +
          'style="background:#EF4444;color:#fff;border:none;border-radius:6px;padding:5px 12px;cursor:pointer;font-weight:700;font-size:.78rem">Close Session</button>' +
        '<button onclick="document.getElementById(\'cashSessionBanner\').remove()" ' +
          'style="background:transparent;border:1px solid #EF4444;border-radius:6px;padding:5px 10px;cursor:pointer;color:#991B1B;font-size:.78rem">Dismiss</button>' +
      '</div>';
  }

  document.body.insertBefore(banner, document.body.firstChild);
  // Auto-dismiss after 30 seconds
  setTimeout(function() { if (banner.parentNode) banner.remove(); }, 30000);
}

async function loadCashView() {
  var el = document.getElementById('cashView');
  el.innerHTML = '<div style="padding:20px;color:#888">Loading cash sessions…</div>';
  var [openR, histR] = await Promise.all([
    api('getOpenCashSession'),
    api('getCashSessions', { userId: currentUser.userId, limit: 10 })
  ]);
  _openCashSession = openR.session || null;
  _cashSessions = histR.sessions || [];
  renderCashView();
}

function renderCashView() {
  var el = document.getElementById('cashView');
  var sessionHtml = '';

  if (_openCashSession) {
    var s = _openCashSession;
    sessionHtml = '<div style="background:linear-gradient(135deg,#064e3b,#065f46);border-radius:16px;padding:18px;color:#fff;margin-bottom:16px">'
      + '<div style="font-size:.72rem;opacity:.7;margin-bottom:2px">OPEN SESSION · ' + (s.shift||'AM') + ' SHIFT</div>'
      + '<div style="font-weight:800;font-size:1.05rem">' + s.session_id + '</div>'
      + '<div style="display:flex;gap:16px;margin-top:10px">'
      + '<div><div style="font-size:.68rem;opacity:.7">Opening Float</div><div style="font-weight:700">₱' + parseFloat(s.opening_float||0).toFixed(2) + '</div></div>'
      + '<div><div style="font-size:.68rem;opacity:.7">Opened At</div><div style="font-weight:700">' + new Date(s.opened_at).toLocaleTimeString('en-PH',{hour:'2-digit',minute:'2-digit'}) + '</div></div>'
      + '<div><div style="font-size:.68rem;opacity:.7">Opened By</div><div style="font-weight:700">' + (s.opened_by||'—') + '</div></div>'
      + '</div>'
      + '<button onclick="openCloseSessionModal()" style="margin-top:12px;width:100%;background:rgba(255,255,255,.15);color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:10px;padding:10px;font-weight:700;cursor:pointer;font-size:.88rem">🔒 Close Session / EOD Count</button>'
      + '</div>';
  } else {
    sessionHtml = '<div style="background:#f0fdf4;border:2px dashed #bbf7d0;border-radius:16px;padding:20px;text-align:center;margin-bottom:16px">'
      + '<div style="font-size:1.5rem;margin-bottom:6px">💵</div>'
      + '<div style="font-weight:700;color:#065f46;margin-bottom:4px">No Open Cash Session</div>'
      + '<div style="font-size:.78rem;color:#64748b;margin-bottom:12px">Open a session at the start of each shift to track cash sales and reconcile at end of day.</div>'
      + '<button onclick="openOpenSessionModal()" style="background:var(--forest-deep);color:#fff;border:none;border-radius:10px;padding:10px 20px;font-weight:700;cursor:pointer">Open Cash Session</button>'
      + '</div>';
  }

  var histHtml = _cashSessions.filter(function(s){ return s.status === 'CLOSED'; }).length === 0
    ? '<div style="text-align:center;padding:20px;color:#94a3b8;font-size:.82rem">No closed sessions yet.</div>'
    : _cashSessions.filter(function(s){ return s.status === 'CLOSED'; }).map(function(s) {
      var varColor = parseFloat(s.variance||0) === 0 ? '#64748b' : parseFloat(s.variance||0) > 0 ? '#22c55e' : '#ef4444';
      var varLabel = parseFloat(s.variance||0) === 0 ? 'Exact' : parseFloat(s.variance||0) > 0 ? 'OVER ₱' + Math.abs(s.variance).toFixed(2) : 'SHORT ₱' + Math.abs(s.variance).toFixed(2);
      return '<div style="background:#fff;border-radius:12px;box-shadow:0 1px 6px rgba(0,0,0,.07);padding:14px 16px;margin-bottom:8px">'
        + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">'
        + '<div><span style="font-weight:700;font-size:.85rem">' + s.session_id + '</span>'
        + ' <span style="font-size:.72rem;color:#64748b">' + (s.shift||'') + '</span></div>'
        + '<span style="font-weight:700;color:' + varColor + ';font-size:.82rem">' + varLabel + '</span>'
        + '</div>'
        + '<div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:6px">'
        + statCard('Float', '₱' + parseFloat(s.opening_float||0).toFixed(0), '#64748b', '#f8fafc')
        + statCard('Cash Sales', '₱' + parseFloat(s.cash_sales||0).toFixed(0), '#0284c7', '#eff6ff')
        + statCard('Expected', '₱' + parseFloat(s.expected_cash||0).toFixed(0), '#065f46', '#f0fdf4')
        + statCard('Counted', '₱' + parseFloat(s.closing_count||0).toFixed(0), varColor, varColor === '#ef4444' ? '#fef2f2' : '#f0fdf4')
        + '</div>'
        + '<div style="font-size:.68rem;color:#94a3b8;margin-top:6px">'
        + new Date(s.opened_at).toLocaleDateString('en-PH',{month:'short',day:'numeric'})
        + ' ' + new Date(s.opened_at).toLocaleTimeString('en-PH',{hour:'2-digit',minute:'2-digit'})
        + ' → ' + (s.closed_at ? new Date(s.closed_at).toLocaleTimeString('en-PH',{hour:'2-digit',minute:'2-digit'}) : '—')
        + ' · ' + (s.closed_by||'—')
        + (s.notes ? ' · ' + s.notes : '')
        + '</div></div>';
    }).join('');

  el.innerHTML = '<div style="padding:16px 16px 0;max-width:960px">'
    + '<div style="font-weight:800;font-size:1.05rem;color:var(--forest-deep);margin-bottom:14px">💵 Cash Drawer</div>'
    + sessionHtml
    + '<div style="font-weight:700;font-size:.85rem;color:#475569;margin-bottom:8px">Session History</div>'
    + histHtml + '</div>';
}

function openOpenSessionModal() {
  var shiftSel = '<select id="cashShift" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px">'
    + '<option value="AM">AM Shift</option><option value="PM">PM Shift</option>'
    + '<option value="FULL">Full Day</option><option value="CUSTOM">Custom</option></select>';
  showModal('Open Cash Session',
    '<div style="display:flex;flex-direction:column;gap:10px">'
    + '<label style="font-size:.8rem;font-weight:600">Shift<br>' + shiftSel + '</label>'
    + '<label style="font-size:.8rem;font-weight:600">Opening Float (₱) — Cash in drawer at start<br>'
    + '<input id="cashFloat" type="number" value="500" min="0" step="50" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px"></label>'
    + '<button onclick="doOpenSession()" style="background:var(--forest-deep);color:#fff;border:none;border-radius:10px;padding:10px;font-weight:700;cursor:pointer;font-size:.9rem">Open Session</button>'
    + '</div>'
  );
}

async function doOpenSession() {
  var r = await api('openCashSession', {
    userId: currentUser.userId,
    shift: document.getElementById('cashShift').value,
    openingFloat: parseFloat(document.getElementById('cashFloat').value) || 0,
  });
  closeModal();
  if (r.ok) { showToast('Cash session opened ✅'); loadCashView(); }
  else showToast(r.error || 'Error', true);
}

function openCloseSessionModal() {
  if (!_openCashSession) return;
  var denominations = [1000, 500, 200, 100, 50, 20, 10, 5, 1];
  var denomHtml = denominations.map(function(d) {
    return '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">'
      + '<span style="min-width:50px;font-size:.8rem;font-weight:600">₱' + d + '</span>'
      + '<input type="number" id="denom_' + d + '" value="0" min="0" placeholder="0" '
      + 'oninput="calcDenomTotal()" '
      + 'style="width:80px;padding:6px;border:1px solid #e2e8f0;border-radius:7px;font-size:.85rem">'
      + '<span style="font-size:.78rem;color:#64748b">pcs</span>'
      + '<span id="denomAmt_' + d + '" style="font-size:.78rem;color:#475569;min-width:60px;text-align:right">= ₱0</span>'
      + '</div>';
  }).join('');

  showModal('Close Session — EOD Count',
    '<div style="display:flex;flex-direction:column;gap:10px">'
    + '<div style="font-size:.8rem;font-weight:700;color:#475569;margin-bottom:4px">Count denominations (or enter total directly):</div>'
    + denomHtml
    + '<div style="background:#f8fafc;border-radius:10px;padding:10px;display:flex;justify-content:space-between;align-items:center">'
    + '<span style="font-weight:700;font-size:.85rem">Total Counted:</span>'
    + '<span id="denomTotal" style="font-weight:800;font-size:1.05rem;color:var(--forest-deep)">₱0.00</span>'
    + '</div>'
    + '<label style="font-size:.8rem;font-weight:600">Or enter total directly (₱):<br>'
    + '<input id="cashClosingCount" type="number" value="" placeholder="Leave blank to use denomination count" '
    + 'style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px"></label>'
    + '<label style="font-size:.8rem;font-weight:600">Notes<br>'
    + '<input id="cashCloseNotes" placeholder="Optional shift notes" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;margin-top:3px"></label>'
    + '<button onclick="doCloseSession()" style="background:#064e3b;color:#fff;border:none;border-radius:10px;padding:10px;font-weight:700;cursor:pointer;font-size:.9rem">Close Session & Reconcile</button>'
    + '</div>'
  );
}

function calcDenomTotal() {
  var denominations = [1000,500,200,100,50,20,10,5,1];
  var total = 0;
  denominations.forEach(function(d) {
    var count = parseInt(document.getElementById('denom_' + d).value) || 0;
    var amt = count * d;
    total += amt;
    document.getElementById('denomAmt_' + d).textContent = '= ₱' + amt.toLocaleString();
  });
  document.getElementById('denomTotal').textContent = '₱' + total.toLocaleString('en-PH', {minimumFractionDigits:2});
  // Update closing count field
  var ccInput = document.getElementById('cashClosingCount');
  if (ccInput && !ccInput.value) ccInput.placeholder = total.toFixed(2);
}

async function doCloseSession() {
  var denominations = [1000,500,200,100,50,20,10,5,1];
  var denomBreakdown = {};
  var denomTotal = 0;
  denominations.forEach(function(d) {
    var count = parseInt(document.getElementById('denom_' + d).value) || 0;
    if (count > 0) { denomBreakdown[d] = count; denomTotal += count * d; }
  });
  var manualTotal = parseFloat(document.getElementById('cashClosingCount').value);
  var closingCount = isNaN(manualTotal) ? denomTotal : manualTotal;
  var r = await api('closeCashSession', {
    userId: currentUser.userId,
    sessionId: _openCashSession.session_id,
    closingCount: closingCount,
    denominationBreakdown: denomBreakdown,
    notes: document.getElementById('cashCloseNotes').value,
  });
  closeModal();
  if (r.ok) {
    var msg = '✅ Session closed — ' + r.overShort
      + ' | Total Sales: ₱' + parseFloat(r.totalSales).toFixed(2);
    showToast(msg);
    loadCashView();
  } else showToast('Error: ' + r.error, true);
}

// ══════════════════════════════════════════════════════════
// QUICK REFUND button on order cards
// ══════════════════════════════════════════════════════════
function showRefundFromOrder(orderId) {
  setFilter('REFUNDS');
  setTimeout(function() { openRefundForm(orderId); }, 300);
}
