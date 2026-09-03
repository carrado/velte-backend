import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

// "Someone answered your request" (2026-09-03). Same shape and same reasoning
// as priceDropEmail.js: email rather than push, because PushSubscription in
// this repo is vendor-scoped (`ref: 'User'`) and buyer push would mean a whole
// new subscribe flow, while every Google-signed-in buyer already has a
// verified address. Email also survives the buyer not having Velte open —
// which is the entire point here, since a Buyer Request is answered hours
// after it is posted, long after the conversation that created it ended.
//
// Written inline rather than as an emailTemplates/*.html file for the same
// reason that one is: it is short and carries no branding assets to keep in
// step. The OTP templates earn their files; this doesn't.

// Everything interpolated below is vendor-authored — a store name, a quote
// note someone typed. Escaped rather than trusted: an apostrophe in "Chidi's
// Store" must not be able to close an attribute, and a note is free text a
// vendor controls.
function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const naira = (kobo) => `₦${Math.round(kobo / 100).toLocaleString("en-NG")}`;

function leadText(days) {
  if (days == null) return null;
  if (days === 0) return "available now";
  return days === 1 ? "in 1 day" : `in ${days} days`;
}

/**
 * Returns true when the mail was accepted, false otherwise — never throws.
 *
 * The caller advances the notification watermark only on a true, so a mail
 * outage retries on the next sweep instead of silently swallowing the news
 * that somebody answered.
 *
 * `responders` are the NEW ones since the last notification, already sorted
 * by the caller. Only the first few are listed: this is a nudge to come and
 * look, not the comparison itself, which lives in the app where the buyer can
 * act on it.
 */
export async function sendBuyerResponseEmail({
  to,
  name,
  description,
  responders,
  totalAccepted,
  clientUrl,
}) {
  try {
    if (!process.env.RESEND_API_KEY) {
      console.warn("[buyer-requests] RESEND_API_KEY unset — alert not sent");
      return false;
    }

    const greeting = name ? `Hi ${esc(name)},` : "Hi,";
    const count = responders.length;
    const headline =
      count === 1
        ? "A business has answered your request."
        : `${count} businesses have answered your request.`;

    const preview =
      description.length > 90 ? `${description.slice(0, 90)}…` : description;

    // At most three. A longer list makes the mail the destination, and the
    // destination is Velte — where the quotes are actually comparable.
    const rows = responders
      .slice(0, 3)
      .map((r) => {
        const bits = [];
        if (r.priceKobo != null)
          bits.push(`<strong>${naira(r.priceKobo)}</strong>`);
        const lead = leadText(r.leadTimeDays);
        if (lead) bits.push(esc(lead));
        if (r.note) bits.push(esc(r.note));
        const detail = bits.length
          ? bits.join(" · ")
          : '<span style="color:#6b7280">No price given — tap to ask</span>';
        return `
    <div style="padding:12px 0;border-top:1px solid #f1f5f9">
      <div style="font-size:14px;font-weight:600">${esc(r.name)}</div>
      <div style="font-size:14px;margin-top:2px">${detail}</div>
    </div>`;
      })
      .join("");

    const more =
      totalAccepted > 3
        ? `<p style="font-size:13px;color:#6b7280;margin:12px 0 0">and ${totalAccepted - 3} more</p>`
        : "";

    const link = clientUrl
      ? `${String(clientUrl).replace(/\/+$/, "")}/chat/requests`
      : null;

    const html = `
<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#023337">
  <p style="font-size:15px;margin:0 0 16px">${greeting}</p>
  <p style="font-size:15px;margin:0 0 20px">${headline}</p>
  <div style="border:1px solid #e5e7eb;border-radius:16px;padding:16px">
    <div style="font-size:13px;color:#6b7280;margin-bottom:4px">You asked for</div>
    <div style="font-size:14px;margin-bottom:4px">${esc(preview)}</div>
    ${rows}
    ${more}
  </div>
  ${
    link
      ? `<p style="margin:24px 0 0"><a href="${esc(link)}" style="display:inline-block;background:#f97316;color:#fff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 24px;border-radius:999px">Compare and choose</a></p>`
      : ""
  }
  <p style="font-size:12px;color:#9ca3af;margin:24px 0 0">Prices above are quoted by the businesses themselves. Velte doesn't set or verify them.</p>
</div>`;

    const { error } = await resend.emails.send({
      to,
      from: "no-reply@velte.ng",
      subject:
        count === 1
          ? "Someone answered your Velte request"
          : `${count} businesses answered your Velte request`,
      html,
    });
    if (error) throw new Error(error.message);
    return true;
  } catch (err) {
    console.error(
      "[buyer-requests] response email failed:",
      err?.message ?? err,
    );
    return false;
  }
}
