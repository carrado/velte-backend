import BuyerPushSubscription from "../../models/BuyerPushSubscription.model.js";

// Mirrors push.controller.js (vendor) exactly, scoped to buyerId — see
// BuyerPushSubscription.model.js's own comment on why this is a separate
// implementation rather than a shared one.
const MAX_SUBSCRIPTIONS_PER_BUYER = 10;

export const subscribe = async (req, res) => {
  try {
    const buyerId = req.buyer.buyerId;
    const { subscription } = req.body;

    if (
      !subscription?.endpoint ||
      !subscription?.keys?.p256dh ||
      !subscription?.keys?.auth
    ) {
      return res.status(400).json({ message: "Invalid subscription object" });
    }

    await BuyerPushSubscription.findOneAndUpdate(
      { endpoint: subscription.endpoint },
      {
        buyerId,
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        failureCount: 0,
        lastSeenAt: new Date(),
      },
      { upsert: true, new: true },
    );

    await pruneOrphanSubscriptions(buyerId);

    res
      .status(200)
      .json({ success: true, message: "Subscribed to push notifications" });
  } catch (error) {
    console.error("Buyer push subscribe error:", error);
    res.status(500).json({ message: "Failed to save push subscription" });
  }
};

async function pruneOrphanSubscriptions(buyerId) {
  const subs = await BuyerPushSubscription.find({ buyerId })
    .sort({ lastSeenAt: -1 })
    .select("_id");

  if (subs.length <= MAX_SUBSCRIPTIONS_PER_BUYER) return;

  const stale = subs.slice(MAX_SUBSCRIPTIONS_PER_BUYER).map((s) => s._id);
  await BuyerPushSubscription.deleteMany({ _id: { $in: stale } });
  console.log(
    `[BuyerPush] pruned ${stale.length} orphan subscription(s) for buyer ${buyerId}`,
  );
}

export const unsubscribe = async (req, res) => {
  try {
    const buyerId = req.buyer.buyerId;
    const { endpoint } = req.body;
    const filter = endpoint ? { buyerId, endpoint } : { buyerId };

    await BuyerPushSubscription.deleteMany(filter);

    res
      .status(200)
      .json({ success: true, message: "Unsubscribed from push notifications" });
  } catch (error) {
    console.error("Buyer push unsubscribe error:", error);
    res.status(500).json({ message: "Failed to remove push subscription" });
  }
};
