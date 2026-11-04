import mongoose from "mongoose";

const schema = new mongoose.Schema(
  {
    buyerId: { type: mongoose.Schema.Types.ObjectId, ref: "Buyer", required: true, index: true },
    query: { type: String, required: true, maxlength: 200 },
  },
  { timestamps: true },
);

schema.index({ buyerId: 1, query: 1 }, { unique: true });

export default mongoose.model("SavedSearch", schema);
