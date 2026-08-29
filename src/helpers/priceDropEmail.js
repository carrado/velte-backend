import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

// The price-drop alert (2026-08-29). Email rather than push, deliberately:
// PushSubscription in this repo is vendor-scoped (`ref: 'User'`), so buyer
// push would mean a whole new subscribe flow and service-worker path, while
// every Google-signed-in buyer already has a verified email address. Email
// also survives the buyer not having the site open, which is the entire
// point of a watch.
//
// Written inline rather than as an emailTemplates/*.html file because this
// one is short and has no branding assets to keep in step; the OTP templates
// earn their files, this doesn't.

// Everything interpolated below comes from a listing title or a merchant
// name — third-party text — so it is escaped rather than trusted. An
// apostrophe in "Chidi's Store" must not be able to close an attribute.
function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Returns true when the mail was accepted, false otherwise — never throws.
 * The caller only stamps `lastNotifiedAt` on a true, so a mail outage
 * retries tomorrow instead of silently swallowing the alert.
 */
export async function sendPriceDropEmail({
  to,
  name,
  label,
  merchant,
  imageUrl,
  wasText,
  nowText,
  savedText,
  url,
}) {
  try {
    if (!process.env.RESEND_API_KEY) {
      console.warn("[price-watch] RESEND_API_KEY unset — alert not sent");
      return false;
    }

    const greeting = name ? `Hi ${esc(name)},` : "Hi,";
    const where = merchant ? ` on ${esc(merchant)}` : "";
    const link = url ? esc(url) : null;

    const html = `
<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#023337">
  <p style="font-size:15px;margin:0 0 16px">${greeting}</p>
  <p style="font-size:15px;margin:0 0 20px">Something you're watching just got cheaper.</p>
  <div style="border:1px solid #e5e7eb;border-radius:16px;padding:16px">
    ${
      imageUrl
        ? `<img src="${esc(imageUrl)}" alt="" style="width:100%;max-width:200px;border-radius:12px;display:block;margin-bottom:12px" />`
        : ""
    }
    <p style="font-size:15px;font-weight:600;margin:0 0 8px">${esc(label)}${where}</p>
    <p style="margin:0 0 4px;font-size:14px;color:#6b7280">
      <span style="text-decoration:line-through">${esc(wasText)}</span>
      &nbsp;→&nbsp;
      <span style="font-size:18px;font-weight:700;color:#023337">${esc(nowText)}</span>
    </p>
    <p style="margin:8px 0 0;font-size:14px;color:#ea580c;font-weight:600">That's ${esc(savedText)} less than when you saved it.</p>
    ${
      link
        ? `<a href="${link}" style="display:inline-block;margin-top:16px;background:#f97316;color:#fff;text-decoration:none;padding:10px 18px;border-radius:999px;font-size:14px;font-weight:600">View the listing</a>`
        : ""
    }
  </div>
  <p style="font-size:12px;color:#6b7280;margin:20px 0 0">
    You're getting this because you asked Velte to watch this item.
    Manage your watches any time at velte.ng.
  </p>
</div>`.trim();

    const result = await resend.emails.send({
      to,
      from: "no-reply@velte.ng",
      subject: `Price drop: ${label.slice(0, 60)} is now ${nowText}`,
      html,
    });

    // Resend's SDK resolves (doesn't throw) on an API-level error and puts
    // it in `error` instead — same gotcha emailSender.js already handles.
    if (result?.error) {
      console.error("[price-watch] resend error:", result.error);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[price-watch] email failed:", err?.message ?? err);
    return false;
  }
}
