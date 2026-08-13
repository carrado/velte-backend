import BuyerRequest from "../models/BuyerRequest.model.js";
import Buyer from "../models/Buyer.model.js";
import { sendSms } from "../services/sendchamp.service.js";

// Business rule per docs/velte_buyer_requests_mvp_spec.md §30-34: batch
// response notifications rather than one SMS per vendor response. Paces
// both the cron tick interval (see the initializer) and, defensively, the
// per-request eligibility gate below, so the gate still holds even if this
// job is ever triggered more often than its own interval.
export const BUYER_REQUEST_NOTIFICATION_INTERVAL_HOURS = 3;

function buildResponseSms(newCount, isFirstNotification) {
  if (isFirstNotification) {
    return newCount === 1
      ? "Velte: A vendor has responded to your request. Open Velte to see their response and chat with them."
      : `Velte: ${newCount} vendors have responded to your request. Open Velte to see their responses and chat with them.`;
  }
  return `Velte: ${newCount} new vendors have responded to your request. Open Velte to see their responses.`;
}

/**
 * Finds active requests with unnotified new responses and sends ONE summary
 * SMS per eligible request — spec §33's exact eligibility rule: active,
 * responseCount > lastBuyerNotifiedResponseCount, and either never notified
 * or the interval has passed since the last notification.
 */
export async function processBuyerRequestResponseNotifications() {
  const intervalCutoff = new Date(
    Date.now() - BUYER_REQUEST_NOTIFICATION_INTERVAL_HOURS * 60 * 60 * 1000,
  );

  const eligible = await BuyerRequest.find({
    status: "active",
    $expr: { $gt: ["$responseCount", "$lastBuyerNotifiedResponseCount"] },
    $or: [
      { lastBuyerNotificationAt: null },
      { lastBuyerNotificationAt: { $lte: intervalCutoff } },
    ],
  });

  let sent = 0;
  for (const request of eligible) {
    const newCount = request.responseCount - request.lastBuyerNotifiedResponseCount;
    if (newCount <= 0) continue; // defensive — the $expr above should already exclude this

    const buyer = await Buyer.findById(request.buyerId).select("phone").lean();
    if (!buyer?.phone) continue;

    const message = buildResponseSms(
      newCount,
      request.lastBuyerNotifiedResponseCount === 0,
    );

    try {
      await sendSms(buyer.phone, message);
      // Only advance the watermark on a CONFIRMED send — spec §53/§55: a
      // failed SMS must not update lastBuyerNotifiedResponseCount, so the
      // next tick retries this same batch instead of silently dropping it.
      // (This single long-lived process has no distributed workers, so the
      // narrow window between two overlapping ticks racing the same
      // document isn't guarded by a separate claim/lock — consistent with
      // every other cron in this repo, e.g. walletLowBalance.job.js, none
      // of which lock either.)
      request.lastBuyerNotifiedResponseCount = request.responseCount;
      request.lastBuyerNotificationAt = new Date();
      await request.save();
      sent += 1;
    } catch (err) {
      console.error(
        `[buyerRequestNotifications] SMS failed for request ${request._id}:`,
        err.message,
      );
    }
  }

  if (eligible.length) {
    console.log(
      `[buyerRequestNotifications] sent ${sent}/${eligible.length} batch notification(s)`,
    );
  }
}
