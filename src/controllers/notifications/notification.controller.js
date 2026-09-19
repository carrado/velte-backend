import Notification from '../../models/Notification.model.js';

const PAGE_SIZE = 20;

/**
 * Whose notifications this request is about (2026-09-05).
 *
 * These routes used to read `req.user.userId` — a vendor, always, because
 * that is the only kind of account that had notifications. Buyers have them
 * now too, so the owner has to be resolved rather than assumed.
 *
 * `resolveActor` is already mounted on these routes and prefers the buyer
 * cookie when both are present, which is the right precedence here for the
 * same reason it is everywhere else: someone reading notifications on /chat
 * is acting as a buyer. A vendor in their dashboard carries no buyer cookie,
 * so they resolve as a vendor exactly as before.
 *
 * Falls back to `req.user` so nothing breaks if a route is ever mounted with
 * only the vendor guard.
 */
function ownerOf(req) {
  if (req.actor) return { userId: req.actor.id, ownerType: req.actor.type };
  if (req.user?.userId) return { userId: req.user.userId, ownerType: 'vendor' };
  return null;
}

// Maps backend type enum → frontend NotificationType
const TYPE_MAP = {
  'new-order': 'order',
  'new-lead': 'lead',
  'expired-product': 'product',
  'payment': 'payment',
  'wallet': 'wallet',
  'referral': 'referral',
  'system': 'system',
  'new-message': 'system',
  'buyer-follow': 'system',
  'buyer-request': 'buyer-request',
  'shopping-plan-digest': 'shopping-plan-digest',
};

function toClientShape(n) {
  return {
    id: n._id.toString(),
    type: TYPE_MAP[n.type] ?? 'system',
    title: n.title,
    body: n.body,
    read: n.isRead,
    href: n.url ?? null,
    createdAt: n.createdAt instanceof Date ? n.createdAt.toISOString() : n.createdAt,
  };
}

export const getNotifications = async (req, res) => {
  try {
    const owner = ownerOf(req);
    if (!owner) return res.status(401).json({ success: false, message: 'Not authenticated.' });
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const skip = (page - 1) * PAGE_SIZE;

    const [raw, unreadCount] = await Promise.all([
      Notification.find(owner)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(PAGE_SIZE)
        .lean(),
      Notification.countDocuments({ ...owner, isRead: false }),
    ]);

    res.status(200).json({
      success: true,
      notifications: raw.map(toClientShape),
      unreadCount,
      page,
    });
  } catch (error) {
    console.error('Get notifications error:', error);
    res.status(500).json({ message: 'Failed to retrieve notifications' });
  }
};

export const markRead = async (req, res) => {
  try {
    const owner = ownerOf(req);
    if (!owner) return res.status(401).json({ success: false, message: 'Not authenticated.' });
    const { id } = req.params;

    const notification = await Notification.findOneAndUpdate(
      { _id: id, ...owner },
      { isRead: true },
      { new: true },
    );

    if (!notification) {
      return res.status(404).json({ message: 'Notification not found' });
    }

    res.status(200).json({ success: true, notification: toClientShape(notification.toObject()) });
  } catch (error) {
    console.error('Mark read error:', error);
    res.status(500).json({ message: 'Failed to update notification' });
  }
};

export const markAllRead = async (req, res) => {
  try {
    const owner = ownerOf(req);
    if (!owner) return res.status(401).json({ success: false, message: 'Not authenticated.' });

    await Notification.updateMany({ ...owner, isRead: false }, { isRead: true });

    res.status(200).json({ success: true, message: 'All notifications marked as read' });
  } catch (error) {
    console.error('Mark all read error:', error);
    res.status(500).json({ message: 'Failed to update notifications' });
  }
};

export const deleteNotification = async (req, res) => {
  try {
    const owner = ownerOf(req);
    if (!owner) return res.status(401).json({ success: false, message: 'Not authenticated.' });
    const { id } = req.params;

    const notification = await Notification.findOneAndDelete({ _id: id, ...owner });

    if (!notification) {
      return res.status(404).json({ message: 'Notification not found' });
    }

    res.status(200).json({ success: true, message: 'Notification deleted' });
  } catch (error) {
    console.error('Delete notification error:', error);
    res.status(500).json({ message: 'Failed to delete notification' });
  }
};
