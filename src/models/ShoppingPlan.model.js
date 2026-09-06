import mongoose from "mongoose";

// A buyer's budgeted, multi-category shopping list (2026-09-06) — "I'm
// moving into a new apartment, ₦2m, need the essentials" becomes one of
// these rather than a single search turn.
//
// Buyer-owned and cross-conversation on purpose, the same reason
// BuyerRequest is: a plan is a multi-week commitment a buyer comes back to
// and edits over time, categorically different from the per-conversation
// goal sheet (ConversationTask in the frontend's types/search.ts), which
// tracks ONE item's budget within a single thread and is wiped the moment a
// new request starts.
//
// Every item carries a DENORMALIZED display snapshot (name/imageUrl/
// priceKobo/merchant/url) rather than a live productId join, same call
// BuyerRequest.model.js makes on buyerName/buyerPhone: a reopened plan must
// render instantly and must never disagree with the priced comparison that
// built it, even if the source listing's price moves later.
const shoppingPlanItemSchema = new mongoose.Schema(
  {
    category: { type: String, required: true, trim: true, maxlength: 60 },
    label: { type: String, required: true, trim: true, maxlength: 120 },
    // Per-item planning target, from the category's own allocation — kept
    // on the item too (not just the category) because a "Replace" edit
    // re-searches ONE item against ITS OWN ceiling, not the whole
    // category's pooled budget.
    targetBudgetKobo: { type: Number, default: null, min: 0 },
    status: {
      type: String,
      enum: ["pending", "found", "no_match", "deferred"],
      default: "pending",
    },
    source: { type: String, enum: ["velte", "external", null], default: null },
    // Set only when source === "velte" — the real listing to hand off to.
    productId: { type: String, default: null },
    // Also velte-only — the vendor to contact, needed alongside productId
    // because the WhatsApp handoff link is built from the VENDOR, not the
    // listing (see this repo's chatLink.ts).
    vendorId: { type: String, default: null },
    // Set only when source === "external" — Serper/connector offer id, kept
    // only for dedupe/debugging; the buyer-facing link is `url` below.
    externalOfferId: { type: String, default: null },
    name: { type: String, default: null },
    imageUrl: { type: String, default: null },
    priceKobo: { type: Number, default: null, min: 0 },
    merchant: { type: String, default: null },
    url: { type: String, default: null },
  },
  { _id: true, timestamps: false },
);

const shoppingPlanSchema = new mongoose.Schema(
  {
    // No dual-session complexity here, unlike BuyerRequest/the old
    // PriceWatch — there is no vendor-side use case for a shopping plan, so
    // this is buyer-only from the start.
    buyerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Buyer",
      required: true,
      index: true,
    },
    // The buyer's own words, snapshotted — never re-derived from the
    // categories/items below, which are code's structured READING of it.
    goalText: { type: String, required: true, trim: true, maxlength: 500 },
    totalBudgetKobo: { type: Number, required: true, min: 0 },
    location: {
      area: { type: String, default: null },
      state: { type: String, default: null },
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
    },
    // "draft" — checklist generated, not yet confirmed/searched (the
    // confirm-before-searching step the product spec is explicit about).
    // "active" — confirmed, items resolved (some may still be no_match).
    // "archived" — buyer-hidden, kept for history rather than deleted.
    status: {
      type: String,
      enum: ["draft", "active", "archived"],
      default: "draft",
    },
    categories: [
      {
        _id: false,
        label: { type: String, required: true, trim: true, maxlength: 60 },
        targetBudgetKobo: { type: Number, required: true, min: 0 },
      },
    ],
    items: [shoppingPlanItemSchema],
  },
  { timestamps: true },
);

shoppingPlanSchema.index({ buyerId: 1, createdAt: -1 });

export default mongoose.model("ShoppingPlan", shoppingPlanSchema);
