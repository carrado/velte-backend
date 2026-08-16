import BuyerConversation from "../../models/BuyerConversation.model.js";
import { AppError } from "../../middleware/errorHandler.js";

const TITLE_MAX_LEN = 80;
// Bounds document size for a very long-running conversation — oldest turns
// drop off the STORED copy first (not the model's own /api/search context,
// which is a separate, per-request client-sent thing entirely). A buyer
// resuming a very old, very long thread loses only its earliest turns, not
// the ability to resume at all.
const MAX_STORED_TURNS = 60;

function truncateTitle(text) {
  const trimmed = text.trim();
  if (trimmed.length <= TITLE_MAX_LEN) return trimmed;
  return `${trimmed.slice(0, TITLE_MAX_LEN - 1).trimEnd()}…`;
}

function isValidTurns(turns) {
  return (
    Array.isArray(turns) &&
    turns.length > 0 &&
    turns.every(
      (t) =>
        t &&
        (t.role === "user" || t.role === "assistant") &&
        typeof t.content === "string" &&
        t.content.trim().length > 0,
    )
  );
}

// POST /api/buyer-conversations — { conversationId?, turns }
// Upsert, not append: the frontend (SearchHome.tsx) sends its FULL current
// turns array after every completed exchange — simpler and more robust
// than an incremental "append just this turn" endpoint (a dropped request
// mid-conversation can't leave the stored copy silently missing a turn
// forever; the next successful save just re-sends everything and overwrites
// it). `conversationId` absent (or not this buyer's own) creates a new
// thread instead of erroring — a buyer can't "lose" their conversation to
// a stale/wrong id, it just starts a fresh one.
export async function upsertConversation(req, res, next) {
  try {
    const { conversationId, turns } = req.body;
    if (!isValidTurns(turns)) {
      return next(new AppError("A non-empty turns array is required", 400));
    }
    const trimmedTurns = turns.slice(-MAX_STORED_TURNS);

    let conversation = null;
    if (conversationId) {
      conversation = await BuyerConversation.findOne({
        _id: conversationId,
        buyerId: req.buyer.buyerId,
      });
    }

    if (conversation) {
      conversation.turns = trimmedTurns;
      conversation.lastMessageAt = new Date();
      await conversation.save();
    } else {
      const firstUserTurn = turns.find((t) => t.role === "user");
      conversation = await BuyerConversation.create({
        buyerId: req.buyer.buyerId,
        title: truncateTitle(firstUserTurn?.content ?? "New chat"),
        turns: trimmedTurns,
        lastMessageAt: new Date(),
      });
    }

    res.status(200).json({
      success: true,
      data: {
        conversation: {
          id: conversation._id,
          title: conversation.title,
          lastMessageAt: conversation.lastMessageAt,
        },
      },
    });
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(err.message, 500));
  }
}

// GET /api/buyer-conversations — the "Recent" list. Deliberately excludes
// `turns` (a list item only ever needs its title/timestamp) — full content
// is a separate fetch (getConversation), only paid for when a buyer
// actually opens one.
export async function listConversations(req, res, next) {
  try {
    const conversations = await BuyerConversation.find({
      buyerId: req.buyer.buyerId,
    })
      .select("title lastMessageAt createdAt")
      .sort({ lastMessageAt: -1 })
      .limit(30);
    res.status(200).json({ success: true, data: { conversations } });
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(err.message, 500));
  }
}

// GET /api/buyer-conversations/:id
export async function getConversation(req, res, next) {
  try {
    const conversation = await BuyerConversation.findOne({
      _id: req.params.id,
      buyerId: req.buyer.buyerId,
    });
    if (!conversation) {
      return next(new AppError("Conversation not found", 404));
    }
    res.status(200).json({ success: true, data: { conversation } });
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(err.message, 500));
  }
}

// DELETE /api/buyer-conversations/:id
export async function deleteConversation(req, res, next) {
  try {
    const result = await BuyerConversation.deleteOne({
      _id: req.params.id,
      buyerId: req.buyer.buyerId,
    });
    if (result.deletedCount === 0) {
      return next(new AppError("Conversation not found", 404));
    }
    res.status(200).json({ success: true, data: { message: "Deleted." } });
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(err.message, 500));
  }
}
