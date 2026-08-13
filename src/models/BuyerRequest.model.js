import mongoose from "mongoose";

// Default request lifetime — per docs/velte_buyer_requests_mvp_spec.md §11.
// A named constant, not a magic 48 sprinkled across files (the spec's own
// instruction), consumed by both request creation and the expiry cron.
export const BUYER_REQUEST_EXPIRY_HOURS = 48;

const buyerRequestSchema = new mongoose.Schema(
  {
    buyerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Buyer",
      required: true,
      index: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
      maxlength: 1000,
    },
    // Frontend uploads directly to Cloudinary and sends only the resulting
    // URL — no backend upload endpoint exists or is needed (confirmed absent
    // in both repos during Phase 1 inspection; see spec §7's own note).
    imageUrl: {
      type: String,
      default: null,
    },
    // Same GeoJSON Point shape as Buyer.location/User.geo, for consistency
    // with the matching service's existing distance calculations.
    location: {
      type: { type: String, enum: ["Point"] },
      coordinates: { type: [Number], default: undefined }, // [lng, lat]
    },
    area: { type: String, default: null },
    state: { type: String, default: null },

    status: {
      type: String,
      enum: ["active", "fulfilled", "expired", "cancelled"],
      default: "active",
      index: true,
    },

    // Populated once at creation from the staffly-ai-backend matching call
    // (see services/matchingClient.service.js) — NOT re-run on every read.
    // Retroactive matching (a new/edited vendor matching an existing active
    // request later) is a documented V2 follow-up, not built here; see
    // spec §62.3.
    matchedVendorIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
      default: [],
    },

    responseCount: { type: Number, default: 0, min: 0 },
    lastResponseAt: { type: Date, default: null },

    // Orphaned — used to back jobs/buyerRequestNotifications.job.js's
    // batched-SMS bookkeeping (comparing responseCount against this to send
    // only one summary SMS per batch, spec §30-33). That job is retired:
    // the buyer now gets an in-app notification immediately, per response
    // (see vendorBuyerRequests.controller.js's respondToRequest), no
    // batching needed since it isn't billed per-message like SMS was.
    // Left in the schema rather than migrated out — harmless, unread.
    lastBuyerNotificationAt: { type: Date, default: null },
    lastBuyerNotifiedResponseCount: { type: Number, default: 0, min: 0 },

    expiresAt: {
      type: Date,
      required: true,
      default: () =>
        new Date(Date.now() + BUYER_REQUEST_EXPIRY_HOURS * 60 * 60 * 1000),
      index: true,
    },
  },
  { timestamps: true },
);

buyerRequestSchema.index({ location: "2dsphere" });
buyerRequestSchema.index({ buyerId: 1, status: 1, createdAt: -1 });
buyerRequestSchema.index({ matchedVendorIds: 1, status: 1 });

export default mongoose.model("BuyerRequest", buyerRequestSchema);
