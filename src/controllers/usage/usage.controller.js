import Usage from "../../models/Usage.model.js";
import { AppError } from "../../middleware/errorHandler.js";
import { limitFor, planIdForActor } from "../../helpers/actorPlan.js";

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
//   buyer  → their own stored plan, expiry-resolved
//   vendor → their own stored plan too (2026-08-29), falling back to the
//             `vendor` entry the caller supplies when they haven't bought one
//
// A vendor without a plan still gets an allowance for being a known, paying
// account rather than a stranger. What changed is that they can now BUY a
// plan against their vendor identity instead of being told to open a second
// account — see helpers/actorPlan.js.

// Every kind that has a counter on Usage.model.js, and the two lists MUST
// stay in step. A kind missing from here is rejected with a 400 — which the
// frontend's consumeSearchQuota catches and FAILS OPEN on, so the allowance
// would silently become unlimited rather than loudly break. That failure mode
// is why this set is checked explicitly instead of trusting the schema: a
// `$inc` on a field Mongoose doesn't know about is dropped in silence too.
const KINDS = new Set(["text", "photo", "band", "brief"]);

// The counters, spelled once. Used by both the insert and the month-rollover
// reset below, which previously listed the fields inline — so adding a kind
// meant remembering three places, and forgetting one left a counter that
// never reset and an account permanently out of allowance.
const ZEROED = { text: 0, photo: 0, band: 0, brief: 0 };

// A fresh row starts every counter at zero regardless — "one-off" describes
// what happens at ROLLOVER, not what a brand-new account starts with.
function zeroedExcept(lifetimeKinds) {
  const out = {};
  for (const kind of Object.keys(ZEROED)) {
    if (!lifetimeKinds.has(kind)) out[kind] = 0;
  }
  return out;
}

// A limit of -1 means uncapped. Matches UNLIMITED in the frontend's plans.ts,
// which is the table these numbers arrive from.
const UNLIMITED = -1;

// ── POST /api/usage/consume ──────────────────────────────────────────────
//
// Body: { kind: "text" | "photo" | "band" | "brief",
//         limits: { free: 10, plus: 100, vendor: 10 },
//         lifetime: { free: ["photo","brief"], plus: [], vendor: [...] },
//         periodKey: "YYYY-MM" }
// 200:  { success, data: { allowed, used, limit, plan, ownerType, periodKey } }
//
// `allowed: false` is a normal outcome — a spent quota, not an error — so it
// returns 200 with the counts. The caller needs them either way to tell the
// account holder where they stand.
export async function consumeSearch(req, res, next) {
  try {
    const { kind, limits, lifetime, periodKey } = req.body ?? {};

    if (!KINDS.has(kind)) {
      throw new AppError(
        `kind must be one of: ${[...KINDS].join(", ")}.`,
        400,
      );
    }
    if (!limits || typeof limits !== "object" || Array.isArray(limits)) {
      throw new AppError("limits must be an object of plan → quota.", 400);
    }
    for (const value of Object.values(limits)) {
      if (!Number.isInteger(value) || (value < 0 && value !== UNLIMITED)) {
        throw new AppError(
          "every limit must be a non-negative integer, or -1 for unlimited.",
          400,
        );
      }
    }
    if (!Number.isInteger(limits.free)) {
      throw new AppError("limits must include a 'free' fallback.", 400);
    }
    if (typeof periodKey !== "string" || !/^\d{4}-\d{2}$/.test(periodKey)) {
      throw new AppError("periodKey must look like '2026-08'.", 400);
    }
    // ONE-OFF allowances (2026-08-31): `{ free: ["photo","brief"], plus: [] }`.
    // Optional, and an absent/!malformed value means "everything is monthly" —
    // i.e. exactly the behaviour before this existed. Failing open here is the
    // right direction: the harm of resetting a counter that should have
    // persisted is a buyer getting a couple of free extras, where the harm of
    // NOT resetting one that should have is an account permanently locked out
    // of an allowance it pays for every month.
    if (lifetime != null && (typeof lifetime !== "object" || Array.isArray(lifetime))) {
      throw new AppError("lifetime must be an object of plan → kinds.", 400);
    }
    if (!req.actor) {
      throw new AppError("Not authenticated.", 401);
    }

    const { id: ownerId, type: ownerType } = req.actor;
    const plan = await planIdForActor(req.actor);
    if (!plan) throw new AppError("Account not found.", 404);
    // limitFor, not a bare table lookup: for a vendor it takes the GREATER of
    // their plan's row and the vendor row, so buying a plan can never reduce
    // an allowance they already had. See helpers/actorPlan.js.
    const limit = limitFor(req.actor, limits, plan);
    const field = kind;

    // Which of THIS actor's counters survive a month rollover. Keyed on the
    // resolved plan, so a vendor on the `vendor` sentinel row picks up that
    // row's set exactly as it picks up that row's limits.
    const lifetimeKinds = new Set(
      (lifetime?.[plan] ?? []).filter((k) => KINDS.has(k)),
    );

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
      { $setOnInsert: { periodKey, ...ZEROED } },
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
    // Only the MONTHLY counters are zeroed. A one-off allowance's counter is
    // deliberately carried across the boundary — that is the whole mechanism:
    // the number in the plan table is what the account gets for its lifetime,
    // and running out means subscribing rather than waiting for the 1st.
    await Usage.updateOne(
      { ownerId, ownerType, periodKey: { $ne: periodKey } },
      { $set: { periodKey, ...zeroedExcept(lifetimeKinds) } },
    );

    // Uncapped tier: still counted (the number is worth having, and the
    // meter in the UI reads it), but with no `$lt` filter there is nothing
    // that can refuse it.
    if (limit === UNLIMITED) {
      const counted = await Usage.findOneAndUpdate(
        { ownerId, ownerType, periodKey },
        { $inc: { [field]: 1 } },
        { new: true },
      ).lean();
      return res.json({
        success: true,
        data: {
          allowed: true,
          used: counted?.[kind] ?? 0,
          limit,
          plan,
          ownerType,
          periodKey,
        },
      });
    }

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

    // Resolves a vendor's OWN plan now, not a hardcoded "vendor" — a vendor
    // who bought Velte Business must read back as being on it, or the plans
    // page would keep offering them what they just paid for.
    const plan = (await planIdForActor(req.actor)) ?? "free";

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
        band: row?.band ?? 0,
        brief: row?.brief ?? 0,
      },
    });
  } catch (err) {
    next(err);
  }
}
