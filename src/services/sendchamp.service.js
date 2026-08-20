import { AppError } from "../middleware/errorHandler.js";

const SENDCHAMP_URL = "https://api.sendchamp.com/api/v1/sms/send";

// Ported from C:\velte-super-admin\backend\src\services\sendchamp.service.js
// (same shape, same env vars) — the SOLE SMS provider for this repo, buyer-
// and vendor-facing alike: phone-OTP delivery (buyerAuth.controller.js),
// the request-confirmation SMS (buyerRequests.controller.js's
// createRequest), the password-change OTP (changePassword.js), and the
// low-wallet SMS (jobs/walletLowBalance.job.js). Per explicit instruction,
// this repo does not use Termii for anything — helpers/smsSender.js (the
// old Termii integration every one of those call sites used to go through)
// was removed rather than left as unused dead code.
//
// Sendchamp wants digits-only international format (e.g. "2348134844186") —
// no leading "+". Nigerian numbers may arrive as "0801..." or "+234801...";
// normalize both to "234801...".
function normalizePhone(phone) {
  const digits = phone.replace(/[^\d]/g, "");
  if (digits.startsWith("234")) return digits;
  if (digits.startsWith("0")) return `234${digits.slice(1)}`;
  return digits;
}

export async function sendSms(phone, message) {
  const apiKey = process.env.SENDCHAMP_API_KEY;
  if (!apiKey) {
    throw new AppError("SENDCHAMP_API_KEY is not configured", 500);
  }

  const res = await fetch(SENDCHAMP_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      to: [normalizePhone(phone)],
      message,
      sender_name: process.env.SENDCHAMP_SENDER_NAME || "Sendchamp",
      route: process.env.SENDCHAMP_ROUTE || "dnd",
    }),
  });

  const data = await res.json();
  if (!res.ok || data.status !== "success") {
    throw new AppError(data.message || "Failed to send SMS", 502);
  }

  return data.data;
}
