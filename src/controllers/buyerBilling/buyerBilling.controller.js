import crypto from "node:crypto";

import Buyer from "../../models/Buyer.model.js";
import { AppError } from "../../middleware/errorHandler.js";
import { initializeTransaction } from "../../services/paystack.service.js";
import {
  BUYER_PLANS,
  CYCLES,
  effectivePlanId,
  expiryFrom,
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
    const buyer = await Buyer.findById(req.buyer.buyerId)
      .select("plan planExpiresAt planCycle")
      .lean();
    if (!buyer) throw new AppError("Account not found.", 404);

    return res.json({
      success: true,
      data: {
        plan: effectivePlanId(buyer),
        storedPlan: buyer.plan ?? "free",
        planExpiresAt: buyer.planExpiresAt ?? null,
        planCycle: buyer.planCycle ?? null,
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

    const buyer = await Buyer.findById(req.buyer.buyerId)
      .select("email plan planExpiresAt")
      .lean();
    if (!buyer) throw new AppError("Account not found.", 404);

    // Paystack requires an email to open a transaction. A Google buyer
    // always has one; a phone-only buyer may not, and the honest answer is
    // to say so rather than to invent a placeholder address that then
    // receives their receipt.
    if (!buyer.email) {
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
      email: buyer.email,
      // initializeTransaction takes NAIRA and converts — see its own comment.
      amount: amountKobo / 100,
      reference,
      callbackUrl: callbackUrl(),
      metadata: {
        // The discriminator the webhook branches on. Must stay distinct
        // from "wallet_topup", which is the vendor wallet's own type.
        type: "buyer_plan",
        buyerId: String(req.buyer.buyerId),
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
  const { buyerId, planId, cycle } = meta;
  const reference = data?.reference;

  if (!buyerId || !BUYER_PLANS[planId] || !CYCLES[cycle] || !reference) {
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

  const buyer = await Buyer.findById(buyerId)
    .select("plan planExpiresAt lastPlanReference")
    .lean();
  if (!buyer) {
    console.error(`[buyer-billing] no buyer ${buyerId} for ref ${reference}`);
    return;
  }
  if (buyer.lastPlanReference === reference) return; // already applied

  const expiresAt = expiryFrom(cycle, buyer.planExpiresAt);

  const updated = await Buyer.updateOne(
    { _id: buyerId, lastPlanReference: { $ne: reference } },
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
      `[buyer-billing] ${buyerId} → ${planId} (${cycle}) until ${expiresAt.toISOString()} [ref ${reference}]`,
    );
  }
}
