import mongoose from "mongoose";

// Demand log (Velte_Connect_Technical_Implementation.md §9 `searches`) —
// every buyer query, matched or not. No `buyerId`/`buyers` collection:
// nothing today re-identifies a buyer across visits (no login, no "your
// past searches" UI), so that reference would be a field with no reader.
// Aggregating/consuming this data (demand reports, vendor recruitment) is
// monetization territory (build-order step h) — this is just the write side.
const searchSchema = new mongoose.Schema(
  {
    rawQuery: { type: String, default: null },
    hadImage: { type: Boolean, default: false },
    // Null when the model never called searchProducts/searchStores at all
    // (e.g. it asked a clarifying question instead) — still a real demand signal.
    parsed: {
      type: new mongoose.Schema(
        {
          product: { type: String, default: null },
          location: { type: String, default: null },
        },
        { _id: false },
      ),
      default: null,
    },
    matched: { type: Boolean, required: true },
    resultVendorIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
      default: [],
    },
    resultStoreIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Store" }],
      default: [],
    },
    // True when no Velte vendor matched at all and searchStores fell
    // through to real Google Places results — itself a demand signal:
    // real businesses exist near this query that Velte hasn't recruited yet.
    usedExternalFallback: { type: Boolean, default: false },
    buyerLat: { type: Number, default: null },
    buyerLng: { type: Number, default: null },
  },
  { timestamps: true },
);

export default mongoose.model("Search", searchSchema);
