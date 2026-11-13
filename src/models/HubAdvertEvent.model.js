import mongoose from "mongoose";

// Per-actor-per-day deduplication ledger for Hub advert impressions ("view")
// and clicks ("click"). Ensures refreshing or repeated clicks by the same
// viewer on the same day only count once toward HubAdvert.views / clicks.
const hubAdvertEventSchema = new mongoose.Schema(
  {
    advertId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HubAdvert",
      required: true,
    },
    actorKey: { type: String, required: true },
    kind: { type: String, enum: ["view", "click"], required: true },
    day: { type: String, required: true }, // YYYY-MM-DD (UTC)
    createdAt: { type: Date, default: Date.now, expires: 3 * 24 * 60 * 60 },
  },
  { versionKey: false },
);

hubAdvertEventSchema.index(
  { advertId: 1, actorKey: 1, kind: 1, day: 1 },
  { unique: true },
);

export default mongoose.model("HubAdvertEvent", hubAdvertEventSchema);

