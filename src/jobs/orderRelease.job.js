import Order from "../models/Order.model.js";
import { CONFIRMATION_WINDOW_HOURS } from "../config/prices.js";
import { releaseFunds } from "../controllers/orders/vendorOrders.controller.js";
import { notifyOwner } from "../services/pushNotification.service.js";

// Q7. Delivery approval starts a confirmation window. The buyer can confirm
// (release now) or dispute (pause). Silence releases only after the deadline,
// and only when delivery evidence is already on the order.

const REMINDER_HOURS = 12;

export function confirmDeadline(from = new Date()) {
  return new Date(from.getTime() + CONFIRMATION_WINDOW_HOURS * 60 * 60 * 1000);
}

export async function sweepOrderReleases() {
  const now = new Date();
  const remindBefore = new Date(now.getTime() + REMINDER_HOURS * 60 * 60 * 1000);

  const due = await Order.find({
    status: "delivered",
    settlement: "escrowed",
    confirmBy: { $lte: now },
    courierApprovedAt: { $ne: null },
  });
  for (const order of due) {
    try {
      await releaseFunds(order);
    } catch (err) {
      console.error(`[orders] default release failed ${order._id}:`, err.message);
    }
  }

  const remind = await Order.find({
    status: "delivered",
    settlement: "escrowed",
    reminderSentAt: null,
    confirmBy: { $gt: now, $lte: remindBefore },
  });
  for (const order of remind) {
    order.reminderSentAt = now;
    await order.save();
    notifyOwner(
      { ownerId: String(order.buyerId), ownerType: "buyer" },
      {
        title: "Confirm your order",
        body: "Delivery was marked complete. Confirm receipt, or raise a dispute before the window closes. If you do neither, the payout releases.",
        url: "/chat/orders",
        tag: `order-reminder:${order._id}`,
        type: "new-order",
      },
    ).catch(() => {});
  }
}

export function startOrderReleaseCron() {
  const tick = () => {
    sweepOrderReleases().catch((err) => {
      console.error("[orders] release sweep failed:", err.message);
    });
  };
  setInterval(tick, 15 * 60 * 1000);
  setTimeout(tick, 20_000);
}
