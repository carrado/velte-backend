import Order from "../../models/Order.model.js";
import AISetup from "../../models/AiSetup.model.js";
import { dispatchToStaffly } from "../../utils/stafflyWebhook.js";

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
      console.warn("[OrderPayment] charge.success without a reference — skipping");
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
    const existing = await Order.findOne({ paystackReference: reference }).select("_id");
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
        customerName: meta.customerName ?? null,
        customerPhone: meta.customerPhone ?? null,
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

    // ── Notify Staffly ────────────────────────────────────────────────────────
    const aiSetup = await AISetup.findOne({ userId: merchantId }).select("selectedNumberId");
    if (aiSetup?.selectedNumberId) {
      // A link the customer can revisit to view/track this order: the pay page
      // renders the order summary and its status (now "paid") when given the
      // merchant's linkId plus the order ref. Built only when both are known.
      const frontendBase = (process.env.FRONTEND_URL || "https://velte.ng").replace(/\/$/, "");
      const trackingUrl =
        meta.linkId && stafflyOrderId
          ? `${frontendBase}/pay/${meta.linkId}?ref=${encodeURIComponent(stafflyOrderId)}`
          : null;

      dispatchToStaffly("order.paid", aiSetup.selectedNumberId, {
        stafflyOrderId,
        orderId: order.orderId ?? order._id.toString(),
        reference,
        product: items[0]?.name ?? meta.product ?? null,
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        amount: Math.round((data.amount ?? 0) / 100), // Paystack kobo → Naira
        trackingUrl,
      });
    } else {
      console.warn(
        `[OrderPayment] merchant ${merchantId} has no AISetup.selectedNumberId — order ${order._id} created but Staffly was not notified`,
      );
    }

    console.log(`[OrderPayment] order ${order._id} created from charge ${reference}`);
  } catch (err) {
    console.error("[OrderPayment] failed to handle order charge:", err.message);
  }
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
      quantity: i.quantity ?? 1,
      basePrice: i.basePrice ?? i.lineTotal ?? 0,
      chosenModifiers: Array.isArray(i.chosenModifiers) ? i.chosenModifiers : [],
      lineTotal: i.lineTotal ?? i.basePrice ?? 0,
    }));
  }

  const naira = Math.round((data?.amount ?? 0) / 100);
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
