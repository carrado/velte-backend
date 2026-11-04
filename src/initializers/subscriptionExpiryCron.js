import { checkSubscriptionExpiries } from "../jobs/subscriptionExpiry.job.js";

// Checks subscription expiries every hour. Runs once immediately on boot.
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export function startSubscriptionExpiryCron() {
  const run = () => {
    checkSubscriptionExpiries().catch((err) =>
      console.error("[sub-expiry-cron] check failed:", err.message),
    );
  };

  run();
  const timer = setInterval(run, CHECK_INTERVAL_MS);
  timer.unref();

  console.log(
    `[sub-expiry-cron] subscription expiry check every ${CHECK_INTERVAL_MS / 60000} min`,
  );
}

