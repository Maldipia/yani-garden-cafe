// ── Payment-proof OCR via Google Cloud Vision ─────────────────────────────
// Reads a GCash / bank-transfer screenshot and extracts the amount + reference
// number. Activates only when GOOGLE_VISION_API_KEY is set; otherwise returns
// { available:false } and the caller falls back to the manual review queue.
//
// Design notes:
//  - Uses the Vision REST API (TEXT_DETECTION) with an API key — no SDK needed.
//  - Parsing is deliberately conservative: if we cannot confidently read the
//    amount, we return amount:null so the caller HOLDS for manual review rather
//    than guessing (never auto-credit on a shaky read).

const VISION_KEY = process.env.GOOGLE_VISION_API_KEY || '';

export function ocrAvailable() {
  return !!VISION_KEY;
}

// Pull the raw text out of a base64 image using Google Vision.
async function visionDetectText(base64) {
  const url = `https://vision.googleapis.com/v1/images:annotate?key=${VISION_KEY}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [{
        image: { content: base64 },
        features: [{ type: 'TEXT_DETECTION', maxResults: 1 }],
      }],
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Vision API ${resp.status}: ${t.slice(0, 200)}`);
  }
  const data = await resp.json();
  const text = data?.responses?.[0]?.fullTextAnnotation?.text
            || data?.responses?.[0]?.textAnnotations?.[0]?.description
            || '';
  return text;
}

// Extract a peso amount from OCR text. Returns the most likely payment amount.
// GCash/bank receipts show the amount prominently, often prefixed with ₱ / PHP
// and near words like "Amount", "Sent", "Total". We prefer amounts near those
// keywords; otherwise we take the largest well-formed peso amount.
function parseAmount(text) {
  if (!text) return null;
  const lines = text.split(/\n+/);
  // Regex for peso amounts: ₱1,000.00 | PHP 1000 | 1,000.00
  const amtRe = /(?:₱|php|p)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i;
  const keyword = /(amount|sent|total|paid|transfer)/i;

  const candidates = [];
  for (const line of lines) {
    const m = line.match(amtRe);
    if (!m) continue;
    const num = parseFloat(m[1].replace(/,/g, ''));
    if (isNaN(num) || num < 1 || num > 100000) continue;
    candidates.push({ num, nearKeyword: keyword.test(line) });
  }
  if (!candidates.length) return null;
  // Prefer a value on a line that also mentions amount/sent/total
  const kw = candidates.filter(c => c.nearKeyword);
  if (kw.length) return kw.sort((a, b) => b.num - a.num)[0].num;
  // Otherwise the largest plausible amount
  return candidates.sort((a, b) => b.num - a.num)[0].num;
}

// Extract a reference number: "Ref No. 1234567890", "Reference No", etc.
function parseReference(text) {
  if (!text) return null;
  // Look for a label then a run of 6-20 digits (optionally with spaces/dashes)
  const refLabel = /(?:ref(?:erence)?\.?\s*(?:no\.?|number|#)?)\s*[:\-]?\s*([0-9][0-9 \-]{5,20}[0-9])/i;
  const m = text.match(refLabel);
  if (m) return m[1].replace(/[ \-]/g, '');
  // Fallback: a lone long digit run (10-15 digits) — typical GCash ref length
  const lone = text.match(/\b([0-9]{10,15})\b/);
  return lone ? lone[1] : null;
}

// Main entry: read a payment proof. Returns:
//   { available:false }                              → no key configured
//   { available:true, ok:false, error }              → OCR call failed
//   { available:true, ok:true, amount, reference, rawText }
export async function ocrReadProof(base64) {
  if (!VISION_KEY) return { available: false };
  try {
    const text = await visionDetectText(base64);
    return {
      available: true,
      ok: true,
      amount: parseAmount(text),
      reference: parseReference(text),
      rawText: (text || '').slice(0, 500),
    };
  } catch (e) {
    return { available: true, ok: false, error: e.message };
  }
}
