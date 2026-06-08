// ── ADMIN: Reviews tab ─────────────────────────────────────────────────────
// Reads via the auth-protected getReviews action (reviews table is RLS-locked
// with no public policies, so the anon client cannot read it — only the
// service-role backend can). Shows rating summary + recent feedback, with
// 1-3 star reviews flagged so complaints get noticed.
// ───────────────────────────────────────────────────────────────────────────
var _reviewsData = null;
var _reviewsFilter = 'all'; // 'all' | 'low'

async function loadReviewsView() {
  var view = document.getElementById('reviewsView');
  if (!view) return;
  view.innerHTML = '<div style="padding:32px;text-align:center;color:var(--timber)">Loading reviews…</div>';
  try {
    var r = await api('getReviews');
    if (!r || !r.ok) {
      view.innerHTML = '<div style="padding:32px;text-align:center;color:#dc2626">Could not load reviews. ' +
        esc((r && r.error) || 'Unknown error') + '</div>';
      return;
    }
    _reviewsData = r;
    renderReviewsView();
  } catch (e) {
    view.innerHTML = '<div style="padding:32px;text-align:center;color:#dc2626">Could not load reviews. ' +
      esc(e.message || String(e)) + '</div>';
  }
}

function _revStars(n) {
  n = Number(n) || 0;
  var s = '';
  for (var i = 1; i <= 5; i++) s += (i <= n) ? '★' : '☆';
  return s;
}

function _revDate(iso) {
  try {
    return new Date(iso).toLocaleString('en-PH', {
      timeZone: 'Asia/Manila', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true
    });
  } catch (e) { return esc(String(iso || '')); }
}

function setReviewsFilter(f) { _reviewsFilter = f; renderReviewsView(); }

