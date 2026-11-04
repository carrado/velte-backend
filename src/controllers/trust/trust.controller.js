import { AppError } from "../../middleware/errorHandler.js";
import Review from "../../models/Review.model.js";
import VendorValidation from "../../models/VendorValidation.model.js";
import PlatformDispute from "../../models/PlatformDispute.model.js";
import Order from "../../models/Order.model.js";
import SavedSearch from "../../models/SavedSearch.model.js";
import CommunityPost from "../../models/CommunityPost.model.js";
import Wallet from "../../models/Wallet.model.js";
import { resolveTier } from "../../services/tier.service.js";
import { can } from "../../config/entitlements.js";

async function tierOf(req) {
  return resolveTier(req.actor);
}

function isVendorKind(kind) {
  return kind !== "product";
}

export async function createReview(req, res, next) {
  try {
    if (req.actor?.type !== "buyer") throw new AppError("Sign in as a buyer.", 401);

    const rating = Number(req.body?.rating);
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new AppError("Choose a rating from 1 to 5.", 400);
    }

    const kind = req.body?.kind === "product" ? "product" : "vendor";
    const capability = kind === "product" ? "review_product" : "review_vendor";
    const tier = await tierOf(req);
    if (!can(tier, capability)) {
      throw new AppError("Sign in as a buyer to leave a review.", 403, {
        code: "upgrade_required",
        capability,
      });
    }

    const order = await Order.findById(req.body?.orderId);
    if (!order || String(order.buyerId) !== String(req.actor.id)) {
      throw new AppError("Order not found.", 404);
    }
    if (order.status !== "received" && order.status !== "confirmed") {
      throw new AppError("Review an order after you've confirmed it.", 409);
    }

    let productId = null;
    if (kind === "product") {
      const rawId = req.body?.productId;
      if (!rawId) throw new AppError("Pick the product you ordered.", 400);
      const line = (order.items || []).find(
        (item) => String(item.productId) === String(rawId),
      );
      if (!line) {
        throw new AppError("That product was not on this order.", 400);
      }
      productId = line.productId;
    }

    const review = await Review.create({
      buyerId: req.actor.id,
      vendorId: order.vendorId,
      orderId: order._id,
      kind,
      productId,
      rating,
      text,
    });
    res.json({
      success: true,
      data: {
        id: String(review._id),
        kind: review.kind,
        productId: productId ? String(productId) : null,
      },
    });
  } catch (err) {
    if (err?.code === 11000) {
      return next(
        new AppError(
          isVendorKind(req.body?.kind)
            ? "You've already reviewed this vendor for that order."
            : "You've already reviewed that product for this order.",
          409,
        ),
      );
    }
    next(err);
  }
}

export async function replyToReview(req, res, next) {
  try {
    const vendorId = req.user?.userId;
    if (!vendorId) throw new AppError("Not authenticated.", 401);
    const reply = typeof req.body?.reply === "string" ? req.body.reply.trim() : "";
    if (reply.length < 1) throw new AppError("Write a reply.", 400);
    const review = await Review.findOne({ _id: req.params.id, vendorId });
    if (!review) throw new AppError("Review not found.", 404);
    review.reply = reply;
    review.repliedAt = new Date();
    await review.save();
    res.json({ success: true, data: { id: String(review._id) } });
  } catch (err) {
    next(err);
  }
}

