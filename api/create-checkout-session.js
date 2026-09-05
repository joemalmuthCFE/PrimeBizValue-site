// /api/create-checkout-session.js
// Vercel serverless function. Creates a Stripe Checkout session for any of
// the paid products. Partner discount codes are handled by Stripe itself
// (Coupons + Promotion Codes), so there is no discount math here.

const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Prices are fixed here, server-side, keyed only by a tier keyword. The
// client sends a keyword, never a dollar amount, so nothing can be tampered
// with. "upgrade" is exactly detailed - basic, for a Custom buyer topping up.
//
//   summary  — $19.99 one-page Summary Report (the tripwire; unlocks the range)
//   basic    — $199  Custom Report
//   detailed — $799  Prime Certified Opinion of Value
//   upgrade  — $600  Custom -> Certified
//   partner  — $2,500 one-time Franchisor Partner Program setup
const TIERS = {
  summary:  { amount: 1999,   label: 'PrimeBizValue Summary Report',
              description: 'One-page valuation summary: estimated value range, SDE/EBITDA recast, multiple applied and what moved it.' },
  basic:    { amount: 19900,  label: 'PrimeBizValue Custom Report',
              description: 'Custom valuation report built from your financials.' },
  detailed: { amount: 79900,  label: 'PrimeBizValue Prime Certified Opinion of Value',
              description: 'Fully documented, benchmarked valuation report with itemized recast, SBA/DSCR analysis and closing breakdown.' },
  upgrade:  { amount: 60000,  label: 'PrimeBizValue Upgrade — Custom to Prime Certified',
              description: 'Difference between the Custom Report and the Prime Certified Opinion of Value.' },
  partner:  { amount: 250000, label: 'PrimeBizValue Franchisor Partner Program — one-time setup',
              description: 'One-time setup. Includes a private 30%-off code for your franchisees on every report, co-branded report cover, and your transfer process on every report.' },
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { customerEmail, tier, brand } = req.body || {};
    const key = TIERS[tier] ? tier : 'detailed'; // default to detailed only if tier is missing/invalid
    const selected = TIERS[key];
    const site = (process.env.SITE_URL || 'https://primebizvalue.com').replace(/\/$/, '');

    const isPartner = key === 'partner';
    const success_url = isPartner
      ? `${site}/partner-onboarding.html?session_id={CHECKOUT_SESSION_ID}`
      : `${site}/tool.html?session_id={CHECKOUT_SESSION_ID}`;
    const cancel_url = isPartner
      ? `${site}/franchisors.html?checkout=cancelled`
      : `${site}/tool.html?checkout=cancelled`;

    const metadata = { tier: key };
    if (isPartner && brand) metadata.brand = String(brand).slice(0, 120);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: selected.label, description: selected.description },
          unit_amount: selected.amount,
        },
        quantity: 1,
      }],
      // Puts an "Add promotion code" box on Stripe's checkout page. Organic
      // customers skip it; franchisees of a partner brand type their code and
      // Stripe applies the 30% and records which code was used. Not offered
      // on the partner setup fee itself.
      allow_promotion_codes: !isPartner,
      customer_email: customerEmail || undefined,
      metadata, // authoritative record of which tier was actually paid for
      // Opts out of Stripe's "Managed Payments" (merchant-of-record) feature.
      managed_payments: { enabled: false },
      success_url,
      cancel_url,
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Checkout session error:', err);
    res.status(500).json({ error: 'Could not create checkout session' });
  }
};
