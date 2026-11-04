import mongoose from "mongoose";

// A paid placement on the Vendors Hub (Phase 4 of docs/velte-platform-plan.md,
// per docs/vendor-delivery-and-hub.md).
//
// "Place Advert" pins the creative to the top of the hub for a fixed window.
// A "Boost" is an advert plus a push to opted-in buyers — the push itself is
// recorded as a HubBroadcast; the fan-out lands with the
// notification-preferences UI. Sponsored placement is always labelled in the
// feed: payment buys position among vendors who already qualify, never
// relevance (platform plan Phase 2.4 — the LLM still never invents vendors).
//
// Billing reuses the vendor WALLET, not credits. Basic pays the pin price per
// advert; Enterprise pins are COVERED by the subscription (decided
// 2026-10-15 — only the boost push still costs). A zero-cost pin skips the
// debit and the ledger row entirely. Paid pins debit atomically
// ($gte-filtered) with a deterministic reference `hub_advert_<advertId>`, so
// a retried request can only ever bill once — the same idempotency shape as
// debitWalletForLead's `buyer_request_<requestId>_<vendorId>`.
const hubAdvertSchema = new mongoose.Schema(
  {
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    /** Set when a Premium buyer placed this pin for the vendor. */
    placedByBuyerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Buyer",
      default: null,
    },

    // Creative — one of the three poster paths in vendor-delivery-and-hub.md:
    // an uploaded artwork, a Velte template, or an image lifted from one of
    // the vendor's own listings.
    imageUrl: { type: String, required: true, trim: true },
    /** Velte template id. null = custom upload (own artwork or IT specialist). */
    templateId: { type: String, default: null },
    headline: { type: String, required: true, trim: true, maxlength: 80 },
    blurb: { type: String, default: "", trim: true, maxlength: 280 },
    /** Optional link to one of the vendor's own listings. */
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      default: null,
    },

    status: {
      type: String,
      enum: ["active", "expired", "cancelled"],
      default: "active",
      index: true,
    },
    /** Place Advert pins the creative to the hub top for the paid window. */
    pinned: { type: Boolean, default: true },
    /** True once its linked broadcast is sent — set at send time, not here. */
    boosted: { type: Boolean, default: false },

    startsAt: { type: Date, default: Date.now },
    endsAt: { type: Date, required: true, index: true },

    costKobo: { type: Number, required: true },
    enterpriseFree: { type: Boolean, default: false },

    // Counters. Incremented by the Hub page's view/click endpoints (next
    // slice, with per-actor-per-day dedup); Enterprise analytics reads these.
    // They start at 0 — never seeded, never self-reported by the vendor.
    views: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 },
  },
  { timestamps: true },
);

hubAdvertSchema.index({ status: 1, endsAt: 1 });

export default mongoose.model("HubAdvert", hubAdvertSchema);
