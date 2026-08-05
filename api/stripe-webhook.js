// /api/stripe-webhook.js
// Vercel serverless function. Stripe calls this automatically every time a
// checkout completes. This is where the order gets logged and tagged to a
// partner (or logged as organic if no code was used).

const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Vercel needs the raw request body to verify the Stripe signature
module.exports.config = { api: { bodyParser: false } };

function buffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  let event;
  try {
    const rawBody = await buffer(req);
    event = stripe.webhooks.constructEvent(
      rawBody,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    try {
      // Pull the full session with discount details expanded — Stripe caps
      // expand depth at 4 levels, so we stop at the discount object itself
      // (which gives us a promotion_code ID) and fetch the actual code
      // string with a separate, cheap lookup below.
      const full = await stripe.checkout.sessions.retrieve(session.id, {
        expand: ['total_details.breakdown.discounts.discount'],
      });

      const discounts = full.total_details?.breakdown?.discounts || [];
      const promoCodeId = discounts[0]?.discount?.promotion_code || null;
      let promoCode = null;
      if (promoCodeId) {
        try {
          const promo = await stripe.promotionCodes.retrieve(promoCodeId);
          promoCode = promo.code || null;
        } catch (e) {
          console.error('Could not look up promotion code:', e.message);
        }
      }
      const validTiers = ['basic', 'detailed', 'upgrade'];
      const tier = validTiers.includes(full.metadata?.tier) ? full.metadata.tier : 'detailed';

      const amountCharged = (full.amount_total || 0) / 100;
      const discountAmount = discounts.reduce((sum, d) => sum + (d.amount || 0), 0) / 100;

      let partnerId = null;
      if (promoCode) {
        const { data: partner } = await supabase
          .from('partners')
          .select('id')
          .eq('stripe_promo_code', promoCode)
          .single();
        partnerId = partner?.id || null;
      }

      const { error: insertError } = await supabase.from('orders').insert({
        stripe_session_id: session.id,
        customer_email: full.customer_details?.email || null,
        partner_id: partnerId,
        tier: tier,
        amount_charged: amountCharged,
        discount_amount: discountAmount,
      });
      if (insertError) {
        // Supabase errors are often returned, not thrown — log this
        // explicitly or a silent rejection here looks identical to success.
        console.error('Supabase insert failed:', insertError);
      } else {
        console.log('Order logged to Supabase:', session.id);
      }
    } catch (err) {
      // Log and still return 200 — we don't want Stripe endlessly retrying
      // a webhook over a logging issue once the payment itself succeeded.
      console.error('Order logging failed:', err);
    }
  }

  res.status(200).json({ received: true });
};
