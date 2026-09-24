import { sendBuyerResponseEmail } from "./buyerResponseEmail.js";
import { sendSms } from "../services/sendchamp.service.js";
import { smsShortLink } from "./shortLinks.js";

// One place that decides HOW a buyer hears that their request was answered
// (2026-09-03). Extracted on its own for a simple reason: more than one
// thing will eventually want to send this, and duplicating a notification
// is how two copies drift into saying different things about the same
// event.
//
// Both channels are attempted independently and neither is required:
//   - EMAIL reaches any buyer with an address, carries the quotes, and costs
//     nothing. Every Google-signed-in buyer has one, and since 2026-08-29
//     posting a request requires an account — so in practice this always has
//     somewhere to go.
//   - SMS reaches them whether or not they open email, but a phone is
//     optional on Buyer and each message costs real money. Best-effort.
//
// Returns true if ANY channel got through. The caller advances the watermark
// only on true, so a total outage retries next sweep rather than silently
// swallowing the one notification this whole feature depends on.

const SMS_HARD_CAP = 160;

/** SMS is billed per segment and the segment size depends on ENCODING: 160
 *  characters of GSM 03.38, but only 70 if a single character falls outside
 *  it. "₦" does. So SMS spells prices as NGN and avoids the typography used
 *  freely in the email. */
function smsNaira(kobo) {
  return `NGN ${Math.round(kobo / 100).toLocaleString("en-NG")}`;
}

function buildSms({ count, cheapestKobo, link }) {
  const who =
    count === 1 ? "A business sent an offer" : `${count} businesses sent offers`;
  // The cheapest quote is the one fact worth paying a segment to carry: it
  // is what tells someone whether opening the app right now is worth it.
  const price =
    cheapestKobo != null
      ? ` Best price so far: ${smsNaira(cheapestKobo)}.`
      : "";
  // The link (2026-09-24) opens the buyer's requests page, where the offers
  // sit side by side and Message starts the chat — the whole next step, one
  // tap from the text. Without one (link minting failed), the old line.
  const next = link
    ? ` Compare and pick one: ${link}`
    : " Open Velte to compare and choose.";
  const msg = `Velte: ${who} on your request.${price}${next}`;
  return msg.length > SMS_HARD_CAP ? msg.slice(0, SMS_HARD_CAP) : msg;
}

/**
 * @param {object}   buyer       - { name, email, phone } (Buyer and User
 *                                 share this same shape).
 * @param {object}   request     - the BuyerRequest document.
 * @param {object[]} responders  - the NEW accepted responders since the last
 *                                 notification, each { name, priceKobo,
 *                                 leadTimeDays, note }.
 * @param {number}   totalAccepted - all accepts on this request, for "and N more".
 */
export async function notifyBuyerOfResponses({
  buyer,
  request,
  responders,
  totalAccepted,
}) {
  if (!responders.length) return false;

  let emailed = false;
  let texted = false;

  if (buyer?.email) {
    emailed = await sendBuyerResponseEmail({
      to: buyer.email,
      name: buyer.name ?? null,
      description: request.description,
      responders,
      totalAccepted,
      clientUrl: process.env.CLIENT_URL ?? null,
    }).catch(() => false);
  }

  if (buyer?.phone) {
    try {
      const priced = responders
        .map((r) => r.priceKobo)
        .filter((p) => typeof p === "number" && p > 0);
      // One code per request, so every "offers arrived" text for the same
      // request reuses it. A failed mint just means the linkless wording.
      const link = await smsShortLink(
        `buyer-requests:${request._id}`,
        "/chat/requests",
      ).catch(() => null);
      await sendSms(
        buyer.phone,
        buildSms({
          count: responders.length,
          cheapestKobo: priced.length ? Math.min(...priced) : null,
          link,
        }),
      );
      texted = true;
    } catch (err) {
      // A missing SENDCHAMP_API_KEY throws here, and so does a provider
      // outage. Neither should stop the email that may already have gone,
      // nor take down the sweep.
      console.error("[buyer-requests] SMS failed:", err?.message ?? err);
    }
  }

  return emailed || texted;
}
