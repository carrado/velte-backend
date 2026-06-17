import crypto from "crypto";
import PaymentLink from "../../models/Paymentlink.model.js";
import StafflyOrder from "../../models/StafflyOrder.model.js";
import { initializeTransaction } from "../../services/paystack.service.js";
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
    PaymentLink.updateOne({ _id: link._id }, { $inc: { clickCount: 1 } }).catch(() => {});

    let order = null;
    if (ref) {
      const so = await StafflyOrder.findOne({ orderId: ref })
        .select("orderId product amount customerName status")
        .lean();
      if (so) {
        order = {
          ref: so.orderId,
          product: so.product,
          amount: so.amount,
          customerName: so.customerName ?? null,
          paid: so.status === "paid",
        };
      }
    }

    // The amount to display/charge: the order's amount for a Staffly checkout,
    // otherwise the link's fixed amount (null = open / payer enters an amount).
    const amount = order?.amount ?? link.amount ?? null;

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
    const { ref, email, amount: bodyAmount, customerName, customerPhone } = req.body;

    const link = await findActiveLink(linkId);

    if (!link.subaccountCode) {
      throw new AppError("This payment link is not configured to accept payments", 422);
    }

    let order = null;
    if (ref) {
      order = await StafflyOrder.findOne({ orderId: ref }).lean();
      if (!order) throw new AppError("Order not found for this payment", 404);
      if (order.status === "paid") {
        throw new AppError("This order has already been paid", 409);
      }
    }

    // Authoritative amount: the Staffly order's amount when present (customer
    // cannot tamper), else the link's fixed amount, else what the payer entered
    // on an open-amount link.
    const amount = order?.amount ?? link.amount ?? Number(bodyAmount);
    if (!amount || amount <= 0) {
      throw new AppError("A valid amount is required", 400);
    }

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
      ...(order
        ? {
            stafflyOrderId: order.orderId,
            customerName: order.customerName ?? null,
            customerPhone: order.customerNumber ?? null,
            items: [
              {
                name: order.product || "Order",
                quantity: 1,
                basePrice: order.amount,
                lineTotal: order.amount,
              },
            ],
          }
        : {
            customerName: customerName ?? null,
            customerPhone: customerPhone ?? null,
          }),
    };

    const frontendBase = (process.env.FRONTEND_URL || "https://velte.ng").replace(/\/$/, "");
    const callbackUrl = `${frontendBase}/payment/callback?reference=${reference}`;

    const transaction = await initializeTransaction({
      email: payerEmail,
      amount,
      reference,
      metadata,
      callbackUrl,
      subaccount: link.subaccountCode,
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
