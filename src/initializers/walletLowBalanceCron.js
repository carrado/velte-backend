import { checkLowWalletBalances } from "../jobs/walletLowBalance.job.js";

// Plain setInterval, not a cron library — this process is already assumed
// long-lived (see keepAlive.js), and an hourly in-process tick needs no new
// dependency or external scheduler infra. Runs once immediately on boot too,
// so a vendor already under the threshold isn't left waiting up to an hour
// after every deploy/restart before hearing about it.
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export function startWalletLowBalanceCron() {
  const run = () => {
    checkLowWalletBalances().catch((err) =>
      console.error("[wallet-cron] check failed:", err.message),
    );
  };

  run();
  const timer = setInterval(run, CHECK_INTERVAL_MS);
  timer.unref();

  console.log(
    `[wallet-cron] low-balance check every ${CHECK_INTERVAL_MS / 60000} min`,
  );
}
