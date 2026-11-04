// Vendor side of cart checkout: list paid orders, accept one, dispatch,
// and mark delivered. Payout is NOT on accept — it waits for courier
// (or vendor-as-courier) delivery approval. See
// docs/velte-order-tracking-settlement-plan.md.

import Order from "../../models/Order.model.js";
import { AppError } from "../../middleware/errorHandler.js";
import { CONFIRMATION_WINDOW_HOURS } from "../../config/prices.js";
import { initiateTransfer } from "../../services/paystack.service.js";
import { presentOrder } from "../cart/cart.controller.js";
import { notifyOwner } from "../../services/pushNotification.service.js";

const OPEN_STATUSES = [
  "paid",
  "accepted",
  "dispatched",
  "delivered",
  "received",
  "disputed",
  "confirmed",
];

export async function listVendorOrders(req, res, next) {
  try {
    const vendorId = req.user?.userId;
    if (!vendorId) throw new AppError("Not authenticated.", 401);

    const status = req.query.status;
    const filter = { vendorId };
    if (typeof status === "string" && OPEN_STATUSES.includes(status)) {
      filter.status = status;
    } else {
      filter.status = { $in: OPEN_STATUSES };
    }

    const orders = await Order.find(filter).sort({ createdAt: -1 }).limit(50);
    res.json({
      success: true,
      data: { orders: orders.map(presentOrder) },
    });
  } catch (err) {
    next(err);
  }
}

export async function getVendorOrder(req, res, next) {
  try {
    const vendorId = req.user?.userId;
    if (!vendorId) throw new AppError("Not authenticated.", 401);

    const order = await Order.findById(req.params.id);
    if (!order || String(order.vendorId) !== String(vendorId)) {
      throw new AppError("Order not found.", 404);
    }
    res.json({ success: true, data: { order: presentOrder(order) } });
  } catch (err) {
    next(err);
  }
}

function loadVendorOrder(req) {
  const vendorId = req.user?.userId;
  if (!vendorId) throw new AppError("Not authenticated.", 401);
  return vendorId;
}

// POST /api/vendor/orders/:id/confirm  (and /accept)
// NEW meaning: accept the order. Tracking starts. Money does not move.
// A stale client that still hits /confirm on an already-accepted order
// gets 409 with the current row rather than a second transfer.
export async function confirmVendorOrder(req, res, next) {
  try {
    const vendorId = loadVendorOrder(req);
    const order = await Order.findById(req.params.id);
    if (!order || String(order.vendorId) !== String(vendorId)) {
      throw new AppError("Order not found.", 404);
    }

    // Already past accept — including a legacy confirmed+transferred row.
    if (order.status !== "paid") {
      if (order.status === "confirmed" && order.transferReference) {
        res.json({ success: true, data: { order: presentOrder(order) } });
        return;
      }
      if (order.acceptedAt || OPEN_STATUSES.includes(order.status)) {
        throw new AppError("This order has already been accepted.", 409, {
          order: presentOrder(order),
        });
      }
      throw new AppError("Only a paid order can be accepted.", 409);
    }

    order.status = "accepted";
    order.acceptedAt = new Date();
    if (!order.settlement || order.settlement === "none") {
      order.settlement = "escrowed";
    }
    await order.save();

    notifyOwner(
      { ownerId: String(order.buyerId), ownerType: "buyer" },
      {
        title: "Vendor accepted your order",
        body: `${order.items[0]?.name ?? "Your order"} is being prepared.`,
        url: `/chat/orders`,
        tag: `order-accepted:${order._id}`,
        type: "new-order",
        metadata: { orderId: String(order._id) },
      },
    ).catch((err) => {
      console.error("[orders] buyer notify failed:", err.message);
    });

    res.json({ success: true, data: { order: presentOrder(order) } });
  } catch (err) {
    next(err);
  }
}

