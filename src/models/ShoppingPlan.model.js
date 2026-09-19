import mongoose from "mongoose";

// Shopping Plan (2026-09-18) — a persistent, deadline-driven shopping
// mission, distinct from an ordinary /api/search turn. Built on the same
// resumable, owner-polymorphic shape as the deleted ShoppingListJob (see
// that model's own git history, `git show <prior-HEAD>:src/models/ShoppingListJob.model.js`),
// but RECURRING rather than one-shot: ShoppingListJob ran each item once
// and completed; a plan keeps monitoring — new options, price changes,
// availability — roughly every 24h until the buyer completes it, pauses
// it, cancels it, or its deadline passes.
//
// Eligibility is decided entirely by /api/search/route.ts BEFORE a plan is
// ever created here (deadline 7+ days away) — this model has no opinion on
// that threshold, same separation BuyerRequest.model.js keeps from its own
// eligibility logic living in the frontend.

const candidateSchema = new mongoose.Schema(
  {
    // "source:externalId" (e.g. "velte:<productId>", "external:<offerId>")
    // — the diffing key the monitoring job uses to tell "this is the same
    // candidate seen before, check for a price/availability change" apart
    // from "this is new, append it". Never regenerated from the snapshot
    // itself, since a VendorMatch/StoreMatch/ExternalOffer's own id field
    // differs by shape.
    candidateKey: { type: String, required: true },
    source: {
      type: String,
      enum: ["velte_product", "velte_store", "external"],
      required: true,
    },
    // Raw VendorMatch / StoreMatch / ExternalOffer, exactly as
    // searchProductsCore/searchStoresCore returned it — this backend never
    // interprets the shape, only stores and hands it back, same contract
    // ShoppingListJob's own velteResults/externalOffers already followed.
    snapshot: { type: mongoose.Schema.Types.Mixed, required: true },
    firstDiscoveredAt: { type: Date, required: true },
    lastCheckedAt: { type: Date, required: true },
    // Never overwritten in place — a new entry is appended only when the
    // price/availability actually changed since the last check, so the
    // array itself IS the history (spec §16), not a derived thing.
    priceHistory: {
      type: [
        {
          _id: false,
          priceNaira: { type: Number, required: true },
          checkedAt: { type: Date, required: true },
        },
      ],
      default: [],
    },
    availabilityHistory: {
      type: [
        {
          _id: false,
          available: { type: Boolean, required: true },
          checkedAt: { type: Date, required: true },
        },
      ],
      default: [],
    },
  },
  { _id: true },
);

const itemSchema = new mongoose.Schema(
  {
    order: { type: Number, required: true },
    label: { type: String, required: true },
    category: { type: String, default: "General" },
    quantity: { type: Number, default: 1 },
    // Higher = searched/reported on first. Buyer-adjustable later via
    // conversational management ("focus on finding the shoes first" —
    // spec §23), defaulted from generation order so nothing is ever
    // unranked.
    priority: { type: Number, default: 0 },
    // No longer model-estimated at creation (removed 2026-09-19, explicit
    // product direction: Velte never invents a price of its own — see
    // buildShoppingPlanSnapshot.ts's own header). Stays 0 until this item
    // has a real candidate — estimatedTotalNaira (shoppingPlan.controller.js
    // / shoppingPlan.job.js) reads through the live candidate list, never
    // this field, for exactly that reason. Kept rather than dropped from the
    // schema: a future deterministic fair-price engine could still populate
    // it legitimately, which a model guess never could.
    estimatedPriceNaira: { type: Number, default: 0 },
    fairPriceMinNaira: { type: Number, default: 0 },
    fairPriceMaxNaira: { type: Number, default: 0 },
    notes: { type: String, default: null },
    status: {
      type: String,
      enum: ["pending", "searching", "found", "no_match", "failed"],
      default: "pending",
    },
    lastCheckedAt: { type: Date, default: null },
    candidates: { type: [candidateSchema], default: [] },
    // The buyer's own pick (candidateSchema._id) — null until they choose
    // one via the Shopping Plans page. Never auto-selected by the
    // monitoring job itself; finding options and picking one are
    // deliberately different states (spec §28).
    selectedCandidateId: { type: mongoose.Schema.Types.ObjectId, default: null },
    // Phase 2 (2026-09-19) — "alternatives with approval" (spec §20): set
    // by the monitoring job the moment the SELECTED candidate is detected
    // unavailable (never for a candidate the buyer never picked — there's
    // nothing to replace). Purely a SUGGESTION; the job never writes it
    // into selectedCandidateId itself — the buyer approves (moves it into
    // selectedCandidateId via the same select endpoint) or dismisses it
    // (cleared, no replacement) explicitly. Never silent.
    suggestedAlternativeCandidateId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    // Real user action, not inferred from search results — "found" and
    // "selected" both mean Velte/the buyer identified an option; only this
    // means money actually changed hands (spec §28's "purchasing = actual
    // user progress"). No payment-tracking integration exists anywhere in
    // this codebase to verify it automatically, so this is a plain manual
    // toggle for now (see shoppingPlan.controller.js's own markPurchased).
    purchased: { type: Boolean, default: false },
    // Snapshotted at the moment of purchase — the SELECTED candidate's
    // price can keep moving in later monitoring cycles (a vendor raising
    // or dropping their price doesn't retroactively change what was
    // actually paid), so "amount spent" must freeze independently of the
    // live price history.
    purchasedPriceNaira: { type: Number, default: null },
    // Phase 3 (2026-09-19) — conversational management ("I don't need
    // sportswear anymore" / "remove the expensive school bag"). A soft
    // flag, not a real array splice: the item's own discovery/price
    // history is real data already paid for (credits already spent
    // checking it) and stays intact, same "never overwrite history"
    // discipline the candidate schema itself follows — it's just excluded
    // from monitoring, estimates, and digests going forward. Reversible in
    // principle (nothing stops re-adding by re-flipping this), though no
    // "un-remove" action is wired yet.
    removed: { type: Boolean, default: false },
  },
  { _id: true },
);

