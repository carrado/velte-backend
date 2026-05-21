import PushSubscription from '../../models/PushSubscription.model.js';

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
      },
      { upsert: true, new: true },
    );

    res.status(200).json({ success: true, message: 'Subscribed to push notifications' });
  } catch (error) {
    console.error('Push subscribe error:', error);
    res.status(500).json({ message: 'Failed to save push subscription' });
  }
};

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
