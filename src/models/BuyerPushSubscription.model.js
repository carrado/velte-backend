import mongoose from "mongoose";

// Buyer-facing counterpart to PushSubscription.model.js (vendor) — a
// separate collection, not a shared one keyed by actor type, same fork as
// every other Buyer/User pair in this codebase (Buyer.model.js,
// BuyerNotification.model.js, BuyerSavedItem.model.js, ...).
const buyerPushSubscriptionSchema = new mongoose.Schema(
  {
    buyerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Buyer",
      required: true,
      index: true,
    },
    endpoint: {
      type: String,
      required: true,
      unique: true,
    },
    p256dh: {
      type: String,
      required: true,
    },
    auth: {
      type: String,
      required: true,
    },
    // Same failure-tracking/pruning fields as PushSubscription.model.js —
    // see that model's own comments for what each is for.
    failureCount: {
      type: Number,
      default: 0,
    },
    lastFailureAt: {
      type: Date,
    },
    lastSeenAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true },
);

export default mongoose.model(
  "BuyerPushSubscription",
  buyerPushSubscriptionSchema,
);
