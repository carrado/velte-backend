import mongoose from "mongoose";

// A customer of a specific business (merchant). One record per (merchant, phone),
// created/updated the first time a customer pays for an order. Subsequent paid
// orders from the same person increment `orders` and `totalSpend` rather than
// creating a duplicate. WhatsApp customers always carry a phone; web-pay customers
// without a phone are keyed by email instead.
const customerSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    name: { type: String, trim: true, default: null },
    // Stored as Staffly stores it (digits only, no +), or whatever the web pay
    // page captured. Null only when the order had no phone at all.
    phone: { type: String, default: null },
    email: { type: String, default: null, lowercase: true, trim: true },
    orders: { type: Number, default: 0, min: 0 },
    totalSpend: { type: Number, default: 0, min: 0 }, // Naira (whole units)
    status: {
      type: String,
      enum: ["Active", "Inactive", "VIP"],
      default: "Active",
    },
    lastOrderAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        ret.id = ret._id.toString();
        // Match the shape the customers UI expects: a formatted spend string.
        ret.spend = Number(ret.totalSpend || 0).toLocaleString("en-NG", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);

// One customer per (business, phone) — the upsert key for WhatsApp orders. Partial
// so the many web-pay customers with a null phone don't collide on a single null.
customerSchema.index(
  { userId: 1, phone: 1 },
  { unique: true, partialFilterExpression: { phone: { $type: "string" } } },
);
// Non-unique: lookup/fallback key for email-only customers (no uniqueness enforced
// so a shared/typo'd email can never block a sale from being recorded).
customerSchema.index({ userId: 1, email: 1 });
customerSchema.index({ userId: 1, createdAt: -1 });

const Customer = mongoose.model("Customer", customerSchema);

export default Customer;
