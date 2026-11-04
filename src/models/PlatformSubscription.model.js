import mongoose from "mongoose";

// A paid tier (Phase 0.2 of the platform plan) — Buyer Premium or Vendor
// Enterprise. Keyed on (ownerId, ownerType) like Credits, because a buyer and
// a vendor are different collections.
//
// The ABSENCE of a row is the free tier: nothing is written for Basic.
// services/tier.service.js is the only reader that turns this into a tier.
//
// Named PlatformSubscription, not Subscription, so it can never share a
// collection with the `subscriptions` documents the retired vendor-trial
// model left behind in the database.
//
// Prices live in config/prices.js (Q1/Q2). Checkout and the Paystack
// webhook branches arrive with Phase 2. Q3: the Enterprise trial takes a
// card but doesn't charge it, and a trial that lapses falls back to Basic,
// never to a charge.
const subscriptionSchema = new mongoose.Schema(
  {
    ownerId: { type: mongoose.Schema.Types.ObjectId, required: true },
    ownerType: { type: String, enum: ["buyer", "vendor"], required: true },

    plan: {
      type: String,
      enum: ["buyer_premium", "vendor_enterprise"],
      required: true,
    },
    interval: { type: String, enum: ["monthly", "annual"], default: "monthly" },

    status: {
      type: String,
      enum: ["trialing", "active", "past_due", "cancelled", "expired"],
      required: true,
    },
    trialEndsAt: { type: Date, default: null },
    /** Paid (or trial) access runs until this instant. A cancelled
     *  subscription keeps its tier until then. */
    currentPeriodEnd: { type: Date, required: true },

    paystackCustomerCode: { type: String, default: null },
    paystackSubscriptionCode: { type: String, default: null },
    /** Q3: an authorisation is captured at trial start without charging. */
    paystackAuthorizationCode: { type: String, default: null, select: false },
    /** Paystack reference of the charge that last activated this row.
     *  A webhook retry with the same reference does not extend the period. */
    lastChargeReference: { type: String, default: null },
    reminded7DaysForEnd: { type: Date, default: null },
    reminded3DaysForEnd: { type: Date, default: null },
  },
  { timestamps: true },
);

subscriptionSchema.index({ ownerId: 1, ownerType: 1 }, { unique: true });

export default mongoose.model("PlatformSubscription", subscriptionSchema);
