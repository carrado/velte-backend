import { sendPriceDropEmail } from "./priceDropEmail.js";
import { sendSms } from "../services/sendchamp.service.js";

// One place that decides HOW an account hears about a price drop
// (2026-08-29). `owner` is a Buyer or a User — both carry the same three
// fields this needs, which is why nothing below has to care which.
//
// Extracted because two callers need it — the external checker's report
// endpoint and the Velte-product sweep — and duplicating a two-channel
// notification across both is how they drift into saying different things
// about the same event.
//
// Both channels are attempted independently and neither is required:
//   - EMAIL reaches any account with an address on file, carries the photo
//     and the link, and costs nothing.
//   - SMS reaches them whether or not they open email, which is the whole
//     point of a watch — but a phone number is optional on both Buyer and
//     User, and each message costs real money. Best-effort, never assumed.
//
// Returns true if ANY channel got through. The caller stamps
// `lastNotifiedAt` only on true, so a total outage retries next sweep
// instead of silently swallowing the alert.

const naira = (kobo) => `₦${Math.round(kobo / 100).toLocaleString("en-NG")}`;

// SMS is billed per segment, and the segment size depends on the ENCODING:
// 160 characters if every character is in the GSM 03.38 alphabet, but only
// 70 if even one isn't. "₦" is not in that alphabet — measured, a perfectly
// ordinary alert written with it came to 113 characters and billed as TWO
// segments, while the same message using "NGN" came to 119 characters and
// billed as ONE. So SMS spells prices out and avoids the typographic
// characters used freely elsewhere: no ₦, no em dash, no "…".
//
// The email has no such constraint and keeps ₦ — see priceDropEmail.js.
const SMS_MAX_LABEL = 40;
const SMS_HARD_CAP = 160;

/** Naira for SMS: GSM-safe, so the message stays one segment. */
function smsNaira(kobo) {
  return `NGN ${Math.round(kobo / 100).toLocaleString("en-NG")}`;
}

// Every character in GSM 03.38's basic alphabet. Anything outside it drags
// the whole message to UCS-2 and halves the segment size.
const GSM_ALPHABET = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà^{}\\[~]|€",
);

// Typographic characters that routinely appear in merchant listing titles.
// Found by testing real ones: an em dash and curly quotes in a Sony headphone
// title were enough on their own to double the cost of an otherwise ordinary
// alert, even after the price formatting had been fixed.
const GSM_SUBSTITUTIONS = {
  "—": "-",
  "–": "-",
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  "„": '"',
  "…": "...",
  "₦": "NGN ",
  " ": " ",
  "•": "-",
  "×": "x",
};

/** Renders arbitrary third-party text (a listing title) as GSM-safe
 *  characters. Substitutes what has an obvious equivalent and drops what
 *  doesn't — a missing character in a title the buyer already recognises
 *  costs nothing, whereas keeping it doubles the bill for every alert. */
function toGsm(value) {
  let out = "";
  for (const char of String(value ?? "")) {
    const replacement = GSM_SUBSTITUTIONS[char];
    if (replacement !== undefined) out += replacement;
    else if (GSM_ALPHABET.has(char)) out += char;
    // else: dropped.
  }
  return out.replace(/\s+/g, " ").trim();
}

function buildSms({ label, wasKobo, nowKobo }) {
  // Transliterated BEFORE truncating, so the length being measured is the
  // length that will actually be sent.
  const safe = toGsm(label);
  const short =
    safe.length > SMS_MAX_LABEL
      ? `${safe.slice(0, SMS_MAX_LABEL - 3).trimEnd()}...`
      : safe;
  const message = `Velte: price drop. ${short} is now ${smsNaira(nowKobo)} (was ${smsNaira(wasKobo)}). See it: velte.ng/chat/watches`;
  // Belt and braces: an unusually large price could still push past a
  // segment, and a truncated alert beats a doubled bill.
  return message.length > SMS_HARD_CAP
    ? `${message.slice(0, SMS_HARD_CAP - 3)}...`
    : message;
}

export async function notifyPriceDrop({ owner, watch, currentKobo }) {
  const wasText = naira(watch.startPriceKobo);
  const nowText = naira(currentKobo);
  const savedText = naira(Math.max(watch.startPriceKobo - currentKobo, 0));

  let emailed = false;
  let texted = false;

  if (owner?.email) {
    emailed = await sendPriceDropEmail({
      to: owner.email,
      name: owner.name ?? null,
      label: watch.label,
      merchant: watch.merchant,
      imageUrl: watch.imageUrl,
      wasText,
      nowText,
      savedText,
      url: watch.url ?? null,
    }).catch(() => false);
  }

  if (owner?.phone) {
    try {
      await sendSms(
        owner.phone,
        buildSms({
          label: watch.label,
          wasKobo: watch.startPriceKobo,
          nowKobo: currentKobo,
        }),
      );
      texted = true;
    } catch (err) {
      // A missing SENDCHAMP_API_KEY throws here, and so does a provider
      // outage. Neither should stop the email that may already have gone,
      // nor take down the sweep.
      console.error("[price-watch] SMS failed:", err?.message ?? err);
    }
  }

  return emailed || texted;
}
