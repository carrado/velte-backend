// src/models/Subscriptions.js
// One subscription document per user.
// Created automatically at registration with a 14-day free trial.

import mongoose from "mongoose";

// ── Transaction Schema ────────────────────────────────────────────────────────

const transactionSchema = new mongoose.Schema(
  {
    amount: {
      type: Number,
      required: true,
    },

    reference: {
      type: String,
      required: true,
      trim: true,
    },

    status: {
      type: String,
      enum: ["success", "failed", "pending"],
      default: "pending",
    },

    paidAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    _id: true,
    timestamps: false,
  },
);

// ── Main Subscription Schema ─────────────────────────────────────────────────

const subscriptionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },

    // ── Trial ────────────────────────────────────────────────────────────────

    trialEndsAt: {
      type: Date,
      default: () => new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    },

    // ── Subscription State ───────────────────────────────────────────────────

    isSubscribed: {
      type: Boolean,
      default: false,
    },

    // Extendable for future plans
    plan: {
      type: String,
      enum: ["monthly", "annual", null],
      default: null,
    },

    // ── Paystack Fields ──────────────────────────────────────────────────────

    paystackCustomerCode: {
      type: String,
      default: null,
    },

    // For managed subscriptions
    paystackSubscriptionCode: {
      type: String,
      default: null,
    },

    // Reusable charge authorization
    paystackAuthorizationCode: {
      type: String,
      select: false,
      default: null,
    },

    // Used for Paystack subscription management
    paystackEmailToken: {
      type: String,
      select: false,
      default: null,
    },

    // ── Billing Period ───────────────────────────────────────────────────────

    currentPeriodStart: {
      type: Date,
      default: null,
    },

    currentPeriodEnd: {
      type: Date,
      default: null,
    },

    // ── Transaction History ──────────────────────────────────────────────────

    transactions: {
      type: [transactionSchema],
      default: [],
    },

    // Prevent duplicate webhook/payment processing
    lastPaystackReference: {
      type: String,
      default: null,
      select: false,
    },

    // ── Cancellation ─────────────────────────────────────────────────────────

    cancelledAt: {
      type: Date,
      default: null,
    },

    cancelReason: {
      type: String,
      default: null,
      trim: true,
    },
  },
  {
    timestamps: true,

    toJSON: {
      virtuals: true,

      transform(_doc, ret) {
        // Never expose sensitive payment tokens
        delete ret.paystackAuthorizationCode;
        delete ret.paystackEmailToken;
        delete ret.lastPaystackReference;
        delete ret.__v;

        return ret;
      },
    },

    toObject: {
      virtuals: true,
    },
  },
);

// ── Virtuals ─────────────────────────────────────────────────────────────────

// Whether free trial has expired
subscriptionSchema.virtual("trialExpired").get(function () {
  if (!this.trialEndsAt) return true;

  return new Date() > this.trialEndsAt;
});

// Whether subscription or trial is currently active
subscriptionSchema.virtual("isActive").get(function () {
  // Paid subscription active
  if (this.isSubscribed && this.currentPeriodEnd) {
    return new Date() < this.currentPeriodEnd;
  }

  // Still inside free trial
  if (!this.trialExpired) {
    return true;
  }

  return false;
});

// Remaining trial days
subscriptionSchema.virtual("trialDaysRemaining").get(function () {
  if (!this.trialEndsAt) return 0;

  const diff = this.trialEndsAt.getTime() - Date.now();

  if (diff <= 0) return 0;

  return Math.ceil(diff / (1000 * 60 * 60 * 24));
});

// ── Indexes ──────────────────────────────────────────────────────────────────

subscriptionSchema.index({ "transactions.reference": 1 });

// ── Export ───────────────────────────────────────────────────────────────────

export default mongoose.model("Subscription", subscriptionSchema);