import PlatformSubscription from "../models/PlatformSubscription.model.js";
import User from "../models/Users.js";
import Buyer from "../models/Buyer.model.js";
import { notifyOwner } from "../services/pushNotification.service.js";
import { sendSms } from "../services/sendchamp.service.js";
import { sendSubscriptionExpiryEmail } from "../helpers/emailSender.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const THREE_DAYS_MS = 3 * DAY_MS;
const SEVEN_DAYS_MS = 7 * DAY_MS;

/**
 * Sweeps active/trialing subscriptions and dispatches reminders when a subscription
 * is 1 week (7 days) or 3 days away from expiry.
 * 
 * Supports both monthly and annual plans for both buyers and vendors.
 * Channels:
 *  1. In-app notification (bell + web push)
 *  2. Email notification (HTML branded)
 *  3. SMS notification (via Sendchamp)
 */
export async function checkSubscriptionExpiries() {
  const now = new Date();
  const clientUrl = (process.env.CLIENT_URL || process.env.FRONTEND_URL || "https://velte.ng").replace(/\/+$/, "");

  // Find all active or trialing subscriptions ending in the next 7 days
  const upcomingSubscriptions = await PlatformSubscription.find({
    status: { $in: ["active", "trialing"] },
    currentPeriodEnd: {
      $gt: now,
      $lte: new Date(now.getTime() + SEVEN_DAYS_MS + 2 * 60 * 60 * 1000), // small buffer
    },
  });

  if (!upcomingSubscriptions.length) return;

  for (const sub of upcomingSubscriptions) {
    try {
      const endMs = new Date(sub.currentPeriodEnd).getTime();
      const diffMs = endMs - now.getTime();
      if (diffMs <= 0) continue;

      let triggerWindow = null; // 7 or 3

      const alreadyReminded3Days =
        sub.reminded3DaysForEnd &&
        new Date(sub.reminded3DaysForEnd).getTime() === endMs;

      const alreadyReminded7Days =
        sub.reminded7DaysForEnd &&
        new Date(sub.reminded7DaysForEnd).getTime() === endMs;

      if (diffMs <= THREE_DAYS_MS) {
        if (!alreadyReminded3Days) {
          triggerWindow = 3;
        }
      } else if (diffMs <= SEVEN_DAYS_MS) {
        if (!alreadyReminded7Days) {
          triggerWindow = 7;
        }
      }

      if (!triggerWindow) continue;

      // Resolve actor identity
      let name = "";
      let email = null;
      let phone = null;
      let planFullName = "";
      let renewUrl = "";

      if (sub.ownerType === "vendor") {
        const vendor = await User.findById(sub.ownerId).select("name email phone company").lean();
        if (!vendor) continue;
        name = vendor.company?.name || vendor.name || "Vendor";
        email = vendor.email || null;
        phone = vendor.phone || null;
        planFullName = "Vendor Enterprise";
        renewUrl = `${clientUrl}/pricing?for=vendors`;
      } else {
        const buyer = await Buyer.findById(sub.ownerId).select("name email phone").lean();
        if (!buyer) continue;
        name = buyer.name || "Velte Shopper";
        email = buyer.email || null;
        phone = buyer.phone || null;
        planFullName = "Buyer Premium";
        renewUrl = `${clientUrl}/pricing?for=buyers`;
      }

      const isAnnual = sub.interval === "annual";
      const intervalLabel = isAnnual ? "Annual" : "Monthly";
      const planDisplay = `${planFullName} (${intervalLabel})`;
      const daysText = triggerWindow === 7 ? "1 week (7 days)" : "3 days";
      const formattedExpiry = new Date(sub.currentPeriodEnd).toLocaleDateString("en-NG", {
        weekday: "short",
        year: "numeric",
        month: "short",
        day: "numeric",
      });

      // 1. In-App Notification
      try {
        await notifyOwner(
          { ownerId: sub.ownerId, ownerType: sub.ownerType },
          {
            title: triggerWindow === 7
              ? `Your Velte ${planDisplay} expires in 1 week`
              : `Urgent: Your Velte ${planDisplay} expires in 3 days`,
            body: triggerWindow === 7
              ? `Your ${intervalLabel.toLowerCase()} subscription will expire on ${formattedExpiry}. Renew now to keep your benefits active.`
              : `Only 3 days remaining before your ${intervalLabel.toLowerCase()} subscription expires on ${formattedExpiry}. Renew now to avoid losing access.`,
            url: sub.ownerType === "vendor" ? "/pricing?for=vendors" : "/pricing?for=buyers",
            type: "payment",
            tag: `sub-expiry-${sub._id}-${triggerWindow}d`,
            metadata: {
              subscriptionId: String(sub._id),
              plan: sub.plan,
              interval: sub.interval,
              currentPeriodEnd: sub.currentPeriodEnd,
              daysRemaining: triggerWindow,
            },
          }
        );
      } catch (inAppErr) {
        console.error(`[sub-expiry] In-app notification error (${sub._id}):`, inAppErr.message);
      }

      // 2. Email Notification
      if (email) {
        try {
          await sendSubscriptionExpiryEmail({
            to: email,
            name,
            planName: planFullName,
            intervalLabel,
            daysRemaining: daysText,
            expiryDate: formattedExpiry,
            renewUrl,
          });
        } catch (emailErr) {
          console.error(`[sub-expiry] Email error for ${email}:`, emailErr.message);
        }
      }

      // 3. SMS Notification
      if (phone) {
        try {
          const smsMsg = triggerWindow === 7
            ? `Velte Alert: Your ${planDisplay} subscription expires in 1 week on ${formattedExpiry}. Renew at ${renewUrl} to keep your benefits active.`
            : `Velte Alert: Urgent - your ${planDisplay} subscription expires in 3 days on ${formattedExpiry}. Renew at ${renewUrl} to avoid interruption.`;
          await sendSms(phone, smsMsg);
          console.log(`✅ Subscription expiry SMS sent to ${phone} (${triggerWindow}d)`);
        } catch (smsErr) {
          console.error(`[sub-expiry] SMS error for ${phone}:`, smsErr.message);
        }
      }

      // Update subscription record to mark reminder sent for this period
      const updateFields = {};
      if (triggerWindow === 3) {
        updateFields.reminded3DaysForEnd = sub.currentPeriodEnd;
        updateFields.reminded7DaysForEnd = sub.currentPeriodEnd; // also cover 7-day mark
      } else if (triggerWindow === 7) {
        updateFields.reminded7DaysForEnd = sub.currentPeriodEnd;
      }

      await PlatformSubscription.findByIdAndUpdate(sub._id, { $set: updateFields });
      console.log(`[sub-expiry] Notified ${sub.ownerType} ${sub.ownerId} of ${triggerWindow}-day expiry (${planDisplay})`);
    } catch (itemErr) {
      console.error(`[sub-expiry] Error processing subscription ${sub._id}:`, itemErr.message);
    }
  }
}

