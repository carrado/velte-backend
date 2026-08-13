import mongoose from "mongoose";

// A buyer's saved products and followed vendors — one model for both (kind
// discriminates), not two parallel collections. "Follow a vendor" and "save
// a vendor" are the same action today (see buyerSaved.controller.js's own
// comment) — they only diverge once vendor-change alerts exist, at which
// point this is still the right row to hang that trigger off of.
const buyerSavedItemSchema = new mongoose.Schema(
  {
    buyerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Buyer",
      required: true,
      index: true,
    },
    kind: {
      type: String,
      enum: ["product", "vendor"],
      required: true,
    },
    // Product._id when kind === "product", vendor's User._id when
    // kind === "vendor" — polymorphic on purpose (mirrors how the rest of
    // the buyer-facing surfaces already key off a bare vendorId without a
    // dedicated Vendor collection to point a ref at).
    targetId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
  },
  { timestamps: true },
);

// One buyer can't save the same product/vendor twice — also what makes
// toggleSaved's "already exists -> delete" check race-safe under a
// double-tap (the loser of the race hits E11000, not a silent duplicate).
buyerSavedItemSchema.index(
  { buyerId: 1, kind: 1, targetId: 1 },
  { unique: true },
);
buyerSavedItemSchema.index({ buyerId: 1, createdAt: -1 });

export default mongoose.model("BuyerSavedItem", buyerSavedItemSchema);
