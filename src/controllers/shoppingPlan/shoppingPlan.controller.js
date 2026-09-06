import ShoppingPlan from "../../models/ShoppingPlan.model.js";
import { AppError } from "../../middleware/errorHandler.js";

// Shopping Plans (2026-09-06) — a buyer's budgeted, multi-category shopping
// list. See ShoppingPlan.model.js for why this is its own buyer-owned,
// cross-conversation collection rather than living on the conversation.
//
// This controller only ever PERSISTS an already-resolved plan/item — the
// actual multi-source search (Velte vendors, external marketplaces via
// Serper, kind-of-item verification) runs in the frontend repo, which is
// where those connectors and verifyMatches.ts already live. velte-backend's
// job here is the same one it plays for BuyerRequest: own the record,
// nothing more.

const MAX_CATEGORIES = 12;
const MAX_ITEMS = 40;

function isNonEmptyString(v, maxLen) {
  return typeof v === "string" && v.trim().length > 0 && v.length <= maxLen;
}

function validCategories(categories) {
  if (!Array.isArray(categories) || !categories.length) return null;
  if (categories.length > MAX_CATEGORIES) return null;
  const cleaned = [];
  for (const c of categories) {
    if (!isNonEmptyString(c?.label, 60)) return null;
    if (
      typeof c?.targetBudgetKobo !== "number" ||
      !Number.isFinite(c.targetBudgetKobo) ||
      c.targetBudgetKobo < 0
    ) {
      return null;
    }
    cleaned.push({
      label: c.label.trim(),
      targetBudgetKobo: Math.round(c.targetBudgetKobo),
    });
  }
  return cleaned;
}

// Items arrive from the frontend's own search-and-verify pipeline, so
// unlike categories these can legitimately carry a full resolved snapshot
// (source/productId/price/...) already — or none of it, for an item still
// `pending`/`no_match`. Validation here is about SHAPE, not re-deciding
// what the frontend already resolved.
function validItems(items, categoryLabels) {
  if (!Array.isArray(items) || !items.length) return null;
  if (items.length > MAX_ITEMS) return null;
  const cleaned = [];
  for (const it of items) {
    if (!isNonEmptyString(it?.label, 120)) return null;
    if (!isNonEmptyString(it?.category, 60) || !categoryLabels.has(it.category)) {
      return null;
    }
    const status = ["pending", "found", "no_match", "deferred"].includes(
      it?.status,
    )
      ? it.status
      : "pending";
    const source = it?.source === "velte" || it?.source === "external"
      ? it.source
      : null;
    cleaned.push({
      category: it.category,
      label: it.label.trim(),
      targetBudgetKobo:
        typeof it?.targetBudgetKobo === "number" &&
        Number.isFinite(it.targetBudgetKobo) &&
        it.targetBudgetKobo >= 0
          ? Math.round(it.targetBudgetKobo)
          : null,
      status,
      source,
      productId: source === "velte" ? (it.productId ?? null) : null,
      vendorId: source === "velte" ? (it.vendorId ?? null) : null,
      externalOfferId: source === "external" ? (it.externalOfferId ?? null) : null,
      name: it?.name ?? null,
      imageUrl: it?.imageUrl ?? null,
      priceKobo:
        typeof it?.priceKobo === "number" && Number.isFinite(it.priceKobo)
          ? Math.round(it.priceKobo)
          : null,
      merchant: it?.merchant ?? null,
      url: it?.url ?? null,
    });
  }
  return cleaned;
}

