import mongoose from "mongoose";

// A Premium buyer's visit check. Kept off the review collection so a
// checklist never reads as a star rating.
const schema = new mongoose.Schema(
  {
    buyerId: { type: mongoose.Schema.Types.ObjectId, ref: "Buyer", required: true },
    vendorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    visited: { type: Boolean, required: true },
    stockSeen: { type: Boolean, required: true },
    addressMatched: { type: Boolean, required: true },
    note: { type: String, default: "", maxlength: 400 },
  },
  { timestamps: true },
);

export default mongoose.model("VendorValidation", schema);
