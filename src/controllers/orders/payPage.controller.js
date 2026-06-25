import crypto from "crypto";
import PaymentLink from "../../models/Paymentlink.model.js";
import StafflyOrder from "../../models/StafflyOrder.model.js";
import { initializeTransaction } from "../../services/paystack.service.js";
import { computeCharge } from "../../utils/commission.js";
import { AppError } from "../../middleware/errorHandler.js";

/**
 * Public pay-page endpoints. These back the velte `/pay/[linkId]` page that a
 * customer lands on from a WhatsApp checkout. No auth — the linkId is the
 * capability — but rate-limited and validated at the route.
 *
 * The link itself is the merchant's STATIC payment link (one Paystack subaccount,
 * reused for every customer). The per-order context rides in the `ref` query
 * param (a Staffly `orderId`); we resolve it server-side so the charged amount
 * and buyer details come from the trusted StafflyOrder, never from the client.
 */

// An active, non-deleted, non-expired link, found by its public linkId.
async function findActiveLink(linkId) {
  const link = await PaymentLink.findOne({
    linkId,
    isActive: true,
    deletedAt: null,
    $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
  });
  if (!link) throw new AppError("Payment link not found or inactive", 404);
  return link;
}

// ── GET /api/pay/:linkId?ref=ord_... ──────────────────────────────────────────
// Returns what the pay page needs to render: who's being paid, the amount, and
// (if a Staffly order is referenced) the order summary.
export async function getPayLink(req, res, next) {
  try {
    const { linkId } = req.params;
    const { ref } = req.query;

    const link = await findActiveLink(linkId);

    // Best-effort: count an opened link without blocking the response.
    PaymentLink.updateOne({ _id: link._id }, { $inc: { clickCount: 1 } }).catch(
      () => {},
    );

    let order = null;
    if (ref) {
      const so = await StafflyOrder.findOne({ orderId: ref })
        .select("orderId product amount quantity items customerName status")
        .lean();
      if (so) {
        order = {
          ref: so.orderId,
          product: so.product,
          // `amount` is the grand total (Σ line totals).
          amount: so.amount,
          quantity: so.quantity ?? 1,
          // Per-variant breakdown for the pay page to show each line. Empty for
          // older orders placed before multi-variant support — the page then
          // falls back to the single product label + quantity.
          items: Array.isArray(so.items)
            ? so.items.map((it) => ({
                name: it.name ?? null,
                variant: it.variant ?? null,
                quantity: it.quantity ?? 1,
                unitPrice: it.unitPrice ?? null,
                lineTotal: it.lineTotal ?? null,
              }))
            : [],
          customerName: so.customerName ?? null,
          paid: so.status === "paid",
        };
      }
    }

    // The product price to display: the order's amount for a Staffly checkout,
    // otherwise the link's fixed amount (null = open / payer enters an amount).
    const amount = order?.amount ?? link.amount ?? null;

    // When the price is known, return the buyer-facing breakdown. The buyer pays
    // `total` (product + Velte commission + Paystack fee); `serviceFee` is the
    // bundled "Service fee" line (commission + fee). For open-amount links the
    // price is unknown until the payer types it, so these are null and the
    // frontend previews them client-side (re-derived here at charge time).
    const breakdown =
      amount != null && amount > 0 ? computeCharge(amount) : null;

    res.json({
      success: true,
      data: {
        linkId: link.linkId,
        accountName: link.accountName,
        bankName: link.bankName,
        description: link.description || "",
        amount,
        amountFixed: order != null || link.amount != null,
        currency: "NGN",
        order,
        serviceFee: breakdown ? breakdown.serviceFee : null,
        total: breakdown ? breakdown.total : null,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/pay/:linkId/initialize ──────────────────────────────────────────
// Body: { ref?, email?, amount?, customerName?, customerPhone? }
// Starts a Paystack checkout routed to the merchant's subaccount and returns the
// authorization URL for the popup.
export async function initializePayLink(req, res, next) {
  try {
    const { linkId } = req.params;
    const {
      ref,
      email,
      amount: bodyAmount,
      customerName,
      customerPhone,
    } = req.body;

    const link = await findActiveLink(linkId);

    if (!link.subaccountCode) {
      throw new AppError(
        "This payment link is not configured to accept payments",
        422,
      );
    }

    let order = null;
    if (ref) {
      order = await StafflyOrder.findOne({ orderId: ref }).lean();
      if (!order) throw new AppError("Order not found for this payment", 404);
      if (order.status === "paid") {
        throw new AppError("This order has already been paid", 409);
      }
    }

    // Authoritative product price: the Staffly order's amount when present
    // (customer cannot tamper), else the link's fixed amount, else what the payer
    // entered on an open-amount link. The seller receives this in full.
    const amount = order?.amount ?? link.amount ?? Number(bodyAmount);
    if (!amount || amount <= 0) {
      throw new AppError("A valid amount is required", 400);
    }

    // Gross up: the buyer is charged `total` (product + Velte commission +
    // Paystack fee). Computed server-side so the fee can never be tampered with.
    // See utils/commission.js + docs/commission-fees.md.
    const { commission, total, serviceFee } = computeCharge(amount);

    // Paystack requires an email. Prefer the order's, then a provided one, then
    // a synthetic address from the WhatsApp number (matches Staffly's invoice
    // convention) so the charge can always proceed.
    const payerEmail =
      order?.customerEmail ||
      email ||
      (order?.customerNumber ? `${order.customerNumber}@staffly.app` : null);
    if (!payerEmail) {
      throw new AppError("An email is required to complete payment", 400);
    }

    // Fresh, unique reference per attempt (Paystack rejects reuse). The order
    // identity travels in metadata.stafflyOrderId, not the reference.
    const reference = `vpl-${linkId}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

    const metadata = {
      type: "order",
      merchantId: link.userId.toString(),
      linkId,
      // Commission breakdown — the merchant keeps `productAmount`; Velte keeps
      // `commission`; the buyer pays `total`. Carried for reconciliation/receipts.
      productAmount: amount,
      commission,
      serviceFee,
      total,
      ...(order
        ? {
            stafflyOrderId: order.orderId,
            customerName: order.customerName ?? null,
            customerPhone: order.customerNumber ?? null,
            customerEmail: order.customerEmail ?? null,
            // Delivery address captured during the WhatsApp checkout — carried
            // through so the velte order can display it.
            deliveryAddress: order.location ?? null,
            // Per-variant breakdown for the fulfilment order. Prefer the lines
            // staffly stored (one per variant, e.g. 3 red + 1 black); fall back to
            // a single synthesised line for older orders without `items`, splitting
            // the grand total back into a per-unit price so it still shows "×N @ unit".
            items:
              Array.isArray(order.items) && order.items.length
                ? order.items.map((it) => ({
                    productId: order.productId ?? undefined,
                    name: it.name || order.product || "Order",
                    image: order.productImage ?? null,
                    variant: it.variant ?? null,
                    quantity: it.quantity >= 1 ? it.quantity : 1,
                    basePrice:
                      it.unitPrice ??
                      Math.round(
                        (it.lineTotal ?? 0) /
                          (it.quantity >= 1 ? it.quantity : 1),
                      ),
                    lineTotal: it.lineTotal ?? null,
                    attributes: Array.isArray(it.attributes)
                      ? it.attributes
                      : [],
                    modifiers: Array.isArray(it.modifiers) ? it.modifiers : [],
                  }))
                : [
                    {
                      productId: order.productId ?? undefined,
                      name: order.product || "Order",
                      image: order.productImage ?? null,
                      // `order.amount` is the grand total; split it back into the
                      // per-unit price so the fulfilment order shows "×N @ unit".
                      quantity: order.quantity >= 1 ? order.quantity : 1,
                      basePrice: Math.round(
                        order.amount /
                          (order.quantity >= 1 ? order.quantity : 1),
                      ),
                      lineTotal: order.amount,
                    },
                  ],
          }
        : {
            customerName: customerName ?? null,
            customerPhone: customerPhone ?? null,
          }),
    };

    const frontendBase = (
      process.env.FRONTEND_URL || "https://velte.ng"
    ).replace(/\/$/, "");
    const callbackUrl = `${frontendBase}/payment/callback?reference=${reference}`;

    const transaction = await initializeTransaction({
      email: payerEmail,
      amount: total, // buyer pays the grossed-up total (product + commission + fee)
      reference,
      metadata,
      callbackUrl,
      subaccount: link.subaccountCode,
      transactionCharge: commission, // flat commission routed to Velte's main account
      channels: ["card", "bank", "ussd", "bank_transfer"],
    });

    res.json({
      success: true,
      data: {
        authorization_url: transaction.authorization_url,
        access_code: transaction.access_code,
        reference: transaction.reference,
      },
    });
  } catch (err) {
    next(err);
  }
}
