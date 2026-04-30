// ── /api/events-inquiry — Wedding/Events lead form handler ─────────────
// Receives form submission from /events.html, emails to ops + sends
// confirmation to client. Uses existing Resend integration. NO database
// dependency — keeps the cafe POS fully isolated.

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const OPS_EMAIL      = process.env.EVENTS_OPS_EMAIL || 'maldipia@gmail.com';
const FROM_EMAIL     = 'YANI Garden Cafe <events@yanigardencafe.com>';

// Simple in-memory rate limit: 5 submissions per IP per hour
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 5;

function checkRateLimit(ip) {
  const now = Date.now();
  const record = rateLimitMap.get(ip);
  if (!record || now - record.firstHit > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, firstHit: now });
    return true;
  }
  if (record.count >= RATE_LIMIT_MAX) return false;
  record.count++;
  return true;
}

// Cleanup old rate-limit entries every 10 min
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [ip, rec] of rateLimitMap.entries()) {
    if (rec.firstHit < cutoff) rateLimitMap.delete(ip);
  }
}, 10 * 60 * 1000).unref?.();

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

// Decision engine — recommend a package from guest count
function recommendPackage(pax) {
  if (pax <= 40) return 'Intimate';
  if (pax <= 60) return 'Signature';
  if (pax <= 70) return 'Full Experience';
  return 'Custom (over 70 guests)';
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-PH', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });
  } catch { return dateStr; }
}

async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY) {
    console.error('RESEND_API_KEY not configured');
    return false;
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM_EMAIL, to: Array.isArray(to)?to:[to], subject, html }),
    });
    if (!r.ok) {
      console.error('Resend error', r.status, await r.text().catch(()=>''));
      return false;
    }
    return true;
  } catch (e) {
    console.error('Email send failed:', e.message);
    return false;
  }
}

// ── Email templates ─────────────────────────────────────────────────────

function emailToClient(data) {
  const recommended = recommendPackage(data.pax);
  const subject = `Your Inquiry Received — YANI Garden Cafe`;
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F5F1E8;font-family:Georgia,'Times New Roman',serif;color:#1A1A1A">
  <div style="max-width:600px;margin:32px auto;background:#fff;padding:0;box-shadow:0 1px 3px rgba(0,0,0,.06)">
    <div style="background:#0F4C3A;padding:36px 32px;text-align:center">
      <div style="color:#B8956A;font-size:11px;letter-spacing:3px;text-transform:uppercase;font-family:Arial,sans-serif;margin-bottom:8px">YANI Garden Cafe</div>
      <div style="color:#F5F1E8;font-size:22px;letter-spacing:.5px">Your Inquiry Has Been Received</div>
      <div style="width:40px;height:1px;background:#B8956A;margin:18px auto 0"></div>
    </div>
    <div style="padding:40px 36px;line-height:1.7;font-size:15px">
      <p style="margin:0 0 18px">Dear ${escapeHtml(data.fullName)},</p>
      <p style="margin:0 0 18px">Thank you for considering YANI Garden Cafe for your upcoming celebration. We have received your inquiry for a <strong>${escapeHtml(data.eventType)}</strong> on <strong>${formatDate(data.eventDate)}</strong>.</p>
      <p style="margin:0 0 18px">Based on your estimated <strong>${data.pax} guests</strong>, our team will prepare a personalized proposal recommending our <em>${recommended}</em> package. You will receive the full proposal — including a complete investment breakdown and our event agreement — within twenty-four hours.</p>
      <p style="margin:0 0 18px">Should you wish to arrange a private viewing of the venue in advance, please reply to this email and we will gladly coordinate a convenient time.</p>
      <p style="margin:32px 0 8px">Warm regards,</p>
      <p style="margin:0;font-style:italic;color:#0F4C3A">The Events Team<br>YANI Garden Cafe<br>Amadeo, Cavite</p>
    </div>
    <div style="background:#FAF7F0;padding:20px;text-align:center;border-top:1px solid #B8956A30">
      <div style="font-size:11px;color:#4A4A4A;font-family:Arial,sans-serif;letter-spacing:.5px">events@yanigardencafe.com  ·  yanigardencafe.com</div>
    </div>
  </div>
</body></html>`;
  return { subject, html };
}

function emailToOps(data, ipAddress) {
  const recommended = recommendPackage(data.pax);
  const subject = `🌿 New Events Inquiry: ${data.fullName} — ${data.eventType} (${data.pax} pax)`;
  const html = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;color:#1A1A1A;background:#f5f5f5;padding:20px">
  <div style="max-width:640px;margin:0 auto;background:#fff;padding:24px;border-radius:8px">
    <h2 style="color:#0F4C3A;margin:0 0 4px">New Events Inquiry</h2>
    <p style="color:#666;font-size:13px;margin:0 0 24px">Recommended package: <strong style="color:#B8956A">${recommended}</strong></p>

    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <tr><td style="padding:8px 0;width:160px;color:#666">Name</td><td><strong>${escapeHtml(data.fullName)}</strong></td></tr>
      <tr><td style="padding:8px 0;color:#666">Email</td><td><a href="mailto:${escapeHtml(data.email)}">${escapeHtml(data.email)}</a></td></tr>
      <tr><td style="padding:8px 0;color:#666">Phone / Viber</td><td><a href="tel:${escapeHtml(data.phone)}">${escapeHtml(data.phone)}</a></td></tr>
      <tr><td colspan="2"><hr style="border:none;border-top:1px solid #eee;margin:8px 0"></td></tr>
      <tr><td style="padding:8px 0;color:#666">Event Type</td><td>${escapeHtml(data.eventType)}</td></tr>
      <tr><td style="padding:8px 0;color:#666">Preferred Date</td><td><strong>${formatDate(data.eventDate)}</strong></td></tr>
      <tr><td style="padding:8px 0;color:#666">Alternative Date</td><td>${data.altDate ? formatDate(data.altDate) : '—'}</td></tr>
      <tr><td style="padding:8px 0;color:#666">Time of Day</td><td>${escapeHtml(data.timeOfDay) || '—'}</td></tr>
      <tr><td style="padding:8px 0;color:#666">Estimated Guests</td><td><strong>${data.pax}</strong></td></tr>
      <tr><td style="padding:8px 0;color:#666">Budget Range</td><td>${escapeHtml(data.budget) || '—'}</td></tr>
      ${data.message ? `<tr><td colspan="2"><hr style="border:none;border-top:1px solid #eee;margin:8px 0"></td></tr>
      <tr><td style="padding:8px 0;color:#666;vertical-align:top">Message / Vision</td><td style="padding:8px 0;line-height:1.5">${escapeHtml(data.message)}</td></tr>` : ''}
    </table>

    <div style="margin-top:24px;padding:14px;background:#F5F1E8;border-left:3px solid #B8956A;font-size:13px;color:#666">
      <strong>Action:</strong> Send full proposal within 24 hours. Reply directly to this email to start the conversation with the client.
    </div>

    <p style="margin-top:24px;font-size:11px;color:#999">Submitted from IP ${escapeHtml(ipAddress)} · ${new Date().toISOString()}</p>
  </div>
</body></html>`;
  return { subject, html };
}

