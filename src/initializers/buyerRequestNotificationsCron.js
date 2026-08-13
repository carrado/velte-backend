import {
  processBuyerRequestResponseNotifications,
  BUYER_REQUEST_NOTIFICATION_INTERVAL_HOURS,
} from "../jobs/buyerRequestNotifications.job.js";

const CHECK_INTERVAL_MS = BUYER_REQUEST_NOTIFICATION_INTERVAL_HOURS * 60 * 60 * 1000;

export function startBuyerRequestNotificationsCron() {
  const run = () => {
    processBuyerRequestResponseNotifications().catch((err) =>
      console.error("[buyerRequestNotifications-cron] run failed:", err.message),
    );
  };

  // Run once immediately on boot too — same reasoning as
  // walletLowBalanceCron: a request that became eligible shortly before a
  // deploy/restart shouldn't wait up to a full interval more to be caught.
  run();
  const timer = setInterval(run, CHECK_INTERVAL_MS);
  timer.unref();

  console.log(
    `[buyerRequestNotifications-cron] batched response check every ${BUYER_REQUEST_NOTIFICATION_INTERVAL_HOURS}h`,
  );
}
