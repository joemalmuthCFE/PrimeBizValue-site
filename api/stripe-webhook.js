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
      const validTiers = ['summary', 'basic', 'detailed', 'upgrade', 'partner'];
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

      // Franchisor Partner Program: the setup fee just cleared. Provision the
      // partner record now so the onboarding page has something to attach to,
      // and mint the 30% promotion code the moment money lands. The onboarding
      // form (partner-onboarding.html) fills in brand details afterwards.
      if (tier === 'partner') {
        try {
          await provisionPartner(full);
        } catch (e) {
          console.error('Partner provisioning failed (onboarding page will retry):', e.message || e);
        }
      }
    } catch (err) {
      // Log and still return 200 — we don't want Stripe endlessly retrying
      // a webhook over a logging issue once the payment itself succeeded.
      console.error('Order logging failed:', err);
    }
  }

  res.status(200).json({ received: true });
};


// ---- Franchisor partner provisioning -------------------------------------
// Idempotent: keyed on the Stripe session id. Creates (or reuses) the one
// shared 30% coupon, then a promotion code unique to this brand. The code is
// what franchisees type at checkout; the webhook above already attributes
// every order carrying it back to this partner row.
async function provisionPartner(session) {
  const email = (session.customer_details && session.customer_details.email) || null;
  const brand = (session.metadata && session.metadata.brand) || null;

  const { data: existing } = await supabase.from('partners').select('id, stripe_promo_code')
    .eq('stripe_session_id', session.id).maybeSingle();
  if (existing && existing.stripe_promo_code) return existing;

  const code = await mintPartnerCode(brand || (email ? email.split('@')[1].split('.')[0] : 'PARTNER'));
  const row = {
    name: brand || null,
    contact_email: email,
    stripe_promo_code: code,
    stripe_session_id: session.id,
    setup_fee_paid_at: new Date().toISOString(),
    setup_fee_amount: (session.amount_total || 0) / 100,
    status: 'onboarding',
  };
  let result;
  if (existing) result = await supabase.from('partners').update(row).eq('id', existing.id).select().single();
  else result = await supabase.from('partners').insert(row).select().single();
  if (result.error) {
    // Older partners table without the new columns: fall back to the minimum.
    console.error('partners insert (full) failed, retrying minimal:', result.error.message);
    result = await supabase.from('partners').insert({ name: row.name, stripe_promo_code: code }).select().single();
    if (result.error) throw new Error(result.error.message);
  }
  console.log('Partner provisioned:', code);
  return result.data;
}

async function getOrCreatePartnerCoupon() {
  const id = 'PARTNER30';
  try { return await stripe.coupons.retrieve(id); } catch (e) { /* not found */ }
  return stripe.coupons.create({ id, percent_off: 30, duration: 'forever', name: 'Franchisor Partner Program — 30% off reports' });
}

async function mintPartnerCode(seed) {
  const coupon = await getOrCreatePartnerCoupon();
  const base = String(seed).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || 'PARTNER';
  for (let i = 0; i < 6; i++) {
    const code = i === 0 ? `${base}30` : `${base}30${i + 1}`;
    try {
      const existing = await stripe.promotionCodes.list({ code, limit: 1 });
      if (existing.data.length) continue;
      const pc = await stripe.promotionCodes.create({ coupon: coupon.id, code, active: true, metadata: { program: 'franchisor-partner' } });
      return pc.code;
    } catch (e) {
      console.error('promo code create failed for', code, e.message);
    }
  }
  throw new Error('Could not mint a unique partner code');
}
module.exports.provisionPartner = provisionPartner;
