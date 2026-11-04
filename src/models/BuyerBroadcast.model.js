import mongoose from "mongoose";

// A Premium buyer's broadcast to the Premium buyers they referred.
// Status stays "queued": nothing here marks a message sent before a
// delivery path exists.
const schema = new mongoose.Schema(
  {
    buyerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Buyer",
      required: true,
      index: true,
    },
    message: { type: String, required: true, trim: true, maxlength: 280 },
    status: {
      type: String,
      enum: ["queued"],
      default: "queued",
    },
    audienceCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export default mongoose.model("BuyerBroadcast", schema);
