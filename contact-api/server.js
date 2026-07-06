// Beacon Legal Group — contact-form email endpoint.
// POST /api/contact  { fullName, businessName?, contactNumber, email }
//   → sends a formatted HTML enquiry email to CONTACT_TO via Office365 SMTP.
// Listens on 127.0.0.1 only; nginx reverse-proxies /api/contact to it.
require('dotenv').config();
const express = require('express');
const nodemailer = require('nodemailer');

const PORT = Number(process.env.CONTACT_PORT || 8081);
const TO = process.env.CONTACT_TO || 'joe@beaconlegalgroup.co.uk';
const SMTP_USER = process.env.IRL_EMAIL_USER;
const SMTP_PASS = process.env.IRL_EMAIL_PASS;

if (!SMTP_USER || !SMTP_PASS) {
  console.error('[contact-api] FATAL: IRL_EMAIL_USER / IRL_EMAIL_PASS not set');
  process.exit(1);
}

const transporter = nodemailer.createTransport({
  host: 'smtp.office365.com', port: 587, secure: false,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
  tls: { ciphers: 'SSLv3' },
});

const app = express();
app.set('trust proxy', 1); // behind nginx — real IP is in X-Forwarded-For
app.use(express.json({ limit: '10kb' }));

// Simple in-memory per-IP rate limit: max 5 submissions per hour.
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now(), windowMs = 60 * 60 * 1000, max = 5;
  const arr = (hits.get(ip) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) { hits.set(ip, arr); return true; }
  arr.push(now); hits.set(ip, arr);
  return false;
}
// Periodic cleanup so the map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of hits) {
    const keep = arr.filter(t => now - t < 60 * 60 * 1000);
    if (keep.length) hits.set(ip, keep); else hits.delete(ip);
  }
}, 15 * 60 * 1000).unref();

const esc = (s) => String(s || '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clean = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const emailOk = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

function renderHtml(d) {
  const row = (label, val) => `
    <tr>
      <td style="padding:10px 14px;border-bottom:1px solid #eef0f4;font-size:13px;color:#6b7280;font-weight:600;width:170px;">${label}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #eef0f4;font-size:14px;color:#111827;">${val || '<span style="color:#9ca3af;">—</span>'}</td>
    </tr>`;
  return `
  <div style="background:#f4f6fb;padding:28px 0;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden;">
      <div style="background:#0d1b2a;padding:22px 26px;">
        <div style="color:#ffffff;font-size:18px;font-weight:700;">Beacon Legal Group</div>
        <div style="color:#9fb3d1;font-size:12px;margin-top:3px;letter-spacing:.04em;">New website enquiry</div>
      </div>
      <div style="padding:24px 26px;">
        <p style="margin:0 0 16px;font-size:14px;color:#374151;">You've received a new enquiry from the contact form on <strong>beaconlegalgroup.co.uk</strong>:</p>
        <table style="width:100%;border-collapse:collapse;border:1px solid #eef0f4;border-radius:8px;overflow:hidden;">
          ${row('Full name', esc(d.fullName))}
          ${row('Business name', esc(d.businessName))}
          ${row('Contact number', esc(d.contactNumber))}
          ${row('Email', d.email ? `<a href="mailto:${esc(d.email)}" style="color:#2563eb;text-decoration:none;">${esc(d.email)}</a>` : '')}
        </table>
        <p style="margin:18px 0 0;font-size:12px;color:#9ca3af;">Reply directly to this email to respond to the enquirer.</p>
      </div>
      <div style="background:#f9fafb;padding:14px 26px;border-top:1px solid #eef0f4;font-size:11px;color:#9ca3af;">
        Sent automatically by the beaconlegalgroup.co.uk contact form.
      </div>
    </div>
  </div>`;
}

app.get('/api/contact/health', (_req, res) => res.json({ ok: true }));

app.post('/api/contact', async (req, res) => {
  try {
    const ip = req.ip || 'unknown';
    if (rateLimited(ip)) {
      return res.status(429).json({ success: false, message: 'Too many submissions — please try again later or call us.' });
    }
    const d = {
      fullName: clean(req.body.fullName, 120),
      businessName: clean(req.body.businessName, 160),
      contactNumber: clean(req.body.contactNumber, 40),
      email: clean(req.body.email, 160),
    };
    if (!d.fullName || !d.contactNumber || !d.email) {
      return res.status(400).json({ success: false, message: 'Please fill in your name, contact number and email.' });
    }
    if (!emailOk(d.email)) {
      return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });
    }
    await transporter.sendMail({
      from: `"Beacon Legal Group — Website" <${SMTP_USER}>`,
      to: TO,
      replyTo: d.email,
      subject: `New enquiry — ${d.fullName}`,
      text: `New enquiry from beaconlegalgroup.co.uk\n\nFull name: ${d.fullName}\nBusiness name: ${d.businessName || '-'}\nContact number: ${d.contactNumber}\nEmail: ${d.email}`,
      html: renderHtml(d),
    });
    console.log(`[contact-api] enquiry sent → ${TO} (from ${d.email})`);
    res.json({ success: true });
  } catch (err) {
    console.error('[contact-api] send failed:', err.message);
    res.status(500).json({ success: false, message: 'Something went wrong sending your message. Please try again or call us.' });
  }
});

app.listen(PORT, '127.0.0.1', () => console.log(`[contact-api] listening on 127.0.0.1:${PORT} → ${TO}`));
