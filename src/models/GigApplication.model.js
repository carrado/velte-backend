import mongoose from "mongoose";

const gigApplicationSchema = new mongoose.Schema(
  {
    gigId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Gig",
      required: true,
      index: true,
    },
    buyerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Buyer",
      required: true,
      index: true,
    },
    pitch: {
      type: String,
      required: true,
      trim: true,
      maxlength: 1500,
    },
    proposedDuration: {
      type: String,
      default: "2-3 days",
      trim: true,
    },
    phone: {
      type: String,
      default: null,
      trim: true,
    },
    status: {
      type: String,
      enum: ["pending", "accepted", "rejected", "submitted", "completed"],
      default: "pending",
      index: true,
    },
    submissionProof: {
      notes: { type: String, default: "", trim: true, maxlength: 3000 },
      photos: { type: [String], default: [] },
      links: { type: [String], default: [] },
      submittedAt: { type: Date, default: null },
    },
    payoutKobo: {
      type: Number,
      default: 0,
      min: 0,
    },
    payoutStatus: {
      type: String,
      enum: ["unpaid", "released"],
      default: "unpaid",
    },
    reviewedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

gigApplicationSchema.index({ gigId: 1, buyerId: 1 }, { unique: true });

export default mongoose.model("GigApplication", gigApplicationSchema);

