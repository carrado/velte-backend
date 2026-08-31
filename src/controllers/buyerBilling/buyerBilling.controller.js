import crypto from "node:crypto";

import { AppError } from "../../middleware/errorHandler.js";
import { initializeTransaction } from "../../services/paystack.service.js";
import {
  modelForActorType,
  resolveEntitlement,
} from "../../helpers/actorPlan.js";
import {
  BUYER_PLANS,
  CYCLES,
  effectivePlanId,
  expiryFrom,
  planRank,
  priceKoboFor,
} from "../../config/buyerPlans.js";

// Buyer plan upgrades (2026-08-29).
//
// A one-off Paystack charge that buys a fixed window of access, NOT a
// Paystack subscription plan. That is a deliberate choice for this market:
// recurring card mandates fail constantly here (expired cards, insufficient
// funds, banks declining recurring auth), and every failed renewal is a
// paying buyer silently downgraded and lost. A prepaid window can't fail —
// it just ends, and the buyer is prompted to buy another. It is also the
// same shape as the airtime/data top-ups every Nigerian buyer already
// understands.
//
// Access is never granted here. It is granted by the webhook (activateFrom
// Charge, below), because that is the only signal that money actually
// moved. A buyer closing the Paystack page, or a callback URL that lies,
// must never produce a plan.
//
// Bought by EITHER kind of account (2026-08-29). A vendor sells stock and
// also buys it, so they are the best-qualified Velte Business prospect in
// the product; until this change they were refused outright and told to open
// a second buyer account to buy the thing we were selling them. The plan is
// stored on whichever document the actor lives in — the fields are identical
// on both (see helpers/actorPlan.js).
//
// Always a CARD charge, never the vendor wallet. Wallet money is Velte's
// revenue from leads, and lead price is tiered on wallet balance, so paying
// from it would silently raise the vendor's own cost per lead.

// Back to the chat rather than to /payment/callback: that page exists for
// the vendor wallet's popup flow and knows nothing about buyer plans, and a
// buyer who just upgraded wants to be back where they were, mid-search.
const CALLBACK_PATH = "/chat?upgrade=done";

// FRONTEND_URL, the same var wallet.controller.js builds its Paystack
// callback from — one origin setting for the whole app, not a second one
// that can drift. Undefined when unset, which Paystack treats as "use the
// dashboard default" rather than failing the transaction.
function callbackUrl() {
  const base = (process.env.FRONTEND_URL || "").replace(/\/+$/, "");
  return base ? `${base}${CALLBACK_PATH}` : undefined;
}

