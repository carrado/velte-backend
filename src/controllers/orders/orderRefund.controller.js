// src/controllers/orders/orderRefund.controller.js
// Temporary test version — Order lookup commented out, hardcoded bank details used directly.
// TODO: uncomment the Order lookup block when Order model has customerBank field.

import { validationResult } from "express-validator";
import crypto from "crypto";
import { AppError } from "../../middleware/errorHandler.js";
import {
  createTransferRecipient,
  initiateTransfer,
} from "../../services/paystack.service.js";

export async function initiateOrderRefund(req, res, next) {
  try {
    // ── 1. Validation ──────────────────────────────────────────────────────
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return next(new AppError(errors.array()[0].msg, 400));
    }

    const { orderId, amount, reason } = req.body;

    // ── 2. TODO: Replace this block with real Order lookup ─────────────────
    // Uncomment once your Order model has the customerBank field:
    //
    // const userId = req.user.userId;
    // const order = await Order.findOne({ _id: orderId, merchantId: userId })
    //   .select("status customerBank orderId amount")
    //   .lean();
    //
    // if (!order) return next(new AppError("Order not found.", 404));
    // if (order.status !== "Cancelled")
    //   return next(new AppError("Refunds can only be issued for cancelled orders.", 400));
    //
    // const { customerBank } = order;
    // if (!customerBank?.accountNumber || !customerBank?.bankCode || !customerBank?.accountName)
    //   return next(new AppError("No customer bank details on this order.", 422));

    // ── Hardcoded test values (remove once Order lookup above is active) ───
    const customerBank = {
      accountName: "CHUKWUEMEKA ISIDOR ANYANWU",
      accountNumber: "0788180507",
      bankCode: "044",
      bankName: "Access Bank",
    };

    // ── 3. Create Paystack transfer recipient for the customer ─────────────
    let recipientCode;
    try {
      recipientCode = await createTransferRecipient({
        accountName: customerBank.accountName,
        accountNumber: customerBank.accountNumber,
        bankCode: customerBank.bankCode,
      });
    } catch (err) {
      return next(
        new AppError(`Could not create transfer recipient: ${err.message}`, 502),
      );
    }

    // ── 4. Build idempotency reference and initiate transfer ───────────────
    const reference = `refund-${orderId}-${crypto.randomBytes(6).toString("hex")}`;

    let transferResult;
    try {
      transferResult = await initiateTransfer({
        recipientCode,
        amountNaira: amount,
        reason: reason ?? `Refund for order ${orderId}`,
        reference,
      });
    } catch (err) {
      return next(
        new AppError(`Transfer initiation failed: ${err.message}`, 502),
      );
    }

    // ── 5. Respond ─────────────────────────────────────────────────────────
    return res.status(200).json({
      success: true,
      message: "Refund transfer initiated successfully.",
      data: {
        transferCode: transferResult.transferCode,
        transferReference: reference,
        amount,
        status: transferResult.status,
        bankName: customerBank.bankName,
        accountNumber: customerBank.accountNumber.replace(
          /(\d{3})\d{4}(\d{3})/,
          "$1****$2",
        ),
      },
    });
  } catch (err) {
    next(err);
  }
}
