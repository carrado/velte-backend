import Buyer from "../models/Buyer.model.js";
import User from "../models/Users.js";
import { effectivePlanId, planRank } from "../config/buyerPlans.js";

// Which plan an actor is on, whichever kind of account they hold
// (2026-08-29 — the "one identity" change).
//
// Before this, a vendor could not be on a plan AT ALL: every metered route
// hardcoded `vendor → the caller's vendor row`, and buyerBilling refused a
// vendor session outright. That made the best-qualified Velte Business
// prospect in the product — a trader who sells stock and also BUYS it — open
// a second account and re-enter a card to buy the thing we were selling
// them. The wallet is deliberately still not involved (see below); what
// changed is only that a vendor's own identity can now hold a buyer plan,
// paid for by card like anyone else's.
//
// THE WALLET IS NOT A PAYMENT METHOD FOR PLANS, and shouldn't become one:
//   - wallet money is Velte's REVENUE from leads. Spending it on search
//     would convert booked revenue into the most expensive thing we serve.
//   - lead price is tiered on wallet BALANCE (see utils/leadPricing.js), so
//     a plan bought from the wallet could silently double a vendor's cost
//     per lead as a side effect. That is not a surprise worth shipping.
//
// Buyer and User now carry the same four plan fields, and effectivePlanId
// only reads `plan` + `planExpiresAt`, so it resolves either document
// without knowing which it was handed.

/** The Mongoose model an actor type lives in. */
export function modelForActorType(ownerType) {
  return ownerType === "vendor" ? User : Buyer;
}

/** The field on THIS kind of document pointing at the same person's other
 *  account. Stored on BOTH sides (see resolveEntitlement) so the lookup is
 *  always a keyed findById rather than a scan on either direction. */
function linkFieldFor(ownerType) {
  return ownerType === "vendor" ? "linkedBuyerId" : "linkedVendorId";
}

/**
 * The plan stored on one account document, expiry-applied.
 *
 * A vendor with no plan (or a lapsed one) resolves to the `"vendor"`
 * sentinel rather than to `"free"`. That sentinel is NOT a tier — it is the
 * row the caller supplies for "a known, paying account that hasn't bought a
 * buyer subscription". Keeping it distinct from `"free"` is what lets
 * vendors keep allowances Free doesn't have (price watches most obviously:
 * VENDOR_PRICE_WATCHES is 10 where Free is 0), which was the entire reason
 * the two were decoupled in the first place.
 */
function planOf(account, ownerType) {
  const resolved = effectivePlanId(account);
  if (ownerType === "vendor" && resolved === "free") return "vendor";
  return resolved;
}

/**
 * What this actor is ENTITLED to, across both halves of one person.
 *
 * A plan is bought by a person, not by a cookie. Google sign-in on /chat
 * creates a separate Buyer even for someone who is already a vendor, and
 * resolveActor prefers the buyer cookie when both are present — so without
 * this, a vendor who bought Velte Business and then signed in for their
 * history would be resolved as a brand-new free buyer and metered at 10
 * searches having just paid for 400. See Buyer.linkedVendorId.
 *
 * BOTH sides are always compared, with NO short-circuit on "their own plan
 * is already a paid one". That short-circuit looked free and was wrong: a
 * buyer on Plus who upgrades through their vendor half to Business — which
 * the checkout guard correctly allows, since it is a genuine upgrade — would
 * have gone on reading as Plus, losing the tier they had just paid for.
 *
 * The link is denormalised onto both documents precisely so always checking
 * costs nothing: an account with no link does ONE query, exactly as before,
 * and only a genuinely linked person does a second keyed lookup.
 *
 * Ties keep the actor's OWN plan, which is what preserves the vendor
 * sentinel: an unpaid vendor linked to a free buyer stays `"vendor"` (and
 * keeps their watches) rather than being flattened to `"free"`. Only a
 * PURCHASED tier ever crosses the link — `"free"` and the sentinel both rank
 * 0 — so a buyer never inherits the vendor floor by being linked. That floor
 * is a property of acting as a vendor, not of the person.
 *
 * `source` says which half the entitlement came from. Billing needs it:
 * buying a tier you already hold through the other half is a refund request
 * waiting to happen, whereas re-buying your OWN tier is an ordinary renewal.
 *
 * Returns null for an account that no longer exists; callers decide whether
 * that is a 404 or a refusal.
 */
export async function resolveEntitlement(actor) {
  if (!actor?.id || !actor?.type) return null;

  const linkField = linkFieldFor(actor.type);
  const account = await modelForActorType(actor.type)
    .findById(actor.id)
    .select(`plan planExpiresAt ${linkField}`)
    .lean();
  if (!account) return null;

  const own = planOf(account, actor.type);
  const linkedId = account[linkField];
  if (!linkedId) return { planId: own, source: "own" };

  const otherType = actor.type === "vendor" ? "buyer" : "vendor";
  const other = await modelForActorType(otherType)
    .findById(linkedId)
    .select("plan planExpiresAt")
    .lean();
  // A link pointing at a deleted account is not an error — the person still
  // has whatever their own half holds.
  if (!other) return { planId: own, source: "own" };

  const linked = planOf(other, otherType);
  if (planRank(linked) > planRank(own)) {
    return { planId: linked, source: "linked" };
  }
  return { planId: own, source: "own" };
}

/**
 * The plan id to meter this actor at — `resolveEntitlement` without the
 * bookkeeping, for the metering call sites that only need the answer.
 */
export async function planIdForActor(actor) {
  const entitlement = await resolveEntitlement(actor);
  return entitlement ? entitlement.planId : null;
}

/**
 * The allowance to enforce, from the caller's plan → quota table.
 *
 * For a vendor this is the GREATER of their plan's row and the vendor row,
 * which makes one invariant true by construction: **buying a plan can never
 * reduce what a vendor already had.** Without it, any tier whose allowance
 * sits below the vendor row would quietly punish the vendor for paying —
 * live today on price watches, where a vendor gets 10 and Free gets 0, and a
 * latent trap on every axis added later.
 *
 * Falls back to the `free` row for an unknown plan id, the same safe
 * direction taken everywhere else: under-charge, never lock out.
 */
export function limitFor(actor, limits, planId) {
  const rowFor = (key) =>
    Number.isInteger(limits?.[key]) ? limits[key] : null;

  const planRow = rowFor(planId) ?? rowFor("free") ?? 0;
  if (actor?.type !== "vendor") return planRow;

  const vendorRow = rowFor("vendor");
  if (vendorRow === null) return planRow;
  // -1 means uncapped, so it beats every finite row — a plain Math.max would
  // read it as the SMALLEST number and quietly cap a vendor who had bought an
  // unlimited tier back down to the vendor floor. That is precisely the
  // "buying a plan can never reduce an allowance" rule this function exists
  // to hold, failing in the one direction nobody would look for it.
  if (planRow === -1 || vendorRow === -1) return -1;
  return Math.max(planRow, vendorRow);
}
