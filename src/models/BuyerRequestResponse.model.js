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
    // Copied from the request, and NULL whenever that request was made by
    // someone with no account (2026-08-27) — which is now the common case,
    // since verifying a phone stopped creating a Buyer. Was `required: true`,
    // which would have thrown at the worst possible moment: a vendor
    // ACCEPTING an anonymous buyer's request, the exact step that releases
    // the WhatsApp number and makes the whole flow pay off.
    //
    // Nothing here needs it — the vendor reads the buyer's name and number
    // off the request's own snapshot, never through this ref.
    buyerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Buyer",
      default: null,
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
