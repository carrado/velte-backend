import Order, {
  RETAIL_TRANSITIONS,
  FOOD_TRANSITIONS,
  STATUS_TO_API,
  STATUS_FROM_API,
  VALID_API_STATUSES,
} from "../../models/Order.model.js";
import User from "../../models/Users.js";
import Product from "../../models/Product.model.js";
import AISetup from "../../models/AiSetup.model.js";
import { dispatchToStaffly } from "../../utils/stafflyWebhook.js";
import { sendOrderTrackingEmail } from "../../helpers/emailSender.js";
import {
  serializeOrderRow,
  serializeOrderDetail,
} from "../../utils/orderSerializer.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

// Error envelope shared by every documented endpoint (orders-api.md → "Error format").
const sendError = (res, httpStatus, code, message, fields) => {
  const error = { code, message };
  if (fields) error.fields = fields;
  return res.status(httpStatus).json({ success: false, error });
};

// `search` is matched literally (case-insensitive) — never interpolated into a query.
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// `tab` -> the internal statuses it groups, per business type.
const TAB_STATUSES = {
  retail: {
    pending: ["Pending"],
    completed: ["Delivered", "Shipped"],
    cancelled: ["Cancelled"],
  },
  food: {
    pending: ["Pending", "Preparing", "Ready", "OnTheWay"],
    completed: ["Delivered"],
    cancelled: ["Cancelled"],
  },
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── Create order ─────────────────────────────────────────────────────────────
// Not part of orders-api.md (orders are normally born from the pay page / Staffly
// bridge). Kept for merchant-created orders; legacy response shape.
export const createOrder = async (req, res) => {
  try {
    const merchantId = req.user.userId;
    const { items, customerName, customerPhone, customerEmail, customerBank, notes } = req.body;

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
      customerEmail,
      customerBank,
      notes,
    });

    const orderRef = order.orderId ?? `#ORD-${order._id.toString().slice(-6).toUpperCase()}`;

    // Email the customer their tracking key on order creation (fire-and-forget).
    if (order.customerEmail) {
      sendOrderTrackingEmail(order.customerEmail, order.customerName, order.trackingKey, orderRef).catch(
        (e) => console.error("Create order tracking email failed:", e.message),
      );
    }

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

// ── List orders ──────────────────────────────────────────────────────────────
// GET /api/orders — server-driven pagination/filter/search/sort, vendor-scoped,
// PII-free list rows.
export const getOrders = async (req, res) => {
  try {
    const merchantId = req.user.userId;
    const {
      tab,
      search,
      payment_status,
      start_date,
      end_date,
      sort_by = "created_at",
      sort_order = "desc",
    } = req.query;

    // ── Validate enumerated params (reject unknown rather than ignore) ──────────
    if (tab !== undefined && !["completed", "pending", "cancelled"].includes(tab)) {
      return sendError(res, 400, "VALIDATION_ERROR", "Validation failed", { tab: `Unknown tab '${tab}'` });
    }
    if (payment_status !== undefined && !["paid", "unpaid"].includes(payment_status)) {
      return sendError(res, 400, "VALIDATION_ERROR", "Validation failed", {
        payment_status: `Unknown payment_status '${payment_status}'`,
      });
    }
    if (!["created_at", "price"].includes(sort_by)) {
      return sendError(res, 400, "VALIDATION_ERROR", "Validation failed", { sort_by: `Unknown sort_by '${sort_by}'` });
    }
    if (!["asc", "desc"].includes(sort_order)) {
      return sendError(res, 400, "VALIDATION_ERROR", "Validation failed", {
        sort_order: `Unknown sort_order '${sort_order}'`,
      });
    }
    if (start_date !== undefined && !DATE_RE.test(start_date)) {
      return sendError(res, 400, "VALIDATION_ERROR", "Validation failed", { start_date: "Expected YYYY-MM-DD" });
    }
    if (end_date !== undefined && !DATE_RE.test(end_date)) {
      return sendError(res, 400, "VALIDATION_ERROR", "Validation failed", { end_date: "Expected YYYY-MM-DD" });
    }

    // ── Clamp pagination ───────────────────────────────────────────────────────
    let page = parseInt(req.query.page, 10);
    let limit = parseInt(req.query.limit, 10);
    page = Number.isNaN(page) || page < 1 ? 1 : page;
    limit = Number.isNaN(limit) ? 10 : Math.min(Math.max(limit, 1), 50);

    // businessType drives the tab → status mapping.
    const user = await User.findById(merchantId).select("businessType").lean();
    const businessType = user?.businessType === "food" ? "food" : "retail";

    // ── Build the (always vendor-scoped) filter ────────────────────────────────
    const filter = { merchantId };

    if (tab) {
      filter.status = { $in: TAB_STATUSES[businessType][tab] };
    }
    if (payment_status) {
      filter.paymentStatus = payment_status;
    }
    if (search) {
      const rx = new RegExp(escapeRegex(search), "i");
      filter.$or = [{ orderId: rx }, { "items.name": rx }];
    }
    if (start_date || end_date) {
      filter.createdAt = {};
      if (start_date) filter.createdAt.$gte = new Date(`${start_date}T00:00:00.000Z`);
      if (end_date) filter.createdAt.$lte = new Date(`${end_date}T23:59:59.999Z`);
    }

    const sortField = sort_by === "price" ? "amount" : "createdAt";
    const sortDir = sort_order === "asc" ? 1 : -1;

    const [orders, total] = await Promise.all([
      Order.find(filter)
        .sort({ [sortField]: sortDir })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Order.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        orders: orders.map(serializeOrderRow),
        pagination: {
          total,
          page,
          limit,
          total_pages: Math.ceil(total / limit) || 0,
        },
      },
    });
  } catch (error) {
    console.error("Get orders error:", error);
    return sendError(res, 500, "INTERNAL_ERROR", "Failed to fetch orders");
  }
};

