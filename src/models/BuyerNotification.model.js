import mongoose from "mongoose";

// Buyer-facing counterpart to Notification.model.js (vendor). Deliberately a
// SEPARATE collection, not a shared one keyed by an actor type — mirrors the
// existing Buyer/User fork (see Buyer.model.js's own comment): buyer and
// vendor notifications have nothing structurally in common worth forcing
// into one schema, and this keeps buyer_auth_token-scoped queries from ever
// needing to filter by actor type.
//
// A row in this collection IS the in-app notification — but as of
// 2026-08-14 it's no longer the ONLY channel: buyerNotification.service.js's
// notifyBuyer also sends push (BuyerPushSubscription) always, and real SMS
// (via sendchamp.service.js) for the narrow set of urgent types in that
// file's own SMS_TYPES (currently just "request-response"). This schema
// doesn't track which channels actually fired for a given row — it's the
// durable in-app record regardless of what else went out alongside it.
const buyerNotificationSchema = new mongoose.Schema(
  {
    buyerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Buyer",
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
    },
    body: {
      type: String,
      required: true,
    },
    type: {
      type: String,
      enum: [
        "request-response", // a vendor responded to one of the buyer's own requests
        "saved-price-change", // a saved product's price changed
        "followed-new-listing", // a followed vendor posted a new product/service
        "followed-store-update", // a followed vendor edited their store profile
        "system",
      ],
      default: "system",
    },
    url: {
      type: String,
      default: null,
    },
    isRead: {
      type: Boolean,
      default: false,
    },
    // Free-form context (e.g. { vendorId } on followed-* types) — lets a
    // trigger look up "was this vendor's follower base already notified
    // recently" (see store-update's own debounce) without a dedicated
    // lookup table.
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  { timestamps: true },
);

buyerNotificationSchema.index({ buyerId: 1, createdAt: -1 });
buyerNotificationSchema.index({ buyerId: 1, isRead: 1 });

export default mongoose.model("BuyerNotification", buyerNotificationSchema);
