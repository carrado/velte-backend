import mongoose from 'mongoose';

export const RETAIL_TRANSITIONS = {
  Pending:   ['Shipped', 'Cancelled'],
  Shipped:   ['Delivered', 'Cancelled'],
  Delivered: [],
  Cancelled: [],
};

export const FOOD_TRANSITIONS = {
  Pending:   ['Preparing', 'Cancelled'],
  Preparing: ['Ready', 'Cancelled'],
  Ready:     ['OnTheWay', 'Cancelled'],
  OnTheWay:  ['Delivered', 'Cancelled'],
  Delivered: [],
  Cancelled: [],
};

const chosenModifierSchema = new mongoose.Schema({
  modifierName:    { type: String, required: true },
  optionName:      { type: String, required: true },
  additionalPrice: { type: Number, default: 0 },
}, { _id: false });

const orderItemSchema = new mongoose.Schema({
  productId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  name:            { type: String, required: true },
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
  amount: { type: Number, default: 0 },
  customerName:  { type: String, default: null },
  customerPhone: { type: String, default: null },
  customerBank: {
    accountName:   { type: String, default: null },
    accountNumber: { type: String, default: null },
    bankCode:      { type: String, default: null },
    bankName:      { type: String, default: null },
  },
  notes: { type: String, default: null },
  // Paystack transaction reference for orders paid online (via a velte pay link).
  // Unique + sparse so it dedupes webhook retries while leaving merchant-created
  // orders (no online payment) free to omit it.
  paystackReference: { type: String, unique: true, sparse: true },
}, {
  timestamps: true,
});

export default mongoose.model('Order', orderSchema);
