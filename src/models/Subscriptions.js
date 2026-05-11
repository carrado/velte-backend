// src/models/Subscriptions.js
// One subscription document per user.
// Created at registration with a 2-day free trial (matching existing behaviour).

import mongoose from "mongoose";

const subscriptionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },

    // ── Trial ─────────────────────────────────────────────────────────────────
    trialEndsAt: {
      type: Date,
      default: () => new Date(Date.now() + 2 * 24 * 60 * 60 * 1000), // 2 days
    },

    // ── Subscription state ────────────────────────────────────────────────────
    isSubscribed: { type: Boolean, default: false },

    // Plan slug — extend as needed, e.g. "monthly", "annual"
    plan: {
      type: String,
      enum: ["monthly", "annual", null],
      default: null,
    },

    // ── Paystack fields ───────────────────────────────────────────────────────
    paystackCustomerCode: { type: String, default: null },
    paystackSubscriptionCode: { type: String, default: null },  // for managed subs
    paystackAuthorizationCode: { type: String, select: false }, // reusable charge auth
    paystackEmailToken: { type: String, select: false },        // for sub management

    // Current billing period
    currentPeriodStart: { type: Date, default: null },
    currentPeriodEnd: { type: Date, default: null },

    // Last verified Paystack reference — prevents double-processing
    lastPaystackReference: { type: String, default: null, select: false },

    // Cancellation
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        // Never leak payment tokens to clients
        delete ret.paystackAuthorizationCode;
        delete ret.paystackEmailToken;
        delete ret.lastPaystackReference;
        delete ret.__v;
        return ret;
      },
    },
  },
);

// ── Virtuals ──────────────────────────────────────────────────────────────────

subscriptionSchema.virtual("trialExpired").get(function () {
  if (!this.trialEndsAt) return true;
  return new Date() > this.trialEndsAt;
});

subscriptionSchema.virtual("isActive").get(function () {
  if (this.isSubscribed && this.currentPeriodEnd) {
    return new Date() < this.currentPeriodEnd;
  }
  // Still in trial
  if (!this.trialExpired) return true;
  return false;
});

subscriptionSchema.set("toJSON", { virtuals: true });

export default mongoose.model("Subscription", subscriptionSchema);