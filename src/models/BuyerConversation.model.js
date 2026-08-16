import mongoose from "mongoose";

// A buyer's persisted /velux chat threads — added 2026-08-15 for the
// AI-agent pivot's "chat history IS the dashboard" buyer-dashboard piece
// (see the buyer-facing spec discussion: "Don't turn it into a traditional
// marketplace dashboard. The chat history is the dashboard."). Deliberately
// lightweight: {role, content} pairs only, the SAME shape /api/search's own
// `history` param already uses (see the frontend's SearchHistoryTurn) —
// this is NOT a replay log of full search results (products/stores/cards),
// just enough text for the model to pick a conversation back up AND for a
// buyer to read what was said. Resuming a past conversation shows the past
// text as plain chat bubbles; anything searched again from that point on
// renders full result cards normally, same as any other turn.
//
// Only ever written for an IDENTIFIED buyer (verifyBuyerAuth gates every
// route in buyerConversations.routes.js) — an anonymous /velux session
// stays exactly as ephemeral as it always was (see SearchHome.tsx's own
// comment on why nothing persists there by design); persistence starts the
// moment a buyer has a real session, never before.
const buyerConversationSchema = new mongoose.Schema(
  {
    buyerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Buyer",
      required: true,
      index: true,
    },
    // The first user turn's text, truncated — the "Recent" list's own
    // label. Set once at creation and never regenerated (turns are only
    // ever appended, never edited, so there's nothing to regenerate it
    // FROM after the fact anyway).
    title: {
      type: String,
      required: true,
      trim: true,
    },
    turns: [
      {
        role: { type: String, enum: ["user", "assistant"], required: true },
        content: { type: String, required: true },
        _id: false,
      },
    ],
    lastMessageAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true },
);

// Buyer's own "Recent" list is always sorted most-recent-first — this is
// the one query pattern that matters, so it's the one compound index this
// collection needs.
buyerConversationSchema.index({ buyerId: 1, lastMessageAt: -1 });

export default mongoose.model("BuyerConversation", buyerConversationSchema);
