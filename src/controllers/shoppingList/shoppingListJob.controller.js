import ShoppingListJob from "../../models/ShoppingListJob.model.js";
import { AppError } from "../../middleware/errorHandler.js";

// Shopping Lists (2026-09-12, widened 2026-09-17 to buyer OR vendor —
// explicit product direction: "what buyer can do, vendor can do"): an
// account may create, read, and PATCH a recommendation onto their OWN jobs,
// never anyone else's. `resolveActor` is mounted on these routes the same
// way notifications.routes.js's own comment explains. The 2026-09-12 note
// that a vendor "has no such thing to spend" no longer holds — Credits is
// already keyed generically on `(ownerId, ownerType)` (see
// credits.controller.js), so a vendor's own balance bills exactly the same
// way a buyer's does; see the job sweep's own advanceOneItem for the charge.

function toClientShape(job) {
  return {
    id: job._id.toString(),
    goalText: job.goalText,
    status: job.status,
    budgetNaira: job.budgetNaira ?? null,
    totalItems: job.totalItems,
    nextItemIndex: job.nextItemIndex,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    items: job.items.map((item) => ({
      id: item._id.toString(),
      order: item.order,
      label: item.label,
      category: item.category,
      quantity: item.quantity,
      estimatedPriceNaira: item.estimatedPriceNaira,
      fairPriceMinNaira: item.fairPriceMinNaira,
      fairPriceMaxNaira: item.fairPriceMaxNaira,
      notes: item.notes,
      status: item.status,
      velteResults: item.velteResults,
      externalOffers: item.externalOffers,
      recommendation: item.recommendation,
    })),
  };
}

