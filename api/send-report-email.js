// /api/send-report-email — sends the finished report to the customer, with a
// quiet BCC copy to hello@primebizvalue.com. Uses Resend's plain HTTP API
// (no extra npm dependency needed, same pattern as the Anthropic proxy).
//
// This is called from the browser right after a payment is verified — the
// browser already has the fully-rendered report HTML (buildReportHTML's
// output), so we just hand that same HTML to Resend as the email body
// instead of rebuilding the report server-side.

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server is missing RESEND_API_KEY. Add it in Vercel project settings.' });
    return;
  }

  const { customerEmail, reportHtml, businessName, tier } = req.body || {};
  if (!customerEmail || !reportHtml) {
    res.status(400).json({ error: 'Missing customerEmail or reportHtml in request body.' });
    return;
  }

  const tierLabel = tier === 'basic' ? 'Basic' : 'Detailed';
  const subject = `Your ${tierLabel} Valuation Report${businessName ? ' — ' + businessName : ''}`;

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: 'PrimeBizValue <reports@primebizvalue.com>',
        to: [customerEmail],
        bcc: ['hello@primebizvalue.com'], // quiet internal copy — invisible to the customer
        subject,
        html: reportHtml,
      }),
    });

    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => '');
      console.error('Resend send failed:', resp.status, bodyText);
      res.status(resp.status).json({ error: 'Email send failed', detail: bodyText.slice(0, 500) });
      return;
    }

    res.status(200).json({ sent: true });
  } catch (err) {
    console.error('send-report-email error:', err);
    res.status(500).json({ error: 'Server error sending email', detail: String(err) });
  }
};
