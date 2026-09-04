// /api/unsubscribe.js
// One-click unsubscribe. Accepts GET (link in the email footer) and POST
// (RFC 8058 List-Unsubscribe-Post, which Gmail/Apple/Yahoo send when the
// reader hits their native "Unsubscribe" button). Either way the address is
// suppressed immediately and permanently until they opt in again themselves.

const { supabase, SITE_URL } = require('./_lib');

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

  const token = (req.query && req.query.t) || (req.body && req.body.t) || null;
  const redirect = (status) => {
    res.statusCode = 302;
    res.setHeader('Location', `${SITE_URL}/unsubscribe.html?s=${status}`);
    res.end();
  };

  if (!token || typeof token !== 'string' || token.length < 16) {
    return req.method === 'POST' ? res.status(400).json({ ok: false }) : redirect('invalid');
  }

  try {
    const db = supabase();
    const { data: lead } = await db.from('leads').select('id, email, unsubscribed_at')
      .eq('unsubscribe_token', token).maybeSingle();

    if (!lead) return req.method === 'POST' ? res.status(404).json({ ok: false }) : redirect('invalid');

    if (!lead.unsubscribed_at) {
      await db.from('leads').update({
        unsubscribed_at: new Date().toISOString(),
        marketing_consent: false,
        sms_consent: false,
      }).eq('id', lead.id);
      await db.from('email_events').insert({ lead_id: lead.id, email: lead.email, kind: 'unsubscribe', status: 'sent', subject: req.method });
    }

    return req.method === 'POST' ? res.status(200).json({ ok: true }) : redirect('done');
  } catch (err) {
    console.error('unsubscribe error:', err);
    return req.method === 'POST' ? res.status(500).json({ ok: false }) : redirect('error');
  }
};
