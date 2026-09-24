import BuyerRequest from "../models/BuyerRequest.model.js";
import BuyerRequestResponse from "../models/BuyerRequestResponse.model.js";
import { notifyUser } from "../services/pushNotification.service.js";
import { textMatchedVendors } from "../helpers/vendorRequestSms.js";

// The one real gap left in the Buyer Request quote loop (found 2026-09-14
// while checking the rest of the flow, which turned out to already be
// built — see docs/quote-loop status doc): a vendor gets exactly ONE push
// when a request is first matched to them (buyerRequests.controller.js's
// createRequest). Nothing nudges them again before the window closes if
// they haven't acted, so a request quietly dies unseen in a vendor's
// notification history rather than being genuinely declined.
//
// This sweep fires ONE reminder per request, at that request's own halfway
// point, to whichever matched vendors have neither accepted nor declined
// yet. Declined vendors are correctly excluded — they DID respond, with a
// no, and renudging them would be noise, not a fix for silence.
//
// Same setInterval idiom as every other sweep here (buyerRequestExpiry.job,
// buyerRequestNotifications.job) — this process is already assumed
// long-lived, so no scheduler dependency is needed.

/** How often the sweep ticks. Hourly, same granularity as the expiry sweep
 *  — being off by up to an hour on when a reminder fires is nothing against
 *  a 48h window, and a request's own reminderSentAt guard (not this
 *  interval) is what actually prevents a repeat. */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** A cap per sweep, same reasoning as buyerRequestNotifications.job's own
 *  BATCH: a backlog is drained over successive ticks, not one long pass. */
const BATCH = 50;

function preview(description) {
  const trimmed = description.trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
}

/**
 * Finds active requests past their own halfway point that haven't been
 * reminder-swept yet, and nudges whichever matched vendors have neither
 * accepted nor declined.
 *
 * Never throws. Marks reminderSentAt even when there is nothing to send
 * (every matched vendor already responded) or when every notifyUser call
 * fails — this is the best-effort push channel, not the confirmed-delivery
 * SMS/email one buyerRequestNotifications.job uses, so there is no
 * "retry until it lands" contract to honor here. Re-scanning a request
 * forever because one push failed would be worse than the odd missed nudge.
 */
export async function sendVendorReminders() {
  const now = new Date();

  const eligible = await BuyerRequest.find({
    status: "active",
    reminderSentAt: null,
    // Past the midpoint of ITS OWN window: createdAt + (expiresAt -
    // createdAt) / 2. Not a flat "24h after creation" — a request's window
    // is a stored fact, not always exactly BUYER_REQUEST_EXPIRY_HOURS, and
    // this must never drift from whatever RequestsPage.tsx is showing the
    // buyer as the same request's own progress bar.
    $expr: {
      $gte: [
        now,
        {
          $add: [
            "$createdAt",
            { $divide: [{ $subtract: ["$expiresAt", "$createdAt"] }, 2] },
          ],
        },
      ],
    },
  })
    .sort({ createdAt: 1 })
    .limit(BATCH);

  let remindedRequests = 0;
  let remindedVendors = 0;

  for (const request of eligible) {
    try {
      const responded = await BuyerRequestResponse.find({
        requestId: request._id,
      }).distinct("vendorId");
      const respondedSet = new Set(responded.map(String));

      const silent = request.matchedVendorIds.filter(
        (id) => !respondedSet.has(String(id)),
      );

      if (silent.length) {
        const body = `Still open: "${preview(request.description)}". Respond before it closes.`;
        const results = await Promise.allSettled(
          silent.map((vendorId) =>
            notifyUser(vendorId, {
              type: "buyer-request",
              title: "A buyer request is still waiting on you",
              body,
              url: `/${vendorId}/buyer-requests/${request._id}`,
              tag: "buyer-request",
            }),
          ),
        );
        remindedVendors += results.filter(
          (r) => r.status === "fulfilled",
        ).length;

        // SMS alongside the push — push is exactly the channel that misses
        // the vendors this reminder exists for. Same best-effort contract:
        // a failed text is logged, never retried, and never stops
        // reminderSentAt below from being set.
        await textMatchedVendors({
          request,
          vendorIds: silent,
          reminder: true,
        }).catch((err) => {
          console.error(
            `[buyerRequestVendorReminder] SMS failed for request ${request._id}:`,
            err?.message ?? err,
          );
        });
      }

      request.reminderSentAt = now;
      await request.save();
      remindedRequests += 1;
    } catch (err) {
      // One bad request must not stop the batch — same shape as every other
      // sweep's per-item try/catch here.
      console.error(
        `[buyerRequestVendorReminder] request ${request._id} failed:`,
        err?.message ?? err,
      );
    }
  }

  if (remindedRequests) {
    console.log(
      `[buyerRequestVendorReminder] swept ${remindedRequests} request(s), nudged ${remindedVendors} vendor(s)`,
    );
  }
  return remindedRequests;
}

export function startBuyerRequestVendorReminderCron() {
  const run = () => {
    sendVendorReminders().catch((err) =>
      console.error(
        "[buyerRequestVendorReminder] sweep failed:",
        err?.message ?? err,
      ),
    );
  };

  // No immediate run on boot — same reasoning as
  // buyerRequestNotifications.job's own cron: a redeploy should not fire a
  // wave of reminders at every eligible request at once just because the
  // process restarted near a sweep boundary.
  const timer = setInterval(run, CHECK_INTERVAL_MS);
  timer.unref();

  console.log(
    `[buyerRequestVendorReminder] reminder sweep every ${CHECK_INTERVAL_MS / 60000} min`,
  );
}
