import Wallet from "../models/Wallet.model.js";
import { maybeAutoRecharge } from "../controllers/wallet/wallet.controller.js";

// A failed auto-recharge only ever gets a chance to retry via
// debitWalletForLead's own call to maybeAutoRecharge — which fires per
// lead, not on a schedule. A vendor whose leads dry up while their card is
// declining would otherwise never get retried (or notified again) at all.
// This periodic sweep is the "wake it up on a schedule" half of that —
// same "sweep, not just on-debit" reasoning as walletLowBalance.job.js.
//
// The actual 5h-retry / 20h-notify / 7-notification-cap policy all lives in
// maybeAutoRecharge itself (single source of truth, shared with the
// per-lead trigger) — this job just calls it for every wallet that MIGHT be
// due. The prefilter below is loose on purpose: maybeAutoRecharge's own
// atomic claim is the real, precise gate (retry-interval timing, the
// inFlight lock, balance-vs-threshold eligibility) — a wallet that isn't
// actually due yet just no-ops there. Cheap enough at this scale not to
// duplicate that precision here.
export async function retryFailedAutoRecharges() {
  const candidates = await Wallet.find({
    "autoRecharge.enabled": true,
    "autoRecharge.authorizationCode": { $ne: null },
    "autoRecharge.failureFirstAt": { $ne: null },
  }).select("_id");

  for (const wallet of candidates) {
    try {
      await maybeAutoRecharge(wallet);
    } catch (err) {
      console.error(
        `[auto-recharge-cron] retry failed for wallet ${wallet._id}:`,
        err.message,
      );
    }
  }
}
