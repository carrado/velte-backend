// src/controllers/subscription/subscription.controller.js
//
// Subscription tiers/billing are retired (Velte Connect pivots monetization to
// pay-per-lead via the Vendor Wallet — see docs/velte-connect-teardown-plan.md
// Bucket A9/D5). This file now only keeps the Paystack webhook endpoint alive,
// since its URL is registered with Paystack and can't just disappear — the
// order-vs-subscription discrimination it used to do is gone, replaced with
// wallet top-up crediting (the only Paystack event source left in the app).

import { AppError } from "../../middleware/errorHandler.js";
import { validateWebhookSignature } from "../../services/paystack.service.js";
import { creditWalletFromCharge } from "../wallet/wallet.controller.js";

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

    // Ack immediately — a webhook handler must not 500 Paystack into an
    // endless retry loop while we do DB work.
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
      // Wallet top-ups are the only charge.success source left in this app —
      // card top-up (our metadata) or a DVA bank-transfer credit (no metadata,
      // identified by customer_code instead). creditWalletFromCharge branches
      // on which shape it is.
      await creditWalletFromCharge(data);
      break;
    }

    default:
      console.log(`[webhook] unhandled Paystack event: ${eventType}`);
  }
}