export async function listVendorReviews(req, res, next) {
  try {
    const rows = await Review.find({
      vendorId: req.params.vendorId,
      $or: [{ kind: "vendor" }, { kind: { $exists: false } }],
    })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();
    res.json({
      success: true,
      data: {
        reviews: rows.map((row) => ({
          id: String(row._id),
          kind: "vendor",
          rating: row.rating,
          text: row.text,
          reply: row.reply,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function createValidation(req, res, next) {
  try {
    if (req.actor?.type !== "buyer") throw new AppError("Sign in as a buyer.", 401);
    const tier = await tierOf(req);
    if (!can(tier, "validate_vendor")) {
      throw new AppError("Vendor checks are part of Buyer Premium.", 403, {
        code: "upgrade_required",
        capability: "validate_vendor",
      });
    }
    const row = await VendorValidation.create({
      buyerId: req.actor.id,
      vendorId: req.body?.vendorId,
      visited: Boolean(req.body?.visited),
      stockSeen: Boolean(req.body?.stockSeen),
      addressMatched: Boolean(req.body?.addressMatched),
      note: typeof req.body?.note === "string" ? req.body.note.slice(0, 400) : "",
    });
    res.json({ success: true, data: { id: String(row._id) } });
  } catch (err) {
    next(err);
  }
}

export async function openDispute(req, res, next) {
  try {
    if (!req.actor) throw new AppError("Not authenticated.", 401);
    const detail = typeof req.body?.detail === "string" ? req.body.detail.trim() : "";
    if (detail.length < 8) throw new AppError("Describe what happened.", 400);
    const row = await PlatformDispute.create({
      openerId: req.actor.id,
      openerType: req.actor.type,
      vendorId: req.body?.vendorId,
      detail,
    });
    res.json({ success: true, data: { id: String(row._id), status: "open" } });
  } catch (err) {
    next(err);
  }
}

export async function saveSearch(req, res, next) {
  try {
    if (req.actor?.type !== "buyer") throw new AppError("Sign in as a buyer.", 401);
    const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
    if (query.length < 2) throw new AppError("Enter what you want to keep.", 400);
    await SavedSearch.updateOne(
      { buyerId: req.actor.id, query },
      { $setOnInsert: { buyerId: req.actor.id, query } },
      { upsert: true },
    );
    res.json({ success: true, data: { saved: true } });
  } catch (err) {
    next(err);
  }
}

export async function listSavedSearches(req, res, next) {
  try {
    if (req.actor?.type !== "buyer") throw new AppError("Sign in as a buyer.", 401);
    const rows = await SavedSearch.find({ buyerId: req.actor.id })
      .sort({ createdAt: -1 })
      .limit(30)
      .lean();
    res.json({
      success: true,
      data: { searches: rows.map((row) => ({ id: String(row._id), query: row.query })) },
    });
  } catch (err) {
    next(err);
  }
}

export async function listCommunity(req, res, next) {
  try {
    const rows = await CommunityPost.find({ reported: false })
      .sort({ createdAt: -1 })
      .limit(40)
      .lean();
    res.json({
      success: true,
      data: {
        posts: rows.map((row) => ({
          id: String(row._id),
          body: row.body,
          mine: req.actor && String(row.authorId) === String(req.actor.id),
        })),
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function postCommunity(req, res, next) {
  try {
    if (!req.actor) throw new AppError("Not authenticated.", 401);
    const tier = await tierOf(req);
    if (tier !== "buyer_premium" && tier !== "vendor_enterprise") {
      throw new AppError("Community is part of a paid plan.", 403, {
        code: "upgrade_required",
        capability: "gigs",
      });
    }
    const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
    if (body.length < 2) throw new AppError("Write a message.", 400);
    const since = new Date(Date.now() - 60 * 60 * 1000);
    const recent = await CommunityPost.countDocuments({
      authorId: req.actor.id,
      createdAt: { $gte: since },
    });
    if (recent >= 10) throw new AppError("Slow down — ten messages an hour.", 429);
    const row = await CommunityPost.create({
      authorId: req.actor.id,
      authorType: req.actor.type,
      body,
    });
    res.json({ success: true, data: { id: String(row._id) } });
  } catch (err) {
    next(err);
  }
}

export async function reportCommunity(req, res, next) {
  try {
    if (!req.actor) throw new AppError("Not authenticated.", 401);
    await CommunityPost.updateOne({ _id: req.params.id }, { $set: { reported: true } });
    res.json({ success: true, data: { reported: true } });
  } catch (err) {
    next(err);
  }
}

export async function finops(req, res, next) {
  try {
    const vendorId = req.user?.userId;
    if (!vendorId) throw new AppError("Not authenticated.", 401);
    const wallet = await Wallet.findOne({ vendorId }).select("balanceKobo").lean();
    res.json({
      success: true,
      data: {
        walletBalanceKobo: wallet?.balanceKobo ?? 0,
        note: "A report of money already on Velte. It does not move funds.",
      },
    });
  } catch (err) {
    next(err);
  }
}
