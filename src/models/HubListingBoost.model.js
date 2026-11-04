import mongoose from "mongoose";

// A vendor sponsoring one listing they already sell. This is not a HubAdvert:
// an advert is a new creative (its own headline and poster). A boost leaves
// the listing as it is and only labels that card Sponsored.
//
// Duration and price come from HUB_BOOST_TIERS. Enterprise pays 0.
const hubListingBoostSchema = new mongoose.Schema(
  {
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["active", "cancelled", "expired"],
      default: "active",
      index: true,
    },
    days: { type: Number, required: true, min: 1 },
    startsAt: { type: Date, default: Date.now },
    endsAt: { type: Date, required: true, index: true },
    costKobo: { type: Number, default: 0 },
    /** Snapshot of the buyer-pool estimate at confirm time. */
    estimatedReachMin: { type: Number, default: null },
    estimatedReachMax: { type: Number, default: null },
  },
  { timestamps: true },
);

hubListingBoostSchema.index({ status: 1, endsAt: 1 });
hubListingBoostSchema.index({ vendorId: 1, productId: 1, status: 1 });

export default mongoose.model("HubListingBoost", hubListingBoostSchema);