// ── GET /api/buyer-billing/plans ─────────────────────────────────────────
//
// The price list, from the server-side table that actually charges. Public
// on purpose — a pricing page needs it before anyone signs in — and it
// exposes nothing but prices that are meant to be published.
export async function listPlans(_req, res, next) {
  try {
    return res.json({
      success: true,
      data: {
        plans: Object.values(BUYER_PLANS).map((plan) => ({
          id: plan.id,
          name: plan.name,
          monthlyKobo: plan.monthlyKobo,
          yearlyKobo: plan.yearlyKobo,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/buyer-billing/me ────────────────────────────────────────────
//
// What this buyer is currently on, with expiry resolved. `plan` is what
// they can USE right now; `storedPlan` is what they last bought, which
// differs whenever a paid plan has lapsed.
export async function getMyPlan(req, res, next) {
  try {
    if (!req.actor) throw new AppError("Not authenticated.", 401);
    const account = await modelForActorType(req.actor.type)
      .findById(req.actor.id)
      .select("plan planExpiresAt planCycle")
      .lean();
    if (!account) throw new AppError("Account not found.", 404);

    // `plan` is the ENTITLEMENT — what they can use, which may come from a
    // linked vendor/buyer account on the same verified email. `storedPlan`
    // and the dates below are this document's own, so a caller can still
    // tell "bought here" from "inherited from my other half", and a renewal
    // prompt reads the right expiry.
    const entitlement = await resolveEntitlement(req.actor);

    return res.json({
      success: true,
      data: {
        plan: entitlement?.planId ?? effectivePlanId(account),
        planSource: entitlement?.source ?? "own",
        storedPlan: account.plan ?? "free",
        planExpiresAt: account.planExpiresAt ?? null,
        planCycle: account.planCycle ?? null,
        ownerType: req.actor.type,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/buyer-billing/checkout ─────────────────────────────────────
//
// Body: { planId: "plus" | "business", cycle: "monthly" | "yearly" }
// 200:  { success, data: { authorizationUrl, reference, amountKobo } }
//
// The caller names the PLAN. The price comes from this repo's own table —
// see config/buyerPlans.js for why that separation is not negotiable.
export async function initCheckout(req, res, next) {
  try {
    const { planId, cycle } = req.body ?? {};

    if (!BUYER_PLANS[planId]) {
      throw new AppError("Unknown plan.", 400);
    }
    if (!CYCLES[cycle]) {
      throw new AppError("cycle must be 'monthly' or 'yearly'.", 400);
    }

    const amountKobo = priceKoboFor(planId, cycle);
    if (!amountKobo) throw new AppError("That plan isn't purchasable.", 400);

    // Don't sell someone what their OTHER half already has (2026-08-29).
    //
    // A buyer linked to a vendor on Velte Business is already entitled to
    // Business everywhere; letting them buy Plus here would take money for a
    // downgrade they'd never see the effect of. Scoped to `source === "linked"`
    // on purpose: re-buying your OWN tier is an ordinary renewal, which
    // expiryFrom explicitly supports by extending from the current expiry.
    const entitlement = await resolveEntitlement(req.actor);
    if (
      entitlement?.source === "linked" &&
      planRank(entitlement.planId) >= planRank(planId)
    ) {
      throw new AppError(
        `Your ${
          req.actor.type === "buyer" ? "vendor" : "buyer"
        } account on this email already includes ${
          BUYER_PLANS[entitlement.planId]?.name ?? entitlement.planId
        }, and it applies here too — there's nothing to buy.`,
        409,
      );
    }

    if (!req.actor) throw new AppError("Not authenticated.", 401);
    const account = await modelForActorType(req.actor.type)
      .findById(req.actor.id)
      .select("email plan planExpiresAt")
      .lean();
    if (!account) throw new AppError("Account not found.", 404);

    // Paystack requires an email to open a transaction. A vendor always has
    // one (it is their login) and so does a Google buyer; a phone-only buyer
    // may not, and the honest answer is to say so rather than to invent a
    // placeholder address that then receives their receipt.
    if (!account.email) {
      throw new AppError(
        "Add an email to your account before upgrading — Paystack needs one to send your receipt.",
        400,
      );
    }

    // Our own reference, carrying no secrets. Random rather than derived
    // from the buyer id, so a reference appearing in a URL or a support
    // screenshot reveals nothing about who bought what.
    const reference = `vplan_${crypto.randomBytes(12).toString("hex")}`;

    const result = await initializeTransaction({
      email: account.email,
      // initializeTransaction takes NAIRA and converts — see its own comment.
      amount: amountKobo / 100,
      reference,
      callbackUrl: callbackUrl(),
      metadata: {
        // The discriminator the webhook branches on. Must stay distinct
        // from "wallet_topup", which is the vendor wallet's own type.
        type: "buyer_plan",
        // Who the plan is for, and which collection they live in. `buyerId`
        // is still written for buyers so a transaction opened by the
        // PREVIOUS build and paid after this one deploys still activates —
        // activateFromCharge reads it as a fallback.
        ownerId: String(req.actor.id),
        ownerType: req.actor.type,
        ...(req.actor.type === "buyer"
          ? { buyerId: String(req.actor.id) }
          : {}),
        planId,
        cycle,
        // Recorded so a mismatch between what we meant to charge and what
        // Paystack reports is visible in the webhook rather than silent.
        amountKobo,
      },
      // No subaccount: a plan purchase is Velte's own revenue, not a
      // marketplace payment being split to a vendor.
    });

    const authorizationUrl = result?.data?.authorization_url;
    if (!authorizationUrl) {
      throw new AppError("Couldn't start the payment. Please try again.", 502);
    }

    return res.json({
      success: true,
      data: { authorizationUrl, reference, amountKobo },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Grants a plan from a verified `charge.success` webhook. Called by the
 * webhook handler, never by a route.
 *
 * Idempotent by reference: Paystack retries webhooks, and a buyer must not
 * get two months for one payment. The guard is a conditional update — the
 * reference is only written when it isn't already the last one recorded, so
 * two concurrent deliveries of the same event can't both extend the expiry.
 */
export async function activateFromCharge(data) {
  const meta = data?.metadata ?? {};
  const { planId, cycle } = meta;
  const reference = data?.reference;

  // `ownerId`/`ownerType` since 2026-08-29; `buyerId` is the pre-vendor
  // shape, still honoured so a transaction opened before that deploy and
  // paid after it still grants the plan it was paid for. Defaulting the type
  // to "buyer" is what makes the old shape resolve correctly.
  const ownerId = meta.ownerId ?? meta.buyerId;
  const ownerType = meta.ownerType === "vendor" ? "vendor" : "buyer";

  if (!ownerId || !BUYER_PLANS[planId] || !CYCLES[cycle] || !reference) {
    console.error(
      "[buyer-billing] charge.success with unusable metadata — ignored:",
      JSON.stringify(meta),
    );
    return;
  }

  // What Paystack says was actually paid, in kobo. Trusted over our own
  // metadata: metadata is what we asked for, `amount` is what settled.
  const paidKobo = Number(data.amount);
  const expectedKobo = priceKoboFor(planId, cycle);
  if (!Number.isFinite(paidKobo) || paidKobo < expectedKobo) {
    console.error(
      `[buyer-billing] underpaid ${planId}/${cycle}: got ${paidKobo}, expected ${expectedKobo} (ref ${reference}) — no plan granted`,
    );
    return;
  }

  const Model = modelForActorType(ownerType);
  const account = await Model.findById(ownerId)
    .select("plan planExpiresAt lastPlanReference")
    .lean();
  if (!account) {
    console.error(
      `[buyer-billing] no ${ownerType} ${ownerId} for ref ${reference}`,
    );
    return;
  }
  if (account.lastPlanReference === reference) return; // already applied

  const expiresAt = expiryFrom(cycle, account.planExpiresAt);

  const updated = await Model.updateOne(
    { _id: ownerId, lastPlanReference: { $ne: reference } },
    {
      $set: {
        plan: planId,
        planCycle: cycle,
        planExpiresAt: expiresAt,
        lastPlanReference: reference,
      },
    },
  );

  if (updated.modifiedCount) {
    console.log(
      `[buyer-billing] ${ownerType} ${ownerId} → ${planId} (${cycle}) until ${expiresAt.toISOString()} [ref ${reference}]`,
    );
  }
}
