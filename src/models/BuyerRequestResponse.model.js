import mongoose from "mongoose";

// 2026-08-18 — repurposed from a free-text "vendor typed a reply" record
// into a simple accept/decline decision. There's no buyer inbox left to
// read a typed response in anymore (buyers have no account), so the old
// "vendor writes a message, buyer reads it later and picks who to chat"
// flow is gone. Now: a vendor either Accepts (pays for the lead, gets the
// buyer's WhatsApp number right there) or Declines (free, no contact info)
// — see vendorBuyerRequests.controller.js's decideOnRequest.
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
    decision: {
      type: String,
      enum: ["accepted", "declined"],
      required: true,
    },
  },
  { timestamps: true },
);

// One decision per vendor per request — a duplicate insert attempt hits
// this and surfaces as a clean 409 via the existing global errorHandler's
// 11000 branch, no extra controller code needed. This is also the real
// guard against a double-charge race in decideOnRequest: the response doc
// is created (and must win this unique index) BEFORE the wallet is ever
// debited, so two concurrent Accepts can never both charge.
buyerRequestResponseSchema.index(
  { requestId: 1, vendorId: 1 },
  { unique: true },
);

export default mongoose.model(
  "BuyerRequestResponse",
  buyerRequestResponseSchema,
);
