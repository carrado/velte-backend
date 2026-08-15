import Buyer from "../models/Buyer.model.js";
import BuyerNotification from "../models/BuyerNotification.model.js";
import { sendBuyerPush, sendBuyerPushToMany } from "./buyerPushNotification.service.js";
import { sendSms } from "./sendchamp.service.js";

// The buyer-facing counterpart to pushNotification.service.js's notifyUser
// — DOES push, same as the vendor side: an in-app `BuyerNotification` row
// always gets written (the guaranteed channel, same reasoning as
// notifyUser's own comment), and a push follows best-effort if the buyer has
// a live subscription (see buyerPushNotification.service.js — a no-op if
// push isn't configured or the buyer never subscribed).
//
// SMS re-added 2026-08-14 (product decision — reverses the 2026-08 "in-app
// only" call, see this file's own prior comment) but deliberately narrow:
// only for SMS_TYPES below, not every notification type. request-response
// is the one case where a buyer is actively waiting to hear back from a
// real person on a real timeline — the flagship "vendor responded" moment
// that made phone verification worth asking for in the first place. It's
// also always a single buyer (notifyBuyer, never the notifyBuyers fan-out
// below) — saved-price-change/followed-* stay in-app+push only: those can
// address dozens of buyers per trigger via notifyBuyers, where SMS would be
// both spammy and a real per-message cost with no matching urgency.
const SMS_TYPES = new Set(["request-response"]);

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

  if (SMS_TYPES.has(type)) {
    Buyer.findById(buyerId)
      .select("phone")
      .lean()
      .then((buyer) => {
        if (!buyer?.phone) return null;
        const link = url ? ` ${process.env.FRONTEND_URL}${url}` : "";
        return sendSms(buyer.phone, `Velte: ${body}${link}`);
      })
      .catch((err) => {
        console.error(`[buyerNotification] SMS failed for buyer ${buyerId}:`, err.message);
      });
  }
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
