import mongoose from "mongoose";

// A real, non-Velte business surfaced by searchStores' Tier 3 (Google
// Places) fallback — recruitment target data, not a demand-log row. Named
// distinctly from the spec's planned `leads` collection (§9), which is a
// different concept: billing/monetization leads for buyer inquiries routed
// to *existing* Velte vendors. This is the write side only — no outreach,
// no admin UI yet (vendor-ops was torn down in the Velte Connect pivot).
// `placeId` (Google's stable Place ID) is the dedupe key: the same real
// business legitimately recurs across many unrelated buyer turns, so it
// needs its own identity with a hit count, not a repeated blob per search.
const recruitmentLeadSchema = new mongoose.Schema(
  {
    placeId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    address: { type: String, required: true },
    location: {
      type: { type: String, enum: ["Point"], default: "Point" },
      coordinates: { type: [Number], required: true }, // [lng, lat]
    },
    // Most-recent-first, capped at 20 (via $slice on write) so a
    // frequently-surfaced business doesn't grow this unboundedly. The
    // business type/category buyers were searching for, not the raw message.
    matchedQueries: { type: [String], default: [] },
    hitCount: { type: Number, default: 0 },
    lastSeenAt: { type: Date, default: Date.now },
    // Nothing reads/writes this beyond the default yet — it's the natural
    // identity of a lead record, kept here so a future manual-review UI
    // doesn't need a schema migration to add it.
    status: {
      type: String,
      enum: ["new", "contacted", "onboarded", "ignored"],
      default: "new",
    },
  },
  { timestamps: true },
);

recruitmentLeadSchema.index({ location: "2dsphere" });

export default mongoose.model("RecruitmentLead", recruitmentLeadSchema);
