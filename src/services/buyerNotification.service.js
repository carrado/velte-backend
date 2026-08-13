import BuyerNotification from "../models/BuyerNotification.model.js";
import { sendBuyerPush, sendBuyerPushToMany } from "./buyerPushNotification.service.js";

// The buyer-facing counterpart to pushNotification.service.js's notifyUser
// — no SMS leg (that used to exist for request responses via the now-
// retired buyerRequestNotifications.job.js; product direction was in-app
// only), but DOES push, same as the vendor side: an in-app `BuyerNotification`
// row always gets written (the guaranteed channel, same reasoning as
// notifyUser's own comment), and a push follows best-effort if the buyer has
// a live subscription (see buyerPushNotification.service.js — a no-op if
// push isn't configured or the buyer never subscribed).
export async function notifyBuyer(
  buyerId,
  { title, body, type = "system", url = null, metadata = null },
) {
  await BuyerNotification.create({ buyerId, title, body, type, url, metadata });
  // Best-effort — a push failure must never surface as a failed notify;
  // the in-app row above already succeeded and is the source of truth.
  sendBuyerPush(buyerId, { title, body, url, tag: type }).catch((err) => {
    console.error(`[buyerNotification] push failed for buyer ${buyerId}:`, err.message);
  });
}

/** Fan-out variant — followed-vendor triggers (new listing, store update)
 *  can address dozens of buyers at once; insertMany/one push query is one
 *  round trip instead of N. */
export async function notifyBuyers(
  buyerIds,
  { title, body, type = "system", url = null, metadata = null },
) {
  if (!buyerIds.length) return;
  await BuyerNotification.insertMany(
    buyerIds.map((buyerId) => ({ buyerId, title, body, type, url, metadata })),
  );
  sendBuyerPushToMany(buyerIds, { title, body, url, tag: type }).catch((err) => {
    console.error(`[buyerNotification] bulk push failed:`, err.message);
  });
}