function toClientShape(doc) {
  return {
    id: String(doc._id),
    goalText: doc.goalText,
    totalBudgetKobo: doc.totalBudgetKobo,
    location: doc.location ?? null,
    status: doc.status,
    categories: doc.categories,
    items: doc.items.map((it) => ({ ...it, id: String(it._id) })),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

// ── POST /api/shopping-plan ─────────────────────────────────────────────────
// Created once, when the buyer confirms the checklist AND the frontend has
// finished resolving every item it can (found/no_match/deferred) — never
// mid-search, so a reopened plan is never caught half-built.
export async function createPlan(req, res, next) {
  try {
    const { goalText, totalBudgetKobo, location, categories, items } =
      req.body ?? {};

    if (!isNonEmptyString(goalText, 500)) {
      return next(new AppError("A goal description is required.", 400));
    }
    if (
      typeof totalBudgetKobo !== "number" ||
      !Number.isFinite(totalBudgetKobo) ||
      totalBudgetKobo <= 0
    ) {
      return next(new AppError("A positive total budget is required.", 400));
    }
    const cleanCategories = validCategories(categories);
    if (!cleanCategories) {
      return next(new AppError("Invalid categories.", 400));
    }
    const categoryLabels = new Set(cleanCategories.map((c) => c.label));
    const cleanItems = validItems(items, categoryLabels);
    if (!cleanItems) {
      return next(new AppError("Invalid items.", 400));
    }

    const plan = await ShoppingPlan.create({
      buyerId: req.buyer.buyerId,
      goalText: goalText.trim(),
      totalBudgetKobo: Math.round(totalBudgetKobo),
      location:
        location && typeof location === "object"
          ? {
              area: location.area ?? null,
              state: location.state ?? null,
              lat: typeof location.lat === "number" ? location.lat : null,
              lng: typeof location.lng === "number" ? location.lng : null,
            }
          : null,
      status: "active",
      categories: cleanCategories,
      items: cleanItems,
    });

    res.status(201).json({ success: true, data: { plan: toClientShape(plan) } });
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(err.message, 500));
  }
}

// ── GET /api/shopping-plan/mine ──────────────────────────────────────────────
export async function listMyPlans(req, res, next) {
  try {
    const plans = await ShoppingPlan.find({
      buyerId: req.buyer.buyerId,
      status: { $ne: "archived" },
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    res.status(200).json({
      success: true,
      data: {
        plans: plans.map((p) => ({
          id: String(p._id),
          goalText: p.goalText,
          totalBudgetKobo: p.totalBudgetKobo,
          status: p.status,
          itemCount: p.items.length,
          spentKobo: p.items.reduce((sum, it) => sum + (it.priceKobo ?? 0), 0),
          createdAt: p.createdAt,
        })),
      },
    });
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(err.message, 500));
  }
}

// ── GET /api/shopping-plan/:id ───────────────────────────────────────────────
export async function getPlan(req, res, next) {
  try {
    const plan = await ShoppingPlan.findOne({
      _id: req.params.id,
      buyerId: req.buyer.buyerId,
    }).lean();
    if (!plan) return next(new AppError("Plan not found.", 404));

    res.status(200).json({ success: true, data: { plan: toClientShape(plan) } });
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(err.message, 500));
  }
}

// ── PATCH /api/shopping-plan/:id/items/:itemId ──────────────────────────────
// Replaces ONE item's resolved selection — the v1 edit path ("get me a
// better TV"). The frontend has already re-run the search/verify/pick
// pipeline for this one item by the time this is called; this endpoint only
// writes the result down. Never touches targetBudgetKobo — a "Replace"
// swaps what was bought, not what the buyer planned to spend.
export async function replaceItem(req, res, next) {
  try {
    const { status, source, productId, vendorId, externalOfferId, name, imageUrl, priceKobo, merchant, url } =
      req.body ?? {};

    const validStatus = ["pending", "found", "no_match", "deferred"].includes(status)
      ? status
      : null;
    if (!validStatus) return next(new AppError("Invalid item status.", 400));
    const validSource = source === "velte" || source === "external" ? source : null;

    const plan = await ShoppingPlan.findOne({
      _id: req.params.id,
      buyerId: req.buyer.buyerId,
    });
    if (!plan) return next(new AppError("Plan not found.", 404));

    const item = plan.items.id(req.params.itemId);
    if (!item) return next(new AppError("Item not found.", 404));

    item.status = validStatus;
    item.source = validSource;
    item.productId = validSource === "velte" ? (productId ?? null) : null;
    item.vendorId = validSource === "velte" ? (vendorId ?? null) : null;
    item.externalOfferId = validSource === "external" ? (externalOfferId ?? null) : null;
    item.name = name ?? null;
    item.imageUrl = imageUrl ?? null;
    item.priceKobo =
      typeof priceKobo === "number" && Number.isFinite(priceKobo)
        ? Math.round(priceKobo)
        : null;
    item.merchant = merchant ?? null;
    item.url = url ?? null;

    await plan.save();

    res.status(200).json({ success: true, data: { plan: toClientShape(plan) } });
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(err.message, 500));
  }
}