// ── Handler ─────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'POST only' });

  const ip = (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown').split(',')[0].trim();

  if (!checkRateLimit(ip)) {
    return res.status(429).json({ ok:false, error:'Too many submissions. Please try again later.' });
  }

  const body = req.body || {};

  // Validation
  const required = ['fullName','email','phone','eventType','pax','eventDate'];
  for (const f of required) {
    if (!body[f] || (typeof body[f]==='string' && !body[f].trim())) {
      return res.status(400).json({ ok:false, error:`Missing required field: ${f}` });
    }
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
    return res.status(400).json({ ok:false, error:'Invalid email' });
  }
  const pax = parseInt(body.pax, 10);
  if (isNaN(pax) || pax < 1 || pax > 100) {
    return res.status(400).json({ ok:false, error:'Guest count must be 1–100' });
  }

  const data = {
    fullName:  String(body.fullName).trim().slice(0, 200),
    email:     String(body.email).trim().toLowerCase().slice(0, 200),
    phone:     String(body.phone).trim().slice(0, 50),
    eventType: String(body.eventType).trim().slice(0, 50),
    pax:       pax,
    eventDate: String(body.eventDate).trim().slice(0, 20),
    altDate:   body.altDate ? String(body.altDate).trim().slice(0, 20) : null,
    timeOfDay: body.timeOfDay ? String(body.timeOfDay).trim().slice(0, 30) : null,
    budget:    body.budget ? String(body.budget).trim().slice(0, 50) : null,
    message:   body.message ? String(body.message).trim().slice(0, 2000) : null,
  };

  // Send emails (fire-and-forget after response would be bad on Vercel,
  // so we await — but we don't fail the inquiry if ONE email fails)
  const opsMail = emailToOps(data, ip);
  const clientMail = emailToClient(data);

  const [opsOk, clientOk] = await Promise.all([
    sendEmail(OPS_EMAIL, opsMail.subject, opsMail.html),
    sendEmail(data.email, clientMail.subject, clientMail.html),
  ]);

  // Always log to Vercel runtime logs for backup recovery
  console.log('EVENTS_INQUIRY_RECEIVED', JSON.stringify({
    ts: new Date().toISOString(),
    ip,
    opsEmailSent: opsOk,
    clientEmailSent: clientOk,
    data,
  }));

  if (!opsOk) {
    // Critical failure — log so we can recover
    console.error('CRITICAL: Ops email failed for inquiry', data.email);
  }

  return res.status(200).json({
    ok: true,
    inquiryId: `INQ-${Date.now()}`,
    message: 'Thank you. Your inquiry has been received.',
  });
};
