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
// KEYED ON (ownerId, ownerType) like Usage before it, so a vendor and a
// buyer can both hold a balance without a second collection.
// Vendors spend from their LEAD WALLET rather than from here (see
// controllers/wallet) — this row exists for them only if they are also acting
// as a buyer with their own balance.
//
// `balance` has no period and never expires: a credit that was bought or
// granted is spent or it isn't. The free allowance (2026-10-15, Phase 0.3 of
// the platform plan) is a SEPARATE bucket in `allowance` below. It resets and
// is never added to `balance`, so a reset can never take away a credit
// someone paid for.
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
     *  actually cost us" without replaying a ledger we don't keep. NEVER
     *  reset — see spentSinceTopUp below for the figure that resets. */
    totalGranted: { type: Number, default: 0, min: 0 },
    totalSpent: { type: Number, default: 0, min: 0 },

    /** The credit meter's OWN "used" half (2026-09-09) — deliberately a
     *  separate figure from totalSpent above, which stays lifetime. Reset
     *  to 0 by grantCredits on every TOP-UP (never on a referral/signup/
     *  catalog grant — see that function's own comment), because the whole
     *  product is modeled on airtime: the meter should read usage against
     *  the bundle just bought, not a running total since the account began.
     *  Found live: a buyer topping up Y credits on top of X remaining saw
     *  the meter immediately show most of X+Y as already "used", because it
     *  was reading totalSpent — every credit ever spent, forever. */
    spentSinceTopUp: { type: Number, default: 0, min: 0 },

    /** The free allowance's current period (config/entitlements.js
     *  ALLOWANCES). `used` counts only when `periodStart` is inside the
     *  current period; an older period reads as untouched, so nothing has
     *  to run at midnight to reset anyone. */
    allowance: {
      periodStart: { type: Date, default: null },
      used: { type: Number, default: 0, min: 0 },
    },

    /** Lifetime free credits spent: what the allowance has cost us. */
    totalFreeSpent: { type: Number, default: 0, min: 0 },

    /** How the most recent charge was split across the two buckets, so a
     *  refund puts credits back where they came from. Refunding a free
     *  charge into `balance` would turn free credits into purchased ones. */
    lastCharge: {
      fromAllowance: { type: Number, default: 0 },
      fromBalance: { type: Number, default: 0 },
      at: { type: Date, default: null },
    },
  },
  { timestamps: true },
);

// One row per owner, and the guarantee that two concurrent first-grants can
// never produce two balances racing each other.
creditsSchema.index({ ownerId: 1, ownerType: 1 }, { unique: true });

export default mongoose.model("Credits", creditsSchema);
