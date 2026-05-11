// src/controllers/subscription/subscription.controller.js

import crypto from "crypto";
import Subscription from "../../models/Subscriptions.js";
import User from "../../models/Users.js";
import { AppError } from "../../middleware/errorHandler.js";
import {
  initializeTransaction,
  verifyTransaction,
  validateWebhookSignature,
} from "../../services/paystack.service.js";

const PLANS = {
  monthly: { amount: 8500, label: "Monthly Plan" },
  annual: { amount: 85000, label: "Annual Plan" },
};

const DEFAULT_PLAN = "monthly";

function getPeriodEnd(planKey, startDate = new Date()) {
  const periodEnd = new Date(startDate);

  if (planKey === "annual") {
    periodEnd.setFullYear(periodEnd.getFullYear() + 1);
  } else {
    periodEnd.setMonth(periodEnd.getMonth() + 1);
  }

  return periodEnd;
}

function formatTransactions(transactions = []) {
  return transactions.map((item) => ({
    id: item._id,
    amount: item.amount,
    reference: item.reference,
    status: item.status,
    paidAt: item.paidAt,
  }));
}

// ── GET /subscription/status ──────────────────────────────────────────────────

export async function getStatus(req, res, next) {
  try {
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
        currentPeriodStart:
          subscription.currentPeriodStart?.toISOString() ?? null,
        currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,

        transactions: formatTransactions(subscription.transactions),
      },
    });
  } catch (err) {
    next(err);
  }
}

