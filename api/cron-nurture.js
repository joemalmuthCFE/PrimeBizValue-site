// /api/cron-nurture — runs once a day (see vercel.json). Walks the nurture
// queue and sends whichever of the three follow-ups is due. Three emails,
// then it stops for good. Anyone who buys, unsubscribes, or bounces drops
// out automatically because the view excludes them.
//
// Protected by CRON_SECRET: Vercel sends it as a Bearer token on scheduled
// invocations; anyone else gets a 401.

const { supabase, sendEmail, FROM_HELLO } = require('./_lib');
const { nurture1, nurture2, nurture3 } = require('./_emails');

// step -> [days after last valuation, template, kind]
const STEPS = [
  [1,  nurture1, 'nurture_1'],
  [4,  nurture2, 'nurture_2'],
  [10, nurture3, 'nurture_3'],
];

module.exports = async (req, res) => {
  const auth = req.headers['authorization'] || '';
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const db = supabase();
  const { data: queue, error } = await db.from('nurture_queue').select('*').limit(200);
  if (error) { console.error('nurture_queue read failed:', error); return res.status(500).json({ error: error.message }); }

  const out = { checked: (queue || []).length, sent: 0, skipped: 0, failed: 0 };

  for (const row of queue || []) {
    const step = Number(row.nurture_step) || 0;
    if (step >= STEPS.length) { out.skipped++; continue; }
    const [dueDay, template, kind] = STEPS[step];
    if (Number(row.days_since_valuation) < dueDay) { out.skipped++; continue; }

    // never send two in one day
    if (row.nurture_last_sent_at && (Date.now() - new Date(row.nurture_last_sent_at).getTime()) < 20 * 3600 * 1000) { out.skipped++; continue; }

    try {
      const { data: lead } = await db.from('leads').select('*').eq('id', row.id).single();
      const msg = template(lead);
      const r = await sendEmail(db, { to: lead.email, subject: msg.subject, html: msg.html, kind, lead, marketing: true, from: FROM_HELLO });
      await db.from('leads').update({ nurture_step: step + 1, nurture_last_sent_at: new Date().toISOString() }).eq('id', lead.id);
      if (r.suppressed) out.skipped++; else out.sent++;
    } catch (e) {
      console.error('nurture send failed for', row.email, e.message || e);
      out.failed++;
    }
  }

  res.status(200).json(out);
};
