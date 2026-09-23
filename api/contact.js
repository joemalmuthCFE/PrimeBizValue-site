const { supabase, validEmail, upsertLead, sendEmail, FROM_HELLO } = require('./_lib');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { name, email, phone, reason, message, marketingConsent, consentText } = req.body || {};
  if (!validEmail(email) || !String(message || '').trim()) {
    return res.status(400).json({ error: 'Valid email and message are required' });
  }
  const db = supabase();
  const now = new Date().toISOString();
  let lead;
  try {
    const r = await upsertLead(db, {
      email,
      name: String(name || '').slice(0, 200),
      phone: String(phone || '').slice(0, 50),
      source: 'contact',
      tags: ['contact', String(reason || 'general').slice(0, 80)],
      consent: true,
      marketing_consent: marketingConsent === true,
      consent_text: marketingConsent === true ? String(consentText || '').slice(0, 2000) : null,
      consent_at: marketingConsent === true ? now : null,
      consent_page: '/contact.html'
    });
    lead = r.lead;
    await sendEmail(db, {
      to: 'hello@primebizvalue.com',
      from: FROM_HELLO,
      replyTo: email,
      subject: 'PrimeBizValue contact form: ' + String(reason || 'General question').slice(0, 120),
      kind: 'contact',
      lead,
      marketing: false,
      html: '<h2>New contact form submission</h2>' +
        '<p><strong>Name:</strong> ' + esc(name) + '</p>' +
        '<p><strong>Email:</strong> ' + esc(email) + '</p>' +
        '<p><strong>Phone:</strong> ' + esc(phone) + '</p>' +
        '<p><strong>Reason:</strong> ' + esc(reason) + '</p>' +
        '<p><strong>Marketing opt-in:</strong> ' + (marketingConsent === true ? 'Yes' : 'No') + '</p>' +
        '<p><strong>Message:</strong></p><p>' + esc(message).replace(/\n/g,'<br>') + '</p>'
    });
    return res.status(200).json({ sent: true });
  } catch (err) {
    console.error('contact handler failed:', err);
    return res.status(500).json({ error: 'Could not send message' });
  }
};
