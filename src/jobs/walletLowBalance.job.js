import Wallet from "../models/Wallet.model.js";
import { notifyUser } from "../services/pushNotification.service.js";

// ₦1,600 — deliberately higher than a single LEAD_COST_KOBO (₦400) so a
// vendor gets warned with room to top up before search-eligibility (which
// gates on a single lead's cost) actually cuts them off. "For now" per the
// user — expect this to move.
export const LOW_BALANCE_KOBO = 160_000;

/**
 * Scans every active wallet for a low balance and notifies the vendor — a
 * periodic sweep rather than an on-debit check, so a vendor still gets
 * warned even if nothing happens to charge their wallet for a while (an
 * on-debit trigger only ever fires when a NEW lead lands, which says
 * nothing about balances that are already low and just sitting there).
 * "Once per low episode": a wallet already flagged is skipped until it
 * recovers back to/above the threshold, which resets the flag below.
 */
export async function checkLowWalletBalances() {
  // $lte, not $lt — a balance sitting exactly AT the threshold (found live:
  // a wallet parked at exactly ₦1,600 with the threshold also ₦1,600) must
  // still count as low. The recovery query below uses the complementary
  // $gt so the boundary value belongs to exactly one side, never both.
  const lowWallets = await Wallet.find({
    status: "active",
    balanceKobo: { $lte: LOW_BALANCE_KOBO },
    lowBalanceNotified: { $ne: true },
  }).select("vendorId balanceKobo");

  for (const wallet of lowWallets) {
    try {
      await notifyUser(wallet.vendorId, {
        type: "wallet",
        title: "Wallet balance running low",
        body: `Your Velte wallet balance is ₦${(wallet.balanceKobo / 100).toLocaleString("en-NG")} — top up to keep showing up in buyer searches.`,
        url: `/${wallet.vendorId}/wallet`,
        tag: "wallet-low-balance",
      });
      wallet.lowBalanceNotified = true;
      await wallet.save();
    } catch (err) {
      console.error(`[wallet-cron] low-balance notify failed for ${wallet.vendorId}:`, err.message);
    }
  }

  // Recovered wallets: clear the flag so the next dip below the threshold
  // notifies again instead of staying silenced forever.
  const { modifiedCount } = await Wallet.updateMany(
    { balanceKobo: { $gt: LOW_BALANCE_KOBO }, lowBalanceNotified: true },
    { $set: { lowBalanceNotified: false } },
  );

  if (lowWallets.length || modifiedCount) {
    console.log(
      `[wallet-cron] notified ${lowWallets.length} low wallet(s), cleared ${modifiedCount} recovered flag(s)`,
    );
  }
}
