import mongoose from "mongoose";

// Metered AI-search usage for ONE account, whatever kind of account it is
// (2026-08-29).
//
// Replaces the `usage` sub-document that briefly lived on Buyer. That shape
// was wrong the moment a second kind of account needed metering: vendors
// sign in with their own cookie (`auth_token`, not `buyer_auth_token`), so
// the buyer-only gate treated them as anonymous — which meant a signed-in
// vendor was told to "sign in" before using photo search, while an actual
// stranger got unlimited text search. Keying on (ownerId, ownerType) instead
// of hanging counters off one collection means the next kind of account that
// needs metering needs no schema change at all.
//
// ONE ROW PER OWNER, not one per month. `periodKey` is the calendar month
// the counters belong to; when it no longer matches, they are stale and get
// reset in place on the next consume. That keeps this collection the same
// size as the account list forever, and needs no cron — a monthly-history
// table would grow without bound to answer a question the `[cost]` logs
// already answer better.
const usageSchema = new mongoose.Schema(
  {
    // Buyer._id or User._id. Not a `ref`: it deliberately points at two
    // different collections depending on ownerType, which a single ref
    // can't express, and nothing here ever needs to populate it.
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    ownerType: {
      type: String,
      enum: ["buyer", "vendor"],
      required: true,
    },
    /** Calendar month in UTC, "2026-08". */
    periodKey: { type: String, default: null },
    text: { type: Number, default: 0, min: 0 },
    photo: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

// The lookup every consume does, and the guarantee that one account can
// never end up with two counter rows racing each other.
usageSchema.index({ ownerId: 1, ownerType: 1 }, { unique: true });

export default mongoose.model("Usage", usageSchema);
