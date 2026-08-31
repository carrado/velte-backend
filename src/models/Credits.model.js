import mongoose from "mongoose";

// A buyer's credit balance (2026-08-31).
//
// Replaces the monthly `Usage` counters and the plan tiers behind them. The
// reason is behavioural: shopping is need-driven, not habit-driven, so a
// monthly allowance charges most users in months they never opened the app,
// and a monthly RESET hands free usage to people who were never going to
// convert. Credits are the airtime model — top up, spend down, see what's
// left — which is the one prepaid shape every Nigerian buyer already has a
// mental model for.
//
// KEYED ON (ownerId, ownerType) like Usage and PriceWatch before it, so a
// vendor and a buyer can both hold a balance without a second collection.
// Vendors spend from their LEAD WALLET rather than from here (see
// controllers/wallet) — this row exists for them only if they are also acting
// as a buyer with their own balance.
//
// NO PERIOD KEY, deliberately, and that is the whole design. There is nothing
// to roll over: a granted credit is spent or it isn't, and it never expires.
// Anything that looks like a monthly reset creeping back in here is the plan
// system returning by the back door.
const creditsSchema = new mongoose.Schema(
  {
    // Buyer._id or User._id. Not a `ref`: it points at two different
    // collections depending on ownerType, which one ref can't express.
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    ownerType: {
      type: String,
      enum: ["buyer", "vendor"],
      required: true,
    },

    /** Credits available to spend. Never negative — every debit is a
     *  conditional update filtered on `balance >= cost`, so the check and the
     *  write are one atomic document operation and two concurrent searches
     *  can't both spend the last credit. */
    balance: { type: Number, default: 0, min: 0 },

    /** Every grant ever applied, by CODE — `"signup"`, `"referral:<id>"`,
     *  `"topup:<paystack-reference>"`.
     *
     *  This is what makes granting idempotent, and it has to be: Paystack
     *  retries webhooks, a referral can fire twice under a race, and a buyer
     *  must never get two grants for one event. The code is the identity of
     *  the event, not of the grant, so a retry of the same event finds its own
     *  code already present and does nothing. */
    grants: { type: [String], default: [] },

    /** Lifetime totals, for support and for answering "what has this account
     *  actually cost us" without replaying a ledger we don't keep. */
    totalGranted: { type: Number, default: 0, min: 0 },
    totalSpent: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

// One row per owner, and the guarantee that two concurrent first-grants can
// never produce two balances racing each other.
creditsSchema.index({ ownerId: 1, ownerType: 1 }, { unique: true });

export default mongoose.model("Credits", creditsSchema);
