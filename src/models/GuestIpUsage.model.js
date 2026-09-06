import mongoose from "mongoose";

// The network-level backstop behind a GUEST's own browser-side allowance
// (2026-09-05). See credits.controller.js's checkGuestIpUsage for the full
// reasoning; the short version: a guest's own credit count lives in their
// browser (the frontend's lib/guestCredits.ts) and resets the instant it's
// cleared, so it protects nothing against someone doing that on purpose.
// This is what still remembers, because it was never inside their browser
// to begin with.
//
// One row per (address, day). Deliberately per ADDRESS, never per browser,
// device, or person — it does not try to recognise anyone, only to notice
// when an unusual amount of guest activity has come from one shared
// connection. That is why the ceiling this feeds can stay generous: many
// honest strangers legitimately share one address (carrier-grade mobile
// NAT, an office, a campus), and a tight limit here would refuse people who
// did nothing wrong.
const guestIpUsageSchema = new mongoose.Schema({
  ip: { type: String, required: true },
  // "YYYY-MM-DD" (UTC) rather than a date-range field — the read-and-
  // increment below is then one exact-match upsert, not a range query.
  day: { type: String, required: true },
  count: { type: Number, default: 0 },
  // TTL: a row expires on its own two days after it was first written. No
  // cleanup job needed, and it means a bad day for one address is never
  // held against it for longer than that — this is a backstop, not a
  // punishment.
  createdAt: { type: Date, default: Date.now, expires: "2d" },
});

// One row per address per day — the thing checkGuestIpUsage upserts into.
guestIpUsageSchema.index({ ip: 1, day: 1 }, { unique: true });

export default mongoose.model("GuestIpUsage", guestIpUsageSchema);