// ── Order stats ──────────────────────────────────────────────────────────────
// GET /api/orders/stats — four cards over a trailing 7-day window vs the prior 7.
export const getOrderStats = async (req, res) => {
  try {
    const merchantId = req.user.userId;

    const now = new Date();
    const DAY = 24 * 60 * 60 * 1000;
    const d7 = new Date(now.getTime() - 7 * DAY);
    const d14 = new Date(now.getTime() - 14 * DAY);

    const window = (gte, lt, extra = {}) => ({
      merchantId,
      createdAt: { $gte: gte, $lt: lt },
      ...extra,
    });

    const [
      totalCur,
      totalPrev,
      newCur,
      newPrev,
      completedCur,
      cancelledCur,
      cancelledPrev,
    ] = await Promise.all([
      Order.countDocuments(window(d7, now)),
      Order.countDocuments(window(d14, d7)),
      Order.countDocuments(window(d7, now, { status: "Pending" })),
      Order.countDocuments(window(d14, d7, { status: "Pending" })),
      Order.countDocuments(window(d7, now, { status: "Delivered" })),
      Order.countDocuments(window(d7, now, { status: "Cancelled" })),
      Order.countDocuments(window(d14, d7, { status: "Cancelled" })),
    ]);

    // % change vs the previous window, 1 decimal place. No prior data → 100% if
    // there's anything now, else 0.
    const growth = (cur, prev) => {
      if (!prev) return cur ? 100 : 0;
      return Math.round(((cur - prev) / prev) * 1000) / 10;
    };
    const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);

    return res.status(200).json({
      success: true,
      data: {
        total_orders: { value: totalCur, growth: growth(totalCur, totalPrev) },
        new_orders: { value: newCur, growth: growth(newCur, newPrev) },
        completed_orders: { value: completedCur, percentage: pct(completedCur, totalCur) },
        canceled_orders: { value: cancelledCur, growth: growth(cancelledCur, cancelledPrev) },
      },
    });
  } catch (error) {
    console.error("Get order stats error:", error);
    return sendError(res, 500, "INTERNAL_ERROR", "Failed to fetch order stats");
  }
};