// Lighter than toClientShape — the "My Shopping Lists" index page (spec
// §20) needs a card's worth per job, never every item's full velteResults/
// externalOffers arrays, which can each carry several full VendorMatch/
// ExternalOffer objects (photos, descriptions, ...) and would make a list
// of a dozen jobs a genuinely heavy response for no reason.
function toSummaryShape(job) {
  const estimatedTotalNaira = job.items.reduce(
    (sum, item) => sum + item.estimatedPriceNaira * item.quantity,
    0,
  );
  const categoryCount = new Set(job.items.map((i) => i.category)).size;
  const foundCount = job.items.filter(
    (i) => i.status === "found_velte" || i.status === "found_external",
  ).length;
  const selectedCount = job.items.filter((i) => i.recommendation).length;
  return {
    id: job._id.toString(),
    goalText: job.goalText,
    status: job.status,
    budgetNaira: job.budgetNaira ?? null,
    estimatedTotalNaira,
    totalItems: job.totalItems,
    categoryCount,
    foundCount,
    selectedCount,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

// Either identity works now (2026-09-17). Returns the filter to scope a job
// query/create by, and the two id fields split out for building a new
// document — exactly one of `buyerId`/`vendorId` is ever non-null, same
// precedence every dual-identity caller in this codebase uses (buyer wins
// when both cookies exist, decided upstream by resolveActor itself).
function requireOwner(req) {
  if (!req.actor || (req.actor.type !== "buyer" && req.actor.type !== "vendor")) {
    throw new AppError("Sign in to use Shopping Lists.", 401);
  }
  const isBuyer = req.actor.type === "buyer";
  return {
    ownerId: req.actor.id,
    ownerType: req.actor.type,
    buyerId: isBuyer ? req.actor.id : null,
    vendorId: isBuyer ? null : req.actor.id,
    filter: isBuyer ? { buyerId: req.actor.id } : { vendorId: req.actor.id },
  };
}

// ── POST /api/shopping-list-jobs ─────────────────────────────────────────
//
// Idempotent on `clientRef` (spec §34): a double-click on "Get these items"
// sends the same clientRef and gets the SAME job back rather than starting
// a duplicate — checked first (the common case, no race), then re-checked
// on a duplicate-key error (the rare simultaneous-click race), rather than
// relying on either alone.
export async function createShoppingListJob(req, res, next) {
  try {
    const owner = requireOwner(req);
    const { goalText, items, conversationId, deviceId, clientRef, budgetNaira } =
      req.body ?? {};

    if (!goalText || !Array.isArray(items) || !items.length || !clientRef) {
      throw new AppError(
        "goalText, items and clientRef are required.",
        400,
      );
    }

    const existing = await ShoppingListJob.findOne({
      clientRef,
      ...owner.filter,
    });
    if (existing) {
      return res.json({ success: true, data: { job: toClientShape(existing), reused: true } });
    }

    const doc = {
      buyerId: owner.buyerId,
      vendorId: owner.vendorId,
      conversationId: conversationId ?? null,
      deviceId: deviceId ?? null,
      goalText,
      clientRef,
      budgetNaira:
        Number.isFinite(budgetNaira) && budgetNaira > 0
          ? Math.round(budgetNaira)
          : null,
      totalItems: items.length,
      items: items.map((item, index) => ({
        order: index,
        label: String(item?.label ?? "").slice(0, 120),
        category: String(item?.category ?? "General").slice(0, 60),
        quantity:
          Number.isFinite(item?.quantity) && item.quantity >= 1
            ? Math.round(item.quantity)
            : 1,
        estimatedPriceNaira: Math.max(0, Number(item?.estimatedPriceNaira) || 0),
        fairPriceMinNaira: Math.max(0, Number(item?.fairPriceMinNaira) || 0),
        fairPriceMaxNaira: Math.max(0, Number(item?.fairPriceMaxNaira) || 0),
        notes: item?.notes ? String(item.notes).slice(0, 200) : null,
      })),
    };

    let job;
    try {
      job = await ShoppingListJob.create(doc);
    } catch (err) {
      // The rare simultaneous-click race — the unique index on clientRef
      // caught what the findOne above (run a moment earlier) couldn't.
      if (err?.code === 11000) {
        const raced = await ShoppingListJob.findOne({
          clientRef,
          ...owner.filter,
        });
        if (raced) {
          return res.json({
            success: true,
            data: { job: toClientShape(raced), reused: true },
          });
        }
      }
      throw err;
    }

    return res.json({ success: true, data: { job: toClientShape(job) } });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/shopping-list-jobs ──────────────────────────────────────────
//
// "My Shopping Lists" (spec §20) — every job this buyer OR vendor has ever
// started, newest first. Summary shape only (see toSummaryShape) — the
// detail page (GET /:id) is what loads a single job's full item/result data.
const LIST_PAGE_SIZE = 30;

export async function listShoppingListJobs(req, res, next) {
  try {
    const owner = requireOwner(req);
    const jobs = await ShoppingListJob.find(owner.filter)
      .sort({ createdAt: -1 })
      .limit(LIST_PAGE_SIZE);
    return res.json({
      success: true,
      data: { jobs: jobs.map(toSummaryShape) },
    });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/shopping-list-jobs/:id ──────────────────────────────────────
export async function getShoppingListJob(req, res, next) {
  try {
    const owner = requireOwner(req);
    const job = await ShoppingListJob.findOne({
      _id: req.params.id,
      ...owner.filter,
    });
    if (!job) throw new AppError("Shopping list not found.", 404);
    return res.json({ success: true, data: { job: toClientShape(job) } });
  } catch (err) {
    next(err);
  }
}

// ── PATCH /api/shopping-list-jobs/:id/items/:itemId/recommendation ──────
//
// The one write this API exposes beyond creation — persists a computed
// "best option" pick (spec §17-19) onto one item. Never accepts a raw
// recommendation shape without checking the item belongs to this account's
// own job first.
export async function setItemRecommendation(req, res, next) {
  try {
    const owner = requireOwner(req);
    const { recommendation } = req.body ?? {};
    const job = await ShoppingListJob.findOne({
      _id: req.params.id,
      ...owner.filter,
    });
    if (!job) throw new AppError("Shopping list not found.", 404);
    const item = job.items.id(req.params.itemId);
    if (!item) throw new AppError("Item not found on this list.", 404);
    item.recommendation = recommendation ?? null;
    await job.save();
    return res.json({ success: true, data: { job: toClientShape(job) } });
  } catch (err) {
    next(err);
  }
}
