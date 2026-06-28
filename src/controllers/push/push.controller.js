import PushSubscription from '../../models/PushSubscription.model.js';

// A real user has a handful of devices, not dozens. Clearing site data drops the
// browser subscription but can leave a row here, so reinstalls accumulate orphans.
// Keep only the most-recently-seen N per user; the oldest (the orphans) are evicted.
const MAX_SUBSCRIPTIONS_PER_USER = 10;

export const subscribe = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { subscription } = req.body;

    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return res.status(400).json({ message: 'Invalid subscription object' });
    }

    await PushSubscription.findOneAndUpdate(
      { endpoint: subscription.endpoint },
      {
        userId,
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        // A fresh (re)subscribe proves this endpoint is live: clear past failures
        // and mark it seen so the prune below keeps it over older orphan rows.
        failureCount: 0,
        lastSeenAt: new Date(),
      },
      { upsert: true, new: true },
    );

    await pruneOrphanSubscriptions(userId);

    res.status(200).json({ success: true, message: 'Subscribed to push notifications' });
  } catch (error) {
    console.error('Push subscribe error:', error);
    res.status(500).json({ message: 'Failed to save push subscription' });
  }
};

// Evict everything beyond the N most-recently-seen subscriptions for a user.
async function pruneOrphanSubscriptions(userId) {
  const subs = await PushSubscription.find({ userId })
    .sort({ lastSeenAt: -1 })
    .select('_id');

  if (subs.length <= MAX_SUBSCRIPTIONS_PER_USER) return;

  const stale = subs.slice(MAX_SUBSCRIPTIONS_PER_USER).map((s) => s._id);
  await PushSubscription.deleteMany({ _id: { $in: stale } });
  console.log(`[Push] pruned ${stale.length} orphan subscription(s) for user ${userId}`);
}

export const unsubscribe = async (req, res) => {
  try {
    const userId = req.user.userId;

    // If a specific endpoint is provided, remove only that device; otherwise remove all
    const { endpoint } = req.body;
    const filter = endpoint ? { userId, endpoint } : { userId };

    await PushSubscription.deleteMany(filter);

    res.status(200).json({ success: true, message: 'Unsubscribed from push notifications' });
  } catch (error) {
    console.error('Push unsubscribe error:', error);
    res.status(500).json({ message: 'Failed to remove push subscription' });
  }
};