export async function dispatchVendorOrder(req, res, next) {
  try {
    const vendorId = loadVendorOrder(req);
    const order = await Order.findById(req.params.id);
    if (!order || String(order.vendorId) !== String(vendorId)) {
      throw new AppError("Order not found.", 404);
    }
    if (order.status !== "accepted") {
      throw new AppError("Accept the order before dispatching it.", 409);
    }

    const method = req.body?.method === "courier" ? "courier" : "self";
    order.status = "dispatched";
    order.dispatchedAt = new Date();
    order.dispatch = {
      method,
      carrier: typeof req.body?.carrier === "string" ? req.body.carrier : null,
      trackingCode:
        typeof req.body?.trackingCode === "string" ? req.body.trackingCode : null,
      note: typeof req.body?.note === "string" ? req.body.note : null,
      photoUrls: Array.isArray(req.body?.photoUrls) ? req.body.photoUrls : [],
    };
    await order.save();

    notifyOwner(
      { ownerId: String(order.buyerId), ownerType: "buyer" },
      {
        title: "Your order is on the way",
        body: `${order.items[0]?.name ?? "Your order"} has been dispatched.`,
        url: `/chat/orders`,
        tag: `order-dispatched:${order._id}`,
        type: "new-order",
        metadata: { orderId: String(order._id) },
      },
    ).catch((err) => {
      console.error("[orders] buyer notify failed:", err.message);
    });

    res.json({ success: true, data: { order: presentOrder(order) } });
  } catch (err) {
    next(err);
  }
}

export async function deliverVendorOrder(req, res, next) {
  try {
    const vendorId = loadVendorOrder(req);
    const order = await Order.findById(req.params.id);
    if (!order || String(order.vendorId) !== String(vendorId)) {
      throw new AppError("Order not found.", 404);
    }
    if (order.status !== "dispatched" && order.status !== "accepted") {
      throw new AppError("This order is not out for delivery.", 409);
    }

    // Self-as-courier shortcut: accepted → handed over in one tap.
    if (order.status === "accepted") {
      order.dispatchedAt = order.dispatchedAt ?? new Date();
      order.dispatch = {
        method: "self",
        carrier: null,
        trackingCode: null,
        note: typeof req.body?.note === "string" ? req.body.note : null,
        photoUrls: Array.isArray(req.body?.photoUrls) ? req.body.photoUrls : [],
      };
    }

    order.status = "delivered";
    order.deliveredAt = new Date();
    order.courierApprovedAt = new Date();
    order.confirmBy = new Date(
      order.deliveredAt.getTime() + CONFIRMATION_WINDOW_HOURS * 60 * 60 * 1000,
    );
    await order.save();

    notifyOwner(
      { ownerId: String(order.buyerId), ownerType: "buyer" },
      {
        title: "Your order was delivered",
        body: `${order.items[0]?.name ?? "Your order"} was delivered. Confirm receipt within ${CONFIRMATION_WINDOW_HOURS} hours, or raise a dispute. If you do neither, the payout releases.`,
        url: `/chat/orders`,
        tag: `order-delivered:${order._id}`,
        type: "new-order",
        metadata: { orderId: String(order._id) },
      },
    ).catch((err) => {
      console.error("[orders] buyer notify failed:", err.message);
    });

    res.json({ success: true, data: { order: presentOrder(order) } });
  } catch (err) {
    next(err);
  }
}

/** Pay the vendor. Only after accept + courier approval, and only while
 *  still escrowed. Buyer confirm never calls this. */
export async function releaseFunds(order) {
  if (!order.acceptedAt || !order.courierApprovedAt) return order;
  if (order.settlement !== "escrowed") return order;
  if (!order.payoutRecipientCode) {
    order.settlement = "failed";
    await order.save();
    console.error(`[orders] DISPUTE-ready: no payout recipient on ${order._id}`);
    return order;
  }

  const transferReference = `vpay_${order._id}`;
  try {
    const transfer = await initiateTransfer({
      recipientCode: order.payoutRecipientCode,
      amountNaira: order.subtotalKobo / 100,
      reason: `Velte order ${order._id}`,
      reference: transferReference,
    });
    order.settlement = transfer?.status === "otp" ? "failed" : "releasing";
    order.transferReference = transferReference;
    order.transferCode = transfer?.transferCode ?? null;
    if (transfer?.status === "otp") {
      console.error(`[orders] transfer OTP required for ${order._id}`);
    }
    await order.save();
  } catch (err) {
    order.settlement = "failed";
    await order.save();
    throw new AppError(
      err instanceof Error
        ? err.message
        : "Couldn't send the payout. Try again in a moment.",
      502,
    );
  }
  return order;
}
