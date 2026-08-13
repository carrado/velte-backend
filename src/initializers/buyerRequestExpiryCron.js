import { expireBuyerRequests } from "../jobs/buyerRequestExpiry.job.js";

// Hourly is plenty of granularity for a 48h expiry window.
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

export function startBuyerRequestExpiryCron() {
  const run = () => {
    expireBuyerRequests().catch((err) =>
      console.error("[buyerRequestExpiry-cron] run failed:", err.message),
    );
  };

  run();
  const timer = setInterval(run, CHECK_INTERVAL_MS);
  timer.unref();

  console.log(
    `[buyerRequestExpiry-cron] expiry sweep every ${CHECK_INTERVAL_MS / 60000} min`,
  );
}
