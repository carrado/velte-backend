import ShoppingPlan from "../../models/ShoppingPlan.model.js";
import { AppError } from "../../middleware/errorHandler.js";

// Shopping Plan (2026-09-18) — an account may create, read and list their
// OWN plans, never anyone else's. `resolveActor` is mounted on these
// routes the same way notifications.routes.js's own comment explains;
// either identity works, same as the deleted ShoppingListJob's own
// widened-to-buyer-or-vendor precedent.

/** Spread onto `nextMonitorAt` once at creation, and preserved (never
 *  re-rolled) on every later advance — this is the whole "don't run every
 *  plan's daily job at the same clock time" story: plans naturally land at
 *  different times of day just from being created at different moments,
 *  and this adds up to an hour of further spread on top so a burst of
 *  plans created in the same minute doesn't all wake the sweep together. */
const MAX_JITTER_MS = 60 * 60 * 1000;

function randomJitterMs() {
  return Math.floor(Math.random() * MAX_JITTER_MS);
}

function requireOwner(req) {
  if (!req.actor || (req.actor.type !== "buyer" && req.actor.type !== "vendor")) {
    throw new AppError("Sign in to use Shopping Plans.", 401);
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

function latestPrice(candidate) {
  return candidate.priceHistory.length
    ? candidate.priceHistory[candidate.priceHistory.length - 1].priceNaira
    : null;
}

// Phase 3 (2026-09-19) — a `removed` item ("I don't need sportswear
// anymore") drops out of every total below, same as it does in
// shoppingPlan.job.js's own activeItems (see that file's comment on why
// this is a flag, not a splice).
function activeItems(plan) {
  return plan.items.filter((item) => !item.removed);
}

// budgetNaira (stated target) and estimatedTotalNaira are the "planning"
// half of spec §8's four values; spentTotalNaira is the other half — only
// what's ACTUALLY been bought (spec §28's "real user action, not merely
// options found"). The third value spec §8 originally asked for,
// selectedTotalNaira (the buyer's own picks, bought or not), was removed
// 2026-09-20 along with `selectedCandidateId` itself — see the model's own
// comment on candidateSchema.purchased for why.
//
// `purchased` now lives on the CANDIDATE, not the item — at most one
// candidate per item is ever purchased (markItemPurchased enforces this),
// so a plain find is enough; there's no need to sum across candidates the
// way estimatedTotalNaira sums across possibilities.
function purchasedCandidate(item) {
  return item.candidates.find((c) => c.purchased) ?? null;
}

function spentTotalNaira(plan) {
  return activeItems(plan).reduce((sum, item) => {
    const purchased = purchasedCandidate(item);
    return sum + (purchased ? (purchased.purchasedPriceNaira ?? 0) : 0);
  }, 0);
}

// Sums only what's actually been FOUND by a real search — an item with no
// candidate yet contributes 0, never a model-invented placeholder (removed
// 2026-09-19; `item.estimatedPriceNaira` stays 0 on every item now — see
// the model's own comment). A buyer reading this total before the first
// monitoring cycle lands (near-immediate, but not synchronous — see
// createShoppingPlan's own nextMonitorAt) sees an undercount rather than a
// confident-but-fake number; `toSummaryShape`'s own foundCount/totalItems is
// what tells them how much of the total is actually priced in yet.
function estimatedTotalNaira(plan) {
  return activeItems(plan).reduce((sum, item) => {
    // A purchased candidate's own frozen price wins outright — what was
    // actually paid is a more real number than "cheapest still available"
    // once a purchase has actually happened, and the two would otherwise
    // disagree the moment the purchased listing's price moves again.
    const purchased = purchasedCandidate(item);
    if (purchased) {
      return sum + (purchased.purchasedPriceNaira ?? 0) * item.quantity;
    }
    let cheapest = null;
    for (const c of item.candidates) {
      const available = c.availabilityHistory.length
        ? c.availabilityHistory[c.availabilityHistory.length - 1].available
        : true;
      if (!available) continue;
      const price = latestPrice(c);
      if (price != null && (cheapest == null || price < cheapest)) cheapest = price;
    }
    return sum + (cheapest ?? 0) * item.quantity;
  }, 0);
}

function toClientShape(plan) {
  return {
    id: plan._id.toString(),
    goalText: plan.goalText,
    deadlineDate: plan.deadlineDate,
    budgetNaira: plan.budgetNaira ?? null,
    estimatedTotalNaira: estimatedTotalNaira(plan),
    spentTotalNaira: spentTotalNaira(plan),
    status: plan.status,
    nextMonitorAt: plan.nextMonitorAt,
    lastMonitoredAt: plan.lastMonitoredAt,
    lastCycle: plan.lastCycle ?? null,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    items: plan.items.map((item) => ({
      id: item._id.toString(),
      order: item.order,
      label: item.label,
      category: item.category,
      quantity: item.quantity,
      priority: item.priority,
      estimatedPriceNaira: item.estimatedPriceNaira,
      fairPriceMinNaira: item.fairPriceMinNaira,
      fairPriceMaxNaira: item.fairPriceMaxNaira,
      notes: item.notes,
      status: item.status,
      lastCheckedAt: item.lastCheckedAt,
      removed: item.removed,
      candidates: item.candidates.map((c) => ({
        id: c._id.toString(),
        source: c.source,
        snapshot: c.snapshot,
        firstDiscoveredAt: c.firstDiscoveredAt,
        lastCheckedAt: c.lastCheckedAt,
        priceHistory: c.priceHistory,
        availabilityHistory: c.availabilityHistory,
        purchased: c.purchased,
        purchasedPriceNaira: c.purchasedPriceNaira ?? null,
      })),
    })),
  };
}

// Lighter than toClientShape — the Shopping Plans index page needs a
// card's worth per plan (spec §4), never every item's full candidate
// snapshots, which would make a list of several plans a heavy response
// for no reason (same restraint ShoppingListJob's own toSummaryShape took).
function toSummaryShape(plan) {
  const active = activeItems(plan);
  const foundCount = active.filter((i) => i.status === "found").length;
  return {
    id: plan._id.toString(),
    goalText: plan.goalText,
    deadlineDate: plan.deadlineDate,
    budgetNaira: plan.budgetNaira ?? null,
    estimatedTotalNaira: estimatedTotalNaira(plan),
    spentTotalNaira: spentTotalNaira(plan),
    status: plan.status,
    totalItems: active.length,
    foundCount,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

// ── POST /api/shopping-plans ──────────────────────────────────────────────
//
// Idempotent on `clientRef`: a double-submit of the same chat turn finds
// this plan already created rather than starting a duplicate — checked
// first (the common case), then re-checked on a duplicate-key error (the
// rare simultaneous-request race), same two-step ShoppingListJob's own
// createShoppingListJob followed.
export async function createShoppingPlan(req, res, next) {
  try {
    const owner = requireOwner(req);
    const {
      goalText,
      items,
      deadlineDate,
      budgetNaira,
      conversationId,
      deviceId,
      clientRef,
      location,
    } = req.body ?? {};

    if (!goalText || !Array.isArray(items) || !items.length || !clientRef) {
      throw new AppError("goalText, items and clientRef are required.", 400);
    }
    const parsedDeadline = new Date(deadlineDate);
    if (!deadlineDate || Number.isNaN(parsedDeadline.getTime())) {
      throw new AppError("A valid deadlineDate is required.", 400);
    }
    // Required (2026-09-19, explicit product direction) — Velte never
    // estimates a price of its own any more (buildShoppingPlanSnapshot.ts
    // no longer asks the model for one), so a plan with no real budget has
    // nothing for the real, searched prices to be checked against later
    // (see shoppingPlan.job.js's own budgetStatusFor). route.ts's own
    // budget-ask gate is what guarantees this is always sent by the time a
    // buyer reaches this endpoint; enforced here too since this is the one
    // place that actually writes the record.
    if (!Number.isFinite(budgetNaira) || budgetNaira <= 0) {
      throw new AppError("A budgetNaira greater than 0 is required.", 400);
    }

    const existing = await ShoppingPlan.findOne({ clientRef, ...owner.filter });
    if (existing) {
      return res.json({ success: true, data: { plan: toClientShape(existing), reused: true } });
    }

    const jitterMs = randomJitterMs();
    const now = new Date();

    const doc = {
      buyerId: owner.buyerId,
      vendorId: owner.vendorId,
      conversationId: conversationId ?? null,
      deviceId: deviceId ?? null,
      clientRef,
      goalText,
      deadlineDate: parsedDeadline,
      budgetNaira:
        Number.isFinite(budgetNaira) && budgetNaira > 0 ? Math.round(budgetNaira) : null,
      jitterMs,
      // Almost immediate (2026-09-19, was `now + 24h + jitterMs`) — a buyer
      // just told Velte "search, then match what you find against my
      // budget," and the old value meant the FIRST real search didn't run
      // for up to a day, during which the plan showed nothing but "waiting
      // to search" with no invented number to fill the gap any more (the
      // model no longer estimates a price at creation — see
      // buildShoppingPlanSnapshot.ts). `jitterMs` (up to 1h) is kept rather
      // than zeroed — it's still what spreads a burst of same-minute plans
      // across the sweep instead of waking it for all of them at once; the
      // sweep's own 5-minute tick (shoppingPlan.job.js's TICK_MS) picks this
      // up on the very next pass either way.
      nextMonitorAt: new Date(now.getTime() + jitterMs),
      location: location
        ? {
            lat: Number.isFinite(location.lat) ? location.lat : null,
            lng: Number.isFinite(location.lng) ? location.lng : null,
            area: location.area ?? null,
            state: location.state ?? null,
          }
        : undefined,
      items: items.map((item, index) => ({
        order: index,
        label: String(item?.label ?? "").slice(0, 120),
        category: String(item?.category ?? "General").slice(0, 60),
        quantity:
          Number.isFinite(item?.quantity) && item.quantity >= 1
            ? Math.round(item.quantity)
            : 1,
        priority: Number.isFinite(item?.priority) ? item.priority : items.length - index,
        estimatedPriceNaira: Math.max(0, Number(item?.estimatedPriceNaira) || 0),
        fairPriceMinNaira: Math.max(0, Number(item?.fairPriceMinNaira) || 0),
        fairPriceMaxNaira: Math.max(0, Number(item?.fairPriceMaxNaira) || 0),
        notes: item?.notes ? String(item.notes).slice(0, 200) : null,
      })),
    };

    let plan;
    try {
      plan = await ShoppingPlan.create(doc);
    } catch (err) {
      // The rare simultaneous-request race — the unique index on clientRef
      // caught what the findOne above (run a moment earlier) couldn't.
      if (err?.code === 11000) {
        const raced = await ShoppingPlan.findOne({ clientRef, ...owner.filter });
        if (raced) {
          return res.json({ success: true, data: { plan: toClientShape(raced), reused: true } });
        }
      }
      throw err;
    }

    return res.json({ success: true, data: { plan: toClientShape(plan) } });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/shopping-plans ────────────────────────────────────────────────
const LIST_PAGE_SIZE = 30;

export async function listShoppingPlans(req, res, next) {
  try {
    const owner = requireOwner(req);
    const plans = await ShoppingPlan.find(owner.filter)
      .sort({ createdAt: -1 })
      .limit(LIST_PAGE_SIZE);
    return res.json({ success: true, data: { plans: plans.map(toSummaryShape) } });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/shopping-plans/manageable ──────────────────────────────────────
//
// Phase 3 (2026-09-19) — conversational management's own context source.
// The frontend's manageShoppingPlanTool.ts needs enough of each open plan
// (which items exist, by name) to resolve "remove the school bag" to a
// real itemId — lighter than toClientShape (no candidates/history, no
// completed/cancelled/expired plans, nothing to act on there), but a level
// deeper than toSummaryShape (which has no items at all). Mounted ahead of
// GET /:id below so Express doesn't try to match "manageable" as an :id.
function toManageableShape(plan) {
  return {
    id: plan._id.toString(),
    goalText: plan.goalText,
    budgetNaira: plan.budgetNaira ?? null,
    deadlineDate: plan.deadlineDate,
    status: plan.status,
    items: activeItems(plan).map((item) => ({
      id: item._id.toString(),
      label: item.label,
      priority: item.priority,
    })),
  };
}

export async function listManageableShoppingPlans(req, res, next) {
  try {
    const owner = requireOwner(req);
    const plans = await ShoppingPlan.find({
      ...owner.filter,
      status: { $in: ["active", "monitoring", "paused"] },
    })
      .sort({ createdAt: -1 })
      .limit(LIST_PAGE_SIZE);
    return res.json({ success: true, data: { plans: plans.map(toManageableShape) } });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/shopping-plans/:id ────────────────────────────────────────────
export async function getShoppingPlan(req, res, next) {
  try {
    const owner = requireOwner(req);
    const plan = await ShoppingPlan.findOne({ _id: req.params.id, ...owner.filter });
    if (!plan) throw new AppError("Shopping plan not found.", 404);
    return res.json({ success: true, data: { plan: toClientShape(plan) } });
  } catch (err) {
    next(err);
  }
}

// ── PATCH /api/shopping-plans/:id/items/:itemId/purchase ──────────────────
//
// Marks a SPECIFIC candidate as actually bought (spec §28 — "purchasing =
// actual user progress," distinct from merely being found). Per-candidate,
// not per-item (2026-09-20, replacing this endpoint's own former
// select-then-purchase flow along with `selectItemCandidate`/
// `dismissSuggestedAlternative`, both deleted — see the model's own
// comment on candidateSchema.purchased for the reasoning): since there's
// no more standing "selected" pick to purchase, the buyer marks whichever
// listing they actually bought directly. Manual, not inferred: no
// payment-tracking integration exists anywhere in this codebase to verify
// it automatically. Freezes the price paid at the moment of marking so a
// later price move on the same listing can't retroactively change "amount
// spent." `purchased: false` un-marks it (a buyer correcting a mistake),
// clearing the frozen price along with it.
//
// At most one purchased candidate per item, enforced here rather than left
// to the caller — marking a new one purchased clears any other candidate
// on the SAME item that was previously marked, since an item can only
// really have been bought once.
export async function markItemPurchased(req, res, next) {
  try {
    const owner = requireOwner(req);
    const { candidateId, purchased } = req.body ?? {};
    if (!candidateId) throw new AppError("candidateId is required.", 400);
    const plan = await ShoppingPlan.findOne({ _id: req.params.id, ...owner.filter });
    if (!plan) throw new AppError("Shopping plan not found.", 404);
    const item = plan.items.id(req.params.itemId);
    if (!item) throw new AppError("Item not found on this plan.", 404);
    const candidate = item.candidates.id(candidateId);
    if (!candidate) throw new AppError("Candidate not found on this item.", 404);

    if (purchased) {
      for (const other of item.candidates) {
        if (other._id.toString() !== candidateId) {
          other.purchased = false;
          other.purchasedPriceNaira = null;
        }
      }
      const price = candidate.priceHistory.length
        ? candidate.priceHistory[candidate.priceHistory.length - 1].priceNaira
        : null;
      candidate.purchased = true;
      candidate.purchasedPriceNaira = price ?? item.estimatedPriceNaira;
    } else {
      candidate.purchased = false;
      candidate.purchasedPriceNaira = null;
    }

    await plan.save();
    return res.json({ success: true, data: { plan: toClientShape(plan) } });
  } catch (err) {
    next(err);
  }
}

// ── PATCH /api/shopping-plans/:id ──────────────────────────────────────────
//
// Phase 3 (2026-09-19) — conversational management (spec §23): "increase
// my budget to ₦250k", "I need everything three days earlier", "pause/
// resume/stop this plan". The buyer's own manageShoppingPlanTool.ts call
// (frontend) resolves WHICH plan and WHAT to change from a chat message;
// this endpoint is the one place that actually WRITES it — the model
// translates, this mutates the real record, never just replies
// conversationally (spec §23's own explicit requirement).
//
// `status` only ever moves between the three states a BUYER can choose —
// "paused", "monitoring" (resume) and "cancelled". "completed"/"expired"
// are system-decided (buyer progress / deadline passage) and never settable
// here; "active" is a creation-only starting state nothing transitions
// back into.
const BUYER_SETTABLE_STATUSES = new Set(["paused", "monitoring", "cancelled"]);

export async function updateShoppingPlan(req, res, next) {
  try {
    const owner = requireOwner(req);
    const { budgetNaira, deadlineDate, status, expedite } = req.body ?? {};
    const plan = await ShoppingPlan.findOne({ _id: req.params.id, ...owner.filter });
    if (!plan) throw new AppError("Shopping plan not found.", 404);

    if (budgetNaira !== undefined) {
      plan.budgetNaira =
        budgetNaira === null
          ? null
          : Number.isFinite(budgetNaira) && budgetNaira > 0
            ? Math.round(budgetNaira)
            : plan.budgetNaira;
    }

    if (deadlineDate !== undefined) {
      const parsed = new Date(deadlineDate);
      if (Number.isNaN(parsed.getTime())) {
        throw new AppError("deadlineDate must be a valid date.", 400);
      }
      // No re-check of the 7-day creation threshold here — that eligibility
      // gate only ever decides whether a NEW request becomes a plan
      // (route.ts's own concern). An existing plan keeps monitoring on
      // whatever deadline its own buyer sets it to, including one now
      // closer than 7 days away; only genuine PASSAGE of the deadline
      // (handled by the sweep's own expiry check) ends it.
      plan.deadlineDate = parsed;
    }

    if (status !== undefined) {
      if (!BUYER_SETTABLE_STATUSES.has(status)) {
        throw new AppError(
          `status must be one of: ${[...BUYER_SETTABLE_STATUSES].join(", ")}.`,
          400,
        );
      }
      if (["completed", "cancelled", "expired"].includes(plan.status)) {
        throw new AppError(`This plan is already ${plan.status} and can't be changed.`, 400);
      }
      // Resuming a paused plan wakes it on the sweep's very next tick
      // rather than leaving it dormant for up to a full adaptive interval
      // — a buyer who just asked to resume is, by definition, expecting it
      // to start working again right away.
      if (status === "monitoring" && plan.status === "paused") {
        plan.nextMonitorAt = new Date();
      }
      plan.status = status;
    }

    // "Find cheaper alternatives" / "check again now" (spec §23) — brings
    // the plan's NEXT check forward to the sweep's very next tick, same
    // trick resume already uses above, independent of any other field in
    // this request. Never runs a search inline in this request itself
    // (see manageShoppingPlanTool.ts's own header on why this stays a
    // schedule nudge rather than a synchronous search call).
    if (expedite === true && !["cancelled", "completed", "expired"].includes(plan.status)) {
      plan.nextMonitorAt = new Date();
    }

    await plan.save();
    return res.json({ success: true, data: { plan: toClientShape(plan) } });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/shopping-plans/:id/items ─────────────────────────────────────
//
// "Actually, also get me a lunch box" — a buyer adding to an existing plan
// mid-flight. No live search runs here (this endpoint is a plain, fast
// write); the new item starts "pending" and is picked up by the plan's own
// next monitoring cycle exactly like any other pending item.
export async function addPlanItem(req, res, next) {
  try {
    const owner = requireOwner(req);
    const { label, category, quantity, priority } = req.body ?? {};
    if (!label || typeof label !== "string" || !label.trim()) {
      throw new AppError("label is required.", 400);
    }
    const plan = await ShoppingPlan.findOne({ _id: req.params.id, ...owner.filter });
    if (!plan) throw new AppError("Shopping plan not found.", 404);

    plan.items.push({
      order: plan.items.length,
      label: label.trim().slice(0, 120),
      category: category ? String(category).slice(0, 60) : "General",
      quantity: Number.isFinite(quantity) && quantity >= 1 ? Math.round(quantity) : 1,
      priority: Number.isFinite(priority) ? priority : 0,
    });

    await plan.save();
    return res.json({ success: true, data: { plan: toClientShape(plan) } });
  } catch (err) {
    next(err);
  }
}

// ── PATCH /api/shopping-plans/:id/items/:itemId ────────────────────────────
//
// The other conversational item edits (spec §23): "focus on finding the
// shoes first" (priority) and "I don't need sportswear anymore" /"remove
// the expensive school bag" (removed — a soft flag, see the model's own
// comment on why this never splices the array).
export async function updatePlanItem(req, res, next) {
  try {
    const owner = requireOwner(req);
    const { priority, removed } = req.body ?? {};
    const plan = await ShoppingPlan.findOne({ _id: req.params.id, ...owner.filter });
    if (!plan) throw new AppError("Shopping plan not found.", 404);
    const item = plan.items.id(req.params.itemId);
    if (!item) throw new AppError("Item not found on this plan.", 404);

    if (priority !== undefined) {
      if (!Number.isFinite(priority)) throw new AppError("priority must be a number.", 400);
      item.priority = priority;
    }
    if (removed !== undefined) {
      item.removed = Boolean(removed);
    }

    await plan.save();
    return res.json({ success: true, data: { plan: toClientShape(plan) } });
  } catch (err) {
    next(err);
  }
}
