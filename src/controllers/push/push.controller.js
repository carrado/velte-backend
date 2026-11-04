import PushSubscription from '../../models/PushSubscription.model.js';
import { AppError } from '../../middleware/errorHandler.js';

// A real user has a handful of devices, not dozens. Clearing site data drops the
// browser subscription but can leave a row here, so reinstalls accumulate orphans.
// Keep only the most-recently-seen N per user; the oldest (the orphans) are evicted.
const MAX_SUBSCRIPTIONS_PER_USER = 10;

// Either account kind (2026-09-05) — see Notification.model.js on why
// push stopped being vendor-only. Buyers get notified of their own
// events now (a buyer request being accepted, say), so they must be
// able to register a device.
function ownerOf(req) {
  if (req.actor) return { userId: req.actor.id, ownerType: req.actor.type };
  if (req.user?.userId) return { userId: req.user.userId, ownerType: "vendor" };
  return null;
}

export const subscribe = async (req, res, next) => {
  try {
    const owner = ownerOf(req);
    if (!owner) throw new AppError("Not authenticated.", 401);
    const { userId, ownerType } = owner;
    const { subscription } = req.body;

    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      throw new AppError('Invalid subscription object', 400);
    }

    await PushSubscription.findOneAndUpdate(
      { endpoint: subscription.endpoint },
      {
        userId,
        ownerType,
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

    await pruneOrphanSubscriptions(userId, ownerType);

    res.status(200).json({ success: true, message: 'Subscribed to push notifications' });
  } catch (error) {
    next(error);
  }
};

// Evict everything beyond the N most-recently-seen subscriptions for a user.
async function pruneOrphanSubscriptions(userId, ownerType) {
  const subs = await PushSubscription.find({ userId, ownerType })
    .sort({ lastSeenAt: -1 })
    .select('_id');

  if (subs.length <= MAX_SUBSCRIPTIONS_PER_USER) return;

  const stale = subs.slice(MAX_SUBSCRIPTIONS_PER_USER).map((s) => s._id);
  await PushSubscription.deleteMany({ _id: { $in: stale } });
  console.log(`[Push] pruned ${stale.length} orphan subscription(s) for user ${userId}`);
}

export const unsubscribe = async (req, res, next) => {
  try {
    const owner = ownerOf(req);
    if (!owner) throw new AppError("Not authenticated.", 401);
    const { userId, ownerType } = owner;

    // If a specific endpoint is provided, remove only that device; otherwise remove all
    const { endpoint } = req.body;
    const filter = endpoint
      ? { userId, ownerType, endpoint }
      : { userId, ownerType };

    await PushSubscription.deleteMany(filter);

    res.status(200).json({ success: true, message: 'Unsubscribed from push notifications' });
  } catch (error) {
    next(error);
  }
};
