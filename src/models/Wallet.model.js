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

    // Set by the hourly low-balance cron (jobs/walletLowBalance.job.js) once
    // it notifies a vendor under the threshold — prevents renotifying every
    // run while they stay low. Reset back to false by the same job once the
    // balance rises back to/above the threshold, so the NEXT dip notifies
    // again ("once per low episode").
    lowBalanceNotified: { type: Boolean, default: false },
  },
  { timestamps: true },
);

export default mongoose.model("Wallet", walletSchema);
