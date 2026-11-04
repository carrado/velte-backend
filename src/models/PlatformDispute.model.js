import mongoose from "mongoose";

// A complaint that is not tied to a cart order. Filing one does not hide
// either party. Ops resolves it; hiddenFromSearch is never set here.
const schema = new mongoose.Schema(
  {
    openerId: { type: mongoose.Schema.Types.ObjectId, required: true },
    openerType: { type: String, enum: ["buyer", "vendor"], required: true },
    vendorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    detail: { type: String, required: true, maxlength: 1000 },
    status: { type: String, enum: ["open", "resolved"], default: "open" },
    resolution: { type: String, default: null, maxlength: 400 },
  },
  { timestamps: true },
);

export default mongoose.model("PlatformDispute", schema);
