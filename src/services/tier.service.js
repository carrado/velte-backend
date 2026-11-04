import PlatformSubscription from "../models/PlatformSubscription.model.js";
import Buyer from "../models/Buyer.model.js";
import { ALLOWANCES, can } from "../config/entitlements.js";
import { AppError } from "../middleware/errorHandler.js";

// Turns an actor (req.actor from resolveActor, or null) into a tier from
// config/entitlements.js, and a tier into its free-allowance policy.

/** A subscription grants its plan while it is trialing, active or past_due
 *  (Paystack's retry grace) and its period hasn't ended. A cancelled one
 *  keeps the tier until currentPeriodEnd. */
const LIVE_STATUSES = ["trialing", "active", "past_due", "cancelled"];

export async function resolveTier(actor) {
  if (!actor?.id) return "guest";
  const base = actor.type === "vendor" ? "vendor_basic" : "buyer_basic";

  const sub = await PlatformSubscription.findOne({
    ownerId: actor.id,
    ownerType: actor.type,
    status: { $in: LIVE_STATUSES },
    currentPeriodEnd: { $gt: new Date() },
  })
    .select("plan")
    .lean()
    // A subscription read failing must not cost a paying customer their
    // tier's allowance silently forever, but it also must not 500 a search:
    // fall back to the free tier for this one request.
    .catch(() => null);

  return sub?.plan ?? base;
}

/**
 * The allowance this actor gets, or null when their tier has none.
 *
 * Shape: { tier, kind, credits, windowHours?, eligible, reason? }.
 * `eligible: false` still returns the policy so the UI can say what would
 * unlock it (today: "verify your phone"), but nothing is spent from it.
 */
export async function allowancePolicyFor(actor) {
  const tier = await resolveTier(actor);
  const policy = ALLOWANCES[tier];
  if (!policy) return null;

  if (policy.requiresVerifiedPhone) {
    const buyer = await Buyer.findById(actor.id)
      .select("phoneVerified")
      .lean()
      .catch(() => null);
    if (!buyer?.phoneVerified) {
      return { tier, ...policy, eligible: false, reason: "phone_unverified" };
    }
  }
  return { tier, ...policy, eligible: true };
}

/** Q6: Enterprise vendors do not pay the ₦1,000 lead fee. */
export async function isLeadFeeExempt(vendorId) {
  if (!vendorId) return false;
  const tier = await resolveTier({ id: vendorId, type: "vendor" });
  return can(tier, "lead_fee_exempt");
}

/** Express middleware: 403 `{ code: "upgrade_required", capability }` unless
 *  the actor's tier has `capability`. Needs resolveActor upstream. */
export function requireEntitlement(capability) {
  return async (req, _res, next) => {
    try {
      const tier = await resolveTier(req.actor);
      req.tier = tier;
      if (can(tier, capability)) return next();
      return next(
        new AppError("Your plan doesn't include this.", 403, {
          code: "upgrade_required",
          capability,
        }),
      );
    } catch (err) {
      next(err);
    }
  };
}
