import Usage from "../../models/Usage.model.js";
import Buyer from "../../models/Buyer.model.js";
import { AppError } from "../../middleware/errorHandler.js";
import { effectivePlanId } from "../../config/buyerPlans.js";

// AI-search metering for any signed-in account (2026-08-29).
//
// Replaces the buyer-only version. See models/Usage.model.js for why the
// counters moved off the Buyer document, and middleware/resolveActor.js for
// how a vendor and a buyer both get here.
//
// THE QUOTAS ARE PASSED IN, the tier is resolved HERE. The plan table lives
// in the frontend (src/lib/server/ai/plans.ts), because that is where the
// gate, the messaging and any pricing UI all read from, and one table that
// can never disagree with itself beats two that drift. The caller sends every
// tier's allowance; this file decides which row applies, from data the caller
// cannot influence:
//
//   buyer  → their own stored plan, expiry-resolved (effectivePlanId)
//   vendor → the `vendor` entry the caller supplies, falling back to `free`
//
// A vendor has no buyer plan to be on. They get an allowance because they are
// a known, paying account rather than a stranger — not because they bought a
// buyer subscription, which is why the wording downstream never offers them
// one.

const KINDS = new Set(["text", "photo"]);

/** The tier this actor is metered at. */
async function planForActor(actor, limits) {
  if (actor.type === "vendor") {
    // `limits.vendor` when the caller defines one, else the free row — a
    // vendor is never left unmetered by a caller that forgot the key.
    return Number.isInteger(limits.vendor) ? "vendor" : "free";
  }
  const buyer = await Buyer.findById(actor.id)
    .select("plan planExpiresAt")
    .lean();
  if (!buyer) throw new AppError("Account not found.", 404);
  return effectivePlanId(buyer);
}

// ── POST /api/usage/consume ──────────────────────────────────────────────
//
// Body: { kind: "text" | "photo",
//         limits: { free: 10, plus: 100, business: 400, vendor: 10 },
//         periodKey: "YYYY-MM" }
// 200:  { success, data: { allowed, used, limit, plan, ownerType, periodKey } }
//
// `allowed: false` is a normal outcome — a spent quota, not an error — so it
// returns 200 with the counts. The caller needs them either way to tell the
// account holder where they stand.
export async function consumeSearch(req, res, next) {
  try {
    const { kind, limits, periodKey } = req.body ?? {};

    if (!KINDS.has(kind)) {
      throw new AppError("kind must be 'text' or 'photo'.", 400);
    }
    if (!limits || typeof limits !== "object" || Array.isArray(limits)) {
      throw new AppError("limits must be an object of plan → quota.", 400);
    }
    for (const value of Object.values(limits)) {
      if (!Number.isInteger(value) || value < 0) {
        throw new AppError("every limit must be a non-negative integer.", 400);
      }
    }
    if (!Number.isInteger(limits.free)) {
      throw new AppError("limits must include a 'free' fallback.", 400);
    }
    if (typeof periodKey !== "string" || !/^\d{4}-\d{2}$/.test(periodKey)) {
      throw new AppError("periodKey must look like '2026-08'.", 400);
    }
    if (!req.actor) {
      throw new AppError("Not authenticated.", 401);
    }

    const { id: ownerId, type: ownerType } = req.actor;
    const plan = await planForActor(req.actor, limits);
    const limit = Number.isInteger(limits[plan]) ? limits[plan] : limits.free;
    const field = kind;

    // Zero means the feature is off for this tier entirely — nothing to
    // increment, and a different message downstream from "used them all".
    if (limit === 0) {
      return res.json({
        success: true,
        data: { allowed: false, used: 0, limit, plan, ownerType, periodKey },
      });
    }

    // Step 1a — make sure a row exists at all. Filtered on the owner ALONE,
    // so an existing row simply matches and `$setOnInsert` does nothing.
    // (Combining this with the rollover below into one upsert looked tidier
    // but was wrong: a filter of `periodKey != current` never matches a row
    // already on the current period, so every ordinary request would attempt
    // an insert and take a duplicate-key error off the unique index.)
    await Usage.updateOne(
      { ownerId, ownerType },
      { $setOnInsert: { periodKey, text: 0, photo: 0 } },
      { upsert: true },
    ).catch((err) => {
      // Two first-ever searches landing in the same instant: one inserts,
      // the other gets 11000, and the row exists either way — which is the
      // outcome wanted. Anything else is a real error.
      if (err?.code !== 11000) throw err;
    });

    // Step 1b — roll the period over if the counters belong to a past month.
    // A no-op on the overwhelming majority of requests, and scoping it on
    // `periodKey != current` means two concurrent requests at a month
    // boundary can't both reset after the other has already incremented:
    // whichever lands second matches nothing and does nothing.
    await Usage.updateOne(
      { ownerId, ownerType, periodKey: { $ne: periodKey } },
      { $set: { periodKey, text: 0, photo: 0 } },
    );

    // Step 2 — increment only if there is room. The `$lt: limit` sits in the
    // FILTER, so the check and the write are one document-level operation and
    // the quota can never be exceeded by two requests racing. A null result
    // means no room left.
    const updated = await Usage.findOneAndUpdate(
      { ownerId, ownerType, periodKey, [field]: { $lt: limit } },
      { $inc: { [field]: 1 } },
      { new: true },
    ).lean();

    if (updated) {
      return res.json({
        success: true,
        data: {
          allowed: true,
          used: updated[kind] ?? 0,
          limit,
          plan,
          ownerType,
          periodKey,
        },
      });
    }

    const current = await Usage.findOne({ ownerId, ownerType })
      .lean()
      .catch(() => null);

    return res.json({
      success: true,
      data: {
        allowed: false,
        // A row that vanished mid-request reports the limit as spent, which
        // fails closed on a path that cannot realistically matter.
        used: current?.[kind] ?? limit,
        limit,
        plan,
        ownerType,
        periodKey,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/usage ───────────────────────────────────────────────────────
//
// Read-only: what this account has spent this period, for a usage meter.
// Never increments, so it is safe to poll and safe to call on render.
export async function getUsage(req, res, next) {
  try {
    if (!req.actor) throw new AppError("Not authenticated.", 401);
    const { id: ownerId, type: ownerType } = req.actor;

    const row = await Usage.findOne({ ownerId, ownerType }).lean();

    let plan = "vendor";
    if (ownerType === "buyer") {
      const buyer = await Buyer.findById(ownerId)
        .select("plan planExpiresAt")
        .lean();
      plan = buyer ? effectivePlanId(buyer) : "free";
    }

    return res.json({
      success: true,
      data: {
        plan,
        ownerType,
        // Counters from a previous month are stale, not current — reporting
        // them would show an account as used-up on the 1st. They read as zero
        // here and are physically reset by the next consume.
        periodKey: row?.periodKey ?? null,
        text: row?.text ?? 0,
        photo: row?.photo ?? 0,
      },
    });
  } catch (err) {
    next(err);
  }
}
