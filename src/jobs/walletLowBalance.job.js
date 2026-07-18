import Wallet from "../models/Wallet.model.js";
import { notifyUser } from "../services/pushNotification.service.js";

// ₦1,000 — still higher than a single LEAD_COST_KOBO (₦400) so a vendor
// gets warned with room to top up before search-eligibility (which gates on
// a single lead's cost) actually cuts them off. "For now" per the user —
// expect this to move.
export const LOW_BALANCE_KOBO = 100_000;

// How often a vendor still under threshold gets reminded if they never
// topped up — the FIRST notification for a low episode always fires
// immediately (see the query below); this only paces the repeats.
const REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Scans every active wallet for a low balance and notifies the vendor — a
 * periodic sweep rather than an on-debit check, so a vendor still gets
 * warned even if nothing happens to charge their wallet for a while (an
 * on-debit trigger only ever fires when a NEW lead lands, which says
 * nothing about balances that are already low and just sitting there).
 * Reminds every REMINDER_INTERVAL_MS while still low, not just once per
 * episode — a vendor who misses/dismisses the first push otherwise never
 * hears about it again until they happen to check their wallet themselves.
 */
export async function checkLowWalletBalances() {
  const reminderCutoff = new Date(Date.now() - REMINDER_INTERVAL_MS);

  // $lte, not $lt — a balance sitting exactly AT the threshold (found live
  // at the old ₦1,600 threshold, same logic applies at ₦1,000) must still
  // count as low. The recovery query below uses the complementary
  // $gt so the boundary value belongs to exactly one side, never both.
  // The $or covers both "never notified this episode" (null — also matches
  // a doc predating this field) and "notified last, but that was a full
  // reminder interval ago or more".
  const lowWallets = await Wallet.find({
    status: "active",
    balanceKobo: { $lte: LOW_BALANCE_KOBO },
    $or: [
      { lowBalanceLastNotifiedAt: null },
      { lowBalanceLastNotifiedAt: { $lte: reminderCutoff } },
    ],
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
      wallet.lowBalanceLastNotifiedAt = new Date();
      await wallet.save();
    } catch (err) {
      console.error(`[wallet-cron] low-balance notify failed for ${wallet.vendorId}:`, err.message);
    }
  }

  // Recovered wallets: clear the timestamp so the next dip below the
  // threshold starts a brand new episode (immediate notification) instead
  // of inheriting whatever was left of the old reminder cadence.
  const { modifiedCount } = await Wallet.updateMany(
    {
      balanceKobo: { $gt: LOW_BALANCE_KOBO },
      lowBalanceLastNotifiedAt: { $ne: null },
    },
    { $set: { lowBalanceLastNotifiedAt: null } },
  );

  if (lowWallets.length || modifiedCount) {
    console.log(
      `[wallet-cron] notified ${lowWallets.length} low wallet(s), cleared ${modifiedCount} recovered flag(s)`,
    );
  }
}