// ── POST /subscription/initialize ─────────────────────────────────────────────

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

    const user = await User.findById(req.user.userId).select(
      "email firstName lastName",
    );

    if (!user) {
      throw new AppError("User not found.", 404);
    }

    const reference = `velte_${req.user.userId}_${Date.now()}_${crypto
      .randomBytes(4)
      .toString("hex")}`;

    const transaction = await initializeTransaction({
      email: user.email,
      amount: plan.amount,
      reference,
      metadata: {
        userId: req.user.userId.toString(),
        plan: planKey,
        userName: `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim(),
      },
    });

    await Subscription.findOneAndUpdate(
      { userId: req.user.userId },
      {
        $push: {
          transactions: {
            amount: plan.amount * 100, // store in kobo to match Paystack
            reference,
            status: "pending",
            paidAt: new Date(),
          },
        },
      },
      { upsert: true, new: true },
    );

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

export async function verifySubscription(req, res, next) {
  try {
    const { reference } = req.body;

    if (!reference) {
      throw new AppError("Payment reference is required.", 400);
    }

    const existing = await Subscription.findOne({
      userId: req.user.userId,
      lastPaystackReference: reference,
    }).select("+lastPaystackReference");

    if (existing) {
      return res.json({
        success: true,
        data: {
          isSubscribed: existing.isSubscribed,
          transactions: formatTransactions(existing.transactions),
        },
      });
    }

    const transaction = await verifyTransaction(reference);

    if (transaction.metadata?.userId !== req.user.userId.toString()) {
      throw new AppError(
        "Payment reference does not belong to this account.",
        403,
      );
    }

    const planKey = transaction.metadata?.plan ?? DEFAULT_PLAN;

    if (transaction.status !== "success") {
      const subscription = await Subscription.findOneAndUpdate(
        {
          userId: req.user.userId,
          "transactions.reference": reference,
        },
        {
          $set: {
            "transactions.$.status": "failed",
            "transactions.$.paidAt": new Date(),
          },
        },
        { new: true },
      );

      return res.json({
        success: true,
        data: {
          isSubscribed: false,
          transactions: formatTransactions(subscription?.transactions),
        },
      });
    }

    const now = new Date();
    const periodEnd = getPeriodEnd(planKey, now);

    let subscription = await Subscription.findOneAndUpdate(
      {
        userId: req.user.userId,
        "transactions.reference": reference,
      },
      {
        $set: {
          isSubscribed: true,
          plan: planKey,
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
          paystackCustomerCode: transaction.customer?.customer_code ?? null,
          lastPaystackReference: reference,

          "transactions.$.amount": transaction.amount,
          "transactions.$.status": "success",
          "transactions.$.paidAt": new Date(transaction.paid_at ?? now),
        },
      },
      { new: true },
    );

    if (!subscription) {
      subscription = await Subscription.findOneAndUpdate(
        { userId: req.user.userId },
        {
          $set: {
            isSubscribed: true,
            plan: planKey,
            currentPeriodStart: now,
            currentPeriodEnd: periodEnd,
            paystackCustomerCode: transaction.customer?.customer_code ?? null,
            lastPaystackReference: reference,
          },
          $push: {
            transactions: {
              amount: transaction.amount,
              reference,
              status: "success",
              paidAt: new Date(transaction.paid_at ?? now),
            },
          },
        },
        { upsert: true, new: true },
      );
    }

    res.json({
      success: true,
      data: {
        isSubscribed: true,
        transactions: formatTransactions(subscription.transactions),
      },
    });
  } catch (err) {
    next(err);
  }
}

// ── POST /subscription/webhook ────────────────────────────────────────────────

export async function handleWebhook(req, res, next) {
  try {
    const signature = req.headers["x-paystack-signature"];

    if (!signature) {
      throw new AppError("Missing webhook signature.", 401);
    }

    const rawBody = req.body;
    const isValid = validateWebhookSignature(rawBody, signature);

    if (!isValid) {
      throw new AppError("Invalid webhook signature.", 401);
    }

    const event = JSON.parse(rawBody.toString());

    res.status(200).json({ received: true });

    await processWebhookEvent(event);
  } catch (err) {
    next(err);
  }
}

async function processWebhookEvent(event) {
  const { event: eventType, data } = event;

  switch (eventType) {
    case "charge.success": {
      const userId = data.metadata?.userId;
      if (!userId) break;

      const reference = data.reference;
      const planKey = data.metadata?.plan ?? DEFAULT_PLAN;

      const alreadyProcessed = await Subscription.findOne({
        userId,
        lastPaystackReference: reference,
      }).select("+lastPaystackReference");

      if (alreadyProcessed) break;

      const now = new Date();
      const periodEnd = getPeriodEnd(planKey, now);

      let subscription = await Subscription.findOneAndUpdate(
        {
          userId,
          "transactions.reference": reference,
        },
        {
          $set: {
            isSubscribed: true,
            plan: planKey,
            currentPeriodStart: now,
            currentPeriodEnd: periodEnd,
            paystackCustomerCode: data.customer?.customer_code ?? null,
            paystackAuthorizationCode:
              data.authorization?.authorization_code ?? null,
            lastPaystackReference: reference,

            "transactions.$.amount": data.amount,
            "transactions.$.status": "success",
            "transactions.$.paidAt": new Date(data.paid_at ?? now),
          },
        },
        { new: true },
      );

      if (!subscription) {
        await Subscription.findOneAndUpdate(
          { userId },
          {
            $set: {
              isSubscribed: true,
              plan: planKey,
              currentPeriodStart: now,
              currentPeriodEnd: periodEnd,
              paystackCustomerCode: data.customer?.customer_code ?? null,
              paystackAuthorizationCode:
                data.authorization?.authorization_code ?? null,
              lastPaystackReference: reference,
            },
            $push: {
              transactions: {
                amount: data.amount,
                reference,
                status: "success",
                paidAt: new Date(data.paid_at ?? now),
              },
            },
          },
          { upsert: true },
        );
      }

      break;
    }

    case "charge.failed": {
      const userId = data.metadata?.userId;
      if (!userId) break;

      await Subscription.findOneAndUpdate(
        {
          userId,
          "transactions.reference": data.reference,
        },
        {
          $set: {
            "transactions.$.status": "failed",
            "transactions.$.paidAt": new Date(),
          },
        },
      );

      break;
    }

    case "subscription.create": {
      const customerCode = data.customer?.customer_code;
      if (!customerCode) break;

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
      console.log(`[webhook] unhandled Paystack event: ${eventType}`);
  }
}