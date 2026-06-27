import Order from "../../models/Order.model.js";
import AISetup from "../../models/AiSetup.model.js";
import Customer from "../../models/Customer.model.js";
import Transaction from "../../models/Transactions.model.js";
import { dispatchToStaffly } from "../../utils/stafflyWebhook.js";
import {
  sendOrderTrackingEmail,
  sendReceiptEmail,
} from "../../helpers/emailSender.js";
import { generateOrderReceipt } from "../../services/documents.service.js";
import { notifyUser } from "../../services/pushNotification.service.js";

/**
 * Handle a Paystack `charge.success` event for an ORDER payment (as opposed to a
 * subscription). Called by the single Paystack webhook in
 * subscription.controller after it discriminates order vs subscription payments
 * by metadata — Paystack only ever calls one webhook URL per integration, so all
 * events funnel through there and are routed by `metadata`.
 *
 * Flow:
 *   1. Create the merchant's real velte Order from the payment metadata
 *      (idempotently — Paystack retries webhooks).
 *   2. Dispatch `order.paid` to Staffly with the `stafflyOrderId` it tracks, so
 *      Staffly closes the checkout intent and sends the customer a WhatsApp
 *      confirmation.
 *
 * Expected `data.metadata` (set when the pay page initializes the transaction):
 *   {
 *     type: "order",
 *     stafflyOrderId,            // Staffly's checkout-intent id (ord_...)
 *     merchantId,                // velte User _id who owns the order
 *     customerName, customerPhone,
 *     items: [{ productId?, name, quantity, basePrice, chosenModifiers?, lineTotal }],
 *     notes?,
 *   }
 *
 * Never throws — a webhook handler must not 500 Paystack into an endless retry
 * loop. Failures are logged and swallowed.
 */
