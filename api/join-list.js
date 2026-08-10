// /api/join-list.js
// Vercel serverless function. Captures Join Our List / gated-access
// submissions — including TCPA consent — into Supabase. Replaces the old
// mailto: placeholder, which only opened the visitor's own email client
// and never actually stored anything.
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { firstName, lastName, email, phone, interest, state, consent, source } = req.body || {};

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'A valid email is required.' });
    }
    if (consent !== true) {
      return res.status(400).json({ error: 'Consent is required to join the list.' });
    }

    const { error: insertError } = await supabase.from('leads').insert({
      first_name: firstName || null,
      last_name: lastName || null,
      email,
      phone: phone || null,
      interest: interest || null,
      state: state || null,
      consent: true,
      source: source || 'join-page',
    });

    if (insertError) {
      // Supabase errors are often returned, not thrown — log explicitly,
      // same lesson learned from the orders-table debugging earlier.
      console.error('Supabase leads insert failed:', insertError);
      return res.status(500).json({ error: 'Could not save your submission — please try again or email hello@primebizvalue.com.' });
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('join-list error:', err);
    res.status(500).json({ error: 'Something went wrong — please try again or email hello@primebizvalue.com.' });
  }
};
