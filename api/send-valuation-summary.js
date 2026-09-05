// /api/send-valuation-summary — the free-tool capture.
// A visitor who has just seen their number can ask to have it emailed. That
// single request (a) creates the CRM record, (b) stores the consent evidence,
// (c) sends the transactional summary, and (d) if they ticked the marketing
// box, enters them into the three-email follow-up the cron runs.
//
// This is the endpoint that closes the biggest leak in the funnel: before it
// existed, every visitor who ran a free valuation and left was gone for good.

const { supabase, clientIp, validEmail, upsertLead, sendEmail } = require('./_lib');
const { valuationSummary } = require('./_emails');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });

    const v = b.valuation || {};
    // Free tier sends SDE/EBITDA only; a Summary buyer also passes the range.
    const low = Number(v.low) || 0, high = Number(v.high) || 0;
    const sde = v.sde != null ? Number(v.sde) : null;
    const ebitda = v.ebitda != null ? Number(v.ebitda) : null;
    if (!(low > 0 && high > 0) && !(sde != null && !isNaN(sde))) return res.status(400).json({ error: 'Run a valuation first.' });

    const marketing = b.marketingConsent === true;
    const now = new Date().toISOString();
    const db = supabase();

    const { lead } = await upsertLead(db, {
      email,
      first_name: b.firstName || null,
      source: 'free-valuation',
      tags: ['free-valuation', 'seller'],
      consent: true,                       // they asked for this email
      marketing_consent: marketing,
      consent_text: marketing && b.consentText ? String(b.consentText).slice(0, 2000) : 'Requested a copy of their free recast by email.',
      consent_at: now,
      consent_ip: clientIp(req),
      consent_user_agent: (req.headers['user-agent'] || '').slice(0, 400),
      consent_page: '/tool.html',
      last_valuation_low: low > 0 ? low : null,
      last_valuation_high: high > 0 ? high : null,
      last_sde: sde,
      last_revenue: v.revenue != null ? Number(v.revenue) : null,
      last_valuation_at: now,
      nurture_step: 0,
      company: b.businessName || null,
    });

    const msg = valuationSummary(lead, { low, high, sde, ebitda, revenue: v.revenue });
    await sendEmail(db, { to: email, subject: msg.subject, html: msg.html, kind: 'valuation_summary', lead, marketing: false });

    res.status(200).json({ ok: true, nurture: marketing });
  } catch (err) {
    console.error('send-valuation-summary error:', err);
    res.status(500).json({ error: 'Could not send that — try again or email hello@primebizvalue.com.' });
  }
};
