// src/controllers/subscription/subscription.controller.js
//
// Follows the NEW controller style (ai-setup pattern):
//   - AppError(message, statusCode) thrown and forwarded with next(err)
//   - req.user.userId  (what verifyAuth actually sets on the JWT)
//   - Responses: res.json({ success: true, data: { ... } })

import crypto from "crypto";
import Subscription from "../../models/Subscriptions.js";
import User from "../../models/Users.js";
import { AppError } from "../../middleware/errorHandler.js";
import {
  initializeTransaction,
  verifyTransaction,
  validateWebhookSignature,
} from "../../services/paystack.service.js";

// ── Pricing ───────────────────────────────────────────────────────────────────
// Centralise pricing here so it's easy to update.
// Amount is in NGN (naira) — the service multiplies by 100 for kobo.

const PLANS = {
  monthly: { amount: 5000, label: "Monthly Plan" },
  annual:  { amount: 50000, label: "Annual Plan" },
};

const DEFAULT_PLAN = "monthly";

// ── GET /subscription/status ──────────────────────────────────────────────────

export async function getStatus(req, res, next) {
  try {
    // getOrCreate so the endpoint is always safe to call
    let subscription = await Subscription.findOne({ userId: req.user.userId });

    if (!subscription) {
      subscription = await Subscription.create({ userId: req.user.userId });
    }

    res.json({
      success: true,
      data: {
        isSubscribed: subscription.isSubscribed,
        trialEndsAt: subscription.trialEndsAt?.toISOString() ?? null,
        plan: subscription.plan ?? null,
        currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ── POST /subscription/initialize ────────────────────────────────────────────
// Creates a Paystack transaction and returns the checkout URL to the client.
// The client opens it in a popup via openPaystackPopup().

export async function initializeSubscription(req, res, next) {
  try {
    const planKey = req.body?.plan ?? DEFAULT_PLAN;
    const plan = PLANS[planKey];

    if (!plan) {
      throw new AppError(
        `Invalid plan. Choose one of: ${Object.keys(PLANS).join(", ")}`,
        400,
      );
    }

    const user = await User.findById(req.user.userId).select("email firstName lastName");
    if (!user) throw new AppError("User not found.", 404);

    // Unique reference per attempt — Paystack rejects duplicate references
    const reference = `velte_${req.user.userId}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

    const transaction = await initializeTransaction({
      email: user.email,
      amount: plan.amount,
      reference,
      metadata: {
        userId: req.user.userId.toString(),
        plan: planKey,
        userName: `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim(),
      },
      // The popup flow doesn't need a callback URL but Paystack requires one
      // for redirect flows — set it to the dashboard as a safe fallback.
      callbackUrl: `${process.env.FRONTEND_URL}/{id}/dashboard`,
    });

    res.json({
      success: true,
      data: {
        authorization_url: transaction.authorization_url,
        reference: transaction.reference,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ── POST /subscription/verify ─────────────────────────────────────────────────
// Called by the client after the Paystack popup closes.
// Verifies the payment with Paystack and activates the subscription.

export async function verifySubscription(req, res, next) {
  try {
    const { reference } = req.body;
    if (!reference) throw new AppError("Payment reference is required.", 400);

    // Prevent replaying the same reference
    const existing = await Subscription.findOne({
      userId: req.user.userId,
      lastPaystackReference: reference,
    }).select("+lastPaystackReference");

    if (existing) {
      // Already processed — return current state idempotently
      return res.json({
        success: true,
        data: { isSubscribed: existing.isSubscribed },
      });
    }

    // Verify with Paystack
    const transaction = await verifyTransaction(reference);

    // Ensure this payment belongs to THIS user — prevents reference hijacking
    if (transaction.metadata?.userId !== req.user.userId.toString()) {
      throw new AppError("Payment reference does not belong to this account.", 403);
    }

    if (transaction.status !== "success") {
      return res.json({
        success: true,
        data: { isSubscribed: false },
      });
    }

    const planKey = transaction.metadata?.plan ?? DEFAULT_PLAN;
    const now = new Date();

    // Set period end based on plan
    const periodEnd = new Date(now);
    if (planKey === "annual") {
      periodEnd.setFullYear(periodEnd.getFullYear() + 1);
    } else {
      periodEnd.setMonth(periodEnd.getMonth() + 1);
    }

    await Subscription.findOneAndUpdate(
      { userId: req.user.userId },
      {
        $set: {
          isSubscribed: true,
          plan: planKey,
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
          // Store the Paystack customer code for future charges
          paystackCustomerCode: transaction.customer?.customer_code ?? null,
          lastPaystackReference: reference,
        },
      },
      { upsert: true, new: true },
    );

    res.json({
      success: true,
      data: { isSubscribed: true },
    });
  } catch (err) {
    next(err);
  }
}

// ── POST /subscription/webhook ────────────────────────────────────────────────
// Receives Paystack webhook events.
// Paystack signs the body with HMAC-SHA512 — always verify first.
// Must be registered with raw body parser (not JSON) to verify signature.
//
// Events handled:
//   charge.success          — one-off payment succeeded
//   subscription.create     — managed subscription created
//   subscription.disable    — managed subscription cancelled
//   invoice.payment_failed  — recurring payment failed

export async function handleWebhook(req, res, next) {
  try {
    const signature = req.headers["x-paystack-signature"];
    if (!signature) {
      throw new AppError("Missing webhook signature.", 401);
    }

    // req.body is a raw Buffer when using express.raw() on this route
    const rawBody = req.body;
    const isValid = validateWebhookSignature(rawBody, signature);
    if (!isValid) {
      throw new AppError("Invalid webhook signature.", 401);
    }

    // Parse the raw body now that we've verified it
    const event = JSON.parse(rawBody.toString());

    // Acknowledge immediately — Paystack retries if we take > 5s
    res.status(200).json({ received: true });

    // Process asynchronously after responding
    await processWebhookEvent(event);
  } catch (err) {
    next(err);
  }
}

async function processWebhookEvent(event) {
  const { event: eventType, data } = event;

  switch (eventType) {

    // ── Successful one-off charge ─────────────────────────────────────────────
    case "charge.success": {
      const userId = data.metadata?.userId;
      if (!userId) break;

      const reference = data.reference;
      const planKey = data.metadata?.plan ?? DEFAULT_PLAN;

      // Guard against duplicate webhook delivery
      const alreadyProcessed = await Subscription.findOne({
        userId,
        lastPaystackReference: reference,
      }).select("+lastPaystackReference");
      if (alreadyProcessed) break;

      const now = new Date();
      const periodEnd = new Date(now);
      if (planKey === "annual") {
        periodEnd.setFullYear(periodEnd.getFullYear() + 1);
      } else {
        periodEnd.setMonth(periodEnd.getMonth() + 1);
      }

      await Subscription.findOneAndUpdate(
        { userId },
        {
          $set: {
            isSubscribed: true,
            plan: planKey,
            currentPeriodStart: now,
            currentPeriodEnd: periodEnd,
            paystackCustomerCode: data.customer?.customer_code ?? null,
            paystackAuthorizationCode: data.authorization?.authorization_code ?? null,
            lastPaystackReference: reference,
          },
        },
        { upsert: true },
      );
      break;
    }

    // ── Recurring subscription created by Paystack ────────────────────────────
    case "subscription.create": {
      const customerCode = data.customer?.customer_code;
      if (!customerCode) break;

      const sub = await Subscription.findOne({ paystackCustomerCode: customerCode });
      if (!sub) break;

      await Subscription.findOneAndUpdate(
        { paystackCustomerCode: customerCode },
        {
          $set: {
            isSubscribed: true,
            paystackSubscriptionCode: data.subscription_code,
            paystackEmailToken: data.email_token,
          },
        },
      );
      break;
    }

    // ── Subscription disabled / cancelled ─────────────────────────────────────
    case "subscription.disable": {
      const subscriptionCode = data.subscription_code;
      if (!subscriptionCode) break;

      await Subscription.findOneAndUpdate(
        { paystackSubscriptionCode: subscriptionCode },
        {
          $set: {
            isSubscribed: false,
            cancelledAt: new Date(),
          },
        },
      );
      break;
    }

    // ── Invoice payment failed — mark as not subscribed ───────────────────────
    case "invoice.payment_failed": {
      const customerCode = data.customer?.customer_code;
      if (!customerCode) break;

      await Subscription.findOneAndUpdate(
        { paystackCustomerCode: customerCode },
        { $set: { isSubscribed: false } },
      );
      break;
    }

    default:
      // Unhandled event — log and move on
      console.log(`[webhook] unhandled Paystack event: ${eventType}`);
  }
}