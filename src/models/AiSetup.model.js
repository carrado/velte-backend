// src/models/AISetup.model.js
import mongoose from "mongoose";

// ── Sub-schema: individual WhatsApp phone number ──────────────────────────────
const whatsAppNumberSchema = new mongoose.Schema(
  {
    numberId: { type: String, required: true },           // Meta's phone_number_id
    phoneNumber: { type: String, required: true },         // e.g. "+234 801 234 5678"
    displayName: { type: String, required: true },
    businessName: { type: String, required: true },
    verificationStatus: {
      type: String,
      enum: ["verified", "pending", "unverified"],
      default: "pending",
    },
  },
  { _id: false }
);

// ── Sub-schema: AI configuration options ──────────────────────────────────────
const aiConfigSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: true },
    greetingMessage: {
      type: String,
      default: "Hello! 👋 Welcome to our store. How can I help you today?",
      maxlength: [1000, "Greeting message cannot exceed 1000 characters"],
    },
    businessTone: {
      type: String,
      enum: ["formal", "professional", "casual"],
      default: "professional",
    },
    productCatalogSync: { type: Boolean, default: true },
  },
  { _id: false }
);

// ── Main schema ───────────────────────────────────────────────────────────────
const aiSetupSchema = new mongoose.Schema(
  {
    // One setup document per user
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },

    // Step 1 — Meta OAuth
    metaConnected: { type: Boolean, default: false },
    metaAccessToken: { type: String, select: false },      // never returned in queries
    metaAccessTokenExpiresAt: { type: Date },

    // Step 2 — WhatsApp Business Account
    wabaConfigured: { type: Boolean, default: false },
    wabaId: { type: String },                              // WhatsApp Business Account ID

    // Step 3 — Phone number selection
    availableNumbers: { type: [whatsAppNumberSchema], default: [] },
    selectedNumberId: { type: String, default: null },     // numberId of chosen number

    // Step 4 — AI configuration
    aiConfig: { type: aiConfigSchema, default: () => ({}) },

    // Final activation
    isComplete: { type: Boolean, default: false },
    webhookUrl: { type: String },
    webhookSecret: { type: String, select: false },        // HMAC secret, never exposed
    activatedAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        // Strip sensitive fields even if `select: false` is bypassed accidentally
        delete ret.metaAccessToken;
        delete ret.webhookSecret;
        delete ret.__v;
        return ret;
      },
    },
  }
);

// ── Virtual: derive selectedNumber object from availableNumbers ───────────────
aiSetupSchema.virtual("selectedNumber").get(function () {
  if (!this.selectedNumberId) return null;
  return this.availableNumbers.find((n) => n.numberId === this.selectedNumberId) ?? null;
});

aiSetupSchema.set("toJSON", { virtuals: true });

export default mongoose.model("AISetup", aiSetupSchema);