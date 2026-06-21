import Order from "../../models/Order.model.js";
import User from "../../models/Users.js";
import Product from "../../models/Product.model.js";

/**
 * Public customer order tracking — POST /api/track/:token  body: { key }
 *
 * No auth: the (token, key) pair is the capability. The token arrives in the URL
 * (sent to the customer's WhatsApp); the key is typed by the customer (emailed to
 * them on order creation). Both must match for the order to be revealed.
 *
 * Status codes are chosen deliberately:
 *   200 → { success: true, data: TrackOrderData }
 *   403 → key missing / wrong   (NOT 401 — the velte frontend's apiClient treats
 *                                any 401 as an auth failure and redirects to the
 *                                vendor login, which would break this public page)
 *   404 → unknown token
 *
 * The payload is the public-safe subset of an order. Unlike the authenticated
 * orders API (kobo + snake_case statuses), this returns Naira whole units and the
 * stored PascalCase status, which is what the /track frontend type expects.
 */

// Mirror of orderSerializer's referenceFor (not exported there) — a stable,
// human-friendly order reference.
const referenceFor = (order) =>
  order.orderId || `#ORD-${order._id.toString().slice(-6).toUpperCase()}`;

export async function trackOrder(req, res) {
  try {
    const { token } = req.params;
    const key = typeof req.body?.key === "string" ? req.body.key.trim() : "";

    if (!key) {
      return res.status(403).json({
        success: false,
        message: "Please enter your tracking key.",
      });
    }

    let order;
    try {
      // trackingKey is select:false — pull it explicitly, only here.
      order = await Order.findOne({ trackingToken: token })
        .select("+trackingKey")
        .lean();
    } catch (err) {
      if (err?.name === "CastError") {
        return res.status(404).json({ success: false, message: "Order not found." });
      }
      throw err;
    }

    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found." });
    }

    // Case-insensitive compare — the key alphabet is uppercase, but customers may
    // type lowercase. Wrong key is 403, never 401.
    if (!order.trackingKey || key.toUpperCase() !== order.trackingKey.toUpperCase()) {
      return res.status(403).json({
        success: false,
        message: "That key doesn't match this order. Please check and try again.",
      });
    }

    // Store name + business type from the merchant record.
    const user = await User.findById(order.merchantId)
      .select("name company.name businessType")
      .lean();
    const businessType = user?.businessType === "food" ? "food" : "retail";
    const storeName = user?.company?.name || user?.name || "the store";

    const items = order.items ?? [];
    const primary = items[0] ?? null;
    const quantity = items.reduce((sum, i) => sum + (i.quantity ?? 0), 0);

    // Resolve a product image: prefer the order-time snapshot, fall back to the
    // current product photo (older orders / merchant-created orders).
    let image = primary?.image ?? null;
    if (!image && primary?.productId) {
      const product = await Product.findById(primary.productId).select("mainImageUrl").lean();
      if (product?.mainImageUrl) image = product.mainImageUrl;
    }

    const isFood = businessType === "food";

    return res.status(200).json({
      success: true,
      data: {
        token: order.trackingToken,
        orderRef: referenceFor(order),
        storeName,
        businessType,
        status: order.status, // PascalCase, matches frontend OrderStatus
        payment: order.paymentStatus === "paid" ? "Paid" : "Unpaid",
        customerName: order.customerName ?? null,
        product: {
          name: primary?.name ?? "Order",
          image,
          quantity: quantity || 1,
          unitPrice: primary?.basePrice ?? 0, // Naira whole units
        },
        total: order.amount ?? 0, // Naira whole units
        currency: "NGN",
        placedAt: order.createdAt,
        updatedAt: order.updatedAt,
        fulfillment: {
          type: order.fulfillmentType ?? "delivery",
          address: order.deliveryAddress ?? order.customerAddress ?? null,
          carrier: isFood ? null : order.carrier ?? null,
          estimate: isFood ? null : order.estimatedDelivery ?? null,
          estimatedPrepMins: isFood ? order.estimatedPrepMins ?? null : null,
        },
      },
    });
  } catch (error) {
    console.error("Track order error:", error);
    return res.status(500).json({ success: false, message: "Failed to load order." });
  }
}
