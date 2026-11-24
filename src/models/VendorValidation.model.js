import mongoose from "mongoose";

// A Premium buyer's vendor validation & storefront audit proof.
const schema = new mongoose.Schema(
  {
    buyerId: { type: mongoose.Schema.Types.ObjectId, ref: "Buyer", required: true },
    vendorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    // Core proof-of-work fields
    photos: { type: [String], default: [] }, // Storefront & stock photo proofs
    geo: {
      type: { type: String, enum: ["Point"] },
      coordinates: { type: [Number], default: undefined }, // [lng, lat]
    },
    accuracyMeters: { type: Number, default: null },
    storeStatus: {
      type: String,
      enum: ["open_trading", "closed_temporarily", "relocated", "not_found"],
      default: "open_trading",
    },
    stockLevel: {
      type: String,
      enum: ["well_stocked", "low_stock", "no_stock"],
      default: "well_stocked",
    },
    merchantContactPerson: { type: String, default: null },
    // Backward compatibility flags
    visited: { type: Boolean, default: true },
    stockSeen: { type: Boolean, default: true },
    addressMatched: { type: Boolean, default: true },
    note: { type: String, default: "", maxlength: 600 },
    // Reward / Bounty settlement tracking
    rewardKobo: { type: Number, default: 50000 }, // ₦500 Proof of Work reward
    rewardCredited: { type: Boolean, default: true },
    status: {
      type: String,
      enum: ["approved", "pending_review", "rejected"],
      default: "approved",
    },
  },
  { timestamps: true },
);

export default mongoose.model("VendorValidation", schema);
