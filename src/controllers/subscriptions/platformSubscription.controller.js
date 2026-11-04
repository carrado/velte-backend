// Phase 2 — Buyer Premium and Vendor Enterprise.
//
// The price never comes from the client. Checkout charges the figure in
// config/prices.js and the webhook grants the tier only when Paystack
// reports that same amount. Enterprise can also open a 14-day trial that
// does not charge; a trial that lapses is just an ended row, so the reader
// falls back to Basic.

import crypto from "crypto";

import { AppError } from "../../middleware/errorHandler.js";
import Buyer from "../../models/Buyer.model.js";
import User from "../../models/Users.js";
import PlatformSubscription from "../../models/PlatformSubscription.model.js";
import { initializeTransaction, verifyTransaction } from "../../services/paystack.service.js";
import { startVerification } from "../../services/kyc.service.js";
import {
  SUBSCRIPTION_PRICES_NGN,
  subscriptionPriced,
} from "../../config/prices.js";

const TRIAL_DAYS = 14;
const CALLBACK_PATH = "/chat?subscription=done";

function periodEnd(interval, from = new Date()) {
  const end = new Date(from);
  if (interval === "annual") end.setFullYear(end.getFullYear() + 1);
  else end.setMonth(end.getMonth() + 1);
  return end;
}

function callbackUrl() {
  const base = (process.env.FRONTEND_URL || "").replace(/\/+$/, "");
  if (!base) return undefined;
  return `${base}${CALLBACK_PATH}`;
}

function planForActor(actor) {
  if (actor?.type === "vendor") return "vendor_enterprise";
  if (actor?.type === "buyer") return "buyer_premium";
  return null;
}

export async function savePremiumAddress(req, res, next) {
  try {
    if (req.actor?.type !== "buyer") {
      throw new AppError("Sign in as a buyer to save an address.", 403);
    }
    const addressLine =
      typeof req.body?.addressLine === "string" ? req.body.addressLine.trim() : "";
    const area = typeof req.body?.area === "string" ? req.body.area.trim() : "";
    const state = typeof req.body?.state === "string" ? req.body.state.trim() : "";
    if (addressLine.length < 8 || !area || !state) {
      throw new AppError("Enter your address, area, and state.", 400, {
        code: "address_required",
      });
    }
    await Buyer.findByIdAndUpdate(req.actor.id, {
      premiumProfile: { addressLine, area, state, savedAt: new Date() },
    });
    res.json({ success: true, data: { saved: true } });
  } catch (err) {
    next(err);
  }
}

export async function startNinCheck(req, res, next) {
  try {
    if (!req.actor) throw new AppError("Not authenticated.", 401);
    const started = await startVerification({
      ownerId: req.actor.id,
      ownerType: req.actor.type,
      nin: req.body?.nin,
    });
    const Model = req.actor.type === "vendor" ? User : Buyer;
    await Model.findByIdAndUpdate(req.actor.id, {
      "verification.kycProvider": "ninja",
      "verification.kycReference": started.reference,
    });
    res.json({ success: true, data: { url: started.url } });
  } catch (err) {
    next(err);
  }
}

async function assertPremiumReady(actor) {
  if (process.env.ENFORCE_BUYER_KYC !== 'true') return;
  if (actor.type !== "buyer") return;
  const buyer = await Buyer.findById(actor.id)
    .select("premiumProfile verification")
    .lean();
  if (!buyer?.premiumProfile?.addressLine) {
    throw new AppError("Add your address before upgrading.", 400, {
      code: "address_required",
    });
  }
  if (!buyer?.verification?.ninVerifiedAt) {
    throw new AppError("Verify your NIN before upgrading.", 403, {
      code: "nin_required",
    });
  }
}

