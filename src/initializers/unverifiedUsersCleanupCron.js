import { cleanupUnverifiedUsers } from "../jobs/unverifiedUsersCleanup.job.js";

// Plain setInterval, same reasoning as walletLowBalanceCron.js: the process
// is already long-lived (keepAlive.js), so no cron library or external
// scheduler. Daily is plenty — the job's 7-day cutoff means timing precision
// buys nothing. Runs once on boot too, so a backlog never waits a day after
// a deploy/restart.
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function startUnverifiedUsersCleanupCron() {
  const run = () => {
    cleanupUnverifiedUsers().catch((err) =>
      console.error("[signup-cleanup] sweep failed:", err.message),
    );
  };

  run();
  const timer = setInterval(run, CLEANUP_INTERVAL_MS);
  timer.unref();

  console.log(
    `[signup-cleanup] unverified-account sweep every ${CLEANUP_INTERVAL_MS / 3600000} h`,
  );
}
