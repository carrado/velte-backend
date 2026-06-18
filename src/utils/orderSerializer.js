// Maps an internal Order document onto the shapes orders-api.md exposes.
//
// Two responsibilities live here so the controllers stay thin:
//   1. status: internal PascalCase  ->  API snake_case (Order.model STATUS_TO_API)
//   2. money:  Naira (stored)        ->  kobo (NGN minor units, what the API uses)
//
// The frontend divides kobo by 100 for display; we never emit floats.

import { STATUS_TO_API } from "../models/Order.model.js";

const toKobo = (naira) => Math.round((naira ?? 0) * 100);

const toIso = (d) => (d instanceof Date ? d.toISOString() : d ?? null);

// A stable, human-friendly reference. Prefers the persisted orderId; otherwise
// derives a short ref from the Mongo _id so every order still shows something.
const referenceFor = (order) =>
  order.orderId || `#ORD-${order._id.toString().slice(-6).toUpperCase()}`;

/**
 * List-row shape (GET /api/orders). Deliberately omits all customer PII —
 * phone/email/address are returned only by the detail endpoint.
 */
export function serializeOrderRow(order) {
  const primary = order.items?.[0];
  return {
    id: order._id.toString(),
    reference: referenceFor(order),
    product_name: primary?.name ?? "Order",
    product_image: primary?.image ?? null, // snapshot of Product.mainImageUrl
    product_initials: null, // frontend derives from name when null
    product_color: null, // frontend defaults to gray when null
    total_amount: toKobo(order.amount),
    payment_status: order.paymentStatus || (order.paystackReference ? "paid" : "unpaid"),
    status: STATUS_TO_API[order.status] ?? "pending",
    created_at: toIso(order.createdAt),
  };
}

/**
 * Detail shape (GET /api/orders/:id) — all list-row fields plus line/customer/
 * fulfillment data. `businessType` decides which estimate fields are relevant and
 * supplies the food prep-time fallback from the vendor's preferences.
 */
export function serializeOrderDetail(order, { businessType = "retail", defaultPrepMins = null } = {}) {
  const items = order.items ?? [];
  const primary = items[0];
  const quantity = items.reduce((sum, i) => sum + (i.quantity ?? 0), 0);
  const subtotal = items.reduce((sum, i) => sum + (i.lineTotal ?? 0), 0);

  const isFood = businessType === "food";

  return {
    ...serializeOrderRow(order),
    quantity,
    unit_price: toKobo(primary?.basePrice),
    subtotal: toKobo(subtotal),
    delivery_fee: toKobo(order.deliveryFee),
    payment_method: order.paymentMethod ?? null,
    sku: primary?.sku ?? null,
    notes: order.notes ?? null,
    customer: {
      name: order.customerName ?? null,
      phone: order.customerPhone ?? null,
      email: order.customerEmail ?? null,
      address: order.customerAddress ?? null,
    },
    fulfillment_type: order.fulfillmentType ?? "delivery",
    delivery_address: order.deliveryAddress ?? null,
    carrier: isFood ? null : order.carrier ?? null,
    estimated_delivery: isFood ? null : order.estimatedDelivery ?? null,
    estimated_prep_mins: isFood ? order.estimatedPrepMins ?? defaultPrepMins : null,
    updated_at: toIso(order.updatedAt),
  };
}
