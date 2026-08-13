import mongoose from "mongoose";

const buyerRequestResponseSchema = new mongoose.Schema(
  {
    requestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BuyerRequest",
      required: true,
      index: true,
    },
    buyerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Buyer",
      required: true,
    },
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    vendorResponse: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
    },
  },
  { timestamps: true },
);

// One active response per vendor per request — spec §20. A duplicate
// insert attempt hits this and surfaces as a clean 409 via the existing
// global errorHandler's 11000 branch, no extra controller code needed.
buyerRequestResponseSchema.index(
  { requestId: 1, vendorId: 1 },
  { unique: true },
);

export default mongoose.model(
  "BuyerRequestResponse",
  buyerRequestResponseSchema,
);
