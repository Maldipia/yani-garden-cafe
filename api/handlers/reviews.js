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
import { supa, getSetting, logSync } from '../lib/db.js';
import { isValidOrderId } from '../lib/validation.js';

const FEEDBACK_MAX = 2000;

export async function routeReviews(action, body, auth, req, res) {

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
