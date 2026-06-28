import webpush from 'web-push';
import PushSubscription from '../models/PushSubscription.model.js';
import Notification from '../models/Notification.model.js';

// A 401/403 is usually a VAPID key mismatch, but it can also be a transient server
// misconfig (wrong key deployed briefly). So don't delete on the first one — only
// after this many consecutive auth failures, by which point it's clearly the
// subscription, not us. A success resets the counter (see below).
const MAX_AUTH_FAILURES = 5;

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
    icon = '/velte_manifest.png',
    badge = '/velte_manifest.png',
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
  if (!subscriptions.length) {
    console.warn(`[Push] notifyUser(${userId}): no push subscriptions — nothing to deliver`);
    return;
  }

  const pushPayload = JSON.stringify({ title, body, url, tag, icon, badge, requireInteraction });
  console.log(`[Push] notifyUser(${userId}): pushing to ${subscriptions.length} subscription(s)`);

  await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          pushPayload,
        );
        // Mark it alive: refresh freshness (so the per-user prune keeps it) and clear
        // any earlier auth failures. Note: a 201 here means the push SERVICE accepted
        // the message, not that a banner was shown — a subscription orphaned by a
        // clear-site-data still "delivers" here while displaying nothing.
        await PushSubscription.updateOne(
          { endpoint: sub.endpoint },
          { $set: { lastSeenAt: new Date(), failureCount: 0 } },
        );
        console.log(`[Push] ✓ delivered to ${sub.endpoint.slice(0, 60)}…`);
      } catch (err) {
        console.error(
          `[Push] ✗ send failed (status ${err.statusCode}) for ${sub.endpoint.slice(0, 60)}…: ${err.body || err.message}`,
        );
        // 404/410 mean the subscription is expired or the user uninstalled — the push
        // service is telling us it's gone, so remove it immediately.
        if (err.statusCode === 404 || err.statusCode === 410) {
          await PushSubscription.deleteOne({ endpoint: sub.endpoint });
          console.warn(`[Push] removed dead subscription ${sub.endpoint.slice(0, 60)}…`);
        } else if (err.statusCode === 401 || err.statusCode === 403) {
          // VAPID mismatch — but tolerate a transient server misconfig. Count the
          // failure; only prune once it's failed MAX_AUTH_FAILURES times in a row.
          const updated = await PushSubscription.findOneAndUpdate(
            { endpoint: sub.endpoint },
            { $inc: { failureCount: 1 }, $set: { lastFailureAt: new Date() } },
            { new: true },
          );
          if (updated && updated.failureCount >= MAX_AUTH_FAILURES) {
            await PushSubscription.deleteOne({ endpoint: sub.endpoint });
            console.warn(
              `[Push] removed subscription after ${updated.failureCount} auth failures ${sub.endpoint.slice(0, 60)}…`,
            );
          }
        }
        // Anything else (413 payload too big, 429, 5xx, network) is transient/server-side —
        // leave the subscription untouched.
      }
    }),
  );
}
