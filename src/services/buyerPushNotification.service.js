import webpush from "web-push";
import BuyerPushSubscription from "../models/BuyerPushSubscription.model.js";
import { isPushEnabled } from "./pushNotification.service.js";

// Buyer-facing counterpart to the push half of pushNotification.service.js's
// notifyUser — but genuinely separate, not a copy-paste: this only ever
// SENDS push (buyerNotification.service.js's notifyBuyer/notifyBuyers own
// the in-app `BuyerNotification` write, this doesn't duplicate it), reuses
// `isPushEnabled()`/the already-configured `webpush` singleton from that
// module rather than re-running VAPID setup a second time, and has no
// HIGH_URGENCY_TYPES concept — every buyer notification type is equally
// worth a real-time push (there's no "routine" bucket to defer).
const MAX_AUTH_FAILURES = 5;

async function sendToSubscriptions(subscriptions, payload) {
  if (!subscriptions.length) return;

  const {
    title,
    body,
    url = null,
    tag = null,
    icon = "/velte_manifest.png",
    badge = "/velte_manifest.png",
    requireInteraction = false,
  } = payload;
  const pushPayload = JSON.stringify({
    title,
    body,
    url,
    tag,
    icon,
    badge,
    requireInteraction,
  });

  await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          pushPayload,
        );
        await BuyerPushSubscription.updateOne(
          { endpoint: sub.endpoint },
          { $set: { lastSeenAt: new Date(), failureCount: 0 } },
        );
      } catch (err) {
        // Same handling as pushNotification.service.js's notifyUser — see
        // its own comments for why each branch does what it does.
        if (err.statusCode === 404 || err.statusCode === 410) {
          await BuyerPushSubscription.deleteOne({ endpoint: sub.endpoint });
        } else if (err.statusCode === 401 || err.statusCode === 403) {
          const updated = await BuyerPushSubscription.findOneAndUpdate(
            { endpoint: sub.endpoint },
            { $inc: { failureCount: 1 }, $set: { lastFailureAt: new Date() } },
            { new: true },
          );
          if (updated && updated.failureCount >= MAX_AUTH_FAILURES) {
            await BuyerPushSubscription.deleteOne({ endpoint: sub.endpoint });
          }
        }
        // Anything else (413/429/5xx/network) is transient — leave as-is.
      }
    }),
  );
}

export async function sendBuyerPush(buyerId, payload) {
  if (!isPushEnabled()) return;
  const subscriptions = await BuyerPushSubscription.find({ buyerId });
  await sendToSubscriptions(subscriptions, payload);
}

/** Fan-out variant — one query across every recipient's subscriptions
 *  instead of N per-buyer queries, for the followed-vendor triggers that
 *  can address dozens of buyers at once. */
export async function sendBuyerPushToMany(buyerIds, payload) {
  if (!isPushEnabled() || !buyerIds.length) return;
  const subscriptions = await BuyerPushSubscription.find({
    buyerId: { $in: buyerIds },
  });
  await sendToSubscriptions(subscriptions, payload);
}