const shoppingPlanSchema = new mongoose.Schema(
  {
    // Exactly one of buyerId/vendorId is ever set — same dual-ownership
    // shape Credits/Notification/ShoppingListJob already share, so a
    // vendor shopping for their own business bills and gets notified
    // exactly the way a buyer does.
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
    // Reference for appending the creation confirmation and future updates
    // onto the ORIGINAL conversation — never the plan's own detailed
    // results, same restraint ShoppingListJob's notifyConversationComplete
    // already followed.
    conversationId: { type: String, default: null },
    deviceId: { type: String, default: null },
    // Idempotency key — a double-submit of the same chat turn finds this
    // plan already created rather than starting a duplicate. Scoped to
    // (clientRef, buyerId)/(clientRef, vendorId) below, not clientRef
    // alone, matching ShoppingListJob's own partial-unique-index reasoning.
    clientRef: { type: String, default: null },

    goalText: { type: String, required: true },
    deadlineDate: { type: Date, required: true },
    // The buyer's stated target, in naira — NEVER a filter on search or a
    // reason to drop a required item (spec §7/§29). Null when not given.
    budgetNaira: { type: Number, default: null },

    status: {
      type: String,
      enum: [
        "active",
        "monitoring",
        "paused",
        "completed",
        "cancelled",
        "expired",
      ],
      default: "active",
      index: true,
    },

    // ── Recurring schedule ──────────────────────────────────────────────
    // `jitterMs` is rolled ONCE at creation (0..1h) and re-applied on every
    // advance — this is what spreads plans created around the same time
    // across a hair different daily "slots" instead of every plan waking
    // the sweep at exactly the same offset from midnight, without needing
    // a distributed scheduler.
    jitterMs: { type: Number, default: 0 },
    nextMonitorAt: { type: Date, required: true, index: true },
    lastMonitoredAt: { type: Date, default: null },
    // Adaptive (Phase 2) — starts at the plain 24h cadence. The INTERNAL
    // search frequency may tighten as the deadline nears; the user-facing
    // digest stays ~24h regardless (spec §18) via lastDigestAt below.
    monitoringIntervalHours: { type: Number, default: 24 },
    lastDigestAt: { type: Date, default: null },
    // The plan's own estimated total AS OF the last digest — Phase 2
    // decouples internal checks from digest delivery (checks can run more
    // often than once a day near the deadline; digests still go out at
    // most once every ~24h), so "previous vs current estimate" in the
    // digest can no longer just be "last cycle's number" the way Phase 1's
    // coupled cycle could — it has to be pinned to the last DIGEST
    // specifically, updated only when a digest actually sends.
    lastDigestEstimateNaira: { type: Number, default: null },

    // Set at the start of each monitoring pass, before any item is
    // touched — the dedup key a crash-mid-cycle retry checks against so a
    // digest is never generated or sent twice for the same pass (spec §26).
    currentMonitoringCycleId: { type: String, default: null },
    lastCycle: {
      cycleId: { type: String, default: null },
      cycleStart: { type: Date, default: null },
      cycleEnd: { type: Date, default: null },
      newOptions: { type: Number, default: 0 },
      priceDrops: { type: Number, default: 0 },
      priceIncreases: { type: Number, default: 0 },
      unavailable: { type: Number, default: 0 },
      previousEstimateNaira: { type: Number, default: null },
      currentEstimateNaira: { type: Number, default: null },
      budgetStatus: {
        type: String,
        enum: ["within_budget", "slightly_over_budget", "significantly_over_budget", null],
        default: null,
      },
      summaryGenerated: { type: Boolean, default: false },
      pushSent: { type: Boolean, default: false },
      smsSent: { type: Boolean, default: false },
    },

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

// The sweep's own query: every active/monitoring plan due for its next
// cycle, oldest-due first.
shoppingPlanSchema.index({ status: 1, nextMonitorAt: 1 });
shoppingPlanSchema.index({ buyerId: 1, createdAt: -1 });
shoppingPlanSchema.index({ vendorId: 1, createdAt: -1 });
// Partial index (only documents with a real clientRef), same reasoning as
// ShoppingListJob's own — a plain `sparse` index still collides two
// null-valued documents under some driver/index combinations.
shoppingPlanSchema.index(
  { clientRef: 1, buyerId: 1 },
  { unique: true, partialFilterExpression: { clientRef: { $type: "string" } } },
);
shoppingPlanSchema.index(
  { clientRef: 1, vendorId: 1 },
  { unique: true, partialFilterExpression: { clientRef: { $type: "string" } } },
);

export default mongoose.model("ShoppingPlan", shoppingPlanSchema);