// ── Get single order ─────────────────────────────────────────────────────────
// GET /api/orders/:id — full detail incl. customer PII. Another vendor's id 404s.
export const getOrder = async (req, res) => {
  try {
    const merchantId = req.user.userId;

    let order;
    try {
      order = await Order.findOne({ _id: req.params.id, merchantId }).lean();
    } catch (err) {
      // Malformed ObjectId — treat as not found so ids can't be probed.
      if (err?.name === "CastError") {
        return sendError(res, 404, "NOT_FOUND", "Order not found");
      }
      throw err;
    }

    if (!order) {
      return sendError(res, 404, "NOT_FOUND", "Order not found");
    }

    const user = await User.findById(merchantId).select("businessType preferences.foodSettings").lean();
    const businessType = user?.businessType === "food" ? "food" : "retail";
    const defaultPrepMins = user?.preferences?.foodSettings?.estimatedPrepMins ?? null;

    // Fallback for orders created before image snapshots (or merchant-created
    // orders that only carry a productId): resolve the current product photo.
    // Single doc lookup — fine on the detail endpoint (never on the list).
    const primary = order.items?.[0];
    if (primary && !primary.image && primary.productId) {
      const product = await Product.findById(primary.productId).select("mainImageUrl").lean();
      if (product?.mainImageUrl) primary.image = product.mainImageUrl;
    }

    return res.status(200).json({
      success: true,
      data: serializeOrderDetail(order, { businessType, defaultPrepMins }),
    });
  } catch (error) {
    console.error("Get order error:", error);
    return sendError(res, 500, "INTERNAL_ERROR", "Failed to fetch order");
  }
};

// ── Update order status ──────────────────────────────────────────────────────
// PATCH /api/orders/:id/status — validates ownership, business-type validity, and
// legal transition before persisting. Cancellation here is status-only; the refund
// is a separate privileged call the frontend makes first.
export const updateOrderStatus = async (req, res) => {
  try {
    const merchantId = req.user.userId;
    const { status } = req.body;

    if (!status || typeof status !== "string") {
      return sendError(res, 400, "VALIDATION_ERROR", "Validation failed", { status: "status is required" });
    }

    // Must be a known API status at all.
    if (!STATUS_FROM_API[status]) {
      return sendError(res, 400, "VALIDATION_ERROR", "Validation failed", { status: `Unknown status '${status}'` });
    }

    const user = await User.findById(merchantId).select("businessType").lean();
    const businessType = user?.businessType === "food" ? "food" : "retail";

    // Status must be valid for this vendor's business type (e.g. retail → 'ready' is 400).
    if (!VALID_API_STATUSES[businessType].includes(status)) {
      return sendError(res, 400, "VALIDATION_ERROR", "Validation failed", {
        status: `Status '${status}' is not valid for a ${businessType} vendor`,
      });
    }

    let order;
    try {
      order = await Order.findOne({ _id: req.params.id, merchantId });
    } catch (err) {
      if (err?.name === "CastError") {
        return sendError(res, 404, "NOT_FOUND", "Order not found");
      }
      throw err;
    }
    if (!order) {
      return sendError(res, 404, "NOT_FOUND", "Order not found");
    }

    const targetInternal = STATUS_FROM_API[status];
    const transitions = businessType === "food" ? FOOD_TRANSITIONS : RETAIL_TRANSITIONS;
    const allowed = transitions[order.status] ?? [];

    if (!allowed.includes(targetInternal)) {
      return sendError(res, 409, "CONFLICT", "Validation failed", {
        status: `Illegal transition from ${STATUS_TO_API[order.status]} to ${status}`,
      });
    }

    const previousInternal = order.status;
    order.status = targetInternal;
    await order.save();

    // Fire-and-forget Staffly notification (keeps the WhatsApp side in sync).
    AISetup.findOne({ userId: merchantId }).select("selectedNumberId").then((aiSetup) => {
      if (aiSetup?.selectedNumberId) {
        dispatchToStaffly("order.status_changed", aiSetup.selectedNumberId, {
          orderId: order.orderId ?? order._id.toString(),
          customerPhone: order.customerPhone,
          newStatus: targetInternal,
          previousStatus: previousInternal,
          ...(targetInternal === "Cancelled" && req.body.cancellationReason
            ? { cancellationReason: req.body.cancellationReason }
            : {}),
        });
      }
    }).catch(() => {});

    return res.status(200).json({ success: true, data: serializeOrderRow(order) });
  } catch (error) {
    console.error("Update order status error:", error);
    return sendError(res, 500, "INTERNAL_ERROR", "Failed to update order status");
  }
};
