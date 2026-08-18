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
    // Snapshotted straight onto the request at creation time (2026-08-18),
    // not read live off the Buyer doc — Buyer.model.js no longer carries a
    // name at all (buyers stay anonymous otherwise; see its own comment),
    // so this is the ONLY place a buyer's name ever lives, scoped to this
    // one request. The AI collects it conversationally before calling
    // createBuyerRequest (see createBuyerRequestTool.ts / systemPrompt.ts).
    buyerName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    // Also snapshotted rather than populated via buyerId — this is the
    // number a vendor WhatsApps directly once they Accept (see
    // vendorBuyerRequests.controller.js's decideOnRequest). Never sent to
    // the client until that vendor has actually accepted and paid for the
    // lead — see getRequestDetail/listMatchedRequests, which strip it out
    // until then.
    buyerPhone: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
      maxlength: 1000,
    },
    // Frontend uploads directly to Cloudinary and sends only the resulting
    // URL — no backend upload endpoint exists or is needed.
    imageUrl: {
      type: String,
      default: null,
    },
    // Same GeoJSON Point shape as User.geo, for consistency with the
    // matching service's existing distance calculations. Only ever set from
    // the buyer's own device location, granted for THIS request — no
    // fallback to any saved/remembered location (there isn't one to fall
    // back to; buyers don't have accounts). Absent entirely means the buyer
    // didn't grant location this time — the vendor-facing detail page shows
    // "N/A" rather than guessing.
    location: {
      type: { type: String, enum: ["Point"] },
      coordinates: { type: [Number], default: undefined }, // [lng, lat]
    },

    status: {
      type: String,
      enum: ["active", "fulfilled", "expired", "cancelled"],
      default: "active",
      index: true,
    },

    // Populated once at creation from the staffly-ai-backend matching call
    // (see services/matchingClient.service.js) — NOT re-run on every read.
    // Retroactive matching (a new/edited vendor matching an existing active
    // request later) is a documented V2 follow-up, not built here.
    matchedVendorIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
      default: [],
    },

    responseCount: { type: Number, default: 0, min: 0 },
    lastResponseAt: { type: Date, default: null },

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
