import mongoose from "mongoose";

// A vendor broadcast to buyers (docs/vendor-delivery-and-hub.md + platform
// plan Phase 4).
//
// Reach is OPTED-IN buyers only (Buyer.notificationPrefs.promoEnabled) —
// never "every user", whatever the tier. A frequency cap applies per tier
// (HUB_BROADCAST_CAP_BASIC/ENTERPRISE_PER_24H: 1 and 5 sends a day, decided
// 2026-10-15). Every send costs HUB_BROADCAST_COST_KOBO (₦1,000) from the
// wallet on BOTH tiers — the Enterprise subscription covers pins, not pushes.
// What Enterprise gets over Basic is the higher cap plus audience
// segmentation and campaign analytics — not a louder free megaphone.
//
// This slice records drafts and their audit trail. The send endpoint and the
// push fan-out land with the notification-preferences UI — buyers need a way
// to opt in first, otherwise the audience is honest but tiny, and marking
// anything "sent" before a delivery path exists would be a lie.
const hubBroadcastSchema = new mongoose.Schema(
  {
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    message: { type: String, required: true, trim: true, maxlength: 280 },
    imageUrl: { type: String, default: null },
    /** Boost path: the broadcast tied to a HubAdvert. null = standalone. */
    advertId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HubAdvert",
      default: null,
    },

    status: {
      type: String,
      enum: ["draft", "queued", "sent", "cancelled"],
      default: "draft",
      index: true,
    },

    // Snapshot at send time — the audience that existed, not a live query.
    audienceCount: { type: Number, default: null },
    costKobo: { type: Number, default: null },
    enterpriseFree: { type: Boolean, default: false },
    sentAt: { type: Date, default: null },
  },
  { timestamps: true },
);

hubBroadcastSchema.index({ vendorId: 1, status: 1 });

export default mongoose.model("HubBroadcast", hubBroadcastSchema);
