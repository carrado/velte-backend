import mongoose from "mongoose";
import { SECTOR_CLASSIFICATION_BY_VALUE } from "../utils/sectorLabels.js";

const FOOD_CLASSIFICATIONS = ["food", "food_both"];
const isFoodSector = (sectorValue) =>
  FOOD_CLASSIFICATIONS.includes(SECTOR_CLASSIFICATION_BY_VALUE[sectorValue]);

const attributeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    value: { type: String, required: true },
  },
  { _id: true },
);

// Each modifier group is embedded per product (required/multi_select may differ
// per dish), but its options are refs to the shared ModifierOption collection
// so that prices stay centralised across every product that uses the same option.
const modifierGroupSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    required: { type: Boolean, default: false },
    multiSelect: { type: Boolean, default: false },
    options: [{ type: mongoose.Schema.Types.ObjectId, ref: "ModifierOption" }],
  },
  { _id: true },
);

const productSchema = new mongoose.Schema(
  {
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    // Which of the vendor's own sectors (taxonomy slug) this specific listing
    // was posted under — drives shape (food/retail/service tooling) per
    // LISTING rather than one frozen account-wide type, so a vendor can post
    // a dish under a food sector and a service under a different sector on
    // the same account. No Mongoose enum: the taxonomy lives in code and is
    // validated in the controller so a taxonomy edit never needs a migration.
    sectorValue: {
      type: String,
      required: true,
    },

    // ── offering identity (marketplace model) ───────────────────────────────
    // A catalog entry is an "offering": a stocked good OR a service (repairs,
    // tailoring, cleaning…). Services carry no stock semantics.
    kind: { type: String, enum: ["product", "service"], default: "product" },
    // Service with no upfront price — buyers "Contact for quote" and the price
    // is agreed per job in chat. Only meaningful for kind === 'service'.
    quoteOnRequest: { type: Boolean, default: false },

    // ── shared fields ───────────────────────────────────────────────────────
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, maxlength: 1000, default: null },
    // Services and dishes carry no category — discovered by meaning
    // (description + sector) rather than a fixed bucket. Only retail
    // products need one.
    categoryId: {
      type: String,
      default: null,
      required: function () {
        return this.kind !== "service" && !isFoodSector(this.sectorValue);
      },
    },
    // `price` is the single price, or the low end of a range. `priceMax` (when
    // set) makes it a range [price .. priceMax] shown as "₦X – ₦Y".
    price: { type: Number, required: true, min: 0 },
    priceMax: { type: Number, default: null, min: 0 },
    currency: { type: String, enum: ["NGN", "USD"], default: "NGN" },
    isFeatured: { type: Boolean, default: false },
    tags: { type: [String], default: [] },
    mainImageUrl: { type: String, default: null },
    thumbnailUrls: { type: [String], default: [] },
    videoUrl: { type: String, default: null },
    colorClass: { type: String, default: null },

    // ── retail-only ─────────────────────────────────────────────────────────
    stockQuantity: { type: Number, default: 0 },
    orderedQuantity: { type: Number, default: 0 },
    lowStockThreshold: { type: Number, default: null },
    manufacturingDate: { type: Date, default: null },
    expirationDate: { type: Date, default: null },
    attributes: { type: [attributeSchema], default: [] },

    // ── food-only ───────────────────────────────────────────────────────────
    isCurrentlyAvailable: { type: Boolean, default: true },
    dailyLimit: { type: Number, default: null },
    dailyOrderCount: { type: Number, default: 0 },
    dailyLimitDisabled: { type: Boolean, default: false },
    allowPreOrder: { type: Boolean, default: false },
    modifiers: { type: [modifierGroupSchema], default: [] },

    // ── catalog provenance (connected catalogs, spec §16.1) ─────────────────
    // Where this offering came from. "manual" = entered in the dashboard;
    // "connected" = synced from the vendor's own website (WooCommerce/Shopify/
    // feed). Connected items are read-only in Velte ("managed on your website")
    // and re-sync from `sourceUrl`; `externalId` dedupes across syncs.
    origin: {
      type: String,
      enum: ["manual", "connected"],
      default: "manual",
    },
    sourceUrl: { type: String, default: null },
    externalId: { type: String, default: null },
    syncedAt: { type: Date, default: null },

    // ── Velte Connect retrieval ─────────────────────────────────────────────
    // Voyage `voyage-4` embedding of name+attributes+category, populated by the
    // AI search layer (Bucket D3) on create/update. Atlas Vector Search index is
    // created out-of-band (Atlas UI/API), not declared here.
    embedding: { type: [Number], default: undefined, select: false },
    // Voyage `voyage-multimodal-3` embedding of mainImageUrl, populated
    // alongside `embedding`. Deliberately NOT behind a second Atlas Vector
    // Search index — it's compared in application code (cosine similarity)
    // against the query photo's own embedding, only across the candidate set
    // the existing text `$vectorSearch` already narrowed down. See
    // retrieval.service.js's rankCandidates.
    imageEmbedding: { type: [Number], default: undefined, select: false },
  },
  {
    timestamps: true,
    toObject: { virtuals: true },
    toJSON: { virtuals: true },
  },
);

export default mongoose.model("Product", productSchema);
