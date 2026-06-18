// src/controllers/orders/orderRefund.controller.js
//
// Refunds a cancelled order back to the customer's ORIGINAL Paystack payment
// source (card/bank). We deliberately do NOT collect or transfer to customer bank
// details — the buyer paid online, so Paystack reverses that exact charge.
//
// This is the privileged, money-moving step. The frontend calls it BEFORE moving
// the order to `cancelled` (see orders-api.md). It is idempotent: a second attempt
// on an already-refunded order is a no-op success.

import { validationResult } from "express-validator";
import { AppError } from "../../middleware/errorHandler.js";
import Order from "../../models/Order.model.js";
import { refundTransaction } from "../../services/paystack.service.js";

export async function initiateOrderRefund(req, res, next) {
  try {
    // ── 1. Validation ──────────────────────────────────────────────────────────
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return next(new AppError(errors.array()[0].msg, 400));
    }

    const { orderId, amount, reason } = req.body;
    const merchantId = req.user.userId;

    // ── 2. Resolve & authorize the order ───────────────────────────────────────
    let order;
    try {
      order = await Order.findOne({ _id: orderId, merchantId });
    } catch (err) {
      if (err?.name === "CastError") return next(new AppError("Order not found.", 404));
      throw err;
    }
    if (!order) return next(new AppError("Order not found.", 404));

    // Only online (Paystack) payments can be refunded to source.
    if (order.paymentStatus !== "paid" || !order.paystackReference) {
      return next(
        new AppError("This order has no online payment to refund.", 422),
      );
    }

    // ── 3. Idempotency ─────────────────────────────────────────────────────────
    // A refund already in flight or done → don't fire a second one.
    if (order.refund?.status === "processed" || order.refund?.status === "pending") {
      return res.status(200).json({
        success: true,
        message: "Refund already initiated for this order.",
        data: {
          refundReference: order.refund.reference,
          amount: order.refund.amount ?? amount,
          status: order.refund.status,
        },
      });
    }

    // ── 4. Issue the refund to the original payment source ─────────────────────
    let refund;
    try {
      refund = await refundTransaction({
        reference: order.paystackReference,
        amountKobo: Math.round(amount * 100), // request body amount is in Naira
        reason: reason ?? `Refund for order ${order.orderId ?? order._id}`,
      });
    } catch (err) {
      // Record the failure so the UI can show it, then surface the error.
      order.refund = {
        ...(order.refund?.toObject?.() ?? order.refund ?? {}),
        status: "failed",
      };
      await order.save().catch(() => {});
      return next(new AppError(`Refund failed: ${err.message}`, 502));
    }

    // ── 5. Persist refund state ────────────────────────────────────────────────
    // Paystack refund status: pending | processing | processed | failed.
    const status = refund?.status === "processed" ? "processed" : "pending";
    order.refund = {
      status,
      reference: refund?.id ? String(refund.id) : order.paystackReference,
      amount,
      refundedAt: new Date(),
    };
    await order.save();

    // ── 6. Respond ─────────────────────────────────────────────────────────────
    return res.status(200).json({
      success: true,
      message: "Refund initiated successfully.",
      data: {
        refundReference: order.refund.reference,
        amount,
        status,
      },
    });
  } catch (err) {
    next(err);
  }
}
