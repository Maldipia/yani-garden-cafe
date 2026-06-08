// ── Post-order review funnel ──────────────────────────────────────────────
// Public, customer-facing. After an order completes the customer sees a star
// rating. 4-5 stars → routed to the public Google review page (routed_public).
// 1-3 stars → private feedback captured in the `reviews` table only (it never
// becomes a public review). Everything is logged so the owner can read it.
//
// Actions:
//   getReviewConfig  → returns the configured Google review URL for the client
//   submitReview     → logs a rating (+ optional private feedback) and returns
//                      the review URL so the client can redirect happy customers
// ───────────────────────────────────────────────────────────────────────────
import { supa, supaFetch, getSetting, logSync } from '../lib/db.js';
import { SUPABASE_URL } from '../lib/config.js';
import { isValidOrderId } from '../lib/validation.js';

const FEEDBACK_MAX = 2000;

export async function routeReviews(action, body, auth, req, res) {
  const { checkAdminAuth } = auth;

  // ── getReviewAlert (ADMIN/OWNER only) ──────────────────────────────────
  // Lightweight badge feed: how many NEW low (1-3 star) reviews exist since the
  // id the admin last saw, plus the latest review id so the client can mark
  // them seen when the tab is opened.
  if (action === 'getReviewAlert') {
    const a = await checkAdminAuth();
    if (!a.ok) return res.status(403).json({ ok: false, error: a.error });
    const sinceId = Number(body.sinceId) || 0;
    const lowR = await supaFetch(
      `${SUPABASE_URL}/rest/v1/reviews?select=id&rating=lte.3&id=gt.${sinceId}&limit=1000`
    );
    const newLow = (lowR.ok && Array.isArray(lowR.data)) ? lowR.data.length : 0;
    const maxR = await supaFetch(
      `${SUPABASE_URL}/rest/v1/reviews?select=id&order=id.desc&limit=1`
    );
    const latestId = (maxR.ok && Array.isArray(maxR.data) && maxR.data[0]) ? maxR.data[0].id : 0;
    return res.status(200).json({ ok: true, newLow, latestId });
  }

  // The funnel deliberately has NO public read path. Reading captured reviews
  // (including private 1-3 star feedback) requires staff auth.
  if (action === 'getReviews') {
    const a = await checkAdminAuth();
    if (!a.ok) return res.status(403).json({ ok: false, error: a.error });

    const r = await supaFetch(
      `${SUPABASE_URL}/rest/v1/reviews?select=id,order_id,table_no,rating,feedback,routed_public,created_at&order=created_at.desc&limit=1000`
    );
    if (!r.ok) return res.status(500).json({ ok: false, error: 'Failed to load reviews' });
    const rows = Array.isArray(r.data) ? r.data : [];

    const total = rows.length;
    const sum = rows.reduce((acc, x) => acc + (Number(x.rating) || 0), 0);
    const avg = total ? Math.round((sum / total) * 100) / 100 : 0;
    const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    rows.forEach(x => { const n = Number(x.rating); if (dist[n] != null) dist[n]++; });
    const low = rows.filter(x => Number(x.rating) <= 3);
    const lowCount = low.length;
    const withFeedback = rows.filter(x => x.feedback && String(x.feedback).trim()).length;
    const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const last7 = rows.filter(x => new Date(x.created_at).getTime() >= since).length;

    return res.status(200).json({
      ok: true,
      stats: { total, avg, dist, lowCount, withFeedback, last7 },
      reviews: rows,
    });
  }

  // ── getReviewConfig (public) ───────────────────────────────────────────
  // Lightweight read of the Google review URL so the customer app knows where
  // to send 4-5 star reviewers. Safe to expose — it's a public review link.
  if (action === 'getReviewConfig') {
    const reviewUrl = await getSetting('GOOGLE_REVIEW_URL');
    return res.status(200).json({ ok: true, reviewUrl: reviewUrl || '' });
  }

  // ── submitReview (public) ──────────────────────────────────────────────
  // Records one review. rating is required (1-5). feedback + orderId optional.
  if (action === 'submitReview') {
    const ratingNum = Number(body.rating);
    if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
      return res.status(400).json({ ok: false, error: 'rating must be an integer 1-5' });
    }

    // orderId is optional, but if present it must be well-formed.
    let orderId = body.orderId ? String(body.orderId).trim() : null;
    if (orderId && !isValidOrderId(orderId)) {
      // Don't hard-fail the customer over a malformed id — just drop it so the
      // rating still gets logged.
      orderId = null;
    }

    let feedback = body.feedback != null ? String(body.feedback).trim() : '';
    if (feedback.length > FEEDBACK_MAX) feedback = feedback.slice(0, FEEDBACK_MAX);

    const tableNo = body.tableNo != null ? String(body.tableNo).slice(0, 20) : null;
    const ua = String(req.headers['user-agent'] || '').slice(0, 300);

    const row = {
      order_id:      orderId,
      table_no:      tableNo,
      rating:        ratingNum,
      feedback:      feedback || null,
      routed_public: ratingNum >= 4,
      source:        'dine_in',
      user_agent:    ua,
    };

    const r = await supa('POST', 'reviews', row);
    if (!r.ok) {
      console.error('submitReview insert failed:', r.status, r.data);
      return res.status(500).json({ ok: false, error: 'Failed to save review' });
    }

    const saved = Array.isArray(r.data) ? r.data[0] : r.data;
    logSync('reviews', saved && saved.id, 'INSERT');

    const reviewUrl = await getSetting('GOOGLE_REVIEW_URL');
    return res.status(200).json({
      ok: true,
      id: saved && saved.id,
      routedPublic: ratingNum >= 4,
      reviewUrl: reviewUrl || '',
    });
  }

  return false;
}
