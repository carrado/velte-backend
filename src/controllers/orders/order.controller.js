import Order, { RETAIL_TRANSITIONS, FOOD_TRANSITIONS } from "../../models/Order.model.js";
import User from "../../models/Users.js";
import AISetup from "../../models/AiSetup.model.js";
import { dispatchToStaffly } from "../../utils/stafflyWebhook.js";

export const createOrder = async (req, res) => {
  try {
    const merchantId = req.user.userId;
    const { items, customerName, customerPhone, customerBank, notes } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "Order must have at least one item" });
    }

    const amount = items.reduce((sum, item) => sum + (item.lineTotal ?? 0), 0);

    const order = await Order.create({
      merchantId,
      items,
      amount,
      customerName,
      customerPhone,
      customerBank,
      notes,
    });

    AISetup.findOne({ userId: merchantId }).select('selectedNumberId').then((aiSetup) => {
      if (aiSetup?.selectedNumberId) {
        dispatchToStaffly('order.created', aiSetup.selectedNumberId, {
          orderId: order.orderId ?? order._id.toString(),
          customerName,
          customerPhone,
          items: items.map((i) => ({ name: i.name, quantity: i.quantity, lineTotal: i.lineTotal ?? 0 })),
          amount,
        });
      }
    }).catch(() => {});

    res.status(201).json({ success: true, order });
  } catch (error) {
    console.error("Create order error:", error);
    res.status(500).json({ message: "Failed to create order" });
  }
};

export const getOrders = async (req, res) => {
  try {
    const orders = await Order.find({ merchantId: req.user.userId }).sort({ createdAt: -1 });
    res.status(200).json({ success: true, orders });
  } catch (error) {
    console.error("Get orders error:", error);
    res.status(500).json({ message: "Failed to fetch orders" });
  }
};

export const getOrder = async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, merchantId: req.user.userId });

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    res.status(200).json({ success: true, order });
  } catch (error) {
    console.error("Get order error:", error);
    res.status(500).json({ message: "Failed to fetch order" });
  }
};

export const updateOrderStatus = async (req, res) => {
  try {
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({ message: "status is required" });
    }

    const user = await User.findById(req.user.userId).select("businessType");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const order = await Order.findOne({ _id: req.params.id, merchantId: req.user.userId });
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    const businessType = user.businessType || 'retail';
    const transitions = businessType === 'food' ? FOOD_TRANSITIONS : RETAIL_TRANSITIONS;
    const allowed = transitions[order.status] ?? [];

    if (!allowed.includes(status)) {
      return res.status(422).json({
        message: `Cannot transition from '${order.status}' to '${status}' for a ${businessType} vendor`,
      });
    }

    // Guard: food-specific statuses blocked for retail
    if (businessType === 'retail' && ['Preparing', 'Ready', 'OnTheWay'].includes(status)) {
      return res.status(422).json({ message: "Invalid status for retail vendor" });
    }

    // Guard: retail-specific status blocked for food
    if (businessType === 'food' && status === 'Shipped') {
      return res.status(422).json({ message: "Invalid status for food vendor" });
    }

    const previousStatus = order.status;
    order.status = status;
    await order.save();

    AISetup.findOne({ userId: req.user.userId }).select('selectedNumberId').then((aiSetup) => {
      if (aiSetup?.selectedNumberId) {
        dispatchToStaffly('order.status_changed', aiSetup.selectedNumberId, {
          orderId: order.orderId ?? order._id.toString(),
          customerPhone: order.customerPhone,
          newStatus: status,
          previousStatus,
          ...(status === 'Cancelled' && req.body.cancellationReason
            ? { cancellationReason: req.body.cancellationReason }
            : {}),
        });
      }
    }).catch(() => {});

    res.status(200).json({ success: true, order });
  } catch (error) {
    console.error("Update order status error:", error);
    res.status(500).json({ message: "Failed to update order status" });
  }
};
