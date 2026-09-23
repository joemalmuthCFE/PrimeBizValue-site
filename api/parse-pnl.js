// /api/parse-pnl — Vercel serverless function
// Holds the real Anthropic API key server-side and proxies the P&L parsing
// call so the key is never exposed to the browser. Called by tool.html.

const buckets = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const LIMIT = 20;

function allowedOrigin(req) {
  const configured = (process.env.SITE_URL || 'https://primebizvalue.com').replace(/\/$/, '');
  const origin = String(req.headers?.origin || '');
  if (origin === configured) return true;
  if (process.env.VERCEL_ENV !== 'production' && /^https:\/\/[^/]+\.vercel\.app$/.test(origin)) return true;
  return false;
}

function rateLimit(req) {
  const now = Date.now();
  const ip = String(req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  const current = buckets.get(ip);
  const bucket = !current || now - current.start >= WINDOW_MS ? { start: now, count: 0 } : current;
  bucket.count += 1;
  buckets.set(ip, bucket);
  return { allowed: bucket.count <= LIMIT, retryAfter: Math.max(1, Math.ceil((WINDOW_MS - (now - bucket.start)) / 1000)) };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (!allowedOrigin(req)) {
    res.status(403).json({ error: 'Forbidden origin' });
    return;
  }

  const limit = rateLimit(req);
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfter));
    res.status(429).json({ error: 'Too many parsing requests' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY. Add it in Vercel project settings.' });
    return;
  }

  const { system, text } = req.body || {};
  if (!text || typeof text !== 'string' || text.length > 40000) {
    res.status(400).json({ error: 'Missing or oversized "text" in request body.' });
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
