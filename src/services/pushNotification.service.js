import webpush from 'web-push';
import PushSubscription from '../models/PushSubscription.model.js';
import Notification from '../models/Notification.model.js';

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY,
);

/**
 * Send a push notification to all of a user's registered devices.
 * Also saves an in-app notification record.
 *
 * @param {string} userId
 * @param {{ title, body, url, tag, icon, type, requireInteraction, metadata }} payload
 */
export async function notifyUser(userId, payload) {
  const {
    title,
    body,
    url = null,
    tag = null,
    icon = '/velte_logo_esn5dj.png',
    badge = '/velte_logo_esn5dj.png',
    type = 'system',
    requireInteraction = false,
    metadata = null,
  } = payload;

  // Save in-app notification (always, regardless of push subscriptions)
  await Notification.create({ userId, title, body, url, tag, type, metadata });

  const subscriptions = await PushSubscription.find({ userId });
  if (!subscriptions.length) return;

  const pushPayload = JSON.stringify({ title, body, url, tag, icon, badge, requireInteraction });

  await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          pushPayload,
        );
      } catch (err) {
        // 410 Gone means the subscription is expired or the user uninstalled — remove it
        if (err.statusCode === 410) {
          await PushSubscription.deleteOne({ endpoint: sub.endpoint });
        }
      }
    }),
  );
}
