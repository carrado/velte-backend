import mongoose from "mongoose";

// Buyer-facing counterpart to Notification.model.js (vendor). Deliberately a
// SEPARATE collection, not a shared one keyed by an actor type — mirrors the
// existing Buyer/User fork (see Buyer.model.js's own comment): buyer and
// vendor notifications have nothing structurally in common worth forcing
// into one schema, and this keeps buyer_auth_token-scoped queries from ever
// needing to filter by actor type.
//
// In-app ONLY, on purpose — no SMS (buyers used to get SMS for request
// responses via the now-retired buyerRequestNotifications cron; explicit
// product direction was to stop that), and no push (buyers have no
// PushSubscription/VAPID registration at all — that's vendor-only
// infrastructure, see pushNotification.service.js). A row in this
// collection IS the entire notification.
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