export async function handleOrderCharge(data) {
  try {
    const reference = data?.reference;
    const meta = data?.metadata || {};
    const stafflyOrderId = meta.stafflyOrderId || null;
    const merchantId = meta.merchantId || null;

    if (!reference) {
      console.warn(
        "[OrderPayment] charge.success without a reference — skipping",
      );
      return;
    }
    if (!merchantId) {
      console.warn(
        `[OrderPayment] charge.success ${reference} has no merchantId in metadata — cannot create order`,
      );
      return;
    }

    // ── Idempotency ───────────────────────────────────────────────────────────
    // The Paystack reference is unique per transaction. If an order already
    // carries it, this charge was processed on a prior delivery of the webhook —
    // don't create a duplicate order or re-notify the customer.
    const existing = await Order.findOne({
      paystackReference: reference,
    }).select("_id");
    if (existing) {
      console.log(
        `[OrderPayment] charge.success ${reference} already processed (order ${existing._id}) — skipping`,
      );
      return;
    }

    const items = normalizeItems(meta, data);
    const amount = items.reduce((sum, i) => sum + (i.lineTotal ?? 0), 0);

    let order;
    try {
      order = await Order.create({
        merchantId,
        items,
        amount,
        status: "Pending", // paid; fulfilment starts here
        paymentStatus: "paid", // settled via Paystack
        paymentMethod: "Credit / Debit Card",
        customerName: meta.customerName ?? null,
        customerPhone: meta.customerPhone ?? null,
        customerEmail: meta.customerEmail ?? null,
        // Same delivery address on both the customer record and the fulfilment
        // block so either UI lookup (customer.address / fulfillment.address) resolves.
        customerAddress: meta.deliveryAddress ?? null,
        deliveryAddress: meta.deliveryAddress ?? null,
        notes: meta.notes ?? null,
        paystackReference: reference,
      });
    } catch (err) {
      // Unique index on paystackReference: a concurrent retry beat us to it.
      if (err?.code === 11000) {
        console.log(
          `[OrderPayment] race on ${reference} — order already created by a concurrent retry`,
        );
        return;
      }
      throw err;
    }

    const orderRef =
      order.orderId ?? `#ORD-${order._id.toString().slice(-6).toUpperCase()}`;

    // ── Record the sale: upsert the customer + write a transaction ──────────────
    // The merchant's books need both. Awaited (these are fast local writes) but
    // each side is independently guarded so a ledger failure never fails the
    // webhook or blocks the customer's notifications below.
    await recordSale(order);

    // ── Email the customer their tracking key ───────────────────────────────────
    // The secret key goes to email; the matching tracking link goes to WhatsApp
    // (below). Fire-and-forget — a mail failure must not fail the webhook.
    if (order.customerEmail) {
      sendOrderTrackingEmail(
        order.customerEmail,
        order.customerName,
        order.trackingKey,
        orderRef,
      ).catch((e) =>
        console.error("[OrderPayment] tracking email failed:", e.message),
      );
    }

    // ── Notify Staffly ────────────────────────────────────────────────────────
    const aiSetup = await AISetup.findOne({ userId: merchantId }).select(
      "selectedNumberId",
    );
    if (aiSetup?.selectedNumberId) {
      // The key-gated public tracking page for this order. The customer opens this
      // link (from WhatsApp) and enters the key we emailed them. The token alone
      // reveals nothing without the key.
      const frontendBase = (
        process.env.FRONTEND_URL || "https://velte.ng"
      ).replace(/\/$/, "");
      const trackingUrl = `${frontendBase}/track/${order.trackingToken}`;

      dispatchToStaffly("order.paid", aiSetup.selectedNumberId, {
        stafflyOrderId,
        orderId: order.orderId ?? order._id.toString(),
        reference,
        product: items[0]?.name ?? meta.product ?? null,
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        // The order's product value (what the merchant sells), not the grossed-up
        // amount the buyer was charged. `data.amount` now includes Velte's
        // commission + Paystack fee, so prefer the product price from metadata.
        amount:
          meta.productAmount ??
          order.amount ??
          Math.round((data.amount ?? 0) / 100),
        trackingUrl,
      });
    } else {
      console.warn(
        `[OrderPayment] merchant ${merchantId} has no AISetup.selectedNumberId — order ${order._id} created but Staffly was not notified`,
      );
    }

    // ── Generate the receipt PDF and send it ────────────────────────────────────
    // Render the merchant's receipt template filled with this order's real
    // products/amount/buyer, store it on the order, and dispatch `receipt.ready`
    // so Staffly WhatsApps the PDF link. Fire-and-forget: PDF/CDN work is heavy
    // and must never delay or fail the Paystack webhook ack.
    generateAndSendReceipt(order, aiSetup?.selectedNumberId).catch((e) =>
      // Full error (not just .message) — receipt failures are usually a missing
      // Chromium/Cloudinary in the deploy env, and we need the stack to tell which.
      console.error(
        `[OrderPayment] receipt generation failed for order ${order._id}:`,
        e,
      ),
    );

    console.log(
      `[OrderPayment] order ${order._id} created from charge ${reference}`,
    );
  } catch (err) {
    console.error("[OrderPayment] failed to handle order charge:", err.message);
  }
}

/**
 * Record a paid order on the merchant's books: upsert the customer (create on
 * first purchase, otherwise increment their order count + spend) and write a
 * completed transaction. Each side is independently guarded so a failure in one
 * never blocks the other or the webhook. Idempotent on webhook retries — the
 * upstream order-creation guard means this only runs once per real payment, and
 * the transaction's unique `reference` rejects any duplicate that slips through.
 */
