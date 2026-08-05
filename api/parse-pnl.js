// /api/parse-pnl — Vercel serverless function
// Holds the real Anthropic API key server-side and proxies the P&L parsing
// call so the key is never exposed to the browser. Called by tool.html.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY. Add it in Vercel project settings.' });
    return;
  }

  const { system, text } = req.body || {};
  if (!text || typeof text !== 'string') {
    res.status(400).json({ error: 'Missing "text" in request body.' });
    return;
  }

  try {
    const anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 8000,
        system: system || '',
        messages: [{ role: 'user', content: text.slice(0, 40000) }],
      }),
    });

    if (!anthropicResp.ok) {
      const bodyText = await anthropicResp.text().catch(() => '');
      res.status(anthropicResp.status).json({
        error: `Anthropic API error: ${anthropicResp.status} ${anthropicResp.statusText}`,
        detail: bodyText.slice(0, 500),
      });
      return;
    }

    const data = await anthropicResp.json();
    const resultText = (data.content || []).map((b) => b.text || '').join('');
    res.status(200).json({ text: resultText });
  } catch (err) {
    res.status(500).json({ error: 'Server error calling Anthropic API', detail: String(err) });
  }
}