function renderReviewsView() {
  var view = document.getElementById('reviewsView');
  if (!view || !_reviewsData) return;
  var st = _reviewsData.stats || { total: 0, avg: 0, dist: {}, lowCount: 0, withFeedback: 0, last7: 0 };
  var rows = _reviewsData.reviews || [];

  var html = '<div style="max-width:1100px;margin:0 auto">';

  // Header + refresh
  html += '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin:4px 0 18px">' +
    '<div style="display:flex;align-items:center;gap:10px">' +
      '<span style="font-size:1.4rem">⭐</span>' +
      '<div><div style="font-family:var(--font-soul);font-weight:700;font-size:1.15rem;color:var(--forest-deep)">Reviews</div>' +
      '<div style="font-size:.7rem;color:var(--timber)">Customer feedback · 4–5★ go to Google, 1–3★ stay private here</div></div>' +
    '</div>' +
    '<button onclick="loadReviewsView()" style="background:var(--mist-light,#eef2ee);border:none;border-radius:10px;padding:8px 14px;font-size:.78rem;font-weight:700;color:var(--forest-deep);cursor:pointer">↻ Refresh</button>' +
  '</div>';

  // Stat cards
  function card(label, value, sub, color) {
    return '<div style="flex:1;min-width:140px;background:var(--white);border-radius:14px;padding:16px;box-shadow:var(--shadow-sm)">' +
      '<div style="font-size:.72rem;color:var(--timber);font-weight:600;text-transform:uppercase;letter-spacing:.5px">' + label + '</div>' +
      '<div style="font-size:1.5rem;font-weight:800;color:' + (color || 'var(--forest-deep)') + ';margin-top:4px">' + value + '</div>' +
      (sub ? '<div style="font-size:.72rem;color:var(--timber);margin-top:2px">' + sub + '</div>' : '') +
    '</div>';
  }
  var avgDisplay = st.total ? (st.avg.toFixed(2) + ' <span style="color:#F59E0B;font-size:1.1rem">' + _revStars(Math.round(st.avg)) + '</span>') : '—';
  html += '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:18px">';
  html += card('Average', avgDisplay, st.total + ' total review' + (st.total === 1 ? '' : 's'));
  html += card('Last 7 days', String(st.last7 || 0), 'new ratings');
  html += card('Needs attention', String(st.lowCount || 0), '1–3★ low ratings', (st.lowCount > 0) ? '#dc2626' : 'var(--forest-deep)');
  html += card('With feedback', String(st.withFeedback || 0), 'wrote a comment');
  html += '</div>';

  // Distribution bars
  if (st.total) {
    html += '<div style="background:var(--white);border-radius:14px;padding:16px 18px;box-shadow:var(--shadow-sm);margin-bottom:18px">';
    html += '<div style="font-size:.8rem;font-weight:700;color:var(--forest-deep);margin-bottom:10px">Rating breakdown</div>';
    for (var k = 5; k >= 1; k--) {
      var c = (st.dist && st.dist[k]) ? st.dist[k] : 0;
      var pct = st.total ? Math.round((c / st.total) * 100) : 0;
      var barColor = (k >= 4) ? '#16a34a' : (k === 3 ? '#F59E0B' : '#dc2626');
      html += '<div style="display:flex;align-items:center;gap:10px;margin:5px 0">' +
        '<div style="width:46px;font-size:.78rem;color:#F59E0B;font-weight:700">' + k + '★</div>' +
        '<div style="flex:1;background:var(--mist,#eef2ee);border-radius:6px;height:14px;overflow:hidden">' +
          '<div style="width:' + pct + '%;height:100%;background:' + barColor + '"></div>' +
        '</div>' +
        '<div style="width:54px;text-align:right;font-size:.74rem;color:var(--timber)">' + c + ' (' + pct + '%)</div>' +
      '</div>';
    }
    html += '</div>';
  }

  // Filter toggle
  html += '<div style="display:flex;gap:8px;margin-bottom:12px">';
  html += '<button onclick="setReviewsFilter(\'all\')" style="padding:6px 14px;border-radius:20px;border:none;font-size:.76rem;font-weight:700;cursor:pointer;background:' + (_reviewsFilter === 'all' ? 'var(--forest)' : 'var(--mist-light,#eef2ee)') + ';color:' + (_reviewsFilter === 'all' ? '#fff' : 'var(--timber)') + '">All (' + rows.length + ')</button>';
  html += '<button onclick="setReviewsFilter(\'low\')" style="padding:6px 14px;border-radius:20px;border:none;font-size:.76rem;font-weight:700;cursor:pointer;background:' + (_reviewsFilter === 'low' ? '#dc2626' : 'var(--mist-light,#eef2ee)') + ';color:' + (_reviewsFilter === 'low' ? '#fff' : 'var(--timber)') + '">Needs attention (' + (st.lowCount || 0) + ')</button>';
  html += '</div>';

  // List
  var list = (_reviewsFilter === 'low') ? rows.filter(function (x) { return Number(x.rating) <= 3; }) : rows;
  if (!list.length) {
    html += '<div style="background:var(--white);border-radius:14px;padding:40px;text-align:center;color:var(--timber);box-shadow:var(--shadow-sm)">' +
      (rows.length ? 'No reviews in this filter.' : 'No reviews yet. They\'ll appear here once customers start rating completed orders. 🌿') +
    '</div>';
  } else {
    list.forEach(function (x) {
      var low = Number(x.rating) <= 3;
      var borderCol = low ? '#dc2626' : '#16a34a';
      var meta = [];
      if (x.table_no) meta.push('Table ' + esc(String(x.table_no)));
      if (x.order_id) meta.push(esc(String(x.order_id)));
      meta.push(_revDate(x.created_at));
      html += '<div style="background:var(--white);border-left:4px solid ' + borderCol + ';border-radius:10px;padding:14px 16px;box-shadow:var(--shadow-sm);margin-bottom:10px">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">' +
          '<div style="font-size:1.05rem;color:#F59E0B;font-weight:700;letter-spacing:1px">' + _revStars(x.rating) +
            '<span style="font-size:.78rem;color:var(--timber);margin-left:8px;letter-spacing:0">' + x.rating + '/5</span></div>' +
          '<div style="font-size:.72rem;color:var(--timber)">' + meta.join(' · ') + '</div>' +
        '</div>';
      if (x.feedback && String(x.feedback).trim()) {
        html += '<div style="margin-top:8px;font-size:.85rem;color:#374151;line-height:1.5;background:' + (low ? '#fef2f2' : '#f0fdf4') + ';border-radius:8px;padding:10px 12px">' + esc(String(x.feedback)) + '</div>';
      }
      if (!low && x.routed_public) {
        html += '<div style="margin-top:6px;font-size:.68rem;color:#16a34a;font-weight:600">→ Sent to Google review page</div>';
      }
      html += '</div>';
    });
  }

  html += '</div>';
  view.innerHTML = html;
}
