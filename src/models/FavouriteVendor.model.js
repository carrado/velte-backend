import mongoose from "mongoose";

// A Premium buyer's saved vendor on the Hub. One row per pair.
const schema = new mongoose.Schema(
  {
    buyerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Buyer",
      required: true,
      index: true,
    },
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true },
);

schema.index({ buyerId: 1, vendorId: 1 }, { unique: true });

export default mongoose.model("FavouriteVendor", schema);
