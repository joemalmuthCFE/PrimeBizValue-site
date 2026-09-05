// /api/partner-onboard — the form a franchisor fills in right after paying
// the $2,500 setup fee (partner-onboarding.html).
//
//   GET  ?session_id=…  → { paid, brand, partner:{code,name,status} }  (page load)
//   POST {session_id, brand, contactName, email, phone, units, website,
//         logoUrl, primaryColor, secondaryColor, transferProcess, notes,
//         consent, consentText}                                        (submit)
//
// The payment is re-verified with Stripe on every call — the session id in
// the URL is never trusted on its own. If the webhook has not provisioned the
// partner row yet (it usually has), this endpoint does it, so a slow webhook
// never leaves a paying franchisor without a code.

const Stripe = require('stripe');
const { supabase, clientIp, validEmail, upsertLead, sendEmail, INTERNAL_BCC, FROM_HELLO } = require('./_lib');
const { partnerWelcome } = require('./_emails');
const { provisionPartner } = require('./stripe-webhook');

async function paidPartnerSession(stripe, sessionId) {
  if (!sessionId) return null;
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session.payment_status !== 'paid' || (session.metadata && session.metadata.tier) !== 'partner') return null;
  return session;
}

async function partnerForSession(db, session) {
  const { data } = await db.from('partners').select('*').eq('stripe_session_id', session.id).maybeSingle();
  if (data && data.stripe_promo_code) return data;
  try { return await provisionPartner(session); } catch (e) { console.error('provisionPartner from onboarding failed:', e.message || e); return data || null; }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const db = supabase();

  if (req.method === 'GET') {
    try {
      const session = await paidPartnerSession(stripe, req.query && req.query.session_id);
      if (!session) return res.status(200).json({ paid: false });
      const partner = await partnerForSession(db, session);
      return res.status(200).json({
        paid: true,
        email: (session.customer_details && session.customer_details.email) || null,
        brand: (session.metadata && session.metadata.brand) || (partner && partner.name) || null,
        partner: partner ? { code: partner.stripe_promo_code || null, name: partner.name || null, status: partner.status || null, onboarded: !!partner.onboarded_at } : null,
      });
    } catch (e) {
      console.error('partner-onboard GET error:', e);
      return res.status(500).json({ paid: false, error: 'Could not verify payment.' });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const b = req.body || {};
    const session = await paidPartnerSession(stripe, b.session_id);
    if (!session) return res.status(402).json({ error: 'We could not confirm a paid partner setup for this session.' });

    const email = String(b.email || (session.customer_details && session.customer_details.email) || '').trim().toLowerCase();
    if (!validEmail(email)) return res.status(400).json({ error: 'A valid contact email is required.' });
    const brand = String(b.brand || (session.metadata && session.metadata.brand) || '').trim().slice(0, 120);
    if (!brand) return res.status(400).json({ error: 'Brand name is required.' });

    const now = new Date().toISOString();
    const partner = await partnerForSession(db, session);

    // 1. Partner row gets the brand details.
    const details = {
      name: brand,
      contact_name: b.contactName ? String(b.contactName).slice(0, 120) : null,
      contact_email: email,
      contact_phone: b.phone ? String(b.phone).slice(0, 40) : null,
      units: b.units != null && b.units !== '' ? String(b.units).slice(0, 20) : null,
      website: b.website ? String(b.website).slice(0, 300) : null,
      logo_url: b.logoUrl ? String(b.logoUrl).slice(0, 500) : null,
      primary_color: b.primaryColor ? String(b.primaryColor).slice(0, 20) : null,
      secondary_color: b.secondaryColor ? String(b.secondaryColor).slice(0, 20) : null,
      transfer_process: b.transferProcess ? String(b.transferProcess).slice(0, 6000) : null,
      notes: b.notes ? String(b.notes).slice(0, 4000) : null,
      status: 'active',
      onboarded_at: now,
    };
    if (partner && partner.id) {
      const r = await db.from('partners').update(details).eq('id', partner.id);
      if (r.error) {
        console.error('partners update (full) failed, retrying name only:', r.error.message);
        await db.from('partners').update({ name: brand }).eq('id', partner.id);
      }
    }

    // 2. The franchisor becomes a CRM contact, tagged so the agents can see them.
    let lead = null;
    try {
      const r = await upsertLead(db, {
        email,
        first_name: details.contact_name ? details.contact_name.split(' ')[0] : null,
        last_name: details.contact_name && details.contact_name.includes(' ') ? details.contact_name.split(' ').slice(1).join(' ') : null,
        phone: details.contact_phone,
        interest: 'Franchisor — Partner Program',
        brand, units: details.units, company: brand,
        source: 'partner-program',
        tags: ['franchisor', 'partner', 'customer'],
        consent: true,
        marketing_consent: b.consent === true,
        sms_consent: b.consent === true && !!details.contact_phone,
        consent_text: b.consent === true && b.consentText ? String(b.consentText).slice(0, 2000) : 'Completed Franchisor Partner Program onboarding after paying the setup fee.',
        consent_at: now,
        consent_ip: clientIp(req),
        consent_user_agent: (req.headers['user-agent'] || '').slice(0, 400),
        consent_page: '/partner-onboarding.html',
      });
      lead = r.lead;
    } catch (e) { console.error('partner lead upsert failed:', e.message || e); }

    // 3. Welcome email with the code; internal BCC so onboarding gets worked.
    const fresh = partner ? Object.assign({}, partner, { name: brand }) : { name: brand };
    const msg = partnerWelcome(lead, fresh);
    try {
      await sendEmail(db, { to: email, subject: msg.subject, html: msg.html, kind: 'partner_welcome', lead, marketing: false, from: FROM_HELLO, bcc: INTERNAL_BCC });
    } catch (e) { console.error('partner welcome email failed:', e.message || e); }

    return res.status(200).json({ ok: true, code: fresh.stripe_promo_code || null });
  } catch (e) {
    console.error('partner-onboard POST error:', e);
    return res.status(500).json({ error: 'Something went wrong saving your details. Email hello@primebizvalue.com and we will finish setup by hand.' });
  }
};
