import mongoose from "mongoose";

// AI advert-poster generations per vendor. Basic 2 / Enterprise 5 — see
// HUB_AI_POSTER_DAILY_* in config/prices.js. When the vendor uses the last
// slot, `resetsAt` is set to now+24h; until then remaining is 0. After
// `resetsAt`, count clears and a fresh allowance begins.
const hubAiPosterUsageSchema = new mongoose.Schema(
  {
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    count: { type: Number, default: 0, min: 0 },
    /** Set when count hits the tier limit; null while slots remain. */
    resetsAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export default mongoose.model("HubAiPosterUsage", hubAiPosterUsageSchema);
