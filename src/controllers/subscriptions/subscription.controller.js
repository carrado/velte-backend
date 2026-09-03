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
import { creditFromCharge } from "../credits/credits.controller.js";

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
      // Buyer PLANS are retired (2026-08-31) and nothing can open one any
      // more — the checkout route, the price table and the grant code are
      // all deleted. This branch stays as a TRAP rather than being removed
      // with them: a plan transaction opened just before the deploy can
      // still be paid after it, and without this it would fall through to
      // the wallet handler and either credit the wrong ledger or be logged
      // as unattributable and quietly lost. Refunding one real payment by
      // hand is fine; not knowing it happened is not.
      if (data.metadata?.type === "buyer_plan") {
        console.error(
          `[webhook] payment for the RETIRED buyer plan — refund by hand: ref ${data.reference}, ${data.amount} kobo, owner ${data.metadata?.ownerId ?? data.metadata?.buyerId ?? "unknown"} (${data.metadata?.ownerType ?? "buyer"})`,
        );
        break;
      }
      // Credit top-ups (2026-08-31), checked before the wallet handler for
      // the same reason: they carry their own metadata type, and falling
      // through would log a payment a buyer already made as unattributable
      // and silently drop it. The reference travels into the grant code, so
      // Paystack's routine retries are no-ops rather than double credits.
      if (data.metadata?.type === "credit_topup") {
        await creditFromCharge({
          ...data.metadata,
          reference: data.reference,
        });
        break;
      }
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
