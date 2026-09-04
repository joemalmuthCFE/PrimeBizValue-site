// /api/join-list.js
// Every opt-in form on the site posts here: join.html, franchisors.html, and
// the free-valuation capture on tool.html. Writes a real CRM record with the
// consent evidence a TCPA / CAN-SPAM challenge would ask for — the exact text
// agreed to, when, from which IP and browser, and on which page.

const { supabase, clientIp, validEmail, upsertLead } = require('./_lib');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    if (!validEmail(email)) return res.status(400).json({ error: 'A valid email is required.' });

    // Two consents, recorded separately.
    //  - consent:          the form's checkbox (email + calls/texts where a phone was given)
    //  - marketingConsent: explicit permission for ongoing email marketing
    // A lead form that only offers one box sends both as the same value; the
    // free-valuation capture sends marketingConsent on its own.
    const consent = b.consent === true;
    const marketingConsent = b.marketingConsent === true || (consent && b.marketingConsent === undefined);
    const phone = b.phone ? String(b.phone).trim() : null;
    const smsConsent = consent && !!phone;

    if (!consent && !marketingConsent) {
      return res.status(400).json({ error: 'Consent is required to join the list.' });
    }

    const now = new Date().toISOString();
    const source = (b.source || 'join-page').toString().slice(0, 60);
    const tags = [source];
    if (b.interest && /franchisor/i.test(b.interest)) tags.push('franchisor');
    if (b.interest && /sell/i.test(b.interest)) tags.push('seller');
    if (b.interest && /buy/i.test(b.interest)) tags.push('buyer');
    if (b.interest && /lender|financial/i.test(b.interest)) tags.push('lender');

    const fields = {
      email,
      first_name: b.firstName || null,
      last_name:  b.lastName || null,
      phone,
      interest:   b.interest || null,
      state:      b.state || null,
      brand:      b.brand || null,
      units:      b.units != null ? String(b.units) : null,
      company:    b.company || null,
      source,
      tags,
      consent,
      marketing_consent: marketingConsent,
      sms_consent: smsConsent,
      consent_text: b.consentText ? String(b.consentText).slice(0, 2000) : null,
      consent_at: now,
      consent_ip: clientIp(req),
      consent_user_agent: (req.headers['user-agent'] || '').slice(0, 400),
      consent_page: (b.page || req.headers.referer || '').toString().slice(0, 300),
    };

    // Free-valuation capture passes the numbers so follow-up can quote them back
    if (b.valuation && typeof b.valuation === 'object') {
      const v = b.valuation;
      if (v.low != null)     fields.last_valuation_low  = Number(v.low) || null;
      if (v.high != null)    fields.last_valuation_high = Number(v.high) || null;
      if (v.sde != null)     fields.last_sde            = Number(v.sde) || null;
      if (v.revenue != null) fields.last_revenue        = Number(v.revenue) || null;
      fields.last_valuation_at = now;
      fields.nurture_step = 0;
    }

    const db = supabase();
    const { lead, created } = await upsertLead(db, fields);

    res.status(200).json({ ok: true, created, id: lead.id });
  } catch (err) {
    console.error('join-list error:', err);
    res.status(500).json({ error: 'Could not save your submission — please try again or email hello@primebizvalue.com.' });
  }
};
