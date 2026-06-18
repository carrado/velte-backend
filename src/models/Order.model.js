import mongoose from 'mongoose';

// Legal status transitions, keyed by the internal (PascalCase) status.
// `cancelled` is only reachable from `pending`; once an order is shipped/preparing
// or later it can no longer be cancelled. `Delivered`/`Cancelled` are terminal.
// (See orders-api.md → "Status lifecycle".)
export const RETAIL_TRANSITIONS = {
  Pending:   ['Shipped', 'Cancelled'],
  Shipped:   ['Delivered'],
  Delivered: [],
  Cancelled: [],
};

export const FOOD_TRANSITIONS = {
  Pending:   ['Preparing', 'Cancelled'],
  Preparing: ['Ready'],
  Ready:     ['OnTheWay'],
  OnTheWay:  ['Delivered'],
  Delivered: [],
  Cancelled: [],
};

// Internal (stored) status <-> the snake_case `status` the Orders API exposes.
// The model and the Staffly bridge stay on PascalCase; only the HTTP layer maps.
export const STATUS_TO_API = {
  Pending:   'pending',
  Preparing: 'preparing',
  Ready:     'ready',
  OnTheWay:  'on_the_way',
  Shipped:   'shipped',
  Delivered: 'delivered',
  Cancelled: 'cancelled',
};

export const STATUS_FROM_API = Object.fromEntries(
  Object.entries(STATUS_TO_API).map(([internal, api]) => [api, internal]),
);

// Which API statuses are valid for each business type. A retail vendor moving an
// order into a food-only status (or vice versa) is a 400, not a 409.
export const VALID_API_STATUSES = {
  retail: ['pending', 'shipped', 'delivered', 'cancelled'],
  food:   ['pending', 'preparing', 'ready', 'on_the_way', 'delivered', 'cancelled'],
};

const chosenModifierSchema = new mongoose.Schema({
  modifierName:    { type: String, required: true },
  optionName:      { type: String, required: true },
  additionalPrice: { type: Number, default: 0 },
}, { _id: false });

const orderItemSchema = new mongoose.Schema({
  productId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  name:            { type: String, required: true },
  // Snapshot of the product photo at order time, so the orders UI can show it
  // without an extra products lookup (and without breaking if the product is
  // later edited/deleted). Sourced from Product.mainImageUrl up the chain.
  image:           { type: String, default: null },
  sku:             { type: String, default: null },
  quantity:        { type: Number, required: true, min: 1 },
  basePrice:       { type: Number, required: true },
  chosenModifiers: { type: [chosenModifierSchema], default: [] },
  lineTotal:       { type: Number, required: true },
}, { _id: false });

const orderSchema = new mongoose.Schema({
  merchantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
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
    enum: ['Pending', 'Shipped', 'Delivered', 'Cancelled', 'Preparing', 'Ready', 'OnTheWay'],
    default: 'Pending',
  },
  items: { type: [orderItemSchema], default: [] },
  // Monetary amounts are stored in Naira (whole units); the HTTP layer converts
  // to/from kobo, which is what orders-api.md exposes to the frontend.
  amount:      { type: Number, default: 0 }, // grand total = subtotal + deliveryFee
  deliveryFee: { type: Number, default: 0 },
  paymentStatus: {
    type: String,
    enum: ['paid', 'unpaid'],
    default: 'unpaid',
  },
  paymentMethod: { type: String, default: null }, // e.g. "Credit / Debit Card"
  customerName:    { type: String, default: null },
  customerPhone:   { type: String, default: null },
  customerEmail:   { type: String, default: null },
  customerAddress: { type: String, default: null },
  customerBank: {
    accountName:   { type: String, default: null },
    accountNumber: { type: String, default: null },
    bankCode:      { type: String, default: null },
    bankName:      { type: String, default: null },
  },
  fulfillmentType: {
    type: String,
    enum: ['delivery', 'pickup'],
    default: 'delivery',
  },
  deliveryAddress:   { type: String, default: null },
  carrier:           { type: String, default: null }, // retail shipping carrier
  estimatedDelivery: { type: String, default: null }, // retail, e.g. "3 – 5 business days"
  estimatedPrepMins: { type: Number, default: null }, // food kitchen estimate
  notes: { type: String, default: null },
  // Paystack transaction reference for orders paid online (via a velte pay link).
  // Unique + sparse so it dedupes webhook retries while leaving merchant-created
  // orders (no online payment) free to omit it.
  paystackReference: { type: String, unique: true, sparse: true },
  // Refund tracking. Refunds go back to the original Paystack payment source (no
  // customer bank details collected); these fields make a second refund attempt a
  // no-op and let the UI reflect refund progress.
  refund: {
    status:     { type: String, enum: ['none', 'pending', 'processed', 'failed'], default: 'none' },
    reference:  { type: String, default: null }, // Paystack refund id/reference
    amount:     { type: Number, default: null }, // Naira
    refundedAt: { type: Date, default: null },
  },
}, {
  timestamps: true,
});

export default mongoose.model('Order', orderSchema);
