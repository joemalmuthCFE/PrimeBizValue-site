// /api/verify-session — confirms a Stripe Checkout session was actually paid
// before the tool unlocks the report. The frontend never trusts its own
// "paid" state after a redirect — it always re-checks with Stripe directly
// using the session_id, so someone can't just type ?session_id=anything
// into the URL to get a free report.

const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { session_id } = req.query;
  if (!session_id) {
    res.status(400).json({ paid: false, error: 'Missing session_id' });
    return;
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    res.status(200).json({
      paid: session.payment_status === 'paid',
      email: session.customer_details?.email || null,
      tier: session.metadata?.tier || null,
    });
  } catch (err) {
    console.error('verify-session error:', err);
    res.status(500).json({ paid: false, error: 'Could not verify session' });
  }
};
