import mongoose from "mongoose";

// Shopping Lists (2026-09-12) — the durable background search job behind
// "Get these items". Lives here, not as a frontend `after()` callback,
// because this backend process is the actually always-on one (see
// jobs/shoppingListJob.job.js's own header, and keepAlive.js's comment on
// why the frontend's serverless functions can't be trusted to survive to
// the end of a several-minute, many-item job).
//
// `nextItemIndex` is the whole resumability story: the sweep always looks
// at `items[nextItemIndex]` and only advances it once that item's attempt
// has genuinely finished (found, no match, or given up on after retries) —
// a crash or redeploy mid-item just means the next tick re-attempts the
// SAME item, never replays completed ones and never loses the cursor.

const itemSchema = new mongoose.Schema(
  {
    order: { type: Number, required: true },
    label: { type: String, required: true },
    category: { type: String, default: "General" },
    quantity: { type: Number, default: 1 },
    estimatedPriceNaira: { type: Number, default: 0 },
    fairPriceMinNaira: { type: Number, default: 0 },
    fairPriceMaxNaira: { type: Number, default: 0 },
    notes: { type: String, default: null },
    status: {
      type: String,
      enum: [
        "pending",
        "searching",
        "found_velte",
        "found_external",
        "no_match",
        "failed",
      ],
      default: "pending",
    },
    attemptedAt: { type: Date, default: null },
    // Raw VendorMatch[]/ExternalOffer[] snapshots, as the frontend's own
    // search functions returned them — this backend never interprets their
    // shape, only stores and hands them back (see the internal search-item
    // route this sweep calls, and the results page that renders them).
    velteResults: { type: [mongoose.Schema.Types.Mixed], default: [] },
    externalOffers: { type: [mongoose.Schema.Types.Mixed], default: [] },
    // An AnyRecommendation (SearchRecommendation | ComparisonTemplate),
    // set once by POST /shopping-list-jobs/:id/items/:itemId/recommendation
    // (spec §17-19's "select the best" step) — null until then.
    recommendation: { type: mongoose.Schema.Types.Mixed, default: null },
    charged: { type: Boolean, default: false },
    creditsCharged: { type: Number, default: 0 },
  },
  { _id: true },
);

const shoppingListJobSchema = new mongoose.Schema(
  {
    // Exactly one of buyerId/vendorId is ever set (2026-09-17, widened from
    // buyer-only) — explicit product direction: "what buyer can do, vendor
    // can do" (a vendor may want to buy things too, and already has their
    // own credit balance under Credits' `(ownerId, ownerType)` model to
    // spend it from). Neither is `required` any more; the controller is
    // what enforces "the caller must be one or the other" (requireOwner).
    buyerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Buyer",
      default: null,
      index: true,
    },
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    // Reference for two best-effort appends onto this conversation: the
    // "I've started looking…" message at creation time, and a short
    // completion SUMMARY once the job finishes (jobs/shoppingListJob.job.js's
    // notifyConversationComplete, 2026-09-12) — never the job's actual
    // RESULTS, which stay at the dedicated results route (see the frontend
    // results page's own comment on why).
    conversationId: { type: String, default: null },
    deviceId: { type: String, default: null },
    goalText: { type: String, required: true },
    // The buyer's own stated budget, in naira — carried over from the draft
    // ShoppingListSnapshot (the chat card) at creation time, since this job
    // document is the only thing that outlives that turn. Null when the
    // buyer never gave one, same as ShoppingListSnapshot.budgetNaira.
    // Needed here (not just derivable from items) so the "My Shopping
    // Lists" index page can show budget-vs-estimated without re-running
    // the LLM draft.
    budgetNaira: { type: Number, default: null },
    // Idempotency key (spec §34) — a double-click on "Get these items"
    // sends the same clientRef (the turn's own client-side id) and finds
    // this job already created rather than starting a duplicate. Uniqueness
    // is scoped to (clientRef, buyerId) below rather than clientRef alone —
    // this field is client-generated, so the DB-level guarantee should
    // match the ownership scope the controller actually checks, not rely
    // on a client-side UUID never colliding across different buyers.
    clientRef: { type: String, default: null },
    status: {
      type: String,
      enum: ["queued", "running", "completed", "completed_partial", "failed"],
      default: "queued",
    },
    totalItems: { type: Number, required: true },
    nextItemIndex: { type: Number, default: 0 },
    creditsChargedTotal: { type: Number, default: 0 },
    // Consecutive failures on the CURRENT item only — resets to 0 the
    // moment an item completes (found or genuinely given up on), so a
    // transient blip on item 3 can't quietly cap how many retries item 7
    // gets later.
    failureStreak: { type: Number, default: 0 },
    notifiedAt: { type: Date, default: null },
    location: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
      area: { type: String, default: null },
      state: { type: String, default: null },
    },
    items: { type: [itemSchema], default: [] },
  },
  { timestamps: true },
);

shoppingListJobSchema.index({ status: 1, updatedAt: 1 });
shoppingListJobSchema.index({ buyerId: 1, createdAt: -1 });
// Same shape, for a vendor's own "My Shopping Lists" list (2026-09-17).
shoppingListJobSchema.index({ vendorId: 1, createdAt: -1 });
// Partial index (only documents with a real clientRef) rather than a plain
// sparse one — Mongoose's `sparse` alone still lets two docs both holding
// `null` collide under some driver/index combinations; `partialFilterExpression`
// is the documented-safe way to make a compound unique index optional.
shoppingListJobSchema.index(
  { clientRef: 1, buyerId: 1 },
  { unique: true, partialFilterExpression: { clientRef: { $type: "string" } } },
);
// Vendor twin of the index above, for the same double-click idempotency
// guarantee on a vendor-owned job (2026-09-17).
shoppingListJobSchema.index(
  { clientRef: 1, vendorId: 1 },
  { unique: true, partialFilterExpression: { clientRef: { $type: "string" } } },
);

export default mongoose.model("ShoppingListJob", shoppingListJobSchema);
