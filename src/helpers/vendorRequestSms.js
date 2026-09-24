import User from "../models/Users.js";
import { sendSms } from "../services/sendchamp.service.js";
import { smsShortLink } from "./shortLinks.js";

// Texts every vendor a new Buyer Request was matched to (2026-09-24), with a
// velte.ng/s/<code> link straight to that request on their dashboard. Sits
// ALONGSIDE the web push createRequest already sends, not instead of it —
// push is unreliable on the Transsion phones most vendors carry, and a
// request a vendor never hears about dies silently in the 48h window.
//
// Sent to the vendor's phone AS STORED. Vendor numbers are never
// OTP-verified, so a mistyped one texts a stranger; that trade-off was
// taken explicitly (every matched vendor, no opt-in, no cap) — revisit here
// if it ever needs gating.
//
// Carries nothing that identifies the buyer — only what they asked for and
// their budget, which is what the vendor's request page shows before accept.

const SMS_HARD_CAP = 160;

/** One non-GSM character (₦, an emoji, a curly quote) drops the segment
 *  size from 160 to 70 and multiplies the cost of every text. The
 *  description is the buyer's own free text, so it is folded down to plain
 *  GSM-safe ASCII before it goes anywhere near the message. The GSM
 *  extension characters ([]{}\^~|`) are dropped too — each costs two. */
function toGsmSafe(text) {
  return text
    .replace(/₦\s*/g, "NGN ")
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/…/g, "...")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // é -> e, not "e " mid-word
    .replace(/[^A-Za-z0-9 !"#%&'()*+,\-./:;<=>?@$_]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/ ([,.!?;:])/g, "$1") // "each ," left where an emoji was
    .trim();
}

function smsNaira(kobo) {
  return `NGN ${Math.round(kobo / 100).toLocaleString("en-NG")}`;
}

/** Whole hours left in the request's window, never below 1 — "closes in
 *  0 hours" reads as already closed to a vendor who could still answer. */
function hoursLeft(expiresAt) {
  const ms = new Date(expiresAt).getTime() - Date.now();
  return Math.max(1, Math.round(ms / (60 * 60 * 1000)));
}

function buildSms({ description, budgetKobo, link, reminder, expiresAt }) {
  const budget =
    typeof budgetKobo === "number" && budgetKobo > 0
      ? ` Budget ${smsNaira(budgetKobo)}.`
      : "";
  let head = "Velte: A buyer near you wants: ";
  let closes = "";
  if (reminder) {
    head = "Velte reminder: A buyer is still waiting for: ";
    if (expiresAt) {
      const h = hoursLeft(expiresAt);
      closes = ` Closes in about ${h} hour${h === 1 ? "" : "s"}.`;
    }
  }
  const tail = `${budget}${closes} Respond here: ${link}`;

  // The description gets whatever room the fixed parts leave, trimmed with
  // "..." rather than cut mid-word-and-silent, and never allowed to push the
  // link — the one part that must survive — past the cap.
  const room = SMS_HARD_CAP - head.length - tail.length - 1; // 1 = "."
  let desc = toGsmSafe(description).replace(/[.!?]+$/, "");
  if (desc.length > room) {
    // "..." takes the place of the closing "." rather than doubling it.
    desc = `${desc.slice(0, Math.max(room - 2, 0)).trimEnd()}...`;
  } else {
    desc = `${desc}.`;
  }
  return `${head}${desc}${tail}`;
}

/**
 * Best-effort: never throws, logs per vendor. A failed text for one vendor
 * must not stop the rest, and none of it may touch the request itself.
 *
 * Also sends the halfway reminder (jobs/buyerRequestVendorReminder.job.js)
 * with `reminder: true` — same short link, since the code is seeded on
 * (request, vendor), so the reminder points at the link already sent.
 *
 * @param {object}   request   - the BuyerRequest document.
 * @param {string[]} vendorIds - the vendors to text: every matched vendor on
 *                               creation, only the silent ones on reminder.
 * @param {boolean}  [reminder] - send the halfway-reminder wording.
 */
export async function textMatchedVendors({
  request,
  vendorIds,
  reminder = false,
}) {
  const vendors = await User.find({
    _id: { $in: vendorIds },
    phone: { $type: "string", $ne: "" },
  })
    .select("_id phone")
    .lean();

  await Promise.all(
    vendors.map(async (vendor) => {
      try {
        const vendorId = String(vendor._id);
        const link = await smsShortLink(
          `buyer-request:${request._id}:${vendorId}`,
          `/${vendorId}/buyer-requests/${request._id}`,
        );

        await sendSms(
          vendor.phone,
          buildSms({
            description: request.description,
            budgetKobo: request.budgetKobo,
            link,
            reminder,
            expiresAt: request.expiresAt,
          }),
        );
      } catch (err) {
        console.error(
          `[buyerRequests] vendor SMS failed for ${vendor._id}, request ${request._id}:`,
          err?.message ?? err,
        );
      }
    }),
  );
}
