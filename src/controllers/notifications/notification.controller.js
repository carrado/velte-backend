import Notification from '../../models/Notification.model.js';

const PAGE_SIZE = 20;

// Maps backend type enum → frontend NotificationType
const TYPE_MAP = {
  'new-order': 'order',
  'low-stock': 'product',
  'payment': 'payment',
  'system': 'system',
  'new-message': 'system',
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
    const userId = req.user.userId;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const skip = (page - 1) * PAGE_SIZE;

    const [raw, unreadCount] = await Promise.all([
      Notification.find({ userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(PAGE_SIZE)
        .lean(),
      Notification.countDocuments({ userId, isRead: false }),
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
    const userId = req.user.userId;
    const { id } = req.params;

    const notification = await Notification.findOneAndUpdate(
      { _id: id, userId },
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
    const userId = req.user.userId;

    await Notification.updateMany({ userId, isRead: false }, { isRead: true });

    res.status(200).json({ success: true, message: 'All notifications marked as read' });
  } catch (error) {
    console.error('Mark all read error:', error);
    res.status(500).json({ message: 'Failed to update notifications' });
  }
};

export const deleteNotification = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;

    const notification = await Notification.findOneAndDelete({ _id: id, userId });

    if (!notification) {
      return res.status(404).json({ message: 'Notification not found' });
    }

    res.status(200).json({ success: true, message: 'Notification deleted' });
  } catch (error) {
    console.error('Delete notification error:', error);
    res.status(500).json({ message: 'Failed to delete notification' });
  }
};
