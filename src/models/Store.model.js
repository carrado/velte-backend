import mongoose from "mongoose";

// One store per vendor — the vendor's public, AI-discoverable presence
// (marketplace-model: the store is the unit of the marketplace, not the
// product). Created lazily on first dashboard visit; the public page lives at
// /store/:handle on the frontend.
const storeSchema = new mongoose.Schema(
  {
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },

    // URL identity: /store/:handle. Lowercase slug, unique across the network.
    handle: {
      type: String,
      required: true,
      unique: true,
      index: true,
      lowercase: true,
      trim: true,
    },

    // Display name — defaults to the vendor's business name at creation but is
    // editable independently.
    name: { type: String, required: true, trim: true, maxlength: 80 },

    // The magic field: plain-language "what we do". This is what gets embedded
    // for store-level matching, so vendors with no offerings uploaded are
    // still discoverable.
    description: { type: String, default: "", maxlength: 600 },

    // Soft sector tags (never a hard fork) — free strings, suggested by the
    // frontend registry.
    sectors: { type: [String], default: [] },

    // WhatsApp number for the buyer handoff CTA (digits only, intl format).
    whatsapp: { type: String, default: null },

    // Showcase photos (Cloudinary URLs).
    gallery: { type: [String], default: [] },

    // ── Connected catalog (spec §16.1) ──────────────────────────────────────
    // The vendor's own website, mirrored into Velte. One source per store.
    // `null` until they connect. The site stays the source of truth: we re-sync
    // on a schedule + manual refresh, and connected products are read-only here.
    connectedCatalog: {
      type: new mongoose.Schema(
        {
          // Normalized origin of the vendor's store (e.g. https://shop.com).
          sourceUrl: { type: String, required: true },
          // Detected adapter: how we pull the catalog.
          platform: {
            type: String,
            enum: ["woocommerce", "shopify", "feed", "unknown"],
            default: "unknown",
          },
          // "connected" once we can read the catalog; "review" when the site
          // isn't auto-detectable and needs manual onboarding.
          status: {
            type: String,
            enum: ["connected", "review"],
            default: "review",
          },
          // Products found at the source on the last probe (0 until synced).
          productCount: { type: Number, default: 0 },
          connectedAt: { type: Date, default: Date.now },
          lastSyncedAt: { type: Date, default: null },
        },
        { _id: false },
      ),
      default: null,
    },

    // ── Velte Connect retrieval ─────────────────────────────────────────────
    // Voyage embedding of description + offering summaries, populated by the
    // AI search layer. Store-level index gives coverage for vendors with no
    // uploaded offerings; the product index gives precision.
    embedding: { type: [Number], default: undefined, select: false },
  },
  { timestamps: true },
);

export default mongoose.model("Store", storeSchema);
