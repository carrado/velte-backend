import BuyerRequest from "../models/BuyerRequest.model.js";
import BuyerRequestResponse from "../models/BuyerRequestResponse.model.js";
import Buyer from "../models/Buyer.model.js";
import Store from "../models/Store.model.js";
import User from "../models/Users.js";
import { notifyBuyerOfResponses } from "../helpers/buyerResponseAlert.js";

// The buyer-side return path for Buyer Requests — RESTORED 2026-09-03.
//
// ── Why this exists again ───────────────────────────────────────────────
//
// A version of this ran until 2026-08-18, when it was deleted on the stated
// grounds that "buyers have no account/inbox to notify into anymore". That
// was true then. It stopped being true on 2026-08-26, when buyers got real
// accounts, and posting a request has REQUIRED one since 2026-08-29 — so
// every request now has a reachable, verified owner behind it.
//
// What was left behind in the meantime is the thing that makes an
// asynchronous marketplace fail: a buyer describes what they need, Velte
// broadcasts it to matched vendors, a vendor answers six hours later — and
// nobody ever tells the buyer. The conversation that created the request
// ended long ago. Without this sweep the entire request feature is a
// one-way broadcast, and the quotes added alongside it (see
// BuyerRequestResponse) would sit unread.
//
// ── Two things it does differently from the deleted version ─────────────
//
// 1. It watches `acceptedCount`, NOT `responseCount`. The old one counted
//    declines, which are never shown to the buyer — so it could send
//    "someone responded" to a buyer who opened Velte and found nothing.
// 2. It notifies by EMAIL as well as SMS. The old one was SMS-only because a
//    phone number was all an anonymous buyer had. Buyers now sign in with
//    Google, so email is the channel that always exists, costs nothing, and
//    can actually carry the quotes.
//
// Batched rather than per-response, unchanged from the original design: a
// request matched to eight vendors that all answer within an hour is ONE
// notification, not eight.

/** Paces both the tick interval and, defensively, the per-request
 *  eligibility gate below — so the gate still holds if this is ever
 *  triggered more often than its own interval. */
export const BUYER_REQUEST_NOTIFICATION_INTERVAL_HOURS = 3;

const INTERVAL_MS = BUYER_REQUEST_NOTIFICATION_INTERVAL_HOURS * 60 * 60 * 1000;

/** A cap per sweep. Each eligible request costs a handful of queries plus an
 *  email and possibly an SMS; a backlog is drained over successive ticks
 *  rather than in one long-running pass. */
const BATCH = 50;

/** Resolves the new responders to the names and quotes a notification shows.
 *
 *  Deliberately mirrors listMyRequests' own resolution — store name first,
 *  business name, then account name — so the email and the page a buyer lands
 *  on call the same vendor the same thing. A vendor whose account has since
 *  been deleted is skipped, exactly as it is there: a mail saying "2
 *  businesses answered" that lists one is worse than one saying "1".
 */
async function describeResponders(responses) {
  const vendorIds = [...new Set(responses.map((r) => String(r.vendorId)))];
  const [vendors, stores] = await Promise.all([
    User.find({ _id: { $in: vendorIds } })
      .select("name company.name")
      .lean(),
    Store.find({ vendorId: { $in: vendorIds } })
      .select("vendorId name")
      .lean(),
  ]);
  const vendorById = new Map(vendors.map((v) => [String(v._id), v]));
  const storeByVendorId = new Map(stores.map((s) => [String(s.vendorId), s]));

  const out = [];
  for (const response of responses) {
    const id = String(response.vendorId);
    const vendor = vendorById.get(id);
    if (!vendor) continue;
    const store = storeByVendorId.get(id);
    out.push({
      name: store?.name || vendor.company?.name || vendor.name,
      priceKobo: response.priceKobo ?? null,
      leadTimeDays: response.leadTimeDays ?? null,
      note: response.note ?? null,
    });
  }

  // Cheapest first, and quotes before non-quotes. The email lists only the
  // first few, so the ordering decides what a buyer sees without opening
  // anything — and the cheapest real number is the most useful thing to lead
  // with. Vendors who accepted without quoting go last, because "no price
  // given" is not an offer to compare against one that is.
  out.sort((a, b) => {
    if (a.priceKobo == null && b.priceKobo == null) return 0;
    if (a.priceKobo == null) return 1;
    if (b.priceKobo == null) return -1;
    return a.priceKobo - b.priceKobo;
  });
  return out;
}