export async function checkoutSubscription(req, res, next) {
  try {
    if (!req.actor) throw new AppError("Not authenticated.", 401);
    const plan = planForActor(req.actor);
    const interval = req.body?.interval === "annual" ? "annual" : "monthly";
    if (!plan || !subscriptionPriced(plan, interval)) {
      throw new AppError("That plan is not available.", 400);
    }
    if (req.body?.plan && req.body.plan !== plan) {
      throw new AppError("That plan is not available on this account.", 403);
    }
    await assertPremiumReady(req.actor);

    const Model = req.actor.type === "vendor" ? User : Buyer;
    const account = await Model.findById(req.actor.id).select("email").lean();
    if (!account?.email) {
      throw new AppError("Add an email before subscribing.", 400);
    }

    const amountNgn = SUBSCRIPTION_PRICES_NGN[plan][interval];
    const reference = `vsub_${crypto.randomBytes(12).toString("hex")}`;
    const result = await initializeTransaction({
      email: account.email,
      amount: amountNgn,
      reference,
      callbackUrl: callbackUrl(),
      channels: ["card", "bank_transfer"],
      metadata: {
        type: "platform_subscription",
        ownerId: String(req.actor.id),
        ownerType: req.actor.type,
        plan,
        interval,
        amountKobo: amountNgn * 100,
      },
    });
    const authorizationUrl = result?.authorization_url;
    if (!authorizationUrl) {
      throw new AppError("Couldn't start the payment. Please try again.", 502);
    }
    res.json({
      success: true,
      data: { authorizationUrl, accessCode: result?.access_code, reference, amountKobo: amountNgn * 100, plan, interval },
    });
  } catch (err) {
    next(err);
  }
}

export async function startEnterpriseTrial(req, res, next) {
  try {
    if (req.actor?.type !== "vendor") {
      throw new AppError("The trial is for vendor accounts.", 403);
    }
    const existing = await PlatformSubscription.findOne({
      ownerId: req.actor.id,
      ownerType: "vendor",
      status: { $in: ["trialing", "active", "past_due"] },
      currentPeriodEnd: { $gt: new Date() },
    }).lean();
    if (existing) {
      throw new AppError("This account already has Enterprise.", 409);
    }
    const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
    const sub = await PlatformSubscription.findOneAndUpdate(
      { ownerId: req.actor.id, ownerType: "vendor" },
      {
        $set: {
          plan: "vendor_enterprise",
          interval: "monthly",
          status: "trialing",
          trialEndsAt,
          currentPeriodEnd: trialEndsAt,
        },
      },
      { upsert: true, new: true },
    );
    res.json({
      success: true,
      data: {
        status: sub.status,
        trialEndsAt: sub.trialEndsAt,
        currentPeriodEnd: sub.currentPeriodEnd,
      },
    });
  } catch (err) {
    next(err);
  }
}

/** Called from the Paystack webhook after it has already ACKed. */
export async function activateFromCharge(data) {
  const meta = data?.metadata || {};
  if (meta.type !== "platform_subscription") return;
  const plan = meta.plan;
  const interval = meta.interval === "annual" ? "annual" : "monthly";
  const ownerId = meta.ownerId;
  const ownerType = meta.ownerType;
  if (!ownerId || (ownerType !== "buyer" && ownerType !== "vendor")) return;
  if (!subscriptionPriced(plan, interval)) return;
  const expected = SUBSCRIPTION_PRICES_NGN[plan][interval] * 100;
  if (Number(data.amount) !== expected) {
    console.error(
      `[webhook] subscription amount mismatch ref ${data.reference}: got ${data.amount}, expected ${expected}`,
    );
    return;
  }
  const existing = await PlatformSubscription.findOne({ ownerId, ownerType });
  if (existing?.lastChargeReference === data.reference) return;

  const now = new Date();
  await PlatformSubscription.findOneAndUpdate(
    { ownerId, ownerType },
    {
      $set: {
        plan,
        interval,
        status: "active",
        currentPeriodEnd: periodEnd(interval, now),
        trialEndsAt: null,
        lastChargeReference: data.reference,
        paystackCustomerCode: data.customer?.customer_code ?? null,
      },
    },
    { upsert: true },
  );
}

export async function verifySubscription(req, res, next) {
  try {
    const { reference } = req.body ?? {};
    if (!reference) throw new AppError("reference is required.", 400);
    const transaction = await verifyTransaction(reference);
    if (transaction.status !== "success") {
      throw new AppError(`Payment ${transaction.status}.`, 402);
    }
    await activateFromCharge(transaction);
    res.json({ success: true, data: { status: "active", reference } });
  } catch (err) {
    next(err);
  }
}
