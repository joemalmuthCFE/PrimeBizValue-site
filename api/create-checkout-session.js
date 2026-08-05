// /api/create-checkout-session.js
// Vercel serverless function. Creates a Stripe Checkout session for the $799 report.
// Partner discount codes are handled by Stripe itself (via Coupons + Promotion Codes) —
// we don't need custom discount math here at all.

const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Prices are fixed here, server-side, keyed only by a tier keyword — the
// client sends a keyword, never a dollar amount, so there's no way to
// tamper with what gets charged. "upgrade" is exactly detailed - basic —
// for a customer who already bought Basic and wants to top up to Detailed
// without paying full price twice.
const TIERS = {
  basic:    { amount: 19900, label: 'PrimeBizValue Basic Valuation Report' },
  detailed: { amount: 79900, label: 'PrimeBizValue Detailed Valuation Report' },
  upgrade:  { amount: 60000, label: 'PrimeBizValue Upgrade — Basic to Detailed Report' },
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { customerEmail, tier } = req.body || {};
    const selected = TIERS[tier] || TIERS.detailed; // default to detailed only if tier is missing/invalid

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: selected.label,
            },
            unit_amount: selected.amount,
          },
          quantity: 1,
        },
      ],
      // This is the key line for the discount code strategy: it puts a
      // "Add promotion code" box right on Stripe's checkout page. Organic
      // customers just skip it and pay full price. Partner customers type
      // in their code (e.g. PARTNER25) and Stripe applies it and
      // records which code was used — no custom code needed on our end.
      allow_promotion_codes: true,
      customer_email: customerEmail || undefined,
      metadata: { tier: TIERS[tier] ? tier : 'detailed' }, // authoritative record of which tier was actually paid for
      // Opts out of Stripe's newer "Managed Payments" feature (on by default
      // for new accounts), which otherwise requires a tax code per product.
      // We're not using Stripe as a merchant-of-record for tax purposes here.
      managed_payments: { enabled: false },
      success_url: `${process.env.SITE_URL}/tool.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.SITE_URL}/tool.html?checkout=cancelled`,
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Checkout session error:', err);
    res.status(500).json({ error: 'Could not create checkout session' });
  }
};
