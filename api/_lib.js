// /api/_lib.js — shared helpers for the PrimeBizValue serverless functions.
// (Files prefixed with an underscore are not exposed as routes by Vercel.)

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const SITE_URL = (process.env.SITE_URL || 'https://primebizvalue.com').replace(/\/$/, '');

// ── Postal address that appears in every outbound email (CAN-SPAM §5(a)(5)) ──
// Keep this in ONE place. If the mailbox address changes, change it here.
const POSTAL_ADDRESS = process.env.POSTAL_ADDRESS || '100 Front Street, Ste 355, Jupiter, FL 33477';
const BRAND = 'PrimeBizValue';
const FROM_REPORTS = `${BRAND} <reports@primebizvalue.com>`;
const FROM_HELLO   = `${BRAND} <hello@primebizvalue.com>`;
const INTERNAL_BCC = 'hello@primebizvalue.com';

function supabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length) return xf.split(',')[0].trim();
  return req.headers['x-real-ip'] || (req.socket && req.socket.remoteAddress) || null;
}

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

function validEmail(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtMoney(n) {
  const v = Math.round(Number(n) || 0);
  return v < 0 ? '($' + Math.abs(v).toLocaleString('en-US') + ')' : '$' + v.toLocaleString('en-US');
}

/**
 * Find-or-create a lead by email (case-insensitive) and merge fields in.
 * Never downgrades consent: a later submission without marketing consent
 * does not revoke an earlier one — only /api/unsubscribe does that.
 */
async function upsertLead(db, fields) {
  const email = String(fields.email || '').trim().toLowerCase();
  if (!validEmail(email)) throw new Error('invalid email');

  const { data: existing, error: selErr } = await db
    .from('leads').select('*').ilike('email', email).limit(1).maybeSingle();
  if (selErr) throw selErr;

  const now = new Date().toISOString();
  const patch = {};
  for (const k of Object.keys(fields)) {
    const v = fields[k];
    if (v === undefined || v === null || v === '') continue;
    patch[k] = v;
  }
  patch.email = email;
  patch.last_seen_at = now;

  if (existing) {
    // consent only ratchets upward here
    if (existing.marketing_consent) patch.marketing_consent = true;
    if (existing.sms_consent) patch.sms_consent = true;
    if (existing.consent) patch.consent = true;
    if (!existing.unsubscribe_token) patch.unsubscribe_token = newToken();
    // tags merge
    if (patch.tags) patch.tags = Array.from(new Set([...(existing.tags || []), ...patch.tags]));
    const { data, error } = await db.from('leads').update(patch).eq('id', existing.id).select().single();
    if (error) throw error;
    return { lead: data, created: false };
  }

  patch.unsubscribe_token = newToken();
  patch.created_at = now;
  const { data, error } = await db.from('leads').insert(patch).select().single();
  if (error) throw error;
  return { lead: data, created: true };
}

/** The footer every outbound email carries. Transactional mails still get the
 *  address; marketing mails get the address AND a working unsubscribe link. */
function emailFooter({ unsubscribeToken, marketing }) {
  const unsub = unsubscribeToken ? `${SITE_URL}/api/unsubscribe?t=${encodeURIComponent(unsubscribeToken)}` : null;
  return `
<div style="margin-top:34px;padding-top:16px;border-top:1px solid #E6E8EC;font-family:Inter,-apple-system,sans-serif;font-size:11.5px;line-height:1.7;color:#8A93A0;">
  <div><strong style="color:#0B0E14;">${BRAND}</strong> &middot; ${escapeHtml(POSTAL_ADDRESS)} &middot; <a href="${SITE_URL}" style="color:#5B6470;">primebizvalue.com</a></div>
  ${marketing && unsub
    ? `<div>You're receiving this because you asked ${BRAND} to send it. <a href="${unsub}" style="color:#5B6470;">Unsubscribe</a> in one click, any time.</div>`
    : `<div>This message was sent because you requested it or completed a purchase. Questions: <a href="mailto:hello@primebizvalue.com" style="color:#5B6470;">hello@primebizvalue.com</a>${unsub ? ` &middot; <a href="${unsub}" style="color:#5B6470;">Manage email preferences</a>` : ''}</div>`}
  <div>Valuations are directional estimates, not certified appraisals, and are not financial, legal, or tax advice.</div>
</div>`;
}

/**
 * Send through Resend and log to email_events. Refuses to send marketing
 * mail to anyone unsubscribed/bounced. Adds List-Unsubscribe headers so
 * Gmail/Apple surface their native unsubscribe button.
 */
async function sendEmail(db, { to, subject, html, kind, lead, marketing = false, from = FROM_REPORTS, bcc = null, replyTo = 'hello@primebizvalue.com' }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY missing');

  if (marketing && lead && (lead.unsubscribed_at || lead.bounced_at || !lead.marketing_consent)) {
    await db.from('email_events').insert({ lead_id: lead.id, email: to, kind, subject, status: 'suppressed' });
    return { suppressed: true };
  }

  const token = lead ? lead.unsubscribe_token : null;
  const body = html + emailFooter({ unsubscribeToken: token, marketing });
  const headers = {};
  if (token) {
    headers['List-Unsubscribe'] = `<${SITE_URL}/api/unsubscribe?t=${encodeURIComponent(token)}>, <mailto:hello@primebizvalue.com?subject=unsubscribe>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }

  const payload = { from, to: [to], subject, html: body, reply_to: replyTo, headers };
  if (bcc) payload.bcc = Array.isArray(bcc) ? bcc : [bcc];

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(payload),
  });
  const text = await resp.text().catch(() => '');
  let providerId = null;
  try { providerId = JSON.parse(text).id || null; } catch (e) {}

  await db.from('email_events').insert({
    lead_id: lead ? lead.id : null, email: to, kind, subject,
    provider_id: providerId, status: resp.ok ? 'sent' : 'failed',
    error: resp.ok ? null : text.slice(0, 500),
  });

  if (!resp.ok) throw new Error(`Resend ${resp.status}: ${text.slice(0, 200)}`);
  return { sent: true, id: providerId };
}

module.exports = {
  SITE_URL, POSTAL_ADDRESS, BRAND, FROM_REPORTS, FROM_HELLO, INTERNAL_BCC,
  supabase, clientIp, newToken, validEmail, escapeHtml, fmtMoney, upsertLead, emailFooter, sendEmail,
};
