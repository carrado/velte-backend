// src/controllers/orders/orderRefund.controller.js
//
// Records a refund for a cancelled order. Orders are paid by MANUAL bank transfer
// (no Paystack charge exists to reverse), so the vendor sends the money back to the
// customer out-of-band and then records that transfer here. We do NOT move money
// from this endpoint — we persist a refund record from the fields the caller supplies.
//
// The frontend calls this BEFORE moving the order to `cancelled` (see orders-api.md).
// It is idempotent: a second attempt on an already-recorded refund is a no-op success.

import { validationResult } from "express-validator";
import { AppError } from "../../middleware/errorHandler.js";
import Order from "../../models/Order.model.js";

export async function initiateOrderRefund(req, res, next) {
  try {
    // ── 1. Validation ──────────────────────────────────────────────────────────
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return next(new AppError(errors.array()[0].msg, 400));
    }

    const { orderId, amount, refundReference, status, reason } = req.body;
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

    // Only a paid order can be refunded.
    if (order.paymentStatus !== "paid") {
      return next(
        new AppError("This order has no completed payment to refund.", 422),
      );
    }

    // ── 3. Idempotency ─────────────────────────────────────────────────────────
    // A refund already recorded → don't overwrite it; echo what we have.
    if (order.refund?.status === "processed" || order.refund?.status === "pending") {
      return res.status(200).json({
        success: true,
        message: "Refund already recorded for this order.",
        refund: {
          refundReference: order.refund.reference,
          amount: order.refund.amount ?? amount,
          status: order.refund.status,
        },
      });
    }

    // ── 4. Persist the refund record ───────────────────────────────────────────
    // The vendor performed the bank transfer manually; we store the reference they
    // supplied. Default to `processed` since recording implies the money was sent.
    const recordedStatus = status ?? "processed";
    order.refund = {
      status: recordedStatus,
      reference: refundReference,
      amount,
      reason: reason ?? null,
      refundedAt: new Date(),
    };
    await order.save();

    // ── 5. Respond ─────────────────────────────────────────────────────────────
    return res.status(200).json({
      success: true,
      message: "Refund recorded successfully.",
      refund: {
        refundReference: order.refund.reference,
        amount,
        status: recordedStatus,
      },
    });
  } catch (err) {
    next(err);
  }
}