export async function processBuyerRequestResponseNotifications() {
  const intervalCutoff = new Date(Date.now() - INTERVAL_MS);

  const eligible = await BuyerRequest.find({
    status: "active",
    // Somebody has accepted since we last said so.
    $expr: { $gt: ["$acceptedCount", "$lastBuyerNotifiedAcceptedCount"] },
    // A request with no account behind it cannot be notified. Legacy rows
    // from before 2026-08-29 can still be in this state.
    buyerId: { $ne: null },
    $or: [
      { lastBuyerNotificationAt: null },
      { lastBuyerNotificationAt: { $lte: intervalCutoff } },
    ],
  })
    .sort({ lastResponseAt: 1 })
    .limit(BATCH);

  let sent = 0;

  for (const request of eligible) {
    try {
      const buyer = await Buyer.findById(request.buyerId)
        .select("name email phone")
        .lean();
      if (!buyer?.email && !buyer?.phone) continue;

      // The accepts this buyer has not been told about yet. Taken by the
      // watermark rather than by a timestamp, because the count is what the
      // eligibility check above is expressed in — mixing the two is how a
      // response lands exactly on a sweep boundary and is either announced
      // twice or never.
      const all = await BuyerRequestResponse.find({
        requestId: request._id,
        decision: "accepted",
      })
        .select("vendorId priceKobo leadTimeDays note createdAt")
        .sort({ createdAt: 1 })
        .lean();

      const fresh = all.slice(request.lastBuyerNotifiedAcceptedCount);
      if (!fresh.length) continue;

      const responders = await describeResponders(fresh);
      if (!responders.length) {
        // Every new responder's account is gone. Nothing to say — but the
        // watermark still advances, or this request is re-examined on every
        // sweep forever.
        request.lastBuyerNotifiedAcceptedCount = all.length;
        request.lastBuyerNotificationAt = new Date();
        await request.save();
        continue;
      }

      const delivered = await notifyBuyerOfResponses({
        buyer,
        request,
        responders,
        totalAccepted: all.length,
      });

      // Advanced only on a CONFIRMED send. A failed email AND SMS leaves the
      // watermark where it was, so the next sweep retries this same batch
      // rather than silently dropping the one notification the feature turns
      // on. (Single long-lived process, no distributed workers — so the
      // narrow window between two overlapping ticks isn't lock-guarded, the
      // same as every other cron here.)
      if (delivered) {
        request.lastBuyerNotifiedAcceptedCount = all.length;
        request.lastBuyerNotificationAt = new Date();
        await request.save();
        sent += 1;
      }
    } catch (err) {
      // One bad request must not stop the batch.
      console.error(
        `[buyer-requests] notification for ${request._id} failed:`,
        err?.message ?? err,
      );
    }
  }

  if (sent) {
    console.log(`[buyer-requests] notified ${sent} buyer(s) of new responses`);
  }
  return sent;
}

export function startBuyerRequestNotificationsCron() {
  const run = () => {
    processBuyerRequestResponseNotifications().catch((err) =>
      console.error("[buyer-requests] sweep failed:", err?.message ?? err),
    );
  };

  // Plain setInterval, same as every other sweep in this repo — the process
  // is already assumed long-lived, so this needs no scheduler and no new
  // dependency.
  //
  // No immediate run on boot: a redeploy would otherwise fire a wave of email
  // and SMS at every buyer with a pending response at once, and SMS costs
  // real money per send. Nobody is harmed by hearing three hours later about
  // something that already happened.
  const timer = setInterval(run, INTERVAL_MS);
  timer.unref();

  console.log(
    `[buyer-requests] response notifications every ${BUYER_REQUEST_NOTIFICATION_INTERVAL_HOURS}h`,
  );
}
