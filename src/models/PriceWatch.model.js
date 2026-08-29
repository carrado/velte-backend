import mongoose from "mongoose";

// Someone asking to be told when something gets cheaper (2026-08-29).
//
// The headline paid feature, and the reason Velte Plus is worth ₦3,500: it
// costs almost nothing to serve (an HTTP GET of a page we already know how
// to read — no LLM anywhere in the loop) and it can save tens of thousands of
// naira. That asymmetry is the whole argument for a subscription, as opposed
// to metering searches, which is the opposite on both counts.
//
// OWNED BY EITHER KIND OF ACCOUNT. Buyers watch things they want to buy;
// vendors watch competitors' prices, which is a genuinely different use and a
// real reason for a vendor to keep coming back. Keyed on
// (ownerId, ownerType) for the same reason Usage is — Velte runs two
// independent sessions and hanging this off one collection could only ever
// serve half the users.
//
// Two kinds of TARGET, which is a separate axis from who owns the watch:
//   - "velte"    — one of our own vendors' products. Price comes from our
//                  own database, so checking is free and exact.
//   - "external" — a Jumia/Konga/Jiji listing. Price is re-read from the
//                  page's own meta tags by the frontend's pageMeta.ts, the
//                  same code that put the price on the card in the first
//                  place. Deliberately NOT re-implemented here: this repo
//                  has no HTML parsing and shouldn't grow any.
const priceWatchSchema = new mongoose.Schema(
  {
    // Buyer._id or User._id. Not a `ref`: it points at two different
    // collections depending on ownerType, which one ref can't express.
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    ownerType: {
      type: String,
      enum: ["buyer", "vendor"],
      required: true,
    },
    kind: {
      type: String,
      enum: ["velte", "external"],
      required: true,
    },
    // Set for kind "velte" — the product being watched.
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      default: null,
    },
    // Set for kind "external" — the listing page. Also the dedup key for
    // external watches (see the partial indexes below).
    url: {
      type: String,
      default: null,
      trim: true,
    },
    // What to show in the alert and the list, captured at watch time. Stored
    // rather than re-derived so an alert still reads correctly even if the
    // listing later changes its title or loses its photo — and so listing
    // someone's watches never needs a fan-out of external fetches.
    label: { type: String, required: true, trim: true },
    imageUrl: { type: String, default: null },
    merchant: { type: String, default: null },

    // Kobo throughout, same as every other money field in this repo.
    // `startPriceKobo` is what it cost when the watch started — that's what
    // makes "₦81,000 less than when you saved it" possible, which is the
    // sentence that justifies the subscription.
    startPriceKobo: { type: Number, required: true, min: 0 },
    lastPriceKobo: { type: Number, required: true, min: 0 },
    // Optional owner-set trigger ("tell me under ₦700k"). Null means alert
    // on ANY drop below the last seen price.
    targetPriceKobo: { type: Number, default: null, min: 0 },

    status: {
      type: String,
      enum: ["active", "paused", "ended"],
      default: "active",
      index: true,
    },
    lastCheckedAt: { type: Date, default: null },
    // When the owner was last told about a drop. Paces alerts so a listing
    // that wobbles by ₦500 a day doesn't message someone daily — see the
    // checker's own cooldown.
    lastNotifiedAt: { type: Date, default: null },
    // Consecutive failed reads. A listing that 404s forever (sold, delisted)
    // shouldn't be fetched twice a day for the rest of time.
    failureCount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

// One watch per account per thing. Partial indexes rather than plain unique
// compounds for the same reason Buyer.model.js uses them: `productId` is null
// on every external watch and `url` is null on every velte one, and a plain
// unique index would treat all those nulls as duplicates of each other — so
// an account could hold exactly one external watch in total.
priceWatchSchema.index(
  { ownerId: 1, ownerType: 1, productId: 1 },
  {
    unique: true,
    partialFilterExpression: { productId: { $type: "objectId" } },
  },
);
priceWatchSchema.index(
  { ownerId: 1, ownerType: 1, url: 1 },
  { unique: true, partialFilterExpression: { url: { $type: "string" } } },
);

// The checker's own query: active watches, oldest-checked first.
priceWatchSchema.index({ status: 1, lastCheckedAt: 1 });

export default mongoose.model("PriceWatch", priceWatchSchema);
