import { createHash } from "crypto";
import ShortLink from "../models/ShortLink.model.js";

// Branded short links for SMS (2026-09-24) — velte.ng/s/<code>, resolved by
// the frontend's /s/[code] route (static map first, then this collection via
// GET /api/shortlinks/:code). Shared by every text that carries a link: the
// vendor's new-request SMS (vendorRequestSms.js) and the buyer's "businesses
// answered" SMS (buyerResponseAlert.js).

const BASE62 =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Same deterministic base62 code velte-super-admin's shortCode.js mints
 *  into this same collection — so re-sending under the same seed reuses the
 *  code already sent rather than orphaning it. */
export function shortCode(seed, length = 7) {
  let num = BigInt(`0x${createHash("sha256").update(seed).digest("hex")}`);
  let code = "";
  while (code.length < length) {
    code = BASE62[Number(num % 62n)] + code;
    num /= 62n;
  }
  return code;
}

/** The site origin links point at, without a trailing slash. */
export function clientOrigin() {
  return (process.env.CLIENT_URL || "https://velte.ng").replace(/\/+$/, "");
}

/**
 * Upserts a short link for `path` (an in-app path like "/chat/requests")
 * under `seed`, and returns it as SMS text — "velte.ng/s/Ab3dE9x", no scheme
 * (phones linkify a bare domain, and every character counts against 160).
 * Throws on a database failure; callers treat the whole SMS as best-effort.
 */
export async function smsShortLink(seed, path) {
  const origin = clientOrigin();
  const code = shortCode(seed);
  // Absolute: /s/[code] hands this straight to NextResponse.redirect.
  await ShortLink.updateOne(
    { code },
    { $set: { url: `${origin}${path}` } },
    { upsert: true },
  );
  return `${origin.replace(/^https?:\/\//, "")}/s/${code}`;
}
