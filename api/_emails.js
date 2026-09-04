// /api/_emails.js — the email copy, in one place.
// Plain, short, no hype. Each one earns its place or it doesn't go out.

const { SITE_URL, escapeHtml, fmtMoney } = require('./_lib');

const wrap = (inner) => `<!doctype html><html><body style="margin:0;padding:0;background:#F7F8FA;">
<div style="max-width:600px;margin:0 auto;padding:28px 20px;font-family:Inter,-apple-system,Segoe UI,Roboto,sans-serif;color:#0B0E14;line-height:1.6;">
  <div style="font-size:17px;font-weight:700;letter-spacing:-.01em;margin-bottom:22px;">Prime<span style="color:#2454FF;">BizValue</span></div>
  ${inner}
</div></body></html>`;

const btn = (href, label) => `<p style="margin:22px 0;"><a href="${href}" style="display:inline-block;background:#2454FF;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 22px;border-radius:9px;">${label}</a></p>`;
const p = (t) => `<p style="margin:0 0 14px;font-size:15px;">${t}</p>`;
const small = (t) => `<p style="margin:0 0 14px;font-size:13px;color:#5B6470;">${t}</p>`;
const first = (lead) => lead && lead.first_name ? escapeHtml(lead.first_name) : null;
const hi = (lead) => first(lead) ? `Hi ${first(lead)},` : 'Hi,';

function valuationSummary(lead, v) {
  const low = fmtMoney(v.low), high = fmtMoney(v.high);
  const sde = v.sde != null ? fmtMoney(v.sde) : null;
  const rev = v.revenue != null ? fmtMoney(v.revenue) : null;
  return {
    subject: `Your estimated business value: ${low} – ${high}`,
    html: wrap(`
      ${p(hi(lead))}
      ${p(`Here's the number the tool produced, so you have it somewhere other than a browser tab:`)}
      <div style="background:#0B0E14;color:#fff;border-radius:12px;padding:22px 24px;margin:6px 0 20px;">
        <div style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#8FADFF;font-weight:700;">Estimated business value</div>
        <div style="font-size:28px;font-weight:700;letter-spacing:-.01em;margin:6px 0 4px;">${low} – ${high}</div>
        ${sde ? `<div style="font-size:13px;color:rgba(255,255,255,.7);">Seller's Discretionary Earnings: <strong style="color:#fff;">${sde}</strong>${rev ? ` &middot; Revenue: ${rev}` : ''}</div>` : ''}
      </div>
      ${p(`A few honest things about that range. It comes from a fixed set of Main Street SDE multiples applied to your recast earnings. It is directional. It is also, in our experience, closer to reality than what most sellers start from, which is usually a neighbor's rumor or what they need to net.`)}
      ${p(`What it isn't yet: documented. A buyer's lender will want to see how the add-backs were built and whether the price survives debt service. That's what the full report is for, and you can read one end to end before deciding:`)}
      ${btn(`${SITE_URL}/sample-report.html`, 'See a complete sample report')}
      ${small(`Your uploaded financials are retained only to produce and support your valuation and are never sold. Full policy: <a href="${SITE_URL}/confidentiality.html" style="color:#5B6470;">primebizvalue.com/confidentiality</a>`)}
    `),
  };
}

function nurture1(lead) {
  const range = lead.last_valuation_low && lead.last_valuation_high
    ? `${fmtMoney(lead.last_valuation_low)} – ${fmtMoney(lead.last_valuation_high)}` : 'your estimated range';
  return {
    subject: `The number a buyer's lender actually checks`,
    html: wrap(`
      ${p(hi(lead))}
      ${p(`Yesterday the tool gave you ${range}. Here's the part most sellers learn too late: the asking price isn't what kills a deal. The lender does.`)}
      ${p(`Roughly nine out of ten Main Street sales are SBA financed, and the underwriter runs one calculation before anything else: can the business's cash flow cover the loan payment with room to spare? They want at least 1.25x coverage. If your price doesn't clear that, the deal dies in underwriting, weeks after everyone's spent money on it.`)}
      ${p(`The Detailed Report runs that math for you, before a lender does. It shows the loan a buyer would need at your price, the annual debt service, and the coverage ratio, so you know whether the number is financeable or just optimistic.`)}
      ${btn(`${SITE_URL}/sample-report.html`, 'See the DSCR section in the sample')}
      ${small(`One more from us in a few days, then we'll leave you alone.`)}
    `),
  };
}

function nurture2(lead) {
  return {
    subject: `What's in the $799 report, and what isn't`,
    html: wrap(`
      ${p(hi(lead))}
      ${p(`Straight answer, because you're deciding whether to spend money.`)}
      ${p(`<strong>What's in it:</strong> the full itemized recast, every add-back on its own line with the reason it's there. A sanity check that flags anything a skeptical buyer would flag. The multiple, and every adjustment that moved it. SBA financing and debt-coverage math. A closing breakdown that shows what you'd actually walk away with after debt, fees, and taxes. All of it built from your P&amp;L, in about ten minutes.`)}
      ${p(`<strong>What isn't:</strong> a certified appraisal. A broker. A guarantee. We say that plainly on every page of the report because a number is only worth something in a negotiation if it's honest about what it is.`)}
      ${p(`For comparison, a broker's opinion of value runs $2,500 to $10,000 and takes weeks. This is a tenth of that, and you can read the whole thing before you buy it.`)}
      ${btn(`${SITE_URL}/tool.html?tier=detailed`, 'Get the Detailed Report')}
      ${small(`Or start with the $199 Basic and upgrade later for the difference. Nothing expires.`)}
    `),
  };
}

function nurture3(lead) {
  return {
    subject: `Last one from us`,
    html: wrap(`
      ${p(hi(lead))}
      ${p(`This is the last email in this series. Your number is still sitting in the tool whenever you want it, and the sample report is still free to read.`)}
      ${p(`If you're not selling for a while, that's fine. Most owners run their numbers a year or two before they list, and the ones who do tend to fix the things that were costing them value before a buyer prices them in.`)}
      ${p(`If you're closer than that, the report is the fastest way to walk into a negotiation with something a lender will respect.`)}
      ${btn(`${SITE_URL}/tool.html`, 'Back to your valuation')}
      ${small(`Questions, any time: hello@primebizvalue.com. We read every one.`)}
    `),
  };
}

module.exports = { valuationSummary, nurture1, nurture2, nurture3 };
