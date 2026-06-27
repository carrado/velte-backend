import webpush from 'web-push';
import PushSubscription from '../models/PushSubscription.model.js';
import Notification from '../models/Notification.model.js';

// Configure VAPID at module load. setVapidDetails THROWS on a missing/malformed
// subject or key — and because this module is imported by the order bridge
// (orderPayment.controller), an unguarded throw here would take down order
// creation too, not just push. So guard it: log loudly and disable push, but keep
// the module (and the in-app bell, which needs no VAPID) working.
let pushEnabled = false;
try {
  if (
    !process.env.VAPID_SUBJECT ||
    !process.env.VAPID_PUBLIC_KEY ||
    !process.env.VAPID_PRIVATE_KEY
  ) {
    throw new Error("VAPID_SUBJECT / VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not all set");
  }
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
  pushEnabled = true;
} catch (err) {
  console.error(
    `[Push] Web-push disabled — invalid VAPID config: ${err.message}. ` +
      `In-app notifications still work; fix the VAPID_* env vars to enable push.`,
  );
}

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

  // Save in-app notification (always, regardless of push subscriptions or VAPID).
  await Notification.create({ userId, title, body, url, tag, type, metadata });

  // Web-push is best-effort and needs valid VAPID config; the in-app bell above
  // is the guaranteed channel.
  if (!pushEnabled) return;

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
