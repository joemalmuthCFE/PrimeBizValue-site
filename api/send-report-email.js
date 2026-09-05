// /api/send-report-email — delivers the purchased report to the customer with
// a quiet internal BCC, records the buyer as a CRM contact, and puts the
// CAN-SPAM footer (postal address + preference link) on the message.
//
// Called from the browser right after a payment is verified. The browser
// already holds the fully rendered report HTML, so we hand that to Resend
// rather than rebuilding it server-side.

const { supabase, validEmail, upsertLead, sendEmail, INTERNAL_BCC } = require('./_lib');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { customerEmail, reportHtml, businessName, tier, marketingConsent, consentText, sessionId } = req.body || {};
  if (!validEmail(customerEmail) || !reportHtml) {
    return res.status(400).json({ error: 'Missing customerEmail or reportHtml in request body.' });
  }

  const LABELS = { summary: 'Summary Report', basic: 'Custom Valuation Report', detailed: 'Prime Certified Opinion of Value' };
  const tierKey = LABELS[tier] ? tier : 'detailed';
  const subject = `Your ${LABELS[tierKey]}${businessName ? ' — ' + businessName : ''}`;
  const db = supabase();

  // 1. Buyer becomes a CRM record. Purchase = transactional relationship;
  //    marketing_consent is only true if they ticked the box on the tool.
  let lead = null;
  try {
    const now = new Date().toISOString();
    const r = await upsertLead(db, {
      email: customerEmail,
      source: 'purchase',
      tags: ['customer', `${tierKey}-buyer`],
      consent: true,
      marketing_consent: marketingConsent === true,
      consent_text: marketingConsent === true && consentText ? String(consentText).slice(0, 2000) : null,
      consent_at: marketingConsent === true ? now : null,
      consent_page: '/tool.html',
      company: businessName || null,
    });
    lead = r.lead;
    if (sessionId) {
      await db.from('orders').update({ lead_id: lead.id, business_name: businessName || null })
        .eq('stripe_session_id', sessionId);
    }
  } catch (e) {
    // never let CRM bookkeeping block report delivery
    console.error('CRM upsert on purchase failed:', e.message || e);
  }

  // 2. Send the report. Transactional, so it goes regardless of marketing status.
  try {
    await sendEmail(db, {
      to: customerEmail, subject, html: reportHtml, kind: 'report',
      lead, marketing: false, bcc: INTERNAL_BCC,
    });
    res.status(200).json({ sent: true });
  } catch (err) {
    console.error('send-report-email error:', err);
    res.status(500).json({ error: 'Email send failed', detail: String(err.message || err).slice(0, 300) });
  }
};
