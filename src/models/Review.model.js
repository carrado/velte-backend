import mongoose from "mongoose";

// Two review kinds, both order-backed:
//   vendor  — one per order (how the seller did)
//   product — one per (order, product) for a line the buyer actually bought
// Legacy rows have no `kind` and read as vendor reviews.
const schema = new mongoose.Schema(
  {
    buyerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Buyer",
      required: true,
    },
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
    },
    kind: {
      type: String,
      enum: ["vendor", "product"],
      default: "vendor",
      index: true,
    },
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      default: null,
      index: true,
    },
    rating: { type: Number, required: true, min: 1, max: 5 },
    text: { type: String, default: "", maxlength: 800 },
    reply: { type: String, default: null, maxlength: 800 },
    repliedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// One vendor review per order. Partial filters cannot use `$exists: false`
// (Mongo rewrites it to `$not`, which is rejected) — so legacy rows with no
// `kind` are backfilled to "vendor" in ensureReviewIndexes before sync.
schema.index(
  { orderId: 1 },
  {
    unique: true,
    partialFilterExpression: { kind: "vendor" },
  },
);

// One product review per ordered line.
schema.index(
  { orderId: 1, productId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      kind: "product",
      productId: { $type: "objectId" },
    },
  },
);

const Review = mongoose.model("Review", schema);

/** Backfills missing `kind`, drops obsolete / invalid orderId uniques, then
 *  syncs. Safe to call on every boot. */
export async function ensureReviewIndexes() {
  try {
    await Review.updateMany(
      { $or: [{ kind: { $exists: false } }, { kind: null }] },
      { $set: { kind: "vendor" } },
    );
  } catch {
    /* empty collection */
  }

  try {
    const indexes = await Review.collection.indexes();
    for (const idx of indexes) {
      const keys = Object.keys(idx.key || {});
      if (!(idx.unique && keys.length === 1 && keys[0] === "orderId")) continue;
      const partial = idx.partialFilterExpression;
      // Drop: no partial (old global unique), or any `$or` / `$exists` form
      // Mongo cannot (re)build — then syncIndexes recreates `{ kind: "vendor" }`.
      const needsDrop =
        !partial ||
        partial.$or != null ||
        JSON.stringify(partial).includes("$exists");
      if (needsDrop && idx.name) {
        await Review.collection.dropIndex(idx.name);
      }
    }
  } catch {
    /* empty collection / already dropped */
  }
  await Review.syncIndexes();
}

export default Review;
