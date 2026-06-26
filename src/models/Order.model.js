import mongoose from "mongoose";
import crypto from "crypto";

// ── Customer order-tracking credentials ────────────────────────────────────────
// Every order gets an opaque `trackingToken` (goes in the public /track/:token
// URL, sent to the customer's WhatsApp) and a short `trackingKey` (the secret the
// customer types on the page, emailed to them). The pair gates the public page so
// a leaked link alone reveals nothing.
//
// The key alphabet excludes ambiguous characters (no 0/O, 1/I) so it survives
// being read off an email and typed by a human.
const KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateTrackingToken() {
  return crypto.randomBytes(16).toString("hex"); // 32 hex chars, unguessable
}

export function generateTrackingKey(length = 6) {
  let key = "";
  for (let i = 0; i < length; i++) {
    key += KEY_ALPHABET[crypto.randomInt(KEY_ALPHABET.length)];
  }
  return key;
}

// Legal status transitions, keyed by the internal (PascalCase) status.
// `cancelled` is only reachable from `pending`; once an order is shipped/preparing
// or later it can no longer be cancelled. `Delivered`/`Cancelled` are terminal.
// (See orders-api.md → "Status lifecycle".)
export const RETAIL_TRANSITIONS = {
  Pending: ["Shipped", "Cancelled"],
  Shipped: ["Delivered"],
  Delivered: [],
  Cancelled: [],
};

export const FOOD_TRANSITIONS = {
  Pending: ["Preparing", "Cancelled"],
  Preparing: ["Ready"],
  Ready: ["OnTheWay"],
  OnTheWay: ["Delivered"],
  Delivered: [],
  Cancelled: [],
};

// Internal (stored) status <-> the snake_case `status` the Orders API exposes.
// The model and the Staffly bridge stay on PascalCase; only the HTTP layer maps.
export const STATUS_TO_API = {
  Pending: "pending",
  Preparing: "preparing",
  Ready: "ready",
  OnTheWay: "on_the_way",
  Shipped: "shipped",
  Delivered: "delivered",
  Cancelled: "cancelled",
};

export const STATUS_FROM_API = Object.fromEntries(
  Object.entries(STATUS_TO_API).map(([internal, api]) => [api, internal]),
);

// Which API statuses are valid for each business type. A retail vendor moving an
// order into a food-only status (or vice versa) is a 400, not a 409.
export const VALID_API_STATUSES = {
  retail: ["pending", "shipped", "delivered", "cancelled"],
  food: [
    "pending",
    "preparing",
    "ready",
    "on_the_way",
    "delivered",
    "cancelled",
  ],
};

const chosenModifierSchema = new mongoose.Schema(
  {
    modifierName: { type: String, required: true },
    optionName: { type: String, required: true },
    additionalPrice: { type: Number, default: 0 },
  },
  { _id: false },
);

const orderItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
    name: { type: String, required: true },
    // Snapshot of the product photo at order time, so the orders UI can show it
    // without an extra products lookup (and without breaking if the product is
    // later edited/deleted). Sourced from Product.mainImageUrl up the chain.
    image: { type: String, default: null },
    sku: { type: String, default: null },
    quantity: { type: Number, required: true, min: 1 },
    basePrice: { type: Number, required: true },
    chosenModifiers: { type: [chosenModifierSchema], default: [] },
    lineTotal: { type: Number, required: true },
  },
  { _id: false },
);

const orderSchema = new mongoose.Schema(
  {
    merchantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    orderId: {
      type: String,
      unique: true,
      sparse: true,
    },
    status: {
      type: String,
      enum: [
        "Pending",
        "Shipped",
        "Delivered",
        "Cancelled",
        "Preparing",
        "Ready",
        "OnTheWay",
      ],
      default: "Pending",
    },
    items: { type: [orderItemSchema], default: [] },
    // Monetary amounts are stored in Naira (whole units); the HTTP layer converts
    // to/from kobo, which is what orders-api.md exposes to the frontend.
    amount: { type: Number, default: 0 }, // grand total = subtotal + deliveryFee
    deliveryFee: { type: Number, default: 0 },
    paymentStatus: {
      // 'awaiting_confirmation' = a manual-transfer receipt was AI-verified but the
      // order is high-value / a first-time buyer, so it's held for the vendor to
      // confirm in the dashboard before it counts as paid.
      type: String,
      enum: ["paid", "unpaid", "awaiting_confirmation"],
      default: "unpaid",
    },
    paymentMethod: { type: String, default: null }, // e.g. "Credit / Debit Card"
    customerName: { type: String, default: null },
    customerPhone: { type: String, default: null },
    customerEmail: { type: String, default: null },
    customerAddress: { type: String, default: null },
    customerBank: {
      accountName: { type: String, default: null },
      accountNumber: { type: String, default: null },
      bankCode: { type: String, default: null },
      bankName: { type: String, default: null },
    },
    fulfillmentType: {
      type: String,
      enum: ["delivery", "pickup"],
      default: "delivery",
    },
    deliveryAddress: { type: String, default: null },
    carrier: { type: String, default: null }, // retail shipping carrier
    estimatedDelivery: { type: String, default: null }, // retail, e.g. "3 – 5 business days"
    estimatedPrepMins: { type: Number, default: null }, // food kitchen estimate
    notes: { type: String, default: null },
    // Paystack transaction reference for orders paid online (via a velte pay link).
    // Unique + sparse so it dedupes webhook retries while leaving merchant-created
    // orders (no online payment) free to omit it.
    paystackReference: { type: String, unique: true, sparse: true },
    // Staffly checkout-intent id (ord_...) for manual-transfer orders bridged in from
    // staffly. Unique + sparse so it dedupes retries while leaving Paystack/merchant
    // orders free to omit it.
    stafflyOrderId: { type: String, unique: true, sparse: true, index: true },
    // Public customer order-tracking credentials (see top of file). Generated for
    // every order in the pre('save') hook. `trackingKey` is select:false so it is
    // never returned by ordinary queries / serializers — query it explicitly with
    // .select('+trackingKey') only inside the track endpoint when validating.
    trackingToken: { type: String, unique: true, sparse: true, index: true },
    trackingKey: { type: String, select: false },
    // CDN URL of the generated receipt PDF (set after a successful payment).
    receiptUrl: { type: String, default: null },
    // Human receipt number on the PDF, e.g. "ASL-0001" (assigned once, then stable).
    receiptNumber: { type: String, default: null },
    // Refund tracking. Refunds go back to the original Paystack payment source (no
    // customer bank details collected); these fields make a second refund attempt a
    // no-op and let the UI reflect refund progress.
    refund: {
      status: {
        type: String,
        enum: ["none", "pending", "processed", "failed"],
        default: "none",
      },
      reference: { type: String, default: null }, // Paystack refund id/reference
      amount: { type: Number, default: null }, // Naira
      refundedAt: { type: Date, default: null },
    },
  },
  {
    timestamps: true,
  },
);

// Mint tracking credentials once, when the order is first created. Kept in a hook
// (not schema defaults) so both order-creation paths — the Paystack webhook
// (handleOrderCharge) and the merchant endpoint (createOrder) — get them for free.
orderSchema.pre("save", function assignTrackingCredentials(next) {
  if (this.isNew) {
    if (!this.trackingToken) this.trackingToken = generateTrackingToken();
    if (!this.trackingKey) this.trackingKey = generateTrackingKey();
  }
  next();
});

export default mongoose.model("Order", orderSchema);
