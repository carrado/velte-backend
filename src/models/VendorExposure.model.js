import mongoose from "mongoose";

// Rolling exposure counter for search-result rotation (retrieval.service.js
// — Idea B / "equal share of visibility"). One document per (vendor,
// category, day) rather than one per impression — a search that shows a
// vendor just does a single $inc on today's bucket, so this stays cheap even
// under real traffic. "Recent exposure" for a vendor is the sum of their
// shownCount across the last EXPOSURE_WINDOW_DAYS bucket documents (see
// fetchRecentExposure in retrieval.service.js).
//
// categoryId is null for service-kind products (they carry no category —
// see Product.model.js) — those fall back to tracking exposure per-vendor
// globally rather than per-category, since there's no category to scope by.
const vendorExposureSchema = new mongoose.Schema({
  vendorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true,
  },
  categoryId: { type: String, default: null },
  // "YYYY-MM-DD", UTC — a plain sortable/comparable string bucket rather
  // than a Date range, so "sum the last N days" is just a $gte string
  // comparison, no date-math in the query itself.
  dateBucket: { type: String, required: true },
  shownCount: { type: Number, default: 0, min: 0 },
  // TTL cleanup only — deliberately longer than retrieval.service.js's own
  // EXPOSURE_WINDOW_DAYS so a bucket is never queried right up against its
  // own expiry. Bump both together if the window ever changes meaningfully.
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 7 },
});

vendorExposureSchema.index(
  { vendorId: 1, categoryId: 1, dateBucket: 1 },
  { unique: true },
);

export default mongoose.model("VendorExposure", vendorExposureSchema);
