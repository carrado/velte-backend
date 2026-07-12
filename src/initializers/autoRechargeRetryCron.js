import { retryFailedAutoRecharges } from "../jobs/autoRechargeRetry.job.js";

// Plain setInterval, same reasoning as walletLowBalanceCron.js: the process
// is already long-lived (keepAlive.js), so no cron library or external
// scheduler. 15 minutes is fine-grained enough to keep the 5-hour retry /
// 20-hour notify cadence (both defined in wallet.controller.js's
// maybeAutoRecharge) reasonably tight without adding one. Runs once on boot
// too, so a failure episode already in progress before a deploy/restart
// doesn't sit waiting a full interval before its next retry.
const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

export function startAutoRechargeRetryCron() {
  const run = () => {
    retryFailedAutoRecharges().catch((err) =>
      console.error("[auto-recharge-cron] sweep failed:", err.message),
    );
  };

  run();
  const timer = setInterval(run, CHECK_INTERVAL_MS);
  timer.unref();

  console.log(
    `[auto-recharge-cron] failed-recharge retry sweep every ${CHECK_INTERVAL_MS / 60000} min`,
  );
}
