import mongoose from "mongoose";

// One wallet per vendor. Prepaid balance decremented per lead (Velte Connect
// monetization — see docs/velte-connect-teardown-plan.md Bucket D). Funding:
// card tokenization for auto-recharge (default) + Dedicated Virtual Account
// (bank transfer) as a fallback for card-averse vendors.
const walletSchema = new mongoose.Schema(
  {
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    balanceKobo: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: "NGN" },

    // Atomic gate for the one-time starter credit — flipped via a single
    // findOneAndUpdate so concurrent requests (getWallet + getTransactions
    // firing together on first page load) can't both win the grant.
    starterCreditGranted: { type: Boolean, default: false },

    // Paystack customer — required before a DVA can be issued, and useful for
    // charge_authorization calls too.
    paystackCustomerCode: { type: String, default: null },

    autoRecharge: {
      enabled: { type: Boolean, default: false },
      // Vendor saved funding preferences before having a card on file — flip
      // `enabled` on automatically when the first card top-up captures a
      // reusable authorization.
      pendingEnable: { type: Boolean, default: false },
      // Recharge when balance drops below this threshold.
      thresholdKobo: { type: Number, default: 0, min: 0 },
      // Amount to top up by when auto-recharge fires.
      topupKobo: { type: Number, default: 0, min: 0 },
      // Reusable authorization from the vendor's first successful card top-up.
      // Never charged per-lead — only used to batch top-ups (see spec §11).
      authorizationCode: { type: String, default: null },
      last4: { type: String, default: null },
      cardType: { type: String, default: null },

      // Atomic claim guard against a concurrent double-charge: two leads
      // landing close together for the same vendor could otherwise each
      // independently see "balance below threshold" and each fire a
      // separate charge_authorization call. Claimed via findOneAndUpdate
      // right before charging (wallet.controller.js's maybeAutoRecharge),
      // released in a finally right after — same atomic-flag pattern as
      // starterCreditGranted/lowBalanceLastNotifiedAt above.
      inFlight: { type: Boolean, default: false },

      // Failure-episode tracking for maybeAutoRecharge's retry/notify policy
      // (see the constants above that function in wallet.controller.js).
      // All four reset to their defaults the moment the episode ends —
      // either a charge succeeds, or the balance recovers above threshold
      // via any other credit (manual top-up, DVA transfer, referral bonus;
      // see clearAutoRechargeFailureIfRecovered).
      failureFirstAt: { type: Date, default: null },
      failureLastAttemptAt: { type: Date, default: null },
      failureNotifyCount: { type: Number, default: 0 },
      lastFailureNotifiedAt: { type: Date, default: null },
    },

    dva: {
      accountNumber: { type: String, default: null },
      bankName: { type: String, default: null },
      accountName: { type: String, default: null },
    },

    status: {
      type: String,
      enum: ["active", "suspended"],
      default: "active",
    },

    // Set by the low-balance cron (jobs/walletLowBalance.job.js) to the time
    // of the last low-balance push — the first notification for a low
    // episode fires immediately, then this timestamp gates a repeat
    // reminder to once every REMINDER_INTERVAL_MS (24h) while the vendor
    // stays under threshold without topping up, instead of either spamming
    // every cron tick or (the old behavior) notifying only once ever per
    // episode. Reset back to null by the same job once the balance rises
    // back above the threshold, so a NEW dip later starts a fresh episode
    // (immediate notification, not waiting out the old reminder cadence).
    lowBalanceLastNotifiedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export default mongoose.model("Wallet", walletSchema);
