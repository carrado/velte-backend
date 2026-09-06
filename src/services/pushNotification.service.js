import webpush from 'web-push';
import PushSubscription from '../models/PushSubscription.model.js';
import Notification from '../models/Notification.model.js';

// A 401/403 is usually a VAPID key mismatch, but it can also be a transient server
// misconfig (wrong key deployed briefly). So don't delete on the first one — only
// after this many consecutive auth failures, by which point it's clearly the
// subscription, not us. A success resets the counter (see below).
const MAX_AUTH_FAILURES = 5;

// All current notification types are worth pushing through OS/FCM
// battery-saving states rather than getting deferred like a routine
// notification — a buyer waiting to chat, a wallet about to stop bidding on
// leads, a referral payout, or a system alert. Kept as an allowlist (rather
// than applying high urgency unconditionally) so a future low-priority type
// (e.g. a marketing/announcement notification) can opt out by omission.
const HIGH_URGENCY_TYPES = new Set(['new-lead', 'wallet', 'referral', 'system']);
const HIGH_URGENCY_TTL_SECONDS = 60 * 60 * 4;

// Configure VAPID at module load. setVapidDetails THROWS on a missing/malformed
// subject or key — and because this module can be imported from request-handling
// paths (e.g. the wallet debit hook), an unguarded throw here would take down
// whatever called it too, not just push. So guard it: log loudly and disable
// push, but keep the module (and the in-app bell, which needs no VAPID) working.
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

export function isPushEnabled() {
  return pushEnabled;
}

/**
 * Send a push notification to all of an OWNER's registered devices, and save
 * the in-app notification record.
 *
 * Owner-keyed since 2026-09-05, because a buyer-owned notification (a buyer
 * request being accepted, say) has to reach the Buyer collection just as
 * readily as a vendor one reaches User. Before this, `Notification` and
 * `PushSubscription` both carried `ref: 'User'` — not decoration, but the
 * assumption that only vendors are ever notified, which is why buyers had no
 * in-app notifications at all.
 *
 * @param {{ ownerId: string, ownerType: 'buyer'|'vendor' }} owner
 * @param {{ title, body, url, tag, icon, type, requireInteraction, metadata }} payload
 */
export async function notifyOwner({ ownerId, ownerType = 'vendor' }, payload) {
  return notifyUserInternal(ownerId, ownerType, payload);
}

/**
 * The vendor-shaped call, unchanged for every existing caller.
 *
 * Kept as a wrapper rather than migrated: a dozen call sites across orders,
 * wallet, referrals and buyer-requests all mean "a vendor", and rewriting
 * them to say so explicitly would be churn with a chance of getting one
 * wrong, to express what this wrapper already states once.
 *
 * @param {string} userId a vendor User._id
 */
export async function notifyUser(userId, payload) {
  return notifyUserInternal(userId, 'vendor', payload);
}

async function notifyUserInternal(userId, ownerType, payload) {
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
  await Notification.create({ userId, ownerType, title, body, url, tag, type, metadata });

  // Web-push is best-effort and needs valid VAPID config; the in-app bell above
  // is the guaranteed channel.
  if (!pushEnabled) return;

  // Scoped by ownerType as well as id: a Buyer._id and a User._id are both
  // ObjectIds, and pushing one account's alert to the other's devices is not
  // a mistake worth risking for the sake of a shorter query.
  const subscriptions = await PushSubscription.find({ userId, ownerType });
  if (!subscriptions.length) {
    console.warn(`[Push] notify(${ownerType}:${userId}): no push subscriptions — nothing to deliver`);
    return;
  }

  const pushPayload = JSON.stringify({ title, body, url, tag, icon, badge, requireInteraction });
  const sendOptions = HIGH_URGENCY_TYPES.has(type)
    ? { TTL: HIGH_URGENCY_TTL_SECONDS, urgency: 'high' }
    : undefined;
  console.log(`[Push] notify(${ownerType}:${userId}): pushing to ${subscriptions.length} subscription(s)`);

  await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          pushPayload,
          sendOptions,
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
