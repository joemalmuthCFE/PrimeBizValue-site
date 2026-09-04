// /api/agent-report — the single read-only snapshot the scheduled agents
// (ops, accounting, customer service, chief of staff) pull each run.
//
//   GET /api/agent-report                → aggregates only, no personal data
//   GET /api/agent-report?key=…&detail=1 → adds recent leads/orders/failures
//
// The keyed detail view exists so the customer-service agent can see who
// bought and who asked for a valuation without anyone handing an agent a
// database password. AGENT_KEY lives in Vercel env, nowhere else.

const Stripe = require('stripe');
const { supabase } = require('./_lib');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'no-store');

  const db = supabase();
  const out = { generated_at: new Date().toISOString(), site: 'primebizvalue.com' };

  try {
    const { data: snap, error } = await db.from('business_snapshot').select('*').single();
    if (error) out.snapshot_error = error.message; else out.snapshot = snap;
  } catch (e) { out.snapshot_error = String(e.message || e); }

  try {
    const since7 = new Date(Date.now() - 7 * 86400e3).toISOString();
    const since30 = new Date(Date.now() - 30 * 86400e3).toISOString();
    const [ev7, evFail, nq, o7, l7src] = await Promise.all([
      db.from('email_events').select('kind', { count: 'exact', head: false }).gte('created_at', since7),
      db.from('email_events').select('id, email, kind, error, created_at').eq('status', 'failed').gte('created_at', since30).order('created_at', { ascending: false }).limit(20),
      db.from('nurture_queue').select('id', { count: 'exact', head: true }),
      db.from('orders').select('tier, amount_charged, created_at').gte('created_at', since7),
      db.from('leads').select('source').gte('created_at', since7),
    ]);
    const byKind = {}; (ev7.data || []).forEach(r => { byKind[r.kind] = (byKind[r.kind] || 0) + 1; });
    const bySrc = {}; (l7src.data || []).forEach(r => { bySrc[r.source || 'unknown'] = (bySrc[r.source || 'unknown'] || 0) + 1; });
    out.email_7d = byKind;
    out.email_failures_30d = (evFail.data || []).map(r => ({ kind: r.kind, error: (r.error || '').slice(0, 120), at: r.created_at }));
    out.nurture_queue = nq.count || 0;
    out.orders_7d = { count: (o7.data || []).length, revenue: (o7.data || []).reduce((s, r) => s + Number(r.amount_charged || 0), 0),
      by_tier: (o7.data || []).reduce((m, r) => { m[r.tier] = (m[r.tier] || 0) + 1; return m; }, {}) };
    out.leads_7d_by_source = bySrc;
  } catch (e) { out.activity_error = String(e.message || e); }

  // Stripe: balance + last payout + disputes, no card data
  try {
    if (process.env.STRIPE_SECRET_KEY) {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      const [bal, payouts, disputes, charges] = await Promise.all([
        stripe.balance.retrieve(),
        stripe.payouts.list({ limit: 1 }),
        stripe.disputes.list({ limit: 5 }),
        stripe.charges.list({ limit: 100, created: { gte: Math.floor(Date.now() / 1000) - 30 * 86400 } }),
      ]);
      const sum = (arr) => arr.reduce((s, b) => s + (b.currency === 'usd' ? b.amount : 0), 0) / 100;
      out.stripe = {
        available_usd: sum(bal.available), pending_usd: sum(bal.pending),
        last_payout: payouts.data[0] ? { amount_usd: payouts.data[0].amount / 100, status: payouts.data[0].status, arrival: payouts.data[0].arrival_date } : null,
        open_disputes: disputes.data.filter(d => d.status && !/won|lost|closed/.test(d.status)).length,
        charges_30d: { count: charges.data.filter(c => c.paid).length, gross_usd: charges.data.filter(c => c.paid).reduce((s, c) => s + c.amount, 0) / 100,
                       refunded_usd: charges.data.reduce((s, c) => s + (c.amount_refunded || 0), 0) / 100,
                       failed: charges.data.filter(c => !c.paid).length },
      };
    }
  } catch (e) { out.stripe_error = String(e.message || e).slice(0, 200); }

  // Detail (customer-service agent): recent people, keyed
  const key = req.query && req.query.key;
  if (req.query && req.query.detail === '1') {
    if (!process.env.AGENT_KEY || key !== process.env.AGENT_KEY) {
      out.detail = 'forbidden';
    } else {
      try {
        const since7 = new Date(Date.now() - 7 * 86400e3).toISOString();
        const [orders, leads] = await Promise.all([
          db.from('orders').select('customer_email, tier, amount_charged, business_name, created_at').gte('created_at', since7).order('created_at', { ascending: false }).limit(50),
          db.from('leads').select('email, first_name, interest, source, brand, units, marketing_consent, last_valuation_low, last_valuation_high, created_at').gte('created_at', since7).order('created_at', { ascending: false }).limit(100),
        ]);
        out.detail = { orders_7d: orders.data || [], leads_7d: leads.data || [] };
      } catch (e) { out.detail_error = String(e.message || e); }
    }
  }

  res.status(200).json(out);
};