export async function recordSale(order) {
  const amount = Number(order.amount) || 0;
  const phone = order.customerPhone || null;
  const email = order.customerEmail || null;
  const name = order.customerName || phone || email || "Customer";

  // ── Upsert the customer (per business) ──────────────────────────────────────
  // Key by phone when we have it (the stable WhatsApp identity), else by email.
  // A customer with neither is anonymous — skip (nothing to dedupe on).
  let customer = null;
  const matchKey = phone
    ? { userId: order.merchantId, phone }
    : email
      ? { userId: order.merchantId, email }
      : null;

  if (matchKey) {
    try {
      customer = await Customer.findOneAndUpdate(
        matchKey,
        {
          $inc: { orders: 1, totalSpend: amount },
          $set: {
            name,
            lastOrderAt: new Date(),
            ...(phone ? { phone } : {}),
            ...(email ? { email } : {}),
          },
          $setOnInsert: { userId: order.merchantId, status: "Active" },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      console.log(
        `[OrderPayment] customer ${customer._id} now at ${customer.orders} order(s), ` +
          `₦${customer.totalSpend.toLocaleString()} total (merchant ${order.merchantId})`,
      );
    } catch (err) {
      console.error("[OrderPayment] customer upsert failed:", err.message);
    }
  } else {
    console.warn(
      `[OrderPayment] order ${order._id} has no phone or email — customer not recorded`,
    );
  }

  // ── Write the transaction ───────────────────────────────────────────────────
  try {
    await Transaction.create({
      userId: order.merchantId,
      customerId: customer?._id?.toString() || phone || email || "unknown",
      name,
      date: new Date().toLocaleDateString("en-GB").replace(/\//g, "-"),
      total: amount,
      currency: "NGN",
      method: "CC", // Paystack card/bank/ussd — "CC" is the closest enum value
      status: "Complete",
      // Dedupe key. Paystack orders use the charge reference; manual-transfer
      // (bridged) orders have none, so fall back to the staffly/order id so each
      // order still records exactly one transaction.
      reference:
        order.paystackReference || order.stafflyOrderId || order._id.toString(),
      metadata: {
        orderId: order.orderId ?? order._id.toString(),
        // Order's DB id — the "View details" link resolves the order by _id.
        orderObjectId: order._id.toString(),
        source: "staffly_order",
      },
    });
    console.log(
      `[OrderPayment] transaction recorded for order ${order._id} (₦${amount.toLocaleString()})`,
    );
  } catch (err) {
    if (err?.code === 11000) {
      console.log(
        `[OrderPayment] transaction for ${order.paystackReference} already recorded — skipping`,
      );
    } else {
      console.error("[OrderPayment] transaction record failed:", err.message);
    }
  }
}

/**
 * Render the receipt PDF for a paid order, persist its URL, and notify Staffly so
 * the customer gets the receipt on WhatsApp. Best-effort: any failure is logged
 * and swallowed (the order + payment are already recorded).
 */
async function generateAndSendReceipt(order, phoneNumberId) {
  console.log(`[OrderPayment] generating receipt for order ${order._id}…`);
  const result = await generateOrderReceipt(order);
  if (!result) {
    // generateOrderReceipt only returns null when Cloudinary isn't configured —
    // surface it loudly so a missing CLOUDINARY_URL in this environment is obvious.
    console.warn(
      `[OrderPayment] receipt NOT generated for order ${order._id} (Cloudinary not configured) — customer will not receive a receipt`,
    );
    return;
  }
  const { url: receiptUrl, receiptNumber, pdf } = result;
  console.log(
    `[OrderPayment] receipt ${receiptNumber} generated for order ${order._id} (${receiptUrl})`,
  );

  await Order.updateOne(
    { _id: order._id },
    { $set: { receiptUrl, receiptNumber } },
  );

  const orderRef =
    order.orderId ?? `#ORD-${order._id.toString().slice(-6).toUpperCase()}`;

  // ── Email the customer their receipt (PDF attached) ─────────────────────────
  // Fire-and-forget — a mail failure must not fail the webhook or block the
  // WhatsApp dispatch below.
  if (order.customerEmail) {
    sendReceiptEmail(order.customerEmail, order.customerName, {
      orderRef,
      receiptNumber,
      amount: order.amount,
      receiptUrl,
      pdfBuffer: pdf,
    }).catch((e) =>
      console.error("[OrderPayment] receipt email failed:", e.message),
    );
  } else {
    console.warn(
      `[OrderPayment] order ${order._id} has no customerEmail — receipt not emailed`,
    );
  }

  // ── WhatsApp the receipt link via Staffly ───────────────────────────────────
  if (phoneNumberId) {
    console.log(
      `[OrderPayment] dispatching receipt.ready to Staffly for order ${order._id} (phoneNumberId ${phoneNumberId})`,
    );
    dispatchToStaffly("receipt.ready", phoneNumberId, {
      orderId: order.orderId ?? order._id.toString(),
      receiptNumber,
      customerPhone: order.customerPhone,
      amount: order.amount,
      paidAt: new Date().toISOString(),
      receiptUrl,
    });
  } else {
    console.warn(
      `[OrderPayment] order ${order._id} receipt generated but no phoneNumberId — not sent to WhatsApp`,
    );
  }
}

// Build + send the merchant's order notification (in-app bell record + web-push,
// via notifyUser). An `awaiting_confirmation` order needs the vendor to verify the
// transfer; a `paid` order is an FYI. Deep-links the merchant straight to the order.
async function notifyMerchantOfOrder(merchantId, order, paymentStatus) {
  const first = order.items?.[0]?.name || "New order";
  const extra = (order.items?.length || 1) - 1;
  const product = extra > 0 ? `${first} +${extra} more` : first;
  const amountText = `₦${Number(order.amount || 0).toLocaleString()}`;
  const ref = order.orderId ?? `#${order._id.toString().slice(-6).toUpperCase()}`;

  const payload =
    paymentStatus === "awaiting_confirmation"
      ? {
          type: "payment",
          title: "Payment to confirm",
          body: `${ref} — ${product} (${amountText}). A customer's transfer receipt is awaiting your confirmation.`,
          requireInteraction: true,
        }
      : {
          type: "new-order",
          title: "New order received",
          body: `${ref} — ${product} (${amountText}) just came in.`,
        };

  await notifyUser(merchantId, {
    ...payload,
    url: `/${merchantId}/orders/${order._id}`,
    tag: `order-${order._id}`,
    metadata: {
      orderId: order._id.toString(),
      stafflyOrderId: order.stafflyOrderId,
    },
  });
}

/**
 * POST /api/internal/orders/from-staffly  (staffly → velte, HMAC-signed)
 *
 * Manual-transfer bridge: when staffly verifies a customer's uploaded receipt, it
 * calls this to surface the order in the merchant's velte dashboard. Replaces the
 * old Paystack `charge.success` → handleOrderCharge path for the no-processor flow.
 * `paymentStatus` is 'paid' (auto-confirmed) or 'awaiting_confirmation' (held for
 * the vendor). Idempotent on `stafflyOrderId`. The signature is already verified by
 * verifyStafflySignature, which attaches the parsed body as req.stafflyBody.
 */
export async function createOrderFromStaffly(req, res) {
  try {
    const body = req.stafflyBody || {};
    const {
      stafflyOrderId,
      merchantId,
      paymentStatus = "paid",
      customerName = null,
      customerPhone = null,
      customerEmail = null,
      deliveryAddress = null,
    } = body;

    if (!stafflyOrderId || !merchantId) {
      return res.status(400).json({
        success: false,
        error: "stafflyOrderId and merchantId are required",
      });
    }
    if (!["paid", "awaiting_confirmation"].includes(paymentStatus)) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid paymentStatus" });
    }

    // Idempotency: staffly may retry. If we already bridged this order, no-op.
    const existing = await Order.findOne({ stafflyOrderId }).select("_id");
    if (existing) {
      return res.status(200).json({ success: true, orderId: existing._id });
    }

    const items = stafflyItemsToOrderItems(body.items, body);
    const amount = items.reduce((sum, i) => sum + (i.lineTotal ?? 0), 0);

    let order;
    try {
      order = await Order.create({
        merchantId,
        items,
        amount,
        status: "Pending",
        paymentStatus,
        paymentMethod: "Bank Transfer",
        customerName,
        customerPhone,
        customerEmail,
        customerAddress: deliveryAddress,
        deliveryAddress,
        stafflyOrderId,
      });
    } catch (err) {
      // Unique index on stafflyOrderId: a concurrent retry beat us to it.
      if (err?.code === 11000) {
        const dup = await Order.findOne({ stafflyOrderId }).select("_id");
        return res.status(200).json({ success: true, orderId: dup?._id });
      }
      throw err;
    }

    // Only a confirmed-paid order hits the merchant's books; a held order is
    // recorded once the vendor confirms it.
    if (paymentStatus === "paid") {
      await recordSale(order);
    }

    // Alert the merchant (dashboard bell + web-push) that an order arrived.
    // Fire-and-forget — a notification failure must never fail the bridge.
    notifyMerchantOfOrder(merchantId, order, paymentStatus).catch((e) =>
      console.error("[OrderBridge] notifyUser failed:", e.message),
    );

    return res.status(201).json({ success: true, orderId: order._id });
  } catch (err) {
    console.error("[OrderBridge] createOrderFromStaffly failed:", err.message);
    return res
      .status(500)
      .json({ success: false, error: "Failed to create order" });
  }
}

// Map staffly's order items ({ name, variant, quantity, unitPrice, lineTotal,
// modifiers:[{group,name,additionalPrice}] }) to velte's orderItemSchema. Falls
// back to a single synthetic line when staffly didn't itemize.
function stafflyItemsToOrderItems(items, body) {
  if (Array.isArray(items) && items.length) {
    return items.map((i) => ({
      name: i.name || body.product || "Item",
      image: i.image ?? body.productImage ?? null,
      quantity: i.quantity ?? 1,
      basePrice: i.unitPrice ?? i.basePrice ?? i.lineTotal ?? 0,
      lineTotal: i.lineTotal ?? i.basePrice ?? 0,
      chosenModifiers: Array.isArray(i.modifiers)
        ? i.modifiers.map((m) => ({
            modifierName: m.group || "Add-on",
            optionName: m.name,
            additionalPrice: m.additionalPrice || 0,
          }))
        : [],
    }));
  }
  const amount = Number(body.amount) || 0;
  return [
    {
      name: body.product || "Order",
      quantity: body.quantity || 1,
      basePrice: body.quantity ? Math.round(amount / body.quantity) : amount,
      chosenModifiers: [],
      lineTotal: amount,
    },
  ];
}

/**
 * Build schema-valid order line items from the payment metadata. Falls back to a
 * single synthetic line (product name + paid amount) when the pay page didn't
 * itemize — so the order still records what was bought.
 */
function normalizeItems(meta, data) {
  if (Array.isArray(meta.items) && meta.items.length) {
    return meta.items.map((i) => ({
      productId: i.productId || undefined,
      name: i.name || "Item",
      image: i.image ?? null,
      quantity: i.quantity ?? 1,
      basePrice: i.basePrice ?? i.lineTotal ?? 0,
      chosenModifiers: Array.isArray(i.chosenModifiers)
        ? i.chosenModifiers
        : [],
      lineTotal: i.lineTotal ?? i.basePrice ?? 0,
    }));
  }

  // Prefer the product price from metadata; `data.amount` now includes Velte's
  // commission + Paystack fee, which must not leak into the order's line items.
  const naira = meta.productAmount ?? Math.round((data?.amount ?? 0) / 100);
  return [
    {
      name: meta.product || meta.productName || "Order",
      quantity: 1,
      basePrice: naira,
      chosenModifiers: [],
      lineTotal: naira,
    },
  ];
}
